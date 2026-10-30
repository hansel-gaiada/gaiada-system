// AIP-18 — migration 202610301340_assistant_handoff_held.sql, the file's own text (no database needed; always runs). The live half (the CHECK
// refuses and accepts the right rows on a real table) is in assistant-soft-stop.test.ts.
//
// THE CHECK REDECLARE (the DROP+ADD-on-a-shared-CHECK trap): the new status list must carry EVERY value of 0084's inline CHECK, read from
// 0084's own text here (not from a copy), plus `held`; and no later migration may have touched the status CHECK in between (if one ever does,
// this test must learn its values too). Also: no data change, LF, guarded DDL, and the old inline constraint is dropped by its real name.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const dir = join(__dirname, "..", "..", "..", "migrations");
const FILE = "202610301340_assistant_handoff_held.sql";
const sql = readFileSync(join(dir, FILE), "utf8");
const strip = (s: string) => s.split("\n").map((l) => (l.includes("--") ? l.slice(0, l.indexOf("--")) : l)).join("\n");
const code = strip(sql);

/** The values of a `status IN (...)` list in SQL text. */
function statusValues(text: string): string[] {
  const m = /status IN \(([^)]*)\)/.exec(text);
  if (!m) throw new Error("no status IN (...) list");
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

describe("AIP-18 · the held-hand-off migration file", () => {
  it("redeclares the status CHECK with every value 0084 had, plus held", () => {
    const original = statusValues(strip(readFileSync(join(dir, "0084_assistant_handoffs.sql"), "utf8")));
    expect(original).toEqual(["queued", "running", "ok", "suspended", "budget_exhausted", "failed", "interrupted", "cancelled"]);
    const block = /ADD CONSTRAINT ck_assistant_handoffs_status CHECK \(([\s\S]*?)\);/.exec(code);
    expect(block).not.toBeNull();
    const next = statusValues(block![1]);
    for (const v of original) expect(next).toContain(v);
    expect(next).toContain("held");
    expect(next.length).toBe(original.length + 1);
    // the self-check asserts the same nine values against the catalogue
    for (const v of [...original, "held"]) expect(code).toMatch(new RegExp(`ARRAY\\[[^\\]]*'${v}'`));
  });

  it("no migration between 0084 and this one touches assistant_handoffs' status CHECK", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const from = files.indexOf("0084_assistant_handoffs.sql");
    const to = files.indexOf(FILE);
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);
    for (const f of files.slice(from + 1, to)) {
      const text = strip(readFileSync(join(dir, f), "utf8"));
      expect(/ALTER TABLE\s+(IF EXISTS\s+)?assistant_handoffs\b/i.test(text), `${f} alters assistant_handoffs`).toBe(false);
    }
  });

  it("drops 0084's inline constraint by its Postgres name, and every ADD CONSTRAINT travels with its own DROP IF EXISTS", () => {
    expect(code).toContain("DROP CONSTRAINT IF EXISTS assistant_handoffs_status_check");
    const adds = code.match(/ADD CONSTRAINT/g)?.length ?? 0;
    expect(adds).toBe(4);
    for (const name of ["ck_assistant_handoffs_status", "ck_assistant_handoffs_hold_shape", "ck_assistant_handoffs_held_has_hold", "ck_assistant_handoffs_goal_id"]) {
      expect(code).toContain(`DROP CONSTRAINT IF EXISTS ${name}`);
      expect(code).toContain(`ADD CONSTRAINT ${name} CHECK`);
    }
  });

  it("a goal id may be missing only on a row that was held (held, cancelled while held, or failed to start)", () => {
    expect(code).toContain("ALTER COLUMN goal_id DROP NOT NULL");
    expect(code).toContain("goal_id IS NOT NULL OR (hold_kind IS NOT NULL AND status IN ('held', 'cancelled', 'failed'))");
    expect(code).toContain("CHECK (status <> 'held' OR hold_kind IS NOT NULL)");
  });

  it("holds no data change, is LF only with no BOM, and every column and index is guarded", () => {
    expect(code).not.toMatch(/^\s*INSERT\s+INTO\b/im);
    expect(code).not.toMatch(/^\s*UPDATE\s+\S+\s+SET\b/im);
    expect(code).not.toMatch(/^\s*DELETE\s+FROM\b/im);
    expect(code).not.toMatch(/count\(\*\)\s+INTO\s+\w+\s+FROM\s+assistant_handoffs\b/i);
    expect(sql).not.toMatch(/\r/);
    expect(sql.charCodeAt(0)).not.toBe(0xfeff);
    for (const col of ["hold_kind text", "hold_unit_node_id text", "held_at timestamptz"]) expect(code).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
    expect(code).toContain("CREATE INDEX IF NOT EXISTS ix_assistant_handoffs_held ON assistant_handoffs (tenant_id, created_at) WHERE status = 'held';");
    expect(code).not.toMatch(/DISABLE ROW LEVEL SECURITY|DROP POLICY/i);
  });
});
