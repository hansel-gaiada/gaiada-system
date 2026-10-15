// DW-7i-1 / DW-D37 (BFF §52.12, PERMISSION §42a) — who may see the failing workflows of the shared n8n.
//
// One n8n serves the whole group and its workflows carry no company, so this is NOT a Cerbos kind: the rule is in code,
// the same way the automation console keeps its own in-code check (modules/automation-console/index.ts explains why).
//
//   a platform operator ............. always (platform_admin, or the owner of the operator root: `isPlatformOperator`)
//   in a company with `automation-console` ENABLED, any one of:
//     the `owner` of this company ... a company-scope `owner` grant on it (principal.roles, server-assembled)
//     the GM ........................ holds a seat, as of today, that is the LEAD seat of this company's GM unit
//     the PM ........................ holds a seat titled "Project Manager" in this company
//
// IT staff, `company_admin` and `manager` do NOT pass on that alone: the owner's list (DW-D37) has four names in it.
//
// Seats are read from the positions machinery (migration 0109: `positions` + `position_assignments`), NEVER from a title
// typed on a user. The GM unit is found the way every other GM surface finds it: the company's org tree, the department
// node whose name resolves to the `gm` workspace for the company's vertical (`workspaceSlugFor`, so "GM" in an agency).
// Its node id is `d-gm` in the seeded agency and is not assumed here.
//
// ⚠ `isModuleEnabled`, not `app_module_allowed`: the DB function checks DECLARED scopes only, never `enabled_modules`.
import type { FastifyRequest } from "fastify";
import { withTenants } from "../db";
import { isPlatformOperator } from "../admin/elevated";
import { isModuleEnabled } from "../modules/registry";
import { departmentUnits, workspaceSlugFor } from "../modules/reports/dept-kpis";
import { companyVertical } from "../modules/reports/dept-kpi-targets";
import { loadOrgStructure } from "../modules/reports/person-scope";
import type { Principal } from "../rbac/principal";

export const AUTOMATION_MODULE = "automation-console";

/** What the route does with a caller: let them in, 404 (module off), or 403. */
export type AutomationFailuresAccess = "allowed" | "module_off" | "not_in_audience";

/** A seat the person holds today (the columns of `positions` this rule reads). */
export interface HeldSeat {
  unitNodeId: string;
  title: string;
  isLead: boolean;
}

/** PURE. "  project   MANAGER " is the Project Manager seat; "Assistant Project Manager" is not. */
export function isProjectManagerTitle(title: string): boolean {
  return title.trim().replace(/\s+/g, " ").toLowerCase() === "project manager";
}

/** PURE. The node ids of this company's GM unit (normally one): every department of the tree that is the GM workspace. */
export function gmUnitIds(structure: unknown, vertical: string | null): Set<string> {
  return new Set(departmentUnits(structure).filter((u) => workspaceSlugFor(vertical, u.name) === "gm").map((u) => u.id));
}

/** PURE. Which seat-based kinds these seats make the person. */
export function seatKinds(seats: readonly HeldSeat[], gmUnits: ReadonlySet<string>): { gm: boolean; pm: boolean } {
  return {
    gm: seats.some((s) => s.isLead && gmUnits.has(s.unitNodeId)),
    pm: seats.some((s) => isProjectManagerTitle(s.title)),
  };
}

/** PURE. A company-scope `owner` grant on exactly this company. */
export function isOwnerOf(principal: Principal, tenantId: string): boolean {
  return principal.roles.some((g) => g.role === "owner" && g.scopeType === "company" && g.scopeId === tenantId);
}

/** I/O. The person's seats as of today (an active seat; an assignment that has started and not ended), plus the GM unit's ids. */
async function loadSeatKinds(userId: string, tenantId: string): Promise<{ gm: boolean; pm: boolean }> {
  const [vertical, held] = await Promise.all([
    companyVertical(tenantId),
    withTenants([tenantId], async (c) => {
      const seats = await c.query<{ unit_node_id: string; title: string; is_lead: boolean }>(
        `SELECT p.unit_node_id, p.title, p.is_lead
           FROM position_assignments pa
           JOIN positions p ON p.id = pa.position_id AND p.tenant_id = pa.tenant_id
          WHERE pa.tenant_id = $1 AND pa.user_id = $2
            AND pa.valid_from <= current_date AND (pa.valid_to IS NULL OR pa.valid_to >= current_date)
            AND p.status = 'active'`,
        [tenantId, userId],
      );
      if (seats.rows.length === 0) return { seats: [] as HeldSeat[], structure: null };
      return {
        seats: seats.rows.map((r) => ({ unitNodeId: r.unit_node_id, title: r.title, isLead: r.is_lead })),
        structure: await loadOrgStructure(c, tenantId),
      };
    }),
  ]);
  return seatKinds(held.seats, gmUnitIds(held.structure, vertical));
}

export async function automationFailuresAccess(principal: Principal, tenantId: string): Promise<AutomationFailuresAccess> {
  // `isPlatformOperator` takes the request only to read `principal` off it.
  if (await isPlatformOperator({ principal } as unknown as FastifyRequest)) return "allowed";
  if (!(await isModuleEnabled(tenantId, AUTOMATION_MODULE))) return "module_off";
  if (principal.kind === "client" || !principal.userId) return "not_in_audience";
  if (isOwnerOf(principal, tenantId)) return "allowed";
  const seat = await loadSeatKinds(principal.userId, tenantId);
  return seat.gm || seat.pm ? "allowed" : "not_in_audience";
}

export async function canSeeAutomationFailures(principal: Principal, tenantId: string): Promise<boolean> {
  return (await automationFailuresAccess(principal, tenantId)) === "allowed";
}
