#!/usr/bin/env node
/**
 * WebDesk M5 (M5-L1 / M5-L2) — migration 0015 (submissions.attribution, visitor_consent,
 * data_subject_phone_ref) proven against a real Postgres.
 *
 * Five parts, one exit code (same shape as 0013_preview_tokens.test.mjs):
 *   A. Catalog state of the MAIN database (already migrated through 0015 by the real runner): the three
 *      columns (types, all nullable, no default), the partial phone index mirroring ix_submissions_data_subject,
 *      RLS still enabled + FORCED with the one policy, and the app role's grants unchanged.
 *   B. Behaviour as the app role, in one transaction that is ROLLED BACK: a row written the OLD way (none of
 *      the three columns) is still valid and reads NULL; a row carrying all three round-trips as jsonb/text;
 *      the erase/purge scrub UPDATE nulls all three; RLS isolates the new columns between two tenants with a
 *      positive control, and an unset context sees nothing.
 *   C. Idempotent re-run: the real runner applies 0 files again, and executing the SQL file a second time
 *      changes nothing (identical catalog snapshots).
 *   D. A scratch database at 0014, then the REAL runner: it applies exactly 0015 and ONLY the intended
 *      catalog changes happen (exact before/after diff: 3 columns and 1 index, nothing else).
 *   E. A row that exists BEFORE 0015 survives it with the three new columns NULL (additive, no backfill).
 *
 * Env (all point at the same cluster):
 *   SUPERUSER_DATABASE_URL  cluster bootstrap identity on the main db (creates/drops scratch dbs)
 *   MIGRATE_DATABASE_URL    webdesk_migrator on the main db
 *   APP_DATABASE_URL        webdesk_app on the main db
 *
 * Run (from webdesk/api, for the same reason as the 0009-0014 files):
 *   node --import tsx ../migrations/tests/0015_submission_attribution.test.mjs
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

const TARGET = '0015_submission_attribution.sql'
const PREV = '0014_media_library.sql'
const TABLE = 'submissions'
const NEW_COLS = ['attribution', 'visitor_consent', 'data_subject_phone_ref']

const { check, summary } = makeChecker('0015')

// A tenant, site and form_def, as the caller's open transaction on the app role.
async function seedForm(c, tenantId, label) {
  await setCtx(c, { platform: true })
  await c.query(`INSERT INTO tenants (id, slug, company_ref) VALUES ($1, $2, $3)`, [tenantId, `m5-${label}-${tenantId.slice(0, 8)}`, randomUUID()])
  await setCtx(c, { tenant: tenantId })
  const site = (await one(c, `INSERT INTO sites (tenant_id, kind, name) VALUES ($1, 'astro', $2) RETURNING id`, [tenantId, label])).id
  const form = (
    await one(c, `INSERT INTO form_defs (tenant_id, site_id, key, schema, notify, retention_days) VALUES ($1, $2, 'contact', '{}'::jsonb, '{}'::jsonb, 180) RETURNING id`, [tenantId, site])
  ).id
  return { tenantId, site, form }
}

const insertSub = (c, s, extra = {}) =>
  attempt(
    c,
    `INSERT INTO submissions (tenant_id, site_id, form_def_id, payload, consent_notice_text, consent_notice_version, expires_at,
                             attribution, visitor_consent, data_subject_phone_ref)
     VALUES ($1, $2, $3, '{"fields":{}}'::jsonb, 'notice', 'v1', now() + interval '1 day', $4::jsonb, $5::jsonb, $6) RETURNING id`,
    [s.tenantId, s.site, s.form, extra.attribution ?? null, extra.visitorConsent ?? null, extra.phone ?? null],
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
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2)`,
      [TABLE, NEW_COLS],
    )
    const col = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]))
    check('all three columns exist', NEW_COLS.every((n) => col[n]), Object.keys(col))
    check(
      'attribution and visitor_consent are jsonb, data_subject_phone_ref is text',
      col.attribution?.data_type === 'jsonb' && col.visitor_consent?.data_type === 'jsonb' && col.data_subject_phone_ref?.data_type === 'text',
      cols.rows,
    )
    check('all three are NULLable with no default (absent = unknown, never a made-up value)', NEW_COLS.every((n) => col[n]?.is_nullable === 'YES' && col[n]?.column_default === null), cols.rows)

    const idx = await c.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`, [TABLE])
    const ix = Object.fromEntries(idx.rows.map((r) => [r.indexname, r.indexdef]))
    check(
      'ix_submissions_data_subject_phone: (tenant_id, data_subject_phone_ref) over non-null rows, like the email index',
      /\(tenant_id, data_subject_phone_ref\)/.test(ix.ix_submissions_data_subject_phone ?? '') &&
        /WHERE \(data_subject_phone_ref IS NOT NULL\)/.test(ix.ix_submissions_data_subject_phone ?? ''),
      ix.ix_submissions_data_subject_phone,
    )
    check('the 0003 email index is untouched', /\(tenant_id, data_subject_ref\)/.test(ix.ix_submissions_data_subject ?? ''), ix.ix_submissions_data_subject)

    const rls = await one(c, `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.submissions'::regclass`)
    check('RLS still enabled + FORCED on submissions', rls.relrowsecurity === true && rls.relforcerowsecurity === true, rls)
    const pol = await c.query(`SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`, [TABLE])
    check('still exactly the one tenant_isolation policy', pol.rows.length === 1 && pol.rows[0].policyname === 'tenant_isolation', pol.rows)

    const grants = await c.query(
      `SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = $1 AND grantee = $2 ORDER BY 1`,
      [TABLE, roles.app],
    )
    check(`${roles.app} grants on submissions are the plain DML set (no TRUNCATE)`, !grants.rows.some((g) => g.privilege_type === 'TRUNCATE'), grants.rows)

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
    const A = await seedForm(c, randomUUID(), 'a')
    const old = await attempt(
      c,
      `INSERT INTO submissions (tenant_id, site_id, form_def_id, payload, consent_notice_text, consent_notice_version, expires_at)
       VALUES ($1, $2, $3, '{"fields":{}}'::jsonb, 'n', 'v1', now() + interval '1 day') RETURNING attribution, visitor_consent, data_subject_phone_ref`,
      [A.tenantId, A.site, A.form],
    )
    check('a row written the OLD way (none of the new columns) is accepted and reads NULL x3', !old.err && NEW_COLS.every((n) => old.rows[0][n] === null), errSummary(old))

    const attribution = { landing: '/services/web/', utm_source: 'google', sections_seen: ['home.hero'] }
    const consent = { analytics: true, marketing: false, version: '3', decided_at: '2026-10-11T09:00:00Z' }
    const full = await insertSub(c, A, { attribution: JSON.stringify(attribution), visitorConsent: JSON.stringify(consent), phone: '6281234567890' })
    check('a row carrying all three is accepted', !full.err, errSummary(full))
    const back = await one(c, `SELECT attribution, visitor_consent, data_subject_phone_ref FROM submissions WHERE id = $1`, [full.rows[0].id])
    check(
      'attribution and visitor_consent round-trip as jsonb, the phone ref as text',
      JSON.stringify(back.attribution) === JSON.stringify(attribution) && back.visitor_consent.marketing === false && back.data_subject_phone_ref === '6281234567890',
      back,
    )

    const viaPhone = await c.query(`SELECT id FROM submissions WHERE tenant_id = $1 AND data_subject_phone_ref = $2`, [A.tenantId, '6281234567890'])
    check('the phone ref is findable by tenant + value', viaPhone.rows.length === 1, viaPhone.rows)

    const scrub = await attempt(
      c,
      `UPDATE submissions SET status = 'erased', payload = '{}'::jsonb, data_subject_ref = NULL,
              attribution = NULL, visitor_consent = NULL, data_subject_phone_ref = NULL WHERE id = $1`,
      [full.rows[0].id],
    )
    check('the erase/purge scrub UPDATE nulls all three (the app role may UPDATE them)', !scrub.err && scrub.rowCount === 1, errSummary(scrub))

    // RLS isolation with a positive control.
    const keep = await insertSub(c, A, { attribution: JSON.stringify(attribution), phone: '628111' })
    const B = await seedForm(c, randomUUID(), 'b')
    const bRow = await insertSub(c, B, { phone: '628222' })
    await setCtx(c, { tenant: A.tenantId })
    const seenByA = (await c.query(`SELECT id FROM submissions WHERE id = ANY($1)`, [[keep.rows[0].id, bRow.rows[0].id]])).rows.map((r) => r.id)
    check("POSITIVE CONTROL: tenant A sees its own row with the new columns; not B's", seenByA.length === 1 && seenByA[0] === keep.rows[0].id, seenByA)
    const bPhone = await c.query(`SELECT id FROM submissions WHERE data_subject_phone_ref = '628222'`)
    check("tenant A cannot find tenant B's phone ref", bPhone.rows.length === 0, bPhone.rows)
    const cross = await attempt(c, `UPDATE submissions SET attribution = '{}'::jsonb WHERE id = $1`, [bRow.rows[0].id])
    check("tenant A's UPDATE of B's row matches 0 rows", !cross.err && cross.rowCount === 0, errSummary(cross))
    await setCtx(c, {})
    const unset = await one(c, `SELECT count(*)::int AS n FROM submissions WHERE id = ANY($1)`, [[keep.rows[0].id, bRow.rows[0].id]])
    check('an UNSET tenant context sees ZERO rows (fail-closed)', unset.n === 0, unset)
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
// D + E. Scratch database at 0014 -> the real runner
// =============================================================================================
const keyed = (rows) => rows.map((s) => JSON.parse(s))

async function partDE(roles) {
  console.log('\n== D/E. scratch database at 0014 -> the real runner ==')
  const db = 'm5_0015_pos'
  try {
    await createScratchDb(SUPER, db, roles)
    const url = withDb(MIGRATE, db)
    const applied = await applyThrough(url, TARGET)
    check(`[pos] scratch db built through ${PREV} (${applied.length} files, none of them 0015)`, applied.includes(PREV) && !applied.includes(TARGET), applied)

    // E. a pre-existing row (as the migrator, under the right GUCs, committed).
    const tenantId = randomUUID()
    let rowId
    const m = await connect(url)
    try {
      await m.query('BEGIN')
      await setCtx(m, { platform: true })
      await m.query(`INSERT INTO tenants (id, slug, company_ref) VALUES ($1, $2, $3)`, [tenantId, `m5-pre-${tenantId.slice(0, 8)}`, randomUUID()])
      await setCtx(m, { tenant: tenantId })
      const site = (await one(m, `INSERT INTO sites (tenant_id, kind, name) VALUES ($1, 'astro', 's') RETURNING id`, [tenantId])).id
      const form = (await one(m, `INSERT INTO form_defs (tenant_id, site_id, key) VALUES ($1, $2, 'contact') RETURNING id`, [tenantId, site])).id
      rowId = (
        await one(
          m,
          `INSERT INTO submissions (tenant_id, site_id, form_def_id, payload, consent_notice_text, consent_notice_version, expires_at)
           VALUES ($1, $2, $3, '{"fields":{"email":"a@b.co"}}'::jsonb, 'n', 'v1', now() + interval '1 day') RETURNING id`,
          [tenantId, site, form],
        )
      ).id
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
    check('[pos] the real runner applies exactly 0015 (exit 0, 1 applied)', run.status === 0 && /1 applied/.test(run.stdout), run.stdout + run.stderr)
    const after = await snap()

    const c = await connect(url)
    try {
      await c.query('BEGIN')
      await setCtx(c, { tenant: tenantId })
      const row = await one(c, `SELECT attribution, visitor_consent, data_subject_phone_ref, payload FROM submissions WHERE id = $1`, [rowId])
      await c.query('ROLLBACK')
      check('[E] a row from before 0015 survives it: the three new columns are NULL, payload intact', NEW_COLS.every((n) => row[n] === null) && row.payload.fields.email === 'a@b.co', row)
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
    check(
      '[pos] columns: exactly the three new ones, all on submissions and nullable',
      diff.columns.added.length === 3 && diff.columns.added.every((r) => r[0] === TABLE && NEW_COLS.includes(r[1]) && r[3] === 'YES'),
      diff.columns.added,
    )
    check('[pos] indexes: exactly ix_submissions_data_subject_phone', diff.indexes.added.length === 1 && diff.indexes.added[0][1] === 'ix_submissions_data_subject_phone', diff.indexes.added)
    for (const k of ['constraints', 'policies', 'grants', 'rls', 'triggers']) check(`[pos] ${k}: nothing added`, diff[k].added.length === 0, diff[k].added)
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
await partDE(roles)
process.exit(summary())
