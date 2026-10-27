// M5-W1q (owner ruling WSK-D84) -- the publish-side half of the contributor upload quarantine.
//
// The serving half is MediaService.getPublicAsset: a quarantined or rejected asset is never served by the public media route,
// by id or by any guess of its path. This file is the second line: content that REFERENCES such an asset cannot be made
// public. A draft may name a quarantined asset (a contributor pastes the url of what they just uploaded, staff preview it), but
// publishing or scheduling a version whose blocks or seo carry `/media/<assetId>` of an asset that is not accepted is
// 409 media-not-accepted, listing the assets, so a page never goes live with an image that 404s and nobody is surprised by one.
//
// The needle is the one media-usage.ts documents: the canonical url of a library asset ends in `/media/<assetId>`, an asset id is
// a v4 uuid, and matching `/media/<uuid>` inside the stored JSON text finds a reference whatever the host, the transform suffix
// or the block shape, so a new block type cannot hide one. Comparison is on the lower-cased text (Postgres accepts an upper-case
// uuid in the url, and /media/<UPPER> serves the same asset).
import type { PoolClient } from "pg";
import { problems } from "./content-problem";

const MEDIA_REF_RE = /\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

/** Every distinct asset id referenced anywhere in the (JSON-serialisable) values, lower-cased, in first-occurrence order. */
export function referencedAssetIds(...values: unknown[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    const text = JSON.stringify(v ?? null).toLowerCase();
    for (const m of text.matchAll(MEDIA_REF_RE)) out.add(m[1]);
  }
  return [...out];
}

export interface UnacceptedReference {
  assetId: string;
  reviewState: string;
}

/** Of `assetIds`, the assets of this site that are not accepted (quarantined or rejected). Under the caller's tenant context (RLS). */
export async function findUnacceptedAssets(client: PoolClient, siteId: string, assetIds: string[]): Promise<UnacceptedReference[]> {
  if (assetIds.length === 0) return [];
  const { rows } = await client.query<{ id: string; review_state: string }>(
    `SELECT id, review_state FROM media_assets WHERE site_id = $1 AND id = ANY($2::uuid[]) AND review_state <> 'accepted' ORDER BY id`,
    [siteId, assetIds],
  );
  return rows.map((r) => ({ assetId: r.id, reviewState: r.review_state }));
}

/**
 * The pre-pass: one entry per item version about to go (or be scheduled to go) public. Refuses the WHOLE request, writing
 * nothing, when any of them names an asset that is not accepted.
 */
export async function assertNoUnacceptedMedia(
  client: PoolClient,
  siteId: string,
  versions: { itemIndex: number; blocks: unknown; seo: unknown }[],
): Promise<void> {
  const found: { itemIndex: number; assetId: string; reviewState: string }[] = [];
  for (const v of versions) {
    for (const a of await findUnacceptedAssets(client, siteId, referencedAssetIds(v.blocks, v.seo))) {
      found.push({ itemIndex: v.itemIndex, ...a });
    }
  }
  if (found.length === 0) return;
  const MAX_LISTED = 50;
  throw problems.conflict(
    "media-not-accepted",
    "Media not accepted",
    `${found.length} media reference(s) in this request name an upload that no staff editor has accepted (quarantined or rejected). ` +
      "Accept the upload, or replace the image, then publish again. Nothing was published.",
    { assets: found.slice(0, MAX_LISTED), total: found.length },
  );
}
