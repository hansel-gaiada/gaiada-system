// Finance F9-04 — INTERCOMPANY TAGGING. Migration 202608251430.
//
// The owner confirmed there ARE dealings between the three entities, which makes eliminations
// mandatory. Elimination needs two things this migration provides: knowing which entity is on the
// other side of a balance, and knowing whether the two sides agree.
//
// The test that matters most is the LAST one: reading the pair with only one tenant in scope makes
// every balance look mismatched. That is the RLS zero-row trap in a place where it would be read as
// a real accounting difference, so it is pinned deliberately rather than left to be discovered.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants } from "./index";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import type { PoolClient } from "pg";

async function withFinance<T>(tenantIds: string[], fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants(tenantIds, async (c) => {
    await c.query("SELECT set_config('app.scopes', 'finance', true)");
    return fn(c);
  });
}

describe.skipIf(!TEST_URL)("Finance F9-04 — intercompany tagging (202608251430)", () => {
  let HOLDING: string;
  let A: string;
  let B: string;
  let arCode: string;
  let apCodeB: string;

  beforeAll(async () => {
    await initTestDb();
    // ★ A and B MUST share a root. `withTenants` refuses a tenant set spanning two root companies
    // ("a single request must not combine data from two roots"), and reading both sides of an
    // intercompany balance is inherently a two-tenant read — so consolidation only works WITHIN a
    // group, which is exactly right: two unrelated holdings must never consolidate together.
    // The first fixture here made two independent roots and every cross-company read was refused.
    HOLDING = await createCompany("Holding PT");
    A = await createCompany("Alpha PT", [], HOLDING);
    B = await createCompany("Beta PT", [], HOLDING);
    for (const co of [A, B]) {
      await withFinance([co], async (c) => {
        await c.query(
          `INSERT INTO finance_company_settings (tenant_id,functional_currency,presentation_currency,fiscal_year_start_month)
           VALUES ($1,'IDR','IDR',1) ON CONFLICT (tenant_id) DO NOTHING`,
          [co],
        );
        await c.query(`SELECT finance_instantiate_coa($1,'id_psak_general_v1')`, [co]);
        // A calendar is required: finance_post_journal refuses a date that falls in no period.
        const fy = await c.query<{ id: string }>(
          `INSERT INTO finance_fiscal_years (tenant_id,code,start_date,end_date)
           VALUES ($1,'FY2026','2026-01-01','2027-01-01') RETURNING id`,
          [co],
        );
        await c.query(`SELECT finance_generate_periods($1,'monthly')`, [fy.rows[0].id]);
      });
    }
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  it("creates a tagged receivable/payable pair, idempotently", async () => {
    const first = await withFinance([A], async (c) =>
      (
        await c.query<{ account_code: string; was_created: boolean }>(
          `SELECT * FROM finance_ensure_intercompany_accounts($1,$2)`,
          [A, B],
        )
      ).rows,
    );
    expect(first).toHaveLength(2);
    expect(first.every((r) => r.was_created)).toBe(true);
    arCode = first[0].account_code;

    // The account NAMES the counterparty — that is the point of putting the tag here.
    const acct = await withFinance([A], async (c) =>
      (
        await c.query<{ name: string; counterparty_company_id: string }>(
          `SELECT name, counterparty_company_id FROM finance_accounts WHERE tenant_id=$1 AND code=$2`,
          [A, arCode],
        )
      ).rows[0],
    );
    expect(acct.name).toMatch(/Beta PT/);
    expect(acct.counterparty_company_id).toBe(B);

    const second = await withFinance([A], async (c) =>
      (await c.query<{ was_created: boolean }>(`SELECT * FROM finance_ensure_intercompany_accounts($1,$2)`, [A, B])).rows,
    );
    expect(second.every((r) => r.was_created)).toBe(false);
  });

  it("a company cannot be its own counterparty", async () => {
    // Such a balance would eliminate against itself and net to nothing, silently removing a real
    // number from the consolidated statements.
    await expect(
      withFinance([A], (c) => c.query(`SELECT finance_ensure_intercompany_accounts($1,$1)`, [A])),
    ).rejects.toThrow(/FINANCE_COUNTERPARTY_IS_SELF/);
  });

  it("★ agreeing sides report NO mismatch", async () => {
    const mirror = await withFinance([B], async (c) =>
      (
        await c.query<{ account_code: string }>(`SELECT * FROM finance_ensure_intercompany_accounts($1,$2)`, [B, A])
      ).rows,
    );
    apCodeB = mirror[1].account_code; // the payable in B

    // A is owed 10m by B; B records owing 10m to A.
    await withFinance([A], (c) =>
      c.query(
        `SELECT finance_post_journal($1,'2026-03-31','ic-a','service to Beta',$2::jsonb)`,
        [
          A,
          JSON.stringify([
            { account_code: arCode, side: "debit", amount: 10_000_000, memo: "due from Beta" },
            { account_code: "4100", side: "credit", amount: 10_000_000, memo: "revenue" },
          ]),
        ],
      ),
    );
    await withFinance([B], (c) =>
      c.query(
        `SELECT finance_post_journal($1,'2026-03-31','ic-b','service from Alpha',$2::jsonb)`,
        [
          B,
          JSON.stringify([
            { account_code: "6900", side: "debit", amount: 10_000_000, memo: "expense" },
            { account_code: apCodeB, side: "credit", amount: 10_000_000, memo: "due to Alpha" },
          ]),
        ],
      ),
    );

    // BOTH tenants in scope — see the last test for why that matters.
    const problems = await withFinance([A, B], async (c) =>
      (
        await c.query<{ problem: string }>(`SELECT * FROM finance_intercompany_mismatch($1,$2,'2026-03-31')`, [A, B])
      ).rows,
    );
    expect(problems).toEqual([]);
  });

  it("the position reports what each side is owed, tagged by counterparty", async () => {
    const pos = await withFinance([A], async (c) =>
      (
        await c.query<{ counterparty_company_id: string; receivable: string; payable: string; net: string }>(
          `SELECT * FROM finance_intercompany_position($1,'2026-03-31')`,
          [A],
        )
      ).rows,
    );
    expect(pos).toHaveLength(1);
    expect(pos[0].counterparty_company_id).toBe(B);
    expect(Number(pos[0].receivable)).toBe(10_000_000);
    expect(Number(pos[0].net)).toBe(10_000_000);
  });

  it("★ a DISAGREEMENT is reported — elimination is impossible until it is resolved", async () => {
    // B pays 4m but A has not yet recorded receipt. Real, common, and it must be visible: a
    // consolidation that silently absorbed the difference would misstate the group.
    await withFinance([B], (c) =>
      c.query(
        `SELECT finance_post_journal($1,'2026-04-30','ic-b2','part payment to Alpha',$2::jsonb)`,
        [
          B,
          JSON.stringify([
            { account_code: apCodeB, side: "debit", amount: 4_000_000, memo: "paid Alpha" },
            { account_code: "1120", side: "credit", amount: 4_000_000, memo: "bank" },
          ]),
        ],
      ),
    );
    const problems = await withFinance([A, B], async (c) =>
      (
        await c.query<{ problem: string; detail: string }>(
          `SELECT * FROM finance_intercompany_mismatch($1,$2,'2026-04-30')`,
          [A, B],
        )
      ).rows,
    );
    expect(problems.some((p) => p.problem === "INTERCOMPANY_RECEIVABLE_MISMATCH")).toBe(true);
    expect(problems[0].detail).toMatch(/10000000|10000000\.00/);
  });

  it("★ reading the pair with ONE tenant in scope makes every balance look mismatched", async () => {
    // The RLS zero-row trap, in the one place it would be misread as an accounting difference
    // rather than a scoping bug. Pinned so the behaviour is documented rather than discovered.
    const problems = await withFinance([A], async (c) =>
      (
        await c.query<{ problem: string; detail: string }>(
          `SELECT * FROM finance_intercompany_mismatch($1,$2,'2026-03-31')`,
          [A, B],
        )
      ).rows,
    );
    // B's side reads as absent, so A's 10m receivable appears unmatched.
    expect(problems.some((p) => p.problem === "INTERCOMPANY_RECEIVABLE_MISMATCH")).toBe(true);
    expect(problems[0].detail).toMatch(/owed 10000000/);
  });
});
