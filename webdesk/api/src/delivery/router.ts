// webdesk/api/src/delivery/router.ts
//
// WSK-48a — MOVED from webdesk/payload/collections/router.ts (WSK-06): the frozen /v1 envelope's
// handler. Still a plain Web Request -> Response function with no framework in it; the HTTP edge
// (delivery.gateway.ts) adapts Fastify to it, exactly as the Payload app's Next route file did.
// Style (no semicolons, single quotes) is kept from the original so a reviewer can diff the two.
//
// What changed from the original, and ONLY this:
//   1. It is now a FACTORY, `createV1Handler(deps)`: the tenant lookup, the key resolution and the
//      tenant-aware pool arrive as dependencies instead of module-level imports of a second pool and
//      a second copy of the key-hash code (WSK-D24's accepted duplication is retired — the api's own
//      ApiKeysService and DbService are injected by delivery.gateway.ts).
//   2. An optional post-authentication hook, `onAuthenticated`, lets the edge apply the api's
//      per-tenant read quota (TenantQuotaService) AFTER the key resolves and BEFORE any content
//      query, and attach rate-limit headers. With no hook the behaviour is exactly the original's.
//   3. Vocabulary imports point at the vendored copy (./vocabulary/*), which a drift test pins to
//      webdesk/payload/vocabulary/*.
// The order of checks, every status, every problem slug/title/detail, the "unknown tenant and bad key
// return the same 401" doctrine, and every header are unchanged.
import { randomUUID } from 'node:crypto'
import { extractBearerKey, type ResolvedApiKey, type ResolvedTenant } from './auth'
import type { DeliveryDb } from './db'
import { getItem, listItems, searchItems } from './content-read'
import { renderSitemapXml } from './redirects'
import { applyCacheTagHeader, buildCacheTags } from './vocabulary/cache-tags'
import { problemDetails, problemResponse } from './vocabulary/problem-details'
import { ENVELOPE_VERSION } from './vocabulary/version'

/** What the edge may decide once a request has authenticated (see createV1Handler). */
export interface AuthGate {
  /** If set, answer with this instead of serving content (e.g. a 429). */
  reject?: Response
  /** Extra response headers for whatever response goes out (e.g. X-RateLimit-*). */
  headers?: Record<string, string>
}

export interface V1Deps {
  db: DeliveryDb
  /** Cross-tenant by construction (platform ctx) — the request has no tenant yet, only a slug. */
  resolveTenantBySlug(slug: string): Promise<ResolvedTenant | null>
  /** Re-reads api_keys fresh on every call; null for unknown / revoked / orphaned keys. */
  resolveApiKey(tenant: ResolvedTenant, plaintextKey: string): Promise<ResolvedApiKey | null>
  onAuthenticated?(auth: ResolvedApiKey, ctx: { instance: string; requestId: string }): AuthGate | void
}

function jsonResponse(body: unknown, headers: Headers, status = 200): Response {
  headers.set('content-type', 'application/json')
  return new Response(JSON.stringify(body), { status, headers })
}

function problem(status: number, slug: string, title: string, detail: string, instance: string, requestId: string) {
  return problemResponse(problemDetails({ slug, title, status, detail, instance, requestId }))
}

function withHeaders(res: Response, headers?: Record<string, string>): Response {
  if (headers) for (const [k, v] of Object.entries(headers)) res.headers.set(k, v)
  return res
}

/** Every /v1 request, whatever HTTP layer received it. Path shape: /v1/t/:tenantSlug/... */
export function createV1Handler(deps: V1Deps): (request: Request) => Promise<Response> {
  const { db } = deps

  return async function handleV1Request(request: Request): Promise<Response> {
    const requestId = request.headers.get('x-request-id') || randomUUID()
    const url = new URL(request.url)
    const instance = url.pathname

    const segments = url.pathname.split('/').filter(Boolean)
    if (segments[0] !== ENVELOPE_VERSION || segments[1] !== 't' || !segments[2]) {
      return problem(404, 'not-found', 'Not Found', 'No /v1 route matches this path.', instance, requestId)
    }
    if (request.method.toUpperCase() !== 'GET') {
      return problem(
        405,
        'method-not-allowed',
        'Method Not Allowed',
        'The /v1 envelope is a read-only contract in this ticket.',
        instance,
        requestId,
      )
    }

    const tenantSlug = segments[2]
    const rest = segments.slice(3) // [] | [key] | [key,slug] | ['search'] | ['sitemap.xml']

    const tenant = await deps.resolveTenantBySlug(tenantSlug)
    if (!tenant || tenant.status !== 'active') {
      // Same status/shape as "bad key" below on purpose (api-key-auth.guard.ts's stated doctrine,
      // carried into this service): a probe should not learn whether a tenant slug exists.
      return problem(401, 'invalid-credentials', 'Invalid credentials', 'Unknown tenant or invalid key.', instance, requestId)
    }

    const plaintextKey = extractBearerKey(request)
    if (!plaintextKey) {
      return problem(401, 'missing-api-key', 'Missing API key', 'Provide "Authorization: Bearer <key>".', instance, requestId)
    }

    let auth: ResolvedApiKey | null
    try {
      auth = await deps.resolveApiKey(tenant, plaintextKey)
    } catch (err) {
      return problem(500, 'internal-error', 'Internal error', (err as Error).message, instance, requestId)
    }
    if (!auth) {
      return problem(401, 'invalid-credentials', 'Invalid credentials', 'Unknown tenant or invalid key.', instance, requestId)
    }

    const gate = deps.onAuthenticated?.(auth, { instance, requestId })
    if (gate?.reject) return withHeaders(gate.reject, gate.headers)

    const locale = url.searchParams.get('locale')
    const limitParam = Number(url.searchParams.get('limit') || '25')
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(1, limitParam), 100) : 25
    const cursor = url.searchParams.get('cursor')
    const expandBlocks = url.searchParams.get('expand') === 'blocks'

    try {
      if (rest.length === 1 && rest[0] === 'search') {
        const q = url.searchParams.get('q') || ''
        const collectionKey = url.searchParams.get('collection') || null
        const result = await searchItems(db, { auth, locale, q, collectionKey, cursor, limit })
        const headers = new Headers()
        applyCacheTagHeader(headers, buildCacheTags({ tenantSlug, collectionKey: collectionKey ?? 'search' }))
        return withHeaders(jsonResponse(result, headers), gate?.headers)
      }

      if (rest.length === 1 && rest[0] === 'sitemap.xml') {
        const xml = await renderSitemapXml(db, { auth, locale })
        const headers = new Headers({ 'content-type': 'application/xml' })
        applyCacheTagHeader(headers, buildCacheTags({ tenantSlug, collectionKey: 'sitemap' }))
        return withHeaders(new Response(xml, { status: 200, headers }), gate?.headers)
      }

      if (rest.length === 1) {
        const [collectionKey] = rest
        const result = await listItems(db, { auth, collectionKey, locale, cursor, limit, expandBlocks })
        const headers = new Headers()
        applyCacheTagHeader(headers, buildCacheTags({ tenantSlug, collectionKey }))
        return withHeaders(jsonResponse(result, headers), gate?.headers)
      }

      if (rest.length === 2) {
        const [collectionKey, slug] = rest
        const result = await getItem(db, { auth, collectionKey, slug, locale })
        if (!result) {
          return withHeaders(
            problem(
              404,
              'item-not-found',
              'Item not found',
              `No published item "${slug}" in "${collectionKey}".`,
              instance,
              requestId,
            ),
            gate?.headers,
          )
        }
        const headers = new Headers()
        applyCacheTagHeader(headers, buildCacheTags({ tenantSlug, collectionKey, itemId: result.id }))
        return withHeaders(jsonResponse(result.envelope, headers), gate?.headers)
      }

      return withHeaders(
        problem(404, 'not-found', 'Not Found', 'No /v1 route matches this path.', instance, requestId),
        gate?.headers,
      )
    } catch (err) {
      return withHeaders(problem(500, 'internal-error', 'Internal error', (err as Error).message, instance, requestId), gate?.headers)
    }
  }
}
