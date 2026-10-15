// DW-7j-5 — the GM's monthly revenue plan (docs/FRONTEND-BFF-CONTRACT.md §40.6.4): the pure, client-safe half. Types of the
// wire shape, the twelve months of a year, the money conversion and the typed-amount parse, the plan-against-actual ratio and the
// sentences for a refusal. No fetching here (revenuePlan-data.ts reads, revenuePlanActions.ts writes).
//
// MONEY UNIT. The plan travels and is stored in the currency's MINOR unit (`amountMinor`: IDR has 0 decimals, USD 2), and the
// server says how many in `minorUnit`. The ledger's P&L, which the page sets beside it, is in MAJOR units, so a plan is shown and
// typed in major units and converted here, never by a table of currencies of this file's own.

import type { ReadResult } from "./readResult";

export interface RevenuePlanMonth {
  /** `YYYY-MM`. */
  month: string;
  amountMinor: number | null;
  note: string | null;
  setBy: string | null;
  setAt: string | null;
}

export interface RevenuePlanRead {
  /** The company's base (functional) currency, or null when it has no finance settings. */
  currency: string | null;
  /** Decimals of that currency, or null with it. */
  minorUnit: number | null;
  months: RevenuePlanMonth[];
}

export const NOTE_MAX = 2000;
export const FIRST_YEAR = 2000;
export const LAST_YEAR = 2100;

/** `YYYY-01` to `YYYY-12`. */
export function monthsOfYear(year: number): string[] {
  return Array.from({ length: 12 }, (_, i) => `${String(year).padStart(4, "0")}-${String(i + 1).padStart(2, "0")}`);
}

/** The year the page shows: `raw` when it is a whole year in range, else `fallback`. */
export function parseYear(raw: string | string[] | undefined, fallback: number): number {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string" || !/^\d{4}$/.test(v)) return fallback;
  const n = Number(v);
  return n >= FIRST_YEAR && n <= LAST_YEAR ? n : fallback;
}

/** First day of a `YYYY-MM`. */
export const monthFirstDay = (month: string): string => `${month}-01`;

/** Last day of a `YYYY-MM`. */
export function monthLastDay(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

/** True when the month starts after `todayIso`: it has no revenue to show yet, so no ratio either. */
export const isFutureMonth = (month: string, todayIso: string): boolean => monthFirstDay(month) > todayIso;

/** minor to major units. */
export const minorToMajor = (minor: number, minorUnit: number): number => minor / 10 ** minorUnit;

/** `IDR 200,000,000` / `USD 12,345.60`: grouped, with exactly the currency's decimals. */
export function formatMoney(major: number, currency: string | null, minorUnit: number): string {
  const n = new Intl.NumberFormat("en-US", { minimumFractionDigits: minorUnit, maximumFractionDigits: minorUnit }).format(major);
  return currency ? `${currency} ${n}` : n;
}

export type AmountParse = { ok: true; minor: number } | { ok: false; error: string };

/**
 * What the GM typed, in MAJOR units, as the whole number of minor units the server stores. Spaces and thousands commas are
 * ignored. A currency with 0 decimals takes none and one with 2 takes at most 2: a figure with more is refused, never rounded
 * (a plan changed silently by a rounding is a plan nobody typed). Done on the digits, not on a float, so 1234.56 is exactly 123456.
 */
export function parseAmountInput(text: string, minorUnit: number): AmountParse {
  const t = text.replace(/[\s,]/g, "");
  if (t === "") return { ok: false, error: "Enter an amount, or use Clear to remove this month's plan." };
  const m = /^(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) return { ok: false, error: "The amount must be a number of at least 0, such as 200000000." };
  const frac = m[2] ?? "";
  if (frac.length > minorUnit) {
    return { ok: false, error: minorUnit === 0 ? "This currency has no decimals: enter a whole amount." : `This currency has ${minorUnit} decimal${minorUnit === 1 ? "" : "s"}: enter at most ${minorUnit}.` };
  }
  const minor = Number(`${m[1]}${frac.padEnd(minorUnit, "0")}`);
  if (!Number.isSafeInteger(minor)) return { ok: false, error: "That amount is too large." };
  return { ok: true, minor };
}

/** actual ÷ plan (both in major units), or `null` when either is unknown or the plan is 0: a month with no plan reads "no data", never 100%. */
export function attainment(actualMajor: number | null, planMinor: number | null, minorUnit: number): number | null {
  if (actualMajor === null || planMinor === null) return null;
  const plan = minorToMajor(planMinor, minorUnit);
  return plan > 0 ? actualMajor / plan : null;
}

/** `92%`, or a dash when there is no ratio. */
export const formatAttainment = (r: number | null): string => (r === null ? "—" : `${Math.round(r * 100)}%`);

export const REFUSED_WORDS = "Only a company administrator can set the revenue plan. You can read it, but not change it.";
export const NO_BASE_CURRENCY_WORDS = "This company has no finance settings yet, so it has no base currency. Set them up in Finance first, then plan the year.";

/** The sentence for a failed write: the two machine answers worded, any other message as the server sent it. */
export function explainRevenuePlanError(status: number | undefined, message: string): string {
  if (status === 403) return REFUSED_WORDS;
  if (message === "no_base_currency") return NO_BASE_CURRENCY_WORDS;
  return message;
}

// ── The grid: twelve months, each plan beside its actual ────────────────────────────────────────

export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/** What the page can say about one month's actual revenue. Never a bare 0 for "not read". */
export type ActualCell =
  | { kind: "value"; major: number }
  /** The month starts after today: there is no revenue to read yet. */
  | { kind: "future" }
  /** The read succeeded but the statement carried no revenue total. */
  | { kind: "none" }
  | { kind: "forbidden" }
  | { kind: "unavailable"; reason: string };

export interface GridRow {
  month: string;
  label: string;
  amountMinor: number | null;
  note: string | null;
  actual: ActualCell;
  /** actual ÷ plan, or null (see `attainment`). */
  attainment: number | null;
}

/** The twelve rows of `year`, from the plan read and each elapsed month's revenue read (a month with no entry is a future one). */
export function buildGridRows(year: number, plan: RevenuePlanRead, actuals: Record<string, ReadResult<number | null>>): GridRow[] {
  const planned = new Map(plan.months.map((m) => [m.month, m]));
  const unit = plan.minorUnit ?? 0;
  return monthsOfYear(year).map((month, i) => {
    const p = planned.get(month);
    const read = actuals[month];
    const actual: ActualCell = !read ? { kind: "future" }
      : read.kind === "forbidden" ? { kind: "forbidden" }
      : read.kind === "unavailable" ? { kind: "unavailable", reason: read.reason }
      : read.data === null ? { kind: "none" }
      : { kind: "value", major: read.data };
    const amountMinor = p?.amountMinor ?? null;
    return {
      month, label: MONTH_NAMES[i], amountMinor, note: p?.note ?? null, actual,
      attainment: attainment(actual.kind === "value" ? actual.major : null, amountMinor, unit),
    };
  });
}

export interface YearTotals {
  /** Sum of the months that have a plan, in major units, and how many of the twelve those are. */
  planMajor: number;
  plannedMonths: number;
  /** Sum of the months whose revenue was read, in major units, and how many of the twelve those are. */
  actualMajor: number;
  readMonths: number;
}

export function yearTotals(rows: readonly GridRow[], minorUnit: number): YearTotals {
  let planMajor = 0, plannedMonths = 0, actualMajor = 0, readMonths = 0;
  for (const r of rows) {
    if (r.amountMinor !== null) { planMajor += minorToMajor(r.amountMinor, minorUnit); plannedMonths += 1; }
    if (r.actual.kind === "value") { actualMajor += r.actual.major; readMonths += 1; }
  }
  return { planMajor, plannedMonths, actualMajor, readMonths };
}
