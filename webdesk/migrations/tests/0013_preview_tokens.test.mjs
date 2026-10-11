#!/usr/bin/env node
/**
 * WSK-46 — migration 0013 (preview_tokens: the draft-preview bearer-token store) proven against a
 * real Postgres.
 *
 * Six parts, one exit code (same shape as 0012_content_schedules.test.mjs):
 *   A. Catalog state of the MAIN database (already migrated through 0013 by the real runner): the shape
 *      (columns, constraints, indexes, foreign keys), RLS enabled + FORCED + one policy, the app role's
 *      grants (SELECT/INSERT/UPDATE, never DELETE), and a second runner pass applying 0 files.
 *   B. Behaviour as the app role, inside one transaction that is ROLLED BACK: the unique hash, the
 *      64-lowercase-hex format CHECK (so a plaintext token can never be stored by mistake), version >= 1,
 *      the composite foreign key to content_versions (a token for a version that does not exist is
 *      refused), the expiry CHECK, NOT NULL columns, and the revoke UPDATE.
 *   C. RLS isolation between two tenants, with a positive control: a tenant sees only its own rows,
 *      cannot insert or update another tenant's, and an unset context sees nothing (fail-closed).
 *   D. The privileges exercised for real: DELETE and TRUNCATE are refused with 42501, UPDATE works.
 *   E. Idempotent re-run: the real runner applies 0 files a second time, and executing the SQL file
 *      again as the migrator changes nothing (before/after catalog snapshots are identical).
 *   F. A scratch database at 0012, then the REAL runner: it applies exactly 0013 and ONLY the intended
 *      catalog changes happen (exact before/after diff).
 *
 * Env (all point at the same cluster):
 *   SUPERUSER_DATABASE_URL  cluster bootstrap identity on the main db (creates/drops scratch dbs)
 *   MIGRATE_DATABASE_URL    webdesk_migrator on the main db
 *   APP_DATABASE_URL        webdesk_app on the main db
 *
 * Run (from webdesk/api, for the same reason as the 0009-0012 files):
 *   node --import tsx ../migrations/tests/0013_preview_tokens.test.mjs
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
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

const TARGET = '0013_preview_tokens.sql'
const TABLE = 'preview_tokens'
const PREV = '0012_content_schedules.sql'

const { check, summary } = makeChecker('0013')

/** What the api stores for a token: sha256 hex. Random per call so no two rows collide by accident. */
const newHash = () => createHash('sha256').update(randomBytes(32).toString('base64url')).digest('hex')

// A tenant, site, collection, item and version 1 + 2 of it, as the app role, in the caller's open transaction.
async function seedItem(c, tenantId, label) {
  await setCtx(c, { platform: true })
  await c.query(`INSERT INTO tenants (id, slug, company_ref) VALUES ($1, $2, $3)`, [tenantId, `wsk46-${label}-${tenantId.slice(0, 8)}`, randomUUID()])
  await setCtx(c, { tenant: tenantId })
  const site = (await one(c, `INSERT INTO sites (tenant_id, kind, name) VALUES ($1, 'astro', $2) RETURNING id`, [tenantId, label])).id
  const col = (await one(c, `INSERT INTO collections (tenant_id, site_id, key) VALUES ($1, $2, 'page') RETURNING id`, [tenantId, site])).id
  const item = (
    await one(
      c,
      `INSERT INTO content_items (tenant_id, site_id, collection_id, locale, slug, localization_group_id, publish_state)
       VALUES ($1, $2, $3, 'en', 'home', gen_random_uuid(), 'draft') RETURNING id`,
      [tenantId, site, col],
    )
  ).id
  for (const v of [1, 2]) {
    await c.query(
      `INSERT INTO content_versions (tenant_id, content_item_id, version, blocks, seo, publish_state, created_by)
       VALUES ($1, $2, $3, '[]'::jsonb, '{}'::jsonb, 'draft', 'user-1')`,
      [tenantId, item, v],
    )
  }
  return { tenantId, site, item }
}

const insertToken = (c, s, over = {}) =>
  attempt(
    c,
    `INSERT INTO preview_tokens (tenant_id, site_id, content_item_id, version, token_hash, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, ${over.expiresSql ?? `now() + interval '1 hour'`}, $6) RETURNING id`,
    [s.tenantId, over.site ?? s.site, over.item ?? s.item, over.version ?? 2, over.hash ?? newHash(), over.createdBy ?? 'user-1'],
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
      'the 10 columns, in order',
      cols.rows.map((r) => r.column_name).join() === 'id,tenant_id,site_id,content_item_id,version,token_hash,expires_at,created_by,created_at,revoked_at',
      cols.rows.map((r) => r.column_name),
    )
    const notNull = ['id', 'tenant_id', 'site_id', 'content_item_id', 'version', 'token_hash', 'expires_at', 'created_by', 'created_at']
    check('NOT NULL on every column but revoked_at', notNull.every((n) => col[n]?.is_nullable === 'NO') && col.revoked_at?.is_nullable === 'YES', cols.rows.map((r) => [r.column_name, r.is_nullable]))
    check(
      'types: uuid ids, integer version, timestamptz instants, text the rest',
      ['id', 'tenant_id', 'site_id', 'content_item_id'].every((n) => col[n].data_type === 'uuid') &&
        col.version.data_type === 'integer' &&
        ['expires_at', 'created_at', 'revoked_at'].every((n) => col[n].data_type === 'timestamp with time zone') &&
        ['token_hash', 'created_by'].every((n) => col[n].data_type === 'text'),
      cols.rows,
    )
    check('defaults: id gen_random_uuid(), created_at now(); expires_at has NO default (a token must name its expiry)', /gen_random_uuid/.test(col.id.column_default ?? '') && /now\(\)/.test(col.created_at.column_default ?? '') && col.expires_at.column_default === null, [col.id.column_default, col.created_at.column_default, col.expires_at.column_default])

    const cons = await c.query(
      `SELECT conname, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.preview_tokens'::regclass ORDER BY conname`,
    )
    const cn = Object.fromEntries(cons.rows.map((r) => [r.conname, r.def]))
    for (const r of cons.rows) console.log(`        ${r.conname}: ${r.def}`)
    check('primary key on id', cons.rows.some((r) => r.contype === 'p' && /PRIMARY KEY \(id\)/.test(r.def)), cons.rows)
    const fks = cons.rows.filter((r) => r.contype === 'f').map((r) => r.def).sort()
    check(
      'foreign keys: tenants(id), sites(id), content_items(id), and (content_item_id, version) -> content_versions',
      fks.length === 4 &&
        fks.some((d) => /\(tenant_id\) REFERENCES tenants\(id\)/.test(d)) &&
        fks.some((d) => /\(site_id\) REFERENCES sites\(id\)/.test(d)) &&
        fks.some((d) => /\(content_item_id\) REFERENCES content_items\(id\)/.test(d)) &&
        /FOREIGN KEY \(content_item_id, version\) REFERENCES content_versions\(content_item_id, version\)/.test(cn.preview_tokens_version_fk ?? ''),
      fks,
    )
    check('CHECK version >= 1', cons.rows.some((r) => r.contype === 'c' && /version >= 1/.test(r.def)), cn)
    check('CHECK preview_tokens_token_hash_check: ^[0-9a-f]{64}$', /token_hash ~ '\^\[0-9a-f\]\{64\}\$'/.test(cn.preview_tokens_token_hash_check ?? ''), cn.preview_tokens_token_hash_check)
    check('CHECK preview_tokens_expiry_check: expires_at > created_at', /expires_at > created_at/.test(cn.preview_tokens_expiry_check ?? ''), cn.preview_tokens_expiry_check)

    const idx = await c.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 ORDER BY indexname`, [TABLE])
    const ix = Object.fromEntries(idx.rows.map((r) => [r.indexname, r.indexdef]))
    for (const r of idx.rows) console.log(`        ${r.indexdef}`)
    check('ux_preview_tokens_hash: UNIQUE (token_hash), the whole table (no partial predicate)', /UNIQUE INDEX .* \(token_hash\)/.test(ix.ux_preview_tokens_hash ?? '') && !/ WHERE /.test(ix.ux_preview_tokens_hash ?? ''), ix.ux_preview_tokens_hash)
    check('ix_preview_tokens_expires: (expires_at) over un-revoked rows only', /\(expires_at\)/.test(ix.ix_preview_tokens_expires ?? '') && /WHERE \(revoked_at IS NULL\)/.test(ix.ix_preview_tokens_expires ?? '') && !/UNIQUE/.test(ix.ix_preview_tokens_expires ?? ''), ix.ix_preview_tokens_expires)
    check('ix_preview_tokens_tenant and ix_preview_tokens_item exist', !!ix.ix_preview_tokens_tenant && !!ix.ix_preview_tokens_item, Object.keys(ix))

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
    for (const p of privs) app[p] = (await one(c, `SELECT has_table_privilege($1, 'preview_tokens', $2) AS ok`, [roles.app, p])).ok
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

    const hash = newHash()
    let r = await insertToken(c, s, { hash })
    const first = r.rows?.[0]?.id
    check('a token row inserts (hash only; there is no plaintext column to fill)', !r.err && !!first, errSummary(r))

    r = await insertToken(c, s, { hash })
    check('THE UNIQUE HASH: the same hash twice is refused, naming ux_preview_tokens_hash', r.err?.code === '23505' && r.err.constraint === 'ux_preview_tokens_hash', errSummary(r))
    r = await insertToken(c, s, { version: 1 })
    check('control: two tokens (different hashes) for one item are fine, and for a different version', !r.err, errSummary(r))

    // The hash format: a plaintext token (base64url, 43 chars) or any non-hex value must not be storable.
    const plaintext = randomBytes(32).toString('base64url')
    for (const [what, bad] of [
      ['a 43-char base64url plaintext token', plaintext],
      ['uppercase hex', newHash().toUpperCase()],
      ['63 hex chars', newHash().slice(1)],
      ['65 hex chars', newHash() + '0'],
      ['the empty string', ''],
    ]) {
      r = await insertToken(c, s, { hash: bad })
      check(`${what} is refused (preview_tokens_token_hash_check)`, r.err?.code === '23514' && r.err.constraint === 'preview_tokens_token_hash_check', errSummary(r))
    }

    r = await insertToken(c, s, { version: 0 })
    check('version 0 is refused (version >= 1; a pre-0009 item has no version to preview)', r.err?.code === '23514', errSummary(r))
    r = await insertToken(c, s, { version: 3 })
    check('a version that has no content_versions row is refused by the composite foreign key (preview_tokens_version_fk)', r.err?.code === '23503' && r.err.constraint === 'preview_tokens_version_fk', errSummary(r))
    r = await insertToken(c, s, { item: randomUUID() })
    check('an unknown content_item_id is refused by its foreign key', r.err?.code === '23503', errSummary(r))
    r = await insertToken(c, s, { site: randomUUID() })
    check('an unknown site_id is refused by its foreign key', r.err?.code === '23503', errSummary(r))

    r = await insertToken(c, s, { expiresSql: `now() - interval '1 minute'` })
    check('an expires_at in the past is refused (preview_tokens_expiry_check)', r.err?.code === '23514' && r.err.constraint === 'preview_tokens_expiry_check', errSummary(r))
    r = await insertToken(c, s, { expiresSql: `now()` })
    check('expires_at = created_at is refused too', r.err?.code === '23514' && r.err.constraint === 'preview_tokens_expiry_check', errSummary(r))
    r = await insertToken(c, s, { expiresSql: `now() + interval '1 second'` })
    check('control: expires_at after created_at is accepted', !r.err, errSummary(r))
    r = await insertToken(c, s, { expiresSql: `NULL` })
    check('expires_at NULL is refused (a token cannot be immortal)', r.err?.code === '23502', errSummary(r))
    r = await attempt(c, `INSERT INTO preview_tokens (tenant_id, site_id, content_item_id, version, token_hash, expires_at, created_by) VALUES ($1,$2,$3,2,$4, now() + interval '1 hour', NULL)`, [s.tenantId, s.site, s.item, newHash()])
    check('created_by NULL is refused', r.err?.code === '23502', errSummary(r))

    // Revocation: one UPDATE of revoked_at.
    r = await attempt(c, `UPDATE preview_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [first])
    check('POSITIVE CONTROL: the revoke UPDATE hits exactly the row', !r.err && r.rowCount === 1, errSummary(r))
    r = await attempt(c, `UPDATE preview_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [first])
    check('a second revoke matches 0 rows (the command is idempotent on top of this)', !r.err && r.rowCount === 0, errSummary(r))
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    await c.end()
  }
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
    let r = await insertToken(c, A)
    const aRow = r.rows[0].id
    const B = await seedItem(c, randomUUID(), 'rls-b')
    r = await insertToken(c, B)
    const bRow = r.rows[0].id

    await setCtx(c, { tenant: A.tenantId })
    const seenByA = (await c.query(`SELECT id FROM preview_tokens WHERE id = ANY($1)`, [[aRow, bRow]])).rows.map((x) => x.id)
    check('POSITIVE CONTROL: tenant A sees its own row', seenByA.includes(aRow), seenByA)
    check("tenant A does NOT see tenant B's row", !seenByA.includes(bRow), seenByA)
    check('tenant A sees exactly one row of the two', seenByA.length === 1, seenByA)

    r = await insertToken(c, B)
    check('tenant A cannot INSERT a row for tenant B (WITH CHECK, 42501)', r.err?.code === '42501', errSummary(r))
    r = await attempt(c, `UPDATE preview_tokens SET revoked_at = now() WHERE id = $1`, [bRow])
    check("tenant A's UPDATE of tenant B's row matches 0 rows", !r.err && r.rowCount === 0, errSummary(r))
    r = await attempt(c, `UPDATE preview_tokens SET tenant_id = $2 WHERE id = $1`, [aRow, B.tenantId])
    check('tenant A cannot hand its own row to tenant B (WITH CHECK, 42501)', r.err?.code === '42501', errSummary(r))

    await setCtx(c, { tenant: B.tenantId })
    const seenByB = (await c.query(`SELECT id FROM preview_tokens WHERE id = ANY($1)`, [[aRow, bRow]])).rows.map((x) => x.id)
    check("POSITIVE CONTROL: tenant B sees its own row and not A's", seenByB.length === 1 && seenByB[0] === bRow, seenByB)
    const bStill = await one(c, `SELECT revoked_at FROM preview_tokens WHERE id = $1`, [bRow])
    check("tenant B's row was not touched by A's attempts", bStill.revoked_at === null, bStill)

    await setCtx(c, {})
    const unset = await one(c, `SELECT count(*)::int AS n FROM preview_tokens WHERE id = ANY($1)`, [[aRow, bRow]])
    check('an UNSET tenant context sees ZERO rows (fail-closed, no error)', unset.n === 0, unset)
    await setCtx(c, { platform: true })
    const platform = await one(c, `SELECT count(*)::int AS n FROM preview_tokens WHERE id = ANY($1)`, [[aRow, bRow]])
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
    const r0 = await insertToken(c, s)
    check('setup: a row exists', !r0.err, errSummary(r0))
    let r = await attempt(c, `DELETE FROM preview_tokens WHERE tenant_id = $1`, [s.tenantId])
    check('DELETE -> 42501 permission denied', r.err?.code === '42501', errSummary(r))
    r = await attempt(c, `TRUNCATE preview_tokens`)
    check('TRUNCATE -> 42501 permission denied', r.err?.code === '42501', errSummary(r))
    r = await attempt(c, `UPDATE preview_tokens SET revoked_at = now() WHERE id = $1`, [r0.rows[0].id])
    check('POSITIVE CONTROL: UPDATE (the revoke transition) is allowed', !r.err && r.rowCount === 1, errSummary(r))
    r = await attempt(c, `SELECT count(*) FROM preview_tokens`)
    check('POSITIVE CONTROL: SELECT is allowed', !r.err, errSummary(r))
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    await c.end()
  }
  const m = await connect(MIGRATE)
  try {
    const mig = (await one(m, `SELECT has_table_privilege($1, 'preview_tokens', 'DELETE') AS ok`, [roles.migrator])).ok
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
// F. Scratch database at 0012 -> the real runner
// =============================================================================================
const keyed = (rows) => rows.map((s) => JSON.parse(s))

async function partF(roles) {
  console.log('\n== F. scratch database at 0012 -> the real runner ==')
  const db = 'wsk_46_pos'
  try {
    await createScratchDb(SUPER, db, roles)
    const url = withDb(MIGRATE, db)
    const applied = await applyThrough(url, TARGET)
    check(`[pos] scratch db built through ${PREV} (${applied.length} files, none of them 0013)`, applied.includes(PREV) && !applied.includes(TARGET), applied)
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
    check('[pos] the real runner applies exactly 0013 (exit 0, 1 applied)', run.status === 0 && /1 applied/.test(run.stdout), run.stdout + run.stderr)
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
    check('[pos] columns: 10 added, all on preview_tokens', diff.columns.added.length === 10 && diff.columns.added.every((r) => r[0] === TABLE), diff.columns.added.length)
    check('[pos] constraints: only preview_tokens constraints added', diff.constraints.added.length > 0 && diff.constraints.added.every((r) => r[0] === TABLE), diff.constraints.added)
    check('[pos] indexes: exactly the pk + 4 new, all on preview_tokens', diff.indexes.added.length === 5 && diff.indexes.added.every((r) => r[0] === TABLE), diff.indexes.added)
    check('[pos] policies: exactly tenant_isolation on preview_tokens', diff.policies.added.length === 1 && diff.policies.added[0][0] === TABLE && diff.policies.added[0][1] === 'tenant_isolation', diff.policies.added)
    check('[pos] triggers: none added', diff.triggers.added.length === 0, diff.triggers.added)
    const appGrants = diff.grants.added.filter((g) => g[1] === roles.app).map((g) => g[2]).sort()
    check(`[pos] grants: ${roles.app} gains exactly SELECT, INSERT, UPDATE, and only on preview_tokens`, diff.grants.added.every((g) => g[0] === TABLE) && appGrants.join() === 'INSERT,SELECT,UPDATE', diff.grants.added)
    const rlsRow = diff.rls.added.find((r) => r[0] === TABLE)
    check('[pos] rls: preview_tokens arrives enabled + forced', diff.rls.added.length === 1 && rlsRow?.[1] === true && rlsRow?.[2] === true, diff.rls.added)
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
