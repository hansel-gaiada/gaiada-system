// DW-4e-1 — department KPI targets and the KPI reads (docs/FRONTEND-BFF-CONTRACT.md §40.2 and §40.3). The I/O half:
// dept-kpis.ts decides (catalogue, condition rules), this file reads and writes, and dept-kpis.controller.ts
// authorizes. No authorization happens here: every caller has already passed Cerbos and the unit narrowing.
//
// THREE WALLS, as every reports surface: Cerbos (`dept_kpi_target`, in the controller); the tenant choke-point (every
// query below runs inside `withTenants([tenantId], …)`); and the `reports` third wall (`dept_kpi_targets` is behind
// `app_module_allowed('reports')`, so every call declares `{modules: [...]}` with `reports` in it).
//
// ══════════════════════════ TARGETS: ONLY AN APPROVED ROW IS IN FORCE ══════════════════════════
// In force for a period: the latest `approved` row for (unit, KPI) whose effective_from is on or before the period's
// start. A newer proposal changes nothing until it is approved ("last period's target stays in force"), and the
// catalogue's suggested target only pre-fills a proposal.
//
// Approving supersedes the approved rows of the same (unit, KPI) from the same effective_from ON: the new row governs
// from its month forward, while an older approved row (an earlier month) stays approved and keeps governing the
// periods before. So "an approved target is in force from its month, and the previous one before it" holds with no
// end-date column. The decision runs in ONE transaction that first locks every row of the (unit, KPI) family in id
// order (a deterministic order, so two approvals of one family serialise instead of deadlocking), then re-reads the
// row's status under that lock. The partial unique index `ux_dept_kpi_targets_approved` (one approved row per month)
// is the database's backstop if a future writer forgets the lock.
//
// ══════════════════════════ VALUES: THE NUMBERS OF THE REPORTS PAGE ══════════════════════════
// A report_fact KPI's value comes from the report document of its grain for the unit and period, fetched through the
// reports controller's own `fetchReportDocumentForRead` (sealed period -> stored document, else live), so a KPI tile
// and the Reports page can never disagree. One document per unit and one company document per read, memoised.
import type { PoolClient } from "pg";
import { newId, withGlobal, withTenants } from "../../db";
import { config } from "../../config";
import { fetchReportDocumentForRead } from "./reports.controller";
import { moduleKpiReaders } from "./dept-kpi-readers";
import { todayIsoInTz } from "./person-scope";
import type { ReportDocument, ReportPeriodKind } from "./report-document";
import {
  DEPT_KPI_SETS,
  departmentCondition,
  departmentsInGoodCondition,
  kpiCondition,
  reportFactValue,
  workspaceSlugFor,
  type DeptKpiDef,
  type KpiCondition,
  type KpiDirection,
  type KpiUnit,
  type KpiValue,
  type OrgUnitRef,
  type UnavailableReason,
  type WorkspaceSlug,
} from "./dept-kpis";

/** The module scopes every query here declares: `reports` for the third wall on dept_kpi_targets and report_*, plus
 *  the person-scope set's `pm`/`hr` (identical to PERSON_SCOPE_MODULES) so a shared transaction can also read the
 *  org tree, memberships and closure. */
export const DEPT_KPI_MODULES = ["reports", "pm", "hr"];

export type TargetStatus = "proposed" | "approved" | "rejected" | "superseded";

export interface TargetRow {
  id: string;
  unitNodeId: string;
  kpiKey: string;
  effectiveFrom: string;
  target: number;
  tolerance: number;
  status: TargetStatus;
  note: string | null;
  proposedBy: string;
  proposedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
}

interface DbTargetRow {
  id: string;
  unit_node_id: string;
  kpi_key: string;
  effective_from: string;
  target: string;
  tolerance: string;
  status: TargetStatus;
  note: string | null;
  proposed_by: string;
  proposed_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
}

// `date` is selected as text: this pool installs no type parser, so a bare `date` would arrive as a local-midnight
// Date and could shift a day across time zones.
const ROW_COLUMNS = `id, unit_node_id, kpi_key, effective_from::text AS effective_from, target::text AS target,
  tolerance::text AS tolerance, status, note, proposed_by, proposed_at, decided_by, decided_at`;

function toRow(r: DbTargetRow): TargetRow {
  return {
    id: r.id,
    unitNodeId: r.unit_node_id,
    kpiKey: r.kpi_key,
    effectiveFrom: r.effective_from,
    target: Number(r.target),
    tolerance: Number(r.tolerance),
    status: r.status,
    note: r.note,
    proposedBy: r.proposed_by,
    proposedAt: new Date(r.proposed_at).toISOString(),
    decidedBy: r.decided_by,
    decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
  };
}

// ═══════════════════════════════ targets: write ═══════════════════════════════

export interface ProposalInput {
  unitNodeId: string;
  kpiKey: string;
  effectiveFrom: string;
  target: number;
  tolerance: number;
  note: string | null;
}

export async function insertProposal(tenantId: string, input: ProposalInput, proposedBy: string): Promise<TargetRow> {
  return withTenants(
    [tenantId],
    async (c) => {
      const { rows } = await c.query<DbTargetRow>(
        `INSERT INTO dept_kpi_targets (id, tenant_id, unit_node_id, kpi_key, effective_from, target, tolerance, status, note,
                                       proposed_by, origin_site)
         VALUES ($1, $2, $3, $4, $5::date, $6, $7, 'proposed', $8, $9, $10)
         RETURNING ${ROW_COLUMNS}`,
        [newId(), tenantId, input.unitNodeId, input.kpiKey, input.effectiveFrom, input.target, input.tolerance, input.note,
          proposedBy, config.originSite],
      );
      return toRow(rows[0]);
    },
    { modules: DEPT_KPI_MODULES },
  );
}

export async function fetchTarget(tenantId: string, id: string): Promise<TargetRow | null> {
  return withTenants(
    [tenantId],
    async (c) => {
      const { rows } = await c.query<DbTargetRow>(`SELECT ${ROW_COLUMNS} FROM dept_kpi_targets WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      return rows[0] ? toRow(rows[0]) : null;
    },
    { modules: DEPT_KPI_MODULES },
  );
}

export type DecisionOutcome =
  | { ok: true; row: TargetRow; superseded: string[] }
  | { ok: false; reason: "not_found" | "not_proposed" };

/** Approve or reject a proposal, in one transaction under the (unit, KPI) family lock (see this file's header). */
export async function decideTarget(
  tenantId: string,
  id: string,
  decision: "approve" | "reject",
  decidedBy: string,
): Promise<DecisionOutcome> {
  return withTenants(
    [tenantId],
    async (c: PoolClient): Promise<DecisionOutcome> => {
      // Lock the whole (unit, KPI) family, in id order, before reading the row's status.
      const family = await c.query<{ id: string }>(
        `SELECT t.id FROM dept_kpi_targets t
          WHERE (t.tenant_id, t.unit_node_id, t.kpi_key) =
                (SELECT s.tenant_id, s.unit_node_id, s.kpi_key FROM dept_kpi_targets s WHERE s.tenant_id = $1 AND s.id = $2)
          ORDER BY t.id
          FOR UPDATE`,
        [tenantId, id],
      );
      if (family.rows.length === 0) return { ok: false, reason: "not_found" };
      const { rows } = await c.query<DbTargetRow>(`SELECT ${ROW_COLUMNS} FROM dept_kpi_targets WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      const current = rows[0];
      if (!current) return { ok: false, reason: "not_found" };
      if (current.status !== "proposed") return { ok: false, reason: "not_proposed" };

      let superseded: string[] = [];
      if (decision === "approve") {
        const s = await c.query<{ id: string }>(
          `UPDATE dept_kpi_targets SET status = 'superseded'
            WHERE tenant_id = $1 AND unit_node_id = $2 AND kpi_key = $3 AND status = 'approved'
              AND effective_from >= $4::date AND id <> $5
           RETURNING id`,
          [tenantId, current.unit_node_id, current.kpi_key, current.effective_from, id],
        );
        superseded = s.rows.map((r) => r.id).sort();
      }
      const updated = await c.query<DbTargetRow>(
        `UPDATE dept_kpi_targets SET status = $3, decided_by = $4, decided_at = now()
          WHERE tenant_id = $1 AND id = $2
         RETURNING ${ROW_COLUMNS}`,
        [tenantId, id, decision === "approve" ? "approved" : "rejected", decidedBy],
      );
      return { ok: true, row: toRow(updated.rows[0]), superseded };
    },
    { modules: DEPT_KPI_MODULES },
  );
}

// ═══════════════════════════════ targets: read ═══════════════════════════════

/** Every row of `unitNodeId`, newest month first, then newest proposal first. */
export async function listUnitTargets(tenantId: string, unitNodeId: string): Promise<TargetRow[]> {
  return withTenants(
    [tenantId],
    async (c) => {
      const { rows } = await c.query<DbTargetRow>(
        `SELECT ${ROW_COLUMNS} FROM dept_kpi_targets
          WHERE tenant_id = $1 AND unit_node_id = $2
          ORDER BY effective_from DESC, proposed_at DESC, id DESC`,
        [tenantId, unitNodeId],
      );
      return rows.map(toRow);
    },
    { modules: DEPT_KPI_MODULES },
  );
}

/** The target in force for each (unit, KPI) of `unitNodeIds` at `periodStart`: unit -> KPI -> row. */
export async function inForceTargets(tenantId: string, unitNodeIds: string[], periodStart: string): Promise<Map<string, Map<string, TargetRow>>> {
  const out = new Map<string, Map<string, TargetRow>>();
  if (unitNodeIds.length === 0) return out;
  const rows = await withTenants(
    [tenantId],
    async (c) =>
      (
        await c.query<DbTargetRow>(
          `SELECT DISTINCT ON (unit_node_id, kpi_key) ${ROW_COLUMNS} FROM dept_kpi_targets
            WHERE tenant_id = $1 AND unit_node_id = ANY($2::text[]) AND status = 'approved' AND effective_from <= $3::date
            ORDER BY unit_node_id, kpi_key, effective_from DESC`,
          [tenantId, unitNodeIds, periodStart],
        )
      ).rows,
    { modules: DEPT_KPI_MODULES },
  );
  for (const r of rows.map(toRow)) {
    if (!out.has(r.unitNodeId)) out.set(r.unitNodeId, new Map());
    out.get(r.unitNodeId)!.set(r.kpiKey, r);
  }
  return out;
}

export interface TargetsView {
  unit: { id: string; name: string };
  workspace: WorkspaceSlug;
  /** The month whose in-force row `inForce` shows: the current month in REPORTS_TZ. */
  asOf: string;
  kpis: Array<{
    key: string;
    label: string;
    unit: KpiUnit;
    direction: KpiDirection;
    suggestedTarget: number | null;
    suggestedTolerance: number | null;
    inForce: TargetRow | null;
    proposals: TargetRow[];
    history: TargetRow[];
  }>;
}

/** PURE. The targets screen's shape: for each KPI of the unit's set, its in-force row as of `asOf`, its open
 *  proposals, and every decided row (history), newest first. Rows of a KPI that is no longer in the unit's set (the
 *  unit was renamed into another workspace) are not listed. */
export function assembleTargetsView(unit: OrgUnitRef, workspace: WorkspaceSlug, asOf: string, rows: TargetRow[]): TargetsView {
  return {
    unit: { id: unit.id, name: unit.name },
    workspace,
    asOf,
    kpis: DEPT_KPI_SETS[workspace].map((def) => {
      const mine = rows.filter((r) => r.kpiKey === def.key);
      const inForce = mine.find((r) => r.status === "approved" && r.effectiveFrom <= asOf) ?? null;
      return {
        key: def.key,
        label: def.label,
        unit: def.unit,
        direction: def.direction,
        suggestedTarget: def.suggestedTarget,
        suggestedTolerance: def.suggestedTolerance,
        inForce,
        proposals: mine.filter((r) => r.status === "proposed"),
        history: mine.filter((r) => r.status !== "proposed"),
      };
    }),
  };
}

// ═══════════════════════════════ the company's vertical ═══════════════════════════════

/** `companies.vertical` (a global table: no RLS, hence withGlobal). `null` reads as the generic pack. */
export async function companyVertical(tenantId: string): Promise<string | null> {
  const { rows } = await withGlobal((c) => c.query<{ vertical: string | null }>(`SELECT vertical FROM companies WHERE id = $1`, [tenantId]));
  return rows[0]?.vertical ?? null;
}

// ═══════════════════════════════ KPI reads (§40.3) ═══════════════════════════════

export interface KpiRead {
  key: string;
  label: string;
  unit: KpiUnit;
  direction: KpiDirection;
  value: number | null;
  numerator?: number;
  denominator?: number;
  target: number | null;
  tolerance: number | null;
  targetSource: "approved" | "none";
  condition: KpiCondition;
  reason?: UnavailableReason;
}

export interface UnitKpis {
  unit: { id: string; name: string };
  workspace: WorkspaceSlug;
  condition: KpiCondition;
  kpis: KpiRead[];
}

export interface PeriodRange {
  periodKind: ReportPeriodKind;
  start: string;
  end: string;
}

/** A module KPI without a readerId has no read yet (`no_reader`) and never carries a value. With one, it is read exactly
 *  like a report_fact KPI (§40.5.1). */
const hasNoRead = (def: DeptKpiDef): boolean => def.reader.kind === "module" && def.reader.readerId === undefined;

/** `failed`: the KPI's module reader threw (§40.5.1). It reads unavailable with `read_failed`, whatever its target. */
function kpiRead(def: DeptKpiDef, v: KpiValue | null, t: TargetRow | undefined, failed = false): KpiRead {
  const level = t ? { target: t.target, tolerance: t.tolerance } : null;
  const { condition, reason }: { condition: KpiCondition; reason?: UnavailableReason } = failed
    ? { condition: "unavailable", reason: "read_failed" }
    : kpiCondition(def, hasNoRead(def) ? null : v ? v.value : null, level);
  const out: KpiRead = {
    key: def.key,
    label: def.label,
    unit: def.unit,
    direction: def.direction,
    value: hasNoRead(def) || !v ? null : v.value,
    target: level ? level.target : null,
    tolerance: level ? level.tolerance : null,
    targetSource: level ? "approved" : "none",
    condition,
  };
  if (v && !hasNoRead(def)) {
    if (v.numerator !== undefined) out.numerator = v.numerator;
    if (v.denominator !== undefined) out.denominator = v.denominator;
  }
  if (reason) out.reason = reason;
  return out;
}

/**
 * The KPIs and condition of each of `units` for one period. `departments` is every department of the company (the
 * population of departments-in-good-condition). How the derived KPI avoids a cycle: it reads the OTHER departments'
 * conditions computed WITHOUT any derived KPI (for every workspace but the GM's that is their full condition; for a
 * second GM-workspace department it is its condition from its own report and module KPIs). The unit being computed is
 * never counted in its own share.
 *
 * `targetsAsOf` (DW-4e-3, FRONTEND-BFF-CONTRACT §41.1) is the date the in-force target is looked up at; it defaults to the
 * range's start (§40.2: "on or before the period's start"). The department appraisal reads a whole cycle as one custom
 * range but judges it against the target in force for the cycle's LAST month, so it passes that month's start.
 */
export async function evaluateUnits(
  tenantId: string,
  vertical: string | null,
  units: OrgUnitRef[],
  departments: OrgUnitRef[],
  range: PeriodRange,
  targetsAsOf: string = range.start,
): Promise<UnitKpis[]> {
  // The earlier of the range's end and today in REPORTS_TZ, computed ONCE so every reader of this evaluation agrees on
  // what is "already due" (§40.5.1).
  const today = todayIsoInTz(config.reportsTz);
  const asOf = range.end < today ? range.end : today;
  const slugOf = (u: OrgUnitRef) => workspaceSlugFor(vertical, u.name);
  const needsDerived = units.some((u) => DEPT_KPI_SETS[slugOf(u)].some((d) => d.reader.kind === "derived"));
  const population = needsDerived ? uniqueUnits([...units, ...departments]) : units;
  const targets = await inForceTargets(tenantId, population.map((u) => u.id), targetsAsOf);

  const docs = new Map<string, ReportDocument>();
  const docFor = async (grain: "department" | "company", scopeRef: string): Promise<ReportDocument> => {
    const key = `${grain}:${scopeRef}`;
    let doc = docs.get(key);
    if (!doc) {
      doc = await fetchReportDocumentForRead(tenantId, grain, scopeRef, range.periodKind, range.start, range.end);
      docs.set(key, doc);
    }
    return doc;
  };

  // Pass 1: every non-derived KPI of the population (report_fact and module readers).
  const base = new Map<string, KpiRead[]>();
  for (const u of population) {
    const reads: KpiRead[] = [];
    for (const def of DEPT_KPI_SETS[slugOf(u)]) {
      if (def.reader.kind === "derived") continue;
      let v: KpiValue | null = null;
      let failed = false;
      if (def.reader.kind === "report_fact") {
        const doc = await docFor(def.reader.grain, def.reader.grain === "company" ? tenantId : u.id);
        v = reportFactValue(def.reader.metricKey, doc);
      } else if (def.reader.kind === "module" && def.reader.readerId !== undefined) {
        const readerId = def.reader.readerId;
        try {
          const reader = moduleKpiReaders()[readerId];
          if (!reader) throw new Error("no reader registered");
          v = await reader({ tenantId, unitId: u.id, periodKind: range.periodKind, start: range.start, end: range.end, asOf });
        } catch (err) {
          // One failing reader fails only its own KPI. Log the reader id and the message, never row data.
          console.error(`[DEPT-KPI] reader "${readerId}" failed:`, (err as Error).message);
          failed = true;
        }
      }
      reads.push(kpiRead(def, v, targets.get(u.id)?.get(def.key), failed));
    }
    base.set(u.id, reads);
  }
  const baseCondition = (unitId: string): KpiCondition => departmentCondition((base.get(unitId) ?? []).map((k) => k.condition));

  // Pass 2: the requested units in their set's order, the derived KPI filled from the other departments.
  return units.map((u) => {
    const slug = slugOf(u);
    const reads = DEPT_KPI_SETS[slug].map((def) => {
      if (def.reader.kind !== "derived") return base.get(u.id)!.find((k) => k.key === def.key)!;
      const others = departments.filter((d) => d.id !== u.id).map((d) => baseCondition(d.id));
      return kpiRead(def, departmentsInGoodCondition(others), targets.get(u.id)?.get(def.key));
    });
    return { unit: { id: u.id, name: u.name }, workspace: slug, condition: departmentCondition(reads.map((k) => k.condition)), kpis: reads };
  });
}

function uniqueUnits(list: OrgUnitRef[]): OrgUnitRef[] {
  const seen = new Set<string>();
  return list.filter((u) => (seen.has(u.id) ? false : (seen.add(u.id), true)));
}
