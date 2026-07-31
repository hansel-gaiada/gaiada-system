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
    // SM-61 (tracker §6au Ruling 1 clause 2, binding — mirrors platform-nest scope-presets.ts's own
    // header note verbatim): `volume` used to ship cadence-LESS. The platform-side pull scheduler
    // (SM-54) was defaulting that absence to weekly-conservative while the cost projection had
    // ALWAYS priced it as one on-demand refresh/month — a cadence-less enabled tool was scheduled
    // ~4x more often than this panel showed. `cadence: "monthly"` fixes this by scheduling it at
    // EXACTLY the rate it was already priced at (price-identical, zero change to any number a human
    // has ever seen here) and matches the vendor's own monthly volume-data cycle.
    volume: { enabled: true, cadence: "monthly" },
    backlinks: { enabled: false },
    ai_visibility: { enabled: true, cadence: "weekly" },
    audit_technical: { enabled: true, cadence: "weekly" },
    audit_cwv: { enabled: true },
    sem_sync: { enabled: false, mode: "manual" },
  },
  heavy: {
    rank: { enabled: true, cadence: "daily", maxKeywords: 200 },
    // Same SM-61 fix as 'standard' above, same price-identity reasoning.
    volume: { enabled: true, cadence: "monthly" },
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
  /** SM-61 (tracker §6au Ruling 1 clause 3) — SERVER-DERIVED, never re-computed here: `true` only
   *  when the platform-side pull scheduler will actually select this row unattended (enabled, a real
   *  cadence present, and the tool is one of the four SM-54 reassigned from n8n). `false` means
   *  `projectedMonthlyUsd` is the ON-DEMAND USAGE ESTIMATE — a real, legitimate number, but nothing
   *  will dispatch it on its own. The scope panel must render an enabled `scheduled: false` row with
   *  its own "on-demand est." label (`onDemandEstimateLabel` below) rather than letting it look like
   *  a schedule — the exact pre-SM-61 ambiguity that let a human be shown one number while the
   *  scheduler (once it existed) ran a different one. */
  scheduled: boolean;
  note?: string;
}

/** The scope panel's cost-cell label for an ENABLED, non-scheduled row (§6au Ruling 1 clause 3's
 *  "on-demand est." requirement, per §6aa's no-unlabelled-figures rule). Returns `null` for a
 *  disabled row (nothing to label — the cell already renders at reduced opacity) or a truly
 *  scheduled one (no estimate caveat needed: the number IS what will run). Takes the plain
 *  booleans rather than the whole `CostProjectionTool` so a caller previewing a not-yet-saved toggle
 *  (which may not have a priced row yet) can still ask the question. */
export function onDemandEstimateLabel(enabled: boolean, scheduled: boolean): string | null {
  return enabled && !scheduled ? "on-demand est." : null;
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
// SM-60 (tracker §6al, closed): a THIRD row status, `incurred`, joined `posted`/`completed`/`failed`
// on migration 0053 — "the vendor was engaged and confirmably charged, and the platform kept nothing
// usable". §6al's own follow-up ("SM-17's legend line should mention both shapes") is discharged in
// the third sentence below: TWO distinct causes both land on `incurred`, and an operator reading the
// word needs both, not just the first one this module originally shipped with —
//   1. the vendor delivered nothing at all (a poll exhausted, a task never completed at the vendor); or
//   2. the vendor DID deliver, but this platform's OWN write (cache/ledger/COMMIT) failed after the
//      charge landed — the money is spent identically either way.
// Collapsing that second cause into "no data" would be a false claim about where the fault sits; the
// legend states the shared consequence (money left, nothing kept) without picking a culprit for either
// row, exactly like `notifications.ts`'s own widened title ("A provider charge produced no usable
// data" — tracker §6al) says nothing more specific than the ledger itself can support.
export const COST_TO_SERVE_LEGEND =
  "Prepaid vendors (Semrush, Ahrefs) bill API units against fixed subscriptions — figures are " +
  "amortized standard rates, not invoices. Actual cash = fixed subscriptions + DataForSEO " +
  "pay-as-you-go (for DataForSEO, cost-to-serve ≈ cash). Cache hits are free. A row marked " +
  "\"incurred\" means the vendor was charged and either delivered nothing, or delivered data this " +
  "platform's own write then failed to keep — cost to serve either way, never $0.";

/** One `search_provider_calls` row. `simulated` + `provider` are carried on EVERY row (AC1) — the
 *  per-row chip renders from THIS flag, never from the platform's current mode, because a
 *  historical row must keep badging its own truth after a mode flip (design addendum §A4.4).
 *  `status` is the raw column value ('posted'|'completed'|'failed'|'incurred', 0053) and must render
 *  VERBATIM — a console that silently relabels a `failed`/`incurred` row would hide a blocked or
 *  money-losing attempt from the one surface built to show it. */
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

// ── SM-19: the dual-mode picker (design §12; addendum §A2/§A3/§A4) ──────────────────────────────
// Two SEPARATE "dual-mode" concepts live in this module and must never be conflated:
//   (1) SEM change-proposal EXECUTION mode ('manual' export+mark-applied vs 'api' one-shot push,
//       design §04/§07) — the human picks it when proposing a change (createChangeProposal's own
//       `mode` field, already accepted by the backend since SM-18).
//   (2) Per-CAPABILITY data-PROVIDER resolution for a metered pull (rank/volume/backlinks/
//       ai_visibility/suggestions — SM-36's cascade, addendum §A2) — which vendor serves a paid
//       pull, whether it is real or simulated (§A4), and what it is projected to cost (§A3).
// This ticket builds the pre-commit disclosure for BOTH: `PaidActionGate` (see that component) for
// (2), and the export/mark-applied wiring in `ChangeProposalsPanel`/`ApplyProposalTwins` for (1).

/** §A2's ruling, transcribed from platform-nest `config.ts`'s `capabilityPreference` (verified
 *  2026-07-31, re-check before trusting if that file changes): `serp` and `ai_visibility` are
 *  seeded as LENGTH-1 lists with NO env override (SM-46d hardcoded them) — "no fallback... a
 *  snapshot from a different vendor has different product semantics than a live capture", refuse
 *  rather than substitute. Every other paid capability (`volume`/`suggestions`/`backlinks`) has a
 *  multi-entry preference list. This module has NO endpoint exposing preference-list LENGTH or the
 *  candidate vendor set (search.controller.ts never serializes `config.search.capabilityPreference`
 *  anywhere) — so this Set is the one and only place this fact is asserted, and it must never be
 *  used to render a fabricated list of "the other providers" (that would be inventing data the
 *  backend never sent, exactly the drift class this module warns about repeatedly). Its ONLY
 *  legitimate use: deciding whether to show a disabled, reasoned single-choice picker (this set) or
 *  to say plainly that no override affordance exists here yet (every other tool) — never to draw a
 *  dropdown of alternatives this file did not get from the backend.
 *  Keyed by the SCOPE TOGGLE name (`search_engagements.tool_scope`'s tool key), not the op-kind —
 *  `rank` (toggle) resolves to op-kind `serp`, per `providers/dispatch.ts`'s `TOGGLE_OP`. */
export const SINGLE_PROVIDER_TOOLS: ReadonlySet<string> = new Set(["rank", "ai_visibility"]);

/** One line, reused everywhere a single-provider capability needs to explain why its picker is a
 *  disabled, reasoned fact rather than a dropdown of one (ticket honesty rule #3: "a disabled
 *  picker with a reason beats a dropdown of one"). */
export function singleProviderReason(provider: string | null): string {
  return provider
    ? `DataForSEO is the only provider this capability may use (design addendum §A2) — a different ` +
        `vendor's data here would carry different product semantics (a database snapshot vs a live ` +
        `capture), so this never substitutes. If DataForSEO is unavailable, the pull refuses rather ` +
        `than falling back to another vendor.`
    : `DataForSEO is the only provider this capability may use (design addendum §A2), and it is ` +
        `currently unavailable — see the reason above. This never falls back to another vendor.`;
}

/** `POST change-proposals/:id/export`'s response (SM-30). Field names verified directly against
 *  `search.controller.ts`'s `exportChangeProposal` return statement (§4i discipline) — `provenance`
 *  is `null` for every kind except `launch` (the only kind built from keyword metrics; see
 *  `sem-export.ts`'s own header note) and reuses `KeywordProvenanceSummary` verbatim rather than a
 *  second shape, so a rendered provenance chip here can share code with the Planner's. */
export interface ChangeProposalExportResult {
  fileId: string;
  filename: string;
  contentType: string;
  byteSize: number;
  provenance: KeywordProvenanceSummary | null;
}

/** `POST change-proposals/:id/mark-applied`'s response (SM-30). */
export interface MarkAppliedResult {
  id: string;
  status: "applied";
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

// SM-14 (tracker §6j AC4 / §6s "still owed"): migration 0048 landed the provenance columns and
// search.controller.ts's listKeywords SELECT now widens to expose them —
//   `metrics_provider AS "metricsProvider", metrics_simulated AS "metricsSimulated"`
// (verified directly against that SELECT, platform-nest/src/modules/search/search.controller.ts,
// listKeywords — not against a fixture, per this file's own §4i discipline). SM-38's prior note
// above (superseded) said this was a genuine backend gap; it no longer is. `metricsSimulated` is
// NOT nullable (0048: `NOT NULL DEFAULT false`) — a never-pulled keyword reads `metricsProvider:
// null, metricsSimulated: false`, never `null`/`undefined` for the flag itself. A vendor-sourced
// `volume`/`difficulty`/`cpcUsd` must never render without checking these two alongside it.
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
  /** Which `SearchDataProvider` produced the CURRENT volume/difficulty/cpcUsd values. `null` = no
   *  metrics pulled yet for this keyword — stays `null`, never defaulted to a guessed vendor
   *  (0048's own column-comment law). */
  metricsProvider: string | null;
  /** `true` = the current metric values were produced by a SIMULATED provider (or while
   *  `config.search.providerMode = simulate`). NOT NULL DEFAULT false (0048) — always a real
   *  boolean, never absent, even for a keyword with no metrics pulled yet. */
  metricsSimulated: boolean;
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

// ── Rank tracking (SM-14; tracker §6af/§6au — the Rankings console tab, unclaimed until now) ────────
// Field names verified against `search.controller.ts`'s `listRankSnapshots`/`pullRanks`/
// `pullKeywordMetrics` SELECTs + response construction (§4i discipline), and against
// `rank.ts`'s `RankPullOutcome`/`MetricsPullOutcome`/batch-result shapes — never against a guess at
// what a rank tracker "should" return.
export interface RankSnapshot {
  id: string;
  keywordId: string;
  keyword: string;
  engine: string;
  device: string;
  locationCode: number | null;
  capturedAt: string;
  /** Nullable — the property genuinely not found in that SERP capture. Honest, never an error and
   *  never coerced to a number (rank.ts's own `findPropertyPosition` header note). Render "—", not
   *  "0" or "not ranked" dressed up as a number. */
  position: number | null;
  rankedUrl: string | null;
  serpFeatures: Record<string, unknown> | null;
  /** Stamped from `DispatchResult.simulated` at capture time — never re-derived from the platform's
   *  current mode, so a historical snapshot keeps badging its own truth after a mode flip (badge, not
   *  filter — same disposition as the ledger's per-row chip). */
  provider: string | null;
  simulated: boolean;
}

export type RankPullRowStatus = "pulled" | "skipped" | "failed";
export interface RankPullOutcomeRow {
  keywordId: string;
  keyword: string;
  status: RankPullRowStatus;
  position?: number | null;
  rankedUrl?: string | null;
  provider?: string;
  simulated?: boolean;
  /** A found→worse or found→not-found regression vs. the immediately-prior snapshot. Absent on a
   *  first-ever pull or a not-found→not-found repeat — those have nothing to regress FROM. */
  dropped?: boolean;
  previousPosition?: number | null;
  /** Present on `skipped`/`failed` rows only — the choke-point's refusal code (a mid-batch scope/
   *  budget/pillar stop) or the per-keyword error message. Never swallowed into a generic label. */
  reason?: string;
}
export interface RankPullBatchResult {
  engagementId: string;
  propertyId: string;
  attempted: number;
  pulled: number;
  skipped: number;
  failed: number;
  results: RankPullOutcomeRow[];
}

export type MetricsPullRowStatus = "updated" | "absent" | "skipped" | "failed";
export interface MetricsPullOutcomeRow {
  keywordId: string;
  keyword: string;
  status: MetricsPullRowStatus;
  volume?: number | null;
  difficulty?: number | null;
  cpcUsd?: number | null;
  provider?: string;
  simulated?: boolean;
  reason?: string;
}
export interface MetricsPullBatchResult {
  attempted: number;
  updated: number;
  absent: number;
  skipped: number;
  failed: number;
  results: MetricsPullOutcomeRow[];
}

/** Derives `dropped`/`previousPosition` for a RAW history list, client-side — the list endpoint
 *  (`GET properties/:id/rank-snapshots`) returns undecorated rows (badge-not-filter, no computed
 *  delta), unlike the PULL response which already carries `dropped` for the row it just wrote. This
 *  mirrors `rank.ts`'s own `isRankDrop` exactly (found→worse, or found→not-found; a first-ever
 *  capture or a not-found→not-found repeat is never a drop) so the panel's read-path badge and the
 *  backend's write-path badge can never disagree about what counts as a regression. Snapshots are
 *  grouped by (keywordId, engine, device) — a drop is only meaningful within the SAME tracked
 *  combination — and compared against the immediately-PRIOR capture by `capturedAt`, regardless of
 *  the array's incoming order. */
export function annotateRankDrops(
  snapshots: RankSnapshot[],
): (RankSnapshot & { dropped: boolean; previousPosition: number | null })[] {
  const byGroup = new Map<string, RankSnapshot[]>();
  for (const s of snapshots) {
    const key = `${s.keywordId}|${s.engine}|${s.device}`;
    const list = byGroup.get(key) ?? [];
    list.push(s);
    byGroup.set(key, list);
  }
  const decorated = new Map<string, { dropped: boolean; previousPosition: number | null }>();
  for (const list of byGroup.values()) {
    const sorted = [...list].sort((a, b) => (a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0));
    for (let i = 0; i < sorted.length; i++) {
      const prev = i > 0 ? sorted[i - 1] : null;
      const previousPosition = prev ? prev.position : null;
      const dropped = previousPosition !== null && (sorted[i].position === null || sorted[i].position! > previousPosition);
      decorated.set(sorted[i].id, { dropped, previousPosition });
    }
  }
  return snapshots.map((s) => ({ ...s, ...(decorated.get(s.id) ?? { dropped: false, previousPosition: null }) }));
}

/** 1-based average position formatter (`numeric(9,2)` on the wire — a float per Google's own shape,
 *  and possibly a STRING if a future reader forgets to cast it — same defensive coercion as
 *  `formatUsd`). Renders one decimal place; "—" for null/absent/non-numeric, never "0" (position 0
 *  does not exist — SERP ranks start at 1). */
export function formatPosition(n: unknown): string {
  if (n === null || n === undefined || n === "") return "—";
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toFixed(1);
}

// ── Google OAuth connections (SM-25a; design addendum §A12, tracker §6ao/§6as) ───────────────────────
// Field names verified against `google/oauth.ts`'s `GoogleConnectionView`/`StartedAuthorization`/
// `RevokeResult` and `search.controller.ts`'s Google-connection routes — the masked view is the ONLY
// shape any of these routes ever return; token material is structurally absent, never trusted to be
// masked by this file.
export type GoogleProvider = "google_search_console" | "google_analytics" | "google_ads";
export const GOOGLE_PROVIDER_VALUES: readonly GoogleProvider[] = ["google_search_console", "google_analytics", "google_ads"];
export const GOOGLE_PROVIDER_LABEL: Record<GoogleProvider, string> = {
  google_search_console: "Search Console",
  google_analytics: "Analytics (GA4)",
  google_ads: "Google Ads",
};
export function isGoogleProvider(v: unknown): v is GoogleProvider {
  return typeof v === "string" && (GOOGLE_PROVIDER_VALUES as readonly string[]).includes(v);
}

/** The masked connection shape every Google-connection route returns (`google/oauth.ts`'s own
 *  `GoogleConnectionView`). §A12.3's honesty rule lives on the last two fields: `issuerHost` is the
 *  host that ACTUALLY issued these tokens, and `issuerIsGoogle` says whether that host is really
 *  Google. **The Connections surface MUST render `issuerHost` whenever `issuerIsGoogle` is false** —
 *  a dev/sandbox-issued connection (local Keycloak's `google-dev` realm client, or the SM-51 sandbox)
 *  must be readable as one at a glance, never indistinguishable from a real Google link. */
export interface GoogleConnectionView {
  id: string;
  provider: GoogleProvider;
  clientId: string;
  status: string;
  hasToken: boolean;
  hasRefreshToken: boolean;
  tokenExpiresAt: string | null;
  scopes: string[];
  externalAccount: string | null;
  issuerHost: string | null;
  issuerIsGoogle: boolean;
}

export interface StartedGoogleAuthorization {
  authorizeUrl: string;
  state: string;
  expiresAt: string;
  issuerHost: string;
  simulated: boolean;
  scopes: string[];
}

export interface GoogleRevokeResult {
  connection: GoogleConnectionView;
  issuerRevoked: boolean;
  issuerStatus: string | number | null;
}

/** Renders the non-Google-issuer disclosure text (§A12.3) — a single helper so the exact wording
 *  can't drift between the connections list and any detail view that also needs it. Returns `null`
 *  when the issuer IS Google (nothing to disclose) or the host is genuinely unknown (still `null` —
 *  an absent host is not itself a lie, it just has nothing to show). */
export function issuerDisclosure(conn: Pick<GoogleConnectionView, "issuerHost" | "issuerIsGoogle">): string | null {
  if (conn.issuerIsGoogle) return null;
  return conn.issuerHost ? `Non-Google issuer: ${conn.issuerHost}` : "Non-Google issuer (host unknown)";
}

// ── GSC + GA4 read ingestion (SM-25b; design addendum §A12, tracker §6ay) ────────────────────────────
// Field names verified against `google/gsc-client.ts`'s `GscPullOutcome`/`GscTopQuery` and
// `google/ga4-client.ts`'s `Ga4PullOutcome`, plus `search.controller.ts`'s `listGscPerformance`/
// `listGa4Metrics` SELECTs (§4i discipline). GSC lags 2-3 days and GA4 samples large reports — the
// freshness/sampling fields below exist ONLY because a chart that silently plots a clamped range as
// "today", or a sampled figure that looks exact, would reintroduce exactly the lie this backend went
// to trouble to prevent. Neither table has a `simulated` derived from platform mode: it is stamped
// from the owning CONNECTION's `issuerIsGoogle` flag (§A12.2 "audience, not label"), so a row's own
// chip is the only trustworthy provenance signal — never inferred from anything else on the page.
export interface GscPerformanceRow {
  id: string;
  date: string;
  query: string;
  page: string;
  device: string;
  clicks: number;
  impressions: number;
  /** Google's own unit: a FRACTION (0..1), never a percentage. `numeric(9,6)` on the wire — may
   *  arrive as a string if unc cast; coerce before formatting. */
  ctr: number | string | null;
  /** 1-based average position, a float. `numeric(9,2)` on the wire. */
  position: number | string | null;
  simulated: boolean;
  fetchedAt: string;
}

export interface GscTopQueryRow {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}

export interface GscPullOutcome {
  propertyId: string;
  status: "pulled";
  startDate: string;
  /** What the caller asked for. Compare against `effectiveEndDate` to know whether a clamp happened —
   *  never assume the two match. */
  requestedEndDate: string;
  /** What was ACTUALLY requested from Google, after the freshness-lag clamp. This is the honest end
   *  of the returned data — render THIS as the range end, never `requestedEndDate`. */
  effectiveEndDate: string;
  /** true iff the requested end date reached into the freshness-lag window and was pulled back. Must
   *  be surfaced next to the date range it describes, not buried in a footnote. */
  clampedForFreshness: boolean;
  freshnessLagDays: number;
  rowsUpserted: number;
  malformedRowsSkipped: number;
  pagesFetched: number;
  /** True iff the page-count safety cap was hit while the last page was still full — more data may
   *  exist that this pull did not fetch. A caller reading `truncated: true` knows `rowsUpserted` is a
   *  FLOOR, not a complete count; must render as a visible caveat, never silently. */
  truncated: boolean;
  provider: "google_search_console";
  connectionId: string;
  simulated: boolean;
}

export interface Ga4MetricsRow {
  id: string;
  date: string;
  channelGroup: string;
  sessions: number;
  engagedSessions: number;
  /** `numeric(14,2)` on the wire — may arrive as a string. */
  conversions: number | string;
  /** Nullable: absent unless the property has ecommerce/revenue events configured — "no revenue
   *  configured" and "zero revenue this period" are different facts and must render differently. */
  totalRevenue: number | string | null;
  /** REPORT-level GA4 fact denormalized onto every row of the response that produced it. A sampled
   *  figure is an ESTIMATE, not an exact count — must render distinguishably at the row, not only in
   *  a page-level footnote. */
  sampled: boolean;
  simulated: boolean;
  fetchedAt: string;
}

export interface Ga4PullOutcome {
  propertyId: string;
  status: "pulled";
  startDate: string;
  requestedEndDate: string;
  effectiveEndDate: string;
  clampedForFreshness: boolean;
  freshnessLagDays: number;
  rowsUpserted: number;
  malformedRowsSkipped: number;
  sampled: boolean;
  provider: "google_analytics";
  connectionId: string;
  simulated: boolean;
}

export interface GscKeywordImportResult {
  setId: string;
  imported: number;
  submitted: number;
  considered: number;
  duplicates: number;
}

/** GSC's CTR fraction (0..1) as a percentage string — "—" for null/absent/non-numeric, never "0%"
 *  for an absent value (that would be a claim, not honest absence — the house "— never 0" rule). */
export function formatCtr(n: unknown): string {
  if (n === null || n === undefined || n === "") return "—";
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

/** Plain count formatter for a GA4/GSC metric that may arrive as a `numeric`-typed STRING
 *  (conversions/totalRevenue) — same null/NaN-safe contract as `numberOrDash`, kept as its own named
 *  export here so a caller reads intent ("this is a Google metric") rather than reusing a generic
 *  helper by coincidence. */
export function formatGoogleMetric(n: unknown): string {
  return numberOrDash(n);
}

/** The freshness-lag disclosure line — one sentence, reused everywhere a pulled range is shown, so
 *  the wording can't drift between the GSC and GA4 halves of the page. Always states BOTH the
 *  effective end date and whether a clamp happened; never omits the clamp fact even when it is
 *  `false` (the whole point is that "not clamped" is itself informative, not merely the quiet case). */
export function freshnessDisclosure(args: { effectiveEndDate: string; clampedForFreshness: boolean; freshnessLagDays: number }): string {
  return args.clampedForFreshness
    ? `Data through ${args.effectiveEndDate} — the requested end date fell inside Google's own ` +
        `${args.freshnessLagDays}-day freshness lag, so the range was pulled back to the last day ` +
        `Google can answer for; a partial day was never requested.`
    : `Data through ${args.effectiveEndDate} (no clamp needed — outside the ${args.freshnessLagDays}-day freshness-lag window).`;
}
