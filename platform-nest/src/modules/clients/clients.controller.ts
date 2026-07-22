// Clients (CRM) resource routes (WSA-2). Extracted from src/core/client-work.controller.ts into
// the clients MODULE; gated by ModuleEnabledGuard("clients"). Deliverables + time_entries stay in
// the CORE ClientWorkController (shared work substrate — NOT module-gated).
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity } from "../../core/http";
import { validateCustomFields } from "../../core/custom-fields";
import { emitEvent } from "../../events/outbox.service";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";

@Controller("api")
@UseGuards(AuthGuard, ModuleEnabledGuard("clients"))
export class ClientsController {
  @Get(":tenantId/clients")
  async listClients(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "client", tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(`SELECT id, name, contact, status, custom_fields FROM clients WHERE deleted_at IS NULL ORDER BY created_at DESC`),
    );
    return rows.rows;
  }

  @Get(":tenantId/clients/:clientId")
  async getClient(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string) {
    await authorize(req.principal, { kind: "client", id: clientId, tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(`SELECT id, name, contact, status, custom_fields FROM clients WHERE id = $1 AND deleted_at IS NULL`, [clientId]),
    );
    if (!rows.rows[0]) throw new NotFoundException("client not found");
    return rows.rows[0];
  }

  @Post(":tenantId/clients")
  @HttpCode(201)
  async createClient(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: { name?: string; contact?: Record<string, unknown>; customFields?: Record<string, unknown> }) {
    const { name, contact = {}, customFields = {} } = body ?? {};
    if (!name) throw new BadRequestException("name required");
    await authorize(req.principal, { kind: "client", tenantId }, "create");
    const id = newId();
    await withTenants([tenantId], async (c) => {
      const cfError = await validateCustomFields(c, tenantId, "client", customFields);
      if (cfError) throw new BadRequestException(cfError);
      await c.query(
        `INSERT INTO clients (id, tenant_id, name, contact, custom_fields, origin_site) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, tenantId, name, JSON.stringify(contact), JSON.stringify(customFields), config.originSite],
      );
      // Transactional outbox (same tx as the insert): powers the event→n8n bridge / consumers.
      await emitEvent(c, tenantId, "client", id, "client.created", { name });
    });
    await writeActivity(tenantId, req.principal.userId, "created", "client", id, { name });
    return { id };
  }

  @Patch(":tenantId/clients/:clientId")
  async updateClient(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string, @Body() b: { name?: string; contact?: Record<string, unknown>; status?: string; customFields?: Record<string, unknown> }) {
    await authorize(req.principal, { kind: "client", id: clientId, tenantId }, "update");
    await withTenants([tenantId], async (c) => {
      if (b.customFields) {
        const cfError = await validateCustomFields(c, tenantId, "client", b.customFields);
        if (cfError) throw new BadRequestException(cfError);
      }
      const res = await c.query(
        `UPDATE clients SET name = COALESCE($2, name), contact = COALESCE($3, contact), status = COALESCE($4, status),
           custom_fields = COALESCE($5, custom_fields), updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL`,
        [clientId, b.name ?? null, b.contact ? JSON.stringify(b.contact) : null, b.status ?? null, b.customFields ? JSON.stringify(b.customFields) : null],
      );
      if (res.rowCount === 0) throw new NotFoundException("client not found");
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "client", clientId);
    return { id: clientId };
  }

  @Delete(":tenantId/clients/:clientId")
  @HttpCode(200)
  async deleteClient(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string) {
    await authorize(req.principal, { kind: "client", id: clientId, tenantId }, "delete");
    await withTenants([tenantId], async (c) => {
      const res = await c.query(`UPDATE clients SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [clientId]);
      if (res.rowCount === 0) throw new NotFoundException("client not found");
      await emitEvent(c, tenantId, "client", clientId, "client.deleted", {});
    });
    await writeActivity(tenantId, req.principal.userId, "deleted", "client", clientId);
    return { ok: true };
  }
}
