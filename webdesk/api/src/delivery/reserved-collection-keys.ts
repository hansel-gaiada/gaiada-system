// WSK M3 T1 (D1) — the collection keys a tenant may NOT use, because the first path segment after
// `/v1/t/:tenantSlug/` already means something else and a collection with that key would be
// unreachable (the more specific route wins over the delivery wildcard `/v1/*`).
//
// Two sources, both pinned (WSK-46 added `preview` to the second):
//   1. Static API routes registered under `v1/t/:tenantSlug/` by other controllers (media, forms).
//      test/delivery/reserved-collection-keys.spec.ts boots the app, reads every registered route
//      and FAILS if a static first segment is missing from this list — so adding a route without
//      reserving its segment turns that test red.
//   2. Segments the delivery router itself treats specially (router.ts imports these three names, so
//      the router and this list cannot drift).
//
// Comparison is case-insensitive (see isReservedCollectionKey): the control plane refuses a key that
// differs from a reserved one only by case, so no near-miss spelling can be created either.

/** `GET /v1/t/:tenantSlug/search` — the search endpoint (router.ts). */
export const SEARCH_SEGMENT = "search";
/** `GET /v1/t/:tenantSlug/sitemap.xml` — the sitemap endpoint (router.ts). */
export const SITEMAP_SEGMENT = "sitemap.xml";

/**
 * `GET|OPTIONS /v1/t/:tenantSlug/preview/:token` — the WSK-46 draft-preview route (router.ts). It is
 * served by the delivery router, not by a Nest controller, so the boot-time route-table test cannot see
 * it; test/delivery/reserved-collection-keys.spec.ts pins this constant against the list instead.
 */
export const PREVIEW_SEGMENT = "preview";

/** Static first segments owned by other controllers under `v1/t/:tenantSlug/` (`consent`: M5-G6's consent log). */
export const API_ROUTE_SEGMENTS = ["forms", "media", "consent"] as const;

export const RESERVED_COLLECTION_KEYS: readonly string[] = [...API_ROUTE_SEGMENTS, SEARCH_SEGMENT, SITEMAP_SEGMENT, PREVIEW_SEGMENT];

export function isReservedCollectionKey(key: string): boolean {
  const k = key.toLowerCase();
  return RESERVED_COLLECTION_KEYS.some((r) => r === k);
}
