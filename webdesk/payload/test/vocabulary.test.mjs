/**
 * WSK-06 — pure unit coverage for the vocabulary package: no database, no network. Run with
 * `node --import tsx test/vocabulary.test.mjs` (same invocation shape as this project's other
 * TS-importing test files, e.g. npm run test:boot).
 */
import { PRIMITIVE_NAMES, PRIMITIVES, validateField } from '../vocabulary/primitives.ts'
import { BLOCK_TYPE_NAMES, BLOCKS, validateBlock } from '../vocabulary/blocks.ts'
import { VOCABULARY_SUMMARY, VOCABULARY_VERSION, ENVELOPE_PATH_PREFIX } from '../vocabulary/version.ts'
import { buildCacheTags, cacheTagHeaderValue } from '../vocabulary/cache-tags.ts'
import { problemDetails } from '../vocabulary/problem-details.ts'
import { resolveRequestedLocale, localeFallbackFlag } from '../vocabulary/locale.ts'
import { buildItemEnvelope, buildListEnvelope } from '../vocabulary/envelope.ts'

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

// --- the freeze's headline numbers -----------------------------------------------------------
check('exactly 8 field primitives', PRIMITIVE_NAMES.length === 8, `got ${PRIMITIVE_NAMES.length}`)
check(
  '8 primitives are exactly: text, richtext, media, relation, number, date, select, geo',
  JSON.stringify([...PRIMITIVE_NAMES].sort()) ===
    JSON.stringify(['date', 'geo', 'media', 'number', 'relation', 'richtext', 'select', 'text'].sort()),
  PRIMITIVE_NAMES.join(','),
)
check('exactly 9 block types', BLOCK_TYPE_NAMES.length === 9, `got ${BLOCK_TYPE_NAMES.length}`)
check(
  '9 block types are exactly: hero, richText, gallery, cta, featureGrid, form, testimonial, faq, logoCloud',
  JSON.stringify([...BLOCK_TYPE_NAMES].sort()) ===
    JSON.stringify(
      ['hero', 'richText', 'gallery', 'cta', 'featureGrid', 'form', 'testimonial', 'faq', 'logoCloud'].sort(),
    ),
  BLOCK_TYPE_NAMES.join(','),
)
check('vocabulary version is set', VOCABULARY_VERSION === '1.0.0', VOCABULARY_VERSION)
check('envelope path prefix is the frozen /v1', ENVELOPE_PATH_PREFIX === '/v1', ENVELOPE_PATH_PREFIX)
check(
  'VOCABULARY_SUMMARY carries both counts (what payload.config.ts exposes via config.custom)',
  VOCABULARY_SUMMARY.primitiveCount === 8 && VOCABULARY_SUMMARY.blockTypeCount === 9,
  JSON.stringify(VOCABULARY_SUMMARY),
)

// --- every block's props schema is built from a real primitive -----------------------------
for (const type of BLOCK_TYPE_NAMES) {
  const def = BLOCKS[type]
  const allFieldsKnown = def.fields.every((f) => PRIMITIVE_NAMES.includes(f.primitive))
  check(`block "${type}" fields all reference a known primitive`, allFieldsKnown, JSON.stringify(def.fields))
}

// --- primitive-level validation ------------------------------------------------------------
check('text primitive accepts a string', PRIMITIVES.text.validate('hello').length === 0)
check('text primitive rejects a number', PRIMITIVES.text.validate(42).length === 1)
check('media primitive requires a url', PRIMITIVES.media.validate({ alt: 'no url' }).length === 1)
check('media primitive accepts a minimal shape', PRIMITIVES.media.validate({ url: '/x.png' }).length === 0)
check(
  'select primitive rejects a value outside options',
  PRIMITIVES.select.validate('purple', { name: 'color', primitive: 'select', options: ['red', 'blue'] }).length === 1,
)
check('geo primitive rejects out-of-range lat', PRIMITIVES.geo.validate({ lat: 999, lng: 0 }).length === 1)
check(
  'required field with no value is an error',
  validateField({ name: 'heading', primitive: 'text', required: true }, undefined).length === 1,
)
check(
  'optional field with no value is fine',
  validateField({ name: 'subheading', primitive: 'text' }, undefined).length === 0,
)

// --- block validation, incl. the renderer invariant --------------------------------------
{
  const valid = validateBlock({ type: 'hero', props: { heading: 'Welcome' } })
  check('a valid hero block validates clean', valid.valid && !valid.unknownType, JSON.stringify(valid))
}
{
  const missingRequired = validateBlock({ type: 'hero', props: {} })
  check(
    'hero without required "heading" fails validation',
    !missingRequired.valid && missingRequired.errors.some((e) => e.includes('heading')),
    JSON.stringify(missingRequired),
  )
}
{
  // Design §05 hard rule 2: an UNKNOWN block type is never a validation failure at this layer —
  // it is the renderer's "render nothing + report" signal, not a write-time or read-time error.
  const unknown = validateBlock({ type: 'totallyNewBlockType', props: { anything: true } })
  check(
    'unknown block type is valid:true, unknownType:true (never a hard failure)',
    unknown.valid === true && unknown.unknownType === true,
    JSON.stringify(unknown),
  )
}

// --- cache tags -----------------------------------------------------------------------------
{
  const tags = buildCacheTags({ tenantSlug: 'acme', collectionKey: 'case-study', itemId: 'abc123' })
  check(
    'cache tags follow t:/c:/i: exactly (design §05)',
    JSON.stringify(tags) === JSON.stringify(['t:acme', 'c:acme:case-study', 'i:acme:abc123']),
    JSON.stringify(tags),
  )
  check('cache-tag header value is comma-joined, no spaces', cacheTagHeaderValue(tags) === 't:acme,c:acme:case-study,i:acme:abc123')
}
{
  const listTags = buildCacheTags({ tenantSlug: 'acme', collectionKey: 'case-study' })
  check('a list response has no item tag', !listTags.some((t) => t.startsWith('i:')), JSON.stringify(listTags))
}

// --- RFC 9457 problem details ---------------------------------------------------------------
{
  const p = problemDetails({
    slug: 'tenant-key-scope',
    title: 'Key not authorised for this environment',
    status: 403,
    detail: 'x',
    instance: '/v1/t/acme/case-study/foo',
    requestId: 'req-1',
  })
  check('problem type is under the errors namespace', p.type === 'https://webdesk.gaiada.online/errors/tenant-key-scope', p.type)
  check('problem carries status/title/detail/instance/requestId', p.status === 403 && p.title && p.detail && p.instance && p.requestId)
}

// --- locale resolution + fallback flag -------------------------------------------------------
check('no ?locale= resolves to the tenant default', resolveRequestedLocale(null, 'id-ID') === 'id-ID')
check('an explicit ?locale= wins', resolveRequestedLocale('en-US', 'id-ID') === 'en-US')
check('no fallback flag when requested === served', localeFallbackFlag('en-US', 'en-US', 'id-ID') === null)
{
  const fb = localeFallbackFlag('en-US', 'id-ID', 'id-ID')
  check(
    'fallback flag names requested/served/defaultLocale when they differ',
    fb && fb.requested === 'en-US' && fb.served === 'id-ID' && fb.defaultLocale === 'id-ID',
    JSON.stringify(fb),
  )
}

// --- envelope builders shape ------------------------------------------------------------------
{
  const item = buildItemEnvelope({
    collectionKey: 'case-study',
    slug: 'acme-rebrand',
    locale: 'id-ID',
    localizations: [{ locale: 'en-US', slug: 'acme-rebrand-en' }],
    seo: { title: 't' },
    publishedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    draft: false,
    blocks: [{ type: 'hero', props: { heading: 'hi' } }],
  })
  check(
    'item envelope has exactly the frozen top-level keys',
    JSON.stringify(Object.keys(item).sort()) ===
      JSON.stringify(['blocks', 'collection', 'locale', 'localizations', 'meta', 'seo', 'slug'].sort()),
    Object.keys(item).join(','),
  )
  check(
    'item envelope meta has exactly the frozen keys',
    JSON.stringify(Object.keys(item.meta).sort()) === JSON.stringify(['draft', 'publishedAt', 'updatedAt', 'x'].sort()),
    Object.keys(item.meta).join(','),
  )
}
{
  const list = buildListEnvelope({ collectionKey: 'case-study', locale: 'id-ID', items: [], cursor: null, hasMore: false, limit: 25 })
  check(
    'list envelope has exactly the frozen top-level keys',
    JSON.stringify(Object.keys(list).sort()) === JSON.stringify(['collection', 'items', 'locale', 'page'].sort()),
    Object.keys(list).join(','),
  )
  check(
    'list envelope page has exactly cursor/hasMore/limit',
    JSON.stringify(Object.keys(list.page).sort()) === JSON.stringify(['cursor', 'hasMore', 'limit'].sort()),
    Object.keys(list.page).join(','),
  )
}

console.log(`\n  WSK-06 vocabulary unit suite: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
