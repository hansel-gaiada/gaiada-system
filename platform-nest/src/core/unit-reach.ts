// DW-10a (docs/FRONTEND-BFF-CONTRACT.md §57.2) — WHO REACHES A UNIT: the one narrowing predicate a department's own surfaces share.
//
// "Placed in U's subtree today, or leads U, or is company-wide." Cerbos cannot read a caller's PLACEMENT as of today, so a surface
// whose Cerbos `read` is tenant-wide (`dept_kpi_target · read`, `dept_notice · read`) applies this in the handler, AFTER the Cerbos
// check and BEFORE the existence check (403, then 404: a caller who may not read a unit learns nothing about whether it exists).
// Extracted from `authorizeUnitRead` (dept-kpis.controller.ts), which now calls `callerReachesUnit` with its behaviour UNCHANGED;
// the notice board uses the same predicate, and DW-10c will reuse it.
//
//   - company-wide: `personAxisTier` unrestricted or company_wide (platform_admin, company_admin, the HR tiers, the served reports
//     tiers), plus `owner` of this company (owner mirrors company_admin but is deliberately absent from personAxisTier, so it is
//     named here). Reaches every unit.
//   - placed:  the caller's primary unit TODAY is in the unit's subtree (`collectUnitSubtree`: a division's staff reach their
//     department, never the reverse). Today, not any requested range: the TR-25 rule.
//   - a head:  a caller in the `unit_scoped` person-axis tier (an org_unit_lead grant, or a lead's company-wide `manager`) whose
//     led scope (`loadLedUnitScope`, grant- and placement-derived subtrees) holds the unit.
//
// ⚠ CALLER CONTRACT: `c` must be inside `withTenants([tenantId], ...)`. The membership and org-tree tables are FORCE RLS; under an
// unset tenant GUC every read returns ZERO rows with no error, which here reads as "reaches nothing" (it fails closed, but it is a
// silent wrong answer, not a refusal).
import type { PoolClient } from "pg";
import type { Principal } from "../rbac/principal";
import {
  collectUnitSubtree,
  loadLedUnitScope,
  personAxisTier,
  requiresUnitNarrowing,
  resolveSubjectUnit,
} from "../modules/reports/person-scope";

/** The company-wide tiers of a department surface (see the header): personAxisTier's two top tiers, plus `owner` of this
 *  company. Reads only `principal.roles` (server-assembled at auth time), never request input. */
export function isCompanyWide(principal: Principal, tenantId: string): boolean {
  const tier = personAxisTier(principal, tenantId);
  if (tier === "unrestricted" || tier === "company_wide") return true;
  return principal.roles.some((g) => g.role === "owner" && g.scopeType === "company" && g.scopeId === tenantId);
}

/**
 * Does the caller reach `unitNodeId`: company-wide, or placed in its subtree today, or leading it? One unit, evaluated lazily
 * (the led scope is only loaded when the caller is not already placed). `structure` is the tenant's org tree
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
  return (
    requiresUnitNarrowing(principal, tenantId) &&
    (await loadLedUnitScope(c, tenantId, principal.userId, asOf, principal)).has(unitNodeId)
  );
}

/** What a caller reaches, loaded ONCE for a list that spans several units (a notice list holds the notices of a unit and of every
 *  unit above it). `reaches(x)` answers exactly what `callerReachesUnit` would for `x`, with no further query. */
export interface UnitReach {
  readonly companyWide: boolean;
  reaches(unitNodeId: string): boolean;
}

/**
 * DW-10e-6 (DW-D43, PERMISSION-CONTRACT §49) — the units a person HEADS in one company, read from that company's OWN lead seats:
 * every active `positions.is_lead` seat in `tenantId` held by `userId` through an assignment with no `valid_to`, each seat's unit
 * expanded by `collectUnitSubtree` over `structure` (that company's tree, `loadOrgStructure`), so a division head also covers the
 * units under it. An empty set means "heads nothing here".
 *
 * Company-anchored on purpose. It never reads an `org_unit_lead` grant: that grant carries no company (scopeType `org_unit`, the
 * scopeId a bare node id) and node ids repeat across companies (`d-webdev`, `d-hr`), so a grant-based answer would make the head of
 * another company's same-id department a head here. Placement alone is not a seat either. A retired position (`status` other than
 * `active`) or an ended assignment (`valid_to` set) does not count.
 *
 * ⚠ CALLER CONTRACT: `c` must be inside `withTenants([tenantId], ...)` (positions and position_assignments are FORCE RLS: an unset
 * tenant GUC reads ZERO seats, which here is a silent "heads nothing").
 */
export async function loadLeadSeatUnits(
  c: PoolClient,
  tenantId: string,
  userId: string | null,
  structure: unknown,
): Promise<Set<string>> {
  const led = new Set<string>();
  if (!userId) return led;
  const { rows } = await c.query<{ unit_node_id: string }>(
    `SELECT DISTINCT p.unit_node_id
       FROM positions p
       JOIN position_assignments pa ON pa.position_id = p.id AND pa.tenant_id = p.tenant_id
      WHERE p.tenant_id = $1 AND p.is_lead AND p.status = 'active' AND pa.valid_to IS NULL AND pa.user_id = $2
      ORDER BY p.unit_node_id`,
    [tenantId, userId],
  );
  for (const r of rows) for (const id of collectUnitSubtree(structure, r.unit_node_id)) led.add(id);
  return led;
}

/** The batch form of `callerReachesUnit`: the caller's primary unit and led scope are read once (eagerly), then each unit is a
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
  const led = requiresUnitNarrowing(principal, tenantId)
    ? await loadLedUnitScope(c, tenantId, principal.userId, asOf, principal)
    : new Set<string>();
  return {
    companyWide: false,
    reaches: (unitNodeId: string) => (!!own && collectUnitSubtree(structure, unitNodeId).includes(own)) || led.has(unitNodeId),
  };
}
