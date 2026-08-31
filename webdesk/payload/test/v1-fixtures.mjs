/**
 * WSK-06 test fixtures for the /v1 envelope contract suite. Same pattern as
 * webdesk/api/test/helpers/fixtures.ts (read, not imported — separate package/runtime): a raw pg
 * client connected as webdesk_migrator, setting the same GUCs the real control plane would
 * (platform_ctx for the tenant row itself, tenant_ctx for everything that belongs to one). Fresh
 * random slugs/ids per call so test files never collide; nothing is cleaned up afterward — the
 * whole database is a throwaway container torn down after the run.
 */
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'

const MIGRATOR_URL = process.env.MIGRATE_DATABASE_URL
if (!MIGRATOR_URL) throw new Error('MIGRATE_DATABASE_URL not set')

function hashApiKey(plaintext, pepper) {
  return createHash('sha256').update(plaintext + pepper, 'utf8').digest('hex')
}

/**
 * @param {{ label: string, defaultLocale?: string, locales?: string[] }} opts
 */
export async function createFixtureTenant(opts) {
  const client = new Client({ connectionString: MIGRATOR_URL })
  await client.connect()
  try {
    const slug = `wsk06-${opts.label}-${randomUUID().slice(0, 8)}`
    const tenantId = randomUUID()
    const siteId = randomUUID()
    const stagingEnvId = randomUUID()
    const productionEnvId = randomUUID()
    const defaultLocale = opts.defaultLocale ?? 'id-ID'
    const locales = opts.locales ?? [defaultLocale]

    await client.query('BEGIN')
    await client.query("SET LOCAL webdesk.platform_ctx = 'true'")
    await client.query(
      `INSERT INTO tenants (id, slug, company_ref, status, default_locale, locales)
       VALUES ($1, $2, $3, 'active', $4, $5)`,
      [tenantId, slug, randomUUID(), defaultLocale, locales],
    )
    await client.query("SET LOCAL webdesk.platform_ctx = ''")
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId])
    await client.query(`INSERT INTO sites (id, tenant_id, kind, name) VALUES ($1, $2, 'astro', $3)`, [
      siteId,
      tenantId,
      `${opts.label} site`,
    ])
    await client.query(
      `INSERT INTO environments (id, site_id, tenant_id, name, status) VALUES ($1, $2, $3, 'staging', 'active')`,
      [stagingEnvId, siteId, tenantId],
    )
    await client.query(
      `INSERT INTO environments (id, site_id, tenant_id, name, status) VALUES ($1, $2, $3, 'production', 'active')`,
      [productionEnvId, siteId, tenantId],
    )
    await client.query('COMMIT')

    return { tenantId, slug, siteId, stagingEnvId, productionEnvId, defaultLocale, locales }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await client.end()
  }
}

export async function createFixtureCollection(tenant, key) {
  const client = new Client({ connectionString: MIGRATOR_URL })
  await client.connect()
  try {
    const collectionId = randomUUID()
    await client.query('BEGIN')
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenant.tenantId])
    await client.query(`INSERT INTO collections (id, tenant_id, site_id, key) VALUES ($1, $2, $3, $4)`, [
      collectionId,
      tenant.tenantId,
      tenant.siteId,
      key,
    ])
    await client.query('COMMIT')
    return collectionId
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await client.end()
  }
}

/**
 * @param {*} tenant
 * @param {{
 *   collectionId: string, locale: string, slug: string,
 *   publishState?: 'draft'|'scheduled'|'published'|'unpublished',
 *   publishAt?: string|null, unpublishAt?: string|null,
 *   blocks?: unknown[], seo?: Record<string, unknown>,
 *   localizationGroupId?: string, createdAt?: string,
 * }} opts
 */
export async function seedContentItem(tenant, opts) {
  const client = new Client({ connectionString: MIGRATOR_URL })
  await client.connect()
  try {
    const id = randomUUID()
    const groupId = opts.localizationGroupId ?? randomUUID()
    await client.query('BEGIN')
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenant.tenantId])
    await client.query(
      `INSERT INTO content_items
         (id, tenant_id, site_id, collection_id, locale, slug, localization_group_id, blocks, seo,
          publish_state, publish_at, unpublish_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, COALESCE($13, now()))`,
      [
        id,
        tenant.tenantId,
        tenant.siteId,
        opts.collectionId,
        opts.locale,
        opts.slug,
        groupId,
        JSON.stringify(opts.blocks ?? [{ type: 'hero', props: { heading: `hello ${opts.slug}` } }]),
        JSON.stringify(opts.seo ?? { title: opts.slug }),
        opts.publishState ?? 'published',
        opts.publishAt ?? null,
        opts.unpublishAt ?? null,
        opts.createdAt ?? null,
      ],
    )
    await client.query('COMMIT')
    return { id, localizationGroupId: groupId }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await client.end()
  }
}

/** @param {*} tenant @param {'staging'|'production'} envName @param {'read'|'write'} scope */
export async function mintFixtureApiKey(tenant, envName, scope) {
  const pepper = process.env.API_KEY_PEPPER
  if (!pepper) throw new Error('API_KEY_PEPPER not set')
  const client = new Client({ connectionString: MIGRATOR_URL })
  await client.connect()
  try {
    const plaintext = `wdsk_test_${randomUUID().replace(/-/g, '')}`
    const keyHash = hashApiKey(plaintext, pepper)
    const envId = envName === 'staging' ? tenant.stagingEnvId : tenant.productionEnvId
    await client.query('BEGIN')
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenant.tenantId])
    await client.query(`INSERT INTO api_keys (env_id, tenant_id, key_hash, scope) VALUES ($1,$2,$3,$4)`, [
      envId,
      tenant.tenantId,
      keyHash,
      scope,
    ])
    await client.query('COMMIT')
    return plaintext
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await client.end()
  }
}

export async function setEnvironmentDomain(tenant, envName, domain) {
  const client = new Client({ connectionString: MIGRATOR_URL })
  await client.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenant.tenantId])
    const envId = envName === 'staging' ? tenant.stagingEnvId : tenant.productionEnvId
    await client.query(`UPDATE environments SET domain = $1 WHERE id = $2`, [domain, envId])
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await client.end()
  }
}
