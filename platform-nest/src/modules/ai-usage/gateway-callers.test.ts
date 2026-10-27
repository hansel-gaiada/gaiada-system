// AIP-03a / AIP-04 — every family of platform-nest callers of the AI gateway writes ONE usage row per call, through its shared client.
// No database: `../../db` is replaced by a recording fake, so what is asserted is the REAL chain end to end (client -> recordGatewayCall ->
// recordAiUsage -> price lookup -> the INSERT's parameters), and what the caller got back.
//
// Families: the search client (/complete and /embed), the social client (/complete with the cloudPolish hint), the assistant's reply
// (relayGeneration, the stream), and the assistant's compaction call. For each: an ok call (attribution, provider tokens, provider cost), a call
// with no usage ('none' or 'estimate'), a refused call (DLP 503, budget 429, error), and the writer failing without changing the call's result.
// Also: the price table fills the gap (cost_source 'table'), and the thread's total cost follows its usage rows.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

const UNIT = "33333333-3333-4333-8333-333333333333";
const h = vi.hoisted(() => ({
  inserts: [] as unknown[][],
  threadUpdates: [] as unknown[][],
  placementReads: 0,
  priceRows: [] as Array<{ prompt: string; completion: string; effective_from: string }>,
  failWrites: false,
  nextId: 0,
}));

vi.mock("../../db", async (orig) => {
  const real = await orig<typeof import("../../db")>();
  const client = {
    query: async (text: string, values: unknown[]) => {
      if (/INSERT INTO ai_usage_events/.test(text)) { h.inserts.push(values); return { rows: [] }; }
      if (/FROM org_unit_memberships/.test(text)) { h.placementReads++; return { rows: [{ id: UNIT }] }; }
      if (/UPDATE assistant_threads/.test(text)) { h.threadUpdates.push(values); return { rows: [] }; }
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return {
    ...real,
    newId: () => `99999999-9999-4999-8999-${String(++h.nextId).padStart(12, "0")}`,
    withTenants: async (_t: string[], fn: (c: PoolClient) => Promise<unknown>) => {
      if (h.failWrites) throw new Error("db down");
      return fn(client);
    },
    withGlobal: async (fn: (c: PoolClient) => Promise<unknown>) =>
      fn({ query: async () => ({ rows: h.priceRows }) } as unknown as PoolClient),
  };
});

import { completeViaGateway as searchComplete, embedViaGateway } from "../search/providers/gateway-client";
import { completeViaGateway as socialComplete } from "../social/gateway-client";
import { relayGeneration, reserveGeneration, type RelayEmit } from "../assistant/stream";
import { assembleContext } from "../assistant/context";
import { clearUnitCacheForTests } from "./gateway-usage";

const T = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";
const TH = "44444444-4444-4444-8444-444444444444";
// INSERT parameter order: id, tenant, occurred_at, user, org_unit, surface, capability, task, tier, provider, model, prompt, completion, tokens_source, cost, cost_source, outcome, thread, run, hint
const V = { tenant: 1, user: 3, unit: 4, surface: 5, capability: 6, task: 7, provider: 9, model: 10, prompt: 11, completion: 12, tokensSource: 13, cost: 14, costSource: 15, outcome: 16, thread: 17, hint: 19 };
const GW = "https://gateway.test";

/** The usage row is written after the answer, fire and forget: wait for it. */
async function row(n = 1): Promise<unknown[]> {
  await vi.waitFor(() => expect(h.inserts.length).toBeGreaterThanOrEqual(n), { timeout: 2000 });
  return h.inserts[n - 1];
}
/** Let any (wrongly) pending write land, then assert none did. */
async function noRow(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
  expect(h.inserts).toHaveLength(0);
}

const json = (body: unknown, status = 200): typeof fetch =>
  (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response) as unknown as typeof fetch;

beforeEach(() => {
  h.inserts.length = 0; h.threadUpdates.length = 0; h.placementReads = 0; h.priceRows = []; h.failWrites = false; h.nextId = 0;
  clearUnitCacheForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("search client (/complete, /embed)", () => {
  const attribution = { tenantId: T, userId: U, surface: "search", task: "search.brief_draft" } as const;
  const opts = (fetchImpl: typeof fetch) => ({ gatewayUrl: GW, gatewayToken: "t", fetchImpl, attribution });

  it("an ok call writes one row: the attribution, the provider's tokens and the provider's cost", async () => {
    const r = await searchComplete("p", opts(json({ text: "hi", provider: "openai", model: "z-ai/glm-5.3-flash", usage: { promptTokens: 11, completionTokens: 7, costUsd: 0.000123, source: "provider" } })));
    expect(r.text).toBe("hi");
    const v = await row();
    expect([v[V.tenant], v[V.user], v[V.surface], v[V.capability], v[V.task], v[V.outcome]]).toEqual([T, U, "search", "llm", "search.brief_draft", "ok"]);
    expect([v[V.provider], v[V.model], v[V.prompt], v[V.completion], v[V.tokensSource], v[V.cost], v[V.costSource]]).toEqual(["openai", "z-ai/glm-5.3-flash", 11, 7, "provider", "0.00012300", "provider"]);
    expect(h.inserts).toHaveLength(1);
  });

  it("the department is the person's primary placement, resolved once and cached for the next call", async () => {
    await searchComplete("p", opts(json({ text: "a", provider: "openai" })));
    await searchComplete("p", opts(json({ text: "b", provider: "openai" })));
    await row(2);
    expect(h.inserts.map((v) => v[V.unit])).toEqual([UNIT, UNIT]);
    expect(h.placementReads).toBe(1);
  });

  it("an answer with no usage writes tokens_source 'none' and no cost", async () => {
    await searchComplete("p", opts(json({ text: "hi", provider: "ollama" })));
    const v = await row();
    expect([v[V.tokensSource], v[V.prompt], v[V.completion], v[V.cost], v[V.costSource]]).toEqual(["none", null, null, null, null]);
  });

  it("AIP-04: provider tokens, no provider cost, a price in force: the table fills the cost, labelled 'table'", async () => {
    h.priceRows = [{ prompt: "0.5", completion: "2", effective_from: "2026-01-01" }];
    await searchComplete("p", opts(json({ text: "hi", provider: "openai", model: "m1", usage: { promptTokens: 1000, completionTokens: 500, source: "provider" } })));
    const v = await row();
    expect([v[V.tokensSource], v[V.cost], v[V.costSource]]).toEqual(["provider", "0.00150000", "table"]);
  });

  it("AIP-04: no price row means the cost stays NULL (unknown is not zero)", async () => {
    await searchComplete("p", opts(json({ text: "hi", provider: "openai", model: "m1", usage: { promptTokens: 1000, completionTokens: 500, source: "provider" } })));
    const v = await row();
    expect([v[V.cost], v[V.costSource]]).toEqual([null, null]);
  });

  it("a DLP refusal (503), a budget refusal (429) and any other failure each write their outcome with no tokens", async () => {
    for (const [status, outcome] of [[503, "blocked_dlp"], [429, "blocked_budget"], [500, "error"]] as const) {
      h.inserts.length = 0;
      await expect(searchComplete("p", opts(json({}, status)))).rejects.toThrow(new RegExp(`HTTP ${status}`));
      const v = await row();
      expect([v[V.outcome], v[V.tokensSource], v[V.prompt], v[V.cost]], String(status)).toEqual([outcome, "none", null, null]);
    }
  });

  it("an unreachable gateway is an 'error' row; the error still reaches the caller", async () => {
    const boom = (async () => { throw new Error("socket hang up"); }) as unknown as typeof fetch;
    await expect(searchComplete("p", opts(boom))).rejects.toThrow("socket hang up");
    expect((await row())[V.outcome]).toBe("error");
  });

  it("/embed writes capability 'embed', tokens 'none'", async () => {
    const vec = await embedViaGateway("running shoes", opts(json({ embedding: [1, 2] })));
    expect(vec).toEqual([1, 2]);
    const v = await row();
    expect([v[V.capability], v[V.tokensSource], v[V.outcome]]).toEqual(["embed", "none", "ok"]);
  });

  it("an unconfigured gateway made no call and writes no row", async () => {
    await expect(searchComplete("p", { gatewayUrl: "", gatewayToken: "", attribution })).rejects.toThrow(/not configured/);
    await noRow();
  });

  it("a job with no person records with a null user and no department", async () => {
    await searchComplete("p", { ...opts(json({ text: "hi", provider: "openai" })), attribution: { tenantId: T, userId: null, surface: "other", task: "reports.narrative" } });
    const v = await row();
    expect([v[V.user], v[V.unit], v[V.surface]]).toEqual([null, null, "other"]);
    expect(h.placementReads).toBe(0);
  });

  it("the writer failing does not change the call's result (and does not reject)", async () => {
    h.failWrites = true;
    const r = await searchComplete("p", opts(json({ text: "still fine", provider: "openai", usage: { promptTokens: 1, completionTokens: 1, source: "provider" } })));
    expect(r.text).toBe("still fine");
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled(), { timeout: 2000 });
    expect(h.inserts).toHaveLength(0);
    // the embed path too
    expect(await embedViaGateway("x", opts(json({ embedding: [3] })))).toEqual([3]);
  });
});

describe("social client (/complete with the cloudPolish hint)", () => {
  const attribution = { tenantId: T, userId: U, surface: "other", task: "social.draft_caption" } as const;

  it("an ok call writes one row with the provider hint, tokens and cost", async () => {
    const r = await socialComplete("p", { gatewayUrl: GW, gatewayToken: "t", provider: "claude", attribution, fetchImpl: json({ text: "caption", provider: "claude", usage: { promptTokens: 20, completionTokens: 9, costUsd: 0.01, source: "provider" } }) });
    expect(r.text).toBe("caption");
    const v = await row();
    expect([v[V.surface], v[V.task], v[V.provider], v[V.hint], v[V.prompt], v[V.completion], v[V.cost], v[V.costSource], v[V.outcome]]).toEqual(["other", "social.draft_caption", "claude", "claude", 20, 9, "0.01000000", "provider", "ok"]);
  });

  it("no usage: 'none'; a DLP refusal: blocked_dlp with no tokens", async () => {
    await socialComplete("p", { gatewayUrl: GW, gatewayToken: "t", attribution, fetchImpl: json({ text: "c", provider: "openai" }) });
    expect((await row())[V.tokensSource]).toBe("none");
    h.inserts.length = 0;
    await expect(socialComplete("p", { gatewayUrl: GW, gatewayToken: "t", attribution, fetchImpl: json({}, 503) })).rejects.toThrow(/HTTP 503/);
    const v = await row();
    expect([v[V.outcome], v[V.tokensSource]]).toEqual(["blocked_dlp", "none"]);
  });

  it("the writer failing does not change the call's result", async () => {
    h.failWrites = true;
    expect((await socialComplete("p", { gatewayUrl: GW, gatewayToken: "t", attribution, fetchImpl: json({ text: "ok", provider: "openai" }) })).text).toBe("ok");
  });
});

describe("assistant reply (relayGeneration)", () => {
  const sse = (...blocks: string[]): ReadableStream<Uint8Array> => {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(blocks.join(""))); c.close(); } });
  };
  const emit: RelayEmit = { token: () => {}, meta: () => {}, usage: () => {}, session: () => {}, done: () => {}, error: () => {} };
  let n = 0;
  const entry = () => reserveGeneration(`relay-thread-${++n}`, `relay-msg-${n}`)!;
  const stream = (body: ReadableStream<Uint8Array> | null, status = 200): typeof fetch =>
    (async () => ({ ok: status === 200, status, body }) as unknown as Response) as unknown as typeof fetch;
  const input = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) => ({
    tenantId: T, prompt: "a prompt of forty characters, roughly...", emit, gatewayUrl: GW, gatewayToken: "t", fetchImpl,
    attribution: { tenantId: T, userId: U, surface: "assistant" as const, threadId: TH, task: "assistant.reply" }, ...extra,
  });

  it("a reply with provider usage and cost: one row, provider tokens, provider cost, the thread and the owner; then the thread's total cost is refreshed", async () => {
    const body = sse(
      `event: meta\ndata: ${JSON.stringify({ provider: "openai", model: "z-ai/glm-5.3-flash" })}\n\n`,
      `data: ${JSON.stringify("Hello")}\n\n`,
      `event: usage\ndata: ${JSON.stringify({ promptTokens: 120, completionTokens: 30, costUsd: 0.0004, source: "provider" })}\n\n`,
      `event: done\ndata: {}\n\n`,
    );
    const r = await relayGeneration(entry(), input(stream(body)));
    expect(r).toMatchObject({ outcome: "done", usageSource: "provider", promptTokens: 120, completionTokens: 30, costUsd: 0.0004 });
    const v = await row();
    expect([v[V.tenant], v[V.user], v[V.unit], v[V.surface], v[V.capability], v[V.thread], v[V.task]]).toEqual([T, U, UNIT, "assistant", "llm", TH, "assistant.reply"]);
    expect([v[V.provider], v[V.model], v[V.prompt], v[V.completion], v[V.tokensSource], v[V.cost], v[V.costSource], v[V.outcome]]).toEqual(["openai", "z-ai/glm-5.3-flash", 120, 30, "provider", "0.00040000", "provider", "ok"]);
    await vi.waitFor(() => expect(h.threadUpdates).toEqual([[T, TH]]), { timeout: 2000 });
  });

  it("a reply with no usage frame writes the labelled ESTIMATE (the prompt we sent, the text we got)", async () => {
    const body = sse(`event: meta\ndata: ${JSON.stringify({ provider: "openai", model: "m1" })}\n\n`, `data: ${JSON.stringify("x".repeat(40))}\n\n`, `event: done\ndata: {}\n\n`);
    const r = await relayGeneration(entry(), input(stream(body)));
    expect(r.usageSource).toBe("estimate");
    const v = await row();
    expect([v[V.tokensSource], v[V.prompt], v[V.completion], v[V.outcome]]).toEqual(["estimate", Math.ceil("a prompt of forty characters, roughly...".length / 4), 10, "ok"]);
  });

  it("AIP-04: an estimate with a price in force is costed from the table, and the row says so", async () => {
    h.priceRows = [{ prompt: "1", completion: "1", effective_from: "2026-01-01" }];
    const body = sse(`event: meta\ndata: ${JSON.stringify({ provider: "openai", model: "m1" })}\n\n`, `data: ${JSON.stringify("x".repeat(40))}\n\n`, `event: done\ndata: {}\n\n`);
    await relayGeneration(entry(), input(stream(body)));
    const v = await row();
    expect([v[V.tokensSource], v[V.costSource]]).toEqual(["estimate", "table"]);
    expect(Number(v[V.cost])).toBeGreaterThan(0);
  });

  it("a DLP refusal (HTTP 503) and a budget refusal (HTTP 429) write their outcome, no tokens", async () => {
    for (const [status, outcome] of [[503, "blocked_dlp"], [429, "blocked_budget"]] as const) {
      h.inserts.length = 0;
      const r = await relayGeneration(entry(), input(stream(null, status)));
      expect(r).toMatchObject({ outcome: "error", errorKind: "transport_error" });
      const v = await row();
      expect([v[V.outcome], v[V.tokensSource], v[V.prompt], v[V.cost]], String(status)).toEqual([outcome, "none", null, null]);
    }
  });

  it("an upstream error is 'error'; a drop mid-stream is 'incurred' (charged, did not complete); neither carries tokens", async () => {
    await relayGeneration(entry(), input(stream(sse(`event: error\ndata: ${JSON.stringify({ error: "boom" })}\n\n`))));
    expect((await row())[V.outcome]).toBe("error");
    h.inserts.length = 0;
    await relayGeneration(entry(), input(stream(sse(`data: ${JSON.stringify("partial")}\n\n`))));
    const v = await row();
    expect([v[V.outcome], v[V.tokensSource]]).toEqual(["incurred", "none"]);
  });

  it("an unconfigured gateway made no call and writes no row", async () => {
    const r = await relayGeneration(entry(), input(stream(null), { gatewayUrl: "", gatewayToken: "" }));
    expect(r).toMatchObject({ outcome: "error", errorKind: "not_configured" });
    await noRow();
  });

  it("the writer failing does not change the reply's result", async () => {
    h.failWrites = true;
    const body = sse(`event: meta\ndata: ${JSON.stringify({ provider: "openai", model: "m1" })}\n\n`, `data: ${JSON.stringify("fine")}\n\n`, `event: done\ndata: {}\n\n`);
    const r = await relayGeneration(entry(), input(stream(body)));
    expect(r).toMatchObject({ outcome: "done", text: "fine" });
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled(), { timeout: 2000 });
    expect(h.threadUpdates).toHaveLength(0); // no usage row, so no refresh
  });
});

describe("assistant compaction (assembleContext)", () => {
  const thread = { ownerUserId: U, compactionSummary: null, compactionSummaryUptoSeq: null };
  const client = {
    query: vi.fn(async (sql: string) => {
      if (/FROM assistant_messages/.test(sql)) {
        return { rows: [1, 2, 3].map((seq) => ({ seq, role: seq % 2 ? "user" : "assistant", content: `message number ${seq} `.repeat(8) })) };
      }
      return { rows: [] };
    }),
  } as unknown as PoolClient;

  it("a compaction writes one row on the thread, surface 'compaction', the owner as the person, provider tokens and cost", async () => {
    const out = await assembleContext(client, TH, thread, 4, {
      tenantId: T, charBudget: 60, knowledgeTopK: 0, gatewayUrl: GW,
      fetchImpl: json({ text: "a summary", provider: "openai", model: "m1", usage: { promptTokens: 300, completionTokens: 40, costUsd: 0.002, source: "provider" } }),
    });
    expect(out.compactionUpdate?.summary).toBe("a summary");
    const v = await row();
    expect([v[V.tenant], v[V.user], v[V.surface], v[V.thread], v[V.prompt], v[V.completion], v[V.tokensSource], v[V.cost], v[V.costSource], v[V.outcome]])
      .toEqual([T, U, "compaction", TH, 300, 40, "provider", "0.00200000", "provider", "ok"]);
    await vi.waitFor(() => expect(h.threadUpdates).toEqual([[T, TH]]), { timeout: 2000 });
  });

  it("a refused compaction (503) writes blocked_dlp and still fails loudly, as before", async () => {
    await expect(assembleContext(client, TH, thread, 4, { tenantId: T, charBudget: 60, knowledgeTopK: 0, gatewayUrl: GW, fetchImpl: json({}, 503) })).rejects.toThrow(/HTTP 503/);
    const v = await row();
    expect([v[V.surface], v[V.outcome], v[V.tokensSource]]).toEqual(["compaction", "blocked_dlp", "none"]);
  });

  it("with no company in scope there is nothing to attribute: no row, and the compaction still works", async () => {
    const out = await assembleContext(client, TH, thread, 4, { charBudget: 60, knowledgeTopK: 0, gatewayUrl: GW, fetchImpl: json({ text: "s", provider: "openai" }) });
    expect(out.compactionUpdate?.summary).toBe("s");
    await noRow();
  });

  it("the writer failing does not change the compaction's result", async () => {
    h.failWrites = true;
    const out = await assembleContext(client, TH, thread, 4, { tenantId: T, charBudget: 60, knowledgeTopK: 0, gatewayUrl: GW, fetchImpl: json({ text: "still summarised", provider: "openai" }) });
    expect(out.compactionUpdate?.summary).toBe("still summarised");
  });
});
