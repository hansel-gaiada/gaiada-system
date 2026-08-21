// TR-26 — the appraisal pack's FE contract. Field-for-field mirror of
// `platform-nest/src/modules/reports/appraisal-document.ts` (TR-24's contract — READ THAT FILE
// BEFORE editing this one; §15's standing lesson across this whole program is that a stand-in
// written from assumption, not from the module that actually writes the data, is how its worst
// bugs happened) plus the validation constants/helpers `appraisal-engine.ts` enforces server-side
// (`SMALL_COHORT_THRESHOLD`, `DEVIATION_THRESHOLD`, `MIN_COMMENTARY_LENGTH`).
//
// Deliberately NOT "server-only" — same reasoning as lib/reports.ts / lib/checkins.ts: this file is
// types + pure, zero-I/O functions only, so both server pages and "use client" form components can
// import it directly. The client-side validation helpers here (`isValidCommentary`,
// `findMissingDeviationNotes`) are a DUPLICATE of appraisal-engine.ts's own pure functions of the
// same name — deliberately: separate deployable projects, no shared package (repo CLAUDE.md), and
// this ticket's whole acceptance bar is that the SAME rules surface as inline validation before
// submit, not only as a raw 400 after it. Keep both in sync by hand if the rule ever changes.
//
// Appraisal data is a genuinely separate model from `ReportDocument` (never part of it, never read
// through `reports.getDocument`, never exposed over MCP — appraisal-document.ts's own header) — this
// file does not import anything from lib/reports.ts for that reason, even though `CohortBandDatum`
// below looks similar to a `ReportKpi`.

// Pinned-locale number formatting — a bare `toLocaleString()` here rendered differently on server
// and client and broke hydration on the appraisal cohort strip (see lib/format.ts::formatNumber).
import { formatNumber } from "./format";

export type AppraisalAxis = "delivery" | "quality" | "effort" | "collaboration";

export type AppraisalStatus = "draft" | "submitted" | "acknowledged" | "disputed" | "finalized";

export type AppraisalAckAction = "acknowledged" | "disputed" | "comment" | "reopened" | "finalized";

/** §5.2 point 3's small-cohort guard, mirrored from appraisal-engine.ts's own constant: bands are
 *  computed only when the cohort has >=5 members in the cycle. Below that, `band` is null AND
 *  `subjectPercentile` is omitted (both, not just the band — a percentile in a 3-person cohort is
 *  exactly as identifying as the band itself; appraisal-document.ts's own header explains this
 *  refinement over TR-16's original non-optional placeholder). */
export const SMALL_COHORT_THRESHOLD = 5;

/** §5.2 point 4: a manager score deviating from the computed band by MORE than this many bands
 *  requires a written per-axis justification, enforced both here (client) and server-side. */
export const DEVIATION_THRESHOLD = 1;

/** §5.2 point 4 / acceptance bar: mandatory commentary, enforced both here and server-side. */
export const MIN_COMMENTARY_LENGTH = 50;

export const APPRAISAL_AXES: AppraisalAxis[] = ["delivery", "quality", "effort", "collaboration"];

export const AXIS_LABELS: Record<AppraisalAxis, string> = {
  delivery: "Delivery", quality: "Quality", effort: "Effort", collaboration: "Collaboration",
};

/** One appraisal-safe metric's cohort position for ONE subject, within their (cycle, roleKey)
 *  cohort — mirrors appraisal-document.ts's `CohortBandDatum` exactly. */
export interface CohortBandDatum {
  metricKey: string;
  metricLabel: string;
  unit: "count" | "minutes" | "percent" | "score";
  subjectValue: number;
  /** §5.2 point 2: every safe RATE carries its denominator — a 100% rate over 2 tasks must read as
   *  what it is, band or no band. */
  numerator?: number;
  denominator?: number;
  /** 0-100 within the same role cohort + cycle. OMITTED when `band` is null (small-cohort guard). */
  subjectPercentile?: number;
  /** null when the cohort has fewer than SMALL_COHORT_THRESHOLD members this cycle — the pack then
   *  shows `subjectValue`/`numerator`/`denominator` only, never a percentile or a band. This is the
   *  ethical requirement 1 datum: a suppressed band must render as suppressed, never as a low score. */
  band: 1 | 2 | 3 | 4 | 5 | null;
  cohortSize: number;
  /** The metrics-catalog axis — NOT necessarily one of the four weighted `AppraisalAxis` values
   *  (discipline metrics carry axis:"discipline", informational only). */
  axis: string;
  /** True for the two axis="discipline" safe metrics: appraisal-safe, banded like any other, but
   *  with no weighted axis to feed scores/composite — carried for reference only. */
  informationalOnly: boolean;
}

export interface AppraisalAxisScore {
  /** The auto-computed band (1-5) — an INPUT, never the score itself (§5.2 point 4: "manager
   *  judgment is the score; auto is an input"). Null when every constituent metric was
   *  small-cohort-suppressed or the axis has no applicable metric. */
  auto: number | null;
  /** The manager's 1-5 score. Null until the manager sets it. */
  manager: number | null;
  /** Required (non-empty, trimmed) whenever `auto !== null && |manager - auto| > DEVIATION_THRESHOLD`. */
  note?: string;
}

export interface AppraisalAckEntry {
  id: string;
  appraisalId: string;
  actorUserId: string;
  actorName: string;
  action: AppraisalAckAction;
  comment: string | null;
  createdAt: string;
}

/** The full read shape `GET /appraisals/:id` (and every list/mine entry) returns — mirrors
 *  appraisal-document.ts's `AppraisalPack` exactly. THE SUBJECT AND THE MANAGER SEE THIS EXACT SAME
 *  SHAPE (§11 principle 2 / this ticket's fairness core) — there is no manager-only field here to
 *  accidentally leak, and no field hidden from the subject either. */
export interface AppraisalPack {
  id: string;
  tenantId: string;
  cycleId: string;
  cycleName: string;
  subjectUserId: string;
  subjectName: string;
  managerUserId: string;
  managerName: string;
  roleKey: string | null;
  weights: Record<AppraisalAxis, number>;
  scores: Record<AppraisalAxis, AppraisalAxisScore>;
  composite: number | null;
  commentary: string | null;
  status: AppraisalStatus;
  cohortBands: CohortBandDatum[];
  evidence: { periodIds: string[]; revisions: Record<string, number> };
  evidenceStale: boolean;
  periodId: string;
  revision: number;
  submittedAt: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
  acks: AppraisalAckEntry[];
}

/** List/`mine` entry shape (the controller's narrower list projection, not the hydrated pack). */
export interface AppraisalListEntry {
  id: string;
  cycleId: string;
  subjectUserId: string;
  managerUserId: string;
  status: AppraisalStatus;
  composite: number | null;
}

export interface AppraisalCycleRow {
  id: string;
  tenantId: string;
  name: string;
  periodStart: string;
  periodEnd: string;
  status: "draft" | "open" | "in_review" | "closed";
  defaultWeights: Record<AppraisalAxis, number>;
  roleWeights: Record<string, Record<AppraisalAxis, number>>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface GenerateRoster {
  subjectUserId: string;
  managerUserId: string;
  roleKey?: string;
}

export interface GenerateResult {
  generated: string[];
  skippedExisting: string[];
}

// =====================================================================
// Pure validation helpers — the SAME rules appraisal-engine.ts enforces, surfaced as inline
// pre-submit feedback rather than a raw 400 (this ticket's acceptance bar).
// =====================================================================

export function isValidCommentary(commentary: string | undefined | null): boolean {
  return !!commentary && commentary.trim().length >= MIN_COMMENTARY_LENGTH;
}

export function commentaryRemaining(commentary: string | undefined | null): number {
  return Math.max(0, MIN_COMMENTARY_LENGTH - (commentary ?? "").trim().length);
}

/** Mirrors appraisal-engine.ts's `findMissingDeviationNotes` exactly: axes whose manager score
 *  deviates from the auto band by more than `DEVIATION_THRESHOLD` WITHOUT a non-empty note. An axis
 *  with no computable auto band (small-cohort-suppressed, or no applicable metric) has nothing to
 *  deviate from and is never flagged. */
export function findMissingDeviationNotes(scores: Record<AppraisalAxis, AppraisalAxisScore>): AppraisalAxis[] {
  const missing: AppraisalAxis[] = [];
  for (const axis of APPRAISAL_AXES) {
    const s = scores[axis];
    if (!s || s.manager === null || s.manager === undefined) continue;
    if (s.auto === null || s.auto === undefined) continue;
    if (Math.abs(s.manager - s.auto) > DEVIATION_THRESHOLD && !(s.note && s.note.trim().length > 0)) missing.push(axis);
  }
  return missing;
}

/** Every axis that still needs a manager score before submit is even attemptable. */
export function findIncompleteAxes(scores: Record<AppraisalAxis, AppraisalAxisScore>): AppraisalAxis[] {
  return APPRAISAL_AXES.filter((axis) => scores[axis]?.manager === null || scores[axis]?.manager === undefined);
}

/** Client-side preview only — the server recomputes and persists the authoritative value at
 *  submit. Null until every axis has a manager score (mirrors appraisal-engine.ts's `computeComposite`). */
export function previewComposite(weights: Record<AppraisalAxis, number>, scores: Record<AppraisalAxis, AppraisalAxisScore>): number | null {
  let sum = 0;
  for (const axis of APPRAISAL_AXES) {
    const s = scores[axis]?.manager;
    if (s === null || s === undefined) return null;
    sum += (weights[axis] ?? 0) * s;
  }
  return Math.round(sum * 100) / 100;
}

/** Whether a submit attempt would currently be refused, and why — the whole point of this function
 *  is that the FORM renders these reasons up front, so the manager sees "commentary needs 12 more
 *  characters" / "Effort deviates from the computed band by more than one — add a note" as they
 *  work, not as a surprise 400 after clicking Submit. */
export interface SubmitReadiness {
  ok: boolean;
  incompleteAxes: AppraisalAxis[];
  missingDeviationNotes: AppraisalAxis[];
  commentaryOk: boolean;
  commentaryRemaining: number;
}

export function checkSubmitReadiness(scores: Record<AppraisalAxis, AppraisalAxisScore>, commentary: string | undefined | null): SubmitReadiness {
  const incompleteAxes = findIncompleteAxes(scores);
  const missingDeviationNotes = findMissingDeviationNotes(scores);
  const commentaryOk = isValidCommentary(commentary);
  return {
    ok: incompleteAxes.length === 0 && missingDeviationNotes.length === 0 && commentaryOk,
    incompleteAxes, missingDeviationNotes, commentaryOk,
    commentaryRemaining: commentaryRemaining(commentary),
  };
}

// =====================================================================
// Formatting helpers — percent values are 0-100 fractions stored as raw 0-1 numbers, same convention
// as every other percent value in the reports program (ReportKpi.value, ReportTable columns) — TR-17/
// TR-18 both fixed a "0.86 instead of 86%" defect on exactly this convention; stay consistent.
// =====================================================================

export function formatCohortValue(v: number, unit: CohortBandDatum["unit"]): string {
  if (unit === "percent") return `${Math.round(v * 100)}%`;
  if (unit === "minutes") return `${Math.round(v)}m`;
  return formatNumber(v);
}
