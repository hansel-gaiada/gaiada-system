// webdesk/api/src/delivery/redirects.ts
//
// WSK-48a — the READ half of webdesk/payload/collections/redirects.ts (WSK-06), moved verbatim: the
// sitemap.xml renderer and the fixed redirect collection's key. The WRITE half
// (ensureRedirectCollection / createRedirect / listRedirects) is deliberately NOT moved: nothing on
// the /v1 read path calls it (it only exists for the envelope-contract test's seeding), and
// authoring is the WSK-41 command surface's job, not the delivery module's. See the WSK-48a report.
//
// Modelled per migrations/0002_content.sql's own header: a redirect is a content_items row in the
// fixed 'redirect' collection (slug = from-path, seo.redirect = { toPath, status, active }), so the
// sitemap excludes that collection by key.
import type { DeliveryDb } from './db'
import type { ResolvedApiKey } from './auth'
import { resolveRequestedLocale } from './vocabulary/locale'

export const REDIRECT_COLLECTION_KEY = 'redirect'

/**
 * §05 v1.1's other addition: "a generated sitemap.xml per locale". Enumerates every
 * effectively-published item across every non-`redirect` collection for the site, in the
 * resolved locale. Uses the site's PRODUCTION environment domain (environments.domain) when one
 * has been set; falls back to root-relative <loc> entries for a pre-launch tenant that has none
 * yet (still valid sitemap XML, just without a scheme+host).
 */
export async function renderSitemapXml(db: DeliveryDb, args: { auth: ResolvedApiKey; locale: string | null }): Promise<string> {
  const locale = resolveRequestedLocale(args.locale, args.auth.tenantDefaultLocale)

  return db.withTenant(args.auth.tenantId, async (client) => {
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
