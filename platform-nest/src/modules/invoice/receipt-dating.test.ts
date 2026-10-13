// PV5-F2 — a client payment dated in a CLOSED fiscal period can still be confirmed (standard late recognition).
//
// Confirming posts an AR receipt dated on the claim's `paid_on`. When that date's period is closed the ledger refused (409
// FINANCE_PERIOD_CLOSED) and the payment could never be confirmed. The rule now (issue.ts resolveReceiptDate, shared with
// the gateway path later): the receipt is dated `paid_on` when its period is open; otherwise the FIRST DAY of the earliest
// OPEN period after it, with the original date in the receipt's reference (its free-text field: the table has no notes
// column); `invoice_payments.paid_on` never changes; with no open period after it, a clear 409 `no_open_period`.
//
// Real HTTP surface against Postgres + RLS + Cerbos (the Linux gate; skips without DATABASE_URL_TEST).
//
// TEETH (proven in the PV5-F2 hand-back by breaking the code in a throwaway commit):
//   (a) remove the late-recognition fallback (always receipt on paid_on) -> "a payment dated in a closed period is
//       confirmed" fails (409 FINANCE_PERIOD_CLOSED, nothing confirmed).
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

describe.skipIf(!TEST_URL)("PV5-F2 — a payment dated in a closed period is confirmed with late recognition", () => {
  let app: NestFastifyApplication;
  let T: string;
  let admin: string;
  let recorder: string;
  let client: string;
  let last: number; // last calendar year: ensureBillingSetup cuts monthly periods for it and for this year

  const finance = <R>(sql: string, args: unknown[] = []) =>
    withTenants([T], (c) => c.query(sql, args), { modules: ["finance"] }).then((r) => r.rows as R[]);
  const row = async (sql: string, args: unknown[]) => (await adminPool().query(sql, args)).rows[0];

  async function pending(invoiceId: string, amount: number, paidOn: string): Promise<string> {
    const id = newId();
    await withTenants([T], (c) =>
      c.query(
        `INSERT INTO invoice_payments (id, tenant_id, invoice_id, client_id, amount, currency, paid_on, status, recorded_by, origin_site, source, reference)
         VALUES ($1, $2, $3, $4, $5, 'IDR', $6::date, 'pending', $7, 'test', 'staff', 'TRF-123')`,
        [id, T, invoiceId, client, amount, paidOn, recorder],
      ));
    return id;
  }
  const decide = (paymentId: string) =>
    app.inject({ method: "POST", url: `/api/${T}/invoice-payments/${paymentId}/decide`, headers: asUser(admin), payload: { decision: "confirm" } });
  const receiptOf = (paymentId: string) =>
    row(
      `SELECT to_char(r.receipt_date, 'YYYY-MM-DD') AS "receiptDate", r.reference, to_char(j.entry_date, 'YYYY-MM-DD') AS "journalDate",
              to_char(pp.paid_on, 'YYYY-MM-DD') AS "paidOn", pp.status
         FROM invoice_payments pp
         JOIN finance_ar_receipts r ON r.id = pp.ar_receipt_id
         JOIN finance_journal_entries j ON j.id = r.journal_entry_id
        WHERE pp.id = $1`, [paymentId]);
  const setPeriods = (where: string, state: "OPEN" | "SOFT_LOCK") =>
    finance(`UPDATE finance_fiscal_periods SET state = $2 WHERE tenant_id = $1 AND ${where}`, [T, state]);
  const invoice = async (amount: number) =>
    (await createIssuedInvoice(T, { clientId: client, actorId: admin, lines: [{ description: "Design work", amount }] }));

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    T = await createCompany("PV5-F2 Receipts Co", ["invoice", "clients"]);
    admin = await createUser("admin@pv5f2-rc.test");
    recorder = await createUser("recorder@pv5f2-rc.test");
    const companyAdmin = await createRole("company_admin");
    for (const u of [admin, recorder]) {
      await addMembership(T, u);
      await grantRole(u, companyAdmin, "company", T);
    }
    client = await createClient(T, "PV5-F2 Client");
    await ensureBillingSetup(T, { prefix: "RCT" });
    last = Number((await row(`SELECT extract(year FROM current_date)::int - 1 AS y`, [])).y);
    app = await buildApp();
  }, 180_000);
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  it("control: a payment dated in an OPEN period is receipted on its own date, with no late note", async () => {
    const inv = await invoice(400_000);
    const p = await pending(inv.id, 400_000, `${last}-02-10`);
    const r = await decide(p);
    expect(r.statusCode, r.body).toBe(200);
    expect(await receiptOf(p)).toMatchObject({ receiptDate: `${last}-02-10`, journalDate: `${last}-02-10`, paidOn: `${last}-02-10`, status: "confirmed", reference: "TRF-123" });
  });

  it("★ a payment dated in a closed period is confirmed: the receipt is dated the first day of the next open period, with the original date in its notes; paid_on is unchanged", async () => {
    await setPeriods(`start_date <= '${last}-03-31'::date AND end_date >= '${last}-03-01'::date`, "SOFT_LOCK");
    const inv = await invoice(500_000);
    const p = await pending(inv.id, 500_000, `${last}-03-10`);
    const r = await decide(p);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ invoicePaid: true });

    const rec = await receiptOf(p);
    expect(rec).toMatchObject({ receiptDate: `${last}-04-01`, journalDate: `${last}-04-01`, status: "confirmed" });
    expect(rec.reference).toContain("TRF-123");
    expect(rec.reference).toContain(`paid ${last}-03-10`);
    // The evidence is never rewritten.
    expect(rec.paidOn).toBe(`${last}-03-10`);
    // Booked and allocated: the invoice is paid in both tables and the subledger still ties to the ledger.
    expect(await row(`SELECT status FROM invoices WHERE id = $1`, [inv.id])).toEqual({ status: "paid" });
    expect(await row(`SELECT status FROM finance_ar_invoices WHERE id = $1`, [inv.arInvoiceId])).toEqual({ status: "paid" });
    expect(await finance(`SELECT problem FROM finance_ar_reconcile($1, NULL)`, [T])).toEqual([]);
  });

  it("the earliest OPEN period after paid_on is used, skipping a run of closed ones", async () => {
    await setPeriods(`start_date <= '${last}-05-31'::date AND end_date >= '${last}-03-01'::date`, "SOFT_LOCK");
    const inv = await invoice(300_000);
    const p = await pending(inv.id, 300_000, `${last}-04-20`);
    const r = await decide(p);
    expect(r.statusCode, r.body).toBe(200);
    expect(await receiptOf(p)).toMatchObject({ receiptDate: `${last}-06-01`, paidOn: `${last}-04-20` });
  });

  it("★ with no open period after it, a clear 409 naming the problem; nothing is confirmed or posted", async () => {
    const inv = await invoice(200_000);
    const p = await pending(inv.id, 200_000, `${last}-03-15`);
    await setPeriods("true", "SOFT_LOCK");
    const r = await decide(p);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json()).toMatchObject({ reason: "no_open_period" });
    expect(String((r.json() as { error: string }).error)).toMatch(/no later fiscal period is open/);
    expect(String((r.json() as { error: string }).error)).not.toMatch(/FINANCE_/);
    expect(await row(`SELECT status, ar_receipt_id, to_char(paid_on, 'YYYY-MM-DD') AS paid_on FROM invoice_payments WHERE id = $1`, [p]))
      .toEqual({ status: "pending", ar_receipt_id: null, paid_on: `${last}-03-15` });
    expect(await row(`SELECT status FROM invoices WHERE id = $1`, [inv.id])).toEqual({ status: "sent" });
    await setPeriods("true", "OPEN");
  });

  it("the readiness blocker for a missing tax code points at the Finance > Tax screen", async () => {
    const id = newId();
    await withTenants([T], (c) =>
      c.query(
        `INSERT INTO invoices (id, tenant_id, client_id, period_start, period_end, status, currency, lines, total, origin_site,
                               created_by, updated_by, approved_by, approved_at, tax_code, service_line_key)
         VALUES ($1, $2, $3, current_date - 30, current_date, 'approved', 'IDR', $4, 1000, 'test', $5, $5, $6, now(), 'NO-SUCH-CODE', 'services')`,
        [id, T, client, JSON.stringify([{ description: "x", hours: 1, rate: 1000, amount: 1000 }]), recorder, admin],
      ));
    const r = await app.inject({ method: "GET", url: `/api/${T}/invoices/${id}/issue-readiness`, headers: asUser(admin) });
    expect(r.statusCode, r.body).toBe(200);
    const blocker = (r.json() as { blockers: Array<{ code: string; message: string }> }).blockers.find((b) => b.code === "TAX_CODE_NOT_IN_FORCE");
    expect(blocker?.message).toContain("NO-SUCH-CODE");
    expect(blocker?.message).toContain("/finance/tax");
  });
});
