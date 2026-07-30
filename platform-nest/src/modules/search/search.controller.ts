// Search-marketing module routes (SM-02; docs/blueprints/seo-sem-design.md §04/§09/§11). Mounted
// under /api/:tenantId/modules/search and gated by AuthGuard + ModuleEnabledGuard("search") — dark
// unless the tenant has 'search' in enabled_modules OR an ACTIVE service_assignment serving
// 'search' to this tenant (registry.ts isModuleEnabled, the standard shared-service OR-clause).
//
// P0 core CRUD only (design §12 SM-02): properties, engagements, kpi-targets, and the per-
// engagement tool-scope endpoints + preset seeding. Campaigns/audits/ranks/reports/provider layer
// are LATER tickets (SM-04/05/07/08/14/16/18) — this controller does not touch that surface.
//
// Three independent walls back every read/write here (hr.controller.ts's documented pattern):
//   1. Cerbos (resource_search_property.yaml / resource_search_engagement.yaml — SM-03, NOT YET
//      LANDED) — module_staff/module_manager derived roles matched by resource.attr.module="search"
//      + tenantId=<SERVED company>. Until SM-03 ships those policy files, Cerbos has no matching
//      resourcePolicy for these two new kinds and DENIES every call by default (verified against the
//      live dev Cerbos instance while building this ticket) — i.e. this module ships FAIL-CLOSED,
//      not fail-open, in the interim between SM-02 and SM-03. That is the correct interim state.
//   2. The ORG-3 tenant choke-point (withTenants([tenantId])) — the caller's authorized-tenant-set.
//   3. Module-sliced RLS (app_module_allowed('search'), the third wall, 0034) — declared via
//      withTenants(...,{modules:['search']}) on every query below. Forgetting the third param on
//      any new query here reads/writes ZERO rows (fail-closed), never a leak.
//
// FK tenant-validation (QA-flagged from SM-01): Postgres FK constraints are checked by the TABLE
// OWNER role and so run OUTSIDE RLS — a caller could otherwise reference another tenant's client_id/
// property_id/project_id and the FK alone would happily accept it. Every helper below resolves the
// referenced row through the SAME tenant+module-scoped connection `c` the mutation runs in, so a
// cross-tenant id resolves to zero rows (rejected with 400) before it ever reaches the INSERT/UPDATE.
import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Put, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity } from "../../core/http";
import { validateCustomFields } from "../../core/custom-fields";
import { emitEvent } from "../../events/outbox.service";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { isScopePreset, seedToolScope, type ScopePreset } from "./scope-presets";
import { projectMonthlyCost } from "./providers/dispatch";
import { moneyOrNull, sumMonthToDate } from "./providers/ledger";
import { parseKeywordImport } from "./keyword-import";
import { clusterKeywordSet, embedKeywordSet, INTENTS, KeywordSetTooLargeError } from "./clustering";
import { pullMetricsForKeywords, pullRankForKeyword, pullRanksForEngagement } from "./rank";
import { pullBacklinksForProperty } from "./backlinks";
import { pullAiVisibilityForProperty } from "./ai-visibility";
import {
  AUDIT_KINDS, AUDIT_SOURCES, AUDIT_TRIAGE_STATUSES,
  computeScore, deriveFindings, diffAudits, hashReport, severitySummary, validateCrawlerReport,
  type PrevFindingRow,
} from "./search-audit";
import { completeViaGateway } from "./providers/gateway-client";
import {
  MAX_BRIEF_FINDINGS, MAX_BRIEF_KEYWORDS, MAX_KNOWLEDGE_HITS, MAX_KNOWLEDGE_INGEST_CHUNKS, MAX_TRIAGE_FINDINGS,
  buildBriefPrompt, buildBriefPolishPrompt, buildReportNarrativePrompt, buildTriagePrompt,
  parseBriefDraft, parseReportNarrative, parseTriageDraft,
  type BriefDraft, type BriefGroundingFacts, type ReportMetricsFacts, type TriageFindingFact,
} from "./ai-drafts";
import { ingestPropertyKnowledge, queryPropertyKnowledge } from "./knowledge-client";
import { buildCampaignPlan, NoClusteredKeywordsError, type PlanKeywordRow } from "./sem-plan";
import {
  buildNegativesProposalPrompt, buildRsaDraftPrompt, MAX_NEGATIVE_TERMS, MAX_RSA_KEYWORDS,
  NEGATIVE_MATCH_TYPES, parseNegativesProposal, parseRsaDraft, type RsaKeywordFact,
} from "./sem-drafts";

const PROPERTY_STATUSES = new Set(["active", "paused", "archived"]);
const ENGAGEMENT_STATUSES = new Set(["draft", "active", "paused", "closed"]);
const KPI_DIRECTIONS = new Set(["up", "down"]);
const KEYWORD_SET_SOURCES = new Set(["client", "gsc", "research", "ai"]);
const AUDIT_KIND_SET = new Set<string>(AUDIT_KINDS);
const AUDIT_SOURCE_SET = new Set<string>(AUDIT_SOURCES);
const AUDIT_TRIAGE_STATUS_SET = new Set<string>(AUDIT_TRIAGE_STATUSES);
// Only the crawler's Report shape (search-crawl-go/internal/crawler) is a known adapter today.
// SEONaut/Unlighthouse are documented as future job-mode containers (design §07 sourcing table)
// but neither ships a report struct anywhere in this repo yet — rather than fabricate a mapping
// for a shape that doesn't exist, ingest refuses those sources with a clear 400 until their
// adapters land. 'ai' is reserved for AI-drafted findings (SM-10), also not this ticket's job.
const INGESTABLE_SOURCES = new Set(["crawler"]);
const BRIEF_STATUSES = new Set(["draft", "approved"]);
const REPORT_KINDS = new Set(["monthly", "audit", "adhoc"]);

// ── SM-18: SEM domain (campaigns/ad-groups/ads/negatives/change-proposals) ─────────────────────────
const CAMPAIGN_PLATFORMS = new Set(["google_ads", "microsoft_ads"]);
// 'live'/'paused'/'ended' mirror a REAL ad account once a live-ads sync exists (SM-20/25/26). This
// ticket has NO live side-effects (design §12 SM-18 "done when"), so only the two ERP-side draft
// states (design §04: "draft/proposed are ERP-side states") are settable through these routes.
const CAMPAIGN_STATUSES_WRITABLE = new Set(["draft", "proposed"]);
const AD_STATUSES_WRITABLE = new Set(["draft", "approved", "rejected"]); // 'live' is sync-only
const NEGATIVE_MATCH_TYPE_SET = new Set<string>(NEGATIVE_MATCH_TYPES);
const NEGATIVE_STATUSES_WRITABLE = new Set(["proposed", "approved", "dismissed"]); // 'applied' is SM-30/21's job
const CHANGE_PROPOSAL_KINDS = new Set(["launch", "pause", "budget", "bid", "negatives_batch", "ads_batch"]);
const CHANGE_PROPOSAL_MODES = new Set(["manual", "api"]);
// Valid status transitions FOR THIS TICKET's PATCH endpoint only — 'applied' never appears as a
// reachable target here (see updateChangeProposal's own comment for why).
const CHANGE_PROPOSAL_TRANSITIONS: Record<string, string[]> = {
  proposed: ["approved", "dismissed"],
  approved: ["dismissed"],
  dismissed: [],
  applied: [],
};

// Every uuid-typed column this controller compares against ($1 = uuid) rejects a non-uuid literal
// with a raw Postgres 22P02 error, which is NOT an HttpException and so is not reshaped by
// http-error.filter.ts — it would surface as an unhandled 500 instead of a clean 400. Guarding format
// BEFORE any query touches the value (same technique as modules/pm/pm.controller.ts's UUID_RE) keeps
// every malformed-input case on this new surface a 400, never a 500 (this ticket's own verification
// bar; pre-existing sibling routes elsewhere in this file predate the convention and are unchanged).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUuid(value: string, label: string): void {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new BadRequestException(`${label} must be a valid id`);
}

function isFiniteOrNull(v: unknown): v is number | null {
  return v === null || (typeof v === "number" && Number.isFinite(v));
}

async function campaignRow(c: PoolClient, campaignId: string): Promise<{ engagementId: string } | null> {
  const r = await c.query<{ engagement_id: string }>(
    `SELECT engagement_id FROM search_campaigns WHERE id = $1 AND deleted_at IS NULL`,
    [campaignId],
  );
  return r.rows[0] ? { engagementId: r.rows[0].engagement_id } : null;
}

async function adGroupRow(c: PoolClient, adGroupId: string): Promise<{ campaignId: string } | null> {
  const r = await c.query<{ campaign_id: string }>(
    `SELECT campaign_id FROM search_ad_groups WHERE id = $1 AND deleted_at IS NULL`,
    [adGroupId],
  );
  return r.rows[0] ? { campaignId: r.rows[0].campaign_id } : null;
}

async function changeProposalRow(c: PoolClient, proposalId: string): Promise<{ campaignId: string; status: string } | null> {
  const r = await c.query<{ campaign_id: string; status: string }>(
    `SELECT campaign_id, status FROM search_change_proposals WHERE id = $1 AND deleted_at IS NULL`,
    [proposalId],
  );
  return r.rows[0] ? { campaignId: r.rows[0].campaign_id, status: r.rows[0].status } : null;
}

// ─────────────────────────────────────────── FK tenant-validation helpers ───────────────────────────
async function clientExists(c: PoolClient, clientId: string): Promise<boolean> {
  const r = await c.query(`SELECT 1 FROM clients WHERE id = $1 AND deleted_at IS NULL`, [clientId]);
  return !!r.rows[0];
}

async function projectExists(c: PoolClient, projectId: string): Promise<boolean> {
  const r = await c.query(`SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL`, [projectId]);
  return !!r.rows[0];
}

async function propertyRow(c: PoolClient, propertyId: string): Promise<{ clientId: string } | null> {
  const r = await c.query<{ client_id: string }>(
    `SELECT client_id FROM search_properties WHERE id = $1 AND deleted_at IS NULL`,
    [propertyId],
  );
  return r.rows[0] ? { clientId: r.rows[0].client_id } : null;
}

// SM-14: the tracked property's own DOMAIN is what findPropertyPosition (rank.ts) matches into a
// dispatched SERP's returned item list — the provider itself has no notion of "whose rank" (its
// request shape carries only the keyword, design §05), so this module resolves it after the fact.
async function propertyDomainRow(c: PoolClient, propertyId: string): Promise<{ domain: string } | null> {
  const r = await c.query<{ domain: string }>(
    `SELECT domain FROM search_properties WHERE id = $1 AND deleted_at IS NULL`,
    [propertyId],
  );
  return r.rows[0] ? { domain: r.rows[0].domain } : null;
}

async function engagementRow(c: PoolClient, engagementId: string): Promise<{ clientId: string; propertyId: string } | null> {
  const r = await c.query<{ client_id: string; property_id: string }>(
    `SELECT client_id, property_id FROM search_engagements WHERE id = $1 AND deleted_at IS NULL`,
    [engagementId],
  );
  return r.rows[0] ? { clientId: r.rows[0].client_id, propertyId: r.rows[0].property_id } : null;
}

// SM-16: the engagement detail a backlink/AI-visibility pull needs — the property to pull FOR
// (an engagement has exactly one, 0034), and tool_scope so an ai-visibility-pull with no explicit
// `queries` override can fall back to the engagement's own scope-configured query list (the same
// `tool_scope.ai_visibility.queries` field providers/dispatch.ts's cost-projection already reads —
// design's own D-11 rule: "cadence comes from engagement tool_scope, never hardcoded", SM-15 §2).
async function engagementScopeRow(
  c: PoolClient,
  engagementId: string,
): Promise<{ propertyId: string; toolScope: Record<string, unknown> } | null> {
  const r = await c.query<{ property_id: string; tool_scope: Record<string, unknown> }>(
    `SELECT property_id, tool_scope FROM search_engagements WHERE id = $1 AND deleted_at IS NULL`,
    [engagementId],
  );
  return r.rows[0] ? { propertyId: r.rows[0].property_id, toolScope: r.rows[0].tool_scope ?? {} } : null;
}

async function keywordSetRow(c: PoolClient, setId: string): Promise<{ engagementId: string } | null> {
  const r = await c.query<{ engagement_id: string }>(
    `SELECT engagement_id FROM search_keyword_sets WHERE id = $1 AND deleted_at IS NULL`,
    [setId],
  );
  return r.rows[0] ? { engagementId: r.rows[0].engagement_id } : null;
}

async function keywordRow(c: PoolClient, keywordId: string): Promise<{ setId: string } | null> {
  const r = await c.query<{ set_id: string }>(
    `SELECT set_id FROM search_keywords WHERE id = $1 AND deleted_at IS NULL`,
    [keywordId],
  );
  return r.rows[0] ? { setId: r.rows[0].set_id } : null;
}

// SM-14: the detail a rank/metrics dispatch needs about one keyword row — text + locale for the
// ProviderOp, set_id to resolve back to its engagement.
async function keywordDetailRow(
  c: PoolClient,
  keywordId: string,
): Promise<{ keyword: string; locale: string; setId: string; isTracked: boolean } | null> {
  const r = await c.query<{ keyword: string; locale: string; set_id: string; is_tracked: boolean }>(
    `SELECT keyword, locale, set_id, is_tracked FROM search_keywords WHERE id = $1 AND deleted_at IS NULL`,
    [keywordId],
  );
  return r.rows[0]
    ? { keyword: r.rows[0].keyword, locale: r.rows[0].locale, setId: r.rows[0].set_id, isTracked: r.rows[0].is_tracked }
    : null;
}

async function auditRow(c: PoolClient, auditId: string): Promise<{ propertyId: string } | null> {
  const r = await c.query<{ property_id: string }>(
    `SELECT property_id FROM search_audits WHERE id = $1 AND deleted_at IS NULL`,
    [auditId],
  );
  return r.rows[0] ? { propertyId: r.rows[0].property_id } : null;
}

async function findingRow(c: PoolClient, findingId: string): Promise<{ auditId: string } | null> {
  const r = await c.query<{ audit_id: string }>(
    `SELECT audit_id FROM search_audit_findings WHERE id = $1`,
    [findingId],
  );
  return r.rows[0] ? { auditId: r.rows[0].audit_id } : null;
}

async function briefRow(c: PoolClient, briefId: string): Promise<{ propertyId: string } | null> {
  const r = await c.query<{ property_id: string }>(
    `SELECT property_id FROM search_content_briefs WHERE id = $1 AND deleted_at IS NULL`,
    [briefId],
  );
  return r.rows[0] ? { propertyId: r.rows[0].property_id } : null;
}

async function reportRow(c: PoolClient, reportId: string): Promise<{ engagementId: string } | null> {
  const r = await c.query<{ engagement_id: string }>(
    `SELECT engagement_id FROM search_reports WHERE id = $1 AND deleted_at IS NULL`,
    [reportId],
  );
  return r.rows[0] ? { engagementId: r.rows[0].engagement_id } : null;
}

@Controller("api/:tenantId/modules/search")
@UseGuards(AuthGuard, ModuleEnabledGuard("search"))
export class SearchController {
  // ============================================================== PROPERTIES ==================
  @Get("properties")
  async listProperties(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("clientId") clientId?: string, @Query("status") status?: string,
  ) {
    await authorize(req.principal, { kind: "resource_search_property", tenantId, module: "search" }, "read");
    const params: unknown[] = [];
    const clauses = ["deleted_at IS NULL"];
    if (clientId) { params.push(clientId); clauses.push(`client_id = $${params.length}`); }
    if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, client_id AS "clientId", domain, site_url AS "siteUrl", targets, umami_site_id AS "umamiSiteId",
                verified_at AS "verifiedAt", status, created_at, updated_at
         FROM search_properties WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 500`,
        params,
      ),
      { modules: ["search"] },
    );
    return rows.rows;
  }

  @Post("properties")
  @HttpCode(201)
  async createProperty(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { clientId?: string; domain?: string; siteUrl?: string; targets?: unknown[]; status?: string },
  ) {
    const { clientId, domain, siteUrl } = body ?? {};
    if (!clientId || !domain || !siteUrl) throw new BadRequestException("clientId, domain and siteUrl required");
    if (body?.status && !PROPERTY_STATUSES.has(body.status)) throw new BadRequestException("invalid status");
    await authorize(req.principal, { kind: "resource_search_property", tenantId, module: "search" }, "create");
    const id = newId();
    await withTenants(
      [tenantId],
      async (c) => {
        if (!(await clientExists(c, clientId))) throw new BadRequestException("clientId not found in this tenant");
        await c.query(
          `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, targets, status, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, tenantId, clientId, domain, siteUrl, JSON.stringify(body?.targets ?? []), body?.status ?? "active", config.originSite],
        );
        await emitEvent(c, tenantId, "search_property", id, "search.property.created", { clientId, domain });
      },
      { modules: ["search"] },
    );
    await writeActivity(tenantId, req.principal.userId, "created", "search_property", id, { domain });
    return { id };
  }

  @Get("properties/:id")
  async getProperty(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "resource_search_property", id, tenantId, module: "search" }, "read");
    const row = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, client_id AS "clientId", domain, site_url AS "siteUrl", targets, umami_site_id AS "umamiSiteId",
                gsc_connection_id AS "gscConnectionId", ga4_connection_id AS "ga4ConnectionId", ads_connection_id AS "adsConnectionId",
                verified_at AS "verifiedAt", status, created_at, updated_at
         FROM search_properties WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      ),
      { modules: ["search"] },
    );
    if (!row.rows[0]) throw new NotFoundException("property not found");
    return row.rows[0];
  }

  @Patch("properties/:id")
  @HttpCode(200)
  async updateProperty(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { domain?: string; siteUrl?: string; targets?: unknown[]; status?: string; verifiedAt?: string | null; umamiSiteId?: string },
  ) {
    if (body?.status && !PROPERTY_STATUSES.has(body.status)) throw new BadRequestException("invalid status");
    await authorize(req.principal, { kind: "resource_search_property", id, tenantId, module: "search" }, "update");
    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [id];
    if (body?.domain) { params.push(body.domain); sets.push(`domain = $${params.length}`); }
    if (body?.siteUrl) { params.push(body.siteUrl); sets.push(`site_url = $${params.length}`); }
    if (body?.targets) { params.push(JSON.stringify(body.targets)); sets.push(`targets = $${params.length}`); }
    if (body?.status) { params.push(body.status); sets.push(`status = $${params.length}`); }
    if (body?.umamiSiteId !== undefined) { params.push(body.umamiSiteId); sets.push(`umami_site_id = $${params.length}`); }
    if (body?.verifiedAt !== undefined) { params.push(body.verifiedAt); sets.push(`verified_at = $${params.length}`); }
    const res = await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE search_properties SET ${sets.join(", ")} WHERE id = $1 AND deleted_at IS NULL`, params),
      { modules: ["search"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("property not found");
    await writeActivity(tenantId, req.principal.userId, "updated", "search_property", id, body ?? {});
    return { id };
  }

  @Delete("properties/:id")
  @HttpCode(200)
  async deleteProperty(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "resource_search_property", id, tenantId, module: "search" }, "delete");
    const res = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query(`UPDATE search_properties SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]);
        if (r.rowCount) await emitEvent(c, tenantId, "search_property", id, "search.property.deleted", {});
        return r;
      },
      { modules: ["search"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("property not found");
    await writeActivity(tenantId, req.principal.userId, "deleted", "search_property", id, {});
    return { ok: true };
  }

  // ============================================================== ENGAGEMENTS =================
  @Get("engagements")
  async listEngagements(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("clientId") clientId?: string, @Query("propertyId") propertyId?: string, @Query("status") status?: string,
  ) {
    await authorize(req.principal, { kind: "resource_search_engagement", tenantId, module: "search" }, "read");
    const params: unknown[] = [];
    const clauses = ["deleted_at IS NULL"];
    if (clientId) { params.push(clientId); clauses.push(`client_id = $${params.length}`); }
    if (propertyId) { params.push(propertyId); clauses.push(`property_id = $${params.length}`); }
    if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        // `tool_scope` is included deliberately: the console's engagement LIST shows a
        // "N of 5 metered tools on" summary per row, and without this column every row reported
        // 0 — a silent wrong answer, not an error, because the UI just read `undefined` as
        // "nothing enabled". Found at the SM-29 gate. It is a small jsonb on a LIMIT 500 read,
        // and the alternative (a per-row scope fetch from the browser) would be far worse.
        `SELECT id, client_id AS "clientId", property_id AS "propertyId", project_id AS "projectId", name,
                scope_preset AS "scopePreset", provider_budget_usd AS "providerBudgetUsd", tool_scope AS "toolScope",
                media_budget_minor AS "mediaBudgetMinor", media_currency AS "mediaCurrency", status,
                owner_id AS "ownerId", starts_on AS "startsOn", ends_on AS "endsOn", custom_fields AS "customFields",
                created_at, updated_at
         FROM search_engagements WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 500`,
        params,
      ),
      { modules: ["search"] },
    );
    // `provider_budget_usd` is numeric(12,6) => a STRING over the wire. The scope and
    // cost-projection endpoints below already cast it; this one and getEngagement did not, so a
    // consumer got a number from one endpoint and a string from another for the same field.
    return rows.rows.map((r) => ({ ...r, providerBudgetUsd: moneyOrNull(r.providerBudgetUsd) }));
  }

  @Post("engagements")
  @HttpCode(201)
  async createEngagement(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: {
      clientId?: string; propertyId?: string; projectId?: string; name?: string;
      scopePreset?: string; toolScope?: Record<string, unknown>; providerBudgetUsd?: number;
      mediaBudgetMinor?: number; mediaCurrency?: string; ownerId?: string; startsOn?: string; endsOn?: string;
      customFields?: Record<string, unknown>;
    },
  ) {
    const { clientId, propertyId, name } = body ?? {};
    if (!clientId || !propertyId || !name) throw new BadRequestException("clientId, propertyId and name required");
    if (body?.scopePreset && !isScopePreset(body.scopePreset)) throw new BadRequestException("scopePreset must be light|standard|heavy|custom");
    await authorize(req.principal, { kind: "resource_search_engagement", tenantId, module: "search" }, "create");

    // Preset seeding (design §04): light/standard/heavy SEED tool_scope; 'custom' (or omitted)
    // leaves whatever tool_scope the caller supplied (or {} if none) as-is.
    const preset = body?.scopePreset as ScopePreset | undefined;
    const seeded = seedToolScope(preset);
    const toolScope = seeded ?? body?.toolScope ?? {};

    const id = newId();
    await withTenants(
      [tenantId],
      async (c) => {
        if (!(await clientExists(c, clientId))) throw new BadRequestException("clientId not found in this tenant");
        const property = await propertyRow(c, propertyId);
        if (!property) throw new BadRequestException("propertyId not found in this tenant");
        // The ER model (design §04) scopes an engagement to a property that belongs to the SAME
        // client — catches a cross-client mix-up at write time rather than silently persisting it.
        if (property.clientId !== clientId) throw new BadRequestException("propertyId does not belong to clientId");
        if (body?.projectId && !(await projectExists(c, body.projectId))) throw new BadRequestException("projectId not found in this tenant");
        if (body?.customFields) {
          const cfError = await validateCustomFields(c, tenantId, "search_engagement", body.customFields);
          if (cfError) throw new BadRequestException(cfError);
        }
        await c.query(
          `INSERT INTO search_engagements
             (id, tenant_id, client_id, property_id, project_id, name, scope_preset, tool_scope,
              provider_budget_usd, media_budget_minor, media_currency, owner_id, starts_on, ends_on, custom_fields, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            id, tenantId, clientId, propertyId, body?.projectId ?? null, name, preset ?? null, JSON.stringify(toolScope),
            body?.providerBudgetUsd ?? 10.0, body?.mediaBudgetMinor ?? null, body?.mediaCurrency ?? null,
            body?.ownerId ?? null, body?.startsOn ?? null, body?.endsOn ?? null, JSON.stringify(body?.customFields ?? {}),
            config.originSite,
          ],
        );
        await emitEvent(c, tenantId, "search_engagement", id, "search.engagement.created", { clientId, propertyId, name });
      },
      { modules: ["search"] },
    );
    await writeActivity(tenantId, req.principal.userId, "created", "search_engagement", id, { name });
    return { id };
  }

  @Get("engagements/:id")
  async getEngagement(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "resource_search_engagement", id, tenantId, module: "search" }, "read");
    const row = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, client_id AS "clientId", property_id AS "propertyId", project_id AS "projectId", name,
                scope_preset AS "scopePreset", tool_scope AS "toolScope", provider_budget_usd AS "providerBudgetUsd",
                media_budget_minor AS "mediaBudgetMinor", media_currency AS "mediaCurrency", status,
                owner_id AS "ownerId", starts_on AS "startsOn", ends_on AS "endsOn", custom_fields AS "customFields",
                created_at, updated_at
         FROM search_engagements WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      ),
      { modules: ["search"] },
    );
    if (!row.rows[0]) throw new NotFoundException("engagement not found");
    // Same numeric-as-string cast as listEngagements — see the note there.
    return { ...row.rows[0], providerBudgetUsd: moneyOrNull(row.rows[0].providerBudgetUsd) };
  }

  @Patch("engagements/:id")
  @HttpCode(200)
  async updateEngagement(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: {
      name?: string; status?: string; ownerId?: string; startsOn?: string; endsOn?: string;
      mediaBudgetMinor?: number; mediaCurrency?: string; customFields?: Record<string, unknown>;
    },
  ) {
    // Deliberately NOT accepting scopePreset/toolScope/providerBudgetUsd here — those are gated
    // behind the separate search:scope:write permission via PUT .../scope (design §11).
    if (body?.status && !ENGAGEMENT_STATUSES.has(body.status)) throw new BadRequestException("invalid status");
    await authorize(req.principal, { kind: "resource_search_engagement", id, tenantId, module: "search" }, "update");
    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [id];
    if (body?.name) { params.push(body.name); sets.push(`name = $${params.length}`); }
    if (body?.status) { params.push(body.status); sets.push(`status = $${params.length}`); }
    if (body?.ownerId !== undefined) { params.push(body.ownerId); sets.push(`owner_id = $${params.length}`); }
    if (body?.startsOn !== undefined) { params.push(body.startsOn); sets.push(`starts_on = $${params.length}`); }
    if (body?.endsOn !== undefined) { params.push(body.endsOn); sets.push(`ends_on = $${params.length}`); }
    if (body?.mediaBudgetMinor !== undefined) { params.push(body.mediaBudgetMinor); sets.push(`media_budget_minor = $${params.length}`); }
    if (body?.mediaCurrency !== undefined) { params.push(body.mediaCurrency); sets.push(`media_currency = $${params.length}`); }
    const res = await withTenants(
      [tenantId],
      async (c) => {
        if (body?.customFields) {
          const cfError = await validateCustomFields(c, tenantId, "search_engagement", body.customFields);
          if (cfError) throw new BadRequestException(cfError);
          params.push(JSON.stringify(body.customFields));
          sets.push(`custom_fields = $${params.length}`);
        }
        return c.query(`UPDATE search_engagements SET ${sets.join(", ")} WHERE id = $1 AND deleted_at IS NULL`, params);
      },
      { modules: ["search"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("engagement not found");
    await writeActivity(tenantId, req.principal.userId, "updated", "search_engagement", id, body ?? {});
    return { id };
  }

  @Delete("engagements/:id")
  @HttpCode(200)
  async deleteEngagement(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "resource_search_engagement", id, tenantId, module: "search" }, "delete");
    const res = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query(`UPDATE search_engagements SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]);
        if (r.rowCount) await emitEvent(c, tenantId, "search_engagement", id, "search.engagement.deleted", {});
        return r;
      },
      { modules: ["search"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("engagement not found");
    await writeActivity(tenantId, req.principal.userId, "deleted", "search_engagement", id, {});
    return { ok: true };
  }

  // ======================================================= ENGAGEMENT TOOL SCOPE ==============
  // GET is a plain "read" (part of the ordinary engagement view); PUT is the dedicated "set_scope"
  // action (design §11: "resource_search_engagement carries a set_scope action — the per-client
  // tool-scope decision is itself permission-gated") — gated behind search:scope:write, distinct
  // from the coarser search:engagement:write used by the general PATCH above.
  @Get("engagements/:id/scope")
  async getEngagementScope(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "resource_search_engagement", id, tenantId, module: "search" }, "read");
    const row = await withTenants(
      [tenantId],
      (c) => c.query<{ scope_preset: string | null; tool_scope: Record<string, unknown>; provider_budget_usd: string }>(
        `SELECT scope_preset, tool_scope, provider_budget_usd FROM search_engagements WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      ),
      { modules: ["search"] },
    );
    if (!row.rows[0]) throw new NotFoundException("engagement not found");
    const r = row.rows[0];
    return { scopePreset: r.scope_preset, toolScope: r.tool_scope, providerBudgetUsd: Number(r.provider_budget_usd) };
  }

  // SM-04 — the cost-PROJECTION surface (design §05/§12: "estimateCostUsd projection endpoint").
  // Read-only and free: it dispatches nothing, spends nothing, and touches no provider network path.
  // It runs the SAME provider-selection cascade + estimator the choke-point uses, so the price the
  // human sees next to a toggle in SM-29's scope grid is by construction the price dispatch will
  // meter. `?toolScope=` lets the UI price a PROPOSED scope before saving it (what-if); with no
  // query param it prices what is currently persisted.
  @Get("engagements/:id/cost-projection")
  async getEngagementCostProjection(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Query("toolScope") toolScopeJson?: string,
  ) {
    await authorize(req.principal, { kind: "resource_search_engagement", id, tenantId, module: "search" }, "read");
    const row = await withTenants(
      [tenantId],
      (c) => c.query<{ tool_scope: Record<string, unknown>; provider_budget_usd: string }>(
        `SELECT tool_scope, provider_budget_usd FROM search_engagements WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      ),
      { modules: ["search"] },
    );
    if (!row.rows[0]) throw new NotFoundException("engagement not found");

    let toolScope: Record<string, unknown> = row.rows[0].tool_scope ?? {};
    let whatIf = false;
    if (toolScopeJson !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(toolScopeJson);
      } catch {
        throw new BadRequestException("toolScope must be a JSON object");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new BadRequestException("toolScope must be a JSON object");
      }
      toolScope = parsed as Record<string, unknown>;
      whatIf = true;
    }

    const projection = projectMonthlyCost(toolScope);
    const budgetUsd = Number(row.rows[0].provider_budget_usd);
    return {
      engagementId: id,
      whatIf,
      providerBudgetUsd: budgetUsd,
      // A projection ABOVE the cap means the stop-loss will start refusing pulls partway through the
      // month — surface it here so the human sees it while choosing, not as a mid-month refusal.
      overBudget: projection.totalMonthlyUsd > budgetUsd,
      ...projection,
    };
  }

  // SM-17 — the ledger/cost surface (design addendum §A3; tracker §6j). The first UI onto the money
  // ledger, so the language and shape are ticket-BINDING, not a style choice:
  //   * `search_provider_calls.cost_usd` is COST-TO-SERVE AT STANDARD RATES, never "spend"/"cash" —
  //     Semrush/Ahrefs are prepaid subscriptions, so a row here is an amortized accounting figure,
  //     the billing/margin basis, NOT an invoice line. Only DataForSEO's PAYG rows happen to coincide
  //     with cash. The word "actual" is FORBIDDEN on any figure this endpoint returns until SM-42's
  //     true-up + SM-41's reconciliation land (Ahrefs rows are conservative upper-bound estimates
  //     until then) — this comment is the enforcement note for whoever edits this route next.
  //   * Every row AND every sum below carries `simulated` + `provider` (AC1) — badging is per-ROW,
  //     from that row's own flag, never from the current platform mode: a historical row keeps its
  //     own truth across a mode flip (addendum §A4.4).
  //   * Sums are CURRENT-MODE ONLY (§A4.1's mode-filter pattern, reused via `sumMonthToDate` —
  //     unmodified, owned by the concurrent SM-40 ticket's `providers/ledger.ts`, only READ here).
  //     Other-mode month-to-date history is surfaced ONLY as a separate, explicitly labelled
  //     `simulatedHistoryExcludedUsd` figure — the FE must render it as its own "excluded" line,
  //     never blend it into `costToServeUsd`.
  //   * `currentModeRowCount` exists so the console can distinguish "no provider calls recorded
  //     yet" (0 rows) from a real $0.00 cost-to-serve (rows exist — e.g. cache hits — and legitimately
  //     summed to zero). Collapsing those two into the same "$0.00" would be the exact class of lie
  //     the "— never 0" house rule exists to prevent, just on the empty-collection axis instead of
  //     the single-value axis.
  //   * Row fields verified against 0034's `search_provider_calls` DDL + 0047's added `simulated`
  //     column (this file's own migrations, re-read for this ticket) — not against a fixture, not
  //     against a TS interface (§4i discipline).
  @Get("engagements/:id/ledger")
  async getEngagementLedger(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "resource_search_ledger", tenantId, module: "search" }, "read");

    const currentModeSimulated = config.search.providerMode === "simulate";

    const result = await withTenants(
      [tenantId],
      async (c) => {
        const eng = await c.query(`SELECT id FROM search_engagements WHERE id = $1 AND deleted_at IS NULL`, [id]);
        if (!eng.rows[0]) return null;

        // Recent rows across BOTH modes — the per-row chip (AC1) is what keeps a historical
        // simulated row honest after a mode flip, so the list must not itself be mode-filtered.
        const rows = await c.query<{
          id: string; provider: string; endpoint: string; items: number; cost_usd: string;
          cache_hit: boolean; status: string; simulated: boolean; created_at: string;
        }>(
          `SELECT id, provider, endpoint, items, cost_usd, cache_hit, status, simulated, created_at
             FROM search_provider_calls
            WHERE engagement_id = $1
            ORDER BY created_at DESC
            LIMIT 200`,
          [id],
        );

        // Month-to-date row COUNT for the current mode only, so the caller can tell "no calls
        // recorded yet" (count = 0) apart from "calls recorded, summed to a real $0" (count > 0).
        // Same month/mode predicate shape as sumMonthToDate — deliberately hand-written here (not a
        // ledger.ts export) rather than widening that module's surface, per this ticket's file split.
        const counts = await c.query<{ current_count: string; other_count: string }>(
          `SELECT
             count(*) FILTER (WHERE simulated = $2 AND date_trunc('month', created_at) = date_trunc('month', now())) AS current_count,
             count(*) FILTER (WHERE simulated = $3 AND date_trunc('month', created_at) = date_trunc('month', now())) AS other_count
           FROM search_provider_calls WHERE engagement_id = $1`,
          [id, currentModeSimulated, !currentModeSimulated],
        );

        // Current-mode month-to-date cost-to-serve: the SAME helper the budget stop-loss reads,
        // scoped to this engagement — never re-derived from the `rows` page above (which is a
        // recent-N slice, not necessarily the whole month).
        const costToServeUsd = await sumMonthToDate(c, id, currentModeSimulated);
        const otherCount = Number(counts.rows[0].other_count);
        const simulatedHistoryExcludedUsd = otherCount > 0
          ? await sumMonthToDate(c, id, !currentModeSimulated)
          : null;

        return {
          rows: rows.rows,
          currentModeRowCount: Number(counts.rows[0].current_count),
          costToServeUsd,
          simulatedHistoryExcludedUsd,
        };
      },
      { modules: ["search"] },
    );
    if (!result) throw new NotFoundException("engagement not found");

    return {
      engagementId: id,
      providerMode: config.search.providerMode,
      costToServeUsd: result.costToServeUsd,
      currentModeRowCount: result.currentModeRowCount,
      simulatedHistoryExcludedUsd: result.simulatedHistoryExcludedUsd,
      rows: result.rows.map((r) => ({
        id: r.id,
        provider: r.provider,
        endpoint: r.endpoint,
        items: r.items,
        costUsd: moneyOrNull(r.cost_usd),
        cacheHit: r.cache_hit,
        status: r.status,
        simulated: r.simulated,
        createdAt: r.created_at,
      })),
    };
  }

  @Put("engagements/:id/scope")
  @HttpCode(200)
  async putEngagementScope(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { scopePreset?: string; toolScope?: Record<string, unknown>; providerBudgetUsd?: number },
  ) {
    if (body?.scopePreset !== undefined && !isScopePreset(body.scopePreset)) {
      throw new BadRequestException("scopePreset must be light|standard|heavy|custom");
    }
    if (body?.providerBudgetUsd !== undefined && !(body.providerBudgetUsd > 0)) {
      throw new BadRequestException("providerBudgetUsd must be a positive number");
    }
    await authorize(req.principal, { kind: "resource_search_engagement", id, tenantId, module: "search" }, "set_scope");

    const preset = body?.scopePreset as ScopePreset | undefined;
    const seeded = seedToolScope(preset);
    // Preset seeding wins over any caller-supplied toolScope for light/standard/heavy — the whole
    // point of a preset is that IT authoritatively defines tool_scope (design §04). A caller who
    // wants a hand-tuned scope must pass scopePreset:'custom' (or omit it) with an explicit toolScope.
    const nextToolScope = seeded ?? body?.toolScope;
    if (nextToolScope === undefined && preset === undefined) {
      throw new BadRequestException("scopePreset and/or toolScope required");
    }

    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [id];
    if (preset !== undefined) { params.push(preset); sets.push(`scope_preset = $${params.length}`); }
    if (nextToolScope !== undefined) { params.push(JSON.stringify(nextToolScope)); sets.push(`tool_scope = $${params.length}`); }
    if (body?.providerBudgetUsd !== undefined) { params.push(body.providerBudgetUsd); sets.push(`provider_budget_usd = $${params.length}`); }

    const res = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query(`UPDATE search_engagements SET ${sets.join(", ")} WHERE id = $1 AND deleted_at IS NULL`, params);
        if (r.rowCount) {
          await emitEvent(c, tenantId, "search_engagement", id, "search.engagement.scope_updated", {
            scopePreset: preset ?? null, seeded: seeded !== undefined,
          });
        }
        return r;
      },
      { modules: ["search"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("engagement not found");
    await writeActivity(tenantId, req.principal.userId, "scope_updated", "search_engagement", id, { scopePreset: preset ?? null });
    return { id, scopePreset: preset ?? null, toolScope: nextToolScope ?? null };
  }

  // ============================================================== KPI TARGETS =================
  @Get("kpi-targets")
  async listKpiTargets(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("engagementId") engagementId?: string) {
    await authorize(req.principal, { kind: "resource_search_engagement", tenantId, module: "search" }, "read");
    const params: unknown[] = [];
    const clauses = ["deleted_at IS NULL"];
    if (engagementId) { params.push(engagementId); clauses.push(`engagement_id = $${params.length}`); }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, engagement_id AS "engagementId", metric_key AS "metricKey", baseline_value AS "baselineValue",
                target_value AS "targetValue", due_period AS "duePeriod", direction, created_at, updated_at
         FROM search_kpi_targets WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 500`,
        params,
      ),
      { modules: ["search"] },
    );
    return rows.rows;
  }

  @Post("kpi-targets")
  @HttpCode(201)
  async createKpiTarget(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { engagementId?: string; metricKey?: string; baselineValue?: number; targetValue?: number; duePeriod?: string; direction?: string },
  ) {
    const { engagementId, metricKey, targetValue } = body ?? {};
    if (!engagementId || !metricKey || targetValue === undefined) throw new BadRequestException("engagementId, metricKey and targetValue required");
    if (body?.direction && !KPI_DIRECTIONS.has(body.direction)) throw new BadRequestException("direction must be up|down");
    await authorize(req.principal, { kind: "resource_search_engagement", id: engagementId, tenantId, module: "search" }, "create");
    const id = newId();
    await withTenants(
      [tenantId],
      async (c) => {
        if (!(await engagementRow(c, engagementId))) throw new BadRequestException("engagementId not found in this tenant");
        await c.query(
          `INSERT INTO search_kpi_targets (id, tenant_id, engagement_id, metric_key, baseline_value, target_value, due_period, direction, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, tenantId, engagementId, metricKey, body?.baselineValue ?? null, targetValue, body?.duePeriod ?? null, body?.direction ?? "up", config.originSite],
        );
      },
      { modules: ["search"] },
    );
    await writeActivity(tenantId, req.principal.userId, "created", "search_kpi_target", id, { engagementId, metricKey });
    return { id };
  }

  @Get("kpi-targets/:id")
  async getKpiTarget(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const row = await withTenants(
      [tenantId],
      (c) => c.query<{ engagement_id: string }>(`SELECT engagement_id FROM search_kpi_targets WHERE id = $1 AND deleted_at IS NULL`, [id]),
      { modules: ["search"] },
    );
    if (!row.rows[0]) throw new NotFoundException("kpi target not found");
    await authorize(req.principal, { kind: "resource_search_engagement", id: row.rows[0].engagement_id, tenantId, module: "search" }, "read");
    const full = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, engagement_id AS "engagementId", metric_key AS "metricKey", baseline_value AS "baselineValue",
                target_value AS "targetValue", due_period AS "duePeriod", direction, created_at, updated_at
         FROM search_kpi_targets WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      ),
      { modules: ["search"] },
    );
    return full.rows[0];
  }

  @Patch("kpi-targets/:id")
  @HttpCode(200)
  async updateKpiTarget(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { baselineValue?: number; targetValue?: number; duePeriod?: string; direction?: string },
  ) {
    if (body?.direction && !KPI_DIRECTIONS.has(body.direction)) throw new BadRequestException("direction must be up|down");
    const existing = await withTenants(
      [tenantId],
      (c) => c.query<{ engagement_id: string }>(`SELECT engagement_id FROM search_kpi_targets WHERE id = $1 AND deleted_at IS NULL`, [id]),
      { modules: ["search"] },
    );
    if (!existing.rows[0]) throw new NotFoundException("kpi target not found");
    await authorize(req.principal, { kind: "resource_search_engagement", id: existing.rows[0].engagement_id, tenantId, module: "search" }, "update");
    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [id];
    if (body?.baselineValue !== undefined) { params.push(body.baselineValue); sets.push(`baseline_value = $${params.length}`); }
    if (body?.targetValue !== undefined) { params.push(body.targetValue); sets.push(`target_value = $${params.length}`); }
    if (body?.duePeriod !== undefined) { params.push(body.duePeriod); sets.push(`due_period = $${params.length}`); }
    if (body?.direction) { params.push(body.direction); sets.push(`direction = $${params.length}`); }
    const res = await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE search_kpi_targets SET ${sets.join(", ")} WHERE id = $1 AND deleted_at IS NULL`, params),
      { modules: ["search"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("kpi target not found");
    await writeActivity(tenantId, req.principal.userId, "updated", "search_kpi_target", id, body ?? {});
    return { id };
  }

  @Delete("kpi-targets/:id")
  @HttpCode(200)
  async deleteKpiTarget(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const existing = await withTenants(
      [tenantId],
      (c) => c.query<{ engagement_id: string }>(`SELECT engagement_id FROM search_kpi_targets WHERE id = $1 AND deleted_at IS NULL`, [id]),
      { modules: ["search"] },
    );
    if (!existing.rows[0]) throw new NotFoundException("kpi target not found");
    await authorize(req.principal, { kind: "resource_search_engagement", id: existing.rows[0].engagement_id, tenantId, module: "search" }, "delete");
    const res = await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE search_kpi_targets SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]),
      { modules: ["search"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("kpi target not found");
    await writeActivity(tenantId, req.principal.userId, "deleted", "search_kpi_target", id, {});
    return { ok: true };
  }

  // ============================================================== KEYWORD SETS ================
  // Cerbos resource kind for the whole keywords surface is `resource_search_keyword` (SM-03; covers
  // "sets/keywords/ranks/research" — see resource_search_keyword.yaml's own header comment). It has
  // no dedicated 'embed'/'cluster' action, so those two AI-drafting writes are gated as 'update' (a
  // re-embed/re-cluster mutates existing keyword rows, same shape as any other field edit) — the
  // same choice import (a bulk 'create') and manual keyword edits (a plain 'update') already make.
  @Get("keyword-sets")
  async listKeywordSets(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("engagementId") engagementId?: string) {
    await authorize(req.principal, { kind: "resource_search_keyword", tenantId, module: "search" }, "read");
    const params: unknown[] = [];
    const clauses = ["deleted_at IS NULL"];
    if (engagementId) { params.push(engagementId); clauses.push(`engagement_id = $${params.length}`); }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, engagement_id AS "engagementId", name, source, created_at, updated_at
         FROM search_keyword_sets WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 500`,
        params,
      ),
      { modules: ["search"] },
    );
    return rows.rows;
  }

  @Post("keyword-sets")
  @HttpCode(201)
  async createKeywordSet(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { engagementId?: string; name?: string; source?: string },
  ) {
    const { engagementId, name } = body ?? {};
    if (!engagementId || !name) throw new BadRequestException("engagementId and name required");
    if (body?.source && !KEYWORD_SET_SOURCES.has(body.source)) throw new BadRequestException("source must be client|gsc|research|ai");
    await authorize(req.principal, { kind: "resource_search_keyword", tenantId, module: "search" }, "create");
    const id = newId();
    await withTenants(
      [tenantId],
      async (c) => {
        if (!(await engagementRow(c, engagementId))) throw new BadRequestException("engagementId not found in this tenant");
        await c.query(
          `INSERT INTO search_keyword_sets (id, tenant_id, engagement_id, name, source, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, tenantId, engagementId, name, body?.source ?? "client", config.originSite],
        );
        await emitEvent(c, tenantId, "search_keyword_set", id, "search.keyword_set.created", { engagementId, name });
      },
      { modules: ["search"] },
    );
    await writeActivity(tenantId, req.principal.userId, "created", "search_keyword_set", id, { name });
    return { id };
  }

  @Get("keyword-sets/:id")
  async getKeywordSet(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "resource_search_keyword", id, tenantId, module: "search" }, "read");
    const row = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, engagement_id AS "engagementId", name, source, created_at, updated_at
         FROM search_keyword_sets WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      ),
      { modules: ["search"] },
    );
    if (!row.rows[0]) throw new NotFoundException("keyword set not found");
    return row.rows[0];
  }

  @Delete("keyword-sets/:id")
  @HttpCode(200)
  async deleteKeywordSet(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "resource_search_keyword", id, tenantId, module: "search" }, "delete");
    const res = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query(`UPDATE search_keyword_sets SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]);
        if (r.rowCount) await emitEvent(c, tenantId, "search_keyword_set", id, "search.keyword_set.deleted", {});
        return r;
      },
      { modules: ["search"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("keyword set not found");
    await writeActivity(tenantId, req.principal.userId, "deleted", "search_keyword_set", id, {});
    return { ok: true };
  }

  // ── Import (CSV / paste, design §12 SM-09) ──────────────────────────────────────────────────────
  @Post("keyword-sets/:id/import")
  @HttpCode(200)
  async importKeywords(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { text?: string; locale?: string },
  ) {
    if (!body?.text || !body.text.trim()) throw new BadRequestException("text required (CSV or one keyword per line)");
    await authorize(req.principal, { kind: "resource_search_keyword", id, tenantId, module: "search" }, "create");
    let rows: ReturnType<typeof parseKeywordImport>;
    try {
      rows = parseKeywordImport(body.text, body.locale || "id-ID");
    } catch (err) {
      // SM-32: parseKeywordImport now rejects an unterminated quoted field (UnterminatedQuoteError)
      // instead of silently mangling it — surface that as a 400 naming the problem, not a 500.
      throw new BadRequestException(err instanceof Error ? err.message : "invalid keyword import CSV");
    }
    if (rows.length === 0) throw new BadRequestException("no importable keyword rows found in text");

    const result = await withTenants(
      [tenantId],
      async (c) => {
        if (!(await keywordSetRow(c, id))) throw new NotFoundException("keyword set not found");
        // SM-32: bound cumulative keyword-set cardinality. Reject over-cap OUTRIGHT (never silently
        // truncate the import — a truncated import that returns 200 is data loss disguised as
        // success) so /embed and /cluster never have to face an uncapped set to begin with.
        const capRow = await c.query<{ count: string }>(
          `SELECT COUNT(*)::int AS count FROM search_keywords WHERE set_id = $1 AND deleted_at IS NULL`,
          [id],
        );
        const existingCount = Number(capRow.rows[0]?.count ?? 0);
        if (existingCount + rows.length > config.search.maxKeywordsPerSet) {
          throw new BadRequestException(
            `import would bring this set to ${existingCount + rows.length} keywords, exceeding the ` +
              `${config.search.maxKeywordsPerSet}-keyword cap (currently ${existingCount}, submitting ${rows.length})`,
          );
        }
        let imported = 0;
        for (const row of rows) {
          const r = await c.query(
            `INSERT INTO search_keywords (id, tenant_id, set_id, keyword, locale, origin_site)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (tenant_id, set_id, keyword, locale) DO NOTHING`,
            [newId(), tenantId, id, row.keyword, row.locale, config.originSite],
          );
          if (r.rowCount) imported++;
        }
        if (imported > 0) await emitEvent(c, tenantId, "search_keyword_set", id, "search.keywords.imported", { imported, submitted: rows.length });
        return { imported, submitted: rows.length, duplicates: rows.length - imported };
      },
      { modules: ["search"] },
    );
    await writeActivity(tenantId, req.principal.userId, "imported", "search_keyword_set", id, result);
    return result;
  }

  @Get("keyword-sets/:id/keywords")
  async listKeywords(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "resource_search_keyword", id, tenantId, module: "search" }, "read");
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        // SM-14 AC4 (tracker §6j): widened to expose metrics_provider/metrics_simulated (0048) so a
        // vendor-sourced volume/difficulty/cpc value never renders without its provenance badge —
        // the exact gap SM-36's carried AC left open (no writer existed to make these columns worth
        // selecting until this ticket). NULL metricsProvider is the honest "never pulled" state, same
        // as NULL volume already was; never defaulted to a guessed vendor.
        `SELECT id, keyword, locale, intent, cluster_id AS "clusterId", cluster_label AS "clusterLabel",
                volume, difficulty, cpc_usd AS "cpcUsd", is_tracked AS "isTracked",
                metrics_provider AS "metricsProvider", metrics_simulated AS "metricsSimulated",
                (embedding IS NOT NULL) AS "hasEmbedding", created_at, updated_at
         FROM search_keywords WHERE set_id = $1 AND deleted_at IS NULL
         ORDER BY keyword ASC, id ASC LIMIT 5000`,
        [id],
      ),
      { modules: ["search"] },
    );
    return rows.rows;
  }

  @Patch("keywords/:id")
  @HttpCode(200)
  async updateKeyword(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { intent?: string | null; clusterLabel?: string | null; isTracked?: boolean },
  ) {
    if (body?.intent !== undefined && body.intent !== null && !(INTENTS as readonly string[]).includes(body.intent)) {
      throw new BadRequestException("intent must be one of informational|commercial|transactional|navigational");
    }
    const existing = await withTenants(
      [tenantId],
      (c) => keywordRow(c, id),
      { modules: ["search"] },
    );
    if (!existing) throw new NotFoundException("keyword not found");
    await authorize(req.principal, { kind: "resource_search_keyword", id, tenantId, module: "search" }, "update");
    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [id];
    if (body?.intent !== undefined) { params.push(body.intent); sets.push(`intent = $${params.length}`); }
    if (body?.clusterLabel !== undefined) { params.push(body.clusterLabel); sets.push(`cluster_label = $${params.length}`); }
    if (body?.isTracked !== undefined) { params.push(body.isTracked); sets.push(`is_tracked = $${params.length}`); }
    const res = await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE search_keywords SET ${sets.join(", ")} WHERE id = $1 AND deleted_at IS NULL`, params),
      { modules: ["search"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("keyword not found");
    await writeActivity(tenantId, req.principal.userId, "updated", "search_keyword", id, body ?? {});
    return { id };
  }

  @Delete("keywords/:id")
  @HttpCode(200)
  async deleteKeyword(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const existing = await withTenants([tenantId], (c) => keywordRow(c, id), { modules: ["search"] });
    if (!existing) throw new NotFoundException("keyword not found");
    await authorize(req.principal, { kind: "resource_search_keyword", id, tenantId, module: "search" }, "delete");
    const res = await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE search_keywords SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]),
      { modules: ["search"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("keyword not found");
    await writeActivity(tenantId, req.principal.userId, "deleted", "search_keyword", id, {});
    return { ok: true };
  }

  // ============================================================== RANK TRACKING (SM-14) =========
  // First real caller of providers/dispatch.ts's dispatchProviderOp (tracker §6j/§6l) — every route
  // below routes through it, so every one of these is a genuine spend action gated by the SAME
  // fail-closed stop-loss as every other provider op. Cerbos: `resource_search_keyword`'s own header
  // comment names it as covering "sets/keywords/ranks/research" — the 'research' action is the
  // paid-pull action, distinct from plain 'read'/'update'.
  @Post("engagements/:id/rank-pull")
  @HttpCode(200)
  async pullRanks(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { keywordIds?: string[] },
  ) {
    await authorize(req.principal, { kind: "resource_search_keyword", tenantId, module: "search" }, "research");
    const { engagement, keywords } = await withTenants(
      [tenantId],
      async (c) => {
        const eng = await engagementRow(c, id);
        if (!eng) throw new NotFoundException("engagement not found");
        const params: unknown[] = [id];
        let idFilter = "";
        if (body?.keywordIds?.length) {
          for (const kwId of body.keywordIds) assertUuid(kwId, "keywordId");
          params.push(body.keywordIds);
          idFilter = ` AND k.id = ANY($${params.length})`;
        }
        const rows = await c.query<{ id: string; keyword: string; locale: string }>(
          `SELECT k.id, k.keyword, k.locale FROM search_keywords k
             JOIN search_keyword_sets s ON s.id = k.set_id
            WHERE s.engagement_id = $1 AND k.is_tracked = true AND k.deleted_at IS NULL${idFilter}
            ORDER BY k.keyword ASC`,
          params,
        );
        return { engagement: eng, keywords: rows.rows };
      },
      { modules: ["search"] },
    );
    if (keywords.length === 0) {
      return { engagementId: id, propertyId: engagement.propertyId, attempted: 0, pulled: 0, skipped: 0, failed: 0, results: [] };
    }
    const property = await withTenants([tenantId], (c) => propertyDomainRow(c, engagement.propertyId), { modules: ["search"] });
    if (!property) throw new NotFoundException("property not found");

    const result = await pullRanksForEngagement({
      tenantId, engagementId: id, propertyId: engagement.propertyId, propertyDomain: property.domain,
      keywords: keywords.map((k) => ({ keywordId: k.id, keyword: k.keyword, locale: k.locale })),
      requestedBy: req.principal.userId, correlationId: req.principal.userId,
    });
    await writeActivity(tenantId, req.principal.userId, "rank_pull", "search_engagement", id, {
      attempted: result.attempted, pulled: result.pulled, skipped: result.skipped, failed: result.failed,
    });
    return result;
  }

  // Keyword-metrics (volume/difficulty/cpc) pull for a whole set, or a filtered subset — the
  // "keyword-metrics writer" tracker §6j's AC2 requires (discharges SM-36's carried-forward AC).
  @Post("keyword-sets/:id/metrics-pull")
  @HttpCode(200)
  async pullKeywordMetrics(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { keywordIds?: string[] },
  ) {
    await authorize(req.principal, { kind: "resource_search_keyword", id, tenantId, module: "search" }, "research");
    const { engagementId, keywords } = await withTenants(
      [tenantId],
      async (c) => {
        const set = await keywordSetRow(c, id);
        if (!set) throw new NotFoundException("keyword set not found");
        const params: unknown[] = [id];
        let idFilter = "";
        if (body?.keywordIds?.length) {
          for (const kwId of body.keywordIds) assertUuid(kwId, "keywordId");
          params.push(body.keywordIds);
          idFilter = ` AND id = ANY($${params.length})`;
        }
        const rows = await c.query<{ id: string; keyword: string; locale: string }>(
          `SELECT id, keyword, locale FROM search_keywords
            WHERE set_id = $1 AND deleted_at IS NULL${idFilter}
            ORDER BY keyword ASC`,
          params,
        );
        return { engagementId: set.engagementId, keywords: rows.rows };
      },
      { modules: ["search"] },
    );
    if (keywords.length === 0) {
      return { attempted: 0, updated: 0, absent: 0, skipped: 0, failed: 0, results: [] };
    }
    const engagement = await withTenants([tenantId], (c) => engagementRow(c, engagementId), { modules: ["search"] });

    const result = await pullMetricsForKeywords({
      tenantId, engagementId, propertyId: engagement?.propertyId ?? null,
      keywords: keywords.map((k) => ({ keywordId: k.id, keyword: k.keyword, locale: k.locale })),
      requestedBy: req.principal.userId, correlationId: req.principal.userId,
    });
    await writeActivity(tenantId, req.principal.userId, "metrics_pull", "search_keyword_set", id, {
      attempted: result.attempted, updated: result.updated, absent: result.absent, skipped: result.skipped, failed: result.failed,
    });
    return result;
  }

  // Rank-history reader (AC5: "any new reader it adds states its mode handling — per-property rank
  // history badges per row rather than filtering"). Deliberately UNFILTERED by current mode: unlike
  // the exec rollup / client-report COUNTs (SM-46a/b), this is a raw history list where every row
  // already carries its OWN `simulated` flag for the console to badge — filtering it would just make
  // half the property's real capture history silently vanish the moment the platform mode flips.
  @Get("properties/:id/rank-snapshots")
  async listRankSnapshots(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Query("keywordId") keywordId?: string, @Query("engine") engine?: string,
    @Query("device") device?: string, @Query("limit") limitParam?: string,
  ) {
    await authorize(req.principal, { kind: "resource_search_keyword", tenantId, module: "search" }, "read");
    if (keywordId) assertUuid(keywordId, "keywordId");
    const limit = Math.min(Math.max(Number(limitParam) || 200, 1), 2000);
    const rows = await withTenants(
      [tenantId],
      async (c) => {
        if (!(await propertyRow(c, id))) throw new NotFoundException("property not found");
        const params: unknown[] = [id];
        const clauses = ["rn.property_id = $1"];
        if (keywordId) { params.push(keywordId); clauses.push(`rn.keyword_id = $${params.length}`); }
        if (engine) { params.push(engine); clauses.push(`rn.engine = $${params.length}`); }
        if (device) { params.push(device); clauses.push(`rn.device = $${params.length}`); }
        params.push(limit);
        return c.query(
          `SELECT rn.id, rn.keyword_id AS "keywordId", k.keyword, rn.engine, rn.device,
                  rn.location_code AS "locationCode", rn.captured_at AS "capturedAt", rn.position,
                  rn.ranked_url AS "rankedUrl", rn.serp_features AS "serpFeatures", rn.provider, rn.simulated
             FROM search_rank_snapshots rn
             JOIN search_keywords k ON k.id = rn.keyword_id
            WHERE ${clauses.join(" AND ")}
            ORDER BY rn.captured_at DESC LIMIT $${params.length}`,
          params,
        );
      },
      { modules: ["search"] },
    );
    return rows.rows;
  }

  // Standard-queue completion callback (AC5: "the Standard-queue completion callback n8n will hit").
  // DataForSEO's own postback carries a TASK ID ONLY and is never trusted as data (design §02/§03,
  // dataforseo.ts's file header); n8n relays it into THIS platform route, which performs the actual
  // authoritative work. LIMITATION, stated plainly: SearchDataProvider has no task-id-keyed re-fetch
  // method (only postSerpTasks+fetchSerpResults as one bundled call, invokeProvider in dispatch.ts) —
  // adding one is a providers/* change outside this ticket's file ownership. So this route re-runs
  // the SAME single-keyword dispatch path a manual pull uses (still through every scope/budget/
  // pillar gate — n8n gets no bypass), rather than a free fetch-by-task-id. search_rank_snapshots is
  // append-only by design (0034), so a callback firing is a genuine new capture, not a duplicate.
  @Post("rank-pulls/callback")
  @HttpCode(200)
  async rankPullCallback(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { engagementId?: string; propertyId?: string; keywordId?: string; taskId?: string },
  ) {
    const { engagementId, propertyId, keywordId } = body ?? {};
    if (!engagementId || !propertyId || !keywordId) {
      throw new BadRequestException("engagementId, propertyId and keywordId required");
    }
    assertUuid(engagementId, "engagementId");
    assertUuid(propertyId, "propertyId");
    assertUuid(keywordId, "keywordId");
    await authorize(req.principal, { kind: "resource_search_keyword", id: keywordId, tenantId, module: "search" }, "research");

    const ctx = await withTenants(
      [tenantId],
      async (c) => {
        const kw = await keywordDetailRow(c, keywordId);
        if (!kw) throw new NotFoundException("keyword not found");
        const set = await keywordSetRow(c, kw.setId);
        if (!set || set.engagementId !== engagementId) throw new BadRequestException("keywordId does not belong to engagementId");
        const eng = await engagementRow(c, engagementId);
        if (!eng || eng.propertyId !== propertyId) throw new BadRequestException("engagementId does not belong to propertyId");
        const property = await propertyDomainRow(c, propertyId);
        if (!property) throw new NotFoundException("property not found");
        return { keyword: kw, propertyDomain: property.domain };
      },
      { modules: ["search"] },
    );

    const outcome = await pullRankForKeyword({
      tenantId, engagementId, propertyId, propertyDomain: ctx.propertyDomain,
      keyword: { keywordId, keyword: ctx.keyword.keyword, locale: ctx.keyword.locale },
      requestedBy: req.principal.userId, correlationId: body.taskId ?? null,
    });
    return outcome;
  }

  // ============================================== SM-16: BACKLINKS + GEO/AI-VISIBILITY ==========
  // Cerbos kind is `resource_search_audit` (design §11: "audits/findings/backlinks/ai-visibility"),
  // same kind the Site-Audit routes above use. That policy's action set is read/create/update/
  // delete/run (resource_search_audit.yaml) — it has no dedicated "research" action the way
  // resource_search_keyword does for rank/metrics pulls (design never lists one; §12's own action
  // legend gates these two buttons on "budget stop-loss" only, not on a named extra permission), so
  // a pull — a genuinely NEW snapshot row, exactly like ingestAudit's own "create" above — is
  // authorized as `create`, and a listing as `read`. This stays inside cerbos/policies' EXISTING
  // action set; no policy file is touched by this ticket.
  @Post("engagements/:id/backlinks-pull")
  @HttpCode(200)
  async pullBacklinks(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "resource_search_audit", tenantId, module: "search" }, "create");
    const ctx = await withTenants(
      [tenantId],
      async (c) => {
        const eng = await engagementRow(c, id);
        if (!eng) throw new NotFoundException("engagement not found");
        const property = await propertyDomainRow(c, eng.propertyId);
        if (!property) throw new NotFoundException("property not found");
        return { propertyId: eng.propertyId, propertyDomain: property.domain };
      },
      { modules: ["search"] },
    );
    const outcome = await pullBacklinksForProperty({
      tenantId, engagementId: id, propertyId: ctx.propertyId, propertyDomain: ctx.propertyDomain,
      requestedBy: req.principal.userId, correlationId: req.principal.userId,
    });
    await writeActivity(tenantId, req.principal.userId, "backlinks_pull", "search_property", ctx.propertyId, {
      backlinks: outcome.backlinks, refDomains: outcome.refDomains, lostSpike: outcome.lostSpike,
    });
    return outcome;
  }

  // Backlink-history reader — deliberately UNFILTERED by current mode, same reasoning as
  // listRankSnapshots above (AC4: "per-property history badges per row rather than filtering"): this
  // is a raw snapshot log where every row already carries its OWN `simulated`/`provider` flag for the
  // console to badge, so filtering here would make half the property's real capture history silently
  // vanish the moment the platform mode flips. Any future COUNT/aggregate reader over this table
  // (there is none yet — 0048's own header note) would need the OPPOSITE (mode-filtered) treatment.
  @Get("properties/:id/backlinks")
  async listBacklinks(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Query("limit") limitParam?: string,
  ) {
    await authorize(req.principal, { kind: "resource_search_audit", tenantId, module: "search" }, "read");
    const limit = Math.min(Math.max(Number(limitParam) || 200, 1), 2000);
    const rows = await withTenants(
      [tenantId],
      async (c) => {
        if (!(await propertyRow(c, id))) throw new NotFoundException("property not found");
        return c.query(
          `SELECT id, captured_at AS "capturedAt", totals, new_links AS "newLinks", lost_links AS "lostLinks",
                  provider, simulated
             FROM search_backlink_snapshots
            WHERE property_id = $1
            ORDER BY captured_at DESC LIMIT $2`,
          [id, limit],
        );
      },
      { modules: ["search"] },
    );
    return rows.rows;
  }

  // GEO/AI-visibility pull. `queries` in the body OVERRIDES the engagement's scope-configured list
  // (`tool_scope.ai_visibility.queries`) for a one-off/ad-hoc pull; with no body override the
  // scheduled-flow shape applies — cadence AND the query list both come from tool_scope, never
  // hardcoded here (design D-11 / SM-15 §2's "flows are mode-blind, scope-driven" rule extends to
  // WHAT gets pulled, not just when).
  @Post("engagements/:id/ai-visibility-pull")
  @HttpCode(200)
  async pullAiVisibility(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { queries?: string[] },
  ) {
    await authorize(req.principal, { kind: "resource_search_audit", tenantId, module: "search" }, "create");
    const ctx = await withTenants(
      [tenantId],
      async (c) => {
        const eng = await engagementScopeRow(c, id);
        if (!eng) throw new NotFoundException("engagement not found");
        return eng;
      },
      { modules: ["search"] },
    );
    let queries = body?.queries;
    if (queries !== undefined) {
      if (!Array.isArray(queries) || queries.some((q) => typeof q !== "string" || !q.trim())) {
        throw new BadRequestException("queries must be a non-empty array of strings");
      }
    } else {
      const scopeQueries = (ctx.toolScope.ai_visibility as { queries?: unknown } | undefined)?.queries;
      queries = Array.isArray(scopeQueries) ? scopeQueries.filter((q): q is string => typeof q === "string") : [];
    }
    if (queries.length === 0) {
      return { propertyId: ctx.propertyId, attempted: 0, pulled: 0, skipped: 0, failed: 0, results: [] };
    }

    const result = await pullAiVisibilityForProperty({
      tenantId, engagementId: id, propertyId: ctx.propertyId, queries,
      requestedBy: req.principal.userId, correlationId: req.principal.userId,
    });
    await writeActivity(tenantId, req.principal.userId, "ai_visibility_pull", "search_property", ctx.propertyId, {
      attempted: result.attempted, pulled: result.pulled, skipped: result.skipped, failed: result.failed,
    });
    return result;
  }

  // AI-visibility history reader — same badge-not-filter shape as listBacklinks/listRankSnapshots
  // above (AC4). Optional `engine`/`query` filters narrow the raw log for the GEO console's
  // per-engine comparison view; neither filters on `simulated`.
  @Get("properties/:id/ai-visibility")
  async listAiVisibility(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Query("engine") engine?: string, @Query("query") query?: string, @Query("limit") limitParam?: string,
  ) {
    await authorize(req.principal, { kind: "resource_search_audit", tenantId, module: "search" }, "read");
    const limit = Math.min(Math.max(Number(limitParam) || 200, 1), 2000);
    const rows = await withTenants(
      [tenantId],
      async (c) => {
        if (!(await propertyRow(c, id))) throw new NotFoundException("property not found");
        const params: unknown[] = [id];
        const clauses = ["property_id = $1"];
        if (engine) { params.push(engine); clauses.push(`engine = $${params.length}`); }
        if (query) { params.push(query); clauses.push(`query = $${params.length}`); }
        params.push(limit);
        return c.query(
          `SELECT id, captured_at AS "capturedAt", engine, query, brand_mentioned AS "brandMentioned",
                  cited, cited_url AS "citedUrl", prominence, provider, simulated
             FROM search_ai_visibility
            WHERE ${clauses.join(" AND ")}
            ORDER BY captured_at DESC LIMIT $${params.length}`,
          params,
        );
      },
      { modules: ["search"] },
    );
    return rows.rows;
  }

  // ── AI: /embed embeddings + dual-mode clustering + Hermes intent/labels (SM-09; design §01/§07 —
  // ai-gateway-go is the ONLY AI egress path, never a vendor SDK or direct provider call) ──────────
  @Post("keyword-sets/:id/embed")
  @HttpCode(200)
  async embedKeywords(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { onlyMissing?: boolean },
  ) {
    await authorize(req.principal, { kind: "resource_search_keyword", id, tenantId, module: "search" }, "update");
    const result = await withTenants(
      [tenantId],
      async (c) => {
        if (!(await keywordSetRow(c, id))) throw new NotFoundException("keyword set not found");
        let r;
        try {
          r = await embedKeywordSet(c, id, { onlyMissing: body?.onlyMissing });
        } catch (err) {
          // SM-32: refuse an over-cap set rather than looping unbounded.
          if (err instanceof KeywordSetTooLargeError) throw new BadRequestException(err.message);
          throw err;
        }
        if (r.embedded > 0) await emitEvent(c, tenantId, "search_keyword_set", id, "search.keywords.embedded", { embedded: r.embedded, mode: r.mode });
        return r;
      },
      { modules: ["search"] },
    );
    await writeActivity(tenantId, req.principal.userId, "embedded", "search_keyword_set", id, { mode: result.mode, embedded: result.embedded });
    return result;
  }

  @Post("keyword-sets/:id/cluster")
  @HttpCode(200)
  async clusterKeywords(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { threshold?: number },
  ) {
    if (body?.threshold !== undefined && !(body.threshold > 0 && body.threshold <= 1)) {
      throw new BadRequestException("threshold must be a number in (0, 1]");
    }
    await authorize(req.principal, { kind: "resource_search_keyword", id, tenantId, module: "search" }, "update");
    const result = await withTenants(
      [tenantId],
      async (c) => {
        if (!(await keywordSetRow(c, id))) throw new NotFoundException("keyword set not found");
        let r;
        try {
          r = await clusterKeywordSet(c, id, { threshold: body?.threshold });
        } catch (err) {
          // SM-32: refuse an over-cap set rather than looping unbounded.
          if (err instanceof KeywordSetTooLargeError) throw new BadRequestException(err.message);
          throw err;
        }
        await emitEvent(c, tenantId, "search_keyword_set", id, "search.keywords.clustered", {
          clusters: r.clusters.length, skipped: r.skipped, mode: r.mode,
        });
        return r;
      },
      { modules: ["search"] },
    );
    await writeActivity(tenantId, req.principal.userId, "clustered", "search_keyword_set", id, {
      clusters: result.clusters.length, skipped: result.skipped,
    });
    return result;
  }

  // ============================================================== AUDITS + FINDINGS (SM-08) =====
  // Cerbos kind is `resource_search_audit` (design §11: "audits/findings/backlinks/ai-visibility").
  // Ingest is a 'create' (a new audit + finding rows), NOT a 'run' — 'run' is SM-07's job-trigger
  // action (dispatching a crawl); this endpoint only ingests a report that ALREADY exists (ticket
  // MUST HOLD: ingest is not a crawl trigger, no network calls happen here).
  @Get("audits")
  async listAudits(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("propertyId") propertyId?: string, @Query("kind") kind?: string, @Query("status") status?: string,
  ) {
    await authorize(req.principal, { kind: "resource_search_audit", tenantId, module: "search" }, "read");
    const params: unknown[] = [];
    const clauses = ["deleted_at IS NULL"];
    if (propertyId) { params.push(propertyId); clauses.push(`property_id = $${params.length}`); }
    if (kind) { params.push(kind); clauses.push(`kind = $${params.length}`); }
    if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, property_id AS "propertyId", kind, source, status, score, summary, ai_summary AS "aiSummary",
                started_at AS "startedAt", completed_at AS "completedAt", created_at, updated_at
         FROM search_audits WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 500`,
        params,
      ),
      { modules: ["search"] },
    );
    return rows.rows;
  }

  // Ingests a raw crawl Report (search-crawl-go's `Report` — see search-audit.ts's header for the
  // exact input contract) into `search_audits` + `search_audit_findings`, then diffs against the
  // previous completed audit of the same property+kind (design §04 regression semantics).
  //
  // IDEMPOTENCY (MUST HOLD): `report_hash` (0045 migration) + a UNIQUE(tenant_id, property_id, kind,
  // report_hash) DB constraint is the enforcement point — re-posting byte-identical (or
  // canonically-identical) report content for the same property+kind is a no-op that returns the
  // EXISTING audit id (`idempotent: true`), never a duplicate row or a re-run of the diff/events.
  @Post("audits")
  @HttpCode(201)
  async ingestAudit(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { propertyId?: string; kind?: string; source?: string; report?: unknown },
  ) {
    const { propertyId, kind, source } = body ?? {};
    if (!propertyId || !kind || !source) throw new BadRequestException("propertyId, kind and source required");
    if (!AUDIT_KIND_SET.has(kind)) throw new BadRequestException("kind must be technical|cwv|content|links|geo");
    if (!AUDIT_SOURCE_SET.has(source)) throw new BadRequestException("source must be seonaut|crawler|unlighthouse|ai");
    if (!INGESTABLE_SOURCES.has(source)) {
      throw new BadRequestException(`no ingest adapter implemented for source '${source}' yet`);
    }
    // Validation runs fully BEFORE any DB write starts (hostile-input MUST HOLD: malformed/oversized
    // input is refused with a 400, never a partial write) — validateCrawlerReport throws synchronously.
    let report;
    try {
      report = validateCrawlerReport(body?.report);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : "invalid report");
    }

    await authorize(req.principal, { kind: "resource_search_audit", tenantId, module: "search" }, "create");

    const reportHash = hashReport(kind, source, report);
    const findings = deriveFindings(report);
    const summary = severitySummary(findings);
    const score = computeScore(findings);
    const startedAt = report.startedAt ?? new Date().toISOString();
    const completedAt = report.finishedAt ?? new Date().toISOString();

    const result = await withTenants(
      [tenantId],
      async (c) => {
        if (!(await propertyRow(c, propertyId))) throw new BadRequestException("propertyId not found in this tenant");

        // Previous completed audit of the SAME property+kind, resolved BEFORE inserting the new
        // row (so it can never resolve to the row we are about to create).
        const prevAudit = await c.query<{ id: string }>(
          `SELECT id FROM search_audits WHERE property_id = $1 AND kind = $2 AND status = 'completed' AND deleted_at IS NULL
           ORDER BY completed_at DESC NULLS LAST, created_at DESC LIMIT 1`,
          [propertyId, kind],
        );
        const prevAuditId = prevAudit.rows[0]?.id ?? null;

        const newAuditId = newId();
        const insertRes = await c.query(
          `INSERT INTO search_audits
             (id, tenant_id, property_id, kind, source, status, score, summary, started_at, completed_at, report_hash, origin_site)
           VALUES ($1,$2,$3,$4,$5,'completed',$6,$7,$8,$9,$10,$11)
           ON CONFLICT (tenant_id, property_id, kind, report_hash) DO NOTHING
           RETURNING id`,
          [newAuditId, tenantId, propertyId, kind, source, score, JSON.stringify(summary), startedAt, completedAt, reportHash, config.originSite],
        );
        if (insertRes.rowCount === 0) {
          // Idempotent re-run: an identical report for this property+kind was already ingested.
          const existing = await c.query<{ id: string }>(
            `SELECT id FROM search_audits WHERE property_id = $1 AND kind = $2 AND report_hash = $3 AND deleted_at IS NULL`,
            [propertyId, kind, reportHash],
          );
          return { id: existing.rows[0].id, idempotent: true, findings: findings.length, regressed: [] as string[] };
        }

        // The diff needs each code's CURRENT logical state, not just what's on the immediately-
        // previous audit row: a code that went 'fixed' N audits ago and hasn't reappeared since has
        // no row on the immediately-previous audit at all (a "still fixed, nothing to report" code
        // gets no new row per ingest — see the toFix branch below), so scoping to prevAuditId alone
        // would forget that history and treat its reappearance as brand-new instead of a regression.
        // DISTINCT ON (code) ordered by the OWNING audit's recency picks each code's latest row
        // across every prior audit of this property+kind.
        const prevFindings: PrevFindingRow[] = (
          await c.query<{ id: string; code: string; status: string; first_seen_audit_id: string | null }>(
            `SELECT DISTINCT ON (saf.code) saf.id, saf.code, saf.status, saf.first_seen_audit_id
               FROM search_audit_findings saf
               JOIN search_audits sa ON sa.id = saf.audit_id
              WHERE sa.property_id = $1 AND sa.kind = $2
              ORDER BY saf.code, sa.completed_at DESC NULLS LAST, sa.created_at DESC, saf.created_at DESC`,
            [propertyId, kind],
          )
        ).rows.map((r) => ({ id: r.id, code: r.code, status: r.status, firstSeenAuditId: r.first_seen_audit_id }));

        const plan = diffAudits(findings, prevFindings, prevAuditId);

        for (const fixedId of plan.toFix) {
          await c.query(`UPDATE search_audit_findings SET status = 'fixed', updated_at = now() WHERE id = $1`, [fixedId]);
        }
        for (let i = 0; i < findings.length; i++) {
          const f = findings[i];
          const ins = plan.toInsert[i];
          await c.query(
            `INSERT INTO search_audit_findings
               (id, tenant_id, audit_id, code, severity, category, message, url_count, sample_urls, status,
                first_seen_audit_id, last_seen_audit_id, origin_site)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [
              newId(), tenantId, newAuditId, f.code, f.severity, f.category, f.message, f.urlCount, JSON.stringify(f.sampleUrls),
              ins.status, ins.firstSeenAuditId ?? newAuditId, newAuditId, config.originSite,
            ],
          );
        }

        await emitEvent(c, tenantId, "search_audit", newAuditId, "search.audit.completed", {
          propertyId, kind, source, score, summary, findings: findings.length,
        });
        if (plan.regressedCodes.length > 0) {
          await emitEvent(c, tenantId, "search_audit", newAuditId, "search.audit.regression", {
            propertyId, kind, codes: plan.regressedCodes,
          });
        }

        return { id: newAuditId, idempotent: false, findings: findings.length, regressed: plan.regressedCodes };
      },
      { modules: ["search"] },
    );
    await writeActivity(tenantId, req.principal.userId, result.idempotent ? "ingest_noop" : "ingested", "search_audit", result.id, {
      propertyId, kind, source, idempotent: result.idempotent,
    });
    return result;
  }

  @Get("audits/:id/findings")
  async listAuditFindings(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Query("status") status?: string,
  ) {
    const audit = await withTenants([tenantId], (c) => auditRow(c, id), { modules: ["search"] });
    if (!audit) throw new NotFoundException("audit not found");
    await authorize(req.principal, { kind: "resource_search_audit", id, tenantId, module: "search" }, "read");
    const params: unknown[] = [id];
    const clauses = ["audit_id = $1"];
    if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, audit_id AS "auditId", code, severity, category, message, url_count AS "urlCount",
                sample_urls AS "sampleUrls", status, first_seen_audit_id AS "firstSeenAuditId",
                last_seen_audit_id AS "lastSeenAuditId", ai_fix_suggestion AS "aiFixSuggestion",
                ai_drafted_at AS "aiDraftedAt", created_at, updated_at
         FROM search_audit_findings WHERE ${clauses.join(" AND ")}
         ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END, created_at DESC
         LIMIT 1000`,
        params,
      ),
      { modules: ["search"] },
    );
    return rows.rows;
  }

  // Manual triage (design §12 "findings triage workflow"): open -> fixed|ignored, or explicitly
  // reopened (fixed|ignored -> open). 'regressed' is system-derived only (the diff pass above) —
  // never a caller-supplied target here, so a human can't fake a regression event.
  @Patch("findings/:id")
  @HttpCode(200)
  async triageFinding(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { status?: string },
  ) {
    if (!body?.status || !AUDIT_TRIAGE_STATUS_SET.has(body.status)) {
      throw new BadRequestException("status must be open|fixed|ignored");
    }
    const finding = await withTenants([tenantId], (c) => findingRow(c, id), { modules: ["search"] });
    if (!finding) throw new NotFoundException("finding not found");
    const audit = await withTenants([tenantId], (c) => auditRow(c, finding.auditId), { modules: ["search"] });
    if (!audit) throw new NotFoundException("finding not found");
    await authorize(req.principal, { kind: "resource_search_audit", id: finding.auditId, tenantId, module: "search" }, "update");
    const res = await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE search_audit_findings SET status = $2, updated_at = now() WHERE id = $1`, [id, body.status]),
      { modules: ["search"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("finding not found");
    await writeActivity(tenantId, req.principal.userId, "triaged", "search_audit_finding", id, { status: body.status });
    return { id, status: body.status };
  }

  // AI-drafted finding triage + fix suggestions (design §07 row: "Audit-finding triage & fix
  // drafts | Hermes | Post-audit | Summary + prioritized fix list on the audit"; also covers
  // "meta/title/on-page suggestions" — see migration 0046's header for why those share one column,
  // there is no separate console action or table for them). ONE completeViaGateway call per
  // request (never one per finding — that would reintroduce the SM-32 unbounded-loop shape),
  // findings capped to MAX_TRIAGE_FINDINGS, the call itself made OUTSIDE any withTenants
  // transaction (bracketed by two short, network-free DB calls) so no connection is ever held open
  // across the network round trip.
  @Post("audits/:id/ai-triage")
  @HttpCode(200)
  async aiTriageAudit(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const audit = await withTenants([tenantId], (c) => auditRow(c, id), { modules: ["search"] });
    if (!audit) throw new NotFoundException("audit not found");
    await authorize(req.principal, { kind: "resource_search_audit", id, tenantId, module: "search" }, "update");

    const findingsRes = await withTenants(
      [tenantId],
      (c) =>
        c.query<{ code: string; severity: string; category: string | null; message: string; url_count: number }>(
          `SELECT code, severity, category, message, url_count
             FROM search_audit_findings
            WHERE audit_id = $1 AND status IN ('open','regressed')
            ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END, created_at DESC
            LIMIT $2`,
          [id, MAX_TRIAGE_FINDINGS],
        ),
      { modules: ["search"] },
    );
    const facts: TriageFindingFact[] = findingsRes.rows.map((f) => ({
      code: f.code, severity: f.severity, category: f.category, message: f.message, urlCount: f.url_count,
    }));

    let draft: { summary: string; fixes: { code: string; suggestion: string }[] };
    let draftedVia: "ai" | "fallback";
    let model: string | null = null;
    if (facts.length === 0) {
      draft = { summary: "No open findings to triage.", fixes: [] };
      draftedVia = "fallback";
    } else {
      try {
        const completion = await completeViaGateway(buildTriagePrompt(facts));
        model = completion.provider ?? null;
        ({ draft, draftedVia } = parseTriageDraft(completion.text, facts));
      } catch {
        ({ draft, draftedVia } = parseTriageDraft(null, facts));
      }
    }

    // Phase 2 (short, network-free transaction): persist. `fix.code` is used ONLY as a WHERE-match
    // against rows already scoped to audit_id=$1 (both bound params, never string-built from AI
    // output) — parseTriageDraft already dropped any code outside `facts`, and this WHERE clause is
    // a second, independent enforcement of the same rule. Only the free-text ai_fix_suggestion
    // column is ever written here — `status` is never touched by this endpoint (MUST HOLD).
    await withTenants(
      [tenantId],
      async (c) => {
        await c.query(`UPDATE search_audits SET ai_summary = $2, updated_at = now() WHERE id = $1`, [id, draft.summary]);
        for (const fix of draft.fixes) {
          await c.query(
            `UPDATE search_audit_findings SET ai_fix_suggestion = $3, ai_drafted_at = now() WHERE audit_id = $1 AND code = $2`,
            [id, fix.code, fix.suggestion],
          );
        }
      },
      { modules: ["search"] },
    );
    await writeActivity(tenantId, req.principal.userId, "ai_triaged", "search_audit", id, { draftedVia, fixCount: draft.fixes.length });
    return { id, aiSummary: draft.summary, fixes: draft.fixes, draftedVia, model };
  }

  // ============================================================== CONTENT BRIEFS (SM-10) ========
  // Cerbos rides the EXISTING resource_search_property policy (read/create/update actions already
  // granted to module_staff/module_manager/company_admin, SM-03) rather than a new resource kind —
  // see migration 0046's header for why. `search:brief:write` (already in the module's permission
  // list) is the registry/UI-facing label for the same create/update actions, matching the
  // resource_search_property.yaml precedent of bundling several permission labels onto one kind.
  @Get("properties/:id/briefs")
  async listBriefs(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const property = await withTenants([tenantId], (c) => propertyRow(c, id), { modules: ["search"] });
    if (!property) throw new NotFoundException("property not found");
    await authorize(req.principal, { kind: "resource_search_property", id, tenantId, module: "search" }, "read");
    const rows = await withTenants(
      [tenantId],
      (c) =>
        c.query(
          `SELECT id, property_id AS "propertyId", topic, status, outline, body, geo_notes AS "geoNotes",
                  grounding, model, drafted_via AS "draftedVia", polished_at AS "polishedAt",
                  created_by AS "createdBy", created_at, updated_at
             FROM search_content_briefs WHERE property_id = $1 AND deleted_at IS NULL
             ORDER BY created_at DESC LIMIT 500`,
          [id],
        ),
      { modules: ["search"] },
    );
    return rows.rows;
  }

  // AI-drafts a content brief grounded in THIS property's own crawl+keyword data (design §12
  // SM-10). Grounding facts come straight from search_audit_findings/search_keywords (bounded,
  // MAX_BRIEF_FINDINGS/MAX_BRIEF_KEYWORDS) — the module's own derived DB rows, not a fabrication —
  // and are ALSO best-effort ingested into WS8 knowledge (ACL-scoped to the property id) and
  // immediately queried back via knowledge.search (design §07: "RAG over the property's crawled
  // content via WS8 knowledge.search", D9: WS8 stays sole owner of the retrieval index). The
  // knowledge round trip and the ONE completeViaGateway call both run OUTSIDE any withTenants
  // transaction — no DB connection is ever held open across a network call here.
  @Post("properties/:id/briefs")
  @HttpCode(201)
  async draftBrief(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { topic?: string },
  ) {
    const topic = typeof body?.topic === "string" ? body.topic.trim() : "";
    if (!topic) throw new BadRequestException("topic required");
    await authorize(req.principal, { kind: "resource_search_property", id, tenantId, module: "search" }, "create");

    const grounded = await withTenants(
      [tenantId],
      async (c) => {
        const propRes = await c.query<{ domain: string }>(`SELECT domain FROM search_properties WHERE id = $1 AND deleted_at IS NULL`, [id]);
        if (!propRes.rows[0]) return null;
        const findings = await c.query<{ code: string; severity: string; category: string | null; message: string }>(
          `SELECT saf.code, saf.severity, saf.category, saf.message
             FROM search_audit_findings saf
             JOIN search_audits sa ON sa.id = saf.audit_id
            WHERE sa.property_id = $1 AND saf.status IN ('open','regressed') AND sa.deleted_at IS NULL
            ORDER BY CASE saf.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END, saf.created_at DESC
            LIMIT $2`,
          [id, MAX_BRIEF_FINDINGS],
        );
        const keywords = await c.query<{ keyword: string; intent: string | null; cluster_label: string | null }>(
          `SELECT k.keyword, k.intent, k.cluster_label
             FROM search_keywords k
             JOIN search_keyword_sets s ON s.id = k.set_id
             JOIN search_engagements e ON e.id = s.engagement_id
            WHERE e.property_id = $1 AND k.deleted_at IS NULL AND s.deleted_at IS NULL AND e.deleted_at IS NULL
            ORDER BY k.keyword ASC, k.id ASC LIMIT $2`,
          [id, MAX_BRIEF_KEYWORDS],
        );
        return { domain: propRes.rows[0].domain, findings: findings.rows, keywords: keywords.rows };
      },
      { modules: ["search"] },
    );
    if (!grounded) throw new NotFoundException("property not found");

    // Best-effort WS8 ingest+search — see method header. Chunk count is its OWN small cap
    // (MAX_KNOWLEDGE_INGEST_CHUNKS), independent of MAX_BRIEF_FINDINGS, because the knowledge
    // service embeds each chunk with its own sequential per-chunk gateway call before /ingest
    // returns (ai-agents/src/knowledge/store.ts) — a purely-local prompt-context bound is not a
    // safe stand-in for "how many chunks am I asking a DIFFERENT service to embed on my behalf".
    const ingestChunks = [
      ...grounded.findings.map((f) => `Finding [${f.code}] severity=${f.severity}: ${f.message}`),
      ...(grounded.keywords.length > 0
        ? [`Target keywords: ${grounded.keywords.map((k) => k.keyword).join(", ")}`]
        : []),
    ].slice(0, MAX_KNOWLEDGE_INGEST_CHUNKS);
    await ingestPropertyKnowledge(tenantId, `search-property:${id}:grounding`, id, ingestChunks);
    const knowledgeHits = await queryPropertyKnowledge(req.principal.userId ?? "", id, topic, MAX_KNOWLEDGE_HITS);

    const facts: BriefGroundingFacts = {
      propertyDomain: grounded.domain,
      findings: grounded.findings.map((f) => ({ code: f.code, severity: f.severity, category: f.category, message: f.message })),
      keywords: grounded.keywords.map((k) => ({ keyword: k.keyword, intent: k.intent, clusterLabel: k.cluster_label })),
      knowledgeHits: knowledgeHits.map((h) => ({ sourceRef: h.sourceRef, text: h.text, score: h.score })),
    };

    let draft: BriefDraft;
    let draftedVia: "ai" | "fallback";
    let model: string | null = null;
    try {
      const completion = await completeViaGateway(buildBriefPrompt(topic, facts));
      model = completion.provider ?? null;
      ({ draft, draftedVia } = parseBriefDraft(completion.text, topic, facts));
    } catch {
      ({ draft, draftedVia } = parseBriefDraft(null, topic, facts));
    }

    const briefId = newId();
    const grounding = {
      findingCount: facts.findings.length,
      keywordCount: facts.keywords.length,
      knowledgeHits: facts.knowledgeHits.map((h) => ({ sourceRef: h.sourceRef, score: h.score })),
    };
    await withTenants(
      [tenantId],
      (c) =>
        c.query(
          `INSERT INTO search_content_briefs
             (id, tenant_id, property_id, topic, status, outline, body, geo_notes, grounding, model, drafted_via, created_by, origin_site)
           VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            briefId, tenantId, id, topic, JSON.stringify(draft.outline), draft.body, draft.geoNotes || null,
            JSON.stringify(grounding), model, draftedVia, req.principal.userId ?? null, config.originSite,
          ],
        ),
      { modules: ["search"] },
    );
    await writeActivity(tenantId, req.principal.userId, "drafted", "search_content_brief", briefId, { topic, draftedVia });
    return {
      id: briefId, propertyId: id, topic, status: "draft", outline: draft.outline, body: draft.body,
      geoNotes: draft.geoNotes, grounding, model, draftedVia,
    };
  }

  @Get("briefs/:id")
  async getBrief(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const brief = await withTenants([tenantId], (c) => briefRow(c, id), { modules: ["search"] });
    if (!brief) throw new NotFoundException("brief not found");
    await authorize(req.principal, { kind: "resource_search_property", id: brief.propertyId, tenantId, module: "search" }, "read");
    const row = await withTenants(
      [tenantId],
      (c) =>
        c.query(
          `SELECT id, property_id AS "propertyId", topic, status, outline, body, geo_notes AS "geoNotes",
                  grounding, model, drafted_via AS "draftedVia", polished_at AS "polishedAt",
                  created_by AS "createdBy", created_at, updated_at
             FROM search_content_briefs WHERE id = $1 AND deleted_at IS NULL`,
          [id],
        ),
      { modules: ["search"] },
    );
    if (!row.rows[0]) throw new NotFoundException("brief not found");
    return row.rows[0];
  }

  // "Polish brief/content with Claude" (design §08). The gateway's OWN chain decides which provider
  // actually serves this completeViaGateway call — this module has no provider-selection knob (see
  // ai-drafts.ts's buildBriefPolishPrompt doc comment for the honest accounting of that gap: the
  // "Hermes-default + Claude flag" routing described in §07 is a gateway-chain concern, not
  // something reachable from this module's /complete body today). A failed/empty polish leaves the
  // EXISTING draft untouched rather than replacing it with a synthesized fallback.
  @Post("briefs/:id/polish")
  @HttpCode(200)
  async polishBrief(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const brief = await withTenants([tenantId], (c) => briefRow(c, id), { modules: ["search"] });
    if (!brief) throw new NotFoundException("brief not found");
    await authorize(req.principal, { kind: "resource_search_property", id: brief.propertyId, tenantId, module: "search" }, "update");

    const current = await withTenants(
      [tenantId],
      (c) =>
        c.query<{ outline: unknown; body: string; geo_notes: string | null }>(
          `SELECT outline, body, geo_notes FROM search_content_briefs WHERE id = $1 AND deleted_at IS NULL`,
          [id],
        ),
      { modules: ["search"] },
    );
    const row = current.rows[0];
    if (!row) throw new NotFoundException("brief not found");
    const draftIn: BriefDraft = {
      outline: Array.isArray(row.outline) ? (row.outline as string[]) : [],
      body: row.body,
      geoNotes: row.geo_notes ?? "",
    };

    let draft: BriefDraft;
    let draftedVia: "ai" | "fallback";
    let model: string | null = null;
    try {
      const completion = await completeViaGateway(buildBriefPolishPrompt(draftIn));
      model = completion.provider ?? null;
      const parsed = parseBriefDraft(completion.text, "", { propertyDomain: "", findings: [], keywords: [], knowledgeHits: [] });
      if (parsed.draftedVia === "ai") {
        draft = parsed.draft;
        draftedVia = "ai";
      } else {
        draft = draftIn;
        draftedVia = "fallback";
      }
    } catch {
      draft = draftIn;
      draftedVia = "fallback";
    }

    await withTenants(
      [tenantId],
      (c) =>
        c.query(
          `UPDATE search_content_briefs
              SET outline = $2, body = $3, geo_notes = $4, model = $5, drafted_via = $6, polished_at = now(), updated_at = now()
            WHERE id = $1 AND deleted_at IS NULL`,
          [id, JSON.stringify(draft.outline), draft.body, draft.geoNotes || null, model, draftedVia],
        ),
      { modules: ["search"] },
    );
    await writeActivity(tenantId, req.principal.userId, "polished", "search_content_brief", id, { draftedVia });
    return { id, outline: draft.outline, body: draft.body, geoNotes: draft.geoNotes, model, draftedVia };
  }

  // Human edit/approve (design §07: "A human either edits/approves in-console (low-impact
  // artifacts: briefs, reports...)"). `status` is a plain request-body enum validated against
  // BRIEF_STATUSES — a human-supplied, permission-gated value, never anything the AI produced.
  @Patch("briefs/:id")
  @HttpCode(200)
  async updateBrief(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { topic?: string; outline?: unknown[]; body?: string; geoNotes?: string; status?: string },
  ) {
    if (body?.status && !BRIEF_STATUSES.has(body.status)) throw new BadRequestException("status must be draft|approved");
    const brief = await withTenants([tenantId], (c) => briefRow(c, id), { modules: ["search"] });
    if (!brief) throw new NotFoundException("brief not found");
    await authorize(req.principal, { kind: "resource_search_property", id: brief.propertyId, tenantId, module: "search" }, "update");
    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [id];
    if (body?.topic) { params.push(body.topic); sets.push(`topic = $${params.length}`); }
    if (body?.outline) { params.push(JSON.stringify(body.outline)); sets.push(`outline = $${params.length}`); }
    if (body?.body !== undefined) { params.push(body.body); sets.push(`body = $${params.length}`); }
    if (body?.geoNotes !== undefined) { params.push(body.geoNotes); sets.push(`geo_notes = $${params.length}`); }
    if (body?.status) { params.push(body.status); sets.push(`status = $${params.length}`); }
    const res = await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE search_content_briefs SET ${sets.join(", ")} WHERE id = $1 AND deleted_at IS NULL`, params),
      { modules: ["search"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("brief not found");
    await writeActivity(tenantId, req.principal.userId, "updated", "search_content_brief", id, body ?? {});
    return { id };
  }

  @Delete("briefs/:id")
  async deleteBrief(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const brief = await withTenants([tenantId], (c) => briefRow(c, id), { modules: ["search"] });
    if (!brief) throw new NotFoundException("brief not found");
    await authorize(req.principal, { kind: "resource_search_property", id: brief.propertyId, tenantId, module: "search" }, "delete");
    const res = await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE search_content_briefs SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]),
      { modules: ["search"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("brief not found");
    await writeActivity(tenantId, req.principal.userId, "deleted", "search_content_brief", id, {});
    return { id };
  }

  // ============================================================== REPORTS narrative draft (SM-10)
  // SM-10 delivers ONLY the Hermes narrative-drafting function/endpoint on the EXISTING
  // search_reports table (0034's schema already has metrics/narrative_md/status) — status never
  // moves past 'draft' here, and file_id/deliverable_id/approved_by/approved_at/delivered_at are
  // never touched by this controller method. SM-22 owns the draft -> in_review -> approved ->
  // delivered lifecycle + render/deliver on top of this.
  @Get("engagements/:id/reports")
  async listReports(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const engagement = await withTenants([tenantId], (c) => engagementRow(c, id), { modules: ["search"] });
    if (!engagement) throw new NotFoundException("engagement not found");
    await authorize(req.principal, { kind: "resource_search_report", tenantId, module: "search" }, "read");
    const rows = await withTenants(
      [tenantId],
      (c) =>
        c.query(
          `SELECT id, engagement_id AS "engagementId", period, kind, status, metrics,
                  narrative_md AS "narrativeMd", file_id AS "fileId", deliverable_id AS "deliverableId",
                  approved_by AS "approvedBy", approved_at AS "approvedAt", delivered_at AS "deliveredAt",
                  created_at, updated_at
             FROM search_reports WHERE engagement_id = $1 AND deleted_at IS NULL
             ORDER BY created_at DESC LIMIT 500`,
          [id],
        ),
      { modules: ["search"] },
    );
    return rows.rows;
  }

  @Get("reports/:id")
  async getReport(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const report = await withTenants([tenantId], (c) => reportRow(c, id), { modules: ["search"] });
    if (!report) throw new NotFoundException("report not found");
    await authorize(req.principal, { kind: "resource_search_report", id, tenantId, module: "search" }, "read");
    const row = await withTenants(
      [tenantId],
      (c) =>
        c.query(
          `SELECT id, engagement_id AS "engagementId", period, kind, status, metrics,
                  narrative_md AS "narrativeMd", file_id AS "fileId", deliverable_id AS "deliverableId",
                  approved_by AS "approvedBy", approved_at AS "approvedAt", delivered_at AS "deliveredAt",
                  created_at, updated_at
             FROM search_reports WHERE id = $1 AND deleted_at IS NULL`,
          [id],
        ),
      { modules: ["search"] },
    );
    if (!row.rows[0]) throw new NotFoundException("report not found");
    return row.rows[0];
  }

  @Post("engagements/:id/reports")
  @HttpCode(201)
  async draftReportNarrative(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { period?: string; kind?: string },
  ) {
    const period = typeof body?.period === "string" ? body.period.trim() : "";
    if (!period) throw new BadRequestException("period required");
    const kind = body?.kind ?? "monthly";
    if (!REPORT_KINDS.has(kind)) throw new BadRequestException("kind must be monthly|audit|adhoc");

    const engagement = await withTenants([tenantId], (c) => engagementRow(c, id), { modules: ["search"] });
    if (!engagement) throw new NotFoundException("engagement not found");
    await authorize(req.principal, { kind: "resource_search_report", tenantId, module: "search" }, "create");

    // Phase 1 (short, network-free transaction): resolve an existing draft row for this
    // engagement+period+kind (if any) + a metrics snapshot from data that already exists. A report
    // that has moved PAST 'draft' (SM-22's in_review/approved/delivered lifecycle) is refused
    // (400) rather than silently rewritten — see the check right after this block.
    const pre = await withTenants(
      [tenantId],
      async (c) => {
        const existing = await c.query<{ id: string; status: string }>(
          `SELECT id, status FROM search_reports WHERE engagement_id = $1 AND period = $2 AND kind = $3 AND deleted_at IS NULL`,
          [id, period, kind],
        );
        const engRow = await c.query<{ name: string }>(`SELECT name FROM search_engagements WHERE id = $1`, [id]);
        // SM-46b (design addendum §A4.7 enumeration, QA's find): mode-filtered, identical shape and
        // reason as the index.ts `search.rank.top10` rollup (SM-46a). This is the worse reader of the
        // two — it feeds a CLIENT-facing report narrative, so an unfiltered count would land blended
        // synthetic rankings in front of the person least equipped to notice. Filter lands now, before
        // SM-14 gives this table its first writer (§4d fail-open class).
        const rankTop10 = await c.query<{ n: string }>(
          `SELECT count(*) AS n FROM (
             SELECT DISTINCT ON (keyword_id, engine, device) position
             FROM search_rank_snapshots WHERE property_id = $1
               AND simulated = $2
             ORDER BY keyword_id, engine, device, captured_at DESC
           ) latest WHERE latest.position BETWEEN 1 AND 10`,
          [engagement.propertyId, config.search.providerMode === "simulate"],
        );
        const criticalOpen = await c.query<{ n: string }>(
          `SELECT count(*) AS n FROM search_audit_findings saf
             JOIN search_audits sa ON sa.id = saf.audit_id
            WHERE sa.property_id = $1 AND saf.severity = 'critical' AND saf.status IN ('open','regressed')`,
          [engagement.propertyId],
        );
        const kpiTargets = await c.query<{ metric_key: string; target_value: string; direction: string }>(
          `SELECT metric_key, target_value, direction FROM search_kpi_targets WHERE engagement_id = $1 AND deleted_at IS NULL`,
          [id],
        );
        return {
          existing: existing.rows[0] ?? null,
          engagementName: engRow.rows[0]?.name ?? "engagement",
          rankTop10: Number(rankTop10.rows[0]?.n ?? 0),
          criticalFindingsOpen: Number(criticalOpen.rows[0]?.n ?? 0),
          kpiTargets: kpiTargets.rows.map((r) => ({ metric: r.metric_key, target: Number(r.target_value), direction: r.direction })),
        };
      },
      { modules: ["search"] },
    );
    if (pre.existing && pre.existing.status !== "draft") {
      throw new BadRequestException(`report ${pre.existing.id} is already '${pre.existing.status}' — cannot re-draft past 'draft'`);
    }

    const facts: ReportMetricsFacts = {
      period, rankTop10: pre.rankTop10, criticalFindingsOpen: pre.criticalFindingsOpen, kpiTargets: pre.kpiTargets,
    };
    const metrics = { rankTop10: pre.rankTop10, criticalFindingsOpen: pre.criticalFindingsOpen, kpiTargets: pre.kpiTargets };

    let narrative: string;
    let draftedVia: "ai" | "fallback";
    let model: string | null = null;
    try {
      const completion = await completeViaGateway(buildReportNarrativePrompt(pre.engagementName, facts));
      model = completion.provider ?? null;
      ({ narrative, draftedVia } = parseReportNarrative(completion.text, facts));
    } catch {
      ({ narrative, draftedVia } = parseReportNarrative(null, facts));
    }

    const reportId = pre.existing?.id ?? newId();
    await withTenants(
      [tenantId],
      (c) =>
        pre.existing
          ? c.query(
              `UPDATE search_reports SET metrics = $2, narrative_md = $3, updated_at = now() WHERE id = $1 AND status = 'draft'`,
              [reportId, JSON.stringify(metrics), narrative],
            )
          : c.query(
              `INSERT INTO search_reports (id, tenant_id, engagement_id, period, kind, status, metrics, narrative_md, origin_site)
               VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8)`,
              [reportId, tenantId, id, period, kind, JSON.stringify(metrics), narrative, config.originSite],
            ),
      { modules: ["search"] },
    );
    await writeActivity(tenantId, req.principal.userId, pre.existing ? "redrafted" : "drafted", "search_report", reportId, { period, kind, draftedVia });
    return { id: reportId, engagementId: id, period, kind, status: "draft", metrics, narrativeMd: narrative, draftedVia, model };
  }

  // ============================================================== SEM: CAMPAIGNS (SM-18) ==========
  // design §04/§07/§09/§11/§12 SM-18. Cerbos kind is `resource_search_campaign` for EVERY object in
  // this domain (campaigns/ad-groups/ads/negatives/change-proposals — the policy header explicitly
  // bundles them, same convention resource_search_property already uses for content briefs).
  //
  // THIS TICKET HAS NO LIVE SIDE-EFFECTS (design §12 SM-18 "done when: ... no live side-effects
  // exist in this ticket"): every write below only ever persists a draft/proposed row. Campaign
  // status is restricted to draft|proposed, ad status to draft|approved|rejected, negative status to
  // proposed|approved|dismissed, and a change proposal can only reach approved|dismissed here —
  // 'live'/'ended' campaigns, 'live' ads, 'applied' negatives and 'applied' change proposals are ALL
  // out of this ticket's reach (SM-20 read-bridge, SM-21 approve-execute-replay, SM-26 live account,
  // SM-30 manual-apply own those transitions exclusively).
  @Get("engagements/:id/campaigns")
  async listCampaigns(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Query("status") status?: string,
  ) {
    assertUuid(id, "engagement id");
    const engagement = await withTenants([tenantId], (c) => engagementRow(c, id), { modules: ["search"] });
    if (!engagement) throw new NotFoundException("engagement not found");
    await authorize(req.principal, { kind: "resource_search_campaign", id, tenantId, module: "search" }, "read");
    const params: unknown[] = [id];
    const clauses = ["engagement_id = $1", "deleted_at IS NULL"];
    if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, engagement_id AS "engagementId", platform, external_id AS "externalId", name, objective,
                status, budget_minor AS "budgetMinor", currency, bid_strategy AS "bidStrategy",
                target_cpa_minor AS "targetCpaMinor", target_roas AS "targetRoas", custom_fields AS "customFields",
                created_at, updated_at
         FROM search_campaigns WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 500`,
        params,
      ),
      { modules: ["search"] },
    );
    return rows.rows.map((r) => ({ ...r, targetRoas: moneyOrNull(r.targetRoas) }));
  }

  @Post("engagements/:id/campaigns")
  @HttpCode(201)
  async createCampaign(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: {
      name?: string; platform?: string; objective?: string; status?: string;
      budgetMinor?: number; currency?: string; bidStrategy?: string; targetCpaMinor?: number;
      targetRoas?: number; customFields?: Record<string, unknown>;
    },
  ) {
    assertUuid(id, "engagement id");
    if (!body?.name) throw new BadRequestException("name required");
    if (body?.platform && !CAMPAIGN_PLATFORMS.has(body.platform)) throw new BadRequestException("platform must be google_ads|microsoft_ads");
    if (body?.status && !CAMPAIGN_STATUSES_WRITABLE.has(body.status)) {
      throw new BadRequestException("status can only be set to draft|proposed here — live states require a live-ads sync (SM-20/25/26)");
    }
    if (body?.budgetMinor !== undefined && !isFiniteOrNull(body.budgetMinor)) throw new BadRequestException("budgetMinor must be a number");
    if (body?.targetCpaMinor !== undefined && !isFiniteOrNull(body.targetCpaMinor)) throw new BadRequestException("targetCpaMinor must be a number");
    if (body?.targetRoas !== undefined && !isFiniteOrNull(body.targetRoas)) throw new BadRequestException("targetRoas must be a number");
    if (body?.budgetMinor !== undefined && body.budgetMinor !== null && !body?.currency) throw new BadRequestException("currency required when budgetMinor is set");
    const engagement = await withTenants([tenantId], (c) => engagementRow(c, id), { modules: ["search"] });
    if (!engagement) throw new NotFoundException("engagement not found");
    await authorize(req.principal, { kind: "resource_search_campaign", tenantId, module: "search" }, "create");
    const campaignId = newId();
    await withTenants(
      [tenantId],
      async (c) => {
        if (body?.customFields) {
          const cfError = await validateCustomFields(c, tenantId, "search_campaign", body.customFields);
          if (cfError) throw new BadRequestException(cfError);
        }
        await c.query(
          `INSERT INTO search_campaigns
             (id, tenant_id, engagement_id, platform, name, objective, status, budget_minor, currency,
              bid_strategy, target_cpa_minor, target_roas, custom_fields, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            campaignId, tenantId, id, body?.platform ?? "google_ads", body.name, body?.objective ?? null,
            body?.status ?? "draft", body?.budgetMinor ?? null, body?.currency ?? null, body?.bidStrategy ?? null,
            body?.targetCpaMinor ?? null, body?.targetRoas ?? null, JSON.stringify(body?.customFields ?? {}), config.originSite,
          ],
        );
        await emitEvent(c, tenantId, "search_campaign", campaignId, "search.campaign.created", { engagementId: id, name: body.name });
      },
      { modules: ["search"] },
    );
    await writeActivity(tenantId, req.principal.userId, "created", "search_campaign", campaignId, { name: body.name });
    return { id: campaignId };
  }

  // Cluster→plan generator (design §12 SM-18: "cluster→plan generator"). Builds ONE campaign
  // (status='draft') plus one ad group PER KEYWORD CLUSTER from a keyword set SM-09 already
  // clustered — see sem-plan.ts's buildCampaignPlan for the pure grouping/provenance logic. Bounded
  // by the SAME cap clustering itself already enforces (config.search.maxKeywordsPerSet, default
  // 1000 keywords per set) — no new unbounded loop is introduced; the number of ad groups created is
  // at most the number of distinct clusters, itself bounded by the keyword-set cap.
  @Post("engagements/:id/campaigns/generate-plan")
  @HttpCode(201)
  async generateCampaignPlan(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: {
      keywordSetId?: string; name?: string; platform?: string; objective?: string;
      budgetMinor?: number; currency?: string; bidStrategy?: string; targetCpaMinor?: number; targetRoas?: number;
    },
  ) {
    assertUuid(id, "engagement id");
    if (!body?.keywordSetId || !body?.name) throw new BadRequestException("keywordSetId and name required");
    assertUuid(body.keywordSetId, "keywordSetId");
    if (body?.platform && !CAMPAIGN_PLATFORMS.has(body.platform)) throw new BadRequestException("platform must be google_ads|microsoft_ads");
    if (body?.budgetMinor !== undefined && !isFiniteOrNull(body.budgetMinor)) throw new BadRequestException("budgetMinor must be a number");
    if (body?.targetCpaMinor !== undefined && !isFiniteOrNull(body.targetCpaMinor)) throw new BadRequestException("targetCpaMinor must be a number");
    if (body?.targetRoas !== undefined && !isFiniteOrNull(body.targetRoas)) throw new BadRequestException("targetRoas must be a number");
    if (body?.budgetMinor !== undefined && body.budgetMinor !== null && !body?.currency) throw new BadRequestException("currency required when budgetMinor is set");
    const engagement = await withTenants([tenantId], (c) => engagementRow(c, id), { modules: ["search"] });
    if (!engagement) throw new NotFoundException("engagement not found");
    await authorize(req.principal, { kind: "resource_search_campaign", tenantId, module: "search" }, "create");

    const keywordSetId = body.keywordSetId;
    const result = await withTenants(
      [tenantId],
      async (c) => {
        const set = await keywordSetRow(c, keywordSetId);
        if (!set) throw new BadRequestException("keywordSetId not found in this tenant");
        if (set.engagementId !== id) throw new BadRequestException("keywordSetId does not belong to this engagement");

        const kwRes = await c.query<{
          id: string; keyword: string; intent: string | null; cluster_id: string | null; cluster_label: string | null;
          volume: number | null; difficulty: string | null; cpc_usd: string | null;
          metrics_provider: string | null; metrics_simulated: boolean;
        }>(
          `SELECT id, keyword, intent, cluster_id, cluster_label, volume, difficulty, cpc_usd,
                  metrics_provider, metrics_simulated
             FROM search_keywords WHERE set_id = $1 AND deleted_at IS NULL
             ORDER BY keyword ASC, id ASC`,
          [keywordSetId],
        );
        const planRows: PlanKeywordRow[] = kwRes.rows.map((r) => ({
          id: r.id, keyword: r.keyword, intent: r.intent, clusterId: r.cluster_id, clusterLabel: r.cluster_label,
          volume: r.volume, difficulty: moneyOrNull(r.difficulty), cpcUsd: moneyOrNull(r.cpc_usd),
          metricsProvider: r.metrics_provider, metricsSimulated: r.metrics_simulated,
        }));

        let plan;
        try {
          plan = buildCampaignPlan(planRows);
        } catch (err) {
          if (err instanceof NoClusteredKeywordsError) throw new BadRequestException(err.message);
          throw err;
        }

        const campaignId = newId();
        await c.query(
          `INSERT INTO search_campaigns
             (id, tenant_id, engagement_id, platform, name, objective, status, budget_minor, currency,
              bid_strategy, target_cpa_minor, target_roas, custom_fields, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10,$11,'{}',$12)`,
          [
            campaignId, tenantId, id, body?.platform ?? "google_ads", body.name, body?.objective ?? null,
            body?.budgetMinor ?? null, body?.currency ?? null, body?.bidStrategy ?? null,
            body?.targetCpaMinor ?? null, body?.targetRoas ?? null, config.originSite,
          ],
        );
        const adGroups: {
          id: string; clusterId: string; name: string; intent: string | null; keywordCount: number;
          keywordSample: string[]; provenance: (typeof plan.adGroups)[number]["provenance"];
        }[] = [];
        for (const g of plan.adGroups) {
          const adGroupId = newId();
          await c.query(
            `INSERT INTO search_ad_groups (id, tenant_id, campaign_id, name, cluster_id, origin_site)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [adGroupId, tenantId, campaignId, g.name, g.clusterId, config.originSite],
          );
          adGroups.push({
            id: adGroupId, clusterId: g.clusterId, name: g.name, intent: g.intent,
            keywordCount: g.keywordCount, keywordSample: g.keywordSample, provenance: g.provenance,
          });
        }
        await emitEvent(c, tenantId, "search_campaign", campaignId, "search.campaign.created", {
          engagementId: id, name: body.name, viaPlanGenerator: true, adGroupCount: adGroups.length,
          keywordSetId, unclusteredSkipped: plan.unclusteredSkipped,
        });
        return { campaignId, adGroups, totalClusteredKeywords: plan.totalClusteredKeywords, unclusteredSkipped: plan.unclusteredSkipped };
      },
      { modules: ["search"] },
    );
    await writeActivity(tenantId, req.principal.userId, "generated_plan", "search_campaign", result.campaignId, {
      adGroups: result.adGroups.length, keywordSetId,
    });
    return {
      id: result.campaignId, keywordSetId, adGroups: result.adGroups,
      totalClusteredKeywords: result.totalClusteredKeywords, unclusteredSkipped: result.unclusteredSkipped,
    };
  }

  @Get("campaigns/:id")
  async getCampaign(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    assertUuid(id, "campaign id");
    await authorize(req.principal, { kind: "resource_search_campaign", id, tenantId, module: "search" }, "read");
    const row = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, engagement_id AS "engagementId", platform, external_id AS "externalId", name, objective,
                status, budget_minor AS "budgetMinor", currency, bid_strategy AS "bidStrategy",
                target_cpa_minor AS "targetCpaMinor", target_roas AS "targetRoas", custom_fields AS "customFields",
                created_at, updated_at
         FROM search_campaigns WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      ),
      { modules: ["search"] },
    );
    if (!row.rows[0]) throw new NotFoundException("campaign not found");
    return { ...row.rows[0], targetRoas: moneyOrNull(row.rows[0].targetRoas) };
  }

  @Patch("campaigns/:id")
  @HttpCode(200)
  async updateCampaign(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: {
      name?: string; objective?: string; status?: string; budgetMinor?: number | null; currency?: string | null;
      bidStrategy?: string | null; targetCpaMinor?: number | null; targetRoas?: number | null; customFields?: Record<string, unknown>;
    },
  ) {
    assertUuid(id, "campaign id");
    if (body?.status && !CAMPAIGN_STATUSES_WRITABLE.has(body.status)) {
      throw new BadRequestException("status can only be set to draft|proposed here — live states require a live-ads sync (SM-20/25/26)");
    }
    if (body?.budgetMinor !== undefined && !isFiniteOrNull(body.budgetMinor)) throw new BadRequestException("budgetMinor must be a number");
    if (body?.targetCpaMinor !== undefined && !isFiniteOrNull(body.targetCpaMinor)) throw new BadRequestException("targetCpaMinor must be a number");
    if (body?.targetRoas !== undefined && !isFiniteOrNull(body.targetRoas)) throw new BadRequestException("targetRoas must be a number");
    await authorize(req.principal, { kind: "resource_search_campaign", id, tenantId, module: "search" }, "update");
    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [id];
    if (body?.name) { params.push(body.name); sets.push(`name = $${params.length}`); }
    if (body?.objective !== undefined) { params.push(body.objective); sets.push(`objective = $${params.length}`); }
    if (body?.status) { params.push(body.status); sets.push(`status = $${params.length}`); }
    if (body?.budgetMinor !== undefined) { params.push(body.budgetMinor); sets.push(`budget_minor = $${params.length}`); }
    if (body?.currency !== undefined) { params.push(body.currency); sets.push(`currency = $${params.length}`); }
    if (body?.bidStrategy !== undefined) { params.push(body.bidStrategy); sets.push(`bid_strategy = $${params.length}`); }
    if (body?.targetCpaMinor !== undefined) { params.push(body.targetCpaMinor); sets.push(`target_cpa_minor = $${params.length}`); }
    if (body?.targetRoas !== undefined) { params.push(body.targetRoas); sets.push(`target_roas = $${params.length}`); }
    const res = await withTenants(
      [tenantId],
      async (c) => {
        if (body?.customFields) {
          const cfError = await validateCustomFields(c, tenantId, "search_campaign", body.customFields);
          if (cfError) throw new BadRequestException(cfError);
          params.push(JSON.stringify(body.customFields));
          sets.push(`custom_fields = $${params.length}`);
        }
        return c.query(`UPDATE search_campaigns SET ${sets.join(", ")} WHERE id = $1 AND deleted_at IS NULL`, params);
      },
      { modules: ["search"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("campaign not found");
    await writeActivity(tenantId, req.principal.userId, "updated", "search_campaign", id, body ?? {});
    return { id };
  }

  @Delete("campaigns/:id")
  @HttpCode(200)
  async deleteCampaign(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    assertUuid(id, "campaign id");
    await authorize(req.principal, { kind: "resource_search_campaign", id, tenantId, module: "search" }, "delete");
    const res = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query(`UPDATE search_campaigns SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]);
        if (r.rowCount) await emitEvent(c, tenantId, "search_campaign", id, "search.campaign.deleted", {});
        return r;
      },
      { modules: ["search"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("campaign not found");
    await writeActivity(tenantId, req.principal.userId, "deleted", "search_campaign", id, {});
    return { ok: true };
  }

  // ============================================================== SEM: AD GROUPS ===================
  @Get("campaigns/:id/ad-groups")
  async listAdGroups(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    assertUuid(id, "campaign id");
    const campaign = await withTenants([tenantId], (c) => campaignRow(c, id), { modules: ["search"] });
    if (!campaign) throw new NotFoundException("campaign not found");
    await authorize(req.principal, { kind: "resource_search_campaign", id, tenantId, module: "search" }, "read");
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, campaign_id AS "campaignId", name, cluster_id AS "clusterId", external_id AS "externalId",
                created_at, updated_at
         FROM search_ad_groups WHERE campaign_id = $1 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 500`,
        [id],
      ),
      { modules: ["search"] },
    );
    return rows.rows;
  }

  @Post("campaigns/:id/ad-groups")
  @HttpCode(201)
  async createAdGroup(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { name?: string; clusterId?: string },
  ) {
    assertUuid(id, "campaign id");
    if (!body?.name) throw new BadRequestException("name required");
    if (body?.clusterId !== undefined) assertUuid(body.clusterId, "clusterId");
    const campaign = await withTenants([tenantId], (c) => campaignRow(c, id), { modules: ["search"] });
    if (!campaign) throw new NotFoundException("campaign not found");
    await authorize(req.principal, { kind: "resource_search_campaign", tenantId, module: "search" }, "create");
    const adGroupId = newId();
    await withTenants(
      [tenantId],
      async (c) => {
        await c.query(
          `INSERT INTO search_ad_groups (id, tenant_id, campaign_id, name, cluster_id, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [adGroupId, tenantId, id, body.name, body?.clusterId ?? null, config.originSite],
        );
        await emitEvent(c, tenantId, "search_ad_group", adGroupId, "search.ad_group.created", { campaignId: id, name: body.name });
      },
      { modules: ["search"] },
    );
    await writeActivity(tenantId, req.principal.userId, "created", "search_ad_group", adGroupId, { name: body.name });
    return { id: adGroupId };
  }

  @Get("ad-groups/:id")
  async getAdGroup(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    assertUuid(id, "ad group id");
    await authorize(req.principal, { kind: "resource_search_campaign", id, tenantId, module: "search" }, "read");
    const row = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, campaign_id AS "campaignId", name, cluster_id AS "clusterId", external_id AS "externalId",
                created_at, updated_at
         FROM search_ad_groups WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      ),
      { modules: ["search"] },
    );
    if (!row.rows[0]) throw new NotFoundException("ad group not found");
    return row.rows[0];
  }

  @Patch("ad-groups/:id")
  @HttpCode(200)
  async updateAdGroup(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { name?: string },
  ) {
    assertUuid(id, "ad group id");
    if (body?.name !== undefined && !body.name) throw new BadRequestException("name cannot be blank");
    await authorize(req.principal, { kind: "resource_search_campaign", id, tenantId, module: "search" }, "update");
    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [id];
    if (body?.name) { params.push(body.name); sets.push(`name = $${params.length}`); }
    const res = await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE search_ad_groups SET ${sets.join(", ")} WHERE id = $1 AND deleted_at IS NULL`, params),
      { modules: ["search"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("ad group not found");
    await writeActivity(tenantId, req.principal.userId, "updated", "search_ad_group", id, body ?? {});
    return { id };
  }

  @Delete("ad-groups/:id")
  @HttpCode(200)
  async deleteAdGroup(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    assertUuid(id, "ad group id");
    await authorize(req.principal, { kind: "resource_search_campaign", id, tenantId, module: "search" }, "delete");
    const res = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query(`UPDATE search_ad_groups SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]);
        if (r.rowCount) await emitEvent(c, tenantId, "search_ad_group", id, "search.ad_group.deleted", {});
        return r;
      },
      { modules: ["search"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("ad group not found");
    await writeActivity(tenantId, req.principal.userId, "deleted", "search_ad_group", id, {});
    return { ok: true };
  }

  // ============================================================== SEM: ADS (RSA) ===================
  @Get("ad-groups/:id/ads")
  async listAds(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    assertUuid(id, "ad group id");
    const adGroup = await withTenants([tenantId], (c) => adGroupRow(c, id), { modules: ["search"] });
    if (!adGroup) throw new NotFoundException("ad group not found");
    await authorize(req.principal, { kind: "resource_search_campaign", id, tenantId, module: "search" }, "read");
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, ad_group_id AS "adGroupId", headlines, descriptions, final_url AS "finalUrl", status,
                ai_generated AS "aiGenerated", created_at, updated_at
         FROM search_ads WHERE ad_group_id = $1 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 500`,
        [id],
      ),
      { modules: ["search"] },
    );
    return rows.rows;
  }

  @Post("ad-groups/:id/ads")
  @HttpCode(201)
  async createAd(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { headlines?: unknown[]; descriptions?: unknown[]; finalUrl?: string; status?: string },
  ) {
    assertUuid(id, "ad group id");
    const headlines = Array.isArray(body?.headlines)
      ? body.headlines.filter((h): h is string => typeof h === "string" && h.trim().length > 0)
      : [];
    const descriptions = Array.isArray(body?.descriptions)
      ? body.descriptions.filter((d): d is string => typeof d === "string" && d.trim().length > 0)
      : [];
    if (headlines.length === 0 || descriptions.length === 0) throw new BadRequestException("at least one headline and one description required");
    if (body?.status && !AD_STATUSES_WRITABLE.has(body.status)) {
      throw new BadRequestException("status must be draft|approved|rejected here — 'live' is set only by a live-ads sync");
    }
    const adGroup = await withTenants([tenantId], (c) => adGroupRow(c, id), { modules: ["search"] });
    if (!adGroup) throw new NotFoundException("ad group not found");
    await authorize(req.principal, { kind: "resource_search_campaign", tenantId, module: "search" }, "create");
    const adId = newId();
    await withTenants(
      [tenantId],
      async (c) => {
        await c.query(
          `INSERT INTO search_ads (id, tenant_id, ad_group_id, headlines, descriptions, final_url, status, ai_generated, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8)`,
          [adId, tenantId, id, JSON.stringify(headlines), JSON.stringify(descriptions), body?.finalUrl ?? null, body?.status ?? "draft", config.originSite],
        );
        await emitEvent(c, tenantId, "search_ad", adId, "search.ad.created", { adGroupId: id });
      },
      { modules: ["search"] },
    );
    await writeActivity(tenantId, req.principal.userId, "created", "search_ad", adId, {});
    return { id: adId };
  }

  @Patch("ads/:id")
  @HttpCode(200)
  async updateAd(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { headlines?: unknown[]; descriptions?: unknown[]; finalUrl?: string | null; status?: string },
  ) {
    assertUuid(id, "ad id");
    if (body?.status && !AD_STATUSES_WRITABLE.has(body.status)) {
      throw new BadRequestException("status must be draft|approved|rejected here — 'live' is set only by a live-ads sync");
    }
    await authorize(req.principal, { kind: "resource_search_campaign", id, tenantId, module: "search" }, "update");
    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [id];
    if (body?.headlines !== undefined) {
      const headlines = Array.isArray(body.headlines)
        ? body.headlines.filter((h): h is string => typeof h === "string" && h.trim().length > 0)
        : [];
      if (headlines.length === 0) throw new BadRequestException("headlines cannot be emptied");
      params.push(JSON.stringify(headlines));
      sets.push(`headlines = $${params.length}`);
    }
    if (body?.descriptions !== undefined) {
      const descriptions = Array.isArray(body.descriptions)
        ? body.descriptions.filter((d): d is string => typeof d === "string" && d.trim().length > 0)
        : [];
      if (descriptions.length === 0) throw new BadRequestException("descriptions cannot be emptied");
      params.push(JSON.stringify(descriptions));
      sets.push(`descriptions = $${params.length}`);
    }
    if (body?.finalUrl !== undefined) { params.push(body.finalUrl); sets.push(`final_url = $${params.length}`); }
    if (body?.status) { params.push(body.status); sets.push(`status = $${params.length}`); }
    const res = await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE search_ads SET ${sets.join(", ")} WHERE id = $1 AND deleted_at IS NULL`, params),
      { modules: ["search"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("ad not found");
    await writeActivity(tenantId, req.principal.userId, "updated", "search_ad", id, {});
    return { id };
  }

  @Delete("ads/:id")
  @HttpCode(200)
  async deleteAd(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    assertUuid(id, "ad id");
    await authorize(req.principal, { kind: "resource_search_campaign", id, tenantId, module: "search" }, "delete");
    const res = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query(`UPDATE search_ads SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]);
        if (r.rowCount) await emitEvent(c, tenantId, "search_ad", id, "search.ad.deleted", {});
        return r;
      },
      { modules: ["search"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("ad not found");
    await writeActivity(tenantId, req.principal.userId, "deleted", "search_ad", id, {});
    return { ok: true };
  }

  // AI RSA draft (design §07/§08: "Generate RSA drafts | Planner/Ads Studio | 🟢 | draft only").
  // Grounded in the ad group's OWN clustered keywords (bounded MAX_RSA_KEYWORDS, ONE gateway call —
  // never per-keyword, the SM-32 lesson this module keeps re-stating). Always persists
  // status='draft', ai_generated=true — never live, never auto-published (design §07's
  // AI-drafts→human-approves spine).
  @Post("ad-groups/:id/ads/draft")
  @HttpCode(201)
  async draftAd(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    assertUuid(id, "ad group id");
    const adGroup = await withTenants([tenantId], (c) => adGroupRow(c, id), { modules: ["search"] });
    if (!adGroup) throw new NotFoundException("ad group not found");
    await authorize(req.principal, { kind: "resource_search_campaign", id, tenantId, module: "search" }, "create");

    const pre = await withTenants(
      [tenantId],
      async (c) => {
        const agRes = await c.query<{ name: string; cluster_id: string | null }>(
          `SELECT name, cluster_id FROM search_ad_groups WHERE id = $1`,
          [id],
        );
        const adGroupName = agRes.rows[0]?.name ?? "ad group";
        const clusterId = agRes.rows[0]?.cluster_id ?? null;
        let keywords: RsaKeywordFact[] = [];
        if (clusterId) {
          const kwRes = await c.query<{ keyword: string; intent: string | null }>(
            `SELECT keyword, intent FROM search_keywords WHERE cluster_id = $1 AND deleted_at IS NULL
               ORDER BY keyword ASC, id ASC LIMIT $2`,
            [clusterId, MAX_RSA_KEYWORDS],
          );
          keywords = kwRes.rows.map((r) => ({ keyword: r.keyword, intent: r.intent }));
        }
        return { adGroupName, keywords };
      },
      { modules: ["search"] },
    );

    let draft: { headlines: string[]; descriptions: string[] };
    let draftedVia: "ai" | "fallback";
    let model: string | null = null;
    try {
      const completion = await completeViaGateway(buildRsaDraftPrompt(pre.adGroupName, null, pre.keywords));
      model = completion.provider ?? null;
      ({ draft, draftedVia } = parseRsaDraft(completion.text, pre.adGroupName, pre.keywords));
    } catch {
      ({ draft, draftedVia } = parseRsaDraft(null, pre.adGroupName, pre.keywords));
    }

    const adId = newId();
    await withTenants(
      [tenantId],
      async (c) => {
        await c.query(
          `INSERT INTO search_ads (id, tenant_id, ad_group_id, headlines, descriptions, status, ai_generated, origin_site)
           VALUES ($1,$2,$3,$4,$5,'draft',true,$6)`,
          [adId, tenantId, id, JSON.stringify(draft.headlines), JSON.stringify(draft.descriptions), config.originSite],
        );
        await emitEvent(c, tenantId, "search_ad_group", id, "search.ads.drafted", { adId, draftedVia });
      },
      { modules: ["search"] },
    );
    await writeActivity(tenantId, req.principal.userId, "ai_drafted", "search_ad", adId, { draftedVia });
    return { id: adId, headlines: draft.headlines, descriptions: draft.descriptions, draftedVia, model };
  }

  // ============================================================== SEM: NEGATIVES ===================
  @Get("campaigns/:id/negatives")
  async listNegatives(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Query("status") status?: string,
  ) {
    assertUuid(id, "campaign id");
    const campaign = await withTenants([tenantId], (c) => campaignRow(c, id), { modules: ["search"] });
    if (!campaign) throw new NotFoundException("campaign not found");
    await authorize(req.principal, { kind: "resource_search_campaign", id, tenantId, module: "search" }, "read");
    const params: unknown[] = [id];
    const clauses = ["campaign_id = $1", "deleted_at IS NULL"];
    if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, campaign_id AS "campaignId", ad_group_id AS "adGroupId", term, match_type AS "matchType",
                source, status, created_at, updated_at
         FROM search_negatives WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 500`,
        params,
      ),
      { modules: ["search"] },
    );
    return rows.rows;
  }

  @Post("campaigns/:id/negatives")
  @HttpCode(201)
  async createNegative(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { term?: string; matchType?: string; adGroupId?: string },
  ) {
    assertUuid(id, "campaign id");
    const term = body?.term?.trim();
    if (!term) throw new BadRequestException("term required");
    const matchType = body?.matchType ?? "exact";
    if (!NEGATIVE_MATCH_TYPE_SET.has(matchType)) throw new BadRequestException("matchType must be broad|phrase|exact");
    if (body?.adGroupId !== undefined) assertUuid(body.adGroupId, "adGroupId");
    const campaign = await withTenants([tenantId], (c) => campaignRow(c, id), { modules: ["search"] });
    if (!campaign) throw new NotFoundException("campaign not found");
    await authorize(req.principal, { kind: "resource_search_campaign", tenantId, module: "search" }, "create");
    const negativeId = newId();
    await withTenants(
      [tenantId],
      async (c) => {
        if (body?.adGroupId) {
          const ag = await adGroupRow(c, body.adGroupId);
          if (!ag || ag.campaignId !== id) throw new BadRequestException("adGroupId not found in this campaign");
        }
        await c.query(
          `INSERT INTO search_negatives (id, tenant_id, campaign_id, ad_group_id, term, match_type, source, status, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,'manual','proposed',$7)`,
          [negativeId, tenantId, id, body?.adGroupId ?? null, term, matchType, config.originSite],
        );
        await emitEvent(c, tenantId, "search_negative", negativeId, "search.negative.created", { campaignId: id, term });
      },
      { modules: ["search"] },
    );
    await writeActivity(tenantId, req.principal.userId, "created", "search_negative", negativeId, { term });
    return { id: negativeId };
  }

  @Patch("negatives/:id")
  @HttpCode(200)
  async updateNegative(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { matchType?: string; status?: string },
  ) {
    assertUuid(id, "negative id");
    if (body?.matchType && !NEGATIVE_MATCH_TYPE_SET.has(body.matchType)) throw new BadRequestException("matchType must be broad|phrase|exact");
    if (body?.status && !NEGATIVE_STATUSES_WRITABLE.has(body.status)) {
      throw new BadRequestException(
        "status can only be set to proposed|approved|dismissed here — 'applied' is stamped only by the manual/api execution flow (SM-30/21)",
      );
    }
    await authorize(req.principal, { kind: "resource_search_campaign", id, tenantId, module: "search" }, "update");
    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [id];
    if (body?.matchType) { params.push(body.matchType); sets.push(`match_type = $${params.length}`); }
    if (body?.status) { params.push(body.status); sets.push(`status = $${params.length}`); }
    const res = await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE search_negatives SET ${sets.join(", ")} WHERE id = $1 AND deleted_at IS NULL`, params),
      { modules: ["search"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("negative not found");
    await writeActivity(tenantId, req.principal.userId, "updated", "search_negative", id, body ?? {});
    return { id };
  }

  @Delete("negatives/:id")
  @HttpCode(200)
  async deleteNegative(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    assertUuid(id, "negative id");
    await authorize(req.principal, { kind: "resource_search_campaign", id, tenantId, module: "search" }, "delete");
    const res = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query(`UPDATE search_negatives SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]);
        if (r.rowCount) await emitEvent(c, tenantId, "search_negative", id, "search.negative.deleted", {});
        return r;
      },
      { modules: ["search"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("negative not found");
    await writeActivity(tenantId, req.principal.userId, "deleted", "search_negative", id, {});
    return { ok: true };
  }

  // AI negative-keyword proposal (design §07: "Search-term → negative classification"; §12 SM-18:
  // "negative AI drafts"). Human-submitted search terms (paste/CSV — no live search-term sync exists
  // yet, that is SM-20's job) are classified in ONE gateway call (bounded MAX_NEGATIVE_TERMS, the
  // SM-32 lesson) into proposed negative-keyword rows, source='ai'. The AI's own text can only ever
  // select FROM the submitted term list — parseNegativesProposal (sem-drafts.ts) drops anything else,
  // and this endpoint enforces the same rule a second, independent time by only ever inserting
  // candidates that parser already validated against `terms`.
  @Post("campaigns/:id/negatives/propose")
  @HttpCode(200)
  async proposeNegatives(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { terms?: unknown[]; text?: string },
  ) {
    assertUuid(id, "campaign id");
    let terms: string[];
    if (Array.isArray(body?.terms)) {
      terms = body.terms.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim());
    } else if (typeof body?.text === "string" && body.text.trim()) {
      terms = parseKeywordImport(body.text).map((r) => r.keyword);
    } else {
      terms = [];
    }
    terms = [...new Set(terms)];
    if (terms.length === 0) throw new BadRequestException("terms or text required (one search term per line, or a terms array)");
    if (terms.length > MAX_NEGATIVE_TERMS) {
      throw new BadRequestException(`submitted ${terms.length} terms, exceeding the ${MAX_NEGATIVE_TERMS}-term cap per request`);
    }
    const campaign = await withTenants([tenantId], (c) => campaignRow(c, id), { modules: ["search"] });
    if (!campaign) throw new NotFoundException("campaign not found");
    await authorize(req.principal, { kind: "resource_search_campaign", tenantId, module: "search" }, "create");

    const campaignName = await withTenants(
      [tenantId],
      async (c) => (await c.query<{ name: string }>(`SELECT name FROM search_campaigns WHERE id = $1`, [id])).rows[0]?.name ?? "campaign",
      { modules: ["search"] },
    );

    let candidates: { term: string; matchType: string; reason: string }[];
    let draftedVia: "ai" | "fallback";
    let model: string | null = null;
    try {
      const completion = await completeViaGateway(buildNegativesProposalPrompt(campaignName, terms));
      model = completion.provider ?? null;
      ({ candidates, draftedVia } = parseNegativesProposal(completion.text, terms));
    } catch {
      ({ candidates, draftedVia } = parseNegativesProposal(null, terms));
    }

    const createdIds = await withTenants(
      [tenantId],
      async (c) => {
        const ids: string[] = [];
        for (const cand of candidates) {
          const negId = newId();
          await c.query(
            `INSERT INTO search_negatives (id, tenant_id, campaign_id, term, match_type, source, status, origin_site)
             VALUES ($1,$2,$3,$4,$5,'ai','proposed',$6)`,
            [negId, tenantId, id, cand.term, cand.matchType, config.originSite],
          );
          ids.push(negId);
        }
        if (ids.length > 0) await emitEvent(c, tenantId, "search_campaign", id, "search.negatives.proposed", { proposed: ids.length });
        return ids;
      },
      { modules: ["search"] },
    );
    await writeActivity(tenantId, req.principal.userId, "ai_proposed", "search_campaign", id, {
      proposed: createdIds.length, submitted: terms.length, draftedVia,
    });
    return { proposed: createdIds.length, submitted: terms.length, candidates, draftedVia, model };
  }

  // ============================================================== SEM: CHANGE PROPOSALS ============
  // design §04/§07 "the dual-mode execution artifact". THIS TICKET creates proposals and lets a human
  // approve/dismiss them — it NEVER executes one. 'applied' is reachable only via SM-30 (manual
  // mark-applied, an export-then-confirm flow) or SM-21 (api-mode, one-shot WS4 approvalId).
  @Get("campaigns/:id/change-proposals")
  async listChangeProposals(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Query("status") status?: string,
  ) {
    assertUuid(id, "campaign id");
    const campaign = await withTenants([tenantId], (c) => campaignRow(c, id), { modules: ["search"] });
    if (!campaign) throw new NotFoundException("campaign not found");
    await authorize(req.principal, { kind: "resource_search_campaign", id, tenantId, module: "search" }, "read");
    const params: unknown[] = [id];
    const clauses = ["campaign_id = $1", "deleted_at IS NULL"];
    if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, campaign_id AS "campaignId", kind, payload, status, mode, approval_id AS "approvalId",
                export_file_id AS "exportFileId", proposed_by AS "proposedBy", approved_by AS "approvedBy",
                applied_by AS "appliedBy", applied_at AS "appliedAt", created_at, updated_at
         FROM search_change_proposals WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 500`,
        params,
      ),
      { modules: ["search"] },
    );
    return rows.rows;
  }

  @Post("campaigns/:id/change-proposals")
  @HttpCode(201)
  async createChangeProposal(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { kind?: string; payload?: Record<string, unknown>; mode?: string },
  ) {
    assertUuid(id, "campaign id");
    if (!body?.kind || !CHANGE_PROPOSAL_KINDS.has(body.kind)) {
      throw new BadRequestException("kind must be one of launch|pause|budget|bid|negatives_batch|ads_batch");
    }
    if (!body?.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
      throw new BadRequestException("payload required (the exact intended change, as an object)");
    }
    if (body?.mode && !CHANGE_PROPOSAL_MODES.has(body.mode)) throw new BadRequestException("mode must be manual|api");
    const campaign = await withTenants([tenantId], (c) => campaignRow(c, id), { modules: ["search"] });
    if (!campaign) throw new NotFoundException("campaign not found");
    await authorize(req.principal, { kind: "resource_search_campaign", tenantId, module: "search" }, "propose_change");
    const proposalId = newId();
    await withTenants(
      [tenantId],
      async (c) => {
        await c.query(
          `INSERT INTO search_change_proposals
             (id, tenant_id, campaign_id, kind, payload, status, mode, proposed_by, origin_site)
           VALUES ($1,$2,$3,$4,$5,'proposed',$6,$7,$8)`,
          [proposalId, tenantId, id, body.kind, JSON.stringify(body.payload), body?.mode ?? "manual", req.principal.userId, config.originSite],
        );
        await emitEvent(c, tenantId, "search_change_proposal", proposalId, "search.campaign.proposed", { campaignId: id, kind: body.kind });
      },
      { modules: ["search"] },
    );
    await writeActivity(tenantId, req.principal.userId, "proposed", "search_change_proposal", proposalId, { campaignId: id, kind: body.kind });
    return { id: proposalId };
  }

  @Get("change-proposals/:id")
  async getChangeProposal(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    assertUuid(id, "change proposal id");
    await authorize(req.principal, { kind: "resource_search_campaign", id, tenantId, module: "search" }, "read");
    const row = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, campaign_id AS "campaignId", kind, payload, status, mode, approval_id AS "approvalId",
                export_file_id AS "exportFileId", proposed_by AS "proposedBy", approved_by AS "approvedBy",
                applied_by AS "appliedBy", applied_at AS "appliedAt", created_at, updated_at
         FROM search_change_proposals WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      ),
      { modules: ["search"] },
    );
    if (!row.rows[0]) throw new NotFoundException("change proposal not found");
    return row.rows[0];
  }

  // Status transitions THIS TICKET owns: proposed -> approved | dismissed, approved -> dismissed.
  // 'applied' is NEVER settable here (SM-30's manual mark-applied / SM-21's api-mode execute own that
  // transition exclusively) — no live side effect exists in this ticket, by design. payload/kind/mode
  // are only editable while status='proposed' (design §04: payload is "hashed for approval match" —
  // mutating it after approval would silently invalidate whatever hash SM-21 checks against). The
  // final UPDATE is guarded by `AND status = <the status this handler read>` so two concurrent
  // approve/dismiss requests on the same proposal can't both "succeed" against a stale read.
  @Patch("change-proposals/:id")
  @HttpCode(200)
  async updateChangeProposal(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { status?: string; payload?: Record<string, unknown>; mode?: string },
  ) {
    assertUuid(id, "change proposal id");
    if (body?.status === "applied") {
      throw new BadRequestException("'applied' cannot be set here — it is stamped only by the manual mark-applied flow (SM-30) or api-mode execution (SM-21)");
    }
    if (body?.payload !== undefined && (typeof body.payload !== "object" || Array.isArray(body.payload))) {
      throw new BadRequestException("payload must be an object");
    }
    if (body?.mode && !CHANGE_PROPOSAL_MODES.has(body.mode)) throw new BadRequestException("mode must be manual|api");
    const existing = await withTenants([tenantId], (c) => changeProposalRow(c, id), { modules: ["search"] });
    if (!existing) throw new NotFoundException("change proposal not found");
    if (body?.status && !(CHANGE_PROPOSAL_TRANSITIONS[existing.status] ?? []).includes(body.status)) {
      throw new BadRequestException(`cannot move a '${existing.status}' proposal to '${body.status}'`);
    }
    if ((body?.payload !== undefined || body?.mode !== undefined) && existing.status !== "proposed") {
      throw new BadRequestException(`payload/mode can only be edited while status='proposed' (this proposal is '${existing.status}')`);
    }
    await authorize(req.principal, { kind: "resource_search_campaign", id, tenantId, module: "search" }, "update");
    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [id];
    if (body?.payload !== undefined) { params.push(JSON.stringify(body.payload)); sets.push(`payload = $${params.length}`); }
    if (body?.mode) { params.push(body.mode); sets.push(`mode = $${params.length}`); }
    if (body?.status) {
      params.push(body.status);
      sets.push(`status = $${params.length}`);
      if (body.status === "approved") { params.push(req.principal.userId); sets.push(`approved_by = $${params.length}`); }
    }
    const guardParamIdx = params.length + 1;
    params.push(existing.status);
    const res = await withTenants(
      [tenantId],
      (c) => c.query(
        `UPDATE search_change_proposals SET ${sets.join(", ")} WHERE id = $1 AND deleted_at IS NULL AND status = $${guardParamIdx}`,
        params,
      ),
      { modules: ["search"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("change proposal not found or was modified concurrently");
    await writeActivity(tenantId, req.principal.userId, "updated", "search_change_proposal", id, body ?? {});
    return { id };
  }
}
