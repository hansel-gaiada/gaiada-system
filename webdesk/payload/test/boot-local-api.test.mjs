/**
 * WSK-02 boot proof, part 1/2 — Local API. Deliberately its own process (see
 * boot-rest-admin.test.mjs's header for why): booting a Payload/db-postgres instance, destroying
 * it, then booting a SECOND one via a cache-busted config re-import in the SAME Node process
 * leaves the second instance's `adapter.tables` empty (`payload.db.tables` has zero entries) and
 * every `find`/`create` throws `Cannot read properties of undefined (reading 'id')` inside
 * `@payloadcms/drizzle`'s `buildQuery`. Reproduced in isolation, with no internal-listener child
 * process involved at all — a plain "boot, use, destroy, boot again" in one process is enough.
 * This is upstream state left over from the first boot (root cause not traced further — out of
 * this ticket's scope to fix a Payload/drizzle limitation), not a defect in the tenancy
 * mechanism this ticket ports. The practical fix is process isolation: one Payload Local-API
 * boot per Node process, which is what npm run test:boot now does (runs this file, then
 * boot-rest-admin.test.mjs, as two separate `node` invocations).
 */
import { bootPayload } from './payload-boot.mjs'
import { runWithTenant } from '../src/tenant-context.mjs'
import { tenantCheckoutLog } from '../src/tenant-pg.mjs'
import { check, summary } from './lib-server.mjs'

const DATABASE_URI = process.env.DATABASE_URI
if (!DATABASE_URI) throw new Error('DATABASE_URI not set (point it at the webdesk_app role)')

const TENANT_A = '11111111-1111-1111-1111-111111111111'
const TENANT_B = '22222222-2222-2222-2222-222222222222'

const payload = await bootPayload({ databaseUri: DATABASE_URI })
try {
  const beforeLen = tenantCheckoutLog.length

  const created = await runWithTenant(TENANT_A, () =>
    payload.create({
      collection: 'pages',
      data: { tenantId: TENANT_A, title: 'WSK-02 boot check — tenant A', body: 'hello' },
    }),
  )
  check('Local API create() returns the created doc', typeof created.id !== 'undefined', JSON.stringify(created))
  check(
    'the pool subclass actually saw this checkout (tenantCheckoutLog grew)',
    tenantCheckoutLog.length > beforeLen,
    `log length ${beforeLen} -> ${tenantCheckoutLog.length}`,
  )

  const asA = await runWithTenant(TENANT_A, () =>
    payload.find({ collection: 'pages', where: { id: { equals: created.id } } }),
  )
  check('Local API find() as tenant A sees its own row', asA.docs.length === 1, JSON.stringify(asA.docs))

  const asB = await runWithTenant(TENANT_B, () =>
    payload.find({ collection: 'pages', where: { id: { equals: created.id } } }),
  )
  check(
    "Local API find() as tenant B does NOT see tenant A's row (fail-closed)",
    asB.docs.length === 0,
    JSON.stringify(asB.docs),
  )

  const noContext = await payload.find({ collection: 'pages', where: { id: { equals: created.id } } })
  check(
    'Local API find() with NO tenant context set sees zero rows (fail-closed, not error)',
    noContext.docs.length === 0,
    JSON.stringify(noContext.docs),
  )
} finally {
  await payload.destroy()
}

const ok = summary('WSK-02 boot probe — Local API')
process.exit(ok ? 0 : 1)
