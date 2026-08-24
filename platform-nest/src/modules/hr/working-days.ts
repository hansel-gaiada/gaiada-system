// Working-day arithmetic over a holiday calendar. PURE — no database, no clock, no config — so the
// same function answers "how many days does this leave request cost" in the controller, in the
// accrual engine, and in payroll's proration, and all three agree by construction.
//
// The reason this exists at all: 0028 charged leave in `minutes` with the day/half-day conversion
// left to the caller, and nothing anywhere knew about weekends or public holidays. A five-calendar-
// day request spanning a weekend was charged as five days. The holiday calendar (wave A) supplies
// the facts; this supplies the arithmetic.
//
// ── Date handling, and why there is no Date object below the boundary ───────────────────────────
// Every date here is an ISO `YYYY-MM-DD` string, and iteration is done by incrementing that string
// through a UTC-anchored Date. Using local-time Date objects for calendar arithmetic is how a
// program east of UTC decides that a leave request starting on the 1st actually starts on the
// previous month — the same trap loan-schedule.ts documents for `localToday()`. Anchoring in UTC
// and never formatting through a locale keeps a pg `date` round-trip exact.

/** ISO-8601 day-of-week: 1 = Monday .. 7 = Sunday. */
export type IsoDow = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface HolidayEntry {
  /** `YYYY-MM-DD`. */
  day: string;
  kind: "public" | "joint_leave" | "company";
  /** Only meaningful for `joint_leave`; a cuti bersama day normally DEDUCTS annual entitlement. */
  deductsEntitlement?: boolean | null;
}

export interface WorkingCalendar {
  /** ISO day numbers that are non-working. Defaults to Sat+Sun when omitted. */
  weekendDays?: number[];
  holidays?: HolidayEntry[];
}

export interface WorkingDayCount {
  /** Every day in the range, inclusive of both ends. */
  calendarDays: number;
  /** Days that are neither weekend nor holiday. */
  workingDays: number;
  weekendDays: number;
  /** Public + company holidays that fell on what would otherwise be a working day. */
  holidayDays: number;
  /**
   * Cuti bersama days inside the range that fell on a working day AND carry
   * `deductsEntitlement`. These are NOT working days, but they DO consume annual leave — which is
   * why they are counted separately rather than folded into either bucket.
   */
  jointLeaveChargedDays: number;
  /** The days actually charged against the entitlement: `workingDays + jointLeaveChargedDays`. */
  chargeableDays: number;
}

const DAY_MS = 86_400_000;
const DEFAULT_WEEKEND: number[] = [6, 7];

/** Parse `YYYY-MM-DD` to a UTC-anchored epoch millisecond value. Throws on anything else. */
export function parseIsoDate(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`expected YYYY-MM-DD, got ${JSON.stringify(iso)}`);
  const [, y, mo, d] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  // Date.UTC happily normalizes 2026-02-31 into March. Round-tripping catches that, so an invalid
  // calendar date is an error here rather than a silently shifted leave request.
  if (formatIsoDate(ms) !== iso) throw new Error(`not a real calendar date: ${iso}`);
  return ms;
}

/** Format a UTC-anchored epoch millisecond value back to `YYYY-MM-DD`. */
export function formatIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** ISO day-of-week (1=Mon..7=Sun) for an ISO date string. */
export function isoDayOfWeek(iso: string): IsoDow {
  const jsDow = new Date(parseIsoDate(iso)).getUTCDay(); // 0=Sun..6=Sat
  return (jsDow === 0 ? 7 : jsDow) as IsoDow;
}

/** Add whole days to an ISO date, returning an ISO date. */
export function addDays(iso: string, days: number): string {
  return formatIsoDate(parseIsoDate(iso) + days * DAY_MS);
}

/** Inclusive list of every ISO date from `startIso` to `endIso`. Empty if the range is inverted. */
export function eachDay(startIso: string, endIso: string): string[] {
  const start = parseIsoDate(startIso);
  const end = parseIsoDate(endIso);
  if (end < start) return [];
  const out: string[] = [];
  for (let ms = start; ms <= end; ms += DAY_MS) out.push(formatIsoDate(ms));
  return out;
}

/**
 * Count how an inclusive date range breaks down against a working calendar.
 *
 * The subtlety worth knowing: a holiday that falls on a weekend is counted as a WEEKEND day, not as
 * a holiday day. Counting it in both would make the buckets sum to more than the range, and every
 * consumer of this function sums the buckets.
 */
export function countWorkingDays(startIso: string, endIso: string, calendar: WorkingCalendar = {}): WorkingDayCount {
  const weekend = new Set(
    (calendar.weekendDays?.length ? calendar.weekendDays : DEFAULT_WEEKEND).map(Number),
  );
  const byDay = new Map<string, HolidayEntry>();
  for (const h of calendar.holidays ?? []) byDay.set(h.day, h);

  const days = eachDay(startIso, endIso);
  let workingDays = 0;
  let weekendDays = 0;
  let holidayDays = 0;
  let jointLeaveChargedDays = 0;

  for (const day of days) {
    if (weekend.has(isoDayOfWeek(day))) { weekendDays += 1; continue; }
    const holiday = byDay.get(day);
    if (!holiday) { workingDays += 1; continue; }
    holidayDays += 1;
    // A cuti bersama day is not worked, but it is normally charged against annual leave. Both facts
    // are true at once, which is exactly why the count is reported in two places.
    if (holiday.kind === "joint_leave" && holiday.deductsEntitlement) jointLeaveChargedDays += 1;
  }

  return {
    calendarDays: days.length,
    workingDays,
    weekendDays,
    holidayDays,
    jointLeaveChargedDays,
    chargeableDays: workingDays + jointLeaveChargedDays,
  };
}

/**
 * The chargeable days for a leave request, honouring the policy's `excludesHolidays` switch.
 *
 * When a policy does NOT exclude holidays (unpaid leave is often counted in calendar days — you are
 * away, the employer is not paying, and the weekend does not make you present), the answer is simply
 * the calendar-day count. Making that a policy flag rather than a per-type `if` is what keeps the
 * rule visible in the data instead of buried here.
 */
export function chargeableLeaveDays(
  startIso: string,
  endIso: string,
  calendar: WorkingCalendar,
  opts: { excludesHolidays?: boolean } = {},
): number {
  const counted = countWorkingDays(startIso, endIso, calendar);
  return opts.excludesHolidays === false ? counted.calendarDays : counted.chargeableDays;
}

/**
 * Convert chargeable days to the canonical `minutes` unit 0028 charges leave in.
 *
 * `minutesPerDay` is a parameter rather than the constant 480 because a part-time employee's day is
 * shorter, and hard-coding the full-time day would over-charge them for the same absence.
 */
export function daysToMinutes(days: number, minutesPerDay = 480): number {
  return Math.round(days * minutesPerDay);
}

/** Whole months of completed service between two ISO dates. Used by every waiting-period rule. */
export function completedMonths(fromIso: string, toIso: string): number {
  const from = new Date(parseIsoDate(fromIso));
  const to = new Date(parseIsoDate(toIso));
  if (to < from) return 0;
  let months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  // The final month only counts once the day-of-month has been reached. Without this, someone hired
  // on the 31st completes a month on the 1st.
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

/**
 * Continuous service in fractional years, the unit every severance multiplier is expressed in.
 *
 * Fractional rather than whole because the Indonesian severance table brackets on "1 year but less
 * than 2", and rounding to whole years at this layer would silently move people between brackets.
 * The bracketing itself belongs to the severance engine, which is where that decision is visible.
 */
export function serviceYears(fromIso: string, toIso: string): number {
  const months = completedMonths(fromIso, toIso);
  const from = new Date(parseIsoDate(fromIso));
  const to = new Date(parseIsoDate(toIso));
  // Leftover days beyond the whole months, expressed against a 30-day month. Approximate by
  // construction — the statute brackets on whole years, so sub-month precision never changes an
  // outcome; it exists so the displayed figure is not a lie.
  const anchor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, from.getUTCDate()));
  const leftoverDays = Math.max(0, Math.round((to.getTime() - anchor.getTime()) / DAY_MS));
  return Number((months / 12 + leftoverDays / 365).toFixed(3));
}
