// GM console — the money tier's arithmetic (GM-09).
// Design: `docs/blueprints/gm-console-foundation.md` §5. Ruling: OQ-3 (2026-08-26).
//
// Pure and client-safe on purpose — no `server-only`, no fetching. Every figure the cockpit's money
// card and the Clients & Money tab render comes through here, so the rules below are asserted once
// in `gmMoney.test.ts` instead of being re-derived (and re-broken) per surface.
//
// ── WHY THIS FILE EXISTS AT ALL, RATHER THAN SUMMING IN THE COMPONENT ────────────────────────────
// `GET /finance/profit-and-loss` already returns the totals as ROWS: `section: "total"` with codes
// `TOTAL_REVENUE`, `TOTAL_EXPENSE`, `NET_PROFIT`. Those come from the Postgres function
// `finance_profit_and_loss()`, and a DB test pins `NET_PROFIT === TOTAL_REVENUE - TOTAL_EXPENSE`
// (`platform-nest/src/db/finance-f3-statements.test.ts`).
//
// So the console READS those codes and never re-sums the line rows. Re-summing would be a second
// implementation of the P&L that agrees with the ledger only until the first accounting subtlety —
// a contra-revenue line, a return, an account that belongs to neither total — and a GM would then
// have two different net-profit numbers on two screens with no way to tell which is the books.
//
// ── MONEY IS A STRING ON THE WIRE, AND THAT IS DELIBERATE ────────────────────────────────────────
// Every amount arrives as a decimal STRING ("331000000.0000"). It is parsed here exactly once, at
// the edge, and the parse is allowed to FAIL: `null` means "not reported", never `0`. A malformed or
// absent total rendered as zero would say "we made no money", which on this surface is the single
// most expensive wrong answer available.

import type { StatementRow, ArAgingRow } from "./finance";

/** The three total codes the P&L function emits. Named, not inlined, because they are a contract
 *  with `finance_profit_and_loss()` — if that function renames one, this is the single place to fix
 *  and the tests below say what broke. */
export const PNL_TOTAL_CODES = {
  revenue: "TOTAL_REVENUE",
  expense: "TOTAL_EXPENSE",
  net: "NET_PROFIT",
} as const;

/** Parse a wire decimal. `null` for absent/malformed — never a silent 0. */
export function parseAmount(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export interface PnlSummary {
  revenue: number | null;
  expense: number | null;
  net: number | null;
  /** net / revenue, as a fraction. `null` when either side is unknown OR revenue is 0 — a margin on
   *  no revenue is not 0%, it is undefined, and dividing anyway yields Infinity or NaN. */
  marginRate: number | null;
  /** True when the statement carried no total rows at all — the caller must render this differently
   *  from "revenue was zero", which is a real and reportable state. */
  totalsMissing: boolean;
}

/** Read the P&L totals out of the statement rows. */
export function summarizePnl(rows: StatementRow[]): PnlSummary {
  const byCode = new Map<string, string>();
  for (const r of rows) {
    // Only `section: "total"` rows are consulted. A LINE row could legitimately carry a code that
    // collides with a total's (an account literally numbered NET_PROFIT is absurd but not
    // impossible), and reading a line as a total would be silently wrong rather than loudly wrong.
    if (r.section === "total") byCode.set(r.code, r.amount);
  }
  const revenue = parseAmount(byCode.get(PNL_TOTAL_CODES.revenue));
  const expense = parseAmount(byCode.get(PNL_TOTAL_CODES.expense));
  const net = parseAmount(byCode.get(PNL_TOTAL_CODES.net));
  const marginRate = net !== null && revenue !== null && revenue !== 0 ? net / revenue : null;
  return {
    revenue,
    expense,
    net,
    marginRate,
    totalsMissing: revenue === null && expense === null && net === null,
  };
}

export interface ArSummary {
  /** Total outstanding across every customer. */
  outstanding: number;
  /** Everything past due — the 30/60/90/90+ buckets, i.e. outstanding minus `current`. */
  overdue: number;
  /** The worst bucket alone. This is the one a GM acts on. */
  over90: number;
  customers: number;
  /** Customers with anything in the 90+ bucket, worst first. */
  worstCustomers: { name: string; over90: number }[];
}

/** Roll the AR aging grid up.
 *
 *  `overdue` is derived as (total - current) rather than by summing the four late buckets: the
 *  server owns `totalOutstanding`, and summing buckets would drift from it the moment a bucket is
 *  added or its boundary moves. Anything the server counts as outstanding but not current is late,
 *  by definition, whatever the bucket structure happens to be. */
export function summarizeArAging(rows: ArAgingRow[]): ArSummary {
  let outstanding = 0;
  let current = 0;
  let over90 = 0;
  const worst: { name: string; over90: number }[] = [];
  for (const r of rows) {
    outstanding += parseAmount(r.totalOutstanding) ?? 0;
    current += parseAmount(r.current) ?? 0;
    const late90 = parseAmount(r.d90Plus) ?? 0;
    over90 += late90;
    if (late90 > 0) worst.push({ name: r.customerName, over90: late90 });
  }
  worst.sort((a, b) => b.over90 - a.over90);
  return {
    outstanding,
    // Clamped at zero: a credit balance (payments on account exceeding invoices) can make `current`
    // exceed the total, and "negative overdue" is not a thing a reader can act on.
    overdue: Math.max(0, outstanding - current),
    over90,
    customers: rows.length,
    worstCustomers: worst,
  };
}

/** Compact money for a KPI tile. Full precision belongs on the finance console; a cockpit tile that
 *  renders 331000000 forces the reader to count digits, which is the opposite of a glance. */
export function formatMoneyShort(n: number | null, currency = "IDR"): string {
  if (n === null) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(1)}B ${currency}`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M ${currency}`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(0)}K ${currency}`;
  return `${sign}${abs.toFixed(0)} ${currency}`;
}

/** A margin as a percentage string. `null` stays a dash — see `PnlSummary.marginRate`. */
export function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}
