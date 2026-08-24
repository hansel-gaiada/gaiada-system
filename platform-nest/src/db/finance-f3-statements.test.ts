// Finance F3 — STATEMENTS: trial balance, general ledger, P&L, balance sheet, and A = L + E.
//
// Covers migration 202608241017 over F1's ledger. Runs through the NOSUPERUSER NOBYPASSRLS app role.
//
// ⚠ THIS IS THE PHASE WITH NO REFERENCE IMPLEMENTATION. project-hug's roadmap §8 ("Financial
// Reporting Engine, Phase 12") is entirely unchecked, including its own "BS Equation: Total Assets
// must equal Liabilities + Equity" checkpoint. These tests ARE the specification.
//
// The fixture is a small but complete year — capital in, revenue, a sales RETURN, expenses, and an
// amortisation adjustment — chosen so that both contra cases appear:
//   * 4300 Retur Penjualan   revenue account with a DEBIT normal balance  -> negative revenue
//   * 1240 Akumulasi Amort.  asset account with a CREDIT normal balance   -> negative asset
// Contra handling that only works for one of those is the usual half-fix; both are asserted.
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

const FY_START = "2026-01-01";
const AS_OF = "2026-12-31";

describe.skipIf(!TEST_URL)("Finance F3 — statements (202608241017)", () => {
  let CO: string;
  /** section+code -> amount, for whichever statement the helper was pointed at. */
  const num = (rows: Array<{ code: string; amount: string }>, code: string) =>
    Number(rows.find((r) => r.code === code)?.amount ?? NaN);

  async function post(date: string, source: string, desc: string, lines: Array<[string, string, number]>, kind = "standard") {
    const payload = lines.map(([account_code, side, amount]) => ({ account_code, side, amount }));
    return withFinance([CO], (c) =>
      c.query("SELECT finance_post_journal($1,$2::date,$3,$4,$5::jsonb,NULL,$6)", [
        CO, date, source, desc, JSON.stringify(payload), kind,
      ]),
    );
  }
  const pnl = () =>
    withFinance([CO], async (c) =>
      (
        await c.query<{ section: string; code: string; amount: string }>(
          "SELECT section, code, amount FROM finance_profit_and_loss($1,$2::date,$3::date)",
          [CO, FY_START, AS_OF],
        )
      ).rows,
    );
  const bs = () =>
    withFinance([CO], async (c) =>
      (
        await c.query<{ section: string; code: string; amount: string }>(
          "SELECT section, code, amount FROM finance_balance_sheet($1,$2::date,$3::date)",
          [CO, AS_OF, FY_START],
        )
      ).rows,
    );

  beforeAll(async () => {
    await initTestDb();
    CO = await createCompany("Statements Co", ["finance"]);
    await withFinance([CO], (c) =>
      c.query(
        `INSERT INTO finance_company_settings (tenant_id, functional_currency, presentation_currency)
         VALUES ($1,'IDR','IDR')`,
        [CO],
      ),
    );
    await withFinance([CO], (c) => c.query("SELECT finance_instantiate_coa($1,'id_psak_general_v1')", [CO]));
    const fy = newId();
    await withFinance([CO], (c) =>
      c.query(
        `INSERT INTO finance_fiscal_years (id, tenant_id, code, start_date, end_date)
         VALUES ($1,$2,'FY2026','2026-01-01','2027-01-01')`,
        [fy, CO],
      ),
    );
    await withFinance([CO], (c) => c.query("SELECT finance_generate_periods($1,'monthly')", [fy]));

    await post("2026-01-02", "s1", "Shareholder capital", [["1120", "debit", 500_000_000], ["3100", "credit", 500_000_000]]);
    await post("2026-02-10", "s2", "Consulting revenue", [["1120", "debit", 250_000_000], ["4100", "credit", 250_000_000]]);
    await post("2026-02-28", "s3", "Salaries February", [["6100", "debit", 90_000_000], ["1120", "credit", 90_000_000]]);
    await post("2026-03-05", "s4", "Office rent Q1", [["6200", "debit", 30_000_000], ["1120", "credit", 30_000_000]]);
    await post("2026-03-20", "s5", "Sales return", [["4300", "debit", 10_000_000], ["1120", "credit", 10_000_000]]);
    await post("2026-04-01", "s6", "Amortisation Q1", [["6700", "debit", 12_000_000], ["1240", "credit", 12_000_000]], "adjustment");
  });
  afterAll(teardownTestDb);

  // ── Trial balance ──────────────────────────────────────────────────────────────────────────────
  describe("trial balance", () => {
    it("total debits equal total credits", async () => {
      const t = await withFinance([CO], async (c) =>
        (
          await c.query<{ d: string; c: string }>(
            "SELECT sum(debit) AS d, sum(credit) AS c FROM finance_trial_balance($1,$2::date)",
            [CO, AS_OF],
          )
        ).rows[0],
      );
      expect(Number(t.d)).toBe(892_000_000);
      expect(Number(t.d)).toBe(Number(t.c));
    });

    it("lists only accounts with activity", async () => {
      const codes = await withFinance([CO], async (c) =>
        (
          await c.query<{ code: string }>("SELECT code FROM finance_trial_balance($1,$2::date) ORDER BY code", [CO, AS_OF])
        ).rows.map((r) => r.code),
      );
      expect(codes).toEqual(["1120", "1240", "3100", "4100", "4300", "6100", "6200", "6700"]);
    });
  });

  // ── P&L ────────────────────────────────────────────────────────────────────────────────────────
  describe("profit and loss", () => {
    it("nets a contra REVENUE account (sales return) negatively against revenue", async () => {
      const rows = await pnl();
      expect(num(rows, "4300")).toBe(-10_000_000); // revenue account, debit normal balance
      expect(num(rows, "TOTAL_REVENUE")).toBe(240_000_000); // 250m gross less the 10m return
    });

    it("totals expenses and computes net profit", async () => {
      const rows = await pnl();
      expect(num(rows, "TOTAL_EXPENSE")).toBe(132_000_000);
      expect(num(rows, "NET_PROFIT")).toBe(108_000_000);
      expect(num(rows, "NET_PROFIT")).toBe(num(rows, "TOTAL_REVENUE") - num(rows, "TOTAL_EXPENSE"));
    });

    // A P&L is flow, not stock — the window is what defines it.
    it("is period-scoped: a narrower window reports less", async () => {
      const q1 = await withFinance([CO], async (c) =>
        (
          await c.query<{ code: string; amount: string }>(
            "SELECT code, amount FROM finance_profit_and_loss($1,'2026-01-01'::date,'2026-03-31'::date)",
            [CO],
          )
        ).rows,
      );
      // Amortisation is dated 1 April and must be excluded.
      expect(Number.isNaN(num(q1, "6700"))).toBe(true);
      expect(num(q1, "NET_PROFIT")).toBe(120_000_000); // 240m revenue - 120m (salaries + rent)
    });
  });

  // ── Balance sheet ──────────────────────────────────────────────────────────────────────────────
  describe("balance sheet", () => {
    it("presents a contra ASSET (accumulated amortisation) negatively", async () => {
      const rows = await bs();
      expect(num(rows, "1240")).toBe(-12_000_000); // asset account, credit normal balance
      expect(num(rows, "1120")).toBe(620_000_000);
      expect(num(rows, "TOTAL_ASSETS")).toBe(608_000_000);
    });

    // The single most-missed thing in a hand-built balance sheet.
    it("carries CURRENT-YEAR PROFIT into equity — without it the sheet is out by exactly that", async () => {
      const rows = await bs();
      expect(num(rows, "CURRENT_YEAR_PROFIT")).toBe(108_000_000);
      expect(num(rows, "TOTAL_EQUITY")).toBe(608_000_000); // 500m capital + 108m profit
      // And it agrees with the P&L rather than being a second definition of profit.
      expect(num(rows, "CURRENT_YEAR_PROFIT")).toBe(num(await pnl(), "NET_PROFIT"));
    });

    it("★ A = L + E", async () => {
      const rows = await bs();
      expect(num(rows, "TOTAL_ASSETS")).toBe(num(rows, "TOTAL_LIABILITIES") + num(rows, "TOTAL_EQUITY"));
    });
  });

  // ── General ledger ─────────────────────────────────────────────────────────────────────────────
  describe("general ledger", () => {
    it("produces a CONTINUOUS running balance ending at the account's balance", async () => {
      const rows = await withFinance([CO], async (c) =>
        (
          await c.query<{ side: string; amount: string; running_balance: string }>(
            "SELECT side, amount, running_balance FROM finance_general_ledger($1,'1120')",
            [CO],
          )
        ).rows,
      );
      expect(rows).toHaveLength(5);
      // Recompute independently: each step must equal the previous plus this line's signed move.
      let acc = 0;
      for (const r of rows) {
        acc += r.side === "debit" ? Number(r.amount) : -Number(r.amount); // 1120 is debit-normal
        expect(Number(r.running_balance)).toBe(acc);
      }
      expect(acc).toBe(620_000_000);
    });

    it("opens from the prior balance when a window starts mid-year, not from zero", async () => {
      const first = await withFinance([CO], async (c) =>
        (
          await c.query<{ running_balance: string }>(
            "SELECT running_balance FROM finance_general_ledger($1,'1120','2026-03-01'::date,'2026-12-31'::date) LIMIT 1",
            [CO],
          )
        ).rows[0],
      );
      // Jan capital 500m + Feb revenue 250m - Feb salaries 90m = 660m opening, then -30m rent.
      expect(Number(first.running_balance)).toBe(630_000_000);
    });
  });

  // ── The invariants, and their survival under correction ───────────────────────────────────────
  describe("statement invariants", () => {
    it("reports ZERO problems", async () => {
      const problems = await withFinance([CO], async (c) =>
        (await c.query("SELECT * FROM finance_verify_statements($1,$2::date,$3::date)", [CO, AS_OF, FY_START])).rows,
      );
      expect(problems).toEqual([]);
    });

    // A reversal is a second journal, not a deletion. Both appear, they net to zero, and the
    // equation must still hold — a statement layer that filtered reversed entries would break here.
    it("still balances after a REVERSAL, and the reversal is visible in both statements", async () => {
      const target = await withFinance([CO], async (c) =>
        (await c.query<{ id: string }>("SELECT id FROM finance_journal_entries WHERE source_event_id='s4'")).rows[0].id,
      );
      await withFinance([CO], (c) =>
        c.query("SELECT finance_reverse_journal($1,$2,NULL,'2026-06-01'::date)", [
          target,
          "Rent was booked to the wrong company",
        ]),
      );

      const rows = await pnl();
      // Rent 30m posted then reversed nets to zero: expense drops by exactly 30m, profit rises by it.
      expect(num(rows, "6200")).toBe(0);
      expect(num(rows, "TOTAL_EXPENSE")).toBe(102_000_000);
      expect(num(rows, "NET_PROFIT")).toBe(138_000_000);

      const sheet = await bs();
      expect(num(sheet, "TOTAL_ASSETS")).toBe(num(sheet, "TOTAL_LIABILITIES") + num(sheet, "TOTAL_EQUITY"));

      const problems = await withFinance([CO], async (c) =>
        (await c.query("SELECT * FROM finance_verify_statements($1,$2::date,$3::date)", [CO, AS_OF, FY_START])).rows,
      );
      expect(problems).toEqual([]);

      // BOTH entries remain on the ledger — the correction is visible, not erased.
      const bothPresent = await withFinance([CO], async (c) =>
        Number(
          (
            await c.query(
              `SELECT count(*) AS n FROM finance_journal_entries
                WHERE tenant_id=$1 AND (source_event_id='s4' OR reversal_of_id=$2)`,
              [CO, target],
            )
          ).rows[0].n,
        ),
      );
      expect(bothPresent).toBe(2);
    });
  });

  // ── Isolation ─────────────────────────────────────────────────────────────────────────────────
  it("statements are empty for a company with no ledger", async () => {
    const other = await createCompany("Empty Co", ["finance"]);
    const rows = await withFinance([other], async (c) =>
      (await c.query("SELECT * FROM finance_trial_balance($1,$2::date)", [other, AS_OF])).rows,
    );
    expect(rows).toEqual([]);
  });
});
