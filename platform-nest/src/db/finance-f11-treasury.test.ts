// Finance F11 — TREASURY: loans, bonds, leases. Migration 202608251830.
//
// The assertions that matter are arithmetic, because a treasury engine that produces plausible
// numbers is the failure mode:
//
//   * an annuity's principal must sum to EXACTLY the principal borrowed — a few rupiah left on a
//     settled loan never reconciles against the GL;
//   * interest must fall as the balance falls, or it is not amortising;
//   * a bullet must charge interest throughout and repay everything at the end;
//   * the effective rate must actually be used when set, or PSAK 71 is decoration.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, newId } from "./index";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";
import type { PoolClient } from "pg";

async function fin<T>(t: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants([t], async (c) => {
    await c.query("SELECT set_config('app.scopes','finance',true)");
    return fn(c);
  });
}

interface Row {
  seq: number;
  due_date: Date;
  opening: string;
  interest: string;
  principal: string;
  closing: string;
}

describe.skipIf(!TEST_URL)("Finance F11 — treasury (202608251830)", () => {
  let CO: string;
  let actor: string;
  let seq = 0;

  beforeAll(async () => {
    await initTestDb();
    CO = await createCompany("Treasury Co");
    actor = await createUser("treasury@f11.test");
    await fin(CO, async (c) => {
      await c.query(
        `INSERT INTO finance_company_settings (tenant_id,functional_currency,presentation_currency,fiscal_year_start_month)
         VALUES ($1,'IDR','IDR',1) ON CONFLICT (tenant_id) DO NOTHING`,
        [CO],
      );
      await c.query(`SELECT finance_instantiate_coa($1,'id_psak_general_v1')`, [CO]);
      const fy = await c.query<{ id: string }>(
        `INSERT INTO finance_fiscal_years (tenant_id,code,start_date,end_date)
         VALUES ($1,'FY2026','2026-01-01','2027-01-01') RETURNING id`,
        [CO],
      );
      await c.query(`SELECT finance_generate_periods($1,'monthly')`, [fy.rows[0].id]);
    });
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  async function instrument(o: {
    kind?: string;
    principal: number;
    rate?: number;
    effective?: number | null;
    method?: string;
    months?: number;
    paymentMonths?: number;
  }): Promise<string> {
    const id = newId();
    const months = o.months ?? 12;
    await fin(CO, (c) =>
      c.query(
        `INSERT INTO finance_instruments
           (id,tenant_id,code,name,kind,principal,nominal_rate,effective_rate,start_date,maturity_date,
            payment_months,repayment_method)
         VALUES ($1,$2,$3,'instr',$4,$5,$6,$7,'2026-01-01',
                 ('2026-01-01'::date + make_interval(months => $8))::date,$9,$10)`,
        [
          id, CO, `L${++seq}`, o.kind ?? "loan_payable", o.principal, o.rate ?? 12,
          o.effective ?? null, months, o.paymentMonths ?? 1, o.method ?? "annuity",
        ],
      ),
    );
    return id;
  }
  const schedule = (id: string) =>
    fin(CO, async (c) =>
      (await c.query<Row>(`SELECT * FROM finance_instrument_schedule($1) ORDER BY seq`, [id])).rows,
    );
  const sum = (rows: Row[], k: "interest" | "principal") =>
    Number(rows.reduce((a, r) => a + Number(r[k]), 0).toFixed(2));

  it("★ an annuity's principal sums to EXACTLY the amount borrowed", async () => {
    const id = await instrument({ principal: 120_000_000, rate: 12, months: 12 });
    const rows = await schedule(id);
    expect(rows).toHaveLength(12);
    expect(sum(rows, "principal")).toBe(120_000_000);
    expect(Number(rows[11].closing)).toBe(0);
  });

  it("★ interest FALLS as the balance falls — otherwise it is not amortising", async () => {
    const id = await instrument({ principal: 120_000_000, rate: 12, months: 12 });
    const rows = await schedule(id);
    expect(Number(rows[0].interest)).toBeGreaterThan(Number(rows[11].interest));
    // 1% per month on the opening balance.
    expect(Number(rows[0].interest)).toBe(1_200_000);
    // And principal RISES as interest falls — the instalment is level.
    expect(Number(rows[11].principal)).toBeGreaterThan(Number(rows[0].principal));
  });

  it("★ a BULLET charges interest throughout and repays everything at maturity", async () => {
    const id = await instrument({ principal: 100_000_000, rate: 12, months: 12, method: "bullet" });
    const rows = await schedule(id);
    // Balance never falls, so interest is constant.
    expect(Number(rows[0].interest)).toBe(1_000_000);
    expect(Number(rows[10].interest)).toBe(1_000_000);
    expect(Number(rows[0].principal)).toBe(0);
    expect(Number(rows[11].principal)).toBe(100_000_000);
    expect(Number(rows[11].closing)).toBe(0);
  });

  it("straight-principal repays an equal slice each period", async () => {
    const id = await instrument({ principal: 120_000_000, rate: 12, months: 12, method: "straight_principal" });
    const rows = await schedule(id);
    expect(Number(rows[0].principal)).toBe(10_000_000);
    expect(sum(rows, "principal")).toBe(120_000_000);
    // Interest falls faster than an annuity's, because principal drops faster.
    expect(Number(rows[11].interest)).toBeLessThan(Number(rows[0].interest));
  });

  it("an INTEREST-FREE loan is legitimate and still amortises", async () => {
    // A shareholder loan at 0% is common and must not divide by zero or refuse.
    const id = await instrument({ principal: 60_000_000, rate: 0, months: 12 });
    const rows = await schedule(id);
    expect(sum(rows, "interest")).toBe(0);
    expect(sum(rows, "principal")).toBe(60_000_000);
    expect(Number(rows[11].closing)).toBe(0);
  });

  it("★ PSAK 71: the EFFECTIVE rate is used when set, not the coupon", async () => {
    // A bond issued at a discount: the 10% coupon is not the true cost of borrowing.
    const coupon = await instrument({ kind: "bond_issued", principal: 100_000_000, rate: 10, months: 12, method: "bullet" });
    const effective = await instrument({
      kind: "bond_issued", principal: 100_000_000, rate: 10, effective: 14, months: 12, method: "bullet",
    });
    const a = await schedule(coupon);
    const b = await schedule(effective);
    // Same principal, same coupon — the one carrying an effective rate bears MORE interest, which
    // is the entire point of amortised cost.
    expect(sum(b, "interest")).toBeGreaterThan(sum(a, "interest"));
    expect(Number(b[0].interest)).toBe(Number((100_000_000 * 0.14 / 12).toFixed(2)));
  });

  it("★ the accrual posts INTEREST ONLY — a payment is not an expense", async () => {
    const id = await instrument({ principal: 120_000_000, rate: 12, months: 12 });
    await fin(CO, (c) => c.query(`SELECT finance_post_instrument_accrual($1,1,$2)`, [id, actor]));
    const bal = async (code: string) =>
      fin(CO, async (c) =>
        Number(
          (
            await c.query<{ b: string }>(
              `SELECT COALESCE(sum(m.balance),0) b FROM finance_account_movement($1,NULL,NULL) m
                 JOIN finance_accounts a ON a.id=m.account_id WHERE a.code=$2`,
              [CO, code],
            )
          ).rows[0].b,
        ),
      );
    // Only the 1,200,000 of interest hits expense. The ~9,000,000 of principal in that instalment
    // is a balance-sheet movement and costs nothing.
    expect(await bal("7500")).toBe(1_200_000);
    expect(await bal("2130")).toBe(1_200_000);
  });

  it("accruing the same instalment twice is refused by the DATABASE", async () => {
    const id = await instrument({ principal: 120_000_000, rate: 12, months: 12 });
    await fin(CO, (c) => c.query(`SELECT finance_post_instrument_accrual($1,1,$2)`, [id, actor]));
    await expect(
      fin(CO, (c) => c.query(`SELECT finance_post_instrument_accrual($1,1,$2)`, [id, actor])),
    ).rejects.toThrow(/ux_finance_instr_payment_seq|finance_instr_payment/);
  });

  it("★ F11-08: the current/non-current split is what a lender reads first", async () => {
    const id = await instrument({ principal: 240_000_000, rate: 12, months: 24, method: "straight_principal" });
    const split = await fin(CO, async (c) =>
      (
        await c.query<{ outstanding: string; current_portion: string; non_current_portion: string }>(
          `SELECT * FROM finance_instrument_maturity_split($1,'2026-01-01') WHERE instrument_id=$2`,
          [CO, id],
        )
      ).rows[0],
    );
    expect(Number(split.outstanding)).toBe(240_000_000);
    // 24 equal instalments of 10m; twelve fall within a year.
    expect(Number(split.current_portion)).toBe(120_000_000);
    expect(Number(split.non_current_portion)).toBe(120_000_000);
  });

  it("★ PSAK 73: a lease creates a ROU asset depreciated over the LEASE TERM", async () => {
    const cls = newId();
    await fin(CO, (c) =>
      c.query(
        `INSERT INTO finance_asset_classes (id,tenant_id,code,name,book_method,book_life_months)
         VALUES ($1,$2,'ROU','Right of use','straight_line',60)`,
        [cls, CO],
      ),
    );
    // A 24-month office lease. The underlying building would last far longer; the RIGHT does not.
    const lease = await instrument({ kind: "lease", principal: 240_000_000, rate: 8, months: 24 });
    const asset = await fin(CO, async (c) =>
      (await c.query<{ a: string }>(`SELECT finance_lease_recognise($1,$2,$3) a`, [lease, cls, actor])).rows[0].a,
    );
    const row = await fin(CO, async (c) =>
      (
        await c.query<{ code: string; cost: string; book_life_months: number }>(
          `SELECT code, cost, book_life_months FROM finance_assets WHERE id=$1`,
          [asset],
        )
      ).rows[0],
    );
    expect(row.code).toMatch(/^ROU-/);
    expect(Number(row.cost)).toBe(240_000_000);
    // 24, the lease term — NOT the class default of 60.
    expect(row.book_life_months).toBe(24);

    await expect(
      fin(CO, (c) => c.query(`SELECT finance_lease_recognise($1,$2,$3)`, [lease, cls, actor])),
    ).rejects.toThrow(/FINANCE_LEASE_ALREADY_RECOGNISED/);
  });

  it("★ F11-13: an unaccrued instalment BLOCKS the close", async () => {
    const period = await fin(CO, async (c) =>
      (
        await c.query<{ id: string }>(
          `SELECT id FROM finance_fiscal_periods WHERE tenant_id=$1 ORDER BY start_date OFFSET 5 LIMIT 1`,
          [CO],
        )
      ).rows[0].id,
    );
    const blockers = await fin(CO, async (c) =>
      (
        await c.query<{ blocker: string }>(`SELECT * FROM finance_treasury_close_blockers($1,$2)`, [CO, period])
      ).rows,
    );
    // Several instruments above have June instalments that were never accrued.
    expect(blockers.some((b) => b.blocker === "INTEREST_NOT_ACCRUED")).toBe(true);
  });

  it("an intercompany loan carries its counterparty, so consolidation can see it", async () => {
    const other = await createCompany("Lender PT");
    const id = newId();
    await fin(CO, (c) =>
      c.query(
        `INSERT INTO finance_instruments
           (id,tenant_id,code,name,kind,principal,nominal_rate,start_date,maturity_date,counterparty_company_id)
         VALUES ($1,$2,'IC-LOAN','shareholder loan','loan_payable',50000000,0,'2026-01-01','2027-01-01',$3)`,
        [id, CO, other],
      ),
    );
    const row = await fin(CO, async (c) =>
      (
        await c.query<{ counterparty_company_id: string }>(
          `SELECT counterparty_company_id FROM finance_instruments WHERE id=$1`,
          [id],
        )
      ).rows[0],
    );
    expect(row.counterparty_company_id).toBe(other);
    // And a company cannot lend to itself.
    await expect(
      fin(CO, (c) =>
        c.query(
          `INSERT INTO finance_instruments
             (tenant_id,code,name,kind,principal,nominal_rate,start_date,maturity_date,counterparty_company_id)
           VALUES ($1,'SELF','self','loan_payable',1000,0,'2026-01-01','2027-01-01',$1)`,
          [CO],
        ),
      ),
    ).rejects.toThrow(/ck_finance_instruments_not_self/);
  });
});
