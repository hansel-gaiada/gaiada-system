// SCP-1b (docs/PERMISSION-CONTRACT.md §53.4, plan §11.2) — test fixtures for the Social Media content pipeline's actors.
//
// Reuses what exists: `grantLeadSeat` (fixtures.ts, the real §50 / DW-10g-2 seat: an active position, its `org_unit_lead`
// role row at `own_unit`, an open assignment), `createRole` / `grantRole`, and the org-tree shape the GM surfaces read
// (`company_org_structure`, departments found by name through `workspaceSlugFor`). Nothing here hard-codes a node id into
// the code under test: the ids below are the fixture's own, and pipeline-authz.ts finds the units by their NAMES.
import { withGlobal, withTenants } from "../db";
import { config } from "../config";
import { createRole, grantLeadSeat, grantRole } from "./fixtures";

/** The fixture's node ids. Free-form on purpose: the code resolves units by name ("Social Media", "GM"), never by id. */
export const SOCIAL_UNITS = {
  socialMedia: "d-social-media",
  gm: "d-gm",
  webDev: "d-webdev",
  creatives: "d-creatives",
  /** An ancestor division above Social Media: its head is NOT a social approver (the exact two units, §53.4). */
  division: "d-marketing",
} as const;

export type SocialUnitKey = keyof typeof SOCIAL_UNITS;

/**
 * Make `tenantId` an agency company (vertical `agency`, so the `social-media` and `gm` workspaces resolve) with an org tree
 * of: GM, a Marketing division holding Social Media and Creatives, and Web Dev. Overwrites any tree the company had.
 * Pass `unitIds` to use other node ids (e.g. the SAME ids in two companies, for the tenant trap).
 */
export async function seedSocialOrgTree(
  tenantId: string,
  unitIds: Partial<Record<SocialUnitKey, string>> = {},
): Promise<Record<SocialUnitKey, string>> {
  const ids = { ...SOCIAL_UNITS, ...unitIds } as Record<SocialUnitKey, string>;
  const dept = (id: string, name: string, children: unknown[] = []) => ({
    id, name, kind: "department", assigneeId: null, assigneeName: null, children,
  });
  const root = {
    id: `root-${tenantId}`, name: "Root", kind: "company", assigneeId: null, assigneeName: null,
    children: [
      dept(ids.gm, "GM"),
      dept(ids.division, "Marketing", [dept(ids.socialMedia, "Social Media"), dept(ids.creatives, "Creatives")]),
      dept(ids.webDev, "Web Dev"),
    ],
  };
  await withGlobal((c) => c.query(`UPDATE companies SET vertical = 'agency' WHERE id = $1`, [tenantId]));
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO UPDATE SET structure = EXCLUDED.structure, updated_at = now()`,
      [tenantId, JSON.stringify({ root }), config.originSite],
    ),
  );
  return ids;
}

/**
 * A live lead seat for `userId` on `unitNodeId` in `tenantId` (the real §50 shape, through `grantLeadSeat`). On the
 * company's Social Media or GM unit this makes them a social approver (`loadSocialApproverIds`). Returns the position id.
 * Pass `o` through for the negative shapes (`ended`, `status: "retired"`, `noRole`).
 */
export async function grantSocialSeat(
  tenantId: string,
  unitNodeId: string,
  userId: string,
  o: Parameters<typeof grantLeadSeat>[3] = {},
): Promise<string> {
  return grantLeadSeat(tenantId, unitNodeId, userId, o);
}

/** A company-scope grant of one of the pipeline's roles (`social_copywriter`, `social_designer`, or any other role name,
 *  e.g. `social_staff` for the team's read tier, `owner`, `company_admin`). */
export async function grantSocialRole(
  tenantId: string,
  userId: string,
  role: "social_copywriter" | "social_designer" | "social_staff" | "social_manager" | (string & {}),
): Promise<void> {
  await grantRole(userId, await createRole(role), "company", tenantId);
}

/** Set (or clear, with null) an engagement's officer: `social_engagements.owner_id` (§53.4: the officer IS the owner). */
export async function setEngagementOfficer(tenantId: string, engagementId: string, userId: string | null): Promise<void> {
  const r = await withTenants(
    [tenantId],
    (c) => c.query(`UPDATE social_engagements SET owner_id = $3 WHERE tenant_id = $1 AND id = $2`, [tenantId, engagementId, userId]),
    { modules: ["social"] },
  );
  if (r.rowCount !== 1) throw new Error(`setEngagementOfficer: no engagement ${engagementId} in ${tenantId}`);
}
