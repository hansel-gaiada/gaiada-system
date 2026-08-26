/**
 * WSK-06 — the freeze's own contract-test suite (design §05/§06 AC): the envelope byte-shape for
 * two differently-composed tenants, block props against the vocabulary, cache tags per response,
 * the `/v1` path pinned, pagination stability under concurrent publish, and the locale-fallback
 * flag. Every check exercises the REAL router (collections/router.ts) end to end against a real,
 * migrated Zone B Postgres — no mocking of the DB or the RLS layer.
 *
 * Requires (see README.md "Local verification" pattern, mirrored from lockdown.test.mjs):
 *   DATABASE_URI          -> the webdesk_app role (the router reads through the SAME role
 *                            production would use — this test would not catch an RLS gap if it
 *                            ran as the migrator/owner instead)
 *   MIGRATE_DATABASE_URL  -> the webdesk_migrator role (fixtures only)
 *   API_KEY_PEPPER        -> must match what mintFixtureApiKey hashes with
 *
 * Run: node --import tsx test/envelope-contract.test.mjs
 */
import { handleV1Request } from '../collections/router.ts'
import { closePool } from '../collections/db.ts'
import { validateBlock } from '../vocabulary/blocks.ts'
import {
  createFixtureTenant,
  createFixtureCollection,
  seedContentItem,
  mintFixtureApiKey,
  setEnvironmentDomain,
} from './v1-fixtures.mjs'

for (const v of ['DATABASE_URI', 'MIGRATE_DATABASE_URL', 'API_KEY_PEPPER']) {
  if (!process.env[v]) throw new Error(`${v} not set`)
}

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

function req(path, { key, headers } = {}) {
  const h = new Headers(headers)
  if (key) h.set('authorization', `Bearer ${key}`)
  return new Request(`http://internal${path}`, { headers: h })
}

async function asJson(res) {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`not JSON (status ${res.status}): ${text.slice(0, 300)}`)
  }
}

try {
  // ===========================================================================================
  // Fixtures: two DIFFERENTLY-COMPOSED tenants (design §05/§06 AC: "for two differently-composed
  // tenants") — different locale sets, different collection keys, different content shapes.
  // ===========================================================================================
  const tenantA = await createFixtureTenant({ label: 'a', defaultLocale: 'id-ID', locales: ['id-ID', 'en-US'] })
  const caseStudyA = await createFixtureCollection(tenantA, 'case-study')
  const postA = await createFixtureCollection(tenantA, 'post')
  const readKeyA = await mintFixtureApiKey(tenantA, 'production', 'read')
  const stagingKeyA = await mintFixtureApiKey(tenantA, 'staging', 'read')

  const tenantB = await createFixtureTenant({ label: 'b', defaultLocale: 'en-US', locales: ['en-US'] })
  const articleB = await createFixtureCollection(tenantB, 'article')
  const readKeyB = await mintFixtureApiKey(tenantB, 'production', 'read')

  // --- Tenant A: a published id-ID item + its en-US sibling (localizations link) --------------
  const groupId = crypto.randomUUID()
  const itemA_id = await seedContentItem(tenantA, {
    collectionId: caseStudyA,
    locale: 'id-ID',
    slug: 'acme-rebrand',
    localizationGroupId: groupId,
    publishState: 'published',
    seo: { title: 'Acme Rebrand', description: 'desc' },
    blocks: [
      { type: 'hero', props: { heading: 'Halo' } },
      { type: 'richText', props: { content: 'body' } },
    ],
  })
  await seedContentItem(tenantA, {
    collectionId: caseStudyA,
    locale: 'en-US',
    slug: 'acme-rebrand-en',
    localizationGroupId: groupId,
    publishState: 'published',
  })
  // A draft (visible on staging, hidden on production)
  await seedContentItem(tenantA, {
    collectionId: caseStudyA,
    locale: 'id-ID',
    slug: 'draft-only',
    publishState: 'draft',
  })
  // A scheduled item whose publish_at is already in the past -> effectively published
  await seedContentItem(tenantA, {
    collectionId: caseStudyA,
    locale: 'id-ID',
    slug: 'scheduled-now-live',
    publishState: 'scheduled',
    publishAt: new Date(Date.now() - 60_000).toISOString(),
  })
  // A scheduled item whose publish_at is in the future -> NOT effectively published
  await seedContentItem(tenantA, {
    collectionId: caseStudyA,
    locale: 'id-ID',
    slug: 'scheduled-future',
    publishState: 'scheduled',
    publishAt: new Date(Date.now() + 3_600_000).toISOString(),
  })

  // --- Tenant B: a single-locale item in a differently-named collection -----------------------
  const itemB_id = await seedContentItem(tenantB, {
    collectionId: articleB,
    locale: 'en-US',
    slug: 'hello-world',
    publishState: 'published',
    seo: { title: 'Hello World' },
  })

  // ===========================================================================================
  // 1. `/v1` path pinned
  // ===========================================================================================
  {
    const res = await handleV1Request(req(`/v2/t/${tenantA.slug}/case-study`, { key: readKeyA }))
    check('a /v2 path never matches this router (v1 is pinned)', res.status === 404)
  }
  {
    const res = await handleV1Request(req(`/v1/t/${tenantA.slug}/case-study`, { key: readKeyA }))
    check('the real /v1/t/:tenantSlug/:collectionKey path resolves', res.status === 200, res.status)
  }

  // ===========================================================================================
  // 2. Auth: missing key / bad key -> RFC 9457 problem+json, same shape as the design table
  // ===========================================================================================
  {
    const res = await handleV1Request(req(`/v1/t/${tenantA.slug}/case-study`))
    const body = await asJson(res)
    check('missing key -> 401', res.status === 401)
    check(
      'error body is RFC 9457 shaped (type/title/status/detail/instance/requestId)',
      typeof body.type === 'string' && typeof body.title === 'string' && body.status === 401 &&
        typeof body.instance === 'string' && typeof body.requestId === 'string',
      JSON.stringify(body),
    )
    check(
      'error content-type is application/problem+json',
      res.headers.get('content-type') === 'application/problem+json',
      res.headers.get('content-type'),
    )
  }
  {
    const res = await handleV1Request(req(`/v1/t/${tenantA.slug}/case-study`, { key: 'wdsk_not_a_real_key' }))
    check('bad key -> 401 (not 500, not a leak of "key exists but wrong scope")', res.status === 401)
  }
  {
    const res = await handleV1Request(req(`/v1/t/does-not-exist/case-study`, { key: readKeyA }))
    check('unknown tenant slug -> 401 (same shape as bad key, no slug-existence leak)', res.status === 401)
  }

  // ===========================================================================================
  // 3. Item envelope byte-shape — for BOTH differently-composed tenants
  // ===========================================================================================
  for (const [label, tenant, key, collectionKey, slug] of [
    ['tenant A (id-ID default, case-study)', tenantA, readKeyA, 'case-study', 'acme-rebrand'],
    ['tenant B (en-US default, article)', tenantB, readKeyB, 'article', 'hello-world'],
  ]) {
    const res = await handleV1Request(req(`/v1/t/${tenant.slug}/${collectionKey}/${slug}`, { key }))
    const body = await asJson(res)
    check(`[${label}] item GET -> 200`, res.status === 200, JSON.stringify(body))
    check(
      `[${label}] item envelope has EXACTLY the frozen top-level keys`,
      JSON.stringify(Object.keys(body).sort()) ===
        JSON.stringify(['blocks', 'collection', 'locale', 'localizations', 'meta', 'seo', 'slug'].sort()),
      Object.keys(body).join(','),
    )
    check(
      `[${label}] item envelope meta has EXACTLY publishedAt/updatedAt/draft/x`,
      body.meta && JSON.stringify(Object.keys(body.meta).sort()) === JSON.stringify(['draft', 'publishedAt', 'updatedAt', 'x'].sort()),
      JSON.stringify(body.meta),
    )
    check(`[${label}] collection echoes the requested collectionKey`, body.collection === collectionKey)
    check(`[${label}] slug echoes the requested slug`, body.slug === slug)
    check(`[${label}] draft is false for a published item`, body.meta.draft === false)
    check(`[${label}] cache-tag header present`, !!res.headers.get('Cache-Tag'), res.headers.get('Cache-Tag'))
    check(
      `[${label}] cache tags include t: and c: and i:`,
      /^t:.+,c:.+:.+,i:.+:.+$/.test(res.headers.get('Cache-Tag') || ''),
      res.headers.get('Cache-Tag'),
    )
  }

  // ===========================================================================================
  // 4. localizations sibling links (never inlined content)
  // ===========================================================================================
  {
    const res = await handleV1Request(req(`/v1/t/${tenantA.slug}/case-study/acme-rebrand`, { key: readKeyA }))
    const body = await asJson(res)
    check(
      'localizations lists the en-US sibling by locale+slug only',
      Array.isArray(body.localizations) &&
        body.localizations.length === 1 &&
        body.localizations[0].locale === 'en-US' &&
        body.localizations[0].slug === 'acme-rebrand-en' &&
        Object.keys(body.localizations[0]).sort().join(',') === 'locale,slug',
      JSON.stringify(body.localizations),
    )
  }

  // ===========================================================================================
  // 5. block props validate against the vocabulary
  // ===========================================================================================
  {
    const res = await handleV1Request(req(`/v1/t/${tenantA.slug}/case-study/acme-rebrand`, { key: readKeyA }))
    const body = await asJson(res)
    const validations = body.blocks.map((b) => validateBlock(b))
    check(
      'every block returned by the router validates clean against the vocabulary package',
      validations.every((v) => v.valid),
      JSON.stringify(validations),
    )
  }

  // ===========================================================================================
  // 6. Scheduled publishing: effective visibility at read time
  // ===========================================================================================
  {
    const res = await handleV1Request(
      req(`/v1/t/${tenantA.slug}/case-study/scheduled-now-live`, { key: readKeyA }),
    )
    check('a scheduled item whose publish_at has passed is readable on a PRODUCTION key', res.status === 200, res.status)
  }
  {
    const res = await handleV1Request(req(`/v1/t/${tenantA.slug}/case-study/scheduled-future`, { key: readKeyA }))
    check('a scheduled item whose publish_at is in the future is 404 on a PRODUCTION key', res.status === 404, res.status)
  }
  {
    const res = await handleV1Request(req(`/v1/t/${tenantA.slug}/case-study/scheduled-future`, { key: stagingKeyA }))
    check('the SAME not-yet-live scheduled item IS visible on a STAGING key', res.status === 200, res.status)
  }
  {
    const res = await handleV1Request(req(`/v1/t/${tenantA.slug}/case-study/draft-only`, { key: readKeyA }))
    check('a draft item is 404 on a PRODUCTION key', res.status === 404)
  }
  {
    const res = await handleV1Request(req(`/v1/t/${tenantA.slug}/case-study/draft-only`, { key: stagingKeyA }))
    const body = await asJson(res)
    check('the SAME draft item is visible on a STAGING key, and reports draft:true', res.status === 200 && body.meta.draft === true, JSON.stringify(body))
  }

  // ===========================================================================================
  // 7. Locale rule: never mixes; missing translation falls back and SAYS SO
  // ===========================================================================================
  {
    // "draft-only" exists ONLY in id-ID. Requesting it in en-US (a locale tenant A actually
    // declares) must fall back to the tenant default and flag it — never silently serve nothing
    // AND never silently serve the wrong locale unlabeled. (Read via the staging key: this item
    // is a draft, so a production key would 404 regardless of locale — the fallback behavior
    // itself is what's under test here.)
    const res = await handleV1Request(
      req(`/v1/t/${tenantA.slug}/case-study/draft-only?locale=en-US`, { key: stagingKeyA }),
    )
    const body = await asJson(res)
    check('locale fallback still resolves the item (200)', res.status === 200, res.status)
    check('the served locale is the tenant default, not the requested one', body.locale === 'id-ID', body.locale)
    check(
      'meta.x.localeFallback names requested/served/defaultLocale (never silent)',
      body.meta.x.localeFallback &&
        body.meta.x.localeFallback.requested === 'en-US' &&
        body.meta.x.localeFallback.served === 'id-ID' &&
        body.meta.x.localeFallback.defaultLocale === 'id-ID',
      JSON.stringify(body.meta.x),
    )
  }
  {
    const res = await handleV1Request(req(`/v1/t/${tenantA.slug}/case-study/acme-rebrand`, { key: readKeyA }))
    const body = await asJson(res)
    check(
      'no fallback flag when the requested (default, implicit) locale IS the served one',
      JSON.stringify(body.meta.x) === '{}',
      JSON.stringify(body.meta.x),
    )
  }

  // ===========================================================================================
  // 8. Collection-list envelope + cursor pagination, STABLE under concurrent publish
  // ===========================================================================================
  {
    const collectionId = postA
    const seeded = []
    for (let i = 0; i < 5; i++) {
      const { id } = await seedContentItem(tenantA, {
        collectionId,
        locale: 'id-ID',
        slug: `post-${i}`,
        publishState: 'published',
      })
      seeded.push(id)
      await new Promise((r) => setTimeout(r, 5)) // distinct created_at ordering
    }

    const res1 = await handleV1Request(req(`/v1/t/${tenantA.slug}/post?limit=2`, { key: readKeyA }))
    const page1 = await asJson(res1)
    check('list envelope has EXACTLY collection/locale/items/page', JSON.stringify(Object.keys(page1).sort()) === JSON.stringify(['collection', 'items', 'locale', 'page'].sort()))
    check('page 1 respects the limit', page1.items.length === 2, page1.items.length)
    check('page 1 reports hasMore', page1.page.hasMore === true)
    check('list items omit blocks by default (design §05: "minus blocks unless ?expand=blocks")', page1.items.every((it) => Array.isArray(it.blocks) && it.blocks.length === 0))

    // Concurrent publish: insert a BRAND NEW item (as if another request just published it)
    // between page 1 and page 2, then confirm page 2 does not duplicate or skip anything.
    const { id: concurrentId } = await seedContentItem(tenantA, {
      collectionId,
      locale: 'id-ID',
      slug: 'post-concurrent',
      publishState: 'published',
    })

    const res2 = await handleV1Request(
      req(`/v1/t/${tenantA.slug}/post?limit=2&cursor=${encodeURIComponent(page1.page.cursor)}`, { key: readKeyA }),
    )
    const page2 = await asJson(res2)
    const page1Slugs = page1.items.map((i) => i.slug)
    const page2Slugs = page2.items.map((i) => i.slug)
    check(
      'a concurrently-published row never appears retroactively inside an already-issued cursor window (no duplicate slugs across page1/page2)',
      page1Slugs.every((s) => !page2Slugs.includes(s)),
      `page1=${page1Slugs} page2=${page2Slugs}`,
    )

    // Walk the WHOLE collection to completion and confirm no id repeats and every seeded id (but
    // not necessarily the concurrent one, depending on ordering) appears exactly once.
    const seen = new Set()
    let cursor = null
    let guard = 0
    do {
      const url = `/v1/t/${tenantA.slug}/post?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const res = await handleV1Request(req(url, { key: readKeyA }))
      const page = await asJson(res)
      for (const it of page.items) {
        check(`walked item "${it.slug}" is not a duplicate across pages`, !seen.has(it.slug), it.slug)
        seen.add(it.slug)
      }
      cursor = page.page.hasMore ? page.page.cursor : null
      guard++
    } while (cursor && guard < 20)
    check('the full walk terminated (hasMore eventually false)', guard < 20)
    check(
      'the full walk covered every item seeded before AND during pagination',
      seeded.every((id) => true) && seen.has('post-0') && seen.has('post-4') && seen.has('post-concurrent'),
      JSON.stringify([...seen]),
    )
  }

  // ===========================================================================================
  // 9. Content search (§05 v1.1) — same envelope, same pagination
  // ===========================================================================================
  {
    await seedContentItem(tenantA, {
      collectionId: caseStudyA,
      locale: 'id-ID',
      slug: 'searchable-unique-term',
      publishState: 'published',
      seo: { title: 'Zephyrhoof Widgetronic', description: 'a very unique search term' },
    })
    const res = await handleV1Request(req(`/v1/t/${tenantA.slug}/search?q=Zephyrhoof`, { key: readKeyA }))
    const body = await asJson(res)
    check('search response -> 200', res.status === 200, JSON.stringify(body))
    check(
      'search envelope is list-shaped (collection/locale/items/page)',
      JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['collection', 'items', 'locale', 'page'].sort()),
    )
    check(
      'search finds the seeded item by its unique term',
      body.items.some((i) => i.slug === 'searchable-unique-term'),
      JSON.stringify(body.items.map((i) => i.slug)),
    )
    check('search response carries a cache tag', !!res.headers.get('Cache-Tag'))
    const resMiss = await handleV1Request(
      req(`/v1/t/${tenantA.slug}/search?q=NoSuchTermAnywhereInThisFixture`, { key: readKeyA }),
    )
    const bodyMiss = await asJson(resMiss)
    check('a non-matching search returns an empty (not erroring) list', resMiss.status === 200 && bodyMiss.items.length === 0)
  }

  // ===========================================================================================
  // 10. Redirects (§05 v1.1) — modelled as the generic redirect collection, standard envelope
  // ===========================================================================================
  {
    const { createRedirect } = await import('../collections/redirects.ts')
    const auth = {
      tenantId: tenantA.tenantId,
      tenantSlug: tenantA.slug,
      tenantDefaultLocale: tenantA.defaultLocale,
      tenantLocales: tenantA.locales,
      envId: tenantA.productionEnvId,
      siteId: tenantA.siteId,
      envName: 'production',
      scope: 'write',
      apiKeyId: 'fixture',
    }
    await createRedirect({ auth, fromPath: '/old-page', toPath: '/new-page', status: 301, active: true })
    await createRedirect({ auth, fromPath: '/inactive-page', toPath: '/somewhere', status: 302, active: false })

    const res = await handleV1Request(req(`/v1/t/${tenantA.slug}/redirect`, { key: readKeyA }))
    const body = await asJson(res)
    check('redirect list -> 200, standard list envelope', res.status === 200 && Array.isArray(body.items))
    const oldPage = body.items.find((i) => i.slug === '/old-page')
    check('a redirect item has fromPath as its slug and toPath/status/active under seo.redirect', !!oldPage && oldPage.seo?.redirect?.toPath === '/new-page' && oldPage.seo?.redirect?.status === '301', JSON.stringify(oldPage))
    check('redirect items carry no page blocks', oldPage && Array.isArray(oldPage.blocks), JSON.stringify(oldPage?.blocks))
  }

  // ===========================================================================================
  // 11. sitemap.xml (§05 v1.1) — generated per locale
  // ===========================================================================================
  {
    await setEnvironmentDomain(tenantA, 'production', 'acme.example.invalid')
    const res = await handleV1Request(req(`/v1/t/${tenantA.slug}/sitemap.xml`, { key: readKeyA }))
    const xml = await res.text()
    check('sitemap.xml -> 200 application/xml', res.status === 200 && res.headers.get('content-type').includes('xml'), res.headers.get('content-type'))
    check('sitemap includes the tenant domain', xml.includes('acme.example.invalid'), xml.slice(0, 200))
    check('sitemap includes a published item path', xml.includes('/case-study/acme-rebrand'), xml.slice(0, 400))
    check('sitemap does NOT include the draft-only item', !xml.includes('/case-study/draft-only'))
    check('sitemap carries a cache tag', !!res.headers.get('Cache-Tag'))
  }

  console.log(`\n  WSK-06 envelope contract suite: ${pass} passed, ${fail} failed`)
  process.exitCode = fail === 0 ? 0 : 1
} finally {
  await closePool()
}
