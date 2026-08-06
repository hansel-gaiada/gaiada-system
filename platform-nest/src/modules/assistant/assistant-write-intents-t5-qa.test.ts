// T5 (QA gate) — an ADVERSARIAL scenario T3b's own suite did not cover: confirm and dismiss racing
// each other on the SAME draft, genuinely concurrently (not two sequential calls). T3b's 8-way race
// (assistant-write-intents.test.ts) only ever fires 8x the SAME operation (confirm-vs-confirm); this
// file asks the harder question — what happens when a user double-taps two different buttons (or two
// tabs disagree) at once. The claim SQL (`UPDATE ... WHERE status='draft' ...`) should make exactly one
// of the two directions win, with the loser observing the winner's terminal state, never a corrupted
// or straddled row.
//
// Independent from assistant-write-intents.test.ts: separate fixtures, separate fake hub/runner, so a
// bug specific to test ordering/fixture reuse in that file would not be masked here.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { assistantModule } from "./index";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

function intentMarker(tool: string, impact: string, args: Record<string, unknown>): string {
  return `INTENT:${Buffer.from(JSON.stringify({ tool, impact, args })).toString("base64")}`;
}

async function startFakeHub() {
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
          /* ignore */
        }
        const oboExternalId = req.headers["x-obo-external-id"] as string | undefined;
        res.writeHead(200, { "content-type": "application/json" });
        if (method === "tools/call") {
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ text: "ok (fake hub)" }] } }));
          return;
        }
        const tools = (oboExternalId ? visibility.get(oboExternalId) : undefined) ?? [];
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: tools.map((name) => ({ name, description: name, inputSchema: { type: "object" } })) } }));
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

async function startFakeRunner() {
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
        let body: { goal?: string } = {};
        try {
          body = JSON.parse(raw) as { goal?: string };
        } catch {
          /* ignore */
        }
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
        const decoded = JSON.parse(Buffer.from(intentMatch[1], "base64").toString("utf8")) as { tool: string; impact: string; args: Record<string, unknown> };
        return json(200, { id: goalMatch[1], status: "suspended", outcome: "suspended", errorKind: "approval_required", approvalId: null, suspendedIntent: decoded, runs: [] });
      }
      return json(200, { id: goalMatch[1], status: "ok", outcome: "ok", errorKind: null, approvalId: null, runs: [] });
    }
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
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe.skipIf(!TEST_URL)("T5 QA — confirm/dismiss racing EACH OTHER (mixed-op genuine concurrency)", () => {
  let app: NestFastifyApplication;
  let hub: ReturnType<typeof startFakeHub> extends Promise<infer T> ? T : never;
  let runner: ReturnType<typeof startFakeRunner> extends Promise<infer T> ? T : never;
  let A: string;
  let owner: string;
  let admin: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(assistantModule);

    A = await createCompany("T5 QA Mixed-Race Tenant", ["assistant"]);
    owner = await createUser("t5qa-owner@test");
    admin = await createUser("t5qa-admin@test");
    await addMembership(A, owner);
    await addMembership(A, admin);
    const adminRole = await createRole("company_admin");
    await grantRole(admin, adminRole, "company", A);

    hub = await startFakeHub();
    runner = await startFakeRunner();
    hub.visibility.set(owner, ["projects.list", "tasks.list", "pm.createTask", "pm.createDoc"]);

    config.services.hub = { url: hub.url, token: "hub-token", assuranceToken: "" };
    config.services.agents = { url: runner.url, token: "runner-token" };
    config.approvalGrantSecret = "t5qa-test-secret-not-a-real-one";
    config.services.gateway = { url: "", token: "" };
    config.assistantIntentTtlMs = 60 * 60 * 1000;

    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app.close();
    await hub.close();
    await runner.close();
    await teardownTestDb();
  });

  it("4 confirms + 4 dismisses fired in one Promise.all against the SAME draft: exactly one direction wins, never both, never a straddled row", async () => {
    const threadId = (
      await app.inject({ method: "POST", url: `/api/${A}/assistant/threads`, headers: asUser(owner), payload: { title: "mixed race" } })
    ).json().id as string;

    const { streamUrl } = (
      await app.inject({
        method: "POST",
        url: `/api/${A}/assistant/threads/${threadId}/messages`,
        headers: asUser(owner),
        payload: { content: intentMarker("pm.createTask", "high", { tenantId: A, projectId: newId(), title: "mixed race task" }), mode: "tools", agent: "task-filer" },
      })
    ).json() as { streamUrl: string };
    // Drain the stream so the tool-call/intent row is persisted before racing.
    const port = (app.getHttpServer().address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}${streamUrl}`, { headers: asUser(owner) });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }

    const msgs = (await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(owner) })).json().messages;
    const callId = msgs[1].toolCalls[0].id as string;

    const before = await adminPool().query<{ n: string }>(`SELECT count(*)::int AS n FROM automation_approvals WHERE tenant_id = $1`, [A]);

    const ops = [
      ...Array.from({ length: 4 }, () => ({ method: "POST" as const, url: `/api/${A}/assistant/threads/${threadId}/tool-calls/${callId}/confirm`, headers: asUser(owner) })),
      ...Array.from({ length: 4 }, () => ({ method: "POST" as const, url: `/api/${A}/assistant/threads/${threadId}/tool-calls/${callId}/dismiss`, headers: asUser(owner) })),
    ];
    const results = await Promise.all(ops.map((o) => app.inject(o)));

    const statuses = results.map((r) => r.statusCode);
    const twoHundreds = statuses.filter((s) => s === 200).length;
    const fourOhNines = statuses.filter((s) => s === 409).length;
    // No 5xx / corruption: every one of the 8 racers resolves to either 200 or 409.
    expect(twoHundreds + fourOhNines).toBe(8);
    expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);
    // NOTE (confirmed by reading write-intents.ts + T3b's own 8-way SAME-direction race, not assumed):
    // confirm and dismiss are EACH idempotent among repeats of themselves once the row is terminal in
    // their own direction (a "loser" that observes the row already filed/dismissed the way IT wanted
    // gets the current state back as 200, per resolveLostClaim) — but refused typed (409) once the row
    // is terminal in the OPPOSITE direction. So if DISMISS wins, all 4 dismiss calls read 200 and all 4
    // confirm calls read 409 ("confirm after dismiss"); if CONFIRM wins, all 4 confirm calls read 200
    // and all 4 dismiss calls read 409 ("dismiss after confirm") — a clean, fully symmetric split, never
    // a mix within one direction.
    const confirmResults = results.slice(0, 4).map((r) => r.statusCode);
    const dismissResults = results.slice(4, 8).map((r) => r.statusCode);
    const dismissWon = dismissResults.every((s) => s === 200) && confirmResults.every((s) => s === 409);
    const confirmWon = confirmResults.every((s) => s === 200) && dismissResults.every((s) => s === 409);
    if (!dismissWon && !confirmWon) {
      throw new Error(`neither clean split observed — confirmResults=${JSON.stringify(confirmResults)} dismissResults=${JSON.stringify(dismissResults)}`);
    }
    expect(dismissWon || confirmWon).toBe(true);
    expect(dismissWon && confirmWon).toBe(false); // never both directions simultaneously "won"

    const finalRow = await adminPool().query<{ status: string; tool_args: unknown; approval_id: string | null }>(
      `SELECT status, tool_args, approval_id FROM assistant_write_intents WHERE tool_call_id = $1`,
      [callId],
    );
    expect(finalRow.rows).toHaveLength(1);
    expect(["filed", "dismissed"]).toContain(finalRow.rows[0].status);
    // Whichever direction won, tool_args is scrubbed either way (filed scrubs on confirm, dismiss
    // scrubs on dismiss) — never left holding the real args after the row is terminal.
    expect(finalRow.rows[0].tool_args).toBeNull();

    const after = await adminPool().query<{ n: string }>(`SELECT count(*)::int AS n FROM automation_approvals WHERE tenant_id = $1`, [A]);
    const filed = finalRow.rows[0].status === "filed";
    expect(Number(after.rows[0].n) - Number(before.rows[0].n)).toBe(filed ? 1 : 0);
    expect(filed).toBe(finalRow.rows[0].approval_id !== null);
  });
});
