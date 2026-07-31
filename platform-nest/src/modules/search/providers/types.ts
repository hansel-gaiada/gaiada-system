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
  /** SM-56 (addendum §A11.1.4) — THE COLLECT SURFACE. Retrieve a task's result BY ITS TASK ID, for a
   *  task THIS PLATFORM ALREADY PAID FOR at post time.
   *
   *  Why it is a separate method rather than a reuse of `fetchSerpResults`: the two differ in exactly
   *  the property that matters. `fetchSerpResults` is only ever reachable through
   *  `invokeProvider`, which calls `postSerpTasks` FIRST — so every path that can retrieve a SERP
   *  today also enqueues (and, on the DataForSEO Standard queue, PAYS for) a brand-new task. That is
   *  correct for a pull and catastrophic for a collect: a genuine vendor postback arriving for a task
   *  we already bought would trigger a second `task_post` and be charged twice for the same data
   *  (tracker §6ah/§6ak, reproduced at the transport layer). §A11.1.4's ruling is literal —
   *  **`task_get` only** — and an interface member is how that becomes enforceable rather than
   *  aspirational: the collect edge can reach ONLY this method, which has no posting step to reach.
   *
   *  THE CONTRACT EVERY IMPLEMENTATION MUST KEEP, and it is a money contract, not a style note:
   *    1. It MUST NOT enqueue, post, or otherwise create billable vendor work. Zero new charges.
   *    2. It MUST NOT call `recordIncurredCostUsd`/`recordActualCostUsd`. There is no charge to
   *       declare — the money was declared at the billing point of the ORIGINAL post — and declaring
   *       one here would write a second cost-bearing row for a single vendor charge, double-counting
   *       real money into all four budget tiers and the exec rollup.
   *    3. It MAY retry/poll, because polling a completed task is free on every vendor whose queue
   *       model charges at post.
   *  Prove property 1 by counting requests at the TRANSPORT layer (dataforseo.sandbox.test.ts does
   *  exactly this over real sockets), never by asserting that a returned cost was 0 — a cost of 0 is
   *  also what a driver that posted and mispriced would report.
   *
   *  OPTIONAL, and the absence is meaningful rather than a hole to paper over: a vendor with no
   *  asynchronous queue has no task id to collect against, so there is nothing for it to implement.
   *  The collect edge REFUSES fail-closed when the resolved driver does not implement this (it cannot
   *  fall back to the dispatch path — falling back is precisely the defect), and refusing costs
   *  nothing. Never provide a phantom default. */
  fetchSerpByTaskId?(ref: TaskRef): Promise<SerpResult>;
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

// ── SM-50 — the INCURRED-cost channel a driver reports its billing point on (addendum §A11.1.3) ─────
//
// There is no interface member for this, and that omission is the ruling, not an oversight: "a billing
// point is an EVENT WITH AN AMOUNT, not a static method property". A driver cannot usefully declare
// "my task_post is billable" up front — what matters is that a specific post was ACCEPTED, how many
// tasks it accepted, and what the vendor's published rate for that queue is. So the declaration is a
// CALL, made by the driver at the instant the vendor confirmably charges:
//
//     recordIncurredCostUsd(usd, vendorRef?)   // see below
//
// Only the driver knows its vendor's billing point (dataforseo.ts records at parsed `task_post`
// acceptance; prepaid vendors would record per served 2xx). This is deliberately a SECOND CHANNEL on
// SM-42's existing per-dispatch AsyncLocalStorage store rather than an overload of
// `takeActualCostUsd`: a CORRECTION signal ("the estimate was wrong, here is the real figure") and a
// LIABILITY signal ("we owe this money whatever happens next") mean different things, and collapsing
// two meanings onto one reader is the §6r class of defect. `recordActualCostUsd` IMPLIES incurred — a
// vendor-confirmed actual charge is by definition an incurred charge — so Ahrefs's existing capture
// feeds both channels with no second call site to drift out of sync.

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
      | "provider_ceiling_unavailable"
      // SM-56 — the resolved driver has no `fetchSerpByTaskId`, so a task this platform already paid
      // for cannot be collected without re-posting it. Refused, never downgraded to the dispatch
      // path: the whole ticket is that a collect must not spend money. Unmapped in
      // provider-dispatch-error.filter.ts ON PURPOSE — that file's documented default for a new
      // refusal code is 503, which is the same status its four "capability unavailable in this
      // deployment" codes already carry, and is the right answer here (nothing the caller can change,
      // not a crash). Pinned by a test so the default is relied on knowingly, not by accident.
      | "collect_unsupported",
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

/** SM-56 (addendum §A11.1.4) — the collect edge resolved a driver that cannot fetch a paid task by its
 *  id (no `fetchSerpByTaskId`, see the interface member's contract). Refused rather than falling back
 *  to `postSerpTasks` + `fetchSerpResults`, because that fallback IS the double-charge this ticket
 *  exists to close: it would buy the same data a second time. A refusal costs nothing; the original
 *  charge stays recorded exactly as it is, and SM-41's reconciliation still sees it. */
export class CollectUnsupportedError extends ProviderDispatchError {
  constructor(readonly provider: string) {
    super(
      "collect_unsupported",
      `provider '${provider}' cannot collect a completed task by id (no task-id-keyed fetch), and re-posting a paid task is forbidden`,
    );
    this.name = "CollectUnsupportedError";
  }
}

/** SM-56 — a postback quoted a vendor task id this tenant has no ledger row for, so there is no
 *  evidence THIS platform ever paid for it. Refused BEFORE any vendor call, which is what makes the
 *  edge cheap to attack and pointless to forge: a forged or replayed-with-garbage postback costs a
 *  ledger lookup and nothing else — no socket to the vendor, no row, no money.
 *
 *  The lookup is RLS-scoped (see ledger.findLedgerRowByVendorRef), so this also forecloses the
 *  cross-tenant shape: a caller authenticated for tenant A quoting tenant B's task id gets THIS error,
 *  not tenant B's data. Foreclosed by construction, not filtered.
 *
 *  A NARROW, HONEST FALSE POSITIVE, stated rather than hidden: the vendor could in principle postback
 *  before our own dispatch transaction has COMMITTED the `posted` row that stamps this `vendor_ref`.
 *  The collect then refuses a legitimate task. At-least-once postback delivery is the vendor norm, so
 *  the retry succeeds; and DataForSEO's Standard queue takes minutes to crawl, so the window is
 *  theoretical rather than operational. Refusing is the correct direction anyway — a collect that
 *  trusted an unknown task id would be writing vendor-supplied data into a client's record on nothing
 *  but the caller's word. */
export class UnknownVendorTaskError extends Error {
  constructor(readonly provider: string, readonly taskId: string) {
    super(`no ledger record of a paid '${provider}' task with this id for this tenant`);
    this.name = "UnknownVendorTaskError";
  }
}

/** SM-50 (addendum §A11.1.3) — an INTERNAL envelope, not a refusal. `withActualCostCapture` throws
 *  this when the wrapped provider call rejected AFTER the driver had already recorded an incurred
 *  charge, so that dispatch.ts can tell "failed, nothing spent" (roll back, no row — still correct)
 *  apart from "failed, money already gone" (roll back AND write a compensating `incurred` row outside
 *  the rolled-back transaction).
 *
 *  DELIBERATELY NOT a ProviderDispatchError, and it deliberately carries no new refusal `code`: this
 *  class must never reach a caller of dispatchProviderOp. dispatch.ts catches it, performs the
 *  compensating write, and rethrows `cause` — the ORIGINAL typed provider error, byte-for-byte — so
 *  every existing caller, the ProviderDispatchError HTTP filter, and every existing test assertion on
 *  a provider error message keep their exact previous behaviour. The compensating write is
 *  bookkeeping; it is not, and must never become, a replacement for the failure the caller asked
 *  about. If you ever find yourself widening the refusal-code union for this, stop: that would mean
 *  the envelope has started escaping. */
export class ProviderFailedAfterSpendError extends Error {
  constructor(
    readonly cause: unknown,
    readonly incurredUsd: number,
    readonly vendorRefs: string[],
  ) {
    super(
      `search-provider call failed AFTER the vendor was charged $${incurredUsd.toFixed(6)}: ` +
      `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "ProviderFailedAfterSpendError";
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
//
// SM-50 (addendum §A11.1.3) adds a SECOND CHANNEL to this same store, not a second store: one store
// per dispatch, two independent accumulators.
//   * totalUsd/observed — SM-42's CORRECTION channel, read-AND-CLEARED by a driver's
//     takeActualCostUsd() at the end of a SUCCESSFUL call.
//   * incurredUsd/incurredObserved/vendorRefs — SM-50's LIABILITY channel, read by
//     withActualCostCapture itself on BOTH paths: on success to stamp `vendor_ref` on the posted row,
//     and on failure to decide whether a compensating `incurred` row is owed.
//
// SM-60 (tracker §6ak) — the LIABILITY CHANNEL'S AMOUNT NOW LEAVES THE SCOPE ON THE SUCCESS PATH TOO.
// SM-50 let the amount escape only inside ProviderFailedAfterSpendError, i.e. only when the provider
// call itself rejected. But a dispatch can be charged, delivered, and STILL lose the money record: the
// critical-section callback continues after this wrapper resolves (writeCache -> insertLedgerRow, same
// transaction), and a throw there rolls the transaction back exactly like a provider rejection while
// this scope — and with it every trace of the charge — is already gone. So the success return carries
// `incurredUsd` alongside `vendorRefs`: the amount, not just the refs, is what a compensating write
// needs, and the ONLY place it can still be read is inside this `run()` callback. Everything after that
// point is dispatch.ts's job (see its SpendLiability handoff); this file's job is simply to stop being
// the place where the number dies.
// They are separate fields precisely so takeActualCostUsd()'s clear-on-read cannot destroy the
// liability record: a driver reads the correction channel, the framework reads the liability channel,
// and neither can consume the other's value. Both inherit the same isolation-by-construction the
// SM-42 analysis above establishes — a concurrent, unrelated dispatch against the same provider
// singleton runs under its own run() invocation with its own store object.
const actualCostCaptureStorage = new AsyncLocalStorage<{
  totalUsd: number;
  observed: boolean;
  incurredUsd: number;
  incurredObserved: boolean;
  vendorRefs: string[];
}>();

/** Run `fn` — dispatch.ts's ONE invokeProvider() call for a real dispatch — inside a fresh capture
 *  scope, then, still INSIDE that scope (before this async function's own promise settles), ask the
 *  provider what it captured via the optional `takeActualCostUsd()`. Keeping that call inside the
 *  `run()` callback is what makes the read-back correct: calling it after this promise has already
 *  resolved would observe no active store at all (ALS context does not survive past the callback that
 *  established it). A provider with no `takeActualCostUsd` method (DataForSEO, every simulator)
 *  simply yields `actualCostUsd: undefined` — a missing capability, never a placeholder $0.
 *
 *  SM-50 (addendum §A11.1.3) — this function is now ALSO the failure boundary:
 *
 *  * On SUCCESS it additionally returns `vendorRefs`, so dispatch stamps the vendor's own id (the
 *    DataForSEO task id) onto the successful ledger row — one column, both paths (§A11.1.4) — and
 *    (SM-60) `incurredUsd`, the liability channel's AMOUNT, because the post-success writes that follow
 *    this call can still fail and lose the row, and the amount is unreachable once this scope closes.
 *    `0` means "the driver reported no confirmable charge for this call" and is the same signal the
 *    rejection path treats as "nothing owed" — never a placeholder for an unknown charge.
 *  * On REJECTION it inspects the liability channel BEFORE the scope closes. When the driver recorded
 *    nothing, the rejection is re-thrown UNTOUCHED and today's behaviour is preserved byte-for-byte
 *    (the transaction rolls back, no row is written — still exactly right, because the vendor was
 *    never engaged). When the driver DID record a charge, the rejection is wrapped in
 *    `ProviderFailedAfterSpendError` so dispatch.ts can compensate outside the doomed transaction.
 *    The wrapper is unwrapped there and never reaches a caller — see that class's own doc comment.
 *
 *  Reading the store inside the catch, INSIDE `run()`, is load-bearing for the same reason the
 *  success-path read is: after this promise settles there is no active store to read, so a liability
 *  recorded by the driver would be silently lost — which is the entire defect this ticket closes,
 *  reintroduced one layer up. */
export async function withActualCostCapture<T>(
  provider: SearchDataProvider,
  fn: () => Promise<T>,
): Promise<{ result: T; actualCostUsd: number | undefined; vendorRefs: string[]; incurredUsd: number }> {
  return actualCostCaptureStorage.run(
    { totalUsd: 0, observed: false, incurredUsd: 0, incurredObserved: false, vendorRefs: [] },
    async () => {
      let result: T;
      try {
        result = await fn();
      } catch (err) {
        const incurred = peekCapturedIncurred();
        // `> 0` rather than `incurredObserved`, on purpose: a driver that recorded a $0 charge has
        // told us the vendor was engaged for nothing billable, and a $0 incurred row would be noise
        // in the ledger AND a $0 row on the money path (the §A9.5 degenerate-input class). Nothing
        // recorded and nothing owed take the identical, unchanged path.
        if (incurred.usd > 0) {
          throw new ProviderFailedAfterSpendError(err, incurred.usd, incurred.vendorRefs);
        }
        throw err;
      }
      const actualCostUsd = provider.takeActualCostUsd?.();
      // SM-60: read the liability channel ONCE, after the driver has consumed its own correction
      // channel, and return BOTH halves. peekCapturedIncurred is non-clearing precisely so this read
      // and the catch-path read above cannot destroy each other's value (see its doc comment) — and
      // note this read must stay INSIDE the run() callback for the same reason that one does: after
      // this promise settles there is no active store, so the amount would be silently lost.
      const incurred = peekCapturedIncurred();
      return { result, actualCostUsd, vendorRefs: incurred.vendorRefs, incurredUsd: incurred.usd };
    },
  );
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
  // SM-50 (§A11.1.3): "recordActualCostUsd IMPLIES incurred." A vendor-confirmed ACTUAL charge is by
  // definition an INCURRED charge, so the liability channel is fed here rather than requiring every
  // true-up-capable driver to make a second, parallel call it could forget or drift on. Composed, not
  // duplicated — this line is why ahrefs.ts needed no edit for this ticket and still produces a
  // correct incurred row if its op fails after a priced response.
  store.incurredUsd += usd;
  store.incurredObserved = true;
}

/** SM-50 (addendum §A11.1.3) — called by a driver at the exact moment its vendor CONFIRMABLY charges,
 *  with the amount in USD (the driver owns its own rate table; this module carries no vendor pricing
 *  knowledge) and, where the vendor exposes one, that call's vendor-side id.
 *
 *  "Confirmably" is the whole discipline, and it is deliberately conservative. Record at a PARSED
 *  VENDOR ACKNOWLEDGEMENT — DataForSEO's `task_post` response listing accepted tasks — never
 *  optimistically before the request, and never on an ambiguous outcome such as a timeout or an
 *  aborted socket where whether the vendor charged is genuinely unknowable. Ambiguous cases therefore
 *  UNDER-record (§A11.1.5): the residue is bounded to cents per op, and SM-41's ledger-vs-console
 *  reconciliation with its >=20% tripwire is the designed catch for it. Over-recording would be worse
 *  in kind, not just in degree — it would refuse real clients for money nobody was charged.
 *
 *  ADDITIVE, like `recordActualCostUsd`: one op can fan out into several billable vendor calls and the
 *  liability is their SUM, never whichever response was parsed last. `vendorRef` is appended in call
 *  order.
 *
 *  A call made OUTSIDE any `withActualCostCapture()` scope (a driver unit test invoking an HTTP method
 *  directly) is a harmless, documented no-op — recording is bookkeeping, never a precondition for the
 *  vendor call's own correctness. Simulators never call this at all: their dollars are synthetic, so a
 *  rollback loses nothing real and no `incurred` row can be produced by simulated traffic (§A11.1.5). */
export function recordIncurredCostUsd(usd: number, vendorRef?: string): void {
  const store = actualCostCaptureStorage.getStore();
  if (!store) return;
  store.incurredUsd += usd;
  store.incurredObserved = true;
  if (vendorRef) store.vendorRefs.push(vendorRef);
}

/** Read the liability channel WITHOUT clearing it. Non-clearing on purpose, and it is the opposite
 *  choice from `takeCapturedActualCostUsd` below for a reason: the correction channel is consumed
 *  once by the driver, whereas the liability channel is read by the FRAMEWORK on both the success and
 *  the failure path within a single scope, and a clear-on-read here would mean whichever read
 *  happened first silently erased the money record. The store dies with its `run()` scope regardless,
 *  so there is nothing to leak into a later dispatch. Not exported: only withActualCostCapture (in
 *  this file) has any business reading it — a driver reporting a charge and then reading back the
 *  running total would be building exactly the shared-mutable-state coupling the ALS design forbids. */
function peekCapturedIncurred(): { usd: number; vendorRefs: string[] } {
  const store = actualCostCaptureStorage.getStore();
  if (!store || !store.incurredObserved) return { usd: 0, vendorRefs: [] };
  return { usd: store.incurredUsd, vendorRefs: [...store.vendorRefs] };
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
