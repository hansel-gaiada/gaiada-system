// D14-05 — `deploy.staging` / `deploy.production` registry entries: the WD-08 dead end's first two
// concrete registrations. This file proves the two things the executor cannot verify on its own:
// (1) the precondition's four branches (fresh/blocked/already-deployed/unknown-run) map to exactly
// the typed reasons the ticket pins, and (2) a stale precondition, driven through the REAL executor
// (`executeApprovedAutomationWrite`), lands `failed` with `precondition_failed:*` and the hub is
// asserted (not inferred) to have been called zero times.
//
// No Nest app is built here — `executeApprovedAutomationWrite` and the registry are plain functions
// over Postgres + a stubbed `fetch`; Cerbos/HTTP plumbing is exercised by approval-execute.test.ts and
// approvals-decide.test.ts, which this file must not duplicate.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import { seedAutomationAccounts } from "../seed/automation";
import {
  registerExecutableApproval,
  resetExecutableApprovals,
  registerCoreExecutableApprovals,
  getExecutable,
} from "./approval-executables";
import { executeApprovedAutomationWrite } from "./approval-execute";

const GRANT_SECRET = "d14-05-test-secret-not-a-real-one";

describe.skipIf(!TEST_URL)("D14-05 registry: deploy.staging / deploy.production", () => {
  let co: string;
  let wfUser: string;

  beforeAll(async () => {
    await initTestDb();
    config.approvalGrantSecret = GRANT_SECRET;
    config.services.hub = { url: "http://hub.test", token: "hub-token" };
    // Independent of whatever another test file in this same worker left the registry in — restore
    // EXACTLY the production two entries via the exported bootstrap rather than hand-rolling a second
    // copy of their lock/precondition (see approval-executables.ts's doc on resetExecutableApprovals).
    resetExecutableApprovals();
    registerCoreExecutableApprovals();

    co = await createCompany("D14-05 Deploy Registry Co");
    await seedAutomationAccounts(co);
    const wf = await adminPool().query<{ user_id: string }>(
      `SELECT user_id FROM identity_links WHERE provider = 'n8n' AND external_id = 'wf:delivery'`,
    );
    wfUser = wf.rows[0].user_id;
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  /** Insert a bare pipeline_runs row and return its id. Shared by the precondition suite and the
   *  executor-integration suite below. */
  async function makeRun(status: string): Promise<string> {
    const id = newId();
    await withTenants([co], (c) =>
      c.query(`INSERT INTO pipeline_runs (id, tenant_id, status, origin_site) VALUES ($1, $2, $3, 'main')`, [
        id,
        co,
        status,
      ]),
    );
    return id;
  }

  async function makeStage(runId: string, name: "staging" | "production", status: string): Promise<void> {
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO pipeline_stages (id, tenant_id, run_id, track, name, status, origin_site)
         VALUES ($1, $2, $3, 'delivery', $4, $5, 'main')`,
        [newId(), co, runId, name, status],
      ),
    );
  }

  // ── registry doctrine: duplicate registration ──────────────────────────────────────────────────

  it("rejects a duplicate registration for a tool that is already registered", () => {
    expect(() => registerExecutableApproval({ toolName: "deploy.staging" })).toThrow(/already registered/i);
    expect(() => registerExecutableApproval({ toolName: "deploy.production" })).toThrow(/already registered/i);
  });

  it("both tools are registered with a real lockKey and precondition (not the D14-02 name-only fallback)", () => {
    for (const name of ["deploy.staging", "deploy.production"]) {
      const entry = getExecutable(name);
      expect(entry).toBeDefined();
      expect(entry!.toolName).toBe(name);
      // A name-only registration's lockKey is the literal `executable-approval:<name>` constant
      // (approval-executables.ts's fallback). A real entry must not be that.
      expect(entry!.lockKey({})).not.toBe(`executable-approval:${name}`);
    }
  });

  // ── lockKey: pure function of toolArgs, fails closed without collapsing to one constant ────────

  describe("lockKey", () => {
    it("keys on the runId when present, verbatim", () => {
      expect(getExecutable("deploy.staging")!.lockKey({ runId: "run-123" })).toBe("run-123");
      expect(getExecutable("deploy.production")!.lockKey({ runId: "run-123" })).toBe("run-123");
    });

    it("is stable across repeated calls with the same args (the retry requirement)", () => {
      const entry = getExecutable("deploy.staging")!;
      const args = { runId: "run-stable" };
      expect(entry.lockKey(args)).toBe(entry.lockKey({ ...args }));
      const malformed = {};
      expect(entry.lockKey(malformed)).toBe(entry.lockKey({}));
    });

    it("a missing/malformed runId does NOT collapse to a single constant shared by every such call", () => {
      const entry = getExecutable("deploy.staging")!;
      const missing = entry.lockKey({});
      const wrongType = entry.lockKey({ runId: 42 });
      const empty = entry.lockKey({ runId: "" });
      // Distinct malformed payloads of the SAME tool must not collide with each other...
      expect(new Set([missing, wrongType, empty]).size).toBe(3);
      // ...and none of them may equal a bare "one lock for every bad call" literal.
      for (const k of [missing, wrongType, empty]) {
        expect(k).not.toBe("deploy.staging");
        expect(k).not.toBe("deploy");
      }
    });

    it("the two tools never share a lock key for the same malformed args (namespaced by tool, not global)", () => {
      const badArgs = { runId: null };
      expect(getExecutable("deploy.staging")!.lockKey(badArgs)).not.toBe(
        getExecutable("deploy.production")!.lockKey(badArgs),
      );
    });
  });

  // ── precondition: the four typed branches, called directly under a live transaction ────────────

  describe("precondition", () => {
    async function runPrecondition(tool: "deploy.staging" | "deploy.production", args: Record<string, unknown>) {
      const entry = getExecutable(tool)!;
      return withTenants([co], (c) => entry.precondition(c, args));
    }

    it("fresh run, no stage row yet ⇒ pass", async () => {
      const runId = await makeRun("delivery_active");
      expect(await runPrecondition("deploy.staging", { runId })).toEqual({ ok: true });
      expect(await runPrecondition("deploy.production", { runId })).toEqual({ ok: true });
    });

    it("fresh run, stage exists but not yet done ⇒ pass", async () => {
      const runId = await makeRun("delivery_active");
      await makeStage(runId, "staging", "awaiting_gate");
      expect(await runPrecondition("deploy.staging", { runId })).toEqual({ ok: true });
    });

    it("a blocked run ⇒ run_blocked, for both tools", async () => {
      const runId = await makeRun("blocked");
      expect(await runPrecondition("deploy.staging", { runId })).toEqual({ ok: false, reason: "run_blocked" });
      expect(await runPrecondition("deploy.production", { runId })).toEqual({ ok: false, reason: "run_blocked" });
    });

    it("a completed run ⇒ run_blocked (the run's work is already over)", async () => {
      const runId = await makeRun("complete");
      expect(await runPrecondition("deploy.staging", { runId })).toEqual({ ok: false, reason: "run_blocked" });
    });

    it("the target stage already 'done' ⇒ stage_already_deployed", async () => {
      const runId = await makeRun("delivery_active");
      await makeStage(runId, "staging", "done");
      expect(await runPrecondition("deploy.staging", { runId })).toEqual({
        ok: false,
        reason: "stage_already_deployed",
      });
      // deploy.production checks its OWN stage name — a done 'staging' stage must not block it.
      expect(await runPrecondition("deploy.production", { runId })).toEqual({ ok: true });
    });

    it("an unknown run id ⇒ run_not_found", async () => {
      const bogus = newId();
      expect(await runPrecondition("deploy.staging", { runId: bogus })).toEqual({
        ok: false,
        reason: "run_not_found",
      });
    });

    it("a soft-deleted run is treated as not found", async () => {
      const runId = await makeRun("delivery_active");
      await withTenants([co], (c) => c.query(`UPDATE pipeline_runs SET deleted_at = now() WHERE id = $1`, [runId]));
      expect(await runPrecondition("deploy.staging", { runId })).toEqual({ ok: false, reason: "run_not_found" });
    });

    it("missing/malformed runId in tool_args fails closed as run_not_found — never touches the DB", async () => {
      for (const badArgs of [{}, { runId: 42 }, { runId: "" }, { runId: null }, { runId: "   " }]) {
        expect(await runPrecondition("deploy.staging", badArgs as Record<string, unknown>)).toEqual({
          ok: false,
          reason: "run_not_found",
        });
      }
    });
  });

  // ── the executor: hub is asserted, not inferred, to be called zero times on a stale precondition ─

  describe("through the executor (executeApprovedAutomationWrite)", () => {
    let hubCalls: Array<{ url: string }> = [];
    const realFetch = globalThis.fetch;

    function installHubStub(): void {
      hubCalls = [];
      const stub = vi.fn(async (url: string, init: any) => {
        if (!String(url).startsWith("http://hub.test")) return realFetch(url as any, init);
        hubCalls.push({ url: String(url) });
        return { ok: true, status: 200, text: async (): Promise<string> => "event: message\ndata: {}\n\n" };
      });
      vi.stubGlobal("fetch", stub as unknown as typeof fetch);
    }

    beforeEach(() => installHubStub());
    afterEach(() => vi.restoreAllMocks());

    async function fileDecided(toolName: string, args: Record<string, unknown>): Promise<string> {
      const id = newId();
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO automation_approvals
             (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at,
              origin, origin_site, execution_status)
           VALUES ($1, $2, 'wf:delivery', $3, $4, 'high', 'approved', $5, $5, now(), 'automation', 'main', 'pending')`,
          [id, co, toolName, JSON.stringify(args), wfUser],
        ),
      );
      return id;
    }

    async function rowOf(id: string) {
      const r = await adminPool().query(`SELECT execution_status, execution_error FROM automation_approvals WHERE id = $1`, [id]);
      return r.rows[0];
    }

    it("an approved deploy.staging row for a STALE run (blocked) ends failed with precondition_failed:run_blocked, and the hub is called ZERO times", async () => {
      const runId = await makeRun("blocked");
      const id = await fileDecided("deploy.staging", { runId, repo: "acme/site" });

      const outcome = await executeApprovedAutomationWrite(co, id);

      expect(outcome.status).toBe("failed");
      expect(outcome).toMatchObject({ error: "precondition_failed: run_blocked" });
      // Asserted directly on the call count the stub recorded — not inferred from the outcome.
      expect(hubCalls).toHaveLength(0);
      const row = await rowOf(id);
      expect(row.execution_status).toBe("failed");
      expect(row.execution_error).toBe("precondition_failed: run_blocked");
    });

    it("an approved deploy.production row against an already-deployed stage ends failed with precondition_failed:stage_already_deployed, and the hub is called ZERO times", async () => {
      const runId = await makeRun("delivery_active");
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO pipeline_stages (id, tenant_id, run_id, track, name, status, origin_site)
           VALUES ($1, $2, $3, 'delivery', 'production', 'done', 'main')`,
          [newId(), co, runId],
        ),
      );
      const id = await fileDecided("deploy.production", { runId, repo: "acme/site" });

      const outcome = await executeApprovedAutomationWrite(co, id);

      expect(outcome).toMatchObject({ status: "failed", error: "precondition_failed: stage_already_deployed" });
      expect(hubCalls).toHaveLength(0);
    });

    it("a deploy row with no runId at all ends failed with precondition_failed:run_not_found, and the hub is called ZERO times", async () => {
      const id = await fileDecided("deploy.staging", { repo: "acme/site" }); // no runId

      const outcome = await executeApprovedAutomationWrite(co, id);

      expect(outcome).toMatchObject({ status: "failed", error: "precondition_failed: run_not_found" });
      expect(hubCalls).toHaveLength(0);
    });

    it("a fresh run's approved deploy.staging DOES call the hub exactly once (the positive control for the zero-calls assertions above)", async () => {
      const runId = await makeRun("delivery_active");
      const id = await fileDecided("deploy.staging", { runId, repo: "acme/site" });

      const outcome = await executeApprovedAutomationWrite(co, id);

      expect(outcome.status).toBe("executed");
      expect(hubCalls).toHaveLength(1);
    });
  });
});
