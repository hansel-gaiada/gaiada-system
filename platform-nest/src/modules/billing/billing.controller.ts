// Billing / invoicing (BFF §4) — backs platform-ui lib/billing.ts. An invoice is generated for
// a client over a period at an hourly rate; line items are computed at creation from billable
// time_entries on that client's projects and frozen onto the invoice. Finance = company.manage.
// WSA-2: moved from src/core to the billing MODULE; gated by ModuleEnabledGuard("billing").
import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity } from "../../core/http";
import { emitEvent } from "../../events/outbox.service";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { recordInvoiceRevision, snapshotInvoice } from "./invoice-revisions";

// IAM-GAP-01: `approved` is a real status (migration 0107 widened the CHECK) but is DELIBERATELY
// NOT in this set — the only way INTO 'approved' is the dedicated /approve endpoint below, which
// runs the maker/checker Cerbos check (approver != creator). Accepting 'approved' here too would
// let anyone holding plain "update" (company_admin, unconditioned) set it directly and bypass the
// seam entirely.
const STATUSES = new Set(["draft", "sent", "paid", "void"]);
// Targets that require the invoice to have already cleared the checker step. 'draft' and 'void'
// are reachable from any current status (correcting a mistake, or cancelling outright, must never
// be blocked by a missing approval); 'sent'/'paid' are the money-moving transitions the maker/
// checker seam actually exists to gate.
const REQUIRES_APPROVED_STATUS = new Set(["sent", "paid"]);

const INVOICE_SELECT = `
  SELECT i.id, i.client_id AS "clientId", COALESCE(cl.name, '(no client)') AS "clientName",
         to_char(i.period_start, 'YYYY-MM-DD') AS "periodStart", to_char(i.period_end, 'YYYY-MM-DD') AS "periodEnd",
         i.status, i.currency, i.lines, i.total::float8 AS total, i.created_at AS "createdAt",
         i.created_by AS "createdBy", i.approved_by AS "approvedBy", i.approved_at AS "approvedAt",
         i.updated_by AS "updatedBy"
  FROM invoices i LEFT JOIN clients cl ON cl.id = i.client_id
  WHERE i.deleted_at IS NULL`;

@Controller("api")
@UseGuards(AuthGuard, ModuleEnabledGuard("billing"))
export class BillingController {
  @Get(":tenantId/invoices")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "invoice", tenantId }, "read");
    const rows = await withTenants([tenantId], (c) => c.query(`${INVOICE_SELECT} ORDER BY i.created_at DESC`));
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
    @Body() b: { clientId?: string; periodStart?: string; periodEnd?: string; rate?: number; currency?: string },
  ) {
    const { clientId, periodStart, periodEnd } = b ?? {};
    const rate = Number(b?.rate);
    if (!clientId || !periodStart || !periodEnd) throw new BadRequestException("clientId, periodStart and periodEnd required");
    if (!Number.isFinite(rate) || rate < 0) throw new BadRequestException("rate must be a non-negative number");
    await authorize(req.principal, { kind: "invoice", tenantId }, "create");
    const currency = (b?.currency || "USD").slice(0, 8);
    const id = newId();
    const invoice = await withTenants([tenantId], async (c) => {
      const client = await c.query<{ id: string }>(`SELECT id FROM clients WHERE id = $1 AND deleted_at IS NULL`, [clientId]);
      if (!client.rows[0]) throw new NotFoundException("client not found");
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
        const amount = Math.round(hours * rate * 100) / 100;
        return { description: r.project, hours, rate, amount };
      });
      const total = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
      // IAM-GAP-02: `updated_by` is set to the creator at INSERT time too — right after creation
      // the creator IS "the last person who made changes" (a trivially true, not fabricated,
      // starting value), so the column is never spuriously NULL for a row nobody has touched yet.
      await c.query(
        `INSERT INTO invoices (id, tenant_id, client_id, period_start, period_end, currency, lines, total, origin_site, created_by, updated_by)
         VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9, $10, $10)`,
        [id, tenantId, clientId, periodStart, periodEnd, currency, JSON.stringify(lines), total, config.originSite, req.principal.userId],
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
    if (!b?.status || !STATUSES.has(b.status)) throw new BadRequestException("valid status required (draft|sent|paid|void)");
    await authorize(req.principal, { kind: "invoice", id: invoiceId, tenantId }, "update");
    await withTenants([tenantId], async (c) => {
      // IAM-GAP-01: 'sent'/'paid' are money-moving — require the invoice to have already cleared
      // the checker step (POST .../approve below). Read-then-guard rather than a single
      // conditional UPDATE so the caller gets a clear 400 (wrong precondition) instead of an
      // indistinguishable 404 (row missing).
      if (REQUIRES_APPROVED_STATUS.has(b.status!)) {
        const current = await c.query<{ status: string }>(`SELECT status FROM invoices WHERE id = $1 AND deleted_at IS NULL`, [invoiceId]);
        if (!current.rows[0]) throw new NotFoundException("invoice not found");
        if (current.rows[0].status !== "approved") {
          throw new BadRequestException(`invoice must be approved before it can be marked '${b.status}' (currently '${current.rows[0].status}')`);
        }
      }
      // IAM-GAP-02: snapshot BEFORE the mutation — the row must still exist to 404 correctly, and
      // the revision needs the pre-edit state to be reconstructible.
      const before = await snapshotInvoice(c, invoiceId);
      if (!before || before.deletedAt) throw new NotFoundException("invoice not found");
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
}
