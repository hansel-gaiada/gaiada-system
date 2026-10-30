// SCP-5 W5-A0 — the period and due-date maths the company rules drive (BFF §63.24.1, §63.27.2, §63.30.1). PURE: no I/O, no clock.
//
// Every periodic report kind has a `period` key in its own format and a range of company days; quarters, halves and years follow the
// company's `reports.fiscalYearStartMonth` (SCP-Q39: 1, calendar periods, by default), and a fiscal year is named by the calendar year
// it STARTS in (with April as the first month, `2026-Q1` is April to June 2026 and `2026` is April 2026 to March 2027).
//
//   kind        period        range
//   daily       YYYY-MM-DD    the day
//   weekly      YYYY-Www      ISO week, Monday to Sunday
//   monthly     YYYY-MM       the calendar month (never fiscal)
//   quarterly   YYYY-Qn       three months from the fiscal year's start
//   semester    YYYY-Hn       six months from the fiscal year's start
//   yearly      YYYY          twelve months from the fiscal year's start
//
// THE DUE RULES (a kind's `due`, BFF §63.30.1), on the period's last day `end`:
//   working_days_after n   `addWorkingDays(end, n)`: n = 1 is the first working day after the period; n = 0 is `end` itself.
//   weekday {weekday, week} the ISO weekday (1 Monday .. 7 Sunday) of the week holding `end` ('same') or of the week after ('next').
//   report_due_day         the client's `report_due_day` in the month after `end`, clamped to that month's last day (63.18's rule);
//                          null for a client without one.
//
// THE CYCLE STEP DUE RULES (`cycle.steps[].due`, 63.27.2), for content month M with ready-by R:
//   ready_by {lessEstimatesFrom, lessWorkingDays}  R less the client's estimates of `lessEstimatesFrom` and every estimated step after
//                                                  it (none when null), less `lessWorkingDays`, in working days. R when both are 0.
//   report_due_day {monthOffset}                   the client's `report_due_day` in month M + monthOffset, clamped; null without one.
//   none                                           null.
import { addDays } from "../../hr/working-days";
import {
  STEP_KEYS, addWorkingDays, lastDayOfMonth, type StepEstimates, type StepKey,
} from "./schedule-health";
import type { WorkingCalendar } from "../../hr/working-days";
import type { CycleStepRule, PeriodicKind, ReportDueRule } from "./rules";

export interface DateRange { start: string; end: string }

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
const monthKeyOf = (total: number): string => `${pad(Math.floor(total / 12), 4)}-${pad((total % 12) + 1)}`;
const totalOf = (year: number, month1: number): number => year * 12 + (month1 - 1);

/** True for a real `YYYY-MM-DD` date. */
export function isRealIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** ISO weekday of a date: 1 Monday .. 7 Sunday. */
export function isoWeekday(iso: string): number {
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The Monday of the ISO week holding `iso`. */
export function mondayOf(iso: string): string {
  return addDays(iso, 1 - isoWeekday(iso));
}

/** The ISO week key `YYYY-Www` of a date (the ISO year is the year of the week's Thursday). */
export function isoWeekKey(iso: string): string {
  const thursday = addDays(mondayOf(iso), 3);
  const year = Number(thursday.slice(0, 4));
  const firstThursday = addDays(mondayOf(`${pad(year, 4)}-01-04`), 3);
  const week = Math.round((Date.parse(`${thursday}T00:00:00Z`) - Date.parse(`${firstThursday}T00:00:00Z`)) / (7 * 86_400_000)) + 1;
  return `${pad(year, 4)}-W${pad(week)}`;
}

/**
 * The period of `kind` holding the day `iso`, with the company's fiscal year start (1 to 12). Quarters, halves and years count from
 * that month and are named by the calendar year their fiscal year starts in.
 */
export function periodOf(kind: PeriodicKind, iso: string, fiscalYearStartMonth = 1): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  if (kind === "daily") return iso;
  if (kind === "weekly") return isoWeekKey(iso);
  if (kind === "monthly") return iso.slice(0, 7);
  const offset = (m - fiscalYearStartMonth + 12) % 12;
  const fy = m >= fiscalYearStartMonth ? y : y - 1;
  if (kind === "quarterly") return `${pad(fy, 4)}-Q${Math.floor(offset / 3) + 1}`;
  if (kind === "semester") return `${pad(fy, 4)}-H${Math.floor(offset / 6) + 1}`;
  return pad(fy, 4);
}

/** The range of company days `period` covers, or null when `period` is not a real period of `kind` (a 2026-02-30, a week 53 that year lacks). */
export function periodRange(kind: PeriodicKind, period: string, fiscalYearStartMonth = 1): DateRange | null {
  if (kind === "daily") return isRealIsoDate(period) ? { start: period, end: period } : null;
  if (kind === "weekly") {
    const w = /^(\d{4})-W(\d{2})$/.exec(period);
    if (!w) return null;
    const week = Number(w[2]);
    if (week < 1 || week > 53) return null;
    const start = addDays(mondayOf(`${w[1]}-01-04`), (week - 1) * 7);
    if (isoWeekKey(start) !== period) return null;
    return { start, end: addDays(start, 6) };
  }
  if (kind === "monthly") {
    const mm = /^(\d{4})-(\d{2})$/.exec(period);
    if (!mm || Number(mm[2]) < 1 || Number(mm[2]) > 12) return null;
    return { start: `${period}-01`, end: lastDayOfMonth(period) };
  }
  let year: number;
  let firstMonth: number; // months from the fiscal year's start
  let months: number;
  if (kind === "quarterly") {
    const q = /^(\d{4})-Q([1-4])$/.exec(period);
    if (!q) return null;
    year = Number(q[1]); firstMonth = (Number(q[2]) - 1) * 3; months = 3;
  } else if (kind === "semester") {
    const h = /^(\d{4})-H([12])$/.exec(period);
    if (!h) return null;
    year = Number(h[1]); firstMonth = (Number(h[2]) - 1) * 6; months = 6;
  } else {
    if (!/^\d{4}$/.test(period)) return null;
    year = Number(period); firstMonth = 0; months = 12;
  }
  const start = totalOf(year, fiscalYearStartMonth) + firstMonth;
  return { start: `${monthKeyOf(start)}-01`, end: lastDayOfMonth(monthKeyOf(start + months - 1)) };
}

/** The client's `report_due_day` in `month` (`YYYY-MM`), clamped to the month's last day; null without a day. */
export function dueDayIn(month: string, reportDueDay: number | null): string | null {
  if (reportDueDay === null || !Number.isInteger(reportDueDay) || reportDueDay < 1 || reportDueDay > 31) return null;
  const last = lastDayOfMonth(month);
  return `${month}-${pad(Math.min(reportDueDay, Number(last.slice(8, 10))))}`;
}

/** `YYYY-MM` plus `k` months. */
export function monthPlus(month: string, k: number): string {
  return monthKeyOf(totalOf(Number(month.slice(0, 4)), Number(month.slice(5, 7))) + k);
}

/** The due day of a report whose period is `range`, by its kind's `due` rule (see the header). */
export function reportDueDate(due: ReportDueRule, range: DateRange, ctx: { reportDueDay: number | null; calendar: WorkingCalendar }): string | null {
  if (due.rule === "working_days_after") return addWorkingDays(range.end, due.n, ctx.calendar);
  if (due.rule === "weekday") return addDays(mondayOf(range.end), (due.week === "next" ? 7 : 0) + due.weekday - 1);
  return dueDayIn(monthPlus(range.end.slice(0, 7), 1), ctx.reportDueDay);
}

/** The working days a `ready_by` step sits before R: the estimates from `from` on, plus `extra`. */
export function stepLeadDays(from: StepKey | null, extra: number, estimates: StepEstimates): number {
  let n = Math.max(0, Math.trunc(extra));
  if (from === null) return n;
  const i = (STEP_KEYS as readonly string[]).indexOf(from);
  for (const k of STEP_KEYS.slice(Math.max(0, i))) {
    const v = estimates[k];
    if (typeof v === "number" && Number.isInteger(v) && v > 0) n += v;
  }
  return n;
}

/** A cycle step's due day for content month `month` (`YYYY-MM`) with ready-by `readyBy` (see the header). */
export function cycleStepDueDate(
  step: Pick<CycleStepRule, "due">, month: string,
  ctx: { readyBy: string; estimates: StepEstimates; reportDueDay: number | null; calendar: WorkingCalendar },
): string | null {
  const due = step.due;
  if (due.rule === "none") return null;
  if (due.rule === "report_due_day") return dueDayIn(monthPlus(month, due.monthOffset), ctx.reportDueDay);
  const lead = stepLeadDays(due.lessEstimatesFrom, due.lessWorkingDays, ctx.estimates);
  return lead > 0 ? addWorkingDays(ctx.readyBy, -lead, ctx.calendar) : ctx.readyBy;
}

/** "November 2026" for `2026-11`. */
export function monthName(month: string): string {
  const [y, mo] = month.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** A step's title for content month `month`: `{month}` is M, `{month-1}` to `{month-3}` the months before it. */
export function cycleStepTitle(step: Pick<CycleStepRule, "title">, month: string): string {
  return step.title.replace(/\{month(?:-([1-3]))?\}/g, (_m, k: string | undefined) => monthName(monthPlus(month, k ? -Number(k) : 0)));
}

export interface ReportDuePreview { kind: PeriodicKind; enabled: boolean; period: string; range: DateRange; due: string | null }

/**
 * The next due date of each periodic kind under `reports` (the preview of `POST rules/preview`, and what a schedule's timing reads):
 * of the period before today's and today's, the first whose due day is today or later; today's period, with its due day (null for a
 * `report_due_day` kind without a client's day), when neither is.
 */
export function nextReportDues(
  reports: { fiscalYearStartMonth: number; kinds: Record<PeriodicKind, { enabled: boolean; due: ReportDueRule }> },
  today: string, ctx: { reportDueDay: number | null; calendar: WorkingCalendar },
): ReportDuePreview[] {
  const fy = reports.fiscalYearStartMonth;
  return PERIODIC_KIND_ORDER.map((kind) => {
    const k = reports.kinds[kind];
    const cur = periodOf(kind, today, fy);
    const curRange = periodRange(kind, cur, fy)!;
    const prev = periodOf(kind, addDays(curRange.start, -1), fy);
    const prevRange = periodRange(kind, prev, fy)!;
    const cands = [{ period: prev, range: prevRange }, { period: cur, range: curRange }]
      .map((x) => ({ ...x, due: reportDueDate(k.due, x.range, ctx) }));
    const pick = cands.find((x) => x.due !== null && x.due >= today) ?? cands[1];
    return { kind, enabled: k.enabled, period: pick.period, range: pick.range, due: pick.due };
  });
}

const PERIODIC_KIND_ORDER: readonly PeriodicKind[] = ["daily", "weekly", "monthly", "quarterly", "semester", "yearly"];
