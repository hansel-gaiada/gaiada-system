// WS4 §3 / D14 — the automation approvals suspension surface, against live Postgres + RLS + Cerbos.
// A scoped automation service account files a suspension (as the hub `approvals.request` tool would);
// an elevated human reads the pending inbox and decides; non-elevated members are denied read/decide.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { seedAutomationAccounts } from "../seed/automation";
import { registerExecutableApproval, resetExecutableApprovals } from "./approval-executables";
import { EXECUTING_STALE_MS, executeApprovedAutomationWrite } from "./approval-execute";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const asWorkflow = (wf: string) => ({ ...svc, "x-obo-provider": "n8n", "x-obo-external-id": wf });

describe.skipIf(!TEST_URL)("automation approvals suspension surface (WS4 §3)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;
  let member: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Gaiada Creative");
    await seedAutomationAccounts(co); // gives wf:new-client-seed a manager-role service principal
    admin = await createUser("admin@approvals.test");
    member = await createUser("member@approvals.test");
    await addMembership(co, admin);
    await addMembership(co, member);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(member, await createRole("member"), "company", co);
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("a scoped automation account files a pending suspension (as approvals.request would)", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/automation-approvals`,
      headers: asWorkflow("wf:new-client-seed"),
      payload: { workflowId: "wf:new-client-seed", toolName: "money.transfer", toolArgs: { amount: 100 }, impact: "medium", reason: "suspend: medium-impact write" },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ status: "pending" });
  });

  it("an elevated human reads the pending inbox; a plain member cannot", async () => {
    const ok = await app.inject({ method: "GET", url: `/api/${co}/automation-approvals`, headers: asUser(admin) });
    expect(ok.statusCode).toBe(200);
    const rows = ok.json() as Array<{ tool_name: string; status: string; impact: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({ tool_name: "money.transfer", status: "pending", impact: "medium" });

    const denied = await app.inject({ method: "GET", url: `/api/${co}/automation-approvals`, headers: asUser(member) });
    expect(denied.statusCode).toBe(403);
  });

  it("company_admin approves it; a second decide is 404; a member may not decide", async () => {
    const id = ((await app.inject({ method: "GET", url: `/api/${co}/automation-approvals`, headers: asUser(admin) })).json() as Array<{ id: string }>)[0].id;

    const memberTry = await app.inject({ method: "POST", url: `/api/${co}/automation-approvals/${id}/decide`, headers: asUser(member), payload: { decision: "approved" } });
    expect(memberTry.statusCode).toBe(403);

    const decided = await app.inject({ method: "POST", url: `/api/${co}/automation-approvals/${id}/decide`, headers: asUser(admin), payload: { decision: "approved" } });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({ status: "approved" });

    const again = await app.inject({ method: "POST", url: `/api/${co}/automation-approvals/${id}/decide`, headers: asUser(admin), payload: { decision: "rejected" } });
    expect(again.statusCode).toBe(404); // no longer pending

    // It leaves the default pending inbox once decided.
    const pending = (await app.inject({ method: "GET", url: `/api/${co}/automation-approvals`, headers: asUser(admin) })).json() as unknown[];
    expect(pending).toHaveLength(0);
  });

  it("accepts an agent-origin suspension (WS8 Step B) and surfaces origin + agentName", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/${co}/automation-approvals`,
      headers: asWorkflow("wf:new-client-seed"), // filed under the OBO principal (agent runs as a user in prod)
      payload: { workflowId: "task-triager", toolName: "tasks.update", toolArgs: { taskId: "t1", status: "done" }, impact: "high", reason: "high_write requires approval", origin: "agent", agentName: "task-triager" },
    });
    expect(created.statusCode).toBe(201);
    const rows = (await app.inject({ method: "GET", url: `/api/${co}/automation-approvals`, headers: asUser(admin) })).json() as Array<{ origin: string; agent_name: string; tool_name: string }>;
    const agentRow = rows.find((r) => r.origin === "agent");
    expect(agentRow).toMatchObject({ origin: "agent", agent_name: "task-triager", tool_name: "tasks.update" });
  });

  it("rejects an invalid origin (400)", async () => {
    expect(
      (await app.inject({ method: "POST", url: `/api/${co}/automation-approvals`, headers: asWorkflow("wf:new-client-seed"), payload: { workflowId: "x", toolName: "y", origin: "bogus" } })).statusCode,
    ).toBe(400);
  });

  it("rejects a bad impact and a missing toolName (400)", async () => {
    expect(
      (await app.inject({ method: "POST", url: `/api/${co}/automation-approvals`, headers: asWorkflow("wf:new-client-seed"), payload: { workflowId: "wf:new-client-seed", toolName: "x", impact: "bogus" } })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "POST", url: `/api/${co}/automation-approvals`, headers: asWorkflow("wf:new-client-seed"), payload: { workflowId: "wf:new-client-seed" } })).statusCode,
    ).toBe(400);
  });

  // APPR-01 — the single-row read backing `platform-ui`'s `/approvals/[id]`, plus the href-parity
  // pin (the whole point of this ticket: the emailed link must land ON the item).
  describe("APPR-01: single-approval detail read + emitted href parity", () => {
    it("an elevated human reads one row by id; a plain member is denied read, same as the list", async () => {
      const created = await app.inject({
        method: "POST", url: `/api/${co}/automation-approvals`, headers: asWorkflow("wf:new-client-seed"),
        payload: { workflowId: "wf:new-client-seed", toolName: "money.transfer", toolArgs: { amount: 1 }, impact: "medium", reason: "detail-read probe" },
      });
      const { id } = created.json() as { id: string };

      const ok = await app.inject({ method: "GET", url: `/api/${co}/automation-approvals/${id}`, headers: asUser(admin) });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ id, toolName: "money.transfer", impact: "medium", status: "pending", reason: "detail-read probe" });

      const denied = await app.inject({ method: "GET", url: `/api/${co}/automation-approvals/${id}`, headers: asUser(member) });
      expect(denied.statusCode).toBe(403); // same refusal `list()` gives a plain member — no weaker
    });

    it("an unknown id 404s, and a REAL id read through a different tenant's path 404s too (RLS — never 403, no existence leak)", async () => {
      const created = await app.inject({
        method: "POST", url: `/api/${co}/automation-approvals`, headers: asWorkflow("wf:new-client-seed"),
        payload: { workflowId: "wf:new-client-seed", toolName: "money.transfer", toolArgs: {}, impact: "medium", reason: "cross-tenant probe" },
      });
      const { id } = created.json() as { id: string };

      const unknown = await app.inject({ method: "GET", url: `/api/${co}/automation-approvals/00000000-0000-0000-0000-000000000000`, headers: asUser(admin) });
      expect(unknown.statusCode).toBe(404);

      const otherCo = await createCompany("Gaiada Creative — cross-tenant probe");
      const otherAdmin = await createUser("other-admin@approvals.test");
      await addMembership(otherCo, otherAdmin);
      await grantRole(otherAdmin, await createRole("company_admin"), "company", otherCo);
      const crossTenant = await app.inject({ method: "GET", url: `/api/${otherCo}/automation-approvals/${id}`, headers: asUser(otherAdmin) });
      expect(crossTenant.statusCode).toBe(404); // RLS makes the row invisible under the wrong tenant — never renders
    });

    it("the emitted notification's payload.href is the id-bearing detail route, not the bare list", async () => {
      const created = await app.inject({
        method: "POST", url: `/api/${co}/automation-approvals`, headers: asWorkflow("wf:new-client-seed"),
        payload: { workflowId: "wf:new-client-seed", toolName: "money.transfer", toolArgs: {}, impact: "high", reason: "href parity probe" },
      });
      const { id } = created.json() as { id: string };
      const row = await adminPool().query<{ payload: { href: string } }>(
        `SELECT payload FROM notifications WHERE type = 'approval.requested' AND (payload->>'entityId') = $1`, [id],
      );
      expect(row.rows[0].payload.href).toBe(`/approvals/${id}`);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // D14-07 — POST :tenantId/automation-approvals/:id/retry. Re-drives execution through the SAME
  // entry point D14-03's own decided-event handler calls (executeApprovedAutomationWrite) — never a
  // second implementation. Eligibility is `failed`, or `executing` stale past EXECUTING_STALE_MS
  // (approval-execute.ts's crash-wedge rule, imported here rather than re-derived).
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("D14-07: retry endpoint", () => {
    const RETRY_TOOL = "test.d1407-retry-tool";
    let retryCo: string;
    let retryAdmin: string;
    let retryManagerUser: string;
    let retryPreconditionOk: boolean;
    let retryHubCalls: Array<{ headers: Record<string, string> }>;
    let retryHubReplies: Array<{ ok: boolean; text: string }>;
    const realFetch = globalThis.fetch;

    function sse(payload: unknown): string {
      return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    }
    function installRetryHubStub(): void {
      retryHubCalls = [];
      const stub = vi.fn(async (url: string, init: any) => {
        if (!String(url).startsWith("http://hub.d1407.test")) return realFetch(url as any, init);
        retryHubCalls.push({ headers: init.headers as Record<string, string> });
        const reply = retryHubReplies.length > 1 ? retryHubReplies.shift()! : (retryHubReplies[0] ?? { ok: true, text: "ok" });
        const rpc = reply.ok
          ? { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: reply.text }] } }
          : { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: reply.text }], isError: true } };
        return { ok: true, status: 200, text: async () => sse(rpc) };
      });
      vi.stubGlobal("fetch", stub as unknown as typeof fetch);
    }

    beforeAll(async () => {
      config.approvalGrantSecret = "d14-07-test-secret-not-a-real-one";
      config.services.hub = { url: "http://hub.d1407.test", token: "hub-token" };
      // Isolated from every other tool this file uses (money.transfer / tasks.update stay
      // unregistered throughout — resetting here does not change their behaviour).
      resetExecutableApprovals();
      registerExecutableApproval({
        toolName: RETRY_TOOL,
        precondition: async () => (retryPreconditionOk ? { ok: true } : { ok: false, reason: "blocked_for_test" }),
      });
      retryCo = await createCompany("D14-07 Retry Co");
      await seedAutomationAccounts(retryCo);
      retryAdmin = await createUser("d1407-retry-admin@a.test");
      retryManagerUser = await createUser("d1407-retry-manager@a.test");
      await addMembership(retryCo, retryAdmin);
      await addMembership(retryCo, retryManagerUser);
      await grantRole(retryAdmin, await createRole("company_admin"), "company", retryCo);
      await grantRole(retryManagerUser, await createRole("manager"), "company", retryCo);
    });

    beforeEach(() => {
      retryPreconditionOk = true;
      retryHubReplies = [{ ok: true, text: "done" }];
      installRetryHubStub();
    });
    afterEach(() => vi.restoreAllMocks());

    async function fileAndApprove(): Promise<string> {
      const created = await app.inject({
        method: "POST", url: `/api/${retryCo}/automation-approvals`, headers: asWorkflow("wf:new-client-seed"),
        payload: { workflowId: "wf:new-client-seed", toolName: RETRY_TOOL, toolArgs: { x: 1 }, impact: "high", reason: "d14-07 retry test" },
      });
      const { id } = created.json() as { id: string };
      const decide = await app.inject({ method: "POST", url: `/api/${retryCo}/automation-approvals/${id}/decide`, headers: asUser(retryAdmin), payload: { decision: "approved" } });
      expect(decide.statusCode).toBe(200);
      return id;
    }

    async function executionStatusOf(id: string): Promise<string> {
      const r = await adminPool().query<{ execution_status: string }>(`SELECT execution_status FROM automation_approvals WHERE id = $1`, [id]);
      return r.rows[0].execution_status;
    }

    it("retry on a `failed` row re-drives once and lands `executed` when the precondition now holds", async () => {
      retryPreconditionOk = false;
      const id = await fileAndApprove();
      await executeApprovedAutomationWrite(retryCo, id); // drives it to `failed` (mirrors the decided-event handler)
      expect(await executionStatusOf(id)).toBe("failed");

      retryPreconditionOk = true; // "the precondition now holds"
      const r = await app.inject({ method: "POST", url: `/api/${retryCo}/automation-approvals/${id}/retry`, headers: asUser(retryAdmin) });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ id, status: "executed" });
      expect(await executionStatusOf(id)).toBe("executed");
    });

    it("retry on `executed` and on `pending` rows both 409", async () => {
      const executedId = await fileAndApprove();
      await executeApprovedAutomationWrite(retryCo, executedId); // succeeds (precondition true by default)
      expect(await executionStatusOf(executedId)).toBe("executed");
      const onExecuted = await app.inject({ method: "POST", url: `/api/${retryCo}/automation-approvals/${executedId}/retry`, headers: asUser(retryAdmin) });
      expect(onExecuted.statusCode).toBe(409);

      const pendingId = await fileAndApprove(); // decide() sets execution_status='pending'; never executed
      expect(await executionStatusOf(pendingId)).toBe("pending");
      const onPending = await app.inject({ method: "POST", url: `/api/${retryCo}/automation-approvals/${pendingId}/retry`, headers: asUser(retryAdmin) });
      expect(onPending.statusCode).toBe(409);
    });

    it("retry by a non-decider (a plain manager) is 403", async () => {
      retryPreconditionOk = false;
      const id = await fileAndApprove();
      await executeApprovedAutomationWrite(retryCo, id);
      expect(await executionStatusOf(id)).toBe("failed");
      const r = await app.inject({ method: "POST", url: `/api/${retryCo}/automation-approvals/${id}/retry`, headers: asUser(retryManagerUser) });
      expect(r.statusCode).toBe(403);
      expect(await executionStatusOf(id)).toBe("failed"); // untouched by the denied attempt
    });

    it("a STALE `executing` row is retryable; a FRESH `executing` row is NOT (409) — the crash-wedge rule", async () => {
      const id = await fileAndApprove();
      // Simulate a crashed executor: claimed but never resolved.
      await adminPool().query(`UPDATE automation_approvals SET execution_status = 'executing', updated_at = now() WHERE id = $1`, [id]);

      const fresh = await app.inject({ method: "POST", url: `/api/${retryCo}/automation-approvals/${id}/retry`, headers: asUser(retryAdmin) });
      expect(fresh.statusCode).toBe(409);
      expect(await executionStatusOf(id)).toBe("executing"); // a denied retry must not move it

      // Age it past EXECUTING_STALE_MS with no restart of anything — same row, same process.
      const staleAt = new Date(Date.now() - EXECUTING_STALE_MS - 5000);
      await adminPool().query(`UPDATE automation_approvals SET updated_at = $2 WHERE id = $1`, [id, staleAt]);

      const stale = await app.inject({ method: "POST", url: `/api/${retryCo}/automation-approvals/${id}/retry`, headers: asUser(retryAdmin) });
      expect(stale.statusCode).toBe(200);
      expect(stale.json()).toMatchObject({ id, status: "executed" });
    });

    it("an unknown id 404s before authorization can even run", async () => {
      const r = await app.inject({ method: "POST", url: `/api/${retryCo}/automation-approvals/00000000-0000-0000-0000-000000000000/retry`, headers: asUser(retryAdmin) });
      expect(r.statusCode).toBe(404);
    });

    // The setting's OWN round-trip + validation is covered by admin/company-crud.controller.test.ts;
    // this test proves the OTHER half — that a value written through that real HTTP endpoint changes
    // the EXECUTOR's behaviour with no restart, driven end to end rather than by a direct SQL write
    // (approval-execute.test.ts's "(f)" suite already covers the direct-SQL version).
    it("the autoRetryCount setting, written via the company PATCH, is read fresh by the executor with no restart", async () => {
      const patch = await app.inject({
        method: "PATCH", url: `/api/companies/${retryCo}`, headers: asUser(retryAdmin),
        payload: { settings: { automation: { approvalRetry: { autoRetryCount: 1 } } } },
      });
      expect(patch.statusCode).toBe(200);

      // A transient tool failure followed by success: with autoRetryCount=1 (just written, no
      // restart) the SAME invocation retries once and lands `executed` after 2 hub calls.
      retryHubReplies = [{ ok: false, text: "tool failed: transient" }, { ok: true, text: "recovered" }];
      const id = await fileAndApprove();
      await executeApprovedAutomationWrite(retryCo, id);
      expect(retryHubCalls).toHaveLength(2);
      expect(await executionStatusOf(id)).toBe("executed");

      // Reset to 0 (manual-only) so it does not leak into any test file run after this one.
      await app.inject({
        method: "PATCH", url: `/api/companies/${retryCo}`, headers: asUser(retryAdmin),
        payload: { settings: { automation: { approvalRetry: { autoRetryCount: 0 } } } },
      });
    });
  });
});
