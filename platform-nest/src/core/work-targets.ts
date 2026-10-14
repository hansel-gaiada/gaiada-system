// DW-8h (docs/FRONTEND-BFF-CONTRACT.md §45.1) — the work targets that two controllers resolve the same way: a PM task, a work
// request and a campaign part. This is DW-6k's resolver (it was in figma/figma.controller.ts, §36.5), moved here unchanged in
// behaviour so there is ONE copy of the rule: Figma links (figma.controller.ts) and file attachments (files.controller.ts) both
// import it, and DW-6k's Cerbos matrix keeps covering it.
//
// WHAT IS HERE: the Cerbos kind each target is authorised as, the resource a READ sends, the target row read from the database
// (`readTarget`, with the attributes a WRITE needs), and the write check (`authorizeWrite`).
//
// WHAT IS NOT HERE: the "not found" outcome. `findTarget` and `readTarget` answer `null` (absent, soft-deleted, another tenant's
// by RLS, or an id that cannot be one) and each controller throws its own refusal (Figma's `FigmaRuleError`, the files
// controller's 404 `target_not_found`), so this module owns no error type.
import type { PoolClient } from "pg";
import { withTenants } from "../db";
import { can } from "../rbac/can";
import type { Principal } from "../rbac/principal";
import type { Resource } from "../rbac/cerbos";
import { authorize } from "./http";
import { isUuidShaped } from "./dept-resolution";
import { factsResource } from "./work-requests.controller";
import { loadAuthFacts } from "./work-requests.service";
import { partResource } from "../modules/agency/agency.controller";
import { partUnitAncestors } from "../modules/agency/agency-campaign-parts.service";

/** The three kinds of work a target can be. The same strings Figma's `TargetKind` (figma/rules.ts) uses. */
export type WorkTargetKind = "pm_task" | "work_request" | "campaign_part";

/** The Cerbos kind each target kind is authorised as. */
export const CERBOS_KIND: Record<WorkTargetKind, string> = {
  pm_task: "pm_task",
  work_request: "work_request",
  campaign_part: "agency_campaign_part",
};

/** The resource a READ on the target sends: what the target's own read routes send. `id` is added only when it is usable. */
export function readResourceOf(kind: WorkTargetKind, tenantId: string, id?: string): Resource {
  if (kind === "campaign_part") return partResource(tenantId, id ? { id } : {});
  return { kind: CERBOS_KIND[kind], tenantId, ...(id ? { id } : {}) };
}

export interface Target {
  id: string;
  /** The target's department (an org-node id) where it has one; the exported asset carries it. */
  departmentId: string | null;
  /** The resource a WRITE on the target sends, attributes read from the DB. */
  writeResource: Resource;
  /** True when the target takes no new attachments: a `work_request` that is `cancelled` or `declined`, or a `campaign_part`
   *  that is `cancelled` (§45.1). A `delivered` request is not closed. A PM task is never closed. Additive; Figma ignores it. */
  closed: boolean;
}

export async function readTarget(c: PoolClient, tenantId: string, kind: WorkTargetKind, id: string): Promise<Target | null> {
  if (kind === "pm_task") {
    const r = await c.query<{ department_id: string | null }>(
      `SELECT p.department_id FROM pm_tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1 AND t.deleted_at IS NULL`,
      [id],
    );
    if (!r.rows[0]) return null;
    return { id, departmentId: r.rows[0].department_id, writeResource: { kind: "pm_task", tenantId, id }, closed: false };
  }
  if (kind === "work_request") {
    const facts = await loadAuthFacts(c, tenantId, id);
    if (!facts) return null;
    const s = await c.query<{ status: string }>(`SELECT status FROM work_requests WHERE id = $1 AND deleted_at IS NULL`, [id]);
    const closed = s.rows[0]?.status === "cancelled" || s.rows[0]?.status === "declined";
    return { id, departmentId: facts.toUnitId, writeResource: factsResource(tenantId, facts), closed };
  }
  const r = await c.query<{ unit_id: string; owner_id: string | null; status: string }>(
    `SELECT unit_id, owner_id, status FROM agency_campaign_parts WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  if (!r.rows[0]) return null;
  const ancestors = await partUnitAncestors(c, tenantId, r.rows[0].unit_id);
  return {
    id, departmentId: r.rows[0].unit_id,
    writeResource: partResource(tenantId, { id, ownerId: r.rows[0].owner_id ?? undefined, unitAncestors: ancestors }),
    closed: r.rows[0].status === "cancelled",
  };
}

/** The target, or `null`: absent, deleted, another tenant's (RLS) or an id that cannot be one. The caller turns `null` into its
 *  own 404. */
export async function findTarget(tenantId: string, kind: WorkTargetKind, id: string | null): Promise<Target | null> {
  if (!id || !isUuidShaped(id)) return null;
  return withTenants([tenantId], (c) => readTarget(c, tenantId, kind, id));
}

/** The write check on a target (§36.5). `work_request` allows either `deliver` (the receiving side) or `cancel` (the asker):
 *  two questions through `can()`, which answers without throwing, then the ONE authoritative `authorize()` on the action
 *  that passed (it audits, enforces the session and the act-for intersection). When neither passes it asks `deliver`, so the
 *  refusal is the standard audited 403. */
export async function authorizeWrite(principal: Principal, kind: WorkTargetKind, target: Target): Promise<void> {
  if (kind !== "work_request") return authorize(principal, target.writeResource, "update");
  // `can()` sets the Cerbos kind itself from the catalog entry, so the full resource is passed as it is.
  let action = "deliver";
  if (!(await can(principal, "core.work_request.deliver", target.writeResource))) {
    if (await can(principal, "core.work_request.cancel", target.writeResource)) action = "cancel";
  }
  return authorize(principal, target.writeResource, action);
}
