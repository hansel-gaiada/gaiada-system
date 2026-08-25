// Finance F10 + F8-11 — CUTOVER, YEAR-END CLOSE, PLACING AN ASSET IN SERVICE. Migration 202608251630.
//
// The assertion this file exists for is the plug refusal. Every accounting system offers to balance
// an opening trial balance by shoving the difference into suspense, and it is the most damaging
// convenience in the category: the books balance, every report renders, and a wrong figure sits
// there until somebody amortises it into whatever account seems least objectionable.
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

describe.skipIf(!TEST_URL)("Finance F10 — cutover + year-end (202608251630)", () => {
  let CO: string;
  let actor: string;
  let fyId: string;

  beforeAll(async () => {
    await initTestDb();
    CO = await createCompany("Cutover Co");
    actor = await createUser("cutover@f10.test");
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
      fyId = fy.rows[0].id;
      await c.query(`SELECT finance_generate_periods($1,'monthly')`, [fyId]);
    });
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  async function newCutover(date = "2026-01-01"): Promise<string> {
    return fin(CO, async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO finance_cutovers (tenant_id, cutover_date) VALUES ($1,$2::date) RETURNING id`,
          [CO, date],
        )
      ).rows[0].id,
    );
  }
  const addLine = (cut: string, code: string, dr: number, cr: number) =>
    fin(CO, (c) =>
      c.query(
        `INSERT INTO finance_opening_balances (tenant_id,cutover_id,account_code,debit,credit)
         VALUES ($1,$2,$3,$4,$5)`,
        [CO, cut, code, dr, cr],
      ),
    );
  const readiness = (cut: string) =>
    fin(CO, async (c) =>
      (await c.query<{ blocker: string; detail: string }>(`SELECT * FROM finance_cutover_readiness($1)`, [cut])).rows,
    );

  it("an empty cutover is blocked, and says it has no lines", async () => {
    const cut = await newCutover();
    const b = await readiness(cut);
    expect(b.some((x) => x.blocker === "NO_OPENING_BALANCES")).toBe(true);
  });

  it("★★ an UNBALANCED opening is REFUSED — it is never plugged to suspense", async () => {
    const cut = await newCutover();
    await addLine(cut, "1120", 500_000_000, 0);
    await addLine(cut, "3100", 0, 400_000_000); // 100m short, deliberately
    const b = await readiness(cut);
    const unbalanced = b.find((x) => x.blocker === "OPENING_UNBALANCED");
    expect(unbalanced).toBeDefined();
    expect(unbalanced!.detail).toMatch(/100000000/);
    // And committing it is refused outright, not merely warned about.
    await expect(fin(CO, (c) => c.query(`SELECT finance_commit_cutover($1,$2)`, [cut, actor]))).rejects.toThrow(
      /FINANCE_CUTOVER_NOT_READY/,
    );
  });

  it("an opening line against a non-existent account is caught BEFORE commit", async () => {
    const cut = await newCutover();
    await addLine(cut, "9999", 1_000, 0);
    await addLine(cut, "3100", 0, 1_000);
    const b = await readiness(cut);
    expect(b.some((x) => x.blocker === "UNKNOWN_ACCOUNT")).toBe(true);
  });

  it("a line that is both a debit AND a credit cannot exist", async () => {
    const cut = await newCutover();
    await expect(addLine(cut, "1120", 100, 100)).rejects.toThrow(/ck_finance_opening_one_side/);
  });

  it("★ a balanced cutover commits as ONE journal tagged OPENING", async () => {
    const cut = await newCutover("2026-01-01");
    await addLine(cut, "1120", 500_000_000, 0);
    await addLine(cut, "3100", 0, 500_000_000);
    expect(await readiness(cut)).toEqual([]);

    const entry = await fin(CO, async (c) =>
      (await c.query<{ e: string }>(`SELECT finance_commit_cutover($1,$2) e`, [cut, actor])).rows[0].e,
    );
    expect(entry).toBeTruthy();

    // Findable forever: an auditor's first question is "what did you start from".
    const src = await fin(CO, async (c) =>
      (
        await c.query<{ source_event_id: string }>(
          `SELECT source_event_id FROM finance_journal_entries WHERE id=$1`,
          [entry],
        )
      ).rows[0].source_event_id,
    );
    expect(src).toMatch(/^OPENING:/);

    const tb = await fin(CO, async (c) =>
      (await c.query(`SELECT * FROM finance_trial_balance($1,'2026-01-31'::date,NULL)`, [CO])).rows,
    );
    const dr = tb.reduce((a, r: { debit: string }) => a + Number(r.debit || 0), 0);
    const cr = tb.reduce((a, r: { credit: string }) => a + Number(r.credit || 0), 0);
    expect(dr).toBe(cr);
    expect(dr).toBe(500_000_000);
  });

  it("committing a second cutover for the same company is refused", async () => {
    // Two sets of opening balances would double the company's history with no way to tell which
    // was meant.
    const cut = await newCutover("2026-02-01");
    await addLine(cut, "1120", 1_000, 0);
    await addLine(cut, "3100", 0, 1_000);
    await expect(fin(CO, (c) => c.query(`SELECT finance_commit_cutover($1,$2)`, [cut, actor]))).rejects.toThrow(
      /ux_finance_cutovers_one_committed|FINANCE_CUTOVER_ALREADY_COMMITTED/,
    );
  });

  it("★ a HARD_LOCKed period cannot be reopened (F10-10, by the EXISTING guard)", async () => {
    // The most tempting shortcut at month-end, and it invalidates every statement already issued.
    //
    // This is enforced by finance_period_state_guard() from 202608241012, not by anything F10 adds.
    // The first draft of the F10 migration added a second trigger for the same rule with its own
    // error code; it was removed rather than kept, because two copies of one rule drift and then a
    // caller handles one code and not the other.
    const p = await fin(CO, async (c) =>
      (
        await c.query<{ id: string }>(
          `SELECT id FROM finance_fiscal_periods WHERE tenant_id=$1 ORDER BY start_date LIMIT 1`,
          [CO],
        )
      ).rows[0].id,
    );
    // OPEN -> SOFT_LOCK -> HARD_LOCK. The jump is itself refused, which is the other half of the
    // same guard.
    await expect(
      fin(CO, (c) => c.query(`UPDATE finance_fiscal_periods SET state='HARD_LOCK' WHERE id=$1`, [p])),
    ).rejects.toThrow(/FINANCE_PERIOD_TRANSITION/);
    await fin(CO, (c) => c.query(`UPDATE finance_fiscal_periods SET state='SOFT_LOCK' WHERE id=$1`, [p]));
    // HARD_LOCK also needs a NAMED sign-off (D-F5) — "these figures are final" is never anonymous.
    await expect(
      fin(CO, (c) => c.query(`UPDATE finance_fiscal_periods SET state='HARD_LOCK' WHERE id=$1`, [p])),
    ).rejects.toThrow(/FINANCE_PERIOD_UNSIGNED/);
    await fin(CO, (c) =>
      c.query(`UPDATE finance_fiscal_periods SET signed_off_by=$1, signed_off_at=now() WHERE id=$2`, [actor, p]),
    );
    await fin(CO, (c) => c.query(`UPDATE finance_fiscal_periods SET state='HARD_LOCK' WHERE id=$1`, [p]));
    await expect(
      fin(CO, (c) => c.query(`UPDATE finance_fiscal_periods SET state='OPEN' WHERE id=$1`, [p])),
    ).rejects.toThrow(/FINANCE_PERIOD_HARD_LOCKED/);
  });

  it("★ a MID-YEAR cutover hard-locks preceding periods through SOFT_LOCK", async () => {
    // The case the single-step version would have failed: with a 1-January cutover no period
    // precedes it, so the bug was invisible.
    const CO4 = await createCompany("MidYear Co");
    let cut = "";
    await fin(CO4, async (c) => {
      await c.query(
        `INSERT INTO finance_company_settings (tenant_id,functional_currency,presentation_currency,fiscal_year_start_month)
         VALUES ($1,'IDR','IDR',1) ON CONFLICT (tenant_id) DO NOTHING`,
        [CO4],
      );
      await c.query(`SELECT finance_instantiate_coa($1,'id_psak_general_v1')`, [CO4]);
      const fy = await c.query<{ id: string }>(
        `INSERT INTO finance_fiscal_years (tenant_id,code,start_date,end_date)
         VALUES ($1,'FY2026','2026-01-01','2027-01-01') RETURNING id`,
        [CO4],
      );
      await c.query(`SELECT finance_generate_periods($1,'monthly')`, [fy.rows[0].id]);
      cut = (
        await c.query<{ id: string }>(
          `INSERT INTO finance_cutovers (tenant_id,cutover_date) VALUES ($1,'2026-07-01') RETURNING id`,
          [CO4],
        )
      ).rows[0].id;
      await c.query(
        `INSERT INTO finance_opening_balances (tenant_id,cutover_id,account_code,debit,credit)
         VALUES ($1,$2,'1120',250000000,0), ($1,$2,'3100',0,250000000)`,
        [CO4, cut],
      );
    });
    // An ACTORLESS commit is refused when there is history to close — closing names a person.
    // In its OWN transaction: a raised exception aborts the block, so the real commit below could
    // not run in the same one.
    await expect(fin(CO4, (c) => c.query(`SELECT finance_commit_cutover($1,NULL)`, [cut]))).rejects.toThrow(
      /FINANCE_CUTOVER_ACTOR_REQUIRED/,
    );
    await fin(CO4, (c) => c.query(`SELECT finance_commit_cutover($1,$2)`, [cut, actor]));
    const states = await fin(CO4, async (c) =>
      (
        await c.query<{ state: string; n: string }>(
          `SELECT state, count(*) n FROM finance_fiscal_periods WHERE tenant_id=$1 GROUP BY state ORDER BY state`,
          [CO4],
        )
      ).rows,
    );
    const by = Object.fromEntries(states.map((r) => [r.state, Number(r.n)]));
    expect(by["HARD_LOCK"]).toBe(6); // Jan-Jun, all before the 1 July cutover
    expect(by["OPEN"]).toBe(6);      // Jul-Dec
  });

  it("★ year-end close rolls profit into 3300, not 3200", async () => {
    const CO2 = await createCompany("YearEnd Co");
    let fy2 = "";
    await fin(CO2, async (c) => {
      await c.query(
        `INSERT INTO finance_company_settings (tenant_id,functional_currency,presentation_currency,fiscal_year_start_month)
         VALUES ($1,'IDR','IDR',1) ON CONFLICT (tenant_id) DO NOTHING`,
        [CO2],
      );
      await c.query(`SELECT finance_instantiate_coa($1,'id_psak_general_v1')`, [CO2]);
      const fy = await c.query<{ id: string }>(
        `INSERT INTO finance_fiscal_years (tenant_id,code,start_date,end_date)
         VALUES ($1,'FY2026','2026-01-01','2027-01-01') RETURNING id`,
        [CO2],
      );
      fy2 = fy.rows[0].id;
      await c.query(`SELECT finance_generate_periods($1,'monthly')`, [fy2]);
      // 100m revenue, 60m expense -> 40m profit.
      await c.query(`SELECT finance_post_journal($1,'2026-03-31','rev','revenue',$2::jsonb)`, [
        CO2,
        JSON.stringify([
          { account_code: "1120", side: "debit", amount: 100_000_000, memo: "cash" },
          { account_code: "4100", side: "credit", amount: 100_000_000, memo: "revenue" },
        ]),
      ]);
      await c.query(`SELECT finance_post_journal($1,'2026-04-30','exp','expense',$2::jsonb)`, [
        CO2,
        JSON.stringify([
          { account_code: "6900", side: "debit", amount: 60_000_000, memo: "expense" },
          { account_code: "1120", side: "credit", amount: 60_000_000, memo: "cash" },
        ]),
      ]);
    });

    await fin(CO2, (c) => c.query(`SELECT finance_close_year($1,$2,$3)`, [CO2, fy2, actor]));

    const bal = async (code: string) =>
      fin(CO2, async (c) =>
        Number(
          (
            await c.query<{ b: string }>(
              `SELECT COALESCE(sum(m.balance),0) b FROM finance_account_movement($1,NULL,NULL) m
                 JOIN finance_accounts a ON a.id=m.account_id WHERE a.code=$2`,
              [CO2, code],
            )
          ).rows[0].b,
        ),
      );
    expect(await bal("3300")).toBe(40_000_000); // retained earnings
    expect(await bal("3200")).toBe(0);          // additional paid-in capital, untouched
    expect(await bal("4100")).toBe(0);          // revenue zeroed
    expect(await bal("6900")).toBe(0);          // expense zeroed

    // Closing twice would double retained earnings.
    await expect(fin(CO2, (c) => c.query(`SELECT finance_close_year($1,$2,$3)`, [CO2, fy2, actor]))).rejects.toThrow(
      /FINANCE_YEAR_ALREADY_CLOSED/,
    );
  });

  it("★ F8-11: a CIP asset is not depreciated until it is placed in service", async () => {
    const CO3 = await createCompany("CIP Co");
    let asset = "";
    await fin(CO3, async (c) => {
      await c.query(
        `INSERT INTO finance_company_settings (tenant_id,functional_currency,presentation_currency,fiscal_year_start_month)
         VALUES ($1,'IDR','IDR',1) ON CONFLICT (tenant_id) DO NOTHING`,
        [CO3],
      );
      await c.query(`SELECT finance_instantiate_coa($1,'id_psak_general_v1')`, [CO3]);
      const fy = await c.query<{ id: string }>(
        `INSERT INTO finance_fiscal_years (tenant_id,code,start_date,end_date)
         VALUES ($1,'FY2026','2026-01-01','2027-01-01') RETURNING id`,
        [CO3],
      );
      await c.query(`SELECT finance_generate_periods($1,'monthly')`, [fy.rows[0].id]);
      const cls = newId();
      asset = newId();
      await c.query(
        `INSERT INTO finance_asset_classes (id,tenant_id,code,name,book_method,book_life_months)
         VALUES ($1,$2,'BLD','Building works','straight_line',240)`,
        [cls, CO3],
      );
      await c.query(
        `INSERT INTO finance_assets (id,tenant_id,class_id,code,name,acquisition_date,in_service_date,cost,status)
         VALUES ($1,$2,$3,'CIP-1','Fit-out','2026-01-10',NULL,240000000,'cip')`,
        [asset, CO3, cls],
      );
    });

    // No schedule at all while it is CIP — an empty result, not a row of zeros that would tie in a
    // reconciliation and hide that the asset was never commissioned.
    const before = await fin(CO3, async (c) =>
      (await c.query(`SELECT * FROM finance_asset_depreciation_schedule($1)`, [asset])).rows,
    );
    expect(before).toHaveLength(0);

    await fin(CO3, (c) => c.query(`SELECT finance_place_asset_in_service($1,'2026-04-01'::date,$2)`, [asset, actor]));

    const after = await fin(CO3, async (c) =>
      (await c.query<{ period_start: Date }>(`SELECT * FROM finance_asset_depreciation_schedule($1) ORDER BY seq`, [asset]))
        .rows,
    );
    expect(after.length).toBeGreaterThan(0);
    // Depreciation starts in April, the commissioning month — NOT January when it was bought.
    expect(after[0].period_start.getMonth() + 1).toBe(4);

    // Placing it in service twice is refused.
    await expect(
      fin(CO3, (c) => c.query(`SELECT finance_place_asset_in_service($1,'2026-05-01'::date,$2)`, [asset, actor])),
    ).rejects.toThrow(/FINANCE_ASSET_NOT_CIP/);
  });
});
