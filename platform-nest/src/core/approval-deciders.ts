// MAIL-06 (F1 fix, design §7.2/§7.3) — decider-set resolution for `automation_approvals` /
// `agency_approvals` CREATE. Callers: automation-approvals.controller.ts (create), hr.controller.ts
// (fileLeave, origin='hr'), search.controller.ts (the Google-Ads change-proposal suspend path,
// origin='automation'), agency.controller.ts (createApproval + submit — BOTH agency_approvals
// insert paths).
//
// THIS IS A NOTIFICATION-ROUTING MIRROR, NOT AN AUTHORIZATION CHECK. Cerbos remains the sole
// authority for "who may decide" — every decide/approve endpoint still calls `authorize()` against
// the resource policy at decide-time, unchanged by this file. The queries below only answer "who
// should be TOLD a new approval exists", by reproducing the SAME rule the policy encodes today. A
// silent divergence between this file and the policy means the wrong people get told about — or
// nobody is told about — a high-risk action, so any change to either policy file's decide/approve
// rule MUST be mirrored here in the same change:
//
//   - platform-nest/cerbos/policies/resource_automation_approval.yaml → `decide` action:
//       derivedRoles: ["company_admin", "group_executive"]
//       PLUS derivedRoles: ["module_manager"] when resource.attr.module == "hr" (WSD-2 — the
//       providing unit's hr_manager; module_manager's condition in derived_roles.yaml string-
//       composes the concrete role name as "<module>_manager", i.e. literally 'hr_manager' here).
//   - platform-nest/cerbos/policies/resource_agency_approval.yaml → `approve` action (ex-Q-V8,
//       answered 2026-08-04 by reading the policy file — it is in-repo and dev-provable):
//       derivedRoles: ["company_admin", "module_approver"]
//       module_approver's condition string-composes "<module>_approver"; agency.controller.ts
//       always passes module: "agency" for agency_approval resources, so the concrete role name
//       here is literally 'agency_approver'.
//
// Both derived roles resolve against derived_roles.yaml's scope-cascade grants (`user_roles` JOIN
// `roles`, read via withGlobal) — the SAME global tables `rbac/principal.ts`'s `assemblePrincipal`
// reads to build a live principal's `grants`. `company_admin` matches scopeType='global' OR
// ('company' scoped to this tenant); `group_executive` matches scopeType='global' ONLY
// (derived_roles.yaml has no company-scoped branch for it — it is an owner-level role).
import { withGlobal } from "../db";

/** De-duped by user id, on top of the query's own `SELECT DISTINCT ur.user_id`. Belt & suspenders
 *  against the documented duplicate-role-row defect (memory: "NULL defeats UNIQUE constraints" —
 *  the original `UNIQUE (company_id, name)` never constrained GLOBAL roles because SQL NULLs are
 *  distinct, so a re-run seed grew multiple global rows sharing one role name; migration 0073 added
 *  a partial unique index for future inserts, but rows already granted before 0073 — or any two
 *  role rows of the SAME name granted to the same user for any other reason — must still collapse
 *  to exactly one notification). Without this, a decider holding two role rows of the same name
 *  would receive N notifications and N mail_log rows for one approval. */
function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

/** Mirrors `resource_automation_approval.yaml`'s `decide` rule (see file header). `module` should
 *  be `"hr"` for an hr-origin row (and only then) — every other origin passes it undefined. */
export async function resolveAutomationApprovalDeciders(tenantId: string, module?: string): Promise<string[]> {
  const includeHr = module === "hr";
  const { rows } = await withGlobal((c) =>
    c.query<{ user_id: string }>(
      `SELECT DISTINCT ur.user_id
         FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        -- IAM-15 (D-7) dropped the group_executive clause with the role. This query MIRRORS
        -- resource_automation_approval.yaml's decide rule, and that rule's exec arm was one of the
        -- 54 deleted, so keeping the clause would have made the mirror WIDER than the policy -- the
        -- exact drift this file's header warns about. (No backticks in here: this SQL sits inside a
        -- JS template literal, where a backtick ENDS the string.)
        WHERE (r.name = 'company_admin' AND (ur.scope_type = 'global' OR (ur.scope_type = 'company' AND ur.scope_id = $1)))
           OR ($2::boolean AND r.name = 'hr_manager' AND (ur.scope_type = 'global' OR (ur.scope_type = 'company' AND ur.scope_id = $1)))`,
      [tenantId, includeHr],
    ),
  );
  return dedupe(rows.map((r) => r.user_id));
}

/**
 * WSK-66 — the decider set for an `origin='webdesk'` row (a WebDesk `content.publish` /
 * `content.schedule` / `key.mint` / `site.archive` / `site.setDomain` request, executed in-band at decide()). Two Cerbos gates stack at
 * decide time, and this mirrors their INTERSECTION:
 *   1. `resource_automation_approval.yaml` · `decide` — company_admin (webdesk rows carry no
 *      `module`, so the hr-only module_manager arm never applies): the base query above.
 *   2. the execution gate the decider must ALSO pass —
 *      `resource_webdesk_content_item.yaml` · `publish`/`schedule` (company_admin or a webdev
 *      module_manager, approvalId required, maker ≠ checker unless R4), or
 *      `resource_webdev_provisioned_site.yaml` · `promote` for `key.mint` / `site.archive` / `site.setDomain` (company_admin, manager,
 *      module_manager). company_admin is in every one of those, so (1) ∩ (2) = (1) on ROLES.
 * What (2) adds is the maker ≠ checker rule: the requester is dropped from the set unless the
 * caller says self-approval is allowed, which is true ONLY for a single-item `content.publish`
 * (WSK-D46 R4; `webdesk-approved-command.ts` computes it from the stored items). `key.mint` and
 * `site.archive` / `site.setDomain` keep the requester out too (the executor enforces requester ≠ decider for them in code).
 *
 * Same status as the rest of this file: a NOTIFICATION mirror. Cerbos decides at decide() time.
 * A webdev_manager publisher is NOT in this set because the generic `decide` gate refuses them
 * today (design §6: a `decide_webdesk` action is post-proof work); listing them would mail people
 * who would then get a 403.
 */
export async function resolveWebdeskApprovalDeciders(
  tenantId: string,
  opts: { requestedBy: string | null; selfApprovalAllowed: boolean },
): Promise<string[]> {
  const base = await resolveAutomationApprovalDeciders(tenantId);
  if (opts.selfApprovalAllowed || !opts.requestedBy) return base;
  return base.filter((id) => id !== opts.requestedBy);
}

/** Mirrors `resource_agency_approval.yaml`'s `approve` rule (see file header, ex-Q-V8). */
export async function resolveAgencyApprovalDeciders(tenantId: string): Promise<string[]> {
  const { rows } = await withGlobal((c) =>
    c.query<{ user_id: string }>(
      `SELECT DISTINCT ur.user_id
         FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE r.name IN ('company_admin', 'agency_approver')
          AND (ur.scope_type = 'global' OR (ur.scope_type = 'company' AND ur.scope_id = $1))`,
      [tenantId],
    ),
  );
  return dedupe(rows.map((r) => r.user_id));
}
