/**
 * One-off: push Payload's dev schema (as the DB owner - only the owner has
 * CREATE on public per estate doctrine), then lock the "pages" table down
 * with FORCE RLS exactly like sql/001_schema.sql does for content_items, and
 * grant the runtime app role what it needs on every table Payload created.
 *
 * Run: OWNER_URI=... node --import tsx scripts/setup-schema.ts
 */
import pg from 'pg'

const OWNER_URI = process.env.OWNER_URI
if (!OWNER_URI) throw new Error('OWNER_URI not set')

process.env.DATABASE_URI = OWNER_URI
process.env.PAYLOAD_ALLOW_PUSH = 'true'
process.env.NODE_ENV = process.env.NODE_ENV || 'development'

const { getPayload } = await import('payload')
const config = (await import('../payload.config.ts')).default

console.log('-- pushing Payload dev schema as owner --')
const payload = await getPayload({ config })
console.log('-- schema push complete --')
await payload.destroy()

// Discover exactly what Payload created, so grants are scoped to those
// tables only - NOT a blanket "ALL TABLES", which would silently widen
// webdesk_app's privilege on tenants/content_items beyond what
// sql/001_schema.sql (owned by another worker) deliberately set.
const owner = new pg.Pool({ connectionString: OWNER_URI, max: 1 })
const { rows } = await owner.query(`
  select table_name from information_schema.tables
  where table_schema = 'public' and table_name not in ('tenants', 'content_items')
`)
const payloadTables: string[] = rows.map((r: any) => r.table_name)
console.log('-- Payload-owned tables:', payloadTables.join(', '))

for (const t of payloadTables) {
  await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${t}" TO webdesk_app`)
}
// Sequences (serial PKs) need USAGE for webdesk_app to insert.
const { rows: seqRows } = await owner.query(`
  select sequence_name from information_schema.sequences where sequence_schema = 'public'
`)
for (const s of seqRows) {
  await owner.query(`GRANT USAGE, SELECT ON SEQUENCE "${s.sequence_name}" TO webdesk_app`)
}

// THE tenant wall on the one collection this spike cares about.
await owner.query('ALTER TABLE pages ENABLE ROW LEVEL SECURITY')
await owner.query('ALTER TABLE pages FORCE ROW LEVEL SECURITY')
await owner.query('DROP POLICY IF EXISTS tenant_isolation ON pages')
await owner.query(`
  CREATE POLICY tenant_isolation ON pages
    USING      ("tenant_id" = nullif(current_setting('webdesk.tenant_ctx', true), ''))
    WITH CHECK ("tenant_id" = nullif(current_setting('webdesk.tenant_ctx', true), ''))
`)
console.log('-- pages: FORCE RLS + tenant_isolation policy applied --')

// Migrator gets CREATE so P12 (migrations) exercises a NOBYPASSRLS role, not
// the superuser owner - see FINDINGS.md for why that distinction matters.
await owner.query('GRANT CREATE ON SCHEMA public TO webdesk_migrator')
await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO webdesk_migrator`)

await owner.end()
console.log('-- setup-schema done --')
