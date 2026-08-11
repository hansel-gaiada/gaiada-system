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
import { adoptManagedGrantAsManual } from "./service-reconciler";

// HIER-1 (migration 0100): `team`/`record` removed here to match the DB's new scope_type CHECK
// exactly — leaving them would let a caller submit a value the CHECK now rejects, turning what
// used to be a valid (if inert — team/record never conferred anything reachable) grant into an
// unhandled Postgres CHECK-violation 500 instead of this endpoint's own clean 400.
//
// HIER-2 (migration 0102): `org_unit` ADDED — `org_unit_lead` now has something to do (own rules
// on `resource_report_document.yaml`'s `read_department` and `resource_appraisal.yaml`'s `read`,
// via IAM-09's closure-table ancestor cascade), so offering the scope here is no longer minting an
// inert grant. `scopeId` for this scope_type is a free-form org-unit node id (0029/0055
// convention, e.g. `'d-web'`) — NOT validated as a uuid here, matching 0100's own per-scope shape
// CHECK (`org_unit` -> non-empty text, no uuid-regex branch), unlike `company`/`project`.
const SCOPE_TYPES = new Set(["global", "company", "project", "org_unit"]);

// GLOBAL-ONLY ROLES. Their Cerbos derived roles (derived_roles.yaml) match ONLY
// `g.scopeType == "global"`, so a company- or project-scoped grant of either confers NOTHING
// through the role arm — it is inert by construction.
//
// ⚠ WHY THIS IS ENFORCED RATHER THAN LEFT INERT (found by IAM-04-ROLLOUT-B12, 2026-08-11):
// under permission matching the two arms DISAGREE about such a grant, and the permission arm is
// the permissive one. `assemblePrincipal()` resolves `perms` from `role_permissions` carrying the
// GRANT's own scope, so a `platform_admin` grant at `scopeType:"company"` yields all 215 grantable
// permissions AT THAT COMPANY — which the `perm_*` derived roles then honour, while the
// role-name arm correctly refuses. That is the permission arm granting what the role arm denies:
// exactly the class of defect the IAM-04 pilot caught for `team_lead`×`pm_task`, but arising from
// a wildcard/unconditional rule rather than same-rule mixing, so
// `permission-arm-hazard-scan.test.ts` structurally cannot see it.
//
// It was REACHABLE, not theoretical: this endpoint is authorized by `user:create`, which
// `company_admin` holds — so a company admin could mint `platform_admin@their-company` and pick up
// the ~16 permissions their own bundle lacks, in their own tenant. That also violates D-9's
// no-self-escalation safeguard. No such grant exists in any seed, fixture or live row (verified),
// so this closes the door before anyone walks through it.
//
// Enforced HERE, at the only unrestricted write path, rather than by narrowing the `perm_*` rules
// in 26+ policy files: this is one check at the source, and it makes the DB state impossible
// instead of making a bad state harmless in one consumer.
const GLOBAL_ONLY_ROLES = new Set(["platform_admin", "group_executive"]);

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
  // ---- Roles catalog (feeds the assign-role picker) ----
  //
  // `tenantId` narrows the catalog to the global roles plus the ones belonging to that company.
  // Without it the picker listed EVERY company's rows, and because per-company roles share their
  // names across companies the operator saw "manager" ten times and "company_admin" three times
  // with nothing to tell them apart — ten identical-looking options, nine of which grant a role
  // row owned by a different company. Optional (not required) so the tenant-less catalog callers
  // keep working; when passed, membership is checked so this cannot be used to enumerate the roles
  // of a company the caller has nothing to do with.
  @Get("roles")
  async roles(@Req() req: FastifyRequest, @Query("tenantId") tenantId?: string) {
    const isPlatformAdmin = req.principal.roles.some((r) => r.role === "platform_admin" && r.scopeType === "global");
    const elevated =
      isPlatformAdmin || req.principal.roles.some((r) => r.role === "company_admin" || r.role === "manager");
    if (!elevated) throw new NotFoundException(); // no data leak; UI degrades on 404
    if (tenantId && !isPlatformAdmin && !req.principal.companies.includes(tenantId)) {
      throw new NotFoundException();
    }
    const rows = await withGlobal((c) =>
      tenantId
        ? c.query(
            `SELECT id, name, company_id FROM roles
             WHERE company_id IS NULL OR company_id = $1
             ORDER BY company_id NULLS FIRST, name`,
            [tenantId],
          )
        : c.query(`SELECT id, name, company_id FROM roles ORDER BY company_id NULLS FIRST, name`),
    );
    return rows.rows;
  }

  // ---- Users with their role grants ----
  //
  // Employee-only by DEFAULT, `?includeService=1` to opt in — the same convention
  // `GET /api/:t/members` (core.controller) already uses, and for the same reason: a membership
  // with kind='service' is not a person. Non-human principals are real `users` rows on purpose
  // (an n8n workflow authenticates via its OBO envelope -> identity_link -> user -> Cerbos, so a
  // workflow that is not a user cannot be authorized at all), which means every people-shaped
  // surface has to filter them out explicitly. This endpoint did not, so the People directory
  // listed 17 automation service accounts among 19 real staff and HR headcount read 36.
  //
  // Not filtered unconditionally, because the SAME endpoint backs Settings → Users & Roles, where
  // an admin legitimately needs to see and revoke an automation account's grants. That page asks
  // for them; the directory does not. `kind` is echoed either way so callers can badge.
  @Get(":tenantId/users")
  async users(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("includeService") includeServiceRaw?: string,
  ) {
    await authorize(req.principal, { kind: "user", tenantId }, "read");
    const includeService = includeServiceRaw === "1";
    const members = await withTenants([tenantId], async (c) => {
      await c.query("SELECT set_config('app.principal_user_id', NULL, true)");
      return c.query<{ id: string; name: string; email: string; title: string | null; status: string; kind: string }>(
        `SELECT u.id, u.name, u.email, u.title, u.status, m.kind
         FROM company_memberships m JOIN users u ON u.id = m.user_id
         WHERE m.deleted_at IS NULL AND u.deleted_at IS NULL
           ${includeService ? "" : "AND m.kind = 'employee'"}
         ORDER BY u.name`,
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
      // Echoed so an admin surface that opted in can badge the row instead of presenting a
      // workflow's service account as a colleague.
      isService: m.kind === "service",
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

    // ORG-7b A14 membership-side hook (mirrors the assignRole hook below EXACTLY): if this invite
    // lands on (re-activates, or simply hits) an EXISTING company_memberships row that is
    // reconciler-managed (kind='service' AND managed_by IS NOT NULL), an admin explicitly
    // inviting/onboarding this person as an employee is a manual act that must ADOPT the row —
    // convert it to kind='employee'/managed_by=NULL and drop its service_grant_claims — so a
    // later revoke of the OWNING service assignment cannot decrement this now-doubly-intended
    // membership into deletion out from under the admin's explicit invite. Without this, inviting
    // someone who already has a live service-provided membership (e.g. an HR-served staffer being
    // hired directly by the target company) would silently leave their access hostage to a
    // service assignment they no longer need.
    let membershipToAdopt: string | null = null;
    await withTenants([tenantId], async (c) => {
      const existing = await c.query<{ id: string; kind: string; managed_by: string | null }>(
        `SELECT id, kind, managed_by FROM company_memberships WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId],
      );
      if (existing.rows[0]?.kind === "service" && existing.rows[0]?.managed_by) {
        membershipToAdopt = existing.rows[0].id;
      }
      await c.query(
        `INSERT INTO company_memberships (id, tenant_id, user_id, origin_site) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = 'active', deleted_at = NULL`,
        [newId(), tenantId, userId, config.originSite],
      );
      // invitedBy: WSD-4's onboarding auto-instantiation needs a human actor for hr_cases.created_by
      // (a NOT NULL FK) — the inviting admin is the natural author of an auto-spawned onboarding case.
      await emitEvent(c, tenantId, "user", userId, "user.invited", { email, name, invitedBy: req.principal.userId });
    });
    if (config.serviceAssignmentsEnabled && membershipToAdopt) {
      await adoptManagedGrantAsManual(tenantId, { membershipId: membershipToAdopt });
    }

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
    // Select the NAME too — needed for the global-only guard below (see GLOBAL_ONLY_ROLES).
    const role = await withGlobal((c) =>
      c.query<{ name: string }>(`SELECT name FROM roles WHERE id = $1`, [roleId]),
    );
    if (!role.rows[0]) throw new BadRequestException("unknown role");
    // GLOBAL-ONLY GUARD — see GLOBAL_ONLY_ROLES' comment for the full rationale. A scoped grant of
    // an elevated role is inert under role-name matching but resolves its FULL bundle at that scope
    // under permission matching, i.e. the permission arm granting what the role arm denies.
    if (GLOBAL_ONLY_ROLES.has(role.rows[0].name) && scopeType !== "global") {
      throw new BadRequestException(
        `role "${role.rows[0].name}" may only be granted at global scope`,
      );
    }
    // HIER-1 (migration 0100): a scoped grant with NO scopeId used to silently insert scope_id =
    // NULL for any non-company scope (the old fallback below defaulted everything but "company"
    // to null) — dead but harmless while scope_id was untyped-by-CHECK. Migration 0100's new
    // per-scope shape CHECK now REJECTS a non-global grant with a NULL scope_id (company/project
    // require a uuid-shaped value), so that same silent-null path would turn into an unhandled
    // CHECK-violation 500. Validated here instead so the caller gets this endpoint's own clean
    // 400 — "global" still forces null (client-supplied scopeId for a global grant is ignored, as
    // before); "company" still defaults to the URL's own tenantId when omitted (as before, and
    // never null in practice since tenantId is always present); any other scope now REQUIRES an
    // explicit scopeId rather than silently defaulting to null.
    let scopeId: string | null;
    if (scopeType === "global") {
      scopeId = null;
    } else if (scopeType === "company") {
      scopeId = body.scopeId ?? tenantId;
    } else {
      if (!body.scopeId) throw new BadRequestException(`scopeId required for scopeType "${scopeType}"`);
      scopeId = body.scopeId;
    }
    const id = newId();
    const inserted = await withGlobal((c) =>
      c.query<{ id: string }>(
        // UNTARGETED `ON CONFLICT DO NOTHING`, deliberately — do not "tighten" this back to a
        // column list. Migration 0092 added a PARTIAL unique index
        // (`user_roles_global_scope_uniq` on (user_id, role_id, scope_type) WHERE scope_id IS NULL)
        // to close the hole where `UNIQUE (user_id, role_id, scope_type, scope_id)` never fires for
        // global grants, because scope_id IS NULL and SQL NULLs are never equal (that hole is why
        // both live elevated accounts carried duplicate grants). A TARGETED conflict clause names
        // the 4-column constraint as its arbiter — which still does not fire on NULL scope_id — so
        // the new partial index would raise an unhandled 23505 and turn a re-grant of an
        // already-held GLOBAL role from this endpoint's graceful no-op/adopt path into a 500.
        // Untargeted arbitrates over BOTH, and the `IS NOT DISTINCT FROM` lookup below already
        // recovers the existing row correctly for NULL scope_id, so the adopt path is unchanged.
        `INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING RETURNING id`,
        [id, userId, roleId, scopeType, scopeId],
      ),
    );
    let grantId: string | undefined = inserted.rows[0]?.id;
    if (!grantId) {
      // The row already existed (ON CONFLICT DO NOTHING fired) — fetch it, and check whether it
      // is reconciler-managed. A14: an admin explicitly (re-)granting a role that collides with a
      // service-assignment-managed grant must ADOPT it as manual (clear managed_by + drop its
      // claims) here, in-band with the grant — otherwise a later revoke of the OWNING assignment
      // would decrement this now-doubly-intended row straight into deletion out from under the
      // admin's explicit grant (A2's "no coalescing" cuts both ways: a manual act must also win).
      // Reconciler-managed grants are always scope_type='company' with scope_id=<the served
      // tenant> (service-reconciler.ts), so the adoption is only attempted on that shape.
      const existing = (
        await withGlobal((c) =>
          c.query<{ id: string; managed_by: string | null }>(
            `SELECT id, managed_by FROM user_roles WHERE user_id = $1 AND role_id = $2 AND scope_type = $3
             AND scope_id IS NOT DISTINCT FROM $4`,
            [userId, roleId, scopeType, scopeId],
          ),
        )
      ).rows[0];
      grantId = existing?.id;
      if (config.serviceAssignmentsEnabled && existing?.managed_by && scopeType === "company" && scopeId) {
        await adoptManagedGrantAsManual(scopeId, { userRoleId: existing.id });
      }
    }
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
