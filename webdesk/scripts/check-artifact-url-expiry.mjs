#!/usr/bin/env node
// webdesk/scripts/check-artifact-url-expiry.mjs
//
// WSK-18 condition 4 — "a presigned/artifact URL must actually stop working after its TTL, proven
// by observation."
//
// Drives the REAL production code path — `S3StorageAdapter.presignGetObject` (webdesk/api/src/
// storage/s3-storage.adapter.ts, WSK-07), the exact class `ContractReadService.readLatest`
// (WSK-15) calls to mint the `sdkTsUrl`/`openapiUrl`/`contractMdUrl` a tenant's control-plane
// contract response carries — against a REAL, throwaway MinIO container. Not a mock, not a
// unit-level assertion on the SDK's signature-generation math: an actual HTTP GET against an
// actual presigned URL, observed to succeed before its TTL and to be refused after it.
//
// Run for real (spins up its own throwaway `minio/minio` container, tears it down after):
//   node webdesk/scripts/check-artifact-url-expiry.mjs --docker
// Against an already-running MinIO (e.g. the dev compose stack):
//   STORAGE_ENDPOINT=http://localhost:8385 STORAGE_ACCESS_KEY_ID=... STORAGE_SECRET_ACCESS_KEY=... \
//     node webdesk/scripts/check-artifact-url-expiry.mjs
// Selftest (no MinIO/network needed — proves the response-classification logic can fail):
//   node webdesk/scripts/check-artifact-url-expiry.mjs --selftest

import { execFileSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Pure classifier — given an HTTP response status for a GET against a presigned URL, says
 *  whether that observation counts as "still valid" or "expired/refused". Kept separate from the
 *  live-fetch code so it can be selftested without a network. */
export function classifyPresignedGetResponse(status) {
  if (status === 200) return 'valid'
  // S3-API presign expiry surfaces as 403 (AccessDenied / SignatureDoesNotMatch / RequestTimeTooSkewed
  // depending on provider) — MinIO's own behavior, confirmed against the real container below.
  if (status === 403) return 'expired-or-refused'
  return `unexpected-status-${status}`
}

function selftest() {
  const cases = [
    { name: '200 before TTL classifies as valid', status: 200, expect: 'valid' },
    { name: 'THE REGRESSION: 403 after TTL classifies as expired-or-refused, not silently treated as valid', status: 403, expect: 'expired-or-refused' },
    { name: 'an unrelated 500 is neither silently accepted as valid nor misreported as expiry', status: 500, expect: 'unexpected-status-500' },
    { name: 'a 404 (object deleted, unrelated to TTL) is not conflated with expiry', status: 404, expect: 'unexpected-status-404' },
  ]
  let fails = 0
  for (const c of cases) {
    const got = classifyPresignedGetResponse(c.status)
    const ok = got === c.expect
    if (!ok) fails++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name}  (got "${got}")`)
  }
  console.log(`\n  selftest: ${cases.length - fails} passed, ${fails} failed`)
  return fails === 0 ? 0 : 1
}

function sh(cmd) {
  return execFileSync('bash', ['-lc', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

async function startThrowawayMinio() {
  const name = 'wsk18-minio-expiry'
  sh(`MSYS_NO_PATHCONV=1 docker rm -f ${name} >/dev/null 2>&1 || true`)
  sh(`MSYS_NO_PATHCONV=1 docker run -d --name ${name} -p 0:9000 -e MINIO_ROOT_USER=wsk18user -e MINIO_ROOT_PASSWORD=wsk18password_min8 minio/minio server /data`)
  // Discover the host-mapped port docker chose (0:9000 = random free port), and wait for readiness.
  let port
  for (let i = 0; i < 30; i++) {
    try {
      const out = sh(`MSYS_NO_PATHCONV=1 docker port ${name} 9000/tcp`)
      port = out.trim().split(':').pop()
      if (port) break
    } catch { /* container still starting */ }
    await sleep(500)
  }
  if (!port) throw new Error('could not discover MinIO published port')
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/minio/health/live`)
      if (res.status === 200) break
    } catch { /* not ready yet */ }
    await sleep(500)
  }
  return { name, endpoint: `http://127.0.0.1:${port}` }
}

async function realRun({ useDocker }) {
  let minio
  if (useDocker) {
    console.log('-- starting a throwaway MinIO container --')
    minio = await startThrowawayMinio()
    process.env.STORAGE_ENDPOINT = minio.endpoint
    process.env.STORAGE_ACCESS_KEY_ID = 'wsk18user'
    process.env.STORAGE_SECRET_ACCESS_KEY = 'wsk18password_min8'
    process.env.STORAGE_FORCE_PATH_STYLE = 'true'
  } else if (!process.env.STORAGE_ENDPOINT) {
    console.error('[artifact-url-expiry] UNTESTABLE — no --docker flag and no STORAGE_ENDPOINT set. This condition requires a REAL object store to observe against; there is no meaningful selftest-only substitute for "the URL actually stops working" (see this file\'s header and the ticket report for what a live run needs).')
    process.exit(3)
  }

  try {
    const { S3StorageAdapter } = await import(pathToFileURL(join(HERE, '../api/src/storage/s3-storage.adapter.ts')).href)
    const adapter = new S3StorageAdapter({
      endpoint: process.env.STORAGE_ENDPOINT,
      region: 'us-east-1',
      forcePathStyle: true,
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
    })

    const bucket = 'wsk18-artifacts-probe'
    const key = 'contracts/qa-p3-acme/1.0.0/openapi.v1.json'
    // Short on purpose — this run WAITS for real wall-clock expiry. Overridable so this same real
    // (non-mocked) codepath can also demonstrate the FAIL branch for real: set a TTL longer than
    // the wait margin below and the "after" GET will still succeed, which the check correctly
    // reports as a failure — the deliberate-break proof for this condition, using real MinIO
    // rather than a synthetic classifier input (see the ticket report for the transcript).
    const TTL_SECONDS = Number(process.env.WSK18_PRESIGN_TTL_SECONDS ?? 2)

    console.log(`-- ensureBucket("${bucket}") + putObject("${key}") --`)
    await adapter.ensureBucket(bucket)
    await adapter.putObject(bucket, key, Buffer.from('{"probe":"wsk18-condition-4"}'), 'application/json')

    console.log(`-- presignGetObject(ttl=${TTL_SECONDS}s) — the SAME call ContractReadService.readLatest makes --`)
    const url = await adapter.presignGetObject(bucket, key, TTL_SECONDS)

    const beforeRes = await fetch(url)
    const beforeClass = classifyPresignedGetResponse(beforeRes.status)
    console.log(`-- immediate GET: HTTP ${beforeRes.status} -> ${beforeClass} --`)

    const waitMs = (TTL_SECONDS + 3) * 1000
    console.log(`-- waiting ${waitMs}ms (TTL + 3s margin) for REAL wall-clock expiry --`)
    await sleep(waitMs)

    const afterRes = await fetch(url)
    const afterClass = classifyPresignedGetResponse(afterRes.status)
    const afterBody = await afterRes.text()
    console.log(`-- GET after TTL: HTTP ${afterRes.status} -> ${afterClass}`)
    console.log(`   body: ${afterBody.slice(0, 300)}`)

    const failures = []
    if (beforeClass !== 'valid') failures.push(`the URL did not even work BEFORE its TTL elapsed (HTTP ${beforeRes.status}) — cannot conclude anything about expiry from a URL that never worked`)
    if (afterClass !== 'expired-or-refused') failures.push(`the URL STILL WORKED after its ${TTL_SECONDS}s TTL elapsed (HTTP ${afterRes.status}) — presigned URL is not actually enforcing expiry`)

    // A second, independent proof: a freshly-minted URL for the SAME object, right now, must
    // still work — proves the failure above is specific to the EXPIRED url, not e.g. the object
    // having been deleted or the bucket having become unreachable.
    const freshUrl = await adapter.presignGetObject(bucket, key, 300)
    const freshRes = await fetch(freshUrl)
    const freshClass = classifyPresignedGetResponse(freshRes.status)
    console.log(`-- control: a FRESH presigned URL for the same object: HTTP ${freshRes.status} -> ${freshClass} --`)
    if (freshClass !== 'valid') failures.push(`a freshly-minted URL for the same object also failed (HTTP ${freshRes.status}) — the object/bucket itself is broken, so the earlier "expired" observation is not attributable to TTL`)

    if (failures.length === 0) {
      console.log('\n[artifact-url-expiry] OK — a presigned artifact URL worked before its TTL, was refused after it (observed, not asserted), and a fresh URL for the same object still works.')
      return 0
    }
    console.error(`\n[artifact-url-expiry] FAILED — ${failures.length} finding(s):`)
    for (const f of failures) console.error(`  - ${f}`)
    return 1
  } finally {
    if (minio) sh(`MSYS_NO_PATHCONV=1 docker rm -f ${minio.name} >/dev/null 2>&1 || true`)
  }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--selftest')) process.exit(selftest())
  process.exit(await realRun({ useDocker: argv.includes('--docker') }))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
