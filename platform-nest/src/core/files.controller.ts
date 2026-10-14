// Files / attachments (Nest port of core/files.ts). base64 upload, day-one scrub on text,
// target-entity IDOR guard, attachment-only download with nosniff (stored-XSS guard),
// RFC 5987 filename (header-injection guard).
import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { storage } from "./storage";
import { sha256Hex } from "./content-hash";
import { scrubText, isScrubbableText } from "./scrub";
import { insertReferenceFile } from "./file-reference";
import { AuthGuard } from "../auth/guards";
import { isUuidShaped } from "./dept-resolution";
import { authorizeWrite, findTarget, readResourceOf, type Target, type WorkTargetKind } from "./work-targets";

export const MAX_BYTES = 25 * 1024 * 1024;
// CP-1: `contract` and `invoice_payment` join the set so a contract PDF and a transfer receipt are
// ordinary attachments rather than a second blob mechanism. Note what this does NOT grant: line 59
// re-authorizes the caller against `{kind: targetType}`, and neither kind is readable by the `client`
// derived role in Cerbos — so a client CANNOT upload through this staff route. Client-side proof
// upload goes through the portal's own route, which authorizes on `portal` + client ownership.
export const TARGET_KINDS = new Set(["project", "task", "deliverable", "client", "agency_campaign", "agency_creative_asset", "contract", "invoice_payment", "work_request", "agency_campaign_part"]);

// DW-8h (docs/FRONTEND-BFF-CONTRACT.md §45.1). The two kinds below are resolved through the shared work-target module
// (work-targets.ts, DW-6k's resolver): the target must exist (404 `target_not_found`), reads follow the target's own read, and
// writes (attach, delete) follow the target's own WRITE rule, with attributes read from the database. Every OTHER kind in
// TARGET_KINDS keeps exactly its old behaviour: `file` then the target's `read`, which also guards its writes. That
// read-for-write is a recorded gap, out of scope for 8h (§45.1).
const WORK_TARGET_OF: Readonly<Record<string, WorkTargetKind>> = { work_request: "work_request", agency_campaign_part: "campaign_part" };
const workKindOf = (entityType: string): WorkTargetKind | null => WORK_TARGET_OF[entityType] ?? null;
const normId = (raw: string): string | undefined => (isUuidShaped(raw.trim()) ? raw.trim().toLowerCase() : undefined);

/** 404 `target_not_found`. The token goes first in `message` (the error filter turns `message` into `{ error }`). */
const targetNotFound = () => new NotFoundException("target_not_found");

/** A work-target READ gate: the target's own read (the shape its read route sends, with the id when it is usable), then the
 *  target must exist. Authorise first, then read the target (§45.1). */
async function readWorkTarget(req: FastifyRequest, tenantId: string, kind: WorkTargetKind, rawId: string): Promise<Target> {
  const id = normId(rawId);
  await authorize(req.principal, readResourceOf(kind, tenantId, id), "read");
  const t = await findTarget(tenantId, kind, id ?? null);
  if (!t) throw targetNotFound();
  return t;
}

/** A work-target WRITE gate: the kind-level read first (so a caller who may not read that kind learns nothing), then the target
 *  must exist, then the target's own write check on the attributes read from the database. */
async function writeWorkTarget(req: FastifyRequest, tenantId: string, kind: WorkTargetKind, rawId: string): Promise<Target> {
  await authorize(req.principal, readResourceOf(kind, tenantId), "read");
  const t = await findTarget(tenantId, kind, normId(rawId) ?? null);
  if (!t) throw targetNotFound();
  await authorizeWrite(req.principal, kind, t);
  return t;
}

/** The READ resource for a file's target: the new kinds send what their own read route sends, the rest the inline shape. */
export function targetReadResource(f: { target_entity_type: string; target_entity_id: string }, tenantId: string) {
  const wk = workKindOf(f.target_entity_type);
  return wk ? readResourceOf(wk, tenantId, f.target_entity_id) : { kind: f.target_entity_type, id: f.target_entity_id, tenantId };
}

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
    const wk = workKindOf(entityType);
    let listId = entityId;
    if (wk) listId = (await readWorkTarget(req, tenantId, wk, entityId)).id;
    else await authorize(req.principal, { kind: entityType, id: entityId, tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        // DW-6i: `url` is returned so a reference attachment (a link with no bytes, such as a Google Drive file) can be opened from
        // the list. It is NULL for an uploaded file. Additive; the row shape is otherwise unchanged.
        `SELECT id, filename, content_type, byte_size, scrubbed, uploader_id, created_at, url FROM files
         WHERE target_entity_type = $1 AND target_entity_id = $2 AND deleted_at IS NULL ORDER BY created_at DESC`,
        [entityType, listId],
      ),
    );
    return rows.rows;
  }

  // Two modes: (1) base64 binary upload {content} — scrubbed + stored; (2) reference attach
  // {url?} — filename (+ optional link) recorded with no blob (UI's current attach; true
  // multipart is a documented follow-up). Accepts both targetType/targetId and the UI's
  // entityType/entityId aliases; contentType and content_type are equivalent.
  @Post(":tenantId/files")
  @HttpCode(201)
  async upload(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { targetType?: string; targetId?: string; entityType?: string; entityId?: string; filename?: string; contentType?: string; content_type?: string; content?: string; url?: string },
  ) {
    const b = body ?? {};
    const targetType = b.targetType ?? b.entityType;
    const targetId = b.targetId ?? b.entityId;
    const contentType = b.contentType ?? b.content_type ?? "application/octet-stream";
    const { filename, content, url } = b;
    if (!targetType || !targetId || !filename) throw new BadRequestException("targetType/entityType, targetId/entityId and filename required");
    if (!TARGET_KINDS.has(targetType)) throw new BadRequestException("unsupported target type");
    await authorize(req.principal, { kind: "file", tenantId }, "create");
    // Order: authorise, read the target, then work (the body is validated after, so validation never pre-empts a 403).
    const wk = workKindOf(targetType);
    let attachId = targetId;
    if (wk) {
      const t = await writeWorkTarget(req, tenantId, wk, targetId);
      // A closed target takes no new files (§45.1); a delivered request still does.
      if (t.closed) throw new ConflictException("target_closed");
      attachId = t.id;
    } else {
      await authorize(req.principal, { kind: targetType, id: targetId, tenantId }, "read");
    }

    // Reference attach (no binary content): store filename + optional URL, no blob. DW-6i: the write is the shared
    // `insertReferenceFile` (file-reference.ts), which Google Drive's attach also uses; called with no options it does exactly
    // what this branch always did (scrub, 2048 cap, one INSERT, one `attached` activity row).
    if (!content) {
      const out = await insertReferenceFile({
        tenantId, uploaderId: req.principal.userId, targetType, targetId: attachId, filename, contentType, url: url ?? null,
      });
      if (out.duplicate) throw new ConflictException("duplicate reference"); // unreachable: rejectDuplicateUrl is not set here
      return { id: out.file.id, scrubbed: false, byteSize: 0 };
    }

    const cleanName = scrubText(filename).text;
    const id = newId();

    const raw = Buffer.from(content, "base64");
    if (raw.byteLength > MAX_BYTES) throw new BadRequestException("file too large");
    let bytes = raw;
    let scrubbed = false;
    if (isScrubbableText(contentType)) {
      const { text, redactions } = scrubText(raw.toString("utf8"));
      bytes = Buffer.from(text, "utf8");
      scrubbed = redactions > 0;
    }
    const storageKey = `${tenantId}/${id}`;
    await storage().put(storageKey, bytes);
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, sha256, scrubbed, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [id, tenantId, req.principal.userId, targetType, attachId, cleanName, contentType, bytes.byteLength, storageKey, sha256Hex(bytes), scrubbed, config.originSite],
      ),
    );
    await writeActivity(tenantId, req.principal.userId, "uploaded", targetType, attachId, { fileId: id, filename: cleanName });
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
    await authorize(req.principal, targetReadResource(f, tenantId), "read");
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
    await authorize(req.principal, targetReadResource(f, tenantId), "read");
    if (!f.storage_key) throw new NotFoundException("no stored content (reference attachment)");
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
      c.query<{ storage_key: string; target_entity_type: string; target_entity_id: string; role: string | null }>(
        `SELECT storage_key, target_entity_type, target_entity_id, role FROM files WHERE id = $1 AND deleted_at IS NULL`,
        [fileId],
      ),
    );
    const f = found.rows[0];
    if (!f) throw new NotFoundException("file not found");
    const wk = workKindOf(f.target_entity_type);
    if (wk) await writeWorkTarget(req, tenantId, wk, f.target_entity_id); // closed targets still allow a delete (§45.1)
    else await authorize(req.principal, { kind: f.target_entity_type, id: f.target_entity_id, tenantId }, "read");
    // PV5-07: an issued invoice's PDF and a contract's sealed copy are records, not attachments. The database refuses
    // the soft delete too (trg_files_guard_role_file); saying so here turns its error into a plain 409.
    if (f.role) throw new ConflictException("this file is an issued document (an invoice PDF or a sealed contract copy) and cannot be deleted");
    await withTenants([tenantId], (c) => c.query(`UPDATE files SET deleted_at = now(), updated_at = now() WHERE id = $1`, [fileId]));
    if (f.storage_key) await storage().del(f.storage_key);
    await writeActivity(tenantId, req.principal.userId, "deleted", "file", fileId);
    return { id: fileId, deleted: true };
  }
}
