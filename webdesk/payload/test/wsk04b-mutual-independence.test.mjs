/**
 * WSK-04b (WSK-D25) — mutual independence, Payload side. This is the deliverable this ticket
 * exists for, not the predicate in src/tenant-access.mjs — it replicates
 * webdesk/api/test/wsk04-mutual-independence.spec.ts's proof shape (read that file's header
 * first; do not re-derive) on the collection WSK-D24 leaves inside Payload's own query layer
 * ("pages"): two blocks, each disabling ONE mechanism and driving the request through the layer
 * left standing, plus the negative/fail-closed controls that prove each block's result is caused
 * by the layer under test, not luck.
 *
 *   1. "RLS OFF, app layer alone" — `pages`' RLS is disabled for the duration of this block (as
 *      `webdesk_owner`, the table's REAL owner here — NOT `webdesk_migrator`; Payload's own
 *      `scripts/setup-schema.mjs` pushes/owns this table via OWNER_URI, unlike
 *      `webdesk/api`'s migration-owned tables where `webdesk_migrator` is the owner. See this
 *      ticket's report for the full note), then real Payload calls go through
 *      `src/tenant-access.mjs`'s `tenantScopedAccess()` unmodified: Local API with
 *      `overrideAccess: false` (the calling convention a tenant-scoped caller opts into) AND
 *      real HTTP REST through the internal listener (`overrideAccess` is never set there —
 *      access always runs). If cross-tenant isolation still holds, it is because of the `access`
 *      predicate, not the database. A raw, predicate-less query is run alongside as the negative
 *      control: same disabled-RLS state, same runtime role, but skips `tenant-access.mjs`
 *      entirely — it MUST leak both tenants, or the block above proves nothing.
 *
 *   2. "App layer bypassed, RLS alone" — Local API calls pass `overrideAccess: true` explicitly
 *      (Payload's OWN default for every Local API call per
 *      `node_modules/payload/dist/collections/operations/local/{find,create,update,delete}.js`,
 *      and per `node_modules/payload/dist/auth/executeAccess.js`'s `if (!overrideAccess)` guard,
 *      this means `tenant-access.mjs`'s functions are never even invoked) — the exact calling
 *      shape `scripts/setup-schema.mjs` and every existing Local API test in this directory
 *      already use, which is why this file changes none of them. Symmetric both directions, plus
 *      a fail-closed no-GUC control. A second, independent proof runs the identical shape as raw
 *      SQL with no Payload code involved at all (mirroring the `api` proof's own layer-2 style),
 *      so the claim does not rest on "Payload's query builder happens to add a filter I can't
 *      see."
 *
 * RLS is always restored byte-identically (even if a check throws) so this file cannot leave the
 * throwaway database in a different RLS state than `scripts/setup-schema.mjs` already put it in.
 * The restore is verified two ways: direct `pg_class`/`pg_policy` facts AND
 * `webdesk/scripts/check-rls-integrity.mjs`'s own `evaluate()` — the exact function the CI gate
 * uses — so "restored" here means what the gate would also accept, not this file's own opinion.
 *
 * Run (see webdesk/payload/README.md "Local verification" for the full runbook this ticket adds
 * to): DATABASE_URI=<webdesk_app role> OWNER_URI=<webdesk_owner role, NOT webdesk_migrator> \
 *      node --import tsx test/wsk04b-mutual-independence.test.mjs
 */
import crypto from 'node:crypto'
import pg from 'pg'
import { bootPayload } from './payload-boot.mjs'
import { runWithTenant } from '../src/tenant-context.mjs'
import { check, summary, startInternal, INTERNAL_URL } from './lib-server.mjs'
import { evaluate } from '../../scripts/check-rls-integrity.mjs'

const DATABASE_URI = process.env.DATABASE_URI
if (!DATABASE_URI) throw new Error('DATABASE_URI not set (point it at the webdesk_app role)')
const OWNER_URI = process.env.OWNER_URI
if (!OWNER_URI) {
  throw new Error(
    'OWNER_URI not set (point it at the webdesk_owner role -- NOT webdesk_migrator: ' +
      'scripts/setup-schema.mjs pushes/owns the "pages" table via OWNER_URI, so webdesk_owner is ' +
      'the real table owner here, unlike webdesk/api\'s migration-owned tables).',
  )
}

// Fresh per run -- no fixed slug/id to collide with a prior manual run against a reused database
// (this project's own convention; see wsk04-mutual-independence.spec.ts's header for why).
const TENANT_A = crypto.randomUUID()
const TENANT_B = crypto.randomUUID()

async function withOwner(fn) {
  const client = new pg.Client({ connectionString: OWNER_URI })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

async function rlsFacts(client) {
  const { rows } = await client.query(`
    SELECT c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'pages'
  `)
  return rows[0]
}

let payload
let internal
let pageA
let pageB

async function seed() {
  payload = await bootPayload({ databaseUri: DATABASE_URI })
  pageA = await runWithTenant(TENANT_A, () =>
    payload.create({ collection: 'pages', data: { tenantId: TENANT_A, title: `wsk04b-a-${TENANT_A}`, body: 'x' } }),
  )
  pageB = await runWithTenant(TENANT_B, () =>
    payload.create({ collection: 'pages', data: { tenantId: TENANT_B, title: `wsk04b-b-${TENANT_B}`, body: 'x' } }),
  )
  check('seed: tenant A page created', typeof pageA?.id !== 'undefined', JSON.stringify(pageA))
  check('seed: tenant B page created', typeof pageB?.id !== 'undefined', JSON.stringify(pageB))
}

async function baselineSanity() {
  const asA = await runWithTenant(TENANT_A, () =>
    payload.find({
      collection: 'pages',
      overrideAccess: false,
      where: { id: { in: [pageA.id, pageB.id] } },
    }),
  )
  check(
    'baseline (both layers active): tenant A sees only its own row (sanity check before disabling anything)',
    asA.docs.length === 1 && asA.docs[0].id === pageA.id,
    JSON.stringify(asA.docs.map((d) => d.id)),
  )
}

async function layer1RlsOffAppAlone() {
  console.log('\n--- layer 1: RLS OFF, app-layer predicate (src/tenant-access.mjs) alone ---')

  const before = await withOwner(rlsFacts)
  check(
    'precondition: RLS is intact before this block starts (enabled+forced+>=1 policy)',
    before.rls_enabled === true && before.rls_forced === true && Number(before.policy_count) >= 1,
    JSON.stringify(before),
  )

  await withOwner((c) => c.query('ALTER TABLE pages DISABLE ROW LEVEL SECURITY'))
  try {
    const disabled = await withOwner(rlsFacts)
    check(
      'confirms RLS is actually OFF for this block (not a no-op toggle)',
      disabled.rls_enabled === false,
      JSON.stringify(disabled),
    )

    // --- Local API, overrideAccess:false: tenant-access.mjs's access.read runs for real ---
    const asALocal = await runWithTenant(TENANT_A, () =>
      payload.find({ collection: 'pages', overrideAccess: false, where: { id: { in: [pageA.id, pageB.id] } } }),
    )
    check(
      "Local API (overrideAccess:false) as tenant A STILL sees only its own row with RLS off — app-layer predicate alone holds",
      asALocal.docs.length === 1 && asALocal.docs[0].id === pageA.id,
      JSON.stringify(asALocal.docs.map((d) => d.id)),
    )

    const asBLocal = await runWithTenant(TENANT_B, () =>
      payload.find({ collection: 'pages', overrideAccess: false, where: { id: { in: [pageA.id, pageB.id] } } }),
    )
    check(
      'symmetric: tenant B via Local API (overrideAccess:false) STILL sees only its own row with RLS off',
      asBLocal.docs.length === 1 && asBLocal.docs[0].id === pageB.id,
      JSON.stringify(asBLocal.docs.map((d) => d.id)),
    )

    // --- REST, via the real internal listener + real HTTP request (route.ts never sets
    //     overrideAccess, so access always runs there regardless of Local API's default) ---
    internal = await startInternal({ databaseUri: DATABASE_URI })

    const restA = await fetch(`${INTERNAL_URL}/api/pages?limit=100`, { headers: { 'x-webdesk-tenant': TENANT_A } })
    const bodyA = await restA.json()
    const idsA = (bodyA.docs ?? []).map((d) => d.id)
    check(
      'REST (internal listener) as tenant A STILL sees only its own row with RLS off',
      idsA.includes(pageA.id) && !idsA.includes(pageB.id),
      `status=${restA.status} ids=${JSON.stringify(idsA)}`,
    )

    const restB = await fetch(`${INTERNAL_URL}/api/pages?limit=100`, { headers: { 'x-webdesk-tenant': TENANT_B } })
    const bodyB = await restB.json()
    const idsB = (bodyB.docs ?? []).map((d) => d.id)
    check(
      'symmetric: REST as tenant B STILL sees only its own row with RLS off',
      idsB.includes(pageB.id) && !idsB.includes(pageA.id),
      `status=${restB.status} ids=${JSON.stringify(idsB)}`,
    )

    // --- Negative control: raw query, no predicate at all, RLS off -> MUST leak both tenants,
    //     proving the app-layer predicate above did the work, not coincidence. ---
    const appClient = new pg.Client({ connectionString: DATABASE_URI })
    await appClient.connect()
    try {
      const { rows } = await appClient.query('SELECT id FROM pages WHERE id = ANY($1)', [[pageA.id, pageB.id]])
      check(
        'negative control: raw query, NO predicate, RLS off -> LEAKS both tenants (proves the access predicate, not luck, protected the requests above)',
        rows.length === 2,
        JSON.stringify(rows.map((r) => r.id)),
      )
    } finally {
      await appClient.end()
    }
  } finally {
    if (internal) {
      await internal.stop()
      internal = undefined
    }
    // Restore EXACTLY what scripts/setup-schema.mjs shipped — byte-identical policy shape.
    await withOwner(async (c) => {
      await c.query('ALTER TABLE pages ENABLE ROW LEVEL SECURITY')
      await c.query('ALTER TABLE pages FORCE ROW LEVEL SECURITY')
      await c.query('DROP POLICY IF EXISTS tenant_isolation ON pages')
      await c.query(`
        CREATE POLICY tenant_isolation ON pages
          USING      ("tenant_id" = nullif(current_setting('webdesk.tenant_ctx', true), ''))
          WITH CHECK ("tenant_id" = nullif(current_setting('webdesk.tenant_ctx', true), ''))
      `)
    })
    const after = await withOwner(rlsFacts)
    check(
      'RLS restored byte-identically (enabled + forced + 1 policy, matching the precondition)',
      after.rls_enabled === true && after.rls_forced === true && Number(after.policy_count) >= 1,
      JSON.stringify(after),
    )
    // evaluate()'s own row shape (webdesk/scripts/check-rls-integrity.mjs's SQL_TENANT_TABLES
    // column aliases): rls_enabled / rls_forced / policy_count -- NOT relrowsecurity/
    // relforcerowsecurity (the pg_class column names rlsFacts() above reads, which happen to
    // differ from evaluate()'s field names; a mismatch here would silently read `undefined` and
    // evaluate() would report a false RLS-disabled finding even though rlsFacts() above already
    // confirmed the real state directly against pg_class).
    const gateFindings = evaluate([
      {
        table_name: 'pages',
        rls_enabled: after.rls_enabled,
        rls_forced: after.rls_forced,
        policy_count: after.policy_count,
      },
    ])
    check(
      "the CI gate's OWN evaluate() (scripts/check-rls-integrity.mjs) confirms pages intact after restore — not this file's own opinion of 'restored'",
      gateFindings.length === 0,
      JSON.stringify(gateFindings),
    )
  }
}

async function layer2AppBypassedRlsAlone() {
  console.log('\n--- layer 2: app-layer predicate BYPASSED (overrideAccess:true), RLS alone ---')

  // --- (a) the real Payload Local API path, with the EXACT calling convention
  //     scripts/setup-schema.mjs and every existing Local API test already use by default:
  //     overrideAccess:true means tenant-access.mjs's functions are never invoked at all. ---
  const asALocal = await runWithTenant(TENANT_A, () =>
    payload.find({ collection: 'pages', overrideAccess: true, where: { id: { in: [pageA.id, pageB.id] } } }),
  )
  check(
    'Local API (overrideAccess:true — app layer BYPASSED) as tenant A sees only its own row — RLS alone holds',
    asALocal.docs.length === 1 && asALocal.docs[0].id === pageA.id,
    JSON.stringify(asALocal.docs.map((d) => d.id)),
  )

  const asBLocal = await runWithTenant(TENANT_B, () =>
    payload.find({ collection: 'pages', overrideAccess: true, where: { id: { in: [pageA.id, pageB.id] } } }),
  )
  check(
    'symmetric: tenant B, app layer bypassed, sees only its own row',
    asBLocal.docs.length === 1 && asBLocal.docs[0].id === pageB.id,
    JSON.stringify(asBLocal.docs.map((d) => d.id)),
  )

  const noContextLocal = await payload.find({
    collection: 'pages',
    overrideAccess: true,
    where: { id: { in: [pageA.id, pageB.id] } },
  })
  check(
    'fail-closed control: app layer bypassed, NO tenant context at all -> ZERO rows (not an error, not both tenants)',
    noContextLocal.docs.length === 0,
    JSON.stringify(noContextLocal.docs.map((d) => d.id)),
  )

  // --- (b) raw SQL, no Payload code involved at all, under the real GUC only -- mirrors
  //     wsk04-mutual-independence.spec.ts's own layer-2 style so the claim does not rest on
  //     "Payload's query builder happens to add a filter I can't see." ---
  async function rawUnderGuc(tenantId) {
    const client = new pg.Client({ connectionString: DATABASE_URI })
    await client.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId])
      const { rows } = await client.query('SELECT id FROM pages WHERE id = ANY($1)', [[pageA.id, pageB.id]])
      return rows.map((r) => r.id)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      await client.end()
    }
  }

  const rawA = await rawUnderGuc(TENANT_A)
  check(
    'raw query (no site/tenant WHERE clause at all) under tenant A GUC sees ONLY tenant A row — RLS alone',
    rawA.length === 1 && rawA[0] === pageA.id,
    JSON.stringify(rawA),
  )

  const rawB = await rawUnderGuc(TENANT_B)
  check(
    'symmetric: raw query under tenant B GUC sees ONLY tenant B row',
    rawB.length === 1 && rawB[0] === pageB.id,
    JSON.stringify(rawB),
  )

  const appClientNoGuc = new pg.Client({ connectionString: DATABASE_URI })
  await appClientNoGuc.connect()
  try {
    const { rows } = await appClientNoGuc.query('SELECT id FROM pages WHERE id = ANY($1)', [[pageA.id, pageB.id]])
    check(
      'fail-closed control: raw query with NO GUC set at all sees ZERO rows (not both, not an error)',
      rows.length === 0,
      JSON.stringify(rows.map((r) => r.id)),
    )
  } finally {
    await appClientNoGuc.end()
  }
}

try {
  await seed()
  await baselineSanity()
  await layer1RlsOffAppAlone()
  await layer2AppBypassedRlsAlone()

  // Sanity: both layers active again, back to baseline behavior (proves layer 1's cleanup ran).
  const finalA = await runWithTenant(TENANT_A, () =>
    payload.find({ collection: 'pages', overrideAccess: false, where: { id: { in: [pageA.id, pageB.id] } } }),
  )
  check(
    'sanity: both layers restored, back to baseline behavior',
    finalA.docs.length === 1 && finalA.docs[0].id === pageA.id,
    JSON.stringify(finalA.docs.map((d) => d.id)),
  )
} finally {
  if (internal) await internal.stop()
  if (payload) await payload.destroy()
}

const ok = summary('WSK-04b — Payload app-layer predicate vs RLS, mutual independence')
process.exit(ok ? 0 : 1)
