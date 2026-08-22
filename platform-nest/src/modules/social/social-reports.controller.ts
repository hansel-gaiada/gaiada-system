// SMM-23 — the client-facing engagement report lifecycle: snapshot + AI narrative -> approve ->
// render -> files + Drive + deliverable. Design smm-design.md §04/§07 as amended by
// smm-design-addendum-2026-08-12.md Δ13 ("rendering and delivery reuse the existing print pipeline
// — SMM-23 does not invent a renderer") and §A3 (`social_reports`, already created by 0105 — no
// migration in this ticket).
//
// A SEPARATE controller class from `SocialController`, for the same reason
// `search-reports.controller.ts` gives (its own header, verbatim structure copied here): three
// other seats hold `social.controller.ts`'s edit surface this wave, and Nest permits multiple
// controller classes to share one route prefix as long as no individual path collides — every
// route below (`reports`, `reports/:id`, `reports/:id/approve`, `reports/:id/deliver`,
// `engagements/:engagementId/reports`) is new.
//
// ── APPROVAL MECHANISM — READ BOTH EXISTING SURFACES BEFORE PICKING ────────────────────────────
// This module already has two approval surfaces: SMM-09's D14 executable-approval registry
// (`core/approval-executables.ts`, `social.publishPost`) and SMM-31's client-review portal stage
// (`social_post_client_reviews`). NEITHER is reused here, and the reason is written down rather
// than guessed:
//   - D14 is for a write that must EXECUTE the instant a human approves it (publish to a live
//     account). A report's approval is an internal sign-off that the numbers and narrative are
//     right — nothing dispatches on approval; `deliver` is its own, later, separately-gated step.
//     Registering it in the D14 registry would suspend an ordinary in-console approve click into
//     the automation-approvals inbox for no reason: no tool call is being re-driven, there is
//     nothing here for a grant to re-execute.
//   - SMM-31's client-review stage is the CLIENT's own sign-off on a POST before it may be
//     submitted for publish — a different resource, a different table (`social_post_client_reviews`,
//     plain tenant wall per D-16/Δ8), and a different audience. A report is staff-authored and
//     staff-approved; the client never touches this kind (see the Cerbos policy's own invariant
//     comment: "`client` appears NOWHERE").
//   - What actually fits, and what base smm-design.md §07 already says verbatim: "Low-impact
//     artifacts (reports, campaign plans) approve in-console via module permissions
//     (`social:report:approve`)". `social.report.approve`/`social.report.deliver` are ALREADY
//     catalog rows and Cerbos actions (0106/SMM-30's forward-looking seed,
//     `resource_social_report.yaml`) — this ticket is the first to build the endpoints that honour
//     them, exactly the same shape SM-22 (`search-reports.controller.ts`) built for `search_report`.
//
// ── RENDER PATH — REUSES THE EXISTING SIDECAR, INVENTS NOTHING ────────────────────────────────
// `deliverReport` below shapes the frozen snapshot + narrative into a `ReportDocument`
// (`reports.ts#buildSocialReportDocument`) — the SAME contract `platform-nest/src/modules/reports/
// report-document.ts` defines and `platform-ui`'s `/print/reports/[jobToken]` already renders via
// `ReportViewer` — then calls the SAME `mintPrintJobToken`/`renderPdfViaSidecar`
// (`../reports/report-pdf-export.ts`) TR-21 built for the 4-grain tracker's own PDF export. No new
// renderer, no new print route, no new sidecar client.
import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, ServiceUnavailableException, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity } from "../../core/http";
import { storage } from "../../core/storage";
import { emitEvent } from "../../events/outbox.service";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { completeViaGateway } from "./gateway-client";
import { queryBrandKnowledge } from "./knowledge-client";
import { buildReportNarrativePrompt, parseReportNarrativeDraft, type ReportNarrativeGroundingFacts } from "./ai-drafts";
import {
  periodDateRange, buildSocialReportSnapshot, buildSocialReportDocument,
  type ReportKind, type FrozenSocialReportMetrics, type DailyMetricInput, type PostMetricInput, type KpiTargetInput,
} from "./reports";
import { PdfRendererNotConfiguredError, mintPrintJobToken, renderPdfViaSidecar } from "../reports/report-pdf-export";

// SMM-19 grounds a draft in the client's OWN brand corpus, at most this many hits — reuse the same
// bound `ai-drafts.ts` already declares for captions rather than a second constant.
const REPORT_KNOWLEDGE_HITS = 8;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUuid(value: string, label: string): void {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new BadRequestException({ message: `${label}_invalid` });
}
function refuse(reason: string): never {
  throw new BadRequestException({ message: reason });
}

const REPORT_KINDS = new Set<ReportKind>(["monthly", "campaign", "adhoc"]);

interface ReportRow {
  id: string;
  tenantId: string;
  engagementId: string;
  clientId: string;
  clientName: string;
  engagementName: string;
  projectId: string | null;
  period: string | null;
  kind: ReportKind;
  status: string;
  metrics: FrozenSocialReportMetrics;
  narrativeMd: string;
  createdAt: string;
}

async function loadReport(c: PoolClient, id: string): Promise<ReportRow | null> {
  const r = await c.query<{
    id: string; tenant_id: string; engagement_id: string; client_id: string; client_name: string;
    engagement_name: string; project_id: string | null; period: string | null; kind: string;
    status: string; metrics: FrozenSocialReportMetrics; narrative_md: string | null; created_at: string;
  }>(
    `SELECT sr.id, sr.tenant_id, sr.engagement_id, se.client_id, cl.name AS client_name,
            se.name AS engagement_name, se.project_id, sr.period, sr.kind, sr.status,
            sr.metrics, sr.narrative_md, sr.created_at
       FROM social_reports sr
       JOIN social_engagements se ON se.id = sr.engagement_id AND se.tenant_id = sr.tenant_id
       JOIN clients cl ON cl.id = se.client_id
      WHERE sr.id = $1 AND sr.deleted_at IS NULL`,
    [id],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id, tenantId: row.tenant_id, engagementId: row.engagement_id, clientId: row.client_id,
    clientName: row.client_name, engagementName: row.engagement_name, projectId: row.project_id,
    period: row.period, kind: row.kind as ReportKind, status: row.status,
    metrics: row.metrics ?? { rangeStart: "", rangeEnd: "", kpis: [], series: [], tables: [], highlights: [] },
    narrativeMd: row.narrative_md ?? "", createdAt: row.created_at,
  };
}

@Controller("api/:tenantId/modules/social")
@UseGuards(AuthGuard, ModuleEnabledGuard("social"))
export class SocialReportsController {
  // ==================================================================== CREATE (snapshot + AI narrative)
  // Draft only — status law identical to search's draftReportNarrative (SM-10): this endpoint never
  // writes past 'draft'. The module GUC (recurring defect class #1): every query below runs inside
  // ONE `withTenants([tenantId], fn, { modules: ["social"] })` call, the SAME convention every other
  // route in `social.controller.ts` uses — omit that option and every SELECT/INSERT below reads or
  // writes ZERO ROWS, silently, which is exactly why `social-reports.test.ts`'s "(module GUC)" case
  // pins this by deleting the option and watching the assertion fail.
  @Post("engagements/:engagementId/reports")
  @HttpCode(201)
  async createReport(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("engagementId") engagementId: string,
    @Body() body: { id?: string; kind?: string; period?: string } = {},
  ) {
    assertUuid(engagementId, "engagement_id");
    if (body.id) assertUuid(body.id, "id");
    const kind = (body.kind ?? "monthly") as ReportKind;
    if (!REPORT_KINDS.has(kind)) refuse("invalid_kind");
    const period = body.period ?? null;
    await authorize(req.principal, { kind: "social_report", tenantId, module: "social" }, "create");

    const id = body.id ?? newId();

    // Idempotent (agentic criterion 3): a caller-supplied id that already exists returns the
    // EXISTING frozen row untouched — never a re-snapshot, and never a second gateway call spent on
    // a retry (mirrors createEngagement/createPost's own idempotency shape).
    const existing = await withTenants([tenantId], (c) => loadReport(c, id), { modules: ["social"] });
    if (existing && existing.engagementId === engagementId) {
      return { id: existing.id, status: existing.status, metrics: existing.metrics, narrativeMd: existing.narrativeMd, draftedVia: "existing" as const };
    }

    const eng = await withTenants(
      [tenantId],
      (c) => c.query<{ client_id: string; client_name: string; name: string }>(
        `SELECT se.client_id, cl.name AS client_name, se.name
           FROM social_engagements se JOIN clients cl ON cl.id = se.client_id
          WHERE se.id = $1 AND se.deleted_at IS NULL`,
        [engagementId],
      ),
      { modules: ["social"] },
    );
    const engRow = eng.rows[0];
    if (!engRow) throw new NotFoundException("engagement not found");

    const { start, end } = periodDateRange(period, new Date());

    const snapshotInput = await withTenants(
      [tenantId],
      async (c) => {
        const dailyRes = await c.query<{
          account_id: string; network: string; date: string; followers: number | null;
          impressions: number | null; reach: number | null; engagements: number | null;
          link_clicks: number | null; video_views: number | null;
        }>(
          `SELECT m.account_id, a.network, m.date::text AS date, m.followers, m.impressions,
                  m.reach, m.engagements, m.link_clicks, m.video_views
             FROM social_metrics_daily m
             JOIN social_accounts a ON a.id = m.account_id AND a.tenant_id = m.tenant_id
            WHERE a.client_id = $1 AND m.date >= $2::date AND m.date <= $3::date AND a.deleted_at IS NULL
            ORDER BY m.account_id, m.date`,
          [engRow.client_id, start, end],
        );
        const daily: DailyMetricInput[] = dailyRes.rows.map((r) => ({
          accountId: r.account_id, network: r.network, date: r.date,
          followers: r.followers, impressions: r.impressions, reach: r.reach,
          engagements: r.engagements, linkClicks: r.link_clicks, videoViews: r.video_views,
        }));

        const publishedRes = await c.query<{
          variant_id: string; network: string; published_at: string | null;
          impressions: number | null; likes: number | null; comments: number | null;
          shares: number | null; saves: number | null; video_views: number | null; clicks: number | null;
        }>(
          `SELECT DISTINCT ON (v.id)
                  v.id AS variant_id, a.network, v.published_at::text AS published_at,
                  pm.impressions, pm.likes, pm.comments, pm.shares, pm.saves, pm.video_views, pm.clicks
             FROM social_post_variants v
             JOIN social_posts p ON p.id = v.post_id AND p.tenant_id = v.tenant_id
             JOIN social_accounts a ON a.id = v.account_id AND a.tenant_id = v.tenant_id
             LEFT JOIN LATERAL (
               SELECT * FROM social_post_metrics pm2
                WHERE pm2.variant_id = v.id ORDER BY pm2.fetched_at DESC LIMIT 1
             ) pm ON true
            WHERE p.engagement_id = $1 AND v.status = 'published' AND v.deleted_at IS NULL
              AND v.published_at >= $2::date AND v.published_at < ($3::date + interval '1 day')`,
          [engagementId, start, end],
        );
        const posts: PostMetricInput[] = publishedRes.rows.map((r) => ({
          variantId: r.variant_id, network: r.network, publishedAt: r.published_at,
          impressions: r.impressions, likes: r.likes, comments: r.comments, shares: r.shares,
          saves: r.saves, videoViews: r.video_views, clicks: r.clicks,
        }));

        const kpiTargetsRes = await c.query<{ metric_key: string; target_value: string; direction: string; due_period: string | null }>(
          `SELECT metric_key, target_value, direction, due_period
             FROM social_kpi_targets WHERE engagement_id = $1 AND deleted_at IS NULL`,
          [engagementId],
        );
        const kpiTargets: KpiTargetInput[] = kpiTargetsRes.rows.map((r) => ({
          metricKey: r.metric_key, targetValue: Number(r.target_value),
          direction: r.direction as "up" | "down", duePeriod: r.due_period,
        }));

        return { daily, posts, postsPublishedInPeriod: posts.length, kpiTargets };
      },
      { modules: ["social"] },
    );

    const frozen = buildSocialReportSnapshot({ rangeStart: start, rangeEnd: end, ...snapshotInput });

    // ── AI narrative, grounded in THIS client's own brand corpus (SMM-19's path — never a second
    //    route to the gateway). `clientId` comes from the engagement row this handler already
    //    resolved server-side, never from a request body field — the exact property
    //    `social-reports.test.ts`'s cross-client leak test drives end to end. ──────────────────────
    const knowledgeHits = await queryBrandKnowledge(
      req.principal.userId, tenantId, engRow.client_id,
      `${engRow.name} performance report ${period ?? ""}`.trim(), REPORT_KNOWLEDGE_HITS,
    );
    const narrativeFacts: ReportNarrativeGroundingFacts = {
      engagementName: engRow.name, clientName: engRow.client_name,
      periodLabel: `${start} – ${end}`,
      kpis: frozen.kpis.map((k) => ({ label: k.label, value: k.value, unit: k.unit })),
      topPosts: (frozen.tables.find((t) => t.key === "top_posts")?.rows ?? []).map((r) => ({
        network: String(r.network ?? ""), publishedAt: r.publishedAt === null ? null : String(r.publishedAt),
        impressions: typeof r.impressions === "number" ? r.impressions : null,
      })),
      knowledgeHits: knowledgeHits.map((h) => ({ sourceRef: h.sourceRef, text: h.text })),
    };
    const prompt = buildReportNarrativePrompt(narrativeFacts);
    let raw: string | null = null;
    try {
      raw = (await completeViaGateway(prompt)).text;
    } catch {
      raw = null; // fail-soft: a gateway hiccup drafts the deterministic fallback, never blocks report creation
    }
    const { text: narrativeText, draftedVia, rejectedNumbers } = parseReportNarrativeDraft(raw, narrativeFacts);
    // Frozen alongside the numbers (reports.ts's own header on `narrativeSource`) so a later read
    // never claims an AI narrative that a gateway hiccup actually fell back from.
    frozen.narrativeSource = draftedVia === "ai" ? "ai" : "deterministic";

    await withTenants(
      [tenantId],
      (c) => c.query(
        `INSERT INTO social_reports (id, tenant_id, engagement_id, period, kind, status, metrics, narrative_md, origin_site)
         VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [id, tenantId, engagementId, period, kind, JSON.stringify(frozen), narrativeText, config.originSite],
      ),
      { modules: ["social"] },
    );
    await writeActivity(tenantId, req.principal.userId, "created", "social_report", id, {
      engagementId, kind, period, draftedVia, groundedOn: knowledgeHits.map((h) => h.sourceRef),
      // Recorded so a REJECTED narrative is distinguishable from a gateway hiccup: both land as
      // draftedVia:'fallback', but only one means the model stated a number nothing grounded.
      // Absent (not `[]`) when nothing was rejected — an empty array would read as "checked and
      // clean" on the AI path and "checked and clean" on the fallback path alike, which is exactly
      // the absent-vs-zero conflation this module refuses.
      ...(rejectedNumbers && rejectedNumbers.length > 0 ? { narrativeRejectedNumbers: rejectedNumbers } : {}),
    });
    return { id, status: "draft", metrics: frozen, narrativeMd: narrativeText, draftedVia, groundedOn: knowledgeHits.map((h) => h.sourceRef) };
  }

  // ==================================================================== LIST / DETAIL ============
  @Get("reports")
  async listReports(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("engagementId") engagementId?: string, @Query("status") status?: string,
  ) {
    await authorize(req.principal, { kind: "social_report", tenantId, module: "social" }, "read");
    const params: unknown[] = [];
    const where: string[] = ["sr.deleted_at IS NULL"];
    if (engagementId) { params.push(engagementId); where.push(`sr.engagement_id = $${params.length}`); }
    if (status) { params.push(status); where.push(`sr.status = $${params.length}`); }
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT sr.id, sr.engagement_id AS "engagementId", cl.name AS "clientName", sr.period, sr.kind,
                sr.status, sr.created_at AS "createdAt", sr.approved_at AS "approvedAt", sr.delivered_at AS "deliveredAt"
           FROM social_reports sr
           JOIN social_engagements se ON se.id = sr.engagement_id AND se.tenant_id = sr.tenant_id
           JOIN clients cl ON cl.id = se.client_id
          WHERE ${where.join(" AND ")}
          ORDER BY sr.created_at DESC LIMIT 500`,
        params,
      ),
      { modules: ["social"] },
    );
    return { reports: rows };
  }

  @Get("reports/:id")
  async getReport(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    assertUuid(id, "id");
    const report = await withTenants([tenantId], (c) => loadReport(c, id), { modules: ["social"] });
    if (!report) throw new NotFoundException("report not found");
    await authorize(req.principal, { kind: "social_report", id, tenantId, module: "social" }, "read");
    const document = buildSocialReportDocument({
      tenantId, engagementId: report.engagementId, clientName: report.clientName, kind: report.kind,
      period: report.period, status: report.status, frozen: report.metrics, narrativeText: report.narrativeMd,
      generatedAt: new Date().toISOString(),
    });
    return { id: report.id, status: report.status, engagementId: report.engagementId, document };
  }

  // ==================================================================== EDIT / SUBMIT / SEND BACK
  @Patch("reports/:id")
  @HttpCode(200)
  async updateReport(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { narrativeMd?: string; status?: string } = {},
  ) {
    assertUuid(id, "id");
    const report = await withTenants([tenantId], (c) => loadReport(c, id), { modules: ["social"] });
    if (!report) throw new NotFoundException("report not found");
    await authorize(req.principal, { kind: "social_report", id, tenantId, module: "social" }, "update");

    let targetStatus = report.status;
    if (body.status !== undefined) {
      if (body.status === "in_review") {
        if (report.status !== "draft") refuse("cannot_submit_from_this_status");
        targetStatus = "in_review";
      } else if (body.status === "draft") {
        if (report.status !== "in_review") refuse("cannot_send_back_from_this_status");
        targetStatus = "draft";
      } else {
        refuse("invalid_status_transition");
      }
    } else if (report.status !== "draft" && report.status !== "in_review") {
      refuse("report_not_editable");
    }

    const narrativeMd = typeof body.narrativeMd === "string" ? body.narrativeMd : undefined;

    await withTenants(
      [tenantId],
      async (c) => {
        const sets: string[] = ["updated_at = now()", "status = $2"];
        const params: unknown[] = [id, targetStatus];
        if (narrativeMd !== undefined) { params.push(narrativeMd); sets.push(`narrative_md = $${params.length}`); }
        params.push(report.status); // compare-and-swap against the status this handler read
        const guardIdx = params.length;
        const r = await c.query(
          `UPDATE social_reports SET ${sets.join(", ")} WHERE id = $1 AND status = $${guardIdx} AND deleted_at IS NULL`,
          params,
        );
        if (r.rowCount === 0) throw new BadRequestException({ message: "status_changed_concurrently" });
        if (targetStatus === "in_review" && report.status === "draft") {
          await emitEvent(c, tenantId, "social_report", id, "social.report.ready_for_review", {
            engagementId: report.engagementId, period: report.period, kind: report.kind,
          });
        }
      },
      { modules: ["social"] },
    );
    await writeActivity(tenantId, req.principal.userId, "updated", "social_report", id, { status: targetStatus, narrativeMdEdited: narrativeMd !== undefined });
    return { id, status: targetStatus };
  }

  // ==================================================================== APPROVE ===================
  // Base design §07: "Low-impact artifacts (reports, campaign plans) approve in-console via module
  // permissions" — this IS that approval. See the file header for why neither the D14 registry nor
  // SMM-31's client-review stage fits.
  @Post("reports/:id/approve")
  @HttpCode(200)
  async approveReport(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    assertUuid(id, "id");
    const report = await withTenants([tenantId], (c) => loadReport(c, id), { modules: ["social"] });
    if (!report) throw new NotFoundException("report not found");
    await authorize(req.principal, { kind: "social_report", id, tenantId, module: "social" }, "approve");
    if (report.status !== "in_review") refuse("cannot_approve_from_this_status");
    await withTenants(
      [tenantId],
      (c) => c.query(
        `UPDATE social_reports SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now()
           WHERE id = $1 AND status = 'in_review' AND deleted_at IS NULL`,
        [id, req.principal.userId],
      ),
      { modules: ["social"] },
    );
    await writeActivity(tenantId, req.principal.userId, "approved", "social_report", id, {});
    return { id, status: "approved" };
  }

  // ==================================================================== DELIVER ===================
  // approved -> delivered: render via the EXISTING print pipeline (mintPrintJobToken +
  // renderPdfViaSidecar, `../reports/report-pdf-export.ts` — TR-21's own building blocks, not a
  // second implementation), persist the PDF as a `files` row (mirrored to Shared Drive by the SAME
  // WS11 job every other module's report delivery rides — this ticket writes the `files` row only,
  // per search-reports.controller.ts's own precedent comment), best-effort `deliverables` link when
  // the engagement carries a `project_id`, and emit `social.report.delivered`. The compare-and-swap
  // guard on the UPDATE below is the SAME idempotency idiom search-reports.controller.ts uses:
  // re-delivering an already-delivered report is refused, never silently re-rendered/re-filed.
  @Post("reports/:id/deliver")
  @HttpCode(200)
  async deliverReport(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    assertUuid(id, "id");
    const report = await withTenants([tenantId], (c) => loadReport(c, id), { modules: ["social"] });
    if (!report) throw new NotFoundException("report not found");
    await authorize(req.principal, { kind: "social_report", id, tenantId, module: "social" }, "deliver");
    if (report.status !== "approved") refuse("cannot_deliver_from_this_status");

    const document = buildSocialReportDocument({
      tenantId, engagementId: report.engagementId, clientName: report.clientName, kind: report.kind,
      period: report.period, status: report.status, frozen: report.metrics, narrativeText: report.narrativeMd,
      generatedAt: new Date().toISOString(),
    });

    const { url, token, platformUiInternalUrl, timeoutMs } = config.reportRenderer;
    if (!url || !token || !platformUiInternalUrl) {
      throw new ServiceUnavailableException({ message: "pdf_render_not_configured" });
    }
    let bytes: Buffer;
    try {
      const jobToken = await mintPrintJobToken({ tenantId, grain: "company", scopeRef: report.engagementId, document });
      bytes = await renderPdfViaSidecar(jobToken, { rendererUrl: url, rendererToken: token, platformUiInternalUrl, timeoutMs });
    } catch (err) {
      if (err instanceof PdfRendererNotConfiguredError) throw new ServiceUnavailableException({ message: "pdf_render_not_configured" });
      throw new ServiceUnavailableException({ message: "pdf_render_failed" });
    }

    const fileId = newId();
    const storageKey = `${tenantId}/social-reports/${fileId}`;
    await storage().put(storageKey, bytes);
    const filename = `social-report-${report.period ?? report.kind}-${fileId.slice(0, 8)}.pdf`;

    const result = await withTenants(
      [tenantId],
      async (c) => {
        await c.query(
          `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, scrubbed, origin_site)
           VALUES ($1,$2,$3,'social_report',$4,$5,'application/pdf',$6,$7,false,$8)`,
          [fileId, tenantId, req.principal.userId, id, filename, bytes.byteLength, storageKey, config.originSite],
        );

        // Best-effort deliverable link — `deliverables.project_id` is NOT NULL, so an engagement
        // with no `project_id` (social_engagements.project_id is nullable) legitimately cannot get
        // one. Never block delivery on this (search-reports.controller.ts's identical ruling).
        let deliverableId: string | null = null;
        if (report.projectId) {
          deliverableId = newId();
          await c.query(
            `INSERT INTO deliverables (id, tenant_id, project_id, client_id, name, status, custom_fields, origin_site)
             VALUES ($1,$2,$3,$4,$5,'delivered','{}',$6)`,
            [deliverableId, tenantId, report.projectId, report.clientId, `${report.kind} report — ${report.period ?? ""}`, config.originSite],
          );
        }

        const r = await c.query(
          `UPDATE social_reports SET status = 'delivered', file_id = $2, deliverable_id = $3, delivered_at = now(), updated_at = now()
             WHERE id = $1 AND status = 'approved' AND deleted_at IS NULL`,
          [id, fileId, deliverableId],
        );
        if (r.rowCount === 0) throw new BadRequestException({ message: "status_changed_concurrently" });

        await emitEvent(c, tenantId, "social_report", id, "social.report.delivered", {
          engagementId: report.engagementId, period: report.period, kind: report.kind, fileId, deliverableId,
        });
        return { deliverableId };
      },
      { modules: ["social"] },
    );

    await writeActivity(tenantId, req.principal.userId, "delivered", "social_report", id, {
      fileId, deliverableId: result.deliverableId, filename,
    });
    return { id, status: "delivered", fileId, filename, deliverableId: result.deliverableId };
  }
}
