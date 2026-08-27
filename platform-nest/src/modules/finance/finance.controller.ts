// Finance & Accounting BFF surface. Mounted at /api/:tenantId/finance/*, gated by
// ModuleEnabledGuard("finance") and Cerbos on every handler.
//
// ── THIS CONTROLLER COMPUTES NO ACCOUNTING ──────────────────────────────────────────────────────
// Every figure below comes from a SQL function built in migrations 202608241010..1028. Balance
// validation, immutability, the hash chain, the subledger tie-outs and the statements are all
// enforced next to the data, where a script cannot walk past them. This file authorizes, scopes
// and shapes JSON. If a handler here ever starts doing arithmetic on money, that arithmetic is in
// the wrong place.
//
// ── withFinance() IS THE ONLY DATABASE PATH, AND THAT IS NOT STYLE ──────────────────────────────
// Every finance_* table composes the third wall:
//     tenant_id = ANY(app_current_tenants()) AND app_module_allowed('finance')
// A plain withTenants() call reads and writes ZERO ROWS and raises NOTHING — the handler returns an
// empty list and looks like it worked. That silent-empty failure is the single most likely bug in
// this file, so there is exactly one helper and nothing calls withTenants directly.
import {
  BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { withTenants } from "../../db";
import { authorize } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";

/** The ONLY way this module reaches the database. See the header. */
function withFinance<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants([tenantId], fn, { modules: ["finance"] });
}

/** ISO date or nothing. Rejects rather than silently coercing — a bad date that becomes `null`
 *  turns "as at 30 June" into "as at today" and returns a confidently wrong statement. */
function isoDate(value: string | undefined, field: string): string | null {
  if (value == null || value === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException(`${field} must be an ISO date (YYYY-MM-DD)`);
  }
  return value;
}
/**
 * Refuse unless the caller echoed the object's own name back.
 *
 * Server-side on purpose. A confirmation implemented only in a form protects nobody calling the API
 * directly — including an agent, which this program explicitly expects to have. The comparison is
 * trimmed but CASE-SENSITIVE: "aug 2026" is not proof of having read "Aug 2026", and the whole
 * point of the gate is that supplying the string requires having looked at it.
 */
function requireConfirmation(supplied: string | undefined, expected: string, what: string): void {
  if ((supplied ?? "").trim() !== expected) {
    throw new BadRequestException(
      `confirmation does not match — type the ${what} exactly as "${expected}" to proceed. `
      + `This action cannot be undone by an ordinary correction.`,
    );
  }
}

function requiredIsoDate(value: string | undefined, field: string): string {
  const d = isoDate(value, field);
  if (d == null) throw new BadRequestException(`${field} is required`);
  return d;
}

interface PostJournalBody {
  date?: string;
  sourceEventId?: string;
  description?: string;
  lines?: Array<{ accountCode?: string; side?: string; amount?: number | string; memo?: string }>;
}

interface ArInvoiceBody {
  customerId?: string;
  invoiceNo?: string;
  invoiceDate?: string;
  dueDate?: string;
  currencyCode?: string;
  lines?: Array<{
    description?: string; quantity?: number | string; unitPrice?: number | string;
    revenueAccountCode?: string; taxCode?: string; taxRate?: number | string;
  }>;
}

/**
 * The return kinds `finance_tax_returns.kind` accepts (202608241025).
 *
 * Kept in step with that CHECK constraint by hand — a value here the constraint rejects becomes a
 * 500 at INSERT instead of the field-level 400 this list exists to produce.
 * `pph_badan` is the only annual one (SPT Tahunan); the rest are monthly (SPT Masa).
 */
const TAX_RETURN_KINDS = ["ppn", "pph21", "pph23", "pph42", "pph_badan"];

interface ArCreditNoteBody {
  customerId?: string;
  creditNoteNo?: string;
  creditNoteDate?: string;
  currencyCode?: string;
  /** Why the credit exists. A code, so a revenue-leakage report can group by it. */
  reasonCode?: string;
  reason?: string;
  /** The invoice this credit RELATES to. Records intent; does not apply it. */
  originalInvoiceId?: string;
  /** Optional immediate application. Omit to leave the credit ON ACCOUNT. */
  applyToInvoiceId?: string;
  applyAmount?: number | string;
  lines?: Array<{
    description?: string; amount?: number | string;
    /** Contra-revenue (4300 Retur Penjualan / 4200 Potongan Penjualan), not the original revenue
     *  account — netting them hides a deteriorating return rate entirely. */
    creditAccountCode?: string; taxRate?: number | string;
  }>;
}

interface ArReceiptBody {
  customerId?: string;
  receiptNo?: string;
  receiptDate?: string;
  currencyCode?: string;
  amount?: number | string;
  bankAccountCode?: string;
  reference?: string;
  /** Optional immediate allocation. Omit to leave the money ON ACCOUNT. */
  allocations?: Array<{ invoiceId?: string; amount?: number | string }>;
}

interface ApBillBody {
  vendorId?: string;
  billNo?: string;
  billDate?: string;
  dueDate?: string;
  currencyCode?: string;
  /** A RATE (0.02 for PPh 23 at 2%), matching the column — not a percentage. */
  withholdingRate?: number | null;
  withholdingCode?: string;
  withholdingAccountCode?: string;
  lines?: Array<{
    description?: string; quantity?: number | string; unitPrice?: number | string;
    expenseAccountCode?: string; taxCode?: string; taxRate?: number | string;
  }>;
}

interface ApPaymentBody {
  vendorId?: string;
  paymentNo?: string;
  paymentDate?: string;
  currencyCode?: string;
  amount?: number | string;
  bankAccountCode?: string;
  reference?: string;
  allocations?: Array<{ billId?: string; amount?: number | string }>;
}

interface InstrumentBody {
  code?: string; name?: string; kind?: string; counterpartyName?: string;
  currencyCode?: string; principal?: number | string;
  /** A PERCENT (11.5 for 11.5%) — unlike AP withholding, which is a rate. The columns differ. */
  nominalRate?: number | null; effectiveRate?: number | null;
  startDate?: string; maturityDate?: string;
  paymentMonths?: number; repaymentMethod?: string;
}

interface OwnershipBody {
  holderUserId?: string | null;
  holderCompanyId?: string | null;
  kind?: string;
  stakePct?: number | string | null;
  effectiveFrom?: string;
  notes?: string;
}

interface SettingsBody {
  isPkp?: boolean;
  npwp?: string | null;
  functionalCurrency?: string;
  presentationCurrency?: string;
}

@Controller("api")
@UseGuards(AuthGuard, ModuleEnabledGuard("finance"))
export class FinanceController {
  // ── Chart of accounts and calendar ────────────────────────────────────────────────────────────
  @Get(":tenantId/finance/accounts")
  async accounts(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("q") q?: string) {
    await authorize(req.principal, { kind: "finance_config", tenantId, module: "finance" }, "read");
    const rows = await withFinance(tenantId, (c) =>
      c.query(
        `SELECT code, name, account_type AS "accountType", normal_balance AS "normalBalance",
                is_postable AS "isPostable", is_control AS "isControl",
                control_subledger AS "controlSubledger",
                allow_manual_posting AS "allowManualPosting", status,
                (first_posted_at IS NOT NULL) AS "hasPostings"
           FROM finance_accounts
          WHERE tenant_id = $1 AND deleted_at IS NULL
            AND ($2::text IS NULL OR code ILIKE '%' || $2 || '%' OR name ILIKE '%' || $2 || '%')
          ORDER BY code`,
        [tenantId, q?.trim() || null],
      ),
    );
    return rows.rows;
  }

  /**
   * The fiscal years, with the id `POST /fiscal-years/:id/close` needs.
   *
   * Added because closing a year was reachable only by somebody who already had the uuid: nothing
   * returned one. `GET /periods` carries the year CODE and not its id, so a console could show the
   * years and could not act on one — the UI correctly rendered a BackendPending rather than guessing
   * an identifier, which is the right failure but not a usable surface.
   *
   * `periodCount` / `openPeriods` come along because "close this year" is not answerable without
   * them: a year with open periods inside it is not closeable, and finding that out from a refusal
   * after typing a confirmation is a worse experience than seeing it on the row.
   */
  @Get(":tenantId/finance/fiscal-years")
  async fiscalYears(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "finance_period", tenantId, module: "finance" }, "read");
    const rows = await withFinance(tenantId, (c) =>
      c.query(
        `SELECT y.id, y.code, y.start_date::text AS "startDate", y.end_date::text AS "endDate",
                y.status,
                (SELECT count(*) FROM finance_fiscal_periods p
                  WHERE p.tenant_id = y.tenant_id AND p.fiscal_year_id = y.id)::int AS "periodCount",
                (SELECT count(*) FROM finance_fiscal_periods p
                  WHERE p.tenant_id = y.tenant_id AND p.fiscal_year_id = y.id AND p.state = 'OPEN')::int AS "openPeriods"
           FROM finance_fiscal_years y
          WHERE y.tenant_id = $1
          ORDER BY y.start_date DESC`,
        [tenantId],
      ),
    );
    return rows.rows;
  }

  @Get(":tenantId/finance/periods")
  async periods(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "finance_period", tenantId, module: "finance" }, "read");
    const rows = await withFinance(tenantId, (c) =>
      c.query(
        `SELECT p.id, p.period_no AS "periodNo", p.name, -- ::text, NOT the bare date column. pg maps a date to a JS Date, which
                -- JSON.stringify renders as a full ISO DATETIME. The UI reads endDate and passes it
                -- back as asOf, and this API's own isoDate() rejects it -- a 400 that took the whole
                -- /finance page down, because financeData() only degrades 403/404. Postgres renders
                -- date::text as exactly YYYY-MM-DD, which is what the contract says these are.
                p.start_date::text AS "startDate",
                p.end_date::text AS "endDate", p.state,
                (p.signed_off_by IS NOT NULL) AS "signedOff", fy.code AS "fiscalYear"
           FROM finance_fiscal_periods p
           JOIN finance_fiscal_years fy ON fy.id = p.fiscal_year_id
          WHERE p.tenant_id = $1
          ORDER BY p.start_date`,
        [tenantId],
      ),
    );
    return rows.rows;
  }

  // ── Statements ────────────────────────────────────────────────────────────────────────────────
  @Get(":tenantId/finance/trial-balance")
  async trialBalance(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("asOf") asOf?: string,
    @Query("from") from?: string,
  ) {
    await authorize(req.principal, { kind: "finance_statement", tenantId, module: "finance" }, "read");
    const rows = await withFinance(tenantId, (c) =>
      c.query(
        `SELECT code, name, account_type AS "accountType", debit, credit, balance
           FROM finance_trial_balance($1, $2::date, $3::date)`,
        [tenantId, isoDate(asOf, "asOf"), isoDate(from, "from")],
      ),
    );
    // The defining property of a trial balance, returned alongside it rather than left for the
    // caller to recompute — and if it is ever false that is a finding, not a rounding note.
    const totalDebit = rows.rows.reduce((a, r: any) => a + Number(r.debit), 0);
    const totalCredit = rows.rows.reduce((a, r: any) => a + Number(r.credit), 0);
    return { rows: rows.rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
  }

  @Get(":tenantId/finance/profit-and-loss")
  async profitAndLoss(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    await authorize(req.principal, { kind: "finance_statement", tenantId, module: "finance" }, "read");
    // A P&L is FLOW, not stock — "as at a date" is a category error, so both bounds are required.
    const rows = await withFinance(tenantId, (c) =>
      c.query(
        `SELECT section, code, name, amount FROM finance_profit_and_loss($1, $2::date, $3::date)`,
        [tenantId, requiredIsoDate(from, "from"), requiredIsoDate(to, "to")],
      ),
    );
    return rows.rows;
  }

  @Get(":tenantId/finance/balance-sheet")
  async balanceSheet(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("asOf") asOf?: string,
    @Query("fyStart") fyStart?: string,
  ) {
    await authorize(req.principal, { kind: "finance_statement", tenantId, module: "finance" }, "read");
    // fyStart is REQUIRED, not defaulted: "profit so far" is meaningless without knowing when the
    // year began, and not every company's fiscal year starts in January. Defaulting it would
    // silently produce a wrong sheet for exactly the companies the holding is most likely to buy.
    const rows = await withFinance(tenantId, (c) =>
      c.query(
        `SELECT section, code, name, amount FROM finance_balance_sheet($1, $2::date, $3::date)`,
        [tenantId, requiredIsoDate(asOf, "asOf"), requiredIsoDate(fyStart, "fyStart")],
      ),
    );
    const total = (code: string) => Number(rows.rows.find((r: any) => r.code === code)?.amount ?? 0);
    const assets = total("TOTAL_ASSETS");
    const liabilities = total("TOTAL_LIABILITIES");
    const equity = total("TOTAL_EQUITY");
    return { rows: rows.rows, assets, liabilities, equity, balanced: assets === liabilities + equity };
  }

  @Get(":tenantId/finance/general-ledger/:code")
  async generalLedger(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("code") code: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    await authorize(req.principal, { kind: "finance_statement", tenantId, module: "finance" }, "read");
    const rows = await withFinance(tenantId, (c) =>
      c.query(
        `SELECT ledger_sequence AS "ledgerSequence", entry_date::text AS "entryDate", description, memo,
                side, amount, running_balance AS "runningBalance", entry_kind AS "entryKind"
           FROM finance_general_ledger($1, $2, $3::date, $4::date)`,
        [tenantId, code, isoDate(from, "from"), isoDate(to, "to")],
      ),
    );
    return rows.rows;
  }

  // ── The ledger ────────────────────────────────────────────────────────────────────────────────
  @Get(":tenantId/finance/journals")
  async journals(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("limit") limit?: string,
  ) {
    await authorize(req.principal, { kind: "finance_ledger", tenantId, module: "finance" }, "read");
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const rows = await withFinance(tenantId, (c) =>
      c.query(
        `SELECT e.id, e.ledger_sequence AS "ledgerSequence", e.entry_date::text AS "entryDate", e.kind,
                e.description, e.currency_code AS "currency", e.total_debit AS "totalDebit",
                e.source_event_id AS "sourceEventId",
                finance_journal_entry_status(e.id) AS status
           FROM finance_journal_entries e
          WHERE e.tenant_id = $1
          ORDER BY e.ledger_sequence DESC
          LIMIT $2`,
        [tenantId, n],
      ),
    );
    return rows.rows;
  }

  @Get(":tenantId/finance/journals/:entryId")
  async journal(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("entryId") entryId: string) {
    await authorize(req.principal, { kind: "finance_ledger", id: entryId, tenantId, module: "finance" }, "read");
    return withFinance(tenantId, async (c) => {
      const head = await c.query(
        `SELECT id, ledger_sequence AS "ledgerSequence", entry_date::text AS "entryDate", kind, description,
                currency_code AS "currency", total_debit AS "totalDebit", total_credit AS "totalCredit",
                source_event_id AS "sourceEventId", reversal_of_id AS "reversalOfId",
                reversal_reason AS "reversalReason", entry_hash AS "entryHash",
                finance_journal_entry_status(id) AS status
           FROM finance_journal_entries WHERE id = $1`,
        [entryId],
      );
      if (!head.rows[0]) throw new NotFoundException("journal entry not found");
      const lines = await c.query(
        `SELECT l.line_no AS "lineNo", a.code AS "accountCode", a.name AS "accountName",
                l.side, l.amount, l.memo
           FROM finance_journal_lines l
           JOIN finance_accounts a ON a.id = l.account_id
          WHERE l.entry_id = $1 ORDER BY l.line_no`,
        [entryId],
      );
      return { ...head.rows[0], lines: lines.rows };
    });
  }

  @Post(":tenantId/finance/journals")
  async postJournal(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: PostJournalBody,
  ) {
    await authorize(req.principal, { kind: "finance_ledger", tenantId, module: "finance" }, "post");

    const date = requiredIsoDate(body?.date, "date");
    const sourceEventId = body?.sourceEventId?.trim();
    const description = body?.description?.trim();
    if (!sourceEventId) throw new BadRequestException("sourceEventId is required — every journal must be traceable to an event");
    if (!description) throw new BadRequestException("description is required");
    if (!Array.isArray(body?.lines) || body.lines.length === 0) {
      throw new BadRequestException("at least one line is required");
    }

    // Shape only. Balance, account validity, period state and the chain are the database's job —
    // re-checking them here would be a second implementation that can drift from the first.
    const lines = body.lines.map((l, i) => {
      if (!l?.accountCode) throw new BadRequestException(`line ${i + 1}: accountCode is required`);
      if (l.side !== "debit" && l.side !== "credit") {
        throw new BadRequestException(`line ${i + 1}: side must be "debit" or "credit"`);
      }
      const amount = Number(l.amount);
      if (!Number.isFinite(amount)) throw new BadRequestException(`line ${i + 1}: amount must be a number`);
      return { account_code: l.accountCode, side: l.side, amount, memo: l.memo ?? null };
    });

    const entryId = await withFinance(tenantId, async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT finance_post_journal($1, $2::date, $3, $4, $5::jsonb, $6) AS id`,
        // userId may be null for an unresolved external identity. It lands in
        // finance_journal_entries.posted_by, which is nullable BY DESIGN — a journal with no named
        // poster is worse than one that records the gap honestly, and the source_event_id above
        // still ties the entry to what caused it.
        [tenantId, date, sourceEventId, description, JSON.stringify(lines), req.principal.userId],
      );
      return r.rows[0].id;
    });
    return { id: entryId };
  }

  @Post(":tenantId/finance/journals/:entryId/reverse")
  async reverseJournal(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("entryId") entryId: string,
    @Body() body: { reason?: string; date?: string },
  ) {
    await authorize(req.principal, { kind: "finance_ledger", id: entryId, tenantId, module: "finance" }, "reverse");
    const reason = body?.reason?.trim();
    if (!reason || reason.length < 8) {
      throw new BadRequestException("reason is required and must say why (at least 8 characters)");
    }
    const id = await withFinance(tenantId, async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT finance_reverse_journal($1, $2, $3, $4::date) AS id`,
        [entryId, reason, req.principal.userId, isoDate(body?.date, "date")],
      );
      return r.rows[0].id;
    });
    return { id };
  }

  @Get(":tenantId/finance/ledger/verify")
  async verifyLedger(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "finance_ledger", tenantId, module: "finance" }, "verify");
    const rows = await withFinance(tenantId, (c) =>
      c.query(
        `SELECT ledger_sequence AS "ledgerSequence", entry_id AS "entryId", problem, detail
           FROM finance_verify_ledger_chain($1)`,
        [tenantId],
      ),
    );
    // An EMPTY list is the pass condition — say so explicitly rather than leaving the caller to
    // infer it from a zero length, which is how a UI ends up rendering "no problems" for a query
    // that actually failed.
    return { problems: rows.rows, clean: rows.rows.length === 0 };
  }

  // ── Subledgers ────────────────────────────────────────────────────────────────────────────────
  @Get(":tenantId/finance/ar/aging")
  async arAging(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("asOf") asOf?: string) {
    await authorize(req.principal, { kind: "finance_ar", tenantId, module: "finance" }, "read");
    const rows = await withFinance(tenantId, (c) =>
      c.query(
        `SELECT customer_code AS "customerCode", customer_name AS "customerName",
                current_amt AS "current", d1_30 AS "d1To30", d31_60 AS "d31To60",
                d61_90 AS "d61To90", d90_plus AS "d90Plus", total_outstanding AS "totalOutstanding"
           FROM finance_ar_aging($1, $2::date)`,
        [tenantId, isoDate(asOf, "asOf")],
      ),
    );
    return rows.rows;
  }

  @Get(":tenantId/finance/ar/reconcile")
  async arReconcile(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("asOf") asOf?: string) {
    await authorize(req.principal, { kind: "finance_ar", tenantId, module: "finance" }, "reconcile");
    return withFinance(tenantId, async (c) => {
      const problems = await c.query(`SELECT problem, detail FROM finance_ar_reconcile($1, $2::date)`, [
        tenantId, isoDate(asOf, "asOf"),
      ]);
      const pos = await c.query(
        `SELECT open_invoices AS "openInvoices", payments_on_account AS "paymentsOnAccount",
                unapplied_credits AS "unappliedCredits", net_receivable AS "netReceivable"
           FROM finance_ar_position($1, $2::date)`,
        [tenantId, isoDate(asOf, "asOf")],
      );
      // ALL FOUR numbers, because they are NOT the same and a caller that assumes they are will
      // report a mismatch on every customer prepayment — and, since 202608270900, on every credit
      // note that is issued and not yet applied, which is a credit note's normal state. The
      // identity is open - onAccount - unappliedCredits = the AR control balance.
      return { position: pos.rows[0], problems: problems.rows, clean: problems.rows.length === 0 };
    });
  }

  @Get(":tenantId/finance/ap/aging")
  async apAging(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("asOf") asOf?: string) {
    await authorize(req.principal, { kind: "finance_ap", tenantId, module: "finance" }, "read");
    const rows = await withFinance(tenantId, (c) =>
      c.query(
        `SELECT vendor_code AS "vendorCode", vendor_name AS "vendorName",
                current_amt AS "current", d1_30 AS "d1To30", d31_60 AS "d31To60",
                d61_90 AS "d61To90", d90_plus AS "d90Plus", total_outstanding AS "totalOutstanding"
           FROM finance_ap_aging($1, $2::date)`,
        [tenantId, isoDate(asOf, "asOf")],
      ),
    );
    return rows.rows;
  }

  @Get(":tenantId/finance/ap/reconcile")
  async apReconcile(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("asOf") asOf?: string) {
    await authorize(req.principal, { kind: "finance_ap", tenantId, module: "finance" }, "reconcile");
    return withFinance(tenantId, async (c) => {
      const problems = await c.query(`SELECT problem, detail FROM finance_ap_reconcile($1, $2::date)`, [
        tenantId, isoDate(asOf, "asOf"),
      ]);
      const pos = await c.query(
        `SELECT open_bills AS "openBills", payments_on_account AS "paymentsOnAccount",
                net_payable AS "netPayable"
           FROM finance_ap_position($1, $2::date)`,
        [tenantId, isoDate(asOf, "asOf")],
      );
      return { position: pos.rows[0], problems: problems.rows, clean: problems.rows.length === 0 };
    });
  }

  // ── Tax ───────────────────────────────────────────────────────────────────────────────────────
  @Get(":tenantId/finance/tax/ppn")
  async ppn(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    await authorize(req.principal, { kind: "finance_tax", tenantId, module: "finance" }, "read");
    const r = await withFinance(tenantId, (c) =>
      c.query(
        `SELECT output_vat AS "outputVat", input_vat_creditable AS "inputVatCreditable",
                input_vat_uncreditable AS "inputVatUncreditable", net_payable AS "netPayable"
           FROM finance_tax_ppn_summary($1, $2::date, $3::date)`,
        [tenantId, requiredIsoDate(from, "from"), requiredIsoDate(to, "to")],
      ),
    );
    return r.rows[0];
  }

  @Get(":tenantId/finance/tax/efaktur-exceptions")
  async efakturExceptions(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    await authorize(req.principal, { kind: "finance_tax", tenantId, module: "finance" }, "read");
    const rows = await withFinance(tenantId, (c) =>
      c.query(
        `SELECT kind, document_no AS "documentNo", counterparty, doc_date AS "docDate",
                tax_amount AS "taxAmount", detail
           FROM finance_tax_efaktur_exceptions($1, $2::date, $3::date)`,
        [tenantId, requiredIsoDate(from, "from"), requiredIsoDate(to, "to")],
      ),
    );
    return rows.rows;
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // TAX RETURN LIFECYCLE (F7)
  //
  // 202608241025 built the DATA — finance_tax_returns, the PPN and PPh summaries, the e-Faktur
  // exception list and the Coretax reconciliation. What it left unbuilt is the lifecycle: turning a
  // live summary into a filed DOCUMENT.
  //
  // ── WHY THE FILED FIGURES ARE SNAPSHOTTED AND NEVER RECOMPUTED ────────────────────────────────
  // `finance_tax_ppn_summary()` answers "what does the data say TODAY". A return answers "what did
  // we tell DJP on the 20th". Those diverge the moment a late invoice is booked against a filed
  // period — and the gap between them is exactly what an auditor asks about, so it must be
  // preserved rather than smoothed away. filed_output / filed_input / filed_net are written ONCE,
  // at filing, and the live summary is shown alongside them afterwards so the drift is visible.
  //
  // ⚠ This does NOT transmit anything. Blueprint §6 / ruling D-F2: e-Faktur and e-Bupot go through a
  // licensed ASP/PJAP. `filingReference` records the NTPN/receipt that channel returned — evidence
  // the return was lodged, captured here rather than produced here.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  @Get(":tenantId/finance/tax/returns")
  async listTaxReturns(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("year") year?: string,
    @Query("kind") kind?: string,
  ) {
    await authorize(req.principal, { kind: "finance_tax", tenantId, module: "finance" }, "read");
    const y = year === undefined ? null : Number(year);
    if (y !== null && (!Number.isInteger(y) || y < 2000 || y > 2100)) {
      throw new BadRequestException("year must be between 2000 and 2100");
    }
    if (kind && !TAX_RETURN_KINDS.includes(kind)) {
      throw new BadRequestException(`kind must be one of ${TAX_RETURN_KINDS.join(", ")}`);
    }
    return withFinance(tenantId, async (c) => {
      const r = await c.query(
        `SELECT id, kind, period_year AS "periodYear", period_month AS "periodMonth",
                period_start::text AS "periodStart", period_end::text AS "periodEnd", status,
                filed_output AS "filedOutput", filed_input AS "filedInput", filed_net AS "filedNet",
                filed_at AS "filedAt", filing_reference AS "filingReference", notes
           FROM finance_tax_returns
          WHERE tenant_id = $1
            AND ($2::int  IS NULL OR period_year = $2)
            AND ($3::text IS NULL OR kind = $3)
          ORDER BY period_year DESC, period_month DESC NULLS LAST, kind`,
        [tenantId, y, kind ?? null],
      );
      return r.rows;
    });
  }

  /**
   * Prepare (or re-open the figures for) a return for one tax period.
   *
   * Idempotent: the table carries UNIQUE (tenant, kind, year, month), so preparing twice returns
   * the same draft rather than creating a second one. The COMPUTED figures come back every time,
   * because for a draft they are simply the live answer — there is nothing to snapshot yet.
   */
  /**
   * Prepare (or re-open the figures for) a return for one tax period.
   *
   * The lifecycle lives in SQL (`202608271230`), not here, for the same reason every other finance
   * capability does: automation and agents reach the functions directly, and a second copy of the
   * period arithmetic in TypeScript is a second place for it to be wrong. This handler validates
   * shape and authorizes; the accounting is the function's.
   */
  @Post(":tenantId/finance/tax/returns")
  @HttpCode(201)
  async prepareTaxReturn(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { kind?: string; periodYear?: number; periodMonth?: number },
  ) {
    await authorize(req.principal, { kind: "finance_tax", tenantId, module: "finance" }, "prepare");

    const kind = body?.kind;
    if (!kind || !TAX_RETURN_KINDS.includes(kind)) {
      throw new BadRequestException(`kind must be one of ${TAX_RETURN_KINDS.join(", ")}`);
    }
    const year = Number(body?.periodYear);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException("periodYear must be between 2000 and 2100");
    }
    // NULL month = an ANNUAL return (SPT Tahunan Badan). The function enforces the pairing too and
    // raises FINANCE_TAX_BADAN_IS_ANNUAL / FINANCE_TAX_PERIODIC_NEEDS_MONTH; checking here first
    // turns those into a field-level 400 instead of a 500 from a mid-statement exception.
    const monthGiven = body?.periodMonth !== undefined && body.periodMonth !== null;
    const month = monthGiven ? Number(body.periodMonth) : null;
    if (month !== null && (!Number.isInteger(month) || month < 1 || month > 12)) {
      throw new BadRequestException("periodMonth must be between 1 and 12, or omitted for an annual return");
    }
    if (kind === "pph_badan" && month !== null) {
      throw new BadRequestException("pph_badan is the ANNUAL return (SPT Tahunan Badan) — omit periodMonth");
    }
    if (kind !== "pph_badan" && month === null) {
      throw new BadRequestException(`${kind} is a monthly return (SPT Masa) — periodMonth is required`);
    }

    return withFinance(tenantId, async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT finance_tax_prepare_return($1,$2,$3,$4,$5) AS id`,
        [tenantId, kind, year, month, req.principal.userId],
      );
      const id = r.rows[0].id;
      const fig = await c.query<{ output_amount: string; input_amount: string; net_amount: string }>(
        `SELECT output_amount, input_amount, net_amount
           FROM finance_tax_return_figures($1,$2,$3,$4)`,
        [tenantId, kind, year, month],
      );
      const row = await c.query<{ status: string; period_start: string; period_end: string }>(
        `SELECT status, period_start::text AS period_start, period_end::text AS period_end
           FROM finance_tax_returns WHERE id = $1`, [id],
      );
      const f = fig.rows[0] ?? { output_amount: "0", input_amount: "0", net_amount: "0" };
      return {
        id, kind, periodYear: year, periodMonth: month,
        periodStart: row.rows[0]?.period_start, periodEnd: row.rows[0]?.period_end,
        status: row.rows[0]?.status,
        computed: {
          output: Number(f.output_amount), input: Number(f.input_amount), net: Number(f.net_amount),
        },
      };
    });
  }

  /**
   * File a prepared return, or amend a filed one: snapshot the figures AS FILED.
   *
   * Confirmation-gated on the period label, like closing a fiscal period. Filing is a statement to
   * the STATE, and the figures stop tracking the ledger the moment it happens — which is the point,
   * and is what `finance_tax_return_drift` later measures.
   */
  @Post(":tenantId/finance/tax/returns/:returnId/file")
  @HttpCode(200)
  async fileTaxReturn(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("returnId") returnId: string,
    @Body() body: { filingReference?: string; confirm?: string; amend?: boolean },
  ) {
    await authorize(req.principal, { kind: "finance_tax", tenantId, module: "finance" }, "file");

    const reference = body?.filingReference?.trim();
    if (!reference) {
      throw new BadRequestException(
        "filingReference is required — the NTPN or receipt from the ASP/PJAP is the evidence the return was actually lodged. "
        + "A return marked filed with no receipt cannot be told apart from one nobody sent.",
      );
    }

    return withFinance(tenantId, async (c) => {
      const r = await c.query<{
        kind: string; period_year: number; period_month: number | null; status: string;
      }>(
        `SELECT kind, period_year, period_month, status
           FROM finance_tax_returns WHERE id = $1 AND tenant_id = $2`,
        [returnId, tenantId],
      );
      const ret = r.rows[0];
      if (!ret) throw new NotFoundException("no such tax return in this company");

      const label = ret.period_month === null
        ? `${ret.kind.toUpperCase()} ${ret.period_year}`
        : `${ret.kind.toUpperCase()} ${ret.period_year}-${String(ret.period_month).padStart(2, "0")}`;
      requireConfirmation(body?.confirm, label, "period");

      const amending = ret.status !== "draft";
      if (amending && !body?.amend) {
        throw new BadRequestException(
          `${label} is already ${ret.status}. Re-filing replaces the figures of record — pass amend:true to file an `
          + `AMENDMENT, which is a different statement to DJP and is recorded as such.`,
        );
      }

      await c.query(
        amending
          ? `SELECT finance_tax_amend_return($1,$2,$3)`
          : `SELECT finance_tax_file_return($1,$2,$3)`,
        [returnId, reference, req.principal.userId],
      );

      const after = await c.query<{
        status: string; filed_output: string; filed_input: string; filed_net: string;
      }>(
        `SELECT status, filed_output::text, filed_input::text, filed_net::text
           FROM finance_tax_returns WHERE id = $1`, [returnId],
      );
      const a = after.rows[0];
      return {
        id: returnId, status: a?.status, period: label, filingReference: reference,
        filed: { output: Number(a?.filed_output ?? 0), input: Number(a?.filed_input ?? 0), net: Number(a?.filed_net ?? 0) },
      };
    });
  }

  /**
   * Where a FILED return no longer agrees with the ledger.
   *
   * One row per problem, empty means clean — the same shape as finance_ar_reconcile and
   * finance_verify_ledger_chain, and for the same reason. A non-empty answer means a journal was
   * posted into a period that has already been declared to DJP, which is not automatically wrong
   * (a late invoice is a real event) but always needs a decision: amend, or carry it forward.
   */
  @Get(":tenantId/finance/tax/returns/drift")
  async taxReturnDrift(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
  ) {
    await authorize(req.principal, { kind: "finance_tax", tenantId, module: "finance" }, "read");
    const rows = await withFinance(tenantId, (c) =>
      c.query(`SELECT problem, detail FROM finance_tax_return_drift($1)`, [tenantId]),
    );
    return { problems: rows.rows, clean: rows.rows.length === 0 };
  }

  // ── The close ─────────────────────────────────────────────────────────────────────────────────
  @Get(":tenantId/finance/periods/:periodId/close-readiness")
  async closeReadiness(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("periodId") periodId: string,
  ) {
    await authorize(req.principal, { kind: "finance_bank", tenantId, module: "finance" }, "reconcile");
    const rows = await withFinance(tenantId, (c) =>
      c.query(`SELECT blocker, detail FROM finance_period_close_readiness($1, $2)`, [tenantId, periodId]),
    );
    return { blockers: rows.rows, ready: rows.rows.length === 0 };
  }

  // ── The event queue (F2) ──────────────────────────────────────────────────────────────────────
  @Get(":tenantId/finance/events/backlog")
  async backlog(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "finance_posting_rule", tenantId, module: "finance" }, "read");
    const rows = await withFinance(tenantId, (c) =>
      c.query(
        `SELECT status, event_type AS "eventType", error_code AS "errorCode", count, oldest
           FROM finance_event_backlog($1)`,
        [tenantId],
      ),
    );
    return rows.rows;
  }

  @Post(":tenantId/finance/events/process")
  async processEvents(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { limit?: number },
  ) {
    await authorize(req.principal, { kind: "finance_posting_rule", tenantId, module: "finance" }, "process");
    const limit = Math.min(Math.max(Number(body?.limit) || 100, 1), 500);
    const r = await withFinance(tenantId, (c) =>
      c.query(`SELECT processed, failed FROM finance_process_pending_events($1, $2, $3)`, [
        tenantId, limit, req.principal.userId,
      ]),
    );
    return r.rows[0];
  }

  // ── UI-02a — accounting settings ──────────────────────────────────────────────────────────────
  // `finance_config` covers this: its catalog entry says "accounting settings" in so many words.
  // Ownership below deliberately does NOT reuse it — see that handler's note.
  @Get(":tenantId/finance/settings")
  async getSettings(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "finance_config", tenantId, module: "finance" }, "read");
    return withFinance(tenantId, async (c) => {
      const r = await c.query(
        `SELECT functional_currency, presentation_currency, fiscal_year_start_month, is_pkp, npwp,
                coa_template_key
           FROM finance_company_settings WHERE tenant_id = $1`,
        [tenantId],
      );
      if (r.rowCount === 0) throw new NotFoundException("this company has no accounting settings yet");
      const s = r.rows[0];
      return {
        functionalCurrency: s.functional_currency,
        presentationCurrency: s.presentation_currency,
        fiscalYearStartMonth: s.fiscal_year_start_month,
        isPkp: s.is_pkp,
        // Stored bare; the dots are decoration applied client-side. The value is the fact.
        npwp: s.npwp,
        coaTemplateKey: s.coa_template_key,
      };
    });
  }

  @Post(":tenantId/finance/settings")
  async updateSettings(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: SettingsBody,
  ) {
    await authorize(req.principal, { kind: "finance_config", tenantId, module: "finance" }, "update");

    // fiscalYearStartMonth is deliberately NOT accepted. The database refuses to move it once a
    // calendar exists, and offering a field that will be rejected is worse than omitting it: the
    // form implies it is editable and the refusal arrives after the user has committed to the idea.
    //
    // is_pkp and npwp are likewise validated in the database (posted-VAT guard, 15/16-digit check).
    // Not re-checked here — a second implementation of a rule is a second thing to drift.
    return withFinance(tenantId, async (c) => {
      const r = await c.query(
        `UPDATE finance_company_settings
            SET is_pkp = COALESCE($2, is_pkp),
                npwp = CASE WHEN $3::text IS NULL THEN npwp ELSE $3 END,
                functional_currency = COALESCE($4, functional_currency),
                presentation_currency = COALESCE($5, presentation_currency),
                updated_at = now()
          WHERE tenant_id = $1
        RETURNING tenant_id`,
        [
          tenantId,
          typeof body?.isPkp === "boolean" ? body.isPkp : null,
          body?.npwp === undefined ? null : (body.npwp ?? ""),
          body?.functionalCurrency ?? null,
          body?.presentationCurrency ?? null,
        ],
      );
      if (r.rowCount === 0) throw new NotFoundException("this company has no accounting settings yet");
      return { ok: true };
    });
  }

  // ── UI-01a — the cap table ────────────────────────────────────────────────────────────────────
  // ★ `finance_ownership`, NOT `finance_config`. An ownership edge is an AUTHORIZATION fact:
  // finance_owner_company_ids() resolves a person's visibility from this table, and a holding edge
  // reaches every descendant company. Reusing the config kind would let anyone who may rename an
  // account grant themselves sight of the whole group.
  @Get(":tenantId/finance/ownership")
  async listOwnership(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("asOf") asOf?: string,
  ) {
    await authorize(req.principal, { kind: "finance_ownership", tenantId, module: "finance" }, "read");
    const at = asOf ? requiredIsoDate(asOf, "asOf") : null;
    return withFinance(tenantId, async (c) => {
      const rows = await c.query(
        `SELECT o.id, o.holder_user_id, o.holder_company_id, o.kind, o.stake_pct,
                o.effective_from::text AS effective_from, o.effective_to::text AS effective_to, o.notes,
                u.name AS holder_user_name, co.name AS holder_company_name
           FROM company_ownership o
           LEFT JOIN users u ON u.id = o.holder_user_id
           LEFT JOIN companies co ON co.id = o.holder_company_id
          WHERE o.tenant_id = $1 AND o.deleted_at IS NULL
            AND ($2::date IS NULL
                 OR (o.effective_from <= $2 AND (o.effective_to IS NULL OR o.effective_to > $2)))
          ORDER BY o.effective_from DESC, o.stake_pct DESC NULLS LAST`,
        [tenantId, at],
      );
      const problems = await c.query(
        `SELECT problem, detail FROM finance_ownership_problems($1, $2::date)`,
        [tenantId, at],
      );
      return {
        edges: rows.rows.map((o) => ({
          id: o.id,
          holderUserId: o.holder_user_id,
          holderCompanyId: o.holder_company_id,
          holderName: o.holder_user_name ?? o.holder_company_name ?? null,
          holderKind: o.holder_user_id ? "person" : "company",
          kind: o.kind,
          stakePct: o.stake_pct,
          effectiveFrom: o.effective_from,
          effectiveTo: o.effective_to,
          notes: o.notes,
        })),
        // Carried WITH the list rather than behind a second call: a cap table totalling 140% has to
        // be visible on the surface that renders it, not discoverable by asking another question.
        problems: problems.rows.map((pr) => ({ problem: pr.problem, detail: pr.detail })),
      };
    });
  }

  @Post(":tenantId/finance/ownership")
  async createOwnership(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: OwnershipBody,
  ) {
    await authorize(req.principal, { kind: "finance_ownership", tenantId, module: "finance" }, "create");

    const kind = body?.kind?.trim();
    if (kind !== "holding" && kind !== "shareholder") {
      throw new BadRequestException('kind must be "holding" or "shareholder"');
    }
    const holderUserId = body?.holderUserId?.trim() || null;
    const holderCompanyId = body?.holderCompanyId?.trim() || null;
    if ((holderUserId ? 1 : 0) + (holderCompanyId ? 1 : 0) !== 1) {
      throw new BadRequestException("exactly one of holderUserId or holderCompanyId is required");
    }
    const effectiveFrom = requiredIsoDate(body?.effectiveFrom, "effectiveFrom");

    return withFinance(tenantId, async (c) => {
      const r = await c.query(
        `INSERT INTO company_ownership
           (tenant_id, holder_user_id, holder_company_id, kind, stake_pct, effective_from, notes)
         VALUES ($1,$2,$3,$4,$5,$6::date,$7)
         RETURNING id`,
        [
          tenantId, holderUserId, holderCompanyId, kind,
          body?.stakePct === null || body?.stakePct === undefined ? null : body.stakePct,
          effectiveFrom, body?.notes ?? null,
        ],
      );
      return { id: r.rows[0].id };
    });
  }

  // END-DATE, never delete. There is no delete action in the policy and none here: last year's
  // statements were true under last year's cap table, and removing the row would make them
  // unexplainable.
  @Post(":tenantId/finance/ownership/:edgeId/end")
  async endOwnership(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("edgeId") edgeId: string,
    @Body() body: { effectiveTo?: string },
  ) {
    await authorize(req.principal, { kind: "finance_ownership", tenantId, module: "finance" }, "update");
    const effectiveTo = requiredIsoDate(body?.effectiveTo, "effectiveTo");
    return withFinance(tenantId, async (c) => {
      const r = await c.query(
        `UPDATE company_ownership SET effective_to = $3::date, updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND effective_to IS NULL
        RETURNING id`,
        [edgeId, tenantId, effectiveTo],
      );
      if (r.rowCount === 0) throw new NotFoundException("no live ownership edge with that id");
      return { ok: true };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // RECEIVABLES — the write side (F4)
  //
  // ── EVERY WRITE GOES THROUGH THE SUBLEDGER FUNCTION, NEVER A HAND-WRITTEN JOURNAL ─────────────
  // `finance_ar_issue_invoice` / `_record_receipt` / `_allocate` are what post to the ledger and
  // move the AR control account. A manual journal to the control account is BARRED in the database,
  // and that bar is the only reason the aging can be trusted to tie to the balance sheet. These
  // handlers therefore assemble rows and call the function; they never compute a journal themselves.
  //
  // ── `issue` AND `receipt` ARE SEPARATE CERBOS ACTIONS, ON PURPOSE ─────────────────────────────
  // The duty matrix seeds `ar_receipt_posting` + `ar_writeoff_approve` as a BLOCKING conflict —
  // pocket the cash, then write off the debt. That is only enforceable if the actions are separately
  // grantable, so raising an invoice and banking money against one authorize distinctly even though
  // both live on the same resource kind.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  /**
   * Raise a customer invoice and ISSUE it in one call.
   *
   * Draft-then-issue is two steps in the database because an invoice may legitimately sit unissued.
   * It is ONE call here because a draft with no UI to finish it is a row nobody can act on — a
   * half-created invoice that never posts is worse than no invoice, since the aging then silently
   * disagrees with what the customer was told. If a real draft workflow is wanted it should arrive
   * as its own endpoint, not as a flag on this one.
   */
  @Post(":tenantId/finance/ar/invoices")
  @HttpCode(201)
  async createArInvoice(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: ArInvoiceBody,
  ) {
    await authorize(req.principal, { kind: "finance_ar", tenantId, module: "finance" }, "issue");

    const invoiceDate = requiredIsoDate(body?.invoiceDate, "invoiceDate");
    const dueDate = requiredIsoDate(body?.dueDate, "dueDate");
    if (dueDate < invoiceDate) throw new BadRequestException("dueDate cannot be before invoiceDate");
    const invoiceNo = body?.invoiceNo?.trim();
    if (!invoiceNo) throw new BadRequestException("invoiceNo is required");
    if (!body?.customerId) throw new BadRequestException("customerId is required");
    if (!Array.isArray(body?.lines) || body.lines.length === 0) {
      // A HEADER IS NOT AN INVOICE. finance_ar_issue_invoice raises FINANCE_AR_EMPTY_INVOICE on one
      // with no lines. Refusing here turns a mid-transaction database exception into a field-level
      // 400 the form can point at.
      throw new BadRequestException("at least one line is required — an invoice with no lines cannot be issued");
    }

    const lines = body.lines.map((l, i) => {
      const qty = Number(l?.quantity ?? 1);
      const unit = Number(l?.unitPrice);
      if (!l?.description?.trim()) throw new BadRequestException(`line ${i + 1}: description is required`);
      if (!l?.revenueAccountCode) throw new BadRequestException(`line ${i + 1}: revenueAccountCode is required`);
      if (!Number.isFinite(qty) || qty <= 0) throw new BadRequestException(`line ${i + 1}: quantity must be greater than zero`);
      if (!Number.isFinite(unit) || unit < 0) throw new BadRequestException(`line ${i + 1}: unitPrice must be zero or more`);
      const rate = l?.taxRate === undefined || l.taxRate === null ? null : Number(l.taxRate);
      if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 100)) {
        throw new BadRequestException(`line ${i + 1}: taxRate must be between 0 and 100`);
      }
      const subtotal = qty * unit;
      // Indonesian PPN is 12% applied to 11/12 of the base, not a flat 11%. Computed HERE rather
      // than accepted from the caller so every invoice this API issues agrees with the ledger's own
      // convention — a caller passing a pre-computed tax would be free to disagree with it.
      const tax = rate === null ? 0 : Math.round(subtotal * (11 / 12) * (rate / 100));
      return {
        description: l.description.trim(), quantity: qty, unitPrice: unit, subtotal,
        revenueAccountCode: l.revenueAccountCode, taxCode: l?.taxCode ?? null, taxRate: rate, tax,
      };
    });

    const subtotal = lines.reduce((t, l) => t + l.subtotal, 0);
    const taxTotal = lines.reduce((t, l) => t + l.tax, 0);
    if (subtotal + taxTotal <= 0) throw new BadRequestException("invoice total must be greater than zero");

    return withFinance(tenantId, async (c) => {
      const inv = await c.query<{ id: string }>(
        `INSERT INTO finance_ar_invoices
           (tenant_id, customer_id, invoice_no, invoice_date, due_date, currency_code,
            subtotal, tax_total, total, amount_paid, status)
         VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,0,'draft') RETURNING id`,
        [tenantId, body.customerId, invoiceNo, invoiceDate, dueDate,
         body?.currencyCode ?? "IDR", subtotal, taxTotal, subtotal + taxTotal],
      );
      const invoiceId = inv.rows[0].id;

      let lineNo = 1;
      for (const l of lines) {
        const acct = await c.query<{ id: string }>(
          `SELECT id FROM finance_accounts WHERE tenant_id = $1 AND code = $2`,
          [tenantId, l.revenueAccountCode],
        );
        if (!acct.rows[0]) throw new BadRequestException(`unknown revenue account ${l.revenueAccountCode}`);
        await c.query(
          `INSERT INTO finance_ar_invoice_lines
             (tenant_id, invoice_id, line_no, description, quantity, unit_price, line_subtotal,
              revenue_account_id, tax_code, tax_rate, tax_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [tenantId, invoiceId, lineNo++, l.description, l.quantity, l.unitPrice, l.subtotal,
           acct.rows[0].id, l.taxCode, l.taxRate, l.tax],
        );
      }

      // This is what posts the journal and moves the control account.
      await c.query(`SELECT finance_ar_issue_invoice($1,$2)`, [invoiceId, req.principal.userId]);
      return { id: invoiceId, subtotal, taxTotal, total: subtotal + taxTotal };
    });
  }

  /**
   * Bank a customer receipt, optionally allocating it against invoices in the same call.
   *
   * Banking the money and deciding WHICH DEBT it settles are deliberately two acts:
   * `finance_ar_allocate` posts nothing, it only records the match. `allocations` is optional
   * precisely so money can be banked before anyone knows what it pays for — the normal case for a
   * bare bank transfer — and the unallocated remainder then shows as `payments on account`, which
   * is a different fact from the aging and is reported separately for that reason.
   */
  @Post(":tenantId/finance/ar/receipts")
  @HttpCode(201)
  async createArReceipt(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: ArReceiptBody,
  ) {
    await authorize(req.principal, { kind: "finance_ar", tenantId, module: "finance" }, "receipt");

    const receiptDate = requiredIsoDate(body?.receiptDate, "receiptDate");
    const receiptNo = body?.receiptNo?.trim();
    if (!receiptNo) throw new BadRequestException("receiptNo is required");
    if (!body?.customerId) throw new BadRequestException("customerId is required");
    if (!body?.bankAccountCode) throw new BadRequestException("bankAccountCode is required");
    const amount = Number(body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException("amount must be greater than zero");

    const allocations = (body?.allocations ?? []).map((a, i) => {
      const amt = Number(a?.amount);
      if (!a?.invoiceId) throw new BadRequestException(`allocation ${i + 1}: invoiceId is required`);
      if (!Number.isFinite(amt) || amt <= 0) throw new BadRequestException(`allocation ${i + 1}: amount must be greater than zero`);
      return { invoiceId: a.invoiceId, amount: amt };
    });
    const allocatedTotal = allocations.reduce((t, a) => t + a.amount, 0);
    if (allocatedTotal > amount) {
      // The database enforces this too (ck_finance_ar_receipts_allocated). Refusing here names both
      // figures, which a raw constraint violation does not.
      throw new BadRequestException(
        `allocations total ${allocatedTotal} exceeds the receipt amount ${amount}`,
      );
    }

    return withFinance(tenantId, async (c) => {
      const bank = await c.query<{ id: string }>(
        `SELECT id FROM finance_accounts WHERE tenant_id = $1 AND code = $2`,
        [tenantId, body.bankAccountCode],
      );
      if (!bank.rows[0]) throw new BadRequestException(`unknown bank account ${body.bankAccountCode}`);

      const rec = await c.query<{ id: string }>(
        `INSERT INTO finance_ar_receipts
           (tenant_id, customer_id, receipt_no, receipt_date, currency_code, amount, bank_account_id, reference)
         VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8) RETURNING id`,
        [tenantId, body.customerId, receiptNo, receiptDate, body?.currencyCode ?? "IDR",
         amount, bank.rows[0].id, body?.reference ?? null],
      );
      const receiptId = rec.rows[0].id;

      await c.query(`SELECT finance_ar_record_receipt($1,$2)`, [receiptId, req.principal.userId]);
      for (const a of allocations) {
        await c.query(`SELECT finance_ar_allocate($1,$2,$3,$4)`,
          [receiptId, a.invoiceId, a.amount, req.principal.userId]);
      }
      return { id: receiptId, amount, allocated: allocatedTotal, onAccount: amount - allocatedTotal };
    });
  }

  /** The customer list, so a form can offer a picker instead of asking for a uuid. */
  @Get(":tenantId/finance/ar/customers")
  async listArCustomers(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "finance_ar", tenantId, module: "finance" }, "read");
    return withFinance(tenantId, async (c) => {
      const r = await c.query(
        `SELECT id, code, name, payment_terms_days AS "paymentTermsDays", is_pkp AS "isPkp"
           FROM finance_ar_customers
          WHERE tenant_id = $1 AND status = 'active'
          ORDER BY code`,
        [tenantId],
      );
      return r.rows;
    });
  }

  /** Open invoices for a customer — what a receipt can be allocated against. */
  @Get(":tenantId/finance/ar/open-invoices")
  async listArOpenInvoices(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("customerId") customerId?: string,
  ) {
    await authorize(req.principal, { kind: "finance_ar", tenantId, module: "finance" }, "read");
    return withFinance(tenantId, async (c) => {
      const r = await c.query(
        `SELECT i.id, i.invoice_no AS "invoiceNo", i.invoice_date AS "invoiceDate",
                i.due_date AS "dueDate", i.total, i.amount_paid AS "amountPaid",
                (i.total - i.amount_paid) AS outstanding, cu.name AS "customerName"
           FROM finance_ar_invoices i
           JOIN finance_ar_customers cu ON cu.id = i.customer_id
          WHERE i.tenant_id = $1
            AND i.status IN ('issued','paid')
            AND i.total > i.amount_paid
            AND ($2::uuid IS NULL OR i.customer_id = $2::uuid)
          ORDER BY i.due_date`,
        [tenantId, customerId ?? null],
      );
      return r.rows;
    });
  }


  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // THE FOUR ENGINES THAT HAD NO DOOR (F8 · F9 · F10 · F11)
  //
  // Fixed assets, consolidation, cutover and treasury were built in SQL, tested, and completely
  // unreachable: zero endpoints, zero UI. The depreciation engine had even RUN on the live estate —
  // the 8,500,000 charge in March's P&L is genuinely it — but only because a seed script called the
  // function directly. Nobody could see an asset, run a period, read a consolidated trial balance or
  // look at a loan's amortisation. An engine nobody can reach is not a delivered capability.
  //
  // ── NO NEW CERBOS KIND, DELIBERATELY ──────────────────────────────────────────────────────────
  // Adding a kind touches SIX coupled artifacts (policy, catalog, groups, generated bundles, the
  // migration, the parity suites) and every one of them has gone stale in this repo at least once.
  // These surfaces map cleanly onto kinds that already exist, so they authorize against those:
  //
  //   assets + treasury (read)   finance_ledger:read     — both are subledgers behind GL control
  //                                                          accounts; seeing them is seeing the ledger
  //   run depreciation           finance_ledger:post     — it POSTS journals. Not a read dressed up
  //                                                          as one, and priced accordingly.
  //   consolidation (read)       finance_statement:read  — a consolidated trial balance IS a statement
  //   cutover (read)             finance_period:read     — an opening balance is a property of the
  //                                                          period it opens
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  // ── F8: fixed assets ──────────────────────────────────────────────────────────────────────────

  /** The register. Book AND tax carrying values side by side, because they legitimately differ and
   *  a single "net book value" column would have to silently pick one. */
  @Get(":tenantId/finance/assets")
  async listAssets(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("asOf") asOf?: string,
  ) {
    await authorize(req.principal, { kind: "finance_ledger", tenantId, module: "finance" }, "read");
    const at = isoDate(asOf, "asOf");
    return withFinance(tenantId, async (c) => {
      const r = await c.query(
        `SELECT a.id, a.code, a.name, a.status,
                to_char(a.acquisition_date,'YYYY-MM-DD') AS "acquisitionDate",
                to_char(a.in_service_date,'YYYY-MM-DD')  AS "inServiceDate",
                a.cost, cl.code AS "classCode", cl.name AS "className",
                cl.book_method AS "bookMethod", cl.book_life_months AS "bookLifeMonths",
                cl.tax_golongan AS "taxGolongan",
                v.book_accum AS "bookAccum", v.book_nbv AS "bookNbv",
                v.tax_accum AS "taxAccum",  v.tax_nbv  AS "taxNbv"
           FROM finance_assets a
           JOIN finance_asset_classes cl ON cl.id = a.class_id
           LEFT JOIN LATERAL finance_asset_book_values(a.id, $2::date) v ON true
          WHERE a.tenant_id = $1
          ORDER BY cl.code, a.code`,
        [tenantId, at ?? null],
      );
      return r.rows;
    });
  }

  /** The asset classes. Needed wherever a class must be CHOSEN rather than inferred — recognising a
   *  lease picks the class that sets the right-of-use asset's useful life for the whole term. */
  @Get(":tenantId/finance/asset-classes")
  async listAssetClasses(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "finance_ledger", tenantId, module: "finance" }, "read");
    return withFinance(tenantId, async (c) => {
      const r = await c.query(
        `SELECT id, code, name, book_method AS "bookMethod", book_life_months AS "bookLifeMonths",
                tax_golongan AS "taxGolongan"
           FROM finance_asset_classes WHERE tenant_id = $1 ORDER BY code`,
        [tenantId],
      );
      return r.rows;
    });
  }

  /** One asset's full schedule — book and tax, period by period. Derived, never stored. */
  @Get(":tenantId/finance/assets/:assetId/schedule")
  async assetSchedule(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("assetId") assetId: string,
  ) {
    await authorize(req.principal, { kind: "finance_ledger", tenantId, module: "finance" }, "read");
    return withFinance(tenantId, async (c) => {
      const owned = await c.query(`SELECT 1 FROM finance_assets WHERE id = $1 AND tenant_id = $2`, [assetId, tenantId]);
      if (owned.rowCount === 0) throw new NotFoundException("no such asset in this company");
      const r = await c.query(
        `SELECT seq, to_char(period_start,'YYYY-MM-DD') AS "periodStart",
                book_charge AS "bookCharge", book_accum AS "bookAccum", book_nbv AS "bookNbv",
                tax_charge  AS "taxCharge",  tax_accum  AS "taxAccum",  tax_nbv  AS "taxNbv"
           FROM finance_asset_depreciation_schedule($1)`,
        [assetId],
      );
      return r.rows;
    });
  }

  /** The register-to-GL tie-out. Empty means the register agrees with its control accounts. */
  @Get(":tenantId/finance/assets/reconcile")
  async reconcileAssets(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "finance_ledger", tenantId, module: "finance" }, "read");
    return withFinance(tenantId, async (c) => {
      const r = await c.query(`SELECT problem, detail FROM finance_fa_reconcile($1)`, [tenantId]);
      return { problems: r.rows, clean: r.rows.length === 0 };
    });
  }

  /** Depreciation runs already recorded, so a reader can see what HAS been charged. */
  @Get(":tenantId/finance/depreciation-runs")
  async listDepreciationRuns(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "finance_ledger", tenantId, module: "finance" }, "read");
    return withFinance(tenantId, async (c) => {
      const r = await c.query(
        // The run row already stores its own totals (asset_count / book_total / tax_total), so this
        // reads them rather than re-aggregating the lines. Re-summing would be a second computation
        // of a figure the engine already committed, free to disagree with what was actually posted.
        `SELECT d.id, d.period_id AS "periodId", p.name AS "periodName",
                p.start_date::text AS "periodStart",
                d.journal_id AS "journalId", d.run_at AS "runAt",
                d.asset_count AS "assetCount", d.book_total AS "bookTotal", d.tax_total AS "taxTotal"
           FROM finance_depreciation_runs d
           JOIN finance_fiscal_periods p ON p.id = d.period_id
          WHERE d.tenant_id = $1
          ORDER BY p.start_date DESC`,
        [tenantId],
      );
      return r.rows;
    });
  }

  /**
   * Charge depreciation for a period. POSTS to the ledger.
   *
   * Authorized as `finance_ledger:post`, not as a read — it creates journal entries, and a period
   * already charged is refused by a unique index rather than by a check here. That refusal is the
   * idempotency guarantee: the same period cannot be charged twice even if two people press the
   * button at once, which a handler-side "already run?" lookup could not promise.
   */
  @Post(":tenantId/finance/periods/:periodId/depreciation")
  @HttpCode(201)
  async runDepreciation(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("periodId") periodId: string,
  ) {
    await authorize(req.principal, { kind: "finance_ledger", tenantId, module: "finance" }, "post");
    return withFinance(tenantId, async (c) => {
      const p = await c.query(`SELECT 1 FROM finance_fiscal_periods WHERE id = $1 AND tenant_id = $2`, [periodId, tenantId]);
      if (p.rowCount === 0) throw new NotFoundException("no such fiscal period in this company");
      const r = await c.query<{ id: string }>(
        `SELECT finance_run_depreciation($1,$2,$3) AS id`,
        [tenantId, periodId, req.principal.userId],
      );
      return { runId: r.rows[0].id };
    });
  }

  // ── F11: treasury ─────────────────────────────────────────────────────────────────────────────

  /** Loans, bonds and leases — one model, distinguished by `kind`. */
  @Get(":tenantId/finance/instruments")
  async listInstruments(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "finance_ledger", tenantId, module: "finance" }, "read");
    return withFinance(tenantId, async (c) => {
      const r = await c.query(
        `SELECT id, code, name, kind, counterparty_name AS "counterpartyName",
                currency_code AS "currencyCode", principal, nominal_rate AS "nominalRate",
                effective_rate AS "effectiveRate",
                to_char(start_date,'YYYY-MM-DD')    AS "startDate",
                to_char(maturity_date,'YYYY-MM-DD') AS "maturityDate",
                repayment_method AS "repaymentMethod", payment_months AS "paymentMonths"
           FROM finance_instruments
          WHERE tenant_id = $1
          ORDER BY kind, code`,
        [tenantId],
      );
      return r.rows;
    });
  }

  /** One instrument's amortisation schedule. Derived at the EFFECTIVE rate when one is set. */
  @Get(":tenantId/finance/instruments/:instrumentId/schedule")
  async instrumentSchedule(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("instrumentId") instrumentId: string,
  ) {
    await authorize(req.principal, { kind: "finance_ledger", tenantId, module: "finance" }, "read");
    return withFinance(tenantId, async (c) => {
      const owned = await c.query(`SELECT 1 FROM finance_instruments WHERE id = $1 AND tenant_id = $2`, [instrumentId, tenantId]);
      if (owned.rowCount === 0) throw new NotFoundException("no such instrument in this company");
      const r = await c.query(
        `SELECT seq, to_char(due_date,'YYYY-MM-DD') AS "dueDate",
                opening, interest, principal, closing
           FROM finance_instrument_schedule($1)`,
        [instrumentId],
      );
      return r.rows;
    });
  }

  /** Current vs non-current split — the balance-sheet presentation question, answered as at a date. */
  @Get(":tenantId/finance/treasury/maturity")
  async treasuryMaturity(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("asOf") asOf?: string,
  ) {
    await authorize(req.principal, { kind: "finance_ledger", tenantId, module: "finance" }, "read");
    const at = requiredIsoDate(asOf ?? new Date().toISOString().slice(0, 10), "asOf");
    return withFinance(tenantId, async (c) => {
      const r = await c.query(
        `SELECT instrument_id AS "instrumentId", code, kind, outstanding,
                current_portion AS "currentPortion", non_current_portion AS "nonCurrentPortion",
                to_char(maturity_date,'YYYY-MM-DD') AS "maturityDate"
           FROM finance_instrument_maturity_split($1,$2::date)`,
        [tenantId, at],
      );
      return r.rows;
    });
  }

  /** Treasury tie-out: instrument balances against the accounts that carry them. */
  @Get(":tenantId/finance/treasury/reconcile")
  async reconcileTreasury(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("asOf") asOf?: string,
  ) {
    await authorize(req.principal, { kind: "finance_ledger", tenantId, module: "finance" }, "read");
    const at = isoDate(asOf, "asOf");
    return withFinance(tenantId, async (c) => {
      const r = await c.query(`SELECT problem, detail FROM finance_treasury_reconcile($1,$2::date)`, [tenantId, at ?? null]);
      return { problems: r.rows, clean: r.rows.length === 0 };
    });
  }

  // ── F9: consolidation ─────────────────────────────────────────────────────────────────────────

  /** Consolidation runs recorded for this parent. */
  @Get(":tenantId/finance/consolidation/runs")
  async listConsolidationRuns(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "finance_statement", tenantId, module: "finance" }, "read");
    return withFinance(tenantId, async (c) => {
      const r = await c.query(
        `SELECT r.id, to_char(r.as_of,'YYYY-MM-DD') AS "asOf", r.label, r.created_at AS "createdAt",
                (SELECT count(*) FROM finance_consolidation_entries e WHERE e.run_id = r.id) AS "entryCount"
           FROM finance_consolidation_runs r
          WHERE r.tenant_id = $1
          ORDER BY r.as_of DESC, r.created_at DESC`,
        [tenantId],
      );
      return r.rows;
    });
  }

  /**
   * The consolidated trial balance for a run.
   *
   * ★ The SQL function REFUSES a run with no elimination entries. That refusal is the whole point:
   * a sum of the members is a legitimate figure, but it is NOT consolidated, and serving one under
   * this name is how a group reports its intercompany revenue twice. The refusal surfaces here as a
   * 409 through FinanceErrorFilter rather than being softened into an empty list.
   */
  @Get(":tenantId/finance/consolidation/runs/:runId/trial-balance")
  async consolidatedTrialBalance(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("runId") runId: string,
  ) {
    await authorize(req.principal, { kind: "finance_statement", tenantId, module: "finance" }, "read");
    return withFinance(tenantId, async (c) => {
      const owned = await c.query(`SELECT 1 FROM finance_consolidation_runs WHERE id = $1 AND tenant_id = $2`, [runId, tenantId]);
      if (owned.rowCount === 0) throw new NotFoundException("no such consolidation run in this company");
      const rows = await c.query(
        `SELECT account_code AS "accountCode", account_name AS "accountName",
                account_type AS "accountType", debit, credit
           FROM finance_consolidated_trial_balance($1)`,
        [runId],
      );
      const totalDebit = rows.rows.reduce((t, r) => t + Number(r.debit), 0);
      const totalCredit = rows.rows.reduce((t, r) => t + Number(r.credit), 0);
      return {
        rows: rows.rows,
        totalDebit: totalDebit.toFixed(2),
        totalCredit: totalCredit.toFixed(2),
        balanced: Math.abs(totalDebit - totalCredit) < 0.005,
      };
    });
  }

  /** What a run has NOT addressed. "Considered and not applicable" and "never considered" look
   *  identical in a working paper, and only one of them is a finished job. */
  @Get(":tenantId/finance/consolidation/runs/:runId/completeness")
  async consolidationCompleteness(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("runId") runId: string,
  ) {
    await authorize(req.principal, { kind: "finance_statement", tenantId, module: "finance" }, "read");
    return withFinance(tenantId, async (c) => {
      const owned = await c.query(`SELECT 1 FROM finance_consolidation_runs WHERE id = $1 AND tenant_id = $2`, [runId, tenantId]);
      if (owned.rowCount === 0) throw new NotFoundException("no such consolidation run in this company");
      const r = await c.query(`SELECT note, detail FROM finance_consolidation_completeness($1)`, [runId]);
      return { notes: r.rows, complete: r.rows.length === 0 };
    });
  }

  // ── F10: cutover ──────────────────────────────────────────────────────────────────────────────

  /** Cutovers recorded for this company, with their opening-balance line counts. */
  @Get(":tenantId/finance/cutovers")
  async listCutovers(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "finance_period", tenantId, module: "finance" }, "read");
    return withFinance(tenantId, async (c) => {
      const r = await c.query(
        `SELECT c.id, to_char(c.cutover_date,'YYYY-MM-DD') AS "cutoverDate", c.status,
                c.journal_id AS "journalId", c.committed_at AS "committedAt", c.notes,
                (SELECT count(*) FROM finance_opening_balances o WHERE o.cutover_id = c.id) AS "lineCount"
           FROM finance_cutovers c
          WHERE c.tenant_id = $1
          ORDER BY c.cutover_date DESC`,
        [tenantId],
      );
      return r.rows;
    });
  }

  /** The cutover gate. An unbalanced opening is REPORTED, never plugged. */
  @Get(":tenantId/finance/cutovers/:cutoverId/readiness")
  async cutoverReadiness(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("cutoverId") cutoverId: string,
  ) {
    await authorize(req.principal, { kind: "finance_period", tenantId, module: "finance" }, "read");
    return withFinance(tenantId, async (c) => {
      const owned = await c.query(`SELECT 1 FROM finance_cutovers WHERE id = $1 AND tenant_id = $2`, [cutoverId, tenantId]);
      if (owned.rowCount === 0) throw new NotFoundException("no such cutover in this company");
      const r = await c.query(`SELECT blocker, detail FROM finance_cutover_readiness($1)`, [cutoverId]);
      return { blockers: r.rows, ready: r.rows.length === 0 };
    });
  }

  /** The opening balance lines themselves — what the cutover will post. */
  @Get(":tenantId/finance/cutovers/:cutoverId/opening-balances")
  async cutoverOpeningBalances(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("cutoverId") cutoverId: string,
  ) {
    await authorize(req.principal, { kind: "finance_period", tenantId, module: "finance" }, "read");
    return withFinance(tenantId, async (c) => {
      const owned = await c.query(`SELECT 1 FROM finance_cutovers WHERE id = $1 AND tenant_id = $2`, [cutoverId, tenantId]);
      if (owned.rowCount === 0) throw new NotFoundException("no such cutover in this company");
      const r = await c.query(
        // Opening balances key on account CODE, not an id: a cutover is authored before the chart is
        // necessarily final, and a code is what an accountant hands over. The join is therefore a
        // LEFT one — a code with no matching account is a real state the readiness gate reports, and
        // an inner join would silently drop exactly the row somebody needs to see.
        `SELECT o.id, o.account_code AS "accountCode", a.name AS "accountName",
                o.debit, o.credit, o.memo
           FROM finance_opening_balances o
           LEFT JOIN finance_accounts a ON a.tenant_id = o.tenant_id AND a.code = o.account_code
          WHERE o.cutover_id = $1
          ORDER BY o.account_code`,
        [cutoverId],
      );
      const debit = r.rows.reduce((t, x) => t + Number(x.debit ?? 0), 0);
      const credit = r.rows.reduce((t, x) => t + Number(x.credit ?? 0), 0);
      return {
        rows: r.rows,
        totalDebit: debit.toFixed(2),
        totalCredit: credit.toFixed(2),
        balanced: Math.abs(debit - credit) < 0.005,
      };
    });
  }


  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // THE TERMINAL ACTIONS (owner decision 2026-08-26: typed-confirmation gate, no second approver)
  //
  // Four things in this module cannot be undone by an ordinary correction:
  //   sign off + close a period   the ledger stops accepting entries dated inside it
  //   commit a cutover            posts the opening journal and locks everything before it
  //   close a fiscal year         rolls the year's result into retained earnings
  //   recognise a lease           creates an asset AND a liability that did not exist before
  //
  // ── EVERY ONE REQUIRES THE CALLER TO ECHO THE NAME BACK ───────────────────────────────────────
  // Each handler takes a `confirm` field and refuses unless it matches the object's own name
  // exactly. That is not decoration and it is not a dialog: a dialog is dismissed by reflex, and a
  // reflex is precisely what should not close a period. Typing "Aug 2026" requires having read
  // which period is about to close, which is the one thing a mis-click cannot supply.
  //
  // It is enforced SERVER-SIDE, not in the form. A confirmation that lives only in the browser
  // protects nobody calling the API — including an agent, which this program expects to have.
  //
  // ── AND A REASON IS MANDATORY ─────────────────────────────────────────────────────────────────
  // Same posture as journal reversal. The person who has to explain a locked period six months
  // later is rarely the person who locked it.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  /**
   * Sign off a period. The accountant's assertion that the books are right — NOT the lock.
   *
   * Separate from closing on purpose: `NO_ACCOUNTANT_SIGNOFF` is one of the close-readiness
   * blockers, so sign-off is an input to the gate rather than a synonym for passing it. Signing off
   * a period whose subledgers do not tie is a legitimate (if unwise) act; closing one is not.
   */
  @Post(":tenantId/finance/periods/:periodId/sign-off")
  @HttpCode(200)
  async signOffPeriod(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("periodId") periodId: string,
    @Body() body: { confirm?: string; note?: string },
  ) {
    await authorize(req.principal, { kind: "finance_period", tenantId, module: "finance" }, "close");
    return withFinance(tenantId, async (c) => {
      const p = await c.query<{ name: string; signed_off_at: string | null }>(
        `SELECT name, signed_off_at FROM finance_fiscal_periods WHERE id = $1 AND tenant_id = $2`,
        [periodId, tenantId],
      );
      const period = p.rows[0];
      if (!period) throw new NotFoundException("no such fiscal period in this company");
      requireConfirmation(body?.confirm, period.name, "period");
      if (period.signed_off_at) throw new BadRequestException(`${period.name} is already signed off`);

      await c.query(
        `UPDATE finance_fiscal_periods
            SET signed_off_by = $2, signed_off_at = now(), updated_at = now()
          WHERE id = $1`,
        [periodId, req.principal.userId],
      );
      return { ok: true, period: period.name };
    });
  }

  /**
   * Close a period: SOFT_LOCK, or HARD_LOCK when `hard` is set.
   *
   * ★ THE READINESS GATE IS RE-CHECKED HERE, not trusted from whatever the caller last saw. The UI
   * shows readiness on page load; a subledger can fall out of balance between that render and this
   * call, and the render is not the authority. Blockers are returned in the refusal so the caller
   * learns WHICH check failed rather than being told "not ready".
   *
   * SOFT vs HARD is a real distinction, not a severity dial: a soft lock stops ordinary posting and
   * is reversible by someone holding `reopen`; a hard lock is the audit boundary. Defaulting to
   * soft means the routine monthly act is the recoverable one.
   */
  @Post(":tenantId/finance/periods/:periodId/close")
  @HttpCode(200)
  async closePeriod(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("periodId") periodId: string,
    @Body() body: { confirm?: string; reason?: string; hard?: boolean },
  ) {
    const hard = body?.hard === true;
    await authorize(
      req.principal,
      { kind: "finance_period", tenantId, module: "finance" },
      hard ? "lock" : "close",
    );
    const reason = body?.reason?.trim();
    if (!reason) throw new BadRequestException("reason is required — a locked period needs an explanation that outlives the person who locked it");

    return withFinance(tenantId, async (c) => {
      const p = await c.query<{ name: string; state: string }>(
        `SELECT name, state FROM finance_fiscal_periods WHERE id = $1 AND tenant_id = $2`,
        [periodId, tenantId],
      );
      const period = p.rows[0];
      if (!period) throw new NotFoundException("no such fiscal period in this company");
      requireConfirmation(body?.confirm, period.name, "period");

      if (period.state === "HARD_LOCK") throw new BadRequestException(`${period.name} is already hard-locked`);
      if (!hard && period.state === "SOFT_LOCK") throw new BadRequestException(`${period.name} is already closed`);

      const gate = await c.query<{ blocker: string; detail: string }>(
        `SELECT blocker, detail FROM finance_period_close_readiness($1,$2)`,
        [tenantId, periodId],
      );
      if (gate.rows.length > 0) {
        throw new BadRequestException(
          `${period.name} is not ready to close — ${gate.rows.map((b) => `${b.blocker}: ${b.detail}`).join("; ")}`,
        );
      }

      await c.query(
        hard
          ? `UPDATE finance_fiscal_periods
                SET state = 'HARD_LOCK', hard_locked_at = now(), hard_locked_by = $2,
                    close_checklist = COALESCE(close_checklist,'{}'::jsonb) || jsonb_build_object('hardLockReason',$3::text),
                    updated_at = now()
              WHERE id = $1`
          : `UPDATE finance_fiscal_periods
                SET state = 'SOFT_LOCK', soft_locked_at = now(), soft_locked_by = $2,
                    close_checklist = COALESCE(close_checklist,'{}'::jsonb) || jsonb_build_object('closeReason',$3::text),
                    updated_at = now()
              WHERE id = $1`,
        [periodId, req.principal.userId, reason],
      );
      return { ok: true, period: period.name, state: hard ? "HARD_LOCK" : "SOFT_LOCK" };
    });
  }

  /** Commit a cutover: posts the opening journal and locks everything before it. Once only. */
  @Post(":tenantId/finance/cutovers/:cutoverId/commit")
  @HttpCode(200)
  async commitCutover(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("cutoverId") cutoverId: string,
    @Body() body: { confirm?: string },
  ) {
    await authorize(req.principal, { kind: "finance_period", tenantId, module: "finance" }, "lock");
    return withFinance(tenantId, async (c) => {
      const cut = await c.query<{ cutover_date: string; status: string }>(
        `SELECT cutover_date::text AS cutover_date, status FROM finance_cutovers WHERE id = $1 AND tenant_id = $2`,
        [cutoverId, tenantId],
      );
      const cutover = cut.rows[0];
      if (!cutover) throw new NotFoundException("no such cutover in this company");
      // The cutover DATE is what the caller must echo — it is the line every figure the company
      // ever reports is measured from, and it is the thing worth having read.
      requireConfirmation(body?.confirm, cutover.cutover_date, "cutover date");

      // The readiness gate lives in SQL and refuses an unbalanced opening rather than plugging it.
      // Re-checked here for the same reason the period gate is: the page render is not authority.
      const gate = await c.query<{ blocker: string; detail: string }>(
        `SELECT blocker, detail FROM finance_cutover_readiness($1)`, [cutoverId],
      );
      if (gate.rows.length > 0) {
        throw new BadRequestException(
          `cutover ${cutover.cutover_date} is not ready — ${gate.rows.map((b) => `${b.blocker}: ${b.detail}`).join("; ")}`,
        );
      }

      const r = await c.query<{ id: string }>(
        `SELECT finance_commit_cutover($1,$2) AS id`, [cutoverId, req.principal.userId],
      );
      return { ok: true, journalId: r.rows[0].id, cutoverDate: cutover.cutover_date };
    });
  }

  /** Close a fiscal year: rolls the year's result into retained earnings. */
  @Post(":tenantId/finance/fiscal-years/:fiscalYearId/close")
  @HttpCode(200)
  async closeFiscalYear(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("fiscalYearId") fiscalYearId: string,
    @Body() body: { confirm?: string; retainedAccountCode?: string },
  ) {
    await authorize(req.principal, { kind: "finance_period", tenantId, module: "finance" }, "lock");
    return withFinance(tenantId, async (c) => {
      const fy = await c.query<{ code: string }>(
        `SELECT code FROM finance_fiscal_years WHERE id = $1 AND tenant_id = $2`, [fiscalYearId, tenantId],
      );
      const year = fy.rows[0];
      if (!year) throw new NotFoundException("no such fiscal year in this company");
      requireConfirmation(body?.confirm, year.code, "fiscal year");

      // Defaults to 3300 — RETAINED earnings, deliberately NOT 3200 (the current-year result). The
      // engine's own default; passed explicitly only when a chart uses a different code.
      const retained = body?.retainedAccountCode?.trim() || "3300";
      const acct = await c.query(
        `SELECT 1 FROM finance_accounts WHERE tenant_id = $1 AND code = $2`, [tenantId, retained],
      );
      if (acct.rowCount === 0) throw new BadRequestException(`unknown retained-earnings account ${retained}`);

      const r = await c.query<{ id: string }>(
        `SELECT finance_close_year($1,$2,$3,$4) AS id`,
        [tenantId, fiscalYearId, req.principal.userId, retained],
      );
      return { ok: true, journalId: r.rows[0].id, fiscalYear: year.code, retainedAccountCode: retained };
    });
  }

  /**
   * Recognise a lease under PSAK 73: creates a right-of-use ASSET and a lease LIABILITY.
   *
   * The most consequential of the four, because it is the only one that changes the SIZE of the
   * balance sheet rather than moving a figure between accounts. `assetClassId` decides how the
   * right-of-use asset depreciates thereafter, so it is required rather than defaulted — a wrong
   * class silently sets a wrong useful life for the whole lease term.
   */
  @Post(":tenantId/finance/instruments/:instrumentId/recognise-lease")
  @HttpCode(201)
  async recogniseLease(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("instrumentId") instrumentId: string,
    @Body() body: { confirm?: string; assetClassId?: string },
  ) {
    await authorize(req.principal, { kind: "finance_ledger", tenantId, module: "finance" }, "post");
    if (!body?.assetClassId) throw new BadRequestException("assetClassId is required — it sets how the right-of-use asset depreciates");
    return withFinance(tenantId, async (c) => {
      const inst = await c.query<{ code: string; kind: string }>(
        `SELECT code, kind FROM finance_instruments WHERE id = $1 AND tenant_id = $2`, [instrumentId, tenantId],
      );
      const instrument = inst.rows[0];
      if (!instrument) throw new NotFoundException("no such instrument in this company");
      if (instrument.kind !== "lease") {
        throw new BadRequestException(`${instrument.code} is a ${instrument.kind}, not a lease — only a lease is recognised under PSAK 73`);
      }
      requireConfirmation(body?.confirm, instrument.code, "instrument code");

      const cls = await c.query(
        `SELECT 1 FROM finance_asset_classes WHERE id = $1 AND tenant_id = $2`, [body.assetClassId, tenantId],
      );
      if (cls.rowCount === 0) throw new BadRequestException("no such asset class in this company");

      const r = await c.query<{ id: string }>(
        `SELECT finance_lease_recognise($1,$2,$3) AS id`,
        [instrumentId, body.assetClassId, req.principal.userId],
      );
      return { ok: true, assetId: r.rows[0].id, instrument: instrument.code };
    });
  }


  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // PAYABLES — the write side (F5)
  //
  // ── BILL ENTRY AND PAYMENT RELEASE ARE SEPARATE ENDPOINTS WITH SEPARATE CERBOS ACTIONS ────────
  // `ap_bill_entry` + `ap_payment_approve` is a seeded BLOCKING conflict in the duty matrix, and
  // `vendor_master` + `ap_payment_release` is a second one. The reason is concrete rather than
  // procedural: whoever can create a bill and also release its payment can pay themselves, and
  // whoever can edit a vendor's BANK DETAILS can redirect payment on a genuine invoice without
  // inventing anything. Splitting the endpoints is what makes those separately grantable — a single
  // "record and pay" call would collapse the distinction the matrix exists to hold.
  //
  // `payment_release` is the narrowest grant in the module: module_manager only, not company_admin.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  @Get(":tenantId/finance/ap/vendors")
  async listApVendors(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "finance_ap", tenantId, module: "finance" }, "read");
    return withFinance(tenantId, async (c) => {
      const r = await c.query(
        `SELECT id, code, name, npwp, is_pkp AS "isPkp",
                default_withholding_code AS "defaultWithholdingCode",
                default_withholding_rate AS "defaultWithholdingRate",
                payment_terms_days AS "paymentTermsDays"
           FROM finance_ap_vendors
          WHERE tenant_id = $1 AND status = 'active'
          ORDER BY code`,
        [tenantId],
      );
      return r.rows;
    });
  }

  /**
   * Bills, filterable by status. Exists so an APPROVER CAN FIND A DRAFT SOMEBODY ELSE ENTERED.
   *
   * ★ Without this the duty-matrix split is theatre. `bill_entry` and `approve` are deliberately
   * different grants so the person who types a vendor's invoice is not the one who admits it to the
   * books — but that only works if the approver can discover what is waiting. A list scoped to
   * whoever created it serves one person testing both halves and nobody doing the real job.
   *
   * Authorized as `read`, not `approve`: seeing that a bill is pending is not deciding it, and an
   * approver who cannot see the queue until they already hold approval cannot triage it.
   */
  @Get(":tenantId/finance/ap/bills")
  async listApBills(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("status") status?: string,
  ) {
    await authorize(req.principal, { kind: "finance_ap", tenantId, module: "finance" }, "read");
    const ALLOWED = ["draft", "approved", "paid", "void"];
    if (status && !ALLOWED.includes(status)) {
      throw new BadRequestException(`status must be one of ${ALLOWED.join(", ")}`);
    }
    return withFinance(tenantId, async (c) => {
      const r = await c.query(
        `SELECT b.id, b.bill_no AS "billNo", b.bill_date::text AS "billDate",
                b.due_date::text AS "dueDate", b.subtotal, b.tax_total AS "taxTotal", b.total,
                b.withholding_amount AS "withholdingAmount",
                b.amount_payable AS "amountPayable", b.amount_paid AS "amountPaid",
                b.status, v.code AS "vendorCode", v.name AS "vendorName"
           FROM finance_ap_bills b
           JOIN finance_ap_vendors v ON v.id = b.vendor_id
          WHERE b.tenant_id = $1 AND ($2::text IS NULL OR b.status = $2::text)
          ORDER BY b.bill_date DESC, b.bill_no`,
        [tenantId, status ?? null],
      );
      return r.rows;
    });
  }

  /** Bills not yet fully paid — what a payment can be allocated against. */
  @Get(":tenantId/finance/ap/open-bills")
  async listApOpenBills(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("vendorId") vendorId?: string,
  ) {
    await authorize(req.principal, { kind: "finance_ap", tenantId, module: "finance" }, "read");
    return withFinance(tenantId, async (c) => {
      const r = await c.query(
        `SELECT b.id, b.bill_no AS "billNo", b.bill_date::text AS "billDate",
                b.due_date::text AS "dueDate", b.total, b.amount_payable AS "amountPayable",
                b.amount_paid AS "amountPaid",
                (b.amount_payable - b.amount_paid) AS outstanding,
                b.withholding_amount AS "withholdingAmount",
                b.status, v.name AS "vendorName"
           FROM finance_ap_bills b
           JOIN finance_ap_vendors v ON v.id = b.vendor_id
          WHERE b.tenant_id = $1
            AND b.status IN ('approved','paid')
            AND b.amount_payable > b.amount_paid
            AND ($2::uuid IS NULL OR b.vendor_id = $2::uuid)
          ORDER BY b.due_date`,
        [tenantId, vendorId ?? null],
      );
      return r.rows;
    });
  }

  /**
   * Enter a vendor bill and APPROVE it.
   *
   * ★ WITHHOLDING IS THE POINT OF THIS ENDPOINT. A 35,000,000 service bill with PPh 23 at 2% is not
   * one liability — the vendor is owed 38,150,000 (net of 700,000 withheld) and DJP is owed the
   * 700,000, and those are different creditors with different due dates. A single "accounts payable"
   * figure hides the second one entirely, and the tax office does not forget it. The split is
   * computed here from the bill's own rate rather than accepted from the caller.
   */
  @Post(":tenantId/finance/ap/bills")
  @HttpCode(201)
  async createApBill(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: ApBillBody,
  ) {
    // `bill_entry`, NOT `manage`. The kind carries a dedicated action for this precisely because
    // `ap_bill_entry` + `ap_payment_approve` is a seeded blocking conflict; authorizing bill entry
    // under a broad `manage` would hand it to everyone holding manage and collapse the split.
    await authorize(req.principal, { kind: "finance_ap", tenantId, module: "finance" }, "bill_entry");

    const billDate = requiredIsoDate(body?.billDate, "billDate");
    const dueDate = requiredIsoDate(body?.dueDate, "dueDate");
    if (dueDate < billDate) throw new BadRequestException("dueDate cannot be before billDate");
    const billNo = body?.billNo?.trim();
    if (!billNo) throw new BadRequestException("billNo is required — it is the VENDOR's number, not ours");
    if (!body?.vendorId) throw new BadRequestException("vendorId is required");
    if (!Array.isArray(body?.lines) || body.lines.length === 0) {
      throw new BadRequestException("at least one line is required — a bill with no lines cannot be approved");
    }

    const lines = body.lines.map((l, i) => {
      const qty = Number(l?.quantity ?? 1);
      const unit = Number(l?.unitPrice);
      if (!l?.description?.trim()) throw new BadRequestException(`line ${i + 1}: description is required`);
      if (!l?.expenseAccountCode) throw new BadRequestException(`line ${i + 1}: expenseAccountCode is required`);
      if (!Number.isFinite(qty) || qty <= 0) throw new BadRequestException(`line ${i + 1}: quantity must be greater than zero`);
      if (!Number.isFinite(unit) || unit < 0) throw new BadRequestException(`line ${i + 1}: unitPrice must be zero or more`);
      const rate = l?.taxRate === undefined || l.taxRate === null ? null : Number(l.taxRate);
      if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 100)) {
        throw new BadRequestException(`line ${i + 1}: taxRate must be between 0 and 100`);
      }
      const subtotal = qty * unit;
      // Indonesian PPN: 12% of 11/12 of the base. Same convention as the AR side, computed in one
      // place per side rather than trusted from the caller.
      const tax = rate === null ? 0 : Math.round(subtotal * (11 / 12) * (rate / 100));
      return {
        description: l.description.trim(), quantity: qty, unitPrice: unit, subtotal,
        expenseAccountCode: l.expenseAccountCode, taxCode: l?.taxCode ?? null, taxRate: rate, tax,
      };
    });

    const subtotal = lines.reduce((t, l) => t + l.subtotal, 0);
    const taxTotal = lines.reduce((t, l) => t + l.tax, 0);
    const total = subtotal + taxTotal;
    if (total <= 0) throw new BadRequestException("bill total must be greater than zero");

    const whtRate = body?.withholdingRate === undefined || body.withholdingRate === null
      ? null : Number(body.withholdingRate);
    if (whtRate !== null && (!Number.isFinite(whtRate) || whtRate < 0 || whtRate > 1)) {
      // A RATE, not a percentage — 0.02 for PPh 23, matching the column. Rejecting 2 here rather
      // than accepting it is deliberate: a 200% withholding would otherwise pass silently and the
      // vendor would be paid a negative amount.
      throw new BadRequestException("withholdingRate is a rate between 0 and 1 (0.02 for PPh 23 at 2%), not a percentage");
    }
    const whtAmount = whtRate === null ? 0 : Math.round(subtotal * whtRate);
    const amountPayable = total - whtAmount;
    if (amountPayable < 0) throw new BadRequestException("withholding exceeds the bill total");

    return withFinance(tenantId, async (c) => {
      const whtAccountId = body?.withholdingAccountCode
        ? (await c.query<{ id: string }>(
            `SELECT id FROM finance_accounts WHERE tenant_id = $1 AND code = $2`,
            [tenantId, body.withholdingAccountCode],
          )).rows[0]?.id ?? null
        : null;
      if (body?.withholdingAccountCode && !whtAccountId) {
        throw new BadRequestException(`unknown withholding account ${body.withholdingAccountCode}`);
      }
      if (whtAmount > 0 && !whtAccountId) {
        throw new BadRequestException("withholdingAccountCode is required when a withholding rate is given — the tax withheld is a liability to DJP and needs an account of its own");
      }

      const bill = await c.query<{ id: string }>(
        `INSERT INTO finance_ap_bills
           (tenant_id, vendor_id, bill_no, bill_date, due_date, currency_code, subtotal, tax_total,
            total, withholding_code, withholding_rate, withholding_amount, withholding_account_id,
            amount_payable, amount_paid, status)
         VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,$10,$11,$12,$13,$14,0,'draft')
         RETURNING id`,
        [tenantId, body.vendorId, billNo, billDate, dueDate, body?.currencyCode ?? "IDR",
         subtotal, taxTotal, total, body?.withholdingCode ?? null, whtRate, whtAmount,
         whtAccountId, amountPayable],
      );
      const billId = bill.rows[0].id;

      let lineNo = 1;
      for (const l of lines) {
        const acct = await c.query<{ id: string }>(
          `SELECT id FROM finance_accounts WHERE tenant_id = $1 AND code = $2`,
          [tenantId, l.expenseAccountCode],
        );
        if (!acct.rows[0]) throw new BadRequestException(`unknown expense account ${l.expenseAccountCode}`);
        await c.query(
          `INSERT INTO finance_ap_bill_lines
             (tenant_id, bill_id, line_no, description, quantity, unit_price, line_subtotal,
              expense_account_id, tax_code, tax_rate, tax_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [tenantId, billId, lineNo++, l.description, l.quantity, l.unitPrice, l.subtotal,
           acct.rows[0].id, l.taxCode, l.taxRate, l.tax],
        );
      }

      // ★ LEFT AS A DRAFT, DELIBERATELY — unlike the AR invoice endpoint, which issues in one call.
      // The asymmetry is the duty matrix, not inconsistency: an AR invoice has no approval action in
      // the model, while AP explicitly separates `bill_entry` from `approve`. Approving here would
      // let whoever entered the bill approve it, which is the thing the two actions exist to
      // prevent. Approval is its own endpoint below.
      return {
        id: billId, status: "draft",
        subtotal, taxTotal, total, withholdingAmount: whtAmount, amountPayable,
      };
    });
  }

  /**
   * Approve a bill. Separate from entering it, and separately grantable.
   *
   * This is what posts the journal and moves the AP control account — a draft bill affects nothing.
   * Holding `bill_entry` does not imply `approve`, so the person who typed the vendor's invoice in
   * cannot be the one who admits it into the books unless somebody deliberately granted them both.
   */
  @Post(":tenantId/finance/ap/bills/:billId/approve")
  @HttpCode(200)
  async approveApBill(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("billId") billId: string,
  ) {
    await authorize(req.principal, { kind: "finance_ap", tenantId, module: "finance" }, "approve");
    return withFinance(tenantId, async (c) => {
      const b = await c.query<{ bill_no: string; status: string }>(
        `SELECT bill_no, status FROM finance_ap_bills WHERE id = $1 AND tenant_id = $2`,
        [billId, tenantId],
      );
      const bill = b.rows[0];
      if (!bill) throw new NotFoundException("no such bill in this company");
      if (bill.status !== "draft") throw new BadRequestException(`bill ${bill.bill_no} is ${bill.status}, not a draft`);

      await c.query(`SELECT finance_ap_approve_bill($1,$2)`, [billId, req.principal.userId]);
      return { ok: true, billNo: bill.bill_no };
    });
  }

  /**
   * Release a payment to a vendor. The narrowest grant in the module.
   *
   * Authorized as `payment_release`, NOT `manage` — this is where money actually leaves. Whoever
   * holds bill entry must not also hold this, and keeping them on different actions is what lets
   * the duty matrix enforce that per person per company rather than by convention.
   */
  @Post(":tenantId/finance/ap/payments")
  @HttpCode(201)
  async createApPayment(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: ApPaymentBody,
  ) {
    await authorize(req.principal, { kind: "finance_ap", tenantId, module: "finance" }, "payment_release");

    const paymentDate = requiredIsoDate(body?.paymentDate, "paymentDate");
    const paymentNo = body?.paymentNo?.trim();
    if (!paymentNo) throw new BadRequestException("paymentNo is required");
    if (!body?.vendorId) throw new BadRequestException("vendorId is required");
    if (!body?.bankAccountCode) throw new BadRequestException("bankAccountCode is required");
    const amount = Number(body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException("amount must be greater than zero");

    const allocations = (body?.allocations ?? []).map((a, i) => {
      const amt = Number(a?.amount);
      if (!a?.billId) throw new BadRequestException(`allocation ${i + 1}: billId is required`);
      if (!Number.isFinite(amt) || amt <= 0) throw new BadRequestException(`allocation ${i + 1}: amount must be greater than zero`);
      return { billId: a.billId, amount: amt };
    });
    const allocatedTotal = allocations.reduce((t, a) => t + a.amount, 0);
    if (allocatedTotal > amount) {
      throw new BadRequestException(`allocations total ${allocatedTotal} exceeds the payment amount ${amount}`);
    }

    return withFinance(tenantId, async (c) => {
      const bank = await c.query<{ id: string }>(
        `SELECT id FROM finance_accounts WHERE tenant_id = $1 AND code = $2`,
        [tenantId, body.bankAccountCode],
      );
      if (!bank.rows[0]) throw new BadRequestException(`unknown bank account ${body.bankAccountCode}`);

      const pay = await c.query<{ id: string }>(
        `INSERT INTO finance_ap_payments
           (tenant_id, vendor_id, payment_no, payment_date, currency_code, amount, bank_account_id, reference)
         VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8) RETURNING id`,
        [tenantId, body.vendorId, paymentNo, paymentDate, body?.currencyCode ?? "IDR",
         amount, bank.rows[0].id, body?.reference ?? null],
      );
      const paymentId = pay.rows[0].id;

      await c.query(`SELECT finance_ap_record_payment($1,$2)`, [paymentId, req.principal.userId]);
      for (const a of allocations) {
        await c.query(`SELECT finance_ap_allocate($1,$2,$3,$4)`,
          [paymentId, a.billId, a.amount, req.principal.userId]);
      }
      return { id: paymentId, amount, allocated: allocatedTotal, onAccount: amount - allocatedTotal };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // MASTER DATA — customers, vendors, accounts
  //
  // Each was previously seed-only, which meant a company could not invoice anyone it had not been
  // seeded with. A customer is NOT a CRM client: it carries the NPWP, the PKP flag and the payment
  // terms that decide how an invoice is taxed and aged, and those are accounting facts.
  //
  // ⚠ VENDOR CREATION IS `vendor_master`, NOT `manage`. Editing a vendor's bank details redirects
  // payment on a genuine invoice without forging anything, which is why the duty matrix seeds
  // `vendor_master` + `ap_payment_release` as a blocking pair. Creating one belongs on that grant.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  @Post(":tenantId/finance/ar/customers")
  @HttpCode(201)
  async createArCustomer(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { code?: string; name?: string; npwp?: string; isPkp?: boolean; paymentTermsDays?: number },
  ) {
    await authorize(req.principal, { kind: "finance_ar", tenantId, module: "finance" }, "manage");
    const code = body?.code?.trim();
    const name = body?.name?.trim();
    if (!code) throw new BadRequestException("code is required");
    if (!name) throw new BadRequestException("name is required");
    const terms = body?.paymentTermsDays ?? 30;
    if (!Number.isInteger(terms) || terms < 0) throw new BadRequestException("paymentTermsDays must be a whole number of days, zero or more");

    return withFinance(tenantId, async (c) => {
      const dup = await c.query(`SELECT 1 FROM finance_ar_customers WHERE tenant_id = $1 AND code = $2`, [tenantId, code]);
      if (dup.rowCount) throw new BadRequestException(`a customer with code ${code} already exists`);
      const r = await c.query<{ id: string }>(
        `INSERT INTO finance_ar_customers (tenant_id, code, name, npwp, is_pkp, payment_terms_days)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [tenantId, code, name, body?.npwp?.trim() || null, body?.isPkp ?? null, terms],
      );
      return { id: r.rows[0].id, code, name };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // AR CREDIT NOTES AND WRITE-OFFS (F4b, migration 202608270900)
  //
  // The two ways a receivable shrinks with no cash arriving. They are separate endpoints under
  // separate rights because they differ on VAT, and VAT is cash:
  //
  //   credit note — the customer never owed it. Output VAT IS reversed (nota retur).
  //   write-off   — the customer owed it and will not pay. Output VAT is NOT reversed; the PPN was
  //                 properly due and has been remitted.
  //
  // Both bind to the SAME segregation-of-duties duty (`ar_writeoff_approve`, seeded 202608241013 as
  // "AR credit note / write-off approval") and both are the far half of the seeded blocking pair
  // with `ar_receipt_posting` — "pocket the cash, then write off the debt".
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  @Get(":tenantId/finance/ar/credit-notes")
  async listArCreditNotes(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("status") status?: string,
  ) {
    await authorize(req.principal, { kind: "finance_ar", tenantId, module: "finance" }, "read");
    const STATUSES = ["draft", "issued", "applied", "void"];
    if (status && !STATUSES.includes(status)) {
      throw new BadRequestException(`status must be one of ${STATUSES.join(", ")}`);
    }
    return withFinance(tenantId, async (c) => {
      const r = await c.query(
        `SELECT n.id, n.credit_note_no AS "creditNoteNo", n.credit_note_date::text AS "creditNoteDate",
                n.customer_id AS "customerId", cu.code AS "customerCode", cu.name AS "customerName",
                n.subtotal, n.tax_total AS "taxTotal", n.total, n.amount_applied AS "amountApplied",
                (n.total - n.amount_applied) AS "unapplied",
                n.reason_code AS "reasonCode", n.reason, n.status,
                n.original_invoice_id AS "originalInvoiceId", i.invoice_no AS "originalInvoiceNo"
           FROM finance_ar_credit_notes n
           JOIN finance_ar_customers cu ON cu.id = n.customer_id
           LEFT JOIN finance_ar_invoices i ON i.id = n.original_invoice_id
          WHERE n.tenant_id = $1 AND ($2::text IS NULL OR n.status = $2)
          ORDER BY n.credit_note_date DESC, n.credit_note_no DESC`,
        [tenantId, status ?? null],
      );
      return r.rows;
    });
  }

  /**
   * Raise a credit note and post it in one call.
   *
   * Mirrors createArInvoice: the draft + lines + `finance_ar_issue_credit_note` happen inside one
   * transaction, so a credit note never exists in a half-posted state. The VAT is computed HERE on
   * the same 12%-of-11/12 convention the invoice path uses, rather than accepted from the caller —
   * a credit note whose VAT disagrees with the invoice it reverses is precisely the difference a
   * Coretax reconciliation surfaces months later.
   */
  @Post(":tenantId/finance/ar/credit-notes")
  @HttpCode(201)
  async createArCreditNote(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: ArCreditNoteBody,
  ) {
    await authorize(req.principal, { kind: "finance_ar", tenantId, module: "finance" }, "credit_note");

    const noteDate = requiredIsoDate(body?.creditNoteDate, "creditNoteDate");
    const creditNoteNo = body?.creditNoteNo?.trim();
    if (!creditNoteNo) throw new BadRequestException("creditNoteNo is required");
    if (!body?.customerId) throw new BadRequestException("customerId is required");

    const REASONS = ["return", "overbilling", "discount", "service_failure", "price_correction", "other"];
    if (!body?.reasonCode || !REASONS.includes(body.reasonCode)) {
      throw new BadRequestException(`reasonCode must be one of ${REASONS.join(", ")}`);
    }
    // A credit note with no stated cause is indistinguishable from a concealed write-off. The DB
    // enforces NOT NULL; this turns that into a field-level 400 the form can point at.
    if (!body?.reason?.trim()) {
      throw new BadRequestException("reason is required — a credit with no recorded cause is indistinguishable from a concealed write-off");
    }
    // Hoisted: TypeScript cannot carry the narrowing above into the withFinance closure.
    const reason = body.reason.trim();
    if (!Array.isArray(body?.lines) || body.lines.length === 0) {
      throw new BadRequestException("at least one line is required — a credit note with no lines cannot be issued");
    }

    const lines = body.lines.map((l, i) => {
      const amount = Number(l?.amount);
      if (!l?.description?.trim()) throw new BadRequestException(`line ${i + 1}: description is required`);
      if (!l?.creditAccountCode) throw new BadRequestException(`line ${i + 1}: creditAccountCode is required`);
      if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException(`line ${i + 1}: amount must be greater than zero`);
      const rate = l?.taxRate === undefined || l.taxRate === null ? null : Number(l.taxRate);
      if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 100)) {
        throw new BadRequestException(`line ${i + 1}: taxRate must be between 0 and 100`);
      }
      const tax = rate === null ? 0 : Math.round(amount * (11 / 12) * (rate / 100));
      return { description: l.description.trim(), amount, creditAccountCode: l.creditAccountCode, tax };
    });

    const subtotal = lines.reduce((t, l) => t + l.amount, 0);
    const taxTotal = lines.reduce((t, l) => t + l.tax, 0);
    if (subtotal + taxTotal <= 0) throw new BadRequestException("credit note total must be greater than zero");

    return withFinance(tenantId, async (c) => {
      const dup = await c.query(
        `SELECT 1 FROM finance_ar_credit_notes WHERE tenant_id = $1 AND credit_note_no = $2`,
        [tenantId, creditNoteNo],
      );
      if (dup.rowCount) throw new BadRequestException(`a credit note numbered ${creditNoteNo} already exists`);

      const cn = await c.query<{ id: string }>(
        `INSERT INTO finance_ar_credit_notes
           (tenant_id, customer_id, credit_note_no, credit_note_date, currency_code,
            subtotal, tax_total, total, reason_code, reason, original_invoice_id, status)
         VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,'draft') RETURNING id`,
        [tenantId, body.customerId, creditNoteNo, noteDate, body?.currencyCode ?? "IDR",
         subtotal, taxTotal, subtotal + taxTotal, body.reasonCode, reason,
         body?.originalInvoiceId ?? null],
      );
      const noteId = cn.rows[0].id;

      let sort = 0;
      for (const l of lines) {
        const acct = await c.query<{ id: string }>(
          `SELECT id FROM finance_accounts WHERE tenant_id = $1 AND code = $2`,
          [tenantId, l.creditAccountCode],
        );
        if (!acct.rows[0]) throw new BadRequestException(`unknown account ${l.creditAccountCode}`);
        await c.query(
          `INSERT INTO finance_ar_credit_note_lines
             (tenant_id, credit_note_id, description, line_subtotal, credit_account_id, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [tenantId, noteId, l.description, l.amount, acct.rows[0].id, sort++],
        );
      }

      // Posts the journal: DR contra-revenue + DR output VAT, CR AR control.
      await c.query(`SELECT finance_ar_issue_credit_note($1,$2)`, [noteId, req.principal.userId]);

      // Apply straight to the named invoice when the caller asked for it. Convenience only — the
      // credit is valid and already on the control account whether or not this succeeds, which is
      // why it is a separate statement rather than folded into issuing.
      if (body?.applyToInvoiceId) {
        await c.query(`SELECT finance_ar_apply_credit($1,$2,$3,$4)`, [
          noteId, body.applyToInvoiceId, Math.min(subtotal + taxTotal, Number(body?.applyAmount ?? subtotal + taxTotal)),
          req.principal.userId,
        ]);
      }
      return { id: noteId, creditNoteNo, subtotal, taxTotal, total: subtotal + taxTotal };
    });
  }

  /** Apply an already-issued credit note to an invoice. Subledger only — posts nothing. */
  @Post(":tenantId/finance/ar/credit-notes/:noteId/apply")
  @HttpCode(200)
  async applyArCreditNote(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("noteId") noteId: string,
    @Body() body: { invoiceId?: string; amount?: number },
  ) {
    await authorize(req.principal, { kind: "finance_ar", tenantId, module: "finance" }, "credit_note");
    if (!body?.invoiceId) throw new BadRequestException("invoiceId is required");
    const amount = Number(body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException("amount must be greater than zero");

    return withFinance(tenantId, async (c) => {
      const owned = await c.query(
        `SELECT 1 FROM finance_ar_credit_notes WHERE id = $1 AND tenant_id = $2`, [noteId, tenantId]);
      if (owned.rowCount === 0) throw new NotFoundException("no such credit note in this company");
      const r = await c.query<{ id: string }>(
        `SELECT finance_ar_apply_credit($1,$2,$3,$4) AS id`,
        [noteId, body.invoiceId, amount, req.principal.userId],
      );
      return { applicationId: r.rows[0].id, amount };
    });
  }

  /**
   * Write off an uncollectible receivable.
   *
   * Confirmation-gated on the INVOICE NUMBER, like closing a period. A write-off is corrected only
   * by a reversal, and the amount is chosen by the caller rather than implied — so a slip here is
   * not a wrong button, it is a wrong number, and re-typing the invoice is the cheapest guard
   * against writing off the wrong one.
   *
   * ⚠ Posts NO VAT line. See migration 202608270900 — Indonesian PPN gives no relief for a bad debt.
   */
  @Post(":tenantId/finance/ar/invoices/:invoiceId/write-off")
  @HttpCode(201)
  async writeOffArInvoice(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("invoiceId") invoiceId: string,
    @Body() body: { amount?: number; writeOffDate?: string; reasonCode?: string; reason?: string; confirm?: string },
  ) {
    await authorize(req.principal, { kind: "finance_ar", tenantId, module: "finance" }, "write_off");

    const amount = Number(body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException("amount must be greater than zero");
    const date = requiredIsoDate(body?.writeOffDate, "writeOffDate");
    const REASONS = ["uncollectible", "customer_insolvent", "disputed_abandoned", "below_recovery_cost", "statute_barred", "other"];
    if (!body?.reasonCode || !REASONS.includes(body.reasonCode)) {
      throw new BadRequestException(`reasonCode must be one of ${REASONS.join(", ")}`);
    }
    if (!body?.reason?.trim()) {
      throw new BadRequestException("reason is required — a write-off with no recorded reason is indistinguishable from a mistake");
    }
    const reason = body.reason.trim();

    return withFinance(tenantId, async (c) => {
      const inv = await c.query<{ invoice_no: string; outstanding: string }>(
        `SELECT invoice_no,
                (total - amount_paid - amount_credited - amount_written_off)::text AS outstanding
           FROM finance_ar_invoices WHERE id = $1 AND tenant_id = $2`,
        [invoiceId, tenantId],
      );
      const row = inv.rows[0];
      if (!row) throw new NotFoundException("no such invoice in this company");
      requireConfirmation(body?.confirm, row.invoice_no, "invoice number");

      const r = await c.query<{ id: string }>(
        `SELECT finance_ar_write_off($1,$2,$3::date,$4,$5,$6) AS id`,
        [invoiceId, amount, date, body.reasonCode, reason, req.principal.userId],
      );
      return { writeOffId: r.rows[0].id, invoiceNo: row.invoice_no, amount };
    });
  }

  @Post(":tenantId/finance/ap/vendors")
  @HttpCode(201)
  async createApVendor(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: {
      code?: string; name?: string; npwp?: string; isPkp?: boolean;
      defaultWithholdingCode?: string; defaultWithholdingRate?: number; paymentTermsDays?: number;
    },
  ) {
    await authorize(req.principal, { kind: "finance_ap", tenantId, module: "finance" }, "vendor_master");
    const code = body?.code?.trim();
    const name = body?.name?.trim();
    if (!code) throw new BadRequestException("code is required");
    if (!name) throw new BadRequestException("name is required");
    const rate = body?.defaultWithholdingRate === undefined || body.defaultWithholdingRate === null
      ? null : Number(body.defaultWithholdingRate);
    if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 1)) {
      throw new BadRequestException("defaultWithholdingRate is a rate between 0 and 1 (0.02 for PPh 23 at 2%), not a percentage");
    }

    return withFinance(tenantId, async (c) => {
      const dup = await c.query(`SELECT 1 FROM finance_ap_vendors WHERE tenant_id = $1 AND code = $2`, [tenantId, code]);
      if (dup.rowCount) throw new BadRequestException(`a vendor with code ${code} already exists`);
      const r = await c.query<{ id: string }>(
        `INSERT INTO finance_ap_vendors
           (tenant_id, code, name, npwp, is_pkp, default_withholding_code, default_withholding_rate, payment_terms_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [tenantId, code, name, body?.npwp?.trim() || null, body?.isPkp ?? null,
         body?.defaultWithholdingCode?.trim() || null, rate, body?.paymentTermsDays ?? 30],
      );
      return { id: r.rows[0].id, code, name };
    });
  }


  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // CONSOLIDATION — the write side (F9)
  //
  // A run is a dated working paper. Creating one is cheap; what makes it a CONSOLIDATION rather than
  // a sum is the elimination entries, which is why `finance_consolidated_trial_balance` refuses a run
  // that has none. These two endpoints exist so that refusal is escapable by doing the work rather
  // than by weakening the check.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  @Post(":tenantId/finance/consolidation/runs")
  @HttpCode(201)
  async createConsolidationRun(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { asOf?: string; label?: string },
  ) {
    // A consolidation is a STATEMENT, and producing one is `export`-grade rather than a plain read:
    // it aggregates every member company's books into a single artefact that leaves the ERP.
    await authorize(req.principal, { kind: "finance_statement", tenantId, module: "finance" }, "export");
    const asOf = requiredIsoDate(body?.asOf, "asOf");
    return withFinance(tenantId, async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO finance_consolidation_runs (tenant_id, as_of, label, created_by)
         VALUES ($1,$2::date,$3,$4) RETURNING id`,
        [tenantId, asOf, body?.label?.trim() || null, req.principal.userId],
      );
      return { id: r.rows[0].id, asOf };
    });
  }

  /**
   * Generate the intercompany eliminations for a run.
   *
   * Runs BOTH the balance-sheet and the P&L elimination. Doing only the first is the classic
   * half-consolidation: intercompany receivables and payables cancel, the group looks tidy, and the
   * revenue each member booked against the other is still counted twice in consolidated turnover —
   * which is the figure a bank actually reads.
   */
  @Post(":tenantId/finance/consolidation/runs/:runId/eliminate")
  @HttpCode(200)
  async eliminateIntercompany(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("runId") runId: string,
  ) {
    await authorize(req.principal, { kind: "finance_statement", tenantId, module: "finance" }, "export");
    return withFinance(tenantId, async (c) => {
      const owned = await c.query(`SELECT 1 FROM finance_consolidation_runs WHERE id = $1 AND tenant_id = $2`, [runId, tenantId]);
      if (owned.rowCount === 0) throw new NotFoundException("no such consolidation run in this company");

      await c.query(`SELECT finance_eliminate_intercompany($1)`, [runId]);
      await c.query(`SELECT finance_eliminate_intercompany_pl($1)`, [runId]);

      const n = await c.query<{ n: string }>(
        `SELECT count(*) n FROM finance_consolidation_entries WHERE run_id = $1`, [runId],
      );
      return { ok: true, entryCount: Number(n.rows[0].n) };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // PERIOD REOPEN (F3)
  //
  // The counterpart to closing, and deliberately a DIFFERENT grant: `reopen` is not held by
  // company_admin. A soft lock is reversible by design — it exists so the routine monthly close is
  // recoverable — but reversing it is somebody else's decision, not the closer's.
  //
  // A HARD lock has no path back at all. That is enforced below rather than left to the policy,
  // because "the audit boundary" is only a boundary if nothing can cross it.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  @Post(":tenantId/finance/periods/:periodId/reopen")
  @HttpCode(200)
  async reopenPeriod(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("periodId") periodId: string,
    @Body() body: { confirm?: string; reason?: string },
  ) {
    await authorize(req.principal, { kind: "finance_period", tenantId, module: "finance" }, "reopen");
    const reason = body?.reason?.trim();
    if (!reason) throw new BadRequestException("reason is required — reopening a closed period is an exception, and an exception with no recorded reason is indistinguishable from a mistake");

    return withFinance(tenantId, async (c) => {
      const p = await c.query<{ name: string; state: string }>(
        `SELECT name, state FROM finance_fiscal_periods WHERE id = $1 AND tenant_id = $2`,
        [periodId, tenantId],
      );
      const period = p.rows[0];
      if (!period) throw new NotFoundException("no such fiscal period in this company");
      requireConfirmation(body?.confirm, period.name, "period");

      if (period.state === "OPEN") throw new BadRequestException(`${period.name} is already open`);
      if (period.state === "HARD_LOCK") {
        throw new BadRequestException(
          `${period.name} is HARD-LOCKED and cannot be reopened. That is what a hard lock means — `
          + `a correction belongs in a later period, as an ordinary entry that shows on the face of the books.`,
        );
      }

      await c.query(
        `UPDATE finance_fiscal_periods
            SET state = 'OPEN', soft_locked_at = NULL, soft_locked_by = NULL,
                close_checklist = COALESCE(close_checklist,'{}'::jsonb) || jsonb_build_object('reopenReason',$3::text),
                updated_at = now()
          WHERE id = $1`,
        [periodId, req.principal.userId, reason],
      );
      return { ok: true, period: period.name, state: "OPEN" };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // TREASURY — the write side (F11)
  //
  // ★ Recording an instrument here is what eventually lets the treasury tie-out go green. Today the
  // check sums accounts tagged `treasury`, and a bank loan sits in an UNTAGGED account (2210) because
  // tagging it would make it a control account and bar the manual journal that is currently the only
  // way to record a drawdown. Giving the drawdown a subledger path is the first half of that fix; the
  // tagging migration is the second, and must not land before this does.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  @Post(":tenantId/finance/instruments")
  @HttpCode(201)
  async createInstrument(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: InstrumentBody,
  ) {
    await authorize(req.principal, { kind: "finance_ledger", tenantId, module: "finance" }, "post");

    const code = body?.code?.trim();
    const name = body?.name?.trim();
    if (!code) throw new BadRequestException("code is required");
    if (!name) throw new BadRequestException("name is required");
    const KINDS = ["loan_payable", "loan_receivable", "bond_issued", "lease"];
    if (!body?.kind || !KINDS.includes(body.kind)) {
      throw new BadRequestException(`kind must be one of ${KINDS.join(", ")}`);
    }
    const startDate = requiredIsoDate(body?.startDate, "startDate");
    const maturityDate = body?.maturityDate ? requiredIsoDate(body.maturityDate, "maturityDate") : null;
    if (maturityDate && maturityDate <= startDate) {
      throw new BadRequestException("maturityDate must be after startDate");
    }
    const principal = Number(body?.principal);
    if (!Number.isFinite(principal) || principal <= 0) throw new BadRequestException("principal must be greater than zero");

    const nominal = body?.nominalRate === undefined || body.nominalRate === null ? null : Number(body.nominalRate);
    if (nominal !== null && (!Number.isFinite(nominal) || nominal < 0 || nominal > 100)) {
      // A PERCENT here (11.5 for 11.5%), matching the column — unlike AP withholding, which is a
      // rate. The two differ because the columns differ; guessing either way silently produces a
      // schedule that is wrong by a factor of a hundred.
      throw new BadRequestException("nominalRate is a percent (11.5 for 11.5%), between 0 and 100");
    }

    return withFinance(tenantId, async (c) => {
      const dup = await c.query(`SELECT 1 FROM finance_instruments WHERE tenant_id = $1 AND code = $2`, [tenantId, code]);
      if (dup.rowCount) throw new BadRequestException(`an instrument with code ${code} already exists`);
      const r = await c.query<{ id: string }>(
        `INSERT INTO finance_instruments
           (tenant_id, code, name, kind, counterparty_name, currency_code, principal,
            nominal_rate, effective_rate, start_date, maturity_date, payment_months, repayment_method)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11::date,$12,$13) RETURNING id`,
        [tenantId, code, name, body.kind, body?.counterpartyName?.trim() || null,
         body?.currencyCode ?? "IDR", principal, nominal,
         body?.effectiveRate === undefined || body.effectiveRate === null ? null : Number(body.effectiveRate),
         startDate, maturityDate, body?.paymentMonths ?? 1, body?.repaymentMethod ?? "annuity"],
      );
      return { id: r.rows[0].id, code, kind: body.kind };
    });
  }

  /**
   * Post the interest accrual for ONE INSTALMENT of an instrument's schedule.
   *
   * ⚠ Keyed on the schedule SEQ, not on a fiscal period — `finance_post_instrument_accrual` takes
   * `(instrument, seq, actor)`. That is the right key and not an accident of the signature: the
   * schedule is derived at the effective rate, so instalment 7 has a definite interest figure
   * regardless of which period it lands in, and posting "the accrual for August" would be ambiguous
   * for any instrument whose payment months do not align with the fiscal calendar.
   *
   * Interest accrues whether or not anybody records it — the liability is real from the day the
   * money is drawn — so a schedule row left unposted understates both the expense and the debt.
   */
  @Post(":tenantId/finance/instruments/:instrumentId/accrual")
  @HttpCode(201)
  async postInstrumentAccrual(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("instrumentId") instrumentId: string,
    @Body() body: { seq?: number },
  ) {
    await authorize(req.principal, { kind: "finance_ledger", tenantId, module: "finance" }, "post");
    const seq = Number(body?.seq);
    if (!Number.isInteger(seq) || seq < 1) {
      throw new BadRequestException("seq is required — the 1-based instalment number from the instrument's schedule");
    }
    return withFinance(tenantId, async (c) => {
      const owned = await c.query(`SELECT 1 FROM finance_instruments WHERE id = $1 AND tenant_id = $2`, [instrumentId, tenantId]);
      if (owned.rowCount === 0) throw new NotFoundException("no such instrument in this company");

      // Refuse a seq the schedule does not contain, rather than letting the function decide. The
      // schedule is derived, so its length is knowable here and a 400 naming the range is more use
      // than whatever a missing row produces downstream.
      const sched = await c.query<{ n: string }>(
        `SELECT count(*) n FROM finance_instrument_schedule($1)`, [instrumentId],
      );
      const len = Number(sched.rows[0].n);
      if (seq > len) {
        throw new BadRequestException(`this instrument's schedule has ${len} instalment(s); seq ${seq} does not exist`);
      }

      const r = await c.query<{ id: string }>(
        `SELECT finance_post_instrument_accrual($1,$2,$3) AS id`,
        [instrumentId, seq, req.principal.userId],
      );
      return { journalId: r.rows[0].id, seq };
    });
  }

}
