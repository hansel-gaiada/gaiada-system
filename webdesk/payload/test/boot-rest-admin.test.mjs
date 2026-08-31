/**
 * WSK-02 boot proof, part 2/2 — REST + admin SSR (the P10 path). Own process, deliberately —
 * see boot-local-api.test.mjs's header for the reproduced Payload/drizzle "second in-process
 * Local-API boot after a destroy() has empty adapter.tables" issue this split avoids. This file
 * boots Payload via Local API exactly ONCE (to bootstrap one admin user), then drives everything
 * else over real HTTP against the internal listener.
 *
 * AUTH TRAP (WSK-00 FINDINGS.md): Payload's default access control for every collection with no
 * explicit `access` block is `Boolean(user)` — a tenant header alone does not authorize a
 * request; a logged-in session is also required. Bootstrap goes through Local API (idempotent
 * find-or-create, bypasses access control by design); login goes over real REST.
 *
 * CSRF TRAP (same source): payload's sanitize step always pushes serverURL onto the CSRF
 * allowlist, so extractJWT's cookie strategy requires an Origin header matching it — every
 * cookie-authenticated call below sets Origin explicitly.
 */
import { bootPayload } from './payload-boot.mjs'
import { startInternal, check, summary, INTERNAL_URL } from './lib-server.mjs'

const DATABASE_URI = process.env.DATABASE_URI
if (!DATABASE_URI) throw new Error('DATABASE_URI not set (point it at the webdesk_app role)')

const TENANT_A = '11111111-1111-1111-1111-111111111111'
const TENANT_B = '22222222-2222-2222-2222-222222222222'
const ADMIN_EMAIL = 'wsk02-boot-admin@example.com'
const ADMIN_PASSWORD = 'wsk-02-boot-test-password-1'

let internal
try {
  internal = await startInternal({ databaseUri: DATABASE_URI })

  const bootstrapPayload = await bootPayload({ databaseUri: DATABASE_URI })
  try {
    const existing = await bootstrapPayload.find({
      collection: 'users',
      where: { email: { equals: ADMIN_EMAIL } },
      limit: 1,
    })
    if (existing.docs.length === 0) {
      await bootstrapPayload.create({ collection: 'users', data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
    }
  } finally {
    await bootstrapPayload.destroy()
  }

  const loginRes = await fetch(`${INTERNAL_URL}/api/users/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: INTERNAL_URL },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  })
  const setCookie = (loginRes.headers.get('set-cookie') || '').split(';')[0]
  check('REST login obtains a session cookie', Boolean(setCookie), `status ${loginRes.status}`)

  const authedHeaders = (tenantId) => ({
    Origin: INTERNAL_URL,
    cookie: tenantId ? `${setCookie}; webdesk_tenant=${tenantId}` : setCookie,
    'x-webdesk-tenant': tenantId ?? '',
  })

  // A unique-per-run marker, not a fixed string — a fixed title risks a false PASS from a row
  // left over by an earlier run in the same (persistent) database.
  const marker = `WSK-02 boot check ${Date.now()}-${Math.random().toString(36).slice(2)}`
  const createRes = await fetch(`${INTERNAL_URL}/api/pages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authedHeaders(TENANT_A) },
    body: JSON.stringify({ tenantId: TENANT_A, title: marker, body: 'via rest' }),
  })
  const created = await createRes.json()
  check(
    'REST POST /api/pages succeeds',
    createRes.status === 201 || createRes.status === 200,
    JSON.stringify(created),
  )

  const readAsA = await fetch(`${INTERNAL_URL}/api/pages/${created.doc?.id}`, { headers: authedHeaders(TENANT_A) })
  check('REST GET as tenant A sees the row it just created', readAsA.status === 200, `status ${readAsA.status}`)

  const readAsB = await fetch(`${INTERNAL_URL}/api/pages/${created.doc?.id}`, { headers: authedHeaders(TENANT_B) })
  check(
    "REST GET as tenant B does NOT see tenant A's row (fail-closed, not error)",
    readAsB.status === 404,
    `status ${readAsB.status}`,
  )

  // Admin SSR first paint — the exact surface WSK-00's P10 probe found broken. Needs the auth
  // cookie AND an Origin header (same CSRF-allowlist requirement as REST — FINDINGS.md documents
  // this for REST; this ticket found the SAME requirement applies to the admin SSR request too,
  // or Payload's list view throws Next's NEXT_REDIRECT to /admin/login) AND the tenant cookie.
  const listRes = await fetch(`${INTERNAL_URL}/admin/collections/pages`, {
    headers: { cookie: `${setCookie}; webdesk_tenant=${TENANT_A}`, Origin: INTERNAL_URL },
  })
  const listHtml = await listRes.text()
  check('admin SSR first paint (P10 path) is reachable', listRes.status === 200, `status ${listRes.status}`)
  check(
    "admin SSR first paint shows the row just created via REST for tenant A",
    listHtml.includes(marker),
    'CANNOT-VERIFY: marker not found in server-rendered HTML even with the globalThis ALS ' +
      'anchor + a correct Origin header — see the ticket report for the full investigation ' +
      '(tenantStore.getStore() reads correctly right up to the RootPage call; what happens ' +
      'inside RootPage after that could not be pinned down further in this ticket\'s time-box)',
  )
} finally {
  await internal?.stop()
}

const ok = summary('WSK-02 boot probe — REST + admin SSR')
process.exit(ok ? 0 : 1)
