// DW-7j-5 / f1 (docs/FRONTEND-BFF-CONTRACT.md §40.6.4): the GM's monthly revenue plan, the PURE half. No I/O, no clock: the months
// of a range, a month's day count, and the plan summed over a KPI window. Shared by the routes (revenue-plan.controller.ts)
// and the `gm.revenue_vs_plan` reader (reports/dept-kpi-readers/functional/gm.ts), so the two cannot disagree about what a
// month is.
//
// MONEY UNIT. A plan is stored in the currency's MINOR unit (`finance_revenue_plans.amount_minor`, a bigint). The ledger's own
// amounts, and so the P&L's, are `numeric` in MAJOR units (migration 202608241015: `numeric(20,4)`, "IDR 0 dp through to 4-dp
// currencies"). `finance_currencies.minor_unit` is the bridge: major = minor / 10^minor_unit (IDR 0, USD 2). The reader
// converts the plan to major units before it divides.

/** The longest range one `GET /revenue-plan` returns (BFF §40.6.4). */
export const MAX_PLAN_MONTHS = 36;

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export interface YearMonth {
  year: number;
  /** 1 to 12. */
  month: number;
}

/** PURE. `YYYY-MM` to its parts, or `null` when it is not a calendar month. */
export function parseMonth(text: unknown): YearMonth | null {
  if (typeof text !== "string") return null;
  const m = MONTH_RE.exec(text);
  return m ? { year: Number(m[1]), month: Number(m[2]) } : null;
}

/** PURE. `YYYY-MM`. */
export function formatMonth(ym: YearMonth): string {
  return `${String(ym.year).padStart(4, "0")}-${String(ym.month).padStart(2, "0")}`;
}

/** PURE. Calendar days in the month (leap years included). */
export function daysInMonth(ym: YearMonth): number {
  return new Date(Date.UTC(ym.year, ym.month, 0)).getUTCDate();
}

/** PURE. Whole months from `a` to `b`, inclusive of both (`a` = `b` is 1). Negative when `b` is before `a`. */
export function monthSpan(a: YearMonth, b: YearMonth): number {
  return (b.year - a.year) * 12 + (b.month - a.month) + 1;
}

/** PURE. Every month from `from` to `to`, inclusive, as `YYYY-MM`. Empty when `to` is before `from`. */
export function monthsBetween(from: YearMonth, to: YearMonth): string[] {
  const n = monthSpan(from, to);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const idx = from.year * 12 + (from.month - 1) + i;
    out.push(formatMonth({ year: Math.floor(idx / 12), month: (idx % 12) + 1 }));
  }
  return out;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Whole days since the epoch for an ISO date (UTC, so no daylight saving). */
function dayNumber(iso: string): number {
  const m = ISO_DATE_RE.exec(iso);
  if (!m) return NaN;
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

/**
 * PURE. The plan over the inclusive window `[start, end]` (ISO dates), in MAJOR units, or `null`.
 *
 * `plans` maps `YYYY-MM` to that month's `amount_minor`. A month that overlaps the window counts its plan times
 * (days of the month inside the window ÷ days in the month): a full month counts its whole plan, a half month half of it.
 * `null` when ANY overlapping month has no plan (a hole is "no data", never a smaller plan), when the window is empty or
 * unreadable, or when the sum is 0 (a KPI cannot divide by it).
 */
export function planOverWindow(plans: ReadonlyMap<string, number>, start: string, end: string, minorUnit: number): number | null {
  const first = dayNumber(start);
  const last = dayNumber(end);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return null;
  const from = parseMonth(start.slice(0, 7));
  const to = parseMonth(end.slice(0, 7));
  if (!from || !to) return null;
  const scale = 10 ** minorUnit;
  let sum = 0;
  for (const key of monthsBetween(from, to)) {
    const minor = plans.get(key);
    if (minor === undefined) return null;
    const ym = parseMonth(key)!;
    const monthFirst = dayNumber(`${key}-01`);
    const dim = daysInMonth(ym);
    const inside = Math.min(last, monthFirst + dim - 1) - Math.max(first, monthFirst) + 1;
    if (inside <= 0) continue;
    sum += (minor * inside) / dim / scale;
  }
  return sum > 0 ? sum : null;
}
