// ASST-12 — unit coverage for stream.ts's pure/near-pure pieces: consuming ASST-11's additive
// `event: meta` / `event: usage` frames (absent-tolerant), the real-usage-overrides-the-estimate
// rule, and "an unknown event type never breaks the stream". Deliberately DB-free (no
// DATABASE_URL_TEST/CERBOS_URL needed) — full end-to-end persistence coverage lives in
// assistant-stream.test.ts, which this file complements rather than duplicates.
//
// Ticket: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md ("### ASST-12").
import { describe, it, expect, vi } from "vitest";
import {
  parseGatewayStream, relayGeneration, reserveGeneration, usageMetaParts,
  type RelayEmit, type RelayResult,
} from "./stream";

function sseBody(...blocks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const joined = blocks.join("");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(joined));
      controller.close();
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

describe("parseGatewayStream — ASST-11's additive meta/usage frames", () => {
  it("yields a meta event, non-terminal (parsing continues afterward)", async () => {
    const body = sseBody(
      `event: meta\ndata: ${JSON.stringify({ provider: "ollama", model: "llama3.2" })}\n\n`,
      `data: ${JSON.stringify("hi")}\n\n`,
      `event: done\ndata: {}\n\n`,
    );
    const events = await collect(parseGatewayStream(body));
    expect(events).toEqual([
      { type: "meta", provider: "ollama", model: "llama3.2", providerSession: undefined },
      { type: "token", text: "hi" },
      { type: "done" },
    ]);
  });

  it("model may legitimately be \"\" (a provider with no fixed-model concept) — passed through, not coerced", async () => {
    const body = sseBody(`event: meta\ndata: ${JSON.stringify({ provider: "echo", model: "" })}\n\n`, `event: done\ndata: {}\n\n`);
    const events = await collect(parseGatewayStream(body));
    expect(events[0]).toEqual({ type: "meta", provider: "echo", model: "", providerSession: undefined });
  });

  it("providerSession is carried through when present", async () => {
    const body = sseBody(
      `event: meta\ndata: ${JSON.stringify({ provider: "hermes", model: "m1", providerSession: "sess-1" })}\n\n`,
      `event: done\ndata: {}\n\n`,
    );
    const events = await collect(parseGatewayStream(body));
    expect(events[0]).toEqual({ type: "meta", provider: "hermes", model: "m1", providerSession: "sess-1" });
  });

  it("a malformed meta frame (missing fields) is dropped, never thrown — the stream keeps going", async () => {
    const body = sseBody(`event: meta\ndata: {"providerSession":"x"}\n\n`, `data: ${JSON.stringify("ok")}\n\n`, `event: done\ndata: {}\n\n`);
    const events = await collect(parseGatewayStream(body));
    expect(events).toEqual([{ type: "token", text: "ok" }, { type: "done" }]);
  });

  it("yields a real usage event (terminal-adjacent, arrives just before done)", async () => {
    const body = sseBody(
      `data: ${JSON.stringify("hi")}\n\n`,
      `event: usage\ndata: ${JSON.stringify({ promptTokens: 12, completionTokens: 34 })}\n\n`,
      `event: done\ndata: {}\n\n`,
    );
    const events = await collect(parseGatewayStream(body));
    expect(events).toEqual([
      { type: "token", text: "hi" },
      { type: "usage", promptTokens: 12, completionTokens: 34 },
      { type: "done" },
    ]);
  });

  it("absent meta/usage is the common path: a plain ASST-10-shaped stream still parses cleanly, zero errors", async () => {
    const body = sseBody(`data: ${JSON.stringify("Hello ")}\n\n`, `data: ${JSON.stringify("there")}\n\n`, `event: done\ndata: {}\n\n`);
    const events = await collect(parseGatewayStream(body));
    expect(events).toEqual([
      { type: "token", text: "Hello " },
      { type: "token", text: "there" },
      { type: "done" },
    ]);
  });

  it("an unrecognised/future event type is ignored — it never breaks the stream, never becomes a token", async () => {
    const body = sseBody(
      `event: tool_call\ndata: {"whatever":true}\n\n`,
      `data: ${JSON.stringify("real token")}\n\n`,
      `event: done\ndata: {}\n\n`,
    );
    const events = await collect(parseGatewayStream(body));
    expect(events).toEqual([{ type: "token", text: "real token" }, { type: "done" }]);
  });
});

// ── relayGeneration: real usage overrides the estimate; meta feeds the result and the live emit ──

function fakeEntry(threadId = "t1", messageId = "m1") {
  const entry = reserveGeneration(threadId, messageId);
  if (!entry) throw new Error("test setup: reservation should always succeed for a fresh threadId");
  return entry;
}

function collectingEmit(): RelayEmit & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = { token: [], meta: [], usage: [], done: [], error: [] };
  return {
    calls,
    token: (text) => calls.token.push([text]),
    meta: (provider, model, providerSession) => calls.meta.push([provider, model, providerSession]),
    usage: (tokens, latencyMs, source, promptTokens, completionTokens) => calls.usage.push([tokens, latencyMs, source, promptTokens, completionTokens]),
    done: () => calls.done.push([]),
    error: (message, errorKind) => calls.error.push([message, errorKind]),
  };
}

function fakeFetch(body: ReadableStream<Uint8Array>): typeof fetch {
  return vi.fn(async () => ({ ok: true, body } as unknown as Response)) as unknown as typeof fetch;
}

describe("relayGeneration — real usage overrides the estimate, absent meta is honest, not an error", () => {
  it("meta + real usage: RelayResult carries provider/model and usageSource='provider', tokens = prompt+completion (not the char estimate)", async () => {
    const entry = fakeEntry("thread-a");
    const emit = collectingEmit();
    const body = sseBody(
      `event: meta\ndata: ${JSON.stringify({ provider: "ollama", model: "llama3.2" })}\n\n`,
      `data: ${JSON.stringify("Hello there")}\n\n`,
      `event: usage\ndata: ${JSON.stringify({ promptTokens: 10, completionTokens: 5 })}\n\n`,
      `event: done\ndata: {}\n\n`,
    );
    const result: RelayResult = await relayGeneration(entry, {
      tenantId: "t1", prompt: "hi", emit, gatewayUrl: "http://fake-gateway.test", fetchImpl: fakeFetch(body),
    });

    expect(result.outcome).toBe("done");
    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("llama3.2");
    expect(result.usageSource).toBe("provider");
    expect(result.promptTokens).toBe(10);
    expect(result.completionTokens).toBe(5);
    expect(result.tokensEstimate).toBe(15); // 10 + 5, the REAL total — not the ~4-chars/token guess
    expect(emit.calls.meta).toEqual([["ollama", "llama3.2", undefined]]);
    expect(emit.calls.usage).toEqual([[15, expect.any(Number), "provider", 10, 5]]);
  });

  it("absent meta and absent usage (the common path, e.g. echo/openai/gemini/claude): unknown provider, estimate labelled as such, zero errors", async () => {
    const entry = fakeEntry("thread-b");
    const emit = collectingEmit();
    const body = sseBody(`data: ${JSON.stringify("plain reply")}\n\n`, `event: done\ndata: {}\n\n`);
    const result = await relayGeneration(entry, { tenantId: "t1", prompt: "hi", emit, gatewayUrl: "http://fake-gateway.test", fetchImpl: fakeFetch(body) });

    expect(result.outcome).toBe("done");
    expect(result.provider).toBeUndefined(); // -> persisted NULL, "unknown provider", never an error
    expect(result.model).toBeUndefined();
    expect(result.usageSource).toBe("estimate");
    expect(result.promptTokens).toBeUndefined();
    expect(result.completionTokens).toBeUndefined();
    expect(emit.calls.meta).toEqual([]);
    expect(emit.calls.usage[0]).toEqual([result.tokensEstimate, expect.any(Number), "estimate", undefined, undefined]);
    expect(emit.calls.error).toEqual([]); // the whole point: absent meta/usage is not an error
  });

  it("meta arrives but the stream then errors: provider/model are still recorded, usageSource stays 'estimate' (a provider never reports usage on an error path)", async () => {
    const entry = fakeEntry("thread-c");
    const emit = collectingEmit();
    const body = sseBody(
      `event: meta\ndata: ${JSON.stringify({ provider: "gemini", model: "gemini-2" })}\n\n`,
      `data: ${JSON.stringify("partial")}\n\n`,
      `event: error\ndata: ${JSON.stringify({ error: "boom" })}\n\n`,
    );
    const result = await relayGeneration(entry, { tenantId: "t1", prompt: "hi", emit, gatewayUrl: "http://fake-gateway.test", fetchImpl: fakeFetch(body) });

    expect(result.outcome).toBe("error");
    expect(result.errorKind).toBe("upstream_error");
    expect(result.provider).toBe("gemini");
    expect(result.model).toBe("gemini-2");
    expect(result.usageSource).toBe("estimate");
    expect(emit.calls.usage).toEqual([]); // usage is never emitted on an error path
  });

  it("an unknown/future SSE event type mixed into the wire does not break the relay — the reply still completes normally", async () => {
    const entry = fakeEntry("thread-d");
    const emit = collectingEmit();
    const body = sseBody(
      `event: tool_call\ndata: {"unexpected":true}\n\n`,
      `data: ${JSON.stringify("still works")}\n\n`,
      `event: done\ndata: {}\n\n`,
    );
    const result = await relayGeneration(entry, { tenantId: "t1", prompt: "hi", emit, gatewayUrl: "http://fake-gateway.test", fetchImpl: fakeFetch(body) });
    expect(result.outcome).toBe("done");
    expect(result.text).toBe("still works");
    expect(emit.calls.error).toEqual([]);
  });
});

describe("usageMetaParts — the jsonb `parts` shape persisted alongside provider/model/tokens", () => {
  it("carries usageSource plus the real breakdown when present", () => {
    expect(usageMetaParts({ usageSource: "provider", promptTokens: 10, completionTokens: 5 })).toEqual([
      { type: "usage_meta", usageSource: "provider", promptTokens: 10, completionTokens: 5 },
    ]);
  });
  it("omits promptTokens/completionTokens entirely when they were never real (estimate case)", () => {
    expect(usageMetaParts({ usageSource: "estimate" })).toEqual([{ type: "usage_meta", usageSource: "estimate" }]);
  });
});
