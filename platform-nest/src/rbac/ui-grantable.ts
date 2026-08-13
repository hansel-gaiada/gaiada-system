// IAM Phase 2 (P2-03) — the `ui_grantable` allow-list enforcement helper (design §7).
//
// THE HAZARD, restated precisely (design §7): a `perm_*` mirror or a `role_permissions` row honours
// a permission key WHICHEVER role carries it. That is safe today only because role composition
// (`role_permissions`) is migration-only data — no runtime write path attaches a permission to a
// role. Phase 2 creates exactly that write path: a POSITION's role-set (`position_roles`) is
// authored through a UI-adjacent surface (P2-08's grant endpoints, P2-12's positions admin UI), and
// Phase 4 will let the UI compose custom roles outright. A staff role carrying `portal.*` would put
// staff inside the CLIENT portal — at a perfectly VALID scope, which is exactly why a scope check
// cannot catch it. The boundary has to live on the KEY itself: `permissions.ui_grantable`.
//
// THIS FILE is the single application-layer enforcement point for that boundary — `assertRoleUiGrantable()`
// is the ONE helper every write path that attaches a role to something UI-authored (a position's
// role-set today; a Phase-4 custom-role composition later) MUST call before writing. It is NOT the
// only layer: migration 0110's `position_roles_guard()` trigger re-checks the identical invariant at
// the DB layer (the design's own words: "the trigger is the layer that survives a forgotten guard"),
// and `cerbos-catalog-alignment.test.ts`/this file's own static suite pin the catalog-side shape. Each
// layer is independently sufficient for the portal case (design §7) — this is defense in depth, not
// the only line.
//
// ⚠ NOT WIRED into any write path by this ticket. `GrantWriteService` (the choke point this helper is
// built for) is P2-04's ticket — explicitly out of this ticket's scope (the brief forbids touching
// `principal.ts`/the reconciler/any admin controller). This file ships the helper + its teeth test so
// P2-04/P2-08/P2-12 have a single, already-tested thing to import rather than each writing their own
// ad-hoc bundle-scan.
import { BadRequestException } from "@nestjs/common";
import type { PoolClient } from "pg";

export interface NonUiGrantableKey {
  key: string;
  sensitive: boolean;
}

/**
 * Every `permissions.key` in `roleId`'s bundle that is `ui_grantable = false`. Empty array means the
 * role is fully UI-attachable. A role with NO bundle rows at all (e.g. a brand-new empty role)
 * returns `[]` — "carries nothing ungrantable" is vacuously true, matching
 * `role-bundle-completeness.db.test.ts`'s own "empty allowlist" posture elsewhere in this program;
 * an EMPTY bundle is a different concern (that guard's remit) from a NON-GRANTABLE bundle (this
 * one's).
 */
export async function nonUiGrantableKeysForRole(c: PoolClient, roleId: string): Promise<NonUiGrantableKey[]> {
  const { rows } = await c.query<{ key: string; sensitive: boolean }>(
    `SELECT p.key, p.sensitive
       FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = $1 AND p.ui_grantable = false
      ORDER BY p.key`,
    [roleId],
  );
  return rows;
}

/**
 * THE single enforcement helper (design §7, enforcement layer 1 of 3). Throws a clean 400 if
 * `roleId`'s bundle contains ANY `ui_grantable = false` permission — i.e. this role must never be
 * attachable through a UI-adjacent write path (a position's role-set; a Phase-4 custom-role
 * composition). Callers must invoke this BEFORE any write, matching this program's standing
 * discipline (`assertRoleScopeAllowed`/`assertPersonInLedScope`'s own contract) — a refusal must
 * never leave a partial row behind.
 *
 * Message carries the `not_ui_grantable` keyword so a future typed-refusal-code layer (design §8:
 * `{error, code}` with `not_ui_grantable` named explicitly as one of the codes) can grep/match on it
 * without this helper needing to depend on whatever error-shape convention that ticket lands on.
 */
export async function assertRoleUiGrantable(c: PoolClient, roleId: string, roleName?: string): Promise<void> {
  const blocked = await nonUiGrantableKeysForRole(c, roleId);
  if (blocked.length > 0) {
    const label = roleName ? `role "${roleName}"` : `role ${roleId}`;
    throw new BadRequestException(
      `not_ui_grantable: ${label} carries ${blocked.length} permission(s) that may never be attached ` +
        `through a UI-adjacent write path (a position's role-set, or a composed custom role): ` +
        `${blocked.map((b) => b.key).join(", ")}. Flipping a key's uiGrantable false->true is a ` +
        `PERMISSION-CONTRACT change requiring an owner decision line in the catalog entry (design §7c) ` +
        `— it is never fixed by widening this check.`,
    );
  }
}
