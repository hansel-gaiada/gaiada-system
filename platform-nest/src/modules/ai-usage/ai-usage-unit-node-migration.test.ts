// AIP-15a — migration 202610300300_ai_usage_unit_node.sql, the file's own text (no database needed; always runs). The live half is
// ai-usage-unit-node.db.test.ts.
//
// Proves: the file holds no data change at all (no INSERT, UPDATE, DELETE, TRUNCATE or ledger write) and never counts the FORCE-RLS table
// (the unset-GUC zero-row trap); it is LF only; every DDL statement is guarded so it re-runs; the view is recreated with security_invoker
// and unit_node_id LAST; it does not touch the append-only trigger function (the new column is immutable through it as it stands).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const MIGRATION = "202610300300_ai_usage_unit_node.sql";
const sql = readFileSync(join(__dirname, "..", "..", "..", "migrations", MIGRATION), "utf8");
const code = sql.split("\n").map((l) => (l.includes("--") ? l.slice(0, l.indexOf("--")) : l)).join("\n");

describe("AIP-15a · the migration file", () => {
  it("holds no data change and no ledger write", () => {
    expect(code).not.toMatch(/^\s*INSERT\s+INTO\b/im);
    expect(code).not.toMatch(/^\s*UPDATE\s+\S+\s+SET\b/im);
    expect(code).not.toMatch(/^\s*DELETE\s+FROM\b/im);
    expect(code).not.toMatch(/^\s*TRUNCATE\b/im);
    expect(code).not.toMatch(/schema_migrations/i);
  });

  it("is LF only, and never counts rows of the FORCE-RLS table", () => {
    expect(sql).not.toMatch(/\r/);
    expect(sql.charCodeAt(0)).not.toBe(0xfeff);
    expect(code).not.toMatch(/count\(\*\)\s+INTO\s+\w+\s+FROM\s+ai_usage_events\b/i);
  });

  it("every DDL statement is guarded, so the file re-runs", () => {
    expect(code).toMatch(/ALTER TABLE ai_usage_events ADD COLUMN IF NOT EXISTS unit_node_id text;/);
    expect(code).toMatch(/DROP CONSTRAINT IF EXISTS ck_ai_usage_events_unit_node_id,\s*ADD CONSTRAINT ck_ai_usage_events_unit_node_id/);
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS ix_ai_usage_events_unit_node_day ON ai_usage_events \(tenant_id, unit_node_id, occurred_at\);/);
    expect(code).toMatch(/CREATE OR REPLACE VIEW ai_usage_daily WITH \(security_invoker = true\) AS/);
    expect(code).not.toMatch(/^\s*CREATE (TABLE|INDEX|VIEW)\s+(?!IF NOT EXISTS)(?!OR REPLACE)/im);
    expect(code).not.toMatch(/^\s*DROP\s+(TABLE|VIEW|INDEX|COLUMN)\b/im);
  });

  it("caps the column at 120 characters and allows NULL (old rows, no person, no placement)", () => {
    expect(code).toContain("CHECK (unit_node_id IS NULL OR length(unit_node_id) BETWEEN 1 AND 120)");
    expect(code).not.toMatch(/unit_node_id\s+text\s+NOT NULL/i);
  });

  it("appends unit_node_id as the view's LAST column and groups by it", () => {
    const view = /CREATE OR REPLACE VIEW ai_usage_daily[\s\S]*?;/.exec(code)![0];
    const select = view.slice(view.indexOf("SELECT") + 6, view.indexOf("FROM ai_usage_events")).trim();
    const lastCol = select.split(",").map((c) => c.trim()).filter(Boolean).pop();
    expect(lastCol).toBe("unit_node_id");
    expect(view).toMatch(/GROUP BY tenant_id, \(occurred_at AT TIME ZONE 'UTC'\)::date, org_unit_id, user_id, surface, provider, model, unit_node_id;/);
  });

  it("leaves the append-only trigger function alone (it already covers every column but the two identities)", () => {
    expect(code).not.toMatch(/CREATE (OR REPLACE )?FUNCTION ai_usage_events_append_only/i);
    expect(code).not.toMatch(/DROP TRIGGER/i);
  });
});
