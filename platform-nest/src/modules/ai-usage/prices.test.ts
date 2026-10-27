// AIP-04 — the price table's arithmetic and the cost rule (AIP-D11), pure unit tests (no database). The database half is ai-model-prices.db.test.ts.
//
// Proves: the NEWEST price on or before the call's UTC day wins; no price (wrong model, or the day is before the first row) gives NULL, never 0;
// the provider's own cost beats the table and keeps its label; both token counts are needed; a failing lookup leaves the cost NULL; and the
// writer puts the table's cost, labelled 'table', into the INSERT.
import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";
import { computeCostUsd, pickPrice, resolveEventCost, utcDay, type ModelPrice, type PriceLookup } from "./prices";
import { recordAiUsage, type AiUsageDeps, type AiUsageEvent } from "./writer";

const T = "11111111-1111-4111-8111-111111111111";
const price = (over: Partial<ModelPrice> = {}): ModelPrice => ({
  provider: "openai", model: "m1", promptUsdPerMtok: 0.5, completionUsdPerMtok: 2, effectiveFrom: "2026-01-01", ...over,
});
const event = (over: Partial<AiUsageEvent> = {}): AiUsageEvent => ({
  tenantId: T, surface: "assistant", capability: "llm", tokensSource: "provider", outcome: "ok",
  provider: "openai", model: "m1", promptTokens: 1000, completionTokens: 500, occurredAt: "2026-10-27T10:00:00Z", ...over,
});

describe("AIP-04 · pickPrice", () => {
  const rows = [
    price({ effectiveFrom: "2026-01-01", promptUsdPerMtok: 1, completionUsdPerMtok: 1 }),
    price({ effectiveFrom: "2026-06-01", promptUsdPerMtok: 2, completionUsdPerMtok: 2 }),
    price({ effectiveFrom: "2026-11-01", promptUsdPerMtok: 3, completionUsdPerMtok: 3 }),
    price({ model: "other", effectiveFrom: "2026-02-01", promptUsdPerMtok: 9, completionUsdPerMtok: 9 }),
  ];
  it("the newest row on or before the day wins", () => {
    expect(pickPrice(rows, "openai", "m1", "2026-10-27")?.promptUsdPerMtok).toBe(2);
    expect(pickPrice(rows, "openai", "m1", "2026-06-01")?.promptUsdPerMtok).toBe(2); // the effective day itself counts
    expect(pickPrice(rows, "openai", "m1", "2026-05-31")?.promptUsdPerMtok).toBe(1);
    expect(pickPrice(rows, "openai", "m1", "2027-01-01")?.promptUsdPerMtok).toBe(3);
  });
  it("order of the rows does not matter", () => {
    expect(pickPrice([...rows].reverse(), "openai", "m1", "2026-10-27")?.promptUsdPerMtok).toBe(2);
  });
  it("no row gives null: a day before the first row, another model, another provider", () => {
    expect(pickPrice(rows, "openai", "m1", "2025-12-31")).toBeNull();
    expect(pickPrice(rows, "openai", "nope", "2026-10-27")).toBeNull();
    expect(pickPrice(rows, "ollama", "m1", "2026-10-27")).toBeNull();
    expect(pickPrice([], "openai", "m1", "2026-10-27")).toBeNull();
  });
});

describe("AIP-04 · computeCostUsd", () => {
  it("is prompt*rate + completion*rate, per million tokens", () => {
    expect(computeCostUsd(price({ promptUsdPerMtok: 0.5, completionUsdPerMtok: 2 }), 1_000_000, 1_000_000)).toBeCloseTo(2.5, 10);
    expect(computeCostUsd(price({ promptUsdPerMtok: 0.5, completionUsdPerMtok: 2 }), 1000, 500)).toBeCloseTo(0.0015, 10);
    expect(computeCostUsd(price(), 0, 0)).toBe(0); // zero tokens really cost zero: both counts are known
  });
  it("needs BOTH counts: one missing is unknown, not zero", () => {
    expect(computeCostUsd(price(), 1000, null)).toBeNull();
    expect(computeCostUsd(price(), undefined, 500)).toBeNull();
    expect(computeCostUsd(price(), null, null)).toBeNull();
  });
});

describe("AIP-04 · utcDay", () => {
  it("is the UTC day of the call, not the local one", () => {
    expect(utcDay("2026-10-27T23:30:00-05:00")).toBe("2026-10-28");
    expect(utcDay(new Date("2026-10-27T00:00:00Z"))).toBe("2026-10-27");
    expect(utcDay(null, new Date("2026-03-04T12:00:00Z"))).toBe("2026-03-04");
    expect(utcDay("garbage", new Date("2026-03-04T12:00:00Z"))).toBe("2026-03-04");
  });
});

describe("AIP-04 · resolveEventCost (AIP-D11)", () => {
  const lookupOf = (rows: ModelPrice[]): PriceLookup => vi.fn(async (p, m, d) => pickPrice(rows, p, m, d));

  it("fills the gap: tokens and no cost, a price in force, gives the table cost labelled 'table'", async () => {
    const lookup = lookupOf([price()]);
    const out = await resolveEventCost(event(), lookup);
    expect(out.costUsd).toBeCloseTo(0.0015, 10);
    expect(out.costSource).toBe("table");
    expect(lookup).toHaveBeenCalledWith("openai", "m1", "2026-10-27");
  });

  it("the provider cost beats the table: the event comes back untouched and the table is never read", async () => {
    const lookup = lookupOf([price()]);
    const e = event({ costUsd: 0.000123, costSource: "provider" });
    const out = await resolveEventCost(e, lookup);
    expect(out).toBe(e);
    expect(lookup).not.toHaveBeenCalled();
    // a provider cost of exactly 0 is a figure too
    const z = event({ costUsd: 0, costSource: "provider" });
    expect(await resolveEventCost(z, lookup)).toBe(z);
  });

  it("no price in force leaves the cost NULL (unknown is not zero)", async () => {
    const out = await resolveEventCost(event({ occurredAt: "2025-01-01T00:00:00Z" }), lookupOf([price()]));
    expect(out.costUsd).toBeUndefined();
    expect(out.costSource).toBeUndefined();
    const unknownModel = await resolveEventCost(event({ model: "zzz" }), lookupOf([price()]));
    expect(unknownModel.costUsd).toBeUndefined();
  });

  it("uses the price in force on the CALL day, not today", async () => {
    const rows = [price({ effectiveFrom: "2026-01-01", promptUsdPerMtok: 1, completionUsdPerMtok: 1 }), price({ effectiveFrom: "2026-10-01", promptUsdPerMtok: 10, completionUsdPerMtok: 10 })];
    const old = await resolveEventCost(event({ occurredAt: "2026-09-30T10:00:00Z", promptTokens: 1_000_000, completionTokens: 0 }), lookupOf(rows));
    expect(old.costUsd).toBeCloseTo(1, 10);
    const now = await resolveEventCost(event({ occurredAt: "2026-10-01T00:00:00Z", promptTokens: 1_000_000, completionTokens: 0 }), lookupOf(rows));
    expect(now.costUsd).toBeCloseTo(10, 10);
  });

  it("is not reached for an event with no provider, no model, or only one token count: no lookup, cost stays NULL", async () => {
    const lookup = lookupOf([price()]);
    for (const e of [event({ provider: null }), event({ model: null }), event({ promptTokens: null }), event({ completionTokens: null }), event({ promptTokens: undefined, completionTokens: undefined })]) {
      expect((await resolveEventCost(e, lookup)).costUsd).toBeUndefined();
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it("a lookup that throws leaves the event as it was; it never throws", async () => {
    const out = await resolveEventCost(event(), async () => { throw new Error("relation ai_model_prices does not exist"); });
    expect(out.costUsd).toBeUndefined();
  });

  it("prices a labelled ESTIMATE the same way; tokens_source stays 'estimate' (the cost is only as good as the counts)", async () => {
    const out = await resolveEventCost(event({ tokensSource: "estimate" }), lookupOf([price()]));
    expect(out.costSource).toBe("table");
    expect(out.tokensSource).toBe("estimate");
  });
});

describe("AIP-04 · the writer uses it", () => {
  function fake(lookupPrice: PriceLookup) {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const deps: AiUsageDeps = {
      warn: vi.fn(), newId: () => "66666666-6666-4666-8666-666666666666", lookupPrice,
      withTenants: async <R,>(_t: string[], fn: (c: PoolClient) => Promise<R>): Promise<R> =>
        fn({ query: async (text: string, values: unknown[]) => { queries.push({ text, values }); return { rows: [] }; } } as unknown as PoolClient),
    };
    return { deps, queries };
  }
  it("INSERTs the table cost with cost_source 'table'", async () => {
    const f = fake(async (p, m, d) => pickPrice([price()], p, m, d));
    expect(await recordAiUsage(event(), f.deps)).toMatchObject({ ok: true });
    expect(f.queries[0].values[14]).toBe("0.00150000");
    expect(f.queries[0].values[15]).toBe("table");
  });
  it("INSERTs the provider cost untouched with cost_source 'provider', and never asks the table", async () => {
    const lookup = vi.fn(async () => price());
    const f = fake(lookup);
    await recordAiUsage(event({ costUsd: 0.5, costSource: "provider" }), f.deps);
    expect(f.queries[0].values[14]).toBe("0.50000000");
    expect(f.queries[0].values[15]).toBe("provider");
    expect(lookup).not.toHaveBeenCalled();
  });
  it("INSERTs a NULL cost when no price is in force", async () => {
    const f = fake(async () => null);
    await recordAiUsage(event(), f.deps);
    expect(f.queries[0].values[14]).toBeNull();
    expect(f.queries[0].values[15]).toBeNull();
  });
  it("a failing lookup does not stop the row: it is written with a NULL cost", async () => {
    const f = fake(async () => { throw new Error("boom"); });
    expect(await recordAiUsage(event(), f.deps)).toMatchObject({ ok: true });
    expect(f.queries[0].values[14]).toBeNull();
  });
});
