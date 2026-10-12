/**
 * M5-W8b — vocabulary 1.4.0 (MINOR): `ui.routePattern`, the public page path pattern of a collection's items.
 * Pure unit coverage, no database.
 *
 *   node --import tsx test/w8b-route-pattern.test.mjs        (cwd webdesk/api, like the other vocabulary suites)
 *
 * Covers: the validator closes the grammar; `pagePathFor` applies it; the classifier COMPUTES 1.3.0 -> current as
 * MINOR from the committed 1.3.0 snapshot (a new collection-`ui` key); a removed key is MAJOR; a tenant's
 * routePattern VALUE edit is PATCH.
 */
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import {
  validateCollectionComposition,
  isVocabularyVersionSupported,
  COLLECTION_UI_KEYS,
  routePatternProblem,
  pagePathFor,
} from '../vocabulary/composition.ts'
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
const v = (routePattern) => validateCollectionComposition('c', { fields: [{ name: 'h1', primitive: 'text' }], ui: { label: 'Posts', routePattern } })
const okPatterns = ['/blog/{slug}/', '/blog/{slug}', '/{locale}/insights/{slug}/', '/{slug}/', '/a-b/c-9/{slug}/', '/{locale}/{slug}']
for (const p of okPatterns) check(`accepted: ${p}`, v(p).valid, JSON.stringify(v(p).issues))
const bad = [
  ['', 'empty'],
  ['blog/{slug}/', 'no leading slash'],
  ['/blog/', 'no {slug}'],
  ['/', 'no {slug}, root'],
  ['/{slug}/{slug}/', 'two {slug}'],
  ['/{locale}/{locale}/{slug}/', 'two {locale}'],
  ['/blog/{slug}/?x=1', 'query'],
  ['/blog/{slug}/#a', 'fragment'],
  ['/blog/../{slug}/', 'dot-dot'],
  ['/blog//{slug}/', 'empty segment'],
  ['/Blog/{slug}/', 'uppercase'],
  ['/blog/{id}/', 'unknown token'],
  ['/blog/post-{slug}/', 'token inside a segment'],
  ['/blog/{slug}.html', 'dot'],
  ['/b l/{slug}/', 'space'],
  ['/' + 'a'.repeat(200) + '/{slug}/', 'over 200 chars'],
  [42, 'not a string'],
  [null, 'null'],
]
for (const [p, why] of bad) {
  const r = v(p)
  check(`refused (${why}): ${JSON.stringify(p)}`, !r.valid && r.issues.some((i) => i.path === 'c.ui.routePattern'), JSON.stringify(r.issues))
}
const edge = '/' + 'a'.repeat(190) + '/{slug}'
check('a pattern of up to 200 chars is accepted', edge.length <= 200 && v(edge).valid)
check('routePattern is optional', validateCollectionComposition('c', { ui: { label: 'Posts' } }).valid)
check('COLLECTION_UI_KEYS carries routePattern', COLLECTION_UI_KEYS.includes('routePattern'))
check('an unknown ui key is still refused', validateCollectionComposition('c', { ui: { label: 'x', nope: 1 } }).issues.some((i) => i.path === 'c.ui.nope'))
check('routePatternProblem is null for a good one', routePatternProblem('/blog/{slug}/') === null)
check('a composition authored against 1.3.0 is still accepted; 1.5.0 is refused', isVocabularyVersionSupported('1.3.0') && isVocabularyVersionSupported('1.4.0') && !isVocabularyVersionSupported('1.5.0'))

console.log('\n[pagePathFor]')
const A = { slug: 'my-post', locale: 'en', defaultLocale: 'en' }
check('plain', pagePathFor('/blog/{slug}/', A) === '/blog/my-post/', pagePathFor('/blog/{slug}/', A))
check('no trailing slash stays off', pagePathFor('/blog/{slug}', A) === '/blog/my-post')
check('default locale drops the {locale} segment', pagePathFor('/{locale}/insights/{slug}/', A) === '/insights/my-post/', pagePathFor('/{locale}/insights/{slug}/', A))
check('another locale fills it', pagePathFor('/{locale}/insights/{slug}/', { ...A, locale: 'id' }) === '/id/insights/my-post/')
check('locale with region', pagePathFor('/{locale}/{slug}/', { ...A, locale: 'pt-BR' }) === '/pt-BR/my-post/')
check('a pattern without {locale} serves every language at the one address', pagePathFor('/blog/{slug}/', { ...A, locale: 'id' }) === '/blog/my-post/')
check('{locale} first and default drops it, leaving the slug at the root', pagePathFor('/{locale}/{slug}/', A) === '/my-post/')
check('an invalid pattern gives null', pagePathFor('/blog/', A) === null && pagePathFor(undefined, A) === null && pagePathFor('/Blog/{slug}/', A) === null)
check('a slug that cannot be a URL segment gives null', pagePathFor('/blog/{slug}/', { ...A, slug: 'a/b' }) === null && pagePathFor('/blog/{slug}/', { ...A, slug: '' }) === null && pagePathFor('/blog/{slug}/', { ...A, slug: '../x' }) === null)
check('a locale that cannot be a URL segment gives null', pagePathFor('/{locale}/{slug}/', { ...A, locale: 'x/y' }) === null)

console.log('\n[classifier]')
const v130 = load(path.join(HERE, 'fixtures', 'vocabulary-1.3.0.snapshot.json'))
const current = currentVocabularySnapshot()
check('the fixture is the 1.3.0 snapshot', v130.vocabularyVersion === '1.3.0' && !v130.collectionUiKeys.includes('routePattern'), JSON.stringify(v130.collectionUiKeys))
const rated = classifyVocabularyChange(v130, current)
console.log(JSON.stringify(rated, null, 2).replace(/^/gm, '      '))
check('classifyVocabularyChange(1.3.0 snapshot, current) === "minor"', rated.bump === 'minor', JSON.stringify(rated))
check('the reason is exactly the one new collection ui key', eq(rated.reasons, ['collection ui key "routePattern" added (new optional key)']), JSON.stringify(rated.reasons))
check('the computed bump applied to 1.3.0 IS the shipped version', bumpVersion('1.3.0', rated.bump) === VOCABULARY_VERSION, bumpVersion('1.3.0', rated.bump))
check('the current snapshot carries routePattern', current.collectionUiKeys.includes('routePattern'), JSON.stringify(current.collectionUiKeys))
check('the envelope did not change by a byte', eq(current.envelopeShape, v130.envelopeShape))
{
  const after = clone(current)
  after.collectionUiKeys = after.collectionUiKeys.filter((k) => k !== 'routePattern')
  check('removing the key is MAJOR', classifyVocabularyChange(current, after).bump === 'major')
}

console.log('\n[tenant contract: a routePattern edit is editor metadata]')
{
  const T = (p) => ({ collections: { n: { fields: [], ui: { label: 'N', ...(p ? { routePattern: p } : {}) } } } })
  const r = classifyTenantContractChange(T('/blog/{slug}/'), T('/news/{slug}/'))
  check('changing routePattern inside a tenant contract is PATCH', r.bump === 'patch', JSON.stringify(r))
}

console.log(`\n  M5-W8b routePattern suite: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
