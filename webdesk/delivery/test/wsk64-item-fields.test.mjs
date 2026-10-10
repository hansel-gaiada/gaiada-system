/**
 * WSK-64 — the composition-typed `fields` block (vocabulary 1.1.0, write-plane design §2.2/§2.4/§2.5),
 * done-when items 3 and 4: validateItemContent table cases, then the composition validator's new
 * rules, then the vocabulary-version acceptance rule. Pure unit coverage, no database.
 *
 *   node --import tsx test/wsk64-item-fields.test.mjs
 */
import { validateItemContent, validateFieldValues, fieldsBlockOf, FIELDS_BLOCK_TYPE } from '../vocabulary/item-fields.ts'
import { validateCollectionComposition, validateTenantComposition } from '../vocabulary/composition.ts'
import { validateBlock } from '../vocabulary/blocks.ts'
import { validateField } from '../vocabulary/primitives.ts'

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
const clone = (v) => JSON.parse(JSON.stringify(v))

// =================================================================================================
// Fixtures: the three §2.4 shapes, written as compositions
// =================================================================================================
const SERVICE = {
  fields: [
    { name: 'url', primitive: 'text', required: true },
    { name: 'source_path', primitive: 'text', required: true, ui: { readOnly: true } },
    { name: 'template', primitive: 'select', required: true, options: ['service', 'home', 'post', 'page'] },
    { name: 'section', primitive: 'text', required: true },
    { name: 'language', primitive: 'text', required: true },
    { name: 'h1', primitive: 'text' },
    { name: 'primary_keyword', primitive: 'text' },
    { name: 'phase', primitive: 'select', required: true, options: ['L', 'M', 'S'] },
    { name: 'schema', primitive: 'text', multiple: true },
    { name: 'hreflang_id', primitive: 'text' },
    { name: 'hreflang_en', primitive: 'text' },
    { name: 'author', primitive: 'text' },
    { name: 'last_updated', primitive: 'text' },
    { name: 'publish_ready', primitive: 'boolean', required: true },
    { name: 'schema_notes', primitive: 'text', ui: { widget: 'code' } },
    { name: 'image_alt_texts', primitive: 'text', multiple: true },
    { name: 'visibility', primitive: 'select', required: true, options: ['shown', 'seo-only', 'held', 'hidden'] },
    {
      name: 'plan',
      primitive: 'group',
      fields: [
        { name: 'action', primitive: 'select', required: true, options: ['SHOW', 'HOLD', 'MERGE', 'REDIRECT', 'RETIRE', 'NEW'] },
        { name: 'to', primitive: 'text' },
        { name: 'why', primitive: 'text' },
      ],
    },
    { name: 'body', primitive: 'markdown', required: true },
  ],
  blocks: [],
  ui: { label: 'Service pages', group: 'Pages', titleField: 'h1' },
  lint: {
    placeholders: [
      { kind: 'token', open: '{{', close: '}}', registry: { collection: 'token-registry', listField: 'tokens', keyField: 'key', valueField: 'value' } },
      { kind: 'marker', open: '[CONFIRM:', close: ']', label: 'confirm' },
      { kind: 'marker', open: '[CLIENT:', close: ']', label: 'client' },
    ],
  },
}

const SERVICE_PROPS = {
  url: '/services/seo/',
  source_path: 'content/en/services/seo.md',
  template: 'service',
  section: 'service',
  language: 'en-GB',
  h1: 'SEO Agency Bali',
  primary_keyword: 'seo agency bali',
  phase: 'L',
  schema: ['Service', 'OfferCatalog', 'FAQPage', 'AggregateRating'],
  hreflang_id: '/id/services/seo/',
  author: '[CONFIRM: author name and role]',
  last_updated: '{{PUBLISH_DATE}}',
  publish_ready: false,
  schema_notes: 'Service:\n  name: "SEO"\n  provider: "Gaia Digital Agency"\n…',
  image_alt_texts: [
    'SEO Agency Bali team reviewing Google Search Console data for a hotel client in Ubud',
    'Five-step SEO process diagram used by Gaia Digital Agency for Bali hospitality clients',
  ],
  visibility: 'shown',
  plan: { action: 'SHOW', to: '', why: '…' },
  body: '# SEO Agency Bali\n\nGaia Digital Agency is an SEO agency in Bali that helps hotels …',
}

const NAVIGATION = {
  singleton: true,
  fields: [
    {
      name: 'primary',
      primitive: 'group',
      multiple: true,
      itemKey: 'key',
      fields: [
        { name: 'key', primitive: 'text', required: true, localized: false },
        { name: 'label', primitive: 'text', required: true },
        { name: 'hub', primitive: 'text' },
        { name: 'url', primitive: 'text', required: true, localized: false },
        { name: 'children', primitive: 'text', multiple: true, localized: false },
      ],
    },
    {
      name: 'cta',
      primitive: 'group',
      fields: [
        { name: 'label', primitive: 'text', required: true },
        { name: 'url', primitive: 'text', required: true, localized: false },
      ],
    },
  ],
  blocks: [],
}

const NAV_PROPS = {
  primary: [
    { key: 'services', label: 'Services', hub: 'All services', url: '/services/', children: ['/services/ai-search-optimization/', '/services/branding/'] },
  ],
  cta: { label: 'Get your free audit', url: '/free-audit/' },
}

const COMPANY = {
  singleton: true,
  localized: false,
  fields: [
    { name: 'name', primitive: 'text', required: true },
    { name: 'legal_name', primitive: 'text' },
    { name: 'domain', primitive: 'text' },
    {
      name: 'address',
      primitive: 'group',
      fields: ['street', 'locality', 'region', 'country', 'full'].map((n) => ({ name: n, primitive: 'text' })),
    },
    { name: 'same_as', primitive: 'text', multiple: true },
    { name: 'languages', primitive: 'text', multiple: true },
  ],
  blocks: [],
}

const FAQ = {
  fields: [
    {
      name: 'faq',
      primitive: 'group',
      multiple: true,
      fields: [
        { name: 'question', primitive: 'text', required: true },
        { name: 'answer', primitive: 'markdown', required: true },
      ],
    },
  ],
  blocks: ['richText', 'cta'],
}

/** A group nested `depth` levels deep, a text leaf at the bottom, and a matching value. */
function nested(depth) {
  let field = { name: 'leaf', primitive: 'text', required: true }
  let value = 'x'
  for (let d = depth; d >= 1; d--) {
    field = { name: `g${d}`, primitive: 'group', fields: [field] }
    value = { [field.fields[0].name]: value }
  }
  return { composition: { fields: [field] }, props: { [field.name]: value } }
}

const fieldsBlock = (props) => ({ type: FIELDS_BLOCK_TYPE, props })
const withProps = (patch) => [fieldsBlock({ ...clone(SERVICE_PROPS), ...patch })]
const without = (key) => {
  const p = clone(SERVICE_PROPS)
  delete p[key]
  return [fieldsBlock(p)]
}

// =================================================================================================
// Done-when 3: validateItemContent, table-driven
// =================================================================================================
// [name, composition, blocks, expectValid, expectPath?, messageIncludes?]
const CASES = [
  // --- position, uniqueness, presence --------------------------------------------------------
  ['§2.4(a) service page is valid', SERVICE, [fieldsBlock(SERVICE_PROPS)], true],
  ['§2.4(b) navigation singleton is valid', NAVIGATION, [fieldsBlock(NAV_PROPS)], true],
  ['§2.4(c) company global is valid', COMPANY, [fieldsBlock({ name: 'Gaia Digital Agency', address: { locality: 'Ubud' }, same_as: [], languages: ['en', 'id'] })], true],
  ['missing fields block (empty blocks) is rejected', SERVICE, [], false, '/blocks/0', 'missing'],
  ['missing fields block (only a generic block) is rejected', FAQ, [{ type: 'richText', props: { content: 'x' } }], false, '/blocks/0', 'missing'],
  ['fields block at index 1 is rejected', FAQ, [{ type: 'richText', props: { content: 'x' } }, fieldsBlock({ faq: [] })], false, '/blocks/1', 'blocks[0]'],
  ['duplicate fields block is rejected', FAQ, [fieldsBlock({ faq: [] }), fieldsBlock({ faq: [] })], false, '/blocks/1', 'duplicate'],
  ['a fields block in a collection without fields is rejected', { blocks: ['hero'] }, [fieldsBlock({})], false, '/blocks/0', 'declares no fields'],
  ['no fields declared, generic blocks only, is valid', { blocks: ['hero'] }, [{ type: 'hero', props: { heading: 'Hi' } }], true],
  ['blocks that is not an array is rejected', SERVICE, { 0: fieldsBlock(SERVICE_PROPS) }, false, '/blocks', 'array'],
  ['a block entry that is not an object is rejected', FAQ, [fieldsBlock({ faq: [] }), 'richText'], false, '/blocks/1', 'block object'],
  ['generic blocks allowed after the fields block are valid', FAQ, [fieldsBlock({ faq: [] }), { type: 'richText', props: { content: 'x' } }, { type: 'cta', props: { heading: 'h', buttonLabel: 'b', buttonHref: '/x' } }], true],
  ['a generic block outside composition.blocks is rejected', FAQ, [fieldsBlock({ faq: [] }), { type: 'hero', props: { heading: 'h' } }], false, '/blocks/1/type', 'not allowed'],
  ['blocks: [] allows no generic block after fields', SERVICE, [fieldsBlock(SERVICE_PROPS), { type: 'richText', props: { content: 'x' } }], false, '/blocks/1/type', 'not allowed'],
  ['an unknown block type is rejected at write time', { fields: [{ name: 'a', primitive: 'text' }] }, [fieldsBlock({}), { type: 'pricingTable', props: {} }], false, '/blocks/1/type', 'not a vocabulary block type'],
  ['blocks absent = every generic block allowed', { fields: [{ name: 'a', primitive: 'text' }] }, [fieldsBlock({}), { type: 'hero', props: { heading: 'h' } }, { type: 'logoCloud', props: { logos: [] } }], true],
  ['a known generic block with bad props is rejected', FAQ, [fieldsBlock({ faq: [] }), { type: 'cta', props: { heading: 'h' } }], false, '/blocks/1/props', 'buttonLabel'],
  ['block props that are not an object are rejected', FAQ, [fieldsBlock({ faq: [] }), { type: 'richText', props: 'x' }], false, '/blocks/1/props', 'object'],
  // --- closed props ------------------------------------------------------------------------
  ['an unknown key in the fields props is rejected', SERVICE, withProps({ extra: 1 }), false, '/blocks/0/props/extra', 'unknown field'],
  ['fields props that are an array are rejected', SERVICE, [fieldsBlock([])], false, '/blocks/0/props', 'object'],
  ['a pointer segment is RFC 6901 escaped', SERVICE, withProps({ 'a/b~c': 1 }), false, '/blocks/0/props/a~1b~0c', 'unknown field'],
  // --- required ----------------------------------------------------------------------------
  ['a missing required field is rejected', SERVICE, without('url'), false, '/blocks/0/props/url', 'url is required'],
  ['a null required field is rejected', SERVICE, withProps({ body: null }), false, '/blocks/0/props/body', 'body is required'],
  ['a missing optional field is fine', SERVICE, without('h1'), true],
  ['a fields block with no props reports every required field', SERVICE, [{ type: FIELDS_BLOCK_TYPE }], false, '/blocks/0/props/url', 'required'],
  // --- typed scalars -----------------------------------------------------------------------
  ['text given a number is rejected', SERVICE, withProps({ h1: 3 }), false, '/blocks/0/props/h1', 'string'],
  ['a select value outside its options is rejected', SERVICE, withProps({ visibility: 'visible' }), false, '/blocks/0/props/visibility', 'not one of'],
  ['all four visibility states are accepted', SERVICE, withProps({ visibility: 'seo-only' }), true],
  // --- boolean -----------------------------------------------------------------------------
  ['boolean true is valid', SERVICE, withProps({ publish_ready: true }), true],
  ['boolean as the string "true" is rejected', SERVICE, withProps({ publish_ready: 'true' }), false, '/blocks/0/props/publish_ready', 'boolean'],
  ['boolean as 0 is rejected', SERVICE, withProps({ publish_ready: 0 }), false, '/blocks/0/props/publish_ready', 'boolean'],
  // --- markdown ----------------------------------------------------------------------------
  ['markdown with CRLF, trailing spaces and HTML is valid', SERVICE, withProps({ body: '# T  \r\n\r\n<div>x</div>\n\n| a | b |\n|---|---|\n' }), true],
  ['an empty markdown string satisfies required (present)', SERVICE, withProps({ body: '' }), true],
  ['markdown given an object is rejected', SERVICE, withProps({ body: { root: {} } }), false, '/blocks/0/props/body', 'markdown'],
  // --- scalar multiple ---------------------------------------------------------------------
  ['text multiple as an array is valid', SERVICE, withProps({ schema: ['Service'] }), true],
  ['text multiple given a scalar is rejected', SERVICE, withProps({ schema: 'Service' }), false, '/blocks/0/props/schema', 'array'],
  ['a bad element of a text multiple is pointed at by index', SERVICE, withProps({ image_alt_texts: ['ok', 7] }), false, '/blocks/0/props/image_alt_texts/1', 'string'],
  ['a required multiple satisfied by []', { fields: [{ name: 'tags', primitive: 'text', multiple: true, required: true }] }, [fieldsBlock({ tags: [] })], true],
  ['boolean multiple is valid', { fields: [{ name: 'flags', primitive: 'boolean', multiple: true }] }, [fieldsBlock({ flags: [true, false] })], true],
  ['number multiple with a string element is rejected', { fields: [{ name: 'n', primitive: 'number', multiple: true }] }, [fieldsBlock({ n: [1, '2'] })], false, '/blocks/0/props/n/1', 'number'],
  // --- group -------------------------------------------------------------------------------
  ['a group with an unknown key is rejected (closed)', SERVICE, withProps({ plan: { action: 'SHOW', extra: 1 } }), false, '/blocks/0/props/plan/extra', 'closed'],
  ['a group missing a required sub-field is rejected', SERVICE, withProps({ plan: { to: '/x/' } }), false, '/blocks/0/props/plan/action', 'action is required'],
  ['a single group given an array is rejected', SERVICE, withProps({ plan: [{ action: 'SHOW' }] }), false, '/blocks/0/props/plan', 'object'],
  ['a group sub-field select is typed', SERVICE, withProps({ plan: { action: 'show' } }), false, '/blocks/0/props/plan/action', 'not one of'],
  ['a list of objects with a non-object element is rejected', NAVIGATION, [fieldsBlock({ ...NAV_PROPS, primary: ['services'] })], false, '/blocks/0/props/primary/0', 'object'],
  ['a nested markdown error has the exact JSON pointer', FAQ, [fieldsBlock({ faq: [{ question: 'a', answer: 'b' }, { question: 'c', answer: 'd' }, { question: 'e', answer: 5 }] })], false, '/blocks/0/props/faq/2/answer', 'markdown'],
  // --- itemKey -----------------------------------------------------------------------------
  [
    'duplicate itemKey values are rejected at the second occurrence',
    NAVIGATION,
    [fieldsBlock({ ...NAV_PROPS, primary: [NAV_PROPS.primary[0], { ...NAV_PROPS.primary[0], label: 'Again' }] })],
    false,
    '/blocks/0/props/primary/1/key',
    'duplicate itemKey',
  ],
  ['distinct itemKey values are valid', NAVIGATION, [fieldsBlock({ ...NAV_PROPS, primary: [NAV_PROPS.primary[0], { key: 'work', label: 'Work', url: '/work/' }] })], true],
  ['a list item missing its itemKey reports required', NAVIGATION, [fieldsBlock({ ...NAV_PROPS, primary: [{ label: 'x', url: '/x/' }] })], false, '/blocks/0/props/primary/0/key', 'key is required'],
  ['localized:false fields validate on shape only (no rule beyond shape)', NAVIGATION, [fieldsBlock({ ...NAV_PROPS, cta: { label: 'Audit gratis', url: '/free-audit/' } })], true],
  // --- depth -------------------------------------------------------------------------------
  ['group nesting at depth 4 is valid', nested(4).composition, [fieldsBlock(nested(4).props)], true],
  ['group nesting at depth 5 is rejected', nested(5).composition, [fieldsBlock(nested(5).props)], false, '/blocks/0/props/g1/g2/g3/g4/g5', 'deeper than 4'],
]

for (const [name, composition, blocks, expectValid, expectPath, msg] of CASES) {
  const r = validateItemContent(composition, blocks)
  let ok = r.valid === expectValid
  if (ok && !expectValid) {
    ok = r.issues.some((i) => i.path === expectPath && (!msg || i.message.includes(msg)))
  }
  check(`item: ${name}`, ok, JSON.stringify(r.issues))
}
check(`at least 40 validateItemContent table cases (have ${CASES.length})`, CASES.length >= 40, String(CASES.length))

// --- markdown is stored verbatim: validation never mutates the input --------------------------
{
  const body = '  # Title  \r\n\r\n- a\n- b\t\n\n```js\nconst x = 1\n```\n'
  const blocks = withProps({ body })
  const before = JSON.stringify(blocks)
  const r = validateItemContent(SERVICE, blocks)
  check('markdown verbatim: valid, and the input is not mutated by validation', r.valid && JSON.stringify(blocks) === before && blocks[0].props.body === body, JSON.stringify(r))
}

// --- fieldsBlockOf -------------------------------------------------------------------------------
check('fieldsBlockOf returns the props of blocks[0]', fieldsBlockOf([fieldsBlock(NAV_PROPS)]) === NAV_PROPS)
check('fieldsBlockOf is null when blocks[0] is a generic block', fieldsBlockOf([{ type: 'richText', props: {} }, fieldsBlock({})]) === null)
check('fieldsBlockOf is null for a non-array', fieldsBlockOf('nope') === null)
check('fieldsBlockOf is null for a fields block without object props', fieldsBlockOf([{ type: 'fields', props: [] }]) === null)

// --- validateFieldValues directly ---------------------------------------------------------------
{
  const issues = validateFieldValues(NAVIGATION.fields, { cta: { label: 'x', url: '/' } }, '/p')
  check('validateFieldValues: valid props give no issues (optional list absent)', issues.length === 0, JSON.stringify(issues))
  const bad = validateFieldValues(NAVIGATION.fields, 'x', '/p')
  check('validateFieldValues: non-object props is one issue at the given path', bad.length === 1 && bad[0].path === '/p', JSON.stringify(bad))
}

// --- the fields block is a KNOWN block with no vocabulary props ----------------------------------
{
  const v = validateBlock({ type: 'fields', props: { anything: 1 } })
  check('validateBlock treats "fields" as known, with no vocabulary props', v.valid && !v.unknownType, JSON.stringify(v))
}

// --- validateField keeps its 1.0.0 message format for top-level scalars --------------------------
check('validateField: required message unchanged', JSON.stringify(validateField({ name: 'h', primitive: 'text', required: true }, undefined)) === '["h is required"]')
check('validateField: scalar message unchanged', JSON.stringify(validateField({ name: 'h', primitive: 'text' }, 1)) === '["h: expected a string"]')
check(
  'validateField: media multiple message unchanged',
  JSON.stringify(validateField({ name: 'items', primitive: 'media', multiple: true }, {})) === '["items: expected an array of media objects"]',
)

// =================================================================================================
// Done-when 4: the composition validator's 1.1.0 rules
// =================================================================================================
// [name, composition, expectValid, expectPath?, messageIncludes?]
const COMP_CASES = [
  ['§2.4 service composition is valid', SERVICE, true],
  ['§2.4 navigation composition is valid', NAVIGATION, true],
  ['§2.4 company composition is valid', COMPANY, true],
  ['FAQ composition is valid', FAQ, true],
  ['fields on a non-group is rejected', { fields: [{ name: 'a', primitive: 'text', fields: [{ name: 'b', primitive: 'text' }] }] }, false, 'c.fields[0].fields', 'only allowed on a "group"'],
  ['a group without fields is rejected', { fields: [{ name: 'g', primitive: 'group' }] }, false, 'c.fields[0].fields', 'non-empty'],
  ['a group with empty fields is rejected', { fields: [{ name: 'g', primitive: 'group', fields: [] }] }, false, 'c.fields[0].fields', 'non-empty'],
  [
    'itemKey naming a non-text field is rejected',
    { fields: [{ name: 'g', primitive: 'group', multiple: true, itemKey: 'n', fields: [{ name: 'n', primitive: 'number', required: true }] }] },
    false,
    'c.fields[0].itemKey',
    'REQUIRED, single-valued "text"',
  ],
  [
    'itemKey naming an optional text field is rejected',
    { fields: [{ name: 'g', primitive: 'group', multiple: true, itemKey: 'k', fields: [{ name: 'k', primitive: 'text' }] }] },
    false,
    'c.fields[0].itemKey',
    'REQUIRED',
  ],
  [
    'itemKey naming a multiple text field is rejected',
    { fields: [{ name: 'g', primitive: 'group', multiple: true, itemKey: 'k', fields: [{ name: 'k', primitive: 'text', required: true, multiple: true }] }] },
    false,
    'c.fields[0].itemKey',
    'single-valued',
  ],
  [
    'itemKey naming a missing sub-field is rejected',
    { fields: [{ name: 'g', primitive: 'group', multiple: true, itemKey: 'nope', fields: [{ name: 'k', primitive: 'text', required: true }] }] },
    false,
    'c.fields[0].itemKey',
    'does not name',
  ],
  [
    'itemKey on a single (non-multiple) group is rejected',
    { fields: [{ name: 'g', primitive: 'group', itemKey: 'k', fields: [{ name: 'k', primitive: 'text', required: true }] }] },
    false,
    'c.fields[0].itemKey',
    'multiple: true',
  ],
  ['itemKey on a non-group is rejected', { fields: [{ name: 't', primitive: 'text', multiple: true, itemKey: 't' }] }, false, 'c.fields[0].itemKey', 'only allowed'],
  ['an unknown FieldDef key is rejected', { fields: [{ name: 'a', primitive: 'text', format: 'markdown' }] }, false, 'c.fields[0].format', 'unknown field key'],
  [
    'an unknown key on a nested sub-field is rejected at its path',
    { fields: [{ name: 'g', primitive: 'group', fields: [{ name: 's', primitive: 'text', regex: '.*' }] }] },
    false,
    'c.fields[0].fields[0].regex',
    'unknown field key',
  ],
  [
    'duplicate sub-field names inside a group are rejected',
    { fields: [{ name: 'g', primitive: 'group', fields: [{ name: 's', primitive: 'text' }, { name: 's', primitive: 'text' }] }] },
    false,
    'c.fields[0].fields[1].name',
    'duplicate',
  ],
  ['"fields" listed in composition.blocks is rejected', { fields: [{ name: 'a', primitive: 'text' }], blocks: ['fields'] }, false, 'c.blocks[0]', 'never be listed'],
  ['group nesting at depth 4 is accepted', nested(4).composition, true],
  ['group nesting at depth 5 is rejected', nested(5).composition, false, 'c.fields[0].fields[0].fields[0].fields[0].fields[0].fields', 'deeper than 4'],
  ['a field name with a hyphen is rejected (grammar)', { fields: [{ name: 'image-alt', primitive: 'text' }] }, false, 'c.fields[0].name', 'grammar'],
  ['a field name starting with a digit is rejected', { fields: [{ name: '1st', primitive: 'text' }] }, false, 'c.fields[0].name', 'grammar'],
  ['snake_case source keys are accepted verbatim', { fields: [{ name: 'image_alt_texts', primitive: 'text', multiple: true }] }, true],
  ['localized must be a boolean', { fields: [{ name: 'a', primitive: 'text', localized: 'no' }] }, false, 'c.fields[0].localized', 'boolean'],
  ['an unknown ui widget is rejected', { fields: [{ name: 'a', primitive: 'text', ui: { widget: 'wysiwyg' } }] }, false, 'c.fields[0].ui.widget', 'widget'],
  ['an unknown field ui key is rejected', { fields: [{ name: 'a', primitive: 'text', ui: { placeholder: 'x' } }] }, false, 'c.fields[0].ui.placeholder', 'unknown field ui key'],
  ['singleton must be a boolean', { fields: [], singleton: 'yes' }, false, 'c.singleton', 'boolean'],
  ['collection localized must be a boolean', { fields: [], localized: 1 }, false, 'c.localized', 'boolean'],
  ['collection ui requires a label', { fields: [], ui: { group: 'Pages' } }, false, 'c.ui.label', 'required'],
  ['collection ui titleField must name a declared field', { fields: [{ name: 'h1', primitive: 'text' }], ui: { label: 'x', titleField: 'title' } }, false, 'c.ui.titleField', 'top-level field'],
  ['collection ui order must be a finite number', { fields: [], ui: { label: 'x', order: '1' } }, false, 'c.ui.order', 'finite'],
  ['a marker rule without a label is rejected', { fields: [], lint: { placeholders: [{ kind: 'marker', open: '[X:', close: ']' }] } }, false, 'c.lint.placeholders[0].label', 'label'],
  ['an empty delimiter is rejected', { fields: [], lint: { placeholders: [{ kind: 'token', open: '', close: '}}' }] } }, false, 'c.lint.placeholders[0].open', 'literal'],
  ['an unknown placeholder kind (e.g. regex) is rejected', { fields: [], lint: { placeholders: [{ kind: 'regex', open: '(', close: ')' }] } }, false, 'c.lint.placeholders[0].kind', 'token'],
  [
    'a token registry missing valueField is rejected',
    { fields: [], lint: { placeholders: [{ kind: 'token', open: '{{', close: '}}', registry: { collection: 'r', listField: 'l', keyField: 'k' } }] } },
    false,
    'c.lint.placeholders[0].registry.valueField',
    'non-empty',
  ],
  ['an unknown lint key is rejected', { fields: [], lint: { spelling: true } }, false, 'c.lint.spelling', 'unknown lint key'],
  ['an unknown composition key is still rejected', { fields: [], draft: true }, false, 'c.draft', 'unknown composition key'],
]
for (const [name, composition, expectValid, expectPath, msg] of COMP_CASES) {
  const r = validateCollectionComposition('c', composition)
  let ok = r.valid === expectValid
  if (ok && !expectValid) ok = r.issues.some((i) => i.path === expectPath && (!msg || i.message.includes(msg)))
  check(`composition: ${name}`, ok, JSON.stringify(r.issues))
}

// =================================================================================================
// Vocabulary-version acceptance (§2.3): a MINOR is a superset
// =================================================================================================
for (const [v, ok] of [
  ['1.0.0', true],
  ['1.1.0', true],
  ['1.1.1', false],
  ['1.2.0', false],
  ['2.0.0', false],
  ['0.9.0', false],
  ['latest', false],
]) {
  const r = validateTenantComposition({ page: SERVICE }, { vocabularyVersion: v })
  check(`validateTenantComposition with vocabularyVersion "${v}" is ${ok ? 'accepted' : 'refused'}`, r.valid === ok, JSON.stringify(r.issues))
}
{
  const r = validateTenantComposition({ legacy: { fields: [{ name: 'g', primitive: 'group', fields: [{ name: 'a', primitive: 'text' }] }] } }, { vocabularyVersion: '1.0.0' })
  check('a composition pinned to 1.0.0 is validated against the 1.1.0 rules (group accepted)', r.valid, JSON.stringify(r.issues))
}

console.log(`\n  WSK-64 item-fields + composition suite: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
