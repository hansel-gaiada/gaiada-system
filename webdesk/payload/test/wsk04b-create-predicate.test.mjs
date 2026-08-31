/**
 * WSK-04b (WSK-D25) — positive control for the WRITE side of src/tenant-access.mjs.
 *
 * wsk04b-mutual-independence.test.mjs exercises `access.read` (via `find`) under both mechanisms
 * disabled in turn; it never forces a create through the access-denied path, so this file is the
 * targeted proof that `tenantScopedCreate` is actually live, not merely present in
 * `payload.config.ts` and never hit. Two things are asserted, both with RLS fully intact (this
 * file is not part of the mutual-independence proof; it is coverage for a code path that proof
 * does not reach):
 *
 *   1. `overrideAccess: false` + a `create` whose `data.tenantId` does NOT match the tenant
 *      `runWithTenant()` established -- Payload's access system refuses it (a `Forbidden` thrown
 *      before anything reaches Postgres), and no row lands. Also confirms this is genuinely the
 *      APP layer's own decision, not RLS reacting: the thrown error is Payload's typed
 *      `Forbidden`, not a Postgres constraint-violation bubbling up.
 *   2. `overrideAccess: false` + a matching `data.tenantId` succeeds (the predicate does not
 *      false-positive on the caller it's supposed to let through).
 *
 * Run: DATABASE_URI=<webdesk_app role> node --import tsx test/wsk04b-create-predicate.test.mjs
 */
import crypto from 'node:crypto'
import { bootPayload } from './payload-boot.mjs'
import { runWithTenant } from '../src/tenant-context.mjs'
import { check, summary } from './lib-server.mjs'

const DATABASE_URI = process.env.DATABASE_URI
if (!DATABASE_URI) throw new Error('DATABASE_URI not set (point it at the webdesk_app role)')

const TENANT_A = crypto.randomUUID()
const TENANT_B = crypto.randomUUID()

const payload = await bootPayload({ databaseUri: DATABASE_URI })
try {
  // --- (1) cross-tenant create attempt: context says A, data says B ---
  let forbiddenName
  let forbiddenMessage
  let created
  try {
    created = await runWithTenant(TENANT_A, () =>
      payload.create({
        collection: 'pages',
        overrideAccess: false,
        data: { tenantId: TENANT_B, title: 'wsk04b forged cross-tenant create', body: 'x' },
      }),
    )
  } catch (err) {
    forbiddenName = err?.name
    forbiddenMessage = err?.message
  }
  check(
    'create() with data.tenantId != resolved tenant is REFUSED by the app-layer predicate (throws, no doc returned)',
    typeof created === 'undefined',
    `unexpectedly got: ${JSON.stringify(created)}`,
  )
  check(
    "the refusal is Payload's own typed Forbidden -- the APP layer's decision, not a raw Postgres error bubbling up",
    forbiddenName === 'Forbidden' || /forbidden/i.test(String(forbiddenMessage)),
    `name=${forbiddenName} message=${forbiddenMessage}`,
  )

  // Confirm no row actually landed for the forged tenant (belt + suspenders: the throw alone
  // proves the operation was refused, this proves it left no residue).
  const leaked = await runWithTenant(TENANT_B, () =>
    payload.find({ collection: 'pages', overrideAccess: false, where: { tenantId: { equals: TENANT_B } } }),
  )
  check(
    'no row landed under tenant B from the refused forged create',
    leaked.docs.length === 0,
    JSON.stringify(leaked.docs.map((d) => d.id)),
  )

  // --- (2) legitimate create: context and data agree -- the predicate must not false-positive ---
  const ok = await runWithTenant(TENANT_A, () =>
    payload.create({
      collection: 'pages',
      overrideAccess: false,
      data: { tenantId: TENANT_A, title: 'wsk04b legitimate create', body: 'x' },
    }),
  )
  check('create() with matching data.tenantId succeeds under the app-layer predicate', typeof ok?.id !== 'undefined', JSON.stringify(ok))
} finally {
  await payload.destroy()
}

const ok = summary('WSK-04b — create-side app-layer predicate positive control')
process.exit(ok ? 0 : 1)
