"use server";
// search-marketing write paths — currently just the SM-29 scope editor. Mirrors the
// lib/hrActions.ts `ctx()` convention. RBAC gating here is defence-in-depth only
// (the UI gate is a hint) — Cerbos's `set_scope` action on `resource_search_engagement`
// (design §11) is the real boundary, and it is enforced server-side by platform-nest
// regardless of what this file does.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError, type Me } from "./platform";
import { getActiveTenant } from "./tenant";
import { can } from "./rbac";
import {
  getEngagementScope,
  getCostProjection,
  getCostProjectionForScope,
  type ToolScopeConfig,
  type CostProjection,
  type EngagementScope,
} from "./searchMarketing";
import {
  isGoogleProvider,
  type AuditTriageStatus, type KeywordImportResult, type KeywordEmbedResult, type KeywordClusterResult,
  type CampaignPlanResult, type RsaDraftResponse, type NegativesProposalResponse,
  type RankPullBatchResult, type MetricsPullBatchResult,
  type GoogleProvider, type GoogleConnectionView, type StartedGoogleAuthorization, type GoogleRevokeResult,
  type GscPullOutcome, type Ga4PullOutcome, type GscKeywordImportResult,
  type ChangeProposalExportResult, type MarkAppliedResult,
} from "./searchMarketingShared";

async function ctx(tenantOverride?: string): Promise<{ userId: string; tenant: string; me: Me } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = tenantOverride ?? (await getActiveTenant(me));
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant, me };
}

export type PreviewResult = { ok: boolean; projection?: CostProjection | null; error?: string };

/** Prices a CANDIDATE scope via the backend's own what-if `cost-projection` call — nothing is
 *  persisted. This is a "read" action (Cerbos-wise) so it needs no elevated permission; any user
 *  who can see the engagement can preview a hypothetical scope's price before an owner saves it. */
export async function previewScopeProjection(
  tenantId: string, engagementId: string, toolScope: ToolScopeConfig,
): Promise<PreviewResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const projection = await getCostProjectionForScope(c.userId, c.tenant, engagementId, toolScope);
    return { ok: true, projection };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

export type SaveScopeResult = {
  ok: boolean;
  error?: string;
  scope?: EngagementScope;
  projection?: CostProjection | null;
};

/** Persists the scope/budget edit. Always sends `scopePreset` (either the picked preset name or
 *  `'custom'`) — the PUT endpoint 400s if BOTH `scopePreset` and `toolScope` are omitted, which a
 *  budget-only save would otherwise trip (search.controller.ts's own test covers exactly this: a
 *  budget-only PUT still carries `scopePreset: 'custom'`). */
export async function saveEngagementScope(
  tenantId: string,
  engagementId: string,
  payload: { scopePreset: string; toolScope?: ToolScopeConfig; providerBudgetUsd?: number },
): Promise<SaveScopeResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.scope.write", c.tenant)) {
    return { ok: false, error: "You don't have the search.scope.write permission." };
  }
  try {
    await platformFetch(`/api/${c.tenant}/modules/search/engagements/${engagementId}/scope`, c.userId, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
  revalidatePath(`/departments/[deptId]/engagements/${engagementId}`, "page");
  revalidatePath(`/departments/[deptId]/engagements`, "page");

  // Re-read authoritatively rather than trust the PUT echo: search.controller.ts's PUT response
  // only reflects what THIS call set (a budget-only save reports `toolScope: null` even though the
  // persisted scope is unchanged) — the client needs the real current state either way.
  const [scope, projection] = await Promise.all([
    getEngagementScope(c.userId, c.tenant, engagementId),
    getCostProjection(c.userId, c.tenant, engagementId),
  ]);
  return { ok: true, scope, projection };
}

// ── Site Audit triage (SM-08's PATCH findings/:id, SM-12 console) ────────────────────────────────
export type TriageFindingResult = { ok: boolean; error?: string; finding?: { id: string; status: string } };

/** Manual triage only — `status` is typed to `AuditTriageStatus` (open|fixed|ignored), which
 *  structurally EXCLUDES `'regressed'` at the call site; the backend's own `AUDIT_TRIAGE_STATUS_SET`
 *  refuses it too (defence in depth, not the only wall — see that type's header note). Gated on
 *  `search.manage`, same capability as drafting properties/engagements/keywords (ticket MUST HOLD),
 *  not the narrower `search.scope.write` the budget/toggle grid uses. */
export async function triageFinding(
  tenantId: string, findingId: string, status: AuditTriageStatus,
): Promise<TriageFindingResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) {
    return { ok: false, error: "You don't have the search.manage permission." };
  }
  try {
    const finding = await platformFetch<{ id: string; status: string }>(
      `/api/${c.tenant}/modules/search/findings/${findingId}`,
      c.userId,
      { method: "PATCH", body: JSON.stringify({ status }) },
    );
    revalidatePath(`/departments/[deptId]/audit`, "page");
    return { ok: true, finding };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

// ── Keywords: set creation, import, embed, cluster (SM-09's write paths, SM-12 console) ──────────
// All four are gated on `search.manage` (ticket MUST HOLD) — the same "draft-only working set"
// capability that covers properties/engagements/audits, not the elevated `search.scope.write` the
// budget/toggle grid needs. Cerbos remains the actual boundary server-side either way.
export type CreateKeywordSetResult = { ok: boolean; error?: string; id?: string };

export async function createKeywordSet(
  tenantId: string, engagementId: string, name: string, source?: string,
): Promise<CreateKeywordSetResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    const res = await platformFetch<{ id: string }>(`/api/${c.tenant}/modules/search/keyword-sets`, c.userId, {
      method: "POST",
      body: JSON.stringify({ engagementId, name, source }),
    });
    revalidatePath(`/departments/[deptId]/keywords`, "page");
    return { ok: true, id: res.id };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

export type ImportKeywordsResult = { ok: boolean; error?: string; result?: KeywordImportResult };

/** CSV/paste import (design §12 SM-09). SM-32 capped keyword sets at 1000 and the backend
 *  REJECTS an over-cap import with a 400 naming the limit — this surfaces `e.message` verbatim
 *  (ticket MUST HOLD: never swallow that error into a generic failure). */
export async function importKeywords(
  tenantId: string, setId: string, text: string, locale?: string,
): Promise<ImportKeywordsResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    const result = await platformFetch<KeywordImportResult>(
      `/api/${c.tenant}/modules/search/keyword-sets/${setId}/import`,
      c.userId,
      { method: "POST", body: JSON.stringify({ text, locale }) },
    );
    revalidatePath(`/departments/[deptId]/keywords`, "page");
    return { ok: true, result };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

export type EmbedKeywordsResult = { ok: boolean; error?: string; result?: KeywordEmbedResult };

/** Embeds every un-embedded keyword in the set via the AI gateway (`onlyMissing` default true —
 *  a retry naturally resumes only the remainder, per clustering.ts's own header note). Must run
 *  before `/cluster` can partition anything: clustering skips any keyword with no embedding yet
 *  and reports it in `skipped`, it does not embed on the fly. */
export async function embedKeywords(tenantId: string, setId: string): Promise<EmbedKeywordsResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    const result = await platformFetch<KeywordEmbedResult>(
      `/api/${c.tenant}/modules/search/keyword-sets/${setId}/embed`,
      c.userId,
      { method: "POST", body: JSON.stringify({}) },
    );
    revalidatePath(`/departments/[deptId]/keywords`, "page");
    return { ok: true, result };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

export type ClusterKeywordsResult = { ok: boolean; error?: string; result?: KeywordClusterResult };

/** Clusters every already-embedded keyword in the set + Hermes-labels each cluster with an intent
 *  (design §07). `skipped` (keywords with no embedding) is always surfaced to the caller so a set
 *  that was never `/embed`-ed reads as "0 clusters, N skipped" rather than a silent no-op. */
export async function clusterKeywords(tenantId: string, setId: string): Promise<ClusterKeywordsResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    const result = await platformFetch<KeywordClusterResult>(
      `/api/${c.tenant}/modules/search/keyword-sets/${setId}/cluster`,
      c.userId,
      { method: "POST", body: JSON.stringify({}) },
    );
    revalidatePath(`/departments/[deptId]/keywords`, "page");
    return { ok: true, result };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

// ── SEM: campaigns / ad groups / ads / negatives / change proposals (SM-18 backend; SM-47 console) ─
// Every write below is gated on `search.manage` — same baseline-CRUD capability as keywords/audits
// above (rbac.ts's own comment: "...campaign drafts+proposals..."), NEVER `search.campaign.launch`.
// That capability is deliberately unused by this file: it gates Cerbos's `launch`/`apply_manual`/
// `apply_negatives`/`set_budget` actions, none of which this ticket's routes ride (SM-18 §6o: every
// new route here rides the baseline `read`/`create`/`update`/`delete`/`propose_change` actions on
// `resource_search_campaign`). Applying a change to a live ad account is categorically out of scope —
// SM-19 (dual-mode picker) and SM-30 (manual export) own that, and neither is called from here.
export type GeneratePlanResult = { ok: boolean; error?: string; plan?: CampaignPlanResult };

/** Cluster→plan generation (design §12 SM-18). Builds one campaign + one ad group per keyword
 *  cluster from an already-clustered keyword set, returning the FULL provenance breakdown per ad
 *  group — this is the one place the console can read `{providers,simulatedCount,realCount,
 *  unpulledCount}` at all (see `CampaignPlanResult`'s header note: the persisted ad-groups read has
 *  none of this). No live side effect: the created campaign is `status='draft'`. */
export async function generateCampaignPlan(
  tenantId: string,
  engagementId: string,
  payload: {
    keywordSetId: string; name: string; platform?: string; objective?: string;
    budgetMinor?: number; currency?: string; bidStrategy?: string; targetCpaMinor?: number; targetRoas?: number;
  },
): Promise<GeneratePlanResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    const plan = await platformFetch<CampaignPlanResult>(
      `/api/${c.tenant}/modules/search/engagements/${engagementId}/campaigns/generate-plan`,
      c.userId,
      { method: "POST", body: JSON.stringify(payload) },
    );
    revalidatePath(`/departments/[deptId]/planner`, "page");
    return { ok: true, plan };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

export type CreateCampaignResult = { ok: boolean; error?: string; id?: string };

export async function createCampaign(
  tenantId: string,
  engagementId: string,
  payload: { name: string; platform?: string; objective?: string; budgetMinor?: number; currency?: string },
): Promise<CreateCampaignResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    const res = await platformFetch<{ id: string }>(
      `/api/${c.tenant}/modules/search/engagements/${engagementId}/campaigns`,
      c.userId,
      { method: "POST", body: JSON.stringify(payload) },
    );
    revalidatePath(`/departments/[deptId]/planner`, "page");
    return { ok: true, id: res.id };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

export type MutateResult = { ok: boolean; error?: string; id?: string };

/** `status` is deliberately typed narrower than `SearchCampaign.status` — only the two ERP-side
 *  draft states this console (and the backend, per `CAMPAIGN_STATUSES_WRITABLE`) may set. */
export async function updateCampaign(
  tenantId: string,
  campaignId: string,
  payload: {
    name?: string; objective?: string; status?: "draft" | "proposed"; budgetMinor?: number | null;
    currency?: string | null; bidStrategy?: string | null; targetCpaMinor?: number | null; targetRoas?: number | null;
  },
): Promise<MutateResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    const res = await platformFetch<{ id: string }>(
      `/api/${c.tenant}/modules/search/campaigns/${campaignId}`,
      c.userId,
      { method: "PATCH", body: JSON.stringify(payload) },
    );
    revalidatePath(`/departments/[deptId]/planner/${campaignId}`, "page");
    revalidatePath(`/departments/[deptId]/planner`, "page");
    return { ok: true, id: res.id };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

export async function deleteCampaign(tenantId: string, campaignId: string): Promise<{ ok: boolean; error?: string }> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    await platformFetch(`/api/${c.tenant}/modules/search/campaigns/${campaignId}`, c.userId, { method: "DELETE" });
    revalidatePath(`/departments/[deptId]/planner`, "page");
    return { ok: true };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

export async function createAdGroup(
  tenantId: string, campaignId: string, name: string, clusterId?: string,
): Promise<CreateCampaignResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    const res = await platformFetch<{ id: string }>(
      `/api/${c.tenant}/modules/search/campaigns/${campaignId}/ad-groups`,
      c.userId,
      { method: "POST", body: JSON.stringify({ name, clusterId }) },
    );
    revalidatePath(`/departments/[deptId]/planner/${campaignId}`, "page");
    return { ok: true, id: res.id };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

export async function deleteAdGroup(tenantId: string, campaignId: string, adGroupId: string): Promise<{ ok: boolean; error?: string }> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    await platformFetch(`/api/${c.tenant}/modules/search/ad-groups/${adGroupId}`, c.userId, { method: "DELETE" });
    revalidatePath(`/departments/[deptId]/planner/${campaignId}`, "page");
    return { ok: true };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

export type CreateAdResult = { ok: boolean; error?: string; id?: string };

export async function createAd(
  tenantId: string, campaignId: string, adGroupId: string,
  payload: { headlines: string[]; descriptions: string[]; finalUrl?: string },
): Promise<CreateAdResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    const res = await platformFetch<{ id: string }>(
      `/api/${c.tenant}/modules/search/ad-groups/${adGroupId}/ads`,
      c.userId,
      { method: "POST", body: JSON.stringify(payload) },
    );
    revalidatePath(`/departments/[deptId]/planner/${campaignId}`, "page");
    return { ok: true, id: res.id };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

/** `status` narrowed to the three states this console (and `AD_STATUSES_WRITABLE` server-side) may
 *  set — 'live' is stamped only by a live-ads sync (SM-20/25/26), never from here. */
export async function updateAdStatus(
  tenantId: string, campaignId: string, adId: string, status: "draft" | "approved" | "rejected",
): Promise<MutateResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    const res = await platformFetch<{ id: string }>(
      `/api/${c.tenant}/modules/search/ads/${adId}`,
      c.userId,
      { method: "PATCH", body: JSON.stringify({ status }) },
    );
    revalidatePath(`/departments/[deptId]/planner/${campaignId}`, "page");
    return { ok: true, id: res.id };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

export async function deleteAd(tenantId: string, campaignId: string, adId: string): Promise<{ ok: boolean; error?: string }> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    await platformFetch(`/api/${c.tenant}/modules/search/ads/${adId}`, c.userId, { method: "DELETE" });
    revalidatePath(`/departments/[deptId]/planner/${campaignId}`, "page");
    return { ok: true };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

export type DraftAdResult = { ok: boolean; error?: string; draft?: RsaDraftResponse };

/** AI RSA draft (design §07/§08: "draft only", never auto-published). ONE gateway call grounded in
 *  the ad group's own clustered keywords, fail-soft to a deterministic draft on any gateway error —
 *  always persists `status:'draft'`. */
export async function draftAd(tenantId: string, campaignId: string, adGroupId: string): Promise<DraftAdResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    const draft = await platformFetch<RsaDraftResponse>(
      `/api/${c.tenant}/modules/search/ad-groups/${adGroupId}/ads/draft`,
      c.userId,
      { method: "POST", body: JSON.stringify({}) },
    );
    revalidatePath(`/departments/[deptId]/planner/${campaignId}`, "page");
    return { ok: true, draft };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

export async function createNegative(
  tenantId: string, campaignId: string, payload: { term: string; matchType?: string; adGroupId?: string },
): Promise<CreateCampaignResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    const res = await platformFetch<{ id: string }>(
      `/api/${c.tenant}/modules/search/campaigns/${campaignId}/negatives`,
      c.userId,
      { method: "POST", body: JSON.stringify(payload) },
    );
    revalidatePath(`/departments/[deptId]/search-terms`, "page");
    return { ok: true, id: res.id };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

/** `status` narrowed to `NEGATIVE_STATUSES_WRITABLE` — 'applied' is stamped only by SM-30/21's
 *  execution flow, never settable here. */
export async function updateNegativeStatus(
  tenantId: string, campaignId: string, negativeId: string, status: "proposed" | "approved" | "dismissed",
): Promise<MutateResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    const res = await platformFetch<{ id: string }>(
      `/api/${c.tenant}/modules/search/negatives/${negativeId}`,
      c.userId,
      { method: "PATCH", body: JSON.stringify({ status }) },
    );
    revalidatePath(`/departments/[deptId]/search-terms`, "page");
    return { ok: true, id: res.id };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

export async function deleteNegative(tenantId: string, campaignId: string, negativeId: string): Promise<{ ok: boolean; error?: string }> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    await platformFetch(`/api/${c.tenant}/modules/search/negatives/${negativeId}`, c.userId, { method: "DELETE" });
    revalidatePath(`/departments/[deptId]/search-terms`, "page");
    return { ok: true };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

export type ProposeNegativesResult = { ok: boolean; error?: string; result?: NegativesProposalResponse };

/** AI negative-keyword classification over a human-submitted search-term list (paste/CSV — no live
 *  search-term sync exists yet, SM-20's job). ONE gateway call over the whole submitted list (the
 *  SM-32 lesson); `candidates` can only ever be drawn from `terms`, enforced twice (parser + this
 *  route both). */
export async function proposeNegatives(
  tenantId: string, campaignId: string, text: string,
): Promise<ProposeNegativesResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    const result = await platformFetch<NegativesProposalResponse>(
      `/api/${c.tenant}/modules/search/campaigns/${campaignId}/negatives/propose`,
      c.userId,
      { method: "POST", body: JSON.stringify({ text }) },
    );
    revalidatePath(`/departments/[deptId]/search-terms`, "page");
    return { ok: true, result };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

export async function createChangeProposal(
  tenantId: string, campaignId: string, payload: { kind: string; payload: Record<string, unknown>; mode?: string },
): Promise<CreateCampaignResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    const res = await platformFetch<{ id: string }>(
      `/api/${c.tenant}/modules/search/campaigns/${campaignId}/change-proposals`,
      c.userId,
      { method: "POST", body: JSON.stringify(payload) },
    );
    revalidatePath(`/departments/[deptId]/planner/${campaignId}`, "page");
    return { ok: true, id: res.id };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

/** `status` narrowed to `'approved' | 'dismissed'` — the only two transitions THIS console may ever
 *  request (`CHANGE_PROPOSAL_TRANSITIONS`). 'applied' is refused (400) by the backend even if a
 *  caller tried; this type signature makes it impossible to even ATTEMPT from this file. */
export async function updateChangeProposalStatus(
  tenantId: string, campaignId: string, proposalId: string, status: "approved" | "dismissed",
): Promise<MutateResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    const res = await platformFetch<{ id: string }>(
      `/api/${c.tenant}/modules/search/change-proposals/${proposalId}`,
      c.userId,
      { method: "PATCH", body: JSON.stringify({ status }) },
    );
    revalidatePath(`/departments/[deptId]/planner/${campaignId}`, "page");
    return { ok: true, id: res.id };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

// ── SM-19: the manual-mode dual-mode twin (SM-30's backend routes) ───────────────────────────────
// Neither action is gated on `search.campaign.launch` UNIFORMLY: `export` has no live side effect
// (it never mutates the proposal's status — search.controller.ts's own comment: "the same risk tier
// as editing/proposing a change"), so it stays on the baseline `search.manage` gate every other
// campaign-domain write in this file uses. `mark-applied` is the ONE elevated action — it is the
// door to `status='applied'`, gated on `search.campaign.launch` (Cerbos `apply_manual`), matching
// the backend's own elevated Cerbos action for that route exactly.
export type ExportChangeProposalResult = { ok: boolean; error?: string; result?: ChangeProposalExportResult };

/** Turns an approved, mode='manual' change proposal into an Ads-Editor-ready CSV `files` artifact.
 *  Re-exporting is harmless (the backend allows it on 'approved' AND 'applied', for a re-download) —
 *  this action never assumes the proposal hasn't already been exported once. */
export async function exportChangeProposal(
  tenantId: string, campaignId: string, proposalId: string,
): Promise<ExportChangeProposalResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    const result = await platformFetch<ChangeProposalExportResult>(
      `/api/${c.tenant}/modules/search/change-proposals/${proposalId}/export`,
      c.userId,
      { method: "POST", body: JSON.stringify({}) },
    );
    revalidatePath(`/departments/[deptId]/planner/${campaignId}`, "page");
    return { ok: true, result };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

export type MarkChangeProposalAppliedResult = { ok: boolean; error?: string; result?: MarkAppliedResult };

/** The one door to `status='applied'` this console offers — a human attestation that they applied
 *  the exported change by hand in the ad platform, permission-gated on `search.campaign.launch`
 *  (Cerbos `apply_manual`, elevated). Refuses (surfaced verbatim) for an api-mode proposal or one
 *  not currently 'approved' — the backend's own precondition, never re-derived or loosened here. */
export async function markChangeProposalApplied(
  tenantId: string, campaignId: string, proposalId: string, note?: string,
): Promise<MarkChangeProposalAppliedResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.campaign.launch", c.tenant)) {
    return { ok: false, error: "You don't have the search.campaign.launch permission." };
  }
  try {
    const result = await platformFetch<MarkAppliedResult>(
      `/api/${c.tenant}/modules/search/change-proposals/${proposalId}/mark-applied`,
      c.userId,
      { method: "POST", body: JSON.stringify({ note }) },
    );
    revalidatePath(`/departments/[deptId]/planner/${campaignId}`, "page");
    return { ok: true, result };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

// ── Rank tracking (SM-14) — the Rankings tab's writes ─────────────────────────────────────────────
// Gated on `search.manage` — same baseline capability as every other draft/pull write in this
// file (search.controller.ts actions both routes as `resource_search_keyword` + `research`, a
// distinct Cerbos action from plain read/update, but this console has no finer-grained RBAC
// capability than `search.manage` for "trigger a metered pull", matching KeywordWorkbench's own
// import/embed/cluster gate).
export type PullRanksResult = { ok: boolean; error?: string; result?: RankPullBatchResult };

export async function pullRanks(
  tenantId: string, engagementId: string, keywordIds?: string[],
): Promise<PullRanksResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    const result = await platformFetch<RankPullBatchResult>(
      `/api/${c.tenant}/modules/search/engagements/${engagementId}/rank-pull`,
      c.userId,
      { method: "POST", body: JSON.stringify({ keywordIds }) },
    );
    revalidatePath(`/departments/[deptId]/rankings`, "page");
    return { ok: true, result };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

export type PullKeywordMetricsResult = { ok: boolean; error?: string; result?: MetricsPullBatchResult };

/** Volume/difficulty/CPC refresh for a keyword SET (not the engagement) — mirrors
 *  `search.controller.ts`'s own resource split (`POST keyword-sets/:id/metrics-pull`). Reused by
 *  both the Rankings tab (a "refresh volume too" convenience) and the Keywords tab. */
export async function pullKeywordMetrics(
  tenantId: string, setId: string, keywordIds?: string[],
): Promise<PullKeywordMetricsResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    const result = await platformFetch<MetricsPullBatchResult>(
      `/api/${c.tenant}/modules/search/keyword-sets/${setId}/metrics-pull`,
      c.userId,
      { method: "POST", body: JSON.stringify({ keywordIds }) },
    );
    revalidatePath(`/departments/[deptId]/rankings`, "page");
    revalidatePath(`/departments/[deptId]/keywords`, "page");
    return { ok: true, result };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

// ── Google OAuth connections (SM-25a) — the Connections tab's Google section ─────────────────────
// `search.manage` gates every write below (starting/refreshing/revoking/binding a connection),
// matching this file's own "same baseline capability as drafting properties/engagements" convention
// — Cerbos's real gate is `resource_search_property` + `update`, elevated no further than that.
const GOOGLE_OAUTH_PENDING_COOKIE = "sm_google_oauth_pending";

export type StartGoogleAuthResult = { ok: boolean; error?: string };

/** Starts a Google OAuth flow and REDIRECTS the browser to the issuer's consent page (real Google,
 *  or the local Keycloak/SM-51 sandbox issuer in dev). `redirect()` throws internally (Next.js's own
 *  mechanism) — a caller only ever sees this function "return" on the ERROR path, never on success.
 *
 *  `provider` AND `returnPath` are stashed in a short-lived, httpOnly cookie because the issuer's own
 *  redirect back to our callback page (Google's real behaviour: a bare browser navigation, only
 *  `code`/`state`/`error` in the query — no way to carry a custom param) cannot tell the callback
 *  which of GSC/GA4/Ads this was for, or which department's Connections tab to return the operator
 *  to (search-google-oauth.controller.ts's own header note: "provider from its own client-side flow
 *  context — Google's redirect never carries it"). The signed `state` param carries the TENANT, not
 *  the provider or a UI route (oauth-state.ts's own design), so this cookie is the flow context the
 *  front end alone is responsible for remembering. 10-minute TTL matches the backend's own state TTL
 *  (`GOOGLE_OAUTH_STATE_TTL_SECONDS`, default 600) — the cookie and the state it accompanies expire
 *  together, so a stale cookie can never outlive the state it is paired with. */
export async function startGoogleAuthorization(
  tenantId: string, provider: GoogleProvider, clientId: string, propertyId: string | undefined, returnPath: string,
): Promise<StartGoogleAuthResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  let started: StartedGoogleAuthorization;
  try {
    started = await platformFetch<StartedGoogleAuthorization>(
      `/api/${c.tenant}/modules/search/google/connections/${provider}/authorize`,
      c.userId,
      { method: "POST", body: JSON.stringify({ clientId, propertyId }) },
    );
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
  const jar = await cookies();
  jar.set(GOOGLE_OAUTH_PENDING_COOKIE, JSON.stringify({ provider, returnPath }), {
    httpOnly: true, sameSite: "lax", path: "/", maxAge: 600,
    secure: process.env.NODE_ENV === "production",
  });
  redirect(started.authorizeUrl);
}

export interface GoogleOAuthPending {
  provider: GoogleProvider;
  returnPath: string;
}

/** Reads (and clears) the {provider, returnPath} stashed by `startGoogleAuthorization` above —
 *  called by the callback route handler (`app/api/search/google/callback/route.ts`) once the issuer
 *  redirects back. A missing/malformed cookie (expired, or the browser arrived here with no flow in
 *  progress — a bookmarked or replayed URL) is reported as `null`, never guessed at; the caller must
 *  fall back to a safe default return path rather than trust an absent value. */
export async function consumeGoogleOAuthPending(): Promise<GoogleOAuthPending | null> {
  const jar = await cookies();
  const raw = jar.get(GOOGLE_OAUTH_PENDING_COOKIE)?.value;
  jar.delete(GOOGLE_OAUTH_PENDING_COOKIE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { provider?: string; returnPath?: string };
    if (!isGoogleProvider(parsed.provider) || typeof parsed.returnPath !== "string" || !parsed.returnPath.startsWith("/")) return null;
    return { provider: parsed.provider, returnPath: parsed.returnPath };
  } catch {
    return null;
  }
}

export type GoogleConnectionMutateResult = { ok: boolean; error?: string; connection?: GoogleConnectionView };

export async function refreshGoogleConnection(tenantId: string, connectionId: string): Promise<GoogleConnectionMutateResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    const connection = await platformFetch<GoogleConnectionView>(
      `/api/${c.tenant}/modules/search/google/connections/${connectionId}/refresh`,
      c.userId,
      { method: "POST", body: JSON.stringify({}) },
    );
    revalidatePath(`/departments/[deptId]/connections`, "page");
    return { ok: true, connection };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

export type RevokeGoogleConnectionResult = { ok: boolean; error?: string; result?: GoogleRevokeResult };

export async function revokeGoogleConnection(tenantId: string, connectionId: string): Promise<RevokeGoogleConnectionResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    const result = await platformFetch<GoogleRevokeResult>(
      `/api/${c.tenant}/modules/search/google/connections/${connectionId}/revoke`,
      c.userId,
      { method: "POST", body: JSON.stringify({}) },
    );
    revalidatePath(`/departments/[deptId]/connections`, "page");
    return { ok: true, result };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

export type BindGoogleConnectionResult = { ok: boolean; error?: string };

export async function bindGoogleConnection(
  tenantId: string, propertyId: string, provider: GoogleProvider, connectionId: string | null,
): Promise<BindGoogleConnectionResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    await platformFetch(
      `/api/${c.tenant}/modules/search/properties/${propertyId}/google-connection/${provider}`,
      c.userId,
      { method: "PUT", body: JSON.stringify({ connectionId }) },
    );
    revalidatePath(`/departments/[deptId]/connections`, "page");
    revalidatePath(`/departments/[deptId]/gsc-ga4`, "page");
    return { ok: true };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

// ── GSC + GA4 read ingestion (SM-25b) — the Search Console & GA4 tab's pulls ──────────────────────
// $0 to the shared vendor deposit (§A12.1: a third egress class, client-private OAuth) — gated on
// `search.manage` anyway, same as every other console-triggered write, because it is still a genuine
// write against a client's own Google account and against our own tables.
export type PullGscResult = { ok: boolean; error?: string; result?: GscPullOutcome };

export async function pullGscPerformance(
  tenantId: string, engagementId: string, body?: { startDate?: string; endDate?: string; rowLimit?: number; maxPages?: number },
): Promise<PullGscResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    const result = await platformFetch<GscPullOutcome>(
      `/api/${c.tenant}/modules/search/engagements/${engagementId}/gsc-pull`,
      c.userId,
      { method: "POST", body: JSON.stringify(body ?? {}) },
    );
    revalidatePath(`/departments/[deptId]/gsc-ga4`, "page");
    return { ok: true, result };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

export type PullGa4Result = { ok: boolean; error?: string; result?: Ga4PullOutcome };

export async function pullGa4Metrics(
  tenantId: string, engagementId: string, body: { ga4PropertyId: string; startDate?: string; endDate?: string },
): Promise<PullGa4Result> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  if (!body.ga4PropertyId.trim()) return { ok: false, error: "GA4 property id required." };
  try {
    const result = await platformFetch<Ga4PullOutcome>(
      `/api/${c.tenant}/modules/search/engagements/${engagementId}/ga4-pull`,
      c.userId,
      { method: "POST", body: JSON.stringify(body) },
    );
    revalidatePath(`/departments/[deptId]/gsc-ga4`, "page");
    return { ok: true, result };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

export type ImportGscKeywordsResult = { ok: boolean; error?: string; result?: GscKeywordImportResult };

/** Seeds a keyword set from our OWN already-persisted GSC rows (never a fresh Google call —
 *  search.controller.ts's own comment: "importing keywords is not itself a reason to re-pull").
 *  `includeSimulated` is NOT exposed here and always omitted (defaults false server-side) — this
 *  console never lets a write path pull demo/sandbox rows into a client's real keyword set, per the
 *  controller's own "data pollution, not merely a misleading number" warning. */
export async function importGscKeywords(
  tenantId: string, engagementId: string,
  body: { setId?: string; name?: string; startDate: string; endDate: string; minClicks?: number; limit?: number; locale?: string },
): Promise<ImportGscKeywordsResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "search.manage", c.tenant)) return { ok: false, error: "You don't have the search.manage permission." };
  try {
    const result = await platformFetch<GscKeywordImportResult>(
      `/api/${c.tenant}/modules/search/engagements/${engagementId}/gsc-keyword-import`,
      c.userId,
      { method: "POST", body: JSON.stringify(body) },
    );
    revalidatePath(`/departments/[deptId]/keywords`, "page");
    return { ok: true, result };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}
