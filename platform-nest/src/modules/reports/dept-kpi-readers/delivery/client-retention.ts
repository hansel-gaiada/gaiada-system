// DW-6n6 (docs/FRONTEND-BFF-CONTRACT.md §40.5.3 row n6, §40.5.4): seo `client-retention`, reader id `clients.retention`.
//
//   * The cohort: the clients in C(u) that were ACTIVE on the window's first day (`start`).
//   * Retained: the same clients, still ACTIVE on `asOf` (the earlier of the window's end and today, so a running month is
//     judged as of today and a past one as of its last day).
//   * Value = retained / cohort, with numerator and denominator. An empty cohort is `null` (no data), never a 100%.
//
// "Active on day D" (a date) is EITHER
//   - a `signed` contract of the client, not deleted, with `starts_on <= D` and `ends_on` null or `>= D`. A superseding
//     version is its own signed row, so v1 followed by v2 is continuous; `draft`, `sent`, `declined`, `expired` and `void`
//     never count; OR
//   - a project of the client, not deleted, in S(u), with `start_date <= D` and status planned, active or on_hold.
// A project's start is `start_date`, else the date it was created in REPORTS_TZ (the common creation paths never set
// `start_date`); a contract's start is `starts_on`, else the date it was signed. A signed contract with neither never counts.
//
// The numbers infer churn from contracts and projects: `clients.status` keeps no history (§40.5.4). A window that has not
// begun as of `asOf` (asOf before start) has no cohort that can be judged, so it reads `null`.
//
// Core tables only (clients, contracts, projects): no module wall, so `withTenants([tenantId], fn)` with no `modules`.
import { config } from "../../../../config";
import { withTenants } from "../../../../db";
import type { ModuleKpiReader } from "../types";
import { deptClientIdsSql, unitSubtreeSql } from "../scope";

/** Placeholders: $1 tenant, $2 unit node id, $3 start, $4 asOf, $5 REPORTS_TZ. */
function activeOn(clientCol: string, dateParam: number): string {
  return (
    `(EXISTS (SELECT 1 FROM contracts k WHERE k.tenant_id = $1::uuid AND k.client_id = ${clientCol} AND k.status = 'signed' ` +
    `AND k.deleted_at IS NULL AND COALESCE(k.starts_on, (k.signed_at AT TIME ZONE $5::text)::date) <= $${dateParam}::date AND (k.ends_on IS NULL OR k.ends_on >= $${dateParam}::date)) ` +
    `OR EXISTS (SELECT 1 FROM projects p WHERE p.tenant_id = $1::uuid AND p.client_id = ${clientCol} AND p.deleted_at IS NULL ` +
    `AND COALESCE(p.start_date, (p.created_at AT TIME ZONE $5::text)::date) <= $${dateParam}::date AND p.status IN ('planned', 'active', 'on_hold') ` +
    `AND ${unitSubtreeSql("p.department_id", 1, 2)}))`
  );
}

export const clientRetention: ModuleKpiReader = async (ctx) => {
  if (ctx.asOf < ctx.start) return null;
  const { rows } = await withTenants([ctx.tenantId], (c) =>
    c.query<{ cohort: string; retained: string }>(
      `SELECT count(*) FILTER (WHERE a0) AS cohort, count(*) FILTER (WHERE a0 AND a1) AS retained
         FROM (SELECT ${activeOn("c.id", 3)} AS a0, ${activeOn("c.id", 4)} AS a1
                 FROM clients c
                WHERE c.tenant_id = $1::uuid AND c.id IN ${deptClientIdsSql(1, 2)}) x`,
      [ctx.tenantId, ctx.unitId, ctx.start, ctx.asOf, config.reportsTz],
    ),
  );
  const cohort = Number(rows[0]?.cohort ?? 0);
  if (cohort === 0) return null;
  const retained = Number(rows[0].retained);
  return { value: retained / cohort, numerator: retained, denominator: cohort };
};
