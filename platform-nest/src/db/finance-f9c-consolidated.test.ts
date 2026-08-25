// Finance F9-06..F9-12 — CONSOLIDATED STATEMENTS. Migration 202608251730.
//
// The assertion this file exists for is the REFUSAL: `finance_consolidated_trial_balance()` will
// not return a figure for a run with no eliminations. A sum across group members is a legitimate
// number and a useless consolidation — it counts every intercompany sale twice — and the whole
// point of F9-12 is that nothing may be called "consolidated" until the eliminations exist.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, newId } from "./index";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";
import type { PoolClient } from "pg";

async function fin<T>(t: string[], fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants(t, async (c) => {
    await c.query("SELECT set_config('app.scopes','finance',true)");
    return fn(c);
  });
}

describe.skipIf(!TEST_URL)("Finance F9 — consolidated statements (202608251730)", () => {
  let H: string, A: string, B: string, ASSOC: string, actor: string;
  let ALL: string[];
  let arCodeA = "";
  let apCodeB = "";

  beforeAll(async () => {
    await initTestDb();
    H = await createCompany("Holding PT");
    A = await createCompany("Alpha PT", [], H);
    B = await createCompany("Beta PT", [], H);
    ASSOC = await createCompany("Gamma PT", [], H);
    ALL = [H, A, B, ASSOC];
    actor = await createUser("consol@f9.test");

    for (const co of ALL) {
      await fin([co], async (c) => {
        await c.query(
          `INSERT INTO finance_company_settings (tenant_id,functional_currency,presentation_currency,fiscal_year_start_month)
           VALUES ($1,'IDR','IDR',1) ON CONFLICT (tenant_id) DO NOTHING`,
          [co],
        );
        await c.query(`SELECT finance_instantiate_coa($1,'id_psak_general_v1')`, [co]);
        const fy = await c.query<{ id: string }>(
          `INSERT INTO finance_fiscal_years (tenant_id,code,start_date,end_date)
           VALUES ($1,'FY2026','2026-01-01','2027-01-01') RETURNING id`,
          [co],
        );
        await c.query(`SELECT finance_generate_periods($1,'monthly')`, [fy.rows[0].id]);
      });
    }

    // 100% of Alpha, 60% of Beta (so 40% NCI), 30% of Gamma (equity method).
    for (const [co, kind, pct] of [[A, "holding", 100], [B, "holding", 60], [ASSOC, "shareholder", 30]] as const) {
      await fin([co], (c) =>
        c.query(
          `INSERT INTO company_ownership (id,tenant_id,holder_company_id,kind,stake_pct,effective_from)
           VALUES ($1,$2,$3,$4,$5,'2026-01-01')`,
          [newId(), co, H, kind, pct],
        ),
      );
    }

    // Capital, so each entity has equity.
    for (const [co, amt] of [[A, 200_000_000], [B, 100_000_000], [ASSOC, 50_000_000]] as const) {
      await fin([co], (c) =>
        c.query(`SELECT finance_post_journal($1,'2026-01-02','cap','capital',$2::jsonb,$3)`, [
          co,
          JSON.stringify([
            { account_code: "1120", side: "debit", amount: amt, memo: "bank" },
            { account_code: "3100", side: "credit", amount: amt, memo: "modal" },
          ]),
          actor,
        ]),
      );
    }

    // Alpha invoices Beta 50m for services — the transaction the group must NOT count.
    arCodeA = (
      await fin([A], async (c) =>
        (await c.query<{ account_code: string }>(`SELECT * FROM finance_ensure_intercompany_accounts($1,$2)`, [A, B]))
          .rows,
      )
    )[0].account_code;
    apCodeB = (
      await fin([B], async (c) =>
        (await c.query<{ account_code: string }>(`SELECT * FROM finance_ensure_intercompany_accounts($1,$2)`, [B, A]))
          .rows,
      )
    )[1].account_code;

    await fin([A], (c) =>
      c.query(`SELECT finance_post_journal($1,'2026-06-30','ic-rev','management fee to Beta',$2::jsonb,$3)`, [
        A,
        JSON.stringify([
          { account_code: arCodeA, side: "debit", amount: 50_000_000, memo: "due from Beta" },
          { account_code: "4100", side: "credit", amount: 50_000_000, memo: "management fee" },
        ]),
        actor,
      ]),
    );
    await fin([B], (c) =>
      c.query(`SELECT finance_post_journal($1,'2026-06-30','ic-exp','management fee from Alpha',$2::jsonb,$3)`, [
        B,
        JSON.stringify([
          { account_code: "6900", side: "debit", amount: 50_000_000, memo: "management fee" },
          { account_code: apCodeB, side: "credit", amount: 50_000_000, memo: "due to Alpha" },
        ]),
        actor,
      ]),
    );
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  const newRun = () =>
    fin([H], async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO finance_consolidation_runs (tenant_id,as_of,label) VALUES ($1,'2026-06-30','H1') RETURNING id`,
          [H],
        )
      ).rows[0].id,
    );

  it("★★ a run with NO eliminations REFUSES to produce a consolidated figure", async () => {
    // The single most important assertion in F9. Summing is easy and wrong.
    const run = await newRun();
    await expect(
      fin(ALL, (c) => c.query(`SELECT * FROM finance_consolidated_trial_balance($1)`, [run])),
    ).rejects.toThrow(/FINANCE_CONSOLIDATION_NOT_ELIMINATED/);
  });

  it("the naive sum IS available — under a name that says what it is", async () => {
    // Withholding a useful figure is not honesty; mislabelling it is the problem.
    const rows = await fin(ALL, async (c) =>
      (
        await c.query<{ account_code: string; balance: string }>(
          `SELECT * FROM finance_group_sum_trial_balance($1,'2026-06-30')`,
          [H],
        )
      ).rows,
    );
    const rev = rows.find((r) => r.account_code === "4100");
    // The sum counts Alpha's intercompany management fee as group revenue. That is exactly the
    // double-count, present and visible, in a function named `group_sum` rather than `consolidated`.
    expect(Number(rev!.balance)).toBe(50_000_000);
  });

  it("★ intercompany revenue is identified by SHARING A JOURNAL, not by amount matching", async () => {
    const pl = await fin([A], async (c) =>
      (
        await c.query<{ counterparty_company_id: string; account_code: string; account_type: string; amount: string }>(
          `SELECT * FROM finance_intercompany_pl($1,NULL,'2026-06-30')`,
          [A],
        )
      ).rows,
    );
    expect(pl).toHaveLength(1);
    expect(pl[0].counterparty_company_id).toBe(B);
    expect(pl[0].account_code).toBe("4100");
    expect(Number(pl[0].amount)).toBe(50_000_000);
  });

  it("★★ after eliminating, group revenue is ZERO — the fee never left the group", async () => {
    const run = await newRun();
    await fin(ALL, async (c) => {
      await c.query(`SELECT finance_eliminate_intercompany($1)`, [run]);
      await c.query(`SELECT finance_eliminate_intercompany_pl($1)`, [run]);
    });

    const tb = await fin(ALL, async (c) =>
      (
        await c.query<{ account_code: string; debit: string; credit: string }>(
          `SELECT * FROM finance_consolidated_trial_balance($1)`,
          [run],
        )
      ).rows,
    );
    const rev = tb.find((r) => r.account_code === "4100");
    const exp = tb.find((r) => r.account_code === "6900");
    // Alpha's 50m revenue and Beta's 50m expense both eliminate: the group sold nothing to anyone.
    expect(Number(rev?.credit ?? 0)).toBe(0);
    expect(Number(exp?.debit ?? 0)).toBe(0);
  });

  it("★ the intercompany RECEIVABLE and PAYABLE are gone from the group balance sheet too", async () => {
    const run = await newRun();
    await fin(ALL, async (c) => {
      await c.query(`SELECT finance_eliminate_intercompany($1)`, [run]);
      await c.query(`SELECT finance_eliminate_intercompany_pl($1)`, [run]);
    });
    const tb = await fin(ALL, async (c) =>
      (
        await c.query<{ account_code: string; debit: string; credit: string }>(
          `SELECT * FROM finance_consolidated_trial_balance($1)`,
          [run],
        )
      ).rows,
    );
    // The group cannot owe itself money.
    const ic = tb.filter((r) => r.account_code.startsWith("1290") || r.account_code.startsWith("2290"));
    for (const row of ic) {
      expect(Number(row.debit) - Number(row.credit)).toBe(0);
    }
  });

  it("★ NCI: 60% of Beta means 40% of its net assets belong to somebody else", async () => {
    const nci = await fin(ALL, async (c) =>
      (
        await c.query<{ company_id: string; nci_pct: string; net_assets: string; nci_amount: string }>(
          `SELECT * FROM finance_nci_position($1,'2026-06-30')`,
          [H],
        )
      ).rows,
    );
    expect(nci).toHaveLength(1); // only Beta; Alpha is wholly owned so there is no minority
    expect(nci[0].company_id).toBe(B);
    expect(Number(nci[0].nci_pct)).toBe(40);
    // Beta: 100m capital less the 50m management-fee expense = 50m net assets. NCI = 20m.
    expect(Number(nci[0].net_assets)).toBe(50_000_000);
    expect(Number(nci[0].nci_amount)).toBe(20_000_000);
  });

  it("★ the associate is carried at a share of net assets, NOT consolidated line by line", async () => {
    const eq = await fin(ALL, async (c) =>
      (
        await c.query<{ company_id: string; stake_pct: string; carrying_amount: string }>(
          `SELECT * FROM finance_equity_method_position($1,'2026-06-30')`,
          [H],
        )
      ).rows,
    );
    expect(eq).toHaveLength(1);
    expect(eq[0].company_id).toBe(ASSOC);
    expect(Number(eq[0].carrying_amount)).toBe(15_000_000); // 30% of 50m

    // And Gamma's own capital must NOT appear in the consolidated trial balance — bringing an
    // associate's lines in would claim control the group does not have.
    const run = await newRun();
    await fin(ALL, async (c) => {
      await c.query(`SELECT finance_eliminate_intercompany($1)`, [run]);
      await c.query(`SELECT finance_eliminate_intercompany_pl($1)`, [run]);
    });
    const tb = await fin(ALL, async (c) =>
      (
        await c.query<{ account_code: string; credit: string }>(
          `SELECT * FROM finance_consolidated_trial_balance($1)`,
          [run],
        )
      ).rows,
    );
    const capital = tb.find((r) => r.account_code === "3100");
    // Alpha 200m + Beta 100m = 300m. Gamma's 50m is absent.
    expect(Number(capital!.credit)).toBe(300_000_000);
  });
});
