#!/usr/bin/env node
/**
 * webdesk/sites/wsk17-proof/scripts/seed-tenant.mjs
 *
 * WSK-17 -- creates ONE real tenant (`wsk17-proof`, the D26-finding tenant-zero analog: a non-WP
 * site, since gaiada.com itself stays WordPress/Hostinger per WSK-D26 and is out of this ticket's
 * reach), one `case-study` collection composed of the FULL 9-type vocabulary, two real content
 * items (multi-block, real English/Indonesian copy, not lorem-ipsum), and a production-scope API
 * key -- all through plain `pg`, connected as `webdesk_migrator`, setting the same
 * `webdesk.platform_ctx` / `webdesk.tenant_ctx` GUCs the real control plane and every other
 * fixture helper in this repo use (mirrors webdesk/payload/test/v1-fixtures.mjs and
 * webdesk/api/test/helpers/fixtures.ts -- same pattern, reimplemented here rather than imported,
 * because this ticket's ownership boundary excludes both `payload/**` and `api/**`).
 *
 * This is test/dev harness tooling that seeds the database directly -- it is NOT part of the
 * shipped site (nothing under src/** imports this file or `pg`). The site itself only ever reads
 * through the generated SDK + openapi-fetch, over HTTP, against the live /v1 dev stack this
 * script's data feeds.
 *
 * Run: MIGRATE_DATABASE_URL=... API_KEY_PEPPER=... node scripts/seed-tenant.mjs
 * Prints one JSON line to stdout: { tenantId, slug, apiKey, collectionKey, slugs: [...] }.
 */
import { Client } from 'pg'
import { randomUUID, createHash } from 'node:crypto'
import { TENANT_SLUG, COLLECTION_KEY } from '../src/lib/site-tenant.ts'

const MIGRATOR_URL = process.env.MIGRATE_DATABASE_URL
if (!MIGRATOR_URL) throw new Error('MIGRATE_DATABASE_URL not set')
const PEPPER = process.env.API_KEY_PEPPER
if (!PEPPER) throw new Error('API_KEY_PEPPER not set')

function hashApiKey(plaintext, pepper) {
  return createHash('sha256').update(plaintext + pepper, 'utf8').digest('hex')
}

// The full 9-type vocabulary, unrestricted order (design §05 Layer 1) -- proving the site renders
// every block type the block-renderer library ships, not a convenient subset.
const ALL_BLOCK_TYPES = [
  'hero', 'richText', 'gallery', 'cta', 'featureGrid', 'form', 'testimonial', 'faq', 'logoCloud',
]

async function main() {
  const client = new Client({ connectionString: MIGRATOR_URL })
  await client.connect()

  const tenantId = randomUUID()
  const siteId = randomUUID()
  const stagingEnvId = randomUUID()
  const productionEnvId = randomUUID()
  const collectionId = randomUUID()

  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL webdesk.platform_ctx = 'true'")
    await client.query(
      `INSERT INTO tenants (id, slug, company_ref, status, default_locale, locales)
       VALUES ($1, $2, $3, 'active', $4, $5)`,
      [tenantId, TENANT_SLUG, randomUUID(), 'en-US', ['en-US', 'id-ID']],
    )
    await client.query("SET LOCAL webdesk.platform_ctx = ''")
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId])
    await client.query(`INSERT INTO sites (id, tenant_id, kind, name) VALUES ($1, $2, 'astro', $3)`, [
      siteId, tenantId, 'WSK-17 proof rebuild',
    ])
    await client.query(
      `INSERT INTO environments (id, site_id, tenant_id, name, status) VALUES ($1, $2, $3, 'staging', 'active')`,
      [stagingEnvId, siteId, tenantId],
    )
    await client.query(
      `INSERT INTO environments (id, site_id, tenant_id, name, status) VALUES ($1, $2, $3, 'production', 'active')`,
      [productionEnvId, siteId, tenantId],
    )
    await client.query(
      `INSERT INTO collections (id, tenant_id, site_id, key, schema) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [collectionId, tenantId, siteId, COLLECTION_KEY, JSON.stringify({ blocks: ALL_BLOCK_TYPES })],
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  }

  // --- Item 1: "acme-rebrand" -- all 9 block types, in vocabulary order, real copy -------------
  const item1Blocks = [
    { type: 'hero', props: {
      heading: 'Acme rebrands for the AI era',
      subheading: 'A full identity refresh delivered in 6 weeks by the Gaiada Web Dev department.',
      media: { url: 'https://picsum.photos/seed/acme-hero/1600/900', alt: 'Acme new storefront' },
      ctaLabel: 'Read the case study', ctaHref: '#cta',
    } },
    { type: 'richText', props: {
      content: 'Acme came to us with a decade-old visual identity and a checkout flow that lost ' +
        'one in three mobile shoppers at payment. This case study walks through the discovery ' +
        'sprint, the new design system, and the 41% conversion lift we measured 90 days post-launch.',
    } },
    { type: 'gallery', props: {
      items: [
        { url: 'https://picsum.photos/seed/acme-1/1200/800', alt: 'Old homepage' },
        { url: 'https://picsum.photos/seed/acme-2/1200/800', alt: 'New homepage' },
        { url: 'https://picsum.photos/seed/acme-3/1200/800', alt: 'New checkout flow' },
      ],
      caption: 'Before / after / the new checkout',
    } },
    { type: 'cta', props: {
      heading: 'Want a rebrand that moves the number that matters?',
      body: 'Talk to the same team that shipped this one.',
      buttonLabel: 'Book a discovery call', buttonHref: 'https://gaiada.com/contact',
    } },
    { type: 'featureGrid', props: {
      heading: 'What shipped',
      items: [
        { collection: 'feature', slug: 'design-system' },
        { collection: 'feature', slug: 'headless-checkout' },
        { collection: 'feature', slug: 'perf-budget' },
      ],
    } },
    { type: 'form', props: { formKey: { collection: 'form_defs', slug: 'case-study-contact' } } },
    { type: 'testimonial', props: {
      quote: 'The Gaiada team shipped in six weeks what our last agency quoted six months for.',
      author: 'Rina Wibowo', role: 'VP Marketing, Acme',
      avatar: { url: 'https://picsum.photos/seed/acme-avatar/200/200', alt: 'Rina Wibowo' },
    } },
    { type: 'faq', props: {
      heading: 'Common questions',
      items: [
        { collection: 'faqItem', slug: 'timeline' },
        { collection: 'faqItem', slug: 'pricing' },
      ],
    } },
    { type: 'logoCloud', props: {
      heading: 'As seen with',
      logos: [
        { url: 'https://picsum.photos/seed/logo-1/240/80', alt: 'Partner 1' },
        { url: 'https://picsum.photos/seed/logo-2/240/80', alt: 'Partner 2' },
      ],
    } },
  ]

  // --- Item 2: "globex-launch" -- a smaller subset, different locale/content, proves the site
  // isn't hardcoded to one row's shape. --------------------------------------------------------
  const item2Blocks = [
    { type: 'hero', props: {
      heading: 'Globex goes live on WebDesk',
      subheading: 'Zero downtime migration from a legacy CMS in one weekend.',
      ctaLabel: 'See the numbers', ctaHref: '#cta',
    } },
    { type: 'richText', props: {
      content: 'Globex needed a Saturday-night cutover with no SEO loss. We pre-warmed the CDN, ' +
        'ran the redirect map through WebDesk\'s redirect collection, and flipped DNS at 2am with ' +
        'a rollback script standing by that was never needed.',
    } },
    { type: 'cta', props: {
      heading: 'Migrating off a legacy CMS?', buttonLabel: 'Get the migration checklist',
      buttonHref: 'https://gaiada.com/migration-checklist',
    } },
  ]

  const groupId1 = randomUUID()
  const groupId2 = randomUUID()

  await client.query('BEGIN')
  await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId])
  await client.query(
    `INSERT INTO content_items
       (id, tenant_id, site_id, collection_id, locale, slug, localization_group_id, blocks, seo, publish_state)
     VALUES ($1,$2,$3,$4,'en-US',$5,$6,$7::jsonb,$8::jsonb,'published')`,
    [randomUUID(), tenantId, siteId, collectionId, 'acme-rebrand', groupId1, JSON.stringify(item1Blocks),
     JSON.stringify({ title: 'Acme rebrands for the AI era', description: 'How Acme lifted conversion 41% with a WebDesk-built site.' })],
  )
  await client.query(
    `INSERT INTO content_items
       (id, tenant_id, site_id, collection_id, locale, slug, localization_group_id, blocks, seo, publish_state)
     VALUES ($1,$2,$3,$4,'en-US',$5,$6,$7::jsonb,$8::jsonb,'published')`,
    [randomUUID(), tenantId, siteId, collectionId, 'globex-launch', groupId2, JSON.stringify(item2Blocks),
     JSON.stringify({ title: 'Globex goes live on WebDesk', description: 'A zero-downtime CMS migration case study.' })],
  )
  // A DRAFT item -- never rendered by a static build against a production-scope key. Present to
  // prove the effective-publish visibility rule actually holds against a live server, not just
  // asserted -- see scripts/conformance-runtime.mjs's "draft item is invisible" check.
  await client.query(
    `INSERT INTO content_items
       (id, tenant_id, site_id, collection_id, locale, slug, localization_group_id, blocks, seo, publish_state)
     VALUES ($1,$2,$3,$4,'en-US','unpublished-draft',$5,$6::jsonb,$7::jsonb,'draft')`,
    [randomUUID(), tenantId, siteId, collectionId, randomUUID(),
     JSON.stringify([{ type: 'hero', props: { heading: 'Should never be built' } }]),
     JSON.stringify({ title: 'draft' })],
  )
  await client.query('COMMIT')

  // --- Production-scope read API key --------------------------------------------------------
  const plaintextKey = `wdsk_wsk17_${randomUUID().replace(/-/g, '')}`
  const keyHash = hashApiKey(plaintextKey, PEPPER)
  await client.query('BEGIN')
  await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId])
  await client.query(`INSERT INTO api_keys (env_id, tenant_id, key_hash, scope) VALUES ($1,$2,$3,'read')`, [
    productionEnvId, tenantId, keyHash,
  ])
  await client.query('COMMIT')

  await client.end()

  console.log(JSON.stringify({
    tenantId, slug: TENANT_SLUG, apiKey: plaintextKey, collectionKey: COLLECTION_KEY,
    slugs: ['acme-rebrand', 'globex-launch'], draftSlugExcluded: 'unpublished-draft',
  }))
}

main().catch((err) => {
  console.error('[wsk17-proof:seed] FAILED', err)
  process.exit(1)
})
