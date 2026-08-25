// Finance UI-01d / UI-02c / UI-02d — the guards that make ownership and settings safe to EDIT.
//
// These exist because the surfaces are about to become editable by a person. Each rule is in the
// database rather than in the form, because a form is one caller among several — a seed, an agent
// and n8n all reach the same tables — and the rule has to hold for all of them.
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

describe.skipIf(!TEST_URL)("Finance UI guards (202608251930)", () => {
  let CO: string;
  let holderA: string;
  let holderB: string;

  beforeAll(async () => {
    await initTestDb();
    CO = await createCompany("Guarded Co");
    holderA = await createUser("holder.a@ui.test");
    holderB = await createUser("holder.b@ui.test");
    await fin(CO, async (c) => {
      await c.query(
        `INSERT INTO finance_company_settings (tenant_id,functional_currency,presentation_currency,fiscal_year_start_month,is_pkp)
         VALUES ($1,'IDR','IDR',1,true) ON CONFLICT (tenant_id) DO NOTHING`,
        [CO],
      );
      await c.query(`SELECT finance_instantiate_coa($1,'id_psak_general_v1')`, [CO]);
    });
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  // ── UI-02c: the NPWP ────────────────────────────────────────────────────────────────────────
  it("an NPWP is normalised to bare digits — formatting is presentation, not storage", async () => {
    await fin(CO, (c) =>
      c.query(`UPDATE finance_company_settings SET npwp='01.234.567.8-901.000' WHERE tenant_id=$1`, [CO]),
    );
    const v = await fin(CO, async (c) =>
      (await c.query<{ npwp: string }>(`SELECT npwp FROM finance_company_settings WHERE tenant_id=$1`, [CO]))
        .rows[0].npwp,
    );
    expect(v).toBe("012345678901000");
    expect(v).toHaveLength(15);
  });

  it("a 16-digit NPWP is accepted — the NIK transition is current, not future", async () => {
    await fin(CO, (c) =>
      c.query(`UPDATE finance_company_settings SET npwp='1234567890123456' WHERE tenant_id=$1`, [CO]),
    );
    const v = await fin(CO, async (c) =>
      (await c.query<{ npwp: string }>(`SELECT npwp FROM finance_company_settings WHERE tenant_id=$1`, [CO]))
        .rows[0].npwp,
    );
    expect(v).toHaveLength(16);
  });

  it("a truncated NPWP is REFUSED at the boundary, not stored and discovered at filing time", async () => {
    await expect(
      fin(CO, (c) => c.query(`UPDATE finance_company_settings SET npwp='01.234' WHERE tenant_id=$1`, [CO])),
    ).rejects.toThrow(/FINANCE_NPWP_INVALID/);
  });

  it("clearing the NPWP is allowed — absent is a legitimate state", async () => {
    await fin(CO, (c) => c.query(`UPDATE finance_company_settings SET npwp='' WHERE tenant_id=$1`, [CO]));
    const v = await fin(CO, async (c) =>
      (await c.query<{ npwp: string | null }>(`SELECT npwp FROM finance_company_settings WHERE tenant_id=$1`, [CO]))
        .rows[0].npwp,
    );
    expect(v).toBeNull();
  });

  // ── UI-02d: PKP ─────────────────────────────────────────────────────────────────────────────
  it("PKP can be turned off while no VAT has been posted", async () => {
    await fin(CO, (c) => c.query(`UPDATE finance_company_settings SET is_pkp=false WHERE tenant_id=$1`, [CO]));
    await fin(CO, (c) => c.query(`UPDATE finance_company_settings SET is_pkp=true WHERE tenant_id=$1`, [CO]));
  });

  it("★★ PKP CANNOT be turned off once PPN is posted — it would orphan a statutory debt", async () => {
    await fin(CO, async (c) => {
      const fy = await c.query<{ id: string }>(
        `INSERT INTO finance_fiscal_years (tenant_id,code,start_date,end_date)
         VALUES ($1,'FY2026','2026-01-01','2027-01-01') RETURNING id`,
        [CO],
      );
      await c.query(`SELECT finance_generate_periods($1,'monthly')`, [fy.rows[0].id]);
      await c.query(`SELECT finance_post_journal($1,'2026-03-31','vat','sale with PPN',$2::jsonb)`, [
        CO,
        JSON.stringify([
          { account_code: "1120", side: "debit", amount: 111_000_000, memo: "bank" },
          { account_code: "4100", side: "credit", amount: 100_000_000, memo: "revenue" },
          { account_code: "2140", side: "credit", amount: 11_000_000, memo: "PPN keluaran" },
        ]),
      ]);
    });

    await expect(
      fin(CO, (c) => c.query(`UPDATE finance_company_settings SET is_pkp=false WHERE tenant_id=$1`, [CO])),
    ).rejects.toThrow(/FINANCE_PKP_HAS_POSTED_VAT/);
  });

  it("★ the fiscal year start cannot move once a calendar is cut", async () => {
    // Every period boundary, every balance sheet's fyStart and the year-end close derive from it.
    await expect(
      fin(CO, (c) =>
        c.query(`UPDATE finance_company_settings SET fiscal_year_start_month=4 WHERE tenant_id=$1`, [CO]),
      ),
    ).rejects.toThrow(/FINANCE_FY_START_LOCKED/);
  });

  // ── UI-01d: the cap table ───────────────────────────────────────────────────────────────────
  it("★ stakes totalling more than 100% are REPORTED — the column CHECK only caps one row", async () => {
    await fin(CO, (c) =>
      c.query(
        `INSERT INTO company_ownership (id,tenant_id,holder_user_id,kind,stake_pct,effective_from)
         VALUES ($1,$2,$3,'shareholder',70,'2026-01-01'), ($4,$2,$5,'shareholder',60,'2026-01-01')`,
        [newId(), CO, holderA, newId(), holderB],
      ),
    );
    const problems = await fin(CO, async (c) =>
      (
        await c.query<{ problem: string; detail: string }>(`SELECT * FROM finance_ownership_problems($1,'2026-06-30')`, [
          CO,
        ])
      ).rows,
    );
    const over = problems.find((p) => p.problem === "STAKE_EXCEEDS_100");
    expect(over).toBeDefined();
    expect(over!.detail).toMatch(/130/);
  });

  it("★ an INCOMPLETE cap table is stated out loud, not silently read as 100%", async () => {
    const CO2 = await createCompany("Partial Co");
    await fin(CO2, (c) =>
      c.query(
        `INSERT INTO company_ownership (id,tenant_id,holder_user_id,kind,stake_pct,effective_from)
         VALUES ($1,$2,$3,'shareholder',60,'2026-01-01')`,
        [newId(), CO2, holderA],
      ),
    );
    const problems = await fin(CO2, async (c) =>
      (
        await c.query<{ problem: string; detail: string }>(
          `SELECT * FROM finance_ownership_problems($1,'2026-06-30')`,
          [CO2],
        )
      ).rows,
    );
    const incomplete = problems.find((p) => p.problem === "STAKE_INCOMPLETE");
    expect(incomplete).toBeDefined();
    // The remaining 40% is unrecorded, which is NOT the same as unowned.
    expect(incomplete!.detail).toMatch(/40/);
  });

  it("validation REPORTS rather than rejects — a cap table is entered one row at a time", async () => {
    // Refusing the fourth row of a four-row entry would make the surface unusable. The insert that
    // takes the total over 100 must succeed; the problem is surfaced, not thrown.
    const CO3 = await createCompany("Building Co");
    await fin(CO3, (c) =>
      c.query(
        `INSERT INTO company_ownership (id,tenant_id,holder_user_id,kind,stake_pct,effective_from)
         VALUES ($1,$2,$3,'shareholder',90,'2026-01-01')`,
        [newId(), CO3, holderA],
      ),
    );
    // This is the row that breaks the total, and it must be ACCEPTED.
    await fin(CO3, (c) =>
      c.query(
        `INSERT INTO company_ownership (id,tenant_id,holder_user_id,kind,stake_pct,effective_from)
         VALUES ($1,$2,$3,'shareholder',30,'2026-01-01')`,
        [newId(), CO3, holderB],
      ),
    );
    const problems = await fin(CO3, async (c) =>
      (await c.query<{ problem: string }>(`SELECT * FROM finance_ownership_problems($1,'2026-06-30')`, [CO3])).rows,
    );
    expect(problems.some((p) => p.problem === "STAKE_EXCEEDS_100")).toBe(true);
  });

  it("an END-DATED edge drops out of the live total", async () => {
    // Removing a holder is setting effective_to, never DELETE: last year's statements were true
    // under last year's cap table.
    const CO4 = await createCompany("Ended Co");
    await fin(CO4, async (c) => {
      await c.query(
        `INSERT INTO company_ownership (id,tenant_id,holder_user_id,kind,stake_pct,effective_from,effective_to)
         VALUES ($1,$2,$3,'shareholder',100,'2026-01-01','2026-03-01')`,
        [newId(), CO4, holderA],
      );
      await c.query(
        `INSERT INTO company_ownership (id,tenant_id,holder_user_id,kind,stake_pct,effective_from)
         VALUES ($1,$2,$3,'shareholder',100,'2026-03-01')`,
        [newId(), CO4, holderB],
      );
    });
    // As at June only the second edge is live: 100%, not 200%.
    const problems = await fin(CO4, async (c) =>
      (await c.query<{ problem: string }>(`SELECT * FROM finance_ownership_problems($1,'2026-06-30')`, [CO4])).rows,
    );
    expect(problems.some((p) => p.problem === "STAKE_EXCEEDS_100")).toBe(false);
    // And as at February, the FIRST edge was the live one — history stays true.
    const feb = await fin(CO4, async (c) =>
      (await c.query<{ problem: string }>(`SELECT * FROM finance_ownership_problems($1,'2026-02-01')`, [CO4])).rows,
    );
    expect(feb.some((p) => p.problem === "STAKE_EXCEEDS_100")).toBe(false);
  });
});
