#!/usr/bin/env node
/**
 * WebDesk site.archive — migration 0019 (sites.status) proven against a real Postgres.
 *
 * Four parts, one exit code (same shape as 0018_ws4_assertion_version.test.mjs):
 *   A. Catalog state of the MAIN database: the column (text, NOT NULL, default 'active'), the CHECK, RLS on
 *      `sites` still FORCED, the ledger row, a second runner pass applying 0 files.
 *   B. Behaviour, in transactions that are ROLLED BACK: a site inserted the OLD way (no status named) reads
 *      'active'; status can move to 'archived'; any other value is refused by the CHECK (23514); NULL is
 *      refused (23502); the app role holds UPDATE on sites.
 *   C. Idempotent re-run: executing the SQL file a second time changes nothing.
 *   D. A scratch database at everything before 0019, then the REAL runner: it applies exactly 0019, ONLY the
 *      intended catalog changes happen (1 column, 1 constraint), and a pre-existing site survives 'active'.
 *
 * Run (from webdesk/api):  node --import tsx ../migrations/tests/0019_site_status.test.mjs
 * Not run on the Windows dev box (needs the Linux gate's Postgres cluster).
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MIGRATIONS_DIR,
  SNAPSHOT_SQL,
  applyThrough,
  attempt,
  connect,
  createScratchDb,
  dropScratchDb,
  errSummary,
  makeChecker,
  one,
  requireEnv,
  resolveRoles,
  runRunner,
  setCtx,
  snapshot,
  withDb,
} from './0009_helpers.mjs'

requireEnv(['SUPERUSER_DATABASE_URL', 'MIGRATE_DATABASE_URL', 'APP_DATABASE_URL'])
const SUPER = process.env.SUPERUSER_DATABASE_URL
const MIGRATE = process.env.MIGRATE_DATABASE_URL
const APP = process.env.APP_DATABASE_URL

const TARGET = '0019_site_status.sql'
const { check, summary } = makeChecker('0019')

// =============================================================================================
// A. Catalog state of the main database
// =============================================================================================
async function partA() {
  console.log('\n== A. catalog state (main db) ==')
  const c = await connect(MIGRATE)
  try {
    const ledger = await one(c, `SELECT count(*)::int AS n FROM schema_migrations WHERE name = $1`, [TARGET])
    check(`ledger records ${TARGET} exactly once`, ledger.n === 1, ledger)

    const col = await one(
      c,
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sites' AND column_name = 'status'`,
    )
    check("sites.status exists as NOT NULL text defaulting to 'active'",
      col?.data_type === 'text' && col?.is_nullable === 'NO' && /'active'/.test(col?.column_default ?? ''), col)

    const ck = await one(
      c,
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'public.sites'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%status%'`,
    )
    check("a CHECK allows exactly 'active' and 'archived'", /active/.test(ck?.def ?? '') && /archived/.test(ck?.def ?? ''), ck)

    const rls = await one(c, `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.sites'::regclass`)
    check('RLS still enabled + FORCED on sites', rls.relrowsecurity === true && rls.relforcerowsecurity === true, rls)

    const second = runRunner(MIGRATE)
    check('a second runner pass applies 0 files', second.status === 0 && /0 applied/.test(second.stdout), second.stdout + second.stderr)
  } finally {
    await c.end()
  }
}

// =============================================================================================
// B. Behaviour (rolled back). Seeded as the migrator (the app role cannot insert a tenant).
// =============================================================================================
async function partB() {
  console.log('\n== B. behaviour (rolled back) ==')
  const t = randomUUID()
  const m = await connect(MIGRATE)
  try {
    await m.query('BEGIN')
    await setCtx(m, { platform: true })
    await m.query(`INSERT INTO tenants (id, slug, company_ref) VALUES ($1, $2, $3)`, [t, `m0019-${t.slice(0, 8)}`, randomUUID()])
    await setCtx(m, { tenant: t })
    const old = await one(m, `INSERT INTO sites (tenant_id, kind, name) VALUES ($1, 'astro', 's') RETURNING id, status`, [t])
    check("a site inserted the OLD way (no status named) reads 'active'", old.status === 'active', old)

    const archived = await attempt(m, `UPDATE sites SET status = 'archived' WHERE id = $1 RETURNING status`, [old.id])
    check("status can move to 'archived'", !archived.err && archived.rows[0].status === 'archived', errSummary(archived))
    for (const bad of ['deleted', 'ACTIVE', '']) {
      const r = await attempt(m, `UPDATE sites SET status = $2 WHERE id = $1`, [old.id, bad])
      check(`status '${bad}' is refused by the CHECK (23514)`, r.err?.code === '23514', errSummary(r))
    }
    const nul = await attempt(m, `UPDATE sites SET status = NULL WHERE id = $1`, [old.id])
    check('status NULL is refused (23502)', nul.err?.code === '23502', errSummary(nul))
  } finally {
    await m.query('ROLLBACK').catch(() => {})
    await m.end()
  }

  // The app role already UPDATEs tenants.status / environments.status the same way.
  const a = await connect(APP)
  try {
    const priv = await one(a, `SELECT has_table_privilege(current_user, 'sites', 'UPDATE') AS u`)
    check('the app role can UPDATE sites (so the command can write the status)', priv.u === true, priv)
  } finally {
    await a.end()
  }
}

// =============================================================================================
// C. Idempotent re-run
// =============================================================================================
async function partC() {
  console.log('\n== C. idempotent re-run ==')
  const m = await connect(MIGRATE)
  try {
    const sql = readFileSync(join(MIGRATIONS_DIR, TARGET), 'utf8')
    const before = await snapshot(m)
    await m.query('BEGIN')
    let err = null
    try {
      await m.query(sql)
    } catch (e) {
      err = e
    }
    await m.query(err ? 'ROLLBACK' : 'COMMIT')
    check('executing the SQL file a second time, directly, raises no error', !err, err?.message)
    const after = await snapshot(m)
    const diffs = Object.keys(SNAPSHOT_SQL).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    check('and changes nothing in the catalog', diffs.length === 0, diffs)
  } finally {
    await m.end()
  }
}

// =============================================================================================
// D. Scratch database before 0019 -> the real runner
// =============================================================================================
const keyed = (rows) => rows.map((s) => JSON.parse(s))

async function partD(roles) {
  console.log('\n== D. scratch database before 0019 -> the real runner ==')
  const db = 'm0019_site_status_pos'
  try {
    await createScratchDb(SUPER, db, roles)
    const url = withDb(MIGRATE, db)
    const applied = await applyThrough(url, TARGET)
    check(`[pos] scratch db built through every file before 0019 (${applied.length} files, none of them 0019)`,
      applied.length > 0 && !applied.includes(TARGET), applied)

    const t = randomUUID()
    const siteId = randomUUID()
    const m = await connect(url)
    try {
      await m.query('BEGIN')
      await setCtx(m, { platform: true })
      await m.query(`INSERT INTO tenants (id, slug, company_ref) VALUES ($1, $2, $3)`, [t, `m0019-${t.slice(0, 8)}`, randomUUID()])
      await setCtx(m, { tenant: t })
      await m.query(`INSERT INTO sites (id, tenant_id, kind, name) VALUES ($1, $2, 'astro', 'pre-existing')`, [siteId, t])
      await m.query('COMMIT')
    } finally {
      await m.end()
    }

    const snap = async () => {
      const c = await connect(url)
      try {
        return await snapshot(c)
      } finally {
        await c.end()
      }
    }
    const before = await snap()
    const run = runRunner(url, { through: TARGET })
    console.log(`        runner exit=${run.status}: ${(run.stdout + run.stderr).trim().split('\n').join(' | ')}`)
    check('[pos] the real runner applies exactly 0019 (exit 0, 1 applied)', run.status === 0 && /1 applied/.test(run.stdout), run.stdout + run.stderr)
    const after = await snap()

    const c = await connect(url)
    try {
      await c.query('BEGIN')
      await setCtx(c, { tenant: t })
      const row = await one(c, `SELECT status FROM sites WHERE id = $1`, [siteId])
      await c.query('ROLLBACK')
      check("[pos] a site from before 0019 survives it as 'active'", row?.status === 'active', row)
    } finally {
      await c.end()
    }

    const diff = {}
    for (const k of Object.keys(SNAPSHOT_SQL)) {
      const a = new Set(after[k])
      const b = new Set(before[k])
      diff[k] = { lost: keyed(before[k].filter((x) => !a.has(x))), added: keyed(after[k].filter((x) => !b.has(x))) }
      console.log(`        ${k}: before=${before[k].length} after=${after[k].length} added=${diff[k].added.length} lost=${diff[k].lost.length}`)
    }
    for (const k of Object.keys(SNAPSHOT_SQL)) check(`[pos] ${k}: nothing lost`, diff[k].lost.length === 0, diff[k].lost)
    check('[pos] columns: exactly sites.status, NOT NULL',
      diff.columns.added.length === 1 && diff.columns.added[0][0] === 'sites' && diff.columns.added[0][1] === 'status' && diff.columns.added[0][3] === 'NO',
      diff.columns.added)
    check('[pos] constraints: exactly one, on sites', diff.constraints.added.length === 1 && diff.constraints.added[0][0] === 'sites', diff.constraints.added)
    for (const k of ['indexes', 'policies', 'grants', 'rls', 'triggers']) check(`[pos] ${k}: nothing added`, diff[k].added.length === 0, diff[k].added)
    const again = runRunner(url, { through: TARGET })
    check('[pos] a second pass is a no-op (0 applied)', again.status === 0 && /0 applied/.test(again.stdout), again.stdout + again.stderr)
  } finally {
    await dropScratchDb(SUPER, db).catch(() => {})
  }
}

// =============================================================================================
const roles = await resolveRoles(SUPER, MIGRATE, APP)
await partA()
await partB()
await partC()
await partD(roles)
process.exit(summary())
