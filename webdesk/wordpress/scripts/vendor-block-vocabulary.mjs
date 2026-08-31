#!/usr/bin/env node
// webdesk/wordpress/scripts/vendor-block-vocabulary.mjs
//
// Run with PLAIN `node` (Node 22.18+/24's native TypeScript type-stripping imports `blocks.ts`
// directly), NOT `--import tsx` — `tsx`'s dynamic-import prescan throws a parse error on this
// directory's own header comments for reasons never worth chasing to a root cause; the same
// documented dodge `webdesk/qa/p3-gate/README.md`'s "condition 1" section and WSK-16's own README
// already use for the identical symptom. Confirmed working locally; verify again on Linux
// (node:22-bookworm-slim, the standing rule) before trusting it there too.
//
// WSK-35 — vendors ONLY the block-TYPE-NAME list (`BLOCK_TYPE_NAMES`) from
// `webdesk/payload/vocabulary/blocks.ts` (WSK-06/WSK-14, frozen) into a plain PHP array,
// `theme/gaiada-webdesk/inc/block-vocabulary.php`. This is the SAME class of problem WSK-16
// solved for `webdesk/blocks` (see that package's own `scripts/vendor-vocabulary.mjs` header,
// vendored verbatim reasoning): PHP cannot `import` a `.ts` file at all, ESM or otherwise, so
// there is no "just import it" option here — vendoring-with-a-drift-check is not a workaround,
// it is the only mechanism available across this particular language boundary. Mirrors WSK-16's
// pattern exactly: `--check` fails loudly (CI gate) rather than silently drifting, per this
// program's "WSK-16 built vendor:check precisely because a vendored copy went stale" hazard.
//
// Usage:
//   node scripts/vendor-block-vocabulary.mjs          — (re)writes inc/block-vocabulary.php
//   node scripts/vendor-block-vocabulary.mjs --check  — exits 1 if the vendored file is stale
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { BLOCK_TYPE_NAMES } from '../../payload/vocabulary/blocks.ts'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const DEST = path.resolve(__dirname, '..', 'theme', 'gaiada-webdesk', 'inc', 'block-vocabulary.php')
const CHECK = process.argv.includes('--check')

function render(names) {
  const phpArray = names.map((n) => `    '${n}',`).join('\n')
  return (
    `<?php\n` +
    `// VENDORED — copied from webdesk/payload/vocabulary/blocks.ts's BLOCK_TYPE_NAMES (WSK-06/\n` +
    `// WSK-14, frozen per webdesk-design.md §05). DO NOT HAND-EDIT.\n` +
    `//\n` +
    `// PHP cannot import a TypeScript module, so this is a vendored copy of the NAME LIST only\n` +
    `// (never a restatement of validation rules — those stay TS-side, WSK-06/14's job) — same\n` +
    `// vendor-with-a-drift-check pattern webdesk/blocks (WSK-16) already established for its own\n` +
    `// language-boundary problem. Regenerate with \`node scripts/vendor-block-vocabulary.mjs\` from\n` +
    `// webdesk/wordpress/. Check for drift with \`node scripts/vendor-block-vocabulary.mjs --check\`.\n` +
    `declare(strict_types=1);\n\n` +
    `namespace GaiadaWebDesk\\Theme;\n\n` +
    `/** @return string[] */\n` +
    `function gaiada_known_block_types(): array\n` +
    `{\n` +
    `    return [\n` +
    `${phpArray}\n` +
    `    ];\n` +
    `}\n`
  )
}

const expected = render(BLOCK_TYPE_NAMES)

if (CHECK) {
  const actual = fs.existsSync(DEST) ? fs.readFileSync(DEST, 'utf8') : null
  if (actual !== expected) {
    console.error(`DRIFT    ${DEST} does not match webdesk/payload/vocabulary/blocks.ts's BLOCK_TYPE_NAMES — run \`node scripts/vendor-block-vocabulary.mjs\``)
    if (actual !== null) {
      console.error(`  vendored has ${(actual.match(/'\w+',/g) ?? []).length} names, source has ${BLOCK_TYPE_NAMES.length}`)
    }
    process.exit(1)
  }
  console.log(`OK       ${DEST} matches webdesk/payload/vocabulary/blocks.ts's BLOCK_TYPE_NAMES (${BLOCK_TYPE_NAMES.length} types)`)
  process.exit(0)
}

fs.mkdirSync(path.dirname(DEST), { recursive: true })
fs.writeFileSync(DEST, expected)
console.log(`wrote    ${DEST} (${BLOCK_TYPE_NAMES.length} types)`)
