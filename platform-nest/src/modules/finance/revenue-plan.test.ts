import { describe, it, expect } from "vitest";
import { MAX_PLAN_MONTHS, daysInMonth, formatMonth, monthSpan, monthsBetween, parseMonth, planOverWindow } from "./revenue-plan";

// DW-7j-5 (BFF §40.6.4): the revenue plan's month arithmetic. Pure; the database tests prove the rows and the routes.
describe("parseMonth / formatMonth", () => {
  it("reads YYYY-MM and nothing else", () => {
    expect(parseMonth("2026-09")).toEqual({ year: 2026, month: 9 });
    expect(formatMonth({ year: 2026, month: 9 })).toBe("2026-09");
    for (const bad of ["2026-9", "2026-13", "2026-00", "2026-09-01", "26-09", "", " 2026-09", undefined, null, 202609]) {
      expect(parseMonth(bad), String(bad)).toBeNull();
    }
  });
});

describe("daysInMonth, monthSpan, monthsBetween", () => {
  it("counts the days of a month, leap years included", () => {
    expect(daysInMonth({ year: 2026, month: 9 })).toBe(30);
    expect(daysInMonth({ year: 2026, month: 10 })).toBe(31);
    expect(daysInMonth({ year: 2026, month: 2 })).toBe(28);
    expect(daysInMonth({ year: 2028, month: 2 })).toBe(29);
  });

  it("spans months inclusively, across a year end", () => {
    expect(monthSpan({ year: 2026, month: 9 }, { year: 2026, month: 9 })).toBe(1);
    expect(monthSpan({ year: 2026, month: 1 }, { year: 2026, month: 12 })).toBe(12);
    expect(monthSpan({ year: 2026, month: 11 }, { year: 2027, month: 2 })).toBe(4);
    expect(monthSpan({ year: 2026, month: 9 }, { year: 2026, month: 8 })).toBe(0);
    expect(MAX_PLAN_MONTHS).toBe(36);
  });

  it("lists every month of a range, and none for a backwards one", () => {
    expect(monthsBetween({ year: 2026, month: 11 }, { year: 2027, month: 2 })).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(monthsBetween({ year: 2026, month: 9 }, { year: 2026, month: 9 })).toEqual(["2026-09"]);
    expect(monthsBetween({ year: 2026, month: 9 }, { year: 2026, month: 8 })).toEqual([]);
  });
});

describe("planOverWindow (the plan in major units over an inclusive window)", () => {
  const plans = (o: Record<string, number>) => new Map(Object.entries(o));

  it("a full month counts its whole plan, converted from minor to major units by the currency's decimals", () => {
    expect(planOverWindow(plans({ "2026-09": 300_000_000 }), "2026-09-01", "2026-09-30", 0)).toBe(300_000_000); // IDR: 0 dp
    expect(planOverWindow(plans({ "2026-09": 1_234_500 }), "2026-09-01", "2026-09-30", 2)).toBe(12_345); // USD: cents
  });

  it("a partial month counts its plan times the days inside the window over the days in the month", () => {
    // September has 30 days: the first 10 are a third of the plan
    expect(planOverWindow(plans({ "2026-09": 300 }), "2026-09-01", "2026-09-10", 0)).toBeCloseTo(100, 9);
    // a window inside one month, not at its edges (days 11 to 20, 10 days)
    expect(planOverWindow(plans({ "2026-09": 300 }), "2026-09-11", "2026-09-20", 0)).toBeCloseTo(100, 9);
    // one day
    expect(planOverWindow(plans({ "2026-09": 300 }), "2026-09-30", "2026-09-30", 0)).toBeCloseTo(10, 9);
  });

  it("a window over two months sums each month's share (a week over a month end)", () => {
    // Sep 28..Oct 4: 3 days of September (30 days) and 4 days of October (31 days)
    const got = planOverWindow(plans({ "2026-09": 3_000, "2026-10": 3_100 }), "2026-09-28", "2026-10-04", 0);
    expect(got).toBeCloseTo(300 + 400, 9);
  });

  it("a quarter is the sum of its three months", () => {
    expect(planOverWindow(plans({ "2026-07": 100, "2026-08": 200, "2026-09": 300 }), "2026-07-01", "2026-09-30", 0)).toBe(600);
  });

  it("a leap February counts 29 days", () => {
    expect(planOverWindow(plans({ "2028-02": 2_900 }), "2028-02-01", "2028-02-10", 0)).toBeCloseTo(1_000, 9);
  });

  it("is null when ANY overlapping month has no plan, never a smaller plan", () => {
    expect(planOverWindow(plans({ "2026-09": 300 }), "2026-09-15", "2026-10-02", 0)).toBeNull();
    expect(planOverWindow(plans({ "2026-10": 300 }), "2026-09-15", "2026-10-02", 0)).toBeNull();
    expect(planOverWindow(plans({}), "2026-09-01", "2026-09-30", 0)).toBeNull();
    // a plan for a month outside the window does not stand in
    expect(planOverWindow(plans({ "2026-08": 300 }), "2026-09-01", "2026-09-30", 0)).toBeNull();
  });

  it("is null when the plan sums to 0 (a KPI cannot divide by it), but not when only some months are 0", () => {
    expect(planOverWindow(plans({ "2026-09": 0 }), "2026-09-01", "2026-09-30", 0)).toBeNull();
    expect(planOverWindow(plans({ "2026-09": 0, "2026-10": 310 }), "2026-09-01", "2026-10-31", 0)).toBe(310);
  });

  it("is null for an empty or unreadable window", () => {
    expect(planOverWindow(plans({ "2026-09": 300 }), "2026-09-10", "2026-09-09", 0)).toBeNull();
    expect(planOverWindow(plans({ "2026-09": 300 }), "nope", "2026-09-09", 0)).toBeNull();
  });
});
