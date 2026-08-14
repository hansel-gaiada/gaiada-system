// IAM Phase 2 (P2-04) — `GrantWriteService`: THE single choke point for creating or revoking a
// `user_roles` row (design `2026-08-13-iam-phase2-design.md` §6.1).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
//
// Two reachable privilege escalations shipped in one week through this exact surface:
//
//   * IAM-SEC-02/04 — `assignRole` could mint `platform_admin @ company:X`. A role's Cerbos
//     derived-role condition may only be satisfiable at particular scopes, but
//     `assemblePrincipal()` resolves `perms` carrying the GRANT's scope, so a mis-scoped grant
//     hands the permission arm what the role arm refuses. Closed by `ROLE_SCOPE_CONSTRAINTS`.
//   * IAM-SEC-05 — `inviteUser`'s optional initial-role grant ran the SAME class of INSERT with a
//     caller-supplied `roleId` and NO scope check at all, while `assignRole` had one. Two
//     hand-written copies of one rule that drifted; a company_admin could mint a 247-permission
//     bundle through the writer the guard was never wired onto.
//
// The lesson is not "add the missing check" — that was IAM-SEC-05's fix and it is already in.
// The lesson is that a rule enforced by N hand-written copies fails at whichever copy the next
// writer forgets. This module is the answer: EVERY production path that inserts or deletes a
// `user_roles` row calls in here, and `user-roles-writer-guard.test.ts` turns CI red on a bespoke
// writer anywhere else in `src/`. The next writer cannot be written wrong, because there is
// nowhere else to write it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ORIGINS — the invariant set is a property of WHERE the grant came from, not of this module
//
// The design deliberately does NOT apply one uniform rule set to every caller (§6.3 scopes its
// invariant list to "all NEW surfaces"; §6.4 pins the legacy admin surface's boundary explicitly).
// Three origins, and the difference between them is load-bearing, not convenience:
//
//   `legacy_admin`      — `assignRole` / `inviteUser`. The company_admin admin console, full
//                         catalog reach. Design §6.4: "keep today's semantics this wave — minus
//                         one tightening: target == caller is refused". Enforced here: scope
//                         validity (unchanged) + self-target refusal (the one NEW refusal).
//                         NOT enforced here, deliberately and by design §6.4/§6.3.6:
//                         allow-list, ceiling, elevated fence. Convergence is Phase 4's ticket.
//                         This is not laziness — it is pinned by the existing suite: two live
//                         tests assert `client @ company` grants SUCCEED through both writers
//                         (`global-only-role-scope.test.ts`), and `client`'s bundle is 7
//                         `portal.*` keys that are all `ui_grantable = false`; a third asserts
//                         `platform_admin @ global` SUCCEEDS. Applying the allow-list or the
//                         fence to this origin would break all three — i.e. it would be a silent
//                         behavioural delta on a live authorization surface, which this ticket
//                         exists to prevent.
//
//   `ui`                — the Phase-2 surfaces (P2-08's grant/revoke endpoints, P2-11's dept-head
//                         page, P2-12's positions composer). The full §6.3 invariant set that is
//                         expressible today: scope validity, self-target refusal, allow-list,
//                         elevated fence, ceiling. NOT YET REACHED BY ANY ENDPOINT — P2-08 owns
//                         the controller. Shipped, unit-proven and teeth-proven here so P2-08
//                         inherits an enforced guard instead of writing a fifth copy of one.
//
//   `trusted_internal`  — the service reconciler and the client-portal invite-accept path. These
//                         run NO caller-choice validation, on purpose: neither the role nor the
//                         scope is caller-chosen (see each call site's reason, mirrored in
//                         `user-roles-writer-guard.test.ts`'s TRUSTED_INTERNAL_CALLERS). Routing
//                         them here buys the STRUCTURAL property — every INSERT/DELETE lives in
//                         one file — with a provably zero behavioural delta, which is the only
//                         acceptable trade on a live authz surface. The teeth are that the writer
//                         guard pins WHICH files may call the trusted entry points by name, so a
//                         new writer cannot reach for `trusted_internal` to skip the invariants.
//
// DEFERRED TO P2-08, explicitly (design §6.3.1 and §6.3.7), so their absence is a recorded
// decision and not a hole someone has to notice:
//   * subtree bound — needs the `role_grant` Cerbos kind live-probed with a server-derived
//     `unitAncestors` feed from `org_unit_closure`. P2-02 registered the kind; no handler
//     populates the attribute yet, and inventing a half-version here would be the
//     frontend-first-drift bug class applied to authorization.
//   * sensitive-key routing to an `automation_approvals` override request — needs the
//     `decide_override` action and the approval seam, both P2-08's.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// IMPORT NOTE (deliberate, not an accident): `assertRoleScopeAllowed` is imported FROM
// `admin-identity.controller.ts` rather than moved here, which makes this an import cycle
// (the controller imports this module's writers). It is kept that way because
// `permission-arm-hazard-scan.test.ts` parses `const ROLE_SCOPE_CONSTRAINTS = {...}` out of
// `admin-identity.controller.ts`'s SOURCE TEXT, BY PATH — moving the map would blind a machine
// check that exists precisely to stop this map drifting from `derived_roles.yaml`, and this
// ticket is forbidden from touching `scope-constrained-roles.*`. The cycle is safe (the binding
// is read at call time, never at module-evaluation time) and is not silently safe: if it ever
// broke, the call would throw a TypeError and `global-only-role-scope.test.ts`'s 400-expectations
// would go RED rather than quietly passing. Follow-up for the architect: give the map its own
// module and repoint the scan's path pin, then this import straightens out.
import { BadRequestException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { newId } from "../db";
import { assertRoleUiGrantable } from "../rbac/ui-grantable";
import type { PermissionGrant } from "../rbac/principal";
import { assertRoleScopeAllowed } from "./admin-identity.controller";

export type GrantOrigin = "legacy_admin" | "ui" | "trusted_internal";

/** Roles no Phase-2 surface may ever mint, at any scope (design §6.3.6, the "elevated fence").
 *  `owner` is listed ahead of its Phase-3 existence on purpose — the fence must already be closed
 *  on the day that role is seeded, not one ticket later. `client` is here for a DIFFERENT reason
 *  than the other three: it is not a tier, it is the staff/client interface boundary, which is a
 *  trust boundary rather than a permission sum (design §7's own wording).
 *
 *  ⚠ This fence binds the `ui` origin ONLY. Design §6.3.6 is explicit that the existing
 *  global-scope-guarded admin path REMAINS a door to the elevated tier until IAM-16's two-person
 *  appointment flow exists ("the only doors ... remain the existing global-scope-guarded admin
 *  path and seeds"). `global-only-role-scope.test.ts` pins that door open, both directions. */
const PHASE2_ELEVATED_FENCE: ReadonlySet<string> = new Set([
  "platform_admin",
  "group_executive",
  "owner",
  "client",
]);

export interface GrantSpec {
  origin: GrantOrigin;
  /** The user the grant lands on. */
  targetUserId: string;
  roleId: string;
  scopeType: string;
  scopeId: string | null;
  /** The acting principal's user id. Required for `legacy_admin`/`ui` (the self-target refusal
   *  and the ceiling both read it); `null` is only legitimate for `trusted_internal`. */
  actorUserId?: string | null;
  /** The acting principal's RESOLVED permissions (`principal.perms`), for the ceiling. Absent
   *  means "holds nothing" — fail-closed by construction, never fail-open. */
  actorPerms?: PermissionGrant[];
  /** The tenant the grant is being made in, for the ceiling's company-scope reach test. */
  tenantId?: string | null;
  /** Reconciler provenance marker. Only `trusted_internal` may set it (A1: `managed_by` is
   *  reconciler-only, pinned by `managed-by-invariant.test.ts`). */
  managedBy?: string | null;
  /** Preserved per-writer, NOT unified — see `insertGrantRow`. */
  onConflict: "untargeted" | "unique_columns";
}

/** Resolve a role's name from its id — the ONE place the choke point learns which role it is
 *  guarding. Deliberately re-read from the DB rather than trusted from a caller-supplied string:
 *  a guard that can be told the wrong role name is not a guard. Throws this program's existing
 *  `unknown role` 400 so the message callers already assert on is unchanged. */
async function resolveRoleName(c: PoolClient, roleId: string): Promise<string> {
  const { rows } = await c.query<{ name: string }>(`SELECT name FROM roles WHERE id = $1`, [roleId]);
  if (!rows[0]) throw new BadRequestException("unknown role");
  return rows[0].name;
}

/** §6.3.5 — no principal may target themselves with a CREATE. Mirrors the structural
 *  `EFFECT_DENY` P2-02 landed on `role_grant.create` (Cerbos stays the authority; this is the
 *  clean-400 mirror the design asks for). Deliberately NOT applied to revokes: dropping your own
 *  grant is a de-escalation, and the Cerbos DENY is scoped to `actions: ["create"]` too. */
function assertNotSelfTarget(actorUserId: string | null | undefined, targetUserId: string | null): void {
  if (actorUserId && targetUserId && actorUserId === targetUserId) {
    throw new BadRequestException(
      "self_grant_forbidden: a principal may not grant a role to themselves (D-9, design §6.3.5) — " +
        "ask another administrator to make this grant",
    );
  }
}

/** §6.3.6 — the elevated fence, `ui` origin only. */
function assertNotElevated(roleName: string): void {
  if (PHASE2_ELEVATED_FENCE.has(roleName)) {
    throw new BadRequestException(
      `elevated_role_forbidden: role "${roleName}" may not be granted from any Phase-2 surface at ` +
        `any scope (design §6.3.6). The elevated tier stays reachable only through the existing ` +
        `global-scope-guarded admin path and seeds until IAM-16's two-person appointment flow lands.`,
    );
  }
}

/**
 * §6.3.2 — the ceiling. The granted role's bundle must be a SUBSET of the grantor's own resolved
 * permissions. Nobody grants what they do not hold.
 *
 * Scope semantics (the part worth being explicit about): a permission the grantor holds at
 * `global` reaches everywhere, one held at `company:<this tenant>` reaches this tenant's grants,
 * and an exact (scopeType, scopeId) match always counts. Anything else does not. A grantor with
 * no `perms` at all (a synthetic principal, or one assembled before IAM-03a) holds NOTHING here —
 * fail-closed, which is the only safe direction for a ceiling.
 *
 * `platform_admin` passes trivially (it holds all 267 grantable keys at global). The 15
 * `class='relationship'` keys are in no bundle at all, so they are structurally out of reach from
 * both sides of this comparison.
 */
async function assertWithinCeiling(c: PoolClient, spec: GrantSpec, roleName: string): Promise<void> {
  const { rows } = await c.query<{ key: string }>(
    `SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = $1 ORDER BY p.key`,
    [spec.roleId],
  );
  const held = new Set<string>();
  for (const g of spec.actorPerms ?? []) {
    const reaches =
      g.scopeType === "global" ||
      (g.scopeType === "company" && !!spec.tenantId && g.scopeId === spec.tenantId) ||
      (g.scopeType === spec.scopeType && g.scopeId === spec.scopeId);
    if (reaches) held.add(g.key);
  }
  const missing = rows.map((r) => r.key).filter((k) => !held.has(k));
  if (missing.length > 0) {
    throw new BadRequestException(
      `ceiling_exceeded: role "${roleName}" carries ${missing.length} permission(s) the grantor does ` +
        `not hold at this scope, and nobody grants what they do not hold (design §6.3.2): ` +
        `${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", …" : ""}`,
    );
  }
}

/**
 * THE guard. Runs the invariant set for `spec.origin` and writes NOTHING — so a caller may (and
 * `inviteUser` does) run it BEFORE any other write, keeping this program's standing "a refusal
 * never leaves a partial row behind" discipline. `insertGrantRow` calls it again at write time,
 * which is the call that actually enforces: a future writer that forgets the early call still
 * cannot escape, because the write itself is guarded.
 */
export async function assertGrantAllowed(c: PoolClient, spec: GrantSpec): Promise<string | null> {
  if (spec.origin === "trusted_internal") return null; // see this file's ORIGINS block
  const roleName = await resolveRoleName(c, spec.roleId);

  // (1) scope validity — the EXISTING check, byte-unchanged, via the one shared helper both
  //     legacy writers already call. IAM-SEC-02/04/05's fix, untouched by this refactor.
  assertRoleScopeAllowed(roleName, spec.scopeType);

  // (2) self-target — the ONE new refusal on the legacy surface (design §6.4).
  assertNotSelfTarget(spec.actorUserId, spec.targetUserId);

  if (spec.origin === "ui") {
    // (3) allow-list, (4) elevated fence, (5) ceiling — Phase-2 surfaces only (design §6.3).
    await assertRoleUiGrantable(c, spec.roleId, roleName);
    assertNotElevated(roleName);
    await assertWithinCeiling(c, spec, roleName);
  }
  return roleName;
}

/**
 * THE insert. Every production `INSERT INTO user_roles` in `src/` is this statement.
 *
 * ⚠ `onConflict` is a PARAMETER rather than a unified clause on purpose. `assignRole` must stay
 * UNTARGETED: migration 0092 added a PARTIAL unique index (`user_roles_global_scope_uniq` on
 * (user_id, role_id, scope_type) WHERE scope_id IS NULL) because the 4-column UNIQUE never fires
 * for global grants (SQL NULLs are never equal), and a TARGETED clause names only the 4-column
 * arbiter — so a re-grant of an already-held GLOBAL role raises an unhandled 23505 and 500s
 * instead of no-opping (`assign-role-global-scope-idempotent.test.ts` pins exactly this). The
 * other three writers all insert at `company` scope with a non-null `scope_id`, where the two
 * clauses are equivalent today. They keep their OWN clause anyway: unifying them would be a
 * behavioural change on a live authorization surface outside this ticket's named intent, and this
 * ticket's first rule is that nothing changes silently. Do not "tidy" this into one clause.
 *
 * `managed_by` is passed explicitly (NULL for every non-reconciler caller) rather than omitted
 * from the column list; the column's default is NULL, so an explicit NULL is byte-identical to
 * leaving it out, and one statement beats four near-duplicates drifting inside the choke point.
 */
export async function insertGrantRow(c: PoolClient, spec: GrantSpec): Promise<string | null> {
  await assertGrantAllowed(c, spec);
  const conflict = spec.onConflict === "untargeted" ? "ON CONFLICT DO NOTHING" : "ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING";
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id, managed_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ${conflict} RETURNING id`,
    [newId(), spec.targetUserId, spec.roleId, spec.scopeType, spec.scopeId, spec.managedBy ?? null],
  );
  return rows[0]?.id ?? null;
}

/** THE admin revoke — `revokeRole`'s statement, verbatim (`id` + `user_id` both pinned so a grant
 *  id from another user cannot be revoked through a mismatched route param). Returns the deleted
 *  row's id, or null when nothing matched (the caller's 404). */
export async function revokeGrantById(c: PoolClient, grantId: string, userId: string): Promise<string | null> {
  const { rows } = await c.query<{ id: string }>(
    `DELETE FROM user_roles WHERE id = $1 AND user_id = $2 RETURNING id`,
    [grantId, userId],
  );
  return rows[0]?.id ?? null;
}

/** THE reconciler revoke — `AND managed_by IS NOT NULL` is the deletion guard that makes manual
 *  and employee rows structurally untouchable from the reconciler's teardown path (A2). Returns
 *  the affected user_id for the caller's session-bump set, exactly as before. */
export async function revokeManagedGrant(c: PoolClient, grantId: string): Promise<string | null> {
  const { rows } = await c.query<{ user_id: string }>(
    `DELETE FROM user_roles WHERE id = $1 AND managed_by IS NOT NULL RETURNING user_id`,
    [grantId],
  );
  return rows[0]?.user_id ?? null;
}
