// DW-4a — the demo backend's calendar math for report periods: day, ISO week, month, quarter,
// semester and year. A pure mirror of platform-nest/src/modules/reports/report-calendar.ts (the one
// real resolver, tracker-reporting-foundation.md §15 "2026-10-13 (DW-4a, contract first)"); it is
// NOT used by the real pages, only by demoReports.ts and demoCheckins.ts. Both sides pin the same
// golden table (demoReports.test.ts <-> report-calendar.test.ts), so a change here must be made
// there too. No "server-only", no clock, no DOM: safe to import from tests.
import type { ReportPeriodKind } from "./reports";

export type CalendarKind = Exclude<ReportPeriodKind, "custom">;

export const CALENDAR_KINDS: readonly CalendarKind[] = ["day", "week", "month", "quarter", "semester", "year"];

export function isCalendarKind(x: unknown): x is CalendarKind {
  return typeof x === "string" && (CALENDAR_KINDS as readonly string[]).includes(x);
}

const MONTHS_PER_PERIOD = { month: 1, quarter: 3, semester: 6, year: 12 } as const;
type MonthAlignedKind = keyof typeof MONTHS_PER_PERIOD;

function isMonthAligned(kind: string): kind is MonthAlignedKind {
  return kind === "month" || kind === "quarter" || kind === "semester" || kind === "year";
}

const DAY_MS = 86_400_000;

function toUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}
function fromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(iso: string, n: number): string {
  return fromUtc(new Date(toUtc(iso).getTime() + n * DAY_MS));
}
function inclusiveDays(from: string, to: string): number {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / DAY_MS) + 1;
}

/** Monday on or before `iso` (ISO week). */
export function mondayOnOrBefore(iso: string): string {
  const d = toUtc(iso);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return fromUtc(d);
}

function monthAlignedStart(kind: MonthAlignedKind, iso: string): string {
  const d = toUtc(iso);
  const span = MONTHS_PER_PERIOD[kind];
  return fromUtc(new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / span) * span, 1)));
}

function monthAlignedEnd(kind: MonthAlignedKind, startIso: string): string {
  const d = toUtc(startIso);
  return fromUtc(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + MONTHS_PER_PERIOD[kind], 0)));
}

/** `start` may be any date inside the period; it is snapped to the period's first day and `end`
 *  is derived (§6.2: "for non-custom kinds, `end` is ignored and derived from `start`"). */
export function resolveCalendarRange(kind: CalendarKind, start: string): { start: string; end: string } {
  if (kind === "day") return { start, end: start };
  if (kind === "week") {
    const s = mondayOnOrBefore(start);
    return { start: s, end: addDays(s, 6) };
  }
  const s = monthAlignedStart(kind, start);
  return { start: s, end: monthAlignedEnd(kind, s) };
}

/** The comparison baseline: a calendar kind compares to the preceding period of the same kind over
 *  its own day count; `custom` to the equal-length window right before it. */
export function previousPeriodRange(
  kind: ReportPeriodKind,
  start: string,
  end: string,
  dayCount: number,
): { start: string; end: string; dayCount: number } {
  if (kind === "day") {
    const p = addDays(start, -1);
    return { start: p, end: p, dayCount: 1 };
  }
  if (kind === "week") return { start: addDays(start, -7), end: addDays(end, -7), dayCount: 7 };
  if (isMonthAligned(kind)) {
    const prevEnd = addDays(monthAlignedStart(kind, start), -1);
    const prevStart = monthAlignedStart(kind, prevEnd);
    return { start: prevStart, end: prevEnd, dayCount: inclusiveDays(prevStart, prevEnd) };
  }
  return { start: addDays(start, -dayCount), end: addDays(start, -1), dayCount };
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function shortDate(iso: string): string {
  const d = toUtc(iso);
  return `${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** ISO 8601 week number (Mon-start, week 1 = the week containing the year's first Thursday). */
function isoWeek(iso: string): { week: number; year: number } {
  const d = toUtc(iso);
  const target = new Date(d.getTime());
  target.setUTCDate(target.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  return { week: 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * DAY_MS)), year: target.getUTCFullYear() };
}

/** "14 Oct 2026" | "Week 42 2026" | "February 2026" | "Q3 2026" | "Semester 2 2026" | "Year 2026" |
 *  custom "16 Jul 2026 - 3 Aug 2026" (plain hyphen, same as the backend). */
export function formatPeriodLabel(kind: ReportPeriodKind, start: string, end: string): string {
  if (kind === "day") return shortDate(start);
  if (kind === "week") {
    const { week, year } = isoWeek(start);
    return `Week ${week} ${year}`;
  }
  const d = toUtc(start);
  if (kind === "month") return `${MONTH_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (kind === "quarter") return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
  if (kind === "semester") return `Semester ${Math.floor(d.getUTCMonth() / 6) + 1} ${d.getUTCFullYear()}`;
  if (kind === "year") return `Year ${d.getUTCFullYear()}`;
  return `${shortDate(start)} - ${shortDate(end)}`;
}
