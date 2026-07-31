// TR-24 — the appraisal pack's typed contract. THE CONTRACT THIS TICKET OWNS (§15's TR-16 ruling:
// "no §6.1 type exists for appraisal cohort data — that is TR-24's contract to define; TR-24/TR-26
// must confirm or replace it rather than assume it").
//
// `CohortBandDatum` below CONFIRMS TR-16's provisional prop shape
// (`platform-ui/src/components/reports/charts/CohortBand.tsx`) field-for-field, with one
// deliberate refinement: `subjectPercentile` is OPTIONAL here, omitted whenever `band` is null.
// TR-16's placeholder typed it as a required `number` — but §5.2's small-cohort guard says a
// cohort under 5 members shows "the raw safe metrics with denominators and NO band"; a percentile
// is exactly as identifying as a band in a 3-person cohort (both degenerate into "you are the 2nd
// of 3 people"), so BOTH must be withheld together, not just the band. TR-26 should pick up this
// refinement rather than keep the placeholder's non-optional field.
//
// This file is intentionally NOT added to report-document.ts / platform-ui's lib/reports.ts —
// report-document.ts's own header says additions must land in the FE contract FIRST and be
// transcribed here verbatim; appraisal data is a genuinely separate model (never part of a
// ReportDocument, never read through the reports.getDocument path, never exposed over MCP — §9.2).
// TR-26 (appraisal UI, FE) is expected to define its own mirror of this shape when it lands,
// exactly as report-document.ts mirrors reports.ts today.
//
// Deliberately NOT exported from this module's `mcpTools` / ModuleContract — §9.2 and the standing
// ruling both exclude every appraisal read/write from MCP: an agent must never touch a performance
// record. Nothing in this file is wired to mcp-hub anywhere.

/** The four axes an appraisal cycle actually WEIGHTS (`report_appraisal_cycles.default_weights`/
 *  `role_weights` keys, migration 0068). Two of the nine appraisal-safe metrics (#18/#19,
 *  metrics.ts axis:"discipline") have no weighted-axis home in this data model — the schema this
 *  ticket builds on (0068, un-touchable per the brief) only carries these four buckets. They still
 *  appear in `cohortBands` as reference/context, just never folded into `scores`/`composite`. This
 *  is a disclosed modelling gap, not a silent omission — see appraisal-engine.ts's header. */
export type AppraisalAxis = "delivery" | "quality" | "effort" | "collaboration";

export type AppraisalStatus = "draft" | "submitted" | "acknowledged" | "disputed" | "finalized";

export type AppraisalAckAction = "acknowledged" | "disputed" | "comment" | "reopened" | "finalized";

/** One appraisal-safe metric's cohort position for ONE subject, within their (cycle, roleKey)
 *  cohort. Confirms/refines `CohortBandDatum` (platform-ui/src/components/reports/charts/
 *  CohortBand.tsx) — see file header. */
export interface CohortBandDatum {
  metricKey: string; // registry key (metrics.ts) — added beyond the FE placeholder for traceability
  metricLabel: string;
  unit: "count" | "minutes" | "percent" | "score";
  subjectValue: number;
  numerator?: number; // §5.2 point 2: every safe RATE carries its denominator — a 100% rate over
  denominator?: number; // 2 tasks must read as what it is, band or no band.
  /** 0-100 within the same role cohort + cycle. OMITTED when `band` is null (small-cohort guard —
   *  see file header on why this differs from TR-16's non-optional placeholder). */
  subjectPercentile?: number;
  /** null when the cohort has fewer than 5 members this cycle (§5.2 small-cohort guard) — the pack
   *  then shows `subjectValue`/`numerator`/`denominator` only, never a percentile or a band. */
  band: 1 | 2 | 3 | 4 | 5 | null;
  cohortSize: number;
  /** The catalog's axis (metrics.ts) — NOT necessarily one of the four weighted `AppraisalAxis`
   *  values (discipline metrics carry axis:"discipline", informational only — see the type's own
   *  comment above). */
  axis: string;
  /** True for the two axis="discipline" safe metrics (#18/#19): appraisal-safe, banded like any
   *  other, but with no weighted axis to feed — carried for reference only, never in `scores`. */
  informationalOnly: boolean;
}

export interface AppraisalAxisScore {
  /** The auto-computed band (1-5), aggregated from this axis's constituent safe metrics' bands
   *  (rounded average of whichever have a `band`, i.e. cohort >= 5; null if none do). This is an
   *  INPUT, never the score itself (§5.2 point 4: "manager judgment is the score; auto is an
   *  input"). */
  auto: number | null;
  /** The manager's 1-5 score. Null until the manager sets it (PATCH). */
  manager: number | null;
  /** Required (non-empty, trimmed) whenever `auto !== null && Math.abs(manager - auto) > 1` —
   *  enforced at submit (appraisal-engine.ts's `validateDeviations`), per axis. */
  note?: string;
}

/** The full read shape `GET /appraisals/:id` (and every list/mine entry) returns. Assembled by
 *  appraisal-engine.ts from `report_appraisals` + its pinned sealed evidence + the cohort bands
 *  computed at generate time (frozen in `auto_inputs`, never recomputed on read — §5.2 point 5/8:
 *  a later weight or metric change must never retroactively rewrite a person's score). */
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
  /** Real, queryable column (migration 0068) — mirrored here so a reader never has to reach into
   *  `evidence` to find it. True when ANY pinned period has been amended since generate (§15:
   *  "amend of a pinned revision flips evidence_stale and BLOCKS finalize until re-confirm" —
   *  detected by appraisal-engine.ts's `detectStaleness`, since the schema deliberately cannot
   *  enforce this itself — see migration 0068's own dedicated note). */
  evidenceStale: boolean;
  periodId: string;
  revision: number;
  submittedAt: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** The full append-only trail (report_appraisal_acks), oldest first. */
  acks: AppraisalAckEntry[];
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
