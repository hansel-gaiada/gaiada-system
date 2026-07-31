// TR-13 — the `ReportDocument` builder (LIVE path only; sealing is TR-15's job — see the header
// note at the bottom on how a sealed branch layers on later without reshaping this file).
//
// ─────────────────────────────── WHAT THIS REUSES, AND WHY ───────────────────────────────
// The whole KPI axis is built by calling `reportRollups.compute()` (TR-08, report-rollups.ts)
// DIRECTLY — the same function `rollups/engine.ts`'s `recomputeRollups()` calls before it upserts
// into `rollup_metrics`. Calling it directly (never through `recomputeRollups`) is what makes the
// §0057 rule 3 guarantee trivial to keep: `compute()` is a pure READ (see report-rollups.ts's own
// header — "Must be pure-read"), so invoking it for an arbitrary custom period NEVER writes a row
// anywhere, let alone into the governed `rollup_metrics` registry. This also means every
// correctness property TR-08 already proved (ratio-of-sums over the ACTUAL day count, #20's
// as-of-range-end point-in-time read, #14/#18/#19's per-day department split, the provider-view
// cross-company slice) is inherited for free, for ANY [start, end] window — calendar or custom —
// because `compute()` itself is range-agnostic (metrics.ts's `parsePeriodRange` just needs a valid
// 'YYYY-MM-DD:YYYY-MM-DD' string; it has no idea whether the range is a calendar period or a
// custom one). This is also exactly what makes the additivity proof (a custom range equal to a
// calendar month must equal that month's document) hold: both paths call the identical function
// with the identical [start, end] pair and no other input differs.
//
// #22 `evidence.source_diversity` is NOT part of `compute()`'s output (it is deliberately
// `seeded: false`, per metrics.ts/§15) — computed here, read-time, as a key-union over
// `report_work_facts.activity_by_source` for the exact scope.
//
// ─────────────────────────────── HOUSE PATTERN ───────────────────────────────
// Same "pure core, I/O at the edges" split as fact-job.ts, with one adjustment: because this
// module's core decision (which RollupRow belongs to which grain/scopeRef) is cheap and the I/O
// gathers are numerous and grain-dependent, the pure helpers (range resolution, scope matching,
// KPI shaping, label/warning computation given already-fetched inputs) are exported standalone and
// unit-tested without a database; `buildReportDocument` is the I/O orchestrator that calls them.
//
// ─────────────────────────────── SCOPE OF THIS TICKET ───────────────────────────────
// Acceptance-tested here: all four grains x all four period kinds building correctly, ratios
// carrying n/d, comparison deltas correct across month boundaries, the provider-view servedTenant
// slice, custom-range mechanics (§0057 rule 3, validation, additivity proof, empty-but-valid).
// series/distributions/tables are populated with a genuinely useful but DELIBERATELY NOT
// exhaustive-per-§7 set (documented at each block below) — full per-grain chart parity (CFD/
// burndown reuse, task-level contribution detail, etc.) is left as follow-up work rather than
// shipped as a shallow imitation; see the ticket report for the explicit list.
import { withGlobal, withTenants } from "../../db";
import { addDaysIso, resolveMembershipAsOf, todayIso, type MembershipInterval } from "../../core/dept-resolution";
import { effectiveStatuses } from "../pm/pm.controller";
import { reportRollups } from "./report-rollups";
import { recomputeFactSlice, REPORT_JOB_MODULES } from "./fact-job";
import { REPORT_METRICS, formatPeriodRange, inclusiveDayCount, type ReportMetricDef } from "./metrics";
import type { RollupRow } from "../contract";
import type {
  ReportDocument,
  ReportGrain,
  ReportPeriodKind,
  ReportHeader,
  ReportKpi,
  ReportSeries,
  ReportSeriesPoint,
  ReportDistribution,
  ReportTable,
  ReportHighlight,
  ReportNarrative,
  ReportUnit,
} from "./report-document";

/** §6.2's ceiling, restated here for the read endpoints (fact-job.ts's `MAX_WINDOW_DAYS` covers
 *  the recompute endpoint; reports.controller.ts's read endpoints import THIS constant so the two
 *  never drift independently). */
export const MAX_CUSTOM_RANGE_DAYS = 400;

// ═══════════════════════════════ PURE — calendar range resolution ═══════════════════════════════

function toUtcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}
function fromUtcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Monday on or before `dateIso` (ISO week, matching platform-ui/src/lib/reports.ts's
 *  `bucketKeyFor` week convention — the two must agree on what "the week" means). */
export function mondayOnOrBefore(dateIso: string): string {
  const d = toUtcDate(dateIso);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow);
  return fromUtcDate(d);
}

/** Resolves a `day`/`week`/`month` periodKind + a caller-given `start` into the actual [start,
 *  end] calendar range (§6.2: "For non-custom kinds, `end` is ignored and derived from `start`").
 *  NOT used for `custom` — the controller passes the caller's own [start, end] through untouched
 *  for that kind. Pure: no clock, no DB. */
export function resolveCalendarRange(periodKind: "day" | "week" | "month", start: string): { start: string; end: string } {
  if (periodKind === "day") return { start, end: start };
  if (periodKind === "week") {
    const s = mondayOnOrBefore(start);
    return { start: s, end: addDaysIso(s, 6) };
  }
  // month
  const monthStart = `${start.slice(0, 7)}-01`;
  const d = toUtcDate(monthStart);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0); // last day of the ORIGINAL month
  return { start: monthStart, end: fromUtcDate(d) };
}

/** The comparison baseline (§6.1 header comment): for `custom` it is the immediately preceding
 *  EQUAL-LENGTH window; for a calendar kind it is the immediately preceding period OF THE SAME
 *  KIND (previous day / ISO week / calendar month) REGARDLESS of that period's own length — which
 *  is what makes "comparison deltas correct across month boundaries" hold (Feb has fewer days than
 *  Jan; both sides recompute Sigma-n/Sigma-d over their OWN actual day count, per §5.4, so an
 *  unequal comparison window is correct, not a bug). */
export function previousPeriodRange(
  periodKind: ReportPeriodKind,
  start: string,
  end: string,
  dayCount: number,
): { start: string; end: string; dayCount: number } {
  if (periodKind === "day") {
    const p = addDaysIso(start, -1);
    return { start: p, end: p, dayCount: 1 };
  }
  if (periodKind === "week") {
    return { start: addDaysIso(start, -7), end: addDaysIso(end, -7), dayCount: 7 };
  }
  if (periodKind === "month") {
    const d = toUtcDate(start);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 1);
    const s = fromUtcDate(d);
    const e2 = new Date(d);
    e2.setUTCMonth(e2.getUTCMonth() + 1);
    e2.setUTCDate(0);
    const e = fromUtcDate(e2);
    return { start: s, end: e, dayCount: inclusiveDayCount(s, e) };
  }
  // custom: immediately preceding equal-length window ([start - dayCount, start - 1])
  return { start: addDaysIso(start, -dayCount), end: addDaysIso(start, -1), dayCount };
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(iso: string): string {
  const d = toUtcDate(iso);
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** ISO 8601 week number (Mon-start, week 1 = the week containing the year's first Thursday) —
 *  standard algorithm, used only for the `periodLabel` display string. */
function isoWeekNumber(dateIso: string): { week: number; year: number } {
  const d = toUtcDate(dateIso);
  const target = new Date(d.getTime());
  const dayNr = (d.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return { week, year: target.getUTCFullYear() };
}

/** §6.1's display examples verbatim: "16 Jul 2026" | "Week 29 2026" | "July 2026" |
 *  "16 Jul - 3 Aug 2026" (en dash in the doc; a plain hyphen here to stay ASCII-safe over JSON). */
export function formatPeriodLabel(periodKind: ReportPeriodKind, start: string, end: string): string {
  if (periodKind === "day") return shortDate(start);
  if (periodKind === "week") {
    const { week, year } = isoWeekNumber(start);
    return `Week ${week} ${year}`;
  }
  if (periodKind === "month") {
    const d = toUtcDate(start);
    return `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  return `${shortDate(start)} - ${shortDate(end)}`;
}

// ═══════════════════════════════ PURE — scope matching over RollupRow[] ═══════════════════════

/** Does this rollup row's `dimensions` belong to the requested grain/scopeRef (+ optional
 *  servedTenant slice)? Every rollup function in report-rollups.ts emits an EXACT single-key (or
 *  empty) dimensions shape per grain — `{userId}` / `{projectId}` / `{unit}` or `{unit,
 *  servedTenant}` / `{}` — so an exact-key match is sufficient; there is no ambiguity to resolve
 *  (see report-rollups.ts's own dimension literals at every `rows.push(...)` call site). */
export function matchesScope(grain: ReportGrain, dims: Record<string, unknown>, scopeRef: string, servedTenantId?: string): boolean {
  if (grain === "person") return dims.userId === scopeRef;
  if (grain === "project") return dims.projectId === scopeRef;
  if (grain === "department") {
    if (dims.unit !== scopeRef) return false;
    return servedTenantId ? dims.servedTenant === servedTenantId : dims.servedTenant === undefined;
  }
  // company
  return Object.keys(dims).length === 0;
}

function findRow(rows: RollupRow[], metricKey: string, grain: ReportGrain, scopeRef: string, servedTenantId?: string): RollupRow | undefined {
  return rows.find((r) => r.metricKey === metricKey && matchesScope(grain, r.dimensions ?? {}, scopeRef, servedTenantId));
}

// ═══════════════════════════════ PURE — KPI shaping ═══════════════════════════════

/** Short display label from a metric key ("delivery.on_time_rate" -> "On Time Rate"). metrics.ts's
 *  `description` is a full sentence (right for tooltips, wrong for a KPI tile), so this derives a
 *  compact one instead of duplicating a second label field in the catalog. */
export function humanizeMetricKey(metricKey: string): string {
  const tail = metricKey.split(".").slice(1).join(" ") || metricKey;
  return tail
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** Best-effort directionality for the DeltaChip (§7). Not part of the metric catalog (metrics.ts
 *  is the governed registry shape and does not carry a UI-only field); kept here, deliberately
 *  narrow, and defaults to "neutral" for anything unlisted rather than guessing. */
const METRIC_DIRECTION: Record<string, "up_good" | "down_good" | "neutral"> = {
  "delivery.throughput_weighted": "up_good",
  "delivery.on_time_rate": "up_good",
  "delivery.estimate_coverage": "up_good",
  "delivery.milestone_hit_rate": "up_good",
  "delivery.backlog_delta": "down_good",
  "flow.blocked_share": "down_good",
  "flow.reopen_rate": "down_good",
  "collab.contributed_minutes": "up_good",
  "discipline.checkin_compliance": "up_good",
  "discipline.time_logging_coverage": "up_good",
  "discipline.overdue_open": "down_good",
  "evidence.link_rate": "up_good",
  "evidence.source_diversity": "up_good",
};

function toReportUnit(displayUnit: ReportMetricDef["displayUnit"]): ReportUnit {
  return displayUnit; // "count" | "minutes" | "percent" are all valid ReportUnit literals verbatim
}

/** value/numerator/denominator for one metric given its (possibly absent) matched row. Ratio
 *  metrics recompute Sigma-n/Sigma-d exactly as `rollupRow` already carries it (report-rollups.ts
 *  did the range-correct summation) — this NEVER re-derives a ratio from anything else, so it
 *  cannot reintroduce the average-of-averages bug. A metric with no matching row (zero facts in
 *  range, or a scope the metric doesn't apply to) reads as an honest zero, never a thrown error —
 *  the "empty-but-valid document" requirement. */
function kpiValueParts(m: ReportMetricDef, row: RollupRow | undefined): { value: number; numerator?: number; denominator?: number } {
  const isRatio = m.aggregationRule === "ratio_of_sums";
  const numerator = row?.numerator ?? 0;
  const denominator = row?.denominator;
  if (isRatio) {
    const d = denominator ?? 0;
    return { value: d !== 0 ? numerator / d : 0, numerator, denominator: d };
  }
  // plain sum / last (#20 point-in-time) — no denominator, ever (§4a invariant 2 / §5.4).
  return { value: numerator };
}

/** Builds every applicable KPI for one grain from the current + comparison period's rollup rows,
 *  plus the read-time distinct-source-diversity pair (#22, never part of `rows`). Pure given
 *  already-fetched inputs — no DB access here. */
export function buildKpis(
  grain: ReportGrain,
  scopeRef: string,
  currentRows: RollupRow[],
  previousRows: RollupRow[],
  servedTenantId: string | undefined,
  sourceDiversity: { current: number; previous: number },
): ReportKpi[] {
  const kpis: ReportKpi[] = [];
  for (const m of REPORT_METRICS) {
    if (!m.grains.includes(grain)) continue;
    if (m.metricKey === "evidence.source_diversity") {
      kpis.push({
        metricKey: m.metricKey,
        label: humanizeMetricKey(m.metricKey),
        unit: toReportUnit(m.displayUnit),
        value: sourceDiversity.current,
        delta: sourceDiversity.current - sourceDiversity.previous,
        direction: METRIC_DIRECTION[m.metricKey] ?? "neutral",
        appraisalSafe: m.appraisalSafe,
        distinctOver: true,
      });
      continue;
    }
    const row = findRow(currentRows, m.metricKey, grain, scopeRef, servedTenantId);
    const prevRow = findRow(previousRows, m.metricKey, grain, scopeRef, servedTenantId);
    const current = kpiValueParts(m, row);
    const previous = kpiValueParts(m, prevRow);
    const kpi: ReportKpi = {
      metricKey: m.metricKey,
      label: humanizeMetricKey(m.metricKey),
      unit: toReportUnit(m.displayUnit), // never "text" (ruling: TR-13 must not emit a text-unit KPI)
      value: current.value,
      delta: current.value - previous.value,
      direction: METRIC_DIRECTION[m.metricKey] ?? "neutral",
      appraisalSafe: m.appraisalSafe,
    };
    if (current.numerator !== undefined) kpi.numerator = current.numerator;
    if (current.denominator !== undefined) kpi.denominator = current.denominator;
    if (m.metricKey === "discipline.overdue_open") kpi.pointInTime = true;
    kpis.push(kpi);
  }
  return kpis;
}

/** A fixed 3-metric headline subset for the `/reports/overview` LISTING endpoint (console
 *  landing: many scopes at once). Deliberately DOES NOT compute a comparison delta — that would
 *  need a second `computeRangeRows` call per grain (cheap for `document`'s single scope, wasteful
 *  fanned out over every entity in a listing) — `ReportKpi.delta` is optional and simply omitted
 *  here. Full deltas are available from the single-scope `document` read. */
export function buildHeadlineKpis(grain: ReportGrain, scopeRef: string, rows: RollupRow[]): ReportKpi[] {
  const HEADLINE_KEYS = ["delivery.throughput_weighted", "delivery.on_time_rate", "delivery.tasks_completed"];
  const kpis: ReportKpi[] = [];
  for (const key of HEADLINE_KEYS) {
    const m = REPORT_METRICS.find((mm) => mm.metricKey === key);
    if (!m || !m.grains.includes(grain)) continue;
    const row = findRow(rows, key, grain, scopeRef);
    const parts = kpiValueParts(m, row);
    const kpi: ReportKpi = {
      metricKey: m.metricKey,
      label: humanizeMetricKey(m.metricKey),
      unit: toReportUnit(m.displayUnit),
      value: parts.value,
      direction: METRIC_DIRECTION[m.metricKey] ?? "neutral",
      appraisalSafe: m.appraisalSafe,
    };
    if (parts.numerator !== undefined) kpi.numerator = parts.numerator;
    if (parts.denominator !== undefined) kpi.denominator = parts.denominator;
    kpis.push(kpi);
  }
  return kpis;
}

/** Bulk scope-name resolution for the overview listing (avoids N+1 per-scope name queries).
 *  `company` grain is not handled here — overview's company branch has exactly one scope (the
 *  tenant itself) and resolves its name inline. */
export async function resolveScopeNamesBulk(tenantId: string, grain: Exclude<ReportGrain, "company">, scopeRefs: string[]): Promise<Map<string, string>> {
  if (scopeRefs.length === 0) return new Map();
  if (grain === "person") {
    const { rows } = await withGlobal((c) => c.query<{ id: string; name: string }>(`SELECT id, name FROM users WHERE id = ANY($1::uuid[])`, [scopeRefs]));
    return new Map(rows.map((r) => [r.id, r.name]));
  }
  if (grain === "project") {
    const { rows } = await withTenants([tenantId], (c) => c.query<{ id: string; name: string }>(`SELECT id, name FROM projects WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tenantId, scopeRefs]));
    return new Map(rows.map((r) => [r.id, r.name]));
  }
  // department: one org-blob fetch, then a label lookup per node id.
  const { rows } = await withTenants([tenantId], (c) => c.query<{ structure: { root?: OrgLabelNode } }>(`SELECT structure FROM company_org_structure WHERE tenant_id = $1`, [tenantId]));
  const root = rows[0]?.structure?.root;
  return new Map(scopeRefs.map((id) => [id, findNodeLabel(root, id) ?? id]));
}

// ═══════════════════════════════ I/O — the KPI axis ═══════════════════════════════

/** `reportRollups.compute()` DIRECTLY — never `recomputeRollups()` — so this NEVER writes into
 *  `rollup_metrics` (§0057 rule 3). Returns rows for EVERY entity in the tenant for this period;
 *  the caller filters down to one grain/scopeRef via `matchesScope`. `servedTenantId` selects
 *  which tenant's OWN `report_work_facts` the provider-view rows are sourced from when computing
 *  a served-company slice — the compute call itself is always scoped to `tenantId` (the reading/
 *  provider tenant); `report-rollups.ts`'s `computeProviderViewRollups` opens its own short-lived
 *  scope into each served tenant internally, so no extra plumbing is needed here. */
async function computeRangeRows(tenantId: string, start: string, end: string): Promise<RollupRow[]> {
  const period = formatPeriodRange(start, end);
  return withTenants([tenantId], (c) => reportRollups.compute(c, tenantId, period), { modules: [...REPORT_JOB_MODULES] });
}

/** #22 `evidence.source_diversity` (§5.4 class N): COUNT(DISTINCT source) unioned over the range
 *  — never the sum of daily distinct counts. Deliberately NOT part of `compute()`'s output (it is
 *  `seeded: false`); read directly off `report_work_facts.activity_by_source`.
 *
 *  For the department-grain "own" slice (no servedTenantId): reads THIS tenant's own facts
 *  filtered by `department_node_id`. For an explicit servedTenantId slice: reads the SERVED
 *  tenant's OWN `report_work_facts` (facts never re-home — §3.2), filtered by
 *  `provider_tenant_id`/`provider_unit_node_id`, mirroring exactly where report-rollups.ts's
 *  `computeProviderViewRollups` reads its own numbers from. */
async function computeSourceDiversity(
  tenantId: string,
  grain: ReportGrain,
  scopeRef: string,
  servedTenantId: string | undefined,
  start: string,
  end: string,
): Promise<number> {
  const readTenant = servedTenantId ?? tenantId;
  return withTenants(
    [readTenant],
    async (c) => {
      const where = ["tenant_id = $1", "fact_date BETWEEN $2::date AND $3::date"];
      const params: unknown[] = [readTenant, start, end];
      if (grain === "person") {
        where.push(`user_id = $${params.length + 1}`);
        params.push(scopeRef);
      } else if (grain === "project") {
        where.push(`project_id = $${params.length + 1}`);
        params.push(scopeRef);
      } else if (grain === "department") {
        if (servedTenantId) {
          where.push(`provider_unit_node_id = $${params.length + 1}`);
          params.push(scopeRef);
          where.push(`provider_tenant_id = $${params.length + 1}`);
          params.push(tenantId);
        } else {
          where.push(`department_node_id = $${params.length + 1}`);
          params.push(scopeRef);
        }
      }
      // company grain: no extra filter — the whole tenant's facts.
      const { rows } = await c.query<{ activity_by_source: Record<string, number> }>(
        `SELECT activity_by_source FROM report_work_facts WHERE ${where.join(" AND ")}`,
        params,
      );
      const sources = new Set<string>();
      for (const r of rows) for (const key of Object.keys(r.activity_by_source ?? {})) sources.add(key);
      return sources.size;
    },
    { modules: [...REPORT_JOB_MODULES] },
  );
}

// ═══════════════════════════════ I/O — lazy backstop (mirrors pm/burndown-job.ts) ══════════════

/** Keeps TODAY's fact slice current on every live read that includes today — the identical
 *  "lazy idempotent upsert-on-read" shape pm.controller.ts's `getBurndown()` uses (called
 *  unconditionally, not gated on an existence check: a genuinely-empty day and a
 *  never-computed day both read as zero rows, so an existence check cannot tell them apart;
 *  recomputing is cheap — one (tenant, date) DELETE+INSERT — and always idempotent). Historical
 *  days are the nightly job's responsibility (§10); this does not attempt to backfill an
 *  arbitrarily large gap on a read. */
async function ensureTodayFresh(tenantId: string, start: string, end: string, today: string): Promise<void> {
  if (today < start || today > end) return;
  await recomputeFactSlice(tenantId, today, { today });
}

// ═══════════════════════════════ I/O — header warnings ═══════════════════════════════

async function firstFactDate(tenantId: string): Promise<string | null> {
  const { rows } = await withTenants(
    [tenantId],
    (c) => c.query<{ d: string | null }>(`SELECT to_char(MIN(fact_date), 'YYYY-MM-DD') AS d FROM report_work_facts WHERE tenant_id = $1`, [tenantId]),
    { modules: [...REPORT_JOB_MODULES] },
  );
  return rows[0]?.d ?? null;
}

/** Person-grain only (§6.1's comment: "a subject moved unit mid-range"). Reads this tenant's OWN
 *  `org_unit_memberships` for the scope user and checks whether any interval boundary falls
 *  STRICTLY inside (start, end] — i.e. a transfer happened during the range, not merely that the
 *  start/end departments differ (which the same check also catches). Foreign (cross-company) home
 *  trees are not consulted here — a documented scope-narrowing, not a correctness claim about
 *  cross-tenant transfers. */
async function personSpansMembershipChange(tenantId: string, userId: string, start: string, end: string): Promise<boolean> {
  const { rows } = await withTenants(
    [tenantId],
    (c) =>
      c.query<{ valid_from: string }>(
        `SELECT valid_from::text AS valid_from FROM org_unit_memberships
          WHERE tenant_id = $1 AND user_id = $2 AND is_primary`,
        [tenantId, userId],
      ),
    { modules: [...REPORT_JOB_MODULES] },
  );
  return rows.some((r) => r.valid_from > start && r.valid_from <= end);
}

export interface HeaderWarningInputs {
  periodKind: ReportPeriodKind;
  start: string;
  end: string;
  today: string;
  firstFactDate: string | null;
  spansMembershipChange?: boolean;
}

/** Pure given already-gathered inputs. `partialPeriod` reads as "this calendar bucket has not
 *  fully elapsed yet" for day/week/month (end >= today), and as "this custom range does not align
 *  to a whole ISO week or calendar month" for `custom` — a judgment call documented here because
 *  §6.1's own comment ("range cuts across an incomplete week/month") is compatible with either
 *  reading and no ticket has pinned one; recorded so a future ticket can correct it deliberately
 *  rather than silently reinterpreting the flag. */
export function computeHeaderWarnings(input: HeaderWarningInputs): ReportHeader["warnings"] {
  const warnings: NonNullable<ReportHeader["warnings"]> = {};
  const endsInFuture = input.end > input.today;
  if (endsInFuture) warnings.endsInFuture = true;

  if (input.periodKind === "custom") {
    warnings.adHoc = true;
    const wholeWeek = mondayOnOrBefore(input.start) === input.start && addDaysIso(input.start, 6) === input.end;
    const wholeMonth = input.start.endsWith("-01") && resolveCalendarRange("month", input.start).end === input.end;
    if (!wholeWeek && !wholeMonth) warnings.partialPeriod = true;
  } else if (input.periodKind !== "day") {
    if (input.end >= input.today) warnings.partialPeriod = true;
  }

  if (input.firstFactDate && input.start < input.firstFactDate) {
    const cappedEnd = input.end < input.firstFactDate ? input.end : addDaysIso(input.firstFactDate, -1);
    if (cappedEnd >= input.start) {
      warnings.precedesFactHistory = {
        firstFactDate: input.firstFactDate,
        affectedDays: inclusiveDayCount(input.start, cappedEnd),
      };
    }
  }

  if (input.spansMembershipChange) warnings.spansMembershipChange = true;

  return Object.keys(warnings).length > 0 ? warnings : undefined;
}

// ═══════════════════════════════ I/O — scope name resolution ═══════════════════════════════

interface OrgLabelNode {
  id?: string;
  name?: string;
  children?: OrgLabelNode[];
}

function findNodeLabel(root: OrgLabelNode | null | undefined, nodeId: string): string | undefined {
  if (!root) return undefined;
  if (root.id === nodeId) return root.name;
  for (const child of root.children ?? []) {
    const found = findNodeLabel(child, nodeId);
    if (found) return found;
  }
  return undefined;
}

async function resolveScopeName(tenantId: string, grain: ReportGrain, scopeRef: string): Promise<string> {
  if (grain === "person") {
    const { rows } = await withGlobal((c) => c.query<{ name: string }>(`SELECT name FROM users WHERE id = $1`, [scopeRef]));
    return rows[0]?.name ?? scopeRef;
  }
  if (grain === "company") {
    const { rows } = await withGlobal((c) => c.query<{ name: string }>(`SELECT name FROM companies WHERE id = $1`, [scopeRef]));
    return rows[0]?.name ?? scopeRef;
  }
  if (grain === "project") {
    const { rows } = await withTenants([tenantId], (c) => c.query<{ name: string }>(`SELECT name FROM projects WHERE id = $1 AND tenant_id = $2`, [scopeRef, tenantId]));
    return rows[0]?.name ?? scopeRef;
  }
  // department: resolve via the org blob (no dedicated name table for org-tree node ids, 0029 convention).
  const { rows } = await withTenants([tenantId], (c) => c.query<{ structure: { root?: OrgLabelNode } }>(`SELECT structure FROM company_org_structure WHERE tenant_id = $1`, [tenantId]));
  const root = rows[0]?.structure?.root;
  return findNodeLabel(root, scopeRef) ?? scopeRef;
}

// ═══════════════════════════════ I/O — series/distributions/tables ═══════════════════════════

const SUM_COLUMNS = ["activity_events", "estimate_minutes_completed", "tasks_completed_on_time", "tasks_completed_with_due_date"] as const;

interface ScopeFilter {
  clause: string;
  params: unknown[];
}

/** The (tenant, filter) pair a scoped `report_work_facts` query must read from — own tenant for
 *  every grain except an explicit served-tenant department slice, which reads the SERVED tenant's
 *  own facts (facts never re-home; ruling ⑤ / §3.2). */
function scopeFilter(tenantId: string, grain: ReportGrain, scopeRef: string, servedTenantId: string | undefined, paramOffset: number): ScopeFilter {
  const params: unknown[] = [];
  let clause = "";
  if (grain === "person") {
    clause = `user_id = $${paramOffset}`;
    params.push(scopeRef);
  } else if (grain === "project") {
    clause = `project_id = $${paramOffset}`;
    params.push(scopeRef);
  } else if (grain === "department") {
    if (servedTenantId) {
      clause = `provider_unit_node_id = $${paramOffset} AND provider_tenant_id = $${paramOffset + 1}`;
      params.push(scopeRef, tenantId);
    } else {
      clause = `department_node_id = $${paramOffset}`;
      params.push(scopeRef);
    }
  } else {
    clause = "true"; // company: whole tenant
  }
  return { clause, params };
}

interface DailySums {
  factDate: string;
  activityEvents: number;
  estimateMinutesCompleted: number;
  tasksCompletedOnTime: number;
  tasksCompletedWithDueDate: number;
}

async function fetchDailySums(readTenant: string, grain: ReportGrain, scopeRef: string, servedTenantId: string | undefined, tenantId: string, start: string, end: string): Promise<DailySums[]> {
  const filter = scopeFilter(tenantId, grain, scopeRef, servedTenantId, 4);
  const { rows } = await withTenants(
    [readTenant],
    (c) =>
      c.query<{ fact_date: string } & Record<(typeof SUM_COLUMNS)[number], string>>(
        `SELECT fact_date::text AS fact_date, ${SUM_COLUMNS.map((col) => `COALESCE(SUM(${col}),0) AS ${col}`).join(", ")}
           FROM report_work_facts
          WHERE tenant_id = $1 AND fact_date BETWEEN $2::date AND $3::date AND ${filter.clause}
          GROUP BY fact_date
          ORDER BY fact_date`,
        [readTenant, start, end, ...filter.params],
      ),
    { modules: [...REPORT_JOB_MODULES] },
  );
  return rows.map((r) => ({
    factDate: r.fact_date,
    activityEvents: Number(r.activity_events),
    estimateMinutesCompleted: Number(r.estimate_minutes_completed),
    tasksCompletedOnTime: Number(r.tasks_completed_on_time),
    tasksCompletedWithDueDate: Number(r.tasks_completed_with_due_date),
  }));
}

/** Every calendar day in [start, end] as an ISO string, ascending — used so a day with zero facts
 *  still emits a `{t, v:0}` point (additive metrics; §7's null-gap discipline is reserved for
 *  genuinely no-data-yet FUTURE days, computed separately below) rather than a silently missing
 *  point that would misrender as a gap in the chart kit. */
function allDaysInRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDaysIso(d, 1)) out.push(d);
  return out;
}

function buildAdditiveSeries(key: string, label: string, unit: ReportUnit, kind: ReportSeries["kind"], days: string[], today: string, valueByDay: Map<string, number>): ReportSeries {
  const points: ReportSeriesPoint[] = days.map((d) => ({ t: d, v: d > today ? null : valueByDay.get(d) ?? 0 }));
  return { key, label, unit, kind, points };
}

/** The modest, honest per-grain series/distribution/table set this ticket ships (see the file
 *  header for what is deliberately NOT attempted). Every number here is sourced fresh from
 *  `report_work_facts` (daily resolution, always [start,end] — never re-aggregated, §5.4's "the
 *  server never re-aggregates" rule applies to series exactly as it does to KPIs). */
async function buildSeriesAndDistributions(
  tenantId: string,
  grain: ReportGrain,
  scopeRef: string,
  servedTenantId: string | undefined,
  start: string,
  end: string,
  today: string,
  currentRows: RollupRow[],
): Promise<{ series: ReportSeries[]; distributions: ReportDistribution[] }> {
  const readTenant = servedTenantId ?? tenantId;
  const daily = await fetchDailySums(readTenant, grain, scopeRef, servedTenantId, tenantId, start, end);
  const days = allDaysInRange(start, end);

  const byDay = <K extends keyof DailySums>(field: K) => new Map(daily.map((r) => [r.factDate, Number(r[field])]));

  const series: ReportSeries[] = [
    buildAdditiveSeries("activity_events", "Activity", "count", "line", days, today, byDay("activityEvents")),
    buildAdditiveSeries("throughput_weighted", "Throughput (weighted minutes)", "minutes", "bar", days, today, byDay("estimateMinutesCompleted")),
  ];

  const onTimeNumerator = byDay("tasksCompletedOnTime");
  const onTimeDenominator = byDay("tasksCompletedWithDueDate");
  series.push(buildAdditiveSeries("tasks_completed_on_time", "Completed on time", "count", "bar", days, today, onTimeNumerator));
  series.push(buildAdditiveSeries("tasks_completed_with_due_date", "Completed with a due date", "count", "bar", days, today, onTimeDenominator));
  series.push({
    key: "on_time_rate",
    label: "On-time rate",
    unit: "percent",
    kind: "line",
    numeratorKey: "tasks_completed_on_time",
    denominatorKey: "tasks_completed_with_due_date",
    points: days.map((d) => {
      if (d > today) return { t: d, v: null };
      const n = onTimeNumerator.get(d) ?? 0;
      const dd = onTimeDenominator.get(d) ?? 0;
      return { t: d, v: dd > 0 ? n / dd : null };
    }),
  });

  // evidence_by_source distribution: sum activity_by_source over the whole range for the scope.
  const sourceFilter = scopeFilter(tenantId, grain, scopeRef, servedTenantId, 4);
  const { rows: sourceRows } = await withTenants(
    [readTenant],
    (c) =>
      c.query<{ activity_by_source: Record<string, number> }>(
        `SELECT activity_by_source FROM report_work_facts
          WHERE tenant_id = $1 AND fact_date BETWEEN $2::date AND $3::date AND ${sourceFilter.clause}`,
        [readTenant, start, end, ...sourceFilter.params],
      ),
    { modules: [...REPORT_JOB_MODULES] },
  );
  const sourceTotals = new Map<string, number>();
  for (const r of sourceRows) {
    for (const [src, n] of Object.entries(r.activity_by_source ?? {})) {
      sourceTotals.set(src, (sourceTotals.get(src) ?? 0) + Number(n));
    }
  }
  const distributions: ReportDistribution[] = [];
  if (sourceTotals.size > 0) {
    distributions.push({
      key: "evidence_by_source",
      label: "Evidence by source",
      kind: "stacked",
      slices: [...sourceTotals.entries()].map(([label, value]) => ({ label, value })),
    });
  }

  // time_by_project donut: person grain only (§7's per-grain chart list).
  if (grain === "person") {
    const { rows: byProject } = await withTenants(
      [readTenant],
      (c) =>
        c.query<{ project_id: string | null; minutes: string }>(
          `SELECT project_id, SUM(minutes_logged) AS minutes FROM report_work_facts
            WHERE tenant_id = $1 AND user_id = $2 AND fact_date BETWEEN $3::date AND $4::date AND minutes_logged > 0
            GROUP BY project_id`,
          [readTenant, scopeRef, start, end],
        ),
      { modules: [...REPORT_JOB_MODULES] },
    );
    if (byProject.length > 0) {
      const projectIds = byProject.filter((r) => r.project_id).map((r) => r.project_id as string);
      const names = projectIds.length
        ? await withTenants([readTenant], (c) => c.query<{ id: string; name: string }>(`SELECT id, name FROM projects WHERE id = ANY($1::uuid[])`, [projectIds]))
        : { rows: [] as { id: string; name: string }[] };
      const nameById = new Map(names.rows.map((r) => [r.id, r.name]));
      distributions.push({
        key: "time_by_project",
        label: "Time by project",
        kind: "donut",
        slices: byProject.map((r) => ({
          label: r.project_id ? nameById.get(r.project_id) ?? r.project_id : "Non-project work",
          value: Number(r.minutes),
          ref: r.project_id ? { kind: "project" as const, id: r.project_id } : undefined,
        })),
      });
    }
  }

  // served-companies split: department grain, own (non-servedTenant-specific) reads only — the
  // "provider view slices by servedTenant" requirement (§7: served-companies split, stacked bars).
  if (grain === "department" && !servedTenantId) {
    const served = currentRows.filter((r) => r.metricKey === "delivery.throughput_weighted" && r.dimensions?.unit === scopeRef && r.dimensions?.servedTenant);
    if (served.length > 0) {
      const tenantIds = served.map((r) => String(r.dimensions!.servedTenant));
      const { rows: names } = await withGlobal((c) => c.query<{ id: string; name: string }>(`SELECT id, name FROM companies WHERE id = ANY($1::uuid[])`, [tenantIds]));
      const nameById = new Map(names.map((r) => [r.id, r.name]));
      distributions.push({
        key: "served_companies_split",
        label: "Served companies",
        kind: "stacked",
        slices: served.map((r) => ({
          label: nameById.get(String(r.dimensions!.servedTenant)) ?? String(r.dimensions!.servedTenant),
          value: r.numerator,
        })),
      });
    }
  }

  return { series, distributions };
}

/** Grain-specific tables (§7). Deliberately modest per-grain picks — see file header. */
async function buildTables(
  tenantId: string,
  grain: ReportGrain,
  scopeRef: string,
  servedTenantId: string | undefined,
  start: string,
  end: string,
  currentRows: RollupRow[],
): Promise<ReportTable[]> {
  const readTenant = servedTenantId ?? tenantId;
  const tables: ReportTable[] = [];

  if (grain === "person") {
    // Contributions: credited contributor-role minutes on OTHER people's tasks, by project (§3.1's
    // contributor rule, metric #15). Project-level, not task-level — a documented narrowing (task-
    // level detail would need the same task_role classification SQL fact-job.ts already owns, and
    // duplicating it here was judged not worth the risk of drift for this ticket's scope).
    const { rows } = await withTenants(
      [readTenant],
      (c) =>
        c.query<{ project_id: string | null; minutes: string }>(
          `SELECT project_id, SUM(minutes_contributed) AS minutes FROM report_work_facts
            WHERE tenant_id = $1 AND user_id = $2 AND fact_date BETWEEN $3::date AND $4::date AND minutes_contributed > 0
            GROUP BY project_id`,
          [readTenant, scopeRef, start, end],
        ),
      { modules: [...REPORT_JOB_MODULES] },
    );
    if (rows.length > 0) {
      const projectIds = rows.filter((r) => r.project_id).map((r) => r.project_id as string);
      const names = projectIds.length
        ? await withTenants([readTenant], (c) => c.query<{ id: string; name: string }>(`SELECT id, name FROM projects WHERE id = ANY($1::uuid[])`, [projectIds]))
        : { rows: [] as { id: string; name: string }[] };
      const nameById = new Map(names.rows.map((r) => [r.id, r.name]));
      const tableRows = rows.map((r) => ({ project: r.project_id ? nameById.get(r.project_id) ?? r.project_id : "Non-project work", minutes: Number(r.minutes) }));
      tables.push({
        key: "contributions",
        label: "Contributions to others' work",
        columns: [
          { key: "project", label: "Project", unit: "text", align: "left" },
          { key: "minutes", label: "Minutes contributed", unit: "minutes", align: "right" },
        ],
        rows: tableRows,
        totalRow: { project: "Total", minutes: tableRows.reduce((s, r) => s + r.minutes, 0) },
      });
    }
  }

  if (grain === "project") {
    // Overdue tasks as of range END (same point-in-time semantics as metric #20 — current-state,
    // not a historical snapshot; §15's accepted limitation applies here too).
    const { rows } = await withTenants(
      [tenantId],
      (c) =>
        c.query<{ id: string; title: string; due_date: string; status: string }>(
          `SELECT id, title, due_date::text AS due_date, status FROM pm_tasks
            WHERE tenant_id = $1 AND project_id = $2 AND deleted_at IS NULL
              AND due_date IS NOT NULL AND due_date < $3::date
            ORDER BY due_date ASC LIMIT 100`,
          [tenantId, scopeRef, end],
        ),
      { modules: [...REPORT_JOB_MODULES] },
    );
    if (rows.length > 0) {
      const doneIds = new Set((await withTenants([tenantId], (c) => effectiveStatuses(c, scopeRef), { modules: [...REPORT_JOB_MODULES] })).filter((s) => s.isDone).map((s) => s.id));
      const overdue = rows.filter((r) => !doneIds.has(r.status));
      if (overdue.length > 0) {
        tables.push({
          key: "overdue_tasks",
          label: "Overdue tasks (as of range end)",
          columns: [
            { key: "title", label: "Task", unit: "text", align: "left" },
            { key: "dueDate", label: "Due", unit: "text", align: "left" },
          ],
          rows: overdue.map((r) => ({ title: r.title, dueDate: r.due_date })),
        });
      }
    }
  }

  if (grain === "department" && !servedTenantId) {
    // Per-person table: members as-of range END whose as-of unit rolls to this department.
    const { rows: memberships } = await withTenants(
      [tenantId],
      (c) =>
        c.query<{ user_id: string; unit_node_id: string; valid_from: string; valid_to: string | null }>(
          `SELECT user_id, unit_node_id, valid_from::text AS valid_from, valid_to::text AS valid_to
             FROM org_unit_memberships WHERE tenant_id = $1 AND is_primary`,
          [tenantId],
        ),
      { modules: [...REPORT_JOB_MODULES] },
    );
    const { rows: blobRows } = await withTenants([tenantId], (c) => c.query<{ structure: { root?: OrgLabelNode & { kind?: string } } }>(`SELECT structure FROM company_org_structure WHERE tenant_id = $1`, [tenantId]), {
      modules: [...REPORT_JOB_MODULES],
    });
    const byUser = new Map<string, MembershipInterval[]>();
    for (const m of memberships) {
      (byUser.get(m.user_id) ?? byUser.set(m.user_id, []).get(m.user_id)!).push({ unitNodeId: m.unit_node_id, validFrom: m.valid_from, validTo: m.valid_to });
    }
    const unitDept = deriveUnitDepartmentsLocal(blobRows[0]?.structure?.root);
    const memberIds: string[] = [];
    for (const [userId, intervals] of byUser) {
      const asOf = resolveMembershipAsOf(intervals, end);
      if (!asOf) continue;
      const dept = unitDept[asOf.unitNodeId] ?? asOf.unitNodeId;
      if (dept === scopeRef) memberIds.push(userId);
    }
    if (memberIds.length > 0) {
      const { rows: names } = await withGlobal((c) => c.query<{ id: string; name: string }>(`SELECT id, name FROM users WHERE id = ANY($1::uuid[])`, [memberIds]));
      const nameById = new Map(names.map((r) => [r.id, r.name]));
      const tableRows = memberIds.map((userId) => {
        const throughput = findRow(currentRows, "delivery.throughput_weighted", "person", userId)?.numerator ?? 0;
        const onTimeRow = findRow(currentRows, "delivery.on_time_rate", "person", userId);
        const onTime = onTimeRow?.denominator ? onTimeRow.numerator / onTimeRow.denominator : null;
        return { person: nameById.get(userId) ?? userId, throughput, onTimeRate: onTime };
      });
      tables.push({
        key: "per_person",
        label: "Per-person summary",
        columns: [
          { key: "person", label: "Person", unit: "text", align: "left" },
          { key: "throughput", label: "Throughput (min)", unit: "minutes", align: "right" },
          { key: "onTimeRate", label: "On-time rate", unit: "percent", align: "right" },
        ],
        rows: tableRows,
      });
    }
  }

  if (grain === "company") {
    const throughputRows = currentRows.filter((r) => r.metricKey === "delivery.throughput_weighted" && r.dimensions?.unit && !r.dimensions?.servedTenant);
    if (throughputRows.length > 0) {
      const { rows: blobRows } = await withTenants([tenantId], (c) => c.query<{ structure: { root?: OrgLabelNode } }>(`SELECT structure FROM company_org_structure WHERE tenant_id = $1`, [tenantId]), {
        modules: [...REPORT_JOB_MODULES],
      });
      const root = blobRows[0]?.structure?.root;
      const tableRows = throughputRows.map((r) => {
        const unit = String(r.dimensions!.unit);
        const onTimeRow = currentRows.find((x) => x.metricKey === "delivery.on_time_rate" && x.dimensions?.unit === unit && !x.dimensions?.servedTenant);
        const reopenRow = currentRows.find((x) => x.metricKey === "flow.reopen_rate" && x.dimensions?.unit === unit && !x.dimensions?.servedTenant);
        return {
          department: findNodeLabel(root, unit) ?? unit,
          throughput: r.numerator,
          onTimeRate: onTimeRow?.denominator ? onTimeRow.numerator / onTimeRow.denominator : null,
          reopenRate: reopenRow?.denominator ? reopenRow.numerator / reopenRow.denominator : null,
        };
      });
      tables.push({
        key: "department_portfolio",
        label: "Department portfolio",
        columns: [
          { key: "department", label: "Department", unit: "text", align: "left" },
          { key: "throughput", label: "Throughput (min)", unit: "minutes", align: "right" },
          { key: "onTimeRate", label: "On-time rate", unit: "percent", align: "right" },
          { key: "reopenRate", label: "Reopen rate", unit: "percent", align: "right" },
        ],
        rows: tableRows,
      });
    }
  }

  return tables;
}

/** Local copy of fact-job.ts's `deriveUnitDepartments` walk, adapted to the `{id,name,children}`
 *  shape the admin org-structure controller actually writes (fact-job.ts's own `OrgNodeLike` omits
 *  `name`/`kind` typing details it doesn't need — re-declared here rather than widening that
 *  file's exported type for a label lookup it has no other use for). */
function deriveUnitDepartmentsLocal(root: (OrgLabelNode & { kind?: string }) | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!root) return out;
  const UNIT_KINDS = new Set(["department", "division"]);
  const walk = (node: OrgLabelNode & { kind?: string }, inherited: string | null) => {
    let forSubtree = inherited;
    if (node.id && node.kind && UNIT_KINDS.has(node.kind)) {
      if (node.kind === "department") {
        forSubtree = node.id;
        out[node.id] = node.id;
      } else {
        out[node.id] = inherited ?? node.id;
      }
    }
    for (const child of node.children ?? []) walk(child, forSubtree);
  };
  walk(root, null);
  return out;
}

// ═══════════════════════════════ PURE — highlights + narrative ═══════════════════════════════

export function buildHighlights(kpis: ReportKpi[], periodEnd: string, today: string): ReportHighlight[] {
  const highlights: ReportHighlight[] = [];
  const completed = kpis.find((k) => k.metricKey === "delivery.tasks_completed");
  const onTime = kpis.find((k) => k.metricKey === "delivery.on_time_rate");
  if (completed && completed.value > 0) {
    const onTimeText = onTime?.numerator !== undefined && onTime?.denominator ? ` (${onTime.numerator} of ${onTime.denominator} on time)` : "";
    highlights.push({ kind: "achievement", text: `Completed ${completed.value} task${completed.value === 1 ? "" : "s"}${onTimeText}.` });
  }
  const overdue = kpis.find((k) => k.metricKey === "discipline.overdue_open");
  if (overdue && overdue.value > 0) {
    // §15 ruling: never present #20 on a past unsealed range without the honesty chrome. There is
    // no dedicated `header.warnings` key for this (the fixed vocabulary has none that fits — see
    // document-builder's own header comment); this highlight plus the KPI's `pointInTime: true`
    // plus `header.sealed === false` (always true today) is how that chrome is carried instead.
    const asOfNote = periodEnd < today ? ` Reflects TODAY's task state, not ${periodEnd}'s (point-in-time, unsealed).` : "";
    highlights.push({ kind: "compliance", text: `${overdue.value} task${overdue.value === 1 ? " is" : "s are"} overdue and still open.${asOfNote}` });
  }
  return highlights;
}

export function buildNarrative(kpis: ReportKpi[]): ReportNarrative {
  const completed = kpis.find((k) => k.metricKey === "delivery.tasks_completed");
  const onTime = kpis.find((k) => k.metricKey === "delivery.on_time_rate");
  const minutes = kpis.find((k) => k.metricKey === "effort.minutes_logged");
  const parts: string[] = [];
  // Every KPI in `kpis` always EXISTS for an applicable grain (buildKpis never omits a metric —
  // "empty but valid" means value 0, not a missing entry), so gating on `.value > 0` here (not
  // merely "the KPI object is present") is what makes a genuinely empty period narrate as
  // "No activity" instead of "Completed 0 tasks, 0 minutes logged." — the honest fallback the
  // acceptance bar requires.
  if (completed && completed.value > 0) parts.push(`Completed ${completed.value} task${completed.value === 1 ? "" : "s"}`);
  if (onTime && onTime.denominator) parts.push(`${onTime.numerator} of ${onTime.denominator} on time`);
  if (minutes && minutes.value > 0) parts.push(`${minutes.value} minutes logged`);
  const text = parts.length > 0 ? `${parts.join(", ")}.` : "No activity recorded for this period.";
  return { source: "deterministic", text };
}

// ═══════════════════════════════ ORCHESTRATION ═══════════════════════════════

export interface BuildDocumentParams {
  tenantId: string;
  grain: ReportGrain;
  scopeRef: string;
  periodKind: ReportPeriodKind;
  /** Already-resolved [start, end] — the controller resolves day/week/month via
   *  `resolveCalendarRange` and validates a `custom` range BEFORE calling this function. This
   *  function trusts its inputs (house pattern: pure-ish core, validation at the edge). */
  start: string;
  end: string;
  /** Department grain only: slice the document down to ONE served company's contribution
   *  (§3.2's provider view). Omitted -> the department's own numbers + a `served_companies_split`
   *  distribution summarizing every served company at once. */
  servedTenantId?: string;
  /** Overridable for tests; defaults to real UTC today. */
  today?: string;
}

/** Builds the full live-path `ReportDocument`. Never touches `rollup_metrics` (§0057 rule 3) —
 *  every number is either a fresh `reportRollups.compute()` call or a direct `report_work_facts`
 *  read. Sealing (TR-15) layers on later by adding a branch BEFORE this function runs: "if the
 *  period is sealed and not custom, return the stored `report_documents` row instead" — nothing in
 *  this function's shape needs to change for that, it simply becomes the "else" branch reachable
 *  today.*/
export async function buildReportDocument(params: BuildDocumentParams): Promise<ReportDocument> {
  const { tenantId, grain, scopeRef, periodKind, start, end, servedTenantId } = params;
  const today = params.today ?? todayIso();
  const dayCount = inclusiveDayCount(start, end);

  await ensureTodayFresh(tenantId, start, end, today);

  const comparison = previousPeriodRange(periodKind, start, end, dayCount);

  const [currentRows, previousRows, currentDiversity, previousDiversity, scopeName, firstFact] = await Promise.all([
    computeRangeRows(tenantId, start, end),
    computeRangeRows(tenantId, comparison.start, comparison.end),
    computeSourceDiversity(tenantId, grain, scopeRef, servedTenantId, start, end),
    computeSourceDiversity(tenantId, grain, scopeRef, servedTenantId, comparison.start, comparison.end),
    resolveScopeName(tenantId, grain, scopeRef),
    firstFactDate(tenantId),
  ]);

  const spansMembershipChange = grain === "person" ? await personSpansMembershipChange(tenantId, scopeRef, start, end) : undefined;

  const kpis = buildKpis(grain, scopeRef, currentRows, previousRows, servedTenantId, { current: currentDiversity, previous: previousDiversity });
  const { series, distributions } = await buildSeriesAndDistributions(tenantId, grain, scopeRef, servedTenantId, start, end, today, currentRows);
  const tables = await buildTables(tenantId, grain, scopeRef, servedTenantId, start, end, currentRows);
  const highlights = buildHighlights(kpis, end, today);
  const narrative = buildNarrative(kpis);

  const header: ReportHeader = {
    tenantId,
    grain,
    scopeRef,
    scopeName,
    periodKind,
    periodStart: start,
    periodEnd: end,
    dayCount,
    periodLabel: formatPeriodLabel(periodKind, start, end),
    generatedAt: new Date().toISOString(),
    sealed: false, // always false — the live path only; TR-15 layers sealed reads on top
    comparison: { periodStart: comparison.start, periodEnd: comparison.end, dayCount: comparison.dayCount },
    warnings: computeHeaderWarnings({ periodKind, start, end, today, firstFactDate: firstFact, spansMembershipChange }),
  };
  if (servedTenantId) {
    const { rows } = await withGlobal((c) => c.query<{ name: string }>(`SELECT name FROM companies WHERE id = $1`, [servedTenantId]));
    header.providerView = { servedTenantId, servedTenantName: rows[0]?.name ?? servedTenantId };
  }

  return { header, kpis, series, distributions, tables, highlights, narrative };
}

// re-exported so callers (reports.controller.ts, tests) can read a raw metric row set for an
// ad-hoc power-user/MCP query (GET /reports/metrics) without a second implementation of "compute
// this tenant's rollup rows for a period".
export { computeRangeRows as computeReportRangeRows };
export type { RollupRow };

/** Which grain a `RollupRow.dimensions` shape belongs to — report-rollups.ts's own dimension
 *  literals are exact-shape per grain (see `matchesScope`'s header comment), so this is a plain
 *  key-presence check. Used by the `/reports/metrics` listing endpoint, which has no single
 *  `scopeRef` to filter by (it lists every entity of a grain) unlike `matchesScope` above. */
export function rowGrainShape(dims: Record<string, unknown>): ReportGrain {
  if ("userId" in dims) return "person";
  if ("projectId" in dims) return "project";
  if ("unit" in dims) return "department";
  return "company";
}
