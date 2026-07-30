// WD-29 (DEF-2 fix) — pipeline state-transition idempotency under a REAL race.
//
// Why this file exists separately from pipeline.test.ts: a concurrency fix's failure mode is silent.
// A subtly wrong lock scope (or a lock with no precondition re-check behind it) passes every ordinary
// sequential test and quietly keeps producing duplicate client-facing stages. So every test here is
// built around a DETERMINISTIC race window rather than a hopeful `Promise.all` + timing luck:
//
//   The driver pre-takes the run's advisory lock on a separate connection, THEN fires N concurrent
//   requests. Each request enters its handler, opens its transaction and blocks on
//   `pg_advisory_xact_lock` — so all N are provably past BEGIN and provably have NOT read anything
//   before the driver releases the lock. That is exactly DEF-2's precondition ("both read the run
//   before either's write lands") reproduced on demand, with no dependence on scheduling.
//
// The suite also FALSIFIES itself: `reproduces the pre-fix duplicate` replays the shipped
// pre-WD-29 read-then-write shape at the SQL level and asserts a duplicate really does appear. If
// that test ever stops producing 2 rows, this whole file has stopped testing the bug it was written
// for, and the "exactly one" assertions below would be vacuous.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { seedAutomationAccounts } from "../seed/automation";
import { PIPELINE_RUN_LOCK_NS } from "./pipeline-lock";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const asWorkflow = (wf: string) => ({ ...svc, "x-obo-provider": "n8n", "x-obo-external-id": wf });

/** Resolves true if `p` settles within `ms`, false if it is still pending. Never rejects — a
 *  rejection counts as "settled", which is what the blocked/not-blocked assertions care about. */
function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    p.then(() => true, () => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ]);
}

describe.skipIf(!TEST_URL)("WD-29 — pipeline state-transition idempotency under a real race (DEF-2)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Gaiada Creative");
    await seedAutomationAccounts(co);
    admin = await createUser("admin@pipeline-race.test");
    await addMembership(co, admin);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    app = await buildApp();
  }, 60000);
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  let seq = 0;
  /** A fresh run whose delivery track is ready for `release_design` (prd_extract present). */
  async function newRun(): Promise<string> {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/pipeline/runs`,
      headers: asWorkflow("wf:mtg-dispatcher"),
      payload: {
        sourceMeetingId: `race-${++seq}`,
        title: `race run ${seq}`,
        stages: [{ track: "delivery", name: "prd_extract", status: "done", artifactRef: "# PRD" }],
      },
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  }

  const createDesign = (runId: string, artifactRef: string) =>
    app.inject({
      method: "POST",
      url: `/api/${co}/pipeline/runs/${runId}/stages`,
      headers: asWorkflow("wf:delivery"),
      payload: { track: "delivery", name: "claude_design", status: "awaiting_gate", artifactRef },
    });

  const designCount = async (runId: string) =>
    (
      await adminPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pipeline_stages WHERE run_id = $1 AND name = 'claude_design'`,
        [runId],
      )
    ).rows[0].n;

  /** Hold the run lock on a dedicated connection; returns a release fn. While held, every handler
   *  that touches this run is parked at its `lockPipelineRun` call. */
  async function holdRunLock(runId: string): Promise<() => Promise<void>> {
    const c = await adminPool().connect();
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [PIPELINE_RUN_LOCK_NS, runId]);
    return async () => {
      await c.query("COMMIT");
      c.release();
    };
  }

  // ── The falsifiability anchor ───────────────────────────────────────────────────────────────────
  it("FALSIFIABILITY: reproduces the pre-fix duplicate — the read-then-write shape really does race", async () => {
    const runId = await newRun();
    // Replays the SHIPPED pre-WD-29 createStage body on two connections, minus the advisory lock:
    // `SELECT ... name='claude_design'` -> (none) -> INSERT. Interleaved read/read/write/write, which
    // is precisely what two `Load + decide` executions do when both trigger events land together.
    const a = await adminPool().connect();
    const b = await adminPool().connect();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      const seenA = await a.query(`SELECT id FROM pipeline_stages WHERE run_id = $1 AND name = 'claude_design'`, [runId]);
      const seenB = await b.query(`SELECT id FROM pipeline_stages WHERE run_id = $1 AND name = 'claude_design'`, [runId]);
      expect(seenA.rowCount).toBe(0); // both snapshots agree "no design yet"
      expect(seenB.rowCount).toBe(0); // -> both will independently decide `release_design`
      const ins = `INSERT INTO pipeline_stages (id, tenant_id, run_id, track, name, status, artifact_ref, origin_site)
                   VALUES (gen_random_uuid(), $1, $2, 'delivery', 'claude_design', 'awaiting_gate', $3, 'test')`;
      await a.query(ins, [co, runId, "# design from execution A"]);
      await a.query("COMMIT");
      await b.query(ins, [co, runId, "# design from execution B"]);
      await b.query("COMMIT");
    } finally {
      a.release();
      b.release();
    }
    // DEF-2, reproduced on the real schema: two client-facing design stages from one logical trigger.
    expect(await designCount(runId)).toBe(2);
  });

  it("...and the run lock is what closes that exact window (second decider blocks until the first commits)", async () => {
    const runId = await newRun();
    const a = await adminPool().connect();
    const b = await adminPool().connect();
    try {
      await a.query("BEGIN");
      await a.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [PIPELINE_RUN_LOCK_NS, runId]);
      await b.query("BEGIN");
      const bWaits = b.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [PIPELINE_RUN_LOCK_NS, runId]);
      // B cannot even begin to read the run while A holds it — no stale snapshot is obtainable.
      expect(await settledWithin(bWaits, 500)).toBe(false);
      await a.query("COMMIT");
      expect(await settledWithin(bWaits, 5000)).toBe(true);
      await b.query("COMMIT");
    } finally {
      a.release();
      b.release();
    }
  });

  // ── The racing driver ──────────────────────────────────────────────────────────────────────────
  it("six concurrent release_design deciders on ONE run create exactly ONE claude_design stage", async () => {
    const runId = await newRun();
    const release = await holdRunLock(runId);

    // Fire all six while the lock is held: each is inside its transaction, parked at lockPipelineRun,
    // guaranteed not to have read the run yet. This is the race, made deterministic.
    const flights = Array.from({ length: 6 }, (_, i) => createDesign(runId, `# design from execution ${i}`));
    expect(await settledWithin(Promise.all(flights), 500)).toBe(false); // all six genuinely blocked

    await release();
    const results = await Promise.all(flights);

    for (const r of results) expect(r.statusCode).toBe(201);
    const bodies = results.map((r) => r.json());
    // Exactly one genuine create; the other five resolved to it instead of inserting.
    expect(bodies.filter((b) => !b.deduped)).toHaveLength(1);
    expect(bodies.filter((b) => b.deduped === true)).toHaveLength(5);
    // Every caller got the SAME stage id, so all six n8n executions stay on the live lineage.
    expect(new Set(bodies.map((b) => b.id)).size).toBe(1);
    expect(await designCount(runId)).toBe(1);
  });

  it("the same race on the REVISE path yields exactly one revision, not one per decider", async () => {
    const runId = await newRun();
    // Beat 0: the initial design.
    const first = await createDesign(runId, "# design rev 1");
    const designId = first.json().id;
    expect(await designCount(runId)).toBe(1);

    // Drive the real revise trigger: customer_feedback on THAT design decided changes_requested.
    const cf = await app.inject({
      method: "POST", url: `/api/${co}/pipeline/gates`, headers: asWorkflow("wf:delivery"),
      payload: { runId, stageId: designId, kind: "customer_feedback", actorSide: "client" },
    });
    expect(cf.statusCode).toBe(201);
    const decided = await app.inject({
      method: "POST", url: `/api/${co}/pipeline/gates/${cf.json().id}/decide`, headers: asUser(admin),
      payload: { decision: "changes_requested", note: "tighten the hero section" },
    });
    expect(decided.statusCode).toBe(200);

    // Now race four `revise_design` deciders. A revision IS justified — but only ONE of them.
    const release = await holdRunLock(runId);
    const flights = Array.from({ length: 4 }, (_, i) => createDesign(runId, `# design rev 2 attempt ${i}`));
    expect(await settledWithin(Promise.all(flights), 500)).toBe(false);
    await release();
    const bodies = (await Promise.all(flights)).map((r) => r.json());

    expect(bodies.filter((b) => !b.deduped)).toHaveLength(1);
    // 2, not 1 and not 5: the legitimate revision survived (WD-05's loop still works) and the three
    // raced twins did not. This is the assertion a blanket UNIQUE(run_id, track, name) would fail.
    expect(await designCount(runId)).toBe(2);
  });

  it("a further revision still needs its OWN changes_requested — the loop cannot be advanced by retriggers", async () => {
    const runId = await newRun();
    const first = await createDesign(runId, "# design rev 1");
    const designId = first.json().id;
    const cf = await app.inject({
      method: "POST", url: `/api/${co}/pipeline/gates`, headers: asWorkflow("wf:delivery"),
      payload: { runId, stageId: designId, kind: "customer_feedback", actorSide: "client" },
    });
    await app.inject({
      method: "POST", url: `/api/${co}/pipeline/gates/${cf.json().id}/decide`, headers: asUser(admin),
      payload: { decision: "changes_requested" },
    });
    const rev2 = await createDesign(runId, "# design rev 2");
    expect(rev2.json().deduped).toBeUndefined();
    expect(await designCount(runId)).toBe(2);

    // The changes_requested that justified rev 2 is attached to rev 1, so it is CONSUMED. Any number
    // of later retriggers must not manufacture rev 3 — this is the WD-05 budget-integrity property:
    // the bound counts design stages, so a spurious extra design escalates the run early.
    for (let i = 0; i < 3; i++) {
      const again = await createDesign(runId, `# spurious rev ${i}`);
      expect(again.json()).toMatchObject({ id: rev2.json().id, deduped: true });
    }
    expect(await designCount(runId)).toBe(2);
  });

  // ── Lock-scope proof: the mistake that would serialize the whole pipeline ───────────────────────
  it("LOCK SCOPE: a run holding its lock does NOT block a DIFFERENT run's transition", async () => {
    const runA = await newRun();
    const runB = await newRun();
    const release = await holdRunLock(runA);
    try {
      // Run A's transition is parked (proves the lock is really held and really covers A)...
      const blockedA = createDesign(runA, "# A");
      expect(await settledWithin(blockedA, 500)).toBe(false);

      // ...while run B's identical transition completes normally. A per-TENANT lock — the plausible
      // wrong scope — would park this too, since every run here shares one tenant, and the whole
      // pipeline would serialize.
      const okB = await createDesign(runB, "# B");
      expect(okB.statusCode).toBe(201);
      expect(okB.json().deduped).toBeUndefined();
      expect(await designCount(runB)).toBe(1);

      // A is still parked, i.e. B's completion was genuine parallelism, not the lock having lapsed.
      expect(await settledWithin(blockedA, 200)).toBe(false);
      expect(await designCount(runA)).toBe(0);

      await release();
      expect((await blockedA).statusCode).toBe(201);
      expect(await designCount(runA)).toBe(1);
    } finally {
      await release().catch(() => {}); // idempotent-ish guard if the body threw before releasing
    }
  });

  // ── Gate-open idempotency ──────────────────────────────────────────────────────────────────────
  it("five concurrent gate-opens for one beat yield exactly ONE pending gate", async () => {
    const runId = await newRun();
    const design = await createDesign(runId, "# design");
    const stageId = design.json().id;

    const release = await holdRunLock(runId);
    const flights = Array.from({ length: 5 }, () =>
      app.inject({
        method: "POST", url: `/api/${co}/pipeline/gates`, headers: asWorkflow("wf:delivery"),
        payload: { runId, stageId, kind: "pm_review", actorSide: "internal", note: "beat 1" },
      }),
    );
    expect(await settledWithin(Promise.all(flights), 500)).toBe(false);
    await release();
    const bodies = (await Promise.all(flights)).map((r) => r.json());

    expect(bodies.filter((b) => !b.deduped)).toHaveLength(1);
    expect(new Set(bodies.map((b) => b.id)).size).toBe(1);
    const gates = await adminPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pipeline_gates WHERE run_id = $1 AND stage_id = $2
         AND kind = 'pm_review' AND status = 'pending' AND deleted_at IS NULL`,
      [runId, stageId],
    );
    // A duplicate PENDING twin is what makes a run STALL forever: gof() resolves a beat to the LAST
    // gate of that kind, so a human deciding the older twin leaves the newer one pending.
    expect(gates.rows[0].n).toBe(1);

    // No phantom audit rows for the four suppressed opens.
    const acts = await adminPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM activities WHERE target_entity_type = 'pipeline_gate' AND verb = 'opened'
         AND target_entity_id = $1`,
      [bodies[0].id],
    );
    expect(acts.rows[0].n).toBe(1);
  });

  it("the revise loop still reopens pm_review on a NEW revision (dedupe is per stage, not per run)", async () => {
    const runId = await newRun();
    const rev1 = (await createDesign(runId, "# rev 1")).json().id;
    const g1 = await app.inject({
      method: "POST", url: `/api/${co}/pipeline/gates`, headers: asWorkflow("wf:delivery"),
      payload: { runId, stageId: rev1, kind: "pm_review", actorSide: "internal" },
    });
    expect(g1.json().deduped).toBeUndefined();
    const cf = await app.inject({
      method: "POST", url: `/api/${co}/pipeline/gates`, headers: asWorkflow("wf:delivery"),
      payload: { runId, stageId: rev1, kind: "customer_feedback", actorSide: "client" },
    });
    await app.inject({
      method: "POST", url: `/api/${co}/pipeline/gates/${cf.json().id}/decide`, headers: asUser(admin),
      payload: { decision: "changes_requested" },
    });
    const rev2 = (await createDesign(runId, "# rev 2")).json().id;
    expect(rev2).not.toBe(rev1);
    // Beat 1 reopens on the NEW stage — a different stage_id, so the pending-duplicate guard must
    // NOT suppress it. (A guard keyed on (run, kind) alone would deadlock the revise loop here.)
    const g2 = await app.inject({
      method: "POST", url: `/api/${co}/pipeline/gates`, headers: asWorkflow("wf:delivery"),
      payload: { runId, stageId: rev2, kind: "pm_review", actorSide: "internal" },
    });
    expect(g2.statusCode).toBe(201);
    expect(g2.json().deduped).toBeUndefined();
    expect(g2.json().id).not.toBe(g1.json().id);
  });

  // ── Single-shot stage identity + the 0052 schema backstop ───────────────────────────────────────
  it("concurrent release_code / deploy deciders each create exactly one stage", async () => {
    const runId = await newRun();
    for (const name of ["claude_code", "staging", "production"]) {
      const release = await holdRunLock(runId);
      const flights = Array.from({ length: 4 }, (_, i) =>
        app.inject({
          method: "POST", url: `/api/${co}/pipeline/runs/${runId}/stages`, headers: asWorkflow("wf:delivery"),
          payload: { track: "delivery", name, status: "awaiting_gate", artifactRef: `# ${name} ${i}` },
        }),
      );
      expect(await settledWithin(Promise.all(flights), 500)).toBe(false);
      await release();
      const bodies = (await Promise.all(flights)).map((r) => r.json());
      expect(bodies.filter((b) => !b.deduped)).toHaveLength(1);
      const n = await adminPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pipeline_stages WHERE run_id = $1 AND name = $2`,
        [runId, name],
      );
      expect(n.rows[0].n).toBe(1);
    }
  });

  it("migration 0052's partial unique index physically rejects a duplicate single-shot stage", async () => {
    const runId = await newRun(); // already has exactly one prd_extract
    await expect(
      adminPool().query(
        `INSERT INTO pipeline_stages (id, tenant_id, run_id, track, name, status, origin_site)
         VALUES (gen_random_uuid(), $1, $2, 'delivery', 'prd_extract', 'pending', 'test')`,
        [co, runId],
      ),
    ).rejects.toThrow(/pipeline_stages_single_shot_uniq|duplicate key/i);

    // ...and it deliberately does NOT cover claude_design, because revise-loop revisions are
    // legitimate repeats. Two rows must be insertable at the SCHEMA level (the causal guard in the
    // controller is what distinguishes them — see 0052's header for why no index can).
    await adminPool().query(
      `INSERT INTO pipeline_stages (id, tenant_id, run_id, track, name, status, origin_site)
       VALUES (gen_random_uuid(), $1, $2, 'delivery', 'claude_design', 'awaiting_gate', 'test'),
              (gen_random_uuid(), $1, $2, 'delivery', 'claude_design', 'awaiting_gate', 'test')`,
      [co, runId],
    );
    expect(await designCount(runId)).toBe(2);
  });

  // ── Event idempotency on the scope trigger ─────────────────────────────────────────────────────
  it("re-filing an already-complete scope sign-off does NOT re-emit scope.signed", async () => {
    const runId = await newRun();
    const sign = (party: string) =>
      app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs/${runId}/scope-signoffs`,
        headers: asUser(admin), payload: { party, signerName: `${party} signer` },
      });
    expect((await sign("provider")).json()).toMatchObject({ complete: false });
    expect((await sign("client")).json()).toMatchObject({ complete: true });

    const emitted = async () =>
      (
        await adminPool().query<{ n: number }>(
          `SELECT count(*)::int AS n FROM outbox_events WHERE entity_id = $1 AND event_type = 'scope.signed'`,
          [runId],
        )
      ).rows[0].n;
    expect(await emitted()).toBe(1);

    // A re-file is a row-level no-op (ON CONFLICT), and must be an EVENT-level no-op too: each
    // spurious scope.signed starts another delivery execution, which is DEF-2's fan-out source.
    for (const p of ["provider", "client", "client"]) {
      const again = await sign(p);
      expect(again.json()).toMatchObject({ complete: true });
    }
    expect(await emitted()).toBe(1);
  });

  it("two parties signing scope CONCURRENTLY emit scope.signed exactly once", async () => {
    const runId = await newRun();
    const release = await holdRunLock(runId);
    const flights = ["provider", "client"].map((party) =>
      app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs/${runId}/scope-signoffs`,
        headers: asUser(admin), payload: { party, signerName: `${party} signer` },
      }),
    );
    expect(await settledWithin(Promise.all(flights), 500)).toBe(false);
    await release();
    for (const r of await Promise.all(flights)) expect(r.statusCode).toBe(201);

    const ev = await adminPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox_events WHERE entity_id = $1 AND event_type = 'scope.signed'`,
      [runId],
    );
    expect(ev.rows[0].n).toBe(1);
  });

  // ── WD-03 / WD-05 regression guards (the lock must not have changed their semantics) ───────────
  it("WD-03's signature lock still 409s an artifact edit after the client signed (now under the run lock)", async () => {
    const runId = await newRun();
    const detail = await app.inject({ method: "GET", url: `/api/${co}/pipeline/runs/${runId}`, headers: asUser(admin) });
    const prdStageId = detail.json().stages[0].id;

    const pre = await app.inject({
      method: "PATCH", url: `/api/${co}/pipeline/stages/${prdStageId}`, headers: asUser(admin),
      payload: { artifactRef: "# PRD v2" },
    });
    expect(pre.statusCode).toBe(200);

    const gate = await app.inject({
      method: "POST", url: `/api/${co}/pipeline/gates`, headers: asWorkflow("wf:delivery"),
      payload: { runId, kind: "prd_sign", actorSide: "client" },
    });
    await app.inject({
      method: "POST", url: `/api/${co}/pipeline/gates/${gate.json().id}/decide`, headers: asUser(admin),
      payload: { decision: "signed" },
    });

    const locked = await app.inject({
      method: "PATCH", url: `/api/${co}/pipeline/stages/${prdStageId}`, headers: asUser(admin),
      payload: { artifactRef: "forged after sign" },
    });
    expect(locked.statusCode).toBe(409);
    // Status-only transitions stay open.
    const statusOnly = await app.inject({
      method: "PATCH", url: `/api/${co}/pipeline/stages/${prdStageId}`, headers: asWorkflow("wf:delivery"),
      payload: { confidence: 0.99 },
    });
    expect(statusOnly.statusCode).toBe(200);
  });

  it("WD-05's updateRun still parks a run 'blocked' and emits pipeline.run.updated", async () => {
    const runId = await newRun();
    const parked = await app.inject({
      method: "PATCH", url: `/api/${co}/pipeline/runs/${runId}`, headers: asWorkflow("wf:delivery"),
      payload: { status: "blocked" },
    });
    expect(parked.statusCode).toBe(200);
    expect(parked.json()).toMatchObject({ id: runId, status: "blocked" });
    const ev = await adminPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox_events WHERE entity_id = $1 AND event_type = 'pipeline.run.updated'`,
      [runId],
    );
    expect(ev.rows[0].n).toBe(1);
  });

  it("two concurrent deciders on ONE gate produce exactly one decision (the loser 404s)", async () => {
    const runId = await newRun();
    const gate = await app.inject({
      method: "POST", url: `/api/${co}/pipeline/gates`, headers: asWorkflow("wf:delivery"),
      payload: { runId, kind: "prd_sign", actorSide: "client" },
    });
    const gateId = gate.json().id;

    const release = await holdRunLock(runId);
    const flights = [0, 1].map(() =>
      app.inject({
        method: "POST", url: `/api/${co}/pipeline/gates/${gateId}/decide`, headers: asUser(admin),
        payload: { decision: "signed" },
      }),
    );
    expect(await settledWithin(Promise.all(flights), 500)).toBe(false);
    await release();
    const codes = (await Promise.all(flights)).map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 404]);

    // Exactly one DECISION audit row, not two (the gate also carries its own 'opened' row, which is
    // why this filters on the decision verb rather than counting every activity on the gate).
    const acts = await adminPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM activities
       WHERE target_entity_type = 'pipeline_gate' AND target_entity_id = $1 AND verb = 'signed'`,
      [gateId],
    );
    expect(acts.rows[0].n).toBe(1);
  });
});
