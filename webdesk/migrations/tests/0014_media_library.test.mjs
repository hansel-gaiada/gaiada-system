#!/usr/bin/env node
/**
 * WSK-43a — migration 0014 (the media library: media_assets metadata + lifecycle, and media_upload_tokens,
 * the single-use credential of the public upload route) proven against a real Postgres.
 *
 * Six parts, one exit code (same shape as 0013_preview_tokens.test.mjs):
 *   A. Catalog state of the MAIN database (already migrated through 0014 by the real runner): the new
 *      media_assets columns and CHECKs, the two new indexes, the media_upload_tokens shape, RLS enabled +
 *      FORCED + one policy, the app role's grants (SELECT/INSERT/UPDATE, never DELETE, on the token table)
 *      and a second runner pass applying 0 files.
 *   B. Behaviour as the app role, inside one transaction that is ROLLED BACK: the defaults of an old-style
 *      insert, the alt-is-an-object / tags / dimensions / lifecycle CHECKs (each with a positive control),
 *      and the token table's hash format, bucket, cap, mime-set and expiry CHECKs, the unique hash, and the
 *      single-use claim UPDATE (the second claim matches 0 rows).
 *   C. RLS isolation between two tenants on media_upload_tokens, with a positive control, and fail-closed
 *      on an unset context; media_assets' own isolation is unchanged.
 *   D. The privileges exercised for real: DELETE and TRUNCATE refused on the token table (42501), UPDATE
 *      works; the app role still may DELETE a media_assets row (privacy erase relies on it).
 *   E. Idempotent re-run: the real runner applies 0 files a second time, and executing the SQL file again
 *      as the migrator changes nothing (before/after catalog snapshots are identical).
 *   F. A scratch database at 0013, then the REAL runner: it applies exactly 0014 and ONLY the intended
 *      catalog changes happen (exact before/after diff).
 *
 * Env (all point at the same cluster):
 *   SUPERUSER_DATABASE_URL  cluster bootstrap identity on the main db (creates/drops scratch dbs)
 *   MIGRATE_DATABASE_URL    webdesk_migrator on the main db
 *   APP_DATABASE_URL        webdesk_app on the main db
 *
 * Run (from webdesk/api, for the same reason as the 0009-0013 files):
 *   node --import tsx ../migrations/tests/0014_media_library.test.mjs
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

const TARGET = '0014_media_library.sql'
const TOKENS = 'media_upload_tokens'
const ASSETS = 'media_assets'
const PREV = '0013_preview_tokens.sql'

const { check, summary } = makeChecker('0014')

const newHash = () => createHash('sha256').update(randomBytes(32).toString('base64url')).digest('hex')

const NEW_ASSET_COLUMNS = ['title', 'alt', 'tags', 'original_filename', 'created_by', 'width', 'height', 'updated_at', 'deleted_at', 'purge_after', 'purged_at']
const TOKEN_COLUMNS = 'id,tenant_id,site_id,token_hash,bucket,max_bytes,allowed_mimes,expires_at,created_by,created_at,used_at'

// A tenant and a site, as the app role, in the caller's open transaction.
async function seedSite(c, tenantId, label) {
  await setCtx(c, { platform: true })
  await c.query(`INSERT INTO tenants (id, slug, company_ref) VALUES ($1, $2, $3)`, [tenantId, `wsk43-${label}-${tenantId.slice(0, 8)}`, randomUUID()])
  await setCtx(c, { tenant: tenantId })
  const site = (await one(c, `INSERT INTO sites (tenant_id, kind, name) VALUES ($1, 'astro', $2) RETURNING id`, [tenantId, label])).id
  return { tenantId, site }
}

const insertAsset = (c, s, over = {}) =>
  attempt(
    c,
    `INSERT INTO media_assets (tenant_id, site_id, bucket_key, mime, size_bytes, scan_status, alt, tags, width, height, deleted_at, purge_after, purged_at)
     VALUES ($1, $2, $3, 'image/png', 10, 'clean', ${over.altSql ?? `'{}'::jsonb`}, ${over.tagsSql ?? `'{}'::text[]`}, ${over.width ?? 'NULL'}, ${over.height ?? 'NULL'},
             ${over.deletedSql ?? 'NULL'}, ${over.purgeAfterSql ?? 'NULL'}, ${over.purgedSql ?? 'NULL'}) RETURNING id`,
    [s.tenantId, s.site, `media/t/${s.tenantId}/${randomUUID()}-x.png`],
  )

const insertToken = (c, s, over = {}) =>
  attempt(
    c,
    `INSERT INTO media_upload_tokens (tenant_id, site_id, token_hash, bucket, max_bytes, allowed_mimes, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, ${over.mimesSql ?? `ARRAY['image/png']`}, ${over.expiresSql ?? `now() + interval '10 minutes'`}, $6) RETURNING id`,
    [s.tenantId, over.site ?? s.site, over.hash ?? newHash(), over.bucket ?? 'media', over.maxBytes ?? 1000, over.createdBy ?? 'user-1'],
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

    // ---- media_assets
    const acols = await c.query(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [ASSETS],
    )
    const a = Object.fromEntries(acols.rows.map((r) => [r.column_name, r]))
    check('media_assets keeps its 8 original columns and gains the 11 library columns', acols.rows.length === 19 && NEW_ASSET_COLUMNS.every((n) => a[n]), acols.rows.map((r) => r.column_name))
    check(
      'types: title/original_filename/created_by text, alt jsonb, tags text[], width/height integer, instants timestamptz',
      a.title.data_type === 'text' &&
        a.original_filename.data_type === 'text' &&
        a.created_by.data_type === 'text' &&
        a.alt.data_type === 'jsonb' &&
        a.tags.data_type === 'ARRAY' &&
        a.width.data_type === 'integer' &&
        a.height.data_type === 'integer' &&
        ['updated_at', 'deleted_at', 'purge_after', 'purged_at'].every((n) => a[n].data_type === 'timestamp with time zone'),
      acols.rows,
    )
    check(
      'NOT NULL: alt, tags, updated_at; nullable: title, original_filename, created_by, width, height, deleted_at, purge_after, purged_at',
      ['alt', 'tags', 'updated_at'].every((n) => a[n].is_nullable === 'NO') &&
        ['title', 'original_filename', 'created_by', 'width', 'height', 'deleted_at', 'purge_after', 'purged_at'].every((n) => a[n].is_nullable === 'YES'),
      acols.rows,
    )
    check("defaults: alt '{}', tags '{}', updated_at now()", /'\{\}'::jsonb/.test(a.alt.column_default ?? '') && /'\{\}'::text\[\]/.test(a.tags.column_default ?? '') && /now\(\)/.test(a.updated_at.column_default ?? ''), [a.alt.column_default, a.tags.column_default, a.updated_at.column_default])

    const acons = await c.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.media_assets'::regclass AND contype = 'c' ORDER BY conname`)
    const ac = Object.fromEntries(acons.rows.map((r) => [r.conname, r.def]))
    for (const r of acons.rows) console.log(`        ${r.conname}: ${r.def}`)
    check('CHECK alt is a JSON object', /jsonb_typeof\(alt\) = 'object'/.test(ac.media_assets_alt_object_check ?? ''), ac)
    check('CHECK purge_after IS NULL iff deleted_at IS NULL', /\(deleted_at IS NULL\) = \(purge_after IS NULL\)/.test(ac.media_assets_purge_after_iff_deleted_check ?? ''), ac)
    check('CHECK purge_after >= deleted_at', /purge_after >= deleted_at/.test(ac.media_assets_purge_after_order_check ?? ''), ac)
    check('CHECK purged_at implies deleted_at', /purged_at IS NULL\) OR \(deleted_at IS NOT NULL\)/.test(ac.media_assets_purged_requires_deleted_check ?? ''), ac)
    check('CHECKs on title length, tags count, filename length, dimensions', !!ac.media_assets_title_check && !!ac.media_assets_tags_check && !!ac.media_assets_original_filename_check && !!ac.media_assets_dimensions_check, Object.keys(ac))

    const aidx = await c.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`, [ASSETS])
    const ai = Object.fromEntries(aidx.rows.map((r) => [r.indexname, r.indexdef]))
    check('ix_media_assets_tags is a GIN index on tags', /USING gin \(tags\)/.test(ai.ix_media_assets_tags ?? ''), ai.ix_media_assets_tags)
    check(
      'ix_media_assets_purge_due: (purge_after) over soft-deleted, un-purged rows only',
      /\(purge_after\)/.test(ai.ix_media_assets_purge_due ?? '') && /deleted_at IS NOT NULL/.test(ai.ix_media_assets_purge_due ?? '') && /purged_at IS NULL/.test(ai.ix_media_assets_purge_due ?? ''),
      ai.ix_media_assets_purge_due,
    )

    // ---- media_upload_tokens
    const cols = await c.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [TOKENS])
    const col = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]))
    check('media_upload_tokens: the 11 columns, in order', cols.rows.map((r) => r.column_name).join() === TOKEN_COLUMNS, cols.rows.map((r) => r.column_name))
    check('NOT NULL on every column but used_at', cols.rows.every((r) => (r.column_name === 'used_at' ? r.is_nullable === 'YES' : r.is_nullable === 'NO')), cols.rows.map((r) => [r.column_name, r.is_nullable]))
    check(
      'types: uuid ids, bigint max_bytes, text[] allowed_mimes, timestamptz instants, text the rest',
      ['id', 'tenant_id', 'site_id'].every((n) => col[n].data_type === 'uuid') &&
        col.max_bytes.data_type === 'bigint' &&
        col.allowed_mimes.data_type === 'ARRAY' &&
        ['expires_at', 'created_at', 'used_at'].every((n) => col[n].data_type === 'timestamp with time zone') &&
        ['token_hash', 'bucket', 'created_by'].every((n) => col[n].data_type === 'text'),
      cols.rows,
    )
    check('expires_at has NO default (a token must name its expiry)', col.expires_at.column_default === null, col.expires_at.column_default)

    const cons = await c.query(`SELECT conname, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.media_upload_tokens'::regclass ORDER BY conname`)
    const cn = Object.fromEntries(cons.rows.map((r) => [r.conname, r.def]))
    for (const r of cons.rows) console.log(`        ${r.conname}: ${r.def}`)
    check('primary key on id', cons.rows.some((r) => r.contype === 'p' && /PRIMARY KEY \(id\)/.test(r.def)), cons.rows)
    const fks = cons.rows.filter((r) => r.contype === 'f').map((r) => r.def).sort()
    check('foreign keys: exactly tenants(id) and sites(id)', fks.length === 2 && fks.some((d) => /\(tenant_id\) REFERENCES tenants\(id\)/.test(d)) && fks.some((d) => /\(site_id\) REFERENCES sites\(id\)/.test(d)), fks)
    check('CHECK token_hash ~ ^[0-9a-f]{64}$', /token_hash ~ '\^\[0-9a-f\]\{64\}\$'/.test(cn.media_upload_tokens_token_hash_check ?? ''), cn.media_upload_tokens_token_hash_check)
    check("CHECK bucket IN ('media', 'video')", /'media'/.test(cn.media_upload_tokens_bucket_check ?? '') && /'video'/.test(cn.media_upload_tokens_bucket_check ?? '') && !/uploads|artifacts/.test(cn.media_upload_tokens_bucket_check ?? ''), cn.media_upload_tokens_bucket_check)
    check('CHECK max_bytes > 0, cardinality(allowed_mimes) >= 1, expires_at > created_at', /max_bytes > 0/.test(cn.media_upload_tokens_max_bytes_check ?? '') && /cardinality\(allowed_mimes\) >= 1/.test(cn.media_upload_tokens_allowed_mimes_check ?? '') && /expires_at > created_at/.test(cn.media_upload_tokens_expiry_check ?? ''), cn)

    const idx = await c.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 ORDER BY indexname`, [TOKENS])
    const ix = Object.fromEntries(idx.rows.map((r) => [r.indexname, r.indexdef]))
    check('ux_media_upload_tokens_hash: UNIQUE (token_hash), the whole table', /UNIQUE INDEX .* \(token_hash\)/.test(ix.ux_media_upload_tokens_hash ?? '') && !/ WHERE /.test(ix.ux_media_upload_tokens_hash ?? ''), ix.ux_media_upload_tokens_hash)
    check('ix_media_upload_tokens_expires: (expires_at) over unspent rows only', /\(expires_at\)/.test(ix.ix_media_upload_tokens_expires ?? '') && /WHERE \(used_at IS NULL\)/.test(ix.ix_media_upload_tokens_expires ?? ''), ix.ix_media_upload_tokens_expires)
    check('ix_media_upload_tokens_tenant and _site exist', !!ix.ix_media_upload_tokens_tenant && !!ix.ix_media_upload_tokens_site, Object.keys(ix))

    const rls = await one(
      c,
      `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c WHERE c.relname = $1 AND c.relnamespace = 'public'::regnamespace`,
      [TOKENS],
    )
    check('RLS enabled + FORCED + exactly 1 policy (the check-rls-integrity.mjs triple)', rls.enabled === true && rls.forced === true && rls.policies === 1, rls)
    check(`owned by the migrating role ${roles.migrator}`, rls.owner === roles.migrator, rls)
    const pol = await one(c, `SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`, [TOKENS])
    check('policy tenant_isolation FOR ALL on tenant_id = webdesk_tenant_ctx(), USING and WITH CHECK', pol.policyname === 'tenant_isolation' && pol.cmd === 'ALL' && /tenant_id = webdesk_tenant_ctx\(\)/.test(pol.qual) && /tenant_id = webdesk_tenant_ctx\(\)/.test(pol.with_check), pol)

    const app = {}
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) app[p] = (await one(c, `SELECT has_table_privilege($1, 'media_upload_tokens', $2) AS ok`, [roles.app, p])).ok
    console.log(`        ${roles.app} on ${TOKENS}: ${JSON.stringify(app)}`)
    check(`${roles.app} holds SELECT, INSERT, UPDATE on the token table`, app.SELECT && app.INSERT && app.UPDATE, app)
    check(`${roles.app} has NO DELETE, TRUNCATE, REFERENCES or TRIGGER on the token table`, !app.DELETE && !app.TRUNCATE && !app.REFERENCES && !app.TRIGGER, app)

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
    const s = await seedSite(c, randomUUID(), 'b')

    // ---- media_assets
    let r = await attempt(c, `INSERT INTO media_assets (tenant_id, site_id, bucket_key, mime, size_bytes) VALUES ($1, $2, $3, 'image/png', 5) RETURNING *`, [s.tenantId, s.site, `media/${randomUUID()}`])
    const old = r.rows?.[0]
    check(
      'an OLD-STYLE insert (the 0002 columns only, what legacy code writes) still works and takes the defaults',
      !r.err && old.title === null && JSON.stringify(old.alt) === '{}' && old.tags.length === 0 && old.original_filename === null && old.created_by === null && old.width === null && old.deleted_at === null && old.purge_after === null && old.purged_at === null && old.updated_at instanceof Date,
      errSummary(r) + JSON.stringify(old),
    )

    r = await insertAsset(c, s, { altSql: `'{"en":"A cat","id":"Kucing"}'::jsonb`, tagsSql: `ARRAY['hero','cats']`, width: 640, height: 480 })
    check('POSITIVE CONTROL: a library row with a per-locale alt, tags and dimensions inserts', !r.err, errSummary(r))
    for (const [what, sql] of [['an array', `'[]'::jsonb`], ['a string', `'"x"'::jsonb`], ['null json', `'null'::jsonb`]]) {
      r = await insertAsset(c, s, { altSql: sql })
      check(`alt as ${what} is refused (media_assets_alt_object_check)`, r.err?.code === '23514' && r.err.constraint === 'media_assets_alt_object_check', errSummary(r))
    }
    r = await attempt(c, `INSERT INTO media_assets (tenant_id, site_id, bucket_key, mime, size_bytes, alt) VALUES ($1,$2,$3,'image/png',1,NULL)`, [s.tenantId, s.site, `media/${randomUUID()}`])
    check('alt NULL is refused (NOT NULL)', r.err?.code === '23502', errSummary(r))
    r = await insertAsset(c, s, { tagsSql: `ARRAY(SELECT 'tag' || g FROM generate_series(1, 21) g)` })
    check('21 tags are refused (media_assets_tags_check); 20 are fine', r.err?.code === '23514' && r.err.constraint === 'media_assets_tags_check', errSummary(r))
    r = await insertAsset(c, s, { tagsSql: `ARRAY(SELECT 'tag' || g FROM generate_series(1, 20) g)` })
    check('control: 20 tags are accepted', !r.err, errSummary(r))
    r = await insertAsset(c, s, { width: 0 })
    check('width 0 is refused (media_assets_dimensions_check)', r.err?.code === '23514' && r.err.constraint === 'media_assets_dimensions_check', errSummary(r))
    r = await insertAsset(c, s, { height: -4 })
    check('height -4 is refused', r.err?.code === '23514' && r.err.constraint === 'media_assets_dimensions_check', errSummary(r))
    r = await attempt(c, `INSERT INTO media_assets (tenant_id, site_id, bucket_key, mime, size_bytes, title) VALUES ($1,$2,$3,'image/png',1, repeat('x', 201))`, [s.tenantId, s.site, `media/${randomUUID()}`])
    check('a 201-character title is refused (media_assets_title_check)', r.err?.code === '23514' && r.err.constraint === 'media_assets_title_check', errSummary(r))
    r = await attempt(c, `INSERT INTO media_assets (tenant_id, site_id, bucket_key, mime, size_bytes, original_filename) VALUES ($1,$2,$3,'image/png',1, repeat('x', 256))`, [s.tenantId, s.site, `media/${randomUUID()}`])
    check('a 256-character filename is refused (media_assets_original_filename_check)', r.err?.code === '23514' && r.err.constraint === 'media_assets_original_filename_check', errSummary(r))

    // lifecycle
    r = await insertAsset(c, s, { deletedSql: 'now()', purgeAfterSql: `now() + interval '1 day'` })
    check('POSITIVE CONTROL: a soft-deleted row (deleted_at + purge_after) inserts', !r.err, errSummary(r))
    r = await insertAsset(c, s, { deletedSql: 'now()' })
    check('deleted_at WITHOUT purge_after is refused (media_assets_purge_after_iff_deleted_check)', r.err?.code === '23514' && r.err.constraint === 'media_assets_purge_after_iff_deleted_check', errSummary(r))
    r = await insertAsset(c, s, { purgeAfterSql: `now() + interval '1 day'` })
    check('purge_after WITHOUT deleted_at is refused', r.err?.code === '23514' && r.err.constraint === 'media_assets_purge_after_iff_deleted_check', errSummary(r))
    r = await insertAsset(c, s, { deletedSql: 'now()', purgeAfterSql: `now() - interval '1 day'` })
    check('purge_after BEFORE deleted_at is refused (media_assets_purge_after_order_check)', r.err?.code === '23514' && r.err.constraint === 'media_assets_purge_after_order_check', errSummary(r))
    r = await insertAsset(c, s, { purgedSql: 'now()' })
    check('purged_at on a row that was never deleted is refused (media_assets_purged_requires_deleted_check)', r.err?.code === '23514', errSummary(r))
    r = await insertAsset(c, s, { deletedSql: 'now()', purgeAfterSql: 'now()', purgedSql: 'now()' })
    check('control: a deleted row may carry purged_at', !r.err, errSummary(r))

    // the soft-delete transition as an UPDATE, the way media.delete does it
    r = await attempt(c, `UPDATE media_assets SET deleted_at = now(), purge_after = now() + interval '1 day', updated_at = now() WHERE id = $1`, [old.id])
    check('the soft-delete UPDATE (deleted_at + purge_after together) works', !r.err && r.rowCount === 1, errSummary(r))
    r = await attempt(c, `UPDATE media_assets SET purge_after = NULL WHERE id = $1`, [old.id])
    check('un-setting purge_after on a deleted row is refused', r.err?.code === '23514', errSummary(r))

    // ---- media_upload_tokens
    const hash = newHash()
    r = await insertToken(c, s, { hash })
    const first = r.rows?.[0]?.id
    check('a token row inserts (hash only; there is no plaintext column)', !r.err && !!first, errSummary(r))
    r = await insertToken(c, s, { hash })
    check('THE UNIQUE HASH: the same hash twice is refused, naming ux_media_upload_tokens_hash', r.err?.code === '23505' && r.err.constraint === 'ux_media_upload_tokens_hash', errSummary(r))
    r = await insertToken(c, s)
    check('control: a second token (new hash) is fine', !r.err, errSummary(r))

    const plaintext = randomBytes(32).toString('base64url')
    for (const [what, bad] of [
      ['a 43-char base64url plaintext token', plaintext],
      ['uppercase hex', newHash().toUpperCase()],
      ['63 hex chars', newHash().slice(1)],
      ['the empty string', ''],
    ]) {
      r = await insertToken(c, s, { hash: bad })
      check(`${what} is refused (media_upload_tokens_token_hash_check)`, r.err?.code === '23514' && r.err.constraint === 'media_upload_tokens_token_hash_check', errSummary(r))
    }
    for (const bucket of ['uploads', 'artifacts', 'nope', '']) {
      r = await insertToken(c, s, { bucket })
      check(`bucket '${bucket}' is refused (media_upload_tokens_bucket_check): only the public buckets`, r.err?.code === '23514' && r.err.constraint === 'media_upload_tokens_bucket_check', errSummary(r))
    }
    r = await insertToken(c, s, { bucket: 'video' })
    check("control: bucket 'video' is accepted", !r.err, errSummary(r))
    for (const maxBytes of [0, -1]) {
      r = await insertToken(c, s, { maxBytes })
      check(`max_bytes ${maxBytes} is refused (media_upload_tokens_max_bytes_check)`, r.err?.code === '23514' && r.err.constraint === 'media_upload_tokens_max_bytes_check', errSummary(r))
    }
    r = await insertToken(c, s, { mimesSql: `'{}'::text[]` })
    check('an EMPTY allowed mime set is refused (media_upload_tokens_allowed_mimes_check)', r.err?.code === '23514' && r.err.constraint === 'media_upload_tokens_allowed_mimes_check', errSummary(r))
    r = await insertToken(c, s, { mimesSql: `ARRAY['image/png','image/jpeg']` })
    check('control: a two-mime set is accepted', !r.err, errSummary(r))
    r = await insertToken(c, s, { expiresSql: `now() - interval '1 minute'` })
    check('an expires_at in the past is refused (media_upload_tokens_expiry_check)', r.err?.code === '23514' && r.err.constraint === 'media_upload_tokens_expiry_check', errSummary(r))
    r = await insertToken(c, s, { expiresSql: 'NULL' })
    check('expires_at NULL is refused (a token cannot be immortal)', r.err?.code === '23502', errSummary(r))
    r = await insertToken(c, s, { site: randomUUID() })
    check('an unknown site_id is refused by its foreign key', r.err?.code === '23503', errSummary(r))
    r = await attempt(c, `INSERT INTO media_upload_tokens (tenant_id, site_id, token_hash, bucket, max_bytes, allowed_mimes, expires_at, created_by) VALUES ($1,$2,$3,'media',1,ARRAY['image/png'], now() + interval '1 hour', NULL)`, [s.tenantId, s.site, newHash()])
    check('created_by NULL is refused', r.err?.code === '23502', errSummary(r))

    // THE SINGLE-USE CLAIM, as the upload route issues it.
    const claim = `UPDATE media_upload_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING id`
    r = await attempt(c, claim, [hash])
    check('POSITIVE CONTROL: the first claim hits exactly the row', !r.err && r.rowCount === 1 && r.rows[0].id === first, errSummary(r))
    r = await attempt(c, claim, [hash])
    check('a SECOND claim of the same token matches 0 rows (single use)', !r.err && r.rowCount === 0, errSummary(r))
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
    const A = await seedSite(c, randomUUID(), 'rls-a')
    const aRow = (await insertToken(c, A)).rows[0].id
    const aAsset = (await insertAsset(c, A)).rows[0].id
    const B = await seedSite(c, randomUUID(), 'rls-b')
    const bRow = (await insertToken(c, B)).rows[0].id
    const bAsset = (await insertAsset(c, B)).rows[0].id

    await setCtx(c, { tenant: A.tenantId })
    const seenByA = (await c.query(`SELECT id FROM media_upload_tokens WHERE id = ANY($1)`, [[aRow, bRow]])).rows.map((x) => x.id)
    check('POSITIVE CONTROL: tenant A sees its own token row', seenByA.includes(aRow), seenByA)
    check("tenant A does NOT see tenant B's token row", !seenByA.includes(bRow) && seenByA.length === 1, seenByA)
    let r = await insertToken(c, B)
    check('tenant A cannot INSERT a token for tenant B (WITH CHECK, 42501)', r.err?.code === '42501', errSummary(r))
    r = await attempt(c, `UPDATE media_upload_tokens SET used_at = now() WHERE id = $1`, [bRow])
    check("tenant A's claim of tenant B's token matches 0 rows", !r.err && r.rowCount === 0, errSummary(r))
    r = await attempt(c, `UPDATE media_upload_tokens SET tenant_id = $2 WHERE id = $1`, [aRow, B.tenantId])
    check('tenant A cannot hand its own token to tenant B (WITH CHECK, 42501)', r.err?.code === '42501', errSummary(r))
    const assetsSeenByA = (await c.query(`SELECT id FROM media_assets WHERE id = ANY($1)`, [[aAsset, bAsset]])).rows.map((x) => x.id)
    check("media_assets isolation is unchanged: A sees its asset and not B's", assetsSeenByA.length === 1 && assetsSeenByA[0] === aAsset, assetsSeenByA)

    await setCtx(c, { tenant: B.tenantId })
    const seenByB = (await c.query(`SELECT id, used_at FROM media_upload_tokens WHERE id = ANY($1)`, [[aRow, bRow]])).rows
    check("POSITIVE CONTROL: tenant B sees its own token and not A's, and A's attempts did not touch it", seenByB.length === 1 && seenByB[0].id === bRow && seenByB[0].used_at === null, seenByB)

    await setCtx(c, {})
    const unset = await one(c, `SELECT count(*)::int AS n FROM media_upload_tokens WHERE id = ANY($1)`, [[aRow, bRow]])
    check('an UNSET tenant context sees ZERO token rows (fail-closed, no error)', unset.n === 0, unset)
    await setCtx(c, { platform: true })
    const platform = await one(c, `SELECT count(*)::int AS n FROM media_upload_tokens WHERE id = ANY($1)`, [[aRow, bRow]])
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
  console.log('\n== D. DELETE / TRUNCATE refused on the token table, UPDATE allowed (as the app role) ==')
  const c = await connect(APP)
  try {
    await c.query('BEGIN')
    const s = await seedSite(c, randomUUID(), 'd')
    const r0 = await insertToken(c, s)
    check('setup: a row exists', !r0.err, errSummary(r0))
    let r = await attempt(c, `DELETE FROM media_upload_tokens WHERE tenant_id = $1`, [s.tenantId])
    check('DELETE -> 42501 permission denied', r.err?.code === '42501', errSummary(r))
    r = await attempt(c, `TRUNCATE media_upload_tokens`)
    check('TRUNCATE -> 42501 permission denied', r.err?.code === '42501', errSummary(r))
    r = await attempt(c, `UPDATE media_upload_tokens SET used_at = now() WHERE id = $1`, [r0.rows[0].id])
    check('POSITIVE CONTROL: UPDATE (the single-use claim) is allowed', !r.err && r.rowCount === 1, errSummary(r))
    r = await attempt(c, `SELECT count(*) FROM media_upload_tokens`)
    check('POSITIVE CONTROL: SELECT is allowed', !r.err, errSummary(r))
    const asset = (await insertAsset(c, s)).rows[0].id
    r = await attempt(c, `DELETE FROM media_assets WHERE id = $1`, [asset])
    check('media_assets: the app role may still DELETE a row (privacy erase of a form attachment relies on it)', !r.err && r.rowCount === 1, errSummary(r))
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    await c.end()
  }
  const m = await connect(MIGRATE)
  try {
    const mig = (await one(m, `SELECT has_table_privilege($1, 'media_upload_tokens', 'DELETE') AS ok`, [roles.migrator])).ok
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
// F. Scratch database at 0013 -> the real runner
// =============================================================================================
const keyed = (rows) => rows.map((s) => JSON.parse(s))

async function partF(roles) {
  console.log('\n== F. scratch database at 0013 -> the real runner ==')
  const db = 'wsk_43_pos'
  try {
    await createScratchDb(SUPER, db, roles)
    const url = withDb(MIGRATE, db)
    const applied = await applyThrough(url, TARGET)
    check(`[pos] scratch db built through ${PREV} (${applied.length} files, none of them 0014)`, applied.includes(PREV) && !applied.includes(TARGET), applied)
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
    check('[pos] the real runner applies exactly 0014 (exit 0, 1 applied)', run.status === 0 && /1 applied/.test(run.stdout), run.stdout + run.stderr)
    const after = await snap()
    const diff = {}
    for (const k of Object.keys(SNAPSHOT_SQL)) {
      const a = new Set(after[k])
      const b = new Set(before[k])
      diff[k] = { lost: keyed(before[k].filter((x) => !a.has(x))), added: keyed(after[k].filter((x) => !b.has(x))) }
      console.log(`        ${k}: before=${before[k].length} after=${after[k].length} added=${diff[k].added.length} lost=${diff[k].lost.length}`)
    }
    for (const k of Object.keys(SNAPSHOT_SQL)) check(`[pos] ${k}: nothing lost`, diff[k].lost.length === 0, diff[k].lost)
    const onlyThese = (rows) => rows.every((r) => r[0] === TOKENS || r[0] === ASSETS)
    check('[pos] columns: 11 on media_assets + 11 on media_upload_tokens', diff.columns.added.length === 22 && diff.columns.added.filter((r) => r[0] === ASSETS).length === 11 && diff.columns.added.filter((r) => r[0] === TOKENS).length === 11, diff.columns.added.length)
    check('[pos] constraints: only on media_assets (8 new CHECKs) and media_upload_tokens', onlyThese(diff.constraints.added) && diff.constraints.added.filter((r) => r[0] === ASSETS).length === 8, diff.constraints.added.map((r) => `${r[0]}.${r[1]}`))
    check('[pos] indexes: 2 on media_assets, the pk + 4 on media_upload_tokens', diff.indexes.added.length === 7 && diff.indexes.added.filter((r) => r[0] === ASSETS).length === 2 && diff.indexes.added.filter((r) => r[0] === TOKENS).length === 5, diff.indexes.added.map((r) => r[1]))
    check('[pos] policies: exactly tenant_isolation on media_upload_tokens (media_assets keeps its own)', diff.policies.added.length === 1 && diff.policies.added[0][0] === TOKENS && diff.policies.added[0][1] === 'tenant_isolation', diff.policies.added)
    check('[pos] triggers: none added', diff.triggers.added.length === 0, diff.triggers.added)
    const appGrants = diff.grants.added.filter((g) => g[1] === roles.app).map((g) => g[2]).sort()
    check(`[pos] grants: ${roles.app} gains exactly SELECT, INSERT, UPDATE, and only on media_upload_tokens`, diff.grants.added.every((g) => g[0] === TOKENS) && appGrants.join() === 'INSERT,SELECT,UPDATE', diff.grants.added)
    const rlsRow = diff.rls.added.find((r) => r[0] === TOKENS)
    check('[pos] rls: media_upload_tokens arrives enabled + forced', diff.rls.added.length === 1 && rlsRow?.[1] === true && rlsRow?.[2] === true, diff.rls.added)
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
