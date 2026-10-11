#!/usr/bin/env node
/**
 * WebDesk M5-G6 — migration 0017 (consent_records: the server-side consent log) proven against a real Postgres.
 *
 * Four parts, one exit code (same shape as 0015_submission_attribution.test.mjs / 0016):
 *   A. Catalog state of the MAIN database (already migrated through 0017 by the real runner): columns, types,
 *      NOT NULLs, the CHECKs, the two indexes, FORCE RLS + one tenant_isolation policy, and the app role's
 *      grants: SELECT, INSERT, DELETE only (no UPDATE: append-only), no TRUNCATE. No ip / user_agent column.
 *   B. Behaviour as the app role, in one transaction that is ROLLED BACK: inserts, the action / version / UA
 *      class / withdraw CHECKs, UPDATE refused (append-only), DELETE allowed (the purge and erase path), RLS
 *      isolation between two tenants with a positive control, an unset tenant_ctx reads 0 rows and refuses
 *      writes, platform_ctx is NOT an escape.
 *   C. Idempotent re-run: the real runner applies 0 files again, and executing the SQL file a second time
 *      changes nothing.
 *   D. A scratch database at 0016, then the REAL runner: it applies exactly 0017 and ONLY the intended catalog
 *      changes happen (exact before/after diff: every added object belongs to consent_records; nothing lost).
 *
 * Env (all point at the same cluster):
 *   SUPERUSER_DATABASE_URL, MIGRATE_DATABASE_URL (webdesk_migrator), APP_DATABASE_URL (webdesk_app)
 *
 * Run (from webdesk/api, for the same reason as the 0009-0016 files):
 *   node --import tsx ../migrations/tests/0017_consent_records.test.mjs
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

const TARGET = '0017_consent_records.sql'
const PREV = '0016_editorial_review.sql'
const TABLE = 'consent_records'
const COLS = ['id', 'consent_id', 'tenant_id', 'site_id', 'analytics', 'marketing', 'notice_version', 'action', 'recorded_at', 'user_agent_class']

const { check, summary } = makeChecker('0017')

async function seedTenant(c, tenantId, label) {
  await setCtx(c, { platform: true })
  await c.query(`INSERT INTO tenants (id, slug, company_ref) VALUES ($1, $2, $3)`, [tenantId, `m5g6-${label}-${tenantId.slice(0, 8)}`, randomUUID()])
  await setCtx(c, { tenant: tenantId })
  const site = (await one(c, `INSERT INTO sites (tenant_id, kind, name) VALUES ($1, 'astro', $2) RETURNING id`, [tenantId, label])).id
  return { tenantId, site }
}

const insert = (c, t, o = {}) =>
  attempt(
    c,
    `INSERT INTO consent_records (consent_id, tenant_id, site_id, analytics, marketing, notice_version, action, user_agent_class)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [o.consentId ?? randomUUID(), t.tenantId, t.site, o.analytics ?? true, o.marketing ?? false, o.version ?? '3', o.action ?? 'grant', o.ua ?? 'desktop'],
  )

async function partA(roles) {
  console.log('\n== A. catalog state (main db) ==')
  const c = await connect(MIGRATE)
  try {
    const ledger = await one(c, `SELECT count(*)::int AS n FROM schema_migrations WHERE name = $1`, [TARGET])
    check(`ledger records ${TARGET} exactly once`, ledger.n === 1, ledger)

    const cols = await c.query(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
      [TABLE],
    )
    const col = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]))
    check('exactly the intended columns exist (no ip, no raw user agent, no other identifier)', JSON.stringify(Object.keys(col).sort()) === JSON.stringify([...COLS].sort()), Object.keys(col))
    check('all columns are NOT NULL', Object.values(col).every((r) => r.is_nullable === 'NO'), cols.rows)
    check(
      'types: uuid ids, boolean categories, timestamptz recorded_at defaulting to now()',
      col.id?.data_type === 'uuid' && col.consent_id?.data_type === 'uuid' && col.analytics?.data_type === 'boolean' && col.marketing?.data_type === 'boolean' &&
        col.recorded_at?.data_type === 'timestamp with time zone' && /now\(\)/.test(col.recorded_at?.column_default ?? ''),
      cols.rows,
    )

    const cons = await c.query(`SELECT conname FROM pg_constraint WHERE conrelid = 'public.consent_records'::regclass`)
    const names = cons.rows.map((r) => r.conname)
    for (const n of ['consent_records_action_check', 'consent_records_notice_version_check', 'consent_records_ua_class_check', 'consent_records_withdraw_check']) {
      check(`constraint ${n} exists`, names.includes(n), names)
    }

    const idx = await c.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`, [TABLE])
    const ix = Object.fromEntries(idx.rows.map((r) => [r.indexname, r.indexdef]))
    check('ix_consent_records_subject on (tenant_id, consent_id, recorded_at)', /\(tenant_id, consent_id, recorded_at\)/.test(ix.ix_consent_records_subject ?? ''), ix)
    check('ix_consent_records_recorded on (tenant_id, recorded_at)', /\(tenant_id, recorded_at\)/.test(ix.ix_consent_records_recorded ?? ''), ix)

    const rls = await one(c, `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.consent_records'::regclass`)
    check('RLS enabled + FORCED', rls.relrowsecurity === true && rls.relforcerowsecurity === true, rls)
    const pol = await c.query(`SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`, [TABLE])
    check(
      'exactly one tenant_isolation policy, FOR ALL, keyed on webdesk_tenant_ctx() with no platform escape',
      pol.rows.length === 1 && pol.rows[0].policyname === 'tenant_isolation' && pol.rows[0].cmd === 'ALL' &&
        /webdesk_tenant_ctx\(\)/.test(pol.rows[0].qual) && !/platform/.test(pol.rows[0].qual) && /webdesk_tenant_ctx\(\)/.test(pol.rows[0].with_check),
      pol.rows,
    )

    const grants = await c.query(
      `SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = $1 AND grantee = $2 ORDER BY 1`,
      [TABLE, roles.app],
    )
    const g = grants.rows.map((r) => r.privilege_type)
    check(`${roles.app} has exactly SELECT, INSERT, DELETE (append-only: no UPDATE, no TRUNCATE)`, JSON.stringify(g) === JSON.stringify(['DELETE', 'INSERT', 'SELECT']), g)

    const second = runRunner(MIGRATE)
    check('a second runner pass applies 0 files', second.status === 0 && /0 applied/.test(second.stdout), second.stdout + second.stderr)
  } finally {
    await c.end()
  }
}

async function partB() {
  console.log('\n== B. behaviour as the app role (one transaction, rolled back) ==')
  const c = await connect(APP)
  try {
    await c.query('BEGIN')
    const A = await seedTenant(c, randomUUID(), 'a')
    const id = randomUUID()
    const ok = await insert(c, A, { consentId: id })
    check('a valid grant row is accepted', !ok.err, errSummary(ok))
    const rec = await one(c, `SELECT recorded_at <= now() AS stamped FROM consent_records WHERE id = $1`, [ok.rows[0].id])
    check('recorded_at is stamped by the server', rec.stamped === true, rec)
    check('a second row with the SAME consent id is accepted (history appends)', !(await insert(c, A, { consentId: id, action: 'update', analytics: false })).err)
    check('a withdraw with both categories off is accepted', !(await insert(c, A, { consentId: id, action: 'withdraw', analytics: false, marketing: false })).err)

    const bad = [
      ['an unknown action', { action: 'delete' }],
      ['an empty notice version', { version: '' }],
      ['a 33-char notice version', { version: 'x'.repeat(33) }],
      ['an unknown user_agent_class', { ua: 'Mozilla/5.0 (X11; Linux x86_64)' }],
      ['a withdraw that still grants analytics', { action: 'withdraw', analytics: true, marketing: false }],
      ['a withdraw that still grants marketing', { action: 'withdraw', analytics: false, marketing: true }],
    ]
    for (const [name, o] of bad) {
      await c.query('SAVEPOINT s')
      const r = await insert(c, A, o)
      check(`${name} is refused by a CHECK`, r.err?.code === '23514', errSummary(r))
      await c.query('ROLLBACK TO SAVEPOINT s')
    }
    await c.query('SAVEPOINT s')
    const noSite = await attempt(c, `INSERT INTO consent_records (consent_id, tenant_id, site_id, analytics, marketing, notice_version, action) VALUES ($1,$2,$3,true,true,'3','grant')`, [randomUUID(), A.tenantId, randomUUID()])
    check('an unknown site_id is refused by the foreign key', noSite.err?.code === '23503', errSummary(noSite))
    await c.query('ROLLBACK TO SAVEPOINT s')

    await c.query('SAVEPOINT s')
    const upd = await attempt(c, `UPDATE consent_records SET analytics = false WHERE consent_id = $1`, [id])
    check('UPDATE is refused to the app role (append-only: a decision is never rewritten)', upd.err?.code === '42501', errSummary(upd))
    await c.query('ROLLBACK TO SAVEPOINT s')
    await c.query('SAVEPOINT s')
    const trunc = await attempt(c, `TRUNCATE consent_records`)
    check('TRUNCATE is refused', trunc.err?.code === '42501', errSummary(trunc))
    await c.query('ROLLBACK TO SAVEPOINT s')

    // RLS isolation with a positive control.
    const B = await seedTenant(c, randomUUID(), 'b')
    const bId = randomUUID()
    await insert(c, B, { consentId: bId })
    await setCtx(c, { tenant: A.tenantId })
    const seenByA = (await c.query(`SELECT consent_id FROM consent_records WHERE consent_id = ANY($1)`, [[id, bId]])).rows.map((r) => r.consent_id)
    check("POSITIVE CONTROL: tenant A sees its own records (3 rows), never B's", seenByA.length === 3 && seenByA.every((x) => x === id), seenByA)
    await c.query('SAVEPOINT s')
    const crossIns = await attempt(c, `INSERT INTO consent_records (consent_id, tenant_id, site_id, analytics, marketing, notice_version, action) VALUES ($1,$2,$3,true,true,'3','grant')`, [randomUUID(), B.tenantId, B.site])
    check('tenant A cannot INSERT a row for tenant B (RLS WITH CHECK)', crossIns.err?.code === '42501', errSummary(crossIns))
    await c.query('ROLLBACK TO SAVEPOINT s')
    await setCtx(c, { tenant: A.tenantId })
    const crossDel = await attempt(c, `DELETE FROM consent_records WHERE consent_id = $1`, [bId])
    check("tenant A's DELETE of B's records matches 0 rows", !crossDel.err && crossDel.rowCount === 0, errSummary(crossDel))
    const ownDel = await attempt(c, `DELETE FROM consent_records WHERE consent_id = $1`, [id])
    check('DELETE of its own records works (the retention purge and privacy.erase path): 3 rows', !ownDel.err && ownDel.rowCount === 3, errSummary(ownDel))

    await setCtx(c, {})
    const unset = await one(c, `SELECT count(*)::int AS n FROM consent_records`)
    check('an UNSET tenant context sees ZERO rows (fail-closed)', unset.n === 0, unset)
    await c.query('SAVEPOINT s')
    const unsetIns = await insert(c, A)
    check('an UNSET tenant context refuses an INSERT', unsetIns.err?.code === '42501', errSummary(unsetIns))
    await c.query('ROLLBACK TO SAVEPOINT s')
    await setCtx(c, { platform: true })
    const plat = await one(c, `SELECT count(*)::int AS n FROM consent_records`)
    check('platform_ctx is NOT an escape (0 rows)', plat.n === 0, plat)
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    await c.end()
  }
}

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

const keyed = (rows) => rows.map((s) => JSON.parse(s))

async function partD(roles) {
  console.log('\n== D. scratch database at 0016 -> the real runner ==')
  const db = 'm5_0017_pos'
  try {
    await createScratchDb(SUPER, db, roles)
    const url = withDb(MIGRATE, db)
    const applied = await applyThrough(url, TARGET)
    check(`[pos] scratch db built through ${PREV} (${applied.length} files, none of them 0017)`, applied.includes(PREV) && !applied.includes(TARGET), applied)
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
    check('[pos] the real runner applies exactly 0017 (exit 0, 1 applied)', run.status === 0 && /1 applied/.test(run.stdout), run.stdout + run.stderr)
    const after = await snap()
    const diff = {}
    for (const k of Object.keys(SNAPSHOT_SQL)) {
      const a = new Set(after[k])
      const b = new Set(before[k])
      diff[k] = { lost: keyed(before[k].filter((x) => !a.has(x))), added: keyed(after[k].filter((x) => !b.has(x))) }
      console.log(`        ${k}: before=${before[k].length} after=${after[k].length} added=${diff[k].added.length} lost=${diff[k].lost.length}`)
      check(`[pos] ${k}: nothing lost`, diff[k].lost.length === 0, diff[k].lost)
    }
    check('[pos] columns: exactly the ten of consent_records', diff.columns.added.length === COLS.length && diff.columns.added.every((r) => r[0] === TABLE), diff.columns.added)
    check('[pos] indexes: only consent_records', diff.indexes.added.length > 0 && diff.indexes.added.every((r) => r[0] === TABLE), diff.indexes.added)
    check('[pos] constraints: only consent_records', diff.constraints.added.length > 0 && diff.constraints.added.every((r) => r[0] === TABLE), diff.constraints.added)
    check('[pos] policies: exactly one, on consent_records', diff.policies.added.length === 1 && diff.policies.added[0][0] === TABLE, diff.policies.added)
    check('[pos] grants: only consent_records', diff.grants.added.length > 0 && diff.grants.added.every((r) => r[0] === TABLE), diff.grants.added)
    check('[pos] rls: only consent_records (enabled + forced)', diff.rls.added.length === 1 && diff.rls.added[0][0] === TABLE && diff.rls.added[0][1] === true && diff.rls.added[0][2] === true, diff.rls.added)
    check('[pos] triggers: nothing added', diff.triggers.added.length === 0, diff.triggers.added)
    const again = runRunner(url, { through: TARGET })
    check('[pos] a second pass is a no-op (0 applied)', again.status === 0 && /0 applied/.test(again.stdout), again.stdout + again.stderr)
  } finally {
    await dropScratchDb(SUPER, db).catch(() => {})
  }
}

const roles = await resolveRoles(SUPER, MIGRATE, APP)
await partA(roles)
await partB()
await partC()
await partD(roles)
process.exit(summary())
