// Knowledge source review proxy (§7) — the platform authorizes then proxies the write to the
// knowledge service (stubbed here). Against live Postgres + RLS + Cerbos.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { withGlobal } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("knowledge review proxy (§7)", () => {
  let app: NestFastifyApplication;
  let stub: Server;
  let lastBody: unknown;
  let tenant: string;
  let admin: string;
  let member: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    tenant = await createCompany("Agency A", ["agency", "knowledge"]);
    admin = await createUser("admin@a.test");
    member = await createUser("mem@a.test");
    await addMembership(tenant, admin);
    await addMembership(tenant, member);
    await grantRole(admin, await createRole("company_admin"), "company", tenant);
    await grantRole(member, await createRole("member"), "company", tenant);

    const { server, base } = await new Promise<{ server: Server; base: string }>((resolve) => {
      const s = createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          if (/\/sources\/.*\/review$/.test(req.url ?? "") && req.method === "POST") {
            lastBody = JSON.parse(raw || "{}");
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, updated: 3 }));
          } else {
            res.writeHead(404);
            res.end("{}");
          }
        });
      });
      s.listen(0, "127.0.0.1", () => resolve({ server: s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` }));
    });
    stub = server;
    config.services.knowledge = { url: base, token: "k-token" };
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await new Promise<void>((r) => stub.close(() => r()));
    await teardownTestDb();
  });

  it("admin review proxies decision to the knowledge service", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${tenant}/knowledge/sources/${encodeURIComponent("drive://folder/doc")}/review`,
      headers: asUser(admin), payload: { decision: "approved" },
    });
    expect(r.statusCode).toBe(200);
    expect(lastBody).toMatchObject({ tenantId: tenant, decision: "approved" });
  });

  it("invalid decision → 400; non-admin → 403", async () => {
    expect((await app.inject({ method: "POST", url: `/api/${tenant}/knowledge/sources/x/review`, headers: asUser(admin), payload: { decision: "maybe" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/${tenant}/knowledge/sources/x/review`, headers: asUser(member), payload: { decision: "approved" } })).statusCode).toBe(403);
  });

  it("unconfigured knowledge service → 404 (UI degrades to 'pending')", async () => {
    const prev = config.services.knowledge;
    config.services.knowledge = { url: "", token: "" };
    const r = await app.inject({ method: "POST", url: `/api/${tenant}/knowledge/sources/x/review`, headers: asUser(admin), payload: { decision: "rejected" } });
    expect(r.statusCode).toBe(404);
    config.services.knowledge = prev;
  });
});

// B3 (erp-whatsapp-and-agent-runtime-e2e.md §3.3): agent goals proxy in front of the
// agent-runner (B1). Stubs the runner's /goals, /goals/:id, /runs/:id; asserts the reshape,
// the elevated-only gates, the platform self-link upsert, and that a body-supplied
// externalId/provider is ignored (envelope always uses the session userId).
describe.skipIf(!TEST_URL)("agent goals proxy (B3)", () => {
  let app: NestFastifyApplication;
  let stub: Server;
  let tenant: string;
  let admin: string;
  let member: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mutated from an async HTTP
  // callback; TS's control-flow narrowing can't see through that, so a precise optional type
  // here fights the narrower (spuriously narrows to `never` at some call sites).
  let lastPostBody: any;

  function startStub(): Promise<{ server: Server; base: string }> {
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        if (req.method === "POST" && url === "/goals") {
          lastPostBody = raw ? JSON.parse(raw) : {};
          return send(202, { id: "goal-new", status: "queued" });
        }
        if (req.method === "GET" && url.startsWith("/goals?")) {
          return send(200, {
            goals: [
              {
                id: "goal-1", goal: "summarize the drive", agent: "supervisor", status: "ok",
                outcome: "done", errorKind: null, approvalId: null,
                modelCalls: 3, toolCalls: 2, fanOut: 2, budget: { modelCalls: 10, toolCalls: 10 },
                createdAt: "2026-07-24T00:00:00Z", startedAt: "2026-07-24T00:00:01Z", endedAt: "2026-07-24T00:00:05Z",
              },
            ],
          });
        }
        if (req.method === "GET" && url.startsWith("/goals/goal-1")) {
          return send(200, {
            id: "goal-1", goal: "summarize the drive", agent: "supervisor", status: "ok",
            outcome: "done", errorKind: null, approvalId: null,
            modelCalls: 3, toolCalls: 2, fanOut: 2, budget: { modelCalls: 10, toolCalls: 10 },
            createdAt: "2026-07-24T00:00:00Z", startedAt: "2026-07-24T00:00:01Z", endedAt: "2026-07-24T00:00:05Z",
            blackboard: [{ specialist: "researcher", task: "find docs", status: "ok", summary: "found 3 docs" }],
            runs: [{ runId: "run-1", agent: "researcher", status: "ok", outcome: "found 3 docs", modelCalls: 2, toolCalls: 1, provider: "gemini", startedAt: 1, endedAt: 2 }],
          });
        }
        if (req.method === "GET" && url.startsWith("/goals/missing")) {
          return send(404, { error: "goal not found" });
        }
        if (req.method === "GET" && url.startsWith("/runs/run-1")) {
          return send(200, {
            runId: "run-1", goalId: "goal-1", agent: "researcher", status: "ok", outcome: "found 3 docs",
            steps: [{ kind: "model", detail: "planned" }, { kind: "tool", detail: "search ok" }],
            modelCalls: 2, toolCalls: 1, toolsCalled: ["search"], provider: "gemini", startedAt: 1, endedAt: 2,
          });
        }
        return send(404, { error: "not found" });
      });
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as AddressInfo).port;
        resolve({ server, base: `http://127.0.0.1:${port}` });
      });
    });
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    const { server, base } = await startStub();
    stub = server;
    config.services.agents = { url: base, token: "runner-token" };

    tenant = await createCompany("Agency B3", ["agency"]);
    admin = await createUser("admin-b3@a.test");
    member = await createUser("member-b3@a.test");
    await addMembership(tenant, admin);
    await addMembership(tenant, member);
    await grantRole(admin, await createRole("platform_admin"), "global", null);
    await grantRole(member, await createRole("member"), "company", tenant);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await new Promise<void>((r) => stub.close(() => r()));
    await teardownTestDb();
  });

  it("goal list reshapes budgetSpent/budgetTotal/fanOut + additive fields", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${tenant}/agents/goals`, headers: asUser(member) });
    expect(r.statusCode).toBe(200);
    const goals = r.json() as Array<Record<string, unknown>>;
    expect(goals).toEqual([
      {
        id: "goal-1", goal: "summarize the drive", status: "ok",
        budgetSpent: 5, budgetTotal: 20, fanOut: 2,
        agent: "supervisor", createdAt: "2026-07-24T00:00:00Z", endedAt: "2026-07-24T00:00:05Z",
        errorKind: null, approvalId: null,
      },
    ]);
  });

  it("goal detail reshapes + carries blackboard/runs; unknown goal -> 404", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${tenant}/agents/goals/goal-1`, headers: asUser(member) });
    expect(r.statusCode).toBe(200);
    const g = r.json() as { budgetSpent: number; blackboard: unknown[]; runs: unknown[] };
    expect(g.budgetSpent).toBe(5);
    expect(g.blackboard).toEqual([{ specialist: "researcher", task: "find docs", status: "ok", summary: "found 3 docs" }]);
    expect(g.runs).toHaveLength(1);

    const missing = await app.inject({ method: "GET", url: `/api/${tenant}/agents/goals/missing`, headers: asUser(member) });
    expect(missing.statusCode).toBe(404);
  });

  it("run transcript is elevated-only", async () => {
    const forbidden = await app.inject({ method: "GET", url: `/api/${tenant}/agents/runs/run-1`, headers: asUser(member) });
    expect(forbidden.statusCode).toBe(403);

    const r = await app.inject({ method: "GET", url: `/api/${tenant}/agents/runs/run-1`, headers: asUser(admin) });
    expect(r.statusCode).toBe(200);
    const run = r.json() as { steps: Array<{ kind: string; detail: string }> };
    expect(run.steps).toEqual([{ kind: "model", detail: "planned" }, { kind: "tool", detail: "search ok" }]);
  });

  it("trigger is elevated-only", async () => {
    const forbidden = await app.inject({
      method: "POST", url: `/api/${tenant}/agents/goals`, headers: asUser(member), payload: { goal: "do a thing" },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("trigger upserts the platform self-link pinned to the session user and sends the OBO envelope + 202 passthrough", async () => {
    lastPostBody = undefined;
    const r = await app.inject({
      method: "POST", url: `/api/${tenant}/agents/goals`, headers: asUser(admin), payload: { goal: "summarize the drive", agent: "supervisor" },
    });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ id: "goal-new", status: "queued" });
    expect(lastPostBody).toMatchObject({
      tenantId: tenant, goal: "summarize the drive", agent: "supervisor",
      envelope: { provider: "platform", externalId: admin }, requestedBy: admin,
    });

    const link = await withGlobal((c) =>
      c.query<{ user_id: string; external_id: string; verified_at: string | null }>(
        `SELECT user_id, external_id, verified_at FROM identity_links WHERE provider = 'platform' AND external_id = $1`,
        [admin],
      ),
    );
    expect(link.rows).toHaveLength(1);
    expect(link.rows[0]).toMatchObject({ user_id: admin, external_id: admin });
    expect(link.rows[0].verified_at).toBeTruthy();
  });

  it("self-link upsert is idempotent across repeated triggers (ON CONFLICT DO NOTHING, no duplicate/blowup)", async () => {
    await app.inject({ method: "POST", url: `/api/${tenant}/agents/goals`, headers: asUser(admin), payload: { goal: "again" } });
    await app.inject({ method: "POST", url: `/api/${tenant}/agents/goals`, headers: asUser(admin), payload: { goal: "again" } });
    const link = await withGlobal((c) =>
      c.query(`SELECT id FROM identity_links WHERE provider = 'platform' AND external_id = $1`, [admin]),
    );
    expect(link.rows).toHaveLength(1);
  });

  it("NEGATIVE: a body-supplied externalId/provider is ignored — envelope + self-link always use the session userId", async () => {
    lastPostBody = undefined;
    const r = await app.inject({
      method: "POST",
      url: `/api/${tenant}/agents/goals`,
      headers: asUser(admin),
      payload: {
        goal: "spoof attempt",
        // Attempted spoof: a different user's id, and a non-platform provider. Neither reaches
        // the runner call nor the self-link upsert — the handler never reads these fields.
        externalId: member,
        provider: "whatsapp",
        envelope: { provider: "whatsapp", externalId: member },
      },
    });
    expect(r.statusCode).toBe(202);
    expect(lastPostBody?.envelope).toEqual({ provider: "platform", externalId: admin });
    expect(lastPostBody?.envelope?.externalId).not.toBe(member);

    // No self-link was minted for the spoofed identity.
    const spoofed = await withGlobal((c) =>
      c.query(`SELECT 1 FROM identity_links WHERE provider = $1 AND external_id = $2`, ["whatsapp", member]),
    );
    expect(spoofed.rows).toHaveLength(0);
  });

  it("degrades to [] when AGENTS_URL is unconfigured; trigger 503s", async () => {
    const prev = config.services.agents;
    config.services.agents = { url: "", token: "" };

    const goals = await app.inject({ method: "GET", url: `/api/${tenant}/agents/goals`, headers: asUser(member) });
    expect(goals.statusCode).toBe(200);
    expect(goals.json()).toEqual([]);

    const trigger = await app.inject({
      method: "POST", url: `/api/${tenant}/agents/goals`, headers: asUser(admin), payload: { goal: "x" },
    });
    expect(trigger.statusCode).toBe(503);

    config.services.agents = prev;
  });
});
