#!/usr/bin/env node
/**
 * webdesk/sites/wsk17-proof/scripts/conformance-runtime.mjs
 *
 * WSK-17 -- the RUNTIME half of the generated conformance test (design §06: "runtime probe: each
 * referenced collection returns the /v1 envelope against the target env"). Uses the exact SAME
 * typed client the site pages use (src/lib/client.ts, openapi-fetch parameterised by the
 * generated sdk.d.ts `paths`) against the LIVE dev stack this site was just built against --
 * proves the generated SDK's types actually describe what the live server returns, not just what
 * the OpenAPI document claims.
 *
 * Exit 0 = every check passed. Exit 1 = at least one failed (see the printed detail).
 * Run: WEBDESK_V1_BASE_URL=... WEBDESK_API_KEY=... node scripts/conformance-runtime.mjs
 */
import { client } from '../src/lib/client.ts'
import { TENANT_SLUG, COLLECTION_KEY } from '../src/lib/site-tenant.ts'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name} -- ${detail ?? ''}`) }
}

async function main() {
  // 1) list endpoint -- the frozen ListEnvelope shape, real page info.
  const list = await client.GET(`/v1/t/${TENANT_SLUG}/${COLLECTION_KEY}`, { params: { query: {} } })
  check('list: no transport error', !list.error, JSON.stringify(list.error))
  if (list.data) {
    check('list: collection matches', list.data.collection === COLLECTION_KEY, list.data.collection)
    check('list: page shape present', typeof list.data.page?.limit === 'number' && 'hasMore' in list.data.page)
    check('list: exactly the 2 published items (draft excluded)', list.data.items.length === 2, `got ${list.data.items.length}`)
    check('list: blocks stripped by default (no ?expand=blocks)', list.data.items.every((i) => i.blocks.length === 0))
  }

  // 2) item endpoint, real content, full 9-block envelope -- proves DB -> /v1 -> typed client is
  // a real chain, not a fixture: asserts a distinctive string this repo's fixture files never
  // contain (only scripts/seed-tenant.mjs wrote it).
  const item = await client.GET(`/v1/t/${TENANT_SLUG}/${COLLECTION_KEY}/{slug}`, {
    params: { path: { slug: 'acme-rebrand' }, query: {} },
  })
  check('item(acme-rebrand): no transport error', !item.error, JSON.stringify(item.error))
  if (item.data) {
    check('item: real seeded heading present', item.data.blocks[0]?.props?.heading === 'Acme rebrands for the AI era')
    check('item: all 9 block types present, in order', JSON.stringify(item.data.blocks.map((b) => b.type)) ===
      JSON.stringify(['hero', 'richText', 'gallery', 'cta', 'featureGrid', 'form', 'testimonial', 'faq', 'logoCloud']))
    check('item: draft is false (effectively published)', item.data.meta.draft === false)
  }

  // 3) the draft item is genuinely invisible through this production-scope key -- the effective-
  // publish rule (content-read.ts), proven against a live server, not just asserted.
  const draft = await client.GET(`/v1/t/${TENANT_SLUG}/${COLLECTION_KEY}/{slug}`, {
    params: { path: { slug: 'unpublished-draft' }, query: {} },
  })
  check('draft item: 404, not visible through a production key', draft.response.status === 404, draft.response.status)
  check('draft item: RFC 9457 problem shape on the 404', typeof draft.error?.type === 'string' && typeof draft.error?.requestId === 'string')

  // 4) second item -- proves the site isn't reading one hardcoded row.
  const item2 = await client.GET(`/v1/t/${TENANT_SLUG}/${COLLECTION_KEY}/{slug}`, {
    params: { path: { slug: 'globex-launch' }, query: {} },
  })
  check('item(globex-launch): real distinct content', item2.data?.blocks[0]?.props?.heading === 'Globex goes live on WebDesk')

  console.log(`\n[wsk17-proof:conformance-runtime] ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[wsk17-proof:conformance-runtime] ERROR', err)
  process.exit(2)
})
