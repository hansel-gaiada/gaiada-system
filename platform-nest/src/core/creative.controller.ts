// Creative Image Studio — persist API. Stores the assets exported by the client-side
// grading pipeline (platform-ui). The whole point is REPRODUCIBILITY: we keep the
// original bytes, the graded bytes, and the exact grade parameters, so any correction
// can be reproduced, reversed, or (phase 2) used as an AI training pair.
//
// Reuses the existing "file" Cerbos policy + storage backend + activity log — no new
// authz surface. Bytes live in storage (keyed); only metadata + the small grade JSON
// live in Postgres (mirrors FilesController). Images are not scrubbable text, so no PII
// scrub runs on the pixels (the day-one scrubber only touches text content types).
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { storage } from "./storage";
import { AuthGuard } from "../auth/guards";

const MAX_BYTES = 25 * 1024 * 1024;

// The nine Grade fields the studio produces (kept in sync with platform-ui lib/imaging/grade.ts).
// Server-side validation guards the reproducibility record: a malformed grade would make the
// stored asset non-reproducible, so we reject rather than store garbage.
const GRADE_KEYS = ["exposure", "contrast", "temperature", "tint", "gamma", "saturation", "vibrance", "highlights", "shadows"] as const;

function validateGrade(g: unknown): Record<string, number> {
  if (!g || typeof g !== "object") throw new BadRequestException("grade must be an object");
  const src = g as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const k of GRADE_KEYS) {
    const v = src[k];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new BadRequestException(`grade.${k} must be a finite number`);
    out[k] = v;
  }
  return out;
}

function decodeImage(b64: string, label: string): Buffer {
  const raw = Buffer.from(b64, "base64");
  if (raw.byteLength === 0) throw new BadRequestException(`${label} is empty`);
  if (raw.byteLength > MAX_BYTES) throw new BadRequestException(`${label} too large`);
  return raw;
}

interface SaveBody {
  name?: string;
  contentType?: string;
  width?: number;
  height?: number;
  presetId?: string;
  departmentId?: string;
  grade?: unknown;
  /** base64 of the exported graded image (required). */
  graded?: string;
  /** base64 of the original, pre-grade image (optional — kept for reproducibility/training). */
  original?: string;
  originalContentType?: string;
}

@Controller("api")
@UseGuards(AuthGuard)
export class CreativeController {
  // ?trainingReady=true|false filters to curated exemplars — the trainer's data pull uses it.
  @Get(":tenantId/creative/assets")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("trainingReady") trainingReady?: string) {
    await authorize(req.principal, { kind: "file", tenantId }, "read");
    const filter = trainingReady === "true" ? " AND training_ready = true" : trainingReady === "false" ? " AND training_ready = false" : "";
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT id, name, content_type, width, height, preset_id, grade, department_id,
                original_key IS NOT NULL AS has_original, original_byte_size, graded_byte_size,
                training_ready, uploader_id, created_at
         FROM creative_assets WHERE deleted_at IS NULL${filter} ORDER BY created_at DESC`,
      ),
    );
    return rows.rows;
  }

  // Curation: mark whether this asset is a good training exemplar (and/or rename it).
  @Patch(":tenantId/creative/assets/:id")
  async update(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string, @Body() body: { trainingReady?: boolean; name?: string }) {
    await authorize(req.principal, { kind: "file", tenantId }, "create");
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (typeof body?.trainingReady === "boolean") { sets.push(`training_ready = $${sets.length + 1}`); vals.push(body.trainingReady); }
    if (typeof body?.name === "string" && body.name.trim()) { sets.push(`name = $${sets.length + 1}`); vals.push(body.name.trim()); }
    if (sets.length === 0) throw new BadRequestException("nothing to update");
    vals.push(id);
    const res = await withTenants([tenantId], (c) =>
      c.query(`UPDATE creative_assets SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length} AND deleted_at IS NULL RETURNING id, training_ready, name`, vals),
    );
    if (!res.rows[0]) throw new NotFoundException("asset not found");
    await writeActivity(tenantId, req.principal.userId, "updated", "creative_asset", id, { trainingReady: body.trainingReady });
    return res.rows[0];
  }

  @Post(":tenantId/creative/assets")
  @HttpCode(201)
  async save(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: SaveBody) {
    const b = body ?? {};
    if (!b.name) throw new BadRequestException("name required");
    if (!b.graded) throw new BadRequestException("graded image content required");
    const grade = validateGrade(b.grade);
    await authorize(req.principal, { kind: "file", tenantId }, "create");

    const id = newId();
    const gradedBytes = decodeImage(b.graded, "graded");
    const gradedKey = `${tenantId}/creative/${id}`;
    await storage().put(gradedKey, gradedBytes);

    let originalKey: string | null = null;
    let originalSize = 0;
    if (b.original) {
      const originalBytes = decodeImage(b.original, "original");
      originalKey = `${tenantId}/creative/${id}.orig`;
      originalSize = originalBytes.byteLength;
      await storage().put(originalKey, originalBytes);
    }

    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO creative_assets
           (id, tenant_id, uploader_id, department_id, name, content_type, width, height, preset_id,
            grade, original_key, original_content_type, original_byte_size, graded_key, graded_byte_size, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          id, tenantId, req.principal.userId, b.departmentId ?? null, b.name,
          b.contentType ?? "image/webp", b.width ?? null, b.height ?? null, b.presetId ?? "custom",
          JSON.stringify(grade), originalKey, b.originalContentType ?? null, originalSize,
          gradedKey, gradedBytes.byteLength, config.originSite,
        ],
      ),
    );
    await writeActivity(tenantId, req.principal.userId, "graded", "creative_asset", id, { name: b.name, presetId: b.presetId ?? "custom" });
    return { id, gradedByteSize: gradedBytes.byteLength, originalByteSize: originalSize };
  }

  @Get(":tenantId/creative/assets/:id")
  async metadata(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "file", tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT id, name, content_type, width, height, preset_id, grade, department_id,
                original_key IS NOT NULL AS has_original, original_byte_size, graded_byte_size,
                training_ready, uploader_id, created_at
         FROM creative_assets WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      ),
    );
    if (!rows.rows[0]) throw new NotFoundException("asset not found");
    return rows.rows[0];
  }

  @Get(":tenantId/creative/assets/:id/content")
  async graded(@Req() req: FastifyRequest, @Res() reply: FastifyReply, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await this.stream(req, reply, tenantId, id, "graded");
  }

  // The original, pre-grade bytes — used to reprocess or to build AI training pairs (phase 2).
  @Get(":tenantId/creative/assets/:id/original")
  async original(@Req() req: FastifyRequest, @Res() reply: FastifyReply, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await this.stream(req, reply, tenantId, id, "original");
  }

  private async stream(req: FastifyRequest, reply: FastifyReply, tenantId: string, id: string, which: "graded" | "original") {
    await authorize(req.principal, { kind: "file", tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query<{ graded_key: string; original_key: string | null; content_type: string; original_content_type: string | null; name: string }>(
        `SELECT graded_key, original_key, content_type, original_content_type, name FROM creative_assets WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      ),
    );
    const a = rows.rows[0];
    if (!a) throw new NotFoundException("asset not found");
    const key = which === "graded" ? a.graded_key : a.original_key;
    if (!key) throw new NotFoundException("no stored content");
    const type = which === "graded" ? a.content_type : (a.original_content_type ?? "application/octet-stream");
    const bytes = await storage().get(key);
    await reply
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox; default-src 'none'")
      .type(type || "application/octet-stream")
      .send(bytes);
  }

  @Delete(":tenantId/creative/assets/:id")
  async remove(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "file", tenantId }, "delete");
    const rows = await withTenants([tenantId], (c) =>
      c.query<{ graded_key: string; original_key: string | null }>(
        `SELECT graded_key, original_key FROM creative_assets WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      ),
    );
    const a = rows.rows[0];
    if (!a) throw new NotFoundException("asset not found");
    await withTenants([tenantId], (c) => c.query(`UPDATE creative_assets SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]));
    if (a.graded_key) await storage().del(a.graded_key);
    if (a.original_key) await storage().del(a.original_key);
    await writeActivity(tenantId, req.principal.userId, "deleted", "creative_asset", id);
    return { id, deleted: true };
  }
}
