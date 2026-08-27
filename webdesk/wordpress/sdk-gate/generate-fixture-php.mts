#!/usr/bin/env -S node --import tsx
// webdesk/wordpress/sdk-gate/generate-fixture-php.mts
//
// WSK-34 — a DB-free sibling of WSK-15's `generate-single.mts` / WSK-18's
// `qa/p3-gate/generate-fixture-artifacts.mts`, narrowed to the ONE artifact this ticket owns:
// `sdk.php`. Reuses BOTH of those tickets' own code UNCHANGED:
//   - `buildContractArtifacts` (webdesk/api/src/codegen/generator/build-artifacts.mts) — the same
//     pure function every other artifact (openapi.v1.json, sdk.d.ts, CONTENT-CONTRACT.md) goes
//     through, now also producing `sdkPhp` (see that file's WSK-34 edit).
//   - `fixtureFor` (webdesk/qa/p3-gate/fixtures/tenant-fixtures.mjs) — WSK-18's static,
//     DB-free `TenantComposition` fixtures, READ ONLY (this file adds no fixture of its own,
//     so a WSK-34 run and a WSK-18 run are provably exercising the identical composition input).
//
// Why this file exists instead of just re-running `qa/p3-gate/generate-fixture-artifacts.mts`:
// that script is WSK-18's OWNED file (this ticket's brief: read anything, touch nothing outside
// `webdesk/wordpress/`) and it does not yet know about `sdk.php` — regenerating it to add a 6th
// output line would be an edit to another ticket's directory. This file is the WSK-34-owned
// equivalent, deliberately minimal (one artifact), living entirely under `webdesk/wordpress/`.
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildContractArtifacts } from '../../api/src/codegen/generator/build-artifacts.mts'
import { fixtureFor } from '../../qa/p3-gate/fixtures/tenant-fixtures.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
void HERE

function parseArgs(argv: string[]): { tenant: string; out: string } {
  let tenant: string | undefined
  let out: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tenant') tenant = argv[++i]
    else if (argv[i] === '--out') out = argv[++i]
  }
  if (!tenant || !out) {
    console.error('usage: generate-fixture-php.mts --tenant <acme|globex> --out <dir>')
    process.exit(2)
  }
  return { tenant, out }
}

async function main() {
  const { tenant, out } = parseArgs(process.argv.slice(2))
  const fixture = fixtureFor(tenant)

  const built = await buildContractArtifacts({
    tenantSlug: fixture.tenantSlug,
    defaultLocale: fixture.defaultLocale,
    locales: fixture.locales,
    composition: fixture.composition,
    previous: null,
  })

  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'sdk.php'), built.sdkPhp)
  writeFileSync(join(out, 'hash-manifest.json'), built.hashManifestJson)

  console.log(`wrote sdk.php (${built.sdkPhp.length} bytes) to ${out} — sdkPhp hash ${JSON.parse(built.hashManifestJson).sdkPhp}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
