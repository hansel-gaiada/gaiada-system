// WSK-43a (owner ruling WSK-D54) — where a media asset is used: the one scan behind `media.usage` (the list)
// and `media.delete` (the 409 media-in-use refusal), so the answer a caller reads and the answer a delete is
// judged by cannot differ.
//
// WHAT "USES" MEANS. Content refers to a library image by URL (the media primitive's `{ url, ... }`), and the
// canonical URL of an asset ends in `/media/<assetId>` (media/library-asset.ts: `/v1/t/<slug>/media/<id>`,
// optionally with a host in front or `/transform?w=` behind). The asset id is a v4 uuid, so the needle
// `/media/<assetId>` cannot match anything else, and matching it as a SUBSTRING of the stored JSON text finds
// the reference whatever the host, the transform suffix or the block shape (a `media` field, a richText
// image, an seo image): nothing here knows the block vocabulary, so a new block type cannot hide a reference.
// A needle with LIKE metacharacters is impossible (a uuid), and strpos is used rather than LIKE anyway. The
// comparison is on the LOWER-CASED text: Postgres accepts an upper-case uuid in the URL, so `/media/<UPPER>`
// serves the same asset and must count as the same reference.
//
// WHICH CONTENT. Every non-deleted item of the asset's site, and three places an item's content lives:
//   live       the live projection (content_items.blocks/seo) of an item that is published or scheduled: what
//              the /v1 read path serves now or will serve when the schedule fires;
//   head       the item's HEAD version (content_versions at head_version), its working draft: deleting an
//              image a draft still shows would break it silently at the next publish (D54: "live or draft");
//   scheduled  the version of a pending live-item swap (content_schedules, WSK-61): it goes live without
//              anyone touching the item again.
// A soft-deleted item is not a reference. The `seo` of each is scanned too (an og:image is an image).
// An item's projection while it is a draft or unpublished is only a copy of some head, so it is not counted:
// "unpublished, and no version refers to it" is a deletable asset.
//
// KNOWN LIMIT (reported, not hidden): the scan is a snapshot. A content write that saves a draft naming the
// asset in the same instant as the delete commits can slip past it (content writes do not lock the assets they
// name, and there is no content-side media validation yet). The effect is a draft with an image that 404s
// until the editor picks another, never a published page.
import type { PoolClient } from "pg";

export type MediaUsageKind = "live" | "head" | "scheduled";

export interface MediaUsageItem {
  itemId: string;
  collectionKey: string;
  locale: string;
  slug: string;
  /** Where the asset is referenced, at least one of live / head / scheduled. */
  in: MediaUsageKind[];
}

export interface MediaUsage {
  /** The items that reference the asset, at most `limit`, in (collection, slug, locale) order. */
  items: MediaUsageItem[];
  /** How many items reference it in all (can exceed items.length). */
  total: number;
}

/** The most items a usage answer or a media-in-use problem lists. */
export const MEDIA_USAGE_LIMIT = 50;

/** The substring that marks a reference to the asset inside stored content JSON. */
export function assetNeedle(assetId: string): string {
  return `/media/${assetId.toLowerCase()}`;
}

/**
 * The scan. `client` is the caller's transaction under the tenant's `webdesk.tenant_ctx` (RLS is the wall);
 * `siteId` and `tenantId` are the second wall. The assetId must already be a validated uuid.
 */
export async function findMediaUsage(
  client: PoolClient,
  p: { tenantId: string; siteId: string; assetId: string; limit?: number },
): Promise<MediaUsage> {
  const needle = assetNeedle(p.assetId);
  const limit = p.limit ?? MEDIA_USAGE_LIMIT;
  const { rows } = await client.query<{
    item_id: string;
    collection_key: string;
    locale: string;
    slug: string;
    in_live: boolean;
    in_head: boolean;
    in_scheduled: boolean;
    total: string;
  }>(
    `SELECT t.*, count(*) OVER () AS total FROM (
       SELECT ci.id AS item_id, c.key AS collection_key, ci.locale, ci.slug,
              (ci.publish_state IN ('published', 'scheduled')
                 AND (strpos(lower(ci.blocks::text), $3) > 0 OR strpos(lower(ci.seo::text), $3) > 0)) AS in_live,
              EXISTS (SELECT 1 FROM content_versions v
                       WHERE v.content_item_id = ci.id AND v.version = ci.head_version AND v.tenant_id = $1
                         AND (strpos(lower(v.blocks::text), $3) > 0 OR strpos(lower(v.seo::text), $3) > 0)) AS in_head,
              EXISTS (SELECT 1 FROM content_schedules s
                        JOIN content_versions v ON v.content_item_id = s.content_item_id AND v.version = s.version
                       WHERE s.content_item_id = ci.id AND s.tenant_id = $1
                         AND s.executed_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL
                         AND (strpos(lower(v.blocks::text), $3) > 0 OR strpos(lower(v.seo::text), $3) > 0)) AS in_scheduled
         FROM content_items ci
         JOIN collections c ON c.id = ci.collection_id
        WHERE ci.site_id = $2 AND ci.tenant_id = $1 AND ci.deleted_at IS NULL
     ) t
     WHERE t.in_live OR t.in_head OR t.in_scheduled
     ORDER BY t.collection_key, t.slug, t.locale, t.item_id
     LIMIT $4`,
    [p.tenantId, p.siteId, needle, limit],
  );
  return {
    items: rows.map((r) => ({
      itemId: r.item_id,
      collectionKey: r.collection_key,
      locale: r.locale,
      slug: r.slug,
      in: [r.in_live ? "live" : null, r.in_head ? "head" : null, r.in_scheduled ? "scheduled" : null].filter((k): k is MediaUsageKind => k !== null),
    })),
    total: rows.length === 0 ? 0 : Number(rows[0].total),
  };
}
