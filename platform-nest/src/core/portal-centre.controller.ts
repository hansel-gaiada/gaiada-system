// Client Centre — PORTAL routes (CC piece 2, CC-D4). See docs/plans/2026-09-29-client-centre.md.
//
// ── WHY THIS IS CORE, NOT UNDER THE `clients` MODULE ────────────────────────────────────────────
// `client_centre_profiles` is deliberately NOT app_module_allowed('clients') (see the migration's own
// header) because it is CLIENT-REACHABLE, and the portal must not depend on the caller's agency
// having the `clients` staff module turned on — a client contact has no visibility into, and no
// reason to care about, their agency's own module configuration. This controller therefore carries
// no `ModuleEnabledGuard` at all, matching every other `Portal*Controller` in `src/core/`. The STAFF
// half of Client Centre (clients-centre.controller.ts) is module-gated; this half is not, by design.
//
// ── CC-D4 (the editor rule) ──────────────────────────────────────────────────────────────────────
// Every active contact may READ the profile. Only an ACTIVE, CLIENT-WIDE (`project_id IS NULL`,
// never project-scoped) contact with capability `signer` for THAT SPECIFIC client — or the legacy
// `clients.portal_user_id` whole-client signer — may EDIT it. This is narrower than
// `portal-scope.ts`'s own `canSign` (which is a per-CALLER union across every client and project the
// caller touches, useful for "should the Sign button render anywhere") — CC-D4 asks the sharper,
// per-CLIENT question "may THIS caller edit THIS company's profile", so it is its own query
// (`canEditCentre` below), not a reuse of `resolvePortalScope`'s `canSign` field. Both the GET's
// `canEdit` and the PATCH's gate call the SAME function, so they can never disagree.
import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Patch, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { withTenants } from "../db";
import { authorize, writeActivity } from "./http";
import { AuthGuard } from "../auth/guards";
import { resolvePortalScope } from "./portal-scope";
import { notifyBestEffort } from "./client-notify";
import { emitEvent } from "../events/outbox.service";
import { applyCentrePatch } from "../modules/clients/centre/validation";
import {
  loadProfileRow, saveProfileRow, emptyProfileState, toCentreProfileDTO,
  DEFAULT_BUSINESS_TYPE,
} from "../modules/clients/centre/store";

/** CC-D4's editor test — see the file header. Returns false for a viewer, a project-scoped signer,
 *  or anyone not an active contact of this exact client at all (a caller outside scope should never
 *  reach this function — the route checks `clientId ∈ scope.clientIds` first). */
export async function canEditCentre(c: PoolClient, userId: string, clientId: string): Promise<boolean> {
  const r = await c.query(
    `SELECT EXISTS (
       SELECT 1 FROM client_contacts cc
        WHERE cc.user_id = $1 AND cc.client_id = $2 AND cc.project_id IS NULL
          AND cc.capability = 'signer' AND cc.status = 'active' AND cc.deleted_at IS NULL
       UNION
       SELECT 1 FROM clients cl WHERE cl.id = $2 AND cl.portal_user_id = $1 AND cl.deleted_at IS NULL
     ) AS can_edit`,
    [userId, clientId],
  );
  return !!r.rows[0]?.can_edit;
}

@Controller("api")
@UseGuards(AuthGuard)
export class PortalCentreController {
  @Get(":tenantId/portal/centre")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const clients = await c.query<{ id: string; name: string }>(
        `SELECT id, name FROM clients WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY name`,
        [scope.clientIds],
      );
      const out = [];
      for (const cl of clients.rows) {
        out.push({
          clientId: cl.id,
          clientName: cl.name,
          canEdit: await canEditCentre(c, req.principal.userId as string, cl.id),
        });
      }
      return out;
    });
  }

  @Get(":tenantId/portal/centre/:clientId")
  async get(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      // Outside scope answers 404, never 403 — CC's own contract line, matching the rest of the
      // portal's isolation posture (portal-scope.ts's own header): a client must never learn that a
      // clientId it guessed belongs to SOMEONE ELSE'S tenant relationship, even as a bare "forbidden".
      if (!scope.clientIds.includes(clientId)) throw new NotFoundException("client not found");
      const client = await c.query<{ id: string; name: string; status: string | null }>(
        `SELECT id, name, status FROM clients WHERE id = $1 AND deleted_at IS NULL`, [clientId],
      );
      if (!client.rows[0]) throw new NotFoundException("client not found");
      const row = await loadProfileRow(c, tenantId, clientId);
      let updatedByName: string | null = null;
      if (row?.updatedById) {
        const u = await c.query<{ name: string | null }>(`SELECT name FROM users WHERE id = $1`, [row.updatedById]);
        updatedByName = u.rows[0]?.name ?? null;
      }
      const canEdit = await canEditCentre(c, req.principal.userId as string, clientId);
      return toCentreProfileDTO(client.rows[0], row, updatedByName, canEdit);
    });
  }

  @Patch(":tenantId/portal/centre/:clientId")
  @HttpCode(200)
  async patch(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("clientId") clientId: string,
    @Body() body: unknown,
  ) {
    await authorize(req.principal, { kind: "portal", tenantId }, "edit_company_profile");
    const outcome = await withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      if (!scope.clientIds.includes(clientId)) throw new NotFoundException("client not found");
      if (!(await canEditCentre(c, req.principal.userId as string, clientId))) {
        throw new ForbiddenException("your access is view-only — ask your account manager for company-wide signing access");
      }
      const client = await c.query<{ id: string; name: string; status: string | null }>(
        `SELECT id, name, status FROM clients WHERE id = $1 AND deleted_at IS NULL`, [clientId],
      );
      if (!client.rows[0]) throw new NotFoundException("client not found");
      const existing = await loadProfileRow(c, tenantId, clientId);
      const current = existing?.state ?? emptyProfileState(DEFAULT_BUSINESS_TYPE);
      const result = applyCentrePatch(current, body);
      if ("error" in result) throw new BadRequestException(result.error);

      let row = existing;
      let owners: string[] = [];
      if (result.changes.length > 0) {
        const saved = await saveProfileRow(c, tenantId, clientId, result.state, req.principal.userId);
        // writeActivity + notifyBestEffort run AFTER this transaction commits (below) — same reason
        // as clients-centre.controller.ts's own comment: writeActivity opens its own transaction, and
        // a notification must never announce a write that then rolls back.
        await emitEvent(c, tenantId, "client", clientId, "client.centre_updated", { changes: result.changes.map((ch) => ch.path) });
        row = { state: result.state, revision: saved.revision, updatedAt: saved.updatedAt, updatedById: req.principal.userId };
        const ownerRows = await c.query<{ owner_id: string | null }>(
          `SELECT DISTINCT p.owner_id FROM projects p WHERE p.client_id = $1 AND p.deleted_at IS NULL`,
          [clientId],
        );
        owners = [...new Set(ownerRows.rows.map((x) => x.owner_id).filter((x): x is string => !!x))];
      }
      let updatedByName: string | null = null;
      if (row?.updatedById) {
        const u = await c.query<{ name: string | null }>(`SELECT name FROM users WHERE id = $1`, [row.updatedById]);
        updatedByName = u.rows[0]?.name ?? null;
      }
      return {
        dto: toCentreProfileDTO(client.rows[0], row, updatedByName, true),
        changes: result.changes,
        owners,
        clientName: client.rows[0].name,
      };
    });
    if (outcome.changes.length > 0) {
      await writeActivity(tenantId, req.principal.userId, "updated", "client", clientId, {
        via: "portal", changes: outcome.changes,
      });
      if (outcome.owners.length) {
        await notifyBestEffort(tenantId, req.principal.userId, outcome.owners, "client.centre_updated", {
          title: `${outcome.clientName} updated their Client Centre profile`,
          href: `/client-centre/${clientId}`,
          entityType: "client",
          entityId: clientId,
          severity: "info",
        });
      }
    }
    return outcome.dto;
  }
}
