/**
 * WSK-02 — the ticket's hard AC as a runnable test: "GraphQL and unscoped/raw REST must be
 * unreachable on the public listener," plus admin (design §11/D-5). Boots both real listeners
 * as child processes against a live Postgres (DATABASE_URI must point at the app role, schema
 * already pushed+RLS'd — see README.md "Local verification") and fails loudly if any of the
 * three is exposed on the public port.
 */
import { startInternal, startPublicGateway, check, summary, PUBLIC_URL, INTERNAL_URL } from './lib-server.mjs'

const DATABASE_URI = process.env.DATABASE_URI
if (!DATABASE_URI) throw new Error('DATABASE_URI not set (point it at the webdesk_app role)')

let internal
let gateway
try {
  internal = await startInternal({ databaseUri: DATABASE_URI })
  gateway = await startPublicGateway()

  // --- the public listener: everything privileged must 404, never proxy ---
  {
    const res = await fetch(`${PUBLIC_URL}/admin`)
    check('public /admin -> 404 (not proxied)', res.status === 404, `got ${res.status}`)
  }
  {
    const res = await fetch(`${PUBLIC_URL}/admin/collections/pages`)
    check('public /admin/collections/pages -> 404', res.status === 404, `got ${res.status}`)
  }
  {
    const res = await fetch(`${PUBLIC_URL}/api/pages`)
    check('public /api/pages (raw REST) -> 404', res.status === 404, `got ${res.status}`)
  }
  {
    const res = await fetch(`${PUBLIC_URL}/api/users/login`, { method: 'POST' })
    check('public /api/users/login -> 404', res.status === 404, `got ${res.status}`)
  }
  {
    const res = await fetch(`${PUBLIC_URL}/api/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
    })
    check('public POST /api/graphql -> 404', res.status === 404, `got ${res.status}`)
  }
  {
    const res = await fetch(`${PUBLIC_URL}/api/graphql-playground`)
    check('public /api/graphql-playground -> 404', res.status === 404, `got ${res.status}`)
  }

  // --- the public listener: the one thing that IS allowed still works ---
  {
    const res = await fetch(`${PUBLIC_URL}/healthz`)
    const body = await res.json()
    check('public /healthz -> 200', res.status === 200 && body.ok === true, `got ${res.status}`)
  }

  // --- v1 does not exist yet (WSK-06); the allowlist entry for it must not accidentally proxy
  //     to something that answers 200 today (it should still 404, because nothing on the
  //     internal app is mounted at /v1 yet — this pins that the allowlist entry is inert, not
  //     silently exposing an unintended route on the internal app) ---
  {
    const res = await fetch(`${PUBLIC_URL}/v1/pages`)
    check(
      'public /v1/pages -> 404 today (vocabulary not built yet, WSK-06)',
      res.status === 404,
      `got ${res.status}`,
    )
  }

  // --- the internal listener: GraphQL must not exist there EITHER (layers 1+2 of the lockdown
  //     — disabled in config, and no route file wires it — the public gateway is not the ONLY
  //     thing standing between an attacker and it) ---
  {
    const res = await fetch(`${INTERNAL_URL}/api/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
    })
    let isGraphQLResponse = false
    try {
      const body = await res.json()
      isGraphQLResponse = res.status === 200 && (body.data || body.errors)
    } catch {
      /* not JSON at all -> definitely not a working GraphQL response */
    }
    check(
      'internal /api/graphql is NOT a working GraphQL endpoint (disabled + unwired)',
      !isGraphQLResponse,
      `status=${res.status}`,
    )
  }

  // --- the internal listener: admin and REST DO work there (proves the split exists — this
  //     is not "everything is broken everywhere") ---
  {
    const res = await fetch(`${INTERNAL_URL}/admin`, { redirect: 'manual' })
    check(
      'internal /admin is reachable (200 or a redirect to /admin/login)',
      res.status === 200 || (res.status >= 300 && res.status < 400),
      `got ${res.status}`,
    )
  }
  {
    // Unauthenticated on purpose — Payload's default access control (Boolean(user)) correctly
    // 403s this. The point here is only that the ROUTE EXISTS and is handled by Payload's real
    // REST implementation (a structured {errors:[...]} body), unlike the public listener's bare,
    // Payload-free 404 for the identical path.
    const res = await fetch(`${INTERNAL_URL}/api/pages`, { headers: { 'x-webdesk-tenant': '' } })
    const body = await res.json()
    check(
      'internal /api/pages is reachable and handled by Payload (structured JSON, not a bare 404)',
      res.status === 403 && Array.isArray(body.errors),
      `got ${res.status} ${JSON.stringify(body).slice(0, 200)}`,
    )
  }
} finally {
  await gateway?.stop()
  await internal?.stop()
}

const ok = summary('WSK-02 lockdown probe')
process.exit(ok ? 0 : 1)
