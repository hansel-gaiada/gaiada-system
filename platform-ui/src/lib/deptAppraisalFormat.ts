// The department appraisal per cycle (DW-4e-3): the TYPES and PURE formatters, BFF contract §41. No server-only import, so a
// client component (the commentary and assessment forms) can use them; the readers that call the backend are in
// lib/deptAppraisals.ts, which re-exports this.
//
// The numbers are never made here: the KPIs over the cycle, the condition history and the people aggregate all come from
// `GET /dept-appraisals`, which computes them with the section 40 engine. This file only words them.
import type { DeptKpi, KpiCondition } from "./deptKpiFormat";

export type { DeptKpi, KpiCondition } from "./deptKpiFormat";

export type CycleStatus = "draft" | "open" | "in_review" | "closed";
export type GmCondition = "on_track" | "at_risk" | "off_track";
export type PeopleStatus = "draft" | "submitted" | "acknowledged" | "disputed" | "finalized";

/** The bound the server enforces on both texts (§41.4: 1 to 4000 characters). */
export const MAX_APPRAISAL_TEXT = 4000;

export interface DeptAppraisalHistoryEntry {
  /** The month start, YYYY-MM-01. */
  month: string;
  condition: KpiCondition;
  kpis: Array<{ key: string; condition: KpiCondition }>;
}

export interface DeptAppraisalPeople {
  total: number;
  byStatus: Record<PeopleStatus, number>;
  /** Counts of submitted-or-later, scored rows by rounded band 1..5; null (with `reason: "too_few"`) when fewer than 3 are scored. */
  distribution: Array<{ band: number; count: number }> | null;
  reason?: "too_few";
}

export interface DeptAppraisalHod {
  text: string;
  by: string;
  byName?: string | null;
  at: string;
}

export interface DeptAppraisalGm {
  text: string;
  condition: GmCondition;
  by: string;
  byName?: string | null;
  at: string;
}

/** `GET /api/:t/dept-appraisals?cycleId=&unitNodeId=` (§41.4). */
export interface DeptAppraisalView {
  cycle: { id: string; name: string; periodStart: string; periodEnd: string; status: CycleStatus };
  unit: { id: string; name: string };
  workspace: string;
  /** The §40 KPIs over the cycle, judged against the target in force for the cycle's LAST month. */
  kpis: DeptKpi[];
  condition: KpiCondition;
  history: DeptAppraisalHistoryEntry[];
  people: DeptAppraisalPeople;
  hodCommentary: DeptAppraisalHod | null;
  gmAssessment: DeptAppraisalGm | null;
}

/** A cycle as the picker needs it (the appraisal cycles list's row, trimmed). */
export interface CyclePick {
  id: string;
  name: string;
  periodStart: string;
  periodEnd: string;
  status: CycleStatus;
}

// ─────────────────────────────────────────────────────────────────── the picker ───────────────

/** Newest first: by period start, then period end, then name. Never mutates its input. */
export function sortCyclesNewestFirst<T extends Pick<CyclePick, "name" | "periodStart" | "periodEnd">>(cycles: readonly T[]): T[] {
  return [...cycles].sort(
    (a, b) =>
      (a.periodStart < b.periodStart ? 1 : a.periodStart > b.periodStart ? -1 : 0) ||
      (a.periodEnd < b.periodEnd ? 1 : a.periodEnd > b.periodEnd ? -1 : 0) ||
      a.name.localeCompare(b.name),
  );
}

export const CYCLE_STATUS_LABEL: Readonly<Record<CycleStatus, string>> = {
  draft: "Draft",
  open: "Open",
  in_review: "In review",
  closed: "Closed",
};

export function cycleStatusLabel(s: string): string {
  return CYCLE_STATUS_LABEL[s as CycleStatus] ?? s;
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-01" -> "Sep 2026". */
export function monthShort(monthStart: string): string {
  const mi = Number(monthStart.slice(5, 7)) - 1;
  return MONTHS_SHORT[mi] ? `${MONTHS_SHORT[mi]} ${monthStart.slice(0, 4)}` : monthStart;
}

/** "2026-07-01" and "2026-12-31" -> "1 Jul 2026 to 31 Dec 2026". */
export function cycleRange(periodStart: string, periodEnd: string): string {
  const d = (iso: string) => {
    const mi = Number(iso.slice(5, 7)) - 1;
    return MONTHS_SHORT[mi] ? `${Number(iso.slice(8, 10))} ${MONTHS_SHORT[mi]} ${iso.slice(0, 4)}` : iso;
  };
  return `${d(periodStart)} to ${d(periodEnd)}`;
}

/** Writes end when the cycle is closed (§41.2): the forms are offered for every other status. */
export function cycleAcceptsWrites(status: string): boolean {
  return status !== "closed";
}

// ─────────────────────────────────────────────────────────────────── the people block ───────────────

const STATUS_LABEL: Readonly<Record<PeopleStatus, string>> = {
  draft: "Draft",
  submitted: "Submitted",
  acknowledged: "Acknowledged",
  disputed: "Disputed",
  finalized: "Finalized",
};

/** The statuses in lifecycle order with their counts, zeros kept (the block always shows the whole line). */
export function statusRows(people: Pick<DeptAppraisalPeople, "byStatus">): Array<{ status: PeopleStatus; label: string; count: number }> {
  return (Object.keys(STATUS_LABEL) as PeopleStatus[]).map((s) => ({ status: s, label: STATUS_LABEL[s], count: people.byStatus?.[s] ?? 0 }));
}

/** "6 appraisals" / "1 appraisal" / "No appraisals in this cycle yet". */
export function peopleHeadline(people: Pick<DeptAppraisalPeople, "total">): string {
  if (people.total === 0) return "No appraisals in this cycle yet";
  return `${people.total} ${people.total === 1 ? "appraisal" : "appraisals"}`;
}

/** The note shown in place of a withheld distribution: it says why, so an absent chart is never read as zero scores. */
export const TOO_FEW_NOTE = "Too few scored appraisals to show a distribution, so no individual's score can be read from it.";

/** The widest bar's count, never 0 (the bars are drawn relative to it). */
export function maxBandCount(distribution: ReadonlyArray<{ count: number }>): number {
  return Math.max(1, ...distribution.map((b) => b.count));
}

// ─────────────────────────────────────────────────────────────────── the history ───────────────

/** One entry's accessible description: "Sep 2026: at risk". */
export function historyLabel(h: Pick<DeptAppraisalHistoryEntry, "month" | "condition">, conditionWord: (c: KpiCondition) => string): string {
  return `${monthShort(h.month)}: ${conditionWord(h.condition).toLowerCase()}`;
}

// ─────────────────────────────────────────────────────────────────── the two forms ───────────────

export const GM_CONDITION_OPTIONS: ReadonlyArray<{ value: GmCondition; label: string }> = [
  { value: "on_track", label: "On track" },
  { value: "at_risk", label: "At risk" },
  { value: "off_track", label: "Off track" },
];

export function isGmCondition(x: unknown): x is GmCondition {
  return x === "on_track" || x === "at_risk" || x === "off_track";
}

export type TextParse = { ok: true; text: string } | { ok: false; error: string; field: "text" };

/** The body text of either form: trimmed, 1 to 4000 characters. The server validates the same rule and stays the authority. */
export function parseAppraisalText(raw: string): TextParse {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, error: "Write something first.", field: "text" };
  if (text.length > MAX_APPRAISAL_TEXT) {
    return { ok: false, error: `Keep it to ${MAX_APPRAISAL_TEXT.toLocaleString("en-US")} characters or fewer.`, field: "text" };
  }
  return { ok: true, text };
}

export type AssessmentParse =
  | { ok: true; body: { text: string; condition: GmCondition } }
  | { ok: false; error: string; field: "text" | "condition" };

export function parseAssessment(raw: { text: string; condition: string }): AssessmentParse {
  const t = parseAppraisalText(raw.text);
  if (!t.ok) return t;
  if (!isGmCondition(raw.condition)) return { ok: false, error: "Choose on track, at risk or off track.", field: "condition" };
  return { ok: true, body: { text: t.text, condition: raw.condition } };
}

/** The machine code a writer can meet, as a sentence. Anything else is the server's own words. */
export function explainAppraisalWriteError(message: string): string {
  if (message === "cycle_closed") return "This cycle is closed, so its department appraisal can no longer be changed.";
  if (message === "cycle_not_found") return "This cycle no longer exists.";
  if (message === "unit_not_found") return "This department no longer exists.";
  return message;
}
