// DW-6n / DW-7 (docs/FRONTEND-BFF-CONTRACT.md §40.5.1 and §40.5.2): the SQL every department KPI reader shares, so the
// department's scope and the window mean the same thing in every reader.
//
//   * S(u): the unit and every org_unit_closure descendant of it. This IS §33's rule (`departmentFilterSql`), so the
//     Clients and Deliverables pages and these KPIs never disagree about which rows are the department's.
//   * C(u): the department's clients: a client with at least one not-deleted project whose department is in S(u),
//     the client itself not deleted and not internal (`clients.is_internal`).
//   * The window: the inclusive dates [start, end] in REPORTS_TZ become the half-open instants
//     [start 00:00, end + 1 day 00:00) in that zone.
//
// Every helper returns a fragment that uses the CALLER's placeholders: the caller binds the tenant, the unit, the dates
// and the zone, and passes their 1-based numbers in. Nothing here binds a value, so a reader's parameter list stays its own.
import { departmentFilterSql } from "../../../core/department-filter";

/** `column` (a text org-node id) is the unit or one of its descendants: S(u). */
export function unitSubtreeSql(column: string, tenantParam: number, unitParam: number): string {
  // departmentFilterSql binds the node id at `nextParam`; passing the caller's unit placeholder reuses that binding.
  return departmentFilterSql({ kind: "unit", nodeId: "" }, column, tenantParam, unitParam).sql;
}

/** A subquery of the department's client ids: C(u). Use it as `x.client_id IN ${deptClientIdsSql(...)}`. */
export function deptClientIdsSql(tenantParam: number, unitParam: number): string {
  return (
    `(SELECT DISTINCT dp.client_id FROM projects dp ` +
    `JOIN clients dc ON dc.id = dp.client_id AND dc.tenant_id = dp.tenant_id ` +
    `WHERE dp.tenant_id = $${tenantParam}::uuid AND dp.deleted_at IS NULL AND dp.client_id IS NOT NULL ` +
    `AND dc.deleted_at IS NULL AND NOT dc.is_internal ` +
    `AND ${unitSubtreeSql("dp.department_id", tenantParam, unitParam)})`
  );
}

/** The window's first instant: `start` 00:00 in the zone. */
export function windowStartSql(startParam: number, tzParam: number): string {
  return `(($${startParam}::date)::timestamp AT TIME ZONE $${tzParam}::text)`;
}

/** The instant just after the window: `end` + 1 day, 00:00 in the zone (exclusive). */
export function windowEndSql(endParam: number, tzParam: number): string {
  return `((($${endParam}::date) + 1)::timestamp AT TIME ZONE $${tzParam}::text)`;
}

/** A timestamptz column's date in the zone, for comparing with a due date. */
export function localDateSql(column: string, tzParam: number): string {
  return `((${column}) AT TIME ZONE $${tzParam}::text)::date`;
}
