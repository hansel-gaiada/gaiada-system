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
import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, ServiceUnavailableException, UseGuards } from "@nestjs/common";
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
import { buildReportNarrativePrompt, findUngroundedNumbers, parseReportNarrativeDraft, type ReportNarrativeGroundingFacts } from "./ai-drafts";
import {
  periodDateRange, buildSocialReportSnapshot, buildSocialReportDocument, withShortKindFacts,
  type ReportKind, type FrozenSocialReportMetrics,
} from "./reports";
import { readReportInputs, readShortKindExtras } from "./report-data";
import {
  buildMonthlyReportDraftPrompt, parseMonthlyReportDraft, readStoredActionPlan, readStoredNotes,
  type ReportAction, type ReportNotes,
} from "./report-notes";
import {
  PERIOD_SHAPE_RE, REPORT_KINDS, buildShortReportDraftPrompt, contentOf, draftShapeOf, dueOf, isLiveWhile, isPeriodicKind, isReportKind, isShortKind,
  nextRangeOf, noteKeysOf, notesCheckPasses, parseShortReportDraft, resolvePeriod, shortKindGrounding, unmetCheck, validateEdit,
  type ReportContent, type ShortDraftContext,
} from "./report-kinds";
import { isSocialSimulationEnabled } from "./publisher/simulation";
import { todayIsoInTz } from "../reports/person-scope";
import { loadWorkingCalendar } from "../reports/dept-kpi-readers/functional/working-calendar";
import { addDays } from "../hr/working-days";
import { check } from "../../rbac/cerbos";
import { PdfRendererNotConfiguredError, mintPrintJobToken, renderPdfViaSidecar } from "../reports/report-pdf-export";
// SCP-1b / SCP-5a (PERMISSION-CONTRACT §53.7, BFF §63.18): every social_report call site sends `module: "social"` and the
// company's seat approvers (`approverIds`), because `approve` and `deliver` belong to the four social approvers only.
import { loadSocialApproverIds, socialReportResource } from "./pipeline-authz";
import { reportKindRules, rulesByRef, rulesRefFor, socialRules, type ReportKindRules } from "./pipeline/rules";
import { periodRange } from "./pipeline/rules-periods";
import { closeReportStepsOnDelivery } from "./pipeline/cycle-steps";
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

const REPORT_STATUSES = new Set(["draft", "in_review", "approved", "delivered"]);
const SOCIAL = { modules: ["social"] };

/** SCP-5 W5-A2: Postgres' unique violation, the one-per-period index's backstop when two creates race past the advisory lock. */
const isUniqueViolation = (e: unknown): boolean => (e as { code?: string } | null)?.code === "23505";

/** The snapshot's numbers, as the ONLY numbers a drafted narrative or insight may state (ai-drafts.ts's numeric guard). The
 *  client's own ad spend (SCP-5a) is among them, in major units of its currency; so are a short report's own facts (W5-A2). */
function groundingFactsOf(
  frozen: FrozenSocialReportMetrics, names: { engagementName: string; clientName: string },
  knowledgeHits: Array<{ sourceRef: string; text: string }>,
): ReportNarrativeGroundingFacts {
  const spend = (frozen.adSpend ?? []).flatMap((s) => [
    { label: `Paid boosts (${s.currency})`, value: s.boosts, unit: "count" },
    ...(s.spendMinor === null ? [] : [{ label: `Client's own ad spend (${s.currency})`, value: s.spendMinor / 10 ** s.minorUnit, unit: s.currency }]),
  ]);
  const short = shortKindGrounding(frozen);
  return {
    engagementName: names.engagementName, clientName: names.clientName,
    periodLabel: `${frozen.rangeStart} – ${frozen.rangeEnd}`,
    kpis: [...frozen.kpis.map((k) => ({ label: k.label, value: k.value, unit: k.unit })), ...spend, ...(short?.kpis ?? [])],
    topPosts: (frozen.tables.find((t) => t.key === "top_posts")?.rows ?? []).map((r) => ({
      network: String(r.network ?? ""), publishedAt: r.publishedAt === null ? null : String(r.publishedAt),
      impressions: typeof r.impressions === "number" ? r.impressions : null,
    })),
    knowledgeHits: knowledgeHits.map((h) => ({ sourceRef: h.sourceRef, text: h.text })),
    ...(short ? { extraGrounding: short.extra } : {}),
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
  /** SCP-5 W5-A2: a short kind's next-period line, the company's rules the report was made under, and the client's due day. */
  nextPeriod: string | null;
  rulesRef: string;
  reportDueDay: number | null;
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
    notes: unknown; action_plan: unknown; simulated: boolean; next_period: string | null; rules_ref: string; report_due_day: number | null;
  }>(
    `SELECT sr.id, sr.tenant_id, sr.engagement_id, se.client_id, cl.name AS client_name, cl.is_internal AS client_is_internal,
            se.name AS engagement_name, se.project_id, sr.period, sr.kind, sr.status,
            sr.metrics, sr.narrative_md, sr.created_at, sr.notes, sr.action_plan, sr.simulated,
            sr.next_period, sr.rules_ref, se.report_due_day
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
    nextPeriod: row.next_period, rulesRef: row.rules_ref, reportDueDay: row.report_due_day === null ? null : Number(row.report_due_day),
  };
}

/** SCP-5 W5-A2 (BFF §63.30): the rules a report was MADE under, for its whole life: its kind's block of the document its `rules_ref`
 *  names, as the content rules the routes below decide by. A campaign or ad hoc report has no kind block (SMM-23's own). */
interface ReportRules { kindRules: ReportKindRules | null; content: ReportContent; fiscalYearStartMonth: number }

async function rulesOfReport(c: PoolClient, tenantId: string, r: Pick<ReportRow, "kind" | "rulesRef">): Promise<ReportRules> {
  const company = await rulesByRef(c, tenantId, r.rulesRef);
  const kindRules = isPeriodicKind(r.kind) ? reportKindRules(company.rules, r.kind) : null;
  return { kindRules, content: contentOf(r.kind, kindRules), fiscalYearStartMonth: company.rules.reports.fiscalYearStartMonth };
}

/** A report and the rules it was made under, in one read; null when there is no such report. */
async function loadReportWithRules(tenantId: string, id: string): Promise<{ report: ReportRow; rules: ReportRules } | null> {
  return withTenants([tenantId], async (c) => {
    const report = await loadReport(c, id);
    return report ? { report, rules: await rulesOfReport(c, tenantId, report) } : null;
  }, SOCIAL);
}

/** The range of a periodic report's period under its own rules (null for campaign, ad hoc, or a legacy period no kind reads). */
function rangeOfReport(r: Pick<ReportRow, "kind" | "period">, rules: ReportRules): { start: string; end: string } | null {
  return isPeriodicKind(r.kind) && r.period ? periodRange(r.kind, r.period, rules.fiscalYearStartMonth) : null;
}

/**
 * The numbers of `range` for a report of `kind`: SCP-5a's snapshot (manual and simulated metric rows and the period's boosts, simulated
 * rows only while the simulator switch is on, as GET overview counts them) and, for a daily or weekly report, its own facts on top
 * (W5-A2: the posts the client approved, the best post by reach, what the pipeline has dated in the next day or week). One function for
 * create, a draft's live read and the submit that freezes them, so the three can never disagree.
 */
async function snapshotOf(
  c: PoolClient, a: { tenantId: string; engagementId: string; clientId: string; kind: ReportKind; range: { start: string; end: string } },
): Promise<{ frozen: FrozenSocialReportMetrics; simulated: boolean }> {
  const includeSimulated = isSocialSimulationEnabled();
  const inputs = await readReportInputs(c, {
    tenantId: a.tenantId, engagementId: a.engagementId, clientId: a.clientId, start: a.range.start, end: a.range.end, includeSimulated,
  });
  let frozen = buildSocialReportSnapshot({
    rangeStart: a.range.start, rangeEnd: a.range.end, daily: inputs.daily, posts: inputs.posts, postsPublishedInPeriod: inputs.posts.length,
    kpiTargets: inputs.kpiTargets, boosts: inputs.boosts,
  });
  let simulated = inputs.simulated;
  const next = nextRangeOf(a.kind, a.range);
  if (next) {
    const x = await readShortKindExtras(c, {
      tenantId: a.tenantId, engagementId: a.engagementId, start: a.range.start, end: a.range.end,
      nextStart: next.range.start, nextEnd: next.range.end, tz: config.reportsTz, includeSimulated,
    });
    frozen = withShortKindFacts(frozen, { approvedPosts: x.approvedPosts, bestPost: x.bestPost, nextPosts: x.nextPosts, nextLabel: next.label });
    simulated = includeSimulated && (simulated || x.simulated);
  }
  return { frozen, simulated };
}

/** A draft whose numbers are live (its rules freeze them at submit): the numbers of its period as they stand now, with the narrative's
 *  provenance it was drafted with; every other report reads its own frozen numbers. */
async function currentNumbers(
  tenantId: string, report: ReportRow, rules: ReportRules,
): Promise<{ metrics: FrozenSocialReportMetrics; simulated: boolean; live: boolean }> {
  const range = rangeOfReport(report, rules);
  if (!isLiveWhile(rules.content, report.status) || !range) return { metrics: report.metrics, simulated: report.simulated, live: false };
  const snap = await withTenants([tenantId], (c) => snapshotOf(c, {
    tenantId, engagementId: report.engagementId, clientId: report.clientId, kind: report.kind, range,
  }), SOCIAL);
  const keep = { ...(report.metrics.narrativeSource ? { narrativeSource: report.metrics.narrativeSource } : {}), ...(report.metrics.narrativeModel ? { narrativeModel: report.metrics.narrativeModel } : {}) };
  return { metrics: { ...snap.frozen, ...keep }, simulated: snap.simulated, live: true };
}

/** The days reports are due (BFF §63.24.1), by each report's own rules: the company's calendar is read once, and only when a rule needs working days. */
async function dueDaysOf(
  tenantId: string, items: Array<{ kind: ReportKind; period: string | null; rules: ReportRules; reportDueDay: number | null }>,
): Promise<Array<string | null>> {
  const needs = items.flatMap((i) => {
    const range = rangeOfReport(i, i.rules);
    return range && i.rules.content.due?.rule === "working_days_after" ? [range.end] : [];
  }).sort();
  const calendar = needs.length > 0 ? await loadWorkingCalendar(tenantId, needs[0], addDays(needs[needs.length - 1], 90)) : {};
  return items.map((i) => dueOf(i.kind, i.period, { fiscalYearStartMonth: i.rules.fiscalYearStartMonth, due: i.rules.content.due }, { reportDueDay: i.reportDueDay, calendar }));
}

/** The document a report renders (the page and the PDF): the numbers, the narrative, the notes and the action plan as
 *  tables, a short report's next-period line, and the SIMULATED mark. */
function documentOf(
  tenantId: string, report: ReportRow, o: { frozenStatus?: string; metrics?: FrozenSocialReportMetrics; simulated?: boolean } = {},
) {
  return buildSocialReportDocument({
    tenantId, engagementId: report.engagementId, clientName: report.clientName, kind: report.kind,
    period: report.period, status: o.frozenStatus ?? report.status, frozen: o.metrics ?? report.metrics, narrativeText: report.narrativeMd,
    generatedAt: new Date().toISOString(), notes: report.notes, actionPlan: report.actionPlan, simulated: o.simulated ?? report.simulated,
    nextPeriod: report.nextPeriod,
  });
}

/** SCP-5a / W5-A2 (§63.18, §63.24.3): one report per engagement, kind and period. The newest undeleted one, or null. */
async function loadExistingFor(c: PoolClient, engagementId: string, kind: ReportKind, period: string): Promise<ReportRow | null> {
  const r = await c.query<{ id: string }>(
    `SELECT id FROM social_reports WHERE engagement_id = $1 AND kind = $2 AND period = $3 AND deleted_at IS NULL
      ORDER BY created_at DESC, id LIMIT 1`,
    [engagementId, kind, period],
  );
  return r.rows[0] ? loadReport(c, r.rows[0].id) : null;
}

function existingAnswer(r: ReportRow) {
  return {
    id: r.id, status: r.status, metrics: r.metrics, narrativeMd: r.narrativeMd, notes: r.notes, actionPlan: r.actionPlan,
    nextPeriod: r.nextPeriod, simulated: r.simulated, draftedVia: "existing" as const,
  };
}

/** What a short report's draft is told about the next day or week: from its snapshot. */
function shortDraftContext(report: Pick<ReportRow, "kind">, frozen: FrozenSocialReportMetrics, content: ReportContent): ShortDraftContext {
  const short = frozen.shortKind;
  const next = frozen.tables.find((t) => t.key === "next_period")?.rows ?? [];
  const label: "day" | "week" = short?.nextLabel ?? (report.kind === "daily" ? "day" : "week");
  return {
    kind: report.kind === "daily" ? "daily" : "weekly", narrativeMax: content.narrativeMax, nextPeriodLine: content.nextPeriodLine,
    extraLines: shortKindGrounding(frozen)?.lines ?? [], nextLabel: label, nextPosts: short?.nextPosts ?? 0, nextTitles: next.map((r) => String(r.title ?? "")),
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
  //
  // SCP-5 W5-A2 (BFF §63.24.3): every periodic kind the company has on. The period of a new kind must be in its format, a real
  // date or week and not in the future (400 `invalid_field` `{field: 'period'}`), and ended when the kind's numbers freeze at create
  // (400 `period_not_over`); the monthly keeps SCP-5a's create (any period, or none). A kind the company turned off is 409
  // `report_kind_off`. One report per client, kind and period, under the advisory lock `social_report:<engagementId>:<kind>:<period>`
  // with the unique index (migration 202610301300) as the new kinds' backstop. The report keeps the company's rules it was made under.
  @Post("engagements/:engagementId/reports")
  @HttpCode(201)
  async createReport(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("engagementId") engagementId: string,
    @Body() body: { id?: string; kind?: string; period?: string } = {},
  ) {
    assertUuid(engagementId, "engagement_id");
    if (body.id) assertUuid(body.id, "id");
    const kind = (body.kind ?? "monthly") as ReportKind;
    if (!isReportKind(kind)) refuse("invalid_kind");
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

    // The company's rules decide which kinds are on and how this one is made (BFF §63.30). Campaign and ad hoc are SMM-23's own.
    const company = isPeriodicKind(kind) ? await withTenants([tenantId], (c) => socialRules(c, tenantId), SOCIAL) : null;
    const kindRules = company && isPeriodicKind(kind) ? reportKindRules(company.rules, kind) : null;
    const content = contentOf(kind, kindRules);
    const fiscal = company?.rules.reports.fiscalYearStartMonth ?? 1;
    let newKindRange: { start: string; end: string } | null = null;
    if (company && isPeriodicKind(kind) && kind !== "monthly") {
      const r = resolvePeriod(kind, period, fiscal, todayIsoInTz(config.reportsTz), content.freezeAt === "create");
      if (!r.ok) return r.code === "period_not_over" ? refuse("period_not_over") : invalidField("period");
      newKindRange = r.range;
    }
    if (kindRules && !kindRules.enabled) throw new ConflictException({ message: "report_kind_off" });

    // SCP-5a (§63.18): one monthly report per engagement and month; W5-A2: and one per client, kind and period for the others. An
    // existing one for the period is returned as it is (`draftedVia: 'existing'`), before any gateway call is spent; the insert
    // below re-checks under a lock. A monthly create with no `period` keeps SMM-23's behaviour (no period, no deduplication).
    const dedupePeriod = period !== null && (kind === "monthly" || newKindRange !== null) ? period : null;
    if (dedupePeriod) {
      const prior = await withTenants([tenantId], (c) => loadExistingFor(c, engagementId, kind, dedupePeriod), { modules: ["social"] });
      if (prior) return existingAnswer(prior);
    }

    const { start, end } = newKindRange ?? periodDateRange(period, new Date());

    // SCP-5a: the snapshot counts manual and simulated metric rows and the period's boosts (the client's own ad spend), and
    // simulated rows only while the simulator switch is on, as GET overview counts them (report-data.ts's header).
    const snap = await withTenants(
      [tenantId],
      (c) => snapshotOf(c, { tenantId, engagementId, clientId: engRow.client_id, kind, range: { start, end } }),
      { modules: ["social"] },
    );
    const frozen = snap.frozen;

    // ── AI narrative, grounded in THIS client's own brand corpus (SMM-19's path — never a second
    //    route to the gateway). `clientId` comes from the engagement row this handler already
    //    resolved server-side, never from a request body field — the exact property
    //    `social-reports.test.ts`'s cross-client leak test drives end to end. A kind whose AI drafting the company turned off
    //    writes an empty draft with no gateway call (`draftedVia: 'none'`). ───────────────────────────────────────────────────
    let knowledgeHits: Array<{ sourceRef: string; text: string }> = [];
    let narrativeText = "";
    let draftedVia: "ai" | "fallback" | "none" = "none";
    let rejectedNumbers: string[] | undefined;
    let notes: ReportNotes = {};
    let actionPlan: ReportAction[] = [];
    let nextPeriod: string | null = null;
    if (!kindRules || kindRules.aiDrafting) {
      knowledgeHits = await queryBrandKnowledge(
        req.principal.userId, tenantId, engRow.client_id,
        `${engRow.name} performance report ${period ?? ""}`.trim(), REPORT_KNOWLEDGE_HITS,
      );
      const narrativeFacts = groundingFactsOf(frozen, { engagementName: engRow.name, clientName: engRow.client_name }, knowledgeHits);
      // SCP-5a: a long kind also drafts its notes and action plan, in the same one gateway call (report-notes.ts); W5-A2: a daily
      // or weekly report drafts its summary and its next-period line (report-kinds.ts).
      const shortCtx = isShortKind(kind) ? shortDraftContext({ kind }, frozen, content) : null;
      const prompt = shortCtx ? buildShortReportDraftPrompt(narrativeFacts, shortCtx)
        : isPeriodicKind(kind) ? buildMonthlyReportDraftPrompt(narrativeFacts, draftShapeOf(content))
        : buildReportNarrativePrompt(narrativeFacts);
      let raw: string | null = null;
      try {
        raw = (await completeViaGateway(prompt, { attribution: aiAttribution(req.principal, tenantId, "other", { task: "social.report_narrative" }) })).text;
      } catch {
        raw = null; // fail-soft: a gateway hiccup drafts the deterministic fallback, never blocks report creation
      }
      if (shortCtx) {
        const draft = parseShortReportDraft(raw, narrativeFacts, shortCtx);
        narrativeText = draft.narrativeMd;
        nextPeriod = draft.nextPeriod;
        draftedVia = draft.draftedVia === "ai" ? "ai" : "fallback";
        rejectedNumbers = draft.rejected?.numbers;
      } else if (isPeriodicKind(kind)) {
        const draft = parseMonthlyReportDraft(raw, narrativeFacts, draftShapeOf(content));
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
    }
    // Frozen alongside the numbers (reports.ts's own header on `narrativeSource`) so a later read
    // never claims an AI narrative that a gateway hiccup actually fell back from.
    frozen.narrativeSource = draftedVia === "ai" ? "ai" : "deterministic";

    const attempt = () => withTenants(
      [tenantId],
      async (c) => {
        if (dedupePeriod) {
          // Two creates for the same client, kind and period at once: the second waits here, then finds the first and returns it.
          await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`social_report:${engagementId}:${kind}:${dedupePeriod}`]);
          const prior = await loadExistingFor(c, engagementId, kind, dedupePeriod);
          if (prior) return prior;
        }
        // SCP-5 W5-A0 (BFF §63.30.3): the report keeps the company's rules it was made under for its whole life.
        const rulesRef = rulesRefFor(company ?? (await socialRules(c, tenantId)));
        await c.query(
          `INSERT INTO social_reports (id, tenant_id, engagement_id, period, kind, status, metrics, narrative_md, notes, action_plan, simulated, origin_site, rules_ref, next_period)
           VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (id) DO NOTHING`,
          [id, tenantId, engagementId, period, kind, JSON.stringify(frozen), narrativeText, JSON.stringify(notes), JSON.stringify(actionPlan),
            snap.simulated, config.originSite, rulesRef, nextPeriod],
        );
        return null;
      },
      { modules: ["social"] },
    );
    let raced: ReportRow | null;
    try {
      raced = await attempt();
    } catch (e) {
      // The unique index's backstop (a path that took no lock): the report that won is the answer.
      if (!dedupePeriod || !isUniqueViolation(e)) throw e;
      raced = await withTenants([tenantId], (c) => loadExistingFor(c, engagementId, kind, dedupePeriod), { modules: ["social"] });
      if (!raced) throw e;
    }
    if (raced) return existingAnswer(raced);
    await writeActivity(tenantId, req.principal.userId, "created", "social_report", id, {
      engagementId, kind, period, draftedVia, groundedOn: knowledgeHits.map((h) => h.sourceRef), simulated: snap.simulated,
      ...(company ? { rulesRef: rulesRefFor(company) } : {}),
      // Recorded so a REJECTED narrative is distinguishable from a gateway hiccup: both land as
      // draftedVia:'fallback', but only one means the model stated a number nothing grounded.
      // Absent (not `[]`) when nothing was rejected — an empty array would read as "checked and
      // clean" on the AI path and "checked and clean" on the fallback path alike, which is exactly
      // the absent-vs-zero conflation this module refuses.
      ...(rejectedNumbers && rejectedNumbers.length > 0 ? { narrativeRejectedNumbers: rejectedNumbers } : {}),
    });
    return {
      id, status: "draft", metrics: frozen, narrativeMd: narrativeText, notes, actionPlan, nextPeriod, simulated: snap.simulated, draftedVia,
      groundedOn: knowledgeHits.map((h) => h.sourceRef),
    };
  }

  // ==================================================================== LIST / DETAIL ============
  // SCP-5a (§63.18): each row gains `notesComplete` (the HoD check's notes rule would pass) and `simulated`; `period` filters.
  // W5-A2 (§63.24.3): `kind` filters, `period` takes every form, and each row gains `due` (the day it falls due, by its own rules),
  // `summaryPresent` and `live` (a draft whose numbers are still moving).
  @Get("reports")
  async listReports(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("engagementId") engagementId?: string, @Query("status") status?: string, @Query("period") period?: string, @Query("kind") kind?: string,
  ) {
    await authorize(req.principal, socialReportResource(tenantId, "", await approverIdsOf(tenantId)), "read");
    if (kind !== undefined && (typeof kind !== "string" || !(REPORT_KINDS as readonly string[]).includes(kind))) invalidField("kind");
    if (engagementId !== undefined && (typeof engagementId !== "string" || !UUID_RE.test(engagementId))) invalidField("engagementId");
    if (status !== undefined && (typeof status !== "string" || !REPORT_STATUSES.has(status))) invalidField("status");
    if (period !== undefined && (typeof period !== "string" || !PERIOD_SHAPE_RE.test(period))) invalidField("period");
    const params: unknown[] = [];
    const where: string[] = ["sr.deleted_at IS NULL"];
    if (kind) { params.push(kind); where.push(`sr.kind = $${params.length}`); }
    if (engagementId) { params.push(engagementId); where.push(`sr.engagement_id = $${params.length}`); }
    if (status) { params.push(status); where.push(`sr.status = $${params.length}`); }
    if (period) { params.push(period); where.push(`sr.period = $${params.length}`); }
    const read = await withTenants(
      [tenantId],
      async (c) => {
        const { rows } = await c.query<{
          id: string; engagementId: string; clientName: string; period: string | null; kind: string; status: string;
          createdAt: string; approvedAt: string | null; deliveredAt: string | null; notes: unknown; simulated: boolean;
          narrativeMd: string | null; rulesRef: string; reportDueDay: number | null;
        }>(
          `SELECT sr.id, sr.engagement_id AS "engagementId", cl.name AS "clientName", sr.period, sr.kind,
                  sr.status, sr.created_at AS "createdAt", sr.approved_at AS "approvedAt", sr.delivered_at AS "deliveredAt",
                  sr.notes, sr.simulated, sr.narrative_md AS "narrativeMd", sr.rules_ref AS "rulesRef", se.report_due_day AS "reportDueDay"
             FROM social_reports sr
             JOIN social_engagements se ON se.id = sr.engagement_id AND se.tenant_id = sr.tenant_id
             JOIN clients cl ON cl.id = se.client_id
            WHERE ${where.join(" AND ")}
            ORDER BY sr.created_at DESC LIMIT 500`,
          params,
        );
        // Each row's own rules, once per distinct `rules_ref`.
        const byRef = new Map<string, ReportRules>();
        const rulesFor = async (r: { kind: string; rulesRef: string }): Promise<ReportRules> => {
          const key = `${r.rulesRef}|${r.kind}`;
          let v = byRef.get(key);
          if (!v) { v = await rulesOfReport(c, tenantId, { kind: r.kind as ReportKind, rulesRef: r.rulesRef }); byRef.set(key, v); }
          return v;
        };
        return Promise.all(rows.map(async (r) => ({ r, rules: await rulesFor(r) })));
      },
      { modules: ["social"] },
    );
    const dues = await dueDaysOf(tenantId, read.map(({ r, rules }) => ({ kind: r.kind as ReportKind, period: r.period, rules, reportDueDay: r.reportDueDay === null ? null : Number(r.reportDueDay) })));
    return {
      reports: read.map(({ r, rules }, i) => {
        const { notes, narrativeMd, rulesRef: _rulesRef, reportDueDay: _day, ...row } = r;
        return {
          ...row, notesComplete: notesCheckPasses(rules.content, notes), simulated: row.simulated === true,
          due: dues[i], summaryPresent: /\S/.test(narrativeMd ?? ""), live: isLiveWhile(rules.content, row.status),
        };
      }),
    };
  }

  @Get("reports/:id")
  async getReport(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    assertUuid(id, "id");
    const loaded = await loadReportWithRules(tenantId, id);
    if (!loaded) throw new NotFoundException("report not found");
    const { report, rules } = loaded;
    const resource = socialReportResource(tenantId, id, await approverIdsOf(tenantId));
    await authorize(req.principal, resource, "read");
    // SCP-5a (§63.18): what the caller may do here, asked as plain checks (never a throw): the page shows the HoD check's and
    // the send's buttons only to the four.
    const [canApprove, canDeliver] = await Promise.all([
      check(req.principal, resource, "approve").then((d) => d.allow),
      check(req.principal, resource, "deliver").then((d) => d.allow),
    ]);
    // W5-A2 (§63.24.1): a draft whose numbers freeze at submit answers them live (`live: true`); the rest read their frozen ones.
    const numbers = await currentNumbers(tenantId, report, rules);
    const [due] = await dueDaysOf(tenantId, [{ kind: report.kind, period: report.period, rules, reportDueDay: report.reportDueDay }]);
    return {
      id: report.id, status: report.status, engagementId: report.engagementId, kind: report.kind, period: report.period,
      notes: report.notes, actionPlan: report.actionPlan, nextPeriod: report.nextPeriod, simulated: numbers.simulated,
      live: numbers.live, due,
      notesComplete: notesCheckPasses(rules.content, report.rawNotes), canApprove, canDeliver,
      document: documentOf(tenantId, report, { metrics: numbers.metrics, simulated: numbers.simulated }),
    };
  }

  // ==================================================================== EDIT / SUBMIT / SEND BACK
  // W5-A2 (§63.24.3): the report's own rules decide which parts it takes and their limits (a part its rules leave out is 400
  // `{field}`), and `nextPeriod` joins `narrativeMd`, `notes` and `actionPlan`. Submitting a report whose numbers freeze at submit
  // takes the snapshot in the status change's transaction and runs the numbers guard on the summary (400 `summary_numbers_changed`
  // with the numbers in `detail.numbers`, the one extra field the error shape forwards for such a refusal: http-error.filter.ts); a send-back keeps the snapshot and the next submit takes it again.
  @Patch("reports/:id")
  @HttpCode(200)
  async updateReport(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { narrativeMd?: string; notes?: unknown; actionPlan?: unknown; nextPeriod?: unknown; status?: string } = {},
  ) {
    assertUuid(id, "id");
    const loaded = await loadReportWithRules(tenantId, id);
    if (!loaded) throw new NotFoundException("report not found");
    const { report, rules } = loaded;
    // SCP-5a (§53.7, BFF §63.18): sending a report BACK from the HoD check (in_review -> draft) is the other answer of that
    // check, so it authorizes as `approve` (the four social approvers), not `update`. An edit in the same call (the narrative,
    // the notes, the action plan or the next-period line) also needs `update`. Decided from the requested move before any validation, so a refused
    // caller gets 403, never 400.
    const reportResource = socialReportResource(tenantId, id, await approverIdsOf(tenantId));
    const sendingBack = body.status === "draft";
    const editing = body.narrativeMd !== undefined || body.notes !== undefined || body.actionPlan !== undefined || body.nextPeriod !== undefined;
    if (sendingBack) {
      await authorize(req.principal, reportResource, "approve");
      if (editing) await authorize(req.principal, reportResource, "update");
    } else {
      await authorize(req.principal, reportResource, "update");
    }

    // SCP-5a: the shapes of 63.1 file 9 (400 {field}), now the report's own rules' (W5-A2).
    const edit = validateEdit(rules.content, { narrativeMd: body.narrativeMd, notes: body.notes, actionPlan: body.actionPlan, nextPeriod: body.nextPeriod });
    if (!edit.ok) invalidField(edit.field);
    const { narrativeMd, notes, actionPlan, nextPeriod } = edit.value;

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

    const submitting = targetStatus === "in_review" && report.status === "draft";
    const freezeRange = submitting && rules.content.freezeAt === "submit" ? rangeOfReport(report, rules) : null;

    await withTenants(
      [tenantId],
      async (c) => {
        const sets: string[] = ["updated_at = now()", "status = $2"];
        const params: unknown[] = [id, targetStatus];
        if (narrativeMd !== undefined) { params.push(narrativeMd); sets.push(`narrative_md = $${params.length}`); }
        if (notes !== undefined) { params.push(JSON.stringify(notes)); sets.push(`notes = $${params.length}::jsonb`); }
        if (actionPlan !== undefined) { params.push(JSON.stringify(actionPlan)); sets.push(`action_plan = $${params.length}::jsonb`); }
        if (nextPeriod !== undefined) { params.push(nextPeriod); sets.push(`next_period = $${params.length}`); }
        if (freezeRange) {
          // The numbers freeze here, in the status change's own transaction (a rollback leaves the live draft). The summary the four
          // will check, and the client will receive, may state only numbers this snapshot holds.
          const snap = await snapshotOf(c, { tenantId, engagementId: report.engagementId, clientId: report.clientId, kind: report.kind, range: freezeRange });
          const summary = narrativeMd ?? report.narrativeMd;
          const moved = findUngroundedNumbers(summary, groundingFactsOf(snap.frozen, { engagementName: report.engagementName, clientName: report.clientName }, []));
          if (moved.length > 0) throw new BadRequestException({ message: "summary_numbers_changed", detail: { numbers: moved } });
          const keep = {
            ...(report.metrics.narrativeSource ? { narrativeSource: report.metrics.narrativeSource } : {}),
            ...(report.metrics.narrativeModel ? { narrativeModel: report.metrics.narrativeModel } : {}),
          };
          params.push(JSON.stringify({ ...snap.frozen, ...keep })); sets.push(`metrics = $${params.length}::jsonb`);
          params.push(snap.simulated); sets.push(`simulated = $${params.length}`);
        }
        params.push(report.status); // compare-and-swap against the status this handler read
        const guardIdx = params.length;
        const r = await c.query(
          `UPDATE social_reports SET ${sets.join(", ")} WHERE id = $1 AND status = $${guardIdx} AND deleted_at IS NULL`,
          params,
        );
        if (r.rowCount === 0) throw new BadRequestException({ message: "status_changed_concurrently" });
        if (submitting) {
          await emitEvent(c, tenantId, "social_report", id, "social.report.ready_for_review", {
            engagementId: report.engagementId, period: report.period, kind: report.kind,
          });
        }
      },
      { modules: ["social"] },
    );
    await writeActivity(tenantId, req.principal.userId, "updated", "social_report", id, {
      status: targetStatus, narrativeMdEdited: narrativeMd !== undefined, notesEdited: notes !== undefined, actionPlanEdited: actionPlan !== undefined,
      ...(nextPeriod !== undefined ? { nextPeriodEdited: true } : {}), ...(freezeRange ? { numbersFrozen: true } : {}),
    });
    return { id, status: targetStatus };
  }

  // ==================================================================== DRAFT WITH AI (SCP-5a) ====
  // A PROPOSAL, never a write (§63.18): the narrative, the three notes and the action plan drafted from the report's FROZEN
  // snapshot and the client's own brand corpus (`queryBrandKnowledge`, DW-D31). Nothing is saved: the page shows it and the
  // officer saves what they keep with a PATCH. The gateway down, or an answer that fails any check, gives the plain template
  // (`draftedVia: 'template'`). Only while the report can still be edited (400 `report_not_editable`).
  // W5-A2 (§63.24.3): a daily or weekly report answers `{narrativeMd, nextPeriod, draftedVia}` from its numbers as they stand (live
  // while a draft); a long kind answers as the monthly, with the notes and the plan its own rules ask for. A kind the company drafts
  // by hand (`aiDrafting` off) is 409 `ai_drafting_off`.
  @Post("reports/:id/ai-draft")
  @HttpCode(200)
  async aiDraftReport(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    assertUuid(id, "id");
    const loaded = await loadReportWithRules(tenantId, id);
    if (!loaded) throw new NotFoundException("report not found");
    const { report, rules } = loaded;
    await authorize(req.principal, socialReportResource(tenantId, id, await approverIdsOf(tenantId)), "update");
    if (report.status !== "draft" && report.status !== "in_review") refuse("report_not_editable");
    if (rules.kindRules && !rules.content.aiDrafting) throw new ConflictException({ message: "ai_drafting_off" });

    const numbers = await currentNumbers(tenantId, report, rules);
    const knowledgeHits = await queryBrandKnowledge(
      req.principal.userId, tenantId, report.clientId,
      `${report.engagementName} performance report ${report.period ?? ""}`.trim(), REPORT_KNOWLEDGE_HITS,
    );
    const facts = groundingFactsOf(numbers.metrics, { engagementName: report.engagementName, clientName: report.clientName }, knowledgeHits);
    const shortCtx = isShortKind(report.kind) ? shortDraftContext(report, numbers.metrics, rules.content) : null;
    const shape = draftShapeOf(rules.content);
    let raw: string | null = null;
    try {
      raw = (await completeViaGateway(shortCtx ? buildShortReportDraftPrompt(facts, shortCtx) : buildMonthlyReportDraftPrompt(facts, shape), {
        attribution: aiAttribution(req.principal, tenantId, "other", { task: "social.report_narrative" }),
      })).text;
    } catch {
      raw = null; // the gateway down: the template, never a failed request
    }
    if (shortCtx) {
      const draft = parseShortReportDraft(raw, facts, shortCtx);
      return { narrativeMd: draft.narrativeMd, nextPeriod: draft.nextPeriod, draftedVia: draft.draftedVia };
    }
    const draft = parseMonthlyReportDraft(raw, facts, shape);
    return { narrativeMd: draft.narrativeMd, notes: draft.notes, actionPlan: draft.actionPlan, draftedVia: draft.draftedVia };
  }

  // ==================================================================== APPROVE ===================
  // Base design §07: "Low-impact artifacts (reports, campaign plans) approve in-console via module permissions" — this IS that approval. See the file header for why neither the D14 registry nor
  // SMM-31's client-review stage fits. SCP-5a (§63.18): the HoD check, the four social approvers only. No maker/checker rule (SCP-Q22):
  // one of the four may approve a report they wrote. W5-A2 (§63.24.3): the check needs what the REPORT'S OWN rules name, in this
  // order: the summary (400 `summary_missing`), the notes (`notes_incomplete`), the action plan (`action_plan_missing`) and the
  // next-period line (`next_period_missing`); by default a daily or weekly report needs its summary and a long kind its notes.
  @Post("reports/:id/approve")
  @HttpCode(200)
  async approveReport(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    assertUuid(id, "id");
    const loaded = await loadReportWithRules(tenantId, id);
    if (!loaded) throw new NotFoundException("report not found");
    const { report, rules } = loaded;
    await authorize(req.principal, socialReportResource(tenantId, id, await approverIdsOf(tenantId)), "approve");
    if (report.status !== "in_review") refuse("cannot_approve_from_this_status");
    const content = rules.content;
    const unmet = unmetCheck(content, { narrativeMd: report.narrativeMd, notes: report.rawNotes, actionPlan: report.actionPlan, nextPeriod: report.nextPeriod });
    if (unmet) refuse(unmet);
    // The rule is re-checked in the UPDATE itself, so an edit that blanks a part between the read above and this write cannot
    // slip through: the row is then left alone and the refusal re-read.
    const params: unknown[] = [id, req.principal.userId];
    const needs: string[] = [];
    if (content.checkRequires.includes("narrative")) needs.push(`coalesce(narrative_md, '') ~ '\\S'`);
    if (content.checkRequires.includes("notes") && content.areas.length > 0) {
      params.push(noteKeysOf(content));
      needs.push(`NOT EXISTS (
                   SELECT 1 FROM unnest($${params.length}::text[]) AS a(area)
                    WHERE coalesce(notes -> a.area ->> 'insight', '') !~ '\\S' OR coalesce(notes -> a.area ->> 'suggestion', '') !~ '\\S')`);
    }
    if (content.checkRequires.includes("actionPlan")) needs.push(`(CASE WHEN jsonb_typeof(action_plan) = 'array' THEN jsonb_array_length(action_plan) ELSE 0 END) > 0`);
    if (content.checkRequires.includes("nextPeriodLine")) needs.push(`coalesce(next_period, '') ~ '\\S'`);
    const r = await withTenants(
      [tenantId],
      (c) => c.query(
        `UPDATE social_reports SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now()
           WHERE id = $1 AND status = 'in_review' AND deleted_at IS NULL${needs.map((n) => `\n             AND ${n}`).join("")}`,
        params,
      ),
      { modules: ["social"] },
    );
    if (r.rowCount === 0) {
      const now = await withTenants([tenantId], (c) => loadReport(c, id), { modules: ["social"] });
      if (!now || now.status !== "in_review") refuse("cannot_approve_from_this_status");
      refuse(unmetCheck(content, { narrativeMd: now.narrativeMd, notes: now.rawNotes, actionPlan: now.actionPlan, nextPeriod: now.nextPeriod }) ?? "notes_incomplete");
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

    // SCP-5a: the PDF carries the notes and the action plan (as tables) and the SIMULATED mark (`document.simulated`); W5-A2: a
    // daily or weekly report's summary and next-period line. An approved report's numbers are frozen, so the document reads them.
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

        // SCP-5f (BFF §63.27.3): a delivered monthly report closes the `report` step of the cycle(s) whose rules name its period (the
        // seed's: cycle M = period + 2), in THIS transaction. It takes only that step task; nothing else of the cycle is locked.
        await closeReportStepsOnDelivery(c, tenantId, { engagementId: report.engagementId, kind: report.kind, period: report.period }, req.principal.userId ?? null);

        // PV7-04a (BFF §55.2): publish it to the client in THIS transaction. An engagement with no project gives a client-wide
        // report (project NULL). Idempotent per source (one client report per social report, ever).
        let clientReport: PublishedClientReport | null = null;
        if (clientCopy && req.principal.userId) {
          // W5-A2: a periodic kind's period is the range its numbers were frozen over (the company's fiscal year included); the
          // monthly, campaign and ad hoc reports keep SCP-5a's and SMM-23's.
          const { start, end } = isPeriodicKind(report.kind) && report.kind !== "monthly" && report.metrics.rangeStart && report.metrics.rangeEnd
            ? { start: report.metrics.rangeStart, end: report.metrics.rangeEnd }
            : periodDateRange(report.period, new Date(report.createdAt));
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
