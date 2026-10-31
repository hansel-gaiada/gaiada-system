// SCP-5 W5-A6 (BFF §63.24.9) — report automation's types and pure helpers. No server-only import, so a client component may import the values.
//
// A schedule says which of the ERP's periodic reports are drafted by themselves: a kind, the clients, when, and on or off. Each run drafts the period that has just ended through
// 63.24.5's machinery; it only drafts (approving, sending back and sending stay the four's own acts). The routes are the server's (`report-schedules.ts`): this file parses what they answer,
// builds what they take, and words what they refuse. The server decides every write; the checks here only put a mistake next to its field before the round trip.
//
// WHAT IS NOT HERE, ON PURPOSE. The server's schedule body has no "AI drafting" switch: whether a kind is drafted by AI is the company's report rule (63.30), and a schedule whose kind is
// turned off or drafted by hand pauses itself (`kind_off`, `ai_drafting_off`). So the dialog says that in words and offers no switch. Nor is there a spend cap (SCP-Q40): spend is tracked.
import { REFUSAL_WORDS, type Refusal } from "./socialPipeline";
import { PLAN_REFUSAL_REASON } from "./socialCycles";

export const SCHEDULE_KINDS = ["daily", "weekly", "monthly", "quarterly", "semester", "yearly"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];
export const KIND_LABEL: Readonly<Record<ScheduleKind, string>> = {
  daily: "Daily", weekly: "Weekly", monthly: "Monthly", quarterly: "Quarterly", semester: "Half-year", yearly: "Yearly",
};
/** What one run of each kind drafts, for the dialog's hint and the run-now confirm. */
const PERIOD_WORD: Readonly<Record<ScheduleKind, string>> = { daily: "day", weekly: "week", monthly: "month", quarterly: "quarter", semester: "half year", yearly: "year" };
export const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
/** The server's bounds (`MAX_DAY`, `MAX_WORKING_DAY`, `MAX_CHOSEN_CLIENTS`). */
export const MAX_DAY = 28;
export const MAX_WORKING_DAY = 20;
export const MAX_CHOSEN_CLIENTS = 200;

export type PausedReason = "manual" | "owner_not_allowed" | "owner_inactive" | "kind_off" | "ai_drafting_off";
export interface Timing { at: string; weekday?: number; on?: "day" | "working_day"; day?: number; n?: number }
export interface Spend { runs: number; calls: number; promptTokens: number; completionTokens: number; costUsd: number | null }
export interface LastRun { runId: string; status: string; created: number; existing: number; skipped: number; failed: number; missed: number }
export interface ReportSchedule {
  id: string;
  kind: ScheduleKind;
  scope: "all" | "chosen";
  clients: Array<{ engagementId: string; clientName: string }>;
  timing: Timing;
  timingText: string;
  enabled: boolean;
  pausedReason: PausedReason | null;
  owner: { id: string; name: string | null };
  nextRunAt: string | null;
  nextPeriod: string | null;
  lastRunAt: string | null;
  lastPeriod: string | null;
  lastRun: LastRun | null;
  spend: { last30Days: Spend; monthToDate: Spend };
}

// ── Parsing ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const REASONS: readonly string[] = ["manual", "owner_not_allowed", "owner_inactive", "kind_off", "ai_drafting_off"];

function asSpend(raw: unknown): Spend {
  const o = isObj(raw) ? raw : {};
  return { runs: num(o.runs), calls: num(o.calls), promptTokens: num(o.promptTokens), completionTokens: num(o.completionTokens), costUsd: typeof o.costUsd === "number" ? o.costUsd : null };
}

function asTiming(raw: unknown): Timing {
  const o = isObj(raw) ? raw : {};
  return {
    at: str(o.at) ?? "", ...(typeof o.weekday === "number" ? { weekday: o.weekday } : {}),
    ...(o.on === "day" || o.on === "working_day" ? { on: o.on } : {}), ...(typeof o.day === "number" ? { day: o.day } : {}), ...(typeof o.n === "number" ? { n: o.n } : {}),
  };
}

/** One schedule of the read. Throws on a body that is not one, so the page says "cannot tell" instead of drawing a plausible card. */
export function asSchedule(raw: unknown): ReportSchedule {
  if (!isObj(raw) || typeof raw.id !== "string" || !(SCHEDULE_KINDS as readonly string[]).includes(raw.kind as string) || typeof raw.enabled !== "boolean") throw new Error("report schedule: not a schedule");
  const o = isObj(raw.owner) ? raw.owner : {};
  const lr = isObj(raw.lastRun) && typeof raw.lastRun.runId === "string" ? raw.lastRun : null;
  const sp = isObj(raw.spend) ? raw.spend : {};
  return {
    id: raw.id, kind: raw.kind as ScheduleKind, scope: raw.scope === "chosen" ? "chosen" : "all",
    clients: Array.isArray(raw.clients)
      ? raw.clients.filter(isObj).filter((c) => typeof c.engagementId === "string").map((c) => ({ engagementId: c.engagementId as string, clientName: str(c.clientName) ?? "" }))
      : [],
    timing: asTiming(raw.timing), timingText: str(raw.timingText) ?? "", enabled: raw.enabled,
    pausedReason: typeof raw.pausedReason === "string" && REASONS.includes(raw.pausedReason) ? (raw.pausedReason as PausedReason) : (raw.enabled ? null : "manual"),
    owner: { id: str(o.id) ?? "", name: str(o.name) },
    nextRunAt: str(raw.nextRunAt), nextPeriod: str(raw.nextPeriod), lastRunAt: str(raw.lastRunAt), lastPeriod: str(raw.lastPeriod),
    lastRun: lr
      ? { runId: lr.runId as string, status: str(lr.status) ?? "", created: num(lr.created), existing: num(lr.existing), skipped: num(lr.skipped), failed: num(lr.failed), missed: num(lr.missed) }
      : null,
    spend: { last30Days: asSpend(sp.last30Days), monthToDate: asSpend(sp.monthToDate) },
  };
}

/** `GET report-schedules`. */
export function asSchedules(raw: unknown): ReportSchedule[] {
  if (!isObj(raw) || !Array.isArray(raw.items)) throw new Error("report schedules: not a list");
  return raw.items.map(asSchedule);
}

/** `POST report-schedules` answers `{schedule, created}`. */
export function asSaved(raw: unknown): { schedule: ReportSchedule; created: boolean } {
  if (!isObj(raw)) throw new Error("report schedule: not an answer");
  return { schedule: asSchedule(raw.schedule), created: raw.created !== false };
}

/** What "Run now" answers: a started run (202), or the period had already been run by this schedule (200 `alreadyApplied`). */
export type RunNowAnswer =
  | { started: true; runId: string; kind: string; period: string; total: number }
  | { started: false; runId: string | null; period: string };

export function asRunNow(raw: unknown): RunNowAnswer {
  if (!isObj(raw)) throw new Error("report schedule run: not an answer");
  if (raw.alreadyApplied === true) return { started: false, runId: str(raw.runId), period: str(raw.period) ?? "" };
  if (typeof raw.runId !== "string") throw new Error("report schedule run: no run id");
  return { started: true, runId: raw.runId, kind: str(raw.kind) ?? "", period: str(raw.period) ?? "", total: num(raw.total) };
}

export interface RunProgress { runId: string; kind: string; period: string; status: string; total: number; done: number; usage: { calls: number; promptTokens: number; completionTokens: number; costUsd: number | null } }

/** `GET reports/generate/:runId` (63.24.5): a run's progress and its usage. */
export function asRunProgress(raw: unknown): RunProgress {
  if (!isObj(raw) || typeof raw.runId !== "string") throw new Error("report run: not a run");
  const u = isObj(raw.usage) ? raw.usage : {};
  return {
    runId: raw.runId, kind: str(raw.kind) ?? "", period: str(raw.period) ?? "", status: str(raw.status) ?? "", total: num(raw.total), done: num(raw.done),
    usage: { calls: num(u.calls), promptTokens: num(u.promptTokens), completionTokens: num(u.completionTokens), costUsd: typeof u.costUsd === "number" ? u.costUsd : null },
  };
}

// ── Dates (company days, calendar periods: SCP-Q39) ─────────────────────────────────────────────────────────────────────────

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number): string => String(n).padStart(2, "0");
const utc = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
const isoOf = (d: Date): string => d.toISOString().slice(0, 10);
export const addDays = (iso: string, n: number): string => { const d = utc(iso); d.setUTCDate(d.getUTCDate() + n); return isoOf(d); };
const dowOf = (iso: string): number => ((utc(iso).getUTCDay() + 6) % 7) + 1; // Monday 1 .. Sunday 7
const mondayOf = (iso: string): string => addDays(iso, 1 - dowOf(iso));
const lastDayOfMonth = (ym: string): string => { const [y, m] = ym.split("-").map(Number); return isoOf(new Date(Date.UTC(y, m, 0))); };
const monthPlus = (ym: string, n: number): string => { const [y, m] = ym.split("-").map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`; };

function isoWeekKey(iso: string): string {
  const thursday = addDays(mondayOf(iso), 3);
  const year = Number(thursday.slice(0, 4));
  const week = Math.floor((Math.round((utc(thursday).getTime() - utc(`${year}-01-01`).getTime()) / 86_400_000)) / 7) + 1;
  return `${year}-W${pad(week)}`;
}

/** The period of `kind` that day `iso` falls in. */
export function periodOf(kind: ScheduleKind, iso: string): string {
  const ym = iso.slice(0, 7);
  const m = Number(iso.slice(5, 7));
  switch (kind) {
    case "daily": return iso;
    case "weekly": return isoWeekKey(iso);
    case "monthly": return ym;
    case "quarterly": return `${iso.slice(0, 4)}-Q${Math.ceil(m / 3)}`;
    case "semester": return `${iso.slice(0, 4)}-H${m <= 6 ? 1 : 2}`;
    case "yearly": return iso.slice(0, 4);
  }
}

/** The first and last day of a period, or null for a string that is not a period of `kind`. */
export function periodRange(kind: ScheduleKind, period: string): { start: string; end: string } | null {
  if (kind === "daily") return /^\d{4}-\d{2}-\d{2}$/.test(period) && isoOf(utc(period)) === period ? { start: period, end: period } : null;
  if (kind === "weekly") {
    const w = /^(\d{4})-W(\d{2})$/.exec(period);
    if (!w) return null;
    const start = addDays(mondayOf(`${w[1]}-01-04`), (Number(w[2]) - 1) * 7);
    return isoWeekKey(start) === period ? { start, end: addDays(start, 6) } : null;
  }
  if (kind === "monthly") return /^\d{4}-(0[1-9]|1[0-2])$/.test(period) ? { start: `${period}-01`, end: lastDayOfMonth(period) } : null;
  const re = kind === "quarterly" ? /^(\d{4})-Q([1-4])$/ : kind === "semester" ? /^(\d{4})-H([12])$/ : /^(\d{4})$/;
  const x = re.exec(period);
  if (!x) return null;
  const months = kind === "quarterly" ? 3 : kind === "semester" ? 6 : 12;
  const first = kind === "yearly" ? 0 : (Number(x[2]) - 1) * months;
  const startYm = `${x[1]}-${pad(first + 1)}`;
  return { start: `${startYm}-01`, end: lastDayOfMonth(monthPlus(startYm, months - 1)) };
}

const dayWords = (iso: string, withYear = false): string => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}${withYear ? ` ${iso.slice(0, 4)}` : ""}`;

/** A period in words: "week of 9 to 15 November 2026", "October 2026", "the third quarter of 2026"; the raw string when it is not a period of `kind`. */
export function periodWords(kind: ScheduleKind, period: string | null): string {
  if (!period) return "";
  const r = periodRange(kind, period);
  if (!r) return period;
  const year = r.end.slice(0, 4);
  switch (kind) {
    case "daily": return dayWords(period, true);
    case "weekly": return r.start.slice(5, 7) === r.end.slice(5, 7) ? `the week of ${Number(r.start.slice(8))} to ${dayWords(r.end, true)}` : `the week of ${dayWords(r.start)} to ${dayWords(r.end, true)}`;
    case "monthly": return `${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;
    case "quarterly": return `the ${["first", "second", "third", "fourth"][Number(period.slice(-1)) - 1]} quarter of ${year}`;
    case "semester": return `the ${period.endsWith("H1") ? "first" : "second"} half of ${year}`;
    case "yearly": return period;
  }
}

/** The period "Run now" drafts: the one that ended before `today` (calendar periods; the server uses the company's own day). */
export const lastEndedPeriod = (kind: ScheduleKind, today: string): string => {
  const r = periodRange(kind, periodOf(kind, today));
  return periodOf(kind, addDays(r ? r.start : today, -1));
};

/** "Monday 16 November, 08:00" (this year) or with the year. `runDay` is a company day. */
function runDayWords(runDay: string, at: string, thisYear: string): string {
  return `${WEEKDAY_NAMES[dowOf(runDay) - 1]} ${dayWords(runDay, runDay.slice(0, 4) !== thisYear)} at ${at}`;
}

// ── The timing in words and the preview ─────────────────────────────────────────────────────────────────────────────────────

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/** The timing in words, as the server words it for the card ("Every Monday at 08:00, for the week before"). */
export function timingWords(kind: ScheduleKind, t: Timing): string {
  if (kind === "daily") return `Every day at ${t.at}, for the day before`;
  if (kind === "weekly") return `Every ${WEEKDAY_NAMES[(t.weekday ?? 1) - 1]} at ${t.at}, for the week before`;
  const when = t.on === "day" ? `On day ${t.day}` : `On the ${ordinal(t.n ?? 1)} working day`;
  if (kind === "monthly") return `${when} of each month at ${t.at}, for the month before`;
  const word = PERIOD_WORD[kind];
  return `${when} of the month after each ${word} at ${t.at}, for the ${word} that ended`;
}

const isWorkingDay = (iso: string): boolean => dowOf(iso) <= 5;
function nthWorkingDay(ym: string, n: number): string {
  let d = `${ym}-01`;
  while (!isWorkingDay(d)) d = addDays(d, 1);
  for (let left = n - 1; left > 0; left--) { d = addDays(d, 1); while (!isWorkingDay(d)) d = addDays(d, 1); }
  return d;
}

/** The company day a period runs on (the server's `runDayOf`, with Monday to Friday as the working days). Always after the period's last day. */
function runDayOf(kind: ScheduleKind, t: Timing, period: string): string {
  const end = (periodRange(kind, period) as { end: string }).end;
  if (kind === "daily") return addDays(end, 1);
  if (kind === "weekly") return addDays(end, t.weekday ?? 1);
  const ym = monthPlus(end.slice(0, 7), 1);
  return t.on === "day" ? `${ym}-${pad(t.day ?? 1)}` : nthWorkingDay(ym, t.n ?? 1);
}

export interface PreviewRun { period: string; runDay: string; at: string; text: string; drafts: string }

/**
 * "Next runs": the next `count` runs after `now`, worked out HERE the way the server does (`nextOccurrence`): walk the periods forward from a period that has surely run, and
 * keep the first whose moment is still ahead. There is no preview route, so this is the computed one. It reads days in UTC and takes Monday to Friday as the working days, which is
 * the server's own answer for a company with no holiday calendar and the zone unset (as on live); with a calendar or a zone the server's day may differ, and the card shows the server's own
 * `nextRunAt` once the schedule is saved. Null when the timing is not complete.
 */
export function previewRuns(kind: ScheduleKind, t: Timing | null, nowMs: number, count = 3): PreviewRun[] | null {
  if (!t || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t.at)) return null;
  const now = new Date(nowMs);
  const today = isoOf(now);
  const thisYear = today.slice(0, 4);
  const out: PreviewRun[] = [];
  let period = periodOf(kind, addDays(today, -120));
  for (let i = 0; i < 5000 && out.length < count; i++) {
    const runDay = runDayOf(kind, t, period);
    const [h, m] = t.at.split(":").map(Number);
    const moment = utc(runDay).getTime() + (h * 60 + m) * 60_000;
    if (moment > nowMs) out.push({ period, runDay, at: t.at, text: runDayWords(runDay, t.at, thisYear), drafts: periodWords(kind, period) });
    const r = periodRange(kind, period) as { end: string };
    period = periodOf(kind, addDays(r.end, 1));
  }
  return out;
}

// ── The form ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ScheduleForm {
  kind: ScheduleKind;
  scope: "all" | "chosen";
  engagementIds: string[];
  weekday: string;
  monthlyOn: "day" | "working_day";
  day: string;
  n: string;
  at: string;
  /** Create only: whether it starts on. Pausing and resuming an existing schedule are their own buttons. */
  enabled: boolean;
}

export const emptyForm = (): ScheduleForm => ({ kind: "weekly", scope: "all", engagementIds: [], weekday: "1", monthlyOn: "working_day", day: "1", n: "3", at: "08:00", enabled: true });

export const formOf = (s: ReportSchedule): ScheduleForm => ({
  kind: s.kind, scope: s.scope, engagementIds: s.clients.map((c) => c.engagementId),
  weekday: String(s.timing.weekday ?? 1), monthlyOn: s.timing.on === "day" ? "day" : "working_day", day: String(s.timing.day ?? 1), n: String(s.timing.n ?? 3), at: s.timing.at || "08:00", enabled: true,
});

const isInt = (text: string, lo: number, hi: number): boolean => /^\d{1,3}$/.test(text.trim()) && Number(text) >= lo && Number(text) <= hi;

/** The kind's timing as the server takes it, or the first part that is wrong (named as the server names it). */
export function timingOfForm(f: ScheduleForm): { ok: true; timing: Timing } | { ok: false; field: string; message: string } {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(f.at)) return { ok: false, field: "timing.at", message: "Choose a time of day, from 00:00 to 23:59." };
  if (f.kind === "daily") return { ok: true, timing: { at: f.at } };
  if (f.kind === "weekly") {
    return isInt(f.weekday, 1, 7) ? { ok: true, timing: { weekday: Number(f.weekday), at: f.at } } : { ok: false, field: "timing.weekday", message: "Choose the day of the week." };
  }
  if (f.monthlyOn === "day") {
    return isInt(f.day, 1, MAX_DAY)
      ? { ok: true, timing: { on: "day", day: Number(f.day), at: f.at } }
      : { ok: false, field: "timing.day", message: `Enter a day of the month from 1 to ${MAX_DAY} (every month has those).` };
  }
  return isInt(f.n, 1, MAX_WORKING_DAY)
    ? { ok: true, timing: { on: "working_day", n: Number(f.n), at: f.at } }
    : { ok: false, field: "timing.n", message: `Enter which working day, from 1 to ${MAX_WORKING_DAY} (every month has twenty).` };
}

const sameTiming = (a: Timing, b: Timing): boolean => a.at === b.at && a.weekday === b.weekday && a.on === b.on && a.day === b.day && a.n === b.n;
const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join() === [...b].sort().join();

export type BuiltBody = { ok: true; body: Record<string, unknown> } | { ok: false; field: string; message: string };

/**
 * The body of a create (`id` is the click's fresh uuid, so a replay is the same schedule) or, with `original`, of an edit: only what changed (scope, clients, timing); the kind cannot be
 * changed, so an edit never sends it. Nothing changed answers `{ok: true, body: {}}` and the dialog just closes.
 */
export function buildBody(f: ScheduleForm, o: { id: string } | { original: ReportSchedule }): BuiltBody {
  if (f.scope === "chosen" && f.engagementIds.length === 0) return { ok: false, field: "engagementIds", message: "Choose at least one client, or switch to all clients." };
  if (f.scope === "chosen" && f.engagementIds.length > MAX_CHOSEN_CLIENTS) return { ok: false, field: "engagementIds", message: `Choose at most ${MAX_CHOSEN_CLIENTS} clients.` };
  const t = timingOfForm(f);
  if (!t.ok) return t;
  const clients = f.scope === "chosen" ? { engagementIds: f.engagementIds } : {};
  if ("id" in o) return { ok: true, body: { id: o.id, kind: f.kind, scope: f.scope, ...clients, timing: t.timing, enabled: f.enabled } };
  const s = o.original;
  const body: Record<string, unknown> = {};
  const scopeChanged = f.scope !== s.scope;
  if (scopeChanged) body.scope = f.scope;
  if (f.scope === "chosen" && (scopeChanged || !sameIds(f.engagementIds, s.clients.map((c) => c.engagementId)))) { body.scope = "chosen"; body.engagementIds = f.engagementIds; }
  if (!sameTiming(t.timing, s.timing)) body.timing = t.timing;
  return { ok: true, body };
}

// ── What the card says ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A paused schedule's reason, in words ("Paused: its owner may no longer run it"). Said in text, never by colour alone. */
export function pausedWords(reason: PausedReason | null): string {
  switch (reason) {
    case "manual": return "Paused by a person";
    case "owner_not_allowed": return "Paused: its owner may no longer run it";
    case "owner_inactive": return "Paused: its owner is no longer an active user";
    case "kind_off": return "Paused: the company turned this report kind off";
    case "ai_drafting_off": return "Paused: this report kind is drafted by hand";
    default: return "Paused";
  }
}

/** A cost in US dollars: four decimals under a dollar, two above. */
export const formatUsd = (n: number): string => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** A spend over a window, plainly: "3 runs, 36 AI calls, 54,000 tokens, cost $0.2400"; the cost reads "not recorded" while no call has one. */
export function spendWords(s: Spend): string {
  if (s.runs === 0 && s.calls === 0) return "No runs";
  const tokens = s.promptTokens + s.completionTokens;
  return `${plural(s.runs, "run")}, ${plural(s.calls, "AI call")}, ${plural(tokens, "token")}, cost ${s.costUsd === null ? "not recorded" : formatUsd(s.costUsd)}`;
}

/** The clients line: "All clients", or the chosen names. */
export const clientsWords = (s: ReportSchedule): string =>
  s.scope === "all" ? "All clients" : `${plural(s.clients.length, "client")}: ${s.clients.map((c) => c.clientName || "A client").join(", ")}`;

/** The last run's counts, in words: "9 drafts made, 2 already there, 1 skipped, 0 failed". */
export function lastRunWords(r: LastRun): string {
  const bits = [`${r.created} ${r.created === 1 ? "draft" : "drafts"} made`, `${r.existing} already there`, `${r.skipped} skipped`, `${r.failed} failed`];
  const status = r.status === "queued" ? "waiting to start" : r.status === "running" ? "still drafting" : r.status === "failed" ? "stopped" : "finished";
  return `${status[0].toUpperCase()}${status.slice(1)}: ${bits.join(", ")}`;
}

export const missedWords = (n: number): string => (n > 0 ? `${plural(n, "earlier period")} missed while the ERP was down, not drafted (only the latest is)` : "");

export const AUTOMATION_PATH = (deptId: string): string => `/departments/${encodeURIComponent(deptId)}/settings`;
/** The Reports page of the department: a run's results are shown there (`?run=`); the page opens the run's progress and each client's report. */
export const runHref = (deptId: string, runId: string): string => `/departments/${encodeURIComponent(deptId)}/social-reports?run=${encodeURIComponent(runId)}`;

// ── Words for a refusal ──────────────────────────────────────────────────────────────────────────────────────────────────

export type ScheduleWrite = "save" | "pause" | "resume" | "delete" | "run";

/** The words of a field the server names in a 400, shown beside that field. */
export const FIELD_WORDS: Readonly<Record<string, string>> = {
  kind: "Choose the kind of report.", scope: "Choose all clients or some clients.", engagementIds: "Choose at least one client that is still open.",
  "timing.at": "Choose a time of day, from 00:00 to 23:59.", "timing.weekday": "Choose the day of the week.",
  "timing.on": "Choose a day of the month, or a working day of the month.", "timing.day": `Enter a day of the month from 1 to ${MAX_DAY}.`,
  "timing.n": `Enter which working day, from 1 to ${MAX_WORKING_DAY}.`, timing: "The timing is not complete. Check each part of it.",
};

/** The sentence for a refusal of a schedule write: the contract's code stays the code; this is its words, with the figures the server added. */
export function scheduleRefusalText(r: Refusal, kind: ScheduleWrite): string {
  switch (r.error) {
    case "not_a_social_approver": return PLAN_REFUSAL_REASON.replace("change this", "set report automation");
    case "automation_cannot_act": return "An automated account cannot do this. A person sets report automation, and the runs act as that person.";
    case "invalid_field": return (r.field && FIELD_WORDS[r.field]) || (r.field === "id" ? "Something went wrong with the request. Reload the page and try again." : r.field ? `${r.field} is not valid.` : "A value is not valid.");
    case "session_expired": return "Session expired — sign in again.";
    case "no_company": return "No active company selected.";
    case "run_not_found": return "That run is no longer available to you. Open the Reports page to see the drafts.";
    default: break;
  }
  if (r.status === 403 && kind === "run") return "Drafting reports needs the right to create them. Ask the Social Media head.";
  if (r.status === 403) return PLAN_REFUSAL_REASON.replace("change this", "set report automation");
  return REFUSAL_WORDS[r.error] ?? "That did not work. Reload the page and try again.";
}
