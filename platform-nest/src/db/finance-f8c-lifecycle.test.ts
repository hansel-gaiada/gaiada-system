// Finance F8c — DISPOSAL, IMPAIRMENT, DEFERRED TAX, CLOSE INTERLOCK. Migration 202608251230.
//
// The deferred-tax assertions are the reason the owner chose book+tax depreciation, so they are
// the ones worth reading. Two things they pin that are easy to get wrong and hard to notice:
//
//   * The posting ADJUSTS TO A TARGET rather than posting the computed figure. Posting the figure
//     every period accumulates it, and by year three the balance sheet carries three times the
//     real liability — while every individual entry looks correct.
//   * Book value comes from what was POSTED; tax value comes from the SCHEDULE. Using the schedule
//     for both would report depreciation that was never charged to the GL.
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

describe.skipIf(!TEST_URL)("Finance F8c — lifecycle + deferred tax (202608251230)", () => {
  let CO: string;
  let classId: string;
  let periods: Array<{ id: string; name: string; end_date: Date }> = [];
  let seq = 0;

  beforeAll(async () => {
    await initTestDb();
    CO = await createCompany("F8c Co");
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
        await c.query<{ id: string; name: string; end_date: Date }>(
          `SELECT id,name,end_date FROM finance_fiscal_periods WHERE fiscal_year_id=$1 ORDER BY start_date`,
          [fy.rows[0].id],
        )
      ).rows;
      classId = newId();
      // Book 12 months vs tax gol_1 48 months — a deliberately large temporary difference.
      await c.query(
        `INSERT INTO finance_asset_classes
           (id,tenant_id,code,name,book_method,book_life_months,tax_golongan,tax_method)
         VALUES ($1,$2,'EQP','Equipment','straight_line',12,'gol_1','garis_lurus')`,
        [classId, CO],
      );
    });
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  async function asset(cost: number, capitalise = true): Promise<string> {
    const id = newId();
    await withFinance([CO], async (c) => {
      await c.query(
        `INSERT INTO finance_assets
           (id,tenant_id,class_id,code,name,acquisition_date,in_service_date,cost,status)
         VALUES ($1,$2,$3,$4,'a','2026-01-05','2026-01-10',$5,'active')`,
        [id, CO, classId, `A${++seq}`, cost],
      );
      if (capitalise) await c.query(`SELECT finance_capitalise_asset($1,'1120')`, [id]);
    });
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

  it("book value comes from what was POSTED, tax value from the SCHEDULE", async () => {
    const id = await asset(12_000_000);
    // No run yet: book accumulated is ZERO even though the schedule has a January charge.
    let v = await withFinance([CO], async (c) =>
      (await c.query(`SELECT * FROM finance_asset_book_values($1,'2026-01-31')`, [id])).rows[0],
    );
    expect(Number(v.book_accum)).toBe(0);
    expect(Number(v.book_nbv)).toBe(12_000_000);
    // Tax is scheduled, never posted, so it accrues regardless: 12,000,000*25%/12 = 250,000.
    expect(Number(v.tax_accum)).toBe(250_000);

    await withFinance([CO], (c) => c.query(`SELECT finance_run_depreciation($1,$2)`, [CO, periods[0].id]));
    v = await withFinance([CO], async (c) =>
      (await c.query(`SELECT * FROM finance_asset_book_values($1,'2026-01-31')`, [id])).rows[0],
    );
    expect(Number(v.book_accum)).toBe(1_000_000); // 12,000,000/12
    expect(Number(v.book_nbv)).toBe(11_000_000);
  });

  it("★ deferred tax: book NBV BELOW tax NBV is an ASSET, and the sign is not cosmetic", async () => {
    // Book depreciates FASTER than tax here: a 12-month book life charges 1,000,000/mo, while
    // gol_1 over 48 months charges only 250,000/mo. So book NBV falls faster and ends up BELOW tax
    // NBV — 11,000,000 against 11,750,000 after January. A negative temporary difference, which is
    // a deferred tax ASSET: the tax authority still has deductions left that the books have already
    // taken, so less tax will be paid later.
    //
    // Inverting this sign is the classic PSAK 46 error: it moves a real asset onto the liability
    // side of the balance sheet, which still balances and still looks plausible.
    const pos = await withFinance([CO], async (c) =>
      (await c.query(`SELECT * FROM finance_deferred_tax_position($1,'2026-01-31',22)`, [CO])).rows[0],
    );
    expect(Number(pos.book_nbv)).toBe(11_000_000);
    expect(Number(pos.tax_nbv)).toBe(11_750_000);
    expect(Number(pos.temporary_difference)).toBe(-750_000);
    expect(Number(pos.deferred_tax)).toBe(-165_000); // -750,000 * 22%
  });

  it("★ the deferred-tax posting ADJUSTS TO A TARGET, it does not accumulate", async () => {
    // Post for January.
    await withFinance([CO], (c) => c.query(`SELECT finance_post_deferred_tax($1,$2,22)`, [CO, periods[0].id]));
    const afterJan = await balance("2250");
    expect(afterJan).toBe(-165_000); // a debit balance on a credit-normal account = deferred tax ASSET

    // Run February, then post again. If the implementation posted the computed figure rather than
    // the delta, this balance would be roughly the sum of two periods instead of February's target.
    await withFinance([CO], (c) => c.query(`SELECT finance_run_depreciation($1,$2)`, [CO, periods[1].id]));
    const target = await withFinance([CO], async (c) =>
      Number(
        (await c.query(`SELECT deferred_tax d FROM finance_deferred_tax_position($1,'2026-02-28',22)`, [CO])).rows[0].d,
      ),
    );
    await withFinance([CO], (c) => c.query(`SELECT finance_post_deferred_tax($1,$2,22)`, [CO, periods[1].id]));
    const afterFeb = await balance("2250");
    // The BALANCE equals the target, not the sum of two postings.
    expect(afterFeb).toBe(target);
    expect(afterFeb).not.toBe(afterJan + target);
  });

  it("posting deferred tax again with nothing changed is a no-op", async () => {
    const before = await balance("2250");
    const r = await withFinance([CO], async (c) =>
      (await c.query(`SELECT finance_post_deferred_tax($1,$2,22) e`, [CO, periods[1].id])).rows[0].e,
    );
    expect(r).toBeNull(); // no journal, because the delta is zero
    expect(await balance("2250")).toBe(before);
  });

  it("★ disposal derecognises BOTH cost and accumulated depreciation", async () => {
    const id = await asset(6_000_000);
    await withFinance([CO], (c) => c.query(`SELECT finance_run_depreciation($1,$2)`, [CO, periods[2].id]));
    const v = await withFinance([CO], async (c) =>
      (await c.query(`SELECT * FROM finance_asset_book_values($1,'2026-03-31')`, [id])).rows[0],
    );
    const cost1210 = await balance("1210");
    const accum1220 = await balance("1220");

    await withFinance([CO], (c) =>
      c.query(`SELECT finance_dispose_asset($1,$2,'1120','2026-03-31')`, [id, Number(v.book_nbv)]),
    );

    // Cost out of 1210 AND accumulated depreciation out of 1220. Leaving 1220 alone is the classic
    // bug: the balance sheet eventually shows negative net fixed assets.
    expect(await balance("1210")).toBe(cost1210 - Number(v.cost));
    expect(await balance("1220")).toBe(accum1220 - Number(v.book_accum));
    // Sold at exactly NBV -> no gain, no loss.
    expect(await balance("7400")).toBe(0);
  });

  it("a disposal above net book value books a GAIN; below books a LOSS", async () => {
    const gainAsset = await asset(3_000_000);
    await withFinance([CO], (c) =>
      c.query(`SELECT finance_dispose_asset($1,$2,'1120','2026-03-31')`, [gainAsset, 3_500_000]),
    );
    expect(await balance("7400")).toBe(500_000); // credit-normal: positive = gain

    const lossAsset = await asset(3_000_000);
    await withFinance([CO], (c) =>
      c.query(`SELECT finance_dispose_asset($1,$2,'1120','2026-03-31')`, [lossAsset, 1_000_000]),
    );
    expect(await balance("7400")).toBe(500_000 - 2_000_000); // net: gain 500k less loss 2m
  });

  it("disposing twice, or disposing something never capitalised, is refused", async () => {
    const id = await asset(1_000_000);
    await withFinance([CO], (c) => c.query(`SELECT finance_dispose_asset($1,0,'1120','2026-03-31')`, [id]));
    await expect(
      withFinance([CO], (c) => c.query(`SELECT finance_dispose_asset($1,0,'1120','2026-03-31')`, [id])),
    ).rejects.toThrow(/FINANCE_ASSET_ALREADY_DISPOSED/);

    const uncap = await asset(1_000_000, false);
    await expect(
      withFinance([CO], (c) => c.query(`SELECT finance_dispose_asset($1,0,'1120','2026-03-31')`, [uncap])),
    ).rejects.toThrow(/FINANCE_ASSET_NOT_CAPITALISED/);
  });

  it("impairment writes down against accumulated depreciation, and cannot exceed carrying amount", async () => {
    const id = await asset(4_000_000);
    const before = await balance("1220");
    await withFinance([CO], (c) => c.query(`SELECT finance_impair_asset($1,1_000_000::numeric,'2026-03-31')`, [id]));
    expect(await balance("1220")).toBe(before + 1_000_000);
    expect(await balance("6750")).toBe(1_000_000);
    // Cost is untouched — the register still shows what was paid, which is what an auditor asks for.
    const v = await withFinance([CO], async (c) =>
      (await c.query(`SELECT * FROM finance_asset_book_values($1,'2026-03-31')`, [id])).rows[0],
    );
    expect(Number(v.cost)).toBe(4_000_000);

    await expect(
      withFinance([CO], (c) => c.query(`SELECT finance_impair_asset($1,99_000_000::numeric,'2026-03-31')`, [id])),
    ).rejects.toThrow(/FINANCE_IMPAIRMENT_EXCEEDS_CARRYING/);
  });

  it("★ an unrun depreciation period BLOCKS the close", async () => {
    // A period closed without depreciation overstates profit, and closing is terminal.
    const blockers = await withFinance([CO], async (c) =>
      (
        await c.query<{ blocker: string; detail: string }>(`SELECT * FROM finance_fa_close_blockers($1,$2)`, [
          CO,
          periods[4].id, // May: never run
        ])
      ).rows,
    );
    expect(blockers.some((b) => b.blocker === "DEPRECIATION_NOT_RUN")).toBe(true);
  });

  it("a period WITH a run is not blocked by that rule", async () => {
    const blockers = await withFinance([CO], async (c) =>
      (
        await c.query<{ blocker: string }>(`SELECT * FROM finance_fa_close_blockers($1,$2)`, [CO, periods[0].id])
      ).rows,
    );
    expect(blockers.some((b) => b.blocker === "DEPRECIATION_NOT_RUN")).toBe(false);
  });
});
