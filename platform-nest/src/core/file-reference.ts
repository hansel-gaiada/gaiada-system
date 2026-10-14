// DW-6i — the ONE write path for a REFERENCE attachment (a `files` row with a name and an optional link, and no bytes).
//
// Extracted from `POST /api/:t/files` (files.controller.ts) so Google Drive's attach (core/google-drive, §42.5) writes through
// exactly the code the generic attach uses: the same day-one scrub of the name and the link, the same 2048-character cap on the
// link, the same INSERT, the same `attached` activity row. `files.controller` calls this with no options, so its behaviour is
// unchanged; a test pins that (files-reference.test.ts).
//
// The caller has ALREADY authorised the request and validated the target. This file only writes.
import { newId, withTenants } from "../db";
import { config } from "../config";
import { writeActivity } from "./http";
import { scrubText } from "./scrub";

export interface ReferenceFileInput {
  tenantId: string;
  uploaderId: string | null;
  targetType: string;
  targetId: string;
  filename: string;
  contentType: string;
  url: string | null;
  /** When true, a second reference with the same link on the same target is refused (returns `{ duplicate: true }`), decided
   *  and written under one advisory lock so two simultaneous attaches cannot both pass. Off for POST /files (it never did). */
  rejectDuplicateUrl?: boolean;
  /** Extra keys for the `attached` activity row (never a secret). */
  activityExtra?: Record<string, unknown>;
}

export interface ReferenceFileRow {
  id: string;
  filename: string;
  contentType: string;
  url: string | null;
  byteSize: number;
  scrubbed: boolean;
  targetType: string;
  targetId: string;
  uploaderId: string | null;
  createdAt: string;
}

export type ReferenceFileResult = { duplicate: false; file: ReferenceFileRow } | { duplicate: true };

export async function insertReferenceFile(input: ReferenceFileInput): Promise<ReferenceFileResult> {
  const cleanName = scrubText(input.filename).text;
  const cleanUrl = input.url ? scrubText(input.url).text.slice(0, 2048) : null;
  const id = newId();

  const created = await withTenants([input.tenantId], async (c): Promise<Date | null> => {
    if (input.rejectDuplicateUrl && cleanUrl) {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`file-ref:${input.targetType}:${input.targetId}:${cleanUrl}`]);
      const existing = await c.query(
        `SELECT 1 FROM files WHERE target_entity_type = $1 AND target_entity_id = $2 AND url = $3 AND deleted_at IS NULL LIMIT 1`,
        [input.targetType, input.targetId, cleanUrl],
      );
      if (existing.rows.length) return null;
    }
    const ins = await c.query<{ created_at: Date }>(
      `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, url, scrubbed, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, NULL, $8, false, $9) RETURNING created_at`,
      [id, input.tenantId, input.uploaderId, input.targetType, input.targetId, cleanName, input.contentType, cleanUrl, config.originSite],
    );
    return ins.rows[0].created_at;
  });
  if (!created) return { duplicate: true };

  await writeActivity(input.tenantId, input.uploaderId, "attached", input.targetType, input.targetId, {
    fileId: id,
    filename: cleanName,
    ...(input.activityExtra ?? {}),
  });
  return {
    duplicate: false,
    file: {
      id, filename: cleanName, contentType: input.contentType, url: cleanUrl, byteSize: 0, scrubbed: false,
      targetType: input.targetType, targetId: input.targetId, uploaderId: input.uploaderId,
      createdAt: created instanceof Date ? created.toISOString() : String(created),
    },
  };
}
