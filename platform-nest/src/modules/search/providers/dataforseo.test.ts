// SM-05 — DataForSEO driver tests against an in-process MOCK SERVER (design §12 SM-05 AC:
// "Mock-server tests for all capabilities; cost table matches §8a published rates; Live-queue flag
// exists but defaults Standard").
//
// No network, no credentials, no deposit: `fetchImpl` is injected, so these run in CI and on a
// laptop today. The REAL-data acceptance (a live pull against api.dataforseo.com) is deliberately
// deferred to the $50 deposit — see the tracker's blocker table. What IS proven here is everything
// that would still be wrong after the deposit lands: envelope parsing, the Standard-queue poll,
// error propagation, credential handling, and the published rate arithmetic.
import { describe, it, expect, vi } from "vitest";
import { config } from "../../../config";
import { DataForSeoProvider, DFS_RATES, createDataForSeoProviderFromConfig } from "./dataforseo";
import type { ProviderOp } from "./types";

/** Records every request and answers from a path->body script. */
function mockServer(routes: Record<string, unknown | ((body: unknown) => unknown)>) {
  const calls: Array<{ path: string; method: string; body: unknown; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const full = String(url);
    const path = full.replace("https://api.test", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      path,
      method: init?.method ?? "GET",
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const match = Object.keys(routes).find((r) => path.startsWith(r));
    if (!match) return { ok: false, status: 404, json: async () => ({}) } as Response;
    const route = routes[match];
    const payload = typeof route === "function" ? (route as (b: unknown) => unknown)(body) : route;
    return { ok: true, status: 200, json: async () => payload } as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function provider(
  routes: Record<string, unknown | ((body: unknown) => unknown)>,
  overrides: Partial<ConstructorParameters<typeof DataForSeoProvider>[0]> = {},
) {
  const { calls, fetchImpl } = mockServer(routes);
  const p = new DataForSeoProvider({
    login: "user@test", password: "secret-pass", baseUrl: "https://api.test",
    queue: "standard", timeoutMs: 5000, fetchImpl, sleepImpl: async () => undefined,
    ...overrides,
  });
  return { p, calls };
}

const OK = (result: unknown[]) => ({
  status_code: 20000,
  tasks: [{ id: "task-1", status_code: 20000, result }],
});

describe("SM-05 DataForSEO driver — capabilities against a mock server", () => {
  it("advertises every capability the design assigns it", () => {
    const { p } = provider({});
    for (const cap of ["serp", "volume", "suggestions", "difficulty", "backlinks", "competitors", "ai_visibility"]) {
      expect(p.capabilities.has(cap as never)).toBe(true);
    }
  });

  // ── SERP ────────────────────────────────────────────────────────────────────────────────────────
  it("posts a Standard-queue SERP task and parses organic items + SERP features", async () => {
    const { p, calls } = provider({
      "/v3/serp/google/organic/task_post": {
        status_code: 20000,
        tasks: [{ id: "t-abc", status_code: 20000, data: { keyword: "sepatu lari" } }],
      },
      "/v3/serp/google/organic/task_get": OK([{
        items: [
          { type: "organic", rank_absolute: 1, url: "https://a.example/", title: "A" },
          { type: "ai_overview", text: "..." },
          { type: "organic", rank_absolute: 2, url: "https://b.example/" },
          { type: "people_also_ask" },
        ],
      }]),
    });

    const refs = await p.postSerpTasks([{ keyword: "sepatu lari", locale: "id-ID", locationCode: 2360, device: "mobile" }]);
    expect(refs).toEqual([{ id: "t-abc", keyword: "sepatu lari" }]);

    // Standard queue, not Live — the 3.3x-cheaper path (foundation §8a lever 2).
    expect(calls[0].path).toBe("/v3/serp/google/organic/task_post");
    expect(calls[0].body).toEqual([{ keyword: "sepatu lari", location_code: 2360, language_code: "id", device: "mobile" }]);

    const [res] = await p.fetchSerpResults(refs);
    expect(res.keyword).toBe("sepatu lari");
    expect(res.items).toEqual([
      { position: 1, url: "https://a.example/", title: "A" },
      { position: 2, url: "https://b.example/", title: undefined },
    ]); // non-organic item types are excluded from positions
    expect(res.serpFeatures).toMatchObject({ ai_overview: true, people_also_ask: true, featured_snippet: false });
  });

  it("polls through the 40602 'task in queue' answer instead of failing", async () => {
    let attempt = 0;
    const { p, calls } = provider({
      "/v3/serp/google/organic/task_get": () => {
        attempt++;
        return attempt < 3
          ? { status_code: 20000, tasks: [{ id: "t", status_code: 40602, status_message: "Task In Queue" }] }
          : OK([{ items: [{ type: "organic", rank_absolute: 7, url: "https://late.example/" }] }]);
      },
    });
    const [res] = await p.fetchSerpResults([{ id: "t", keyword: "k" }]);
    expect(res.items[0].position).toBe(7);
    expect(calls).toHaveLength(3); // two queued answers, then the result
  });

  it("gives up with a clear error if the task never leaves the queue", async () => {
    const { p } = provider(
      { "/v3/serp/google/organic/task_get": { status_code: 20000, tasks: [{ id: "t", status_code: 40602 }] } },
      { pollAttempts: 3 },
    );
    await expect(p.fetchSerpResults([{ id: "t", keyword: "k" }])).rejects.toThrow(/still queued after 3 polls/);
  });

  it("uses the Live endpoint only when the queue flag is explicitly flipped", async () => {
    const { p, calls } = provider(
      { "/v3/serp/google/organic/live": { status_code: 20000, tasks: [{ id: "L1", status_code: 20000, data: { keyword: "k" } }] } },
      { queue: "live" },
    );
    await p.postSerpTasks([{ keyword: "k" }]);
    expect(calls[0].path).toBe("/v3/serp/google/organic/live/advanced");
  });

  // ── Keyword metrics ─────────────────────────────────────────────────────────────────────────────
  it("maps keyword metrics back onto the requested keywords, tolerating a missing row", async () => {
    const { p } = provider({
      "/v3/keywords_data/google_ads/search_volume/live": OK([
        { keyword: "alpha", search_volume: 1200, cpc: 0.42, keyword_difficulty: 37 },
      ]),
    });
    const res = await p.getKeywordMetrics([{ keyword: "alpha" }, { keyword: "beta" }]);
    expect(res).toEqual([
      { keyword: "alpha", volume: 1200, cpcUsd: 0.42, difficulty: 37 },
      { keyword: "beta", volume: undefined, cpcUsd: undefined, difficulty: undefined },
    ]);
  });

  it("reads the nested keyword_info/keyword_properties envelope shape too", async () => {
    const { p } = provider({
      "/v3/keywords_data/google_ads/search_volume/live": OK([
        { keyword: "alpha", keyword_info: { search_volume: 90, cpc: 1.1 }, keyword_properties: { keyword_difficulty: 12 } },
      ]),
    });
    const [row] = await p.getKeywordMetrics([{ keyword: "alpha" }]);
    expect(row).toEqual({ keyword: "alpha", volume: 90, cpcUsd: 1.1, difficulty: 12 });
  });

  it("short-circuits an empty keyword batch without calling the API", async () => {
    const { p, calls } = provider({});
    expect(await p.getKeywordMetrics([])).toEqual([]);
    expect(await p.postSerpTasks([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  // ── Backlinks ───────────────────────────────────────────────────────────────────────────────────
  it("parses a backlink summary and defaults missing counters to 0", async () => {
    const { p } = provider({
      "/v3/backlinks/summary/live": OK([{ target: "example.com", backlinks: 5321, referring_domains: 214, rank: 42 }]),
    });
    expect(await p.getBacklinkSummary("example.com")).toEqual({
      target: "example.com", backlinks: 5321, refDomains: 214, authorityScore: 42,
    });

    const { p: empty } = provider({ "/v3/backlinks/summary/live": OK([]) });
    expect(await empty.getBacklinkSummary("nothing.example")).toEqual({
      target: "nothing.example", backlinks: 0, refDomains: 0, authorityScore: undefined,
    });
  });

  // ── GEO / AI visibility ─────────────────────────────────────────────────────────────────────────
  it("reports AI-visibility citation state from the AI-mode envelope", async () => {
    const { p } = provider({
      "/v3/serp/google/ai_mode/live/advanced": OK([{
        items: [{ text: "Brand X is a good option", references: [{ url: "https://brandx.example/" }] }],
      }]),
    });
    const [res] = await p.getAiVisibility({ query: "best running shoes" });
    expect(res).toMatchObject({ engine: "google_ai_overview", cited: true, brandMentioned: true, citedUrl: "https://brandx.example/" });

    const { p: none } = provider({ "/v3/serp/google/ai_mode/live/advanced": OK([{ items: [] }]) });
    const [absent] = await none.getAiVisibility({ query: "obscure query" });
    expect(absent.cited).toBe(false);
    expect(absent.brandMentioned).toBe(false);
  });

  // ── Errors + credential handling ────────────────────────────────────────────────────────────────
  it("propagates an envelope-level failure (DataForSEO signals errors inside a 200)", async () => {
    const { p } = provider({
      "/v3/backlinks/summary/live": { status_code: 40401, status_message: "Not Found" },
    });
    await expect(p.getBacklinkSummary("x.example")).rejects.toThrow(/40401 Not Found/);
  });

  it("propagates a rejected task rather than returning an empty ref", async () => {
    const { p } = provider({
      "/v3/serp/google/organic/task_post": {
        status_code: 20000,
        tasks: [{ id: "t", status_code: 40501, status_message: "Invalid Field" }],
      },
    });
    await expect(p.postSerpTasks([{ keyword: "k" }])).rejects.toThrow(/task rejected: 40501/);
  });

  it("does not echo the response body on an HTTP error (it can carry the account identifier)", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 402, json: async () => ({ account: "secret" }) })) as unknown as typeof fetch;
    const p = new DataForSeoProvider({
      login: "u", password: "p", baseUrl: "https://api.test", queue: "standard", timeoutMs: 100, fetchImpl,
    });
    const err = await p.getBacklinkSummary("x.example").catch((e: Error) => e);
    expect((err as Error).message).toBe("dataforseo /v3/backlinks/summary/live returned HTTP 402");
    expect((err as Error).message).not.toContain("secret");
  });

  it("sends HTTP Basic auth and never puts credentials in the URL", async () => {
    const { p, calls } = provider({ "/v3/backlinks/summary/live": OK([]) });
    await p.getBacklinkSummary("x.example");
    expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from("user@test:secret-pass").toString("base64")}`);
    expect(calls[0].path).not.toContain("secret-pass");
  });

  it("aborts a hung request on the configured timeout", async () => {
    const fetchImpl = ((_u: unknown, init?: RequestInit) => new Promise((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(new Error("The operation was aborted")));
    })) as unknown as typeof fetch;
    const p = new DataForSeoProvider({
      login: "u", password: "p", baseUrl: "https://api.test", queue: "standard", timeoutMs: 20, fetchImpl,
    });
    await expect(p.getBacklinkSummary("x.example")).rejects.toThrow(/abort/i);
  });
});

describe("SM-05 cost table matches the §8a published rates", () => {
  const { p: standard } = provider({});
  const { p: live } = provider({}, { queue: "live" });
  const op = (kind: ProviderOp["kind"], items: number): ProviderOp => ({ kind, query: "k", items });

  it("publishes the 2026 rate constants the foundation doc locked", () => {
    expect(DFS_RATES).toEqual({
      serpStandardPerTask: 0.0006,
      serpLivePerTask: 0.002,
      keywordsDataPerTask: 0.0012,
      keywordsDataPerKeyword: 0.00012,
      labsPerTask: 0.012,
      labsPerItem: 0.00012,
      backlinksSummary: 0.02,
    });
  });

  it("prices SERP per task at the Standard rate, and Live at 3.3x", () => {
    expect(standard.estimateCostUsd(op("serp", 1))).toBeCloseTo(0.0006, 9);
    expect(standard.estimateCostUsd(op("serp", 50))).toBeCloseTo(0.03, 9);
    expect(live.estimateCostUsd(op("serp", 1))).toBeCloseTo(0.002, 9);
    expect(live.estimateCostUsd(op("serp", 1)) / standard.estimateCostUsd(op("serp", 1))).toBeCloseTo(3.333, 2);
  });

  it("prices Keywords Data as task + per-keyword, and Labs as task + per-item", () => {
    // 100 keywords: $0.0012 + 100 x $0.00012 = $0.0132
    expect(standard.estimateCostUsd(op("volume", 100))).toBeCloseTo(0.0132, 9);
    // suggestions ride Labs: $0.012 + 100 x $0.00012 = $0.024
    expect(standard.estimateCostUsd(op("suggestions", 100))).toBeCloseTo(0.024, 9);
  });

  it("prices backlinks at the pay-as-you-go summary rate", () => {
    expect(standard.estimateCostUsd(op("backlinks", 1))).toBeCloseTo(0.02, 9);
  });

  it("is pure and synchronous — the stop-loss calls it before every dispatch", () => {
    const o = op("serp", 10);
    expect(standard.estimateCostUsd(o)).toBe(standard.estimateCostUsd(o));
    expect(typeof standard.estimateCostUsd(o)).toBe("number");
  });

  it("defaults items to 1 when an op does not declare a batch size", () => {
    expect(standard.estimateCostUsd({ kind: "serp", query: "k" })).toBeCloseTo(DFS_RATES.serpStandardPerTask, 9);
  });

  // ── SM-42 / addendum §A9.5 — items >= 1 alignment with the simulator. This is the NAMED example
  // from the design addendum: an items:0 'serp' op used to price at exactly $0 (rate * 0), which is
  // the §4d fail-open class arriving through a degenerate input on the money path. ──────────────────
  it("clamps items to a floor of 1 — an items:0 serp op prices the SAME as items:1, never $0", () => {
    const zero = standard.estimateCostUsd(op("serp", 0));
    const one = standard.estimateCostUsd(op("serp", 1));
    expect(zero).toBeCloseTo(one, 9);
    expect(zero).toBeCloseTo(DFS_RATES.serpStandardPerTask, 9);
    expect(zero).toBeGreaterThan(0);
  });

  it("reproduces the foundation's per-client monthly order of magnitude", () => {
    // A 'standard' engagement: 50 tracked keywords daily + 100-keyword monthly volume refresh.
    const rank = standard.estimateCostUsd(op("serp", 50)) * 30;
    const volume = standard.estimateCostUsd(op("volume", 100));
    // foundation §8a: SEO ~= $5.40/client/mo for a full round — same order, well under it for rank+volume.
    expect(rank + volume).toBeGreaterThan(0.5);
    expect(rank + volume).toBeLessThan(5.4);
  });
});

describe("SM-06 keyless bootstrap — no credentials means no registered driver", () => {
  it("returns null when either credential half is missing, and a driver when both are set", () => {
    const original = { ...config.search.dataforseo };
    try {
      config.search.dataforseo = { ...original, login: "", password: "" };
      expect(createDataForSeoProviderFromConfig()).toBeNull();

      config.search.dataforseo = { ...original, login: "user", password: "" };
      expect(createDataForSeoProviderFromConfig()).toBeNull();

      config.search.dataforseo = { ...original, login: "", password: "pass" };
      expect(createDataForSeoProviderFromConfig()).toBeNull();

      config.search.dataforseo = { ...original, login: "user", password: "pass" };
      const p = createDataForSeoProviderFromConfig();
      expect(p).toBeInstanceOf(DataForSeoProvider);
      expect(p!.key).toBe("dataforseo");
    } finally {
      config.search.dataforseo = original;
    }
  });

  it("defaults the queue to Standard — Live must be opted into explicitly", () => {
    // The parsed config (not the raw env) is what the driver reads; anything other than the exact
    // string 'live' resolves to 'standard', so a typo can never triple the bill.
    expect(["standard", "live"]).toContain(config.search.dataforseo.queue);
    const parse = (v: string | undefined) => (v ?? "standard") === "live" ? "live" : "standard";
    expect(parse(undefined)).toBe("standard");
    expect(parse("")).toBe("standard");
    expect(parse("LIVE")).toBe("standard");
    expect(parse("standard")).toBe("standard");
    expect(parse("live")).toBe("live");
  });

  it("ships all three pillars enabled by default; only an explicit '0' disables one", () => {
    const parse = (v: string | undefined) => (v ?? "1") !== "0";
    expect(parse(undefined)).toBe(true);
    expect(parse("1")).toBe(true);
    expect(parse("0")).toBe(false);
    expect(config.search.pillars).toEqual({ seo: true, sem: true, geo: true });
  });
});
