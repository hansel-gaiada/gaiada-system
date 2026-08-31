#!/usr/bin/env -S node --import tsx
// webdesk/qa/p3-gate/generate-fixture-artifacts.mts
//
// WSK-18 condition 1 (determinism double-run + CROSS-MACHINE) — a DB-free sibling of WSK-15's
// `generate-single.mts`. That script fetches a live tenant from Postgres; this one takes a static
// fixture (fixtures/tenant-fixtures.mjs) instead, specifically so the cross-machine run
// (check-determinism-crossmachine.mjs) can spawn this in two SEPARATE Docker containers that do
// NOT share a database — proving the artifacts are byte-identical because the generator itself is
// deterministic given the same input, not because both runs happened to read the same DB row at
// the same instant.
//
// Reuses `buildContractArtifacts` (webdesk/api/src/codegen/generator/build-artifacts.mts)
// UNCHANGED — this file adds no generation logic of its own, per this ticket's "read anything,
// touch nothing outside your area" rule. Writes the same 4 artifacts WSK-15's own gate compares,
// plus a `tool-versions.json` recording exactly what produced them (node, tsx, openapi-typescript)
// — the "pinned tool versions" half of condition 1, which WSK-15's double-run-gate.mts does not
// itself record.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { buildContractArtifacts } from '../../api/src/codegen/generator/build-artifacts.mts'
import { fixtureFor } from './fixtures/tenant-fixtures.mjs'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv: string[]): { tenant: string; out: string } {
  let tenant: string | undefined
  let out: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tenant') tenant = argv[++i]
    else if (argv[i] === '--out') out = argv[++i]
  }
  if (!tenant || !out) {
    console.error('usage: generate-fixture-artifacts.mts --tenant <acme|globex> --out <dir>')
    process.exit(2)
  }
  return { tenant, out }
}

function readPkgVersion(pkgName: string): string {
  try {
    // Resolve via the api package's own node_modules — this file is always run with that
    // directory copied alongside it (see check-determinism-crossmachine.mjs).
    const pkgJsonPath = require.resolve(`${pkgName}/package.json`, { paths: [join(HERE, '../../api')] })
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
    return pkg.version
  } catch (err) {
    return `UNRESOLVED (${(err as Error).message})`
  }
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
  writeFileSync(join(out, 'openapi.v1.json'), built.openapiJson)
  writeFileSync(join(out, 'sdk.d.ts'), built.sdkTs)
  writeFileSync(join(out, 'CONTENT-CONTRACT.md'), built.contractMd)
  writeFileSync(join(out, 'hash-manifest.json'), built.hashManifestJson)

  const toolVersions = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    tsx: readPkgVersion('tsx'),
    'openapi-typescript': readPkgVersion('openapi-typescript'),
  }
  writeFileSync(join(out, 'tool-versions.json'), JSON.stringify(toolVersions, null, 2) + '\n')

  console.log(`wrote 5 files to ${out} (contentHash ${built.contentHash}) — tools: ${JSON.stringify(toolVersions)}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
