#!/usr/bin/env node
// webdesk/qa/p3-gate/generate-fixture-artifacts-dist.mjs
//
// M6-P4r-a -- the COMPILED-form sibling of generate-fixture-artifacts.mts. Same static fixture
// (fixtures/tenant-fixtures.mjs, no database), same `previous: null` baseline, but the generator is
// the one the api image ships: webdesk/api/dist/codegen/generator.mjs, run with plain `node` (no
// tsx, no loader). Writes the five deterministic artifacts to --out.
//
// usage: node generate-fixture-artifacts-dist.mjs --tenant <acme|globex> --out <dir> [--bundle <path>]
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fixtureFor } from './fixtures/tenant-fixtures.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const o = { tenant: undefined, out: undefined, bundle: resolve(HERE, '../../api/dist/codegen/generator.mjs') }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tenant') o.tenant = argv[++i]
    else if (argv[i] === '--out') o.out = argv[++i]
    else if (argv[i] === '--bundle') o.bundle = resolve(argv[++i])
  }
  if (!o.tenant || !o.out) {
    console.error('usage: generate-fixture-artifacts-dist.mjs --tenant <acme|globex> --out <dir> [--bundle <path>]')
    process.exit(2)
  }
  return o
}

const { tenant, out, bundle } = parseArgs(process.argv.slice(2))
const { buildContractArtifacts } = await import(pathToFileURL(bundle).href)
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
writeFileSync(join(out, 'sdk.php'), built.sdkPhp)
writeFileSync(join(out, 'CONTENT-CONTRACT.md'), built.contractMd)
writeFileSync(join(out, 'hash-manifest.json'), built.hashManifestJson)
console.log(`wrote 5 files to ${out} (contentHash ${built.contentHash}) from the compiled bundle`)
