// PV5-10 — online payment through the Midtrans hosted checkout, against a SIMULATED Midtrans (owner ruling 2026-10-13:
// no sandbox keys yet). Real HTTP surface (app.inject) against Postgres + RLS + Cerbos (the Linux gate; skips without
// DATABASE_URL_TEST, and a skipped run proves nothing). No test reaches the internet: the real Midtrans adapter is handed
// the in-process fake's fetch (testing/fake-midtrans.ts).
//
// TEETH (each proven in the PV5-10 hand-back by breaking the code and watching the named test fail):
//   (a) skip the status re-fetch (act on the notice's own transaction_status)   -> "the payload lies" fails (a payment is written);
//   (b) drop the amount comparison in process.ts writePayment                   -> "amount mismatch" fails;
//   (c) drop the dedupe claim's ON CONFLICT (answer 200 and process every time)  -> "a replayed notice" fails (500 / a second claim);
//   (d) skip signature verification in the webhook                               -> "a forged signature" fails;
//   (e) drop { modules: ["finance"] } from the portal checkout transaction       -> "checkout ... reuses it" fails (500, the
//       zero-row guard in loadOnlinePaymentFacts refuses to read an issued invoice without its ledger row).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../testing/fixtures";
import { markInvoicesLegacy } from "../testing/invoice-fixtures";
import { FakeMidtrans } from "../testing/fake-midtrans";
import { createIssuedInvoice, ensureBillingSetup, recordConfirmedPayment } from "../seed/billing-setup";
import { PROVIDER_PRINCIPALS, setPaymentFetchForTests } from "./registry";
import { loadOnlinePaymentFacts } from "./checkout";
import { paymentNoticeHandler, processPaymentEvent, sweepPaymentEvents } from "./process";

const KEY = "SB-Mid-server-DB-TEST-ONLY";
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const PRINCIPAL = PROVIDER_PRINCIPALS.midtrans;

describe.skipIf(!TEST_URL)("PV5-10 — online payment (simulated Midtrans)", () => {
  let app: NestFastifyApplication;
  let fake: FakeMidtrans;
  let A: string;         // the merchant company (owns the Midtrans account)
  let U: string;         // a company whose books are in USD
  let admin: string;
  let finMgr: string;
  let contact: string;   // client contact of clientA
  let outsider: string;  // client contact of clientB (same company, another client)
  let contactU: string;
  let clientA: string;
  let clientB: string;
  let clientU: string;
  let clearingAccountId: string;

  const row = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await adminPool().query(sql, args)).rows[0] as T;
  const rows = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await adminPool().query(sql, args)).rows as T[];
  const count = async (sql: string, args: unknown[] = []) => Number((await row<{ n: string }>(sql, args)).n);

  const issued = (amount: number, client = clientA, t = A, currency?: string) =>
    createIssuedInvoice(t, { clientId: client, actorId: admin, lines: [{ description: "Design work", amount }], currency });
  const checkout = (invoiceId: string, who = contact, t = A) =>
    app.inject({ method: "POST", url: `/api/${t}/portal/invoices/${invoiceId}/checkout`, headers: asUser(who), payload: {} });
  const detail = (invoiceId: string, who = contact, t = A) =>
    app.inject({ method: "GET", url: `/api/${t}/portal/invoices/${invoiceId}`, headers: asUser(who) });
  const webhook = (body: unknown, provider = "midtrans") =>
    app.inject({ method: "POST", url: `/api/webhooks/payments/${provider}`, payload: body as Record<string, unknown> });
  const orderOf = async (invoiceId: string) =>
    (await row<{ ref: string }>(`SELECT provider_checkout_id AS ref FROM payment_checkouts WHERE invoice_id = $1 AND status = 'open'`, [invoiceId])).ref;
  const claimOf = async (eventKey: string) =>
    row<{ id: string; status: string; error: string | null; attempts: number; last_error: string | null; notice: Record<string, string>; outcome: string | null }>(
      `SELECT id, status, error, attempts, last_error, notice, outcome FROM provider_events WHERE provider = 'midtrans' AND event_id = $1`, [eventKey]);
  const paymentsOn = (invoiceId: string) =>
    rows<{ id: string; source: string; method: string; status: string; amount: string; recorded_by: string; confirmed_by: string; provider_payment_id: string; ar_receipt_id: string | null }>(
      `SELECT id, source, method, status, amount::text AS amount, recorded_by, confirmed_by, provider_payment_id, ar_receipt_id
         FROM invoice_payments WHERE invoice_id = $1 ORDER BY created_at`, [invoiceId]);

  /** Open a checkout for a fresh issued invoice and return what a test needs. */
  async function openCheckout(amount = 150_000) {
    const inv = await issued(amount);
    const r = await checkout(inv.id);
    expect(r.statusCode, r.body).toBe(200);
    return { inv, order: await orderOf(inv.id), body: r.json() as { checkoutUrl: string; amount: string; reused: boolean } };
  }
  /** Deliver a notice and process its claim, as the consumer would. */
  async function deliver(body: Record<string, string>) {
    const r = await webhook(body);
    expect(r.statusCode, r.body).toBe(200);
    const key = `${body.order_id}:${body.transaction_status}:${body.status_code}`;
    const claim = await claimOf(key);
    const outcome = await processPaymentEvent(A, claim.id);
    return { r, claim, outcome };
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    A = await createCompany("PV5-10 Merchant Co", ["invoice", "clients"]);
    U = await createCompany("PV5-10 Dollar Books Co", ["invoice", "clients"]);
    admin = await createUser("admin@pv510.test");
    finMgr = await createUser("finmgr@pv510.test");
    contact = await createUser("contact@pv510-client.test");
    outsider = await createUser("outsider@pv510-client.test");
    contactU = await createUser("contact-u@pv510-client.test");
    const companyAdmin = await createRole("company_admin");
    const clientRole = await createRole("client");
    for (const t of [A, U]) {
      await addMembership(t, admin);
      await grantRole(admin, companyAdmin, "company", t);
    }
    await addMembership(A, finMgr);
    await grantRole(finMgr, await createRole("finance_manager"), "company", A);

    clientA = await createClient(A, "PV5-10 Client A");
    clientB = await createClient(A, "PV5-10 Client B");
    clientU = await createClient(U, "PV5-10 Client U");
    const addContact = (t: string, client: string, user: string) =>
      withTenants([t], (c) => c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site)
         VALUES ($1, $2, $3, $4, NULL, 'viewer', 'active', now(), 'test')`,
        [newId(), t, client, user]));
    await addContact(A, clientA, contact);
    await addContact(A, clientB, outsider);
    await addContact(U, clientU, contactU);
    await grantRole(contact, clientRole, "company", A);
    await grantRole(outsider, clientRole, "company", A);
    await grantRole(contactU, clientRole, "company", U);

    await ensureBillingSetup(A, { prefix: "PAY" });
    // The gateway clearing account Finance creates (data, never a code in code) and names in the billing profile.
    clearingAccountId = await withTenants([A], async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO finance_accounts (tenant_id, code, name, account_type, normal_balance, is_postable, is_control, allow_manual_posting)
         VALUES ($1, '1125', 'Payment gateway clearing (test)', 'asset', 'debit', true, false, true) RETURNING id`, [A]);
      await c.query(`UPDATE company_billing_profiles SET gateway_clearing_account_code = '1125' WHERE tenant_id = $1`, [A]);
      return r.rows[0].id;
    }, { modules: ["finance"] });
    // U keeps its books in USD (so a USD invoice can be issued there at all).
    await withTenants([U], (c) => c.query(
      `INSERT INTO finance_company_settings (tenant_id, functional_currency, presentation_currency, fiscal_year_start_month)
       VALUES ($1, 'USD', 'USD', 1)`, [U]), { modules: ["finance"] });
    await ensureBillingSetup(U, { prefix: "USB" });

    fake = new FakeMidtrans(KEY);
    setPaymentFetchForTests(fake.fetch);
    config.payments.midtrans = { serverKey: KEY, environment: "sandbox", tenantId: A };
    app = await buildApp();
  }, 180_000);
  afterAll(async () => {
    setPaymentFetchForTests(null);
    config.payments.midtrans = { serverKey: "", environment: "", tenantId: "" };
    await app?.close();
    await teardownTestDb();
  });
  beforeEach(() => {
    config.payments.midtrans = { serverKey: KEY, environment: "sandbox", tenantId: A };
  });

  // ── off unless configured ─────────────────────────────────────────────────────────────────────────
  describe("switched off", () => {
    it("with no server key: the flag says not offered, checkout is 404, the webhook is 404, and nothing is written", async () => {
      const inv = await issued(100_000);
      config.payments.midtrans = { serverKey: "", environment: "", tenantId: A };
      const d = await detail(inv.id);
      expect(d.statusCode, d.body).toBe(200);
      expect(d.json().onlinePayment).toEqual({ available: false, reason: "not_offered", message: expect.any(String) });
      expect((await checkout(inv.id)).statusCode).toBe(404);
      const events = await count(`SELECT count(*) FROM provider_events`);
      const w = await webhook(fake.notice("ck-anything", { transactionStatus: "settlement", grossAmount: "100000.00" }));
      expect(w.statusCode).toBe(404);
      expect(await count(`SELECT count(*) FROM provider_events`)).toBe(events);
      expect(await count(`SELECT count(*) FROM payment_checkouts WHERE invoice_id = $1`, [inv.id])).toBe(0);
    });

    it("an unknown provider is 404 even when Midtrans is on", async () => {
      expect((await webhook({}, "stripe")).statusCode).toBe(404);
    });

    it("another company's invoices are not offered through this company's merchant account", async () => {
      config.payments.midtrans = { serverKey: KEY, environment: "sandbox", tenantId: U };
      const inv = await issued(100_000);
      expect((await detail(inv.id)).json().onlinePayment).toMatchObject({ available: false, reason: "not_offered" });
      expect((await checkout(inv.id)).statusCode).toBe(404);
    });
  });

  // ── the checkout ──────────────────────────────────────────────────────────────────────────────────
  describe("checkout", () => {
    it("opens ONE checkout for the outstanding balance, with a minted order id (never the invoice number), and reuses it", async () => {
      const inv = await issued(150_000);
      expect((await detail(inv.id)).json().onlinePayment).toEqual({ available: true, amount: 150_000, currency: "IDR" });
      const before = fake.snapCreates().length;
      const r1 = await checkout(inv.id);
      expect(r1.statusCode, r1.body).toBe(200);
      const b1 = r1.json();
      expect(b1.checkoutUrl).toMatch(/^https:\/\/app\.sandbox\.midtrans\.com\/snap\//);
      expect(Number(b1.amount)).toBe(150_000);
      expect(b1.currency).toBe("IDR");
      expect(b1.reused).toBe(false);
      const ck = await row<{ ref: string; amount: string; status: string; created_by: string }>(
        `SELECT provider_checkout_id AS ref, amount::text AS amount, status, created_by FROM payment_checkouts WHERE invoice_id = $1`, [inv.id]);
      expect(ck.ref).toMatch(/^ck-[0-9a-f]{32}$/);
      expect(ck.ref).not.toContain(inv.invoiceNo);
      expect(Number(ck.amount)).toBe(150_000);
      expect(ck.created_by).toBe(contact);
      const sent = fake.snapCreates()[before];
      expect(sent.body).toMatchObject({ transaction_details: { order_id: ck.ref, gross_amount: 150000 } });

      const r2 = await checkout(inv.id);
      expect(r2.statusCode).toBe(200);
      expect(r2.json()).toMatchObject({ checkoutUrl: b1.checkoutUrl, reused: true });
      expect(fake.snapCreates().length).toBe(before + 1);
      expect(await count(`SELECT count(*) FROM payment_checkouts WHERE invoice_id = $1`, [inv.id])).toBe(1);
    });

    it("charges only what is not already being verified, and mints a new checkout when that amount changes", async () => {
      const inv = await issued(300_000);
      const first = (await checkout(inv.id)).json();
      // The client then tells us about a 100,000 transfer: the online amount drops to 200,000.
      await withTenants([A], (c) => c.query(
        `INSERT INTO invoice_payments (id, tenant_id, invoice_id, client_id, amount, currency, paid_on, status, recorded_by, origin_site, source)
         VALUES ($1, $2, $3, $4, 100000, 'IDR', current_date, 'pending', $5, 'test', 'client_claim')`,
        [newId(), A, inv.id, clientA, contact]));
      const second = await checkout(inv.id);
      expect(second.statusCode, second.body).toBe(200);
      expect(Number(second.json().amount)).toBe(200_000);
      expect(second.json().checkoutUrl).not.toBe(first.checkoutUrl);
      const all = await rows<{ status: string; amount: string }>(
        `SELECT status, amount::text AS amount FROM payment_checkouts WHERE invoice_id = $1 ORDER BY created_at`, [inv.id]);
      expect(all.map((x) => [x.status, Number(x.amount)])).toEqual([["expired", 300_000], ["open", 200_000]]);
    });

    it("refuses an invoice that was never issued (409 not_issued)", async () => {
      const id = newId();
      await adminPool().query(
        `INSERT INTO invoices (id, tenant_id, client_id, period_start, period_end, status, currency, lines, total, origin_site)
         VALUES ($1, $2, $3, current_date - 30, current_date - 1, 'void', 'IDR', '[]', 1000, 'test')`, [id, A, clientA]);
      await markInvoicesLegacy([id]); // a pre-PV-5 row: portal-visible, never issued
      const r = await checkout(id);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().reason).toBe("not_issued");
      expect((await detail(id)).json().onlinePayment).toMatchObject({ available: false, reason: "not_issued" });
    });

    it("refuses an invoice that is not in rupiah (409 not_idr)", async () => {
      config.payments.midtrans = { serverKey: KEY, environment: "sandbox", tenantId: U };
      const inv = await issued(100.5, clientU, U, "USD");
      const r = await checkout(inv.id, contactU, U);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().reason).toBe("not_idr");
      expect(await count(`SELECT count(*) FROM payment_checkouts WHERE invoice_id = $1`, [inv.id])).toBe(0);
    });

    it("refuses an invoice with nothing outstanding (409 nothing_outstanding)", async () => {
      const inv = await issued(50_000);
      await recordConfirmedPayment(A, inv.id, { recordedBy: admin, confirmedBy: admin });
      const r = await checkout(inv.id);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().reason).toBe("nothing_outstanding");
    });

    it("refuses a balance that is not a whole number of rupiah, never rounding it (409 fractional_amount)", async () => {
      const inv = await issued(200_000);
      // Half a rupiah written off in the ledger (superuser: a state no portal path can produce, but the books can).
      await adminPool().query(`UPDATE finance_ar_invoices SET amount_written_off = 0.5 WHERE id = $1`, [inv.arInvoiceId]);
      const r = await checkout(inv.id);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().reason).toBe("fractional_amount");
      expect(fake.snapCreates().some((c) => (c.body as { transaction_details?: { gross_amount?: number } })?.transaction_details?.gross_amount === 199_999)).toBe(false);
    });

    it("refuses while the whole balance is being verified, and while Finance has not set the clearing account", async () => {
      const inv = await issued(80_000);
      await withTenants([A], (c) => c.query(
        `INSERT INTO invoice_payments (id, tenant_id, invoice_id, client_id, amount, currency, paid_on, status, recorded_by, origin_site, source)
         VALUES ($1, $2, $3, $4, 80000, 'IDR', current_date, 'pending', $5, 'test', 'client_claim')`,
        [newId(), A, inv.id, clientA, contact]));
      expect((await checkout(inv.id)).json().reason).toBe("payment_being_verified");

      const inv2 = await issued(80_000);
      await adminPool().query(`UPDATE company_billing_profiles SET gateway_clearing_account_code = NULL WHERE tenant_id = $1`, [A]);
      try {
        const r = await checkout(inv2.id);
        expect(r.statusCode).toBe(409);
        expect(r.json().reason).toBe("not_ready");
      } finally {
        await adminPool().query(`UPDATE company_billing_profiles SET gateway_clearing_account_code = '1125' WHERE tenant_id = $1`, [A]);
      }
    });

    it("a contact outside the invoice's scope gets 404 (never 403) and nothing is written", async () => {
      const inv = await issued(70_000);
      const before = fake.snapCreates().length;
      const r = await checkout(inv.id, outsider);
      expect(r.statusCode).toBe(404);
      expect(fake.snapCreates().length).toBe(before);
      expect(await count(`SELECT count(*) FROM payment_checkouts WHERE invoice_id = $1`, [inv.id])).toBe(0);
      expect((await detail(inv.id, outsider)).statusCode).toBe(404);
    });

    it("staff without the portal `pay` action are refused before anything is read (403)", async () => {
      const inv = await issued(70_000);
      expect((await checkout(inv.id, finMgr)).statusCode).toBe(403);
    });

    it("the provider being down is a 503 that says so, and leaves no checkout behind", async () => {
      const inv = await issued(60_000);
      fake.snapFailure = 503;
      const r = await checkout(inv.id);
      expect(r.statusCode).toBe(503);
      expect(r.json().reason).toBe("provider_unavailable");
      expect(await count(`SELECT count(*) FROM payment_checkouts WHERE invoice_id = $1`, [inv.id])).toBe(0);
    });

    it("the zero-row trap cannot hide the ledger: without the finance scope the facts refuse to read, never say 'nothing to pay'", async () => {
      const inv = await issued(40_000);
      await expect(withTenants([A], (c) => loadOnlinePaymentFacts(c, inv.id))).rejects.toThrow(/finance module scope/);
      const scoped = await withTenants([A], (c) => loadOnlinePaymentFacts(c, inv.id), { modules: ["finance"] });
      expect(scoped).toMatchObject({ issued: true, outstandingPositive: true, whole: true, clearingReady: true });
    });
  });

  // ── the webhook and the processing ────────────────────────────────────────────────────────────────
  describe("webhook", () => {
    it("a forged signature is 401 and writes nothing", async () => {
      const { inv, order } = await openCheckout();
      fake.settle(order, "txn-forged");
      const events = await count(`SELECT count(*) FROM provider_events`);
      const forged = { ...fake.notice(order, { transactionStatus: "settlement", transactionId: "txn-forged" }) };
      forged.signature_key = forged.signature_key.replace(/^./, (ch) => (ch === "a" ? "b" : "a"));
      expect((await webhook(forged)).statusCode).toBe(401);
      const wrongKey = new FakeMidtrans("not-our-key").notice(order, { transactionStatus: "settlement", grossAmount: "150000.00" });
      expect((await webhook(wrongKey)).statusCode).toBe(401);
      const unsigned: Record<string, string> = { ...fake.notice(order, { transactionStatus: "settlement" }) };
      delete unsigned.signature_key;
      expect((await webhook(unsigned)).statusCode).toBe(401);
      expect(await count(`SELECT count(*) FROM provider_events`)).toBe(events);
      expect(await paymentsOn(inv.id)).toEqual([]);
      expect((await row<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [inv.id])).status).toBe("sent");
    });

    it("a good notice confirms, posts into the clearing account and allocates, exactly once, as the provider's principal", async () => {
      const { inv, order } = await openCheckout(150_000);
      fake.settle(order, "txn-good-1");
      const body = fake.notice(order, { transactionStatus: "settlement", transactionId: "txn-good-1" });
      const { r, claim, outcome } = await deliver(body);
      expect(r.json()).toEqual({ ok: true });
      expect(claim.status).toBe("received");
      expect(claim.notice).toMatchObject({ order_id: order, transaction_status: "settlement", gross_amount: "150000.00" });
      expect(claim.notice).not.toHaveProperty("masked_card");
      // The claim and its job were written together (the outbox row the consumer would read).
      expect(await count(`SELECT count(*) FROM outbox_events WHERE entity_type = 'provider_event' AND entity_id = $1 AND event_type = 'payment.notice.received'`, [claim.id])).toBe(1);
      expect(outcome.status).toBe("paid");
      // The provider's status API was asked, about this order.
      expect(fake.statusChecks(order).length).toBeGreaterThanOrEqual(1);

      const pays = await paymentsOn(inv.id);
      expect(pays).toHaveLength(1);
      expect(pays[0]).toMatchObject({
        source: "gateway", method: "online", status: "confirmed", recorded_by: PRINCIPAL, confirmed_by: PRINCIPAL,
        provider_payment_id: "txn-good-1",
      });
      expect(Number(pays[0].amount)).toBe(150_000);
      const receipt = await row<{ bank_account_id: string; amount: string; journal_entry_id: string | null }>(
        `SELECT bank_account_id, amount::text AS amount, journal_entry_id FROM finance_ar_receipts WHERE id = $1`, [pays[0].ar_receipt_id]);
      expect(receipt.bank_account_id).toBe(clearingAccountId);
      expect(Number(receipt.amount)).toBe(150_000);
      expect(receipt.journal_entry_id).not.toBeNull();
      const allocs = await rows<{ amount: string }>(`SELECT amount::text AS amount FROM finance_ar_allocations WHERE receipt_id = $1`, [pays[0].ar_receipt_id]);
      expect(allocs.map((a) => Number(a.amount))).toEqual([150_000]);
      expect((await row<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [inv.id])).status).toBe("paid");
      expect((await row<{ status: string }>(`SELECT status FROM finance_ar_invoices WHERE id = $1`, [inv.arInvoiceId])).status).toBe("paid");
      expect((await row<{ status: string }>(`SELECT status FROM payment_checkouts WHERE provider_checkout_id = $1`, [order])).status).toBe("paid");
      expect((await claimOf(`${order}:settlement:200`)).status).toBe("processed");
      expect(await count(`SELECT count(*) FROM outbox_events WHERE event_type = 'invoice.payment.confirmed' AND entity_id = $1`, [pays[0].id])).toBe(1);
      // The client and Finance are told.
      expect(await count(`SELECT count(*) FROM notifications WHERE user_id = $1 AND type = 'invoice.payment.confirmed' AND payload->>'entityId' = $2`, [contact, inv.id])).toBe(1);
      expect(await count(`SELECT count(*) FROM notifications WHERE user_id = $1 AND type = 'invoice.payment.received_online'`, [finMgr])).toBeGreaterThanOrEqual(1);
      // The books still reconcile.
      expect(await withTenants([A], (c) => c.query(`SELECT problem FROM finance_ar_reconcile($1, NULL)`, [A]), { modules: ["finance"] }).then((x) => x.rows)).toEqual([]);

      // Processing the same claim again does nothing.
      expect((await processPaymentEvent(A, claim.id)).status).toBe("skipped");
      expect(await paymentsOn(inv.id)).toHaveLength(1);
    });

    it("a replayed notice is processed once (200 duplicate), and a replay with a changed unsigned status writes nothing more", async () => {
      const { inv, order } = await openCheckout(120_000);
      fake.settle(order, "txn-replay");
      const body = fake.notice(order, { transactionStatus: "settlement", transactionId: "txn-replay" });
      await deliver(body);
      const events = await count(`SELECT count(*) FROM provider_events`);
      const again = await webhook(body);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual({ ok: true, duplicate: true });
      expect(await count(`SELECT count(*) FROM provider_events`)).toBe(events);
      // transaction_status is not signed: a replay may carry another word. It claims a new key, the re-fetch finds the
      // payment already recorded, and nothing more is written.
      const variant = { ...body, transaction_status: "capture", fraud_status: "accept" };
      const v = await webhook(variant);
      expect(v.statusCode).toBe(200);
      const vc = await claimOf(`${order}:capture:200`);
      expect((await processPaymentEvent(A, vc.id)).status).toBe("processed");
      expect((await claimOf(`${order}:capture:200`)).outcome).toMatch(/already recorded/);
      expect(await paymentsOn(inv.id)).toHaveLength(1);
      expect(await count(`SELECT count(*) FROM finance_ar_receipts r JOIN invoice_payments p ON p.ar_receipt_id = r.id WHERE p.invoice_id = $1`, [inv.id])).toBe(1);
    });

    it("the payload lies: it says settlement, the status API says pending -> no payment, and it keeps re-checking", async () => {
      const { inv, order } = await openCheckout(90_000);
      fake.setStatus(order, { transactionStatus: "pending", transactionId: "txn-lie" });
      const { outcome } = await deliver(fake.notice(order, { transactionStatus: "settlement", transactionId: "txn-lie" }));
      expect(outcome.status).toBe("retry");
      expect(await paymentsOn(inv.id)).toEqual([]);
      expect((await row<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [inv.id])).status).toBe("sent");
      const claim = await claimOf(`${order}:settlement:200`);
      expect(claim).toMatchObject({ status: "received", attempts: 1 });
      expect(claim.last_error).toMatch(/provider's status is pending/);
      expect((await row<{ status: string }>(`SELECT status FROM payment_checkouts WHERE provider_checkout_id = $1`, [order])).status).toBe("open");
    });

    it("an amount mismatch is ignored with the reason, writes no payment, and Finance is told", async () => {
      const { inv, order } = await openCheckout(150_000);
      // The provider reports a different amount than the checkout asked for.
      fake.settle(order, "txn-mismatch", { grossAmount: "100000.00" });
      const finBefore = await count(`SELECT count(*) FROM notifications WHERE user_id = $1 AND type = 'payment.online.needs_attention'`, [finMgr]);
      const { outcome } = await deliver(fake.notice(order, { transactionStatus: "settlement", transactionId: "txn-mismatch", grossAmount: "100000.00" }));
      expect(outcome).toMatchObject({ status: "ignored", reason: "amount_mismatch" });
      const claim = await claimOf(`${order}:settlement:200`);
      expect(claim).toMatchObject({ status: "ignored", error: "amount_mismatch" });
      expect(await paymentsOn(inv.id)).toEqual([]);
      expect((await row<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [inv.id])).status).toBe("sent");
      expect(await count(`SELECT count(*) FROM notifications WHERE user_id = $1 AND type = 'payment.online.needs_attention'`, [finMgr])).toBe(finBefore + 1);
    });

    it("out of order: settlement first, then pending -> paid once, and the pending notice does not undo it", async () => {
      const { inv, order } = await openCheckout(110_000);
      fake.settle(order, "txn-ooo");
      const first = await deliver(fake.notice(order, { transactionStatus: "settlement", transactionId: "txn-ooo" }));
      expect(first.outcome.status).toBe("paid");
      const late = await deliver(fake.notice(order, { transactionStatus: "pending", transactionId: "txn-ooo" }));
      expect(late.outcome.status).toBe("processed");
      expect(await paymentsOn(inv.id)).toHaveLength(1);
      expect((await row<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [inv.id])).status).toBe("paid");
      expect((await row<{ status: string }>(`SELECT status FROM payment_checkouts WHERE provider_checkout_id = $1`, [order])).status).toBe("paid");
    });

    it("in order: pending (nothing to do), then settlement -> paid once", async () => {
      const { inv, order } = await openCheckout(130_000);
      fake.setStatus(order, { transactionStatus: "pending", transactionId: "txn-io" });
      const p = await deliver(fake.notice(order, { transactionStatus: "pending", transactionId: "txn-io" }));
      expect(p.outcome).toMatchObject({ status: "processed" });
      expect(await paymentsOn(inv.id)).toEqual([]);
      fake.settle(order, "txn-io");
      const s = await deliver(fake.notice(order, { transactionStatus: "settlement", transactionId: "txn-io" }));
      expect(s.outcome.status).toBe("paid");
      expect(await paymentsOn(inv.id)).toHaveLength(1);
    });

    it("a notice for an order that is no checkout of ours is ignored (unknown_checkout)", async () => {
      fake.setStatus("ck-not-ours-0001", { grossAmount: "75000.00" });
      fake.settle("ck-not-ours-0001", "txn-stranger");
      const { outcome } = await deliver(fake.notice("ck-not-ours-0001", { transactionStatus: "settlement", transactionId: "txn-stranger" }));
      expect(outcome).toMatchObject({ status: "ignored", reason: "unknown_checkout" });
      expect(await count(`SELECT count(*) FROM invoice_payments WHERE provider_payment_id = 'txn-stranger'`)).toBe(0);
    });

    it("a payment for an invoice voided meanwhile is ignored (invoice_void), never posted", async () => {
      const { inv, order } = await openCheckout(140_000);
      const v = await app.inject({ method: "POST", url: `/api/${A}/invoices/${inv.id}/void`, headers: asUser(admin), payload: { reason: "issued in error" } });
      expect(v.statusCode, v.body).toBe(200);
      fake.settle(order, "txn-void");
      const { outcome } = await deliver(fake.notice(order, { transactionStatus: "settlement", transactionId: "txn-void" }));
      expect(outcome).toMatchObject({ status: "ignored", reason: "invoice_void" });
      expect(await paymentsOn(inv.id)).toEqual([]);
    });

    it("a provider outage during the re-fetch is retried later; a missing clearing account waits and Finance is told once", async () => {
      const { inv, order } = await openCheckout(100_000);
      fake.settle(order, "txn-later");
      fake.statusFailure = 503;
      const { claim, outcome } = await deliver(fake.notice(order, { transactionStatus: "settlement", transactionId: "txn-later" }));
      expect(outcome.status).toBe("retry");
      expect(await paymentsOn(inv.id)).toEqual([]);

      await adminPool().query(`UPDATE company_billing_profiles SET gateway_clearing_account_code = NULL WHERE tenant_id = $1`, [A]);
      try {
        const second = await processPaymentEvent(A, claim.id);
        expect(second.status).toBe("retry");
        expect(await paymentsOn(inv.id)).toEqual([]);
        const told = await count(`SELECT count(*) FROM notifications WHERE user_id = $1 AND type = 'payment.online.needs_attention' AND payload->>'entityId' = $2`, [finMgr, claim.id]);
        expect(told).toBe(1);
        expect((await processPaymentEvent(A, claim.id)).status).toBe("retry");
        expect(await count(`SELECT count(*) FROM notifications WHERE user_id = $1 AND type = 'payment.online.needs_attention' AND payload->>'entityId' = $2`, [finMgr, claim.id])).toBe(1);
      } finally {
        await adminPool().query(`UPDATE company_billing_profiles SET gateway_clearing_account_code = '1125' WHERE tenant_id = $1`, [A]);
      }
      // Fixed: the sweep (the path that works with Redis off) records it, once.
      await adminPool().query(`UPDATE provider_events SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [claim.id]);
      const swept = await sweepPaymentEvents({ ignoreGrace: true });
      expect(swept.some((o) => o.status === "paid")).toBe(true);
      expect(await paymentsOn(inv.id)).toHaveLength(1);
    });

    it("the outbox handler runs the same processor (the consumer path)", async () => {
      const { inv, order } = await openCheckout(95_000);
      fake.settle(order, "txn-handler");
      const r = await webhook(fake.notice(order, { transactionStatus: "settlement", transactionId: "txn-handler" }));
      expect(r.statusCode).toBe(200);
      const claim = await claimOf(`${order}:settlement:200`);
      const ev = await row<{ id: string; tenant_id: string; entity_type: string; entity_id: string; event_type: string; payload: Record<string, unknown> }>(
        `SELECT id, tenant_id, entity_type, entity_id, event_type, payload FROM outbox_events WHERE entity_id = $1`, [claim.id]);
      await paymentNoticeHandler({
        id: ev.id, tenantId: ev.tenant_id, entityType: ev.entity_type, entityId: ev.entity_id, eventType: ev.event_type,
        payload: ev.payload, originSite: "test", schemaVersion: 1, createdAt: new Date().toISOString(),
      });
      expect(await paymentsOn(inv.id)).toHaveLength(1);
    });
  });
});
