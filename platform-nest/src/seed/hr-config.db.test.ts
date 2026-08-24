// seed:hr-config — proven against a real Postgres, not inspected.
//
// The two properties that matter and that a code read cannot establish:
//
//   1. IT ACTUALLY WRITES ROWS. This program's signature failure is a seed that reports success
//      having written nothing, because the hr module GUC was not open and every row silently failed
//      the RLS predicate. The only proof is a count read back through `withTenants(..., {modules})`.
//   2. IT IS IDEMPOTENT. Running twice must not double the holiday calendar or fork the policies —
//      seeds get re-run on every deploy, and a seed that is not idempotent is a seed that corrupts.
//
// A third, smaller one worth pinning: the statutory set lands UNRATIFIED. That is the payroll gate,
// and a seed that ratified its own numbers would defeat the entire mechanism.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withGlobal, withTenants } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import { seedHrConfig, verifyHrConfig } from "./hr-config";

const AGENCY_NAME = "Gaia Digital Agency";

describe.skipIf(!TEST_URL)("seed:hr-config — HR configuration, no personal data", () => {
  beforeAll(async () => {
    await initTestDb();
    // The seed resolves its tenant BY NAME and refuses to create one, so the fixture must. Using the
    // shared helper rather than a hand-written INSERT: `companies` carries NOT NULL columns
    // (origin_site) that a literal insert here would have to keep in sync by hand.
    await createCompany(AGENCY_NAME, ["hr"]);
  });
  afterAll(async () => { await teardownTestDb(); });

  it("refuses to run when the company does not exist, rather than creating a second one", async () => {
    // The by-name fork hazard migration 202608230612 exists to fix. Proven by renaming the row out
    // from under the seed and putting it back.
    await withGlobal((c) => c.query(`UPDATE companies SET name = 'temporarily-renamed' WHERE name = $1`, [AGENCY_NAME]));
    await expect(seedHrConfig()).rejects.toThrow(/Refusing to create one/);
    const n = await withGlobal((c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM companies`));
    expect(Number(n.rows[0].n)).toBe(1);   // it did NOT create a second company
    await withGlobal((c) => c.query(`UPDATE companies SET name = $1 WHERE name = 'temporarily-renamed'`, [AGENCY_NAME]));
  });

  it("WRITES ROWS — verified by reading back through the module scope, not by trusting the return", async () => {
    const r = await seedHrConfig();
    expect(r.tenantId).toBeTruthy();

    const counts = await verifyHrConfig(r.tenantId);
    // The assertion that catches the silent-zero failure. Every one of these must be non-zero.
    expect(counts.hr_holiday_calendars).toBe(1);
    expect(counts.hr_holidays).toBeGreaterThanOrEqual(15);
    expect(counts.hr_leave_policies).toBe(3);
    expect(counts.hr_leave_policy_assignments).toBe(3);   // one tenant-wide default per policy
    expect(counts.hr_pipeline_stages).toBe(9);
    expect(counts.hr_pay_grades).toBe(7);
    expect(counts.hr_allowance_types).toBe(6);
    expect(counts.hr_benefit_plans).toBe(5);
    expect(counts.hr_statutory_parameter_sets).toBe(1);
    expect(counts.hr_statutory_parameters).toBeGreaterThanOrEqual(24);
  });

  it("writes ZERO personal data — the Legal Gate 1 boundary, asserted", async () => {
    // The reason this seed can run against the live estate at all. If a future edit adds an employee
    // or a candidate here, this fails and the author has to justify it against the gate.
    const pii = await withTenants(
      [(await seedHrConfig()).tenantId],
      async (c) => ({
        employees: Number((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM employees`)).rows[0].n),
        candidates: Number((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM hr_candidates`)).rows[0].n),
        compensation: Number((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM hr_compensation`)).rows[0].n),
        payslips: Number((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM hr_payslips`)).rows[0].n),
        records: Number((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM hr_records`)).rows[0].n),
      }),
      { modules: ["hr"] },
    );
    expect(pii).toEqual({ employees: 0, candidates: 0, compensation: 0, payslips: 0, records: 0 });
  });

  it("IS IDEMPOTENT — a second and third run add nothing", async () => {
    const first = await verifyHrConfig((await seedHrConfig()).tenantId);
    const second = await seedHrConfig();
    const afterSecond = await verifyHrConfig(second.tenantId);
    await seedHrConfig();
    const afterThird = await verifyHrConfig(second.tenantId);

    expect(afterSecond).toEqual(first);
    expect(afterThird).toEqual(first);
    // And it reports the re-run honestly rather than claiming fresh creations.
    expect(second.calendar.created).toBe(false);
    expect(second.calendar.holidaysAdded).toBe(0);
    expect(second.leavePolicies.created).toEqual([]);
    expect(second.leavePolicies.existing).toHaveLength(3);
  });

  it("seeds the statutory set UNRATIFIED — the payroll gate a seed must never close for itself", async () => {
    const r = await seedHrConfig();
    const set = await withTenants(
      [r.tenantId],
      (c) => c.query<{ name: string; ratified_by: string | null; ratified_at: string | null; source_note: string }>(
        `SELECT name, ratified_by, ratified_at, source_note FROM hr_statutory_parameter_sets LIMIT 1`,
      ),
      { modules: ["hr"] },
    );
    expect(set.rows[0].ratified_by).toBeNull();
    expect(set.rows[0].ratified_at).toBeNull();
    expect(set.rows[0].name).toMatch(/UNRATIFIED/);
    // The provenance is on the row, so nobody has to go looking for where the numbers came from.
    expect(set.rows[0].source_note).toMatch(/NOT legally verified/i);
  });

  it("the leave policy encodes the Indonesian statutory shape, and sick leave is NOT an entitlement", async () => {
    const r = await seedHrConfig();
    const rows = await withTenants(
      [r.tenantId],
      (c) => c.query<{ leave_type: string; accrual_method: string; annual_entitlement_minutes: number; waiting_period_months: number; excludes_holidays: boolean }>(
        `SELECT leave_type, accrual_method, annual_entitlement_minutes, waiting_period_months, excludes_holidays
         FROM hr_leave_policies ORDER BY leave_type`,
      ),
      { modules: ["hr"] },
    );
    const byType = Object.fromEntries(rows.rows.map((x) => [x.leave_type, x]));

    // UU 13/2003 art. 79: 12 working days after 12 months of continuous service.
    expect(byType.vacation.accrual_method).toBe("upfront");
    expect(byType.vacation.annual_entitlement_minutes).toBe(12 * 480);
    expect(byType.vacation.waiting_period_months).toBe(12);

    // Sick leave is a PAID-WAGE rule in Indonesia, not a counted entitlement — accruing it would
    // invent a limit the law does not impose.
    expect(byType.sick.accrual_method).toBe("none");
    expect(byType.sick.annual_entitlement_minutes).toBe(0);

    // Unpaid leave is counted in CALENDAR days: a weekend in the middle does not make you present.
    expect(byType.unpaid.excludes_holidays).toBe(false);
  });

  it("cuti bersama is seeded as joint_leave that DEDUCTS entitlement — the distinction the kind exists for", async () => {
    const r = await seedHrConfig();
    const rows = await withTenants(
      [r.tenantId],
      (c) => c.query<{ kind: string; deducts_entitlement: boolean | null; n: string }>(
        `SELECT kind, deducts_entitlement, count(*)::text AS n FROM hr_holidays GROUP BY kind, deducts_entitlement`,
      ),
      { modules: ["hr"] },
    );
    const joint = rows.rows.find((x) => x.kind === "joint_leave");
    const pub = rows.rows.find((x) => x.kind === "public");
    expect(joint?.deducts_entitlement).toBe(true);
    // A public holiday is "not applicable" for the flag, NOT false — the column reads as absent.
    expect(pub?.deducts_entitlement).toBeNull();
  });

  it("the funnel has exactly one terminal stage per outcome, each naming its kind", async () => {
    const r = await seedHrConfig();
    const rows = await withTenants(
      [r.tenantId],
      (c) => c.query<{ terminal_kind: string }>(
        `SELECT terminal_kind FROM hr_pipeline_stages WHERE is_terminal ORDER BY terminal_kind`,
      ),
      { modules: ["hr"] },
    );
    expect(rows.rows.map((x) => x.terminal_kind)).toEqual(["hired", "rejected", "withdrawn"]);
  });

  it("all five BPJS programs are SEPARATE plans — one flag could not carry five rate/cap pairs", async () => {
    const r = await seedHrConfig();
    const rows = await withTenants(
      [r.tenantId],
      (c) => c.query<{ statutory_code: string; employer_rate: string; wage_cap: string | null }>(
        `SELECT statutory_code, employer_rate, wage_cap FROM hr_benefit_plans ORDER BY statutory_code`,
      ),
      { modules: ["hr"] },
    );
    expect(rows.rows.map((x) => x.statutory_code)).toEqual([
      "bpjs_jht", "bpjs_jkk", "bpjs_jkm", "bpjs_jp", "bpjs_kesehatan",
    ]);
    // The rates genuinely differ — which is the whole argument for five rows.
    expect(new Set(rows.rows.map((x) => x.employer_rate)).size).toBeGreaterThan(1);
    // And so do the caps: kesehatan and jp are capped, the rest are not.
    expect(rows.rows.filter((x) => x.wage_cap !== null)).toHaveLength(2);
  });
});
