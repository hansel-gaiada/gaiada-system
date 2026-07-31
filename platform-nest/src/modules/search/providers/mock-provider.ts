// SM-04 — mock/stub SearchDataProvider for tests and keyless dev (design §12 SM-04: "Provide a
// mock/stub provider for tests (SM-05 fills in the real DataForSEO driver behind this interface)").
//
// It advertises the full capability set, returns deterministic shaped payloads, and counts every
// call so tests can PROVE single-flight (identical concurrent queries dispatch exactly once). A
// small optional per-call delay lets a test hold the advisory-lock window open long enough to race
// N callers through it. Cost estimates loosely track DataForSEO Standard unit prices (§8a) — the
// real per-item cost table lands with SM-05; SM-04 only needs a stable, non-zero estimator.
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

// USD per billable item, per op kind (mock rates; SM-05 replaces with the published table).
const RATE_USD: Record<string, number> = {
  serp: 0.0006,
  volume: 0.00012, // the $0.00012 unit price the schema's numeric(12,6) exists to hold
  suggestions: 0.0001,
  backlinks: 0.02,
  ai_visibility: 0.001,
};

export class MockSearchProvider implements SearchDataProvider {
  readonly key = "dataforseo" as const; // masquerades as the platform default so the cascade picks it
  readonly capabilities = new Set<Capability>([
    "serp",
    "volume",
    "suggestions",
    "difficulty",
    "backlinks",
    "competitors",
    "ai_visibility",
  ]);

  /** Every network-shaped call increments this. Single-flight tests assert it advances by exactly 1
   *  across N concurrent identical dispatches. */
  dispatchCount = 0;
  /** Optional artificial latency (ms) to widen the single-flight race window in tests. */
  delayMs = 0;

  private async tick(): Promise<void> {
    this.dispatchCount += 1;
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
  }

  async postSerpTasks(reqs: SerpRequest[]): Promise<TaskRef[]> {
    await this.tick();
    return reqs.map((r, i) => ({ id: `mock-task-${i}-${r.keyword}`, keyword: r.keyword }));
  }

  async fetchSerpResults(refs: TaskRef[]): Promise<SerpResult[]> {
    return refs.map((ref) => ({
      keyword: ref.keyword,
      items: [{ position: 1, url: "https://example.com/", title: `Mock result for ${ref.keyword}` }],
      serpFeatures: { ai_overview: false, featured_snippet: true },
    }));
  }

  /** SM-56 — the collect surface (types.ts's `fetchSerpByTaskId` contract), so the module's shared test
   *  driver can exercise the collect edge.
   *
   *  Two properties are modelled on purpose, and both are the ones a collect test needs to be able to
   *  distinguish. It does NOT call `tick()`, mirroring the real driver: a collect issues no billable
   *  vendor work, so it must not advance the dispatch counter that other tests read as "a network-shaped
   *  paid call happened" — a collect that bumped `dispatchCount` would make the counter mean two
   *  different things and quietly weaken every single-flight assertion that reads it. And `collectCount`
   *  is separate, so a test can assert a collect DID reach the driver without conflating it with a pull. */
  collectCount = 0;

  /** SM-63 — the collect path's OWN artificial latency, and the reason it had to exist.
   *
   *  `delayMs` above lives inside `tick()`, which `fetchSerpByTaskId` deliberately does not call (see the
   *  paragraph above — a collect must never advance `dispatchCount`). The consequence went unnoticed for a
   *  release: a collect-race test setting `mock.delayMs` was setting a field the collect path never reads,
   *  so its "window" was zero-width and the test passed whether or not the task-scoped advisory lock
   *  existed at all. The QA gate proved it by deleting the lock and watching the test stay GREEN.
   *
   *  So the two knobs are separate because the two counters are separate — that is the same reasoning
   *  applied consistently, not a second mechanism. A collect race widens THIS one; nothing here ticks.
   *  A test that sets it should also assert the window was really open (elapsed >= the delay), because a
   *  timing instrument that silently stops working is exactly the defect this field was added to fix. */
  collectDelayMs = 0;

  async fetchSerpByTaskId(ref: TaskRef): Promise<SerpResult> {
    this.collectCount += 1;
    if (this.collectDelayMs > 0) await new Promise((r) => setTimeout(r, this.collectDelayMs));
    return {
      keyword: ref.keyword,
      items: [{ position: 1, url: "https://example.com/", title: `Mock collected result for ${ref.keyword}` }],
      serpFeatures: { ai_overview: false, featured_snippet: true },
    };
  }

  async getKeywordMetrics(kws: KeywordQuery[]): Promise<KeywordMetrics[]> {
    await this.tick();
    return kws.map((k) => ({
      keyword: k.keyword,
      volume: 1200,
      cpcUsd: 0.42,
      difficulty: 37.5,
      suggestions: [`${k.keyword} price`, `${k.keyword} review`],
    }));
  }

  async getBacklinkSummary(target: string): Promise<BacklinkSummary> {
    await this.tick();
    return { target, backlinks: 5321, refDomains: 214, authorityScore: 42 };
  }

  async getAiVisibility(q: AiVisibilityQuery): Promise<AiVisibilityResult[]> {
    await this.tick();
    return [
      { engine: q.engine ?? "chatgpt", query: q.query, brandMentioned: true, cited: true, citedUrl: "https://example.com/", prominence: 0.8 },
    ];
  }

  estimateCostUsd(op: ProviderOp): number {
    const rate = RATE_USD[op.kind] ?? 0.001;
    return rate * (op.items ?? 1);
  }
}
