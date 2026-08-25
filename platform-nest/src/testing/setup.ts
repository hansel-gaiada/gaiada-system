// Test-DB harness. Needs DATABASE_URL_TEST (a superuser URL to a DISPOSABLE database) —
// suites skip without it. Each test file gets a fresh, already-migrated database, then the app is
// repointed at a NOSUPERUSER NOBYPASSRLS role, because superusers bypass RLS and would test
// nothing.
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
//  2. `fileParallelism: false` does not prevent overlap either: each vitest worker/file gets a
//     fresh module graph, so a finishing file's async teardown (closing pools) can still overlap
//     the next file's `DROP SCHEMA ... CASCADE`, racing for the same locks/objects and deadlocking
//     or dropping tables out from under a still-running suite ("relation ... does not exist" was
//     the observed symptom, at a nondeterministic later file).
//
// Per-file physical databases make both classes of failure structurally impossible: locks,
// drops, unique constraints and idle-in-transaction stragglers are all scoped to one database
// each, so no two suites can ever contend for — or pollute — the same object, no matter how
// their hooks overlap in time. That is also what makes file parallelism safe (vitest.config.ts).
//
// SCHEMA COMES FROM A TEMPLATE, NOT FROM migrate(). This file used to call `migrate()` itself,
// which meant 166 migrations per test file and, across 292 DB-backed files, ~48,000 migration
// transactions and 1219s — 90% of the whole `ci` workflow's wall clock. global-setup.ts now
// migrates ONE template database per run and each file copies it. See that file for the full
// rationale; the isolation property above is untouched, only the fill mechanism changed.
import { Pool } from "pg";
import { expect } from "vitest";
import { config } from "../config";
import { setPool, closePool, attachPoolErrorHandler } from "../db";
import { APP_PASSWORD, APP_ROLE, perFileDbName, templateDbName, urlWithDb } from "./db-names";

export const TEST_URL = process.env.DATABASE_URL_TEST ?? "";

let admin: Pool | null = null;

/** Falls back to a fixed name only if vitest can't report a test path (shouldn't happen — every
 *  caller invokes this from a running test file's beforeAll, which vitest 2.1.9 reports
 *  correctly). */
function currentDbName(): string {
  return perFileDbName(expect.getState().testPath ?? "shared");
}

export async function initTestDb(): Promise<void> {
  if (!TEST_URL) throw new Error("DATABASE_URL_TEST not set");
  const dbName = currentDbName();
  const template = templateDbName();

  // Maintenance connection: connects to whatever database TEST_URL names, used ONLY to
  // CREATE/DROP this file's own database. CREATE/DROP DATABASE can't run inside a transaction
  // block and can't target the database the session is connected to, so this pool must never
  // point at `dbName` itself. `WITH (FORCE)` (PG13+) terminates any backends still attached —
  // safe here because `dbName` is unique to this file, so it can never disconnect another
  // suite (unlike the shared-DB `pg_terminate_backend` attempt this ticket rules out — that one
  // targeted the database every suite shared, so it killed concurrently-running suites too).
  const maintenance = new Pool({ connectionString: TEST_URL, max: 1 });
  attachPoolErrorHandler(maintenance);
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    // ⚠ RETRIED. Postgres refuses `CREATE DATABASE ... TEMPLATE t` while any session is connected
    // to `t` ("source database is being accessed by other users"). global-setup.ts closes every
    // pool it opens before returning, so steady state is zero connections — but concurrent workers
    // all copying the same template can still transiently collide on the lock this takes. Bounded
    // and short: the loser only needs the winner's copy to finish.
    for (let attempt = 1; ; attempt++) {
      try {
        await maintenance.query(`CREATE DATABASE ${dbName} TEMPLATE ${template}`);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Only contention is retryable. A MISSING template means globalSetup never ran (or ran
        // under a different TEST_DB_PREFIX) — that must fail loudly on the first attempt, because
        // retrying it only turns one legible error into a slow one.
        if (!/being accessed by other users|source database.*in use/i.test(msg) || attempt >= 10) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 100 * attempt));
      }
    }
  } finally {
    await maintenance.end();
  }

  const dbUrl = urlWithDb(TEST_URL, dbName);
  const localAdmin = new Pool({ connectionString: dbUrl });
  attachPoolErrorHandler(localAdmin);

  try {
    // No migrate() and no CREATE/GRANT for APP_ROLE here: the template arrived fully migrated and
    // its per-database GRANTs were copied along with it. The role itself is cluster-global and was
    // asserted once in globalSetup — which is also what removes the `tuple concurrently updated`
    // catalog race this function used to carry a five-attempt retry loop for.
    const app = new URL(dbUrl);
    app.username = APP_ROLE;
    app.password = APP_PASSWORD;
    config.databaseUrl = app.toString();
    setPool(new Pool({ connectionString: config.databaseUrl }));
    admin = localAdmin;
  } catch (err) {
    // Unconditional cleanup on a failed init: never leave a Pool (or an idle-in-transaction
    // connection) dangling on a database that a later run's DROP DATABASE would then have to
    // fight — with 292 suites sharing one Postgres instance, one leaked pool from a throwing
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

  // Actually drop the physical database initTestDb created — this is the fix for the
  // per-file-database leak (615 abandoned databases once exhausted Docker's 64MB /dev/shm).
  // `admin` (just closed above) was connected to `dbName` itself, and Postgres refuses to
  // DROP DATABASE on the database a session is connected to — so the drop CANNOT run over
  // `admin`; it needs its own maintenance connection to whatever database TEST_URL names
  // (normally `postgres`), exactly mirroring the CREATE/DROP pairing in initTestDb above.
  // `WITH (FORCE)` (PG13+; confirmed running 17.10 here) terminates any straggling backends —
  // safe for the same reason it's safe in initTestDb: dbName is unique to this file, so FORCE
  // can never disconnect a different suite's database.
  //
  // Guarded end-to-end so a teardown hiccup never fails an otherwise-passing suite: no-op if
  // TEST_URL was never set, `IF EXISTS` makes a second teardown call (or a setup that failed
  // before creating anything) a no-op, and the query itself is wrapped so any error is
  // swallowed rather than thrown — matching the `.catch(() => {})` swallowing already used
  // for closePool/admin.end above.
  if (!TEST_URL) return;
  const dbName = currentDbName();
  const maintenance = new Pool({ connectionString: TEST_URL, max: 1 });
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  } catch {
    // best-effort cleanup only — never fail the suite over a teardown hiccup
  } finally {
    await maintenance.end().catch(() => {});
  }
}
