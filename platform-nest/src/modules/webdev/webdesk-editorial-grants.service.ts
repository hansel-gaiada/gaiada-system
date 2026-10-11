// M5-W1b — the writers' room grant path's BFF half (docs/plans/2026-10-11-m5-writers-room-design.md §2.6). The routes are
// `webdesk-editorial-grants.controller.ts`; the MCP tools `webdesk.editorial.{listGrants,grantRole,revokeRole}` call them.
//
// What THIS file owns, and what it deliberately does not:
//   * It PROVES the site from WebDesk (the cross-company wall `resolveEditableSite`, then `collection.list` on that
//     site) and hands the proven facts to the choke point as a `VerifiedEditorialSite`. The choke point
//     (`admin/grant-write.service.ts` grantEditorialRole / revokeEditorialRole) is the ONLY writer of the grant and of
//     its scope rows, and it re-checks everything Cerbos cannot see.
//   * It writes the AUDIT row on the SAME connection as the grant, in one transaction: a grant that committed without
//     its audit row cannot exist. The row carries identifiers only (role, site, collection keys, locales, the target's
//     user id, the grant id, the expiry); never a name or an email.
//   * It bumps the target's `session_version` (D11) after a change, grant AND revoke, like role-grants.controller.ts.
//   * It never reaches WebDesk inside the database transaction: the Zone B reads come first, then one short
//     transaction. A revoke reads WebDesk not at all (a de-escalation must work while WebDesk is down, and for a site
//     WebDesk no longer lists).
import { BadGatewayException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { config } from "../../config";
import { newId, withGlobal, withTenants } from "../../db";
import { currentApproval, currentVia } from "../../core/request-context";
import type { Principal } from "../../rbac/principal";
import {
  EDITORIAL_ROLES, EditorialScopeError, isEditorialRole, normaliseEditorialScope, type EditorialRole,
  type NormalisedEditorialScope,
} from "../../rbac/editorial-roles";
import {
  grantEditorialRole, revokeEditorialRole, type VerifiedEditorialSite,
} from "../../admin/grant-write.service";
import { UUID_RE, invalidRequest, isPlainObject, strictBody, webdeskZoneB, type SiteRef, type WebdeskZoneB } from "./webdesk-content.service";

/** The POST body, strict (an unknown key is 400 `invalid_request`, AFTER authorization). */
export const EDITORIAL_GRANT_BODY_KEYS = ["userId", "role", "allCollections", "collections", "allLocales", "locales", "expiresAt"] as const;

export interface EditorialGrantRequest {
  userId: string;
  role: EditorialRole;
  scope: NormalisedEditorialScope;
  expiresAt: string | null;
}

/** Validate the POST body. PURE (unit-tested); throws the BFF's typed 400. `now` is injectable for tests. */
export function parseEditorialGrantBody(raw: unknown, now: number = Date.now()): EditorialGrantRequest {
  const b = strictBody(raw, EDITORIAL_GRANT_BODY_KEYS);
  if (typeof b.userId !== "string" || !UUID_RE.test(b.userId)) throw invalidRequest("userId must be a uuid");
  if (!isEditorialRole(b.role)) throw invalidRequest(`role must be one of ${EDITORIAL_ROLES.join(", ")}`);
  let scope: NormalisedEditorialScope;
  try {
    scope = normaliseEditorialScope(b);
  } catch (err) {
    if (err instanceof EditorialScopeError) throw invalidRequest(err.reason);
    throw err;
  }
  let expiresAt: string | null = null;
  if (b.expiresAt !== undefined && b.expiresAt !== null) {
    const t = typeof b.expiresAt === "string" ? Date.parse(b.expiresAt) : Number.NaN;
    if (!Number.isFinite(t) || t <= now) throw invalidRequest("expiresAt must be an ISO-8601 instant in the future, or null");
    expiresAt = new Date(t).toISOString();
  }
  return { userId: b.userId, role: b.role, scope, expiresAt };
}

/** The revoke route's two path params, checked AFTER authorization. PURE. */
export function parseEditorialRevokeParams(userId: string, role: string): { userId: string; role: EditorialRole } {
  if (!UUID_RE.test(userId)) throw invalidRequest("userId must be a uuid");
  if (!isEditorialRole(role)) throw invalidRequest(`role must be one of ${EDITORIAL_ROLES.join(", ")}`);
  return { userId, role };
}

/** The proof the choke point needs: the site is this company's (the wall), its collections, its tenant's locales. */
export async function verifyEditorialSite(zoneB: WebdeskZoneB, tenantId: string, site: SiteRef): Promise<VerifiedEditorialSite> {
  const { tenant } = await zoneB.resolveEditableSite(tenantId, site.tenantSlug, site.siteId);
  const r = await zoneB.read({
    command: "collection.list",
    path: "/control/v1/tenants/:tenantSlug/sites/:siteId/collections",
    params: { tenantSlug: site.tenantSlug, siteId: site.siteId },
  });
  const list = isPlainObject(r.body) && Array.isArray(r.body.collections) ? r.body.collections : null;
  if (!list) throw new BadGatewayException({ message: "webdesk_error", reason: "collection_list_shape" });
  const collectionKeys = list
    .map((c) => (isPlainObject(c) && typeof c.key === "string" ? c.key : null))
    .filter((k): k is string => k !== null);
  const locales = Array.isArray(tenant.locales) ? tenant.locales.filter((l): l is string => typeof l === "string") : [];
  return { tenantSlug: site.tenantSlug, siteId: site.siteId, collectionKeys, locales };
}

/** The audit row, on the caller's connection (same transaction as the change). Same columns and ambient stamping as
 *  `writeActivity()` (core/http.ts), which cannot join an existing transaction because it opens its own. */
async function writeEditorialAuditTx(
  c: PoolClient, tenantId: string, actorId: string | null, verb: string, grantId: string, metadata: Record<string, unknown>,
): Promise<void> {
  const via = currentVia();
  const withVia = via && metadata.via === undefined ? { ...metadata, via } : metadata;
  const appr = currentApproval();
  await c.query(
    `INSERT INTO activities (id, tenant_id, actor_id, verb, target_entity_type, target_entity_id, metadata, origin_site,
                             approved_by, approval_channel, executed_by)
     VALUES ($1, $2, $3, $4, 'user_role', $5, $6, $7, $8, $9, $10)`,
    [newId(), tenantId, actorId, verb, grantId, JSON.stringify(withVia), config.originSite,
     appr?.approvedBy ?? null, appr?.channel ?? null, appr?.executedBy ?? null],
  );
}

/** D11: a change to someone's authority cuts their live sessions. */
async function bumpSession(userId: string): Promise<void> {
  await withGlobal((c) =>
    c.query(`UPDATE users SET session_version = session_version + 1, updated_at = now() WHERE id = $1`, [userId]),
  );
}

export interface EditorialGrantView {
  grantId: string;
  userId: string;
  name: string | null;
  email: string | null;
  role: EditorialRole;
  tenantSlug: string;
  siteId: string;
  allCollections: boolean;
  collections: string[];
  allLocales: boolean;
  locales: string[];
  expiresAt: string | null;
  grantedBy: string | null;
  updatedAt: string;
}

/** Every unexpired writers' room grant with a scope row on this site, in this company. Reads ERP rows only (no WebDesk
 *  call): a list of who holds what must stay readable while WebDesk is down. */
export async function listEditorialGrants(tenantId: string, site: SiteRef): Promise<{ tenantSlug: string; siteId: string; grants: EditorialGrantView[] }> {
  if (!UUID_RE.test(site.siteId)) throw invalidRequest("siteId must be a uuid");
  const rows = await withTenants([tenantId], (c) =>
    c.query<EditorialGrantView>(
      `SELECT ur.id AS "grantId", ur.user_id AS "userId", u.name, u.email, r.name AS role,
              s.webdesk_tenant_slug AS "tenantSlug", s.site_id AS "siteId",
              s.all_collections AS "allCollections", s.collections, s.all_locales AS "allLocales", s.locales,
              ur.expires_at AS "expiresAt", s.granted_by AS "grantedBy", s.updated_at AS "updatedAt"
         FROM user_role_editorial_scopes s
         JOIN user_roles ur ON ur.id = s.user_role_id
         JOIN roles r ON r.id = ur.role_id
         JOIN users u ON u.id = ur.user_id
        WHERE s.tenant_id = $1 AND s.site_id = $2
          AND ur.scope_type = 'company' AND ur.scope_id = $1::text
          AND (ur.expires_at IS NULL OR ur.expires_at > now())
        ORDER BY u.name NULLS LAST, u.email, r.name`,
      [tenantId, site.siteId],
    ),
  );
  return { tenantSlug: site.tenantSlug, siteId: site.siteId, grants: rows.rows };
}

export interface EditorialGrantResponse {
  userId: string;
  role: EditorialRole;
  tenantSlug: string;
  siteId: string;
  grantId: string;
  allCollections: boolean;
  collections: string[];
  allLocales: boolean;
  locales: string[];
  expiresAt: string | null;
  /** False: the grant and this site's scope were already exactly as requested (no audit row, no session bump). */
  changed: boolean;
  /** True: this call created the role grant (the person's first site for this role in this company). */
  createdGrant: boolean;
}

/** Grant: the caller has ALREADY passed Cerbos `webdesk_collection:manage_editorial` (the controller's first statement). */
export async function grantEditorialRoleOnSite(
  principal: Principal, tenantId: string, site: SiteRef, req: EditorialGrantRequest, zoneB: WebdeskZoneB = webdeskZoneB,
): Promise<EditorialGrantResponse> {
  const verified = await verifyEditorialSite(zoneB, tenantId, site);
  const result = await withTenants([tenantId], async (c) => {
    const r = await grantEditorialRole(
      c,
      {
        tenantId, tenantSlug: site.tenantSlug, siteId: site.siteId, targetUserId: req.userId, role: req.role,
        scope: req.scope, expiresAt: req.expiresAt, actorUserId: principal.userId,
      },
      verified,
    );
    if (r.changed) {
      await writeEditorialAuditTx(c, tenantId, principal.userId, "webdesk.editorial.role_granted", r.grantId, {
        role: r.role, tenantSlug: site.tenantSlug, siteId: site.siteId, targetUserId: req.userId, grantId: r.grantId,
        createdGrant: r.createdGrant, allCollections: r.scope.allCollections, collections: r.scope.collections,
        allLocales: r.scope.allLocales, locales: r.scope.locales, expiresAt: r.expiresAt,
      });
    }
    return r;
  });
  if (result.changed) await bumpSession(req.userId);
  return {
    userId: req.userId, role: result.role, tenantSlug: site.tenantSlug, siteId: site.siteId, grantId: result.grantId,
    ...result.scope, expiresAt: result.expiresAt, changed: result.changed, createdGrant: result.createdGrant,
  };
}

export interface EditorialRevokeResponse {
  userId: string;
  role: EditorialRole;
  siteId: string;
  /** False: there was nothing to revoke on this site (idempotent; no audit row, no session bump). */
  changed: boolean;
  /** True: the grant itself is gone (this was its last site). */
  removedGrant: boolean;
}

/** Revoke: the caller has ALREADY passed Cerbos. No WebDesk call (see the file header). */
export async function revokeEditorialRoleOnSite(
  principal: Principal, tenantId: string, site: SiteRef, userId: string, role: EditorialRole,
): Promise<EditorialRevokeResponse> {
  if (!UUID_RE.test(site.siteId)) throw invalidRequest("siteId must be a uuid");
  const result = await withTenants([tenantId], async (c) => {
    const r = await revokeEditorialRole(c, { tenantId, siteId: site.siteId, targetUserId: userId, role });
    if (r) {
      await writeEditorialAuditTx(c, tenantId, principal.userId, "webdesk.editorial.role_revoked", r.grantId, {
        role, tenantSlug: site.tenantSlug, siteId: site.siteId, targetUserId: userId, grantId: r.grantId,
        removedScope: r.removedScope, removedGrant: r.removedGrant,
      });
    }
    return r;
  });
  if (result) await bumpSession(userId);
  return { userId, role, siteId: site.siteId, changed: result !== null, removedGrant: result?.removedGrant ?? false };
}
