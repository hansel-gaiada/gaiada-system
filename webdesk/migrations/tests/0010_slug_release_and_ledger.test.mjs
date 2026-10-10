#!/usr/bin/env node
/**
 * WSK-D51 — migration 0010 (a soft-deleted item releases its slug; the runtime role loses the
 * migration ledger) proven against a real Postgres.
 *
 * Four parts, one exit code:
 *   A. Catalog state of the MAIN database (already migrated through 0010 by the real runner): the
 *      old table-wide UNIQUE is gone, the partial unique index is there, the app role's grants on
 *      schema_migrations are all false (the migrator's are all true), nothing else lost a grant,
 *      and a second runner pass applies 0 files.
 *   B. Behaviour as the app role, inside one transaction that is ROLLED BACK: two LIVE items with
 *      one (collection, locale, slug) are refused naming ux_content_items_slug_live (with controls
 *      that the legitimate neighbours are accepted); after a soft delete the slug is free; two
 *      soft-deleted rows coexist; bringing a soft-deleted row back (clearing deleted_at) onto a slug
 *      a live row holds is refused by the same index, and succeeds when nothing holds the slug.
 *   C. The same privileges exercised for real: the app role's SELECT/INSERT/UPDATE/DELETE/TRUNCATE
 *      on schema_migrations are each refused with 42501.
 *   D. Scratch databases stopped at 0009, then the REAL runner (staged through 0010 so later files
 *      do not blur the result): a populated database takes 0010 and ONLY the intended catalog
 *      changes happen (exact before/after diff); the constraint's name is resolved from the catalog
 *      (a renamed constraint is still found and dropped); zero constraints or two constraints make
 *      the runner fail loudly with nothing applied.
 *
 * Env (all point at the same cluster):
 *   SUPERUSER_DATABASE_URL  cluster bootstrap identity on the main db (creates/drops scratch dbs)
 *   MIGRATE_DATABASE_URL    webdesk_migrator on the main db
 *   APP_DATABASE_URL        webdesk_app on the main db
 *
 * Run (from webdesk/):  node migrations/tests/0010_slug_release_and_ledger.test.mjs
 */
import { randomUUID } from 'node:crypto'
import {
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
  seedTenant,
  setCtx,
  snapshot,
  withDb,
} from './0009_helpers.mjs'

requireEnv(['SUPERUSER_DATABASE_URL', 'MIGRATE_DATABASE_URL', 'APP_DATABASE_URL'])
const SUPER = process.env.SUPERUSER_DATABASE_URL
const MIGRATE = process.env.MIGRATE_DATABASE_URL
const APP = process.env.APP_DATABASE_URL

const TARGET = '0010_slug_release_and_ledger.sql'
const OLD_CONSTRAINT = 'content_items_collection_id_locale_slug_key'
const NEW_INDEX = 'ux_content_items_slug_live'

const { check, summary } = makeChecker('0010')

// =============================================================================================
// A. Catalog state of the main database
// =============================================================================================
async function partA(roles) {
  console.log('\n== A. catalog state (main db) ==')
  const c = await connect(MIGRATE)
  try {
    const ledger = await one(c, `SELECT count(*)::int AS n FROM schema_migrations WHERE name = $1`, [TARGET])
    check(`ledger records ${TARGET} exactly once`, ledger.n === 1, ledger)

    const uniq = await c.query(
      `SELECT c.conname FROM pg_constraint c
        WHERE c.conrelid = 'public.content_items'::regclass AND c.contype = 'u'
          AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
                 FROM unnest(c.conkey) AS k(attnum) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
              = ARRAY['collection_id','locale','slug']::text[]`,
    )
    check('no table-wide UNIQUE (collection_id, locale, slug) remains on content_items', uniq.rows.length === 0, uniq.rows)
    const oldIdx = await one(c, `SELECT count(*)::int AS n FROM pg_class WHERE relname = $1`, [OLD_CONSTRAINT])
    check(`the old constraint's backing index ${OLD_CONSTRAINT} is gone`, oldIdx.n === 0, oldIdx)

    const idx = await c.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'content_items'
        AND indexname = ANY($1) ORDER BY indexname`,
      [[NEW_INDEX, 'ux_content_items_group_locale']],
    )
    for (const r of idx.rows) console.log(`        ${r.indexdef}`)
    const ix = Object.fromEntries(idx.rows.map((r) => [r.indexname, r.indexdef]))
    check(
      `${NEW_INDEX}: UNIQUE (collection_id, locale, slug) WHERE deleted_at IS NULL`,
      /UNIQUE INDEX .* \(collection_id, locale, slug\) WHERE \(deleted_at IS NULL\)/.test(ix[NEW_INDEX] ?? ''),
      ix[NEW_INDEX],
    )
    check('0009 ux_content_items_group_locale is untouched', /\(site_id, localization_group_id, locale\) WHERE \(deleted_at IS NULL\)/.test(ix.ux_content_items_group_locale ?? ''), ix.ux_content_items_group_locale)

    // The ledger's grants. has_table_privilege is the catalog's own answer (it follows role
    // membership and PUBLIC), so a grant that arrived by any route would show.
    const privs = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
    const app = {}
    const mig = {}
    for (const p of privs) {
      app[p] = (await one(c, `SELECT has_table_privilege($1, 'schema_migrations', $2) AS ok`, [roles.app, p])).ok
      mig[p] = (await one(c, `SELECT has_table_privilege($1, 'schema_migrations', $2) AS ok`, [roles.migrator, p])).ok
    }
    console.log(`        ${roles.app} on schema_migrations: ${JSON.stringify(app)}`)
    check(`${roles.app} has NO INSERT on schema_migrations`, app.INSERT === false, app)
    check(`${roles.app} has NO UPDATE on schema_migrations`, app.UPDATE === false, app)
    check(`${roles.app} has NO DELETE on schema_migrations`, app.DELETE === false, app)
    check(`${roles.app} has NO TRUNCATE on schema_migrations`, app.TRUNCATE === false, app)
    check(`${roles.app} has no SELECT/REFERENCES/TRIGGER either (REVOKE ALL)`, !app.SELECT && !app.REFERENCES && !app.TRIGGER, app)
    check(`POSITIVE CONTROL: ${roles.migrator} (the owner) still holds every right`, privs.every((p) => mig[p] === true), mig)
    const acl = await one(c, `SELECT relacl::text AS acl FROM pg_class WHERE relname = 'schema_migrations' AND relnamespace = 'public'::regnamespace`)
    check(`the table's ACL does not mention ${roles.app}`, !String(acl.acl).includes(roles.app), acl)

    // Not a blanket revoke: every OTHER public base table keeps the app role's SELECT.
    const lacking = await c.query(
      `SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
          AND NOT has_table_privilege($1, c.oid, 'SELECT') ORDER BY 1`,
      [roles.app],
    )
    check(`schema_migrations is the ONLY public table ${roles.app} cannot SELECT`, lacking.rows.length === 1 && lacking.rows[0].relname === 'schema_migrations', lacking.rows)
    const ci = await one(c, `SELECT has_table_privilege($1, 'content_items', 'SELECT,INSERT,UPDATE,DELETE') AS ok`, [roles.app])
    check(`${roles.app} keeps full DML on content_items`, ci.ok === true, ci)

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
  console.log('\n== B. slug release, as the app role (one transaction, rolled back) ==')
  const c = await connect(APP)
  const A = randomUUID()
  try {
    await c.query('BEGIN')
    await setCtx(c, { platform: true })
    await c.query(`INSERT INTO tenants (id, slug, company_ref) VALUES ($1, $2, $3)`, [A, `wsk-d51-${A.slice(0, 8)}`, randomUUID()])
    await setCtx(c, { tenant: A })
    const site = (await one(c, `INSERT INTO sites (tenant_id, kind, name) VALUES ($1, 'astro', 'd51') RETURNING id`, [A])).id
    const colA = (await one(c, `INSERT INTO collections (tenant_id, site_id, key) VALUES ($1, $2, 'page') RETURNING id`, [A, site])).id
    const colB = (await one(c, `INSERT INTO collections (tenant_id, site_id, key) VALUES ($1, $2, 'post') RETURNING id`, [A, site])).id

    const ins = (col, locale, slug) =>
      attempt(c, `INSERT INTO content_items (tenant_id, site_id, collection_id, locale, slug, localization_group_id) VALUES ($1, $2, $3, $4, $5, gen_random_uuid()) RETURNING id`, [A, site, col, locale, slug])
    const softDelete = (id) => attempt(c, `UPDATE content_items SET deleted_at = now() WHERE id = $1`, [id])
    const liveCount = async (col, locale, slug) =>
      (await one(c, `SELECT count(*)::int AS n FROM content_items WHERE collection_id = $1 AND locale = $2 AND slug = $3 AND deleted_at IS NULL`, [col, locale, slug])).n

    let r = await ins(colA, 'en', 'home')
    const first = r.rows?.[0]?.id
    check('first live (page, en, home) accepted', !r.err && !!first, errSummary(r))

    r = await ins(colA, 'en', 'home')
    check(
      'TWO LIVE items with the same (collection, locale, slug) are refused, naming ux_content_items_slug_live',
      r.err?.code === '23505' && r.err.constraint === NEW_INDEX && new RegExp(NEW_INDEX).test(r.err.message),
      errSummary(r),
    )
    r = await ins(colA, 'id', 'home')
    check('control: the same slug in another LOCALE is accepted', !r.err, errSummary(r))
    r = await ins(colB, 'en', 'home')
    check('control: the same slug in another COLLECTION is accepted', !r.err, errSummary(r))

    r = await softDelete(first)
    check('soft delete of the first item', !r.err && r.rowCount === 1, errSummary(r))
    r = await ins(colA, 'en', 'home')
    const second = r.rows?.[0]?.id
    check('after the soft delete a NEW live item with that slug inserts (the slug was released)', !r.err && !!second, errSummary(r))
    check('exactly one live (page, en, home) row, the new one', (await liveCount(colA, 'en', 'home')) === 1)

    r = await softDelete(second)
    check('soft delete of the second item', !r.err && r.rowCount === 1, errSummary(r))
    const both = await one(c, `SELECT count(*)::int AS n FROM content_items WHERE collection_id = $1 AND locale = 'en' AND slug = 'home' AND deleted_at IS NOT NULL`, [colA])
    check('TWO soft-deleted rows with the same slug coexist', both.n === 2, both)
    r = await ins(colA, 'en', 'home')
    const third = r.rows?.[0]?.id
    check('and a live item can still take the slug beside the two soft-deleted ones', !r.err && !!third, errSummary(r))

    // Bringing a soft-deleted row back (the DB-level backstop for any undelete path).
    r = await attempt(c, `UPDATE content_items SET deleted_at = NULL WHERE id = $1`, [first])
    check(
      'clearing deleted_at on a row whose slug a LIVE row now holds is refused by ux_content_items_slug_live',
      r.err?.code === '23505' && r.err.constraint === NEW_INDEX,
      errSummary(r),
    )
    r = await softDelete(third)
    r = await attempt(c, `UPDATE content_items SET deleted_at = NULL WHERE id = $1`, [first])
    check('POSITIVE CONTROL: with no live holder the soft-deleted row can be brought back', !r.err && r.rowCount === 1, errSummary(r))
    check('exactly one live (page, en, home) row again', (await liveCount(colA, 'en', 'home')) === 1)

    // 0009's group/locale rule is unaffected: it still keys on (site, group, locale), not on slug.
    const g = randomUUID()
    r = await attempt(c, `INSERT INTO content_items (tenant_id, site_id, collection_id, locale, slug, localization_group_id) VALUES ($1,$2,$3,'en','twin-1',$4)`, [A, site, colA, g])
    r = await attempt(c, `INSERT INTO content_items (tenant_id, site_id, collection_id, locale, slug, localization_group_id) VALUES ($1,$2,$3,'en','twin-2',$4)`, [A, site, colA, g])
    check('0009 ux_content_items_group_locale still refuses a second live (site, group, locale)', r.err?.code === '23505' && r.err.constraint === 'ux_content_items_group_locale', errSummary(r))
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    await c.end()
  }
}

// =============================================================================================
// C. The ledger, exercised for real as the app role
// =============================================================================================
async function partC() {
  console.log('\n== C. schema_migrations as the app role (every verb refused) ==')
  const c = await connect(APP)
  try {
    await c.query('BEGIN')
    for (const [verb, sql] of [
      ['SELECT', `SELECT count(*) FROM schema_migrations`],
      ['INSERT', `INSERT INTO schema_migrations (name) VALUES ('0999_forged.sql')`],
      ['UPDATE', `UPDATE schema_migrations SET name = name`],
      ['DELETE', `DELETE FROM schema_migrations`],
      ['TRUNCATE', `TRUNCATE schema_migrations`],
    ]) {
      const r = await attempt(c, sql)
      check(`${verb} on schema_migrations -> 42501 permission denied`, r.err?.code === '42501', errSummary(r))
    }
    const ok = await attempt(c, `SELECT 1 FROM content_items LIMIT 1`)
    check('POSITIVE CONTROL: the same role still reads content_items (no blanket lock-out)', !ok.err, errSummary(ok))
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    await c.end()
  }
}

// =============================================================================================
// D. Scratch databases stopped at 0009, then the real runner
// =============================================================================================
const keyed = (rows) => rows.map((s) => JSON.parse(s))

async function seedLive(m, { site, col, t }, slugs) {
  await m.query('BEGIN')
  await setCtx(m, { tenant: t })
  for (const [locale, slug] of slugs) {
    await m.query(
      `INSERT INTO content_items (tenant_id, site_id, collection_id, locale, slug, localization_group_id, publish_state)
       VALUES ($1, $2, $3, $4, $5, gen_random_uuid(), 'published')`,
      [t, site, col, locale, slug],
    )
  }
  await m.query('COMMIT')
}

async function stateOf(url) {
  const c = await connect(url)
  try {
    return await one(
      c,
      `SELECT (SELECT count(*)::int FROM schema_migrations WHERE name = $1) AS ledger,
              (SELECT count(*)::int FROM pg_class WHERE relname = $2) AS new_index,
              (SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'public.content_items'::regclass AND contype = 'u') AS uniques`,
      [TARGET, NEW_INDEX],
    )
  } finally {
    await c.end()
  }
}

async function partD(roles) {
  console.log('\n== D. scratch databases at 0009 -> the real runner ==')
  const dbs = ['wsk_d51_pos', 'wsk_d51_ren', 'wsk_d51_none', 'wsk_d51_two']
  try {
    // ---- D1: a populated database takes 0010; only the intended catalog changes --------------
    {
      const db = dbs[0]
      console.log(`\n-- positive control: populated 0009 db (${db}) --`)
      await createScratchDb(SUPER, db, roles)
      const url = withDb(MIGRATE, db)
      const applied = await applyThrough(url, TARGET)
      check(`[pos] scratch db built at 0001..0009 (${applied.length} files)`, applied.length === 9 && applied.at(-1).startsWith('0009_'), applied)
      const m = await connect(url)
      let s
      try {
        s = await seedTenant(m)
        await seedLive(m, s, [['en', 'home'], ['en', 'about'], ['id', 'home']])
      } finally {
        await m.end()
      }
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
      check('[pos] the real runner applies exactly 0010 (exit 0, 1 applied)', run.status === 0 && /1 applied/.test(run.stdout), run.stdout + run.stderr)
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
      check(
        '[pos] constraints: exactly the old UNIQUE is lost, nothing is added',
        diff.constraints.lost.length === 1 &&
          diff.constraints.lost[0][0] === 'content_items' &&
          diff.constraints.lost[0][1] === OLD_CONSTRAINT &&
          /UNIQUE \(collection_id, locale, slug\)/.test(diff.constraints.lost[0][2]) &&
          diff.constraints.added.length === 0,
        diff.constraints,
      )
      check(
        `[pos] indexes: ${NEW_INDEX} is added; the old constraint's backing index is lost; nothing else`,
        diff.indexes.added.length === 1 &&
          diff.indexes.added[0][1] === NEW_INDEX &&
          /WHERE \(deleted_at IS NULL\)/.test(diff.indexes.added[0][2]) &&
          diff.indexes.lost.length === 1 &&
          diff.indexes.lost[0][1] === OLD_CONSTRAINT,
        diff.indexes,
      )
      const lostGrants = diff.grants.lost
      check(
        `[pos] grants: only ${roles.app}'s four DML rights on schema_migrations are lost; nothing added`,
        diff.grants.added.length === 0 &&
          lostGrants.length === 4 &&
          lostGrants.every((g) => g[0] === 'schema_migrations' && g[1] === roles.app) &&
          ['DELETE', 'INSERT', 'SELECT', 'UPDATE'].join() === lostGrants.map((g) => g[2]).sort().join(),
        diff.grants,
      )
      for (const k of ['policies', 'columns', 'rls', 'triggers']) {
        check(`[pos] ${k}: unchanged (nothing added or lost)`, diff[k].added.length === 0 && diff[k].lost.length === 0, diff[k])
      }
      const st = await (async () => {
        const c2 = await connect(url)
        try {
          await c2.query('BEGIN')
          await setCtx(c2, { tenant: s.t })
          const r = await one(c2, `SELECT count(*)::int AS n, count(*) FILTER (WHERE deleted_at IS NULL)::int AS live FROM content_items`)
          await c2.query('ROLLBACK')
          return r
        } finally {
          await c2.end()
        }
      })()
      check('[pos] the 3 seeded items survive, all live', st.n === 3 && st.live === 3, st)
      const again = runRunner(url, { through: TARGET })
      check('[pos] a second pass is a no-op (0 applied)', again.status === 0 && /0 applied/.test(again.stdout), again.stdout + again.stderr)
    }

    // ---- D2: the constraint name is resolved, not assumed --------------------------------------
    {
      const db = dbs[1]
      console.log(`\n-- the name is resolved from the catalog: constraint renamed (${db}) --`)
      await createScratchDb(SUPER, db, roles)
      const url = withDb(MIGRATE, db)
      await applyThrough(url, TARGET)
      const m = await connect(url)
      try {
        await m.query(`ALTER TABLE content_items RENAME CONSTRAINT ${OLD_CONSTRAINT} TO restored_from_dump_slug_uq`)
      } finally {
        await m.end()
      }
      const run = runRunner(url, { through: TARGET })
      console.log(`        runner exit=${run.status}: ${(run.stdout + run.stderr).trim().split('\n').join(' | ')}`)
      const st = await stateOf(url)
      check('[renamed] the runner still applies 0010 (exit 0)', run.status === 0 && /1 applied/.test(run.stdout), run.stdout + run.stderr)
      check('[renamed] the renamed constraint was found and dropped; the partial index exists', st.ledger === 1 && st.new_index === 1 && st.uniques === 0, st)
    }

    // ---- D3: no such constraint -> loud failure, nothing applied -------------------------------
    {
      const db = dbs[2]
      console.log(`\n-- negative control: the constraint is missing (${db}) --`)
      await createScratchDb(SUPER, db, roles)
      const url = withDb(MIGRATE, db)
      await applyThrough(url, TARGET)
      const m = await connect(url)
      try {
        await m.query(`ALTER TABLE content_items DROP CONSTRAINT ${OLD_CONSTRAINT}`)
      } finally {
        await m.end()
      }
      const run = runRunner(url, { through: TARGET })
      console.log(`        runner exit=${run.status}: ${(run.stdout + run.stderr).trim().split('\n').join(' | ')}`)
      const st = await stateOf(url)
      check('[none] the real runner exits non-zero', run.status === 1, run.status)
      check('[none] the error names the precondition and the count (0)', /0010 precondition FAILED: expected exactly one UNIQUE constraint on content_items \(collection_id, locale, slug\), found 0/.test(run.stderr), run.stderr)
      check('[none] no ledger row and no partial index', st.ledger === 0 && st.new_index === 0, st)
    }

    // ---- D4: two constraints -> loud failure, nothing applied, nothing dropped -----------------
    {
      const db = dbs[3]
      console.log(`\n-- negative control: two UNIQUE constraints on the same three columns (${db}) --`)
      await createScratchDb(SUPER, db, roles)
      const url = withDb(MIGRATE, db)
      await applyThrough(url, TARGET)
      const m = await connect(url)
      try {
        await m.query(`ALTER TABLE content_items ADD CONSTRAINT content_items_extra_slug_uq UNIQUE (slug, locale, collection_id)`)
      } finally {
        await m.end()
      }
      const run = runRunner(url, { through: TARGET })
      console.log(`        runner exit=${run.status}: ${(run.stdout + run.stderr).trim().split('\n').join(' | ')}`)
      const st = await stateOf(url)
      check('[two] the real runner exits non-zero', run.status === 1, run.status)
      check('[two] the error names the precondition, the count (2) and both constraints', /found 2/.test(run.stderr) && new RegExp(OLD_CONSTRAINT).test(run.stderr) && /content_items_extra_slug_uq/.test(run.stderr), run.stderr)
      check('[two] atomic: no ledger row, no partial index, both constraints still there', st.ledger === 0 && st.new_index === 0 && st.uniques === 2, st)
    }
  } catch (err) {
    check('[scratch] unexpected harness error', false, err.stack)
  } finally {
    for (const d of dbs) await dropScratchDb(SUPER, d).catch(() => {})
  }
}

// =============================================================================================
async function main() {
  const roles = await resolveRoles(SUPER, MIGRATE, APP)
  console.log(`[0010] roles: owner=${roles.owner} migrator=${roles.migrator} app=${roles.app}`)
  await partA(roles)
  await partB()
  await partC()
  await partD(roles)
  process.exit(summary())
}

main().catch((err) => {
  console.error('[0010] ERROR', err.stack)
  process.exit(2)
})
