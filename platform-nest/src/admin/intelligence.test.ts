// Knowledge source review proxy (§7) — the platform authorizes then proxies the write to the
// knowledge service (stubbed here). Against live Postgres + RLS + Cerbos.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withGlobal, withTenants } from "../db";
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
  // ASST-21 — `assistant_handoffs.run_id` is a real `uuid` column (migration 0084), unlike this
  // file's pre-existing human-readable `run-1`/`goal-1` stub ids — computed once, up front, so both
  // the fake server's route match and the DB row + request URL below all agree on the same value
  // regardless of hook ordering (a plain `let` closed over by the server's request handler, read at
  // REQUEST time, not at server-start time).
  const HANDOFF_RUN_ID = newId();

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
        // O4 — `/runs/run-1/events`. Checked BEFORE the bare `/runs/run-1` detail route below:
        // that route matches on `url.startsWith("/runs/run-1")`, which a naive ordering would let
        // swallow `/runs/run-1/events?...` too (it's a string prefix of it). Echoes the `tenant=`
        // query param the controller forwarded so tests can prove tenant scoping isn't
        // hardcoded/lost, and honors `since` exactly like the real runner's `GoalStore.listEvents`
        // (strictly greater than, ascending).
        if (req.method === "GET" && url.startsWith("/runs/run-1/events")) {
          const sinceMatch = /since=(\d+)/.exec(url);
          const since = sinceMatch ? Number(sinceMatch[1]) : 0;
          const tenantMatch = /tenant=([^&]+)/.exec(url);
          const tenantParam = tenantMatch ? decodeURIComponent(tenantMatch[1]) : "";
          // Simulates the runner's own tenant filter (store.ts's `listEvents` is `WHERE tenant_id=$2`):
          // only the tenant these events actually belong to gets any rows back.
          if (tenantParam !== tenant) return send(200, { events: [] });
          const all = [
            { eventId: "e1", runId: "run-1", goalId: "goal-1", seq: 1, ts: "2026-08-23T00:00:01Z", kind: "model", detail: "planned", durationMs: 120, parentRunId: null },
            { eventId: "e2", runId: "run-1", goalId: "goal-1", seq: 2, ts: "2026-08-23T00:00:02Z", kind: "tool", detail: "search ok", durationMs: 300, parentRunId: null },
            { eventId: "e3", runId: "run-1", goalId: "goal-1", seq: 3, ts: "2026-08-23T00:00:03Z", kind: "delegate", detail: "-> researcher", durationMs: null, parentRunId: "run-1" },
          ];
          return send(200, { events: all.filter((e) => e.seq > since) });
        }
        if (req.method === "GET" && url.startsWith("/runs/run-1")) {
          return send(200, {
            runId: "run-1", goalId: "goal-1", agent: "researcher", status: "ok", outcome: "found 3 docs",
            steps: [{ kind: "model", detail: "planned" }, { kind: "tool", detail: "search ok" }],
            modelCalls: 2, toolCalls: 1, toolsCalled: ["search"], provider: "gemini", startedAt: 1, endedAt: 2,
          });
        }
        // ASST-21 — a SEPARATE run id, standing in for a handoff run's transcript. Distinct from
        // "run-1" above on purpose: "run-1" has NO `assistant_handoffs` row anywhere in this suite,
        // which is exactly what keeps it proving the UNCHANGED elevated-only path; this one gets a
        // handoff row inserted by the ASST-21 tests below, so the two can never be confused.
        //
        // Same ordering rule as above: `/events` checked BEFORE the bare run-detail route.
        if (req.method === "GET" && url.startsWith(`/runs/${HANDOFF_RUN_ID}/events`)) {
          const sinceMatch = /since=(\d+)/.exec(url);
          const since = sinceMatch ? Number(sinceMatch[1]) : 0;
          const all = [
            { eventId: "he1", runId: HANDOFF_RUN_ID, goalId: "goal-handoff-1", seq: 1, ts: "2026-08-23T00:00:01Z", kind: "tool", detail: "projects.list ok", durationMs: 80, parentRunId: null },
          ];
          return send(200, { events: all.filter((e) => e.seq > since) });
        }
        if (req.method === "GET" && url.startsWith(`/runs/${HANDOFF_RUN_ID}`)) {
          return send(200, {
            runId: HANDOFF_RUN_ID, goalId: "goal-handoff-1", agent: "status-reporter", status: "ok",
            outcome: "1 project, 0 tasks", steps: [{ kind: "tool", detail: "projects.list ok" }],
            modelCalls: 1, toolCalls: 1, toolsCalled: ["projects.list"], provider: "echo", startedAt: 1, endedAt: 2,
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

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // O4 — run events proxy (the office canvas's backend data path). Same elevated-only gate as the
  // run transcript above (reused, not reimplemented); whitelisted reshape; the `since` cursor.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("O4: run events proxy", () => {
    it("is elevated-only, like the run transcript", async () => {
      const forbidden = await app.inject({ method: "GET", url: `/api/${tenant}/agents/runs/run-1/events`, headers: asUser(member) });
      expect(forbidden.statusCode).toBe(403);

      const r = await app.inject({ method: "GET", url: `/api/${tenant}/agents/runs/run-1/events`, headers: asUser(admin) });
      expect(r.statusCode).toBe(200);
    });

    it("reshapes the runner's event rows to the whitelisted shape, ordered, with the delegation edge", async () => {
      const r = await app.inject({ method: "GET", url: `/api/${tenant}/agents/runs/run-1/events`, headers: asUser(admin) });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { events: Array<Record<string, unknown>> };
      expect(body.events).toEqual([
        { eventId: "e1", runId: "run-1", goalId: "goal-1", seq: 1, ts: "2026-08-23T00:00:01Z", kind: "model", detail: "planned", durationMs: 120, parentRunId: null },
        { eventId: "e2", runId: "run-1", goalId: "goal-1", seq: 2, ts: "2026-08-23T00:00:02Z", kind: "tool", detail: "search ok", durationMs: 300, parentRunId: null },
        { eventId: "e3", runId: "run-1", goalId: "goal-1", seq: 3, ts: "2026-08-23T00:00:03Z", kind: "delegate", detail: "-> researcher", durationMs: null, parentRunId: "run-1" },
      ]);
      // No `tenantId` field leaks through — reshapeEvent whitelists it out like every other
      // reshape in this file.
      expect(body.events[0]).not.toHaveProperty("tenantId");
    });

    it("the `since` cursor: since=0 returns everything, since=<last seq> returns only what's newer", async () => {
      const first = await app.inject({ method: "GET", url: `/api/${tenant}/agents/runs/run-1/events?since=0`, headers: asUser(admin) });
      expect(first.statusCode).toBe(200);
      const firstBody = first.json() as { events: Array<{ seq: number }> };
      expect(firstBody.events.map((e) => e.seq)).toEqual([1, 2, 3]);
      const lastSeq = firstBody.events[firstBody.events.length - 1].seq;

      const second = await app.inject({ method: "GET", url: `/api/${tenant}/agents/runs/run-1/events?since=${lastSeq}`, headers: asUser(admin) });
      expect(second.statusCode).toBe(200);
      const secondBody = second.json() as { events: Array<{ seq: number }> };
      expect(secondBody.events).toEqual([]); // nothing newer than the cursor the caller already has

      const middle = await app.inject({ method: "GET", url: `/api/${tenant}/agents/runs/run-1/events?since=1`, headers: asUser(admin) });
      expect((middle.json() as { events: Array<{ seq: number }> }).events.map((e) => e.seq)).toEqual([2, 3]);
    });

    it("tenant scoping: the route's tenantId is forwarded to the runner, not hardcoded or dropped — a different tenant sees no rows for the same runId", async () => {
      const otherTenant = await createCompany("Agency B3-Other", ["agency"]);
      // `admin` is platform_admin @ global, so the elevated gate itself does not discriminate by
      // tenant — this proves scoping happens where it must: the `tenant=` query param the
      // controller sends to the runner, which the stub above echoes back against.
      const r = await app.inject({ method: "GET", url: `/api/${otherTenant}/agents/runs/run-1/events`, headers: asUser(admin) });
      expect(r.statusCode).toBe(200);
      expect((r.json() as { events: unknown[] }).events).toEqual([]);
    });

    it("degrades to { events: [] } when AGENTS_URL is unconfigured", async () => {
      const prev = config.services.agents;
      config.services.agents = { url: "", token: "" };
      const r = await app.inject({ method: "GET", url: `/api/${tenant}/agents/runs/run-1/events`, headers: asUser(admin) });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ events: [] });
      config.services.agents = prev;
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // ASST-21 — the additive handoff-owner carve-out, and its regression guard.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Design: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md ("### ASST-21").
  // `run-1` above has NO `assistant_handoffs` row anywhere in this file, so the "run transcript is
  // elevated-only" test just above is ALREADY the regression guard: it exercises the EXACT SAME
  // `isElevated(req)` line this ticket's edit wraps, with a non-elevated `member` still 403ing and
  // `admin` (platform_admin @ global) still 200ing, completely unchanged. The tests below add the
  // NEW owner-scoped allow path for a DIFFERENT runId that a real handoff links — a member who is
  // this specific handoff's owner, a different member who is not, and `company_admin` (deliberately
  // NOT elevated — `admin/elevated.ts` only recognizes platform_admin/group_executive @ global) all
  // hit the SAME `/agents/runs/:runId` route the regression test above already covers.
  describe("ASST-21: handoff-owner additive carve-out", () => {
    let owner: string;
    let sameCompanyOther: string;
    let companyAdmin: string;

    beforeAll(async () => {
      owner = await createUser("handoff-owner@a.test");
      sameCompanyOther = await createUser("handoff-other@a.test");
      companyAdmin = await createUser("handoff-admin@a.test");
      await addMembership(tenant, owner);
      await addMembership(tenant, sameCompanyOther);
      await addMembership(tenant, companyAdmin);
      const memberRole = await createRole("member");
      const companyAdminRole = await createRole("company_admin");
      await grantRole(owner, memberRole, "company", tenant);
      await grantRole(sameCompanyOther, memberRole, "company", tenant);
      await grantRole(companyAdmin, companyAdminRole, "company", tenant);

      // The link ASST-21's endpoint would have created via `handoffs.ts`'s `createHandoff` — inserted
      // directly here (module-scoped withTenants, exactly what the real code path uses) so this test
      // targets the READ side (the additive Cerbos rule + intelligence.controller.ts's edit) without
      // re-testing the write side, which `assistant-handoff.test.ts` already covers end to end.
      await withTenants(
        [tenant],
        (c) =>
          c.query(
            `INSERT INTO assistant_threads (id, tenant_id, owner_user_id, origin_site) VALUES ($1,$2,$3,'central')`,
            [newId(), tenant, owner],
          ),
        { modules: ["assistant"] },
      );
      const threadRow = await withTenants(
        [tenant],
        (c) => c.query<{ id: string }>(`SELECT id FROM assistant_threads WHERE tenant_id = $1 AND owner_user_id = $2`, [tenant, owner]),
        { modules: ["assistant"] },
      );
      await withTenants(
        [tenant],
        (c) =>
          c.query(
            `INSERT INTO assistant_handoffs
               (id, tenant_id, thread_id, owner_user_id, agent, goal_text, goal_id, run_id, status, origin_site)
             VALUES ($1,$2,$3,$4,'status-reporter','status please',$5,$6,'ok','central')`,
            [newId(), tenant, threadRow.rows[0].id, owner, newId(), HANDOFF_RUN_ID],
          ),
        { modules: ["assistant"] },
      );
    });

    it("the triggering owner CAN read the handoff run's transcript (owner-scoped, not elevated-scoped)", async () => {
      const r = await app.inject({ method: "GET", url: `/api/${tenant}/agents/runs/${HANDOFF_RUN_ID}`, headers: asUser(owner) });
      expect(r.statusCode).toBe(200);
      const run = r.json() as { steps: Array<{ kind: string; detail: string }> };
      expect(run.steps).toEqual([{ kind: "tool", detail: "projects.list ok" }]);
    });

    // O4 — the events proxy reuses the SAME gate line as the transcript above, so the owner
    // carve-out extends to it for free; pinned here so a future refactor that splits the gates
    // apart gets caught.
    it("the same owner-scoped carve-out extends to the events proxy (same gate, reused not reimplemented)", async () => {
      const r = await app.inject({ method: "GET", url: `/api/${tenant}/agents/runs/${HANDOFF_RUN_ID}/events`, headers: asUser(owner) });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { events: Array<{ detail: string }> };
      expect(body.events).toEqual([{ eventId: "he1", runId: HANDOFF_RUN_ID, goalId: "goal-handoff-1", seq: 1, ts: "2026-08-23T00:00:01Z", kind: "tool", detail: "projects.list ok", durationMs: 80, parentRunId: null }]);

      const other = await app.inject({ method: "GET", url: `/api/${tenant}/agents/runs/${HANDOFF_RUN_ID}/events`, headers: asUser(sameCompanyOther) });
      expect(other.statusCode).toBe(403);
    });

    it("a DIFFERENT same-company user CANNOT read it", async () => {
      const r = await app.inject({ method: "GET", url: `/api/${tenant}/agents/runs/${HANDOFF_RUN_ID}`, headers: asUser(sameCompanyOther) });
      expect(r.statusCode).toBe(403);
    });

    it("company_admin CANNOT read it either (owner-scoped, no admin backdoor — company_admin is NOT isElevated)", async () => {
      const r = await app.inject({ method: "GET", url: `/api/${tenant}/agents/runs/${HANDOFF_RUN_ID}`, headers: asUser(companyAdmin) });
      expect(r.statusCode).toBe(403);
    });

    it("a runId with NO assistant_handoffs row still 403s a non-elevated caller (the additive path never widens to 'any owner-attributed run')", async () => {
      const r = await app.inject({ method: "GET", url: `/api/${tenant}/agents/runs/run-1`, headers: asUser(owner) });
      expect(r.statusCode).toBe(403);
    });

    it("REGRESSION GUARD (restated with THIS suite's own principals): elevated (platform_admin) still reads a non-handoff run; a non-elevated owner-of-a-handoff still cannot read a DIFFERENT, non-handoff run", async () => {
      const asAdmin = await app.inject({ method: "GET", url: `/api/${tenant}/agents/runs/run-1`, headers: asUser(admin) });
      expect(asAdmin.statusCode).toBe(200);
      const asHandoffOwner = await app.inject({ method: "GET", url: `/api/${tenant}/agents/runs/run-1`, headers: asUser(owner) });
      expect(asHandoffOwner.statusCode).toBe(403);
    });
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
