/**
 * WSK-14 item 5 — "Validate the two differently-composed tenants WSK-06's contract suite already
 * uses, so the validator is exercised against real compositions rather than toy ones."
 *
 * Reuses test/v1-fixtures.mjs's `createFixtureTenant`/`createFixtureCollection` verbatim (same
 * helpers test/envelope-contract.test.mjs uses) with the SAME tenant shapes and collection keys
 * that suite already establishes as "the two differently-composed tenants":
 *   - tenant A: id-ID default + en-US, collections `case-study` + `post`
 *   - tenant B: en-US only, collection `article`
 * (see test/envelope-contract.test.mjs §"Fixtures: two DIFFERENTLY-COMPOSED tenants").
 *
 * WSK-06 never populated `collections.schema` for these page-shaped collections (verified by
 * reading v1-fixtures.mjs's `createFixtureCollection` — it leaves the column at its DB default
 * `{}`), so this file writes real Layer-2 composition data into the SAME collection rows via
 * direct SQL (same connection/GUC pattern v1-fixtures.mjs itself uses), reads it back through a
 * live round-trip, and validates it. It ALSO fetches the real `redirect` collection's schema —
 * the one composition WSK-06 actually shipped (redirects.ts `ensureRedirectCollection`) — proving
 * the validator accepts what is already live, not just synthetic data invented for this ticket.
 *
 * Requires the same env vars as envelope-contract.test.mjs: DATABASE_URI is NOT needed (this file
 * never goes through the /v1 router), only MIGRATE_DATABASE_URL.
 *
 * Run: node --import tsx test/wsk14-two-tenants.test.mjs
 */
import { Client } from 'pg'
import { createFixtureTenant, createFixtureCollection } from './v1-fixtures.mjs'
import { validateTenantComposition, formatCompositionIssues } from '../vocabulary/composition.ts'

const MIGRATOR_URL = process.env.MIGRATE_DATABASE_URL
if (!MIGRATOR_URL) throw new Error('MIGRATE_DATABASE_URL not set')

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

/** Writes a Layer-2 composition into an EXISTING collections row, same GUC pattern as every other
 *  v1-fixtures.mjs helper (set tenant_ctx, single statement, own connection). Not an edit to
 *  v1-fixtures.mjs — this ticket owns only NEW test/wsk14-*.test.mjs files. */
async function writeCollectionSchema(tenant, collectionId, schema) {
  const client = new Client({ connectionString: MIGRATOR_URL })
  await client.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenant.tenantId])
    await client.query(`UPDATE collections SET schema = $1 WHERE id = $2`, [JSON.stringify(schema), collectionId])
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await client.end()
  }
}

/** Reads a collection's `key` + `schema` straight back out of Postgres — a real jsonb round-trip,
 *  not the in-memory object this file constructed. */
async function readCollection(tenant, collectionId) {
  const client = new Client({ connectionString: MIGRATOR_URL })
  await client.connect()
  try {
    // set_config(..., true) is transaction-LOCAL (v1-fixtures.mjs's own pattern) — under
    // autocommit (no explicit BEGIN), each statement is its own implicit transaction, so the GUC
    // set here would vanish before the SELECT below ever ran, and RLS would fail-closed to zero
    // rows (the standing "RLS zero-row trap": unset GUC => ZERO rows, no error). Both statements
    // MUST share one transaction.
    await client.query('BEGIN')
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenant.tenantId])
    const { rows } = await client.query(`SELECT key, schema FROM collections WHERE id = $1`, [collectionId])
    await client.query('COMMIT')
    if (!rows[0]) throw new Error(`collection ${collectionId} not found under tenant ${tenant.slug}`)
    return rows[0]
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await client.end()
  }
}

try {
  // ===========================================================================================
  // Tenant A: id-ID default + en-US — case-study (hero + richText + cta, matches the blocks
  // envelope-contract.test.mjs actually seeds: `[{ type: 'hero', ... }, { type: 'richText', ... }]`
  // for its published items) and post (richText only — a lighter-weight collection).
  // ===========================================================================================
  const tenantA = await createFixtureTenant({ label: 'wsk14a', defaultLocale: 'id-ID', locales: ['id-ID', 'en-US'] })
  const caseStudyA = await createFixtureCollection(tenantA, 'case-study')
  const postA = await createFixtureCollection(tenantA, 'post')

  await writeCollectionSchema(tenantA, caseStudyA, { blocks: ['hero', 'richText', 'cta', 'testimonial'] })
  await writeCollectionSchema(tenantA, postA, {
    fields: [{ name: 'excerpt', primitive: 'text' }],
    blocks: ['richText'],
  })

  const caseStudyRowA = await readCollection(tenantA, caseStudyA)
  const postRowA = await readCollection(tenantA, postA)

  const tenantAComposition = {
    [caseStudyRowA.key]: caseStudyRowA.schema,
    [postRowA.key]: postRowA.schema,
  }
  const resultA = validateTenantComposition(tenantAComposition)
  check(
    '[tenant A, id-ID default, case-study + post] real DB-round-tripped composition validates clean',
    resultA.valid,
    JSON.stringify(resultA.issues),
  )
  check('[tenant A] the composition read back has the collection keys actually stored', Object.keys(tenantAComposition).sort().join(',') === 'case-study,post')

  // ===========================================================================================
  // Tenant B: en-US only — article (hero only, matching envelope-contract.test.mjs's seed, which
  // omits `blocks` and gets the default `[{ type: 'hero', ... }]`).
  // ===========================================================================================
  const tenantB = await createFixtureTenant({ label: 'wsk14b', defaultLocale: 'en-US', locales: ['en-US'] })
  const articleB = await createFixtureCollection(tenantB, 'article')
  await writeCollectionSchema(tenantB, articleB, { blocks: ['hero'] })

  const articleRowB = await readCollection(tenantB, articleB)
  const tenantBComposition = { [articleRowB.key]: articleRowB.schema }
  const resultB = validateTenantComposition(tenantBComposition)
  check('[tenant B, en-US only, article] real DB-round-tripped composition validates clean', resultB.valid, JSON.stringify(resultB.issues))

  // Confirm the two tenants really ARE differently composed (not two copies of the same shape) —
  // the AC's own phrase, made concrete: different collection keys, different block sets.
  check(
    'tenant A and tenant B are genuinely differently composed (different collection keys)',
    JSON.stringify(Object.keys(tenantAComposition).sort()) !== JSON.stringify(Object.keys(tenantBComposition).sort()),
  )

  // ===========================================================================================
  // The REAL shipped `redirect` collection (redirects.ts `ensureRedirectCollection`) — the one
  // Layer-2 composition already live in this codebase before this ticket, not a fixture invented
  // for it. Proves the validator accepts what WSK-06 actually shipped.
  // ===========================================================================================
  const { ensureRedirectCollection } = await import('../collections/redirects.ts')
  // ensureRedirectCollection wants a raw PoolClient with tenant_ctx already set — reuse the same
  // GUC pattern via a fresh pg Client cast loosely (it only calls .query on the client).
  {
    const client = new Client({ connectionString: MIGRATOR_URL })
    await client.connect()
    let redirectId
    try {
      // ensureRedirectCollection issues a SELECT then (first call only) an INSERT on the same
      // client — both need the SAME transaction-local GUC, per the note in readCollection above.
      await client.query('BEGIN')
      await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantA.tenantId])
      redirectId = await ensureRedirectCollection(client, tenantA.tenantId, tenantA.siteId)
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      await client.end()
    }
    {
      const redirectRow = await readCollection(tenantA, redirectId)
      const resultRedirect = validateTenantComposition({ [redirectRow.key]: redirectRow.schema })
      check(
        'the REAL shipped redirect collection (redirects.ts, live in this codebase) validates clean through the WSK-14 validator',
        resultRedirect.valid,
        JSON.stringify(resultRedirect.issues),
      )
      check('the redirect collection key is exactly "redirect"', redirectRow.key === 'redirect', redirectRow.key)
    }
  }

  // ===========================================================================================
  // Negative control: a third, deliberately-broken tenant composition, written and read back
  // through the SAME real DB round-trip, to confirm rejection survives jsonb serialization (not
  // just in-memory JS objects) — with the exact actionable error the ticket asks for.
  // ===========================================================================================
  const tenantC = await createFixtureTenant({ label: 'wsk14c', defaultLocale: 'en-US', locales: ['en-US'] })
  const brokenC = await createFixtureCollection(tenantC, 'landing-page')
  await writeCollectionSchema(tenantC, brokenC, { blocks: ['hero', 'pricingTable'] }) // pricingTable does not exist
  const brokenRowC = await readCollection(tenantC, brokenC)
  const resultC = validateTenantComposition({ [brokenRowC.key]: brokenRowC.schema })
  check('an out-of-vocabulary construct survives the DB round-trip and is still rejected', !resultC.valid, JSON.stringify(resultC.issues))
  const messages = formatCompositionIssues(resultC.issues)
  check('the actual rejection message names the offending path and the known set', messages.some((m) => m.includes('landing-page.blocks[1]') && m.includes('pricingTable')), JSON.stringify(messages))
  console.log(`  >>> actual rejection (post-DB-round-trip): ${messages.join(' | ')}`)

  console.log(`\n  WSK-14 two-tenants (DB-backed) suite: ${pass} passed, ${fail} failed`)
  process.exitCode = fail === 0 ? 0 : 1
} catch (err) {
  console.error(err)
  process.exitCode = 1
}
