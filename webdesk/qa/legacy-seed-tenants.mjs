// Seeds / removes the two throwaway tenants the `legacy` suite's `npm run codegen:gate` step needs
// (webdesk/migrations create no tenants, and generate-single.mts reads a tenant's composition from the
// database). Uses the static p3-gate fixtures (qa-p3-acme, qa-p3-globex). Connects as SEED_DATABASE_URL
// (the cluster superuser: BYPASSRLS, so no GUC dance) and removes every row it created in `clean`
// (`seed` also cleans first, so a half-finished earlier run cannot collide).
//   node qa/legacy-seed-tenants.mjs seed|clean      (from webdesk/, so `pg` resolves)
import pg from 'pg'
import { TENANT_FIXTURES } from './p3-gate/fixtures/tenant-fixtures.mjs'

const mode = process.argv[2]
const url = process.env.SEED_DATABASE_URL
if (!['seed', 'clean'].includes(mode) || !url) {
  console.error('usage: SEED_DATABASE_URL=... node qa/legacy-seed-tenants.mjs seed|clean')
  process.exit(2)
}
const fixtures = Object.values(TENANT_FIXTURES)
const slugs = fixtures.map((f) => f.tenantSlug)

const client = new pg.Client({ connectionString: url })
await client.connect()
try {
  await client.query('BEGIN')
  // Children first (collections/sites reference tenants, no ON DELETE CASCADE).
  await client.query(`DELETE FROM collections WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ANY($1))`, [slugs])
  await client.query(`DELETE FROM sites WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ANY($1))`, [slugs])
  await client.query(`DELETE FROM tenants WHERE slug = ANY($1)`, [slugs])
  if (mode === 'seed') {
    for (const f of fixtures) {
      const { rows } = await client.query(
        `INSERT INTO tenants (slug, company_ref, default_locale, locales) VALUES ($1, gen_random_uuid(), $2, $3) RETURNING id`,
        [f.tenantSlug, f.defaultLocale, f.locales],
      )
      const tenantId = rows[0].id
      const site = await client.query(`INSERT INTO sites (tenant_id, kind, name) VALUES ($1, 'astro', $2) RETURNING id`, [
        tenantId,
        f.tenantSlug,
      ])
      for (const [key, schema] of Object.entries(f.composition)) {
        await client.query(`INSERT INTO collections (tenant_id, site_id, key, schema) VALUES ($1, $2, $3, $4)`, [
          tenantId,
          site.rows[0].id,
          key,
          JSON.stringify(schema),
        ])
      }
    }
  }
  await client.query('COMMIT')
  console.log(`legacy-seed-tenants: ${mode} ok (${slugs.join(', ')})`)
} catch (err) {
  await client.query('ROLLBACK').catch(() => {})
  console.error(err)
  process.exit(1)
} finally {
  await client.end()
}
