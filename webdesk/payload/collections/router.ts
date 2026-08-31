// webdesk/payload/collections/router.ts
//
// WSK-06 — the frozen /v1 envelope's actual handler (design §05/§06). A plain Web
// Request -> Response function, deliberately NOT wired through Payload's `config.endpoints`.
//
// WHY NOT config.endpoints: Payload/Next's `handleEndpoints` (node_modules/payload/dist/
// utilities/handleEndpoints.js) hard-requires the incoming pathname to start with
// `config.routes.api` (default `/api`) before it will even look at `config.endpoints` — see
// `if (!pathname.startsWith(baseAPIPath)) return notFoundResponse(...)`. Reconfiguring
// `routes.api` to `/v1` so that requirement is met would put Payload's OWN unscoped, automatic
// collection REST (for `users`/`pages`, and every future Payload-native collection) on the exact
// same public prefix this ticket exists to freeze — precisely the WSK-D20 leak the whole design
// warns about ("Payload exposes GraphQL and its own REST automatically ... silently defeats the
// snapshot pin"). So this router bypasses Payload's REST/endpoint machinery entirely: it is a
// self-contained function any HTTP-serving layer can call with a standard Request and get back a
// standard Response — this ticket's own test harness (a plain Node http.Server, see
// test/envelope-contract.test.mjs), or eventually a thin Next.js route file. See this ticket's
// final report for exactly why that route file could not be added here (it lives under
// webdesk/payload/app/**, outside this ticket's ownership boundary) and for its exact contents.
import { randomUUID } from 'node:crypto'
import { extractBearerKey, resolveApiKey, resolveTenantBySlug, type ResolvedApiKey } from './auth.ts'
import { getItem, listItems, searchItems } from './content-read.ts'
import { renderSitemapXml } from './redirects.ts'
import { applyCacheTagHeader, buildCacheTags } from '../vocabulary/cache-tags.ts'
import { problemDetails, problemResponse } from '../vocabulary/problem-details.ts'
import { ENVELOPE_VERSION } from '../vocabulary/version.ts'

function jsonResponse(body: unknown, headers: Headers, status = 200): Response {
  headers.set('content-type', 'application/json')
  return new Response(JSON.stringify(body), { status, headers })
}

function problem(status: number, slug: string, title: string, detail: string, instance: string, requestId: string) {
  return problemResponse(problemDetails({ slug, title, status, detail, instance, requestId }))
}

/** Every /v1 request, whatever HTTP layer received it. Path shape: /v1/t/:tenantSlug/... */
export async function handleV1Request(request: Request): Promise<Response> {
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

  const tenant = await resolveTenantBySlug(tenantSlug)
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
    auth = await resolveApiKey(tenant, plaintextKey)
  } catch (err) {
    return problem(500, 'internal-error', 'Internal error', (err as Error).message, instance, requestId)
  }
  if (!auth) {
    return problem(401, 'invalid-credentials', 'Invalid credentials', 'Unknown tenant or invalid key.', instance, requestId)
  }

  const locale = url.searchParams.get('locale')
  const limitParam = Number(url.searchParams.get('limit') || '25')
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(1, limitParam), 100) : 25
  const cursor = url.searchParams.get('cursor')
  const expandBlocks = url.searchParams.get('expand') === 'blocks'

  try {
    if (rest.length === 1 && rest[0] === 'search') {
      const q = url.searchParams.get('q') || ''
      const collectionKey = url.searchParams.get('collection') || null
      const result = await searchItems({ auth, locale, q, collectionKey, cursor, limit })
      const headers = new Headers()
      applyCacheTagHeader(headers, buildCacheTags({ tenantSlug, collectionKey: collectionKey ?? 'search' }))
      return jsonResponse(result, headers)
    }

    if (rest.length === 1 && rest[0] === 'sitemap.xml') {
      const xml = await renderSitemapXml({ auth, locale })
      const headers = new Headers({ 'content-type': 'application/xml' })
      applyCacheTagHeader(headers, buildCacheTags({ tenantSlug, collectionKey: 'sitemap' }))
      return new Response(xml, { status: 200, headers })
    }

    if (rest.length === 1) {
      const [collectionKey] = rest
      const result = await listItems({ auth, collectionKey, locale, cursor, limit, expandBlocks })
      const headers = new Headers()
      applyCacheTagHeader(headers, buildCacheTags({ tenantSlug, collectionKey }))
      return jsonResponse(result, headers)
    }

    if (rest.length === 2) {
      const [collectionKey, slug] = rest
      const result = await getItem({ auth, collectionKey, slug, locale })
      if (!result) {
        return problem(
          404,
          'item-not-found',
          'Item not found',
          `No published item "${slug}" in "${collectionKey}".`,
          instance,
          requestId,
        )
      }
      const headers = new Headers()
      applyCacheTagHeader(headers, buildCacheTags({ tenantSlug, collectionKey, itemId: result.id }))
      return jsonResponse(result.envelope, headers)
    }

    return problem(404, 'not-found', 'Not Found', 'No /v1 route matches this path.', instance, requestId)
  } catch (err) {
    return problem(500, 'internal-error', 'Internal error', (err as Error).message, instance, requestId)
  }
}
