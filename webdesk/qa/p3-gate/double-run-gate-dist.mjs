#!/usr/bin/env node
// webdesk/qa/p3-gate/double-run-gate-dist.mjs
//
// M6-P4r-a -- WSK-15's determinism gate (double-run-gate.mts) for the COMPILED generator, DB-free.
// For each fixture tenant:
//   1. spawn generate-fixture-artifacts-dist.mjs TWICE, as two separate plain `node` processes
//      (no tsx), and byte-compare every artifact between the two runs;
//   2. generate the same fixture through the tsx path (generate-fixture-artifacts.mts for the
//      openapi/sdk.d.ts/CONTENT-CONTRACT/hash-manifest set, ../../wordpress/sdk-gate/
//      generate-fixture-php.mts for sdk.php) and byte-compare the compiled output against it.
// A compiled generator that is stable but differs from the source generator is as wrong as an
// unstable one: the bundle must be a faithful compilation, byte for byte.
//
// usage (from webdesk/api, after `npm run build:codegen`):
//   node ../qa/p3-gate/double-run-gate-dist.mjs --tenants acme,globex
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const API = resolve(HERE, '../../api')
const BUNDLE = join(API, 'dist/codegen/generator.mjs')
const GEN_DIST = join(HERE, 'generate-fixture-artifacts-dist.mjs')
const GEN_TSX = join(HERE, 'generate-fixture-artifacts.mts')
const GEN_TSX_PHP = resolve(HERE, '../../wordpress/sdk-gate/generate-fixture-php.mts')

// artifact file -> which tsx generator also writes it
const FILES = ['openapi.v1.json', 'sdk.d.ts', 'CONTENT-CONTRACT.md', 'hash-manifest.json', 'sdk.php']
const TSX_SOURCE = { 'openapi.v1.json': 'main', 'sdk.d.ts': 'main', 'CONTENT-CONTRACT.md': 'main', 'hash-manifest.json': 'main', 'sdk.php': 'php' }

let tenantsArg
for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === '--tenants') tenantsArg = process.argv[++i]
if (!tenantsArg) {
  console.error('usage: double-run-gate-dist.mjs --tenants <acme,globex>')
  process.exit(2)
}
const tenants = tenantsArg.split(',').map((t) => t.trim()).filter(Boolean)
if (!existsSync(BUNDLE)) {
  console.error(`compiled bundle missing: ${BUNDLE} (run \`npm run build:codegen\` in webdesk/api first)`)
  process.exit(2)
}

const node = (args, cwd) => execFileSync(process.execPath, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'], env: process.env })
const root = mkdtempSync(join(tmpdir(), 'm6-p4ra-dist-gate-'))
const problems = []
const differs = (label, a, b) => {
  if (Buffer.compare(a, b) === 0) return false
  problems.push(`${label}: ${a.length} vs ${b.length} bytes`)
  return true
}

try {
  for (const t of tenants) {
    const d1 = join(root, t, 'dist-run1')
    const d2 = join(root, t, 'dist-run2')
    const tsx = join(root, t, 'tsx-main')
    const tsxPhp = join(root, t, 'tsx-php')
    console.log(`-- ${t}: compiled bundle, run 1 (fresh process) --`)
    node([GEN_DIST, '--tenant', t, '--out', d1], API)
    console.log(`-- ${t}: compiled bundle, run 2 (fresh process) --`)
    node([GEN_DIST, '--tenant', t, '--out', d2], API)
    console.log(`-- ${t}: tsx reference --`)
    node(['--import', 'tsx', GEN_TSX, '--tenant', t, '--out', tsx], API)
    node(['--import', 'tsx', GEN_TSX_PHP, '--tenant', t, '--out', tsxPhp], API)

    let sameRuns = 0
    let sameTsx = 0
    for (const f of FILES) {
      const a = readFileSync(join(d1, f))
      const b = readFileSync(join(d2, f))
      const ref = readFileSync(join(TSX_SOURCE[f] === 'php' ? tsxPhp : tsx, f))
      if (!differs(`tenant "${t}" ${f}: compiled run 1 vs run 2`, a, b)) sameRuns++
      if (!differs(`tenant "${t}" ${f}: compiled vs tsx`, a, ref)) sameTsx++
    }
    console.log(`-- ${t}: ${sameRuns}/${FILES.length} artifacts byte-identical across two compiled runs; ${sameTsx}/${FILES.length} byte-identical to the tsx output --`)
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

if (problems.length > 0) {
  console.error('COMPILED CODEGEN DETERMINISM GATE FAILED:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(`COMPILED CODEGEN DETERMINISM GATE PASSED -- ${tenants.length} tenant(s), ${FILES.length} artifacts each: stable across two separately spawned node processes and byte-identical to the tsx generator.`)
