/**
 * WSK-04 condition 3 — the generic, idempotent RLS re-apply routine for Payload-owned tables.
 *
 * BACKGROUND (do not re-derive — see webdesk/spike-rls/payload/FINDINGS.md's addendum and this
 * ticket's report): an ordinary Payload dev schema push (`PAYLOAD_ALLOW_PUSH=true`) DISABLES row
 * security and DROPS the `tenant_isolation` policy on every table it touches, while leaving
 * `relforcerowsecurity=true` — fail-OPEN, and invisible to a check that only inspects the FORCE
 * flag. `payload.config.ts` already gates push behind two explicit flags AND `NODE_ENV !==
 * 'production'` (WSK-02) — push cannot fire against a database whose process has
 * `NODE_ENV=production`. This file is the other half: the MANDATORY re-apply step that must run
 * every time push *is* used (dev only), made GENERIC — it discovers every tenant-scoped table by
 * the same `tenant_id`-column heuristic `webdesk/scripts/check-rls-integrity.mjs` uses, instead of
 * naming `pages` by hand the way `scripts/setup-schema.mjs`'s interim version does — so a future
 * Payload collection with a `tenantId` field is covered automatically, with no per-collection edit
 * to this file.
 *
 * DECISION RECORD (condition 3 — "pick ONE"): this is Option B — "push forbidden against any real
 * database plus a mandatory re-apply step" — NOT Option A ("policies re-applied BY a migration
 * that runs after every schema change"). Reason: a Payload/drizzle migration's `up()` runs exactly
 * ONCE, ever (recorded in `payload_migrations`). Encoding the reapply inside a migration would
 * only protect the tables that existed the day that migration was written; every future
 * collection would need a BRAND NEW migration whose author remembers to reapply RLS specifically
 * for it — the exact "must stay correct forever, on every future change, easy to forget" shape
 * WSK-00's own FINDINGS.md already caught once (the push hazard itself was exactly this kind of
 * silent, forgettable gap). A script that mechanically re-discovers tenant-scoped tables every
 * time it runs has no such expiry date.
 *
 * THE ENFORCING GATE, per this ticket's own requirement, is NOT this file — it is
 * `webdesk/scripts/check-rls-integrity.mjs`. This file can (in principle) have a bug, miss a
 * table, or run against the wrong database. `webdesk/scripts/reapply-and-verify-rls.mjs` is the
 * wrapper that calls this function and then unconditionally runs check-rls-integrity's own
 * `evaluate()` against live catalog state before exiting 0 — so a gap in THIS file's own logic
 * still fails loudly rather than shipping quietly. Never call this function without that gate
 * immediately after it.
 */
import pg from 'pg';

/**
 * Tables a Payload push can create that are never tenant-scoped (Payload's own auth/preferences/
 * jobs machinery) — mirrors `scripts/check-rls-integrity.mjs`'s EXEMPT set and
 * `scripts/setup-schema.mjs`'s KNOWN_NON_PAYLOAD_TABLES, restated here because this file must
 * also run standalone, without importing either.
 */
const NEVER_TENANT_SCOPED = new Set([
  'users',
  'users_sessions',
  'payload_kv',
  'payload_migrations',
  'payload_preferences',
  'payload_preferences_rels',
  'payload_locked_documents',
  'payload_locked_documents_rels',
  'payload_jobs',
  'payload_jobs_log',
]);

// Scoped to tables the CONNECTING role owns (current_user — the DB owner role push runs as),
// not merely "every tenant_id-bearing table in the database". This is deliberate, not an
// oversight: webdesk/migrations/0001-0004 tables (sites, api_keys, content_items, ...) also have
// a tenant_id column and are correctly RLS'd already, but they are owned by webdesk_migrator, not
// the owner role Payload pushes as — attempting to ALTER them here would either fail with
// "must be owner of table" (safe, but noisy and wrong) or, if ever run as a role WITH such
// rights, would be reaching outside this file's actual job (fixing what PUSH disarms) into
// territory the platform-core ledger already owns permanently. Scoping by relowner = current_user
// makes this routine self-limiting to exactly "tables the role that just pushed created," with no
// hardcoded table-name list to keep in sync.
const DISCOVER_TENANT_TABLES_SQL = `
  SELECT DISTINCT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
     AND a.attname = 'tenant_id'
     AND a.attnum > 0
     AND NOT a.attisdropped
`;

/**
 * (Re)applies FORCE RLS + the standard tenant_isolation policy to every table in `public` that
 * has a `tenant_id` column and is not in NEVER_TENANT_SCOPED. Must be called as a role with
 * ownership/ALTER rights on those tables (the DB owner role — the same role `setup-schema.mjs`
 * already uses for push). Idempotent and safe to call unconditionally, any number of times:
 * ENABLE/FORCE ROW LEVEL SECURITY are no-ops when already set, and DROP POLICY IF EXISTS + CREATE
 * POLICY replaces cleanly.
 *
 * Returns the list of table names it touched, so a caller can log/assert against it.
 */
export async function reapplyTenantRlsOnPayloadTables(ownerConnectionString) {
  const owner = new pg.Pool({ connectionString: ownerConnectionString, max: 1 });
  try {
    const { rows } = await owner.query(DISCOVER_TENANT_TABLES_SQL);
    const tables = rows.map((r) => r.table_name).filter((t) => !NEVER_TENANT_SCOPED.has(t));

    for (const t of tables) {
      // Payload/drizzle's tenantId field on `pages` is `type: 'text'` (see payload.config.ts's
      // own comment: "Text, not a DB-level FK ... WSK-02 scope is proving boot + the tenancy
      // mechanism end-to-end"), so the policy compares text to text, matching
      // setup-schema.mjs's existing pattern for `pages` exactly — this generic version does not
      // change that shape, only removes the hardcoded table name.
      await owner.query(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
      await owner.query(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
      await owner.query(`DROP POLICY IF EXISTS tenant_isolation ON "${t}"`);
      await owner.query(`
        CREATE POLICY tenant_isolation ON "${t}"
          USING      ("tenant_id" = nullif(current_setting('webdesk.tenant_ctx', true), ''))
          WITH CHECK ("tenant_id" = nullif(current_setting('webdesk.tenant_ctx', true), ''))
      `);
    }
    return tables;
  } finally {
    await owner.end();
  }
}

// Runnable standalone: `OWNER_URI=... node src/reapply-tenant-rls.mjs`
const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  const uri = process.env.OWNER_URI;
  if (!uri) {
    console.error('[reapply-tenant-rls] OWNER_URI not set');
    process.exit(1);
  }
  reapplyTenantRlsOnPayloadTables(uri)
    .then((tables) => {
      console.log(`[reapply-tenant-rls] reapplied FORCE RLS + tenant_isolation on: ${tables.join(', ') || '(none found)'}`);
    })
    .catch((err) => {
      console.error('[reapply-tenant-rls] ERROR', err);
      process.exit(1);
    });
}
