// M5-G5d — a SUSPENDED `agency_privacy.erase` held by the assistant, against REAL Postgres and REAL Cerbos, over HTTP
// (app.inject + a real listening port for the SSE stream). Proves, with distinctive identifiers, that neither the
// email nor the phone (nor a lower-cased / normalised form) lands in ANY assistant row (messages, tool calls, write
// intents, handoffs), the stream frames, the thread/handoff reads, the approval, the outbox, the activity log, the
// notifications, the DSR ledger or the captured logs; that the confirm chip STILL files the approval; and that after
// a second admin approves, the requester's erase runs against the right lead (the subject is rebuilt from the hashes).
//
// The runner is a scripted HTTP server. It is run twice: handing over the minimised shape (ai-agents >= M5-G5d) and
// handing over the RAW email/phone (an older runner during a rolling deploy): the ERP must hold hashes only either way.
// The person's identifier is never in a goal text or a user message here (the fake runner is keyed by a marker), so
// every assertion is about the INTENT's args, which is what this ticket closes.
//
// Every write runs as `platform_app_test` (NOSUPERUSER NOBYPASSRLS) through the real routes; `adminPool()` only reads
// evidence. Needs DATABASE_URL_TEST (+ CERBOS_URL): the Linux gate. Skips without it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { assistantModule } from "./index";
import { subjectHash } from "../../core/agency-privacy.subject";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

interface Intent { tool: string; impact: string; args: Record<string, unknown> }
interface FakeRunner { url: string; close: () => Promise<void>; intent: Intent | null }

/** A scripted runner: a goal whose text contains PRIVACY suspends with `runner.intent`; anything else answers. */
async function startFakeRunner(): Promise<FakeRunner> {
  const state: FakeRunner = { url: "", close: async () => undefined, intent: null };
  const goals = new Map<string, { goal: string; intent: Intent | null }>();
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "POST" && url.pathname === "/goals") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as { goal?: string };
        const id = newId();
        goals.set(id, { goal: body.goal ?? "", intent: state.intent });
        json(202, { id, status: "queued" });
      });
      return;
    }
    const goalMatch = /^\/goals\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && goalMatch) {
      const g = goals.get(goalMatch[1]);
      if (!g) return json(404, { error: "goal not found" });
      if (g.goal.includes("PRIVACY") && g.intent) {
        return json(200, {
          id: goalMatch[1], status: "suspended", outcome: `suspended awaiting confirmation for ${g.intent.tool} (${g.intent.impact}) — not yet filed`,
          errorKind: "approval_required", approvalId: null, suspendedIntent: g.intent, runs: [],
        });
      }
      return json(200, { id: goalMatch[1], status: "ok", outcome: "Nothing to do.", errorKind: null, approvalId: null, runs: [] });
    }
    if (req.method === "GET" && url.pathname === "/agents") {
      return json(200, {
        agents: [
          { name: "task-filer", tools: ["projects.list", "tasks.list", "pm.createTask", "pm.createDoc"], maxSteps: 8, maxToolCalls: 4, writeCapable: true, evaledProviders: [] },
          { name: "privacy-clerk", tools: ["agency_privacy.erase"], maxSteps: 5, maxToolCalls: 3, writeCapable: true, evaledProviders: [] },
        ],
        supervisor: { name: "supervisor", maxSubRuns: 4, goalBudget: { modelCalls: 20, toolCalls: 20 } },
      });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  state.close = () => new Promise<void>((r) => server.close(() => r()));
  return state;
}

/** A hub that lists the chat agent's tools as visible to everyone and answers tools/call with ok. */
async function startFakeHub(visibleFor: () => string[]): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let method = "";
      try { method = (JSON.parse(raw) as { method?: string }).method ?? ""; } catch { /* ignore */ }
      res.writeHead(200, { "content-type": "application/json" });
      if (method === "tools/call") return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ text: "ok (fake hub)" }] } }));
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: visibleFor().map((name) => ({ name, description: name, inputSchema: { type: "object" } })) } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe.skipIf(!TEST_URL)("M5-G5d — a suspended agency_privacy.erase in the assistant: hashes only in every store, the chip still files, and it runs after a second person approves", () => {
  let app: NestFastifyApplication;
  let port: number;
  let runner: FakeRunner;
  let hub: { url: string; close: () => Promise<void> };
  let A: string;
  let owner: string; // the chatting user and the privacy requester: company_admin, holds `convert`
  let decider: string; // a second company_admin

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(assistantModule);
    A = await createCompany("G5d Privacy Intent", ["assistant"]);
    const adminRole = await createRole("company_admin");
    const mk = async (email: string) => {
      const id = await createUser(email);
      await addMembership(A, id);
      await grantRole(id, adminRole, "company", A);
      return id;
    };
    owner = await mk("owner@g5d-intent.test");
    decider = await mk("decider@g5d-intent.test");

    runner = await startFakeRunner();
    hub = await startFakeHub(() => ["projects.list", "tasks.list", "pm.createTask", "pm.createDoc"]);
    config.services.hub = { url: hub.url, token: "hub-token", assuranceToken: "" };
    config.services.agents = { url: runner.url, token: "runner-token" };
    config.approvalGrantSecret = "g5d-test-secret-not-a-real-one";
    config.services.gateway = { url: "", token: "" };
    config.assistantIntentTtlMs = 60 * 60 * 1000;
    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.getHttpServer().address() as { port: number }).port;
  }, 60000);

  afterAll(async () => {
    await app.close();
    await hub.close();
    await runner.close();
    await teardownTestDb();
  });

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────
  let seq = 0;
  function person() {
    const n = ++seq;
    return {
      name: `Siti Intent${n} Rahayu`,
      email: `Siti.Intent${n}@Dsr-Intent.test`,
      phone: `+62 812 7000 ${String(3000 + n)}`,
      phoneDigits: `628127000${String(3000 + n)}`,
    };
  }
  type Person = ReturnType<typeof person>;
  const forms = (p: Person) => [p.email, p.email.toLowerCase(), p.email.toUpperCase(), `siti.intent${seq}`, p.phone, p.phoneDigits, `+${p.phoneDigits}`, p.phoneDigits.slice(2), `812 7000 ${3000 + seq}`];
  const noLeak = (text: string, p: Person, where: string) => {
    const lower = text.toLowerCase();
    for (const f of forms(p)) expect(lower, `${where}: leaked ${f}`).not.toContain(f.toLowerCase());
  };
  const minimisedFor = (p: Person) => ({
    minimised: "agency-privacy.v1", kind: "erase", identifiers: ["email", "phone"], tenantId: A,
    subject: {
      emailHash: subjectHash(p.email.toLowerCase()), emailHint: "***@dsr-intent.test",
      phoneHash: subjectHash(p.phoneDigits), phoneHint: `***${p.phoneDigits.slice(-2)}`,
    },
  });

  async function insertLead(f: { name: string; email?: string | null; phone?: string | null }): Promise<string> {
    const id = newId();
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO agency_leads (id, tenant_id, org_name, contact_name, contact_email, contact_phone, source, status, stage, origin_site)
         VALUES ($1, $2, 'Org (not given)', $3, $4, $5, 'web', 'new', 'enquiry', 'test')`,
        [id, A, f.name, f.email ?? null, f.phone ?? null],
      ),
    );
    return id;
  }
  const lead = async (id: string) => (await adminPool().query(`SELECT * FROM agency_leads WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;

  /** Every durable place an identifier must NOT land, as one lower-cased text blob. */
  async function dbText(): Promise<string> {
    const q = async (sql: string) => (await adminPool().query<{ t: string }>(sql)).rows.map((r) => r.t).join("\n");
    return (
      await Promise.all([
        q(`SELECT row_to_json(m)::text AS t FROM assistant_messages m`),
        q(`SELECT row_to_json(t)::text AS t FROM assistant_threads t`),
        q(`SELECT row_to_json(c)::text AS t FROM assistant_tool_calls c`),
        q(`SELECT row_to_json(w)::text AS t FROM assistant_write_intents w`),
        q(`SELECT row_to_json(h)::text AS t FROM assistant_handoffs h`),
        q(`SELECT row_to_json(a)::text AS t FROM automation_approvals a`),
        q(`SELECT row_to_json(o)::text AS t FROM outbox_events o`),
        q(`SELECT row_to_json(a)::text AS t FROM activities a`),
        q(`SELECT row_to_json(n)::text AS t FROM notifications n`),
        q(`SELECT row_to_json(d)::text AS t FROM agency_dsr_requests d`),
        q(`SELECT row_to_json(s)::text AS t FROM agency_contact_suppressions s`),
      ])
    ).join("\n").toLowerCase();
  }
  async function withLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string }> {
    const chunks: string[] = [];
    const wrap = (stream: NodeJS.WriteStream) => {
      const orig = stream.write.bind(stream);
      stream.write = ((chunk: unknown, ...rest: unknown[]) => { chunks.push(String(chunk)); return (orig as (...a: unknown[]) => boolean)(chunk, ...rest); }) as never;
      return () => { stream.write = orig as never; };
    };
    const undo = [wrap(process.stdout), wrap(process.stderr)];
    try { return { result: await fn(), logs: chunks.join("").toLowerCase() }; } finally { undo.forEach((u) => u()); }
  }
  async function newThread(title: string): Promise<string> {
    const r = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads`, headers: asUser(owner), payload: { title } });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  }
  async function readStream(streamUrl: string): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}${streamUrl}`, { headers: asUser(owner) });
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) { const { done, value } = await reader.read(); if (done) break; out += decoder.decode(value, { stream: true }); }
    return out;
  }
  const getThread = async (threadId: string) => {
    const r = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(owner) });
    expect(r.statusCode).toBe(200);
    return { body: r.body, json: r.json() as { messages: Array<{ toolCalls: Array<{ id: string; toolName: string; args: unknown; approvalId: string | null; intent: { status: string } | null }> }> } };
  };
  const decide = (user: string, approvalId: string, decision: "approved" | "rejected") =>
    app.inject({ method: "POST", url: `/api/${A}/automation-approvals/${approvalId}/decide`, headers: asUser(user), payload: { decision } });
  const run = (user: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/${A}/agency/privacy/erase`, headers: asUser(user), payload });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // The handoff path (a real roster agent, the REAL /handoff + /handoffs endpoints): harvest -> chip -> confirm
  // -> a second admin approves -> the requester erases by approvalId. Run for both runner generations.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  for (const variant of ["a runner that hands over the minimised shape (ai-agents >= M5-G5d)", "an older runner that hands over the RAW email and phone"] as const) {
    it(`${variant}: draft, chip, confirm, approve and erase hold hashes only, and the right lead is erased`, async () => {
      const p = person();
      const target = await insertLead({ name: p.name, email: p.email.toLowerCase(), phone: p.phone });
      const bystander = await insertLead({ name: "Someone Else", email: `else${seq}@dsr-intent.test` });
      runner.intent = {
        tool: "agency_privacy.erase", impact: "high",
        args: variant.includes("RAW") ? { tenantId: A, email: p.email, phone: p.phone } : minimisedFor(p),
      };

      const threadId = await newThread(`g5d handoff ${seq}`);
      const handoff = await withLogs(async () => {
        const created = await app.inject({
          method: "POST", url: `/api/${A}/assistant/threads/${threadId}/handoff`, headers: asUser(owner),
          payload: { agent: "privacy-clerk", goal: "PRIVACY: handle the pending erasure request" },
        });
        expect(created.statusCode, created.body).toBe(201);
        const list = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}/handoffs`, headers: asUser(owner) });
        expect(list.statusCode).toBe(200);
        return { created: created.body, list: list.body };
      });
      noLeak(handoff.result.created + handoff.result.list, p, "handoff responses");

      // The draft: a chip on the thread, nothing filed yet, and the intent row holds the minimised shape ONLY.
      const thread = await getThread(threadId);
      noLeak(thread.body, p, "thread read");
      const call = thread.json.messages[0].toolCalls[0];
      expect(call).toMatchObject({ toolName: "agency_privacy.erase", approvalId: null, intent: { status: "draft" } });
      const draft = (await adminPool().query(`SELECT tool_args, status FROM assistant_write_intents WHERE tool_call_id = $1`, [call.id])).rows[0];
      expect(draft).toMatchObject({ status: "draft" });
      expect(draft.tool_args).toEqual(minimisedFor(p));
      noLeak(await dbText(), p, "database after the draft");
      noLeak(handoff.logs, p, "logs during the draft");

      // THE CHIP STILL WORKS: confirm files the approval (hashes + hints + the generated reason) and the ledger's filed row.
      const confirmed = await withLogs(() => app.inject({
        method: "POST", url: `/api/${A}/assistant/threads/${threadId}/tool-calls/${call.id}/confirm`, headers: asUser(owner),
      }));
      expect(confirmed.result.statusCode, confirmed.result.body).toBe(200);
      const approvalId = (confirmed.result.json() as { approvalId: string }).approvalId;
      const row = (await adminPool().query(`SELECT * FROM automation_approvals WHERE id = $1`, [approvalId])).rows[0];
      expect(row).toMatchObject({ tool_name: "agency_privacy.erase", status: "pending", requested_by: owner, origin: "agent" });
      expect(row.tool_args).toEqual(minimisedFor(p));
      expect(row.reason).toMatch(/^Privacy request: ERASE the personal data of/);
      noLeak(JSON.stringify(row), p, "approval row");
      const filed = (await adminPool().query(`SELECT phase, kind, email_hash, phone_hash, actor_id FROM agency_dsr_requests WHERE approval_id = $1`, [approvalId])).rows;
      expect(filed).toEqual([{ phase: "filed", kind: "erase", email_hash: subjectHash(p.email.toLowerCase()), phone_hash: subjectHash(p.phoneDigits), actor_id: owner }]);
      expect((await adminPool().query(`SELECT tool_args FROM assistant_write_intents WHERE tool_call_id = $1`, [call.id])).rows[0].tool_args).toBeNull();

      // A second person approves; before that, the requester's run is "awaiting approval".
      const early = await run(owner, { approvalId });
      expect(early.statusCode).toBe(202);
      expect((await lead(target)).contact_email).not.toBeNull();
      const decided = await withLogs(() => decide(decider, approvalId, "approved"));
      expect(decided.result.statusCode, decided.result.body).toBe(200);

      // THE EXECUTION: just the approvalId; the subject is rebuilt from the hashes, the RIGHT lead is erased.
      const exec = await withLogs(() => run(owner, { approvalId }));
      expect(exec.result.statusCode, exec.result.body).toBe(200);
      expect(exec.result.json()).toMatchObject({ outcome: "executed", replayed: false });
      expect(await lead(target)).toMatchObject({ contact_email: null, contact_phone: null, contact_name: null, org_name: "(erased)" });
      expect((await lead(target)).erased_at).not.toBeNull();
      expect((await lead(bystander)).erased_at).toBeNull();
      expect((await lead(bystander)).contact_email).toBe(`else${seq}@dsr-intent.test`);
      expect((await adminPool().query(`SELECT phase FROM agency_dsr_requests WHERE approval_id = $1 ORDER BY created_at`, [approvalId])).rows.map((r) => r.phase)).toEqual(["filed", "executed"]);

      // After everything: no store, no stream, no log line, no read shape ever held an identifier.
      const after = await getThread(threadId);
      noLeak(after.body, p, "thread read after the run");
      noLeak(await dbText(), p, "database after the run");
      noLeak(confirmed.logs + decided.logs + exec.logs, p, "logs");
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // The chat path: the SSE stream the UI receives, and dismiss scrubs the draft.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("chat path: the confirm_required frame, the thread read and the intent row hold no identifier, and dismiss scrubs the draft", async () => {
    const p = person();
    runner.intent = { tool: "agency_privacy.erase", impact: "high", args: { tenantId: A, email: p.email, phone: p.phone } };
    const threadId = await newThread(`g5d chat ${seq}`);
    const sent = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads/${threadId}/messages`, headers: asUser(owner),
      payload: { content: "PRIVACY: handle the pending erasure request", mode: "tools", agent: "task-filer" },
    });
    expect(sent.statusCode).toBe(201);
    const streamed = await withLogs(() => readStream((sent.json() as { streamUrl: string }).streamUrl));
    expect(streamed.result).toContain("event: confirm_required");
    expect(streamed.result).toContain('"toolName":"agency_privacy.erase"');
    noLeak(streamed.result, p, "SSE stream");
    noLeak(streamed.logs, p, "logs");

    const thread = await getThread(threadId);
    noLeak(thread.body, p, "thread read");
    const call = thread.json.messages[1].toolCalls[0];
    expect((await adminPool().query(`SELECT tool_args FROM assistant_write_intents WHERE tool_call_id = $1`, [call.id])).rows[0].tool_args).toEqual(minimisedFor(p));
    noLeak(await dbText(), p, "database after the draft");

    const dismissed = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads/${threadId}/tool-calls/${call.id}/dismiss`, headers: asUser(owner),
    });
    expect(dismissed.statusCode).toBe(200);
    expect((await adminPool().query(`SELECT status, tool_args FROM assistant_write_intents WHERE tool_call_id = $1`, [call.id])).rows[0]).toMatchObject({ status: "dismissed", tool_args: null });
    noLeak(await dbText(), p, "database after dismiss");
  });

  it("chat path: a malformed identifier drafts nothing (no intent row, no chip) and the error carries no value", async () => {
    runner.intent = { tool: "agency_privacy.erase", impact: "high", args: { tenantId: A, email: "this is not an email" } };
    const threadId = await newThread(`g5d invalid ${seq}`);
    const before = (await adminPool().query(`SELECT count(*)::int AS n FROM assistant_write_intents WHERE tenant_id = $1`, [A])).rows[0].n;
    const sent = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads/${threadId}/messages`, headers: asUser(owner),
      payload: { content: "PRIVACY: handle the pending erasure request", mode: "tools", agent: "task-filer" },
    });
    const body = await readStream((sent.json() as { streamUrl: string }).streamUrl);
    expect(body).not.toContain("event: confirm_required");
    expect(body).toContain("intent_invalid");
    expect(body.toLowerCase()).not.toContain("this is not an email");
    expect((await adminPool().query(`SELECT count(*)::int AS n FROM assistant_write_intents WHERE tenant_id = $1`, [A])).rows[0].n).toBe(before);
  });
});
