// Finance F8b — CAPITALISATION, THE DEPRECIATION RUN, AND THE TIE-OUT. Migration 202608251130.
//
// F8's first suite proved the ARITHMETIC. This one proves the module is a SUBLEDGER rather than a
// spreadsheet: that cost reaches the GL, that depreciation posts, and that the two agree.
//
// The assertion that matters most is the negative one — `finance_fa_reconcile()` must report a
// problem when the register and the ledger disagree. A tie-out that cannot go red is not a
// tie-out, and it is the easiest thing in this file to write wrongly and never notice.
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

describe.skipIf(!TEST_URL)("Finance F8b — capitalisation + depreciation run (202608251130)", () => {
  let CO: string;
  let classId: string;
  let periods: Array<{ id: string; name: string; start_date: Date }> = [];
  let seq = 0;

  beforeAll(async () => {
    await initTestDb();
    CO = await createCompany("F8b Co");
    await withFinance([CO], async (c) => {
      await c.query(
        `INSERT INTO finance_company_settings (tenant_id, functional_currency, presentation_currency, fiscal_year_start_month)
         VALUES ($1,'IDR','IDR',1) ON CONFLICT (tenant_id) DO NOTHING`,
        [CO],
      );
      await c.query(`SELECT finance_instantiate_coa($1, 'id_psak_general_v1')`, [CO]);
      const fy = await c.query<{ id: string }>(
        `INSERT INTO finance_fiscal_years (tenant_id, code, start_date, end_date)
         VALUES ($1,'FY2026','2026-01-01','2027-01-01') RETURNING id`,
        [CO],
      );
      await c.query(`SELECT finance_generate_periods($1,'monthly')`, [fy.rows[0].id]);
      periods = (
        await c.query<{ id: string; name: string; start_date: Date }>(
          `SELECT id, name, start_date FROM finance_fiscal_periods WHERE fiscal_year_id=$1 ORDER BY start_date`,
          [fy.rows[0].id],
        )
      ).rows;

      classId = newId();
      await c.query(
        `INSERT INTO finance_asset_classes
           (id, tenant_id, code, name, book_method, book_life_months, tax_golongan, tax_method)
         VALUES ($1,$2,'EQP','Equipment','straight_line',12,'gol_1','garis_lurus')`,
        [classId, CO],
      );
    });
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  async function newAsset(cost: number, inService = "2026-01-10"): Promise<string> {
    const id = newId();
    await withFinance([CO], (c) =>
      c.query(
        `INSERT INTO finance_assets
           (id,tenant_id,class_id,code,name,acquisition_date,in_service_date,cost,status)
         VALUES ($1,$2,$3,$4,'asset','2026-01-05',$5,$6,'active')`,
        [id, CO, classId, `E${++seq}`, inService, cost],
      ),
    );
    return id;
  }

  const balance = (code: string) =>
    withFinance([CO], async (c) =>
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

  const reconcile = () =>
    withFinance([CO], async (c) =>
      (await c.query<{ problem: string; detail: string }>(`SELECT * FROM finance_fa_reconcile($1)`, [CO])).rows,
    );

  it("an uncapitalised asset is NAMED, not netted into a total", async () => {
    // A difference tells you the books are wrong. A named asset tells you which one.
    const id = await newAsset(12_000_000);
    const problems = await reconcile();
    expect(problems.some((p) => p.problem === "UNCAPITALISED_ASSET")).toBe(true);
    expect(problems.find((p) => p.problem === "UNCAPITALISED_ASSET")!.detail).toMatch(/E1/);
    // Clean up so later assertions start from a tying position.
    await withFinance([CO], (c) => c.query(`SELECT finance_capitalise_asset($1,'1120')`, [id]));
    expect(await reconcile()).toEqual([]);
  });

  it("capitalisation puts cost into 1210 against the funding account, and the register ties", async () => {
    expect(await balance("1210")).toBe(12_000_000);
    expect(await balance("1120")).toBe(-12_000_000); // credited from bank
    expect(await reconcile()).toEqual([]);
  });

  it("capitalising twice is REFUSED rather than silently doubling cost", async () => {
    const id = await newAsset(1_000_000);
    await withFinance([CO], (c) => c.query(`SELECT finance_capitalise_asset($1,'1120')`, [id]));
    await expect(
      withFinance([CO], (c) => c.query(`SELECT finance_capitalise_asset($1,'1120')`, [id])),
    ).rejects.toThrow(/FINANCE_ASSET_ALREADY_CAPITALISED/);
  });

  it("★ the run posts BOOK depreciation and the subledger still ties", async () => {
    // Two assets in service from January: 12,000,000 and 1,000,000 over 12 months.
    // Monthly book charge = 1,000,000 + 83,333.33 = 1,083,333.33.
    const runId = await withFinance([CO], async (c) =>
      (await c.query<{ r: string }>(`SELECT finance_run_depreciation($1,$2) r`, [CO, periods[0].id])).rows[0].r,
    );
    const run = await withFinance([CO], async (c) =>
      (
        await c.query<{ book_total: string; tax_total: string; asset_count: number; journal_id: string }>(
          `SELECT book_total, tax_total, asset_count, journal_id FROM finance_depreciation_runs WHERE id=$1`,
          [runId],
        )
      ).rows[0],
    );
    expect(run.asset_count).toBe(2);
    expect(Number(run.book_total)).toBe(1_083_333.33);
    expect(run.journal_id).toBeTruthy();

    expect(await balance("6700")).toBe(1_083_333.33); // expense
    expect(await balance("1220")).toBe(1_083_333.33); // accumulated depreciation, credit-normal
    expect(await reconcile()).toEqual([]);
  });

  it("★ TAX depreciation is recorded on the line but NEVER posted to the GL", async () => {
    // The whole point of the two-schedule design. Tax belongs on a computation, not in the
    // financial statements — posting it would make the balance sheet meaningless under PSAK.
    const line = await withFinance([CO], async (c) =>
      (
        await c.query<{ book_charge: string; tax_charge: string }>(
          `SELECT book_charge, tax_charge FROM finance_depreciation_lines dl
             JOIN finance_assets a ON a.id=dl.asset_id WHERE a.code='E1'`,
        )
      ).rows[0],
    );
    // Book: 12,000,000/12 = 1,000,000. Tax gol_1 garis lurus: 12,000,000 * 25% / 12 = 250,000.
    expect(Number(line.book_charge)).toBe(1_000_000);
    expect(Number(line.tax_charge)).toBe(250_000);
    // They differ — and only the book figure reached the ledger.
    expect(await balance("1220")).toBe(1_083_333.33);
    // No tax figure anywhere in the GL.
    expect(await balance("1220")).not.toBe(Number(line.tax_charge));
  });

  it("re-running the same period is refused by the DATABASE, and posts nothing twice", async () => {
    const before = await balance("1220");
    await expect(
      withFinance([CO], (c) => c.query(`SELECT finance_run_depreciation($1,$2)`, [CO, periods[0].id])),
    ).rejects.toThrow(/ux_finance_dep_runs_period/);
    expect(await balance("1220")).toBe(before);
    expect(await reconcile()).toEqual([]);
  });

  it("a run against a non-OPEN period is refused", async () => {
    await withFinance([CO], (c) =>
      c.query(`UPDATE finance_fiscal_periods SET state='SOFT_LOCK' WHERE id=$1`, [periods[1].id]),
    );
    await expect(
      withFinance([CO], (c) => c.query(`SELECT finance_run_depreciation($1,$2)`, [CO, periods[1].id])),
    ).rejects.toThrow(/FINANCE_PERIOD_NOT_OPEN/);
    await withFinance([CO], (c) =>
      c.query(`UPDATE finance_fiscal_periods SET state='OPEN' WHERE id=$1`, [periods[1].id]),
    );
  });

  it("★ the tie-out CAN go red — a reconciliation that cannot fail is not a reconciliation", async () => {
    // Post a manual journal straight at the accumulated-depreciation account, simulating drift.
    // If this does not turn finance_fa_reconcile() red, the check is decorative.
    await withFinance([CO], (c) =>
      c.query(
        `SELECT finance_post_journal($1,'2026-02-28','test-drift','drift',
           $2::jsonb, NULL,'standard',NULL,NULL,NULL,NULL,'fixed_assets')`,
        [
          CO,
          JSON.stringify([
            { account_code: "6700", side: "debit", amount: 5000, memo: "drift" },
            { account_code: "1220", side: "credit", amount: 5000, memo: "drift" },
          ]),
        ],
      ),
    );
    const problems = await reconcile();
    expect(problems.some((p) => p.problem === "ACCUM_DEPRECIATION_MISMATCH")).toBe(true);
    expect(problems.find((p) => p.problem === "ACCUM_DEPRECIATION_MISMATCH")!.detail).toMatch(/5000/);
  });

  it("reconcile REPORTS and never repairs — the difference survives a second call", async () => {
    // A fixer would make the second call clean. Nothing here repairs, because a repaired
    // difference is a difference nobody investigated.
    const first = await reconcile();
    const second = await reconcile();
    expect(second).toEqual(first);
    expect(second.length).toBeGreaterThan(0);
  });
});
