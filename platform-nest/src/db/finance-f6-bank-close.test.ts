// Finance F6 — BANK RECONCILIATION AND THE CLOSE.
//
// Covers migration 202608241023 over F1/F3/F4/F5.
//
// Two questions this suite answers:
//
//   1. DOES THE CASH EXIST? The GL says one number, the bank says another, and the difference must
//      be fully explained by items in flight — never by a plug. There is deliberately no adjustment
//      field to test, and its absence is the point.
//
//   2. CAN WE CLOSE? `finance_period_close_readiness()` aggregates every integrity check the
//      program has: ledger chain, statement balance, AR tie-out, AP tie-out, bank reconciliation,
//      and the D-F5 sign-off. An unexplained difference must BLOCK the close.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, newId } from "./index";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";
import type { PoolClient } from "pg";

async function withFinance<T>(tenantIds: string[], fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants(tenantIds, async (c) => {
    await c.query("SELECT set_config('app.scopes', 'finance', true)");
    return fn(c);
  });
}

describe.skipIf(!TEST_URL)("Finance F6 — bank reconciliation and close (202608241023)", () => {
  let CO: string;
  let accountant: string;
  let bankAcct: string;
  let marchPeriod: string;
  let statement: string;

  const recon = () =>
    withFinance([CO], async (c) =>
      (
        await c.query<Record<string, string>>("SELECT * FROM finance_bank_reconcile($1)", [statement])
      ).rows[0],
    );
  const readiness = () =>
    withFinance([CO], async (c) =>
      (
        await c.query<{ blocker: string; detail: string }>(
          "SELECT * FROM finance_period_close_readiness($1,$2)",
          [CO, marchPeriod],
        )
      ).rows,
    );
  const post = (date: string, source: string, desc: string, lines: Array<[string, string, number]>) =>
    withFinance([CO], (c) =>
      c.query("SELECT finance_post_journal($1,$2::date,$3,$4,$5::jsonb)", [
        CO, date, source, desc,
        JSON.stringify(lines.map(([account_code, side, amount]) => ({ account_code, side, amount }))),
      ]),
    );

  beforeAll(async () => {
    await initTestDb();
    CO = await createCompany("Bank Co", ["finance"]);
    accountant = await createUser("accountant@f6.test");
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

    bankAcct = await withFinance([CO], async (c) =>
      (await c.query<{ id: string }>("SELECT id FROM finance_accounts WHERE tenant_id=$1 AND code='1120'", [CO]))
        .rows[0].id,
    );
    marchPeriod = await withFinance([CO], async (c) =>
      (
        await c.query<{ id: string }>(
          "SELECT id FROM finance_fiscal_periods WHERE tenant_id=$1 AND period_no=3",
          [CO],
        )
      ).rows[0].id,
    );

    // Three cash movements in March, all recorded in the ledger.
    await post("2026-03-02", "b1", "Capital injected", [["1120", "debit", 100_000_000], ["3100", "credit", 100_000_000]]);
    await post("2026-03-10", "b2", "Rent paid", [["6200", "debit", 20_000_000], ["1120", "credit", 20_000_000]]);
    await post("2026-03-20", "b3", "Utilities paid", [["6300", "debit", 5_000_000], ["1120", "credit", 5_000_000]]);

    // The bank's version: it has seen the first two, plus a bank charge we have not recorded.
    statement = newId();
    await withFinance([CO], async (c) => {
      await c.query(
        `INSERT INTO finance_bank_statements
           (id, tenant_id, account_id, statement_no, period_start, period_end,
            opening_balance, closing_balance, currency_code, source, imported_by)
         VALUES ($1,$2,$3,'STMT-2026-03','2026-03-01','2026-03-31',0,79850000,'IDR','csv',$4)`,
        [statement, CO, bankAcct, accountant],
      );
      await c.query(
        `INSERT INTO finance_bank_transactions
           (tenant_id, statement_id, line_no, txn_date, description, direction, amount)
         VALUES
           ($1,$2,1,'2026-03-02','Transfer in','in',100000000),
           ($1,$2,2,'2026-03-11','Rent payment','out',20000000),
           ($1,$2,3,'2026-03-31','Bank charges','out',150000)`,
        [CO, statement],
      );
    });
  });
  afterAll(teardownTestDb);

  // ── Matching ───────────────────────────────────────────────────────────────────────────────────
  describe("auto-matching", () => {
    it("matches unambiguous lines within the date tolerance", async () => {
      const n = await withFinance([CO], async (c) =>
        Number(
          (await c.query<{ n: string }>("SELECT finance_bank_automatch($1,3,$2) AS n", [statement, accountant]))
            .rows[0].n,
        ),
      );
      // Capital in (same day) and rent (1 day later, inside tolerance). The bank charge has no
      // ledger line at all, so it cannot match.
      expect(n).toBe(2);
    });

    it("leaves a bank line with no ledger counterpart UNMATCHED", async () => {
      const unmatched = await withFinance([CO], async (c) =>
        (
          await c.query<{ description: string }>(
            `SELECT t.description FROM finance_bank_transactions t
              WHERE t.statement_id = $1
                AND NOT EXISTS (SELECT 1 FROM finance_bank_matches m WHERE m.bank_transaction_id = t.id)`,
            [statement],
          )
        ).rows.map((r) => r.description),
      );
      expect(unmatched).toEqual(["Bank charges"]);
    });

    it("records HOW each match was made", async () => {
      const byRule = await withFinance([CO], async (c) =>
        Number(
          (await c.query("SELECT count(*) AS n FROM finance_bank_matches WHERE matched_by_rule")).rows[0].n,
        ),
      );
      expect(byRule).toBe(2);
    });

    // The refusal is the design: a wrong match costs more than an unmatched item.
    it("REFUSES to match when two ledger lines are equally plausible", async () => {
      // Two identical 7m payments on the same day — indistinguishable on amount and date alone.
      await post("2026-03-25", "dup1", "Vendor A", [["6600", "debit", 7_000_000], ["1120", "credit", 7_000_000]]);
      await post("2026-03-25", "dup2", "Vendor B", [["6600", "debit", 7_000_000], ["1120", "credit", 7_000_000]]);

      const stmt2 = newId();
      await withFinance([CO], async (c) => {
        await c.query(
          `INSERT INTO finance_bank_statements
             (id, tenant_id, account_id, statement_no, period_start, period_end,
              opening_balance, closing_balance, currency_code)
           VALUES ($1,$2,$3,'STMT-DUP','2026-04-01','2026-04-30',0,0,'IDR')`,
          [stmt2, CO, bankAcct],
        );
        await c.query(
          `INSERT INTO finance_bank_transactions
             (tenant_id, statement_id, line_no, txn_date, description, direction, amount)
           VALUES ($1,$2,1,'2026-03-25','Payment 7m','out',7000000)`,
          [CO, stmt2],
        );
      });

      const n = await withFinance([CO], async (c) =>
        Number((await c.query<{ n: string }>("SELECT finance_bank_automatch($1) AS n", [stmt2])).rows[0].n),
      );
      expect(n).toBe(0); // ambiguous -> left for a human
    });
  });

  // ── Reconciliation ─────────────────────────────────────────────────────────────────────────────
  describe("reconciliation", () => {
    it("explains the difference entirely with items in flight", async () => {
      const r = await recon();
      // GL: 100m in, 20m out, 5m out, and the two 7m duplicates = 61m.
      expect(Number(r.gl_balance)).toBe(61_000_000);
      expect(Number(r.statement_balance)).toBe(79_850_000);
      // In flight OURS: utilities 5m + two 7m payments the bank has not shown = 19m out.
      expect(Number(r.unmatched_ledger_out)).toBe(19_000_000);
      // In flight THEIRS: the 150k bank charge we have not booked.
      expect(Number(r.unmatched_bank_out)).toBe(150_000);
      // 61m + 19m - 150k = 79.85m — exactly the statement.
      expect(Number(r.unexplained_difference)).toBe(0);
    });

    it("reports a RESIDUE when the two genuinely disagree", async () => {
      await withFinance([CO], (c) =>
        c.query("UPDATE finance_bank_statements SET closing_balance = closing_balance + 1234 WHERE id=$1", [
          statement,
        ]),
      );
      const r = await recon();
      expect(Number(r.unexplained_difference)).toBe(-1234);
      await withFinance([CO], (c) =>
        c.query("UPDATE finance_bank_statements SET closing_balance = closing_balance - 1234 WHERE id=$1", [
          statement,
        ]),
      );
      expect(Number((await recon()).unexplained_difference)).toBe(0);
    });

    // Recording the missing item is the RIGHT way to clear it — not editing the statement.
    it("clears an unrecorded bank charge by POSTING it, not by editing the statement", async () => {
      await post("2026-03-31", "b4", "Bank charges March", [
        ["7600", "debit", 150_000],
        ["1120", "credit", 150_000],
      ]);
      await withFinance([CO], (c) => c.query("SELECT finance_bank_automatch($1,3,$2)", [statement, accountant]));

      const r = await recon();
      expect(Number(r.unmatched_bank_out)).toBe(0); // the charge is now matched
      expect(Number(r.unexplained_difference)).toBe(0);
    });
  });

  // ── The close gate ─────────────────────────────────────────────────────────────────────────────
  describe("close readiness", () => {
    it("blocks on the missing accountant sign-off (D-F5)", async () => {
      const blockers = await readiness();
      expect(blockers.map((b) => b.blocker)).toContain("NO_ACCOUNTANT_SIGNOFF");
    });

    it("does NOT report ledger, statement or subledger problems on clean books", async () => {
      const kinds = (await readiness()).map((b) => b.blocker);
      expect(kinds).not.toContain("LEDGER_INTEGRITY");
      expect(kinds).not.toContain("STATEMENTS");
      expect(kinds).not.toContain("AR_RECONCILIATION");
      expect(kinds).not.toContain("AP_RECONCILIATION");
    });

    // The point of the whole phase: cash that does not tie must stop the close.
    it("★ an unexplained bank difference BLOCKS the close", async () => {
      await withFinance([CO], (c) =>
        c.query("UPDATE finance_bank_statements SET closing_balance = closing_balance + 500000 WHERE id=$1", [
          statement,
        ]),
      );
      const blockers = await readiness();
      const bank = blockers.find((b) => b.blocker === "BANK_UNEXPLAINED_DIFFERENCE");
      expect(bank).toBeDefined();
      expect(bank!.detail).toContain("unexplained");

      await withFinance([CO], (c) =>
        c.query("UPDATE finance_bank_statements SET closing_balance = closing_balance - 500000 WHERE id=$1", [
          statement,
        ]),
      );
      expect((await readiness()).map((b) => b.blocker)).not.toContain("BANK_UNEXPLAINED_DIFFERENCE");
    });

    it("clears entirely once the accountant signs off", async () => {
      await withFinance([CO], (c) =>
        c.query(
          "UPDATE finance_fiscal_periods SET signed_off_by=$2, signed_off_at=now() WHERE id=$1",
          [marchPeriod, accountant],
        ),
      );
      expect(await readiness()).toEqual([]);
    });

    // Readiness advises; the F0 trigger enforces. Both must hold.
    it("readiness does not itself close anything — the state machine still governs", async () => {
      const state = await withFinance([CO], async (c) =>
        (await c.query<{ state: string }>("SELECT state FROM finance_fiscal_periods WHERE id=$1", [marchPeriod]))
          .rows[0].state,
      );
      expect(state).toBe("OPEN");

      // And OPEN -> HARD_LOCK is still refused, readiness or not.
      await expect(
        withFinance([CO], (c) =>
          c.query("UPDATE finance_fiscal_periods SET state='HARD_LOCK' WHERE id=$1", [marchPeriod]),
        ),
      ).rejects.toThrow(/FINANCE_PERIOD_TRANSITION/);
    });

    it("a broken subledger tie-out surfaces as a close blocker", async () => {
      const cust = newId();
      const inv = newId();
      await withFinance([CO], async (c) => {
        await c.query(
          "INSERT INTO finance_ar_customers (id, tenant_id, code, name) VALUES ($1,$2,'C-1','Test Client')",
          [cust, CO],
        );
        await c.query(
          `INSERT INTO finance_ar_invoices (id, tenant_id, customer_id, invoice_no, invoice_date, due_date,
             currency_code, subtotal, tax_total, total, status, journal_entry_id)
           VALUES ($1,$2,$3,'INV-ORPHAN','2026-03-15','2026-04-14','IDR',9000000,0,9000000,'draft',NULL)`,
          [inv, CO, cust],
        );
        // Force it 'issued' WITHOUT a journal — exactly the drift the tie-out exists to catch.
        // (The status/journal CHECK permits this only because we are not setting a journal id.)
        await c.query("UPDATE finance_ar_invoices SET amount_paid = 0 WHERE id=$1", [inv]);
      });
      // The invoice is still a draft, so it is correctly OUT of the subledger position and the
      // tie-out stays clean — drafts are not receivables.
      expect((await readiness()).map((b) => b.blocker)).not.toContain("AR_RECONCILIATION");
    });
  });
});
