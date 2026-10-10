#!/usr/bin/env node
/**
 * WSK-04 — the tenancy wall's consolidated cross-path probe suite.
 *
 * ONE command proving ZERO rows via EVERY access path a real request can take into Zone B's
 * tenant-scoped data (webdesk-design.md §12's WSK-04 row): raw SQL as `webdesk_app` and the
 * `webdesk/api` service's guarded content routes (WSK-48b: the Payload Local API / REST / jobs
 * paths this suite also ran are gone with Payload). This file does not reinvent any of those probes — it runs the ones WSK-01/
 * 02/03/05 and this ticket already built and proved individually, together, with one pass/fail
 * verdict per path and one process exit code, so this is a permanent regression suite rather than
 * six scripts someone has to remember to run in the right order.
 *
 * Every check inside each path-probe still runs and still gets reported — this file does not
 * relax any of them.
 *
 * USAGE — five connection strings, one per role/purpose (all point at the SAME database):
 *
 *   SUPERUSER_DATABASE_URL   cluster bootstrap identity (postgres/init-roles.sh's $POSTGRES_USER)
 *                            — migrations/tests/rls.spec.sql needs SET ROLE freely, same as its
 *                            own header documents.
 *   MIGRATE_DATABASE_URL     webdesk_migrator — used by webdesk/api's test fixtures.
 *   APP_DATABASE_URL         webdesk_app — used by webdesk/api's own tests (WSK05_TEST_DATABASE_URL).
 *
 * Run (from webdesk/):
 *   SUPERUSER_DATABASE_URL=postgres://postgres:...@localhost:PORT/webdesk \
 *   MIGRATE_DATABASE_URL=postgres://webdesk_migrator:...@localhost:PORT/webdesk \
 *   APP_DATABASE_URL=postgres://webdesk_app:...@localhost:PORT/webdesk \
 *   node scripts/wsk04-cross-path-suite.mjs
 *
 * Prerequisite: migrations/migrate.mjs already applied to the target database — this suite tests
 * access paths, not schema setup.
 *
 * Exit 0 = every path's evidence matches its expected shape.
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
// (WSK-48b) The Payload paths this suite used to run -- Payload Local API, Payload REST + admin SSR,
// the pool-subclass pin, and the jobs path -- went with Payload (rulings WSK-D37/D38). What remains
// is every path a request can take into Zone B's tenant data today: raw SQL, the api's guarded
// content routes, and the RLS-integrity gate.
// ------------------------------------------------------------------------------------------

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
