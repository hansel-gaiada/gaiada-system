// PV7-04a — the STAFF side of client reports (docs/FRONTEND-BFF-CONTRACT.md §55.3; PERMISSION-CONTRACT §46).
//
//   GET  :t/clients/:clientId/reports        every report of one client, every status, with the staff `clientVisible` flag
//   POST :t/client-reports/:id/publish       draft -> published (needs the report's own file), then the notice
//   POST :t/client-reports/:id/withdraw      published -> withdrawn, with a reason
//
// Module `clients` (ModuleEnabledGuard), Cerbos kind `client_report`. The staff download of a report's file is the existing
// `GET :t/files/:fileId/content` (core/files.controller.ts): it authorizes `file · read` then `client_report · read` on the
// file's target, which is exactly this kind's read. Delivering a social or search report publishes its client report from
// the module's own `deliver` handler (core/client-reports.ts); nothing here re-implements that.
//
// ── ORDER: AUTHORIZE, READ THE ROW, AUTHORIZE ON ITS ATTRIBUTES, THEN VALIDATE ─────────────────────────────────────────
// The kind-level `read` first, so a caller who may not read client reports learns nothing (not even a 404). Then the row,
// then the action on the row's attributes (`ownerUserId` from the CLIENT row, never a body: the client's owner rule), then
// the state and the body. A missing reason is a 400 only for a caller who may withdraw, so a denial test with a sloppy
// body still tests authorization (the validation-preempts-authz lesson).
import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Req,
  UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../../db";
import { authorize, writeActivity } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { emitEvent } from "../../events/outbox.service";
import { isUuid } from "../../core/conversation-core";
import { staffClientReportClientVisible } from "../../core/portal-visibility";
import {
  CLIENT_REPORT_ENTITY, announceClientReportPublished, clientReportFileOf, type ClientReportSource, type ClientReportStatus,
} from "../../core/client-reports";
import type { Resource } from "../../rbac/cerbos";

const MAX_REASON = 2000;

interface ReportRow {
  id: string;
  clientId: string;
  projectId: string | null;
  source: ClientReportSource;
  status: ClientReportStatus;
  title: string;
  ownerUserId: string | null;
  /** The report's own role file (role client_report_file, target this report, not deleted), or null. */
  fileId: string | null;
}

@Controller("api")
@UseGuards(AuthGuard, ModuleEnabledGuard("clients"))
export class ClientReportsController {
  @Get(":tenantId/clients/:clientId/reports")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string) {
    await authorize(req.principal, { kind: "client_report", tenantId }, "read");
    // Shape only, after the decision: a malformed id is a 404 (there is no such client), never a 500 at the uuid cast.
    if (!isUuid(clientId)) throw new NotFoundException("client not found");
    return withTenants([tenantId], async (c) => {
      const client = await c.query(`SELECT 1 FROM clients WHERE id = $1 AND deleted_at IS NULL`, [clientId]);
      if (!client.rows[0]) throw new NotFoundException("client not found");
      const rows = await c.query<Record<string, unknown>>(
        `SELECT cr.id, cr.client_id AS "clientId", cr.project_id AS "projectId", p.name AS "projectName",
                cr.source, cr.source_id AS "sourceId", cr.deliverable_id AS "deliverableId", cr.title,
                to_char(cr.period_start, 'YYYY-MM-DD') AS "periodStart", to_char(cr.period_end, 'YYYY-MM-DD') AS "periodEnd",
                cr.status, f.id AS "fileId", f.filename, f.content_type AS "contentType", f.byte_size AS "byteSize",
                cr.created_at AS "createdAt", cr.published_at AS "publishedAt", pu.name AS "publishedByName",
                cr.withdrawn_at AS "withdrawnAt", wu.name AS "withdrawnByName", cr.withdrawn_reason AS "withdrawnReason",
                ${staffClientReportClientVisible("cr")} AS "clientVisible",
                (SELECT count(*)::int FROM client_report_reads rr WHERE rr.report_id = cr.id) AS "readCount"
           FROM client_reports cr
           LEFT JOIN projects p ON p.id = cr.project_id
           LEFT JOIN files f ON ${clientReportFileOf("f", "cr")}
           LEFT JOIN users pu ON pu.id = cr.published_by
           LEFT JOIN users wu ON wu.id = cr.withdrawn_by
          WHERE cr.client_id = $1
          ORDER BY COALESCE(cr.published_at, cr.created_at) DESC, cr.id
          LIMIT 500`,
        [clientId],
      );
      return {
        reports: rows.rows.map((r) => {
          const { fileId, filename, contentType, byteSize, ...rest } = r;
          return {
            ...rest,
            file: fileId ? { id: fileId, filename, contentType, byteSize: Number(byteSize) } : null,
          };
        }),
      };
    });
  }

  @Post(":tenantId/client-reports/:id/publish")
  @HttpCode(200)
  async publish(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "client_report", tenantId }, "read");
    const row = await this.load(tenantId, id);
    await authorize(req.principal, this.resource(tenantId, row), "publish");
    const actor = req.principal.userId;
    // A publication names the person who answers for it (published_by is required once published).
    if (!actor) throw new ForbiddenException("a person publishes a report");
    if (row.status !== "draft") throw new ConflictException("not_a_draft");
    if (!row.fileId) throw new ConflictException("report_has_no_file");

    const publishedAt = await withTenants([tenantId], async (c) => {
      // Compare-and-swap on the state AND the file, so a concurrent publish or a file change between the read and the write
      // cannot publish twice or publish without its own file.
      const u = await c.query<{ published_at: string }>(
        `UPDATE client_reports cr
            SET status = 'published', published_at = now(), published_by = $2, updated_at = now()
          WHERE cr.id = $1 AND cr.status = 'draft'
            AND EXISTS (SELECT 1 FROM files f WHERE ${clientReportFileOf("f", "cr")})
        RETURNING cr.published_at`,
        [id, actor],
      );
      if (!u.rows[0]) throw new ConflictException("not_a_draft");
      await emitEvent(c, tenantId, CLIENT_REPORT_ENTITY, id, "client_report.published", {
        clientId: row.clientId, projectId: row.projectId, source: row.source,
      });
      return u.rows[0].published_at;
    });
    await writeActivity(tenantId, actor, "published", CLIENT_REPORT_ENTITY, id, { clientId: row.clientId, projectId: row.projectId });
    await announceClientReportPublished(tenantId, actor, { id, clientId: row.clientId, projectId: row.projectId, title: row.title });
    return { id, status: "published" as const, publishedAt };
  }

  @Post(":tenantId/client-reports/:id/withdraw")
  @HttpCode(200)
  async withdraw(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { reason?: unknown } = {},
  ) {
    await authorize(req.principal, { kind: "client_report", tenantId }, "read");
    const row = await this.load(tenantId, id);
    await authorize(req.principal, this.resource(tenantId, row), "withdraw");
    const actor = req.principal.userId;
    if (!actor) throw new ForbiddenException("a person withdraws a report");
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!reason) throw new BadRequestException("reason_required");
    if (reason.length > MAX_REASON) throw new BadRequestException("reason_too_long");
    if (row.status !== "published") throw new ConflictException("not_published");

    const withdrawnAt = await withTenants([tenantId], async (c) => {
      const u = await c.query<{ withdrawn_at: string }>(
        `UPDATE client_reports
            SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = $2, withdrawn_reason = $3, updated_at = now()
          WHERE id = $1 AND status = 'published'
        RETURNING withdrawn_at`,
        [id, actor, reason],
      );
      if (!u.rows[0]) throw new ConflictException("not_published");
      // The portal's `reports` topic: an open Reports page refetches and the report is gone. No notice to the client.
      await emitEvent(c, tenantId, CLIENT_REPORT_ENTITY, id, "client_report.withdrawn", {
        clientId: row.clientId, projectId: row.projectId, source: row.source,
      });
      return u.rows[0].withdrawn_at;
    });
    await writeActivity(tenantId, actor, "withdrawn", CLIENT_REPORT_ENTITY, id, { clientId: row.clientId, reason });
    return { id, status: "withdrawn" as const, withdrawnAt };
  }

  /** The report and its client's owner. 404 for an unknown or malformed id (after the kind-level read, so a caller who may
   *  not read client reports never reaches it). */
  private async load(tenantId: string, id: string): Promise<ReportRow> {
    if (!isUuid(id)) throw new NotFoundException("report not found");
    const r = await withTenants([tenantId], (c) =>
      c.query<ReportRow>(
        `SELECT cr.id, cr.client_id AS "clientId", cr.project_id AS "projectId", cr.source, cr.status, cr.title,
                cl.owner_user_id AS "ownerUserId",
                (SELECT f.id FROM files f WHERE ${clientReportFileOf("f", "cr")}) AS "fileId"
           FROM client_reports cr JOIN clients cl ON cl.id = cr.client_id
          WHERE cr.id = $1`,
        [id],
      ),
    );
    if (!r.rows[0]) throw new NotFoundException("report not found");
    return r.rows[0];
  }

  /** The Cerbos resource for an action on one report. `ownerUserId` is the CLIENT's owner, read from the client row (never a
   *  body); "" when the client has none, which the owner rule refuses. */
  private resource(tenantId: string, row: ReportRow): Resource {
    return { kind: "client_report", id: row.id, tenantId, clientId: row.clientId, ownerUserId: row.ownerUserId ?? "" };
  }
}
