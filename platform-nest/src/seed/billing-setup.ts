// PV5-04 — the finance setup a company needs before it can ISSUE an invoice, and the seed/test helpers that produce
// issued (and paid) invoices through the REAL issue path. Since PV5-01b (202610131800) an invoice can be `sent` or
// `paid` only if it was issued through the ledger, so the demo seeds and the test fixtures that used to INSERT a sent
// invoice now set this up and issue for real. Nothing here sets the legacy flag (only the migration may) or bypasses a
// CHECK.
//
// What `ensureBillingSetup()` makes, idempotently, for ONE company (by id, never by name):
//   * the `finance` module flag on the company;
//   * accounting settings (IDR books), the PSAK chart of accounts, and calendar fiscal years for LAST year and THIS
//     year with monthly periods (each only when no fiscal year already covers its 1 January), so a demo invoice
//     issued "60 days ago" in January still lands in an open period;
//   * a billing profile with OBVIOUSLY FAKE issuer and bank details (the repo is public; real values are entered on the
//     server through PUT /billing-profile), prefix `INV` unless told otherwise, revenue 4100 and receipts into 1120.
// An existing profile is never overwritten.
//
// ⚠ The finance tables are module walled: every write here declares { modules: ["finance"] } (a plain withTenants writes
// nothing and raises nothing).
import { newId, withGlobal, withTenants } from "../db";
import { config } from "../config";
import { issueInvoice, postConfirmedPayment, withBilling, type IssuedView } from "../modules/invoice/issue";

export interface BillingSetupOptions {
  /** Invoice number prefix (A-Z, 0-9, '-'). Default `INV`. */
  prefix?: string;
}

export async function ensureBillingSetup(tenantId: string, opts: BillingSetupOptions = {}): Promise<void> {
  const company = await withGlobal((c) =>
    c.query<{ name: string }>(`SELECT name FROM companies WHERE id = $1`, [tenantId]),
  );
  if (!company.rows[0]) throw new Error(`ensureBillingSetup: no company ${tenantId}`);
  await withGlobal((c) =>
    c.query(
      `UPDATE companies SET enabled_modules = array_append(enabled_modules, 'finance'), updated_at = now()
        WHERE id = $1 AND NOT ('finance' = ANY(COALESCE(enabled_modules, '{}')))`,
      [tenantId],
    ),
  );
  await withTenants(
    [tenantId],
    async (c) => {
      await c.query(
        `INSERT INTO finance_company_settings (tenant_id, functional_currency, presentation_currency, fiscal_year_start_month)
         VALUES ($1, 'IDR', 'IDR', 1) ON CONFLICT (tenant_id) DO NOTHING`,
        [tenantId],
      );
      await c.query(`SELECT finance_instantiate_coa($1, 'id_psak_general_v1')`, [tenantId]);
      for (const back of [1, 0]) {
        const covered = await c.query(
          `SELECT 1 FROM finance_fiscal_years
            WHERE tenant_id = $1 AND daterange(start_date, end_date, '[)') @>
                  make_date(extract(year FROM current_date)::int - $2::int, 1, 1)`,
          [tenantId, back],
        );
        if (covered.rows[0]) continue;
        const fy = await c.query<{ id: string }>(
          `INSERT INTO finance_fiscal_years (tenant_id, code, start_date, end_date)
           SELECT $1, 'FY' || (extract(year FROM current_date)::int - $2::int),
                  make_date(extract(year FROM current_date)::int - $2::int, 1, 1),
                  make_date(extract(year FROM current_date)::int - $2::int + 1, 1, 1)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [tenantId, back],
        );
        if (fy.rows[0]) await c.query(`SELECT finance_generate_periods($1, 'monthly')`, [fy.rows[0].id]);
      }
      await c.query(
        `INSERT INTO company_billing_profiles
           (tenant_id, legal_name, address, invoice_prefix, default_payment_terms_days, currency_code,
            bank_name, bank_account_name, bank_account_no, bank_ledger_account_code, default_revenue_account_code)
         VALUES ($1, $2, 'Example address (seed data, not a real address)', $3, 30, 'IDR',
                 'Example Bank (seed data)', $2, '0000000000', '1120', '4100')
         ON CONFLICT (tenant_id) DO NOTHING`,
        [tenantId, company.rows[0].name, opts.prefix ?? "INV"],
      );
    },
    { modules: ["finance"] },
  );
}

export interface SeedInvoiceLine { description: string; hours?: number; rate?: number; amount: number }

/**
 * Create an APPROVED invoice and issue it through the real issue path (IDR unless told otherwise). Returns the issued
 * view (its id, number, dates, totals). `ensureBillingSetup(tenantId)` must have run. `actorId` is recorded as creator,
 * approver and issuer: this is seed/test data, not a maker/checker demonstration.
 */
export async function createIssuedInvoice(
  tenantId: string,
  p: {
    clientId: string; actorId: string; lines: SeedInvoiceLine[]; currency?: string;
    periodStart?: string | null; periodEnd?: string | null; taxCode?: string | null;
    /** Seeds only: issue as of this date (YYYY-MM-DD), e.g. to show an overdue invoice. Default today. */
    issueDate?: string;
  },
): Promise<IssuedView> {
  const id = newId();
  const total = p.lines.reduce((s, l) => s + l.amount, 0);
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO invoices (id, tenant_id, client_id, period_start, period_end, status, currency, lines, total,
                             origin_site, created_by, updated_by, approved_by, approved_at, tax_code)
       VALUES ($1, $2, $3, COALESCE($4::date, current_date - 30), COALESCE($5::date, current_date), 'approved', $6, $7, $8,
               $9, $10, $10, $10, now(), $11)`,
      [id, tenantId, p.clientId, p.periodStart ?? null, p.periodEnd ?? null, p.currency ?? "IDR",
       JSON.stringify(p.lines), total, config.originSite, p.actorId, p.taxCode ?? null],
    ),
  );
  return issueInvoice(tenantId, id, p.actorId, { issueDate: p.issueDate });
}

/**
 * Record a CONFIRMED payment on an issued invoice the real way: the invoice_payments row plus its AR receipt and
 * allocation (the same postConfirmedPayment the decide route uses). `amount` defaults to everything outstanding, which
 * leaves the invoice `paid`. `source` is `client_claim` when the client recorded it, `staff` otherwise. Returns the id.
 */
export async function recordConfirmedPayment(
  tenantId: string,
  invoiceId: string,
  p: {
    recordedBy: string | null; confirmedBy: string; amount?: number | string; paidOn?: string;
    method?: string; reference?: string | null; byClient?: boolean;
  },
): Promise<string> {
  const paymentId = newId();
  await withBilling(tenantId, async (c) => {
    const inv = await c.query<{ clientId: string | null; currency: string; outstanding: string; today: string }>(
      `SELECT i.client_id AS "clientId", i.currency,
              (a.total - a.amount_paid - a.amount_credited - a.amount_written_off)::text AS outstanding,
              to_char(current_date, 'YYYY-MM-DD') AS today
         FROM invoices i JOIN finance_ar_invoices a ON a.id = i.ar_invoice_id
        WHERE i.id = $1`,
      [invoiceId],
    );
    const row = inv.rows[0];
    if (!row) throw new Error(`recordConfirmedPayment: invoice ${invoiceId} is not issued (or the finance scope is missing)`);
    const amount = p.amount === undefined ? row.outstanding : String(p.amount);
    const paidOn = p.paidOn ?? row.today;
    await c.query(
      `INSERT INTO invoice_payments
         (id, tenant_id, invoice_id, client_id, amount, currency, paid_on, method, reference, status,
          recorded_by, confirmed_by, confirmed_at, source, origin_site)
       VALUES ($1, $2, $3, $4, $5::numeric, $6, $7::date, $8, $9, 'confirmed', $10, $11, now(), $12, $13)`,
      [paymentId, tenantId, invoiceId, row.clientId, amount, row.currency, paidOn, p.method ?? "bank_transfer",
       p.reference ?? null, p.recordedBy, p.confirmedBy, p.byClient ? "client_claim" : "staff", config.originSite],
    );
    await postConfirmedPayment(c, tenantId, {
      paymentId, invoiceId, amount, currency: row.currency, paidOn, reference: p.reference ?? null, actorId: p.confirmedBy,
    });
  });
  return paymentId;
}
