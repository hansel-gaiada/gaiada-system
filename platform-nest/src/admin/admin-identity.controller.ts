// Admin console API (Phase A): users & roles, identity links, module enablement, and the
// filtered audit read. Backs platform-ui's lib/adminData.ts contract. All paths are under
// /api and AuthGuard'd; each mutation authorizes via Cerbos and records an activity + bumps
// the target's session_version where a role/identity change must invalidate live sessions (D11).
import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException,
  Param, Patch, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withGlobal, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "../core/http";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";

const SCOPE_TYPES = new Set(["global", "company", "team", "project", "record"]);

interface RoleGrantRow {
  grantId: string;
  user_id: string;
  role: string;
  scopeType: string;
  scopeId: string | null;
}

/** Member user_ids of a tenant (RLS-bound). Resets the possibly-stale principal_user_id GUC
 *  before the read, exactly like CoreController.members. */
async function memberIds(tenantId: string): Promise<string[]> {
  const rows = await withTenants([tenantId], async (c) => {
    await c.query("SELECT set_config('app.principal_user_id', NULL, true)");
    return c.query<{ user_id: string }>(
      `SELECT user_id FROM company_memberships WHERE deleted_at IS NULL AND status = 'active'`,
    );
  });
  return rows.rows.map((r) => r.user_id);
}

/** D11: a role/identity change on a user must cut their live sessions. */
async function bumpSession(userId: string): Promise<void> {
  await withGlobal((c) =>
    c.query(`UPDATE users SET session_version = session_version + 1, updated_at = now() WHERE id = $1`, [userId]),
  );
}

@Controller("api")
@UseGuards(AuthGuard)
export class AdminIdentityController {
  // ---- Roles catalog (global; feeds the assign-role picker) ----
  @Get("roles")
  async roles(@Req() req: FastifyRequest) {
    const elevated = req.principal.roles.some(
      (r) =>
        (r.role === "platform_admin" && r.scopeType === "global") ||
        r.role === "company_admin" ||
        r.role === "manager",
    );
    if (!elevated) throw new NotFoundException(); // no data leak; UI degrades on 404
    const rows = await withGlobal((c) =>
      c.query(`SELECT id, name, company_id FROM roles ORDER BY company_id NULLS FIRST, name`),
    );
    return rows.rows;
  }

  // ---- Users with their role grants ----
  @Get(":tenantId/users")
  async users(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "user", tenantId }, "read");
    const members = await withTenants([tenantId], async (c) => {
      await c.query("SELECT set_config('app.principal_user_id', NULL, true)");
      return c.query<{ id: string; name: string; email: string; title: string | null; status: string }>(
        `SELECT u.id, u.name, u.email, u.title, u.status
         FROM company_memberships m JOIN users u ON u.id = m.user_id
         WHERE m.deleted_at IS NULL AND u.deleted_at IS NULL ORDER BY u.name`,
      );
    });
    const ids = members.rows.map((m) => m.id);
    const grants = ids.length
      ? await withGlobal((c) =>
          c.query<RoleGrantRow>(
            `SELECT ur.id AS "grantId", ur.user_id, r.name AS role,
                    ur.scope_type AS "scopeType", ur.scope_id AS "scopeId"
             FROM user_roles ur JOIN roles r ON r.id = ur.role_id
             WHERE ur.user_id = ANY($1::uuid[])`,
            [ids],
          ),
        )
      : { rows: [] as RoleGrantRow[] };
    const byUser = new Map<string, RoleGrantRow[]>();
    for (const g of grants.rows) {
      const list = byUser.get(g.user_id) ?? [];
      list.push(g);
      byUser.set(g.user_id, list);
    }
    return members.rows.map((m) => ({
      id: m.id,
      name: m.name,
      email: m.email,
      title: m.title,
      status: m.status,
      roles: (byUser.get(m.id) ?? []).map((g) => ({
        grantId: g.grantId,
        role: g.role,
        scopeType: g.scopeType,
        scopeId: g.scopeId,
      })),
    }));
  }

  // ---- Invite / onboard a user into this company ----
  // Creates the global user record (or reuses an existing one by email), adds a company
  // membership, and optionally grants an initial role at company scope. Emits `user.invited`.
  @Post(":tenantId/users")
  @HttpCode(201)
  async inviteUser(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { name?: string; email?: string; title?: string | null; roleId?: string },
  ) {
    const name = body?.name?.trim();
    const email = body?.email?.trim().toLowerCase();
    if (!name || !email) throw new BadRequestException("name and email required");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BadRequestException("invalid email");
    await authorize(req.principal, { kind: "user", tenantId }, "create");

    if (body?.roleId) {
      const role = await withGlobal((c) => c.query(`SELECT 1 FROM roles WHERE id = $1`, [body.roleId]));
      if (!role.rows[0]) throw new BadRequestException("unknown role");
    }

    // Reuse an existing global user by email (invite an existing person into another company)
    // or provision a new one. users.email is UNIQUE.
    const userId = await withGlobal(async (c) => {
      const existing = await c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`, [email]);
      if (existing.rows[0]) return existing.rows[0].id;
      const id = newId();
      await c.query(
        `INSERT INTO users (id, email, name, title, origin_site) VALUES ($1, $2, $3, $4, $5)`,
        [id, email, name, body?.title ?? null, config.originSite],
      );
      return id;
    });

    await withTenants([tenantId], async (c) => {
      await c.query(
        `INSERT INTO company_memberships (id, tenant_id, user_id, origin_site) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = 'active', deleted_at = NULL`,
        [newId(), tenantId, userId, config.originSite],
      );
      await emitEvent(c, tenantId, "user", userId, "user.invited", { email, name });
    });

    if (body?.roleId) {
      await withGlobal((c) =>
        c.query(
          `INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1, $2, $3, 'company', $4)
           ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING`,
          [newId(), userId, body.roleId, tenantId],
        ),
      );
      await bumpSession(userId);
    }
    await writeActivity(tenantId, req.principal.userId, "user.invited", "user", userId, { email });
    return { id: userId };
  }

  // ---- Edit a member's profile / (de)activate them ----
  @Patch(":tenantId/users/:userId")
  @HttpCode(200)
  async updateUser(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Body() b: { name?: string; title?: string | null; status?: string },
  ) {
    await authorize(req.principal, { kind: "user", id: userId, tenantId }, "update");
    if (!(await memberIds(tenantId)).includes(userId)) {
      throw new NotFoundException("user is not a member of this company");
    }
    const nothing = b?.name === undefined && b?.title === undefined && b?.status === undefined;
    if (nothing) throw new BadRequestException("nothing to update");
    const deactivating = b?.status !== undefined && b.status !== "active";
    await withGlobal((c) =>
      c.query(
        `UPDATE users SET name = COALESCE($2, name), title = COALESCE($3, title),
           status = COALESCE($4, status), updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL`,
        [userId, b?.name ?? null, b?.title ?? null, b?.status ?? null],
      ),
    );
    // Reflect (de)activation on the tenant membership too, and cut live sessions (D11).
    if (b?.status !== undefined) {
      await withTenants([tenantId], (c) =>
        c.query(`UPDATE company_memberships SET status = $2, updated_at = now() WHERE user_id = $1`, [userId, b.status]),
      );
      if (deactivating) await bumpSession(userId);
    }
    await writeActivity(tenantId, req.principal.userId, "updated", "user", userId, { status: b?.status });
    return { ok: true };
  }

  // ---- Assign a role grant ----
  @Post(":tenantId/users/:userId/roles")
  @HttpCode(201)
  async assignRole(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Body() body: { roleId?: string; scopeType?: string; scopeId?: string | null },
  ) {
    const { roleId, scopeType } = body ?? {};
    if (!roleId || !scopeType) throw new BadRequestException("roleId and scopeType required");
    if (!SCOPE_TYPES.has(scopeType)) throw new BadRequestException("invalid scopeType");
    await authorize(req.principal, { kind: "user", tenantId }, "create");
    if (!(await memberIds(tenantId)).includes(userId)) {
      throw new NotFoundException("user is not a member of this company");
    }
    const role = await withGlobal((c) => c.query(`SELECT 1 FROM roles WHERE id = $1`, [roleId]));
    if (!role.rows[0]) throw new BadRequestException("unknown role");
    const scopeId = scopeType === "global" ? null : body.scopeId ?? (scopeType === "company" ? tenantId : null);
    const id = newId();
    const inserted = await withGlobal((c) =>
      c.query<{ id: string }>(
        `INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING RETURNING id`,
        [id, userId, roleId, scopeType, scopeId],
      ),
    );
    const grantId =
      inserted.rows[0]?.id ??
      (
        await withGlobal((c) =>
          c.query<{ id: string }>(
            `SELECT id FROM user_roles WHERE user_id = $1 AND role_id = $2 AND scope_type = $3
             AND scope_id IS NOT DISTINCT FROM $4`,
            [userId, roleId, scopeType, scopeId],
          ),
        )
      ).rows[0]?.id;
    await bumpSession(userId);
    await writeActivity(tenantId, req.principal.userId, "role.assigned", "user", userId, { roleId, scopeType, scopeId });
    return { grantId };
  }

  // ---- Revoke a role grant ----
  @Delete(":tenantId/users/:userId/roles/:grantId")
  async revokeRole(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("grantId") grantId: string,
  ) {
    await authorize(req.principal, { kind: "user", tenantId }, "delete");
    const res = await withGlobal((c) =>
      c.query(`DELETE FROM user_roles WHERE id = $1 AND user_id = $2 RETURNING id`, [grantId, userId]),
    );
    if (res.rowCount === 0) throw new NotFoundException("grant not found");
    await bumpSession(userId);
    await writeActivity(tenantId, req.principal.userId, "role.revoked", "user", userId, { grantId });
    return { revoked: true };
  }

  // ---- Identity links (list / verify / unlink) ----
  @Get(":tenantId/identity-links")
  async identityLinks(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "identity_link", tenantId }, "read");
    const ids = await memberIds(tenantId);
    if (!ids.length) return [];
    const rows = await withGlobal((c) =>
      c.query(
        `SELECT il.id, il.user_id, u.name AS user_name, il.provider, il.external_id, il.verified_at
         FROM identity_links il JOIN users u ON u.id = il.user_id
         WHERE il.user_id = ANY($1::uuid[]) ORDER BY u.name, il.provider`,
        [ids],
      ),
    );
    return rows.rows;
  }

  @Post(":tenantId/identity-links/:linkId/verify")
  @HttpCode(200)
  async verifyLink(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("linkId") linkId: string,
  ) {
    await authorize(req.principal, { kind: "identity_link", tenantId }, "update");
    const ids = await memberIds(tenantId);
    const res = await withGlobal((c) =>
      c.query(
        `UPDATE identity_links SET verified_at = now()
         WHERE id = $1 AND user_id = ANY($2::uuid[]) RETURNING user_id`,
        [linkId, ids],
      ),
    );
    if (res.rowCount === 0) throw new NotFoundException("identity link not found");
    await writeActivity(tenantId, req.principal.userId, "identity.verified", "identity_link", linkId);
    return { verified: true };
  }

  @Delete(":tenantId/identity-links/:linkId")
  async unlink(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("linkId") linkId: string,
  ) {
    await authorize(req.principal, { kind: "identity_link", tenantId }, "delete");
    const ids = await memberIds(tenantId);
    const res = await withGlobal((c) =>
      c.query(`DELETE FROM identity_links WHERE id = $1 AND user_id = ANY($2::uuid[]) RETURNING id`, [linkId, ids]),
    );
    if (res.rowCount === 0) throw new NotFoundException("identity link not found");
    await writeActivity(tenantId, req.principal.userId, "identity.unlinked", "identity_link", linkId);
    return { unlinked: true };
  }

  // ---- Module enablement toggle (companies.enabled_modules) ----
  @Patch(":tenantId/company/modules")
  @HttpCode(200)
  async setModule(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { module?: string; enabled?: boolean },
  ) {
    const { module, enabled } = body ?? {};
    if (!module || typeof enabled !== "boolean") throw new BadRequestException("module and enabled required");
    await authorize(req.principal, { kind: "company", id: tenantId, tenantId }, "update");
    const res = await withGlobal((c) =>
      c.query(
        enabled
          ? `UPDATE companies SET enabled_modules = array_append(array_remove(enabled_modules, $2), $2),
               updated_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING enabled_modules`
          : `UPDATE companies SET enabled_modules = array_remove(enabled_modules, $2),
               updated_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING enabled_modules`,
        [tenantId, module],
      ),
    );
    if (res.rowCount === 0) throw new NotFoundException("company not found");
    await writeActivity(tenantId, req.principal.userId, enabled ? "module.enabled" : "module.disabled", "company", tenantId, { module });
    return { module, enabled, enabledModules: res.rows[0].enabled_modules };
  }

  // ---- Filtered audit read (activities feed, admin surface) ----
  @Get(":tenantId/audit")
  async audit(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("verb") verb?: string,
    @Query("actorId") actorId?: string,
    @Query("entityType") entityType?: string,
    @Query("since") since?: string,
    @Query("until") until?: string,
    @Query("limit") limit?: string,
  ) {
    await authorize(req.principal, { kind: "activity", tenantId }, "read");
    const lim = Math.max(1, Math.min(Number(limit ?? 50) || 50, 500));
    // RLS already scopes rows to the tenant; these are just optional narrowing filters.
    const clauses: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, op: string, val: unknown) => {
      params.push(val);
      clauses.push(`${col} ${op} $${params.length}`);
    };
    if (verb) add("a.verb", "=", verb);
    if (actorId) add("a.actor_id", "=", actorId);
    if (entityType) add("a.target_entity_type", "=", entityType);
    if (since) add("a.occurred_at", ">=", since);
    if (until) add("a.occurred_at", "<=", until);
    params.push(lim);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT a.id, a.actor_id, u.name AS actor_name, a.verb, a.target_entity_type,
                a.target_entity_id, a.occurred_at, a.metadata
         FROM activities a LEFT JOIN users u ON u.id = a.actor_id
         ${where}
         ORDER BY a.occurred_at DESC LIMIT $${params.length}`,
        params,
      ),
    );
    return rows.rows;
  }
}
