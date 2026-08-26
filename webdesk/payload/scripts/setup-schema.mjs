/**
 * WSK-02 — one-off: push Payload's dev schema (as the DB OWNER role — only the owner has CREATE
 * on public per the estate's role-split doctrine, mirrored from webdesk/postgres/init-roles.sh),
 * then immediately lock the "pages" table down with FORCE RLS + a tenant_isolation policy, and
 * grant the runtime app role what it needs on every table Payload created.
 *
 * This is the mitigation for the dev-push hazard documented in FINDINGS.md's addendum: an
 * ordinary `PAYLOAD_ALLOW_PUSH=true` boot disables row security and drops any existing policy
 * while leaving relforcerowsecurity=true (fail-open, invisible to a FORCE-flag-only check). This
 * script's LAST action is always re-asserting RLS — run it again any time push has run, including
 * every time this project's own dev workflow uses push. WSK-04 owns the permanent decision for how
 * RLS survives Payload owning the schema across every future service boot (a migration that
 * reapplies the policy, or forbidding push entirely against any database that matters); this
 * script is the interim, explicit, always-rerun mitigation for THIS ticket's scope, not that
 * decision.
 *
 * Run: OWNER_URI=... PAYLOAD_ALLOW_PUSH=true PAYLOAD_ALLOW_PUSH_I_UNDERSTAND_THIS_DISABLES_RLS=true \
 *      node --import tsx scripts/setup-schema.mjs
 */
import pg from 'pg'

const OWNER_URI = process.env.OWNER_URI
if (!OWNER_URI) throw new Error('OWNER_URI not set')

process.env.DATABASE_URI = OWNER_URI
process.env.PAYLOAD_ALLOW_PUSH = 'true'
process.env.PAYLOAD_ALLOW_PUSH_I_UNDERSTAND_THIS_DISABLES_RLS = 'true'
process.env.NODE_ENV = process.env.NODE_ENV || 'development'

const { getPayload } = await import('payload')
const config = (await import('../payload.config.ts')).default

console.log('-- pushing Payload dev schema as owner --')
const payload = await getPayload({ config })
console.log('-- schema push complete --')
await payload.destroy()

// Discover exactly what Payload created, so grants are scoped to those tables only — never a
// blanket "ALL TABLES", which could silently widen webdesk_app's privilege on tables this
// project does not own (the platform-core schema from WSK-03 lives in the same database under
// the shared-instance model, WSK-D16).
const owner = new pg.Pool({ connectionString: OWNER_URI, max: 1 })
const KNOWN_NON_PAYLOAD_TABLES = [
  'tenants',
  'sites',
  'environments',
  'api_keys',
  'releases',
  'audit_entries',
  'collections',
  'content_items',
  'content_versions',
  'media_assets',
]
const { rows } = await owner.query(
  `select table_name from information_schema.tables
   where table_schema = 'public' and table_name != ALL($1::text[])`,
  [KNOWN_NON_PAYLOAD_TABLES],
)
const payloadTables = rows.map((r) => r.table_name)
console.log('-- Payload-owned tables:', payloadTables.join(', '))

for (const t of payloadTables) {
  await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${t}" TO webdesk_app`)
}
const { rows: seqRows } = await owner.query(
  `select sequence_name from information_schema.sequences where sequence_schema = 'public'`,
)
for (const s of seqRows) {
  await owner.query(`GRANT USAGE, SELECT ON SEQUENCE "${s.sequence_name}" TO webdesk_app`)
}

// THE tenant wall on the one collection this ticket cares about. Always re-run, unconditionally,
// as the LAST step — this is what makes push safe to have used a moment ago.
await owner.query('ALTER TABLE pages ENABLE ROW LEVEL SECURITY')
await owner.query('ALTER TABLE pages FORCE ROW LEVEL SECURITY')
await owner.query('DROP POLICY IF EXISTS tenant_isolation ON pages')
await owner.query(`
  CREATE POLICY tenant_isolation ON pages
    USING      ("tenant_id" = nullif(current_setting('webdesk.tenant_ctx', true), ''))
    WITH CHECK ("tenant_id" = nullif(current_setting('webdesk.tenant_ctx', true), ''))
`)
console.log('-- pages: FORCE RLS + tenant_isolation policy applied --')

// Verify the three RLS facts this ticket's README calls out (the FINDINGS.md addendum's gate,
// restated for one table): relrowsecurity, relforcerowsecurity, and >=1 policy. A CI-wide gate
// covering every tenant table is WSK-04's job; this is a same-script sanity check that push did
// not leave `pages` fail-open right after we just used push.
const { rows: rlsRows } = await owner.query(`
  select c.relrowsecurity, c.relforcerowsecurity,
         (select count(*) from pg_policy where polrelid = c.oid) as policy_count
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'pages'
`)
const rls = rlsRows[0]
console.log('-- pages RLS facts:', rls)
if (!rls?.relrowsecurity || !rls?.relforcerowsecurity || Number(rls?.policy_count) < 1) {
  await owner.end()
  throw new Error(
    `RLS verification FAILED for pages: relrowsecurity=${rls?.relrowsecurity} ` +
      `relforcerowsecurity=${rls?.relforcerowsecurity} policy_count=${rls?.policy_count}`,
  )
}

await owner.end()
console.log('-- setup-schema done --')
