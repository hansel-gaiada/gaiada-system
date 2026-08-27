#!/usr/bin/env node
// webdesk/scripts/check-contract-coherence.mjs
//
// WSK-18 condition 2 — "SDK <-> OpenAPI <-> contract coherence ... If a field exists in one and
// not the others, the gate fails and names the field."
//
// What this checks, concretely, over one tenant's generated artifact set (openapi.v1.json,
// sdk.d.ts, CONTENT-CONTRACT.md — the same three WSK-15's own double-run gate compares):
//
//   1. Every collection key documented in CONTENT-CONTRACT.md's `### `key`` headings has a
//      corresponding `ItemEnvelope_<key>` / `ListEnvelope_<key>` schema pair in openapi.v1.json,
//      and vice versa (openapi -> markdown).
//   2. Every schema name openapi.v1.json declares under `components.schemas` has a matching
//      exported type in sdk.d.ts's generated `components["schemas"]` interface (openapi-typescript's
//      own emitted shape), and vice versa.
//   3. Every path openapi.v1.json declares under `paths` has a matching key in sdk.d.ts's
//      generated `paths` interface, and vice versa.
//
// Why this can be checked mechanically at all: WSK-15's own pipeline derives sdk.d.ts AND
// CONTENT-CONTRACT.md from the SAME `OpenApiBuilderInput` in one generation run (openapi-builder.mts
// builds the OpenAPI doc; sdk-ts.mts derives the SDK from that doc via openapi-typescript;
// content-contract-md.mts derives the markdown from the SAME input, not by re-parsing the OpenAPI
// JSON — see that file's own header). That derivation makes the THREE artifacts unable to drift
// from EACH OTHER within a single generation run BY CONSTRUCTION. The gap this check actually
// closes is the one the codegen pipeline itself cannot see: a STALE artifact set — e.g. sdk.d.ts
// served from a cached/older `latest.json` pointer while openapi.v1.json was hand-edited, uploaded
// out of band, or partially re-generated. That is exactly the "silently drift" scenario condition
// 2 names, and it is a cross-process/cross-time gap the single-run derivation cannot self-detect.
//
// Run:
//   node webdesk/scripts/check-contract-coherence.mjs --dir <path with openapi.v1.json, sdk.d.ts, CONTENT-CONTRACT.md>
// Selftest (no artifacts needed — proves the compare logic can fail):
//   node webdesk/scripts/check-contract-coherence.mjs --selftest

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Extracts every `"<Name>": {` key directly under `components.schemas` in a parsed OpenAPI doc. */
function openApiSchemaNames(doc) {
  return new Set(Object.keys(doc?.components?.schemas ?? {}))
}

function openApiPathKeys(doc) {
  return new Set(Object.keys(doc?.paths ?? {}))
}

/** openapi.v1.json's `x-webdesk-contract.collectionKeys` (openapi-builder.mts's own info block) —
 *  the authoritative collection-key list this generation run declares. */
function openApiCollectionKeys(doc) {
  return new Set(doc?.info?.['x-webdesk-contract']?.collectionKeys ?? [])
}

/** `### `key`` headings in CONTENT-CONTRACT.md (content-contract-md.mts's own emitted format,
 *  `### \`${key}\``). */
function markdownCollectionKeys(md) {
  const keys = new Set()
  const re = /^### `([^`]+)`$/gm
  let m
  while ((m = re.exec(md))) keys.add(m[1])
  return keys
}

/** sdk.d.ts (openapi-typescript's emitted `.d.ts`) declares two interfaces this check reads by
 *  regex rather than a full TS parse (deliberately dependency-free — adding a TS parser to a QA
 *  gate script is a heavier footprint than the two patterns openapi-typescript reliably emits):
 *    - `export interface paths { "/v1/...": { ... } ... }`  -> path string keys
 *    - `schemas: { ItemEnvelope_x: components["schemas"]... }` under `export interface components`
 *  openapi-typescript (7.x, `alphabetize: true` — sdk-ts.mts's own option) emits quoted string
 *  keys for paths and identifier keys for schemas; both patterns below match that shape exactly
 *  and are pinned by this file's own selftest fixtures using REAL fragments of that shape.
 */
/** Returns the substring strictly between the `{` at `openBraceIndex` and its matching `}`,
 *  brace-depth aware (values inside can nest arbitrarily deep TS object/type syntax). Needed
 *  because a plain non-greedy regex (`\{([\s\S]*?)\n\}`) stops at the FIRST close brace, which is
 *  almost always a nested member's, not the block's own — exactly the bug this file's first
 *  selftest run caught (see the ticket's evidence: it under-extracted `sdk.d.ts`'s schema block to
 *  one member). */
function balancedBraceContent(text, openBraceIndex) {
  let depth = 0
  for (let i = openBraceIndex; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return text.slice(openBraceIndex + 1, i)
    }
  }
  return ''
}

/** Top-level `key:` / `"key":` / `key?:` member names directly inside a `{ ... }` block content —
 *  splits the content into top-level (`;`-terminated, depth-0) statements first, so a schema's OWN
 *  nested properties can never be mistaken for a sibling schema name. */
function topLevelMemberNames(rawBlockContent) {
  // openapi-typescript emits a `/** @description ... */` JSDoc block ahead of most members
  // (carried straight from this pipeline's own OpenAPI `description` fields) — strip block AND
  // line comments first, or a comment's own text (which never contains the terminating `;` this
  // scanner splits on) gets absorbed into the following member's "statement" and the regex that
  // expects the identifier at the very start never matches. Confirmed: the first real run against
  // acme's actual generated sdk.d.ts hit exactly this — 0 schema names extracted, 11 false
  // "missing from sdk.d.ts" findings, none of them real.
  const blockContent = rawBlockContent.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const names = new Set()
  let depth = 0
  let stmt = ''
  const flush = () => {
    const m = stmt.match(/^\s*(?:"([^"]+)"|([A-Za-z_$][A-Za-z0-9_$]*))\??\s*:/)
    if (m) names.add(m[1] ?? m[2])
    stmt = ''
  }
  for (const ch of blockContent) {
    if (ch === '{') { depth++; if (depth === 1) stmt += ch; continue }
    if (ch === '}') { depth--; continue }
    if (ch === ';' && depth === 0) { flush(); continue }
    if (depth === 0) stmt += ch
  }
  if (stmt.trim()) flush()
  return names
}

function sdkPathKeys(dts) {
  const headerIdx = dts.indexOf('export interface paths')
  if (headerIdx < 0) return new Set()
  const openBrace = dts.indexOf('{', headerIdx)
  const content = balancedBraceContent(dts, openBrace)
  const keys = new Set()
  const re = /^\s*"([^"]+)":/gm
  let m
  while ((m = re.exec(content))) keys.add(m[1])
  return keys
}

function sdkSchemaNames(dts) {
  const headerIdx = dts.indexOf('schemas:')
  if (headerIdx < 0) return new Set()
  const openBrace = dts.indexOf('{', headerIdx)
  const content = balancedBraceContent(dts, openBrace)
  return topLevelMemberNames(content)
}

/**
 * Core coherence comparison — pure, takes already-parsed/extracted sets so it is selftest-able
 * without real artifact files.
 */
export function compareCoherence({ openApiSchemas, sdkSchemas, openApiPaths, sdkPaths, openApiCollections, mdCollections }) {
  const findings = []

  const onlyIn = (setA, setB, labelA, labelB, kind) => {
    for (const item of setA) {
      if (!setB.has(item)) {
        findings.push(`${kind} "${item}" exists in ${labelA} but not in ${labelB}`)
      }
    }
  }

  onlyIn(openApiSchemas, sdkSchemas, 'openapi.v1.json (components.schemas)', 'sdk.d.ts (components["schemas"])', 'schema')
  onlyIn(sdkSchemas, openApiSchemas, 'sdk.d.ts (components["schemas"])', 'openapi.v1.json (components.schemas)', 'schema')

  onlyIn(openApiPaths, sdkPaths, 'openapi.v1.json (paths)', 'sdk.d.ts (paths)', 'path')
  onlyIn(sdkPaths, openApiPaths, 'sdk.d.ts (paths)', 'openapi.v1.json (paths)', 'path')

  onlyIn(openApiCollections, mdCollections, 'openapi.v1.json (x-webdesk-contract.collectionKeys)', 'CONTENT-CONTRACT.md (### headings)', 'collection')
  onlyIn(mdCollections, openApiCollections, 'CONTENT-CONTRACT.md (### headings)', 'openapi.v1.json (x-webdesk-contract.collectionKeys)', 'collection')

  return findings
}

function loadAndExtract(dir) {
  const openApiDoc = JSON.parse(readFileSync(join(dir, 'openapi.v1.json'), 'utf8'))
  const sdkDts = readFileSync(join(dir, 'sdk.d.ts'), 'utf8')
  const md = readFileSync(join(dir, 'CONTENT-CONTRACT.md'), 'utf8')

  return {
    openApiSchemas: openApiSchemaNames(openApiDoc),
    sdkSchemas: sdkSchemaNames(sdkDts),
    openApiPaths: openApiPathKeys(openApiDoc),
    sdkPaths: sdkPathKeys(sdkDts),
    openApiCollections: openApiCollectionKeys(openApiDoc),
    mdCollections: markdownCollectionKeys(md),
  }
}

// ---------------------------------------------------------------------------------------------
// selftest — proves the compare logic can fail, and that extraction regexes match REAL
// openapi-typescript / content-contract-md.mts output fragments (not invented shapes).
// ---------------------------------------------------------------------------------------------
function selftest() {
  const REAL_SDK_FRAGMENT = `
export interface paths {
    "/v1/t/acme/article": {
        get: operations["list_article"];
    };
    "/v1/t/acme/article/{slug}": {
        get: operations["get_article"];
    };
}
export interface components {
    schemas: {
        /** @description webdesk/payload/vocabulary/envelope.ts's ItemEnvelope — frozen. */
        ItemEnvelope_article: {
            collection: string;
        };
        ListEnvelope_article: {
            items: components["schemas"]["ItemEnvelope_article"][];
        };
        ProblemDetails: {
            type?: string;
        };
    };
}
`
  const REAL_MD_FRAGMENT = `# WebDesk content contract — acme

### \`article\`

- \`GET /v1/t/acme/article\` — cursor-paginated list
`

  const cases = [
    {
      name: 'a coherent set (all three axes agree) passes',
      input: {
        openApiSchemas: new Set(['ItemEnvelope_article', 'ListEnvelope_article', 'ProblemDetails']),
        sdkSchemas: sdkSchemaNames(REAL_SDK_FRAGMENT),
        openApiPaths: new Set(['/v1/t/acme/article', '/v1/t/acme/article/{slug}']),
        sdkPaths: sdkPathKeys(REAL_SDK_FRAGMENT),
        openApiCollections: new Set(['article']),
        mdCollections: markdownCollectionKeys(REAL_MD_FRAGMENT),
      },
      expect: 0,
    },
    {
      name: 'THE REGRESSION: openapi.v1.json gains a field/schema the SDK does not have (stale sdk.d.ts) — named',
      input: {
        openApiSchemas: new Set(['ItemEnvelope_article', 'ListEnvelope_article', 'ProblemDetails', 'ItemEnvelope_caseStudy']),
        sdkSchemas: sdkSchemaNames(REAL_SDK_FRAGMENT), // does NOT know ItemEnvelope_caseStudy
        openApiPaths: new Set(['/v1/t/acme/article', '/v1/t/acme/article/{slug}']),
        sdkPaths: sdkPathKeys(REAL_SDK_FRAGMENT),
        openApiCollections: new Set(['article']),
        mdCollections: markdownCollectionKeys(REAL_MD_FRAGMENT),
      },
      expect: 1,
      expectNames: ['ItemEnvelope_caseStudy'],
    },
    {
      name: 'a collection documented in the markdown but absent from openapi.v1.json is caught (named)',
      input: {
        openApiSchemas: new Set(['ItemEnvelope_article', 'ListEnvelope_article', 'ProblemDetails']),
        sdkSchemas: sdkSchemaNames(REAL_SDK_FRAGMENT),
        openApiPaths: new Set(['/v1/t/acme/article', '/v1/t/acme/article/{slug}']),
        sdkPaths: sdkPathKeys(REAL_SDK_FRAGMENT),
        openApiCollections: new Set(['article']),
        mdCollections: new Set(['article', 'caseStudy']), // markdown claims a collection openapi never declared
      },
      expect: 1,
      expectNames: ['caseStudy'],
    },
    {
      name: 'a path present in sdk.d.ts but missing from openapi.v1.json (partial regeneration) is caught',
      input: {
        openApiSchemas: new Set(['ItemEnvelope_article', 'ListEnvelope_article', 'ProblemDetails']),
        sdkSchemas: sdkSchemaNames(REAL_SDK_FRAGMENT),
        openApiPaths: new Set(['/v1/t/acme/article']), // missing the /{slug} path openapi-typescript still emitted
        sdkPaths: sdkPathKeys(REAL_SDK_FRAGMENT),
        openApiCollections: new Set(['article']),
        mdCollections: markdownCollectionKeys(REAL_MD_FRAGMENT),
      },
      expect: 1,
      expectNames: ['/v1/t/acme/article/{slug}'],
    },
  ]

  // Also pin the extraction regexes against the real fragments directly.
  const extracted = {
    sdkSchemas: [...sdkSchemaNames(REAL_SDK_FRAGMENT)].sort(),
    sdkPaths: [...sdkPathKeys(REAL_SDK_FRAGMENT)].sort(),
    mdCollections: [...markdownCollectionKeys(REAL_MD_FRAGMENT)].sort(),
  }
  const expectedExtraction = {
    sdkSchemas: ['ItemEnvelope_article', 'ListEnvelope_article', 'ProblemDetails'],
    sdkPaths: ['/v1/t/acme/article', '/v1/t/acme/article/{slug}'],
    mdCollections: ['article'],
  }
  let fails = 0
  const extractOk = JSON.stringify(extracted) === JSON.stringify(expectedExtraction)
  console.log(`  ${extractOk ? 'PASS' : 'FAIL'}  extraction regexes match real openapi-typescript/content-contract-md.mts output shapes`)
  if (!extractOk) {
    fails++
    console.log(`      got: ${JSON.stringify(extracted)}`)
    console.log(`      want: ${JSON.stringify(expectedExtraction)}`)
  }

  for (const c of cases) {
    const findings = compareCoherence(c.input)
    let ok = findings.length === c.expect
    if (ok && c.expectNames) {
      ok = c.expectNames.every((n) => findings.some((f) => f.includes(`"${n}"`)))
    }
    if (!ok) fails++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name}  (${findings.length} finding(s))`)
    if (!ok) for (const f of findings) console.log(`      - ${f}`)
  }

  console.log(`\n  selftest: ${cases.length + 1 - fails} passed, ${fails} failed`)
  return fails === 0 ? 0 : 1
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--selftest')) process.exit(selftest())

  const dirIdx = argv.indexOf('--dir')
  if (dirIdx < 0) {
    console.error('usage: check-contract-coherence.mjs --dir <path with openapi.v1.json, sdk.d.ts, CONTENT-CONTRACT.md>')
    process.exit(2)
  }
  const dir = argv[dirIdx + 1]
  const extracted = loadAndExtract(dir)
  const findings = compareCoherence(extracted)

  if (findings.length === 0) {
    console.log(`[contract-coherence] OK — ${dir}: schemas, paths and collection keys agree across openapi.v1.json, sdk.d.ts, CONTENT-CONTRACT.md.`)
    process.exit(0)
  }
  console.error(`[contract-coherence] FAILED — ${findings.length} drift(s) in ${dir}:\n`)
  for (const f of findings) console.error(`  - ${f}`)
  process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
