// Vitest globalSetup: builds ONE template database per run, so the 292 DB-backed test files
// stop each replaying the whole migration history.
//
// WHY THIS EXISTS (measured, 2026-08-24). The per-file physical-database isolation in setup.ts
// is correct and is NOT changed by this file — every test file still gets its own database. What
// was expensive was how that database got its SCHEMA: `initTestDb` ran `migrate()`, which applies
// 166 migrations (1.7 MB of SQL) in 166 separate transactions on 166 separate connections. Times
// 292 files, that is ~48,000 migration transactions per CI run, and it was 1219s of a 22.6-minute
// `ci` workflow — 90% of the whole pipeline's wall clock (run 32708526114, step 14).
//
// The migrations are applied ONCE here, into a template. Each file then does
// `CREATE DATABASE <file> TEMPLATE <template>`, which Postgres serves as a filesystem copy of the
// already-migrated data directory — hundreds of milliseconds instead of seconds, and flat in the
// number of migrations rather than linear.
//
// WHAT IS PRESERVED, deliberately:
//   * Per-file physical databases — the isolation property setup.ts's header argues for at length
//     (unique-email collisions, teardown/DROP races). A template changes how a database is FILLED,
//     never how many there are.
//   * Migration correctness as a gate — the migrations still run from scratch, in order, against
//     an empty database, on every single run. A broken migration still fails, just once and early
//     (in globalSetup, before any test file) instead of 292 times.
//   * The `platform_app_test` role's NOSUPERUSER/NOBYPASSRLS attributes, re-asserted here.
//
// A BUG THIS ALSO CLOSES. Role setup used to run per-file, and `CREATE/ALTER ROLE` on one
// cluster-global role from concurrent sessions raises `tuple concurrently updated` — setup.ts
// carried a five-attempt retry loop for exactly that race. Doing it once, before any worker
// starts, removes the race instead of retrying it, so that loop is gone.
import { Pool } from "pg";
import { config } from "../config";
import { migrate } from "../db/migrate";
import { APP_PASSWORD, APP_ROLE, templateDbName, urlWithDb } from "./db-names";

const TEST_URL = process.env.DATABASE_URL_TEST ?? "";

/** Connections to a template must be zero when anything does CREATE DATABASE ... TEMPLATE, so
 *  every pool opened in here is closed before setup() returns. */
async function withPool<T>(url: string, fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: url, max: 1 });
  // No attachPoolErrorHandler here on purpose: this runs in vitest's main process, not a worker,
  // and a swallowed error during template construction would produce 292 files failing in
  // beforeAll with no stated cause. Let it throw and fail the run at its actual origin.
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

export async function setup(): Promise<void> {
  // No test DB configured -> every DB-backed suite self-skips, so there is nothing to build.
  // This is also what keeps `npm run test:iam-chain-alignment` free: that CI step sets no
  // DATABASE_URL_TEST because its two files are pure YAML/JSON parsing, so it pays nothing here.
  if (!TEST_URL) return;

  const template = templateDbName();

  // ⚠ THE ROLE IS CREATED BEFORE migrate(), AND THAT ORDER IS LOAD-BEARING.
  //
  // Some migrations grant privileges CONDITIONALLY on the runtime role already existing, because
  // role names differ between environments — `202608210218_monitoring_partition_roll_forward.sql`
  // REVOKEs EXECUTE on monitoring_ensure_result_partitions() from PUBLIC and then re-grants it only
  // `IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app_test')`; 0051 has the same
  // shape. Migrate first and that branch is simply skipped, leaving the function executable by
  // nobody: `permission denied for function monitoring_ensure_result_partitions` (SQLSTATE 42501)
  // out of every suite that sweeps monitors.
  //
  // This bites ONLY on a FRESH cluster, which is exactly why it needs stating rather than leaving to
  // ordering. The role is cluster-global, so a developer's long-lived local Postgres already has it
  // from an earlier run, migrate() sees it, and the suite passes locally while failing on CI's clean
  // Postgres. (The pre-template harness created the role per-file AFTER migrate() and survived by
  // luck: the FIRST file on a fresh cluster missed the grant too, and merely never happened to be
  // one that called this function.) Creating the role up front removes the ordering dependency.
  await withPool(TEST_URL, async (maintenance) => {
    await maintenance.query(`
      DO $$ BEGIN
        CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      -- Re-asserted unconditionally: the CREATE above swallows duplicate_object, so a pre-existing
      -- role keeps whatever password (and whatever BYPASSRLS) it was last left with. A role quietly
      -- granted BYPASSRLS would make every tenant-isolation suite pass for the wrong reason, which
      -- is far worse than the loud "password authentication failed" a wrong password gives.
      ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
    `);
  });

  // Recreate from scratch rather than reusing a leftover. A template left behind by a crashed run
  // may be half-migrated, and reusing it would seed EVERY file in this run with a broken schema —
  // the one failure mode that would be both total and hard to attribute.
  await withPool(TEST_URL, async (maintenance) => {
    await maintenance.query(`DROP DATABASE IF EXISTS ${template} WITH (FORCE)`);
    await maintenance.query(`CREATE DATABASE ${template}`);
  });

  const templateUrl = urlWithDb(TEST_URL, template);

  // migrate() reads config at call time and prefers migrateDatabaseUrl; blank it so a
  // MIGRATE_DATABASE_URL inherited from a developer's shell cannot redirect the migrations of a
  // throwaway template at some other database.
  config.migrateDatabaseUrl = "";
  config.databaseUrl = templateUrl;
  await migrate();

  // The role is cluster-global (created once, shared by every file); the GRANTs are per-database
  // catalog rows and are therefore COPIED into each `CREATE DATABASE ... TEMPLATE` child, which is
  // what lets the per-file path skip granting entirely. Granting after migrate() means ON ALL
  // TABLES covers every table the full migration history creates.
  await withPool(templateUrl, async (admin) => {
    await admin.query(`
      GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
    `);
  });
}

export async function teardown(): Promise<void> {
  if (!TEST_URL) return;
  const template = templateDbName();
  try {
    await withPool(TEST_URL, async (maintenance) => {
      await maintenance.query(`DROP DATABASE IF EXISTS ${template} WITH (FORCE)`);
    });
  } catch {
    // Best-effort: a leftover template is harmless (the next run drops and rebuilds it, and the
    // name is deterministic so they do not accumulate). Never fail a green run in teardown.
  }
}
