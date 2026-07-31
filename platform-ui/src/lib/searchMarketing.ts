// search-marketing (SEO · SEM · GEO) BFF client — the typed surface the `seo`
// department console renders from. SM-11.
//
// NOT named `search.ts`: that name is already taken by the app-wide global-search
// helper (`lib/search.ts`, Plan 5). This module is the search-MARKETING module
// client; the two are unrelated and must not be confused.
//
// Types + pure helpers live in `lib/searchMarketingShared.ts` and are re-exported below —
// they were split out because THIS file imports `lib/platform.ts` (`"server-only"`), and a
// client component (SM-29's <ScopeEditor>) that needs even a single constant from here would
// fail the Next.js build with "You're importing a component that needs server-only". Import
// from the shared module directly in client code; server code can keep importing from here.
//
// BFF CONTRACT (platform-nest `modules/search/search.controller.ts`, mounted at
// /api/:t/modules/search/*). Built today — SM-01/02/04/08/09 landed:
//   GET/POST      properties                          -> SearchProperty[] / {id}
//   GET/PATCH/DEL properties/:id                      -> SearchProperty
//   GET/POST      engagements                          -> SearchEngagement[] / {id}
//   GET/PATCH/DEL engagements/:id                      -> SearchEngagement
//   GET/PUT       engagements/:id/scope                -> EngagementScope {scopePreset,toolScope,providerBudgetUsd}
//   GET           engagements/:id/cost-projection      -> CostProjection
//   GET           engagements/:id/ledger                -> EngagementLedger (SM-17, ledger/cost surface)
//   GET/POST      kpi-targets                          -> SearchKpiTarget[] / {id}
//   GET/PATCH/DEL kpi-targets/:id                      -> SearchKpiTarget
//   GET           audits                                -> SearchAudit[] (?propertyId=)
//   GET           audits/:id/findings                   -> AuditFinding[]
//   PATCH         findings/:id                          -> {id,status} (write; see searchMarketingActions.ts)
//   GET/POST      keyword-sets                          -> SearchKeywordSet[] / {id} (?engagementId=)
//   GET/DEL       keyword-sets/:id                      -> SearchKeywordSet
//   POST          keyword-sets/:id/import               -> {imported,submitted,duplicates} (write)
//   GET           keyword-sets/:id/keywords              -> SearchKeyword[]
//   POST          keyword-sets/:id/embed                 -> {mode,embedded} (write)
//   POST          keyword-sets/:id/cluster               -> {mode,clusters,skipped} (write)
//   PATCH/DEL     keywords/:id                          -> {id} (write, not used by this console yet)
//   GET           engagements/:id/campaigns              -> SearchCampaign[] (?status=)  (SM-18/SM-47)
//   GET/PATCH/DEL campaigns/:id                          -> SearchCampaign
//   POST          engagements/:id/campaigns/generate-plan -> CampaignPlanResult (write; provenance)
//   GET           campaigns/:id/ad-groups                -> SearchAdGroup[]
//   GET/PATCH/DEL ad-groups/:id                          -> SearchAdGroup
//   GET           ad-groups/:id/ads                       -> SearchAd[]
//   POST          ad-groups/:id/ads/draft                 -> RsaDraftResponse (write; AI, fail-soft)
//   PATCH/DEL     ads/:id                                -> {id} (write; see searchMarketingActions.ts)
//   GET           campaigns/:id/negatives                -> SearchNegative[] (?status=)
//   PATCH/DEL     negatives/:id                          -> {id} (write)
//   POST          campaigns/:id/negatives/propose         -> NegativesProposalResponse (write; AI)
//   GET           campaigns/:id/change-proposals          -> SearchChangeProposal[] (?status=)
//   GET/PATCH     change-proposals/:id                    -> SearchChangeProposal (write; never 'applied')
//   POST          change-proposals/:id/export             -> ChangeProposalExportResult (write; SM-30, manual mode only)
//   POST          change-proposals/:id/mark-applied       -> MarkAppliedResult (write; SM-30, elevated `search.campaign.launch`)
//   POST          engagements/:id/rank-pull                -> RankPullBatchResult (write; SM-14, metered)
//   POST          keyword-sets/:id/metrics-pull            -> MetricsPullBatchResult (write; SM-14, metered)
//   GET           properties/:id/rank-snapshots            -> RankSnapshot[] (badge, not filter)
//   GET/POST      google/connections[/:provider/authorize] -> GoogleConnectionView[] / StartedGoogleAuthorization (SM-25a)
//   GET           google/connections/:id                   -> GoogleConnectionView
//   POST          google/connections/:id/refresh|revoke    -> GoogleConnectionView / GoogleRevokeResult (write)
//   PUT           properties/:id/google-connection/:provider -> {propertyId,provider,connectionId} (write)
//   POST          engagements/:id/gsc-pull|ga4-pull        -> GscPullOutcome / Ga4PullOutcome (write; SM-25b, $0)
//   GET           properties/:id/gsc-performance           -> GscPerformanceRow[] (badge, not filter)
//   GET           properties/:id/gsc-performance/top-queries -> GscTopQueryRow[] (aggregate, real-only default)
//   GET           properties/:id/ga4-metrics                -> Ga4MetricsRow[] (badge, not filter)
//   POST          engagements/:id/gsc-keyword-import        -> GscKeywordImportResult (write; reads OUR OWN GSC rows)
// There is NO ingest-a-new-audit / run-a-crawl route consumed here — POST audits INGESTS an
// already-produced crawler Report (SM-07's job), it does not trigger one; search-crawl-go is a
// separate, out-of-scope service for this module. There is also NO `GET .../clusters` route —
// clustering only writes cluster_id/cluster_label/intent back onto each keyword row, so the
// clustered view is derived client-side from `listKeywords` (see `groupKeywordsByCluster`).
//
// NOT BUILT YET — the tabs that need these render the BackendPending banner
// rather than an empty table that would read as real (empty) data:
//   content briefs (SM-10) · backlinks + ai-visibility CONSOLE TABS (SM-16's backend landed;
//   no UI page reads it yet — same PendingCapability gap Rankings had before SM-14's UI) ·
//   pacing/metrics-daily (SM-22) · live search-term sync (SM-20) · api-mode execution (SM-21)
// Rankings (SM-14) and Google connections + GSC/GA4 (SM-25a/SM-25b) ARE now built and wired — see the
// fetchers above and RankingsPanel.tsx/GoogleConnectionsPanel.tsx/GscGa4Panel.tsx. The ledger/cost
// surface (SM-17) IS built — see `getEngagementLedger` below. SEM read/safe-write surfaces (SM-47)
// ARE built for campaigns/ad-groups/ads/negatives/change-proposals. SM-19 (this ticket) adds:
//   (a) `PaidActionGate` — a pre-commit disclosure (resolved provider, per-run cost ESTIMATE never
//       "actual", real-vs-SIMULATED, engagement-budget projection) wrapping the Rankings tab's
//       metered "Pull ranks now" action, sourced from the SAME `cost-projection` endpoint SM-29's
//       scope editor already reads — no second cost formula (ticket's own binding rule).
//   (b) the manual-mode dual-mode twin for SEM change proposals: `exportChangeProposal` +
//       `markChangeProposalApplied` (SM-30's backend routes) wired into `ChangeProposalsPanel` via
//       `ApplyProposalTwins`, plus a mode picker (manual/api) at proposal-creation time. The
//       AUTOMATED (api) twin renders as an honestly-disabled state — SM-21 (its executor) is still
//       TODO, so an api-mode proposal has NO path to 'applied' from this console today, and the UI
//       says so rather than offering a control that would do nothing.
import { platformFetch, PlatformError } from "@/lib/platform";
import type {
  SearchProperty, SearchEngagement, EngagementScope, CostProjection, SearchKpiTarget, ToolScopeConfig,
  SearchAudit, AuditFinding, SearchKeywordSet, SearchKeyword, EngagementLedger,
  SearchCampaign, SearchAdGroup, SearchAd, SearchNegative, SearchChangeProposal,
  CampaignPlanResult, RsaDraftResponse, NegativesProposalResponse,
  RankSnapshot, GoogleConnectionView,
  GscPerformanceRow, GscTopQueryRow, Ga4MetricsRow,
} from "./searchMarketingShared";

export * from "./searchMarketingShared";

// Absorbs 404 (endpoint/entity absent) and 403 (module not enabled for this
// tenant, or Cerbos denial) so a console tab degrades to its empty/pending state
// instead of erroring the whole page. Mirrors lib/entities.ts.
async function skipUnavailable<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return fallback;
    throw e;
  }
}

/** Single-resource GETs must yield an OBJECT or nothing. A 200 carrying the wrong SHAPE is the
 *  dangerous case: an array is truthy, so a `if (!x) notFound()` guard sails past it and the first
 *  property access crashes the page ("Cannot read properties of undefined"). That is not theoretical
 *  — it is exactly how the engagement detail page died at its QA gate, and a backend contract
 *  violation would reproduce it outside demo mode. Treat a wrong shape as absent and degrade. */
function asObject<T>(v: unknown): T | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as T) : null;
}

/** Mirror of the above for collection GETs: anything that is not an array becomes an empty list,
 *  so a malformed 200 renders the empty state instead of throwing inside `.map()`. */
function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

const base = (t: string) => `/api/${t}/modules/search`;

// ── Properties ───────────────────────────────────────────────────────────────
export const listProperties = async (u: string, t: string) =>
  asArray<SearchProperty>(await skipUnavailable(platformFetch<unknown>(`${base(t)}/properties`, u), []));

export const getProperty = async (u: string, t: string, id: string) =>
  asObject<SearchProperty>(await skipUnavailable(platformFetch<unknown>(`${base(t)}/properties/${id}`, u), null));

// ── Engagements ──────────────────────────────────────────────────────────────
export const listEngagements = async (u: string, t: string) =>
  asArray<SearchEngagement>(await skipUnavailable(platformFetch<unknown>(`${base(t)}/engagements`, u), []));

export const getEngagement = async (u: string, t: string, id: string) =>
  asObject<SearchEngagement>(await skipUnavailable(platformFetch<unknown>(`${base(t)}/engagements/${id}`, u), null));

const EMPTY_SCOPE: EngagementScope = { scopePreset: null, toolScope: {}, providerBudgetUsd: null };

export const getEngagementScope = async (u: string, t: string, id: string): Promise<EngagementScope> =>
  asObject<EngagementScope>(await skipUnavailable(platformFetch<unknown>(`${base(t)}/engagements/${id}/scope`, u), EMPTY_SCOPE)) ?? EMPTY_SCOPE;

export const getCostProjection = async (u: string, t: string, id: string) =>
  asObject<CostProjection>(await skipUnavailable(platformFetch<unknown>(`${base(t)}/engagements/${id}/cost-projection`, u), null));

/** The what-if half of the same endpoint (search.controller.ts: `?toolScope=` prices a CANDIDATE
 *  scope without persisting it) — this is how the scope editor prices a toggle the human hasn't
 *  saved yet, using the SAME estimator dispatch bills with, never a browser-side reimplementation. */
export const getCostProjectionForScope = async (u: string, t: string, id: string, toolScope: ToolScopeConfig) =>
  asObject<CostProjection>(
    await skipUnavailable(
      platformFetch<unknown>(`${base(t)}/engagements/${id}/cost-projection?toolScope=${encodeURIComponent(JSON.stringify(toolScope))}`, u),
      null,
    ),
  );

// SM-17 — the ledger/cost surface. `null` (404/403, degraded per skipUnavailable) means the console
// must render "we don't know" (a permission gap or a not-yet-enabled module), which is a DIFFERENT
// claim from `currentModeRowCount === 0` ("we know, and there is genuinely nothing recorded this
// period") — the two must never be collapsed into the same empty-looking UI state.
export const getEngagementLedger = async (u: string, t: string, id: string) =>
  asObject<EngagementLedger>(await skipUnavailable(platformFetch<unknown>(`${base(t)}/engagements/${id}/ledger`, u), null));

// ── KPI targets ──────────────────────────────────────────────────────────────
export const listKpiTargets = async (u: string, t: string) =>
  asArray<SearchKpiTarget>(await skipUnavailable(platformFetch<unknown>(`${base(t)}/kpi-targets`, u), []));

// ── Site Audit (SM-08, SM-12) ─────────────────────────────────────────────────
export const listAudits = async (u: string, t: string, propertyId?: string) =>
  asArray<SearchAudit>(
    await skipUnavailable(
      platformFetch<unknown>(`${base(t)}/audits${propertyId ? `?propertyId=${encodeURIComponent(propertyId)}` : ""}`, u),
      [],
    ),
  );

export const listAuditFindings = async (u: string, t: string, auditId: string) =>
  asArray<AuditFinding>(await skipUnavailable(platformFetch<unknown>(`${base(t)}/audits/${auditId}/findings`, u), []));

// ── Keywords (SM-09, SM-12) ────────────────────────────────────────────────────
export const listKeywordSets = async (u: string, t: string, engagementId?: string) =>
  asArray<SearchKeywordSet>(
    await skipUnavailable(
      platformFetch<unknown>(`${base(t)}/keyword-sets${engagementId ? `?engagementId=${encodeURIComponent(engagementId)}` : ""}`, u),
      [],
    ),
  );

export const listKeywords = async (u: string, t: string, setId: string) =>
  asArray<SearchKeyword>(await skipUnavailable(platformFetch<unknown>(`${base(t)}/keyword-sets/${setId}/keywords`, u), []));

// ── SEM: campaigns / ad groups / ads / negatives / change proposals (SM-18 backend; SM-47 console) ─
// No live side-effects anywhere on this surface (SM-18's own constraint, enforced server-side):
// campaign/ad/negative/change-proposal status writes are restricted to their ERP-side draft states,
// and 'applied' is refused (400) everywhere — SM-30/SM-19/SM-21 own the actual apply path. This
// console reads and safely writes drafts/proposals only; it must never imply a push to a live ad
// account is possible from here.
export const listCampaigns = async (u: string, t: string, engagementId: string, status?: string) =>
  asArray<SearchCampaign>(
    await skipUnavailable(
      platformFetch<unknown>(`${base(t)}/engagements/${engagementId}/campaigns${status ? `?status=${encodeURIComponent(status)}` : ""}`, u),
      [],
    ),
  );

export const getCampaign = async (u: string, t: string, id: string) =>
  asObject<SearchCampaign>(await skipUnavailable(platformFetch<unknown>(`${base(t)}/campaigns/${id}`, u), null));

export const listAdGroups = async (u: string, t: string, campaignId: string) =>
  asArray<SearchAdGroup>(await skipUnavailable(platformFetch<unknown>(`${base(t)}/campaigns/${campaignId}/ad-groups`, u), []));

export const getAdGroup = async (u: string, t: string, id: string) =>
  asObject<SearchAdGroup>(await skipUnavailable(platformFetch<unknown>(`${base(t)}/ad-groups/${id}`, u), null));

export const listAds = async (u: string, t: string, adGroupId: string) =>
  asArray<SearchAd>(await skipUnavailable(platformFetch<unknown>(`${base(t)}/ad-groups/${adGroupId}/ads`, u), []));

export const listNegatives = async (u: string, t: string, campaignId: string, status?: string) =>
  asArray<SearchNegative>(
    await skipUnavailable(
      platformFetch<unknown>(`${base(t)}/campaigns/${campaignId}/negatives${status ? `?status=${encodeURIComponent(status)}` : ""}`, u),
      [],
    ),
  );

export const listChangeProposals = async (u: string, t: string, campaignId: string, status?: string) =>
  asArray<SearchChangeProposal>(
    await skipUnavailable(
      platformFetch<unknown>(`${base(t)}/campaigns/${campaignId}/change-proposals${status ? `?status=${encodeURIComponent(status)}` : ""}`, u),
      [],
    ),
  );

// SM-19: re-read a single change proposal authoritatively — used by the download-proxy route
// (app/api/search/change-proposals/[id]/export-file) to resolve the CURRENT `exportFileId` server-
// side rather than trust a client-supplied one, same "re-read authoritatively rather than trust the
// echo" convention `saveEngagementScope` already uses for the scope PUT.
export const getChangeProposal = async (u: string, t: string, id: string) =>
  asObject<SearchChangeProposal>(await skipUnavailable(platformFetch<unknown>(`${base(t)}/change-proposals/${id}`, u), null));

// ── Rank tracking (SM-14) ──────────────────────────────────────────────────────
// Raw history — BADGE, not filter (search.controller.ts's own comment): every row keeps its own
// provider/simulated truth across a mode flip, so this never mode-filters.
export const listRankSnapshots = async (
  u: string, t: string, propertyId: string,
  params?: { keywordId?: string; engine?: string; device?: string; limit?: number },
) => {
  const qs = new URLSearchParams();
  if (params?.keywordId) qs.set("keywordId", params.keywordId);
  if (params?.engine) qs.set("engine", params.engine);
  if (params?.device) qs.set("device", params.device);
  if (params?.limit) qs.set("limit", String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return asArray<RankSnapshot>(await skipUnavailable(platformFetch<unknown>(`${base(t)}/properties/${propertyId}/rank-snapshots${suffix}`, u), []));
};

// ── Google OAuth connections (SM-25a) ───────────────────────────────────────────
// Every response is the masked GoogleConnectionView — token material is structurally absent at the
// HTTP boundary (search-google-oauth.controller.test.ts asserts this by string-scan; this client
// trusts that boundary, it does not re-check it).
export const listGoogleConnections = async (u: string, t: string, clientId?: string) =>
  asArray<GoogleConnectionView>(
    await skipUnavailable(platformFetch<unknown>(`${base(t)}/google/connections${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ""}`, u), []),
  );

export const getGoogleConnection = async (u: string, t: string, id: string) =>
  asObject<GoogleConnectionView>(await skipUnavailable(platformFetch<unknown>(`${base(t)}/google/connections/${id}`, u), null));

// ── GSC + GA4 read ingestion (SM-25b) ───────────────────────────────────────────
// Raw history readers — BADGE, not filter, same disposition as rank snapshots above (search.
// controller.ts's own comment on listGscPerformance/listGa4Metrics).
export const listGscPerformance = async (
  u: string, t: string, propertyId: string,
  params?: { startDate?: string; endDate?: string; query?: string; limit?: number },
) => {
  const qs = new URLSearchParams();
  if (params?.startDate) qs.set("startDate", params.startDate);
  if (params?.endDate) qs.set("endDate", params.endDate);
  if (params?.query) qs.set("query", params.query);
  if (params?.limit) qs.set("limit", String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return asArray<GscPerformanceRow>(await skipUnavailable(platformFetch<unknown>(`${base(t)}/properties/${propertyId}/gsc-performance${suffix}`, u), []));
};

// AGGREGATE reader — FILTERED to real data by default (search.controller.ts's own comment on
// topGscQueries: blending simulated demo rows into a "top queries" total that could feed a real
// keyword-import decision would be the exact class of lie this module keeps closing). `startDate`/
// `endDate` are REQUIRED by the controller (400 otherwise) — this fetcher does not default them, the
// caller must supply an explicit range.
export const listTopGscQueries = async (
  u: string, t: string, propertyId: string,
  params: { startDate: string; endDate: string; limit?: number; includeSimulated?: boolean },
) => {
  const qs = new URLSearchParams({ startDate: params.startDate, endDate: params.endDate });
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.includeSimulated) qs.set("includeSimulated", "1");
  return asArray<GscTopQueryRow>(
    await skipUnavailable(platformFetch<unknown>(`${base(t)}/properties/${propertyId}/gsc-performance/top-queries?${qs.toString()}`, u), []),
  );
};

export const listGa4Metrics = async (
  u: string, t: string, propertyId: string,
  params?: { startDate?: string; endDate?: string; limit?: number },
) => {
  const qs = new URLSearchParams();
  if (params?.startDate) qs.set("startDate", params.startDate);
  if (params?.endDate) qs.set("endDate", params.endDate);
  if (params?.limit) qs.set("limit", String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return asArray<Ga4MetricsRow>(await skipUnavailable(platformFetch<unknown>(`${base(t)}/properties/${propertyId}/ga4-metrics${suffix}`, u), []));
};
