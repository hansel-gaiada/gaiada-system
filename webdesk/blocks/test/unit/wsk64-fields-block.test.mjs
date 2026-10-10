// webdesk/blocks/test/unit/wsk64-fields-block.test.mjs
//
// WSK-64 (vocabulary 1.1.0) — the composition-typed `fields` block at blocks[0] is KNOWN to this
// renderer and NON-VISUAL: it resolves known:true (so it is never reported as an unknown block) and
// BlockRenderer.astro draws nothing for it. Run with `node --test test/unit`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveBlocks, partitionResolvedBlocks, isNonVisualBlockType, NON_VISUAL_BLOCK_TYPES } from '../../src/renderer/resolve-blocks.ts'
import { BLOCK_TYPE_NAMES, COMPOSABLE_BLOCK_TYPE_NAMES, FIELDS_BLOCK_TYPE, validateBlock } from '../../src/vocabulary/blocks.ts'
import { VOCABULARY_VERSION } from '../../src/vocabulary/version.ts'

test('the vendored vocabulary is 1.1.0 and knows the fields block', () => {
  assert.equal(VOCABULARY_VERSION, '1.1.0')
  assert.ok(BLOCK_TYPE_NAMES.includes(FIELDS_BLOCK_TYPE))
  assert.ok(!COMPOSABLE_BLOCK_TYPE_NAMES.includes(FIELDS_BLOCK_TYPE))
  assert.equal(COMPOSABLE_BLOCK_TYPE_NAMES.length, 9)
})

test('the fields block is the only non-visual type', () => {
  assert.deepEqual([...NON_VISUAL_BLOCK_TYPES], ['fields'])
  assert.equal(isNonVisualBlockType('fields'), true)
  for (const t of COMPOSABLE_BLOCK_TYPE_NAMES) assert.equal(isNonVisualBlockType(t), false, t)
})

test('a page with blocks[0] = fields resolves every block known; nothing is reported unknown', () => {
  const resolved = resolveBlocks([
    { type: 'fields', props: { h1: 'SEO Agency Bali', body: '# SEO', publish_ready: false } },
    { type: 'richText', props: { content: 'x' } },
  ])
  const { known, unknown } = partitionResolvedBlocks(resolved)
  assert.equal(unknown.length, 0)
  assert.equal(known.length, 2)
  assert.equal(known[0].type, 'fields')
  assert.deepEqual(known[0].props, { h1: 'SEO Agency Bali', body: '# SEO', publish_ready: false })
})

test('validateBlock treats fields as known with no vocabulary props (props are typed per collection)', () => {
  const v = validateBlock({ type: 'fields', props: { anything: 1 } })
  assert.equal(v.unknownType, false)
  assert.equal(v.valid, true)
})
