// webdesk/payload/collections/content-read.ts
//
// WSK-06 — the read paths behind the frozen /v1 envelope: single item, cursor-paginated list,
// and tsvector search. All three share one visibility rule (scheduled publishing, §05 v1.1) and
// one pagination mechanism (cursor on immutable columns, stable under concurrent publish).
import type { PoolClient } from 'pg'
import { withTenant } from './db.ts'
import type { ResolvedApiKey } from './auth.ts'
import {
  buildItemEnvelope,
  buildListEnvelope,
  type ItemEnvelope,
  type ListEnvelope,
  type LocalizationLink,
} from '../vocabulary/envelope.ts'
import { resolveRequestedLocale, localeFallbackFlag } from '../vocabulary/locale.ts'

/**
 * A content_items row is "effectively visible" (§05 v1.1 scheduled-publishing amendment) when:
 *   - publish_state='published' and it has not reached its unpublish_at yet, OR
 *   - publish_state='scheduled' and publish_at has arrived and unpublish_at has not.
 * Computed in SQL — not app code — so `now()` is the database's own clock and every concurrent
 * reader agrees on which side of "now" a row sits, consistent with 0002_content.sql's own
 * `CHECK (unpublish_at IS NULL OR publish_at IS NULL OR unpublish_at > publish_at)`.
 *
 * On the worker (§05: "honoured by the worker"): this expression makes every /v1 read correct
 * regardless of whether a background job has ever flipped `publish_state` from 'scheduled' to
 * 'published'. A worker that performs that column flip (for admin-UI display, audit trails,
 * etc.) is a separate, not-yet-built piece belonging to the `worker` service (WSK-07/11's
 * ownership, not this ticket's `payload/` scope) — flagged in the final report as a follow-up,
 * not a defect in this read path.
 */
const EFFECTIVE_PUBLISHED_SQL = `(
  (ci.publish_state = 'published' AND (ci.unpublish_at IS NULL OR ci.unpublish_at > now()))
  OR (ci.publish_state = 'scheduled' AND ci.publish_at IS NOT NULL AND ci.publish_at <= now()
      AND (ci.unpublish_at IS NULL OR ci.unpublish_at > now()))
)`

interface ContentRow {
  id: string
  slug: string
  locale: string
  blocks: unknown
  seo: Record<string, unknown> | null
  publish_state: string
  publish_at: string | null
  unpublish_at: string | null
  created_at: string
  /** Postgres's own text rendering of created_at, full microsecond precision — see encodeCursor. */
  created_at_raw: string
  updated_at: string
  localization_group_id: string
  effective_published: boolean
}

/**
 * Cursor = base64url(`${created_at_raw}|${id}`). Ordering by (created_at, id) — both IMMUTABLE
 * once a row exists — rather than updated_at is what makes pagination stable under concurrent
 * publish (design §06 AC): a publish/unpublish flips `publish_state`/`updated_at`, never
 * `created_at` or `id`, so a row already handed to a client keeps its exact position in the
 * sequence regardless of what happens to any row (including itself) after the cursor was minted.
 *
 * Deliberately built from `created_at_raw` (`ci.created_at::text`, selected alongside `ci.*` in
 * every query below) rather than the `ci.*`-derived `created_at`, which `pg` parses into a JS
 * `Date` — millisecond precision only. Postgres's own `timestamptz` carries MICROSECOND
 * precision, so a boundary row whose true value is `...:28.847123+00` compares strictly GREATER
 * than a cursor truncated to `...:28.847Z`, and gets handed back a second time on the very next
 * page (reproduced live: `post-1` reappeared as the first item of page 2, a straight duplicate
 * the "stable under concurrent publish" AC exists to catch). Round-tripping through Postgres's
 * OWN text format instead of a JS Date avoids any precision loss in either direction.
 */
function encodeCursor(row: { created_at_raw: string; id: string }): string {
  return Buffer.from(`${row.created_at_raw}|${row.id}`, 'utf8').toString('base64url')
}
function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
    const sep = decoded.indexOf('|')
    if (sep < 0) return null
    return { createdAt: decoded.slice(0, sep), id: decoded.slice(sep + 1) }
  } catch {
    return null
  }
}

async function loadCollectionId(client: PoolClient, siteId: string, collectionKey: string): Promise<string | null> {
  const { rows } = await client.query(`SELECT id FROM collections WHERE site_id = $1 AND key = $2`, [
    siteId,
    collectionKey,
  ])
  return rows[0]?.id ?? null
}

async function loadLocalizations(
  client: PoolClient,
  groupId: string,
  currentLocale: string,
  productionOnly: boolean,
): Promise<LocalizationLink[]> {
  const { rows } = await client.query(
    `SELECT ci.locale, ci.slug FROM content_items ci
      WHERE ci.localization_group_id = $1 AND ci.locale <> $2
        AND ($3::boolean = false OR ${EFFECTIVE_PUBLISHED_SQL})
      ORDER BY ci.locale`,
    [groupId, currentLocale, productionOnly],
  )
  return rows.map((r: { locale: string; slug: string }) => ({ locale: r.locale, slug: r.slug }))
}

function toEnvelope(
  row: ContentRow,
  collectionKey: string,
  localizations: LocalizationLink[],
  localeInfo: { requested: string; served: string; defaultLocale: string },
): ItemEnvelope {
  const fallback = localeFallbackFlag(localeInfo.requested, localeInfo.served, localeInfo.defaultLocale)
  return buildItemEnvelope({
    collectionKey,
    slug: row.slug,
    locale: row.locale,
    localizations,
    seo: (row.seo ?? {}) as Record<string, unknown>,
    // content_items carries no dedicated "first became published" audit column (only the
    // scheduling timestamps + updated_at) — publishedAt is a documented approximation
    // (publish_at when the row was ever scheduled, else created_at), flagged in the final report
    // as an interpretation, not a schema defect requiring new DDL against a frozen migration.
    publishedAt: row.effective_published ? row.publish_at ?? row.created_at : null,
    updatedAt: row.updated_at,
    draft: !row.effective_published,
    x: fallback ? { localeFallback: fallback } : {},
    blocks: Array.isArray(row.blocks) ? (row.blocks as Array<{ type: string; props: Record<string, unknown> }>) : [],
  })
}

export interface GetItemArgs {
  auth: ResolvedApiKey
  collectionKey: string
  slug: string
  locale: string | null
}

export async function getItem(args: GetItemArgs): Promise<{ id: string; envelope: ItemEnvelope } | null> {
  const productionOnly = args.auth.envName === 'production'
  const requestedLocale = args.locale
  const servedLocaleCandidate = resolveRequestedLocale(requestedLocale, args.auth.tenantDefaultLocale)

  return withTenant(args.auth.tenantId, async (client) => {
    const collectionId = await loadCollectionId(client, args.auth.siteId, args.collectionKey)
    if (!collectionId) return null

    const fetchOne = async (locale: string): Promise<ContentRow | null> => {
      const { rows } = await client.query<ContentRow>(
        `SELECT ci.*, ci.created_at::text AS created_at_raw, ${EFFECTIVE_PUBLISHED_SQL} AS effective_published
           FROM content_items ci
          WHERE ci.collection_id = $1 AND ci.locale = $2 AND ci.slug = $3
            AND ($4::boolean = false OR ${EFFECTIVE_PUBLISHED_SQL})`,
        [collectionId, locale, args.slug, productionOnly],
      )
      return rows[0] ?? null
    }

    let row = await fetchOne(servedLocaleCandidate)
    let servedLocale = servedLocaleCandidate
    // §05 locale rule: fall back to the tenant default when the requested locale has no
    // translation of THIS slug — never mix locales within one response, and always say so.
    if (!row && requestedLocale && requestedLocale !== args.auth.tenantDefaultLocale) {
      row = await fetchOne(args.auth.tenantDefaultLocale)
      servedLocale = args.auth.tenantDefaultLocale
    }
    if (!row) return null

    const localizations = await loadLocalizations(client, row.localization_group_id, servedLocale, productionOnly)
    const envelope = toEnvelope(row, args.collectionKey, localizations, {
      requested: requestedLocale ?? args.auth.tenantDefaultLocale,
      served: servedLocale,
      defaultLocale: args.auth.tenantDefaultLocale,
    })
    return { id: row.id, envelope }
  })
}

export interface ListItemsArgs {
  auth: ResolvedApiKey
  collectionKey: string
  locale: string | null
  cursor: string | null
  limit: number
  expandBlocks: boolean
}

export async function listItems(args: ListItemsArgs): Promise<ListEnvelope> {
  const productionOnly = args.auth.envName === 'production'
  const servedLocale = resolveRequestedLocale(args.locale, args.auth.tenantDefaultLocale)

  return withTenant(args.auth.tenantId, async (client) => {
    const collectionId = await loadCollectionId(client, args.auth.siteId, args.collectionKey)
    if (!collectionId) {
      return buildListEnvelope({
        collectionKey: args.collectionKey,
        locale: servedLocale,
        items: [],
        cursor: null,
        hasMore: false,
        limit: args.limit,
      })
    }

    const cur = args.cursor ? decodeCursor(args.cursor) : null
    const params: unknown[] = [collectionId, servedLocale, productionOnly]
    let cursorClause = ''
    if (cur) {
      params.push(cur.createdAt, cur.id)
      cursorClause = `AND (ci.created_at, ci.id) > ($${params.length - 1}, $${params.length})`
    }
    params.push(args.limit + 1) // fetch one extra row to know hasMore without a second query

    const { rows } = await client.query<ContentRow>(
      `SELECT ci.*, ci.created_at::text AS created_at_raw, ${EFFECTIVE_PUBLISHED_SQL} AS effective_published
         FROM content_items ci
        WHERE ci.collection_id = $1 AND ci.locale = $2
          AND ($3::boolean = false OR ${EFFECTIVE_PUBLISHED_SQL})
          ${cursorClause}
        ORDER BY ci.created_at ASC, ci.id ASC
        LIMIT $${params.length}`,
      params,
    )

    const hasMore = rows.length > args.limit
    const page = hasMore ? rows.slice(0, args.limit) : rows
    const nextCursor = page.length > 0 ? encodeCursor(page[page.length - 1]) : null

    const items: ItemEnvelope[] = []
    for (const row of page) {
      const localizations = await loadLocalizations(client, row.localization_group_id, servedLocale, productionOnly)
      const envelope = toEnvelope(row, args.collectionKey, localizations, {
        requested: args.locale ?? args.auth.tenantDefaultLocale,
        served: servedLocale,
        defaultLocale: args.auth.tenantDefaultLocale,
      })
      // §05: "items, minus blocks unless ?expand=blocks" — list responses are lightweight by default.
      if (!args.expandBlocks) envelope.blocks = []
      items.push(envelope)
    }

    return buildListEnvelope({
      collectionKey: args.collectionKey,
      locale: servedLocale,
      items,
      cursor: hasMore ? nextCursor : null,
      hasMore,
      limit: args.limit,
    })
  })
}

export interface SearchItemsArgs {
  auth: ResolvedApiKey
  locale: string | null
  q: string
  collectionKey: string | null
  cursor: string | null
  limit: number
}

/**
 * §05 v1.1 "content search" amendment: Postgres tsvector per locale, returned in the SAME
 * envelope with the SAME cursor pagination as a normal list. Deliberately ordered by
 * (created_at, id) rather than ts_rank — a rank-ordered cursor is not stable under concurrent
 * publish (a new better-matching row can shift every subsequent page's ranking), and this
 * ticket's frozen AC is pagination stability, not relevance ranking. A `?sort=relevance`
 * non-paginated-stable mode is a reasonable WSK-14+ addition, not built here.
 */
export async function searchItems(args: SearchItemsArgs): Promise<ListEnvelope> {
  const productionOnly = args.auth.envName === 'production'
  const servedLocale = resolveRequestedLocale(args.locale, args.auth.tenantDefaultLocale)

  return withTenant(args.auth.tenantId, async (client) => {
    const params: unknown[] = [args.auth.siteId, servedLocale, productionOnly, args.q]
    let collectionFilter = ''
    if (args.collectionKey) {
      params.push(args.collectionKey)
      collectionFilter = `AND c.key = $${params.length}`
    }
    const cur = args.cursor ? decodeCursor(args.cursor) : null
    let cursorClause = ''
    if (cur) {
      params.push(cur.createdAt, cur.id)
      cursorClause = `AND (ci.created_at, ci.id) > ($${params.length - 1}, $${params.length})`
    }
    params.push(args.limit + 1)

    const { rows } = await client.query<ContentRow & { collection_key: string }>(
      `SELECT ci.*, ci.created_at::text AS created_at_raw, c.key AS collection_key, ${EFFECTIVE_PUBLISHED_SQL} AS effective_published
         FROM content_items ci
         JOIN collections c ON c.id = ci.collection_id
        WHERE c.site_id = $1 AND ci.locale = $2
          AND ($3::boolean = false OR ${EFFECTIVE_PUBLISHED_SQL})
          AND ci.search_vector @@ websearch_to_tsquery(webdesk_locale_ts_config($2), $4)
          ${collectionFilter}
          ${cursorClause}
        ORDER BY ci.created_at ASC, ci.id ASC
        LIMIT $${params.length}`,
      params,
    )

    const hasMore = rows.length > args.limit
    const page = hasMore ? rows.slice(0, args.limit) : rows
    const nextCursor = page.length > 0 ? encodeCursor(page[page.length - 1]) : null

    const items: ItemEnvelope[] = []
    for (const row of page) {
      const localizations = await loadLocalizations(client, row.localization_group_id, servedLocale, productionOnly)
      const envelope = toEnvelope(row, row.collection_key, localizations, {
        requested: args.locale ?? args.auth.tenantDefaultLocale,
        served: servedLocale,
        defaultLocale: args.auth.tenantDefaultLocale,
      })
      envelope.blocks = [] // search results are list-shaped — never inline full blocks
      items.push(envelope)
    }

    return buildListEnvelope({
      collectionKey: args.collectionKey ?? 'search',
      locale: servedLocale,
      items,
      cursor: hasMore ? nextCursor : null,
      hasMore,
      limit: args.limit,
    })
  })
}
