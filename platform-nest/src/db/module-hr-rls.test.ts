// WSD-3 — HR module (0028) RLS: served-tenant isolation + THE THIRD WALL (module-sliced RLS).
//
// Verified through the NOSUPERUSER NOBYPASSRLS app role (initTestDb), so RLS is actually exercised.
//
// The third wall lives in a SECOND GUC, `app.scopes` (CSV of module keys authorized for the request),
// consumed by app_module_allowed('hr'). withTenants({modules}) that sets it is WSD-4 wiring; here we
// set app.scopes directly (same transaction, set_config(...,true) = SET LOCAL) to prove the DB wall
// in isolation. `withHr` = a request that correctly declared the hr scope; plain `withTenants` = a
// request that did NOT — the exact "mis-scoped handler" of design §5 beat 7.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, withGlobal, newId } from "./index";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";
import type { PoolClient } from "pg";

// withTenants + declare the hr module scope for the transaction (models withTenants([t],{modules:['hr']})).
async function withHr<T>(tenantIds: string[], fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants(tenantIds, async (c) => {
    await c.query("SELECT set_config('app.scopes', 'hr', true)");
    return fn(c);
  });
}

describe.skipIf(!TEST_URL)("HR module RLS — served-tenant + third-wall (0028)", () => {
  let A: string; // provider (Gaia agency) — serves hr to B/C, never touches B's rows
  let B: string; // served company (Viceroy) — owns its hr data
  let C: string; // second served / unrelated company
  let actor: string;
  let subject: string;
  let caseId: string;

  beforeAll(async () => {
    await initTestDb();
    // B/C get 'hr' via serving in the real flow — deliberately NOT via enabled_modules, to prove the
    // wall is scope-declaration-based (design §2.4), not enablement-based.
    A = await createCompany("Provider A", ["hr"]);
    B = await createCompany("Served B");
    C = await createCompany("Served C");
    actor = await createUser("hr-staff@a.test");
    subject = await createUser("employee@b.test");

    caseId = newId();
    await withHr([B], (c) =>
      c.query(
        `INSERT INTO hr_cases (id, tenant_id, subject_user_id, kind, title, created_by)
         VALUES ($1,$2,$3,'onboarding','Onboard employee',$4)`,
        [caseId, B, subject, actor],
      ),
    );
  });
  afterAll(teardownTestDb);

  // ── (c) rls.test.ts invariant: every hr_* table has tenant_id AND FORCE RLS ──────────────────────
  it("all six hr_* tables FORCE RLS (rls.test.ts sweep invariant)", async () => {
    const { rows } = await withGlobal((c) =>
      c.query<{ relname: string; relforcerowsecurity: boolean }>(
        `SELECT relname, relforcerowsecurity FROM pg_class
          WHERE relkind='r' AND relname IN
            ('hr_cases','hr_records','hr_leave_requests','hr_leave_balances','hr_attendance','hr_checklist_templates')`,
      ),
    );
    expect(rows.length).toBe(6);
    for (const r of rows) expect(r.relforcerowsecurity, `${r.relname} must FORCE RLS`).toBe(true);
  });

  it("each hr_* table has exactly one FOR-ALL tenant_isolation policy (sweep-compatible name)", async () => {
    const { rows } = await withGlobal((c) =>
      c.query<{ tablename: string; policyname: string; cmd: string }>(
        `SELECT tablename, policyname, cmd FROM pg_policies
          WHERE tablename LIKE 'hr\\_%' ORDER BY tablename`,
      ),
    );
    expect(rows.length).toBe(6);
    for (const r of rows) {
      expect(r.policyname, r.tablename).toBe("tenant_isolation");
      expect(r.cmd, r.tablename).toBe("ALL");
    }
  });

  // ── (a) served-tenant isolation: B's row visible under withHr([B]) only ──────────────────────────
  it("an HR row for served company B is visible under withHr([B])", async () => {
    const res = await withHr([B], (c) => c.query(`SELECT tenant_id FROM hr_cases WHERE id=$1`, [caseId]));
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].tenant_id).toBe(B);
  });

  it("B's HR row is invisible to served company C and to provider A (even with hr scope declared)", async () => {
    const fromC = await withHr([C], (c) => c.query(`SELECT id FROM hr_cases WHERE id=$1`, [caseId]));
    const fromA = await withHr([A], (c) => c.query(`SELECT id FROM hr_cases WHERE id=$1`, [caseId]));
    expect(fromC.rows.length).toBe(0);
    expect(fromA.rows.length).toBe(0);
  });

  it("cannot INSERT an hr row into a tenant outside the authorized set (WITH CHECK)", async () => {
    await expect(
      withHr([B], (c) =>
        c.query(
          `INSERT INTO hr_cases (id, tenant_id, kind, title, created_by) VALUES (gen_random_uuid(),$1,'other','x',$2)`,
          [C, actor],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  // ── (b) THE THIRD WALL: right tenant, but the request did NOT declare the hr module scope ────────
  it("right tenant WITHOUT the hr module scope declared → ZERO rows (design §5 beat 7)", async () => {
    // Plain withTenants([B]) sets app.current_tenant_ids but NOT app.scopes — the mis-scoped handler.
    const res = await withTenants([B], (c) => c.query(`SELECT id FROM hr_cases WHERE id=$1`, [caseId]));
    expect(res.rows.length).toBe(0);
  });

  it("right tenant with a DIFFERENT module scope (e.g. 'finance') → ZERO rows", async () => {
    const res = await withTenants([B], async (c) => {
      await c.query("SELECT set_config('app.scopes', 'finance,legal', true)");
      return c.query(`SELECT id FROM hr_cases WHERE id=$1`, [caseId]);
    });
    expect(res.rows.length).toBe(0);
  });

  it("WITH CHECK: cannot INSERT an hr row without declaring the hr scope (write wall)", async () => {
    // Correct tenant [B], but no hr scope → WITH CHECK app_module_allowed('hr') is false → refused.
    await expect(
      withTenants([B], (c) =>
        c.query(
          `INSERT INTO hr_cases (id, tenant_id, kind, title, created_by) VALUES (gen_random_uuid(),$1,'other','no-scope',$2)`,
          [B, actor],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  // ── (d) empty tenant set → zero rows, never an error (0025 fail-closed, preserved) ───────────────
  it("empty tenant set → zero rows on every hr_* table, no error (even with hr scope)", async () => {
    for (const t of [
      "hr_cases",
      "hr_records",
      "hr_leave_requests",
      "hr_leave_balances",
      "hr_attendance",
      "hr_checklist_templates",
    ]) {
      const res = await withHr([], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`));
      expect(res.rows[0].n, `${t} under withHr([]) must be empty, not error`).toBe(0);
    }
  });

  // ── app_module_allowed inlines into the predicate (STABLE, once-per-scan, not per-row) ───────────
  it("app_module_allowed inlines into the RLS predicate (not an opaque per-row call)", async () => {
    const plan = await withHr([B], async (c) => {
      const r = await c.query<{ ["QUERY PLAN"]: string }>(`EXPLAIN (COSTS OFF) SELECT * FROM hr_cases`);
      return r.rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("string_to_array"); // both helpers inlined
    expect(plan).not.toContain("app_module_allowed");
    expect(plan).not.toContain("app_current_tenants");
  });

  // Full round-trip on the module wall using approvals origin='hr' too (proves the origin widening).
  it("automation_approvals accepts origin='hr' (widened constraint)", async () => {
    const id = newId();
    const res = await withTenants([B], (c) =>
      c.query(
        `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, origin, origin_site)
         VALUES ($1,$2,'hr:leave','hr.fileLeave','hr','central') RETURNING origin`,
        [id, B],
      ),
    );
    expect(res.rows[0].origin).toBe("hr");
  });
});
