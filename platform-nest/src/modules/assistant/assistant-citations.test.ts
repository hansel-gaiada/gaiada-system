// ASST-18 — knowledge citations: RAG retrieval renders citation chips, and every rendered chip
// RESOLVES to a real destination — "a chip that 404s is worse than no chip" (the ticket's own bar).
//
// Ticket: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md ("### ASST-18").
// Design: docs/blueprints/assistant-foundation.md §8.
//
// Two halves:
//   (1) `resolveCitation` / `GET .../assistant/citations/:sourceRef` against real rows — proves the
//       resolvable kinds resolve, a deleted/unknown/cross-tenant ref does NOT (honest 404, never a
//       fabricated link), exactly mirroring erp-source.ts's own `erp:<kind>:<id>` convention.
//   (2) End to end: a fake knowledge service returns a hit whose `sourceRef` names a REAL row in
//       THIS tenant; the assistant's context assembly picks it up, the stream emits a `citations`
//       frame carrying that exact ref, the persisted message's `parts` carries the same fact on
//       reload, and the citations endpoint resolves it to that row's real href. This is the
//       grounding-to-chip-to-resolution pipeline in one run, not three separate leaps of faith.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { assistantModule } from "./index";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

interface FakeHub { url: string; close: () => Promise<void> }
async function startFakeHub(visible: string[]): Promise<FakeHub> {
  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/mcp") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: visible.map((n) => ({ name: n, description: n })) } }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

interface FakeRunner { url: string; close: () => Promise<void> }
/** A minimal `TOOLRUN_OK`-only double — just enough for `runToolTurn` to reach `done` so the
 *  controller finalizes the message and this file can assert on the persisted `parts`. */
async function startFakeRunner(): Promise<FakeRunner> {
  const goals = new Map<string, boolean>();
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
        const id = newId();
        goals.set(id, true);
        void raw; // the goal text is irrelevant to this fake
        json(202, { id, status: "queued" });
      });
      return;
    }
    const goalMatch = /^\/goals\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && goalMatch && goals.has(goalMatch[1])) {
      return json(200, {
        id: goalMatch[1], status: "ok", outcome: "Status report: nothing to see here.", errorKind: null, approvalId: null,
        runs: [{ runId: `run-${goalMatch[1]}`, status: "ok", provider: "echo", startedAt: Date.now() - 5, endedAt: Date.now() }],
      });
    }
    const runMatch = /^\/runs\/run-([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && runMatch && goals.has(runMatch[1])) {
      return json(200, { runId: url.pathname, provider: "echo", steps: [], startedAt: Date.now() - 5, endedAt: Date.now() });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

interface FakeKnowledge { url: string; close: () => Promise<void>; hits: Array<{ sourceRef: string; text: string; score: number }> }
async function startFakeKnowledge(): Promise<FakeKnowledge> {
  const state: FakeKnowledge = { url: "", close: async () => {}, hits: [] };
  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/search") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hits: state.hits }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  state.url = `http://127.0.0.1:${addr.port}`;
  state.close = () => new Promise<void>((r) => server.close(() => r()));
  return state;
}

describe.skipIf(!TEST_URL)("Assistant knowledge citations (ASST-18) — live PG + Cerbos", () => {
  let app: NestFastifyApplication;
  let hub: FakeHub;
  let runner: FakeRunner;
  let knowledge: FakeKnowledge;
  let A: string;
  let B: string; // a second tenant — the cross-tenant ref-forgery probe
  let owner: string;
  let clientId: string;
  let projectId: string;
  let taskId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(assistantModule);

    A = await createCompany("Citations Tenant A", ["assistant"]);
    B = await createCompany("Citations Tenant B", ["assistant"]);
    owner = await createUser("owner@asst-cite.test");
    await addMembership(A, owner);
    await addMembership(B, owner);
    const memberRole = await createRole("member");
    await grantRole(owner, memberRole, "company", A);
    await grantRole(owner, memberRole, "company", B);

    clientId = newId();
    await withTenants(
      [A],
      (c) => c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,$3,$4)`, [clientId, A, "Acme Corp", config.originSite]),
    );
    projectId = await createProject(A, "Acme Rebuild");
    taskId = newId();
    await withTenants(
      [A],
      (c) => c.query(
        `INSERT INTO tasks (id, tenant_id, project_id, title, origin_site) VALUES ($1,$2,$3,$4,$5)`,
        [taskId, A, projectId, "Migrate DNS", config.originSite],
      ),
    );

    hub = await startFakeHub(["projects.list", "tasks.list"]);
    runner = await startFakeRunner();
    knowledge = await startFakeKnowledge();
    config.services.hub = { url: hub.url, token: "hub-token" };
    config.services.agents = { url: runner.url, token: "runner-token" };
    config.services.knowledge = { url: knowledge.url, token: "knowledge-token" };
    config.services.gateway = { url: "", token: "" }; // the tool-turn path never touches this

    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app.close();
    await hub.close();
    await runner.close();
    await knowledge.close();
    await teardownTestDb();
  });

  // ── HALF 1: resolution against real rows ──────────────────────────────────────────────────────
  async function resolve(tenantId: string, sourceRef: string) {
    return app.inject({ method: "GET", url: `/api/${tenantId}/assistant/citations/${encodeURIComponent(sourceRef)}`, headers: asUser(owner) });
  }

  it("resolves a client/project/task ref to that row's real href", async () => {
    const client = await resolve(A, `erp:client:${clientId}`);
    expect(client.statusCode).toBe(200);
    expect(client.json()).toEqual({ kind: "client", label: "Acme Corp", href: `/clients/${clientId}` });

    const project = await resolve(A, `erp:project:${projectId}`);
    expect(project.statusCode).toBe(200);
    expect(project.json()).toEqual({ kind: "project", label: "Acme Rebuild", href: `/projects/${projectId}` });

    const task = await resolve(A, `erp:task:${taskId}`);
    expect(task.statusCode).toBe(200);
    expect(task.json()).toEqual({ kind: "task", label: "Migrate DNS", href: `/tasks/${taskId}` });
  });

  it("a chip that would 404 NEVER resolves — deleted row, unknown kind, malformed ref, and a cross-tenant ref forgery all 404", async () => {
    // Deleted row: still a real uuid, but the entity is gone.
    const goneId = newId();
    await withTenants([A], (c) => c.query(`INSERT INTO clients (id, tenant_id, name, deleted_at, origin_site) VALUES ($1,$2,$3,now(),$4)`, [goneId, A, "Gone Co", config.originSite]));
    expect((await resolve(A, `erp:client:${goneId}`)).statusCode).toBe(404);

    // Unknown kind (report/file — this file deliberately does not resolve them, see citations.ts).
    expect((await resolve(A, `erp:report:person:${A}`)).statusCode).toBe(404);
    expect((await resolve(A, `erp:file:${newId()}`)).statusCode).toBe(404);

    // Malformed ref.
    expect((await resolve(A, "not-a-source-ref"))).toMatchObject({ statusCode: 404 });

    // A ref for a REAL client, but resolved under a DIFFERENT tenant's route — RLS alone would
    // already return zero rows; asserted here as a 404 (never a 200 leaking existence/label).
    expect((await resolve(B, `erp:client:${clientId}`)).statusCode).toBe(404);
  });

  it("a person/org ref whose EMBEDDED tenant doesn't match the route tenant 404s, even though both tenants are real", async () => {
    // erp-source.ts's own person ref shape: erp:person:<tenantId>:<userId>. Forge one naming
    // tenant A's id while resolving it under tenant B's route.
    expect((await resolve(B, `erp:person:${A}:${owner}`)).statusCode).toBe(404);
    // The org ref forged the same way.
    expect((await resolve(B, `erp:org:${A}`)).statusCode).toBe(404);
  });

  // ── HALF 2: the RAG-to-chip-to-resolution pipeline, live ──────────────────────────────────────
  it("a knowledge-grounded turn EMITS its citations on the wire, PERSISTS them for reload, and every emitted chip RESOLVES", async () => {
    // The fake knowledge service returns a hit naming this run's REAL project row.
    knowledge.hits = [{ sourceRef: `erp:project:${projectId}`, text: "Project: Acme Rebuild / Status: active", score: 0.91 }];

    const created = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads`, headers: asUser(owner), payload: { title: "grounded" } });
    expect(created.statusCode).toBe(201);
    const threadId = created.json().id as string;

    const sent = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads/${threadId}/messages`, headers: asUser(owner),
      payload: { content: "what's the status of the Acme rebuild?", mode: "tools" },
    });
    expect(sent.statusCode).toBe(201);
    const { messageId, streamUrl } = sent.json() as { messageId: string; streamUrl: string };

    const port = (app.getHttpServer().address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}${streamUrl}`, { headers: asUser(owner) });
    expect(res.status).toBe(200);
    const body = await res.text();

    // (a) The citations frame is on the wire, carries the real sourceRef, and arrives BEFORE done.
    expect(body).toContain("event: citations");
    expect(body).toContain(`erp:project:${projectId}`);
    expect(body).toContain("event: done");
    expect(body.indexOf("event: citations")).toBeLessThan(body.indexOf("event: done"));

    // (b) Persisted for reload — the SAME fact survives in the message's `parts`, not just the
    // live stream.
    const got = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(owner) });
    const msgs = (got.json() as { messages: Array<{ id: string; parts: unknown }> }).messages;
    const reply = msgs.find((m) => m.id === messageId);
    const citationsPart = (reply?.parts as Array<{ type: string; items?: Array<{ sourceRef: string }> }> | null)?.find((p) => p.type === "citations");
    expect(citationsPart?.items?.map((i) => i.sourceRef)).toEqual([`erp:project:${projectId}`]);

    // (c) The chip RESOLVES — this is the bar the ticket sets ("a chip that 404s is worse than no
    // chip"): whatever we emitted must be independently resolvable, not just echoed back.
    const resolved = await resolve(A, citationsPart!.items![0].sourceRef);
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toEqual({ kind: "project", label: "Acme Rebuild", href: `/projects/${projectId}` });
  });

  it("an unreachable/empty-hit knowledge service degrades this turn's grounding, never the turn itself — no citations frame, still a normal `done`", async () => {
    knowledge.hits = []; // this run's fake reports nothing relevant (indistinguishable, by design, from an outage — see context.ts's header)

    const created = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads`, headers: asUser(owner), payload: { title: "no grounding" } });
    const threadId = created.json().id as string;
    const sent = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads/${threadId}/messages`, headers: asUser(owner),
      payload: { content: "anything at all", mode: "tools" },
    });
    const { streamUrl } = sent.json() as { messageId: string; streamUrl: string };
    const port = (app.getHttpServer().address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}${streamUrl}`, { headers: asUser(owner) });
    const body = await res.text();
    expect(body).not.toContain("event: citations");
    expect(body).toContain("event: done");
  });
});
