// search-marketing types + pure helpers that must be importable from a CLIENT component
// (SM-29's <ScopeEditor>). Split out of lib/searchMarketing.ts specifically because that module
// imports lib/platform.ts, which is marked `"server-only"` — any client component transitively
// importing it (even just for a type or a pure function) fails the Next.js build with "You're
// importing a component that needs server-only". This file has NO such import, so it is safe for
// both server pages and client components; lib/searchMarketing.ts re-exports everything here for
// its existing callers, so there is exactly one definition of each type/helper, not two that can
// drift apart.
//
// Nothing in this file talks to the network — see lib/searchMarketing.ts for the BFF fetchers.

// ── Tier badges (design §08) ─────────────────────────────────────────────────
// Every console capability is one of two cost tiers, and the console says which
// so nobody is surprised by a bill: 🟢 FREE = our own crawlers + AI on our own
// data, $0 external spend; 🔵 DATA KEY = needs the metered provider (DataForSEO),
// gated on the deposit (OQ-2) and on the engagement's own tool-scope toggle.
export type CostTier = "free" | "data_key";

// Field names below are the controller's REAL response keys, verified against
// search.controller.ts and migration 0034. An earlier revision of this file invented
// `displayName`/`kind`/`startedAt`/`ended`, which rendered as permanent "—" and a dead status —
// frontend-first drift is the failure mode this module is most exposed to, so keep these aligned.
export interface SearchProperty {
  id: string;
  clientId: string;
  domain: string;
  siteUrl: string | null;
  targets: unknown;
  umamiSiteId: string | null;
  verifiedAt: string | null;
  status: string;
  createdAt: string;
}

export type EngagementStatus = "draft" | "active" | "paused" | "closed";

export interface SearchEngagement {
  id: string;
  clientId: string;
  propertyId: string | null;
  projectId: string | null;
  name: string;
  scopePreset: string | null;
  status: EngagementStatus;
  /** numeric(12,6) — cast to a number by the controller (`moneyOrNull`). */
  providerBudgetUsd: number | null;
  toolScope: ToolScopeConfig;
  startsOn: string | null;
  endsOn: string | null;
  createdAt: string;
}

/** Per-engagement tool scope (D-11). A toggle that is absent counts as OFF —
 *  dispatch refuses naming the toggle, so the console must render absent and
 *  explicitly-disabled identically.
 *
 *  Field names verified against `providers/dispatch.ts`'s `itemsPerRun`/`runsPerMonth` and
 *  `scope-presets.ts`'s seeded shapes — NOT a generic `limit`. An earlier revision of this
 *  interface invented `limit`, which the backend estimator silently ignores (falls back to its
 *  own default item count), so a human setting a cap in the UI would have had zero effect on the
 *  actual price or the actual pull size. Getting this wrong doesn't error — it just quietly prices
 *  and dispatches the wrong thing, which is worse. */
export interface ToolScopeToggle {
  enabled?: boolean;
  cadence?: string | null;
  /** rank/volume/suggestions item cap (`itemsPerRun`'s `toggle.maxKeywords`). */
  maxKeywords?: number;
  /** ai_visibility query cap (`itemsPerRun`'s `toggle.maxQueries`, falls back to `queries.length`). */
  maxQueries?: number;
  /** sem_sync's own mode field (scope-presets.ts) — not metered, carried through untouched. */
  mode?: string;
  // jsonb on the DB side (design §04: "loosely typed... not a runtime validation schema") — extra
  // keys (e.g. a future provider-specific knob) must round-trip through the editor unharmed.
  [key: string]: unknown;
}
export type ToolScopeConfig = Record<string, ToolScopeToggle | undefined>;

/** The GET/PUT .../scope contract's actual envelope (search.controller.ts `getEngagementScope`) —
 *  `{scopePreset, toolScope, providerBudgetUsd}`, NOT a bare toggle map. An earlier revision of
 *  this module typed `getEngagementScope`'s return as `ToolScopeConfig` directly and the engagement
 *  detail page indexed straight into it (`scope[toggle]`) — against the demo fixture (which WAS a
 *  bare map) that looked fine; against the real backend every toggle would have read as absent
 *  (`scope.rank` undefined, since the real payload is one level down at `scope.toolScope.rank`),
 *  rendering every capability "blocked" regardless of its actual state. Fixed here and at the demo
 *  fixture together so the two can't drift apart again. */
export interface EngagementScope {
  scopePreset: string | null;
  toolScope: ToolScopeConfig;
  /** numeric(12,6) cast to a number by the controller — see `formatUsd`'s header note anyway,
   *  since a future endpoint revision forgetting the cast is exactly how this bit before. */
  providerBudgetUsd: number | null;
}

export type ScopePreset = "light" | "standard" | "heavy" | "custom";
export const SCOPE_PRESET_VALUES: readonly ScopePreset[] = ["light", "standard", "heavy", "custom"];

export function isScopePreset(v: unknown): v is ScopePreset {
  return typeof v === "string" && (SCOPE_PRESET_VALUES as readonly string[]).includes(v);
}

/** Mirrors platform-nest `modules/search/scope-presets.ts`'s `SEEDED_PRESETS` verbatim. This is
 *  SEEDING data, not a pricing formula — duplicating it does not violate "don't reimplement
 *  pricing in the browser" (rule 5): the dollar figure the scope editor shows still comes
 *  exclusively from the backend's own what-if `cost-projection` call (`getCostProjectionForScope`
 *  in lib/searchMarketing.ts), priced with this exact candidate shape. Keep the two literally in
 *  step; a drift here only mis-previews a preset before save, since the actual PUT lets the
 *  backend re-seed authoritatively regardless of what this constant says. */
export const SCOPE_PRESET_SEEDS: Record<Exclude<ScopePreset, "custom">, ToolScopeConfig> = {
  light: {
    rank: { enabled: false },
    volume: { enabled: false },
    backlinks: { enabled: false },
    ai_visibility: { enabled: false },
    audit_technical: { enabled: true, cadence: "monthly" },
    audit_cwv: { enabled: true, cadence: "monthly" },
    sem_sync: { enabled: false, mode: "manual" },
  },
  standard: {
    rank: { enabled: true, cadence: "weekly", maxKeywords: 50 },
    volume: { enabled: true },
    backlinks: { enabled: false },
    ai_visibility: { enabled: true, cadence: "weekly" },
    audit_technical: { enabled: true, cadence: "weekly" },
    audit_cwv: { enabled: true },
    sem_sync: { enabled: false, mode: "manual" },
  },
  heavy: {
    rank: { enabled: true, cadence: "daily", maxKeywords: 200 },
    volume: { enabled: true },
    backlinks: { enabled: true, cadence: "monthly" },
    ai_visibility: { enabled: true, cadence: "weekly" },
    audit_technical: { enabled: true, cadence: "weekly" },
    audit_cwv: { enabled: true, cadence: "weekly" },
    sem_sync: { enabled: true, mode: "manual" },
  },
};

/** SM-33's provider mode (design addendum §A4; `providers/simulation.ts`'s `ProviderMode`) —
 *  platform-global, `'live'` by default. `CostProjection.providerMode` is the ONE place the console
 *  can read it today (`projectMonthlyCost` in `providers/dispatch.ts`). */
export type ProviderMode = "live" | "simulate";

/** Exactly what `GET engagements/:id/cost-projection` returns: the controller's own envelope
 *  spread over `projectMonthlyCost`'s result. The per-tool key is `tool` (the scope toggle) and the
 *  totals are `projectedMonthlyUsd` / `totalMonthlyUsd` — NOT `monthlyUsd`. Getting these names
 *  wrong does not fail loudly; it renders "—" everywhere, which reads as "this costs nothing".
 *
 *  SM-38: `simulated` (per row) and `providerMode` (top-level) are ADDITIVE fields SM-33 put on this
 *  SAME envelope — no new endpoint (verified against `providers/dispatch.ts`'s `ProjectedToolCost`
 *  and `projectMonthlyCost`). This is the ONLY provenance-carrying surface the console can read
 *  today: `search_provider_calls`/`search_data_cache` gained `simulated` in migration 0047, but
 *  there is no ledger-listing endpoint yet (SM-17), and the snapshot tables a future rankings/
 *  backlinks/ai-visibility tab would read (`search_rank_snapshots`/`search_backlink_snapshots`/
 *  `search_ai_visibility`) have a `provider` + nullable `provider_call_id` column but NO `simulated`
 *  column — that lands in migration 0048 with SM-36, not started. Do not type a `simulated` field
 *  onto anything sourced from those three tables until 0048 ships; `undefined` is falsy, so a row
 *  that IS synthetic would silently render as real, the exact failure this ticket exists to prevent. */
export interface CostProjectionTool {
  tool: string;
  opKind: string;
  enabled: boolean;
  cadence: string | null;
  runsPerMonth: number;
  itemsPerRun: number;
  costPerRunUsd: number;
  projectedMonthlyUsd: number;
  provider: string | null;
  /** Is THIS row's price a synthetic figure? Per-tool because provider selection is per-tool
   *  (SM-36's future per-capability cascade can put a live driver next to a simulated one in the
   *  same grid) — a single page-level flag would then be a lie about half the grid. */
  simulated: boolean;
  note?: string;
}

export interface CostProjection {
  engagementId: string;
  /** True when the projection was computed for a candidate scope passed in, not the persisted one. */
  whatIf: boolean;
  providerBudgetUsd: number | null;
  overBudget: boolean;
  perTool: CostProjectionTool[];
  totalMonthlyUsd: number;
  /** The platform's data mode when this projection was computed (SM-38 deliverable #2: state it
   *  once in the engagement header rather than making an operator infer it from chips). */
  providerMode: ProviderMode;
}

/** A total/aggregate built from simulated inputs is itself simulated (SM-38 AC: "aggregates count").
 *  Only ENABLED rows count — a disabled toggle's $0 isn't a number sourced from a provider at all,
 *  so its (irrelevant) simulated flag must not taint an otherwise-real total. */
export function anyEnabledToolSimulated(perTool: CostProjectionTool[]): boolean {
  return perTool.some((t) => t.enabled && t.simulated);
}

// ── Ledger / cost surface (SM-17; design addendum §A3, tracker §6j) ──────────────────────────
// The FIRST UI onto the money ledger. Field names + envelope shape verified against
// `search.controller.ts`'s `getEngagementLedger` SELECT + response construction (§4i discipline) —
// not against a demo fixture, not against this interface's own earlier drafts.
//
// BINDING LANGUAGE (do not rephrase without re-reading the design addendum §A3): a
// `search_provider_calls.cost_usd` row is COST-TO-SERVE AT STANDARD RATES, never "spend" or "cash".
// With Semrush/Ahrefs on prepaid subscriptions the marginal cash cost of one more call is $0 until
// the allowance exhausts — this figure is the amortized accounting basis for per-client billing and
// margin analysis, not an invoice line. The word "actual" is FORBIDDEN on any figure this surface
// renders until SM-42's true-up + SM-41's reconciliation exist (an Ahrefs row today is a
// conservative UPPER BOUND with no downward correction, so "actual" would overclaim precision the
// data does not have).
export const COST_TO_SERVE_LEGEND =
  "Prepaid vendors (Semrush, Ahrefs) bill API units against fixed subscriptions — figures are " +
  "amortized standard rates, not invoices. Actual cash = fixed subscriptions + DataForSEO " +
  "pay-as-you-go (for DataForSEO, cost-to-serve ≈ cash). Cache hits are free.";

/** One `search_provider_calls` row. `simulated` + `provider` are carried on EVERY row (AC1) — the
 *  per-row chip renders from THIS flag, never from the platform's current mode, because a
 *  historical row must keep badging its own truth after a mode flip (design addendum §A4.4).
 *  `status` is the raw column value ('posted'|'completed'|'failed') and must render VERBATIM — a
 *  console that silently relabels a `failed` refusal row would hide a blocked-attempt from the one
 *  surface built to show it. */
export interface LedgerRow {
  id: string;
  provider: string;
  endpoint: string;
  items: number;
  /** `numeric(12,6)` cast to a number by the controller (`moneyOrNull`) — still checked defensively
   *  by `formatUsd` the same way every other money field in this module is. */
  costUsd: number | null;
  cacheHit: boolean;
  status: string;
  simulated: boolean;
  createdAt: string;
}

/** `GET engagements/:id/ledger`'s full envelope. `costToServeUsd` and `simulatedHistoryExcludedUsd`
 *  are BOTH month-to-date, current-mode-only sums (design addendum §A4.1's mode-filter pattern,
 *  reused verbatim via `providers/ledger.ts`'s `sumMonthToDate` — not re-derived from `rows`, which
 *  is a recent-N slice across BOTH modes, not necessarily the whole month). `currentModeRowCount`
 *  is what lets the console tell "no provider calls recorded yet" (0) apart from a real $0.00
 *  cost-to-serve (rows exist — e.g. cache hits — and legitimately summed to zero); collapsing those
 *  two into one "$0.00" would be the "— never 0" house rule's failure mode on the empty-collection
 *  axis instead of the single-value axis. `simulatedHistoryExcludedUsd` is `null` when the OTHER
 *  mode has zero rows this month — the console must render its "simulated history (excluded)" line
 *  ONLY when this is non-null, and must NEVER add it into `costToServeUsd`. */
export interface EngagementLedger {
  engagementId: string;
  providerMode: ProviderMode;
  costToServeUsd: number | null;
  currentModeRowCount: number;
  simulatedHistoryExcludedUsd: number | null;
  rows: LedgerRow[];
}

export interface SearchKpiTarget {
  id: string;
  engagementId: string;
  metricKey: string;
  baselineValue: number | null;
  targetValue: number;
  duePeriod: string | null;
  direction: string | null;
}

// ── Presentation helpers (pure — shared by pages, the client-side editor, and tests) ──────────

/** A toggle counts as enabled ONLY when explicitly `enabled: true`. Absent and
 *  `enabled: false` are the same thing to dispatch, so they must look the same
 *  in the console too. */
export function isToggleEnabled(scope: ToolScopeConfig, toggle: string): boolean {
  return scope[toggle]?.enabled === true;
}

/** Which scope toggle each metered capability rides on, so a tab can explain
 *  precisely which switch to flip. Mirrors OP_SCOPE_TOGGLE in the backend's
 *  providers/types.ts — keep the two in step. */
export const CAPABILITY_TOGGLE: Record<string, string> = {
  rankings: "rank",
  keywords_volume: "volume",
  suggestions: "suggestions",
  backlinks: "backlinks",
  ai_visibility: "ai_visibility",
};

/** Which field a metered toggle's item-cap actually lives on (`providers/dispatch.ts`'s
 *  `itemsPerRun`) — rank/volume/suggestions read `maxKeywords`, ai_visibility reads `maxQueries`,
 *  backlinks has no cap at all (always 1 item/run). Centralizing this mapping means the scope
 *  editor's "limit" input and the read-only summary can never disagree about which field it writes. */
export const TOGGLE_LIMIT_FIELD: Partial<Record<string, "maxKeywords" | "maxQueries">> = {
  rank: "maxKeywords",
  volume: "maxKeywords",
  suggestions: "maxKeywords",
  ai_visibility: "maxQueries",
};

/** Reads the item-cap for a toggle using the correct field for that tool (see
 *  `TOGGLE_LIMIT_FIELD`). Returns `undefined` for a tool with no cap concept (backlinks) or an
 *  absent/non-numeric value — the caller renders that as "—", same convention as `formatUsd`. */
export function toggleLimit(toggle: ToolScopeToggle | undefined, tool: string): number | undefined {
  const field = TOGGLE_LIMIT_FIELD[tool];
  if (!field || !toggle) return undefined;
  const v = toggle[field];
  return typeof v === "number" ? v : undefined;
}

/** Patches ONE tool's toggle fields into a full scope config, leaving every other key untouched —
 *  other capability toggles, non-metered tools the grid doesn't render (audit_technical/audit_cwv/
 *  sem_sync), and any `provider` override object. A custom-scope save persists exactly the
 *  `toolScope` object the caller sends (design §04), so building that object by patching a single
 *  key onto the full starting scope — rather than only the 5 metered rows the grid shows — is what
 *  keeps a save from silently wiping fields the editor never displayed. */
export function patchToolScope(scope: ToolScopeConfig, tool: string, patch: Partial<ToolScopeToggle>): ToolScopeConfig {
  return { ...scope, [tool]: { ...(scope[tool] ?? {}), ...patch } };
}

/** A simple numeric comparison, NOT a re-estimate: the backend's what-if `cost-projection` prices
 *  against the PERSISTED budget only (it has no candidate-budget parameter), so a human typing a
 *  new budget cap before saving needs this client-side comparison to see the warning update live.
 *  Never invents a total — an unresolvable projection or budget renders "not over budget" (the
 *  caller only shows the warning when it has a real total to compare, per the "— never 0" rule). */
export function isProjectionOverBudget(totalMonthlyUsd: unknown, budgetUsd: unknown): boolean {
  // `Number(null)` is 0 — a legitimate-looking number that would make "no budget set" look
  // catastrophically over budget. null/undefined must resolve to "unknown", not "$0 cap".
  if (totalMonthlyUsd === null || totalMonthlyUsd === undefined || budgetUsd === null || budgetUsd === undefined) return false;
  const total = typeof totalMonthlyUsd === "number" ? totalMonthlyUsd : Number(totalMonthlyUsd);
  const budget = typeof budgetUsd === "number" ? budgetUsd : Number(budgetUsd);
  if (!Number.isFinite(total) || !Number.isFinite(budget)) return false;
  return total > budget;
}

export function engagementStatusTone(status: EngagementStatus): "ok" | "warn" | "muted" {
  if (status === "active") return "ok";
  if (status === "paused" || status === "draft") return "warn";
  return "muted"; // 'closed'
}

/** Money formatter. Accepts `unknown` on purpose: Postgres `numeric` reaches JS as a STRING, and
 *  while the controller now casts every money column exactly once, a single un-cast endpoint used to
 *  be enough to crash this page with "n.toFixed is not a function". Coercing here means a future
 *  endpoint that forgets the cast degrades to a correct display instead of a runtime error — and a
 *  genuinely non-numeric value still renders "—" rather than "$NaN". */
export function formatUsd(n: unknown): string {
  if (n === null || n === undefined || n === "") return "—";
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return "—";
  return `$${v.toFixed(2)}`;
}

/** Plain (non-currency) numeric formatter for `numeric`-typed columns that are NOT money
 *  (`search_audits.score`, `search_keywords.difficulty`) — same null/NaN-safe contract as
 *  `formatUsd` minus the `$` prefix. Postgres `numeric` still arrives as a string; this coerces the
 *  same way `formatUsd` does rather than duplicating a second crash-prone assumption. */
export function numberOrDash(n: unknown): string {
  if (n === null || n === undefined || n === "") return "—";
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return "—";
  return String(v);
}

/** Coerces a `bigint`-column value to a number, or `null`. Postgres `bigint` (search_campaigns'
 *  `budget_minor`/`target_cpa_minor`) reaches JS as a STRING by default — this repo registers no
 *  `pg.types.setTypeParser` for OID 20, confirmed by grep — and `search.controller.ts` does not cast
 *  either column the way it casts `targetRoas` (only field this module money-casts on campaigns).
 *  Use this before `formatBudget`/arithmetic rather than assuming `number`. */
export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── SEM: campaigns / ad groups / ads / negatives / change proposals (SM-18 backend; SM-47 console) ──
// Field names verified against `search.controller.ts`'s SEM SELECT lists + response construction
// (§4i discipline: the controller, never a fixture, never a prior draft of this interface).
//
// One thing worth flagging because it BREAKS this module's own usual convention: every SEM SELECT
// (campaigns/ad-groups/ads/negatives/change-proposals) carries `created_at`/`updated_at` COMPLETELY
// UNALIASED — literally snake_case on the wire, not `createdAt`/`updatedAt` the way `startsOn`/
// `endsOn` are on `SearchEngagement`. (This is actually true of `SearchEngagement.createdAt` and
// `SearchProperty.createdAt` too — their SELECTs are unaliased the same way — but nothing in the
// console reads those two fields today, so the mismatch has never surfaced. Not this ticket's file
// to fix.) Typing these camelCase here would silently render "—"/undefined on every SEM created/
// updated column the moment something tried to read it — so they are typed exactly as they arrive.
export type CampaignPlatform = "google_ads" | "microsoft_ads";
// Mirrors search.controller.ts's CAMPAIGN_STATUSES_WRITABLE exactly — 'live'/'paused'/'ended' need a
// live-ads sync (SM-20/25/26) and are refused (400) by the backend if this console ever tried to set
// them; duplicated here only so the UI never even OFFERS an option the backend will reject.
export const CAMPAIGN_STATUSES_WRITABLE = ["draft", "proposed"] as const;
export type CampaignStatusWritable = (typeof CAMPAIGN_STATUSES_WRITABLE)[number];

export interface SearchCampaign {
  id: string;
  engagementId: string;
  platform: string;
  externalId: string | null;
  name: string;
  objective: string | null;
  status: string;
  /** `bigint`, NOT cast by the controller — see `numOrNull`'s header note. Minor units (cents). */
  budgetMinor: string | number | null;
  currency: string | null;
  bidStrategy: string | null;
  /** `bigint`, same caveat as `budgetMinor`. */
  targetCpaMinor: string | number | null;
  /** `numeric`, cast via `moneyOrNull` server-side (the ONE SEM money-shaped field the controller
   *  casts) — a real number or null. NOT a dollar figure: a target ROAS multiplier (4.0 = "400%
   *  target return"), so render it with `numberOrDash` + an "x" suffix, never `formatUsd`. */
  targetRoas: number | null;
  customFields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SearchAdGroup {
  id: string;
  campaignId: string;
  name: string;
  clusterId: string | null;
  externalId: string | null;
  created_at: string;
  updated_at: string;
}

// Mirrors search.controller.ts's AD_STATUSES_WRITABLE — 'live' is sync-only, never settable here.
export const AD_STATUSES_WRITABLE = ["draft", "approved", "rejected"] as const;
export type AdStatusWritable = (typeof AD_STATUSES_WRITABLE)[number];

export interface SearchAd {
  id: string;
  adGroupId: string;
  headlines: string[];
  descriptions: string[];
  finalUrl: string | null;
  status: string;
  aiGenerated: boolean;
  created_at: string;
  updated_at: string;
}

export const NEGATIVE_MATCH_TYPES = ["broad", "phrase", "exact"] as const;
export type NegativeMatchType = (typeof NEGATIVE_MATCH_TYPES)[number];
// Mirrors search.controller.ts's NEGATIVE_STATUSES_WRITABLE — 'applied' is stamped only by the
// manual/api execution flow (SM-30/21), never settable from this console.
export const NEGATIVE_STATUSES_WRITABLE = ["proposed", "approved", "dismissed"] as const;
export type NegativeStatusWritable = (typeof NEGATIVE_STATUSES_WRITABLE)[number];

export interface SearchNegative {
  id: string;
  campaignId: string;
  adGroupId: string | null;
  term: string;
  matchType: string;
  /** 'manual' | 'ai' (the AI-classification propose flow). */
  source: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export const CHANGE_PROPOSAL_KINDS = ["launch", "pause", "budget", "bid", "negatives_batch", "ads_batch"] as const;
export type ChangeProposalKind = (typeof CHANGE_PROPOSAL_KINDS)[number];
export const CHANGE_PROPOSAL_MODES = ["manual", "api"] as const;
export type ChangeProposalMode = (typeof CHANGE_PROPOSAL_MODES)[number];
// Mirrors search.controller.ts's CHANGE_PROPOSAL_TRANSITIONS exactly: 'applied' is NEVER a reachable
// target from this console (SM-30's manual mark-applied / SM-21's api-mode execution own it
// exclusively) — the UI must never offer it as an option, matching the backend's own 400 refusal.
export const CHANGE_PROPOSAL_TRANSITIONS: Record<string, readonly string[]> = {
  proposed: ["approved", "dismissed"],
  approved: ["dismissed"],
  dismissed: [],
  applied: [],
};

export interface SearchChangeProposal {
  id: string;
  campaignId: string;
  kind: string;
  payload: Record<string, unknown>;
  status: string;
  mode: string;
  approvalId: string | null;
  exportFileId: string | null;
  proposedBy: string | null;
  approvedBy: string | null;
  appliedBy: string | null;
  appliedAt: string | null;
  created_at: string;
  updated_at: string;
}

/** `generateCampaignPlan`'s per-ad-group provenance block (`sem-plan.ts`'s `KeywordProvenanceSummary`,
 *  computed by `buildCampaignPlan`). THE binding provenance surface for this ticket (§A2/§A4.7): a
 *  plan built partly from simulated keyword volumes must never present as though built from real
 *  ones. Three states, never collapsed to two:
 *   - `providers` — every DISTINCT vendor actually present, alphabetically sorted. Never blended/
 *     averaged — a Semrush KD and an Ahrefs KD are different formulas on different scales (§A2).
 *   - `simulatedCount` / `realCount` — counted SEPARATELY, never summed into one figure that hides
 *     the mix.
 *   - `unpulledCount` — keywords with NO metrics pulled yet. "Not yet known", never coerced into 0
 *     or folded into either `real` or `simulated` — the exact ambiguity SM-12 already avoided for
 *     per-keyword volume (see `VolumeState` above) and this ticket must not reintroduce at the
 *     ad-group level. */
export interface KeywordProvenanceSummary {
  providers: string[];
  simulatedCount: number;
  realCount: number;
  unpulledCount: number;
}

/** One ad group in a freshly-generated plan (`generateCampaignPlan`'s response `adGroups[]`).
 *  NOTE this shape only exists on the generate-plan RESPONSE — `GET campaigns/:id/ad-groups` (the
 *  persisted read) does NOT return `keywordCount`/`keywordSample`/`provenance` at all (verified
 *  against that endpoint's SELECT, which is just id/campaignId/name/clusterId/externalId/timestamps).
 *  A campaign's provenance is therefore only knowable at the moment its plan is generated — this
 *  console must not fabricate a provenance figure for an ad group it reads back later. */
export interface PlannedAdGroupResult {
  id: string;
  clusterId: string;
  name: string;
  intent: string | null;
  keywordCount: number;
  keywordSample: string[];
  provenance: KeywordProvenanceSummary;
}

/** `POST engagements/:id/campaigns/generate-plan`'s full response envelope. */
export interface CampaignPlanResult {
  /** The newly-created campaign's id. */
  id: string;
  keywordSetId: string;
  adGroups: PlannedAdGroupResult[];
  totalClusteredKeywords: number;
  unclusteredSkipped: number;
}

/** `POST ad-groups/:id/ads/draft`'s response — an AI (or fail-soft fallback) RSA draft, already
 *  persisted as `status:'draft', aiGenerated:true`. `model` is the gateway's reported provider, or
 *  `null` when the fallback path fired (no gateway call succeeded). */
export interface RsaDraftResponse {
  id: string;
  headlines: string[];
  descriptions: string[];
  draftedVia: "ai" | "fallback";
  model: string | null;
}

/** `POST campaigns/:id/negatives/propose`'s response. `candidates` is the AI's (or fallback's)
 *  classification of the SUBMITTED terms only — `parseNegativesProposal` drops anything the caller
 *  didn't submit, so `candidates` can never introduce a term absent from what the human pasted in. */
export interface NegativesProposalResponse {
  proposed: number;
  submitted: number;
  candidates: { term: string; matchType: string; reason: string }[];
  draftedVia: "ai" | "fallback";
  model: string | null;
}

// ── Site Audit (SM-08 ingest; SM-12 console) ─────────────────────────────────
// Field names verified against platform-nest's search.controller.ts (listAudits / ingestAudit /
// listAuditFindings / triageFinding SELECT + INSERT lists) and search-audit.ts's own exported
// constants — NOT against the demo fixture, per this ticket's own warning about how that class of
// bug hides. `score` is a `numeric` column (migration 0034) that listAudits does NOT cast the way
// `providerBudgetUsd` is cast elsewhere in this module, so it arrives as a STRING; render it with
// `numberOrDash`, never assume `number`.
export const AUDIT_KINDS = ["technical", "cwv", "content", "links", "geo"] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export const FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** Triage transitions the CONSOLE is allowed to request via `PATCH findings/:id`. `'regressed'` is
 *  deliberately excluded: search-audit.ts's diff pass (run only from the ingest path) is the only
 *  writer of that status, and the controller's own `AUDIT_TRIAGE_STATUS_SET` (open|fixed|ignored)
 *  rejects any caller who tries to set it directly with a 400 — the console must never even offer
 *  it as an option. */
export const AUDIT_TRIAGE_STATUSES = ["open", "fixed", "ignored"] as const;
export type AuditTriageStatus = (typeof AUDIT_TRIAGE_STATUSES)[number];

export interface SearchAudit {
  id: string;
  propertyId: string;
  kind: string;
  source: string;
  status: string;
  score: string | number | null;
  /** `severitySummary()`'s shape — jsonb, already a plain object of counts. */
  summary: Record<string, number> | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface AuditFinding {
  id: string;
  auditId: string;
  code: string;
  severity: string;
  category: string;
  message: string;
  urlCount: number;
  sampleUrls: string[];
  status: string;
  firstSeenAuditId: string | null;
  lastSeenAuditId: string | null;
  createdAt: string;
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/** Groups findings by severity in severity-ranked order (critical first) — the same order
 *  `listAuditFindings`'s own `ORDER BY CASE severity ...` already returns rows in, so this just
 *  makes the grouping explicit for rendering rather than re-deriving a different order. A severity
 *  value outside the known five (the column is a CHECK-constrained `text`, not a client-validated
 *  enum) sorts last instead of throwing — the console must never crash on an unexpected string here. */
export function groupFindingsBySeverity(findings: AuditFinding[]): { severity: string; findings: AuditFinding[] }[] {
  const groups = new Map<string, AuditFinding[]>();
  for (const f of findings) {
    const list = groups.get(f.severity) ?? [];
    list.push(f);
    groups.set(f.severity, list);
  }
  return [...groups.entries()].sort(
    (a, b) => (SEVERITY_RANK[a[0]] ?? 99) - (SEVERITY_RANK[b[0]] ?? 99),
  ).map(([severity, list]) => ({ severity, findings: list }));
}

// ── Keywords (SM-09 import/embed/cluster; SM-12 console) ─────────────────────
// Field names verified against search.controller.ts's listKeywordSets/listKeywords SELECT lists and
// clustering.ts's ClusterSummary/EmbedResult/ClusterKeywordSetResult return shapes. There is NO
// dedicated `GET .../clusters` route (clustering only writes cluster_id/cluster_label/intent back
// onto each keyword row) — an earlier draft of this ticket's own placeholder text implied one, and
// that implication is wrong; the clustered view must be derived from `listKeywords`, see
// `groupKeywordsByCluster` below.
export interface SearchKeywordSet {
  id: string;
  engagementId: string;
  name: string;
  source: string;
  createdAt: string;
}

export const INTENTS = ["informational", "commercial", "transactional", "navigational"] as const;
export type Intent = (typeof INTENTS)[number];

// SM-38: `listKeywords`'s SELECT (search.controller.ts) has NO provenance columns — no
// `metrics_provider`, no `metrics_simulated`. Those need migration 0048 (owned by SM-36, not
// started); `search_keywords` doesn't even carry them today, so this interface must NOT invent
// them. That means `SIMULATED`/vendor-label rendering on `volume`/`difficulty` below is a genuine
// backend gap, not a UI oversight — no chip, no claim either way (BackendPending discipline), until
// SM-36 lands the columns and the controller selects them.
export interface SearchKeyword {
  id: string;
  keyword: string;
  locale: string;
  intent: string | null;
  clusterId: string | null;
  clusterLabel: string | null;
  /** `integer` column — a real JS number over the wire (node-pg parses `int4` natively, unlike the
   *  `numeric` fields below). Still routed through the "never show 0 for unknown" rule via
   *  `formatVolume`/`keywordVolumeState`: a metered pull that never ran is `null`, and `null` must
   *  never render as "0 searches/mo". */
  volume: number | null;
  /** `numeric(5,2)` -> string over the wire. */
  difficulty: string | number | null;
  /** `numeric(12,6)` -> string over the wire; this one IS money — use `formatUsd`. */
  cpcUsd: string | number | null;
  isTracked: boolean;
  hasEmbedding: boolean;
  createdAt: string;
}

export interface ClusterGroup {
  clusterId: string;
  clusterLabel: string;
  intent: string | null;
  keywords: SearchKeyword[];
}

/** Groups a keyword-set's rows by `clusterId` for the "clusters + intent labels" view (design §12
 *  SM-12). Derived client-side from the same `listKeywords` read the flat table uses — see this
 *  file's header note on why no separate clusters endpoint exists. Keywords with no `clusterId`
 *  (never clustered, or skipped by `/cluster` for having no embedding yet) are dropped from the
 *  result rather than folded into a fake "Unclustered" group; the caller renders the flat keyword
 *  table for those, which already shows every row regardless of cluster state. Sorted largest
 *  cluster first, purely for a stable, useful default reading order. */
export function groupKeywordsByCluster(keywords: SearchKeyword[]): ClusterGroup[] {
  const groups = new Map<string, ClusterGroup>();
  for (const k of keywords) {
    if (!k.clusterId) continue;
    let g = groups.get(k.clusterId);
    if (!g) {
      g = { clusterId: k.clusterId, clusterLabel: k.clusterLabel ?? k.clusterId, intent: k.intent, keywords: [] };
      groups.set(k.clusterId, g);
    }
    g.keywords.push(k);
  }
  return [...groups.values()].sort((a, b) => b.keywords.length - a.keywords.length);
}

export interface KeywordImportResult {
  imported: number;
  submitted: number;
  duplicates: number;
}

export interface KeywordEmbedResult {
  mode: string;
  embedded: number;
}

export interface KeywordClusterSummary {
  clusterId: string;
  label: string;
  intent: string;
  size: number;
  keywordIds: string[];
}

export interface KeywordClusterResult {
  mode: string;
  clusters: KeywordClusterSummary[];
  skipped: number;
}

/** Search-VOLUME rendering state (design §12 MUST HOLD: "per-keyword search VOLUME is a metered
 *  🔵 capability behind its own scope toggle... render its state rather than pretending it is
 *  free"). Three distinct states — collapsing any two of them into the same "—" is exactly the
 *  class of lie the ticket calls out:
 *   - `'disabled'` — the engagement's `volume` scope toggle is off (absent counts as off, D-11).
 *     No pull can happen until a human flips it on in the engagement's scope editor (SM-29).
 *   - `'unpulled'` — the toggle IS on, but this keyword has no volume yet (never pulled). A real
 *     "0 searches/mo" and "nothing here yet" must not look identical, hence a third state rather
 *     than folding this into `'disabled'`.
 *   - `'value'` — a real number is present; 0 is a legitimate answer here (same asymmetry
 *     `formatUsd` documents for money) and renders as-is. */
export type VolumeState = "disabled" | "unpulled" | "value";

export function keywordVolumeState(volumeScopeEnabled: boolean, volume: number | null | undefined): VolumeState {
  if (!volumeScopeEnabled) return "disabled";
  if (volume === null || volume === undefined) return "unpulled";
  return "value";
}

/** Plain integer formatter for a RESOLVED volume value — only meaningful once
 *  `keywordVolumeState` has already confirmed there is a value to show ('value' state).
 *
 *  Grouping is done by hand rather than with `toLocaleString("en-US")`. An explicit locale LOOKS
 *  deterministic, but it depends on the runtime's ICU data: a Node build with small-icu can format
 *  the same number differently from the browser, so the server-rendered HTML and the client's first
 *  render disagree and React reports a hydration mismatch. That is a real server/client divergence,
 *  not a cosmetic warning — it was mis-attributed to inline widths when SM-12 first saw it. This
 *  version depends on nothing but the number itself. */
export function formatVolume(volume: number | null | undefined): string {
  if (volume === null || volume === undefined || !Number.isFinite(volume)) return "—";
  const negative = volume < 0;
  const digits = Math.abs(Math.trunc(volume)).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${grouped}` : grouped;
}
