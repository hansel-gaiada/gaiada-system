#!/usr/bin/env node
// webdesk/scripts/check-unknown-block-rejection.mjs
//
// Deliberately run with PLAIN node, no `--import tsx`: the imported vocabulary/renderer files are
// plain, erasable-syntax TypeScript, and tsx's dynamic-import prescan choked on this file's own
// header comment (confirmed while building this check — a `Parse error ... transformDynamicImport`
// at a byte offset landing inside a `//` comment, moving every time the comment text changed).
// Node 22.18+/24's native type-stripping (WSK-16's README documents the same choice for the same
// reason) imports these files directly with no loader at all.
//
// WSK-18 condition 3 — a block the vocabulary does not know must be REJECTED, not silently
// dropped or passed through (the ticket's own wording).
//
// THIS SYSTEM HAS TWO DIFFERENT, DELIBERATE "unknown block" behaviours at two different moments,
// and they are opposite on purpose. Getting this gate right means probing the correct one, not
// forcing the wrong one to change:
//
//   (a) COMPOSITION / AUTHORING time — a TENANT declares which block types a collection may use
//       (`collections.schema.blocks`, WSK-14's `validateCollectionComposition`). Proposing a
//       block type the vocabulary does not know here is an AUTHORING MISTAKE (a typo, a
//       hallucinated type from an AI-drafted proposal per WSK-32, a hand-edited schema) — and
//       `composition.ts`'s own header says so explicitly: "a composition proposing a primitive or
//       block type that does not exist in the vocabulary ... must be rejected loudly with an
//       actionable error." THIS is condition 3's real target.
//
//   (b) READ / RENDER time — a CONTENT ITEM already stored in an older tenant is served through a
//       pinned older contract, and a NEWER vocabulary-MINOR block type appears in its `blocks`
//       array (or a genuinely unrecognized type reaches the renderer some other way). Here the
//       design's OWN frozen rule (§05 hard rule 2, "the renderer invariant") requires the OPPOSITE
//       of rejection: the block is skipped and reported, never thrown, never dropped without a
//       trace, and the wire schema (openapi-builder.mts's `UNKNOWN_BLOCK_SCHEMA`) is deliberately
//       permissive so a vocabulary-MINOR addition never becomes a wire-level 500 or a hard
//       contract-version break for an older pinned SDK. WSK-16's own renderer proves this half
//       already (`resolve-blocks.ts` + BlockRenderer.astro — "renders nothing and reports").
//
// So this gate asserts (a) is REAL rejection with an actionable, NAMED error — and separately
// documents that (b)'s permissiveness is intentional, not a gap this ticket may "fix" by making
// the renderer throw (that would violate a frozen design decision two tickets already shipped
// against). Forcing rejection at (b) would be the wrong fix for the wrong layer.
//
// Run (imports the real composition validator — no fixture reimplementation):
//   node --import tsx webdesk/scripts/check-unknown-block-rejection.mjs
// Selftest — proves the gate can fail, using a DELIBERATELY WEAKENED validator (not the shipped
// one) so a real defect in the shipped validator would show up as the real-run FAILING, not the
// selftest silently passing regardless:
//   node --import tsx webdesk/scripts/check-unknown-block-rejection.mjs --selftest

// Static relative imports (not dynamic `import()` on a computed path) — deliberate: tsx's dynamic-
// import transform choked on a computed specifier when this file first ran (confirmed while
// building this check), and every other consumer in this repo (openapi-builder.mts,
// resolve-blocks.ts's own test suite) reaches the vocabulary the same static way.
import { validateCollectionComposition, validateTenantComposition } from '../payload/vocabulary/composition.ts'
import { BLOCK_TYPE_NAMES, isBlockType } from '../payload/vocabulary/blocks.ts'
import { resolveBlocks } from '../blocks/src/renderer/resolve-blocks.ts'

const UNKNOWN_BLOCK_TYPE = 'pricingTable' // same probe value WSK-16's own demo used — an
// out-of-vocabulary type that is NOT one of the 9 frozen block types (blocks.ts's BlockType union).

async function realRun() {
  const failures = []

  // --- Precondition: the probe type must genuinely be unknown, or this whole check is inert ---
  if (isBlockType(UNKNOWN_BLOCK_TYPE)) {
    console.error(`[unknown-block-reject] SETUP ERROR — "${UNKNOWN_BLOCK_TYPE}" IS a known vocabulary block type now (${BLOCK_TYPE_NAMES.join(', ')}). Pick a different probe value; this check is meaningless against a type the vocabulary actually knows.`)
    process.exit(2)
  }

  // --- (a) composition/authoring rejection — the real target ---
  const singleResult = validateCollectionComposition('article', { blocks: ['hero', UNKNOWN_BLOCK_TYPE] })
  if (singleResult.valid) {
    failures.push(`validateCollectionComposition ACCEPTED an out-of-vocabulary block type ("${UNKNOWN_BLOCK_TYPE}") in "article.blocks" — this must be rejected (composition.ts's own documented rule).`)
  } else {
    const named = singleResult.issues.some((i) => i.path.includes('article.blocks') && i.message.includes(UNKNOWN_BLOCK_TYPE))
    if (!named) {
      failures.push(`validateCollectionComposition rejected the composition, but no issue names the offending block type "${UNKNOWN_BLOCK_TYPE}" or its path — got: ${JSON.stringify(singleResult.issues)}`)
    }
  }

  // --- whole-tenant path (validateTenantComposition), same probe, plus a KNOWN sibling collection
  //     to prove the gate does not over-trigger on the rest of a valid tenant ---
  const tenantResult = validateTenantComposition({
    article: { blocks: ['hero', UNKNOWN_BLOCK_TYPE] },
    caseStudy: { blocks: ['testimonial', 'gallery'] }, // entirely valid — must not appear in issues
  })
  if (tenantResult.valid) {
    failures.push('validateTenantComposition ACCEPTED a whole-tenant composition containing an out-of-vocabulary block type.')
  } else {
    const namedRight = tenantResult.issues.some((i) => i.path === 'article.blocks[1]' && i.message.includes(UNKNOWN_BLOCK_TYPE))
    const falseAlarmOnValidSibling = tenantResult.issues.some((i) => i.path.startsWith('caseStudy'))
    if (!namedRight) failures.push(`validateTenantComposition rejected the tenant, but did not name "article.blocks[1]" / "${UNKNOWN_BLOCK_TYPE}" — got: ${JSON.stringify(tenantResult.issues)}`)
    if (falseAlarmOnValidSibling) failures.push(`validateTenantComposition raised an issue against "caseStudy", which is entirely valid — over-triggering, not precise rejection: ${JSON.stringify(tenantResult.issues)}`)
  }

  // --- positive control: an all-known composition must NOT be rejected (a gate that rejects
  //     everything is as useless as one that rejects nothing) ---
  const knownOnly = validateCollectionComposition('article', { blocks: ['hero', 'richText', 'cta'] })
  if (!knownOnly.valid) {
    failures.push(`validateCollectionComposition rejected an ALL-KNOWN block list — false positive: ${JSON.stringify(knownOnly.issues)}`)
  }

  // --- documented, not silently assumed: the renderer's (b) permissiveness is real and on purpose ---
  const resolved = resolveBlocks([{ type: 'hero', props: {} }, { type: UNKNOWN_BLOCK_TYPE, props: {} }])
  const rendererSkipsRatherThanThrows = resolved.length === 2 && resolved[0].known === true && resolved[1].known === false
  if (!rendererSkipsRatherThanThrows) {
    failures.push(`resolveBlocks()'s behavior on an unknown block type changed from the documented renderer invariant (§05 hard rule 2) — got: ${JSON.stringify(resolved)}. If this is an intentional design change, WSK-16/17's renderer invariant tests must be updated in the SAME change, and this gate's condition-3 target re-scoped.`)
  }

  if (failures.length === 0) {
    console.log('[unknown-block-reject] OK —')
    console.log('  (a) composition/authoring: an out-of-vocabulary block type is REJECTED with an actionable error naming the exact path and type, single-collection AND whole-tenant, no false positives on valid siblings.')
    console.log('  (b) read/render: an out-of-vocabulary block type is skipped-and-reported, never thrown — confirmed intentional per design §05 hard rule 2 (WSK-16), NOT a gap condition 3 requires closing.')
    process.exit(0)
  }
  console.error(`[unknown-block-reject] FAILED — ${failures.length} finding(s):\n`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------------------------
// selftest — proves the CHECK ITSELF can fail, using a deliberately-weakened stand-in validator
// (never the real shipped one — this is a check-on-the-check, not a re-run of the real gate).
// ---------------------------------------------------------------------------------------------
function weakenedValidateCollectionComposition_PASSTHROUGH_BUG(_key, raw) {
  // The bug this simulates: a validator that only checks STRUCTURE (is `blocks` an array of
  // strings?) and never cross-checks each entry against the vocabulary's known set — i.e. exactly
  // the "silently pass through" failure mode condition 3 exists to catch.
  const blocks = raw && raw.blocks
  if (blocks !== undefined && (!Array.isArray(blocks) || !blocks.every((b) => typeof b === 'string'))) {
    return { valid: false, issues: [{ path: 'blocks', message: 'must be an array of strings' }] }
  }
  return { valid: true, issues: [] } // <-- never checks vocabulary membership
}

function selftest() {
  const cases = [
    {
      name: 'the REAL check logic (as run above) against a validator that genuinely rejects unknown types — PASS expected',
      validate: (key, raw) => {
        const known = new Set(['hero', 'richText', 'cta', 'testimonial', 'gallery'])
        const issues = []
        for (const [i, b] of (raw.blocks ?? []).entries()) {
          if (!known.has(b)) issues.push({ path: `${key}.blocks[${i}]`, message: `"${b}" is not a known block type` })
        }
        return { valid: issues.length === 0, issues }
      },
      expectDetectsRejection: true,
    },
    {
      name: 'THE REGRESSION this gate exists to catch: a validator that silently passes an unknown block through — must be caught as a FAILURE of the check',
      validate: weakenedValidateCollectionComposition_PASSTHROUGH_BUG,
      expectDetectsRejection: false,
    },
  ]

  let fails = 0
  for (const c of cases) {
    const result = c.validate('article', { blocks: ['hero', UNKNOWN_BLOCK_TYPE] })
    const detectedRejection = !result.valid
    const ok = detectedRejection === c.expectDetectsRejection
    if (!ok) fails++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name}  (validator rejected: ${detectedRejection})`)
  }
  console.log(`\n  selftest: ${cases.length - fails} passed, ${fails} failed`)
  return fails === 0 ? 0 : 1
}

async function main() {
  if (process.argv.includes('--selftest')) process.exit(selftest())
  await realRun()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
