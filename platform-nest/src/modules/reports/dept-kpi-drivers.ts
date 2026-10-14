// DW-4j-3 — "behind the miss": the drivers of a department KPI (docs/FRONTEND-BFF-CONTRACT.md §43.8; PERMISSION-CONTRACT §38b).
// The I/O half and the pure ordering. The route is dept-kpi-watch.controller.ts (`GET /dept-kpis/drivers`); the gate is
// `authorizeUnitHeadRead` (dept-kpis.controller.ts, shared with the department appraisal); the engine is untouched, so a
// KPI's value stays the department's value whatever this read says.
//
// ══════════════════════════ WHICH KPIs HAVE DRIVERS ══════════════════════════
// Only a `report_fact` KPI of the DEPARTMENT grain has drivers; the rows come from the SAME rollup rows the Reports page and the
// Team report read (`computeReportRangeRows`, live: the rows `GET /reports/overview?grain=person&unit=` builds its `kpis`
// from), so a driver's numbers equal the Team report's for the same period.
//   - `delivery.milestone_hit_rate` (no person grain): the unit's PROJECTS, project-grain rows. A project is the one whose
//     `projects.department_id` is the unit (the join the department row itself is summed over, so the drivers add up to the
//     department's number), with at least one milestone due in the period and at least one missed.
//   - `flow.reopen_rate`, `discipline.overdue_open`, `discipline.checkin_compliance`: the PEOPLE of the unit's roster (the §37
//     rule: `loadUnitRoster` over the unit's subtree as of TODAY, narrowed for a unit-scoped caller exactly as the Team report
//     does), person-grain rows only. A person with no row, or no data (a ratio with a 0 denominator), is not listed, and neither
//     is a person with no miss (a reopen rate of 0, no overdue task, every expected check-in submitted).
//   - a `module` KPI has no reader, so no drivers: `drivers: null, reason: "no_reader"`.
//   - the company-grain KPI (utilization) and the derived one (departments in good condition) have none by construction:
//     `drivers: null, reason: "no_drivers"`.
// At most MAX_DRIVERS, worst first: the lowest value for an up-is-good KPI, the highest for a down-is-good one; ties by name,
// then id.
import { withTenants } from "../../db";
import { config } from "../../config";
import type { Principal } from "../../rbac/principal";
import { computeReportRangeRows, resolveScopeNamesBulk, type RollupRow } from "./document-builder";
import { collectUnitSubtree, loadLedUnitScope, loadOrgStructure, loadUnitByUser, loadUnitRoster, requiresUnitNarrowing, todayIsoInTz } from "./person-scope";
import type { DeptKpiDef, KpiDirection, KpiUnit } from "./dept-kpis";
import { DEPT_KPI_MODULES, type PeriodRange } from "./dept-kpi-targets";

export const MAX_DRIVERS = 5;

export type DriverKind = "project" | "person";

export interface DriverRow {
  kind: DriverKind;
  id: string;
  name: string;
  value: number;
  numerator?: number;
  denominator?: number;
}

export interface DriversView {
  kpi: { key: string; label: string; unit: KpiUnit; direction: KpiDirection };
  period: PeriodRange;
  drivers: DriverRow[] | null;
  reason?: "no_reader" | "no_drivers";
}

/** The metrics that have drivers, and the grain the drivers are read at. */
const DRIVER_METRICS: Readonly<Record<string, DriverKind>> = {
  "delivery.milestone_hit_rate": "project",
  "flow.reopen_rate": "person",
  "discipline.overdue_open": "person",
  "discipline.checkin_compliance": "person",
};

// ═══════════════════════════════ pure ═══════════════════════════════

/** PURE. Why a KPI has no drivers, or null when it has some to look for. */
export function noDriversReason(def: Pick<DeptKpiDef, "reader">): "no_reader" | "no_drivers" | null {
  // A module KPI with a reader of its own (a later catalogue gives the `module` arm an optional `readerId`) has a value but no
  // drivers; one without has no reader. Duck-typed so this file compiles before and after that field exists.
  if (def.reader.kind === "module") return (def.reader as { readerId?: string }).readerId ? "no_drivers" : "no_reader";
  if (def.reader.kind === "report_fact" && def.reader.grain === "department" && def.reader.metricKey in DRIVER_METRICS) return null;
  return "no_drivers";
}

/** PURE. Worst first, at most MAX_DRIVERS: ascending for an up-is-good KPI, descending for a down-is-good one, ties by name
 *  (locale order, as every list here) then by id. Never mutates its input. */
export function topDrivers(rows: readonly DriverRow[], direction: KpiDirection): DriverRow[] {
  const sign = direction === "up_good" ? 1 : -1;
  return [...rows]
    .sort((a, b) => sign * (a.value - b.value) || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_DRIVERS);
}

/** PURE. The drivers of one metric, as unordered rows with a name each, from the period's rollup rows. `allowed` is the set of
 *  project ids (project grain) or user ids (person grain) the unit owns; `names` resolves their display names (an unknown id
 *  reads as its id). Only a row with a real miss is kept (see this file's header). */
export function driverRows(metricKey: string, rows: readonly RollupRow[], allowed: ReadonlySet<string>, names: ReadonlyMap<string, string>): DriverRow[] {
  const kind = DRIVER_METRICS[metricKey];
  if (!kind) return [];
  const idKey = kind === "project" ? "projectId" : "userId";
  const out: DriverRow[] = [];
  for (const r of rows) {
    if (r.metricKey !== metricKey) continue;
    const id = (r.dimensions ?? {})[idKey];
    if (typeof id !== "string" || !allowed.has(id)) continue;
    const name = names.get(id) ?? id;
    if (metricKey === "discipline.overdue_open") {
      // A count, no denominator: a person with no overdue task has no row at all, but a 0 would not be a miss either.
      if (r.numerator > 0) out.push({ kind, id, name, value: r.numerator });
      continue;
    }
    const den = r.denominator ?? 0;
    if (den <= 0) continue; // nothing was measured: no data, not a zero
    const miss = metricKey === "flow.reopen_rate" ? r.numerator > 0 : r.numerator < den; // reopen: any reopen; hit rate and check-in: below 100%
    if (!miss) continue;
    out.push({ kind, id, name, value: r.numerator / den, numerator: r.numerator, denominator: den });
  }
  return out;
}

// ═══════════════════════════════ I/O ═══════════════════════════════

/** The ids of the projects of department `unitNodeId` (`projects.department_id`, the join the department's own milestone row is
 *  summed over) with their names. */
async function loadUnitProjects(tenantId: string, unitNodeId: string): Promise<Map<string, string>> {
  const rows = await withTenants(
    [tenantId],
    async (c) =>
      (await c.query<{ id: string; name: string }>(`SELECT id, name FROM projects WHERE tenant_id = $1 AND department_id = $2`, [tenantId, unitNodeId])).rows,
    { modules: DEPT_KPI_MODULES },
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** The unit's roster as of TODAY (REPORTS_TZ, never the range end: the TR-25 rule), narrowed for a unit-scoped caller to the
 *  people in their led scope, the same two steps `GET /reports/overview?grain=person&unit=` takes. */
async function loadRoster(tenantId: string, unitNodeId: string, principal: Principal): Promise<string[]> {
  const asOf = todayIsoInTz(config.reportsTz);
  return withTenants(
    [tenantId],
    async (c) => {
      const structure = await loadOrgStructure(c, tenantId);
      let ids = await loadUnitRoster(c, tenantId, collectUnitSubtree(structure, unitNodeId), asOf);
      if (requiresUnitNarrowing(principal, tenantId)) {
        const scope = await loadLedUnitScope(c, tenantId, principal.userId, asOf, principal);
        if (scope.size === 0) return [];
        const unitByUser = await loadUnitByUser(c, tenantId, ids, asOf);
        ids = ids.filter((id) => {
          const u = unitByUser.get(id);
          return !!u && scope.has(u);
        });
      }
      return ids;
    },
    { modules: DEPT_KPI_MODULES },
  );
}

/** The drivers read (§43.8). The caller has already passed the head-only gate and the KPI is one of the unit's workspace set. */
export async function readDrivers(
  tenantId: string,
  principal: Principal,
  unitNodeId: string,
  def: DeptKpiDef,
  range: PeriodRange,
): Promise<DriversView> {
  const kpi = { key: def.key, label: def.label, unit: def.unit, direction: def.direction };
  const reason = noDriversReason(def);
  if (reason) return { kpi, period: range, drivers: null, reason };
  if (def.reader.kind !== "report_fact") return { kpi, period: range, drivers: null, reason: "no_drivers" }; // unreachable: noDriversReason decided

  const metricKey = def.reader.metricKey;
  const kind = DRIVER_METRICS[metricKey];
  const owned = kind === "project" ? await loadUnitProjects(tenantId, unitNodeId) : null;
  const roster = kind === "person" ? await loadRoster(tenantId, unitNodeId, principal) : [];
  const allowed = new Set<string>(owned ? [...owned.keys()] : roster);
  if (allowed.size === 0) return { kpi, period: range, drivers: [] };

  const rows = await computeReportRangeRows(tenantId, range.start, range.end);
  const names = owned ?? (await resolveScopeNamesBulk(tenantId, "person", roster));
  return { kpi, period: range, drivers: topDrivers(driverRows(metricKey, rows, allowed, names), def.direction) };
}
