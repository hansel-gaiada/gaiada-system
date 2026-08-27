/**
 * WSK-14 — the breaking-change ruleset (webdesk-design.md §05's versioning table), tested against
 * the table's OWN examples, verbatim, one check per named example. Pure unit coverage, no
 * database. Run with `node --import tsx test/wsk14-breaking-change.test.mjs`.
 */
import {
  classifyVocabularyChange,
  classifyTenantContractChange,
  classifyRendererChange,
  currentVocabularySnapshot,
  currentEnvelopeShapeSignature,
  bumpVersion,
  maxBump,
} from '../vocabulary/breaking-change.ts'

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

function clone(v) {
  return JSON.parse(JSON.stringify(v))
}

// =================================================================================================
// Axis 1 — Vocabulary semver (§05 row 1)
// =================================================================================================
const baseVocab = currentVocabularySnapshot()

{
  // MAJOR: "remove/rename a primitive"
  const after = clone(baseVocab)
  after.primitives = after.primitives.filter((p) => p !== 'geo')
  const r = classifyVocabularyChange(baseVocab, after)
  check('§05 example: removing a primitive -> vocabulary MAJOR', r.bump === 'major', JSON.stringify(r))
}
{
  // MAJOR: "remove/rename a block type"
  const after = clone(baseVocab)
  delete after.blocks.faq
  const r = classifyVocabularyChange(baseVocab, after)
  check('§05 example: removing a block type -> vocabulary MAJOR', r.bump === 'major', JSON.stringify(r))
}
{
  // MAJOR: "change a block's props non-additively" — narrow an existing REQUIRED field's primitive
  const after = clone(baseVocab)
  after.blocks.hero.fields = after.blocks.hero.fields.map((f) => (f.name === 'heading' ? { ...f, primitive: 'select', options: ['a'] } : f))
  const r = classifyVocabularyChange(baseVocab, after)
  check('§05 example: a block\'s props changed non-additively -> vocabulary MAJOR', r.bump === 'major', JSON.stringify(r))
}
{
  // MAJOR: "any envelope shape change" — even an ADDITIVE one (hard rule 1: no mutation, ever)
  const after = clone(baseVocab)
  after.envelopeShape = [...after.envelopeShape, 'item.newField'].sort()
  const r = classifyVocabularyChange(baseVocab, after)
  check(
    '§05 hard rule 1: an ADDITIVE envelope change is STILL vocabulary MAJOR (envelope evolution is /v2, never a mutation)',
    r.bump === 'major' && r.reasons.some((x) => x.includes('envelope shape changed')),
    JSON.stringify(r),
  )
}
{
  // MINOR: "new block type"
  const after = clone(baseVocab)
  after.blocks.pricingTable = { fields: [{ name: 'heading', primitive: 'text' }] }
  const r = classifyVocabularyChange(baseVocab, after)
  check('§05 example: a new block type -> vocabulary MINOR', r.bump === 'minor', JSON.stringify(r))
}
{
  // MINOR: "new optional prop on an existing block"
  const after = clone(baseVocab)
  after.blocks.hero.fields = [...after.blocks.hero.fields, { name: 'badge', primitive: 'text' }]
  const r = classifyVocabularyChange(baseVocab, after)
  check('§05 example: a new optional prop on an existing block -> vocabulary MINOR', r.bump === 'minor', JSON.stringify(r))
}
{
  // MINOR: "new primitive"
  const after = clone(baseVocab)
  after.primitives = [...after.primitives, 'boolean']
  const r = classifyVocabularyChange(baseVocab, after)
  check('§05 example: a new primitive -> vocabulary MINOR', r.bump === 'minor', JSON.stringify(r))
}
{
  // PATCH: "docs/descriptions" — literally no structural change
  const after = clone(baseVocab)
  const r = classifyVocabularyChange(baseVocab, after)
  check('§05 example: no structural change (docs-only) -> vocabulary PATCH', r.bump === 'patch', JSON.stringify(r))
}
{
  // The real, currently-shipped envelope shape signature is non-empty and stable across two calls
  // (a determinism sanity check on the reflection helper itself).
  const a = currentEnvelopeShapeSignature()
  const b = currentEnvelopeShapeSignature()
  check('currentEnvelopeShapeSignature() is deterministic', JSON.stringify(a) === JSON.stringify(b) && a.length > 0, a.length)
  check('the real envelope signature includes the frozen top-level item keys', a.includes('item.collection') && a.includes('item.blocks') && a.includes('item.meta.x'), JSON.stringify(a))
  check('the real envelope signature does NOT descend into seo (free-form jsonb)', !a.some((p) => p.startsWith('item.seo.')), JSON.stringify(a))
}

// =================================================================================================
// Axis 2 — Tenant contract semver (§05 row 2) — every example the ticket names, verbatim
// =================================================================================================
function tenantSnapshot(collections) {
  return { collections }
}

{
  // MAJOR: "remove ... a collection"
  const before = tenantSnapshot({ 'case-study': { fields: [] }, post: { fields: [] } })
  const after = tenantSnapshot({ 'case-study': { fields: [] } })
  const r = classifyTenantContractChange(before, after)
  check('§05 example: removing a collection -> tenant contract MAJOR', r.bump === 'major', JSON.stringify(r))
}
{
  // MAJOR: "rename ... a collection" — a rename is indistinguishable from remove+add by
  // structural diff, and IS correctly MAJOR either way because the removal alone forces it,
  // regardless of what else the same change also adds.
  const before = tenantSnapshot({ 'case-study': { fields: [] } })
  const after = tenantSnapshot({ 'success-story': { fields: [] } })
  const r = classifyTenantContractChange(before, after)
  check('§05 example: renaming a collection -> tenant contract MAJOR', r.bump === 'major', JSON.stringify(r))
}
{
  // MAJOR: "remove ... a field"
  const before = tenantSnapshot({ post: { fields: [{ name: 'subtitle', primitive: 'text' }] } })
  const after = tenantSnapshot({ post: { fields: [] } })
  const r = classifyTenantContractChange(before, after)
  check('§05 example: removing a field -> tenant contract MAJOR', r.bump === 'major', JSON.stringify(r))
}
{
  // MAJOR: "rename ... a field" (same remove+add reasoning as the collection case)
  const before = tenantSnapshot({ post: { fields: [{ name: 'subtitle', primitive: 'text' }] } })
  const after = tenantSnapshot({ post: { fields: [{ name: 'tagline', primitive: 'text' }] } })
  const r = classifyTenantContractChange(before, after)
  check('§05 example: renaming a field -> tenant contract MAJOR', r.bump === 'major', JSON.stringify(r))
}
{
  // MAJOR: "narrow a type"
  const before = tenantSnapshot({ post: { fields: [{ name: 'rating', primitive: 'number' }] } })
  const after = tenantSnapshot({ post: { fields: [{ name: 'rating', primitive: 'select', options: ['1', '2', '3'] }] } })
  const r = classifyTenantContractChange(before, after)
  check('§05 example: narrowing a type -> tenant contract MAJOR', r.bump === 'major', JSON.stringify(r))
}
{
  // MAJOR: "narrow a type" — the select-options special case (interpretation, flagged in report)
  const before = tenantSnapshot({ post: { fields: [{ name: 'tier', primitive: 'select', options: ['gold', 'silver', 'bronze'] }] } })
  const after = tenantSnapshot({ post: { fields: [{ name: 'tier', primitive: 'select', options: ['gold', 'silver'] }] } })
  const r = classifyTenantContractChange(before, after)
  check('narrowing a select field\'s option set -> tenant contract MAJOR', r.bump === 'major', JSON.stringify(r))
}
{
  // MAJOR: "flip optional->required"
  const before = tenantSnapshot({ post: { fields: [{ name: 'excerpt', primitive: 'text', required: false }] } })
  const after = tenantSnapshot({ post: { fields: [{ name: 'excerpt', primitive: 'text', required: true }] } })
  const r = classifyTenantContractChange(before, after)
  check('§05 example: flipping optional -> required -> tenant contract MAJOR', r.bump === 'major', JSON.stringify(r))
}
{
  // MAJOR: "a vocabulary MAJOR reaching a block the tenant uses"
  const before = tenantSnapshot({ 'case-study': { fields: [], blocks: ['hero', 'faq'] } })
  const after = tenantSnapshot({ 'case-study': { fields: [], blocks: ['hero', 'faq'] } })
  const r = classifyTenantContractChange(before, after, { bump: 'major', affectedBlockTypes: ['faq'] })
  check(
    '§05 example: a vocabulary MAJOR reaching a block the tenant uses -> tenant contract MAJOR',
    r.bump === 'major' && r.reasons.some((x) => x.includes('faq')),
    JSON.stringify(r),
  )
}
{
  // The converse, proving the usage-gate is real: a vocabulary MAJOR that does NOT touch any
  // block this tenant uses must NOT propagate as MAJOR (nothing else changed either).
  const before = tenantSnapshot({ 'case-study': { fields: [], blocks: ['hero'] } })
  const after = tenantSnapshot({ 'case-study': { fields: [], blocks: ['hero'] } })
  const r = classifyTenantContractChange(before, after, { bump: 'major', affectedBlockTypes: ['faq'] })
  check(
    'a vocabulary MAJOR that touches a block this tenant does NOT use does not propagate as MAJOR',
    r.bump === 'patch',
    JSON.stringify(r),
  )
}
{
  // MINOR: "add a collection"
  const before = tenantSnapshot({ post: { fields: [] } })
  const after = tenantSnapshot({ post: { fields: [] }, event: { fields: [] } })
  const r = classifyTenantContractChange(before, after)
  check('§05 example: adding a collection -> tenant contract MINOR', r.bump === 'minor', JSON.stringify(r))
}
{
  // MINOR: "add ... a field"
  const before = tenantSnapshot({ post: { fields: [] } })
  const after = tenantSnapshot({ post: { fields: [{ name: 'byline', primitive: 'text' }] } })
  const r = classifyTenantContractChange(before, after)
  check('§05 example: adding an optional field -> tenant contract MINOR', r.bump === 'minor', JSON.stringify(r))
}
{
  // MINOR: "add ... an optional prop" (explicit ticket wording)
  const before = tenantSnapshot({ post: { fields: [{ name: 'title', primitive: 'text', required: true }] } })
  const after = tenantSnapshot({ post: { fields: [{ name: 'title', primitive: 'text', required: true }, { name: 'subtitle', primitive: 'text' }] } })
  const r = classifyTenantContractChange(before, after)
  check('§05 ticket example: add an optional prop -> tenant contract MINOR', r.bump === 'minor', JSON.stringify(r))
}
{
  // MINOR: "vocabulary MINOR" — unconditional, no usage qualifier
  const before = tenantSnapshot({ post: { fields: [] } })
  const after = tenantSnapshot({ post: { fields: [] } })
  const r = classifyTenantContractChange(before, after, { bump: 'minor' })
  check(
    '§05 example: a vocabulary MINOR reaching a tenant -> tenant contract MINOR (unconditional, unlike the MAJOR case)',
    r.bump === 'minor',
    JSON.stringify(r),
  )
}
{
  // PATCH: "descriptive only" — no structural change at all
  const before = tenantSnapshot({ post: { fields: [{ name: 'title', primitive: 'text', required: true }] } })
  const after = tenantSnapshot({ post: { fields: [{ name: 'title', primitive: 'text', required: true }] } })
  const r = classifyTenantContractChange(before, after)
  check('§05 example: no structural change -> tenant contract PATCH', r.bump === 'patch', JSON.stringify(r))
}

// =================================================================================================
// Axis 3 — Block-renderer library semver (§05 row 3)
// =================================================================================================
{
  const r = classifyRendererChange({ breakingMarkupChanges: ['hero'] })
  check('§05 example: a markup contract change that breaks styling/slots -> renderer MAJOR', r.bump === 'major', JSON.stringify(r))
}
{
  const r = classifyRendererChange({ addedComponents: ['pricingTable'] })
  check('§05 example: new block components -> renderer MINOR', r.bump === 'minor', JSON.stringify(r))
}
{
  const r = classifyRendererChange({ fixes: ['gallery lightbox z-index'] })
  check('§05 example: fixes -> renderer PATCH', r.bump === 'patch', JSON.stringify(r))
}
{
  const r = classifyRendererChange({})
  check('an empty renderer diff -> PATCH (nothing changed)', r.bump === 'patch', JSON.stringify(r))
}

// =================================================================================================
// Small helpers
// =================================================================================================
check('bumpVersion major', bumpVersion('1.4.2', 'major') === '2.0.0')
check('bumpVersion minor', bumpVersion('1.4.2', 'minor') === '1.5.0')
check('bumpVersion patch', bumpVersion('1.4.2', 'patch') === '1.4.3')
check('maxBump picks the highest severity present', maxBump('patch', 'minor', 'patch') === 'minor')
check('maxBump of nothing is patch (the floor)', maxBump() === 'patch')

console.log(`\n  WSK-14 breaking-change ruleset suite: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
