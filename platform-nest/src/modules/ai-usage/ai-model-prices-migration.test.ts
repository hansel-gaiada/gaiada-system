// AIP-04 — the migration file's own text (no database needed; always runs). The live half is ai-model-prices.db.test.ts.
//
// Proves: no rows are seeded (a price is never invented); the table is global reference data (no tenant_id, no RLS, nothing that would trip the
// FORCE-RLS lints); the runtime role is granted SELECT and nothing else; the column set and primary key are the agreed ones; the file is LF only and
// never counts or writes rows of a table that is not its own; the numbering follows the AIP-01 file.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const DIR = join(__dirname, "..", "..", "..", "migrations");
const MIGRATION = "202610271810_ai_model_prices.sql";
const sql = readFileSync(join(DIR, MIGRATION), "utf8");
const code = sql.split("\n").map((l) => (l.includes("--") ? l.slice(0, l.indexOf("--")) : l)).join("\n");

describe("AIP-04 · the migration file", () => {
  it("seeds NOTHING: no INSERT, UPDATE, DELETE or TRUNCATE (no price is invented; the owner or an admin enters them)", () => {
    expect(code).not.toMatch(/^\s*INSERT\s+INTO\b/im);
    expect(code).not.toMatch(/^\s*UPDATE\s+\S+\s+SET\b/im);
    expect(code).not.toMatch(/^\s*DELETE\s+FROM\b/im);
    expect(code).not.toMatch(/^\s*TRUNCATE\b/im);
    expect(code).not.toMatch(/schema_migrations/i);
  });

  it("is global reference data: no tenant_id column, no RLS statement of any kind", () => {
    expect(code).not.toMatch(/^\s+tenant_id\s+\w+/m); // a column definition; the COMMENT text may say "no tenant_id"
    expect(code).not.toMatch(/ENABLE ROW LEVEL SECURITY|FORCE ROW LEVEL SECURITY/i);
    expect(code).not.toMatch(/CREATE POLICY/i);
  });

  it("creates the agreed columns with the primary key (provider, model, effective_from)", () => {
    for (const col of [
      /provider\s+text\s+NOT NULL/, /model\s+text\s+NOT NULL/, /prompt_usd_per_mtok\s+numeric\(14,6\)\s+NOT NULL/,
      /completion_usd_per_mtok\s+numeric\(14,6\)\s+NOT NULL/, /effective_from\s+date\s+NOT NULL/, /\bnote\s+text\b/,
    ]) expect(code).toMatch(col);
    expect(code).toMatch(/PRIMARY KEY \(provider, model, effective_from\)/);
  });

  it("grants the runtime role SELECT only, after revoking the owner's default DML", () => {
    expect(code).toMatch(/REVOKE ALL ON ai_model_prices FROM platform_app/);
    expect(code).toMatch(/GRANT SELECT ON ai_model_prices TO platform_app/);
    expect(code).not.toMatch(/GRANT[^;]*\b(INSERT|UPDATE|DELETE|ALL)\b[^;]*ON ai_model_prices TO platform_app/i);
    expect(code).toMatch(/REVOKE ALL ON ai_model_prices FROM sync_app/);
  });

  it("is LF only", () => {
    expect(sql).not.toMatch(/\r/);
  });

  it("sorts after the ai_usage_events migration it depends on, and its filename is unique in the directory", () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
    const usage = files.find((f) => /_ai_usage_events\.sql$/.test(f));
    expect(usage).toBeDefined();
    expect(files.indexOf(MIGRATION)).toBeGreaterThan(files.indexOf(usage!));
    expect(files.filter((f) => f.startsWith(MIGRATION.slice(0, 12)))).toEqual([MIGRATION]);
  });

  it("asserts the catalogue, never a row count", () => {
    expect(code).not.toMatch(/count\(\*\)\s+INTO\s+\w+\s+FROM\s+ai_model_prices\b/i);
  });
});
