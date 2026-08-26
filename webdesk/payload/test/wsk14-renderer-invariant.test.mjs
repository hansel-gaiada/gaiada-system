/**
 * WSK-14 item 4 — "the renderer invariant, asserted": an unknown block type must validate as
 * KNOWN-UNKNOWN (`valid:true, unknownType:true`), never a hard failure, so additive vocabulary
 * changes (a future MINOR that ships a 10th block type) can flow to a site pinned to an older
 * renderer without crashing it. The invariant itself was implemented by WSK-06 (`blocks.ts`'s
 * `validateBlock`) — this file's only job is proving it with fixtures representative of the
 * scenario the design describes (§05 hard rule 2), not re-implementing it.
 *
 * Pure unit coverage, no database. Run with
 * `node --import tsx test/wsk14-renderer-invariant.test.mjs`.
 */
import { validateBlock, BLOCK_TYPE_NAMES } from '../vocabulary/blocks.ts'

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
// Fixture: a content_items.blocks entry as it would arrive from a FUTURE vocabulary MINOR (a 10th
// block type, admitted after this site's renderer was built and pinned) — the exact scenario §05
// hard rule 2 exists for: "vocabulary-MINOR content can flow to a site pinned to an older renderer
// without crashing it."
// =================================================================================================
const futureBlockFixture = {
  type: 'pricingTable', // does not exist in the 9 known types today
  props: { tiers: [{ name: 'Pro', price: 49 }] },
}

{
  const result = validateBlock(futureBlockFixture)
  check('a future/unknown block type is valid:true (never a hard validation failure)', result.valid === true, JSON.stringify(result))
  check('a future/unknown block type is flagged unknownType:true (the renderer\'s render-nothing-and-report signal)', result.unknownType === true, JSON.stringify(result))
  check('no errors are produced for an unknown type (there is nothing to validate it against)', result.errors.length === 0, JSON.stringify(result))
}

// =================================================================================================
// Contrast fixture: a KNOWN type with malformed props is STILL a real validation error — the
// invariant only protects UNKNOWN types, never known ones with bad data.
// =================================================================================================
{
  const result = validateBlock({ type: 'hero', props: {} }) // missing required "heading"
  check('a KNOWN type with malformed props is a REAL failure (the invariant does not blanket-suppress errors)', result.valid === false && result.unknownType === false, JSON.stringify(result))
}

// =================================================================================================
// Fixture: a whole envelope's `blocks` array mixing a known block and a from-the-future unknown
// one — the realistic shape a renderer actually receives over `/v1` once a MINOR has shipped
// server-side ahead of this site's pinned renderer version.
// =================================================================================================
{
  const blocksFromServer = [
    { type: 'hero', props: { heading: 'Welcome' } },
    { type: 'pricingTable', props: { tiers: [] } }, // from a vocabulary MINOR this renderer predates
    { type: 'richText', props: { content: 'body copy' } },
  ]
  const results = blocksFromServer.map((b) => validateBlock(b))
  check('every block in a mixed known/unknown array validates without throwing', results.every((r) => typeof r.valid === 'boolean'))
  check('the known blocks in the mix are valid AND not flagged unknown', results[0].valid && !results[0].unknownType && results[2].valid && !results[2].unknownType)
  check(
    'the unknown block in the mix is valid:true, unknownType:true — an OLDER renderer can render the two it knows and skip/report the third, never crash the page',
    results[1].valid === true && results[1].unknownType === true,
    JSON.stringify(results[1]),
  )
  // What an actual renderer library (WSK-16) is contracted to do with this signal is "render
  // nothing + report" — simulated here as the minimal reference behavior a renderer must exhibit,
  // proving the signal alone is sufficient to implement that contract without any additional
  // information from the vocabulary package.
  const rendered = blocksFromServer.map((b, i) => (results[i].unknownType ? null : `<${b.type}/>`))
  check(
    'reference renderer behavior driven ONLY by the unknownType signal renders nothing for the unknown block and something for the known ones',
    rendered[0] === '<hero/>' && rendered[1] === null && rendered[2] === '<richText/>',
    JSON.stringify(rendered),
  )
}

// =================================================================================================
// Every REAL block type validates as known (sanity: the invariant is about the OTHER 9+1 case,
// not a loophole that accidentally also swallows real ones).
// =================================================================================================
for (const type of BLOCK_TYPE_NAMES) {
  const result = validateBlock({ type, props: {} })
  check(`known block type "${type}" is never flagged unknownType (props may still be invalid, but the TYPE is recognized)`, result.unknownType === false, JSON.stringify(result))
}

console.log(`\n  WSK-14 renderer-invariant fixture suite: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
