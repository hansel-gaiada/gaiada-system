// Principal assembly (RBAC spec §2). Assembled per request from the DB — never from
// anything a client asserts. Assurance tiers (D4, v1-lite):
//   'high'    — platform-authenticated user (IdP once it exists; dev-header behind the
//               service token today, which only trusted services hold).
//   'linked'  — resolved from a VERIFIED identity_links row (dual-proof enrollment):
//               standard in-tenant access; sensitive/bulk/cross-tenant still need 'high'.
//   'low'     — unverified link or unknown external identity: no company data at all.
import { withGlobal, withTenants } from "../db";

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
  const companies = await withGlobal(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query("SELECT set_config('app.principal_user_id', $1, true)", [userId]);
      const res = await c.query<{ tenant_id: string }>(
        `SELECT m.tenant_id FROM company_memberships m
         WHERE m.user_id = $1 AND m.status = 'active' AND m.deleted_at IS NULL`,
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
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO activities (id, tenant_id, actor_id, verb, target_entity_type, target_entity_id, metadata, origin_site)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'authz')`,
      [
        tenantId,
        p.userId,
        allow ? "authz.allow" : "authz.deny",
        resourceKind,
        resourceId,
        JSON.stringify({ action, reason }),
      ],
    ),
  );
}
