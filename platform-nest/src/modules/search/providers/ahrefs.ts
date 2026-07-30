// SM-35 — the Ahrefs API v3 driver, behind SM-04's SearchDataProvider interface (design §05,
// tracker §6 SM-35). Same discipline as dataforseo.ts/semrush.ts: everything money-related (scope
// gate, budget stop-loss, cache, ledger) lives in dispatch.ts and is NOT duplicated here. This file's
// only jobs are: speak Ahrefs's HTTP dialect, normalize its envelope into our shapes, and price an op.
//
// ── Endpoints + envelope (docs.ahrefs.com, verified via live doc fetch 2026-07-29) ─────────────────
// Base URL: https://api.ahrefs.com/v3. Auth is a Bearer token — `Authorization: Bearer <key>` plus
// `Accept: application/json` — confirmed via Ahrefs's own documented curl example. Unlike Semrush's
// classic semicolon format, Ahrefs v3 responses ARE real JSON: each endpoint wraps its payload under
// a resource-named key, confirmed for get-domain-rating (`{"domain_rating": {...}}`). Errors are
// ordinary non-2xx HTTP (400/401/403/429/500) with a `{"error": "..."}` JSON body — this driver never
// echoes that body (the AC's "no response body in error messages": Ahrefs's error body can carry
// workspace/account-identifying detail, same reasoning as DataForSEO's and Semrush's own bodies).
//
// Endpoint paths used here (confirmed via docs.ahrefs.com/api/reference/site-explorer + a documented
// example URL for /site-explorer/all-backlinks and /keywords-explorer/overview):
//   /site-explorer/backlinks-stats  -> backlinks (live/live_refdomains counts)
//   /site-explorer/domain-rating    -> backlinks (authority score component)
//   /keywords-explorer/overview     -> volume + difficulty
//   /site-explorer/organic-competitors -> competitors (capability only, no OpKind)
//   /serp-overview/serp-overview    -> serp — CONFIRMED FREE: "Requests to this endpoint are free
//                                      and do not consume any API units" (docs.ahrefs.com/api/
//                                      reference/rank-tracker/get-serp-overview). Requires a
//                                      pre-existing Rank Tracker `project_id`, which this platform
//                                      does not provision — see rankTrackerProjectId below.
//
// Ahrefs's own envelope wrapper key for backlinks-stats / keywords-explorer / organic-competitors is
// NOT independently confirmed in this research pass (only domain-rating's and serp-overview's field
// shapes were confirmed by direct doc fetch); the wrapper keys used below (`metrics`, `keywords`,
// `competitors`, `positions`) are a documented ASSUMPTION following the one confirmed pattern
// (domain-rating wraps under a key named after the resource). Since this driver is exercised only
// against an injected mock in tests (no live network, no credentials), a wrong wrapper key is a
// same-shaped fix here, not a money-safety bug — the cost derivation below is the part that is.
import { config } from "../../../config";
import {
  type AiVisibilityQuery,
  type AiVisibilityResult,
  type BacklinkSummary,
  type Capability,
  type KeywordMetrics,
  type KeywordQuery,
  type ProviderOp,
  type SearchDataProvider,
  type SerpRequest,
  type SerpResult,
  type TaskRef,
  recordActualCostUsd,
  takeCapturedActualCostUsd,
} from "./types";

// ── Unit -> USD derivation v2 (design addendum §A3/§A7 OQ-10 — THE part the review focuses on) ─────
// Ahrefs bills API UNITS against a subscription: a minimum of 50 units per call, plus per-field/
// per-row costs on top (docs.ahrefs.com/api/docs/limits-consumption, via search summary: "each API
// call costing a minimum of 50 units... the per-row cost is the sum of the costs of each unique
// field appearing in the returned result", default field cost 1 unit, some metrics 5-10 units). The
// API is a SEPARATE priced product on top of an Ahrefs seat, not bundled into the Lite/Standard/
// Advanced/Enterprise plan tiers (historically Enterprise-gated; newer plans reportedly sell API
// access separately) — `estimateCostUsd` must still return USD and stay pure + synchronous, so a
// units->USD ratio is required.
//
// RULING (addendum §A3.1/§A3.3, binding — supersedes this file's earlier draft): the ratio is
// `monthlyApiTierPriceUsd ÷ monthlyApiTierUnitAllowance`, and **both inputs are OWNER-SUPPLIED,
// UNVERIFIED facts** (§A7 OQ-10: whether the team's current Ahrefs plan includes API v3 at all, and
// if so its allowance/price — the owner must read the Ahrefs account console; two conflicting
// public figures were found during research — a "Standard" API-product tier reported at $500/mo for
// 150,000 units (requiring the separate $449/mo Advanced seat as a prerequisite), versus a different
// source's SEAT-tier "unit budgets" of 100K/400K/1M/2M tied to Lite/Standard/Advanced/Enterprise
// directly (implying no separate API product at all) — which is exactly the kind of unresolved,
// materially-different-conclusion conflict this file must surface, not silently pick one side of.
// This file does NOT invent a number and assert it as vendor truth. Both inputs default to 0 in
// config.ts, which makes the derived rate 0 — deliberately, per the fail-closed rule below.
//
// **B1 (mid-flight amendment, non-negotiable): an unset OR non-positive costPerUnitUsd means the
// driver must NOT be registered — never a $0 rate.** A $0 rate would silently disarm every budget
// tier for Ahrefs (the tracker §4d fail-open class, arriving through config instead of code).
// createAhrefsProviderFromConfig() enforces this at registration; estimateCostUsd() ALSO throws
// defensively if ever called on an instance holding a non-positive rate (covers a future caller
// constructing AhrefsProvider directly, bypassing the factory) — this applies even to the
// confirmed-free 'serp' op, because REGISTRATION is all-or-nothing per vendor: an instance that
// should not exist must not silently serve ANY op, including the one that happens to price at $0
// regardless of the rate.
//
// Deliberately EXCLUDED from the ratio, once the owner supplies real figures: the mandatory
// Advanced-plan seat (~$449/mo). Per the owner directive ("the team already uses Semrush + Ahrefs"),
// that seat is a fixed cost of maintaining vendor access independent of this integration's
// consumption. If that policy is wrong, the seat price should be added into
// `monthlyApiTierPriceUsd` in config — a one-line change, not a code change.
export function computeAhrefsCostPerUnitUsd(monthlyApiTierPriceUsd: number, monthlyApiTierUnitAllowance: number): number {
  if (!(monthlyApiTierPriceUsd > 0) || !(monthlyApiTierUnitAllowance > 0)) return 0;
  return monthlyApiTierPriceUsd / monthlyApiTierUnitAllowance;
}

// ── Published/observed per-call unit costs (Ahrefs "API units", not USD) ────────────────────────────
// NOTE on semantics: for backlinks, one "item" = one full call (one target domain per call, no
// batching), so its base costs scale WITH `items`. For keywords-explorer, one call can batch many
// keyword rows, so its base cost is charged ONCE per call and only the per-row term scales with
// `items` — see estimateCostUsd below, where this distinction is load-bearing.
export const AHREFS_RATES = {
  // /site-explorer/backlinks-stats: base minimum call cost (confirmed: 50 units/call minimum).
  backlinksStatsBaseUnits: 50,
  // /site-explorer/domain-rating: a second call for the authority-score component of
  // BacklinkSummary, also billed at the published 50-unit-per-call minimum.
  domainRatingBaseUnits: 50,
  // /keywords-explorer/overview: base minimum call cost.
  keywordsOverviewBaseUnits: 50,
  // Default per-field cost is 1 unit (confirmed); ASSUMED_FIELDS below is the field count our
  // `select=keyword,volume,traffic_potential,difficulty` request line actually asks for.
  keywordsOverviewPerFieldUnits: 1,
  keywordsOverviewAssumedFields: 4, // keyword, volume, traffic_potential, difficulty
  // /site-explorer/organic-competitors: base minimum call cost. Capability-only (no standalone
  // OpKind — 'competitors' rides no dispatch op, same as 'difficulty' does across every driver in
  // this module), listed for documentation, not consumed by estimateCostUsd below.
  organicCompetitorsBaseUnits: 50,
  // /serp-overview/serp-overview: CONFIRMED FREE. Kept as an explicit named zero (never a bare
  // magic number) so a future edit can't accidentally reprice it without touching this comment.
  serpOverviewUnits: 0,
} as const;

export interface AhrefsOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  /** ISO 3166-1 alpha-2 country code used by keywords-explorer/organic-competitors/serp-overview
   *  when a request doesn't specify one. */
  country: string;
  /** SERP Overview requires a pre-existing Ahrefs Rank Tracker project id (docs.ahrefs.com/api/
   *  reference/rank-tracker/get-serp-overview: `project_id` is a REQUIRED integer param). This
   *  platform does not provision Rank Tracker projects, so this is operator-supplied config; when
   *  absent, postSerpTasks refuses BEFORE making a network call (see the method below) rather than
   *  sending a request Ahrefs would reject anyway. */
  rankTrackerProjectId?: string;
  /** The amortized USD-per-unit rate (design addendum §A3.1), already computed by
   *  computeAhrefsCostPerUnitUsd() from owner-supplied, unverified plan facts. The FACTORY
   *  (createAhrefsProviderFromConfig) refuses to register a driver when this is <= 0; this class
   *  itself stays permissive at construction (tests build instances with an arbitrary positive test
   *  rate) but estimateCostUsd() re-asserts positivity defensively — see the B1 note above. */
  costPerUnitUsd: number;
  /** Injected in tests so a mock server can stand in for api.ahrefs.com. */
  fetchImpl?: typeof fetch;
}

function numOrUndefined(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

export class AhrefsProvider implements SearchDataProvider {
  readonly key = "ahrefs" as const;
  // Design §6 SM-35: Ahrefs covers backlinks (its strength), volume, difficulty, competitors, serp.
  // NO suggestions, NO ai_visibility — same absence as Semrush; Ahrefs's REST API has no keyword-
  // suggestions or AI-visibility product. Those two OpKinds must never resolve to this driver
  // (registry.ts's capability gate enforces that; the methods below still refuse defensively).
  //
  // SM-44(c): 'serp' is advertised CONDITIONALLY, on whether a Rank Tracker project id is configured
  // (this platform does not provision one — see AhrefsOptions.rankTrackerProjectId above).
  // postSerpTasks() already refused loudly and pre-network without one, but the capability set kept
  // claiming 'serp' regardless — so registry.ts's capability check (the thing that is SUPPOSED to
  // let dispatch refuse honestly before ever reaching a driver) had nothing to catch, and SM-29's
  // cost-projection panel priced an impossible pull at $0 (a free-looking, entirely fake "you can do
  // this for nothing" line). This also interacts correctly with SM-36 rule 2: 'serp' routes to
  // DataForSEO with no fallback anyway (§A2), so dropping it here never changes what actually serves
  // a real serp pull — it only stops Ahrefs from lying about what it can do. Computed once at
  // construction time, same "keyless-disable at capability granularity" pattern as SM-06's
  // driver-level registration gate.
  readonly capabilities: Set<Capability>;

  private readonly opts: AhrefsOptions;
  /** Ahrefs's SERP Overview is synchronous (one call, one answer) like Semrush's — there is no
   *  task-queue model like DataForSEO's Standard queue. To conform to SM-04's async
   *  postSerpTasks/fetchSerpResults shape, the HTTP call happens inside postSerpTasks and the parsed
   *  result is cached here by TaskRef id; fetchSerpResults is a pure lookup with no second network
   *  round trip. Entries are removed once read to bound memory. */
  private readonly pendingSerp = new Map<string, SerpResult>();
  private serpSeq = 0;

  /** SM-42 (design addendum §A8.7) — true-up capture, WIRED. Ahrefs CONFIRMS two response headers
   *  (docs.ahrefs.com, via search summary): `x-api-units-cost-total` (the pre-computed estimate the
   *  vendor itself would have charged for this exact call) and `x-api-units-cost-total-actual` (what
   *  it actually charged). This is genuinely verified — unlike Semrush, where no equivalent
   *  per-response header was found (see semrush.ts's estimateCostUsd doc comment).
   *
   *  Previously (SM-34/35) this could only be captured into a read-only, last-call-wins instance
   *  field (`lastObservedActualUnitsCost`), because `SearchDataProvider` had no slot for a driver to
   *  return post-call cost metadata and `estimateCostUsd` is a separate, PRE-dispatch, pure function
   *  with no access to a response. SM-42 adds that slot (`takeActualCostUsd`, optional on the
   *  interface) — see `call()` below and types.ts's withActualCostCapture/recordActualCostUsd/
   *  takeCapturedActualCostUsd for the concurrency-safe mechanism that replaces the old field
   *  entirely: instance-level state is NEVER read or written anywhere in this class for this
   *  purpose now, precisely because Ahrefs's own getBacklinkSummary below issues two calls in
   *  PARALLEL for one op, and a shared field could not attribute each call's header to the right op
   *  (or even sum two calls belonging to the SAME op) once more than one dispatch could be in flight
   *  against this singleton. `estimateCostUsd` itself is unaffected — it stays pure/synchronous. */

  constructor(opts: AhrefsOptions) {
    this.opts = opts;
    const base: Capability[] = ["backlinks", "volume", "difficulty", "competitors"];
    this.capabilities = new Set<Capability>(opts.rankTrackerProjectId ? [...base, "serp"] : base);
  }

  /** SM-42 — SearchDataProvider's optional true-up surface. Delegates entirely to the shared,
   *  ALS-scoped helper (types.ts): reads whatever `call()` below recorded during the request that is
   *  CURRENTLY resolving in this same async chain, then clears it. See types.ts's doc comments for
   *  why this is concurrency-safe against a second dispatch racing this same provider instance. */
  takeActualCostUsd(): number | undefined {
    return takeCapturedActualCostUsd();
  }

  private refuse(cap: Capability): never {
    throw new Error(`ahrefs driver does not offer '${cap}' — it is not an advertised capability (SM-35)`);
  }

  private async call<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") qs.set(k, String(v));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await doFetch(`${this.opts.baseUrl}${path}?${qs.toString()}`, {
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        // Never echo the response body: Ahrefs's `{"error": "..."}` body can carry
        // workspace/account-identifying detail.
        throw new Error(`ahrefs ${path} returned HTTP ${res.status}`);
      }
      // SM-42: capture the confirmed true-up header, converted from Ahrefs API UNITS to USD using
      // THIS instance's own amortized rate (the same `costPerUnitUsd` estimateCostUsd prices with —
      // recordActualCostUsd carries no vendor pricing knowledge of its own, by design). Recorded via
      // the shared ALS-scoped helper, NOT an instance field — see the class-level doc comment above
      // and types.ts for why: this call may be one of getBacklinkSummary's TWO PARALLEL calls for one
      // op, and the helper sums everything recorded within the current op's capture scope rather than
      // letting whichever response resolves last overwrite the other's contribution (or a
      // concurrently racing, unrelated op's).
      const actualHeader = res.headers?.get?.("x-api-units-cost-total-actual");
      if (actualHeader !== null && actualHeader !== undefined) {
        const units = Number(actualHeader);
        if (!Number.isNaN(units) && this.opts.costPerUnitUsd > 0) {
          recordActualCostUsd(units * this.opts.costPerUnitUsd);
        }
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── SERP (confirmed FREE — see AHREFS_RATES.serpOverviewUnits) ───────────────────────────────────
  async postSerpTasks(reqs: SerpRequest[]): Promise<TaskRef[]> {
    // SM-44(c): the constructor no longer puts 'serp' in `capabilities` at all when
    // rankTrackerProjectId is unset, so this line is now the one that actually fires for a
    // directly-constructed instance missing the id (defence-in-depth, same as every other
    // capability's `refuse()` guard on this class). The check below is consequently unreachable in
    // normal operation — capabilities and the id are set together at construction — but is kept as a
    // second belt, same reasoning as the frozen-interface defensive throws elsewhere in this file.
    if (!this.capabilities.has("serp")) this.refuse("serp");
    if (reqs.length === 0) return [];
    if (!this.opts.rankTrackerProjectId) {
      // Fail BEFORE any network call: Ahrefs would reject a project_id-less request anyway
      // (documented as a required param), and refusing locally keeps this a $0, deterministic path.
      throw new Error(
        "ahrefs serp-overview requires a Rank Tracker project id (AHREFS_RANK_TRACKER_PROJECT_ID) " +
          "which is not configured — Ahrefs does not accept a project-less SERP Overview request",
      );
    }
    const out: TaskRef[] = [];
    for (const r of reqs) {
      const body = await this.call<{
        positions?: Array<{ position?: number; url?: string | null; title?: string | null }>;
      }>("/serp-overview/serp-overview", {
        keyword: r.keyword,
        country: r.locale?.split("-")[1]?.toLowerCase() ?? this.opts.country,
        device: r.device === "mobile" ? "mobile" : "desktop",
        project_id: this.opts.rankTrackerProjectId,
      });
      const id = `ahrefs-serp-${this.serpSeq++}`;
      this.pendingSerp.set(id, {
        keyword: r.keyword,
        items: (body.positions ?? [])
          .filter((p) => p.url)
          .map((p) => ({
            position: Number(p.position ?? 0),
            url: String(p.url),
            title: p.title ?? undefined,
          })),
      });
      out.push({ id, keyword: r.keyword });
    }
    return out;
  }

  async fetchSerpResults(refs: TaskRef[]): Promise<SerpResult[]> {
    if (!this.capabilities.has("serp")) this.refuse("serp");
    return refs.map((ref) => {
      const cached = this.pendingSerp.get(ref.id);
      if (!cached) {
        throw new Error(
          `ahrefs serp result for task '${ref.id}' was not found — postSerpTasks() must run first ` +
            "(this driver has no async queue to poll)",
        );
      }
      this.pendingSerp.delete(ref.id);
      return cached;
    });
  }

  // ── Keyword metrics (volume / cpc / difficulty) ───────────────────────────────────────────────────
  async getKeywordMetrics(kws: KeywordQuery[]): Promise<KeywordMetrics[]> {
    if (!this.capabilities.has("volume")) this.refuse("volume");
    if (kws.length === 0) return [];
    const first = kws[0];
    const body = await this.call<{
      keywords?: Array<{ keyword?: string; volume?: number; difficulty?: number }>;
    }>("/keywords-explorer/overview", {
      keywords: kws.map((k) => k.keyword).join(","),
      country: first.locale?.split("-")[1]?.toLowerCase() ?? this.opts.country,
      select: "keyword,volume,traffic_potential,difficulty",
    });
    const byKeyword = new Map((body.keywords ?? []).map((r) => [r.keyword, r]));
    return kws.map((k) => {
      const r = byKeyword.get(k.keyword);
      return {
        keyword: k.keyword,
        volume: numOrUndefined(r?.volume),
        difficulty: numOrUndefined(r?.difficulty),
      };
    });
  }

  // ── Backlinks (Ahrefs's strength — two calls: stats + authority) ─────────────────────────────────
  async getBacklinkSummary(target: string): Promise<BacklinkSummary> {
    if (!this.capabilities.has("backlinks")) this.refuse("backlinks");
    const today = new Date().toISOString().slice(0, 10);
    const [stats, rating] = await Promise.all([
      this.call<{ metrics?: { live?: number; live_refdomains?: number } }>("/site-explorer/backlinks-stats", {
        target,
        date: today,
        mode: "domain",
      }),
      this.call<{ domain_rating?: { domain_rating?: number } }>("/site-explorer/domain-rating", {
        target,
        date: today,
      }),
    ]);
    return {
      target,
      backlinks: numOrUndefined(stats.metrics?.live) ?? 0,
      refDomains: numOrUndefined(stats.metrics?.live_refdomains) ?? 0,
      authorityScore: numOrUndefined(rating.domain_rating?.domain_rating),
    };
  }

  // ── GEO / AI visibility — NOT an advertised capability for Ahrefs ────────────────────────────────
  async getAiVisibility(_q: AiVisibilityQuery): Promise<AiVisibilityResult[]> {
    this.refuse("ai_visibility");
  }

  // ── Cost ──────────────────────────────────────────────────────────────────────────────────────────
  /** Pure + synchronous (the stop-loss and the projection endpoint both call it before dispatch).
   *  'suggestions' and 'ai_visibility' are OpKinds this driver never advertises the capability for —
   *  registry.ts's resolveProvider() refuses those before estimateCostUsd is ever reached, so that
   *  throw is defensive/unreachable in normal operation, matching getAiVisibility() above.
   *
   *  B2 (design addendum §A3.4, upper bounds): 'backlinks' and 'volume' have their row/field counts
   *  known BEFORE dispatch (backlinks is always exactly 2 calls at their published base-minimum;
   *  volume's field count is fixed by the `select=` list this driver itself constructs), so these
   *  are not approximations of an unknown count — they equal the true cost of the exact calls this
   *  driver issues, and this pre-dispatch figure is exactly what evaluateBudget's stop-loss decision
   *  is (and must stay) based on. True-up from response metadata: Ahrefs DOES confirm a per-response
   *  actual-cost header (`x-api-units-cost-total-actual`) — SM-42 wires it, via `call()` above and
   *  `takeActualCostUsd()`, into a POST-dispatch correction of the ledger row dispatch.ts already
   *  wrote from THIS estimate; it never feeds back into this function, which stays pure/synchronous
   *  and pre-dispatch exactly as before.
   *
   *  SM-42 / addendum §A9.5: `items` is clamped to a floor of 1 (`Math.max(1, ...)`), matching the
   *  simulator's own clamp — an `items: 0` op must never price at exactly $0, because a $0 estimate
   *  on the money path can never breach any budget tier (the §4d fail-open class arriving through a
   *  degenerate input instead of a computed error). */
  estimateCostUsd(op: ProviderOp): number {
    if (!(this.opts.costPerUnitUsd > 0)) {
      // Defensive re-assertion of B1 (see the class-level costPerUnitUsd doc comment): should be
      // unreachable via createAhrefsProviderFromConfig(), which refuses to register a driver with a
      // non-positive rate — but a directly-constructed instance must still fail closed here, EVEN
      // for the confirmed-free 'serp' op, because registration is all-or-nothing per vendor.
      throw new Error(
        "ahrefs estimateCostUsd: costPerUnitUsd is not configured (<= 0) — this must never be " +
          "treated as $0; the driver should not have been registered without a positive rate " +
          "(design addendum §A3.3)",
      );
    }
    const items = Math.max(1, op.items ?? 1);
    switch (op.kind) {
      case "backlinks":
        // One "item" = one full call (backlinks-stats + domain-rating, no batching across targets),
        // so both base costs scale WITH items.
        return (AHREFS_RATES.backlinksStatsBaseUnits + AHREFS_RATES.domainRatingBaseUnits) *
          items * this.opts.costPerUnitUsd;
      case "volume":
        // One call can batch many keyword rows: the base cost is charged ONCE per call, and only
        // the per-field*row term scales with items — the opposite shape from 'backlinks' above,
        // and the reason this driver does NOT use one shared "base * items" formula for every kind.
        return (AHREFS_RATES.keywordsOverviewBaseUnits +
          AHREFS_RATES.keywordsOverviewPerFieldUnits * AHREFS_RATES.keywordsOverviewAssumedFields * items) *
          this.opts.costPerUnitUsd;
      case "serp":
        // Confirmed free: 0 units regardless of items (and regardless of costPerUnitUsd, which is
        // still required to be positive per B1 — see the throw above).
        return AHREFS_RATES.serpOverviewUnits * items * this.opts.costPerUnitUsd;
      case "suggestions":
      case "ai_visibility":
        throw new Error(`ahrefs driver does not support op kind '${op.kind}' — it is not an advertised capability`);
    }
  }
}

/** Bootstrap registration (SM-35, mirrors SM-06's DataForSEO pattern; design addendum §A3.3/B1).
 *  Registers ONLY when BOTH an API key AND a positive amortized unit rate are configured — a
 *  configured key with no (or a non-positive) rate registers NOTHING, logged distinctly by main.ts,
 *  because whether the team's Ahrefs plan even includes API v3 is unverified (§A7 OQ-10) and a
 *  guessed rate must never be asserted as fact, while a $0 fallback would silently disarm the
 *  stop-loss (B1). Keyless deployments simply have no Ahrefs driver registered, and every
 *  Ahrefs-routed capability then fails closed at the registry instead of half-working. Independent
 *  of DataForSEO's and Semrush's own credential checks (SM-34/35 AC: "keyless per-vendor disable
 *  proven independently"). */
export function createAhrefsProviderFromConfig(): AhrefsProvider | null {
  const c = config.search.ahrefs;
  if (!c.apiKey) return null;
  const costPerUnitUsd = computeAhrefsCostPerUnitUsd(c.monthlyApiTierPriceUsd, c.monthlyApiTierUnitAllowance);
  if (!(costPerUnitUsd > 0)) return null;
  return new AhrefsProvider({
    apiKey: c.apiKey,
    baseUrl: c.baseUrl,
    timeoutMs: c.timeoutMs,
    country: c.country,
    rankTrackerProjectId: c.rankTrackerProjectId || undefined,
    costPerUnitUsd,
  });
}
