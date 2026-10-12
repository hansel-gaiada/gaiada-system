// PV5-04 — issue an invoice THROUGH THE LEDGER (ruling PV-D7). The money path.
// Plan: docs/plans/2026-10-12-pv5-contracts-billing-tickets.md (PV5-04; design decisions 1-10, 20).
//
// `invoices` stays the drafting stage (lines from logged hours, maker/checker). ISSUING it is what makes it an invoice
// of record, and it happens in ONE transaction, under both RLS walls (`withBilling`, below):
//   1. re-check readiness (the same function the readiness GET answers from) and refuse with EVERY blocker at once;
//   2. find or create the client's AR customer (a group client's customer carries counterparty_company_id, decision 20);
//   3. take the next number of the company's gapless per-year series (`next_document_no`, row-locked: a rollback
//      returns the number, concurrent issues serialise);
//   4. compute tax with `finance_tax_compute()` from the effective-dated tax code, rounded to the currency's minor unit
//      (never arithmetic in a handler, decision 8);
//   5. write the AR invoice and its lines and post it with `finance_ar_issue_invoice()` (balanced journal);
//   6. write the invoice-of-record columns and the frozen issuer snapshot, and set `sent` (shown as "Issued");
//   7. emit `invoice.issued` and record a revision (`status_changed`, the closed 0108 action list).
// After this the row is immutable (202610130400's trigger) except status -> paid | void.
//
// ── NUMBERS ARE `numeric`, NEVER JS FLOATS ─────────────────────────────────────────────────────────────
// Every amount below travels as a STRING between Postgres and here and every comparison is done in SQL. The tracker's
// `lines` JSON is read with jsonb operators and cast to numeric in the database. A float round-trip on money is how a
// rupiah goes missing and a reconciliation stops being clean.
//
// ── THE WALLS ──────────────────────────────────────────────────────────────────────────────────────────
// finance_* tables compose `app_module_allowed('finance')`. A plain withTenants() reads ZERO rows and raises nothing,
// so every function here takes a client opened by `withBilling` (modules: ["finance"]). The readiness check reads the
// company's `enabled_modules` separately: the GUC is set by us, so "can read finance rows" says nothing about whether
// the company has the module switched on.
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseError, type PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import { emitEvent } from "../../events/outbox.service";
import { recordInvoiceRevision, snapshotInvoice } from "./invoice-revisions";

/** The only DB path for anything that touches finance_* tables from the invoice side. See the header. */
export function withBilling<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants([tenantId], fn, { modules: ["finance"] });
}

export interface IssueBlocker {
  /** Machine code a client can branch on (stable). */
  code: string;
  /** What is missing, in words staff can act on. */
  message: string;
}

/** 409 carrying the full blocker list (`blockers`, forwarded by HttpErrorFilter). Nothing was written. */
export class IssueBlockedError extends ConflictException {
  constructor(public readonly blockers: IssueBlocker[]) {
    super({
      message: `this invoice cannot be issued yet: ${blockers.map((b) => b.message).join("; ")}`,
      reason: "issue_blocked",
      blockers,
    });
  }
}

/** Everything readiness reads, in one place, so the issue transaction acts on exactly what it checked. */
interface IssueFacts {
  id: string;
  tenantId: string;
  status: string;
  clientId: string | null;
  clientName: string | null;
  clientGroupCompanyId: string | null;
  currency: string;
  total: string;
  taxCode: string | null;
  issuedAt: string | null;
  arInvoiceId: string | null;
  invoiceNo: string | null;
  financeOn: boolean;
  // billing profile
  hasProfile: boolean;
  legalName: string | null;
  address: string | null;
  invoicePrefix: string | null;
  termsDays: number | null;
  bankName: string | null;
  bankAccountName: string | null;
  bankAccountNo: string | null;
  bankLedgerCode: string | null;
  revenueCode: string | null;
  // finance settings
  hasSettings: boolean;
  functionalCurrency: string | null;
  isPkp: boolean | null;
  npwp: string | null;
  // currency
  currencyKnown: boolean;
  minorUnit: number;
  // ledger
  arControls: number;
  revenueAccountId: string | null;
  bankAccountId: string | null;
  vatAccountId: string | null;
  periodOpen: boolean;
  today: string;
  taxInForce: boolean | null;
  // lines
  lineCount: number;
  badLines: number;
  linesTotalMatches: boolean;
  precisionOk: boolean;
}

const LOAD_INVOICE = `
  SELECT i.id, i.tenant_id AS "tenantId", i.status, i.client_id AS "clientId", cl.name AS "clientName",
         cl.group_company_id AS "clientGroupCompanyId", i.currency, i.total::text AS total, i.tax_code AS "taxCode",
         i.issued_at AS "issuedAt", i.ar_invoice_id AS "arInvoiceId", i.invoice_no AS "invoiceNo",
         ('finance' = ANY(COALESCE(co.enabled_modules, '{}'))) AS "financeOn",
         (bp.tenant_id IS NOT NULL) AS "hasProfile", bp.legal_name AS "legalName", bp.address,
         bp.invoice_prefix AS "invoicePrefix", bp.default_payment_terms_days AS "termsDays",
         bp.bank_name AS "bankName", bp.bank_account_name AS "bankAccountName", bp.bank_account_no AS "bankAccountNo",
         bp.bank_ledger_account_code AS "bankLedgerCode", bp.default_revenue_account_code AS "revenueCode",
         (fs.tenant_id IS NOT NULL) AS "hasSettings", fs.functional_currency AS "functionalCurrency",
         fs.is_pkp AS "isPkp", fs.npwp,
         (cur.code IS NOT NULL) AS "currencyKnown", COALESCE(cur.minor_unit, 2)::int AS "minorUnit"
    FROM invoices i
    JOIN companies co ON co.id = i.tenant_id
    LEFT JOIN clients cl ON cl.id = i.client_id AND cl.deleted_at IS NULL
    LEFT JOIN company_billing_profiles bp ON bp.tenant_id = i.tenant_id
    LEFT JOIN finance_company_settings fs ON fs.tenant_id = i.tenant_id
    LEFT JOIN finance_currencies cur ON cur.code = i.currency
   WHERE i.id = $1 AND i.deleted_at IS NULL`;

/** A live, active, postable, non-control account by code (the shape a receipt or revenue line can post to). */
const postableAccount = (codeParam: string) => `
  SELECT id FROM finance_accounts
   WHERE tenant_id = $1 AND code = ${codeParam}::text AND deleted_at IS NULL AND status = 'active'
     AND is_postable AND NOT is_control
   LIMIT 1`;

async function loadFacts(
  c: PoolClient, tenantId: string, invoiceId: string, lock: boolean, onDate: string | null = null,
): Promise<IssueFacts | null> {
  const head = await c.query(`${LOAD_INVOICE}${lock ? " FOR UPDATE OF i" : ""}`, [invoiceId]);
  const h = head.rows[0];
  if (!h || h.tenantId !== tenantId) return null;

  const ledger = await c.query<{
    arControls: number; revenueAccountId: string | null; bankAccountId: string | null; vatAccountId: string | null;
    periodOpen: boolean; today: string; taxInForce: boolean | null;
  }>(
    `SELECT (SELECT count(*)::int FROM finance_accounts
              WHERE tenant_id = $1 AND is_control AND control_subledger = 'ar'
                AND deleted_at IS NULL AND status = 'active') AS "arControls",
            (${postableAccount("$2")}) AS "revenueAccountId",
            (${postableAccount("$3")}) AS "bankAccountId",
            -- finance_ar_issue_invoice credits output VAT to 2140 by code; check what it will look for.
            (SELECT id FROM finance_accounts WHERE tenant_id = $1 AND code = '2140' AND deleted_at IS NULL
                AND status = 'active' LIMIT 1) AS "vatAccountId",
            finance_period_accepts_posting($1, COALESCE($5::date, current_date)) AS "periodOpen",
            to_char(COALESCE($5::date, current_date), 'YYYY-MM-DD') AS today,
            CASE WHEN $4::text IS NULL THEN NULL
                 ELSE finance_tax_compute($1, $4::text, 1, COALESCE($5::date, current_date)) IS NOT NULL END AS "taxInForce"`,
    [tenantId, h.revenueCode, h.bankLedgerCode, h.taxCode, onDate],
  );

  // The tracker's lines, read as numeric in the database (never JS floats). A non-number amount is a bad line.
  const lines = await c.query<{ n: number; bad: number; sumMatches: boolean; precisionOk: boolean }>(
    `WITH l AS (
       SELECT CASE WHEN jsonb_typeof(x.l->'amount') = 'number' THEN (x.l->>'amount')::numeric END AS amt
         FROM invoices i
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(i.lines) = 'array' THEN i.lines ELSE '[]'::jsonb END) AS x(l)
        WHERE i.id = $1
     )
     SELECT count(*)::int AS n,
            count(*) FILTER (WHERE amt IS NULL OR amt < 0)::int AS bad,
            (COALESCE(sum(amt), 0) = (SELECT total FROM invoices WHERE id = $1)) AS "sumMatches",
            COALESCE(bool_and(amt IS NULL OR amt = round(amt, $2::int)), true) AS "precisionOk"
       FROM l`,
    [invoiceId, h.minorUnit],
  );

  const L = ledger.rows[0];
  const ln = lines.rows[0];
  return {
    ...h,
    termsDays: h.termsDays === null ? null : Number(h.termsDays),
    minorUnit: Number(h.minorUnit),
    arControls: Number(L.arControls),
    revenueAccountId: L.revenueAccountId,
    bankAccountId: L.bankAccountId,
    vatAccountId: L.vatAccountId,
    periodOpen: L.periodOpen === true,
    today: L.today,
    taxInForce: L.taxInForce,
    lineCount: Number(ln.n),
    badLines: Number(ln.bad),
    linesTotalMatches: ln.sumMatches === true,
    precisionOk: ln.precisionOk === true,
  } as IssueFacts;
}

/** Every reason the invoice cannot be issued right now, all at once (the period-close-readiness idiom). */
function blockersFor(f: IssueFacts): IssueBlocker[] {
  const out: IssueBlocker[] = [];
  const add = (code: string, message: string) => out.push({ code, message });

  if (f.status !== "approved") add("NOT_APPROVED", `only an approved invoice can be issued (this one is ${f.status})`);
  if (!f.clientId || !f.clientName) add("NO_CLIENT", "the invoice has no live client to bill");
  if (!f.financeOn) add("FINANCE_MODULE_OFF", "the finance module is switched off for this company");
  if (!f.hasSettings) add("NO_FINANCE_SETTINGS", "this company has no accounting settings (functional currency, PKP status)");
  if (!f.hasProfile) {
    add("NO_BILLING_PROFILE", "this company has no billing profile (legal name, address, invoice number prefix)");
  } else {
    if (!f.bankName) add("NO_BANK_DETAILS", "the billing profile has no bank account for clients to pay into");
    if (!f.revenueCode) add("NO_REVENUE_ACCOUNT", "the billing profile names no revenue account");
    else if (!f.revenueAccountId) add("NO_REVENUE_ACCOUNT", `revenue account ${f.revenueCode} is not a live, postable account in the chart`);
    if (!f.bankLedgerCode) add("NO_RECEIPT_ACCOUNT", "the billing profile names no ledger account for bank receipts");
    else if (!f.bankAccountId) add("NO_RECEIPT_ACCOUNT", `receipt account ${f.bankLedgerCode} is not a live, postable account in the chart`);
  }
  if (f.arControls === 0) add("NO_AR_CONTROL_ACCOUNT", "the chart of accounts has no active receivables control account");
  if (!f.periodOpen) add("NO_OPEN_PERIOD", `no open fiscal period contains today (${f.today})`);
  if (!f.currencyKnown) add("CURRENCY_UNKNOWN", `${f.currency} is not a currency the ledger knows`);
  else if (f.hasSettings && f.functionalCurrency !== f.currency) {
    // The ledger books lines at exchange rate 1. Posting a foreign-currency invoice would put its face value into the
    // functional-currency books, which is a wrong number, so it is refused until multi-currency issue exists.
    add("CURRENCY_NOT_FUNCTIONAL", `the invoice is in ${f.currency} but the books are kept in ${f.functionalCurrency}`);
  }
  if (f.lineCount === 0) add("EMPTY_INVOICE", "the invoice has no lines");
  else {
    if (f.badLines > 0) add("LINES_INVALID", `${f.badLines} line(s) have no valid amount`);
    if (!f.linesTotalMatches) add("LINES_TOTAL_MISMATCH", "the line amounts do not add up to the invoice total");
    if (!f.precisionOk) add("AMOUNT_PRECISION", `a line amount has more decimals than ${f.currency} allows`);
  }
  if (f.lineCount > 0 && f.linesTotalMatches && !(Number(f.total) > 0)) add("EMPTY_INVOICE", "the invoice total is zero");
  if (f.taxCode) {
    // PV-D7 (owner, 2026-10-12): until Finance records the company as PKP, an invoice that carries tax cannot be issued.
    if (f.isPkp !== true) add("PKP_NOT_CONFIRMED", "the invoice carries tax but the company is not recorded as PKP");
    if (f.taxInForce !== true) add("TAX_CODE_NOT_IN_FORCE", `tax code ${f.taxCode} has no rate in force today`);
    if (!f.vatAccountId) add("NO_VAT_ACCOUNT", "the invoice carries tax but the chart has no output VAT account (2140)");
  }
  return out;
}

export interface ReadinessView {
  invoiceId: string;
  status: string;
  issued: boolean;
  invoiceNo: string | null;
  ready: boolean;
  blockers: IssueBlocker[];
}

/** GET …/issue-readiness. Reads only. 404 for an invoice outside the tenant or soft-deleted. */
export async function readIssueReadiness(tenantId: string, invoiceId: string): Promise<ReadinessView> {
  return withBilling(tenantId, async (c) => {
    const f = await loadFacts(c, tenantId, invoiceId, false);
    if (!f) throw new NotFoundException("invoice not found");
    if (f.issuedAt) {
      return { invoiceId, status: f.status, issued: true, invoiceNo: f.invoiceNo, ready: false, blockers: [] };
    }
    const blockers = blockersFor(f);
    return { invoiceId, status: f.status, issued: false, invoiceNo: null, ready: blockers.length === 0, blockers };
  });
}

/** Maps the refusals this path can raise to clear 4xx answers. FINANCE_* is left to FinanceErrorFilter (global). */
export async function mapLedgerErrors<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof DatabaseError) {
      const msg = e.message ?? "";
      const pv5 = /^(PV5_[A-Z0-9_]+):\s*(.*)$/s.exec(msg);
      if (pv5) throw new ConflictException({ message: pv5[2].trim(), reason: pv5[1].toLowerCase() });
      if (e.code === "23505") {
        throw new ConflictException({
          message: `a number or link this needs is already taken (${e.constraint ?? "unique"}); nothing was written, try again`,
          reason: "conflict",
        });
      }
      if (e.code === "40001" || e.code === "40P01") {
        throw new ConflictException({ message: "a concurrent change got there first; nothing was written, try again", reason: "conflict" });
      }
    }
    throw e;
  }
}

async function nextNumber(c: PoolClient, tenantId: string, series: string, year: number): Promise<number> {
  const r = await c.query<{ n: number }>(`SELECT next_document_no($1, $2, $3) AS n`, [tenantId, series, year]);
  return Number(r.rows[0].n);
}

/** `{prefix}/{yyyy}/{nnnn}` (PV5-Q3); other series carry a short infix: `{prefix}/RC/{yyyy}/{nnnn}`. */
function formatNo(prefix: string, year: number, n: number, infix?: string): string {
  return [prefix, infix, String(year), String(n).padStart(4, "0")].filter(Boolean).join("/");
}

/** Decision 20: one AR customer per client, created on first issue. A group client's customer carries the counterparty. */
async function ensureArCustomer(c: PoolClient, f: IssueFacts): Promise<{ id: string; termsDays: number }> {
  const find = () =>
    c.query<{ id: string; terms: number }>(
      `SELECT id, payment_terms_days AS terms FROM finance_ar_customers
        WHERE tenant_id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [f.tenantId, f.clientId],
    );
  let r = await find();
  if (!r.rows[0]) {
    const counterparty = f.clientGroupCompanyId && f.clientGroupCompanyId !== f.tenantId ? f.clientGroupCompanyId : null;
    // ON CONFLICT DO NOTHING: a concurrent first issue for the same client loses the race on the partial unique index
    // and simply reads the winner's row below.
    await c.query(
      `INSERT INTO finance_ar_customers (tenant_id, code, name, client_id, payment_terms_days, counterparty_company_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [f.tenantId, `CL-${f.clientId}`, f.clientName, f.clientId, f.termsDays ?? 30, counterparty],
    );
    r = await find();
  }
  if (!r.rows[0]) {
    throw new ConflictException({ message: "could not create the client's receivables customer (its code is taken)", reason: "conflict" });
  }
  return { id: r.rows[0].id, termsDays: Number(r.rows[0].terms) };
}

export interface IssuedView {
  id: string;
  status: string;
  invoiceNo: string;
  issueDate: string;
  dueDate: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  currency: string;
  arInvoiceId: string;
  alreadyIssued: boolean;
}

async function issuedView(c: PoolClient, invoiceId: string, alreadyIssued: boolean): Promise<IssuedView> {
  const r = await c.query(
    `SELECT id, status, invoice_no AS "invoiceNo", to_char(issue_date, 'YYYY-MM-DD') AS "issueDate",
            to_char(due_date, 'YYYY-MM-DD') AS "dueDate", subtotal::text AS subtotal, tax_total::text AS "taxTotal",
            total::text AS total, currency, ar_invoice_id AS "arInvoiceId"
       FROM invoices WHERE id = $1`,
    [invoiceId],
  );
  return { ...r.rows[0], alreadyIssued };
}

/**
 * POST …/issue. Idempotent: a second call answers the issued invoice (`alreadyIssued: true`). Refuses with every
 * blocker (409, nothing written) when readiness fails INSIDE the transaction, on the locked row.
 */
export async function issueInvoice(
  tenantId: string,
  invoiceId: string,
  actorId: string | null,
  /** SEEDS ONLY (never reachable over HTTP): issue as of an earlier date, so a demo can show an invoice that is
   *  overdue today. Readiness still requires an open period containing that date. */
  opts: { issueDate?: string } = {},
): Promise<IssuedView> {
  if (!actorId) throw new ForbiddenException("issuing needs a known user (issued_by)");
  return mapLedgerErrors(
    withBilling(tenantId, async (c) => {
      // Row lock first: two concurrent issues of ONE invoice serialise here, and the loser sees issued_at below.
      const f = await loadFacts(c, tenantId, invoiceId, true, opts.issueDate ?? null);
      if (!f) throw new NotFoundException("invoice not found");
      if (f.issuedAt) return issuedView(c, invoiceId, true);

      // 1. Readiness, re-checked on the locked row. The GET is advice; this is the gate.
      const blockers = blockersFor(f);
      if (blockers.length > 0) throw new IssueBlockedError(blockers);

      const before = await snapshotInvoice(c, invoiceId);

      // 2. The client's AR customer.
      const customer = await ensureArCustomer(c, f);

      // 3. The number. The series row stays locked until commit; a rollback returns the number.
      const year = Number(f.today.slice(0, 4));
      const invoiceNo = formatNo(f.invoicePrefix as string, year, await nextNumber(c, tenantId, "invoice", year));

      // 4. Lines and tax, computed in the database as numeric. Tax per line through finance_tax_compute(), rounded to
      //    the currency's minor unit; the statutory rate is recorded on the line (decision 8).
      const lines = await c.query<{
        ord: string; description: string; quantity: string; unitPrice: string; amount: string;
        taxRate: string | null; taxAmount: string; subtotal: string; taxTotal: string;
      }>(
        `WITH src AS (
           SELECT x.ord, x.l, (x.l->>'amount')::numeric AS amount,
                  CASE WHEN jsonb_typeof(x.l->'hours') = 'number' AND (x.l->>'hours')::numeric > 0
                        AND jsonb_typeof(x.l->'rate') = 'number' AND (x.l->>'rate')::numeric >= 0
                       THEN true ELSE false END AS per_hour
             FROM invoices i
             CROSS JOIN LATERAL jsonb_array_elements(i.lines) WITH ORDINALITY AS x(l, ord)
            WHERE i.id = $1
         ), taxed AS (
           SELECT s.ord,
                  left(COALESCE(NULLIF(btrim(s.l->>'description'), ''), 'Services'), 500) AS description,
                  CASE WHEN s.per_hour THEN (s.l->>'hours')::numeric ELSE 1 END AS quantity,
                  CASE WHEN s.per_hour THEN (s.l->>'rate')::numeric ELSE s.amount END AS unit_price,
                  s.amount,
                  CASE WHEN $3::text IS NULL THEN NULL ELSE t.rate END AS tax_rate,
                  CASE WHEN $3::text IS NULL THEN 0
                       ELSE round(finance_tax_compute($2, $3::text, s.amount, $4::date), $5::int) END AS tax_amount
             FROM src s
             LEFT JOIN LATERAL (
               SELECT tc.rate FROM finance_tax_codes tc
                WHERE tc.tenant_id = $2 AND tc.code = $3::text AND $4::date >= tc.effective_from
                  AND (tc.effective_to IS NULL OR $4::date <= tc.effective_to)
                ORDER BY tc.effective_from DESC LIMIT 1
             ) t ON true
         )
         SELECT ord::text, description, quantity::text, unit_price::text AS "unitPrice", amount::text,
                tax_rate::text AS "taxRate", tax_amount::text AS "taxAmount",
                (sum(amount) OVER ())::text AS subtotal, (sum(tax_amount) OVER ())::text AS "taxTotal"
           FROM taxed ORDER BY ord`,
        [invoiceId, tenantId, f.taxCode, f.today, f.minorUnit],
      );
      const subtotal = lines.rows[0].subtotal;
      const taxTotal = lines.rows[0].taxTotal;

      // 5. The ledger AR invoice (same number, same totals), its lines, and the posting.
      const ar = await c.query<{ id: string; dueDate: string }>(
        `INSERT INTO finance_ar_invoices
           (tenant_id, customer_id, invoice_no, invoice_date, due_date, currency_code,
            subtotal, tax_total, total, amount_paid, status, notes)
         VALUES ($1, $2, $3, $4::date, $4::date + $5::int, $6, $7::numeric, $8::numeric, $7::numeric + $8::numeric, 0, 'draft', $9)
         RETURNING id, to_char(due_date, 'YYYY-MM-DD') AS "dueDate"`,
        [tenantId, customer.id, invoiceNo, f.today, customer.termsDays, f.currency, subtotal, taxTotal,
         `Issued from invoice ${invoiceId}`],
      );
      const arId = ar.rows[0].id;
      for (const l of lines.rows) {
        await c.query(
          `INSERT INTO finance_ar_invoice_lines
             (tenant_id, invoice_id, line_no, description, quantity, unit_price, line_subtotal,
              revenue_account_id, tax_code, tax_rate, tax_amount)
           VALUES ($1, $2, $3::int, $4, $5::numeric, $6::numeric, $7::numeric, $8, $9, $10::numeric, $11::numeric)`,
          [tenantId, arId, l.ord, l.description, l.quantity, l.unitPrice, l.amount, f.revenueAccountId,
           f.taxCode, l.taxRate, l.taxAmount],
        );
      }
      await c.query(`SELECT finance_ar_issue_invoice($1, $2)`, [arId, actorId]);

      // 6. The invoice of record, with the issuer frozen as it is today (decision 5).
      const issuer = {
        legalName: f.legalName,
        address: f.address,
        npwp: f.npwp,
        isPkp: f.isPkp,
        bank: { name: f.bankName, accountName: f.bankAccountName, accountNo: f.bankAccountNo },
      };
      const upd = await c.query(
        `UPDATE invoices
            SET status = 'sent', invoice_no = $2, issued_at = now(), issued_by = $3, issue_date = $4::date,
                due_date = $5::date, subtotal = $6::numeric, tax_total = $7::numeric, total = $6::numeric + $7::numeric,
                issuer = $8::jsonb, ar_invoice_id = $9, updated_by = $3, updated_at = now()
          WHERE id = $1 AND issued_at IS NULL AND status = 'approved'`,
        [invoiceId, invoiceNo, actorId, f.today, ar.rows[0].dueDate, subtotal, taxTotal, JSON.stringify(issuer), arId],
      );
      if (upd.rowCount !== 1) throw new ConflictException({ message: "the invoice changed while it was being issued; nothing was written", reason: "conflict" });

      // 7. Event and revision, in the same transaction.
      await emitEvent(c, tenantId, "invoice", invoiceId, "invoice.issued", {
        invoiceNo, arInvoiceId: arId, clientId: f.clientId, currency: f.currency, subtotal, taxTotal,
      });
      // `status_changed`: invoice_revisions.action is a closed CHECK list (0108) and issuing IS a status change
      // (approved -> sent); changed_fields records every invoice-of-record column it set.
      await recordInvoiceRevision(c, tenantId, invoiceId, actorId, "status_changed", before);
      return issuedView(c, invoiceId, false);
    }),
  );
}

/**
 * POST …/void for an ISSUED invoice (decision 9): posts a credit note for the full amount, applies it, and marks both the
 * AR invoice and the invoice `void`, in one transaction. A part-paid (or credited, or written-off) invoice is refused:
 * that is a refund question for Finance, not a status change. A pending payment claim must be decided first.
 */
export async function voidIssuedInvoice(
  tenantId: string, invoiceId: string, actorId: string | null, reason: string,
): Promise<{ id: string; status: "void"; creditNoteId: string | null; alreadyVoid: boolean }> {
  if (!actorId) throw new ForbiddenException("voiding needs a known user");
  return mapLedgerErrors(
    withBilling(tenantId, async (c) => {
      const inv = await c.query<{ status: string; issuedAt: string | null; arInvoiceId: string | null; prefix: string | null }>(
        `SELECT i.status, i.issued_at AS "issuedAt", i.ar_invoice_id AS "arInvoiceId", bp.invoice_prefix AS prefix
           FROM invoices i LEFT JOIN company_billing_profiles bp ON bp.tenant_id = i.tenant_id
          WHERE i.id = $1 AND i.tenant_id = $2 AND i.deleted_at IS NULL
          FOR UPDATE OF i`,
        [invoiceId, tenantId],
      );
      const row = inv.rows[0];
      if (!row) throw new NotFoundException("invoice not found");
      if (!row.issuedAt || !row.arInvoiceId) {
        throw new ConflictException({ message: "this invoice was never issued; cancel it with PATCH status=void instead", reason: "not_issued" });
      }
      if (row.status === "void") return { id: invoiceId, status: "void" as const, creditNoteId: null, alreadyVoid: true };
      if (row.status !== "sent") {
        throw new ConflictException({ message: `a ${row.status} invoice cannot be voided; raise a credit note in Finance`, reason: "not_voidable" });
      }

      const pending = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM invoice_payments WHERE invoice_id = $1 AND status = 'pending' AND deleted_at IS NULL`,
        [invoiceId],
      );
      if (Number(pending.rows[0].n) > 0) {
        throw new ConflictException({ message: "a payment claim on this invoice is still pending; confirm or reject it first", reason: "pending_payment" });
      }

      const ar = await c.query<{
        customerId: string; currency: string; subtotal: string; taxTotal: string; total: string; untouched: boolean; status: string;
      }>(
        `SELECT customer_id AS "customerId", currency_code AS currency, subtotal::text AS subtotal,
                tax_total::text AS "taxTotal", total::text AS total, status,
                (amount_paid = 0 AND amount_credited = 0 AND amount_written_off = 0) AS untouched
           FROM finance_ar_invoices WHERE id = $1 FOR UPDATE`,
        [row.arInvoiceId],
      );
      const a = ar.rows[0];
      // Zero rows here is the module-wall trap or a broken link, never "nothing to do": refuse loudly.
      if (!a) throw new ConflictException({ message: "the ledger invoice behind this invoice could not be read", reason: "ledger_missing" });
      if (!a.untouched || a.status !== "issued") {
        throw new ConflictException({
          message: "part of this invoice has been paid, credited or written off; it cannot be voided, raise a credit note in Finance",
          reason: "not_voidable",
        });
      }

      const before = await snapshotInvoice(c, invoiceId);
      const today = (await c.query<{ d: string }>(`SELECT to_char(current_date, 'YYYY-MM-DD') AS d`)).rows[0].d;
      const year = Number(today.slice(0, 4));
      const cnNo = formatNo(row.prefix ?? "INV", year, await nextNumber(c, tenantId, "credit_note", year), "CN");
      const cnId = newId();
      await c.query(
        `INSERT INTO finance_ar_credit_notes
           (id, tenant_id, customer_id, credit_note_no, credit_note_date, currency_code, subtotal, tax_total, total,
            reason_code, reason, original_invoice_id)
         VALUES ($1, $2, $3, $4, $5::date, $6, $7::numeric, $8::numeric, $9::numeric, 'other', $10, $11)`,
        [cnId, tenantId, a.customerId, cnNo, today, a.currency, a.subtotal, a.taxTotal, a.total,
         `Void of issued invoice: ${reason}`.slice(0, 1000), row.arInvoiceId],
      );
      // A void cancels the sale, so each line reverses the revenue account it was booked to (not contra-revenue, which
      // is for returns and discounts on a sale that stands). The output VAT is reversed by the credit note's VAT line.
      await c.query(
        `INSERT INTO finance_ar_credit_note_lines (tenant_id, credit_note_id, description, line_subtotal, credit_account_id, sort_order)
         SELECT $1, $2, l.description, l.line_subtotal, l.revenue_account_id, l.line_no
           FROM finance_ar_invoice_lines l
          WHERE l.invoice_id = $3 AND l.line_subtotal > 0
          ORDER BY l.line_no`,
        [tenantId, cnId, row.arInvoiceId],
      );
      await c.query(`SELECT finance_ar_issue_credit_note($1, $2)`, [cnId, actorId]);
      await c.query(`SELECT finance_ar_apply_credit($1, $2, $3::numeric, $4)`, [cnId, row.arInvoiceId, a.total, actorId]);
      await c.query(`UPDATE finance_ar_invoices SET status = 'void', updated_at = now() WHERE id = $1`, [row.arInvoiceId]);

      const upd = await c.query(
        `UPDATE invoices SET status = 'void', updated_by = $2, updated_at = now() WHERE id = $1 AND status = 'sent'`,
        [invoiceId, actorId],
      );
      if (upd.rowCount !== 1) throw new ConflictException({ message: "the invoice changed while it was being voided; nothing was written", reason: "conflict" });
      await emitEvent(c, tenantId, "invoice", invoiceId, "invoice.voided", { arInvoiceId: row.arInvoiceId, creditNoteId: cnId, creditNoteNo: cnNo });
      await recordInvoiceRevision(c, tenantId, invoiceId, actorId, "status_changed", before);
      return { id: invoiceId, status: "void" as const, creditNoteId: cnId, alreadyVoid: false };
    }),
  );
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// Payments against an issued invoice
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

/** The ledger's view of what is still owed on an issued invoice, net of pending client claims. All numeric strings. */
export interface Headroom {
  outstanding: string;
  pending: string;
  headroom: string;
  minorUnit: number;
}

/** Outstanding per the AR invoice (total - paid - credited - written off), minus pending claims. `c` must be withBilling. */
export async function claimHeadroom(c: PoolClient, invoiceId: string): Promise<Headroom | null> {
  const r = await c.query<{ outstanding: string; pending: string; headroom: string; minorUnit: number }>(
    `SELECT (a.total - a.amount_paid - a.amount_credited - a.amount_written_off)::text AS outstanding,
            COALESCE(p.pending, 0)::text AS pending,
            (a.total - a.amount_paid - a.amount_credited - a.amount_written_off - COALESCE(p.pending, 0))::text AS headroom,
            COALESCE(cur.minor_unit, 2)::int AS "minorUnit"
       FROM invoices i
       JOIN finance_ar_invoices a ON a.id = i.ar_invoice_id
       LEFT JOIN finance_currencies cur ON cur.code = a.currency_code
       LEFT JOIN LATERAL (
         SELECT sum(pp.amount) AS pending FROM invoice_payments pp
          WHERE pp.invoice_id = i.id AND pp.status = 'pending' AND pp.deleted_at IS NULL
       ) p ON true
      WHERE i.id = $1`,
    [invoiceId],
  );
  return r.rows[0] ? { ...r.rows[0], minorUnit: Number(r.rows[0].minorUnit) } : null;
}

/** True when `amount` (a decimal string) has no more decimals than the currency allows. */
export async function hasCurrencyPrecision(c: PoolClient, amount: string, minorUnit: number): Promise<boolean> {
  const r = await c.query<{ ok: boolean }>(`SELECT $1::numeric = round($1::numeric, $2::int) AS ok`, [amount, minorUnit]);
  return r.rows[0].ok === true;
}

/**
 * Confirming a payment on an ISSUED invoice posts it: an AR receipt into the billing profile's bank ledger account
 * (`finance_ar_record_receipt`: DR bank, CR AR), then its allocation to the AR invoice (`finance_ar_allocate`). The
 * invoice becomes `paid` exactly when the AR invoice does, in the same transaction. `c` must be withBilling, and the
 * caller has already moved the payment row to `confirmed` in this transaction.
 */
export async function postConfirmedPayment(
  c: PoolClient,
  tenantId: string,
  p: { paymentId: string; invoiceId: string; amount: string; currency: string; paidOn: string; reference: string | null; actorId: string },
): Promise<{ invoicePaid: boolean; receiptId: string }> {
  const inv = await c.query<{ arInvoiceId: string; currency: string; prefix: string | null; bankAccountId: string | null; bankCode: string | null }>(
    `SELECT i.ar_invoice_id AS "arInvoiceId", i.currency, bp.invoice_prefix AS prefix,
            bp.bank_ledger_account_code AS "bankCode",
            (SELECT fa.id FROM finance_accounts fa
              WHERE fa.tenant_id = i.tenant_id AND fa.code = bp.bank_ledger_account_code AND fa.deleted_at IS NULL
                AND fa.status = 'active' AND fa.is_postable AND NOT fa.is_control LIMIT 1) AS "bankAccountId"
       FROM invoices i LEFT JOIN company_billing_profiles bp ON bp.tenant_id = i.tenant_id
      WHERE i.id = $1 FOR UPDATE OF i`,
    [p.invoiceId],
  );
  const row = inv.rows[0];
  if (!row?.arInvoiceId) throw new ConflictException({ message: "this invoice is not issued", reason: "not_issued" });
  if (p.currency !== row.currency) {
    throw new ConflictException({ message: `the payment is in ${p.currency} but the invoice is in ${row.currency}`, reason: "currency_mismatch" });
  }
  if (!row.bankAccountId) {
    throw new ConflictException({
      message: `the billing profile's receipt account ${row.bankCode ?? "(not set)"} is not a live, postable account; set it before confirming`,
      reason: "no_receipt_account",
    });
  }

  const ar = await c.query<{ customerId: string; fits: boolean; outstanding: string }>(
    `SELECT customer_id AS "customerId",
            ($2::numeric <= total - amount_paid - amount_credited - amount_written_off) AS fits,
            (total - amount_paid - amount_credited - amount_written_off)::text AS outstanding
       FROM finance_ar_invoices WHERE id = $1 FOR UPDATE`,
    [row.arInvoiceId, p.amount],
  );
  const a = ar.rows[0];
  if (!a) throw new ConflictException({ message: "the ledger invoice behind this invoice could not be read", reason: "ledger_missing" });
  if (!a.fits) {
    throw new ConflictException({
      message: `the payment (${p.amount}) is more than the ${a.outstanding} ${row.currency} still outstanding; reject it and ask for the right amount`,
      reason: "overpayment",
    });
  }

  const year = Number(p.paidOn.slice(0, 4));
  const receiptNo = formatNo(row.prefix ?? "INV", year, await nextNumber(c, tenantId, "receipt", year), "RC");
  const receiptId = newId();
  await c.query(
    `INSERT INTO finance_ar_receipts
       (id, tenant_id, customer_id, receipt_no, receipt_date, currency_code, amount, bank_account_id, reference)
     VALUES ($1, $2, $3, $4, $5::date, $6, $7::numeric, $8, $9)`,
    [receiptId, tenantId, a.customerId, receiptNo, p.paidOn, p.currency, p.amount, row.bankAccountId,
     (p.reference ?? `invoice payment ${p.paymentId}`).slice(0, 200)],
  );
  await c.query(`SELECT finance_ar_record_receipt($1, $2)`, [receiptId, p.actorId]);
  await c.query(`SELECT finance_ar_allocate($1, $2, $3::numeric, $4)`, [receiptId, row.arInvoiceId, p.amount, p.actorId]);
  await c.query(`UPDATE invoice_payments SET ar_receipt_id = $2 WHERE id = $1`, [p.paymentId, receiptId]);

  // Paid is DERIVED from the ledger: the invoice flips exactly when the AR invoice is fully allocated.
  const st = await c.query<{ status: string }>(`SELECT status FROM finance_ar_invoices WHERE id = $1`, [row.arInvoiceId]);
  let invoicePaid = false;
  if (st.rows[0]?.status === "paid") {
    const before = await snapshotInvoice(c, p.invoiceId);
    const res = await c.query(
      `UPDATE invoices SET status = 'paid', updated_by = $2, updated_at = now() WHERE id = $1 AND status = 'sent'`,
      [p.invoiceId, p.actorId],
    );
    if (res.rowCount && res.rowCount > 0) {
      invoicePaid = true;
      await recordInvoiceRevision(c, tenantId, p.invoiceId, p.actorId, "paid_via_payment_confirmation", before);
      await emitEvent(c, tenantId, "invoice", p.invoiceId, "invoice.updated", { status: "paid" });
    }
  }
  return { invoicePaid, receiptId };
}
