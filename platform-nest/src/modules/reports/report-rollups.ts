// TR-08 — the reports module's `RollupProvider`: turns `report_work_facts` (+ pm_progress_snapshots,
// pm_milestones, report_checkins, the work calendar) into the 21 SEEDED §5 metrics, upserted into
// the governed `rollup_metrics` registry (rollups/engine.ts, D12).
//
// ─────────────────────────────── THE PERIOD CONVENTION (see metrics.ts) ───────────────────────────
// `compute(client, tenantId, period)` receives `period` as `'YYYY-MM-DD:YYYY-MM-DD'` (inclusive
// range) — metrics.ts's `parsePeriodRange` is the ONE place that format is defined. Every ratio
// divides by the ACTUAL day count of that range (§4a invariant 2, §15 ruling ③), never an assumed
// 7 or 30 — `range.days` is threaded through every days-denominated ratio below.
//
// ─────────────────────────────── SCOPE DISCIPLINE (§4a invariant 7) ───────────────────────────────
// `rollups/engine.ts`'s per-module invocation loop calls `provider.compute` under
// `withTenants([tenantId], fn, {modules:['reports']})` — ONLY the reports third wall is open on the
// `client` this function receives. That is sufficient for `report_work_facts`/`report_checkins`/
// `report_work_calendars` (reports-walled) AND for every `pm_*`/`projects`/`org_unit_memberships`/
// `company_org_structure` table (plain tenant policy, no third wall) via the SAME client. The THREE
// metrics that need `hr_leave_requests`/`hr_attendance` (#14, #18, #19's expected-day calculus)
// open their OWN short-lived `withTenants([tenantId], fn, {modules:['reports','hr']})` scope
// (a fresh pooled connection, not a nested SQL transaction) — the same "declare exactly where you
// need it" pattern `gatherForeignContext` uses in fact-job.ts. Never widened onto the shared
// `client`, so no OTHER metric silently gains an hr-scope dependency it doesn't need.
import type { PoolClient } from "pg";
import { withTenants } from "../../db";
import type { RollupProvider, RollupRow } from "../contract";
import { effectiveStatuses } from "../pm/pm.controller";
import { resolveMembershipAsOf, type MembershipInterval } from "../../core/dept-resolution";
import {
  attributePerson,
  DEFAULT_WORK_CALENDAR,
  deriveUnitDepartments,
  expectedCheckinUsers,
  type AssigneeKind,
  type OrgNodeLike,
  type WorkCalendar,
} from "./fact-job";
import { parsePeriodRange, toMetricDefs, type ReportMetricDef, type ReportMetricGrain, SEEDED_REPORT_METRICS } from "./metrics";

// ═══════════════════════════ generic report_work_facts aggregation (13 metrics) ═══════════════════

/** Every additive column `report_work_facts` carries that at least one seeded metric divides by or
 *  sums directly. Kept as one literal list so the SELECT and the lookup key always agree. */
const FACT_SUM_COLUMNS = [
  "tasks_completed",
  "tasks_completed_on_time",
  "tasks_completed_with_due_date",
  "tasks_completed_estimated",
  "estimate_minutes_completed",
  "estimate_minutes_completed_with_actual",
  "minutes_logged_completed_with_actual",
  "tasks_reopened",
  "tasks_created",
  "minutes_logged",
  "minutes_billable",
  "minutes_contributed",
  "comments_authored",
  "docs_updated",
  "activity_events",
  "activity_linked_exact",
] as const;
type FactSumColumn = (typeof FACT_SUM_COLUMNS)[number];
type FactSums = Record<FactSumColumn, number>;

const ZERO_SUMS: FactSums = Object.fromEntries(FACT_SUM_COLUMNS.map((c) => [c, 0])) as FactSums;

function toFactSums(row: Record<string, string | null>): FactSums {
  const out = { ...ZERO_SUMS };
  for (const c of FACT_SUM_COLUMNS) out[c] = Number(row[c] ?? 0);
  return out;
}

const SUM_SELECT = FACT_SUM_COLUMNS.map((c) => `COALESCE(SUM(${c}), 0) AS ${c}`).join(", ");
/** The same sums with the columns qualified by the `report_work_facts` alias `f`, for the client
 *  regroup that joins `projects` and `clients` (PV7-01). */
const SUM_SELECT_F = FACT_SUM_COLUMNS.map((c) => `COALESCE(SUM(f.${c}), 0) AS ${c}`).join(", ");

/** PV7-01 — which projects count toward a client, in SQL. A project joins a client only through
 *  `projects.client_id`, and BOTH shapes of internal work are out: `projects.is_internal` and the
 *  sentinel `clients.is_internal` (the two shapes `dept-kpi-readers/scope.ts` excludes), plus
 *  anything soft-deleted. Callers alias `projects p` and `clients c`. */
export const CLIENT_PROJECT_ELIGIBLE_SQL = `p.deleted_at IS NULL AND c.deleted_at IS NULL AND NOT p.is_internal AND NOT c.is_internal`;

/** PV7-05 — delivery on time per client for a date range, as ONE set query over `clientIds[]` (the health board's seam,
 *  `deliveryOnTimeFor` in clients/client-health.ts). It is the client-grain regroup `computeOwnFactRollups` does, narrowed
 *  to the one metric and to the clients asked for, so the board's query count stays fixed. The columns come from the
 *  metric's own catalog entry, so a change to what "on time" means moves this with the report. `client` must carry the
 *  tenant's `reports` scope (a missed wall reads ZERO rows, silently). A client with no completions that carried a due date
 *  has no answer: its entry is `null`, never 0. */
export async function loadClientOnTimeRates(
  client: PoolClient, tenantId: string, start: string, end: string, clientIds: string[],
): Promise<Map<string, number | null>> {
  const cols = SEEDED_REPORT_METRICS.find((m) => m.metricKey === "delivery.on_time_rate")?.factColumns;
  const num = cols?.numerator as FactSumColumn | undefined;
  const den = cols?.denominator as FactSumColumn | undefined;
  if (!num || !den || !FACT_SUM_COLUMNS.includes(num) || !FACT_SUM_COLUMNS.includes(den)) {
    throw new Error("delivery.on_time_rate has no fact columns in the metric catalog");
  }
  const out = new Map<string, number | null>(clientIds.map((id) => [id, null]));
  if (clientIds.length === 0) return out;
  const { rows } = await client.query<{ client_id: string; num: string; den: string }>(
    `SELECT p.client_id, COALESCE(SUM(f.${num}), 0) AS num, COALESCE(SUM(f.${den}), 0) AS den
       FROM report_work_facts f
       JOIN projects p ON p.id = f.project_id AND p.tenant_id = f.tenant_id
       JOIN clients c ON c.id = p.client_id AND c.tenant_id = p.tenant_id
      WHERE f.tenant_id = $1 AND f.fact_date BETWEEN $2::date AND $3::date
        AND p.client_id = ANY($4::uuid[]) AND ${CLIENT_PROJECT_ELIGIBLE_SQL}
      GROUP BY p.client_id`,
    [tenantId, start, end, clientIds],
  );
  for (const r of rows) {
    const d = Number(r.den);
    out.set(r.client_id, d > 0 ? Number(r.num) / d : null);
  }
  return out;
}

/** project id -> client id for every project that counts toward a client (see
 *  `CLIENT_PROJECT_ELIGIBLE_SQL`). Milestone, flow and overdue rows regroup through this map the
 *  way flow already maps project -> department. Reads the CURRENT `projects.client_id`, so a live
 *  range follows a moved project; a sealed period keeps its stored documents. */
async function loadProjectClientMap(client: PoolClient, tenantId: string): Promise<Map<string, string>> {
  const { rows } = await client.query<{ id: string; client_id: string }>(
    `SELECT p.id, p.client_id FROM projects p
       JOIN clients c ON c.id = p.client_id AND c.tenant_id = p.tenant_id
      WHERE p.tenant_id = $1 AND ${CLIENT_PROJECT_ELIGIBLE_SQL}`,
    [tenantId],
  );
  return new Map(rows.map((r) => [r.id, r.client_id]));
}

/** Metrics whose numerator/denominator are plain `report_work_facts` column sums (§5.4 class A/R
 *  metrics 1,2,3,4,6,9,11,12,13,15,16,17,21 — 13 of the 21 seeded rows). Everything else (5,7,8,10,
 *  14,18,19,20) has its own dedicated source and is computed by the functions further below. */
const FACT_BACKED_METRICS: readonly ReportMetricDef[] = SEEDED_REPORT_METRICS.filter((m) => m.factColumns);

/** §5.4/invariant-2: `delivery.backlog_delta` (#6) is Σcreated − Σcompleted, a NET count, not a
 *  ratio — `aggregationRule` is `'sum'`, so it must be emitted with NO denominator even though its
 *  catalog entry borrows `factColumns.denominator` to name the second column it needs. */
const NET_DIFFERENCE_METRICS = new Set(["delivery.backlog_delta"]);

function rowsFromFactSums(metrics: readonly ReportMetricDef[], sums: FactSums, dimensions: Record<string, unknown>): RollupRow[] {
  const out: RollupRow[] = [];
  for (const m of metrics) {
    if (!m.factColumns) continue;
    const numerator = sums[m.factColumns.numerator as FactSumColumn];
    if (NET_DIFFERENCE_METRICS.has(m.metricKey)) {
      const denomCol = m.factColumns.denominator as FactSumColumn;
      out.push({ metricKey: m.metricKey, numerator: numerator - sums[denomCol], dimensions });
      continue;
    }
    const denominator = m.factColumns.denominator ? sums[m.factColumns.denominator as FactSumColumn] : undefined;
    out.push({ metricKey: m.metricKey, numerator, denominator, dimensions });
  }
  return out;
}

function metricsForGrain(grain: ReportMetricGrain): readonly ReportMetricDef[] {
  return FACT_BACKED_METRICS.filter((m) => m.grains.includes(grain));
}

/** Person/project/department/company aggregation off the tenant's OWN `report_work_facts` rows —
 *  the `client` passed in already carries the tenant's `reports` scope (the engine's invocation). */
async function computeOwnFactRollups(client: PoolClient, tenantId: string, start: string, end: string): Promise<RollupRow[]> {
  const rows: RollupRow[] = [];

  const person = await client.query<{ user_id: string } & Record<FactSumColumn, string>>(
    `SELECT user_id, ${SUM_SELECT} FROM report_work_facts
      WHERE tenant_id = $1 AND fact_date BETWEEN $2::date AND $3::date AND user_id IS NOT NULL
      GROUP BY user_id`,
    [tenantId, start, end],
  );
  for (const r of person.rows) {
    rows.push(...rowsFromFactSums(metricsForGrain("person"), toFactSums(r), { userId: r.user_id }));
  }

  const project = await client.query<{ project_id: string } & Record<FactSumColumn, string>>(
    `SELECT project_id, ${SUM_SELECT} FROM report_work_facts
      WHERE tenant_id = $1 AND fact_date BETWEEN $2::date AND $3::date AND project_id IS NOT NULL
      GROUP BY project_id`,
    [tenantId, start, end],
  );
  for (const r of project.rows) {
    rows.push(...rowsFromFactSums(metricsForGrain("project"), toFactSums(r), { projectId: r.project_id }));
  }

  // Client grain (PV7-01): the same fact sums regrouped through `projects.client_id`. The sums are
  // taken over ALL of a client's project rows at once, so a ratio is Sum(numerator) / Sum(denominator)
  // across the projects, never a mean of per-project ratios. Rows with no project (non-project work)
  // have no client and are not in any client's figures.
  const byClient = await client.query<{ client_id: string } & Record<FactSumColumn, string>>(
    `SELECT p.client_id, ${SUM_SELECT_F}
       FROM report_work_facts f
       JOIN projects p ON p.id = f.project_id AND p.tenant_id = f.tenant_id
       JOIN clients c ON c.id = p.client_id AND c.tenant_id = p.tenant_id
      WHERE f.tenant_id = $1 AND f.fact_date BETWEEN $2::date AND $3::date AND ${CLIENT_PROJECT_ELIGIBLE_SQL}
      GROUP BY p.client_id`,
    [tenantId, start, end],
  );
  for (const r of byClient.rows) {
    rows.push(...rowsFromFactSums(metricsForGrain("client"), toFactSums(r), { clientId: r.client_id }));
  }

  // Department grain: grouped by the ROLLED `department_node_id` (§3.1 — divisions roll to their
  // department; a foreign/unrolled unit_node_id is carried through as-is per the documented §15
  // finding ⑤ limitation). Rows with no resolved department (the explicit unattributed bucket, §3.1
  // row 4b) are excluded here — they have no `{unit}` dimension to key on; the Σperson≤Σunit=company
  // identity is reconciled directly against report_work_facts (TR-29), not through this rollup.
  const dept = await client.query<{ department_node_id: string } & Record<FactSumColumn, string>>(
    `SELECT department_node_id, ${SUM_SELECT} FROM report_work_facts
      WHERE tenant_id = $1 AND fact_date BETWEEN $2::date AND $3::date AND department_node_id IS NOT NULL
      GROUP BY department_node_id`,
    [tenantId, start, end],
  );
  for (const r of dept.rows) {
    rows.push(...rowsFromFactSums(metricsForGrain("department"), toFactSums(r), { unit: r.department_node_id }));
  }

  const company = await client.query<Record<FactSumColumn, string>>(
    `SELECT ${SUM_SELECT} FROM report_work_facts WHERE tenant_id = $1 AND fact_date BETWEEN $2::date AND $3::date`,
    [tenantId, start, end],
  );
  rows.push(...rowsFromFactSums(metricsForGrain("company"), toFactSums(company.rows[0] ?? {}), {}));

  return rows;
}

/** D12's provider view: "dept of company A incl. work done for B" (§3.2). `tenantId` here IS the
 *  provider (A). Facts for work A's people did for a served company B are written under B's OWN
 *  `report_work_facts` (data never re-homes), stamped `provider_tenant_id=A`/`provider_unit_node_id`
 *  — so A cannot see them via a plain SELECT scoped to itself. Step 1 discovers which tenants A
 *  legitimately serves (`service_assignments`, readable from A's own scope — 0026's dual-side
 *  `sa_select`). Step 2 opens ONE SEPARATE single-tenant scope PER served tenant (mirrors
 *  `gatherForeignContext`'s two-step shape in fact-job.ts — D5: never a widened tenant set) to sum
 *  that tenant's facts stamped for A, grouped by `provider_unit_node_id`. Emitted with dimensions
 *  `{unit, servedTenant}` for every fact-backed metric that supports the department grain — the
 *  D12-sanctioned, ONLY cross-company read path (never a raw cross-tenant JOIN). */
async function computeProviderViewRollups(tenantId: string, start: string, end: string): Promise<RollupRow[]> {
  const served = await withTenants(
    [tenantId],
    (c) =>
      c.query<{ target_tenant_id: string }>(
        `SELECT DISTINCT target_tenant_id FROM service_assignments
          WHERE provider_tenant_id = $1 AND status = 'active'`,
        [tenantId],
      ),
    { modules: ["reports"] },
  );
  if (served.rows.length === 0) return [];

  const deptEligible = FACT_BACKED_METRICS.filter((m) => m.grains.includes("department"));
  const rows: RollupRow[] = [];
  for (const { target_tenant_id: servedTenantId } of served.rows) {
    // Single-element tenant array — one served tenant's scope at a time, never widened (D5).
    const agg = await withTenants(
      [servedTenantId],
      (c) =>
        c.query<{ provider_unit_node_id: string } & Record<FactSumColumn, string>>(
          `SELECT provider_unit_node_id, ${SUM_SELECT} FROM report_work_facts
            WHERE tenant_id = $1 AND provider_tenant_id = $2 AND provider_unit_node_id IS NOT NULL
              AND fact_date BETWEEN $3::date AND $4::date
            GROUP BY provider_unit_node_id`,
          [servedTenantId, tenantId, start, end],
        ),
      { modules: ["reports"] },
    );
    for (const r of agg.rows) {
      rows.push(...rowsFromFactSums(deptEligible, toFactSums(r), { unit: r.provider_unit_node_id, servedTenant: servedTenantId }));
    }
  }
  return rows;
}

// ═══════════════════════════ #5 delivery.milestone_hit_rate (pm_milestones) ═══════════════════════
//
// KNOWN LIMITATION (documented rather than silently redefined, per the ticket's own instruction):
// `pm_milestones` carries no `completed_at` — only a mutable `status` and `due_date`. "Hit" is
// therefore CURRENTLY-done-and-due-in-range, not provably on-or-before its due date; a milestone
// completed weeks late but still 'done' today reads as a hit. Closing this properly needs a
// completed_at column on pm_milestones, which is a schema change to a table this ticket does not
// own (pm.controller.ts is explicitly off-limits) — flagged here, not fixed quietly.
async function computeMilestoneHitRate(client: PoolClient, tenantId: string, start: string, end: string): Promise<RollupRow[]> {
  const rows: RollupRow[] = [];

  const byProject = await client.query<{ project_id: string; due: string; hit: string }>(
    `SELECT project_id, count(*) AS due, count(*) FILTER (WHERE status = 'done') AS hit
       FROM pm_milestones
      WHERE tenant_id = $1 AND deleted_at IS NULL AND due_date BETWEEN $2::date AND $3::date
      GROUP BY project_id`,
    [tenantId, start, end],
  );
  for (const r of byProject.rows) {
    rows.push({ metricKey: "delivery.milestone_hit_rate", numerator: Number(r.hit), denominator: Number(r.due), dimensions: { projectId: r.project_id } });
  }

  // Client grain (PV7-01): Sum(hit) / Sum(due) across the client's projects, never a mean of rates.
  const byClient = await client.query<{ client_id: string; due: string; hit: string }>(
    `SELECT p.client_id, count(*) AS due, count(*) FILTER (WHERE m.status = 'done') AS hit
       FROM pm_milestones m
       JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
       JOIN clients c ON c.id = p.client_id AND c.tenant_id = p.tenant_id
      WHERE m.tenant_id = $1 AND m.deleted_at IS NULL AND m.due_date BETWEEN $2::date AND $3::date
        AND ${CLIENT_PROJECT_ELIGIBLE_SQL}
      GROUP BY p.client_id`,
    [tenantId, start, end],
  );
  for (const r of byClient.rows) {
    rows.push({ metricKey: "delivery.milestone_hit_rate", numerator: Number(r.hit), denominator: Number(r.due), dimensions: { clientId: r.client_id } });
  }

  const byDept = await client.query<{ department_node_id: string | null; due: string; hit: string }>(
    `SELECT p.department_id AS department_node_id, count(*) AS due, count(*) FILTER (WHERE m.status = 'done') AS hit
       FROM pm_milestones m JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
      WHERE m.tenant_id = $1 AND m.deleted_at IS NULL AND m.due_date BETWEEN $2::date AND $3::date
        AND p.department_id IS NOT NULL
      GROUP BY p.department_id`,
    [tenantId, start, end],
  );
  for (const r of byDept.rows) {
    rows.push({ metricKey: "delivery.milestone_hit_rate", numerator: Number(r.hit), denominator: Number(r.due), dimensions: { unit: r.department_node_id } });
  }

  const company = await client.query<{ due: string; hit: string }>(
    `SELECT count(*) AS due, count(*) FILTER (WHERE status = 'done') AS hit
       FROM pm_milestones WHERE tenant_id = $1 AND deleted_at IS NULL AND due_date BETWEEN $2::date AND $3::date`,
    [tenantId, start, end],
  );
  if (company.rows[0] && Number(company.rows[0].due) > 0) {
    rows.push({ metricKey: "delivery.milestone_hit_rate", numerator: Number(company.rows[0].hit), denominator: Number(company.rows[0].due), dimensions: {} });
  }
  return rows;
}

// ═══════════════════ #7/#8/#10 flow metrics (pm_progress_snapshots + effectiveStatuses) ═══════════
//
// KNOWN LIMITATION: `effectiveStatuses` is read at COMPUTE time (current is_done/is_blocked flags),
// applied uniformly across every snapshot day in the range. A status relabelled mid-range (rare —
// P2-04's flags are meant to be stable) would apply its CURRENT is_blocked flag retroactively to
// older snapshot rows. Acceptable for these three explicitly ops-context/appraisal-unsafe metrics.
async function computeFlowMetrics(client: PoolClient, tenantId: string, start: string, end: string, days: number): Promise<RollupRow[]> {
  const rows: RollupRow[] = [];

  const projects = await client.query<{ id: string; department_id: string | null }>(
    `SELECT id, department_id FROM projects WHERE tenant_id = $1 AND deleted_at IS NULL`,
    [tenantId],
  );
  if (projects.rows.length === 0) return rows;

  const snapshots = await client.query<{
    project_id: string;
    snapshot_date: string;
    open_count: number;
    avg_progress: number;
    status_counts: Record<string, number>;
  }>(
    `SELECT project_id, snapshot_date::text AS snapshot_date, open_count, avg_progress, status_counts
       FROM pm_progress_snapshots
      WHERE tenant_id = $1 AND snapshot_date BETWEEN $2::date AND $3::date`,
    [tenantId, start, end],
  );
  if (snapshots.rows.length === 0) return rows;

  const byProject = new Map<string, typeof snapshots.rows>();
  for (const r of snapshots.rows) {
    (byProject.get(r.project_id) ?? byProject.set(r.project_id, []).get(r.project_id)!).push(r);
  }

  const deptOf = new Map(projects.rows.map((p) => [p.id, p.department_id]));
  const clientOf = await loadProjectClientMap(client, tenantId);
  const clientTotals = new Map<string, { open: number; blocked: number; progressWeighted: number }>();
  const deptTotals = new Map<string, { open: number; blocked: number }>();
  let companyOpen = 0;
  let companyBlocked = 0;

  for (const [projectId, projSnaps] of byProject) {
    const blockedIds = new Set((await effectiveStatuses(client, projectId)).filter((s) => s.isBlocked).map((s) => s.id));
    let openSum = 0;
    let blockedSum = 0;
    let progressWeighted = 0;
    for (const s of projSnaps) {
      openSum += s.open_count;
      progressWeighted += s.avg_progress * s.open_count;
      const counts = (s.status_counts ?? {}) as Record<string, number>;
      for (const [statusId, n] of Object.entries(counts)) {
        if (blockedIds.has(statusId)) blockedSum += Number(n);
      }
    }
    rows.push({ metricKey: "flow.wip_open_avg", numerator: openSum, denominator: days, dimensions: { projectId } });
    rows.push({ metricKey: "flow.blocked_share", numerator: blockedSum, denominator: openSum, dimensions: { projectId } });
    rows.push({ metricKey: "flow.avg_progress", numerator: progressWeighted, denominator: openSum, dimensions: { projectId } });

    const clientId = clientOf.get(projectId);
    if (clientId) {
      const t = clientTotals.get(clientId) ?? { open: 0, blocked: 0, progressWeighted: 0 };
      t.open += openSum;
      t.blocked += blockedSum;
      t.progressWeighted += progressWeighted;
      clientTotals.set(clientId, t);
    }

    const dept = deptOf.get(projectId);
    if (dept) {
      const t = deptTotals.get(dept) ?? { open: 0, blocked: 0 };
      t.open += openSum;
      t.blocked += blockedSum;
      deptTotals.set(dept, t);
    }
    companyOpen += openSum;
    companyBlocked += blockedSum;
  }

  // Client grain (PV7-01). wip_open_avg keeps the range's DAY COUNT as its denominator (summing the
  // per-project day counts would multiply the days); the two ratios divide summed numerators by the
  // summed open counts, never a mean of per-project ratios.
  for (const [clientId, t] of clientTotals) {
    rows.push({ metricKey: "flow.wip_open_avg", numerator: t.open, denominator: days, dimensions: { clientId } });
    rows.push({ metricKey: "flow.blocked_share", numerator: t.blocked, denominator: t.open, dimensions: { clientId } });
    rows.push({ metricKey: "flow.avg_progress", numerator: t.progressWeighted, denominator: t.open, dimensions: { clientId } });
  }

  for (const [dept, t] of deptTotals) {
    rows.push({ metricKey: "flow.wip_open_avg", numerator: t.open, denominator: days, dimensions: { unit: dept } });
    rows.push({ metricKey: "flow.blocked_share", numerator: t.blocked, denominator: t.open, dimensions: { unit: dept } });
  }
  rows.push({ metricKey: "flow.wip_open_avg", numerator: companyOpen, denominator: days, dimensions: {} });
  rows.push({ metricKey: "flow.blocked_share", numerator: companyBlocked, denominator: companyOpen, dimensions: {} });

  return rows;
}

// ═══════════════════ #14/#18/#19 calendar-based discipline/effort metrics ═════════════════════════
//
// Reuses the SAME `expectedCheckinUsers` pure predicate (§5.3) fact-job.ts's nightly auto_missed
// writer uses, applied over every day in the range instead of one day, and with NO write side
// effect (read-only rollup). Needs `hr_leave_requests`/`hr_attendance` — behind the 'hr' third
// wall — so this function opens its OWN `{modules:['reports','hr']}` scope rather than reusing the
// engine-provided `client` (which only carries 'reports'; see the file header).
//
// TR-35 (§15, 2026-07-31 finding): department for the D-grain rollup is resolved PER DAY via the
// SAME pure `resolveMembershipAsOf` (TR-04) the fact job's own precedence ② uses — not once as of
// the range's END date. The old range-end resolution meant a mid-range transfer attributed the
// WHOLE range's compliance/coverage/capacity to the person's end-of-range department while every
// fact-sourced metric split correctly at the transfer date: two metric families on the same report
// disagreeing about where someone worked. Person-grain and company-grain totals are UNCHANGED by
// this fix (they never depended on department) — only the per-department bucketing below is now
// day-by-day, so it lands on the exact same split date `report_work_facts.department_node_id` does
// for this same person (there is no task/project here to fire precedence ①/③, so a person's own
// as-of membership on that specific day IS the whole resolution — identical to how a time-entry
// fact resolves its department in fact-job.ts's `resolveUnit`).
async function computeCalendarMetrics(tenantId: string, start: string, end: string, days: number): Promise<RollupRow[]> {
  return withTenants(
    [tenantId],
    async (c) => {
      const calRow = await c.query<{ working_days: number[]; holidays: unknown; workday_minutes: number }>(
        `SELECT working_days, holidays, workday_minutes FROM report_work_calendars WHERE tenant_id = $1`,
        [tenantId],
      );
      const raw = calRow.rows[0];
      const holidayList = Array.isArray(raw?.holidays) ? (raw.holidays as Array<{ date?: string } | string>) : [];
      const calendar: WorkCalendar = raw
        ? {
            workingDays: raw.working_days ?? DEFAULT_WORK_CALENDAR.workingDays,
            holidays: holidayList.map((h) => (typeof h === "string" ? h : h?.date ?? "")).filter((d) => d.length > 0),
            workdayMinutes: raw.workday_minutes ?? DEFAULT_WORK_CALENDAR.workdayMinutes,
          }
        : DEFAULT_WORK_CALENDAR;

      const memberships = await c.query<{ user_id: string; unit_node_id: string; valid_from: string; valid_to: string | null }>(
        `SELECT user_id, unit_node_id, valid_from::text AS valid_from, valid_to::text AS valid_to
           FROM org_unit_memberships WHERE tenant_id = $1 AND is_primary ORDER BY user_id, valid_from`,
        [tenantId],
      );
      const blob = await c.query<{ structure: OrgNodeLike }>(`SELECT structure FROM company_org_structure WHERE tenant_id = $1`, [tenantId]);
      const unitDept = deriveUnitDepartments(blob.rows[0]?.structure);

      const intervalsByUser = new Map<string, MembershipInterval[]>();
      for (const row of memberships.rows) {
        (intervalsByUser.get(row.user_id) ?? intervalsByUser.set(row.user_id, []).get(row.user_id)!).push({
          unitNodeId: row.unit_node_id,
          validFrom: row.valid_from,
          validTo: row.valid_to,
        });
      }

      // TR-35: a user's rolled department AS OF one specific day. Returns undefined when no
      // membership interval covers that day (the explicit unattributed bucket, §3.1 row 4b) — such
      // days are excluded from department bucketing but still counted at person/company grain,
      // mirroring how `computeOwnFactRollups`'s department query excludes NULL
      // `department_node_id` rows.
      const deptOnDay = (userId: string, day: string): string | undefined => {
        const resolved = resolveMembershipAsOf(intervalsByUser.get(userId) ?? [], day);
        if (!resolved) return undefined;
        return unitDept[resolved.unitNodeId] ?? resolved.unitNodeId;
      };

      const leave = await c.query<{ subject_user_id: string; starts_on: string; ends_on: string }>(
        `SELECT subject_user_id, starts_on::text, ends_on::text FROM hr_leave_requests
          WHERE tenant_id = $1 AND status = 'approved' AND deleted_at IS NULL
            AND starts_on <= $3::date AND ends_on >= $2::date`,
        [tenantId, start, end],
      );
      const attendance = await c.query<{ subject_user_id: string; day: string }>(
        `SELECT subject_user_id, day::text FROM hr_attendance
          WHERE tenant_id = $1 AND status IN ('leave','absent') AND day BETWEEN $2::date AND $3::date`,
        [tenantId, start, end],
      );
      const employedRows = await c.query<{ user_id: string }>(
        `SELECT DISTINCT user_id FROM org_unit_memberships WHERE tenant_id = $1 AND is_primary`,
        [tenantId],
      );
      const employed = employedRows.rows.map((r) => r.user_id);

      // Submitted checkins in range, PER (user, date) — TR-35 needs the individual date to resolve
      // THAT day's department; `submittedByUser` (whole-range totals, used for person/company grain
      // exactly as before §14/§18/§19 always worked) is derived from this same row set below.
      const submitted = await c.query<{ user_id: string; checkin_date: string }>(
        `SELECT user_id, checkin_date::text AS checkin_date FROM report_checkins
          WHERE tenant_id = $1 AND status = 'submitted' AND checkin_date BETWEEN $2::date AND $3::date`,
        [tenantId, start, end],
      );
      const submittedDaysByUser = new Map<string, Set<string>>();
      for (const r of submitted.rows) {
        (submittedDaysByUser.get(r.user_id) ?? submittedDaysByUser.set(r.user_id, new Set()).get(r.user_id)!).add(r.checkin_date);
      }
      // UNIQUE(tenant_id, user_id, checkin_date) means at most one row per (user, date), so
      // count(*) and count(DISTINCT date) always agreed already — this stays a plain size().
      const submittedByUser = new Map<string, number>();
      for (const [user, daySet] of submittedDaysByUser) submittedByUser.set(user, daySet.size);

      // Minutes logged in range, PER (user, date) — same reason: TR-35 needs the date to resolve
      // that day's department. `daysLoggedByUser`/`minutesLoggedByUser` (whole-range totals, used
      // for person/company grain exactly as before) are derived from this same row set below.
      const dailyMinutes = await c.query<{ user_id: string; fact_date: string; minutes: string }>(
        `SELECT user_id, fact_date::text AS fact_date, SUM(minutes_logged) AS minutes FROM report_work_facts
          WHERE tenant_id = $1 AND fact_date BETWEEN $2::date AND $3::date AND user_id IS NOT NULL
          GROUP BY user_id, fact_date`,
        [tenantId, start, end],
      );
      const minutesByUserDay = new Map<string, Map<string, number>>();
      for (const r of dailyMinutes.rows) {
        const perDay = minutesByUserDay.get(r.user_id) ?? new Map<string, number>();
        perDay.set(r.fact_date, Number(r.minutes));
        minutesByUserDay.set(r.user_id, perDay);
      }
      const daysLoggedByUser = new Map<string, number>();
      const minutesLoggedByUser = new Map<string, number>();
      for (const [user, perDay] of minutesByUserDay) {
        let daysWithMinutes = 0;
        let total = 0;
        for (const minutes of perDay.values()) {
          total += minutes;
          if (minutes > 0) daysWithMinutes += 1;
        }
        daysLoggedByUser.set(user, daysWithMinutes);
        minutesLoggedByUser.set(user, total);
      }

      // Per-day expected(user,date) via the SAME §5.3 predicate the fact job's auto_missed writer
      // uses — read-only here, accumulated across the whole range. TR-35: this is also the
      // per-day department-split pass for the EXPECTED-days denominator — for every user expected
      // on day `d`, resolve THAT day's department (never the range-end department) and bucket the
      // day into it.
      const leaveByUser = new Map<string, Array<{ from: string; to: string }>>();
      for (const l of leave.rows) (leaveByUser.get(l.subject_user_id) ?? leaveByUser.set(l.subject_user_id, []).get(l.subject_user_id)!).push({ from: l.starts_on, to: l.ends_on });
      const attendanceByUser = new Map<string, Set<string>>();
      for (const a of attendance.rows) (attendanceByUser.get(a.subject_user_id) ?? attendanceByUser.set(a.subject_user_id, new Set()).get(a.subject_user_id)!).add(a.day);

      const expectedDaysByUser = new Map<string, number>();
      const deptExpected = new Map<string, number>();
      for (let d = start; d <= end; d = addDays(d, 1)) {
        const approvedLeave = employed.filter((u) => (leaveByUser.get(u) ?? []).some((r) => r.from <= d && r.to >= d));
        const attendanceOff = employed.filter((u) => attendanceByUser.get(u)?.has(d));
        const expected = expectedCheckinUsers({ date: d, calendar, employed, approvedLeave, attendanceOff });
        for (const u of expected) {
          expectedDaysByUser.set(u, (expectedDaysByUser.get(u) ?? 0) + 1);
          const dept = deptOnDay(u, d);
          if (dept) deptExpected.set(dept, (deptExpected.get(dept) ?? 0) + 1);
        }
      }

      // TR-35: the submitted/logged-minutes department split, resolved per (user, date) directly
      // off the row-level maps above — decoupled from "expected"-ness exactly as the person/company
      // totals always were (a submission or logged day outside the expected set still counted
      // there, so it must still count here, just bucketed by ITS OWN day's department).
      const deptSubmitted = new Map<string, number>();
      for (const [user, daySet] of submittedDaysByUser) {
        for (const d of daySet) {
          const dept = deptOnDay(user, d);
          if (dept) deptSubmitted.set(dept, (deptSubmitted.get(dept) ?? 0) + 1);
        }
      }
      const deptDaysLogged = new Map<string, number>();
      const deptMinutesLogged = new Map<string, number>();
      for (const [user, perDay] of minutesByUserDay) {
        for (const [d, minutes] of perDay) {
          const dept = deptOnDay(user, d);
          if (!dept) continue;
          if (minutes > 0) deptDaysLogged.set(dept, (deptDaysLogged.get(dept) ?? 0) + 1);
          deptMinutesLogged.set(dept, (deptMinutesLogged.get(dept) ?? 0) + minutes);
        }
      }

      const rows: RollupRow[] = [];
      let companyExpected = 0;
      let companySubmitted = 0;
      let companyDaysLogged = 0;
      let companyMinutesLogged = 0;

      for (const [user, expectedDays] of expectedDaysByUser) {
        const sub = submittedByUser.get(user) ?? 0;
        const logged = daysLoggedByUser.get(user) ?? 0;
        const minutes = minutesLoggedByUser.get(user) ?? 0;
        const expectedMinutes = expectedDays * calendar.workdayMinutes;

        rows.push({ metricKey: "discipline.checkin_compliance", numerator: sub, denominator: expectedDays, dimensions: { userId: user } });
        rows.push({ metricKey: "discipline.time_logging_coverage", numerator: logged, denominator: expectedDays, dimensions: { userId: user } });
        if (expectedMinutes > 0) {
          rows.push({ metricKey: "effort.capacity_utilization", numerator: minutes, denominator: expectedMinutes, dimensions: { userId: user } });
        }

        companyExpected += expectedDays;
        companySubmitted += sub;
        companyDaysLogged += logged;
        companyMinutesLogged += minutes;
      }

      for (const [dept, expectedDays] of deptExpected) {
        rows.push({ metricKey: "discipline.checkin_compliance", numerator: deptSubmitted.get(dept) ?? 0, denominator: expectedDays, dimensions: { unit: dept } });
        rows.push({ metricKey: "discipline.time_logging_coverage", numerator: deptDaysLogged.get(dept) ?? 0, denominator: expectedDays, dimensions: { unit: dept } });
        const expectedMinutes = expectedDays * calendar.workdayMinutes;
        if (expectedMinutes > 0) {
          rows.push({ metricKey: "effort.capacity_utilization", numerator: deptMinutesLogged.get(dept) ?? 0, denominator: expectedMinutes, dimensions: { unit: dept } });
        }
      }

      if (companyExpected > 0) {
        rows.push({ metricKey: "discipline.checkin_compliance", numerator: companySubmitted, denominator: companyExpected, dimensions: {} });
        rows.push({ metricKey: "discipline.time_logging_coverage", numerator: companyDaysLogged, denominator: companyExpected, dimensions: {} });
        const companyExpectedMinutes = companyExpected * calendar.workdayMinutes;
        if (companyExpectedMinutes > 0) {
          rows.push({ metricKey: "effort.capacity_utilization", numerator: companyMinutesLogged, denominator: companyExpectedMinutes, dimensions: {} });
        }
      }
      void days; // range length is not used directly here (expectedDaysByUser IS the real day count)
      return rows;
    },
    { modules: ["reports", "hr"] },
  );
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ═══════════════════════════════ #20 discipline.overdue_open ("last") ══════════════════════════════
//
// §5.4: point-in-time, evaluated AT THE RANGE END — never summed across days (that would multiply
// the same still-overdue task by the day count). KNOWN LIMITATION: `pm_tasks` is mutable current
// state (no history table), so "as of range end" is only exact when `end` is today; for a past
// range this reads today's overdue set, not a true historical snapshot — the same current-state
// tradeoff §15 already documents for task ownership. Acceptable for an explicitly ops-only,
// appraisal-unsafe, trend-line metric.
async function computeOverdueOpen(client: PoolClient, tenantId: string, end: string): Promise<RollupRow[]> {
  // Candidate set: every non-deleted task past due at `end`, regardless of status — done-ness is
  // filtered in JS below via `effectiveStatuses`'s is_done FLAG (never a literal status id, the
  // same discipline every other done-check in this codebase follows), not approximated in SQL.
  const rows = await client.query<{
    task_id: string;
    project_id: string;
    status: string;
    department_id: string | null;
    owner_kind: AssigneeKind | null;
    owner_user_id: string | null;
    responsible_user_id: string | null;
  }>(
    `SELECT t.id AS task_id, t.project_id, t.status, p.department_id,
            o.assignee_kind AS owner_kind, o.user_id AS owner_user_id, r.user_id AS responsible_user_id
       FROM pm_tasks t
       JOIN projects p ON p.id = t.project_id AND p.tenant_id = t.tenant_id
       -- TR-34/TR-36: owner+responsible are INTERVAL rows (migration 0063), so these joins MUST be
       -- as-of-dated or a reassigned task multiplies (one output row per historical owner x responsible
       -- pair, each counted again below -> silently inflated overdue counts). #20 is defined as
       -- "evaluated at range END", so as-of the end date is both the correct semantics and
       -- single-valued: pm_task_assignees_no_overlap (0063) forbids overlapping intervals per
       -- (task, role), so at most one row per role can match any given date.
       LEFT JOIN pm_task_assignees o ON o.tenant_id = t.tenant_id AND o.task_id = t.id AND o.role = 'owner'
            AND o.valid_from <= $2::date AND (o.valid_to IS NULL OR o.valid_to >= $2::date)
       LEFT JOIN pm_task_assignees r ON r.tenant_id = t.tenant_id AND r.task_id = t.id AND r.role = 'responsible'
            AND r.valid_from <= $2::date AND (r.valid_to IS NULL OR r.valid_to >= $2::date)
      WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND t.due_date IS NOT NULL AND t.due_date < $2::date`,
    [tenantId, end],
  );

  const byPerson = new Map<string, number>();
  const byProject = new Map<string, number>();
  const byDept = new Map<string, number>();
  const byClient = new Map<string, number>();
  const clientOf = await loadProjectClientMap(client, tenantId);
  let company = 0;

  const doneIdsByProject = new Map<string, Set<string>>();
  for (const r of rows.rows) {
    if (!doneIdsByProject.has(r.project_id)) {
      const statuses = await effectiveStatuses(client, r.project_id);
      doneIdsByProject.set(r.project_id, new Set(statuses.filter((s) => s.isDone).map((s) => s.id)));
    }
    if (doneIdsByProject.get(r.project_id)!.has(r.status)) continue; // done — not overdue-OPEN

    const person = attributePerson({ ownerKind: r.owner_kind, ownerUserId: r.owner_user_id, responsibleUserId: r.responsible_user_id });
    if (person) byPerson.set(person, (byPerson.get(person) ?? 0) + 1);
    byProject.set(r.project_id, (byProject.get(r.project_id) ?? 0) + 1);
    if (r.department_id) byDept.set(r.department_id, (byDept.get(r.department_id) ?? 0) + 1);
    const clientId = clientOf.get(r.project_id);
    if (clientId) byClient.set(clientId, (byClient.get(clientId) ?? 0) + 1);
    company += 1;
  }

  const out: RollupRow[] = [];
  for (const [userId, n] of byPerson) out.push({ metricKey: "discipline.overdue_open", numerator: n, dimensions: { userId } });
  for (const [projectId, n] of byProject) out.push({ metricKey: "discipline.overdue_open", numerator: n, dimensions: { projectId } });
  // Client grain (PV7-01): a point-in-time count at the range end, summed across the client's
  // projects (never across days).
  for (const [clientId, n] of byClient) out.push({ metricKey: "discipline.overdue_open", numerator: n, dimensions: { clientId } });
  for (const [unit, n] of byDept) out.push({ metricKey: "discipline.overdue_open", numerator: n, dimensions: { unit } });
  out.push({ metricKey: "discipline.overdue_open", numerator: company, dimensions: {} });
  return out;
}

// ═══════════════════════════════════ the RollupProvider ═══════════════════════════════════════════

export const reportRollups: RollupProvider = {
  metrics: toMetricDefs(),
  compute: async (client, tenantId, period) => {
    const { start, end, days } = parsePeriodRange(period);
    // `computeOwnFactRollups`/`computeMilestoneHitRate`/`computeFlowMetrics`/`computeOverdueOpen`
    // all read through the ONE `client` the engine handed in (a single pooled connection/
    // transaction). A single pg connection cannot serve concurrent queries — firing them via
    // `Promise.all` is exactly the deprecated "calling client.query() while already executing a
    // query" pattern (pg warns today, removes it in pg@9) — so they run sequentially, awaited one
    // at a time. `computeProviderViewRollups`/`computeCalendarMetrics` each open their OWN
    // separate pooled connection (see their headers) and are genuinely independent, so those two
    // run in parallel alongside the sequential chain.
    const [providerView, calendar] = await Promise.all([
      computeProviderViewRollups(tenantId, start, end),
      computeCalendarMetrics(tenantId, start, end, days),
    ]);
    const own = await computeOwnFactRollups(client, tenantId, start, end);
    const milestones = await computeMilestoneHitRate(client, tenantId, start, end);
    const flow = await computeFlowMetrics(client, tenantId, start, end, days);
    const overdue = await computeOverdueOpen(client, tenantId, end);
    return [...own, ...providerView, ...milestones, ...flow, ...calendar, ...overdue];
  },
};
