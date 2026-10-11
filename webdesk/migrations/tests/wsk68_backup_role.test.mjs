#!/usr/bin/env node
/**
 * WSK-68 — the read-only BYPASSRLS backup role (`webdesk_backup`, owner ruling WSK-D48 (6)) proven
 * against the real cluster that postgres/init-roles.sh built.
 *
 *   A. Catalog: BYPASSRLS, LOGIN, NOSUPERUSER/NOINHERIT/NOCREATEDB/NOCREATEROLE/NOREPLICATION,
 *      `default_transaction_read_only=on` in rolconfig, a member of no role, and no privilege other
 *      than SELECT on any public relation.
 *   B. Behaviour, inside one transaction that is ROLLED BACK: with a positive control (webdesk_migrator
 *      — the table owner, NOBYPASSRLS — reads ZERO rows with no GUC set, so FORCE RLS is armed), the
 *      backup role reads the fixtures' rows on tenants / sites / platform-level audit_entries with NO
 *      tenant GUC set. That is exactly what pg_dump needs, and it is the thing no other role can do.
 *   C. It cannot write: INSERT / UPDATE / DELETE / TRUNCATE are refused with 42501 (the grant wall).
 *   D. Read-only transaction: a role's `ALTER ROLE ... SET default_transaction_read_only = on` is applied
 *      at LOGIN, which a superuser's SET ROLE cannot reproduce (and the role has no password, so this
 *      script cannot log in as it over TCP). So the setting is READ from rolconfig and applied as
 *      `SET LOCAL transaction_read_only` — the same value the login would have applied — and the INSERT
 *      must then fail with SQLSTATE 25006 "cannot execute INSERT in a read-only transaction". The real
 *      socket login is exercised for real by ops/scripts/webdesk-backup-nightly.sh on the box.
 *   E. The RLS-integrity gate (scripts/check-rls-integrity.mjs) run as a child process against this
 *      cluster exits 0: its role-model SQL works on a real catalog and sees a read-only backup role.
 *
 * A cluster that predates WSK-68 (no webdesk_backup) FAILS part A on purpose, with the remedy in the
 * message: run webdesk/ops/scripts/ensure-backup-role.sh. CI and the Linux gate build clusters from
 * init-roles.sh, so they always have it.
 *
 * Env: SUPERUSER_DATABASE_URL (cluster bootstrap identity, main db), MIGRATE_DATABASE_URL.
 * Run (from webdesk/api, like the 0009-0014 files):
 *   node --import tsx ../migrations/tests/wsk68_backup_role.test.mjs
 */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, makeChecker, requireEnv } from './0009_helpers.mjs'

requireEnv(['SUPERUSER_DATABASE_URL', 'MIGRATE_DATABASE_URL'])
const SUPER = process.env.SUPERUSER_DATABASE_URL
const MIGRATE = process.env.MIGRATE_DATABASE_URL
const ROLE = 'webdesk_backup'
const CHECKER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'check-rls-integrity.mjs')

const { check, summary } = makeChecker('wsk68')

/** Runs `sql` in a SAVEPOINT; returns the SQLSTATE it failed with, or null if it succeeded. The savepoint is rolled back either way. */
async function sqlstate(c, sql, params = []) {
  await c.query('SAVEPOINT s')
  try {
    await c.query(sql, params)
    return null
  } catch (err) {
    return err.code ?? String(err.message)
  } finally {
    await c.query('ROLLBACK TO SAVEPOINT s')
  }
}

const su = await connect(SUPER)
try {
  // ---- A. catalog -------------------------------------------------------------------------------
  const { rows: roleRows } = await su.query(
    `SELECT rolcanlogin, rolsuper, rolinherit, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolconfig,
            ARRAY(SELECT g.rolname::text FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid)::text[] AS member_of
       FROM pg_roles r WHERE rolname = $1`,
    [ROLE],
  )
  check(`role ${ROLE} exists (a cluster without it needs webdesk/ops/scripts/ensure-backup-role.sh)`, roleRows.length === 1)
  if (roleRows.length !== 1) process.exit(summary())
  const r = roleRows[0]
  check('LOGIN + BYPASSRLS', r.rolcanlogin === true && r.rolbypassrls === true, r)
  check('NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION',
    !r.rolsuper && !r.rolinherit && !r.rolcreatedb && !r.rolcreaterole && !r.rolreplication, r)
  check('default_transaction_read_only=on is set on the role', (r.rolconfig ?? []).includes('default_transaction_read_only=on'), r.rolconfig)
  check('member of no role', r.member_of.length === 0, r.member_of)

  const { rows: nonSelect } = await su.query(
    `SELECT c.relname, p.priv
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND has_table_privilege($1, c.oid, p.priv)`,
    [ROLE],
  )
  check('no table privilege other than SELECT on any public table', nonSelect.length === 0, nonSelect)
  const { rows: selectable } = await su.query(
    `SELECT count(*) FILTER (WHERE has_table_privilege($1, c.oid, 'SELECT'))::int AS can, count(*)::int AS total
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')`,
    [ROLE],
  )
  check('SELECT on EVERY public table and sequence (a table it cannot read is a hole in the dump)',
    selectable[0].total > 0 && selectable[0].can === selectable[0].total, selectable[0])

  // ---- B + C. behaviour, one rolled-back transaction ----------------------------------------------
  const ta = randomUUID()
  const tb = randomUUID()
  const siteA = randomUUID()
  const siteB = randomUUID()
  await su.query('BEGIN')
  try {
    await su.query('SET LOCAL ROLE webdesk_migrator')
    await su.query(`SET LOCAL webdesk.platform_ctx = 'true'`)
    await su.query(`INSERT INTO tenants (id, slug, company_ref, status) VALUES ($1, $2, $3, 'active'), ($4, $5, $6, 'active')`,
      [ta, `wsk68-a-${ta.slice(0, 8)}`, randomUUID(), tb, `wsk68-b-${tb.slice(0, 8)}`, randomUUID()])
    await su.query(`INSERT INTO audit_entries (id, tenant_id, actor, action) VALUES ($1, NULL, 'control-plane', 'wsk68.platform')`, [randomUUID()])
    await su.query(`SET LOCAL webdesk.platform_ctx = ''`)
    await su.query(`SELECT set_config('webdesk.tenant_ctx', $1, true)`, [ta])
    await su.query(`INSERT INTO sites (id, tenant_id, kind, name) VALUES ($1, $2, 'astro', 'A')`, [siteA, ta])
    await su.query(`SELECT set_config('webdesk.tenant_ctx', $1, true)`, [tb])
    await su.query(`INSERT INTO sites (id, tenant_id, kind, name) VALUES ($1, $2, 'astro', 'B')`, [siteB, tb])
    await su.query('RESET ROLE')

    // Positive control: with no GUC the table OWNER (NOBYPASSRLS) sees nothing, so the read below is not vacuous.
    await su.query(`SET LOCAL webdesk.tenant_ctx = ''`)
    await su.query('SET LOCAL ROLE webdesk_migrator')
    const blind = await su.query(`SELECT (SELECT count(*) FROM sites)::int AS sites, (SELECT count(*) FROM tenants)::int AS tenants`)
    check('control: webdesk_migrator (the table owner, NOBYPASSRLS) reads ZERO rows with no GUC set', blind.rows[0].sites === 0 && blind.rows[0].tenants === 0, blind.rows[0])
    await su.query('RESET ROLE')

    await su.query(`SET LOCAL ROLE ${ROLE}`)
    const seen = await su.query(
      `SELECT (SELECT count(*) FROM tenants WHERE id IN ($1, $2))::int AS tenants,
              (SELECT count(*) FROM sites WHERE id IN ($3, $4))::int AS sites,
              (SELECT count(*) FROM audit_entries WHERE tenant_id IS NULL AND action = 'wsk68.platform')::int AS platform_audit`,
      [ta, tb, siteA, siteB],
    )
    check(`${ROLE} reads BOTH tenants' rows and the platform-level audit row with no GUC set`,
      seen.rows[0].tenants === 2 && seen.rows[0].sites === 2 && seen.rows[0].platform_audit === 1, seen.rows[0])

    const ins = await sqlstate(su, `INSERT INTO sites (id, tenant_id, kind, name) VALUES ($1, $2, 'astro', 'nope')`, [randomUUID(), ta])
    check('INSERT is refused (42501)', ins === '42501', ins)
    check('UPDATE is refused (42501)', (await sqlstate(su, `UPDATE tenants SET slug = slug`)) === '42501')
    check('DELETE is refused (42501)', (await sqlstate(su, `DELETE FROM sites`)) === '42501')
    check('TRUNCATE is refused (42501)', (await sqlstate(su, `TRUNCATE sites`)) === '42501')
    check('DDL is refused (42501)', (await sqlstate(su, `CREATE TABLE wsk68_never (i int)`)) === '42501')
  } finally {
    await su.query('ROLLBACK')
  }

  // ---- D. the read-only transaction the role's own setting produces ---------------------------------
  const cfg = Object.fromEntries((r.rolconfig ?? []).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]))
  check('rolconfig carries default_transaction_read_only', cfg.default_transaction_read_only === 'on', cfg)
  await su.query('BEGIN')
  try {
    await su.query(`SET LOCAL ROLE ${ROLE}`)
    // What the login would have applied: the role's default_transaction_read_only becomes this txn's mode.
    await su.query(`SET LOCAL transaction_read_only = ${cfg.default_transaction_read_only === 'on' ? 'on' : 'off'}`)
    const roIns = await sqlstate(su, `INSERT INTO sites (id, tenant_id, kind, name) VALUES ($1, $2, 'astro', 'nope')`, [randomUUID(), randomUUID()])
    check('with the role\'s read-only setting applied, INSERT fails with 25006 "read-only transaction"', roIns === '25006', roIns)
    const roSel = await su.query('SELECT count(*)::int AS n FROM tenants')
    check('and reads still work in that read-only transaction', Number.isInteger(roSel.rows[0].n))
  } finally {
    await su.query('ROLLBACK')
  }
} finally {
  await su.end()
}

// ---- E. the integrity gate, as a child process against this cluster --------------------------------
const gate = spawnSync(process.execPath, [CHECKER], { env: { ...process.env, DATABASE_URL: MIGRATE }, encoding: 'utf8' })
check('check-rls-integrity.mjs exits 0 against this cluster (role model + tables)', gate.status === 0, `${gate.stdout}${gate.stderr}`.trim().slice(0, 600))
check('and it saw the role present and read-only (not the "absent" note)', /present and read-only/.test(gate.stdout), gate.stdout)

process.exit(summary())
