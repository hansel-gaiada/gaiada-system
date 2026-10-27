// SCP-3c — 202610271500_social_post_metrics_manual.sql (BFF §63.1 file 6) against LIVE Postgres. Needs DATABASE_URL_TEST; skipped without it (the
// file-text checks at the top always run). initTestDb() hands us a fully migrated database; the CHECKs are proved through the superuser pool, which
// bypasses RLS but never a CHECK or a foreign key, and the file is re-applied the way CI's sync-engine-go job applies every migration: plain `psql -f`
// semantics, no ledger (here: one multi-statement simple query).
//
// Proves: a row written the way the nightly pull writes it reads `pull`, no reach and no author (the default, with no row rewritten); `source` is one of
// the three and NOT NULL; `reach` is NULL or >= 0 (a NULL reach is admitted, a negative one is not, 0 is a number); `entered_by` is present exactly on
// the `manual` rows (both directions: a manual row with no author, and a pulled or simulated row with one, are refused, whatever the NULL shape);
// `entered_by` names a real user; an UPDATE is held to the same checks; and the file applies again without error, changes no row, leaves one of each
// constraint and keeps the wall.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createClient, createCompany, createUser } from "../testing/fixtures";
import { socialModule } from "../modules/social/index";

const MIGRATION = "202610271500_social_post_metrics_manual.sql";
const PATH = join(__dirname, "..", "..", "migrations", MIGRATION);
const CONSTRAINTS = ["fk_social_post_metrics_entered_by", "social_post_metrics_entered_by_ck", "social_post_metrics_reach_ck", "social_post_metrics_source_ck"];

describe("SCP-3c · the migration file (no database needed)", () => {
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
    expect(code).not.toMatch(/schema_migrations/i);
    expect(sql).not.toMatch(/\r/);
  });

  it("never counts rows of the FORCE-RLS table (the unset-GUC zero-row trap): it asserts the catalogue", () => {
    expect(code).not.toMatch(/count\(\*\)[^;]*\bFROM\s+social_post_metrics\b/i);
  });

  it("declares exactly the contract's columns and CHECKs", () => {
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'pull'/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS reach integer,/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS entered_by uuid/);
    expect(code).toMatch(/CHECK \(source IN \('pull', 'manual', 'simulated'\)\)/);
    expect(code).toMatch(/CHECK \(reach IS NULL OR reach >= 0\)/);
    expect(code).toMatch(/FOREIGN KEY \(entered_by\) REFERENCES users \(id\)/);
    expect(code).toMatch(/CHECK \(\(source = 'manual'\) = \(entered_by IS NOT NULL\)\)/);
  });
});

describe.skipIf(!TEST_URL)("SCP-3c · social_post_metrics source, reach and entered_by", () => {
  let A: string;
  let user: string;
  let variant: string;
  const pool = () => adminPool();

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Mock Agency", ["social"]);
    user = await createUser("scp3c-mig@mock.test", "Mock Officer");
    const clientId = await createClient(A, "Mock Metrics Client");
    const [engagement, post, org, account] = [newId(), newId(), newId(), newId()];
    variant = newId();
    const db = pool();
    await db.query(`INSERT INTO social_engagements (id, tenant_id, client_id, name, status) VALUES ($1, $2, $3, 'Mock engagement', 'active')`, [engagement, A, clientId]);
    await db.query(`INSERT INTO social_posts (id, tenant_id, engagement_id, title) VALUES ($1, $2, $3, 'Mock post')`, [post, A, engagement]);
    await db.query(
      `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
       VALUES ($1, $2, $3, 'postiz', 'scp3c-mig-org', 'default', 'active', 'central')`, [org, A, clientId]);
    await db.query(
      `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, origin_site)
       VALUES ($1, $2, $3, $4, 'instagram', '@scp3c-mig', 'connected', '{}', 'central')`, [account, A, clientId, org]);
    await db.query(
      `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, status, native_import, published_at, origin_site)
       VALUES ($1, $2, $3, $4, 'copy', 'published', true, now(), 'central')`, [variant, A, post, account]);
  });
  afterAll(async () => { await teardownTestDb(); });

  /** One snapshot row, with only the columns the nightly pull wrote before this file existed, plus what the case sets. */
  async function insert(over: { source?: string | null; reach?: number | null; enteredBy?: string | null; omit?: boolean } = {}) {
    const id = newId();
    const cols = ["id", "tenant_id", "variant_id", "likes"];
    const vals: unknown[] = [id, A, variant, 12];
    if (!over.omit) {
      if ("source" in over) { cols.push("source"); vals.push(over.source); }
      if ("reach" in over) { cols.push("reach"); vals.push(over.reach); }
      if ("enteredBy" in over) { cols.push("entered_by"); vals.push(over.enteredBy); }
    }
    await pool().query(`INSERT INTO social_post_metrics (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
    return id;
  }
  const read = async (id: string) =>
    (await pool().query(`SELECT source, reach, entered_by::text AS entered_by, likes FROM social_post_metrics WHERE id = $1`, [id])).rows[0] as
      { source: string; reach: number | null; entered_by: string | null; likes: number };
  const refuses = (p: Promise<unknown>, name: string) => expect(p).rejects.toThrow(new RegExp(`violates (check|foreign key) constraint "${name}"`));

  it("a row written the way the nightly pull writes it reads pull, no reach and no author", async () => {
    expect(await read(await insert({ omit: true }))).toEqual({ source: "pull", reach: null, entered_by: null, likes: 12 });
  });

  it("source is one of the three, nothing else, and is NOT NULL", async () => {
    expect((await read(await insert({ source: "pull" }))).source).toBe("pull");
    expect((await read(await insert({ source: "manual", enteredBy: user }))).source).toBe("manual");
    expect((await read(await insert({ source: "simulated" }))).source).toBe("simulated");
    for (const source of ["Manual", "", "typed", "import", " pull"]) await refuses(insert({ source }), "social_post_metrics_source_ck");
    await expect(insert({ source: null })).rejects.toThrow(/null value in column "source"/);
  });

  it("reach is NULL or a whole number from 0: NULL is admitted, 0 is a number, a negative is refused", async () => {
    expect((await read(await insert({ reach: null }))).reach).toBeNull();
    expect((await read(await insert({ reach: 0 }))).reach).toBe(0);
    expect((await read(await insert({ reach: 2_147_483_647 }))).reach).toBe(2_147_483_647);
    await refuses(insert({ reach: -1 }), "social_post_metrics_reach_ck");
    await expect(insert({ reach: 1.5 })).rejects.toThrow(/invalid input syntax for type integer/); // a whole number only: the column is an integer
  });

  it("entered_by is present exactly on the manual rows, in both directions, whatever the NULL shape", async () => {
    // manual needs an author
    await refuses(insert({ source: "manual" }), "social_post_metrics_entered_by_ck");
    await refuses(insert({ source: "manual", enteredBy: null }), "social_post_metrics_entered_by_ck");
    // an author needs manual
    await refuses(insert({ source: "pull", enteredBy: user }), "social_post_metrics_entered_by_ck");
    await refuses(insert({ source: "simulated", enteredBy: user }), "social_post_metrics_entered_by_ck");
    await refuses(insert({ enteredBy: user }), "social_post_metrics_entered_by_ck"); // the default source is pull
    // the good pairs
    expect(await read(await insert({ source: "manual", enteredBy: user, reach: 900 }))).toMatchObject({ source: "manual", entered_by: user, reach: 900 });
    expect((await read(await insert({ source: "pull", enteredBy: null }))).entered_by).toBeNull();
    expect((await read(await insert({ source: "simulated", enteredBy: null }))).entered_by).toBeNull();
  });

  it("entered_by names a real user", async () => {
    await refuses(insert({ source: "manual", enteredBy: newId() }), "fk_social_post_metrics_entered_by");
  });

  it("an UPDATE is held to the same checks", async () => {
    const id = await insert({ source: "manual", enteredBy: user, reach: 10 });
    await refuses(pool().query(`UPDATE social_post_metrics SET entered_by = NULL WHERE id = $1`, [id]), "social_post_metrics_entered_by_ck");
    await refuses(pool().query(`UPDATE social_post_metrics SET source = 'pull' WHERE id = $1`, [id]), "social_post_metrics_entered_by_ck");
    await refuses(pool().query(`UPDATE social_post_metrics SET reach = -5 WHERE id = $1`, [id]), "social_post_metrics_reach_ck");
    await refuses(pool().query(`UPDATE social_post_metrics SET source = 'bogus' WHERE id = $1`, [id]), "social_post_metrics_source_ck");
    await pool().query(`UPDATE social_post_metrics SET source = 'pull', entered_by = NULL, reach = NULL WHERE id = $1`, [id]);
    expect(await read(id)).toMatchObject({ source: "pull", entered_by: null, reach: null });
  });

  it("applies again on its own with plain psql semantics, changes no row, and leaves one of each constraint and the wall", async () => {
    const id = await insert({ source: "manual", enteredBy: user, reach: 321 });
    const before = await pool().query(`SELECT source, reach, entered_by, likes, fetched_at FROM social_post_metrics WHERE id = $1`, [id]);
    await pool().query(readFileSync(PATH, "utf8"));
    const after = await pool().query(`SELECT source, reach, entered_by, likes, fetched_at FROM social_post_metrics WHERE id = $1`, [id]);
    expect(after.rows).toEqual(before.rows);
    const cons = await pool().query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'social_post_metrics'::regclass AND conname = ANY($1::text[]) ORDER BY conname`, [CONSTRAINTS]);
    expect(cons.rows.map((x) => x.conname)).toEqual(CONSTRAINTS);
    const wall = await pool().query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'social_post_metrics'::regclass`);
    expect(wall.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});
