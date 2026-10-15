import { describe, it, expect } from "vitest";
import type { ArAgingRow, StatementRow, TrialBalanceRow } from "./finance";
import { arPicture, cashPosition, lastMonths, readingOfMonth } from "./financeAnalytics";

// DW-7b-2: the shaping behind Finance's "Revenue, AR and cash" page. What is pinned is each place a figure could be invented: a month
// that was not read, a statement with no totals, an aging with nothing in it, a chart of accounts with no cash flag.

describe("lastMonths", () => {
  it("gives twelve calendar months, oldest first, ending with the current month to date", () => {
    const m = lastMonths("2026-10-15", 12);
    expect(m).toHaveLength(12);
    expect(m[0]).toMatchObject({ key: "2025-11", label: "Nov 2025", from: "2025-11-01", to: "2025-11-30", partial: false });
    expect(m[11]).toMatchObject({ key: "2026-10", label: "Oct 2026", from: "2026-10-01", to: "2026-10-15", partial: true });
    expect(m.filter((x) => x.partial)).toHaveLength(1);
  });

  it("crosses a year, and knows February and leap years", () => {
    expect(lastMonths("2026-02-03", 3).map((x) => [x.key, x.to])).toEqual([["2025-12", "2025-12-31"], ["2026-01", "2026-01-31"], ["2026-02", "2026-02-03"]]);
    expect(lastMonths("2024-03-10", 2)[0]).toMatchObject({ key: "2024-02", to: "2024-02-29" });
    expect(lastMonths("2026-03-10", 2)[0]).toMatchObject({ key: "2026-02", to: "2026-02-28" });
  });

  it("is contiguous: each month starts the day after the one before ends", () => {
    const m = lastMonths("2026-01-31", 12);
    for (let i = 1; i < m.length; i++) {
      const prevEnd = new Date(`${m[i - 1].to}T00:00:00Z`);
      prevEnd.setUTCDate(prevEnd.getUTCDate() + 1);
      expect(prevEnd.toISOString().slice(0, 10)).toBe(m[i].from);
    }
  });

  it("refuses a date it cannot read", () => {
    expect(() => lastMonths("15/10/2026")).toThrow();
  });
});

const total = (code: string, amount: string): StatementRow => ({ section: "total", code, name: code, amount });

describe("readingOfMonth", () => {
  it("reads revenue, net and the margin from the total rows", () => {
    const rows: StatementRow[] = [
      { section: "revenue", code: "4100", name: "Sales", amount: "999.0000" },
      total("TOTAL_REVENUE", "200000000.0000"), total("TOTAL_EXPENSE", "150000000.0000"), total("NET_PROFIT", "50000000.0000"),
    ];
    expect(readingOfMonth({ kind: "ok", data: rows })).toEqual({ kind: "ok", revenue: 200000000, net: 50000000, marginRate: 0.25, totalsMissing: false });
  });

  it("a real zero is a zero, with no margin (a margin on no revenue is undefined)", () => {
    const r = readingOfMonth({ kind: "ok", data: [total("TOTAL_REVENUE", "0.0000"), total("NET_PROFIT", "0.0000")] });
    expect(r).toEqual({ kind: "ok", revenue: 0, net: 0, marginRate: null, totalsMissing: false });
  });

  it("a statement without totals is 'no totals', never zero revenue", () => {
    expect(readingOfMonth({ kind: "ok", data: [] })).toMatchObject({ kind: "ok", revenue: null, net: null, totalsMissing: true });
  });

  it("carries a refusal and a failure through, never as numbers", () => {
    expect(readingOfMonth({ kind: "forbidden" })).toEqual({ kind: "forbidden" });
    expect(readingOfMonth({ kind: "unavailable", reason: "503" })).toEqual({ kind: "unavailable", reason: "503" });
    expect(readingOfMonth({ kind: "ok", data: null as unknown as StatementRow[] })).toMatchObject({ kind: "unavailable" });
  });
});

const ar = (name: string, current: string, d1: string, d31: string, d61: string, d90: string, totalOutstanding: string): ArAgingRow =>
  ({ customerCode: name.slice(0, 3).toUpperCase(), customerName: name, current, d1To30: d1, d31To60: d31, d61To90: d61, d90Plus: d90, totalOutstanding });

describe("arPicture", () => {
  const rows = [
    ar("Alpha", "100", "0", "0", "0", "0", "100"),
    ar("Bravo", "0", "50", "0", "0", "300", "350"),
    ar("Charlie", "10", "40", "0", "0", "0", "50"),
    ar("Delta", "0", "0", "0", "70", "0", "70"),
    ar("Echo", "0", "5", "0", "0", "0", "5"),
    ar("Foxtrot", "0", "1", "0", "0", "0", "1"),
    ar("Golf", "20", "0", "0", "0", "0", "20"),
  ];

  it("sums the buckets and takes overdue as outstanding less current, with its share", () => {
    const p = arPicture(rows);
    expect(p.buckets).toEqual({ current: 130, d1To30: 96, d31To60: 0, d61To90: 70, d90Plus: 300, total: 596 });
    expect(p.overdue).toBe(466);
    expect(p.overdueShare).toBeCloseTo(466 / 596);
    expect(p.customers).toBe(7);
    expect(p.unreadable).toBe(false);
  });

  it("lists the top five customers by overdue, worst first, leaving out anyone not overdue", () => {
    const p = arPicture(rows);
    expect(p.top.map((c) => [c.name, c.overdue])).toEqual([["Bravo", 350], ["Delta", 70], ["Charlie", 40], ["Echo", 5], ["Foxtrot", 1]]);
    expect(p.top.map((c) => c.name)).not.toContain("Alpha");
    expect(p.top.map((c) => c.name)).not.toContain("Golf");
    expect(arPicture(rows, 2).top).toHaveLength(2);
  });

  it("has no share when nothing is outstanding, and clamps a credit balance's negative overdue at zero", () => {
    const none = arPicture([]);
    expect(none.overdueShare).toBeNull();
    expect(none.overdue).toBe(0);
    const credit = arPicture([ar("Prepaid", "500", "0", "0", "0", "0", "300")]);
    expect(credit.overdue).toBe(0);
    expect(credit.top).toEqual([]);
  });

  it("says so when an amount cannot be read, instead of rolling up a guess", () => {
    expect(arPicture([ar("Bad", "x", "0", "0", "0", "0", "10")]).unreadable).toBe(true);
  });
});

const tb = (code: string, name: string, accountType: TrialBalanceRow["accountType"], balance: string): TrialBalanceRow =>
  ({ code, name, accountType, debit: balance, credit: "0", balance });

describe("cashPosition", () => {
  it("takes asset accounts named Kas, Bank or Cash, and leaves receivables, stock, liabilities and equity out", () => {
    const c = cashPosition([
      tb("1110", "Kas", "asset", "5000000"), tb("1120", "Bank BCA", "asset", "620000000"), tb("1130", "Piutang Usaha", "asset", "185000000"),
      tb("1140", "Persediaan", "asset", "1"), tb("2210", "Bank Loan", "liability", "900"), tb("1150", "Petty Cash", "asset", "250000"),
      tb("3100", "Modal", "equity", "7"),
    ]);
    expect(c.accounts.map((a) => a.code)).toEqual(["1110", "1120", "1150"]);
    expect(c.total).toBe(625250000);
  });

  it("finds no account when none is named for cash (the page then says so, and draws no total)", () => {
    const c = cashPosition([tb("1130", "Piutang Usaha", "asset", "10"), tb("4100", "Sales", "revenue", "10")]);
    expect(c.accounts).toEqual([]);
    expect(c.total).toBe(0);
  });

  it("has no total when a balance cannot be read, and keeps the account with no figure", () => {
    const c = cashPosition([tb("1110", "Kas", "asset", "5"), tb("1120", "Bank", "asset", "oops")]);
    expect(c.accounts[1].balance).toBeNull();
    expect(c.total).toBeNull();
  });

  it("matches the word, not a fragment of one", () => {
    expect(cashPosition([tb("1190", "Banking fees prepaid", "asset", "1"), tb("1191", "Cashier float", "asset", "1")]).accounts).toEqual([]);
  });
});
