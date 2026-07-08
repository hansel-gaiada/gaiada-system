// Ordered-SQL migration runner (ported from the Fastify core, CommonJS variant). Each
// migrations/NNNN_*.sql applies once, in a transaction, recorded in schema_migrations.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPool } from "./index";

// platform-nest owns its own migrations/ (copied at port time; the cutover deletes platform/).
const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

export async function migrate(): Promise<string[]> {
  const pool = getPool();
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
  return ran;
}

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
