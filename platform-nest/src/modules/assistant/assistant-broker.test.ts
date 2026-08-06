// ASST-17 — the tool broker, and the ONE authz property it exists to guarantee: every tool a chat
// turn runs executes under the CHATTING USER's own Cerbos principal, never a service principal.
//
// Ticket: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md ("### ASST-17").
// Design: docs/blueprints/assistant-foundation.md §6.
//
// ── WHAT THESE TESTS ARE INSTRUMENTED TO PROVE (and why the obvious assertion is not enough) ──────
// The tempting assertion for the refusal case is "the user saw an error". That would pass even if the
// call had actually RUN under the wrong principal and merely reported a failure afterwards — i.e. it
// would pass in exactly the world this ticket exists to prevent. So the refusal test asserts BOTH
// halves: the typed, in-thread refusal AND that the agent runner received ZERO requests (no goal, no
// hub call, no execution by anybody), plus that the visibility decision that produced the refusal was
// itself taken under the refused user's own OBO envelope.
//
// ── THE DOUBLES ───────────────────────────────────────────────────────────────────────────────────
// Two small `node:http` fakes, both RECORDING (they are assertion instruments, not just stubs):
//   * fake mcp-hub    — answers `tools/list` from a per-USER visibility map keyed on the
//                       `x-obo-external-id` header it receives, which is how "the hub decided under
//                       THIS principal" becomes directly observable. Records every request's OBO
//                       headers + Authorization.
//   * fake agent-runner — records every `POST /goals` body verbatim (envelope included) and scripts
//                       its goal/run replies off markers embedded in the goal text, the same
//                       marker-driven pattern assistant-stream.test.ts's fake gateway uses. Its
//                       "live data" mode performs a REAL platform read under the envelope it was
//                       handed, so the read tool's answer is genuinely live tenant data fetched as
//                       the chatting user — not a fixture the fake invented.
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
import {
  ASSISTANT_AGENT_WRITE_TOOLS,
  DEFAULT_TOOL_AGENT,
  ServicePrincipalRefusedError,
  ensurePlatformSelfLink,
  oboEnvelopeFor,
  persistToolCalls,
  readTurnMode,
  redactToolArgs,
  turnModePart,
} from "./broker";
// ASST-23 (§7.4/T3a) — the registry-gate refusal test mutates the in-process executable registry
// (mirrors d14-17-assistant-write-registry.test.ts's own beforeAll pattern) and the card-state test
// drives the REAL executor after a REAL decide() call — no second, parallel implementation of either.
import { getExecutable, registerCoreExecutableApprovals, registerPmExecutableApprovals, resetExecutableApprovals } from "../../core/approval-executables";
import { executeApprovedAutomationWrite } from "../../core/approval-execute";

// ══════════════════════════════════════ pure units (no DB needed) ═══════════════════════════════

describe("ASST-17 broker — the envelope is the invariant", () => {
  it("oboEnvelopeFor ALWAYS spells provider 'platform' and the chatting user's own id", () => {
    const userId = "11111111-2222-3333-4444-555555555555";
    expect(oboEnvelopeFor({ userId, tenantId: "t" })).toEqual({ provider: "platform", externalId: userId });
  });

  it("refuses every non-user authority — empty, whitespace, a service-token string, a workflow id", () => {
    for (const bad of ["", "   ", "svc-token", "wf:new-client-seed", "platform-service", "n8n"]) {
      expect(() => oboEnvelopeFor({ userId: bad, tenantId: "t" })).toThrow(ServicePrincipalRefusedError);
    }
  });

  it("readTurnMode/turnModePart round-trip; anything else reads as a plain chat turn (never widened)", () => {
    expect(readTurnMode([turnModePart("status-reporter")])).toEqual({ type: "turn_mode", mode: "tools", agent: "status-reporter" });
    // Absent-tolerant in every direction — a malformed or unknown `parts` can only DEGRADE to chat.
    expect(readTurnMode([])).toBeNull();
    expect(readTurnMode(null)).toBeNull();
    expect(readTurnMode("tools")).toBeNull();
    expect(readTurnMode([{ type: "usage_meta", usageSource: "estimate" }])).toBeNull();
    expect(readTurnMode([{ type: "turn_mode", mode: "chat" }])).toBeNull();
    // A marker with no agent falls back to the default rather than to "no agent at all".
    expect(readTurnMode([{ type: "turn_mode", mode: "tools" }])?.agent).toBe(DEFAULT_TOOL_AGENT);
  });
});

describe("ASST-17 broker — redactToolArgs destroys values and keeps shape", () => {
  it("every leaf becomes a type tag; key names survive at depth; arrays collapse with their length", () => {
    const redacted = redactToolArgs({
      iban: "GB33BUKB20201555555555",
      amount: 5000,
      urgent: true,
      memo: null,
      recipients: ["a@b.c", "d@e.f", "g@h.i"],
      nested: { secret: "hunter2", deeper: { key: "value" } },
    });
    expect(redacted).toEqual({
      iban: "[redacted:string]",
      amount: "[redacted:number]",
      urgent: "[redacted:boolean]",
      memo: "[redacted:null]",
      recipients: "[redacted:array(3)]",
      nested: { secret: "[redacted:string]", deeper: { key: "[redacted:string]" } },
    });
    // The point of the whole function: no VALUE survives anywhere in the serialized row.
    const serialized = JSON.stringify(redacted);
    for (const secret of ["GB33BUKB20201555555555", "hunter2", "a@b.c", "5000"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("a non-object args bag yields {} (the column default), never a synthesized wrapper key", () => {
    expect(redactToolArgs(null)).toEqual({});
    expect(redactToolArgs(undefined)).toEqual({});
    expect(redactToolArgs("just a string")).toEqual({});
    expect(redactToolArgs([1, 2, 3])).toEqual({});
  });

  it("collapses a pathologically deep tree instead of walking it forever", () => {
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let i = 0; i < 12; i++) deep = { level: deep };
    const out = JSON.stringify(redactToolArgs(deep));
    expect(out).not.toContain('"x"');
    expect(out).toContain("[redacted:object]");
  });
});

// ══════════════════════════════════════ the live integration ════════════════════════════════════

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

interface FakeHub {
  url: string;
  close: () => Promise<void>;
  /** userId -> the tool names the hub reports as VISIBLE for that principal. A user absent from the
   *  map sees nothing (deny-by-default, mirroring the real hub's posture). */
  visibility: Map<string, string[]>;
  received: Array<{ method: string; oboProvider: string | undefined; oboExternalId: string | undefined; authorization: string | undefined }>;
}

async function startFakeHub(): Promise<FakeHub> {
  const visibility = new Map<string, string[]>();
  const received: FakeHub["received"] = [];
  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/mcp") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let method = "";
        try {
          method = (JSON.parse(raw) as { method?: string }).method ?? "";
        } catch {
          // an unparsable body is not this fake's concern
        }
        const oboExternalId = req.headers["x-obo-external-id"] as string | undefined;
        received.push({
          method,
          oboProvider: req.headers["x-obo-provider"] as string | undefined,
          oboExternalId,
          authorization: req.headers.authorization as string | undefined,
        });
        res.writeHead(200, { "content-type": "application/json" });
        if (method === "tools/call") {
          // ASST-23 (§7.4/T3a card-state test) — the executor's re-drive (`core/approval-execute.ts`'s
          // `callHubTool`) hits this SAME `/mcp` endpoint with a DIFFERENT jsonrpc method. It only
          // needs a well-formed non-error `tools/call` response; the tool's own real effect is
          // platform-nest's PM handler, which this fake never reaches — same "the hub is a fixture"
          // scope every other test in this file already accepts for `tools/list`.
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ text: "ok (fake hub)" }] } }));
          return;
        }
        const tools = (oboExternalId ? visibility.get(oboExternalId) : undefined) ?? [];
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { tools: tools.map((name) => ({ name, description: name, inputSchema: { type: "object" } })) },
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())), visibility, received };
}

interface ReceivedGoal {
  tenantId?: string;
  goal?: string;
  agent?: string;
  envelope?: { provider?: string; externalId?: string };
  requestedBy?: string;
  authorization?: string;
}

interface FakeRunner {
  url: string;
  close: () => Promise<void>;
  receivedGoals: ReceivedGoal[];
  /** Set once the app is listening so the "live data" mode can call the REAL platform under the
   *  envelope it was handed. */
  platformBase: string;
}

/**
 * The scripted agent-runner. Markers in the goal text (which is the assembled prompt, so the user's
 * own message content appears verbatim — see context.ts) select the behaviour:
 *   TOOLRUN_OK        — one run, two tool steps (`projects.list ok`, `tasks.list failed`), status ok.
 *   TOOLRUN_LIVE      — performs a REAL `GET /api/:t/projects` UNDER THE ENVELOPE IT RECEIVED and
 *                       returns the response body as the goal outcome; one `projects.list ok` step.
 *                       This is what makes "a read tool returns live tenant data scoped to that
 *                       user" a real end-to-end assertion instead of a fixture echo.
 *   TOOLRUN_SUSPEND:<approvalId> — status suspended with that approvalId (the D14 write-proposal path).
 *   TOOLRUN_FAIL      — status failed with errorKind ToolNotAllowedError.
 */
async function startFakeRunner(): Promise<FakeRunner> {
  const receivedGoals: ReceivedGoal[] = [];
  const goals = new Map<string, { goal: string; envelope: { provider?: string; externalId?: string }; tenantId: string; liveOutcome?: string }>();
  const fake: FakeRunner = { url: "", close: async () => {}, receivedGoals, platformBase: "" };

  /** The `TOOLRUN_LIVE` behaviour: actually go and read the platform, as whoever the envelope names.
   *  Done eagerly while the goal is being accepted (a real runner would do it in its worker), so the
   *  answer is already cached by the time the broker polls the goal. */
  async function performLiveRead(g: { goal: string; envelope: { provider?: string; externalId?: string }; tenantId: string }): Promise<string> {
    try {
      const r = await fetch(`${fake.platformBase}/api/${g.tenantId}/projects`, {
        headers: {
          authorization: "Bearer svc-token",
          // THE point: the runner reads as whoever the envelope names — nothing else.
          "x-obo-provider": g.envelope.provider ?? "",
          "x-obo-external-id": g.envelope.externalId ?? "",
        },
      });
      return `HTTP ${r.status} :: ${await r.text()}`;
    } catch (err) {
      return `live read failed: ${(err as Error).message}`;
    }
  }

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
        void (async () => {
          let body: ReceivedGoal = {};
          try {
            body = JSON.parse(raw) as ReceivedGoal;
          } catch {
            // ignore
          }
          receivedGoals.push({ ...body, authorization: req.headers.authorization as string | undefined });
          const id = newId();
          const g = { goal: body.goal ?? "", envelope: body.envelope ?? {}, tenantId: body.tenantId ?? "" };
          const liveOutcome = g.goal.includes("TOOLRUN_LIVE") ? await performLiveRead(g) : undefined;
          goals.set(id, { ...g, liveOutcome });
          json(202, { id, status: "queued" });
        })();
      });
      return;
    }

    const goalMatch = /^\/goals\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && goalMatch) {
      const g = goals.get(goalMatch[1]);
      if (!g) return json(404, { error: "goal not found" });
      const suspend = /TOOLRUN_SUSPEND:(\S+)/.exec(g.goal)?.[1];
      if (suspend) {
        return json(200, {
          id: goalMatch[1],
          status: "suspended",
          outcome: `suspended for approval — filed ${suspend} for money.transfer (high)`,
          errorKind: "approval_required",
          approvalId: suspend,
          runs: [],
        });
      }
      if (g.goal.includes("TOOLRUN_FAIL")) {
        return json(200, {
          id: goalMatch[1],
          status: "failed",
          outcome: "tool not on the agent's allow-list: money.transfer",
          errorKind: "ToolNotAllowedError",
          approvalId: null,
          runs: [],
        });
      }
      // ok — one run whose steps/outcome are computed lazily by GET /runs/:id below.
      return json(200, {
        id: goalMatch[1],
        status: "ok",
        outcome: g.goal.includes("TOOLRUN_LIVE") ? (g.liveOutcome ?? "(live read not performed)") : "Status report: 1 project, 0 tasks.",
        errorKind: null,
        approvalId: null,
        runs: [{ runId: `run-${goalMatch[1]}`, status: "ok", provider: "echo", startedAt: Date.now() - 10, endedAt: Date.now() }],
      });
    }

    const runMatch = /^\/runs\/run-([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && runMatch) {
      const g = goals.get(runMatch[1]);
      if (!g) return json(404, { error: "run not found" });
      const steps = g.goal.includes("TOOLRUN_LIVE")
        ? [{ kind: "model", detail: "{\"tool\":\"projects.list\"}" }, { kind: "tool", detail: "projects.list ok" }]
        : [
            { kind: "model", detail: "{\"tool\":\"projects.list\"}" },
            { kind: "tool", detail: "projects.list ok" },
            { kind: "tool", detail: "tasks.list failed" },
          ];
      return json(200, { runId: url.pathname, provider: "echo", steps, startedAt: Date.now() - 10, endedAt: Date.now() });
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  fake.url = `http://127.0.0.1:${addr.port}`;
  fake.close = () => new Promise<void>((r) => server.close(() => r()));
  return fake;
}

describe.skipIf(!TEST_URL)("Assistant tool broker (ASST-17) — live PG + Cerbos", () => {
  let app: NestFastifyApplication;
  let port: number;
  let hub: FakeHub;
  let runner: FakeRunner;
  let A: string;
  let owner: string;
  let restricted: string;
  let other: string;
  let admin: string;
  let outsiderCompany: string;
  let outsider: string;
  let automationUser: string;
  let projectName: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(assistantModule);

    A = await createCompany("Assistant Broker Tenant A", ["assistant"]);
    outsiderCompany = await createCompany("Assistant Broker Tenant B", ["assistant"]);
    owner = await createUser("owner@asst-broker.test");
    restricted = await createUser("restricted@asst-broker.test");
    other = await createUser("other@asst-broker.test");
    admin = await createUser("admin@asst-broker.test");
    outsider = await createUser("outsider@asst-broker.test");
    // A NON-HUMAN principal, present only so the "authority_user_id is never a service id" assertion
    // has a concrete service identity to look for rather than asserting the absence of nothing.
    automationUser = await createUser("automation@asst-broker.test");

    for (const u of [owner, restricted, other, admin]) await addMembership(A, u);
    await addMembership(A, automationUser, "service");
    await addMembership(outsiderCompany, outsider);

    const companyAdminRole = await createRole("company_admin");
    const memberRole = await createRole("member");
    await grantRole(admin, companyAdminRole, "company", A);
    for (const u of [owner, restricted, other]) await grantRole(u, memberRole, "company", A);
    await grantRole(outsider, memberRole, "company", outsiderCompany);

    // Live tenant data the read-tool test looks for. Created here, in THIS run, with a unique name —
    // so finding it in the streamed answer cannot be a fixture or a demo-mode artifact.
    projectName = `Broker Live Project ${Date.now()}`;
    await createProject(A, projectName);

    hub = await startFakeHub();
    runner = await startFakeRunner();
    // The hub's per-principal answer. `owner` sees both status-reporter tools; `restricted` sees
    // neither of them (only an unrelated tool), which is how a Cerbos deny for that user looks on the
    // wire. Nobody else is in the map at all — deny-by-default.
    // ASST-23 (§7.4/T3a) — `owner` also sees task-filer's tools, incl. both write tools, so the
    // registry-gate (step 0.5) and card-state tests below exercise wall 1 too, not just the new gate.
    hub.visibility.set(owner, ["projects.list", "tasks.list", "clients.list", "pm.createTask", "pm.createDoc"]);
    hub.visibility.set(restricted, ["clients.list"]);

    config.services.hub = { url: hub.url, token: "hub-token", assuranceToken: "" };
    config.services.agents = { url: runner.url, token: "runner-token" };
    // ASST-23 card-state test: the executor's re-drive needs a configured grant secret to mint the
    // execution grant header (approval-execute.ts's attemptRedrive) — same pattern every other
    // executor-touching test file in this codebase uses (see d14-17-assistant-write-registry.test.ts).
    config.approvalGrantSecret = "asst-broker-test-secret-not-a-real-one";
    // The chat path is not exercised here, but leave the gateway unset-safe: a tool turn must never
    // touch it, and if it did, the resulting `not_configured` error would be loud.
    config.services.gateway = { url: "", token: "" };

    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.getHttpServer().address() as { port: number }).port;
    runner.platformBase = `http://127.0.0.1:${port}`;
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

  async function sendToolMessage(userId: string, threadId: string, content: string, agent?: string) {
    const r = await app.inject({
      method: "POST",
      url: `/api/${A}/assistant/threads/${threadId}/messages`,
      headers: asUser(userId),
      payload: { content, mode: "tools", ...(agent ? { agent } : {}) },
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

  async function toolCallRows(messageId: string) {
    const { rows } = await adminPool().query<{
      tool_name: string; status: string; authority_user_id: string; args: unknown; approval_id: string | null; mcp_server: string | null; result_summary: string | null;
    }>(
      `SELECT tool_name, status, authority_user_id, args, approval_id, mcp_server, result_summary
         FROM assistant_tool_calls WHERE message_id = $1 ORDER BY created_at, tool_name`,
      [messageId],
    );
    return rows;
  }

  // ── THE PHASE-3 GATE ────────────────────────────────────────────────────────────────────────────
  it("THE PHASE-3 GATE: a tool-using turn writes assistant_tool_calls rows ATTRIBUTABLE TO THE CHATTING USER, and the runner was invoked under that user's own OBO envelope", async () => {
    const threadId = await newThread(owner, "phase 3 gate");
    const before = runner.receivedGoals.length;
    const { messageId, streamUrl } = await sendToolMessage(owner, threadId, "TOOLRUN_OK give me a status report");
    expect(streamUrl).toContain("&mode=tools");

    const body = await readStream(streamUrl, owner);
    expect(body).toContain("event: tool_call");
    expect(body).toContain("event: tool_result");
    expect(body).toContain("event: done");

    // (1) The ledger exists and EVERY row's authority is the chatting user.
    const rows = await toolCallRows(messageId);
    expect(rows.map((r) => `${r.tool_name}:${r.status}`)).toEqual(["projects.list:succeeded", "tasks.list:failed"]);
    for (const r of rows) {
      expect(r.authority_user_id).toBe(owner);
      expect(r.mcp_server).toBe("mcp-hub");
    }

    // (2) The runner was driven under THIS user's envelope — provider pinned to 'platform',
    // externalId to the chatting user, requestedBy the same. Never a service id, never a body value.
    const goals = runner.receivedGoals.slice(before);
    expect(goals).toHaveLength(1);
    expect(goals[0].envelope).toEqual({ provider: "platform", externalId: owner });
    expect(goals[0].requestedBy).toBe(owner);
    expect(goals[0].agent).toBe("status-reporter");
    expect(goals[0].tenantId).toBe(A);
    // The bearer is the SERVICE's transport credential — it authenticates the process, it is not the
    // authority. Asserted explicitly so the distinction is documented in a test, not just a comment.
    expect(goals[0].authorization).toBe("Bearer runner-token");

    // (3) The capability gate consulted the hub as the chatting user, not as a service principal.
    const hubCalls = hub.received.filter((h) => h.method === "tools/list");
    expect(hubCalls.at(-1)).toMatchObject({ oboProvider: "platform", oboExternalId: owner, authorization: "Bearer hub-token" });

    // (4) The assistant message is finalized, visible on a fresh read, and marked as a tool turn.
    const got = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(owner) });
    const msgs = (got.json() as { messages: Array<{ role: string; content: string; errorKind: string | null; parts: unknown }> }).messages;
    expect(msgs[1]).toMatchObject({ role: "assistant", errorKind: null });
    expect(msgs[1].content).toContain("Status report");
    expect(readTurnMode(msgs[1].parts)).not.toBeNull();
  });

  // ── THE REFUSAL, PROVEN ON BOTH HALVES ──────────────────────────────────────────────────────────
  it("a tool the user lacks Cerbos rights for is REFUSED in-thread (typed + visible) AND is never executed by anyone — the runner receives ZERO requests", async () => {
    const threadId = await newThread(restricted, "refusal");
    const goalsBefore = runner.receivedGoals.length;
    const { messageId, streamUrl } = await sendToolMessage(restricted, threadId, "TOOLRUN_OK give me a status report");

    const body = await readStream(streamUrl, restricted);

    // (a) TYPED + VISIBLE on the wire: a denied tool_result per missing tool, and a typed error frame.
    expect(body).toContain('"status":"denied"');
    expect(body).toContain("projects.list");
    expect(body).toContain("event: error");
    expect(body).toContain('"errorKind":"tool_denied"');
    expect(body).not.toContain("event: done");

    // (b) NOTHING RAN, under any principal. This is the half a "the user saw an error" assertion
    // would have missed entirely: if the call had run under a service principal and merely failed,
    // the runner would have received a goal.
    expect(runner.receivedGoals.slice(goalsBefore)).toHaveLength(0);

    // (c) The decision that produced the refusal was taken under the REFUSED USER's own principal.
    const hubCalls = hub.received.filter((h) => h.method === "tools/list");
    expect(hubCalls.at(-1)).toMatchObject({ oboProvider: "platform", oboExternalId: restricted });

    // (d) The refusal is recorded as a `denied` row — still attributed to the chatting user, so an
    // audit of "who attempted this" can never point at a service identity.
    const rows = await toolCallRows(messageId);
    expect(rows.map((r) => `${r.tool_name}:${r.status}`)).toEqual(["projects.list:denied", "tasks.list:denied"]);
    for (const r of rows) expect(r.authority_user_id).toBe(restricted);
    expect(rows[0].result_summary).toContain("not authorized");

    // (e) Visible on a RELOAD, not just in the live stream — the refusal is part of the transcript.
    const got = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(restricted) });
    const msgs = (got.json() as { messages: Array<{ role: string; content: string; errorKind: string | null }> }).messages;
    expect(msgs[1].errorKind).toBe("tool_denied");
    expect(msgs[1].content).toContain("isn't authorized");
    expect(msgs[1].content).toContain("Nothing was run on your behalf");
  });

  it("an unreachable hub fails CLOSED — no visible tools means refuse, never 'assume authorized'", async () => {
    const saved = config.services.hub;
    config.services.hub = { url: "http://127.0.0.1:1", token: "hub-token", assuranceToken: "" }; // nothing listens there
    try {
      const threadId = await newThread(owner, "hub down");
      const goalsBefore = runner.receivedGoals.length;
      const { streamUrl } = await sendToolMessage(owner, threadId, "TOOLRUN_OK status please");
      const body = await readStream(streamUrl, owner);
      expect(body).toContain('"errorKind":"tool_denied"');
      expect(runner.receivedGoals.slice(goalsBefore)).toHaveLength(0);
    } finally {
      config.services.hub = saved;
    }
  });

  // ── LIVE TENANT DATA, SCOPED TO THAT USER ───────────────────────────────────────────────────────
  it("a read tool returns LIVE tenant data scoped to the chatting user — and the SAME read under a different user's envelope returns nothing of this tenant", async () => {
    const threadId = await newThread(owner, "live read");
    const { messageId, streamUrl } = await sendToolMessage(owner, threadId, "TOOLRUN_LIVE what projects do we have");
    const body = await readStream(streamUrl, owner);

    // The answer carries a project row that was INSERTED BY THIS TEST RUN — it can only have come
    // from a real, authorized, tenant-scoped read performed under the chatting user's envelope.
    expect(body).toContain("HTTP 200");
    expect(body).toContain(projectName);
    expect(body).toContain("event: done");
    const rows = await toolCallRows(messageId);
    expect(rows.map((r) => `${r.tool_name}:${r.status}`)).toEqual(["projects.list:succeeded"]);
    expect(rows[0].authority_user_id).toBe(owner);

    // The scoping half: the SAME endpoint, the SAME service transport token, a DIFFERENT (verified,
    // linked) user's envelope — a real member of a DIFFERENT company. It must not see this tenant's
    // data. Without this, "live data came back" would be equally consistent with an ambient read.
    await ensurePlatformSelfLink(outsider);
    const denied = await fetch(`http://127.0.0.1:${port}/api/${A}/projects`, {
      headers: { authorization: "Bearer svc-token", "x-obo-provider": "platform", "x-obo-external-id": outsider },
    });
    expect(denied.status).toBe(403);
    const deniedBody = await denied.text();
    expect(deniedBody).not.toContain(projectName);
  });

  // ── THE D14 WRITE PROPOSAL: real args, really redacted ──────────────────────────────────────────
  it("a suspended write surfaces `approval_required` and records a PENDING row whose args are redacted (values destroyed, shape kept)", async () => {
    const approvalId = newId();
    const secretIban = "GB33BUKB20201555555555";
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, tool_args, impact, reason, origin_site)
         VALUES ($1,$2,$3,$4,$5::jsonb,'high','suspend: high-impact write',$6)`,
        [approvalId, A, "assistant:broker", "money.transfer", JSON.stringify({ iban: secretIban, amount: 5000, note: { memo: "payroll" } }), config.originSite],
      ),
    );

    const threadId = await newThread(owner, "suspended write");
    const { messageId, streamUrl } = await sendToolMessage(owner, threadId, `TOOLRUN_SUSPEND:${approvalId} pay the invoice`);
    const body = await readStream(streamUrl, owner);

    expect(body).toContain("event: approval_required");
    expect(body).toContain(approvalId);
    expect(body).toContain('"impact":"high"');
    expect(body).toContain('"errorKind":"approval_required"');
    // The raw argument values never touch the wire either.
    expect(body).not.toContain(secretIban);

    const rows = await toolCallRows(messageId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool_name: "money.transfer", status: "pending", authority_user_id: owner, approval_id: approvalId });
    // REAL arguments, REALLY redacted: shape preserved, every value destroyed.
    expect(rows[0].args).toEqual({ iban: "[redacted:string]", amount: "[redacted:number]", note: { memo: "[redacted:string]" } });
    expect(JSON.stringify(rows[0].args)).not.toContain(secretIban);
  });

  // ── ASST-23 (§7.4/T3a) — STEP 0.5, THE REGISTRY GATE ────────────────────────────────────────────
  it("step 0.5: a write tool with NO approval-executables entry is refused BEFORE the runner is ever contacted — zero goals, typed refusal", async () => {
    // Simulate a drifted mirror: task-filer's write tools are removed from the registry (leaving only
    // the deploy.* entries), so ASSISTANT_AGENT_WRITE_TOOLS["task-filer"] names two tools this
    // process, right now, cannot execute. Restored in `finally` — this mutates a process-wide
    // singleton the rest of this file (and this suite's later tests) depend on being intact.
    resetExecutableApprovals();
    registerCoreExecutableApprovals(); // deploy.staging/production only — pm.createTask/createDoc gone
    try {
      expect(getExecutable("pm.createTask")).toBeUndefined(); // the precondition this test actually probes
      const threadId = await newThread(owner, "registry gate refusal");
      const goalsBefore = runner.receivedGoals.length;
      const { messageId, streamUrl } = await sendToolMessage(owner, threadId, "TOOLRUN_OK file a task please", "task-filer");

      const body = await readStream(streamUrl, owner);
      expect(body).toContain("event: error");
      expect(body).toContain('"errorKind":"tool_not_executable"');
      expect(body).not.toContain("event: done");

      // Provably nothing ran, under any principal — same shape as wall 1's own refusal test: the
      // runner never even received a goal, so there is no world where this executed under a service
      // principal and merely reported a failure afterwards.
      expect(runner.receivedGoals.slice(goalsBefore)).toHaveLength(0);

      const rows = await toolCallRows(messageId);
      expect(rows.map((r) => r.tool_name).sort()).toEqual(ASSISTANT_AGENT_WRITE_TOOLS["task-filer"].slice().sort());
      for (const r of rows) {
        expect(r.status).toBe("denied");
        expect(r.authority_user_id).toBe(owner); // still attributed to the chatting user, never a service id
        expect(r.approval_id).toBeNull(); // nothing was ever filed
      }

      // Visible on reload too, not just the live stream.
      const got = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(owner) });
      const msgs = (got.json() as { messages: Array<{ errorKind: string | null }> }).messages;
      expect(msgs[1].errorKind).toBe("tool_not_executable");
    } finally {
      registerPmExecutableApprovals(); // restore pm.createTask/pm.createDoc for every test after this one
    }
  });

  // ── ASST-23 (§7.4/T3a) — THE CARD-STATE JOIN, END TO END ────────────────────────────────────────
  it("card state: a suspended origin='agent' pm.createTask, once decided AND executed, shows up EXECUTED on a fresh GET thread — via the real decide() endpoint and the real executor, never a second implementation", async () => {
    const projectId = await createProject(A, `Card State Project ${Date.now()}`);
    const approvalId = newId();
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO automation_approvals
           (id, tenant_id, workflow_id, tool_name, tool_args, impact, reason, requested_by, origin, agent_name, origin_site)
         VALUES ($1,$2,'task-filer','pm.createTask',$3::jsonb,'high','suspend: high-impact write',$4,'agent','task-filer',$5)`,
        [approvalId, A, JSON.stringify({ tenantId: A, projectId, title: "Filed via the assistant broker (card-state test)" }), owner, config.originSite],
      ),
    );

    const threadId = await newThread(owner, "card state");
    const { messageId, streamUrl } = await sendToolMessage(owner, threadId, `TOOLRUN_SUSPEND:${approvalId} file this task`, "task-filer");
    const body = await readStream(streamUrl, owner);
    expect(body).toContain("event: approval_required");
    expect(body).toContain(approvalId);

    // Pre-decision: the ledger row is `pending`, joined to an approval that is itself still `pending`
    // for DECISION and, per migration 0078's column DEFAULT, still `not_applicable` for EXECUTION —
    // `decide()` (below) is what first flips execution_status to 'pending' once it sees a registered
    // tool. Asserting the default here (not guessing 'pending') is the "a column a SELECT omits reads
    // exactly like NULL" discipline applied to a state transition: get the PRE-state right or the
    // POST-state assertion proves nothing.
    const preDecision = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(owner) });
    const preMsgs = (preDecision.json() as { messages: Array<{ toolCalls: Array<{ toolName: string; status: string; approvalId: string | null; approval: { status: string; executionStatus: string } | null }> }> }).messages;
    expect(preMsgs[1].toolCalls).toHaveLength(1);
    expect(preMsgs[1].toolCalls[0]).toMatchObject({ toolName: "pm.createTask", status: "pending", approvalId, approval: { status: "pending", executionStatus: "not_applicable" } });

    // The human decides — the REAL endpoint, as the REAL company_admin decider, exactly as a person
    // would from the approvals inbox. This is D14's existing surface; ASST-23 adds no new one.
    const decideRes = await app.inject({
      method: "POST", url: `/api/${A}/automation-approvals/${approvalId}/decide`, headers: asUser(admin), payload: { decision: "approved" },
    });
    expect(decideRes.statusCode).toBe(200);

    // Drive the executor directly rather than waiting on a live Redis-backed outbox consumer — the
    // SAME entry point the outbox handler and D14-07's retry call (approval-execute.ts), same pattern
    // d14-09/d14-17's own suites use to prove decide()->execute without standing up a relay.
    const outcome = await executeApprovedAutomationWrite(A, approvalId);
    expect(outcome.status).toBe("executed");

    const postDecision = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(owner) });
    const postMsgs = (postDecision.json() as { messages: Array<{ toolCalls: Array<{ toolName: string; approvalId: string | null; approval: { status: string; executionStatus: string; executionError: string | null } | null }> }> }).messages;
    expect(postMsgs[1].toolCalls).toHaveLength(1);
    expect(postMsgs[1].toolCalls[0]).toMatchObject({
      toolName: "pm.createTask",
      approvalId,
      approval: { status: "approved", executionStatus: "executed", executionError: null },
    });
    // The ledger row's OWN status column is untouched by decide/execute — it is a read-time join, not
    // a mutation of the transcript (§2.5's own invariant, restated as a live assertion here).
    const rawRow = await toolCallRows(messageId);
    expect(rawRow[0].status).toBe("pending");
  });

  it("a failed tool run persists a typed error_kind and still attributes every row to the chatting user", async () => {
    const threadId = await newThread(owner, "failed run");
    const { streamUrl } = await sendToolMessage(owner, threadId, "TOOLRUN_FAIL do something forbidden");
    const body = await readStream(streamUrl, owner);
    expect(body).toContain('"errorKind":"ToolNotAllowedError"');
    expect(body).not.toContain("event: done");
    const got = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(owner) });
    const msgs = (got.json() as { messages: Array<{ errorKind: string | null; content: string }> }).messages;
    expect(msgs[1].errorKind).toBe("ToolNotAllowedError");
    expect(msgs[1].content).toContain("allow-list");
  });

  // ── OWNER-PRIVATE, END TO END, INCLUDING THE TOOL TRANSCRIPT ────────────────────────────────────
  it("the tool-turn transcript stays OWNER-PRIVATE: a different same-company user AND a company_admin are both denied on read, send and stream", async () => {
    const threadId = await newThread(owner, "privacy after tools");
    const { messageId, streamUrl } = await sendToolMessage(owner, threadId, "TOOLRUN_OK status report");
    await readStream(streamUrl, owner);
    expect((await toolCallRows(messageId)).length).toBeGreaterThan(0);

    for (const intruder of [other, admin]) {
      const read = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(intruder) });
      expect(read.statusCode).toBe(403);
      const send = await app.inject({
        method: "POST", url: `/api/${A}/assistant/threads/${threadId}/messages`, headers: asUser(intruder), payload: { content: "let me in", mode: "tools" },
      });
      expect(send.statusCode).toBe(403);
      const list = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads`, headers: asUser(intruder) });
      expect(list.statusCode).toBe(200);
      expect((list.json() as { items: Array<{ id: string }> }).items.map((t) => t.id)).not.toContain(threadId);
    }

    // The stream half needs a PENDING placeholder to even reach the owner check — a fresh send, then
    // an intruder opening the stream URL. 403, never a degraded view.
    const fresh = await sendToolMessage(owner, threadId, "TOOLRUN_OK second turn");
    for (const intruder of [other, admin]) {
      const res = await fetch(`http://127.0.0.1:${port}${fresh.streamUrl}`, { headers: asUser(intruder) });
      expect(res.status).toBe(403);
      await res.text();
    }
    // Owner drains it so the thread isn't left wedged for the next test in this file.
    await readStream(fresh.streamUrl, owner);
  });

  // ── THE COLUMN-LEVEL INVARIANT, SWEPT ACROSS EVERYTHING THIS FILE WROTE ─────────────────────────
  it("assistant_tool_calls.authority_user_id is a CHATTING USER on every row this suite produced — never a service identity", async () => {
    const { rows } = await adminPool().query<{ authority_user_id: string; n: number }>(
      `SELECT authority_user_id, count(*)::int AS n FROM assistant_tool_calls WHERE tenant_id = $1 GROUP BY 1`,
      [A],
    );
    expect(rows.length).toBeGreaterThan(0);
    const authorities = rows.map((r) => r.authority_user_id);
    // Exactly the two humans who chatted in this file, and nobody else.
    expect(new Set(authorities)).toEqual(new Set([owner, restricted]));
    expect(authorities).not.toContain(automationUser);
    expect(authorities).not.toContain(other);
    expect(authorities).not.toContain(admin);
    expect(authorities).not.toContain(outsider);
  });

  it("persistToolCalls REFUSES a non-user authority outright rather than writing the row", async () => {
    const threadId = await newThread(owner, "authority guard");
    const { messageId } = await sendToolMessage(owner, threadId, "TOOLRUN_OK guard probe");
    // Drain so the thread isn't wedged; the placeholder is irrelevant to this assertion.
    await readStream(`/api/${A}/assistant/threads/${threadId}/stream?messageId=${messageId}`, owner);

    for (const bad of ["", "svc-token", "wf:new-client-seed"]) {
      await expect(
        withTenants(
          [A],
          (c) =>
            persistToolCalls(c, {
              tenantId: A,
              messageId,
              authorityUserId: bad,
              calls: [{ id: newId(), toolName: "projects.list", mcpServer: "mcp-hub", args: {}, status: "succeeded", resultSummary: null, approvalId: null, durationMs: null }],
            }),
          { modules: ["assistant"] },
        ),
      ).rejects.toThrow(ServicePrincipalRefusedError);
    }
  });

  it("rejects an unknown tool agent at send time (400) rather than discovering it mid-stream", async () => {
    const threadId = await newThread(owner, "bad agent");
    const r = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads/${threadId}/messages`, headers: asUser(owner), payload: { content: "hi", mode: "tools", agent: "task-triager" },
    });
    expect(r.statusCode).toBe(400);
    const bad = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads/${threadId}/messages`, headers: asUser(owner), payload: { content: "hi", mode: "agentic" },
    });
    expect(bad.statusCode).toBe(400);
  });
});
