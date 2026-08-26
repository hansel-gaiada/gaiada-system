import { describe, it, expect } from "vitest";
import {
  summarizePnl, summarizeArAging, parseAmount, formatMoneyShort, formatRate, PNL_TOTAL_CODES,
} from "./gmMoney";
import type { StatementRow, ArAgingRow } from "./finance";

const line = (section: string, code: string, amount: string): StatementRow =>
  ({ section, code, name: code, amount });

// The demo/real P&L shape: line rows, then `section: "total"` rows carrying the three codes.
const PNL: StatementRow[] = [
  line("revenue", "4100", "331000000.0000"),
  line("expense", "6100", "108000000.0000"),
  line("expense", "6200", "24000000.0000"),
  line("total", PNL_TOTAL_CODES.revenue, "331000000.0000"),
  line("total", PNL_TOTAL_CODES.expense, "132000000.0000"),
  line("total", PNL_TOTAL_CODES.net, "199000000.0000"),
];

describe("parseAmount", () => {
  it("returns null — never 0 — for absent or malformed money", () => {
    // THE rule of this file. A zero here reads as "we made no money", which on the money tier is
    // the most expensive wrong answer available.
    for (const bad of [undefined, null, "", "   ", "n/a", "abc"]) {
      expect(parseAmount(bad as string | undefined), String(bad)).toBeNull();
    }
    expect(parseAmount("0")).toBe(0); // a REPORTED zero is a real figure and must survive
    expect(parseAmount("331000000.0000")).toBe(331_000_000);
    expect(parseAmount("-1200.50")).toBe(-1200.5);
  });
});

describe("summarizePnl", () => {
  it("reads the server's total rows instead of re-summing the lines", () => {
    const s = summarizePnl(PNL);
    expect(s.revenue).toBe(331_000_000);
    expect(s.expense).toBe(132_000_000);
    expect(s.net).toBe(199_000_000);
    expect(s.totalsMissing).toBe(false);
  });

  it("ignores a LINE row whose code collides with a total code", () => {
    // Absurd but not impossible, and reading a line as a total would be silently wrong. Only
    // `section: "total"` is consulted.
    const s = summarizePnl([
      line("revenue", PNL_TOTAL_CODES.net, "999999.0000"),
      ...PNL,
    ]);
    expect(s.net).toBe(199_000_000);
  });

  it("computes margin as net/revenue", () => {
    expect(summarizePnl(PNL).marginRate).toBeCloseTo(199 / 331, 10);
  });

  it("returns a NULL margin on zero revenue rather than dividing", () => {
    // A margin on no revenue is undefined, not 0% — dividing anyway yields Infinity or NaN and
    // renders as a confident, meaningless figure.
    const s = summarizePnl([
      line("total", PNL_TOTAL_CODES.revenue, "0"),
      line("total", PNL_TOTAL_CODES.expense, "5000"),
      line("total", PNL_TOTAL_CODES.net, "-5000"),
    ]);
    expect(s.revenue).toBe(0);
    expect(s.net).toBe(-5000);
    expect(s.marginRate).toBeNull();
  });

  it("flags a statement with no totals at all, distinctly from a zero one", () => {
    // "The endpoint answered but carried no totals" and "revenue was zero" are different facts and
    // the caller renders them differently.
    const missing = summarizePnl([line("revenue", "4100", "100")]);
    expect(missing.totalsMissing).toBe(true);
    expect(missing.revenue).toBeNull();

    const zero = summarizePnl([line("total", PNL_TOTAL_CODES.revenue, "0")]);
    expect(zero.totalsMissing).toBe(false);
    expect(zero.revenue).toBe(0);
  });

  it("is empty-safe", () => {
    const s = summarizePnl([]);
    expect(s).toMatchObject({ revenue: null, expense: null, net: null, marginRate: null, totalsMissing: true });
  });
});

const ar = (name: string, current: string, d90: string, total: string): ArAgingRow => ({
  customerCode: name, customerName: name,
  current, d1To30: "0", d31To60: "0", d61To90: "0", d90Plus: d90, totalOutstanding: total,
});

describe("summarizeArAging", () => {
  it("derives overdue from the server's own total, not by summing buckets", () => {
    // Summing the four late buckets would drift from `totalOutstanding` the moment a bucket is
    // added or a boundary moves. Anything outstanding but not current is late, by definition.
    const s = summarizeArAging([ar("Cedar", "100", "40", "200")]);
    expect(s.outstanding).toBe(200);
    expect(s.overdue).toBe(100); // 200 total - 100 current, regardless of bucket structure
    expect(s.over90).toBe(40);
  });

  it("clamps overdue at zero when a credit balance makes current exceed the total", () => {
    // Payments on account can do this. "Negative overdue" is not something a reader can act on.
    expect(summarizeArAging([ar("Lumen", "500", "0", "300")]).overdue).toBe(0);
  });

  it("ranks the worst 90+ customers first and omits the clean ones", () => {
    const s = summarizeArAging([
      ar("Small", "0", "10", "10"),
      ar("Clean", "50", "0", "50"),
      ar("Big", "0", "900", "900"),
    ]);
    expect(s.worstCustomers.map((c) => c.name)).toEqual(["Big", "Small"]);
    expect(s.customers).toBe(3); // every customer counts toward the population…
    expect(s.worstCustomers).toHaveLength(2); // …but only the late ones are named
  });

  it("is empty-safe and reports zeros as zeros", () => {
    expect(summarizeArAging([])).toMatchObject({ outstanding: 0, overdue: 0, over90: 0, customers: 0 });
  });
});

describe("formatting", () => {
  it("compacts money without forcing the reader to count digits", () => {
    expect(formatMoneyShort(331_000_000)).toBe("331.0M IDR");
    expect(formatMoneyShort(2_400_000_000)).toBe("2.4B IDR");
    expect(formatMoneyShort(4_500)).toBe("5K IDR");
    expect(formatMoneyShort(-1_200_000)).toBe("-1.2M IDR");
  });

  it("renders an unknown figure as a dash, never as zero", () => {
    expect(formatMoneyShort(null)).toBe("—");
    expect(formatRate(null)).toBe("—");
    // A reported zero still renders as a number — it is a fact, unlike null.
    expect(formatMoneyShort(0)).toBe("0 IDR");
    expect(formatRate(0)).toBe("0%");
  });
});
