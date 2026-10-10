// webdesk/payload/vocabulary/cache-tags.ts
//
// WSK-06 — the cache-tag scheme (webdesk-design.md §05 "Cache invalidation" open item, resolved):
// `t:<tenant>` + `c:<tenant>:<collection>` + `i:<tenant>:<itemId>` on every content response, so
// a publish can purge exactly the affected tags via the purge-scoped Cloudflare token (§03
// egress allowlist — WSK-27's job to wire the actual purge call; this file only builds the tag
// set and the header, the same contract that call will consume).
export function buildCacheTags(input: { tenantSlug: string; collectionKey?: string; itemId?: string }): string[] {
  const tags = [`t:${input.tenantSlug}`]
  if (input.collectionKey) tags.push(`c:${input.tenantSlug}:${input.collectionKey}`)
  if (input.itemId) tags.push(`i:${input.tenantSlug}:${input.itemId}`)
  return tags
}

/** Cloudflare's cache-tag purge header convention: comma-separated, no spaces. */
export function cacheTagHeaderValue(tags: string[]): string {
  return tags.join(',')
}

export function applyCacheTagHeader(headers: Headers, tags: string[]): void {
  headers.set('Cache-Tag', cacheTagHeaderValue(tags))
}
