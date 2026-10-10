// webdesk/payload/vocabulary/envelope.ts
//
// WSK-06 — the frozen `/v1` envelope shapes (webdesk-design.md §05, v1.1/WSK-D18). Three shapes,
// identical for every tenant and every collection: the item response, the cursor-paginated
// collection-list response, and (see ./problem-details.ts) the RFC 9457 error response.
//
// THIS IS THE FREEZE. §05 hard rule 1: envelope evolution means a new `/v2` path, never a
// mutation of these shapes. Any future field addition here is itself a MAJOR vocabulary change
// unless it lands inside `meta.x` (the one namespace design §05 declares "additive forever").
export interface LocalizationLink {
  locale: string
  slug: string
}

export interface SeoShape {
  title?: string
  description?: string
  ogImage?: string
  /** Free-form beyond the three documented keys (e.g. the redirect collection's `redirect` sub-
   *  object — see collections/redirects.ts). `seo` is jsonb end to end; this type is not exhaustive. */
  [key: string]: unknown
}

export interface MetaShape {
  publishedAt: string | null
  updatedAt: string
  draft: boolean
  /** Reserved extension namespace (§05 v1.1): additive forever, never a breaking-change vector. */
  x: Record<string, unknown>
}

export interface ItemEnvelope {
  collection: string
  slug: string
  locale: string
  localizations: LocalizationLink[]
  seo: SeoShape
  meta: MetaShape
  blocks: Array<{ type: string; props: Record<string, unknown> }>
}

export interface PageInfo {
  cursor: string | null
  hasMore: boolean
  limit: number
}

export interface ListEnvelope {
  collection: string
  locale: string
  items: ItemEnvelope[]
  page: PageInfo
}

export function buildItemEnvelope(input: {
  collectionKey: string
  slug: string
  locale: string
  localizations: LocalizationLink[]
  seo: SeoShape
  publishedAt: string | null
  updatedAt: string
  draft: boolean
  x?: Record<string, unknown>
  blocks: Array<{ type: string; props: Record<string, unknown> }>
}): ItemEnvelope {
  return {
    collection: input.collectionKey,
    slug: input.slug,
    locale: input.locale,
    localizations: input.localizations,
    seo: input.seo ?? {},
    meta: {
      publishedAt: input.publishedAt,
      updatedAt: input.updatedAt,
      draft: input.draft,
      x: input.x ?? {},
    },
    blocks: input.blocks,
  }
}

export function buildListEnvelope(input: {
  collectionKey: string
  locale: string
  items: ItemEnvelope[]
  cursor: string | null
  hasMore: boolean
  limit: number
}): ListEnvelope {
  return {
    collection: input.collectionKey,
    locale: input.locale,
    items: input.items,
    page: { cursor: input.cursor, hasMore: input.hasMore, limit: input.limit },
  }
}
