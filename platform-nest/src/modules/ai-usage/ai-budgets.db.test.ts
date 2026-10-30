// AIP-17b — migration 202610300400_ai_budgets.sql against LIVE Postgres. Needs DATABASE_URL_TEST; it SKIPS without one, and a skip is not a
// pass. initTestDb() hands us a fully migrated database and repoints the app at a NOSUPERUSER NOBYPASSRLS role, so RLS is really exercised
// through withTenants. Seeding and "what is really stored" go through the superuser pool, which bypasses RLS but never a CHECK or an index.
//
// Proves: every CHECK incl. the NULL cases (a company row with a mode, a unit row with no mode or no node, no figure, a bad stop-lifted month,
// an alert whose subject or period or threshold does not fit its kind); the two partial unique indexes (one company row per tenant, one row per
// tenant and unit, the same node in another tenant is fine); the allowance range and primary key; the ledger's ON CONFLICT DO NOTHING; RLS on
// all three tables (another company sees none, no tenant context sees none, a write for another company is refused); and a clean re-apply.
// The grants are the migration's own self-check (it runs on every apply): the harness blanket-grants DML to its test role, so a REVOKE cannot
// be proved from here (see 202610271800's note).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants } from "../../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany, createUser } from "../../testing/fixtures";

const MIGRATION = "202610300400_ai_budgets.sql";

describe.skipIf(!TEST_URL)("AIP-17b · ai_budgets, ai_person_allowances, ai_usage_alerts (202610300400)", () => {
  let A: string;
  let B: string;
  let u1: string;
  const admin = () => adminPool();

  async function budget(over: Record<string, unknown> & { tenant_id: string }) {
    const row: Record<string, unknown> = { scope: "unit", unit_node_id: "d-web", monthly_usd: "10", mode: "report", ...over };
    const cols = Object.keys(row);
    return admin().query(`INSERT INTO ai_budgets (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map((c) => row[c]));
  }
  async function alert(over: Record<string, unknown> & { tenant_id: string }) {
    const row: Record<string, unknown> = { kind: "unit_budget", subject: "d-web", period: "2026-10", threshold: 80, ...over };
    const cols = Object.keys(row);
    return admin().query(`INSERT INTO ai_usage_alerts (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map((c) => row[c]));
  }

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("AIP17b Company A");
    B = await createCompany("AIP17b Company B");
    u1 = await createUser("aip17b-u1@mock.test", "AIP17b One");
  });
  afterAll(async () => { await teardownTestDb(); });

  describe("ai_budgets", () => {
    it("stores a company row (no node, no mode) and a unit row (node, mode)", async () => {
      await budget({ tenant_id: A, scope: "company", unit_node_id: null, mode: null, monthly_usd: "250.5" });
      await budget({ tenant_id: A, unit_node_id: "d-web", mode: "soft_stop", monthly_usd: "99999999.9999" });
      const r = await admin().query(`SELECT scope, unit_node_id, mode, monthly_usd::text AS m FROM ai_budgets WHERE tenant_id = $1 ORDER BY scope`, [A]);
      expect(r.rows).toEqual([
        { scope: "company", unit_node_id: null, mode: null, m: "250.5000" },
        { scope: "unit", unit_node_id: "d-web", mode: "soft_stop", m: "99999999.9999" },
      ]);
    });

    it("refuses a company row that carries a mode or a node (AIP-D8: no company-level stop), and one that forgets to say mode NULL", async () => {
      await expect(budget({ tenant_id: B, scope: "company", unit_node_id: null, mode: "report" })).rejects.toThrow(/ck_ai_budgets_scope_shape/);
      await expect(budget({ tenant_id: B, scope: "company", unit_node_id: "d-web", mode: null })).rejects.toThrow(/ck_ai_budgets_scope_shape/);
      // an insert that omits `mode` gets the column default 'report', which a company row may not hold
      await expect(admin().query(`INSERT INTO ai_budgets (tenant_id, scope, monthly_usd) VALUES ($1, 'company', 5)`, [B])).rejects.toThrow(/ck_ai_budgets_scope_shape/);
    });

    it("refuses a unit row with no mode, no node, an empty or a 121-character node, or a mode outside the vocabulary (NULL does not pass)", async () => {
      await expect(budget({ tenant_id: B, mode: null })).rejects.toThrow(/ck_ai_budgets_scope_shape/);
      await expect(budget({ tenant_id: B, unit_node_id: null })).rejects.toThrow(/ck_ai_budgets_scope_shape/);
      await expect(budget({ tenant_id: B, unit_node_id: "" })).rejects.toThrow(/ck_ai_budgets_scope_shape/);
      await expect(budget({ tenant_id: B, unit_node_id: "x".repeat(121) })).rejects.toThrow(/ck_ai_budgets_scope_shape/);
      await expect(budget({ tenant_id: B, mode: "hard_stop" })).rejects.toThrow(/ck_ai_budgets_scope_shape/);
      await budget({ tenant_id: B, unit_node_id: "x".repeat(120) });
      await admin().query(`DELETE FROM ai_budgets WHERE tenant_id = $1`, [B]);
    });

    it("refuses a scope outside the vocabulary", async () => {
      await expect(budget({ tenant_id: B, scope: "team" })).rejects.toThrow(/ck_ai_budgets_scope/);
    });

    it("refuses no figure, zero, a negative figure and an overflow", async () => {
      await expect(budget({ tenant_id: B, monthly_usd: null })).rejects.toThrow(/not-null|null value/i);
      await expect(budget({ tenant_id: B, monthly_usd: "0" })).rejects.toThrow(/ck_ai_budgets_monthly_usd/);
      await expect(budget({ tenant_id: B, monthly_usd: "-1" })).rejects.toThrow(/ck_ai_budgets_monthly_usd/);
      await expect(budget({ tenant_id: B, monthly_usd: "100000000" })).rejects.toThrow(/overflow/i);
    });

    it("stop_lifted_month: NULL or a real YYYY-MM on a unit row, never on the company row", async () => {
      await budget({ tenant_id: B, unit_node_id: "d-a", stop_lifted_month: "2026-10" });
      await budget({ tenant_id: B, unit_node_id: "d-b", stop_lifted_month: null });
      for (const bad of ["2026-13", "2026-00", "2026-1", "26-10", "2026-10-01", ""]) {
        await expect(budget({ tenant_id: B, unit_node_id: "d-c", stop_lifted_month: bad })).rejects.toThrow(/ck_ai_budgets_stop_lifted_month/);
      }
      await expect(budget({ tenant_id: B, scope: "company", unit_node_id: null, mode: null, stop_lifted_month: "2026-10" })).rejects.toThrow(/ck_ai_budgets_stop_lifted_month/);
      await admin().query(`DELETE FROM ai_budgets WHERE tenant_id = $1`, [B]);
    });

    it("one company row per tenant and one row per (tenant, unit); the same node in another company is fine", async () => {
      await expect(budget({ tenant_id: A, scope: "company", unit_node_id: null, mode: null })).rejects.toThrow(/ux_ai_budgets_company/);
      await expect(budget({ tenant_id: A, unit_node_id: "d-web" })).rejects.toThrow(/ux_ai_budgets_unit/);
      await budget({ tenant_id: A, unit_node_id: "d-seo" });
      await budget({ tenant_id: B, unit_node_id: "d-web" });
      await budget({ tenant_id: B, scope: "company", unit_node_id: null, mode: null });
    });
  });

  describe("ai_person_allowances", () => {
    it("holds 1 to 100000 and refuses 0, 100001, NULL and a second row for the same person", async () => {
      await admin().query(`INSERT INTO ai_person_allowances (tenant_id, user_id, daily_replies) VALUES ($1, $2, 1)`, [A, u1]);
      await admin().query(`UPDATE ai_person_allowances SET daily_replies = 100000 WHERE tenant_id = $1 AND user_id = $2`, [A, u1]);
      await expect(admin().query(`UPDATE ai_person_allowances SET daily_replies = 0 WHERE tenant_id = $1`, [A])).rejects.toThrow(/ck_ai_person_allowances_daily_replies/);
      await expect(admin().query(`UPDATE ai_person_allowances SET daily_replies = 100001 WHERE tenant_id = $1`, [A])).rejects.toThrow(/ck_ai_person_allowances_daily_replies/);
      await expect(admin().query(`UPDATE ai_person_allowances SET daily_replies = NULL WHERE tenant_id = $1`, [A])).rejects.toThrow(/not-null|null value/i);
      await expect(admin().query(`INSERT INTO ai_person_allowances (tenant_id, user_id, daily_replies) VALUES ($1, $2, 5)`, [A, u1])).rejects.toThrow(/duplicate key/);
      // the same person in another company is another row
      await admin().query(`INSERT INTO ai_person_allowances (tenant_id, user_id, daily_replies) VALUES ($1, $2, 5)`, [B, u1]);
    });
  });

  describe("ai_usage_alerts", () => {
    it("stores a budget alert and a runaway alert; refuses a kind, subject, period or threshold that does not fit", async () => {
      await alert({ tenant_id: A });
      await alert({ tenant_id: A, kind: "company_budget", subject: "", threshold: 100 });
      await alert({ tenant_id: A, kind: "runaway_person", subject: u1, period: "2026-10-30", threshold: 500 });
      await alert({ tenant_id: A, kind: "runaway_agent", subject: "seo-writer", period: "2026-10-30", threshold: 500 });
      await expect(alert({ tenant_id: A, kind: "weekly" })).rejects.toThrow(/ck_ai_usage_alerts_kind/);
      await expect(alert({ tenant_id: A, kind: "company_budget", subject: "d-web" })).rejects.toThrow(/ck_ai_usage_alerts_subject/);
      await expect(alert({ tenant_id: A, kind: "unit_budget", subject: "", period: "2026-09" })).rejects.toThrow(/ck_ai_usage_alerts_subject/);
      await expect(alert({ tenant_id: A, kind: "runaway_person", subject: "", period: "2026-10-30", threshold: 500 })).rejects.toThrow(/ck_ai_usage_alerts_subject/);
      await expect(alert({ tenant_id: A, subject: "x".repeat(121), period: "2026-09" })).rejects.toThrow(/ck_ai_usage_alerts_subject/);
      await expect(alert({ tenant_id: A, threshold: 50, period: "2026-09" })).rejects.toThrow(/ck_ai_usage_alerts_period_threshold/);
      await expect(alert({ tenant_id: A, threshold: 500, period: "2026-09" })).rejects.toThrow(/ck_ai_usage_alerts_period_threshold/);
      await expect(alert({ tenant_id: A, period: "2026-13" })).rejects.toThrow(/ck_ai_usage_alerts_period_threshold/);
      await expect(alert({ tenant_id: A, period: "2026-10-30" })).rejects.toThrow(/ck_ai_usage_alerts_period_threshold/);
      await expect(alert({ tenant_id: A, kind: "runaway_person", subject: u1, period: "2026-10", threshold: 500 })).rejects.toThrow(/ck_ai_usage_alerts_period_threshold/);
      await expect(alert({ tenant_id: A, kind: "runaway_person", subject: u1, period: "2026-10-30", threshold: 100 })).rejects.toThrow(/ck_ai_usage_alerts_period_threshold/);
      await expect(alert({ tenant_id: A, kind: "runaway_person", subject: u1, period: "2026-10-32", threshold: 500 })).rejects.toThrow(/ck_ai_usage_alerts_period_threshold/);
    });

    it("INSERT .. ON CONFLICT DO NOTHING claims a notice exactly once, even from two connections at once", async () => {
      const claim = () =>
        withTenants([A], (c) =>
          c.query(
            `INSERT INTO ai_usage_alerts (tenant_id, kind, subject, period, threshold) VALUES ($1, 'unit_budget', 'd-claim', '2026-10', 80)
             ON CONFLICT (tenant_id, kind, subject, period, threshold) DO NOTHING`,
            [A],
          ),
        );
      const results = await Promise.all([claim(), claim(), claim()]);
      expect(results.map((r) => r.rowCount).sort()).toEqual([0, 0, 1]);
      expect((await admin().query(`SELECT count(*)::int AS n FROM ai_usage_alerts WHERE subject = 'd-claim'`)).rows[0].n).toBe(1);
    });
  });

  describe("RLS on all three tables", () => {
    it("another company reads none of A's rows, and no tenant context reads none", async () => {
      for (const t of ["ai_budgets", "ai_person_allowances", "ai_usage_alerts"]) {
        expect((await withTenants([A], (c) => c.query(`SELECT 1 FROM ${t} WHERE tenant_id = $1`, [A]))).rows.length, `${t} A sees own`).toBeGreaterThan(0);
        expect((await withTenants([B], (c) => c.query(`SELECT 1 FROM ${t} WHERE tenant_id = $1`, [A]))).rows, `${t} B sees A`).toHaveLength(0);
      }
    });

    it("a write for another company is refused by the policy's WITH CHECK", async () => {
      await expect(
        withTenants([B], (c) => c.query(`INSERT INTO ai_budgets (tenant_id, scope, unit_node_id, monthly_usd, mode) VALUES ($1, 'unit', 'd-rls', 5, 'report')`, [A])),
      ).rejects.toThrow(/row-level security/);
      await expect(
        withTenants([B], (c) => c.query(`INSERT INTO ai_person_allowances (tenant_id, user_id, daily_replies) VALUES ($1, $2, 5)`, [A, u1])),
      ).rejects.toThrow(/row-level security/);
      await expect(
        withTenants([B], (c) => c.query(`INSERT INTO ai_usage_alerts (tenant_id, kind, subject, period, threshold) VALUES ($1, 'unit_budget', 'd-rls', '2026-10', 80)`, [A])),
      ).rejects.toThrow(/row-level security/);
    });

    it("the policy is the house one on each table (FORCE RLS, one tenant_isolation policy)", async () => {
      const r = await admin().query(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname AND p.policyname = 'tenant_isolation') AS pol
           FROM pg_class c WHERE c.relname IN ('ai_budgets', 'ai_person_allowances', 'ai_usage_alerts') ORDER BY 1`,
      );
      expect(r.rows).toEqual([
        { relname: "ai_budgets", relrowsecurity: true, relforcerowsecurity: true, pol: 1 },
        { relname: "ai_person_allowances", relrowsecurity: true, relforcerowsecurity: true, pol: 1 },
        { relname: "ai_usage_alerts", relrowsecurity: true, relforcerowsecurity: true, pol: 1 },
      ]);
    });
  });

  it("re-applies cleanly with the self-check passing, and keeps the rows (every statement is guarded)", async () => {
    const file = readFileSync(join(__dirname, "..", "..", "..", "migrations", MIGRATION), "utf8");
    const before = (await admin().query(`SELECT count(*)::int AS n FROM ai_budgets`)).rows[0].n;
    await admin().query(file);
    await admin().query(file);
    expect((await admin().query(`SELECT count(*)::int AS n FROM ai_budgets`)).rows[0].n).toBe(before);
    const ck = await admin().query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname LIKE 'ck_ai_budgets_%' OR conname LIKE 'ck_ai_person_allowances_%' OR conname LIKE 'ck_ai_usage_alerts_%'`);
    expect(ck.rows[0].n).toBe(8);
  });
});
