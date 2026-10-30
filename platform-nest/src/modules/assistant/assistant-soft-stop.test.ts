// AIP-18 (docs/plans/2026-10-27-ai-plan.md §6.3 item 9; FRONTEND-BFF-CONTRACT §66.11) — the soft stop on the assistant's send path and on
// agent hand-offs, end to end against real Postgres (RLS on) and real Cerbos, with a fake gateway and a fake agent runner that record exactly
// what they were sent. Claims:
//   STOPPED TURN     a person over their daily allowance: the stream's FIRST frame is `event: budget` { kind, resetsAt } (no figure); the
//                    gateway gets `tier: "fast"` and NO provider hint and NO provider session although the thread names a provider the person
//                    may pick; the placeholder and the finished reply carry the `turn_budget` part; the thread row's brain settings are
//                    untouched; the usage row records the applied tier `fast`.
//   UNSTOPPED TURN   byte for byte today's gateway request (prompt, task, provider, providerSession; no tier), no budget frame, no part.
//   ASK              the same decision on `POST assistant/ask`: `turnBudget` in the answer only when stopped, and the department stop end to end
//                    (home node -> ancestor with a soft_stop budget over its figure -> `{ kind: "department", unitNodeId }`).
//   HELD HAND-OFF    a hand-off while stopped is `held` (no goal id, why, when it resets) and the runner is NOT called; it is listed with its
//                    status and never polled; its owner cancels it (200, then 409 `not_held`), a stranger cannot (403), an unknown id is 404.
//   RELEASE          the 10-minute job starts a held hand-off once its owner is no longer stopped (posted exactly as a fresh one: the owner's
//                    envelope, fileOnSuspend false) and leaves a still-stopped owner's held; two releases racing post the goal ONCE.
//   MIGRATION        the live table takes every old status plus `held`, and refuses a held row with no reason or a goal-less unheld row.
// Needs the Linux gate (DATABASE_URL_TEST + a Cerbos with the current policies). It SKIPS without a database; a skip is not a pass.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { rebuildOrgUnitClosure } from "../../core/org-unit-closure";
import { clearBudgetStateCacheForTests } from "../ai-usage/soft-stop";
import { clearUnitCacheForTests } from "../ai-usage/gateway-usage";
import { runUsageAlertsSweep } from "../ai-usage/usage-alerts-job";
import { releaseHeldHandoffs } from "./handoffs";
import { assistantModule } from "./index";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── the fakes ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface GatewayCall { raw: string; body: Record<string, unknown> }

function startFakeGateway(): Promise<{ url: string; calls: GatewayCall[]; close: () => Promise<void> }> {
  const calls: GatewayCall[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* not this fake's concern */ }
      if (req.method === "POST" && req.url === "/complete/stream") {
        calls.push({ raw, body });
        res.writeHead(200, { "content-type": "text/event-stream" });
        // meta names the tier the gateway applied: the request's own tier (a provider hint beats it, as in the real gateway)
        const tier = typeof body.tier === "string" && !body.provider ? body.tier : undefined;
        res.write(`event: meta\ndata: ${JSON.stringify({ provider: "openai", model: "glm-5.3-flash", ...(tier ? { tier } : {}) })}\n\n`);
        res.write(`data: ${JSON.stringify("a lighter answer")}\n\n`);
        res.write(`event: done\ndata: {}\n\n`);
        res.end();
        return;
      }
      if (req.method === "POST" && req.url === "/complete") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: "summary", provider: "openai" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  })));
}

interface ReceivedGoal { tenantId?: string; goal?: string; agent?: string; envelope?: { provider?: string; externalId?: string }; requestedBy?: string; fileOnSuspend?: boolean }

function startFakeRunner(): Promise<{ url: string; goals: ReceivedGoal[]; goalPolls: string[]; postDelayMs: { v: number }; close: () => Promise<void> }> {
  const goals: ReceivedGoal[] = [];
  const goalPolls: string[] = [];
  const postDelayMs = { v: 0 };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && url.pathname === "/agents") {
      return json(200, { agents: [{ name: "status-reporter", tools: ["projects.list"], maxSteps: 8, maxToolCalls: 6, writeCapable: false, evaledProviders: [] }], supervisor: null });
    }
    if (req.method === "POST" && url.pathname === "/goals") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        goals.push(JSON.parse(raw) as ReceivedGoal);
        setTimeout(() => json(202, { id: randomUUID(), status: "queued" }), postDelayMs.v);
      });
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/goals/")) {
      goalPolls.push(url.pathname);
      return json(404, { error: "unknown" });
    }
    if (req.method === "GET" && url.pathname === "/episodes") return json(200, { episodes: [] });
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    goals, goalPolls, postDelayMs,
    close: () => new Promise<void>((r) => server.close(() => r())),
  })));
}

async function grantChooseProvider(userId: string, tenantId: string): Promise<void> {
  const roleId = randomUUID();
  await adminPool().query(`INSERT INTO roles (id, company_id, name) VALUES ($1, $2, $3)`, [roleId, tenantId, `aip18_brain_chooser_${roleId.slice(0, 8)}`]);
  const ins = await adminPool().query(
    `INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = 'assistant.brain.choose_provider'`, [roleId],
  );
  expect(ins.rowCount).toBe(1);
  await grantRole(userId, roleId, "company", tenantId);
}

describe.skipIf(!TEST_URL)("AIP-18 soft stop: the send path and held hand-offs (HTTP, real Postgres + Cerbos)", () => {
  let app: NestFastifyApplication;
  let port: number;
  let gateway: Awaited<ReturnType<typeof startFakeGateway>>;
  let runner: Awaited<ReturnType<typeof startFakeRunner>>;
  let A: string;
  let stopped: string; // over their daily allowance
  let free: string; // never stopped
  let deptUser: string; // stopped by an ancestor unit's soft_stop budget
  let other: string; // a member of A, never the owner of these threads
  const q = () => adminPool();

  const usageRow = (tenant: string, user: string | null, over: Record<string, unknown> = {}) => {
    const r: Record<string, unknown> = { tenant_id: tenant, user_id: user, surface: "assistant", capability: "chat", tokens_source: "provider", outcome: "ok", ...over };
    const cols = Object.keys(r);
    return q().query(
      `INSERT INTO ai_usage_events (id, occurred_at, ${cols.join(", ")}) VALUES ($1, now(), ${cols.map((_, i) => `$${i + 2}`).join(", ")})`,
      [newId(), ...cols.map((c) => r[c])],
    );
  };

  const row = async (id: string) =>
    (await q().query(`SELECT status, goal_id, hold_kind, hold_unit_node_id, held_at, goal_text FROM assistant_handoffs WHERE id = $1`, [id])).rows[0];

  async function newThread(owner: string, brain?: { provider: string; session: string } | { tier: string }): Promise<string> {
    const r = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads`, headers: asUser(owner), payload: { title: "soft stop" } });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id as string;
    if (brain && "provider" in brain) {
      await q().query(`UPDATE assistant_threads SET brain_provider = $2, hermes_session_id = $3 WHERE id = $1`, [id, brain.provider, brain.session]);
    } else if (brain) {
      await q().query(`UPDATE assistant_threads SET brain_tier = $2 WHERE id = $1`, [id, brain.tier]);
    }
    return id;
  }

  async function readAll(res: Response): Promise<string> {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    return out;
  }

  /** One full chat turn: send, open the stream, read it to the end. Returns the SSE text and the placeholder id. */
  async function turn(owner: string, threadId: string, content: string): Promise<{ sse: string; messageId: string }> {
    const sent = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${threadId}/messages`, headers: asUser(owner), payload: { content } });
    expect(sent.statusCode, sent.body).toBe(201);
    const { messageId, streamUrl } = sent.json() as { messageId: string; streamUrl: string };
    const placeholder = await q().query(`SELECT parts FROM assistant_messages WHERE id = $1`, [messageId]);
    lastPlaceholderParts = placeholder.rows[0].parts as unknown[];
    const res = await fetch(`http://127.0.0.1:${port}${streamUrl}`, { headers: asUser(owner) });
    expect(res.status).toBe(200);
    return { sse: await readAll(res), messageId };
  }
  let lastPlaceholderParts: unknown[] = [];

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(assistantModule);
    gateway = await startFakeGateway();
    runner = await startFakeRunner();
    config.services.gateway = { url: gateway.url, token: "gw-token" };
    config.services.agents = { url: runner.url, token: "runner-token" };
    config.assistant.streamIdleTimeoutMs = 2000;

    A = await createCompany("Soft Stop Co", ["assistant"]);
    const mk = async (key: string) => {
      const id = await createUser(`${key}@aip18.test`, key);
      await addMembership(A, id);
      return id;
    };
    stopped = await mk("stopped");
    free = await mk("free");
    deptUser = await mk("deptuser");
    other = await mk("other");
    const member = await createRole("member");
    for (const u of [stopped, free, deptUser, other]) await grantRole(u, member, "company", A);
    await grantChooseProvider(stopped, A);
    await grantChooseProvider(free, A);

    // the allowance stop: an override of 1 reply a day, and one completed reply today
    await q().query(`INSERT INTO ai_person_allowances (tenant_id, user_id, daily_replies) VALUES ($1, $2, 1)`, [A, stopped]);
    await usageRow(A, stopped);

    // the department stop: dv-fe under d-web; d-web has a soft_stop budget of 1.00 and its subtree spent 2.00 this month
    const root = {
      id: "d-corp", kind: "company", name: "Soft Stop Co",
      children: [{ id: "d-web", kind: "department", name: "Web Dev", children: [{ id: "dv-fe", kind: "division", name: "Frontend", children: [] }] }],
    };
    await withTenants([A], (c) => c.query(
      `INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,$3) ON CONFLICT (tenant_id) DO UPDATE SET structure = EXCLUDED.structure`,
      [A, JSON.stringify({ root }), config.originSite],
    ));
    await withTenants([A], (c) => rebuildOrgUnitClosure(c, A, root));
    await q().query(
      `INSERT INTO org_unit_memberships (tenant_id, user_id, unit_node_id, is_primary, valid_from, origin_site) VALUES ($1, $2, 'dv-fe', true, current_date - 3, $3)`,
      [A, deptUser, config.originSite],
    );
    await q().query(`INSERT INTO ai_budgets (tenant_id, scope, unit_node_id, monthly_usd, mode) VALUES ($1, 'unit', 'd-web', 1, 'soft_stop')`, [A]);
    await usageRow(A, other, { unit_node_id: "dv-fe", cost_usd: "2.00", cost_source: "provider" });

    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.getHttpServer().address() as AddressInfo).port;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await gateway?.close();
    await runner?.close();
    await teardownTestDb();
  });

  beforeEach(() => {
    clearBudgetStateCacheForTests();
    clearUnitCacheForTests();
    runner.postDelayMs.v = 0;
  });

  // ═════════════════════════════════════════ the send path ═════════════════════════════════════════
  describe("a chat turn", () => {
    it("STOPPED: one budget frame first, `fast` with no hint and no session, the part kept, the thread untouched, the usage row says fast", async () => {
      const threadId = await newThread(stopped, { provider: "hermes", session: "sess-keep" });
      const before = gateway.calls.length;
      const { sse, messageId } = await turn(stopped, threadId, "what is on today?");

      // the placeholder carried the decision made at send time
      expect(lastPlaceholderParts).toContainEqual(expect.objectContaining({ type: "turn_budget", kind: "allowance" }));
      // the budget frame is the first frame, with no figure in it
      const firstEvent = /event: (\w+)\ndata: (.*)\n/.exec(sse);
      expect(firstEvent?.[1]).toBe("budget");
      const frame = JSON.parse(firstEvent![2]) as Record<string, unknown>;
      expect(Object.keys(frame).sort()).toEqual(["kind", "resetsAt"]);
      expect(frame.kind).toBe("allowance");
      const resets = new Date(frame.resetsAt as string);
      expect(resets.getUTCHours()).toBe(0);
      expect(resets.getTime()).toBeGreaterThan(Date.now());
      expect(sse.split("event: budget\n").length - 1).toBe(1);
      expect(sse).toContain("event: done");

      // the gateway: fast, and neither the stored provider nor its session
      expect(gateway.calls.length).toBe(before + 1);
      const body = gateway.calls[before].body;
      expect(body.tier).toBe("fast");
      expect(body).not.toHaveProperty("provider");
      expect(body).not.toHaveProperty("providerSession");

      // the finished reply keeps the line; the thread's own settings did not move
      const msg = await q().query(`SELECT content, parts FROM assistant_messages WHERE id = $1`, [messageId]);
      expect(msg.rows[0].content).toBe("a lighter answer");
      expect(msg.rows[0].parts).toContainEqual(expect.objectContaining({ type: "turn_budget", kind: "allowance" }));
      const t = await q().query(`SELECT brain_provider, brain_tier, hermes_session_id FROM assistant_threads WHERE id = $1`, [threadId]);
      expect(t.rows[0]).toEqual({ brain_provider: "hermes", brain_tier: null, hermes_session_id: "sess-keep" });

      // the usage row (written after the answer, fire-and-forget) records the tier the gateway applied
      let tier: string | null = null;
      for (let i = 0; i < 50 && tier === null; i++) {
        const r = await q().query(`SELECT tier FROM ai_usage_events WHERE thread_id = $1 ORDER BY occurred_at DESC LIMIT 1`, [threadId]);
        tier = r.rows[0]?.tier ?? null;
        if (tier === null) await sleep(40);
      }
      expect(tier).toBe("fast");
    });

    it("UNSTOPPED: byte for byte today's request, no budget frame, no part", async () => {
      const threadId = await newThread(free, { provider: "hermes", session: "sess-free" });
      const before = gateway.calls.length;
      const { sse, messageId } = await turn(free, threadId, "and tomorrow?");
      expect(sse).not.toContain("event: budget");
      expect(lastPlaceholderParts).toEqual([]);
      const call = gateway.calls[before];
      // exactly the keys and order relayGeneration has always sent: prompt, task, provider, providerSession (no tier)
      expect(call.raw).toBe(JSON.stringify({ prompt: call.body.prompt, task: "chat", provider: "hermes", providerSession: "sess-free" }));
      const msg = await q().query(`SELECT parts FROM assistant_messages WHERE id = $1`, [messageId]);
      expect(JSON.stringify(msg.rows[0].parts)).not.toContain("turn_budget");
    });

    it("UNSTOPPED with a stored tier: the tier is sent as before", async () => {
      const threadId = await newThread(free, { tier: "strong" });
      const before = gateway.calls.length;
      await turn(free, threadId, "strong please");
      expect(gateway.calls[before].raw).toBe(JSON.stringify({ prompt: gateway.calls[before].body.prompt, task: "chat", tier: "strong" }));
    });
  });

  describe("POST assistant/ask", () => {
    it("STOPPED by the allowance: the answer carries turnBudget and the gateway got fast", async () => {
      const before = gateway.calls.length;
      const r = await app.inject({ method: "POST", url: `/api/${A}/assistant/ask`, headers: asUser(stopped), payload: { question: "status?" } });
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json();
      expect(body.ok).toBe(true);
      expect(Object.keys(body.turnBudget).sort()).toEqual(["kind", "resetsAt"]);
      expect(body.turnBudget.kind).toBe("allowance");
      expect(gateway.calls[before].body.tier).toBe("fast");
      const placeholder = await q().query(`SELECT parts FROM assistant_messages WHERE id = $1`, [body.messageId]);
      expect(placeholder.rows[0].parts).toContainEqual(expect.objectContaining({ type: "turn_budget", kind: "allowance" }));
    });

    it("STOPPED by the department: home dv-fe, its ancestor d-web is soft_stop and over its figure", async () => {
      const r = await app.inject({ method: "POST", url: `/api/${A}/assistant/ask`, headers: asUser(deptUser), payload: { question: "status?" } });
      expect(r.statusCode, r.body).toBe(200);
      const tb = r.json().turnBudget;
      expect(tb.kind).toBe("department");
      expect(tb.unitNodeId).toBe("d-web");
      const resets = new Date(tb.resetsAt);
      expect(resets.getUTCDate()).toBe(1);
      expect(resets.getUTCHours()).toBe(0);
    });

    it("a report-mode budget stops nothing (AIP-D7)", async () => {
      await q().query(`UPDATE ai_budgets SET mode = 'report' WHERE tenant_id = $1 AND unit_node_id = 'd-web'`, [A]);
      try {
        const r = await app.inject({ method: "POST", url: `/api/${A}/assistant/ask`, headers: asUser(deptUser), payload: { question: "status?" } });
        expect(r.statusCode, r.body).toBe(200);
        expect(r.json()).not.toHaveProperty("turnBudget");
      } finally {
        await q().query(`UPDATE ai_budgets SET mode = 'soft_stop' WHERE tenant_id = $1 AND unit_node_id = 'd-web'`, [A]);
      }
    });

    it("UNSTOPPED: no turnBudget key at all", async () => {
      const r = await app.inject({ method: "POST", url: `/api/${A}/assistant/ask`, headers: asUser(free), payload: { question: "status?" } });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).not.toHaveProperty("turnBudget");
    });
  });

  // ═════════════════════════════════════════ hand-offs ═════════════════════════════════════════
  describe("hand-offs while stopped", () => {
    const handoff = (owner: string, threadId: string, goal = "give me a status report") =>
      app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${threadId}/handoff`, headers: asUser(owner), payload: { agent: "status-reporter", goal } });

    it("is stored held, says why and when, and the runner is NOT called; listed with its status and never polled", async () => {
      const threadId = await newThread(stopped);
      const goalsBefore = runner.goals.length;
      const r = await handoff(stopped, threadId);
      expect(r.statusCode, r.body).toBe(201);
      const body = r.json();
      expect(body.status).toBe("held");
      expect(body.goalId).toBeNull();
      expect(body.hold.kind).toBe("allowance");
      expect(typeof body.hold.resetsAt).toBe("string");
      expect(runner.goals.length).toBe(goalsBefore);
      expect(await row(body.id)).toMatchObject({ status: "held", goal_id: null, hold_kind: "allowance", hold_unit_node_id: null, goal_text: "give me a status report" });

      const pollsBefore = runner.goalPolls.length;
      const list = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}/handoffs`, headers: asUser(stopped) });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json()).toEqual([expect.objectContaining({ id: body.id, status: "held", goalId: null, holdKind: "allowance" })]);
      expect(runner.goalPolls.length).toBe(pollsBefore);
    });

    it("a department-stopped owner's hand-off names the unit", async () => {
      const threadId = await newThread(deptUser);
      const r = await handoff(deptUser, threadId);
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json().hold).toMatchObject({ kind: "department", unitNodeId: "d-web" });
      expect(await row(r.json().id)).toMatchObject({ status: "held", hold_kind: "department", hold_unit_node_id: "d-web" });
    });

    it("an unstopped owner's hand-off starts at once, as before", async () => {
      const threadId = await newThread(free);
      const goalsBefore = runner.goals.length;
      const r = await handoff(free, threadId);
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json().status).toBe("queued");
      expect(r.json()).not.toHaveProperty("hold");
      expect(runner.goals.length).toBe(goalsBefore + 1);
    });

    it("cancel: the owner cancels a held one (200), a second cancel is 409 not_held, a stranger 403, an unknown id 404", async () => {
      const threadId = await newThread(stopped);
      const id = (await handoff(stopped, threadId, "cancel me")).json().id as string;
      const cancel = (as: string, hid: string) => app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${threadId}/handoffs/${hid}/cancel`, headers: asUser(as) });

      const denied = await cancel(other, id);
      expect(denied.statusCode).toBe(403);
      expect((await row(id)).status).toBe("held");

      const ok = await cancel(stopped, id);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({ id, status: "cancelled", goalId: null });
      expect((await row(id)).status).toBe("cancelled");

      expect((await cancel(stopped, id)).statusCode).toBe(409);
      expect((await cancel(stopped, randomUUID())).statusCode).toBe(404);
      expect((await cancel(stopped, "not-a-uuid")).statusCode).toBe(404);

      // a cancelled hand-off is never started by a release (even one told every owner is free)
      const goalsBefore = runner.goals.length;
      await releaseHeldHandoffs(A, {}, { state: async () => ({ stopped: false }) });
      expect(runner.goals.slice(goalsBefore).some((g) => g.goal === "cancel me")).toBe(false);
      expect((await row(id)).status).toBe("cancelled");
    });

    it("cancel refuses a hand-off that already started (409)", async () => {
      const threadId = await newThread(free);
      const id = (await handoff(free, threadId)).json().id as string;
      const r = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${threadId}/handoffs/${id}/cancel`, headers: asUser(free) });
      expect(r.statusCode).toBe(409);
    });
  });

  describe("release", () => {
    it("the job starts a held hand-off once its owner is no longer stopped, posted exactly as a fresh one; a still-stopped owner's stays held", async () => {
      const tStopped = await newThread(stopped);
      const stillHeldId = (await app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${tStopped}/handoff`, headers: asUser(stopped), payload: { agent: "status-reporter", goal: "wait for me" } })).json().id as string;
      const tDept = await newThread(deptUser);
      const toStart = (await app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${tDept}/handoff`, headers: asUser(deptUser), payload: { agent: "status-reporter", goal: "start me later" } })).json().id as string;

      // deptUser's stop ends: the department's figure is raised above the spend. `stopped` is still over its allowance.
      await q().query(`UPDATE ai_budgets SET monthly_usd = 100 WHERE tenant_id = $1 AND unit_node_id = 'd-web'`, [A]);
      try {
        const goalsBefore = runner.goals.length;
        const r = await runUsageAlertsSweep(new Date(), { runCompany: async () => ({ budgetNotices: 0, runawayNotices: 0 }) });
        expect(r.skippedLocked).toBe(false);
        expect(r.handoffsReleased).toBeGreaterThanOrEqual(1);

        const posted = runner.goals.slice(goalsBefore).filter((g) => g.goal === "start me later");
        expect(posted.length).toBe(1);
        expect(posted[0]).toEqual({
          tenantId: A, goal: "start me later", agent: "status-reporter",
          envelope: { provider: "platform", externalId: deptUser }, requestedBy: deptUser, fileOnSuspend: false,
        });
        expect(runner.goals.slice(goalsBefore).some((g) => g.goal === "wait for me")).toBe(false);
        const started = await row(toStart);
        expect(started.status).toBe("queued");
        expect(started.goal_id).toMatch(/^[0-9a-f-]{36}$/);
        expect(started.hold_kind).toBe("department"); // the record of the wait is kept
        expect((await row(stillHeldId)).status).toBe("held");

        // a second sweep posts nothing more
        const again = runner.goals.length;
        await runUsageAlertsSweep(new Date(), { runCompany: async () => ({ budgetNotices: 0, runawayNotices: 0 }) });
        expect(runner.goals.slice(again).filter((g) => g.goal === "start me later" || g.goal === "wait for me")).toEqual([]);
      } finally {
        await q().query(`UPDATE ai_budgets SET monthly_usd = 1 WHERE tenant_id = $1 AND unit_node_id = 'd-web'`, [A]);
      }
    });

    it("two releases racing post the goal ONCE (the claim is a conditional UPDATE from held)", async () => {
      const threadId = await newThread(stopped);
      const id = (await app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${threadId}/handoff`, headers: asUser(stopped), payload: { agent: "status-reporter", goal: "race me" } })).json().id as string;
      runner.postDelayMs.v = 300; // the first claimer holds its row lock across a slow post
      const free_ = async () => ({ stopped: false as const });
      const before = runner.goals.length;
      const [a, b] = await Promise.all([releaseHeldHandoffs(A, {}, { state: free_ }), releaseHeldHandoffs(A, {}, { state: free_ })]);
      expect(runner.goals.slice(before).filter((g) => g.goal === "race me").length).toBe(1);
      expect(a.errors + b.errors).toBe(0);
      expect((await row(id)).status).toBe("queued");
    });

    it("a release that cannot read the owner's state keeps the hand-off held (it never starts one by accident)", async () => {
      const threadId = await newThread(stopped);
      const id = (await app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${threadId}/handoff`, headers: asUser(stopped), payload: { agent: "status-reporter", goal: "keep me" } })).json().id as string;
      const before = runner.goals.length;
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const r = await releaseHeldHandoffs(A, {}, { state: async () => { throw new Error("db down"); } });
      err.mockRestore();
      expect(r.errors).toBeGreaterThan(0);
      expect(r.started).toBe(0);
      expect(runner.goals.length).toBe(before);
      expect((await row(id)).status).toBe("held");
    });
  });

  // ═════════════════════════════════════════ the migration, live ═════════════════════════════════════════
  describe("the status CHECK and the hold CHECKs, on the live table", () => {
    it("every old status plus held is accepted; anything else, a held row with no reason, and a goal-less unheld row are refused", async () => {
      const threadId = await newThread(free);
      const ins = (status: string, over: { goal?: string | null; kind?: string | null; unit?: string | null; heldAt?: boolean } = {}) =>
        q().query(
          `INSERT INTO assistant_handoffs (id, tenant_id, thread_id, owner_user_id, agent, goal_text, goal_id, status, hold_kind, hold_unit_node_id, held_at, origin_site)
           VALUES ($1, $2, $3, $4, 'status-reporter', 'g', $5, $6, $7, $8, CASE WHEN $9 THEN now() END, $10)`,
          [randomUUID(), A, threadId, free, over.goal === undefined ? randomUUID() : over.goal, status, over.kind ?? null, over.unit ?? null, over.heldAt ?? false, config.originSite],
        );
      for (const s of ["queued", "running", "ok", "suspended", "budget_exhausted", "failed", "interrupted", "cancelled"]) await ins(s);
      await ins("held", { goal: null, kind: "allowance", heldAt: true });
      await ins("held", { goal: null, kind: "department", unit: "d-web", heldAt: true });
      await ins("cancelled", { goal: null, kind: "allowance", heldAt: true });
      await ins("failed", { goal: null, kind: "department", unit: "d-web", heldAt: true });
      await expect(ins("bogus")).rejects.toThrow(/check constraint/i);
      await expect(ins("held", { goal: null })).rejects.toThrow(/check constraint/i);
      await expect(ins("queued", { goal: null })).rejects.toThrow(/check constraint/i);
      await expect(ins("ok", { goal: null, kind: "allowance", heldAt: true })).rejects.toThrow(/check constraint/i);
      await expect(ins("held", { goal: null, kind: "department", heldAt: true })).rejects.toThrow(/check constraint/i); // no unit
      await expect(ins("held", { goal: null, kind: "allowance", unit: "d-web", heldAt: true })).rejects.toThrow(/check constraint/i);
      await expect(ins("held", { goal: null, kind: "allowance" })).rejects.toThrow(/check constraint/i); // no held_at
      await expect(ins("held", { goal: null, kind: "anything", heldAt: true })).rejects.toThrow(/check constraint/i);
    });
  });
});
