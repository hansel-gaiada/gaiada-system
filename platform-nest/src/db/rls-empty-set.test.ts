// ORG-1 / A15 regression: a COMPUTED-and-empty authorized-tenant set must return ZERO ROWS on
// every tenant-scoped table, never an error (the empty-set → ''::uuid cast bug the 0025 helper
// closes). Plus an EXPLAIN check proving app_current_tenants() inlines into the policy predicate
// (so it is not evaluated per row).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, withGlobal } from "./index";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createProject } from "../testing/fixtures";

describe.skipIf(!TEST_URL)("RLS empty-set hardening (app_current_tenants / 0025)", () => {
  beforeAll(async () => {
    await initTestDb();
    const a = await createCompany("Empty-set A");
    await createProject(a, "seed"); // at least one row somewhere, to prove [] filters it out
  });
  afterAll(teardownTestDb);

  it("withTenants([]) returns zero rows (never an error) on EVERY tenant-scoped table", async () => {
    // Every table with a tenant_id column. Excludes site_subscriptions' non-tenant policy path via
    // the same GUC-empty logic — under [] its sync_context predicate is also false → zero rows.
    const { rows: tables } = await withGlobal((c) =>
      c.query<{ table_name: string }>(
        `SELECT c.relname AS table_name
           FROM pg_class c
           JOIN information_schema.columns col
             ON col.table_name = c.relname AND col.column_name = 'tenant_id'
          WHERE c.relkind = 'r' AND col.table_schema = 'public'
          ORDER BY 1`,
      ),
    );
    expect(tables.length).toBeGreaterThanOrEqual(13);

    for (const { table_name } of tables) {
      // The whole point: this must resolve to 0, NOT throw a 22P02 invalid uuid cast.
      const res = await withTenants([], (c) =>
        c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table_name}`),
      );
      expect(res.rows[0].n, `${table_name} under withTenants([]) must be empty, not error`).toBe(0);
    }
  });

  it("the six re-pointed tables specifically survive the empty set", async () => {
    // 0011/0014/0017/0018_pm/0019/0021 — the migrations 0025 re-points at the helper.
    const sixMigrationTables = [
      "company_org_structure",
      "compliance_gates",
      "automation_approvals",
      "pipeline_runs",
      "pipeline_stages",
      "pipeline_gates",
      "scope_signoffs",
      "pm_project_meta",
      "pm_milestones",
      "pm_tasks",
      "pm_docs",
      "pm_suggestions",
      "pm_project_tags",
      "pm_project_statuses",
      "pm_progress_snapshots",
      "pm_templates",
      "pm_task_followers",
      "comment_reactions",
      "pm_doc_versions",
      "it_devices",
      "it_device_events",
      "invoices",
    ];
    for (const t of sixMigrationTables) {
      const res = await withTenants([], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`));
      expect(res.rows[0].n, `${t}`).toBe(0);
    }
  });

  it("app_current_tenants() inlines into the RLS predicate (not a per-row function call)", async () => {
    const a = await createCompany("Explain A");
    const plan = await withTenants([a], async (c) => {
      const r = await c.query<{ ["QUERY PLAN"]: string }>(`EXPLAIN (COSTS OFF) SELECT * FROM pm_tasks`);
      return r.rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
    // Inlined ⇒ the planner expands the body; the filter shows string_to_array(NULLIF(...)),
    // NOT an opaque app_current_tenants() call.
    expect(plan).toContain("string_to_array");
    expect(plan).not.toContain("app_current_tenants");
  });
});
