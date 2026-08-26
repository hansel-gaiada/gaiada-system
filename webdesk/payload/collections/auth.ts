// webdesk/payload/collections/auth.ts
//
// WSK-06 — API-key resolution for the /v1 content-read path.
//
// This DELIBERATELY duplicates the algorithm in webdesk/api/src/crypto/api-key-hash.ts +
// webdesk/api/src/api-keys/api-keys.service.ts's `resolve()`, rather than importing them: this
// Payload service and the NestJS `api` service are separate processes/packages (design §02), and
// this ticket's ownership boundary excludes webdesk/api/src/** entirely (a concurrent worker is
// there). The two services can still independently validate the SAME `api_keys` row because the
// actual contract is the DATABASE ROW plus the shared `API_KEY_PEPPER` env var, not shared code —
// sha256(plaintext + pepper) hex, matching `api_keys.key_hash` exactly as documented on that
// column (0001_platform_core.sql's own comment). If that algorithm ever changes, it must change
// in BOTH places or every key silently stops resolving in one of the two services — flagged here
// and in this ticket's final report as a coupling to watch, not hidden.
import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { withPlatformCtx, withTenant } from './db.ts'

export type ApiKeyScope = 'read' | 'write'
export type EnvName = 'staging' | 'production'

export interface ResolvedTenant {
  id: string
  slug: string
  status: string
  defaultLocale: string
  locales: string[]
}

export interface ResolvedApiKey {
  apiKeyId: string
  tenantId: string
  tenantSlug: string
  tenantDefaultLocale: string
  tenantLocales: string[]
  envId: string
  siteId: string
  envName: EnvName
  scope: ApiKeyScope
}

function hashApiKey(plaintextKey: string, pepper: string): string {
  return createHash('sha256').update(plaintextKey + pepper, 'utf8').digest('hex')
}

/** Cross-tenant by construction (webdesk.platform_ctx) — the request has no tenant yet, only a slug. */
export async function resolveTenantBySlug(slug: string): Promise<ResolvedTenant | null> {
  return withPlatformCtx(async (client: PoolClient) => {
    const { rows } = await client.query(
      `SELECT id, slug, status, default_locale, locales FROM tenants WHERE slug = $1`,
      [slug],
    )
    const row = rows[0]
    if (!row) return null
    return {
      id: row.id,
      slug: row.slug,
      status: row.status,
      defaultLocale: row.default_locale,
      locales: row.locales,
    }
  })
}

/**
 * Re-reads `api_keys` fresh on every call — no cache anywhere in this path, matching WSK-05's
 * "revoke dies on the very next request" doctrine for the api service's own guard.
 */
export async function resolveApiKey(tenant: ResolvedTenant, plaintextKey: string): Promise<ResolvedApiKey | null> {
  const pepper = process.env.API_KEY_PEPPER
  if (!pepper) throw new Error('[webdesk-v1] API_KEY_PEPPER is not set')
  const keyHash = hashApiKey(plaintextKey, pepper)

  return withTenant(tenant.id, async (client: PoolClient) => {
    // tenant_id = $1 is redundant with RLS (same app-layer-scoping doctrine as api-keys.service.ts)
    const { rows } = await client.query(
      `SELECT id, env_id, scope, revoked_at FROM api_keys WHERE tenant_id = $1 AND key_hash = $2`,
      [tenant.id, keyHash],
    )
    const row = rows[0]
    if (!row || row.revoked_at) return null

    const { rows: envRows } = await client.query(
      `SELECT site_id, name FROM environments WHERE id = $1 AND tenant_id = $2`,
      [row.env_id, tenant.id],
    )
    const env = envRows[0]
    if (!env) return null // orphaned key (its environment was removed) — fail closed

    return {
      apiKeyId: row.id,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      tenantDefaultLocale: tenant.defaultLocale,
      tenantLocales: tenant.locales,
      envId: row.env_id,
      siteId: env.site_id,
      envName: env.name,
      scope: row.scope,
    }
  })
}

export function extractBearerKey(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
}
