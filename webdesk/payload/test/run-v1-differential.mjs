/**
 * WSK-48a — runs the whole differential gate and prints one verdict. Three child runs, one shared
 * (already migrated) Zone B Postgres, one already-running webdesk/api (the NEW /v1 route):
 *
 *   1. envelope-contract.test.mjs, UNMODIFIED except for one mechanical import swap (below), with its
 *      `handleV1Request` replaced by lib-v1-differential.mjs's tee — so every request the suite makes
 *      (~100, including the pagination walk and the concurrent-publish scenario) goes to BOTH the old
 *      router and the api, is compared, and the suite's own ~60 assertions are evaluated on the API's
 *      responses (V1_DIFF_TARGET=api).
 *   2. The same, with the assertions evaluated on the OLD router's responses (V1_DIFF_TARGET=old): a
 *      baseline proving the tee itself is transparent (it must pass exactly like the original suite).
 *   3. v1-differential-extra.test.mjs: the error paths and edge cases the suite never exercises.
 *
 * The one transform applied to the contract suite's source (asserted to match exactly once, so a
 * refactor of that file fails loudly instead of silently running something else):
 *     import { handleV1Request } from '../collections/router.ts'
 *  -> import { handleV1Request } from './lib-v1-differential.mjs'
 * The suite also imports `closePool` and `createRedirect` from ../collections/*.ts; those stay (they
 * seed/close the PAYLOAD-side pool, which is fine — fixtures are data, not the system under test).
 *
 * Env (all required): V1_NEW_URL (api base URL, e.g. http://api:3000), DATABASE_URI (webdesk_app),
 * MIGRATE_DATABASE_URL (webdesk_migrator), API_KEY_PEPPER (must equal the api's).
 * Run from webdesk/api so `--import tsx` resolves:  node --import tsx ../payload/test/run-v1-differential.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const IMPORT_LINE = "import { handleV1Request } from '../collections/router.ts'"

const src = fs.readFileSync(path.join(here, 'envelope-contract.test.mjs'), 'utf8')
if (src.split(IMPORT_LINE).length - 1 !== 1) {
  console.error(`FATAL: envelope-contract.test.mjs no longer contains the expected import line exactly once:\n  ${IMPORT_LINE}`)
  process.exit(2)
}
const generated = path.join(here, '.generated-envelope-contract-tee.test.mjs')
fs.writeFileSync(generated, src.replace(IMPORT_LINE, "import { handleV1Request } from './lib-v1-differential.mjs'"))

function run(label, file, env) {
  console.log(`\n=== ${label} ===`)
  const r = spawnSync(process.execPath, ['--import', 'tsx', file], {
    env: { ...process.env, V1_DIFF_LABEL: label, ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  process.stdout.write(r.stdout)
  process.stderr.write(r.stderr)
  const diff = /\[v1-diff\] [^:]+: target-for-assertions=\w+ pairs=(\d+) identical=(\d+) different=(\d+) known_divergent=(\d+) statusonly=(\d+) statusonly_same=(\d+)/.exec(r.stdout)
  const suite = /WSK-06 envelope contract suite: (\d+) passed, (\d+) failed/.exec(r.stdout)
  return {
    label,
    exit: r.status,
    pairs: diff ? Number(diff[1]) : 0,
    identical: diff ? Number(diff[2]) : 0,
    different: diff ? Number(diff[3]) : -1,
    knownDivergent: diff ? Number(diff[4]) : 0,
    statusOnly: diff ? Number(diff[5]) : 0,
    statusOnlySame: diff ? Number(diff[6]) : 0,
    assertionsPassed: suite ? Number(suite[1]) : null,
    assertionsFailed: suite ? Number(suite[2]) : null,
  }
}

let results
try {
  results = [
    run('contract-suite replay, assertions on API responses', generated, { V1_DIFF_TARGET: 'api' }),
    run('contract-suite replay, assertions on OLD responses (baseline)', generated, { V1_DIFF_TARGET: 'old' }),
    run('extra error-path / edge-case replay', path.join(here, 'v1-differential-extra.test.mjs'), { V1_DIFF_TARGET: 'api' }),
  ]
} finally {
  fs.rmSync(generated, { force: true })
}

console.log('\n=================== WSK-48a differential verdict ===================')
let pairs = 0
let identical = 0
let known = 0
let statusOnly = 0
let statusOnlySame = 0
let ok = true
for (const r of results) {
  pairs += r.pairs
  identical += r.identical
  known += r.knownDivergent
  statusOnly += r.statusOnly
  statusOnlySame += r.statusOnlySame
  const suiteTxt = r.assertionsPassed === null ? '' : `  contract assertions: ${r.assertionsPassed} passed, ${r.assertionsFailed} failed`
  console.log(`  ${r.label}\n    byte-compared pairs=${r.pairs} identical=${r.identical} different=${r.different} known-framework-divergence=${r.knownDivergent}; status-only pairs=${r.statusOnly} same-status=${r.statusOnlySame}; exit=${r.exit}${suiteTxt}`)
  if (r.exit !== 0 || r.different !== 0 || r.pairs + r.statusOnly === 0 || r.statusOnly !== r.statusOnlySame || r.assertionsFailed) ok = false
}
console.log(`  TOTAL byte-compared request pairs: ${pairs}   identical: ${identical}   different: ${pairs - identical - known}   known framework divergences (invalid % escape -> Fastify 400): ${known}`)
console.log(`  TOTAL status-only pairs (outside /v1, different servers by design): ${statusOnly}   same status: ${statusOnlySame}`)
console.log(`  VERDICT: ${ok ? 'IDENTICAL' : 'DIFFERENCES FOUND'}`)
process.exit(ok ? 0 : 1)
