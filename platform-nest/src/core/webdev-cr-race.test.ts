// MI-03 — the change-request TRIAGE transition under a REAL race (the DEF-2 class applied to a new
// unit of consistency). Model: `pipeline-race.test.ts`, which this file follows deliberately rather
// than inventing a second concurrency-testing style.
//
// ── WHY THIS FILE IS SHAPED THE WAY IT IS ────────────────────────────────────────────────────────
// A `Promise.all` of two requests plus timing luck is the WORST kind of concurrency test: it looks
// like the strongest test in the suite and proves nothing whenever the two requests happen not to
// overlap. Three properties make the race here deterministic and self-checking:
//
//  1. The driver PRE-TAKES the change request's advisory lock on a dedicated connection (the OWNER
//     pool — a different Postgres session from the app's `platform_app_test` pool, which matters
//     because advisory locks are SESSION-REENTRANT: a probe that took the lock on a connection the
//     app might reuse would be granted it again and block nothing). Only then are the concurrent
//     converts fired. Each one enters the handler, opens its transaction, and parks on
//     `pg_advisory_xact_lock` — provably past BEGIN, provably having read nothing.
//  2. THE COLLISION IS ASSERTED, NOT ASSUMED. `waitForAdvisoryWaiters(2)` polls `pg_locks` until
//     TWO ungranted advisory waiters exist in THIS database. That is direct evidence that both app
//     transactions are queued behind the same lock key — the thing a green `Promise.all` cannot
//     tell you. A previous ticket in this estate shipped a 4-way "race" that passed even with
//     check-then-insert substituted for the real logic, because it never actually collided.
//  3. The suite FALSIFIES ITSELF (`FALSIFIABILITY:` below): it replays the lock-less read-then-write
//     shape at the SQL level and asserts an orphan run really does appear — including the finding
//     that the UPDATE's `AND status = 'new'` backstop does NOT prevent it. If that test ever stops
//     producing two runs, the "exactly one" assertions here have gone vacuous.
//
// ── MUTATION PROBE (run for real, 2026-08-08) ────────────────────────────────────────────────────
// `webdev-change-requests.controller.ts`'s server-side precondition re-check (`if (cr.status !==
// "new") return already_triaged`) was DELETED, this file re-run, and it went RED — see the header of
// `webdev-cr-lock.ts` for the recorded evidence and the exact failing assertions. The re-check was
// then restored. Without that probe the "exactly ONE run" assertion below would be an untested
// claim about a test.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../testing/fixtures";
import { WEBDEV_CR_LOCK_NS } from "./webdev-cr-lock";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

/** Resolves true if `p` settles within `ms`, false if it is still pending. Never rejects — a
 *  rejection counts as "settled", which is what the blocked/not-blocked assertions care about. */
function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    p.then(() => true, () => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ]);
}

interface TriageOk { id: string; status: string; route: string | null; pipelineRunId?: string; pmTaskId?: string }
interface TriageConflict { error: string; existing?: { status: string; route: string | null; pipelineRunId: string | null; pmTaskId: string | null } }

describe.skipIf(!TEST_URL)("MI-03 — change-request triage idempotency under a real race", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;
  let clientA: string;
  let projX: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();

    co = await createCompany("Gaiada Creative");
    admin = await createUser("admin@cr-race.test");
    await addMembership(co, admin);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    clientA = await createClient(co, "Bali Beach Resort");
    projX = await createProject(co, "Rebrand X", admin);
    await withTenants([co], (c) => c.query(`UPDATE projects SET client_id = $2 WHERE id = $1`, [projX, clientA]));

    app = await buildApp();
  }, 60000);

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ── helpers ────────────────────────────────────────────────────────────────────────────────────
  let seq = 0;
  /** A fresh `status='new'` change request, created through the REAL internal-create endpoint (not a
   *  hand-written INSERT), so every row this file races on has been through the shipped write path.
   *  The title is unique per CR, which is what lets the assertions count spawned runs by title —
   *  crucial for the mutation probe, where a DUPLICATE run has a different id but the same title. */
  async function newCr(kind = "feature", opts: { projectId?: string | null } = {}): Promise<{ id: string; title: string }> {
    // Suffix is deliberately LETTERS-ONLY. The first draft used `Date.now()` — 13 digits — and the
    // shipped `scrubText` on the create path redacted it as a card PAN, so the stored title never
    // matched the one this helper returned and every count-by-title assertion read 0 while the
    // endpoint was returning a perfectly correct 200. A 200 is not a pass; neither is a count you
    // took against a value the server never stored.
    const title = `race cr ${String.fromCharCode(97 + (seq % 26))}${++seq}-${Math.random().toString(36).slice(2, 8).replace(/[0-9]/g, "z")}`;
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/webdev/change-requests`,
      headers: asUser(admin),
      payload: { kind, title, body: "please fix the thing", clientId: clientA, projectId: opts.projectId === undefined ? projX : opts.projectId },
    });
    expect(r.statusCode).toBe(201);
    const id = (r.json() as { id: string }).id;
    // Read the title BACK, so every later count-by-title is taken against what actually committed.
    const stored = await adminPool().query<{ title: string }>(`SELECT title FROM webdev_change_requests WHERE id = $1`, [id]);
    expect(stored.rows[0].title).toBe(title);
    return { id, title: stored.rows[0].title };
  }

  const triage = (crId: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/${co}/webdev/change-requests/${crId}/triage`, headers: asUser(admin), payload });

  /** Hold the CR's advisory lock on a dedicated OWNER connection; returns a release fn. While held,
   *  every triage handler for this CR is parked at `lockChangeRequest`. */
  async function holdCrLock(crId: string): Promise<() => Promise<void>> {
    const c = await adminPool().connect();
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [WEBDEV_CR_LOCK_NS, crId]);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await c.query("COMMIT");
      c.release();
    };
  }

  /** Ungranted advisory-lock waiters in THIS database. Per-file physical databases (see
   *  testing/setup.ts) mean the only advisory locks here are this suite's, so no key filtering is
   *  needed — and filtering would be wrong anyway: `hashtext` returns a SIGNED int4 while
   *  `pg_locks.objid` is an unsigned oid, so a negative hash does not compare equal. */
  async function advisoryWaiters(): Promise<number> {
    const r = await adminPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    return r.rows[0].n;
  }

  /** Poll until exactly `n` transactions are queued behind an advisory lock. Fails loudly (never
   *  silently continues) if the collision does not materialize — a race test that stops colliding
   *  must break, not quietly pass. */
  async function waitForAdvisoryWaiters(n: number, timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = -1;
    while (Date.now() < deadline) {
      last = await advisoryWaiters();
      if (last >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect.fail(`expected ${n} advisory-lock waiters (the collision); saw ${last} — the racers never collided, so this test proves nothing`);
  }

  const countRunsTitled = async (title: string) =>
    (await adminPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM pipeline_runs WHERE title = $1`, [title])).rows[0].n;

  const countStagesFor = async (title: string) =>
    (
      await adminPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pipeline_stages s JOIN pipeline_runs r ON r.id = s.run_id WHERE r.title = $1`,
        [title],
      )
    ).rows[0].n;

  const countGatesFor = async (title: string) =>
    (
      await adminPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pipeline_gates g JOIN pipeline_runs r ON r.id = g.run_id WHERE r.title = $1`,
        [title],
      )
    ).rows[0].n;

  const countRunCreatedEvents = async (title: string) =>
    (
      await adminPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM outbox_events
          WHERE event_type = 'pipeline.run.created' AND payload->>'title' = $1`,
        [title],
      )
    ).rows[0].n;

  const countCrEvents = async (crId: string) =>
    (
      await adminPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM outbox_events
          WHERE entity_type = 'webdev_change_request' AND entity_id = $1 AND event_type = 'webdev.change_request.updated'`,
        [crId],
      )
    ).rows[0].n;

  const countActivities = async (crId: string, verb: string) =>
    (
      await adminPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM activities
          WHERE target_entity_type = 'webdev_change_request' AND target_entity_id = $1 AND verb = $2`,
        [crId, verb],
      )
    ).rows[0].n;

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // The falsifiability anchor — the window is real, and the SQL backstop alone does NOT close it
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("FALSIFIABILITY: the lock-less read-then-write shape really does spawn an ORPHAN run (and `AND status='new'` does not prevent it)", async () => {
    const cr = await newCr();
    const a = await adminPool().connect();
    const b = await adminPool().connect();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      // Both snapshots agree "still new, nothing spawned" — DEF-2's precondition, exactly.
      for (const c of [a, b]) {
        const seen = await c.query<{ status: string }>(`SELECT status FROM webdev_change_requests WHERE id = $1`, [cr.id]);
        expect(seen.rows[0].status).toBe("new");
      }
      const insRun = `INSERT INTO pipeline_runs (id, tenant_id, source_meeting_id, title, status, created_by, origin_site)
                      VALUES (gen_random_uuid(), $1, NULL, $2, 'delivery_active', $3, 'test') RETURNING id`;
      const runA = (await a.query<{ id: string }>(insRun, [co, cr.title, admin])).rows[0].id;
      const runB = (await b.query<{ id: string }>(insRun, [co, cr.title, admin])).rows[0].id;
      const link = `UPDATE webdev_change_requests SET status='in_progress', route='mini_run', pipeline_run_id=$2
                     WHERE id = $1 AND status = 'new'`;
      const upA = await a.query(link, [cr.id, runA]);
      await a.query("COMMIT");
      // B's UPDATE blocks on A's row lock, then re-evaluates the WHERE against the COMMITTED row and
      // matches nothing. So the SQL-level `AND status='new'` backstop does its job on the LINK...
      const upB = await b.query(link, [cr.id, runB]);
      await b.query("COMMIT");
      expect(upA.rowCount).toBe(1);
      expect(upB.rowCount).toBe(0);
    } finally {
      a.release();
      b.release();
    }
    // ...and yet TWO runs exist. This is the finding that makes the server-side re-check load-bearing
    // rather than belt-and-braces: the UPDATE guard can only refuse to LINK a twin, never to CREATE
    // one. Run B is a fully-formed, client-facing pipeline run that no change request points at —
    // and once it carries stages and a client sign gate, a client is asked to sign a run nobody
    // triaged. `ux_wcr_run` cannot help either: it constrains the link, not the spawn.
    expect(await countRunsTitled(cr.title)).toBe(2);
    const linked = await adminPool().query<{ pipeline_run_id: string }>(
      `SELECT pipeline_run_id FROM webdev_change_requests WHERE id = $1`, [cr.id],
    );
    expect(linked.rows[0].pipeline_run_id).not.toBeNull();
  });

  it("...and the CR lock is what closes that window: a second decider cannot even read the CR while the first holds it", async () => {
    const cr = await newCr();
    const a = await adminPool().connect();
    const b = await adminPool().connect();
    try {
      await a.query("BEGIN");
      await a.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [WEBDEV_CR_LOCK_NS, cr.id]);
      await b.query("BEGIN");
      const bWaits = b.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [WEBDEV_CR_LOCK_NS, cr.id]);
      expect(await settledWithin(bWaits, 500)).toBe(false);
      await a.query("COMMIT");
      expect(await settledWithin(bWaits, 5000)).toBe(true);
      await b.query("COMMIT");
    } finally {
      a.release();
      b.release();
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // THE HEADLINE AC — two concurrent converts, exactly ONE run, loser gets 409 + the existing run id
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("two CONCURRENT converts on one change request spawn exactly ONE run; the loser 409s carrying the existing pipelineRunId", async () => {
    const cr = await newCr();
    const release = await holdCrLock(cr.id);
    try {
      const flights = [0, 1].map(() => triage(cr.id, { action: "convert", route: "mini_run" }));

      // COLLISION PROOF (the assertion this whole file hangs on): both handlers are inside their
      // transactions, queued on the SAME advisory lock key, having read nothing.
      await waitForAdvisoryWaiters(2);
      expect(await settledWithin(Promise.all(flights), 300)).toBe(false);
      expect(await countRunsTitled(cr.title)).toBe(0); // neither spawned before blocking

      await release();
      const results = await Promise.all(flights);

      // ⚠ MUTATION-PROBE TRIPWIRE #1 — asserted FIRST, on purpose. The status code is only the
      // SYMPTOM; the corruption is a second client-facing run. Checking the count before the codes
      // means the mutation probe reports the actual damage ("expected 2 to be 1") rather than
      // stopping at a wrong HTTP status, which a reader could dismiss as cosmetic.
      expect(await countRunsTitled(cr.title)).toBe(1);
      expect(await countStagesFor(cr.title)).toBe(2);   // prd_extract + scope_extract, once
      expect(await countGatesFor(cr.title)).toBe(1);    // the single client prd_sign gate
      expect(await countRunCreatedEvents(cr.title)).toBe(1);
      expect(await countCrEvents(cr.id)).toBe(1);
      expect(await countActivities(cr.id, "converted")).toBe(1);

      const codes = results.map((r) => r.statusCode).sort();
      // ⚠ MUTATION-PROBE TRIPWIRE #2: with the re-check deleted this reads [200, 200].
      expect(codes).toEqual([200, 409]);

      const winner = results.find((r) => r.statusCode === 200)!.json() as TriageOk;
      const loser = results.find((r) => r.statusCode === 409)!.json() as TriageConflict;
      expect(winner).toMatchObject({ id: cr.id, status: "in_progress", route: "mini_run" });
      expect(winner.pipelineRunId).toBeTruthy();

      // The loser resolves to the artifact that ALREADY EXISTS rather than getting a bare error —
      // `existing` has to survive HttpErrorFilter's `{error}` reshape, which is why that filter
      // forwards the field. Same run id, so a double-clicking PM lands on the live lineage.
      expect(loser.existing).toMatchObject({
        status: "in_progress", route: "mini_run", pipelineRunId: winner.pipelineRunId, pmTaskId: null,
      });

      // The CR points at the winner's run, and the DDL's state machine holds. Note what the counts
      // above already established: a lock WITHOUT the re-check serializes the racers and still spawns
      // twice, and the loser's UPDATE is then refused by `AND status='new'` — so the CR still names
      // exactly ONE run and only a count over the RUN table can see the twin. A test that asserted
      // only on the CR row would pass on the broken implementation.
      const row = await adminPool().query(
        `SELECT status, route, pipeline_run_id, pm_task_id, triaged_by FROM webdev_change_requests WHERE id = $1`, [cr.id],
      );
      expect(row.rows[0]).toMatchObject({
        status: "in_progress", route: "mini_run", pipeline_run_id: winner.pipelineRunId, pm_task_id: null, triaged_by: admin,
      });
    } finally {
      await release();
    }
  });

  it("FOUR concurrent converts still spawn exactly ONE run; all three losers 409 with the SAME run id", async () => {
    const cr = await newCr();
    const release = await holdCrLock(cr.id);
    try {
      const flights = Array.from({ length: 4 }, () => triage(cr.id, { action: "convert", route: "mini_run" }));
      await waitForAdvisoryWaiters(4);
      expect(await settledWithin(Promise.all(flights), 300)).toBe(false);
      await release();
      const results = await Promise.all(flights);

      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 409)).toHaveLength(3);
      const runIds = new Set(
        results.map((r) =>
          r.statusCode === 200 ? (r.json() as TriageOk).pipelineRunId : (r.json() as TriageConflict).existing?.pipelineRunId,
        ),
      );
      expect(runIds.size).toBe(1); // every caller ends up on the same live lineage
      expect(await countRunsTitled(cr.title)).toBe(1);
      expect(await countRunCreatedEvents(cr.title)).toBe(1);
    } finally {
      await release();
    }
  });

  it("a concurrent DECLINE and CONVERT cannot both take effect — one disposition, one audit row", async () => {
    const cr = await newCr();
    const release = await holdCrLock(cr.id);
    try {
      const flights = [
        triage(cr.id, { action: "convert", route: "mini_run" }),
        triage(cr.id, { action: "decline", reason: "out of contract scope" }),
      ];
      await waitForAdvisoryWaiters(2);
      await release();
      const results = await Promise.all(flights);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);

      const row = await adminPool().query<{ status: string; route: string | null }>(
        `SELECT status, route FROM webdev_change_requests WHERE id = $1`, [cr.id],
      );
      // Whichever won, the row is internally consistent with the DDL's `wcr_route_matches_status`.
      const { status, route } = row.rows[0];
      expect(["declined", "in_progress"]).toContain(status);
      expect(route === null).toBe(status === "declined");
      // Exactly one disposition happened in total (not one of each).
      const declined = await countActivities(cr.id, "declined");
      const converted = await countActivities(cr.id, "converted");
      expect(declined + converted).toBe(1);
      expect(await countCrEvents(cr.id)).toBe(1);
    } finally {
      await release();
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // The non-concurrent replays of the same window: a retry and a double-click
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("a SEQUENTIAL repeat convert (an HTTP retry of a request that committed) 409s with the existing run", async () => {
    const cr = await newCr();
    const first = await triage(cr.id, { action: "convert", route: "mini_run" });
    expect(first.statusCode).toBe(200);
    const runId = (first.json() as TriageOk).pipelineRunId;

    for (let i = 0; i < 3; i++) {
      const again = await triage(cr.id, { action: "convert", route: "mini_run" });
      expect(again.statusCode).toBe(409);
      expect((again.json() as TriageConflict).existing).toMatchObject({ pipelineRunId: runId, route: "mini_run" });
    }
    expect(await countRunsTitled(cr.title)).toBe(1);
    expect(await countRunCreatedEvents(cr.title)).toBe(1);
  });

  it("a declined request cannot then be converted (the precondition is `new`, not `not yet converted`)", async () => {
    const cr = await newCr();
    expect((await triage(cr.id, { action: "decline", reason: "duplicate of an existing ticket" })).statusCode).toBe(200);
    const convert = await triage(cr.id, { action: "convert", route: "mini_run" });
    expect(convert.statusCode).toBe(409);
    expect((convert.json() as TriageConflict).existing).toMatchObject({ status: "declined", route: null, pipelineRunId: null });
    expect(await countRunsTitled(cr.title)).toBe(0);
  });

  it("a declined request cannot be declined twice (no second reason overwrite, no second notification)", async () => {
    const cr = await newCr();
    expect((await triage(cr.id, { action: "decline", reason: "the original reason" })).statusCode).toBe(200);
    const again = await triage(cr.id, { action: "decline", reason: "a rewritten reason" });
    expect(again.statusCode).toBe(409);
    const row = await adminPool().query<{ declined_reason: string }>(
      `SELECT declined_reason FROM webdev_change_requests WHERE id = $1`, [cr.id],
    );
    expect(row.rows[0].declined_reason).toBe("the original reason");
    expect(await countActivities(cr.id, "declined")).toBe(1);
  });

  it("two concurrent converts on the PM-TASK route also yield exactly one task", async () => {
    const cr = await newCr("bug");
    const release = await holdCrLock(cr.id);
    try {
      // `severity` is required to convert a BUG (wcr_bug_has_severity); without it the triage 400s
      // on the payload and never reaches the advisory-lock race this test exists to pin.
      const flights = [0, 1].map(() => triage(cr.id, { action: "convert", route: "pm_task", severity: "high" }));
      await waitForAdvisoryWaiters(2);
      await release();
      const results = await Promise.all(flights);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      const taskId = (results.find((r) => r.statusCode === 200)!.json() as TriageOk).pmTaskId;
      expect((results.find((r) => r.statusCode === 409)!.json() as TriageConflict).existing).toMatchObject({
        route: "pm_task", pmTaskId: taskId, pipelineRunId: null,
      });
      const tasks = await adminPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pm_tasks WHERE title = $1`, [cr.title],
      );
      expect(tasks.rows[0].n).toBe(1);
    } finally {
      await release();
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // LOCK SCOPE — the plausible wrong scope (per-tenant) would serialize every triage in the product
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("LOCK SCOPE: one change request holding its lock does NOT block a DIFFERENT request's triage", async () => {
    const crA = await newCr();
    const crB = await newCr();
    const release = await holdCrLock(crA.id);
    try {
      const blockedA = triage(crA.id, { action: "convert", route: "mini_run" });
      await waitForAdvisoryWaiters(1);
      expect(await settledWithin(blockedA, 300)).toBe(false);

      // B's identical transition completes normally. Every CR here shares ONE tenant, so a
      // tenant-keyed lock — the plausible wrong scope — would park this too.
      const okB = await triage(crB.id, { action: "convert", route: "mini_run" });
      expect(okB.statusCode).toBe(200);
      expect(await countRunsTitled(crB.title)).toBe(1);

      // A is still parked, i.e. B's completion was genuine parallelism, not the lock having lapsed.
      expect(await settledWithin(blockedA, 200)).toBe(false);
      expect(await countRunsTitled(crA.title)).toBe(0);

      await release();
      expect((await blockedA).statusCode).toBe(200);
      expect(await countRunsTitled(crA.title)).toBe(1);
    } finally {
      await release();
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // FAULT INJECTION — run + stages + gate + CR + outbox roll back ATOMICALLY
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("a fault raised AFTER the run INSERT rolls back run + stages + gate + CR + outbox together", async () => {
    // The fault is injected in the DATABASE, not by editing the product: a BEFORE INSERT trigger on
    // `pipeline_stages` that raises when the artifact carries a marker string. That lands the failure
    // strictly AFTER the `pipeline_runs` INSERT — provably, because `pipeline_stages.run_id` is a
    // plain (immediately-checked) FK to `pipeline_runs`, so the trigger cannot fire until the run row
    // exists. Injecting in-process would have required a product-code seam that exists only for tests.
    await adminPool().query(`
      CREATE OR REPLACE FUNCTION mi03_inject_fault() RETURNS trigger AS $fn$
      BEGIN
        IF NEW.artifact_ref LIKE '%FAULT_INJECTION_PROBE%' THEN
          RAISE EXCEPTION 'MI03 injected fault, after the run INSERT';
        END IF;
        RETURN NEW;
      END $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER mi03_inject_fault_trg BEFORE INSERT ON pipeline_stages
        FOR EACH ROW EXECUTE FUNCTION mi03_inject_fault();
    `);

    // Letters-only marker for the same reason `newCr` uses one (scrubText would redact a digit run).
    const title = `FAULT_INJECTION_PROBE rollback probe`;
    const created = await app.inject({
      method: "POST", url: `/api/${co}/webdev/change-requests`, headers: asUser(admin),
      payload: { kind: "feature", title, body: "rolls back", clientId: clientA, projectId: projX },
    });
    expect(created.statusCode).toBe(201);
    const crId = (created.json() as { id: string }).id;

    try {
      const r = await triage(crId, { action: "convert", route: "mini_run" });
      expect(r.statusCode).toBe(500); // an unmapped PG error, i.e. the fault genuinely escaped

      // Nothing survived. Each of these is a distinct half of the atomicity claim.
      expect(await countRunsTitled(title)).toBe(0);
      expect(await countStagesFor(title)).toBe(0);
      expect(await countGatesFor(title)).toBe(0);
      const stray = await adminPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pipeline_stages WHERE artifact_ref LIKE '%FAULT_INJECTION_PROBE%'`,
      );
      expect(stray.rows[0].n).toBe(0);

      // TRANSACTIONAL OUTBOX: the event lives in the same transaction as the write it announces, so a
      // rollback un-emits it. An outbox row surviving here would publish `pipeline.run.created` for a
      // run that does not exist, and the shipped fanout would open a client gate on nothing.
      expect(await countRunCreatedEvents(title)).toBe(0);
      expect(await countCrEvents(crId)).toBe(0);

      // The CR is untouched — still `new`, so it is genuinely re-triageable rather than wedged
      // half-converted (the `wcr_route_matches_status` CHECK would not even permit the half state).
      const row = await adminPool().query(
        `SELECT status, route, pipeline_run_id, triaged_by, triaged_at FROM webdev_change_requests WHERE id = $1`, [crId],
      );
      expect(row.rows[0]).toMatchObject({ status: "new", route: null, pipeline_run_id: null, triaged_by: null, triaged_at: null });

      // No after-commit side effects either: notify/activity run only on a returned outcome.
      expect(await countActivities(crId, "converted")).toBe(0);
      const notifs = await adminPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM notifications WHERE payload->>'entityId' = $1`, [crId],
      );
      expect(notifs.rows[0].n).toBe(0);
    } finally {
      await adminPool().query(`DROP TRIGGER IF EXISTS mi03_inject_fault_trg ON pipeline_stages`);
      await adminPool().query(`DROP FUNCTION IF EXISTS mi03_inject_fault()`);
    }

    // FOLLOW-THROUGH: with the fault gone the same CR converts cleanly. This is what proves the
    // rollback left a usable row rather than a plausible-looking one.
    const retry = await triage(crId, { action: "convert", route: "mini_run" });
    expect(retry.statusCode).toBe(200);
    expect(await countRunsTitled(title)).toBe(1);
    expect(await countStagesFor(title)).toBe(2);
    expect(await countGatesFor(title)).toBe(1);
  });
});
