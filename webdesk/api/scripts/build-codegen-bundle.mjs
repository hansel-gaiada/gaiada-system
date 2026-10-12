#!/usr/bin/env node
// M6-P4r-a -- bundles WebDesk's contract generator into ONE ESM file the api image can run.
//
// Why a bundle: the generator (src/codegen/generator/*.mts) is outside tsc's include glob on
// purpose (see that directory's README: `.mts`, imports webdesk/delivery/vocabulary/** with
// explicit `.ts` extensions, which tsc's commonjs resolution rejects). It has only ever run
// through `tsx`, a devDependency, so none of it reached dist/ or the image. esbuild resolves those
// specifiers literally, so the sources stay untouched and this file is the whole bridge.
//
//   entry    src/codegen/generator/bundle-entry.mts      (the only place that lists the exports)
//   output   dist/codegen/generator.mjs                   (ESM, platform node, target node22)
//   inlined  every relative import, webdesk/delivery/vocabulary/**, and every npm package that is
//            NOT a production dependency (openapi-typescript + typescript are devDependencies:
//            only the generator uses them, so inlining them keeps the image's node_modules lean)
//   external every package named in package.json `dependencies` (pg, @aws-sdk/*, ...): they are
//            installed in the image already and must not be duplicated into the bundle
//
// Deterministic by construction: no minify, no sourcemap, no timestamps; esbuild orders its output
// by import graph. The codegen:gate:dist gate proves it by generating twice and byte-comparing.
import { build } from 'esbuild'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const API = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(API, 'package.json'), 'utf8'))
const external = Object.keys(pkg.dependencies ?? {}).flatMap((name) => [name, `${name}/*`])
const outfile = resolve(API, 'dist/codegen/generator.mjs')

mkdirSync(dirname(outfile), { recursive: true })
const result = await build({
  entryPoints: [resolve(API, 'src/codegen/generator/bundle-entry.mts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external,
  logLevel: 'warning',
  legalComments: 'none',
  metafile: true,
  // Inlined CommonJS packages (typescript, openapi-typescript's deps) call require() on node
  // builtins and read __filename/__dirname; an ES module has none of the three, so supply them.
  banner: {
    js: [
      "import { createRequire as __gdCreateRequire } from 'node:module';",
      "import { fileURLToPath as __gdFileURLToPath } from 'node:url';",
      "import { dirname as __gdDirname } from 'node:path';",
      'const require = __gdCreateRequire(import.meta.url);',
      'const __filename = __gdFileURLToPath(import.meta.url);',
      'const __dirname = __gdDirname(__filename);',
    ].join(' '),
  },
})

const bytes = Object.values(result.metafile.outputs)[0].bytes
const externalsUsed = [...new Set(
  Object.values(result.metafile.outputs)[0].imports.filter((i) => i.external).map((i) => i.path),
)].sort()
console.log(`codegen bundle: ${outfile} (${bytes} bytes); runtime externals: ${externalsUsed.join(', ')}`)
if (process.argv.includes('--metafile')) writeFileSync(resolve(API, 'dist/codegen/generator.meta.json'), JSON.stringify(result.metafile))
