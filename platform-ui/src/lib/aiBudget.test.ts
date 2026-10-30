import { describe, it, expect } from "vitest";
import {
  asAllowances, asCompanyBudgets, asTurnBudget, asUnitBudget, allowanceOf, budgetErrorText, budgetModeLabel, budgetStateWords, checkDailyReplies, checkMonthlyUsd,
  formatResetTime, heldNote, liftOffered, parseTurnBudget, percentText, stoppedMonthName, turnBudgetLine, utcMonthOf,
} from "./aiBudget";
import { allowances, companyBudget, unitBudget } from "./aiUsageFixtures";

// AIP-17b and AIP-18 (BFF §66.8, §66.9, §66.11): the budget lines, the allowances, the form validators, the lift's conditions and the soft stop's chat line.

describe("the state words", () => {
  it("say under, over 80% and at or over 100%", () => {
    expect(budgetStateWords("under")).toBe("under");
    expect(budgetStateWords("over_80")).toBe("over 80%");
    expect(budgetStateWords("over_100")).toBe("at or over 100%");
  });
  it("name the two modes, Report only first", () => {
    expect(budgetModeLabel("report")).toBe("Report only");
    expect(budgetModeLabel("soft_stop")).toBe("Soft stop");
  });
  it("show the server's floored percent as it is, never rounded up", () => {
    expect(percentText(87.5)).toBe("87.5%");
    expect(percentText(80)).toBe("80%");
    expect(percentText(99.9)).toBe("99.9%");
    expect(percentText(0)).toBe("0%");
  });
});

describe("parsing the budget lines (§66.8)", () => {
  it("reads a unit line, the money still a string, and an unknown spend still null", () => {
    const l = asUnitBudget({ ...unitBudget(), spentUsd: null, percent: 0, state: "under" });
    expect(l).toMatchObject({ unitNodeId: "d-web", mode: "report", monthlyUsd: "1.0000", spentUsd: null, state: "under", stopLifted: false });
  });
  it("treats an absent or null `budget` as no budget (an older server sends no key)", () => {
    expect(asUnitBudget(undefined)).toBeNull();
    expect(asUnitBudget(null)).toBeNull();
    expect(asCompanyBudgets(undefined)).toEqual({ company: null, units: [] });
    expect(asCompanyBudgets({ company: null, units: [] })).toEqual({ company: null, units: [] });
  });
  it("keeps a unit whose name is null (a node no longer in the tree), and reads stopLifted", () => {
    const b = asCompanyBudgets({ company: companyBudget(), units: [{ ...unitBudget({ name: null, stopLifted: true, mode: "soft_stop" }) }] });
    expect(b.company).toMatchObject({ monthlyUsd: "250.0000", percent: 87.5, state: "over_80" });
    expect(b.units[0]).toMatchObject({ name: null, stopLifted: true, mode: "soft_stop" });
  });
  it("refuses a malformed line rather than guessing (a number for money, a bad state or mode, a negative percent)", () => {
    expect(() => asUnitBudget({ ...unitBudget(), monthlyUsd: 1 })).toThrow(/monthlyUsd/);
    expect(() => asUnitBudget({ ...unitBudget(), spentUsd: "1e3" })).toThrow(/spentUsd/);
    expect(() => asUnitBudget({ ...unitBudget(), state: "over" })).toThrow(/state/);
    expect(() => asUnitBudget({ ...unitBudget(), mode: "hard_stop" })).toThrow(/mode/);
    expect(() => asUnitBudget({ ...unitBudget(), percent: -1 })).toThrow(/percent/);
    expect(() => asCompanyBudgets({ company: "x", units: [] })).toThrow(/budgets.company/);
    expect(() => asCompanyBudgets({ units: "x" })).toThrow(/budgets.units/);
  });
});

describe("parsing the allowances (§66.9)", () => {
  it("reads the default and the overrides, a missing name as null", () => {
    const a = asAllowances({ defaultDailyReplies: 200, overrides: [{ userId: "u-2", name: null, dailyReplies: 350, updatedAt: "2026-10-29T10:00:00.000Z" }] });
    expect(a).toEqual({ defaultDailyReplies: 200, overrides: [{ userId: "u-2", name: null, dailyReplies: 350, updatedAt: "2026-10-29T10:00:00.000Z" }] });
  });
  it("refuses a bad default or override", () => {
    expect(() => asAllowances({ defaultDailyReplies: 0, overrides: [] })).toThrow();
    expect(() => asAllowances({ defaultDailyReplies: 200 })).toThrow();
    expect(() => asAllowances({ defaultDailyReplies: 200, overrides: [{ userId: "u", dailyReplies: 1.5 }] })).toThrow();
  });
  it("says a person's allowance: the override, else the default", () => {
    expect(allowanceOf(allowances(), "u-2")).toEqual({ dailyReplies: 350, isDefault: false });
    expect(allowanceOf(allowances(), "u-9")).toEqual({ dailyReplies: 200, isDefault: true });
  });
});

describe("the money validator is the server's rule (§66.9)", () => {
  it.each(["250", "0.05", "0.0001", "99999999.9999", "1.5", "00012", " 40 "])("accepts %s", (v) => {
    expect(checkMonthlyUsd(v).ok).toBe(true);
  });
  it("sends what was typed, trimmed (the server canonicalises it)", () => {
    expect(checkMonthlyUsd(" 40.5 ")).toEqual({ ok: true, value: "40.5" });
  });
  it.each(["", "  ", "0", "0.0000", "-5", "+5", "1.23456", "1e3", "1,000", "1 000", "$5", "100000000", "abc", ".5", "5."])("refuses %j", (v) => {
    expect(checkMonthlyUsd(v).ok).toBe(false);
  });
  it("says why: more than 0, the decimal places, a figure", () => {
    expect(checkMonthlyUsd("0")).toMatchObject({ ok: false, error: expect.stringContaining("more than 0") });
    expect(checkMonthlyUsd("1.23456")).toMatchObject({ ok: false, error: expect.stringContaining("4 decimal places") });
    expect(checkMonthlyUsd("")).toMatchObject({ ok: false, error: "Enter a figure in US dollars." });
  });
});

describe("the allowance validator is the server's rule (§66.9)", () => {
  it("accepts a whole number from 1 to 100,000", () => {
    expect(checkDailyReplies("350")).toEqual({ ok: true, value: 350 });
    expect(checkDailyReplies(" 1 ")).toEqual({ ok: true, value: 1 });
    expect(checkDailyReplies("100000")).toEqual({ ok: true, value: 100000 });
  });
  it.each(["", "0", "100001", "1.5", "-3", "1e3", "two", "1,000"])("refuses %j", (v) => {
    expect(checkDailyReplies(v).ok).toBe(false);
  });
});

describe("the lift button's exact conditions (AIP-18)", () => {
  const now = new Date("2026-10-30T12:00:00Z");
  const stopped = unitBudget({ mode: "soft_stop", state: "over_100", percent: 130, stopLifted: false });
  const caps = { canLiftStop: true };
  it("is offered for a soft stop at or over 100 percent, not lifted, when the answer says canLiftStop, in the current month", () => {
    expect(liftOffered(stopped, caps, "2026-10", now)).toBe(true);
  });
  it.each([
    ["no budget", null],
    ["Report only mode", { ...stopped, mode: "report" as const }],
    ["over 80 but under 100", { ...stopped, state: "over_80" as const }],
    ["under", { ...stopped, state: "under" as const }],
    ["already lifted this month", { ...stopped, stopLifted: true }],
  ])("is not offered with %s", (_name, line) => {
    expect(liftOffered(line, caps, "2026-10", now)).toBe(false);
  });
  it("is not offered without canLiftStop", () => {
    expect(liftOffered(stopped, { canLiftStop: false }, "2026-10", now)).toBe(false);
  });
  it("is not offered beside a past month's figures: a lift always applies to the current UTC month", () => {
    expect(liftOffered(stopped, caps, "2026-09", now)).toBe(false);
  });
  it("reads the UTC month, not the local one", () => {
    expect(utcMonthOf(new Date("2026-10-31T23:59:59Z"))).toBe("2026-10");
    expect(utcMonthOf(new Date("2026-11-01T00:00:00Z"))).toBe("2026-11");
    expect(liftOffered(stopped, caps, "2026-11", new Date("2026-11-01T00:00:00Z"))).toBe(true);
  });
});

describe("the server's refusals, in words", () => {
  it("says a 400 as the server's own sentence", () => {
    expect(budgetErrorText({ status: 400, message: "monthlyUsd must be greater than 0" })).toBe("monthlyUsd must be greater than 0");
  });
  it("says a 403 plainly, for a write and for a lift", () => {
    expect(budgetErrorText({ status: 403, message: "Forbidden" })).toMatch(/Only the owner/);
    expect(budgetErrorText({ status: 403, message: "Forbidden" }, "lift")).toMatch(/owner, or the head of this department/);
  });
  it("tells the three 404s apart", () => {
    expect(budgetErrorText({ status: 404, message: "unit_not_found" })).toMatch(/department was not found/);
    expect(budgetErrorText({ status: 404, message: "person_not_found" }, "allowance")).toMatch(/not an active member/);
    expect(budgetErrorText({ status: 404, message: "no_soft_stop" }, "lift")).toMatch(/no soft stop/);
  });
});

describe("the reset time in words", () => {
  const nextMidnight = "2026-10-31T00:00:00.000Z";
  it("says the viewer's local time with UTC beside it", () => {
    expect(formatResetTime(nextMidnight, "Asia/Makassar")).toBe("31 Oct, 08:00 GMT+8 (31 Oct, 00:00 UTC)");
  });
  it("carries the local date when it differs from UTC's", () => {
    expect(formatResetTime(nextMidnight, "America/Los_Angeles")).toBe("30 Oct, 17:00 GMT-7 (31 Oct, 00:00 UTC)");
  });
  it("says UTC once for a viewer in UTC", () => {
    expect(formatResetTime(nextMidnight, "UTC")).toBe("31 Oct, 00:00 UTC");
  });
  it("is null for an unreadable instant", () => {
    expect(formatResetTime("", "UTC")).toBeNull();
    expect(formatResetTime("tomorrow", "UTC")).toBeNull();
  });
});

describe("the soft stop's chat line (AIP-18)", () => {
  it("says the allowance line with the reset time in local time and UTC", () => {
    expect(turnBudgetLine({ kind: "allowance", resetsAt: "2026-10-31T00:00:00.000Z" }, "Asia/Makassar"))
      .toBe("You have reached today's AI allowance. Replies continue in a lighter mode until 31 Oct, 08:00 GMT+8 (31 Oct, 00:00 UTC).");
  });
  it("drops only the 'until' clause when the instant is unreadable", () => {
    expect(turnBudgetLine({ kind: "allowance", resetsAt: "" }, "UTC")).toBe("You have reached today's AI allowance. Replies continue in a lighter mode.");
  });
  it("says the department line with the month the stop was for (the month before the reset)", () => {
    expect(turnBudgetLine({ kind: "department", unitNodeId: "d-web", resetsAt: "2026-11-01T00:00:00.000Z" }))
      .toBe("Your department has reached its AI budget for October. Replies continue in a lighter mode.");
    expect(stoppedMonthName("2027-01-01T00:00:00.000Z")).toBe("December");
    expect(stoppedMonthName("")).toBe("this month");
  });
  it("never carries a number: no figure, count or percent", () => {
    const lines = [
      turnBudgetLine({ kind: "department", resetsAt: "2026-11-01T00:00:00.000Z" }),
      turnBudgetLine({ kind: "allowance", resetsAt: "" }),
    ];
    for (const l of lines) expect(l).not.toMatch(/\d/);
  });
});

describe("reading the part, the frame and the ask answer's `turnBudget`", () => {
  const part = { type: "turn_budget", kind: "department", unitNodeId: "d-web", resetsAt: "2026-11-01T00:00:00.000Z" };
  it("finds the part in a message's parts", () => {
    expect(parseTurnBudget([{ type: "usage_meta", usageSource: "provider" }, part])).toEqual({ kind: "department", unitNodeId: "d-web", resetsAt: "2026-11-01T00:00:00.000Z" });
  });
  it("is null on every unstopped message: no part, null or non-array parts, an unknown kind", () => {
    expect(parseTurnBudget(null)).toBeNull();
    expect(parseTurnBudget("x")).toBeNull();
    expect(parseTurnBudget([])).toBeNull();
    expect(parseTurnBudget([{ type: "citations", items: [] }])).toBeNull();
    expect(parseTurnBudget([{ type: "turn_budget", kind: "weekly", resetsAt: "x" }])).toBeNull();
  });
  it("reads the ask answer's object the same way (no `type` key)", () => {
    expect(asTurnBudget({ kind: "allowance", resetsAt: "2026-10-31T00:00:00.000Z" })).toEqual({ kind: "allowance", resetsAt: "2026-10-31T00:00:00.000Z" });
    expect(asTurnBudget(undefined)).toBeNull();
    expect(asTurnBudget({ kind: "allowance" })).toEqual({ kind: "allowance", resetsAt: "" });
  });
});

describe("the held hand-off's note", () => {
  it("says which stop holds it, and that it starts by itself", () => {
    expect(heldNote("allowance")).toMatch(/starts by itself when the allowance resets/);
    expect(heldNote("department")).toMatch(/starts by itself when the stop ends/);
    expect(heldNote(null)).toMatch(/starts by itself/);
  });
});
