/**
 * WSK-14 — the composition validator: pure unit coverage, no database. Run with
 * `node --import tsx test/wsk14-composition-validator.test.mjs` (same invocation shape as
 * test/vocabulary.test.mjs).
 */
import {
  validateCollectionComposition,
  validateTenantComposition,
  formatCompositionIssue,
} from '../vocabulary/composition.ts'
import { VOCABULARY_VERSION } from '../vocabulary/version.ts'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name} -- ${detail ?? ''}`)
  }
}

// =================================================================================================
// Valid compositions accept
// =================================================================================================
{
  const r = validateCollectionComposition('case-study', {
    blocks: ['hero', 'richText', 'cta'],
  })
  check('a blocks-only composition of known block types validates clean', r.valid && r.issues.length === 0, JSON.stringify(r))
}
{
  const r = validateCollectionComposition('redirect', {
    fields: [
      { name: 'toPath', primitive: 'text', required: true },
      { name: 'status', primitive: 'select', options: ['301', '302', '307', '308'] },
      { name: 'active', primitive: 'select', options: ['true', 'false'] },
    ],
  })
  check(
    'the REAL shipped redirect composition (redirects.ts ensureRedirectCollection) validates clean',
    r.valid && r.issues.length === 0,
    JSON.stringify(r),
  )
}
{
  const r = validateCollectionComposition('empty', {})
  check('a composition with neither fields nor blocks is valid (no restriction declared)', r.valid, JSON.stringify(r))
}
{
  const r = validateCollectionComposition('gallery', {
    fields: [{ name: 'items', primitive: 'media', multiple: true, required: true }],
    blocks: ['gallery'],
  })
  check('a composition combining fields AND blocks validates clean', r.valid, JSON.stringify(r))
}

// =================================================================================================
// Rejections — out-of-vocabulary constructs, with ACTIONABLE errors (path + message + expected)
// =================================================================================================
{
  const r = validateCollectionComposition('pricing', {
    blocks: ['pricingTable'],
  })
  check('an unknown block type in a composition is REJECTED (not the runtime unknownType:true escape hatch)', r.valid === false, JSON.stringify(r))
  check('exactly one issue, naming the offending path', r.issues.length === 1 && r.issues[0].path === 'pricing.blocks[0]', JSON.stringify(r.issues))
  check(
    'the message names what was found and the expected set (never just "invalid")',
    r.issues[0].message.includes('pricingTable') && r.issues[0].expected === 'hero | richText | gallery | cta | featureGrid | form | testimonial | faq | logoCloud',
    JSON.stringify(r.issues[0]),
  )
  console.log(`  >>> actual rejection message: ${formatCompositionIssue(r.issues[0])}`)
}
{
  const r = validateCollectionComposition('survey', {
    fields: [{ name: 'satisfied', primitive: 'boolean', required: true }],
  })
  check('an unknown primitive is rejected', !r.valid, JSON.stringify(r))
  check(
    'the error names the field path and the primitive that does not exist',
    r.issues.some((i) => i.path === 'survey.fields[0].primitive' && i.message.includes('boolean')),
    JSON.stringify(r.issues),
  )
}
{
  const r = validateCollectionComposition('typo', { feilds: [] })
  check('a misspelled top-level composition key is rejected as out-of-vocabulary, not silently ignored', !r.valid, JSON.stringify(r))
  check('names the exact bad key', r.issues.some((i) => i.path === 'typo.feilds' && i.message.includes('feilds')), JSON.stringify(r.issues))
}
{
  const r = validateCollectionComposition('color-picker', {
    fields: [{ name: 'shade', primitive: 'select' }], // no options
  })
  check('a select field with no options is rejected (structurally unsound, not just "invalid")', !r.valid, JSON.stringify(r))
  check('names the missing options path', r.issues.some((i) => i.path === 'color-picker.fields[0].options'), JSON.stringify(r.issues))
}
{
  const r = validateCollectionComposition('linked', {
    fields: [{ name: 'author', primitive: 'relation' }], // no relationTo
  })
  check('a relation field with no relationTo is rejected', !r.valid, JSON.stringify(r))
  check('names the missing relationTo path', r.issues.some((i) => i.path === 'linked.fields[0].relationTo'), JSON.stringify(r.issues))
}
{
  const r = validateCollectionComposition('dupes', {
    fields: [
      { name: 'title', primitive: 'text' },
      { name: 'title', primitive: 'text' },
    ],
  })
  check('a duplicate field name within one collection is rejected', !r.valid, JSON.stringify(r))
}
{
  const r = validateCollectionComposition('dupblocks', { blocks: ['hero', 'hero'] })
  check('a duplicate block-type entry is rejected', !r.valid, JSON.stringify(r))
}
{
  const r = validateCollectionComposition('bad-shape', 'not-an-object')
  check('a non-object composition value is rejected', !r.valid, JSON.stringify(r))
}
{
  const r = validateCollectionComposition('bad-blocks-type', { blocks: 'hero' })
  check('blocks must be an array, not a bare string', !r.valid, JSON.stringify(r))
}

// =================================================================================================
// Whole-tenant validation (Record<collectionKey, composition>)
// =================================================================================================
{
  const r = validateTenantComposition({
    'case-study': { blocks: ['hero', 'richText'] },
    post: { blocks: ['richText'] },
  })
  check('a valid two-collection tenant composition validates clean', r.valid, JSON.stringify(r))
}
{
  const r = validateTenantComposition({
    'case-study': { blocks: ['hero'] },
    broken: { blocks: ['notARealBlockType'] },
  })
  check('one bad collection among several fails the whole tenant validation', !r.valid, JSON.stringify(r))
  check('the issue path is scoped to the offending collection, not the whole tenant', r.issues.some((i) => i.path.startsWith('broken.')), JSON.stringify(r.issues))
  check('the OTHER (valid) collection contributes no issues', !r.issues.some((i) => i.path.startsWith('case-study.')), JSON.stringify(r.issues))
}
{
  const r = validateTenantComposition('not-an-object')
  check('a non-object tenant composition is rejected', !r.valid, JSON.stringify(r))
}

// =================================================================================================
// Vocabulary-version targeting
// =================================================================================================
{
  const r = validateTenantComposition({ x: { blocks: ['hero'] } }, { vocabularyVersion: VOCABULARY_VERSION })
  check('validating explicitly against the current vocabulary version works', r.valid, JSON.stringify(r))
}
{
  const r = validateTenantComposition({ x: { blocks: ['hero'] } }, { vocabularyVersion: '2.0.0' })
  check('validating against a vocabulary version with no registered snapshot fails loudly, not silently against current', !r.valid, JSON.stringify(r))
  check(
    'the error explains no snapshot exists and names the version that DOES',
    r.issues[0].message.includes('2.0.0') && r.issues[0].expected === VOCABULARY_VERSION,
    JSON.stringify(r.issues),
  )
}

console.log(`\n  WSK-14 composition validator suite: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
