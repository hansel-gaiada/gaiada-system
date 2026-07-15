// Core client-work routes (Nest port of core/client-work.ts): clients, deliverables,
// time_entries. authorize() → RLS query → activity; time-entry owned by the logger.
import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { validateCustomFields } from "./custom-fields";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";

@Controller("api")
@UseGuards(AuthGuard)
export class ClientWorkController {
  // ---- Clients ----
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

  // ---- Deliverables ----
  @Get(":tenantId/deliverables")
  async listDeliverables(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("projectId") projectId?: string, @Query("clientId") clientId?: string) {
    await authorize(req.principal, { kind: "deliverable", tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT id, project_id, client_id, name, status, due_date, custom_fields FROM deliverables
         WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR project_id = $1) AND ($2::uuid IS NULL OR client_id = $2)
         ORDER BY due_date NULLS LAST, created_at DESC`,
        [projectId ?? null, clientId ?? null],
      ),
    );
    return rows.rows;
  }

  @Get(":tenantId/deliverables/:deliverableId")
  async getDeliverable(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("deliverableId") deliverableId: string) {
    await authorize(req.principal, { kind: "deliverable", id: deliverableId, tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(`SELECT id, project_id, client_id, name, status, due_date, custom_fields FROM deliverables WHERE id = $1 AND deleted_at IS NULL`, [deliverableId]),
    );
    if (!rows.rows[0]) throw new NotFoundException("deliverable not found");
    return rows.rows[0];
  }

  @Post(":tenantId/deliverables")
  @HttpCode(201)
  async createDeliverable(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: { projectId?: string; clientId?: string; name?: string; dueDate?: string; customFields?: Record<string, unknown> }) {
    const { projectId, clientId, name, dueDate, customFields = {} } = body ?? {};
    if (!projectId || !name) throw new BadRequestException("projectId and name required");
    await authorize(req.principal, { kind: "deliverable", tenantId, projectId }, "create");
    const id = newId();
    await withTenants([tenantId], async (c) => {
      const cfError = await validateCustomFields(c, tenantId, "deliverable", customFields);
      if (cfError) throw new BadRequestException(cfError);
      const proj = await c.query(`SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL`, [projectId]);
      if (!proj.rows[0]) throw new NotFoundException("project not found");
      await c.query(
        `INSERT INTO deliverables (id, tenant_id, project_id, client_id, name, due_date, custom_fields, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, tenantId, projectId, clientId ?? null, name, dueDate ?? null, JSON.stringify(customFields), config.originSite],
      );
    });
    await writeActivity(tenantId, req.principal.userId, "created", "deliverable", id, { name });
    return { id };
  }

  @Patch(":tenantId/deliverables/:deliverableId")
  async updateDeliverable(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("deliverableId") deliverableId: string, @Body() b: { name?: string; status?: string; dueDate?: string; clientId?: string; customFields?: Record<string, unknown> }) {
    await authorize(req.principal, { kind: "deliverable", id: deliverableId, tenantId }, "update");
    await withTenants([tenantId], async (c) => {
      if (b.customFields) {
        const cfError = await validateCustomFields(c, tenantId, "deliverable", b.customFields);
        if (cfError) throw new BadRequestException(cfError);
      }
      const res = await c.query(
        `UPDATE deliverables SET name = COALESCE($2, name), status = COALESCE($3, status), due_date = COALESCE($4, due_date),
           client_id = COALESCE($5, client_id), custom_fields = COALESCE($6, custom_fields), updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL`,
        [deliverableId, b.name ?? null, b.status ?? null, b.dueDate ?? null, b.clientId ?? null, b.customFields ? JSON.stringify(b.customFields) : null],
      );
      if (res.rowCount === 0) throw new NotFoundException("deliverable not found");
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "deliverable", deliverableId, { status: b.status });
    return { id: deliverableId };
  }

  // ---- Time entries (owned by the logger) ----
  @Get(":tenantId/time-entries")
  async listTime(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("projectId") projectId?: string, @Query("taskId") taskId?: string, @Query("mine") mine?: string) {
    await authorize(req.principal, { kind: "time_entry", tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT id, user_id, project_id, task_id, minutes, billable, entry_date, notes FROM time_entries
         WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR project_id = $1) AND ($2::uuid IS NULL OR task_id = $2)
           AND ($3::uuid IS NULL OR user_id = $3)
         ORDER BY entry_date DESC, created_at DESC LIMIT 500`,
        [projectId ?? null, taskId ?? null, mine === "me" ? req.principal.userId : null],
      ),
    );
    return rows.rows;
  }

  @Post(":tenantId/time-entries")
  @HttpCode(201)
  async logTime(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: { projectId?: string; taskId?: string; minutes?: number; billable?: boolean; entryDate?: string; notes?: string }) {
    const { projectId, taskId, minutes, billable = false, entryDate, notes = "" } = body ?? {};
    if (!projectId) throw new BadRequestException("projectId required");
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes <= 0) throw new BadRequestException("minutes must be a positive integer");
    await authorize(req.principal, { kind: "time_entry", tenantId, projectId, ownerId: req.principal.userId ?? undefined }, "create");
    const id = newId();
    await withTenants([tenantId], async (c) => {
      const proj = await c.query(`SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL`, [projectId]);
      if (!proj.rows[0]) throw new NotFoundException("project not found");
      await c.query(
        `INSERT INTO time_entries (id, tenant_id, user_id, project_id, task_id, minutes, billable, entry_date, notes, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::date, current_date), $9, $10)`,
        [id, tenantId, req.principal.userId, projectId, taskId ?? null, minutes, billable, entryDate ?? null, notes, config.originSite],
      );
    });
    await writeActivity(tenantId, req.principal.userId, "logged", "time_entry", id, { minutes, billable });
    return { id };
  }

  @Patch(":tenantId/time-entries/:entryId")
  async updateTime(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("entryId") entryId: string, @Body() b: { minutes?: number; billable?: boolean; notes?: string }) {
    const owner = await withTenants([tenantId], (c) =>
      c.query<{ user_id: string }>(`SELECT user_id FROM time_entries WHERE id = $1 AND deleted_at IS NULL`, [entryId]),
    );
    if (!owner.rows[0]) throw new NotFoundException("time entry not found");
    await authorize(req.principal, { kind: "time_entry", id: entryId, tenantId, ownerId: owner.rows[0].user_id }, "update");
    if (b.minutes != null && (!Number.isInteger(b.minutes) || b.minutes <= 0)) throw new BadRequestException("minutes must be a positive integer");
    await withTenants([tenantId], (c) =>
      c.query(
        `UPDATE time_entries SET minutes = COALESCE($2, minutes), billable = COALESCE($3, billable), notes = COALESCE($4, notes), updated_at = now()
         WHERE id = $1`,
        [entryId, b.minutes ?? null, b.billable ?? null, b.notes ?? null],
      ),
    );
    await writeActivity(tenantId, req.principal.userId, "updated", "time_entry", entryId);
    return { id: entryId };
  }
}
