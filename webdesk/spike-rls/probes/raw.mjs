/**
 * WSK-00 probes, layer 1: the mechanism itself, no Payload involved.
 * If these fail, nothing above them can be made safe.
 */
import { makePool, withTenantSession, withTenantTx, withTenantSessionNoReset, withTenantSessionNoReset2 } from '../src/tenant-pool.mjs';

const ACME   = '11111111-1111-1111-1111-111111111111';
const GLOBEX = '22222222-2222-2222-2222-222222222222';

let pass = 0, fail = 0;
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else    { fail++; console.log(`  FAIL  ${name} -- ${detail}`); }
}

const app = makePool({ user: 'webdesk_app', password: 'spike_app_pw', max: 1 });

// P1/P2 - scoping works, both directions
for (const [label, tid, want] of [['acme', ACME, 'ACME'], ['globex', GLOBEX, 'GLOBEX']]) {
  const rows = await withTenantTx(app, tid, c => c.query('SELECT title FROM content_items').then(r => r.rows));
  check(`P1 ${label}: sees only own rows`,
    rows.length === 2 && rows.every(r => r.title.startsWith(want)),
    `got ${JSON.stringify(rows.map(r => r.title))}`);
}

// P3 - fail-closed: no GUC must mean ZERO ROWS, not an error, not everything
try {
  const rows = await withTenantTx(app, null, c => c.query('SELECT title FROM content_items').then(r => r.rows));
  check('P3 no GUC: zero rows, no error (fail-closed)', rows.length === 0, `got ${rows.length} rows`);
} catch (e) {
  check('P3 no GUC: zero rows, no error (fail-closed)', false, `threw instead: ${e.message}`);
}

// P4 - THE pooled-connection leak probe. Reuse one connection across two tenants.
{
  await withTenantSession(app, ACME, c => c.query('SELECT 1'));
  const rows = await withTenantSession(app, null, c => c.query('SELECT title FROM content_items').then(r => r.rows));
  check('P4 session strategy: context does NOT survive connection reuse',
    rows.length === 0, `LEAK - saw ${rows.length} rows from a previous tenant's context`);
}

// P4b - NEGATIVE CONTROL. A probe that cannot fail proves nothing, so run P4's
// exact scenario against the variant that skips the reset. This MUST leak. If it
// does not, P4's pass is meaningless and the whole suite is decorative.
{
  await withTenantSessionNoReset(app, ACME, c => c.query('SELECT 1'));
  // Second checkout sets NO tenant context at all. On a max:1 pool this is
  // physically the same connection. If the reset is absent, ACME's context is
  // still stamped on it and this query sees ACME's rows.
  const rows = await withTenantSessionNoReset2(app, c =>
    c.query('SELECT title FROM content_items').then(r => r.rows));
  check('P4b NEGATIVE CONTROL: without the reset, context DOES leak (proves P4 has teeth)',
    rows.length > 0 && rows.every(r => r.title.startsWith('ACME')),
    `expected a leak of ACME rows, saw ${rows.length}: ${JSON.stringify(rows.map(r => r.title))}`);
}

// P5 - write probe: cannot insert into another tenant
try {
  await withTenantTx(app, ACME, c => c.query(
    "INSERT INTO content_items (id, tenant_id, title) VALUES (gen_random_uuid(), $1, 'smuggled')", [GLOBEX]));
  check('P5 cross-tenant INSERT refused', false, 'insert SUCCEEDED - WITH CHECK not enforcing');
} catch (e) {
  check('P5 cross-tenant INSERT refused', /row-level security/i.test(e.message), e.message);
}

// P6 - app role must not be able to DDL
try {
  await withTenantTx(app, ACME, c => c.query('CREATE TABLE spike_should_not_exist (x int)'));
  check('P6 app role cannot DDL', false, 'CREATE TABLE succeeded as app role');
} catch (e) {
  check('P6 app role cannot DDL', /permission denied/i.test(e.message), e.message);
}

// P7 - the app role must not be able to turn RLS off
try {
  await withTenantTx(app, ACME, c => c.query('ALTER TABLE content_items DISABLE ROW LEVEL SECURITY'));
  check('P7 app role cannot disable RLS', false, 'DISABLE RLS succeeded as app role');
} catch (e) {
  check('P7 app role cannot disable RLS', /must be owner|permission denied/i.test(e.message), e.message);
}

await app.end();

console.log(`\n  raw layer: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
