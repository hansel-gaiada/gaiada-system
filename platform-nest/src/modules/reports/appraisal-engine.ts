// TR-24 — the appraisal engine: cohort banding, weight resolution, generate (freeze weights +
// auto_inputs from sealed calendar periods only), submit validation (mandatory commentary +
// deviation-justification), staleness detection, ack, finalize. Framework-agnostic (no Nest
// imports) — same "pure core / I/O at the edges, discriminated result shapes" split
// report-seal.ts/report-periods.ts use; appraisals.controller.ts maps results to HTTP status.
//
// ─────────────────────────────── WHY THIS TICKET MATTERS (§5.2, §11, §15) ───────────────────────
// This is the program's most consequential surface: these rows describe real people and are used
// to make real decisions about them. Every anti-gaming rule below is the ethical core, not a
// preference — see each function's comment for exactly which §5.2 rule it enforces and how.
//
// ─────────────────────────────── DISCLOSED DESIGN DECISIONS (genuine judgment calls, not spec) ───
// The blueprint specifies the RULES (freeze from sealed periods, ±1 band deviation, ≥50 char
// commentary, append-only acks, small-cohort guard) but leaves several data-model questions open
// that migration 0068 (deliberately schema-only) does not answer either. Each is resolved here,
// documented, and reported — never silently guessed:
//
// 1. **"Covering sealed calendar periods" = calendar MONTHS.** The cycle's [periodStart, periodEnd]
//    (0068's own RLS-test fixture: a half-year, 2026-07-01..2026-12-31) is decomposed into calendar
//    months (matching §10's `reports-monthly-seal` cadence) via report-periods.ts's own
//    `ensureCalendarPeriodRows` lazy-backstop — the SAME vivify-on-read pattern the periods
//    endpoints already use, not a second implementation. ALL months overlapping the range must be
//    `sealed`, else 409. If any EXISTING `period_kind='custom'` row overlaps the cycle window, this
//    is 422 BEFORE the calendar check even runs — per §0057 rule 2 / §15, never a silent skip.
// 2. **Role-cohort key resolution.** `report_appraisal_cycles.role_weights` keys are HR-authored
//    free strings (e.g. "senior_dev") with no canonical mapping to anything else in the schema.
//    `generate`'s roster accepts an explicit per-subject `roleKey` override (HR's authoritative
//    input); when omitted, this falls back to a normalized `users.title` (best-effort, NOT
//    guaranteed to match a `role_weights` key — falls through to `default_weights` when it
//    doesn't). Subjects with no resolvable role at all are grouped into one `__unassigned__`
//    cohort — a disclosed, coarse fallback, NOT a true role-cohort (cross-role comparison is
//    exactly what §5.2 point 3 forbids); HR should pass explicit `roleKey`s for meaningful bands.
// 3. **Cohorts are computed per `generate` CALL, not merged across separate calls to the same
//    cycle.** A later call adding more subjects to an existing cycle computes its own new subjects'
//    cohort independently — never retroactively re-bands an already-generated (frozen) appraisal,
//    consistent with §5.2 point 5/8 ("a later config/metric change must never retroactively rewrite
//    a person's score"). A follow-up ticket may want true cross-call cohort continuity; flagged,
//    not built, here.
// 4. **Two of the nine appraisal-safe metrics have no weighted-axis home.** `report_appraisal_
//    cycles.default_weights`/`role_weights` (0068, un-touchable per the brief) carry exactly FOUR
//    keys: delivery/quality/effort/collaboration. Metrics #18/#19 (axis:"discipline") ARE
//    appraisal-safe and DO get banded into `cohortBands` (with `informationalOnly: true`), but they
//    never feed `scores`/`composite` — there is no discipline axis to weight. This is the schema's
//    own shape, not something this ticket can silently work around without inventing a fifth weight
//    key the migration doesn't have.
// 5. **Axis auto-band = rounded average of that axis's bandable constituent metrics.** Delivery
//    has three safe person-grain metrics (#1/#3/#4); quality/effort/collaboration each have one
//    (#9/#13/#15). Where more than one metric shares an axis, the axis-level "auto" reference score
//    the manager compares against is their rounded mean band (clamped 1-5); null when every
//    constituent metric was small-cohort-suppressed.
import type { PoolClient } from "pg";
import { newId, withGlobal, withTenants } from "../../db";
import { config } from "../../config";
import { emitEvent } from "../../events/outbox.service";
import { REPORT_METRICS } from "./metrics";
import { ensureCalendarPeriodRows, type PeriodRow } from "./report-periods";
import { fetchSealedDocument } from "./report-seal";
import { humanizeMetricKey } from "./document-builder";
import type {
  AppraisalAckAction,
  AppraisalAckEntry,
  AppraisalAxis,
  AppraisalAxisScore,
  AppraisalCycleRow,
  AppraisalPack,
  AppraisalStatus,
  CohortBandDatum,
} from "./appraisal-document";

export const APPRAISAL_MODULES = { modules: ["reports"] };

export const APPRAISAL_AXES: AppraisalAxis[] = ["delivery", "quality", "effort", "collaboration"];

/** §5.2 point 3's small-cohort guard: bands are computed ONLY when the cohort has >=5 members in
 *  the cycle; below that, the pack shows raw safe metrics + denominators and NO band. */
export const SMALL_COHORT_THRESHOLD = 5;

/** §5.2 point 4: a manager overriding the computed band by more than this many bands requires a
 *  written per-axis justification. */
export const DEVIATION_THRESHOLD = 1;

export const MIN_COMMENTARY_LENGTH = 50;

// ═══════════════════════════════ PURE — role key + weight resolution ═══════════════════════════

/** Best-effort normalization of a free-text `users.title` into a role-cohort key
 *  ("Senior Developer" -> "senior_developer"). See file header point 2 — this is a documented
 *  fallback, not a guaranteed match to `role_weights`' HR-authored keys. */
export function normalizeRoleKey(title: string | null | undefined): string | null {
  if (!title) return null;
  const norm = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return norm.length > 0 ? norm : null;
}

/** §5.2 point 5: weights frozen at generate time. `role_weights[roleKey]` overrides
 *  `default_weights` when present; falls back to defaults otherwise (unresolved role, or a role
 *  key the cycle has no override for). */
export function resolveWeights(cycle: Pick<AppraisalCycleRow, "defaultWeights" | "roleWeights">, roleKey: string | null): Record<AppraisalAxis, number> {
  const override = roleKey ? cycle.roleWeights[roleKey] : undefined;
  return override ?? cycle.defaultWeights;
}

// ═══════════════════════════════ PURE — cohort banding (§5.2 points 2/3/4) ═══════════════════════

/** The eight appraisal-safe metrics actually usable at PERSON grain (metrics.ts's #5
 *  `milestone_hit_rate` is safe but project/department/company-only — never appears on an
 *  individual's appraisal). Derived directly from the catalog (never hand-copied) so a future
 *  catalog edit cannot silently drift from what this engine reads. */
export const PERSON_SAFE_METRICS = REPORT_METRICS.filter((m) => m.appraisalSafe && m.grains.includes("person"));

if (PERSON_SAFE_METRICS.length !== 8) {
  throw new Error(`PERSON_SAFE_METRICS must be exactly 8 (9 appraisal-safe minus #5, project-only), got ${PERSON_SAFE_METRICS.length}`);
}

type MetricOrientation = "higher_better" | "lower_better" | "closer_to_one";

/** Per-metric directionality for banding purposes. NOT importable from document-builder.ts (its
 *  own `METRIC_DIRECTION` map is private, and that file is out of scope for this ticket to touch) —
 *  a small, deliberately narrow duplicate covering only the 8 metrics this engine needs, each
 *  justified: `flow.reopen_rate` is down_good (fewer reopens is better); `effort.estimate_accuracy`
 *  is neither up- nor down-good — the doc's own words are "±25% is 'good', not 100%" (over- AND
 *  under-estimating are both worse than accurate), so it bands on CLOSENESS to 1.0, not magnitude.
 *  Every other safe person-grain metric is a plain "more is better". */
const SAFE_METRIC_ORIENTATION: Record<string, MetricOrientation> = {
  "delivery.throughput_weighted": "higher_better",
  "delivery.on_time_rate": "higher_better",
  "delivery.estimate_coverage": "higher_better",
  "flow.reopen_rate": "lower_better",
  "effort.estimate_accuracy": "closer_to_one",
  "collab.contributed_minutes": "higher_better",
  "discipline.checkin_compliance": "higher_better",
  "discipline.time_logging_coverage": "higher_better",
};

function orientationScore(metricKey: string, value: number): number {
  const orientation = SAFE_METRIC_ORIENTATION[metricKey] ?? "higher_better";
  if (orientation === "lower_better") return -value;
  if (orientation === "closer_to_one") return -Math.abs(value - 1);
  return value;
}

/** 0-100 percentile rank of `value` within `cohortScores` (which includes the subject's own
 *  score) — fraction strictly below, plus half of exact ties, so a tied value lands at the tie
 *  group's midpoint rather than arbitrarily above or below its peers. */
export function percentileRank(cohortScores: number[], value: number): number {
  if (cohortScores.length <= 1) return 50;
  const below = cohortScores.filter((s) => s < value).length;
  const tied = cohortScores.filter((s) => s === value).length;
  const rank = below + tied / 2;
  return Math.round((rank / cohortScores.length) * 100);
}

/** Quintile banding: P0-19 -> 1 ... P80-100 -> 5. */
export function bandForPercentile(p: number): 1 | 2 | 3 | 4 | 5 {
  if (p < 20) return 1;
  if (p < 40) return 2;
  if (p < 60) return 3;
  if (p < 80) return 4;
  return 5;
}

export interface SubjectMetricValue {
  value: number;
  numerator?: number;
  denominator?: number;
}

/** Cohort banding for ONE metric across ALL subjects sharing a cohort (§5.2 points 2/3/4). Pure —
 *  every input is already-gathered raw metric values. The small-cohort guard is enforced HERE,
 *  once, for every metric: below `SMALL_COHORT_THRESHOLD` members, `band`/`subjectPercentile` are
 *  both omitted (never just the band — a percentile in a 3-person cohort is as identifying as the
 *  band itself). Every safe rate still carries its numerator/denominator regardless (§5.2 point
 *  2) — banding and denominator-honesty are independent guarantees. */
export function computeCohortBands(cohortMetrics: Map<string, Map<string, SubjectMetricValue>>): Map<string, CohortBandDatum[]> {
  const out = new Map<string, CohortBandDatum[]>();
  const subjectIds = [...cohortMetrics.keys()];
  for (const m of PERSON_SAFE_METRICS) {
    const present = subjectIds.filter((id) => cohortMetrics.get(id)!.has(m.metricKey));
    const bandable = present.length >= SMALL_COHORT_THRESHOLD;
    const scores = present.map((id) => orientationScore(m.metricKey, cohortMetrics.get(id)!.get(m.metricKey)!.value));
    for (const subjectId of present) {
      const raw = cohortMetrics.get(subjectId)!.get(m.metricKey)!;
      let subjectPercentile: number | undefined;
      let band: 1 | 2 | 3 | 4 | 5 | null = null;
      if (bandable) {
        subjectPercentile = percentileRank(scores, orientationScore(m.metricKey, raw.value));
        band = bandForPercentile(subjectPercentile);
      }
      const datum: CohortBandDatum = {
        metricKey: m.metricKey,
        metricLabel: humanizeMetricKey(m.metricKey),
        unit: m.displayUnit,
        subjectValue: raw.value,
        ...(raw.numerator !== undefined ? { numerator: raw.numerator } : {}),
        ...(raw.denominator !== undefined ? { denominator: raw.denominator } : {}),
        ...(subjectPercentile !== undefined ? { subjectPercentile } : {}),
        band,
        cohortSize: present.length,
        axis: m.axis,
        informationalOnly: !(APPRAISAL_AXES as string[]).includes(m.axis),
      };
      (out.get(subjectId) ?? out.set(subjectId, []).get(subjectId)!).push(datum);
    }
  }
  return out;
}

/** Aggregates each of the four weighted axes' auto-band from its bandable constituent safe
 *  metrics (file header point 5). Discipline metrics (`informationalOnly`) are excluded — they
 *  have no weighted axis to feed. */
export function axisAutoScores(bands: CohortBandDatum[]): Record<AppraisalAxis, number | null> {
  const out: Record<AppraisalAxis, number | null> = { delivery: null, quality: null, effort: null, collaboration: null };
  for (const axis of APPRAISAL_AXES) {
    const relevant = bands.filter((b) => b.axis === axis && !b.informationalOnly && b.band !== null);
    if (relevant.length === 0) continue;
    const avg = relevant.reduce((s, b) => s + (b.band as number), 0) / relevant.length;
    out[axis] = Math.min(5, Math.max(1, Math.round(avg)));
  }
  return out;
}

// ═══════════════════════════════ PURE — composite + deviation + commentary ══════════════════════

/** Σ weight * manager-score, the four weighted axes only. Null (not computable) until every axis
 *  has a manager score. */
export function computeComposite(weights: Record<AppraisalAxis, number>, scores: Record<AppraisalAxis, AppraisalAxisScore>): number | null {
  let sum = 0;
  for (const axis of APPRAISAL_AXES) {
    const s = scores[axis]?.manager;
    if (s === null || s === undefined) return null;
    sum += (weights[axis] ?? 0) * s;
  }
  return Math.round(sum * 100) / 100;
}

/** §5.2 point 4: which axes have a manager score that deviates from the auto band by MORE than
 *  `DEVIATION_THRESHOLD` bands WITHOUT a non-empty `note`. An axis with no computable auto band
 *  (small-cohort-suppressed, or no applicable metric) has nothing to deviate from and is never
 *  flagged — there is no baseline to compare against. */
export function findMissingDeviationNotes(weights: Record<AppraisalAxis, number>, scores: Record<AppraisalAxis, AppraisalAxisScore>): AppraisalAxis[] {
  const missing: AppraisalAxis[] = [];
  for (const axis of APPRAISAL_AXES) {
    const s = scores[axis];
    if (!s || s.manager === null || s.manager === undefined) continue;
    if (s.auto === null || s.auto === undefined) continue;
    if (Math.abs(s.manager - s.auto) > DEVIATION_THRESHOLD && !(s.note && s.note.trim().length > 0)) missing.push(axis);
  }
  return missing;
}

export function isValidCommentary(commentary: string | undefined | null): boolean {
  return !!commentary && commentary.trim().length >= MIN_COMMENTARY_LENGTH;
}

// ═══════════════════════════════ I/O — covering sealed periods (§0057 rule 2 / §15) ════════════

export type CoveringPeriodsResult =
  | { ok: true; periods: PeriodRow[] }
  | { ok: false; reason: "unsealed"; unsealed: { periodStart: string; periodEnd: string; status: string }[] }
  | { ok: false; reason: "custom_overlap"; overlapping: { id: string; periodStart: string; periodEnd: string }[] };

/** Generate freezes weights + auto_inputs from SEALED CALENDAR periods only (§ acceptance bar).
 *  See file header point 1 for why "covering periods" = calendar months. The custom-overlap check
 *  runs BEFORE the calendar check — §0057 rule 2 / §15: an ad-hoc pinned range under an appraisal
 *  cycle's window must 422 loudly, never be silently skipped in favour of whatever calendar months
 *  happen to also exist. */
export async function findCoveringPeriods(tenantId: string, cycleStart: string, cycleEnd: string): Promise<CoveringPeriodsResult> {
  const { rows: customRows } = await withTenants(
    [tenantId],
    (c) =>
      c.query<{ id: string; period_start: string; period_end: string }>(
        `SELECT id, period_start::text AS period_start, period_end::text AS period_end
           FROM report_periods
          WHERE tenant_id = $1 AND period_kind = 'custom' AND period_start <= $3::date AND period_end >= $2::date`,
        [tenantId, cycleStart, cycleEnd],
      ),
    APPRAISAL_MODULES,
  );
  if (customRows.length > 0) {
    return { ok: false, reason: "custom_overlap", overlapping: customRows.map((r) => ({ id: r.id, periodStart: r.period_start, periodEnd: r.period_end })) };
  }

  const months = await ensureCalendarPeriodRows(tenantId, "month", cycleStart, cycleEnd);
  const unsealed = months.filter((m) => m.status !== "sealed");
  if (unsealed.length > 0) {
    return { ok: false, reason: "unsealed", unsealed: unsealed.map((m) => ({ periodStart: m.periodStart, periodEnd: m.periodEnd, status: m.status })) };
  }
  return { ok: true, periods: months };
}

/** Detects whether ANY of this appraisal's pinned periods has been re-sealed to a revision
 *  different from the one frozen at generate time (§15: "amend of a pinned revision flips
 *  evidence_stale... the schema cannot enforce this — staleness detection is the ENGINE's job"). */
export async function detectStaleness(tenantId: string, evidence: { periodIds: string[]; revisions: Record<string, number> }): Promise<boolean> {
  if (evidence.periodIds.length === 0) return false;
  const { rows } = await withTenants(
    [tenantId],
    (c) => c.query<{ id: string; revision: number }>(`SELECT id, revision FROM report_periods WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tenantId, evidence.periodIds]),
    APPRAISAL_MODULES,
  );
  return rows.some((r) => evidence.revisions[r.id] !== undefined && evidence.revisions[r.id] !== r.revision);
}

/** §5.2 point 1's anti-slicing correctness extended across a MULTI-period cycle: additive safe
 *  metrics (#1/#15) sum across the covering periods' already-sealed values; ratio safe metrics
 *  (#3/#4/#9/#13/#18/#19) sum numerator/denominator SEPARATELY across periods and divide once at
 *  the end (§5.4 — never average the per-period ratios). Reads exclusively from `report_documents`
 *  via `fetchSealedDocument`, pinned to each period's OWN revision (never "latest") — the frozen
 *  evidence this engine reports is exactly what was sealed, not whatever the period looks like now. */
export async function aggregateSubjectMetrics(tenantId: string, subjectUserId: string, periods: PeriodRow[]): Promise<Map<string, SubjectMetricValue>> {
  const totals = new Map<string, { sumNumerator: number; sumDenominator: number; isRatio: boolean }>();
  for (const period of periods) {
    const doc = await fetchSealedDocument(tenantId, period.id, "person", subjectUserId, period.revision);
    if (!doc) continue; // legitimately empty scope for this month — "empty but valid", never an error
    for (const m of PERSON_SAFE_METRICS) {
      const kpi = doc.kpis.find((k) => k.metricKey === m.metricKey);
      if (!kpi) continue;
      const isRatio = m.aggregationRule === "ratio_of_sums";
      const entry = totals.get(m.metricKey) ?? { sumNumerator: 0, sumDenominator: 0, isRatio };
      if (isRatio) {
        entry.sumNumerator += kpi.numerator ?? 0;
        entry.sumDenominator += kpi.denominator ?? 0;
      } else {
        entry.sumNumerator += kpi.value;
      }
      totals.set(m.metricKey, entry);
    }
  }
  const out = new Map<string, SubjectMetricValue>();
  for (const m of PERSON_SAFE_METRICS) {
    const entry = totals.get(m.metricKey);
    if (!entry) {
      out.set(m.metricKey, { value: 0 });
      continue;
    }
    if (entry.isRatio) {
      out.set(m.metricKey, {
        value: entry.sumDenominator > 0 ? entry.sumNumerator / entry.sumDenominator : 0,
        numerator: entry.sumNumerator,
        denominator: entry.sumDenominator,
      });
    } else {
      out.set(m.metricKey, { value: entry.sumNumerator });
    }
  }
  return out;
}

// ═══════════════════════════════ I/O — generate ═══════════════════════════════

export interface GenerateSubjectInput {
  subjectUserId: string;
  managerUserId: string;
  /** Explicit override — takes precedence over `users.title` normalization (file header point 2). */
  roleKey?: string;
}

export interface GenerateResult {
  generated: string[];
  skippedExisting: string[];
}

export type GenerateOutcome = { ok: true; result: GenerateResult } | { ok: false; reason: "unsealed" | "custom_overlap"; detail: unknown };

/** `POST /appraisals/cycles/:id/generate`'s whole flow. Idempotent per subject (ON CONFLICT DO
 *  NOTHING on `(tenant_id, cycle_id, subject_user_id)`) — re-running generate with a wider roster
 *  only creates rows for subjects who don't already have one; an existing appraisal's frozen
 *  weights/auto_inputs are NEVER touched by a later call (§5.2 point 5/8). */
export async function generateCycleAppraisals(tenantId: string, cycle: AppraisalCycleRow, roster: GenerateSubjectInput[]): Promise<GenerateOutcome> {
  const covering = await findCoveringPeriods(tenantId, cycle.periodStart, cycle.periodEnd);
  if (!covering.ok) {
    return { ok: false, reason: covering.reason, detail: covering.reason === "unsealed" ? covering.unsealed : covering.overlapping };
  }

  const { rows: existingRows } = await withTenants(
    [tenantId],
    (c) => c.query<{ subject_user_id: string }>(`SELECT subject_user_id FROM report_appraisals WHERE tenant_id = $1 AND cycle_id = $2`, [tenantId, cycle.id]),
    APPRAISAL_MODULES,
  );
  const existing = new Set(existingRows.map((r) => r.subject_user_id));
  const toGenerate = roster.filter((s) => !existing.has(s.subjectUserId));
  const skippedExisting = roster.filter((s) => existing.has(s.subjectUserId)).map((s) => s.subjectUserId);
  if (toGenerate.length === 0) return { ok: true, result: { generated: [], skippedExisting } };

  const titleRows = await withGlobal((c) =>
    c.query<{ id: string; title: string | null }>(`SELECT id, title FROM users WHERE id = ANY($1::uuid[])`, [toGenerate.map((s) => s.subjectUserId)]),
  );
  const titleById = new Map(titleRows.rows.map((r) => [r.id, r.title]));
  const roleKeyBySubject = new Map<string, string | null>();
  for (const s of toGenerate) roleKeyBySubject.set(s.subjectUserId, s.roleKey ?? normalizeRoleKey(titleById.get(s.subjectUserId) ?? null));

  const metricsBySubject = new Map<string, Map<string, SubjectMetricValue>>();
  for (const s of toGenerate) metricsBySubject.set(s.subjectUserId, await aggregateSubjectMetrics(tenantId, s.subjectUserId, covering.periods));

  // Cohort = subjects in THIS roster sharing the same resolved role key (file header points 2/3).
  const cohortGroups = new Map<string, string[]>();
  for (const s of toGenerate) {
    const key = roleKeyBySubject.get(s.subjectUserId) ?? "__unassigned__";
    (cohortGroups.get(key) ?? cohortGroups.set(key, []).get(key)!).push(s.subjectUserId);
  }
  const bandsBySubject = new Map<string, CohortBandDatum[]>();
  for (const subjectIds of cohortGroups.values()) {
    const cohortMetrics = new Map(subjectIds.map((id) => [id, metricsBySubject.get(id)!]));
    for (const [subjectId, bands] of computeCohortBands(cohortMetrics)) bandsBySubject.set(subjectId, bands);
  }

  const evidence = {
    periodIds: covering.periods.map((p) => p.id),
    revisions: Object.fromEntries(covering.periods.map((p) => [p.id, p.revision])),
  };
  // Pin the LAST covering period as the schema's single `period_id`/`revision` anchor (0068's
  // composite-FK columns) — the full multi-period evidence set lives in `evidence` above. "Last"
  // (closest to the cycle's own end date) is the most natural single anchor; not itself
  // load-bearing for staleness (which walks the FULL `evidence.periodIds` set, not just the anchor).
  const anchor = covering.periods[covering.periods.length - 1];

  const generatedIds: string[] = [];
  await withTenants(
    [tenantId],
    async (c: PoolClient) => {
      for (const s of toGenerate) {
        const bands = bandsBySubject.get(s.subjectUserId) ?? [];
        const autoScores = axisAutoScores(bands);
        const weights = resolveWeights(cycle, roleKeyBySubject.get(s.subjectUserId) ?? null);
        const scores: Record<AppraisalAxis, AppraisalAxisScore> = {
          delivery: { auto: autoScores.delivery, manager: null },
          quality: { auto: autoScores.quality, manager: null },
          effort: { auto: autoScores.effort, manager: null },
          collaboration: { auto: autoScores.collaboration, manager: null },
        };
        const id = newId();
        const autoInputs = { metrics: Object.fromEntries(metricsBySubject.get(s.subjectUserId)!), cohortBands: bands };
        const res = await c.query<{ id: string }>(
          `INSERT INTO report_appraisals
             (id, tenant_id, cycle_id, subject_user_id, manager_user_id, role_key, weights, auto_inputs,
              scores, evidence, period_id, revision, status, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,'draft',$13)
           ON CONFLICT (tenant_id, cycle_id, subject_user_id) DO NOTHING
           RETURNING id`,
          [
            id,
            tenantId,
            cycle.id,
            s.subjectUserId,
            s.managerUserId,
            roleKeyBySubject.get(s.subjectUserId) ?? null,
            JSON.stringify(weights),
            JSON.stringify(autoInputs),
            JSON.stringify(scores),
            JSON.stringify(evidence),
            anchor.id,
            anchor.revision,
            config.originSite,
          ],
        );
        if (res.rows[0]) {
          generatedIds.push(res.rows[0].id);
          await emitEvent(c, tenantId, "report_appraisal", res.rows[0].id, "reports.appraisal.generated", {
            cycleId: cycle.id,
            subjectUserId: s.subjectUserId,
            managerUserId: s.managerUserId,
          });
        }
      }
    },
    APPRAISAL_MODULES,
  );

  return { ok: true, result: { generated: generatedIds, skippedExisting } };
}

// ═══════════════════════════════ I/O — appraisal row read/patch/submit/ack/finalize ═════════════

export interface AppraisalRowShape {
  id: string;
  tenantId: string;
  cycleId: string;
  subjectUserId: string;
  managerUserId: string;
  roleKey: string | null;
  weights: Record<AppraisalAxis, number>;
  autoInputs: { metrics: Record<string, SubjectMetricValue>; cohortBands: CohortBandDatum[] };
  scores: Record<AppraisalAxis, AppraisalAxisScore>;
  composite: string | null; // numeric(4,2) — pg returns as string
  commentary: string | null;
  evidence: { periodIds: string[]; revisions: Record<string, number> };
  evidenceStale: boolean;
  periodId: string;
  revision: number;
  status: AppraisalStatus;
  submittedAt: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const APPRAISAL_COLUMNS = `
  id, tenant_id AS "tenantId", cycle_id AS "cycleId", subject_user_id AS "subjectUserId",
  manager_user_id AS "managerUserId", role_key AS "roleKey", weights, auto_inputs AS "autoInputs",
  scores, composite, commentary, evidence, evidence_stale AS "evidenceStale", period_id AS "periodId",
  revision, status, submitted_at::text AS "submittedAt", finalized_at::text AS "finalizedAt",
  created_at::text AS "createdAt", updated_at::text AS "updatedAt"
`;

export async function fetchAppraisalRow(tenantId: string, id: string): Promise<AppraisalRowShape | null> {
  const { rows } = await withTenants(
    [tenantId],
    (c) => c.query<AppraisalRowShape>(`SELECT ${APPRAISAL_COLUMNS} FROM report_appraisals WHERE tenant_id = $1 AND id = $2`, [tenantId, id]),
    APPRAISAL_MODULES,
  );
  return rows[0] ?? null;
}

export interface ListAppraisalFilter {
  cycleId?: string;
  subjectUserId?: string;
  managerUserId?: string;
  /** self/mine reads never see a draft — a subject's own pack is visible only once a manager has
   *  submitted it (§8: "self (own, status >= submitted)"). */
  minStatus?: "submitted";
}

const NON_DRAFT_STATUSES = ["submitted", "acknowledged", "disputed", "finalized"];

export async function listAppraisalRows(tenantId: string, filter: ListAppraisalFilter): Promise<AppraisalRowShape[]> {
  const clauses = ["tenant_id = $1"];
  const params: unknown[] = [tenantId];
  if (filter.cycleId) {
    params.push(filter.cycleId);
    clauses.push(`cycle_id = $${params.length}`);
  }
  if (filter.subjectUserId) {
    params.push(filter.subjectUserId);
    clauses.push(`subject_user_id = $${params.length}`);
  }
  if (filter.managerUserId) {
    params.push(filter.managerUserId);
    clauses.push(`manager_user_id = $${params.length}`);
  }
  if (filter.minStatus === "submitted") {
    params.push(NON_DRAFT_STATUSES);
    clauses.push(`status = ANY($${params.length})`);
  }
  const { rows } = await withTenants(
    [tenantId],
    (c) => c.query<AppraisalRowShape>(`SELECT ${APPRAISAL_COLUMNS} FROM report_appraisals WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`, params),
    APPRAISAL_MODULES,
  );
  return rows;
}

/** Hydrates the full read shape (§ "the contract you must define") from a raw row: resolves
 *  subject/manager/cycle names and the append-only ack trail. */
export async function hydrateAppraisalPack(tenantId: string, row: AppraisalRowShape): Promise<AppraisalPack> {
  const [names, cycleRows, ackRows] = await Promise.all([
    withGlobal((c) => c.query<{ id: string; name: string }>(`SELECT id, name FROM users WHERE id = ANY($1::uuid[])`, [[row.subjectUserId, row.managerUserId]])),
    withTenants([tenantId], (c) => c.query<{ name: string }>(`SELECT name FROM report_appraisal_cycles WHERE tenant_id = $1 AND id = $2`, [tenantId, row.cycleId]), APPRAISAL_MODULES),
    withTenants(
      [tenantId],
      (c) =>
        c.query<{ id: string; actor_user_id: string; action: AppraisalAckAction; comment: string | null; created_at: string }>(
          `SELECT id, actor_user_id, action, comment, created_at::text AS created_at
             FROM report_appraisal_acks WHERE tenant_id = $1 AND appraisal_id = $2 ORDER BY created_at`,
          [tenantId, row.id],
        ),
      APPRAISAL_MODULES,
    ),
  ]);
  const nameById = new Map(names.rows.map((r) => [r.id, r.name]));
  const actorIds = [...new Set(ackRows.rows.map((r) => r.actor_user_id))];
  const actorNames = actorIds.length ? await withGlobal((c) => c.query<{ id: string; name: string }>(`SELECT id, name FROM users WHERE id = ANY($1::uuid[])`, [actorIds])) : { rows: [] as { id: string; name: string }[] };
  const actorNameById = new Map(actorNames.rows.map((r) => [r.id, r.name]));

  const acks: AppraisalAckEntry[] = ackRows.rows.map((r) => ({
    id: r.id,
    appraisalId: row.id,
    actorUserId: r.actor_user_id,
    actorName: actorNameById.get(r.actor_user_id) ?? r.actor_user_id,
    action: r.action,
    comment: r.comment,
    createdAt: r.created_at,
  }));

  return {
    id: row.id,
    tenantId,
    cycleId: row.cycleId,
    cycleName: cycleRows.rows[0]?.name ?? row.cycleId,
    subjectUserId: row.subjectUserId,
    subjectName: nameById.get(row.subjectUserId) ?? row.subjectUserId,
    managerUserId: row.managerUserId,
    managerName: nameById.get(row.managerUserId) ?? row.managerUserId,
    roleKey: row.roleKey,
    weights: row.weights,
    scores: row.scores,
    composite: row.composite === null ? null : Number(row.composite),
    commentary: row.commentary,
    status: row.status,
    cohortBands: row.autoInputs?.cohortBands ?? [],
    evidence: row.evidence,
    evidenceStale: row.evidenceStale,
    periodId: row.periodId,
    revision: row.revision,
    submittedAt: row.submittedAt,
    finalizedAt: row.finalizedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    acks,
  };
}

// ---- patch (manager scores/commentary, draft only) + confirmEvidence ----

export interface PatchAppraisalInput {
  scores?: Partial<Record<AppraisalAxis, { manager?: number | null; note?: string }>>;
  commentary?: string;
  confirmEvidence?: boolean;
}

export type PatchResult = { ok: true; row: AppraisalRowShape } | { ok: false; reason: "not_found" | "not_draft" | "finalized" | "invalid_score" };

/** `PATCH /appraisals/:id`. `actorIsManager`/`actorIsHr` are computed by the CONTROLLER (Cerbos +
 *  the exact-match `managerUserId === principal.userId` check the coarse Cerbos `manager` grant
 *  cannot express) — this function trusts them, same house pattern as every other engine file's
 *  "validation at the edge, orchestration here" split. Score/commentary edits require the assigned
 *  manager AND draft status; `confirmEvidence` (§15's re-confirm path) is available to the
 *  assigned manager OR HR at any pre-finalize status, since staleness can surface after submit. */
export async function patchAppraisal(
  tenantId: string,
  id: string,
  input: PatchAppraisalInput,
  actorIsManager: boolean,
  actorIsHr: boolean,
): Promise<PatchResult> {
  const existing = await fetchAppraisalRow(tenantId, id);
  if (!existing) return { ok: false, reason: "not_found" };
  if (existing.status === "finalized") return { ok: false, reason: "finalized" };

  let evidence = existing.evidence;
  let evidenceStale = existing.evidenceStale;
  if (input.confirmEvidence) {
    if (!actorIsManager && !actorIsHr) return { ok: false, reason: "not_draft" };
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query<{ id: string; revision: number }>(`SELECT id, revision FROM report_periods WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tenantId, existing.evidence.periodIds]),
      APPRAISAL_MODULES,
    );
    evidence = { periodIds: existing.evidence.periodIds, revisions: Object.fromEntries(rows.map((r) => [r.id, r.revision])) };
    evidenceStale = false;
  }

  let scores = existing.scores;
  let commentary = existing.commentary;
  const wantsScoreEdit = input.scores !== undefined || input.commentary !== undefined;
  if (wantsScoreEdit) {
    if (!actorIsManager) return { ok: false, reason: "not_draft" };
    if (existing.status !== "draft") return { ok: false, reason: "not_draft" };
    if (input.scores) {
      scores = { ...existing.scores };
      for (const axis of APPRAISAL_AXES) {
        const patch = input.scores[axis];
        if (!patch) continue;
        if (patch.manager !== undefined && patch.manager !== null && (!Number.isInteger(patch.manager) || patch.manager < 1 || patch.manager > 5)) {
          return { ok: false, reason: "invalid_score" };
        }
        scores[axis] = {
          ...scores[axis],
          ...(patch.manager !== undefined ? { manager: patch.manager } : {}),
          ...(patch.note !== undefined ? { note: patch.note } : {}),
        };
      }
    }
    if (input.commentary !== undefined) commentary = input.commentary;
  }

  const { rows } = await withTenants(
    [tenantId],
    (c) =>
      c.query<AppraisalRowShape>(
        `UPDATE report_appraisals SET scores = $3::jsonb, commentary = $4, evidence = $5::jsonb, evidence_stale = $6, updated_at = now()
          WHERE tenant_id = $1 AND id = $2 RETURNING ${APPRAISAL_COLUMNS}`,
        [tenantId, id, JSON.stringify(scores), commentary, JSON.stringify(evidence), evidenceStale],
      ),
    APPRAISAL_MODULES,
  );
  return { ok: true, row: rows[0] };
}

// ---- submit ----

export type SubmitResult =
  | { ok: true; row: AppraisalRowShape }
  | { ok: false; reason: "not_found" | "not_draft" | "commentary_too_short" | "scores_incomplete" | "deviation_unjustified"; detail?: unknown };

/** `POST /appraisals/:id/submit`. Validates (§ acceptance bar): commentary >= 50 chars, every axis
 *  scored, and no unjustified >±1-band deviation — THEN computes the composite and flips status.
 *  The DB CHECK (`report_appraisals_commentary_required`) is a real backstop, not the only guard —
 *  this validates first so a bad submit returns a clean 400/422, not a raw constraint-violation
 *  500. */
export async function submitAppraisal(tenantId: string, id: string, commentary: string | undefined): Promise<SubmitResult> {
  const existing = await fetchAppraisalRow(tenantId, id);
  if (!existing) return { ok: false, reason: "not_found" };
  if (existing.status !== "draft") return { ok: false, reason: "not_draft" };

  const finalCommentary = commentary !== undefined ? commentary : existing.commentary ?? undefined;
  if (!isValidCommentary(finalCommentary)) return { ok: false, reason: "commentary_too_short" };

  for (const axis of APPRAISAL_AXES) {
    const s = existing.scores[axis];
    if (!s || s.manager === null || s.manager === undefined) return { ok: false, reason: "scores_incomplete", detail: axis };
  }
  const missing = findMissingDeviationNotes(existing.weights, existing.scores);
  if (missing.length > 0) return { ok: false, reason: "deviation_unjustified", detail: missing };

  const composite = computeComposite(existing.weights, existing.scores);
  const { rows } = await withTenants(
    [tenantId],
    (c) =>
      c.query<AppraisalRowShape>(
        `UPDATE report_appraisals SET status = 'submitted', commentary = $3, composite = $4, submitted_at = now(), updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND status = 'draft' RETURNING ${APPRAISAL_COLUMNS}`,
        [tenantId, id, finalCommentary, composite],
      ),
    APPRAISAL_MODULES,
  );
  if (!rows[0]) return { ok: false, reason: "not_draft" };
  return { ok: true, row: rows[0] };
}

// ---- ack (subject only; append-only trail) ----

export type AckResult = { ok: true; row: AppraisalRowShape } | { ok: false; reason: "not_found" | "wrong_status" };

/** `POST /appraisals/:id/ack`. INSERTs into the append-only `report_appraisal_acks` trail (never
 *  UPDATE/DELETE — the trigger would reject it anyway) and mirrors the outcome onto the mutable
 *  `report_appraisals.status` summary column, which the trigger does NOT protect. */
export async function ackAppraisal(tenantId: string, id: string, actorUserId: string, action: "acknowledged" | "disputed", comment: string | undefined): Promise<AckResult> {
  const existing = await fetchAppraisalRow(tenantId, id);
  if (!existing) return { ok: false, reason: "not_found" };
  if (!["submitted", "acknowledged", "disputed"].includes(existing.status)) return { ok: false, reason: "wrong_status" };

  return withTenants(
    [tenantId],
    async (c) => {
      await c.query(
        `INSERT INTO report_appraisal_acks (id, tenant_id, appraisal_id, actor_user_id, action, comment, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [newId(), tenantId, id, actorUserId, action, comment ?? null, config.originSite],
      );
      const upd = await c.query<AppraisalRowShape>(
        `UPDATE report_appraisals SET status = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING ${APPRAISAL_COLUMNS}`,
        [tenantId, id, action],
      );
      await emitEvent(c, tenantId, "report_appraisal", id, `reports.appraisal.${action}`, { subjectUserId: existing.subjectUserId });
      return { ok: true as const, row: upd.rows[0] };
    },
    APPRAISAL_MODULES,
  );
}

// ---- finalize (HR only; blocked while evidence_stale) ----

export type FinalizeResult = { ok: true; row: AppraisalRowShape } | { ok: false; reason: "not_found" | "wrong_status" | "evidence_stale" };

/** `POST /appraisals/:id/finalize`. §15's binding ruling: "amend of a pinned revision flips
 *  evidence_stale and BLOCKS finalize until re-confirm" — re-checks staleness live (not only the
 *  stored flag, since a manager may not have PATCHed `confirmEvidence` yet to surface a staleness
 *  that only just occurred) and persists the flag the moment it is discovered, so the caller sees
 *  an honest 409 and the row itself reflects reality even before anyone re-confirms. */
export async function finalizeAppraisal(tenantId: string, id: string, actorUserId: string): Promise<FinalizeResult> {
  const existing = await fetchAppraisalRow(tenantId, id);
  if (!existing) return { ok: false, reason: "not_found" };
  if (!["submitted", "acknowledged", "disputed"].includes(existing.status)) return { ok: false, reason: "wrong_status" };

  const stale = existing.evidenceStale || (await detectStaleness(tenantId, existing.evidence));
  if (stale) {
    if (!existing.evidenceStale) {
      await withTenants([tenantId], (c) => c.query(`UPDATE report_appraisals SET evidence_stale = true, updated_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, id]), APPRAISAL_MODULES);
    }
    return { ok: false, reason: "evidence_stale" };
  }

  return withTenants(
    [tenantId],
    async (c) => {
      await c.query(
        `INSERT INTO report_appraisal_acks (id, tenant_id, appraisal_id, actor_user_id, action, origin_site)
         VALUES ($1,$2,$3,$4,'finalized',$5)`,
        [newId(), tenantId, id, actorUserId, config.originSite],
      );
      const upd = await c.query<AppraisalRowShape>(
        `UPDATE report_appraisals SET status = 'finalized', finalized_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING ${APPRAISAL_COLUMNS}`,
        [tenantId, id],
      );
      await emitEvent(c, tenantId, "report_appraisal", id, "reports.appraisal.finalized", { subjectUserId: existing.subjectUserId });
      return { ok: true as const, row: upd.rows[0] };
    },
    APPRAISAL_MODULES,
  );
}

// ═══════════════════════════════ I/O — cycle CRUD ═══════════════════════════════

const CYCLE_COLUMNS = `
  id, tenant_id AS "tenantId", name, period_start::text AS "periodStart", period_end::text AS "periodEnd",
  status, default_weights AS "defaultWeights", role_weights AS "roleWeights", created_by AS "createdBy",
  created_at::text AS "createdAt", updated_at::text AS "updatedAt"
`;

const DEFAULT_CYCLE_WEIGHTS: Record<AppraisalAxis, number> = { delivery: 0.35, quality: 0.3, effort: 0.1, collaboration: 0.25 };

export interface CreateCycleInput {
  name: string;
  periodStart: string;
  periodEnd: string;
  defaultWeights?: Record<AppraisalAxis, number>;
  roleWeights?: Record<string, Record<AppraisalAxis, number>>;
}

export async function createCycle(tenantId: string, input: CreateCycleInput, createdBy: string): Promise<AppraisalCycleRow> {
  const id = newId();
  const { rows } = await withTenants(
    [tenantId],
    (c) =>
      c.query<AppraisalCycleRow>(
        `INSERT INTO report_appraisal_cycles (id, tenant_id, name, period_start, period_end, default_weights, role_weights, created_by, origin_site)
         VALUES ($1,$2,$3,$4::date,$5::date,$6::jsonb,$7::jsonb,$8,$9)
         RETURNING ${CYCLE_COLUMNS}`,
        [id, tenantId, input.name, input.periodStart, input.periodEnd, JSON.stringify(input.defaultWeights ?? DEFAULT_CYCLE_WEIGHTS), JSON.stringify(input.roleWeights ?? {}), createdBy, config.originSite],
      ),
    APPRAISAL_MODULES,
  );
  return rows[0];
}

export async function listCycles(tenantId: string): Promise<AppraisalCycleRow[]> {
  const { rows } = await withTenants([tenantId], (c) => c.query<AppraisalCycleRow>(`SELECT ${CYCLE_COLUMNS} FROM report_appraisal_cycles WHERE tenant_id = $1 ORDER BY period_start DESC`, [tenantId]), APPRAISAL_MODULES);
  return rows;
}

export async function getCycle(tenantId: string, id: string): Promise<AppraisalCycleRow | null> {
  const { rows } = await withTenants([tenantId], (c) => c.query<AppraisalCycleRow>(`SELECT ${CYCLE_COLUMNS} FROM report_appraisal_cycles WHERE tenant_id = $1 AND id = $2`, [tenantId, id]), APPRAISAL_MODULES);
  return rows[0] ?? null;
}

export interface PatchCycleInput {
  name?: string;
  periodStart?: string;
  periodEnd?: string;
  status?: "draft" | "open" | "in_review" | "closed";
  defaultWeights?: Record<AppraisalAxis, number>;
  roleWeights?: Record<string, Record<AppraisalAxis, number>>;
}

export async function patchCycle(tenantId: string, id: string, input: PatchCycleInput): Promise<AppraisalCycleRow | null> {
  const existing = await getCycle(tenantId, id);
  if (!existing) return null;
  const next = {
    name: input.name ?? existing.name,
    periodStart: input.periodStart ?? existing.periodStart,
    periodEnd: input.periodEnd ?? existing.periodEnd,
    status: input.status ?? existing.status,
    defaultWeights: input.defaultWeights ?? existing.defaultWeights,
    roleWeights: input.roleWeights ?? existing.roleWeights,
  };
  const { rows } = await withTenants(
    [tenantId],
    (c) =>
      c.query<AppraisalCycleRow>(
        `UPDATE report_appraisal_cycles
            SET name = $3, period_start = $4::date, period_end = $5::date, status = $6,
                default_weights = $7::jsonb, role_weights = $8::jsonb, updated_at = now()
          WHERE tenant_id = $1 AND id = $2 RETURNING ${CYCLE_COLUMNS}`,
        [tenantId, id, next.name, next.periodStart, next.periodEnd, next.status, JSON.stringify(next.defaultWeights), JSON.stringify(next.roleWeights)],
      ),
    APPRAISAL_MODULES,
  );
  return rows[0] ?? null;
}
