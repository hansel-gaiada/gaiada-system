#!/usr/bin/env node
/**
 * WebDesk M5-W1q (owner ruling WSK-D84) -- migration 0020 (media_assets.review_state + reviewed_by/at, media_upload_tokens.quarantine)
 * proven against a real Postgres. Same shape as 0019_site_status.test.mjs, four parts, one exit code:
 *   A. Catalog state of the MAIN database: the columns, their defaults and NOT NULLs, the two CHECKs, the review-queue index,
 *      RLS still FORCED on both tables, the ledger row, a second runner pass applying 0 files.
 *   B. Behaviour, in transactions that are ROLLED BACK: a row inserted the OLD way (no state named) reads 'accepted'; the three
 *      states are accepted, anything else is refused (23514); a quarantined row has no reviewer and a reviewer comes with an
 *      instant (23514); a token inserted the old way is not quarantining; the app role can UPDATE both tables.
 *   C. Idempotent re-run: executing the SQL file a second time changes nothing.
 *   D. A scratch database at everything before 0020, then the REAL runner: it applies exactly 0020, ONLY the intended catalog changes
 *      happen (4 columns, 2 constraints, 1 index), and a media asset from before 0020 survives as 'accepted'.
 *
 * Run (from webdesk/api):  node --import tsx ../migrations/tests/0020_media_review_state.test.mjs
 * Not run on the Windows dev box (needs the Linux gate's Postgres cluster).
 */
import { randomUUID, createHash } from 'node:crypto'
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

const TARGET = '0020_media_review_state.sql'
const { check, summary } = makeChecker('0020')
const sha = (s) => createHash('sha256').update(s).digest('hex')

// =============================================================================================
// A. Catalog state of the main database
// =============================================================================================
async function partA() {
  console.log('\n== A. catalog state (main db) ==')
  const c = await connect(MIGRATE)
  try {
    const ledger = await one(c, `SELECT count(*)::int AS n FROM schema_migrations WHERE name = $1`, [TARGET])
    check(`ledger records ${TARGET} exactly once`, ledger.n === 1, ledger)

    const col = async (table, name) =>
      one(
        c,
        `SELECT data_type, is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [table, name],
      )
    const rs = await col('media_assets', 'review_state')
    check("media_assets.review_state is NOT NULL text defaulting to 'accepted'", rs?.data_type === 'text' && rs?.is_nullable === 'NO' && /'accepted'/.test(rs?.column_default ?? ''), rs)
    const by = await col('media_assets', 'reviewed_by')
    check('media_assets.reviewed_by is nullable text', by?.data_type === 'text' && by?.is_nullable === 'YES', by)
    const at = await col('media_assets', 'reviewed_at')
    check('media_assets.reviewed_at is nullable timestamptz', at?.data_type === 'timestamp with time zone' && at?.is_nullable === 'YES', at)
    const q = await col('media_upload_tokens', 'quarantine')
    check('media_upload_tokens.quarantine is NOT NULL boolean defaulting to false', q?.data_type === 'boolean' && q?.is_nullable === 'NO' && /false/.test(q?.column_default ?? ''), q)

    const checks = await c.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'public.media_assets'::regclass AND contype = 'c' AND conname IN ('media_assets_review_state_check', 'media_assets_review_decision_check')`,
    )
    check('both review CHECKs exist on media_assets', checks.rows.length === 2, checks.rows)
    const state = checks.rows.find((r) => r.conname === 'media_assets_review_state_check')
    check("the state CHECK allows exactly accepted, quarantined and rejected", ['accepted', 'quarantined', 'rejected'].every((s) => state?.def.includes(s)), state)

    const idx = await one(c, `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ix_media_assets_quarantined'`)
    check('the review-queue partial index exists', /review_state/.test(idx?.indexdef ?? '') && /quarantined/.test(idx?.indexdef ?? ''), idx)

    for (const t of ['media_assets', 'media_upload_tokens']) {
      const rls = await one(c, `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`, [`public.${t}`])
      check(`RLS still enabled + FORCED on ${t}`, rls.relrowsecurity === true && rls.relforcerowsecurity === true, rls)
    }

    const second = runRunner(MIGRATE)
    check('a second runner pass applies 0 files', second.status === 0 && /0 applied/.test(second.stdout), second.stdout + second.stderr)
  } finally {
    await c.end()
  }
}

// =============================================================================================
// B. Behaviour (rolled back). Seeded as the migrator (the app role cannot insert a tenant).
// =============================================================================================
async function seed(m) {
  const t = randomUUID()
  await setCtx(m, { platform: true })
  await m.query(`INSERT INTO tenants (id, slug, company_ref) VALUES ($1, $2, $3)`, [t, `m0020-${t.slice(0, 8)}`, randomUUID()])
  await setCtx(m, { tenant: t })
  const site = await one(m, `INSERT INTO sites (tenant_id, kind, name) VALUES ($1, 'astro', 's') RETURNING id`, [t])
  return { t, site: site.id }
}

async function partB() {
  console.log('\n== B. behaviour (rolled back) ==')
  const m = await connect(MIGRATE)
  try {
    await m.query('BEGIN')
    const { t, site } = await seed(m)
    const key = () => `media/${randomUUID()}`

    const old = await one(m, `INSERT INTO media_assets (tenant_id, site_id, bucket_key, mime, size_bytes) VALUES ($1, $2, $3, 'image/png', 5) RETURNING review_state, reviewed_by, reviewed_at`, [t, site, key()])
    check("an asset inserted the OLD way (no state named) reads 'accepted' with no reviewer", old.review_state === 'accepted' && old.reviewed_by === null && old.reviewed_at === null, old)

    for (const good of ['accepted', 'quarantined']) {
      const r = await attempt(m, `INSERT INTO media_assets (tenant_id, site_id, bucket_key, mime, size_bytes, review_state) VALUES ($1, $2, $3, 'image/png', 5, $4) RETURNING review_state`, [t, site, key(), good])
      check(`review_state '${good}' is accepted by the CHECK`, !r.err && r.rows[0].review_state === good, errSummary(r))
    }
    const rej = await attempt(
      m,
      `INSERT INTO media_assets (tenant_id, site_id, bucket_key, mime, size_bytes, review_state, reviewed_by, reviewed_at) VALUES ($1, $2, $3, 'image/png', 5, 'rejected', 'staff-1', now()) RETURNING review_state`,
      [t, site, key()],
    )
    check("review_state 'rejected' with its reviewer and instant is accepted", !rej.err && rej.rows[0].review_state === 'rejected', errSummary(rej))

    for (const bad of ['pending', 'ACCEPTED', '', 'deleted']) {
      const r = await attempt(m, `INSERT INTO media_assets (tenant_id, site_id, bucket_key, mime, size_bytes, review_state) VALUES ($1, $2, $3, 'image/png', 5, $4)`, [t, site, key(), bad])
      check(`review_state '${bad}' is refused by the CHECK (23514)`, r.err?.code === '23514', errSummary(r))
    }
    const nul = await attempt(m, `INSERT INTO media_assets (tenant_id, site_id, bucket_key, mime, size_bytes, review_state) VALUES ($1, $2, $3, 'image/png', 5, NULL)`, [t, site, key()])
    check('review_state NULL is refused (23502)', nul.err?.code === '23502', errSummary(nul))

    const q1 = await attempt(
      m,
      `INSERT INTO media_assets (tenant_id, site_id, bucket_key, mime, size_bytes, review_state, reviewed_by, reviewed_at) VALUES ($1, $2, $3, 'image/png', 5, 'quarantined', 'staff-1', now())`,
      [t, site, key()],
    )
    check('a QUARANTINED row cannot already have a reviewer (23514)', q1.err?.code === '23514', errSummary(q1))
    const q2 = await attempt(m, `INSERT INTO media_assets (tenant_id, site_id, bucket_key, mime, size_bytes, review_state, reviewed_by) VALUES ($1, $2, $3, 'image/png', 5, 'accepted', 'staff-1')`, [t, site, key()])
    check('a reviewer without an instant is refused (23514)', q2.err?.code === '23514', errSummary(q2))
    const q3 = await attempt(m, `INSERT INTO media_assets (tenant_id, site_id, bucket_key, mime, size_bytes, review_state, reviewed_at) VALUES ($1, $2, $3, 'image/png', 5, 'accepted', now())`, [t, site, key()])
    check('an instant without a reviewer is refused (23514)', q3.err?.code === '23514', errSummary(q3))

    const tokenOld = await one(
      m,
      `INSERT INTO media_upload_tokens (tenant_id, site_id, token_hash, bucket, max_bytes, allowed_mimes, expires_at, created_by)
       VALUES ($1, $2, $3, 'media', 100, ARRAY['image/png'], now() + interval '10 minutes', 'staff-1') RETURNING quarantine`,
      [t, site, sha(randomUUID())],
    )
    check('a token inserted the OLD way is not quarantining', tokenOld.quarantine === false, tokenOld)
    const tokenQ = await one(
      m,
      `INSERT INTO media_upload_tokens (tenant_id, site_id, token_hash, bucket, max_bytes, allowed_mimes, expires_at, created_by, quarantine)
       VALUES ($1, $2, $3, 'media', 100, ARRAY['image/png'], now() + interval '10 minutes', 'contrib-1', true) RETURNING quarantine`,
      [t, site, sha(randomUUID())],
    )
    check('a token minted for a contributor carries quarantine = true', tokenQ.quarantine === true, tokenQ)
  } finally {
    await m.query('ROLLBACK').catch(() => {})
    await m.end()
  }

  const a = await connect(APP)
  try {
    const priv = await one(a, `SELECT has_table_privilege(current_user, 'media_assets', 'UPDATE') AS u, has_table_privilege(current_user, 'media_assets', 'INSERT') AS i`)
    check('the app role can INSERT and UPDATE media_assets (the upload route writes the state, the review command changes it)', priv.u === true && priv.i === true, priv)
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
// D. Scratch database before 0020 -> the real runner
// =============================================================================================
const keyed = (rows) => rows.map((s) => JSON.parse(s))

async function partD(roles) {
  console.log('\n== D. scratch database before 0020 -> the real runner ==')
  const db = 'm0020_media_review_state_pos'
  try {
    await createScratchDb(SUPER, db, roles)
    const url = withDb(MIGRATE, db)
    const applied = await applyThrough(url, TARGET)
    check(`[pos] scratch db built through every file before 0020 (${applied.length} files, none of them 0020)`, applied.length > 0 && !applied.includes(TARGET), applied)

    const t = randomUUID()
    const assetId = randomUUID()
    const m = await connect(url)
    try {
      await m.query('BEGIN')
      await setCtx(m, { platform: true })
      await m.query(`INSERT INTO tenants (id, slug, company_ref) VALUES ($1, $2, $3)`, [t, `m0020-${t.slice(0, 8)}`, randomUUID()])
      await setCtx(m, { tenant: t })
      const site = await one(m, `INSERT INTO sites (tenant_id, kind, name) VALUES ($1, 'astro', 'pre-existing') RETURNING id`, [t])
      await m.query(`INSERT INTO media_assets (id, tenant_id, site_id, bucket_key, mime, size_bytes, scan_status) VALUES ($1, $2, $3, $4, 'image/png', 9, 'clean')`, [assetId, t, site.id, `media/${randomUUID()}`])
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
    check('[pos] the real runner applies exactly 0020 (exit 0, 1 applied)', run.status === 0 && /1 applied/.test(run.stdout), run.stdout + run.stderr)
    const after = await snap()

    const c = await connect(url)
    try {
      await c.query('BEGIN')
      await setCtx(c, { tenant: t })
      const row = await one(c, `SELECT review_state, reviewed_by, reviewed_at FROM media_assets WHERE id = $1`, [assetId])
      await c.query('ROLLBACK')
      check("[pos] a media asset from before 0020 survives it as 'accepted' with no reviewer (so nothing already public becomes unserved)", row?.review_state === 'accepted' && row?.reviewed_by === null && row?.reviewed_at === null, row)
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
    const addedCols = diff.columns.added.map((r) => `${r[0]}.${r[1]}`).sort()
    check('[pos] columns: exactly the four new ones', JSON.stringify(addedCols) === JSON.stringify(['media_assets.review_state', 'media_assets.reviewed_at', 'media_assets.reviewed_by', 'media_upload_tokens.quarantine']), addedCols)
    check('[pos] constraints: exactly the two CHECKs, both on media_assets', diff.constraints.added.length === 2 && diff.constraints.added.every((r) => r[0] === 'media_assets'), diff.constraints.added)
    check('[pos] indexes: exactly the review-queue index', diff.indexes.added.length === 1, diff.indexes.added)
    for (const k of ['policies', 'grants', 'rls', 'triggers']) check(`[pos] ${k}: nothing added`, diff[k].added.length === 0, diff[k].added)
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
