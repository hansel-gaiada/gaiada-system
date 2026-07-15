// Shared guard for the DB-backed knowledge tests. They need a disposable Postgres
// (DATABASE_URL_TEST). Previously they gated only on the var being SET — but `dotenv` loads a
// local `.env` that points at a `gaiada_knowledge_test` DB which may not exist, so the guard was
// defeated and the suite hard-CRASHED on connect instead of skipping. This probes actual
// reachability so the tests RUN where the DB exists (CI, or an ephemeral Docker PG) and SKIP
// cleanly where it doesn't — no test is weakened, only the skip condition is made honest.
import "dotenv/config";
import { Pool } from "pg";

export const TEST_DB_URL = process.env.DATABASE_URL_TEST ?? "";

/** True only if DATABASE_URL_TEST is set AND a `SELECT 1` succeeds within a short timeout. */
export async function testDbReachable(): Promise<boolean> {
  if (!TEST_DB_URL) return false;
  const pool = new Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 1500 });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}
