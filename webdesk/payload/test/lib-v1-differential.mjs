/**
 * WSK-48a — the differential gate's engine: serve the OLD Payload-hosted router
 * (collections/router.ts `handleV1Request`, behind a plain Node http.Server) and the NEW api-hosted
 * route (an already-running webdesk/api at V1_NEW_URL) side by side, send every request to BOTH, and
 * compare what actually crosses the wire.
 *
 * Both sides are reached over real HTTP with the SAME request (method, path+query, headers), one
 * after the other, so the shared fixture database cannot change between the two halves of a pair.
 *
 * COMPARED, exactly: status code; body bytes (Buffer.equals — not parsed JSON); the `content-type`
 * header; the `cache-tag` header (present-or-absent too).
 * STATUS-ONLY class (counted and reported separately, never folded into 'identical'): a request whose path
 * is outside the /v1 prefix. The old router FUNCTION answers those with its own 404 problem body, but in
 * the old deployment it was only ever reached through public-gateway.mjs's `^/v1/` allowlist (anything else
 * was the gateway's `{"error":"not_found"}`), and in the new one Nest answers them: different servers by
 * design, so only 'both answer the same status' is asserted. The envelope-contract suite makes exactly one
 * such request (/v2/...).
 * NOT compared, and reported separately as an informational header-NAME diff: every other response
 * header (`date`, `connection`, `keep-alive`, `content-length`/`transfer-encoding` framing, and the
 * api's added `x-ratelimit-*`). Per-request values are neutralised by sending the SAME explicit
 * `x-request-id` to both sides (injected here when the caller sent none), so the RFC 9457 `requestId`
 * is deterministic and NOTHING in any body is ignored or rewritten — except the explicit
 * `normalizeRequestId` probes in v1-differential-extra.test.mjs, which send NO x-request-id and
 * compare after replacing the one random UUID in `requestId` (listed there by name).
 *
 * `handleV1Request` below is a drop-in for collections/router.ts's export: the envelope-contract suite
 * is run UNMODIFIED against it (see run-v1-differential.mjs), so "every request the suite makes" is
 * replayed literally, including the pagination walk and the concurrent-publish scenario.
 *   V1_DIFF_TARGET=api  (default) the suite's assertions are evaluated on the NEW route's responses
 *   V1_DIFF_TARGET=old            ...on the OLD router's (a baseline: proves the harness is neutral)
 */
import http from 'node:http'
import { handleV1Request as oldHandle } from '../collections/router.ts'

const NEW_URL = (process.env.V1_NEW_URL || '').replace(/\/$/, '')
const TARGET = process.env.V1_DIFF_TARGET || 'api'
const LABEL = process.env.V1_DIFF_LABEL || 'differential'
if (!NEW_URL) throw new Error('V1_NEW_URL (base URL of the api-hosted /v1 route) is not set')
if (!['api', 'old'].includes(TARGET)) throw new Error(`V1_DIFF_TARGET must be api|old, got ${TARGET}`)

// ---- the OLD router, behind a real http.Server --------------------------------------------------
const oldServer = http.createServer(async (req, res) => {
  try {
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.append(k, Array.isArray(v) ? v.join(', ') : v)
    const response = await oldHandle(new Request(`http://internal${req.url}`, { method: req.method, headers }))
    const out = {}
    response.headers.forEach((v, k) => (out[k] = v))
    res.writeHead(response.status, out)
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch (err) {
    res.writeHead(599, { 'content-type': 'text/plain' }).end(`HARNESS: old router threw: ${err?.stack || err}`)
  }
})
await new Promise((resolve) => oldServer.listen(0, '127.0.0.1', resolve))
oldServer.unref()
const OLD_URL = `http://127.0.0.1:${oldServer.address().port}`

// ---- comparison ---------------------------------------------------------------------------------
const stats = { pairs: 0, identical: 0, statusOnlyPairs: 0, statusOnlyIdentical: 0, knownDivergent: [], mismatches: [], headerNameDiffs: new Map(), byStatus: new Map() }
const IGNORED_HEADER_NAMES = new Set(['date', 'connection', 'keep-alive', 'transfer-encoding', 'content-length'])
let seq = 0

async function wire(base, spec) {
  const res = await fetch(base + spec.pathAndQuery, { method: spec.method, headers: spec.headers, body: spec.body, redirect: 'manual' })
  const body = Buffer.from(await res.arrayBuffer())
  const headers = {}
  res.headers.forEach((v, k) => (headers[k] = v))
  return { status: res.status, body, headers }
}

function specFrom(requestOrSpec, init) {
  if (requestOrSpec instanceof Request) {
    const u = new URL(requestOrSpec.url)
    return { method: requestOrSpec.method, pathAndQuery: u.pathname + u.search, headers: Object.fromEntries(requestOrSpec.headers) }
  }
  return { method: 'GET', headers: {}, ...requestOrSpec, ...init }
}

/** Send `spec` to both servers, record the pair, return { old, neu, same }. */
export async function comparePair(requestOrSpec, { normalizeRequestId = false, note } = {}) {
  const spec = specFrom(requestOrSpec)
  spec.headers = { ...spec.headers }
  if (!normalizeRequestId && !Object.keys(spec.headers).some((h) => h.toLowerCase() === 'x-request-id')) {
    spec.headers['x-request-id'] = `diff-${++seq}`
  }
  const old = await wire(OLD_URL, spec)
  const neu = await wire(NEW_URL, spec)

  let oldBody = old.body
  let newBody = neu.body
  if (normalizeRequestId) {
    const norm = (b) => Buffer.from(b.toString('utf8').replace(/("requestId":")[0-9a-f-]{36}(")/, '$1<uuid>$2'), 'utf8')
    oldBody = norm(old.body)
    newBody = norm(neu.body)
  }

  const outsideV1 = !spec.pathAndQuery.startsWith('/v1/') // the old gateway's allowlist was ^/v1/ (so bare /v1 was outside it too)
  if (outsideV1) {
    // status-only class (see header)
    stats.statusOnlyPairs++
    if (old.status === neu.status) stats.statusOnlyIdentical++
    else stats.mismatches.push({ request: `${spec.method} ${spec.pathAndQuery}`, note: 'status-only class', diffs: [`status old=${old.status} new=${neu.status}`] })
    return { old, neu, same: old.status === neu.status }
  }
  const diffs = []
  if (old.status !== neu.status) diffs.push(`status old=${old.status} new=${neu.status}`)
  if (!oldBody.equals(newBody)) diffs.push(`body bytes differ (old ${oldBody.length}B / new ${newBody.length}B): old=${JSON.stringify(oldBody.toString('utf8').slice(0, 300))} new=${JSON.stringify(newBody.toString('utf8').slice(0, 300))}`)
  if ((old.headers['content-type'] ?? null) !== (neu.headers['content-type'] ?? null)) diffs.push(`content-type old=${old.headers['content-type']} new=${neu.headers['content-type']}`)
  if ((old.headers['cache-tag'] ?? null) !== (neu.headers['cache-tag'] ?? null)) diffs.push(`cache-tag old=${old.headers['cache-tag']} new=${neu.headers['cache-tag']}`)

  stats.pairs++
  const key = `${spec.method} ${old.status}`
  stats.byStatus.set(key, (stats.byStatus.get(key) ?? 0) + 1)
  // KNOWN FRAMEWORK DIVERGENCE (listed, counted separately, never folded into 'identical'): a raw '%' that is
  // not followed by two hex digits in the PATH. Fastify refuses such a URL itself (400, code FST_ERR_BAD_URL,
  // application/json) before any route runs; the bare router function never saw that class of input. The old
  // production stack put Next.js in front of the router, which (unverified here) also refuses undecodable
  // path params — so this is an input class the old stack likely never delivered to the router either.
  const badEscape = /%(?![0-9A-Fa-f]{2})/.test(spec.pathAndQuery.split('?')[0])
  if (diffs.length === 0) stats.identical++
  else if (badEscape && neu.status === 400 && neu.body.toString('utf8').includes('FST_ERR_BAD_URL')) stats.knownDivergent.push({ request: `${spec.method} ${spec.pathAndQuery}`, old: old.status, new: neu.status })
  else stats.mismatches.push({ request: `${spec.method} ${spec.pathAndQuery}`, note, diffs })

  const names = (h) => new Set(Object.keys(h).filter((n) => !IGNORED_HEADER_NAMES.has(n)))
  const o = names(old.headers)
  const n = names(neu.headers)
  for (const h of n) if (!o.has(h)) stats.headerNameDiffs.set(`only-new:${h}`, (stats.headerNameDiffs.get(`only-new:${h}`) ?? 0) + 1)
  for (const h of o) if (!n.has(h)) stats.headerNameDiffs.set(`only-old:${h}`, (stats.headerNameDiffs.get(`only-old:${h}`) ?? 0) + 1)

  return { old, neu, same: diffs.length === 0 }
}

function toResponse(w) {
  const headers = new Headers()
  for (const [k, v] of Object.entries(w.headers)) {
    if (!IGNORED_HEADER_NAMES.has(k)) headers.set(k, v)
  }
  return new Response(w.body, { status: w.status, headers })
}

/** Drop-in for collections/router.ts#handleV1Request: tees the request to both servers. */
export async function handleV1Request(request) {
  const { old, neu } = await comparePair(request)
  return toResponse(TARGET === 'api' ? neu : old)
}

export function report() {
  console.log(`\n[v1-diff] ${LABEL}: target-for-assertions=${TARGET} pairs=${stats.pairs} identical=${stats.identical} different=${stats.mismatches.filter((m) => m.note !== 'status-only class').length} known_divergent=${stats.knownDivergent.length} statusonly=${stats.statusOnlyPairs} statusonly_same=${stats.statusOnlyIdentical}`)
  console.log(`[v1-diff] ${LABEL}: status mix (method status -> count): ${[...stats.byStatus].map(([k, v]) => `${k}=${v}`).sort().join(' ')}`)
  console.log(`[v1-diff] ${LABEL}: informational response-header-name differences (not compared): ${[...stats.headerNameDiffs].map(([k, v]) => `${k}x${v}`).join(' ') || 'none'}`)
  for (const k of stats.knownDivergent) console.log(`[v1-diff] KNOWN-DIVERGENCE (invalid % escape -> Fastify FST_ERR_BAD_URL) ${k.request}: old status ${k.old}, new ${k.new}`)
  for (const m of stats.mismatches) console.log(`[v1-diff] MISMATCH ${m.request}${m.note ? ` (${m.note})` : ''}\n    ${m.diffs.join('\n    ')}`)
  return stats.mismatches.length === 0
}

process.on('exit', () => {
  const ok = report()
  if (!ok) process.exitCode = 1
})
