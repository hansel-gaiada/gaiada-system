// ASST-06 — the send->stream engine, against live Postgres + Cerbos (skips without
// DATABASE_URL_TEST/CERBOS_URL). Exercises `POST .../messages`, `GET .../stream` and
// `POST .../stop` through real HTTP: negative-auth cases via `app.inject` (no real socket needed
// — authorize() throws before `reply.raw` is ever touched, same property portal-stream.controller
// already relies on), and every true-streaming case via a REAL listener + real `fetch`
// (`app.inject()` cannot drive an SSE route: it resolves only when the response completes, and
// this route deliberately never completes one on its own until the generation ends — see
// core/portal-dashboard.test.ts's own comment on the identical constraint).
//
// Gateway double: a small Node `http` server reproducing the ASST-10 wire grammar byte-for-byte
// (`data: "<json string>"` for tokens, `event: error`/`{"error":string}`, `event: done`/`{}`) —
// deterministic and fast, per the ticket's own preference ("prefer a fake/local gateway for
// determinism"). Its behaviour per call is driven by markers embedded in the SENT MESSAGE content
// (which context.ts renders verbatim into the prompt as "User: <content>"), so one server instance
// covers every scenario without per-test port juggling.
//
// Ticket: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md ("### ASST-06").
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { assembleContext } from "./context";
import { assistantModule } from "./index";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 20): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

/** The ASST-10-shaped fake gateway. Behaviour is selected by markers inside the rendered prompt:
 *   PROBE:<id>          — records into `abortedProbes` whether the CLIENT (platform-nest, i.e. us)
 *                          disconnected before this response ended. THE assertion instrument for
 *                          "stop cancels the upstream" — a direct observation, not an inference.
 *   SIMULATE_DELAY:<ms> — per-token delay (default 20ms).
 *   SIMULATE_IDLE       — send response headers, then NEVER write a byte (idle-timeout probe).
 *   SIMULATE_ERROR:<m>  — after the 3 tokens, emit `event: error` with message <m> instead of `done`.
 *   SIMULATE_ABNORMAL_DROP — after the 3 tokens, close the connection with NEITHER `done` NOR `error`.
 *   SIMULATE_META:<provider>:<model> — (ASST-11/12) emit `event: meta` before the first token,
 *                          naming <provider>/<model> (an empty <model> segment sends `model: ""`).
 *   SIMULATE_USAGE:<p>:<c> — (ASST-11/12) emit a terminal `event: usage` with promptTokens=<p>,
 *                          completionTokens=<c>, immediately before `done`.
 *   (default)           — 3 tokens ("Hello ", "there ", "friend"), then `event: done`. No meta/
 *                          usage frame at all by default — this is the ASST-10-shaped gateway most
 *                          providers (echo/openai/gemini/claude) still look like, the common path
 *                          ASST-12 must handle as "unknown provider", never an error. */
interface FakeGateway {
  url: string;
  close: () => Promise<void>;
  abortedProbes: Map<string, boolean>;
}

async function startFakeGateway(): Promise<FakeGateway> {
  const abortedProbes = new Map<string, boolean>();
  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/complete/stream") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        let prompt = "";
        try {
          prompt = (JSON.parse(raw) as { prompt?: string }).prompt ?? "";
        } catch {
          // ignore — an unparsable body is not this fake's concern
        }
        res.writeHead(200, { "content-type": "text/event-stream" });

        const probeId = /PROBE:(\S+)/.exec(prompt)?.[1];
        if (probeId) {
          abortedProbes.set(probeId, false);
          req.on("close", () => {
            if (!res.writableEnded) abortedProbes.set(probeId, true);
          });
        }

        if (prompt.includes("SIMULATE_IDLE")) return; // headers sent, body never written — hangs on purpose

        const delayMs = Number(/SIMULATE_DELAY:(\d+)/.exec(prompt)?.[1] ?? "20");
        const errorMsg = /SIMULATE_ERROR:(\S+)/.exec(prompt)?.[1];
        const abnormalDrop = prompt.includes("SIMULATE_ABNORMAL_DROP");
        const metaMatch = /SIMULATE_META:(\S*?):(\S*)/.exec(prompt);
        const usageMatch = /SIMULATE_USAGE:(\d+):(\d+)/.exec(prompt);
        const unknownEvent = prompt.includes("SIMULATE_UNKNOWN_EVENT");

        void (async () => {
          if (unknownEvent) {
            // A future grammar-v3+ frame this platform-nest build has never heard of — the
            // additive-event contract requires it to be ignored, never mis-parsed as a token or
            // thrown as an error (see stream.ts's parseGatewayStream header).
            res.write(`event: tool_call\ndata: ${JSON.stringify({ unexpected: true })}\n\n`);
          }
          if (metaMatch) {
            res.write(`event: meta\ndata: ${JSON.stringify({ provider: metaMatch[1], model: metaMatch[2] })}\n\n`);
          }
          const tokens = ["Hello ", "there ", "friend"];
          for (const tok of tokens) {
            if (res.writableEnded || res.destroyed) return;
            res.write(`data: ${JSON.stringify(tok)}\n\n`);
            await sleep(delayMs);
          }
          if (res.writableEnded || res.destroyed) return;
          if (errorMsg) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: errorMsg })}\n\n`);
            res.end();
            return;
          }
          if (abnormalDrop) {
            res.end(); // deliberately no terminal event at all
            return;
          }
          if (usageMatch) {
            res.write(`event: usage\ndata: ${JSON.stringify({ promptTokens: Number(usageMatch[1]), completionTokens: Number(usageMatch[2]) })}\n\n`);
          }
          res.write(`event: done\ndata: {}\n\n`);
          res.end();
        })();
      });
      return;
    }
    if (req.method === "POST" && req.url === "/complete") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: "a compact summary of the folded excerpt", provider: "echo" }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    abortedProbes,
  };
}

describe.skipIf(!TEST_URL)("Assistant send->stream engine (ASST-06)", () => {
  let app: NestFastifyApplication;
  let port: number;
  let gateway: { url: string; close: () => Promise<void>; abortedProbes: Map<string, boolean> };
  let A: string;
  let owner: string;
  let other: string;
  let admin: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(assistantModule);

    A = await createCompany("Assistant Stream Tenant A", ["assistant"]);
    owner = await createUser("owner@asst-stream.test");
    other = await createUser("other@asst-stream.test");
    admin = await createUser("admin@asst-stream.test");
    await addMembership(A, owner);
    await addMembership(A, other);
    await addMembership(A, admin);
    const companyAdminRole = await createRole("company_admin");
    const memberRole = await createRole("member");
    await grantRole(admin, companyAdminRole, "company", A);
    await grantRole(other, memberRole, "company", A);
    await grantRole(owner, memberRole, "company", A);

    // Fake gateway FIRST, then point config.services.gateway at it, then build+listen the app —
    // no test in this file may rely on the real ai-gateway-go binary (none is running in this
    // environment; a fake reproducing the shipped ASST-10 grammar is the ticket's own preferred,
    // deterministic choice).
    gateway = await startFakeGateway();

    config.services.gateway = { url: gateway.url, token: "gw-token" };
    // Generous default so token cadence (20ms x 3 = ~60ms) never trips it; the one test that wants
    // a SHORT idle timeout overrides and restores this around itself.
    config.assistant.streamIdleTimeoutMs = 2000;

    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.getHttpServer().address() as { port: number }).port;
  });
  afterAll(async () => {
    await app.close();
    await gateway.close();
    await teardownTestDb();
  });

  async function sendMessage(threadId: string, content: string, headers: Record<string, string> = asUser(owner)) {
    return app.inject({
      method: "POST",
      url: `/api/${A}/assistant/threads/${threadId}/messages`,
      headers,
      payload: { content },
    });
  }

  async function newThread(title: string): Promise<string> {
    const r = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads`, headers: asUser(owner), payload: { title },
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  }

  async function openStream(streamUrl: string, headers: Record<string, string> = asUser(owner)) {
    return fetch(`http://127.0.0.1:${port}${streamUrl}`, { headers });
  }

  async function readAll(res: Response): Promise<string> {
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

  it("POST returns {messageId, streamUrl}; the stream yields >=3 token events then done; the assistant row persists at the right seq; re-GET replays the exact transcript", async () => {
    const threadId = await newThread("normal flow");
    const sent = await sendMessage(threadId, "Hi there, please respond.");
    expect(sent.statusCode).toBe(201);
    const { messageId, streamUrl } = sent.json() as { messageId: string; streamUrl: string };
    expect(messageId).toBeTruthy();
    expect(streamUrl).toBe(`/api/${A}/assistant/threads/${threadId}/stream?messageId=${messageId}`);

    const res = await openStream(streamUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const body = await readAll(res);

    const tokenCount = body.split("event: token\n").length - 1;
    expect(tokenCount).toBeGreaterThanOrEqual(3);
    expect(body).toContain("event: done\ndata: {}");
    expect(body).not.toContain("event: error");

    const got = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(owner) });
    expect(got.statusCode).toBe(200);
    const gotBody = got.json() as { messages: Array<{ seq: number; role: string; content: string; errorKind: string | null; tokens: number | null; provider: string | null; model: string | null }> };
    expect(gotBody.messages).toHaveLength(2);
    expect(gotBody.messages[0]).toMatchObject({ seq: 1, role: "user", content: "Hi there, please respond." });
    expect(gotBody.messages[1]).toMatchObject({ seq: 2, role: "assistant", content: "Hello there friend", errorKind: null });
    expect(gotBody.messages[1].tokens).toBeGreaterThan(0);
    // ASST-12: this fake gateway never sent `event: meta` — the common path (echo/openai/gemini/
    // claude report nothing). provider/model stay NULL, the honest "unknown provider" state — not
    // an error, and no different from ASST-06's original behaviour before ASST-11 existed.
    expect(gotBody.messages[1].provider).toBeNull();
    expect(gotBody.messages[1].model).toBeNull();

    // Re-GET (a second, independent read) replays byte-identical content — proves persistence, not
    // just an in-memory echo of what the SSE stream happened to carry.
    const again = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(owner) });
    expect((again.json() as { messages: Array<{ content: string }> }).messages[1].content).toBe("Hello there friend");

    // The finalized placeholder no longer matches the "pending" precondition, so re-opening the
    // SAME messageId 404s instead of silently re-streaming or hanging.
    const reopened = await openStream(streamUrl);
    expect(reopened.status).toBe(404);
  });

  // ── ASST-12: consuming ASST-11's additive `event: meta` / terminal `event: usage` ────────────────
  it("`meta` arrives -> persists non-null provider/model and relays a `meta` frame to our own client before any token", async () => {
    const threadId = await newThread("meta probe");
    const sent = await sendMessage(threadId, "SIMULATE_META:ollama:llama3.2 please respond");
    const { messageId, streamUrl } = sent.json() as { messageId: string; streamUrl: string };

    const res = await openStream(streamUrl);
    const body = await readAll(res);
    expect(body).toContain('event: meta\ndata: {"provider":"ollama","model":"llama3.2"}');
    // Load-bearing ordering: meta committed to OUR wire before the first token frame, mirroring
    // ASST-11's own gateway-side invariant.
    expect(body.indexOf("event: meta")).toBeLessThan(body.indexOf("event: token"));
    expect(body).not.toContain("event: error");

    const got = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(owner) });
    const msg = (got.json() as { messages: Array<{ id: string; provider: string | null; model: string | null }> }).messages
      .find((m) => m.id === messageId)!;
    expect(msg.provider).toBe("ollama");
    expect(msg.model).toBe("llama3.2");
  });

  it("a provider with no fixed-model concept reports model:\"\" — persisted and relayed as an empty string, never null and never dropped", async () => {
    const threadId = await newThread("meta empty-model probe");
    const sent = await sendMessage(threadId, "SIMULATE_META:echo: please respond");
    const { messageId, streamUrl } = sent.json() as { messageId: string; streamUrl: string };
    const res = await openStream(streamUrl);
    const body = await readAll(res);
    expect(body).toContain('event: meta\ndata: {"provider":"echo","model":""}');

    const got = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(owner) });
    const msg = (got.json() as { messages: Array<{ id: string; provider: string | null; model: string | null }> }).messages
      .find((m) => m.id === messageId)!;
    expect(msg.provider).toBe("echo");
    expect(msg.model).toBe(""); // truthful absence, distinct from NULL (no meta at all)
  });

  it("real `usage` OVERRIDES the ~4-chars/token estimate — persisted tokens = promptTokens+completionTokens, and the relayed `usage` frame labels source:'provider'", async () => {
    const threadId = await newThread("real usage probe");
    const sent = await sendMessage(threadId, "SIMULATE_META:ollama:llama3.2 SIMULATE_USAGE:37:41 please respond");
    const { messageId, streamUrl } = sent.json() as { messageId: string; streamUrl: string };
    const res = await openStream(streamUrl);
    const body = await readAll(res);

    const usageLine = body.split("\n\n").find((b) => b.startsWith("event: usage"))!;
    const usagePayload = JSON.parse(usageLine.split("data: ")[1]) as { tokens: number; source: string; promptTokens: number; completionTokens: number };
    expect(usagePayload).toMatchObject({ tokens: 78, source: "provider", promptTokens: 37, completionTokens: 41 });

    const got = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(owner) });
    const msg = (got.json() as { messages: Array<{ id: string; tokens: number | null; provider: string | null }> }).messages
      .find((m) => m.id === messageId)!;
    expect(msg.tokens).toBe(78); // the REAL total, not the char-count estimate
    expect(msg.provider).toBe("ollama");
  });

  it("absent usage (no SIMULATE_USAGE marker) keeps the relayed `usage` frame labelled source:'estimate' — never presented as a measurement", async () => {
    const threadId = await newThread("estimate-labelled probe");
    const sent = await sendMessage(threadId, "please respond, no usage marker here");
    const { streamUrl } = sent.json() as { messageId: string; streamUrl: string };
    const res = await openStream(streamUrl);
    const body = await readAll(res);

    const usageLine = body.split("\n\n").find((b) => b.startsWith("event: usage"))!;
    const usagePayload = JSON.parse(usageLine.split("data: ")[1]) as { source: string; promptTokens?: number; completionTokens?: number };
    expect(usagePayload.source).toBe("estimate");
    expect(usagePayload.promptTokens).toBeUndefined();
    expect(usagePayload.completionTokens).toBeUndefined();
  });

  it("an unrecognised/future SSE event type on the gateway wire is ignored — the stream still completes cleanly, zero errors", async () => {
    const threadId = await newThread("unknown event probe");
    const sent = await sendMessage(threadId, "SIMULATE_UNKNOWN_EVENT please respond");
    const { messageId, streamUrl } = sent.json() as { messageId: string; streamUrl: string };
    const res = await openStream(streamUrl);
    const body = await readAll(res);
    // The unknown `tool_call` frame the fake gateway wrote first never surfaces as a token, an
    // error, or anything at all on OUR wire — it is silently dropped, and the reply still
    // completes normally right after it.
    expect(body).not.toContain("tool_call");
    expect(body).not.toContain("event: error");
    expect(body).toContain("event: done\ndata: {}");

    const got = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(owner) });
    const msg = (got.json() as { messages: Array<{ id: string; content: string | null; errorKind: string | null }> }).messages
      .find((m) => m.id === messageId)!;
    expect(msg.content).toBe("Hello there friend"); // the 3 real tokens, unaffected by the bogus frame
    expect(msg.errorKind).toBeNull();
  });

  it("a second concurrent send to the same thread is rejected (409), never interleaving seq", async () => {
    const threadId = await newThread("concurrency probe");
    const [r1, r2] = await Promise.all([
      sendMessage(threadId, "first message"),
      sendMessage(threadId, "second message"),
    ]);
    const codes = [r1.statusCode, r2.statusCode].sort();
    expect(codes).toEqual([201, 409]);

    const got = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(owner) });
    const messages = (got.json() as { messages: Array<{ seq: number; role: string }> }).messages;
    // Exactly ONE (user, assistant-placeholder) pair landed — no gap, no duplicate, no interleave.
    expect(messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("stop mid-stream CANCELS the upstream request (observed directly on the fake gateway) and the partial message persists, flagged", async () => {
    const threadId = await newThread("stop probe");
    const sent = await sendMessage(threadId, "PROBE:stopcase SIMULATE_DELAY:250 please respond slowly");
    const { messageId, streamUrl } = sent.json() as { messageId: string; streamUrl: string };

    const res = await openStream(streamUrl);
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    // Wait for the FIRST token to arrive — proves generation genuinely started before we stop it.
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("event: token");

    const stopped = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${threadId}/stop`, headers: asUser(owner) });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ ok: true, stopped: true });

    // The direct, load-bearing assertion: the FAKE GATEWAY itself observed the client disconnect —
    // not inferred from our own state, from the far end's own `req.on('close')`.
    const sawAbort = await waitFor(() => gateway.abortedProbes.get("stopcase") === true);
    expect(sawAbort).toBe(true);

    // Drain the rest of our own stream (should end shortly with an `error` event).
    let restOfBody = "";
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      restOfBody += decoder.decode(value, { stream: true });
    }
    expect(restOfBody).toContain("event: error");
    expect(restOfBody).toMatch(/"errorKind":"stopped"/);
    expect(restOfBody).not.toContain("event: done");

    const got = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(owner) });
    const assistantMsg = (got.json() as { messages: Array<{ id: string; errorKind: string | null; content: string | null }> }).messages
      .find((m) => m.id === messageId)!;
    expect(assistantMsg.errorKind).toBe("stopped");
    expect(typeof assistantMsg.content).toBe("string"); // partial content persisted (possibly "")
  });

  it("stream end WITHOUT `done` surfaces as an error (abnormal drop), never as success", async () => {
    const threadId = await newThread("abnormal drop probe");
    const sent = await sendMessage(threadId, "SIMULATE_ABNORMAL_DROP please");
    const { streamUrl } = sent.json() as { messageId: string; streamUrl: string };

    const res = await openStream(streamUrl);
    const body = await readAll(res);
    expect(body).toContain("event: error");
    expect(body).toMatch(/"errorKind":"abnormal_drop"/);
    expect(body).not.toContain("event: done");

    const got = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(owner) });
    const assistantMsg = (got.json() as { messages: Array<{ role: string; errorKind: string | null; content: string | null }> }).messages
      .find((m) => m.role === "assistant")!;
    expect(assistantMsg.errorKind).toBe("abnormal_drop");
    expect(assistantMsg.content).toBe("Hello there friend"); // the 3 tokens sent before the drop
  });

  it("an upstream `event: error` persists error_kind='upstream_error'", async () => {
    const threadId = await newThread("upstream error probe");
    const sent = await sendMessage(threadId, "SIMULATE_ERROR:provider_exploded please");
    const { streamUrl } = sent.json() as { messageId: string; streamUrl: string };
    const res = await openStream(streamUrl);
    const body = await readAll(res);
    expect(body).toMatch(/"error":"provider_exploded"/);
    expect(body).toMatch(/"errorKind":"upstream_error"/);

    const got = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(owner) });
    const assistantMsg = (got.json() as { messages: Array<{ role: string; errorKind: string | null }> }).messages
      .find((m) => m.role === "assistant")!;
    expect(assistantMsg.errorKind).toBe("upstream_error");
  });

  it("a server-side idle timeout kills a stalled upstream into a visible error event", async () => {
    const previous = config.assistant.streamIdleTimeoutMs;
    config.assistant.streamIdleTimeoutMs = 150;
    try {
      const threadId = await newThread("idle timeout probe");
      const sent = await sendMessage(threadId, "SIMULATE_IDLE please just hang");
      const { streamUrl } = sent.json() as { messageId: string; streamUrl: string };
      const res = await openStream(streamUrl);
      const body = await readAll(res); // resolves once our own idle timer aborts the upstream
      expect(body).toContain("event: error");
      expect(body).toMatch(/"errorKind":"idle_timeout"/);

      const got = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(owner) });
      const assistantMsg = (got.json() as { messages: Array<{ role: string; errorKind: string | null; content: string | null }> }).messages
        .find((m) => m.role === "assistant")!;
      expect(assistantMsg.errorKind).toBe("idle_timeout");
      expect(assistantMsg.content).toBe(""); // no token ever arrived
    } finally {
      config.assistant.streamIdleTimeoutMs = previous;
    }
  });

  it("owner-only holds on stream + stop: a different same-company user and a company_admin are both denied", async () => {
    const threadId = await newThread("owner-only probe");
    const sent = await sendMessage(threadId, "hello");
    const { streamUrl } = sent.json() as { messageId: string; streamUrl: string };

    // No real socket needed: authorize() throws before reply.raw is touched (see file header).
    const otherStream = await app.inject({ method: "GET", url: streamUrl, headers: asUser(other) });
    expect(otherStream.statusCode).toBe(403);
    const adminStream = await app.inject({ method: "GET", url: streamUrl, headers: asUser(admin) });
    expect(adminStream.statusCode).toBe(403);

    const otherStop = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${threadId}/stop`, headers: asUser(other) });
    expect(otherStop.statusCode).toBe(403);
    const adminStop = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${threadId}/stop`, headers: asUser(admin) });
    expect(adminStop.statusCode).toBe(403);

    // The owner can still legitimately stop it afterwards — the 403s above didn't consume anything.
    const ownerStop = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads/${threadId}/stop`, headers: asUser(owner) });
    expect(ownerStop.statusCode).toBe(200);
  });

  it("compaction v1: an overflowing window folds the oldest messages into a summary, and the raw messages survive untouched", async () => {
    const threadId = await newThread("compaction probe");
    // Insert enough raw messages, directly, to exceed a tiny budget — cheaper and more precise than
    // driving 10 real sends through the HTTP layer for a context-assembly-only property.
    await withTenants(
      [A],
      async (c) => {
        for (let seq = 1; seq <= 6; seq++) {
          await c.query(
            `INSERT INTO assistant_messages (id, tenant_id, thread_id, seq, role, content, origin_site)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)`,
            [A, threadId, seq, seq % 2 === 1 ? "user" : "assistant", `message number ${seq} with some padding text to grow the transcript`, config.originSite],
          );
        }
      },
      { modules: ["assistant"] },
    );

    const assembled = await withTenants(
      [A],
      (c) => assembleContext(c, threadId, { compactionSummary: null, compactionSummaryUptoSeq: null }, 7, {
        gatewayUrl: gateway.url, gatewayToken: "gw-token", charBudget: 80,
      }),
      { modules: ["assistant"] },
    );
    expect(assembled.compactionUpdate).toBeTruthy();
    expect(assembled.compactionUpdate!.summary).toContain("compact summary");
    expect(assembled.prompt).toContain("Summary of the earlier conversation");
    // The most recent message is always kept verbatim, never folded away.
    expect(assembled.prompt).toContain("message number 6");

    // The RAW messages are untouched — resuming this thread still replays every one of them.
    const admin_ = adminPool();
    const rawCount = await admin_.query(`SELECT count(*)::int AS n FROM assistant_messages WHERE thread_id = $1`, [threadId]);
    expect(rawCount.rows[0].n).toBe(6);
  });
});
