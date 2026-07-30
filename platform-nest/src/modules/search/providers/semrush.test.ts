// SM-34 — Semrush driver tests against an in-process MOCK SERVER (tracker §6 SM-34 AC: "every
// capability parses from a mocked envelope; rate tables asserted constant-by-constant with the
// unit->USD derivation in a comment; keyless per-vendor disable proven independently; vendor error
// envelopes and 200s carrying errors handled; no response body in error messages").
//
// No network, no credentials, no vendor account: `fetchImpl` is injected, exactly like
// dataforseo.test.ts. Semrush's OWN envelope quirk — semicolon-delimited plain text, and a FAILED
// lookup still returning HTTP 200 with an `ERROR <code> :: <message>` body — is exercised directly,
// since that is genuinely different from DataForSEO's JSON-with-embedded-status-code shape.
// Mid-flight amendment (design addendum §A3/§A7 OQ-9, binding — see docs/blueprints/
// seo-sem-design-addendum-providers.md): estimateCostUsd's unit->USD ratio is no longer a hardcoded
// assumed constant. Both `monthlyPlanPriceUsd` and `monthlyUnitAllowance` are OWNER-SUPPLIED,
// UNVERIFIED facts read from config (default 0, i.e. unregistered); `computeSemrushCostPerUnitUsd`
// is the pure derivation function under test, and `SemrushOptions.costPerUnitUsd` is what the class
// actually consumes (tests inject an arbitrary positive test rate directly, matching how
// dataforseo.test.ts injects test config rather than asserting a specific vendor dollar figure).
import { describe, it, expect } from "vitest";
import { config } from "../../../config";
import {
  SemrushProvider,
  SEMRUSH_RATES,
  computeSemrushCostPerUnitUsd,
  createSemrushProviderFromConfig,
} from "./semrush";
import type { ProviderOp } from "./types";

/** A representative positive test rate — NOT asserted as vendor truth, just a fixed number the cost
 *  arithmetic tests can multiply through predictably. */
const TEST_RATE_USD_PER_UNIT = 0.0001;

/** Records every request and answers from a path(query-string-prefix)->body script, mirroring
 *  dataforseo.test.ts's mockServer() but returning Semrush's semicolon-delimited TEXT body instead
 *  of JSON, and matching on the `type=` query param rather than the URL path (Semrush's classic API
 *  is one endpoint, `/`, differentiated entirely by `type`). */
function mockServer(routes: Record<string, string | ((qs: URLSearchParams) => string)>) {
  const calls: Array<{ qs: URLSearchParams; url: string }> = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const full = new URL(String(url));
    const qs = full.searchParams;
    calls.push({ qs, url: full.toString() });
    const type = qs.get("type") ?? "";
    const match = routes[type];
    if (match === undefined) return { ok: false, status: 404, text: async () => "" } as unknown as Response;
    const body = typeof match === "function" ? match(qs) : match;
    return { ok: true, status: 200, text: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function provider(
  routes: Record<string, string | ((qs: URLSearchParams) => string)>,
  overrides: Partial<ConstructorParameters<typeof SemrushProvider>[0]> = {},
) {
  const { calls, fetchImpl } = mockServer(routes);
  const p = new SemrushProvider({
    apiKey: "test-key", baseUrl: "https://api.test", database: "us", timeoutMs: 5000,
    costPerUnitUsd: TEST_RATE_USD_PER_UNIT, fetchImpl,
    ...overrides,
  });
  return { p, calls };
}

describe("SM-34 Semrush driver — capabilities against a mock server", () => {
  it("advertises exactly the capabilities design §6 assigns Semrush — no suggestions, no ai_visibility", () => {
    const { p } = provider({});
    for (const cap of ["volume", "difficulty", "backlinks", "competitors", "serp"]) {
      expect(p.capabilities.has(cap as never)).toBe(true);
    }
    expect(p.capabilities.has("suggestions" as never)).toBe(false);
    expect(p.capabilities.has("ai_visibility" as never)).toBe(false);
  });

  // ── SERP (synchronous — no async queue) ────────────────────────────────────────────────────────
  it("resolves organic rankings for a keyword with no second network round trip on fetch", async () => {
    const { p, calls } = provider({
      phrase_organic: "Po;Ur;Dn\r\n1;https://a.example/;a.example\r\n3;https://b.example/;b.example\r\n",
    });
    const refs = await p.postSerpTasks([{ keyword: "sepatu lari" }]);
    expect(refs).toEqual([{ id: "semrush-serp-0", keyword: "sepatu lari" }]);
    expect(calls).toHaveLength(1); // the HTTP call already happened inside postSerpTasks

    const [res] = await p.fetchSerpResults(refs);
    expect(calls).toHaveLength(1); // fetchSerpResults made NO further network call
    expect(res.keyword).toBe("sepatu lari");
    expect(res.items).toEqual([
      { position: 1, url: "https://a.example/", title: undefined },
      { position: 3, url: "https://b.example/", title: undefined },
    ]);
  });

  it("requests the Organic Results report with the documented column set", async () => {
    const { p, calls } = provider({ phrase_organic: "Po;Ur;Dn\r\n" });
    await p.postSerpTasks([{ keyword: "running shoes", locale: "en-US" }]);
    expect(calls[0].qs.get("type")).toBe("phrase_organic");
    expect(calls[0].qs.get("phrase")).toBe("running shoes");
    expect(calls[0].qs.get("export_columns")).toBe("Po,Ur,Dn");
    expect(calls[0].qs.get("database")).toBe("us");
    // Auth is a QUERY PARAM for Semrush, never a header — and never the raw password-style secret
    // DataForSEO would use.
    expect(calls[0].qs.get("key")).toBe("test-key");
  });

  it("refuses to fetch a SERP result before postSerpTasks ran for that id", async () => {
    const { p } = provider({});
    await expect(p.fetchSerpResults([{ id: "nonexistent", keyword: "k" }])).rejects.toThrow(
      /was not found.*postSerpTasks/,
    );
  });

  it("short-circuits an empty SERP request batch without calling the API", async () => {
    const { p, calls } = provider({});
    expect(await p.postSerpTasks([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  // ── Keyword metrics ─────────────────────────────────────────────────────────────────────────────
  it("maps batch keyword metrics back onto the requested keywords, tolerating a missing row", async () => {
    const { p, calls } = provider({
      phrase_these: "Ph;Nq;Cp;Kd\r\nalpha;1200;0.42;37\r\n",
    });
    const res = await p.getKeywordMetrics([{ keyword: "alpha" }, { keyword: "beta" }]);
    expect(res).toEqual([
      { keyword: "alpha", volume: 1200, cpcUsd: 0.42, difficulty: 37 },
      { keyword: "beta", volume: undefined, cpcUsd: undefined, difficulty: undefined },
    ]);
    expect(calls[0].qs.get("type")).toBe("phrase_these");
    expect(calls[0].qs.get("phrase")).toBe("alpha;beta"); // batch = semicolon-joined in ONE param
  });

  it("short-circuits an empty keyword batch without calling the API", async () => {
    const { p, calls } = provider({});
    expect(await p.getKeywordMetrics([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  // ── Backlinks ───────────────────────────────────────────────────────────────────────────────────
  it("parses a backlinks overview summary", async () => {
    const { p, calls } = provider({
      backlinks_overview: "ascore;total;domains_num\r\n42;5321;214\r\n",
    });
    expect(await p.getBacklinkSummary("example.com")).toEqual({
      target: "example.com", backlinks: 5321, refDomains: 214, authorityScore: 42,
    });
    expect(calls[0].qs.get("type")).toBe("backlinks_overview");
    expect(calls[0].qs.get("target")).toBe("example.com");
  });

  it("defaults missing backlink counters to 0 on an empty result set", async () => {
    const { p } = provider({ backlinks_overview: "ascore;total;domains_num\r\n" });
    expect(await p.getBacklinkSummary("nothing.example")).toEqual({
      target: "nothing.example", backlinks: 0, refDomains: 0, authorityScore: undefined,
    });
  });

  // ── Non-advertised capabilities refuse rather than fake data ──────────────────────────────────────
  it("refuses ai_visibility — Semrush has no AI-visibility product", async () => {
    const { p } = provider({});
    await expect(p.getAiVisibility({ query: "x" })).rejects.toThrow(/does not offer 'ai_visibility'/);
  });

  it("estimateCostUsd throws for the two OpKinds it does not support (defensive — unreachable via dispatch)", () => {
    const { p } = provider({});
    expect(() => p.estimateCostUsd({ kind: "suggestions", query: "k" })).toThrow(/does not support op kind 'suggestions'/);
    expect(() => p.estimateCostUsd({ kind: "ai_visibility", query: "k" })).toThrow(/does not support op kind 'ai_visibility'/);
  });

  // ── Errors: envelope-level (200 carrying an error) + HTTP + credential handling ───────────────────
  it("propagates a 200-with-ERROR-body envelope failure exactly like DataForSEO's embedded status code", async () => {
    const { p } = provider({ backlinks_overview: "ERROR 50 :: NOTHING FOUND" });
    await expect(p.getBacklinkSummary("x.example")).rejects.toThrow(/ERROR 50 NOTHING FOUND/);
  });

  it("propagates an API-units-exhausted error the same way", async () => {
    const { p } = provider({ phrase_these: "ERROR 132 :: API UNITS BALANCE IS ZERO" });
    await expect(p.getKeywordMetrics([{ keyword: "k" }])).rejects.toThrow(/ERROR 132/);
  });

  it("does not echo the response body on an HTTP error (the URL itself carries the `key` credential)", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 403, text: async () => "account: secret-internal-id" })) as unknown as typeof fetch;
    const p = new SemrushProvider({
      apiKey: "leak-me-not", baseUrl: "https://api.test", database: "us", timeoutMs: 100,
      costPerUnitUsd: TEST_RATE_USD_PER_UNIT, fetchImpl,
    });
    const err = await p.getBacklinkSummary("x.example").catch((e: Error) => e);
    expect((err as Error).message).toBe("semrush backlinks_overview returned HTTP 403");
    expect((err as Error).message).not.toContain("secret-internal-id");
    expect((err as Error).message).not.toContain("leak-me-not");
  });

  it("aborts a hung request on the configured timeout", async () => {
    const fetchImpl = ((_u: unknown, init?: RequestInit) => new Promise((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(new Error("The operation was aborted")));
    })) as unknown as typeof fetch;
    const p = new SemrushProvider({
      apiKey: "k", baseUrl: "https://api.test", database: "us", timeoutMs: 20,
      costPerUnitUsd: TEST_RATE_USD_PER_UNIT, fetchImpl,
    });
    await expect(p.getBacklinkSummary("x.example")).rejects.toThrow(/abort/i);
  });
});

describe("SM-34 cost table + unit->USD derivation (design addendum §A3, binding)", () => {
  const { p } = provider({});
  const op = (kind: ProviderOp["kind"], items: number): ProviderOp => ({ kind, query: "k", items });

  it("publishes the researched per-report unit-cost constants (report structure — NOT the unverified $/unit ratio)", () => {
    expect(SEMRUSH_RATES).toEqual({
      keywordOverviewUnitsPerLine: 10,
      keywordDifficultyUnitsPerLine: 50,
      serpUnitsPerLine: 10,
      backlinksUnitsPerLine: 40,
      competitorsUnitsPerLine: 40,
    });
  });

  describe("computeSemrushCostPerUnitUsd — the pure price/allowance derivation", () => {
    it("is 0 when either input is 0 (the config default) — never a positive fallback", () => {
      expect(computeSemrushCostPerUnitUsd(0, 0)).toBe(0);
      expect(computeSemrushCostPerUnitUsd(500, 0)).toBe(0);
      expect(computeSemrushCostPerUnitUsd(0, 10_000_000)).toBe(0);
    });

    it("is 0 for a negative input too (defensive — config parsing should never produce one)", () => {
      expect(computeSemrushCostPerUnitUsd(-500, 10_000_000)).toBe(0);
      expect(computeSemrushCostPerUnitUsd(500, -10_000_000)).toBe(0);
    });

    it("derives price / allowance once both are positive, with no hardcoded vendor figure asserted", () => {
      expect(computeSemrushCostPerUnitUsd(500, 10_000_000)).toBeCloseTo(0.00005, 9);
      expect(computeSemrushCostPerUnitUsd(549, 300_000)).toBeCloseTo(549 / 300_000, 9);
    });
  });

  it("prices a volume op as (keyword-overview + difficulty) units, since difficulty rides the volume op", () => {
    const expected = (SEMRUSH_RATES.keywordOverviewUnitsPerLine + SEMRUSH_RATES.keywordDifficultyUnitsPerLine) *
      10 * TEST_RATE_USD_PER_UNIT;
    expect(p.estimateCostUsd(op("volume", 10))).toBeCloseTo(expected, 9);
  });

  it("prices a serp op at the confirmed 10-units/line organic-results rate", () => {
    expect(p.estimateCostUsd(op("serp", 1))).toBeCloseTo(SEMRUSH_RATES.serpUnitsPerLine * TEST_RATE_USD_PER_UNIT, 9);
  });

  it("prices a backlinks op at the proxied 40-units/line rate", () => {
    expect(p.estimateCostUsd(op("backlinks", 1))).toBeCloseTo(SEMRUSH_RATES.backlinksUnitsPerLine * TEST_RATE_USD_PER_UNIT, 9);
  });

  // ── SM-42 / addendum §A9.5 — items >= 1 alignment with the simulator ──────────────────────────────
  it("clamps items to a floor of 1 — an items:0 serp op prices the SAME as items:1, never $0", () => {
    const zero = p.estimateCostUsd(op("serp", 0));
    const one = p.estimateCostUsd(op("serp", 1));
    expect(zero).toBeCloseTo(one, 9);
    expect(zero).toBeGreaterThan(0);
  });

  it("is pure and synchronous — the stop-loss calls it before every dispatch", () => {
    const o = op("serp", 10);
    expect(p.estimateCostUsd(o)).toBe(p.estimateCostUsd(o));
    expect(typeof p.estimateCostUsd(o)).toBe("number");
  });

  it("defaults items to 1 when an op does not declare a batch size", () => {
    expect(p.estimateCostUsd({ kind: "serp", query: "k" })).toBeCloseTo(SEMRUSH_RATES.serpUnitsPerLine * TEST_RATE_USD_PER_UNIT, 9);
  });

  it("B1: throws rather than returning $0 if ever called on an instance with a non-positive rate (defensive, bypasses the factory)", () => {
    const { p: unpriced } = provider({}, { costPerUnitUsd: 0 });
    expect(() => unpriced.estimateCostUsd(op("serp", 1))).toThrow(/costPerUnitUsd is not configured/);
    const { p: negRate } = provider({}, { costPerUnitUsd: -1 });
    expect(() => negRate.estimateCostUsd(op("backlinks", 1))).toThrow(/costPerUnitUsd is not configured/);
  });
});

describe("SM-34 keyless bootstrap — registration requires BOTH a key AND a positive unit rate, independent of the other vendors", () => {
  it("returns null when SEMRUSH_API_KEY is empty even with a valid rate configured", () => {
    const original = { ...config.search.semrush };
    try {
      config.search.semrush = { ...original, apiKey: "", monthlyPlanPriceUsd: 500, monthlyUnitAllowance: 10_000_000 };
      expect(createSemrushProviderFromConfig()).toBeNull();
    } finally {
      config.search.semrush = original;
    }
  });

  it("B1: returns null when the API key is present but NO unit rate is configured — never falls back to $0", () => {
    const original = { ...config.search.semrush };
    try {
      config.search.semrush = { ...original, apiKey: "a-real-key", monthlyPlanPriceUsd: 0, monthlyUnitAllowance: 0 };
      expect(createSemrushProviderFromConfig()).toBeNull();

      config.search.semrush = { ...original, apiKey: "a-real-key", monthlyPlanPriceUsd: 500, monthlyUnitAllowance: 0 };
      expect(createSemrushProviderFromConfig()).toBeNull();

      config.search.semrush = { ...original, apiKey: "a-real-key", monthlyPlanPriceUsd: 0, monthlyUnitAllowance: 10_000_000 };
      expect(createSemrushProviderFromConfig()).toBeNull();
    } finally {
      config.search.semrush = original;
    }
  });

  it("registers once BOTH the key and a positive rate are configured", () => {
    const original = { ...config.search.semrush };
    try {
      config.search.semrush = { ...original, apiKey: "a-real-key", monthlyPlanPriceUsd: 500, monthlyUnitAllowance: 10_000_000 };
      const p = createSemrushProviderFromConfig();
      expect(p).toBeInstanceOf(SemrushProvider);
      expect(p!.key).toBe("semrush");
      // The configured rate flows through to a real cost estimate (never $0).
      expect(p!.estimateCostUsd({ kind: "serp", query: "k", items: 1 })).toBeGreaterThan(0);
    } finally {
      config.search.semrush = original;
    }
  });

  it("Semrush registration is decided purely from config.search.semrush — Ahrefs's own key never affects it", () => {
    const semrushOriginal = { ...config.search.semrush };
    const ahrefsOriginal = { ...config.search.ahrefs };
    try {
      config.search.semrush = {
        ...semrushOriginal, apiKey: "semrush-present", monthlyPlanPriceUsd: 500, monthlyUnitAllowance: 10_000_000,
      };
      config.search.ahrefs = { ...ahrefsOriginal, apiKey: "" }; // Ahrefs deliberately absent
      const p = createSemrushProviderFromConfig();
      expect(p).toBeInstanceOf(SemrushProvider); // Semrush still registers
    } finally {
      config.search.semrush = semrushOriginal;
      config.search.ahrefs = ahrefsOriginal;
    }
  });
});
