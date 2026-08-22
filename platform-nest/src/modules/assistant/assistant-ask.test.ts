// AGN-6 · `orchestrator.ask` — the golden case for the assistant's first MCP-reachable capability.
//
// WHY THIS FILE MATTERS BEYOND COVERAGE. The assistant contributed ZERO tools until now, which was
// correct: it had no authorized execution path, and advertising a tool without one is the hazard its
// own contract file warns about. `POST :tenantId/assistant/ask` is that path, and this suite is what
// makes registering the tool honest rather than a claim — readiness-bar criterion 7 ("a fixture
// exercising the capability end-to-end", failing when "no test drives the real endpoint").
//
// Uses the fake gateway pattern established by `assistant-stream.test.ts`: no test here may depend on
// the real ai-gateway-go binary, and a deterministic fake reproducing the shipped frame grammar is
// this program's own stated preference.
//
// ⚠ Needs DATABASE_URL_TEST and a live Cerbos. Skips silently otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createServer, type Server } from "node:http";
import { config } from "../../config";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";

const live = !!process.env.CERBOS_URL;

let app: NestFastifyApplication;
let gateway: Server;
let gatewayUrl: string;
let tenant: string;
let owner: string;
let stranger: string;

// The service token is required alongside `x-user-id` — the dev-login path sits INSIDE the
// service-token branch of the guard, which is why a bare x-user-id 401s. Same shape as
// assistant-stream.test.ts.
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

/** Minimal ASST-10-shaped SSE gateway: two token frames then done. */
async function startFakeGateway(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    res.write(`event: meta\ndata: ${JSON.stringify({ provider: "fake", model: "fake-1" })}\n\n`);
    // ⚠ A TOKEN IS AN UNNAMED SSE FRAME — `data:` with NO `event:` line — and its data is a JSON
    // STRING, not an object. Two wrong guesses cost real time here: `{"text": "..."}` (parsed to an
    // object) and `event: token` (a NAMED event, which falls through the parser's default branch and
    // is ignored). Both produced an empty answer with a perfectly healthy-looking transport, so the
    // endpoint under test appeared broken when the fake was. Matches
    // assistant-stream.test.ts's fake, which is the grammar of record.
    res.write(`data: ${JSON.stringify("Berlin")}\n\n`);
    res.write(`data: ${JSON.stringify(" it is.")}\n\n`);
    res.write(`event: done\ndata: {}\n\n`);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { server, url: `http://127.0.0.1:${port}` };
}

describe.skipIf(!TEST_URL || !live)("AGN-6 · orchestrator.ask (POST /assistant/ask)", () => {
  beforeAll(async () => {
    await initTestDb();
    tenant = await createCompany("Ask Co", ["assistant"]);
    owner = await createUser("ask-owner@a.test");
    stranger = await createUser("ask-stranger@b.test");
    const memberRole = await createRole("member");
    await addMembership(tenant, owner);
    await grantRole(owner, memberRole, "company", tenant);

    // The guard's dev-login branch sits INSIDE the service-token check, so the token must be set
    // on config as well as sent — assistant-stream.test.ts does the same.
    config.serviceToken = "svc-token";

    const g = await startFakeGateway();
    gateway = g.server;
    gatewayUrl = g.url;
    config.services.gateway = { url: gatewayUrl, token: "gw-token" };
    config.assistant.streamIdleTimeoutMs = 4000;

    app = await buildApp();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await new Promise<void>((r) => gateway?.close(() => r()));
    await teardownTestDb();
  });

  const ask = (body: unknown, headers = asUser(owner)) =>
    app.inject({ method: "POST", url: `/api/${tenant}/assistant/ask`, headers, payload: body as object });

  it("🔴 answers synchronously AND leaves a reviewable thread behind", async () => {
    const res = await ask({ question: "What is the capital of Germany?" });
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json() as { ok: boolean; answer: string; threadId: string; messageId: string; provider: string | null };
    expect(out.ok).toBe(true);
    expect(out.answer).toBe("Berlin it is.");
    // The provider is the ACTUAL server that answered, never the requested one — the property that
    // makes the badge truthful on the chat surface, and it must hold here too.
    expect(out.provider).toBe("fake");

    // The audit half, which is the reason this endpoint creates a real thread rather than answering
    // into the void: an agent's conversation must be exactly as reviewable afterwards as a human's.
    const rows = await adminPool().query<{ role: string; content: string | null }>(
      `SELECT role, content FROM assistant_messages WHERE thread_id = $1 ORDER BY seq`,
      [out.threadId],
    );
    expect(rows.rows.map((r) => r.role)).toEqual(["user", "assistant"]);
    expect(rows.rows[0].content).toBe("What is the capital of Germany?");
    expect(rows.rows[1].content).toBe("Berlin it is.");
  });

  it("continues an existing thread when given its id, rather than opening a second one", async () => {
    const first = (await ask({ question: "First question" })).json() as { threadId: string };
    const second = await ask({ question: "Second question", threadId: first.threadId });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { threadId: string }).threadId).toBe(first.threadId);
    const n = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM assistant_messages WHERE thread_id = $1`,
      [first.threadId],
    );
    expect(Number(n.rows[0].n)).toBe(4); // two turns, user+assistant each
  });

  it("refuses an empty question rather than spending budget on nothing", async () => {
    expect((await ask({ question: "   " })).statusCode).toBe(400);
    expect((await ask({})).statusCode).toBe(400);
  });

  it("a stranger to the tenant cannot ask — the same Cerbos actions the chat surface uses", async () => {
    // Positive control is the first test above: `owner` CAN ask. Without it this could pass against
    // an endpoint that refuses everyone.
    const res = await ask({ question: "Anything" }, asUser(stranger));
    expect([403, 404]).toContain(res.statusCode);
  });

  it("continuing someone else's thread is refused, not silently answered into", async () => {
    const mine = (await ask({ question: "Mine" })).json() as { threadId: string };
    const res = await ask({ question: "Yours now" }, asUser(stranger));
    expect([403, 404]).toContain(res.statusCode);
    // And the other user's thread is untouched by the attempt.
    const n = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM assistant_messages WHERE thread_id = $1`,
      [mine.threadId],
    );
    expect(Number(n.rows[0].n)).toBe(2);
  });

  it("rejects an over-long question at the same limit the chat surface enforces", async () => {
    const res = await ask({ question: "x".repeat(20_001) });
    expect(res.statusCode).toBe(400);
  });

  it("an unknown threadId is a 404, not a new thread created behind the caller's back", async () => {
    const res = await ask({ question: "Hi", threadId: "00000000-0000-0000-0000-0000000000ff" });
    expect(res.statusCode).toBe(404);
  });
});
