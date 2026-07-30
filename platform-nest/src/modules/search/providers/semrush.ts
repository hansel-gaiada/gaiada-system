// SM-34 — the Semrush Analytics API v3 driver, behind SM-04's SearchDataProvider interface (design
// §05, tracker §6 SM-34). Same discipline as dataforseo.ts: everything money-related (scope gate,
// budget stop-loss, cache, ledger) lives in dispatch.ts and is NOT duplicated here. This file's only
// jobs are: speak Semrush's HTTP dialect, normalize its envelope into our shapes, and price an op.
//
// ── Endpoints + envelope (developer.semrush.com/api/v3/analytics, verified via live doc fetch
//    2026-07-29) ─────────────────────────────────────────────────────────────────────────────────
// Base URL: https://api.semrush.com — the classic Analytics API. Auth is a `key` QUERY PARAM, never
// a header and never Basic auth (unlike DataForSEO) — so the auth secret rides in the URL, which is
// exactly why call() below still never echoes the URL or body on error.
//
// Response format is NOT JSON. Confirmed from Semrush's own documented example
// (developer.semrush.com/api/v3/analytics/basic-docs): a request returns semicolon-delimited plain
// text with a header row, e.g.
//   "Database;Domain;Rank;Organic Keywords\r\nus;apple.com;17;16464474"
// A failed lookup still comes back **HTTP 200** with a body of `ERROR <code> :: <message>` (e.g.
// "ERROR 50 :: NOTHING FOUND", "ERROR 132 :: API UNITS BALANCE IS ZERO") — the same "200 carrying an
// error" shape DataForSEO has, just spelled differently, so this driver needs its own envelope-level
// failure check (assertNotErrorLine below), exactly like dataforseo.ts's assertOk().
//
// Report types used here, each independently priced per the §8a-style rate table (confirmed
// per-line costs via developer.semrush.com's keyword-reports / domain-reports pages):
//   phrase_these           -> volume (+cpc)         10 units/line  (batch keyword overview)
//   phrase_kdi              -> difficulty            50 units/line  (rides the 'volume' op — no
//                                                                     standalone OpKind, same pattern
//                                                                     as DataForSEO's difficulty)
//   phrase_organic          -> serp                  10 units/line  (organic rankings for ONE keyword;
//                                                                     Semrush has no async task queue,
//                                                                     see postSerpTasks below)
//   backlinks_overview      -> backlinks              rate PROXIED — see SEMRUSH_RATES comment
//   domain_organic_organic  -> competitors            40 units/line  (capability only, no OpKind)
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
} from "./types";

// ── Unit -> USD derivation v2 (design addendum §A3/§A7 OQ-9 — THE part the review focuses on) ───────
// Semrush bills API UNITS against a subscription (units bought in blocks of 2,000,000 / 5,000,000 /
// 10,000,000 / 20,000,000 per developer.semrush.com/api/get-started/api-units-balance), NOT a flat
// per-call USD price like DataForSEO. `estimateCostUsd` must still return USD and stay pure +
// synchronous, so a units->USD ratio is required.
//
// RULING (addendum §A3.1/§A3.3, binding — supersedes this file's earlier draft): the ratio is
// `monthlyPlanPriceUsd ÷ monthlyUnitAllowance`, and **both inputs are OWNER-SUPPLIED, UNVERIFIED
// facts** (§A7 OQ-9: the team's actual Semrush plan tier, its monthly API-unit allowance, and its
// unit price list — all three require the owner to read the Semrush account console; the Analytics
// API is historically Business-tier-gated with lower tiers having no API access at all, so even
// tier eligibility is unconfirmed from this desk). This file does NOT invent a number and assert it
// as vendor truth. Both inputs default to 0 in config.ts, which makes the derived rate 0 —
// deliberately, per the fail-closed rule below.
//
// **B1 (mid-flight amendment, non-negotiable): an unset OR non-positive costPerUnitUsd means the
// driver must NOT be registered — never a $0 rate.** Pricing a prepaid vendor's ops at $0 would
// silently disarm every budget tier for that vendor (the tracker §4d fail-open class, arriving
// through config instead of code — a wrong-direction "estimate" is worse than no driver at all).
// createSemrushProviderFromConfig() enforces this at registration; estimateCostUsd() ALSO throws
// defensively if it is ever called on an instance holding a non-positive rate, so the fail-closed
// property holds even if some future caller constructs SemrushProvider directly, bypassing the
// factory.
//
// Deliberately EXCLUDED from the ratio, once the owner supplies real figures: the mandatory
// Advanced-plan seat (~$549/mo, reportedly required to unlock API access at all). Per the owner
// directive ("the team already uses Semrush + Ahrefs"), that seat is a fixed cost of maintaining
// vendor access independent of this integration's consumption — the stop-loss should track the part
// of the bill that actually scales with usage, not a sunk seat cost every other Semrush user also
// pays. If that policy is wrong, the seat price should be added into `monthlyPlanPriceUsd` in config
// — a one-line change, not a code change.
export function computeSemrushCostPerUnitUsd(monthlyPlanPriceUsd: number, monthlyUnitAllowance: number): number {
  if (!(monthlyPlanPriceUsd > 0) || !(monthlyUnitAllowance > 0)) return 0;
  return monthlyPlanPriceUsd / monthlyUnitAllowance;
}

// ── Published/observed per-report unit costs (Semrush "API units", NOT USD — this table is public,
//    vendor-documented report-cost information, independent of any specific plan or the unverified
//    $/unit ratio above) ────────────────────────────────────────────────────────────────────────────
export const SEMRUSH_RATES = {
  // phrase_these (batch Keyword Overview): confirmed 10 units/line.
  keywordOverviewUnitsPerLine: 10,
  // phrase_kdi (Keyword Difficulty): confirmed 50 units/line. Rides the 'volume' OpKind (see
  // OP_CAPABILITY in types.ts — difficulty has no standalone dispatch kind).
  keywordDifficultyUnitsPerLine: 50,
  // phrase_organic (Organic Results for one keyword): confirmed 10 units/line.
  serpUnitsPerLine: 10,
  // backlinks_overview: NOT independently confirmed in this research pass (Semrush's backlinks-
  // reports doc page 404'd on both direct fetch attempts). PROXIED from backlinks_refdomains, which
  // IS confirmed at 40 units/line and is the closest same-tier "backlinks" report — both return a
  // referring-domains-shaped answer for one target. Correct this once backlinks_overview's real cost
  // is confirmed from Semrush's own docs or an actual invoice line.
  backlinksUnitsPerLine: 40,
  // domain_organic_organic (Competitors in Organic Search): confirmed 40 units/line. Capability-only
  // (no standalone OpKind), listed here for completeness/documentation, not consumed by
  // estimateCostUsd below.
  competitorsUnitsPerLine: 40,
} as const;

interface SemrushRow {
  [column: string]: string;
}

/** Semrush signals a failed lookup with HTTP 200 and a body of `ERROR <code> :: <message>` — the
 *  same "200 carrying an error" shape DataForSEO has under a different spelling. Checked on the
 *  FIRST line only; a genuine data row never starts with the literal token "ERROR". */
function assertNotErrorLine(firstLine: string, what: string): void {
  const m = /^ERROR\s+(\d+)\s*::\s*(.*)$/.exec(firstLine.trim());
  if (m) {
    throw new Error(`semrush ${what} failed: ERROR ${m[1]} ${m[2]}`.trim());
  }
}

/** Parses Semrush's semicolon-delimited plain-text envelope into row objects keyed by the header
 *  Semrush itself returned (not by our requested export_columns — the two agree in practice, but
 *  keying off the actual header is what makes a column-order surprise a no-op instead of silent
 *  corruption). Blank/trailing lines are dropped. */
function parseDelimited(text: string): SemrushRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split(";");
  return lines.slice(1).map((line) => {
    const cells = line.split(";");
    const row: SemrushRow = {};
    header.forEach((h, i) => {
      row[h] = cells[i] ?? "";
    });
    return row;
  });
}

function numOrUndefined(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

export interface SemrushOptions {
  apiKey: string;
  baseUrl: string;
  /** Semrush's regional database code, e.g. "us", "uk", "id". */
  database: string;
  timeoutMs: number;
  /** The amortized USD-per-unit rate (design addendum §A3.1), already computed by
   *  computeSemrushCostPerUnitUsd() from owner-supplied, unverified plan facts. The FACTORY
   *  (createSemrushProviderFromConfig) refuses to register a driver when this is <= 0; this class
   *  itself stays permissive at construction (tests build instances with an arbitrary positive test
   *  rate) but estimateCostUsd() re-asserts positivity defensively — see the B1 note above. */
  costPerUnitUsd: number;
  /** Injected in tests so a mock server can stand in for api.semrush.com. */
  fetchImpl?: typeof fetch;
}

export class SemrushProvider implements SearchDataProvider {
  readonly key = "semrush" as const;
  // Design §6 SM-34: Semrush covers volume/difficulty/backlinks/competitors/serp. NO suggestions,
  // NO ai_visibility — Semrush has no keyword-suggestions product and no AI-visibility product in
  // the Analytics API. Those two OpKinds must never resolve to this driver (registry.ts's capability
  // gate is what actually enforces that; the methods below still refuse defensively, see refuse()).
  readonly capabilities = new Set<Capability>(["volume", "difficulty", "backlinks", "competitors", "serp"]);

  private readonly opts: SemrushOptions;
  /** Semrush's Organic Results report is SYNCHRONOUS — there is no task-queue model like
   *  DataForSEO's Standard queue. To conform to SM-04's async postSerpTasks/fetchSerpResults shape,
   *  the HTTP call happens inside postSerpTasks and the parsed result is cached here by TaskRef id;
   *  fetchSerpResults is then a pure lookup with no second network round trip. Entries are removed
   *  once read so a long-running process can't accumulate unbounded state from unresolved refs. */
  private readonly pendingSerp = new Map<string, SerpResult>();
  private serpSeq = 0;

  constructor(opts: SemrushOptions) {
    this.opts = opts;
  }

  private refuse(cap: Capability): never {
    throw new Error(`semrush driver does not offer '${cap}' — it is not an advertised capability (SM-34)`);
  }

  private async call(type: string, params: Record<string, string | number | undefined>): Promise<string> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const qs = new URLSearchParams({ key: this.opts.apiKey, type, database: this.opts.database });
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") qs.set(k, String(v));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await doFetch(`${this.opts.baseUrl}/?${qs.toString()}`, { signal: controller.signal });
      if (!res.ok) {
        // Never echo the response body: the `key` param already puts the account credential in the
        // URL we just called, and a Semrush error body can carry account-identifying detail too.
        throw new Error(`semrush ${type} returned HTTP ${res.status}`);
      }
      const text = await res.text();
      const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
      assertNotErrorLine(firstLine, type);
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── SERP (synchronous under the hood — see pendingSerp doc comment) ──────────────────────────────
  async postSerpTasks(reqs: SerpRequest[]): Promise<TaskRef[]> {
    if (!this.capabilities.has("serp")) this.refuse("serp");
    if (reqs.length === 0) return [];
    const out: TaskRef[] = [];
    for (const r of reqs) {
      // phrase_organic: organic rankings for ONE keyword. Columns Po (position), Ur (ranking URL),
      // Dn (domain) — this report does not carry a page title, so SerpResult.title stays undefined
      // (matching the interface's optional field, same as DataForSEO's non-organic filter leaving it
      // out). `database` doubles as the locale/geo selector Semrush's classic API uses; there's no
      // separate device dimension on this report, unlike DataForSEO's mobile/desktop split.
      const text = await this.call("phrase_organic", {
        phrase: r.keyword,
        export_columns: "Po,Ur,Dn",
        ...(r.locationCode !== undefined ? {} : {}),
      });
      const rows = parseDelimited(text);
      const id = `semrush-serp-${this.serpSeq++}`;
      this.pendingSerp.set(id, {
        keyword: r.keyword,
        items: rows
          .filter((row) => row.Po !== undefined && row.Po !== "")
          .map((row) => ({
            position: Number(row.Po),
            url: row.Ur ?? "",
            title: undefined,
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
          `semrush serp result for task '${ref.id}' was not found — postSerpTasks() must run first ` +
            "(this driver has no async queue to poll, unlike DataForSEO's Standard queue)",
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
    // phrase_these: batch Keyword Overview, up to 100 phrases separated by ';'. Columns
    // Ph (keyword), Nq (search volume), Cp (CPC), Kd (keyword difficulty).
    const text = await this.call("phrase_these", {
      phrase: kws.map((k) => k.keyword).join(";"),
      export_columns: "Ph,Nq,Cp,Kd",
    });
    const rows = parseDelimited(text);
    const byKeyword = new Map(rows.map((r) => [r.Ph, r]));
    return kws.map((k) => {
      const r = byKeyword.get(k.keyword);
      return {
        keyword: k.keyword,
        volume: numOrUndefined(r?.Nq),
        cpcUsd: numOrUndefined(r?.Cp),
        difficulty: numOrUndefined(r?.Kd),
      };
    });
  }

  // ── Backlinks ─────────────────────────────────────────────────────────────────────────────────────
  async getBacklinkSummary(target: string): Promise<BacklinkSummary> {
    if (!this.capabilities.has("backlinks")) this.refuse("backlinks");
    // backlinks_overview: ascore (authority), total (backlinks), domains_num (referring domains).
    const text = await this.call("backlinks_overview", {
      target,
      target_type: "root_domain",
      export_columns: "ascore,total,domains_num",
    });
    const [row] = parseDelimited(text);
    return {
      target,
      backlinks: numOrUndefined(row?.total) ?? 0,
      refDomains: numOrUndefined(row?.domains_num) ?? 0,
      authorityScore: numOrUndefined(row?.ascore),
    };
  }

  // ── GEO / AI visibility — NOT an advertised capability for Semrush ────────────────────────────────
  async getAiVisibility(_q: AiVisibilityQuery): Promise<AiVisibilityResult[]> {
    this.refuse("ai_visibility");
  }

  // ── Cost ──────────────────────────────────────────────────────────────────────────────────────────
  /** Pure + synchronous (the stop-loss and the projection endpoint both call it before dispatch).
   *  'suggestions' and 'ai_visibility' are OpKinds this driver never advertises the capability for —
   *  registry.ts's resolveProvider() refuses those before estimateCostUsd is ever reached, so that
   *  throw is defensive/unreachable in normal operation, matching getAiVisibility() above.
   *
   *  B2 (design addendum §A3.4, upper bounds): every op here has its row/line count known BEFORE
   *  dispatch (the caller-declared `op.items`; Semrush's per-report unit costs are flat per-line, not
   *  a variable per-selected-field charge), so these estimates are not upper-bound approximations of
   *  an unknown row count — they equal the true cost for the exact call this driver issues. True-up
   *  from response metadata: NOT VERIFIED for Semrush's classic Analytics API in this research pass —
   *  only a cumulative account-balance endpoint and a request-log UI were found, not a per-response
   *  header/field carrying that single call's actual unit cost (contrast with Ahrefs's confirmed
   *  `x-api-units-cost-total-actual` header, see ahrefs.ts). Per §A3.4's own escape hatch, the
   *  estimate stands as FINAL here — no true-up is implemented, and this is a stated limitation, not
   *  a silent gap. SM-42 (design addendum §A8.7): this driver deliberately does NOT implement the
   *  optional SearchDataProvider.takeActualCostUsd — there is no confirmed per-response actual-cost
   *  signal to wire it to here, so it correctly stays absent rather than fabricated.
   *
   *  SM-42 / addendum §A9.5: `items` is clamped to a floor of 1 (`Math.max(1, ...)`), matching the
   *  simulator's own clamp — an `items: 0` op must never price at exactly $0 (the §4d fail-open
   *  class arriving through a degenerate input rather than a computed error). */
  estimateCostUsd(op: ProviderOp): number {
    if (!(this.opts.costPerUnitUsd > 0)) {
      // Defensive re-assertion of B1: should be unreachable via createSemrushProviderFromConfig(),
      // which refuses to register a driver with a non-positive rate — but a directly-constructed
      // instance (a future caller bypassing the factory) must still fail closed here rather than
      // silently pricing every op at $0.
      throw new Error(
        "semrush estimateCostUsd: costPerUnitUsd is not configured (<= 0) — this must never be " +
          "treated as $0; the driver should not have been registered without a positive rate " +
          "(design addendum §A3.3)",
      );
    }
    const items = Math.max(1, op.items ?? 1);
    switch (op.kind) {
      case "volume":
        // difficulty rides the volume op (no standalone OpKind) — both report costs are charged
        // together so a volume pull's price reflects the full metrics set this driver actually
        // returns (Nq+Cp+Kd in one logical fetch, even though the current implementation issues one
        // batched HTTP call rather than DataForSEO-style task+per-item billing).
        return (SEMRUSH_RATES.keywordOverviewUnitsPerLine + SEMRUSH_RATES.keywordDifficultyUnitsPerLine) *
          items * this.opts.costPerUnitUsd;
      case "serp":
        return SEMRUSH_RATES.serpUnitsPerLine * items * this.opts.costPerUnitUsd;
      case "backlinks":
        return SEMRUSH_RATES.backlinksUnitsPerLine * items * this.opts.costPerUnitUsd;
      case "suggestions":
      case "ai_visibility":
        throw new Error(`semrush driver does not support op kind '${op.kind}' — it is not an advertised capability`);
    }
  }
}

/** Bootstrap registration (SM-34, mirrors SM-06's DataForSEO pattern; design addendum §A3.3/B1).
 *  Registers ONLY when BOTH an API key AND a positive amortized unit rate are configured — a
 *  configured key with no (or a non-positive) rate registers NOTHING, logged distinctly by main.ts,
 *  because the team's actual Semrush plan/allowance is unverified (§A7 OQ-9) and a guessed rate must
 *  never be asserted as fact, while a $0 fallback would silently disarm the stop-loss (B1). Keyless
 *  deployments simply have no Semrush driver registered, and every Semrush-routed capability then
 *  fails closed at the registry instead of half-working. Independent of DataForSEO's and Ahrefs's own
 *  credential checks (SM-34 AC: "keyless per-vendor disable proven independently"). */
export function createSemrushProviderFromConfig(): SemrushProvider | null {
  const c = config.search.semrush;
  if (!c.apiKey) return null;
  const costPerUnitUsd = computeSemrushCostPerUnitUsd(c.monthlyPlanPriceUsd, c.monthlyUnitAllowance);
  if (!(costPerUnitUsd > 0)) return null;
  return new SemrushProvider({
    apiKey: c.apiKey,
    baseUrl: c.baseUrl,
    database: c.database,
    timeoutMs: c.timeoutMs,
    costPerUnitUsd,
  });
}
