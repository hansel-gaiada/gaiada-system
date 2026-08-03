// Calendar layout maths for /calendar. Pure and UTC-only — no I/O, no Date.now() inside the
// functions (callers pass `today`), so every case below is unit-testable and a machine's timezone
// can never shift which cell a task lands in.
//
// Why UTC throughout: task due dates are plain `YYYY-MM-DD` with no time. Parsing those with
// `new Date("2026-08-01")` gives UTC midnight, but reading them back with local getters
// (getDate/getMonth) shifts the day backwards for anyone west of UTC — the classic off-by-one that
// puts a task in the wrong cell. Every function here parses and formats via UTC only.
//
// Not modelled on purpose: hours. Tasks carry a date, never a time, so a 24-hour grid would be
// empty scaffolding. Month and Week are all-day grids (the equivalent of a calendar's all-day row).

export type CalView = "month" | "week" | "day" | "timeline";
export const CAL_VIEWS: CalView[] = ["month", "week", "day", "timeline"];

/** One dated thing on the calendar. Deliberately narrower than PmTask: the cross-company reader
 *  (`/api/tasks/mine`) cannot supply more than this, and the grid must render identically from
 *  either source. `start` is present only when the source knows it (single-company scope). */
export interface CalItem {
  id: string;
  title: string;
  status: string;
  /** Due date, `YYYY-MM-DD`. The cell this item sits in. */
  date: string;
  start?: string | null;
  href: string;
  company?: string;
  projectName?: string;
}

const DAY = 86_400_000;

export function parseView(raw: string | undefined): CalView {
  return CAL_VIEWS.includes(raw as CalView) ? (raw as CalView) : "month";
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The anchor date the view is drawn around. Invalid/absent → today, so a hand-edited URL degrades
 *  to the default rather than rendering an "Invalid Date" grid. */
export function parseAnchor(raw: string | undefined, today: string): string {
  if (!raw || !ISO_RE.test(raw)) return today;
  const t = Date.parse(`${raw}T00:00:00Z`);
  if (Number.isNaN(t)) return today;
  // A NaN check alone is not enough: Date.parse accepts "2026-02-30" and silently rolls it to
  // 2 March, so the anchor string and the grid drawn from it would disagree (the heading says
  // February, the cells are March). Round-tripping rejects any date that does not exist.
  return new Date(t).toISOString().slice(0, 10) === raw ? raw : today;
}

export const toIso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const fromIso = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);
export const addDays = (iso: string, n: number): string => toIso(fromIso(iso) + n * DAY);

/** Monday-start weekday index (0=Mon … 6=Sun). The suite is a work tool; weeks start on Monday. */
export function weekdayIndex(iso: string): number {
  return (new Date(fromIso(iso)).getUTCDay() + 6) % 7;
}

export const startOfWeek = (iso: string): string => addDays(iso, -weekdayIndex(iso));

export function startOfMonth(iso: string): string {
  const d = new Date(fromIso(iso));
  return toIso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function endOfMonth(iso: string): string {
  const d = new Date(fromIso(iso));
  // Day 0 of the NEXT month is the last day of this one — avoids a 28/29/30/31 table entirely,
  // so February and leap years need no special case.
  return toIso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

export const sameMonth = (a: string, b: string): boolean => a.slice(0, 7) === b.slice(0, 7);

/** Weeks (Monday-start rows of 7 ISO dates) covering the whole month, including the leading and
 *  trailing days of adjacent months that share a row — exactly what a month grid renders. */
export function monthGrid(anchor: string): string[][] {
  const first = startOfWeek(startOfMonth(anchor));
  const last = endOfMonth(anchor);
  const weeks: string[][] = [];
  for (let cursor = first; ; ) {
    const week: string[] = [];
    for (let i = 0; i < 7; i++) week.push(addDays(cursor, i));
    weeks.push(week);
    const next = addDays(cursor, 7);
    if (fromIso(week[6]) >= fromIso(last)) break;
    cursor = next;
  }
  return weeks;
}

export function weekDays(anchor: string): string[] {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** Move the anchor by one view-sized step. Month steps by calendar month (not 30 days) and clamps
 *  the day, so stepping from Jan 31 lands on Feb 28/29 instead of skipping into March. */
export function shiftAnchor(anchor: string, view: CalView, delta: number): string {
  if (view === "week") return addDays(anchor, 7 * delta);
  if (view === "day") return addDays(anchor, delta);
  const d = new Date(fromIso(anchor));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + delta;
  const lastOfTarget = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return toIso(Date.UTC(y, m, Math.min(d.getUTCDate(), lastOfTarget)));
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function dayNumber(iso: string): number {
  return new Date(fromIso(iso)).getUTCDate();
}

/** Heading for the current view, e.g. "August 2026", "3 – 9 August 2026", "Monday 3 August 2026". */
export function rangeLabel(anchor: string, view: CalView): string {
  const d = new Date(fromIso(anchor));
  const month = MONTHS[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  if (view === "day") {
    const wd = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getUTCDay()];
    return `${wd} ${d.getUTCDate()} ${month} ${year}`;
  }
  if (view === "week") {
    const days = weekDays(anchor);
    const a = new Date(fromIso(days[0])), b = new Date(fromIso(days[6]));
    const aM = MONTHS[a.getUTCMonth()], bM = MONTHS[b.getUTCMonth()];
    if (a.getUTCFullYear() !== b.getUTCFullYear()) return `${a.getUTCDate()} ${aM} ${a.getUTCFullYear()} – ${b.getUTCDate()} ${bM} ${b.getUTCFullYear()}`;
    if (aM !== bM) return `${a.getUTCDate()} ${aM} – ${b.getUTCDate()} ${bM} ${year}`;
    return `${a.getUTCDate()} – ${b.getUTCDate()} ${bM} ${year}`;
  }
  return `${month} ${year}`;
}

/** Items keyed by their due date. Items with no date never reach here (the page filters them out
 *  and reports the count separately — silently dropping work is how a calendar lies). */
export function groupByDate(items: CalItem[]): Map<string, CalItem[]> {
  const out = new Map<string, CalItem[]>();
  for (const it of items) {
    const arr = out.get(it.date);
    if (arr) arr.push(it);
    else out.set(it.date, [it]);
  }
  return out;
}

export interface CalCounts { total: number; overdue: number; today: number; thisWeek: number }

/** `thisWeek` counts the next 7 days INCLUDING today, and excludes overdue — so the three figures
 *  never double-count the same task. */
export function counts(items: CalItem[], today: string): CalCounts {
  const t = fromIso(today);
  let overdue = 0, todayN = 0, thisWeek = 0;
  for (const it of items) {
    const d = fromIso(it.date);
    const days = Math.round((d - t) / DAY);
    if (days < 0) overdue++;
    else if (days === 0) { todayN++; thisWeek++; }
    else if (days <= 6) thisWeek++;
  }
  return { total: items.length, overdue, today: todayN, thisWeek };
}

export const isOverdue = (iso: string, today: string): boolean => fromIso(iso) < fromIso(today);
