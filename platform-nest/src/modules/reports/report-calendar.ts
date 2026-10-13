// DW-4a — the ONE calendar resolver for report periods (tracker-reporting-foundation.md §15,
// "2026-10-13 (DW-4a, contract first)"). Pure: no DB, no clock, no Nest. Everything that needs to
// know what "the week / month / quarter / semester / year containing this date" means calls here:
// `document-builder.ts` (range, comparison, label), `report-periods.ts` (period starts in a
// window) and `checkins.controller.ts` (`resolveCheckinPeriod`). `document-builder.ts` and
// `report-periods.ts` re-export these names so older importers keep compiling.
//
// Calendar kinds: day, ISO week (Monday start), month, quarter (Jan-Mar, Apr-Jun, Jul-Sep,
// Oct-Dec), semester (Jan-Jun, Jul-Dec) and year (Jan-Dec). No fiscal-year offset exists.
// platform-ui/src/lib/demoReports.ts mirrors this math; both sides pin the same golden table
// (report-calendar.test.ts <-> demoReports.test.ts).
import { addDaysIso } from "../../core/dept-resolution";
import { inclusiveDayCount } from "./metrics";
import type { ReportPeriodKind } from "./report-document";

export type CalendarKind = "day" | "week" | "month" | "quarter" | "semester" | "year";

export const CALENDAR_KINDS: readonly CalendarKind[] = ["day", "week", "month", "quarter", "semester", "year"];

export function isCalendarKind(x: unknown): x is CalendarKind {
  return typeof x === "string" && (CALENDAR_KINDS as readonly string[]).includes(x);
}

/** Months per period for the month-aligned kinds. */
const MONTHS_PER_PERIOD = {
  month: 1,
  quarter: 3,
  semester: 6,
  year: 12,
} as const;

type MonthAlignedKind = keyof typeof MONTHS_PER_PERIOD;

function isMonthAligned(kind: string): kind is MonthAlignedKind {
  return kind === "month" || kind === "quarter" || kind === "semester" || kind === "year";
}

function toUtcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}
function fromUtcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Monday on or before `dateIso` (ISO week, matching platform-ui/src/lib/reports.ts's
 *  `bucketKeyFor` week convention — the two must agree on what "the week" means). */
export function mondayOnOrBefore(dateIso: string): string {
  const d = toUtcDate(dateIso);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow);
  return fromUtcDate(d);
}

/** First day of the month-aligned period (month/quarter/semester/year) containing `dateIso`. */
function monthAlignedStart(kind: MonthAlignedKind, dateIso: string): string {
  const d = toUtcDate(dateIso);
  const span = MONTHS_PER_PERIOD[kind];
  const firstMonth = Math.floor(d.getUTCMonth() / span) * span;
  return fromUtcDate(new Date(Date.UTC(d.getUTCFullYear(), firstMonth, 1)));
}

/** Last day of the month-aligned period that begins on `startIso` (a first-of-period date). */
function monthAlignedEnd(kind: MonthAlignedKind, startIso: string): string {
  const d = toUtcDate(startIso);
  // day 0 of the month AFTER the period = the period's last day
  return fromUtcDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + MONTHS_PER_PERIOD[kind], 0)));
}

/** First day of the period that follows the one starting on `startIso`. */
function nextMonthAlignedStart(kind: MonthAlignedKind, startIso: string): string {
  const d = toUtcDate(startIso);
  return fromUtcDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + MONTHS_PER_PERIOD[kind], 1)));
}

/** Resolves a calendar periodKind + a caller-given `start` into the actual [start, end] calendar
 *  range (§6.2: "For non-custom kinds, `end` is ignored and derived from `start`"). `start` may be
 *  any date inside the period; it is snapped to the period's first day. NOT used for `custom` —
 *  the controller passes the caller's own [start, end] through untouched for that kind. Pure: no
 *  clock, no DB. */
export function resolveCalendarRange(periodKind: CalendarKind, start: string): { start: string; end: string } {
  if (periodKind === "day") return { start, end: start };
  if (periodKind === "week") {
    const s = mondayOnOrBefore(start);
    return { start: s, end: addDaysIso(s, 6) };
  }
  const s = monthAlignedStart(periodKind, start);
  return { start: s, end: monthAlignedEnd(periodKind, s) };
}

/** The comparison baseline (§6.1 header comment): for `custom` it is the immediately preceding
 *  EQUAL-LENGTH window; for a calendar kind it is the immediately preceding period OF THE SAME
 *  KIND (previous day / ISO week / calendar month / quarter / semester / year) REGARDLESS of that
 *  period's own length — which is what makes "comparison deltas correct across month boundaries"
 *  hold (Feb has fewer days than Jan; both sides recompute Sigma-n/Sigma-d over their OWN actual
 *  day count, per §5.4, so an unequal comparison window is correct, not a bug). */
export function previousPeriodRange(
  periodKind: ReportPeriodKind,
  start: string,
  end: string,
  dayCount: number,
): { start: string; end: string; dayCount: number } {
  if (periodKind === "day") {
    const p = addDaysIso(start, -1);
    return { start: p, end: p, dayCount: 1 };
  }
  if (periodKind === "week") {
    return { start: addDaysIso(start, -7), end: addDaysIso(end, -7), dayCount: 7 };
  }
  if (isMonthAligned(periodKind)) {
    // The period that ends the day before this one starts, resolved by the same snap rule.
    const prevEnd = addDaysIso(monthAlignedStart(periodKind, start), -1);
    const prevStart = monthAlignedStart(periodKind, prevEnd);
    return { start: prevStart, end: prevEnd, dayCount: inclusiveDayCount(prevStart, prevEnd) };
  }
  // custom: immediately preceding equal-length window ([start - dayCount, start - 1])
  return { start: addDaysIso(start, -dayCount), end: addDaysIso(start, -1), dayCount };
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(iso: string): string {
  const d = toUtcDate(iso);
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** ISO 8601 week number (Mon-start, week 1 = the week containing the year's first Thursday) —
 *  standard algorithm, used only for the `periodLabel` display string. */
function isoWeekNumber(dateIso: string): { week: number; year: number } {
  const d = toUtcDate(dateIso);
  const target = new Date(d.getTime());
  const dayNr = (d.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return { week, year: target.getUTCFullYear() };
}

/** §6.1's display examples verbatim: "16 Jul 2026" | "Week 29 2026" | "July 2026" | "Q3 2026" |
 *  "Semester 2 2026" | "Year 2026" | "16 Jul 2026 - 3 Aug 2026" (a plain hyphen, to stay ASCII-safe
 *  over JSON). */
export function formatPeriodLabel(periodKind: ReportPeriodKind, start: string, end: string): string {
  if (periodKind === "day") return shortDate(start);
  if (periodKind === "week") {
    const { week, year } = isoWeekNumber(start);
    return `Week ${week} ${year}`;
  }
  const d = toUtcDate(start);
  if (periodKind === "month") {
    return `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  if (periodKind === "quarter") return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
  if (periodKind === "semester") return `Semester ${Math.floor(d.getUTCMonth() / 6) + 1} ${d.getUTCFullYear()}`;
  if (periodKind === "year") return `Year ${d.getUTCFullYear()}`;
  return `${shortDate(start)} - ${shortDate(end)}`;
}

/** Every calendar `period_start` of `kind` whose period overlaps or falls within [from, to] —
 *  pure, no DB. Bounded by construction: the controller caps [from,to] at
 *  `MAX_CUSTOM_RANGE_DAYS` (400) before this ever runs, so day-kind emits at most 400 starts,
 *  week ~57, month ~14, quarter ~6, semester ~3, year ~2. */
export function enumerateCalendarStarts(kind: CalendarKind, from: string, to: string): string[] {
  const starts: string[] = [];
  if (kind === "day") {
    for (let d = from; d <= to; d = addDaysIso(d, 1)) starts.push(d);
    return starts;
  }
  if (kind === "week") {
    for (let s = mondayOnOrBefore(from); s <= to; s = addDaysIso(s, 7)) starts.push(s);
    return starts;
  }
  // month / quarter / semester / year: step from the period start containing `from`
  for (let s = monthAlignedStart(kind, from); s <= to; s = nextMonthAlignedStart(kind, s)) starts.push(s);
  return starts;
}
