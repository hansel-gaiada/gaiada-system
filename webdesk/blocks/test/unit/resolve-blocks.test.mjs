// webdesk/blocks/test/unit/resolve-blocks.test.mjs
//
// WSK-16 — the renderer invariant, proven at the resolution layer (BEFORE any Astro rendering):
// an unknown block type must resolve to `known: false` and never throw, and a mixed array must
// resolve every entry independently (one unknown block never poisons its neighbors). Run with
// `node --test test/unit` (Node's built-in test runner + native TS type-stripping — see README).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveBlocks, partitionResolvedBlocks } from '../../src/renderer/resolve-blocks.ts'
import { BLOCK_TYPE_NAMES } from '../../src/vocabulary/blocks.ts'
import { fullEnvelopeFixture } from '../fixtures/full-envelope.mjs'
import { unknownBlockEnvelopeFixture } from '../fixtures/unknown-block-envelope.mjs'

test('every one of the 9 known block types in the full-envelope fixture resolves known:true', () => {
  const resolved = resolveBlocks(fullEnvelopeFixture.blocks)
  assert.equal(resolved.length, 9, 'fixture should carry exactly the 9 vocabulary block types')
  for (const b of resolved) {
    assert.equal(b.known, true, `block[${b.index}] type "${b.type}" should be known`)
  }
  const types = resolved.map((b) => b.type)
  assert.deepEqual([...types].sort(), [...BLOCK_TYPE_NAMES].sort(), 'fixture should cover every vocabulary block type exactly once')
})

test('an unknown block type resolves known:false without throwing', () => {
  assert.doesNotThrow(() => resolveBlocks(unknownBlockEnvelopeFixture.blocks))
  const resolved = resolveBlocks(unknownBlockEnvelopeFixture.blocks)
  const { unknown } = partitionResolvedBlocks(resolved)
  assert.equal(unknown.length, 1, 'exactly one block in the fixture is unknown')
  assert.equal(unknown[0].type, 'pricingTable')
  assert.equal(unknown[0].index, 1, 'the unknown block sits between two known ones at index 1')
})

test('the two known blocks either side of an unknown one are unaffected — the page still renders its other blocks', () => {
  const resolved = resolveBlocks(unknownBlockEnvelopeFixture.blocks)
  assert.equal(resolved[0].known, true)
  assert.equal(resolved[0].type, 'hero')
  assert.equal(resolved[1].known, false)
  assert.equal(resolved[2].known, true)
  assert.equal(resolved[2].type, 'richText')
})

test('a completely malformed block array (missing props, weird type values) never throws', () => {
  assert.doesNotThrow(() => {
    const resolved = resolveBlocks([
      { type: 'hero' }, // no props at all
      { type: '' },
      { type: 123 },
      { type: 'hero', props: null },
    ])
    assert.equal(resolved.length, 4)
    assert.equal(resolved[0].known, true)
    assert.deepEqual(resolved[0].props, {})
    assert.equal(resolved[1].known, false)
    assert.equal(resolved[2].known, false, 'a non-string type is treated as unknown, not thrown on')
    assert.equal(resolved[3].known, true)
    assert.deepEqual(resolved[3].props, {})
  })
})

test('block order is preserved exactly as given', () => {
  const resolved = resolveBlocks(fullEnvelopeFixture.blocks)
  assert.deepEqual(
    resolved.map((b) => b.type),
    fullEnvelopeFixture.blocks.map((b) => b.type),
  )
})
