// AIP-17b — migration 202610300400_ai_budgets.sql, the file's own text (no database needed; always runs). The live half is
// ai-budgets.db.test.ts.
//
// Proves: no data change (no INSERT, UPDATE, DELETE or TRUNCATE) and no row count of a FORCE-RLS table (the unset-GUC zero-row trap); LF only;
// every DDL statement is guarded so the file re-runs; each table is FORCE RLS with the one tenant_isolation policy; the ledger is granted
// SELECT and INSERT only while the two settings tables get all four verbs; platform_app is guarded by IF EXISTS.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const sql = readFileSync(join(__dirname, "..", "..", "..", "migrations", "202610300400_ai_budgets.sql"), "utf8");
const code = sql.split("\n").map((l) => (l.includes("--") ? l.slice(0, l.indexOf("--")) : l)).join("\n");

describe("AIP-17b · the migration file", () => {
  it("holds no data change", () => {
    expect(code).not.toMatch(/^\s*INSERT\s+INTO\b/im);
    expect(code).not.toMatch(/^\s*UPDATE\s+\S+\s+SET\b/im);
    expect(code).not.toMatch(/^\s*DELETE\s+FROM\b/im);
    expect(code).not.toMatch(/^\s*TRUNCATE\b/im);
    expect(code).not.toMatch(/schema_migrations/i);
  });

  it("is LF only, has no BOM, and never counts rows of a FORCE-RLS table", () => {
    expect(sql).not.toMatch(/\r/);
    expect(sql.charCodeAt(0)).not.toBe(0xfeff);
    expect(code).not.toMatch(/count\(\*\)\s+INTO\s+\w+\s+FROM\s+ai_(budgets|person_allowances|usage_alerts)\b/i);
  });

  it("every DDL statement is guarded, so the file re-runs", () => {
    for (const t of ["ai_budgets", "ai_person_allowances", "ai_usage_alerts"]) {
      expect(code).toContain(`CREATE TABLE IF NOT EXISTS ${t} (`);
      expect(code).toContain(`DROP POLICY IF EXISTS tenant_isolation ON ${t};`);
    }
    expect(code).toContain("CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_budgets_company ON ai_budgets (tenant_id) WHERE scope = 'company';");
    expect(code).toContain("CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_budgets_unit ON ai_budgets (tenant_id, unit_node_id) WHERE scope = 'unit';");
    expect(code).not.toMatch(/^\s*CREATE (TABLE|INDEX|UNIQUE INDEX)\s+(?!IF NOT EXISTS)/im);
    expect(code).not.toMatch(/^\s*DROP\s+(TABLE|INDEX|COLUMN)\b/im);
    // every ADD CONSTRAINT travels with its own DROP CONSTRAINT IF EXISTS in the same ALTER, so a re-run replaces and never stacks
    const adds = code.match(/ADD CONSTRAINT/g)?.length ?? 0;
    const drops = code.match(/DROP CONSTRAINT IF EXISTS/g)?.length ?? 0;
    expect(adds).toBe(8);
    expect(drops).toBe(adds);
  });

  it("each table is ENABLE + FORCE RLS with the one tenant_isolation policy over app_current_tenants()", () => {
    for (const t of ["ai_budgets", "ai_person_allowances", "ai_usage_alerts"]) {
      expect(code).toContain(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`);
      expect(code).toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`);
      const policy = new RegExp(String.raw`CREATE POLICY tenant_isolation ON ${t} FOR ALL\s+USING \(tenant_id = ANY\(app_current_tenants\(\)\)\)\s+WITH CHECK \(tenant_id = ANY\(app_current_tenants\(\)\)\);`);
      expect(code).toMatch(policy);
    }
    expect(code).not.toMatch(/app_module_allowed/);
  });

  it("grants: the settings tables get all four verbs, the ledger SELECT and INSERT only, all behind IF EXISTS platform_app", () => {
    expect(code).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'platform_app'\) THEN/);
    expect(code).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON ai_budgets TO platform_app;");
    expect(code).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON ai_person_allowances TO platform_app;");
    expect(code).toContain("GRANT SELECT, INSERT ON ai_usage_alerts TO platform_app;");
    expect(code).not.toMatch(/GRANT[^;]*(UPDATE|DELETE|TRUNCATE|ALL)[^;]*ON ai_usage_alerts/i);
  });

  it("a CHECK never rests on NULL passing: the figure and the scope are NOT NULL, and the shape CHECK names each branch", () => {
    expect(code).toMatch(/monthly_usd\s+numeric\(12,4\) NOT NULL/);
    expect(code).toMatch(/scope\s+text NOT NULL/);
    expect(code).toContain("(scope = 'company' AND unit_node_id IS NULL AND mode IS NULL)");
    expect(code).toContain("scope = 'unit' AND unit_node_id IS NOT NULL AND length(unit_node_id) BETWEEN 1 AND 120 AND mode IS NOT NULL AND mode IN ('report', 'soft_stop')");
  });
});
