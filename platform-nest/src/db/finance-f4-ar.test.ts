// Finance F4 — ACCOUNTS RECEIVABLE: the first subledger, and the invariant that makes it real.
//
// Covers migration 202608241019 over F1's ledger and F3's statements.
//
// ⚠ THE TEST THAT MATTERS is not "an invoice saves". It is:
//
//     SUM(open invoices) - SUM(payments on account)  ==  AR control account balance in the GL
//
// Blueprint §3.2 — "if it can drift, the system is not banking ready". An aging schedule is the
// first document a lender asks for, and an aging that does not tie to the balance sheet is worse
// than no aging: it is a number that looks authoritative and is not.
//
// ⚠ THE SECOND TERM IS NOT DECORATION. This suite was first written asserting the naive identity
// (open invoices == control account) and it FAILED, correctly: a receipt credits AR the moment the
// money lands, before anyone allocates it, so a customer who prepays leaves a credit inside the
// control account. The migration's reconciliation was fixed, not the assertion. Both numbers are
// exposed by `finance_ar_position()` so no caller re-derives the identity and gets it different.
//
// So `finance_ar_reconcile()` is asserted EMPTY after every state change below — issue, receipt,
// partial allocation, full allocation, and reversal.
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

describe.skipIf(!TEST_URL)("Finance F4 — AR subledger (202608241019)", () => {
  let CO: string;
  let actor: string;
  let customer: string;
  let otherCustomer: string;
  let revenueAcct: string;
  let bankAcct: string;

  /** The invariant, as a helper — called after every state change. */
  const reconcile = () =>
    withFinance([CO], async (c) =>
      (await c.query<{ problem: string; detail: string }>("SELECT * FROM finance_ar_reconcile($1)", [CO])).rows,
    );

  /** The subledger's NET position: open invoices less payments on account. */
  const arPosition = () =>
    withFinance([CO], async (c) =>
      (
        await c.query<{ open_invoices: string; payments_on_account: string; net_receivable: string }>(
          "SELECT * FROM finance_ar_position($1)", [CO],
        )
      ).rows[0],
    );

  /** AR control account balance straight from the GL, independent of the subledger. */
  const arControlBalance = () =>
    withFinance([CO], async (c) =>
      Number(
        (
          await c.query<{ b: string }>(
            `SELECT coalesce(sum(m.balance),0) AS b
               FROM finance_account_movement($1, NULL, NULL) m
               JOIN finance_accounts a ON a.id = m.account_id
              WHERE a.is_control AND a.control_subledger = 'ar'`,
            [CO],
          )
        ).rows[0].b,
      ),
    );

  async function draftInvoice(no: string, date: string, due: string, subtotal: number, tax = 0) {
    const id = newId();
    await withFinance([CO], async (c) => {
      await c.query(
        `INSERT INTO finance_ar_invoices
           (id, tenant_id, customer_id, invoice_no, invoice_date, due_date, currency_code,
            subtotal, tax_total, total)
         VALUES ($1,$2,$3,$4,$5::date,$6::date,'IDR',$7,$8,$9)`,
        [id, CO, customer, no, date, due, subtotal, tax, subtotal + tax],
      );
      await c.query(
        `INSERT INTO finance_ar_invoice_lines
           (tenant_id, invoice_id, line_no, description, quantity, unit_price, line_subtotal,
            revenue_account_id, tax_code, tax_rate, tax_amount)
         VALUES ($1,$2,1,'Consulting services',1,$3,$3,$4,$5,$6,$7)`,
        [CO, id, subtotal, revenueAcct, tax > 0 ? "PPN" : null, tax > 0 ? 11 : null, tax],
      );
    });
    return id;
  }

  beforeAll(async () => {
    await initTestDb();
    CO = await createCompany("AR Co", ["finance"]);
    actor = await createUser("ar.officer@f4.test");
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

    const ids = await withFinance([CO], async (c) => ({
      revenue: (await c.query<{ id: string }>("SELECT id FROM finance_accounts WHERE tenant_id=$1 AND code='4100'", [CO])).rows[0].id,
      bank: (await c.query<{ id: string }>("SELECT id FROM finance_accounts WHERE tenant_id=$1 AND code='1120'", [CO])).rows[0].id,
    }));
    revenueAcct = ids.revenue;
    bankAcct = ids.bank;

    customer = newId();
    otherCustomer = newId();
    await withFinance([CO], (c) =>
      c.query(
        `INSERT INTO finance_ar_customers (id, tenant_id, code, name, payment_terms_days)
         VALUES ($1,$2,'CUST-001','Viceroy Bali',30), ($3,$2,'CUST-002','Other Client',30)`,
        [customer, CO, otherCustomer],
      ),
    );
  });
  afterAll(teardownTestDb);

  // ── Issuing ────────────────────────────────────────────────────────────────────────────────────
  describe("issuing an invoice", () => {
    let inv: string;

    it("posts DR AR control / CR revenue / CR output VAT, and ties to the GL", async () => {
      inv = await draftInvoice("INV-001", "2026-02-01", "2026-03-03", 100_000_000, 11_000_000);
      await withFinance([CO], (c) => c.query("SELECT finance_ar_issue_invoice($1,$2)", [inv, actor]));

      const lines = await withFinance([CO], async (c) =>
        (
          await c.query<{ code: string; side: string; amount: string }>(
            `SELECT a.code, l.side, l.amount
               FROM finance_ar_invoices i
               JOIN finance_journal_lines l ON l.entry_id = i.journal_entry_id
               JOIN finance_accounts a ON a.id = l.account_id
              WHERE i.id = $1 ORDER BY l.line_no`,
            [inv],
          )
        ).rows,
      );
      expect(lines).toEqual([
        { code: "1130", side: "debit", amount: "111000000.0000" },  // AR control, gross
        { code: "4100", side: "credit", amount: "100000000.0000" }, // revenue, net
        { code: "2140", side: "credit", amount: "11000000.0000" },  // PPN Keluaran
      ]);
      expect(await arControlBalance()).toBe(111_000_000);
      expect(await reconcile()).toEqual([]);
    });

    it("REFUSES issuing twice — and the first journal stands", async () => {
      await expect(
        withFinance([CO], (c) => c.query("SELECT finance_ar_issue_invoice($1)", [inv])),
      ).rejects.toThrow(/FINANCE_AR_ALREADY_ISSUED/);
      expect(await reconcile()).toEqual([]);
    });

    it("REFUSES issuing an invoice with no lines", async () => {
      const empty = newId();
      await withFinance([CO], (c) =>
        c.query(
          `INSERT INTO finance_ar_invoices (id, tenant_id, customer_id, invoice_no, invoice_date, due_date,
             currency_code, subtotal, tax_total, total)
           VALUES ($1,$2,$3,'INV-EMPTY','2026-02-01','2026-03-03','IDR',5000000,0,5000000)`,
          [empty, CO, customer],
        ),
      );
      await expect(
        withFinance([CO], (c) => c.query("SELECT finance_ar_issue_invoice($1)", [empty])),
      ).rejects.toThrow(/FINANCE_AR_EMPTY_INVOICE/);
    });

    // The AR control account is barred to manual journals — only the 'ar' subledger may reach it.
    it("a MANUAL journal still cannot touch the AR control account", async () => {
      await expect(
        withFinance([CO], (c) =>
          c.query(
            `SELECT finance_post_journal($1,'2026-02-05','manual-ar','Sneaky',
               '[{"account_code":"1130","side":"debit","amount":100},
                 {"account_code":"4100","side":"credit","amount":100}]'::jsonb)`,
            [CO],
          ),
        ),
      ).rejects.toThrow(/FINANCE_MANUAL_POSTING_BARRED/);
    });
  });

  // ── Receipts and allocation ────────────────────────────────────────────────────────────────────
  describe("receipts and allocation", () => {
    let receipt: string;
    let inv: string;

    beforeAll(async () => {
      inv = await withFinance([CO], async (c) =>
        (await c.query<{ id: string }>("SELECT id FROM finance_ar_invoices WHERE invoice_no='INV-001'")).rows[0].id,
      );
      receipt = newId();
      await withFinance([CO], (c) =>
        c.query(
          `INSERT INTO finance_ar_receipts
             (id, tenant_id, customer_id, receipt_no, receipt_date, currency_code, amount, bank_account_id)
           VALUES ($1,$2,$3,'RCP-001','2026-03-01','IDR',50000000,$4)`,
          [receipt, CO, customer, bankAcct],
        ),
      );
    });

    it("a receipt posts DR bank / CR AR control immediately — before any allocation", async () => {
      await withFinance([CO], (c) => c.query("SELECT finance_ar_record_receipt($1,$2)", [receipt, actor]));
      // AR control drops by the receipt even though nothing is allocated yet: the customer owes
      // that much less the moment the money lands. The subledger's NET position must move with it —
      // the open invoice is still 111m, offset by a 50m payment on account.
      expect(await arControlBalance()).toBe(61_000_000);
      const pos = await arPosition();
      expect(Number(pos.open_invoices)).toBe(111_000_000);
      expect(Number(pos.payments_on_account)).toBe(50_000_000);
      expect(Number(pos.net_receivable)).toBe(61_000_000);
      expect(await reconcile()).toEqual([]);
    });

    it("allocates partially, moving no money and posting no journal", async () => {
      const before = await withFinance([CO], async (c) =>
        Number((await c.query("SELECT count(*) AS n FROM finance_journal_entries WHERE tenant_id=$1", [CO])).rows[0].n),
      );
      await withFinance([CO], (c) => c.query("SELECT finance_ar_allocate($1,$2,30000000,$3)", [receipt, inv, actor]));
      const after = await withFinance([CO], async (c) =>
        Number((await c.query("SELECT count(*) AS n FROM finance_journal_entries WHERE tenant_id=$1", [CO])).rows[0].n),
      );
      expect(after).toBe(before); // allocation is a subledger act only

      const state = await withFinance([CO], async (c) =>
        (
          await c.query<{ amount_paid: string; status: string }>(
            "SELECT amount_paid, status FROM finance_ar_invoices WHERE id=$1",
            [inv],
          )
        ).rows[0],
      );
      expect(Number(state.amount_paid)).toBe(30_000_000);
      expect(state.status).toBe("issued"); // not yet paid
      expect(await reconcile()).toEqual([]);
    });

    it("REFUSES allocating more than the receipt has left", async () => {
      await expect(
        withFinance([CO], (c) => c.query("SELECT finance_ar_allocate($1,$2,999000000)", [receipt, inv])),
      ).rejects.toThrow(/FINANCE_AR_OVER_ALLOCATED/);
    });

    it("REFUSES allocating across customers", async () => {
      const foreign = newId();
      await withFinance([CO], async (c) => {
        await c.query(
          `INSERT INTO finance_ar_invoices (id, tenant_id, customer_id, invoice_no, invoice_date, due_date,
             currency_code, subtotal, tax_total, total)
           VALUES ($1,$2,$3,'INV-OTHER','2026-02-01','2026-03-03','IDR',5000000,0,5000000)`,
          [foreign, CO, otherCustomer],
        );
        await c.query(
          `INSERT INTO finance_ar_invoice_lines (tenant_id, invoice_id, line_no, description, quantity,
             unit_price, line_subtotal, revenue_account_id)
           VALUES ($1,$2,1,'Other work',1,5000000,5000000,$3)`,
          [CO, foreign, revenueAcct],
        );
        await c.query("SELECT finance_ar_issue_invoice($1)", [foreign]);
      });
      await expect(
        withFinance([CO], (c) => c.query("SELECT finance_ar_allocate($1,$2,1000000)", [receipt, foreign])),
      ).rejects.toThrow(/FINANCE_AR_CUSTOMER_MISMATCH/);
    });

    // An overpayment is a customer credit balance, not a negative receivable — modelling it as
    // over-allocation would make the aging lie.
    it("REFUSES overpaying an invoice", async () => {
      const r2 = newId();
      await withFinance([CO], async (c) => {
        await c.query(
          `INSERT INTO finance_ar_receipts (id, tenant_id, customer_id, receipt_no, receipt_date,
             currency_code, amount, bank_account_id)
           VALUES ($1,$2,$3,'RCP-002','2026-03-02','IDR',500000000,$4)`,
          [r2, CO, customer, bankAcct],
        );
        await c.query("SELECT finance_ar_record_receipt($1)", [r2]);
      });
      await expect(
        withFinance([CO], (c) => c.query("SELECT finance_ar_allocate($1,$2,400000000)", [r2, inv])),
      ).rejects.toThrow(/FINANCE_AR_OVERPAYMENT/);
      expect(await reconcile()).toEqual([]);
    });

    it("marks the invoice PAID once fully allocated", async () => {
      const r2 = await withFinance([CO], async (c) =>
        (await c.query<{ id: string }>("SELECT id FROM finance_ar_receipts WHERE receipt_no='RCP-002'")).rows[0].id,
      );
      await withFinance([CO], (c) => c.query("SELECT finance_ar_allocate($1,$2,81000000)", [r2, inv]));
      const state = await withFinance([CO], async (c) =>
        (await c.query<{ status: string }>("SELECT status FROM finance_ar_invoices WHERE id=$1", [inv])).rows[0].status,
      );
      expect(state).toBe("paid");
      expect(await reconcile()).toEqual([]);
    });
  });

  // ── Aging ──────────────────────────────────────────────────────────────────────────────────────
  describe("aging", () => {
    // An invoice on 60-day terms issued 45 days ago is CURRENT. Ageing by issue date instead of
    // days overdue is the classic error and makes a healthy book look distressed.
    it("buckets by DAYS OVERDUE, not by invoice age", async () => {
      const long = newId();
      await withFinance([CO], async (c) => {
        await c.query(
          `INSERT INTO finance_ar_invoices (id, tenant_id, customer_id, invoice_no, invoice_date, due_date,
             currency_code, subtotal, tax_total, total)
           VALUES ($1,$2,$3,'INV-TERMS','2026-01-01','2026-03-31','IDR',7000000,0,7000000)`,
          [long, CO, otherCustomer],
        );
        await c.query(
          `INSERT INTO finance_ar_invoice_lines (tenant_id, invoice_id, line_no, description, quantity,
             unit_price, line_subtotal, revenue_account_id)
           VALUES ($1,$2,1,'Long terms',1,7000000,7000000,$3)`,
          [CO, long, revenueAcct],
        );
        await c.query("SELECT finance_ar_issue_invoice($1)", [long]);
      });

      // As of 2026-02-15 the invoice is 45 days old but NOT yet due -> current.
      const rows = await withFinance([CO], async (c) =>
        (
          await c.query<{ customer_code: string; current_amt: string; d1_30: string }>(
            "SELECT customer_code, current_amt, d1_30 FROM finance_ar_aging($1,'2026-02-15'::date)",
            [CO],
          )
        ).rows,
      );
      const other = rows.find((r) => r.customer_code === "CUST-002")!;
      expect(Number(other.current_amt)).toBe(12_000_000); // 7m long-terms + 5m INV-OTHER, both undue
      expect(Number(other.d1_30)).toBe(0);
    });

    it("moves an invoice into an overdue bucket once past its due date", async () => {
      const rows = await withFinance([CO], async (c) =>
        (
          await c.query<{ customer_code: string; d31_60: string; total_outstanding: string }>(
            "SELECT customer_code, d31_60, total_outstanding FROM finance_ar_aging($1,'2026-05-05'::date)",
            [CO],
          )
        ).rows,
      );
      const other = rows.find((r) => r.customer_code === "CUST-002")!;
      expect(Number(other.d31_60)).toBe(7_000_000); // due 31 Mar, 35 days overdue at 5 May
      expect(Number(other.total_outstanding)).toBe(12_000_000);
    });

    it("excludes fully paid invoices", async () => {
      const rows = await withFinance([CO], async (c) =>
        (
          await c.query<{ customer_code: string }>("SELECT customer_code FROM finance_ar_aging($1,'2026-12-31'::date)", [CO])
        ).rows.map((r) => r.customer_code),
      );
      expect(rows).not.toContain("CUST-001"); // INV-001 is paid in full
    });
  });

  // ── The invariant, under correction ────────────────────────────────────────────────────────────
  describe("subledger ↔ GL reconciliation", () => {
    // The aging shows OPEN INVOICES. The control account holds open invoices LESS payments on
    // account. Both statements are true and they are not the same number — asserting the naive
    // equality is what surfaced the modelling error in the first place.
    it("★ the aging total equals open invoices, and net position equals the AR control account", async () => {
      const aging = await withFinance([CO], async (c) =>
        Number(
          (
            await c.query<{ t: string }>(
              "SELECT coalesce(sum(total_outstanding),0) AS t FROM finance_ar_aging($1,'2026-12-31'::date)",
              [CO],
            )
          ).rows[0].t,
        ),
      );
      const pos = await arPosition();
      expect(aging).toBe(Number(pos.open_invoices));
      expect(Number(pos.net_receivable)).toBe(await arControlBalance());
      expect(await reconcile()).toEqual([]);
    });

    // The cache is a deliberate trade; this is the check that makes it safe.
    it("DETECTS amount_paid cache drift rather than silently repairing it", async () => {
      const inv = await withFinance([CO], async (c) =>
        (await c.query<{ id: string }>("SELECT id FROM finance_ar_invoices WHERE invoice_no='INV-TERMS'")).rows[0].id,
      );
      await withFinance([CO], (c) =>
        c.query("UPDATE finance_ar_invoices SET amount_paid = 123 WHERE id=$1", [inv]),
      );
      const problems = await reconcile();
      expect(problems.map((p) => p.problem)).toContain("AR_INVOICE_PAID_CACHE_DRIFT");
      // And the subledger/GL mismatch surfaces too, because outstanding moved.
      expect(problems.map((p) => p.problem)).toContain("AR_SUBLEDGER_GL_MISMATCH");

      await withFinance([CO], (c) => c.query("UPDATE finance_ar_invoices SET amount_paid = 0 WHERE id=$1", [inv]));
      expect(await reconcile()).toEqual([]);
    });

    it("still reconciles after the invoice journal is REVERSED", async () => {
      const row = await withFinance([CO], async (c) =>
        (
          await c.query<{ id: string; journal_entry_id: string }>(
            "SELECT id, journal_entry_id FROM finance_ar_invoices WHERE invoice_no='INV-TERMS'",
          )
        ).rows[0],
      );
      await withFinance([CO], (c) =>
        c.query("SELECT finance_reverse_journal($1,$2,NULL,'2026-06-01'::date)", [
          row.journal_entry_id,
          "Invoice raised against the wrong entity",
        ]),
      );
      // The GL no longer carries the receivable, so the subledger must be told too — voiding is the
      // subledger's half of the correction. Until it happens, reconciliation MUST fail loudly.
      const before = await reconcile();
      expect(before.map((p) => p.problem)).toContain("AR_SUBLEDGER_GL_MISMATCH");

      await withFinance([CO], (c) =>
        c.query("UPDATE finance_ar_invoices SET status='void' WHERE id=$1", [row.id]),
      );
      expect(await reconcile()).toEqual([]);
    });
  });
});
