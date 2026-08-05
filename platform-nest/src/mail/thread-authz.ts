// MAIL-13 / design A10 — the ONE implementation of "authorize a thread read against its PARENT
// entity". Both thread read paths (the entity-scoped `GET /api/:t/mail/threads` and the admin
// `GET /api/admin/mail/log/:id/thread`) call this, for the reason `core/portal-scope.ts` states about
// its own kernel: a rule re-derived in two controllers is a rule that will eventually disagree with
// itself, and here the two halves disagreeing means one of them over-permits.
//
// WHY THE PARENT AND NOT THE MAIL TABLES (A10, verbatim): "Thread reads are authorized against the
// parent entity (`authorize()` on the entity kind the thread hangs off), never against the global mail
// tables directly. That is the compensating control for `mail_messages` being global (§6.1)." So the
// contract this file must satisfy is behavioural, not merely structural: **a caller who cannot read
// the approval/run cannot read its thread, in exactly the cases the parent 403s** — which is why each
// branch below reproduces the parent surface's own `authorize()` call SHAPE, attributes included,
// rather than a simplified version of it. Getting `module` wrong on the automation_approval branch, for
// instance, would deny the thread to a shared-service `hr_manager` who can read the approval itself
// (WSD-2's `module_manager` rule matches only when `resource.attr.module == "hr"`).
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { withTenants } from "../db";
import { authorize } from "../core/http";
import type { Principal } from "../rbac/principal";

/** Entity kinds a thread may hang off — the three `mail_log.entity_type` values design §5's DDL
 *  enumerates. Fail-closed by allowlist rather than by "whatever Cerbos says about this string":
 *  an unlisted Cerbos resource kind yields a DENY, but it yields it for EVERYONE including a
 *  platform_admin, which reads as a logic bug rather than as a policy decision (the
 *  `cerbos-new-policy-needs-restart` failure mode). An explicit list makes adding a fourth entity kind
 *  a deliberate two-line change: this set, plus its `authorize()` shape below. */
export const MAIL_THREAD_ENTITY_KINDS = new Set(["automation_approval", "agency_approval", "pipeline_run"]);

/**
 * Throws (403/404) unless `principal` may read the entity this thread hangs off.
 *
 * `entityId` is required: authorizing a thread against the entity KIND alone would let a caller who
 * can read one approval read the thread of every approval in the tenant.
 */
export async function authorizeThreadParent(
  principal: Principal,
  tenantId: string,
  entityType: string,
  entityId: string,
): Promise<void> {
  if (!MAIL_THREAD_ENTITY_KINDS.has(entityType)) {
    throw new ForbiddenException(`mail threads are not readable for entity type '${entityType}'`);
  }

  if (entityType === "automation_approval") {
    // Mirrors `core/automation-approvals.controller.ts`'s decide path EXACTLY, with action "read":
    // fetch the row's `origin` first so an hr-origin approval carries `resource.attr.module='hr'` (the
    // only route by which the providing unit's hr_manager passes), 404 when the id does not exist, then
    // authorize. The read-before-authorize ordering is that controller's own idiom and is preserved
    // deliberately — diverging from it is how "403s exactly like the parent" stops being true.
    const existing = await withTenants([tenantId], (c) =>
      c.query<{ origin: string }>(
        `SELECT origin FROM automation_approvals WHERE id = $1 AND deleted_at IS NULL`,
        [entityId],
      ),
    );
    if (!existing.rows[0]) throw new NotFoundException("approval not found");
    const module = existing.rows[0].origin === "hr" ? "hr" : undefined;
    await authorize(principal, { kind: "automation_approval", id: entityId, tenantId, module }, "read");
    return;
  }

  if (entityType === "agency_approval") {
    // Mirrors `modules/agency/agency.controller.ts`'s read calls (`module: "agency"` on every one).
    await authorize(principal, { kind: "agency_approval", id: entityId, tenantId, module: "agency" }, "read");
    return;
  }

  // pipeline_run — mirrors `core/pipeline.controller.ts`'s read calls (no extra attributes).
  await authorize(principal, { kind: "pipeline_run", id: entityId, tenantId }, "read");
}
