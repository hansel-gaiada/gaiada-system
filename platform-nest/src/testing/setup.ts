// Test-DB harness. Needs DATABASE_URL_TEST (a superuser URL to a DISPOSABLE database) —
// suites skip without it. Applies migrations fresh, then repoints the app at a
// NOSUPERUSER NOBYPASSRLS role, because superusers bypass RLS and would test nothing.
import { Pool } from "pg";
import { config } from "../config";
import { setPool, closePool } from "../db";
import { migrate } from "../db/migrate";

export const TEST_URL = process.env.DATABASE_URL_TEST ?? "";

const APP_ROLE = "platform_app_test";
const APP_PASSWORD = "test";

let admin: Pool | null = null;
let initialized = false;

export async function initTestDb(): Promise<void> {
  if (!TEST_URL) throw new Error("DATABASE_URL_TEST not set");
  admin = new Pool({ connectionString: TEST_URL });
  if (!initialized) {
    await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    initialized = true;
  }
  // Run migrations as the admin (owner), then hand the app a least-privilege role.
  config.databaseUrl = TEST_URL;
  setPool(new Pool({ connectionString: TEST_URL }));
  await migrate();
  await closePool();

  await admin.query(`
    DO $$ BEGIN
      CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
  `);

  const app = new URL(TEST_URL);
  app.username = APP_ROLE;
  app.password = APP_PASSWORD;
  config.databaseUrl = app.toString();
  setPool(new Pool({ connectionString: config.databaseUrl }));
}

/** Escape hatch for assertions that must bypass RLS (verifying what is REALLY stored). */
export function adminPool(): Pool {
  if (!admin) throw new Error("initTestDb first");
  return admin;
}

export async function teardownTestDb(): Promise<void> {
  await closePool();
  await admin?.end();
  admin = null;
}
