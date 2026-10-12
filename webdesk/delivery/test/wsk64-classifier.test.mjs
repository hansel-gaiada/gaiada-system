/**
 * WSK-64 — vocabulary 1.0.0 -> 1.1.0 is COMPUTED, not asserted (write-plane design §2.3, done-when
 * items 1, 2 and 6). Pure unit coverage, no database.
 *
 *   node --import tsx test/wsk64-classifier.test.mjs
 *
 * Optional: WSK64_BASE_VOCAB_DIR=<a pre-WSK-64 webdesk/delivery/vocabulary checkout> also runs the
 * negative controls through the 1.0.0 classifier, proving it rated the blind cases PATCH.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import {
  classifyVocabularyChange,
  classifyTenantContractChange,
  currentVocabularySnapshot,
  currentEnvelopeShapeSignature,
} from '../vocabulary/breaking-change.ts'
import { VOCABULARY_VERSION } from '../vocabulary/version.ts'
import { probeVocabularySnapshot } from './wsk64-snapshot-probe.mjs'

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 'vocabulary-1.0.0.snapshot.json')

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
const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))

// =================================================================================================
// Done-when 1: the computed bump, with exactly §2.3's rows 1-8 as reasons
// =================================================================================================
const v100 = load(FIXTURE)
const current = currentVocabularySnapshot()

check('the fixture is the 1.0.0 snapshot', v100.vocabularyVersion === '1.0.0', v100.vocabularyVersion)
check('VOCABULARY_VERSION is 1.3.0 (M5-W3c: a MINOR on top of 1.2.0; see wsk49-client-editable.test.mjs and w3c-lint-content.test.mjs)', VOCABULARY_VERSION === '1.3.0', VOCABULARY_VERSION)

// Each expected reason, tagged with the §2.3 row it realises. Exact strings, exact order.
const EXPECTED = [
  [1, 'primitive "group" added'],
  [3, 'primitive "boolean" added'],
  [4, 'primitive "markdown" added'],
  [6, 'block type "fields" added (the composition-typed block: its props are typed per collection, not by the vocabulary)'],
  [5, '"multiple" now honoured for primitive(s) date, geo, number, richtext, select, text (new capability)'],
  [1, 'FieldDef key "fields" added (new optional key)'],
  [2, 'FieldDef key "itemKey" added (new optional key)'],
  [7, 'FieldDef key "localized" added (new optional key)'],
  [8, 'FieldDef key "ui" added (new optional key)'],
  [8, 'composition key "lint" added (new optional key)'],
  [8, 'composition key "localized" added (new optional key)'],
  [8, 'composition key "singleton" added (new optional key)'],
  [8, 'composition key "ui" added (new optional key)'],
]

const result = classifyVocabularyChange(v100, current)
console.log('  >>> classifyVocabularyChange(1.0.0 fixture, current):')
console.log(JSON.stringify(result, null, 2).replace(/^/gm, '      '))
check('1.0.0 -> current is MINOR', result.bump === 'minor', JSON.stringify(result))
check(
  'the reasons are exactly the expected list (no more, no fewer, same order)',
  JSON.stringify(result.reasons) === JSON.stringify(EXPECTED.map(([, r]) => r)),
  JSON.stringify(result.reasons),
)
const rowsCovered = [...new Set(EXPECTED.map(([row]) => row))].sort((a, b) => a - b)
check('every row 1-8 of §2.3 is realised by at least one reason', JSON.stringify(rowsCovered) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8]), JSON.stringify(rowsCovered))
check('no reason mentions the envelope (row 9: no envelope path changed)', !result.reasons.some((r) => r.includes('envelope')), JSON.stringify(result.reasons))

// =================================================================================================
// Done-when 6 (row 9): the envelope is byte-identical
// =================================================================================================
check(
  'currentEnvelopeShapeSignature() equals the 1.0.0 snapshot exactly',
  JSON.stringify(currentEnvelopeShapeSignature()) === JSON.stringify(v100.envelopeShape),
  JSON.stringify(currentEnvelopeShapeSignature()),
)
const ENVELOPE_SHA256_LF = '941c5c2d16ef2bfea9f567b31113c60a0451a2ea4f8fc972b4406fd13b6370e1' // envelope.ts at 8023c992
const envelopeSha = crypto
  .createHash('sha256')
  .update(fs.readFileSync(path.join(HERE, '..', 'vocabulary', 'envelope.ts'), 'utf8').replace(/\r\n/g, '\n'))
  .digest('hex')
check('vocabulary/envelope.ts is byte-identical to its pre-WSK-64 content (LF-normalised sha256)', envelopeSha === ENVELOPE_SHA256_LF, envelopeSha)

// =================================================================================================
// The extended dimensions are behaviour, not declaration
// =================================================================================================
const probed = await probeVocabularySnapshot()
for (const dim of ['primitives', 'blocks', 'envelopeShape', 'multipleCapable', 'fieldDefKeys', 'compositionKeys', 'fieldUiKeys', 'collectionUiKeys', 'lintKeys']) {
  check(
    `the probe (same method that captured the fixture) agrees with currentVocabularySnapshot().${dim}`,
    JSON.stringify(probed[dim]) === JSON.stringify(current[dim]),
    `${JSON.stringify(probed[dim])} vs ${JSON.stringify(current[dim])}`,
  )
}
check('the 1.0.0 fixture honoured multiple for media + relation only', JSON.stringify(v100.multipleCapable) === '["media","relation"]', JSON.stringify(v100.multipleCapable))

{
  const legacy = { primitives: v100.primitives, blocks: v100.blocks, envelopeShape: v100.envelopeShape }
  let threw = null
  try {
    classifyVocabularyChange(legacy, current)
  } catch (e) {
    threw = e
  }
  check('a snapshot without the WSK-64 dimensions is refused loudly, never compared blind', threw && /predates WSK-64/.test(threw.message), String(threw))
}

// =================================================================================================
// Done-when 2: negative controls. Shared with the optional 1.0.0 run below.
// =================================================================================================
function negativeControls(classifyVocab, classifyTenant, baseSnapshot) {
  const out = []
  const withBlock = (snap, fields) => {
    const s = clone(snap)
    s.blocks.probeBlock = { fields }
    return s
  }
  const group = (subs, extra = {}) => ({ name: 'g', primitive: 'group', fields: subs, ...extra })
  const sub = (name, extra = {}) => ({ name, primitive: 'text', ...extra })

  // (a) a group sub-field removed, vocabulary axis
  {
    const before = withBlock(baseSnapshot, [group([sub('a'), sub('b')])])
    const after = withBlock(baseSnapshot, [group([sub('a')])])
    out.push(['vocabulary: group sub-field removed', classifyVocab(before, after)])
  }
  // (a') the same on the tenant axis
  {
    const before = { collections: { page: { fields: [group([sub('a'), sub('b')])] } } }
    const after = { collections: { page: { fields: [group([sub('a')])] } } }
    out.push(['tenant: group sub-field removed', classifyTenant(before, after)])
  }
  // (b) itemKey changed
  {
    const list = (key) => [group([sub('key', { required: true }), sub('slug', { required: true })], { multiple: true, itemKey: key })]
    const before = { collections: { nav: { fields: list('key') } } }
    const after = { collections: { nav: { fields: list('slug') } } }
    out.push(['tenant: itemKey changed', classifyTenant(before, after)])
  }
  // (c) localized true -> false
  {
    const before = { collections: { nav: { fields: [sub('url')] } } }
    const after = { collections: { nav: { fields: [sub('url', { localized: false })] } } }
    out.push(['tenant: field localized true -> false', classifyTenant(before, after)])
  }
  // (d) a mutated envelope path
  {
    const after = clone(baseSnapshot)
    after.envelopeShape = [...after.envelopeShape, 'item.fields'].sort()
    out.push(['vocabulary: envelope path added (item.fields)', classifyVocab(baseSnapshot, after)])
  }
  return out
}

const controls = negativeControls(classifyVocabularyChange, classifyTenantContractChange, current)
for (const [name, r] of controls) {
  console.log(`  >>> control "${name}": ${r.bump} — ${r.reasons.join(' | ')}`)
  check(`negative control is MAJOR: ${name}`, r.bump === 'major', JSON.stringify(r))
}
check(
  'the removed sub-field reason names the group path (the recursion, not a coincidence)',
  controls[0][1].reasons.some((r) => r.includes('> group "g"') && r.includes('field "b" removed')),
  JSON.stringify(controls[0][1]),
)

const baseDir = process.env.WSK64_BASE_VOCAB_DIR
if (baseDir) {
  const baseBc = await import(url.pathToFileURL(path.join(path.resolve(baseDir), 'breaking-change.ts')).href)
  const baseControls = negativeControls(baseBc.classifyVocabularyChange, baseBc.classifyTenantContractChange, baseBc.currentVocabularySnapshot())
  const expectedBase = ['patch', 'patch', 'patch', 'patch', 'major']
  baseControls.forEach(([name, r], i) => {
    console.log(`  >>> 1.0.0 classifier, control "${name}": ${r.bump} — ${r.reasons.join(' | ')}`)
    check(`the 1.0.0 classifier rated "${name}" ${expectedBase[i]} (proves the blind spot WSK-64 closed)`, r.bump === expectedBase[i], JSON.stringify(r))
  })
} else {
  console.log('  SKIP  1.0.0 classifier comparison (set WSK64_BASE_VOCAB_DIR to a pre-WSK-64 vocabulary dir)')
}

// =================================================================================================
// The new ratings, each in isolation
// =================================================================================================
{
  const after = clone(current)
  after.multipleCapable = after.multipleCapable.filter((p) => p !== 'text')
  const r = classifyVocabularyChange(current, after)
  check('narrowing multiple (text) is MAJOR', r.bump === 'major' && r.reasons[0].includes('text'), JSON.stringify(r))
}
{
  const after = clone(current)
  after.fieldDefKeys = after.fieldDefKeys.filter((k) => k !== 'ui')
  const r = classifyVocabularyChange(current, after)
  check('removing a FieldDef key is MAJOR', r.bump === 'major', JSON.stringify(r))
}
{
  const after = clone(current)
  after.compositionKeys = after.compositionKeys.filter((k) => k !== 'lint')
  const r = classifyVocabularyChange(current, after)
  check('removing a composition key is MAJOR', r.bump === 'major', JSON.stringify(r))
}
{
  const after = clone(current)
  after.compositionKeys = [...after.compositionKeys, 'archived'].sort()
  const r = classifyVocabularyChange(current, after)
  check('adding a composition key is MINOR', r.bump === 'minor', JSON.stringify(r))
}
{
  const r = classifyVocabularyChange(current, clone(current))
  check('no change is PATCH', r.bump === 'patch', JSON.stringify(r))
}

const T = (collections) => ({ collections })
{
  const g = (subs) => [{ name: 'plan', primitive: 'group', fields: subs }]
  const r = classifyTenantContractChange(
    T({ p: { fields: g([{ name: 'action', primitive: 'text' }]) } }),
    T({ p: { fields: g([{ name: 'action', primitive: 'text' }, { name: 'why', primitive: 'text' }]) } }),
  )
  check('an optional sub-field added to a group is MINOR', r.bump === 'minor', JSON.stringify(r))
  const r2 = classifyTenantContractChange(
    T({ p: { fields: g([{ name: 'action', primitive: 'text' }]) } }),
    T({ p: { fields: g([{ name: 'action', primitive: 'text' }, { name: 'to', primitive: 'text', required: true }]) } }),
  )
  check('a REQUIRED sub-field added to a group is MAJOR', r2.bump === 'major', JSON.stringify(r2))
  const r3 = classifyTenantContractChange(
    T({ p: { fields: g([{ name: 'action', primitive: 'text' }]) } }),
    T({ p: { fields: g([{ name: 'action', primitive: 'select', options: ['SHOW'] }]) } }),
  )
  check('a group sub-field primitive change is MAJOR', r3.bump === 'major', JSON.stringify(r3))
}
{
  const r = classifyTenantContractChange(
    T({ n: { fields: [{ name: 'url', primitive: 'text', localized: false }] } }),
    T({ n: { fields: [{ name: 'url', primitive: 'text' }] } }),
  )
  check('field localized false -> true is MINOR', r.bump === 'minor', JSON.stringify(r))
}
{
  const r = classifyTenantContractChange(
    T({ n: { fields: [{ name: 'url', primitive: 'text', ui: { label: 'URL' } }] } }),
    T({ n: { fields: [{ name: 'url', primitive: 'text', ui: { label: 'Link', widget: 'input' } }] } }),
  )
  check('a field ui edit is PATCH', r.bump === 'patch' && r.reasons[0].includes('ui changed'), JSON.stringify(r))
}
{
  const r = classifyTenantContractChange(T({ n: { fields: [], ui: { label: 'A' } } }), T({ n: { fields: [], ui: { label: 'B', order: 2 } } }))
  check('a collection ui edit is PATCH', r.bump === 'patch' && r.reasons[0].includes('ui changed'), JSON.stringify(r))
}
{
  const r = classifyTenantContractChange(
    T({ n: { fields: [] } }),
    T({ n: { fields: [], lint: { placeholders: [{ kind: 'marker', open: '[CONFIRM:', close: ']', label: 'confirm' }] } } }),
  )
  check('a lint edit is PATCH (advisory)', r.bump === 'patch', JSON.stringify(r))
}
{
  const r = classifyTenantContractChange(T({ c: { fields: [] } }), T({ c: { fields: [], singleton: true } }))
  check('a collection singleton flip is MAJOR', r.bump === 'major', JSON.stringify(r))
  const r2 = classifyTenantContractChange(T({ c: { fields: [], localized: false } }), T({ c: { fields: [] } }))
  check('a collection localized flip (false -> true) is MAJOR', r2.bump === 'major', JSON.stringify(r2))
}
{
  const r = classifyTenantContractChange(
    T({ c: { fields: [{ name: 'k', primitive: 'group', multiple: true, fields: [{ name: 'key', primitive: 'text', required: true }] }] } }),
    T({ c: { fields: [{ name: 'k', primitive: 'group', multiple: true, itemKey: 'key', fields: [{ name: 'key', primitive: 'text', required: true }] }] } }),
  )
  check('adding an itemKey to an existing list is MAJOR (identity introduced)', r.bump === 'major', JSON.stringify(r))
}
{
  const r = classifyTenantContractChange(T({ p: { fields: [{ name: 'tags', primitive: 'text' }] } }), T({ p: { fields: [{ name: 'tags', primitive: 'text', multiple: true }] } }))
  check('a scalar multiple flip is still MAJOR (unchanged 1.0.0 rule)', r.bump === 'major', JSON.stringify(r))
}

console.log(`\n  WSK-64 classifier suite: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
