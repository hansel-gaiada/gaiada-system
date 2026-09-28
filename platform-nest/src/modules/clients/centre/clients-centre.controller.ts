// Client Centre — STAFF routes (CC piece 2). See docs/plans/2026-09-29-client-centre.md.
// Mounted under the `clients` module (ModuleEnabledGuard("clients")), authorized against the SAME
// `client` Cerbos kind + `core.client.{read,update}` catalog keys ClientsController already uses —
// this is a new VIEW over the existing `clients` resource, not a new authorization surface.
//
// ── STATIC-ROUTE-BEFORE-PARAM (verified by clients-centre-routing.db.test.ts) ──────────────────
// `GET :tenantId/clients/centre` is 3 path segments after `/api`; the existing
// `GET :tenantId/clients/:clientId` (ClientsController) is ALSO 3 segments at the same depth, so a
// naive router could resolve `/clients/centre` as `clientId = "centre"`. Fastify's `find-my-way`
// router prefers a static segment over a parametric one at the same node regardless of registration
// order, but this is exactly the kind of routing fact that is worth PROVING rather than trusting —
// see the db test for the live assertion.
import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../../../db";
import { authorize, writeActivity } from "../../../core/http";
import { check } from "../../../rbac/cerbos";
import { emitEvent } from "../../../events/outbox.service";
import { AuthGuard } from "../../../auth/guards";
import { ModuleEnabledGuard } from "../../module-enabled.guard";
import { applyCentrePatch } from "./validation";
import {
  loadProfileRow, saveProfileRow, emptyProfileState, toCentreProfileDTO,
  fieldsFilledSummary, connectionsConnectedSummary, DEFAULT_BUSINESS_TYPE,
} from "./store";

@Controller("api")
@UseGuards(AuthGuard, ModuleEnabledGuard("clients"))
export class ClientsCentreController {
  @Get(":tenantId/clients/centre")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "client", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const clients = await c.query<{ id: string; name: string; status: string | null }>(
        `SELECT id, name, status FROM clients WHERE deleted_at IS NULL ORDER BY created_at DESC`,
      );
      const profiles = await c.query<{
        client_id: string; business_type: string; profile: Record<string, string>;
        connections: Record<string, { status?: string }>; custom_connections: Record<string, Array<{ id: string; name: string }>>;
        updated_at: string | null;
      }>(`SELECT client_id, business_type, profile, connections, custom_connections, updated_at FROM client_centre_profiles`);
      const byClient = new Map(profiles.rows.map((r) => [r.client_id, r]));
      return clients.rows.map((cl) => {
        const p = byClient.get(cl.id);
        const state = p
          ? { businessType: p.business_type, profile: p.profile ?? {}, connections: p.connections ?? {}, departments: {}, customConnections: p.custom_connections ?? {} }
          : emptyProfileState();
        return {
          clientId: cl.id,
          clientName: cl.name,
          clientStatus: cl.status,
          businessType: state.businessType,
          city: state.profile.city ?? null,
          fieldsFilled: fieldsFilledSummary(state),
          connectionsConnected: connectionsConnectedSummary(state),
          updatedAt: p?.updated_at ?? null,
        };
      });
    });
  }

  @Get(":tenantId/clients/:clientId/centre")
  async get(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string) {
    await authorize(req.principal, { kind: "client", id: clientId, tenantId }, "read");
    return withTenants([tenantId], async (c) => {
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
      const canEdit = (await check(req.principal, { kind: "client", id: clientId, tenantId }, "update")).allow;
      return toCentreProfileDTO(client.rows[0], row, updatedByName, canEdit);
    });
  }

  @Patch(":tenantId/clients/:clientId/centre")
  async patch(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("clientId") clientId: string,
    @Body() body: unknown,
  ) {
    await authorize(req.principal, { kind: "client", id: clientId, tenantId }, "update");
    const outcome = await withTenants([tenantId], async (c) => {
      const client = await c.query<{ id: string; name: string; status: string | null }>(
        `SELECT id, name, status FROM clients WHERE id = $1 AND deleted_at IS NULL`, [clientId],
      );
      if (!client.rows[0]) throw new NotFoundException("client not found");
      const existing = await loadProfileRow(c, tenantId, clientId);
      const current = existing?.state ?? emptyProfileState(DEFAULT_BUSINESS_TYPE);
      const result = applyCentrePatch(current, body);
      if ("error" in result) throw new BadRequestException(result.error);

      let row = existing;
      if (result.changes.length > 0) {
        const saved = await saveProfileRow(c, tenantId, clientId, result.state, req.principal.userId);
        // Same transaction as the write it announces (transactional outbox) — writeActivity is NOT
        // called here on purpose: it opens its OWN withTenants transaction, and matching
        // ClientsController's own idiom, it runs AFTER this transaction has committed (below).
        await emitEvent(c, tenantId, "client", clientId, "client.centre_updated", { changes: result.changes.map((ch) => ch.path) });
        row = { state: result.state, revision: saved.revision, updatedAt: saved.updatedAt, updatedById: req.principal.userId };
      }
      let updatedByName: string | null = null;
      if (row?.updatedById) {
        const u = await c.query<{ name: string | null }>(`SELECT name FROM users WHERE id = $1`, [row.updatedById]);
        updatedByName = u.rows[0]?.name ?? null;
      }
      return { dto: toCentreProfileDTO(client.rows[0], row, updatedByName, true), changes: result.changes };
    });
    if (outcome.changes.length > 0) {
      await writeActivity(tenantId, req.principal.userId, "updated", "client", clientId, {
        via: "client-centre", changes: outcome.changes,
      });
    }
    return outcome.dto;
  }
}
