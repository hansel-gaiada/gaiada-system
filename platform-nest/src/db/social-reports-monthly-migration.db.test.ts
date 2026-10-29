// SCP-5a — 202610291600_social_reports_monthly.sql (BFF §63.1 file 9) against LIVE Postgres. Needs DATABASE_URL_TEST; skipped without it
// (the file-text checks at the top always run). initTestDb() hands us a fully migrated database; the CHECKs are proved through the superuser
// pool, which bypasses RLS but never a CHECK or a NOT NULL; the WALL is proved through `withTenants` / `withGlobal` (the runtime role, which
// RLS binds).
//
// Proves: the three columns and their defaults (an old row reads `{}`, `[]` and false); each CHECK refuses its bad shape and admits the good
// one, NULL cases included (SQL NULL is refused by NOT NULL, JSON null by the CHECK); the third wall is untouched (an unset tenant GUC reads
// zero rows, a tenant without the module scope reads zero rows, another tenant reads none); and applying the file again changes no
// existing row.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId, withGlobal, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createClient, createCompany } from "../testing/fixtures";
import { socialModule } from "../modules/social/index";

const MIGRATION = "202610291600_social_reports_monthly.sql";
const PATH = join(__dirname, "..", "..", "migrations", MIGRATION);

describe("SCP-5a · the migration file (no database needed)", () => {
  const sql = readFileSync(PATH, "utf8");
  const code = sql.split("\n").map((l) => (l.includes("--") ? l.slice(0, l.indexOf("--")) : l)).join("\n");

  it("is registered in the social module, after every earlier social migration", () => {
    expect(socialModule.migrations).toContain(MIGRATION);
    expect(socialModule.migrations[socialModule.migrations.length - 1]).toBe(MIGRATION);
  });

  it("holds no data change, no grant, no policy change and no ledger write, and is LF only", () => {
    expect(code).not.toMatch(/^\s*INSERT\s+INTO\b/im);
    expect(code).not.toMatch(/^\s*UPDATE\s+\S+\s+SET\b/im);
    expect(code).not.toMatch(/^\s*DELETE\s+FROM\b/im);
    expect(code).not.toMatch(/\bGRANT\b/i);
    expect(code).not.toMatch(/\b(CREATE|DROP|ALTER)\s+POLICY\b/i);
    expect(code).not.toMatch(/schema_migrations/i);
    expect(sql).not.toMatch(/\r/);
  });

  it("adds exactly the contract's three columns and two CHECKs, re-runnably", () => {
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS notes jsonb NOT NULL DEFAULT '\{\}'::jsonb/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS action_plan jsonb NOT NULL DEFAULT '\[\]'::jsonb/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS simulated boolean NOT NULL DEFAULT false/);
    expect(code).toMatch(/CHECK \(jsonb_typeof\(notes\) = 'object'\)/);
    expect(code).toMatch(/CHECK \(jsonb_typeof\(action_plan\) = 'array'\)/);
  });
});

describe.skipIf(!TEST_URL)("SCP-5a · social_reports: notes, action_plan, simulated", () => {
  let A: string;
  let C: string;
  let engagementA: string;
  let engagementC: string;
  const db = () => adminPool();

  async function engagement(tenant: string): Promise<string> {
    const id = newId();
    const client = await createClient(tenant, "Mock Report Client");
    await db().query(`INSERT INTO social_engagements (id, tenant_id, client_id, name) VALUES ($1, $2, $3, 'Mock engagement')`, [id, tenant, client]);
    return id;
  }
  /** A report row; `over` replaces columns with SQL literals. */
  async function insertReport(over: Record<string, string> = {}, tenant = () => A, eng = () => engagementA): Promise<string> {
    const id = newId();
    const cols: Record<string, string> = { id: `'${id}'`, tenant_id: `'${tenant()}'`, engagement_id: `'${eng()}'`, period: "'2026-09'", ...over };
    await db().query(`INSERT INTO social_reports (${Object.keys(cols).join(", ")}) VALUES (${Object.values(cols).join(", ")})`);
    return id;
  }
  const refusedWith = async (p: Promise<unknown>, code: string) => {
    await expect(p).rejects.toMatchObject({ code });
  };

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Mock Agency", ["social"]);
    C = await createCompany("Mock Other", ["social"]);
    engagementA = await engagement(A);
    engagementC = await engagement(C);
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  it("a row written without the new columns reads the defaults: {} notes, [] action plan, not simulated", async () => {
    const id = await insertReport();
    const r = (await db().query(`SELECT notes, action_plan, simulated FROM social_reports WHERE id = $1`, [id])).rows[0];
    expect(r).toEqual({ notes: {}, action_plan: [], simulated: false });
  });

  it("each CHECK admits its good shape", async () => {
    const good = await insertReport({
      notes: `'{"followers": {"insight": "Up.", "suggestion": "More."}}'::jsonb`,
      action_plan: `'[{"action": "Plan", "owner": "agency", "due": "2026-10-10"}]'::jsonb`,
      simulated: "true",
    });
    const r = (await db().query(`SELECT notes, action_plan, simulated FROM social_reports WHERE id = $1`, [good])).rows[0];
    expect(r.notes.followers.insight).toBe("Up.");
    expect(r.action_plan).toHaveLength(1);
    expect(r.simulated).toBe(true);
    await insertReport({ notes: `'{}'::jsonb`, action_plan: `'[]'::jsonb`, simulated: "false" });
  });

  it("each CHECK refuses its bad shape, JSON null included; SQL NULL is refused by NOT NULL", async () => {
    for (const bad of [`'[]'::jsonb`, `'"text"'::jsonb`, `'1'::jsonb`, `'null'::jsonb`]) {
      await refusedWith(insertReport({ notes: bad }), "23514");
    }
    for (const bad of [`'{}'::jsonb`, `'"text"'::jsonb`, `'true'::jsonb`, `'null'::jsonb`]) {
      await refusedWith(insertReport({ action_plan: bad }), "23514");
    }
    await refusedWith(insertReport({ notes: "NULL" }), "23502");
    await refusedWith(insertReport({ action_plan: "NULL" }), "23502");
    await refusedWith(insertReport({ simulated: "NULL" }), "23502");
    // An UPDATE is held to the same rules.
    const id = await insertReport();
    await refusedWith(db().query(`UPDATE social_reports SET notes = '[]'::jsonb WHERE id = $1`, [id]), "23514");
    await refusedWith(db().query(`UPDATE social_reports SET action_plan = NULL WHERE id = $1`, [id]), "23502");
  });

  it("the third wall is untouched: an unset GUC reads ZERO rows, the tenant without the module scope reads zero, another tenant none", async () => {
    const mine = await insertReport({ simulated: "true" });
    const theirs = await insertReport({}, () => C, () => engagementC);
    const ids = [mine, theirs];
    const truth = await db().query<{ n: number }>(`SELECT count(*)::int AS n FROM social_reports WHERE id = ANY($1::uuid[])`, [ids]);
    expect(truth.rows[0].n).toBe(2);
    const unset = await withGlobal((c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM social_reports WHERE id = ANY($1::uuid[])`, [ids]));
    expect(unset.rows[0].n, "unset GUC").toBe(0);
    const noModule = await withTenants([A], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM social_reports WHERE id = ANY($1::uuid[])`, [ids]));
    expect(noModule.rows[0].n, "no module scope").toBe(0);
    const scoped = await withTenants([A], (c) => c.query<{ id: string; simulated: boolean }>(
      `SELECT id::text AS id, simulated FROM social_reports WHERE id = ANY($1::uuid[])`, [ids]), { modules: ["social"] });
    expect(scoped.rows).toEqual([{ id: mine, simulated: true }]);
  });

  it("applying the file again changes no existing row", async () => {
    await insertReport({ notes: `'{"audience": {"insight": "Wider.", "suggestion": "Noon."}}'::jsonb`, status: "'in_review'" });
    const snapshot = async () => (await db().query<{ j: unknown }>(`SELECT to_jsonb(r) AS j FROM social_reports r ORDER BY id`)).rows.map((r) => r.j);
    const before = await snapshot();
    expect(before.length).toBeGreaterThan(0);
    await db().query(readFileSync(PATH, "utf8"));
    expect(await snapshot()).toEqual(before);
  });
});
