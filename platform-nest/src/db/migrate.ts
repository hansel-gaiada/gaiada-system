// Ordered-SQL migration runner (ported from the Fastify core, CommonJS variant). Each
// migrations/NNNN_*.sql applies once, in a transaction, recorded in schema_migrations.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { config } from "../config";

// platform-nest owns its own migrations/ (copied at port time; the cutover deletes platform/).
const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

// DDL + grant provisioning run as the OWNER (migrateDatabaseUrl), NOT the restricted runtime role.
// A dedicated short-lived pool keeps the runtime pool (getPool) on platform_app.
function migratePool(): Pool {
  // Owner DSN in prod; falls back to the runtime DSN in dev/tests (read at call time so the test
  // harness's runtime-set config.databaseUrl is honored).
  const url = config.migrateDatabaseUrl || config.databaseUrl;
  if (!url) throw new Error("MIGRATE_DATABASE_URL / DATABASE_URL not set");
  return new Pool({ connectionString: url });
}

export async function migrate(): Promise<string[]> {
  const pool = migratePool();
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = new Set(
      (await pool.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        ran.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      } finally {
        client.release();
      }
    }
    // Least-privilege runtime grants (DB topology plan §3.1). Idempotent + conditional on the
    // production roles existing, so dev/test (single shared role) is a no-op. Runs as the owner,
    // which owns every table and can therefore GRANT/REVOKE. sync_app gets EXACTLY the sync
    // writeback footprint; platform_app is REVOKED from the sync-internal tables (the hard
    // platform↔sync boundary — the ACL especially).
    await pool.query(RUNTIME_GRANTS_SQL);
    return ran;
  } finally {
    await pool.end();
  }
}

// Tables the sync engine touches (internal/protocol/writeback.go registry + audit/companies/outbox
// + the sync-internal tables). Kept in sync with that registry.
const RUNTIME_GRANTS_SQL = `
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sync_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      deliverables, agency_campaigns, time_entries, activities, companies, outbox_events,
      site_subscriptions, sync_cursors, sync_applied_events, sync_conflicts, sync_dead_letter
      TO sync_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    REVOKE ALL ON site_subscriptions, sync_cursors, sync_applied_events, sync_conflicts, sync_dead_letter
      FROM platform_app;
  END IF;
END $$;`;

if (require.main === module) {
  migrate()
    .then((ran) => {
      // eslint-disable-next-line no-console
      console.log(ran.length ? `applied: ${ran.join(", ")}` : "up to date");
      process.exit(0);
    })
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.error(e.message);
      process.exit(1);
    });
}
