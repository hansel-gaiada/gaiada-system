// The Overview's "My activity" block, as pure rules (DW-3j, then DW-4h-3, docs/plans/2026-10-13-department-workspaces.md
// §14.5): which days the heatmap draws, and today's counts by kind. No React and no server imports, so the block stays thin
// and every rule here is a plain unit test.
//
// What is drawn is the person's own all-work activity series (`GET /activity/series`, BFF section 44.3, self is always
// allowed): every module's work, by kind. The kinds, their labels and their order are the SERVER's, never listed here, and
// the window ends on the server's own `to` (today in its reports time zone), never on a UTC "today" of this machine. A
// person's activity is counted, not rated (DW-D19): a day's total is only a shade and a "things done" count.
import { addDaysIso } from "@/lib/checkins";
import {
  buildYearMap, countsByKind, weekStartOf, type ActivityDayCounts, type ActivityKind, type ActivitySeries, type YearCell,
} from "@/lib/activitySeriesFormat";

/** Full weeks the heatmap shows before the current one. */
export const ACTIVITY_WEEKS = 16;

/** The Monday of the week `iso` falls in. */
export const weekStart = weekStartOf;

/** The first day drawn: the Monday 16 whole weeks before the current week's. The current week follows, up to the server's today. */
export function activityWindowStart(today: string): string {
  return addDaysIso(weekStart(today), -ACTIVITY_WEEKS * 7);
}

export interface TodayCount {
  key: string;
  label: string;
  value: number;
}

export const NOTHING_TODAY = "Nothing recorded yet today";

/** Today's counts by kind, in the server's kind order, zero kinds dropped. Empty when nothing was recorded. */
export function todayCounts(day: ActivityDayCounts | null, kinds: readonly ActivityKind[]): TodayCount[] {
  if (!day) return [];
  return countsByKind(day.counts, kinds).map((c) => ({ key: c.key, label: c.label, value: c.n }));
}

export interface MyActivity {
  /** The drawn days padded with leading blanks to their weekday row, Monday-first; null is a blank. */
  cells: (YearCell | null)[];
  weekCount: number;
  /** The window's first and last day, for the grid's label. Null when the series held no day in it. */
  from: string | null;
  to: string | null;
  /** The server's today (the series' `to`); null when the series did not include it, so nothing is claimed about today. */
  today: string | null;
  counts: TodayCount[];
}

/** Trims the server's series to the window and draws it. The window ends on the series' own `to`: the server says what today
 *  is, in its own reports time zone, and this never second-guesses that. */
export function buildMyActivity(series: ActivitySeries, fmtDate: (iso: string) => string): MyActivity {
  const start = activityWindowStart(series.to);
  const days = series.days.filter((d) => d.date >= start && d.date <= series.to);
  if (days.length === 0) return { cells: [], weekCount: 0, from: null, to: null, today: null, counts: [] };
  const map = buildYearMap(days, series.kinds, fmtDate);
  const today = days.find((d) => d.date === series.to) ?? null;
  return {
    cells: map.cells,
    weekCount: map.weekCount,
    from: map.from,
    to: map.to,
    today: today ? today.date : null,
    counts: todayCounts(today, series.kinds),
  };
}
