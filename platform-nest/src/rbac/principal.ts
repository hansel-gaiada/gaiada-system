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

export interface RoleGrant {
  role: string;
  scopeType: "global" | "company" | "team" | "project" | "record";
  scopeId: string | null;
}

export interface Principal {
  userId: string | null; // null = unknown external identity
  assurance: Assurance;
  companies: string[]; // authorized tenant set (active memberships)
  roles: RoleGrant[];
  sessionVersion: number; // D11
}

export const ANONYMOUS: Principal = { userId: null, assurance: "low", companies: [], roles: [], sessionVersion: 0 };

export async function assemblePrincipal(userId: string, assurance: Assurance): Promise<Principal | null> {
  const user = await withGlobal((c) =>
    c.query<{ id: string; status: string; session_version: number }>(
      `SELECT id, status, session_version FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    ),
  );
  if (!user.rows[0] || user.rows[0].status !== "active") return null;

  const roles = await withGlobal((c) =>
    c.query<RoleGrant>(
      `SELECT r.name AS role, ur.scope_type AS "scopeType", ur.scope_id AS "scopeId"
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
      [userId],
    ),
  );

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
    roles: roles.rows,
    sessionVersion: user.rows[0].session_version,
  };
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
