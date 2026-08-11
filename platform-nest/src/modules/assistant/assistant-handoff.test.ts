// ASST-21 — "hand off a thread to a specialist" + the agent roster.
//
// Ticket: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md ("### ASST-21").
// Design: docs/blueprints/assistant-foundation.md §8's "agent roster" line, D-B.
//
// ── THE AUTHZ DESIGN PIN, restated for this file ────────────────────────────────────────────────────
// A handoff runs under the CHATTING USER's own OBO envelope (broker.ts's `oboEnvelopeFor`) — this
// file's `envelope assertion` test does not INFER that from a 200 response; it reads the exact body
// the fake runner received and asserts `envelope === {provider:'platform', externalId: owner}`
// verbatim, the same "assert, don't infer" discipline `assistant-broker.test.ts` established for
// ASST-17. The READ-side authz proof (owner CAN read the resulting run's transcript; a different
// same-company user and company_admin CANNOT; a non-handoff run stays elevated-only) lives in
// `admin/intelligence.test.ts`'s "ASST-21: handoff-owner additive carve-out" block — this file does
// not duplicate it, it proves the WRITE side that produces the row that read-side test depends on.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { assistantModule } from "./index";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

interface ReceivedGoal {
  tenantId?: string;
  goal?: string;
  agent?: string;
  envelope?: { provider?: string; externalId?: string };
  requestedBy?: string;
}

// Fixed ids, real-uuid-shaped: `assistant_handoffs.goal_id`/`run_id` are BOTH `uuid` columns
// (migration 0084) — the REAL ai-agents runner always returns `gen_random_uuid()` ids, so this fake
// must too, or platform-nest's INSERT throws "invalid input syntax for type uuid" instead of
// exercising the code path this test is actually about.
const GOAL_ID = "0199999a-1111-4000-8000-000000000001";
const RUN_ID = "0199999a-0000-4000-8000-000000000001";

function startFakeRunner(): Promise<{
  url: string;
  close: () => Promise<void>;
  receivedGoals: ReceivedGoal[];
  receivedEpisodeRunIds: string[][];
}> {
  const receivedGoals: ReceivedGoal[] = [];
  const receivedEpisodeRunIds: string[][] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && url.pathname === "/agents") {
      return json(200, {
        agents: [
          { name: "status-reporter", tools: ["projects.list", "tasks.list"], maxSteps: 8, maxToolCalls: 6, writeCapable: false, evaledProviders: [] },
          { name: "approvals-chaser", tools: ["agency.pendingApprovals"], maxSteps: 4, maxToolCalls: 2, writeCapable: false, evaledProviders: [] },
          { name: "task-triager", tools: ["tasks.list", "tasks.update"], maxSteps: 10, maxToolCalls: 6, writeCapable: true, evaledProviders: ["openai"] },
        ],
        supervisor: { name: "supervisor" },
      });
    }

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
        return json(202, { id: GOAL_ID, status: "queued" });
      });
      return;
    }

    if (req.method === "GET" && url.pathname === `/goals/${GOAL_ID}`) {
      return json(200, {
        id: GOAL_ID, status: "ok", outcome: "1 project, 0 tasks", errorKind: null, approvalId: null,
        runs: [{ runId: RUN_ID, agent: "status-reporter", status: "ok", outcome: "1 project, 0 tasks", modelCalls: 1, toolCalls: 1, provider: "echo", startedAt: 1, endedAt: 2 }],
      });
    }

    if (req.method === "GET" && url.pathname === "/episodes") {
      const runIds = (url.searchParams.get("runIds") ?? "").split(",").filter(Boolean);
      receivedEpisodeRunIds.push(runIds);
      return json(200, {
        episodes: runIds.map((runId) => ({
          runId, agent: "status-reporter", tenantId: url.searchParams.get("tenant"), goal: "status please",
          status: "ok", outcome: "1 project, 0 tasks", toolsCalled: ["projects.list"], failedTools: [],
          modelCalls: 1, toolCalls: 1, provider: "echo", provenance: "agent", feedback: [], createdAt: Date.now(),
        })),
      });
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        receivedGoals,
        receivedEpisodeRunIds,
      });
    });
  });
}

describe.skipIf(!TEST_URL)("Assistant handoff + roster (ASST-21) — live PG + Cerbos", () => {
  let app: NestFastifyApplication;
  let runner: Awaited<ReturnType<typeof startFakeRunner>>;
  let A: string;
  let owner: string;
  let other: string;
  let admin: string;
  let threadId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(assistantModule);

    runner = await startFakeRunner();
    config.services.agents = { url: runner.url, token: "runner-token" };

    A = await createCompany("Assistant Handoff Tenant A", ["assistant"]);
    owner = await createUser("handoff-owner@asst-h.test");
    other = await createUser("handoff-other@asst-h.test");
    admin = await createUser("handoff-admin@asst-h.test");
    await addMembership(A, owner);
    await addMembership(A, other);
    await addMembership(A, admin);
    const memberRole = await createRole("member");
    const companyAdminRole = await createRole("company_admin");
    await grantRole(owner, memberRole, "company", A);
    await grantRole(other, memberRole, "company", A);
    await grantRole(admin, companyAdminRole, "company", A);

    app = await buildApp();

    const created = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads`, headers: asUser(owner), payload: { title: "handoff thread" } });
    threadId = (created.json() as { id: string }).id;
  });
  afterAll(async () => {
    await app.close();
    await runner.close();
    await teardownTestDb();
  });

  it("agent must be one of the REAL registry — an unknown name 400s naming the real ones, never a hardcoded list", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads/${threadId}/handoff`, headers: asUser(owner),
      payload: { agent: "does-not-exist", goal: "do something" },
    });
    expect(r.statusCode).toBe(400);
    const body = r.json() as { error?: string };
    expect(body.error).toContain("status-reporter");
    expect(body.error).toContain("task-triager");
  });

  it("owner-only: a different user cannot hand off someone else's thread (no goal is ever submitted)", async () => {
    const before = runner.receivedGoals.length;
    const r = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads/${threadId}/handoff`, headers: asUser(other),
      payload: { agent: "status-reporter", goal: "spy on this thread" },
    });
    expect(r.statusCode).toBe(403);
    expect(runner.receivedGoals.length).toBe(before); // provably nothing was submitted
  });

  let handoffId: string;
  it("creates a handoff linked to the thread, running EXPLICITLY under the CHATTING USER's own OBO envelope (asserted, not inferred)", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads/${threadId}/handoff`, headers: asUser(owner),
      payload: { agent: "status-reporter", goal: "give me a status report" },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { id: string; goalId: string; status: string };
    expect(body.goalId).toBe(GOAL_ID);
    expect(body.status).toBe("queued");
    handoffId = body.id;

    // THE envelope assertion — the exact body the runner received, not a side effect inferred from
    // the HTTP status. `oboEnvelopeFor` hard-codes provider:'platform' and the chatting user's id;
    // this is what proves THIS call actually used it.
    const submitted = runner.receivedGoals.at(-1)!;
    expect(submitted.tenantId).toBe(A);
    expect(submitted.agent).toBe("status-reporter");
    expect(submitted.envelope).toEqual({ provider: "platform", externalId: owner });
    expect(submitted.requestedBy).toBe(owner);

    // Linked to the thread, in the platform's OWN table — not just accepted by the runner.
    const row = await withTenants(
      [A],
      (c) => c.query<{ ownerUserId: string; threadId: string; agent: string; status: string }>(
        `SELECT owner_user_id AS "ownerUserId", thread_id AS "threadId", agent, status FROM assistant_handoffs WHERE id = $1`,
        [handoffId],
      ),
      { modules: ["assistant"] },
    );
    expect(row.rows[0]).toMatchObject({ ownerUserId: owner, threadId, agent: "status-reporter", status: "queued" });
  });

  it("no writeActivity()/notify() on the handoff write — the shared tenant feed never learns a private thread exists", async () => {
    // `activities` also carries `core/http.ts`'s Cerbos DECISION audit (`authz.allow`/`authz.deny`,
    // written on EVERY authorize() call regardless of module) — that is a separate, pre-existing
    // mechanism, not the member-readable FEED `writeActivity()` writes to. This assertion is about
    // the latter: excluding `authz.%` rows is what isolates it.
    const activity = await withTenants(
      [A],
      (c) => c.query(`SELECT verb FROM activities WHERE tenant_id = $1 AND verb NOT LIKE 'authz.%'`, [A]),
    );
    expect(activity.rows).toEqual([]);
    const notifications = await withTenants([A], (c) => c.query(`SELECT 1 FROM notifications WHERE tenant_id = $1`, [A]));
    expect(notifications.rows).toEqual([]);
  });

  it("GET .../handoffs lazily syncs status + runId from the runner, and is owner-only", async () => {
    const forbidden = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}/handoffs`, headers: asUser(other) });
    expect(forbidden.statusCode).toBe(403);

    const r = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}/handoffs`, headers: asUser(owner) });
    expect(r.statusCode).toBe(200);
    const items = r.json() as Array<{ id: string; status: string; runId: string | null; outcome: string | null }>;
    const mine = items.find((h) => h.id === handoffId)!;
    expect(mine.status).toBe("ok"); // synced from the fake runner's terminal goal
    expect(mine.runId).toBe(RUN_ID);
    expect(mine.outcome).toBe("1 project, 0 tasks");

    // The DB row itself was updated (not just the HTTP response reshaped in-flight).
    const persisted = await withTenants(
      [A],
      (c) => c.query<{ status: string; runId: string | null }>(`SELECT status, run_id AS "runId" FROM assistant_handoffs WHERE id = $1`, [handoffId]),
      { modules: ["assistant"] },
    );
    expect(persisted.rows[0]).toMatchObject({ status: "ok", runId: RUN_ID });
  });

  it("GET .../agents (roster) lists the REAL registry (not hardcoded) plus THIS caller's own episodic history, narrowed by their own handoff run ids — never a bare tenant-wide history", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${A}/assistant/agents`, headers: asUser(owner) });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      agents: Array<{ name: string; writeCapable: boolean }>;
      runnerConfigured: boolean;
      episodicHistory: Array<{ runId: string; agent: string }>;
    };
    expect(body.runnerConfigured).toBe(true);
    // Reflects the FAKE runner's own registry verbatim — proves this is a live read, not a mirror.
    expect(body.agents.map((a) => a.name).sort()).toEqual(["approvals-chaser", "status-reporter", "task-triager"]);
    expect(body.agents.find((a) => a.name === "task-triager")?.writeCapable).toBe(true);
    // The episode for THIS owner's handoff run is present.
    expect(body.episodicHistory.map((e) => e.runId)).toContain(RUN_ID);

    // THE narrowing proof: the runner's /episodes saw exactly the caller's own run id(s), never an
    // unfiltered "give me everything for this tenant" call.
    const lastRunIdsRequested = runner.receivedEpisodeRunIds.at(-1)!;
    expect(lastRunIdsRequested).toEqual([RUN_ID]);
  });

  it("a caller with NO handoffs yet gets an empty episodic history, never someone else's", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${A}/assistant/agents`, headers: asUser(other) });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { episodicHistory: unknown[] };
    expect(body.episodicHistory).toEqual([]);
  });

  it("module contract: the ASST-21 migration is registered", () => {
    expect(assistantModule.migrations).toContain("0084_assistant_handoffs.sql");
  });

  // IAM-01d (2026-08-10): `assistant:handoff` used to be declared here, but the reconciliation in
  // docs/superpowers/plans/2026-08-10-permission-catalog.md §7 traced it to the catalog's
  // RELATIONSHIP class (assistant.thread.handoff + assistant.agent_run.read — the 15 bypass-exempt
  // pairs, Ruling 3) — held by owning the resource, never role-grantable. The module registry's
  // `validateModulePermissions()` fails closed on any module declaring a relationship-class
  // permission, so it was removed rather than renamed. Handoff authorization is unchanged: still
  // enforced by Cerbos's `owns`/`inTenant`/`notLow` conditions, just never through
  // `ModuleContract.permissions`/`role_permissions`.
  it("module contract: assistant declares NO grantable permissions (all 5 are relationship-class, never role-grantable)", () => {
    expect(assistantModule.permissions).toEqual([]);
  });
});
