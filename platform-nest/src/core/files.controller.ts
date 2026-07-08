// Files / attachments (Nest port of core/files.ts). base64 upload, day-one scrub on text,
// target-entity IDOR guard, attachment-only download with nosniff (stored-XSS guard),
// RFC 5987 filename (header-injection guard).
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { storage } from "./storage";
import { scrubText, isScrubbableText } from "./scrub";
import { AuthGuard } from "../auth/guards";

const MAX_BYTES = 25 * 1024 * 1024;
const TARGET_KINDS = new Set(["project", "task", "deliverable", "client", "agency_campaign", "agency_creative_asset"]);

function dispositionHeader(filename: string): string {
  const ascii = filename.replace(/[\r\n"\\]/g, "_").replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

@Controller("api")
@UseGuards(AuthGuard)
export class FilesController {
  @Get(":tenantId/files")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("entityType") entityType?: string, @Query("entityId") entityId?: string) {
    if (!entityType || !entityId) throw new BadRequestException("entityType and entityId required");
    if (!TARGET_KINDS.has(entityType)) throw new BadRequestException("unsupported target type");
    await authorize(req.principal, { kind: "file", tenantId }, "read");
    await authorize(req.principal, { kind: entityType, id: entityId, tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT id, filename, content_type, byte_size, scrubbed, uploader_id, created_at FROM files
         WHERE target_entity_type = $1 AND target_entity_id = $2 AND deleted_at IS NULL ORDER BY created_at DESC`,
        [entityType, entityId],
      ),
    );
    return rows.rows;
  }

  @Post(":tenantId/files")
  @HttpCode(201)
  async upload(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: { targetType?: string; targetId?: string; filename?: string; contentType?: string; content?: string }) {
    const { targetType, targetId, filename, contentType = "application/octet-stream", content } = body ?? {};
    if (!targetType || !targetId || !filename || !content) throw new BadRequestException("targetType, targetId, filename and content (base64) required");
    if (!TARGET_KINDS.has(targetType)) throw new BadRequestException("unsupported target type");
    await authorize(req.principal, { kind: "file", tenantId }, "create");
    await authorize(req.principal, { kind: targetType, id: targetId, tenantId }, "read");

    const raw = Buffer.from(content, "base64");
    if (raw.byteLength > MAX_BYTES) throw new BadRequestException("file too large");
    let bytes = raw;
    let scrubbed = false;
    if (isScrubbableText(contentType)) {
      const { text, redactions } = scrubText(raw.toString("utf8"));
      bytes = Buffer.from(text, "utf8");
      scrubbed = redactions > 0;
    }
    const cleanName = scrubText(filename).text;
    const id = newId();
    const storageKey = `${tenantId}/${id}`;
    await storage().put(storageKey, bytes);
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, scrubbed, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, tenantId, req.principal.userId, targetType, targetId, cleanName, contentType, bytes.byteLength, storageKey, scrubbed, config.originSite],
      ),
    );
    await writeActivity(tenantId, req.principal.userId, "uploaded", targetType, targetId, { fileId: id, filename: cleanName });
    return { id, scrubbed, byteSize: bytes.byteLength };
  }

  @Get(":tenantId/files/:fileId")
  async metadata(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("fileId") fileId: string) {
    await authorize(req.principal, { kind: "file", id: fileId, tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT id, filename, content_type, byte_size, scrubbed, target_entity_type, target_entity_id, uploader_id, created_at
         FROM files WHERE id = $1 AND deleted_at IS NULL`,
        [fileId],
      ),
    );
    const f = rows.rows[0] as { target_entity_type: string; target_entity_id: string } | undefined;
    if (!f) throw new NotFoundException("file not found");
    await authorize(req.principal, { kind: f.target_entity_type, id: f.target_entity_id, tenantId }, "read");
    return rows.rows[0];
  }

  @Get(":tenantId/files/:fileId/content")
  async content(@Req() req: FastifyRequest, @Res() reply: FastifyReply, @Param("tenantId") tenantId: string, @Param("fileId") fileId: string) {
    await authorize(req.principal, { kind: "file", id: fileId, tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query<{ storage_key: string; content_type: string; filename: string; target_entity_type: string; target_entity_id: string }>(
        `SELECT storage_key, content_type, filename, target_entity_type, target_entity_id FROM files WHERE id = $1 AND deleted_at IS NULL`,
        [fileId],
      ),
    );
    const f = rows.rows[0];
    if (!f) throw new NotFoundException("file not found");
    await authorize(req.principal, { kind: f.target_entity_type, id: f.target_entity_id, tenantId }, "read");
    const bytes = await storage().get(f.storage_key);
    await reply
      .header("content-disposition", dispositionHeader(f.filename))
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox; default-src 'none'")
      .type(f.content_type || "application/octet-stream")
      .send(bytes);
  }

  @Delete(":tenantId/files/:fileId")
  async remove(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("fileId") fileId: string) {
    await authorize(req.principal, { kind: "file", id: fileId, tenantId }, "delete");
    const found = await withTenants([tenantId], (c) =>
      c.query<{ storage_key: string; target_entity_type: string; target_entity_id: string }>(
        `SELECT storage_key, target_entity_type, target_entity_id FROM files WHERE id = $1 AND deleted_at IS NULL`,
        [fileId],
      ),
    );
    const f = found.rows[0];
    if (!f) throw new NotFoundException("file not found");
    await authorize(req.principal, { kind: f.target_entity_type, id: f.target_entity_id, tenantId }, "read");
    await withTenants([tenantId], (c) => c.query(`UPDATE files SET deleted_at = now(), updated_at = now() WHERE id = $1`, [fileId]));
    await storage().del(f.storage_key);
    await writeActivity(tenantId, req.principal.userId, "deleted", "file", fileId);
    return { id: fileId, deleted: true };
  }
}
