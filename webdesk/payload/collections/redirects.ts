// webdesk/payload/collections/redirects.ts
//
// WSK-06 — §05 v1.1's "redirects + sitemap as a standard collection" amendment.
//
// Modelled per migrations/0002_content.sql's OWN header comment: "Redirects/sitemap/robots are
// deliberately NOT new tables here ... §05's amendment models them as data inside the generic
// collections/content_items mechanism ('a fixed redirect collection') ... this file adds no
// bespoke table for them, on purpose." Honouring that: a redirect is a `content_items` row in
// the fixed `redirect` collection —
//   - `slug`          = the from-path (unique per site+locale+collection, exactly like any
//                        other item; redirects are not localized in v1, so they always live in
//                        the tenant's default locale)
//   - `seo.redirect`  = { toPath, status, active } — `seo` is already part of the frozen
//                        envelope as free-form jsonb, so this adds NO envelope shape, no new
//                        block type, and no new migration.
//   - `blocks`        = [] always; a redirect is never page content and never flows through the
//                        block vocabulary.
import type { PoolClient } from 'pg'
import { withTenant } from './db.ts'
import type { ResolvedApiKey } from './auth.ts'
import { resolveRequestedLocale } from '../vocabulary/locale.ts'

export const REDIRECT_COLLECTION_KEY = 'redirect'

export type RedirectStatus = 301 | 302 | 307 | 308

export interface RedirectRecord {
  fromPath: string
  toPath: string
  status: RedirectStatus
  active: boolean
}

/** Layer-2 composition-as-data for the fixed redirect collection (idempotent: reuses an existing row). */
export async function ensureRedirectCollection(client: PoolClient, tenantId: string, siteId: string): Promise<string> {
  const { rows } = await client.query(`SELECT id FROM collections WHERE site_id = $1 AND key = $2`, [
    siteId,
    REDIRECT_COLLECTION_KEY,
  ])
  if (rows[0]) return rows[0].id

  const schema = {
    fields: [
      { name: 'toPath', primitive: 'text', required: true },
      { name: 'status', primitive: 'select', options: ['301', '302', '307', '308'] },
      // No boolean primitive exists in the frozen 8 (§05) — 'active' is modelled as a closed
      // select, same pattern content_items.publish_state already uses at the DB layer.
      { name: 'active', primitive: 'select', options: ['true', 'false'] },
    ],
  }
  const { rows: created } = await client.query(
    `INSERT INTO collections (tenant_id, site_id, key, schema) VALUES ($1, $2, $3, $4) RETURNING id`,
    [tenantId, siteId, REDIRECT_COLLECTION_KEY, JSON.stringify(schema)],
  )
  return created[0].id
}

export async function createRedirect(args: {
  auth: ResolvedApiKey
  fromPath: string
  toPath: string
  status: RedirectStatus
  active: boolean
}): Promise<RedirectRecord> {
  return withTenant(args.auth.tenantId, async (client) => {
    const collectionId = await ensureRedirectCollection(client, args.auth.tenantId, args.auth.siteId)
    const locale = args.auth.tenantDefaultLocale
    await client.query(
      `INSERT INTO content_items (tenant_id, site_id, collection_id, locale, slug, blocks, seo, publish_state)
       VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, $6, 'published')
       ON CONFLICT (collection_id, locale, slug) DO UPDATE SET seo = EXCLUDED.seo`,
      [
        args.auth.tenantId,
        args.auth.siteId,
        collectionId,
        locale,
        args.fromPath,
        JSON.stringify({ redirect: { toPath: args.toPath, status: String(args.status), active: String(args.active) } }),
      ],
    )
    return { fromPath: args.fromPath, toPath: args.toPath, status: args.status, active: args.active }
  })
}

export async function listRedirects(args: { auth: ResolvedApiKey; activeOnly: boolean }): Promise<RedirectRecord[]> {
  return withTenant(args.auth.tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT ci.slug, ci.seo
         FROM content_items ci
         JOIN collections c ON c.id = ci.collection_id
        WHERE c.site_id = $1 AND c.key = $2`,
      [args.auth.siteId, REDIRECT_COLLECTION_KEY],
    )
    const records = (rows as Array<{ slug: string; seo: { redirect?: { toPath: string; status: string; active: string } } }>)
      .map((r) => {
        const rd = r.seo?.redirect
        if (!rd) return null
        const record: RedirectRecord = {
          fromPath: r.slug,
          toPath: rd.toPath,
          status: Number(rd.status ?? 301) as RedirectStatus,
          active: rd.active === 'true' || (rd.active as unknown) === true,
        }
        return record
      })
      .filter((r): r is RedirectRecord => r !== null)
    return args.activeOnly ? records.filter((r) => r.active) : records
  })
}

/**
 * §05 v1.1's other addition: "a generated sitemap.xml per locale". Enumerates every
 * effectively-published item across every non-`redirect` collection for the site, in the
 * resolved locale. Uses the site's PRODUCTION environment domain (environments.domain) when one
 * has been set; falls back to root-relative <loc> entries for a pre-launch tenant that has none
 * yet (still valid sitemap XML, just without a scheme+host).
 */
export async function renderSitemapXml(args: { auth: ResolvedApiKey; locale: string | null }): Promise<string> {
  const locale = resolveRequestedLocale(args.locale, args.auth.tenantDefaultLocale)

  return withTenant(args.auth.tenantId, async (client) => {
    const { rows: domainRows } = await client.query(
      `SELECT domain FROM environments WHERE site_id = $1 AND name = 'production'`,
      [args.auth.siteId],
    )
    const domain = domainRows[0]?.domain as string | null | undefined
    const base = domain ? `https://${domain}` : ''

    const { rows } = await client.query(
      `SELECT c.key AS collection_key, ci.slug, ci.updated_at
         FROM content_items ci
         JOIN collections c ON c.id = ci.collection_id
        WHERE c.site_id = $1 AND ci.locale = $2 AND c.key <> $3
          AND (
            (ci.publish_state = 'published' AND (ci.unpublish_at IS NULL OR ci.unpublish_at > now()))
            OR (ci.publish_state = 'scheduled' AND ci.publish_at IS NOT NULL AND ci.publish_at <= now()
                AND (ci.unpublish_at IS NULL OR ci.unpublish_at > now()))
          )
        ORDER BY c.key, ci.slug`,
      [args.auth.siteId, locale, REDIRECT_COLLECTION_KEY],
    )

    const urls = (rows as Array<{ collection_key: string; slug: string; updated_at: string }>)
      .map(
        (r) =>
          `  <url><loc>${escapeXml(`${base}/${r.collection_key}/${r.slug}`)}</loc>` +
          `<lastmod>${new Date(r.updated_at).toISOString()}</lastmod></url>`,
      )
      .join('\n')

    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
  })
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
