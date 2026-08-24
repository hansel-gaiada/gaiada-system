// Leave accrual arithmetic. PURE — no database, no clock — so "why is my balance 7.5 days" has an
// answer that can be unit-tested and restated to an employee line by line.
//
// The problem this solves: 0028's `hr_leave_balances.allocated_minutes` is a number somebody typed.
// It stops being true the moment anyone joins mid-year, and nothing in the system can say how it was
// arrived at. Wave A added the RULE (`hr_leave_policies`) and the LEDGER (`hr_leave_accruals`); this
// is the function between them.
//
// ── The Indonesian default this is shaped around ────────────────────────────────────────────────
// UU 13/2003 art. 79: 12 working days of paid annual leave after 12 months of CONTINUOUS service.
// That is `accrual_method='upfront'`, `waiting_period_months=12`, `annual_entitlement_minutes=5760`.
// Nothing below hard-codes any of it — the policy row carries the numbers, and a company running a
// more generous monthly-accrual scheme is the same code path with different data. The statutory
// shape is documented here because it is what the defaults were chosen to express, not because the
// engine assumes it.
//
// ── Everything is in MINUTES ────────────────────────────────────────────────────────────────────
// Same discipline as loan-schedule.ts's cents: integer minor units throughout, one conversion at the
// boundary. Accruing 1/12 of 5760 minutes twelve times must land on exactly 5760, and it only does
// if the remainder is carried rather than rounded away each month.

import { completedMonths, parseIsoDate } from "./working-days";

export type AccrualMethod = "upfront" | "monthly" | "anniversary" | "none";

export interface LeavePolicy {
  id?: string;
  accrualMethod: AccrualMethod;
  annualEntitlementMinutes: number;
  waitingPeriodMonths: number;
  prorateFirstYear: boolean;
  carryoverMaxMinutes: number;
  carryoverExpiryMonths: number;
  allowNegativeBalance: boolean;
}

export interface AccrualPosting {
  /** `accrual` | `carryover` | `expiry`. Adjustments and encashments are human acts, never posted here. */
  kind: "accrual" | "carryover" | "expiry";
  minutes: number;
  periodStart: string;
  periodEnd: string;
  /** Human-readable derivation, stored on the ledger row so the balance can explain itself. */
  reason: string;
}

export interface AccrualContext {
  /** ISO hire date. Service, and therefore every waiting period, is measured from here. */
  hireDate: string;
  /** The calendar year being accrued. */
  year: number;
  /** Inclusive ISO date the run is posting UP TO. Nothing after this accrues. */
  asOf: string;
  /** Minutes already posted for this (subject, year, type) — makes the run idempotent in arithmetic
   *  as well as in the database's unique index. */
  alreadyAccruedMinutes?: number;
  /** Unused minutes at the end of the PRIOR year, before the policy cap is applied. */
  priorYearRemainingMinutes?: number;
  /** ISO date the employee left, if they did. Accrual stops here. */
  terminationDate?: string | null;
}

const clampNonNegative = (n: number): number => (n < 0 ? 0 : n);

/**
 * The date on which entitlement first exists: hire date plus the waiting period.
 *
 * Month arithmetic via UTC components rather than day addition, because "12 months after 31 January"
 * is 31 January, not 31 January plus 365 days — and in a leap year those differ.
 */
export function entitlementStartDate(hireDate: string, waitingPeriodMonths: number): string {
  const d = new Date(parseIsoDate(hireDate));
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + waitingPeriodMonths, d.getUTCDate()));
  // Date.UTC rolls 31 February into March. For a waiting period that is the correct, conservative
  // direction (entitlement starts slightly later, never earlier), so it is left as-is and noted
  // rather than clamped to the month end.
  return target.toISOString().slice(0, 10);
}

/**
 * How many minutes SHOULD be allocated for `year`, given the policy and the employee's service.
 *
 * This is the target, not the delta. `planAccruals` diffs it against what has already been posted,
 * which is what makes a re-run a no-op instead of a doubling.
 */
export function entitlementForYear(policy: LeavePolicy, ctx: AccrualContext): number {
  if (policy.accrualMethod === "none" || policy.annualEntitlementMinutes <= 0) return 0;

  const yearStart = `${ctx.year}-01-01`;
  const yearEnd = `${ctx.year}-12-31`;
  const eligibleFrom = entitlementStartDate(ctx.hireDate, policy.waitingPeriodMonths);

  // Not yet eligible at any point during the year.
  if (eligibleFrom > yearEnd) return 0;
  // Left before the year began.
  if (ctx.terminationDate && ctx.terminationDate < yearStart) return 0;

  const windowStart = eligibleFrom > yearStart ? eligibleFrom : yearStart;
  const windowEnd = ctx.terminationDate && ctx.terminationDate < yearEnd ? ctx.terminationDate : yearEnd;
  if (windowEnd < windowStart) return 0;

  const full = policy.annualEntitlementMinutes;
  const isPartialYear = windowStart > yearStart || windowEnd < yearEnd;
  if (!isPartialYear || !policy.prorateFirstYear) return full;

  // Pro-rate by COMPLETED MONTHS in the window rather than by days. Months are the unit the policy
  // is expressed in, and a day-based proration produces figures like 11.87 days that nobody can
  // reconcile against a contract that says "12 days a year".
  const months = Math.min(12, completedMonths(windowStart, windowEnd) + 1);
  return Math.round((full * months) / 12);
}

/**
 * Carried-over minutes: last year's remainder, capped by policy.
 *
 * The cap is the whole point — an uncapped carryover turns unused leave into an unbounded liability
 * on the balance sheet, which is exactly why every real policy has one.
 */
export function carryoverForYear(policy: LeavePolicy, priorYearRemainingMinutes: number): number {
  if (policy.carryoverMaxMinutes <= 0) return 0;
  return Math.min(clampNonNegative(priorYearRemainingMinutes), policy.carryoverMaxMinutes);
}

/** The ISO date on which carried-over minutes expire, or null if the policy does not expire them. */
export function carryoverExpiryDate(policy: LeavePolicy, year: number): string | null {
  if (policy.carryoverMaxMinutes <= 0 || policy.carryoverExpiryMonths <= 0) return null;
  // Months after 1 January of the accrual year.
  const d = new Date(Date.UTC(year, policy.carryoverExpiryMonths, 1));
  // The last day of the month BEFORE the boundary, so a 3-month expiry means "usable through 31 March".
  return new Date(d.getTime() - 86_400_000).toISOString().slice(0, 10);
}

/**
 * The postings the engine should write for one (employee, year, leave type), given what is already
 * on the ledger. Returns an empty array when nothing is owed — the common case on a re-run.
 *
 * Monthly accrual posts one row PER COMPLETED MONTH rather than one catch-up row, because the ledger
 * is what an employee is shown when they query their balance, and "you accrued 1 day in each of
 * March, April and May" is an explanation where "you accrued 3 days" is an assertion.
 */
export function planAccruals(policy: LeavePolicy, ctx: AccrualContext): AccrualPosting[] {
  const postings: AccrualPosting[] = [];
  const yearStart = `${ctx.year}-01-01`;
  const yearEnd = `${ctx.year}-12-31`;
  const asOf = ctx.asOf < yearEnd ? ctx.asOf : yearEnd;

  // Carryover is posted first: it is dated to 1 January and it is what the year opens with.
  const carried = carryoverForYear(policy, ctx.priorYearRemainingMinutes ?? 0);
  if (carried > 0) {
    postings.push({
      kind: "carryover",
      minutes: carried,
      periodStart: yearStart,
      periodEnd: yearStart,
      reason: `carried over from ${ctx.year - 1} (capped at ${policy.carryoverMaxMinutes} minutes)`,
    });
  }

  const target = entitlementForYear(policy, ctx);
  if (target <= 0) return postings;

  const eligibleFrom = entitlementStartDate(ctx.hireDate, policy.waitingPeriodMonths);
  const alreadyPosted = clampNonNegative(ctx.alreadyAccruedMinutes ?? 0);

  if (policy.accrualMethod === "upfront") {
    // The whole entitlement lands on the later of 1 January and the eligibility date, and only once
    // that date has actually arrived.
    const anchor = eligibleFrom > yearStart ? eligibleFrom : yearStart;
    if (anchor > asOf) return postings;
    const owed = target - alreadyPosted;
    if (owed > 0) {
      postings.push({
        kind: "accrual",
        minutes: owed,
        periodStart: anchor,
        periodEnd: anchor,
        reason: `upfront entitlement for ${ctx.year} (${target} minutes)`,
      });
    }
    return postings;
  }

  if (policy.accrualMethod === "anniversary") {
    // The whole entitlement lands on the hire anniversary falling in this year.
    const hire = new Date(parseIsoDate(ctx.hireDate));
    const anniversary = new Date(Date.UTC(ctx.year, hire.getUTCMonth(), hire.getUTCDate()))
      .toISOString().slice(0, 10);
    if (anniversary < eligibleFrom || anniversary > asOf) return postings;
    const owed = target - alreadyPosted;
    if (owed > 0) {
      postings.push({
        kind: "accrual",
        minutes: owed,
        periodStart: anniversary,
        periodEnd: anniversary,
        reason: `anniversary entitlement for ${ctx.year} (${target} minutes)`,
      });
    }
    return postings;
  }

  // monthly: one posting per eligible completed month.
  //
  // Two properties this loop has to hold simultaneously, and the reason it is written in two passes
  // rather than one:
  //
  //   1. THE POSTINGS MUST SUM EXACTLY TO `target`. Rounding target/12 independently each month
  //      loses up to 11 minutes a year — small, and precisely the kind of small an employee notices
  //      at year end. Taking each month's share as the DIFFERENCE of two cumulative roundings
  //      (round(target*m/12) - round(target*(m-1)/12)) makes the remainder self-correcting.
  //   2. A RE-RUN MUST BE A NO-OP. `alreadyAccruedMinutes` is consumed off the FRONT of the due
  //      list, so months already on the ledger produce nothing and only the tail is posted.
  //
  // Doing both in one pass is what produced the tangle this replaced. Two passes is longer and it
  // is obviously right.
  const due: AccrualPosting[] = [];
  let previousCumulative = 0;
  for (let month = 1; month <= 12; month += 1) {
    const monthStart = `${ctx.year}-${String(month).padStart(2, "0")}-01`;
    // Day 0 of the NEXT month is the last day of this one — the standard trick, and correct for
    // February in a leap year without a special case.
    const monthEnd = new Date(Date.UTC(ctx.year, month, 0)).toISOString().slice(0, 10);
    const cumulative = Math.round((target * month) / 12);
    const share = cumulative - previousCumulative;
    previousCumulative = cumulative;

    if (monthEnd > asOf) break;                                        // not yet completed
    if (ctx.terminationDate && monthStart > ctx.terminationDate) break; // left before it started
    if (monthEnd < eligibleFrom) continue;                              // still inside the waiting period
    if (share <= 0) continue;

    due.push({
      kind: "accrual",
      minutes: share,
      periodStart: monthStart,
      periodEnd: monthEnd,
      reason: `monthly accrual ${ctx.year}-${String(month).padStart(2, "0")} (1/12 of ${target} minutes)`,
    });
  }

  // Consume what the ledger already holds off the front. A partially-covered month posts its
  // remainder rather than being skipped, so a hand adjustment mid-month cannot strand minutes.
  let unconsumed = alreadyPosted;
  for (const posting of due) {
    if (unconsumed >= posting.minutes) { unconsumed -= posting.minutes; continue; }
    const minutes = posting.minutes - unconsumed;
    unconsumed = 0;
    postings.push({ ...posting, minutes });
  }
  return postings;
}

export interface BalanceView {
  allocatedMinutes: number;
  usedMinutes: number;
  pendingMinutes: number;
  /** allocated - used - pending. May be negative when the policy allows advance leave. */
  remainingMinutes: number;
  /** Whether a request of `requestedMinutes` fits. */
  sufficient: boolean;
  shortfallMinutes: number;
}

/**
 * Whether a request fits the balance, and by how much it does not.
 *
 * PENDING requests are counted against the balance. Not doing so is the classic double-spend in
 * leave systems: file two requests for the same fortnight before either is decided, and both look
 * affordable right up until they are both approved.
 */
export function evaluateRequest(
  policy: Pick<LeavePolicy, "allowNegativeBalance">,
  balance: { allocatedMinutes: number; usedMinutes: number; pendingMinutes?: number },
  requestedMinutes: number,
): BalanceView {
  const pending = balance.pendingMinutes ?? 0;
  const remaining = balance.allocatedMinutes - balance.usedMinutes - pending;
  const after = remaining - requestedMinutes;
  return {
    allocatedMinutes: balance.allocatedMinutes,
    usedMinutes: balance.usedMinutes,
    pendingMinutes: pending,
    remainingMinutes: remaining,
    sufficient: policy.allowNegativeBalance || after >= 0,
    shortfallMinutes: after < 0 ? -after : 0,
  };
}
