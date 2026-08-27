#!/usr/bin/env node
/**
 * WSK-28 -- the CDN-bypass auditor.
 *
 * WHY THIS EXISTS (design §11a: "The CDN is mandatory ... A media path that bypasses the CDN is
 * a defect"): self-hosted media on a single box is only safe at scale if every public asset
 * request actually goes through Cloudflare's cache/WAF. If the origin (Zone B) will happily
 * answer a request that skipped the CDN, then (a) the box has no protection against direct-origin
 * abuse and (b) the whole §11a scaling argument is fiction.
 *
 * MECHANISM this ticket specifies: Cloudflare injects a shared-secret header on every request it
 * forwards to the origin (a Transform/Origin Rule -- configured in Cloudflare, not in this repo,
 * since Zone B holds no Cloudflare API credential beyond the purge-scoped token per §03's egress
 * table). Caddy checks that header on every media path BEFORE reverse-proxying to the api
 * service; a request missing it (i.e. one that reached the origin directly, bypassing Cloudflare)
 * gets refused.
 *
 * This script has two modes:
 *   --selftest        no network needed; proves the check LOGIC would fail on a reversed/broken
 *                      implementation, using an in-process fake origin.
 *   --probe <origin>   live mode (only meaningful once a real Caddy instance exists to hit) --
 *                      sends one request WITH the header and one WITHOUT, to every path in
 *                      MEDIA_PATHS, and asserts the header-less request is refused.
 *
 * Run:  node check-cdn-bypass.mjs --selftest
 *       WEBDESK_EDGE_VERIFY_HEADER_VALUE=<value> node check-cdn-bypass.mjs --probe http://localhost:8380
 */

import http from 'node:http';

const HEADER_NAME = 'x-webdesk-edge-verify';
const MEDIA_PATHS = ['/media/probe-object', '/forms/probe'];

// --- selftest: a fake origin implementing the CORRECT behavior, and one implementing the WRONG
// (reversed) behavior, to prove the checker actually discriminates between them. ----------------
function startFakeOrigin({ enforceHeader }) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const got = req.headers[HEADER_NAME];
      if (enforceHeader && got !== 'expected-secret') {
        res.writeHead(403);
        res.end('missing/invalid edge-verify header -- refused');
        return;
      }
      res.writeHead(200);
      res.end('media-bytes');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function requestWithHeader(origin, path, withHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      origin + path,
      { headers: withHeader ? { [HEADER_NAME]: 'expected-secret' } : {} },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function auditOrigin(origin) {
  // A media path must be refused when the header is absent, and served when present. If BOTH
  // requests succeed, the origin is bypassable. If the header-present request also fails, this
  // isn't a CDN-bypass problem -- it's a different bug -- but it still fails this specific check
  // because it means the enforcement mechanism itself is broken, not just permissive.
  const findings = [];
  for (const path of MEDIA_PATHS) {
    const withoutHeader = await requestWithHeader(origin, path, false);
    const withHeader = await requestWithHeader(origin, path, true);
    if (withoutHeader < 400) {
      findings.push(`${path}: request WITHOUT the edge-verify header returned ${withoutHeader} (expected refusal) -- CDN-BYPASSABLE`);
    }
    if (withHeader >= 400) {
      findings.push(`${path}: request WITH the edge-verify header returned ${withHeader} (expected success) -- enforcement is broken, not just permissive`);
    }
  }
  return findings;
}

async function selftest() {
  let ok = true;

  const goodOrigin = await startFakeOrigin({ enforceHeader: true });
  const goodPort = goodOrigin.address().port;
  const goodFindings = await auditOrigin(`http://127.0.0.1:${goodPort}`);
  goodOrigin.close();
  if (goodFindings.length !== 0) {
    console.error('SELFTEST FAIL: a correctly-enforcing origin was flagged:', goodFindings);
    ok = false;
  } else {
    console.log('SELFTEST: correctly-enforcing origin passes clean (expected)');
  }

  const bypassableOrigin = await startFakeOrigin({ enforceHeader: false });
  const bypassPort = bypassableOrigin.address().port;
  const bypassFindings = await auditOrigin(`http://127.0.0.1:${bypassPort}`);
  bypassableOrigin.close();
  if (bypassFindings.length === 0) {
    console.error('SELFTEST FAIL: a bypassable origin (serves media with NO header check) was NOT flagged -- the check would miss the exact regression it exists to catch');
    ok = false;
  } else {
    console.log('SELFTEST: bypassable origin correctly flagged:', bypassFindings);
  }

  return ok;
}

// --- entry --------------------------------------------------------------------------------------
/**
 * WSK-28 (coordinator addition) — the CONFIG half of this gate.
 *
 * WHY THIS EXISTS: the Caddyfile matcher is deliberately fail-SOFT in dev —
 *
 *   "{$WEBDESK_EDGE_VERIFY_SECRET}" != "" && {header} != "{$secret}"
 *
 * — so an EMPTY or UNSET secret makes the whole matcher false and nothing is blocked. Correct for
 * a dev box with no Cloudflare in front; wrong everywhere else. In production an unset var means
 * every /media/* path is directly reachable at the origin, the CDN is bypassable, and NOTHING
 * complains. `--probe` cannot catch it either: a bypassable origin with an unset secret looks
 * exactly like a dev box.
 *
 * `--assert-configured` is the missing half. Run it ON the box, in the deploy path, BEFORE
 * trusting a green --probe. It is the estate's own `requireInProd` idea (platform-nest config.ts)
 * applied to a var that lives in a Caddyfile, which has no way to call it.
 */
const MIN_SECRET_LENGTH = 24;

function assertConfigured(secret) {
  const findings = [];
  if (secret === undefined || secret === null || secret === '') {
    findings.push(
      'WEBDESK_EDGE_VERIFY_SECRET is unset or empty -- the Caddyfile matcher is then FALSE for ' +
        'every request, so /media/* is served with NO edge-verify check at all. This fails OPEN.',
    );
    return findings;
  }
  if (secret.trim() !== secret) {
    findings.push('WEBDESK_EDGE_VERIFY_SECRET has leading/trailing whitespace -- Cloudflare injects the trimmed value, so every request would 403');
  }
  if (secret.trim().length < MIN_SECRET_LENGTH) {
    findings.push(`WEBDESK_EDGE_VERIFY_SECRET is ${secret.trim().length} chars; a brute-forceable shared secret is not a gate (want >= ${MIN_SECRET_LENGTH})`);
  }
  return findings;
}

/** Proves this half can fail — a check that cannot fail is decoration. */
function selftestConfigured() {
  const cases = [
    { name: 'a real secret passes', secret: 'x'.repeat(40), expect: 0 },
    { name: 'THE FAIL-OPEN CASE: unset secret is caught', secret: undefined, expect: 1 },
    { name: 'empty secret is caught', secret: '', expect: 1 },
    { name: 'a too-short secret is caught', secret: 'short', expect: 1 },
    { name: 'untrimmed secret is caught (would 403 every request)', secret: ' ' + 'x'.repeat(40) + ' ', expect: 1 },
  ];
  let fails = 0;
  for (const c of cases) {
    const got = assertConfigured(c.secret).length ? 1 : 0;
    const ok = got === c.expect;
    if (!ok) fails++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  }
  return fails === 0;
}

const mode = process.argv[2];

if (mode === '--selftest') {
  const originOk = await selftest();
  console.log('\n--- config half (--assert-configured) ---');
  const ok = originOk && selftestConfigured();
  console.log(ok ? '\nSELFTEST: 7/7 OK (2 origin + 5 config)' : '\nSELFTEST: FAILED');
  process.exit(ok ? 0 : 1);
}

if (mode === '--probe') {
  const origin = process.argv[3];
  if (!origin) {
    console.error('usage: node check-cdn-bypass.mjs --probe <origin-url>');
    process.exit(2);
  }
  const findings = await auditOrigin(origin);
  if (findings.length === 0) {
    console.log(`PASS: ${origin} -- every media path refuses a request missing the edge-verify header`);
    process.exit(0);
  } else {
    console.error(`FAIL: ${origin}`);
    for (const f of findings) console.error(`  - ${f}`);
    process.exit(1);
  }
}

if (mode === '--assert-configured') {
  const findings = assertConfigured(process.env.WEBDESK_EDGE_VERIFY_SECRET);
  if (findings.length === 0) {
    console.log('PASS: WEBDESK_EDGE_VERIFY_SECRET is set and plausible -- the Caddyfile /media/* matcher will actually enforce');
    process.exit(0);
  }
  console.error('FAIL: the CDN-bypass gate is NOT armed');
  for (const f of findings) console.error(`  - ${f}`);
  process.exit(1);
}

console.error('usage: node check-cdn-bypass.mjs --selftest | --probe <origin-url> | --assert-configured');
process.exit(2);
