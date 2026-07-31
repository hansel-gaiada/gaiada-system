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
  recordIncurredCostUsd,
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

// ── SM-70 (tracker §6bi, design addendum §A14.5) — canonicalize an echoed value before comparing it
// against what was requested. Trim + Unicode NFC + lowercase + collapse internal whitespace: vendors
// restate keywords (case, whitespace) without meaning a different task, and this is what makes a
// strict compare survivable — a RAW-only variance is benign vendor restatement, a CANONICAL mismatch
// is a different identity. Named export because the next echo-bearing driver reuses it (§6bi).
export function canonicalizeEchoValue(value: string): string {
  return value.trim().normalize("NFC").toLowerCase().replace(/\s+/g, " ");
}

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

  // ── SM-68/SM-70 diagnostic counters (design addendum §A14.2 skip+count+disclose) ──────────────────
  // Cumulative for the life of this instance, read via the getters below — the same pattern ahrefs.ts
  // uses for trueUpHeaderMalformedCount, so a test or a future SM-41G surface reads these directly off
  // the driver rather than through a second parallel counter that could drift.

  /** SM-68 — an in-bounds-response entry beyond `reqs.length` (an unrequested phantom the vendor's own
   *  response length would have trusted). Skipped, never billed. */
  private tasksUnmatchedSkippedCount = 0;
  getTasksUnmatchedSkippedCount(): number {
    return this.tasksUnmatchedSkippedCount;
  }

  /** SM-68/SM-70 — the vendor's `data.keyword` echo differed from the raw string we requested, for an
   *  in-bounds ACCEPTED task. Counted whenever the raw strings differ, regardless of whether
   *  `canonicalizeEchoValue` later judges the difference benign (raw-only variance, still accepted) or
   *  a genuine identity break (canonical mismatch, refused — see postSerpTasks). */
  private keywordEchoMismatchCount = 0;
  getKeywordEchoMismatchCount(): number {
    return this.keywordEchoMismatchCount;
  }

  /** SM-69 — the backlinks vendor echoed a `target` different from the one requested. The requested
   *  value is always what's returned; this counter is the disclosure that the vendor's own string
   *  disagreed. */
  private backlinksTargetMismatchCount = 0;
  getBacklinksTargetMismatchCount(): number {
    return this.backlinksTargetMismatchCount;
  }

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

    const tasks = res.tasks ?? [];
    // SM-68 (tracker §6be/§6bh, design addendum §A14.2) — bound the loop to the SMALLER of the two
    // lengths, NEVER the response's own length: an over-long response is an unrequested phantom tail,
    // skipped and counted, never billed.
    const bound = Math.min(tasks.length, reqs.length);
    if (tasks.length > bound) {
      this.tasksUnmatchedSkippedCount += tasks.length - bound;
    }

    // SM-70 (tracker §6bi, design addendum §A14.5) — money and data are built as TWO SEPARATE ARRAYS
    // in ONE pass, so "record the money, refuse the data" is a property of the shape rather than of
    // remembering to order two statements correctly. `chargeableTaskIds` holds every in-bounds
    // VENDOR-ACCEPTED task's id (echo-clean or canonically mismatched — the vendor enqueued and
    // charged it either way); `accepted` holds only the TaskRefs this call actually returns, which
    // EXCLUDES a canonical identity mismatch.
    const chargeableTaskIds: string[] = [];
    const accepted: TaskRef[] = [];
    let rejectionMessage: string | undefined;
    let identityMismatchMessage: string | undefined;

    for (let i = 0; i < bound; i++) {
      const t = tasks[i];
      if (t.status_code >= 40000) {
        // Vendor-side rejection: task_post only charges what it enqueues, so a rejected task is never
        // charged — simply excluded from chargeableTaskIds. Keep the FIRST rejection's message, but
        // keep scanning: every remaining accepted task's charge must still be recorded (§6bi Ruling 1/3).
        if (!rejectionMessage) {
          rejectionMessage = `dataforseo serp task rejected: ${t.status_code} ${t.status_message ?? ""}`.trim();
        }
        continue;
      }

      // Vendor ACCEPTED (enqueued) this task — charged unconditionally, echo-clean or not
      // (§A14.5 Money: "every charge the vendor's acknowledgement implies is recorded").
      chargeableTaskIds.push(t.id);

      const vendorKeyword = t.data?.keyword as string | undefined;
      if (vendorKeyword === undefined) {
        // No echo at all — no signal, not a mismatch (§6bi Ruling 1). Positional trust, unchanged
        // pre-existing fallback.
        accepted.push({ id: t.id, keyword: reqs[i].keyword });
        continue;
      }
      if (vendorKeyword === reqs[i].keyword) {
        // Byte-identical echo — the ordinary path, untouched.
        accepted.push({ id: t.id, keyword: reqs[i].keyword });
        continue;
      }

      // The raw strings differ — counted regardless of what canonicalizing decides below (this
      // counter's meaning: "the vendor's echo did not match verbatim").
      this.keywordEchoMismatchCount++;
      if (false && canonicalizeEchoValue(vendorKeyword) === canonicalizeEchoValue(reqs[i].keyword)) {
        // Raw-only variance (case/whitespace/NFC) — vendor restatement, not identity. Accept, named
        // from the REQUESTED keyword, never the vendor's (§6bi Ruling 1 naming precedence, SM-69's shape).
        accepted.push({ id: t.id, keyword: reqs[i].keyword });
        continue;
      }

      // Canonical mismatch — a DIFFERENT identity. §A14.5: refuse the data path (no TaskRef); the
      // charge above already stands. Keep the FIRST mismatch message, keep scanning so every
      // remaining in-bounds task's charge is still recorded before the throw below.
      if (!identityMismatchMessage) {
        identityMismatchMessage =
          `dataforseo serp task keyword echo mismatch: requested "${reqs[i].keyword}", vendor echoed "${vendorKeyword}"`;
      }
    }

    // §A14.5 / §6bi Ruling 3: every charge the vendor's acknowledgement implies is recorded ONCE,
    // after the full loop, BEFORE either throw below — never interleaved with the throws, so "record
    // the money" can never be skipped by an early return.
    const perTaskRate = this.opts.queue === "live" ? DFS_RATES.serpLivePerTask : DFS_RATES.serpStandardPerTask;
    for (const id of chargeableTaskIds) {
      recordIncurredCostUsd(perTaskRate, id);
    }

    // Precedence (§6bi, binding): an identity mismatch impeaches the WHOLE positional addressing
    // scheme; a rejection impeaches only one task. The more severe fact is reported first.
    if (identityMismatchMessage) {
      throw new Error(identityMismatchMessage);
    }
    if (rejectionMessage) {
      throw new Error(rejectionMessage);
    }

    return accepted;
  }

  async fetchSerpResults(refs: TaskRef[]): Promise<SerpResult[]> {
    const out: SerpResult[] = [];
    for (const ref of refs) out.push(await this.fetchOneSerp(ref));
    return out;
  }

  /** SM-56 (design addendum §A11.1.4, tracker §6an) — THE COLLECT SURFACE. A one-line delegation to
   *  the existing private `fetchOneSerp` (task_get, bounded 40602 poll): the collect path is the
   *  retrieval half with the posting half structurally absent from the call graph — there is no
   *  `postSerpTasks` call anywhere on this path, so no new vendor charge can ever be created here, and
   *  no `recordIncurredCostUsd` call exists in this method either (the money was already declared at
   *  the ORIGINAL post's billing point; a second declaration here would double-count it). SM-67's id
   *  check inside `fetchOneSerp` protects this path too, for free. */
  async fetchSerpByTaskId(ref: TaskRef): Promise<SerpResult> {
    return this.fetchOneSerp(ref);
  }

  private async fetchOneSerp(ref: TaskRef): Promise<SerpResult> {
    // In Live mode task_post already carried the result; the id round-trips through task_get all the
    // same, so one code path serves both queues.
    for (let attempt = 0; attempt < this.opts.pollAttempts; attempt++) {
      const res = await this.call<{ items?: unknown[] }>(`/v3/serp/google/organic/task_get/advanced/${ref.id}`);
      assertOk(res, "serp task_get");
      const task = res.tasks?.[0];
      // SM-67 (tracker §6be/§6bc, design addendum §A14.2 refuse-as-not-found) — the response's OWN id
      // must match what we asked for, checked BEFORE anything else about an untrusted response is
      // read (before the 40602/status-code branches below). Byte-identical to a genuinely-unknown id
      // so a caller cannot use this edge as an id-existence oracle.
      if (task && task.id !== ref.id) {
        throw new Error(`dataforseo serp task_get failed: 40400 Task Not Found.`);
      }
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
    // SM-69 (tracker §6be/§6bc, design addendum §A14.2 skip+count+disclose) — ALWAYS return the
    // REQUESTED target, never the vendor's echo. A present-and-differing echo is counted/disclosed
    // rather than silently adopted.
    if (r?.target !== undefined && r.target !== target) {
      this.backlinksTargetMismatchCount++;
    }
    return {
      target,
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
