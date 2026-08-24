// Finance F7 — TAX AND STATUTORY.
//
// Covers migration 202608241025 over F4 (AR output VAT) and F5 (AP input VAT + withholding).
//
// The rule this suite exists to pin has a direct money consequence:
//
//     INPUT VAT WITH NO e-FAKTUR IS NOT CREDITABLE
//
// The company pays it and cannot reclaim it. A system that quietly includes it in the claim
// overstates the refund and understates expense — so it must be EXCLUDED from the claim and
// reported separately, loudly enough that somebody chases the vendor while there is still time.
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

describe.skipIf(!TEST_URL)("Finance F7 — tax and returns (202608241025)", () => {
  let CO: string;
  let actor: string;
  let customer: string;
  let vendor: string;
  let revenueAcct: string;
  let expenseAcct: string;
  let whtAcct: string;

  const ppn = (from: string, to: string) =>
    withFinance([CO], async (c) =>
      (
        await c.query<Record<string, string>>(
          "SELECT * FROM finance_tax_ppn_summary($1,$2::date,$3::date)",
          [CO, from, to],
        )
      ).rows[0],
    );

  beforeAll(async () => {
    await initTestDb();
    CO = await createCompany("Tax Co", ["finance"]);
    actor = await createUser("tax.officer@f7.test");
    await withFinance([CO], (c) =>
      c.query(
        `INSERT INTO finance_company_settings (tenant_id, functional_currency, presentation_currency, is_pkp)
         VALUES ($1,'IDR','IDR',true)`,
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
      rev: (await c.query<{ id: string }>("SELECT id FROM finance_accounts WHERE tenant_id=$1 AND code='4100'", [CO])).rows[0].id,
      exp: (await c.query<{ id: string }>("SELECT id FROM finance_accounts WHERE tenant_id=$1 AND code='6600'", [CO])).rows[0].id,
      wht: (await c.query<{ id: string }>("SELECT id FROM finance_accounts WHERE tenant_id=$1 AND code='2151'", [CO])).rows[0].id,
      vatOut: (await c.query<{ id: string }>("SELECT id FROM finance_accounts WHERE tenant_id=$1 AND code='2140'", [CO])).rows[0].id,
    }));
    revenueAcct = ids.rev;
    expenseAcct = ids.exp;
    whtAcct = ids.wht;

    // Tax codes, including the 11/12 regime.
    await withFinance([CO], (c) =>
      c.query(
        `INSERT INTO finance_tax_codes (tenant_id, code, name, kind, rate, base_multiplier, account_id, effective_from)
         VALUES
           ($1,'PPN11','PPN 11% (pre-2025 full base)','ppn_output',11,1,$2,'2022-04-01'),
           ($1,'PPN12','PPN 12% on 11/12 base','ppn_output',12,0.9166666667,$2,'2025-01-01'),
           ($1,'PPh23','PPh 23 services 2%','pph23',2,1,$3,'2020-01-01')`,
        [CO, ids.vatOut, whtAcct],
      ),
    );

    customer = newId();
    vendor = newId();
    await withFinance([CO], async (c) => {
      await c.query(
        "INSERT INTO finance_ar_customers (id, tenant_id, code, name, is_pkp) VALUES ($1,$2,'CUST-1','Client PKP',true)",
        [customer, CO],
      );
      await c.query(
        `INSERT INTO finance_ap_vendors (id, tenant_id, code, name, npwp, default_withholding_code, default_withholding_rate)
         VALUES ($1,$2,'VEN-1','Vendor Jasa','01.111.222.3-444.000','PPh23',2)`,
        [vendor, CO],
      );
    });
  });
  afterAll(teardownTestDb);

  async function issueInvoice(no: string, date: string, net: number, tax: number, efaktur: string | null) {
    const id = newId();
    await withFinance([CO], async (c) => {
      await c.query(
        `INSERT INTO finance_ar_invoices (id, tenant_id, customer_id, invoice_no, invoice_date, due_date,
           currency_code, subtotal, tax_total, total, efaktur_no)
         VALUES ($1,$2,$3,$4,$5::date,$5::date + 30,'IDR',$6,$7,$8,$9)`,
        [id, CO, customer, no, date, net, tax, net + tax, efaktur],
      );
      await c.query(
        `INSERT INTO finance_ar_invoice_lines (tenant_id, invoice_id, line_no, description, quantity,
           unit_price, line_subtotal, revenue_account_id, tax_code, tax_rate, tax_amount)
         VALUES ($1,$2,1,'Services',1,$3,$3,$4,'PPN12',12,$5)`,
        [CO, id, net, revenueAcct, tax],
      );
      await c.query("SELECT finance_ar_issue_invoice($1,$2)", [id, actor]);
    });
    return id;
  }

  async function approveBill(no: string, date: string, net: number, tax: number, wht: number, efaktur: string | null) {
    const id = newId();
    await withFinance([CO], async (c) => {
      await c.query(
        `INSERT INTO finance_ap_bills (id, tenant_id, vendor_id, bill_no, bill_date, due_date,
           currency_code, subtotal, tax_total, total, withholding_code, withholding_rate,
           withholding_amount, withholding_account_id, amount_payable, efaktur_no)
         VALUES ($1,$2,$3,$4,$5::date,$5::date + 30,'IDR',$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [id, CO, vendor, no, date, net, tax, net + tax,
         wht > 0 ? "PPh23" : null, wht > 0 ? 2 : null, wht, wht > 0 ? whtAcct : null,
         net + tax - wht, efaktur],
      );
      await c.query(
        `INSERT INTO finance_ap_bill_lines (tenant_id, bill_id, line_no, description, quantity,
           unit_price, line_subtotal, expense_account_id, tax_code, tax_rate, tax_amount)
         VALUES ($1,$2,1,'Vendor services',1,$3,$3,$4,'PPN12',12,$5)`,
        [CO, id, net, expenseAcct, tax],
      );
      await c.query("SELECT finance_ap_approve_bill($1,$2)", [id, actor]);
    });
    return id;
  }

  // ── The 11/12 regime ───────────────────────────────────────────────────────────────────────────
  describe("tax codes", () => {
    // A single `rate` column cannot express this: 12% of 11/12 of the base is an effective 11%.
    it("applies the base multiplier — 12% on 11/12 of the base", async () => {
      const t = await withFinance([CO], async (c) =>
        Number(
          (
            await c.query<{ t: string }>(
              "SELECT finance_tax_compute($1,'PPN12',100000000,'2026-02-01'::date) AS t",
              [CO],
            )
          ).rows[0].t,
        ),
      );
      // 100m * (11/12) * 12% = 11m exactly, not 12m.
      expect(Math.round(t)).toBe(11_000_000);
    });

    // Re-rating history when the law changes is how a prior-period return stops reproducing.
    it("is effective-dated: a 2024 supply uses the old full-base 11%", async () => {
      const t = await withFinance([CO], async (c) =>
        Number(
          (
            await c.query<{ t: string }>(
              "SELECT finance_tax_compute($1,'PPN11',100000000,'2024-06-01'::date) AS t",
              [CO],
            )
          ).rows[0].t,
        ),
      );
      expect(Math.round(t)).toBe(11_000_000);
      // Same effective amount, DIFFERENT basis — and the return must be able to say which.
      const codes = await withFinance([CO], async (c) =>
        (
          await c.query<{ code: string; rate: string; base_multiplier: string }>(
            "SELECT code, rate, base_multiplier FROM finance_tax_codes WHERE tenant_id=$1 AND kind='ppn_output' ORDER BY code",
            [CO],
          )
        ).rows,
      );
      expect(codes.map((c) => `${c.code}@${Number(c.rate)}`)).toEqual(["PPN11@11", "PPN12@12"]);
    });
  });

  // ── Creditability: the money rule ─────────────────────────────────────────────────────────────
  describe("PPN summary", () => {
    beforeAll(async () => {
      // Output: two invoices, both with fakturs.
      await issueInvoice("INV-T1", "2026-02-05", 100_000_000, 11_000_000, "010.000-26.00000001");
      await issueInvoice("INV-T2", "2026-02-18", 50_000_000, 5_500_000, "010.000-26.00000002");
      // Input: one WITH a faktur, one WITHOUT.
      await approveBill("VB-T1", "2026-02-10", 40_000_000, 4_400_000, 800_000, "010.000-26.99000001");
      await approveBill("VB-T2", "2026-02-20", 20_000_000, 2_200_000, 400_000, null);
    });

    it("sums output VAT from issued invoices", async () => {
      const r = await ppn("2026-02-01", "2026-02-28");
      expect(Number(r.output_vat)).toBe(16_500_000);
    });

    // ★ The rule with a money consequence.
    it("★ EXCLUDES input VAT with no e-Faktur from the claim", async () => {
      const r = await ppn("2026-02-01", "2026-02-28");
      expect(Number(r.input_vat_creditable)).toBe(4_400_000);   // only the one with a faktur
      expect(Number(r.input_vat_uncreditable)).toBe(2_200_000); // reported, not netted
    });

    it("nets only the creditable portion into the payable", async () => {
      const r = await ppn("2026-02-01", "2026-02-28");
      expect(Number(r.net_payable)).toBe(16_500_000 - 4_400_000);
      // If the uncreditable amount had been wrongly included, the payable would be 2.2m lower —
      // an understated liability the tax office would eventually assess.
      expect(Number(r.net_payable)).not.toBe(16_500_000 - 6_600_000);
    });

    it("is period-scoped", async () => {
      const r = await ppn("2026-03-01", "2026-03-31");
      expect(Number(r.output_vat)).toBe(0);
      expect(Number(r.net_payable)).toBe(0);
    });
  });

  // ── Withholding, per counterparty ─────────────────────────────────────────────────────────────
  describe("PPh summary", () => {
    it("reports withholding per vendor per code — what e-Bupot needs", async () => {
      const rows = await withFinance([CO], async (c) =>
        (
          await c.query<{ withholding_code: string; vendor_code: string; npwp: string; withheld_amount: string; bill_count: string }>(
            "SELECT * FROM finance_tax_pph_summary($1,'2026-02-01'::date,'2026-02-28'::date)",
            [CO],
          )
        ).rows,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].withholding_code).toBe("PPh23");
      expect(rows[0].vendor_code).toBe("VEN-1");
      expect(rows[0].npwp).toBe("01.111.222.3-444.000"); // needed on the bukti potong
      expect(Number(rows[0].withheld_amount)).toBe(1_200_000); // 800k + 400k
      expect(Number(rows[0].bill_count)).toBe(2);
    });
  });

  // ── The chase list ────────────────────────────────────────────────────────────────────────────
  describe("e-Faktur exceptions", () => {
    // Same symptom, opposite consequence, different person to chase.
    it("separates a compliance failure from a money loss", async () => {
      await issueInvoice("INV-T3", "2026-02-25", 10_000_000, 1_100_000, null); // we owe a faktur
      const rows = await withFinance([CO], async (c) =>
        (
          await c.query<{ kind: string; document_no: string; tax_amount: string; detail: string }>(
            "SELECT * FROM finance_tax_efaktur_exceptions($1,'2026-02-01'::date,'2026-02-28'::date)",
            [CO],
          )
        ).rows,
      );
      const ar = rows.find((r) => r.kind === "AR_MISSING_EFAKTUR");
      const ap = rows.find((r) => r.kind === "AP_INPUT_VAT_LOST");
      expect(ar?.document_no).toBe("INV-T3");
      expect(ap?.document_no).toBe("VB-T2");
      expect(Number(ap?.tax_amount)).toBe(2_200_000);
      expect(ap?.detail).toContain("real cost");
    });
  });

  // ── Coretax reconciliation ────────────────────────────────────────────────────────────────────
  describe("Coretax reconciliation", () => {
    it("agrees when the extract matches the ledger", async () => {
      await withFinance([CO], (c) =>
        c.query(
          `INSERT INTO finance_coretax_extracts
             (tenant_id, direction, period_year, period_month, efaktur_no, doc_date, base_amount, tax_amount)
           VALUES
             ($1,'output',2026,2,'010.000-26.00000001','2026-02-05',100000000,11000000),
             ($1,'output',2026,2,'010.000-26.00000002','2026-02-18',50000000,5500000)`,
          [CO],
        ),
      );
      const problems = await withFinance([CO], async (c) =>
        (await c.query("SELECT * FROM finance_tax_coretax_reconcile($1,2026,2)", [CO])).rows,
      );
      expect(problems).toEqual([]);
    });

    it("flags a faktur DJP has that the ledger does not — issued outside the system", async () => {
      await withFinance([CO], (c) =>
        c.query(
          `INSERT INTO finance_coretax_extracts
             (tenant_id, direction, period_year, period_month, efaktur_no, doc_date, base_amount, tax_amount)
           VALUES ($1,'output',2026,2,'010.000-26.00000099','2026-02-27',9000000,990000)`,
          [CO],
        ),
      );
      const problems = await withFinance([CO], async (c) =>
        (
          await c.query<{ problem: string; efaktur_no: string }>(
            "SELECT * FROM finance_tax_coretax_reconcile($1,2026,2)",
            [CO],
          )
        ).rows,
      );
      expect(problems.map((p) => p.problem)).toContain("NOT_IN_LEDGER");
      expect(problems.find((p) => p.problem === "NOT_IN_LEDGER")!.efaktur_no).toBe("010.000-26.00000099");
    });

    // The case that quietly becomes a tax assessment.
    it("flags a tax amount that disagrees", async () => {
      await withFinance([CO], (c) =>
        c.query(
          "UPDATE finance_coretax_extracts SET tax_amount = 9999999 WHERE efaktur_no='010.000-26.00000001'",
        ),
      );
      const problems = await withFinance([CO], async (c) =>
        (
          await c.query<{ problem: string; detail: string }>(
            "SELECT * FROM finance_tax_coretax_reconcile($1,2026,2)",
            [CO],
          )
        ).rows,
      );
      const mismatch = problems.find((p) => p.problem === "TAX_AMOUNT_MISMATCH");
      expect(mismatch).toBeDefined();
      expect(mismatch!.detail).toContain("difference");
    });
  });

  // ── The filing record ─────────────────────────────────────────────────────────────────────────
  describe("returns", () => {
    it("snapshots the numbers AS FILED, separate from what the data says later", async () => {
      const ret = newId();
      const before = await ppn("2026-02-01", "2026-02-28");
      await withFinance([CO], (c) =>
        c.query(
          `INSERT INTO finance_tax_returns
             (id, tenant_id, kind, period_year, period_month, period_start, period_end,
              status, filed_output, filed_input, filed_net, filed_at, filed_by, filing_reference)
           VALUES ($1,$2,'ppn',2026,2,'2026-02-01','2026-02-28','filed',$3,$4,$5,now(),$6,'NTPN-TEST-1')`,
          [ret, CO, before.output_vat, before.input_vat_creditable, before.net_payable, actor],
        ),
      );

      // A late invoice lands after filing — the live figure moves, the filed figure must not.
      await issueInvoice("INV-LATE", "2026-02-27", 20_000_000, 2_200_000, "010.000-26.00000003");
      const after = await ppn("2026-02-01", "2026-02-28");
      const filed = await withFinance([CO], async (c) =>
        (
          await c.query<{ filed_output: string }>("SELECT filed_output FROM finance_tax_returns WHERE id=$1", [ret])
        ).rows[0],
      );
      expect(Number(after.output_vat)).toBeGreaterThan(Number(before.output_vat));
      expect(Number(filed.filed_output)).toBe(Number(before.output_vat));
    });

    it("REFUSES a filed return with no filing timestamp", async () => {
      await expect(
        withFinance([CO], (c) =>
          c.query(
            `INSERT INTO finance_tax_returns (tenant_id, kind, period_year, period_month,
               period_start, period_end, status)
             VALUES ($1,'pph23',2026,2,'2026-02-01','2026-02-28','filed')`,
            [CO],
          ),
        ),
      ).rejects.toThrow(/ck_finance_tax_returns_filed/);
    });

    it("allows one return per kind per period", async () => {
      await expect(
        withFinance([CO], (c) =>
          c.query(
            `INSERT INTO finance_tax_returns (tenant_id, kind, period_year, period_month,
               period_start, period_end, status)
             VALUES ($1,'ppn',2026,2,'2026-02-01','2026-02-28','draft')`,
            [CO],
          ),
        ),
      ).rejects.toThrow(/ux_finance_tax_returns_period/);
    });
  });
});
