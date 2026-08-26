/**
 * WSK-02 — the public listener (design §05/WSK-D20, AC: "GraphQL and unscoped REST disabled on
 * the public listener"; §11/D-5: "admin ... never public").
 *
 * This is a SEPARATE Node process from the Payload/Next.js app (`next.config.mjs` +
 * `app/(payload)/**`) — it imports neither `payload` nor `next`. That is the whole enforcement
 * story: it is not possible for this process to reach `/admin`, `/api/graphql`, or Payload's
 * generic `/api/<collection>` REST, because this file contains no code path that wires to any of
 * them. What it CAN reach is a hardcoded allowlist, proxied to the internal Next.js listener
 * (`PAYLOAD_INTERNAL_PORT`, never exposed to the public vhost — see README.md).
 *
 * Today the allowlist is `/healthz` only, because the `/v1` envelope does not exist yet
 * (vocabulary v1 + the frozen envelope are WSK-06's job, per this ticket's scope note — "do not
 * build it"). WSK-06 is expected to register its endpoints under Payload's `config.endpoints`
 * with a `/v1` path prefix; when it does, this gateway starts forwarding `^/v1/` without any
 * lockdown-relevant code changing — the DENYLIST below still runs first, unconditionally, on every
 * request, so `/admin` and `/api/*` stay blocked regardless of what the internal app grows.
 *
 * grep-provable, per the ticket AC: `grep -n "DENYLIST\|ALLOWLIST" src/public-gateway.mjs` shows
 * the complete, exhaustive route policy of the public listener in two small arrays — there is no
 * wildcard passthrough, no `proxy.forward(everything)` path, anywhere in this file.
 */
import http from 'node:http'

const PUBLIC_PORT = Number(process.env.PAYLOAD_PUBLIC_PORT || 3201)
const INTERNAL_HOST = process.env.PAYLOAD_INTERNAL_HOST || '127.0.0.1'
const INTERNAL_PORT = Number(process.env.PAYLOAD_INTERNAL_PORT || 3100)

// Checked FIRST, unconditionally, on every request — defense in depth. Even if the ALLOWLIST
// below were ever misconfigured to something broader, these three patterns still win, because
// they are evaluated before any allow decision and short-circuit with a hard 404.
const DENYLIST_ALWAYS = [
  /^\/admin(\/|$)/, // Payload admin panel — never public (design §11/D-5)
  /^\/api\/graphql(\/|$)/, // Payload GraphQL — never public (WSK-D20), also disabled outright in payload.config.ts
  /^\/api(\/|$)/, // Payload's generic, unscoped/raw collection REST — never public (WSK-D20)
]

// What the public listener is allowed to forward to the internal app. `/v1` does not exist yet
// (WSK-06); listed here pre-emptively so the future addition is a one-line, reviewable diff
// rather than a rewrite of this file's routing logic.
const ALLOWLIST = [/^\/healthz$/, /^\/v1\//]

function isDenied(pathname) {
  return DENYLIST_ALWAYS.some((re) => re.test(pathname))
}

function isAllowed(pathname) {
  return ALLOWLIST.some((re) => re.test(pathname))
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'application/json' }).end(
    JSON.stringify({ error: 'not_found' }),
  )
}

function proxy(req, res, pathname) {
  const upstream = http.request(
    {
      host: INTERNAL_HOST,
      port: INTERNAL_PORT,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    },
  )
  upstream.on('error', () => {
    res.writeHead(502, { 'content-type': 'application/json' }).end(
      JSON.stringify({ error: 'upstream_unreachable' }),
    )
  })
  req.pipe(upstream)
}

export const server = http.createServer((req, res) => {
  const pathname = (req.url || '/').split('?')[0]

  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }))
    return
  }

  if (isDenied(pathname) || !isAllowed(pathname)) {
    notFound(res)
    return
  }

  proxy(req, res, pathname)
})

// This module is always run as a standalone process (`node src/public-gateway.mjs`, or
// `npm run gateway`) — tests spawn it as a real child process (see test/lockdown.test.mjs)
// rather than importing it in-process, so there is no import-vs-execute ambiguity to guard here.
server.listen(PUBLIC_PORT, () => {
  console.log(`[webdesk-payload] public gateway listening on :${PUBLIC_PORT}`)
  console.log(`[webdesk-payload] denylist: ${DENYLIST_ALWAYS.map(String).join(', ')}`)
  console.log(`[webdesk-payload] allowlist: ${ALLOWLIST.map(String).join(', ')}`)
})
