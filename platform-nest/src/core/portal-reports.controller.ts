// PV7-04a — the CLIENT side of client reports (docs/FRONTEND-BFF-CONTRACT.md §55.4).
//
//   GET  :t/portal/reports            the published reports in the caller's reach, newest first
//   POST :t/portal/reports/:id/read   the caller's read marker (the "New" badge clears)
//
// Core, not module-guarded (a client contact has no module), authorized on `portal · read` and scoped by
// `resolvePortalScope`, like every portal read. The file itself is downloaded through the portal's own route
// (`GET :t/portal/files/:fileId`, portal-commerce.controller.ts), where `client_report` is a DOWNLOADABLE kind.
//
// ⚠ WRITTEN ON THE BUILDERS FROM DAY ONE. Which rows a client may see is `clientReportInPortalScope` (portal-visibility.ts):
// published only, and the strict reach (a report with no project reaches client-wide contacts only). No row-visibility literal
// lives in this file; `portal-visibility.test.ts` lists it on SWITCHED and its scan fails on one.
//
// What a client never reads here: the status (every row is published by definition), the source id, the deliverable id, who
// published or withdrew it, a withdrawal reason, and drafts.
import { Controller, Get, HttpCode, NotFoundException, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../db";
import { authorize } from "./http";
import { AuthGuard } from "../auth/guards";
import { resolvePortalScope, scopeValues } from "./portal-scope";
import { clientReportInPortalScope, scopeAt } from "./portal-visibility";
import { clientReportFileOf } from "./client-reports";
import { isUuid } from "./conversation-core";

@Controller("api")
@UseGuards(AuthGuard)
export class PortalReportsController {
  @Get(":tenantId/portal/reports")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const rows = await c.query<{
        id: string; title: string; source: string; periodStart: string; periodEnd: string; clientId: string; clientName: string;
        projectId: string | null; projectName: string | null; publishedAt: string;
        fileId: string; filename: string; contentType: string; byteSize: string; readAt: string | null;
      }>(
        `SELECT cr.id, cr.title, cr.source,
                to_char(cr.period_start, 'YYYY-MM-DD') AS "periodStart", to_char(cr.period_end, 'YYYY-MM-DD') AS "periodEnd",
                cr.client_id AS "clientId", cl.name AS "clientName",
                cr.project_id AS "projectId", p.name AS "projectName",
                cr.published_at AS "publishedAt",
                f.id AS "fileId", f.filename, f.content_type AS "contentType", f.byte_size AS "byteSize",
                rr.read_at AS "readAt"
           FROM client_reports cr
           JOIN clients cl ON cl.id = cr.client_id
           LEFT JOIN projects p ON p.id = cr.project_id
           JOIN files f ON ${clientReportFileOf("f", "cr")}
           LEFT JOIN client_report_reads rr ON rr.report_id = cr.id AND rr.user_id = $4
          WHERE ${clientReportInPortalScope("cr", scopeAt(1))}
          ORDER BY cr.published_at DESC, cr.id
          LIMIT 300`,
        [...scopeValues(scope), req.principal.userId],
      );
      return rows.rows.map((r) => ({
        id: r.id, title: r.title, source: r.source, periodStart: r.periodStart, periodEnd: r.periodEnd,
        clientId: r.clientId, clientName: r.clientName, projectId: r.projectId, projectName: r.projectName,
        publishedAt: r.publishedAt,
        file: { id: r.fileId, filename: r.filename, contentType: r.contentType, byteSize: Number(r.byteSize) },
        readAt: r.readAt,
      }));
    });
  }

  /** The caller's read marker. The FIRST read is kept (a re-read changes nothing), so "opened on" stays true. 404, never 403,
   *  for a report that is not published, not in reach or not an id: the route must not tell a client which ids exist. */
  @Post(":tenantId/portal/reports/:id/read")
  @HttpCode(200)
  async markRead(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      if (!isUuid(id)) throw new NotFoundException("report not found");
      const found = await c.query(
        `SELECT cr.id FROM client_reports cr WHERE cr.id = $1 AND ${clientReportInPortalScope("cr", scopeAt(2))}`,
        [id, ...scopeValues(scope)],
      );
      if (!found.rows[0]) throw new NotFoundException("report not found");
      await c.query(
        `INSERT INTO client_report_reads (report_id, tenant_id, user_id) VALUES ($1, $2, $3)
         ON CONFLICT (report_id, user_id) DO NOTHING`,
        [id, tenantId, req.principal.userId],
      );
      const r = await c.query<{ read_at: string }>(
        `SELECT read_at FROM client_report_reads WHERE report_id = $1 AND user_id = $2`,
        [id, req.principal.userId],
      );
      return { id, readAt: r.rows[0].read_at };
    });
  }
}
