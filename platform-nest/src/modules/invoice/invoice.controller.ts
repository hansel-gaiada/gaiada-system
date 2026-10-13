// Invoicing (BFF §4) — backs platform-ui lib/invoice.ts. An invoice is generated for
// a client over a period at an hourly rate; line items are computed at creation from billable
// time_entries on that client's projects and frozen onto the invoice. Finance = company.manage.
// WSA-2: moved from src/core to this MODULE; gated by ModuleEnabledGuard("invoice").
// The module was named `billing` until 2026-08-26; the routes below have always said `invoices`.
import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity } from "../../core/http";
import { emitEvent } from "../../events/outbox.service";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { recordInvoiceRevision, snapshotInvoice } from "./invoice-revisions";
import { clientFilterSql, parseClientFilter } from "../../core/client-filter";
import { invoiceClientVisible, staffClientVisible } from "../../core/portal-visibility";
import { issueInvoice, readIssueReadiness, voidIssuedInvoice, withBilling } from "./issue";
import { INVOICE_PDF_FILE_ID } from "../../core/document-read-fields";

// IAM-GAP-01: `approved` is a real status (migration 0107 widened the CHECK) but is DELIBERATELY
// NOT in this set — the only way INTO 'approved' is the dedicated /approve endpoint below, which
// runs the maker/checker Cerbos check (approver != creator). Accepting 'approved' here too would
// let anyone holding plain "update" (company_admin, unconditioned) set it directly and bypass the
// seam entirely.
//
// PV5-04 (PV-D7, decision 2): `sent` and `paid` are NO LONGER reachable here. `sent` means ISSUED, and the only door
// into it is POST .../issue (numbered, posted to the ledger, issuer frozen); `paid` is derived from the ledger when a
// confirmed payment's allocation settles the AR invoice (contracts.controller.ts decidePayment). PATCH keeps `draft`
// and `void` for an invoice that was never issued; an issued invoice is voided through POST .../void.
const STATUSES = new Set(["draft", "void"]);

// PV3-07: `clientVisible` (a client-wide contact of the invoice's client can read it in the portal) is
// composed from the portal's own predicate: anything but a draft. Shared by the list and the detail.
const INVOICE_SELECT = `
  SELECT i.id, i.client_id AS "clientId", COALESCE(cl.name, '(no client)') AS "clientName",
         to_char(i.period_start, 'YYYY-MM-DD') AS "periodStart", to_char(i.period_end, 'YYYY-MM-DD') AS "periodEnd",
         i.status, i.currency, i.lines, i.total::float8 AS total, i.created_at AS "createdAt",
         i.created_by AS "createdBy", i.approved_by AS "approvedBy", i.approved_at AS "approvedAt",
         i.updated_by AS "updatedBy",
         ${staffClientVisible("i", invoiceClientVisible("i"))} AS "clientVisible",
         -- PV5-04: the invoice of record (all NULL until issued). Money as float8 for display, like total.
         i.invoice_no AS "invoiceNo", i.issued_at AS "issuedAt", i.issued_by AS "issuedBy",
         to_char(i.issue_date, 'YYYY-MM-DD') AS "issueDate", to_char(i.due_date, 'YYYY-MM-DD') AS "dueDate",
         i.subtotal::float8 AS subtotal, i.tax_total::float8 AS "taxTotal", i.tax_code AS "taxCode",
         i.issuer, i.ar_invoice_id AS "arInvoiceId", i.pre_pv5_legacy AS "legacyUnissued",
         -- PV5-07: the issued invoice's stored PDF. NULL = not issued, or issued and still being prepared.
         ${INVOICE_PDF_FILE_ID("i")} AS "pdfFileId"
  FROM invoices i LEFT JOIN clients cl ON cl.id = i.client_id
  WHERE i.deleted_at IS NULL`;

@Controller("api")
@UseGuards(AuthGuard, ModuleEnabledGuard("invoice"))
export class InvoiceController {
  // CC-1: `?clientId=<uuid>` / `?clientId=internal`. This list previously took NO query parameters at
  // all, so there is no prior behaviour to preserve beyond "omitted returns everything".
  @Get(":tenantId/invoices")
  async list(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("clientId") clientId?: string,
  ) {
    await authorize(req.principal, { kind: "invoice", tenantId }, "read");
    const filter = clientFilterSql(parseClientFilter(clientId), "i.client_id", 1);
    const rows = await withTenants([tenantId], (c) =>
      c.query(`${INVOICE_SELECT} AND ${filter.sql} ORDER BY i.created_at DESC`, filter.params),
    );
    return rows.rows;
  }

  @Get(":tenantId/invoices/:invoiceId")
  async detail(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("invoiceId") invoiceId: string) {
    await authorize(req.principal, { kind: "invoice", id: invoiceId, tenantId }, "read");
    const rows = await withTenants([tenantId], (c) => c.query(`${INVOICE_SELECT} AND i.id = $1`, [invoiceId]));
    if (!rows.rows[0]) throw new NotFoundException("invoice not found");
    return rows.rows[0];
  }

  // Generate an invoice: sum billable time on the client's projects in [periodStart, periodEnd],
  // one line per project (hours × rate). Frozen onto the invoice at creation time.
  @Post(":tenantId/invoices")
  @HttpCode(201)
  async create(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() b: { clientId?: string; periodStart?: string; periodEnd?: string; rate?: number; currency?: string; taxCode?: string },
  ) {
    const { clientId, periodStart, periodEnd } = b ?? {};
    const rate = Number(b?.rate);
    if (!clientId || !periodStart || !periodEnd) throw new BadRequestException("clientId, periodStart and periodEnd required");
    if (!Number.isFinite(rate) || rate < 0) throw new BadRequestException("rate must be a non-negative number");
    await authorize(req.principal, { kind: "invoice", tenantId }, "create");
    // PV5-04: an optional tax code (a finance_tax_codes code). It is applied at ISSUE, through finance_tax_compute()
    // on the issue date; here it is only recorded on the draft. Issue readiness refuses it until the code is in force
    // and the company is recorded as PKP.
    const taxCode = typeof b?.taxCode === "string" && b.taxCode.trim() ? b.taxCode.trim() : null;
    if (taxCode && !/^[A-Za-z0-9_.-]{1,32}$/.test(taxCode)) throw new BadRequestException("taxCode must be 1-32 letters, digits, '.', '_' or '-'");
    const id = newId();
    let currency = "USD";
    const invoice = await withBilling(tenantId, async (c) => {
      const client = await c.query<{ id: string }>(`SELECT id FROM clients WHERE id = $1 AND deleted_at IS NULL AND NOT is_internal`, [clientId]);
      if (!client.rows[0]) throw new NotFoundException("client not found");
      // PV5-04: the currency defaults to the billing profile's (the books' currency), not a hard-coded USD; with no
      // profile the old default stands. Line amounts round to that currency's minor unit (IDR: whole rupiah), so an
      // invoice is issuable as drafted.
      const prof = await c.query<{ currency: string | null }>(
        `SELECT currency_code AS currency FROM company_billing_profiles WHERE tenant_id = $1`,
        [tenantId],
      );
      currency = (b?.currency || prof.rows[0]?.currency || "USD").slice(0, 8);
      const mu = await c.query<{ minorUnit: number }>(`SELECT minor_unit::int AS "minorUnit" FROM finance_currencies WHERE code = $1`, [currency]);
      const scale = 10 ** (mu.rows[0] ? Number(mu.rows[0].minorUnit) : 2);
      // Billable minutes per project for this client's projects within the period.
      const agg = await c.query<{ project: string; minutes: string }>(
        `SELECT p.name AS project, SUM(te.minutes) AS minutes
         FROM time_entries te JOIN projects p ON p.id = te.project_id
         WHERE p.client_id = $1 AND te.billable = true AND te.deleted_at IS NULL
           AND te.entry_date >= $2::date AND te.entry_date <= $3::date
         GROUP BY p.name ORDER BY p.name`,
        [clientId, periodStart, periodEnd],
      );
      const lines = agg.rows.map((r) => {
        const hours = Math.round((Number(r.minutes) / 60) * 100) / 100;
        const amount = Math.round(hours * rate * scale) / scale;
        return { description: r.project, hours, rate, amount };
      });
      const total = Math.round(lines.reduce((s, l) => s + l.amount, 0) * scale) / scale;
      // IAM-GAP-02: `updated_by` is set to the creator at INSERT time too — right after creation
      // the creator IS "the last person who made changes" (a trivially true, not fabricated,
      // starting value), so the column is never spuriously NULL for a row nobody has touched yet.
      await c.query(
        `INSERT INTO invoices (id, tenant_id, client_id, period_start, period_end, currency, lines, total, origin_site, created_by, updated_by, tax_code)
         VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9, $10, $10, $11)`,
        [id, tenantId, clientId, periodStart, periodEnd, currency, JSON.stringify(lines), total, config.originSite, req.principal.userId, taxCode],
      );
      await emitEvent(c, tenantId, "invoice", id, "invoice.created", { clientId, total, currency });
      // IAM-GAP-02: revision #1 — before=null (nothing existed), after=the row just inserted.
      await recordInvoiceRevision(c, tenantId, id, req.principal.userId, "created", null);
      return { total, lineCount: lines.length };
    });
    await writeActivity(tenantId, req.principal.userId, "created", "invoice", id, { total: invoice.total });
    return { id };
  }

  @Patch(":tenantId/invoices/:invoiceId")
  @HttpCode(200)
  async setStatus(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("invoiceId") invoiceId: string,
    @Body() b: { status?: string },
  ) {
    // Authorization before validation (PV5 rule): a caller who may not update gets 403 whatever they sent.
    await authorize(req.principal, { kind: "invoice", id: invoiceId, tenantId }, "update");
    if (b?.status === "sent" || b?.status === "paid") {
      // PV5-04: the two money-moving states have their own doors now. Named precisely so a caller (or an agent)
      // knows where to go instead of being told only "invalid".
      throw new BadRequestException(
        b.status === "sent"
          ? "an invoice becomes sent only by issuing it: POST /api/:tenantId/invoices/:invoiceId/issue"
          : "an invoice becomes paid only when a confirmed payment settles it in the ledger",
      );
    }
    if (!b?.status || !STATUSES.has(b.status)) throw new BadRequestException("valid status required (draft|void)");
    await withTenants([tenantId], async (c) => {
      // IAM-GAP-02: snapshot BEFORE the mutation — the row must still exist to 404 correctly, and
      // the revision needs the pre-edit state to be reconstructible.
      const before = await snapshotInvoice(c, invoiceId);
      if (!before || before.deletedAt) throw new NotFoundException("invoice not found");
      // PV5-04: an issued invoice is a legal document; it changes only through POST .../void (which reverses it in
      // the ledger). A legacy sent/paid invoice (pre_pv5_legacy) keeps the old cancel path.
      if (before.issuedAt) {
        throw new ConflictException(
          b.status === "void"
            ? "this invoice is issued; void it with POST /api/:tenantId/invoices/:invoiceId/void, which reverses it in the ledger"
            : "this invoice is issued and can no longer be edited",
        );
      }
      const res = await c.query(
        `UPDATE invoices SET status = $2, updated_by = $3, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
        [invoiceId, b.status, req.principal.userId],
      );
      if (res.rowCount === 0) throw new NotFoundException("invoice not found");
      await emitEvent(c, tenantId, "invoice", invoiceId, "invoice.updated", { status: b.status });
      await recordInvoiceRevision(c, tenantId, invoiceId, req.principal.userId, "status_changed", before);
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "invoice", invoiceId, { status: b.status });
    return { ok: true };
  }

  // IAM-GAP-01 — the maker/checker seam's own endpoint. draft -> approved ONLY; the approver must
  // not be the invoice's own creator (resource_invoice.yaml's `approve` rule, fail-closed on an
  // unknown/legacy creator). Fetch BEFORE authorize (same reason automation-approvals.controller.ts's
  // decide() documents): the row's OWN created_by is what Cerbos's condition evaluates, so it must
  // be read first, never trusted from the request body.
  @Post(":tenantId/invoices/:invoiceId/approve")
  @HttpCode(200)
  async approve(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("invoiceId") invoiceId: string) {
    const row = await withTenants(
      [tenantId],
      (c) => c.query<{ status: string; created_by: string | null }>(`SELECT status, created_by FROM invoices WHERE id = $1 AND deleted_at IS NULL`, [invoiceId]),
    );
    if (!row.rows[0]) throw new NotFoundException("invoice not found");
    await authorize(
      req.principal,
      { kind: "invoice", id: invoiceId, tenantId, creatorId: row.rows[0].created_by ?? undefined },
      "approve",
    );
    if (row.rows[0].status !== "draft") {
      throw new BadRequestException(`invoice is '${row.rows[0].status}', not awaiting approval (only 'draft' invoices can be approved)`);
    }
    await withTenants([tenantId], async (c) => {
      // IAM-GAP-02: snapshot BEFORE the mutation, inside the SAME transaction as the UPDATE below
      // (not the earlier, pre-authorize SELECT above, which ran in its own separate `withTenants`
      // call — a concurrent edit between that check and this transaction must not corrupt the
      // revision's "before" state).
      const before = await snapshotInvoice(c, invoiceId);
      if (!before) throw new NotFoundException("invoice not found");
      const res = await c.query(
        `UPDATE invoices SET status = 'approved', approved_by = $2, approved_at = now(), updated_by = $2, updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL AND status = 'draft'`,
        [invoiceId, req.principal.userId],
      );
      if (res.rowCount === 0) throw new NotFoundException("invoice not found or no longer awaiting approval");
      await emitEvent(c, tenantId, "invoice", invoiceId, "invoice.approved", { approvedBy: req.principal.userId });
      await recordInvoiceRevision(c, tenantId, invoiceId, req.principal.userId, "approved", before);
    });
    await writeActivity(tenantId, req.principal.userId, "approved", "invoice", invoiceId, {});
    return { ok: true, status: "approved" };
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // PV5-04 — issue through the ledger (PV-D7). The logic lives in ./issue.ts; these handlers authorize and shape.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  /** Everything that stops this invoice being issued right now, all at once (decision 7). On `invoice` read: a reader
   *  may see why an invoice is stuck; only an `issue` holder can act on it. */
  @Get(":tenantId/invoices/:invoiceId/issue-readiness")
  async issueReadiness(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("invoiceId") invoiceId: string) {
    await authorize(req.principal, { kind: "invoice", id: invoiceId, tenantId }, "read");
    return readIssueReadiness(tenantId, invoiceId);
  }

  /** Issue an approved invoice: number it, post it, freeze it. 409 `{ reason: "issue_blocked", blockers }` with nothing
   *  written when it is not ready. Idempotent: a second call answers the issued invoice with `alreadyIssued: true`.
   *  Cerbos `invoice`/`issue` (company_admin, manager, owner by its bundle; bots and automation DENIED). */
  @Post(":tenantId/invoices/:invoiceId/issue")
  @HttpCode(200)
  async issue(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("invoiceId") invoiceId: string) {
    await authorize(req.principal, { kind: "invoice", id: invoiceId, tenantId }, "issue");
    const out = await issueInvoice(tenantId, invoiceId, req.principal.userId);
    if (!out.alreadyIssued) {
      await writeActivity(tenantId, req.principal.userId, "issued", "invoice", invoiceId, {
        invoiceNo: out.invoiceNo, total: out.total, currency: out.currency, arInvoiceId: out.arInvoiceId,
      });
    }
    return out;
  }

  /** Void an ISSUED invoice: a full credit note in the ledger, both rows `void` (decision 9). A part-paid invoice is
   *  refused (a credit note in Finance). Cerbos `invoice`/`void_issued` (company_admin, owner; bots DENIED). */
  @Post(":tenantId/invoices/:invoiceId/void")
  @HttpCode(200)
  async voidIssued(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("invoiceId") invoiceId: string,
    @Body() b: { reason?: string },
  ) {
    await authorize(req.principal, { kind: "invoice", id: invoiceId, tenantId }, "void_issued");
    const reason = typeof b?.reason === "string" ? b.reason.trim() : "";
    if (reason.length < 4) throw new BadRequestException("a reason (at least 4 characters) is required to void an issued invoice");
    const out = await voidIssuedInvoice(tenantId, invoiceId, req.principal.userId, reason.slice(0, 500));
    if (!out.alreadyVoid) {
      await writeActivity(tenantId, req.principal.userId, "voided", "invoice", invoiceId, { creditNoteId: out.creditNoteId, reason: reason.slice(0, 200) });
    }
    return out;
  }
}
