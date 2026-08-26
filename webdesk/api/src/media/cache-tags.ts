// WSK-07 — §11a: "every public asset response must carry a long Cache-Control plus the §05 cache
// tags so a CDN hit never reaches the origin ... a media path that bypasses the CDN is a defect."
//
// §05's scheme (content responses): `t:<tenant>` + `c:<tenant>:<collection>` + `i:<tenant>:<itemId>`.
// Media has no "collection" concept, so this reuses the tenant-level tag `t:<tenant>` and an
// item-level tag shaped like the content scheme's `i:` tag but namespaced `m:` (media) so a purge
// system can distinguish "purge everything for this tenant" from "purge this one asset" without
// colliding with content-item ids that happen to match an asset id.
export type CacheTagInput = { tenantSlug: string; assetId: string };

export const LONG_CACHE_CONTROL = "public, max-age=31536000, immutable";

export function buildCacheTags({ tenantSlug, assetId }: CacheTagInput): string[] {
  return [`t:${tenantSlug}`, `m:${tenantSlug}:${assetId}`];
}

/** Cloudflare's own header name for cache-tag-based purge (`Cache-Tag`); kept as one shared constant
 *  so every caller emits the identical header name. */
export const CACHE_TAG_HEADER = "Cache-Tag";
