/**
 * WSK-04 condition 2 — pin the pool subclass.
 *
 * FINDINGS.md's mechanism section is explicit about why this matters: the ENTIRE tenancy story
 * for Payload rests on `postgresAdapter({ pg: tenantAwarePg })` actually resulting in
 * `this.pool = new this.pg.Pool(this.poolOptions)` (db-postgres's own connect.js) constructing an
 * instance of THIS project's `TenantAwarePool`, not a bare `pg.Pool`. That is a documented, typed
 * extension point today (`PgDependency` in @payloadcms/db-postgres/dist/types.d.ts) — but it is
 * still a contract with a third-party package that this project does not control, and a future
 * @payloadcms/db-postgres version could change how (or whether) it uses the `pg` option without
 * that being a "breaking change" from Payload's own point of view. WSK-00's FINDINGS.md names
 * `tenantCheckoutLog` as the observable; this file goes one step further than "the log grew"
 * (which a coincidental, unrelated connection could also produce) and asserts IDENTITY: the exact
 * object `payload.db` is holding as its live pool, the one every real query goes through, must
 * literally be our subclass.
 *
 * This test is DESIGNED to fail loudly, not quietly degrade, the day that stops being true — a
 * version bump that makes it fail here is a regression caught before it becomes a cross-tenant
 * leak, not a coincidence the suite happened to still pass.
 *
 * Run: DATABASE_URI=<app role, schema already pushed+RLS'd> node --import tsx \
 *        test/wsk04-pool-subclass-pin.test.mjs
 */
import { bootPayload } from './payload-boot.mjs'
import { tenantAwarePg, tenantCheckoutLog } from '../src/tenant-pg.mjs'
import { runWithTenant } from '../src/tenant-context.mjs'
import { check, summary } from './lib-server.mjs'

const DATABASE_URI = process.env.DATABASE_URI
if (!DATABASE_URI) throw new Error('DATABASE_URI not set (point it at the webdesk_app role)')

const TENANT_A = '11111111-1111-1111-1111-111111111111'

const TenantAwarePool = tenantAwarePg.Pool

const payload = await bootPayload({ databaseUri: DATABASE_URI })
try {
  // --- Identity, not just behavior: the LIVE pool object db-postgres actually holds ---
  const livePool = payload.db?.pool
  check(
    'payload.db.pool exists (db-postgres actually constructed a pool for this adapter instance)',
    Boolean(livePool),
    `payload.db.pool = ${livePool}`,
  )
  check(
    'the live pool IS our TenantAwarePool subclass, not a bare pg.Pool — instanceof check',
    livePool instanceof TenantAwarePool,
    `constructor name observed: ${livePool?.constructor?.name}. If this fails, ` +
      '@payloadcms/db-postgres stopped constructing its pool from the `pg` option the way ' +
      'connect.js currently does (`this.pool = new this.pg.Pool(this.poolOptions)`) — see this ' +
      "file's header. That is exactly WSK-D16's adapter-patch fallback trigger and must not ship silently.",
  )
  check(
    "the live pool's constructor name is literally 'TenantAwarePool' (defense in depth beyond instanceof, " +
      'which a proxy or a differently-loaded module copy could satisfy without being the real thing)',
    livePool?.constructor?.name === 'TenantAwarePool',
    `got '${livePool?.constructor?.name}'`,
  )

  // --- Behavioral confirmation on BOTH call conventions FINDINGS.md calls out ---
  // (1) the promise form, used by drizzle.transaction() for create/update/delete
  const beforeCreate = tenantCheckoutLog.length
  const created = await runWithTenant(TENANT_A, () =>
    payload.create({
      collection: 'pages',
      data: { tenantId: TENANT_A, title: 'WSK-04 pool-pin check', body: 'x' },
    }),
  )
  check(
    'create() (promise-form Pool#connect, via drizzle.transaction()) grew tenantCheckoutLog',
    tenantCheckoutLog.length > beforeCreate,
    `log length ${beforeCreate} -> ${tenantCheckoutLog.length}`,
  )
  // create() may take more than one checkout (e.g. a transaction BEGIN plus any internal
  // lookups) — every checkout recorded from this point on must carry TENANT_A, none should be
  // null/other, which is the actually load-bearing property (not "the Nth entry specifically").
  const createCheckouts = tenantCheckoutLog.slice(beforeCreate).filter((e) => e.phase === 'checkout')
  check(
    'every checkout recorded during create() carried the correct tenant id (none null, none other)',
    createCheckouts.length > 0 && createCheckouts.every((e) => e.tenantId === TENANT_A),
    JSON.stringify(createCheckouts),
  )

  // (2) the callback form, used internally by pg-pool's own query() convenience method for plain,
  //     non-transactional find()
  const beforeFind = tenantCheckoutLog.length
  await runWithTenant(TENANT_A, () => payload.find({ collection: 'pages', where: { id: { equals: created.id } } }))
  check(
    'find() (callback-form Pool#connect, via pg-pool query()) ALSO grew tenantCheckoutLog',
    tenantCheckoutLog.length > beforeFind,
    `log length ${beforeFind} -> ${tenantCheckoutLog.length}`,
  )

  // --- The negative half of "pin": prove the check ITSELF can fail, not just that it currently
  //     passes — a bare pg.Pool handed to the same adapter option is NOT our subclass. ---
  const pg = (await import('pg')).default
  check(
    'sanity: a bare pg.Pool is correctly rejected by the same instanceof check (the pin can fail)',
    !(new pg.Pool({ connectionString: DATABASE_URI, max: 1 }) instanceof TenantAwarePool),
    'a bare pg.Pool incorrectly passed the TenantAwarePool instanceof check — the check itself is broken',
  )
} finally {
  await payload.destroy()
}

const ok = summary('WSK-04 condition 2 — pool subclass pin')
process.exit(ok ? 0 : 1)
