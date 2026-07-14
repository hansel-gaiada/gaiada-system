// D17 registry management (Nest port). The UI reads field defs to render dynamic forms;
// admins/managers define them. Validation-on-write lives in custom-fields.ts (the validator).
import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { AuthGuard } from "../auth/guards";

const DATA_TYPES = new Set(["text", "number", "boolean", "date", "select"]);

@Controller("api")
@UseGuards(AuthGuard)
export class CustomFieldsController {
  @Get(":tenantId/custom-fields")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("entityType") entityType?: string) {
    await authorize(req.principal, { kind: "custom_field", tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT key, label, data_type, options, required FROM custom_field_definitions
         WHERE deleted_at IS NULL ${entityType ? "AND entity_type = $1" : ""} ORDER BY entity_type, key`,
        entityType ? [entityType] : [],
      ),
    );
    return rows.rows;
  }

  @Post(":tenantId/custom-fields")
  @HttpCode(201)
  async create(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { entityType?: string; key?: string; label?: string; dataType?: string; options?: unknown[]; required?: boolean },
  ) {
    const { entityType, key, label, dataType, options = [], required = false } = body ?? {};
    if (!entityType || !key || !label || !dataType) throw new BadRequestException("entityType, key, label and dataType required");
    if (!DATA_TYPES.has(dataType)) throw new BadRequestException("invalid dataType");
    await authorize(req.principal, { kind: "custom_field", tenantId }, "create");
    const id = newId();
    try {
      await withTenants([tenantId], (c) =>
        c.query(
          `INSERT INTO custom_field_definitions (id, tenant_id, entity_type, key, label, data_type, options, required, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [id, tenantId, entityType, key, label, dataType, JSON.stringify(options), required, config.originSite],
        ),
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictException("a field with that key already exists for this entity");
      }
      throw err;
    }
    await writeActivity(tenantId, req.principal.userId, "created", "custom_field", id, { entityType, key });
    return { id };
  }

  // Edit a field def — label/options/required only (key/entity_type/data_type are immutable
  // to keep the JSONB values already written under that key valid).
  @Patch(":tenantId/custom-fields/:fieldId")
  async update(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("fieldId") fieldId: string,
    @Body() body: { label?: string; options?: unknown[]; required?: boolean },
  ) {
    await authorize(req.principal, { kind: "custom_field", tenantId }, "update");
    const { label, options, required } = body ?? {};
    if (label === undefined && options === undefined && required === undefined) {
      throw new BadRequestException("nothing to update");
    }
    const res = await withTenants([tenantId], (c) =>
      c.query(
        `UPDATE custom_field_definitions
         SET label = COALESCE($2, label),
             options = COALESCE($3::jsonb, options),
             required = COALESCE($4, required),
             updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL`,
        [fieldId, label ?? null, options === undefined ? null : JSON.stringify(options), required ?? null],
      ),
    );
    if (res.rowCount === 0) throw new NotFoundException("field definition not found");
    await writeActivity(tenantId, req.principal.userId, "updated", "custom_field", fieldId);
    return { id: fieldId };
  }

  // Soft-delete a field def (existing values on entities are left untouched).
  @Delete(":tenantId/custom-fields/:fieldId")
  async remove(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("fieldId") fieldId: string,
  ) {
    await authorize(req.principal, { kind: "custom_field", tenantId }, "delete");
    const res = await withTenants([tenantId], (c) =>
      c.query(
        `UPDATE custom_field_definitions SET deleted_at = now(), updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL`,
        [fieldId],
      ),
    );
    if (res.rowCount === 0) throw new NotFoundException("field definition not found");
    await writeActivity(tenantId, req.principal.userId, "deleted", "custom_field", fieldId);
    return { id: fieldId, deleted: true };
  }
}
