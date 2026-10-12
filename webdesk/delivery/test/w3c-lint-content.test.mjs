/**
 * M5-W3c — vocabulary 1.3.0 (MINOR): `lint.content`, the per-collection settings of the advisory content checks.
 * Pure unit coverage, no database.
 *
 *   node --import tsx test/w3c-lint-content.test.mjs        (cwd webdesk/api, like the other vocabulary suites)
 *
 * Covers: the validator closes the new member; the classifier COMPUTES 1.2.0 -> current as MINOR from the committed
 * 1.2.0 snapshot (the `lint` key set is a snapshot dimension since 1.3.0: the 1.2.0 classifier would have rated
 * this PATCH); a removed lint key is MAJOR; a tenant's lint.content edit is PATCH; a snapshot without `lintKeys`
 * is refused loudly.
 */
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { validateCollectionComposition, isVocabularyVersionSupported, LINT_KEYS, CONTENT_LINT_RULE_IDS } from '../vocabulary/composition.ts'
import { bumpVersion, classifyVocabularyChange, classifyTenantContractChange, currentVocabularySnapshot } from '../vocabulary/breaking-change.ts'
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

console.log('\n[validator]')
const v = (content) => validateCollectionComposition('c', { fields: [{ name: 'h1', primitive: 'text' }], lint: { content } })
check('lint.content is accepted (empty, and with a rule setting)', v({}).valid && v({ rules: { meta: { titleMax: 70 } } }).valid)
check('LINT_KEYS carries content and placeholders', eq([...LINT_KEYS].sort(), ['content', 'placeholders']))
check('an unknown lint key is still refused', validateCollectionComposition('c', { lint: { nope: 1 } }).issues.some((i) => i.path === 'c.lint.nope'))
check('an unknown rule id is refused', v({ rules: { nope: {} } }).issues.some((i) => i.path === 'c.lint.content.rules.nope'))
check('an unknown knob is refused', v({ rules: { meta: { nope: 1 } } }).issues.some((i) => i.path === 'c.lint.content.rules.meta.nope'))
check('an out-of-range value is refused', v({ rules: { meta: { titleMax: 0 } } }).issues.some((i) => i.path === 'c.lint.content.rules.meta.titleMax'))
check('a non-object lint.content is refused', !v('x').valid)
check('the rule ids are the eleven documented ones', CONTENT_LINT_RULE_IDS.length === 11, CONTENT_LINT_RULE_IDS.join(','))
check('a composition authored against 1.2.0 is still accepted (a MINOR is a superset); 1.5.0 is refused', isVocabularyVersionSupported('1.2.0') && isVocabularyVersionSupported('1.3.0') && !isVocabularyVersionSupported('1.5.0'))

console.log('\n[classifier]')
const v120 = load(path.join(HERE, 'fixtures', 'vocabulary-1.2.0.snapshot.json'))
// M5-W8b moved the vocabulary on to 1.4.0, so the 1.3.0 release is rated against ITS OWN committed capture.
const current = load(path.join(HERE, 'fixtures', 'vocabulary-1.3.0.snapshot.json'))
check('the 1.3.0 fixture is the 1.3.0 snapshot', current.vocabularyVersion === '1.3.0', current.vocabularyVersion)
check('the fixture is the 1.2.0 snapshot', v120.vocabularyVersion === '1.2.0' && eq(v120.lintKeys, ['placeholders']), JSON.stringify(v120.lintKeys))
const rated = classifyVocabularyChange(v120, current)
console.log(JSON.stringify(rated, null, 2).replace(/^/gm, '      '))
check('classifyVocabularyChange(1.2.0 snapshot, current) === "minor"', rated.bump === 'minor', JSON.stringify(rated))
check('the reason is exactly the one new lint key, nothing else', eq(rated.reasons, ['composition lint key "content" added (new optional key)']), JSON.stringify(rated.reasons))
check('the computed bump applied to 1.2.0 IS the shipped version', bumpVersion('1.2.0', rated.bump) === current.vocabularyVersion, bumpVersion('1.2.0', rated.bump))
check('the 1.3.0 snapshot carries the lintKeys dimension', eq(current.lintKeys, ['content', 'placeholders']), JSON.stringify(current.lintKeys))
{
  const after = clone(current)
  after.lintKeys = after.lintKeys.filter((k) => k !== 'placeholders')
  check('removing a lint key is MAJOR', classifyVocabularyChange(current, after).bump === 'major')
  const legacy = clone(v120)
  delete legacy.lintKeys
  let threw = null
  try {
    classifyVocabularyChange(legacy, current)
  } catch (e) {
    threw = e
  }
  check('a snapshot with a `lint` key but WITHOUT lintKeys is refused loudly, never compared blind', threw && /lintKeys/.test(threw.message), String(threw))
}
check('1.1.0 -> current is still MINOR', classifyVocabularyChange(load(path.join(HERE, 'fixtures', 'vocabulary-1.1.0.snapshot.json')), current).bump === 'minor')
check('the envelope did not change by a byte', eq(current.envelopeShape, v120.envelopeShape))

console.log('\n[tenant contract: a lint.content edit is advisory]')
{
  const T = (lint) => ({ collections: { n: { fields: [], ...(lint ? { lint } : {}) } } })
  const r = classifyTenantContractChange(T(), T({ content: { rules: { meta: { titleMax: 70 } } } }))
  check('adding / editing lint.content inside a tenant contract is PATCH', r.bump === 'patch' && r.reasons.length === 1 && r.reasons[0].includes('lint changed'), JSON.stringify(r))
}

console.log(`\n  M5-W3c lint.content suite: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
