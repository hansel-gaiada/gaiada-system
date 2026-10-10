#!/usr/bin/env node
// webdesk/api/src/delivery/vocabulary/vendor.mjs
//
// WSK-48a — vendors the subset of `webdesk/payload/vocabulary/**` that the /v1 delivery module
// (webdesk/api/src/delivery/) needs, so the api never imports the Payload app's source tree.
//
// WHY A COPY AND NOT AN IMPORT: webdesk/api is CommonJS (`tsconfig` "module": "commonjs"), and the
// vocabulary files use ESM `.ts`-extension relative imports (`from './primitives.ts'`), which
// `tsc` under that setting cannot resolve without `allowImportingTsExtensions` (which forces
// `noEmit`). Same constraint WSK-32 (src/schema-draft/vocabulary-vendor.ts) and WSK-16
// (webdesk/blocks/scripts/vendor-vocabulary.mjs) met. This file follows WSK-16's answer, NOT
// WSK-32's hand-transcription: the copies are produced MECHANICALLY from the real source, so
// there is no hand-restated rule anywhere in this directory to fall out of date silently.
//
// THE ONLY TRANSFORM (applied to source text, nothing else is ever rewritten):
//   1. line endings normalised to LF (a Windows checkout has CRLF, git's index has LF);
//   2. relative import specifiers lose their `.ts` extension:  from './x.ts'  ->  from './x'
//   3. a banner is prepended.
//
// Usage (from anywhere):
//   node src/delivery/vocabulary/vendor.mjs           — (re)writes the vendored copies
//   node src/delivery/vocabulary/vendor.mjs --check   — exits 1 on drift (used by
//                                                        test/delivery/vocabulary-vendor-drift.spec.ts)
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
// webdesk/api/src/delivery/vocabulary -> webdesk/payload/vocabulary
const SOURCE_DIR = path.resolve(HERE, '..', '..', '..', '..', 'payload', 'vocabulary')

// Exactly what ./router.ts, ./content-read.ts and ./redirects.ts import, plus the transitive
// closure of those (version.ts -> primitives.ts + blocks.ts).
//
// WSK-64 (vocabulary 1.1.0) adds composition.ts and item-fields.ts: this directory is the api's ONE
// importable copy of the vocabulary, so the write plane (WSK-41's content commands validate items
// with validateItemContent) and src/schema-draft/vocabulary-vendor.ts (which re-exports the
// composition validator from here instead of hand-transcribing it) use the real rules, mechanically.
// Still NOT breaking-change.ts / index.ts: nothing in the api needs them.
export const FILES = [
  'cache-tags.ts',
  'problem-details.ts',
  'locale.ts',
  'envelope.ts',
  'primitives.ts',
  'blocks.ts',
  'version.ts',
  'composition.ts',
  'item-fields.ts',
]

export function banner(file) {
  return (
    `// VENDORED — generated from webdesk/payload/vocabulary/${file} (WSK-06/WSK-14, frozen per\n` +
    `// webdesk-design.md §05) by webdesk/api/src/delivery/vocabulary/vendor.mjs. DO NOT HAND-EDIT.\n` +
    `// The only transform: LF line endings and relative '.ts' import extensions stripped (this\n` +
    `// package is CommonJS). Re-vendor with \`node src/delivery/vocabulary/vendor.mjs\`; drift is\n` +
    `// caught by test/delivery/vocabulary-vendor-drift.spec.ts.\n\n`
  )
}

export function transform(file, sourceText) {
  const lf = sourceText.replace(/\r\n/g, '\n')
  const stripped = lf.replace(/(\bfrom\s+')(\.{1,2}\/[^']+?)\.ts(')/g, '$1$2$3')
  return banner(file) + stripped
}

function normalise(text) {
  return text.replace(/\r\n/g, '\n')
}

function main() {
  const check = process.argv.includes('--check')
  let bad = false
  for (const file of FILES) {
    const srcPath = path.join(SOURCE_DIR, file)
    const destPath = path.join(HERE, file)
    if (!fs.existsSync(srcPath)) {
      console.error(`MISSING  ${srcPath}`)
      bad = true
      continue
    }
    const expected = transform(file, fs.readFileSync(srcPath, 'utf8'))
    if (check) {
      const actual = fs.existsSync(destPath) ? normalise(fs.readFileSync(destPath, 'utf8')) : null
      if (actual !== expected) {
        bad = true
        console.error(`DRIFT    delivery/vocabulary/${file} != payload/vocabulary/${file} (run vendor.mjs)`)
      } else {
        console.log(`OK       delivery/vocabulary/${file}`)
      }
    } else {
      fs.writeFileSync(destPath, expected)
      console.log(`wrote    delivery/vocabulary/${file}`)
    }
  }
  if (bad) process.exit(1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) main()
