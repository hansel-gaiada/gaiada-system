// PV5-04 — issuing an invoice THROUGH THE LEDGER (PV-D7), the billing profile API, payments that post, void after
// issue, and the portal's invoice of record. Real HTTP surface against Postgres + RLS + Cerbos (the Linux gate; skips
// without DATABASE_URL_TEST, and a skipped run proves nothing).
//
// TEETH (each proven in the PV5-04 hand-back by breaking the code in a throwaway commit):
//   (a) drop the readiness re-check inside issueInvoice()'s transaction  -> "no billing profile" fails (500, not 409);
//   (b) take the number outside the issue transaction                    -> "a refused issue consumes no number" fails;
//   (c) drop { modules: ["finance"] } from the portal invoice list       -> "the portal shows the invoice of record" fails
//       (the AR join reads zero rows and raises nothing: `payable` reads false);
//   (d) weaken invoices_sent_paid_issued                                  -> pv5-invoice-enforcement.db.test.ts fails.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../testing/fixtures";
import { createIssuedInvoice, ensureBillingSetup } from "../../seed/billing-setup";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("PV5-04 — issue an invoice through the ledger", () => {
  let app: NestFastifyApplication;
  let A: string;        // fully set up (finance + billing profile, prefix TST)
  let B: string;        // invoicing only: no finance setup, no billing profile
  let C: string;        // set up, prefix GAP: the gapless-number case
  let admin: string;    // company_admin of A, B, C (issues, voids)
  let manager: string;  // manager of A (may issue, may NOT void)
  let member: string;   // member of A (nothing)
  let bot: string;      // company_admin of A, users.kind = 'bot'
  let recorder: string; // a second company_admin: records payments admin confirms
  let finMgr: string;   // finance_manager of B
  let ownerB: string;   // owner of B
  let contact: string;  // client contact of clientA (portal)
  let clientA: string;
  let clientB: string;
  let clientC: string;
  let sister: string;   // a company the group client is
  let groupClient: string;
  let year: string;

  const finance = <T>(t: string, sql: string, args: unknown[] = []) =>
    withTenants([t], (c) => c.query(sql, args), { modules: ["finance"] }).then((r) => r.rows as T[]);

  /** An APPROVED invoice (the stage issue starts from), lines that add up, inserted directly. */
  async function approvedInvoice(t: string, client: string | null, amount: number, cols: { taxCode?: string; currency?: string } = {}): Promise<string> {
    const id = newId();
    await withTenants([t], (c) =>
      c.query(
        `INSERT INTO invoices (id, tenant_id, client_id, period_start, period_end, status, currency, lines, total, origin_site,
                               created_by, updated_by, approved_by, approved_at, tax_code)
         VALUES ($1, $2, $3, current_date - 30, current_date, 'approved', $4, $5, $6, 'test', $7, $7, $8, now(), $9)`,
        [id, t, client, cols.currency ?? "IDR", JSON.stringify([{ description: "Design work", hours: 1, rate: amount, amount }]),
         amount, recorder, admin, cols.taxCode ?? null],
      ),
    );
    return id;
  }
  const issue = (t: string, id: string, who = admin) =>
    app.inject({ method: "POST", url: `/api/${t}/invoices/${id}/issue`, headers: asUser(who) });
  const readiness = (t: string, id: string, who = admin) =>
    app.inject({ method: "GET", url: `/api/${t}/invoices/${id}/issue-readiness`, headers: asUser(who) });
  const reconcile = (t: string) => finance<{ problem: string; detail: string }>(t, `SELECT problem, detail FROM finance_ar_reconcile($1, NULL)`, [t]);
  async function pendingPayment(t: string, invoiceId: string, client: string | null, amount: number): Promise<string> {
    const id = newId();
    await withTenants([t], (c) =>
      c.query(
        `INSERT INTO invoice_payments (id, tenant_id, invoice_id, client_id, amount, currency, paid_on, status, recorded_by, origin_site, source)
         VALUES ($1, $2, $3, $4, $5, 'IDR', current_date, 'pending', $6, 'test', 'staff')`,
        [id, t, invoiceId, client, amount, recorder],
      ),
    );
    return id;
  }
  const decide = (t: string, paymentId: string, decision: "confirm" | "reject", reason?: string) =>
    app.inject({ method: "POST", url: `/api/${t}/invoice-payments/${paymentId}/decide`, headers: asUser(admin), payload: { decision, reason } });
  const row = async (sql: string, args: unknown[]) => (await adminPool().query(sql, args)).rows[0];

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    A = await createCompany("PV5-04 Agency A", ["invoice", "clients"]);
    B = await createCompany("PV5-04 Agency B", ["invoice", "clients"]);
    C = await createCompany("PV5-04 Agency C", ["invoice", "clients"]);
    sister = await createCompany("PV5-04 Sister Co");
    admin = await createUser("admin@pv504.test");
    manager = await createUser("manager@pv504.test");
    member = await createUser("member@pv504.test");
    bot = await createUser("bot@pv504.test");
    recorder = await createUser("recorder@pv504.test");
    finMgr = await createUser("finmgr@pv504.test");
    ownerB = await createUser("owner-b@pv504.test");
    contact = await createUser("contact@pv504-client.test");
    const companyAdmin = await createRole("company_admin");
    for (const t of [A, B, C]) {
      await addMembership(t, admin);
      await grantRole(admin, companyAdmin, "company", t);
      await addMembership(t, recorder);
      await grantRole(recorder, companyAdmin, "company", t);
    }
    for (const u of [manager, member, bot]) await addMembership(A, u);
    await grantRole(manager, await createRole("manager"), "company", A);
    await grantRole(member, await createRole("member"), "company", A);
    await grantRole(bot, companyAdmin, "company", A);
    await adminPool().query(`UPDATE users SET kind = 'bot' WHERE id = $1`, [bot]);
    await addMembership(B, finMgr);
    await grantRole(finMgr, await createRole("finance_manager"), "company", B);
    await addMembership(B, ownerB);
    await grantRole(ownerB, await createRole("owner"), "company", B);

    clientA = await createClient(A, "PV5-04 Client A");
    clientB = await createClient(B, "PV5-04 Client B");
    clientC = await createClient(C, "PV5-04 Client C");
    groupClient = await createClient(A, "PV5-04 Group Client");
    await withTenants([A], (c) => c.query(`UPDATE clients SET group_company_id = $2 WHERE id = $1`, [groupClient, sister]));
    await withTenants([A], async (c) => {
      await c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site)
         VALUES ($1, $2, $3, $4, NULL, 'signer', 'active', now(), 'test')`,
        [newId(), A, clientA, contact],
      );
    });
    await grantRole(contact, await createRole("client"), "company", A);

    await ensureBillingSetup(A, { prefix: "TST" });
    await ensureBillingSetup(C, { prefix: "GAP" });
    year = String((await row(`SELECT extract(year FROM current_date)::int AS y`, [])).y);
    app = await buildApp();
  }, 180_000);
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ── authorization runs first ──────────────────────────────────────────────────────────────────────
  describe("authorization", () => {
    it("a bot holding company_admin is refused issue and void (403) before any validation, even on an unknown id", async () => {
      expect((await issue(A, newId(), bot)).statusCode).toBe(403);
      const v = await app.inject({ method: "POST", url: `/api/${A}/invoices/${newId()}/void`, headers: asUser(bot), payload: {} });
      expect(v.statusCode).toBe(403);
    });
    it("a plain member is refused issue (403)", async () => {
      expect((await issue(A, newId(), member)).statusCode).toBe(403);
    });
  });

  // ── readiness ───────────────────────────────────────────────────────────────────────────────────────
  describe("issue readiness", () => {
    it("a company with no finance setup and no billing profile: every blocker at once, and issuing writes NOTHING (409)", async () => {
      const id = await approvedInvoice(B, clientB, 1000);
      const r = await readiness(B, id);
      expect(r.statusCode).toBe(200);
      const codes = (r.json() as { ready: boolean; blockers: Array<{ code: string }> }).blockers.map((b) => b.code);
      expect(r.json().ready).toBe(false);
      expect(codes).toEqual(expect.arrayContaining(["NO_BILLING_PROFILE", "FINANCE_MODULE_OFF", "NO_FINANCE_SETTINGS", "NO_AR_CONTROL_ACCOUNT", "NO_OPEN_PERIOD"]));

      const res = await issue(B, id);
      expect(res.statusCode, res.body).toBe(409);
      const body = res.json() as { reason: string; blockers: Array<{ code: string }> };
      expect(body.reason).toBe("issue_blocked");
      expect(body.blockers.map((b) => b.code)).toContain("NO_BILLING_PROFILE");
      // Nothing was written: no number, no customer, no ledger invoice, no status change.
      expect(await row(`SELECT status, issued_at, invoice_no FROM invoices WHERE id = $1`, [id])).toEqual({ status: "approved", issued_at: null, invoice_no: null });
      expect((await row(`SELECT count(*)::int AS n FROM document_series WHERE tenant_id = $1`, [B])).n).toBe(0);
      expect((await row(`SELECT count(*)::int AS n FROM finance_ar_customers WHERE tenant_id = $1`, [B])).n).toBe(0);
      expect((await row(`SELECT count(*)::int AS n FROM finance_ar_invoices WHERE tenant_id = $1`, [B])).n).toBe(0);
    });

    it("a ready company reads clean (proves the finance scope is declared: without it the chart reads as empty)", async () => {
      const id = await approvedInvoice(A, clientA, 1000);
      const r = await readiness(A, id);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ ready: true, blockers: [], issued: false });
    });

    it("a draft, a foreign-currency invoice and lines that do not add up are each named", async () => {
      const draft = await approvedInvoice(A, clientA, 1000);
      await withTenants([A], (c) => c.query(`UPDATE invoices SET status = 'draft' WHERE id = $1`, [draft]));
      expect((await readiness(A, draft)).json().blockers.map((b: { code: string }) => b.code)).toContain("NOT_APPROVED");
      const usd = await approvedInvoice(A, clientA, 1000, { currency: "USD" });
      expect((await readiness(A, usd)).json().blockers.map((b: { code: string }) => b.code)).toContain("CURRENCY_NOT_FUNCTIONAL");
      const off = await approvedInvoice(A, clientA, 1000);
      await withTenants([A], (c) => c.query(`UPDATE invoices SET total = 999 WHERE id = $1`, [off]));
      expect((await readiness(A, off)).json().blockers.map((b: { code: string }) => b.code)).toContain("LINES_TOTAL_MISMATCH");
    });
  });

  // ── issuing ─────────────────────────────────────────────────────────────────────────────────────────
  describe("issue", () => {
    it("posts a balanced journal; the AR invoice and the invoice agree on number and totals; reconciliation is clean; a second call is idempotent", async () => {
      const id = await approvedInvoice(A, clientA, 2_500_000);
      const res = await issue(A, id);
      expect(res.statusCode, res.body).toBe(200);
      const out = res.json() as { invoiceNo: string; arInvoiceId: string; total: string; alreadyIssued: boolean; dueDate: string; issueDate: string };
      expect(out.alreadyIssued).toBe(false);
      expect(out.invoiceNo).toMatch(new RegExp(`^TST/${year}/\\d{4}$`));

      const inv = await row(
        `SELECT status, invoice_no, total::text AS total, subtotal::text AS subtotal, tax_total::text AS tax, issuer, ar_invoice_id, issued_by,
                (due_date - issue_date) AS terms
           FROM invoices WHERE id = $1`, [id]);
      expect(inv).toMatchObject({ status: "sent", invoice_no: out.invoiceNo, subtotal: "2500000", tax: "0", ar_invoice_id: out.arInvoiceId, issued_by: admin, terms: 30 });
      expect(Number(inv.total)).toBe(2_500_000);
      expect(inv.issuer).toMatchObject({ legalName: "PV5-04 Agency A", bank: { accountNo: "0000000000" } });

      const ar = await row(
        `SELECT a.invoice_no, a.total::text AS total, a.status, a.journal_entry_id, cu.client_id, j.total_debit::text AS dr, j.total_credit::text AS cr
           FROM finance_ar_invoices a JOIN finance_ar_customers cu ON cu.id = a.customer_id
           JOIN finance_journal_entries j ON j.id = a.journal_entry_id
          WHERE a.id = $1`, [out.arInvoiceId]);
      expect(ar).toMatchObject({ invoice_no: out.invoiceNo, status: "issued", client_id: clientA });
      expect(Number(ar.total)).toBe(2_500_000);
      expect(Number(ar.dr)).toBe(2_500_000);
      expect(ar.dr).toBe(ar.cr);
      expect(await reconcile(A)).toEqual([]);

      const evt = await row(`SELECT count(*)::int AS n FROM outbox_events WHERE entity_id = $1 AND event_type = 'invoice.issued'`, [id]);
      expect(evt.n).toBe(1);
      const rev = await row(`SELECT count(*)::int AS n FROM invoice_revisions WHERE invoice_id = $1 AND action = 'issued'`, [id]);
      expect(rev.n).toBe(1);

      const again = await issue(A, id);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ invoiceNo: out.invoiceNo, alreadyIssued: true });
      expect((await row(`SELECT count(*)::int AS n FROM finance_ar_invoices WHERE tenant_id = $1 AND invoice_no = $2`, [A, out.invoiceNo])).n).toBe(1);
    });

    it("two concurrent issues in one company get consecutive numbers", async () => {
      const [x, y] = [await approvedInvoice(A, clientA, 1000), await approvedInvoice(A, clientA, 2000)];
      const [rx, ry] = await Promise.all([issue(A, x), issue(A, y)]);
      expect([rx.statusCode, ry.statusCode]).toEqual([200, 200]);
      const nums = [rx.json().invoiceNo, ry.json().invoiceNo].map((n: string) => Number(n.split("/")[2])).sort((a, b) => a - b);
      expect(nums[1] - nums[0]).toBe(1);
    });

    it("a refused issue consumes no number: the series is gapless", async () => {
      // A hand-entered ledger invoice already holds the number the next issue would take, so that issue fails AFTER
      // taking it, and rolls back. Once the collision is gone, the next issue gets the SAME number.
      const taken = `GAP/${year}/0001`;
      const cust = newId();
      const arId = newId();
      await withTenants([C], async (c) => {
        await c.query(`INSERT INTO finance_ar_customers (id, tenant_id, code, name) VALUES ($1, $2, 'MANUAL', 'Manual customer')`, [cust, C]);
        await c.query(
          `INSERT INTO finance_ar_invoices (id, tenant_id, customer_id, invoice_no, invoice_date, due_date, currency_code, subtotal, tax_total, total)
           VALUES ($1, $2, $3, $4, current_date, current_date + 30, 'IDR', 10, 0, 10)`,
          [arId, C, cust, taken],
        );
      }, { modules: ["finance"] });
      const id = await approvedInvoice(C, clientC, 5000);
      const first = await issue(C, id);
      expect(first.statusCode, first.body).toBe(409);
      expect(await row(`SELECT status FROM invoices WHERE id = $1`, [id])).toEqual({ status: "approved" });

      await withTenants([C], (c) => c.query(`UPDATE finance_ar_invoices SET invoice_no = 'MANUAL-1' WHERE id = $1`, [arId]), { modules: ["finance"] });
      const second = await issue(C, id);
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json().invoiceNo).toBe(taken);
    });

    it("a taxed invoice is refused while the company's PKP status is unknown, and issued with tax from the code once it is recorded", async () => {
      await finance(A, `INSERT INTO finance_tax_codes (tenant_id, code, name, kind, rate, base_multiplier, effective_from)
                        VALUES ($1, 'PPN', 'PPN 12% on 11/12', 'ppn_output', 12, 0.9166666667, '2025-01-01')`, [A]);
      const id = await approvedInvoice(A, clientA, 1_000_000, { taxCode: "PPN" });
      const refused = await issue(A, id);
      expect(refused.statusCode).toBe(409);
      expect((refused.json() as { blockers: Array<{ code: string }> }).blockers.map((b) => b.code)).toContain("PKP_NOT_CONFIRMED");

      await finance(A, `UPDATE finance_company_settings SET is_pkp = true WHERE tenant_id = $1`, [A]);
      const ok = await issue(A, id);
      expect(ok.statusCode, ok.body).toBe(200);
      // 1,000,000 x 11/12 x 12% = 110,000 (not 120,000: the 11/12 base), rounded to whole rupiah.
      expect(Number(ok.json().taxTotal)).toBe(110_000);
      expect(Number(ok.json().total)).toBe(1_110_000);
      const vat = await row(
        `SELECT sum(l.amount)::text AS amt FROM finance_journal_lines l JOIN finance_accounts fa ON fa.id = l.account_id
          WHERE l.entry_id = (SELECT journal_entry_id FROM finance_ar_invoices WHERE id = $1) AND fa.code = '2140' AND l.side = 'credit'`,
        [ok.json().arInvoiceId]);
      expect(Number(vat.amt)).toBe(110_000);
      expect(await reconcile(A)).toEqual([]);
      await finance(A, `UPDATE finance_company_settings SET is_pkp = NULL WHERE tenant_id = $1`, [A]).catch(() => undefined);
    });

    it("the first issue to a GROUP client creates its AR customer with the counterparty company (decision 20)", async () => {
      const id = await approvedInvoice(A, groupClient, 7000);
      const res = await issue(A, id);
      expect(res.statusCode, res.body).toBe(200);
      const cu = await row(`SELECT counterparty_company_id FROM finance_ar_customers WHERE tenant_id = $1 AND client_id = $2`, [A, groupClient]);
      expect(cu.counterparty_company_id).toBe(sister);
    });
  });

  // ── PATCH can no longer reach sent or paid ────────────────────────────────────────────────────────
  describe("PATCH", () => {
    it("status=paid and status=sent answer 400; void on an ISSUED invoice answers 409 (use POST …/void)", async () => {
      const appr = await approvedInvoice(A, clientA, 1000);
      for (const status of ["paid", "sent"]) {
        const r = await app.inject({ method: "PATCH", url: `/api/${A}/invoices/${appr}`, headers: asUser(admin), payload: { status } });
        expect(r.statusCode).toBe(400);
      }
      const issued = (await createIssuedInvoice(A, { clientId: clientA, actorId: admin, lines: [{ description: "x", amount: 1000 }] })).id;
      const r = await app.inject({ method: "PATCH", url: `/api/${A}/invoices/${issued}`, headers: asUser(admin), payload: { status: "void" } });
      expect(r.statusCode).toBe(409);
      expect(await row(`SELECT status FROM invoices WHERE id = $1`, [issued])).toEqual({ status: "sent" });
    });
  });

  // ── payments post to the ledger ───────────────────────────────────────────────────────────────────
  describe("confirming a payment", () => {
    it("posts a receipt into the profile's bank account and allocates it; full payment flips BOTH rows to paid", async () => {
      const inv = await createIssuedInvoice(A, { clientId: clientA, actorId: admin, lines: [{ description: "x", amount: 500_000 }] });
      const p1 = await pendingPayment(A, inv.id, clientA, 200_000);
      const r1 = await decide(A, p1, "confirm");
      expect(r1.statusCode, r1.body).toBe(200);
      expect(r1.json()).toMatchObject({ invoicePaid: false });
      const rec = await row(
        `SELECT r.amount::text AS amount, fa.code, r.journal_entry_id FROM invoice_payments pp
           JOIN finance_ar_receipts r ON r.id = pp.ar_receipt_id JOIN finance_accounts fa ON fa.id = r.bank_account_id
          WHERE pp.id = $1`, [p1]);
      expect(rec).toMatchObject({ code: "1120" });
      expect(Number(rec.amount)).toBe(200_000);
      expect(rec.journal_entry_id).toBeTruthy();
      expect(await row(`SELECT amount_paid::text AS paid, status FROM finance_ar_invoices WHERE id = $1`, [inv.arInvoiceId])).toMatchObject({ status: "issued" });
      expect(await row(`SELECT status FROM invoices WHERE id = $1`, [inv.id])).toEqual({ status: "sent" });

      const p2 = await pendingPayment(A, inv.id, clientA, 300_000);
      const r2 = await decide(A, p2, "confirm");
      expect(r2.statusCode, r2.body).toBe(200);
      expect(r2.json()).toMatchObject({ invoicePaid: true });
      expect(await row(`SELECT status FROM finance_ar_invoices WHERE id = $1`, [inv.arInvoiceId])).toEqual({ status: "paid" });
      expect(await row(`SELECT status FROM invoices WHERE id = $1`, [inv.id])).toEqual({ status: "paid" });
      expect(await reconcile(A)).toEqual([]);
    });

    it("an overpaying confirmation is refused (409) and nothing is posted; a rejected claim posts nothing", async () => {
      const inv = await createIssuedInvoice(A, { clientId: clientA, actorId: admin, lines: [{ description: "x", amount: 100_000 }] });
      const over = await pendingPayment(A, inv.id, clientA, 150_000);
      const r = await decide(A, over, "confirm");
      expect(r.statusCode).toBe(409);
      expect(await row(`SELECT status, ar_receipt_id FROM invoice_payments WHERE id = $1`, [over])).toEqual({ status: "pending", ar_receipt_id: null });
      const rej = await decide(A, over, "reject", "Amount does not match the transfer");
      expect(rej.statusCode).toBe(200);
      expect(await row(`SELECT status, ar_receipt_id FROM invoice_payments WHERE id = $1`, [over])).toEqual({ status: "rejected", ar_receipt_id: null });
      expect(await row(`SELECT amount_paid::text AS paid FROM finance_ar_invoices WHERE id = $1`, [inv.arInvoiceId])).toEqual({ paid: "0.0000" });
    });

    it("a payment on an invoice that was never issued cannot be confirmed (409)", async () => {
      const appr = await approvedInvoice(A, clientA, 1000);
      const p = await pendingPayment(A, appr, clientA, 1000);
      expect((await decide(A, p, "confirm")).statusCode).toBe(409);
    });
  });

  // ── void after issue ──────────────────────────────────────────────────────────────────────────────
  describe("void after issue", () => {
    it("reverses in the ledger (a credit note for the full amount); both rows read void; reconciliation stays clean", async () => {
      const inv = await createIssuedInvoice(A, { clientId: clientA, actorId: admin, lines: [{ description: "x", amount: 400_000 }] });
      const noReason = await app.inject({ method: "POST", url: `/api/${A}/invoices/${inv.id}/void`, headers: asUser(admin), payload: {} });
      expect(noReason.statusCode).toBe(400);
      const byManager = await app.inject({ method: "POST", url: `/api/${A}/invoices/${inv.id}/void`, headers: asUser(manager), payload: { reason: "issued to the wrong client" } });
      expect(byManager.statusCode).toBe(403);

      const r = await app.inject({ method: "POST", url: `/api/${A}/invoices/${inv.id}/void`, headers: asUser(admin), payload: { reason: "issued to the wrong client" } });
      expect(r.statusCode, r.body).toBe(200);
      expect(await row(`SELECT status FROM invoices WHERE id = $1`, [inv.id])).toEqual({ status: "void" });
      expect(await row(`SELECT status FROM finance_ar_invoices WHERE id = $1`, [inv.arInvoiceId])).toEqual({ status: "void" });
      const cn = await row(`SELECT total::text AS total, status FROM finance_ar_credit_notes WHERE original_invoice_id = $1`, [inv.arInvoiceId]);
      expect(Number(cn.total)).toBe(400_000);
      expect(cn.status).toBe("applied");
      expect(await reconcile(A)).toEqual([]);

      const again = await app.inject({ method: "POST", url: `/api/${A}/invoices/${inv.id}/void`, headers: asUser(admin), payload: { reason: "issued to the wrong client" } });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ alreadyVoid: true });
    });

    it("a part-paid invoice cannot be voided (409): that is a credit note in Finance", async () => {
      const inv = await createIssuedInvoice(A, { clientId: clientA, actorId: admin, lines: [{ description: "x", amount: 300_000 }] });
      const p = await pendingPayment(A, inv.id, clientA, 100_000);
      expect((await decide(A, p, "confirm")).statusCode).toBe(200);
      const r = await app.inject({ method: "POST", url: `/api/${A}/invoices/${inv.id}/void`, headers: asUser(admin), payload: { reason: "client cancelled" } });
      expect(r.statusCode).toBe(409);
      expect(await row(`SELECT status FROM invoices WHERE id = $1`, [inv.id])).toEqual({ status: "sent" });
    });
  });

  // ── the portal: the invoice of record ─────────────────────────────────────────────────────────────
  describe("portal", () => {
    it("the portal shows the invoice of record (number, due date, issuer and bank, outstanding) and accepts a claim only while payable", async () => {
      const inv = await createIssuedInvoice(A, { clientId: clientA, actorId: admin, lines: [{ description: "Portal work", amount: 800_000 }] });
      const list = await app.inject({ method: "GET", url: `/api/${A}/portal/invoices`, headers: asUser(contact) });
      expect(list.statusCode).toBe(200);
      const mine = (list.json() as Array<Record<string, unknown>>).find((r) => r.id === inv.id)!;
      expect(mine).toMatchObject({ invoiceNo: inv.invoiceNo, dueDate: inv.dueDate, outstanding: 800_000, payable: true, overdue: false });

      const detail = await app.inject({ method: "GET", url: `/api/${A}/portal/invoices/${inv.id}`, headers: asUser(contact) });
      const d = detail.json() as Record<string, unknown>;
      expect(d).toMatchObject({ invoiceNo: inv.invoiceNo, payable: true, issuer: { legalName: "PV5-04 Agency A", bank: { accountNo: "0000000000" } } });
      expect(d).not.toHaveProperty("arInvoiceId");

      const today = new Date().toISOString().slice(0, 10);
      const tooMuch = await app.inject({ method: "POST", url: `/api/${A}/portal/invoices/${inv.id}/payments`, headers: asUser(contact), payload: { amount: 900_000, paidOn: today } });
      expect(tooMuch.statusCode).toBe(400);
      const claim = await app.inject({ method: "POST", url: `/api/${A}/portal/invoices/${inv.id}/payments`, headers: asUser(contact), payload: { amount: 800_000, paidOn: today } });
      expect(claim.statusCode, claim.body).toBe(201);
      // The whole outstanding amount is now being verified: no further claim, and no form.
      const after = (await app.inject({ method: "GET", url: `/api/${A}/portal/invoices/${inv.id}`, headers: asUser(contact) })).json();
      expect(after.payable).toBe(false);
    });

    it("overdue is by DUE date: an invoice issued 31 days ago on 30-day terms is overdue, today's is not", async () => {
      const old = await createIssuedInvoice(A, {
        clientId: clientA, actorId: admin, lines: [{ description: "Old work", amount: 1000 }],
        issueDate: new Date(Date.now() - 31 * 86_400_000).toISOString().slice(0, 10),
      });
      const list = (await app.inject({ method: "GET", url: `/api/${A}/portal/invoices`, headers: asUser(contact) })).json() as Array<{ id: string; overdue: boolean }>;
      expect(list.find((r) => r.id === old.id)?.overdue).toBe(true);
    });

    it("a client cannot claim a payment on a legacy-style unissued invoice (409)", async () => {
      const id = newId();
      // A `void` (never issued) invoice is client-visible; a claim on it is refused like any unissued invoice.
      await withTenants([A], (c) => c.query(
        `INSERT INTO invoices (id, tenant_id, client_id, status, currency, lines, total, origin_site) VALUES ($1, $2, $3, 'void', 'IDR', '[]', 10, 'test')`,
        [id, A, clientA]));
      const r = await app.inject({ method: "POST", url: `/api/${A}/portal/invoices/${id}/payments`, headers: asUser(contact), payload: { amount: 10, paidOn: new Date().toISOString().slice(0, 10) } });
      expect([400, 409]).toContain(r.statusCode);
    });
  });

  // ── the billing profile API ─────────────────────────────────────────────────────────────────────
  describe("billing profile", () => {
    const put = (who: string, payload: Record<string, unknown>) =>
      app.inject({ method: "PUT", url: `/api/${B}/billing-profile`, headers: asUser(who), payload });

    it("GET is 404 before one exists; a member cannot write it (403)", async () => {
      expect((await app.inject({ method: "GET", url: `/api/${B}/billing-profile`, headers: asUser(admin) })).statusCode).toBe(404);
      expect((await app.inject({ method: "PUT", url: `/api/${A}/billing-profile`, headers: asUser(member), payload: { legalName: "x" } })).statusCode).toBe(403);
    });

    it("company_admin creates and edits the profile but may NOT set the bank details (403); a bad prefix is a 400", async () => {
      const r = await put(admin, { legalName: "PT Example B", address: "Example street 1", invoicePrefix: "EXB", bankLedgerAccountCode: "1120", defaultRevenueAccountCode: "4100" });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ legalName: "PT Example B", invoicePrefix: "EXB", bank: null, defaultPaymentTermsDays: 30, currencyCode: "IDR" });
      expect((await put(admin, { invoicePrefix: "bad/prefix" })).statusCode).toBe(400);
      expect((await put(admin, { bank: { bankName: "Example Bank", accountName: "PT Example B", accountNo: "1234567890" } })).statusCode).toBe(403);
    });

    it("the finance manager sets the bank details; the change is recorded and EVERY owner is notified (PV-D26)", async () => {
      const r = await put(finMgr, { bank: { bankName: "Example Bank", accountName: "PT Example B", accountNo: "1234567890" } });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().bank).toEqual({ bankName: "Example Bank", accountName: "PT Example B", accountNo: "1234567890" });
      const act = await row(`SELECT count(*)::int AS n FROM activities WHERE tenant_id = $1 AND verb = 'bank_details_changed'`, [B]);
      expect(act.n).toBe(1);
      const note = await row(`SELECT payload FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND type = 'billing.bank_details_changed'`, [B, ownerB]);
      expect(note?.payload?.body).toMatch(/…7890/);
      expect(JSON.stringify(note.payload)).not.toContain("1234567890");
    });

    it("an owner may change the bank block alone (no finance_config update needed)", async () => {
      const r = await put(ownerB, { bank: { bankName: "Example Bank Two", accountName: "PT Example B", accountNo: "9876543210" } });
      expect(r.statusCode, r.body).toBe(200);
    });
  });
});
