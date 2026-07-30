// Test-DB harness. Needs DATABASE_URL_TEST (a superuser URL to a DISPOSABLE database) —
// suites skip without it. Applies migrations fresh, then repoints the app at a
// NOSUPERUSER NOBYPASSRLS role, because superusers bypass RLS and would test nothing.
//
// ISOLATION: every test FILE gets its own physical database (name derived deterministically
// from the file's path), not a shared `public` schema and not a single global reset. Two
// things rule out weaker fixes:
//
//  1. A single `DROP SCHEMA public CASCADE` against one shared database — even moved into a
//     `globalSetup` hook that runs once before any worker starts — still leaves every test
//     file's DATA in that same shared database. Fixtures across this suite use literal,
//     non-unique emails (e.g. "admin@a.test" appears in 20+ files) against a globally UNIQUE
//     `users.email`; two files in one shared database collide on that constraint the moment
//     both run in the same `vitest run`. A shared schema was never going to pass 3 clean
//     consecutive full-suite runs, only individual files run in isolation (which is exactly
//     the symptom this ticket was filed to fix).
//  2. `fileParallelism: false` alone (the pre-existing config) does not prevent overlap either:
//     each vitest worker/file gets a fresh module graph, so a finishing file's async teardown
//     (closing pools) can still overlap the next file's `DROP SCHEMA ... CASCADE`, racing for
//     the same locks/objects and deadlocking or dropping tables out from under a still-running
//     suite ("relation ... does not exist" was the observed symptom, at a nondeterministic
//     later file).
//
// Per-file physical databases make both classes of failure structurally impossible: locks,
// drops, unique constraints and idle-in-transaction stragglers are all scoped to one database
// each, so no two suites can ever contend for — or pollute — the same object, no matter how
// their hooks overlap in time.
//
// The database name is a hash of the test file's path, so it is the SAME across runs — a
// crashed run's leftover database (possibly with a stuck backend) is simply dropped-and-
// recreated (`WITH (FORCE)`, PG13+) the next time that file runs, instead of accumulating a
// new throwaway database forever. The set of databases stays bounded at "one per test file".
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { expect } from "vitest";
import { config } from "../config";
import { setPool, closePool } from "../db";
import { migrate } from "../db/migrate";

export const TEST_URL = process.env.DATABASE_URL_TEST ?? "";

const APP_ROLE = "platform_app_test";
const APP_PASSWORD = "test";

let admin: Pool | null = null;

/** Deterministic per-test-file database name. Falls back to a fixed name only if vitest can't
 *  report a test path (shouldn't happen — every caller invokes this from a running test
 *  file's beforeAll, which we verified vitest 2.1.9 reports correctly).
 *
 *  `TEST_DB_PREFIX` scopes the name to a RUNNER. The name is derived purely from the test path,
 *  so two `vitest run` invocations against the same Postgres compute the SAME database name and
 *  the second one's `DROP DATABASE ... WITH (FORCE)` yanks the first one's schema mid-run — the
 *  original SM-31 bug, moved from concurrent files to concurrent runs. That bites two agents (or
 *  two developers, or two CI jobs) sharing this server. Set a distinct prefix per concurrent
 *  runner to isolate them. Determinism is preserved WITHIN a prefix, so the bounded-database
 *  property still holds: a crashed run's leftover is reused and recreated, never accumulated. */
function perFileDbName(): string {
  const testPath = expect.getState().testPath ?? "shared";
  const hash = createHash("sha1").update(testPath).digest("hex").slice(0, 20);
  // Lowercased on purpose: Postgres folds unquoted identifiers, so a mixed-case prefix would be
  // CREATEd as one name and connected to as another — which fails as an unhelpful "database does
  // not exist" inside beforeAll, and vitest then reports the whole suite as *skipped* rather than
  // failed. Silent skips are the worst outcome here, so normalize instead of trusting the caller.
  const prefix = (process.env.TEST_DB_PREFIX ?? "pgtest_f").toLowerCase().replace(/[^a-z0-9_]/g, "");
  return `${prefix}_${hash}`;
}

function urlWithDb(baseUrl: string, database: string): string {
  const u = new URL(baseUrl);
  u.pathname = `/${database}`;
  return u.toString();
}

export async function initTestDb(): Promise<void> {
  if (!TEST_URL) throw new Error("DATABASE_URL_TEST not set");
  const dbName = perFileDbName();

  // Maintenance connection: connects to whatever database TEST_URL names, used ONLY to
  // CREATE/DROP this file's own database. CREATE/DROP DATABASE can't run inside a transaction
  // block and can't target the database the session is connected to, so this pool must never
  // point at `dbName` itself. `WITH (FORCE)` (PG13+) terminates any backends still attached —
  // safe here because `dbName` is unique to this file, so it can never disconnect another
  // suite (unlike the shared-DB `pg_terminate_backend` attempt this ticket rules out — that one
  // targeted the database every suite shared, so it killed concurrently-running suites too).
  const maintenance = new Pool({ connectionString: TEST_URL, max: 1 });
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await maintenance.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await maintenance.end();
  }

  const dbUrl = urlWithDb(TEST_URL, dbName);
  const localAdmin = new Pool({ connectionString: dbUrl });

  try {
    // Run migrations as the admin (owner), then hand the app a least-privilege role.
    config.databaseUrl = dbUrl;
    setPool(new Pool({ connectionString: dbUrl }));
    await migrate();
    await closePool();

    await localAdmin.query(`
      DO $$ BEGIN
        CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
    `);

    const app = new URL(dbUrl);
    app.username = APP_ROLE;
    app.password = APP_PASSWORD;
    config.databaseUrl = app.toString();
    setPool(new Pool({ connectionString: config.databaseUrl }));
    admin = localAdmin;
  } catch (err) {
    // Unconditional cleanup on a failed init: never leave a Pool (or an idle-in-transaction
    // connection) dangling on a database that a later run's DROP DATABASE would then have to
    // fight — with 74 suites sharing one Postgres instance, one leaked pool from a throwing
    // beforeAll must not compound into connection-limit failures for unrelated later files.
    await closePool().catch(() => {});
    await localAdmin.end().catch(() => {});
    admin = null;
    throw err;
  }
}

/** Escape hatch for assertions that must bypass RLS (verifying what is REALLY stored). */
export function adminPool(): Pool {
  if (!admin) throw new Error("initTestDb first");
  return admin;
}

export async function teardownTestDb(): Promise<void> {
  await closePool().catch(() => {});
  await admin?.end().catch(() => {});
  admin = null;
}
