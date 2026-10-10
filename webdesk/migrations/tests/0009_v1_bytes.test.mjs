#!/usr/bin/env node
/**
 * WSK-65 — the /v1 read path returns IDENTICAL BYTES before and after migration 0009, on the SAME
 * rows (WSK-48a's gate; design §2.6: "the read SQL is not edited").
 *
 * Why this is a real risk and not a formality: the delivery queries select `ci.*`, so after 0009
 * every row they fetch carries five extra columns. The envelope is assembled from named fields, so
 * nothing should leak, but "should" is what this file replaces with a measurement.
 *
 * Method: one scratch database stopped at 0008, seeded with the /v1 fixture helpers (published,
 * draft, scheduled past/future, unpublished, localized siblings, an unknown block, redirects, a
 * domain for the sitemap, two tenants). Every request below is captured (status, every header,
 * body bytes) through the real router (payload/collections/router.ts), the REAL runner then applies
 * 0009 to that same database, and every request is replayed and compared byte for byte. A fixed
 * x-request-id keeps problem+json bodies deterministic.
 *
 * Env: SUPERUSER_DATABASE_URL, MIGRATE_DATABASE_URL, APP_DATABASE_URL (main db; a scratch db is
 * derived from them), API_KEY_PEPPER.
 * Run from webdesk/api (its tsx loads the .ts router; `pg` resolves from webdesk/node_modules):
 *   node --import tsx ../migrations/tests/0009_v1_bytes.test.mjs
 */
import {
  TARGET_FILE,
  applyThrough,
  createScratchDb,
  dropScratchDb,
  makeChecker,
  requireEnv,
  resolveRoles,
  runRunner,
  withDb,
} from './0009_helpers.mjs'

requireEnv(['SUPERUSER_DATABASE_URL', 'MIGRATE_DATABASE_URL', 'APP_DATABASE_URL', 'API_KEY_PEPPER'])
const SUPER = process.env.SUPERUSER_DATABASE_URL
const DB = 'wsk65_v1bytes'
const { check, summary } = makeChecker('0009-v1-bytes')

async function main() {
  const roles = await resolveRoles(SUPER, process.env.MIGRATE_DATABASE_URL, process.env.APP_DATABASE_URL)
  await createScratchDb(SUPER, DB, roles)
  const mUrl = withDb(process.env.MIGRATE_DATABASE_URL, DB)
  const aUrl = withDb(process.env.APP_DATABASE_URL, DB)
  try {
    const applied = await applyThrough(mUrl)
    check(`scratch db at 0008 (${applied.length} files, last ${applied.at(-1)})`, applied.length === 8)

    // The fixture helpers and the router read these at import time: set them, THEN import.
    process.env.MIGRATE_DATABASE_URL = mUrl
    process.env.DATABASE_URI = aUrl
    const fx = await import('../../payload/test/v1-fixtures.mjs')
    const { handleV1Request } = await import('../../payload/collections/router.ts')
    const { closePool } = await import('../../payload/collections/db.ts')
    const { createRedirect } = await import('../../payload/collections/redirects.ts')

    // ---- seed (0008 schema) --------------------------------------------------------------
    const A = await fx.createFixtureTenant({ label: 'a', defaultLocale: 'id-ID', locales: ['id-ID', 'en-US'] })
    const caseStudy = await fx.createFixtureCollection(A, 'case-study')
    const post = await fx.createFixtureCollection(A, 'post')
    await fx.createFixtureCollection(A, 'redirect')
    const prodA = await fx.mintFixtureApiKey(A, 'production', 'read')
    const stagA = await fx.mintFixtureApiKey(A, 'staging', 'read')
    const B = await fx.createFixtureTenant({ label: 'b', defaultLocale: 'en-US', locales: ['en-US'] })
    const article = await fx.createFixtureCollection(B, 'article')
    const prodB = await fx.mintFixtureApiKey(B, 'production', 'read')

    const g = crypto.randomUUID()
    const t0 = Date.parse('2026-01-01T00:00:00Z')
    const at = (i) => new Date(t0 + i * 1000).toISOString()
    await fx.seedContentItem(A, {
      collectionId: caseStudy, locale: 'id-ID', slug: 'acme-rebrand', localizationGroupId: g, publishState: 'published', createdAt: at(1),
      seo: { title: 'Acme Rebrand', description: 'desc Zephyrhoof', ogImage: '/x.png' },
      blocks: [{ type: 'hero', props: { heading: 'Halo' } }, { type: 'richText', props: { content: 'body' } }, { type: 'zzz-unknown-block', props: { a: 1 } }],
    })
    await fx.seedContentItem(A, { collectionId: caseStudy, locale: 'en-US', slug: 'acme-rebrand-en', localizationGroupId: g, publishState: 'published', createdAt: at(2) })
    await fx.seedContentItem(A, { collectionId: caseStudy, locale: 'id-ID', slug: 'draft-only', publishState: 'draft', createdAt: at(3) })
    await fx.seedContentItem(A, { collectionId: caseStudy, locale: 'id-ID', slug: 'scheduled-now-live', publishState: 'scheduled', publishAt: new Date(Date.now() - 60_000).toISOString(), createdAt: at(4) })
    await fx.seedContentItem(A, { collectionId: caseStudy, locale: 'id-ID', slug: 'scheduled-future', publishState: 'scheduled', publishAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: at(5) })
    await fx.seedContentItem(A, { collectionId: caseStudy, locale: 'id-ID', slug: 'pulled', publishState: 'unpublished', createdAt: at(6) })
    for (let i = 0; i < 5; i++) {
      await fx.seedContentItem(A, { collectionId: post, locale: 'id-ID', slug: `post-${i}`, publishState: 'published', createdAt: at(10 + i) })
    }
    await fx.seedContentItem(B, { collectionId: article, locale: 'en-US', slug: 'hello-world', publishState: 'published', seo: { title: 'Hello World' }, createdAt: at(20) })
    const auth = {
      tenantId: A.tenantId, tenantSlug: A.slug, tenantDefaultLocale: A.defaultLocale, tenantLocales: A.locales,
      envId: A.productionEnvId, siteId: A.siteId, envName: 'production', scope: 'write', apiKeyId: 'fixture',
    }
    await createRedirect({ auth, fromPath: '/old-page', toPath: '/new-page', status: 301, active: true })
    await createRedirect({ auth, fromPath: '/inactive-page', toPath: '/somewhere', status: 302, active: false })
    await fx.setEnvironmentDomain(A, 'production', 'acme.example.invalid')

    // ---- the request matrix ------------------------------------------------------------------
    const T = A.slug
    const matrix = [
      [`/v1/t/${T}/case-study`, prodA], [`/v1/t/${T}/case-study`, stagA],
      [`/v1/t/${T}/case-study?locale=en-US`, prodA], [`/v1/t/${T}/case-study?locale=fr-FR`, prodA],
      [`/v1/t/${T}/case-study/acme-rebrand`, prodA], [`/v1/t/${T}/case-study/acme-rebrand`, stagA],
      [`/v1/t/${T}/case-study/acme-rebrand?locale=en-US`, prodA],
      [`/v1/t/${T}/case-study/draft-only`, prodA], [`/v1/t/${T}/case-study/draft-only`, stagA],
      [`/v1/t/${T}/case-study/draft-only?locale=en-US`, stagA],
      [`/v1/t/${T}/case-study/scheduled-now-live`, prodA], [`/v1/t/${T}/case-study/scheduled-future`, prodA],
      [`/v1/t/${T}/case-study/scheduled-future`, stagA], [`/v1/t/${T}/case-study/pulled`, prodA], [`/v1/t/${T}/case-study/pulled`, stagA],
      [`/v1/t/${T}/case-study/no-such-slug`, prodA],
      [`/v1/t/${T}/post?limit=2`, prodA], [`/v1/t/${T}/post?limit=100`, stagA],
      [`/v1/t/${T}/search?q=Zephyrhoof`, prodA], [`/v1/t/${T}/search?q=acme`, stagA], [`/v1/t/${T}/search?q=NoSuchTermAnywhere`, prodA],
      [`/v1/t/${T}/redirect`, prodA], [`/v1/t/${T}/sitemap.xml`, prodA],
      [`/v1/t/${T}/no-such-collection`, prodA], [`/v1/t/${T}/case-study`, null], [`/v1/t/${T}/case-study`, 'wdsk_not_a_real_key'],
      [`/v1/t/${T}/case-study`, prodB], [`/v1/t/does-not-exist/case-study`, prodA], [`/v2/t/${T}/case-study`, prodA],
      [`/v1/t/${B.slug}/article`, prodB], [`/v1/t/${B.slug}/article/hello-world`, prodB],
    ]

    async function capture() {
      const out = []
      for (const [path, key] of matrix) {
        const h = new Headers({ 'x-request-id': 'wsk65-fixed-request-id' })
        if (key) h.set('authorization', `Bearer ${key}`)
        const res = await handleV1Request(new Request(`http://internal${path}`, { headers: h }))
        const headers = [...res.headers.entries()].sort(([a], [b]) => a.localeCompare(b))
        out.push({ path, key: key ? key.slice(0, 14) : null, status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) })
      }
      // Paginate the cursor too: page 2 under the same cursor is part of the contract.
      const first = JSON.parse(out.find((o) => o.path.endsWith('post?limit=2')).body.toString('utf8'))
      if (first?.page?.cursor) {
        const p = `/v1/t/${T}/post?limit=2&cursor=${encodeURIComponent(first.page.cursor)}`
        const res = await handleV1Request(new Request(`http://internal${p}`, { headers: { authorization: `Bearer ${prodA}`, 'x-request-id': 'wsk65-fixed-request-id' } }))
        out.push({ path: p, key: 'prodA', status: res.status, headers: [...res.headers.entries()].sort(([a], [b]) => a.localeCompare(b)), body: Buffer.from(await res.arrayBuffer()) })
      }
      return out
    }

    const before = await capture()
    const statuses = before.reduce((m, o) => ((m[o.status] = (m[o.status] ?? 0) + 1), m), {})
    console.log(`        captured ${before.length} responses before 0009; statuses ${JSON.stringify(statuses)}; ${before.reduce((n, o) => n + o.body.length, 0)} body bytes`)
    check('the matrix exercises 200s and error paths', (statuses[200] ?? 0) >= 15 && Object.keys(statuses).length >= 3, statuses)

    await closePool() // drop pooled connections before the DDL takes its locks
    const run = runRunner(mUrl)
    console.log(`        runner exit=${run.status}: ${run.stdout.trim().split('\n').at(-1)}`)
    check(`the real runner applied ${TARGET_FILE} between the two captures`, run.status === 0 && /1 applied/.test(run.stdout), run.stdout + run.stderr)

    const after = await capture()
    let identical = 0
    for (let i = 0; i < before.length; i++) {
      const b = before[i]
      const a = after[i]
      const same = a && a.status === b.status && JSON.stringify(a.headers) === JSON.stringify(b.headers) && Buffer.compare(a.body, b.body) === 0
      if (same) identical++
      else {
        check(`identical bytes: ${b.path} [${b.key}]`, false, {
          status: [b.status, a?.status],
          headers: JSON.stringify(b.headers) === JSON.stringify(a?.headers) ? 'same' : { before: b.headers, after: a?.headers },
          before: b.body.toString('utf8').slice(0, 400),
          after: a?.body.toString('utf8').slice(0, 400),
        })
      }
    }
    console.log(`        ${identical}/${before.length} responses byte-identical (status + every header + body)`)
    check(`all ${before.length} /v1 responses byte-identical before and after 0009`, identical === before.length && after.length === before.length)
    await closePool()
  } catch (err) {
    check('unexpected harness error', false, err.stack)
  } finally {
    await dropScratchDb(SUPER, DB).catch(() => {})
  }
  process.exit(summary())
}

main()
