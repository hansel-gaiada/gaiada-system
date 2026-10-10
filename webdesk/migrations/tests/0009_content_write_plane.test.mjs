#!/usr/bin/env node
/**
 * WSK-65 — migration 0009 (the write-plane storage model, ruling WSK-D45) proven against a real
 * Postgres. Spec: docs/plans/2026-10-10-webdesk-write-plane-design.md §2.6 and §12's WSK-65 row.
 *
 * Four parts, one exit code:
 *   A. Catalog state of the MAIN database (already migrated through 0009 by the real runner):
 *      columns, named constraints, indexes, table ownership, app-role grants, RLS flags.
 *   B. Behaviour, as the app role, inside one transaction that is ROLLED BACK: the cross-tenant
 *      probe on control_idempotency_keys (with positive controls), fail-closed writes, and each new
 *      unique index and CHECK, each with a control that the legitimate case still succeeds.
 *   C. Negative controls on scratch databases stopped at 0008: duplicates seeded under the tenant
 *      GUC (invisible to a migrator SELECT without the GUC: the zero-row trap, shown), then the REAL
 *      runner must fail loudly, leave no ledger row and no partial DDL.
 *   D. Positive control on a seeded 0008 scratch database: replay-row reuse and cross-site group
 *      reuse do NOT block 0009; every pre-existing constraint, index, policy and grant survives with
 *      an identical definition (no DROP+ADD re-declaration); seeded rows land in the "unadopted"
 *      state; a second runner pass is a no-op.
 *
 * Env (all point at the same cluster):
 *   SUPERUSER_DATABASE_URL  cluster bootstrap identity on the main db (creates/drops scratch dbs)
 *   MIGRATE_DATABASE_URL    webdesk_migrator on the main db
 *   APP_DATABASE_URL        webdesk_app on the main db
 *
 * Run (from webdesk/):  node migrations/tests/0009_content_write_plane.test.mjs
 */
import { randomUUID } from 'node:crypto'
import {
  SNAPSHOT_SQL,
  TARGET_FILE,
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
  seedTenant,
  setCtx,
  snapshot,
  withDb,
} from './0009_helpers.mjs'

requireEnv(['SUPERUSER_DATABASE_URL', 'MIGRATE_DATABASE_URL', 'APP_DATABASE_URL'])
const SUPER = process.env.SUPERUSER_DATABASE_URL
const MIGRATE = process.env.MIGRATE_DATABASE_URL
const APP = process.env.APP_DATABASE_URL

const { check, summary } = makeChecker('0009')

// =============================================================================================
// A. Catalog state of the main database
// =============================================================================================
async function partA(roles) {
  console.log('\n== A. catalog state (main db) ==')
  const c = await connect(MIGRATE)
  try {
    const ledger = await one(c, `SELECT count(*)::int AS n FROM schema_migrations WHERE name = $1`, [TARGET_FILE])
    check(`ledger records ${TARGET_FILE} exactly once`, ledger.n === 1, ledger)

    const cols = await c.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (
            ('content_items','head_version'), ('content_items','published_version'), ('content_items','deleted_at'),
            ('content_items','last_published_at'), ('content_items','last_published_by'),
            ('content_versions','content_hash'), ('content_versions','note'), ('content_versions','attribution'))
        ORDER BY table_name, column_name`,
    )
    const col = Object.fromEntries(cols.rows.map((r) => [`${r.table_name}.${r.column_name}`, r]))
    check('8 new columns present', cols.rows.length === 8, cols.rows.map((r) => `${r.table_name}.${r.column_name}`))
    check(
      'content_items.head_version integer NOT NULL DEFAULT 0',
      col['content_items.head_version']?.data_type === 'integer' &&
        col['content_items.head_version']?.is_nullable === 'NO' &&
        col['content_items.head_version']?.column_default === '0',
      col['content_items.head_version'],
    )
    check('content_items.published_version integer NULL', col['content_items.published_version']?.is_nullable === 'YES')
    check('content_items.deleted_at timestamptz NULL', col['content_items.deleted_at']?.data_type === 'timestamp with time zone')
    check(
      "content_versions.attribution jsonb NOT NULL DEFAULT '{}'",
      col['content_versions.attribution']?.data_type === 'jsonb' &&
        col['content_versions.attribution']?.is_nullable === 'NO' &&
        String(col['content_versions.attribution']?.column_default).startsWith("'{}'::jsonb"),
      col['content_versions.attribution'],
    )

    const cons = await c.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = ANY($1) ORDER BY conname`,
      [[
        'content_items_head_version_check', 'content_items_published_version_check',
        'content_items_published_le_head_check', 'content_items_last_published_pair_check',
        'content_versions_content_hash_check', 'content_versions_note_check', 'content_versions_attribution_check',
        'control_idempotency_keys_status_check', 'control_idempotency_keys_expiry_check',
      ]],
    )
    check('9 named CHECK constraints present', cons.rows.length === 9, cons.rows.map((r) => r.conname))

    const idx = await c.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
         AND indexname = ANY($1) ORDER BY indexname`,
      [['ux_content_items_group_locale', 'ux_audit_entries_ws4_once', 'ux_idem_tenant', 'ux_idem_platform', 'ix_idem_expires', 'ix_audit_entries_ws4']],
    )
    const ix = Object.fromEntries(idx.rows.map((r) => [r.indexname, r.indexdef]))
    for (const r of idx.rows) console.log(`        ${r.indexdef}`)
    check(
      'ux_content_items_group_locale: UNIQUE (site_id, localization_group_id, locale) WHERE deleted_at IS NULL',
      /UNIQUE INDEX .* \(site_id, localization_group_id, locale\) WHERE \(deleted_at IS NULL\)/.test(ix.ux_content_items_group_locale ?? ''),
    )
    check(
      "ux_audit_entries_ws4_once: UNIQUE (ws4_approval_id) WHERE NOT NULL AND action NOT LIKE '%.replay'",
      /UNIQUE INDEX .* \(ws4_approval_id\) WHERE \(\(ws4_approval_id IS NOT NULL\) AND \(action !~~ '%\.replay'::text\)\)/.test(
        ix.ux_audit_entries_ws4_once ?? '',
      ),
    )
    check('ux_idem_tenant + ux_idem_platform are partial UNIQUE indexes', /UNIQUE/.test(ix.ux_idem_tenant ?? '') && /UNIQUE/.test(ix.ux_idem_platform ?? ''))
    check('0001 plain index ix_audit_entries_ws4 is still there (replay lookups)', !!ix.ix_audit_entries_ws4)

    // Ownership: every base table in public owned by the migrator (the live-box incident was
    // tables owned by `postgres` with zero app grants).
    const owners = await c.query(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`,
    )
    const foreign = owners.rows.filter((r) => r.owner !== roles.migrator)
    check(`all ${owners.rows.length} public tables owned by ${roles.migrator}`, foreign.length === 0, foreign)

    const priv = await one(
      c,
      `SELECT has_table_privilege($1, 'control_idempotency_keys', 'SELECT') AS s,
              has_table_privilege($1, 'control_idempotency_keys', 'INSERT') AS i,
              has_table_privilege($1, 'control_idempotency_keys', 'UPDATE') AS u,
              has_table_privilege($1, 'control_idempotency_keys', 'DELETE') AS d,
              has_table_privilege($1, 'content_items', 'SELECT,INSERT,UPDATE,DELETE') AS ci,
              has_table_privilege($1, 'content_versions', 'UPDATE') AS cv_u,
              has_table_privilege($1, 'content_versions', 'DELETE') AS cv_d,
              has_table_privilege($1, 'audit_entries', 'UPDATE') AS ae_u,
              has_table_privilege($1, 'audit_entries', 'DELETE') AS ae_d`,
      [roles.app],
    )
    check(`${roles.app} has SELECT/INSERT/UPDATE/DELETE on control_idempotency_keys`, priv.s && priv.i && priv.u && priv.d, priv)
    check(`${roles.app} keeps full DML on content_items`, priv.ci === true)
    check(`content_versions stays append-only for ${roles.app} (no UPDATE/DELETE)`, !priv.cv_u && !priv.cv_d, priv)
    check(`audit_entries stays append-only for ${roles.app} (no UPDATE/DELETE)`, !priv.ae_u && !priv.ae_d, priv)

    // RLS: the same query check-rls-integrity.mjs runs, listed out.
    const rls = await c.query(
      `SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped)
        ORDER BY c.relname`,
    )
    console.log(`        tenant-scoped tables (${rls.rows.length}): ` + rls.rows.map((r) => `${r.relname}[${r.enabled ? 'E' : '-'}${r.forced ? 'F' : '-'}${r.policies}]`).join(' '))
    const idem = rls.rows.find((r) => r.relname === 'control_idempotency_keys')
    check('control_idempotency_keys: RLS enabled + FORCED + 1 policy', idem?.enabled && idem?.forced && idem?.policies === 1, idem)
    const pol = await one(
      c,
      `SELECT pg_get_expr(polqual, polrelid) AS q, pg_get_expr(polwithcheck, polrelid) AS w, polcmd
         FROM pg_policy WHERE polrelid = 'control_idempotency_keys'::regclass`,
    )
    check(
      'idempotency policy is dual-mode on BOTH USING and WITH CHECK, FOR ALL',
      pol.polcmd === '*' && [pol.q, pol.w].every((e) => /webdesk_tenant_ctx\(\)/.test(e) && /webdesk_platform_ctx\(\)/.test(e) && /tenant_id IS NULL/.test(e)),
      pol,
    )
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
  const A = randomUUID()
  const B = randomUUID()
  try {
    await c.query('BEGIN')

    // --- fixtures: two tenants (platform ctx), a site + collection each (tenant ctx) ------------
    await setCtx(c, { platform: true })
    for (const [id, label] of [[A, 'a'], [B, 'b']]) {
      await c.query(`INSERT INTO tenants (id, slug, company_ref) VALUES ($1, $2, $3)`, [id, `wsk65-${label}-${id.slice(0, 8)}`, randomUUID()])
    }
    const sites = {}
    const cols = {}
    for (const t of [A, B]) {
      await setCtx(c, { tenant: t })
      sites[t] = (await one(c, `INSERT INTO sites (tenant_id, kind, name) VALUES ($1, 'astro', 'wsk65') RETURNING id`, [t])).id
      cols[t] = (await one(c, `INSERT INTO collections (tenant_id, site_id, key) VALUES ($1, $2, 'page') RETURNING id`, [t, sites[t]])).id
    }

    // --- control_idempotency_keys: one row per mode, the SAME scope_key everywhere ------------
    const insIdem = `INSERT INTO control_idempotency_keys (tenant_id, scope_key, command, request_hash, status) VALUES ($1, $2, 'content.update', 'h', 'in_flight')`
    await setCtx(c, { tenant: A })
    let r = await attempt(c, insIdem, [A, 'k1'])
    check('tenant A writes its own idempotency row', !r.err, errSummary(r))
    await setCtx(c, { tenant: B })
    r = await attempt(c, insIdem, [B, 'k1'])
    check('tenant B writes the same scope_key (uniqueness is per tenant)', !r.err, errSummary(r))
    await setCtx(c, { platform: true })
    r = await attempt(c, insIdem, [null, 'k1'])
    check('platform ctx writes a platform row (tenant_id NULL) with the same scope_key', !r.err, errSummary(r))

    // --- the cross-tenant probe + positive controls -------------------------------------------
    const countFor = `SELECT count(*)::int AS n FROM control_idempotency_keys WHERE tenant_id = $1`
    await setCtx(c, { tenant: A })
    const aSeesB = (await one(c, countFor, [B])).n
    const aTotal = (await one(c, `SELECT count(*)::int AS n FROM control_idempotency_keys`)).n
    const aSeesNull = (await one(c, `SELECT count(*)::int AS n FROM control_idempotency_keys WHERE tenant_id IS NULL`)).n
    await setCtx(c, { tenant: B })
    const bSeesB = (await one(c, countFor, [B])).n
    console.log(`        probe: A-ctx sees B rows=${aSeesB}, A-ctx total=${aTotal}, A-ctx NULL rows=${aSeesNull}; B-ctx sees B rows=${bSeesB}`)
    check("CROSS-TENANT PROBE: tenant A's GUC reads 0 of tenant B's idempotency rows", aSeesB === 0, aSeesB)
    check('POSITIVE CONTROL: the same query under tenant B reads 1 row', bSeesB === 1, bSeesB)
    check('tenant A sees exactly its own 1 row and no platform rows', aTotal === 1 && aSeesNull === 0, { aTotal, aSeesNull })

    await setCtx(c, { platform: true })
    const pNull = (await one(c, `SELECT count(*)::int AS n FROM control_idempotency_keys WHERE tenant_id IS NULL`)).n
    const pTenant = (await one(c, `SELECT count(*)::int AS n FROM control_idempotency_keys WHERE tenant_id IS NOT NULL`)).n
    console.log(`        probe: platform-ctx NULL rows=${pNull}, tenant rows=${pTenant}`)
    check('platform ctx reads only tenant_id IS NULL rows (0 tenant rows)', pTenant === 0, pTenant)
    check('POSITIVE CONTROL: platform ctx reads its 1 platform row', pNull === 1, pNull)

    await setCtx(c, {})
    const none = (await one(c, `SELECT count(*)::int AS n FROM control_idempotency_keys`)).n
    check('no GUC at all: 0 rows (fail-closed, no error)', none === 0, none)

    // --- fail-closed writes --------------------------------------------------------------------
    await setCtx(c, { tenant: A })
    r = await attempt(c, insIdem, [B, 'k2'])
    check('tenant A cannot INSERT a row for tenant B (WITH CHECK, 42501)', r.err?.code === '42501', errSummary(r))
    r = await attempt(c, insIdem, [null, 'k2'])
    check('tenant A cannot INSERT a platform row (42501)', r.err?.code === '42501', errSummary(r))
    r = await attempt(c, `UPDATE control_idempotency_keys SET status = 'completed' WHERE tenant_id = $1`, [B])
    check("tenant A's UPDATE of tenant B's row matches 0 rows", !r.err && r.rowCount === 0, errSummary(r))
    r = await attempt(c, `UPDATE control_idempotency_keys SET tenant_id = $1 WHERE tenant_id = $2`, [B, A])
    check('tenant A cannot move its own row to tenant B (42501)', r.err?.code === '42501', errSummary(r))
    r = await attempt(c, `UPDATE control_idempotency_keys SET status = 'completed', response = '{"ok":true}' WHERE tenant_id = $1`, [A])
    check('tenant A completes its own row (in_flight -> completed)', !r.err && r.rowCount === 1, errSummary(r))
    await setCtx(c, { platform: true })
    r = await attempt(c, insIdem, [A, 'k3'])
    check('platform ctx cannot INSERT a tenant row (42501)', r.err?.code === '42501', errSummary(r))

    // --- idempotency uniqueness + checks -------------------------------------------------------
    await setCtx(c, { tenant: A })
    r = await attempt(c, insIdem, [A, 'k1'])
    check('duplicate (tenant, scope_key) refused by ux_idem_tenant', r.err?.code === '23505' && /ux_idem_tenant/.test(r.err.message), errSummary(r))
    await setCtx(c, { platform: true })
    r = await attempt(c, insIdem, [null, 'k1'])
    check('duplicate platform scope_key refused by ux_idem_platform (NULL does not defeat it)', r.err?.code === '23505' && /ux_idem_platform/.test(r.err.message), errSummary(r))
    r = await attempt(c, `INSERT INTO control_idempotency_keys (tenant_id, scope_key, command, request_hash, status) VALUES (NULL, 'k9', 'x', 'h', 'done')`)
    check("status outside ('in_flight','completed') refused (23514)", r.err?.code === '23514', errSummary(r))
    r = await attempt(
      c,
      `INSERT INTO control_idempotency_keys (tenant_id, scope_key, command, request_hash, status, expires_at) VALUES (NULL, 'k8', 'x', 'h', 'in_flight', now() - interval '1 second')`,
    )
    check('expires_at not after created_at refused (23514)', r.err?.code === '23514', errSummary(r))
    const exp = await one(c, `SELECT (expires_at - created_at) AS ttl FROM control_idempotency_keys WHERE tenant_id IS NULL AND scope_key = 'k1'`)
    check('default TTL is 7 days', exp?.ttl?.days === 7, exp)

    // --- audit_entries: WS4 single use ---------------------------------------------------------
    const W = randomUUID()
    const insAudit = `INSERT INTO audit_entries (tenant_id, actor, action, ws4_approval_id) VALUES ($1, 'wsk65', $2, $3)`
    await setCtx(c, { tenant: A })
    r = await attempt(c, insAudit, [A, 'control.content.publish', W])
    check('first non-replay use of an approval id is accepted', !r.err, errSummary(r))
    r = await attempt(c, insAudit, [A, 'control.content.publish.replay', W])
    check('a .replay row carrying the same approval id is accepted (excluded from the index)', !r.err, errSummary(r))
    r = await attempt(c, insAudit, [A, 'control.content.publish.replay', W])
    check('a second .replay row is accepted too', !r.err, errSummary(r))
    r = await attempt(c, insAudit, [A, 'control.content.publish', W])
    check('SECOND non-replay use of the approval id refused by ux_audit_entries_ws4_once', r.err?.code === '23505' && /ux_audit_entries_ws4_once/.test(r.err.message), errSummary(r))
    r = await attempt(c, insAudit, [A, 'control.release.promote', W])
    check('reuse under a DIFFERENT command is refused too (single use is per approval, not per command)', r.err?.code === '23505', errSummary(r))
    await setCtx(c, { tenant: B })
    r = await attempt(c, insAudit, [B, 'control.content.publish', W])
    check("reuse by ANOTHER tenant is refused (the index reads the heap, not tenant B's RLS view)", r.err?.code === '23505', errSummary(r))
    await setCtx(c, { platform: true })
    r = await attempt(c, insAudit, [null, 'control.tenant.archive', W])
    check('reuse at platform scope (tenant_id NULL) is refused', r.err?.code === '23505', errSummary(r))
    r = await attempt(c, insAudit, [null, 'control.tenant.archive', randomUUID()])
    check('POSITIVE CONTROL: a fresh approval id at platform scope is accepted', !r.err, errSummary(r))
    await setCtx(c, { tenant: A })
    r = await attempt(c, insAudit, [A, 'control.contract.read', null])
    const r2 = await attempt(c, insAudit, [A, 'control.contract.read', null])
    check('rows with NULL ws4_approval_id are unconstrained', !r.err && !r2.err, `${errSummary(r)} / ${errSummary(r2)}`)

    // --- content_items: one live row per (site, group, locale) ---------------------------------
    const G = randomUUID()
    const insItem = `INSERT INTO content_items (tenant_id, site_id, collection_id, locale, slug, localization_group_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`
    await setCtx(c, { tenant: A })
    r = await attempt(c, insItem, [A, sites[A], cols[A], 'en', 'home', G])
    const firstId = r.rows?.[0]?.id
    check('first (site, group, en) item accepted', !r.err, errSummary(r))
    const fresh = await one(c, `SELECT head_version, published_version, deleted_at, last_published_at, last_published_by FROM content_items WHERE id = $1`, [firstId])
    check('a new row starts unadopted: head 0, published NULL, not deleted, no publish attribution', fresh.head_version === 0 && fresh.published_version === null && fresh.deleted_at === null && fresh.last_published_by === null, fresh)
    r = await attempt(c, insItem, [A, sites[A], cols[A], 'id', 'beranda', G])
    check('sibling locale in the same group accepted', !r.err, errSummary(r))
    r = await attempt(c, insItem, [A, sites[A], cols[A], 'en', 'home-2', G])
    check('second LIVE (site, group, en) item refused by ux_content_items_group_locale', r.err?.code === '23505' && /ux_content_items_group_locale/.test(r.err.message), errSummary(r))
    r = await attempt(c, `UPDATE content_items SET deleted_at = now() WHERE id = $1`, [firstId])
    check('soft delete of the first item', !r.err && r.rowCount === 1, errSummary(r))
    r = await attempt(c, insItem, [A, sites[A], cols[A], 'en', 'home-2', G])
    check('after soft delete the (site, group, en) slot is free again', !r.err, errSummary(r))
    const site2 = (await one(c, `INSERT INTO sites (tenant_id, kind, name) VALUES ($1, 'astro', 'wsk65-2') RETURNING id`, [A])).id
    const col2 = (await one(c, `INSERT INTO collections (tenant_id, site_id, key) VALUES ($1, $2, 'page') RETURNING id`, [A, site2])).id
    r = await attempt(c, insItem, [A, site2, col2, 'en', 'home', G])
    check('the same (group, en) on ANOTHER site is accepted (index is site-scoped: bundle copies)', !r.err, errSummary(r))

    // --- content_items CHECKs ------------------------------------------------------------------
    const target = (await one(c, `SELECT id FROM content_items WHERE localization_group_id = $1 AND locale = 'id'`, [G])).id
    const upd = (set) => attempt(c, `UPDATE content_items SET ${set} WHERE id = $1`, [target])
    r = await upd(`head_version = -1`)
    check('head_version < 0 refused', r.err?.code === '23514' && /content_items_head_version_check/.test(r.err.message), errSummary(r))
    r = await upd(`published_version = 0, head_version = 3`)
    check('published_version 0 refused', r.err?.code === '23514' && /content_items_published_version_check/.test(r.err.message), errSummary(r))
    r = await upd(`published_version = 1`)
    check('publishing an unadopted row (published 1 > head 0) refused', r.err?.code === '23514' && /content_items_published_le_head_check/.test(r.err.message), errSummary(r))
    r = await upd(`head_version = 2, published_version = 3`)
    check('published_version ahead of head refused', r.err?.code === '23514' && /published_le_head/.test(r.err.message), errSummary(r))
    r = await upd(`head_version = 2, published_version = 1, last_published_at = now()`)
    check('last_published_at without last_published_by refused', r.err?.code === '23514' && /last_published_pair/.test(r.err.message), errSummary(r))
    r = await upd(`head_version = 2, published_version = 1, last_published_at = now(), last_published_by = 'kc:user-1', publish_state = 'published'`)
    check('POSITIVE CONTROL: head 2 / published 1 / full attribution accepted', !r.err && r.rowCount === 1, errSummary(r))
    r = await upd(`head_version = 3`)
    check('a draft edit past a published version (head 3, published 1) accepted', !r.err && r.rowCount === 1, errSummary(r))

    // --- content_versions: hash, note, attribution; still append-only --------------------------
    const insVer = `INSERT INTO content_versions (tenant_id, content_item_id, version, blocks, publish_state, created_by, content_hash, note, attribution)
                    VALUES ($1, $2, $3, '[]', 'draft', 'kc:user-1', $4, $5, $6::jsonb)`
    const H = 'a'.repeat(64)
    r = await attempt(c, insVer, [A, target, 1, H, 'first', '{"pk":"kc:user-1","req":"r1"}'])
    check('version with a 64-hex hash, a note and an object attribution accepted', !r.err, errSummary(r))
    r = await attempt(c, insVer, [A, target, 2, 'ABC', null, '{}'])
    check('non-hex / wrong-length content_hash refused', r.err?.code === '23514' && /content_hash_check/.test(r.err.message), errSummary(r))
    r = await attempt(c, insVer, [A, target, 2, 'A'.repeat(64), null, '{}'])
    check('UPPERCASE hex refused (canonical lower-case only)', r.err?.code === '23514', errSummary(r))
    r = await attempt(c, insVer, [A, target, 2, null, 'x'.repeat(501), '{}'])
    check('note longer than 500 refused', r.err?.code === '23514' && /note_check/.test(r.err.message), errSummary(r))
    r = await attempt(c, insVer, [A, target, 2, null, 'x'.repeat(500), '{}'])
    check('note of exactly 500 accepted', !r.err, errSummary(r))
    r = await attempt(c, insVer, [A, target, 3, null, null, '[]'])
    check('array attribution refused (must be an object)', r.err?.code === '23514' && /attribution_check/.test(r.err.message), errSummary(r))
    r = await attempt(
      c,
      `INSERT INTO content_versions (tenant_id, content_item_id, version, blocks, publish_state, created_by) VALUES ($1, $2, 4, '[]', 'draft', 'legacy') RETURNING attribution, content_hash`,
      [A, target],
    )
    check("pre-0009-shaped insert (no new columns) still works; attribution defaults to {} and hash to NULL", !r.err && JSON.stringify(r.rows[0].attribution) === '{}' && r.rows[0].content_hash === null, errSummary(r))
    r = await attempt(c, `UPDATE content_versions SET note = 'rewrite' WHERE content_item_id = $1`, [target])
    check('content_versions is still append-only for the app role (UPDATE -> 42501)', r.err?.code === '42501', errSummary(r))
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    await c.end()
  }
}

// =============================================================================================
// C. Negative controls: duplicates seeded under the tenant GUC on a 0008 scratch db
// =============================================================================================
async function assertLoudFailure(roles, dbName, label, seed, expectMsg) {
  console.log(`\n-- negative control: ${label} (scratch db ${dbName}) --`)
  await createScratchDb(SUPER, dbName, roles)
  const mUrl = withDb(MIGRATE, dbName)
  try {
    const applied = await applyThrough(mUrl)
    check(`[${label}] scratch db built at 0001..0008 (${applied.length} files)`, applied.length === 8 && applied.at(-1).startsWith('0008_'), applied)
    const m = await connect(mUrl)
    try {
      const visibleWithGuc = await seed(m)
      const noGuc = await one(m, `SELECT (SELECT count(*)::int FROM content_items) AS items, (SELECT count(*)::int FROM audit_entries) AS audits`)
      console.log(`        seeded under the tenant GUC: ${JSON.stringify(visibleWithGuc)}; the migrator WITHOUT a GUC sees ${JSON.stringify(noGuc)}`)
      check(`[${label}] zero-row trap shown: a SELECT precondition (no GUC) would see 0 rows and pass`, noGuc.items === 0 && noGuc.audits === 0, noGuc)
    } finally {
      await m.end()
    }
    const run = runRunner(mUrl, { through: TARGET_FILE })
    console.log(`        runner exit=${run.status}`)
    for (const line of (run.stdout + run.stderr).trim().split('\n')) console.log(`        | ${line}`)
    check(`[${label}] the real runner exits non-zero`, run.status === 1, run.status)
    check(`[${label}] the error names the failed precondition`, expectMsg.test(run.stderr), run.stderr)
    const m2 = await connect(mUrl)
    try {
      const st = await one(
        m2,
        `SELECT (SELECT count(*)::int FROM schema_migrations WHERE name = $1) AS ledger,
                (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'content_items' AND column_name = 'head_version') AS col,
                to_regclass('public.control_idempotency_keys') IS NOT NULL AS idem_table,
                to_regclass('public.ux_content_items_group_locale') IS NOT NULL AS idx`,
        [TARGET_FILE],
      )
      check(`[${label}] atomic: no ledger row, no new column, no new table, no new index`, st.ledger === 0 && st.col === 0 && !st.idem_table && !st.idx, st)
    } finally {
      await m2.end()
    }
    return mUrl
  } catch (err) {
    check(`[${label}] unexpected harness error`, false, err.message)
    return mUrl
  }
}

async function partC(roles) {
  console.log('\n== C. negative controls (duplicates seeded under the tenant GUC before applying) ==')
  const dbs = ['wsk65_neg_group', 'wsk65_neg_ws4', 'wsk65_neg_ws4x']
  try {
    // C1: two live rows for the same (site, group, locale).
    const url1 = await assertLoudFailure(
      roles,
      dbs[0],
      'duplicate (site_id, localization_group_id, locale)',
      async (m) => {
        const { t, site, col } = await seedTenant(m)
        const g = randomUUID()
        await m.query('BEGIN')
        await setCtx(m, { tenant: t })
        for (const slug of ['dup-a', 'dup-b']) {
          await m.query(`INSERT INTO content_items (tenant_id, site_id, collection_id, locale, slug, localization_group_id) VALUES ($1,$2,$3,'en',$4,$5)`, [t, site, col, slug, g])
        }
        const n = (await one(m, `SELECT count(*)::int AS n FROM content_items WHERE localization_group_id = $1`, [g])).n
        await m.query('COMMIT')
        return { tenantGucSees: n }
      },
      /0009 precondition FAILED: content_items has two live rows for the same \(site_id, localization_group_id, locale\)/,
    )
    // Remediation path: fix the duplicate under the GUC, re-run, it applies.
    {
      const m = await connect(url1)
      try {
        await m.query('BEGIN')
        await setCtx(m, { platform: true })
        const t = (await one(m, `SELECT id FROM tenants ORDER BY created_at, id LIMIT 1`)).id
        await setCtx(m, { tenant: t })
        const del = await m.query(`DELETE FROM content_items WHERE tenant_id = $1 AND slug = 'dup-b'`, [t])
        await m.query('COMMIT')
        check('[remediation] the duplicate removed under the tenant GUC (1 row)', del.rowCount === 1, del.rowCount)
      } finally {
        await m.end()
      }
      const rerun = runRunner(url1, { through: TARGET_FILE })
      console.log(`        rerun exit=${rerun.status}: ${rerun.stdout.trim().split('\n').at(-1)}`)
      check('[remediation] after the fix the runner applies 0009 (exit 0)', rerun.status === 0 && /1 applied/.test(rerun.stdout), rerun.stdout + rerun.stderr)
    }

    // C2: one approval id on two non-replay rows in the same tenant.
    await assertLoudFailure(
      roles,
      dbs[1],
      'duplicate non-replay ws4_approval_id (tenant scope)',
      async (m) => {
        const { t } = await seedTenant(m)
        const w = randomUUID()
        await m.query('BEGIN')
        await setCtx(m, { tenant: t })
        for (const action of ['control.release.promote', 'control.release.promote']) {
          await m.query(`INSERT INTO audit_entries (tenant_id, actor, action, ws4_approval_id) VALUES ($1, 'x', $2, $3)`, [t, action, w])
        }
        const n = (await one(m, `SELECT count(*)::int AS n FROM audit_entries WHERE ws4_approval_id = $1`, [w])).n
        await m.query('COMMIT')
        return { tenantGucSees: n }
      },
      /0009 precondition FAILED: audit_entries holds one WS4 approval id on two non-replay rows/,
    )

    // C3: the same approval id once at platform scope and once in a tenant (two RLS scopes; no
    // single GUC can see both rows, but the index build does).
    await assertLoudFailure(
      roles,
      dbs[2],
      'duplicate non-replay ws4_approval_id across platform + tenant scope',
      async (m) => {
        const { t } = await seedTenant(m)
        const w = randomUUID()
        await m.query('BEGIN')
        await setCtx(m, { platform: true })
        await m.query(`INSERT INTO audit_entries (tenant_id, actor, action, ws4_approval_id) VALUES (NULL, 'x', 'control.tenant.archive', $1)`, [w])
        const p = (await one(m, `SELECT count(*)::int AS n FROM audit_entries WHERE ws4_approval_id = $1`, [w])).n
        await setCtx(m, { tenant: t })
        await m.query(`INSERT INTO audit_entries (tenant_id, actor, action, ws4_approval_id) VALUES ($1, 'x', 'control.release.promote', $2)`, [t, w])
        const tn = (await one(m, `SELECT count(*)::int AS n FROM audit_entries WHERE ws4_approval_id = $1`, [w])).n
        await m.query('COMMIT')
        return { platformGucSees: p, tenantGucSees: tn }
      },
      /0009 precondition FAILED: audit_entries holds one WS4 approval id on two non-replay rows/,
    )
  } finally {
    for (const d of dbs) await dropScratchDb(SUPER, d).catch(() => {})
  }
}

// =============================================================================================
// D. Positive control: a populated 0008 db takes 0009 cleanly; nothing pre-existing changes
// =============================================================================================
async function partD(roles) {
  console.log('\n== D. positive control: populated 0008 db -> 0009, nothing pre-existing altered ==')
  const db = 'wsk65_pos'
  await createScratchDb(SUPER, db, roles)
  const mUrl = withDb(MIGRATE, db)
  try {
    await applyThrough(mUrl)
    const m = await connect(mUrl)
    let t, item, w
    try {
      const s = await seedTenant(m)
      t = s.t
      w = randomUUID()
      const g = randomUUID()
      await m.query('BEGIN')
      await setCtx(m, { tenant: t })
      // published item + a version row, as pre-0009 code writes them
      item = (await one(m, `INSERT INTO content_items (tenant_id, site_id, collection_id, locale, slug, localization_group_id, publish_state, blocks)
                             VALUES ($1,$2,$3,'en','home',$4,'published','[{"type":"hero","props":{}}]') RETURNING id`, [t, s.site, s.col, g])).id
      await m.query(`INSERT INTO content_versions (tenant_id, content_item_id, version, blocks, publish_state, created_by) VALUES ($1,$2,1,'[]','published','legacy')`, [t, item])
      // the same group+locale on a second site (a same-database bundle copy)
      const site2 = (await one(m, `INSERT INTO sites (tenant_id, kind, name) VALUES ($1,'astro','copy') RETURNING id`, [t])).id
      const col2 = (await one(m, `INSERT INTO collections (tenant_id, site_id, key) VALUES ($1,$2,'page') RETURNING id`, [t, site2])).id
      await m.query(`INSERT INTO content_items (tenant_id, site_id, collection_id, locale, slug, localization_group_id) VALUES ($1,$2,$3,'en','home',$4)`, [t, site2, col2, g])
      // one execution + two idempotent replays of the same approval
      for (const a of ['control.release.promote', 'control.release.promote.replay', 'control.release.promote.replay']) {
        await m.query(`INSERT INTO audit_entries (tenant_id, actor, action, ws4_approval_id) VALUES ($1,'x',$2,$3)`, [t, a, w])
      }
      await m.query('COMMIT')
    } finally {
      await m.end()
    }

    const sc = await connect(mUrl)
    const snapBefore = await snapshot(sc)
    await sc.end()

    const run = runRunner(mUrl, { through: TARGET_FILE })
    console.log(`        runner exit=${run.status}: ${(run.stdout + run.stderr).trim().split('\n').join(' | ')}`)
    check('populated db with replay rows + cross-site group reuse takes 0009 (exit 0, 1 applied)', run.status === 0 && /1 applied/.test(run.stdout), run.stdout + run.stderr)

    const sc2 = await connect(mUrl)
    const snapAfter = await snapshot(sc2)
    for (const k of Object.keys(SNAPSHOT_SQL)) {
      const after = new Set(snapAfter[k])
      const lost = snapBefore[k].filter((x) => !after.has(x))
      const added = snapAfter[k].filter((x) => !new Set(snapBefore[k]).has(x))
      console.log(`        ${k}: before=${snapBefore[k].length} after=${snapAfter[k].length} added=${added.length} changed-or-removed=${lost.length}`)
      check(`every pre-0009 ${k} entry survives with an identical definition`, lost.length === 0, lost)
    }

    // seeded rows are in the "unadopted" state the WSK-41 service expects
    await sc2.query('BEGIN')
    await setCtx(sc2, { tenant: t })
    const st = await one(
      sc2,
      `SELECT (SELECT count(*)::int FROM content_items WHERE head_version = 0 AND published_version IS NULL AND deleted_at IS NULL AND last_published_by IS NULL) AS unadopted,
              (SELECT count(*)::int FROM content_items) AS items,
              (SELECT count(*)::int FROM content_versions WHERE content_hash IS NULL AND note IS NULL AND attribution = '{}'::jsonb) AS legacy_versions,
              (SELECT publish_state FROM content_items WHERE id = $1) AS state`,
      [item],
    )
    await sc2.query('ROLLBACK')
    await sc2.end()
    check('pre-0009 rows are unadopted (head 0, published NULL) and keep publish_state; versions get {} / NULL', st.unadopted === 2 && st.items === 2 && st.legacy_versions === 1 && st.state === 'published', st)

    const again = runRunner(mUrl, { through: TARGET_FILE })
    check('second runner pass is a no-op (0 applied)', again.status === 0 && /0 applied/.test(again.stdout), again.stdout + again.stderr)
  } catch (err) {
    check('[positive control] unexpected harness error', false, err.stack)
  } finally {
    await dropScratchDb(SUPER, db).catch(() => {})
  }
}

// =============================================================================================
async function main() {
  const roles = await resolveRoles(SUPER, MIGRATE, APP)
  console.log(`[0009] roles: owner=${roles.owner} migrator=${roles.migrator} app=${roles.app}`)
  await partA(roles)
  await partB()
  await partC(roles)
  await partD(roles)
  process.exit(summary())
}

main().catch((err) => {
  console.error('[0009] ERROR', err.stack)
  process.exit(2)
})
