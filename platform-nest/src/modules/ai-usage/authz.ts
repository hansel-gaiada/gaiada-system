// AIP-15 (docs/PERMISSION-CONTRACT.md §58, docs/FRONTEND-BFF-CONTRACT.md §66; plan docs/plans/2026-10-27-ai-plan.md §6.3 item 2) — the facts
// Cerbos sees for the core `ai_usage` kind (cerbos/policies/resource_ai_usage.yaml), read from the rows and never from a body, and the
// resource built from them.
//
// One resource is ONE company's usage record, narrowed to one org unit when the handler feeds `unitAncestors`:
//   tenantId       the route's company (validated by the router; RLS and `inTenant` do the rest).
//   unitAncestors  the unit and every ancestor of it, from the per-tenant closure (`loadUnitAncestors`, computed WITH the tenant: node ids
//                  repeat across companies). Fed only by the unit route; [] elsewhere, so no head's rule can match there.
//   gmIds          the live lead-seat holders of the company's GM unit(s): the `ai_usage_gm_seat` derived role, `read_company` only. Found
//                  BY NAME, the way every GM surface finds its unit (`gmUnitIds`: the departments of the company's own org tree whose
//                  workspace slug is `gm` for the company's vertical; never a hard-coded node id, PV-D13), and the seats are §50's
//                  (`loadSeatHoldersByNode`: an active position carrying its org_unit_lead role row at own_unit, held with no valid_to). The
//                  same computation as loadSocialApproverIds' GM half. A company with no GM unit, or no seat on it, answers [] (fail closed).
//
// Every function takes the caller's client: the caller owns the transaction and its tenant scope (`withTenants([tenantId])`; positions,
// position_roles, position_assignments, company_org_structure and org_unit_closure are FORCE RLS, so an unset GUC reads ZERO rows and every
// seat would silently vanish).
import type { PoolClient } from "pg";
import type { Resource } from "../../rbac/cerbos";
import { loadOrgStructure, loadSeatHoldersByNode } from "../reports/person-scope";
import { departmentUnits, workspaceSlugFor } from "../reports/dept-kpis";
import { gmUnitIds } from "../../core/automation-failures-audience";
import { loadUnitAncestors } from "../../core/org-unit-closure";

export const AI_USAGE_KIND = "ai_usage";

/** The six actions of the kind. `manage` has its routes with AIP-17b; `lift_stop` has none yet (AIP-18); the answers' `capabilities` report both. */
export const AI_USAGE_ACTIONS = ["read_own", "read_unit", "read_company", "read_people", "manage", "lift_stop"] as const;
export type AiUsageAction = (typeof AI_USAGE_ACTIONS)[number];

/** The `ai_usage` resource: the company, the unit's ancestry (or none), and the GM seat holders. Never a body. */
export function aiUsageResource(tenantId: string, facts: { unitAncestors?: string[]; gmIds?: string[] } = {}): Resource {
  return {
    kind: AI_USAGE_KIND,
    tenantId,
    unitAncestors: [...(facts.unitAncestors ?? [])],
    gmIds: [...(facts.gmIds ?? [])],
  };
}

/** The company's vertical (companies is global reference data, no RLS). */
async function companyVertical(c: PoolClient, tenantId: string): Promise<string | null> {
  const { rows } = await c.query<{ vertical: string | null }>(`SELECT vertical FROM companies WHERE id = $1`, [tenantId]);
  return rows[0]?.vertical ?? null;
}

/**
 * The live lead-seat holders of the company's GM unit(s), lower case, sorted and distinct. `structure` may be passed when the caller already
 * read the org tree in this transaction. Runs on the caller's `withTenants([tenantId])` client.
 */
export async function loadGmSeatIds(c: PoolClient, tenantId: string, structure?: unknown): Promise<string[]> {
  const tree = structure === undefined ? await loadOrgStructure(c, tenantId) : structure;
  const units = [...gmUnitIds(tree, await companyVertical(c, tenantId))];
  if (units.length === 0) return [];
  const byNode = await loadSeatHoldersByNode(c, tenantId, units);
  const ids = new Set<string>();
  for (const holders of byNode.values()) for (const id of holders) ids.add(id.toLowerCase());
  return [...ids].sort();
}

/**
 * AIP-19 (AIP-D19): the live lead-seat holders of the company's IT unit(s), lower case, sorted and distinct: the departments of the company's
 * own org tree whose workspace slug is `it` for the company's vertical (found BY NAME, the way the GM unit is), and the seats are the same
 * §50 seats. A company with no IT unit, or no seat on it, answers [] (the runaway alert then reaches the owner(s) alone).
 */
export async function loadItSeatIds(c: PoolClient, tenantId: string, structure?: unknown): Promise<string[]> {
  const tree = structure === undefined ? await loadOrgStructure(c, tenantId) : structure;
  const vertical = await companyVertical(c, tenantId);
  const units = departmentUnits(tree).filter((u) => workspaceSlugFor(vertical, u.name) === "it").map((u) => u.id);
  if (units.length === 0) return [];
  const byNode = await loadSeatHoldersByNode(c, tenantId, units);
  const ids = new Set<string>();
  for (const holders of byNode.values()) for (const id of holders) ids.add(id.toLowerCase());
  return [...ids].sort();
}

/** Everything one request needs to authorize and to name units: the org tree, the GM seats, and (for a unit) its ancestry. */
export interface AiUsageFacts {
  structure: unknown;
  gmIds: string[];
  unitAncestors: string[];
}

/** One read of the facts, on the caller's `withTenants([tenantId])` client. `unitNodeId` only on the unit route. */
export async function loadAiUsageFacts(c: PoolClient, tenantId: string, unitNodeId?: string): Promise<AiUsageFacts> {
  const structure = await loadOrgStructure(c, tenantId);
  const gmIds = await loadGmSeatIds(c, tenantId, structure);
  const unitAncestors = unitNodeId === undefined ? [] : await loadUnitAncestors(c, tenantId, unitNodeId);
  return { structure, gmIds, unitAncestors };
}
