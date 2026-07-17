// Billing / invoicing (BFF §4) — backs platform-ui lib/billing.ts. An invoice is generated for
// a client over a period at an hourly rate; line items are computed at creation from billable
// time_entries on that client's projects and frozen onto the invoice. Finance = company.manage.
import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";

const STATUSES = new Set(["draft", "sent", "paid", "void"]);

const INVOICE_SELECT = `
  SELECT i.id, i.client_id AS "clientId", COALESCE(cl.name, '(no client)') AS "clientName",
         to_char(i.period_start, 'YYYY-MM-DD') AS "periodStart", to_char(i.period_end, 'YYYY-MM-DD') AS "periodEnd",
         i.status, i.currency, i.lines, i.total::float8 AS total, i.created_at AS "createdAt"
  FROM invoices i LEFT JOIN clients cl ON cl.id = i.client_id
  WHERE i.deleted_at IS NULL`;

@Controller("api")
@UseGuards(AuthGuard)
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
      await c.query(
        `INSERT INTO invoices (id, tenant_id, client_id, period_start, period_end, currency, lines, total, origin_site)
         VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9)`,
        [id, tenantId, clientId, periodStart, periodEnd, currency, JSON.stringify(lines), total, config.originSite],
      );
      await emitEvent(c, tenantId, "invoice", id, "invoice.created", { clientId, total, currency });
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
      const res = await c.query(`UPDATE invoices SET status = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`, [invoiceId, b.status]);
      if (res.rowCount === 0) throw new NotFoundException("invoice not found");
      await emitEvent(c, tenantId, "invoice", invoiceId, "invoice.updated", { status: b.status });
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "invoice", invoiceId, { status: b.status });
    return { ok: true };
  }
}
