// Tracker/reporting — the check-in subsystem's typed contract (TR-10/TR-38, Blueprint §5.3/§6.2).
//
// Field-for-field mirror of `platform-nest/src/modules/reports/checkins.controller.ts`'s actual
// response shapes (read before writing this — §15's standing lesson: "a stand-in written from
// assumption rather than from the module that writes the data" is how this program's worst bugs
// happened). In particular `CheckinPrefill` is the exact shape `composeCheckinPrefill` returns, and
// `CheckinToday`/`CheckinHistoryEntry` are the exact shapes `today()`/`history()` return.
//
// Deliberately NOT `"server-only"` (same reasoning as lib/reports.ts's header comment): this file
// is types + pure, zero-I/O functions only, so a "use client" component (CheckinCard) can import it
// directly. The actual fetch calls live in the separate `lib/checkins-data.ts` (server-only), and
// the write path lives in `lib/checkinActions.ts` ("use server").
//
// §5.3's false-negative guard, restated for the FE: the backend writes an `auto_missed` row ONLY
// for days a person was actually expected to check in (working day ∧ ¬holiday ∧ ¬approved-leave ∧
// ¬attendance-off ∧ active membership) — it NEVER writes a row for a non-expected day. That
// invariant is what makes `buildCalendarDays` below safe: a day with no history row is always
// treated as `not_expected`, never as `missed` — the FE never has to (and never should try to)
// re-derive expected() itself, because it has no access to the calendar/holiday/leave/attendance
// tables that decide it. The only positive evidence of a miss is a persisted `auto_missed` row.

export type CheckinRowStatus = "submitted" | "auto_missed" | "excused";

export interface PrefillProjectMinutes {
  projectId: string;
  projectName: string;
  minutes: number;
}

export interface PrefillTaskRef {
  taskId: string;
  title: string;
}

// Mirrors checkins.controller.ts's `CheckinPrefill` interface exactly.
export interface CheckinPrefill {
  summaryText: string;
  minutesLogged: number;
  minutesBillable: number;
  byProject: PrefillProjectMinutes[];
  tasksCompleted: PrefillTaskRef[];
  tasksCreated: PrefillTaskRef[];
  tasksMoved: PrefillTaskRef[];
  commentsAuthored: number;
  docsUpdated: number;
  otherActivityEvents: number;
}

export interface CheckinExisting {
  id: string;
  status: string; // "submitted" | "excused" today (an "auto_missed" row for TODAY cannot exist yet)
  summary: string;
  blockers: string | null;
  edited: boolean;
  source: string;
  submittedAt: string | null;
}

// Mirrors `GET /checkins/today`'s response exactly.
export interface CheckinToday {
  date: string; // YYYY-MM-DD, in REPORTS_TZ
  expected: boolean;
  alreadySubmitted: boolean;
  existing: CheckinExisting | null;
  draft: CheckinPrefill;
}

// Mirrors one row of `GET /checkins`'s `checkins[]` array exactly.
export interface CheckinHistoryEntry {
  id: string;
  date: string;
  status: CheckinRowStatus;
  summary: string;
  blockers: string | null;
  edited: boolean;
  source: string;
  submittedAt: string | null;
  excusedReason: string | null;
}

export interface CheckinHistory {
  userId: string;
  from: string;
  to: string;
  checkins: CheckinHistoryEntry[];
}

/** One person's tally in the compliance grid — mirrors `checkins.controller.ts`'s exported
 *  `ComplianceRow` field-for-field.
 *
 *  ⚠ `complianceRate` is `null`, never 0, when `expectedDays === 0` — the controller never divides
 *  by zero, and "nobody was expected to check in" is not "nobody complied". A consumer that renders
 *  `null` as 0% invents a failure. */
export interface CheckinComplianceRow {
  userId: string;
  expectedDays: number;
  submittedDays: number;
  missedDays: number;
  excusedDays: number;
  complianceRate: number | null;
}

/** `GET /checkins/compliance`'s envelope. `unit` ECHOES what the server actually scoped to, which is
 *  NOT always what the caller asked for: for a unit-scoped (dept-lead) principal the controller
 *  replaces the requested unit with the led subtree, and for a self-only principal it returns
 *  `unit: null` with a single row. Read the echo, never assume the request. */
export interface CheckinCompliance {
  from: string;
  to: string;
  unit: string | null;
  rows: CheckinComplianceRow[];
}

/** Roll a grid up to one headline figure.
 *
 *  Sums the NUMERATORS and DENOMINATORS rather than averaging the per-person rates — averaging rates
 *  weights a person expected once the same as a person expected twenty times, which is the classic
 *  way a compliance number ends up disagreeing with the grid underneath it. `rate` is `null` when
 *  nothing was expected at all, propagating the controller's own never-divide-by-zero rule. */
export function rollUpCompliance(rows: CheckinComplianceRow[]): {
  people: number;
  expected: number;
  submitted: number;
  missed: number;
  excused: number;
  rate: number | null;
} {
  const t = { people: rows.length, expected: 0, submitted: 0, missed: 0, excused: 0 };
  for (const r of rows) {
    t.expected += r.expectedDays;
    t.submitted += r.submittedDays;
    t.missed += r.missedDays;
    t.excused += r.excusedDays;
  }
  return { ...t, rate: t.expected > 0 ? t.submitted / t.expected : null };
}

// Mirrors `POST /checkins`'s 200 response exactly.
export interface CheckinSubmitResult {
  id: string;
  date: string;
  status: "submitted";
  summary: string;
  blockers: string | null;
  edited: boolean;
  source: string;
}

// =====================================================================
// Pure helpers — no fetch, safe for both server and client components.
// =====================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

export function addDaysIso(iso: string, n: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

// "3h 45m" / "45m" / "2h" / "0m" — mirrors checkins.controller.ts's own `formatMinutes` exactly
// (duplicated rather than shared: separate projects, no shared package, per repo convention).
export function formatMinutes(total: number): string {
  if (total <= 0) return "0m";
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// The four-state calendar day, matching `CalendarHeatmap`'s own `CheckinDayStatus` union exactly
// (components/reports/charts/CalendarHeatmap.tsx) — kept as an independent literal type here
// rather than a value-import from that "use client" component, so this file stays import-clean for
// both server and client callers; the two unions are asserted identical by `checkins.test.ts`.
export type CheckinDayStatus = "submitted" | "missed" | "excused" | "not_expected";
export interface CheckinDay { date: string; status: CheckinDayStatus }

// TR-38 — turns a sparse history (only days that HAVE a persisted row) into a dense day-by-day
// calendar for `CalendarHeatmap`, for exactly one [periodStart, periodEnd] range. A day with no
// row maps to `not_expected` — see this file's header comment for why that's the ONLY honest
// default (weekend/holiday/leave and "the nightly job hasn't reached this day yet" are
// indistinguishable from here, and both are non-miss outcomes; today itself is always in the
// second bucket, which is also how "today is never shown as missed" falls out for free, with no
// date-equality special case needed).
export function buildCalendarDays(history: CheckinHistoryEntry[], periodStart: string, periodEnd: string): CheckinDay[] {
  const byDate = new Map(history.map((h) => [h.date, h.status]));
  const days: CheckinDay[] = [];
  for (let d = periodStart; d <= periodEnd; d = addDaysIso(d, 1)) {
    const raw = byDate.get(d);
    const status: CheckinDayStatus =
      raw === "submitted" ? "submitted" : raw === "excused" ? "excused" : raw === "auto_missed" ? "missed" : "not_expected";
    days.push({ date: d, status });
  }
  return days;
}

// TR-10 — a self-facing streak/compliance summary built from the ONLY source a self-service caller
// is permitted to read (`GET /checkins?userId=<self>`, always self-allowed). This is deliberately
// NOT the official §18 compliance metric: `GET /checkins/compliance` is structurally self-⛔
// (checkins.controller.ts's own comment: "Cerbos's self rule requires `subjectUserId`, which this
// action never sets, so only lead/exec/HR/admin tiers can ever pass — matching §8's 'self ⛔' cell
// exactly"), so a person can never fetch their own row from that grid. This function's `rate`
// deliberately EXCLUDES excused days from the denominator (submitted / (submitted + missed)) —
// the official grid's `complianceRate` (submitted/expected) still charges an excused day against
// the rate, because it was objectively an expected day; that is the right call for a management
// metric but the wrong one for a self-motivation number, where an excused absence (by definition
// already forgiven by a manager/HR) should never read as a personal shortfall. `currentStreak`
// counts consecutive SUBMITTED days walking back from the most recent recorded day; an excused day
// neither breaks nor extends the streak (it's a forgiven gap, not a submission), a missed day
// breaks it.
export interface SelfComplianceSummary {
  windowDays: number; // how many days actually had a row in the queried window
  submittedCount: number;
  missedCount: number;
  excusedCount: number;
  rate: number | null; // null when there is no evidence either way yet (denominator 0)
  currentStreak: number;
}

export function summarizeSelfCompliance(history: CheckinHistoryEntry[]): SelfComplianceSummary {
  const sorted = [...history].sort((a, b) => b.date.localeCompare(a.date)); // most recent first
  let submitted = 0, missed = 0, excused = 0;
  for (const h of sorted) {
    if (h.status === "submitted") submitted += 1;
    else if (h.status === "excused") excused += 1;
    else missed += 1; // auto_missed
  }
  let currentStreak = 0;
  for (const h of sorted) {
    if (h.status === "submitted") currentStreak += 1;
    else if (h.status === "excused") continue;
    else break;
  }
  const denom = submitted + missed;
  return {
    windowDays: sorted.length,
    submittedCount: submitted,
    missedCount: missed,
    excusedCount: excused,
    rate: denom > 0 ? submitted / denom : null,
    currentStreak,
  };
}

// The trailing window My Work's streak/compliance strip queries (§6.2's history endpoint, self —
// deliberately NOT the 400-day reports ceiling; this is a small, cheap, self-only read).
export const SELF_HISTORY_WINDOW_DAYS = 30;
