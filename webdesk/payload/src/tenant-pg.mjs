/**
 * WSK-02 — the pool-layer GUC hook, ported from the WSK-00 spike
 * (spike-rls/payload/src/tenant-pg.mjs) with no mechanism changes. See that file's header and
 * FINDINGS.md for the full derivation; restated briefly here:
 *
 * `@payloadcms/db-postgres`'s `postgresAdapter({ pg, pool, ... })` takes a `pg` option typed
 * `PgDependency` (node_modules/@payloadcms/db-postgres/dist/types.d.ts) and does exactly
 * `this.pool = new this.pg.Pool(this.poolOptions)` (dist/connect.js) — a documented, typed
 * extension point, not a patch of the adapter's source. A subclassed `Pool` passed through that
 * option intercepts BOTH call conventions `Pool.prototype.connect()` resolves to: the promise
 * form (`drizzle.transaction()`, used by create/update/delete) and the callback form (`pg-pool`'s
 * own `query()` convenience method, used by plain, non-transactional `find`). On every checkout it
 * stamps `set_config('webdesk.tenant_ctx', tenantId ?? '', false)` from whatever is active in
 * Node's AsyncLocalStorage at that instant; on release, it resets to `''` before the physical
 * connection becomes visible to the next borrower. This is the SESSION strategy (not TX/
 * `SET LOCAL`) pushed down to the one place every operation — transactional or not — must pass
 * through: `Pool.connect()`. FINDINGS.md's P13 proved this holds under forced connection reuse,
 * including a negative control that reproduces a real leak when the release-scrub is skipped.
 *
 * The only change from the spike file: importing `tenantStore` from `./tenant-pool.mjs` (this
 * project's globalThis-anchored instance — see that file's header) instead of the spike's
 * `../../src/tenant-pool.mjs` (a plain ES-module singleton, which is what P10 found broken for the
 * admin SSR page layer).
 */
import pg from 'pg'
import { tenantStore } from './tenant-pool.mjs'

const GUC = 'webdesk.tenant_ctx'

/** Every checkout+release passes through here, whoever calls it. Used by test/lockdown and
 *  test/boot to prove which code path actually touched the real pool. */
export const tenantCheckoutLog = []

// Tags each PHYSICAL client with a stable id the first time it is seen, so tests can prove
// "request B reused the exact same connection request A just used" — see the spike's P13 comment
// for why this is used instead of forcing pool max=1 (which deadlocks Payload's own find/create).
const connIds = new WeakMap()
let connCounter = 0
function idFor(client) {
  if (!connIds.has(client)) connIds.set(client, `conn-${++connCounter}`)
  return connIds.get(client)
}

class TenantAwarePool extends pg.Pool {
  connect(cb) {
    const promise = this.#tenantAwareConnect()
    if (typeof cb === 'function') {
      promise.then(
        (client) => cb(null, client, client.release),
        (err) => cb(err),
      )
      return undefined
    }
    return promise
  }

  async #tenantAwareConnect() {
    const client = await super.connect()
    const tenantId = tenantStore.getStore() ?? null
    const connId = idFor(client)

    tenantCheckoutLog.push({ phase: 'checkout', tenantId, connId })

    // Stamp (or explicitly clear) on EVERY checkout, never conditionally skip the clear branch —
    // the physical connection may carry a previous tenant's value, and "no ALS context" must mean
    // fail-closed (no GUC), not "whatever was left over from the last borrower."
    await client.query('select set_config($1, $2, false)', [GUC, tenantId ?? ''])

    const originalRelease = client.release.bind(client)
    client.release = (errOrDone) => {
      // THE critical line: scrub before the connection is visible to the next checkout.
      client
        .query("select set_config($1, '', false)", [GUC])
        .catch(() => {})
        .finally(() => {
          tenantCheckoutLog.push({ phase: 'release', tenantId, connId })
          originalRelease(errOrDone)
        })
    }

    return client
  }
}

/** Shaped like the `pg` module, for the adapter's `pg` option. */
export const tenantAwarePg = { ...pg, Pool: TenantAwarePool }

export { tenantStore }
