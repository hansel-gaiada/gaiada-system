// webdesk/qa/p5-wp-gate/seed.mjs -- M6 P5 gate: seeds ONE throwaway tenant for the WordPress gate.
//
// Runs INSIDE the freshly built api image (cwd /app, so `pg` resolves from the image's own
// node_modules), fed on stdin by p5-wp-gate.sh:   node --input-type=module - < seed.mjs
// Env:  SEED_DATABASE_URL (the cluster superuser, BYPASSRLS: no GUC dance, same as
//       qa/legacy-seed-tenants.mjs)  SEED_PEPPER (= the api's API_KEY_PEPPER)  SEED_TENANT_SLUG
//
// What it writes (the same rows test/helpers/fixtures.ts + test/content-test-kit.ts write):
//   tenant (default_locale en, locales en+id) -> one `wp` site with staging + production environments
//   -> a `pages` collection whose composition lists the eight vocabulary block types
//   -> content_items published in `en` and `id` (home, about, contact(en only)), with an UNKNOWN
//      block type (`pricingTable`) inside every item and a `javascript:` CTA href inside every item
//   -> ONE production read key: plaintext = "wdsk_" + base64url(32 random bytes), at rest
//      sha256(plaintext + pepper), exactly crypto/api-key-hash.ts.
//
// The items are inserted as SQL fixtures, NOT through the control plane: the control plane's publish
// needs a WS4 approval assertion and the ERP's mTLS/Keycloak layers, which this gate deliberately does
// not stand up. What the gate proves is the READ side: /v1 -> generated sdk.php -> WordPress theme.
//
// stdout carries EXACTLY ONE line, `P5KEY=<plaintext key>`, captured by the shell into a variable and
// never echoed. Everything else goes to stderr.
import pg from 'pg'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

const url = process.env.SEED_DATABASE_URL
const pepper = process.env.SEED_PEPPER
const slug = process.env.SEED_TENANT_SLUG
if (!url || !pepper || !slug) {
  console.error('seed: SEED_DATABASE_URL, SEED_PEPPER and SEED_TENANT_SLUG are required')
  process.exit(2)
}

const BLOCK_TYPES = ['hero', 'richText', 'cta', 'gallery', 'featureGrid', 'testimonial', 'faq', 'logoCloud']
const img = (name) => ({ url: `https://assets.example.test/${name}.png`, alt: `alt ${name}`, width: 640, height: 360 })

// One full page: every known vocabulary block type, plus the unknown one, plus the hostile CTA.
function pageBlocks(tag, lang) {
  return [
    {
      type: 'hero',
      props: { heading: `P5GATE-${tag}-HERO`, subheading: `P5GATE-${tag}-SUB`, ctaLabel: 'About us', ctaHref: '/about/', media: img(`${tag}-hero`) },
    },
    // UNKNOWN to the vocabulary: must render nothing, leak nothing, and break nothing around it.
    { type: 'pricingTable', props: { heading: 'P5GATE-PRICING-LEAK', plans: [{ name: 'P5GATE-PLAN-LEAK', price: 1 }] } },
    { type: 'richText', props: { content: `<p>P5GATE-${tag}-RICH</p>` } },
    // HOSTILE: a javascript: href seeded in content must come out as "#".
    { type: 'cta', props: { heading: `P5GATE-${tag}-CTA`, body: 'cta body', buttonLabel: 'Go', buttonHref: 'javascript:alert(document.domain)' } },
    { type: 'gallery', props: { items: [img(`${tag}-g1`), img(`${tag}-g2`)], caption: `P5GATE-${tag}-CAPTION` } },
    { type: 'featureGrid', props: { heading: `P5GATE-${tag}-FEATURES`, items: [{ collection: 'feature', slug: `f-${lang}-1` }, { collection: 'feature', slug: `f-${lang}-2` }] } },
    { type: 'testimonial', props: { quote: `P5GATE-${tag}-QUOTE`, author: 'Ada Tester', role: 'QA' } },
    { type: 'faq', props: { heading: `P5GATE-${tag}-FAQ`, items: [{ collection: 'faqItem', slug: `q-${lang}-1` }] } },
    { type: 'logoCloud', props: { heading: `P5GATE-${tag}-LOGOS`, logos: [img(`${tag}-l1`), img(`${tag}-l2`)] } },
  ]
}

// about/en and about/id share a localization group (so do home/en and home/id).
const ITEMS = [
  { slug: 'home', locale: 'en', tag: 'HOME-EN', title: 'P5GATE Home EN' },
  { slug: 'home', locale: 'id', tag: 'HOME-ID', title: 'P5GATE Beranda ID' },
  { slug: 'about', locale: 'en', tag: 'ABOUT-EN', title: 'P5GATE About EN' },
  { slug: 'about', locale: 'id', tag: 'ABOUT-ID', title: 'P5GATE Tentang ID' },
  { slug: 'contact', locale: 'en', tag: 'CONTACT-EN', title: 'P5GATE Contact EN' },
]

const client = new pg.Client({ connectionString: url })
await client.connect()
let plaintext
try {
  await client.query('BEGIN')
  const t = await client.query(
    `INSERT INTO tenants (slug, company_ref, status, default_locale, locales) VALUES ($1, gen_random_uuid(), 'active', 'en', ARRAY['en','id']) RETURNING id`,
    [slug],
  )
  const tenantId = t.rows[0].id
  const s = await client.query(`INSERT INTO sites (tenant_id, kind, name) VALUES ($1, 'wp', $2) RETURNING id`, [tenantId, `${slug} site`])
  const siteId = s.rows[0].id
  const envs = {}
  for (const name of ['staging', 'production']) {
    const e = await client.query(
      `INSERT INTO environments (site_id, tenant_id, name, status) VALUES ($1, $2, $3, 'active') RETURNING id`,
      [siteId, tenantId, name],
    )
    envs[name] = e.rows[0].id
  }
  const composition = { blocks: BLOCK_TYPES }
  const c = await client.query(`INSERT INTO collections (tenant_id, site_id, key, schema) VALUES ($1, $2, 'pages', $3::jsonb) RETURNING id`, [
    tenantId,
    siteId,
    JSON.stringify(composition),
  ])
  const collectionId = c.rows[0].id

  const groups = {}
  for (const it of ITEMS) {
    groups[it.slug] ??= randomUUID()
    await client.query(
      `INSERT INTO content_items (tenant_id, site_id, collection_id, locale, slug, localization_group_id, blocks, seo, publish_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, 'published')`,
      [tenantId, siteId, collectionId, it.locale, it.slug, groups[it.slug], JSON.stringify(pageBlocks(it.tag, it.locale)), JSON.stringify({ title: it.title })],
    )
  }

  plaintext = 'wdsk_' + randomBytes(32).toString('base64url')
  const keyHash = createHash('sha256').update(plaintext + pepper, 'utf8').digest('hex')
  await client.query(`INSERT INTO api_keys (env_id, tenant_id, key_hash, scope) VALUES ($1, $2, $3, 'read')`, [envs.production, tenantId, keyHash])
  await client.query('COMMIT')
  console.error(`seed: tenant ${slug} (${tenantId}) with ${ITEMS.length} published items, 1 production read key`)
} catch (err) {
  await client.query('ROLLBACK').catch(() => {})
  console.error('seed FAILED:', err)
  process.exit(1)
} finally {
  await client.end()
}
process.stdout.write(`P5KEY=${plaintext}\n`)
