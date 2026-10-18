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
  UNIT_SCOPED_ROLES,
  collectUnitSubtree,
  grantCoversTenant,
  loadLedUnitScope,
  personAxisTier,
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

/**
 * DW-10e-6 (DW-D43, PERMISSION-CONTRACT §49) — the units a person HEADS in one company, read from that company's OWN lead seats:
 * every `positions` row of `tenantId` with `is_lead` and `status = 'active'` that ALSO carries a `position_roles` row for the
 * `org_unit_lead` role at `own_unit` (0109 design §2.2: "a position with is_lead=true and no org_unit_lead role row confers no lead
 * power"), held by `userId` through an assignment with no `valid_to`. Each seat's unit is expanded by `collectUnitSubtree` over
 * `structure` (that company's tree, `loadOrgStructure`), so a division head also covers the units under it. An empty set means
 * "heads nothing here". The role is matched by NAME, as Cerbos and `position_roles_guard()` do: the library role, or a role of this
 * company.
 *
 * Company-anchored on purpose. It never reads an `org_unit_lead` GRANT: that grant carries no company (scopeType `org_unit`, the
 * scopeId a bare node id) and node ids repeat across companies (`d-webdev`, `d-hr`), so a grant-based answer would make the head of
 * another company's same-id department a head here. Placement alone is not a seat either. A retired position (`status` other than
 * `active`), an ended assignment (`valid_to` set) or a lead position without the role row does not count.
 *
 * ⚠ CALLER CONTRACT: `c` must be inside `withTenants([tenantId], ...)` (positions, position_roles and position_assignments are FORCE
 * RLS: an unset tenant GUC reads ZERO seats, which here is a silent "heads nothing").
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
       JOIN position_roles pr ON pr.position_id = p.id AND pr.tenant_id = p.tenant_id AND pr.scope_kind = 'own_unit'
       JOIN roles r ON r.id = pr.role_id AND r.name = 'org_unit_lead' AND (r.company_id IS NULL OR r.company_id = p.tenant_id)
      WHERE p.tenant_id = $1 AND p.is_lead AND p.status = 'active' AND pa.valid_to IS NULL AND pa.user_id = $2
      ORDER BY p.unit_node_id`,
    [tenantId, userId],
  );
  for (const r of rows) for (const id of collectUnitSubtree(structure, r.unit_node_id)) led.add(id);
  return led;
}

/**
 * DW-10g — does the placement-derived lead path apply to this caller IN THIS COMPANY? The company-anchored half of the old
 * `requiresUnitNarrowing` gate: a `manager` or `org_unit_lead` grant (personAxisTier's unit-scoped roles) that is a company or
 * global grant covering `tenantId`, or a project grant on one of `tenantId`'s own projects (read in this company's scope, so a
 * project of another company never matches). The `org_unit` grant source is dropped: it carries no company.
 */
export async function placementLeadApplies(c: PoolClient, principal: Principal, tenantId: string): Promise<boolean> {
  const grants = principal.roles.filter((g) => UNIT_SCOPED_ROLES.has(g.role));
  if (grants.some((g) => grantCoversTenant(g, tenantId))) return true;
  const projectIds = grants.filter((g) => g.scopeType === "project" && !!g.scopeId).map((g) => g.scopeId as string);
  if (projectIds.length === 0) return false;
  const { rows } = await c.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM projects WHERE tenant_id = $1 AND id::text = ANY($2::text[])) AS ok`,
    [tenantId, projectIds],
  );
  return rows[0]?.ok === true;
}

/**
 * DW-10g — the units of `tenantId` the caller HEADS, company-anchored: the company's own lead seats (`loadLeadSeatUnits`), plus,
 * when `placementLeadApplies`, the caller's own primary unit(s) and their subtrees (`loadLedUnitScope` WITHOUT the principal, which
 * is exactly its placement-derived source). Never the tenantless `org_unit_lead` grant. Same caller contract as above.
 */
export async function loadHeadUnits(
  c: PoolClient,
  principal: Principal,
  tenantId: string,
  structure: unknown,
  asOf: string,
): Promise<Set<string>> {
  const led = await loadLeadSeatUnits(c, tenantId, principal.userId, structure);
  if (principal.userId && (await placementLeadApplies(c, principal, tenantId))) {
    for (const id of await loadLedUnitScope(c, tenantId, principal.userId, asOf)) led.add(id);
  }
  return led;
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
