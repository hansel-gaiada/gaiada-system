// SM-05 — the real DataForSEO driver, behind SM-04's SearchDataProvider interface (design §05).
//
// Everything money-related — the scope gate, the budget stop-loss, the cache, the ledger — lives in
// dispatch.ts and is NOT duplicated here. This file's only jobs are: speak DataForSEO's HTTP dialect,
// normalize its envelopes into our shapes, and price an op from the published rate table.
//
// ── The Standard-queue model (foundation §8a lever 2) ─────────────────────────────────────────────
// SERP work is asynchronous and cheap: `task_post` enqueues and returns a task id (~5 min, $0.0006),
// vs the Live endpoint's immediate answer at $0.002 — 3.3x. Standard is the LOCKED default; the
// `live` flag exists so a premium engagement can be flipped deliberately (config.search.dataforseo.queue).
// In Standard mode fetchSerpResults() polls `task_get` with a bounded backoff. Production doesn't rely
// on that poll for freshness: DataForSEO posts a callback to the n8n bridge carrying a TASK ID ONLY,
// and n8n calls back into the module, which then performs THIS authoritative fetch. Inbound webhook
// payloads are never trusted as data (design §02/§03) — the worst a forged callback can do is cause a
// redundant authenticated read.
//
// ── Auth ─────────────────────────────────────────────────────────────────────────────────────────
// HTTP Basic with ONE server-side credential pair against a single shared deposit pool (§8a lever 5) —
// never per-client keys. Credentials come from config (SM-06) and are never logged; only endpoint
// paths and item counts reach the ledger/spans.
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

// ── Published rate table (foundation §8a, DataForSEO 2026) ──────────────────────────────────────────
// SERP:          Standard $0.0006/task · Live $0.002/task
// Labs:          $0.012/task + $0.00012/item
// Keywords Data: $0.0012/task + $0.00012/keyword
// Backlinks:     pay-as-you-go, no $100 minimum ($0.02/summary at the published PAYG rate)
// On-page/crawl: NOT USED — our own crawlers do audit work at $0 API (lever 3).
export const DFS_RATES = {
  serpStandardPerTask: 0.0006,
  serpLivePerTask: 0.002,
  keywordsDataPerTask: 0.0012,
  keywordsDataPerKeyword: 0.00012,
  labsPerTask: 0.012,
  labsPerItem: 0.00012,
  backlinksSummary: 0.02,
} as const;

interface DfsResponse<T> {
  status_code: number;
  status_message?: string;
  tasks?: Array<{
    id: string;
    status_code: number;
    status_message?: string;
    data?: Record<string, unknown>;
    result?: T[] | null;
  }>;
}

/** DataForSEO signals per-task failures INSIDE a 200 response; 20000-range codes are success. */
function assertOk(body: DfsResponse<unknown>, what: string): void {
  if (body.status_code >= 40000) {
    throw new Error(`dataforseo ${what} failed: ${body.status_code} ${body.status_message ?? ""}`.trim());
  }
}

export interface DataForSeoOptions {
  login: string;
  password: string;
  baseUrl: string;
  queue: "standard" | "live";
  timeoutMs: number;
  /** Bounded polling for the Standard queue. Production normally arrives via the postback path, so
   *  these defaults are a safety net, not the primary route. */
  pollAttempts?: number;
  pollIntervalMs?: number;
  /** Injected in tests so a mock server can stand in for api.dataforseo.com. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so the poll backoff doesn't actually sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export class DataForSeoProvider implements SearchDataProvider {
  readonly key = "dataforseo" as const;
  // 'competitors' and 'difficulty' ride the Labs/Keywords-Data pulls rather than being standalone
  // dispatch ops (see OpKind in types.ts) — advertised because the driver can serve them.
  readonly capabilities = new Set<Capability>([
    "serp", "volume", "suggestions", "difficulty", "backlinks", "competitors", "ai_visibility",
  ]);

  private readonly opts: Required<Omit<DataForSeoOptions, "fetchImpl" | "sleepImpl">> &
    Pick<DataForSeoOptions, "fetchImpl" | "sleepImpl">;

  constructor(opts: DataForSeoOptions) {
    this.opts = {
      pollAttempts: 10,
      pollIntervalMs: 3000,
      ...opts,
    };
  }

  private get authHeader(): string {
    return `Basic ${Buffer.from(`${this.opts.login}:${this.opts.password}`).toString("base64")}`;
  }

  private async call<T>(path: string, body?: unknown): Promise<DfsResponse<T>> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await doFetch(`${this.opts.baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Never echo the response body: it can contain the account identifier.
        throw new Error(`dataforseo ${path} returned HTTP ${res.status}`);
      }
      return (await res.json()) as DfsResponse<T>;
    } finally {
      clearTimeout(timer);
    }
  }

  private sleep(ms: number): Promise<void> {
    return this.opts.sleepImpl ? this.opts.sleepImpl(ms) : new Promise((r) => setTimeout(r, ms));
  }

  // ── SERP ──────────────────────────────────────────────────────────────────────────────────────
  async postSerpTasks(reqs: SerpRequest[]): Promise<TaskRef[]> {
    if (reqs.length === 0) return [];
    const path = this.opts.queue === "live"
      ? "/v3/serp/google/organic/live/advanced"
      : "/v3/serp/google/organic/task_post";
    const body = reqs.map((r) => ({
      keyword: r.keyword,
      // DataForSEO defaults to desktop/US when these are absent; we pass them through explicitly so
      // the cache key (which includes them) always describes the coordinates actually requested.
      ...(r.locationCode !== undefined ? { location_code: r.locationCode } : {}),
      ...(r.locale ? { language_code: r.locale.split("-")[0] } : {}),
      ...(r.device ? { device: r.device } : {}),
      ...(r.engine && r.engine !== "google" ? { se_domain: r.engine } : {}),
    }));
    const res = await this.call<unknown>(path, body);
    assertOk(res, "serp task_post");

    return (res.tasks ?? []).map((t, i) => {
      if (t.status_code >= 40000) {
        throw new Error(`dataforseo serp task rejected: ${t.status_code} ${t.status_message ?? ""}`.trim());
      }
      return { id: t.id, keyword: (t.data?.keyword as string) ?? reqs[i]?.keyword ?? "" };
    });
  }

  async fetchSerpResults(refs: TaskRef[]): Promise<SerpResult[]> {
    const out: SerpResult[] = [];
    for (const ref of refs) out.push(await this.fetchOneSerp(ref));
    return out;
  }

  private async fetchOneSerp(ref: TaskRef): Promise<SerpResult> {
    // In Live mode task_post already carried the result; the id round-trips through task_get all the
    // same, so one code path serves both queues.
    for (let attempt = 0; attempt < this.opts.pollAttempts; attempt++) {
      const res = await this.call<{ items?: unknown[] }>(`/v3/serp/google/organic/task_get/advanced/${ref.id}`);
      assertOk(res, "serp task_get");
      const task = res.tasks?.[0];
      // 40602 = "task in queue" — the expected Standard-queue answer until the crawl completes.
      if (task && task.status_code === 40602) {
        await this.sleep(this.opts.pollIntervalMs);
        continue;
      }
      if (task && task.status_code >= 40000) {
        throw new Error(`dataforseo serp task_get failed: ${task.status_code} ${task.status_message ?? ""}`.trim());
      }
      const items = (task?.result?.[0]?.items ?? []) as Array<Record<string, unknown>>;
      return {
        keyword: ref.keyword,
        items: items
          .filter((it) => it.type === "organic")
          .map((it) => ({
            position: Number(it.rank_absolute ?? it.rank_group ?? 0),
            url: String(it.url ?? ""),
            title: it.title === undefined ? undefined : String(it.title),
          })),
        serpFeatures: {
          ai_overview: items.some((it) => it.type === "ai_overview"),
          featured_snippet: items.some((it) => it.type === "featured_snippet"),
          people_also_ask: items.some((it) => it.type === "people_also_ask"),
          local_pack: items.some((it) => it.type === "local_pack"),
        },
      };
    }
    throw new Error(`dataforseo serp task ${ref.id} still queued after ${this.opts.pollAttempts} polls`);
  }

  // ── Keyword metrics (volume / cpc / difficulty / suggestions) ─────────────────────────────────────
  async getKeywordMetrics(kws: KeywordQuery[]): Promise<KeywordMetrics[]> {
    if (kws.length === 0) return [];
    const first = kws[0];
    const res = await this.call<{
      keyword?: string; search_volume?: number; cpc?: number; competition?: number;
      keyword_difficulty?: number; keyword_info?: { search_volume?: number; cpc?: number };
      keyword_properties?: { keyword_difficulty?: number };
    }>("/v3/keywords_data/google_ads/search_volume/live", [{
      keywords: kws.map((k) => k.keyword),
      ...(first.locationCode !== undefined ? { location_code: first.locationCode } : {}),
      ...(first.locale ? { language_code: first.locale.split("-")[0] } : {}),
    }]);
    assertOk(res, "keywords_data search_volume");

    const rows = res.tasks?.[0]?.result ?? [];
    const byKeyword = new Map(rows.map((r) => [String(r.keyword ?? ""), r]));
    return kws.map((k) => {
      const r = byKeyword.get(k.keyword);
      return {
        keyword: k.keyword,
        volume: r?.search_volume ?? r?.keyword_info?.search_volume,
        cpcUsd: r?.cpc ?? r?.keyword_info?.cpc,
        difficulty: r?.keyword_difficulty ?? r?.keyword_properties?.keyword_difficulty,
      };
    });
  }

  // ── Backlinks ─────────────────────────────────────────────────────────────────────────────────────
  async getBacklinkSummary(target: string): Promise<BacklinkSummary> {
    const res = await this.call<{
      target?: string; backlinks?: number; referring_domains?: number; rank?: number;
    }>("/v3/backlinks/summary/live", [{ target, internal_list_limit: 1, backlinks_status_type: "live" }]);
    assertOk(res, "backlinks summary");
    const r = res.tasks?.[0]?.result?.[0];
    return {
      target: r?.target ?? target,
      backlinks: r?.backlinks ?? 0,
      refDomains: r?.referring_domains ?? 0,
      authorityScore: r?.rank,
    };
  }

  // ── GEO / AI visibility ───────────────────────────────────────────────────────────────────────────
  async getAiVisibility(q: AiVisibilityQuery): Promise<AiVisibilityResult[]> {
    // v1 reads AI Overview presence + citations out of the SERP envelope, which is the one
    // AI-answer surface DataForSEO exposes today. Other engines (ChatGPT/Claude/Perplexity) arrive
    // via their own drivers under the same capability — the shape below is engine-agnostic on purpose.
    const res = await this.call<{ items?: Array<Record<string, unknown>> }>(
      "/v3/serp/google/ai_mode/live/advanced",
      [{ keyword: q.query }],
    );
    assertOk(res, "ai visibility");
    const items = (res.tasks?.[0]?.result?.[0]?.items ?? []) as Array<Record<string, unknown>>;
    const references = items.flatMap((it) => (Array.isArray(it.references) ? it.references : [])) as Array<Record<string, unknown>>;
    const text = items.map((it) => String(it.text ?? "")).join(" ");
    const firstRef = references[0];
    return [{
      engine: q.engine ?? "google_ai_overview",
      query: q.query,
      brandMentioned: text.length > 0,
      cited: references.length > 0,
      citedUrl: firstRef ? String(firstRef.url ?? "") : undefined,
      prominence: references.length > 0 ? 1 / references.length : undefined,
    }];
  }

  // ── Cost ──────────────────────────────────────────────────────────────────────────────────────────
  /** Pure + synchronous (the stop-loss and the projection endpoint both call it before dispatch).
   *  Mirrors the §8a published rates above; per-task components are charged once per op because
   *  dispatch's cache-key granularity is one subject per op.
   *
   *  SM-42 (design addendum §A8.7): this driver deliberately does NOT implement the optional
   *  SearchDataProvider.takeActualCostUsd — DataForSEO bills a single published flat per-call USD
   *  price (no per-response actual-cost signal exists to correct against), so no true-up is needed.
   *
   *  SM-42 / addendum §A9.5: `items` is clamped to a floor of 1 (`Math.max(1, ...)`) — the concrete
   *  case that named this alignment: an `items: 0` 'serp' op used to price at exactly $0 here (rate
   *  * 0), which is the §4d fail-open class (a $0 estimate on the money path can never breach any
   *  budget tier) arriving through a degenerate input instead of a computed error. Matches the
   *  simulator's own clamp (simulation.ts). */
  estimateCostUsd(op: ProviderOp): number {
    const items = Math.max(1, op.items ?? 1);
    switch (op.kind) {
      case "serp":
        return (this.opts.queue === "live" ? DFS_RATES.serpLivePerTask : DFS_RATES.serpStandardPerTask) * items;
      case "volume":
        return DFS_RATES.keywordsDataPerTask + DFS_RATES.keywordsDataPerKeyword * items;
      case "suggestions":
        return DFS_RATES.labsPerTask + DFS_RATES.labsPerItem * items;
      case "backlinks":
        return DFS_RATES.backlinksSummary * items;
      case "ai_visibility":
        return (this.opts.queue === "live" ? DFS_RATES.serpLivePerTask : DFS_RATES.serpStandardPerTask) * items;
    }
  }
}

/** Bootstrap registration (SM-06). Returns the driver if credentials are configured, else null —
 *  keyless deployments simply have no paid provider registered, and every paid capability then
 *  fails closed at the registry instead of half-working. */
export function createDataForSeoProviderFromConfig(): DataForSeoProvider | null {
  const c = config.search.dataforseo;
  if (!c.login || !c.password) return null;
  return new DataForSeoProvider({
    login: c.login,
    password: c.password,
    baseUrl: c.baseUrl,
    queue: c.queue,
    timeoutMs: c.timeoutMs,
  });
}
