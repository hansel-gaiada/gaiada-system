// D14-15 — `pm.createTask` / `pm.createDoc` registry entries: this file proves (1) each typed
// refusal branch (`project_not_found`, `project_archived`, `assignee_gone`) maps to the exact reason
// string the ticket pins, (2) a stale precondition, driven through the REAL executor
// (`executeApprovedAutomationWrite`), lands `failed` with `precondition_failed:*` and the hub is
// asserted — not inferred — to have been called zero times, and (3) the happy path executes exactly
// once even when the executor is invoked twice (the at-least-once redelivery case).
//
// No Nest app is built here — same shape as approval-executables.test.ts (D14-05): plain functions
// over Postgres + a stubbed `fetch`. Cerbos/HTTP plumbing is exercised elsewhere and must not be
// duplicated here.
//
// SCOPE NOTE carried from approval-executables.ts's own header: this file (and the entries it tests)
// makes the AUTOMATION (n8n) re-drive path work for PM writes. It does NOT unblock the agent path —
// `mcp-hub/src/principal.ts` mints every envelope-derived principal at `minAssurance:"low"` and D14-10
// requires `"verified"`, so an agent-filed PM approval never reaches this registry entry today. Nothing
// in this file exercises or claims otherwise.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createProject } from "../testing/fixtures";
import { seedAutomationAccounts } from "../seed/automation";
import {
  registerExecutableApproval,
  resetExecutableApprovals,
  registerCoreExecutableApprovals,
  registerPmExecutableApprovals,
  getExecutable,
} from "./approval-executables";
import { executeApprovedAutomationWrite } from "./approval-execute";

const GRANT_SECRET = "d14-15-test-secret-not-a-real-one";

describe.skipIf(!TEST_URL)("D14-15 registry: pm.createTask / pm.createDoc", () => {
  let co: string;
  let wfUser: string;

  beforeAll(async () => {
    await initTestDb();
    config.approvalGrantSecret = GRANT_SECRET;
    config.services.hub = { url: "http://hub.test", token: "hub-token", assuranceToken: "" };
    // Independent of whatever another test file in this worker left the registry in — restore the
    // full production set (deploy.* + pm.*) via the exported bootstraps rather than hand-rolling a
    // second copy of their lock/precondition.
    resetExecutableApprovals();
    registerCoreExecutableApprovals();
    registerPmExecutableApprovals();

    co = await createCompany("D14-15 PM Registry Co");
    await seedAutomationAccounts(co);
    const wf = await adminPool().query<{ user_id: string }>(
      `SELECT user_id FROM identity_links WHERE provider = 'n8n' AND external_id = 'wf:report'`,
    );
    wfUser = wf.rows[0].user_id;
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  async function makeProject(status = "active"): Promise<string> {
    const id = await createProject(co, `Project ${newId()}`);
    if (status !== "active") {
      await withTenants([co], (c) => c.query(`UPDATE projects SET status = $2 WHERE id = $1`, [id, status]));
    }
    return id;
  }

  async function makeActiveMember(): Promise<string> {
    const userId = await createUser(`member-${newId()}@d14-15.test`);
    await addMembership(co, userId);
    return userId;
  }

  // ── registry doctrine: duplicate registration ──────────────────────────────────────────────────

  it("rejects a duplicate registration for a tool that is already registered", () => {
    expect(() => registerExecutableApproval({ toolName: "pm.createTask" })).toThrow(/already registered/i);
    expect(() => registerExecutableApproval({ toolName: "pm.createDoc" })).toThrow(/already registered/i);
  });

  it("both tools are registered with a real lockKey and precondition (not the D14-02 name-only fallback)", () => {
    for (const name of ["pm.createTask", "pm.createDoc"]) {
      const entry = getExecutable(name);
      expect(entry).toBeDefined();
      expect(entry!.toolName).toBe(name);
      expect(entry!.lockKey({})).not.toBe(`executable-approval:${name}`);
    }
  });

  it("the J2 ball-pass tool (pm.passBall) has no registry entry — it does not exist in the hub yet", () => {
    expect(getExecutable("pm.passBall")).toBeUndefined();
    expect(getExecutable("pm.setStatus")).toBeUndefined();
    expect(getExecutable("pm.setDueDate")).toBeUndefined();
    expect(getExecutable("pm.comment")).toBeUndefined();
  });

  // ── lockKey: pure function of toolArgs, fails closed without collapsing to one constant ──────────

  describe("lockKey", () => {
    it("keys on the projectId when present, verbatim, shared across both tools", () => {
      expect(getExecutable("pm.createTask")!.lockKey({ projectId: "proj-123" })).toBe("proj-123");
      expect(getExecutable("pm.createDoc")!.lockKey({ projectId: "proj-123" })).toBe("proj-123");
    });

    it("is stable across repeated calls with the same args (the retry requirement)", () => {
      const entry = getExecutable("pm.createTask")!;
      const args = { projectId: "proj-stable" };
      expect(entry.lockKey(args)).toBe(entry.lockKey({ ...args }));
      expect(entry.lockKey({})).toBe(entry.lockKey({}));
    });

    it("a missing/malformed projectId does NOT collapse to a single constant shared by every such call", () => {
      const entry = getExecutable("pm.createTask")!;
      const missing = entry.lockKey({});
      const wrongType = entry.lockKey({ projectId: 42 });
      const empty = entry.lockKey({ projectId: "" });
      expect(new Set([missing, wrongType, empty]).size).toBe(3);
      for (const k of [missing, wrongType, empty]) {
        expect(k).not.toBe("pm.createTask");
        expect(k).not.toBe("pm");
      }
    });

    it("the two tools never share a lock key for the same malformed args (namespaced by tool, not global — never serializes every PM write behind one lock)", () => {
      const badArgs = { projectId: null };
      expect(getExecutable("pm.createTask")!.lockKey(badArgs)).not.toBe(
        getExecutable("pm.createDoc")!.lockKey(badArgs),
      );
    });
  });

  // ── precondition: typed branches, called directly under a live transaction ──────────────────────

  describe("precondition", () => {
    async function runPrecondition(tool: "pm.createTask" | "pm.createDoc", args: Record<string, unknown>) {
      const entry = getExecutable(tool)!;
      return withTenants([co], (c) => entry.precondition(c, args));
    }

    it("an active project, no assignee ⇒ pass, for both tools", async () => {
      const projectId = await makeProject();
      expect(await runPrecondition("pm.createTask", { projectId, title: "t" })).toEqual({ ok: true });
      expect(await runPrecondition("pm.createDoc", { projectId, title: "d" })).toEqual({ ok: true });
    });

    it("an archived project ⇒ project_archived, for both tools", async () => {
      const projectId = await makeProject("archived");
      expect(await runPrecondition("pm.createTask", { projectId, title: "t" })).toEqual({
        ok: false,
        reason: "project_archived",
      });
      expect(await runPrecondition("pm.createDoc", { projectId, title: "d" })).toEqual({
        ok: false,
        reason: "project_archived",
      });
    });

    it("an unknown project id ⇒ project_not_found", async () => {
      const bogus = newId();
      expect(await runPrecondition("pm.createTask", { projectId: bogus, title: "t" })).toEqual({
        ok: false,
        reason: "project_not_found",
      });
    });

    it("a soft-deleted project is treated as not found", async () => {
      const projectId = await makeProject();
      await withTenants([co], (c) => c.query(`UPDATE projects SET deleted_at = now() WHERE id = $1`, [projectId]));
      expect(await runPrecondition("pm.createTask", { projectId, title: "t" })).toEqual({
        ok: false,
        reason: "project_not_found",
      });
    });

    it("missing/malformed projectId in tool_args fails closed as project_not_found — never touches the DB", async () => {
      for (const badArgs of [{}, { projectId: 42 }, { projectId: "" }, { projectId: null }, { projectId: "   " }]) {
        expect(await runPrecondition("pm.createTask", badArgs as Record<string, unknown>)).toEqual({
          ok: false,
          reason: "project_not_found",
        });
      }
    });

    it("pm.createTask with a still-active assignee ⇒ pass", async () => {
      const projectId = await makeProject();
      const assigneeUserId = await makeActiveMember();
      expect(await runPrecondition("pm.createTask", { projectId, title: "t", assigneeUserId })).toEqual({ ok: true });
    });

    it("pm.createTask with an assignee who is no longer an active member ⇒ assignee_gone", async () => {
      const projectId = await makeProject();
      const assigneeUserId = await makeActiveMember();
      await withTenants([co], (c) =>
        c.query(`UPDATE company_memberships SET status = 'inactive' WHERE user_id = $1 AND tenant_id = $2`, [
          assigneeUserId,
          co,
        ]),
      );
      expect(await runPrecondition("pm.createTask", { projectId, title: "t", assigneeUserId })).toEqual({
        ok: false,
        reason: "assignee_gone",
      });
    });

    it("pm.createTask with an assignee whose membership was soft-deleted ⇒ assignee_gone", async () => {
      const projectId = await makeProject();
      const assigneeUserId = await makeActiveMember();
      await withTenants([co], (c) =>
        c.query(`UPDATE company_memberships SET deleted_at = now() WHERE user_id = $1 AND tenant_id = $2`, [
          assigneeUserId,
          co,
        ]),
      );
      expect(await runPrecondition("pm.createTask", { projectId, title: "t", assigneeUserId })).toEqual({
        ok: false,
        reason: "assignee_gone",
      });
    });

    it("pm.createTask with an unknown assigneeUserId ⇒ assignee_gone (never a DB error)", async () => {
      const projectId = await makeProject();
      expect(await runPrecondition("pm.createTask", { projectId, title: "t", assigneeUserId: newId() })).toEqual({
        ok: false,
        reason: "assignee_gone",
      });
    });

    it("pm.createDoc has no assignee concept — an assigneeUserId field, if present, is simply ignored", async () => {
      const projectId = await makeProject();
      expect(await runPrecondition("pm.createDoc", { projectId, title: "d", assigneeUserId: newId() })).toEqual({
        ok: true,
      });
    });

    it("project_archived takes precedence over assignee_gone (project state is checked first)", async () => {
      const projectId = await makeProject("archived");
      expect(await runPrecondition("pm.createTask", { projectId, title: "t", assigneeUserId: newId() })).toEqual({
        ok: false,
        reason: "project_archived",
      });
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
           VALUES ($1, $2, 'wf:report', $3, $4, 'medium', 'approved', $5, $5, now(), 'automation', 'main', 'pending')`,
          [id, co, toolName, JSON.stringify(args), wfUser],
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

    it("an approved pm.createTask row for an ARCHIVED project ends failed with precondition_failed:project_archived, and the hub is called ZERO times", async () => {
      const projectId = await makeProject("archived");
      const id = await fileDecided("pm.createTask", { tenantId: co, projectId, title: "Task on a closed project" });

      const outcome = await executeApprovedAutomationWrite(co, id);

      expect(outcome.status).toBe("failed");
      expect(outcome).toMatchObject({ error: "precondition_failed: project_archived" });
      expect(hubCalls).toHaveLength(0);
      const row = await rowOf(id);
      expect(row.execution_status).toBe("failed");
      expect(row.execution_error).toBe("precondition_failed: project_archived");
    });

    it("an approved pm.createTask row naming a departed assignee ends failed with precondition_failed:assignee_gone, and the hub is called ZERO times", async () => {
      const projectId = await makeProject();
      const assigneeUserId = await makeActiveMember();
      await withTenants([co], (c) =>
        c.query(`UPDATE company_memberships SET status = 'inactive' WHERE user_id = $1 AND tenant_id = $2`, [
          assigneeUserId,
          co,
        ]),
      );
      const id = await fileDecided("pm.createTask", { tenantId: co, projectId, title: "Task", assigneeUserId });

      const outcome = await executeApprovedAutomationWrite(co, id);

      expect(outcome).toMatchObject({ status: "failed", error: "precondition_failed: assignee_gone" });
      expect(hubCalls).toHaveLength(0);
    });

    it("an approved pm.createDoc row against an unknown project ends failed with precondition_failed:project_not_found, and the hub is called ZERO times", async () => {
      const id = await fileDecided("pm.createDoc", { tenantId: co, projectId: newId(), title: "Report" });

      const outcome = await executeApprovedAutomationWrite(co, id);

      expect(outcome).toMatchObject({ status: "failed", error: "precondition_failed: project_not_found" });
      expect(hubCalls).toHaveLength(0);
    });

    it("a fresh project's approved pm.createTask DOES call the hub exactly once (the positive control for the zero-calls assertions above)", async () => {
      const projectId = await makeProject();
      const id = await fileDecided("pm.createTask", { tenantId: co, projectId, title: "Real work" });

      const outcome = await executeApprovedAutomationWrite(co, id);

      expect(outcome.status).toBe("executed");
      expect(hubCalls).toHaveLength(1);
    });

    it("a fresh project's approved pm.createDoc DOES call the hub exactly once", async () => {
      const projectId = await makeProject();
      const id = await fileDecided("pm.createDoc", { tenantId: co, projectId, title: "Report doc" });

      const outcome = await executeApprovedAutomationWrite(co, id);

      expect(outcome.status).toBe("executed");
      expect(hubCalls).toHaveLength(1);
    });

    it("the happy path executes EXACTLY ONCE even when the executor is invoked twice (at-least-once redelivery)", async () => {
      const projectId = await makeProject();
      const id = await fileDecided("pm.createTask", { tenantId: co, projectId, title: "Redelivered task" });

      const first = await executeApprovedAutomationWrite(co, id);
      expect(first.status).toBe("executed");
      expect(hubCalls).toHaveLength(1);

      // Simulates the relay redelivering the same `automation_approval.decided` event, or D14-07's
      // retry firing on an already-terminal row: the single-use claim (`execution_status='pending'`
      // in the UPDATE's WHERE clause) has nothing left to win, so this must be a silent no-op — never
      // a second hub call.
      const second = await executeApprovedAutomationWrite(co, id);
      expect(second).toEqual({ status: "skipped", reason: "not_pending" });
      expect(hubCalls).toHaveLength(1);

      const row = await rowOf(id);
      expect(row.execution_status).toBe("executed");
    });
  });
});
