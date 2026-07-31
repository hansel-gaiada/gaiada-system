// Search-marketing ('search') module contract (SM-02; docs/blueprints/seo-sem-design.md §04/§07/
// §09/§11). The ROUTES live in SearchController; this object carries the registry/rollup metadata
// (rollupProviders, permissions, customFieldTargets, mcpTools, migrations, uiManifest) that the
// engine + registry + hub tool-def aggregation consume — same split as hrModule/index.ts.
//
// Every rollupProvider.compute() below runs under `withTenants([tenantId], fn, {modules:['search']})`
// (rollups/engine.ts's per-module invocation), so the third wall (app_module_allowed('search'),
// 0034) is open for the duration of the call — plain SELECTs against search_* tables just work.
// The metrics against audits/rank_snapshots/provider_calls/campaign_metrics_daily/reports are REAL
// queries against tables SM-01 already created; they read zero rows until SM-07/08/14/16/17/18/22
// start writing into them — nothing here is a stub, the numbers just start at 0 and light up as
// later tickets land, exactly like every other module's rollups did before their write paths shipped.
import { config } from "../../config";
import type { ModuleContract, RollupProvider } from "../contract";
import {
  handleAiVisibilityChanged,
  handleAuditCompleted,
  handleAuditRegression,
  handleBudgetOverspend,
  handleBudgetThreshold,
  handleCampaignApplied,
  handleCampaignProposed,
  handleIncurredCost,
  handleRankDropped,
  handleReportDelivered,
  handleReportReady,
} from "./notifications";

const searchRollups: RollupProvider = {
  metrics: [
    { metricKey: "search.engagements.active", description: "Active search-marketing engagements", unit: "count", isMonetary: false, aggregationRule: "sum" },
    { metricKey: "search.rank.top10", description: "Tracked keywords currently ranking top-10 (latest snapshot per keyword/engine/device)", unit: "count", isMonetary: false, aggregationRule: "sum" },
    { metricKey: "search.audits.critical_open", description: "Open critical audit findings", unit: "count", isMonetary: false, aggregationRule: "sum" },
    { metricKey: "search.provider_cost.month", description: "Provider data-cost spend this month (USD, minor units)", unit: "money_minor", isMonetary: true, aggregationRule: "sum" },
    { metricKey: "search.sem_spend.month", description: "Imported SEM ad spend this month, per currency", unit: "money_minor", isMonetary: true, aggregationRule: "sum" },
    { metricKey: "search.reports.delivered", description: "Engagement reports delivered", unit: "count", isMonetary: false, aggregationRule: "sum" },
  ],
  compute: async (client, _tenantId, period) => {
    const active = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM search_engagements WHERE deleted_at IS NULL AND status = 'active'`,
    );
    // Latest snapshot per (keyword_id, engine, device); count those currently in positions 1-10.
    // SM-46a (design addendum §A4.7 enumeration): mode-filtered, same reason and same shape as the
    // `provider_cost.month` filter below — this is an EXEC-facing rollup, so an unfiltered count would
    // blend simulated and real rank history the moment a writer lands (SM-14). Harmless today only
    // because search_rank_snapshots is empty in every env; that safety expires silently at SM-14, so
    // the filter lands now rather than later (§4d fail-open class).
    const top10 = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM (
         SELECT DISTINCT ON (keyword_id, engine, device) position
         FROM search_rank_snapshots
         WHERE simulated = $1
         ORDER BY keyword_id, engine, device, captured_at DESC
       ) latest WHERE latest.position BETWEEN 1 AND 10`,
      [config.search.providerMode === "simulate"],
    );
    const criticalOpen = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM search_audit_findings WHERE severity = 'critical' AND status = 'open'`,
    );
    // SM-33: mode-filtered, for the same reason the stop-loss sums are (design addendum §A4.1).
    // This metric is `isMonetary` and feeds the EXEC cross-company money rollup, so without the
    // filter a month spent demoing would report synthetic dollars as real spend — an unlabelled
    // plausible number in the one surface least able to sanity-check it. Filtering on the CURRENT
    // mode is correct in both directions: a live instance cannot create simulated rows at all (the
    // boot-time mutual exclusion in main.ts), so the only way they exist under live mode is a
    // formerly-simulated environment, whose synthetic history must not be counted as cash; and a
    // simulate-mode instance is a demo throughout, where reporting the simulated total is the
    // useful and honest answer.
    //
    // SM-50 (addendum §A11.2 #5) — STATUS-BLIND ON PURPOSE, stated so no future reader "fixes" it:
    // this sum has no status predicate, so it INCLUDES `incurred` rows — charges a vendor made for
    // calls that returned no data. That inclusion is CORRECT: this metric is cost-to-serve, and a
    // charge that bought nothing is still a cost. Excluding it would under-report real spend to the
    // exec rollup, which is the one surface least able to sanity-check the figure. If you want to see
    // work delivered rather than money spent, count `completed` rows on a DIFFERENT metric (§A11.2 #12
    // carries that standing note into SM-22) — do not narrow this one.
    const providerCost = await client.query<{ n: string }>(
      `SELECT COALESCE(sum(cost_usd), 0) AS n FROM search_provider_calls
        WHERE date_trunc('month', created_at) = date_trunc('month', $1::date)
          AND simulated = $2`,
      [period, config.search.providerMode === "simulate"],
    );
    const semSpendByCurrency = await client.query<{ currency: string; n: string }>(
      `SELECT COALESCE(currency, 'USD') AS currency, COALESCE(sum(cost_minor), 0) AS n
         FROM search_campaign_metrics_daily
        WHERE date_trunc('month', date) = date_trunc('month', $1::date)
        GROUP BY COALESCE(currency, 'USD')`,
      [period],
    );
    const delivered = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM search_reports WHERE deleted_at IS NULL AND status = 'delivered'`,
    );
    return [
      { metricKey: "search.engagements.active", numerator: Number(active.rows[0].n) },
      { metricKey: "search.rank.top10", numerator: Number(top10.rows[0].n) },
      { metricKey: "search.audits.critical_open", numerator: Number(criticalOpen.rows[0].n) },
      // provider cost is numeric(12,6) USD; rollups carry money in MINOR units (cents).
      { metricKey: "search.provider_cost.month", numerator: Math.round(Number(providerCost.rows[0].n) * 100), currency: "USD" },
      ...semSpendByCurrency.rows.map((r) => ({
        metricKey: "search.sem_spend.month",
        numerator: Number(r.n),
        currency: r.currency,
        dimensions: { currency: r.currency },
      })),
      { metricKey: "search.reports.delivered", numerator: Number(delivered.rows[0].n) },
    ];
  },
};

export const searchModule: ModuleContract = {
  key: "search",
  migrations: [
    "0034_module_search.sql", "0035_integration_connections_search_providers.sql",
    "0045_search_audit_ingest.sql", "0046_search_ai_drafts.sql",
    "0047_search_provider_simulation.sql", "0048_search_capability_provenance.sql",
    // SM-50 (addendum §A11): `incurred` status + `vendor_ref`. Listed here at write time on purpose —
    // 0047 was omitted from this array and had to be fixed after the fact.
    "0053_search_provider_incurred_cost.sql",
    // SM-25a (addendum §A12): in-flight Google authorization requests (sealed PKCE verifier,
    // single-use). Registered here at write time for the same reason 0053 says so — 0047's omission
    // from this array had to be fixed after the fact.
    "0060_search_google_oauth_states.sql",
    // SM-25b (addendum §A12): GSC Search Analytics + GA4 runReport performance tables. Registered
    // here AT WRITE TIME, for the identical reason the two comments immediately above say so — 0047's
    // omission from this array is this module's own repeated lesson, not a one-off.
    "0061_search_google_performance.sql",
    // SM-20 (design §12): search-terms sync — the Ads-Scripts webhook's per-term daily table.
    // Registered here AT WRITE TIME, same standing lesson as every comment immediately above.
    "0062_search_search_terms.sql",
    // SM-21 (design §07, D-6): the api-mode execution record — UNIQUE (approval_id) is the one-shot
    // consumption of the WS4 approval. Registered here AT WRITE TIME, same standing lesson as every
    // comment immediately above (0047's omission from this array is this module's own repeated bug).
    "0064_search_change_executions.sql",
    // SM-25c (addendum §A12): additive `simulated`/`connection_id` provenance columns on
    // search_campaign_metrics_daily for the Ads OAuth read pull. Registered here by the SM-21 agent
    // at the coordinator's request because this file was held by that ticket — the FILE exists on
    // disk (verified by `ls migrations/` at write time), and an unregistered migration simply never
    // runs, which is 0047's standing lesson repeated one entry above.
    "0065_search_campaign_metrics_provenance.sql",
    // SM-26 (tracker §6bp Ruling 6): the pre-send Google Ads mutate operation manifest — written
    // before any Ads mutate HTTP call so positional response parsing has something of ours (not the
    // vendor's) to be paired against. Registered here AT WRITE TIME, same standing lesson as every
    // comment immediately above (0047's omission from this array is this module's own repeated bug).
    "0066_search_ads_execution_manifest.sql",
  ],
  permissions: [
    { key: "search:engagement:read", description: "View search-marketing engagements/properties/KPI targets" },
    { key: "search:engagement:write", description: "Create/update engagements, properties and KPI targets" },
    { key: "search:scope:write", description: "Set an engagement's tool-scope config and provider budget cap (D-11)" },
    { key: "search:keyword:write", description: "Import/edit keyword sets and keywords" },
    { key: "search:rank:read", description: "View rank-tracking snapshots" },
    { key: "search:audit:run", description: "Trigger a technical/CWV/content audit" },
    { key: "search:brief:write", description: "Create/edit content briefs" },
    { key: "search:campaign:write", description: "Create/edit SEM campaigns, ad groups, ads and negatives" },
    { key: "search:campaign:launch", description: "Mark a manual-mode change proposal applied, or execute an api-mode one (covers both dual-mode twins)" },
    { key: "search:content:publish", description: "Publish drafted content to a client's live site (WebDesk seam)" },
    { key: "search:report:write", description: "Draft/edit an engagement report" },
    { key: "search:report:approve", description: "Approve and delivery-gate an engagement report" },
    { key: "search:ledger:read", description: "View the provider usage/cost ledger" },
    { key: "search:provider:admin", description: "Override a budget stop-loss (elevated, audited)" },
  ],
  customFieldTargets: ["search_engagement", "search_campaign"],
  // Per §07: reads are minAssurance 'low'; every write:true tool (paid pulls, AI drafts, live
  // mutations, exports) is 'verified' (matches pm.runTracker / hr.fileLeave write-tool precedent).
  // search.listEngagements (SM-02) and search.clusterKeywords (SM-09) have real HTTP bindings —
  // every other tool below is a genuine informational stub: the shape mcp-hub aggregates today so
  // `/mcp/tool-defs` lists `search.*` now, with method/pathTemplate added by the ticket that
  // implements its handler (noted per tool). Paid pulls are write:true+impact:'medium' EVEN
  // THOUGH they're semantically reads (design §07/D-5 — spending money is a mutation);
  // live-account mutations are always impact:'high'.
  //
  // ⚠️ CORRECTED per addendum §A13.6 (tracker §6ad): this comment used to add "routes through the
  // D14 automation-write gate", and that clause is SUPERSEDED. It was never true and it was
  // actively misleading, because `impact` is never reached for an n8n caller: every automation
  // principal is minted `assurance: "low"` by construction (mcp-hub/src/principal.ts), and
  // `permits()` checks assurance BEFORE both the allow-list and the impact gate — so a `verified`
  // write tool is refused outright, long before `impact` is consulted.
  //
  // The stale clause did real harm: an agent read it as licence to lower `minAssurance` so an n8n
  // flow could reach a paid pull, and left that instruction in a workflow file for the next agent
  // (removed by SM-55). `impact:'medium'` REMAINS — as risk classification for agent-surface
  // gating, approvals rows and console display — but it is NOT a claim that automation can enter
  // here. **Automation must never trigger a paid pull**; recurring cadence is a platform-side
  // scheduler job (SM-54) authorized by the human-written `tool_scope`, and no allow-list may ever
  // include a money-spending tool.
  mcpTools: [
    {
      name: "search.listEngagements",
      description: "List the served company's search-marketing engagements",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/search/engagements",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] },
    },
    {
      name: "search.rankSummary",
      description: "Rank-tracking history for a property, newest first — each row carries its own provider/simulated badge (SM-14; real binding)",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/search/properties/:propertyId/rank-snapshots",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, propertyId: { type: "string" } },
        required: ["tenantId", "propertyId"],
      },
    },
    {
      name: "search.auditSummary",
      description: "Latest audit summary for a property (stub — real binding lands with SM-08)",
      minAssurance: "low",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, propertyId: { type: "string" } },
        required: ["tenantId", "propertyId"],
      },
    },
    {
      name: "search.ledgerSummary",
      description: "Provider usage/cost ledger summary for an engagement (stub — real binding lands with SM-04/SM-17)",
      minAssurance: "low",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, engagementId: { type: "string" } },
        required: ["tenantId", "engagementId"],
      },
    },
    {
      name: "search.keywordResearch",
      description: "Paid keyword volume/suggestions/difficulty pull, scope+ledger-checked (stub — real dispatch lands with SM-04/SM-05)",
      minAssurance: "verified",
      write: true,
      impact: "medium",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, engagementId: { type: "string" }, keywords: { type: "array", items: { type: "string" } } },
        required: ["tenantId", "engagementId", "keywords"],
      },
    },
    {
      name: "search.pullRanks",
      description: "Dispatch a rank-tracking pull for an engagement's tracked keywords, through the full scope/budget/pillar choke-point (SM-14; real dispatch)",
      minAssurance: "verified",
      write: true,
      impact: "medium",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/search/engagements/:engagementId/rank-pull",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" }, engagementId: { type: "string" } }, required: ["tenantId", "engagementId"] },
    },
    {
      name: "search.pullBacklinks",
      description: "Dispatch a backlink snapshot pull for an engagement's property, through the full scope/budget/pillar choke-point (SM-16; real dispatch)",
      minAssurance: "verified",
      write: true,
      impact: "medium",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/search/engagements/:engagementId/backlinks-pull",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" }, engagementId: { type: "string" } }, required: ["tenantId", "engagementId"] },
    },
    {
      name: "search.pullAiVisibility",
      description: "Dispatch a GEO/AI-visibility snapshot pull for an engagement's property (scope-configured queries, or an explicit override), through the full scope/budget/pillar choke-point (SM-16; real dispatch)",
      minAssurance: "verified",
      write: true,
      impact: "medium",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/search/engagements/:engagementId/ai-visibility-pull",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" }, engagementId: { type: "string" },
          queries: { type: "array", items: { type: "string" } },
        },
        required: ["tenantId", "engagementId"],
      },
    },
    {
      name: "search.runAudit",
      description: "Trigger a technical/CWV/content/links/geo audit job ($0, self-hosted crawlers; stub — real dispatch lands with SM-07/SM-08)",
      minAssurance: "verified",
      write: true,
      impact: "low",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, propertyId: { type: "string" }, kind: { type: "string" } },
        required: ["tenantId", "propertyId", "kind"],
      },
    },
    {
      name: "search.clusterKeywords",
      description: "AI-cluster + intent-tag a keyword set via ai-gateway-go /embed + /complete (Hermes); draft only, no live side effect (SM-09)",
      minAssurance: "verified",
      write: true,
      impact: "low",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/search/keyword-sets/:setId/cluster",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" }, setId: { type: "string" } }, required: ["tenantId", "setId"] },
    },
    {
      name: "search.draftBrief",
      description: "AI-draft a content brief grounded in the property's own crawl/keyword data + WS8 knowledge.search RAG (Hermes; draft only, SM-10)",
      minAssurance: "verified",
      write: true,
      impact: "low",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/search/properties/:propertyId/briefs",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, propertyId: { type: "string" }, topic: { type: "string" } },
        required: ["tenantId", "propertyId", "topic"],
      },
    },
    {
      name: "search.proposeNegatives",
      description: "AI-classify human-submitted search terms into proposed negative-keyword candidates (Hermes; draft only, no live side effect, SM-18)",
      minAssurance: "verified",
      write: true,
      impact: "low",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/search/campaigns/:campaignId/negatives/propose",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" }, campaignId: { type: "string" },
          terms: { type: "array", items: { type: "string" } }, text: { type: "string" },
        },
        required: ["tenantId", "campaignId"],
      },
    },
    {
      name: "search.draftReport",
      description: "AI-draft (Hermes) an engagement's periodic report narrative + metrics snapshot; draft only, never past status='draft' (SM-10; SM-22 owns review/approve/deliver)",
      minAssurance: "verified",
      write: true,
      impact: "low",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/search/engagements/:engagementId/reports",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, engagementId: { type: "string" }, period: { type: "string" } },
        required: ["tenantId", "engagementId", "period"],
      },
    },
    {
      // SM-30: real binding. Exports an APPROVED, mode='manual' change proposal as an Ads-Editor-
      // ready CSV `files` artifact (no live side effect — the manual-mode twin only; an api-mode
      // proposal is refused here and executes exclusively via SM-21's one-shot approvalId path).
      // Marking a proposal applied ("a human attests they applied it by hand") is DELIBERATELY NOT
      // an MCP tool at all — see search.controller.ts's markChangeProposalApplied for why an
      // automation principal self-attesting a human action would be a lie-generator, not a shortcut.
      name: "search.exportProposal",
      description: "Export an approved, manual-mode change proposal as an Ads-Editor-ready CSV artifact (no live side effect, SM-30; real binding)",
      minAssurance: "verified",
      write: true,
      impact: "low",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/search/change-proposals/:proposalId/export",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" }, proposalId: { type: "string" } }, required: ["tenantId", "proposalId"] },
    },
    // SM-21: all three now have REAL method/pathTemplate bindings onto the ONE api-execution route
    // (`POST change-proposals/:proposalId/apply-api`). Three tool names, one route, deliberately:
    // design §07's tool table names the three by risk class, and the route derives BOTH its Cerbos
    // action and its operation set from the proposal's own `kind` — a caller cannot pick which
    // semantics apply by choosing a tool name, so three routes would be three ways to reach one
    // guard rather than three guards. `sem-apply.ts`'s `toolNameForKind` is the same mapping in
    // reverse, and it is what gets recorded on the WS4 approval row so a human deciding it in the
    // inbox sees which declared high-impact tool they are authorizing.
    //
    // impact:'high' is unchanged and, per addendum §A13.6, is a RISK CLASSIFICATION — not a claim
    // that automation can enter here. An automation principal is minted `assurance:'low'` by
    // construction (mcp-hub/src/principal.ts) and `permits()` checks assurance BEFORE impact, so a
    // `verified` write tool is refused outright. The suspension these tools describe is filed by the
    // ROUTE itself (against `automation_approvals`, WS4's existing store) rather than by the hub
    // gate — which is why the route suspends identically for a human console caller: D-6 holds
    // humans to the automation standard on this path.
    {
      name: "search.applyNegatives",
      description: "Execute an approved api-mode negatives-batch change proposal against the live ad account — suspends into WS4 on first call, executes exactly once when the approval is consumed (SM-21; real binding, live push lands with SM-26)",
      minAssurance: "verified",
      write: true,
      impact: "high",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/search/change-proposals/:proposalId/apply-api",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" }, proposalId: { type: "string" } }, required: ["tenantId", "proposalId"] },
    },
    {
      name: "search.setBudget",
      description: "Execute an approved api-mode budget change proposal against the live ad account — suspends into WS4 on first call, executes exactly once when the approval is consumed (SM-21; real binding, live push lands with SM-26)",
      minAssurance: "verified",
      write: true,
      impact: "high",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/search/change-proposals/:proposalId/apply-api",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" }, proposalId: { type: "string" } }, required: ["tenantId", "proposalId"] },
    },
    {
      name: "search.launchCampaign",
      description: "Execute an approved api-mode launch/pause/bid/ads-batch change proposal against the live ad account — suspends into WS4 on first call, executes exactly once when the approval is consumed (SM-21; real binding, live push lands with SM-26)",
      minAssurance: "verified",
      write: true,
      impact: "high",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/search/change-proposals/:proposalId/apply-api",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" }, proposalId: { type: "string" } }, required: ["tenantId", "proposalId"] },
    },
    {
      name: "search.publishContent",
      description: "Publish drafted content to a client's live WebDesk-hosted site (stub — real execution lands post-WebDesk-P3, ALWAYS suspends to WS4)",
      minAssurance: "verified",
      write: true,
      impact: "high",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" }, propertyId: { type: "string" }, docId: { type: "string" } }, required: ["tenantId", "propertyId", "docId"] },
    },
  ],
  rollupProviders: [searchRollups],
  // Dept slug 'seo' (D-10, ratified 2026-07-23): universal Home·Work·Connections spine + three
  // craft-group primary-strip divisions (Accounts/Optimize/Campaigns, design §08). Routes match
  // the console's own /departments/seo/* mounting convention.
  uiManifest: [
    { label: "SEO — Home", path: "/departments/seo" },
    { label: "Engagements", path: "/departments/seo/engagements" },
    { label: "Reports", path: "/departments/seo/reports" },
    { label: "Site Audit", path: "/departments/seo/audit" },
    { label: "Keywords", path: "/departments/seo/keywords" },
    { label: "Rankings", path: "/departments/seo/rankings" },
    { label: "Content Briefs", path: "/departments/seo/briefs" },
    { label: "AI Visibility", path: "/departments/seo/ai-visibility" },
    { label: "Planner", path: "/departments/seo/planner" },
    { label: "Ads Studio", path: "/departments/seo/ads" },
    { label: "Search Terms", path: "/departments/seo/search-terms" },
    { label: "Pacing", path: "/departments/seo/pacing" },
  ],
  // SM-13 (design §09/§12): every §09 event type gets a bell notification with a deep-link href —
  // see notifications.ts's file header for the full type -> href table and the one type
  // (search.backlinks.lost_spike) deliberately left unwired (no Backlinks tab exists yet).
  eventHandlers: {
    "search.provider.budget_threshold": handleBudgetThreshold,
    // SM-50 (addendum §A11.2 #11): a vendor charge that delivered no data must reach a human, not only
    // the budget sums. Producer: providers/dispatch.ts's compensating write.
    "search.provider.incurred_cost": handleIncurredCost,
    "search.audit.completed": handleAuditCompleted,
    "search.audit.regression": handleAuditRegression,
    "search.rank.dropped": handleRankDropped,
    "search.budget.overspend": handleBudgetOverspend,
    "search.report.ready_for_review": handleReportReady,
    "search.report.delivered": handleReportDelivered,
    "search.campaign.proposed": handleCampaignProposed,
    // SM-73 (§6bp Ruling 2): all four terminal outcomes (applied/partial/failed/indeterminate)
    // wired here because partial and indeterminate are the ones an operator must not miss.
    // Producer: search.controller.ts applyProposalApi.
    "search.campaign.applied": handleCampaignApplied,
    "search.ai_visibility.changed": handleAiVisibilityChanged,
  },
  // routes: served by SearchController in the NestJS port.
};
