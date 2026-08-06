// D14-17 — Assistant write-tool entries (Phase-6 v1 proposal set). ORIGINALLY this file pinned a
// FINDING: the broker's proposable surface was entirely read-only, so zero net-new tools existed to
// register (full original narrative retained in `approval-executables.ts`'s own D14-17 section — read
// that first, it is unchanged). **ASST-23 (§7.4/T3a, 2026-08-06) supersedes that finding on purpose**:
// `modules/assistant/broker.ts` now names a real write-capable agent, `task-filer`
// (`ASSISTANT_AGENT_TOOLS["task-filer"]` includes `pm.createTask`/`pm.createDoc`,
// `ASSISTANT_AGENT_WRITE_TOOLS["task-filer"]` names them as its PROPOSABLE writes). The three facts
// the old finding rested on have changed exactly as much as ASST-23 changed them and no more:
//   1. The broker's tool universe is no longer entirely read-only — `task-filer` is write-capable.
//   2. Whether `taskTriager`/`writeSpecialists` is broker-reachable is UNCHANGED by this ticket (it
//      still isn't — `task-filer` is a separate, new AgentDef, T2's job, not a promotion of
//      `taskTriager`).
//   3. `ai-agents/src/agent-write-guard.test.ts`'s `RERUN_CAPABLE_HIGH_WRITES` allowlist gaining
//      `pm.createTask`/`pm.createDoc` is THAT project's own ticket (T2) to land — this file does not
//      assert on ai-agents' allowlist at all (separate standalone project, no import across the
//      boundary), it only asserts on what platform-nest itself can prove: the registry + the broker's
//      OWN mirror agree.
//
// ── THE SUCCESSOR INVARIANT (what (A)/(A-reverse) became, and why) ─────────────────────────────────
// The OLD (A)/(A-reverse) pinned "the broker's tool universe is read-only, full stop" — an exact
// `toEqual` on `ASSISTANT_AGENT_TOOLS` plus "nothing in it is registered". That pin is now FALSE by
// design (task-filer's two tools ARE registered, on purpose), so keeping it would fail this suite for
// the very feature ASST-23 ships — exactly the "don't delete the guard, evolve it" instruction. The
// invariant this file now proves, per broker.ts's own "ASST-23 — THE WRITE-MAP CONTRACT" header:
//   (A1) every tool named in `ASSISTANT_AGENT_WRITE_TOOLS[agent]`, for every agent, HAS a registered
//        `approval-executables.ts` entry — a write the broker could propose must never dead-end at
//        `not_applicable` for lack of registration;
//   (A2) the reverse: every tool in `ASSISTANT_AGENT_TOOLS[agent]` that is NOT ALSO named in
//        `ASSISTANT_AGENT_WRITE_TOOLS[agent]` has NO registered executable — a plain read (or a tool
//        this agent was never given write-propose rights to) genuinely stays inert at the registry
//        layer, never silently promoted into something the executor would act on;
//   (A3) `ASSISTANT_AGENT_WRITE_TOOLS[agent]` is always a SUBSET of `ASSISTANT_AGENT_TOOLS[agent]` —
//        the broker can never propose a write for a tool the agent isn't even allowed to call at all.
// Together these are STRICTLY STRONGER than the old pin for what matters (every write is backed by a
// real precondition) while correctly no longer claiming "the whole surface is read-only", which was
// true only because nobody had shipped a write agent yet.
//
// (B) and (C) are UNCHANGED in spirit and, for (C), EXTENDED: (B) proves a representative unregistered
// "assistant write" tool name still dead-ends forever at `not_applicable`, never auto-executing — the
// negative control that makes (A1) meaningful rather than vacuous. (C) proves BOTH of D14-15's PM
// entries execute an `origin='agent'` approval correctly (happy path + stale precondition) — extended
// beyond the original `pm.createTask`-only coverage to include `pm.createDoc` per the owner's OQ-1
// ruling (§7.1: "both PM tools ship in v1", so both need this proof, not just one with the other
// "covered by the same mechanism" — the mechanism claim must be made TRUE, not merely asserted).
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
import { ASSISTANT_AGENT_TOOLS, ASSISTANT_AGENT_WRITE_TOOLS } from "../modules/assistant/broker";

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

  // ── (A) the write-map contract (ASST-23 successor invariant — see file header) ───────────────────

  it("(A1) every tool ASSISTANT_AGENT_WRITE_TOOLS names, for every agent, HAS a registered approval-executable entry", () => {
    // Fails loudly the moment a future agent's write-map names a tool nobody registered an executor
    // for — exactly the dead-end (approved, then stuck at 'not_applicable' with no one told) this
    // gate exists to make impossible to ship silently.
    expect(Object.keys(ASSISTANT_AGENT_WRITE_TOOLS).length).toBeGreaterThan(0); // this file has teeth today
    for (const [agent, writeTools] of Object.entries(ASSISTANT_AGENT_WRITE_TOOLS)) {
      expect(writeTools.length).toBeGreaterThan(0);
      for (const toolName of writeTools) {
        expect(getExecutable(toolName), `${agent}'s write tool '${toolName}' has no approval-executables entry`).not.toBeUndefined();
      }
    }
  });

  it("(A2) every broker tool NOT named as a write for its agent has NO registered executable — a read genuinely stays a read (reverse check)", () => {
    for (const [agent, tools] of Object.entries(ASSISTANT_AGENT_TOOLS)) {
      const writeSet = new Set(ASSISTANT_AGENT_WRITE_TOOLS[agent] ?? []);
      for (const toolName of tools) {
        if (writeSet.has(toolName)) continue; // covered, and required to be registered, by (A1)
        expect(
          getExecutable(toolName),
          `${toolName} is not a declared write for '${agent}' but IS a registered executable — either promote it to the write map or unregister it`,
        ).toBeUndefined();
      }
    }
  });

  it("(A3) ASSISTANT_AGENT_WRITE_TOOLS[agent] is always a SUBSET of ASSISTANT_AGENT_TOOLS[agent] — never a write on a tool the agent can't even call", () => {
    for (const [agent, writeTools] of Object.entries(ASSISTANT_AGENT_WRITE_TOOLS)) {
      const allTools = new Set(ASSISTANT_AGENT_TOOLS[agent] ?? []);
      for (const toolName of writeTools) {
        expect(allTools.has(toolName), `'${agent}' proposes '${toolName}' as a write but its own tool list does not include it`).toBe(true);
      }
    }
  });

  // ── (A4) T2b's finding, pinned on THIS side of the ai-agents/platform-nest boundary ──────────────
  // T2b (ai-agents) found that a `fileOnSuspend:false` goal routed through the SUPERVISOR's fan-out
  // path still files a write immediately — bypassing the confirm chip (§7.2) the moment T3b ships.
  // `broker.ts` itself throws at import time if either mirror ever names a delegating agent (see its
  // own "ASST-23 / T2b FINDING" section, right above `ASSISTANT_AGENT_WRITE_TOOLS`) — this test is
  // the second, independent proof that the invariant currently holds, so a regression is caught by a
  // failing assertion here in addition to (not instead of) the module-load throw.
  it("(A4) neither mirror ever names a delegating/fan-out agent (T2b's supervisor-bypass finding) — 'supervisor' is absent from both", () => {
    for (const mirror of [ASSISTANT_AGENT_TOOLS, ASSISTANT_AGENT_WRITE_TOOLS]) {
      expect(Object.keys(mirror)).not.toContain("supervisor");
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

    // ── §7.1's caveat, closed: the original (C) coverage above only ever drove pm.createTask. Both
    // tools ship in v1 (owner ruling, §7.1), so "pm.createDoc is covered by the same mechanism" must be
    // made TRUE here, not merely asserted by analogy — mirrors the two pm.createTask cases exactly,
    // minus the assignee branch (pm.createDoc's own precondition, `pmProjectPrecondition`, has none —
    // see approval-executables.ts's header on why that is a documented scope call).

    it("(§7.1) a fresh project's origin='agent' pm.createDoc executes exactly once — same entry, same precondition, no code change needed for the assistant to use it", async () => {
      const projectId = await makeProject();
      const id = await fileAgentOriginApproved(
        "pm.createDoc",
        { tenantId: co, projectId, title: "Filed by the assistant broker (simulated)" },
        "pending",
      );
      const outcome = await executeApprovedAutomationWrite(co, id);
      expect(outcome.status).toBe("executed");
      expect(hubCalls).toHaveLength(1);
    });

    it("(§7.1) an origin='agent' pm.createDoc against an ARCHIVED project still fails closed with precondition_failed:project_archived, and the hub is called ZERO times", async () => {
      const projectId = await makeProject("archived");
      const id = await fileAgentOriginApproved(
        "pm.createDoc",
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
