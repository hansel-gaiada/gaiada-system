// AIP-15 (FRONTEND-BFF-CONTRACT §66) — the pure halves of the AI usage reads (no database; always runs). The routes over real Postgres and
// Cerbos are reads.http.test.ts.
//
// Proves: the month is the UTC calendar month (absent: the current one, read in UTC even at a month's edge in another zone), `YYYY-MM` only,
// everything else a 400 naming `month`; December rolls into January; a figures row maps to numbers, an unreported sum stays null (never 0),
// and cost stays an exact decimal string; the resource carries only the company, the ancestry and the GM seats.
import { describe, it, expect } from "vitest";
import { UsageRuleError, parseMonth, toFigures } from "./reads.service";
import { AI_USAGE_ACTIONS, aiUsageResource } from "./authz";

describe("AIP-15 · parseMonth", () => {
  it("YYYY-MM is that UTC month, [first instant, first instant of the next month)", () => {
    expect(parseMonth("2026-10")).toEqual({ month: "2026-10", start: "2026-10-01T00:00:00Z", end: "2026-11-01T00:00:00Z" });
    expect(parseMonth("2026-12")).toEqual({ month: "2026-12", start: "2026-12-01T00:00:00Z", end: "2027-01-01T00:00:00Z" });
    expect(parseMonth("2027-02").end).toBe("2027-03-01T00:00:00Z");
  });

  it("absent: the CURRENT UTC month, even when a local clock is already in the next month", () => {
    // 2026-10-31T20:00Z is 2026-11-01 04:00 in UTC+8: still October in UTC.
    expect(parseMonth(undefined, new Date("2026-10-31T20:00:00Z")).month).toBe("2026-10");
    expect(parseMonth(undefined, new Date("2026-11-01T00:00:00Z")).month).toBe("2026-11");
  });

  it("anything else is a 400 naming `month`", () => {
    for (const bad of ["", "2026-13", "2026-00", "2026-1", "26-10", "2026-10-01", "2026/10", " 2026-10", "2026-10 ", "oct", "1969-12", "9999-01", ["2026-10", "2026-11"], 202610, null, {}]) {
      let err: unknown = null;
      try {
        parseMonth(bad as unknown);
      } catch (e) {
        err = e;
      }
      expect(err, JSON.stringify(bad)).toBeInstanceOf(UsageRuleError);
      expect((err as UsageRuleError).httpStatus).toBe(400);
      expect((err as UsageRuleError).field).toBe("month");
    }
  });

  it("the edges of the accepted years", () => {
    expect(parseMonth("1970-01").start).toBe("1970-01-01T00:00:00Z");
    expect(parseMonth("9998-12").end).toBe("9999-01-01T00:00:00Z");
  });
});

describe("AIP-15 · toFigures", () => {
  const row = {
    calls: "3", prompt_tokens: "120", completion_tokens: "45", cost_usd: "0.00106000", estimated_token_calls: "1", no_token_calls: "0",
    no_cost_calls: "1", provider_cost_calls: "2", table_cost_calls: "0",
  };

  it("maps a figures row: counts and token sums as numbers, cost as the exact decimal string", () => {
    expect(toFigures(row)).toEqual({
      calls: 3, promptTokens: 120, completionTokens: 45, costUsd: "0.00106000", estimatedTokenCalls: 1, noTokenCalls: 0, noCostCalls: 1,
      providerCostCalls: 2, tableCostCalls: 0,
    });
  });

  it("a sum nobody reported stays null (unknown), never 0; an empty group is 0 calls with null sums", () => {
    const f = toFigures({ ...row, prompt_tokens: null, completion_tokens: null, cost_usd: null, no_cost_calls: "3", provider_cost_calls: "0" });
    expect([f.promptTokens, f.completionTokens, f.costUsd]).toEqual([null, null, null]);
    const empty = toFigures({
      calls: "0", prompt_tokens: null, completion_tokens: null, cost_usd: null, estimated_token_calls: "0", no_token_calls: "0", no_cost_calls: "0",
      provider_cost_calls: "0", table_cost_calls: "0",
    });
    expect(empty).toMatchObject({ calls: 0, promptTokens: null, completionTokens: null, costUsd: null });
  });

  it("a reported zero is a zero", () => {
    expect(toFigures({ ...row, prompt_tokens: "0", cost_usd: "0.00000000" })).toMatchObject({ promptTokens: 0, costUsd: "0.00000000" });
  });
});

describe("AIP-15 · aiUsageResource", () => {
  it("is the company, the unit's ancestry and the GM seats; nothing else, and copies (never aliases) the lists", () => {
    const anc = ["d-web", "d-corp"];
    const r = aiUsageResource("t1", { unitAncestors: anc, gmIds: ["u-gm"] });
    expect(r).toEqual({ kind: "ai_usage", tenantId: "t1", unitAncestors: ["d-web", "d-corp"], gmIds: ["u-gm"] });
    anc.push("x");
    expect(r.unitAncestors).toEqual(["d-web", "d-corp"]);
    expect(aiUsageResource("t1")).toEqual({ kind: "ai_usage", tenantId: "t1", unitAncestors: [], gmIds: [] });
  });

  it("names the six actions of the policy", () => {
    expect([...AI_USAGE_ACTIONS]).toEqual(["read_own", "read_unit", "read_company", "read_people", "manage", "lift_stop"]);
  });
});
