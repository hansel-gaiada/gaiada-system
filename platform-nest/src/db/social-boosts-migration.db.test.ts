// SCP-4a — 202610281300_social_boosts.sql (BFF §63.1 file 7) against LIVE Postgres. Needs DATABASE_URL_TEST; skipped without it (the file-text
// checks at the top always run). initTestDb() hands us a fully migrated database; the CHECKs are proved through the superuser pool, which bypasses
// RLS but never a CHECK, a unique index or a foreign key; the WALL is proved through `withTenants` (the runtime role, which RLS binds).
//
// Proves: the total is generated (daily x days) and cannot be written; each contract CHECK refuses its bad shape; one open boost per post, one
// pending and one agreed budget per cycle; a boost cannot point at another company's budget; the PLAIN wall (a company's own rows read with no
// module scope, another company's never); and the file applies again without error.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createClient, createCompany, createUser } from "../testing/fixtures";
import { socialModule } from "../modules/social/index";

const MIGRATION = "202610281300_social_boosts.sql";
const PATH = join(__dirname, "..", "..", "migrations", MIGRATION);

describe("SCP-4a · the migration file (no database needed)", () => {
  const sql = readFileSync(PATH, "utf8");
  const code = sql.split("\n").map((l) => (l.includes("--") ? l.slice(0, l.indexOf("--")) : l)).join("\n");

  it("is registered in the social module", () => {
    expect(socialModule.migrations).toContain(MIGRATION);
  });

  it("holds no data change, no grant and no ledger write, and is LF only", () => {
    expect(code).not.toMatch(/^\s*INSERT\s+INTO\b/im);
    expect(code).not.toMatch(/^\s*UPDATE\s+\S+\s+SET\b/im);
    expect(code).not.toMatch(/^\s*DELETE\s+FROM\b/im);
    expect(code).not.toMatch(/\bGRANT\b/i);
    expect(code).not.toMatch(/schema_migrations/i);
    expect(sql).not.toMatch(/\r/);
  });

  it("takes the PLAIN tenant wall: no module clause in any policy", () => {
    expect(code).toMatch(/USING \(tenant_id = ANY\(app_current_tenants\(\)\)\)/);
    expect(code).toMatch(/WITH CHECK \(tenant_id = ANY\(app_current_tenants\(\)\)\)/);
    expect(code).not.toMatch(/CREATE POLICY[^;]*app_module_allowed/i);
    expect(code).toMatch(/total_budget_minor bigint GENERATED ALWAYS AS \(daily_budget_minor \* days\) STORED/);
  });
});

describe.skipIf(!TEST_URL)("SCP-4a · social_boosts and social_boost_budgets", () => {
  let A: string;
  let C: string;
  let user: string;
  let clientId: string;
  let cycleId: string;
  let otherBudget: string;
  const db = () => adminPool();
  const posts: string[] = [];

  async function newPost(): Promise<string> {
    const id = newId();
    await db().query(`INSERT INTO social_posts (id, tenant_id, engagement_id, title) VALUES ($1, $2, (SELECT id FROM social_engagements WHERE tenant_id = $2 LIMIT 1), 'Mock post')`, [id, A]);
    posts.push(id);
    return id;
  }
  /** A boost row; `over` replaces columns (SQL literals) of the requested default. */
  async function insertBoost(postId: string, over: Record<string, string> = {}): Promise<string> {
    const id = newId();
    const cols: Record<string, string> = {
      id: `'${id}'`, tenant_id: `'${A}'`, post_id: `'${postId}'`, client_id: `'${clientId}'`, cycle_id: `'${cycleId}'`, status: "'requested'",
      goal: "'website'", audience: "'automatic'", daily_budget_minor: "100000", days: "5", currency: "'IDR'", starts_on: "'2027-03-05'",
      requested_by: `'${user}'`, ...over,
    };
    await db().query(`INSERT INTO social_boosts (${Object.keys(cols).join(", ")}) VALUES (${Object.values(cols).join(", ")})`);
    return id;
  }
  async function insertBudget(over: Record<string, string> = {}, tenant = A, client = () => clientId, cycle = () => cycleId): Promise<string> {
    const id = newId();
    const cols: Record<string, string> = {
      id: `'${id}'`, tenant_id: `'${tenant}'`, client_id: `'${client()}'`, cycle_id: `'${cycle()}'`, amount_minor: "1000000", requested_by: `'${user}'`, ...over,
    };
    await db().query(`INSERT INTO social_boost_budgets (${Object.keys(cols).join(", ")}) VALUES (${Object.values(cols).join(", ")})`);
    return id;
  }
  const refusedWith = async (p: Promise<unknown>, code: string) => {
    await expect(p).rejects.toMatchObject({ code });
  };

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Mock Agency", ["social"]);
    C = await createCompany("Mock Other", ["social"]);
    user = await createUser("scp4a-mig@mock.test", "Mock Officer");
    clientId = await createClient(A, "Mock Boost Client");
    const engagement = newId();
    cycleId = newId();
    await db().query(`INSERT INTO social_engagements (id, tenant_id, client_id, name, status) VALUES ($1, $2, $3, 'Mock engagement', 'active')`, [engagement, A, clientId]);
    await db().query(`INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by) VALUES ($1, $2, $3, '2027-03-01', '2027-02-26', '2027-02-24')`, [cycleId, A, engagement]);
    const cClient = await createClient(C, "Mock Other Client");
    const cEng = newId();
    const cCycle = newId();
    await db().query(`INSERT INTO social_engagements (id, tenant_id, client_id, name, status) VALUES ($1, $2, $3, 'Other engagement', 'active')`, [cEng, C, cClient]);
    await db().query(`INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by) VALUES ($1, $2, $3, '2027-03-01', '2027-02-26', '2027-02-24')`, [cCycle, C, cEng]);
    otherBudget = await insertBudget({}, C, () => cClient, () => cCycle);
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  it("the total is generated and cannot be written", async () => {
    const id = await insertBoost(await newPost(), { daily_budget_minor: "250000", days: "4" });
    expect(Number((await db().query(`SELECT total_budget_minor FROM social_boosts WHERE id = $1`, [id])).rows[0].total_budget_minor)).toBe(1_000_000);
    await expect(db().query(`UPDATE social_boosts SET total_budget_minor = 1 WHERE id = $1`, [id])).rejects.toThrow();
  });

  it("each contract CHECK refuses its bad shape", async () => {
    const p = await newPost();
    const check = "23514";
    await refusedWith(insertBoost(p, { status: "'approved'" }), check); // approved with no approval
    await refusedWith(insertBoost(p, { status: "'approved'", approved_via: "'budget'", approved_by: `'${user}'`, approved_at: "now()" }), check); // budget with no budget_id
    await refusedWith(insertBoost(p, { status: "'approved'", approved_via: "'recorded'", approved_by: `'${user}'`, approved_at: "now()", approval_channel: "'email'" }), check); // no note
    await refusedWith(insertBoost(p, { status: "'running'", approved_via: "'portal'", approved_by: `'${user}'`, approved_at: "now()" }), check); // never started
    await refusedWith(insertBoost(p, { status: "'stopped'", approved_via: "'portal'", approved_by: `'${user}'`, approved_at: "now()", started_at: "now()", ended_at: "now()" }), check); // no spend
    await refusedWith(insertBoost(p, { status: "'completed'", approved_via: "'portal'", approved_by: `'${user}'`, approved_at: "now()", started_at: "now()", ended_at: "now()", spend_minor: "1" }), check); // no reach
    await refusedWith(insertBoost(p, { cancelled_at: "now()" }), check); // cancelled_at without the status
    await refusedWith(insertBoost(p, { status: "'declined'" }), check); // declined without declined_at
    await refusedWith(insertBoost(p, { audience: "'custom'" }), check); // custom with no note
    await refusedWith(insertBoost(p, { days: "91" }), check);
    await refusedWith(insertBoost(p, { daily_budget_minor: "0" }), check);
    await refusedWith(insertBoost(p, { reach_estimate_low: "10", reach_estimate_high: "5" }), check);
    await refusedWith(insertBudget({ amount_minor: "-1" }), check);
    await refusedWith(insertBudget({ status: "'agreed'" }), check); // agreed with no decision
    await refusedWith(insertBudget({ status: "'agreed'", decided_via: "'recorded'", decided_at: "now()", recorded_by: `'${user}'`, channel: "'email'" }), check); // no note
    await refusedWith(insertBudget({ status: "'agreed'", decided_via: "'portal'", decided_at: "now()" }), check); // portal with no contact
    await refusedWith(insertBudget({ channel: "'email'" }), check); // a pending row with a decision field
  });

  it("one open boost per post, one pending and one agreed budget per cycle", async () => {
    const p = await newPost();
    await insertBoost(p);
    await refusedWith(insertBoost(p), "23505");
    await insertBoost(p, { status: "'cancelled'", cancelled_at: "now()" }); // a closed one beside it is fine
    await insertBudget();
    await refusedWith(insertBudget(), "23505");
    const recorded = { status: "'agreed'", decided_via: "'recorded'", decided_at: "now()", recorded_by: `'${user}'`, channel: "'email'", decision_note: "'Yes.'" };
    await insertBudget(recorded);
    await refusedWith(insertBudget(recorded), "23505");
  });

  it("a boost cannot point at another company's budget or cycle", async () => {
    const p = await newPost();
    await refusedWith(insertBoost(p, { status: "'approved'", approved_via: "'budget'", approved_by: `'${user}'`, approved_at: "now()", budget_id: `'${otherBudget}'` }), "23503");
  });

  it("the PLAIN wall: the company's rows read with no module scope; another company's never", async () => {
    const mine = await withTenants([A], (c) => c.query(`SELECT count(*)::int AS n FROM social_boosts`));
    expect(mine.rows[0].n).toBeGreaterThan(0);
    const budgets = await withTenants([A], (c) => c.query(`SELECT tenant_id::text AS t FROM social_boost_budgets`));
    expect(budgets.rows.length).toBeGreaterThan(0);
    expect(budgets.rows.every((r: { t: string }) => r.t === A)).toBe(true);
    const theirs = await withTenants([C], (c) => c.query(`SELECT count(*)::int AS n FROM social_boosts`));
    expect(theirs.rows[0].n).toBe(0);
    // Writing into another company through the wall is refused.
    await expect(withTenants([C], (c) => c.query(
      `INSERT INTO social_boosts (tenant_id, post_id, client_id, goal, audience, daily_budget_minor, days, currency, starts_on, requested_by)
       VALUES ($1, $2, $3, 'website', 'automatic', 1, 1, 'IDR', '2027-03-05', $4)`, [A, posts[0], clientId, user]))).rejects.toThrow();
  });

  it("applies again on its own with plain psql semantics", async () => {
    await db().query(readFileSync(PATH, "utf8"));
    const n = await db().query(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename IN ('social_boosts','social_boost_budgets')`);
    expect(n.rows[0].n).toBe(2);
  });
});
