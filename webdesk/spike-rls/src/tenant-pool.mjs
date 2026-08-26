/**
 * The mechanism under test.
 *
 * Payload/Drizzle takes a `pg` Pool and issues queries on pooled connections it
 * checks out itself. We cannot hook "every Payload operation", so we hook the
 * layer underneath: the Pool. Two candidate strategies, both probed:
 *
 *   TX      - run the work inside a transaction and use SET LOCAL. Correct by
 *             construction (SET LOCAL dies with the transaction) but requires
 *             every caller to be inside a transaction.
 *   SESSION - set_config(..., false) on checkout, RESET on release. Works for
 *             non-transactional callers, but the GUC lives on a SHARED pooled
 *             connection, so a missed reset leaks tenant A's context to
 *             whoever gets that connection next. Probe 4 exists to catch that.
 */
import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';

export const tenantStore = new AsyncLocalStorage();

export function makePool({ user, password, max = 4 }) {
  const pool = new pg.Pool({
    host: 'localhost', port: 55432, database: 'webdesk_spike',
    user, password, max,
  });

  // SESSION strategy: stamp the GUC when a connection is checked out, and
  // scrub it when it goes back. The scrub is the entire safety story.
  pool.on('connect', async (client) => {
    client.__spikeTenant = null;
  });

  return pool;
}

/** SESSION strategy - explicit checkout so we control set + reset. */
export async function withTenantSession(pool, tenantId, fn) {
  const client = await pool.connect();
  try {
    if (tenantId !== null) {
      await client.query("SELECT set_config('webdesk.tenant_ctx', $1, false)", [tenantId]);
    }
    return await fn(client);
  } finally {
    // THE critical line. Remove it and probe 4 fails.
    await client.query("SELECT set_config('webdesk.tenant_ctx', '', false)").catch(() => {});
    client.release();
  }
}

/** TX strategy - SET LOCAL inside a transaction; self-scrubbing. */
export async function withTenantTx(pool, tenantId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (tenantId !== null) {
      await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId]);
    }
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Deliberately broken variant, used only to prove probe 4 can actually fail. */
export async function withTenantSessionNoReset(pool, tenantId, fn) {
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, false)", [tenantId]);
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Checkout with NO tenant context set at all - the second half of the negative control. */
export async function withTenantSessionNoReset2(pool, fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
