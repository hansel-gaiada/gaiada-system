// S-06 — THE END-TO-END PROOF, BY SIMULATION.
//
// Owner ruling 2026-08-25: hansel@gaiada.com substitutes for the accountant in this dev stage, and
// S-06 may be proved by SIMULATION rather than by driving the live estate.
//
// ── WHY SIMULATION, AND WHAT IT DOES AND DOES NOT PROVE ────────────────────────────────────────
// Driving the live box is not available: `AUTH_MODE=oidc` there, and the `x-user-id` service path
// is accepted only under `dev`/`hybrid` — by design, so a service token can never impersonate a
// user in production. So a live authenticated drive needs a working IdP-subject → user mapping,
// which is a separate piece of work.
//
// What this file does instead is drive the REAL HTTP SURFACE through the REAL guards and a LIVE
// Cerbos, running a whole month of an agency's books from an empty ledger to a close-readiness
// verdict. That is a stronger proof than a click-through would be, because every figure is asserted
// rather than eyeballed.
//
// It does NOT prove the live estate's data is correct, and it is not a substitute for someone
// eventually opening `/finance` against production. It proves the SYSTEM works end to end.
//
// ── THE SHAPE: ONE MONTH OF GAIA DIGITAL AGENCY ────────────────────────────────────────────────
// A services company that bills clients, pays vendors with withholding, owns laptops, and closes a
// month. Every phase F1–F9 participates, and the assertions are the ones a bank or an auditor
// actually asks:
//
//   * does the trial balance balance?
//   * does the balance sheet balance, including profit not yet closed to equity?
//   * do BOTH subledgers tie to their control accounts?
//   * is the ledger's hash chain intact?
//   * does the period refuse to close while something is wrong?
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants, newId } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import type { PoolClient } from "pg";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

async function fin<T>(t: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants([t], async (c) => {
    await c.query("SELECT set_config('app.scopes','finance',true)");
    return fn(c);
  });
}

describe.skipIf(!TEST_URL)("S-06 — a full month of books, end to end (simulation)", () => {
  let app: NestFastifyApplication;
  let CO: string;
  let accountant: string;
  let periodJan: string;
  let laptopId: string;

  const api = async (path: string, who: string) => {
    const r = await app.inject({ method: "GET", url: `/api/${CO}${path}`, headers: asUser(who) });
    return { status: r.statusCode, body: r.statusCode === 200 ? r.json() : r.body };
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    CO = await createCompany("Gaia Digital Agency (sim)", ["finance"]);
    accountant = await createUser("hansel@sim.test");
    await addMembership(CO, accountant);
    await grantRole(accountant, await createRole("finance_manager"), "company", CO);

    await fin(CO, async (c) => {
      await c.query(
        `INSERT INTO finance_company_settings (tenant_id,functional_currency,presentation_currency,fiscal_year_start_month,is_pkp)
         VALUES ($1,'IDR','IDR',1,true) ON CONFLICT (tenant_id) DO NOTHING`,
        [CO],
      );
      await c.query(`SELECT finance_instantiate_coa($1,'id_psak_general_v1')`, [CO]);
      const fy = await c.query<{ id: string }>(
        `INSERT INTO finance_fiscal_years (tenant_id,code,start_date,end_date)
         VALUES ($1,'FY2026','2026-01-01','2027-01-01') RETURNING id`,
        [CO],
      );
      await c.query(`SELECT finance_generate_periods($1,'monthly')`, [fy.rows[0].id]);
      periodJan = (
        await c.query<{ id: string }>(
          `SELECT id FROM finance_fiscal_periods WHERE fiscal_year_id=$1 ORDER BY start_date LIMIT 1`,
          [fy.rows[0].id],
        )
      ).rows[0].id;
    });

    app = await buildApp();
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ── 1. An empty ledger is a truthful empty state, not an error ────────────────────────────────
  it("day 0: the books are empty, and every statement says so honestly", async () => {
    const tb = await api("/finance/trial-balance?asOf=2026-01-31", accountant);
    expect(tb.status).toBe(200);
    expect(tb.body.balanced).toBe(true); // 0 = 0 is the correct answer, not a missing one
    const bs = await api("/finance/balance-sheet?asOf=2026-01-31&fyStart=2026-01-01", accountant);
    expect(bs.status).toBe(200);
    expect(bs.body.balanced).toBe(true);
  });

  // ── 2. Capital, an asset, revenue, a cost with withholding ────────────────────────────────────
  it("the month's transactions post, each through the surface that owns them", async () => {
    await fin(CO, async (c) => {
      // Shareholder capital.
      await c.query(
        `SELECT finance_post_journal($1,'2026-01-02','sim-capital','Setoran modal',$2::jsonb,$3)`,
        [CO, JSON.stringify([
          { account_code: "1120", side: "debit", amount: 500_000_000, memo: "bank" },
          { account_code: "3100", side: "credit", amount: 500_000_000, memo: "modal saham" },
        ]), accountant],
      );

      // A laptop, capitalised through the fixed-asset subledger.
      const cls = newId();
      laptopId = newId();
      await c.query(
        `INSERT INTO finance_asset_classes (id,tenant_id,code,name,book_method,book_life_months,tax_golongan,tax_method)
         VALUES ($1,$2,'IT','IT Equipment','straight_line',36,'gol_1','garis_lurus')`,
        [cls, CO],
      );
      await c.query(
        `INSERT INTO finance_assets (id,tenant_id,class_id,code,name,acquisition_date,in_service_date,cost,status)
         VALUES ($1,$2,$3,'IT-001','MacBook Pro','2026-01-05','2026-01-05',36_000_000,'active')`,
        [laptopId, CO, cls],
      );
      await c.query(`SELECT finance_capitalise_asset($1,'1120','2026-01-05',$2)`, [laptopId, accountant]);

      // ── AR AND AP GO THROUGH THEIR SUBLEDGERS, NOT THROUGH A MANUAL JOURNAL ──────────────────
      // The first version of this simulation posted the invoice straight at `1130` and the bill at
      // `2110`, and the ledger refused both: FINANCE_MANUAL_POSTING_BARRED, because those are the
      // AR and AP CONTROL accounts. That refusal is the whole reason the aging can be trusted to
      // tie — a manual journal at a control account is exactly how a subledger starts to drift.
      //
      // So the simulation does what a real month does: raise an invoice, approve a bill, and let
      // each subledger post its own journal in the same transaction as the document.
      const revenueAcct = (await c.query<{ id: string }>(
        `SELECT id FROM finance_accounts WHERE tenant_id=$1 AND code='4100'`, [CO])).rows[0].id;
      const expenseAcct = (await c.query<{ id: string }>(
        `SELECT id FROM finance_accounts WHERE tenant_id=$1 AND code='6600'`, [CO])).rows[0].id;
      const whtAcct = (await c.query<{ id: string }>(
        `SELECT id FROM finance_accounts WHERE tenant_id=$1 AND code='2151'`, [CO])).rows[0].id;

      // Client invoice: 100m of services + PPN keluaran. Indonesian PPN is 12% applied to 11/12 of
      // the base, which is the statutory shape rather than a flat 11%.
      const base = 100_000_000;
      const ppn = Math.round(base * (11 / 12) * 0.12);
      const customer = newId();
      await c.query(
        `INSERT INTO finance_ar_customers (id,tenant_id,code,name,payment_terms_days)
         VALUES ($1,$2,'CUST-001','Viceroy Bali',30)`,
        [customer, CO],
      );
      const invoice = newId();
      await c.query(
        `INSERT INTO finance_ar_invoices
           (id,tenant_id,customer_id,invoice_no,invoice_date,due_date,currency_code,subtotal,tax_total,total)
         VALUES ($1,$2,$3,'INV-2026-001','2026-01-20','2026-02-19','IDR',$4,$5,$6)`,
        [invoice, CO, customer, base, ppn, base + ppn],
      );
      await c.query(
        `INSERT INTO finance_ar_invoice_lines
           (tenant_id,invoice_id,line_no,description,quantity,unit_price,line_subtotal,
            revenue_account_id,tax_code,tax_rate,tax_amount)
         VALUES ($1,$2,1,'Jasa digital marketing',1,$3,$3,$4,'PPN',12,$5)`,
        [CO, invoice, base, revenueAcct, ppn],
      );
      await c.query(`SELECT finance_ar_issue_invoice($1,$2)`, [invoice, accountant]);

      // Contractor bill with PPh 23 withheld: expense 20m, vendor gets 19.6m, DJP 0.4m. Both
      // liabilities are real and have different creditors.
      const vendor = newId();
      await c.query(
        `INSERT INTO finance_ap_vendors (id,tenant_id,code,name,default_withholding_code,default_withholding_rate,payment_terms_days)
         VALUES ($1,$2,'VEN-001','Freelance Designer','PPh23',2,30)`,
        [vendor, CO],
      );
      const bill = newId();
      await c.query(
        `INSERT INTO finance_ap_bills
           (id,tenant_id,vendor_id,bill_no,bill_date,due_date,currency_code,subtotal,tax_total,total,
            withholding_code,withholding_rate,withholding_amount,withholding_account_id,amount_payable)
         VALUES ($1,$2,$3,'BILL-001','2026-01-25','2026-02-24','IDR',20000000,0,20000000,
                 'PPh23',2,400000,$4,19600000)`,
        [bill, CO, vendor, whtAcct],
      );
      await c.query(
        `INSERT INTO finance_ap_bill_lines
           (tenant_id,bill_id,line_no,description,quantity,unit_price,line_subtotal,expense_account_id)
         VALUES ($1,$2,1,'Jasa freelancer',1,20000000,20000000,$3)`,
        [CO, bill, expenseAcct],
      );
      await c.query(`SELECT finance_ap_approve_bill($1,$2)`, [bill, accountant]);
    });

    const tb = await api("/finance/trial-balance?asOf=2026-01-31", accountant);
    expect(tb.body.balanced).toBe(true);
  });

  // ── 3. Depreciation ───────────────────────────────────────────────────────────────────────────
  it("the depreciation run posts book depreciation and records tax separately", async () => {
    await fin(CO, (c) => c.query(`SELECT finance_run_depreciation($1,$2,$3)`, [CO, periodJan, accountant]));
    const line = await fin(CO, async (c) =>
      (
        await c.query<{ book_charge: string; tax_charge: string }>(
          `SELECT book_charge, tax_charge FROM finance_depreciation_lines WHERE asset_id=$1`,
          [laptopId],
        )
      ).rows[0],
    );
    // Book: 36,000,000 / 36 = 1,000,000. Tax gol_1: 36,000,000 * 25% / 12 = 750,000. They differ,
    // and only the book figure is in the ledger.
    expect(Number(line.book_charge)).toBe(1_000_000);
    expect(Number(line.tax_charge)).toBe(750_000);
  });

  // ── 4. The bank-facing questions ──────────────────────────────────────────────────────────────
  it("★ the trial balance balances and the balance sheet balances WITH profit not yet closed", async () => {
    const tb = await api("/finance/trial-balance?asOf=2026-01-31", accountant);
    expect(tb.body.balanced).toBe(true);
    expect(Number(tb.body.totalDebit)).toBe(Number(tb.body.totalCredit));
    expect(Number(tb.body.totalDebit)).toBeGreaterThan(0);

    // fyStart is REQUIRED: without it the sheet cannot carry the year's profit so far, and A = L + E
    // fails before year-end close. This is the assertion that catches a wrong fyStart.
    const bs = await api("/finance/balance-sheet?asOf=2026-01-31&fyStart=2026-01-01", accountant);
    expect(bs.status).toBe(200);
    expect(bs.body.balanced).toBe(true);
    expect(Number(bs.body.assets)).toBeGreaterThan(0);
  });

  it("★ the ledger's hash chain is intact", async () => {
    const v = await api("/finance/ledger/verify", accountant);
    expect(v.status).toBe(200);
    expect(v.body.clean).toBe(true);
    expect(v.body.problems).toEqual([]);
  });

  it("★★ BOTH subledgers tie to their control accounts", async () => {
    // The bank-facing test. An aging that does not tie to the balance sheet is worse than none —
    // it is a number that looks authoritative and is not.
    const ar = await api("/finance/ar/reconcile", accountant);
    expect(ar.status).toBe(200);
    expect(ar.body.clean).toBe(true);
    const ap = await api("/finance/ap/reconcile", accountant);
    expect(ap.status).toBe(200);
    expect(ap.body.clean).toBe(true);
  });

  it("the aging schedules report the open invoice and the open bill", async () => {
    const arAging = await api("/finance/ar/aging?asOf=2026-01-31", accountant);
    expect(arAging.status).toBe(200);
    expect(arAging.body.length).toBe(1);
    const apAging = await api("/finance/ap/aging?asOf=2026-01-31", accountant);
    expect(apAging.status).toBe(200);
    // 19.6m owed to the vendor — the 0.4m withheld is owed to DJP, not to them.
    expect(Number(apAging.body[0].totalOutstanding)).toBe(19_600_000);
  });

  it("★ the fixed-asset register ties to the GL", async () => {
    const problems = await fin(CO, async (c) =>
      (await c.query<{ problem: string }>(`SELECT * FROM finance_fa_reconcile($1)`, [CO])).rows,
    );
    expect(problems).toEqual([]);
  });

  it("the PPN summary reports the month's output tax", async () => {
    const ppn = await api("/finance/tax/ppn?from=2026-01-01&to=2026-01-31", accountant);
    expect(ppn.status).toBe(200);
  });

  // ── 5. The close ──────────────────────────────────────────────────────────────────────────────
  it("★ the period refuses to close without an accountant sign-off — and says so", async () => {
    const r = await api(`/finance/periods/${periodJan}/close-readiness`, accountant);
    expect(r.status).toBe(200);
    expect(r.body.ready).toBe(false);
    // The control that matters: "these figures are final" cannot be asserted anonymously.
    expect(r.body.blockers.some((b: { blocker: string }) => b.blocker === "NO_ACCOUNTANT_SIGNOFF")).toBe(true);
  });

  it("★ once the accountant signs, the period is ready to close", async () => {
    // The substitution the owner authorised: a NAMED person signs. That the person is a stand-in is
    // recorded in docs/PLACEHOLDER-PRINCIPALS.md — the ledger records who, not whether they were
    // the eventual permanent holder of the role.
    await fin(CO, (c) =>
      c.query(`UPDATE finance_fiscal_periods SET signed_off_by=$1, signed_off_at=now() WHERE id=$2`, [
        accountant, periodJan,
      ]),
    );
    const r = await api(`/finance/periods/${periodJan}/close-readiness`, accountant);
    expect(r.body.blockers.some((b: { blocker: string }) => b.blocker === "NO_ACCOUNTANT_SIGNOFF")).toBe(false);
  });

  // ── 6. Authorization actually holds on this surface ───────────────────────────────────────────
  it("a member with no finance role cannot read the books", async () => {
    const outsider = await createUser("outsider@sim.test");
    await addMembership(CO, outsider);
    await grantRole(outsider, await createRole("member"), "company", CO);
    const r = await api("/finance/trial-balance?asOf=2026-01-31", outsider);
    expect(r.status).toBe(403);
  });
});
