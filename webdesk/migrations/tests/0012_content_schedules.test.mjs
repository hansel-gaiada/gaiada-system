#!/usr/bin/env node
/**
 * WSK-61 — migration 0012 (content_schedules: pending version swaps on live items) proven against a
 * real Postgres.
 *
 * Six parts, one exit code:
 *   A. Catalog state of the MAIN database (already migrated through 0012 by the real runner): the shape
 *      (columns, constraints, indexes, foreign keys), RLS enabled + FORCED + one policy, the app role's
 *      grants (SELECT/INSERT/UPDATE, never DELETE), and a second runner pass applying 0 files.
 *   B. Behaviour as the app role, inside one transaction that is ROLLED BACK: the one-pending-swap rule
 *      (with positive controls that a cancelled, executed or failed row frees the slot), the
 *      at-most-one-terminal CHECK, the publish/unpublish window CHECK, version >= 1, and the reason
 *      columns requiring their timestamp.
 *   C. RLS isolation between two tenants, with a positive control: a tenant sees only its own rows,
 *      cannot insert or update another tenant's, and an unset context sees nothing (fail-closed).
 *   D. The privileges exercised for real: DELETE and TRUNCATE are refused with 42501, UPDATE works.
 *   E. Idempotent re-run: the real runner applies 0 files a second time, and executing the SQL file
 *      again as the migrator changes nothing (before/after catalog snapshots are identical).
 *   F. A scratch database at 0010, then the REAL runner: it applies exactly 0012 and ONLY the intended
 *      catalog changes happen (exact before/after diff).
 *
 * Env (all point at the same cluster):
 *   SUPERUSER_DATABASE_URL  cluster bootstrap identity on the main db (creates/drops scratch dbs)
 *   MIGRATE_DATABASE_URL    webdesk_migrator on the main db
 *   APP_DATABASE_URL        webdesk_app on the main db
 *
 * Run (from webdesk/api, for the same reason as the 0009/0010 files):
 *   node --import tsx ../migrations/tests/0012_content_schedules.test.mjs
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

const TARGET = '0012_content_schedules.sql'
const TABLE = 'content_schedules'
const PREV = '0010_slug_release_and_ledger.sql' // 0011 is another ticket's (it may or may not be present yet)

const { check, summary } = makeChecker('0012')

const PENDING = `executed_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL`

// A tenant, site, collection and item as the app role, in the caller's open transaction.
async function seedItem(c, tenantId, label) {
  await setCtx(c, { platform: true })
  await c.query(`INSERT INTO tenants (id, slug, company_ref) VALUES ($1, $2, $3)`, [tenantId, `wsk61-${label}-${tenantId.slice(0, 8)}`, randomUUID()])
  await setCtx(c, { tenant: tenantId })
  const site = (await one(c, `INSERT INTO sites (tenant_id, kind, name) VALUES ($1, 'astro', $2) RETURNING id`, [tenantId, label])).id
  const col = (await one(c, `INSERT INTO collections (tenant_id, site_id, key) VALUES ($1, $2, 'page') RETURNING id`, [tenantId, site])).id
  const item = (
    await one(
      c,
      `INSERT INTO content_items (tenant_id, site_id, collection_id, locale, slug, localization_group_id, publish_state)
       VALUES ($1, $2, $3, 'en', 'home', gen_random_uuid(), 'published') RETURNING id`,
      [tenantId, site, col],
    )
  ).id
  return { tenantId, site, item }
}

const insertSchedule = (c, s, over = {}) =>
  attempt(
    c,
    `INSERT INTO content_schedules (tenant_id, site_id, content_item_id, version, publish_at, unpublish_at, requested_by, ws4_approval_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'user-1', 'apr-1') RETURNING id`,
    [s.tenantId, s.site, s.item, over.version ?? 2, over.publishAt ?? '2030-01-01T00:00:00Z', over.unpublishAt ?? null],
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

    const cols = await c.query(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [TABLE],
    )
    const col = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]))
    console.log(`        columns: ${cols.rows.map((r) => `${r.column_name}:${r.data_type}${r.is_nullable === 'NO' ? '!' : ''}`).join(' ')}`)
    check(
      'the 15 columns, in order',
      cols.rows.map((r) => r.column_name).join() ===
        'id,tenant_id,site_id,content_item_id,version,publish_at,unpublish_at,requested_by,ws4_approval_id,created_at,executed_at,cancelled_at,cancel_reason,failed_at,fail_reason',
      cols.rows.map((r) => r.column_name),
    )
    const notNull = ['id', 'tenant_id', 'site_id', 'content_item_id', 'version', 'publish_at', 'requested_by', 'created_at']
    const nullable = ['unpublish_at', 'ws4_approval_id', 'executed_at', 'cancelled_at', 'cancel_reason', 'failed_at', 'fail_reason']
    check('NOT NULL exactly on id, tenant_id, site_id, content_item_id, version, publish_at, requested_by, created_at',
      notNull.every((n) => col[n]?.is_nullable === 'NO') && nullable.every((n) => col[n]?.is_nullable === 'YES'), cols.rows.map((r) => [r.column_name, r.is_nullable]))
    check('types: uuid ids, integer version, timestamptz instants, text the rest',
      ['id', 'tenant_id', 'site_id', 'content_item_id'].every((n) => col[n].data_type === 'uuid') &&
        col.version.data_type === 'integer' &&
        ['publish_at', 'unpublish_at', 'created_at', 'executed_at', 'cancelled_at', 'failed_at'].every((n) => col[n].data_type === 'timestamp with time zone') &&
        ['requested_by', 'ws4_approval_id', 'cancel_reason', 'fail_reason'].every((n) => col[n].data_type === 'text'),
      cols.rows)
    check('defaults: id gen_random_uuid(), created_at now()', /gen_random_uuid/.test(col.id.column_default ?? '') && /now\(\)/.test(col.created_at.column_default ?? ''), [col.id.column_default, col.created_at.column_default])

    const cons = await c.query(
      `SELECT conname, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.content_schedules'::regclass ORDER BY conname`,
    )
    const cn = Object.fromEntries(cons.rows.map((r) => [r.conname, r.def]))
    for (const r of cons.rows) console.log(`        ${r.conname}: ${r.def}`)
    check('primary key on id', cons.rows.some((r) => r.contype === 'p' && /PRIMARY KEY \(id\)/.test(r.def)), cons.rows)
    const fks = cons.rows.filter((r) => r.contype === 'f').map((r) => r.def).sort()
    check('foreign keys: tenants(id), sites(id), content_items(id)',
      fks.length === 3 &&
        fks.some((d) => /\(tenant_id\) REFERENCES tenants\(id\)/.test(d)) &&
        fks.some((d) => /\(site_id\) REFERENCES sites\(id\)/.test(d)) &&
        fks.some((d) => /\(content_item_id\) REFERENCES content_items\(id\)/.test(d)),
      fks)
    check('CHECK version >= 1', cons.rows.some((r) => r.contype === 'c' && /version >= 1/.test(r.def)), cn)
    check('CHECK content_schedules_window_check: unpublish_at > publish_at', /unpublish_at IS NULL\) OR \(unpublish_at > publish_at\)/.test(cn.content_schedules_window_check ?? ''), cn.content_schedules_window_check)
    check('CHECK content_schedules_one_terminal_check: num_nonnulls(...) <= 1', /num_nonnulls\(executed_at, cancelled_at, failed_at\) <= 1/.test(cn.content_schedules_one_terminal_check ?? ''), cn.content_schedules_one_terminal_check)

    const idx = await c.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 ORDER BY indexname`, [TABLE])
    const ix = Object.fromEntries(idx.rows.map((r) => [r.indexname, r.indexdef]))
    for (const r of idx.rows) console.log(`        ${r.indexdef}`)
    const pendingPredicate = /WHERE \(\(executed_at IS NULL\) AND \(cancelled_at IS NULL\) AND \(failed_at IS NULL\)\)/
    check('ux_content_schedules_one_pending: UNIQUE (content_item_id) over pending rows only', /UNIQUE INDEX .* \(content_item_id\)/.test(ix.ux_content_schedules_one_pending ?? '') && pendingPredicate.test(ix.ux_content_schedules_one_pending ?? ''), ix.ux_content_schedules_one_pending)
    check('ix_content_schedules_due: (publish_at) over pending rows only', /\(publish_at\)/.test(ix.ix_content_schedules_due ?? '') && pendingPredicate.test(ix.ix_content_schedules_due ?? '') && !/UNIQUE/.test(ix.ix_content_schedules_due ?? ''), ix.ix_content_schedules_due)
    check('ix_content_schedules_tenant exists', !!ix.ix_content_schedules_tenant, Object.keys(ix))

    const rls = await one(
      c,
      `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
              pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c WHERE c.relname = $1 AND c.relnamespace = 'public'::regnamespace`,
      [TABLE],
    )
    check('RLS enabled + FORCED + exactly 1 policy (the check-rls-integrity.mjs triple)', rls.enabled === true && rls.forced === true && rls.policies === 1, rls)
    check(`owned by the migrating role ${roles.migrator}`, rls.owner === roles.migrator, rls)
    const pol = await one(c, `SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`, [TABLE])
    check('policy tenant_isolation FOR ALL on tenant_id = webdesk_tenant_ctx(), USING and WITH CHECK', pol.policyname === 'tenant_isolation' && pol.cmd === 'ALL' && /tenant_id = webdesk_tenant_ctx\(\)/.test(pol.qual) && /tenant_id = webdesk_tenant_ctx\(\)/.test(pol.with_check), pol)

    const privs = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
    const app = {}
    for (const p of privs) app[p] = (await one(c, `SELECT has_table_privilege($1, 'content_schedules', $2) AS ok`, [roles.app, p])).ok
    console.log(`        ${roles.app} on ${TABLE}: ${JSON.stringify(app)}`)
    check(`${roles.app} holds SELECT, INSERT, UPDATE`, app.SELECT && app.INSERT && app.UPDATE, app)
    check(`${roles.app} has NO DELETE, TRUNCATE, REFERENCES or TRIGGER (history is never deleted)`, !app.DELETE && !app.TRUNCATE && !app.REFERENCES && !app.TRIGGER, app)

    const again = runRunner(MIGRATE)
    console.log(`        runner (second pass): exit=${again.status}: ${again.stdout.trim().split('\n').at(-1)}`)
    check('re-running the real migrator applies 0 files', again.status === 0 && /0 applied/.test(again.stdout), again.stdout + again.stderr)
  } finally {
    await c.end()
  }
}

// =============================================================================================
// B. Behaviour as the app role (rolled back)
// =============================================================================================
async function partB() {
  console.log('\n== B. constraints, as the app role (one transaction, rolled back) ==')
  const c = await connect(APP)
  try {
    await c.query('BEGIN')
    const s = await seedItem(c, randomUUID(), 'b')

    let r = await insertSchedule(c, s)
    const first = r.rows?.[0]?.id
    check('a pending swap inserts', !r.err && !!first, errSummary(r))

    r = await insertSchedule(c, s, { version: 3 })
    check(
      'THE ONE-PENDING RULE: a second pending swap for the same item is refused, naming ux_content_schedules_one_pending',
      r.err?.code === '23505' && r.err.constraint === 'ux_content_schedules_one_pending',
      errSummary(r),
    )

    // Positive controls: every terminal state frees the slot, and history rows may repeat.
    for (const [state, set] of [
      ['cancelled', `cancelled_at = now(), cancel_reason = 'superseded'`],
      ['executed', `executed_at = now()`],
      ['failed', `failed_at = now(), fail_reason = 'version no longer validates'`],
    ]) {
      const cur = (await one(c, `SELECT id FROM content_schedules WHERE content_item_id = $1 AND ${PENDING}`, [s.item])).id
      r = await attempt(c, `UPDATE content_schedules SET ${set} WHERE id = $1`, [cur])
      check(`control: the pending row can become ${state}`, !r.err && r.rowCount === 1, errSummary(r))
      r = await insertSchedule(c, s, { version: 5 })
      check(`control: with the previous row ${state}, a new pending swap for the item is accepted`, !r.err, errSummary(r))
    }
    const history = await one(c, `SELECT count(*)::int AS n FROM content_schedules WHERE content_item_id = $1`, [s.item])
    check('four rows for the one item now exist (3 terminal + 1 pending)', history.n === 4, history)

    const pending = (await one(c, `SELECT id FROM content_schedules WHERE content_item_id = $1 AND ${PENDING}`, [s.item])).id
    r = await attempt(c, `UPDATE content_schedules SET executed_at = now(), cancelled_at = now() WHERE id = $1`, [pending])
    check('a row with TWO terminal timestamps is refused (content_schedules_one_terminal_check)', r.err?.code === '23514' && r.err.constraint === 'content_schedules_one_terminal_check', errSummary(r))
    r = await attempt(c, `UPDATE content_schedules SET failed_at = now(), fail_reason = 'x', executed_at = now() WHERE id = $1`, [pending])
    check('executed + failed is refused too', r.err?.code === '23514' && r.err.constraint === 'content_schedules_one_terminal_check', errSummary(r))
    r = await attempt(c, `UPDATE content_schedules SET executed_at = now() WHERE id = $1`, [pending])
    check('control: ONE terminal timestamp is accepted', !r.err && r.rowCount === 1, errSummary(r))
    r = await attempt(c, `UPDATE content_schedules SET cancelled_at = now() WHERE id = $1`, [pending])
    check('a terminal row cannot gain a second terminal state', r.err?.code === '23514', errSummary(r))

    r = await insertSchedule(c, { ...s, item: (await seedSecondItem(c, s)) }, { publishAt: '2030-01-01T00:00:00Z', unpublishAt: '2030-01-01T00:00:00Z' })
    check('unpublish_at = publish_at is refused (content_schedules_window_check)', r.err?.code === '23514' && r.err.constraint === 'content_schedules_window_check', errSummary(r))
    const item2 = await seedSecondItem(c, s)
    r = await insertSchedule(c, { ...s, item: item2 }, { publishAt: '2030-01-01T00:00:00Z', unpublishAt: '2029-12-31T00:00:00Z' })
    check('unpublish_at before publish_at is refused', r.err?.code === '23514' && r.err.constraint === 'content_schedules_window_check', errSummary(r))
    r = await insertSchedule(c, { ...s, item: item2 }, { publishAt: '2030-01-01T00:00:00Z', unpublishAt: '2030-02-01T00:00:00Z' })
    check('control: unpublish_at after publish_at is accepted', !r.err, errSummary(r))
    const item3 = await seedSecondItem(c, s)
    r = await insertSchedule(c, { ...s, item: item3 }, { unpublishAt: null })
    check('control: unpublish_at NULL is accepted', !r.err, errSummary(r))

    const item4 = await seedSecondItem(c, s)
    r = await insertSchedule(c, { ...s, item: item4 }, { version: 0 })
    check('version 0 is refused (version >= 1)', r.err?.code === '23514', errSummary(r))
    r = await attempt(c, `INSERT INTO content_schedules (tenant_id, site_id, content_item_id, version, publish_at, requested_by) VALUES ($1,$2,$3,1,now(),NULL)`, [s.tenantId, s.site, item4])
    check('requested_by NULL is refused', r.err?.code === '23502', errSummary(r))
    r = await attempt(c, `INSERT INTO content_schedules (tenant_id, site_id, content_item_id, version, publish_at, requested_by, cancel_reason) VALUES ($1,$2,$3,1,now(),'u','why')`, [s.tenantId, s.site, item4])
    check('a cancel_reason without cancelled_at is refused', r.err?.code === '23514' && r.err.constraint === 'content_schedules_cancel_reason_check', errSummary(r))
    r = await attempt(c, `INSERT INTO content_schedules (tenant_id, site_id, content_item_id, version, publish_at, requested_by, fail_reason) VALUES ($1,$2,$3,1,now(),'u','why')`, [s.tenantId, s.site, item4])
    check('a fail_reason without failed_at is refused', r.err?.code === '23514' && r.err.constraint === 'content_schedules_fail_reason_check', errSummary(r))
    r = await attempt(c, `INSERT INTO content_schedules (tenant_id, site_id, content_item_id, version, publish_at, requested_by) VALUES ($1,$2,$3,1,now(),'u')`, [s.tenantId, randomUUID(), item4])
    check('an unknown site_id is refused by its foreign key', r.err?.code === '23503', errSummary(r))
    r = await attempt(c, `INSERT INTO content_schedules (tenant_id, site_id, content_item_id, version, publish_at, requested_by) VALUES ($1,$2,$3,1,now(),'u')`, [s.tenantId, s.site, randomUUID()])
    check('an unknown content_item_id is refused by its foreign key', r.err?.code === '23503', errSummary(r))
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    await c.end()
  }
}

let itemCounter = 0
async function seedSecondItem(c, s) {
  const col = (await one(c, `SELECT id FROM collections WHERE site_id = $1 LIMIT 1`, [s.site])).id
  return (
    await one(
      c,
      `INSERT INTO content_items (tenant_id, site_id, collection_id, locale, slug, localization_group_id, publish_state)
       VALUES ($1, $2, $3, 'en', $4, gen_random_uuid(), 'published') RETURNING id`,
      [s.tenantId, s.site, col, `extra-${++itemCounter}`],
    )
  ).id
}

// =============================================================================================
// C. RLS isolation between two tenants
// =============================================================================================
async function partC() {
  console.log('\n== C. RLS isolation, two tenants (one transaction, rolled back) ==')
  const c = await connect(APP)
  try {
    await c.query('BEGIN')
    const A = await seedItem(c, randomUUID(), 'rls-a')
    let r = await insertSchedule(c, A)
    const aRow = r.rows[0].id
    const B = await seedItem(c, randomUUID(), 'rls-b')
    r = await insertSchedule(c, B)
    const bRow = r.rows[0].id

    await setCtx(c, { tenant: A.tenantId })
    const seenByA = (await c.query(`SELECT id FROM content_schedules WHERE id = ANY($1)`, [[aRow, bRow]])).rows.map((x) => x.id)
    check("POSITIVE CONTROL: tenant A sees its own row", seenByA.includes(aRow), seenByA)
    check("tenant A does NOT see tenant B's row", !seenByA.includes(bRow), seenByA)
    check('tenant A sees exactly one row of the two', seenByA.length === 1, seenByA)

    r = await insertSchedule(c, { ...B, item: B.item })
    check("tenant A cannot INSERT a row for tenant B (WITH CHECK, 42501)", r.err?.code === '42501', errSummary(r))
    r = await attempt(c, `UPDATE content_schedules SET cancelled_at = now(), cancel_reason = 'x' WHERE id = $1`, [bRow])
    check("tenant A's UPDATE of tenant B's row matches 0 rows", !r.err && r.rowCount === 0, errSummary(r))
    r = await attempt(c, `UPDATE content_schedules SET tenant_id = $2 WHERE id = $1`, [aRow, B.tenantId])
    check('tenant A cannot hand its own row to tenant B (WITH CHECK, 42501)', r.err?.code === '42501', errSummary(r))

    await setCtx(c, { tenant: B.tenantId })
    const seenByB = (await c.query(`SELECT id FROM content_schedules WHERE id = ANY($1)`, [[aRow, bRow]])).rows.map((x) => x.id)
    check("POSITIVE CONTROL: tenant B sees its own row and not A's", seenByB.length === 1 && seenByB[0] === bRow, seenByB)
    const bStill = await one(c, `SELECT cancelled_at FROM content_schedules WHERE id = $1`, [bRow])
    check("tenant B's row was not touched by A's attempts", bStill.cancelled_at === null, bStill)

    await setCtx(c, {})
    const unset = await one(c, `SELECT count(*)::int AS n FROM content_schedules WHERE id = ANY($1)`, [[aRow, bRow]])
    check('an UNSET tenant context sees ZERO rows (fail-closed, no error)', unset.n === 0, unset)
    await setCtx(c, { platform: true })
    const platform = await one(c, `SELECT count(*)::int AS n FROM content_schedules WHERE id = ANY($1)`, [[aRow, bRow]])
    check('platform_ctx has no escape hatch on this table (single-mode policy): 0 rows', platform.n === 0, platform)
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    await c.end()
  }
}

// =============================================================================================
// D. Privileges, exercised for real
// =============================================================================================
async function partD(roles) {
  console.log('\n== D. DELETE / TRUNCATE refused, UPDATE allowed (as the app role) ==')
  const c = await connect(APP)
  try {
    await c.query('BEGIN')
    const s = await seedItem(c, randomUUID(), 'd')
    const r0 = await insertSchedule(c, s)
    check('setup: a row exists', !r0.err, errSummary(r0))
    let r = await attempt(c, `DELETE FROM content_schedules WHERE tenant_id = $1`, [s.tenantId])
    check('DELETE -> 42501 permission denied', r.err?.code === '42501', errSummary(r))
    r = await attempt(c, `TRUNCATE content_schedules`)
    check('TRUNCATE -> 42501 permission denied', r.err?.code === '42501', errSummary(r))
    r = await attempt(c, `UPDATE content_schedules SET cancelled_at = now(), cancel_reason = 'superseded' WHERE id = $1`, [r0.rows[0].id])
    check('POSITIVE CONTROL: UPDATE (the lifecycle transition) is allowed', !r.err && r.rowCount === 1, errSummary(r))
    r = await attempt(c, `SELECT count(*) FROM content_schedules`)
    check('POSITIVE CONTROL: SELECT is allowed', !r.err, errSummary(r))
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    await c.end()
  }
  const m = await connect(MIGRATE)
  try {
    const mig = (await one(m, `SELECT has_table_privilege($1, 'content_schedules', 'DELETE') AS ok`, [roles.migrator])).ok
    check(`POSITIVE CONTROL: the owner ${roles.migrator} still holds DELETE (only the app role is restricted)`, mig === true, mig)
  } finally {
    await m.end()
  }
}

// =============================================================================================
// E. Idempotent re-run
// =============================================================================================
async function partE() {
  console.log('\n== E. idempotent re-run ==')
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
    check('and changes nothing in the catalog (constraints, indexes, policies, columns, grants, RLS flags, triggers)', diffs.length === 0, diffs)
  } finally {
    await m.end()
  }
}

// =============================================================================================
// F. Scratch database at 0010 -> the real runner
// =============================================================================================
const keyed = (rows) => rows.map((s) => JSON.parse(s))

async function partF(roles) {
  console.log('\n== F. scratch database at 0010 -> the real runner ==')
  const db = 'wsk_61_pos'
  try {
    await createScratchDb(SUPER, db, roles)
    const url = withDb(MIGRATE, db)
    const applied = await applyThrough(url, TARGET)
    check(`[pos] scratch db built through ${PREV} (${applied.length} files, none of them 0012)`, applied.includes(PREV) && !applied.includes(TARGET), applied)
    const before = await (async () => {
      const c = await connect(url)
      try {
        return await snapshot(c)
      } finally {
        await c.end()
      }
    })()
    const run = runRunner(url, { through: TARGET })
    console.log(`        runner exit=${run.status}: ${(run.stdout + run.stderr).trim().split('\n').join(' | ')}`)
    check('[pos] the real runner applies exactly 0012 (exit 0, 1 applied)', run.status === 0 && /1 applied/.test(run.stdout), run.stdout + run.stderr)
    const c = await connect(url)
    let after
    try {
      after = await snapshot(c)
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
    for (const k of Object.keys(SNAPSHOT_SQL)) {
      check(`[pos] ${k}: nothing lost`, diff[k].lost.length === 0, diff[k].lost)
    }
    check('[pos] columns: 15 added, all on content_schedules', diff.columns.added.length === 15 && diff.columns.added.every((r) => r[0] === TABLE), diff.columns.added.length)
    check('[pos] constraints: only content_schedules constraints added', diff.constraints.added.length > 0 && diff.constraints.added.every((r) => r[0] === TABLE), diff.constraints.added)
    check('[pos] indexes: exactly the pk + 3 new, all on content_schedules', diff.indexes.added.length === 4 && diff.indexes.added.every((r) => r[0] === TABLE), diff.indexes.added)
    check('[pos] policies: exactly tenant_isolation on content_schedules', diff.policies.added.length === 1 && diff.policies.added[0][0] === TABLE && diff.policies.added[0][1] === 'tenant_isolation', diff.policies.added)
    check('[pos] triggers: none added', diff.triggers.added.length === 0, diff.triggers.added)
    const appGrants = diff.grants.added.filter((g) => g[1] === roles.app).map((g) => g[2]).sort()
    check(`[pos] grants: ${roles.app} gains exactly SELECT, INSERT, UPDATE, and only on content_schedules`, diff.grants.added.every((g) => g[0] === TABLE) && appGrants.join() === 'INSERT,SELECT,UPDATE', diff.grants.added)
    const rlsRow = diff.rls.added.find((r) => r[0] === TABLE)
    check('[pos] rls: content_schedules arrives enabled + forced', diff.rls.added.length === 1 && rlsRow?.[1] === true && rlsRow?.[2] === true, diff.rls.added)
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
await partE()
await partF(roles)
process.exit(summary())
