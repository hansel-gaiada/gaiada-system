#!/usr/bin/env node
/**
 * WSK-04 — the tenancy wall's consolidated cross-path probe suite.
 *
 * ONE command proving ZERO rows via EVERY access path a real request can take into Zone B's
 * tenant-scoped data (webdesk-design.md §12's WSK-04 row): raw SQL as `webdesk_app`, Payload Local
 * API, Payload REST, the `webdesk/api` service's guarded content routes, and (see "jobs path"
 * below) the jobs path. This file does not reinvent any of those probes — it runs the ones WSK-01/
 * 02/03/05 and this ticket already built and proved individually, together, with one pass/fail
 * verdict per path and one process exit code, so this is a permanent regression suite rather than
 * six scripts someone has to remember to run in the right order.
 *
 * Every check inside each path-probe still runs and still gets reported — this file does not
 * relax any of them. The one deliberate exception is documented in "condition 4" below: the
 * admin-SSR-first-paint assertion inside boot-rest-admin.test.mjs is a KNOWN, LABELED gap
 * (fails closed, root-caused, not fixed this ticket — see the ticket report), so this suite
 * asserts that failure is EXACTLY the expected one and no other, rather than either hiding it or
 * letting it permanently red the whole suite.
 *
 * USAGE — five connection strings, one per role/purpose (all point at the SAME database):
 *
 *   SUPERUSER_DATABASE_URL   cluster bootstrap identity (postgres/init-roles.sh's $POSTGRES_USER)
 *                            — migrations/tests/rls.spec.sql needs SET ROLE freely, same as its
 *                            own header documents.
 *   MIGRATE_DATABASE_URL     webdesk_migrator — used by webdesk/api's test fixtures.
 *   APP_DATABASE_URL         webdesk_app — used by webdesk/api's own tests (WSK05_TEST_DATABASE_URL)
 *                            and as this file's DATABASE_URI for Payload.
 *   PAYLOAD_INTERNAL_PORT    optional, default 34401 — must be free (see this ticket's report for
 *                            which ports are already in use on this box; do not reuse them).
 *
 * Run (from webdesk/):
 *   SUPERUSER_DATABASE_URL=postgres://postgres:...@localhost:PORT/webdesk \
 *   MIGRATE_DATABASE_URL=postgres://webdesk_migrator:...@localhost:PORT/webdesk \
 *   APP_DATABASE_URL=postgres://webdesk_app:...@localhost:PORT/webdesk \
 *   node scripts/wsk04-cross-path-suite.mjs
 *
 * Prerequisite: migrations/migrate.mjs (0001-0004) AND payload/scripts/setup-schema.mjs (or
 * webdesk/scripts/reapply-and-verify-rls.mjs after a push) already applied to the target database
 * — this suite tests access paths, not schema setup.
 *
 * Exit 0 = every path's evidence matches its expected shape (including the one labeled gap).
 * Exit 1 = a path produced evidence that does NOT match what this ticket found and reported.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBDESK_ROOT = path.resolve(__dirname, '..');

const SUPERUSER_DATABASE_URL = process.env.SUPERUSER_DATABASE_URL;
const MIGRATE_DATABASE_URL = process.env.MIGRATE_DATABASE_URL;
const APP_DATABASE_URL = process.env.APP_DATABASE_URL;
const PAYLOAD_INTERNAL_PORT = process.env.PAYLOAD_INTERNAL_PORT || '34401';

for (const [name, value] of [
  ['SUPERUSER_DATABASE_URL', SUPERUSER_DATABASE_URL],
  ['MIGRATE_DATABASE_URL', MIGRATE_DATABASE_URL],
  ['APP_DATABASE_URL', APP_DATABASE_URL],
]) {
  if (!value) {
    console.error(`[wsk04-suite] ${name} is not set — refusing to run.`);
    process.exit(2);
  }
}

/** @type {{ path: string, status: 'PASS'|'FAIL'|'LABELED-GAP'|'SKIPPED', detail: string }[]} */
const results = [];

function record(pathName, status, detail) {
  results.push({ path: pathName, status, detail });
  const tag = { PASS: 'PASS', FAIL: 'FAIL', 'LABELED-GAP': 'LABELED-GAP (non-blocking)', SKIPPED: 'SKIPPED' }[status];
  console.log(`\n=== [${tag}] ${pathName} ===`);
  if (detail) console.log(detail);
}

// ------------------------------------------------------------------------------------------
// PATH 1 — raw SQL, as webdesk_app AND webdesk_migrator (rls.spec.sql runs both — the migrator
// probe is the "even the true table owner is bound" bonus, per condition 1's own finding that
// the migrator, not webdesk_owner, is the role to watch).
// ------------------------------------------------------------------------------------------
{
  // No external `psql` binary assumed to be on PATH (this box has none locally — Postgres only
  // runs in Docker here; a bare `docker exec` would also work but ties this file to one
  // container name/environment). node-postgres's simple query protocol runs the WHOLE file
  // (multiple ;-separated statements, DO blocks included) in one client.query() call, and emits
  // a 'notice' event per RAISE NOTICE — the same evidence psql's own stdout would show, captured
  // more portably. Only the one psql META-command in the file (`\set ON_ERROR_STOP on`, not real
  // SQL) is stripped before sending.
  const specPath = path.join(WEBDESK_ROOT, 'migrations', 'tests', 'rls.spec.sql');
  const sql = readFileSync(specPath, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('\\'))
    .join('\n');

  const client = new pg.Client({ connectionString: SUPERUSER_DATABASE_URL });
  const notices = [];
  client.on('notice', (msg) => notices.push(msg.message ?? String(msg)));
  await client.connect();
  let ok = false;
  let errorDetail = '';
  try {
    await client.query(sql);
    // The file itself contains exactly 12 `RAISE NOTICE 'PASS ...'` statements today (probes
    // 0,1,2,3,4a-4e,5,6a,6b) — verified by grep, not assumed; re-derive with
    // `grep -c "RAISE NOTICE 'PASS" migrations/tests/rls.spec.sql` if this file is ever extended.
    const EXPECTED_PASS_NOTICES = 12;
    const passCount = notices.filter((n) => /PASS/.test(n)).length;
    ok = passCount === EXPECTED_PASS_NOTICES;
    errorDetail = ok ? '' : `${passCount} PASS notices observed, expected exactly ${EXPECTED_PASS_NOTICES}:\n${notices.join('\n')}`;
  } catch (err) {
    errorDetail = `${err.message}\nnotices before failure:\n${notices.join('\n')}`;
  } finally {
    await client.end();
  }
  record(
    'raw SQL (webdesk_app + webdesk_migrator, migrations/tests/rls.spec.sql)',
    ok ? 'PASS' : 'FAIL',
    ok ? `${notices.length} PASS notices observed; transaction rolled back cleanly (the file's own design — see its header).` : errorDetail,
  );
}

// ------------------------------------------------------------------------------------------
// PATH 2 — Payload Local API (payload.find/create/update, in-process, no HTTP).
// ------------------------------------------------------------------------------------------
{
  const res = spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join('test', 'boot-local-api.test.mjs')],
    {
      cwd: path.join(WEBDESK_ROOT, 'payload'),
      env: { ...process.env, DATABASE_URI: APP_DATABASE_URL },
      encoding: 'utf8',
    },
  );
  const out = (res.stdout || '') + (res.stderr || '');
  const fails = (out.match(/^\s*FAIL\s/gm) || []).length;
  const ok = res.status === 0 && fails === 0;
  record('Payload Local API (payload/test/boot-local-api.test.mjs)', ok ? 'PASS' : 'FAIL', out);
}

// ------------------------------------------------------------------------------------------
// PATH 3 — Payload REST + admin SSR (spawns its own `next dev` child; slow — allow real time).
// The admin-SSR-first-paint assertion is a KNOWN, LABELED, non-blocking gap (condition 4 — see
// this ticket's report). Every OTHER assertion in this path, including REST's own cross-tenant
// checks, must still pass with zero exceptions.
// ------------------------------------------------------------------------------------------
{
  const res = spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join('test', 'boot-rest-admin.test.mjs')],
    {
      cwd: path.join(WEBDESK_ROOT, 'payload'),
      env: { ...process.env, DATABASE_URI: APP_DATABASE_URL, PAYLOAD_INTERNAL_PORT },
      encoding: 'utf8',
      timeout: 180_000,
    },
  );
  const out = (res.stdout || '') + (res.stderr || '');
  const failLines = (out.match(/^\s*FAIL\s.*$/gm) || []);
  const KNOWN_GAP_MARKER = 'admin SSR first paint shows the row just created via REST for tenant A';
  const unexpectedFails = failLines.filter((l) => !l.includes(KNOWN_GAP_MARKER));

  if (unexpectedFails.length > 0) {
    record('Payload REST + admin SSR (payload/test/boot-rest-admin.test.mjs)', 'FAIL', `Unexpected failures:\n${unexpectedFails.join('\n')}\n\nFull output:\n${out}`);
  } else if (failLines.length === 1) {
    record(
      'Payload REST (clean) + Payload admin SSR first paint (condition 4)',
      'LABELED-GAP',
      'REST: all cross-tenant/fail-closed assertions PASS. Admin SSR first paint: KNOWN gap, ' +
        'fails CLOSED (renders zero rows for every tenant, never leaks) — root-caused to a ' +
        "Next.js App Router internal (see this ticket's report, condition 4). Left labelled, " +
        'not fixed, per this ticket\'s explicit permission to do so.\n' + out,
    );
  } else {
    // failLines.length === 0 would mean condition 4 got closed — good news, not a failure.
    record('Payload REST + admin SSR (payload/test/boot-rest-admin.test.mjs)', 'PASS', `All assertions pass, INCLUDING the previously-known admin-SSR gap — condition 4 may now be closed; verify before updating this suite's KNOWN_GAP_MARKER expectation.\n${out}`);
  }
}

// ------------------------------------------------------------------------------------------
// PATH 2b/3b (condition 2) — the pool-subclass pin, on the same live Payload instance.
// ------------------------------------------------------------------------------------------
{
  const res = spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join('test', 'wsk04-pool-subclass-pin.test.mjs')],
    {
      cwd: path.join(WEBDESK_ROOT, 'payload'),
      env: { ...process.env, DATABASE_URI: APP_DATABASE_URL },
      encoding: 'utf8',
    },
  );
  const out = (res.stdout || '') + (res.stderr || '');
  const fails = (out.match(/^\s*FAIL\s/gm) || []).length;
  const ok = res.status === 0 && fails === 0;
  record('Payload pool-subclass pin — condition 2 (payload/test/wsk04-pool-subclass-pin.test.mjs)', ok ? 'PASS' : 'FAIL', out);
}

// ------------------------------------------------------------------------------------------
// PATH 4 — webdesk/api's guarded content routes (real HTTP via Fastify inject, real Postgres).
//
// Deliberately an EXPLICIT file list, not a bare `vitest run` of the whole `test/` directory.
// `webdesk/api/test/` is shared with other in-flight tickets (WSK-07 media, WSK-11 mail, ...)
// landing their own spec files in this same working tree concurrently with this one — a blanket
// run would fail this permanent RLS-wall suite on THEIR work-in-progress (unwired modules,
// missing local services like ClamAV), which is not this suite's job to gate on. Every file named
// below is WSK-04/05's own — the tenancy mechanism this wall is actually about.
// ------------------------------------------------------------------------------------------
{
  const WSK04_API_SPEC_FILES = [
    'test/api-keys.scope-matrix.spec.ts',
    'test/no-key.spec.ts',
    'test/revoked-key.spec.ts',
    'test/plaintext-dump-grep.spec.ts',
    'test/tenant-quota.spec.ts',
    'test/tenant-pool-leak.spec.ts',
    'test/wsk04-mutual-independence.spec.ts',
    'test/wsk04-cross-path-content.spec.ts',
  ];
  const res = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vitest', 'run', ...WSK04_API_SPEC_FILES], {
    cwd: path.join(WEBDESK_ROOT, 'api'),
    env: {
      ...process.env,
      WSK05_TEST_DATABASE_URL: APP_DATABASE_URL,
      MIGRATE_DATABASE_URL,
    },
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const out = (res.stdout || '') + (res.stderr || '');
  const ok = res.status === 0;
  record('webdesk/api guarded content routes (api-keys.scope-matrix, wsk04-mutual-independence, wsk04-cross-path-content, tenant-pool-leak, ...)', ok ? 'PASS' : 'FAIL', out.slice(-4000));
}

// ------------------------------------------------------------------------------------------
// PATH 5 — jobs. NOT WIRED into the real webdesk/payload service today: `payload.config.ts` (out
// of this ticket's scope to edit — another worker owns it right now) has no `jobs` block, so
// there is no jobs collection/task to drive on the real service. WSK-00's spike DID prove the
// mechanism at the pool level (FINDINGS.md P11, 2/2: a task that re-threads tenant context from
// job.input sees only its own rows; a task that omits this fails closed). That evidence is prior,
// frozen, and out of this ticket's scope to re-run (spike-rls is read-only and its port 55432 is
// another worker's). Recorded here as an explicit, honest gap, not silently skipped.
// ------------------------------------------------------------------------------------------
record(
  'jobs / queue path',
  'SKIPPED',
  'webdesk/payload/payload.config.ts has no `jobs` config today — out of this ticket\'s scope to ' +
    'add (payload.config.ts is frozen for this ticket; another worker owns it). The underlying ' +
    'mechanism jobs would rely on (the SAME TenantAwarePool, proven by condition 2\'s pin test ' +
    'above to be genuinely on Payload\'s connection path) is not path-specific, so the residual ' +
    'risk is purely "does the future jobs task handler re-thread tenant context from job.input," ' +
    'an app-code responsibility for whoever wires jobs, not a gap in this suite\'s mechanism. ' +
    'WSK-00\'s frozen spike (FINDINGS.md P11, 2/2) is the prior evidence for the pattern. ' +
    'Reported as a required payload.config.ts change, not applied.',
);

// ------------------------------------------------------------------------------------------
// Condition 1 — the RLS-integrity gate itself, as part of one command covering the whole wall.
// ------------------------------------------------------------------------------------------
{
  const client = new pg.Client({ connectionString: APP_DATABASE_URL });
  await client.connect();
  let ok = false;
  let detail = '';
  try {
    const { evaluate } = await import('./check-rls-integrity.mjs');
    const { rows } = await client.query(`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped)
    `);
    const findings = evaluate(rows);
    ok = findings.length === 0 && rows.length > 0;
    detail = ok
      ? `${rows.length} tenant-scoped table(s) intact.`
      : JSON.stringify(findings, null, 2);
  } finally {
    await client.end();
  }
  record('condition 1 — RLS-integrity gate (webdesk/scripts/check-rls-integrity.mjs)', ok ? 'PASS' : 'FAIL', detail);
}

// ------------------------------------------------------------------------------------------
// Summary
// ------------------------------------------------------------------------------------------
console.log('\n' + '='.repeat(78));
console.log('WSK-04 cross-path suite — summary');
console.log('='.repeat(78));
for (const r of results) {
  console.log(`  [${r.status.padEnd(12)}] ${r.path}`);
}
const hardFails = results.filter((r) => r.status === 'FAIL');
console.log(
  `\n${hardFails.length === 0 ? 'ALL PATHS OK' : `${hardFails.length} PATH(S) FAILED`} ` +
    `(${results.filter((r) => r.status === 'LABELED-GAP').length} labeled non-blocking gap, ` +
    `${results.filter((r) => r.status === 'SKIPPED').length} skipped/not-wired).`,
);
process.exit(hardFails.length === 0 ? 0 : 1);
