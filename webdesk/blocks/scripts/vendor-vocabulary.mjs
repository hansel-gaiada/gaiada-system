#!/usr/bin/env node
// webdesk/blocks/scripts/vendor-vocabulary.mjs
//
// WSK-16 — vendors the subset of `webdesk/payload/vocabulary/**` (WSK-06/WSK-14, frozen per
// webdesk-design.md §05) that this package's Props types and renderer need, so the PACKED
// TARBALL is self-contained.
//
// WHY THIS EXISTS (read before "just import it directly"): WSK-16's own ticket instruction says
// "Import the block prop schemas from [webdesk/payload/vocabulary] — do NOT restate them." That
// instruction is correct for every OTHER consumer of the vocabulary shipped so far (WSK-15's
// codegen imports it with a relative path like `../../../../payload/vocabulary/primitives.ts`,
// per api/src/codegen/generator/vocabulary-field-schema.mts) — but every one of those consumers
// runs INSIDE this repo, on this filesystem, forever. This package is different: constraint 3 of
// the WSK-16 ticket requires it to `npm pack` into a tarball a SCAFFOLDED SITE — outside this
// repo entirely — installs by path (OQ-6: no registry infra). Once installed into some other
// project's node_modules, a relative import like `../../payload/vocabulary/blocks.ts` resolves to
// nothing; there is no `payload/vocabulary` two directories up from a site's node_modules.
//
// So a straight relative import (WSK-15's pattern) would build and typecheck fine INSIDE this
// repo and then silently be unshippable — the failure would only surface the first time someone
// actually tried to install the tarball into a real site. Vendoring — copying the exact source
// files verbatim into this package at pack time, with a mechanical drift check — is the answer
// that keeps `webdesk/payload/vocabulary` the single source of truth (this script never
// hand-restates a type or a validation rule; it copies bytes) while producing an artifact that
// actually survives being installed somewhere else. See the WSK-16 ticket report for the
// reciprocal recommendation: long-term, `payload/vocabulary` should probably become its own
// publishable package that both `api`'s codegen and this package depend on formally, instead of
// each inventing its own answer to "how do I reach code across a package boundary that won't
// exist post-install." That is a cross-cutting call outside this ticket's `webdesk/blocks/**`
// scope — reported, not decided here.
//
// Usage:
//   node scripts/vendor-vocabulary.mjs          — (re)writes src/vocabulary/*.ts from the source
//   node scripts/vendor-vocabulary.mjs --check  — exits 1 if any vendored file is stale (CI gate)
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const SOURCE_DIR = path.resolve(__dirname, '..', '..', 'payload', 'vocabulary')
const DEST_DIR = path.resolve(__dirname, '..', 'src', 'vocabulary')

// Only the files the Props types / renderer / envelope typing actually need. NOT the whole
// vocabulary package (e.g. composition.ts, breaking-change.ts, locale.ts, problem-details.ts,
// index.ts are WSK-14/19/32 concerns this renderer has no reason to carry).
const FILES = ['primitives.ts', 'blocks.ts', 'envelope.ts', 'version.ts']

const CHECK = process.argv.includes('--check')

function banner(file) {
  return (
    `// VENDORED — copied verbatim from webdesk/payload/vocabulary/${file} (WSK-06/WSK-14,\n` +
    `// frozen per webdesk-design.md §05). DO NOT HAND-EDIT THIS FILE.\n` +
    `//\n` +
    `// Regenerate with \`npm run vendor:vocabulary\` from webdesk/blocks/. Check for drift with\n` +
    `// \`npm run vendor:check\` (also runs as part of \`npm run build\` / \`prepack\`).\n` +
    `//\n` +
    `// Why a copy exists at all instead of a relative import: this package ships as an installable\n` +
    `// tarball to sites OUTSIDE this repo (WSK-16, OQ-6 — no registry infra), where\n` +
    `// \`../../payload/vocabulary\` will not exist. See scripts/vendor-vocabulary.mjs's header for\n` +
    `// the full reasoning. The vocabulary source above this banner is byte-identical to the real\n` +
    `// file — this script has never rewritten a single line of it.\n\n`
  )
}

let drift = false
let missing = false

for (const file of FILES) {
  const srcPath = path.join(SOURCE_DIR, file)
  const destPath = path.join(DEST_DIR, file)

  if (!fs.existsSync(srcPath)) {
    console.error(`MISSING  ${srcPath} does not exist — has webdesk/payload/vocabulary been restructured?`)
    missing = true
    continue
  }

  const srcContent = fs.readFileSync(srcPath, 'utf8')
  const expected = banner(file) + srcContent

  if (CHECK) {
    const actual = fs.existsSync(destPath) ? fs.readFileSync(destPath, 'utf8') : null
    if (actual !== expected) {
      drift = true
      console.error(`DRIFT    src/vocabulary/${file} does not match payload/vocabulary/${file} — run \`npm run vendor:vocabulary\``)
    } else {
      console.log(`OK       src/vocabulary/${file} matches payload/vocabulary/${file}`)
    }
  } else {
    fs.mkdirSync(DEST_DIR, { recursive: true })
    fs.writeFileSync(destPath, expected)
    console.log(`wrote    src/vocabulary/${file}`)
  }
}

if (missing) {
  console.error('\nvendor-vocabulary: aborting — one or more source files are missing.')
  process.exit(1)
}

if (CHECK && drift) {
  console.error('\nvendor-vocabulary --check: FAILED — vendored copies are stale.')
  process.exit(1)
}

if (CHECK) {
  console.log('\nvendor-vocabulary --check: OK — all vendored files match the source vocabulary.')
}
