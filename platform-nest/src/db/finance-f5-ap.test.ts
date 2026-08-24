// Finance F5 — ACCOUNTS PAYABLE: the mirror of F4, plus Indonesian withholding tax.
//
// Covers migration 202608241021.
//
// The reconciliation identity is REUSED from F4, second term and all:
//
//     SUM(open bills) - SUM(payments on account)  ==  AP control account balance
//
// F4's suite had to teach us that second term. This suite pins it from the start rather than
// rediscovering it.
//
// The thing AP has that AR does not is WITHHOLDING. On a 100m services bill with PPh 23 at 2%:
// the expense is 100m, the VENDOR is owed 98m, and DJP is owed 2m. Both liabilities are real and
// have different creditors. The tests below assert the split lands correctly, because booking only
// the vendor half understates payables and hides a statutory debt.
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

describe.skipIf(!TEST_URL)("Finance F5 — AP subledger (202608241021)", () => {
  let CO: string;
  let actor: string;
  let vendor: string;
  let expenseAcct: string;
  let bankAcct: string;
  let whtAcct: string; // 2151 Utang PPh 23

  const reconcile = () =>
    withFinance([CO], async (c) =>
      (await c.query<{ problem: string; detail: string }>("SELECT * FROM finance_ap_reconcile($1)", [CO])).rows,
    );
  const apControlBalance = () =>
    withFinance([CO], async (c) =>
      Number(
        (
          await c.query<{ b: string }>(
            `SELECT coalesce(sum(m.balance),0) AS b
               FROM finance_account_movement($1, NULL, NULL) m
               JOIN finance_accounts a ON a.id = m.account_id
              WHERE a.is_control AND a.control_subledger = 'ap'`,
            [CO],
          )
        ).rows[0].b,
      ),
    );
  const accountBalance = (code: string) =>
    withFinance([CO], async (c) =>
      Number(
        (
          await c.query<{ b: string }>(
            "SELECT coalesce(balance,0) AS b FROM finance_account_movement($1) WHERE code=$2",
            [CO, code],
          )
        ).rows[0]?.b ?? 0,
      ),
    );

  beforeAll(async () => {
    await initTestDb();
    CO = await createCompany("AP Co", ["finance"]);
    actor = await createUser("ap.officer@f5.test");
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
      expense: (await c.query<{ id: string }>("SELECT id FROM finance_accounts WHERE tenant_id=$1 AND code='6600'", [CO])).rows[0].id,
      bank: (await c.query<{ id: string }>("SELECT id FROM finance_accounts WHERE tenant_id=$1 AND code='1120'", [CO])).rows[0].id,
      wht: (await c.query<{ id: string }>("SELECT id FROM finance_accounts WHERE tenant_id=$1 AND code='2151'", [CO])).rows[0].id,
    }));
    expenseAcct = ids.expense;
    bankAcct = ids.bank;
    whtAcct = ids.wht;

    vendor = newId();
    await withFinance([CO], (c) =>
      c.query(
        `INSERT INTO finance_ap_vendors (id, tenant_id, code, name, npwp,
           default_withholding_code, default_withholding_rate, payment_terms_days)
         VALUES ($1,$2,'VEN-001','Konsultan Hukum','01.234.567.8-901.000','PPh23',2,30)`,
        [vendor, CO],
      ),
    );
  });
  afterAll(teardownTestDb);

  /** A services bill with PPh 23 withheld at 2% of the net. */
  async function draftBill(no: string, date: string, due: string, net: number, vat: number, wht: number) {
    const id = newId();
    await withFinance([CO], async (c) => {
      await c.query(
        `INSERT INTO finance_ap_bills
           (id, tenant_id, vendor_id, bill_no, bill_date, due_date, currency_code,
            subtotal, tax_total, total, withholding_code, withholding_rate, withholding_amount,
            withholding_account_id, amount_payable)
         VALUES ($1,$2,$3,$4,$5::date,$6::date,'IDR',$7,$8,$9,$10,$11,$12,$13,$14)`,
        [id, CO, vendor, no, date, due, net, vat, net + vat,
         wht > 0 ? "PPh23" : null, wht > 0 ? 2 : null, wht, wht > 0 ? whtAcct : null,
         net + vat - wht],
      );
      await c.query(
        `INSERT INTO finance_ap_bill_lines
           (tenant_id, bill_id, line_no, description, quantity, unit_price, line_subtotal,
            expense_account_id, tax_code, tax_rate, tax_amount)
         VALUES ($1,$2,1,'Legal advisory',1,$3,$3,$4,$5,$6,$7)`,
        [CO, id, net, expenseAcct, vat > 0 ? "PPN" : null, vat > 0 ? 11 : null, vat],
      );
    });
    return id;
  }

  // ── Withholding: the thing AP has that AR does not ────────────────────────────────────────────
  describe("approving a bill with withholding", () => {
    let bill: string;

    it("splits the credit between the VENDOR and DJP", async () => {
      // 100m services + 11m input VAT = 111m billed; 2m PPh 23 withheld; vendor gets 109m.
      bill = await draftBill("VINV-001", "2026-02-01", "2026-03-03", 100_000_000, 11_000_000, 2_000_000);
      await withFinance([CO], (c) => c.query("SELECT finance_ap_approve_bill($1,$2)", [bill, actor]));

      const lines = await withFinance([CO], async (c) =>
        (
          await c.query<{ code: string; side: string; amount: string }>(
            `SELECT a.code, l.side, l.amount
               FROM finance_ap_bills b
               JOIN finance_journal_lines l ON l.entry_id = b.journal_entry_id
               JOIN finance_accounts a ON a.id = l.account_id
              WHERE b.id = $1 ORDER BY l.line_no`,
            [bill],
          )
        ).rows,
      );
      expect(lines).toEqual([
        { code: "6600", side: "debit", amount: "100000000.0000" },  // expense, net
        { code: "1170", side: "debit", amount: "11000000.0000" },   // PPN Masukan (input VAT)
        { code: "2110", side: "credit", amount: "109000000.0000" }, // AP — what the VENDOR is owed
        { code: "2151", side: "credit", amount: "2000000.0000" },   // Utang PPh 23 — owed to DJP
      ]);
    });

    it("the expense is the GROSS service cost — withholding does not reduce it", async () => {
      expect(await accountBalance("6600")).toBe(100_000_000);
    });

    it("AP carries only what the vendor is owed, and DJP's share is a separate liability", async () => {
      expect(await apControlBalance()).toBe(109_000_000);
      expect(await accountBalance("2151")).toBe(2_000_000);
      expect(await reconcile()).toEqual([]);
    });

    it("REFUSES approving twice", async () => {
      await expect(
        withFinance([CO], (c) => c.query("SELECT finance_ap_approve_bill($1)", [bill])),
      ).rejects.toThrow(/FINANCE_AP_ALREADY_APPROVED/);
    });

    it("a MANUAL journal still cannot touch the AP control account", async () => {
      await expect(
        withFinance([CO], (c) =>
          c.query(
            `SELECT finance_post_journal($1,'2026-02-05','manual-ap','Sneaky',
               '[{"account_code":"6600","side":"debit","amount":100},
                 {"account_code":"2110","side":"credit","amount":100}]'::jsonb)`,
            [CO],
          ),
        ),
      ).rejects.toThrow(/FINANCE_MANUAL_POSTING_BARRED/);
    });

    // The subledger boundary: 'ar' may not reach the AP control account and vice versa.
    it("the AR subledger cannot post to the AP control account", async () => {
      await expect(
        withFinance([CO], (c) =>
          c.query(
            `SELECT finance_post_journal($1,'2026-02-05','ar-into-ap','Wrong subledger',
               '[{"account_code":"6600","side":"debit","amount":100},
                 {"account_code":"2110","side":"credit","amount":100}]'::jsonb,
               NULL,'standard',NULL,'IDR',NULL,NULL,'ar')`,
            [CO],
          ),
        ),
      ).rejects.toThrow(/FINANCE_MANUAL_POSTING_BARRED/);
    });
  });

  // ── Payment and allocation ────────────────────────────────────────────────────────────────────
  describe("payment and allocation", () => {
    let payment: string;
    let bill: string;

    beforeAll(async () => {
      bill = await withFinance([CO], async (c) =>
        (await c.query<{ id: string }>("SELECT id FROM finance_ap_bills WHERE bill_no='VINV-001'")).rows[0].id,
      );
      payment = newId();
      await withFinance([CO], (c) =>
        c.query(
          `INSERT INTO finance_ap_payments
             (id, tenant_id, vendor_id, payment_no, payment_date, currency_code, amount, bank_account_id)
           VALUES ($1,$2,$3,'PAY-001','2026-03-01','IDR',109000000,$4)`,
          [payment, CO, vendor, bankAcct],
        ),
      );
    });

    it("a payment posts DR AP / CR bank and clears the payable", async () => {
      await withFinance([CO], (c) => c.query("SELECT finance_ap_record_payment($1,$2)", [payment, actor]));
      expect(await apControlBalance()).toBe(0);
      // The withholding liability is untouched by paying the vendor — DJP is still owed.
      expect(await accountBalance("2151")).toBe(2_000_000);
      expect(await reconcile()).toEqual([]);
    });

    it("allocation posts no journal and marks the bill PAID", async () => {
      const before = await withFinance([CO], async (c) =>
        Number((await c.query("SELECT count(*) AS n FROM finance_journal_entries WHERE tenant_id=$1", [CO])).rows[0].n),
      );
      await withFinance([CO], (c) => c.query("SELECT finance_ap_allocate($1,$2,109000000,$3)", [payment, bill, actor]));
      const after = await withFinance([CO], async (c) =>
        Number((await c.query("SELECT count(*) AS n FROM finance_journal_entries WHERE tenant_id=$1", [CO])).rows[0].n),
      );
      expect(after).toBe(before);

      const status = await withFinance([CO], async (c) =>
        (await c.query<{ status: string }>("SELECT status FROM finance_ap_bills WHERE id=$1", [bill])).rows[0].status,
      );
      expect(status).toBe("paid");
      expect(await reconcile()).toEqual([]);
    });

    // Allocation is capped at amount_payable, not total — the withheld 2m was never the vendor's.
    it("REFUSES allocating the withheld portion to the vendor", async () => {
      const b2 = await draftBill("VINV-002", "2026-03-01", "2026-04-01", 50_000_000, 0, 1_000_000);
      await withFinance([CO], (c) => c.query("SELECT finance_ap_approve_bill($1)", [b2]));
      const p2 = newId();
      await withFinance([CO], async (c) => {
        await c.query(
          `INSERT INTO finance_ap_payments (id, tenant_id, vendor_id, payment_no, payment_date,
             currency_code, amount, bank_account_id)
           VALUES ($1,$2,$3,'PAY-002','2026-03-05','IDR',50000000,$4)`,
          [p2, CO, vendor, bankAcct],
        );
        await c.query("SELECT finance_ap_record_payment($1)", [p2]);
      });
      // The bill is 50m gross, 1m withheld -> 49m payable. Trying to pay the vendor 50m must fail.
      await expect(
        withFinance([CO], (c) => c.query("SELECT finance_ap_allocate($1,$2,50000000)", [p2, b2])),
      ).rejects.toThrow(/FINANCE_AP_OVERPAYMENT/);
      await withFinance([CO], (c) => c.query("SELECT finance_ap_allocate($1,$2,49000000)", [p2, b2]));
      expect(await reconcile()).toEqual([]);
    });

    it("REFUSES allocating across vendors", async () => {
      const other = newId();
      const otherBill = newId();
      await withFinance([CO], async (c) => {
        await c.query(
          `INSERT INTO finance_ap_vendors (id, tenant_id, code, name) VALUES ($1,$2,'VEN-002','Other Vendor')`,
          [other, CO],
        );
        await c.query(
          `INSERT INTO finance_ap_bills (id, tenant_id, vendor_id, bill_no, bill_date, due_date,
             currency_code, subtotal, tax_total, total, amount_payable)
           VALUES ($1,$2,$3,'VINV-OTHER','2026-03-01','2026-04-01','IDR',1000000,0,1000000,1000000)`,
          [otherBill, CO, other],
        );
        await c.query(
          `INSERT INTO finance_ap_bill_lines (tenant_id, bill_id, line_no, description, quantity,
             unit_price, line_subtotal, expense_account_id)
           VALUES ($1,$2,1,'Other',1,1000000,1000000,$3)`,
          [CO, otherBill, expenseAcct],
        );
        await c.query("SELECT finance_ap_approve_bill($1)", [otherBill]);
      });
      const p2 = await withFinance([CO], async (c) =>
        (await c.query<{ id: string }>("SELECT id FROM finance_ap_payments WHERE payment_no='PAY-002'")).rows[0].id,
      );
      await expect(
        withFinance([CO], (c) => c.query("SELECT finance_ap_allocate($1,$2,500000)", [p2, otherBill])),
      ).rejects.toThrow(/FINANCE_AP_VENDOR_MISMATCH/);
    });
  });

  // ── The identity, pinned from the start this time ─────────────────────────────────────────────
  describe("subledger ↔ GL reconciliation", () => {
    it("★ open bills − payments on account = AP control balance", async () => {
      const pos = await withFinance([CO], async (c) =>
        (
          await c.query<{ open_bills: string; payments_on_account: string; net_payable: string }>(
            "SELECT * FROM finance_ap_position($1)", [CO],
          )
        ).rows[0],
      );
      expect(Number(pos.net_payable)).toBe(Number(pos.open_bills) - Number(pos.payments_on_account));
      expect(Number(pos.net_payable)).toBe(await apControlBalance());
      expect(await reconcile()).toEqual([]);
    });

    // Prepaying a vendor leaves a DEBIT in the payables control account — the mirror of F4's
    // prepayment case, and the reason the second term exists.
    it("a vendor PREPAYMENT keeps the reconciliation clean", async () => {
      const p3 = newId();
      await withFinance([CO], async (c) => {
        await c.query(
          `INSERT INTO finance_ap_payments (id, tenant_id, vendor_id, payment_no, payment_date,
             currency_code, amount, bank_account_id)
           VALUES ($1,$2,$3,'PAY-PREPAY','2026-04-01','IDR',25000000,$4)`,
          [p3, CO, vendor, bankAcct],
        );
        await c.query("SELECT finance_ap_record_payment($1)", [p3]);
      });
      const pos = await withFinance([CO], async (c) =>
        (
          await c.query<{ payments_on_account: string; net_payable: string }>(
            "SELECT * FROM finance_ap_position($1)", [CO],
          )
        ).rows[0],
      );
      // 25m prepayment + a 1m residue from the withholding test above: PAY-002 was 50m, but only
      // 49m was allocable because 1m of that bill was withheld for DJP. That residue IS a payment
      // on account — the vendor holds 1m of our money with no bill against it — and it is exactly
      // the kind of balance the naive identity would have reported as a reconciliation failure.
      expect(Number(pos.payments_on_account)).toBe(26_000_000);
      expect(Number(pos.net_payable)).toBe(await apControlBalance());
      expect(await reconcile()).toEqual([]);
    });

    it("DETECTS amount_paid cache drift rather than repairing it", async () => {
      const b = await withFinance([CO], async (c) =>
        (await c.query<{ id: string }>("SELECT id FROM finance_ap_bills WHERE bill_no='VINV-OTHER'")).rows[0].id,
      );
      await withFinance([CO], (c) => c.query("UPDATE finance_ap_bills SET amount_paid=77 WHERE id=$1", [b]));
      const problems = await reconcile();
      expect(problems.map((p) => p.problem)).toContain("AP_BILL_PAID_CACHE_DRIFT");
      await withFinance([CO], (c) => c.query("UPDATE finance_ap_bills SET amount_paid=0 WHERE id=$1", [b]));
      expect(await reconcile()).toEqual([]);
    });
  });

  // ── Aging ─────────────────────────────────────────────────────────────────────────────────────
  describe("aging", () => {
    it("shows the PAYABLE amount, not the gross bill", async () => {
      const rows = await withFinance([CO], async (c) =>
        (
          await c.query<{ vendor_code: string; total_outstanding: string }>(
            "SELECT vendor_code, total_outstanding FROM finance_ap_aging($1,'2026-03-15'::date)",
            [CO],
          )
        ).rows,
      );
      const other = rows.find((r) => r.vendor_code === "VEN-002");
      expect(Number(other?.total_outstanding)).toBe(1_000_000); // no withholding on this one
      // VEN-001's bills are settled to their PAYABLE amount, so it should not appear.
      expect(rows.find((r) => r.vendor_code === "VEN-001")).toBeUndefined();
    });
  });
});
