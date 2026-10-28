// SCP-1b (docs/PERMISSION-CONTRACT.md §53.4-§53.5, docs/FRONTEND-BFF-CONTRACT.md §63.2, §63.3.3) — the facts Cerbos sees for
// the Social Media content pipeline, read from the rows and never from a body, and the three resource shapes built from them.
//
// One module, shared by every caller that authorizes a pipeline action: the stage machine and its routes (SCP-1b-sm), the
// report routes (social-reports.controller.ts), and the publish decision's approverCheck (core/approval-executables.ts).
//
// THE FOUR SOCIAL APPROVERS (SCP-Q19). Two of them are seats, fed to Cerbos as `approverIds` (derived role
// `social_approver_seat`): the live lead-seat holders of the company's Social Media unit and of its GM unit. The other two
// need no entry: the `owner` reaches the approver actions through their perm_* mirrors, and `platform_admin` through the
// wildcard.
//   - The units are found BY NAME, the way every GM surface finds its unit: the departments of the company's own org tree
//     whose workspace slug is `social-media` or `gm` for the company's vertical (`workspaceSlugFor`, `gmUnitIds`). Never a
//     hard-coded node id (PV-D13).
//   - The seats are §50's (DW-10g-2): an active `positions` row of the company carrying its `org_unit_lead` role row at
//     `own_unit`, held through an assignment with no `valid_to` (`loadSeatHoldersByNode`). The role row is the source;
//     `is_lead` is not read. Read in the company's own scope (the caller's `withTenants([tenantId])`), so the head of
//     another company's same-id unit is never an approver here.
//   - The exact two units, not a subtree: a head of an ancestor of Social Media is not one of the four (§53.4).
//
// Every function takes the caller's client: the caller owns the transaction and its tenant scope. Social tables carry the
// module wall (`app_module_allowed('social')`), so each social read declares the module scope on that transaction first
// (`declareSocialModuleScope`, additive and transaction-local), and an unset scope can never read zero rows silently.
import type { PoolClient } from "pg";
import type { Resource } from "../../rbac/cerbos";
import { departmentUnits, workspaceSlugFor } from "../reports/dept-kpis";
import { loadOrgStructure, loadSeatHoldersByNode } from "../reports/person-scope";
import { gmUnitIds } from "../../core/automation-failures-audience";
import { loadAuthFacts } from "../../core/work-requests.service";
import { declareSocialModuleScope } from "./module-scope";

/** The Cerbos-relevant facts of one pipeline (or Composer) post, every value from the rows. */
export interface SocialPostAuthz {
  postId: string;
  engagementId: string;
  /** NULL for a Composer post (`social_posts.pipeline_status`). */
  pipelineStatus: string | null;
  /** The client's officer: the engagement's `owner_id`, or "" when none. */
  ownerId: string;
  /** The maker: the post's `author_id`, or "" before `start_draft`. */
  creatorId: string;
  /** The company's Social Media and GM lead-seat holders (`loadSocialApproverIds`). */
  approverIds: string[];
  /** The PM task's responsible and person assignees of the post's month request (`creative_request_id`), or []. */
  assigneeIds: string[];
  /** The post's `creative_source` (`creatives` | `in_team`), or "" before `approve_for_design`. */
  creativeSource: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The workspace slugs whose unit heads are social approvers (SCP-Q19). */
export const SOCIAL_APPROVER_UNIT_SLUGS = ["social-media", "gm"] as const;

/** PURE. The node ids of the company's Social Media unit(s) and GM unit(s) in `structure` (the company's own org tree). */
export function socialApproverUnitIds(structure: unknown, vertical: string | null): string[] {
  const ids = new Set<string>(gmUnitIds(structure, vertical));
  for (const u of departmentUnits(structure)) {
    if (workspaceSlugFor(vertical, u.name) === "social-media") ids.add(u.id);
  }
  return [...ids].sort();
}

/**
 * The live lead-seat holders of the company's Social Media unit and its GM unit, sorted and distinct: the HoD and the GM
 * (the owner and the superadmin need no entry). Runs on the caller's `withTenants([tenantId])` client. A company with no such
 * unit, or no seat on it, answers [] (nobody is a seat approver: fail closed).
 */
export async function loadSocialApproverIds(client: PoolClient, tenantId: string): Promise<string[]> {
  const vertical = (
    await client.query<{ vertical: string | null }>(`SELECT vertical FROM companies WHERE id = $1`, [tenantId])
  ).rows[0]?.vertical ?? null;
  const units = socialApproverUnitIds(await loadOrgStructure(client, tenantId), vertical);
  if (units.length === 0) return [];
  const byNode = await loadSeatHoldersByNode(client, tenantId, units);
  const ids = new Set<string>();
  for (const holders of byNode.values()) for (const id of holders) ids.add(id.toLowerCase());
  return [...ids].sort();
}

/**
 * The facts of post `postId` in `tenantId`, or null (absent, deleted, another tenant's, or not a uuid). A Composer post
 * answers too, with `pipelineStatus: null`: the caller decides what that means.
 */
export async function loadSocialPostAuthz(client: PoolClient, tenantId: string, postId: string): Promise<SocialPostAuthz | null> {
  if (typeof postId !== "string" || !UUID_RE.test(postId)) return null;
  return (await loadSocialPostAuthzMany(client, tenantId, [postId])).get(postId.toLowerCase()) ?? null;
}

/**
 * SCP-3g: the facts of several posts of `tenantId` at once, keyed by the post id (lower case). The ONE builder
 * `loadSocialPostAuthz` reads through, so a page of posts gets exactly the facts one post gets: one posts query, the seat
 * holders once, and one PM read per distinct month request. A post that is absent, deleted or another tenant's, or an id that
 * is not a uuid, has no entry.
 */
export async function loadSocialPostAuthzMany(
  client: PoolClient,
  tenantId: string,
  postIds: readonly string[],
): Promise<Map<string, SocialPostAuthz>> {
  const out = new Map<string, SocialPostAuthz>();
  const wanted = [...new Set(postIds.filter((id) => typeof id === "string" && UUID_RE.test(id)).map((id) => id.toLowerCase()))];
  if (wanted.length === 0) return out;
  await declareSocialModuleScope(client);
  const { rows } = await client.query<{
    id: string; engagement_id: string; pipeline_status: string | null; author_id: string | null;
    creative_request_id: string | null; creative_source: string | null; owner_id: string | null;
  }>(
    `SELECT p.id, p.engagement_id, p.pipeline_status, p.author_id::text AS author_id,
            p.creative_request_id::text AS creative_request_id, p.creative_source, e.owner_id::text AS owner_id
       FROM social_posts p
       JOIN social_engagements e ON e.id = p.engagement_id AND e.tenant_id = p.tenant_id
      WHERE p.tenant_id = $1 AND p.id = ANY($2::uuid[]) AND p.deleted_at IS NULL`,
    [tenantId, wanted],
  );
  if (rows.length === 0) return out;
  const assigneesByRequest = new Map<string, string[]>();
  for (const requestId of new Set(rows.map((r) => r.creative_request_id).filter((v): v is string => !!v))) {
    assigneesByRequest.set(requestId, (await loadAuthFacts(client, tenantId, requestId))?.assigneeIds ?? []);
  }
  const approverIds = await loadSocialApproverIds(client, tenantId);
  for (const r of rows) {
    out.set(r.id.toLowerCase(), {
      postId: r.id,
      engagementId: r.engagement_id,
      pipelineStatus: r.pipeline_status,
      ownerId: r.owner_id ?? "",
      creatorId: r.author_id ?? "",
      approverIds: [...approverIds],
      assigneeIds: r.creative_request_id ? [...(assigneesByRequest.get(r.creative_request_id) ?? [])] : [],
      creativeSource: r.creative_source ?? "",
    });
  }
  return out;
}

/** The `social_post` resource of BFF §63.3.3. */
export function socialPostResource(tenantId: string, facts: SocialPostAuthz): Resource {
  return {
    kind: "social_post",
    id: facts.postId,
    tenantId,
    module: "social",
    ownerId: facts.ownerId,
    creatorId: facts.creatorId,
    approverIds: [...facts.approverIds],
    assigneeIds: [...facts.assigneeIds],
    creativeSource: facts.creativeSource,
  };
}

/** The `social_engagement` resource of the planning and money routes (§63.3.3): no id for a company-level action. */
export function socialEngagementResource(tenantId: string, approverIds: string[], engagementId?: string): Resource {
  return {
    kind: "social_engagement",
    ...(engagementId ? { id: engagementId } : {}),
    tenantId,
    module: "social",
    approverIds: [...approverIds],
  };
}

/** The `social_report` resource of the report routes (§63.3.3, §53.7): no `ownerId` (the officer no longer sends). */
export function socialReportResource(tenantId: string, reportId: string, approverIds: string[]): Resource {
  return {
    kind: "social_report",
    ...(reportId ? { id: reportId } : {}),
    tenantId,
    module: "social",
    approverIds: [...approverIds],
  };
}
