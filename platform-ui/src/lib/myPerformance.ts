// PV7-06: "My performance" (`/me/performance`), as pure rules. The page reads the person's OWN numbers, check-ins,
// appraisal, learning and time, each on its own, and links to each one's full page; it copies none of them.
//
// Every section is what its reader said, kept in one `Section` shape, so a refused or failed read can never become
// "no training", "no check-ins" or "0 h" (plan docs/plans/2026-10-15-pv7-performance-views-tickets.md, PV7-06; the
// DW-3 `readResult` pattern). A section whose module the company has switched off is `off`: withheld, not blanked.
//
// What is deliberately NOT here: a composite score, a utilization figure, hours beside the appraisal, and anything
// about another person. The appraisal view below takes only a cycle's name and its state; the pack's scores
// (including its effort axis) never enter the view model, so a section cannot render them.
//
// Nothing here is a security boundary: every read is the person's own and the server narrows it.
import type { ReadResult } from "./readResult";
import type { MyLearning } from "./lms";
import type { AppraisalPack, AppraisalStatus } from "./appraisals";
import type { CheckinHistory, CheckinHistoryEntry, CheckinRowStatus } from "./checkins";
import { summarizeSelfCompliance } from "./checkins";
import type { ReportDocument } from "./reports";
import { appraisalStatusText } from "./overviewGrowth";
import { buildYourNumbers, formatHours, personReportHref, todayIso, type YourNumbers } from "./overviewNumbers";

export const MY_PERFORMANCE_HREF = "/me/performance";
/** Where the day's check-in is filled in: Today's block on the person's Overview (`/` resolves to it). */
export const CHECKIN_HREF = "/";
export const MY_APPRAISALS_HREF = "/appraisals/mine";
export const MY_LEARNING_HREF = "/me/learning";
export const MY_TIMESHEET_HREF = "/timesheets";

/** The six sections, in the order the page draws them. */
export const PERFORMANCE_SECTIONS = ["numbers", "checkins", "appraisal", "learning", "time", "activity"] as const;
export type PerformanceSection = (typeof PERFORMANCE_SECTIONS)[number];

/** The module each section reads from, as its full page gates it: reports (numbers, appraisals), `hr` (check-ins),
 *  `lms` (learning). Time entries and the activity link belong to no module. */
export const SECTION_MODULE: Readonly<Partial<Record<PerformanceSection, string>>> = {
  numbers: "reports", checkins: "hr", appraisal: "reports", learning: "lms",
};

export type Section<T> =
  | { kind: "ok"; data: T }
  | { kind: "forbidden" }
  | { kind: "unavailable" }
  /** The company switched this section's module off: the page does not draw it. */
  | { kind: "off" };

/** True when the section's module is switched off (`moduleOn` fails open, so only a module the backend positively said is off). */
export function moduleOff(section: PerformanceSection, moduleOn: (key: string) => boolean): boolean {
  const mod = SECTION_MODULE[section];
  return mod !== undefined && !moduleOn(mod);
}

/** Map a successful read; a refused one stays `forbidden`, a failed one (or a mapping that throws on an odd payload)
 *  is `unavailable`. Never an empty value standing in for a read that did not return. */
export function sectionOf<T, U>(result: ReadResult<T>, map: (data: T) => U): Section<U> {
  if (result.kind === "forbidden") return { kind: "forbidden" };
  if (result.kind !== "ok") return { kind: "unavailable" };
  try {
    return { kind: "ok", data: map(result.data) };
  } catch {
    return { kind: "unavailable" };
  }
}

// ── Your numbers: this month, the same document as My report ─────────────────────────────────────

/** The period is the current month, the Overview's default and My report's default: one document, one read, the very
 *  numbers My report shows for the month. A period selector would repeat My report's own; the link opens the report
 *  for the same month, where the other periods live. */
export const NUMBERS_PERIOD = "month" as const;

export function numbersSection(result: ReadResult<ReportDocument>): Section<YourNumbers> {
  return sectionOf(result, buildYourNumbers);
}

export function numbersHref(today: string): string {
  return personReportHref(NUMBERS_PERIOD, today);
}

// ── Check-ins ────────────────────────────────────────────────────────────────────────────────────

export const CHECKIN_ENTRIES_SHOWN = 14;

export interface CheckinRow { date: string; status: string; summary: string }
export interface CheckinsView {
  streak: number;
  /** "93%", or null when nothing was expected yet (never a 0%). */
  rate: string | null;
  submitted: number;
  missed: number;
  excused: number;
  /** Days with a record in the window the figures cover. */
  windowDays: number;
  entries: CheckinRow[];
}

const CHECKIN_STATUS: Record<CheckinRowStatus, string> = { submitted: "Submitted", auto_missed: "Missed", excused: "Excused" };

function checkinRow(e: CheckinHistoryEntry): CheckinRow {
  const summary = e.status === "excused" ? (e.excusedReason || e.summary) : e.summary;
  return { date: e.date, status: CHECKIN_STATUS[e.status] ?? String(e.status), summary: summary?.trim() ? summary : "" };
}

/** Streak and compliance come from the self summary (the only compliance a person may read for themselves: an excused
 *  day never counts against them), and the newest 14 records are listed. */
export function checkinsView(history: CheckinHistory): CheckinsView {
  const s = summarizeSelfCompliance(history.checkins);
  const newest = [...history.checkins].sort((a, b) => b.date.localeCompare(a.date)).slice(0, CHECKIN_ENTRIES_SHOWN);
  return {
    streak: s.currentStreak,
    rate: s.rate === null ? null : `${Math.round(s.rate * 100)}%`,
    submitted: s.submittedCount, missed: s.missedCount, excused: s.excusedCount, windowDays: s.windowDays,
    entries: newest.map(checkinRow),
  };
}

// ── Appraisal ────────────────────────────────────────────────────────────────────────────────────

/** The latest appraisal as the person's own record: its cycle, its state and whether they acknowledged it. NO score,
 *  no axis and no effort or hours figure: the view carries these four fields and nothing else. */
export interface AppraisalView {
  cycleName: string;
  status: AppraisalStatus;
  statusText: string;
  acknowledged: boolean;
}

type PackFields = Pick<AppraisalPack, "cycleName" | "status" | "submittedAt" | "createdAt" | "acks">;

const at = (v: string | null | undefined): number => {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
};

/** Null is a real "no appraisal yet" (the read succeeded and held none). `appraisals/mine` never returns a draft. */
export function appraisalSection(result: ReadResult<{ appraisals: readonly PackFields[] }>): Section<AppraisalView | null> {
  return sectionOf(result, (d) => {
    const latest = [...d.appraisals].sort((a, b) => at(b.submittedAt ?? b.createdAt) - at(a.submittedAt ?? a.createdAt))[0];
    if (!latest) return null;
    return {
      cycleName: latest.cycleName,
      status: latest.status,
      statusText: appraisalStatusText(latest.status),
      acknowledged: latest.status === "acknowledged" || (latest.acks ?? []).some((a) => a.action === "acknowledged"),
    };
  });
}

// ── Learning ─────────────────────────────────────────────────────────────────────────────────────

export interface LearningCounts { outstanding: number; mandatory: number; overdue: number }

/** Outstanding is assigned or in progress, as My learning counts it; mandatory and overdue are among the outstanding. */
export function learningSection(result: ReadResult<MyLearning>): Section<LearningCounts> {
  return sectionOf(result, (d) => {
    const open = d.enrolments.filter((e) => e.status === "assigned" || e.status === "in_progress");
    return { outstanding: open.length, mandatory: open.filter((e) => e.isMandatory).length, overdue: open.filter((e) => e.overdue).length };
  });
}

// ── Your time ────────────────────────────────────────────────────────────────────────────────────

export interface TimeEntryLike { entry_date: string; minutes: number }
export interface TimeView {
  monthLabel: string;
  /** Minutes in this calendar month, and in the last 7 days (today and the six before it). */
  monthMinutes: number;
  weekMinutes: number;
  monthText: string;
  weekText: string;
  entryCount: number;
}

const DAY_MS = 86_400_000;
const addDays = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);

export function monthLabelOf(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? today.slice(0, 7) : d.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** Hours from the person's OWN entries (the read passes `mine=me`). This is context for the numbers above, never a score. */
export function timeSection(result: ReadResult<readonly TimeEntryLike[]>, today: string = todayIso()): Section<TimeView> {
  return sectionOf(result, (entries) => {
    const month = today.slice(0, 7);
    const weekFrom = addDays(today, -6);
    let monthMinutes = 0;
    let weekMinutes = 0;
    for (const e of entries) {
      const day = String(e.entry_date).slice(0, 10);
      const minutes = Number.isFinite(e.minutes) ? e.minutes : 0;
      if (day.startsWith(month)) monthMinutes += minutes;
      if (day >= weekFrom && day <= today) weekMinutes += minutes;
    }
    return {
      monthLabel: monthLabelOf(today), monthMinutes, weekMinutes,
      monthText: formatHours(monthMinutes), weekText: formatHours(weekMinutes), entryCount: entries.length,
    };
  });
}
