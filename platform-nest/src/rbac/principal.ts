// Principal assembly (RBAC spec §2). Assembled per request from the DB — never from
// anything a client asserts. Assurance tiers (D4, v1-lite):
//   'high'    — platform-authenticated user (IdP once it exists; dev-header behind the
//               service token today, which only trusted services hold).
//   'linked'  — resolved from a VERIFIED identity_links row (dual-proof enrollment):
//               standard in-tenant access; sensitive/bulk/cross-tenant still need 'high'.
//   'low'     — unverified link or unknown external identity: no company data at all.
import { withGlobal, withTenants } from "../db";

/** Local copy (2 lines, zero deps) rather than importing `isUuidShaped` from `core/dept-resolution.ts`:
 *  this file is the authz substrate and must not gain a dependency on a domain module. See
 *  `auditDecision` below for why a uuid shape-check is needed at all. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export type Assurance = "low" | "linked" | "high";

// HIER-1 (2026-08-10): `org_unit` added to this union — a pure WIDENING, not a narrowing swap for
// `team`/`record`. `team`/`record` are kept here on purpose even though migration 0100's DB-level
// CHECK on `user_roles.scope_type` no longer permits either: retiring them from THIS TS union is
// HIER-3's job (docs/superpowers/plans/2026-08-10-hierarchy-consolidation.md §3 W11), sequenced
// AFTER HIER-2 builds `org_unit`'s replacement role — narrowing here first would force a
// simultaneous edit of every test file that still constructs a `team`-scoped `Principal` literal
// (cerbos.test.ts, cerbos-webdev-matrix.test.ts, cerbos-permission-dual-match.test.ts,
// principal-permissions.db.test.ts, person-scope.test.ts — none of which touch the DB, so none of
// them are broken by 0100's CHECK; they would ONLY break from narrowing this type, which is not
// this ticket's mandate). The DB is authoritative on what can be STORED; this union is
// authoritative on what TypeScript will let a caller construct in memory — the two are allowed to
// diverge during the phased retirement, and 0100's shape CHECK is what actually enforces the new
// boundary at the only layer that matters for data integrity.
export interface RoleGrant {
  role: string;
  scopeType: "global" | "company" | "org_unit" | "team" | "project" | "record";
  scopeId: string | null;
}

/** IAM-03a: a single resolved (permission key, scope) a principal holds — the role→permission
 *  expansion of one `RoleGrant` via `role_permissions` (IAM-02a, migration 0094). `key` is a
 *  `permissions.key` from the catalog (migration 0093, `permission-catalog.json`), e.g.
 *  `"core.task.update"`. `scopeType`/`scopeId` are copied from the GRANT the permission was
 *  reached through — a company-scope `manager` grant yields company-scope perms at that same
 *  company, not global ones; a global-scope `platform_admin` grant yields global-scope perms.
 *  `org_unit` WAS deliberately excluded from this union pending IAM-08/HIER-1 — HIER-1 (migration
 *  0100) is that ticket, so it is added now, additively, alongside (not replacing) `team`/
 *  `record` per this file's `RoleGrant` comment just above. */
export interface PermissionGrant {
  key: string;
  scopeType: "global" | "company" | "org_unit" | "team" | "project" | "record";
  scopeId: string | null;
}

export interface Principal {
  userId: string | null; // null = unknown external identity
  assurance: Assurance;
  companies: string[]; // authorized tenant set (active memberships)
  roles: RoleGrant[];
  /** IAM-03a: STRICTLY ADDITIVE alongside `roles` — every existing call site that only reads
   *  `roles` is unaffected. Resolved from `role_permissions` (IAM-02a); NEVER contains a
   *  `class='relationship'` key (Ruling 3) — enforced twice over, see `assemblePrincipal`'s query
   *  comment and 0093's `role_permissions_reject_relationship` trigger. Nothing consumes this yet
   *  (Cerbos still matches role names; the permission-matching rewrite is IAM-04).
   *
   *  Declared OPTIONAL, not required, so this ticket touches zero files outside `src/rbac/`:
   *  ~20 existing test files across `src/rbac/`, `src/modules/reports/`, `src/modules/search/`
   *  hand-construct `Principal` literals for mocking and are owned by other work/other concurrent
   *  agents in this checkout. `assemblePrincipal()` (the one real producer) always populates it;
   *  `principalHasPermission()` below defends with `p.perms ?? []` for the synthetic literals that
   *  don't. A later ticket that starts actually depending on `perms` can tighten this to required
   *  once those call sites are updated — not this one's remit. */
  perms?: PermissionGrant[];
  sessionVersion: number; // D11
}

export const ANONYMOUS: Principal = {
  userId: null,
  assurance: "low",
  companies: [],
  roles: [],
  perms: [],
  sessionVersion: 0,
};

export async function assemblePrincipal(userId: string, assurance: Assurance): Promise<Principal | null> {
  const user = await withGlobal((c) =>
    c.query<{ id: string; status: string; session_version: number }>(
      `SELECT id, status, session_version FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    ),
  );
  if (!user.rows[0] || user.rows[0].status !== "active") return null;

  // IAM-03a: `roles` (unchanged query, unchanged shape — every existing caller keeps working) and
  // its `perms` expansion resolved in the SAME connection checkout (one extra query, not one extra
  // pool round trip) — see the IAM-03b report for the measured cost. The perms query joins through
  // `role_permissions` (IAM-02a, 0094) to the SAME `user_roles` grant row, so a permission's
  // scopeType/scopeId is always the scope the enclosing ROLE grant was made at, never invented.
  // `p.class = 'grantable'` is defense-in-depth, not the only thing preventing a relationship-class
  // leak here: 0093's `role_permissions_reject_relationship` trigger already makes it structurally
  // impossible for any of the 15 class='relationship' permissions to be a row in `role_permissions`
  // in the first place, so this WHERE clause can never actually have anything to filter out — kept
  // anyway so this query's own correctness doesn't depend on a reader remembering that fact, and so
  // a future bug that somehow got a relationship row into `role_permissions` would still be caught
  // here rather than surfacing only in the DB trigger. `SELECT DISTINCT` collapses the case where
  // two held roles grant the identical (key, scope) pair (e.g. `member` and `manager` both reaching
  // `core.task.read` at the same company scope) into one entry, and also absorbs the pre-existing
  // duplicate-global-grant defect (Finding F, migration 0092) without needing its own dedup pass.
  const { roles, perms } = await withGlobal(async (c) => {
    const rolesRes = await c.query<RoleGrant>(
      `SELECT r.name AS role, ur.scope_type AS "scopeType", ur.scope_id AS "scopeId"
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
      [userId],
    );
    const permsRes = await c.query<PermissionGrant>(
      `SELECT DISTINCT p.key AS key, ur.scope_type AS "scopeType", ur.scope_id AS "scopeId"
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE ur.user_id = $1 AND p.class = 'grantable'`,
      [userId],
    );
    return { roles: rolesRes.rows, perms: permsRes.rows };
  });

  // Memberships are RLS-protected; the dedicated principal_lookup policy exposes only
  // the rows of the user being resolved, keyed on this transaction-local setting.
  //
  // W0 — the UNION with client_contacts is what gives an external client portal contact a tenant at
  // all. `resource_portal.yaml` grants its actions to the `client` derived role gated on
  // `variables.inTenant`, and inTenant is `resource.tenantId in principal.companies`, so without this
  // a client authenticates fine and is then refused everything, with nothing to say why.
  //
  // WHY NOT A company_memberships ROW FOR CLIENTS (the alternative, deliberately rejected — see
  // migration 0072's header): only 6 of 27 non-test queries over company_memberships filter `kind`,
  // so putting clients there would have required a defensive filter at ~10 staff-listing sites and
  // left every future site free to forget, with a client contact showing up in /people and HR as an
  // employee. Keeping clients out of that table entirely makes the leak structurally impossible;
  // this UNION and `notify()` are the only two places that deliberately look at both.
  //
  // Safe because "user" — the parent of the `client` derived role — is granted by NO resource policy:
  // every grant in cerbos/policies names a concrete staff role or `client`, and derivedRoles:
  // ["client"] appears only in resource_portal.yaml. A principal whose only grant is `client`
  // therefore satisfies exactly one policy, so a tenant appearing here opens nothing else.
  //
  // client_contacts carries its own principal_lookup policy (0072 §7b) for the same reason
  // company_memberships does: this read happens BEFORE any tenant context exists, so under
  // tenant_isolation alone it would match zero rows.
  const companies = await withGlobal(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query("SELECT set_config('app.principal_user_id', $1, true)", [userId]);
      const res = await c.query<{ tenant_id: string }>(
        `SELECT m.tenant_id FROM company_memberships m
          WHERE m.user_id = $1 AND m.status = 'active' AND m.deleted_at IS NULL
         UNION
         SELECT cc.tenant_id FROM client_contacts cc
          WHERE cc.user_id = $1 AND cc.status = 'active' AND cc.deleted_at IS NULL`,
        [userId],
      );
      await c.query("COMMIT");
      return res;
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  });

  return {
    userId,
    assurance,
    companies: companies.rows.map((r) => r.tenant_id),
    roles,
    perms,
    sessionVersion: user.rows[0].session_version,
  };
}

/** IAM-03a: does `p` hold `key` in a grant that covers `scopeType`/`scopeId`? A `global`-scope
 *  grant of `key` covers every scope (global is the top of the cascade); any other grant must
 *  match the exact (scopeType, scopeId) pair it was resolved at. This does NOT resolve narrower
 *  cascades (e.g. whether a company-scope grant should also cover that company's teams/projects)
 *  — that cascade lives in Cerbos's derived-role policy conditions today (D16 PlanResources) and
 *  is deliberately left there; this only saves a future consumer the "global beats everything"
 *  special case and a linear re-scan of `perms`, not a full authorization decision. Nothing calls
 *  this yet — IAM-04's permission-matching derived roles and IAM-05a's `can()` are the intended
 *  consumers. */
export function principalHasPermission(
  p: Principal,
  key: string,
  scopeType: PermissionGrant["scopeType"],
  scopeId: string | null,
): boolean {
  return (p.perms ?? []).some(
    (g) => g.key === key && (g.scopeType === "global" || (g.scopeType === scopeType && g.scopeId === scopeId)),
  );
}

/** D11: sensitive paths re-check the live session version — a revoked/downgraded user
 *  is cut off immediately, not at token expiry. */
export async function sessionVersionCurrent(p: Principal): Promise<boolean> {
  if (!p.userId) return false;
  const { rows } = await withGlobal((c) =>
    c.query<{ session_version: number }>(`SELECT session_version FROM users WHERE id = $1`, [p.userId]),
  );
  return rows[0]?.session_version === p.sessionVersion;
}

/** Audit a decision into the tenant's activity feed (allow AND deny — RBAC spec §6). */
export async function auditDecision(
  tenantId: string | null,
  p: Principal,
  action: string,
  resourceKind: string,
  resourceId: string | null,
  allow: boolean,
  reason: string,
): Promise<void> {
  if (!tenantId) return; // global-scope decisions have no tenant feed (logged by caller)

  // ⚠ TR-25 BUG FIX (pre-existing, found by the person-axis parity suite). `activities
  // .target_entity_id` is `uuid` (0001_core.sql:212), but not every resource id in this codebase is a
  // uuid: an org-unit node id is FREE-FORM TEXT by the 0029 convention (`'d-web'`, `'d-hr'`), and
  // `reports.controller.ts`'s `authorizeReportDocumentRead` passes the department-grain `scopeRef`
  // straight through as `resource.id`. So a DENIED department-grain report read raised
  // `invalid input syntax for type uuid: "d-web"` INSIDE this audit write and surfaced as a bare
  // **500**, not the 403 the caller must get — violating the BFF convention (§8 hard rule 2: an
  // unauthorized read is 403, never 404, and certainly never a server error the UI cannot render a
  // limited-access state for). It went unnoticed because no test had ever asserted a DENIED
  // department-grain read; every existing case used a uuid scopeRef or was allowed.
  //
  // Fixed HERE rather than at the call site because the defect is generic — any resource kind whose id
  // is not a uuid has the same failure mode on denial, and dropping `resource.id` at the call site
  // would change what Cerbos's `manager`/`member` project-scope conditions match on
  // (`g.scopeId == request.resource.attr.id`). Nothing is lost: a non-uuid id is preserved verbatim in
  // `metadata.resourceId`, so the audit trail still names the exact resource that was denied.
  const uuidId = resourceId !== null && UUID_RE.test(resourceId) ? resourceId : null;
  const detail: Record<string, unknown> = { action, reason };
  if (resourceId !== null && uuidId === null) detail.resourceId = resourceId;

  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO activities (id, tenant_id, actor_id, verb, target_entity_type, target_entity_id, metadata, origin_site)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'authz')`,
      [
        tenantId,
        p.userId,
        allow ? "authz.allow" : "authz.deny",
        resourceKind,
        uuidId,
        JSON.stringify(detail),
      ],
    ),
  );
}
