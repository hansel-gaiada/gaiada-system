// SCP-5 W5-A5 (docs/FRONTEND-BFF-CONTRACT.md §63.24.9; owner rulings SCP-Q38, Q39) — report automation's timing: when a schedule runs
// and which period each run drafts. PURE: no I/O, no clock (every "now" is an argument), no config (the zone is an argument).
//
// ── THE TIMING PER KIND (the `timing` column, validated here; 400 `{field}` names the first bad part) ─────────────────────────
//   kind                          timing                                                       runs                                drafts
//   daily                         {at: 'HH:MM'}                                                every day at `at`                  the day before
//   weekly                        {weekday: 1..7 (Monday 1), at}                               that weekday at `at`               the ISO week before
//   monthly                       {on: 'day', day: 1..28, at} | {on: 'working_day', n: 1..20, at}   day N, or the N-th working   the month before
//                                                                                                    day, of each month
//   quarterly, semester, yearly   the monthly's two forms                                      day N, or the N-th working day,    the period that
//                                                                                              of the month after the period ends ended
//   A key another kind uses (a daily's `weekday`), an unknown key, a time that is not 00:00 to 23:59, a day past 28 (every month has it),
//   a working day past 20 (every month has twenty weekdays) or a missing part is refused with that part's field: `timing.at`,
//   `timing.weekday`, `timing.on`, `timing.day`, `timing.n`, or `timing` itself for a timing that is not an object or names a key no kind has.
//
// ── THE CLOCK ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
//   * Every day is a day of the company's zone (`REPORTS_TZ`; UTC while it is unset, as on live). A run's day is a calendar day there and
//     its moment is `at` on that day in that zone (`zonedInstant`), whatever the server's own zone.
//   * DST: a wall time the zone skips (a spring-forward gap) runs at the first moment after the gap, by the gap's length (02:30 in a zone
//     that jumps 02:00 -> 03:00 runs at 03:30); a wall time the zone repeats (an autumn overlap) runs at its FIRST occurrence. So every run
//     day has exactly one run moment.
//   * Working days are the HR holiday calendar's, as schedule-health counts them (weekend days and holidays are not working days; a
//     company with no calendar works Monday to Friday). The N-th working day of a month is the first working day on or after the 1st,
//     then N-1 working days on; with many holidays it may fall in the month after, never before the period has ended.
//   * Periods are the company's (`periodOf`, `periodRange`, with its fiscal year's first month; calendar by default, SCP-Q39).
//
// ── NEXT, DUE AND CATCH-UP ────────────────────────────────────────────────────────────────────────────────────────────────────
//   occurrenceFor(P)     the run day and moment of period P. Strictly after P's last day, so a run never drafts a period still going.
//   nextOccurrence(t)    the first period whose run moment is strictly after t: what a schedule's `next_run_at` and `next_period` are
//                        when it is written, resumed or advanced. Run moments rise with the period, so it is the first of a walk forward.
//   dueAt(P, now)        the job's question for a schedule whose stored next period is P. P's moment is computed AGAIN with today's
//                        calendar: if it is now in the future (a holiday added since), nothing is due and the schedule simply moves to
//                        that moment. Otherwise the run drafts the LATEST period whose moment has passed, once; the periods between P and
//                        it are `missed` (no backlog flood), and the next occurrence is the one after the drafted period.
import { addDays } from "../../hr/working-days";
import type { WorkingCalendar } from "../../hr/working-days";
import { addWorkingDays, firstWorkingDayOnOrAfter } from "./schedule-health";
import { monthPlus, periodOf, periodRange } from "./rules-periods";
import type { PeriodicKind } from "./rules";

export type MonthlyTiming = { on: "day"; day: number; at: string } | { on: "working_day"; n: number; at: string };
export type DailyTiming = { at: string };
export type WeeklyTiming = { weekday: number; at: string };
export type ScheduleTiming = DailyTiming | WeeklyTiming | MonthlyTiming;

/** The timing fields a 400 may name (BFF §63.24.9). */
export const TIMING_FIELDS = ["timing.at", "timing.weekday", "timing.on", "timing.day", "timing.n"] as const;
export type TimingField = (typeof TIMING_FIELDS)[number] | "timing";

export type TimingResult = { ok: true; timing: ScheduleTiming } | { ok: false; field: TimingField };

/** The highest day of the month a `{on: 'day'}` timing takes: every month has it. */
export const MAX_DAY = 28;
/** The highest N of an `{on: 'working_day'}` timing: every month has twenty weekdays. */
export const MAX_WORKING_DAY = 20;

const AT_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/** The keys each kind's timing takes, in the order a 400 checks them. */
function keysFor(kind: PeriodicKind, on: unknown): readonly string[] {
  if (kind === "daily") return ["at"];
  if (kind === "weekly") return ["weekday", "at"];
  if (on === "working_day") return ["on", "n", "at"];
  return ["on", "day", "at"];
}

/** Validate `raw` as `kind`'s timing (see the header). The answer is a fresh object holding only the kind's keys. */
export function parseTiming(kind: PeriodicKind, raw: unknown): TimingResult {
  if (!isObj(raw)) return { ok: false, field: "timing" };
  const allowed = keysFor(kind, raw.on);
  // A key of another kind (or of the other monthly form) names its own field; a key no kind has names `timing`.
  for (const k of Object.keys(raw)) {
    if (allowed.includes(k)) continue;
    const field = `timing.${k}`;
    return { ok: false, field: (TIMING_FIELDS as readonly string[]).includes(field) ? (field as TimingField) : "timing" };
  }
  if (kind === "weekly" && !isInt(raw.weekday, 1, 7)) return { ok: false, field: "timing.weekday" };
  if (kind !== "daily" && kind !== "weekly") {
    if (raw.on !== "day" && raw.on !== "working_day") return { ok: false, field: "timing.on" };
    if (raw.on === "day" && !isInt(raw.day, 1, MAX_DAY)) return { ok: false, field: "timing.day" };
    if (raw.on === "working_day" && !isInt(raw.n, 1, MAX_WORKING_DAY)) return { ok: false, field: "timing.n" };
  }
  if (typeof raw.at !== "string" || !AT_RE.test(raw.at)) return { ok: false, field: "timing.at" };
  const at = raw.at;
  if (kind === "daily") return { ok: true, timing: { at } };
  if (kind === "weekly") return { ok: true, timing: { weekday: raw.weekday as number, at } };
  return raw.on === "day"
    ? { ok: true, timing: { on: "day", day: raw.day as number, at } }
    : { ok: true, timing: { on: "working_day", n: raw.n as number, at } };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The zone
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** The wall clock of instant `ms` in `tz`, as a UTC-anchored epoch of the same fields (so `wall - ms` is the zone's offset). */
function wallOf(ms: number, tz: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(tz).formatToParts(new Date(ms))) if (p.type !== "literal") parts[p.type] = Number(p.value);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour === 24 ? 0 : parts.hour, parts.minute, parts.second);
}

/** The zone's offset (wall minus UTC, in ms) at instant `ms`. */
const offsetAt = (ms: number, tz: string): number => wallOf(Math.floor(ms / 1000) * 1000, tz) - Math.floor(ms / 1000) * 1000;

/** True when `tz` is a zone this runtime knows. */
export function isKnownZone(tz: string): boolean {
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

/** The calendar day (`YYYY-MM-DD`) instant `t` falls on in `tz`. */
export function localDateOf(t: Date, tz: string): string {
  return new Date(wallOf(t.getTime(), tz)).toISOString().slice(0, 10);
}

/**
 * The instant the wall clock of `tz` reads `at` on day `dateIso` (see the header for DST): the first such instant in an overlap, and the
 * moment as far past the gap's start as `at` is, for a time in a gap.
 */
export function zonedInstant(dateIso: string, at: string, tz: string): Date {
  const [h, mi] = at.split(":").map(Number);
  const wall = Date.parse(`${dateIso}T00:00:00Z`) + (h * 60 + mi) * 60_000;
  // The two offsets that can apply around this wall time: the one a day before and the one a day after (no zone changes twice a day).
  const before = offsetAt(wall - 86_400_000, tz);
  const after = offsetAt(wall + 86_400_000, tz);
  const candidates = [...new Set([before, after])].map((o) => wall - o).sort((a, b) => a - b);
  for (const t of candidates) if (wallOf(t, tz) === wall) return new Date(t);
  // A gap: no instant reads `wall`. The offset before the jump puts it as far past the gap's start as `at` is past the gap's start.
  return new Date(wall - before);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Periods and run days
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface TimingContext {
  /** The company's zone (`REPORTS_TZ`, UTC while unset). */
  tz: string;
  /** The company's fiscal year's first month (1, calendar periods, by default). */
  fiscalYearStartMonth: number;
  /** The company's default HR holiday calendar over the days in question (`{}`: Monday to Friday, no holidays). */
  calendar: WorkingCalendar;
}

export interface Occurrence {
  /** The period the run drafts. */
  period: string;
  /** The company day the run falls on. */
  runDay: string;
  /** The moment it runs. */
  runAt: Date;
}

function rangeOf(kind: PeriodicKind, period: string, fy: number) {
  const r = periodRange(kind, period, fy);
  if (!r) throw new Error(`not a ${kind} period: ${JSON.stringify(period)}`);
  return r;
}

/** The period after `period`. */
export function nextPeriodOf(kind: PeriodicKind, period: string, fy = 1): string {
  return periodOf(kind, addDays(rangeOf(kind, period, fy).end, 1), fy);
}

/** The period before `period`. */
export function previousPeriodOf(kind: PeriodicKind, period: string, fy = 1): string {
  return periodOf(kind, addDays(rangeOf(kind, period, fy).start, -1), fy);
}

/** The period that ended last before the company day `today` ("Run now" drafts it). */
export function lastEndedPeriod(kind: PeriodicKind, today: string, fy = 1): string {
  return previousPeriodOf(kind, periodOf(kind, today, fy), fy);
}

/** The N-th working day of `month` (`YYYY-MM`): the first working day on or after the 1st, then N-1 working days on. */
export function nthWorkingDayOfMonth(month: string, n: number, calendar: WorkingCalendar): string {
  return addWorkingDays(firstWorkingDayOnOrAfter(`${month}-01`, calendar), n - 1, calendar);
}

/** The company day period `period` of `kind` runs on, under `timing` (see the header's table). Always after the period's last day. */
export function runDayOf(kind: PeriodicKind, timing: ScheduleTiming, period: string, ctx: Pick<TimingContext, "fiscalYearStartMonth" | "calendar">): string {
  const { end } = rangeOf(kind, period, ctx.fiscalYearStartMonth);
  if (kind === "daily") return addDays(end, 1);
  // A week ends on a Sunday: Monday after it is end + 1, and weekday W is end + W.
  if (kind === "weekly") return addDays(end, (timing as WeeklyTiming).weekday);
  const month = monthPlus(end.slice(0, 7), 1);
  const t = timing as MonthlyTiming;
  return t.on === "day" ? `${month}-${String(t.day).padStart(2, "0")}` : nthWorkingDayOfMonth(month, t.n, ctx.calendar);
}

/** Period `period`'s run: its day and its moment in the company's zone. */
export function occurrenceFor(kind: PeriodicKind, timing: ScheduleTiming, period: string, ctx: TimingContext): Occurrence {
  const runDay = runDayOf(kind, timing, period, ctx);
  return { period, runDay, runAt: zonedInstant(runDay, timing.at, ctx.tz) };
}

/**
 * How far back the walk starts: a run falls at most this many days after its period's last day (a month after the period, twenty working
 * days in, with holidays), so every period starting before `today - LOOKBACK_DAYS` has already run.
 */
const LOOKBACK_DAYS = 120;
/** A walk never takes more steps than this (a daily schedule behind by years is still bounded). */
const MAX_STEPS = 5000;

/** The first occurrence whose moment is strictly after `after` (what `next_run_at` and `next_period` are set to). */
export function nextOccurrence(kind: PeriodicKind, timing: ScheduleTiming, after: Date, ctx: TimingContext): Occurrence {
  const today = localDateOf(after, ctx.tz);
  let period = periodOf(kind, addDays(today, -LOOKBACK_DAYS), ctx.fiscalYearStartMonth);
  for (let i = 0; i < MAX_STEPS; i++) {
    const o = occurrenceFor(kind, timing, period, ctx);
    if (o.runAt.getTime() > after.getTime()) return o;
    period = nextPeriodOf(kind, period, ctx.fiscalYearStartMonth);
  }
  throw new Error(`no ${kind} occurrence found after ${after.toISOString()}`);
}

/** The first occurrence of a period AFTER `period` (the next run once `period` has been drafted). */
export function occurrenceAfterPeriod(kind: PeriodicKind, timing: ScheduleTiming, period: string, ctx: TimingContext): Occurrence {
  return occurrenceFor(kind, timing, nextPeriodOf(kind, period, ctx.fiscalYearStartMonth), ctx);
}

export type DueAnswer =
  /** Nothing to draft yet: the stored period's moment, computed again, is still ahead; the schedule moves to it. */
  | { due: false; next: Occurrence }
  /** Draft `period` now (the latest period whose moment has passed); `missed` periods before it are not drafted; then `next`. */
  | { due: true; period: string; runAt: Date; missed: number; next: Occurrence };

/** The job's question for a schedule whose stored next period is `nextPeriod`, at `now` (see the header's "next, due and catch-up"). */
export function dueAt(kind: PeriodicKind, timing: ScheduleTiming, nextPeriod: string, now: Date, ctx: TimingContext): DueAnswer {
  const first = occurrenceFor(kind, timing, nextPeriod, ctx);
  if (first.runAt.getTime() > now.getTime()) return { due: false, next: first };
  let latest = first;
  let missed = 0;
  for (let i = 0; i < MAX_STEPS; i++) {
    const n = occurrenceAfterPeriod(kind, timing, latest.period, ctx);
    if (n.runAt.getTime() > now.getTime()) return { due: true, period: latest.period, runAt: latest.runAt, missed, next: n };
    latest = n;
    missed += 1;
  }
  throw new Error(`a ${kind} schedule is behind by more than ${MAX_STEPS} periods`);
}

/** The days a schedule's calendar must cover for `nextOccurrence` and `dueAt` around company day `today` (the holiday window). */
export function calendarWindowFor(today: string, behindDays = 0): { from: string; to: string } {
  return { from: addDays(today, -(LOOKBACK_DAYS + 10 + Math.max(0, behindDays))), to: addDays(today, 460) };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Words
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const PERIOD_WORD: Record<PeriodicKind, string> = {
  daily: "day", weekly: "week", monthly: "month", quarterly: "quarter", semester: "half year", yearly: "year",
};

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/** The timing in words, for the card: "Every Monday at 08:00, for the week before". */
export function timingText(kind: PeriodicKind, timing: ScheduleTiming): string {
  const at = timing.at;
  if (kind === "daily") return `Every day at ${at}, for the day before`;
  if (kind === "weekly") return `Every ${WEEKDAYS[(timing as WeeklyTiming).weekday - 1]} at ${at}, for the week before`;
  const t = timing as MonthlyTiming;
  const when = t.on === "day" ? `On day ${t.day}` : `On the ${ordinal(t.n)} working day`;
  if (kind === "monthly") return `${when} of each month at ${at}, for the month before`;
  const word = PERIOD_WORD[kind];
  return `${when} of the month after each ${word} at ${at}, for the ${word} that ended`;
}
