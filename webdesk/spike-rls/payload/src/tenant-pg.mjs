/**
 * WSK-00 layer 2 - the pool-layer GUC hook, generalised for Payload.
 *
 * Layer 1 (../../src/tenant-pool.mjs) proved the mechanism with code we fully
 * control: explicit wrapper functions around every checkout. Payload never
 * gives us that call site - Drizzle checks out and releases connections from
 * `this.pool` internally, on paths we do not author (plain `find`, the admin
 * SSR data loader, the REST handler's internal query issuance, the jobs
 * runner). The question this file answers: can the SESSION strategy be
 * pushed one layer DOWN, onto the `pg.Pool` class itself, so it applies
 * automatically no matter which internal path Payload takes?
 *
 * Mechanism: `@payloadcms/db-postgres`'s `postgresAdapter({ pg, pool, ... })`
 * takes a `pg` option typed `PgDependency` (see
 * node_modules/@payloadcms/db-postgres/dist/types.d.ts) and does exactly
 * `this.pool = new this.pg.Pool(this.poolOptions)` (dist/connect.js). That is
 * an OFFICIAL, TYPED extension point - passing a shaped-like-`pg` object with
 * a custom `Pool` class is not a patch of the adapter's source, it is using
 * the surface the adapter documents. Every internal Drizzle/node-postgres
 * code path that wants a connection - `pool.connect()` directly (used by
 * `drizzle.transaction()`, which is what Payload's create/update/delete
 * transactions run through) or the `pool.query()` convenience method (used
 * by the plain, non-transactional `find` path) - resolves to
 * `Pool.prototype.connect` under the hood, so overriding just that one method
 * on a subclass covers both.
 *
 * The tenant value itself comes from Node's AsyncLocalStorage - the SAME
 * `tenantStore` instance layer 1 exports, imported read-only. Whoever sits at
 * the edge of a request (our own REST/admin route wrappers, our own job
 * handler) is responsible for calling `tenantStore.run(tenantId, fn)`. This
 * file's only job is: whatever value is active in ALS when a connection is
 * checked out, stamp it on that physical connection before handing it back,
 * and scrub it before the connection returns to the pool - regardless of who
 * asked for the connection or why.
 */
import pg from 'pg';
import { tenantStore } from '../../src/tenant-pool.mjs';

const GUC = 'webdesk.tenant_ctx';

/** Every checkout+release passes through here, whoever calls it. */
export const tenantCheckoutLog = [];

// Tags each PHYSICAL client with a stable id the first time it is seen, so
// probes can prove "request B reused the exact same connection request A
// just used" directly - a stronger, deterministic proof of reuse than
// forcing pool max=1 (which, empirically, deadlocks Payload's own find()/
// create() - see FINDINGS.md "operational hazard #2"). With pool max=N and
// N+1 sequential checkouts, pigeonhole guarantees at least one repeat.
const connIds = new WeakMap();
let connCounter = 0;
function idFor(client) {
  if (!connIds.has(client)) connIds.set(client, `conn-${++connCounter}`);
  return connIds.get(client);
}

class TenantAwarePool extends pg.Pool {
  /**
   * node-postgres's Pool.connect() genuinely has two call conventions, and
   * both are load-bearing: `pool.connect()` (promise, used by
   * `drizzle.transaction()` for the create/update/delete path) AND
   * `pool.connect(cb)` (node-style callback, used internally by
   * `pg-pool`'s own `query()` method - which is exactly what the plain,
   * non-transactional `find` path resolves to). The first draft of this
   * file only handled the promise form and threw on the callback form; it
   * surfaced immediately (see FINDINGS.md P8) the moment Payload's schema
   * push issued a plain query. Left in as the concrete reason this file
   * bridges both styles through one implementation instead of assuming
   * Payload "only ever" uses one of them.
   */
  connect(cb) {
    const promise = this.#tenantAwareConnect();
    if (typeof cb === 'function') {
      promise.then(
        (client) => cb(null, client, client.release),
        (err) => cb(err),
      );
      return undefined;
    }
    return promise;
  }

  async #tenantAwareConnect() {
    // Always go through the base class's zero-arg (promise) form, which is
    // the one documented path that hands back a client with a working,
    // already-bound `.release()` - we do not reimplement pg-pool's
    // PendingItem/newClient queuing ourselves.
    const client = await super.connect();
    const tenantId = tenantStore.getStore() ?? null;
    const connId = idFor(client);

    tenantCheckoutLog.push({ phase: 'checkout', tenantId, connId });

    // Stamp (or explicitly clear) on EVERY checkout, never conditionally skip
    // the clear branch - the physical connection may have carried a previous
    // tenant's value, and "no ALS context" must mean fail-closed (no GUC),
    // not "whatever was left over from the last borrower."
    await client.query(
      "select set_config($1, $2, false)",
      [GUC, tenantId ?? ''],
    );

    const originalRelease = client.release.bind(client);
    client.release = (errOrDone) => {
      // THE critical line, same as layer 1: scrub before the connection is
      // visible to the next checkout. Delaying the call to originalRelease
      // until the reset settles is what keeps this safe under reuse -
      // node-postgres does not consider the client available again until
      // release() actually runs.
      client
        .query("select set_config($1, '', false)", [GUC])
        .catch(() => {})
        .finally(() => {
          tenantCheckoutLog.push({ phase: 'release', tenantId, connId });
          originalRelease(errOrDone);
        });
    };

    return client;
  }
}

/** Shaped like the `pg` module, for the adapter's `pg` option. */
export const tenantAwarePg = { ...pg, Pool: TenantAwarePool };

export { tenantStore };
