// AIP-17b + AIP-19 — the PURE half: money parsing, the exact percent and state arithmetic, the notice thresholds, the runaway rule, the body
// parsers, the config parsers and the job's loop switch. No database, no Cerbos: always runs.
import { describe, it, expect, vi } from "vitest";
import {
  budgetFigure, isRunaway, parseMonthlyUsd, thresholdsCrossed, toScaled, usualDaily, utcDay, utcDayMinus, MoneyError,
} from "./budgets";
import { parseAllowanceBody, parseCompanyBudgetBody, parseUnitBudgetBody, BudgetBodyError } from "./budgets.service";
import { DEFAULT_DAILY_REPLY_ALLOWANCE, parseAiUsageJobIntervalMs, parseDailyReplyAllowance } from "../../config";
import { firstTickDelayMs, startUsageAlertsLoop } from "./usage-alerts-job";

describe("AIP-17b · money", () => {
  it("accepts a positive decimal string with at most 4 places and at most 99999999.9999, in the stored form", () => {
    expect(parseMonthlyUsd("250")).toBe("250.0000");
    expect(parseMonthlyUsd("250.5")).toBe("250.5000");
    expect(parseMonthlyUsd("0.0001")).toBe("0.0001");
    expect(parseMonthlyUsd("007.10")).toBe("7.1000");
    expect(parseMonthlyUsd("99999999.9999")).toBe("99999999.9999");
  });

  it.each([
    ["a number", 250], ["zero", "0"], ["zero with places", "0.0000"], ["negative", "-1"], ["5 places", "1.00001"], ["9 integer digits", "100000000"],
    ["an exponent", "1e3"], ["a comma", "1,5"], ["a space", " 5"], ["empty", ""], ["a trailing dot", "5."], ["a leading dot", ".5"], ["text", "ten"],
    ["null", null], ["undefined", undefined], ["an object", {}], ["Infinity", "Infinity"], ["a plus sign", "+5"],
  ])("refuses %s", (_label, v) => {
    expect(() => parseMonthlyUsd(v)).toThrow(MoneyError);
  });

  it("scales exactly and refuses a non-decimal", () => {
    expect(toScaled("0.01500000")).toBe(1_500_000n);
    expect(toScaled("50.0000")).toBe(5_000_000_000n);
    expect(toScaled("7")).toBe(700_000_000n);
    expect(() => toScaled("-1")).toThrow();
    expect(() => toScaled("1e3")).toThrow();
    expect(() => toScaled("0.000000001")).toThrow();
  });
});

describe("AIP-17b · the percent and the state are exact", () => {
  it("is under below 80, over_80 from exactly 80, over_100 from exactly 100", () => {
    expect(budgetFigure("79.99999999", "100.0000").state).toBe("under");
    expect(budgetFigure("80", "100.0000").state).toBe("over_80");
    expect(budgetFigure("80.00000000", "100.0000").state).toBe("over_80");
    expect(budgetFigure("99.99999999", "100.0000").state).toBe("over_80");
    expect(budgetFigure("100", "100.0000").state).toBe("over_100");
    expect(budgetFigure("250", "100.0000").state).toBe("over_100");
  });

  it("is exact where a float would not be (0.1 + 0.2 against 0.3 at the edge)", () => {
    // 0.30000000 of 0.3750 is exactly 80 percent. A float sum of 0.1 + 0.2 is 0.30000000000000004 and 0.3 * 100 / 0.375 = 80.00000000000001.
    expect(budgetFigure("0.30000000", "0.3750").state).toBe("over_80");
    expect(budgetFigure("0.29999999", "0.3750").state).toBe("under");
  });

  it("floors the percent to one decimal and never shows a threshold it has not reached", () => {
    expect(budgetFigure("79.96", "100").percent).toBe(79.9);
    expect(budgetFigure("0", "100").percent).toBe(0);
    expect(budgetFigure("100", "100").percent).toBe(100);
    expect(budgetFigure("12.5", "50").percent).toBe(25);
    expect(budgetFigure("150", "100").percent).toBe(150);
  });

  it("treats unknown spend (null) as nothing spent: money nobody knows cannot cross a budget", () => {
    expect(budgetFigure(null, "10.0000")).toEqual({ percent: 0, state: "under" });
  });

  it("lists the thresholds crossed, lowest first", () => {
    expect(thresholdsCrossed("under")).toEqual([]);
    expect(thresholdsCrossed("over_80")).toEqual([80]);
    expect(thresholdsCrossed("over_100")).toEqual([80, 100]);
  });
});

describe("AIP-19 · the runaway rule", () => {
  const base = { today: 100, activeDays: 10, previousCalls: 100 }; // usual 10 a day; today 100 = 10x

  it("flags 5x or more of the average over ACTIVE days", () => {
    expect(isRunaway(base)).toBe(true);
    expect(isRunaway({ today: 50, activeDays: 10, previousCalls: 100 })).toBe(true); // exactly 5x
    expect(isRunaway({ today: 49, activeDays: 10, previousCalls: 100 })).toBe(false); // just under
    expect(usualDaily(base)).toBe(10);
  });

  it("averages over the days with calls only (a person active 7 days of 14 is compared with those 7)", () => {
    // 7 active days of 10 calls: usual 10. Over all 14 days the mean would be 5 and 25 would flag; over active days 25 does not.
    expect(isRunaway({ today: 25, activeDays: 7, previousCalls: 70 })).toBe(false);
    expect(isRunaway({ today: 50, activeDays: 7, previousCalls: 70 })).toBe(true);
  });

  it("needs at least 7 active days", () => {
    expect(isRunaway({ today: 1000, activeDays: 6, previousCalls: 60 })).toBe(false);
    expect(isRunaway({ today: 1000, activeDays: 7, previousCalls: 70 })).toBe(true);
    expect(isRunaway({ today: 1000, activeDays: 0, previousCalls: 0 })).toBe(false);
  });

  it("needs at least 20 calls today", () => {
    expect(isRunaway({ today: 19, activeDays: 14, previousCalls: 14 })).toBe(false);
    expect(isRunaway({ today: 20, activeDays: 14, previousCalls: 14 })).toBe(true);
  });

  it("refuses non-integers", () => {
    expect(isRunaway({ today: 100.5, activeDays: 10, previousCalls: 10 })).toBe(false);
    expect(isRunaway({ today: Number.NaN, activeDays: 10, previousCalls: 10 })).toBe(false);
  });

  it("names UTC days", () => {
    expect(utcDay(new Date("2026-10-30T23:59:59Z"))).toBe("2026-10-30");
    expect(utcDay(new Date("2026-10-31T00:00:00Z"))).toBe("2026-10-31");
    expect(utcDayMinus("2026-10-30", 14)).toBe("2026-10-16");
    expect(utcDayMinus("2026-03-05", 14)).toBe("2026-02-19");
    expect(utcDayMinus("2026-10-30", -1)).toBe("2026-10-31");
    expect(utcDayMinus("2027-01-01", 1)).toBe("2026-12-31");
  });
});

describe("AIP-17b · the request bodies", () => {
  it("company: a figure, or null; nothing else", () => {
    expect(parseCompanyBudgetBody({ monthlyUsd: "100" })).toEqual({ monthlyUsd: "100.0000" });
    expect(parseCompanyBudgetBody({ monthlyUsd: null })).toEqual({ monthlyUsd: null });
    for (const bad of [null, [], "x", {}, { monthlyUsd: 5 }, { monthlyUsd: "0" }, { monthlyUsd: "5", mode: "report" }, { monthlyUsd: undefined }]) {
      expect(() => parseCompanyBudgetBody(bad)).toThrow(BudgetBodyError);
    }
  });

  it("unit: a figure and an optional mode; a mode needs a figure", () => {
    expect(parseUnitBudgetBody({ monthlyUsd: "5" })).toEqual({ monthlyUsd: "5.0000", mode: undefined });
    expect(parseUnitBudgetBody({ monthlyUsd: "5", mode: "soft_stop" })).toEqual({ monthlyUsd: "5.0000", mode: "soft_stop" });
    expect(parseUnitBudgetBody({ monthlyUsd: null })).toEqual({ monthlyUsd: null, mode: undefined });
    for (const bad of [{ monthlyUsd: null, mode: "report" }, { monthlyUsd: "5", mode: "hard_stop" }, { monthlyUsd: "5", mode: null }, { monthlyUsd: "5", mode: 1 }, { mode: "report" }, { monthlyUsd: "5", extra: 1 }]) {
      expect(() => parseUnitBudgetBody(bad)).toThrow(BudgetBodyError);
    }
  });

  it("allowance: a whole number from 1 to 100000, or null", () => {
    expect(parseAllowanceBody({ dailyReplies: 1 })).toEqual({ dailyReplies: 1 });
    expect(parseAllowanceBody({ dailyReplies: 100000 })).toEqual({ dailyReplies: 100000 });
    expect(parseAllowanceBody({ dailyReplies: null })).toEqual({ dailyReplies: null });
    for (const bad of [{ dailyReplies: 0 }, { dailyReplies: -1 }, { dailyReplies: 100001 }, { dailyReplies: 1.5 }, { dailyReplies: "5" }, { dailyReplies: Number.NaN }, {}, null, { dailyReplies: 5, x: 1 }]) {
      expect(() => parseAllowanceBody(bad)).toThrow(BudgetBodyError);
    }
  });
});

describe("AIP-D9 · AI_DAILY_REPLY_ALLOWANCE", () => {
  it("defaults to 200 and falls back to 200 on anything invalid", () => {
    expect(DEFAULT_DAILY_REPLY_ALLOWANCE).toBe(200);
    for (const v of [undefined, "", "  ", "abc", "0", "-5", "1.5", "1e3", "100001", "99999999999999999999", "NaN"]) expect(parseDailyReplyAllowance(v)).toBe(200);
  });
  it("accepts a whole number from 1 to 100000", () => {
    expect(parseDailyReplyAllowance("1")).toBe(1);
    expect(parseDailyReplyAllowance(" 350 ")).toBe(350);
    expect(parseDailyReplyAllowance("100000")).toBe(100000);
  });
  it("the job interval is 10 minutes unless it is at least a minute (never a busy loop)", () => {
    for (const v of [undefined, "", "0", "-1", "1000", "abc"]) expect(parseAiUsageJobIntervalMs(v)).toBe(600_000);
    expect(parseAiUsageJobIntervalMs("60000")).toBe(60_000);
    expect(parseAiUsageJobIntervalMs("900000")).toBe(900_000);
  });
});

describe("AIP-17b · the job's loop", () => {
  it("returns null, with no timer, when switched off", () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    expect(startUsageAlertsLoop({ enabled: false })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("jitters the first tick between 60 and 120 seconds", () => {
    expect(firstTickDelayMs(() => 0)).toBe(60_000);
    expect(firstTickDelayMs(() => 0.999999)).toBeLessThan(120_000);
  });

  it("a failing tick is swallowed and the next one is still scheduled", async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sweep = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ skippedLocked: false, companies: 0, errors: 0, budgetNotices: 0, runawayNotices: 0 });
    const loop = startUsageAlertsLoop({ enabled: true, intervalMs: 1000, initialDelayMs: 10, sweep });
    await vi.advanceTimersByTimeAsync(10);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sweep).toHaveBeenCalledTimes(2);
    loop?.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sweep).toHaveBeenCalledTimes(2);
    err.mockRestore();
    vi.useRealTimers();
  });
});
