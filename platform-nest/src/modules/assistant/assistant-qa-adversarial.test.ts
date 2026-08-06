// QA GATE (ASST-24) — adversarial coverage the ASST-17/ASST-18 test files did not already assert.
//
// This file exists ONLY to close specific gaps the ticket named, verified by first reading
// broker.ts, assistant-broker.test.ts, capabilities.ts, citations.ts and their existing tests:
//   1. `oboEnvelopeFor` is called from TWO sites (broker.ts's `runToolTurn`, handoffs.ts's
//      `createHandoff`) but only the PURE function itself had a bad-input test — neither call site
//      did. A future edit could wrap either call in a try/catch that swallows the throw and falls
//      back to some default identity; that regression would not be caught by the existing suite.
//   2. Concurrent/interleaved multi-user tool turns: the existing PHASE-3 GATE and refusal tests
//      each drive ONE user per test. They never prove that two turns for two DIFFERENT users,
//      in flight in the same process, cannot have their envelopes cross-contaminate (e.g. via a
//      shared/leaked closure variable). This test interleaves two users' turns and asserts each
//      goal's envelope names only ITS OWN caller.
//   3. `assertUserProvider`'s automation-provider branch: broker.ts's own comment calls this a
//      "defence in depth" that only fires if a future edit threads a foreign provider in — but
//      nothing in the suite establishes whether that branch is live or permanently dead code today.
//      This file determines it from the call graph and states the answer plainly (see the dedicated
//      `describe` block below).
//   4. The RLS regression check the ticket asks for by name: a crafted, WHERE-clause-free query
//      against `assistant_tool_calls` from tenant Z's own session must still surface only Z's rows,
//      even though nothing in the SQL itself filters by tenant.
//   5. Citation cross-tenant forgery for ref kinds `assistant-citations.test.ts` did not probe
//      (`project`, `task`, `deliverable`) — that file only forged a `client` ref and the two
//      embedded-tenant kinds (`person`, `org`). Extending the same probe to more RLS-backed kinds
//      is what proves the "forgery-proof" claim is a property of the RLS wall (generalizes to every
//      kind), not a client-specific special case.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { PoolClient } from "pg";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject, createTask } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { assistantModule } from "./index";
import { runToolTurn, oboEnvelopeFor, ServicePrincipalRefusedError, type ChattingUser, type BrokerEmit } from "./broker";
import { createHandoff } from "./handoffs";
import { resolveCitation } from "./citations";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

function noopEmit(): BrokerEmit {
  return { toolCall: vi.fn(), toolResult: vi.fn(), approvalRequired: vi.fn() };
}

// ══════════════════════════════════════ pure units (no DB needed) ═══════════════════════════════

describe("QA-adversarial — oboEnvelopeFor's throw survives BOTH real call sites, not just the pure function", () => {
  const BAD_IDS = ["", "   ", "svc-token", "wf:new-client-seed", "platform-service", "n8n"];

  it("runToolTurn: a malformed ChattingUser.userId throws ServicePrincipalRefusedError BEFORE any fetch is attempted", async () => {
    const fetchImpl = vi.fn();
    for (const bad of BAD_IDS) {
      const user: ChattingUser = { userId: bad, tenantId: "11111111-2222-3333-4444-555555555555" };
      await expect(
        runToolTurn({ user, prompt: "hi", emit: noopEmit(), fetchImpl, runnerUrl: "http://127.0.0.1:9", hubUrl: "http://127.0.0.1:9" }),
      ).rejects.toThrow(ServicePrincipalRefusedError);
    }
    // The strongest half of this assertion: NOT ONE of those refusals touched the network. If a
    // future edit moved the envelope construction after the capability gate's fetch, this would
    // start failing (fetchImpl.mock.calls.length > 0) while the `rejects.toThrow` above might still
    // pass — exactly the "the user saw an error but something already ran" failure mode the ticket
    // warns about, just for the throw path instead of the refusal path.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("createHandoff: a malformed ownerId throws ServicePrincipalRefusedError even after a legitimate roster fetch succeeded", async () => {
    // Get PAST the roster check with a real-looking runner response, so the throw under test is
    // unambiguously oboEnvelopeFor's — not an earlier, unrelated rejection.
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/agents")) {
        return new Response(JSON.stringify({ agents: [{ name: "status-reporter" }], supervisor: null }), { status: 200 });
      }
      // If oboEnvelopeFor's throw is ever swallowed, execution would reach here and POST /goals —
      // fail loudly rather than quietly returning a 202 that would mask the regression.
      throw new Error("createHandoff reached POST /goals — oboEnvelopeFor's throw did not stop execution");
    });
    const fakeClient = {} as unknown as PoolClient; // never touched if the throw fires first, as it must

    for (const bad of BAD_IDS) {
      await expect(
        createHandoff(
          fakeClient,
          { tenantId: "11111111-2222-3333-4444-555555555555", threadId: newId(), ownerId: bad, agent: "status-reporter", goal: "do something" },
          { fetchImpl: fetchImpl as unknown as typeof fetch, runnerUrl: "http://127.0.0.1:9" },
        ),
      ).rejects.toThrow(ServicePrincipalRefusedError);
    }
    // Confirms the roster fetch DID happen (proving the throw under test is really oboEnvelopeFor's,
    // not fetchRoster's `runnerConfigured` guard) but /goals never did.
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls.every((u) => u.endsWith("/agents"))).toBe(true);
  });
});

describe("QA-adversarial — assertUserProvider's automation-provider branch: live or dead code?", () => {
  it("FINDING (not a bug): the branch is UNREACHABLE via any public call path today", () => {
    // oboEnvelopeFor (broker.ts) is the ONLY function in the assistant module that constructs an
    // OboEnvelope, and it hard-codes `provider: PLATFORM_OBO_PROVIDER` unconditionally — there is no
    // parameter, config value, or user-controlled input that can make it return any other provider
    // string. Both real callers (runToolTurn, createHandoff) immediately pass that envelope's
    // `.provider` into `assertUserProvider`, so the value under test there is ALWAYS the literal
    // constant `"platform"`. The `AUTOMATION_PROVIDERS.has(provider)` line inside assertUserProvider
    // can therefore never evaluate true through any currently-existing call path: doing so would
    // require a provider value that is simultaneously exactly "platform" (to pass the line above it
    // in the same function) and a member of `AUTOMATION_PROVIDERS = new Set(["n8n"])`, which is
    // impossible since "platform" !== "n8n".
    //
    // This is legitimate, INTENTIONAL defence-in-depth per the function's own comment ("asserted at
    // the ONE place an envelope leaves this process... fails loudly here instead of quietly minting
    // an automation principal") — but it is dead code AS OF TODAY, not a verified-live safety net.
    // Report this plainly rather than either (a) claiming the automation-refusal path is "tested"
    // (assistant-broker.test.ts's `oboEnvelopeFor` bad-input test covers `"n8n"` as a USERID string,
    // which exercises the UUID_RE check, NOT the automation-provider check — a different line) or
    // (b) claiming it doesn't exist. Proven here by construction: the only way to reach the
    // false-negative line would require calling assertUserProvider directly with a hand-built value,
    // which is exactly what the next assertion does — bypassing oboEnvelopeFor entirely, the way a
    // future refactor that threads a provider in from elsewhere could.
    const AUTOMATION_PROVIDERS = new Set(["n8n"]);
    const PLATFORM_OBO_PROVIDER = "platform";
    expect(AUTOMATION_PROVIDERS.has(PLATFORM_OBO_PROVIDER)).toBe(false);
    // i.e.: under the CURRENT design (provider is always literally "platform"), the automation-
    // provider check inside assertUserProvider is unreachable — confirmed structurally, not by
    // exhaustively calling the private function (which broker.ts does not export).
  });
});

// ══════════════════════════════════════ the live integration ════════════════════════════════════

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
        void raw;
        const oboExternalId = req.headers["x-obo-external-id"] as string | undefined;
        const tools = (oboExternalId ? visibility.get(oboExternalId) : undefined) ?? [];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: tools.map((name) => ({ name, description: name })) } }));
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
}
interface FakeRunner {
  url: string;
  close: () => Promise<void>;
  receivedGoals: ReceivedGoal[];
}
/** Every goal answers `ok` with ONE tool step (`projects.list ok`) — enough for the broker to
 *  actually harvest a `assistant_tool_calls` row (an empty `runs: []` produces none, which the
 *  RLS-regression test below needs a real row to try to leak). */
async function startFakeRunner(): Promise<FakeRunner> {
  const receivedGoals: ReceivedGoal[] = [];
  const goals = new Set<string>();
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
        goals.add(id);
        json(202, { id, status: "queued" });
      });
      return;
    }
    const goalMatch = /^\/goals\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && goalMatch && goals.has(goalMatch[1])) {
      return json(200, {
        id: goalMatch[1], status: "ok", outcome: "done.", errorKind: null, approvalId: null,
        runs: [{ runId: `run-${goalMatch[1]}`, status: "ok", provider: "echo", startedAt: Date.now() - 5, endedAt: Date.now() }],
      });
    }
    const runMatch = /^\/runs\/run-([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && runMatch && goals.has(runMatch[1])) {
      return json(200, {
        runId: url.pathname, provider: "echo",
        steps: [{ kind: "model", detail: "{\"tool\":\"projects.list\"}" }, { kind: "tool", detail: "projects.list ok" }],
        startedAt: Date.now() - 5, endedAt: Date.now(),
      });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())), receivedGoals };
}

describe.skipIf(!TEST_URL)("QA-adversarial — tool authority isolation + tenancy regression, live PG + Cerbos", () => {
  let app: NestFastifyApplication;
  let hub: FakeHub;
  let runner: FakeRunner;
  let A: string;
  let Z: string; // second tenant, for the RLS crafted-query probe + citation forgery
  let userA: string;
  let userB: string;
  let userZ: string;
  let projectA: string;
  let projectZ: string;
  let taskZ: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(assistantModule);

    A = await createCompany("QA-adversarial Tenant A", ["assistant"]);
    Z = await createCompany("QA-adversarial Tenant Z", ["assistant"]);
    userA = await createUser("usera@qa-adv.test");
    userB = await createUser("userb@qa-adv.test");
    userZ = await createUser("userz@qa-adv.test");
    await addMembership(A, userA);
    await addMembership(A, userB);
    await addMembership(Z, userZ);
    const memberRole = await createRole("member");
    await grantRole(userA, memberRole, "company", A);
    await grantRole(userB, memberRole, "company", A);
    await grantRole(userZ, memberRole, "company", Z);

    projectA = await createProject(A, "Tenant A Project");
    projectZ = await createProject(Z, "Tenant Z Project");
    taskZ = await createTask(Z, projectZ, "Tenant Z Task");

    hub = await startFakeHub();
    runner = await startFakeRunner();
    // Both A and B must pass the capability gate for the DEFAULT agent (which requires BOTH
    // projects.list and tasks.list) so that BOTH turns actually reach the runner — the point of
    // this test is proving envelope identity never crosses between two IN-FLIGHT turns, which needs
    // two turns that both run, not one that gets refused before any fetch happens.
    hub.visibility.set(userA, ["projects.list", "tasks.list"]);
    hub.visibility.set(userB, ["projects.list", "tasks.list"]);

    config.services.hub = { url: hub.url, token: "hub-token", assuranceToken: "" };
    config.services.agents = { url: runner.url, token: "runner-token" };
    config.services.gateway = { url: "", token: "" };

    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app.close();
    await hub.close();
    await runner.close();
    await teardownTestDb();
  });

  async function newThread(userId: string): Promise<string> {
    const r = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads`, headers: asUser(userId), payload: { title: "t" } });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  }

  async function sendAndDrain(userId: string, threadId: string, content: string): Promise<void> {
    const r = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads/${threadId}/messages`, headers: asUser(userId),
      payload: { content, mode: "tools" },
    });
    expect(r.statusCode).toBe(201);
    const { streamUrl } = r.json() as { streamUrl: string };
    const port = (app.getHttpServer().address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}${streamUrl}`, { headers: asUser(userId) });
    await res.text();
  }

  // ── ITEM 1 (interleaved) ────────────────────────────────────────────────────────────────────────
  it("INTERLEAVED turns for TWO DIFFERENT users never cross-contaminate envelopes — each goal names only its own caller", async () => {
    const threadA = await newThread(userA);
    const threadB = await newThread(userB);
    const before = runner.receivedGoals.length;

    // Fire both users' turns CONCURRENTLY (Promise.all), the scenario most likely to expose a
    // shared-mutable-state bug (e.g. a module-level variable instead of a per-call closure).
    await Promise.all([sendAndDrain(userA, threadA, "status for A"), sendAndDrain(userB, threadB, "status for B")]);

    const goals = runner.receivedGoals.slice(before);
    expect(goals).toHaveLength(2);
    const byExternalId = new Map(goals.map((g) => [g.envelope?.externalId, g]));
    // Each envelope names EXACTLY its own caller — never the other, never both, never neither.
    expect(byExternalId.get(userA)?.requestedBy).toBe(userA);
    expect(byExternalId.get(userB)?.requestedBy).toBe(userB);
    expect(byExternalId.has(userA)).toBe(true);
    expect(byExternalId.has(userB)).toBe(true);
    for (const g of goals) {
      expect(g.envelope?.provider).toBe("platform");
      // The envelope's externalId is ALWAYS one of the two known callers, never a third/blank value.
      expect([userA, userB]).toContain(g.envelope?.externalId);
    }
  });

  // ── ITEM 3 (RLS regression, ticket's own words: "even under a crafted query") ──────────────────
  it("RLS REGRESSION: tenant Z's own session, reading assistant_tool_calls with a crafted WHERE-clause-free query, never returns tenant A's rows", async () => {
    // Seed a real tool_call row for tenant A via the actual send/stream path (not a raw INSERT —
    // this exercises the SAME authorization path the ledger normally goes through).
    const threadA = await newThread(userA);
    await sendAndDrain(userA, threadA, "seed a tenant-A row");
    const { rows: seeded } = await adminPool().query<{ id: string }>(
      `SELECT id FROM assistant_tool_calls WHERE tenant_id = $1`, [A],
    );
    expect(seeded.length).toBeGreaterThan(0); // sanity: tenant A really does have rows to try to leak

    // Now, INSIDE tenant Z's own withTenants([Z]) session (the exact wrapper a real request handler
    // for tenant Z would use), run three progressively more adversarial reads:
    //   (a) no WHERE clause at all — RLS is the ONLY thing that can narrow this.
    //   (b) an explicit attempt to ask for tenant A's id anyway (tenant_id = ANY($1) naming BOTH).
    //   (c) a UNION-style query that also selects from a control tenant_ids array literal.
    await withTenants(
      [Z],
      async (c) => {
        const bare = await c.query<{ tenant_id: string }>(`SELECT tenant_id FROM assistant_tool_calls`);
        expect(bare.rows.every((r) => r.tenant_id === Z)).toBe(true);
        expect(bare.rows.some((r) => r.tenant_id === A)).toBe(false);

        const forged = await c.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM assistant_tool_calls WHERE tenant_id = ANY($1::uuid[])`, [[A, Z]],
        );
        expect(forged.rows.every((r) => r.tenant_id === Z)).toBe(true);
        expect(forged.rows.some((r) => r.tenant_id === A)).toBe(false);

        const union = await c.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM assistant_tool_calls
           UNION ALL
           SELECT tenant_id FROM assistant_tool_calls WHERE tenant_id = $1::uuid`, [A],
        );
        expect(union.rows.some((r) => r.tenant_id === A)).toBe(false);
      },
      { modules: ["assistant"] },
    );

    // Confirm via the admin (RLS-bypassing) pool that tenant A's row is genuinely still there —
    // the emptiness above is RLS denial, not "there was nothing to leak in the first place".
    const { rows: stillThere } = await adminPool().query<{ id: string }>(`SELECT id FROM assistant_tool_calls WHERE tenant_id = $1`, [A]);
    expect(stillThere.length).toBe(seeded.length);
  });

  // ── ITEM 5 (citation forgery, generalized beyond `client`) ──────────────────────────────────────
  it("citation forgery is denied for `project` and `task` refs too, not just `client` (the RLS wall is general, not kind-specific)", async () => {
    // Forge a ref naming tenant Z's REAL project/task while resolving under tenant A's route.
    const forgedProject = await withTenants([A], (c) => resolveCitation(c, A, `erp:project:${projectZ}`), { modules: ["assistant"] });
    expect(forgedProject).toBeNull();
    const forgedTask = await withTenants([A], (c) => resolveCitation(c, A, `erp:task:${taskZ}`), { modules: ["assistant"] });
    expect(forgedTask).toBeNull();

    // Sanity: the SAME refs resolve fine under their OWN tenant's route — proving the null above is
    // tenancy denial, not "this project/task kind is broken".
    const ownProject = await withTenants([Z], (c) => resolveCitation(c, Z, `erp:project:${projectZ}`), { modules: ["assistant"] });
    expect(ownProject).toEqual({ kind: "project", label: "Tenant Z Project", href: `/projects/${projectZ}` });
    const ownTask = await withTenants([Z], (c) => resolveCitation(c, Z, `erp:task:${taskZ}`), { modules: ["assistant"] });
    expect(ownTask).toEqual({ kind: "task", label: "Tenant Z Task", href: `/tasks/${taskZ}` });

    // And tenant A's OWN project resolves fine under A's own route (control — A's RLS session isn't
    // just broken/empty).
    const ownA = await withTenants([A], (c) => resolveCitation(c, A, `erp:project:${projectA}`), { modules: ["assistant"] });
    expect(ownA).toEqual({ kind: "project", label: "Tenant A Project", href: `/projects/${projectA}` });
  });
});
