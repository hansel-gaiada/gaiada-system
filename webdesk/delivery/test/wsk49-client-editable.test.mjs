/**
 * WSK-49a — vocabulary 1.2.0 (MINOR): `ui.clientEditable`, and the ONE rule that resolves it
 * (ruling WSK-D59). Pure unit coverage, no database.
 *
 *   node --import tsx test/wsk49-client-editable.test.mjs
 *
 * Covers: the editability function (inheritance, group nesting, `seo` never, generic blocks), the
 * content diff and the two violation helpers the write plane uses, the composition validator's new
 * key, and the classifier: 1.1.0 -> current is COMPUTED as MINOR from the committed 1.1.0 snapshot,
 * and a `clientEditable` flip inside a tenant contract is a `ui` edit (PATCH).
 */
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import {
  isClientEditable,
  collectionAcceptsClientCreate,
  changedContentPointers,
  clientEditViolations,
  clientCreateViolations,
} from '../vocabulary/client-editable.ts'
import { validateCollectionComposition, isVocabularyVersionSupported } from '../vocabulary/composition.ts'
import {
  bumpVersion,
  classifyVocabularyChange,
  classifyTenantContractChange,
  currentEnvelopeShapeSignature,
  currentVocabularySnapshot,
} from '../vocabulary/breaking-change.ts'
import { FIELD_UI_KEYS } from '../vocabulary/primitives.ts'
import { VOCABULARY_VERSION } from '../vocabulary/version.ts'

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const clone = (v) => JSON.parse(JSON.stringify(v))

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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// -------------------------------------------------------------------------------------------------
// Compositions under test
// -------------------------------------------------------------------------------------------------
const P = '/blocks/0/props'
/** Collection ON: everything inherits true unless a field says false. */
const ON = {
  ui: { label: 'Pages', clientEditable: true },
  fields: [
    { name: 'title', primitive: 'text' },
    { name: 'price', primitive: 'number', ui: { clientEditable: false } },
    { name: 'image', primitive: 'media' },
    { name: 'tags', primitive: 'text', multiple: true },
    {
      name: 'faq',
      primitive: 'group',
      multiple: true,
      itemKey: 'key',
      fields: [
        { name: 'key', primitive: 'text', required: true, ui: { clientEditable: false } },
        { name: 'q', primitive: 'text' },
        { name: 'a', primitive: 'text' },
      ],
    },
    {
      name: 'legal',
      primitive: 'group',
      ui: { clientEditable: false },
      fields: [
        { name: 'terms', primitive: 'text' },
        { name: 'summary', primitive: 'text', ui: { clientEditable: true } },
        { name: 'inner', primitive: 'group', fields: [{ name: 'deep', primitive: 'text' }, { name: 'deepYes', primitive: 'text', ui: { clientEditable: true } }] },
      ],
    },
  ],
  blocks: ['richText'],
}
/** Collection with no ui: only explicitly marked fields are editable. */
const OFF = {
  fields: [
    { name: 'title', primitive: 'text' },
    { name: 'blurb', primitive: 'text', ui: { clientEditable: true } },
    {
      name: 'team',
      primitive: 'group',
      ui: { clientEditable: true },
      fields: [
        { name: 'name', primitive: 'text' },
        { name: 'bio', primitive: 'text' },
        { name: 'rank', primitive: 'number', ui: { clientEditable: false } },
        { name: 'links', primitive: 'group', fields: [{ name: 'href', primitive: 'text' }] },
      ],
    },
  ],
  blocks: ['richText'],
}
/** Collection ui present but clientEditable false. */
const EXPLICIT_FALSE = { ui: { label: 'X', clientEditable: false }, fields: [{ name: 'a', primitive: 'text' }, { name: 'b', primitive: 'text', ui: { clientEditable: true } }] }
/** Generic-only collections (no `fields`). */
const GENERIC_ON = { ui: { label: 'Home', clientEditable: true }, blocks: ['hero', 'richText'] }
const GENERIC_OFF = { ui: { label: 'Home' }, blocks: ['hero', 'richText'] }

// =================================================================================================
// The editability function
// =================================================================================================
console.log('\n[isClientEditable]')
check('a top-level field inherits the collection value (true)', isClientEditable(ON, `${P}/title`) === true)
check('a field with ui.clientEditable:false overrides a true collection', isClientEditable(ON, `${P}/price`) === false)
check('no collection ui at all: a field with no flag is NOT editable (default false)', isClientEditable(OFF, `${P}/title`) === false)
check('no collection ui: a field marked true IS editable', isClientEditable(OFF, `${P}/blurb`) === true)
check('collection ui.clientEditable:false: unmarked false, marked true wins', isClientEditable(EXPLICIT_FALSE, `${P}/a`) === false && isClientEditable(EXPLICIT_FALSE, `${P}/b`) === true)
check('a value inside a media object resolves to the media field', isClientEditable(ON, `${P}/image/alt`) === true && isClientEditable(ON, `${P}/image/url`) === true)
check('an element of a multiple scalar resolves to its field', isClientEditable(ON, `${P}/tags/3`) === true && isClientEditable(OFF, `${P}/blurb/0`) === true)

console.log('\n[isClientEditable: groups]')
check('a group member inherits the group (true group, unmarked member)', isClientEditable(OFF, `${P}/team/name`) === true && isClientEditable(OFF, `${P}/team/bio`) === true)
check('a member with an explicit false overrides a true group', isClientEditable(OFF, `${P}/team/rank`) === false)
check('a nested group inherits the outer group, and so do ITS members', isClientEditable(OFF, `${P}/team/links/href`) === true)
check('a false group makes unmarked members false even under a TRUE collection', isClientEditable(ON, `${P}/legal/terms`) === false)
check('a member marked true inside a false group is editable (own value wins)', isClientEditable(ON, `${P}/legal/summary`) === true)
check('two levels down: unmarked inherits the false group, marked wins', isClientEditable(ON, `${P}/legal/inner/deep`) === false && isClientEditable(ON, `${P}/legal/inner/deepYes`) === true)
check('a list of objects: the index is skipped, the member resolves', isClientEditable(ON, `${P}/faq/2/q`) === true && isClientEditable(ON, `${P}/faq/0/key`) === false)
check('a pointer that stops at the list or one item resolves to the group itself', isClientEditable(ON, `${P}/faq`) === true && isClientEditable(ON, `${P}/faq/4`) === true && isClientEditable(ON, `${P}/legal`) === false)
check('a non-numeric or non-canonical index into a list of objects is refused', isClientEditable(ON, `${P}/faq/q`) === false && isClientEditable(ON, `${P}/faq/01/q`) === false && isClientEditable(ON, `${P}/faq/-1/q`) === false)
check('an unknown field is never editable (even under a true collection)', isClientEditable(ON, `${P}/nope`) === false && isClientEditable(ON, `${P}/faq/0/nope`) === false)
check('prototype-ish names are unknown fields', isClientEditable(ON, `${P}/__proto__`) === false && isClientEditable(ON, `${P}/constructor`) === false && isClientEditable(ON, `${P}/toString`) === false)

console.log('\n[isClientEditable: seo, generic blocks, structure]')
check('seo is NEVER editable, even when the collection is true', isClientEditable(ON, '/seo/title') === false && isClientEditable(ON, '/seo') === false && isClientEditable(ON, '/seo/redirect/toPath') === false)
check('seo is never editable when a field named like it is marked true', isClientEditable({ ui: { label: 'x', clientEditable: true }, fields: [{ name: 'seo', primitive: 'text', ui: { clientEditable: true } }] }, '/seo/title') === false)
check('a generic block after the fields block is editable iff the collection is', isClientEditable(ON, '/blocks/1/props/html') === true && isClientEditable(OFF, '/blocks/1/props/html') === false && isClientEditable(EXPLICIT_FALSE, '/blocks/2/type') === false)
check('a generic-only collection: every block is editable iff the collection is', isClientEditable(GENERIC_ON, '/blocks/0/props/heading') === true && isClientEditable(GENERIC_ON, '/blocks/3') === true && isClientEditable(GENERIC_OFF, '/blocks/0/props/heading') === false)
check('a field-level flag does not make a generic block editable', isClientEditable(OFF, '/blocks/1/props/html') === false)
check('the fields block itself (its type, props object, or slot) is structure, never editable', isClientEditable(ON, '/blocks/0') === false && isClientEditable(ON, '/blocks/0/type') === false && isClientEditable(ON, '/blocks/0/props') === false)
check('malformed pointers are refused', ['', '/', 'blocks/0/props/title', '/blocks', '/blocks/x/props/title', '/blocks/-1/props/title', '/blocks/00/props/title', '/other/x'].every((p) => isClientEditable(ON, p) === false))
check('RFC 6901 escapes in a segment are decoded (a field named with ~ or / cannot match a name by accident)', isClientEditable(ON, `${P}/ti~1tle`) === false)
check('an invalid composition (not an object) is never editable', isClientEditable(null, `${P}/title`) === false && isClientEditable({}, `${P}/title`) === false)

console.log('\n[collectionAcceptsClientCreate]')
check('a collection with at least one editable field accepts', collectionAcceptsClientCreate(ON) === true && collectionAcceptsClientCreate(OFF) === true && collectionAcceptsClientCreate(EXPLICIT_FALSE) === true)
check('a collection with no editable field refuses', collectionAcceptsClientCreate({ fields: [{ name: 'a', primitive: 'text' }] }) === false && collectionAcceptsClientCreate({ ui: { label: 'x', clientEditable: true }, fields: [{ name: 'a', primitive: 'text', ui: { clientEditable: false } }], blocks: [] }) === false)
check('a nested editable member counts', collectionAcceptsClientCreate({ fields: [{ name: 'g', primitive: 'group', ui: { clientEditable: false }, fields: [{ name: 'm', primitive: 'text', ui: { clientEditable: true } }] }] }) === true)
check('a generic-only collection accepts iff it is true and allows blocks', collectionAcceptsClientCreate(GENERIC_ON) === true && collectionAcceptsClientCreate(GENERIC_OFF) === false && collectionAcceptsClientCreate({ ui: { label: 'x', clientEditable: true }, blocks: [] }) === false)
check('garbage is refused', collectionAcceptsClientCreate(null) === false && collectionAcceptsClientCreate('x') === false)

// =================================================================================================
// The diff and the two violation helpers
// =================================================================================================
console.log('\n[changedContentPointers]')
const base = () => ({
  blocks: [
    { type: 'fields', props: { title: 'T', price: 10, tags: ['a', 'b'], faq: [{ key: 'k1', q: 'Q1', a: 'A1' }, { key: 'k2', q: 'Q2', a: 'A2' }] } },
    { type: 'richText', props: { html: '<p>x</p>' } },
  ],
  seo: { title: 'S' },
})
check('identical content has no changes', eq(changedContentPointers(base(), base()), []))
check('object key order is not a change', eq(changedContentPointers({ blocks: [{ props: { a: 1, b: 2 }, type: 'fields' }], seo: {} }, { blocks: [{ type: 'fields', props: { b: 2, a: 1 } }], seo: {} }), []))
{
  const a = base()
  const b = base()
  b.blocks[0].props.title = 'T2'
  check('a scalar change is reported at its pointer', eq(changedContentPointers(a, b), [`${P}/title`]))
}
{
  const b = base()
  b.blocks[0].props.faq[1].a = 'changed'
  b.seo.title = 'S2'
  check('a list-of-objects member and seo are reported by pointer, sorted', eq(changedContentPointers(base(), b), [`${P}/faq/1/a`, '/seo/title']))
}
{
  const b = base()
  b.blocks[0].props.extra = 'new'
  delete b.blocks[0].props.price
  check('an added key and a removed key are both changes', eq(changedContentPointers(base(), b), [`${P}/extra`, `${P}/price`]))
}
{
  const b = base()
  b.blocks[0].props.tags = ['a', 'b', 'c']
  check('a longer array reports the new index', eq(changedContentPointers(base(), b), [`${P}/tags/2`]))
  const c = base()
  c.blocks[0].props.tags = ['a']
  check('a shorter array reports the removed index', eq(changedContentPointers(base(), c), [`${P}/tags/1`]))
}
{
  const b = base()
  b.blocks[0].props.faq.push({ key: 'k3', q: 'Q3', a: 'A3' })
  check('a new list item reports EVERY leaf of the item (not the item itself), so a non-editable member inside cannot hide', eq(changedContentPointers(base(), b), [`${P}/faq/2/a`, `${P}/faq/2/key`, `${P}/faq/2/q`]))
}
{
  const b = base()
  b.blocks[0].props.title = { nested: { deep: 1 } }
  const ptrs = changedContentPointers(base(), b)
  check('a scalar replaced by an object reports the pointer and the object\'s leaves', eq(ptrs, [`${P}/title`, `${P}/title/nested/deep`]), JSON.stringify(ptrs))
}
{
  const b = base()
  b.blocks.push({ type: 'hero', props: { heading: 'H' } })
  check('a new generic block reports its leaves', eq(changedContentPointers(base(), b), ['/blocks/2/props/heading', '/blocks/2/type']), JSON.stringify(changedContentPointers(base(), b)))
}
{
  // A hostile "__proto__" key (JSON.parse makes it an OWN property): it must be reported as a change, never read through the prototype.
  const hostile = JSON.parse('{"blocks":[{"type":"fields","props":{"__proto__":{}}}],"seo":{}}')
  const clean = { blocks: [{ type: 'fields', props: {} }], seo: {} }
  const ptrs = changedContentPointers(clean, hostile)
  check('a "__proto__" key is a real key and is reported (never read through the prototype)', eq(ptrs, [`${P}/__proto__`]), JSON.stringify(ptrs))
  check('and it is never editable, even under a true collection', clientEditViolations(ON, clean, hostile).length === 1 && clientCreateViolations(ON, hostile).length === 1, JSON.stringify([clientEditViolations(ON, clean, hostile), clientCreateViolations(ON, hostile)]))
}
{
  let deepA = 'x'
  let deepB = 'y'
  for (let i = 0; i < 5000; i++) {
    deepA = { n: deepA }
    deepB = { n: deepB }
  }
  let threw = null
  let ptrs = null
  try {
    ptrs = changedContentPointers({ blocks: [{ type: 'fields', props: { title: deepA } }], seo: {} }, { blocks: [{ type: 'fields', props: { title: deepB } }], seo: {} })
  } catch (e) {
    threw = e
  }
  check('a pathologically deep value fails CLOSED (a pointer inside the field, never a thrown RangeError)', threw === null && Array.isArray(ptrs) && ptrs.length === 1 && ptrs[0].startsWith(`${P}/title/n/n`), String(threw ?? JSON.stringify(ptrs)?.slice(0, 80)))
}

console.log('\n[clientEditViolations]')
{
  const b = base()
  b.blocks[0].props.title = 'T2'
  b.blocks[0].props.faq[0].q = 'new q'
  check('every changed path editable -> no violations', eq(clientEditViolations(ON, base(), b), []))
}
{
  const b = base()
  b.blocks[0].props.title = 'T2'
  b.blocks[0].props.price = 99
  b.blocks[0].props.faq[0].key = 'renamed'
  check('a mixed change lists exactly the non-editable pointers', eq(clientEditViolations(ON, base(), b), [`${P}/faq/0/key`, `${P}/price`]), JSON.stringify(clientEditViolations(ON, base(), b)))
}
{
  const b = base()
  b.seo.description = 'sneaky'
  check('a seo change is a violation under a true collection', eq(clientEditViolations(ON, base(), b), ['/seo/description']))
}
{
  const b = base()
  b.blocks[1].props.html = '<p>y</p>'
  check('a generic block change follows the collection', eq(clientEditViolations(ON, base(), b), []) && eq(clientEditViolations(OFF, base(), b), ['/blocks/1/props/html']))
}
{
  const b = base()
  b.blocks[0].props.faq.push({ key: 'k3', q: 'Q3', a: 'A3' })
  check('adding a list item whose key member is non-editable is refused (it lists the key leaf)', eq(clientEditViolations(ON, base(), b), [`${P}/faq/2/key`]), JSON.stringify(clientEditViolations(ON, base(), b)))
}

console.log('\n[clientCreateViolations]')
{
  const ok = { blocks: [{ type: 'fields', props: { title: 'T', tags: ['x'], image: { url: 'https://x/y.png' } } }], seo: {} }
  check('a create that sets only editable fields has no violations', eq(clientCreateViolations(ON, ok), []))
  const bad = { blocks: [{ type: 'fields', props: { title: 'T', price: 5 } }], seo: {} }
  check('a non-editable field set to a value is a violation', eq(clientCreateViolations(ON, bad), [`${P}/price`]))
  const nulls = { blocks: [{ type: 'fields', props: { title: 'T', price: null, faq: undefined } }], seo: {} }
  check('a non-editable field that is null or absent equals its default and is fine', eq(clientCreateViolations(ON, nulls), []))
  const seo = { blocks: [{ type: 'fields', props: { title: 'T' } }], seo: { title: 'S' } }
  check('seo must be empty', eq(clientCreateViolations(ON, seo), ['/seo/title']) && eq(clientCreateViolations(ON, { blocks: [{ type: 'fields', props: {} }], seo: { title: null } }), []))
  const generic = { blocks: [{ type: 'fields', props: {} }, { type: 'richText', props: { html: 'x' } }], seo: {} }
  check('generic blocks on create follow the collection', eq(clientCreateViolations(ON, generic), []) && eq(clientCreateViolations(OFF, generic).length > 0, true))
  const emptyList = { blocks: [{ type: 'fields', props: { title: 'T', legal: { terms: 'x' } } }], seo: {} }
  check('a nested non-editable member set on create is a violation', eq(clientCreateViolations(ON, emptyList), [`${P}/legal/terms`]))
}

// =================================================================================================
// The composition validator
// =================================================================================================
console.log('\n[validator]')
check('ui.clientEditable is accepted on a collection and on a field', validateCollectionComposition('c', { ui: { label: 'L', clientEditable: true }, fields: [{ name: 'a', primitive: 'text', ui: { clientEditable: false } }] }).valid === true)
check('a non-boolean collection ui.clientEditable is refused', validateCollectionComposition('c', { ui: { label: 'L', clientEditable: 'yes' } }).issues.some((i) => i.path === 'c.ui.clientEditable'))
check('a non-boolean field ui.clientEditable is refused', validateCollectionComposition('c', { fields: [{ name: 'a', primitive: 'text', ui: { clientEditable: 1 } }] }).issues.some((i) => i.path === 'c.fields[0].ui.clientEditable'))
check('FIELD_UI_KEYS carries clientEditable', FIELD_UI_KEYS.includes('clientEditable'))
check('a composition authored against 1.1.0 is still accepted (a MINOR is a superset)', isVocabularyVersionSupported('1.1.0') === true && isVocabularyVersionSupported('1.2.0') === true && isVocabularyVersionSupported('1.3.0') === false)

// =================================================================================================
// The classifier: COMPUTED, not asserted
// =================================================================================================
console.log('\n[classifier]')
const v110 = load(path.join(HERE, 'fixtures', 'vocabulary-1.1.0.snapshot.json'))
const current = currentVocabularySnapshot()
check('the fixture is the 1.1.0 snapshot', v110.vocabularyVersion === '1.1.0', v110.vocabularyVersion)
check('VOCABULARY_VERSION is 1.2.0', VOCABULARY_VERSION === '1.2.0', VOCABULARY_VERSION)
const rated = classifyVocabularyChange(v110, current)
console.log('  >>> classifyVocabularyChange(1.1.0 fixture, current):')
console.log(JSON.stringify(rated, null, 2).replace(/^/gm, '      '))
check('classifyVocabularyChange(1.1.0 snapshot, current) === "minor"', rated.bump === 'minor', JSON.stringify(rated))
check(
  'the reasons are exactly the two new ui keys, nothing else',
  eq(rated.reasons, ['FieldDef ui key "clientEditable" added (new optional key)', 'collection ui key "clientEditable" added (new optional key)']),
  JSON.stringify(rated.reasons),
)
check('the computed bump applied to 1.1.0 IS the shipped version', bumpVersion('1.1.0', rated.bump) === VOCABULARY_VERSION, bumpVersion('1.1.0', rated.bump))
check('the envelope did not change by a byte (no envelope reason, signature equals the 1.1.0 capture)', !rated.reasons.some((r) => r.includes('envelope')) && eq(currentEnvelopeShapeSignature(), v110.envelopeShape))
check('the new dimensions are in the current snapshot', eq(current.fieldUiKeys, [...FIELD_UI_KEYS].sort()) && current.collectionUiKeys.includes('clientEditable'), JSON.stringify([current.fieldUiKeys, current.collectionUiKeys]))
{
  const after = clone(current)
  after.fieldUiKeys = after.fieldUiKeys.filter((k) => k !== 'help')
  const r = classifyVocabularyChange(current, after)
  check('removing a field ui key is MAJOR', r.bump === 'major', JSON.stringify(r))
  const after2 = clone(current)
  after2.collectionUiKeys = [...after2.collectionUiKeys, 'archived'].sort()
  const r2 = classifyVocabularyChange(current, after2)
  check('adding a collection ui key is MINOR', r2.bump === 'minor', JSON.stringify(r2))
}
{
  const legacy = clone(v110)
  delete legacy.fieldUiKeys
  let threw = null
  try {
    classifyVocabularyChange(legacy, current)
  } catch (e) {
    threw = e
  }
  check('a 1.1.0-shaped snapshot WITHOUT the ui-key dimensions is refused loudly, never compared blind', threw && /fieldUiKeys/.test(threw.message), String(threw))
}
{
  // The 1.0.0 fixture has no `ui` key on FieldDef at all, so its ui sub-keys are not a separate dimension.
  const v100 = load(path.join(HERE, 'fixtures', 'vocabulary-1.0.0.snapshot.json'))
  const r = classifyVocabularyChange(v100, current)
  check('1.0.0 -> current is still MINOR (the ui key itself is the added key)', r.bump === 'minor', JSON.stringify(r))
}

console.log('\n[tenant contract: a clientEditable flip is a ui edit]')
const T = (collections) => ({ collections })
{
  const r = classifyTenantContractChange(
    T({ n: { fields: [{ name: 'url', primitive: 'text', ui: { label: 'URL' } }] } }),
    T({ n: { fields: [{ name: 'url', primitive: 'text', ui: { label: 'URL', clientEditable: true } }] } }),
  )
  check('a FIELD ui.clientEditable false/absent -> true is PATCH', r.bump === 'patch' && r.reasons.length === 1 && r.reasons[0].includes('ui changed'), JSON.stringify(r))
  const back = classifyTenantContractChange(
    T({ n: { fields: [{ name: 'url', primitive: 'text', ui: { clientEditable: true } }] } }),
    T({ n: { fields: [{ name: 'url', primitive: 'text', ui: { clientEditable: false } }] } }),
  )
  check('a FIELD ui.clientEditable true -> false is PATCH', back.bump === 'patch', JSON.stringify(back))
}
{
  const r = classifyTenantContractChange(T({ n: { fields: [], ui: { label: 'N' } } }), T({ n: { fields: [], ui: { label: 'N', clientEditable: true } } }))
  check('a COLLECTION ui.clientEditable flip is PATCH', r.bump === 'patch' && r.reasons[0].includes('ui changed'), JSON.stringify(r))
}
{
  const r = classifyTenantContractChange(
    T({ n: { fields: [{ name: 'g', primitive: 'group', fields: [{ name: 'm', primitive: 'text' }] }] } }),
    T({ n: { fields: [{ name: 'g', primitive: 'group', fields: [{ name: 'm', primitive: 'text', ui: { clientEditable: true } }] }] } }),
  )
  check('a flip on a group MEMBER is PATCH too (the recursion carries ui)', r.bump === 'patch', JSON.stringify(r))
}

console.log(`\n  WSK-49 client-editable suite: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
