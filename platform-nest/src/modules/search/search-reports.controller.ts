// SM-22 — the client-facing report review -> approve -> render -> deliver lifecycle (design
// §04/§07/§12 SM-22; deps SM-10 [the data / narrative draft], SM-17 [usage/legend precedent], SM-18
// [SEM domain, read here for the Ads section]).
//
// A SEPARATE controller class from `SearchController` (same reason search-google-ads.controller.ts
// gives: SM-21 owns search.controller.ts's edit surface this wave, and SM-10 already added its own
// REPORTS section there — GET .../reports, GET reports/:id, POST engagements/:id/reports — which
// this file NEVER touches or re-implements). Nest permits multiple controller classes to share one
// route prefix as long as no individual path collides; every route below is a NEW path
// (reports/:id PATCH, reports/:id/approve, reports/:id/preview, reports/:id/deliver) that SM-10's
// controller never defines.
//
// LIFECYCLE (search_reports.status, 0034's CHECK): draft -[submit]-> in_review -[approve]-> approved
// -[deliver]-> delivered. SM-10's draftReportNarrative owns writes into 'draft' exclusively (and
// explicitly refuses to touch a report that has moved past it — see that method's own guard). This
// file owns every transition PAST 'draft':
//   - PATCH reports/:id           — edit narrativeMd (draft|in_review only) and/or submit for review
//                                    (draft -> in_review) or send back for rework (in_review -> draft).
//                                    Cerbos action `update` (module_staff and up).
//   - POST reports/:id/approve    — in_review -> approved, stamps approved_by/approved_at.
//                                    Cerbos action `approve` (module_manager/company_admin/
//                                    group_executive/platform_admin only, per resource_search_report.
//                                    yaml — module_staff is refused).
//   - GET reports/:id/preview     — read-only render (no file/deliverable write) so a reviewer can see
//                                    the exact client-facing document, including its honesty banner,
//                                    BEFORE approving. Cerbos action `read`.
//   - POST reports/:id/deliver    — approved -> delivered: renders the client-facing artifact, writes
//                                    it as a `files` row (mirrored to Shared Drive per WS11's existing
//                                    convention — this ticket writes the `files` row; the Drive mirror
//                                    job itself is WS11 infrastructure this ticket does not own),
//                                    best-effort links a `deliverables` row (only when the engagement
//                                    carries a `project_id` — deliverables.project_id is NOT NULL, so
//                                    a project-less engagement's report still delivers, just without a
//                                    PM-visible deliverable row; never blocked on this), and emits
//                                    `search.report.delivered`. Cerbos action `deliver` (same tier as
//                                    `approve`).
//
// HONESTY (ticket brief; see reports.ts's own header for the full rule set) — this file's job is
// ASSEMBLING the facts (DB reads only; every parse/render/disclosure decision lives in reports.ts,
// this module's one pure/testable file, mirroring the sem-export.ts / search-audit.ts split):
//   - rankTop10 / criticalFindingsOpen / kpiTargets are read VERBATIM from the report's own frozen
//     `metrics` column (SM-10's snapshot) — never recomputed here with a different query shape.
//   - Rank-snapshot PROVENANCE (real vs simulated) is this ticket's own additive disclosure, computed
//     over the identical "latest snapshot per (keyword,engine,device)" shape SM-10/index.ts already
//     use, so it describes the SAME rows the frozen count came from (never a competing redefinition).
//   - GSC/GA4/Ads sections are fresh reads of already-persisted tables for the report's own period —
//     never a live vendor call (this route has no scheduler wiring and touches no google/**/providers/
//     ** file). An empty result renders as "no data for this period", never a zero.
//   - `search_provider_calls.cost_usd` (our vendor cost-to-serve) is never queried, read, or rendered
//     anywhere in this file — see reports.ts's file-header rule 2.
import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity } from "../../core/http";
import { storage } from "../../core/storage";
import { emitEvent } from "../../events/outbox.service";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { GSC_FRESHNESS_LAG_DAYS } from "./google/gsc-client";
import {
  periodDateRange,
  renderReportMarkdown,
  summarizeSimulated,
  type AdsDisclosure,
  type AuditDisclosure,
  type FrozenReportMetrics,
  type Ga4Disclosure,
  type GscDisclosure,
  type RankDisclosure,
  type ReportRenderInput,
} from "./reports";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUuid(value: string, label: string): void {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new BadRequestException(`${label} must be a valid id`);
}

interface ReportFullRow {
  id: string;
  engagementId: string;
  propertyId: string;
  clientId: string;
  projectId: string | null;
  engagementName: string;
  clientName: string;
  period: string;
  kind: string;
  status: string;
  metrics: FrozenReportMetrics;
  narrativeMd: string;
  createdAt: string;
}

/** Own copy of the join search.controller.ts's `reportRow`/`engagementRow` helpers would otherwise
 *  duplicate — reimplemented here (not imported: those two are unexported private helpers in a file
 *  this ticket must not touch) with the additional columns THIS controller needs (client name,
 *  project id, frozen metrics, narrative). */
async function reportFullRow(c: PoolClient, reportId: string): Promise<ReportFullRow | null> {
  const r = await c.query<{
    id: string; engagement_id: string; property_id: string; client_id: string; project_id: string | null;
    engagement_name: string; client_name: string; period: string | null; kind: string; status: string;
    metrics: FrozenReportMetrics; narrative_md: string | null; created_at: string;
  }>(
    `SELECT sr.id, sr.engagement_id, se.property_id, se.client_id, se.project_id,
            se.name AS engagement_name, cl.name AS client_name,
            sr.period, sr.kind, sr.status, sr.metrics, sr.narrative_md, sr.created_at
       FROM search_reports sr
       JOIN search_engagements se ON se.id = sr.engagement_id
       JOIN clients cl ON cl.id = se.client_id
      WHERE sr.id = $1 AND sr.deleted_at IS NULL`,
    [reportId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id, engagementId: row.engagement_id, propertyId: row.property_id, clientId: row.client_id,
    projectId: row.project_id, engagementName: row.engagement_name, clientName: row.client_name,
    period: row.period ?? "", kind: row.kind, status: row.status,
    metrics: row.metrics ?? { rankTop10: 0, criticalFindingsOpen: 0, kpiTargets: [] },
    narrativeMd: row.narrative_md ?? "", createdAt: row.created_at,
  };
}

/** Assembles the full render input for a report by reading already-persisted data for its
 *  property/engagement + period date range. See file header for the honesty rules this must uphold —
 *  every DB read here is additive disclosure alongside the frozen metrics, never a redefinition of
 *  them. Runs inside the caller's own `withTenants` connection (module scope already open). */
async function buildRenderInput(c: PoolClient, report: ReportFullRow): Promise<ReportRenderInput> {
  const { start, end } = periodDateRange(report.period, new Date(report.createdAt));

  // ── Rank provenance (rule 6: additive disclosure over the SAME latest-snapshot shape SM-10 uses) ──
  const rankRows = await c.query<{ simulated: boolean; n: string }>(
    `SELECT simulated, count(*) AS n FROM (
       SELECT DISTINCT ON (keyword_id, engine, device) simulated
       FROM search_rank_snapshots WHERE property_id = $1
       ORDER BY keyword_id, engine, device, captured_at DESC
     ) latest GROUP BY simulated`,
    [report.propertyId],
  );
  const rankTotal = rankRows.rows.reduce((n, r) => n + Number(r.n), 0);
  const rank: RankDisclosure | null =
    rankTotal === 0
      ? null
      : {
          provenance: summarizeSimulated(
            rankRows.rows.flatMap((r) => Array.from({ length: Number(r.n) }, () => ({ simulated: r.simulated }))),
          ),
          asOf: new Date().toISOString(),
        };

  // ── Audits (no simulated dimension — these are our own crawls, not vendor-metered) ────────────────
  const auditRes = await c.query<{ n: string }>(
    `SELECT count(*) AS n FROM search_audits WHERE property_id = $1 AND status = 'completed'`,
    [report.propertyId],
  );
  const audit: AuditDisclosure = { auditsCompleted: Number(auditRes.rows[0]?.n ?? 0) };

  // ── GSC ────────────────────────────────────────────────────────────────────────────────────────
  const gscAgg = await c.query<{ simulated: boolean; n: string; clicks: string; impressions: string; maxdate: string }>(
    `SELECT simulated, count(*) AS n, COALESCE(sum(clicks),0) AS clicks, COALESCE(sum(impressions),0) AS impressions, max(date)::text AS maxdate
       FROM search_gsc_performance WHERE property_id = $1 AND date >= $2 AND date <= $3
       GROUP BY simulated`,
    [report.propertyId, start, end],
  );
  const gscTop = await c.query<{ query: string; clicks: string; impressions: string }>(
    `SELECT query, COALESCE(sum(clicks),0) AS clicks, COALESCE(sum(impressions),0) AS impressions
       FROM search_gsc_performance WHERE property_id = $1 AND date >= $2 AND date <= $3
       GROUP BY query ORDER BY sum(clicks) DESC LIMIT 10`,
    [report.propertyId, start, end],
  );
  const gscRowCount = gscAgg.rows.reduce((n, r) => n + Number(r.n), 0);
  const gsc: GscDisclosure = {
    present: gscRowCount > 0,
    totalClicks: gscAgg.rows.reduce((n, r) => n + Number(r.clicks), 0),
    totalImpressions: gscAgg.rows.reduce((n, r) => n + Number(r.impressions), 0),
    topQueries: gscTop.rows.map((r) => ({ query: r.query, clicks: Number(r.clicks), impressions: Number(r.impressions) })),
    provenance: {
      real: Number(gscAgg.rows.find((r) => !r.simulated)?.n ?? 0),
      simulated: Number(gscAgg.rows.find((r) => r.simulated)?.n ?? 0),
    },
    latestDate: gscAgg.rows.map((r) => r.maxdate).filter(Boolean).sort().at(-1) ?? null,
    lagDays: GSC_FRESHNESS_LAG_DAYS,
  };

  // ── GA4 ────────────────────────────────────────────────────────────────────────────────────────
  const ga4Agg = await c.query<{ simulated: boolean; sampled: boolean; n: string; sessions: string; conversions: string }>(
    `SELECT simulated, sampled, count(*) AS n, COALESCE(sum(sessions),0) AS sessions, COALESCE(sum(conversions),0) AS conversions
       FROM search_ga4_metrics WHERE property_id = $1 AND date >= $2 AND date <= $3
       GROUP BY simulated, sampled`,
    [report.propertyId, start, end],
  );
  const ga4RowCount = ga4Agg.rows.reduce((n, r) => n + Number(r.n), 0);
  const ga4: Ga4Disclosure = {
    present: ga4RowCount > 0,
    totalSessions: ga4Agg.rows.reduce((n, r) => n + Number(r.sessions), 0),
    totalConversions: ga4Agg.rows.reduce((n, r) => n + Number(r.conversions), 0),
    provenance: {
      real: ga4Agg.rows.filter((r) => !r.simulated).reduce((n, r) => n + Number(r.n), 0),
      simulated: ga4Agg.rows.filter((r) => r.simulated).reduce((n, r) => n + Number(r.n), 0),
    },
    anySampled: ga4Agg.rows.some((r) => r.sampled && Number(r.n) > 0),
  };

  // ── Ads (client's own media spend — search_campaign_metrics_daily.cost_minor, NEVER our
  //    search_provider_calls.cost_usd; that table is not read anywhere in this file) ─────────────────
  const adsAgg = await c.query<{ simulated: boolean; n: string; cost_minor: string; clicks: string; impressions: string; currency: string | null }>(
    `SELECT scmd.simulated, count(*) AS n, COALESCE(sum(scmd.cost_minor),0) AS cost_minor,
            COALESCE(sum(scmd.clicks),0) AS clicks, COALESCE(sum(scmd.impressions),0) AS impressions,
            (array_agg(scmd.currency) FILTER (WHERE scmd.currency IS NOT NULL))[1] AS currency
       FROM search_campaign_metrics_daily scmd
       JOIN search_campaigns sc ON sc.id = scmd.campaign_id
      WHERE sc.engagement_id = $1 AND scmd.date >= $2 AND scmd.date <= $3
      GROUP BY scmd.simulated`,
    [report.engagementId, start, end],
  );
  const adsRowCount = adsAgg.rows.reduce((n, r) => n + Number(r.n), 0);
  const ads: AdsDisclosure = {
    present: adsRowCount > 0,
    totalClientSpendMinor: adsAgg.rows.reduce((n, r) => n + Number(r.cost_minor), 0),
    currency: adsAgg.rows.map((r) => r.currency).find((c) => !!c) ?? null,
    totalClicks: adsAgg.rows.reduce((n, r) => n + Number(r.clicks), 0),
    totalImpressions: adsAgg.rows.reduce((n, r) => n + Number(r.impressions), 0),
    provenance: {
      real: adsAgg.rows.filter((r) => !r.simulated).reduce((n, r) => n + Number(r.n), 0),
      simulated: adsAgg.rows.filter((r) => r.simulated).reduce((n, r) => n + Number(r.n), 0),
    },
  };

  return {
    reportId: report.id, engagementName: report.engagementName, clientName: report.clientName,
    period: report.period, kind: report.kind, narrativeMd: report.narrativeMd, frozen: report.metrics,
    rank, audit, gsc, ga4, ads, generatedAt: new Date().toISOString(),
  };
}

@Controller("api/:tenantId/modules/search")
@UseGuards(AuthGuard, ModuleEnabledGuard("search"))
export class SearchReportsController {
  // ============================================================ SM-22: EDIT / SUBMIT / SEND BACK ====
  @Patch("reports/:id")
  @HttpCode(200)
  async updateReport(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { narrativeMd?: string; status?: string },
  ) {
    assertUuid(id, "report id");
    const report = await withTenants([tenantId], (c) => reportFullRow(c, id), { modules: ["search"] });
    if (!report) throw new NotFoundException("report not found");
    await authorize(req.principal, { kind: "resource_search_report", id, tenantId, module: "search" }, "update");

    let targetStatus = report.status;
    if (body?.status !== undefined) {
      if (body.status === "in_review") {
        if (report.status !== "draft") throw new BadRequestException(`cannot submit for review from '${report.status}' — only a 'draft' report can be submitted`);
        targetStatus = "in_review";
      } else if (body.status === "draft") {
        if (report.status !== "in_review") throw new BadRequestException(`cannot send back to draft from '${report.status}' — only an 'in_review' report can be sent back`);
        targetStatus = "draft";
      } else {
        throw new BadRequestException("status must be 'in_review' (submit for review) or 'draft' (send back)");
      }
    } else if (report.status !== "draft" && report.status !== "in_review") {
      throw new BadRequestException(`cannot edit a '${report.status}' report — only draft/in_review reports are editable`);
    }

    const narrativeMd = typeof body?.narrativeMd === "string" ? body.narrativeMd : undefined;

    await withTenants(
      [tenantId],
      async (c) => {
        const sets: string[] = ["updated_at = now()", "status = $2"];
        const params: unknown[] = [id, targetStatus];
        if (narrativeMd !== undefined) { params.push(narrativeMd); sets.push(`narrative_md = $${params.length}`); }
        // Compare-and-swap guard against the status this handler READ (report.status) — closes the
        // same concurrent-transition race sem-export.ts's mark-applied route documents: two requests
        // racing to submit/send-back the same report resolve at this row lock, and the loser's own
        // WHERE re-evaluates against the now-changed row and matches zero, refused below.
        params.push(report.status);
        const guardIdx = params.length;
        const r = await c.query(
          `UPDATE search_reports SET ${sets.join(", ")} WHERE id = $1 AND status = $${guardIdx} AND deleted_at IS NULL`,
          params,
        );
        if (r.rowCount === 0) throw new NotFoundException("report not found (or status changed concurrently)");
        if (targetStatus === "in_review" && report.status === "draft") {
          await emitEvent(c, tenantId, "search_report", id, "search.report.ready_for_review", {
            engagementId: report.engagementId, period: report.period, kind: report.kind,
          });
        }
      },
      { modules: ["search"] },
    );
    await writeActivity(tenantId, req.principal.userId, "updated", "search_report", id, { status: targetStatus, narrativeMdEdited: narrativeMd !== undefined });
    return { id, status: targetStatus };
  }

  // ============================================================ SM-22: APPROVE ========================
  @Post("reports/:id/approve")
  @HttpCode(200)
  async approveReport(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    assertUuid(id, "report id");
    const report = await withTenants([tenantId], (c) => reportFullRow(c, id), { modules: ["search"] });
    if (!report) throw new NotFoundException("report not found");
    await authorize(req.principal, { kind: "resource_search_report", id, tenantId, module: "search" }, "approve");
    if (report.status !== "in_review") {
      throw new BadRequestException(`cannot approve a '${report.status}' report — approval requires status='in_review'`);
    }
    await withTenants(
      [tenantId],
      (c) =>
        c.query(
          `UPDATE search_reports SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now()
             WHERE id = $1 AND status = 'in_review' AND deleted_at IS NULL`,
          [id, req.principal.userId],
        ),
      { modules: ["search"] },
    );
    await writeActivity(tenantId, req.principal.userId, "approved", "search_report", id, {});
    return { id, status: "approved" };
  }

  // ============================================================ SM-22: PREVIEW (read-only) ===========
  @Get("reports/:id/preview")
  async previewReport(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    assertUuid(id, "report id");
    const report = await withTenants([tenantId], (c) => reportFullRow(c, id), { modules: ["search"] });
    if (!report) throw new NotFoundException("report not found");
    await authorize(req.principal, { kind: "resource_search_report", id, tenantId, module: "search" }, "read");
    const rendered = await withTenants([tenantId], async (c) => renderReportMarkdown(await buildRenderInput(c, report)), { modules: ["search"] });
    return rendered;
  }

  // ============================================================ SM-22: DELIVER =========================
  // approved -> delivered: render + persist as a `files` artifact + best-effort `deliverables` link +
  // emit `search.report.delivered`. Re-delivering an already-delivered report is refused (never
  // silently re-renders/re-files — a client-facing artifact, once sent, is not something this route
  // quietly replaces); a fresh render for an already-approved-not-yet-delivered report is idempotent
  // at the DB layer via the `status = 'approved'` guard on the UPDATE below (same compare-and-swap
  // idiom sem-export.ts's mark-applied route uses).
  @Post("reports/:id/deliver")
  @HttpCode(200)
  async deliverReport(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    assertUuid(id, "report id");
    const report = await withTenants([tenantId], (c) => reportFullRow(c, id), { modules: ["search"] });
    if (!report) throw new NotFoundException("report not found");
    await authorize(req.principal, { kind: "resource_search_report", id, tenantId, module: "search" }, "deliver");
    if (report.status !== "approved") {
      throw new BadRequestException(`cannot deliver a '${report.status}' report — delivery requires status='approved'`);
    }

    const rendered = await withTenants([tenantId], async (c) => renderReportMarkdown(await buildRenderInput(c, report)), { modules: ["search"] });

    const fileId = newId();
    const storageKey = `${tenantId}/search-reports/${fileId}`;
    const bytes = Buffer.from(rendered.markdown, "utf8");
    await storage().put(storageKey, bytes);

    const result = await withTenants(
      [tenantId],
      async (c) => {
        await c.query(
          `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, scrubbed, origin_site)
           VALUES ($1,$2,$3,'search_report',$4,$5,'text/markdown',$6,$7,false,$8)`,
          [fileId, tenantId, req.principal.userId, id, rendered.filename, bytes.byteLength, storageKey, config.originSite],
        );

        // Best-effort deliverable link: `deliverables.project_id` is NOT NULL (0001_core.sql), so an
        // engagement with no `project_id` (search_engagements.project_id is nullable — "optional: ties
        // into PM/time/deliverables", 0034) legitimately cannot get one. Never block delivery on this —
        // the client-facing artifact + notification are the actual deliverable this ticket must not fail.
        let deliverableId: string | null = null;
        if (report.projectId) {
          deliverableId = newId();
          await c.query(
            `INSERT INTO deliverables (id, tenant_id, project_id, client_id, name, status, custom_fields, origin_site)
             VALUES ($1,$2,$3,$4,$5,'delivered','{}',$6)`,
            [deliverableId, tenantId, report.projectId, report.clientId, `${report.kind} report — ${report.period}`, config.originSite],
          );
        }

        const r = await c.query(
          `UPDATE search_reports
             SET status = 'delivered', file_id = $2, deliverable_id = $3, delivered_at = now(), updated_at = now()
           WHERE id = $1 AND status = 'approved' AND deleted_at IS NULL`,
          [id, fileId, deliverableId],
        );
        if (r.rowCount === 0) throw new BadRequestException("report status changed concurrently — not delivered twice");

        await emitEvent(c, tenantId, "search_report", id, "search.report.delivered", {
          engagementId: report.engagementId, period: report.period, kind: report.kind,
          fileId, deliverableId, anySimulated: rendered.anySimulated, allSimulated: rendered.allSimulated,
        });
        return { deliverableId };
      },
      { modules: ["search"] },
    );

    await writeActivity(tenantId, req.principal.userId, "delivered", "search_report", id, {
      fileId, deliverableId: result.deliverableId, filename: rendered.filename,
      anySimulated: rendered.anySimulated, allSimulated: rendered.allSimulated,
    });
    return {
      id, status: "delivered", fileId, filename: rendered.filename,
      deliverableId: result.deliverableId, anySimulated: rendered.anySimulated, allSimulated: rendered.allSimulated,
    };
  }
}
