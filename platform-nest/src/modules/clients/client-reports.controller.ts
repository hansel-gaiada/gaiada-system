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
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Patch, Post, Req,
  UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
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
import { buildAccountSummarySnapshot, parseSummaryPeriod } from "./account-summary/snapshot";
import {
  MAX_SUMMARY_NARRATIVE_CHARS, draftSummaryNarrative, findLiveSummary, insertSummaryDraft,
} from "./account-summary/draft";
import { publishAccountSummary } from "./account-summary/publish";

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
      return { reports: await loadStaffReports(c, { clientId }) };
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
    // PV7-07: an account summary has no file until now. It is rendered, stored and published in one flow
    // (account-summary/publish.ts); a render failure is a 503 and the report stays a draft. Social and search reports publish
    // at delivery with the module's own file, and this route keeps its PV7-04a behaviour for them.
    const publishedAt = row.source === "account_summary"
      ? await publishAccountSummary({ tenantId, reportId: id, clientId: row.clientId, projectId: row.projectId, actor })
      : await this.publishWithFile(tenantId, id, actor, row);
    await writeActivity(tenantId, actor, "published", CLIENT_REPORT_ENTITY, id, { clientId: row.clientId, projectId: row.projectId });
    await announceClientReportPublished(tenantId, actor, { id, clientId: row.clientId, projectId: row.projectId, title: row.title });
    return { id, status: "published" as const, publishedAt };
  }

  /** PV7-04a: publish a draft that already has its own file. Compare-and-swap on the state AND the file, so a concurrent publish
   *  or a file change between the read and the write cannot publish twice or publish without its own file. */
  private async publishWithFile(tenantId: string, id: string, actor: string, row: ReportRow): Promise<string> {
    if (!row.fileId) throw new ConflictException("report_has_no_file");
    return withTenants([tenantId], async (c) => {
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
  }

  // ── PV7-07: the monthly account summary (BFF §56) ─────────────────────────────────────────────────
  // ORDER: the kind-level read, then the client (its owner feeds the `draft` rule), then `draft`, THEN the body (a malformed
  // period is a 400 only for a caller who may draft, so a denial test with a sloppy body still tests authorization).
  @Post(":tenantId/clients/:clientId/reports/summary")
  @HttpCode(200)
  async draftSummary(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("clientId") clientId: string,
    @Body() body: { period?: unknown } = {},
  ) {
    await authorize(req.principal, { kind: "client_report", tenantId }, "read");
    if (!isUuid(clientId)) throw new NotFoundException("client not found");
    const client = await withTenants([tenantId], (c) =>
      c.query<{ id: string; name: string; isInternal: boolean; ownerUserId: string | null }>(
        `SELECT id, name, is_internal AS "isInternal", owner_user_id AS "ownerUserId" FROM clients WHERE id = $1 AND deleted_at IS NULL`,
        [clientId],
      ),
    );
    const cl = client.rows[0];
    if (!cl) throw new NotFoundException("client not found");
    await authorize(req.principal, { kind: "client_report", tenantId, clientId, ownerUserId: cl.ownerUserId ?? "" }, "draft");
    const actor = req.principal.userId;
    if (!actor) throw new ForbiddenException("a person drafts a report");

    const period = parseSummaryPeriod(body?.period);
    if (!period) throw new BadRequestException("invalid_period");
    const now = new Date();
    if (period.startAt.getTime() > now.getTime()) throw new BadRequestException("period_in_future");
    // The internal sentinel client is never part of a portal scope (WSK-D36): there is no client to show a summary to.
    if (cl.isInternal) throw new BadRequestException("internal_client");

    // One live summary per client and month: a retry (an agent's, a double click) gets the existing draft, not a second one.
    const live = await withTenants([tenantId], (c) => findLiveSummary(c, clientId, period.periodStart));
    if (live) return this.summaryAnswer(tenantId, live, false);

    const snapshot = await buildAccountSummarySnapshot({ tenantId, clientId, clientName: cl.name, period }, { now });
    const narrative = await draftSummaryNarrative(snapshot, { tenantId, userId: actor, surface: "other", task: "clients.account_summary" });
    const made = await insertSummaryDraft(tenantId, { clientId, actor, period, snapshot, narrative });
    if (made.created) {
      await writeActivity(tenantId, actor, "drafted", CLIENT_REPORT_ENTITY, made.id, {
        clientId, source: "account_summary", period: period.period, narrativeSource: narrative.source,
      });
    }
    return this.summaryAnswer(tenantId, made, made.created);
  }

  @Patch(":tenantId/client-reports/:id")
  @HttpCode(200)
  async editNarrative(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { narrativeMd?: unknown } = {},
  ) {
    await authorize(req.principal, { kind: "client_report", tenantId }, "read");
    const row = await this.load(tenantId, id);
    await authorize(req.principal, this.resource(tenantId, row), "draft");
    const actor = req.principal.userId;
    if (!actor) throw new ForbiddenException("a person edits a report");
    if (row.source !== "account_summary") throw new ConflictException("not_an_account_summary");
    if (row.status !== "draft") throw new ConflictException("not_a_draft");
    const text = typeof body?.narrativeMd === "string" ? body.narrativeMd.trim() : "";
    if (!text) throw new BadRequestException("narrative_required");
    if (text.length > MAX_SUMMARY_NARRATIVE_CHARS) throw new BadRequestException("narrative_too_long");

    await withTenants([tenantId], async (c) => {
      const u = await c.query(
        `UPDATE client_reports SET narrative_md = $2, narrative_source = 'human', updated_at = now()
          WHERE id = $1 AND status = 'draft' AND source = 'account_summary'`,
        [id, text],
      );
      if (!u.rowCount) throw new ConflictException("not_a_draft");
    });
    await writeActivity(tenantId, actor, "edited", CLIENT_REPORT_ENTITY, id, { clientId: row.clientId });
    return { report: await this.one(tenantId, id) };
  }

  private async summaryAnswer(tenantId: string, r: { id: string; status: string }, created: boolean) {
    // A published summary already covers the month: it is withdrawn before a new one is drafted.
    if (r.status !== "draft") throw new ConflictException("summary_published");
    return { created, report: await this.one(tenantId, r.id) };
  }

  private async one(tenantId: string, id: string): Promise<StaffClientReport> {
    const rows = await withTenants([tenantId], (c) => loadStaffReports(c, { id }));
    if (!rows[0]) throw new NotFoundException("report not found");
    return rows[0];
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

/** One staff report, as `GET :t/clients/:clientId/reports` lists it (BFF §55.3, plus §56.3's summary fields). */
export type StaffClientReport = Record<string, unknown> & { id: string; source: ClientReportSource; status: ClientReportStatus };

/** The staff read of client reports: every report of one client, or one report by id. For an `account_summary` row the list
 *  also carries `period`, `narrativeMd`, `narrativeSource`, `generatedAt` and the frozen `snapshot`. */
export async function loadStaffReports(c: PoolClient, where: { clientId: string } | { id: string }): Promise<StaffClientReport[]> {
  const byClient = "clientId" in where;
  const rows = await c.query<Record<string, unknown>>(
    `SELECT cr.id, cr.client_id AS "clientId", cr.project_id AS "projectId", p.name AS "projectName",
            cr.source, cr.source_id AS "sourceId", cr.deliverable_id AS "deliverableId", cr.title,
            to_char(cr.period_start, 'YYYY-MM-DD') AS "periodStart", to_char(cr.period_end, 'YYYY-MM-DD') AS "periodEnd",
            cr.status, f.id AS "fileId", f.filename, f.content_type AS "contentType", f.byte_size AS "byteSize",
            cr.created_at AS "createdAt", cr.published_at AS "publishedAt", pu.name AS "publishedByName",
            cr.withdrawn_at AS "withdrawnAt", wu.name AS "withdrawnByName", cr.withdrawn_reason AS "withdrawnReason",
            ${staffClientReportClientVisible("cr")} AS "clientVisible",
            (SELECT count(*)::int FROM client_report_reads rr WHERE rr.report_id = cr.id) AS "readCount",
            to_char(cr.period_start, 'YYYY-MM') AS "period", cr.narrative_md AS "narrativeMd",
            cr.narrative_source AS "narrativeSource", cr.generated_at AS "generatedAt", cr.snapshot
       FROM client_reports cr
       LEFT JOIN projects p ON p.id = cr.project_id
       LEFT JOIN files f ON ${clientReportFileOf("f", "cr")}
       LEFT JOIN users pu ON pu.id = cr.published_by
       LEFT JOIN users wu ON wu.id = cr.withdrawn_by
      WHERE ${byClient ? "cr.client_id = $1" : "cr.id = $1"}
      ORDER BY COALESCE(cr.published_at, cr.created_at) DESC, cr.id
      LIMIT 500`,
    [byClient ? where.clientId : (where as { id: string }).id],
  );
  return rows.rows.map((r) => {
    const { fileId, filename, contentType, byteSize, period, narrativeMd, narrativeSource, generatedAt, snapshot, ...rest } = r;
    const base = {
      ...rest,
      file: fileId ? { id: fileId, filename, contentType, byteSize: Number(byteSize) } : null,
    };
    // The summary fields belong to an account summary only; a social or search row keeps the 04a shape exactly.
    return (rest.source === "account_summary"
      ? { ...base, period, narrativeMd, narrativeSource, generatedAt, snapshot }
      : base) as unknown as StaffClientReport;
  });
}
