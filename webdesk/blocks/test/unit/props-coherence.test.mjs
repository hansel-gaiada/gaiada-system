// webdesk/blocks/test/unit/props-coherence.test.mjs
//
// WSK-16 — mechanical proof that "Props typed from the vocabulary package, not hand-written" is
// actually true, not just asserted in a comment. Two independent checks:
//
//   1. STRUCTURAL: src/types.ts's EXPECTED_FIELDS table (a plain-data mirror of each block's
//      Props interface) is diffed field-by-field against the vendored vocabulary's own
//      `BLOCKS[type].fields` — name, required-ness, multiplicity. Any drift between a hand-typed
//      Props interface and the real vocabulary fails this test.
//   2. RUNTIME ROUND-TRIP: for every block type, a minimal valid props object is generated PURELY
//      from the vocabulary's own primitive definitions (never from src/types.ts), then passed
//      through the vocabulary's own `validateBlock()` — proving the values these Props types
//      describe are genuinely accepted by the vocabulary's runtime validator, not just
//      similarly-named by inspection.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BLOCKS, BLOCK_TYPE_NAMES, validateBlock } from '../../src/vocabulary/blocks.ts'
import { EXPECTED_FIELDS } from '../../src/types.ts'

test('EXPECTED_FIELDS covers every vocabulary block type, no more, no less', () => {
  assert.deepEqual([...Object.keys(EXPECTED_FIELDS)].sort(), [...BLOCK_TYPE_NAMES].sort())
})

for (const type of BLOCK_TYPE_NAMES) {
  test(`Props type for "${type}" matches BLOCKS.${type}.fields exactly (name, required, multiple)`, () => {
    const real = BLOCKS[type].fields.map((f) => ({ name: f.name, required: !!f.required, multiple: !!f.multiple }))
    const declared = EXPECTED_FIELDS[type]
    assert.deepEqual(declared, real, `src/types.ts's EXPECTED_FIELDS.${type} has drifted from the vendored vocabulary's BLOCKS.${type}.fields`)
  })
}

/** Produces one valid value for a primitive, using ONLY the vocabulary's own primitive semantics
 *  (primitives.ts's documented jsonShape) — never src/types.ts — so the round-trip below proves
 *  something independent of the hand-written Props interfaces. */
function sampleValueFor(primitive, field) {
  switch (primitive) {
    case 'text':
      return 'sample text'
    case 'richtext':
      return 'sample rich text'
    case 'media':
      return { url: 'https://cdn.example.com/sample.jpg', alt: 'sample' }
    case 'relation':
      return { collection: field.relationTo ?? 'x', slug: 'sample-slug' }
    case 'number':
      return 1
    case 'date':
      return '2026-08-27T00:00:00.000Z'
    case 'select':
      return field.options && field.options.length > 0 ? field.options[0] : 'a'
    case 'geo':
      return { lat: 0, lng: 0 }
    default:
      throw new Error(`sampleValueFor: no sample generator for primitive "${primitive}"`)
  }
}

function minimalValidProps(type) {
  const props = {}
  for (const field of BLOCKS[type].fields) {
    if (!field.required) continue
    const one = sampleValueFor(field.primitive, field)
    props[field.name] = field.multiple ? [one] : one
  }
  return props
}

// RESOLVED 2026-08-27 (was: KNOWN VOCABULARY GAP, found by this very test).
// primitives.ts's `media` validator ignored `field.multiple` while `relation` honoured it, so
// `gallery.items` and `logoCloud.logos` -- both declared `{ primitive: 'media', multiple: true }`
// -- could never pass validateBlock(). Two of the nine frozen block types were unvalidatable.
// Fixed upstream by mirroring the `relation` branch, then re-vendored here. The set below is now
// EMPTY on purpose rather than deleted: it is the seam where the next such gap gets recorded, and
// the loop beneath it is what turned an invisible bug into a failing test.
const KNOWN_MULTIPLE_MEDIA_VALIDATION_GAP = new Set([])

for (const type of BLOCK_TYPE_NAMES) {
  if (KNOWN_MULTIPLE_MEDIA_VALIDATION_GAP.has(type)) continue
  test(`a minimal props object built from BLOCKS.${type}.fields' own primitives validates via the vocabulary's validateBlock()`, () => {
    const props = minimalValidProps(type)
    const result = validateBlock({ type, props })
    assert.equal(result.unknownType, false)
    assert.equal(result.valid, true, `expected valid, got errors: ${JSON.stringify(result.errors)} for props ${JSON.stringify(props)}`)
  })
}

for (const type of KNOWN_MULTIPLE_MEDIA_VALIDATION_GAP) {
  test(`REGRESSION GUARD (not a pass/fail bug in this package) — "${type}"'s declared array-of-media field still fails the vocabulary's own validateBlock(), documenting the gap above`, () => {
    const props = minimalValidProps(type)
    const result = validateBlock({ type, props })
    assert.equal(result.unknownType, false)
    assert.equal(
      result.valid,
      false,
      `if this now passes, webdesk/payload/vocabulary's "media"+multiple validation gap has been fixed upstream — ` +
        `flip this assertion to true and delete it from KNOWN_MULTIPLE_MEDIA_VALIDATION_GAP above`,
    )
  })
}

test('known block types with malformed props are still real validation failures (the invariant only protects UNKNOWN types)', () => {
  const result = validateBlock({ type: 'hero', props: {} }) // missing required "heading"
  assert.equal(result.valid, false)
  assert.equal(result.unknownType, false)
  assert.ok(result.errors.length > 0)
})
