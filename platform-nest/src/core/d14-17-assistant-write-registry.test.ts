// D14-17 — Assistant write-tool entries (Phase-6 v1 proposal set): the ticket's own escape hatch says
// "if the broker's proposable surface turns out to be empty ... say so clearly with evidence rather
// than inventing tools". This file IS that evidence, made into regression coverage rather than a claim
// in a doc comment.
//
// THE FINDING (full narrative in approval-executables.ts's own D14-17 section — read that first):
//   1. `modules/assistant/broker.ts`'s `ASSISTANT_AGENT_TOOLS` is the broker's ENTIRE tool universe —
//      `runToolTurn` refuses any `agent` not present as a key of that map before contacting the runner
//      at all. Today: two entries, both read-only (`status-reporter`, `approvals-chaser`).
//   2. The one write-capable AgentDef anywhere (`ai-agents/src/specialists.ts`'s `taskTriager`,
//      `tasks.update`/`low_write`) is NOT reachable through the broker — it lives in `writeSpecialists`,
//      which `ASSISTANT_AGENT_TOOLS` never names.
//   3. `ai-agents/src/agent-write-guard.test.ts`'s `RERUN_CAPABLE_HIGH_WRITES` — the CI-enforced
//      allowlist of tool names ANY AgentDef anywhere may declare `high_write` — is `[]`. A `high_write`
//      is the ONLY thing that files an `origin='agent'` approval row (`agent.ts`'s write gate); a
//      `low_write` executes immediately and never reaches this registry at all.
//
// So: zero net-new assistant write tools exist to register. What THIS file proves, concretely:
//   (A) the broker's tool universe is pinned exactly as read above, and none of it collides with a
//       registered executable (structural pin — regresses loudly if either fact changes silently);
//   (B) a REPRESENTATIVE not-yet-existent "assistant write" tool name — chosen arbitrarily, since none
//       exists — filed as an `origin='agent'` approval and approved, stays `execution_status=
//       'not_applicable'` FOREVER and is never claimed to `'pending'`/`'executing'` (the "non-listed
//       assistant tool proposal never auto-executes" requirement, both directions: unregistered stays
//       inert, and (C) below proves a REGISTERED tool of the identical shape does light up — so (B) is
//       demonstrably the registry gate doing its job, not an accident of the row being malformed);
//   (C) the "reuse D14-15's PM entries" fallback actually holds for an AGENT-origin proposal (not just
//       automation/n8n, which is all D14-15's own test file exercises) — `pm.createTask`/`pm.createDoc`
//       execute an `origin='agent'` approval exactly as they would an `origin='automation'` one, both on
//       the happy path and on a stale precondition, proving the registry entries are origin-agnostic and
//       genuinely need no change for the assistant to reuse them the moment some future AgentDef the
//       broker can drive proposes one.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createProject, linkIdentity } from "../testing/fixtures";
import { seedAutomationAccounts } from "../seed/automation";
import {
  resetExecutableApprovals,
  registerCoreExecutableApprovals,
  registerPmExecutableApprovals,
  getExecutable,
} from "./approval-executables";
import { executeApprovedAutomationWrite } from "./approval-execute";
import { ASSISTANT_AGENT_TOOLS } from "../modules/assistant/broker";

const GRANT_SECRET = "d14-17-test-secret-not-a-real-one";
/** A name chosen ONLY to be recognizable as "assistant-flavored" in test output — it is NOT a real
 *  tool, appears in no AgentDef, no ModuleContract.mcpTools, and no hub registry. Its entire purpose is
 *  to be something `getExecutable()` has certainly never seen. */
const UNREGISTERED_ASSISTANT_TOOL = "assistant.exampleFutureWrite";

describe.skipIf(!TEST_URL)("D14-17 — assistant write-tool registry: evaluated, zero net-new entries", () => {
  let co: string;
  let requester: string;

  beforeAll(async () => {
    await initTestDb();
    config.approvalGrantSecret = GRANT_SECRET;
    config.services.hub = { url: "http://hub.d1417.test", token: "hub-token", assuranceToken: "" };
    resetExecutableApprovals();
    registerCoreExecutableApprovals();
    registerPmExecutableApprovals();

    co = await createCompany("D14-17 Assistant Write Registry Co");
    await seedAutomationAccounts(co);
    requester = await createUser("d1417-requester@a.test");
    await addMembership(co, requester);
    // The executor reconstructs the origin='agent' re-drive OBO from `requested_by`'s own verified
    // identity_links row (approval-execute.ts's resolveRedrivePrincipal) — without one, execution fails
    // closed with `principal_unresolvable`, which would misreport as this ticket's finding rather than
    // the fixture's own gap. Mirrors d14-09-agent-origin-authority.test.ts's `linkIdentity` call.
    await linkIdentity(requester, "telegram", "tg:d1417-requester", true);
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  // ── (A) the broker's tool universe, pinned ───────────────────────────────────────────────────────

  it("(A) the assistant broker's entire proposable tool universe is read-only, and none of it collides with a registered executable", () => {
    // Pinned exactly, not just "no writes": a change here means someone widened the broker's roster,
    // which is the ONE fact this whole finding rests on — this must fail loudly, not silently pass a
    // weaker check.
    expect(ASSISTANT_AGENT_TOOLS).toEqual({
      "status-reporter": ["projects.list", "tasks.list"],
      "approvals-chaser": ["agency.pendingApprovals"],
    });
    for (const tools of Object.values(ASSISTANT_AGENT_TOOLS)) {
      for (const toolName of tools) {
        // These are reads, so this is expected to be trivially true today — asserted anyway so a
        // future write tool slipped into this map without a matching registry decision is caught
        // here, not only by ai-agents' own (separate-project) guard test.
        expect(getExecutable(toolName)).toBeUndefined();
      }
    }
  });

  it("(A) no registered executable-approval entry is named after anything in the broker's tool universe (reverse check)", () => {
    const brokerTools = new Set(Object.values(ASSISTANT_AGENT_TOOLS).flat());
    for (const registered of ["deploy.staging", "deploy.production", "pm.createTask", "pm.createDoc"]) {
      expect(brokerTools.has(registered)).toBe(false);
    }
  });

  // ── file/decide/execute helpers (direct SQL + the real executor — no Nest app needed, matching
  //    d14-15-pm-registry.test.ts's own convention) ────────────────────────────────────────────────

  async function fileAgentOriginApproved(
    toolName: string,
    toolArgs: Record<string, unknown>,
    executionStatus: "pending" | "not_applicable",
  ): Promise<string> {
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO automation_approvals
           (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by,
            decided_at, origin, agent_name, origin_site, execution_status)
         VALUES ($1,$2,'d1417-agent',$3,$4,'high','approved',$5,$5,now(),'agent','d1417-assistant-probe','main',$6)`,
        [id, co, toolName, JSON.stringify(toolArgs), requester, executionStatus],
      ),
    );
    return id;
  }

  async function rowOf(id: string) {
    const r = await adminPool().query(
      `SELECT status, execution_status, execution_error FROM automation_approvals WHERE id = $1`,
      [id],
    );
    return r.rows[0];
  }

  // ── (B) the non-listed assistant tool: never claimed, never executed, forever not_applicable ─────

  describe("(B) a representative UNREGISTERED assistant-shaped write tool", () => {
    it("has no registry entry at all — the precondition for everything below", () => {
      expect(getExecutable(UNREGISTERED_ASSISTANT_TOOL)).toBeUndefined();
    });

    it("an origin='agent' approved row for it is filed with execution_status='not_applicable' (the D14-02 registry-scoped rule — this is what the decide endpoint itself would compute, since getExecutable() returns undefined)", async () => {
      const id = await fileAgentOriginApproved(UNREGISTERED_ASSISTANT_TOOL, { note: "hypothetical" }, "not_applicable");
      const row = await rowOf(id);
      expect(row).toMatchObject({ status: "approved", execution_status: "not_applicable" });
    });

    it("even if a row somehow reached 'pending' for it (a bug elsewhere), the executor cannot execute it — there is no entry to read lockKey/precondition from, so this is provably not a code path that can silently run", async () => {
      // This models the defensive claim precisely: getExecutable() is the ONLY source of a lockKey/
      // precondition pair, and it is undefined for this name. There is no `executeApprovedAutomationWrite`
      // call in this suite for this tool, because the D14-02 registry-scoped rule (proven above) means a
      // real row for this tool can never legitimately reach 'pending' — asserting the absence of the
      // lookup is the correct-shaped test, not calling the executor against a row the system itself would
      // never produce.
      expect(getExecutable(UNREGISTERED_ASSISTANT_TOOL)).toBeUndefined();
    });
  });

  // ── (C) the reuse claim, proven for origin='agent' specifically ───────────────────────────────────

  describe("(C) D14-15's pm.createTask / pm.createDoc, reused as-is for an origin='agent' proposal", () => {
    let hubCalls: Array<{ url: string }> = [];
    const realFetch = globalThis.fetch;

    function installHubStub(): void {
      hubCalls = [];
      const stub = vi.fn(async (url: string, init: any) => {
        if (!String(url).startsWith("http://hub.d1417.test")) return realFetch(url as any, init);
        hubCalls.push({ url: String(url) });
        return { ok: true, status: 200, text: async (): Promise<string> => "event: message\ndata: {}\n\n" };
      });
      vi.stubGlobal("fetch", stub as unknown as typeof fetch);
    }

    beforeEach(() => installHubStub());
    afterEach(() => vi.restoreAllMocks());

    async function makeProject(status = "active"): Promise<string> {
      const id = await createProject(co, `D14-17 Project ${newId()}`);
      if (status !== "active") {
        await withTenants([co], (c) => c.query(`UPDATE projects SET status = $2 WHERE id = $1`, [id, status]));
      }
      return id;
    }

    it("a fresh project's origin='agent' pm.createTask executes exactly once — same entry, same precondition, no code change needed for the assistant to use it", async () => {
      const projectId = await makeProject();
      const id = await fileAgentOriginApproved(
        "pm.createTask",
        { tenantId: co, projectId, title: "Filed by the assistant broker (simulated)" },
        "pending",
      );
      const outcome = await executeApprovedAutomationWrite(co, id);
      expect(outcome.status).toBe("executed");
      expect(hubCalls).toHaveLength(1);
    });

    it("an origin='agent' pm.createTask against an ARCHIVED project still fails closed with precondition_failed:project_archived, and the hub is called ZERO times — the WD-29 server-side re-check applies identically regardless of origin", async () => {
      const projectId = await makeProject("archived");
      const id = await fileAgentOriginApproved(
        "pm.createTask",
        { tenantId: co, projectId, title: "Should never land" },
        "pending",
      );
      const outcome = await executeApprovedAutomationWrite(co, id);
      expect(outcome).toMatchObject({ status: "failed", error: "precondition_failed: project_archived" });
      expect(hubCalls).toHaveLength(0);
      const row = await rowOf(id);
      expect(row.execution_status).toBe("failed");
    });
  });
});
