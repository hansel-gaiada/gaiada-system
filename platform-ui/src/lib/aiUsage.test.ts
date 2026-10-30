import { describe, it, expect } from "vitest";
import {
  asCompanyUsage, asFigures, asMyUsage, asUnitUsage, companyAiUsageHref, companyUsagePath, costGapMark, costMark, currentMonth, dayLabel, departmentAiUsageHref,
  departmentLabel, figureNotes, formatCost, formatTokens, isEmptyMonth, modelLabel, monthLabel, myAiUsageHref, myUsagePath, noUseText, parseMonth, personLabel,
  recentMonths, shiftMonth, surfaceLabel, tokenMark, unitUsagePath, type UsageFigures,
} from "./aiUsage";

// AIP-16 and AIP-05 (BFF section 66): the pure half. Cost and token words, unknown vs 0, the month, the answer's checks.
const FIG = {
  calls: 12, promptTokens: 3400, completionTokens: 900, costUsd: "0.00106000",
  estimatedTokenCalls: 0, noTokenCalls: 0, noCostCalls: 0, providerCostCalls: 12, tableCostCalls: 0,
};
const f = (over: Partial<UsageFigures> = {}): UsageFigures => ({ ...FIG, ...over });

describe("formatCost: a decimal string, never a float", () => {
  it("shows four decimals under a dollar, half up", () => {
    expect(formatCost("0.00106000")).toBe("$0.0011");
    expect(formatCost("0.00104999")).toBe("$0.0010");
    expect(formatCost("0.00105")).toBe("$0.0011");
    expect(formatCost("0.5")).toBe("$0.5000");
    expect(formatCost("0.1234")).toBe("$0.1234");
    expect(formatCost("0.0001")).toBe("$0.0001");
  });
  it("says 'under $0.0001' for a non-zero cost below it, and never $0.0000", () => {
    expect(formatCost("0.00009999")).toBe("under $0.0001");
    expect(formatCost("0.00000001")).toBe("under $0.0001");
    expect(formatCost("0.0000000000000000001")).toBe("under $0.0001");
  });
  it("is exact for a figure a float would mangle", () => {
    expect(formatCost("0.00010000000000000001")).toBe("$0.0001");
    expect(formatCost("0.00009999999999999999")).toBe("under $0.0001");
    expect(formatCost("0.30000000000000004")).toBe("$0.3000");
  });
  it("shows a known zero as $0.0000 and a missing cost as unknown, never $0", () => {
    expect(formatCost("0")).toBe("$0.0000");
    expect(formatCost("0.00000000")).toBe("$0.0000");
    expect(formatCost(null)).toBe("unknown");
  });
  it("shows two decimals and thousands separators from a dollar up", () => {
    expect(formatCost("1")).toBe("$1.00");
    expect(formatCost("12.3456")).toBe("$12.35");
    expect(formatCost("1234567.891")).toBe("$1,234,567.89");
    expect(formatCost("0.99996")).toBe("$1.00");
  });
  it("reads a value that is not a plain decimal string as unknown rather than guessing", () => {
    expect(formatCost("1e-7")).toBe("unknown");
    expect(formatCost("-0.5")).toBe("unknown");
    expect(formatCost("")).toBe("unknown");
  });
});

describe("tokens: null is unknown, never 0", () => {
  it("formats a sum, and a missing sum as unknown", () => {
    expect(formatTokens(3400)).toBe("3,400");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(null)).toBe("unknown");
  });
});

describe("what a figure says about itself", () => {
  it("marks estimated tokens", () => {
    expect(tokenMark(f({ estimatedTokenCalls: 2 }))).toBe("estimated");
    expect(tokenMark(f())).toBeNull();
  });
  it("marks a cost from our price table, wholly or partly, and leaves the provider's own unmarked", () => {
    expect(costMark(f({ providerCostCalls: 0, tableCostCalls: 3 }))).toBe("from our price table");
    expect(costMark(f({ providerCostCalls: 8, tableCostCalls: 1 }))).toBe("partly from our price table");
    expect(costMark(f())).toBeNull();
  });
  it("marks a cost that leaves calls out as partial, never when the cost is unknown", () => {
    expect(costGapMark(f({ noCostCalls: 3 }))).toBe("partial");
    expect(costGapMark(f({ noCostCalls: 3, costUsd: null }))).toBeNull();
    expect(costGapMark(f())).toBeNull();
  });
  it("writes sentences for estimates, calls with no tokens, the price table and calls with no cost", () => {
    expect(figureNotes(f())).toEqual(["Cost is the provider's own figure."]);
    const notes = figureNotes(f({ estimatedTokenCalls: 2, noTokenCalls: 1, tableCostCalls: 1, providerCostCalls: 8, noCostCalls: 3 }));
    expect(notes).toContain("Tokens are estimated for 2 calls (about 4 characters a token).");
    expect(notes).toContain("1 call reported no token counts, so the token sums leave them out.");
    expect(notes).toContain("Cost is from our price table for 1 call and the provider's own figure for 8 calls.");
    expect(notes).toContain("3 calls had no cost figure, so the cost is a floor, not the whole.");
  });
  it("says an all-unpriced group's cost is unknown", () => {
    expect(figureNotes(f({ costUsd: null, noCostCalls: 12, providerCostCalls: 0 }))).toEqual(["12 calls had no cost figure, so the cost is unknown."]);
  });
});

describe("the month (UTC calendar months)", () => {
  const NOW = new Date("2026-10-30T23:59:59Z");
  it("is the current UTC month by default, and by UTC, not the local day", () => {
    expect(currentMonth(NOW)).toBe("2026-10");
    expect(currentMonth(new Date("2026-11-01T00:00:00Z"))).toBe("2026-11");
    expect(parseMonth(undefined, NOW)).toBe("2026-10");
  });
  it("takes a real month, and the first of a repeated query", () => {
    expect(parseMonth("2026-09", NOW)).toBe("2026-09");
    expect(parseMonth(["2026-08", "2026-09"], NOW)).toBe("2026-08");
    expect(parseMonth("2026-10", NOW)).toBe("2026-10");
  });
  it("never passes on anything else: a bad month, a day, a month 13, a month after this one", () => {
    for (const bad of ["", "2026", "2026-13", "2026-00", "2026-9", "2026-09-01", "26-09", "Oct 2026", "2026-11", "2027-01", "1969-12"]) {
      expect(parseMonth(bad, NOW), bad).toBe("2026-10");
    }
  });
  it("shifts across a year", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-10", -10)).toBe("2025-12");
  });
  it("lists the last twelve months, newest first", () => {
    const m = recentMonths(NOW, 12);
    expect(m).toHaveLength(12);
    expect(m[0]).toBe("2026-10");
    expect(m[11]).toBe("2025-11");
  });
  it("words a month and a day", () => {
    expect(monthLabel("2026-10")).toBe("October 2026");
    expect(monthLabel("nonsense")).toBe("nonsense");
    expect(dayLabel("2026-10-03")).toBe("3 Oct");
  });
  it("says an empty month plainly", () => {
    expect(noUseText("2026-10")).toBe("No AI use recorded in October 2026");
    expect(isEmptyMonth(f({ calls: 0 }))).toBe(true);
    expect(isEmptyMonth(f())).toBe(false);
  });
});

describe("addresses", () => {
  it("builds the three screens' links and the three routes", () => {
    expect(myAiUsageHref()).toBe("/analytics/ai-usage");
    expect(myAiUsageHref("2026-09")).toBe("/analytics/ai-usage?month=2026-09");
    expect(departmentAiUsageHref("d-web", "2026-09")).toBe("/analytics/ai-usage/department?unit=d-web&month=2026-09");
    expect(departmentAiUsageHref(undefined, "2026-09")).toBe("/analytics/ai-usage/department?month=2026-09");
    expect(companyAiUsageHref("2026-09")).toBe("/ai-usage?month=2026-09");
    expect(myUsagePath("co-a", "2026-10")).toBe("/api/co-a/ai-usage/me?month=2026-10");
    expect(unitUsagePath("co-a", "d web/1", "2026-10")).toBe("/api/co-a/ai-usage/units/d%20web%2F1?month=2026-10");
    expect(companyUsagePath("co-a", "2026-10")).toBe("/api/co-a/ai-usage/company?month=2026-10");
  });
});

describe("words", () => {
  it("gives every known surface a readable label and keeps an unknown one visible", () => {
    expect(surfaceLabel("assistant")).toBe("Assistant replies");
    expect(surfaceLabel("knowledge")).toMatch(/^Knowledge/);
    expect(surfaceLabel("agent")).toBe("AI agents");
    expect(surfaceLabel("new_thing")).toBe("New thing");
  });
  it("says a model, a department and a person even when the name is missing", () => {
    expect(modelLabel({ provider: "openrouter", model: "glm" })).toBe("openrouter / glm");
    expect(modelLabel({ provider: null, model: null })).toBe("Model not recorded");
    expect(departmentLabel({ unitNodeId: null, name: null })).toBe("No department recorded");
    expect(departmentLabel({ unitNodeId: "d-web", name: "Web Dev" })).toBe("Web Dev");
    expect(personLabel({ name: null })).toBe("Name not available");
  });
});

describe("the answer, checked", () => {
  const wire = { ...FIG };
  it("keeps a cost as the string it came as and a null sum as null", () => {
    const g = asFigures({ ...wire, promptTokens: null, completionTokens: null });
    expect(g.costUsd).toBe("0.00106000");
    expect(g.promptTokens).toBeNull();
    expect(asFigures({ ...wire, costUsd: null }).costUsd).toBeNull();
  });
  it("takes a numeric string for a sum, and refuses a missing count rather than reading it as 0", () => {
    expect(asFigures({ ...wire, promptTokens: "3400" }).promptTokens).toBe(3400);
    const { estimatedTokenCalls: _drop, ...partial } = wire;
    expect(() => asFigures(partial)).toThrow(/estimatedTokenCalls/);
    expect(() => asFigures({ ...wire, calls: null })).toThrow(/calls/);
    expect(() => asFigures({ ...wire, promptTokens: "lots" })).toThrow(/promptTokens/);
  });
  it("refuses a cost that is a number (a float on the wire) or not a decimal", () => {
    expect(() => asFigures({ ...wire, costUsd: 0.00106 })).toThrow(/costUsd/);
    expect(() => asFigures({ ...wire, costUsd: "1e-7" })).toThrow(/costUsd/);
  });
  const caps = { canSeePeople: true, canManage: false, canLiftStop: false };
  it("reads `me`", () => {
    const a = asMyUsage({ month: "2026-10", totals: wire, bySurface: [{ surface: "assistant", ...wire }], byDay: [{ day: "2026-10-03", ...wire }], capabilities: caps });
    expect(a.bySurface[0].surface).toBe("assistant");
    expect(a.byDay[0].day).toBe("2026-10-03");
    expect(() => asMyUsage({ month: "October", totals: wire, bySurface: [], byDay: [] })).toThrow(/month/);
    expect(() => asMyUsage(null)).toThrow();
  });
  it("reads a unit, and keeps `people` ABSENT (null) when the answer had no such key, an empty list when it had one", () => {
    const base = { month: "2026-10", unit: { unitNodeId: "d-web", name: "Web Dev" }, totals: wire, bySurface: [], byModel: [{ provider: null, model: "m", ...wire }], byDay: [], capabilities: caps };
    expect(asUnitUsage(base).people).toBeNull();
    expect(asUnitUsage({ ...base, people: [] }).people).toEqual([]);
    expect(asUnitUsage({ ...base, people: [{ userId: "u-1", name: null, ...wire }] }).people?.[0]).toMatchObject({ userId: "u-1", name: null });
    expect(() => asUnitUsage({ ...base, unit: {} })).toThrow(/unit/);
  });
  it("reads the company, with the null department bucket and the no-person lines", () => {
    const a = asCompanyUsage({
      month: "2026-10", totals: wire,
      byDepartment: [{ unitNodeId: "d-web", name: "Web Dev", ...wire }, { unitNodeId: null, name: null, ...wire }],
      noPerson: [{ surface: "knowledge", ...wire }], byModel: [], bySurface: [], byDay: [], capabilities: caps,
    });
    expect(a.byDepartment.map((d) => d.unitNodeId)).toEqual(["d-web", null]);
    expect(a.noPerson[0].surface).toBe("knowledge");
    expect(() => asCompanyUsage({ month: "2026-10", totals: wire, byDepartment: "x", noPerson: [], byModel: [], bySurface: [], byDay: [] })).toThrow(/byDepartment/);
  });
});
