// webdesk/payload/vocabulary/locale.ts
//
// WSK-06 — the locale rules (webdesk-design.md §05 v1.1, WSK-D18): "A tenant declares its locale
// set and a default at provisioning; every content read resolves to exactly one locale
// (?locale=, else the tenant default) and never mixes. A missing translation falls back to the
// default locale and says so in meta.x.localeFallback — silently serving the wrong language is
// worse than an honest fallback flag."

/** Resolves what locale a request is FOR, before we know whether that locale has the content. */
export function resolveRequestedLocale(requested: string | null, tenantDefaultLocale: string): string {
  return requested && requested.trim().length > 0 ? requested.trim() : tenantDefaultLocale
}

export interface LocaleFallback {
  requested: string
  served: string
  defaultLocale: string
}

/**
 * Null when the served locale IS the one requested (no fallback happened) — meta.x stays `{}` in
 * that case, per the envelope's "additive forever" extension-namespace rule (nothing is ever
 * present-but-empty as a way of saying "no"). Non-null only when a fallback actually occurred.
 */
export function localeFallbackFlag(requested: string, served: string, defaultLocale: string): LocaleFallback | null {
  if (requested === served) return null
  return { requested, served, defaultLocale }
}
