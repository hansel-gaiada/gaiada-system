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
  BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query, Req, UseGuards,
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
                net_receivable AS "netReceivable"
           FROM finance_ar_position($1, $2::date)`,
        [tenantId, isoDate(asOf, "asOf")],
      );
      // Both numbers, because they are NOT the same and a caller that assumes they are will
      // report a mismatch on every customer prepayment.
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
}
