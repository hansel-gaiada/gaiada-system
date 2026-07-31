// TR-06 — reports module (0056) RLS: tenant isolation + THE THIRD WALL (module-sliced RLS).
//
// Verified through the NOSUPERUSER NOBYPASSRLS app role (initTestDb), so RLS is actually exercised.
//
// Mirrors module-hr-rls.test.ts exactly (0028's own third-wall suite) — the third wall lives in a
// SECOND GUC, `app.scopes` (CSV of module keys authorized for the request), consumed by
// app_module_allowed('reports'). withTenants({modules}) that sets it is app-side wiring (TR-09/TR-07
// will use it); here we set app.scopes directly (same transaction, set_config(...,true) = SET LOCAL)
// to prove the DB wall in isolation. `withReports` = a request that correctly declared the reports
// scope; plain `withTenants` = a request that did NOT — the exact "mis-scoped handler" this wall
// exists to catch. This is the program's FIRST reports-module table set, so this file is the ONLY
// guard against a missing module wall (rls.test.ts's sweep only proves tenant isolation, not module
// scoping — it would pass even if app_module_allowed('reports') were never composed into the policy).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, withGlobal, newId } from "./index";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createProject } from "../testing/fixtures";
import type { PoolClient } from "pg";

const REPORT_TABLES = ["report_work_calendars", "report_checkins", "report_work_facts"];

// withTenants + declare the reports module scope for the transaction (models
// withTenants([t], {modules:['reports']})).
async function withReports<T>(tenantIds: string[], fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants(tenantIds, async (c) => {
    await c.query("SELECT set_config('app.scopes', 'reports', true)");
    return fn(c);
  });
}

describe.skipIf(!TEST_URL)("reports module RLS — tenant isolation + third wall (0056)", () => {
  let B: string; // tenant under test
  let C: string; // unrelated tenant
  let user: string;
  let factId: string;

  beforeAll(async () => {
    await initTestDb();
    // Deliberately NOT put 'reports' in enabled_modules — the wall is scope-declaration-based
    // (mirrors 0028's HR precedent), not enablement-based.
    B = await createCompany("Tenant B");
    C = await createCompany("Tenant C");
    user = await createUser("worker@b.test");

    factId = newId();
    await withReports([B], (c) =>
      c.query(
        `INSERT INTO report_work_facts (id, tenant_id, fact_date, user_id, origin_site, tasks_completed)
         VALUES ($1,$2,'2026-07-28',$3,'central',3)`,
        [factId, B, user],
      ),
    );
  });
  afterAll(teardownTestDb);

  // ── (c) rls.test.ts invariant: every report_* table has tenant_id AND FORCE RLS ─────────────────
  it("all three report_* tables FORCE RLS (rls.test.ts sweep invariant)", async () => {
    const { rows } = await withGlobal((c) =>
      c.query<{ relname: string; relforcerowsecurity: boolean }>(
        `SELECT relname, relforcerowsecurity FROM pg_class
          WHERE relkind='r' AND relname = ANY($1)`,
        [REPORT_TABLES],
      ),
    );
    expect(rows.length).toBe(3);
    for (const r of rows) expect(r.relforcerowsecurity, `${r.relname} must FORCE RLS`).toBe(true);
  });

  it("each report_* table has exactly one FOR-ALL tenant_isolation policy", async () => {
    const { rows } = await withGlobal((c) =>
      c.query<{ tablename: string; policyname: string; cmd: string }>(
        `SELECT tablename, policyname, cmd FROM pg_policies
          WHERE tablename = ANY($1) ORDER BY tablename`,
        [REPORT_TABLES],
      ),
    );
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.policyname, r.tablename).toBe("tenant_isolation");
      expect(r.cmd, r.tablename).toBe("ALL");
    }
  });

  // ── tenant isolation: B's row visible under withReports([B]) only ───────────────────────────────
  it("a report_work_facts row for tenant B is visible under withReports([B])", async () => {
    const res = await withReports([B], (c) =>
      c.query(`SELECT tenant_id FROM report_work_facts WHERE id=$1`, [factId]),
    );
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].tenant_id).toBe(B);
  });

  it("B's fact row is invisible to unrelated tenant C (even with reports scope declared)", async () => {
    const res = await withReports([C], (c) => c.query(`SELECT id FROM report_work_facts WHERE id=$1`, [factId]));
    expect(res.rows.length).toBe(0);
  });

  it("cannot INSERT a report_checkins row into a tenant outside the authorized set (WITH CHECK)", async () => {
    await expect(
      withReports([B], (c) =>
        c.query(
          `INSERT INTO report_checkins (id, tenant_id, user_id, checkin_date, status, origin_site)
           VALUES (gen_random_uuid(),$1,$2,'2026-07-29','submitted','central')`,
          [C, user],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  // ── THE REQUIRED DEDICATED TEST: right tenant WITHOUT the reports module scope → ZERO rows ──────
  // This is the only guard for the missing-module-wall defect class — the rls.test.ts sweep proves
  // tenant isolation only and would pass even if app_module_allowed('reports') were never wired in.
  it("right tenant WITHOUT the reports module scope declared -> ZERO rows, on all three tables", async () => {
    // Plain withTenants([B]) sets app.current_tenant_ids but NOT app.scopes -- the mis-scoped handler.
    const facts = await withTenants([B], (c) => c.query(`SELECT id FROM report_work_facts WHERE id=$1`, [factId]));
    expect(facts.rows.length).toBe(0);

    for (const t of REPORT_TABLES) {
      const res = await withTenants([B], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`));
      expect(res.rows[0].n, `${t} under withTenants([B]) with no reports scope must be zero`).toBe(0);
    }
  });

  it("right tenant with a DIFFERENT module scope (e.g. 'hr') -> ZERO rows", async () => {
    const res = await withTenants([B], async (c) => {
      await c.query("SELECT set_config('app.scopes', 'hr,pm', true)");
      return c.query(`SELECT id FROM report_work_facts WHERE id=$1`, [factId]);
    });
    expect(res.rows.length).toBe(0);
  });

  it("WITH CHECK: cannot INSERT a report_* row without declaring the reports scope (write wall)", async () => {
    // Correct tenant [B], but no reports scope -> WITH CHECK app_module_allowed('reports') is
    // false -> refused.
    await expect(
      withTenants([B], (c) =>
        c.query(
          `INSERT INTO report_checkins (id, tenant_id, user_id, checkin_date, status, origin_site)
           VALUES (gen_random_uuid(),$1,$2,'2026-07-30','submitted','central')`,
          [B, user],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  // ── empty tenant set -> zero rows, never an error (0025 fail-closed, preserved) ──────────────────
  it("empty tenant set -> zero rows on every report_* table, no error (even with reports scope)", async () => {
    for (const t of REPORT_TABLES) {
      const res = await withReports([], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`));
      expect(res.rows[0].n, `${t} under withReports([]) must be empty, not error`).toBe(0);
    }
  });

  // ── app_module_allowed inlines into the predicate (STABLE, once-per-scan, not per-row) ───────────
  it("app_module_allowed inlines into the RLS predicate (not an opaque per-row call)", async () => {
    const plan = await withReports([B], async (c) => {
      const r = await c.query<{ ["QUERY PLAN"]: string }>(`EXPLAIN (COSTS OFF) SELECT * FROM report_work_facts`);
      return r.rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("string_to_array"); // both helpers inlined
    expect(plan).not.toContain("app_module_allowed");
    expect(plan).not.toContain("app_current_tenants");
  });

  // ── ruling (1): origin_site NOT NULL with NO default — proves no silent site mislabeling ────────
  it("origin_site has NO default on any of the three tables — omitting it fails loudly", async () => {
    await expect(
      withReports([B], (c) =>
        c.query(
          `INSERT INTO report_work_calendars (id, tenant_id) VALUES (gen_random_uuid(), $1)`,
          [B],
        ),
      ),
    ).rejects.toThrow(/null value in column "origin_site"/);
  });

  // ── ruling (2): composite FK on project_id — cross-tenant attribution smuggling is impossible ───
  it("report_work_facts.project_id rejects a project belonging to a DIFFERENT tenant (composite FK)", async () => {
    const otherProject = await createProject(C, "C's project");
    await expect(
      withReports([B], (c) =>
        c.query(
          `INSERT INTO report_work_facts (id, tenant_id, fact_date, project_id, origin_site)
           VALUES (gen_random_uuid(), $1, '2026-07-28', $2, 'central')`,
          [B, otherProject],
        ),
      ),
    ).rejects.toThrow(/violates foreign key constraint "fk_report_work_facts_project_tenant"/);
  });

  it("report_work_facts.project_id accepts a project belonging to the SAME tenant", async () => {
    const ownProject = await createProject(B, "B's project");
    const id = newId();
    const res = await withReports([B], (c) =>
      c.query(
        `INSERT INTO report_work_facts (id, tenant_id, fact_date, project_id, origin_site)
         VALUES ($1, $2, '2026-07-28', $3, 'central') RETURNING id`,
        [id, B, ownProject],
      ),
    );
    expect(res.rows[0].id).toBe(id);
  });

  // ── shape requirement: UNIQUE NULLS NOT DISTINCT makes the daily upsert idempotent even for
  //    rows with NULL user/project/unit (§4a invariant 5, PG15+) ───────────────────────────────────
  it("report_work_facts rejects a second row for the same (tenant, date, NULL user, NULL project, NULL unit)", async () => {
    await withReports([B], (c) =>
      c.query(
        `INSERT INTO report_work_facts (id, tenant_id, fact_date, origin_site)
         VALUES (gen_random_uuid(), $1, '2026-07-15', 'central')`,
        [B],
      ),
    );
    await expect(
      withReports([B], (c) =>
        c.query(
          `INSERT INTO report_work_facts (id, tenant_id, fact_date, origin_site)
           VALUES (gen_random_uuid(), $1, '2026-07-15', 'central')`,
          [B],
        ),
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });

  // ── shape requirement: one check-in per person per day ───────────────────────────────────────────
  it("report_checkins rejects a second check-in for the same (tenant, user, day)", async () => {
    await withReports([B], (c) =>
      c.query(
        `INSERT INTO report_checkins (id, tenant_id, user_id, checkin_date, status, origin_site)
         VALUES (gen_random_uuid(), $1, $2, '2026-06-01', 'submitted', 'central')`,
        [B, user],
      ),
    );
    await expect(
      withReports([B], (c) =>
        c.query(
          `INSERT INTO report_checkins (id, tenant_id, user_id, checkin_date, status, origin_site)
           VALUES (gen_random_uuid(), $1, $2, '2026-06-01', 'auto_missed', 'central')`,
          [B, user],
        ),
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });

  // ── shape requirement: one calendar row per tenant v1 ────────────────────────────────────────────
  it("report_work_calendars rejects a second row for the same tenant", async () => {
    await withReports([B], (c) =>
      c.query(`INSERT INTO report_work_calendars (id, tenant_id, origin_site) VALUES (gen_random_uuid(), $1, 'central')`, [
        B,
      ]),
    );
    await expect(
      withReports([B], (c) =>
        c.query(`INSERT INTO report_work_calendars (id, tenant_id, origin_site) VALUES (gen_random_uuid(), $1, 'central')`, [
          B,
        ]),
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });
});
