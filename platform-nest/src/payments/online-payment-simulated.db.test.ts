// PV-D41 — the SIMULATED Midtrans, end to end over real HTTP: the app LISTENS on loopback, the REAL Midtrans adapter
// calls the in-process simulator there (no fetch override), the simulated page's action makes the simulator DELIVER a
// signed notice to our own webhook over HTTP, and the normal path (claim, status re-fetch from the simulator, posting)
// records the payment. Postgres + RLS + Cerbos (the Linux gate; skips without DATABASE_URL_TEST).
//
// The one stand-in: the Redis consumer is not running in the test harness, so a claimed notice is processed by calling
// processPaymentEvent (exactly what the consumer's handler and the sweep call).
//
// TEETH (proven on the gate, see the hand-back):
//   (a) the webhook skips signature verification in simulated mode   -> "a forged notice is still 401" fails;
//   (b) the portal routes skip the portal-scope predicate            -> "another client's contact gets 404" fails.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../testing/fixtures";
import { createIssuedInvoice, ensureBillingSetup } from "../seed/billing-setup";
import { describePaymentsConfig, setPaymentFetchForTests } from "./registry";
import { processPaymentEvent } from "./process";
import { simGetOrder, simNoticeBody } from "./simulator";

const KEY = "SIM-db-test-only";
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("PV-D41 — online payment against the simulated Midtrans", () => {
  let app: NestFastifyApplication;
  let base: string;
  let A: string;
  let admin: string;
  let finMgr: string;
  let contact: string;
  let outsider: string;
  let clientA: string;
  let clientB: string;

  const row = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await adminPool().query(sql, args)).rows[0] as T;
  const count = async (sql: string, args: unknown[] = []) => Number(Object.values(await row<Record<string, unknown>>(sql, args))[0]);
  const on = () => {
    config.payments.simulationEnabled = true;
    config.payments.midtrans = { serverKey: KEY, environment: "simulated", tenantId: A };
    config.payments.simulatorInternalUrl = base;
  };
  const off = () => {
    config.payments.simulationEnabled = false;
    config.payments.midtrans = { serverKey: "", environment: "", tenantId: "" };
  };

  const issued = (amount: number) =>
    createIssuedInvoice(A, { clientId: clientA, actorId: admin, lines: [{ description: "Design work", amount }] });
  const checkout = (invoiceId: string, who = contact) =>
    app.inject({ method: "POST", url: `/api/${A}/portal/invoices/${invoiceId}/checkout`, headers: asUser(who), payload: {} });
  const page = (orderId: string, who = contact) =>
    app.inject({ method: "GET", url: `/api/${A}/portal/payments/simulated/${orderId}`, headers: asUser(who) });
  const act = (orderId: string, action: string, who = contact) =>
    app.inject({ method: "POST", url: `/api/${A}/portal/payments/simulated/${orderId}/act`, headers: asUser(who), payload: { action } });
  const paymentsOn = (invoiceId: string) =>
    adminPool().query<{ id: string; reference: string; note: string | null; ar_receipt_id: string; checkout_id: string }>(
      `SELECT id, reference, note, ar_receipt_id, checkout_id FROM invoice_payments WHERE invoice_id = $1`, [invoiceId]).then((r) => r.rows);

  /** Wait (bounded) until the simulator's notice has been claimed by our webhook, then process it as the consumer would. */
  async function claimed(orderId: string, status: string) {
    for (let i = 0; i < 100; i++) {
      const r = await adminPool().query<{ id: string }>(
        `SELECT id FROM provider_events WHERE provider = 'midtrans' AND ref = $1 AND notice->>'transaction_status' = $2`, [orderId, status]);
      if (r.rows[0]) return r.rows[0].id;
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error(`no ${status} notice for ${orderId} was delivered`);
  }

  /** Open a simulated checkout for a fresh invoice; answer the order id. */
  async function openSimulated(amount = 150_000) {
    const inv = await issued(amount);
    const r = await checkout(inv.id);
    expect(r.statusCode, r.body).toBe(200);
    const url = r.json().checkoutUrl as string;
    expect(url).toMatch(/^\/portal\/pay\/simulated\/ck-[0-9a-f]{32}$/);
    return { inv, orderId: url.split("/").pop() as string };
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    A = await createCompany("PV-D41 Merchant Co", ["invoice", "clients"]);
    admin = await createUser("admin@pvd41.test");
    finMgr = await createUser("finmgr@pvd41.test");
    contact = await createUser("contact@pvd41-client.test");
    outsider = await createUser("outsider@pvd41-client.test");
    await addMembership(A, admin);
    await grantRole(admin, await createRole("company_admin"), "company", A);
    await addMembership(A, finMgr);
    await grantRole(finMgr, await createRole("finance_manager"), "company", A);
    clientA = await createClient(A, "PV-D41 Client A");
    clientB = await createClient(A, "PV-D41 Client B");
    const clientRole = await createRole("client");
    for (const [user, client] of [[contact, clientA], [outsider, clientB]] as const) {
      await withTenants([A], (c) => c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site)
         VALUES ($1, $2, $3, $4, NULL, 'viewer', 'active', now(), 'test')`, [newId(), A, client, user]));
      await grantRole(user, clientRole, "company", A);
    }
    await ensureBillingSetup(A, { prefix: "SIM" });
    await withTenants([A], async (c) => {
      await c.query(
        `INSERT INTO finance_accounts (tenant_id, code, name, account_type, normal_balance, is_postable, is_control, allow_manual_posting)
         VALUES ($1, '1125', 'Payment gateway clearing (test)', 'asset', 'debit', true, false, true)`, [A]);
      await c.query(`UPDATE company_billing_profiles SET gateway_clearing_account_code = '1125' WHERE tenant_id = $1`, [A]);
    }, { modules: ["finance"] });

    setPaymentFetchForTests(null); // the REAL adapter, real HTTP, to the simulator on loopback
    app = await buildApp();
    await app.listen(0, "127.0.0.1");
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  }, 180_000);
  afterAll(async () => {
    off();
    await app?.close();
    await teardownTestDb();
  });
  beforeEach(() => on());

  it("switched off: the simulator's API and the portal page are 404, and boot refuses a mixed configuration", async () => {
    const { orderId } = await openSimulated(90_000);
    off();
    expect((await page(orderId)).statusCode).toBe(404);
    expect((await act(orderId, "pay")).statusCode).toBe(404);
    const sim = await fetch(`${base}/internal/payments/midtrans-sim/v2/${orderId}/status`, {
      headers: { authorization: `Basic ${Buffer.from(`${KEY}:`).toString("base64")}` },
    });
    expect(sim.status).toBe(404);
    config.payments.simulationEnabled = true;
    config.payments.midtrans = { serverKey: "SB-Mid-server-x", environment: "sandbox", tenantId: A };
    expect(() => describePaymentsConfig()).toThrow(/needs MIDTRANS_ENVIRONMENT=simulated/);
    config.payments.simulationEnabled = false;
    config.payments.midtrans = { serverKey: KEY, environment: "simulated", tenantId: A };
    expect(() => describePaymentsConfig()).toThrow(/needs PAYMENTS_SIMULATION_ENABLED=1/);
  });

  it("the simulator speaks Midtrans: HTTP Basic with the server key, 404 before the payer acts", async () => {
    const { orderId } = await openSimulated(95_000);
    const wrong = await fetch(`${base}/internal/payments/midtrans-sim/v2/${orderId}/status`, {
      headers: { authorization: `Basic ${Buffer.from("not-the-key:").toString("base64")}` },
    });
    expect(wrong.status).toBe(401);
    const right = await fetch(`${base}/internal/payments/midtrans-sim/v2/${orderId}/status`, {
      headers: { authorization: `Basic ${Buffer.from(`${KEY}:`).toString("base64")}` },
    });
    expect(right.status).toBe(404);
  });

  it("a full simulated round trip: checkout -> Pay (simulated) -> notice delivered -> processed -> receipt, allocation, paid, labelled", async () => {
    const { inv, orderId } = await openSimulated(150_000);
    const p = await page(orderId);
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json()).toMatchObject({ simulated: true, orderId, invoiceNo: inv.invoiceNo, amount: 150_000, currency: "IDR", transactionStatus: null, canAct: true });

    const r = await act(orderId, "pay");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ simulated: true, transactionStatus: "settlement", returnUrl: `/portal/invoices/${inv.id}?checkout=finished` });
    const claim = await claimed(orderId, "settlement");
    expect((await processPaymentEvent(A, claim)).status).toBe("paid");

    const pays = await paymentsOn(inv.id);
    expect(pays).toHaveLength(1);
    expect(pays[0].reference).toMatch(/^SIMULATED Online payment ck-/);
    expect(pays[0].note).toMatch(/SIMULATED/);
    const receipt = await row<{ reference: string; amount: string }>(`SELECT reference, amount::text AS amount FROM finance_ar_receipts WHERE id = $1`, [pays[0].ar_receipt_id]);
    expect(receipt.reference).toMatch(/SIMULATED/);
    expect(Number(receipt.amount)).toBe(150_000);
    expect(await count(`SELECT count(*) FROM finance_ar_allocations WHERE receipt_id = $1`, [pays[0].ar_receipt_id])).toBe(1);
    expect((await row<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [inv.id])).status).toBe("paid");
    expect((await row<{ environment: string; status: string }>(`SELECT environment, status FROM payment_checkouts WHERE provider_checkout_id = $1`, [orderId])))
      .toEqual({ environment: "simulated", status: "paid" });
    // Audited, and the notifications say SIMULATED.
    expect(await count(`SELECT count(*) FROM activities WHERE verb = 'payment.simulated' AND actor_id = $1 AND metadata->>'order' = $2 AND metadata->>'action' = 'pay'`, [contact, orderId])).toBe(1);
    expect(await count(`SELECT count(*) FROM notifications WHERE user_id = $1 AND type = 'invoice.payment.received_online' AND payload->>'title' LIKE 'SIMULATED: %'`, [finMgr])).toBeGreaterThanOrEqual(1);
    // A paid page takes no further action.
    expect((await page(orderId)).json()).toMatchObject({ transactionStatus: "settlement", canAct: false });
    expect((await act(orderId, "fail")).statusCode).toBe(409);
  });

  it("Leave pending, then Pay: nothing is written for pending, the payment once", async () => {
    const { inv, orderId } = await openSimulated(120_000);
    expect((await act(orderId, "pending")).statusCode).toBe(200);
    const pending = await claimed(orderId, "pending");
    expect((await processPaymentEvent(A, pending)).status).toBe("processed");
    expect(await paymentsOn(inv.id)).toEqual([]);
    expect((await act(orderId, "pay")).statusCode).toBe(200);
    const settled = await claimed(orderId, "settlement");
    expect((await processPaymentEvent(A, settled)).status).toBe("paid");
    expect(await paymentsOn(inv.id)).toHaveLength(1);
  });

  it("Payment fails: deny, no payment, the checkout is marked failed", async () => {
    const { inv, orderId } = await openSimulated(110_000);
    expect((await act(orderId, "fail")).statusCode).toBe(200);
    const denied = await claimed(orderId, "deny");
    expect((await processPaymentEvent(A, denied)).status).toBe("processed");
    expect(await paymentsOn(inv.id)).toEqual([]);
    expect((await row<{ status: string }>(`SELECT status FROM payment_checkouts WHERE provider_checkout_id = $1`, [orderId])).status).toBe("failed");
    expect((await row<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [inv.id])).status).toBe("sent");
  });

  it("another client's contact gets 404 on the page and the action, and nothing changes", async () => {
    const { orderId } = await openSimulated(105_000);
    expect((await page(orderId, outsider)).statusCode).toBe(404);
    expect((await act(orderId, "pay", outsider)).statusCode).toBe(404);
    const sim = await withTenants([A], (c) => simGetOrder(c, orderId));
    expect(sim?.transactionStatus).toBeNull();
    // Staff without the portal `pay` action are refused before anything is read.
    expect((await act(orderId, "pay", finMgr)).statusCode).toBe(403);
  });

  it("a forged notice is still 401 in simulated mode, and writes nothing", async () => {
    const { orderId } = await openSimulated(100_000);
    expect((await act(orderId, "pay")).statusCode).toBe(200);
    await claimed(orderId, "settlement");
    const before = await count(`SELECT count(*) FROM provider_events`);
    const sim = await withTenants([A], (c) => simGetOrder(c, orderId));
    const forged = { ...simNoticeBody(sim!, "not-the-key"), transaction_status: "capture", fraud_status: "accept" };
    const r = await fetch(`${base}/api/webhooks/payments/midtrans`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(forged),
    });
    expect(r.status).toBe(401);
    expect(await count(`SELECT count(*) FROM provider_events`)).toBe(before);
  });

  it("the simulator's own notice, replayed, is processed once", async () => {
    const { inv, orderId } = await openSimulated(130_000);
    expect((await act(orderId, "pay")).statusCode).toBe(200);
    const claim = await claimed(orderId, "settlement");
    expect((await processPaymentEvent(A, claim)).status).toBe("paid");
    const sim = await withTenants([A], (c) => simGetOrder(c, orderId));
    const replay = await fetch(`${base}/api/webhooks/payments/midtrans`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(simNoticeBody(sim!, KEY)),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, duplicate: true });
    expect(await paymentsOn(inv.id)).toHaveLength(1);
  });
});
