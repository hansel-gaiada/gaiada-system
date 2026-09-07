// QA gate — AD-6 agency-lead CONVERT concurrency proof, driven against REAL Postgres.
//
// Model: `webdev-cr-race.test.ts` (MI-03), read in full before writing this file, and followed
// deliberately rather than inventing a second concurrency-testing style. Same three properties
// make this a real proof rather than a `Promise.all`-and-hope test:
//
//  1. The driver PRE-TAKES the lead's advisory lock (AGENCY_LEAD_LOCK_NS, agency-lead-convert
//     .service.ts) on a dedicated OWNER connection (adminPool(), never the app's own pool — an
//     advisory lock is SESSION-REENTRANT, so taking it on a connection the app might reuse would
//     grant it again and block nothing).
//  2. THE COLLISION IS ASSERTED VIA pg_locks (`waitForAdvisoryWaiters`), not assumed from timing.
//  3. FALSIFIABILITY: the lock-less read-then-write shape is replayed at the SQL level first, and
//     really does spawn two client rows for one lead — proving the race window is real and that a
//     lock alone (§6.2: "a lock alone does nothing... both racers merely take turns and still spawn
//     twice, DEF-2's exact shape") would not have been enough without the re-check under it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { AGENCY_LEAD_LOCK_NS } from "./agency-lead-convert.service";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    p.then(() => true, () => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ]);
}

interface ConvertOk { id: string; status: string; clientId: string; projectId: string; runId: string }
interface ConvertConflict { message: string; existing?: { clientId: string | null; projectId: string | null; runId: string | null } }

describe.skipIf(!TEST_URL)("AD-6 — agency lead convert idempotency under a real race", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();

    co = await createCompany("Gaiada Creative");
    admin = await createUser("admin@lead-race.test");
    await addMembership(co, admin);
    await grantRole(admin, await createRole("company_admin"), "company", co);

    app = await buildApp();
  }, 60000);

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────
  let seq = 0;
  /** A fresh 'submitted' lead, inserted directly (this file is testing the CONVERT transition, not
   *  the submit path — that is agency-discovery-intake-e2e.db.test.ts's job). org_name is
   *  letters-only per file-suffix, mirroring webdev-cr-race.test.ts's own reasoning: a digit run in
   *  the title would trip scrubText()'s PAN rule on OTHER paths in this codebase, and while nothing
   *  here scrubs org_name, keeping the same discipline means a count-by-name assertion is never
   *  accidentally comparing against a scrubbed value. */
  async function newLead(status: "submitted" | "in_review" | "nurturing" | "declined" = "submitted"): Promise<{ id: string; orgName: string }> {
    const orgName = `Race Org ${String.fromCharCode(97 + (seq % 26))}${++seq}`;
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO agency_leads (id, tenant_id, org_name, contact_name, contact_email, contact_phone, source, status, owner_id, origin_site, declined_reason)
         VALUES ($1, $2, $3, 'Prospect Contact', $4, '+62-811-000-000', 'invite', $5, $6, 'test', $7)`,
        [id, co, orgName, `${id}@prospect.test`, status, admin, status === "declined" ? "no budget" : null],
      ),
    );
    return { id, orgName };
  }

  const convert = (leadId: string, delegations: unknown[] = []) =>
    app.inject({
      method: "POST",
      url: `/api/${co}/agency/leads/${leadId}/convert`,
      headers: asUser(admin),
      payload: { delegations },
    });

  /** Hold the lead's advisory lock on a dedicated OWNER connection — every convert handler for this
   *  lead parks at `lockAgencyLead` while held. */
  async function holdLeadLock(leadId: string): Promise<() => Promise<void>> {
    const c = await adminPool().connect();
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [AGENCY_LEAD_LOCK_NS, leadId]);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await c.query("COMMIT");
      c.release();
    };
  }

  /** Ungranted advisory-lock waiters in THIS database. Per-file physical databases mean the only
   *  advisory locks here are this suite's own. */
  async function advisoryWaiters(): Promise<number> {
    const r = await adminPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    return r.rows[0].n;
  }

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

  const countClientsNamed = async (orgName: string) =>
    (await adminPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM clients WHERE name = $1`, [orgName])).rows[0].n;
  const countProjectsNamed = async (orgName: string) =>
    (await adminPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM projects WHERE name = $1`, [orgName])).rows[0].n;
  const countRunsTitled = async (orgName: string) =>
    (await adminPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM pipeline_runs WHERE title = $1`, [orgName])).rows[0].n;
  const countStagesFor = async (orgName: string) =>
    (
      await adminPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pipeline_stages s JOIN pipeline_runs r ON r.id = s.run_id WHERE r.title = $1`,
        [orgName],
      )
    ).rows[0].n;
  const countGatesFor = async (orgName: string) =>
    (
      await adminPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pipeline_gates g JOIN pipeline_runs r ON r.id = g.run_id WHERE r.title = $1`,
        [orgName],
      )
    ).rows[0].n;
  const countRunCreatedEvents = async (orgName: string) =>
    (
      await adminPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'pipeline.run.created' AND payload->>'title' = $1`,
        [orgName],
      )
    ).rows[0].n;
  const countConvertedEvents = async (leadId: string) =>
    (
      await adminPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM outbox_events WHERE entity_type = 'agency_lead' AND entity_id = $1 AND event_type = 'agency.lead.converted'`,
        [leadId],
      )
    ).rows[0].n;

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // FALSIFIABILITY — the race window is real, and a lock alone would not have closed it
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("FALSIFIABILITY: the lock-less read-then-write shape really does spawn TWO client rows for one lead", async () => {
    const lead = await newLead();
    const a = await adminPool().connect();
    const b = await adminPool().connect();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      for (const c of [a, b]) {
        const seen = await c.query<{ status: string }>(`SELECT status FROM agency_leads WHERE id = $1`, [lead.id]);
        expect(seen.rows[0].status).toBe("submitted");
      }
      const insClient = `INSERT INTO clients (id, tenant_id, name, origin_site) VALUES (gen_random_uuid(), $1, $2, 'test') RETURNING id`;
      const clientA = (await a.query<{ id: string }>(insClient, [co, lead.orgName])).rows[0].id;
      const clientB = (await b.query<{ id: string }>(insClient, [co, lead.orgName])).rows[0].id;
      const link = `UPDATE agency_leads SET status='converted', converted_client_id=$2 WHERE id = $1 AND status = ANY(ARRAY['submitted','in_review','nurturing'])`;
      const upA = await a.query(link, [lead.id, clientA]);
      await a.query("COMMIT");
      // B's UPDATE blocks on A's row lock, re-evaluates the WHERE against the COMMITTED row, and
      // matches nothing — `ux_lead_client` and the WHERE guard together stop the LINK...
      let upBErr: unknown = null;
      let upB: { rowCount: number | null } = { rowCount: 0 };
      try {
        upB = await b.query(link, [lead.id, clientB]);
        await b.query("COMMIT");
      } catch (err) {
        upBErr = err;
        await b.query("ROLLBACK").catch(() => {});
      }
      expect(upA.rowCount).toBe(1);
      // Either the WHERE guard alone refuses the link (rowCount 0) — because A already committed
      // 'converted' — or, if B's read happened to still see an open status, `ux_lead_client`'s
      // partial unique refuses the SECOND link outright. Both are acceptable outcomes for THIS
      // probe; what matters is that at most one link ever survives.
      if (!upBErr) expect(upB.rowCount).toBe(0);
    } finally {
      a.release();
      b.release();
    }
    // ...but regardless of whether the LINK survived, TWO client rows exist — a fully-formed client
    // record nothing points at. This is the finding that makes the server-side re-check load-bearing:
    // the UPDATE guard (and even the partial unique) can only ever refuse to LINK a twin, never to
    // CREATE one.
    expect(await countClientsNamed(lead.orgName)).toBe(2);
  });

  it("...and the lead lock is what closes that window: a second decider cannot even read the lead while the first holds it", async () => {
    const lead = await newLead();
    const a = await adminPool().connect();
    const b = await adminPool().connect();
    try {
      await a.query("BEGIN");
      await a.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [AGENCY_LEAD_LOCK_NS, lead.id]);
      await b.query("BEGIN");
      const bWaits = b.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [AGENCY_LEAD_LOCK_NS, lead.id]);
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
  // THE HEADLINE AC — two concurrent converts, exactly ONE spawn, loser 409s with the existing ids
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("two CONCURRENT converts on one lead spawn exactly ONE client+project+run+stages+gate; the loser 409s carrying the existing ids", async () => {
    const lead = await newLead();
    const release = await holdLeadLock(lead.id);
    try {
      const flights = [0, 1].map(() => convert(lead.id));

      // COLLISION PROOF: both handlers are inside their transactions, queued on the SAME advisory
      // lock key, having read nothing race-sensitive yet.
      await waitForAdvisoryWaiters(2);
      expect(await settledWithin(Promise.all(flights), 300)).toBe(false);
      expect(await countClientsNamed(lead.orgName)).toBe(0); // neither spawned before blocking

      await release();
      const results = await Promise.all(flights);

      // Asserted FIRST, on purpose (mutation-probe tripwire): the status code is only the symptom,
      // the corruption is a second client-facing client/project/run.
      expect(await countClientsNamed(lead.orgName)).toBe(1);
      expect(await countProjectsNamed(lead.orgName)).toBe(1);
      expect(await countRunsTitled(lead.orgName)).toBe(1);
      expect(await countStagesFor(lead.orgName)).toBe(2); // prd_extract + scope_extract, once
      expect(await countGatesFor(lead.orgName)).toBe(1); // the single client prd_sign gate
      expect(await countRunCreatedEvents(lead.orgName)).toBe(1);
      expect(await countConvertedEvents(lead.id)).toBe(1);

      const codes = results.map((r) => r.statusCode).sort();
      expect(codes).toEqual([200, 409]);

      const winner = results.find((r) => r.statusCode === 200)!.json() as ConvertOk;
      const loser = results.find((r) => r.statusCode === 409)!.json() as ConvertConflict;
      expect(winner).toMatchObject({ id: lead.id, status: "converted" });
      expect(winner.clientId).toBeTruthy();
      expect(winner.projectId).toBeTruthy();
      expect(winner.runId).toBeTruthy();

      // The loser resolves to the artifact that ALREADY EXISTS — `existing` survives
      // HttpErrorFilter's `{error}` reshape (agency-lead-convert.controller.ts forwards it exactly
      // as webdev-change-requests.controller.ts does for its own AC).
      expect(loser.existing).toMatchObject({
        clientId: winner.clientId, projectId: winner.projectId, runId: winner.runId,
      });

      // The lead's own row agrees, and the DDL's state machine holds.
      const row = await adminPool().query(
        `SELECT status, converted_client_id, converted_project_id, pipeline_run_id, triaged_by
           FROM agency_leads WHERE id = $1`, [lead.id],
      );
      expect(row.rows[0]).toMatchObject({
        status: "converted", converted_client_id: winner.clientId,
        converted_project_id: winner.projectId, pipeline_run_id: winner.runId, triaged_by: admin,
      });

      // Schema backstop: ux_lead_client / ux_lead_run hold even if some future hand-written path
      // tried to link a SECOND lead to the same client/run.
      const other = await newLead();
      await expect(
        withTenants([co], (c) =>
          c.query(
            `UPDATE agency_leads SET status='converted', converted_client_id=$2, pipeline_run_id=$3 WHERE id = $1`,
            [other.id, winner.clientId, winner.runId],
          ),
        ),
      ).rejects.toThrow(/ux_lead_client|duplicate key/i);
    } finally {
      await release();
    }
  });

  it("FOUR concurrent converts still spawn exactly ONE client/project/run; all three losers 409 with the SAME ids", async () => {
    const lead = await newLead();
    const release = await holdLeadLock(lead.id);
    try {
      const flights = Array.from({ length: 4 }, () => convert(lead.id));
      await waitForAdvisoryWaiters(4);
      expect(await settledWithin(Promise.all(flights), 300)).toBe(false);
      await release();
      const results = await Promise.all(flights);

      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 409)).toHaveLength(3);
      const runIds = new Set(
        results.map((r) =>
          r.statusCode === 200 ? (r.json() as ConvertOk).runId : (r.json() as ConvertConflict).existing?.runId,
        ),
      );
      expect(runIds.size).toBe(1);
      expect(await countClientsNamed(lead.orgName)).toBe(1);
      expect(await countRunsTitled(lead.orgName)).toBe(1);
      expect(await countRunCreatedEvents(lead.orgName)).toBe(1);
    } finally {
      await release();
    }
  });

  it("a SEQUENTIAL repeat convert (an HTTP retry of a request that committed) 409s with the existing ids, no twin spawned", async () => {
    const lead = await newLead();
    const first = await convert(lead.id);
    expect(first.statusCode).toBe(200);
    const won = first.json() as ConvertOk;

    for (let i = 0; i < 3; i++) {
      const again = await convert(lead.id);
      expect(again.statusCode).toBe(409);
      expect((again.json() as ConvertConflict).existing).toMatchObject({
        clientId: won.clientId, projectId: won.projectId, runId: won.runId,
      });
    }
    expect(await countClientsNamed(lead.orgName)).toBe(1);
    expect(await countRunsTitled(lead.orgName)).toBe(1);
    expect(await countRunCreatedEvents(lead.orgName)).toBe(1);
  });

  it("a DECLINED lead cannot be converted — the loser reports existing ids of null (nothing ever spawned)", async () => {
    const lead = await newLead("declined");
    const result = await convert(lead.id);
    expect(result.statusCode).toBe(409);
    expect((result.json() as ConvertConflict).existing).toMatchObject({ clientId: null, projectId: null, runId: null });
    expect(await countClientsNamed(lead.orgName)).toBe(0);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // LOCK SCOPE — the plausible wrong scope (per-tenant) would serialize every convert in the tenant
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("LOCK SCOPE: one lead holding its lock does NOT block a DIFFERENT lead's convert", async () => {
    const leadA = await newLead();
    const leadB = await newLead();
    const release = await holdLeadLock(leadA.id);
    try {
      const blockedA = convert(leadA.id);
      await waitForAdvisoryWaiters(1);
      expect(await settledWithin(blockedA, 300)).toBe(false);

      // B's identical transition completes normally. Both leads share ONE tenant, so a tenant-keyed
      // lock — the plausible wrong scope (pipeline-lock.ts:32-37's own lesson, applied here) —
      // would park this too.
      const okB = await convert(leadB.id);
      expect(okB.statusCode).toBe(200);
      expect(await countClientsNamed(leadB.orgName)).toBe(1);

      // A is still parked — B's completion was genuine parallelism, not the lock having lapsed.
      expect(await settledWithin(blockedA, 200)).toBe(false);
      expect(await countClientsNamed(leadA.orgName)).toBe(0);

      await release();
      expect((await blockedA).statusCode).toBe(200);
      expect(await countClientsNamed(leadA.orgName)).toBe(1);
    } finally {
      await release();
    }
  });
});
