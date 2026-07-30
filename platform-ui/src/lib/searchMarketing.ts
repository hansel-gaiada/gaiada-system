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
// There is NO ingest-a-new-audit / run-a-crawl route consumed here — POST audits INGESTS an
// already-produced crawler Report (SM-07's job), it does not trigger one; search-crawl-go is a
// separate, out-of-scope service for this module. There is also NO `GET .../clusters` route —
// clustering only writes cluster_id/cluster_label/intent back onto each keyword row, so the
// clustered view is derived client-side from `listKeywords` (see `groupKeywordsByCluster`).
//
// NOT BUILT YET — the tabs that need these render the BackendPending banner
// rather than an empty table that would read as real (empty) data:
//   rankings (SM-14) · content briefs (SM-10) · ai-visibility (SM-16) · pacing/metrics-daily (SM-22)
//   the dual-mode apply picker + manual export + live search-term sync (SM-19/SM-30/SM-20/SM-21)
// The ledger/cost surface (SM-17) IS built — see `getEngagementLedger` below. SEM read/safe-write
// surfaces (SM-47, this ticket) ARE built for campaigns/ad-groups/ads/negatives/change-proposals —
// everything EXCEPT actually applying a change to a live ad account, which stays out of scope.
import { platformFetch, PlatformError } from "@/lib/platform";
import type {
  SearchProperty, SearchEngagement, EngagementScope, CostProjection, SearchKpiTarget, ToolScopeConfig,
  SearchAudit, AuditFinding, SearchKeywordSet, SearchKeyword, EngagementLedger,
  SearchCampaign, SearchAdGroup, SearchAd, SearchNegative, SearchChangeProposal,
  CampaignPlanResult, RsaDraftResponse, NegativesProposalResponse,
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
