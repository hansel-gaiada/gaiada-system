// HR-FULL — the third-wall proof for every table waves A-D added, plus the schema invariants the
// new controllers rely on.
//
// ⚠ WHY THIS FILE EXISTS, in one sentence: a handler that forgets `{ modules: ["hr"] }` reads and
//    writes ZERO rows and reports success, so the only thing standing between "the wall is on every
//    new table" and "the wall is on most of them" is a test that enumerates them.
//
// `module-hr-rls.test.ts` (0028) does this for the original six tables. This does it for the
// thirty-three waves A–D add, and it derives the list from the MIGRATION FILES rather than from a
// hand-typed array — a hand-typed list is exactly the thing that silently omits the table somebody
// added last week.
//
// Follows the harness idiom of its sibling: `describe.skipIf(!TEST_URL)`, initTestDb/teardownTestDb,
// and `withTenants`/`withGlobal` rather than a raw pool — so RLS is exercised through the
// NOSUPERUSER NOBYPASSRLS app role, which is the only way any of this proves anything.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { withTenants, withGlobal } from "./index";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";

const MIGRATIONS_DIR = join(__dirname, "../../migrations");

const HR_FULL_MIGRATIONS = [
  "202608240140_hr_time_and_lifecycle.sql",
  "202608240141_hr_recruitment.sql",
  "202608240142_hr_compensation_benefits.sql",
  "202608240143_hr_payroll.sql",
];

/**
 * The tables each migration puts behind the wall, read from the DO-loop array in the file itself.
 * Deriving rather than listing is the point — see the header.
 */
function walledTablesFrom(file: string): string[] {
  const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
  const loop = /FOREACH t IN ARRAY ARRAY\[([\s\S]*?)\]\s*LOOP/.exec(sql);
  if (!loop) return [];
  return [...loop[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

/** Every table the migration CREATEs, so the two lists can be compared against each other. */
function createdTablesFrom(file: string): string[] {
  const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
  return [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)\s*\(/g)].map((m) => m[1]);
}

// Exactly as Postgres renders it back in pg_policies — including the outer parentheses it adds.
// Comparing against the string as WRITTEN in the migration silently fails, which is a small but real
// trap: the assertion looks right and the diff is one character at each end.
const EXPECTED_PREDICATE = "((tenant_id = ANY (app_current_tenants())) AND app_module_allowed('hr'::text))";
const allWalled = HR_FULL_MIGRATIONS.flatMap(walledTablesFrom);

/** withTenants + the hr module scope declared for the transaction — a correctly-scoped request. */
async function withHr<T>(tenantIds: string[], fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants(tenantIds, async (c) => {
    await c.query("SELECT set_config('app.scopes', 'hr', true)");
    return fn(c);
  });
}

// ── Static half: runs everywhere, no database needed. ────────────────────────────────────────────
describe("HR-FULL · the migration files themselves", () => {
  it("all five HR-FULL migrations are present in the ledger directory", () => {
    const present = new Set(readdirSync(MIGRATIONS_DIR));
    for (const f of [...HR_FULL_MIGRATIONS, "202608240144_iam_hr_full_permissions.sql"]) {
      expect(present.has(f), `${f} is missing from migrations/`).toBe(true);
    }
  });

  it("EVERY table these migrations create is also in that migration's own third-wall DO loop", () => {
    // The failure nothing else catches: a new CREATE TABLE landing without its name added to the
    // loop below it. The table then has NO RLS at all, and every query against it works perfectly —
    // across tenants.
    for (const file of HR_FULL_MIGRATIONS) {
      const walled = new Set(walledTablesFrom(file));
      const unwalled = createdTablesFrom(file).filter((t) => !walled.has(t));
      expect(unwalled, `${file} creates table(s) its DO loop does not wall`).toEqual([]);
    }
  });

  it("adds 33 distinct walled tables — 10 (A) + 9 (B) + 7 (C) + 7 (D)", () => {
    // A count pin, so a table quietly vanishing from a migration shows up in the diff rather than
    // as a silently smaller sweep below.
    expect(walledTablesFrom(HR_FULL_MIGRATIONS[0])).toHaveLength(10);
    expect(walledTablesFrom(HR_FULL_MIGRATIONS[1])).toHaveLength(9);
    expect(walledTablesFrom(HR_FULL_MIGRATIONS[2])).toHaveLength(7);
    expect(walledTablesFrom(HR_FULL_MIGRATIONS[3])).toHaveLength(7);
    expect(allWalled).toHaveLength(33);
    expect(new Set(allWalled).size).toBe(33);   // no duplicates across the four files
  });

  it("every walled table is hr_-prefixed", () => {
    // The one non-hr_ table these waves touch is `employees` (0109), already walled there.
    for (const t of allWalled) expect(t.startsWith("hr_"), `${t} is not hr_-prefixed`).toBe(true);
  });
});

// ── Live half. Skips silently without DATABASE_URL_TEST — CHECK THE SKIP COUNT. ─────────────────
describe.skipIf(!TEST_URL)("HR-FULL · the third wall, in the database", () => {
  let A: string;   // the tenant under test
  let B: string;   // an unrelated tenant, for the cross-tenant probe
  let actor: string;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("HR-FULL Wall A", ["hr"]);
    B = await createCompany("HR-FULL Wall B", ["hr"]);
    actor = await createUser("wall-actor@a.test");
  });
  afterAll(async () => { await teardownTestDb(); });

  it("FORCE RLS is on for every walled table", async () => {
    const rows = await withGlobal((c) => c.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname = ANY($1::text[]) AND relkind = 'r'`,
      [allWalled],
    ));
    expect(rows.rows).toHaveLength(allWalled.length);
    for (const r of rows.rows) {
      expect(r.relrowsecurity, `${r.relname}: RLS not enabled`).toBe(true);
      // FORCE, not merely ENABLE: without it the table OWNER bypasses its own policy, and the owner
      // is what migrations and any accidental superuser connection run as.
      expect(r.relforcerowsecurity, `${r.relname}: RLS not FORCEd`).toBe(true);
    }
  });

  it("the tenant_isolation predicate is BYTE-IDENTICAL on every walled table", async () => {
    const rows = await withGlobal((c) => c.query<{ tablename: string; qual: string; with_check: string }>(
      `SELECT tablename, qual, with_check FROM pg_policies
        WHERE policyname = 'tenant_isolation' AND tablename = ANY($1::text[])`,
      [allWalled],
    ));
    expect(rows.rows).toHaveLength(allWalled.length);
    for (const r of rows.rows) {
      // Both directions. A USING-only policy would let a caller INSERT into another tenant and then
      // be unable to read it back — silent, and a genuine cross-tenant write.
      expect(r.qual, `${r.tablename}: USING predicate drifted from 0028's form`).toBe(EXPECTED_PREDICATE);
      expect(r.with_check, `${r.tablename}: WITH CHECK predicate drifted from 0028's form`).toBe(EXPECTED_PREDICATE);
    }
  });

  it("app_module_allowed('hr') is NEVER TRUE unless the hr scope is declared", async () => {
    // ⚠ Asserting NOT-TRUE rather than FALSE, and the difference is a real one worth pinning.
    //
    // With the GUC unset, `string_to_array(NULLIF(current_setting(...), ''), ',')` is NULL, so
    // `mod = ANY(NULL)` evaluates to NULL — not false. 0028's own header comment says "-> false",
    // which is not what the database does. It is still FAIL-CLOSED, because an RLS policy admits a
    // row only on TRUE and treats NULL exactly like false; but anyone who read that comment and
    // relied on a boolean coming back (an `IF NOT app_module_allowed(...)` in a later migration,
    // say) would get three-valued-logic behaviour they did not expect. Pinned here as NOT-TRUE so
    // the suite states what is actually guaranteed.
    await withTenants([A], async (c) => {
      const unset = await c.query<{ ok: boolean | null }>(`SELECT app_module_allowed('hr') AS ok`);
      expect(unset.rows[0].ok).not.toBe(true);

      await c.query(`SELECT set_config('app.scopes', '', true)`);
      expect((await c.query<{ ok: boolean | null }>(`SELECT app_module_allowed('hr') AS ok`)).rows[0].ok).not.toBe(true);

      // A DIFFERENT module's scope must not open the hr wall. Here the array IS non-null, so this
      // one really is a hard false rather than a NULL.
      await c.query(`SELECT set_config('app.scopes', 'pm,billing', true)`);
      expect((await c.query<{ ok: boolean | null }>(`SELECT app_module_allowed('hr') AS ok`)).rows[0].ok).toBe(false);

      await c.query(`SELECT set_config('app.scopes', 'hr', true)`);
      expect((await c.query<{ ok: boolean | null }>(`SELECT app_module_allowed('hr') AS ok`)).rows[0].ok).toBe(true);
    });
  });

  it("a RIGHT-TENANT read with NO module scope returns ZERO rows on every walled table", async () => {
    // The behaviour the wall exists for, and the one that is invisible in production: the query
    // succeeds, returns nothing, and the console renders empty.
    await withTenants([A], async (c) => {
      for (const table of allWalled) {
        const res = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
        expect(res.rows[0].n, `${table} returned rows without hr module scope`).toBe("0");
      }
    });
  });

  it("an INSERT with the right tenant but NO module scope is REJECTED", async () => {
    await expect(
      withTenants([A], (c) => c.query(
        `INSERT INTO hr_holiday_calendars (tenant_id, name) VALUES ($1, 'should not land')`, [A],
      )),
    ).rejects.toThrow(/row-level security/i);
  });

  it("WITH the module scope declared, the same INSERT and read succeed", async () => {
    // The positive control. Without it, a wall that rejected EVERYTHING would pass every assertion
    // above and this suite would prove nothing.
    const n = await withHr([A], async (c) => {
      await c.query(`INSERT INTO hr_holiday_calendars (tenant_id, name) VALUES ($1, 'probe calendar')`, [A]);
      const res = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM hr_holiday_calendars WHERE name = 'probe calendar'`,
      );
      return res.rows[0].n;
    });
    expect(n).toBe("1");
  });

  it("a WRONG-TENANT read returns zero even WITH the module scope open", async () => {
    // Wall 1 and wall 3 are independent; opening the module scope must not open the tenant one.
    await withHr([A], (c) => c.query(`INSERT INTO hr_holiday_calendars (tenant_id, name) VALUES ($1, 'A only')`, [A]));
    const n = await withHr([B], async (c) => {
      const res = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM hr_holiday_calendars WHERE name = 'A only'`,
      );
      return res.rows[0].n;
    });
    expect(n).toBe("0");
  });

  it("a cross-tenant INSERT is rejected even with the module scope open", async () => {
    await expect(
      withHr([A], (c) => c.query(`INSERT INTO hr_holiday_calendars (tenant_id, name) VALUES ($1, 'wrong home')`, [B])),
    ).rejects.toThrow(/row-level security/i);
  });

  // ── The invariants the controllers rely on ─────────────────────────────────────────────────────

  it("TWO OVERLAPPING OPEN COMPENSATION ROWS ARE IMPOSSIBLE", async () => {
    // The invariant payroll's point-in-time lookup rests on: without it there are two answers to
    // "what were they paid on the 15th" and the run picks one arbitrarily.
    const employeeId = await withHr([A], async (c) => {
      const e = await c.query<{ id: string }>(
        `INSERT INTO employees (tenant_id, display_name, hire_date, created_by) VALUES ($1,'Overlap Probe','2020-01-01',$2) RETURNING id`,
        [A, actor],
      );
      return e.rows[0].id;
    });
    await withHr([A], (c) => c.query(
      `INSERT INTO hr_compensation (tenant_id, employee_id, base_amount, effective_from) VALUES ($1,$2,10000000,'2026-01-01')`,
      [A, employeeId],
    ));
    await expect(
      withHr([A], (c) => c.query(
        `INSERT INTO hr_compensation (tenant_id, employee_id, base_amount, effective_from) VALUES ($1,$2,12000000,'2026-06-01')`,
        [A, employeeId],
      )),
    ).rejects.toThrow(/ex_hr_compensation_no_overlap|exclusion constraint/i);

    // Closing the incumbent first — the controller's own sequence — lets the successor land.
    await withHr([A], async (c) => {
      await c.query(
        `UPDATE hr_compensation SET effective_to = ('2026-06-01'::date - INTERVAL '1 day')::date
          WHERE employee_id = $1 AND effective_to IS NULL`,
        [employeeId],
      );
      await c.query(
        `INSERT INTO hr_compensation (tenant_id, employee_id, base_amount, effective_from) VALUES ($1,$2,12000000,'2026-06-01')`,
        [A, employeeId],
      );
    });
    const count = await withHr([A], async (c) => (await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM hr_compensation WHERE employee_id = $1`, [employeeId],
    )).rows[0].n);
    expect(count).toBe("2");
  });

  it("an offer cannot be 'converted' without an employee_id — the recruitment/HR boundary, in the DB", async () => {
    // ck_hr_offer_conversion is what stops a candidate drifting into staff through a status edit,
    // independently of whatever the controller does.
    const applicationId = await withHr([A], async (c) => {
      const req = await c.query<{ id: string }>(
        `INSERT INTO hr_requisitions (tenant_id, reference, title, created_by) VALUES ($1,'REQ-PROBE','Probe',$2) RETURNING id`,
        [A, actor],
      );
      const cand = await c.query<{ id: string }>(
        `INSERT INTO hr_candidates (tenant_id, full_name) VALUES ($1,'Probe Candidate') RETURNING id`, [A],
      );
      const app = await c.query<{ id: string }>(
        `INSERT INTO hr_applications (tenant_id, requisition_id, candidate_id, stage_key) VALUES ($1,$2,$3,'applied') RETURNING id`,
        [A, req.rows[0].id, cand.rows[0].id],
      );
      return app.rows[0].id;
    });
    await expect(
      withHr([A], (c) => c.query(
        `INSERT INTO hr_offers (tenant_id, application_id, base_amount, status, created_by)
         VALUES ($1,$2,10000000,'converted',$3)`,
        [A, applicationId, actor],
      )),
    ).rejects.toThrow(/ck_hr_offer_conversion|check constraint/i);

    // A draft offer on the same application is fine — the CHECK constrains only the converted state.
    await withHr([A], (c) => c.query(
      `INSERT INTO hr_offers (tenant_id, application_id, base_amount, created_by) VALUES ($1,$2,10000000,$3)`,
      [A, applicationId, actor],
    ));
  });

  it("only ONE default holiday calendar per tenant, but any number of non-defaults", async () => {
    await withHr([A], (c) => c.query(`INSERT INTO hr_holiday_calendars (tenant_id, name, is_default) VALUES ($1,'Default One',true)`, [A]));
    await expect(
      withHr([A], (c) => c.query(`INSERT INTO hr_holiday_calendars (tenant_id, name, is_default) VALUES ($1,'Default Two',true)`, [A])),
    ).rejects.toThrow(/ux_hr_holiday_calendars_default|duplicate key/i);
    // The partial index must not over-constrain: two non-defaults are legitimate.
    await withHr([A], async (c) => {
      await c.query(`INSERT INTO hr_holiday_calendars (tenant_id, name, is_default) VALUES ($1,'Alt A',false)`, [A]);
      await c.query(`INSERT INTO hr_holiday_calendars (tenant_id, name, is_default) VALUES ($1,'Alt B',false)`, [A]);
    });
  });

  it("engine-posted accruals are idempotent per period; a human adjustment stays repeatable", async () => {
    const subject = await createUser("accrual-subject@a.test");
    const insertEngine = () => withHr([A], (c) => c.query(
      `INSERT INTO hr_leave_accruals (tenant_id, subject_user_id, year, leave_type, kind, minutes, period_start, period_end)
       VALUES ($1,$2,2026,'vacation','accrual',480,'2026-01-01','2026-01-31')`,
      [A, subject],
    ));
    await insertEngine();
    // created_by IS NULL and period_end IS NOT NULL — covered by ux_hr_leave_accruals_engine_period.
    await expect(insertEngine()).rejects.toThrow(/ux_hr_leave_accruals_engine_period|duplicate key/i);

    // A human adjustment carries created_by and no period, so it falls OUTSIDE that partial index
    // and can legitimately be repeated. Scoping the index this way is deliberate.
    const adjust = () => withHr([A], (c) => c.query(
      `INSERT INTO hr_leave_accruals (tenant_id, subject_user_id, year, leave_type, kind, minutes, reason, created_by)
       VALUES ($1,$2,2026,'vacation','adjustment',240,'goodwill',$3)`,
      [A, subject, actor],
    ));
    await adjust();
    await adjust();
  });

  it("at most one live REGULAR payroll run per period; a correction run may coexist", async () => {
    const mk = (reference: string, kind: string) => withHr([A], (c) => c.query(
      `INSERT INTO hr_payroll_runs (tenant_id, reference, kind, period_start, period_end, created_by)
       VALUES ($1,$2,$3,'2026-08-01','2026-08-31',$4)`,
      [A, reference, kind, actor],
    ));
    await mk("PR-2026-08", "regular");
    await expect(mk("PR-2026-08-dup", "regular")).rejects.toThrow(/ux_hr_payroll_runs_regular_period|duplicate key/i);
    // The whole reason `kind` exists: an off-cycle correction is not a second regular run.
    await mk("PR-2026-08-corr", "correction");
  });

  it("a terminal pipeline stage must name its terminal kind", async () => {
    await expect(
      withHr([A], (c) => c.query(
        `INSERT INTO hr_pipeline_stages (tenant_id, key, label, is_terminal) VALUES ($1,'bad','Bad',true)`, [A],
      )),
    ).rejects.toThrow(/ck_hr_stage_terminal|check constraint/i);
    await withHr([A], (c) => c.query(
      `INSERT INTO hr_pipeline_stages (tenant_id, key, label, is_terminal, terminal_kind) VALUES ($1,'hired','Hired',true,'hired')`, [A],
    ));
  });

  it("a statutory parameter carries exactly one of value_num / value_json", async () => {
    const setId = await withHr([A], async (c) => (await c.query<{ id: string }>(
      `INSERT INTO hr_statutory_parameter_sets (tenant_id, name, effective_from, created_by)
       VALUES ($1,'Probe 2026','2026-01-01',$2) RETURNING id`,
      [A, actor],
    )).rows[0].id);
    for (const [num, json] of [[null, null], [1, '{"a":1}']] as [number | null, string | null][]) {
      await expect(
        withHr([A], (c) => c.query(
          `INSERT INTO hr_statutory_parameters (tenant_id, set_id, key, value_num, value_json) VALUES ($1,$2,'probe.key',$3,$4)`,
          [A, setId, num, json],
        )),
      ).rejects.toThrow(/ck_hr_param_one_value|check constraint/i);
    }
    await withHr([A], (c) => c.query(
      `INSERT INTO hr_statutory_parameters (tenant_id, set_id, key, value_num) VALUES ($1,$2,'bpjs.kesehatan.employer_rate',0.04)`,
      [A, setId],
    ));
  });

  it("a parameter set is UNRATIFIED on creation — the payroll gate's default state", async () => {
    const row = await withHr([A], async (c) => (await c.query<{ ratified_at: string | null }>(
      `SELECT ratified_at FROM hr_statutory_parameter_sets ORDER BY created_at DESC LIMIT 1`,
    )).rows[0]);
    expect(row.ratified_at).toBeNull();
  });
});
