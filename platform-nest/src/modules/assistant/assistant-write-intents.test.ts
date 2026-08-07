// T3b — the confirm-before-file machinery: `assistant_write_intents`, the confirm/dismiss endpoints,
// and the broker's harvest-to-intent path (`goal.suspendedIntent`, never `goal.approvalId`).
//
// Ticket: T3b, docs/superpowers/plans/2026-08-06-t3b-confirm-machinery-report.md.
// Design: docs/superpowers/plans/2026-08-06-asst-23-unblock-design.md §7.2 — the ruled state machine.
//
// This file is deliberately SEPARATE from `assistant-broker.test.ts`: that file's existing "suspended
// write" and "card state" tests keep exercising the LEGACY `approvalId`-filed-at-turn-time shape (still
// green, unmodified, on purpose — see broker.ts's own doc on why that shape is kept as a defensive
// fallback). This file drives the broker's ACTUAL, only-mode-today shape: `fileOnSuspend:false` +
// `goal.suspendedIntent` + `confirm_required`.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { assistantModule } from "./index";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

interface FakeHub {
  url: string;
  close: () => Promise<void>;
  visibility: Map<string, string[]>;
}

async function startFakeHub(): Promise<FakeHub> {
  const visibility = new Map<string, string[]>();
  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/mcp") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let method = "";
        try {
          method = (JSON.parse(raw) as { method?: string }).method ?? "";
        } catch {
          // ignore
        }
        const oboExternalId = req.headers["x-obo-external-id"] as string | undefined;
        res.writeHead(200, { "content-type": "application/json" });
        if (method === "tools/call") {
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ text: "ok (fake hub)" }] } }));
          return;
        }
        const tools = (oboExternalId ? visibility.get(oboExternalId) : undefined) ?? [];
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: tools.map((name) => ({ name, description: name, inputSchema: { type: "object" } })) } }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())), visibility };
}

interface ReceivedGoal {
  tenantId?: string;
  goal?: string;
  agent?: string;
  envelope?: { provider?: string; externalId?: string };
  requestedBy?: string;
  fileOnSuspend?: boolean;
}

interface FakeRunner {
  url: string;
  close: () => Promise<void>;
  receivedGoals: ReceivedGoal[];
}

/**
 * A scripted agent-runner whose ONLY suspended shape is `suspendedIntent` (T2b's real contract) — the
 * shape this broker's `fileOnSuspend:false` request should always produce. Marker in the goal text:
 *   INTENT:<base64(JSON {tool,impact,args})> — suspended with that intent, NO approvalId.
 *   OK                                        — status ok, one read step.
 */
async function startFakeRunner(): Promise<FakeRunner> {
  const receivedGoals: ReceivedGoal[] = [];
  const goals = new Map<string, { goal: string }>();
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && url.pathname === "/goals") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body: ReceivedGoal = {};
        try {
          body = JSON.parse(raw) as ReceivedGoal;
        } catch {
          // ignore
        }
        receivedGoals.push(body);
        const id = newId();
        goals.set(id, { goal: body.goal ?? "" });
        json(202, { id, status: "queued" });
      });
      return;
    }
    const goalMatch = /^\/goals\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && goalMatch) {
      const g = goals.get(goalMatch[1]);
      if (!g) return json(404, { error: "goal not found" });
      const intentMatch = /INTENT:(\S+)/.exec(g.goal);
      if (intentMatch) {
        const decoded = JSON.parse(Buffer.from(intentMatch[1], "base64").toString("utf8")) as {
          tool: string;
          impact: string;
          args: Record<string, unknown>;
        };
        return json(200, {
          id: goalMatch[1],
          status: "suspended",
          outcome: `suspended awaiting confirmation for ${decoded.tool} (${decoded.impact}) — not yet filed`,
          errorKind: "approval_required",
          approvalId: null,
          suspendedIntent: decoded,
          runs: [],
        });
      }
      return json(200, {
        id: goalMatch[1],
        status: "ok",
        outcome: "Status report: 0 projects.",
        errorKind: null,
        approvalId: null,
        runs: [{ runId: `run-${goalMatch[1]}`, status: "ok", provider: "echo", startedAt: Date.now() - 5, endedAt: Date.now() }],
      });
    }
    const runMatch = /^\/runs\/run-([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && runMatch) {
      return json(200, {
        runId: url.pathname,
        provider: "echo",
        steps: [{ kind: "tool", detail: "projects.list ok" }],
        startedAt: Date.now() - 5,
        endedAt: Date.now(),
      });
    }
    // The roster's registry half (handoffs.ts's `fetchRoster`) — needed for the §7.2.5 scope-note
    // test below, which drives a REAL handoff through the REAL `/handoff` endpoint against THIS fake.
    if (req.method === "GET" && url.pathname === "/agents") {
      return json(200, {
        agents: [{ name: "task-filer", tools: ["projects.list", "tasks.list", "pm.createTask", "pm.createDoc"], maxSteps: 8, maxToolCalls: 4, writeCapable: true, evaledProviders: [] }],
        supervisor: { name: "supervisor", maxSubRuns: 4, goalBudget: { modelCalls: 20, toolCalls: 20 } },
      });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())), receivedGoals };
}

/** Encodes an intent marker for the fake runner above. */
function intentMarker(tool: string, impact: string, args: Record<string, unknown>): string {
  return `INTENT:${Buffer.from(JSON.stringify({ tool, impact, args })).toString("base64")}`;
}

describe.skipIf(!TEST_URL)("T3b — confirm-before-file machinery, live PG + Cerbos", () => {
  let app: NestFastifyApplication;
  let port: number;
  let hub: FakeHub;
  let runner: FakeRunner;
  let A: string;
  let owner: string;
  let other: string;
  let admin: string; // company_admin — the decider

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(assistantModule);

    A = await createCompany("T3b Confirm Tenant", ["assistant"]);
    owner = await createUser("t3b-owner@test");
    other = await createUser("t3b-other@test");
    admin = await createUser("t3b-admin@test");
    for (const u of [owner, other, admin]) await addMembership(A, u);
    const companyAdminRole = await createRole("company_admin");
    const memberRole = await createRole("member");
    await grantRole(admin, companyAdminRole, "company", A);
    for (const u of [owner, other]) await grantRole(u, memberRole, "company", A);

    hub = await startFakeHub();
    runner = await startFakeRunner();
    hub.visibility.set(owner, ["projects.list", "tasks.list", "pm.createTask", "pm.createDoc"]);

    config.services.hub = { url: hub.url, token: "hub-token", assuranceToken: "" };
    config.services.agents = { url: runner.url, token: "runner-token" };
    config.approvalGrantSecret = "t3b-test-secret-not-a-real-one";
    config.services.gateway = { url: "", token: "" };
    config.assistantIntentTtlMs = 60 * 60 * 1000;

    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.getHttpServer().address() as { port: number }).port;
  });

  afterAll(async () => {
    await app.close();
    await hub.close();
    await runner.close();
    await teardownTestDb();
  });

  async function newThread(userId: string, title: string): Promise<string> {
    const r = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads`, headers: asUser(userId), payload: { title } });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  }

  async function sendToolMessage(userId: string, threadId: string, content: string, agent = "task-filer") {
    const r = await app.inject({
      method: "POST",
      url: `/api/${A}/assistant/threads/${threadId}/messages`,
      headers: asUser(userId),
      payload: { content, mode: "tools", agent },
    });
    expect(r.statusCode).toBe(201);
    return r.json() as { messageId: string; streamUrl: string };
  }

  async function readStream(streamUrl: string, userId: string): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}${streamUrl}`, { headers: asUser(userId) });
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    return out;
  }

  interface ThreadMsg {
    id: string;
    toolCalls: Array<{
      id: string;
      toolName: string;
      approvalId: string | null;
      approval: { status: string; executionStatus: string; executionError: string | null } | null;
      intent: { status: string; expiresAt: string } | null;
    }>;
  }

  async function getThread(userId: string, threadId: string): Promise<{ messages: ThreadMsg[] }> {
    const r = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(userId) });
    expect(r.statusCode).toBe(200);
    return r.json();
  }

  /** Drives one full turn to a drafted intent and returns everything a downstream test needs. */
  async function driveToDraft(
    tool: string,
    args: Record<string, unknown>,
    impact = "high",
  ): Promise<{ threadId: string; messageId: string; callId: string; body: string }> {
    const threadId = await newThread(owner, `draft ${tool} ${newId()}`);
    const goalsBefore = runner.receivedGoals.length;
    const { messageId, streamUrl } = await sendToolMessage(owner, threadId, intentMarker(tool, impact, args));
    const body = await readStream(streamUrl, owner);

    // The broker's request to the runner must carry `fileOnSuspend:false` — asserted here once, not
    // per-test, since every draft-producing test in this file goes through this helper.
    const goals = runner.receivedGoals.slice(goalsBefore);
    expect(goals).toHaveLength(1);
    expect(goals[0].fileOnSuspend).toBe(false);

    const msgs = (await getThread(owner, threadId)).messages;
    const callId = msgs[1].toolCalls[0].id;
    return { threadId, messageId, callId, body };
  }

  // ── THE DRAFT ITSELF: no filing, no notification, real args nowhere on the wire ──────────────────
  it("a suspended write drafts an assistant_write_intents row and surfaces confirm_required — no approval filed, no decider notified", async () => {
    const secretTitle = `secret title ${newId()}`;
    const before = await adminPool().query<{ n: string }>(`SELECT count(*)::int AS n FROM automation_approvals WHERE tenant_id = $1`, [A]);
    const notifyBefore = await adminPool().query<{ n: string }>(
      `SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND type = 'approval.requested'`,
      [A, admin],
    );

    const { threadId, callId, body } = await driveToDraft("pm.createTask", { tenantId: A, projectId: newId(), title: secretTitle });

    expect(body).toContain("event: confirm_required");
    expect(body).toContain('"toolName":"pm.createTask"');
    expect(body).toContain('"impact":"high"');
    expect(body).toContain('"errorKind":"confirm_required"');
    // The real title never touches the wire — redaction destroys the value, keeps the shape.
    expect(body).not.toContain(secretTitle);
    expect(body).not.toContain("event: approval_required"); // NOT the legacy filed-at-turn-time frame
    expect(body).not.toContain("event: done");

    // Zero filing, zero notification — the whole point of the confirm gate.
    const after = await adminPool().query<{ n: string }>(`SELECT count(*)::int AS n FROM automation_approvals WHERE tenant_id = $1`, [A]);
    expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n));
    const notifyAfter = await adminPool().query<{ n: string }>(
      `SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND type = 'approval.requested'`,
      [A, admin],
    );
    expect(Number(notifyAfter.rows[0].n)).toBe(Number(notifyBefore.rows[0].n));

    // DB-level: the intent row holds the REAL args; the ledger row's own args stay redacted.
    const intentRow = await adminPool().query<{ status: string; tool_args: { title?: string } | null; impact: string; owner_user_id: string }>(
      `SELECT status, tool_args, impact, owner_user_id FROM assistant_write_intents WHERE tool_call_id = $1`,
      [callId],
    );
    expect(intentRow.rows).toHaveLength(1);
    expect(intentRow.rows[0]).toMatchObject({ status: "draft", impact: "high", owner_user_id: owner });
    expect(intentRow.rows[0].tool_args?.title).toBe(secretTitle);

    const ledgerRow = await adminPool().query<{ args: { title?: unknown }; approval_id: string | null }>(
      `SELECT args, approval_id FROM assistant_tool_calls WHERE id = $1`,
      [callId],
    );
    expect(ledgerRow.rows[0].approval_id).toBeNull();
    expect(ledgerRow.rows[0].args.title).toBe("[redacted:string]");
    expect(JSON.stringify(ledgerRow.rows[0].args)).not.toContain(secretTitle);

    // Card state on GET thread: awaiting confirmation, no approval yet.
    const msgs = (await getThread(owner, threadId)).messages;
    expect(msgs[1].toolCalls[0]).toMatchObject({ approvalId: null, approval: null });
    expect(msgs[1].toolCalls[0].intent?.status).toBe("draft");
    expect(typeof msgs[1].toolCalls[0].intent?.expiresAt).toBe("string");
  });

  // ── CONFIRM: files byte-identically, scrubs the intent, notifies the decider ─────────────────────
  it("confirm files an origin='agent' approval attributed to the OWNER, scrubs the intent's real args, and notifies the decider", async () => {
    const title = `confirm title ${newId()}`;
    const projectId = newId();
    const { threadId, callId } = await driveToDraft("pm.createTask", { tenantId: A, projectId, title });

    const notifyBefore = await adminPool().query<{ n: string }>(
      `SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND type = 'approval.requested'`,
      [A, admin],
    );

    const res = await app.inject({
      method: "POST",
      url: `/api/${A}/assistant/threads/${threadId}/tool-calls/${callId}/confirm`,
      headers: asUser(owner),
    });
    expect(res.statusCode).toBe(200);
    const parsed = res.json() as { intentId: string; status: string; approvalId: string; approval: { status: string; executionStatus: string; executionError: string | null } };
    expect(parsed.status).toBe("filed");
    expect(parsed.approval).toMatchObject({ status: "pending", executionStatus: "not_applicable", executionError: null });
    const approvalId = parsed.approvalId;
    expect(approvalId).toBeTruthy();

    // The filed row is shape-identical to a runner/n8n-filed one: origin='agent', workflow_id = the
    // agent, requested_by = the OWNER (never a service id, never the approver).
    const approvalRow = await adminPool().query<{
      origin: string; workflow_id: string; tool_name: string; requested_by: string; tool_args: { title?: string }; impact: string; status: string;
    }>(`SELECT origin, workflow_id, tool_name, requested_by, tool_args, impact, status FROM automation_approvals WHERE id = $1`, [approvalId]);
    expect(approvalRow.rows[0]).toMatchObject({
      origin: "agent",
      workflow_id: "task-filer",
      tool_name: "pm.createTask",
      requested_by: owner,
      impact: "high",
      status: "pending",
    });
    expect(approvalRow.rows[0].tool_args.title).toBe(title); // the REAL, byte-identical args

    // The intent's own copy is scrubbed — genuinely NULL, not merely unselected.
    const intentRow = await adminPool().query<{ status: string; tool_args: unknown; approval_id: string | null }>(
      `SELECT status, tool_args, approval_id FROM assistant_write_intents WHERE tool_call_id = $1`,
      [callId],
    );
    expect(intentRow.rows[0]).toMatchObject({ status: "filed", approval_id: approvalId, tool_args: null });

    // The decider (company_admin) got the SAME bell a runner/n8n filing would have produced.
    const notifyAfter = await adminPool().query<{ n: string }>(
      `SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND type = 'approval.requested'`,
      [A, admin],
    );
    expect(Number(notifyAfter.rows[0].n)).toBe(Number(notifyBefore.rows[0].n) + 1);

    // GET thread: approval takes over, intent goes back to null.
    const msgs = (await getThread(owner, threadId)).messages;
    expect(msgs[1].toolCalls[0]).toMatchObject({ approvalId, approval: { status: "pending", executionStatus: "not_applicable", executionError: null } });
    expect(msgs[1].toolCalls[0].intent).toBeNull();
  });

  // ── END TO END: draft -> confirm -> decide -> execute -> card state, the SAME chains as T3a ───────
  it("a confirmed intent flows through the EXISTING decide()/execute() chain unchanged, and the card shows executed", async () => {
    const projectId = await createProject(A, `T3b Project ${newId()}`);
    const { threadId, callId } = await driveToDraft("pm.createTask", { tenantId: A, projectId, title: `T3b task ${newId()}` });

    const confirmRes = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads/${threadId}/tool-calls/${callId}/confirm`, headers: asUser(owner),
    });
    const { approvalId } = confirmRes.json() as { approvalId: string };

    const decideRes = await app.inject({
      method: "POST", url: `/api/${A}/automation-approvals/${approvalId}/decide`, headers: asUser(admin), payload: { decision: "approved" },
    });
    expect(decideRes.statusCode).toBe(200);

    const { executeApprovedAutomationWrite } = await import("../../core/approval-execute");
    const outcome = await executeApprovedAutomationWrite(A, approvalId);
    expect(outcome.status).toBe("executed");

    // The anti-privilege-amplification invariant, checked at the DB: the executor re-drove as the
    // ORIGINAL FILING PRINCIPAL (the owner, who confirmed it), never the approver (admin, who merely
    // decided it) — `requested_by` is what `confirmWriteIntent` set to the chatting user, and
    // `executed_by` is read straight from it (`approval-execute.ts`).
    const row = await adminPool().query<{ requested_by: string; decided_by: string; executed_by: string }>(
      `SELECT requested_by, decided_by, executed_by FROM automation_approvals WHERE id = $1`,
      [approvalId],
    );
    expect(row.rows[0]).toMatchObject({ requested_by: owner, decided_by: admin, executed_by: owner });

    const msgs = (await getThread(owner, threadId)).messages;
    expect(msgs[1].toolCalls[0]).toMatchObject({
      approvalId,
      approval: { status: "approved", executionStatus: "executed", executionError: null },
    });
  });

  // ── PRECONDITION RE-CHECK, THROUGH THE NEW CONFIRM PATH SPECIFICALLY ──────────────────────────────
  it("a confirmed intent against an ARCHIVED project still fails closed at execution — precondition_failed:project_archived, hub never called", async () => {
    const projectId = await createProject(A, `T3b Archived Project ${newId()}`);
    await withTenants([A], (c) => c.query(`UPDATE projects SET status = 'archived' WHERE id = $1`, [projectId]));
    const { threadId, callId } = await driveToDraft("pm.createTask", { tenantId: A, projectId, title: `T3b archived ${newId()}` });

    const confirmRes = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads/${threadId}/tool-calls/${callId}/confirm`, headers: asUser(owner),
    });
    expect(confirmRes.statusCode).toBe(200);
    const { approvalId } = confirmRes.json() as { approvalId: string };

    await app.inject({
      method: "POST", url: `/api/${A}/automation-approvals/${approvalId}/decide`, headers: asUser(admin), payload: { decision: "approved" },
    });

    const { executeApprovedAutomationWrite } = await import("../../core/approval-execute");
    const outcome = await executeApprovedAutomationWrite(A, approvalId);
    expect(outcome).toMatchObject({ status: "failed", error: "precondition_failed: project_archived" });

    const msgs = (await getThread(owner, threadId)).messages;
    expect(msgs[1].toolCalls[0].approval).toMatchObject({ status: "approved", executionStatus: "failed" });
  });

  // ── DOUBLE-CLICK / GENUINE CONCURRENCY — exactly one filing ───────────────────────────────────────
  it("8 concurrent confirm requests against the SAME draft file EXACTLY ONE approval — a single-winner claim, not a sequential re-call", async () => {
    const { threadId, callId } = await driveToDraft("pm.createTask", { tenantId: A, projectId: newId(), title: `race ${newId()}` });

    const before = await adminPool().query<{ n: string }>(`SELECT count(*)::int AS n FROM automation_approvals WHERE tenant_id = $1`, [A]);

    // Genuinely concurrent: N real requests fired via Promise.all against the SAME running app
    // instance, racing each other's transaction — the codebase's own established "genuine
    // concurrency" idiom for a single-winner claim (see pm-short-codes.test.ts, client-invites.test.ts).
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${threadId}/tool-calls/${callId}/confirm`, headers: asUser(owner) }),
      ),
    );
    for (const r of results) expect(r.statusCode).toBe(200);
    const approvalIds = new Set(results.map((r) => (r.json() as { approvalId: string }).approvalId));
    // Every response — the winner AND every idempotent loser — reports the SAME approval id.
    expect(approvalIds.size).toBe(1);

    const after = await adminPool().query<{ n: string }>(`SELECT count(*)::int AS n FROM automation_approvals WHERE tenant_id = $1`, [A]);
    expect(Number(after.rows[0].n) - Number(before.rows[0].n)).toBe(1); // EXACTLY one row filed, not 8
  });

  // ── DISMISS: no filing, no notification, scrubbed ────────────────────────────────────────────────
  it("dismiss discards the draft, files nothing, notifies nobody, and scrubs tool_args", async () => {
    const { threadId, callId } = await driveToDraft("pm.createDoc", { tenantId: A, projectId: newId(), title: `dismissed ${newId()}` });
    const before = await adminPool().query<{ n: string }>(`SELECT count(*)::int AS n FROM automation_approvals WHERE tenant_id = $1`, [A]);

    const res = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads/${threadId}/tool-calls/${callId}/dismiss`, headers: asUser(owner),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "dismissed", approvalId: null });

    const after = await adminPool().query<{ n: string }>(`SELECT count(*)::int AS n FROM automation_approvals WHERE tenant_id = $1`, [A]);
    expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n));

    const intentRow = await adminPool().query<{ status: string; tool_args: unknown }>(
      `SELECT status, tool_args FROM assistant_write_intents WHERE tool_call_id = $1`,
      [callId],
    );
    expect(intentRow.rows[0]).toMatchObject({ status: "dismissed", tool_args: null });

    const msgs = (await getThread(owner, threadId)).messages;
    expect(msgs[1].toolCalls[0].intent).toMatchObject({ status: "dismissed" });
  });

  it("dismissing an already-dismissed draft is idempotent (200), not a 409 — same target direction, second click", async () => {
    const { threadId, callId } = await driveToDraft("pm.createTask", { tenantId: A, projectId: newId(), title: "double dismiss" });
    const first = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${threadId}/tool-calls/${callId}/dismiss`, headers: asUser(owner) });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${threadId}/tool-calls/${callId}/dismiss`, headers: asUser(owner) });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ status: "dismissed", approvalId: null });
  });

  // ── TYPED REFUSALS, NEVER SILENT SUCCESS OR A SECOND FILING ──────────────────────────────────────
  it("confirm after dismiss is refused typed (409), not a silent success and not a filing", async () => {
    const { threadId, callId } = await driveToDraft("pm.createTask", { tenantId: A, projectId: newId(), title: "x" });
    await app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${threadId}/tool-calls/${callId}/dismiss`, headers: asUser(owner) });

    const before = await adminPool().query<{ n: string }>(`SELECT count(*)::int AS n FROM automation_approvals WHERE tenant_id = $1`, [A]);
    const res = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${threadId}/tool-calls/${callId}/confirm`, headers: asUser(owner) });
    expect(res.statusCode).toBe(409);
    // The global HttpErrorFilter reshapes every HttpException body to {error, field?} — the row's
    // actual status is named IN the message text, asserted via substring (see write-intents.ts's
    // `resolveLostClaim` comment on why this cannot be a structured field).
    expect((res.json() as { error: string }).error).toContain("dismissed");
    const after = await adminPool().query<{ n: string }>(`SELECT count(*)::int AS n FROM automation_approvals WHERE tenant_id = $1`, [A]);
    expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n));
  });

  it("dismiss after confirm is refused typed (409) — cannot dismiss something already sent for approval", async () => {
    const { threadId, callId } = await driveToDraft("pm.createTask", { tenantId: A, projectId: newId(), title: "x" });
    await app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${threadId}/tool-calls/${callId}/confirm`, headers: asUser(owner) });

    const res = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${threadId}/tool-calls/${callId}/dismiss`, headers: asUser(owner) });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain("filed");
  });

  it("expiry (confirm claim): confirm is refused typed (409) once past TTL, and the claim's own refusal reaps the row (tool_args NULL) — no filing, no background job", async () => {
    const { threadId, callId } = await driveToDraft("pm.createTask", { tenantId: A, projectId: newId(), title: "expiring" });
    // Simulate TTL passage directly (no real 1h wait) — mirrors the design's own "correctness never
    // depends on the TTL value, only on expires_at" framing.
    await adminPool().query(`UPDATE assistant_write_intents SET expires_at = now() - interval '1 minute' WHERE tool_call_id = $1`, [callId]);

    const before = await adminPool().query<{ n: string }>(`SELECT count(*)::int AS n FROM automation_approvals WHERE tenant_id = $1`, [A]);
    const confirmRes = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${threadId}/tool-calls/${callId}/confirm`, headers: asUser(owner) });
    expect(confirmRes.statusCode).toBe(409);
    expect((confirmRes.json() as { error: string }).error).toContain("expired");
    const after = await adminPool().query<{ n: string }>(`SELECT count(*)::int AS n FROM automation_approvals WHERE tenant_id = $1`, [A]);
    expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n)); // nothing was filed

    // The claim's own refusal ALSO reaped the row (resolveLostClaim's lazy reap) — genuinely NULL,
    // even before any GET thread ran.
    const row = await adminPool().query<{ status: string; tool_args: unknown }>(`SELECT status, tool_args FROM assistant_write_intents WHERE tool_call_id = $1`, [callId]);
    expect(row.rows[0]).toMatchObject({ status: "expired", tool_args: null });
  });

  it("expiry (GET thread's own lazy reap): a stale draft flips to expired + scrubs tool_args on the NEXT thread read, with no background job", async () => {
    const { threadId, callId } = await driveToDraft("pm.createTask", { tenantId: A, projectId: newId(), title: "expiring2" });
    await adminPool().query(`UPDATE assistant_write_intents SET expires_at = now() - interval '1 minute' WHERE tool_call_id = $1`, [callId]);

    // Still 'draft' in the DB until something reads the thread — no sweep has run yet.
    const before = await adminPool().query<{ status: string }>(`SELECT status FROM assistant_write_intents WHERE tool_call_id = $1`, [callId]);
    expect(before.rows[0].status).toBe("draft");

    const msgs = (await getThread(owner, threadId)).messages;
    expect(msgs[1].toolCalls[0].intent).toMatchObject({ status: "expired" });

    const after = await adminPool().query<{ status: string; tool_args: unknown }>(`SELECT status, tool_args FROM assistant_write_intents WHERE tool_call_id = $1`, [callId]);
    expect(after.rows[0]).toMatchObject({ status: "expired", tool_args: null });
  });

  // ── OWNER-ONLY, BOTH DIRECTIONS (VER-02's pattern, applied to confirm_write) ──────────────────────
  it("confirm/dismiss are owner-only: a different same-company user AND a real company_admin are BOTH denied (403), never a decision made on their behalf", async () => {
    const { threadId, callId } = await driveToDraft("pm.createTask", { tenantId: A, projectId: newId(), title: "privacy" });
    for (const intruder of [other, admin]) {
      const confirmRes = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${threadId}/tool-calls/${callId}/confirm`, headers: asUser(intruder) });
      expect(confirmRes.statusCode).toBe(403);
      const dismissRes = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${threadId}/tool-calls/${callId}/dismiss`, headers: asUser(intruder) });
      expect(dismissRes.statusCode).toBe(403);
    }
    // Still confirmable by the real owner afterwards — the intruders' attempts left it untouched.
    const ownerRes = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${threadId}/tool-calls/${callId}/confirm`, headers: asUser(owner) });
    expect(ownerRes.statusCode).toBe(200);
  });

  it("confirming/dismissing a callId with no draft at all is a 404", async () => {
    const threadId = await newThread(owner, "no draft here");
    const bogusCallId = newId();
    const confirmRes = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${threadId}/tool-calls/${bogusCallId}/confirm`, headers: asUser(owner) });
    expect(confirmRes.statusCode).toBe(404);
    const dismissRes = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${threadId}/tool-calls/${bogusCallId}/dismiss`, headers: asUser(owner) });
    expect(dismissRes.statusCode).toBe(404);
  });

  // ── 2026-08-07: the §7.2.5 scope note is OVERRULED — a handoff now reaches the SAME confirm chip ──
  // (docs/superpowers/plans/2026-08-07-handoff-confirm-report.md). This block replaces the old
  // "handoff files directly, no confirm gate" pin with its successor: a handoff's goal submission
  // now ALSO sends `fileOnSuspend:false`, and a suspended handoff's write is harvested into
  // `assistant_write_intents` via `handoffs.ts::refreshHandoff` — same table, same confirm/dismiss
  // endpoints, same card-state join, never a second mechanism.
  describe("handoff-initiated writes now reach the confirm chip (closing the §7.2.5 bypass)", () => {
    it("the REAL /handoff endpoint's goal submission sends fileOnSuspend:false, exactly like the chat-path broker", async () => {
      const threadId = await newThread(owner, "handoff no longer bypasses confirm");
      const before = runner.receivedGoals.length;

      const res = await app.inject({
        method: "POST",
        url: `/api/${A}/assistant/threads/${threadId}/handoff`,
        headers: asUser(owner),
        payload: { agent: "task-filer", goal: "file a task on my behalf" },
      });
      expect(res.statusCode).toBe(201);

      const goals = runner.receivedGoals.slice(before);
      expect(goals).toHaveLength(1);
      // Inverted from the old pin: the handoff click is consent to RUN the agent, never to ONE
      // specific write with these specific arguments — so it defers filing exactly like a chat turn.
      expect(goals[0].fileOnSuspend).toBe(false);
      expect(goals[0].agent).toBe("task-filer");
    });

    it("a suspended handoff is harvested in-thread as a draft — no approval filed, no decider notified, until the OWNER confirms it", async () => {
      const secretTitle = `handoff secret ${newId()}`;
      const threadId = await newThread(owner, "handoff harvest happy path");
      const notifyBefore = await adminPool().query<{ n: string }>(
        `SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND type = 'approval.requested'`,
        [A, admin],
      );

      const handoffRes = await app.inject({
        method: "POST",
        url: `/api/${A}/assistant/threads/${threadId}/handoff`,
        headers: asUser(owner),
        payload: { agent: "task-filer", goal: intentMarker("pm.createTask", "high", { title: secretTitle }) },
      });
      expect(handoffRes.statusCode).toBe(201);
      const handoffId = (handoffRes.json() as { id: string }).id;

      // GET .../handoffs is the run-watch poll — it lazily refreshes from the runner, and (new) is
      // where the harvest happens. Before this call NOTHING has been filed — the goal is suspended
      // but nobody but the owner has any signal of it yet.
      const beforeApprovals = await adminPool().query<{ n: string }>(`SELECT count(*)::int AS n FROM automation_approvals WHERE tenant_id = $1`, [A]);

      const listRes = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}/handoffs`, headers: asUser(owner) });
      expect(listRes.statusCode).toBe(200);
      const handoffs = listRes.json() as Array<{ id: string; status: string; approvalId: string | null }>;
      const mine = handoffs.find((h) => h.id === handoffId)!;
      expect(mine.status).toBe("suspended");
      expect(mine.approvalId).toBeNull(); // NOT filed — this is the whole point of the fix

      // Still nothing filed, nobody notified.
      const afterApprovals = await adminPool().query<{ n: string }>(`SELECT count(*)::int AS n FROM automation_approvals WHERE tenant_id = $1`, [A]);
      expect(afterApprovals.rows[0].n).toBe(beforeApprovals.rows[0].n);
      const notifyAfterHarvest = await adminPool().query<{ n: string }>(
        `SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND type = 'approval.requested'`,
        [A, admin],
      );
      expect(notifyAfterHarvest.rows[0].n).toBe(notifyBefore.rows[0].n);

      // The SAME in-thread confirm chip a chat turn would produce: one new assistant message, one
      // tool call, a 'draft' intent, real args nowhere on the wire (the response above never carried
      // `secretTitle`), and the message's own content confirms it never touched the DB as a write.
      const { messages } = await getThread(owner, threadId);
      expect(messages).toHaveLength(1); // the handoff itself never wrote a user turn into this thread
      const call = messages[0].toolCalls[0];
      expect(call.toolName).toBe("pm.createTask");
      expect(call.approvalId).toBeNull();
      expect(call.intent).toMatchObject({ status: "draft" });
      const rawBody = JSON.stringify(listRes.json()) + JSON.stringify(await getThread(owner, threadId));
      expect(rawBody).not.toContain(secretTitle);

      // The real (unredacted) args live ONLY in assistant_write_intents.tool_args pre-confirm.
      const intentRow = await adminPool().query<{ tool_args: { title?: string } }>(
        `SELECT tool_args FROM assistant_write_intents WHERE tool_call_id = $1`,
        [call.id],
      );
      expect(intentRow.rows[0].tool_args.title).toBe(secretTitle);

      // Re-polling (a second GET .../handoffs) must NOT re-harvest — no second message, no second
      // tool call, no error.
      const secondList = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}/handoffs`, headers: asUser(owner) });
      expect(secondList.statusCode).toBe(200);
      const afterSecondPoll = await getThread(owner, threadId);
      expect(afterSecondPoll.messages).toHaveLength(1);
      expect(afterSecondPoll.messages[0].toolCalls).toHaveLength(1);

      // NOW the owner confirms — this is the ONLY action that may file, and it attributes the filing
      // to the CHATTING USER (the owner), never to any handoff/agent identity.
      const confirmRes = await app.inject({
        method: "POST",
        url: `/api/${A}/assistant/threads/${threadId}/tool-calls/${call.id}/confirm`,
        headers: asUser(owner),
      });
      expect(confirmRes.statusCode).toBe(200);
      const confirmed = confirmRes.json() as { approvalId: string; approval: { status: string } };
      expect(confirmed.approval.status).toBe("pending");

      const approvalRow = await adminPool().query<{ requested_by: string; origin: string; workflow_id: string; tool_name: string; tool_args: { title?: string } }>(
        `SELECT requested_by, origin, workflow_id, tool_name, tool_args FROM automation_approvals WHERE id = $1`,
        [confirmed.approvalId],
      );
      expect(approvalRow.rows[0]).toMatchObject({ requested_by: owner, origin: "agent", workflow_id: "task-filer", tool_name: "pm.createTask" });
      expect(approvalRow.rows[0].tool_args.title).toBe(secretTitle);

      // Confirming is what notifies the decider — never the handoff/harvest step itself.
      const notifyAfterConfirm = await adminPool().query<{ n: string }>(
        `SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND type = 'approval.requested'`,
        [A, admin],
      );
      expect(Number(notifyAfterConfirm.rows[0].n)).toBeGreaterThan(Number(notifyBefore.rows[0].n));
    });

    it("a handoff whose goal never suspends harvests NOTHING — the guard is `status==='suspended' && suspendedIntent`, never merely 'this came from a handoff'", async () => {
      // The fake runner in THIS file only registers "task-filer" on /agents, so drive a plain "OK"
      // (non-INTENT) goal through it rather than switching agents.
      const threadId = await newThread(owner, "handoff read-only path");
      const res = await app.inject({
        method: "POST",
        url: `/api/${A}/assistant/threads/${threadId}/handoff`,
        headers: asUser(owner),
        payload: { agent: "task-filer", goal: "OK just read something" },
      });
      expect(res.statusCode).toBe(201);
      const listRes = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}/handoffs`, headers: asUser(owner) });
      expect(listRes.statusCode).toBe(200);
      const { messages } = await getThread(owner, threadId);
      expect(messages).toHaveLength(0); // nothing was ever harvested — there was nothing to harvest
    });
  });
});
