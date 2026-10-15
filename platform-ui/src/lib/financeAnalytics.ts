// DW-7b-2: the arithmetic and shaping behind Finance's "Revenue, AR and cash" page (`/finance/analytics`).
//
// Pure and client-safe, like `gmMoney.ts`, whose parsers and P&L reading it reuses. Nothing here fetches. Every figure is read from a
// `ReadResult` the page already holds, and the rules a reader must keep are asserted once in `financeAnalytics.test.ts`:
//   - a month whose read was refused or failed is a REFUSED month, never a month with no revenue;
//   - a statement with no total rows is "no totals", never a zero;
//   - the only arithmetic is presentation roll-ups over rows the server computed (summing an aging column, as the Finance Overview does).
import type { ReadResult } from "./readResult";
import type { ArAgingRow, StatementRow, TrialBalanceRow } from "./finance";
import { parseAmount, summarizePnl } from "./gmMoney";

// ── Revenue by month ──────────────────────────────────────────────────────────────────────────────

export interface MonthWindow {
  /** `YYYY-MM`. */
  key: string;
  /** `Oct 2026`. */
  label: string;
  /** First and last day, inclusive (the current month ends today, not at month end). */
  from: string;
  to: string;
  /** The month is not over: it runs to `today`. */
  partial: boolean;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const pad = (n: number) => String(n).padStart(2, "0");

/** The last `count` calendar months ending with the month that contains `today` (`YYYY-MM-DD`), oldest first. The current month is
 *  included to date. Pure string arithmetic: `today` is already the display zone's date, so no zone is applied here. */
export function lastMonths(today: string, count = 12): MonthWindow[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!m) throw new Error(`lastMonths: not a YYYY-MM-DD date: ${today}`);
  const year = Number(m[1]);
  const month0 = Number(m[2]) - 1;
  const out: MonthWindow[] = [];
  for (let back = count - 1; back >= 0; back--) {
    const idx = year * 12 + month0 - back;
    const y = Math.floor(idx / 12);
    const mo = idx % 12;
    const key = `${y}-${pad(mo + 1)}`;
    const partial = back === 0;
    const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    out.push({
      key, label: `${MONTH_NAMES[mo]} ${y}`, from: `${key}-01`, to: partial ? today : `${key}-${pad(lastDay)}`, partial,
    });
  }
  return out;
}

export type MonthReading =
  | { kind: "ok"; revenue: number | null; net: number | null; marginRate: number | null; totalsMissing: boolean }
  | { kind: "forbidden" }
  | { kind: "unavailable"; reason: string };

/** One month's P&L read as revenue, net and the margin rate (`gmMoney.summarizePnl`: the `TOTAL_REVENUE` and `NET_PROFIT` rows, never a re-sum). */
export function readingOfMonth(r: ReadResult<StatementRow[]>): MonthReading {
  if (r.kind === "forbidden") return { kind: "forbidden" };
  if (r.kind === "unavailable") return { kind: "unavailable", reason: r.reason };
  // A payload that is not a list of rows is not a statement.
  if (!Array.isArray(r.data)) return { kind: "unavailable", reason: "The statement was not a list of rows" };
  const s = summarizePnl(r.data);
  return { kind: "ok", revenue: s.revenue, net: s.net, marginRate: s.marginRate, totalsMissing: s.totalsMissing };
}

// ── Receivables ───────────────────────────────────────────────────────────────────────────────────

export interface ArBuckets { current: number; d1To30: number; d31To60: number; d61To90: number; d90Plus: number; total: number }
export interface OverdueCustomer { code: string; name: string; overdue: number; total: number }
export interface ArPicture {
  buckets: ArBuckets;
  /** Outstanding less current (the server owns both), clamped at 0: a credit balance can make current exceed the total. */
  overdue: number;
  /** overdue / outstanding, as a fraction; null when nothing is outstanding (a share of nothing is undefined, not 0%). */
  overdueShare: number | null;
  /** The customers with the most overdue, worst first. */
  top: OverdueCustomer[];
  customers: number;
  /** An amount in the grid could not be parsed: the roll-up would be a guess, so the page says so instead of drawing it. */
  unreadable: boolean;
}

/** The aging grid rolled up: bucket totals, the overdue share and the top customers by overdue amount. */
export function arPicture(rows: ArAgingRow[], topN = 5): ArPicture {
  const buckets: ArBuckets = { current: 0, d1To30: 0, d31To60: 0, d61To90: 0, d90Plus: 0, total: 0 };
  let unreadable = false;
  const per: OverdueCustomer[] = [];
  const num = (raw: string): number => {
    const n = parseAmount(raw);
    if (n === null) { unreadable = true; return 0; }
    return n;
  };
  for (const r of rows) {
    const current = num(r.current);
    const total = num(r.totalOutstanding);
    buckets.current += current;
    buckets.d1To30 += num(r.d1To30);
    buckets.d31To60 += num(r.d31To60);
    buckets.d61To90 += num(r.d61To90);
    buckets.d90Plus += num(r.d90Plus);
    buckets.total += total;
    const overdue = Math.max(0, total - current);
    if (overdue > 0) per.push({ code: r.customerCode, name: r.customerName, overdue, total });
  }
  per.sort((a, b) => b.overdue - a.overdue);
  const overdue = Math.max(0, buckets.total - buckets.current);
  return {
    buckets, overdue, overdueShare: buckets.total > 0 ? overdue / buckets.total : null,
    top: per.slice(0, topN), customers: rows.length, unreadable,
  };
}

// ── Cash ──────────────────────────────────────────────────────────────────────────────────────────

/** The chart of accounts carries no cash or bank flag (the receivables and payables forms pick bank accounts by the same sort of
 *  convention: Indonesian "Kas", "Bank", or "Cash" in the name). An account is read as cash only when it is an asset and its NAME says so.
 *  Matching on the code prefix (11xx) would count receivables and stock. */
export const CASH_NAME = /\b(kas|bank|cash)\b/i;

export interface CashAccount { code: string; name: string; balance: number | null }
export interface CashPosition {
  accounts: CashAccount[];
  /** null when any account's balance could not be read: a total over a guess is not a total. */
  total: number | null;
}

/** The ledger's cash and bank balances out of a trial balance (one row per account that has had a posting; `balance` is signed to the
 *  account's normal side, so an asset with a debit balance is positive). */
export function cashPosition(rows: TrialBalanceRow[]): CashPosition {
  const accounts = rows
    .filter((r) => r.accountType === "asset" && CASH_NAME.test(r.name))
    .map((r) => ({ code: r.code, name: r.name, balance: parseAmount(r.balance) }));
  const total = accounts.every((a) => a.balance !== null) ? accounts.reduce((t, a) => t + (a.balance as number), 0) : null;
  return { accounts, total };
}
