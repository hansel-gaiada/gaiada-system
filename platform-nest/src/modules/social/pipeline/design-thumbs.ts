// SCP-2b — the stored thumbnail of a post's design (FRONTEND-BFF-CONTRACT §63.8 "Thumbnails", §63.1 file 10; plan §10).
//
// final_approve materializes each design as a `files` row targeting the post and remembers it on `social_post_designs.file_id`
// (pipeline-effects.ts `materializeDesignMedia`). The client's approval page and the staff feed list that picture for about
// 600 cards, so a list must not ship the full-size file: this makes a small WebP copy, stores it, files it as a second `files`
// row on the same post and remembers it on `social_post_designs.thumb_file_id`. The reads answer
// `COALESCE(thumb_file_id, file_id)` as `thumbFileId`, so a design with no thumbnail (a video, a failed resize) shows its full
// file and a NULL is never an error.
//
// BEST-EFFORT, and never on the critical path:
//   - `ensureDesignThumbs` is called after the commit and never throws; a failure is logged (`[scp]`, no file contents) and counted.
//   - `sharp` carries a native binary. It is loaded lazily, inside the function, and a load failure is caught: a missing or
//     broken binary can never stop the app from booting, it only means no thumbnails (the reads fall back to the full file).
//   - Each design is its own short transaction. The bytes are read and resized with NO connection held and no lock taken; the
//     row is written in one transaction that takes the design row's lock only for the insert and the update.
import { newId, withTenants } from "../../../db";
import { config } from "../../../config";
import { sha256Hex } from "../../../core/content-hash";
import { storage } from "../../../core/storage";

const SOCIAL = { modules: ["social"] };

/** The thumbnail fits inside this square. */
export const THUMB_MAX_PX = 640;
export const THUMB_WEBP_QUALITY = 80;

/** What `ensureDesignThumbs` did: `made` new thumbnails, `skipped` designs that need none (a video, a design that already has
 *  one by the time the lock was taken), `failed` designs it tried and could not. */
export interface ThumbResult { made: number; skipped: number; failed: number }

type SharpFactory = typeof import("sharp").default;
/** How the resizer is obtained. Replaced in a test to prove a load failure is caught; the default loads sharp lazily. */
export type SharpLoader = () => Promise<SharpFactory | null>;

/** Load `sharp` on first use. `null` (never a throw) when the native binary is missing or cannot load. */
export const loadSharp: SharpLoader = async () => {
  try {
    const mod = (await import("sharp")) as unknown as { default?: SharpFactory };
    return mod.default ?? (mod as unknown as SharpFactory);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[scp] thumbnails are off: sharp did not load (${(err as Error)?.message ?? err})`);
    return null;
  }
};

/** A content type a thumbnail is made from: a raster image. A video keeps no thumbnail; an SVG is not rasterized (the
 *  renderer follows external references, and an SVG already scales to any list). */
export function isThumbnailable(contentType: string | null | undefined): boolean {
  const ct = (contentType ?? "").toLowerCase().split(";")[0].trim();
  return ct.startsWith("image/") && ct !== "image/svg+xml";
}

/** The resize itself: the image fitted inside 640 x 640 (never enlarged), turned upright by its EXIF orientation, as WebP at
 *  quality 80. `null` when sharp is unavailable. Throws on bytes sharp cannot read (the caller counts it). */
export async function makeThumbnail(bytes: Buffer, load: SharpLoader = loadSharp): Promise<Buffer | null> {
  const sharp = await load();
  if (!sharp) return null;
  return sharp(bytes)
    .rotate()
    .resize({ width: THUMB_MAX_PX, height: THUMB_MAX_PX, fit: "inside", withoutEnlargement: true })
    .webp({ quality: THUMB_WEBP_QUALITY })
    .toBuffer();
}

/** `<original base>-thumb.webp`: the design file's name with its extension replaced. */
export function thumbName(filename: string | null | undefined): string {
  const base = (filename ?? "").replace(/[\\/]/g, "_").replace(/\.[^./\\]*$/, "").trim().slice(0, 200);
  return `${base || "design"}-thumb.webp`;
}

interface Candidate {
  design_id: string;
  file_id: string;
  filename: string;
  content_type: string;
  storage_key: string | null;
  uploader_id: string | null;
}

const warn = (msg: string) => {
  // eslint-disable-next-line no-console
  console.warn(`[scp] ${msg}`);
};

/** Make the missing thumbnails of a post's live designs. Never throws. */
export async function ensureDesignThumbs(tenantId: string, postId: string, load: SharpLoader = loadSharp): Promise<ThumbResult> {
  const result: ThumbResult = { made: 0, skipped: 0, failed: 0 };
  let candidates: Candidate[];
  try {
    candidates = (await withTenants([tenantId], (c) => c.query<Candidate>(
      `SELECT d.id::text AS design_id, f.id::text AS file_id, f.filename, f.content_type, f.storage_key, f.uploader_id::text AS uploader_id
         FROM social_post_designs d
         JOIN files f ON f.tenant_id = d.tenant_id AND f.id = d.file_id AND f.deleted_at IS NULL
        WHERE d.tenant_id = $1 AND d.post_id = $2 AND d.removed_at IS NULL AND d.file_id IS NOT NULL AND d.thumb_file_id IS NULL
        ORDER BY d.position`,
      [tenantId, postId],
    ), SOCIAL)).rows;
  } catch (err) {
    warn(`thumbnails for post ${postId}: the designs could not be read: ${(err as Error)?.message ?? err}`);
    result.failed += 1;
    return result;
  }

  for (const d of candidates) {
    if (!isThumbnailable(d.content_type) || !d.storage_key) {
      result.skipped += 1;
      continue;
    }
    let storedKey: string | null = null;
    try {
      const original = await storage().get(d.storage_key);
      const thumb = await makeThumbnail(original, load);
      if (!thumb) {
        result.failed += 1; // sharp is unavailable; already logged once by the loader
        continue;
      }
      const thumbId = newId();
      storedKey = `${tenantId}/${thumbId}`;
      await storage().put(storedKey, thumb);
      const keyToStore = storedKey;
      const made = await withTenants([tenantId], async (c) => {
        // The design row's lock keeps two runs from both filing a thumbnail, and checks the design still shows the file the
        // thumbnail was made from (a new version moves `file_id` and clears `thumb_file_id`).
        const locked = await c.query(
          `SELECT 1 FROM social_post_designs
            WHERE tenant_id = $1 AND id = $2 AND file_id = $3 AND thumb_file_id IS NULL AND removed_at IS NULL FOR UPDATE`,
          [tenantId, d.design_id, d.file_id],
        );
        if (!locked.rowCount) return false;
        await c.query(
          `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, sha256, scrubbed, origin_site)
           VALUES ($1, $2, $3, 'social_post', $4, $5, 'image/webp', $6, $7, $8, false, $9)`,
          [thumbId, tenantId, d.uploader_id, postId, thumbName(d.filename), thumb.byteLength, keyToStore, sha256Hex(thumb), config.originSite],
        );
        await c.query(`UPDATE social_post_designs SET thumb_file_id = $3 WHERE tenant_id = $1 AND id = $2`, [tenantId, d.design_id, thumbId]);
        return true;
      }, SOCIAL);
      if (made) {
        result.made += 1;
      } else {
        result.skipped += 1;
        await storage().del(storedKey).catch(() => undefined); // lost the race: nothing refers to these bytes
      }
    } catch (err) {
      result.failed += 1;
      warn(`thumbnail for design ${d.design_id} of post ${postId} failed: ${(err as Error)?.message ?? err}`);
      if (storedKey) await storage().del(storedKey).catch(() => undefined);
    }
  }
  return result;
}
