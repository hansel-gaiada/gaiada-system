// SM-04 — the SearchDataProvider abstraction (design §05). Capability-based so drivers can be
// partial (DataForSEO Standard covers most; the free `scraper` fallback covers only suggestions).
// SM-05 fills in the real DataForSEO HTTP driver BEHIND this interface; SM-04 ships the interface,
// the capability registry, the per-engagement selection cascade, the Postgres cache + single-flight
// dispatch, the fail-closed scope/budget stop-loss, the metering ledger, and a mock/stub driver for
// tests. Nothing here talks to a real provider network endpoint.
//
// SM-42 (design addendum §A8.7, tracker §6j step 3) adds the OPTIONAL post-call true-up surface —
// see SearchDataProvider.takeActualCostUsd below and the withActualCostCapture/recordActualCostUsd/
// takeCapturedActualCostUsd trio near the bottom of this file.
import { AsyncLocalStorage } from "node:async_hooks";

/** Provider capabilities (design §05 sketch). A driver advertises the subset it implements. */
export type Capability =
  | "serp"
  | "volume"
  | "suggestions"
  | "difficulty"
  | "backlinks"
  | "competitors"
  | "ai_visibility";

/** The dispatchable operation kinds SM-04 supports end-to-end (each has a provider method AND a
 *  `search_data_cache.kind`). `competitors`/`difficulty` are advertised capabilities but not
 *  standalone dispatch ops in v1 — difficulty rides the `volume` metrics pull. */
export type OpKind = "serp" | "volume" | "suggestions" | "backlinks" | "ai_visibility";

/** `search_data_cache.kind` CHECK values (0034). OpKind is a subset; kept explicit so a cache-key
 *  builder can never emit a kind the table rejects. */
export type CacheKind = "serp" | "volume" | "suggestions" | "backlinks" | "competitors" | "ai_visibility";

/** The capability a given op requires — the resolved provider MUST advertise it or dispatch is
 *  refused fail-closed (NoCapableProviderError). */
export const OP_CAPABILITY: Record<OpKind, Capability> = {
  serp: "serp",
  volume: "volume",
  suggestions: "suggestions",
  backlinks: "backlinks",
  ai_visibility: "ai_visibility",
};

/** The engagement `tool_scope` toggle key that gates a given op (design §04/§05, D-11). A missing
 *  or `enabled !== true` toggle refuses the op naming THIS key — regardless of budget. The map is
 *  the single source of truth for "which switch turns this pull on", shared by the choke-point and
 *  the cost-projection surface so the two can never disagree. */
export const OP_SCOPE_TOGGLE: Record<OpKind, string> = {
  serp: "rank",
  volume: "volume",
  suggestions: "suggestions",
  backlinks: "backlinks",
  ai_visibility: "ai_visibility",
};

/** Per-kind cache TTL in seconds (design §05). `serp` is cached 24h BUT tracked-rank pulls bypass
 *  the cache entirely (they must capture the property's live position) — see DispatchInput.bypassCache. */
export const CACHE_TTL_SECONDS: Record<OpKind, number> = {
  volume: 30 * 24 * 3600, // 30d
  serp: 24 * 3600, // 24h (tracked-rank pulls bypass)
  suggestions: 14 * 24 * 3600, // 14d
  backlinks: 7 * 24 * 3600, // 7d
  ai_visibility: 7 * 24 * 3600, // 7d
};

export type ProviderKey = "dataforseo" | "semrush" | "scraper" | "ahrefs";

// ── Request / result shapes (illustrative; SM-05 refines against DataForSEO's real envelopes) ──────
export interface SerpRequest {
  keyword: string;
  engine?: string;
  device?: string;
  locale?: string;
  locationCode?: number;
}
export interface TaskRef {
  id: string;
  keyword: string;
}
export interface SerpResult {
  keyword: string;
  items: Array<{ position: number; url: string; title?: string }>;
  serpFeatures?: Record<string, boolean>;
}
export interface KeywordQuery {
  keyword: string;
  locale?: string;
  locationCode?: number;
}
export interface KeywordMetrics {
  keyword: string;
  volume?: number;
  cpcUsd?: number;
  difficulty?: number;
  suggestions?: string[];
}
export interface BacklinkSummary {
  target: string;
  backlinks: number;
  refDomains: number;
  authorityScore?: number;
}
export interface AiVisibilityQuery {
  query: string;
  engine?: string;
}
export interface AiVisibilityResult {
  engine: string;
  query: string;
  brandMentioned: boolean;
  cited: boolean;
  citedUrl?: string;
  prominence?: number;
}

/** The unit of work the cost estimator + dispatcher reason about. `items` drives cost and cache
 *  key granularity is per-op (one keyword / one domain per op) so cross-tenant reuse is maximal. */
export interface ProviderOp {
  kind: OpKind;
  /** normalized subject: the keyword (serp/volume/suggestions), domain/target (backlinks), or
   *  the AI-visibility query. Canonicalized (lowercased/trimmed) into the cache key. */
  query: string;
  engine?: string;
  device?: string;
  locale?: string;
  locationCode?: number;
  /** billable item count for THIS op (e.g. keyword batch size); defaults to 1. */
  items?: number;
}

/** The provider contract (design §05). Async-queue model for SERP (post → poll/postback-fetch);
 *  metrics/backlinks/ai-visibility resolve directly. `estimateCostUsd` is consulted BEFORE dispatch
 *  by the stop-loss and by the projection endpoint — it must be pure + synchronous. */
export interface SearchDataProvider {
  key: ProviderKey;
  capabilities: Set<Capability>;
  postSerpTasks(reqs: SerpRequest[]): Promise<TaskRef[]>;
  fetchSerpResults(refs: TaskRef[]): Promise<SerpResult[]>;
  getKeywordMetrics(kws: KeywordQuery[]): Promise<KeywordMetrics[]>;
  getBacklinkSummary(target: string): Promise<BacklinkSummary>;
  getAiVisibility(q: AiVisibilityQuery): Promise<AiVisibilityResult[]>;
  estimateCostUsd(op: ProviderOp): number;
  /** SM-42 (design addendum §A8.7, tracker §6j step 3) — the OPTIONAL post-call true-up surface.
   *  `estimateCostUsd` is a pure, PRE-dispatch function with no access to a response, so a vendor
   *  that reports the true cost of a call only in that call's own response (Ahrefs's confirmed
   *  `x-api-units-cost-total-actual` header) has no way to correct the ledger without this. When a
   *  driver implements it, dispatch.ts calls it exactly once per real dispatch — inside
   *  `withActualCostCapture` below, immediately after the SearchDataProvider method(s) that produced
   *  this call's payload — and uses a defined return value to advance the ledger row from its
   *  pre-dispatch ESTIMATE to this ACTUAL figure, in EITHER direction (down when the estimate
   *  over-counted, up when it under-counted). Returning `undefined` (nothing observed this call) is
   *  NOT the same as a $0 true-up: dispatch leaves the row at its estimate untouched.
   *
   *  OPTIONAL is load-bearing, not incidental: DataForSEO bills a single published flat per-call USD
   *  price with no vendor-reported correction to apply, and every simulator's dollars are synthetic
   *  by construction — neither needs, nor implements, this method, and dispatch.ts must treat its
   *  absence as "no correction available", never call a phantom default.
   *
   *  CONCURRENCY (the reason this is a method dispatch TAKES from the provider, rather than a value
   *  the provider methods above simply return): a provider instance is a process-level singleton
   *  (registry.ts), and Ahrefs's own getBacklinkSummary makes TWO parallel internal HTTP calls for
   *  ONE op — so an implementation must both SUM multiple calls belonging to the SAME op and never
   *  let a DIFFERENT op racing concurrently against the same instance observe or clobber this one's
   *  total. An instance field written by "whichever response happened to resolve last" satisfies
   *  neither property and is NOT a valid implementation — see withActualCostCapture/
   *  recordActualCostUsd/takeCapturedActualCostUsd below for the AsyncLocalStorage-scoped mechanism
   *  every implementing driver should build on (ahrefs.ts is the reference implementation), and
   *  dispatch.test.ts / ahrefs.test.ts's racing tests for the proof. */
  takeActualCostUsd?(): number | undefined;
}

// ── Typed refusals from the dispatch choke-point (all fail-closed) ─────────────────────────────────
export class ProviderDispatchError extends Error {
  constructor(
    readonly code:
      | "pillar_disabled"
      | "scope_disabled"
      | "budget_exceeded"
      | "no_capable_provider"
      | "unknown_provider"
      | "global_ceiling_unavailable"
      | "provider_ceiling_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ProviderDispatchError";
  }
}

/** Which pillar kill-switch (SM-06, `config.search.pillars`) governs an op. SEM has no paid data
 *  pull of its own in v1 — its planning objects are built from SEO's keyword data — so no op maps
 *  to 'sem' yet; the flag exists for SM-18+ and for symmetry in the operator surface. */
export type Pillar = "seo" | "sem" | "geo";
export const OP_PILLAR: Record<OpKind, Pillar> = {
  serp: "seo",
  volume: "seo",
  suggestions: "seo",
  backlinks: "seo",
  ai_visibility: "geo",
};

/** (-1) The operator kill switch for this op's pillar is off (SM-06). Checked BEFORE the scope
 *  gate: it is an incident brake that outranks any per-engagement configuration. */
export class PillarDisabledError extends ProviderDispatchError {
  constructor(readonly pillar: Pillar, readonly opKind: OpKind) {
    super("pillar_disabled", `search-provider op '${opKind}' is refused: the '${pillar}' pillar is disabled platform-wide (SEARCH_PILLAR_${pillar.toUpperCase()}=0)`);
    this.name = "PillarDisabledError";
  }
}

/** (0) The op's tool_scope toggle is off (or absent) — refused naming the toggle, before any
 *  budget arithmetic or provider selection (design §05). */
export class ScopeDisabledError extends ProviderDispatchError {
  constructor(readonly toggle: string, readonly opKind: OpKind) {
    super("scope_disabled", `search-provider op '${opKind}' is refused: enable the '${toggle}' tool in this engagement's scope config`);
    this.name = "ScopeDisabledError";
  }
}

/** SM-40 (design addendum §A3.5) inserts `provider` between `tenant` and `global`: the budget
 *  cascade is engagement -> tenant -> provider -> global (first breach wins, evaluateBudget in
 *  dispatch.ts). */
export type BudgetTier = "engagement" | "tenant" | "provider" | "global";

/** (1) A month-to-date spend tier would be breached by this dispatch — refused, event emitted,
 *  blocked state recorded (design §05/§11). */
export class BudgetExceededError extends ProviderDispatchError {
  constructor(
    readonly tier: BudgetTier,
    readonly capUsd: number,
    readonly monthToDateUsd: number,
    readonly estimateUsd: number,
  ) {
    super(
      "budget_exceeded",
      `search-provider ${tier} budget would be exceeded: month-to-date $${monthToDateUsd.toFixed(6)} + estimate $${estimateUsd.toFixed(6)} > cap $${capUsd.toFixed(6)}`,
    );
    this.name = "BudgetExceededError";
  }
}

/** (1b-provider) SM-40 (design addendum §A3.5) — the per-provider month-to-date spend could not be
 *  computed, so the provider ceiling cannot be evaluated. This tier bounds a PREPAID vendor's
 *  (Semrush, Ahrefs) reserved SHARE of its shared subscription allowance, or a genuinely PAYG
 *  vendor's (DataForSEO) deposit-burn ceiling — both cross-tenant aggregates over the same
 *  `search_provider_calls` ledger `sumGlobalMonthToDate` reads, just filtered to one provider.
 *  Refused rather than degraded, for the identical reason as GlobalCeilingUnavailableError
 *  immediately below (§4d, the fail-open class this whole ticket exists to foreclose): a $0
 *  month-to-date can never breach a cap, so treating an uncomputable sum as $0 would silently
 *  disarm this tier the moment its cross-tenant aggregate hits a permission or logic fault — and
 *  unlike the global tier, THIS is the only tier standing between a misconfigured engagement and
 *  overrunning the humans' interactive share of a shared paid subscription. A tier whose cap is
 *  unset (`config.search.providerMonthlyCapUsd[key] == null`) is SKIPPED before this sum is even
 *  attempted (dispatch.ts) — this error can only fire for a provider that HAS a configured cap. */
export class ProviderCeilingUnavailableError extends ProviderDispatchError {
  constructor(readonly provider: string, readonly cause: string) {
    super(
      "provider_ceiling_unavailable",
      `search-provider dispatch refused: the '${provider}' provider's monthly ceiling could not be evaluated (${cause})`,
    );
    this.name = "ProviderCeilingUnavailableError";
  }
}

/** (1b) The platform-wide month-to-date spend could not be computed, so the global ceiling — the
 *  LAST stop-loss tier, and on the default config the ONLY platform-wide one (a tenant cap is
 *  optional and unset by default) — cannot be evaluated. Refused rather than degraded: treating an
 *  uncomputable ceiling as $0 spent is a silent fail-OPEN on the money path. The realistic cause is
 *  a permission/logic failure in the cross-tenant aggregate (see ledger.sumGlobalMonthToDate and
 *  its lint-withtenants allowlist entry), not a transient outage — a genuinely dead database fails
 *  the rest of dispatch anyway, so failing closed here costs almost no availability. */
export class GlobalCeilingUnavailableError extends ProviderDispatchError {
  constructor(readonly cause: string) {
    super(
      "global_ceiling_unavailable",
      `search-provider dispatch refused: the platform-wide monthly ceiling could not be evaluated (${cause})`,
    );
    this.name = "GlobalCeilingUnavailableError";
  }
}

export class NoCapableProviderError extends ProviderDispatchError {
  constructor(readonly capability: Capability) {
    super("no_capable_provider", `no registered search-data provider advertises capability '${capability}'`);
    this.name = "NoCapableProviderError";
  }
}

// ── SM-42 — the concurrency-safe true-up capture mechanism (design addendum §A8.7) ─────────────────
//
// This replaces the shape that created the hazard in the first place: ahrefs.ts previously held a
// single `lastObservedActualUnitsCost` INSTANCE FIELD, written by whichever of the driver's internal
// HTTP calls happened to resolve last. That is a real bug the moment more than one call can be in
// flight against the same provider instance — and Ahrefs's own getBacklinkSummary already issues TWO
// calls in parallel (backlinks-stats + domain-rating) for a SINGLE op. A shared last-write-wins field
// gets that case wrong even with no other op involved (it returns only the later call's figure, never
// the sum of both), and gets it WORSE the moment a second, wholly unrelated op dispatches concurrently
// against the same singleton (registry.ts holds exactly one instance per ProviderKey): the second op's
// response can silently overwrite the first op's captured value before the first op ever reads it
// back, attributing one call's actual cost to the wrong ledger row, or dropping it.
//
// AsyncLocalStorage fixes both properties at once, by construction: `withActualCostCapture` opens a
// FRESH store for each call, and every internal HTTP call awaited (directly, or fanned out via
// Promise.all, as getBacklinkSummary does) from within that one call's execution shares that ONE
// store — so multiple calls belonging to the SAME op correctly ADD UP — while a different op racing
// concurrently against the same provider instance runs under an entirely separate `run()` invocation
// with its OWN store object, which the first op's code can neither see nor write to. No shared
// mutable state ever crosses an op boundary; isolation is a property of the async context, not of
// discipline the driver author has to get right by hand.
const actualCostCaptureStorage = new AsyncLocalStorage<{ totalUsd: number; observed: boolean }>();

/** Run `fn` — dispatch.ts's ONE invokeProvider() call for a real dispatch — inside a fresh capture
 *  scope, then, still INSIDE that scope (before this async function's own promise settles), ask the
 *  provider what it captured via the optional `takeActualCostUsd()`. Keeping that call inside the
 *  `run()` callback is what makes the read-back correct: calling it after this promise has already
 *  resolved would observe no active store at all (ALS context does not survive past the callback that
 *  established it). A provider with no `takeActualCostUsd` method (DataForSEO, every simulator)
 *  simply yields `actualCostUsd: undefined` — a missing capability, never a placeholder $0. */
export async function withActualCostCapture<T>(
  provider: SearchDataProvider,
  fn: () => Promise<T>,
): Promise<{ result: T; actualCostUsd: number | undefined }> {
  return actualCostCaptureStorage.run({ totalUsd: 0, observed: false }, async () => {
    const result = await fn();
    const actualCostUsd = provider.takeActualCostUsd?.();
    return { result, actualCostUsd };
  });
}

/** Called by a driver's internal HTTP layer (ahrefs.ts's `call()`) the instant a response reports a
 *  vendor-confirmed actual cost for THAT ONE call, already converted to USD — the driver owns its own
 *  unit->USD rate; this module carries no vendor pricing knowledge and does no conversion. ADDITIVE,
 *  deliberately never last-write-wins: a single op can fan out into several HTTP calls (Ahrefs
 *  backlinks: stats + domain-rating, run via Promise.all), and a true-up must equal the SUM of what
 *  the vendor actually charged for ALL of them, not whichever response happened to be parsed last. A
 *  call made OUTSIDE any withActualCostCapture() scope (e.g. a driver unit test invoking the HTTP
 *  method directly, with no capture wrapper) is a harmless, documented no-op: recording is
 *  opportunistic bookkeeping, never a precondition for the call's own correctness. */
export function recordActualCostUsd(usd: number): void {
  const store = actualCostCaptureStorage.getStore();
  if (!store) return;
  store.totalUsd += usd;
  store.observed = true;
}

/** The read-AND-CLEAR half a driver's `takeActualCostUsd()` implementation calls (see ahrefs.ts).
 *  Clearing, not just reading, is defence in depth: it makes a store's contents unobservable a second
 *  time, so even a future bug that invoked take twice, or retained a stale store reference across
 *  calls, cannot double-count a figure or replay it into an unrelated ledger row. Returns `undefined`
 *  (never 0) when nothing was ever recorded in this scope — the distinction dispatch.ts's
 *  "undefined = no correction available" contract depends on. */
export function takeCapturedActualCostUsd(): number | undefined {
  const store = actualCostCaptureStorage.getStore();
  if (!store || !store.observed) return undefined;
  const total = store.totalUsd;
  store.totalUsd = 0;
  store.observed = false;
  return total;
}
