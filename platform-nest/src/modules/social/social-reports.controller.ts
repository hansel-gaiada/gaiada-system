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
import { sha256Hex } from "../../core/content-hash";
import { emitEvent } from "../../events/outbox.service";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { completeViaGateway } from "./gateway-client";
import { aiAttribution } from "../ai-usage/gateway-usage";
import { queryBrandKnowledge } from "./knowledge-client";
import { buildReportNarrativePrompt, parseReportNarrativeDraft, type ReportNarrativeGroundingFacts } from "./ai-drafts";
import {
  periodDateRange, buildSocialReportSnapshot, buildSocialReportDocument,
  type ReportKind, type FrozenSocialReportMetrics,
} from "./reports";
import { readReportInputs } from "./report-data";
import {
  buildMonthlyReportDraftPrompt, notesComplete, parseMonthlyReportDraft, readStoredActionPlan, readStoredNotes, validateActionPlan, validateNotes,
  type ReportAction, type ReportNotes,
} from "./report-notes";
import { isSocialSimulationEnabled } from "./publisher/simulation";
import { check } from "../../rbac/cerbos";
import { PdfRendererNotConfiguredError, mintPrintJobToken, renderPdfViaSidecar } from "../reports/report-pdf-export";
// SCP-1b / SCP-5a (PERMISSION-CONTRACT §53.7, BFF §63.18): every social_report call site sends `module: "social"` and the
// company's seat approvers (`approverIds`), because `approve` and `deliver` belong to the four social approvers only.
import { loadSocialApproverIds, socialReportResource } from "./pipeline-authz";
// PV7-04a (BFF §55.2): delivery publishes the report to the client, in the same transaction.
import {
  announceClientReportPublished, deliveredReportTitle, discardStoredReportFile, publishDeliveredReport, storeClientReportFile,
  type PublishedClientReport,
} from "../../core/client-reports";

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
/** SCP-5a (BFF §63.0): a 400 that names the bad input. */
function invalidField(field: string): never {
  throw new BadRequestException({ message: "invalid_field", field });
}

const REPORT_KINDS = new Set<ReportKind>(["monthly", "campaign", "adhoc"]);
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const REPORT_STATUSES = new Set(["draft", "in_review", "approved", "delivered"]);

/** SCP-5a (§63.18): the HoD check's notes rule binds the MONTHLY report only; a campaign or ad hoc report has no notes to complete,
 *  so its check passes this rule (and `notesComplete` reads true for it, so the list's flag means "the check may pass"). */
function checkNotesComplete(kind: string, notes: unknown): boolean {
  return kind !== "monthly" || notesComplete(notes);
}

/** The snapshot's numbers, as the ONLY numbers a drafted narrative or insight may state (ai-drafts.ts's numeric guard). The
 *  client's own ad spend (SCP-5a) is among them, in major units of its currency. */
function groundingFactsOf(
  frozen: FrozenSocialReportMetrics, names: { engagementName: string; clientName: string },
  knowledgeHits: Array<{ sourceRef: string; text: string }>,
): ReportNarrativeGroundingFacts {
  const spend = (frozen.adSpend ?? []).flatMap((s) => [
    { label: `Paid boosts (${s.currency})`, value: s.boosts, unit: "count" },
    ...(s.spendMinor === null ? [] : [{ label: `Client's own ad spend (${s.currency})`, value: s.spendMinor / 10 ** s.minorUnit, unit: s.currency }]),
  ]);
  return {
    engagementName: names.engagementName, clientName: names.clientName,
    periodLabel: `${frozen.rangeStart} – ${frozen.rangeEnd}`,
    kpis: [...frozen.kpis.map((k) => ({ label: k.label, value: k.value, unit: k.unit })), ...spend],
    topPosts: (frozen.tables.find((t) => t.key === "top_posts")?.rows ?? []).map((r) => ({
      network: String(r.network ?? ""), publishedAt: r.publishedAt === null ? null : String(r.publishedAt),
      impressions: typeof r.impressions === "number" ? r.impressions : null,
    })),
    knowledgeHits: knowledgeHits.map((h) => ({ sourceRef: h.sourceRef, text: h.text })),
  };
}

interface ReportRow {
  id: string;
  /** M5-G0b: internal sentinel client (WSK-D36); never receives a client report. */
  clientIsInternal: boolean;
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
  /** SCP-5a: the notes and the action plan as stored (read leniently), and the SIMULATED mark. */
  notes: ReportNotes;
  rawNotes: unknown;
  actionPlan: ReportAction[];
  simulated: boolean;
}

/** SCP-1b: the company's Social Media and GM lead-seat holders, read in the company's own scope (pipeline-authz.ts). */
async function approverIdsOf(tenantId: string): Promise<string[]> {
  return withTenants([tenantId], (c) => loadSocialApproverIds(c, tenantId), { modules: ["social"] });
}

async function loadReport(c: PoolClient, id: string): Promise<ReportRow | null> {
  const r = await c.query<{
    id: string; tenant_id: string; engagement_id: string; client_id: string; client_name: string; client_is_internal: boolean;
    engagement_name: string; project_id: string | null; period: string | null; kind: string;
    status: string; metrics: FrozenSocialReportMetrics; narrative_md: string | null; created_at: string;
    notes: unknown; action_plan: unknown; simulated: boolean;
  }>(
    `SELECT sr.id, sr.tenant_id, sr.engagement_id, se.client_id, cl.name AS client_name, cl.is_internal AS client_is_internal,
            se.name AS engagement_name, se.project_id, sr.period, sr.kind, sr.status,
            sr.metrics, sr.narrative_md, sr.created_at, sr.notes, sr.action_plan, sr.simulated
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
    clientName: row.client_name, clientIsInternal: row.client_is_internal, engagementName: row.engagement_name, projectId: row.project_id,
    period: row.period, kind: row.kind as ReportKind, status: row.status,
    metrics: row.metrics ?? { rangeStart: "", rangeEnd: "", kpis: [], series: [], tables: [], highlights: [] },
    narrativeMd: row.narrative_md ?? "", createdAt: row.created_at,
    notes: readStoredNotes(row.notes), rawNotes: row.notes, actionPlan: readStoredActionPlan(row.action_plan), simulated: row.simulated === true,
  };
}

/** The document a report renders (the page and the PDF): the frozen numbers, the narrative, the notes and the action plan as
 *  tables, and the SIMULATED mark. */
function documentOf(tenantId: string, report: ReportRow, frozenStatus = report.status) {
  return buildSocialReportDocument({
    tenantId, engagementId: report.engagementId, clientName: report.clientName, kind: report.kind,
    period: report.period, status: frozenStatus, frozen: report.metrics, narrativeText: report.narrativeMd,
    generatedAt: new Date().toISOString(), notes: report.notes, actionPlan: report.actionPlan, simulated: report.simulated,
  });
}

/** SCP-5a (§63.18): one monthly report per engagement and period. The newest undeleted one, or null. */
async function loadMonthlyFor(c: PoolClient, engagementId: string, period: string): Promise<ReportRow | null> {
  const r = await c.query<{ id: string }>(
    `SELECT id FROM social_reports WHERE engagement_id = $1 AND kind = 'monthly' AND period = $2 AND deleted_at IS NULL
      ORDER BY created_at DESC, id LIMIT 1`,
    [engagementId, period],
  );
  return r.rows[0] ? loadReport(c, r.rows[0].id) : null;
}

function existingAnswer(r: ReportRow) {
  return {
    id: r.id, status: r.status, metrics: r.metrics, narrativeMd: r.narrativeMd, notes: r.notes, actionPlan: r.actionPlan,
    simulated: r.simulated, draftedVia: "existing" as const,
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
    await authorize(req.principal, socialReportResource(tenantId, "", await approverIdsOf(tenantId)), "create");

    const id = body.id ?? newId();

    // Idempotent (agentic criterion 3): a caller-supplied id that already exists returns the
    // EXISTING frozen row untouched — never a re-snapshot, and never a second gateway call spent on
    // a retry (mirrors createEngagement/createPost's own idempotency shape).
    const existing = await withTenants([tenantId], (c) => loadReport(c, id), { modules: ["social"] });
    if (existing && existing.engagementId === engagementId) return existingAnswer(existing);

    const eng = await withTenants(
      [tenantId],
      (c) => c.query<{ client_id: string; client_name: string; name: string; is_internal: boolean }>(
        `SELECT se.client_id, cl.name AS client_name, cl.is_internal, se.name
           FROM social_engagements se JOIN clients cl ON cl.id = se.client_id
          WHERE se.id = $1 AND se.deleted_at IS NULL`,
        [engagementId],
      ),
      { modules: ["social"] },
    );
    const engRow = eng.rows[0];
    if (!engRow) throw new NotFoundException("engagement not found");
    // M5-G0b (WSK-D36): no client-facing report is generated for the internal sentinel client.
    if (engRow.is_internal) refuse("internal_client_no_reports");

    // SCP-5a (§63.18): one monthly report per engagement and month. An existing one for the period is returned as it is
    // (`draftedVia: 'existing'`), before any gateway call is spent; the insert below re-checks under a lock.
    const monthlyPeriod = kind === "monthly" && period !== null ? period : null;
    if (monthlyPeriod) {
      const prior = await withTenants([tenantId], (c) => loadMonthlyFor(c, engagementId, monthlyPeriod), { modules: ["social"] });
      if (prior) return existingAnswer(prior);
    }

    const { start, end } = periodDateRange(period, new Date());

    // SCP-5a: the snapshot counts manual and simulated metric rows and the period's boosts (the client's own ad spend), and
    // simulated rows only while the simulator switch is on, as GET overview counts them (report-data.ts's header).
    const inputs = await withTenants(
      [tenantId],
      (c) => readReportInputs(c, { tenantId, engagementId, clientId: engRow.client_id, start, end, includeSimulated: isSocialSimulationEnabled() }),
      { modules: ["social"] },
    );
    const frozen = buildSocialReportSnapshot({
      rangeStart: start, rangeEnd: end, daily: inputs.daily, posts: inputs.posts, postsPublishedInPeriod: inputs.posts.length,
      kpiTargets: inputs.kpiTargets, boosts: inputs.boosts,
    });

    // ── AI narrative, grounded in THIS client's own brand corpus (SMM-19's path — never a second
    //    route to the gateway). `clientId` comes from the engagement row this handler already
    //    resolved server-side, never from a request body field — the exact property
    //    `social-reports.test.ts`'s cross-client leak test drives end to end. ──────────────────────
    const knowledgeHits = await queryBrandKnowledge(
      req.principal.userId, tenantId, engRow.client_id,
      `${engRow.name} performance report ${period ?? ""}`.trim(), REPORT_KNOWLEDGE_HITS,
    );
    const narrativeFacts = groundingFactsOf(frozen, { engagementName: engRow.name, clientName: engRow.client_name }, knowledgeHits);
    // SCP-5a: a monthly report also drafts its notes and action plan, in the same one gateway call (report-notes.ts).
    const prompt = kind === "monthly" ? buildMonthlyReportDraftPrompt(narrativeFacts) : buildReportNarrativePrompt(narrativeFacts);
    let raw: string | null = null;
    try {
      raw = (await completeViaGateway(prompt, { attribution: aiAttribution(req.principal, tenantId, "other", { task: "social.report_narrative" }) })).text;
    } catch {
      raw = null; // fail-soft: a gateway hiccup drafts the deterministic fallback, never blocks report creation
    }
    let narrativeText: string;
    let draftedVia: "ai" | "fallback";
    let rejectedNumbers: string[] | undefined;
    let notes: ReportNotes = {};
    let actionPlan: ReportAction[] = [];
    if (kind === "monthly") {
      const draft = parseMonthlyReportDraft(raw, narrativeFacts);
      narrativeText = draft.narrativeMd;
      draftedVia = draft.draftedVia === "ai" ? "ai" : "fallback";
      rejectedNumbers = draft.rejected?.numbers;
      notes = draft.notes;
      actionPlan = draft.actionPlan;
    } else {
      const parsed = parseReportNarrativeDraft(raw, narrativeFacts);
      narrativeText = parsed.text;
      draftedVia = parsed.draftedVia;
      rejectedNumbers = parsed.rejectedNumbers;
    }
    // Frozen alongside the numbers (reports.ts's own header on `narrativeSource`) so a later read
    // never claims an AI narrative that a gateway hiccup actually fell back from.
    frozen.narrativeSource = draftedVia === "ai" ? "ai" : "deterministic";

    const raced = await withTenants(
      [tenantId],
      async (c) => {
        if (monthlyPeriod) {
          // Two creates for the same month at once: the second waits here, then finds the first and returns it.
          await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`social_report:${engagementId}:monthly:${monthlyPeriod}`]);
          const prior = await loadMonthlyFor(c, engagementId, monthlyPeriod);
          if (prior) return prior;
        }
        await c.query(
          `INSERT INTO social_reports (id, tenant_id, engagement_id, period, kind, status, metrics, narrative_md, notes, action_plan, simulated, origin_site)
           VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
          [id, tenantId, engagementId, period, kind, JSON.stringify(frozen), narrativeText, JSON.stringify(notes), JSON.stringify(actionPlan),
            inputs.simulated, config.originSite],
        );
        return null;
      },
      { modules: ["social"] },
    );
    if (raced) return existingAnswer(raced);
    await writeActivity(tenantId, req.principal.userId, "created", "social_report", id, {
      engagementId, kind, period, draftedVia, groundedOn: knowledgeHits.map((h) => h.sourceRef), simulated: inputs.simulated,
      // Recorded so a REJECTED narrative is distinguishable from a gateway hiccup: both land as
      // draftedVia:'fallback', but only one means the model stated a number nothing grounded.
      // Absent (not `[]`) when nothing was rejected — an empty array would read as "checked and
      // clean" on the AI path and "checked and clean" on the fallback path alike, which is exactly
      // the absent-vs-zero conflation this module refuses.
      ...(rejectedNumbers && rejectedNumbers.length > 0 ? { narrativeRejectedNumbers: rejectedNumbers } : {}),
    });
    return {
      id, status: "draft", metrics: frozen, narrativeMd: narrativeText, notes, actionPlan, simulated: inputs.simulated, draftedVia,
      groundedOn: knowledgeHits.map((h) => h.sourceRef),
    };
  }

  // ==================================================================== LIST / DETAIL ============
  // SCP-5a (§63.18): each row gains `notesComplete` (the HoD check's notes rule would pass) and `simulated`; `period` filters.
  @Get("reports")
  async listReports(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("engagementId") engagementId?: string, @Query("status") status?: string, @Query("period") period?: string,
  ) {
    await authorize(req.principal, socialReportResource(tenantId, "", await approverIdsOf(tenantId)), "read");
    if (engagementId !== undefined && (typeof engagementId !== "string" || !UUID_RE.test(engagementId))) invalidField("engagementId");
    if (status !== undefined && (typeof status !== "string" || !REPORT_STATUSES.has(status))) invalidField("status");
    if (period !== undefined && (typeof period !== "string" || !PERIOD_RE.test(period))) invalidField("period");
    const params: unknown[] = [];
    const where: string[] = ["sr.deleted_at IS NULL"];
    if (engagementId) { params.push(engagementId); where.push(`sr.engagement_id = $${params.length}`); }
    if (status) { params.push(status); where.push(`sr.status = $${params.length}`); }
    if (period) { params.push(period); where.push(`sr.period = $${params.length}`); }
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query<{
        id: string; engagementId: string; clientName: string; period: string | null; kind: string; status: string;
        createdAt: string; approvedAt: string | null; deliveredAt: string | null; notes: unknown; simulated: boolean;
      }>(
        `SELECT sr.id, sr.engagement_id AS "engagementId", cl.name AS "clientName", sr.period, sr.kind,
                sr.status, sr.created_at AS "createdAt", sr.approved_at AS "approvedAt", sr.delivered_at AS "deliveredAt",
                sr.notes, sr.simulated
           FROM social_reports sr
           JOIN social_engagements se ON se.id = sr.engagement_id AND se.tenant_id = sr.tenant_id
           JOIN clients cl ON cl.id = se.client_id
          WHERE ${where.join(" AND ")}
          ORDER BY sr.created_at DESC LIMIT 500`,
        params,
      ),
      { modules: ["social"] },
    );
    return {
      reports: rows.map(({ notes, ...r }) => ({ ...r, notesComplete: checkNotesComplete(r.kind, notes), simulated: r.simulated === true })),
    };
  }

  @Get("reports/:id")
  async getReport(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    assertUuid(id, "id");
    const report = await withTenants([tenantId], (c) => loadReport(c, id), { modules: ["social"] });
    if (!report) throw new NotFoundException("report not found");
    const resource = socialReportResource(tenantId, id, await approverIdsOf(tenantId));
    await authorize(req.principal, resource, "read");
    // SCP-5a (§63.18): what the caller may do here, asked as plain checks (never a throw): the page shows the HoD check's and
    // the send's buttons only to the four.
    const [canApprove, canDeliver] = await Promise.all([
      check(req.principal, resource, "approve").then((d) => d.allow),
      check(req.principal, resource, "deliver").then((d) => d.allow),
    ]);
    return {
      id: report.id, status: report.status, engagementId: report.engagementId, kind: report.kind, period: report.period,
      notes: report.notes, actionPlan: report.actionPlan, simulated: report.simulated,
      notesComplete: checkNotesComplete(report.kind, report.rawNotes), canApprove, canDeliver,
      document: documentOf(tenantId, report),
    };
  }

  // ==================================================================== EDIT / SUBMIT / SEND BACK
  @Patch("reports/:id")
  @HttpCode(200)
  async updateReport(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { narrativeMd?: string; notes?: unknown; actionPlan?: unknown; status?: string } = {},
  ) {
    assertUuid(id, "id");
    const report = await withTenants([tenantId], (c) => loadReport(c, id), { modules: ["social"] });
    if (!report) throw new NotFoundException("report not found");
    // SCP-5a (§53.7, BFF §63.18): sending a report BACK from the HoD check (in_review -> draft) is the other answer of that
    // check, so it authorizes as `approve` (the four social approvers), not `update`. An edit in the same call (the narrative,
    // the notes or the action plan) also needs `update`. Decided from the requested move before any validation, so a refused
    // caller gets 403, never 400.
    const reportResource = socialReportResource(tenantId, id, await approverIdsOf(tenantId));
    const sendingBack = body.status === "draft";
    const editing = body.narrativeMd !== undefined || body.notes !== undefined || body.actionPlan !== undefined;
    if (sendingBack) {
      await authorize(req.principal, reportResource, "approve");
      if (editing) await authorize(req.principal, reportResource, "update");
    } else {
      await authorize(req.principal, reportResource, "update");
    }

    // SCP-5a: the shapes of 63.1 file 9 (400 {field}).
    if (body.narrativeMd !== undefined && typeof body.narrativeMd !== "string") invalidField("narrativeMd");
    let notes: ReportNotes | undefined;
    if (body.notes !== undefined) {
      const v = validateNotes(body.notes);
      if (!v.ok) invalidField("notes");
      notes = v.value;
    }
    let actionPlan: ReportAction[] | undefined;
    if (body.actionPlan !== undefined) {
      const v = validateActionPlan(body.actionPlan);
      if (!v.ok) invalidField("actionPlan");
      actionPlan = v.value;
    }

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
        if (notes !== undefined) { params.push(JSON.stringify(notes)); sets.push(`notes = $${params.length}::jsonb`); }
        if (actionPlan !== undefined) { params.push(JSON.stringify(actionPlan)); sets.push(`action_plan = $${params.length}::jsonb`); }
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
    await writeActivity(tenantId, req.principal.userId, "updated", "social_report", id, {
      status: targetStatus, narrativeMdEdited: narrativeMd !== undefined, notesEdited: notes !== undefined, actionPlanEdited: actionPlan !== undefined,
    });
    return { id, status: targetStatus };
  }

  // ==================================================================== DRAFT WITH AI (SCP-5a) ====
  // A PROPOSAL, never a write (§63.18): the narrative, the three notes and the action plan drafted from the report's FROZEN
  // snapshot and the client's own brand corpus (`queryBrandKnowledge`, DW-D31). Nothing is saved: the page shows it and the
  // officer saves what they keep with a PATCH. The gateway down, or an answer that fails any check, gives the plain template
  // (`draftedVia: 'template'`). Only while the report can still be edited (400 `report_not_editable`).
  @Post("reports/:id/ai-draft")
  @HttpCode(200)
  async aiDraftReport(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    assertUuid(id, "id");
    const report = await withTenants([tenantId], (c) => loadReport(c, id), { modules: ["social"] });
    if (!report) throw new NotFoundException("report not found");
    await authorize(req.principal, socialReportResource(tenantId, id, await approverIdsOf(tenantId)), "update");
    if (report.status !== "draft" && report.status !== "in_review") refuse("report_not_editable");

    const knowledgeHits = await queryBrandKnowledge(
      req.principal.userId, tenantId, report.clientId,
      `${report.engagementName} performance report ${report.period ?? ""}`.trim(), REPORT_KNOWLEDGE_HITS,
    );
    const facts = groundingFactsOf(report.metrics, { engagementName: report.engagementName, clientName: report.clientName }, knowledgeHits);
    let raw: string | null = null;
    try {
      raw = (await completeViaGateway(buildMonthlyReportDraftPrompt(facts), {
        attribution: aiAttribution(req.principal, tenantId, "other", { task: "social.report_narrative" }),
      })).text;
    } catch {
      raw = null; // the gateway down: the template, never a failed request
    }
    const draft = parseMonthlyReportDraft(raw, facts);
    return { narrativeMd: draft.narrativeMd, notes: draft.notes, actionPlan: draft.actionPlan, draftedVia: draft.draftedVia };
  }

  // ==================================================================== APPROVE ===================
  // Base design §07: "Low-impact artifacts (reports, campaign plans) approve in-console via module
  // permissions" — this IS that approval. See the file header for why neither the D14 registry nor
  // SMM-31's client-review stage fits. SCP-5a (§63.18): the HoD check, the four social approvers only; a monthly report needs
  // an insight and a suggestion in every area (400 `notes_incomplete`). No maker/checker rule (SCP-Q22): one of the four may
  // approve a report they wrote.
  @Post("reports/:id/approve")
  @HttpCode(200)
  async approveReport(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    assertUuid(id, "id");
    const report = await withTenants([tenantId], (c) => loadReport(c, id), { modules: ["social"] });
    if (!report) throw new NotFoundException("report not found");
    await authorize(req.principal, socialReportResource(tenantId, id, await approverIdsOf(tenantId)), "approve");
    if (report.status !== "in_review") refuse("cannot_approve_from_this_status");
    if (!checkNotesComplete(report.kind, report.rawNotes)) refuse("notes_incomplete");
    // The notes rule is re-checked in the UPDATE itself, so an edit that blanks a note between the read above and this write
    // cannot slip through: the row is then left alone and the refusal re-read.
    const r = await withTenants(
      [tenantId],
      (c) => c.query(
        `UPDATE social_reports SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now()
           WHERE id = $1 AND status = 'in_review' AND deleted_at IS NULL
             AND (kind <> 'monthly' OR NOT EXISTS (
                   SELECT 1 FROM unnest(ARRAY['followers', 'engagement', 'audience']) AS a(area)
                    WHERE coalesce(notes -> a.area ->> 'insight', '') !~ '\\S' OR coalesce(notes -> a.area ->> 'suggestion', '') !~ '\\S'))`,
        [id, req.principal.userId],
      ),
      { modules: ["social"] },
    );
    if (r.rowCount === 0) {
      const now = await withTenants([tenantId], (c) => loadReport(c, id), { modules: ["social"] });
      if (!now || now.status !== "in_review") refuse("cannot_approve_from_this_status");
      refuse("notes_incomplete");
    }
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
    await authorize(req.principal, socialReportResource(tenantId, id, await approverIdsOf(tenantId)), "deliver");
    if (report.clientIsInternal) refuse("internal_client_not_deliverable");
    if (report.status !== "approved") refuse("cannot_deliver_from_this_status");

    // SCP-5a: the PDF carries the notes and the action plan (as tables) and the SIMULATED mark (`document.simulated`).
    const document = documentOf(tenantId, report);

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
    // PV7-04a: the client report's own copy of the same bytes, under its own key (core/client-reports.ts header).
    const clientCopy = req.principal.userId ? await storeClientReportFile(tenantId, bytes, filename, "application/pdf") : null;

    const result = await withTenants(
      [tenantId],
      async (c) => {
        await c.query(
          `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, sha256, scrubbed, origin_site)
           VALUES ($1,$2,$3,'social_report',$4,$5,'application/pdf',$6,$7,$8,false,$9)`,
          [fileId, tenantId, req.principal.userId, id, filename, bytes.byteLength, storageKey, sha256Hex(bytes), config.originSite],
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

        // PV7-04a (BFF §55.2): publish it to the client in THIS transaction. An engagement with no project gives a client-wide
        // report (project NULL). Idempotent per source (one client report per social report, ever).
        let clientReport: PublishedClientReport | null = null;
        if (clientCopy && req.principal.userId) {
          const { start, end } = periodDateRange(report.period, new Date(report.createdAt));
          clientReport = await publishDeliveredReport(c, {
            tenantId, source: "social_report", sourceId: id, clientId: report.clientId, projectId: report.projectId,
            deliverableId, title: deliveredReportTitle("social_report", report.kind, report.period, start, end),
            periodStart: start, periodEnd: end, file: clientCopy, publishedBy: req.principal.userId, announce: true,
          });
        }
        return { deliverableId, clientReport };
      },
      { modules: ["social"] },
    ).catch(async (err: unknown) => {
      // Nothing committed, so the client report's copy is referenced by no row: remove it, then fail as before.
      if (clientCopy) await discardStoredReportFile(clientCopy);
      throw err;
    });

    if (clientCopy && result.clientReport && !result.clientReport.created) await discardStoredReportFile(clientCopy);
    if (result.clientReport?.created) await announceClientReportPublished(tenantId, req.principal.userId, result.clientReport);
    await writeActivity(tenantId, req.principal.userId, "delivered", "social_report", id, {
      fileId, deliverableId: result.deliverableId, filename, clientReportId: result.clientReport?.id ?? null,
    });
    return { id, status: "delivered", fileId, filename, deliverableId: result.deliverableId, clientReportId: result.clientReport?.id ?? null };
  }
}
