// TR-08 — the reports metric registry: THE single source of truth for both the governed
// `metric_definitions` seed (migration 0057_report_metric_seeds.sql) and the range-additivity /
// appraisal-safety metadata `ReportKpi` (TR-13+) and the rollup provider (report-rollups.ts) read.
//
// Blueprint §5 lists 22 metrics; §5.4 (2026-07-30 amendment, confirmed by the later "soundness
// pass" entry in §15) settled that only 21 are SEEDED into `metric_definitions` — #22
// `evidence.source_diversity` is a distinct-count over a range, which no existing
// `aggregation_rule` can express (`'max'` is actively WRONG, not merely imprecise: Mon `{pm}`,
// Tue `{github}` → max daily distinct = 1, true distinct = 2). It is carried here with
// `seeded: false` so document-build code (TR-13) can still find its axis/appraisal metadata
// without it ever reaching the governed registry.
//
// ─────────────────────────────── RULING ① (binding, §15) ───────────────────────────────
// `metric_definitions.aggregation_rule` is `CHECK (aggregation_rule IN ('sum','ratio_of_sums',
// 'max','last'))` (0001_core.sql:83) — FIXED and shared across every module's rollup consumers.
// This catalog does NOT widen it. Every seeded row below uses only that vocabulary:
//   - #20 `discipline.overdue_open` seeds as `'last'` (point-in-time; summing it across a range
//     would multiply the same still-overdue task by the day count — TR-08's regression test
//     pins this).
//   - #22 is not seeded at all (`seeded: false`), computed at document-build time as a
//     `COUNT(DISTINCT source)` union over `report_work_facts.activity_by_source`.
// The §5.4 range-additivity class (`rangeClass` below) is a CATALOG field only — it is never
// written to `metric_definitions` (that table has no such column and must not gain one).
import type { MetricDef } from "../contract";

export type ReportMetricAxis =
  | "delivery"
  | "flow"
  | "quality"
  | "effort"
  | "collaboration"
  | "discipline"
  | "evidence";

export type ReportMetricGrain = "person" | "project" | "department" | "company";

/** §5.4's three range-additivity classes. Dictates how a rollup/document-build query must treat
 *  an arbitrary [start, end] window:
 *   - additive:  Σ the daily measure. Range length is irrelevant.
 *   - ratio:     Σ numerator / Σ denominator, recomputed over the range — NEVER the mean of daily
 *                ratios. A days-denominated ratio divides by the range's ACTUAL day count.
 *   - non_additive: cannot be derived from daily aggregates; must be recomputed from the
 *                underlying rows (or refused) for the exact range asked. */
export type ReportRangeClass = "additive" | "ratio" | "non_additive";

/** The governed registry's `aggregation_rule` vocabulary (0001_core.sql:83) — repeated here as a
 *  literal union (not imported) so a typo cannot silently produce a value the CHECK will reject
 *  only at `npm run migrate` time. `'max'` is listed for completeness; this catalog never uses it
 *  (§15's soundness-pass ruling: `'max'` is WRONG, not merely imprecise, for a distinct-count). */
export type ReportAggregationRule = "sum" | "ratio_of_sums" | "last";

/** `metric_definitions.unit` has no DB CHECK (free `text`), but the existing TS union
 *  (`MetricDef.unit`) only carries `count | ratio | minutes | money_minor` — every other module's
 *  registered metric already reuses `'ratio'` for a percentage-shaped ratio_of_sums metric
 *  (`core.tasks.open_ratio`). This catalog follows that established convention rather than
 *  widening the shared union for a purely cosmetic "percent" label: `registryUnit` is what is
 *  actually stored in `metric_definitions`/seeded by 0057; `displayUnit` is the richer §5 "Unit"
 *  column, kept for the `ReportKpi`/document layer (TR-13) to read off this same catalog. */
export interface ReportMetricDef {
  /** §5's `#` column — 1..22, for cross-referencing the blueprint table in review/tests. */
  no: number;
  metricKey: string;
  axis: ReportMetricAxis;
  /** The blueprint's own "Unit" column (display-facing). */
  displayUnit: "count" | "minutes" | "percent";
  /** What actually gets seeded into `metric_definitions.unit` (see the doc comment above). */
  registryUnit: "count" | "ratio" | "minutes";
  aggregationRule: ReportAggregationRule;
  rangeClass: ReportRangeClass;
  grains: ReportMetricGrain[];
  /** true for the nine metrics that may enter an appraisal pack / feed an auto-score (§5.2). */
  appraisalSafe: boolean;
  /** false ONLY for #22 (read-time derived, never in `metric_definitions`). */
  seeded: boolean;
  description: string;
  /** Non-null for a ratio metric backed by two `report_work_facts` counters (the common case).
   *  Absent for metrics whose source is NOT `report_work_facts` (milestones/snapshots/calendar) —
   *  those are computed with dedicated SQL in report-rollups.ts, documented at each call site. */
  factColumns?: { numerator: string; denominator?: string };
}

export const REPORT_METRICS: readonly ReportMetricDef[] = [
  {
    no: 1,
    metricKey: "delivery.throughput_weighted",
    axis: "delivery",
    displayUnit: "minutes",
    registryUnit: "minutes",
    aggregationRule: "sum",
    rangeClass: "additive",
    grains: ["person", "project", "department", "company"],
    appraisalSafe: true,
    seeded: true,
    description: "Estimate-weighted completed throughput (anti-slicing weight; Σ estimate_minutes_completed)",
    factColumns: { numerator: "estimate_minutes_completed" },
  },
  {
    no: 2,
    metricKey: "delivery.tasks_completed",
    axis: "delivery",
    displayUnit: "count",
    registryUnit: "count",
    aggregationRule: "sum",
    rangeClass: "additive",
    grains: ["person", "project", "department", "company"],
    appraisalSafe: false,
    seeded: true,
    description: "Raw completed-task count (appraisal-unsafe: rewards task-slicing; see #1)",
    factColumns: { numerator: "tasks_completed" },
  },
  {
    no: 3,
    metricKey: "delivery.on_time_rate",
    axis: "delivery",
    displayUnit: "percent",
    registryUnit: "ratio",
    aggregationRule: "ratio_of_sums",
    rangeClass: "ratio",
    grains: ["person", "project", "department", "company"],
    appraisalSafe: true,
    seeded: true,
    description:
      "On-time completions over completions that carried a due date (§15 ruling ②: NOT tasks_completed — that would dilute the rate for teams that set fewer due dates)",
    factColumns: { numerator: "tasks_completed_on_time", denominator: "tasks_completed_with_due_date" },
  },
  {
    no: 4,
    metricKey: "delivery.estimate_coverage",
    axis: "delivery",
    displayUnit: "percent",
    registryUnit: "ratio",
    aggregationRule: "ratio_of_sums",
    rangeClass: "ratio",
    grains: ["person", "project", "department", "company"],
    appraisalSafe: true,
    seeded: true,
    description: "Completed tasks that carried an estimate, over all completions (estimation hygiene)",
    factColumns: { numerator: "tasks_completed_estimated", denominator: "tasks_completed" },
  },
  {
    no: 5,
    metricKey: "delivery.milestone_hit_rate",
    axis: "delivery",
    displayUnit: "percent",
    registryUnit: "ratio",
    aggregationRule: "ratio_of_sums",
    rangeClass: "ratio",
    grains: ["project", "department", "company"],
    appraisalSafe: true,
    seeded: true,
    description:
      "Milestones due in-range that are done, over milestones due in-range (project/lead level; sourced from pm_milestones, NOT report_work_facts — see report-rollups.ts's documented limitation: pm_milestones carries no completed_at, so 'hit' means currently-done, not provably on-or-before its due date)",
  },
  {
    no: 6,
    metricKey: "delivery.backlog_delta",
    axis: "delivery",
    displayUnit: "count",
    registryUnit: "count",
    aggregationRule: "sum",
    rangeClass: "additive",
    grains: ["project", "department", "company"],
    appraisalSafe: false,
    seeded: true,
    description: "Net backlog change: Σ tasks_created − Σ tasks_completed (not person-attributable)",
    factColumns: { numerator: "tasks_created", denominator: "tasks_completed" }, // see report-rollups.ts: numerator−denominator, no division
  },
  {
    no: 7,
    metricKey: "flow.wip_open_avg",
    axis: "flow",
    displayUnit: "count",
    registryUnit: "ratio",
    aggregationRule: "ratio_of_sums",
    rangeClass: "ratio",
    grains: ["project", "department", "company"],
    appraisalSafe: false,
    seeded: true,
    description: "Average daily open task count over the range (pm_progress_snapshots; context, not attributable)",
  },
  {
    no: 8,
    metricKey: "flow.blocked_share",
    axis: "flow",
    displayUnit: "percent",
    registryUnit: "ratio",
    aggregationRule: "ratio_of_sums",
    rangeClass: "ratio",
    grains: ["project", "department", "company"],
    appraisalSafe: false,
    seeded: true,
    description: "Daily blocked-status count over daily open count (blocked is often external; pm_progress_snapshots)",
  },
  {
    no: 9,
    metricKey: "flow.reopen_rate",
    axis: "quality",
    displayUnit: "percent",
    registryUnit: "ratio",
    aggregationRule: "ratio_of_sums",
    rangeClass: "ratio",
    grains: ["person", "project", "department", "company"],
    appraisalSafe: true,
    seeded: true,
    description: "Reopened over completed (quality proxy; owner-attributed)",
    factColumns: { numerator: "tasks_reopened", denominator: "tasks_completed" },
  },
  {
    no: 10,
    metricKey: "flow.avg_progress",
    axis: "flow",
    displayUnit: "percent",
    registryUnit: "ratio",
    aggregationRule: "ratio_of_sums",
    rangeClass: "ratio",
    grains: ["project"],
    appraisalSafe: false,
    seeded: true,
    description: "Progress·open weighted average over the range (self-reported progress; pm_progress_snapshots)",
  },
  {
    no: 11,
    metricKey: "effort.minutes_logged",
    axis: "effort",
    displayUnit: "minutes",
    registryUnit: "minutes",
    aggregationRule: "sum",
    rangeClass: "additive",
    grains: ["person", "project", "department", "company"],
    appraisalSafe: false,
    seeded: true,
    description: "Raw logged minutes (appraisal-unsafe alone: hours are not value; §5.2)",
    factColumns: { numerator: "minutes_logged" },
  },
  {
    no: 12,
    metricKey: "effort.billable_share",
    axis: "effort",
    displayUnit: "percent",
    registryUnit: "ratio",
    aggregationRule: "ratio_of_sums",
    rangeClass: "ratio",
    grains: ["person", "project", "department", "company"],
    // §5's table marks this "✅ safe at D/C; ⚠ caution at P" — a CONDITIONAL safety, not a plain
    // safe. An appraisal pack is built at PERSON grain, exactly the grain the table cautions
    // against, so `appraisalSafe` is false here. This is also what makes §5's prose count
    // ("nine appraisal-safe metrics") match the table: without this resolution the table's raw
    // checkmarks would count to ten. TR-08's acceptance bar is explicit about the 9/13 split, so
    // this is a deliberate reading, not an oversight — flagged for TR-24 (appraisal engine) to
    // apply the D/C-only nuance explicitly if a richer-than-boolean model is ever needed.
    appraisalSafe: false,
    seeded: true,
    description: "Billable minutes over logged minutes (conditionally safe at D/C ONLY; unsafe at person grain, which is what an appraisal pack uses — §5 table)",
    factColumns: { numerator: "minutes_billable", denominator: "minutes_logged" },
  },
  {
    no: 13,
    metricKey: "effort.estimate_accuracy",
    axis: "effort",
    displayUnit: "percent",
    registryUnit: "ratio",
    aggregationRule: "ratio_of_sums",
    rangeClass: "ratio",
    grains: ["person", "project", "department"],
    appraisalSafe: true,
    seeded: true,
    description:
      "Estimate over actual, for completed tasks that carry BOTH (§15 ruling ②'s second gap — estimate_minutes_completed and minutes_logged live on separate axes in the base grain, so 0057 adds matched counters). Display with a band (±25% is 'good', not 100%)",
    factColumns: {
      numerator: "estimate_minutes_completed_with_actual",
      denominator: "minutes_logged_completed_with_actual",
    },
  },
  {
    no: 14,
    metricKey: "effort.capacity_utilization",
    axis: "effort",
    displayUnit: "percent",
    registryUnit: "ratio",
    aggregationRule: "ratio_of_sums",
    rangeClass: "ratio",
    grains: ["person", "department", "company"],
    appraisalSafe: false,
    seeded: true,
    description: "Logged minutes over expected calendar minutes (presence proxy; ops capacity planning only)",
  },
  {
    no: 15,
    metricKey: "collab.contributed_minutes",
    axis: "collaboration",
    displayUnit: "minutes",
    registryUnit: "minutes",
    aggregationRule: "sum",
    rangeClass: "additive",
    grains: ["person", "department", "company"],
    appraisalSafe: true,
    seeded: true,
    description: "Credited contributor-role minutes on OTHER people's tasks (real logged time helping)",
    factColumns: { numerator: "minutes_contributed" },
  },
  {
    no: 16,
    metricKey: "collab.comments_authored",
    axis: "collaboration",
    displayUnit: "count",
    registryUnit: "count",
    aggregationRule: "sum",
    rangeClass: "additive",
    grains: ["person", "project", "department"],
    appraisalSafe: false,
    seeded: true,
    description: "Raw comment count (chatter is gameable)",
    factColumns: { numerator: "comments_authored" },
  },
  {
    no: 17,
    metricKey: "collab.docs_updated",
    axis: "collaboration",
    displayUnit: "count",
    registryUnit: "count",
    aggregationRule: "sum",
    rangeClass: "additive",
    grains: ["person", "project", "department"],
    appraisalSafe: false,
    seeded: true,
    description: "Raw doc-update count (unsafe raw; pack shows cohort band only)",
    factColumns: { numerator: "docs_updated" },
  },
  {
    no: 18,
    metricKey: "discipline.checkin_compliance",
    axis: "discipline",
    displayUnit: "percent",
    registryUnit: "ratio",
    aggregationRule: "ratio_of_sums",
    rangeClass: "ratio",
    grains: ["person", "department", "company"],
    appraisalSafe: true,
    seeded: true,
    description: "Submitted check-ins over expected (calendar + leave + attendance aware, §5.3)",
  },
  {
    no: 19,
    metricKey: "discipline.time_logging_coverage",
    axis: "discipline",
    displayUnit: "percent",
    registryUnit: "ratio",
    aggregationRule: "ratio_of_sums",
    rangeClass: "ratio",
    grains: ["person", "department", "company"],
    appraisalSafe: true,
    seeded: true,
    description: "Days with >=1 logged time entry over expected working days (hygiene, not volume)",
  },
  {
    no: 20,
    metricKey: "discipline.overdue_open",
    axis: "discipline",
    displayUnit: "count",
    registryUnit: "count",
    aggregationRule: "last",
    rangeClass: "non_additive",
    grains: ["person", "project", "department", "company"],
    appraisalSafe: false,
    seeded: true,
    description:
      "Open tasks past due, evaluated AT THE RANGE END (point-in-time — §5.4; NOT a sum, or a 30-day range would count the same still-overdue task ~30x). Pack shows trend only",
  },
  {
    no: 21,
    metricKey: "evidence.link_rate",
    axis: "evidence",
    displayUnit: "percent",
    registryUnit: "ratio",
    aggregationRule: "ratio_of_sums",
    rangeClass: "ratio",
    grains: ["person", "department", "company"],
    appraisalSafe: false,
    seeded: true,
    description: "Exactly-linked activity over all activity events (measures the linker, not the person)",
    factColumns: { numerator: "activity_linked_exact", denominator: "activity_events" },
  },
  {
    no: 22,
    metricKey: "evidence.source_diversity",
    axis: "evidence",
    displayUnit: "count",
    registryUnit: "count",
    aggregationRule: "last", // irrelevant — never seeded; kept only so the type stays total
    rangeClass: "non_additive",
    grains: ["person", "department", "company"],
    appraisalSafe: false,
    seeded: false,
    // ⚠ MCP REACHABILITY (TR-43, §15 2026-08-01): `seeded: false` here is not merely a storage
    // detail — it means this metric is STRUCTURALLY ABSENT from `GET /reports/metrics` and
    // therefore from the `reports.getMetrics` MCP tool, because both read `computeReportRangeRows`
    // (document-builder.ts's `computeRangeRows`), which walks `rollup_metrics`-shaped rows built
    // from `report_work_facts` counters only — #22 never has one. It is ONLY ever produced inside
    // `buildKpis()` (document-builder.ts), which special-cases this exact `metricKey` before the
    // generic row lookup and feeds it from a separate `sourceDiversity` param, not `rows`. Concretely:
    // an agent calling `reports.getMetrics` with `metricKey: "evidence.source_diversity"` gets an
    // EMPTY array, not an error and not a value — call `reports.getDocument` instead and read the
    // `evidence.source_diversity` entry out of the returned `ReportDocument.kpis` (it carries
    // `distinctOver: true`). This is the ONLY entry in this catalog with `seeded: false`; if a future
    // metric is ever added with `seeded: false`, it inherits the identical gap and needs the same
    // callout in `reports.getMetrics`'s tool description (src/modules/reports/index.ts).
    description:
      "COUNT(DISTINCT source) unioned over the range — NOT the sum of daily distinct counts (Mon {pm}, Tue {github} → 2, not the sum of two 1s). No `aggregation_rule` expresses a distinct-union and 'max' is wrong, not merely imprecise, so this is never written to metric_definitions; it is computed read-time as a key-union over report_work_facts.activity_by_source and carried as a ReportKpi with distinctOver:true. NOT reachable via GET /reports/metrics or the reports.getMetrics MCP tool (see reports.getDocument instead) — this row's absence from rollup_metrics/report_work_facts-derived rows is structural, not a bug.",
  },
];

export const SEEDED_REPORT_METRICS: readonly ReportMetricDef[] = REPORT_METRICS.filter((m) => m.seeded);

/** Exactly 21 per §15's soundness-pass ruling — asserted so a future edit that accidentally flips
 *  a `seeded` flag (or adds a 23rd metric without updating this comment) fails loudly at import
 *  time rather than silently miscounting the migration's seed rows. */
if (SEEDED_REPORT_METRICS.length !== 21) {
  throw new Error(`REPORT_METRICS must seed exactly 21 rows, got ${SEEDED_REPORT_METRICS.length}`);
}

/** §5's prose: "Nine appraisal-safe metrics feed the four appraisal axes; the other thirteen exist
 *  for ops truth and report richness." Guarded the same way as the seed count above — a metric
 *  silently flipping to appraisal-safe would put a gameable number into someone's review. */
const APPRAISAL_SAFE_COUNT = REPORT_METRICS.filter((m) => m.appraisalSafe).length;
if (APPRAISAL_SAFE_COUNT !== 9) {
  throw new Error(`REPORT_METRICS must have exactly 9 appraisal-safe metrics, got ${APPRAISAL_SAFE_COUNT}`);
}

export function getReportMetric(metricKey: string): ReportMetricDef {
  const found = REPORT_METRICS.find((m) => m.metricKey === metricKey);
  if (!found) throw new Error(`unknown report metric: ${metricKey}`);
  return found;
}

/** Projects the catalog's seeded rows into the shared `MetricDef` shape the rollup engine's
 *  `RollupProvider.metrics` (and `syncMetricDefinitions()`) consume. `isMonetary` is always false —
 *  payroll/compensation is an explicit non-goal (§1). */
export function toMetricDefs(): MetricDef[] {
  return SEEDED_REPORT_METRICS.map((m) => ({
    metricKey: m.metricKey,
    description: m.description,
    unit: m.registryUnit,
    isMonetary: false,
    aggregationRule: m.aggregationRule,
  }));
}

// ═══════════════════════════════ period-range convention (TR-08) ═══════════════════════════════
//
// `rollups/engine.ts`'s `RollupProvider.compute(client, tenantId, period)` takes one opaque
// `period` string per call — every OTHER module's provider treats it as a single label (a day, or
// a 'YYYY-MM' month), which is fine because none of them need §5.4's range-additivity discipline.
// The reports provider is different: day/week/month numbers must all be Σ-over-actual-days
// (invariant 2, ruling ③ — "never assumed 7 or 30"), so it needs the ACTUAL [start, end] window,
// not just a label. This module therefore defines `period` as an explicit inclusive range,
// `'YYYY-MM-DD:YYYY-MM-DD'` — the ONLY convention this file governs; no other module's periods
// change. TR-13 (the live document builder) and TR-15 (sealing) must format/parse periods the
// SAME way when they upsert into `rollup_metrics`, so this is exported, not duplicated.
export interface PeriodRange {
  start: string;
  end: string;
  /** Inclusive day count — the denominator for every days-denominated ratio (ruling ③). */
  days: number;
}

const PERIOD_RANGE_RE = /^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/;

/** Inclusive day count between two 'YYYY-MM-DD' dates (UTC calendar days — same basis as
 *  fact-job.ts / dept-resolution.ts's todayIso). */
export function inclusiveDayCount(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  return Math.floor((b - a) / 86_400_000) + 1;
}

export function formatPeriodRange(start: string, end: string): string {
  return `${start}:${end}`;
}

export function parsePeriodRange(period: string): PeriodRange {
  const m = PERIOD_RANGE_RE.exec(period);
  if (!m) {
    throw new Error(`reports rollup period must be 'YYYY-MM-DD:YYYY-MM-DD', got: ${JSON.stringify(period)}`);
  }
  const [, start, end] = m;
  if (end < start) throw new Error(`reports rollup period end (${end}) precedes start (${start})`);
  return { start, end, days: inclusiveDayCount(start, end) };
}
