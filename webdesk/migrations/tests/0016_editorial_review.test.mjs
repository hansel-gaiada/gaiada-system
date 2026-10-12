#!/usr/bin/env node
/**
 * WebDesk M5 (M5-W2a, the writers' room) — migration 0016 (editorial_policies, editorial_items,
 * editorial_events, editorial_comments) proven against a real Postgres.
 *
 * Seven parts, one exit code (same shape as 0013_preview_tokens.test.mjs / 0015_submission_attribution.test.mjs):
 *   A. Catalog state of the MAIN database (already migrated through 0016 by the real runner): columns and
 *      their order, types, NOT NULLs, defaults (review OFF by default), every constraint, indexes, the three
 *      RLS facts + one tenant_isolation policy, the owner, and the app role's grants (no DELETE anywhere, no
 *      UPDATE on the append-only events table, column-level UPDATE only on a comment's resolve fields).
 *   B. Behaviour as the app role, in one transaction that is ROLLED BACK: the policy table (defaults, the
 *      collection foreign key, sign-off-needs-review), editorial_items (state set, the in_review / approved
 *      invariants, the approval triple, the SEO pair and snapshot, composite version FKs naming an
 *      immutable version, approved_version surviving a return to draft), events (kind format, note cap, FK),
 *      comments (anchor shape, body bounds, resolve pair, FK).
 *   C. RLS isolation between two tenants on all four tables, each with a positive control; an unset
 *      tenant_ctx reads 0 rows and refuses writes; platform_ctx is NOT an escape.
 *   D. Privileges exercised for real: DELETE and TRUNCATE refused on all four, events are append-only,
 *      a comment's body cannot be rewritten but its resolve fields can, positive controls for the rest.
 *   E. Idempotent re-run: the real runner applies 0 files again, and executing the SQL file a second time
 *      changes nothing (identical catalog snapshots).
 *   F. A scratch database at 0015, then the REAL runner: it applies exactly 0016 and ONLY the intended
 *      catalog changes happen (an exact before/after diff: nothing lost, nothing added outside the four new
 *      tables, so no existing table, and with it nothing /v1 reads, was altered). Rows that exist BEFORE 0016
 *      (items, versions) survive byte-for-byte and read as "no editorial row" (legacy = draft, no author).
 *   G. Static, no database: nothing under webdesk/api/src/delivery/ (the frozen /v1 read path) names an
 *      editorial_ table (design 4.6 / D11).
 *
 * Env (all point at the same cluster):
 *   SUPERUSER_DATABASE_URL  cluster bootstrap identity on the main db (creates/drops scratch dbs)
 *   MIGRATE_DATABASE_URL    webdesk_migrator on the main db
 *   APP_DATABASE_URL        webdesk_app on the main db
 *
 * Run (from webdesk/api, for the same reason as the 0009-0015 files):
 *   node --import tsx ../migrations/tests/0016_editorial_review.test.mjs
 *
 * Needs the Linux gate's Postgres cluster (part G alone needs no database).
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

const TARGET = '0016_editorial_review.sql'
const PREV = '0015_submission_attribution.sql'
const TABLES = ['editorial_policies', 'editorial_items', 'editorial_events', 'editorial_comments']
const HERE = dirname(fileURLToPath(import.meta.url))

const { check, summary } = makeChecker('0016')

// A tenant, site, collection 'post', one item with versions 1..3, as the caller's open transaction on the app role.
async function seed(c, tenantId, label) {
  await setCtx(c, { platform: true })
  await c.query(`INSERT INTO tenants (id, slug, company_ref) VALUES ($1, $2, $3)`, [tenantId, `m5w2a-${label}-${tenantId.slice(0, 8)}`, randomUUID()])
  await setCtx(c, { tenant: tenantId })
  const site = (await one(c, `INSERT INTO sites (tenant_id, kind, name) VALUES ($1, 'astro', $2) RETURNING id`, [tenantId, label])).id
  const col = (await one(c, `INSERT INTO collections (tenant_id, site_id, key) VALUES ($1, $2, 'post') RETURNING id`, [tenantId, site])).id
  const item = (
    await one(
      c,
      `INSERT INTO content_items (tenant_id, site_id, collection_id, locale, slug, localization_group_id, publish_state)
       VALUES ($1, $2, $3, 'en', 'hello', gen_random_uuid(), 'draft') RETURNING id`,
      [tenantId, site, col],
    )
  ).id
  for (const v of [1, 2, 3]) {
    await c.query(
      `INSERT INTO content_versions (tenant_id, content_item_id, version, blocks, seo, publish_state, created_by)
       VALUES ($1, $2, $3, '[]'::jsonb, '{}'::jsonb, 'draft', 'user-1')`,
      [tenantId, item, v],
    )
  }
  return { tenantId, site, item, key: 'post' }
}

const insPolicy = (c, s, over = {}) =>
  attempt(
    c,
    `INSERT INTO editorial_policies (tenant_id, site_id, collection_key, review_required, seo_signoff_required, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING review_required, seo_signoff_required`,
    [s.tenantId, over.site ?? s.site, over.key ?? s.key, over.review ?? false, over.seo ?? false, over.by ?? 'user-1'],
  )

// editorial_items: `over` columns are set by name; the rest take the column defaults.
const insItem = (c, s, over = {}) => {
  const cols = { tenant_id: s.tenantId, site_id: s.site, content_item_id: s.item, ...over }
  const names = Object.keys(cols)
  return attempt(
    c,
    `INSERT INTO editorial_items (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING content_item_id`,
    names.map((n) => cols[n]),
  )
}
const updItem = (c, s, set) => {
  const names = Object.keys(set)
  return attempt(c, `UPDATE editorial_items SET ${names.map((n, i) => `${n} = $${i + 2}`).join(', ')} WHERE content_item_id = $1`, [s.item, ...names.map((n) => set[n])])
}
const insEvent = (c, s, over = {}) =>
  attempt(
    c,
    `INSERT INTO editorial_events (tenant_id, content_item_id, version, kind, actor_sub, note) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [s.tenantId, over.item ?? s.item, over.version === undefined ? 2 : over.version, over.kind ?? 'submitted', over.actor ?? 'user-1', over.note ?? null],
  )
const insComment = (c, s, over = {}) =>
  attempt(
    c,
    `INSERT INTO editorial_comments (tenant_id, content_item_id, version, anchor, body, author_sub) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [s.tenantId, over.item ?? s.item, over.version ?? 2, over.anchor === undefined ? '/fields/title' : over.anchor, over.body ?? 'tighten this', over.author ?? 'user-2'],
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

    const colsOf = async (t) => (await c.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [t])).rows
    const names = (rows) => rows.map((r) => r.column_name).join()
    const by = (rows) => Object.fromEntries(rows.map((r) => [r.column_name, r]))

    const pol = await colsOf('editorial_policies')
    check('editorial_policies: the 7 columns, in order', names(pol) === 'tenant_id,site_id,collection_key,review_required,seo_signoff_required,updated_by,updated_at', names(pol))
    const p = by(pol)
    check(
      'REVIEW IS OFF BY DEFAULT: review_required and seo_signoff_required are boolean NOT NULL DEFAULT false',
      p.review_required.data_type === 'boolean' && p.review_required.is_nullable === 'NO' && p.review_required.column_default === 'false' &&
        p.seo_signoff_required.data_type === 'boolean' && p.seo_signoff_required.is_nullable === 'NO' && p.seo_signoff_required.column_default === 'false',
      [p.review_required, p.seo_signoff_required],
    )

    const itm = await colsOf('editorial_items')
    check(
      'editorial_items: the 16 columns, in order',
      names(itm) === 'content_item_id,tenant_id,site_id,state,author_sub,submitted_version,seo_signed_version,seo_signed_by,seo_snapshot,approved_version,approved_by,approved_at,due_at,planned_publish_at,brief_ref,updated_at',
      names(itm),
    )
    const i = by(itm)
    check('editorial_items: state is NOT NULL DEFAULT draft; the three *_version columns are integer and NULLable', i.state.is_nullable === 'NO' && /'draft'/.test(i.state.column_default ?? '') && ['submitted_version', 'seo_signed_version', 'approved_version'].every((n) => i[n].data_type === 'integer' && i[n].is_nullable === 'YES'), itm)
    check('editorial_items: seo_snapshot is jsonb, due_at / planned_publish_at / approved_at are timestamptz', i.seo_snapshot.data_type === 'jsonb' && ['due_at', 'planned_publish_at', 'approved_at', 'updated_at'].every((n) => i[n].data_type === 'timestamp with time zone'), itm)

    const evt = await colsOf('editorial_events')
    check('editorial_events: the 8 columns, in order', names(evt) === 'id,tenant_id,content_item_id,version,kind,actor_sub,note,created_at', names(evt))
    const cmt = await colsOf('editorial_comments')
    check('editorial_comments: the 10 columns, in order', names(cmt) === 'id,tenant_id,content_item_id,version,anchor,body,author_sub,created_at,resolved_at,resolved_by', names(cmt))
    check('editorial_comments: version, body, author_sub NOT NULL; anchor, resolved_* NULLable', by(cmt).version.is_nullable === 'NO' && by(cmt).body.is_nullable === 'NO' && by(cmt).author_sub.is_nullable === 'NO' && by(cmt).anchor.is_nullable === 'YES' && by(cmt).resolved_at.is_nullable === 'YES', cmt)

    // Constraints.
    const consOf = async (t) => {
      const r = await c.query(`SELECT conname, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY conname`, [`public.${t}`])
      return { rows: r.rows, by: Object.fromEntries(r.rows.map((x) => [x.conname, x])) }
    }
    const fkDefs = (k) => k.rows.filter((r) => r.contype === 'f').map((r) => r.def)

    const kp = await consOf('editorial_policies')
    check('editorial_policies: PRIMARY KEY (site_id, collection_key)', kp.rows.some((r) => r.contype === 'p' && /PRIMARY KEY \(site_id, collection_key\)/.test(r.def)), kp.rows)
    check(
      'editorial_policies: foreign keys to tenants(id), sites(id) and (site_id, collection_key) -> collections(site_id, key)',
      fkDefs(kp).length === 3 && fkDefs(kp).some((d) => /\(tenant_id\) REFERENCES tenants\(id\)/.test(d)) && fkDefs(kp).some((d) => /\(site_id\) REFERENCES sites\(id\)/.test(d)) &&
        /FOREIGN KEY \(site_id, collection_key\) REFERENCES collections\(site_id, key\)/.test(kp.by.editorial_policies_collection_fk?.def ?? ''),
      fkDefs(kp),
    )
    check('editorial_policies: CHECK (NOT seo_signoff_required OR review_required)', /\(NOT seo_signoff_required\) OR review_required/.test(kp.by.editorial_policies_signoff_needs_review_check?.def ?? ''), kp.by.editorial_policies_signoff_needs_review_check)

    const ki = await consOf('editorial_items')
    check('editorial_items: PRIMARY KEY (content_item_id)', ki.rows.some((r) => r.contype === 'p' && /PRIMARY KEY \(content_item_id\)/.test(r.def)), ki.rows)
    check('editorial_items: state CHECK is exactly draft | in_review | changes_requested | approved', ['draft', 'in_review', 'changes_requested', 'approved'].every((s) => (ki.by.editorial_items_state_check?.def ?? '').includes(`'${s}'`)) && (ki.by.editorial_items_state_check?.def.match(/'/g) ?? []).length === 8, ki.by.editorial_items_state_check)
    check(
      'editorial_items: each of submitted_version, seo_signed_version, approved_version is a composite FK (content_item_id, version) -> content_versions (the 0013 shape)',
      ['submitted_version', 'seo_signed_version', 'approved_version'].every((n) => new RegExp(`FOREIGN KEY \\(content_item_id, ${n}\\) REFERENCES content_versions\\(content_item_id, version\\)`).test(ki.by[`editorial_items_${n}_fk`]?.def ?? '')),
      fkDefs(ki),
    )
    check('editorial_items: FKs to content_items(id), tenants(id), sites(id) exist too (6 in all)', fkDefs(ki).length === 6 && fkDefs(ki).some((d) => /\(content_item_id\) REFERENCES content_items\(id\)/.test(d)) && fkDefs(ki).some((d) => /\(tenant_id\) REFERENCES tenants\(id\)/.test(d)) && fkDefs(ki).some((d) => /\(site_id\) REFERENCES sites\(id\)/.test(d)), fkDefs(ki))

    const ke = await consOf('editorial_events')
    check('editorial_events: PRIMARY KEY (id); FKs to tenants, content_items and (content_item_id, version) -> content_versions', ke.rows.some((r) => r.contype === 'p' && /PRIMARY KEY \(id\)/.test(r.def)) && fkDefs(ke).length === 3 && /FOREIGN KEY \(content_item_id, version\) REFERENCES content_versions\(content_item_id, version\)/.test(ke.by.editorial_events_version_fk?.def ?? ''), fkDefs(ke))
    const kc = await consOf('editorial_comments')
    check('editorial_comments: PRIMARY KEY (id); FKs to tenants, content_items and (content_item_id, version) -> content_versions', kc.rows.some((r) => r.contype === 'p' && /PRIMARY KEY \(id\)/.test(r.def)) && fkDefs(kc).length === 3 && /FOREIGN KEY \(content_item_id, version\) REFERENCES content_versions\(content_item_id, version\)/.test(kc.by.editorial_comments_version_fk?.def ?? ''), fkDefs(kc))

    // Indexes.
    const ixOf = async (t) => Object.fromEntries((await c.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`, [t])).rows.map((r) => [r.indexname, r.indexdef]))
    const ixI = await ixOf('editorial_items')
    check('editorial_items: ix_editorial_items_site_state (site_id, state) and the partial ix_editorial_items_site_due (site_id, due_at) WHERE due_at IS NOT NULL', /\(site_id, state\)/.test(ixI.ix_editorial_items_site_state ?? '') && /\(site_id, due_at\)/.test(ixI.ix_editorial_items_site_due ?? '') && /WHERE \(due_at IS NOT NULL\)/.test(ixI.ix_editorial_items_site_due ?? ''), ixI)
    const ixE = await ixOf('editorial_events')
    check('editorial_events: ix_editorial_events_item (content_item_id, created_at)', /\(content_item_id, created_at\)/.test(ixE.ix_editorial_events_item ?? ''), ixE)
    const ixC = await ixOf('editorial_comments')
    check('editorial_comments: ix_editorial_comments_item, and the partial ix_editorial_comments_open WHERE resolved_at IS NULL', /\(content_item_id, created_at\)/.test(ixC.ix_editorial_comments_item ?? '') && /WHERE \(resolved_at IS NULL\)/.test(ixC.ix_editorial_comments_open ?? ''), ixC)
    const ixP = await ixOf('editorial_policies')
    check('a tenant index on every table', !!ixP.ix_editorial_policies_tenant && !!ixI.ix_editorial_items_tenant && !!ixE.ix_editorial_events_tenant && !!ixC.ix_editorial_comments_tenant, [ixP, ixI, ixE, ixC].map(Object.keys))

    // RLS + owner + grants.
    for (const t of TABLES) {
      const rls = await one(
        c,
        `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies, pg_get_userbyid(c.relowner) AS owner
           FROM pg_class c WHERE c.relname = $1 AND c.relnamespace = 'public'::regnamespace`,
        [t],
      )
      check(`${t}: RLS enabled + FORCED + exactly 1 policy (the check-rls-integrity.mjs triple), owned by ${roles.migrator}`, rls.enabled === true && rls.forced === true && rls.policies === 1 && rls.owner === roles.migrator, rls)
      const pl = await one(c, `SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`, [t])
      check(`${t}: policy tenant_isolation FOR ALL on tenant_id = webdesk_tenant_ctx(), USING and WITH CHECK`, pl.policyname === 'tenant_isolation' && pl.cmd === 'ALL' && /tenant_id = webdesk_tenant_ctx\(\)/.test(pl.qual) && /tenant_id = webdesk_tenant_ctx\(\)/.test(pl.with_check), pl)
    }

    const priv = async (t) => {
      const o = {}
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) o[p] = (await one(c, `SELECT has_table_privilege($1, $2, $3) AS ok`, [roles.app, t, p])).ok
      return o
    }
    for (const t of ['editorial_policies', 'editorial_items']) {
      const g = await priv(t)
      check(`${t}: ${roles.app} holds SELECT, INSERT, UPDATE and nothing else`, g.SELECT && g.INSERT && g.UPDATE && !g.DELETE && !g.TRUNCATE && !g.REFERENCES && !g.TRIGGER, g)
    }
    const evDefault = await one(c, `SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'editorial_events' AND column_name = 'created_at'`)
    check('editorial_events.created_at defaults to clock_timestamp() (events written in one transaction still order)', /clock_timestamp\(\)/.test(evDefault.column_default ?? ''), evDefault)
    const ge = await priv('editorial_events')
    check(`editorial_events: ${roles.app} holds SELECT, INSERT only (append-only: no UPDATE, no DELETE)`, ge.SELECT && ge.INSERT && !ge.UPDATE && !ge.DELETE && !ge.TRUNCATE && !ge.REFERENCES && !ge.TRIGGER, ge)
    const gc = await priv('editorial_comments')
    check(`editorial_comments: ${roles.app} holds SELECT, INSERT, and no table-level UPDATE / DELETE`, gc.SELECT && gc.INSERT && !gc.UPDATE && !gc.DELETE && !gc.TRUNCATE && !gc.REFERENCES && !gc.TRIGGER, gc)
    const colUpd = {}
    for (const col of ['resolved_at', 'resolved_by', 'body', 'anchor', 'author_sub', 'version', 'tenant_id']) colUpd[col] = (await one(c, `SELECT has_column_privilege($1, 'editorial_comments', $2, 'UPDATE') AS ok`, [roles.app, col])).ok
    check(`editorial_comments: ${roles.app} may UPDATE exactly resolved_at and resolved_by`, colUpd.resolved_at && colUpd.resolved_by && !colUpd.body && !colUpd.anchor && !colUpd.author_sub && !colUpd.version && !colUpd.tenant_id, colUpd)

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
  console.log('\n== B. constraints and behaviour, as the app role (one transaction, rolled back) ==')
  const c = await connect(APP)
  try {
    await c.query('BEGIN')
    const s = await seed(c, randomUUID(), 'b')
    let r

    // ---- editorial_policies ----
    const bare = await attempt(c, `INSERT INTO editorial_policies (tenant_id, site_id, collection_key) VALUES ($1, $2, 'post') RETURNING review_required, seo_signoff_required, updated_by`, [s.tenantId, s.site])
    check('a policy row with only its key reads back review_required = false, seo_signoff_required = false (review OFF by default)', !bare.err && bare.rows[0].review_required === false && bare.rows[0].seo_signoff_required === false, errSummary(bare))
    r = await insPolicy(c, s)
    check('the same (site, collection) twice is refused by the primary key', r.err?.code === '23505', errSummary(r))
    r = await attempt(c, `UPDATE editorial_policies SET review_required = true, seo_signoff_required = true, updated_by = 'user-9' WHERE site_id = $1 AND collection_key = 'post'`, [s.site])
    check('POSITIVE CONTROL: review + sign-off can be turned on, in place', !r.err && r.rowCount === 1, errSummary(r))
    r = await attempt(c, `UPDATE editorial_policies SET review_required = false WHERE site_id = $1 AND collection_key = 'post'`, [s.site])
    check('turning review off while sign-off stays required is refused (editorial_policies_signoff_needs_review_check)', r.err?.code === '23514' && r.err.constraint === 'editorial_policies_signoff_needs_review_check', errSummary(r))
    r = await attempt(c, `UPDATE editorial_policies SET review_required = false, seo_signoff_required = false WHERE site_id = $1 AND collection_key = 'post'`, [s.site])
    check('turning both off together is fine', !r.err && r.rowCount === 1, errSummary(r))
    r = await insPolicy(c, s, { key: 'no-such-collection' })
    check('a policy for a collection that does not exist on the site is refused (editorial_policies_collection_fk)', r.err?.code === '23503' && r.err.constraint === 'editorial_policies_collection_fk', errSummary(r))
    // A second collection, so the CHECK is reached without first hitting the primary key.
    await c.query(`INSERT INTO collections (tenant_id, site_id, key) VALUES ($1, $2, 'guide')`, [s.tenantId, s.site])
    r = await insPolicy(c, s, { key: 'guide', seo: true, review: false })
    check('INSERT with sign-off required but review not required is refused (the CHECK)', r.err?.code === '23514' && r.err.constraint === 'editorial_policies_signoff_needs_review_check', errSummary(r))
    r = await insPolicy(c, s, { key: 'guide', by: '' })
    check("updated_by '' is refused", r.err?.code === '23514', errSummary(r))
    r = await insPolicy(c, s, { key: 'guide', review: true, seo: true })
    check('control: a collection can be given review + sign-off from the start', !r.err, errSummary(r))

    // ---- editorial_items ----
    r = await insItem(c, s, {})
    check('an item row with only its ids takes the defaults: state draft, no author, no versions', !r.err, errSummary(r))
    const dflt = await one(c, `SELECT state, author_sub, submitted_version, seo_signed_version, approved_version, approved_by, approved_at FROM editorial_items WHERE content_item_id = $1`, [s.item])
    check('defaults read back as draft / NULLs (a legacy item is draft with no author)', dflt.state === 'draft' && Object.entries(dflt).filter(([k]) => k !== 'state').every(([, v]) => v === null), dflt)
    r = await insItem(c, s, {})
    check('a second editorial row for one item is refused (the primary key)', r.err?.code === '23505', errSummary(r))

    r = await updItem(c, s, { state: 'published' })
    check("state 'published' is refused (editorial_items_state_check: publishing is the WS4 projection, not review state)", r.err?.code === '23514' && r.err.constraint === 'editorial_items_state_check', errSummary(r))
    r = await updItem(c, s, { state: 'in_review' })
    check('state in_review with NO submitted version is refused (editorial_items_in_review_needs_version_check)', r.err?.code === '23514' && r.err.constraint === 'editorial_items_in_review_needs_version_check', errSummary(r))
    r = await updItem(c, s, { author_sub: 'user-1', state: 'in_review', submitted_version: 2 })
    check('POSITIVE CONTROL: submit = in_review + submitted_version 2', !r.err && r.rowCount === 1, errSummary(r))
    r = await updItem(c, s, { submitted_version: 9 })
    check('a submitted_version that has no content_versions row is refused by the composite FK', r.err?.code === '23503' && r.err.constraint === 'editorial_items_submitted_version_fk', errSummary(r))
    r = await updItem(c, s, { submitted_version: 0 })
    check('submitted_version 0 is refused (>= 1)', r.err?.code === '23514', errSummary(r))
    r = await updItem(c, s, { state: 'approved' })
    check('state approved with NO approved version is refused (editorial_items_approved_needs_version_check)', r.err?.code === '23514' && r.err.constraint === 'editorial_items_approved_needs_version_check', errSummary(r))
    r = await updItem(c, s, { approved_version: 2 })
    check('an approved_version with no approver or time is refused (editorial_items_approval_triple_check)', r.err?.code === '23514' && r.err.constraint === 'editorial_items_approval_triple_check', errSummary(r))
    r = await updItem(c, s, { approved_by: 'user-3', approved_at: new Date() })
    check('an approver and time with no approved version is refused too', r.err?.code === '23514' && r.err.constraint === 'editorial_items_approval_triple_check', errSummary(r))
    r = await updItem(c, s, { state: 'approved', approved_version: 2, approved_by: 'user-3', approved_at: new Date() })
    check('POSITIVE CONTROL: approve = approved + approved_version 2 + approver + time', !r.err && r.rowCount === 1, errSummary(r))
    r = await updItem(c, s, { approved_version: 7, approved_by: 'user-3', approved_at: new Date() })
    check('an approved_version of a version that does not exist is refused by the composite FK', r.err?.code === '23503' && r.err.constraint === 'editorial_items_approved_version_fk', errSummary(r))
    r = await updItem(c, s, { state: 'draft' })
    const back = await one(c, `SELECT state, approved_version FROM editorial_items WHERE content_item_id = $1`, [s.item])
    check('edit after approval: state returns to draft and approved_version STAYS (still publishable)', !r.err && back.state === 'draft' && back.approved_version === 2, back)

    r = await updItem(c, s, { seo_signed_version: 3 })
    check('a signed version with no signer is refused (editorial_items_seo_pair_check)', r.err?.code === '23514' && r.err.constraint === 'editorial_items_seo_pair_check', errSummary(r))
    r = await updItem(c, s, { seo_signed_by: 'user-4' })
    check('a signer with no signed version is refused', r.err?.code === '23514' && r.err.constraint === 'editorial_items_seo_pair_check', errSummary(r))
    r = await updItem(c, s, { seo_snapshot: JSON.stringify({ score: 90 }) })
    check('a snapshot with no signed version is refused (editorial_items_seo_snapshot_check)', r.err?.code === '23514' && r.err.constraint === 'editorial_items_seo_snapshot_check', errSummary(r))
    r = await updItem(c, s, { seo_signed_version: 3, seo_signed_by: 'user-4', seo_snapshot: JSON.stringify({ score: 90, checks: [] }) })
    check('POSITIVE CONTROL: SEO sign-off = version + signer + snapshot', !r.err && r.rowCount === 1, errSummary(r))
    r = await updItem(c, s, { seo_snapshot: JSON.stringify([1, 2]) })
    check('a snapshot that is not a JSON object is refused', r.err?.code === '23514' && r.err.constraint === 'editorial_items_seo_snapshot_check', errSummary(r))
    r = await updItem(c, s, { seo_snapshot: JSON.stringify({ pad: 'x'.repeat(70000) }) })
    check('a snapshot over 64 KB is refused', r.err?.code === '23514' && r.err.constraint === 'editorial_items_seo_snapshot_check', errSummary(r))
    r = await updItem(c, s, { author_sub: '' })
    check("author_sub '' is refused", r.err?.code === '23514' && r.err.constraint === 'editorial_items_subs_check', errSummary(r))
    r = await updItem(c, s, { brief_ref: 'x'.repeat(201) })
    check('a brief_ref over 200 chars is refused', r.err?.code === '23514' && r.err.constraint === 'editorial_items_brief_ref_check', errSummary(r))
    r = await updItem(c, s, { due_at: new Date(Date.now() + 86400000), planned_publish_at: new Date(Date.now() + 172800000), brief_ref: 'brief:42' })
    check('control: due date, planned publish date and an opaque brief ref are accepted', !r.err && r.rowCount === 1, errSummary(r))
    const orphan = await insItem(c, s, { content_item_id: randomUUID() })
    check('an editorial row for a content item that does not exist is refused by its FK', orphan.err?.code === '23503', errSummary(orphan))

    // ---- editorial_events ----
    r = await insEvent(c, s, { kind: 'submitted', note: 'ready for the SEO pass' })
    check('an event inserts, naming a version', !r.err, errSummary(r))
    r = await insEvent(c, s, { version: null, kind: 'assigned' })
    check('an event with NO version (an assignment) inserts: the composite FK is MATCH SIMPLE', !r.err, errSummary(r))
    for (const [what, kind] of [['an upper-case kind', 'Submitted'], ['a kind with a space', 'request changes'], ['an empty kind', ''], ['a kind starting with a digit', '1x'], ['a kind over 48 chars', 'a'.repeat(49)]]) {
      r = await insEvent(c, s, { kind })
      check(`${what} is refused (editorial_events_kind_check)`, r.err?.code === '23514' && r.err.constraint === 'editorial_events_kind_check', errSummary(r))
    }
    r = await insEvent(c, s, { kind: 'changes_requested', note: 'n'.repeat(2001) })
    check('a note over 2000 chars is refused', r.err?.code === '23514' && r.err.constraint === 'editorial_events_note_check', errSummary(r))
    r = await insEvent(c, s, { kind: 'changes_requested', note: 'n'.repeat(2000) })
    check('a note of exactly 2000 chars is accepted', !r.err, errSummary(r))
    r = await insEvent(c, s, { version: 9 })
    check('an event naming a version that does not exist is refused by the composite FK', r.err?.code === '23503' && r.err.constraint === 'editorial_events_version_fk', errSummary(r))
    r = await insEvent(c, s, { actor: '' })
    check("actor_sub '' is refused", r.err?.code === '23514' && r.err.constraint === 'editorial_events_actor_check', errSummary(r))
    r = await insEvent(c, s, { version: 0 })
    check('version 0 is refused (>= 1)', r.err?.code === '23514', errSummary(r))

    // ---- editorial_comments ----
    r = await insComment(c, s)
    const cid = r.rows?.[0]?.id
    check('a comment inserts, anchored to a JSON pointer in version 2', !r.err && !!cid, errSummary(r))
    for (const [what, anchor] of [['a NULL anchor (the whole item)', null], ['the empty pointer (the whole document)', ''], ['a nested pointer', '/fields/hero/title/0']]) {
      r = await insComment(c, s, { anchor })
      check(`${what} is accepted`, !r.err, errSummary(r))
    }
    r = await insComment(c, s, { anchor: 'fields/title' })
    check('an anchor that is not a JSON pointer (no leading /) is refused (editorial_comments_anchor_check)', r.err?.code === '23514' && r.err.constraint === 'editorial_comments_anchor_check', errSummary(r))
    r = await insComment(c, s, { anchor: '/' + 'a'.repeat(512) })
    check('an anchor over 512 chars is refused', r.err?.code === '23514' && r.err.constraint === 'editorial_comments_anchor_check', errSummary(r))
    r = await insComment(c, s, { anchor: '/' + 'a'.repeat(511) })
    check('an anchor of exactly 512 chars is accepted', !r.err, errSummary(r))
    r = await insComment(c, s, { body: '' })
    check('an empty body is refused (editorial_comments_body_check)', r.err?.code === '23514' && r.err.constraint === 'editorial_comments_body_check', errSummary(r))
    r = await insComment(c, s, { body: 'b'.repeat(4001) })
    check('a body over 4000 chars is refused', r.err?.code === '23514' && r.err.constraint === 'editorial_comments_body_check', errSummary(r))
    r = await insComment(c, s, { body: 'b'.repeat(4000) })
    check('a body of exactly 4000 chars is accepted', !r.err, errSummary(r))
    r = await insComment(c, s, { version: 9 })
    check('a comment on a version that does not exist is refused by the composite FK', r.err?.code === '23503' && r.err.constraint === 'editorial_comments_version_fk', errSummary(r))
    r = await insComment(c, s, { author: '' })
    check("author_sub '' is refused", r.err?.code === '23514' && r.err.constraint === 'editorial_comments_author_check', errSummary(r))
    r = await attempt(c, `UPDATE editorial_comments SET resolved_at = now() WHERE id = $1`, [cid])
    check('resolved_at without resolved_by is refused (editorial_comments_resolved_pair_check)', r.err?.code === '23514' && r.err.constraint === 'editorial_comments_resolved_pair_check', errSummary(r))
    r = await attempt(c, `UPDATE editorial_comments SET resolved_at = now(), resolved_by = 'user-5' WHERE id = $1`, [cid])
    check('POSITIVE CONTROL: resolve = resolved_at + resolved_by', !r.err && r.rowCount === 1, errSummary(r))
    r = await attempt(c, `UPDATE editorial_comments SET resolved_at = NULL, resolved_by = NULL WHERE id = $1`, [cid])
    check('re-opening a comment (both NULL) is allowed', !r.err && r.rowCount === 1, errSummary(r))
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    await c.end()
  }
}

// =============================================================================================
// C. RLS isolation between two tenants, all four tables
// =============================================================================================
async function partC() {
  console.log('\n== C. RLS isolation, two tenants (one transaction, rolled back) ==')
  const c = await connect(APP)
  try {
    await c.query('BEGIN')
    const mk = async (label) => {
      const s = await seed(c, randomUUID(), label)
      await insPolicy(c, s, { review: true })
      await insItem(c, s, { author_sub: 'user-1' })
      const ev = (await insEvent(c, s)).rows[0].id
      const cm = (await insComment(c, s)).rows[0].id
      return { ...s, ev, cm }
    }
    const A = await mk('rls-a')
    const B = await mk('rls-b')
    const count = async (sql, params = []) => (await one(c, sql, params)).n
    const reads = {
      editorial_policies: [`SELECT count(*)::int AS n FROM editorial_policies WHERE site_id = ANY($1)`, [[A.site, B.site]]],
      editorial_items: [`SELECT count(*)::int AS n FROM editorial_items WHERE content_item_id = ANY($1)`, [[A.item, B.item]]],
      editorial_events: [`SELECT count(*)::int AS n FROM editorial_events WHERE id = ANY($1)`, [[A.ev, B.ev]]],
      editorial_comments: [`SELECT count(*)::int AS n FROM editorial_comments WHERE id = ANY($1)`, [[A.cm, B.cm]]],
    }

    await setCtx(c, { tenant: A.tenantId })
    for (const t of TABLES) {
      const n = await count(...reads[t])
      check(`${t}: POSITIVE CONTROL, tenant A sees exactly its own row (1 of 2 seeded)`, n === 1, n)
    }
    // Cross-tenant writes as A.
    let r = await insPolicy(c, B, { key: 'post' })
    check("editorial_policies: A cannot INSERT into B's site (WITH CHECK 42501, before the duplicate key)", r.err?.code === '42501', errSummary(r))
    r = await attempt(c, `UPDATE editorial_policies SET review_required = false WHERE site_id = $1`, [B.site])
    check("editorial_policies: A's UPDATE of B's row matches 0 rows", !r.err && r.rowCount === 0, errSummary(r))
    r = await insItem(c, B, { content_item_id: B.item })
    check("editorial_items: A cannot INSERT a row for B's tenant (42501)", r.err?.code === '42501', errSummary(r))
    r = await updItem(c, B, { state: 'draft' })
    check("editorial_items: A's UPDATE of B's row matches 0 rows", !r.err && r.rowCount === 0, errSummary(r))
    r = await attempt(c, `UPDATE editorial_items SET tenant_id = $2 WHERE content_item_id = $1`, [A.item, B.tenantId])
    check('editorial_items: A cannot hand its own row to B (WITH CHECK, 42501)', r.err?.code === '42501', errSummary(r))
    r = await insEvent(c, B)
    check("editorial_events: A cannot INSERT an event for B's tenant (42501)", r.err?.code === '42501', errSummary(r))
    r = await insComment(c, B)
    check("editorial_comments: A cannot INSERT a comment for B's tenant (42501)", r.err?.code === '42501', errSummary(r))
    r = await attempt(c, `UPDATE editorial_comments SET resolved_at = now(), resolved_by = 'x' WHERE id = $1`, [B.cm])
    check("editorial_comments: A's resolve of B's comment matches 0 rows", !r.err && r.rowCount === 0, errSummary(r))

    await setCtx(c, { tenant: B.tenantId })
    for (const t of TABLES) {
      const n = await count(...reads[t])
      check(`${t}: POSITIVE CONTROL, tenant B sees exactly its own row, untouched by A's attempts`, n === 1, n)
    }
    const bStill = await one(c, `SELECT state, (SELECT review_required FROM editorial_policies WHERE site_id = $2) AS review, (SELECT resolved_at FROM editorial_comments WHERE id = $3) AS resolved FROM editorial_items WHERE content_item_id = $1`, [B.item, B.site, B.cm])
    check("tenant B's rows were not changed by A's attempts", bStill.state === 'draft' && bStill.review === true && bStill.resolved === null, bStill)

    await setCtx(c, {})
    for (const t of TABLES) {
      const n = await count(...reads[t])
      check(`${t}: an UNSET tenant context sees ZERO rows (fail-closed, no error)`, n === 0, n)
    }
    r = await insEvent(c, A)
    check('an UNSET tenant context cannot INSERT (WITH CHECK, 42501)', r.err?.code === '42501', errSummary(r))
    await setCtx(c, { platform: true })
    for (const t of TABLES) {
      const n = await count(...reads[t])
      check(`${t}: platform_ctx is no escape hatch (single-mode policy): 0 rows`, n === 0, n)
    }
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    await c.end()
  }
}

// =============================================================================================
// D. Privileges, exercised for real
// =============================================================================================
async function partD(roles) {
  console.log('\n== D. DELETE / TRUNCATE refused; events append-only; comment edits limited (as the app role) ==')
  const c = await connect(APP)
  try {
    await c.query('BEGIN')
    const s = await seed(c, randomUUID(), 'd')
    await insPolicy(c, s, { review: true })
    await insItem(c, s, { author_sub: 'user-1' })
    const ev = (await insEvent(c, s)).rows[0].id
    const cm = (await insComment(c, s)).rows[0].id
    let r
    for (const t of TABLES) {
      r = await attempt(c, `DELETE FROM ${t} WHERE tenant_id = $1`, [s.tenantId])
      check(`${t}: DELETE -> 42501 permission denied`, r.err?.code === '42501', errSummary(r))
      r = await attempt(c, `TRUNCATE ${t}`)
      check(`${t}: TRUNCATE -> 42501 permission denied`, r.err?.code === '42501', errSummary(r))
      r = await attempt(c, `SELECT count(*) FROM ${t}`)
      check(`${t}: POSITIVE CONTROL, SELECT is allowed`, !r.err, errSummary(r))
    }
    r = await attempt(c, `UPDATE editorial_events SET note = 'rewritten history' WHERE id = $1`, [ev])
    check('editorial_events: UPDATE -> 42501 (history cannot be rewritten)', r.err?.code === '42501', errSummary(r))
    r = await attempt(c, `UPDATE editorial_comments SET body = 'rewritten' WHERE id = $1`, [cm])
    check("editorial_comments: UPDATE of body -> 42501 (a comment's words cannot change)", r.err?.code === '42501', errSummary(r))
    r = await attempt(c, `UPDATE editorial_comments SET author_sub = 'someone-else' WHERE id = $1`, [cm])
    check('editorial_comments: UPDATE of author_sub -> 42501', r.err?.code === '42501', errSummary(r))
    r = await attempt(c, `UPDATE editorial_comments SET resolved_at = now(), resolved_by = 'user-5' WHERE id = $1`, [cm])
    check('POSITIVE CONTROL: editorial_comments resolve UPDATE (resolved_at, resolved_by) is allowed', !r.err && r.rowCount === 1, errSummary(r))
    r = await attempt(c, `UPDATE editorial_policies SET review_required = false WHERE site_id = $1`, [s.site])
    check('POSITIVE CONTROL: editorial_policies UPDATE is allowed', !r.err && r.rowCount === 1, errSummary(r))
    r = await updItem(c, s, { state: 'draft' })
    check('POSITIVE CONTROL: editorial_items UPDATE is allowed', !r.err && r.rowCount === 1, errSummary(r))
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    await c.end()
  }
  const m = await connect(MIGRATE)
  try {
    const mig = (await one(m, `SELECT has_table_privilege($1, 'editorial_events', 'DELETE') AS ok`, [roles.migrator])).ok
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
    const again = runRunner(MIGRATE)
    check('the real runner then applies 0 files', again.status === 0 && /0 applied/.test(again.stdout), again.stdout + again.stderr)
  } finally {
    await m.end()
  }
}

// =============================================================================================
// F. Scratch database at 0015 -> the real runner
// =============================================================================================
const keyed = (rows) => rows.map((s) => JSON.parse(s))

async function partF(roles) {
  console.log('\n== F. scratch database at 0015 -> the real runner ==')
  const db = 'm5_0016_pos'
  try {
    await createScratchDb(SUPER, db, roles)
    const url = withDb(MIGRATE, db)
    const applied = await applyThrough(url, TARGET)
    check(`[pos] scratch db built through ${PREV} (${applied.length} files, none of them 0016)`, applied.includes(PREV) && !applied.includes(TARGET), applied)

    // Rows that exist BEFORE 0016 (committed as the migrator, under the right GUCs).
    const tenantId = randomUUID()
    const m = await connect(url)
    let itemId
    try {
      await m.query('BEGIN')
      await setCtx(m, { platform: true })
      await m.query(`INSERT INTO tenants (id, slug, company_ref) VALUES ($1, $2, $3)`, [tenantId, `m5w2a-pre-${tenantId.slice(0, 8)}`, randomUUID()])
      await setCtx(m, { tenant: tenantId })
      const site = (await one(m, `INSERT INTO sites (tenant_id, kind, name) VALUES ($1, 'astro', 's') RETURNING id`, [tenantId])).id
      const col = (await one(m, `INSERT INTO collections (tenant_id, site_id, key) VALUES ($1, $2, 'post') RETURNING id`, [tenantId, site])).id
      itemId = (
        await one(
          m,
          `INSERT INTO content_items (tenant_id, site_id, collection_id, locale, slug, localization_group_id, publish_state, head_version, published_version, last_published_at, last_published_by)
           VALUES ($1, $2, $3, 'en', 'legacy', gen_random_uuid(), 'published', 2, 2, now(), 'user-1') RETURNING id`,
          [tenantId, site, col],
        )
      ).id
      for (const v of [1, 2]) {
        await m.query(`INSERT INTO content_versions (tenant_id, content_item_id, version, blocks, seo, publish_state, created_by) VALUES ($1, $2, $3, '[]'::jsonb, '{}'::jsonb, 'published', 'user-1')`, [tenantId, itemId, v])
      }
      await m.query('COMMIT')
    } finally {
      await m.end()
    }
    const readRows = async (u) => {
      const c = await connect(u)
      try {
        await c.query('BEGIN')
        await setCtx(c, { tenant: tenantId })
        const out = {
          item: (await c.query(`SELECT * FROM content_items WHERE id = $1`, [itemId])).rows,
          versions: (await c.query(`SELECT * FROM content_versions WHERE content_item_id = $1 ORDER BY version`, [itemId])).rows,
        }
        await c.query('ROLLBACK')
        return JSON.stringify(out)
      } finally {
        await c.end()
      }
    }
    const rowsBefore = await readRows(url)

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
    check('[pos] the real runner applies exactly 0016 (exit 0, 1 applied)', run.status === 0 && /1 applied/.test(run.stdout), run.stdout + run.stderr)
    const after = await snap()

    check('[pos] pre-existing content_items and content_versions rows are byte-for-byte unchanged (additive, no backfill DML)', (await readRows(url)) === rowsBefore)
    const c = await connect(url)
    try {
      await c.query('BEGIN')
      await setCtx(c, { tenant: tenantId })
      const none = await one(c, `SELECT (SELECT count(*)::int FROM editorial_items) AS items, (SELECT count(*)::int FROM editorial_policies) AS policies, (SELECT count(*)::int FROM editorial_events) AS events, (SELECT count(*)::int FROM editorial_comments) AS comments`)
      await c.query('ROLLBACK')
      check('[pos] the legacy item has NO editorial row, and no table was backfilled (legacy = draft, no author, review off)', Object.values(none).every((n) => n === 0), none)
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
    for (const k of Object.keys(SNAPSHOT_SQL)) check(`[pos] ${k}: nothing lost (no existing object altered)`, diff[k].lost.length === 0, diff[k].lost)
    const onNew = (r) => TABLES.includes(r[0])
    const perTable = (rows) => Object.fromEntries(TABLES.map((t) => [t, rows.filter((r) => r[0] === t).length]))
    check(
      '[pos] columns: 41 added (7 + 16 + 8 + 10), ALL on the four new tables, none on an existing one',
      diff.columns.added.length === 41 && diff.columns.added.every(onNew) && JSON.stringify(perTable(diff.columns.added)) === JSON.stringify({ editorial_policies: 7, editorial_items: 16, editorial_events: 8, editorial_comments: 10 }),
      perTable(diff.columns.added),
    )
    check('[pos] constraints: all added constraints are on the four new tables', diff.constraints.added.length > 0 && diff.constraints.added.every(onNew), diff.constraints.added.filter((r) => !onNew(r)))
    check('[pos] indexes: 13 added (pk + secondary), all on the new tables', diff.indexes.added.length === 13 && diff.indexes.added.every(onNew), diff.indexes.added)
    check('[pos] policies: exactly one tenant_isolation per new table', diff.policies.added.length === 4 && diff.policies.added.every((p) => onNew(p) && p[1] === 'tenant_isolation') && new Set(diff.policies.added.map((p) => p[0])).size === 4, diff.policies.added)
    check('[pos] triggers: none added (no trigger on any table, new or old)', diff.triggers.added.length === 0, diff.triggers.added)
    const g = (t) => diff.grants.added.filter((x) => x[0] === t && x[1] === roles.app).map((x) => x[2]).sort().join()
    check(
      `[pos] grants: only on the new tables; ${roles.app} gets SELECT+INSERT+UPDATE on policies and items, SELECT+INSERT on events and comments`,
      diff.grants.added.every(onNew) && g('editorial_policies') === 'INSERT,SELECT,UPDATE' && g('editorial_items') === 'INSERT,SELECT,UPDATE' && g('editorial_events') === 'INSERT,SELECT' && g('editorial_comments') === 'INSERT,SELECT',
      diff.grants.added,
    )
    check('[pos] rls: exactly the four new tables arrive enabled + forced', diff.rls.added.length === 4 && diff.rls.added.every((r) => onNew(r) && r[1] === true && r[2] === true), diff.rls.added)
    const again = runRunner(url, { through: TARGET })
    check('[pos] a second pass is a no-op (0 applied)', again.status === 0 && /0 applied/.test(again.stdout), again.stdout + again.stderr)
  } finally {
    await dropScratchDb(SUPER, db).catch(() => {})
  }
}

// =============================================================================================
// G. Static: the frozen /v1 read path never names an editorial_ table (design 4.6, D11)
// =============================================================================================
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}
function partG() {
  console.log('\n== G. static: nothing under webdesk/api/src/delivery/ names editorial_ ==')
  const root = join(HERE, '..', '..', 'api', 'src', 'delivery')
  const files = walk(root).filter((f) => /\.(ts|mts|cts|js|mjs|sql)$/.test(f))
  check(`the delivery tree is readable (${files.length} source files scanned)`, files.length > 0, root)
  const hits = files.filter((f) => /editorial_/i.test(readFileSync(f, 'utf8')))
  check('no file under delivery/ contains "editorial_" (the frozen read SQL never joins review state)', hits.length === 0, hits)
}

// =============================================================================================
partG()
const roles = await resolveRoles(SUPER, MIGRATE, APP)
await partA(roles)
await partB()
await partC()
await partD(roles)
await partE()
await partF(roles)
process.exit(summary())
