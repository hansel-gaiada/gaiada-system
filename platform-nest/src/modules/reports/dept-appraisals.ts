// DW-4e-3 — the department appraisal per cycle (docs/FRONTEND-BFF-CONTRACT.md §41; plan
// docs/plans/2026-10-13-department-workspaces.md §5.3 and §5.5, owner ruling DW-Q4). The I/O half plus the pure helpers
// the tests pin: dept-appraisals.controller.ts authorizes, this file reads and writes. No authorization happens here:
// every caller has already passed Cerbos and the unit gate.
//
// ══════════════════════════ NO NEW NUMBERS ══════════════════════════
// The appraisal is the §40 engine (`evaluateUnits`, dept-kpi-targets.ts) pointed at the cycle, never a second copy of
// its condition logic:
//   - the KPIs over the cycle: one custom range [period_start, period_end] (the 400-day cap of every report range), judged
//     against the target in force for the cycle's LAST month (`targetsAsOf`);
//   - the condition history: the same engine for each calendar month the cycle touches, each judged against ITS OWN month's
//     in-force target, so a month agrees with `GET /dept-kpis` for that month. Computed on read, never snapshotted;
//   - the people: `report_appraisals` of the cycle whose subject's primary unit is in the department's subtree TODAY (the
//     §37 roster rule: `loadUnitRoster` over `collectUnitSubtree`), AGGREGATED ONLY. Counts by status, and the composite
//     distribution of submitted-or-later rows by rounded band, withheld below MIN_SCORED_FOR_DISTRIBUTION rows so no
//     individual's score can be read from it. No names, no individual scores, no commentary leave this file.
//
// ══════════════════════════ WHAT IS STORED ══════════════════════════
// `dept_appraisals` (202610150000): the head's commentary and the GM's assessment (+ the GM's judged condition) for one
// (cycle, unit), created on the FIRST write. Both writes end when the cycle is `closed` (409 `cycle_closed`): the check
// and the write share one transaction, with the cycle row locked FOR SHARE so a concurrent close (which updates the row)
// either lands first (the write is refused) or waits for the write to commit.
import type { PoolClient } from "pg";
import { newId, withGlobal, withTenants } from "../../db";
import { config } from "../../config";
import { isUuidShaped } from "../../core/dept-resolution";
import { getCycle } from "./appraisal-engine";
import type { AppraisalCycleRow } from "./appraisal-document";
import { enumerateCalendarStarts, resolveCalendarRange } from "./report-calendar";
import { collectUnitSubtree, loadUnitRoster, todayIsoInTz } from "./person-scope";
import { departmentUnits, type KpiCondition, type OrgUnitRef, type WorkspaceSlug } from "./dept-kpis";
import { DEPT_KPI_MODULES, evaluateUnits, type KpiRead, type PeriodRange } from "./dept-kpi-targets";

/** Fewer scored rows than this and the composite distribution is withheld (`reason: "too_few"`). */
export const MIN_SCORED_FOR_DISTRIBUTION = 3;
export const MAX_TEXT = 4000;
export const GM_CONDITIONS = ["on_track", "at_risk", "off_track"] as const;
export type GmCondition = (typeof GM_CONDITIONS)[number];
export const APPRAISAL_STATUSES = ["draft", "submitted", "acknowledged", "disputed", "finalized"] as const;
export type PeopleStatus = (typeof APPRAISAL_STATUSES)[number];

// ═══════════════════════════════ PURE ═══════════════════════════════

/** Every calendar month the cycle touches, as month starts (`YYYY-MM-01`), oldest first. A cycle that starts mid-month
 *  includes that month (the calendar month the KPI page shows for it). Bounded by the 400-day cap: at most 15. */
export function cycleMonthStarts(periodStart: string, periodEnd: string): string[] {
  return enumerateCalendarStarts("month", periodStart, periodEnd);
}

/** The start of the month that holds the cycle's last day: the date its in-force targets are looked up at. */
export function lastMonthStart(periodEnd: string): string {
  return resolveCalendarRange("month", periodEnd).start;
}

/** A composite score (1..5 scale; numeric(4,2) arrives as a string) to its band: rounded, clamped to 1..5. */
export function scoreBand(composite: number): number {
  return Math.min(5, Math.max(1, Math.round(composite)));
}

export interface PeopleRow {
  status: string;
  /** numeric(4,2) as the driver returns it (a string), a number, or null when never scored. */
  composite: string | number | null;
}

export interface PeopleAggregate {
  total: number;
  byStatus: Record<PeopleStatus, number>;
  /** Counts of submitted-or-later, scored rows by rounded band 1..5; `null` (with `reason`) when fewer than
   *  MIN_SCORED_FOR_DISTRIBUTION rows are scored. */
  distribution: Array<{ band: number; count: number }> | null;
  reason?: "too_few";
}

/** PURE. The people block: counts by status, and the distribution unless it would expose an individual. A draft row is
 *  never scored here (its composite is only computed at submit), a row with no composite is not counted as scored. */
export function aggregatePeople(rows: readonly PeopleRow[]): PeopleAggregate {
  const byStatus = Object.fromEntries(APPRAISAL_STATUSES.map((s) => [s, 0])) as Record<PeopleStatus, number>;
  const bands = [0, 0, 0, 0, 0];
  let scored = 0;
  for (const r of rows) {
    if ((APPRAISAL_STATUSES as readonly string[]).includes(r.status)) byStatus[r.status as PeopleStatus] += 1;
    if (r.status === "draft" || r.composite === null || r.composite === undefined) continue;
    const c = Number(r.composite);
    if (!Number.isFinite(c)) continue;
    bands[scoreBand(c) - 1] += 1;
    scored += 1;
  }
  if (scored < MIN_SCORED_FOR_DISTRIBUTION) return { total: rows.length, byStatus, distribution: null, reason: "too_few" };
  return { total: rows.length, byStatus, distribution: bands.map((count, i) => ({ band: i + 1, count })) };
}

// ═══════════════════════════════ reads ═══════════════════════════════

/** The cycle, or null for an id that is not a uuid or not this company's. */
export async function fetchCycle(tenantId: string, cycleId: string): Promise<AppraisalCycleRow | null> {
  if (!isUuidShaped(cycleId)) return null;
  return getCycle(tenantId, cycleId);
}

interface DbAppraisalRow {
  id: string;
  hod_commentary: string | null;
  hod_by: string | null;
  hod_at: Date | null;
  gm_assessment: string | null;
  gm_condition: GmCondition | null;
  gm_by: string | null;
  gm_at: Date | null;
}

const APPRAISAL_COLUMNS = `id, hod_commentary, hod_by, hod_at, gm_assessment, gm_condition, gm_by, gm_at`;

export interface HodCommentary {
  text: string;
  by: string;
  byName: string | null;
  at: string;
}
export interface GmAssessment {
  text: string;
  condition: GmCondition;
  by: string;
  byName: string | null;
  at: string;
}

async function userNames(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { rows } = await withGlobal((c) => c.query<{ id: string; name: string | null }>(`SELECT id, name FROM users WHERE id = ANY($1::uuid[])`, [unique]));
  return new Map(rows.filter((r) => r.name).map((r) => [r.id, r.name as string]));
}

async function toViews(row: DbAppraisalRow | undefined): Promise<{ hodCommentary: HodCommentary | null; gmAssessment: GmAssessment | null }> {
  if (!row) return { hodCommentary: null, gmAssessment: null };
  const names = await userNames([row.hod_by, row.gm_by].filter((x): x is string => !!x));
  return {
    hodCommentary:
      row.hod_commentary !== null && row.hod_by && row.hod_at
        ? { text: row.hod_commentary, by: row.hod_by, byName: names.get(row.hod_by) ?? null, at: new Date(row.hod_at).toISOString() }
        : null,
    gmAssessment:
      row.gm_assessment !== null && row.gm_condition && row.gm_by && row.gm_at
        ? { text: row.gm_assessment, condition: row.gm_condition, by: row.gm_by, byName: names.get(row.gm_by) ?? null, at: new Date(row.gm_at).toISOString() }
        : null,
  };
}

async function loadStored(tenantId: string, cycleId: string, unitNodeId: string): Promise<DbAppraisalRow | undefined> {
  return withTenants(
    [tenantId],
    async (c) =>
      (
        await c.query<DbAppraisalRow>(
          `SELECT ${APPRAISAL_COLUMNS} FROM dept_appraisals WHERE tenant_id = $1 AND cycle_id = $2 AND unit_node_id = $3`,
          [tenantId, cycleId, unitNodeId],
        )
      ).rows[0],
    { modules: DEPT_KPI_MODULES },
  );
}

/** The people block for the unit: the cycle's appraisals whose subject is on the unit's roster TODAY (§37). */
export async function loadPeopleAggregate(tenantId: string, cycleId: string, structure: unknown, unitNodeId: string): Promise<PeopleAggregate> {
  const asOf = todayIsoInTz(config.reportsTz);
  return withTenants(
    [tenantId],
    async (c: PoolClient) => {
      const roster = await loadUnitRoster(c, tenantId, collectUnitSubtree(structure, unitNodeId), asOf);
      if (roster.length === 0) return aggregatePeople([]);
      const { rows } = await c.query<PeopleRow>(
        `SELECT status, composite FROM report_appraisals
          WHERE tenant_id = $1 AND cycle_id = $2 AND subject_user_id = ANY($3::uuid[])`,
        [tenantId, cycleId, roster],
      );
      return aggregatePeople(rows);
    },
    { modules: DEPT_KPI_MODULES },
  );
}

export interface DeptAppraisalView {
  cycle: { id: string; name: string; periodStart: string; periodEnd: string; status: string };
  unit: { id: string; name: string };
  workspace: WorkspaceSlug;
  kpis: KpiRead[];
  condition: KpiCondition;
  history: Array<{ month: string; condition: KpiCondition; kpis: Array<{ key: string; condition: KpiCondition }> }>;
  people: PeopleAggregate;
  hodCommentary: HodCommentary | null;
  gmAssessment: GmAssessment | null;
}

/**
 * The whole read: the §40 engine over the cycle (judged against the last month's target), the engine again per
 * calendar month for the history, the people aggregate, and the two stored halves. `range` is the cycle as a custom
 * range, already validated against the 400-day cap by the caller (`resolveRange("custom", …)`).
 */
export async function assembleDeptAppraisal(
  tenantId: string,
  vertical: string | null,
  cycle: AppraisalCycleRow,
  unit: OrgUnitRef,
  structure: unknown,
  range: PeriodRange,
): Promise<DeptAppraisalView> {
  const departments = departmentUnits(structure);
  const [overall] = await evaluateUnits(tenantId, vertical, [unit], departments, range, lastMonthStart(cycle.periodEnd));

  const history: DeptAppraisalView["history"] = [];
  for (const month of cycleMonthStarts(cycle.periodStart, cycle.periodEnd)) {
    const m = resolveCalendarRange("month", month);
    const [read] = await evaluateUnits(tenantId, vertical, [unit], departments, { periodKind: "month", start: m.start, end: m.end });
    history.push({ month: m.start, condition: read.condition, kpis: read.kpis.map((k) => ({ key: k.key, condition: k.condition })) });
  }

  const [people, stored] = await Promise.all([
    loadPeopleAggregate(tenantId, cycle.id, structure, unit.id),
    loadStored(tenantId, cycle.id, unit.id).then(toViews),
  ]);
  return {
    cycle: { id: cycle.id, name: cycle.name, periodStart: cycle.periodStart, periodEnd: cycle.periodEnd, status: cycle.status },
    unit: overall.unit,
    workspace: overall.workspace,
    kpis: overall.kpis,
    condition: overall.condition,
    history,
    people,
    hodCommentary: stored.hodCommentary,
    gmAssessment: stored.gmAssessment,
  };
}

// ═══════════════════════════════ writes ═══════════════════════════════

export type WriteOutcome<T> = { ok: true; id: string; value: T } | { ok: false; reason: "cycle_not_found" | "cycle_closed" };

/** Lock the cycle row FOR SHARE and refuse when it is missing or closed, inside the caller's transaction. */
async function lockOpenCycle(c: PoolClient, tenantId: string, cycleId: string): Promise<"ok" | "cycle_not_found" | "cycle_closed"> {
  const { rows } = await c.query<{ status: string }>(
    `SELECT status FROM report_appraisal_cycles WHERE tenant_id = $1 AND id = $2 FOR SHARE`,
    [tenantId, cycleId],
  );
  if (rows.length === 0) return "cycle_not_found";
  return rows[0].status === "closed" ? "cycle_closed" : "ok";
}

/** The head's commentary: create the (cycle, unit) row on the first write, replace the head's half after that. */
export async function writeCommentary(
  tenantId: string,
  cycleId: string,
  unitNodeId: string,
  text: string,
  userId: string,
): Promise<WriteOutcome<HodCommentary>> {
  const out = await withTenants(
    [tenantId],
    async (c): Promise<WriteOutcome<DbAppraisalRow>> => {
      const gate = await lockOpenCycle(c, tenantId, cycleId);
      if (gate !== "ok") return { ok: false, reason: gate };
      const { rows } = await c.query<DbAppraisalRow>(
        `INSERT INTO dept_appraisals (id, tenant_id, cycle_id, unit_node_id, hod_commentary, hod_by, hod_at, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
         ON CONFLICT (tenant_id, cycle_id, unit_node_id)
         DO UPDATE SET hod_commentary = EXCLUDED.hod_commentary, hod_by = EXCLUDED.hod_by, hod_at = EXCLUDED.hod_at, updated_at = now()
         RETURNING ${APPRAISAL_COLUMNS}`,
        [newId(), tenantId, cycleId, unitNodeId, text, userId, config.originSite],
      );
      return { ok: true, id: rows[0].id, value: rows[0] };
    },
    { modules: DEPT_KPI_MODULES },
  );
  if (!out.ok) return out;
  const view = (await toViews(out.value)).hodCommentary;
  return { ok: true, id: out.id, value: view as HodCommentary };
}

/** The GM's assessment and judged condition: the same create-or-replace for the GM's half. */
export async function writeAssessment(
  tenantId: string,
  cycleId: string,
  unitNodeId: string,
  text: string,
  condition: GmCondition,
  userId: string,
): Promise<WriteOutcome<GmAssessment>> {
  const out = await withTenants(
    [tenantId],
    async (c): Promise<WriteOutcome<DbAppraisalRow>> => {
      const gate = await lockOpenCycle(c, tenantId, cycleId);
      if (gate !== "ok") return { ok: false, reason: gate };
      const { rows } = await c.query<DbAppraisalRow>(
        `INSERT INTO dept_appraisals (id, tenant_id, cycle_id, unit_node_id, gm_assessment, gm_condition, gm_by, gm_at, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)
         ON CONFLICT (tenant_id, cycle_id, unit_node_id)
         DO UPDATE SET gm_assessment = EXCLUDED.gm_assessment, gm_condition = EXCLUDED.gm_condition, gm_by = EXCLUDED.gm_by,
                       gm_at = EXCLUDED.gm_at, updated_at = now()
         RETURNING ${APPRAISAL_COLUMNS}`,
        [newId(), tenantId, cycleId, unitNodeId, text, condition, userId, config.originSite],
      );
      return { ok: true, id: rows[0].id, value: rows[0] };
    },
    { modules: DEPT_KPI_MODULES },
  );
  if (!out.ok) return out;
  const view = (await toViews(out.value)).gmAssessment;
  return { ok: true, id: out.id, value: view as GmAssessment };
}
