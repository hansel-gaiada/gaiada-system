// IAM-GAP-02 — invoice revision tracking's THIRD write path: `contracts.controller.ts::decidePayment()`
// is the ONLY place `invoices.status` moves to 'paid' outside the invoice module entirely (a
// staff-confirmed client payment, once the confirmed ledger covers the total). No test file existed
// for this endpoint before this ticket (`decidePayment` was previously untested end-to-end); this
// file drives the REAL `POST /api/:t/invoice-payments/:paymentId/decide` route and asserts the same
// forensic contract invoice.test.ts pins for the other two write paths: a revision row per mutation,
// actor-attributed, before-state reconstructible — plus the pre-existing recorder≠confirmer rule and
// the "don't resurrect a void invoice" guard, both unaffected by this pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { createIssuedInvoice, ensureBillingSetup } from "../seed/billing-setup";
import { voidIssuedInvoice } from "../modules/invoice/issue";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("invoice-payments decide -> invoice.paid revision (IAM-GAP-02)", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let admin: string; // confirms payments (company_admin)
  let recorder: string; // a DIFFERENT user who "recorded" the payment — decidePayment forbids recorder===confirmer
  let clientId: string;

  // PV5-04: a `sent` invoice is an ISSUED one (PV5-01b), so it is issued through the real path (IDR, the books'
  // currency); a `void` one is issued and then voided (a credit note in the ledger), the only way an issued invoice
  // ends void.
  async function insertInvoice(total: number, status: "sent" | "void" = "sent"): Promise<string> {
    const issued = await createIssuedInvoice(tenant, {
      clientId, actorId: admin, lines: [{ description: "Fixture work", amount: total }],
    });
    if (status === "void") await voidIssuedInvoice(tenant, issued.id, admin, "fixture: cancelled");
    return issued.id;
  }

  async function insertPayment(invoiceId: string, amount: number): Promise<string> {
    const id = newId();
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO invoice_payments (id, tenant_id, invoice_id, client_id, amount, currency, paid_on, status, recorded_by, origin_site)
         VALUES ($1, $2, $3, $4, $5, 'IDR', now()::date, 'pending', $6, 'test')`,
        [id, tenant, invoiceId, clientId, amount, recorder],
      ),
    );
    return id;
  }

  const getRevisions = (invoiceId: string) =>
    withTenants([tenant], (c) =>
      c.query<{ action: string; actorId: string | null; before: { status: string } | null; after: { status: string } }>(
        `SELECT action, actor_id AS "actorId", before_snapshot AS before, after_snapshot AS after
           FROM invoice_revisions WHERE invoice_id = $1 ORDER BY occurred_at ASC`,
        [invoiceId],
      ),
    ).then((r) => r.rows);

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    tenant = await createCompany("Agency A", ["agency", "clients"]);
    admin = await createUser("admin@a.test");
    recorder = await createUser("recorder@a.test");
    await addMembership(tenant, admin);
    await addMembership(tenant, recorder);
    await grantRole(admin, await createRole("company_admin"), "company", tenant);
    app = await buildApp();
    clientId = (await app.inject({ method: "POST", url: `/api/${tenant}/clients`, headers: asUser(admin), payload: { name: "Acme", businessType: "other" } })).json().id;
    await ensureBillingSetup(tenant);
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("confirming a fully-covering payment flips the invoice to 'paid' and records ONE 'paid_via_payment_confirmation' revision, actor = the confirmer", async () => {
    const invoiceId = await insertInvoice(500);
    const paymentId = await insertPayment(invoiceId, 500);

    // Baseline: the invoice was ISSUED through the real path (PV5-04), which records exactly one 'issued' revision.
    const baseline = await getRevisions(invoiceId);
    expect(baseline.map((r) => r.action)).toEqual(["issued"]);

    const r = await app.inject({
      method: "POST", url: `/api/${tenant}/invoice-payments/${paymentId}/decide`,
      headers: asUser(admin), payload: { decision: "confirm" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ invoicePaid: true });

    const revs = (await getRevisions(invoiceId)).slice(baseline.length);
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ action: "paid_via_payment_confirmation", actorId: admin });
    expect(revs[0].before?.status).toBe("sent");
    expect(revs[0].after.status).toBe("paid");

    const row = await withTenants([tenant], (c) =>
      c.query<{ updated_by: string }>(`SELECT updated_by FROM invoices WHERE id = $1`, [invoiceId]),
    );
    expect(row.rows[0].updated_by).toBe(admin);
  });

  it("a PARTIAL payment does not flip the invoice and records NO revision (no mutation happened, so no revision must appear)", async () => {
    const invoiceId = await insertInvoice(1000);
    const paymentId = await insertPayment(invoiceId, 300);
    const baseline = (await getRevisions(invoiceId)).length;

    const r = await app.inject({
      method: "POST", url: `/api/${tenant}/invoice-payments/${paymentId}/decide`,
      headers: asUser(admin), payload: { decision: "confirm" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ invoicePaid: false });
    expect(await getRevisions(invoiceId)).toHaveLength(baseline);
  });

  it("a VOID invoice is never resurrected to 'paid' by a late confirmation, and records NO revision either", async () => {
    const invoiceId = await insertInvoice(200, "void");
    const paymentId = await insertPayment(invoiceId, 200);
    const baseline = (await getRevisions(invoiceId)).length;

    const r = await app.inject({
      method: "POST", url: `/api/${tenant}/invoice-payments/${paymentId}/decide`,
      headers: asUser(admin), payload: { decision: "confirm" },
    });
    // PV5-04: confirming money against a voided invoice is now REFUSED (409, nothing written) rather than confirmed
    // with a quirky `invoicePaid: true` (the IAM-GAP-02 quirk this test used to pin): the ledger invoice is void, so
    // there is nothing to allocate the money to. The claim stays pending for a staff member to reject.
    expect(r.statusCode).toBe(409);
    const row = await withTenants([tenant], (c) => c.query<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [invoiceId]));
    expect(row.rows[0].status).toBe("void");
    const pay = await withTenants([tenant], (c) => c.query<{ status: string }>(`SELECT status FROM invoice_payments WHERE id = $1`, [paymentId]));
    expect(pay.rows[0].status).toBe("pending");
    expect(await getRevisions(invoiceId)).toHaveLength(baseline); // no mutation happened -> no revision recorded
  });

  // PV3-03 / CC-1: the `?clientId=` facet on the finance confirmation queue.
  describe("GET invoice-payments?clientId= (strict client facet)", () => {
    let otherClient: string;
    const pay: Record<string, string> = {};

    // `invoice_payments.client_id` is nullable (0075), so `internal` genuinely selects rows here: the
    // payments on an invoice that names no client. PV5-04: the parent invoices are `approved` (unissued): this block
    // tests the list facet only, and an invoice with no client cannot be issued.
    async function insertPaymentFor(client: string | null, amount: number): Promise<string> {
      const invoiceId = newId();
      const id = newId();
      await withTenants([tenant], async (c) => {
        await c.query(
          `INSERT INTO invoices (id, tenant_id, client_id, status, currency, lines, total, origin_site, created_by, updated_by)
           VALUES ($1, $2, $3, 'approved', 'USD', '[]', $4, 'test', $5, $5)`,
          [invoiceId, tenant, client, amount, admin],
        );
        await c.query(
          `INSERT INTO invoice_payments (id, tenant_id, invoice_id, client_id, amount, currency, paid_on, status, recorded_by, origin_site)
           VALUES ($1, $2, $3, $4, $5, 'USD', now()::date, 'pending', $6, 'test')`,
          [id, tenant, invoiceId, client, amount, recorder],
        );
      });
      return id;
    }

    beforeAll(async () => {
      otherClient = (await app.inject({ method: "POST", url: `/api/${tenant}/clients`, headers: asUser(admin), payload: { name: "Facet Other", businessType: "other" } })).json().id;
      pay.mine = await insertPaymentFor(clientId, 111);
      pay.theirs = await insertPaymentFor(otherClient, 222);
      pay.clientless = await insertPaymentFor(null, 333);
    });

    const get = (qs: string, as = admin) =>
      app.inject({ method: "GET", url: `/api/${tenant}/invoice-payments${qs}`, headers: asUser(as) });
    type Row = { id: string; clientId: string | null };

    it("no clientId returns every client's payments, unchanged", async () => {
      const r = await get("");
      expect(r.statusCode).toBe(200);
      const ids = (r.json() as Row[]).map((x) => x.id);
      expect(ids).toEqual(expect.arrayContaining([pay.mine, pay.theirs, pay.clientless]));
    });

    it("a uuid lists only that client's payments, never another client's", async () => {
      const r = await get(`?clientId=${clientId}`);
      expect(r.statusCode).toBe(200);
      const rows = r.json() as Row[];
      expect(rows.map((x) => x.id)).toContain(pay.mine);
      expect(rows.map((x) => x.id)).not.toContain(pay.theirs);
      expect(rows.map((x) => x.id)).not.toContain(pay.clientless);
      expect(rows.every((x) => x.clientId === clientId)).toBe(true);
    });

    it("composes with ?status=", async () => {
      const r = await get(`?clientId=${otherClient}&status=pending`);
      expect(r.statusCode).toBe(200);
      expect((r.json() as Row[]).map((x) => x.id)).toEqual([pay.theirs]);
      const none = await get(`?clientId=${otherClient}&status=confirmed`);
      expect(none.json()).toEqual([]);
    });

    it("internal lists only clientless payments", async () => {
      const r = await get("?clientId=internal");
      expect(r.statusCode).toBe(200);
      const rows = r.json() as Row[];
      expect(rows.map((x) => x.id)).toContain(pay.clientless);
      expect(rows.map((x) => x.id)).not.toContain(pay.mine);
      expect(rows.map((x) => x.id)).not.toContain(pay.theirs);
      expect(rows.every((x) => x.clientId === null)).toBe(true);
    });

    it("a non-uuid is a 400", async () => {
      expect((await get("?clientId=not-a-uuid")).statusCode).toBe(400);
    });

    it("authorization runs before validation: no grant -> 403, even with a garbage clientId", async () => {
      expect((await get("?clientId=not-a-uuid", recorder)).statusCode).toBe(403);
    });
  });
});
