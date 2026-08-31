#!/usr/bin/env node
// WebDesk (Zone B) migration runner — WSK-01.
//
// Applies migrations/*.sql in ascending filename order, as the MIGRATOR role
// (MIGRATE_DATABASE_URL), recording each applied file by its full name in a ledger table
// (schema_migrations) so a re-run is a no-op — same discovery/ledger shape as platform-nest's
// `src/db/migrate.ts`, deliberately: this is Zone B's OWN ledger (own database, own role, starts
// at 0001), not a shared one, per design §04's "two ledgers, never mixed" rule.
//
// Usage:
//   MIGRATE_DATABASE_URL=postgres://webdesk_migrator:...@localhost:8383/webdesk node migrate.mjs
//   npm run migrate   (reads the same env var; load a .env first if you use one)

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = __dirname;

const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
`;

function discoverMigrationFiles() {
  // Plain lexicographic sort, same as platform-nest's runner: deterministic, platform-independent,
  // and correct for the "0001_", "0002_", ... numbering rule this ledger uses (NOT timestamps —
  // that is platform-nest's rule only, per design §04/WSK-01's scope).
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

async function main() {
  const connectionString = process.env.MIGRATE_DATABASE_URL;
  if (!connectionString) {
    console.error("[webdesk:migrate] MIGRATE_DATABASE_URL is not set — refusing to run.");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query(LEDGER_DDL);

    const { rows: appliedRows } = await client.query("SELECT name FROM schema_migrations");
    const applied = new Set(appliedRows.map((r) => r.name));

    const files = discoverMigrationFiles();
    let appliedCount = 0;
    let skippedCount = 0;

    for (const file of files) {
      if (applied.has(file)) {
        skippedCount++;
        continue;
      }

      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      console.log(`[webdesk:migrate] applying ${file} ...`);

      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        appliedCount++;
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`[webdesk:migrate] FAILED on ${file}:`, err.message);
        process.exitCode = 1;
        return;
      }
    }

    console.log(
      `[webdesk:migrate] done — ${files.length} file(s) discovered, ${appliedCount} applied, ` +
        `${skippedCount} already in the ledger.`,
    );
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (invokedDirectly) {
  main().catch((err) => {
    console.error("[webdesk:migrate] unexpected error:", err);
    process.exit(1);
  });
}

export { discoverMigrationFiles };
