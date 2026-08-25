// Finance F8d — THE MOVEMENT SCHEDULE. Migration 202608251330.
//
// The assertions that matter are the two a naive implementation gets wrong:
//
//   * An asset bought AND sold inside the window must appear in additions and in disposals, and
//     contribute nothing to opening or closing. "Closing = opening + additions - disposals" is
//     only a real check if the row was built independently, not derived from it.
//   * Accumulated depreciation leaving with a disposed asset is EVERYTHING charged to it, not just
//     the charge inside the window.
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

interface Move {
  class_code: string;
  opening_cost: string;
  additions: string;
  disposals_cost: string;
  closing_cost: string;
  opening_accum: string;
  charge: string;
  disposals_accum: string;
  closing_accum: string;
  closing_nbv: string;
}

describe.skipIf(!TEST_URL)("Finance F8d — movement schedule (202608251330)", () => {
  let CO: string;
  let classId: string;
  let periods: Array<{ id: string; end_date: Date }> = [];
  let seq = 0;

  beforeAll(async () => {
    await initTestDb();
    CO = await createCompany("F8d Co");
    await withFinance([CO], async (c) => {
      await c.query(
        `INSERT INTO finance_company_settings (tenant_id, functional_currency, presentation_currency, fiscal_year_start_month)
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
      periods = (
        await c.query<{ id: string; end_date: Date }>(
          `SELECT id,end_date FROM finance_fiscal_periods WHERE fiscal_year_id=$1 ORDER BY start_date`,
          [fy.rows[0].id],
        )
      ).rows;
      classId = newId();
      await c.query(
        `INSERT INTO finance_asset_classes (id,tenant_id,code,name,book_method,book_life_months,tax_golongan,tax_method)
         VALUES ($1,$2,'EQP','Equipment','straight_line',12,'gol_1','garis_lurus')`,
        [classId, CO],
      );
    });
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  async function asset(cost: number, acquired: string, inService: string): Promise<string> {
    const id = newId();
    await withFinance([CO], async (c) => {
      await c.query(
        `INSERT INTO finance_assets (id,tenant_id,class_id,code,name,acquisition_date,in_service_date,cost,status)
         VALUES ($1,$2,$3,$4,'a',$5,$6,$7,'active')`,
        [id, CO, classId, `M${++seq}`, acquired, inService, cost],
      );
      await c.query(`SELECT finance_capitalise_asset($1,'1120',$2)`, [id, acquired]);
    });
    return id;
  }

  const movement = (from: string, to: string) =>
    withFinance([CO], async (c) =>
      (await c.query<Move>(`SELECT * FROM finance_fa_movement($1,$2::date,$3::date)`, [CO, from, to])).rows,
    );

  it("additions inside the window appear as additions, not as opening", async () => {
    await asset(12_000_000, "2026-02-05", "2026-02-05");
    const [m] = await movement("2026-02-01", "2026-02-28");
    expect(Number(m.opening_cost)).toBe(0);
    expect(Number(m.additions)).toBe(12_000_000);
    expect(Number(m.closing_cost)).toBe(12_000_000);
  });

  it("an asset acquired BEFORE the window is opening, not an addition", async () => {
    const [m] = await movement("2026-03-01", "2026-03-31");
    expect(Number(m.opening_cost)).toBe(12_000_000);
    expect(Number(m.additions)).toBe(0);
    expect(Number(m.closing_cost)).toBe(12_000_000);
  });

  it("the schedule ARTICULATES: opening + additions - disposals = closing", async () => {
    await withFinance([CO], (c) => c.query(`SELECT finance_run_depreciation($1,$2)`, [CO, periods[1].id]));
    await asset(6_000_000, "2026-03-10", "2026-03-10");
    const [m] = await movement("2026-03-01", "2026-03-31");
    expect(Number(m.opening_cost) + Number(m.additions) - Number(m.disposals_cost)).toBe(Number(m.closing_cost));
    expect(Number(m.opening_accum) + Number(m.charge) - Number(m.disposals_accum)).toBe(Number(m.closing_accum));
    expect(Number(m.closing_cost) - Number(m.closing_accum)).toBe(Number(m.closing_nbv));
  });

  it("★ an asset bought AND sold inside the window shows in both, and in neither opening nor closing", async () => {
    const id = await asset(4_000_000, "2026-04-02", "2026-04-02");
    await withFinance([CO], (c) =>
      c.query(`SELECT finance_dispose_asset($1,4_000_000::numeric,'1120','2026-04-20')`, [id]),
    );
    const [m] = await movement("2026-04-01", "2026-04-30");
    expect(Number(m.additions)).toBe(4_000_000);
    expect(Number(m.disposals_cost)).toBe(4_000_000);
    // Contributes nothing to either end of the window.
    expect(Number(m.opening_cost)).toBe(18_000_000); // the two surviving assets
    expect(Number(m.closing_cost)).toBe(18_000_000);
    // And it still articulates.
    expect(Number(m.opening_cost) + Number(m.additions) - Number(m.disposals_cost)).toBe(Number(m.closing_cost));
  });

  it("★ accumulated depreciation leaving with a disposal is EVERYTHING charged to that asset", async () => {
    // Run March and April so the older asset has two periods of charge, then dispose it in May.
    await withFinance([CO], async (c) => {
      await c.query(`SELECT finance_run_depreciation($1,$2)`, [CO, periods[2].id]);
      await c.query(`SELECT finance_run_depreciation($1,$2)`, [CO, periods[3].id]);
    });
    const old = await withFinance([CO], async (c) =>
      (await c.query<{ id: string }>(`SELECT id FROM finance_assets WHERE code='M1'`)).rows[0].id,
    );
    const v = await withFinance([CO], async (c) =>
      (await c.query<{ book_accum: string }>(`SELECT * FROM finance_asset_book_values($1,'2026-05-31')`, [old])).rows[0],
    );
    // More than one period's worth — so a window-only implementation would understate it.
    expect(Number(v.book_accum)).toBeGreaterThan(1_000_000);

    await withFinance([CO], (c) => c.query(`SELECT finance_dispose_asset($1,0::numeric,'1120','2026-05-15')`, [old]));
    const [m] = await movement("2026-05-01", "2026-05-31");
    expect(Number(m.disposals_accum)).toBe(Number(v.book_accum));
    expect(Number(m.opening_accum) + Number(m.charge) - Number(m.disposals_accum)).toBe(Number(m.closing_accum));
  });

  it("a class with no assets reports zeros rather than vanishing", async () => {
    // A missing row reads as "this class does not exist"; a zero row reads as "nothing moved".
    // The note must show every class, because absence is itself information to an auditor.
    await withFinance([CO], (c) =>
      c.query(
        `INSERT INTO finance_asset_classes (id,tenant_id,code,name,book_method,book_life_months)
         VALUES ($1,$2,'VEH','Vehicles','straight_line',48)`,
        [newId(), CO],
      ),
    );
    const rows = await movement("2026-05-01", "2026-05-31");
    const veh = rows.find((r) => r.class_code === "VEH");
    expect(veh).toBeDefined();
    expect(Number(veh!.closing_cost)).toBe(0);
    expect(Number(veh!.closing_nbv)).toBe(0);
  });
});
