// SCP-Sa — 202610271600_social_simulation.sql (BFF §63.1 file 8) against LIVE Postgres. Needs DATABASE_URL_TEST; skipped
// without it (the file-text checks at the top always run). initTestDb() hands us a fully migrated database; the CHECK and
// the defaults are proved through the superuser pool, which bypasses RLS but never a CHECK or a NOT NULL, and the file is
// re-applied the way CI's sync-engine-go job applies every migration: plain `psql -f` semantics, no ledger (here: one
// multi-statement simple query).
//
// Proves: rows written the way today's writers write them read `simulated = false` / `source = 'pull'`; the two booleans
// are NOT NULL; `source` admits exactly 'pull' and 'simulated' (NULL refused by NOT NULL, never waved through by the
// CHECK); an UPDATE is held to the same CHECK; the walls are unchanged; and the file applies again without error, changes
// no existing row and leaves exactly one CHECK.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createClient } from "../testing/fixtures";
import { socialModule } from "../modules/social/index";

const MIGRATION = "202610271600_social_simulation.sql";
const PATH = join(__dirname, "..", "..", "migrations", MIGRATION);

describe("SCP-Sa · the migration file (no database needed)", () => {
  const sql = readFileSync(PATH, "utf8");
  const code = sql.split("\n").map((l) => (l.includes("--") ? l.slice(0, l.indexOf("--")) : l)).join("\n");

  it("is registered in the social module", () => {
    expect(socialModule.migrations).toContain(MIGRATION);
  });

  it("holds no data changes, no grant and no ledger write, and is LF only", () => {
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

  it("never counts rows of the FORCE-RLS tables (the unset-GUC zero-row trap): it asserts the catalogue", () => {
    expect(code).not.toMatch(/count\(\*\)[^;]*\bFROM\s+social_(accounts|post_variants|metrics_daily)\b/i);
  });

  it("declares exactly the contract's columns and CHECK (BFF §63.1 file 8)", () => {
    expect(code).toMatch(/ALTER TABLE social_accounts\s+ADD COLUMN IF NOT EXISTS simulated boolean NOT NULL DEFAULT false;/);
    expect(code).toMatch(/ALTER TABLE social_post_variants\s+ADD COLUMN IF NOT EXISTS simulated boolean NOT NULL DEFAULT false;/);
    expect(code).toMatch(/ALTER TABLE social_metrics_daily\s+ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'pull';/);
    expect(code).toMatch(/ADD CONSTRAINT social_metrics_daily_source_ck CHECK \(source IN \('pull', 'simulated'\)\)/);
  });
});

describe.skipIf(!TEST_URL)("SCP-Sa · the simulation marks on social_accounts, social_post_variants, social_metrics_daily", () => {
  let A: string;
  let client: string;
  let org: string;
  let engagement: string;
  let post: string;
  const pool = () => adminPool();
  let seq = 0;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Mock Agency SCP-Sa", ["social"]);
    client = await createClient(A, "Mock Client Kopi Senja");
    org = newId();
    await pool().query(
      `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
       VALUES ($1,$2,$3,'postiz',$4,'default','active','central')`,
      [org, A, client, `scp-sa-org-${newId()}`],
    );
    engagement = newId();
    await pool().query(
      `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, origin_site)
       VALUES ($1,$2,$3,'SCP-Sa engagement','active','{}',10,'central')`,
      [engagement, A, client],
    );
    post = newId();
    await pool().query(
      `INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site) VALUES ($1,$2,$3,'SCP-Sa post','draft','central')`,
      [post, A, engagement],
    );
  });
  afterAll(async () => { await teardownTestDb(); });

  /** An account written with only the columns today's writers write, plus `simulated` when the case sets it. */
  async function account(simulated?: boolean | null): Promise<string> {
    const id = newId();
    const cols = ["id", "tenant_id", "client_id", "publisher_org_id", "network", "handle", "status", "origin_site"];
    const vals: unknown[] = [id, A, client, org, "instagram", `@mock-kopi-senja-${++seq}`, "connected", "central"];
    if (simulated !== undefined) { cols.push("simulated"); vals.push(simulated); }
    await pool().query(`INSERT INTO social_accounts (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
    return id;
  }
  async function variant(accountId: string, simulated?: boolean | null): Promise<string> {
    const id = newId();
    const cols = ["id", "tenant_id", "post_id", "account_id", "body", "status", "origin_site"];
    const vals: unknown[] = [id, A, post, accountId, "A mock caption", "draft", "central"];
    if (simulated !== undefined) { cols.push("simulated"); vals.push(simulated); }
    await pool().query(`INSERT INTO social_post_variants (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
    return id;
  }
  async function metric(accountId: string, source?: string | null, date = `2026-11-${String(++seq % 28 + 1).padStart(2, "0")}`): Promise<string> {
    const id = newId();
    const cols = ["id", "tenant_id", "account_id", "date", "reach", "origin_site"];
    const vals: unknown[] = [id, A, accountId, date, 100, "central"];
    if (source !== undefined) { cols.push("source"); vals.push(source); }
    await pool().query(`INSERT INTO social_metrics_daily (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
    return id;
  }
  const one = async (sql: string, id: string) => (await pool().query(sql, [id])).rows[0] as Record<string, unknown>;
  const refusesCheck = (p: Promise<unknown>) => expect(p).rejects.toThrow(/violates check constraint "social_metrics_daily_source_ck"/);

  it("rows written the way today's writers write them are real: simulated = false, source = 'pull'", async () => {
    const acc = await account();
    expect(await one(`SELECT simulated FROM social_accounts WHERE id = $1`, acc)).toEqual({ simulated: false });
    const v = await variant(acc);
    expect(await one(`SELECT simulated FROM social_post_variants WHERE id = $1`, v)).toEqual({ simulated: false });
    const m = await metric(acc);
    expect(await one(`SELECT source FROM social_metrics_daily WHERE id = $1`, m)).toEqual({ source: "pull" });
  });

  it("the simulated marks can be written, and read back", async () => {
    const acc = await account(true);
    expect(await one(`SELECT simulated FROM social_accounts WHERE id = $1`, acc)).toEqual({ simulated: true });
    const v = await variant(acc, true);
    expect(await one(`SELECT simulated FROM social_post_variants WHERE id = $1`, v)).toEqual({ simulated: true });
    const m = await metric(acc, "simulated");
    expect(await one(`SELECT source FROM social_metrics_daily WHERE id = $1`, m)).toEqual({ source: "simulated" });
  });

  it("the two booleans are NOT NULL: a NULL mark is refused, never read as either answer", async () => {
    await expect(account(null)).rejects.toThrow(/null value in column "simulated"/);
    const acc = await account(true);
    await expect(variant(acc, null)).rejects.toThrow(/null value in column "simulated"/);
  });

  it("source is exactly 'pull' or 'simulated'; NULL is refused by NOT NULL", async () => {
    const acc = await account(true);
    for (const bad of ["PULL", "Simulated", "", "manual", " pull", "sim"]) await refusesCheck(metric(acc, bad));
    await expect(metric(acc, null)).rejects.toThrow(/null value in column "source"/);
  });

  it("an UPDATE is held to the same CHECK", async () => {
    const acc = await account(true);
    const m = await metric(acc, "simulated");
    await refusesCheck(pool().query(`UPDATE social_metrics_daily SET source = 'bogus' WHERE id = $1`, [m]));
    await pool().query(`UPDATE social_metrics_daily SET source = 'pull' WHERE id = $1`, [m]);
    expect(await one(`SELECT source FROM social_metrics_daily WHERE id = $1`, m)).toEqual({ source: "pull" });
  });

  it("applies again on its own with plain psql semantics, changes no row, and leaves one CHECK and the walls", async () => {
    const acc = await account(true);
    const v = await variant(acc, true);
    const m = await metric(acc, "simulated");
    const snapshot = async () => ({
      a: (await pool().query(`SELECT * FROM social_accounts WHERE id = $1`, [acc])).rows,
      v: (await pool().query(`SELECT * FROM social_post_variants WHERE id = $1`, [v])).rows,
      m: (await pool().query(`SELECT * FROM social_metrics_daily WHERE id = $1`, [m])).rows,
      all: (await pool().query(
        `SELECT (SELECT count(*) FROM social_accounts WHERE simulated)::int AS a,
                (SELECT count(*) FROM social_post_variants WHERE simulated)::int AS v,
                (SELECT count(*) FROM social_metrics_daily WHERE source = 'simulated')::int AS m`,
      )).rows,
    });
    const beforeApply = await snapshot();
    await pool().query(readFileSync(PATH, "utf8"));
    expect(await snapshot()).toEqual(beforeApply);
    const cons = await pool().query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'social_metrics_daily'::regclass AND conname = 'social_metrics_daily_source_ck'`,
    );
    expect(cons.rows).toHaveLength(1);
    for (const t of ["social_accounts", "social_post_variants", "social_metrics_daily"]) {
      const wall = await pool().query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`, [t]);
      expect(wall.rows[0], t).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    }
  });
});
