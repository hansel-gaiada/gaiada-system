// AIP-01 — the migration file's own text (no database needed; always runs). The live half is ai-usage.db.test.ts.
//
// Proves: each closed vocabulary in vocab.ts is the very list the migration's CHECK carries (drift fails here); the file holds no data
// change beyond the erasure function's one UPDATE, no ledger write and no CRLF; it asserts the catalogue and never counts the FORCE-RLS
// table (the unset-GUC zero-row trap); the column set is closed and has no column that could hold text.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { AI_USAGE_CAPABILITIES, AI_USAGE_COST_SOURCES, AI_USAGE_OUTCOMES, AI_USAGE_SURFACES, AI_USAGE_TOKENS_SOURCES } from "./vocab";

const MIGRATION = "202610271800_ai_usage_events.sql";
const sql = readFileSync(join(__dirname, "..", "..", "..", "migrations", MIGRATION), "utf8");
const code = sql.split("\n").map((l) => (l.includes("--") ? l.slice(0, l.indexOf("--")) : l)).join("\n");
const list = (v: readonly string[]) => `IN (${v.map((x) => `'${x}'`).join(", ")})`;

describe("AIP-01 · the migration file", () => {
  it("each vocabulary in vocab.ts is exactly the CHECK list in the migration", () => {
    expect(code).toContain(`CHECK (surface ${list(AI_USAGE_SURFACES)})`);
    expect(code).toContain(`CHECK (capability ${list(AI_USAGE_CAPABILITIES)})`);
    expect(code).toContain(`CHECK (tokens_source ${list(AI_USAGE_TOKENS_SOURCES)})`);
    expect(code).toContain(`CHECK (outcome ${list(AI_USAGE_OUTCOMES)})`);
    expect(code).toContain(`CHECK (cost_source IS NULL OR cost_source ${list(AI_USAGE_COST_SOURCES)})`);
  });

  it("holds no INSERT, DELETE, TRUNCATE or ledger write, and its only UPDATE is the erasure function's", () => {
    expect(code).not.toMatch(/^\s*INSERT\s+INTO\b/im);
    expect(code).not.toMatch(/^\s*DELETE\s+FROM\b/im);
    expect(code).not.toMatch(/^\s*TRUNCATE\b/im);
    expect(code).not.toMatch(/schema_migrations/i);
    const updates = code.match(/^\s*UPDATE\s+\S+\s+SET\b.*$/gim) ?? [];
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/UPDATE ai_usage_events SET user_id = NULL WHERE user_id = p_user/);
  });

  it("is LF only, and never counts rows of the FORCE-RLS table", () => {
    expect(sql).not.toMatch(/\r/);
    expect(code).not.toMatch(/count\(\*\)\s+INTO\s+\w+\s+FROM\s+ai_usage_events\b/i);
  });

  it("closes the column set, and no column is text-shaped", () => {
    const m = /IS DISTINCT FROM '([a-z_,]+)' THEN/.exec(code);
    expect(m).not.toBeNull();
    const cols = m![1].split(",");
    expect(cols).toHaveLength(20);
    for (const c of cols) expect(c).not.toMatch(/prompt$|answer|content|message|body|text|transcript|args|payload/);
    expect(code).not.toMatch(/^\s+\w+\s+jsonb?\b/im);
  });

  it("grants the runtime role SELECT and INSERT only, never UPDATE or DELETE", () => {
    expect(code).toMatch(/GRANT SELECT, INSERT ON ai_usage_events TO platform_app/);
    expect(code).not.toMatch(/GRANT[^;]*\b(UPDATE|DELETE|ALL)\b[^;]*ON ai_usage_events TO platform_app/i);
  });
});
