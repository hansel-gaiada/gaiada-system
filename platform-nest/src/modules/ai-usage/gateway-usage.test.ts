// AIP-03a — the shared recorder every gateway client ends in (gateway-usage.ts), pure unit tests (no database).
//
// Proves: the gateway's usage object is read strictly (never invented); a refusal maps to the right outcome and carries no tokens; provider
// counts and cost are labelled 'provider', an estimate 'estimate', nothing 'none'; a free-text name cannot cost the whole row; the person's
// department is resolved from the primary placement, cached for 10 minutes (a null too), never cached on failure, and a call site's own
// department wins; and recordGatewayCall never rejects, whatever fails.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  aiAttribution, clearUnitCacheForTests, outcomeForGatewayStatus, readGatewayUsage, recordGatewayCall, resolvePrimaryUnitId, statusFromError,
  toAiUsageCall, type AiCallAttribution,
} from "./gateway-usage";
import type { AiUsageDeps } from "./writer";

const T = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";
const D = "33333333-3333-4333-8333-333333333333";
const TH = "44444444-4444-4444-8444-444444444444";
const ID = "66666666-6666-4666-8666-666666666666";

beforeEach(() => clearUnitCacheForTests());

describe("AIP-03a · readGatewayUsage", () => {
  it("reads the AIP-02 shape: counts, cost, source provider", () => {
    expect(readGatewayUsage({ promptTokens: 11, completionTokens: 7, costUsd: 0.000123, source: "provider" })).toEqual({ promptTokens: 11, completionTokens: 7, costUsd: 0.000123 });
  });
  it("a cost the upstream did not send is null; a reported 0 is kept", () => {
    expect(readGatewayUsage({ promptTokens: 1, completionTokens: 2, source: "provider" })?.costUsd).toBeNull();
    expect(readGatewayUsage({ promptTokens: 1, completionTokens: 2, costUsd: 0, source: "provider" })?.costUsd).toBe(0);
  });
  it("is null for anything that is not real provider counts", () => {
    for (const bad of [undefined, null, "x", 5, [], {}, { promptTokens: 1 }, { promptTokens: "1", completionTokens: 2 }, { promptTokens: -1, completionTokens: 2 },
      { promptTokens: 1.5, completionTokens: 2 }, { promptTokens: 1, completionTokens: 2, source: "estimate" }, { promptTokens: 1e12, completionTokens: 2 }]) {
      expect(readGatewayUsage(bad), JSON.stringify(bad)).toBeNull();
    }
  });
  it("a malformed cost is dropped, the counts survive", () => {
    expect(readGatewayUsage({ promptTokens: 1, completionTokens: 2, costUsd: -3, source: "provider" })).toEqual({ promptTokens: 1, completionTokens: 2, costUsd: null });
    expect(readGatewayUsage({ promptTokens: 1, completionTokens: 2, costUsd: "0.1" })?.costUsd).toBeNull();
  });
});

describe("AIP-03a · outcomes", () => {
  it("429 is the budget cap, 503 is DLP, everything else is an error", () => {
    expect(outcomeForGatewayStatus(429)).toBe("blocked_budget");
    expect(outcomeForGatewayStatus(503)).toBe("blocked_dlp");
    for (const s of [400, 401, 500, 502, 504]) expect(outcomeForGatewayStatus(s)).toBe("error");
  });
  it("reads the status out of a client error message, never a body", () => {
    expect(statusFromError(new Error("ai-gateway /complete returned HTTP 429"))).toBe(429);
    expect(statusFromError(new Error("This operation was aborted"))).toBeNull();
    expect(statusFromError(undefined)).toBeNull();
  });
});

describe("AIP-03a · toAiUsageCall", () => {
  it("provider counts and cost: tokens_source provider, cost_source provider", () => {
    const c = toAiUsageCall({ capability: "llm", outcome: "ok", provider: "openai", model: "z-ai/glm-5.3-flash", usage: { promptTokens: 11, completionTokens: 7, costUsd: 0.000123 } }, { task: "social.caption" });
    expect(c).toMatchObject({ capability: "llm", outcome: "ok", provider: "openai", model: "z-ai/glm-5.3-flash", task: "social.caption", promptTokens: 11, completionTokens: 7, tokensSource: "provider", costUsd: 0.000123, costSource: "provider" });
  });
  it("provider counts with no cost: no cost and no label (the writer then asks the price table)", () => {
    const c = toAiUsageCall({ capability: "llm", outcome: "ok", usage: { promptTokens: 1, completionTokens: 2, costUsd: null } }, {});
    expect(c.tokensSource).toBe("provider");
    expect(c.costUsd).toBeUndefined();
    expect(c.costSource).toBeUndefined();
  });
  it("no usage and an estimate: tokens_source estimate; no usage and no estimate: none", () => {
    expect(toAiUsageCall({ capability: "llm", outcome: "ok", estimate: { promptTokens: 40, completionTokens: 10 } }, {})).toMatchObject({ tokensSource: "estimate", promptTokens: 40, completionTokens: 10 });
    expect(toAiUsageCall({ capability: "embed", outcome: "ok" }, {})).toMatchObject({ tokensSource: "none" });
    expect(toAiUsageCall({ capability: "embed", outcome: "ok" }, {}).promptTokens).toBeUndefined();
  });
  it("real usage beats an estimate", () => {
    const c = toAiUsageCall({ capability: "llm", outcome: "ok", usage: { promptTokens: 5, completionTokens: 6, costUsd: null }, estimate: { promptTokens: 99, completionTokens: 99 } }, {});
    expect(c).toMatchObject({ tokensSource: "provider", promptTokens: 5, completionTokens: 6 });
  });
  it("a refused call carries no tokens and no cost, whatever was passed", () => {
    for (const outcome of ["blocked_dlp", "blocked_budget", "error"] as const) {
      const c = toAiUsageCall({ capability: "llm", outcome, usage: { promptTokens: 5, completionTokens: 6, costUsd: 0.1 }, estimate: { promptTokens: 1, completionTokens: 1 } }, {});
      expect(c.tokensSource, outcome).toBe("none");
      expect(c.promptTokens).toBeUndefined();
      expect(c.costUsd).toBeUndefined();
    }
  });
  it("an 'incurred' call keeps its figures (the money counts)", () => {
    expect(toAiUsageCall({ capability: "llm", outcome: "incurred", usage: { promptTokens: 5, completionTokens: 6, costUsd: 0.1 } }, {})).toMatchObject({ outcome: "incurred", costUsd: 0.1, costSource: "provider" });
  });
  it("a name with a space in it becomes null instead of costing the whole row", () => {
    const c = toAiUsageCall({ capability: "llm", outcome: "ok", provider: "open ai", model: "some model name", providerHint: "claude" }, { task: "a whole sentence of text" });
    expect(c.provider).toBeNull();
    expect(c.model).toBeNull();
    expect(c.task).toBeNull();
    expect(c.gatewayProviderHint).toBe("claude");
  });
});

describe("AIP-03a · aiAttribution", () => {
  it("takes the person from the principal, or null when there is none", () => {
    expect(aiAttribution({ userId: U }, T, "search", { task: "search.x" })).toEqual({ tenantId: T, userId: U, surface: "search", task: "search.x" });
    expect(aiAttribution(undefined, T, "other").userId).toBeNull();
    expect(aiAttribution({ userId: null }, T, "other").userId).toBeNull();
  });
});

describe("AIP-03a · the department of a person", () => {
  /** A fake withTenants whose client answers the placement query with `rows` (or throws). */
  function placement(rows: Array<{ id: string }> | Error) {
    const calls: Array<{ tenants: string[]; values: unknown[] }> = [];
    const fn = (async (tenants: string[], cb: (c: PoolClient) => Promise<unknown>) => {
      calls.push({ tenants, values: [] });
      if (rows instanceof Error) throw rows;
      return cb({ query: async (_t: string, values: unknown[]) => { calls[calls.length - 1].values = values; return { rows }; } } as unknown as PoolClient);
    }) as never;
    return { fn, calls };
  }

  it("reads the primary placement under the company's own tenant context, and returns the org_units id", async () => {
    const p = placement([{ id: D }]);
    expect(await resolvePrimaryUnitId(T, U, { withTenants: p.fn })).toBe(D);
    expect(p.calls).toEqual([{ tenants: [T], values: [T, U] }]);
  });

  it("is cached for 10 minutes: the second call does not read; the 11th minute does", async () => {
    const p = placement([{ id: D }]);
    let now = 1_000_000;
    const deps = { withTenants: p.fn, now: () => now };
    await resolvePrimaryUnitId(T, U, deps);
    now += 9 * 60_000;
    await resolvePrimaryUnitId(T, U, deps);
    expect(p.calls).toHaveLength(1);
    now += 2 * 60_000;
    await resolvePrimaryUnitId(T, U, deps);
    expect(p.calls).toHaveLength(2);
  });

  it("a person with no placement is null, and that null is cached too", async () => {
    const p = placement([]);
    expect(await resolvePrimaryUnitId(T, U, { withTenants: p.fn })).toBeNull();
    expect(await resolvePrimaryUnitId(T, U, { withTenants: p.fn })).toBeNull();
    expect(p.calls).toHaveLength(1);
  });

  it("a failure is a null and is NOT cached (the next call tries again)", async () => {
    const bad = placement(new Error("connection refused"));
    expect(await resolvePrimaryUnitId(T, U, { withTenants: bad.fn })).toBeNull();
    const good = placement([{ id: D }]);
    expect(await resolvePrimaryUnitId(T, U, { withTenants: good.fn })).toBe(D);
  });

  it("is keyed by company AND person", async () => {
    const p = placement([{ id: D }]);
    await resolvePrimaryUnitId(T, U, { withTenants: p.fn });
    await resolvePrimaryUnitId("55555555-5555-4555-8555-555555555555", U, { withTenants: p.fn });
    await resolvePrimaryUnitId(T, "77777777-7777-4777-8777-777777777777", { withTenants: p.fn });
    expect(p.calls).toHaveLength(3);
  });
});

describe("AIP-03a · recordGatewayCall", () => {
  const attr = (over: Partial<AiCallAttribution> = {}): AiCallAttribution => ({ tenantId: T, userId: U, surface: "search", task: "search.brief_draft", ...over });
  function writerDeps(fail?: unknown) {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const warn = vi.fn();
    const writer: AiUsageDeps = {
      warn, newId: () => ID, lookupPrice: async () => null,
      withTenants: async <R,>(_t: string[], fn: (c: PoolClient) => Promise<R>): Promise<R> => {
        if (fail !== undefined) throw fail;
        return fn({ query: async (text: string, values: unknown[]) => { queries.push({ text, values }); return { rows: [] }; } } as unknown as PoolClient);
      },
    };
    return { writer, queries, warn };
  }
  // INSERT parameter order: id, tenant, occurred_at, user, org_unit, surface, capability, task, tier, provider, model, prompt, completion, tokens_source, cost, cost_source, outcome, thread, run, hint
  const V = { tenant: 1, user: 3, unit: 4, surface: 5, capability: 6, task: 7, provider: 9, model: 10, prompt: 11, completion: 12, tokensSource: 13, cost: 14, costSource: 15, outcome: 16, thread: 17, run: 18, hint: 19 };

  it("writes ONE row with the attribution, the provider tokens and the provider cost", async () => {
    const w = writerDeps();
    await recordGatewayCall(attr({ threadId: TH }), { capability: "llm", outcome: "ok", provider: "openai", model: "z-ai/glm-5.3-flash", usage: { promptTokens: 11, completionTokens: 7, costUsd: 0.000123 }, providerHint: "claude" }, { resolveUnit: async () => D, writer: w.writer });
    expect(w.queries).toHaveLength(1);
    const v = w.queries[0].values;
    expect([v[V.tenant], v[V.user], v[V.unit], v[V.surface], v[V.capability], v[V.task], v[V.thread], v[V.hint]]).toEqual([T, U, D, "search", "llm", "search.brief_draft", TH, "claude"]);
    expect([v[V.provider], v[V.model], v[V.prompt], v[V.completion], v[V.tokensSource], v[V.cost], v[V.costSource], v[V.outcome]]).toEqual(["openai", "z-ai/glm-5.3-flash", 11, 7, "provider", "0.00012300", "provider", "ok"]);
  });

  it("a call with no usage writes 'none'; with an estimate writes 'estimate'", async () => {
    const a = writerDeps();
    await recordGatewayCall(attr(), { capability: "embed", outcome: "ok" }, { resolveUnit: async () => null, writer: a.writer });
    expect(a.queries[0].values[V.tokensSource]).toBe("none");
    expect(a.queries[0].values[V.prompt]).toBeNull();
    const b = writerDeps();
    await recordGatewayCall(attr(), { capability: "llm", outcome: "ok", estimate: { promptTokens: 40, completionTokens: 10 } }, { resolveUnit: async () => null, writer: b.writer });
    expect([b.queries[0].values[V.tokensSource], b.queries[0].values[V.prompt], b.queries[0].values[V.completion]]).toEqual(["estimate", 40, 10]);
  });

  it("a refused call writes its outcome with no tokens", async () => {
    const w = writerDeps();
    await recordGatewayCall(attr(), { capability: "llm", outcome: "blocked_dlp" }, { resolveUnit: async () => null, writer: w.writer });
    expect([w.queries[0].values[V.outcome], w.queries[0].values[V.tokensSource], w.queries[0].values[V.cost]]).toEqual(["blocked_dlp", "none", null]);
  });

  it("the call site's own department wins and nothing is resolved; an explicit null means 'none', also not resolved", async () => {
    const resolveUnit = vi.fn(async () => D);
    const a = writerDeps();
    await recordGatewayCall(attr({ orgUnitId: "88888888-8888-4888-8888-888888888888" }), { capability: "llm", outcome: "ok" }, { resolveUnit, writer: a.writer });
    expect(a.queries[0].values[V.unit]).toBe("88888888-8888-4888-8888-888888888888");
    const b = writerDeps();
    await recordGatewayCall(attr({ orgUnitId: null }), { capability: "llm", outcome: "ok" }, { resolveUnit, writer: b.writer });
    expect(b.queries[0].values[V.unit]).toBeNull();
    expect(resolveUnit).not.toHaveBeenCalled();
  });

  it("a call with no person has no department and resolves nothing; the row is still written (a bot or a job)", async () => {
    const resolveUnit = vi.fn(async () => D);
    const w = writerDeps();
    await recordGatewayCall(attr({ userId: null }), { capability: "llm", outcome: "ok" }, { resolveUnit, writer: w.writer });
    expect(resolveUnit).not.toHaveBeenCalled();
    expect([w.queries[0].values[V.user], w.queries[0].values[V.unit]]).toEqual([null, null]);
  });

  it("a bot is recorded with its own user id", async () => {
    const w = writerDeps();
    await recordGatewayCall(attr({ userId: U }), { capability: "llm", outcome: "ok" }, { resolveUnit: async () => null, writer: w.writer });
    expect(w.queries[0].values[V.user]).toBe(U);
  });

  it("never rejects: the writer failing, the resolver throwing, a bad company, a malformed attribution", async () => {
    const failing = writerDeps(new Error("db down"));
    await expect(recordGatewayCall(attr(), { capability: "llm", outcome: "ok" }, { resolveUnit: async () => D, writer: failing.writer })).resolves.toMatchObject({ ok: false });
    expect(failing.warn).toHaveBeenCalledTimes(1);
    const ok = writerDeps();
    await expect(recordGatewayCall(attr(), { capability: "llm", outcome: "ok" }, { resolveUnit: async () => { throw new Error("x"); }, writer: ok.writer })).resolves.toBeNull();
    await expect(recordGatewayCall(attr({ tenantId: "no-company" }), { capability: "llm", outcome: "ok" }, { writer: ok.writer })).resolves.toBeNull();
    await expect(recordGatewayCall(undefined as never, { capability: "llm", outcome: "ok" })).resolves.toBeNull();
    expect(ok.queries).toHaveLength(0);
  });

  it("a bad company records nothing (there is no row without one)", async () => {
    const w = writerDeps();
    expect(await recordGatewayCall(attr({ tenantId: "" }), { capability: "llm", outcome: "ok" }, { writer: w.writer })).toBeNull();
    expect(w.queries).toHaveLength(0);
  });
});
