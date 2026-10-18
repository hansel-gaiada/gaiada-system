// DW-10a (docs/FRONTEND-BFF-CONTRACT.md §57.2) — WHO REACHES A UNIT: the one narrowing predicate a department's own surfaces share.
//
// "Placed in U's subtree today, or leads U, or is company-wide." Cerbos cannot read a caller's PLACEMENT as of today, so a surface
// whose Cerbos `read` is tenant-wide (`dept_kpi_target · read`, `dept_notice · read`) applies this in the handler, AFTER the Cerbos
// check and BEFORE the existence check (403, then 404: a caller who may not read a unit learns nothing about whether it exists).
// Extracted from `authorizeUnitRead` (dept-kpis.controller.ts), which now calls `callerReachesUnit` with its behaviour UNCHANGED;
// the notice board uses the same predicate, and DW-10c reuses it.
//
//   - company-wide: `personAxisTier` unrestricted or company_wide (platform_admin, company_admin, the HR tiers, the served reports
//     tiers), plus `owner` of this company (owner mirrors company_admin but is deliberately absent from personAxisTier, so it is
//     named here). Reaches every unit.
//   - placed:  the caller's primary unit TODAY is in the unit's subtree (`collectUnitSubtree`: a division's staff reach their
//     department, never the reverse). Today, not any requested range: the TR-25 rule.
//   - a head (DW-10g, company-anchored: `loadHeadUnits`): the units of THIS company the caller heads, which is
//       * the company's own lead seats (`loadLeadSeatUnits`), each with its subtree; plus
//       * the placement-derived lead path (the caller's own primary unit and its subtree) when the caller holds a `manager` or
//         `org_unit_lead` grant anchored on THIS company: a company or global grant (`grantCoversTenant`), or a project grant on
//         one of this company's projects.
//     Never an `org_unit` grant: an `org_unit_lead` grant carries no company (its scopeId is a bare node id) and node ids repeat
//     across companies (`d-webdev`, `d-hr`), so it would make the head of another company's same-id department a head here. Before
//     DW-10g this path read `requiresUnitNarrowing` + `loadLedUnitScope(..., principal)`, which took that grant from any company.
//
// ⚠ CALLER CONTRACT: `c` must be inside `withTenants([tenantId], ...)`. The membership, org-tree and position tables are FORCE RLS;
// under an unset tenant GUC every read returns ZERO rows with no error, which here reads as "reaches nothing" (it fails closed, but
// it is a silent wrong answer, not a refusal).
import type { PoolClient } from "pg";
import type { Principal } from "../rbac/principal";
import {
  collectUnitSubtree,
  loadHeadUnits,
  personAxisTier,
  resolveSubjectUnit,
} from "../modules/reports/person-scope";

// DW-10g-2: the seat helpers live in person-scope.ts now (its company-anchored `loadLedUnitScope` needs them, and person-scope
// cannot import this file without a cycle). Re-exported so every existing import keeps working.
export { loadHeadUnits, loadLeadSeatUnits, placementLeadApplies } from "../modules/reports/person-scope";

/** The company-wide tiers of a department surface (see the header): personAxisTier's two top tiers, plus `owner` of this
 *  company. Reads only `principal.roles` (server-assembled at auth time), never request input. */
export function isCompanyWide(principal: Principal, tenantId: string): boolean {
  const tier = personAxisTier(principal, tenantId);
  if (tier === "unrestricted" || tier === "company_wide") return true;
  return principal.roles.some((g) => g.role === "owner" && g.scopeType === "company" && g.scopeId === tenantId);
}

/**
 * Does the caller reach `unitNodeId`: company-wide, or placed in its subtree today, or heading it? One unit, evaluated lazily
 * (the head set is only loaded when the caller is not already placed). `structure` is the tenant's org tree
 * (`loadOrgStructure`), read once by the caller for this check and for the existence check that follows it.
 */
export async function callerReachesUnit(
  c: PoolClient,
  principal: Principal,
  tenantId: string,
  structure: unknown,
  unitNodeId: string,
  asOf: string,
): Promise<boolean> {
  if (isCompanyWide(principal, tenantId)) return true;
  const own = principal.userId ? await resolveSubjectUnit(c, tenantId, principal.userId, asOf) : null;
  const placed = !!own && collectUnitSubtree(structure, unitNodeId).includes(own);
  if (placed) return true;
  return (await loadHeadUnits(c, principal, tenantId, structure, asOf)).has(unitNodeId);
}

/** What a caller reaches, loaded ONCE for a list that spans several units (a notice list holds the notices of a unit and of every
 *  unit above it). `reaches(x)` answers exactly what `callerReachesUnit` would for `x`, with no further query. */
export interface UnitReach {
  readonly companyWide: boolean;
  reaches(unitNodeId: string): boolean;
}

/** The batch form of `callerReachesUnit`: the caller's primary unit and head set are read once (eagerly), then each unit is a
 *  pure in-memory test. Same predicate, same answer per unit. */
export async function loadUnitReach(
  c: PoolClient,
  principal: Principal,
  tenantId: string,
  structure: unknown,
  asOf: string,
): Promise<UnitReach> {
  if (isCompanyWide(principal, tenantId)) return { companyWide: true, reaches: () => true };
  const own = principal.userId ? await resolveSubjectUnit(c, tenantId, principal.userId, asOf) : null;
  const led = await loadHeadUnits(c, principal, tenantId, structure, asOf);
  return {
    companyWide: false,
    reaches: (unitNodeId: string) => (!!own && collectUnitSubtree(structure, unitNodeId).includes(own)) || led.has(unitNodeId),
  };
}
