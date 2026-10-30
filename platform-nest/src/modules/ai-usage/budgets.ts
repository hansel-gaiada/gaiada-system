// AIP-17b + AIP-19 (docs/plans/2026-10-27-ai-plan.md §6.3 items 6 to 8; docs/FRONTEND-BFF-CONTRACT.md §66) — the PURE half of budgets, allowances
// and the runaway alert: money parsing, the exact percent and state arithmetic, the notice thresholds, and the runaway rule. No DB, no Nest:
// budgets.test.ts drives every function directly.
//
// MONEY IS NEVER A FLOAT. A figure is an exact decimal string. `ai_usage_events.cost_usd` sums to numeric(14,8) and a budget is numeric(12,4);
// both are scaled to 8 places as BigInt, so "80 percent" is an exact comparison (spent * 100 >= monthly * 80), never a rounded one.

/** The most a monthly figure may be: numeric(12,4). */
export const MAX_MONTHLY_USD = "99999999.9999";

/** The two notice thresholds of a budget, in percent. */
export const BUDGET_THRESHOLDS = [80, 100] as const;
export type BudgetThreshold = (typeof BUDGET_THRESHOLDS)[number];

/** The runaway ledger threshold: 5 times the usual figure, as a percent (the ledger holds whole numbers). */
export const RUNAWAY_LEDGER_THRESHOLD = 500;
export const RUNAWAY_FACTOR = 5;
/** A person or agent needs this many active days in the 14-day window, and this many calls today (AIP-19). */
export const RUNAWAY_MIN_ACTIVE_DAYS = 7;
export const RUNAWAY_MIN_CALLS_TODAY = 20;
export const RUNAWAY_WINDOW_DAYS = 14;

export type BudgetState = "under" | "over_80" | "over_100";

const SCALE = 8;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

/** PURE. A SQL numeric text (or any plain non-negative decimal) as a BigInt scaled by 10^8. Throws on anything else. */
export function toScaled(decimal: string): bigint {
  const m = /^([0-9]+)(?:\.([0-9]+))?$/.exec(decimal);
  if (!m) throw new Error(`not a plain non-negative decimal: ${decimal}`);
  const frac = (m[2] ?? "");
  if (frac.length > SCALE) {
    // numeric(14,8) never holds more; trailing zeros past the scale are tolerated, anything else is a caller bug.
    if (/[1-9]/.test(frac.slice(SCALE))) throw new Error(`more than ${SCALE} decimal places: ${decimal}`);
  }
  return BigInt(m[1]) * SCALE_FACTOR + BigInt(frac.slice(0, SCALE).padEnd(SCALE, "0"));
}

export class MoneyError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/**
 * PURE. A monthly figure from a request body: a STRING, a positive decimal with at most 4 places and at most 99999999.9999. Returns it in the
 * canonical form PostgreSQL stores (4 places, no leading zeros beyond one). A number, an exponent, a sign, a comma, a space, zero and more than
 * 8 integer digits are all refused: a float in a money field is how a cent goes missing.
 */
export function parseMonthlyUsd(raw: unknown, field = "monthlyUsd"): string {
  if (typeof raw !== "string") throw new MoneyError(field, `${field} must be a decimal string such as "250.00"`);
  const m = /^([0-9]{1,8})(?:\.([0-9]{1,4}))?$/.exec(raw);
  if (!m) throw new MoneyError(field, `${field} must be a positive decimal with at most 4 decimal places and at most ${MAX_MONTHLY_USD}`);
  const whole = m[1].replace(/^0+(?=[0-9])/, "");
  const frac = (m[2] ?? "").padEnd(4, "0");
  if (!/[1-9]/.test(whole + frac)) throw new MoneyError(field, `${field} must be greater than 0 (remove the figure with null)`);
  return `${whole}.${frac}`;
}

export interface BudgetFigure {
  /** Month-to-date percent of the figure, floored to one decimal place (never rounds up to a threshold it has not reached). */
  percent: number;
  state: BudgetState;
}

/**
 * PURE. Where month-to-date spend stands against a monthly figure. `spentUsd` null (no call in the scope had a cost) is nothing spent: unknown is
 * counted separately by the caller (`noCostCalls`), and a budget cannot be crossed by money nobody knows.
 */
export function budgetFigure(spentUsd: string | null, monthlyUsd: string): BudgetFigure {
  const spent = spentUsd === null ? 0n : toScaled(spentUsd);
  const monthly = toScaled(monthlyUsd);
  if (monthly <= 0n) throw new Error("a budget figure is always greater than 0");
  const percent = Number((spent * 1000n) / monthly) / 10;
  const state: BudgetState = spent * 100n >= monthly * 100n ? "over_100" : spent * 100n >= monthly * 80n ? "over_80" : "under";
  return { percent, state };
}

/** PURE. The thresholds a state has crossed, lowest first: over_80 is [80], over_100 is [80, 100]. */
export function thresholdsCrossed(state: BudgetState): BudgetThreshold[] {
  return state === "over_100" ? [80, 100] : state === "over_80" ? [80] : [];
}

export interface RunawayInput {
  /** Calls today (the UTC day). */
  today: number;
  /** Days of the previous 14 UTC days on which the subject had any call. */
  activeDays: number;
  /** The calls on those days, summed. */
  previousCalls: number;
}

/**
 * PURE (AIP-19, AIP-D19). A subject runs away when it has at least 7 active days in the previous 14, at least 20 calls today, and today's calls
 * are at least 5 times its own average over the ACTIVE days only. Exact integer arithmetic: today >= 5 * previous / activeDays is
 * today * activeDays >= 5 * previous.
 */
export function isRunaway(i: RunawayInput): boolean {
  if (!Number.isInteger(i.today) || !Number.isInteger(i.activeDays) || !Number.isInteger(i.previousCalls)) return false;
  if (i.activeDays < RUNAWAY_MIN_ACTIVE_DAYS || i.today < RUNAWAY_MIN_CALLS_TODAY) return false;
  return i.today * i.activeDays >= RUNAWAY_FACTOR * i.previousCalls;
}

/** PURE. The usual daily figure of a subject (average calls on its active days), rounded to a whole number for the notice. */
export function usualDaily(i: RunawayInput): number {
  return i.activeDays > 0 ? Math.round(i.previousCalls / i.activeDays) : 0;
}

/** PURE. `YYYY-MM-DD` of a UTC instant. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** PURE. `YYYY-MM-DD` of the UTC day `days` before `day`. */
export function utcDayMinus(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
