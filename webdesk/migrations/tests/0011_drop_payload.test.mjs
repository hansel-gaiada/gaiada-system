#!/usr/bin/env node
/**
 * WSK-48b — migration 0011 (drop the tables Payload's own schema created) proven against a real
 * Postgres, with the REAL runner.
 *
 * Four parts, one exit code:
 *   A. The MAIN database (already migrated through 0011 by the real runner, and never a Payload
 *      database): the ledger records 0011, none of the nine Payload tables exists, no sequence of
 *      theirs is left, and a second runner pass applies 0 files. (This is also what the live
 *      database looks like: 0011 is a no-op there.)
 *   B. A scratch database stopped at 0010, with a Payload-shaped table set built from the DDL of
 *      Payload's initial migration (same tables, serial ids, foreign keys, indexes, and the FORCE RLS
 *      + tenant_isolation policy setup-schema.mjs put on `pages`), a tenant with a site and content
 *      next to it, and a WebDesk catalog snapshot. Before the migration: no WebDesk table has a
 *      foreign key to any Payload table. The real runner then applies 0011: the nine tables and
 *      their sequences are gone, the WebDesk catalog (constraints, indexes, policies, columns,
 *      grants, RLS flags, triggers, minus the Payload tables) is byte-identical, the WebDesk rows
 *      are all still there, and a second pass applies 0 files.
 *   C. The same on a scratch database that never had Payload (the live case): 0011 applies and
 *      changes nothing in the catalog.
 *   D. Loud refusals, each with nothing applied (ledger lacks 0011, the tables intact): a `users`
 *      table that is not Payload's shape is NOT dropped; a WebDesk-side table with a foreign key to
 *      `pages` blocks the drop (there is no CASCADE).
 *
 * Env (all point at the same cluster):
 *   SUPERUSER_DATABASE_URL  cluster bootstrap identity on the main db (creates/drops scratch dbs)
 *   MIGRATE_DATABASE_URL    webdesk_migrator on the main db
 *   APP_DATABASE_URL        webdesk_app on the main db
 *
 * Run (from webdesk/):  node migrations/tests/0011_drop_payload.test.mjs
 */
import {
  applyThrough,
  connect,
  createScratchDb,
  dropScratchDb,
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

const TARGET = '0011_drop_payload.sql'
const PAYLOAD_TABLES = [
  'users_sessions',
  'users',
  'pages',
  'payload_kv',
  'payload_locked_documents',
  'payload_locked_documents_rels',
  'payload_preferences',
  'payload_preferences_rels',
  'payload_migrations',
]
// Payload's initial migration (webdesk/payload/src/migrations/20260829_113056_wsk_initial.ts, deleted
// with this migration), reproduced here: tables, serial ids, foreign keys, indexes.
const PAYLOAD_DDL = `
  CREATE TABLE "users_sessions" ("_order" integer NOT NULL, "_parent_id" integer NOT NULL, "id" varchar PRIMARY KEY NOT NULL,
    "created_at" timestamp(3) with time zone, "expires_at" timestamp(3) with time zone NOT NULL);
  CREATE TABLE "users" ("id" serial PRIMARY KEY NOT NULL, "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL, "email" varchar NOT NULL, "reset_password_token" varchar,
    "reset_password_expiration" timestamp(3) with time zone, "salt" varchar, "hash" varchar, "login_attempts" numeric DEFAULT 0,
    "lock_until" timestamp(3) with time zone);
  CREATE TABLE "pages" ("id" serial PRIMARY KEY NOT NULL, "tenant_id" varchar NOT NULL, "title" varchar NOT NULL, "body" varchar,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL, "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL);
  CREATE TABLE "payload_kv" ("id" serial PRIMARY KEY NOT NULL, "key" varchar NOT NULL, "data" jsonb NOT NULL);
  CREATE TABLE "payload_locked_documents" ("id" serial PRIMARY KEY NOT NULL, "global_slug" varchar,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL, "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL);
  CREATE TABLE "payload_locked_documents_rels" ("id" serial PRIMARY KEY NOT NULL, "order" integer, "parent_id" integer NOT NULL,
    "path" varchar NOT NULL, "users_id" integer, "pages_id" integer);
  CREATE TABLE "payload_preferences" ("id" serial PRIMARY KEY NOT NULL, "key" varchar, "value" jsonb,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL, "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL);
  CREATE TABLE "payload_preferences_rels" ("id" serial PRIMARY KEY NOT NULL, "order" integer, "parent_id" integer NOT NULL,
    "path" varchar NOT NULL, "users_id" integer);
  CREATE TABLE "payload_migrations" ("id" serial PRIMARY KEY NOT NULL, "name" varchar, "batch" numeric,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL, "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL);
  ALTER TABLE "users_sessions" ADD CONSTRAINT "users_sessions_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."users"("id") ON DELETE cascade;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."payload_locked_documents"("id") ON DELETE cascade;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_pages_fk" FOREIGN KEY ("pages_id") REFERENCES "public"."pages"("id") ON DELETE cascade;
  ALTER TABLE "payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."payload_preferences"("id") ON DELETE cascade;
  ALTER TABLE "payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade;
  CREATE INDEX "users_sessions_parent_id_idx" ON "users_sessions" USING btree ("_parent_id");
  CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");
  CREATE INDEX "pages_tenant_id_idx" ON "pages" USING btree ("tenant_id");
  CREATE UNIQUE INDEX "payload_kv_key_idx" ON "payload_kv" USING btree ("key");
  CREATE INDEX "payload_locked_documents_rels_pages_id_idx" ON "payload_locked_documents_rels" USING btree ("pages_id");
  CREATE INDEX "payload_preferences_rels_users_id_idx" ON "payload_preferences_rels" USING btree ("users_id");
  CREATE INDEX "payload_migrations_created_at_idx" ON "payload_migrations" USING btree ("created_at");
  -- what scripts/setup-schema.mjs added on top of the push: the tenant wall on pages
  ALTER TABLE pages ENABLE ROW LEVEL SECURITY;
  ALTER TABLE pages FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON pages
    USING ("tenant_id" = nullif(current_setting('webdesk.tenant_ctx', true), ''))
    WITH CHECK ("tenant_id" = nullif(current_setting('webdesk.tenant_ctx', true), ''));
`

const { check, summary } = makeChecker('0011')

const firstColIs = (names) => (row) => !names.includes(JSON.parse(row)[0])
/** The WebDesk part of a catalog snapshot: every row whose table is not a Payload table. */
function webdeskOnly(snap) {
  return Object.fromEntries(Object.entries(snap).map(([k, rows]) => [k, rows.filter(firstColIs(PAYLOAD_TABLES))]))
}
function sameSnapshot(a, b) {
  const diffs = []
  for (const k of Object.keys(a)) {
    const gone = a[k].filter((r) => !b[k].includes(r))
    const added = b[k].filter((r) => !a[k].includes(r))
    if (gone.length || added.length) diffs.push({ part: k, removed: gone.slice(0, 3), added: added.slice(0, 3) })
  }
  return diffs
}
async function payloadTablesPresent(c) {
  const { rows } = await c.query(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname = ANY($1) ORDER BY 1`, [PAYLOAD_TABLES])
  return rows.map((r) => r.relname)
}
async function payloadSequencesPresent(c) {
  const { rows } = await c.query(
    `SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'S' AND relname = ANY($1) ORDER BY 1`,
    [PAYLOAD_TABLES.map((t) => `${t}_id_seq`)],
  )
  return rows.map((r) => r.relname)
}
/** Row counts under the right GUCs (tenants need platform ctx; sites/collections need the tenant's). */
async function webdeskRows(c, seeded) {
  await c.query('BEGIN')
  try {
    await setCtx(c, { platform: true })
    const t = (await one(c, `SELECT count(*)::int AS n FROM tenants WHERE id = $1`, [seeded.t])).n
    await setCtx(c, { tenant: seeded.t })
    const s = (await one(c, `SELECT count(*)::int AS n FROM sites WHERE id = $1`, [seeded.site])).n
    const col = (await one(c, `SELECT count(*)::int AS n FROM collections WHERE id = $1`, [seeded.col])).n
    const l = (await one(c, `SELECT count(*)::int AS n FROM schema_migrations`)).n
    return { tenants: t, sites: s, collections: col, ledger: l }
  } finally {
    await c.query('COMMIT')
  }
}
const lastLine = (r) => r.stdout.trim().split('\n').at(-1)
const ledgerHas = async (c, name) => (await one(c, `SELECT count(*)::int AS n FROM schema_migrations WHERE name = $1`, [name])).n === 1

// =============================================================================================
// A. The main database
// =============================================================================================
async function partA() {
  console.log('\n== A. main db (migrated by the real runner; never held Payload) ==')
  const c = await connect(MIGRATE)
  try {
    check(`ledger records ${TARGET}`, await ledgerHas(c, TARGET))
    const tables = await payloadTablesPresent(c)
    check('none of the nine Payload tables exists', tables.length === 0, tables)
    const seqs = await payloadSequencesPresent(c)
    check('none of their serial sequences exists', seqs.length === 0, seqs)
    const fks = await c.query(
      `SELECT conrelid::regclass::text AS tbl, conname FROM pg_constraint
        WHERE contype = 'f' AND confrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1))`,
      [PAYLOAD_TABLES],
    )
    check('no foreign key anywhere references a Payload-named table', fks.rows.length === 0, fks.rows)
    const second = runRunner(MIGRATE)
    console.log(`        second runner pass: ${lastLine(second)}`)
    check('a second runner pass applies 0 files', second.status === 0 && /\b0 applied/.test(second.stdout), second.stdout + second.stderr)
  } finally {
    await c.end()
  }
}

// A scratch database at 0010 (everything before 0011), optionally with the Payload table set.
async function scratchAt0010(roles, name, { payload }) {
  await createScratchDb(SUPER, name, roles)
  const mUrl = withDb(MIGRATE, name)
  const applied = await applyThrough(mUrl, TARGET)
  check(`[${name}] scratch db at 0010 (${applied.length} files, last ${applied.at(-1)})`, applied.length === 10 && applied.at(-1).startsWith('0010'))
  const m = await connect(mUrl)
  if (payload) await m.query(PAYLOAD_DDL)
  return { mUrl, m }
}

// =============================================================================================
// B. Payload tables present
// =============================================================================================
async function partB(roles) {
  console.log('\n== B. a database that ran Payload ==')
  const name = 'wsk48b_payload'
  const { mUrl, m } = await scratchAt0010(roles, name, { payload: true })
  try {
    const present = await payloadTablesPresent(m)
    check('the nine Payload tables exist before 0011', present.length === 9, present)
    const seqBefore = await payloadSequencesPresent(m)
    check('their serial sequences exist before 0011', seqBefore.length === 8, seqBefore)

    // The FK proof: of every foreign key that points INTO a Payload table, none starts in a WebDesk table.
    const fk = await m.query(
      `SELECT conrelid::regclass::text AS tbl, conname FROM pg_constraint
        WHERE contype = 'f'
          AND confrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1))
          AND conrelid NOT IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1))`,
      [PAYLOAD_TABLES],
    )
    check('no WebDesk table has a foreign key to a Payload table', fk.rows.length === 0, fk.rows)
    const fkIn = await m.query(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f'
        AND confrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1))`,
      [PAYLOAD_TABLES],
    )
    check('the Payload tables do have their own six internal foreign keys (the check above can see them)', fkIn.rows[0].n === 6, fkIn.rows)

    const seeded = await seedTenant(m)
    const before = webdeskOnly(await snapshot(m))
    const rowsBefore = await webdeskRows(m, seeded)
    // Payload-owned data must not matter either way: put rows in, they go with the tables.
    await m.query(`INSERT INTO users (email, salt, hash) VALUES ('a@example.invalid', 's', 'h')`)
    await m.query(`INSERT INTO payload_kv (key, data) VALUES ('k', '{}')`)

    await m.end()
    const run = runRunner(mUrl, { through: TARGET })
    console.log(`        runner exit=${run.status}: ${lastLine(run)}`)
    check('the real runner applied 0011', run.status === 0 && /1 applied/.test(run.stdout), run.stdout + run.stderr)

    const a = await connect(mUrl)
    try {
      const left = await payloadTablesPresent(a)
      check('the nine Payload tables are gone', left.length === 0, left)
      const seqLeft = await payloadSequencesPresent(a)
      check('their serial sequences are gone with them', seqLeft.length === 0, seqLeft)
      const after = webdeskOnly(await snapshot(a))
      const diffs = sameSnapshot(before, after)
      check(`the WebDesk catalog is untouched (${Object.values(before).reduce((n, r) => n + r.length, 0)} facts: constraints, indexes, policies, columns, grants, RLS flags, triggers)`, diffs.length === 0, diffs)
      const rowsAfter = await webdeskRows(a, seeded)
      check('the seeded tenant, site and collection are all still there (the ledger gained exactly 0011)',
        rowsBefore.tenants === 1 && rowsBefore.sites === 1 && rowsBefore.collections === 1 &&
          rowsAfter.tenants === 1 && rowsAfter.sites === 1 && rowsAfter.collections === 1 && rowsAfter.ledger === rowsBefore.ledger + 1,
        { rowsBefore, rowsAfter })
      check(`ledger records ${TARGET}`, await ledgerHas(a, TARGET))
    } finally {
      await a.end()
    }
    const again = runRunner(mUrl, { through: TARGET })
    console.log(`        second runner pass: ${lastLine(again)}`)
    check('a second runner pass applies 0 files (idempotent)', again.status === 0 && /\b0 applied/.test(again.stdout), again.stdout + again.stderr)
  } finally {
    await m.end().catch(() => {})
    await dropScratchDb(SUPER, name).catch(() => {})
  }
}

// =============================================================================================
// C. No Payload tables (the live case)
// =============================================================================================
async function partC(roles) {
  console.log('\n== C. a database that never had Payload (the live case) ==')
  const name = 'wsk48b_clean'
  const { mUrl, m } = await scratchAt0010(roles, name, { payload: false })
  try {
    const before = await snapshot(m)
    await m.end()
    const run = runRunner(mUrl, { through: TARGET })
    console.log(`        runner exit=${run.status}: ${lastLine(run)}`)
    check('0011 applies cleanly (a no-op)', run.status === 0 && /1 applied/.test(run.stdout), run.stdout + run.stderr)
    const a = await connect(mUrl)
    try {
      const diffs = sameSnapshot(before, await snapshot(a))
      check('the whole catalog is byte-identical before and after', diffs.length === 0, diffs)
    } finally {
      await a.end()
    }
  } finally {
    await m.end().catch(() => {})
    await dropScratchDb(SUPER, name).catch(() => {})
  }
}

// =============================================================================================
// D. Loud refusals
// =============================================================================================
async function partD(roles) {
  console.log('\n== D. loud refusals ==')
  {
    const name = 'wsk48b_foreign_users'
    const { mUrl, m } = await scratchAt0010(roles, name, { payload: false })
    try {
      await m.query(`CREATE TABLE users (id uuid PRIMARY KEY, name text NOT NULL)`)
      await m.query(`INSERT INTO users VALUES ('00000000-0000-4000-8000-000000000001', 'not payload')`)
      await m.end()
      const run = runRunner(mUrl, { through: TARGET })
      console.log(`        runner exit=${run.status}: ${lastLine(run)}`)
      check('a users table that is not Payload\'s shape stops the runner, naming it', run.status !== 0 && /public\.users exists but does not have Payload's columns/.test(run.stdout + run.stderr), run.stdout + run.stderr)
      const a = await connect(mUrl)
      try {
        check('that users table and its row are untouched', (await one(a, `SELECT count(*)::int AS n FROM users`)).n === 1)
        check(`nothing applied: ${TARGET} is not in the ledger`, !(await ledgerHas(a, TARGET)))
      } finally {
        await a.end()
      }
    } finally {
      await m.end().catch(() => {})
      await dropScratchDb(SUPER, name).catch(() => {})
    }
  }
  {
    const name = 'wsk48b_dependent'
    const { mUrl, m } = await scratchAt0010(roles, name, { payload: true })
    try {
      // A WebDesk-side object that depends on a Payload table: without CASCADE the drop must refuse.
      await m.query(`CREATE TABLE webdesk_pins_page (id serial PRIMARY KEY, page_id integer NOT NULL REFERENCES pages(id))`)
      await m.end()
      const run = runRunner(mUrl, { through: TARGET })
      console.log(`        runner exit=${run.status}: ${lastLine(run)}`)
      check('a dependent WebDesk object stops the runner (no CASCADE)', run.status !== 0 && /depend/i.test(run.stdout + run.stderr), run.stdout + run.stderr)
      const a = await connect(mUrl)
      try {
        const left = await payloadTablesPresent(a)
        check('all nine Payload tables and the dependent table are still there (the file rolled back)', left.length === 9 && (await one(a, `SELECT to_regclass('public.webdesk_pins_page') IS NOT NULL AS ok`)).ok, left)
        check(`nothing applied: ${TARGET} is not in the ledger`, !(await ledgerHas(a, TARGET)))
      } finally {
        await a.end()
      }
    } finally {
      await m.end().catch(() => {})
      await dropScratchDb(SUPER, name).catch(() => {})
    }
  }
}

async function main() {
  const roles = await resolveRoles(SUPER, MIGRATE, APP)
  try {
    await partA()
    await partB(roles)
    await partC(roles)
    await partD(roles)
  } catch (err) {
    check('unexpected harness error', false, err.stack)
  }
  process.exit(summary())
}

main()
