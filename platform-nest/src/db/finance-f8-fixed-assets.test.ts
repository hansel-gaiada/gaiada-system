// Finance F8 — FIXED ASSETS AND DEPRECIATION. Covers migration 202608251030.
//
// Owner ruling 2026-08-25: book AND tax depreciation, with deferred tax. So the central assertions
// here are not "a schedule is produced" but:
//
//   1. **Each side sums to its own base, exactly.** Book sums to (cost - residual); tax sums to
//      full cost, because Indonesian tax recognises no residual. Rounding must be absorbed, not
//      left as a few rupiah of book value that never reconciles against the GL.
//   2. **Declining balance terminates.** Saldo menurun approaches zero asymptotically. An engine
//      that just applies the rate forever leaves an asset depreciating past its life, and the
//      error is small enough per period that nobody notices for years.
//   3. **The two sides legitimately disagree**, and the difference is the deferred-tax input.
//
// The suite is deliberately arithmetic-heavy. A depreciation engine that produces plausible
// numbers is the failure mode — every figure here is checked against a value computed by hand from
// the statute, not against whatever the function happened to return.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, newId } from "./index";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import type { PoolClient } from "pg";

async function withFinance<T>(tenantIds: string[], fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants(tenantIds, async (c) => {
    await c.query("SELECT set_config('app.scopes', 'finance', true)");
    return fn(c);
  });
}

interface Row {
  seq: number;
  // pg maps a `date` column to a JS Date, not a string.
  period_start: Date;
  book_charge: string;
  book_accum: string;
  book_nbv: string;
  tax_charge: string;
  tax_accum: string;
  tax_nbv: string;
}

describe.skipIf(!TEST_URL)("Finance F8 — fixed assets (202608251030)", () => {
  let CO: string;
  let seq = 0;

  beforeAll(async () => {
    await initTestDb();
    CO = await createCompany("F8 Co");
    await withFinance([CO], async (c) => {
      await c.query(
        `INSERT INTO finance_company_settings (tenant_id, functional_currency, presentation_currency, fiscal_year_start_month)
         VALUES ($1,'IDR','IDR',1) ON CONFLICT (tenant_id) DO NOTHING`,
        [CO],
      );
      await c.query(`SELECT finance_instantiate_coa($1, 'id_psak_general_v1')`, [CO]);
    });
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  /** Create a class + asset and return the generated schedule. */
  async function schedule(opts: {
    cost: number;
    residual?: number;
    bookMethod?: string;
    bookLife?: number | null;
    golongan?: string | null;
    taxMethod?: string | null;
    inService?: string | null;
    status?: string;
  }): Promise<Row[]> {
    const classId = newId();
    const assetId = newId();
    // A plain counter, NOT a slice of the uuid: newId() is uuid v7, whose leading hex digits are a
    // MILLISECOND TIMESTAMP — two assets built in the same millisecond derive the same code and
    // collide on ux_finance_asset_classes_code.
    const code = `A${++seq}`;
    return withFinance([CO], async (c) => {
      await c.query(
        `INSERT INTO finance_asset_classes
           (id, tenant_id, code, name, book_method, book_life_months, tax_golongan, tax_method)
         VALUES ($1,$2,$3,'cls',$4,$5,$6,$7)`,
        [classId, CO, code, opts.bookMethod ?? "straight_line", opts.bookLife ?? null, opts.golongan ?? null, opts.taxMethod ?? null],
      );
      await c.query(
        `INSERT INTO finance_assets
           (id, tenant_id, class_id, code, name, acquisition_date, in_service_date, cost, residual_amount, status)
         VALUES ($1,$2,$3,$4,'asset','2026-01-15',$5,$6,$7,$8)`,
        [
          assetId, CO, classId, code,
          opts.inService === undefined ? "2026-02-01" : opts.inService,
          opts.cost, opts.residual ?? 0,
          opts.status ?? (opts.inService === null ? "cip" : "active"),
        ],
      );
      return (await c.query<Row>(`SELECT * FROM finance_asset_depreciation_schedule($1) ORDER BY seq`, [assetId])).rows;
    });
  }

  const sum = (rows: Row[], k: "book_charge" | "tax_charge") =>
    Number(rows.reduce((a, r) => a + Number(r[k]), 0).toFixed(2));

  // ── The statute itself ─────────────────────────────────────────────────────────────────────────
  it("golongan parameters match UU PPh Ps. 11", async () => {
    const rows = await withFinance([CO], async (c) =>
      (
        await c.query<{ g: string; life_months: number; rate_garis_lurus: string; rate_saldo_menurun: string | null }>(
          `SELECT g.golongan AS g, p.* FROM (VALUES ('gol_1'),('gol_2'),('gol_3'),('gol_4'),
             ('bangunan_permanen'),('bangunan_non_permanen')) AS g(golongan)
             CROSS JOIN LATERAL finance_tax_golongan_params(g.golongan) p`,
        )
      ).rows,
    );
    const by = Object.fromEntries(rows.map((r) => [r.g, r]));
    expect(by["gol_1"].life_months).toBe(48);
    expect(Number(by["gol_1"].rate_garis_lurus)).toBe(25);
    expect(Number(by["gol_1"].rate_saldo_menurun)).toBe(50);
    expect(by["gol_2"].life_months).toBe(96);
    expect(by["gol_3"].life_months).toBe(192);
    expect(by["gol_4"].life_months).toBe(240);
    expect(by["bangunan_permanen"].life_months).toBe(240);
    // ★ NULL, not 0. Saldo menurun is not permitted for buildings; a 0 would read as a correctly
    // depreciating asset charging nothing, which is the failure this NULL exists to prevent.
    expect(by["bangunan_permanen"].rate_saldo_menurun).toBeNull();
    expect(by["bangunan_non_permanen"].rate_saldo_menurun).toBeNull();
  });

  // ── Book: straight line ────────────────────────────────────────────────────────────────────────
  it("straight-line book depreciation sums EXACTLY to cost less residual", async () => {
    // 10,000,000 over 36 months with 1,000,000 residual. 9,000,000/36 = 250,000 exactly.
    const rows = await schedule({ cost: 10_000_000, residual: 1_000_000, bookLife: 36 });
    expect(rows).toHaveLength(36);
    expect(Number(rows[0].book_charge)).toBe(250_000);
    expect(sum(rows, "book_charge")).toBe(9_000_000);
    // Never below residual.
    expect(Number(rows[35].book_nbv)).toBe(1_000_000);
  });

  it("the FINAL period absorbs rounding — an indivisible cost still sums exactly", async () => {
    // 10,000,000 / 3 months = 3,333,333.33 which sums to 9,999,999.99, not 10,000,000.
    // Charging the rounded figure every month strands 0.01 forever and it never reconciles.
    const rows = await schedule({ cost: 10_000_000, bookLife: 3 });
    expect(Number(rows[0].book_charge)).toBe(3_333_333.33);
    expect(Number(rows[1].book_charge)).toBe(3_333_333.33);
    expect(Number(rows[2].book_charge)).toBe(3_333_333.34); // the remainder, not the monthly figure
    expect(sum(rows, "book_charge")).toBe(10_000_000);
    expect(Number(rows[2].book_nbv)).toBe(0);
  });

  it("declining balance TERMINATES rather than approaching zero forever", async () => {
    const rows = await schedule({ cost: 10_000_000, bookMethod: "declining_balance", bookLife: 24 });
    expect(rows).toHaveLength(24);
    expect(sum(rows, "book_charge")).toBe(10_000_000);
    expect(Number(rows[23].book_nbv)).toBe(0);
    // Front-loaded: the first charge must exceed the straight-line equivalent, else it is not
    // actually declining balance.
    expect(Number(rows[0].book_charge)).toBeGreaterThan(10_000_000 / 24);
  });

  // ── Tax ────────────────────────────────────────────────────────────────────────────────────────
  it("tax garis lurus on gol_1 runs 48 months at 25%/yr and sums to FULL cost (no residual)", async () => {
    const rows = await schedule({
      cost: 48_000_000, residual: 8_000_000, bookLife: 48,
      golongan: "gol_1", taxMethod: "garis_lurus",
    });
    expect(rows).toHaveLength(48);
    // 48,000,000 * 25% / 12 = 1,000,000 per month.
    expect(Number(rows[0].tax_charge)).toBe(1_000_000);
    // ★ Tax recognises NO residual: the base is full cost even though book keeps 8m back.
    expect(sum(rows, "tax_charge")).toBe(48_000_000);
    expect(sum(rows, "book_charge")).toBe(40_000_000);
    expect(Number(rows[47].tax_nbv)).toBe(0);
  });

  it("tax saldo menurun terminates in the final period and sums to full cost", async () => {
    const rows = await schedule({ cost: 20_000_000, bookLife: 48, golongan: "gol_1", taxMethod: "saldo_menurun" });
    expect(sum(rows, "tax_charge")).toBe(20_000_000);
    expect(Number(rows[47].tax_nbv)).toBe(0);
    expect(Number(rows[0].tax_charge)).toBeGreaterThan(Number(rows[24].tax_charge)); // front-loaded
  });

  it("★ book and tax legitimately DISAGREE — that difference is the deferred-tax input", async () => {
    // A laptop: book life 3 years (management estimate), tax gol_1 = 4 years (statute).
    const rows = await schedule({ cost: 12_000_000, bookLife: 36, golongan: "gol_1", taxMethod: "garis_lurus" });
    // Schedule runs the LONGER of the two lives so neither side is truncated by the other.
    expect(rows).toHaveLength(48);
    // At month 36 book is finished; tax is not.
    expect(Number(rows[35].book_nbv)).toBe(0);
    expect(Number(rows[35].tax_nbv)).toBeGreaterThan(0);
    expect(Number(rows[36].book_charge)).toBe(0);
    expect(Number(rows[36].tax_charge)).toBeGreaterThan(0);
    // Both arrive at the same place, by different routes.
    expect(sum(rows, "book_charge")).toBe(12_000_000);
    expect(sum(rows, "tax_charge")).toBe(12_000_000);
  });

  // ── In-service, CIP, and the things that must NOT depreciate ───────────────────────────────────
  it("depreciation starts at the IN-SERVICE month, not acquisition", async () => {
    const rows = await schedule({ cost: 1_200_000, bookLife: 12, inService: "2026-06-20" });
    // Acquired 15 Jan, commissioned 20 Jun -> first charge is the June period.
    const d = rows[0].period_start;
    expect([d.getFullYear(), d.getMonth() + 1]).toEqual([2026, 6]);
  });

  it("a CIP asset (not in service) yields an EMPTY schedule, not a row of zeros", async () => {
    // Zeros would tie in a reconciliation and hide that the asset was never commissioned.
    const rows = await schedule({ cost: 5_000_000, bookLife: 12, inService: null });
    expect(rows).toHaveLength(0);
  });

  it("non_depreciable (land) charges no tax depreciation", async () => {
    const rows = await schedule({ cost: 900_000_000, bookMethod: "none", bookLife: null, golongan: "non_depreciable" });
    expect(sum(rows, "tax_charge")).toBe(0);
    expect(sum(rows, "book_charge")).toBe(0);
  });

  // ── Constraints that stop wrong data existing at all ───────────────────────────────────────────
  it("a BUILDING on saldo menurun is refused by the database", async () => {
    // Statutory: buildings must use garis lurus. A building on declining balance produces a wrong
    // tax return, and nothing downstream would catch it — so it is a CHECK, not a UI rule.
    await expect(
      withFinance([CO], (c) =>
        c.query(
          `INSERT INTO finance_asset_classes (id, tenant_id, code, name, book_life_months, tax_golongan, tax_method)
           VALUES ($1,$2,'BLD-BAD','bad',240,'bangunan_permanen','saldo_menurun')`,
          [newId(), CO],
        ),
      ),
    ).rejects.toThrow(/ck_asset_class_building_method/);
  });

  it("residual exceeding cost is refused", async () => {
    // Otherwise the depreciable base is negative and the schedule CREDITS depreciation — it
    // silently runs backwards.
    const classId = newId();
    await withFinance([CO], (c) =>
      c.query(
        `INSERT INTO finance_asset_classes (id, tenant_id, code, name, book_life_months) VALUES ($1,$2,'RES','r',12)`,
        [classId, CO],
      ),
    );
    await expect(
      withFinance([CO], (c) =>
        c.query(
          `INSERT INTO finance_assets (id,tenant_id,class_id,code,name,acquisition_date,in_service_date,cost,residual_amount)
           VALUES ($1,$2,$3,'RES-1','x','2026-01-01','2026-01-01',100,500)`,
          [newId(), CO, classId],
        ),
      ),
    ).rejects.toThrow(/ck_finance_assets_residual/);
  });

  it("one depreciation run per period is enforced by the DATABASE, not by code", async () => {
    // F8-06. A unique index is the only version of idempotency that survives a retried job or two
    // operators clicking at once.
    const periodId = await withFinance([CO], async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO finance_fiscal_years (tenant_id, code, start_date, end_date)
           VALUES ($1,'FY2026-F8','2026-01-01','2027-01-01') RETURNING id`,
          [CO],
        )
      ).rows[0].id,
    );
    const runOne = () =>
      withFinance([CO], (c) =>
        c.query(`INSERT INTO finance_depreciation_runs (id, tenant_id, period_id) VALUES ($1,$2,$3)`, [
          newId(), CO, periodId,
        ]),
      );
    await runOne();
    await expect(runOne()).rejects.toThrow(/ux_finance_dep_runs_period/);
  });

  it("the fixed-asset control accounts exist and accumulated depreciation is CONTRA", async () => {
    const rows = await withFinance([CO], async (c) =>
      (
        await c.query<{ code: string; normal_balance: string; is_control: boolean; control_subledger: string | null }>(
          `SELECT code, normal_balance, is_control, control_subledger FROM finance_accounts
            WHERE tenant_id=$1 AND code IN ('1210','1220','6700') ORDER BY code`,
          [CO],
        )
      ).rows,
    );
    const by = Object.fromEntries(rows.map((r) => [r.code, r]));
    expect(by["1210"].is_control).toBe(true);
    expect(by["1210"].control_subledger).toBe("fixed_assets");
    // ★ An ASSET with a CREDIT normal balance. Every sign in the engine reads this, never a
    // hardcoded list of "contra" account codes.
    expect(by["1220"].normal_balance).toBe("credit");
    expect(by["1220"].control_subledger).toBe("fixed_assets");
    expect(by["6700"].normal_balance).toBe("debit");
  });
});
