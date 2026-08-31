#!/usr/bin/env -S node --import tsx
// webdesk/wordpress/sdk-gate/double-run-gate.mts
//
// WSK-34 — the PHP SDK's own determinism proof, in the exact shape WSK-15's own
// `webdesk/api/src/codegen/generator/double-run-gate.mts` already established (this file
// deliberately mirrors it rather than inventing a different methodology): for a named tenant
// fixture, spawn `generate-fixture-php.mts` as TWO SEPARATE `node` child processes (not two
// in-process calls — a fresh process/module cache per run), then byte-compare (`Buffer.compare`)
// the resulting sdk.php.
//
// This is a NARROWER, sibling gate to WSK-15's — it does not re-check openapi.v1.json/sdk.d.ts/
// CONTENT-CONTRACT.md (that determinism is WSK-15's own gate's job, unchanged by this ticket).
// It exists because `sdk.php` is not yet wired into WSK-15's `ARTIFACT_FILES` list at the point
// this ticket was scoped to `webdesk/wordpress/` only — see this ticket's report for the additive
// edit that DOES add "sdk.php" to that shared list (`generator/double-run-gate.mts`'s
// `ARTIFACT_FILES` array), which makes this file's proof a deliberate SECOND, narrower
// confirmation rather than the only one.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GENERATE_FIXTURE_PHP = fileURLToPath(new URL('./generate-fixture-php.mts', import.meta.url))

function parseArgs(argv: string[]): { tenants: string[] } {
  let tenantsArg: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tenants') tenantsArg = argv[++i]
  }
  if (!tenantsArg) {
    console.error('usage: double-run-gate.mts --tenants <acme,globex>')
    process.exit(2)
  }
  return { tenants: tenantsArg.split(',').map((t) => t.trim()).filter(Boolean) }
}

function runGenerate(tenant: string, outDir: string): void {
  execFileSync(process.execPath, ['--import', 'tsx', GENERATE_FIXTURE_PHP, '--tenant', tenant, '--out', outDir], {
    stdio: 'inherit',
    env: process.env,
  })
}

async function main() {
  const { tenants } = parseArgs(process.argv.slice(2))
  const root = mkdtempSync(join(tmpdir(), 'wsk34-php-double-run-'))
  const mismatches: string[] = []

  try {
    for (const tenant of tenants) {
      const runA = join(root, tenant, 'run1')
      const runB = join(root, tenant, 'run2')
      console.log(`-- ${tenant}: run 1 (fresh process) --`)
      runGenerate(tenant, runA)
      console.log(`-- ${tenant}: run 2 (fresh process) --`)
      runGenerate(tenant, runB)

      const a = readFileSync(join(runA, 'sdk.php'))
      const b = readFileSync(join(runB, 'sdk.php'))
      if (Buffer.compare(a, b) !== 0) {
        mismatches.push(`tenant "${tenant}": sdk.php differs between run 1 (${a.length} bytes) and run 2 (${b.length} bytes)`)
      } else {
        console.log(`-- ${tenant}: sdk.php byte-identical across both runs (${a.length} bytes) --`)
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  if (mismatches.length > 0) {
    console.error('PHP SDK DETERMINISM GATE FAILED:')
    for (const m of mismatches) console.error(`  - ${m}`)
    process.exit(1)
  }
  console.log(`PHP SDK DETERMINISM GATE PASSED — ${tenants.length} tenant(s), byte-identical across two separately spawned processes.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
