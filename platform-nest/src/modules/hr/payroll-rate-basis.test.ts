// Rate basis vs pay frequency — the conversion, and the fact that THREE copies of it agree.
//
// The multiplier from a quoted rate to a period amount exists in three places by design:
//   • SQL   — hr_annualisation_factor() / hr_periods_per_year()   (migration 202608260930)
//   • Nest  — annualisationFactor() / periodsPerYear()            (payroll-calc.ts)
//   • UI    — monthlyEquivalent()                                 (platform-ui/src/lib/hr-full.ts)
//
// Payroll must not need a database round trip to convert a rate, and platform-ui is a separate
// project that cannot import from platform-nest. So the duplication is deliberate — but a
// duplicated constant that drifts is worse than one that was never duplicated, and drift here means
// two parts of the system disagreeing about someone's salary. The SQL/Nest pair is asserted equal
// below against a live database; the UI copy is pinned by its own test in that project.
//
// The pure conversions below need no infrastructure. The agreement check does — it asks the actual
// database what its functions return, because a hand-transcribed "the SQL says 2080" assertion
// would pass with the migration deleted, which is precisely the failure it is meant to catch.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withGlobal, withTenants } from "../../db";
import { initTestDb, teardownTestDb } from "../../testing/setup";
import { createCompany } from "../../testing/fixtures";
import { annualisationFactor, periodsPerYear, periodBaseAmount } from "./payroll-calc";

// File-level, not per-describe: teardown from one describe would drop the database out from under
// the next one, and the failure would look like a missing function rather than a missing database.
beforeAll(initTestDb);
afterAll(teardownTestDb);

describe("rate basis → period amount", () => {
  it("pays an annual-quoted employee a TWELFTH on a monthly slip", () => {
    // The defect this whole split exists to prevent. Before it, the payslip generator selected the
    // basis and ignored it, handing base_amount to the engine as though it were always monthly — so
    // this employee would have received 120,000,000 every month instead of 10,000,000.
    expect(periodBaseAmount(120_000_000, "annual", "monthly")).toBe(10_000_000);
  });

  it("keeps a monthly rate on a monthly slip untouched", () => {
    expect(periodBaseAmount(12_000_000, "monthly", "monthly")).toBe(12_000_000);
  });

  it("converts an hourly rate across every frequency without losing a year", () => {
    // Whatever the cadence, twelve monthly slips and fifty-two weekly slips must add up to the same
    // annual cost. If they did not, the choice of pay frequency would silently change what someone
    // earns — which is the exact failure a separate frequency field is supposed to make impossible.
    const hourly = 100_000;
    const annual = hourly * 2080;
    for (const [freq, n] of [["monthly", 12], ["weekly", 52], ["biweekly", 26], ["semi_monthly", 24]] as const) {
      const per = periodBaseAmount(hourly, "hourly", freq);
      expect(per).toBeDefined();
      expect((per as number) * n).toBeCloseTo(annual, 6);
    }
  });

  it("refuses to convert a piece rate rather than guessing one", () => {
    // A piece rate's annual figure depends on OUTPUT, which is not in the compensation row. There is
    // no defensible multiplier, so there is no multiplier — the caller must skip and report.
    expect(periodBaseAmount(50_000, "piece_rate", "monthly")).toBeUndefined();
    expect(annualisationFactor("piece_rate")).toBeUndefined();
  });

  it("refuses an unrecognised basis or frequency", () => {
    // Falling back to monthly here would turn a typo into a salary.
    expect(periodBaseAmount(1_000, "fortnightly", "monthly")).toBeUndefined();
    expect(periodBaseAmount(1_000, "monthly", "quarterly")).toBeUndefined();
  });

  it("distinguishes biweekly from semi-monthly", () => {
    // 26 vs 24 — the pair most often conflated, and a ~8% difference in every slip.
    expect(periodsPerYear("biweekly")).toBe(26);
    expect(periodsPerYear("semi_monthly")).toBe(24);
  });
});

describe("the SQL copy agrees with the TypeScript copy", () => {
  it("returns identical factors for every basis and frequency", async () => {
    const bases = ["hourly", "daily", "weekly", "monthly", "annual", "piece_rate"];
    const freqs = ["weekly", "biweekly", "semi_monthly", "monthly"];

    await withGlobal(async (c) => {
      for (const b of bases) {
        const r = await c.query<{ f: string | null }>(`SELECT hr_annualisation_factor($1)::text AS f`, [b]);
        const sql = r.rows[0].f === null ? undefined : Number(r.rows[0].f);
        expect(sql, `annualisation factor for '${b}'`).toBe(annualisationFactor(b));
      }
      for (const f of freqs) {
        const r = await c.query<{ n: number | null }>(`SELECT hr_periods_per_year($1) AS n`, [f]);
        expect(r.rows[0].n ?? undefined, `periods per year for '${f}'`).toBe(periodsPerYear(f));
      }
    });
  });
});

describe("the jurisdiction rule is data, not an enum", () => {
  let tenant = "";
  let employee = "";

  beforeAll(async () => {
    tenant = await createCompany("Jurisdiction Rule Co", ["hr"]);
    // A bare employees row is enough: this describe is about the cadence guard, and routing the
    // fixture through the whole hire funnel would make a trigger test depend on recruitment.
    await withTenants([tenant], async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO employees (tenant_id, display_name, hire_date)
         VALUES ($1,'Cadence Fixture','2026-01-01') RETURNING id`,
        [tenant],
      );
      employee = r.rows[0].id;
    }, { modules: ["hr"] });
  });

  it("permits every frequency when no rule is recorded for the company", async () => {
    // A company with no jurisdiction row is UNCONSTRAINED, not defaulted to Indonesia. Inventing a
    // rule for an entity nobody has classified would be a legal assertion this system has no basis
    // for making.
    await withGlobal(async (c) => {
      const r = await c.query<{ src: string }>(
        `SELECT prosrc AS src FROM pg_proc WHERE proname = 'hr_pay_frequency_guard'`,
      );
      expect(r.rows[0].src).toContain("IF v_max IS NULL THEN");
    });
  });

  it("REFUSES a compensation row whose cadence exceeds the recorded cap", async () => {
    // Drives the guard for real rather than restating its arithmetic. A hardcoded table of
    // frequency->days compared against itself would pass with the trigger dropped.
    //
    // The cap is set to 7 days here so that a MONTHLY cadence violates it. Indonesia's actual cap is one
    // month, which every frequency this estate offers already satisfies — so under the real rule
    // this guard rejects nothing today. That is the intended state: it exists so that a longer
    // cadence added later cannot slip in unnoticed, and a test that only ever saw the permissive
    // case would never prove it was wired.
    await withTenants([tenant], async (c) => {
      await c.query(
        `INSERT INTO hr_payroll_jurisdiction_rules (tenant_id, country_code, max_payment_interval_days, basis)
         VALUES ($1,'ID',7,'test fixture — deliberately stricter than PP 36/2021 so monthly violates it')`,
        [tenant],
      );

    }, { modules: ["hr"] });

    // A SEPARATE transaction for each attempt. `withTenants` opens one transaction, and Postgres
    // aborts the whole thing on the first failed statement — so a rejection and the acceptance that
    // proves the guard is a filter rather than a wall cannot share a block. Trying to do both in
    // one produced "current transaction is aborted" and reads as a broken test, not a working guard.
    await expect(
      withTenants([tenant], (c) => c.query(
        `INSERT INTO hr_compensation (tenant_id, employee_id, base_amount, rate_basis, pay_frequency, effective_from)
         VALUES ($1,$2,12000000,'monthly','monthly','2026-01-01')`,
        [tenant, employee],
      ), { modules: ["hr"] }),
    ).rejects.toThrow(/HR_PAY_FREQUENCY_NOT_PERMITTED/);

    // ...and the frequency that DOES fit is accepted.
    const ok = await withTenants([tenant], (c) => c.query<{ id: string }>(
      `INSERT INTO hr_compensation (tenant_id, employee_id, base_amount, rate_basis, pay_frequency, effective_from)
       VALUES ($1,$2,3000000,'weekly','weekly','2026-01-01') RETURNING id`,
      [tenant, employee],
    ), { modules: ["hr"] });
    expect(ok.rows).toHaveLength(1);
  });
});
