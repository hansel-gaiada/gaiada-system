// P2-08 (part A) — the grant / revoke surface: the first HTTP door onto the `role_grant` kind.
//
// Design: docs/superpowers/plans/2026-08-13-iam-phase2-design.md §6.2 (who may grant), §6.3 (the
// seven invariants), §6.5 (overrides). Consumes P2-04's `GrantWriteService` — this file writes NO
// `user_roles` row of its own, by construction.
//
// ── WHY THIS SURFACE IS THE DANGEROUS ONE, AND WHAT ANSWERS THAT ───────────────────────────────
// Two reachable escalations shipped through grant write paths in one week (IAM-SEC-02, IAM-SEC-05),
// both because a *new* writer did not repeat an *old* writer's guard. So this controller deliberately
// owns no invariants: every refusal below is either Cerbos's (`role_grant · create/revoke`, including
// the structural self-target DENY) or the choke point's (`assertGrantAllowed` — scope validity,
// self-target, allow-list, elevated fence, ceiling). What the controller DOES own is the one thing a
// guard cannot do for itself: deriving `unitAncestors` **server-side from the closure table**, never
// from the request body (§6.3.1), because a caller-supplied ancestry is a caller-supplied
// authorization decision.
//
// ── WHAT IS DELIBERATELY NOT HERE: the routed override (§6.5) ─────────────────────────────────
// §6.3.7 says a role whose bundle carries any `sensitive`-flagged key must not be granted directly
// from the dept-head surface — it routes as an override request through the approvals inbox, decided
// with a dedicated `decide_override` action. **`decide_override` exists in neither
// `resource_automation_approval.yaml` nor the permission catalog**, and adding a literal action means
// a catalog entry + a bundles migration + re-deriving the whole parity chain — its own ticket, not a
// side effect of this one.
//
// So this surface **fails closed** instead of pretending: a sensitive-carrying role requested by a
// dept head is REFUSED with a typed `override_required` error naming the missing mechanism.
// company_admin and above are unaffected (they are not the tier §6.3.7 constrains). That is a real,
// visible gap — recorded in the P2-08 report and in PERMISSION-CONTRACT — not a silent allow.
import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Query,
  Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { withGlobal, withTenants } from "../db";
import { authorize, writeActivity } from "../core/http";
import { check } from "../rbac/cerbos";
import { AuthGuard } from "../auth/guards";
import { loadUnitAncestors } from "../core/org-unit-closure";
import { insertGrantRow, revokeGrantById } from "./grant-write.service";

/** Default override expiry, design §12 Q4 (owner recommendation: 90 days, renewable). Applied to
 *  any grant made with `expiresInDays` unset but `temporary: true`; a permanent grant needs
 *  company_admin, which Cerbos already decides. */
const DEFAULT_EXPIRY_DAYS = 90;
const MAX_EXPIRY_DAYS = 365;

/** D11: a role change on a user must cut their live sessions. */
async function bumpSession(userId: string): Promise<void> {
  await withGlobal((c) =>
    c.query(`UPDATE users SET session_version = session_version + 1, updated_at = now() WHERE id = $1`, [userId]),
  );
}

/** The target's CURRENT unit ancestry, from `org_unit_closure` — the attribute the dept-head rule
 *  matches on. Derived here, server-side, from the target's open PRIMARY org-unit membership.
 *  Returns `[]` when the target is placed nowhere, which is fail-closed: `org_unit_lead`'s
 *  containment test can never match an empty list, so an unplaced target is reachable only by
 *  company_admin/platform_admin. */
async function targetUnitAncestors(c: PoolClient, tenantId: string, targetUserId: string): Promise<string[]> {
  const { rows } = await c.query<{ unit_node_id: string }>(
    `SELECT unit_node_id FROM org_unit_memberships
      WHERE tenant_id = $1 AND user_id = $2 AND is_primary AND valid_to IS NULL
      ORDER BY valid_from DESC LIMIT 1`,
    [tenantId, targetUserId],
  );
  if (!rows[0]) return [];
  return loadUnitAncestors(c, tenantId, rows[0].unit_node_id);
}

@Controller("api")
@UseGuards(AuthGuard)
export class RoleGrantsController {
  /** Every grant a user holds that is visible in this tenant, with its provenance. `read` on the
   *  `role_grant` kind, with the target's own ancestry passed so a dept head can inspect their own
   *  people and nobody else's. */
  @Get(":tenantId/role-grants")
  async list(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("userId") userId?: string,
  ) {
    const target = userId?.trim();
    if (!target) throw new BadRequestException("userId query parameter required");
    const ancestors = await withTenants([tenantId], (c) => targetUnitAncestors(c, tenantId, target));
    await authorize(
      req.principal,
      { kind: "role_grant", tenantId, targetUserId: target, unitAncestors: ancestors },
      "read",
    );
    const rows = await withGlobal((c) =>
      c.query<{
        id: string; role: string; scope_type: string; scope_id: string | null;
        managed_by: string | null; managed_by_position: string | null;
        expires_at: string | null; origin_approval_id: string | null;
      }>(
        `SELECT ur.id, r.name AS role, ur.scope_type, ur.scope_id, ur.managed_by,
                ur.managed_by_position, ur.expires_at, ur.origin_approval_id
           FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = $1
          ORDER BY r.name`,
        [target],
      ),
    );
    return {
      userId: target,
      grants: rows.rows.map((g) => ({
        grantId: g.id,
        role: g.role,
        scopeType: g.scope_type,
        scopeId: g.scope_id,
        // Provenance is the whole point of showing this list: a position-managed grant must not be
        // hand-revoked (the reconciler would restore it and the operator would think the UI lied),
        // so it is labelled rather than merely listed.
        source: g.managed_by_position ? "position" : g.managed_by ? "service_assignment" : "manual",
        expiresAt: g.expires_at,
        originApprovalId: g.origin_approval_id,
        revocable: !g.managed_by_position && !g.managed_by,
      })),
    };
  }

  @Post(":tenantId/role-grants")
  @HttpCode(201)
  async create(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { userId?: string; roleId?: string; scopeType?: string; scopeId?: string | null; temporary?: boolean; expiresInDays?: number; reason?: string },
  ) {
    const target = body?.userId?.trim();
    const roleId = body?.roleId?.trim();
    if (!target || !roleId) throw new BadRequestException("userId and roleId required");
    const scopeType = body?.scopeType ?? "company";
    const scopeId = scopeType === "company" ? tenantId : (body?.scopeId ?? null);
    if (scopeType !== "company" && scopeType !== "org_unit") {
      // `global`/`project` are not this surface's business: global is the elevated door §6.3.6 keeps
      // shut here, and project-scoped grants have their own owner surfaces.
      throw new BadRequestException("scopeType must be 'company' or 'org_unit' on this surface");
    }
    if (scopeType === "org_unit" && !scopeId) throw new BadRequestException("scopeId required for org_unit scope");

    const prep = await withTenants([tenantId], async (c) => {
      const member = await c.query<{ user_id: string }>(
        `SELECT user_id FROM company_memberships
          WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' AND deleted_at IS NULL`,
        [tenantId, target],
      );
      if (!member.rows[0]) throw new BadRequestException("target is not an active member of this company");
      return { ancestors: await targetUnitAncestors(c, tenantId, target) };
    });

    // Cerbos first, with the SERVER-derived ancestry. This is also what enforces the structural
    // self-target DENY — the controller never re-implements it.
    await authorize(
      req.principal,
      { kind: "role_grant", tenantId, targetUserId: target, unitAncestors: prep.ancestors },
      "create",
    );

    // §6.3.7 — the sensitive gate. Only constrains the dept-head tier: a caller who reaches
    // `role_grant · create` WITHOUT any unit ancestry (i.e. tenant-wide) is company_admin or above.
    const tenantWide = await check(
      req.principal,
      { kind: "role_grant", tenantId, targetUserId: target, unitAncestors: [] },
      "create",
    );
    if (!tenantWide.allow) {
      // ⚠ SELF-SCOPED-EXCLUDED **and** baseline-excluded — the same two rules the ceiling applies,
      // for the same two reasons (see `assertWithinCeiling`):
      //   * `NOT rp.self_scoped` (the 0114 marker): a key whose every rule is self-scoped confers
      //     authority over the holder's own rows only. Routing that for approval is theatre.
      //   * the baseline `member` bundle: the baseline role itself carries ELEVEN sensitive-flagged
      //     keys, so without this a dept head is refused the commonest grant in the system and every
      //     role above it — i.e. the whole surface.
      //
      // The flags this gate reads were owner-reviewed on 2026-08-18 (107 -> 100, reads un-flagged
      // except `hr.record.read`); the review is `docs/superpowers/plans/2026-08-18-sensitivity-review.md`.
      const sensitive = await withGlobal((c) =>
        c.query<{ key: string }>(
          `SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
            WHERE rp.role_id = $1 AND p.sensitive AND NOT rp.self_scoped
              AND p.key NOT IN (
                SELECT p2.key FROM role_permissions rp2
                  JOIN permissions p2 ON p2.id = rp2.permission_id
                  JOIN roles r2 ON r2.id = rp2.role_id
                 WHERE r2.name = 'member' AND r2.company_id IS NULL
              )
            ORDER BY p.key`,
          [roleId],
        ),
      );
      if (sensitive.rows.length > 0) {
        throw new BadRequestException(
          `override_required: this role carries ${sensitive.rows.length} sensitive permission(s) ` +
            `(${sensitive.rows.slice(0, 5).map((r) => r.key).join(", ")}` +
            `${sensitive.rows.length > 5 ? ", …" : ""}) and a department head may not grant it directly ` +
            `(design §6.3.7). It must route as an override request for approval — and that mechanism ` +
            `(the 'decide_override' action) is NOT BUILT YET, so this request is refused rather than ` +
            `quietly allowed. Ask a company administrator to make this grant in the meantime.`,
        );
      }
    }

    const expiresAt = ((): string | null => {
      if (body?.expiresInDays === undefined && body?.temporary !== true) return null;
      const days = body?.expiresInDays ?? DEFAULT_EXPIRY_DAYS;
      if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRY_DAYS) {
        throw new BadRequestException(`expiresInDays must be an integer between 1 and ${MAX_EXPIRY_DAYS}`);
      }
      return new Date(Date.now() + days * 86400000).toISOString();
    })();

    // The choke point runs invariants 1–6 (scope validity, self-target, allow-list, elevated fence,
    // ceiling) and performs the only INSERT. `origin: "ui"` is what turns the Phase-2 invariant set
    // on — the legacy admin path deliberately keeps its narrower set (§6.4).
    const grantId = await withGlobal((c) =>
      insertGrantRow(c, {
        origin: "ui",
        targetUserId: target,
        roleId,
        scopeType,
        scopeId,
        actorUserId: req.principal.userId,
        actorPerms: req.principal.perms,
        tenantId,
        expiresAt,
        onConflict: "unique_columns",
      }),
    );
    await bumpSession(target);
    await writeActivity(tenantId, req.principal.userId, "granted", "role_grant", grantId ?? target, {
      roleId, scopeType, scopeId, expiresAt, reason: body?.reason ?? null,
    });
    return { ok: true, grantId, expiresAt, alreadyHeld: grantId === null };
  }

  @Delete(":tenantId/role-grants/:grantId")
  @HttpCode(200)
  async revoke(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("grantId") grantId: string,
  ) {
    const grant = await withGlobal((c) =>
      c.query<{ user_id: string; managed_by: string | null; managed_by_position: string | null; role: string }>(
        `SELECT ur.user_id, ur.managed_by, ur.managed_by_position, r.name AS role
           FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.id = $1`,
        [grantId],
      ),
    );
    if (!grant.rows[0]) throw new NotFoundException("grant not found");
    const row = grant.rows[0];

    const ancestors = await withTenants([tenantId], (c) => targetUnitAncestors(c, tenantId, row.user_id));
    await authorize(
      req.principal,
      { kind: "role_grant", tenantId, targetUserId: row.user_id, unitAncestors: ancestors },
      "revoke",
    );

    // A reconciler-owned grant is not hand-revocable: the next reconcile would restore it, so the
    // revoke would appear to work and then silently undo itself. Refuse and name the real lever —
    // the same posture `managed-by-invariant.test.ts` pins for the service reconciler.
    if (row.managed_by_position) {
      throw new BadRequestException(
        "managed_grant_not_revocable: this grant is provisioned by a POSITION. Unassign the person " +
          "from the seat (or change the seat's role-set) — revoking it here would be undone by the " +
          "next reconcile.",
      );
    }
    if (row.managed_by) {
      throw new BadRequestException(
        "managed_grant_not_revocable: this grant is provisioned by a SERVICE ASSIGNMENT. Revoke the " +
          "assignment instead.",
      );
    }

    const deleted = await withGlobal((c) => revokeGrantById(c, grantId, row.user_id));
    if (!deleted) throw new NotFoundException("grant not found");
    await bumpSession(row.user_id);
    await writeActivity(tenantId, req.principal.userId, "revoked", "role_grant", grantId, {
      userId: row.user_id, role: row.role,
    });
    return { ok: true, grantId: deleted, userId: row.user_id };
  }
}
