// PRV-03 — `webdev.provisionSite` D14 registry entry: the authorization/automation half of the
// provision<->ERP seam. Mirrors approval-executables.test.ts (D14-05) and d14-15-pm-registry.test.ts
// (D14-15) byte-for-byte in shape: (1) the precondition's typed branches map to exactly the reasons
// `evaluateProvisionPrecondition` returns, (2) a stale precondition driven through the REAL executor
// (`executeApprovedAutomationWrite`) lands `failed` with `precondition_failed:*` and the hub is
// asserted — not inferred — to have been called zero times, and (3) the happy path calls the hub
// exactly once. No Nest app is built here — plain functions over Postgres + a stubbed `fetch`.
//
// Design: docs/blueprints/provision-erp-seam-design.md §04/§06/§09 D-P5.
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
  registerPmExecutableApprovals,
  registerWebdevExecutableApprovals,
  getExecutable,
} from "./approval-executables";
import { executeApprovedAutomationWrite } from "./approval-execute";

const GRANT_SECRET = "prv-03-test-secret-not-a-real-one";

describe.skipIf(!TEST_URL)("PRV-03 registry: webdev.provisionSite", () => {
  let co: string;
  let wfUser: string;

  beforeAll(async () => {
    await initTestDb();
    config.approvalGrantSecret = GRANT_SECRET;
    config.services.hub = { url: "http://hub.test", token: "hub-token", assuranceToken: "" };
    // Independent of whatever another test file in this worker left the registry in — restore the
    // FULL production set (deploy.* + pm.* + webdev.*) via the exported bootstraps rather than
    // hand-rolling a second copy of anyone's lock/precondition.
    resetExecutableApprovals();
    registerCoreExecutableApprovals();
    registerPmExecutableApprovals();
    registerWebdevExecutableApprovals();

    co = await createCompany("PRV-03 Registry Co");
    await seedAutomationAccounts(co);
    const wf = await adminPool().query<{ user_id: string }>(
      `SELECT user_id FROM identity_links WHERE provider = 'n8n' AND external_id = 'wf:delivery'`,
    );
    wfUser = wf.rows[0].user_id;
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  /** Bare pipeline_runs row. Shared by the precondition suite and the executor-integration suite. */
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

  async function makeGate(
    runId: string,
    kind: string,
    status: "pending" | "decided",
    decision: string | null,
  ): Promise<void> {
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO pipeline_gates (id, tenant_id, run_id, kind, actor_side, status, decision, origin_site)
         VALUES ($1, $2, $3, $4, 'internal', $5, $6, 'main')`,
        [newId(), co, runId, kind, status, decision],
      ),
    );
  }

  // ── registry doctrine: duplicate registration ──────────────────────────────────────────────────

  it("rejects a duplicate registration for webdev.provisionSite", () => {
    expect(() => registerExecutableApproval({ toolName: "webdev.provisionSite" })).toThrow(/already registered/i);
  });

  it("is registered with a real lockKey and precondition (not the D14-02 name-only fallback)", () => {
    const entry = getExecutable("webdev.provisionSite");
    expect(entry).toBeDefined();
    expect(entry!.toolName).toBe("webdev.provisionSite");
    expect(entry!.lockKey({})).not.toBe("executable-approval:webdev.provisionSite");
  });

  // ── lockKey: pure function of toolArgs, fails closed without collapsing to one constant ─────────

  describe("lockKey", () => {
    it("keys on the runId when present, verbatim", () => {
      expect(getExecutable("webdev.provisionSite")!.lockKey({ runId: "run-123" })).toBe("run-123");
    });

    it("is stable across repeated calls with the same args (the retry requirement)", () => {
      const entry = getExecutable("webdev.provisionSite")!;
      const args = { runId: "run-stable" };
      expect(entry.lockKey(args)).toBe(entry.lockKey({ ...args }));
      expect(entry.lockKey({})).toBe(entry.lockKey({}));
    });

    it("a missing/malformed runId does NOT collapse to a single constant shared by every such call", () => {
      const entry = getExecutable("webdev.provisionSite")!;
      const missing = entry.lockKey({});
      const wrongType = entry.lockKey({ runId: 42 });
      const empty = entry.lockKey({ runId: "" });
      expect(new Set([missing, wrongType, empty]).size).toBe(3);
      for (const k of [missing, wrongType, empty]) {
        expect(k).not.toBe("webdev.provisionSite");
      }
    });

    it("never shares a lock key with deploy.staging for the same malformed args (namespaced by tool)", () => {
      const badArgs = { runId: null };
      expect(getExecutable("webdev.provisionSite")!.lockKey(badArgs)).not.toBe(
        getExecutable("deploy.staging")!.lockKey(badArgs),
      );
    });
  });

  // ── precondition: re-derives run + prd_sign-gate state, never trusts approval-time state ────────

  describe("precondition (requireSignedPrdGate: true — the automation-path split)", () => {
    async function runPrecondition(args: Record<string, unknown>) {
      const entry = getExecutable("webdev.provisionSite")!;
      return withTenants([co], (c) => entry.precondition(c, args));
    }

    it("a fresh run with prd_sign decided approved ⇒ pass", async () => {
      const runId = await makeRun("delivery_active");
      await makeGate(runId, "prd_sign", "decided", "approved");
      expect(await runPrecondition({ runId })).toEqual({ ok: true });
    });

    it("a fresh run with prd_sign decided signed ⇒ pass (the design's second accepted decision value)", async () => {
      const runId = await makeRun("delivery_active");
      await makeGate(runId, "prd_sign", "decided", "signed");
      expect(await runPrecondition({ runId })).toEqual({ ok: true });
    });

    it("a run whose prd_sign gate is still PENDING ⇒ prd_gate_not_decided (the window this re-check exists to close)", async () => {
      const runId = await makeRun("delivery_active");
      await makeGate(runId, "prd_sign", "pending", null);
      expect(await runPrecondition({ runId })).toEqual({ ok: false, reason: "prd_gate_not_decided" });
    });

    it("a run with NO prd_sign gate at all ⇒ prd_gate_not_decided", async () => {
      const runId = await makeRun("delivery_active");
      expect(await runPrecondition({ runId })).toEqual({ ok: false, reason: "prd_gate_not_decided" });
    });

    it("a run whose prd_sign gate was decided REJECTED ⇒ prd_gate_not_decided (rejected is not approved/signed)", async () => {
      const runId = await makeRun("delivery_active");
      await makeGate(runId, "prd_sign", "decided", "rejected");
      expect(await runPrecondition({ runId })).toEqual({ ok: false, reason: "prd_gate_not_decided" });
    });

    it("a blocked run ⇒ run_blocked, even with prd_sign approved (the run itself may not acquire new infrastructure)", async () => {
      const runId = await makeRun("blocked");
      await makeGate(runId, "prd_sign", "decided", "approved");
      expect(await runPrecondition({ runId })).toEqual({ ok: false, reason: "run_blocked" });
    });

    it("an unknown run id ⇒ run_not_found", async () => {
      const bogus = newId();
      expect(await runPrecondition({ runId: bogus })).toEqual({ ok: false, reason: "run_not_found" });
    });

    it("a soft-deleted run is treated as not found", async () => {
      const runId = await makeRun("delivery_active");
      await makeGate(runId, "prd_sign", "decided", "approved");
      await withTenants([co], (c) => c.query(`UPDATE pipeline_runs SET deleted_at = now() WHERE id = $1`, [runId]));
      expect(await runPrecondition({ runId })).toEqual({ ok: false, reason: "run_not_found" });
    });

    it("missing/malformed runId in tool_args fails closed as run_not_found — never touches the DB", async () => {
      for (const badArgs of [{}, { runId: 42 }, { runId: "" }, { runId: null }, { runId: "   " }]) {
        expect(await runPrecondition(badArgs as Record<string, unknown>)).toEqual({
          ok: false,
          reason: "run_not_found",
        });
      }
    });
  });

  // ── the executor: hub is asserted, not inferred, to be called zero times on a stale precondition ─

  describe("through the executor (executeApprovedAutomationWrite) — proves re-derivation, not trust", () => {
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

    async function fileDecided(args: Record<string, unknown>): Promise<string> {
      const id = newId();
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO automation_approvals
             (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at,
              origin, origin_site, execution_status)
           VALUES ($1, $2, 'wf:delivery', 'webdev.provisionSite', $3, 'medium', 'approved', $4, $4, now(),
                   'automation', 'main', 'pending')`,
          [id, co, JSON.stringify(args), wfUser],
        ),
      );
      return id;
    }

    async function rowOf(id: string) {
      const r = await adminPool().query(
        `SELECT execution_status, execution_error FROM automation_approvals WHERE id = $1`,
        [id],
      );
      return r.rows[0];
    }

    it(
      "THE CORE PROOF — an approval filed when prd_sign was approved, but the gate got REVERSED " +
        "before the human clicked Approve, ends failed with precondition_failed:prd_gate_not_decided " +
        "and the hub is called ZERO times. This is the exact window the re-derivation exists to close: " +
        "the row was filed with `prd_sign` approved (real at proposal time), state then changed, and the " +
        "executor must re-check current state rather than trust what was true when it was filed.",
      async () => {
        const runId = await makeRun("delivery_active");
        await makeGate(runId, "prd_sign", "decided", "approved");
        const id = await fileDecided({ tenantId: co, runId, framework: "vite" });

        // Simulate the gate being reversed after filing (a re-open + re-decide as rejected) — the
        // approval row itself is untouched; only the pipeline state it was filed against moves.
        await withTenants([co], (c) =>
          c.query(`UPDATE pipeline_gates SET decision = 'rejected' WHERE run_id = $1 AND kind = 'prd_sign'`, [runId]),
        );

        const outcome = await executeApprovedAutomationWrite(co, id);

        expect(outcome.status).toBe("failed");
        expect(outcome).toMatchObject({ error: "precondition_failed: prd_gate_not_decided" });
        expect(hubCalls).toHaveLength(0);
        const row = await rowOf(id);
        expect(row.execution_status).toBe("failed");
        expect(row.execution_error).toBe("precondition_failed: prd_gate_not_decided");
      },
    );

    it("an approved row for a run parked BLOCKED between filing and approval ends failed with precondition_failed:run_blocked, hub called ZERO times", async () => {
      const runId = await makeRun("delivery_active");
      await makeGate(runId, "prd_sign", "decided", "approved");
      const id = await fileDecided({ tenantId: co, runId, framework: "vite" });

      await withTenants([co], (c) => c.query(`UPDATE pipeline_runs SET status = 'blocked' WHERE id = $1`, [runId]));

      const outcome = await executeApprovedAutomationWrite(co, id);

      expect(outcome).toMatchObject({ status: "failed", error: "precondition_failed: run_blocked" });
      expect(hubCalls).toHaveLength(0);
    });

    it("a row with no runId at all ends failed with precondition_failed:run_not_found, hub called ZERO times", async () => {
      const id = await fileDecided({ tenantId: co, framework: "vite" }); // no runId

      const outcome = await executeApprovedAutomationWrite(co, id);

      expect(outcome).toMatchObject({ status: "failed", error: "precondition_failed: run_not_found" });
      expect(hubCalls).toHaveLength(0);
    });

    it(
      "THE POSITIVE CONTROL — a run whose prd_sign gate is STILL approved at execution time DOES call " +
        "the hub exactly once (proves the zero-call assertions above are a real refusal, not a broken stub)",
      async () => {
        const runId = await makeRun("delivery_active");
        await makeGate(runId, "prd_sign", "decided", "approved");
        const id = await fileDecided({ tenantId: co, runId, framework: "vite" });

        const outcome = await executeApprovedAutomationWrite(co, id);

        expect(outcome.status).toBe("executed");
        expect(hubCalls).toHaveLength(1);
      },
    );

    it("the happy path executes EXACTLY ONCE even when the executor is invoked twice (at-least-once redelivery)", async () => {
      const runId = await makeRun("delivery_active");
      await makeGate(runId, "prd_sign", "decided", "signed");
      const id = await fileDecided({ tenantId: co, runId, framework: "vite" });

      const first = await executeApprovedAutomationWrite(co, id);
      expect(first.status).toBe("executed");
      expect(hubCalls).toHaveLength(1);

      const second = await executeApprovedAutomationWrite(co, id);
      expect(second).toEqual({ status: "skipped", reason: "not_pending" });
      expect(hubCalls).toHaveLength(1);

      const row = await rowOf(id);
      expect(row.execution_status).toBe("executed");
    });
  });
});
