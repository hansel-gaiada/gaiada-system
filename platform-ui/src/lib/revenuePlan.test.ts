import { describe, it, expect } from "vitest";
import {
  attainment, buildGridRows, explainRevenuePlanError, formatAttainment, formatMoney, isFutureMonth, minorToMajor, monthLastDay, monthsOfYear,
  parseAmountInput, parseYear, yearTotals, NO_BASE_CURRENCY_WORDS, REFUSED_WORDS, type RevenuePlanRead,
} from "./revenuePlan";

// DW-7j-5 (BFF §40.6.4): the revenue plan's pure half.
describe("months and years", () => {
  it("lists the twelve months of a year, and the last day of each", () => {
    expect(monthsOfYear(2026)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12"]);
    expect(monthLastDay("2026-09")).toBe("2026-09-30");
    expect(monthLastDay("2026-02")).toBe("2026-02-28");
    expect(monthLastDay("2028-02")).toBe("2028-02-29");
    expect(monthLastDay("2026-12")).toBe("2026-12-31");
  });

  it("a month that starts after today is a future one", () => {
    expect(isFutureMonth("2026-11", "2026-10-15")).toBe(true);
    expect(isFutureMonth("2026-10", "2026-10-15")).toBe(false);
    expect(isFutureMonth("2026-10", "2026-10-01")).toBe(false);
  });

  it("reads a year from the query, falling back for anything that is not a year in range", () => {
    expect(parseYear("2025", 2026)).toBe(2025);
    expect(parseYear(["2027", "2030"], 2026)).toBe(2027);
    for (const bad of [undefined, "", "abc", "26", "20260", "1999", "2101", "2026.5"]) expect(parseYear(bad, 2026), String(bad)).toBe(2026);
  });
});

describe("money", () => {
  it("converts minor to major units by the currency's decimals and formats exactly those decimals", () => {
    expect(minorToMajor(200_000_000, 0)).toBe(200_000_000);
    expect(minorToMajor(1_234_560, 2)).toBe(12_345.6);
    expect(formatMoney(200_000_000, "IDR", 0)).toBe("IDR 200,000,000");
    expect(formatMoney(12_345.6, "USD", 2)).toBe("USD 12,345.60");
    expect(formatMoney(5, null, 0)).toBe("5");
  });
});

describe("parseAmountInput (typed in major units, stored as minor units)", () => {
  it("reads a whole amount for a currency with no decimals, ignoring spaces and thousands commas", () => {
    expect(parseAmountInput("200000000", 0)).toEqual({ ok: true, minor: 200_000_000 });
    expect(parseAmountInput(" 200,000,000 ", 0)).toEqual({ ok: true, minor: 200_000_000 });
    expect(parseAmountInput("0", 0)).toEqual({ ok: true, minor: 0 });
  });

  it("reads decimals exactly (no float), padding to the currency's decimals", () => {
    expect(parseAmountInput("1234.56", 2)).toEqual({ ok: true, minor: 123_456 });
    expect(parseAmountInput("1234.5", 2)).toEqual({ ok: true, minor: 123_450 });
    expect(parseAmountInput("1234", 2)).toEqual({ ok: true, minor: 123_400 });
    expect(parseAmountInput("0.07", 2)).toEqual({ ok: true, minor: 7 });
    expect(parseAmountInput("19.99", 2)).toEqual({ ok: true, minor: 1_999 });
  });

  it("refuses more decimals than the currency has rather than rounding", () => {
    const idr = parseAmountInput("100.5", 0);
    expect(idr).toMatchObject({ ok: false });
    expect(!idr.ok && idr.error).toMatch(/no decimals/);
    const usd = parseAmountInput("1.234", 2);
    expect(!usd.ok && usd.error).toMatch(/2 decimals/);
  });

  it("refuses nothing, a negative, text and an amount too large", () => {
    for (const bad of ["", "   ", "-5", "abc", "1.2.3", "1e6", "12 34a"]) expect(parseAmountInput(bad, 0).ok, bad).toBe(false);
    expect(parseAmountInput("99999999999999999999", 0)).toMatchObject({ ok: false, error: "That amount is too large." });
  });
});

describe("attainment", () => {
  it("is actual ÷ plan in major units", () => {
    expect(attainment(150_000_000, 200_000_000, 0)).toBe(0.75);
    expect(attainment(50, 10_000, 2)).toBe(0.5); // plan 100.00
  });

  it("is null with no plan, a plan of 0, or an unknown actual (never 100%, never 0%)", () => {
    expect(attainment(100, null, 0)).toBeNull();
    expect(attainment(100, 0, 0)).toBeNull();
    expect(attainment(null, 100, 0)).toBeNull();
    expect(attainment(0, 100, 0)).toBe(0); // no revenue against a plan is a real 0
    expect(formatAttainment(0.756)).toBe("76%");
    expect(formatAttainment(0)).toBe("0%");
    expect(formatAttainment(null)).toBe("—");
  });
});

describe("explainRevenuePlanError", () => {
  it("words a refusal and the missing base currency, and passes anything else through", () => {
    expect(explainRevenuePlanError(403, "not authorized: cerbos denied approve on dept_kpi_target")).toBe(REFUSED_WORDS);
    expect(explainRevenuePlanError(409, "no_base_currency")).toBe(NO_BASE_CURRENCY_WORDS);
    expect(explainRevenuePlanError(400, "amountMinor must be a whole number of at least 0")).toBe("amountMinor must be a whole number of at least 0");
  });
});

describe("buildGridRows and yearTotals", () => {
  const plan: RevenuePlanRead = {
    currency: "IDR", minorUnit: 0,
    months: monthsOfYear(2026).map((month) => ({ month, amountMinor: null, note: null, setBy: null, setAt: null })).map((m) =>
      m.month === "2026-08" ? { ...m, amountMinor: 100_000_000, note: "Q3" }
      : m.month === "2026-09" ? { ...m, amountMinor: 200_000_000 }
      : m.month === "2026-10" ? { ...m, amountMinor: 0 }
      : m),
  };

  it("one row per month with the plan, the actual and the ratio, each state its own cell", () => {
    const rows = buildGridRows(2026, plan, {
      "2026-07": { kind: "ok", data: 5_000_000 }, // no plan
      "2026-08": { kind: "ok", data: 90_000_000 },
      "2026-09": { kind: "forbidden" },
      "2026-10": { kind: "ok", data: null },
      "2026-06": { kind: "unavailable", reason: "boom" },
    });
    expect(rows).toHaveLength(12);
    const by = Object.fromEntries(rows.map((r) => [r.month, r]));
    expect(by["2026-08"]).toMatchObject({ label: "August", amountMinor: 100_000_000, note: "Q3", actual: { kind: "value", major: 90_000_000 }, attainment: 0.9 });
    expect(by["2026-07"]).toMatchObject({ amountMinor: null, actual: { kind: "value", major: 5_000_000 }, attainment: null }); // no plan, no ratio
    expect(by["2026-09"]).toMatchObject({ actual: { kind: "forbidden" }, attainment: null });
    expect(by["2026-10"]).toMatchObject({ amountMinor: 0, actual: { kind: "none" }, attainment: null });
    expect(by["2026-06"].actual).toEqual({ kind: "unavailable", reason: "boom" });
    expect(by["2026-12"].actual).toEqual({ kind: "future" });
  });

  it("the year row adds what is planned and what was read, and says how many months each is", () => {
    const rows = buildGridRows(2026, plan, { "2026-07": { kind: "ok", data: 5 }, "2026-08": { kind: "ok", data: 90 }, "2026-09": { kind: "forbidden" } });
    expect(yearTotals(rows, 0)).toEqual({ planMajor: 300_000_000, plannedMonths: 3, actualMajor: 95, readMonths: 2 });
  });
});
