// webdesk/api/src/delivery/preview-read.ts
//
// WSK-46 (owner ruling WSK-D52) — the read behind GET /v1/t/:tenantSlug/preview/:token: the ONE version
// a draft-preview token pins, as the frozen ITEM envelope.
//
// The envelope is built by content-read.ts's own toEnvelope(), the same builder the
// `/v1/t/:tenant/:collection/:slug` route uses, from the pinned content_versions row's blocks and seo
// (never the live projection) and the item's collection/locale/slug/meta. Nothing in the envelope shape
// changes.
//
// ONE QUERY DECIDES, and it is deliberately all-or-nothing. A token is honoured only if, under the
// tenant's own webdesk.tenant_ctx (so another tenant's row is invisible to this query by RLS, not by
// application care), a row exists with:
//   - token_hash = sha256(presented token)   — the hash lookup IS the comparison; plaintext is never held,
//                                              never compared, never logged;
//   - revoked_at IS NULL and expires_at > now() — the database's clock, so every replica agrees;
//   - an item that is not soft-deleted, in the same tenant and the same site as the token, whose pinned
//     version row exists.
// Every other outcome, whatever the reason, is the same `null`: the route answers one identical 404, so
// the endpoint cannot be used to learn why a token failed, or whether a slug, tenant or item exists.
//
// `localizations` lists only LIVE siblings (what a production key would see), not drafts: a preview link
// exposes one draft, and must not disclose that other unpublished items, or their slugs, exist.
// `meta.draft` is true unless the pinned version IS the version currently live for production.
import type { DeliveryDb } from './db'
import type { ResolvedTenant } from './auth'
import type { ItemEnvelope } from './vocabulary/envelope'
import { EFFECTIVE_PUBLISHED_SQL, loadLocalizations, toEnvelope, type ContentRow } from './content-read'
import { hashPreviewToken, PREVIEW_TOKEN_RE } from './preview-token'

export interface PreviewHit {
  envelope: ItemEnvelope
  /** `environments.domain` of every environment of the token's site (the CORS allow-list source). */
  domains: string[]
}

type PreviewRow = ContentRow & {
  collection_key: string
  published_version: number | null
  /** The token's pinned version. */
  pinned_version: number
}

/** null for every failure of any kind: see the header. */
export async function loadPreview(db: DeliveryDb, tenant: ResolvedTenant, token: string): Promise<PreviewHit | null> {
  // A string that cannot be one of ours is not looked up at all (it could not match, and the database
  // never sees attacker-shaped input of unbounded length).
  if (!PREVIEW_TOKEN_RE.test(token)) return null
  const tokenHash = hashPreviewToken(token)

  return db.withTenant(tenant.id, async (client) => {
    const { rows } = await client.query<PreviewRow & { site_id: string }>(
      `SELECT pt.site_id, pt.version AS pinned_version,
              ci.id, ci.slug, ci.locale, ci.publish_state, ci.publish_at, ci.unpublish_at, ci.created_at,
              ci.created_at::text AS created_at_raw, ci.updated_at, ci.localization_group_id, ci.published_version,
              c.key AS collection_key,
              v.blocks, v.seo,
              ${EFFECTIVE_PUBLISHED_SQL} AS effective_published
         FROM preview_tokens pt
         JOIN content_items ci ON ci.id = pt.content_item_id
         JOIN collections c ON c.id = ci.collection_id
         JOIN content_versions v ON v.content_item_id = pt.content_item_id AND v.version = pt.version
        WHERE pt.token_hash = $1
          AND pt.tenant_id = $2 AND ci.tenant_id = $2 AND v.tenant_id = $2
          AND ci.site_id = pt.site_id AND c.site_id = pt.site_id
          AND pt.revoked_at IS NULL AND pt.expires_at > now()
          AND ci.deleted_at IS NULL`,
      [tokenHash, tenant.id],
    )
    const row = rows[0]
    if (!row) return null

    const livePinned = row.effective_published && row.published_version === row.pinned_version
    const localizations = await loadLocalizations(client, row.localization_group_id, row.locale, true)
    const envelope = toEnvelope({ ...row, effective_published: livePinned }, row.collection_key, localizations, {
      requested: row.locale,
      served: row.locale,
      defaultLocale: tenant.defaultLocale,
    })

    const { rows: envRows } = await client.query<{ domain: string }>(
      `SELECT domain FROM environments WHERE site_id = $1 AND tenant_id = $2 AND domain IS NOT NULL AND domain <> ''`,
      [row.site_id, tenant.id],
    )
    return { envelope, domains: envRows.map((r) => r.domain) }
  })
}
