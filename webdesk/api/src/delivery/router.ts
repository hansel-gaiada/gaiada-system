// webdesk/api/src/delivery/router.ts
//
// WSK-48a — MOVED from webdesk/payload/collections/router.ts (WSK-06; that tree was deleted in WSK-48b): the frozen /v1 envelope's
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
//      webdesk/delivery/vocabulary/*.
//   4. (M3 T1) Hardening of the read path, and ONLY these: each path segment after the tenant prefix
//      is percent-decoded once (malformed -> 400 problem+json, a decoded segment holding `/` or NUL
//      -> 404 never reaching SQL); a malformed pagination cursor is a 400 `invalid-cursor`; and the
//      catch-all 500 carries a fixed detail instead of the thrown error's message (logged here).
//   5. (WSK-46) The draft-preview route `GET|OPTIONS /v1/t/:tenantSlug/preview/:token`, answered BEFORE the
//      method check and the tenant/key resolution: its credential is the token, not an api key, and its
//      one failure is a 404 that is the same for every cause (see handlePreview). Every other path below
//      is untouched.
// Apart from item 4, the order of checks, every status, every problem slug/title/detail, the "unknown tenant and bad key
// return the same 401" doctrine, and every header are unchanged.
import { randomUUID } from 'node:crypto'
import { Logger } from '@nestjs/common'
import { extractBearerKey, type ResolvedApiKey, type ResolvedTenant } from './auth'
import type { DeliveryDb } from './db'
import { getItem, InvalidCursorError, listItems, searchItems } from './content-read'
import { PREVIEW_SEGMENT, SEARCH_SEGMENT, SITEMAP_SEGMENT } from './reserved-collection-keys'
import { loadPreview } from './preview-read'
import { allowedPreviewOrigin, redactPreviewToken } from './preview-token'
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
  onAuthenticated?(auth: ResolvedApiKey, ctx: { instance: string; requestId: string }): AuthGate | void | Promise<AuthGate | void>
  /**
   * (WSK-46) The same edge hook for a draft-preview read, called ONLY once a token has been proven valid
   * (never for an unknown or expired one), so a stranger guessing tokens cannot spend a tenant's real read
   * quota. Same AuthGate contract as onAuthenticated.
   */
  onPreviewServed?(tenant: ResolvedTenant, ctx: { instance: string; requestId: string }): AuthGate | void | Promise<AuthGate | void>
}

const logger = new Logger('DeliveryRouter')
/** What every unexpected failure tells the client. The thrown message (SQL text, hosts) stays in the log. */
const INTERNAL_ERROR_DETAIL = 'The server could not complete this request.'

function logInternalError(err: unknown, instance: string, requestId: string): void {
  logger.error(`internal error on ${instance} (request ${requestId}): ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
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

/**
 * Headers of EVERY response of the preview route, errors included: a draft must never be cached (a cached
 * 200 would outlive a revoke), never indexed, and the answer depends on the Origin, so caches must vary.
 */
const PREVIEW_HEADERS = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', vary: 'Origin' } as const

/**
 * `/v1/t/:tenantSlug/preview/:token` — five raw segments with the literal `preview` fourth. The match is on
 * the DECODED fourth segment (so `%70review` is the same route), but a segment that does not decode, or
 * that decodes to something holding `/` or NUL, is never a credential: it yields `null` parts and the route
 * answers its one 404. Anything that is not this shape is not a preview request and falls through.
 */
function matchPreviewRoute(segments: string[]): { tenantSlug: string | null; token: string | null } | null {
  if (segments.length !== 5) return null
  const decode = (s: string): string | null => {
    try {
      const d = decodeURIComponent(s)
      return d.includes('/') || d.includes('\u0000') ? null : d
    } catch {
      return null
    }
  }
  if (decode(segments[3]) !== PREVIEW_SEGMENT) return null
  return { tenantSlug: decode(segments[2]), token: decode(segments[4]) }
}

/** Every /v1 request, whatever HTTP layer received it. Path shape: /v1/t/:tenantSlug/... */
export function createV1Handler(deps: V1Deps): (request: Request) => Promise<Response> {
  const { db } = deps

  /**
   * GET|OPTIONS /v1/t/:tenantSlug/preview/:token (WSK-46, owner ruling WSK-D52). No api key: the token is
   * the credential, and it is a bearer capability. `instance` arrives with the token already redacted.
   *
   * ONE FAILURE: an unknown, malformed, expired or revoked token, a tenant slug that is not that token's
   * tenant (or not a tenant at all, or an archived one), a deleted item: all the same 404 `not-found`, the
   * body of any unknown /v1 path, with the same headers and no CORS. Nothing here lets a caller tell
   * those apart. The quota is consumed only after the token proved valid.
   */
  async function handlePreview(
    request: Request,
    route: { tenantSlug: string | null; token: string | null },
    instance: string,
    requestId: string,
  ): Promise<Response> {
    const method = request.method.toUpperCase()
    const failed = (status: number, slug: string, title: string, detail: string) =>
      withHeaders(problem(status, slug, title, detail, instance, requestId), PREVIEW_HEADERS)
    const notFound = () => failed(404, 'not-found', 'Not Found', 'No /v1 route matches this path.')
    if (method !== 'GET' && method !== 'OPTIONS') {
      return failed(405, 'method-not-allowed', 'Method Not Allowed', 'The /v1 envelope is a read-only contract in this ticket.')
    }
    if (!route.tenantSlug || !route.token) return notFound()

    let hit
    try {
      const tenant = await deps.resolveTenantBySlug(route.tenantSlug)
      if (!tenant || tenant.status !== 'active') return notFound()
      hit = await loadPreview(db, tenant, route.token)
      if (!hit) return notFound()

      // From here the token is proven: the origin rule can be answered (it needs the token's site).
      const origin = allowedPreviewOrigin(request.headers.get('origin'), hit.domains)
      const cors: Record<string, string> = origin ? { 'access-control-allow-origin': origin } : {}

      if (method === 'OPTIONS') {
        return withHeaders(new Response(null, { status: 204 }), {
          ...PREVIEW_HEADERS,
          ...(origin
            ? { ...cors, 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'x-request-id', 'access-control-max-age': '600' }
            : {}),
        })
      }

      const gate = await deps.onPreviewServed?.(tenant, { instance, requestId })
      if (gate?.reject) return withHeaders(gate.reject, { ...gate.headers, ...PREVIEW_HEADERS, ...cors })
      return withHeaders(jsonResponse(hit.envelope, new Headers()), { ...gate?.headers, ...PREVIEW_HEADERS, ...cors })
    } catch (err) {
      logInternalError(err, instance, requestId)
      return failed(500, 'internal-error', 'Internal error', INTERNAL_ERROR_DETAIL)
    }
  }

  return async function handleV1Request(request: Request): Promise<Response> {
    const requestId = request.headers.get('x-request-id') || randomUUID()
    const url = new URL(request.url)
    // WSK-43a: a path that carries a bearer token (the media upload route also reaches this wildcard when it is
    // called with a method or on a path the Nest route does not serve) never has it copied into a problem `instance`.
    // Every other path is returned unchanged, so the frozen contract's bytes do not move.
    const instance = redactPreviewToken(url.pathname)

    const segments = url.pathname.split('/').filter(Boolean)
    if (segments[0] !== ENVELOPE_VERSION || segments[1] !== 't' || !segments[2]) {
      return problem(404, 'not-found', 'Not Found', 'No /v1 route matches this path.', instance, requestId)
    }
    const previewRoute = matchPreviewRoute(segments)
    if (previewRoute) return handlePreview(request, previewRoute, redactPreviewToken(instance), requestId)
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

    // M3 T1: decode each segment exactly once (never twice: `%2541` is the literal text `%41`). A
    // malformed escape is the caller's error (400). A decoded segment can no longer be trusted to be
    // one segment: `/` would let `%2F` reach across segments, and NUL cannot be stored in Postgres
    // text (it would surface as a 500) — neither can match anything, so both are a plain 404.
    let decoded: string[]
    try {
      decoded = segments.slice(2).map((s) => decodeURIComponent(s))
    } catch {
      return problem(400, 'invalid-path-encoding', 'Invalid path encoding', 'A path segment is not valid percent-encoding.', instance, requestId)
    }
    if (decoded.some((s) => s.includes('/') || s.includes('\u0000'))) {
      return problem(404, 'not-found', 'Not Found', 'No /v1 route matches this path.', instance, requestId)
    }

    const tenantSlug = decoded[0]
    const rest = decoded.slice(1) // [] | [key] | [key,slug] | ['search'] | ['sitemap.xml']

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
      logInternalError(err, instance, requestId)
      return problem(500, 'internal-error', 'Internal error', INTERNAL_ERROR_DETAIL, instance, requestId)
    }
    if (!auth) {
      return problem(401, 'invalid-credentials', 'Invalid credentials', 'Unknown tenant or invalid key.', instance, requestId)
    }

    const gate = await deps.onAuthenticated?.(auth, { instance, requestId })
    if (gate?.reject) return withHeaders(gate.reject, gate.headers)

    const locale = url.searchParams.get('locale')
    const limitParam = Number(url.searchParams.get('limit') || '25')
    // M3 T1: truncated to an integer. `limit=2.5` used to reach `LIMIT $n` as a non-integer and 500.
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(1, Math.trunc(limitParam)), 100) : 25
    const cursor = url.searchParams.get('cursor')
    const expandBlocks = url.searchParams.get('expand') === 'blocks'

    try {
      if (rest.length === 1 && rest[0] === SEARCH_SEGMENT) {
        const q = url.searchParams.get('q') || ''
        const collectionKey = url.searchParams.get('collection') || null
        const result = await searchItems(db, { auth, locale, q, collectionKey, cursor, limit })
        const headers = new Headers()
        applyCacheTagHeader(headers, buildCacheTags({ tenantSlug, collectionKey: collectionKey ?? 'search' }))
        return withHeaders(jsonResponse(result, headers), gate?.headers)
      }

      if (rest.length === 1 && rest[0] === SITEMAP_SEGMENT) {
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
      if (err instanceof InvalidCursorError) {
        return withHeaders(
          problem(400, 'invalid-cursor', 'Invalid cursor', 'The cursor is not one this API issued.', instance, requestId),
          gate?.headers,
        )
      }
      logInternalError(err, instance, requestId)
      return withHeaders(problem(500, 'internal-error', 'Internal error', INTERNAL_ERROR_DETAIL, instance, requestId), gate?.headers)
    }
  }
}
