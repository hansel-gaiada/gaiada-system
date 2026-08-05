// D14-10 — `POST :tenantId/automation-approvals/resolve-and-execute`: the approval-aware agent
// re-run surface, against live Postgres + RLS + Cerbos.
//
// THE HAZARD THIS SUITE EXISTS TO DISPROVE is a DOUBLE-EXECUTED high-impact write. The owner's locked
// D14-b decision resumes a suspended agent goal by re-running it from the top, which means the goal's
// suspension point is reached a SECOND time while D14-03's decided-event executor may be auto-executing
// the same row concurrently (OQ-4). Two independent paths, one write. So every claim-order test below
// asserts the HUB CALL COUNT directly — never "the row says executed", which is equally true of one
// execution and of two.
//
// The hub is a stubbed fetch (same technique and same reasoning as `approval-execute.test.ts`): it is
// the only way to COUNT calls, which is the entire question here. Cerbos and everything else still go
// out for real, because the authority half of this endpoint is a real policy decision.
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
import { automationApprovalExecutorHandler } from "./approval-execute";
import { canonicalJson, computeArgsSha256 } from "./hub-client";
import type { OutboxEvent } from "../events/types";

const GRANT_SECRET = "d14-10-test-secret-not-a-real-one";
const TOOL = "test.d1410-agent-write";
const AGENT = "risky-agent";

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The digest is the BINDING (contract §1). Asserting a pinned vector here proves this endpoint hashes
// with the SAME implementation the grant is minted from and the hub verifies against — if it ever
// forked, matching would silently stop working (every re-run would re-file) or, worse, match args that
// are not the args sent. `core/hub-client.ts` is the one implementation; this is the cross-check.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("D14-10 matches on the SAME canonical digest the grant binds (contract §1)", () => {
  it("pinned vector 3 — {runId:'r1', repo:'acme/site'} → 756a6e9a…9dad", () => {
    expect(canonicalJson({ runId: "r1", repo: "acme/site" })).toBe('{"repo":"acme/site","runId":"r1"}');
    expect(computeArgsSha256({ runId: "r1", repo: "acme/site" })).toBe(
      "756a6e9ac2f5873539d73f9a95008a46ed673573ade26e86ff42a6b27b1f9dad",
    );
    // Key order is irrelevant (recursively sorted) but VALUES are not: one differing field is a
    // different approval. This is the property done-when (4) rests on.
    expect(computeArgsSha256({ repo: "acme/site", runId: "r1" })).toBe(computeArgsSha256({ runId: "r1", repo: "acme/site" }));
    expect(computeArgsSha256({ runId: "r2", repo: "acme/site" })).not.toBe(computeArgsSha256({ runId: "r1", repo: "acme/site" }));
  });
});

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
    if (!String(url).startsWith("http://hub.d1410.test")) return realFetch(url as any, init);
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

describe.skipIf(!TEST_URL)("D14-10 resolve-and-execute — agent re-run makes forward progress, exactly once", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string; // the APPROVER (company_admin) — never an execution principal
  let agentUser: string; // the ORIGINAL requester, with a verified identity link to re-drive as
  let otherUser: string; // a second member: same tenant, same rights, NOT this row's requester
  let preconditionOk: boolean;

  /** The agent's own envelope: exactly how `ai-agents` reaches the platform (through the hub, under
   *  the triggering human's OBO). Using it here — rather than `x-user-id` — keeps the authority path
   *  under test the same one production uses. */
  const asAgent = () => ({
    authorization: "Bearer svc-token",
    "x-obo-provider": "telegram",
    "x-obo-external-id": "tg:d1410-agent",
  });
  const asOtherAgentUser = () => ({
    authorization: "Bearer svc-token",
    "x-obo-provider": "telegram",
    "x-obo-external-id": "tg:d1410-other",
  });
  const asUser = (id: string) => ({ authorization: "Bearer svc-token", "x-user-id": id });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.approvalGrantSecret = GRANT_SECRET;
    config.services.hub = { url: "http://hub.d1410.test", token: "hub-token" };
    resetModules();
    resetCoreRollupProviders();
    // Isolated fixture tool. `resetExecutableApprovals()` first so this file is independent of
    // whatever the core registration (deploy.*) left in the module-level map.
    resetExecutableApprovals();
    registerExecutableApproval({
      toolName: TOOL,
      lockKey: (a) => `d1410:${String(a.taskId ?? "none")}`,
      precondition: async () => (preconditionOk ? { ok: true } : { ok: false, reason: "blocked_for_test" }),
    });

    co = await createCompany("D14-10 Agent Re-run Co");
    admin = await createUser("d1410-admin@a.test");
    agentUser = await createUser("d1410-agent@a.test");
    otherUser = await createUser("d1410-other@a.test");
    await addMembership(co, admin);
    await addMembership(co, agentUser);
    await addMembership(co, otherUser);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    // `member` is what the agent's human needs to FILE a suspension (Cerbos `create` on
    // automation_approval) — and therefore what resolve-and-execute gates on. `otherUser` gets the
    // SAME grant on purpose: the 403 below must come from the requester check, not from missing rights.
    const memberRole = await createRole("member");
    await grantRole(agentUser, memberRole, "company", co);
    await grantRole(otherUser, memberRole, "company", co);
    await linkIdentity(agentUser, "telegram", "tg:d1410-agent", true);
    await linkIdentity(otherUser, "telegram", "tg:d1410-other", true);

    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  beforeEach(() => {
    preconditionOk = true;
    hubReplies = [{ kind: "ok", text: "task t1 marked done" }];
    installHubStub();
  });
  afterEach(() => vi.restoreAllMocks());

  // ── helpers ─────────────────────────────────────────────────────────────────────────────────────

  /** File a suspension exactly as `write-agent.ts`'s `fileApproval` does through the hub's
   *  `approvals.request` tool: origin=agent, workflowId = the agent name, under the agent's envelope. */
  async function file(args: Record<string, unknown>, opts: { headers?: Record<string, string> } = {}): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/api/${co}/automation-approvals`,
      headers: opts.headers ?? asAgent(),
      payload: {
        workflowId: AGENT,
        toolName: TOOL,
        toolArgs: args,
        impact: "high",
        reason: "tool requires human approval — run suspended, nothing committed",
        origin: "agent",
        agentName: AGENT,
      },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  }

  async function decide(id: string, decision: "approved" | "rejected"): Promise<void> {
    const res = await app.inject({
      method: "POST",
      url: `/api/${co}/automation-approvals/${id}/decide`,
      headers: asUser(admin),
      payload: { decision },
    });
    expect(res.statusCode).toBe(200);
  }

  /** What the agent runner's `resolveApproval` dep does, over HTTP. */
  async function resolve(
    args: Record<string, unknown>,
    opts: { headers?: Record<string, string>; agentName?: string; toolName?: string } = {},
  ) {
    return app.inject({
      method: "POST",
      url: `/api/${co}/automation-approvals/resolve-and-execute`,
      headers: opts.headers ?? asAgent(),
      payload: { agentName: opts.agentName ?? AGENT, toolName: opts.toolName ?? TOOL, toolArgs: args },
    });
  }

  async function rowOf(id: string) {
    const r = await adminPool().query(
      `SELECT status, execution_status, execution_attempts, executed_by, decided_by, execution_error, execution_result
         FROM automation_approvals WHERE id = $1`,
      [id],
    );
    return r.rows[0];
  }

  /** How many approvals exist for this exact (agent, tool, args) — the duplicate-filing detector. */
  async function approvalCountFor(args: Record<string, unknown>): Promise<number> {
    const r = await adminPool().query<{ tool_args: unknown }>(
      `SELECT tool_args FROM automation_approvals WHERE origin = 'agent' AND workflow_id = $1 AND tool_name = $2 AND deleted_at IS NULL`,
      [AGENT, TOOL],
    );
    const wanted = computeArgsSha256(args);
    return r.rows.filter((row) => computeArgsSha256(row.tool_args as Record<string, unknown>) === wanted).length;
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

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // (1) A re-run after approval executes the write EXACTLY ONCE and the goal can continue.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("(1) re-run after approval executes the write exactly once and hands the runner a result to continue with", async () => {
    const args = { taskId: "t-one", status: "done" };
    const id = await file(args);
    await decide(id, "approved");
    expect((await rowOf(id)).execution_status).toBe("pending");

    const res = await resolve(args);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      match: "executed",
      approvalId: id,
      consumed: false, // executed BY this call
      result: "task t1 marked done",
      truncated: false,
    });

    // EXACTLY ONE hub call — counted, not inferred from the row's terminal state.
    expect(hubCalls).toHaveLength(1);
    expect(hubCalls[0].body).toMatchObject({ method: "tools/call", params: { name: TOOL, arguments: args } });
    // Authority: re-driven as the ORIGINAL requester's verified link, never the approver's.
    expect(hubCalls[0].headers["x-obo-provider"]).toBe("telegram");
    expect(hubCalls[0].headers["x-obo-external-id"]).toBe("tg:d1410-agent");
    // The grant binds THESE args.
    const claims = JSON.parse(Buffer.from(hubCalls[0].headers["x-approval-grant"].split(".")[0], "base64url").toString("utf8"));
    expect(claims).toMatchObject({ v: 1, approvalId: id, tenantId: co, toolName: TOOL });
    expect(claims.argsSha256).toBe(computeArgsSha256(args));

    const row = await rowOf(id);
    expect(row.execution_status).toBe("executed");
    expect(row.execution_attempts).toBe(1);
    expect(row.executed_by).toBe(agentUser);
    expect(row.decided_by).toBe(admin);
    expect(row.executed_by).not.toBe(row.decided_by);
    // And no second approval was filed anywhere along the way.
    expect(await approvalCountFor(args)).toBe(1);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // (2) A SECOND re-run does not execute again — it consumes the stored result.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("(2) a second re-run consumes the stored execution_result WITHOUT re-calling the tool", async () => {
    const args = { taskId: "t-two", status: "done" };
    const id = await file(args);
    await decide(id, "approved");

    const first = await resolve(args);
    expect(first.json()).toMatchObject({ match: "executed", consumed: false });
    expect(hubCalls).toHaveLength(1);

    // Two more re-runs of the same goal. Neither may reach the hub.
    const second = await resolve(args);
    const third = await resolve(args);
    expect(hubCalls).toHaveLength(1); // STILL one
    for (const r of [second, third]) {
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({
        match: "executed",
        approvalId: id,
        consumed: true, // read from the row, not produced now
        result: "task t1 marked done",
        truncated: false,
      });
    }
    // The row is untouched by the consumptions: one attempt, one execution.
    expect((await rowOf(id)).execution_attempts).toBe(1);
    expect(await approvalCountFor(args)).toBe(1);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // (3) BOTH CLAIM ORDERS ⇒ exactly ONE execution. The race that matters (OQ-4).
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("(3a) ORDER: executor auto-executes first, THEN the re-run — hub called exactly ONCE, the re-run consumes", async () => {
    const args = { taskId: "t-order-a", status: "done" };
    const id = await file(args);
    await decide(id, "approved");

    // The decided-event handler main.ts registers — D14-03's auto-execute (OQ-4).
    await automationApprovalExecutorHandler(decidedEvent(id));
    expect(hubCalls).toHaveLength(1);
    expect((await rowOf(id)).execution_status).toBe("executed");

    // Now the goal is re-run. It must NOT execute a second time.
    const res = await resolve(args);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ match: "executed", approvalId: id, consumed: true, result: "task t1 marked done" });
    expect(hubCalls).toHaveLength(1); // ← the assertion this whole ticket is about
    expect((await rowOf(id)).execution_attempts).toBe(1);
  });

  it("(3b) ORDER: the re-run claims first, THEN the decided event is redelivered — hub called exactly ONCE, redelivery no-ops", async () => {
    const args = { taskId: "t-order-b", status: "done" };
    const id = await file(args);
    await decide(id, "approved");

    const res = await resolve(args);
    expect(res.json()).toMatchObject({ match: "executed", approvalId: id, consumed: false });
    expect(hubCalls).toHaveLength(1);

    // At-least-once delivery: the same decided event arrives (twice, for good measure) AFTER the
    // re-run already claimed and executed. D14-03's `WHERE execution_status = 'pending'` claim finds
    // zero rows and returns silently — no second call, no state change.
    await automationApprovalExecutorHandler(decidedEvent(id));
    await automationApprovalExecutorHandler(decidedEvent(id));
    expect(hubCalls).toHaveLength(1); // ← same assertion, opposite order
    const row = await rowOf(id);
    expect(row.execution_status).toBe("executed");
    expect(row.execution_attempts).toBe(1);
  });

  it("(3c) CONCURRENT: the re-run and the decided-event executor race in-flight — still exactly ONE hub call", async () => {
    // Neither (3a) nor (3b) can catch a claim that is lost BETWEEN the endpoint's SELECT and its
    // claim, because both are strictly sequential. Firing them together exercises the `skipped`
    // branch: whichever loses the `pending -> executing` claim must consume, never re-drive.
    const args = { taskId: "t-order-c", status: "done" };
    const id = await file(args);
    await decide(id, "approved");

    const [viaEndpoint] = await Promise.all([resolve(args), automationApprovalExecutorHandler(decidedEvent(id))]);
    expect(hubCalls).toHaveLength(1); // ← whoever won, ONE execution
    expect(viaEndpoint.statusCode).toBe(200);
    const body = viaEndpoint.json();
    expect(body.approvalId).toBe(id);
    // The endpoint either won the claim and executed, or lost it and reports the winner's outcome —
    // `executed` if the auto-execute already finished, `executing` while its hub call is still in
    // flight (the claim commits before that call; see 3d's note). Never a second execution.
    expect(
      (body.match === "executed" && body.result === "task t1 marked done") || body.match === "executing",
    ).toBe(true);
    const row = await rowOf(id);
    expect(row.execution_status).toBe("executed");
    expect(row.execution_attempts).toBe(1);
  });

  it("(3d) CONCURRENT: two re-runs of the same goal race each other — exactly ONE executes, the loser never re-drives", async () => {
    // The symmetric race, and the one that proves the CLAIM (not luck) is what serializes: both
    // requests read `pending`, both attempt `UPDATE ... WHERE execution_status = 'pending'`, the second
    // blocks on the row lock, then re-evaluates the WHERE against the newly committed row version and
    // matches ZERO rows. Exactly one execution.
    //
    // WHAT THE LOSER GETS, and why BOTH answers are correct (this is a real observed behaviour, not a
    // loose assertion): the winner's hub call happens OUTSIDE its claim transaction (deliberately —
    // `approval-execute.ts`'s TRANSACTION BOUNDARY note: never hold an advisory lock across network
    // I/O), so the row sits at `executing` for the duration of that call. The loser re-reads and
    // therefore sees EITHER `executed` (the winner already finished ⇒ it consumes the stored result and
    // continues) OR `executing` (still in flight ⇒ the specified typed "loud wait": the goal stops and
    // a later re-run finds `executed`). It must NEVER see a second execution, and it must never claim.
    // The platform deliberately does NOT block waiting on an in-flight external call.
    const args = { taskId: "t-order-d", status: "done" };
    const id = await file(args);
    await decide(id, "approved");

    const [a, b] = await Promise.all([resolve(args), resolve(args)]);
    expect(hubCalls).toHaveLength(1); // ← the only thing that would be catastrophic to get wrong
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const bodies = [a.json(), b.json()];
    // Exactly one caller produced the execution.
    expect(bodies.filter((x) => x.match === "executed" && x.consumed === false)).toHaveLength(1);
    // The other either consumed it or was told it is in flight — never a second `consumed: false`.
    const loser = bodies.find((x) => !(x.match === "executed" && x.consumed === false))!;
    expect(loser.approvalId).toBe(id);
    expect(
      (loser.match === "executed" && loser.consumed === true && loser.result === "task t1 marked done") ||
        loser.match === "executing",
    ).toBe(true);

    const row = await rowOf(id);
    expect(row.execution_status).toBe("executed");
    expect(row.execution_attempts).toBe(1); // ONE claim ⇒ ONE attempt, whatever the loser saw

    // And the loser's later re-run resolves cleanly to the stored result — forward progress is only
    // delayed by the race, never lost.
    const later = await resolve(args);
    expect(later.json()).toMatchObject({ match: "executed", approvalId: id, consumed: true, result: "task t1 marked done" });
    expect(hubCalls).toHaveLength(1);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // (4) One differing field ⇒ NO match ⇒ suspends anew. An approval can never pre-authorize
  //     a different call.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("(4) args differing by ONE field do not match the approved row — the runner suspends anew", async () => {
    const approvedArgs = { taskId: "t-four", status: "done" };
    const id = await file(approvedArgs);
    await decide(id, "approved");

    // One field changed (a different task) — a DIFFERENT write, never covered by this approval.
    const other = await resolve({ taskId: "t-four-DIFFERENT", status: "done" });
    expect(other.statusCode).toBe(200);
    expect(other.json()).toEqual({ match: "none" });
    expect(hubCalls).toHaveLength(0);

    // One field's VALUE changed on the same task — also a different write.
    const changedValue = await resolve({ taskId: "t-four", status: "blocked" });
    expect(changedValue.json()).toEqual({ match: "none" });

    // An EXTRA field is a different call too (superset ≠ match; the human approved exactly these args).
    const extraField = await resolve({ taskId: "t-four", status: "done", force: true });
    expect(extraField.json()).toEqual({ match: "none" });

    // A MISSING field, likewise.
    const missingField = await resolve({ taskId: "t-four" });
    expect(missingField.json()).toEqual({ match: "none" });

    // A different TOOL with the identical args — the digest matches but the tool does not.
    const otherTool = await resolve(approvedArgs, { toolName: "test.d1410-some-other-tool" });
    expect(otherTool.json()).toEqual({ match: "none" });

    // A different AGENT with the identical args + tool — `workflow_id` is part of the binding.
    const otherAgent = await resolve(approvedArgs, { agentName: "some-other-agent" });
    expect(otherAgent.json()).toEqual({ match: "none" });

    expect(hubCalls).toHaveLength(0); // nothing executed for any near-miss
    expect((await rowOf(id)).execution_status).toBe("pending"); // the real row is untouched

    // ...and the exact call still resolves, proving the negatives above are about the ARGS, not a
    // broken matcher (a matcher that never matched would pass every assertion so far).
    const exact = await resolve(approvedArgs);
    expect(exact.json()).toMatchObject({ match: "executed", approvalId: id });
    expect(hubCalls).toHaveLength(1);

    // Key ORDER is not part of the binding — canonical JSON sorts recursively.
    const reordered = await resolve({ status: "done", taskId: "t-four" });
    expect(reordered.json()).toMatchObject({ match: "executed", approvalId: id, consumed: true });
    expect(hubCalls).toHaveLength(1);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // (5) A rejected row ⇒ typed refusal, and NO duplicate approval filed for the identical call.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("(5) a rejected row yields a typed refusal, never an execution — and the caller has no reason to re-file", async () => {
    const args = { taskId: "t-five", status: "done" };
    const id = await file(args);
    await decide(id, "rejected");

    const res = await resolve(args);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      match: "rejected",
      approvalId: id,
      reason: "tool requires human approval — run suspended, nothing committed",
    });
    expect(hubCalls).toHaveLength(0);

    // Re-running repeatedly keeps refusing, and NEVER creates a second row for the identical call —
    // which is what "no duplicate approval filed" means on this side of the wire: `match: "rejected"`
    // is not `match: "none"`, so `write-agent.ts` never reaches `fileApproval`.
    await resolve(args);
    await resolve(args);
    expect(await approvalCountFor(args)).toBe(1);
    expect((await rowOf(id)).execution_status).toBe("not_applicable");
    expect(hubCalls).toHaveLength(0);
  });

  it("(5b) a later APPROVAL of the same call outranks the earlier rejection (a human changed their mind)", async () => {
    const args = { taskId: "t-five-b", status: "done" };
    const rejected = await file(args);
    await decide(rejected, "rejected");
    const approved = await file(args); // the human asked to be asked again
    await decide(approved, "approved");

    const res = await resolve(args);
    expect(res.json()).toMatchObject({ match: "executed", approvalId: approved, consumed: false });
    expect(hubCalls).toHaveLength(1);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // AUTHORITY (§1) — the original requester, never the approver.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("the APPROVER cannot resolve-and-execute a row they decided — 403, not a silent `none`", async () => {
    const args = { taskId: "t-authority", status: "done" };
    const id = await file(args);
    await decide(id, "approved");

    const byApprover = await resolve(args, { headers: asUser(admin) });
    expect(byApprover.statusCode).toBe(403);
    // `{ error: "<message>" }` — the house error shape (`src/http-error.filter.ts` keeps Fastify-era
    // contract parity; it is NOT Nest's default `{ message }`).
    expect(byApprover.json().error).toMatch(/only by the principal that filed it/);
    expect(hubCalls).toHaveLength(0);
    expect((await rowOf(id)).execution_status).toBe("pending"); // nothing claimed

    // The 403 (not `none`) matters: `none` means "file a fresh approval", so answering an authority
    // failure with it would turn a permission problem back into the duplicate-approval generator.
    const byRequester = await resolve(args);
    expect(byRequester.json()).toMatchObject({ match: "executed", approvalId: id });
    expect(hubCalls).toHaveLength(1);
  });

  it("another user with the SAME rights cannot consume someone else's approval (403 — the gate is the requester, not the role)", async () => {
    const args = { taskId: "t-cross-user", status: "done" };
    const id = await file(args);
    await decide(id, "approved");

    const byOther = await resolve(args, { headers: asOtherAgentUser() });
    expect(byOther.statusCode).toBe(403);
    expect(hubCalls).toHaveLength(0);
    expect((await rowOf(id)).execution_status).toBe("pending");
  });

  it("a principal without the filing right is refused by Cerbos before any row is looked at", async () => {
    const args = { taskId: "t-unauthorized", status: "done" };
    const id = await file(args);
    await decide(id, "approved");

    // A member of a DIFFERENT company: `inTenant` fails, so Cerbos denies `create` here.
    const strangerCo = await createCompany("D14-10 Stranger Co");
    const stranger = await createUser("d1410-stranger@a.test");
    await addMembership(strangerCo, stranger);
    await grantRole(stranger, await createRole("member"), "company", strangerCo);
    const res = await resolve(args, { headers: asUser(stranger) });
    expect(res.statusCode).toBe(403);
    expect(hubCalls).toHaveLength(0);
    expect((await rowOf(id)).execution_status).toBe("pending");
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // FAIL-CLOSED STATES — none of these may become "so call the tool yourself".
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("an UNDECIDED (pending-decision) row is not a match — the runner suspends as it does today", async () => {
    const args = { taskId: "t-undecided", status: "done" };
    await file(args); // filed, nobody has decided it
    const res = await resolve(args);
    expect(res.json()).toEqual({ match: "none" });
    expect(hubCalls).toHaveLength(0);
  });

  it("an approved row whose tool has NO executable-registry entry resolves to `not_executable`, never an execution", async () => {
    // `decide()` leaves an unregistered tool at 'not_applicable' (the registry-scoped rule) — the
    // common case for an agent write today, since the registry holds only deploy.*.
    const unregistered = "test.d1410-unregistered";
    const args = { taskId: "t-unregistered" };
    const created = await app.inject({
      method: "POST",
      url: `/api/${co}/automation-approvals`,
      headers: asAgent(),
      payload: { workflowId: AGENT, toolName: unregistered, toolArgs: args, impact: "high", origin: "agent", agentName: AGENT },
    });
    const id = (created.json() as { id: string }).id;
    await decide(id, "approved");
    expect((await rowOf(id)).execution_status).toBe("not_applicable");

    const res = await resolve(args, { toolName: unregistered });
    expect(res.json()).toEqual({ match: "not_executable", approvalId: id, reason: "no_executable_registry_entry" });
    expect(hubCalls).toHaveLength(0);
  });

  it("a stale precondition lands `failed` and the re-run reports it — a second re-run does NOT retry it", async () => {
    const args = { taskId: "t-stale", status: "done" };
    const id = await file(args);
    await decide(id, "approved");
    preconditionOk = false;

    const first = await resolve(args);
    expect(first.json()).toEqual({ match: "failed", approvalId: id, error: "precondition_failed: blocked_for_test" });
    expect(hubCalls).toHaveLength(0); // a refused precondition never reaches the hub

    // Even with the precondition healthy again, the agent must NOT re-drive a terminally failed row:
    // only a HUMAN's D14-07 retry may, because that path re-evaluates the precondition under the lock
    // and because a tool_error/transport failure MAY have partially applied.
    preconditionOk = true;
    const second = await resolve(args);
    expect(second.json()).toMatchObject({ match: "failed", approvalId: id });
    expect(hubCalls).toHaveLength(0);
    expect((await rowOf(id)).execution_attempts).toBe(1);
  });

  it("a hub denial is reported as `failed` with the hub's own reason — the runner never retries around it", async () => {
    hubReplies = [{ kind: "isError", text: "denied by policy: " + TOOL }];
    const args = { taskId: "t-denied", status: "done" };
    const id = await file(args);
    await decide(id, "approved");

    const res = await resolve(args);
    expect(res.json()).toEqual({ match: "failed", approvalId: id, error: `hub_denied: denied by policy: ${TOOL}` });
    expect(hubCalls).toHaveLength(1); // the grant WAS presented; the hub refused anyway
    expect((await rowOf(id)).execution_status).toBe("failed");
  });

  it("an `executing` row (another executor in flight) reports `executing` and never claims it again", async () => {
    const args = { taskId: "t-inflight", status: "done" };
    const id = await file(args);
    await decide(id, "approved");
    // Simulate the crash-wedge / in-flight state D14-03 leaves for the duration of a hub call.
    await withTenants([co], (c) =>
      c.query(`UPDATE automation_approvals SET execution_status = 'executing' WHERE id = $1`, [id]),
    );

    const res = await resolve(args);
    expect(res.json()).toEqual({ match: "executing", approvalId: id });
    expect(hubCalls).toHaveLength(0);
  });

  it("an automation-origin row is invisible to this endpoint (it is the agent surface only)", async () => {
    // origin='automation' rows are driven by the decided-event executor and D14-07's retry. Letting an
    // agent principal resolve one would be a cross-origin authority hole.
    const args = { taskId: "t-automation" };
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO automation_approvals
           (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at,
            origin, origin_site, execution_status)
         VALUES ($1, $2, $3, $4, $5, 'high', 'approved', $6, $7, now(), 'automation', 'main', 'pending')`,
        [id, co, AGENT, TOOL, JSON.stringify(args), agentUser, admin],
      ),
    );
    const res = await resolve(args);
    expect(res.json()).toEqual({ match: "none" });
    expect(hubCalls).toHaveLength(0);
    expect((await rowOf(id)).execution_status).toBe("pending");
  });

  it("a decided row in ANOTHER tenant is invisible (RLS), even to the same requester", async () => {
    const args = { taskId: "t-cross-tenant", status: "done" };
    const id = await file(args);
    await decide(id, "approved");

    const otherCo = await createCompany("D14-10 Other Tenant Co");
    await addMembership(otherCo, agentUser);
    await grantRole(agentUser, await createRole("member"), "company", otherCo);
    const res = await app.inject({
      method: "POST",
      url: `/api/${otherCo}/automation-approvals/resolve-and-execute`,
      headers: asAgent(),
      payload: { agentName: AGENT, toolName: TOOL, toolArgs: args },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ match: "none" }); // the row exists, but not in this tenant
    expect(hubCalls).toHaveLength(0);
    expect((await rowOf(id)).execution_status).toBe("pending");
  });

  it("rejects a request with no agentName/toolName (400 — never a silent `none`)", async () => {
    for (const payload of [{}, { agentName: AGENT }, { toolName: TOOL }]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/${co}/automation-approvals/resolve-and-execute`,
        headers: asAgent(),
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("records the resume in the activity trail, distinguishing an execution from a consumption", async () => {
    const args = { taskId: "t-activity", status: "done" };
    const id = await file(args);
    await decide(id, "approved");
    await resolve(args); // executes
    await resolve(args); // consumes

    const acts = await adminPool().query<{ verb: string; actor_id: string }>(
      // `activities` timestamps on `occurred_at` (0001), not `created_at`.
      `SELECT verb, actor_id FROM activities WHERE target_entity_type = 'automation_approval' AND target_entity_id = $1 ORDER BY occurred_at`,
      [id],
    );
    const verbs = acts.rows.map((r) => r.verb);
    expect(verbs).toContain("resumed");
    expect(verbs).toContain("consumed");
    // The actor is the AGENT's human, not the approver — same authority rule as the execution itself.
    expect(acts.rows.filter((r) => r.verb === "resumed" || r.verb === "consumed").every((r) => r.actor_id === agentUser)).toBe(true);
  });
});
