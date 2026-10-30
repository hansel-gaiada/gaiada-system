// AIP-01 — the usage writer, pure unit tests (no database). The database half is ai-usage.db.test.ts.
//
// Proves: an unknown key is refused (so no text field can ride in); the writer never throws or rejects, whatever fails; its one warning
// carries ids and a reason and nothing else; a valid event becomes exactly the expected INSERT parameters, under the event's own tenant;
// the vocabularies, the label shape, the numeric bounds and "cost needs a source" are enforced before the database is reached.
import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  AI_USAGE_EVENT_KEYS,
  AI_USAGE_INSERT_SQL,
  buildAiUsageEvent,
  buildAiUsageInsert,
  recordAiUsage,
  recordAiUsageCall,
  validateAiUsageEvent,
  type AiUsageDeps,
  type AiUsageEvent,
} from "./writer";

const T = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";
const D = "33333333-3333-4333-8333-333333333333";
const TH = "44444444-4444-4444-8444-444444444444";
const RUN = "55555555-5555-4555-8555-555555555555";
const ID = "66666666-6666-4666-8666-666666666666";

const valid = (over: Partial<AiUsageEvent> = {}): AiUsageEvent => ({
  tenantId: T,
  surface: "assistant",
  capability: "chat",
  tokensSource: "provider",
  outcome: "ok",
  ...over,
});

/** A fake withTenants that records the tenant set and every query, and runs fn against a fake client. */
function fakeDeps(opts: { failWith?: unknown } = {}) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const tenantSets: string[][] = [];
  const warn = vi.fn();
  const deps: AiUsageDeps = {
    warn,
    newId: () => ID,
    withTenants: async <T2,>(tenantIds: string[], fn: (c: PoolClient) => Promise<T2>): Promise<T2> => {
      tenantSets.push(tenantIds);
      if (opts.failWith !== undefined) throw opts.failWith;
      const client = { query: async (text: string, values: unknown[]) => { queries.push({ text, values }); return { rows: [] }; } };
      return fn(client as unknown as PoolClient);
    },
  };
  return { deps, queries, tenantSets, warn };
}

describe("AIP-01 · recordAiUsage · what it refuses", () => {
  it("rejects an unknown key, so no text field can ride in", async () => {
    for (const key of ["content", "prompt", "answer", "message", "text", "messages", "toolArgs", "body"]) {
      const f = fakeDeps();
      const r = await recordAiUsage({ ...valid(), [key]: "please summarise the Q3 contract for Acme" } as unknown as AiUsageEvent, f.deps);
      expect(r.ok, key).toBe(false);
      expect(f.queries, `${key} must never reach the database`).toHaveLength(0);
      expect(f.warn).toHaveBeenCalledTimes(1);
    }
  });

  it("the event's key list has no key that could carry text", () => {
    for (const k of AI_USAGE_EVENT_KEYS) expect(k).not.toMatch(/prompt$|answer|content|message|text|body|tool|transcript|summary/i);
  });

  it("AIP-15a: unitNodeId is a label: an org node id passes, a sentence, an empty string, 121 characters or a number is refused", () => {
    for (const ok of ["d-webdev", "dv-fe", "n-12", "0197c0de-0000-7000-8000-000000000001", "x".repeat(120)]) {
      expect(validateAiUsageEvent(valid({ unitNodeId: ok })).ok, ok).toBe(true);
    }
    expect(validateAiUsageEvent(valid({ unitNodeId: null })).ok).toBe(true);
    for (const bad of ["Web Dev team", "", "x".repeat(121), 7 as never]) {
      const r = validateAiUsageEvent(valid({ unitNodeId: bad }));
      expect(r.ok, String(bad)).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/^unitNodeId must be a label/);
    }
  });

  it("rejects a bad vocabulary value for each closed vocabulary", () => {
    expect(validateAiUsageEvent(valid({ surface: "email" as never })).ok).toBe(false);
    expect(validateAiUsageEvent(valid({ capability: "image" as never })).ok).toBe(false);
    expect(validateAiUsageEvent(valid({ tokensSource: "guess" as never })).ok).toBe(false);
    expect(validateAiUsageEvent(valid({ outcome: "done" as never })).ok).toBe(false);
    expect(validateAiUsageEvent(valid({ costUsd: 1, costSource: "invoice" as never })).ok).toBe(false);
  });

  it("accepts every value of every vocabulary", () => {
    for (const surface of ["assistant", "compaction", "title", "agent", "knowledge", "search", "bot", "other"] as const) {
      expect(validateAiUsageEvent(valid({ surface })).ok, surface).toBe(true);
    }
    for (const capability of ["llm", "chat", "embed", "media"] as const) expect(validateAiUsageEvent(valid({ capability })).ok, capability).toBe(true);
    for (const tokensSource of ["provider", "estimate", "none"] as const) expect(validateAiUsageEvent(valid({ tokensSource })).ok, tokensSource).toBe(true);
    for (const outcome of ["ok", "blocked_dlp", "blocked_budget", "failed_over", "error", "incurred"] as const) {
      expect(validateAiUsageEvent(valid({ outcome })).ok, outcome).toBe(true);
    }
  });

  it("a missing required field is refused, not defaulted", () => {
    for (const k of ["tenantId", "surface", "capability", "tokensSource", "outcome"] as const) {
      const e: Record<string, unknown> = { ...valid() };
      delete e[k];
      expect(validateAiUsageEvent(e).ok, k).toBe(false);
    }
  });

  it("refuses a label with a space (a sentence), a newline, or more than 120 characters; accepts a real model id", () => {
    expect(validateAiUsageEvent(valid({ model: "summarise this contract" })).ok).toBe(false);
    expect(validateAiUsageEvent(valid({ task: "line1\nline2" })).ok).toBe(false);
    expect(validateAiUsageEvent(valid({ provider: "x".repeat(121) })).ok).toBe(false);
    expect(validateAiUsageEvent(valid({ gatewayProviderHint: "" })).ok).toBe(false);
    expect(validateAiUsageEvent(valid({ model: "ollama/kimi-k2.7-code:cloud", provider: "openai", tier: "cheap", task: "title.generate" })).ok).toBe(true);
    expect(validateAiUsageEvent(valid({ model: "x".repeat(120) })).ok).toBe(true);
  });

  it("refuses a negative, fractional, huge or non-numeric token count; accepts zero and null", () => {
    expect(validateAiUsageEvent(valid({ promptTokens: -1 })).ok).toBe(false);
    expect(validateAiUsageEvent(valid({ completionTokens: 1.5 })).ok).toBe(false);
    expect(validateAiUsageEvent(valid({ promptTokens: 2147483648 })).ok).toBe(false);
    expect(validateAiUsageEvent(valid({ promptTokens: "12" as never })).ok).toBe(false);
    expect(validateAiUsageEvent(valid({ promptTokens: 0, completionTokens: 0 })).ok).toBe(true);
    expect(validateAiUsageEvent(valid({ promptTokens: null, completionTokens: null })).ok).toBe(true);
  });

  it("refuses a negative, non-finite or oversize cost, and a cost with no source; accepts a cost with one", () => {
    expect(validateAiUsageEvent(valid({ costUsd: -0.01, costSource: "table" })).ok).toBe(false);
    expect(validateAiUsageEvent(valid({ costUsd: Number.NaN, costSource: "table" })).ok).toBe(false);
    expect(validateAiUsageEvent(valid({ costUsd: Infinity, costSource: "table" })).ok).toBe(false);
    expect(validateAiUsageEvent(valid({ costUsd: 1_000_000, costSource: "table" })).ok).toBe(false);
    expect(validateAiUsageEvent(valid({ costUsd: 0.5 })).ok).toBe(false);
    expect(validateAiUsageEvent(valid({ costUsd: 0.5, costSource: null })).ok).toBe(false);
    expect(validateAiUsageEvent(valid({ costUsd: 0, costSource: "provider" })).ok).toBe(true);
    expect(validateAiUsageEvent(valid({ costUsd: null, costSource: null })).ok).toBe(true);
  });

  it("refuses an id that is not a uuid, and a bad date", () => {
    expect(validateAiUsageEvent(valid({ tenantId: "acme" })).ok).toBe(false);
    expect(validateAiUsageEvent(valid({ userId: "not-a-uuid" })).ok).toBe(false);
    expect(validateAiUsageEvent(valid({ orgUnitId: 7 as never })).ok).toBe(false);
    expect(validateAiUsageEvent(valid({ occurredAt: "yesterday-ish" })).ok).toBe(false);
    expect(validateAiUsageEvent(valid({ occurredAt: new Date("nope") })).ok).toBe(false);
  });

  it("refuses a non-object event", () => {
    for (const bad of [null, undefined, "x", 3, [], true]) expect(validateAiUsageEvent(bad).ok).toBe(false);
  });
});

describe("AIP-01 · recordAiUsage · it never breaks its caller", () => {
  it("never throws or rejects on garbage input", async () => {
    for (const bad of [null, undefined, "text", 42, [], { tenantId: {} }]) {
      const f = fakeDeps();
      await expect(recordAiUsage(bad as never, f.deps)).resolves.toMatchObject({ ok: false });
      expect(f.warn).toHaveBeenCalledTimes(1);
    }
  });

  it("returns { ok: false } and warns ONCE when the database fails, without the database's message or the event's labels", async () => {
    const f = fakeDeps({ failWith: Object.assign(new Error('new row for relation "ai_usage_events" violates check constraint (Failing row contains (secret-model-x, 123))'), { code: "23514" }) });
    const r = await recordAiUsage(valid({ userId: U, threadId: TH, runId: RUN, model: "secret-model-x", promptTokens: 123, costUsd: 9.87654321, costSource: "table" }), f.deps);
    expect(r).toEqual({ ok: false, reason: "database error 23514" });
    expect(f.warn).toHaveBeenCalledTimes(1);
    const line = String(f.warn.mock.calls[0][0]);
    expect(line).toContain(`tenantId=${T}`);
    expect(line).toContain(`userId=${U}`);
    expect(line).toContain(`threadId=${TH}`);
    expect(line).toContain(`runId=${RUN}`);
    expect(line).not.toMatch(/secret-model-x|123|9\.8765|Failing row|assistant|chat|provider|table/);
  });

  it("survives a pool that cannot connect (an error with no code) and a thrown non-Error", async () => {
    for (const failWith of [new Error("connect ECONNREFUSED 10.0.0.1:5432 password=hunter2"), "a string", 7, null]) {
      const f = fakeDeps({ failWith });
      if (failWith === null) continue; // `failWith: undefined` means "no failure"; null is not a supported fault
      const r = await recordAiUsage(valid(), f.deps);
      expect(r.ok).toBe(false);
      expect(f.warn).toHaveBeenCalledTimes(1);
      expect(String(f.warn.mock.calls[0][0])).not.toMatch(/ECONNREFUSED|hunter2|10\.0\.0\.1/);
    }
  });

  it("survives a broken logger", async () => {
    const f = fakeDeps({ failWith: new Error("boom") });
    f.warn.mockImplementation(() => { throw new Error("logger down"); });
    await expect(recordAiUsage(valid(), f.deps)).resolves.toMatchObject({ ok: false });
  });

  it("does not warn on success", async () => {
    const f = fakeDeps();
    const r = await recordAiUsage(valid(), f.deps);
    expect(r).toEqual({ ok: true, id: ID });
    expect(f.warn).not.toHaveBeenCalled();
  });

  it("with no database configured at all, it still returns instead of throwing (the real withTenants, no pool)", async () => {
    const warn = vi.fn();
    const r = await recordAiUsage(valid(), { warn });
    expect(r.ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("AIP-01 · recordAiUsage · the INSERT it produces", () => {
  it("writes one INSERT under the event's own tenant, with the expected parameters in column order", async () => {
    const f = fakeDeps();
    const r = await recordAiUsage(
      valid({
        userId: U, orgUnitId: D, task: "title.generate", tier: "cheap", provider: "openai", model: "glm-5.3-flash",
        promptTokens: 120, completionTokens: 30, tokensSource: "estimate", costUsd: 0.0123, costSource: "table",
        outcome: "ok", threadId: TH, runId: RUN, gatewayProviderHint: "openrouter", occurredAt: new Date("2026-10-27T08:30:00.000Z"),
        unitNodeId: "d-webdev",
      }),
      f.deps,
    );
    expect(r).toEqual({ ok: true, id: ID });
    expect(f.tenantSets).toEqual([[T]]);
    expect(f.queries).toHaveLength(1);
    expect(f.queries[0].text).toBe(AI_USAGE_INSERT_SQL);
    expect(f.queries[0].values).toEqual([
      ID, T, "2026-10-27T08:30:00.000Z", U, D, "assistant", "chat", "title.generate", "cheap", "openai", "glm-5.3-flash",
      120, 30, "estimate", "0.01230000", "table", "ok", TH, RUN, "openrouter", "d-webdev",
    ]);
  });

  it("absent optional fields become NULL (unknown), never 0 or an empty string", () => {
    const { values } = buildAiUsageInsert(valid({ tokensSource: "none" }), ID);
    expect(values).toEqual([ID, T, null, null, null, "assistant", "chat", null, null, null, null, null, null, "none", null, null, "ok", null, null, null, null]);
  });

  // AIP-15a (202610300300): + unit_node_id, appended LAST so every earlier parameter keeps its position. 20 -> 21.
  it("the INSERT names exactly 21 columns and 21 parameters, and no text column; unit_node_id is the last", () => {
    const cols = /INSERT INTO ai_usage_events\s*\(([^)]*)\)/.exec(AI_USAGE_INSERT_SQL)![1].split(",").map((c) => c.trim());
    expect(cols).toHaveLength(21);
    expect(cols[20]).toBe("unit_node_id");
    expect(AI_USAGE_INSERT_SQL.match(/\$\d+/g)).toHaveLength(21);
    for (const c of cols) expect(c).not.toMatch(/prompt$|answer|content|message|text|body/);
  });

  it("sends cost as fixed-point text so no float noise reaches numeric(14,8)", () => {
    expect(buildAiUsageInsert(valid({ costUsd: 0.1 + 0.2, costSource: "table" }), ID).values[14]).toBe("0.30000000");
    expect(buildAiUsageInsert(valid({ costUsd: 0, costSource: "provider" }), ID).values[14]).toBe("0.00000000");
  });
});

describe("AIP-01 · the typed helper for callers", () => {
  const ctx = { tenantId: T, userId: U, orgUnitId: D, surface: "compaction" as const, threadId: TH };

  it("combines a request's context with one call's result", () => {
    const e = buildAiUsageEvent(ctx, { capability: "chat", outcome: "ok", provider: "openai", model: "m", promptTokens: 5, completionTokens: 2, tokensSource: "provider", costUsd: 0.001, costSource: "provider" });
    expect(e).toMatchObject({ tenantId: T, userId: U, orgUnitId: D, unitNodeId: null, surface: "compaction", threadId: TH, runId: null, capability: "chat", tokensSource: "provider", costSource: "provider" });
    expect(buildAiUsageEvent({ ...ctx, unitNodeId: "d-seo" }, { capability: "chat", outcome: "ok" }).unitNodeId).toBe("d-seo");
    expect(validateAiUsageEvent(e).ok).toBe(true);
  });

  it("never claims provider counts unless told: counts default to 'estimate', no counts to 'none'", () => {
    expect(buildAiUsageEvent(ctx, { capability: "chat", outcome: "ok", promptTokens: 5 }).tokensSource).toBe("estimate");
    expect(buildAiUsageEvent(ctx, { capability: "chat", outcome: "ok" }).tokensSource).toBe("none");
    expect(buildAiUsageEvent(ctx, { capability: "chat", outcome: "ok", promptTokens: 0, completionTokens: 0 }).tokensSource).toBe("estimate");
  });

  it("recordAiUsageCall records through the same writer, and a cost without a source is refused, not thrown", async () => {
    const f = fakeDeps();
    expect(await recordAiUsageCall(ctx, { capability: "llm", outcome: "incurred", costUsd: 0.02, costSource: "table" }, f.deps)).toEqual({ ok: true, id: ID });
    expect(f.queries[0].values[16]).toBe("incurred");
    const g = fakeDeps();
    await expect(recordAiUsageCall(ctx, { capability: "llm", outcome: "ok", costUsd: 0.02 }, g.deps)).resolves.toMatchObject({ ok: false });
    expect(g.queries).toHaveLength(0);
  });
});
