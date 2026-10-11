#!/usr/bin/env node
/**
 * WebDesk M4 F1 — migration 0018 (audit_entries.ws4_assertion_version) proven against a real Postgres.
 *
 * Four parts, one exit code (same shape as 0015_submission_attribution.test.mjs):
 *   A. Catalog state of the MAIN database (already migrated through 0018 by the real runner): the column
 *      (smallint, nullable, no default), the CHECK, the 0009 single-use index unchanged, RLS still FORCED,
 *      audit still append-only for the app role.
 *   B. Behaviour as the app role, in one transaction that is ROLLED BACK: an old-shape row reads NULL;
 *      versions 1 and 2 beside an approval are accepted; 0, 3 and a version without an approval are
 *      refused by the CHECK (23514); the single-use index still refuses one approval twice even across
 *      versions (v1 then v2); UPDATE is still denied (append-only).
 *   C. Idempotent re-run: the real runner applies 0 files again, and executing the SQL file a second time
 *      changes nothing (identical catalog snapshots).
 *   D. A scratch database at everything before 0018, then the REAL runner: it applies exactly 0018, ONLY
 *      the intended catalog changes happen (1 column, 1 constraint), and a pre-existing row survives NULL.
 *
 * Env (all point at the same cluster):
 *   SUPERUSER_DATABASE_URL  cluster bootstrap identity on the main db (creates/drops scratch dbs)
 *   MIGRATE_DATABASE_URL    webdesk_migrator on the main db
 *   APP_DATABASE_URL        webdesk_app on the main db
 *
 * Run (from webdesk/api, for the same reason as the 0009-0015 files):
 *   node --import tsx ../migrations/tests/0018_ws4_assertion_version.test.mjs
 *
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

const TARGET = '0018_ws4_assertion_version.sql'
const TABLE = 'audit_entries'
const COL = 'ws4_assertion_version'
const CK = 'ck_audit_entries_ws4_assertion_version'

const { check, summary } = makeChecker('0018')

const insertAudit = (c, { tenantId = null, approval = null, version = null, action = 'control.tenant.archive' } = {}) =>
  attempt(
    c,
    `INSERT INTO audit_entries (tenant_id, actor, action, ws4_approval_id, ws4_assertion_version)
     VALUES ($1, 'm4f1-test', $2, $3, $4) RETURNING id, ws4_assertion_version`,
    [tenantId, action, approval, version],
  )

// =============================================================================================
// A. Catalog state of the main database
// =============================================================================================
async function partA(roles) {
  console.log('\n== A. catalog state (main db) ==')
  const c = await connect(MIGRATE)
  try {
    const ledger = await one(c, `SELECT count(*)::int AS n FROM schema_migrations WHERE name = $1`, [TARGET])
    check(`ledger records ${TARGET} exactly once`, ledger.n === 1, ledger)

    const col = await one(
      c,
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [TABLE, COL],
    )
    check(`${COL} exists as a nullable smallint with no default (NULL = not recorded, never a made-up value)`,
      col?.data_type === 'smallint' && col?.is_nullable === 'YES' && col?.column_default === null, col)

    const ck = await one(c, `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1 AND conrelid = 'public.audit_entries'::regclass`, [CK])
    check(`${CK}: only NULL, 1 or 2, and a version only beside an approval id`,
      /ws4_assertion_version IS NULL/.test(ck?.def ?? '') && /ws4_approval_id IS NOT NULL/.test(ck?.def ?? '') && /1/.test(ck?.def ?? '') && /2/.test(ck?.def ?? ''),
      ck)

    const ux = await one(c, `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ux_audit_entries_ws4_once'`)
    check('the 0009 single-use index is untouched: ws4_approval_id only, the version is NOT part of the key',
      /\(ws4_approval_id\)/.test(ux?.indexdef ?? '') && !/ws4_assertion_version/.test(ux?.indexdef ?? ''), ux)

    const rls = await one(c, `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.audit_entries'::regclass`)
    check('RLS still enabled + FORCED on audit_entries', rls.relrowsecurity === true && rls.relforcerowsecurity === true, rls)

    const priv = await one(
      c,
      `SELECT has_table_privilege($1, 'audit_entries', 'INSERT') AS i, has_table_privilege($1, 'audit_entries', 'UPDATE') AS u,
              has_table_privilege($1, 'audit_entries', 'DELETE') AS d`,
      [roles.app],
    )
    check(`audit_entries stays append-only for ${roles.app} (INSERT yes, no UPDATE/DELETE)`, priv.i && !priv.u && !priv.d, priv)

    const second = runRunner(MIGRATE)
    check('a second runner pass applies 0 files', second.status === 0 && /0 applied/.test(second.stdout), second.stdout + second.stderr)
  } finally {
    await c.end()
  }
}

// =============================================================================================
// B. Behaviour as the app role (rolled back)
// =============================================================================================
async function partB() {
  console.log('\n== B. behaviour as the app role (one transaction, rolled back) ==')
  const c = await connect(APP)
  try {
    await c.query('BEGIN')
    await setCtx(c, { platform: true })

    const old = await attempt(
      c,
      `INSERT INTO audit_entries (tenant_id, actor, action, args_hash, ws4_approval_id) VALUES (NULL, 'm4f1-test', 'control.tenant.provision', NULL, NULL)
       RETURNING ws4_assertion_version`,
    )
    check('a row written the OLD way (no version column named) is accepted and reads NULL', !old.err && old.rows[0].ws4_assertion_version === null, errSummary(old))

    const v1 = await insertAudit(c, { approval: `m4f1-${randomUUID()}`, version: 1 })
    check('version 1 beside an approval id is accepted', !v1.err && v1.rows[0].ws4_assertion_version === 1, errSummary(v1))
    const v2 = await insertAudit(c, { approval: `m4f1-${randomUUID()}`, version: 2 })
    check('version 2 beside an approval id is accepted', !v2.err && v2.rows[0].ws4_assertion_version === 2, errSummary(v2))
    const unknown = await insertAudit(c, { approval: `m4f1-${randomUUID()}`, version: null })
    check('an approval with NO version (not recorded) is accepted', !unknown.err, errSummary(unknown))

    for (const bad of [0, 3, -1]) {
      const r = await insertAudit(c, { approval: `m4f1-${randomUUID()}`, version: bad })
      check(`version ${bad} is refused by ${CK} (23514)`, r.err?.code === '23514' && r.err?.constraint === CK, errSummary(r))
    }
    const orphan = await insertAudit(c, { approval: null, version: 2 })
    check(`a version on a row that claims NO approval is refused (23514 ${CK})`, orphan.err?.code === '23514' && orphan.err?.constraint === CK, errSummary(orphan))

    const shared = `m4f1-${randomUUID()}`
    const first = await insertAudit(c, { approval: shared, version: 1 })
    const again = await insertAudit(c, { approval: shared, version: 2 })
    check('one approval cannot be claimed once as v1 and again as v2 (ux_audit_entries_ws4_once, 23505)',
      !first.err && again.err?.code === '23505' && again.err?.constraint === 'ux_audit_entries_ws4_once', errSummary(again))

    const upd = await attempt(c, `UPDATE audit_entries SET ws4_assertion_version = 2 WHERE id = $1`, [v1.rows[0].id])
    check('UPDATE of the version is denied: audit stays append-only (42501)', upd.err?.code === '42501', errSummary(upd))
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    await c.end()
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
// D. Scratch database before 0018 -> the real runner
// =============================================================================================
const keyed = (rows) => rows.map((s) => JSON.parse(s))

async function partD(roles) {
  console.log('\n== D. scratch database before 0018 -> the real runner ==')
  const db = 'm4f1_0018_pos'
  try {
    await createScratchDb(SUPER, db, roles)
    const url = withDb(MIGRATE, db)
    const applied = await applyThrough(url, TARGET)
    check(`[pos] scratch db built through every file before 0018 (${applied.length} files, none of them 0018)`,
      applied.length > 0 && !applied.includes(TARGET), applied)

    // A pre-existing platform audit row carrying an approval, committed as the migrator.
    const approval = `m4f1-pre-${randomUUID()}`
    const m = await connect(url)
    try {
      await m.query('BEGIN')
      await setCtx(m, { platform: true })
      await m.query(`INSERT INTO audit_entries (tenant_id, actor, action, ws4_approval_id) VALUES (NULL, 'm4f1-test', 'control.tenant.archive', $1)`, [approval])
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
    check('[pos] the real runner applies exactly 0018 (exit 0, 1 applied)', run.status === 0 && /1 applied/.test(run.stdout), run.stdout + run.stderr)
    const after = await snap()

    const c = await connect(url)
    try {
      await c.query('BEGIN')
      await setCtx(c, { platform: true })
      const row = await one(c, `SELECT ws4_approval_id, ws4_assertion_version FROM audit_entries WHERE ws4_approval_id = $1`, [approval])
      await c.query('ROLLBACK')
      check('[pos] a row from before 0018 survives it: approval intact, version NULL (not recorded, never guessed)',
        row?.ws4_approval_id === approval && row?.ws4_assertion_version === null, row)
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
    check('[pos] columns: exactly audit_entries.ws4_assertion_version, nullable',
      diff.columns.added.length === 1 && diff.columns.added[0][0] === TABLE && diff.columns.added[0][1] === COL && diff.columns.added[0][3] === 'YES',
      diff.columns.added)
    check(`[pos] constraints: exactly ${CK}`, diff.constraints.added.length === 1 && diff.constraints.added[0][1] === CK, diff.constraints.added)
    for (const k of ['indexes', 'policies', 'grants', 'rls', 'triggers']) check(`[pos] ${k}: nothing added`, diff[k].added.length === 0, diff[k].added)
    const again = runRunner(url, { through: TARGET })
    check('[pos] a second pass is a no-op (0 applied)', again.status === 0 && /0 applied/.test(again.stdout), again.stdout + again.stderr)
  } finally {
    await dropScratchDb(SUPER, db).catch(() => {})
  }
}

// =============================================================================================
const roles = await resolveRoles(SUPER, MIGRATE, APP)
await partA(roles)
await partB()
await partC()
await partD(roles)
process.exit(summary())
