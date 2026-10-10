// WSK-65 — shared helpers for the 0009 test files (0009_content_write_plane.test.mjs and
// 0009_v1_bytes.test.mjs). Not a test itself.
//
// The negative controls need a database that stops at 0008, so these helpers build throwaway
// scratch databases next to the main one. Each is set up exactly as postgres/init-roles.sh sets up
// the main database (same owner, same CONNECT grants, same schema grants, same default-privilege
// hand-off to the app role), then migrated file by file with the same per-file transaction and
// ledger shape as migrations/migrate.mjs. The final step to 0009 is always the REAL runner,
// spawned as a child process, so the loud failure being asserted is the one an operator would see.
import pg from 'pg'
import { readFileSync, readdirSync } from 'node:fs'
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

/** Runs the real migration runner against `migratorUrl`. */
export function runRunner(migratorUrl) {
  const r = spawnSync(process.execPath, [RUNNER], {
    env: { ...process.env, MIGRATE_DATABASE_URL: migratorUrl },
    encoding: 'utf8',
    timeout: 120_000,
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** Sets both GUCs for the rest of the current transaction. */
export async function setCtx(client, { tenant = null, platform = false } = {}) {
  await client.query(`SELECT set_config('webdesk.tenant_ctx', $1, true), set_config('webdesk.platform_ctx', $2, true)`, [
    tenant ?? '',
    platform ? 'true' : 'false',
  ])
}
