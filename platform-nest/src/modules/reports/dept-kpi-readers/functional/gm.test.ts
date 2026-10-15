import { describe, it, expect } from "vitest";
import { marginFromPnlTotals } from "./gm";

// DW-7j f2 (BFF §40.6.2): the margin from the P&L's total rows. Pure; the database test proves the rows.
describe("marginFromPnlTotals", () => {
  const rows = (revenue: string | number | null, net: string | number | null) => [
    { code: "TOTAL_REVENUE", amount: revenue },
    { code: "NET_PROFIT", amount: net },
  ];

  it("is net ÷ revenue, with net as the numerator and revenue as the denominator (the ledger's numeric strings parse)", () => {
    expect(marginFromPnlTotals(rows("150000000.0000", "120000000.0000"))).toEqual({ value: 0.8, numerator: 120_000_000, denominator: 150_000_000 });
  });

  it("a loss is a negative margin", () => {
    expect(marginFromPnlTotals(rows(100, -25))?.value).toBe(-0.25);
  });

  it("is null when revenue is 0, never 0 or Infinity", () => {
    expect(marginFromPnlTotals(rows("0.0000", "-7000000.0000"))).toBeNull();
    expect(marginFromPnlTotals(rows(0, 0))).toBeNull();
  });

  it("is null when a total row is missing, null or not a number", () => {
    expect(marginFromPnlTotals([])).toBeNull();
    expect(marginFromPnlTotals([{ code: "TOTAL_REVENUE", amount: "100" }])).toBeNull();
    expect(marginFromPnlTotals([{ code: "NET_PROFIT", amount: "10" }])).toBeNull();
    expect(marginFromPnlTotals(rows(null, 10))).toBeNull();
    expect(marginFromPnlTotals(rows("abc", 10))).toBeNull();
  });

  it("reads only the two total rows by code", () => {
    expect(marginFromPnlTotals([{ code: "4100", amount: "999" }, ...rows(100, 50)])?.value).toBe(0.5);
  });
});
