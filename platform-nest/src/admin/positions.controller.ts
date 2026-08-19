// P2-12 (backend half) — positions CRUD, the role-set composer, and the assign/unassign path.
//
// Design: docs/superpowers/plans/2026-08-13-iam-phase2-design.md §2.2/§2.3 (the seat + its role-set
// template), §4.1 (HR creates/retires positions; dept head assigns within their subtree), §3.3
// (orphaned positions), §7 (the ui_grantable allow-list).
//
// ── WHY THIS EXISTS NOW, BEFORE ITS UI ─────────────────────────────────────────────────────────
// Until this file, `positions` and `position_roles` had NO HTTP surface at all: a seat could only be
// created with raw SQL, which meant P2-06's joiner/mover/leaver flows were unreachable in any real
// environment (you cannot hire someone into a position nobody can create). P2-06's own tests insert
// positions directly for exactly that reason. This closes that gap on the server side; the admin UI
// is still P2-12's frontend half.
//
// ── THE THREE LAYERS THAT BOUND A ROLE-SET, AND WHY THE UI IS NEVER THE FILTER ──────────────────
// Attaching a role to a position is the write that turns "a seat" into "authority". It is bounded by:
//   1. Cerbos — `position · create/update/retire` (company_admin + hr_people_ops).
//   2. `assertRoleUiGrantable()` (P2-03) — the role must carry no key marked `uiGrantable:false`.
//      Enforced HERE, server-side, before the insert.
//   3. `position_roles_guard()` (0109 §2.3) — the denied-role registry (`platform_admin`,
//      `group_executive`, `client`, `owner`) and the scope-shape check, as a DB trigger.
// (2) and (3) overlap deliberately: (2) gives a readable typed refusal, (3) is the structural
// backstop that holds even against a direct SQL writer. A refusal from either is a 400, never a
// filtered-out option — `GET /positions/attachable-roles` exists so the UI can render the same set,
// but the UI is a convenience over the server's answer, never the enforcement.
import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch,
  Post, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { newId, withGlobal, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "../core/http";
import { check } from "../rbac/cerbos";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";
import { loadUnitAncestors, loadUnitDescendants } from "../core/org-unit-closure";
import { assertRoleUiGrantable, nonUiGrantableKeysForRole } from "../rbac/ui-grantable";
import { reconcileUser, reconcilePosition } from "./position-reconciler";

const SCOPE_KINDS = new Set(["company", "own_unit"]);

interface PositionRecord {
  id: string;
  tenant_id: string;
  unit_node_id: string;
  title: string;
  is_lead: boolean;
  status: string;
  created_at: string;
  updated_at: string;
}

async function loadPositionRow(c: PoolClient, tenantId: string, positionId: string): Promise<PositionRecord> {
  const { rows } = await c.query<PositionRecord>(
    `SELECT * FROM positions WHERE tenant_id = $1 AND id = $2`,
    [tenantId, positionId],
  );
  if (!rows[0]) throw new NotFoundException("position not found");
  return rows[0];
}

function shape(p: PositionRecord, roles: { roleId: string; role: string; scopeKind: string }[], holders: number) {
  return {
    id: p.id,
    tenantId: p.tenant_id,
    unitNodeId: p.unit_node_id,
    title: p.title,
    isLead: p.is_lead,
    status: p.status,
    // §3.3: a position whose unit node has been deleted from the org blob is ORPHANED — the
    // reconciler FREEZES those users' grants rather than tearing them down, so the state must be
    // visible wherever positions are listed, not only in a sweep report.
    orphaned: p.status === "orphaned",
    roleSet: roles,
    currentHolders: holders,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

@Controller("api")
@UseGuards(AuthGuard)
export class PositionsController {
  // ─────────────────────────────── reads ───────────────────────────────

  /** Tenant-wide for company_admin/HR; an `org_unit_lead` sees only their own subtree.
   *
   *  The subtree narrowing is applied to the RESULT SET, not left to Cerbos: `position · read` is a
   *  per-resource decision over `unitAncestors`, and a LIST cannot pass one resource. Asking Cerbos
   *  per row would be N round-trips; instead the caller's own `org_unit_lead` grants are expanded
   *  through the closure table (the SAME containment Cerbos's derived role computes) and used as a
   *  filter. Reach itself is still decided by Cerbos — see the two probes below. */
  @Get(":tenantId/positions")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    // ⚠ NOT `authorize(..., {kind:"position", tenantId}, "read")`. That is a resource with NO
    // `unitAncestors`, and `org_unit_lead`'s condition is `g.scopeId in resource.attr.unitAncestors`
    // — so an empty list can never match, and a dept-head-only caller would be refused the list they
    // are precisely the intended reader of. Caught by this file's own dept-head case (403 where 200
    // was expected). This is the "rule a handler can never satisfy" shape, arriving from the handler
    // side for once: the policy was right and the CALL was unsatisfiable.
    //
    // So the decision is made twice, both times by Cerbos, never by hand-rolled role logic:
    //   1. tenant-wide? (empty ancestry — only the scope-only tiers can pass)
    //   2. failing that, does ANY of the caller's own lead units pass? If so they are a dept head and
    //      the result set is narrowed to the union of those subtrees.
    // Neither ⇒ a real 403, never a silently empty list.
    const leadUnits = req.principal.roles
      .filter((g) => g.role === "org_unit_lead" && g.scopeType === "org_unit" && !!g.scopeId)
      .map((g) => g.scopeId!);
    const tenantWide = await check(req.principal, { kind: "position", tenantId, unitAncestors: [] }, "read");
    if (!tenantWide.allow) {
      const perUnit = await Promise.all(
        leadUnits.map((u) => check(req.principal, { kind: "position", tenantId, unitAncestors: [u] }, "read")),
      );
      if (!perUnit.some((d) => d.allow)) {
        // Route it through authorize() so the refusal is audited exactly like every other denial,
        // with a resource shape that reflects what was actually asked.
        await authorize(req.principal, { kind: "position", tenantId, unitAncestors: leadUnits }, "read");
      }
    }

    const out = await withTenants([tenantId], async (c) => {
      let visibleUnits: string[] | null = null;
      if (!tenantWide.allow) {
        // Only a lead grant got them here, so narrow to the union of their subtrees.
        const sets = await Promise.all(leadUnits.map((u) => loadUnitDescendants(c, tenantId, u)));
        visibleUnits = Array.from(new Set(sets.flat().concat(leadUnits)));
      }
      const { rows } = await c.query<PositionRecord>(
        `SELECT * FROM positions
          WHERE tenant_id = $1
            AND ($2::text[] IS NULL OR unit_node_id = ANY($2::text[]))
          ORDER BY unit_node_id, title`,
        [tenantId, visibleUnits],
      );
      const roleRows = await c.query<{ position_id: string; role_id: string; role: string; scope_kind: string }>(
        `SELECT pr.position_id, pr.role_id, r.name AS role, pr.scope_kind
           FROM position_roles pr JOIN roles r ON r.id = pr.role_id
          WHERE pr.tenant_id = $1`,
        [tenantId],
      );
      const holderRows = await c.query<{ position_id: string; n: string }>(
        `SELECT position_id, count(*)::text AS n FROM position_assignments
          WHERE tenant_id = $1 AND valid_to IS NULL GROUP BY position_id`,
        [tenantId],
      );
      return { rows, roleRows: roleRows.rows, holderRows: holderRows.rows };
    });

    const rolesByPosition = new Map<string, { roleId: string; role: string; scopeKind: string }[]>();
    for (const r of out.roleRows) {
      const list = rolesByPosition.get(r.position_id) ?? [];
      list.push({ roleId: r.role_id, role: r.role, scopeKind: r.scope_kind });
      rolesByPosition.set(r.position_id, list);
    }
    const holders = new Map(out.holderRows.map((h) => [h.position_id, Number(h.n)]));
    return {
      positions: out.rows.map((p) => shape(p, rolesByPosition.get(p.id) ?? [], holders.get(p.id) ?? 0)),
      scope: tenantWide.allow ? "tenant" : "subtree",
    };
  }

  /** The composer's option list: every role that MAY be attached, with the refused ones and their
   *  reason. Returned rather than filtered so the UI can show *why* a role is unavailable — a
   *  silently missing option is how the allow-list becomes folklore. */
  @Get(":tenantId/positions/attachable-roles")
  async attachableRoles(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "position", tenantId }, "read");
    const DENIED_REGISTRY = ["platform_admin", "group_executive", "client", "owner"];
    const rows = await withGlobal(async (c) => {
      const { rows: roles } = await c.query<{ id: string; name: string; company_id: string | null }>(
        `SELECT id, name, company_id FROM roles WHERE company_id IS NULL OR company_id = $1 ORDER BY name`,
        [tenantId],
      );
      const out: { roleId: string; role: string; attachable: boolean; reason: string | null }[] = [];
      for (const r of roles) {
        if (DENIED_REGISTRY.includes(r.name)) {
          out.push({ roleId: r.id, role: r.name, attachable: false, reason: "denied_role_registry" });
          continue;
        }
        const blocked = await nonUiGrantableKeysForRole(c, r.id);
        out.push({
          roleId: r.id,
          role: r.name,
          attachable: blocked.length === 0,
          reason: blocked.length ? `not_ui_grantable: ${blocked.map((b) => b.key).join(", ")}` : null,
        });
      }
      return out;
    });
    return { roles: rows };
  }

  // ─────────────────────────────── writes ───────────────────────────────

  @Post(":tenantId/positions")
  @HttpCode(201)
  async create(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { unitNodeId?: string; title?: string; isLead?: boolean; roles?: { roleId?: string; scopeKind?: string }[] },
  ) {
    const unitNodeId = body?.unitNodeId?.trim();
    const title = body?.title?.trim();
    if (!unitNodeId || !title) throw new BadRequestException("unitNodeId and title required");
    await authorize(req.principal, { kind: "position", tenantId }, "create");

    const positionId = newId();
    await withTenants([tenantId], async (c) => {
      // The unit must exist in THIS tenant's org tree. Creating a seat against a node that is not in
      // the blob would produce a position that is orphaned from birth (§3.3) — refuse instead.
      const ancestors = await loadUnitAncestors(c, tenantId, unitNodeId);
      if (ancestors.length === 0) {
        throw new BadRequestException(
          `unitNodeId "${unitNodeId}" is not a node in this company's org structure (set the org chart first)`,
        );
      }
      await c.query(
        `INSERT INTO positions (id, tenant_id, unit_node_id, title, is_lead, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [positionId, tenantId, unitNodeId, title.slice(0, 120), body?.isLead === true, config.originSite],
      );
      for (const entry of body?.roles ?? []) {
        await this.attachRoleRow(c, tenantId, positionId, entry);
      }
      await emitEvent(c, tenantId, "position", positionId, "position.created", { unitNodeId, title });
    });
    await writeActivity(tenantId, req.principal.userId, "created", "position", positionId);
    return { id: positionId, tenantId, unitNodeId, title, isLead: body?.isLead === true, status: "active" };
  }

  @Patch(":tenantId/positions/:positionId")
  async update(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("positionId") positionId: string,
    @Body() body: { title?: string; isLead?: boolean; unitNodeId?: string },
  ) {
    await authorize(req.principal, { kind: "position", tenantId }, "update");
    const moved = await withTenants([tenantId], async (c) => {
      await loadPositionRow(c, tenantId, positionId);
      if (body?.unitNodeId !== undefined) {
        const ancestors = await loadUnitAncestors(c, tenantId, body.unitNodeId);
        if (ancestors.length === 0) {
          throw new BadRequestException(`unitNodeId "${body.unitNodeId}" is not a node in this company's org structure`);
        }
      }
      await c.query(
        `UPDATE positions SET
           title        = COALESCE($3, title),
           is_lead      = COALESCE($4, is_lead),
           unit_node_id = COALESCE($5, unit_node_id),
           updated_at   = now()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, positionId, body?.title?.trim() || null, body?.isLead ?? null, body?.unitNodeId ?? null],
      );
      await emitEvent(c, tenantId, "position", positionId, "position.updated", {
        unitNodeId: body?.unitNodeId ?? null,
      });
      return body?.unitNodeId !== undefined;
    });
    // Moving a seat to another unit changes what an `own_unit` role-set entry resolves to, so every
    // holder must be re-diffed. `reconcilePosition` fans out to exactly this position's holders.
    if (moved) await reconcilePosition(tenantId, positionId);
    await writeActivity(tenantId, req.principal.userId, "updated", "position", positionId);
    return { ok: true, reconciled: moved };
  }

  /** Retire: the seat stops conferring anything. Open assignments are CLOSED here (rather than left
   *  dangling) because `collectDesired()` filters on `p.status = 'active'` — leaving them open would
   *  make the reconciler drop the grants while the assignment row still claimed the person held the
   *  seat, which is the kind of half-state the drift sweep then reports forever. */
  @Post(":tenantId/positions/:positionId/retire")
  @HttpCode(200)
  async retire(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("positionId") positionId: string,
  ) {
    await authorize(req.principal, { kind: "position", tenantId }, "retire");
    const affected = await withTenants([tenantId], async (c) => {
      await loadPositionRow(c, tenantId, positionId);
      const holders = (
        await c.query<{ id: string; user_id: string }>(
          `SELECT id, user_id FROM position_assignments
            WHERE tenant_id = $1 AND position_id = $2 AND valid_to IS NULL`,
          [tenantId, positionId],
        )
      ).rows;
      for (const h of holders) {
        await c.query(`UPDATE position_assignments SET valid_to = current_date WHERE id = $1`, [h.id]);
        await emitEvent(c, tenantId, "position_assignment", h.id, "position_assignment.closed", {
          positionId, userId: h.user_id, reason: "position_retired",
        });
      }
      await c.query(
        `UPDATE positions SET status = 'retired', updated_at = now() WHERE tenant_id = $1 AND id = $2`,
        [tenantId, positionId],
      );
      await emitEvent(c, tenantId, "position", positionId, "position.retired", { holders: holders.length });
      return holders.map((h) => h.user_id);
    });
    for (const userId of Array.from(new Set(affected))) await reconcileUser(tenantId, userId);
    await writeActivity(tenantId, req.principal.userId, "retired", "position", positionId);
    return { ok: true, closedHolders: affected.length };
  }

  // ─────────────────────── the role-set composer ───────────────────────

  @Post(":tenantId/positions/:positionId/roles")
  @HttpCode(201)
  async attachRole(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("positionId") positionId: string,
    @Body() body: { roleId?: string; scopeKind?: string },
  ) {
    await authorize(req.principal, { kind: "position", tenantId }, "update");
    const affected = await withTenants([tenantId], async (c) => {
      await loadPositionRow(c, tenantId, positionId);
      await this.attachRoleRow(c, tenantId, positionId, body ?? {});
      await emitEvent(c, tenantId, "position", positionId, "position.roles_changed", {
        added: body?.roleId, scopeKind: body?.scopeKind ?? "company",
      });
      const { rows } = await c.query<{ user_id: string }>(
        `SELECT DISTINCT user_id FROM position_assignments
          WHERE tenant_id = $1 AND position_id = $2 AND valid_to IS NULL`,
        [tenantId, positionId],
      );
      return rows.map((r) => r.user_id);
    });
    for (const userId of affected) await reconcileUser(tenantId, userId);
    await writeActivity(tenantId, req.principal.userId, "updated", "position", positionId, { attached: body?.roleId });
    return { ok: true, reconciledHolders: affected.length };
  }

  @Delete(":tenantId/positions/:positionId/roles/:roleId")
  @HttpCode(200)
  async detachRole(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("positionId") positionId: string,
    @Param("roleId") roleId: string,
  ) {
    await authorize(req.principal, { kind: "position", tenantId }, "update");
    const affected = await withTenants([tenantId], async (c) => {
      await loadPositionRow(c, tenantId, positionId);
      const { rowCount } = await c.query(
        `DELETE FROM position_roles WHERE tenant_id = $1 AND position_id = $2 AND role_id = $3`,
        [tenantId, positionId, roleId],
      );
      if (!rowCount) throw new NotFoundException("role is not attached to this position");
      await emitEvent(c, tenantId, "position", positionId, "position.roles_changed", { removed: roleId });
      const { rows } = await c.query<{ user_id: string }>(
        `SELECT DISTINCT user_id FROM position_assignments
          WHERE tenant_id = $1 AND position_id = $2 AND valid_to IS NULL`,
        [tenantId, positionId],
      );
      return rows.map((r) => r.user_id);
    });
    // Detaching is the direction that REVOKES, so the reconcile is what makes it real — without it
    // the template says one thing and the live grants another until the next sweep.
    for (const userId of affected) await reconcileUser(tenantId, userId);
    await writeActivity(tenantId, req.principal.userId, "updated", "position", positionId, { detached: roleId });
    return { ok: true, reconciledHolders: affected.length };
  }

  // ─────────────────────── assign / unassign (the dept-head path) ───────────────────────

  @Post(":tenantId/positions/:positionId/assign")
  @HttpCode(201)
  async assign(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("positionId") positionId: string,
    @Body() body: { userId?: string; validFrom?: string; reason?: string },
  ) {
    const userId = body?.userId?.trim();
    if (!userId) throw new BadRequestException("userId required");
    const prep = await withTenants([tenantId], async (c) => {
      const position = await loadPositionRow(c, tenantId, positionId);
      if (position.status !== "active") {
        throw new BadRequestException(`position is ${position.status}; only an active position may be assigned`);
      }
      return { position, ancestors: await loadUnitAncestors(c, tenantId, position.unit_node_id) };
    });
    // `targetUserId` is what makes `resource_position.yaml`'s self-assign DENY fire — nobody assigns
    // themselves to a seat through this surface, superadmin included.
    await authorize(
      req.principal,
      { kind: "position", id: positionId, tenantId, targetUserId: userId, unitAncestors: prep.ancestors },
      "assign",
    );

    // ⚠ OWNER END-STATE (§11.2, ruled 2026-08-18): a DEPT HEAD's assignment is a REQUEST, not a write.
    // HR and company_admin place people directly; a lead proposes and someone senior agrees.
    //
    // The distinction is drawn by asking Cerbos the same question with NO ancestry: only the
    // tenant-wide tiers (company_admin, hr_people_ops) can pass that, because `org_unit_lead`'s rule
    // matches on subtree containment. So a caller who needed their ancestry to get here is a dept head.
    //
    // This flip was deliberately deferred until P2-08 part B existed — removing a working capability
    // with nothing in its place would have been the worse outcome, so direct assign stayed live until
    // the request path could receive it.
    const tenantWide = await check(
      req.principal,
      { kind: "position", id: positionId, tenantId, targetUserId: userId, unitAncestors: [] },
      "assign",
    );
    if (!tenantWide.allow) {
      throw new BadRequestException(
        `assignment_request_required: a department head proposes a placement rather than writing it. ` +
          `POST /api/${tenantId}/positions/${positionId}/assignment-requests with a justification — it ` +
          `goes to HR or a company administrator, and the seat opens when they approve.`,
      );
    }

    const assignmentId = await withTenants([tenantId], async (c) => {
      const member = await c.query<{ user_id: string }>(
        `SELECT user_id FROM company_memberships
          WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' AND deleted_at IS NULL`,
        [tenantId, userId],
      );
      if (!member.rows[0]) {
        throw new BadRequestException("user is not an active member of this company; hire them first");
      }
      const open = await c.query<{ id: string }>(
        `SELECT id FROM position_assignments
          WHERE tenant_id = $1 AND position_id = $2 AND user_id = $3 AND valid_to IS NULL`,
        [tenantId, positionId, userId],
      );
      if (open.rows[0]) return open.rows[0].id; // idempotent
      const id = newId();
      await c.query(
        `INSERT INTO position_assignments
           (id, tenant_id, position_id, user_id, valid_from, assigned_by, reason, origin_site)
         VALUES ($1,$2,$3,$4,COALESCE($5::date, current_date),$6,$7,$8)`,
        [id, tenantId, positionId, userId, body?.validFrom ?? null, req.principal.userId,
         body?.reason?.slice(0, 200) ?? null, config.originSite],
      );
      await emitEvent(c, tenantId, "position_assignment", id, "position_assignment.created", {
        positionId, userId,
      });
      return id;
    });
    const reconciled = await reconcileUser(tenantId, userId);
    await writeActivity(tenantId, req.principal.userId, "assigned", "position", positionId, { userId });
    return {
      ok: true, assignmentId,
      reconciled: reconciled ? { granted: reconciled.granted, revoked: reconciled.revoked } : null,
    };
  }

  @Post(":tenantId/positions/:positionId/unassign")
  @HttpCode(200)
  async unassign(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("positionId") positionId: string,
    @Body() body: { userId?: string },
  ) {
    const userId = body?.userId?.trim();
    if (!userId) throw new BadRequestException("userId required");
    const prep = await withTenants([tenantId], async (c) => {
      const position = await loadPositionRow(c, tenantId, positionId);
      return { ancestors: await loadUnitAncestors(c, tenantId, position.unit_node_id) };
    });
    await authorize(
      req.principal,
      { kind: "position", id: positionId, tenantId, unitAncestors: prep.ancestors },
      "unassign",
    );
    const closed = await withTenants([tenantId], async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `UPDATE position_assignments SET valid_to = current_date
          WHERE tenant_id = $1 AND position_id = $2 AND user_id = $3 AND valid_to IS NULL
          RETURNING id`,
        [tenantId, positionId, userId],
      );
      for (const r of rows) {
        await emitEvent(c, tenantId, "position_assignment", r.id, "position_assignment.closed", {
          positionId, userId, reason: "unassigned",
        });
      }
      return rows.map((r) => r.id);
    });
    const reconciled = await reconcileUser(tenantId, userId);
    await writeActivity(tenantId, req.principal.userId, "unassigned", "position", positionId, { userId });
    return {
      ok: true, closedAssignmentIds: closed,
      reconciled: reconciled ? { granted: reconciled.granted, revoked: reconciled.revoked } : null,
    };
  }

  /** One insert, three bounds (see the file header). Shared by `create` and `attachRole` so the
   *  allow-list check can never be present on one path and missing on the other — the drift shape
   *  that produced IAM-SEC-05 (`inviteUser` had no scope guard while `assignRole` did). */
  private async attachRoleRow(
    c: PoolClient,
    tenantId: string,
    positionId: string,
    entry: { roleId?: string; scopeKind?: string },
  ): Promise<void> {
    const roleId = entry?.roleId?.trim();
    const scopeKind = entry?.scopeKind ?? "company";
    if (!roleId) throw new BadRequestException("roleId required on every role-set entry");
    if (!SCOPE_KINDS.has(scopeKind)) throw new BadRequestException("scopeKind must be 'company' or 'own_unit'");
    const role = await withGlobal(async (g) => {
      const { rows } = await g.query<{ id: string; name: string }>(`SELECT id, name FROM roles WHERE id = $1`, [roleId]);
      if (!rows[0]) throw new BadRequestException("roleId does not resolve to a role");
      // Order matters for the MESSAGE, not for safety (both refuse): the denied-role registry is
      // checked FIRST so an attempt to attach `platform_admin` is told it is fenced, rather than
      // being handed a list of 200-odd non-UI-grantable permission keys that buries the real reason.
      // 0109's guard trigger is the structural backstop for the same registry; this is the readable
      // 400 in front of it.
      if (["platform_admin", "group_executive", "client", "owner"].includes(rows[0].name)) {
        throw new BadRequestException(
          `role "${rows[0].name}" is in the denied-role registry and can never be attached to a position ` +
            `(design §2.3/§6.3.6 — the elevated fence)`,
        );
      }
      // (2) the P2-03 allow-list, server-side and before the write.
      await assertRoleUiGrantable(g, rows[0].id, rows[0].name);
      return rows[0];
    });
    await c.query(
      `INSERT INTO position_roles (id, tenant_id, position_id, role_id, scope_kind)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (position_id, role_id, scope_kind) DO NOTHING`,
      [newId(), tenantId, positionId, roleId, scopeKind],
    );
  }
  // ─────────────────── §11.2 the dept head's assignment REQUEST ───────────────────
  //
  // Files an `automation_approvals` row (origin='iam', workflow_id='iam:position_assign') decided by
  // the same `decide_override` action as a routed override, through the same inbox, executed by the
  // same seam. A dept head cannot approve their own (structural Cerbos DENY on requester == decider).
  @Post(":tenantId/positions/:positionId/assignment-requests")
  @HttpCode(201)
  async requestAssignment(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("positionId") positionId: string,
    @Body() body: { userId?: string; justification?: string },
  ) {
    const userId = body?.userId?.trim();
    const justification = body?.justification?.trim();
    if (!userId) throw new BadRequestException("userId required");
    if (!justification) {
      throw new BadRequestException("justification required: a placement outside the normal flow needs a stated reason");
    }
    const prep = await withTenants([tenantId], async (c) => {
      const position = await loadPositionRow(c, tenantId, positionId);
      if (position.status !== "active") {
        throw new BadRequestException(`position is ${position.status}; only an active position may be requested`);
      }
      const member = await c.query<{ user_id: string }>(
        `SELECT user_id FROM company_memberships
          WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' AND deleted_at IS NULL`,
        [tenantId, userId],
      );
      if (!member.rows[0]) throw new BadRequestException("user is not an active member of this company");
      return { position, ancestors: await loadUnitAncestors(c, tenantId, position.unit_node_id) };
    });

    // The REQUESTER still needs `assign` reach — including the self-assign DENY. Requesting is not a
    // way around the subtree bound or around "nobody seats themselves"; it is only a way around the
    // fact that a lead may no longer write the row directly.
    await authorize(
      req.principal,
      { kind: "position", id: positionId, tenantId, targetUserId: userId, unitAncestors: prep.ancestors },
      "assign",
    );

    const approvalId = newId();
    await withTenants([tenantId], async (c) => {
      await c.query(
        `INSERT INTO automation_approvals
           (id, tenant_id, workflow_id, tool_name, tool_args, impact, reason, requested_by, origin, origin_site)
         VALUES ($1,$2,'iam:position_assign','iam.assignPosition',$3,'medium',$4,$5,'iam',$6)`,
        [
          approvalId, tenantId,
          JSON.stringify({ positionId, userId, reason: justification }),
          `${prep.position.title} (${prep.position.unit_node_id}) — ${justification}`,
          req.principal.userId, config.originSite,
        ],
      );
      await emitEvent(c, tenantId, "automation_approval", approvalId, "iam.assignment_requested", {
        positionId, userId, requestedBy: req.principal.userId,
      });
    });
    await writeActivity(tenantId, req.principal.userId, "requested", "position", approvalId, { userId, positionId });
    return {
      ok: true,
      approvalId,
      decideVia: `POST /api/${tenantId}/automation-approvals/${approvalId}/decide`,
    };
  }

}
