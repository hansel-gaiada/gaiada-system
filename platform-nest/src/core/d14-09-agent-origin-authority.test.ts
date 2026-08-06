// D14-09 item (f) — QA-gate adversarial test: an `origin='agent'` approved row must execute under the
// ORIGINAL REQUESTING USER's principal (never the approver's), and a role revoked between approval and
// execution must cause the write to FAIL, never silently fall back to running as the approver (or as
// any other principal with more standing authority than the requester currently has).
//
// SCOPE NOTE (read before extending this file): `core/approval-execute.ts` reconstructs the OBO
// envelope for the ORIGINAL filer and hands it to the hub over HTTP — the ACTUAL Cerbos re-evaluation
// of "does this principal's CURRENT role still permit this tool call" happens one hop further out, at
// mcp-hub / the platform-fronting tool endpoint the hub calls back into, using that principal's live
// roles. `approval-execute.test.ts`'s own suite stubs the hub for exactly this reason (see its header):
// a live hub would hide the platform's half of the contract behind a 200/403. This file follows the
// same convention, so what it proves is HARNESS-LEVEL, not a live end-to-end role-revocation drill:
//   1. the OBO reconstructed and sent to the hub is unambiguously the REQUESTER's, never the
//      APPROVER's — proven by inspecting the actual x-obo-* headers on the (stubbed) hub call;
//   2. when the downstream call is denied — which is exactly the shape mcp-hub/Cerbos produce when a
//      principal's role no longer grants the tool (the same `isError: "denied by policy: <tool>"` shape
//      `approval-execute.test.ts`'s own D14-13 window test uses) — the row lands `failed`, the write
//      never applied, and there is no code path that retries as a more-privileged principal.
// A live drill (revoke the requester's role in the DB, then round-trip through a real mcp-hub + Cerbos
// and observe the deny) would additionally need mcp-hub reachable from this suite and is out of this
// file's reach in the current test harness; that gap is reported, not hidden, in the QA write-up.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, linkIdentity } from "../testing/fixtures";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { registerExecutableApproval, resetExecutableApprovals } from "./approval-executables";
import { automationApprovalExecutorHandler, executeApprovedAutomationWrite } from "./approval-execute";
import type { OutboxEvent } from "../events/types";

const GRANT_SECRET = "d14-09-item-f-test-secret-not-a-real-one";
const TOOL = "test.d1409f-agent-write";

type HubReply = { kind: "ok"; text: string } | { kind: "isError"; text: string };
let hubReplies: HubReply[] = [];
let hubCalls: Array<{ body: any; headers: Record<string, string> }> = [];
const realFetch = globalThis.fetch;

function sse(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

function installHubStub(): void {
  hubCalls = [];
  const stub = vi.fn(async (url: string, init: any) => {
    if (!String(url).startsWith("http://hub.d1409f.test")) return realFetch(url as any, init);
    hubCalls.push({ body: JSON.parse(init.body), headers: init.headers as Record<string, string> });
    const reply = hubReplies.length > 1 ? hubReplies.shift()! : (hubReplies[0] ?? { kind: "ok", text: "ok" });
    const rpc =
      reply.kind === "ok"
        ? { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: reply.text }] } }
        : { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: reply.text }], isError: true } };
    return { ok: true, status: 200, text: async () => sse(rpc) };
  });
  vi.stubGlobal("fetch", stub as unknown as typeof fetch);
}

describe.skipIf(!TEST_URL)("D14-09 (f) — origin='agent' executes as the requester, and a downstream role-loss denial is fail-closed", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string; // the APPROVER (company_admin) — must never be the executing principal
  let requester: string; // the ORIGINAL requester, with a verified identity link

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.approvalGrantSecret = GRANT_SECRET;
    config.services.hub = { url: "http://hub.d1409f.test", token: "hub-token", assuranceToken: "" };
    resetModules();
    resetCoreRollupProviders();
    resetExecutableApprovals();
    registerExecutableApproval({
      toolName: TOOL,
      lockKey: (a) => `d1409f:${String(a.taskId ?? "none")}`,
      precondition: async () => ({ ok: true }),
    });

    co = await createCompany("D14-09(f) Agent Authority Co");
    admin = await createUser("d1409f-admin@a.test");
    requester = await createUser("d1409f-requester@a.test");
    await addMembership(co, admin);
    await addMembership(co, requester);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(requester, await createRole("member"), "company", co);
    await linkIdentity(requester, "telegram", "tg:d1409f-requester", true);

    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  beforeEach(() => {
    hubReplies = [{ kind: "ok", text: "done" }];
    installHubStub();
  });
  afterEach(() => vi.restoreAllMocks());

  async function fileAndApprove(args: Record<string, unknown>): Promise<string> {
    const filed = await app.inject({
      method: "POST",
      url: `/api/${co}/automation-approvals`,
      headers: {
        authorization: "Bearer svc-token",
        "x-obo-provider": "telegram",
        "x-obo-external-id": "tg:d1409f-requester",
      },
      payload: {
        workflowId: "d1409f-agent",
        toolName: TOOL,
        toolArgs: args,
        impact: "high",
        reason: "requires human approval",
        origin: "agent",
        agentName: "d1409f-agent",
      },
    });
    expect(filed.statusCode).toBe(201);
    const id = (filed.json() as { id: string }).id;
    const decided = await app.inject({
      method: "POST",
      url: `/api/${co}/automation-approvals/${id}/decide`,
      headers: { authorization: "Bearer svc-token", "x-user-id": admin },
      payload: { decision: "approved" },
    });
    expect(decided.statusCode).toBe(200);
    return id;
  }

  async function rowOf(id: string) {
    const r = await adminPool().query(
      `SELECT execution_status, executed_by, decided_by, execution_error FROM automation_approvals WHERE id = $1`,
      [id],
    );
    return r.rows[0];
  }

  const decidedEvent = (approvalId: string): OutboxEvent => ({
    id: newId(),
    tenantId: co,
    entityType: "automation_approval",
    entityId: approvalId,
    eventType: "automation_approval.decided",
    payload: { decision: "approved", origin: "agent" },
    originSite: "main",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
  });

  it("(f-1) the re-drive is sent under the REQUESTER's OBO, never the approver's — and `executed_by` proves it on the row", async () => {
    const id = await fileAndApprove({ taskId: "f-1" });
    await automationApprovalExecutorHandler(decidedEvent(id));

    expect(hubCalls).toHaveLength(1);
    // THE assertion: whatever identity the hub called out under, it is the REQUESTER's link, not a
    // hardcoded/approver fallback. There is no code path in approval-execute.ts that can substitute the
    // approver's identity for the requester's — this pins that by observation, not by reading the code.
    expect(hubCalls[0].headers["x-obo-provider"]).toBe("telegram");
    expect(hubCalls[0].headers["x-obo-external-id"]).toBe("tg:d1409f-requester");

    const row = await rowOf(id);
    expect(row.execution_status).toBe("executed");
    expect(row.executed_by).toBe(requester);
    expect(row.decided_by).toBe(admin);
    // Never conflated, per invariant 1 of approval-execute.ts's header.
    expect(row.executed_by).not.toBe(row.decided_by);
  });

  it("(f-2) a downstream denial shaped exactly like a revoked-role Cerbos refusal fails the row closed — never retried as the approver", async () => {
    // This is the shape mcp-hub/Cerbos produce when the OBO principal's CURRENT role no longer grants
    // the tool — i.e. a role revoked between the human's approval click and this execution attempt.
    // `approval-execute.test.ts`'s own D14-13 window test uses the identical reply shape for the same
    // reason: a live hub call would hide this behind a 200/403, so the denial is asserted at the
    // typed-outcome boundary the executor itself produces.
    hubReplies = [{ kind: "isError", text: "denied by policy: requester's role no longer grants " + TOOL }];
    const id = await fileAndApprove({ taskId: "f-2" });

    const outcome = await executeApprovedAutomationWrite(co, id);
    expect(outcome.status).toBe("failed");

    // Presented under the REQUESTER's OBO — the denial is Cerbos re-evaluating THAT principal's
    // current standing, not some other identity's.
    expect(hubCalls).toHaveLength(1);
    expect(hubCalls[0].headers["x-obo-external-id"]).toBe("tg:d1409f-requester");

    const row = await rowOf(id);
    expect(row.execution_status).toBe("failed");
    expect(row.execution_error).toContain("hub_denied");
    expect(row.execution_error).toContain("no longer grants");
    // Fail CLOSED: no second attempt, no fallback identity. The row is NOT executed, and executed_by
    // (whatever it holds from the failed claim) is never the approver — there is no code path that
    // would let the approver's authority substitute for the revoked requester's.
    expect(row.executed_by).not.toBe(admin);

    // And nothing about this failure silently escalates on a later re-drive attempt: a second call
    // (e.g. a re-run) still goes out under the SAME requester identity, still gets the same typed
    // refusal — never an attempt as a different, more-privileged principal.
    const again = await executeApprovedAutomationWrite(co, id);
    expect(again).toEqual({ status: "skipped", reason: "not_pending" }); // terminal `failed`, not re-claimable by this entry point
    expect(hubCalls).toHaveLength(1);
  });
});
