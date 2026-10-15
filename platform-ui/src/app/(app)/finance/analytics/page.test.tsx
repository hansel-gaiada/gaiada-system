import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { ArAgingRow, StatementRow, TrialBalance, TrialBalanceRow } from "@/lib/finance";
import type { ReadResult } from "@/lib/readResult";

// DW-7b-2: Finance's "Revenue, AR and cash" page. Three sections, each its own read: what is pinned is that every section can
// show data, a refusal and a failure on its own, that a refusal is said in its section and never drawn as a zero or an empty
// table, and that one section failing costs only that section.
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-1" })), PlatformError: class extends Error {} }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/finance", () => ({ money: (n: unknown) => `Rp ${String(n)}` }));
vi.mock("@/lib/format", async (orig) => ({ ...(await orig<typeof import("@/lib/format")>()), todayIsoInDisplayZone: () => "2026-10-15" }));
vi.mock("@/lib/finance-data", () => ({ getProfitAndLossResult: vi.fn(), getArAgingResult: vi.fn(), getTrialBalanceResult: vi.fn() }));

import { getArAgingResult, getProfitAndLossResult, getTrialBalanceResult } from "@/lib/finance-data";
import FinanceAnalyticsPage from "./page";

const pnl = vi.mocked(getProfitAndLossResult);
const aging = vi.mocked(getArAgingResult);
const trial = vi.mocked(getTrialBalanceResult);

const total = (code: string, amount: string): StatementRow => ({ section: "total", code, name: code, amount });
const month = (revenue: string, net: string): ReadResult<StatementRow[]> =>
  ({ kind: "ok", data: [total("TOTAL_REVENUE", revenue), total("TOTAL_EXPENSE", "0"), total("NET_PROFIT", net)] });
const arRow = (name: string, current: string, d1: string, d90: string, totalOutstanding: string): ArAgingRow =>
  ({ customerCode: name.slice(0, 3), customerName: name, current, d1To30: d1, d31To60: "0", d61To90: "0", d90Plus: d90, totalOutstanding });
const tbRow = (code: string, name: string, accountType: TrialBalanceRow["accountType"], balance: string): TrialBalanceRow =>
  ({ code, name, accountType, debit: balance, credit: "0", balance });
const ledger = (rows: TrialBalanceRow[]): ReadResult<TrialBalance> => ({ kind: "ok", data: { rows, totalDebit: 0, totalCredit: 0, balanced: true } });

function happy() {
  pnl.mockImplementation(async (_u, _t, from) => (from === "2026-10-01" ? month("400", "100") : month("200", "50")));
  aging.mockResolvedValue({ kind: "ok", data: [arRow("Alpha", "100", "0", "0", "100"), arRow("Bravo", "0", "50", "300", "350")] });
  trial.mockResolvedValue(ledger([tbRow("1110", "Kas", "asset", "5000"), tbRow("1120", "Bank", "asset", "620000"), tbRow("1130", "Piutang Usaha", "asset", "185000")]));
}
const mount = async () => render(await FinanceAnalyticsPage());
/** A section by its title (the card heading also carries its hint's button, so the name is matched by prefix). */
const card = (title: string): HTMLElement =>
  screen.getAllByRole("heading", { level: 3 }).find((h) => (h.textContent ?? "").startsWith(title))!.closest("section") as HTMLElement;

beforeEach(() => { pnl.mockReset(); aging.mockReset(); trial.mockReset(); });

describe("Finance analytics: the page", () => {
  it("reads one P&L window per month for the last 12 months (this month to date), in parallel, and the aging and trial balance once", async () => {
    happy();
    await mount();
    expect(pnl).toHaveBeenCalledTimes(12);
    const windows = pnl.mock.calls.map((c) => [c[2], c[3]]);
    expect(windows[0]).toEqual(["2025-11-01", "2025-11-30"]);
    expect(windows[11]).toEqual(["2026-10-01", "2026-10-15"]);
    expect(aging).toHaveBeenCalledTimes(1);
    expect(trial).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { level: 1, name: "Revenue, AR and cash" })).toBeInTheDocument();
  });

  it("draws every section from its data", async () => {
    happy();
    await mount();
    // Revenue: the table, the chart, the margin (current month: 100 net on 400 revenue).
    const revenue = within(card("Revenue by month"));
    expect(revenue.getByText("Oct 2026 (to date)")).toBeInTheDocument();
    expect(revenue.getByText("Rp 400")).toBeInTheDocument();
    expect(revenue.getAllByText("25%").length).toBeGreaterThan(0);
    expect(revenue.getByRole("img", { name: /Revenue for each of the last 12 months/ })).toBeInTheDocument();
    // Receivables: overdue 350 of 450 outstanding, worst customer first, and the link to the page.
    const receivables = within(card("Receivables"));
    expect(receivables.getByText("Bravo")).toBeInTheDocument();
    expect(receivables.getByText("78% of what is outstanding")).toBeInTheDocument();
    expect(receivables.getByRole("link", { name: /Receivables →/ })).toHaveAttribute("href", "/finance/receivables");
    // Cash: only the accounts that say so, a total, and the link to Treasury.
    const cash = within(card("Cash and bank"));
    expect(cash.getByText("1110 · Kas")).toBeInTheDocument();
    expect(cash.getByText("1120 · Bank")).toBeInTheDocument();
    expect(cash.queryByText(/Piutang Usaha/)).toBeNull();
    expect(cash.getByText("Rp 625000")).toBeInTheDocument();
    expect(cash.getByRole("link", { name: /Treasury →/ })).toHaveAttribute("href", "/finance/treasury");
  });

  it("a refused revenue read says so in its section, never as zero revenue, and the other sections still draw", async () => {
    happy();
    pnl.mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText(/You don't have access to the profit and loss/)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Revenue for each/ })).toBeNull();
    expect(within(card("Revenue by month")).queryByText(/Rp /)).toBeNull();
    expect(screen.getByText("Bravo")).toBeInTheDocument();
    expect(screen.getByText("1110 · Kas")).toBeInTheDocument();
  });

  it("a failed revenue read says we cannot tell, in an alert", async () => {
    happy();
    pnl.mockResolvedValue({ kind: "unavailable", reason: "503" });
    await mount();
    const alert = screen.getAllByRole("alert").find((a) => /profit and loss/.test(a.textContent ?? ""))!;
    expect(alert).toHaveTextContent(/this is not a statement that there is nothing here/);
    expect(screen.queryByText("Oct 2026 (to date)")).toBeNull();
  });

  it("one month failing is one row that says so; the other months and the chart stay", async () => {
    happy();
    pnl.mockImplementation(async (_u, _t, from) => (from === "2026-03-01" ? { kind: "unavailable", reason: "boom" } : month("200", "50")));
    await mount();
    const revenue = within(card("Revenue by month"));
    // The failed month's three cells each say so.
    expect(revenue.getAllByText("Unavailable")).toHaveLength(3);
    expect(revenue.getByRole("alert")).toHaveTextContent("1 of 12 months could not be read");
    expect(revenue.getAllByText("Rp 200")).toHaveLength(11);
    expect(screen.getByRole("img", { name: /Revenue for each/ })).toBeInTheDocument();
  });

  it("a month whose statement has no totals reads 'No totals', not zero", async () => {
    happy();
    pnl.mockResolvedValue({ kind: "ok", data: [] });
    await mount();
    const revenue = within(card("Revenue by month"));
    expect(revenue.getAllByText("No totals")).toHaveLength(12);
    expect(revenue.queryByText(/Rp /)).toBeNull();
  });

  it("a refused aging says so in Receivables, never 'nothing overdue'", async () => {
    happy();
    aging.mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText(/You don't have access to the receivables aging/)).toBeInTheDocument();
    expect(screen.queryByText(/No customer/)).toBeNull();
    expect(screen.getByRole("link", { name: /Receivables →/ })).toBeInTheDocument();
    expect(screen.getByText("Oct 2026 (to date)")).toBeInTheDocument();
  });

  it("a failed aging is an alert, and an empty aging is a real 'nobody owes'", async () => {
    happy();
    aging.mockResolvedValue({ kind: "unavailable", reason: "502" });
    const first = await mount();
    expect(screen.getAllByRole("alert").some((a) => /receivables aging/.test(a.textContent ?? ""))).toBe(true);
    first.unmount();
    aging.mockResolvedValue({ kind: "ok", data: [] });
    await mount();
    expect(screen.getByText(/No customer has an outstanding balance as at today/)).toBeInTheDocument();
  });

  it("a refused trial balance says so in Cash; a ledger with no cash account says that, in words about the names", async () => {
    happy();
    trial.mockResolvedValue({ kind: "forbidden" });
    const first = await mount();
    expect(screen.getByText(/You don't have access to the trial balance/)).toBeInTheDocument();
    expect(screen.queryByText("1110 · Kas")).toBeNull();
    first.unmount();
    trial.mockResolvedValue(ledger([tbRow("1130", "Piutang Usaha", "asset", "1")]));
    await mount();
    expect(screen.getByText(/no posting to an asset account named Kas, Bank or Cash/)).toBeInTheDocument();
    expect(screen.getByText(/not a bank balance/)).toBeInTheDocument();
  });

  it("a failed trial balance costs only Cash", async () => {
    happy();
    trial.mockResolvedValue({ kind: "unavailable", reason: "500" });
    await mount();
    expect(screen.getAllByRole("alert").some((a) => /trial balance/.test(a.textContent ?? ""))).toBe(true);
    expect(screen.getByText("Rp 400")).toBeInTheDocument();
    expect(screen.getByText("Bravo")).toBeInTheDocument();
  });
});
