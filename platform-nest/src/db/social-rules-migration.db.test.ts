// SCP-5 W5-A0 — 202610301000_social_rules.sql (BFF §63.30.3) against LIVE Postgres. Needs DATABASE_URL_TEST; skipped without it (the
// file-text checks at the top always run). initTestDb() hands us a fully migrated database; the CHECKs and triggers are proved through the
// superuser pool, which bypasses RLS but never a CHECK, a NOT NULL or a trigger; the WALL through `withTenants` / `withGlobal` (the runtime
// role, which RLS binds).
//
// Proves: each CHECK of social_rule_versions refuses its bad value and admits the good one, NULL cases included (SQL NULL by NOT NULL, a JSON
// null by the object CHECK); versions are consecutive per company (a gap, a repeat and a version 0 refused; another company starts at 1);
// the table refuses UPDATE and DELETE; the third wall (an unset tenant GUC, a missing module scope and another tenant all read zero rows);
// `rules_ref` on social_reports and social_cycles: the default 'default:scp-5a', the shape CHECK with its NULL case; and that applying the
// file to tables WITHOUT the column (as on the live estate before it lands) gives every existing row 'default:scp-5a' and changes nothing
// else, and applying it again changes no row.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId, withGlobal, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createClient, createCompany, createUser } from "../testing/fixtures";
import { socialModule } from "../modules/social/index";

const MIGRATION = "202610301000_social_rules.sql";
const PATH = join(__dirname, "..", "..", "migrations", MIGRATION);

describe("W5-A0 · the migration file (no database needed)", () => {
  const sql = readFileSync(PATH, "utf8");
  const code = sql.split("\n").map((l) => (l.includes("--") ? l.slice(0, l.indexOf("--")) : l)).join("\n");

  it("is registered in the social module, after every earlier social migration", () => {
    expect(socialModule.migrations).toContain(MIGRATION);
    expect(socialModule.migrations[socialModule.migrations.length - 1]).toBe(MIGRATION);
  });

  it("holds no data change, no grant, no ledger write, nothing that widens, and is LF only", () => {
    expect(code).not.toMatch(/^\s*INSERT\s+INTO\b/im);
    expect(code).not.toMatch(/^\s*UPDATE\s+\S+\s+SET\b/im);
    expect(code).not.toMatch(/^\s*DELETE\s+FROM\b/im);
    expect(code).not.toMatch(/\bTRUNCATE\b/i);
    expect(code).not.toMatch(/\bGRANT\b/i);
    expect(code).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(code).not.toMatch(/\bBYPASSRLS\b/i);
    expect(code).not.toMatch(/schema_migrations/i);
    expect(sql).not.toMatch(/\r/);
  });
});

describe.skipIf(!TEST_URL)("W5-A0 · social_rule_versions and rules_ref", () => {
  let A: string;
  let C: string;
  let editor: string;
  let engA: string;
  const db = () => adminPool();
  const refusedWith = async (p: Promise<unknown>, code: string) => {
    await expect(p).rejects.toMatchObject({ code });
  };

  /** A version row for `tenant`; `over` replaces columns with SQL literals. */
  async function insertVersion(tenant: string, version: number, over: Record<string, string> = {}): Promise<void> {
    const cols: Record<string, string> = {
      tenant_id: `'${tenant}'`, version: String(version), rules: `'{"ideas": {"metricRequired": true, "sharedInMonthlyReport": false}}'::jsonb`,
      section: "'ideas'", defaults_version: "'scp5-2026-10-30'", edited_by: `'${editor}'`, ...over,
    };
    await db().query(`INSERT INTO social_rule_versions (${Object.keys(cols).join(", ")}) VALUES (${Object.values(cols).join(", ")})`);
  }
  async function insertReport(over: Record<string, string> = {}): Promise<string> {
    const id = newId();
    const cols: Record<string, string> = { id: `'${id}'`, tenant_id: `'${A}'`, engagement_id: `'${engA}'`, period: "'2026-09'", ...over };
    await db().query(`INSERT INTO social_reports (${Object.keys(cols).join(", ")}) VALUES (${Object.values(cols).join(", ")})`);
    return id;
  }
  let monthSeq = 0;
  async function insertCycle(over: Record<string, string> = {}): Promise<string> {
    const id = newId();
    monthSeq += 1;
    const month = `${2040 + Math.floor(monthSeq / 12)}-${String((monthSeq % 12) + 1).padStart(2, "0")}-01`;
    const cols: Record<string, string> = {
      id: `'${id}'`, tenant_id: `'${A}'`, engagement_id: `'${engA}'`, month: `'${month}'`, deadline: `'${month}'`, ready_by: `'${month}'`, ...over,
    };
    await db().query(`INSERT INTO social_cycles (${Object.keys(cols).join(", ")}) VALUES (${Object.values(cols).join(", ")})`);
    return id;
  }

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("W5A0 Mock Agency", ["social"]);
    C = await createCompany("W5A0 Mock Other", ["social"]);
    editor = await createUser("w5a0-editor@mock.test", "Mock Editor");
    engA = newId();
    const client = await createClient(A, "W5A0 Mock Client");
    await db().query(`INSERT INTO social_engagements (id, tenant_id, client_id, name) VALUES ($1, $2, $3, 'Mock engagement')`, [engA, A, client]);
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  it("versions are consecutive per company: 1 first, then 2; a gap, a repeat and a 0 are refused; another company starts at 1", async () => {
    await refusedWith(insertVersion(A, 2), "23514"); // a gap before the first
    await insertVersion(A, 1);
    await refusedWith(insertVersion(A, 1), "23514"); // a repeat (the trigger speaks before the key)
    await refusedWith(insertVersion(A, 3), "23514"); // a gap
    await insertVersion(A, 2, { section: "'reports'", reset: "true" });
    await insertVersion(C, 1);
    const rows = (await db().query(`SELECT tenant_id, version FROM social_rule_versions ORDER BY tenant_id = $1 DESC, version`, [A])).rows;
    expect(rows.map((r) => r.version)).toEqual([1, 2, 1]);
  });

  it("each CHECK refuses its bad value, JSON null included; SQL NULL is refused by NOT NULL; the FK by the users table", async () => {
    const next = async () => Number((await db().query(`SELECT coalesce(max(version), 0) + 1 AS n FROM social_rule_versions WHERE tenant_id = $1`, [A])).rows[0].n);
    const v = await next();
    for (const bad of [`'[]'::jsonb`, `'"text"'::jsonb`, `'1'::jsonb`, `'null'::jsonb`]) await refusedWith(insertVersion(A, v, { rules: bad }), "23514");
    await refusedWith(insertVersion(A, v, { rules: "NULL" }), "23502");
    for (const bad of [`'people'`, `'Reports'`, `''`]) await refusedWith(insertVersion(A, v, { section: bad }), "23514");
    await refusedWith(insertVersion(A, v, { section: "NULL" }), "23502");
    for (const bad of [`'Bad Version'`, `''`, `'-x'`, `'${"x".repeat(61)}'`]) await refusedWith(insertVersion(A, v, { defaults_version: bad }), "23514");
    await refusedWith(insertVersion(A, v, { defaults_version: "NULL" }), "23502");
    await refusedWith(insertVersion(A, v, { reset: "NULL" }), "23502");
    await refusedWith(insertVersion(A, v, { edited_by: "NULL" }), "23502");
    await refusedWith(insertVersion(A, v, { edited_by: `'${newId()}'` }), "23503");
    await refusedWith(insertVersion(A, v, { effective_from: "NULL" }), "23502");
    await refusedWith(insertVersion(A, 0), "23514");
    await refusedWith(insertVersion(A, v, { version: "NULL" }), "23514"); // the trigger: NULL is never the next version
    await insertVersion(A, v, { section: "'audit'", defaults_version: "'scp-5a'" });
    const row = (await db().query(`SELECT reset, origin_site, effective_from IS NOT NULL AS dated FROM social_rule_versions WHERE tenant_id = $1 AND version = $2`, [A, v])).rows[0];
    expect(row).toEqual({ reset: false, origin_site: "central", dated: true });
  });

  it("the table is append-only: UPDATE and DELETE are refused, even to the owner", async () => {
    await expect(db().query(`UPDATE social_rule_versions SET reset = true WHERE tenant_id = $1`, [A])).rejects.toThrow(/append-only/);
    await expect(db().query(`DELETE FROM social_rule_versions WHERE tenant_id = $1`, [A])).rejects.toThrow(/append-only/);
  });

  it("the third wall: an unset GUC reads ZERO rows, the tenant without the module scope reads zero, another tenant none", async () => {
    const q = `SELECT count(*)::int AS n FROM social_rule_versions WHERE tenant_id = $1`;
    expect((await db().query(q, [A])).rows[0].n).toBeGreaterThan(0);
    expect((await withGlobal((c) => c.query<{ n: number }>(q, [A]))).rows[0].n, "unset GUC").toBe(0);
    expect((await withTenants([A], (c) => c.query<{ n: number }>(q, [A]))).rows[0].n, "no module scope").toBe(0);
    expect((await withTenants([C], (c) => c.query<{ n: number }>(q, [A]), { modules: ["social"] })).rows[0].n, "another tenant").toBe(0);
    expect((await withTenants([A], (c) => c.query<{ n: number }>(q, [A]), { modules: ["social"] })).rows[0].n, "the company").toBeGreaterThan(0);
    // Writing for another company through the wall is refused (version 1: the trigger, reading as A, sees none of C's rows, so the
    // policy's WITH CHECK is what refuses it).
    await expect(withTenants([A], (c) => c.query(
      `INSERT INTO social_rule_versions (tenant_id, version, rules, section, defaults_version, edited_by) VALUES ($1, 1, '{}'::jsonb, 'ideas', 'x', $2)`,
      [C, editor],
    ), { modules: ["social"] })).rejects.toThrow(/row-level security/);
  });

  it("rules_ref: the default 'default:scp-5a', the shape CHECK with its NULL case, on both tables", async () => {
    const rep = await insertReport();
    const cyc = await insertCycle();
    expect((await db().query(`SELECT rules_ref FROM social_reports WHERE id = $1`, [rep])).rows[0].rules_ref).toBe("default:scp-5a");
    expect((await db().query(`SELECT rules_ref FROM social_cycles WHERE id = $1`, [cyc])).rows[0].rules_ref).toBe("default:scp-5a");
    for (const good of [`'company:1'`, `'company:1234567890'`, `'default:scp5-2026-10-30'`, `'default:SCP-5a'`]) {
      await insertReport({ rules_ref: good });
      await insertCycle({ rules_ref: good });
    }
    for (const bad of [`'company:0'`, `'company:01'`, `'Company:1'`, `'company:1 '`, `'default:'`, `'default:-x'`, `'default:a b'`, `'rules:1'`, `''`, `'company:12345678901'`, `'default:${"x".repeat(61)}'`]) {
      await refusedWith(insertReport({ rules_ref: bad }), "23514");
      await refusedWith(insertCycle({ rules_ref: bad }), "23514");
    }
    await refusedWith(insertReport({ rules_ref: "NULL" }), "23502");
    await refusedWith(insertCycle({ rules_ref: "NULL" }), "23502");
    await refusedWith(db().query(`UPDATE social_reports SET rules_ref = 'nope' WHERE id = $1`, [rep]), "23514");
  });

  it("applied to tables without the column, every existing row reads 'default:scp-5a' and nothing else changes; applied again, no row changes", async () => {
    await insertReport({ notes: `'{"audience": {"insight": "Wider.", "suggestion": "Noon."}}'::jsonb`, status: "'in_review'" });
    await insertCycle();
    const snapshot = async (table: string) =>
      (await db().query<{ j: Record<string, unknown> }>(`SELECT to_jsonb(r) AS j FROM ${table} r ORDER BY id`)).rows.map((r) => r.j);
    const versions = async () => (await db().query(`SELECT to_jsonb(v) AS j FROM social_rule_versions v ORDER BY tenant_id, version`)).rows;

    // As on the live estate before this file: the column absent.
    await db().query(`ALTER TABLE social_reports DROP COLUMN rules_ref`);
    await db().query(`ALTER TABLE social_cycles DROP COLUMN rules_ref`);
    const reportsBefore = await snapshot("social_reports");
    const cyclesBefore = await snapshot("social_cycles");
    const versionsBefore = await versions();
    expect(reportsBefore.length).toBeGreaterThan(0);
    expect(cyclesBefore.length).toBeGreaterThan(0);

    await db().query(readFileSync(PATH, "utf8"));
    const reportsAfter = await snapshot("social_reports");
    const cyclesAfter = await snapshot("social_cycles");
    expect(reportsAfter.every((r) => r.rules_ref === "default:scp-5a")).toBe(true);
    expect(cyclesAfter.every((r) => r.rules_ref === "default:scp-5a")).toBe(true);
    expect(reportsAfter.map(({ rules_ref: _r, ...rest }) => rest)).toEqual(reportsBefore);
    expect(cyclesAfter.map(({ rules_ref: _r, ...rest }) => rest)).toEqual(cyclesBefore);
    expect(await versions()).toEqual(versionsBefore);

    // Applied again: nothing moves.
    await db().query(readFileSync(PATH, "utf8"));
    expect(await snapshot("social_reports")).toEqual(reportsAfter);
    expect(await snapshot("social_cycles")).toEqual(cyclesAfter);
    expect(await versions()).toEqual(versionsBefore);
  });
});
