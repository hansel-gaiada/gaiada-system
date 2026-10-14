// The Asset Library's SAVE path (`creative_assets`), as ONE function, so that every writer takes the same road.
//
// It was the body of `POST /api/:t/creative/assets` (creative.controller.ts, DW-6h §35.2). DW-6k (§36.4) needs the same
// save for a Figma export, which must become a new VERSION of the link's group exactly as an upload does, so the body moved
// here unchanged and both callers use it. Nothing about its behaviour changed:
//   * the graded bytes (and the original, when given) are stored first, under keys derived from the new asset id;
//   * with `versionOf`, the transaction locks the group's first row, takes the next version number, inherits the latest
//     version's department unless one is named, and closes an open review round as `superseded`;
//   * a failed save removes the bytes it stored, best effort;
//   * activity rows are written after the commit.
// Authorisation, body validation and `versionOf` parsing stay with the caller: this function trusts what it is handed.
import type { PoolClient } from "pg";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { writeActivity } from "./http";
import { storage } from "./storage";
import * as rv from "./creative-reviews";

export interface SaveAssetInput {
  tenantId: string;
  userId: string;
  name: string;
  contentType: string;
  width: number | null;
  height: number | null;
  presetId: string;
  /** undefined or null: no department named (a new version then inherits its group's). */
  departmentId?: string | null;
  /** The reproducibility record, stored as jsonb. The caller has validated it. */
  grade: unknown;
  graded: Buffer;
  original: Buffer | null;
  originalContentType: string | null;
  /** A validated asset id (any version of the group), or null for a new asset. */
  versionOf: string | null;
  hooks?: {
    /** Runs FIRST inside the transaction and may replace `versionOf` (a Figma export reads its link's group here, under the
     *  link row's lock, so two first exports cannot start two groups). */
    beforeInsert?: (c: PoolClient) => Promise<{ versionOf: string | null }>;
    /** Runs inside the same transaction after the row (and any supersede) is written. */
    afterInsert?: (c: PoolClient, saved: { id: string; versionGroupId: string; versionNo: number }) => Promise<void>;
  };
}

export interface SavedAsset {
  id: string;
  gradedByteSize: number;
  originalByteSize: number;
  versionNo: number;
  versionGroupId: string;
  supersedesId: string | null;
}

export async function saveCreativeAsset(input: SaveAssetInput): Promise<SavedAsset> {
  const { tenantId, userId } = input;
  const id = newId();
  const gradedKey = `${tenantId}/creative/${id}`;
  await storage().put(gradedKey, input.graded);

  let originalKey: string | null = null;
  let originalSize = 0;
  if (input.original) {
    originalKey = `${tenantId}/creative/${id}.orig`;
    originalSize = input.original.byteLength;
    await storage().put(originalKey, input.original);
  }

  let versionOf = input.versionOf;
  let out: { versionNo: number; versionGroupId: string; supersedesId: string | null; superseded: { round: number } | null };
  try {
    out = await rv.mapCreativeRules(() =>
      withTenants([tenantId], async (c) => {
        if (input.hooks?.beforeInsert) versionOf = (await input.hooks.beforeInsert(c)).versionOf;
        let versionNo = 1;
        let groupId: string | null = null;
        let supersedesId: string | null = null;
        let departmentId: string | null = input.departmentId ?? null;
        let superseded: { round: number } | null = null;
        if (versionOf) {
          const ref = await rv.loadAssetRef(c, tenantId, versionOf);
          if (!ref) throw rv.assetNotFound();
          await rv.lockGroup(c, tenantId, ref.group_id);
          // Re-read under the lock: a concurrent delete of the named version is committed now or not at all.
          const now = await rv.loadAssetRef(c, tenantId, versionOf);
          if (!now || now.deleted_at) throw rv.assetDeleted();
          const latest = await rv.latestLiveVersion(c, tenantId, ref.group_id);
          if (!latest) throw rv.assetDeleted();
          versionNo = await rv.nextVersionNo(c, tenantId, ref.group_id);
          groupId = ref.group_id;
          supersedesId = latest.id;
          if (input.departmentId === undefined || input.departmentId === null) departmentId = latest.department_id;
        }
        await c.query(
          `INSERT INTO creative_assets
             (id, tenant_id, uploader_id, department_id, name, content_type, width, height, preset_id,
              grade, original_key, original_content_type, original_byte_size, graded_key, graded_byte_size, origin_site,
              version_group_id, version_no, supersedes_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [
            id, tenantId, userId, departmentId, input.name,
            input.contentType, input.width, input.height, input.presetId,
            JSON.stringify(input.grade), originalKey, input.originalContentType, originalSize,
            gradedKey, input.graded.byteLength, config.originSite,
            groupId, versionNo, supersedesId,
          ],
        );
        // §35.3: a new version supersedes the open round, in this same transaction (the group lock is held).
        if (groupId) {
          const closed = await rv.supersedeOpenRound(c, tenantId, groupId);
          if (closed) superseded = { round: closed.round };
        }
        const result = { versionNo, versionGroupId: groupId ?? id, supersedesId, superseded };
        if (input.hooks?.afterInsert) await input.hooks.afterInsert(c, { id, versionGroupId: result.versionGroupId, versionNo });
        return result;
      }),
    );
  } catch (e) {
    // Nothing was committed: do not leave the bytes behind.
    await storage().del(gradedKey).catch(() => undefined);
    if (originalKey) await storage().del(originalKey).catch(() => undefined);
    throw e;
  }

  await writeActivity(tenantId, userId, "graded", "creative_asset", id, {
    name: input.name, presetId: input.presetId,
    ...(versionOf ? { versionOf, versionNo: out.versionNo, versionGroupId: out.versionGroupId } : {}),
  });
  if (out.superseded) {
    await writeActivity(tenantId, userId, "review_superseded", "creative_asset", out.versionGroupId, {
      round: out.superseded.round, byVersion: id, versionNo: out.versionNo,
    });
  }
  return {
    id, gradedByteSize: input.graded.byteLength, originalByteSize: originalSize,
    versionNo: out.versionNo, versionGroupId: out.versionGroupId, supersedesId: out.supersedesId,
  };
}
