// WSK-65 — shared helpers for the migration test files (0009_content_write_plane.test.mjs,
// 0009_v1_bytes.test.mjs and, since WSK-D51, 0010_slug_release_and_ledger.test.mjs). Not a test
// itself.
//
// The negative controls need a database that stops short of the migration under test, so these helpers build throwaway
// scratch databases next to the main one. Each is set up exactly as postgres/init-roles.sh sets up
// the main database (same owner, same CONNECT grants, same schema grants, same default-privilege
// hand-off to the app role), then migrated file by file with the same per-file transaction and
// ledger shape as migrations/migrate.mjs. The final step to 0009 is always the REAL runner,
// spawned as a child process, so the loud failure being asserted is the one an operator would see.
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
export const MIGRATIONS_DIR = join(HERE, '..')
export const RUNNER = join(MIGRATIONS_DIR, 'migrate.mjs')
export const TARGET_FILE = '0009_content_write_plane.sql'

export function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n])
  if (missing.length) {
    console.error(`[0009] missing env: ${missing.join(', ')}`)
    process.exit(2)
  }
}

/** Same URL with a different database name. */
export function withDb(url, db) {
  const u = new URL(url)
  u.pathname = `/${db}`
  return u.toString()
}

export function userOf(url) {
  return decodeURIComponent(new URL(url).username)
}

export async function connect(url) {
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  return c
}

/** A tiny PASS/FAIL ledger: every check prints, the process exit code is the verdict. */
export function makeChecker(tag) {
  const state = { pass: 0, fail: 0 }
  function check(name, ok, detail) {
    if (ok) {
      state.pass++
      console.log(`  PASS  ${name}`)
    } else {
      state.fail++
      console.log(`  FAIL  ${name}${detail !== undefined ? ` -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
    }
  }
  function summary() {
    console.log(`\n[${tag}] ${state.pass} passed, ${state.fail} failed`)
    return state.fail === 0 ? 0 : 1
  }
  return { check, summary, state }
}

/**
 * Creates (or recreates) a scratch database provisioned the way init-roles.sh provisions the main
 * one. `superUrl` must be a superuser connection (the cluster bootstrap identity).
 */
export async function createScratchDb(superUrl, name, roles) {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsafe scratch db name ${name}`)
  const su = await connect(superUrl)
  try {
    await su.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await su.query(`CREATE DATABASE ${name} OWNER ${roles.owner}`)
    await su.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`)
    await su.query(`GRANT CONNECT ON DATABASE ${name} TO ${roles.migrator}, ${roles.app}`)
  } finally {
    await su.end()
  }
  const sd = await connect(withDb(superUrl, name))
  try {
    await sd.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`)
    await sd.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${roles.migrator}`)
    await sd.query(`GRANT USAGE ON SCHEMA public TO ${roles.app}`)
    await sd.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${roles.migrator} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roles.app}`,
    )
    await sd.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${roles.migrator} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${roles.app}`,
    )
  } finally {
    await sd.end()
  }
}

export async function dropScratchDb(superUrl, name) {
  const su = await connect(superUrl)
  try {
    await su.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  } finally {
    await su.end()
  }
}

/** Reads the role names from the live connection strings and the main database's owner. */
export async function resolveRoles(superUrl, migrateUrl, appUrl) {
  const su = await connect(superUrl)
  try {
    const { rows } = await su.query(`SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()`)
    return { owner: rows[0].owner, migrator: userOf(migrateUrl), app: userOf(appUrl) }
  } finally {
    await su.end()
  }
}

/** Applies every migration file sorting strictly before `stopBefore`, as migrate.mjs would. */
export async function applyThrough(migratorUrl, stopBefore = TARGET_FILE) {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort().filter((f) => f < stopBefore)
  const c = await connect(migratorUrl)
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`)
    for (const f of files) {
      await c.query('BEGIN')
      try {
        await c.query(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
        await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f])
        await c.query('COMMIT')
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {})
        throw new Error(`applyThrough: ${f} failed: ${err.message}`)
      }
    }
    return files
  } finally {
    await c.end()
  }
}

/**
 * Runs the real migration runner against `migratorUrl`.
 *
 * `through` (a migration file name) stops the run at that file: the runner discovers files by
 * reading its OWN directory, so a copy of migrate.mjs plus every file <= `through` is staged in a
 * throwaway directory next to this one (inside webdesk/, so `pg` resolves from webdesk/node_modules)
 * and run from there. The code that runs is still the real runner, unmodified, with its real output
 * ("N applied"). The 0009 tests pass `through: TARGET_FILE` so they keep proving 0009 in isolation
 * now that later files (0010...) exist; without it the runner applies everything pending.
 */
export function runRunner(migratorUrl, { through } = {}) {
  let stage = null
  let runner = RUNNER
  if (through) {
    stage = mkdtempSync(join(HERE, '.runner-'))
    copyFileSync(RUNNER, join(stage, 'migrate.mjs'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f <= through)) {
      copyFileSync(join(MIGRATIONS_DIR, f), join(stage, f))
    }
    runner = join(stage, 'migrate.mjs')
  }
  try {
    const r = spawnSync(process.execPath, [runner], {
      env: { ...process.env, MIGRATE_DATABASE_URL: migratorUrl },
      encoding: 'utf8',
      timeout: 120_000,
    })
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true })
  }
}

/** Sets both GUCs for the rest of the current transaction. */
export async function setCtx(client, { tenant = null, platform = false } = {}) {
  await client.query(`SELECT set_config('webdesk.tenant_ctx', $1, true), set_config('webdesk.platform_ctx', $2, true)`, [
    tenant ?? '',
    platform ? 'true' : 'false',
  ])
}

/** Runs `sql` inside a savepoint; returns the pg error (or null) and rolls back to the savepoint. */
export async function attempt(client, sql, params = []) {
  await client.query('SAVEPOINT sp')
  try {
    const r = await client.query(sql, params)
    await client.query('RELEASE SAVEPOINT sp')
    return { err: null, rowCount: r.rowCount, rows: r.rows }
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT sp')
    return { err }
  }
}
export const errSummary = (r) => (r.err ? `${r.err.code} ${r.err.message}` : `no error (rowCount=${r.rowCount})`)
export const one = async (client, sql, params = []) => (await client.query(sql, params)).rows[0]

// A tenant + site + 'page' collection committed under the right GUCs, as a migrator session.
export async function seedTenant(m) {
  const t = randomUUID()
  await m.query('BEGIN')
  await setCtx(m, { platform: true })
  await m.query(`INSERT INTO tenants (id, slug, company_ref) VALUES ($1, $2, $3)`, [t, `wsk65-neg-${t.slice(0, 8)}`, randomUUID()])
  await setCtx(m, { tenant: t })
  const site = (await one(m, `INSERT INTO sites (tenant_id, kind, name) VALUES ($1, 'astro', 's') RETURNING id`, [t])).id
  const col = (await one(m, `INSERT INTO collections (tenant_id, site_id, key) VALUES ($1, $2, 'page') RETURNING id`, [t, site])).id
  await m.query('COMMIT')
  return { t, site, col }
}

// Every catalog fact a migration could alter, as comparable strings (before/after diffs).
export const SNAPSHOT_SQL = {
  constraints: `SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
                 WHERE connamespace = 'public'::regnamespace AND conrelid <> 0 ORDER BY 1, 2`,
  indexes: `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2`,
  policies: `SELECT tablename, policyname, cmd, qual, with_check, roles::text FROM pg_policies WHERE schemaname = 'public' ORDER BY 1, 2`,
  columns: `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
             WHERE table_schema = 'public' ORDER BY 1, 2`,
  grants: `SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
            WHERE table_schema = 'public' ORDER BY 1, 2, 3`,
  rls: `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
         WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY 1`,
  triggers: `SELECT tgrelid::regclass::text AS tbl, tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`,
}
const keyOf = (r) => JSON.stringify(Object.values(r))
export async function snapshot(c) {
  const out = {}
  for (const [k, sql] of Object.entries(SNAPSHOT_SQL)) out[k] = (await c.query(sql)).rows.map(keyOf)
  return out
}
