// The Overview's "My activity" block, as pure rules (DW-3j, docs/plans/2026-10-13-department-workspaces.md
// §14.5): which days to read, which of them the heatmap draws, and today's counts by kind. No React and no
// server imports, so the block stays thin and every rule here is a plain unit test.
//
// What is drawn is the person's own PM activity series (`GET /pm/productivity`, self is always allowed). Its
// `score` is always null and is never read here: a person's activity is counted, not rated (DW-D19), so a day's
// total is only a shade and a tooltip.
import type { ProductivityDayPoint, ProductivityReport } from "@/lib/pm";
import { addDaysIso } from "@/lib/checkins";
import { isoWeekday, levelFor, type HeatLevel } from "@/components/pm/activityHeatmap";

/** Full weeks the heatmap shows before the current one. */
export const ACTIVITY_WEEKS = 16;

/** The Monday of the week `iso` falls in. */
export function weekStart(iso: string): string {
  return addDaysIso(iso, -isoWeekday(iso));
}

/** The first day drawn: the Monday 16 whole weeks before the current week's. The current week follows, up to today. */
export function activityWindowStart(today: string): string {
  return addDaysIso(weekStart(today), -ACTIVITY_WEEKS * 7);
}

/** The `from` to send: a week earlier than the window needs, so a server whose "today" is a day either side of
 *  ours still returns every day drawn. `to` is left out, so the server decides what today is. */
export function activityRequestFrom(today: string): string {
  return addDaysIso(activityWindowStart(today), -7);
}

export interface ActivityCell {
  date: string;
  total: number;
  level: HeatLevel;
  /** The cell's tooltip: "3 things on 13 Oct 2026" (a count, never a rating). */
  title: string;
}

export interface TodayCount {
  key: "completedTasks" | "tasksAccepted" | "comments" | "notesContributions" | "reactionsGiven";
  label: string;
  value: number;
}

const KINDS: readonly { key: TodayCount["key"]; label: string }[] = [
  { key: "completedTasks", label: "Tasks completed" },
  { key: "tasksAccepted", label: "Tasks accepted" },
  { key: "comments", label: "Comments" },
  { key: "notesContributions", label: "Notes" },
  { key: "reactionsGiven", label: "Reactions given" },
];

export const NOTHING_TODAY = "Nothing recorded yet today";
export const COUNTS_NOTE = "Counts project-management work for now";

/** Today's counts by kind, zero kinds dropped. Empty when nothing was recorded. */
export function todayCounts(point: ProductivityDayPoint | null): TodayCount[] {
  if (!point) return [];
  return KINDS.map((k) => ({ ...k, value: point[k.key] })).filter((c) => c.value > 0);
}

export interface MyActivity {
  /** The drawn days padded with leading blanks to their weekday row, Monday-first; null is a blank. */
  cells: (ActivityCell | null)[];
  weekCount: number;
  /** The window's first and last day, for the grid's label. Null when the series held no day in it. */
  from: string | null;
  to: string | null;
  /** The last day of the series (the server's today); null when there was none, so nothing is claimed about today. */
  today: string | null;
  counts: TodayCount[];
}

const things = (n: number) => `${n} thing${n === 1 ? "" : "s"}`;

/** Trims the server's series to the window and draws it. The last point of the series is today: the server
 *  ends it on its own today, in its own reports time zone, and this never second-guesses that. */
export function buildMyActivity(report: ProductivityReport, fmtDate: (iso: string) => string): MyActivity {
  const sorted = [...report.series].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const last = sorted.length > 0 ? sorted[sorted.length - 1] : null;
  if (!last) return { cells: [], weekCount: 0, from: null, to: null, today: null, counts: [] };

  const start = activityWindowStart(last.date);
  const days = sorted.filter((d) => d.date >= start);
  const max = Math.max(0, ...days.map((d) => d.total));
  const cells: ActivityCell[] = days.map((d) => ({
    date: d.date, total: d.total, level: levelFor(d.total, max), title: `${things(d.total)} on ${fmtDate(d.date)}`,
  }));
  const padded: (ActivityCell | null)[] = [...Array<null>(isoWeekday(days[0].date)).fill(null), ...cells];
  return {
    cells: padded, weekCount: Math.ceil(padded.length / 7), from: days[0].date, to: last.date, today: last.date, counts: todayCounts(last),
  };
}
