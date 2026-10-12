/**
 * M5-V5-a — vocabulary 1.5.0 (MINOR): the `experiment` block (A/B variants), phase-5 design section 5.1 / 5.2.
 * Pure unit coverage, no database.
 *
 *   node --import tsx test/v5a-experiment.test.mjs        (cwd webdesk/api, like the other vocabulary suites)
 *
 * Covers: the block type is known, non-composable and never listed in a composition; the classifier COMPUTES
 * 1.4.0 -> current as MINOR from the committed 1.4.0 snapshot with exactly the one new reason; the envelope did not
 * change by a byte; every write-time rule of section 5.1 has a passing and a failing case; the experiment is never
 * client-editable (edit, create, remove); the publish lock (the pure half) refuses a change to a running experiment
 * or its control and allows the stop.
 */
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import {
  BLOCKS,
  BLOCK_TYPE_NAMES,
  COMPOSABLE_BLOCK_TYPE_NAMES,
  EXPERIMENT_BLOCK_TYPE,
  isBlockType,
  isComposableBlockType,
  validateBlock,
} from '../vocabulary/blocks.ts'
import { validateCollectionComposition, isVocabularyVersionSupported } from '../vocabulary/composition.ts'
import { validateItemContent, experimentLockViolations } from '../vocabulary/item-fields.ts'
import { isClientEditable, clientEditViolations, clientCreateViolations } from '../vocabulary/client-editable.ts'
import { bumpVersion, classifyVocabularyChange, currentVocabularySnapshot } from '../vocabulary/breaking-change.ts'
import { VOCABULARY_VERSION } from '../vocabulary/version.ts'

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const clone = (v) => JSON.parse(JSON.stringify(v))
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

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

console.log('\n[the block type]')
check('the vocabulary is 1.5.0', VOCABULARY_VERSION === '1.5.0', VOCABULARY_VERSION)
check('experiment is a known block type with no vocabulary props', isBlockType('experiment') && BLOCKS.experiment.fields.length === 0)
check('it is not composable, and the 9 generic block types are unchanged', !isComposableBlockType('experiment') && COMPOSABLE_BLOCK_TYPE_NAMES.length === 9 && BLOCK_TYPE_NAMES.length === 11)
check('validateBlock accepts it as a known block (props are checked per item)', eq(validateBlock({ type: 'experiment', props: { anything: 1 } }), { valid: true, errors: [], unknownType: false }))
const listed = validateCollectionComposition('page', { blocks: ['hero', 'experiment'] })
check('a composition listing "experiment" in blocks is refused with the right path', !listed.valid && listed.issues.some((i) => i.path === 'page.blocks[1]' && /A\/B-test block/.test(i.message)), JSON.stringify(listed.issues))
check('a composition authored against 1.4.0 is still accepted; 1.6.0 is refused', isVocabularyVersionSupported('1.4.0') && isVocabularyVersionSupported('1.5.0') && !isVocabularyVersionSupported('1.6.0'))

console.log('\n[classifier]')
const v140 = load(path.join(HERE, 'fixtures', 'vocabulary-1.4.0.snapshot.json'))
const current = currentVocabularySnapshot()
check('the fixture is the 1.4.0 snapshot (no experiment block)', v140.vocabularyVersion === '1.4.0' && !('experiment' in v140.blocks), Object.keys(v140.blocks).join(','))
const rated = classifyVocabularyChange(v140, current)
console.log(JSON.stringify(rated, null, 2).replace(/^/gm, '      '))
check('classifyVocabularyChange(1.4.0 snapshot, current) === "minor"', rated.bump === 'minor', JSON.stringify(rated))
check(
  'the reason is exactly the one new block type, nothing else',
  eq(rated.reasons, ['block type "experiment" added (the A/B-test block: non-composable and non-visual, its props are checked per item)']),
  JSON.stringify(rated.reasons),
)
check('the computed bump applied to 1.4.0 IS the shipped version', bumpVersion('1.4.0', rated.bump) === VOCABULARY_VERSION, bumpVersion('1.4.0', rated.bump))
check('the envelope did not change by a byte', eq(current.envelopeShape, v140.envelopeShape))
{
  const after = clone(current)
  delete after.blocks.experiment
  check('removing the block type again is MAJOR', classifyVocabularyChange(current, after).bump === 'major')
}

console.log('\n[validateItemContent: placement]')
const FIELDS = [
  { name: 'heading', primitive: 'text', required: true },
  { name: 'ctaLabel', primitive: 'text' },
  { name: 'count', primitive: 'number' },
]
const PAGE = { fields: FIELDS, blocks: ['hero', 'cta'], ui: { label: 'Page', clientEditable: true } }
const CLOSED = { fields: FIELDS, blocks: [] }
const NOFIELDS = { blocks: ['hero', 'cta'] }
const fieldsBlock = (props = { heading: 'Websites that win work', ctaLabel: 'Get a quote' }) => ({ type: 'fields', props })
const exp = (over = {}) => ({
  type: 'experiment',
  props: {
    key: 'home-hero-2026-11',
    target: 'fields',
    enrolment: 'consented',
    goal: { event: 'lead_form_start', match: { form_id: 'contact' } },
    arms: [
      { key: 'a', weight: 50 },
      { key: 'b', weight: 50, override: { heading: 'Your next client is searching now' } },
    ],
    ...over,
  },
})
const issuesOf = (c, blocks) => validateItemContent(c, blocks).issues
const ok = (c, blocks) => validateItemContent(c, blocks).valid
const has = (c, blocks, re, pathPrefix) => issuesOf(c, blocks).some((i) => re.test(i.message) && (!pathPrefix || i.path.startsWith(pathPrefix)))

check('a valid fields experiment passes', ok(PAGE, [fieldsBlock(), exp()]), JSON.stringify(issuesOf(PAGE, [fieldsBlock(), exp()])))
check('it is allowed without being listed, even in a collection whose blocks is closed to []', ok(CLOSED, [fieldsBlock(), exp()]))
check('enrolment "all" and an absent enrolment pass', ok(PAGE, [fieldsBlock(), exp({ enrolment: 'all' })]) && ok(PAGE, [fieldsBlock(), (() => { const e = exp(); delete e.props.enrolment; return e })()]))
check('never at index 0 (a collection without fields)', has(NOFIELDS, [exp({ target: { block: 1 } }), { type: 'hero', props: { heading: 'h' } }], /can never be blocks\[0\]/))
check('never at index 0 (a fields collection: fields is blocks[0], so it is also misplaced)', has(PAGE, [exp(), fieldsBlock()], /can never be blocks\[0\]|must be blocks\[0\]/))
check('at most one per item', has(PAGE, [fieldsBlock(), exp(), exp({ key: 'second-test' })], /duplicate "experiment" block/, '/blocks/2'))
check('props must be an object', issuesOf(PAGE, [fieldsBlock(), { type: 'experiment', props: 'x' }]).some((i) => i.path === '/blocks/1/props'))

console.log('\n[validateItemContent: props]')
check('an unknown prop is refused (closed)', has(PAGE, [fieldsBlock(), exp({ nope: 1 })], /unknown key "nope"/, '/blocks/1/props/nope'))
for (const k of ['ab', 'A-bc', '-abc', 'a'.repeat(49), 'has space', 'under_score', 42, undefined]) {
  check(`key ${JSON.stringify(k)} is refused`, issuesOf(PAGE, [fieldsBlock(), exp({ key: k })]).some((i) => i.path === '/blocks/1/props/key'))
}
for (const k of ['abc', '0ab', 'a-b-c', 'a'.repeat(48)]) check(`key ${JSON.stringify(k)} is accepted`, ok(PAGE, [fieldsBlock(), exp({ key: k })]))
check('a bad enrolment is refused', has(PAGE, [fieldsBlock(), exp({ enrolment: 'sometimes' })], /enrolment must be/))
check('a missing goal is refused', has(PAGE, [fieldsBlock(), exp({ goal: undefined })], /goal must be an object/))
for (const ev of ['generate_lead', 'lead_form_start', 'cta_click', 'click_whatsapp', 'click_phone', 'click_email', 'section_view']) {
  check(`goal.event ${ev} is accepted`, ok(PAGE, [fieldsBlock(), exp({ goal: { event: ev } })]))
}
check('an unknown goal.event is refused', has(PAGE, [fieldsBlock(), exp({ goal: { event: 'page_view' } })], /goal\.event is not one of/))
check('goal.match holds at most one key', has(PAGE, [fieldsBlock(), exp({ goal: { event: 'cta_click', match: { form_id: 'a', section_id: 'b' } } })], /at most one of form_id/))
check('goal.match refuses an unknown key', has(PAGE, [fieldsBlock(), exp({ goal: { event: 'cta_click', match: { url: 'a' } } })], /unknown goal\.match key/))
check('goal.match value is [A-Za-z0-9_.:-]{1,64}', has(PAGE, [fieldsBlock(), exp({ goal: { event: 'cta_click', match: { section_id: 'has space' } } })], /goal\.match\.section_id must be/) && has(PAGE, [fieldsBlock(), exp({ goal: { event: 'cta_click', match: { form_id: 'a'.repeat(65) } } })], /goal\.match\.form_id must be/) && ok(PAGE, [fieldsBlock(), exp({ goal: { event: 'section_view', match: { section_id: 'home.hero:step-3_A' } } })]))
check('a goal with extra keys is refused', has(PAGE, [fieldsBlock(), exp({ goal: { event: 'cta_click', extra: 1 } })], /unknown key "extra"/))

console.log('\n[validateItemContent: arms]')
const arms = (list) => exp({ arms: list })
const A = { key: 'a', weight: 50 }
const B = { key: 'b', weight: 50, override: { heading: 'B' } }
check('one arm is refused', has(PAGE, [fieldsBlock(), arms([{ key: 'a', weight: 100 }])], /2 to 4 arms/))
check('five arms are refused', has(PAGE, [fieldsBlock(), arms([A, B, B, B, B])], /2 to 4 arms/))
check('four arms (a-d, 25 each) pass', ok(PAGE, [fieldsBlock(), arms([{ key: 'a', weight: 25 }, { ...B, weight: 25 }, { key: 'c', weight: 25, override: { heading: 'C' } }, { key: 'd', weight: 25, override: { heading: 'D' } }])]))
check('three arms (34/33/33) pass', ok(PAGE, [fieldsBlock(), arms([{ key: 'a', weight: 34 }, { ...B, weight: 33 }, { key: 'c', weight: 33, override: { heading: 'C' } }])]))
check('arm keys must be a, b, c, d in order', has(PAGE, [fieldsBlock(), arms([A, { ...B, key: 'c' }])], /arm 1 must be keyed "b"/) && has(PAGE, [fieldsBlock(), arms([{ ...A, key: 'b' }, { ...B, key: 'a' }])], /arm 0 must be keyed "a"/))
check('weights must sum to 100', has(PAGE, [fieldsBlock(), arms([{ ...A, weight: 50 }, { ...B, weight: 40 }])], /sum to 100 \(they sum to 90\)/))
check('a weight below 10 is refused', has(PAGE, [fieldsBlock(), arms([{ ...A, weight: 95 }, { ...B, weight: 5 }])], /integer of at least 10/, '/blocks/1/props/arms/1/weight'))
check('a fractional or non-number weight is refused', has(PAGE, [fieldsBlock(), arms([{ ...A, weight: 50.5 }, { ...B, weight: 49.5 }])], /integer of at least 10/) && has(PAGE, [fieldsBlock(), arms([{ ...A, weight: '50' }, B])], /integer of at least 10/))
check('weights 10 and 90 pass (the minimum is inclusive)', ok(PAGE, [fieldsBlock(), arms([{ ...A, weight: 90 }, { ...B, weight: 10 }])]))
check('arm "a" never overrides', has(PAGE, [fieldsBlock(), arms([{ ...A, override: { heading: 'x' } }, B])], /control and never overrides/))
check('an arm with unknown keys is refused', has(PAGE, [fieldsBlock(), arms([A, { ...B, note: 'x' }])], /unknown key "note"/))

console.log('\n[validateItemContent: target "fields"]')
check('target "fields" needs a collection that declares fields', has(NOFIELDS, [{ type: 'hero', props: { heading: 'h' } }, exp()], /declares fields/))
check('a non-control arm needs a non-empty override', has(PAGE, [fieldsBlock(), arms([A, { key: 'b', weight: 50 }])], /needs an override object/) && has(PAGE, [fieldsBlock(), arms([A, { key: 'b', weight: 50, override: {} }])], /needs an override object/))
check('an override naming an undeclared field is refused', has(PAGE, [fieldsBlock(), arms([A, { ...B, override: { nope: 'x' } }])], /unknown field "nope"/, '/blocks/1/props/arms/1/override/nope'))
check('an override value of the wrong type is refused at its own path', issuesOf(PAGE, [fieldsBlock(), arms([A, { ...B, override: { count: 'many' } }])]).some((i) => i.path === '/blocks/1/props/arms/1/override/count'))
check('an override that blanks a required field is refused', issuesOf(PAGE, [fieldsBlock(), arms([A, { ...B, override: { heading: null } }])]).some((i) => i.path === '/blocks/1/props/arms/1/override/heading'))
check('a control value that is invalid is reported once, on the control, not blamed on the arm', (() => {
  const bad = issuesOf(PAGE, [fieldsBlock({ heading: 'ok', count: 'x' }), exp()])
  return bad.some((i) => i.path === '/blocks/0/props/count') && !bad.some((i) => i.path.startsWith('/blocks/1/props/arms'))
})())
check('"replace" on a fields experiment is refused', has(PAGE, [fieldsBlock(), arms([A, { key: 'b', weight: 50, override: { heading: 'x' }, replace: { type: 'hero' } }])], /"replace" is for a block target/))

console.log('\n[validateItemContent: target { block }]')
const HERO = { type: 'hero', props: { heading: 'Original', ctaLabel: 'Go' } }
const blockExp = (target, replace, over = {}) =>
  exp({ target, arms: [A, { key: 'b', weight: 50, replace }], ...over })
check('a block target with a same-type replacement passes', ok(PAGE, [fieldsBlock(), HERO, blockExp({ block: 1 }, { type: 'hero', props: { heading: 'Better' } })]), JSON.stringify(issuesOf(PAGE, [fieldsBlock(), HERO, blockExp({ block: 1 }, { type: 'hero', props: { heading: 'Better' } })])))
check('a block target in a fields-less collection passes (blocks[0] may be the tested block)', ok(NOFIELDS, [HERO, blockExp({ block: 0 }, { type: 'hero', props: { heading: 'Better' } })]))
check('a different type is refused', has(PAGE, [fieldsBlock(), HERO, blockExp({ block: 1 }, { type: 'cta', props: { heading: 'x', buttonLabel: 'b', buttonHref: '/' } })], /same type as the block under test/))
check('a replacement that fails validateBlock is refused', has(PAGE, [fieldsBlock(), HERO, blockExp({ block: 1 }, { type: 'hero', props: {} })], /heading/, '/blocks/2/props/arms/1/replace/props'))
check('target.block out of range is refused', has(PAGE, [fieldsBlock(), HERO, blockExp({ block: 9 }, { type: 'hero', props: { heading: 'x' } })], /does not name a block/))
check('target.block naming the fields block is refused', has(PAGE, [fieldsBlock(), HERO, blockExp({ block: 0 }, { type: 'hero', props: { heading: 'x' } })], /target it with "fields"/))
check('target.block naming the experiment itself is refused', has(PAGE, [fieldsBlock(), HERO, blockExp({ block: 2 }, { type: 'hero', props: { heading: 'x' } })], /cannot target itself/))
check('target.block must be a non-negative integer', has(PAGE, [fieldsBlock(), HERO, blockExp({ block: -1 }, { type: 'hero', props: { heading: 'x' } })], /target must be/) && has(PAGE, [fieldsBlock(), HERO, blockExp({ block: 1.5 }, { type: 'hero', props: { heading: 'x' } })], /target must be/))
check('an unknown target form is refused', has(PAGE, [fieldsBlock(), HERO, exp({ target: 'blocks' })], /target must be/))
check('a block experiment arm needs "replace"', has(PAGE, [fieldsBlock(), HERO, blockExp({ block: 1 }, undefined)], /needs a replace block/))
check('"override" on a block experiment is refused', has(PAGE, [fieldsBlock(), HERO, exp({ target: { block: 1 }, arms: [A, { key: 'b', weight: 50, override: { heading: 'x' }, replace: { type: 'hero', props: { heading: 'x' } } }] })], /"override" is for a "fields" target/))

console.log('\n[client editors: never]')
const before = [fieldsBlock(), HERO]
const withExp = [fieldsBlock(), HERO, exp()]
check('the structural rule still says a generic block is client-editable when the collection is', isClientEditable(PAGE, '/blocks/2/props/key') === true)
check('with the content, the experiment block is not editable at any pointer', isClientEditable(PAGE, '/blocks/2/props/key', [withExp]) === false && isClientEditable(PAGE, '/blocks/2', [withExp]) === false && isClientEditable(PAGE, '/blocks/2/props/arms/1/weight', [before, withExp]) === false)
check('a neighbouring block stays editable', isClientEditable(PAGE, '/blocks/1/props/heading', [withExp]) === true)
check('a client ADDING an experiment is refused', clientEditViolations(PAGE, { blocks: before, seo: {} }, { blocks: withExp, seo: {} }).length > 0 && clientEditViolations(PAGE, { blocks: before, seo: {} }, { blocks: withExp, seo: {} }).every((p) => p.startsWith('/blocks/2')))
check('a client REMOVING one is refused', clientEditViolations(PAGE, { blocks: withExp, seo: {} }, { blocks: before, seo: {} }).length > 0)
check('a client CHANGING one is refused, the weight edit is named', clientEditViolations(PAGE, { blocks: withExp, seo: {} }, { blocks: [fieldsBlock(), HERO, exp({ arms: [{ key: 'a', weight: 60 }, { ...B, weight: 40 }] })], seo: {} }).includes('/blocks/2/props/arms/0/weight'))
check('a client changing the control block next to it is still allowed by this rule', eq(clientEditViolations(PAGE, { blocks: withExp, seo: {} }, { blocks: [fieldsBlock(), { ...HERO, props: { heading: 'Edited' } }, exp()], seo: {} }), []))
check('a client CREATING an item with an experiment is refused', clientCreateViolations(PAGE, { blocks: withExp, seo: {} }).some((p) => p.startsWith('/blocks/2')))
check('a client creating an item without one is unaffected', eq(clientCreateViolations(PAGE, { blocks: [fieldsBlock({ heading: 'x' })], seo: {} }), []))

console.log('\n[the publish lock (pure)]')
const live = [fieldsBlock(), HERO, exp()]
check('an identical version is allowed (a republish)', eq(experimentLockViolations(live, clone(live)), []))
check('no experiment live: nothing locks', eq(experimentLockViolations([fieldsBlock(), HERO], [fieldsBlock({ heading: 'new' }), HERO, exp()]), []))
check('the stop (the block removed) is always allowed, even with the control changed', eq(experimentLockViolations(live, [fieldsBlock({ heading: 'Winner' }), HERO]), []))
check('the stop with the winner merged into fields is allowed', eq(experimentLockViolations(live, [fieldsBlock({ heading: 'Your next client is searching now', ctaLabel: 'Get a quote' }), HERO]), []))
check('changing a weight is refused', experimentLockViolations(live, [fieldsBlock(), HERO, exp({ arms: [{ key: 'a', weight: 60 }, { ...B, weight: 40 }] })]).some((v) => v.pointer === '/blocks/2/props' && /was changed/.test(v.reason)))
check('changing an arm override is refused', experimentLockViolations(live, [fieldsBlock(), HERO, exp({ arms: [A, { ...B, override: { heading: 'Different' } }] })]).length === 1)
check('changing the key, goal or enrolment is refused', [exp({ key: 'other-key' }), exp({ goal: { event: 'cta_click' } }), exp({ enrolment: 'all' })].every((e) => experimentLockViolations(live, [fieldsBlock(), HERO, e]).length === 1))
check('changing the CONTROL value the experiment overrides is refused, naming the field', eq(experimentLockViolations(live, [fieldsBlock({ heading: 'Changed', ctaLabel: 'Get a quote' }), HERO, exp()]).map((v) => v.pointer), ['/blocks/0/props/heading']))
check('adding a value for an overridden field that was unset is refused', experimentLockViolations([fieldsBlock({}), HERO, exp()], [fieldsBlock({ heading: 'Now set' }), HERO, exp()]).length === 1)
check('changing a field the experiment does NOT override is allowed', eq(experimentLockViolations(live, [fieldsBlock({ heading: 'Websites that win work', ctaLabel: 'A different label' }), HERO, exp()]), []))
check('changing other blocks, or the seo, is allowed', eq(experimentLockViolations(live, [fieldsBlock(), { ...HERO, props: { heading: 'Edited hero' } }, exp()]), []))
check('key order inside the experiment is not a change', eq(experimentLockViolations(live, [fieldsBlock(), HERO, { type: 'experiment', props: { arms: live[2].props.arms, goal: { match: { form_id: 'contact' }, event: 'lead_form_start' }, enrolment: 'consented', target: 'fields', key: 'home-hero-2026-11' } }]), []))
{
  const bl = [fieldsBlock(), HERO, blockExp({ block: 1 }, { type: 'hero', props: { heading: 'Better' } })]
  check('a block target: changing the control block is refused', eq(experimentLockViolations(bl, [fieldsBlock(), { ...HERO, props: { heading: 'Changed' } }, bl[2]]).map((v) => v.pointer), ['/blocks/1']))
  check('a block target: changing the fields block is allowed', eq(experimentLockViolations(bl, [fieldsBlock({ heading: 'Other' }), HERO, bl[2]]), []))
  check('a block target: the stop is allowed', eq(experimentLockViolations(bl, [fieldsBlock(), { ...HERO, props: { heading: 'Winner' } }]), []))
}
check('malformed input never throws', (() => { try { return experimentLockViolations(null, undefined).length === 0 && experimentLockViolations([{ type: 'experiment', props: 'x' }], [{ type: 'experiment' }]).length >= 0 } catch { return false } })())

console.log(`\n  M5-V5-a experiment suite: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
