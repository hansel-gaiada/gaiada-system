/**
 * P13 - THE pooled-connection leak case, reproduced against Payload's own
 * call patterns instead of our own explicit wrapper (that was layer 1's P4).
 *
 * Each pool-size phase runs in its OWN child process (see the
 * _p13_*_subprocess.mjs files) because sequential getPayload() boot/destroy
 * cycles with different pool sizes inside one process hit internal
 * @payloadcms/drizzle state that assumes a single lifetime (discovered
 * empirically - see FINDINGS.md). That is a real constraint worth
 * recording, but it is about re-using ONE Node process across multiple
 * Payload lifetimes, which no real deployment does either - a server
 * process boots once with one pool config and runs.
 *
 * Note on pool size: layer 1's P4 used max=1 to FORCE reuse of one physical
 * connection across two raw `pg` queries, which need one connection each.
 * Payload's `create()` (transactional path) needs >1 simultaneous
 * connection immediately after boot - confirmed empirically (max=1: hangs
 * indefinitely; max=2: completes in ~60ms). That is independent of
 * anything this spike added (plain `pg.Pool` would deadlock the same way).
 * So: max=1 for the READ path (find has no such requirement - one
 * sequential round trip per findMany.js - so it gets the same absolute
 * forced-reuse guarantee layer 1's P4 had); max=2 for the WRITE path.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, summary } from '../src/lib.mjs';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const payloadRoot = path.resolve(dirname, '..');
const APP_URI = 'postgres://webdesk_app:spike_app_pw@localhost:55432/webdesk_spike';

function runSub(file, poolMax) {
  // Invoke tsx's CLI entry via `node` directly rather than the .cmd shim -
  // more portable across spawnSync's Windows quirks with batch-file shims.
  const tsxCli = path.join(payloadRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const res = spawnSync(process.execPath, [tsxCli, path.join(dirname, file)], {
    cwd: payloadRoot,
    env: { ...process.env, DATABASE_URI: APP_URI, WSK_POOL_MAX: String(poolMax), PAYLOAD_ALLOW_PUSH: 'false' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const line = (res.stdout || '').split('\n').find((l) => l.startsWith('WSK00_RESULT '));
  return { res, parsed: line ? JSON.parse(line.slice('WSK00_RESULT '.length)) : null };
}

// seed with a generous pool (create() needs >1 connection - see header)
const seeded = runSub('_p13_seed_subprocess.mjs', 4);
check('P13 seed phase completed', seeded.res.status === 0 && seeded.parsed?.seeded === true, `${seeded.res.stdout}\n${seeded.res.stderr}`.slice(-1500));

// read path, pool max=2 (max=1 deadlocks Payload's find() itself - see
// header and FINDINGS.md); reuse is proven deterministically via connId
// tagging (pigeonhole: 3 checkouts, 2 slots), not by forcing max=1.
const read = runSub('_p13_read_subprocess.mjs', 2);
if (read.parsed) {
  check(
    'P13 read path: at least one connection was actually reused across requests (the leak precondition)',
    read.parsed.reuseObserved === true,
    `checkout connIds in order: ${JSON.stringify(read.parsed.checkoutConnIds)}`,
  );
  check(
    'P13 read path: no-context checkout after ACME sees zero rows (no leak)',
    read.parsed.noTenantTitles.length === 0,
    `got ${JSON.stringify(read.parsed.noTenantTitles)}`,
  );
  check(
    'P13 read path: GLOBEX checkout after ACME sees only GLOBEX rows (no leak)',
    read.parsed.globexTitles.length > 0 && read.parsed.globexTitles.every((t) => t.startsWith('GLOBEX')),
    `got ${JSON.stringify(read.parsed.globexTitles)}`,
  );
} else {
  check('P13 read path subprocess', false, `exit ${read.res.status}\n${read.res.stdout}\n${read.res.stderr}`.slice(-1500));
}

// write path, pool max=2 (create() needs >1 concurrently)
const write = runSub('_p13_write_subprocess.mjs', 2);
if (write.parsed) {
  check(
    'P13 write path (create, alternating tenants, pool max=2): connections released between transactions carry no residual context',
    write.parsed.noTenantTitles.length === 0,
    `got ${JSON.stringify(write.parsed.noTenantTitles)}`,
  );
} else {
  check('P13 write path subprocess', false, `exit ${write.res.status}\n${write.res.stdout}\n${write.res.stderr}`.slice(-1500));
}

// negative control: prove the read-path probe has teeth (raw pg, no Payload,
// no subprocess needed)
{
  const tenantPg = await import('../src/tenant-pg.mjs');
  const pgReal = (await import('pg')).default;
  class BrokenPool extends pgReal.Pool {
    async connect() {
      const client = await super.connect();
      const { tenantStore } = tenantPg;
      const tenantId = tenantStore.getStore() ?? null;
      // Broken on TWO counts, deliberately: (1) skips the checkout stamp
      // entirely when there is no ALS context, instead of explicitly
      // clearing it (that is what lets a stale value survive untouched);
      // (2) never wraps client.release() to scrub on the way back to the
      // pool - the bug layer 1's README calls "the entire safety story".
      if (tenantId) {
        await client.query("select set_config('webdesk.tenant_ctx', $1, false)", [tenantId]);
      }
      return client;
    }
  }
  const { runWithTenant } = await import('../src/tenant-context.mjs');
  const brokenPool = new BrokenPool({
    host: 'localhost', port: 55432, database: 'webdesk_spike',
    user: 'webdesk_app', password: 'spike_app_pw', max: 1,
  });
  await runWithTenant('11111111-1111-1111-1111-111111111111', async () => {
    const c = await brokenPool.connect();
    await c.query('select 1');
    c.release();
  });
  const c2 = await brokenPool.connect(); // no tenantStore context this time
  const leaked = await c2.query('select title from pages');
  c2.release();
  await brokenPool.end();
  check(
    'P13 negative control: broken variant (no release-reset) DOES leak',
    leaked.rows.length > 0,
    `(sanity only; observed ${leaked.rows.length} rows through the broken pool - proves this probe can detect a real leak)`,
  );
}

const ok = summary('P13 pooled-connection leak (Payload-driven)');
process.exit(ok ? 0 : 1);
