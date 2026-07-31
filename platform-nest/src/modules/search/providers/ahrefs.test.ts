// SM-35 — Ahrefs driver tests against an in-process MOCK SERVER (tracker §6 SM-35 AC, design
// addendum §A3/§A7 OQ-10 mid-flight amendments: "every capability parses from a mocked envelope;
// rate tables asserted constant-by-constant with the unit->USD derivation in a comment; keyless
// per-vendor disable proven independently; an unset unit rate means NOT REGISTERED, never $0;
// vendor error envelopes handled; no response body in error messages").
//
// No network, no credentials, no vendor account: `fetchImpl` is injected, exactly like
// dataforseo.test.ts/semrush.test.ts. Ahrefs's OWN envelope quirk — real JSON wrapped under a
// resource-named key, ordinary non-2xx HTTP errors with a `{"error": "..."}` body, and a confirmed
// `x-api-units-cost-total-actual` response header — is exercised directly.
import { describe, it, expect } from "vitest";
import { config } from "../../../config";
import {
  AhrefsProvider,
  AHREFS_RATES,
  computeAhrefsCostPerUnitUsd,
  createAhrefsProviderFromConfig,
} from "./ahrefs";
import { withActualCostCapture, type ProviderOp } from "./types";

/** A representative positive test rate — NOT asserted as vendor truth, just a fixed number the cost
 *  arithmetic tests can multiply through predictably. */
const TEST_RATE_USD_PER_UNIT = 0.001;

/** Records every request and answers from a path-prefix->body script. Response headers can be
 *  supplied per-route to exercise the confirmed x-api-units-cost-total-actual true-up capture. */
function mockServer(
  routes: Record<string, unknown | ((url: URL) => unknown)>,
  headersByRoute: Record<string, Record<string, string>> = {},
) {
  const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const full = new URL(String(url));
    calls.push({ url: full, headers: (init?.headers ?? {}) as Record<string, string> });
    // baseUrl is "https://api.test/v3", so full.pathname is "/v3/site-explorer/..." — routes are
    // keyed by the path this driver passes to call() (no "/v3" prefix), hence endsWith not startsWith.
    const match = Object.keys(routes).find((r) => full.pathname.endsWith(r));
    if (!match) {
      return {
        ok: false, status: 404,
        headers: { get: () => null },
        json: async () => ({ error: "not found" }),
      } as unknown as Response;
    }
    const route = routes[match];
    const payload = typeof route === "function" ? (route as (u: URL) => unknown)(full) : route;
    const hdrs = headersByRoute[match] ?? {};
    return {
      ok: true, status: 200,
      headers: { get: (name: string) => hdrs[name.toLowerCase()] ?? null },
      json: async () => payload,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function provider(
  routes: Record<string, unknown | ((url: URL) => unknown)>,
  overrides: Partial<ConstructorParameters<typeof AhrefsProvider>[0]> = {},
  headersByRoute: Record<string, Record<string, string>> = {},
) {
  const { calls, fetchImpl } = mockServer(routes, headersByRoute);
  const p = new AhrefsProvider({
    apiKey: "test-token", baseUrl: "https://api.test/v3", timeoutMs: 5000, country: "us",
    rankTrackerProjectId: "proj-123", costPerUnitUsd: TEST_RATE_USD_PER_UNIT, fetchImpl,
    ...overrides,
  });
  return { p, calls };
}

describe("SM-35 Ahrefs driver — capabilities against a mock server", () => {
  it("advertises exactly the capabilities design §6/addendum §A2 assign Ahrefs — no suggestions, no ai_visibility", () => {
    const { p } = provider({});
    for (const cap of ["backlinks", "volume", "difficulty", "competitors", "serp"]) {
      expect(p.capabilities.has(cap as never)).toBe(true);
    }
    expect(p.capabilities.has("suggestions" as never)).toBe(false);
    expect(p.capabilities.has("ai_visibility" as never)).toBe(false);
  });

  // ── SERP (confirmed free; synchronous — no async queue) ────────────────────────────────────────
  it("resolves SERP Overview positions with no second network round trip on fetch", async () => {
    const { p, calls } = provider({
      "/serp-overview/serp-overview": {
        positions: [
          { position: 1, url: "https://a.example/", title: "A" },
          { position: 3, url: "https://b.example/", title: null },
          { position: 5, url: null }, // no-URL row must be filtered out
        ],
      },
    });
    const refs = await p.postSerpTasks([{ keyword: "sepatu lari" }]);
    expect(refs).toEqual([{ id: "ahrefs-serp-0", keyword: "sepatu lari" }]);
    expect(calls).toHaveLength(1);

    const [res] = await p.fetchSerpResults(refs);
    expect(calls).toHaveLength(1); // fetchSerpResults made NO further network call
    expect(res.items).toEqual([
      { position: 1, url: "https://a.example/", title: "A" },
      { position: 3, url: "https://b.example/", title: undefined },
    ]);
  });

  it("requests SERP Overview with the documented query params", async () => {
    const { p, calls } = provider({ "/serp-overview/serp-overview": { positions: [] } });
    await p.postSerpTasks([{ keyword: "running shoes", locale: "en-GB", device: "mobile" }]);
    const qs = calls[0].url.searchParams;
    expect(qs.get("keyword")).toBe("running shoes");
    expect(qs.get("country")).toBe("gb");
    expect(qs.get("device")).toBe("mobile");
    expect(qs.get("project_id")).toBe("proj-123");
    // Bearer auth, never a query param (contrast with Semrush's `key=` model).
    expect(calls[0].headers.Authorization).toBe("Bearer test-token");
    expect(calls[0].headers.Accept).toBe("application/json");
  });

  // SM-44(c): without a configured Rank Tracker project id, 'serp' is dropped from the ADVERTISED
  // capability set at construction (not merely refused deep inside postSerpTasks) — so
  // registry.ts's own capability gate refuses honestly (NoCapableProviderError) before ever reaching
  // this driver, instead of the driver failing at call time with a capability it falsely claimed.
  it("does NOT advertise 'serp' when no Rank Tracker project id is configured", () => {
    const { p } = provider({}, { rankTrackerProjectId: undefined });
    expect(p.capabilities.has("serp" as never)).toBe(false);
    // every other capability is unaffected by this one flag
    for (const cap of ["backlinks", "volume", "difficulty", "competitors"]) {
      expect(p.capabilities.has(cap as never)).toBe(true);
    }
  });

  it("refuses SERP requests BEFORE any network call when no Rank Tracker project id is configured — "
    + "still refuses even if called directly, bypassing the capability gate", async () => {
    const { p, calls } = provider({ "/serp-overview/serp-overview": { positions: [] } }, { rankTrackerProjectId: undefined });
    // Direct call bypasses registry.ts's capability check entirely; the driver's own capability
    // gate (now excluding 'serp') is what fires first — a defence-in-depth refusal naming the
    // capability, not the underlying reason (that reason lives in the doc comment / config wiring).
    await expect(p.postSerpTasks([{ keyword: "k" }])).rejects.toThrow(/does not offer 'serp'/);
    expect(calls).toHaveLength(0);
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
  it("maps keywords-explorer overview rows back onto the requested keywords, tolerating a missing row", async () => {
    const { p, calls } = provider({
      "/keywords-explorer/overview": { keywords: [{ keyword: "alpha", volume: 1200, difficulty: 37 }] },
    });
    const res = await p.getKeywordMetrics([{ keyword: "alpha" }, { keyword: "beta" }]);
    expect(res).toEqual([
      { keyword: "alpha", volume: 1200, difficulty: 37 },
      { keyword: "beta", volume: undefined, difficulty: undefined },
    ]);
    const qs = calls[0].url.searchParams;
    expect(qs.get("keywords")).toBe("alpha,beta");
    expect(qs.get("select")).toBe("keyword,volume,traffic_potential,difficulty");
  });

  it("short-circuits an empty keyword batch without calling the API", async () => {
    const { p, calls } = provider({});
    expect(await p.getKeywordMetrics([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  // ── Backlinks (two calls: stats + domain rating) ───────────────────────────────────────────────
  it("combines backlinks-stats and domain-rating into one BacklinkSummary", async () => {
    const { p, calls } = provider({
      "/site-explorer/backlinks-stats": { metrics: { live: 5321, live_refdomains: 214 } },
      "/site-explorer/domain-rating": { domain_rating: { domain_rating: 42, ahrefs_rank: 900 } },
    });
    expect(await p.getBacklinkSummary("example.com")).toEqual({
      target: "example.com", backlinks: 5321, refDomains: 214, authorityScore: 42,
    });
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.url.pathname.endsWith("/site-explorer/backlinks-stats"))).toBe(true);
    expect(calls.some((c) => c.url.pathname.endsWith("/site-explorer/domain-rating"))).toBe(true);
  });

  it("defaults missing backlink counters to 0 / undefined authority on an empty result", async () => {
    const { p } = provider({
      "/site-explorer/backlinks-stats": { metrics: {} },
      "/site-explorer/domain-rating": { domain_rating: {} },
    });
    expect(await p.getBacklinkSummary("nothing.example")).toEqual({
      target: "nothing.example", backlinks: 0, refDomains: 0, authorityScore: undefined,
    });
  });

  // ── SM-42 true-up capture (design addendum §A8.7) — WIRED via takeActualCostUsd ───────────────────
  it("reports the confirmed x-api-units-cost-total-actual header, converted to USD, via takeActualCostUsd — without changing estimateCostUsd", async () => {
    const { p } = provider(
      {
        "/site-explorer/backlinks-stats": { metrics: { live: 1, live_refdomains: 1 } },
        "/site-explorer/domain-rating": { domain_rating: { domain_rating: 5 } },
      },
      {},
      { "/site-explorer/domain-rating": { "x-api-units-cost-total-actual": "37" } },
    );
    const summaryBefore = p.estimateCostUsd({ kind: "backlinks", query: "x.example", items: 1 });
    const { actualCostUsd } = await withActualCostCapture(p, () => p.getBacklinkSummary("x.example"));
    // 37 units, converted through THIS instance's own costPerUnitUsd (TEST_RATE_USD_PER_UNIT) — not
    // the raw unit count, and not a hardcoded ratio living outside the driver.
    expect(actualCostUsd).toBeCloseTo(37 * TEST_RATE_USD_PER_UNIT, 9);
    // estimateCostUsd is unaffected — it is a pure, pre-dispatch function with no access to a
    // response, so the confirmed header cannot (and does not) feed back into it directly.
    expect(p.estimateCostUsd({ kind: "backlinks", query: "x.example", items: 1 })).toBe(summaryBefore);
  });

  it("sums BOTH of getBacklinkSummary's parallel calls into ONE actual cost — not last-write-wins", async () => {
    const { p } = provider(
      {
        "/site-explorer/backlinks-stats": { metrics: { live: 1, live_refdomains: 1 } },
        "/site-explorer/domain-rating": { domain_rating: { domain_rating: 5 } },
      },
      {},
      {
        "/site-explorer/backlinks-stats": { "x-api-units-cost-total-actual": "12" },
        "/site-explorer/domain-rating": { "x-api-units-cost-total-actual": "37" },
      },
    );
    const { actualCostUsd } = await withActualCostCapture(p, () => p.getBacklinkSummary("sum.example"));
    // The OLD lastObserved-style single slot could only ever report ONE call's figure (whichever
    // resolved last) — 37 or 12, never their sum. A regression back to that shape fails this
    // assertion, not just a subtler one.
    expect(actualCostUsd).toBeCloseTo((12 + 37) * TEST_RATE_USD_PER_UNIT, 9);
  });

  it("reports undefined (never 0) when the vendor's response carries no actual-cost header", async () => {
    const { p } = provider({
      "/site-explorer/backlinks-stats": { metrics: { live: 1, live_refdomains: 1 } },
      "/site-explorer/domain-rating": { domain_rating: { domain_rating: 5 } },
    }); // no headersByRoute => no x-api-units-cost-total-actual anywhere
    const { actualCostUsd } = await withActualCostCapture(p, () => p.getBacklinkSummary("nohdr.example"));
    expect(actualCostUsd).toBeUndefined();
  });

  it("takeActualCostUsd() called OUTSIDE any capture scope is a harmless no-op, never a stale replay", () => {
    const { p } = provider({});
    expect(p.takeActualCostUsd()).toBeUndefined();
  });

  // ── SM-66 (tracker §6be.1/§6bc, design addendum §A14.2) — malformed true-up header hardening ─────
  // The defect: `!Number.isNaN(units)` LOOKS like validation but is not one, because `Number("")` and
  // `Number("   ")` coerce to 0, not NaN. Confirmed directly, not assumed:
  it("confirms the underlying JS coercion the defect rests on — Number('') and Number('   ') are 0, not NaN", () => {
    expect(Number("")).toBe(0);
    expect(Number("   ")).toBe(0);
    expect(Number.isNaN(Number(""))).toBe(false);
    expect(Number("-5")).toBe(-5);
    expect(Number("Infinity")).toBe(Infinity);
  });

  it.each(["", "   ", "-5", "Infinity", "-Infinity", "NaN", "0"])(
    "SM-66: a malformed x-api-units-cost-total-actual header (%j) leaves the true-up UNAPPLIED — pre-existing estimate stands, never $0",
    async (malformed) => {
      const { p } = provider(
        {
          "/site-explorer/backlinks-stats": { metrics: { live: 1, live_refdomains: 1 } },
          "/site-explorer/domain-rating": { domain_rating: { domain_rating: 5 } },
        },
        {},
        { "/site-explorer/domain-rating": { "x-api-units-cost-total-actual": malformed } },
      );
      const before = p.getTrueUpHeaderMalformedCount();
      const { actualCostUsd } = await withActualCostCapture(p, () => p.getBacklinkSummary(`malformed-${malformed}.example`));
      // No correction applied at all — dispatch.ts's contract is "undefined = no correction
      // available", identical to a response with no header whatsoever. A regression back to the old
      // guard would instead report `0` here (a fabricated true-up), which fails this exact assertion.
      expect(actualCostUsd).toBeUndefined();
      // Counted exactly once — the anomaly is disclosed, not silently absorbed as "no true-up this call".
      expect(p.getTrueUpHeaderMalformedCount()).toBe(before + 1);
    },
  );

  it("SM-66: a well-formed positive numeric header is UNAFFECTED by the tightened guard (regression pin)", async () => {
    const { p } = provider(
      {
        "/site-explorer/backlinks-stats": { metrics: { live: 1, live_refdomains: 1 } },
        "/site-explorer/domain-rating": { domain_rating: { domain_rating: 5 } },
      },
      {},
      { "/site-explorer/domain-rating": { "x-api-units-cost-total-actual": "37" } },
    );
    const before = p.getTrueUpHeaderMalformedCount();
    const { actualCostUsd } = await withActualCostCapture(p, () => p.getBacklinkSummary("wellformed.example"));
    expect(actualCostUsd).toBeCloseTo(37 * TEST_RATE_USD_PER_UNIT, 9);
    expect(p.getTrueUpHeaderMalformedCount()).toBe(before); // no anomaly counted for a good header
  });

  // ── SM-66 mutation probe (§6bc Ruling 5 does not strictly require a negative control for a
  // data-validity check rather than a concurrency guard, but the brief asked for one and it is cheap
  // and direct here): reproduce the EXACT old predicate inline and show it fails what the fixed
  // predicate passes, proving the two are behaviourally different rather than a cosmetic rewrite.
  it("SM-66 mutation probe: the OLD guard (!Number.isNaN(units)) would have recorded a fabricated $0/$negative/$Infinity true-up for every malformed case above", () => {
    const oldGuardPasses = (raw: string) => !Number.isNaN(Number(raw));
    const newGuardPasses = (raw: string) => Number.isFinite(Number(raw)) && Number(raw) > 0;
    for (const malformed of ["", "   ", "-5", "Infinity", "-Infinity", "0"]) {
      expect(oldGuardPasses(malformed)).toBe(true); // the old code would have proceeded to record
      expect(newGuardPasses(malformed)).toBe(false); // the new code correctly refuses
    }
    // And the new guard still accepts a genuine positive figure, exactly like the old one did.
    expect(newGuardPasses("37")).toBe(true);
    expect(oldGuardPasses("37")).toBe(true);
  });

  // ── SM-42 named hazard — the concurrency proof (tracker §6j step 3) ───────────────────────────────
  // getBacklinkSummary issues TWO calls in parallel for ONE op. The hazard: a naive capture (an
  // instance-level "last write wins" field) would, the moment a SECOND, unrelated dispatch races
  // concurrently against the SAME provider singleton (registry.ts holds exactly one instance per
  // ProviderKey), let one op's response overwrite the other's captured figure — attributing one
  // call's actual cost to the wrong ledger row, or dropping it. This test actually RACES two ops
  // against the same instance (Promise.all, not sequential awaits) with deliberately staggered
  // internal delays so their internal HTTP calls interleave, and proves each op still ends up with
  // exactly its OWN total.
  it("two ops racing concurrently on the SAME provider instance never cross-contaminate — each true-ups to its OWN reported cost", async () => {
    function racingFetch(statsUnits: number, ratingUnits: number, ratingDelayMs: number): typeof fetch {
      return (async (url: string | URL | Request) => {
        const full = new URL(String(url));
        if (full.pathname.endsWith("/site-explorer/backlinks-stats")) {
          return {
            ok: true, status: 200,
            headers: { get: (n: string) => (n.toLowerCase() === "x-api-units-cost-total-actual" ? String(statsUnits) : null) },
            json: async () => ({ metrics: { live: 1, live_refdomains: 1 } }),
          } as unknown as Response;
        }
        // domain-rating: delayed so op A's and op B's second calls resolve in CROSSED order relative
        // to each other (op B's rating resolves before op A's), not in dispatch order.
        await new Promise((r) => setTimeout(r, ratingDelayMs));
        return {
          ok: true, status: 200,
          headers: { get: (n: string) => (n.toLowerCase() === "x-api-units-cost-total-actual" ? String(ratingUnits) : null) },
          json: async () => ({ domain_rating: { domain_rating: 5 } }),
        } as unknown as Response;
      }) as unknown as typeof fetch;
    }

    // ONE provider instance — a process singleton, exactly as registry.ts holds.
    const shared = new AhrefsProvider({
      apiKey: "k", baseUrl: "https://api.test/v3", timeoutMs: 5000, country: "us",
      rankTrackerProjectId: "proj-123", costPerUnitUsd: TEST_RATE_USD_PER_UNIT,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const full = new URL(String(url));
        const isOpA = full.searchParams.get("target") === "a.example";
        const fetchImpl = isOpA ? racingFetch(10, 20, 30) : racingFetch(40, 5, 5);
        return fetchImpl(url, init);
      }) as unknown as typeof fetch,
    });

    const [a, b] = await Promise.all([
      withActualCostCapture(shared, () => shared.getBacklinkSummary("a.example")),
      withActualCostCapture(shared, () => shared.getBacklinkSummary("b.example")),
    ]);

    // op A: stats=10 + rating=20 (resolves at t=30ms) => 30 units
    expect(a.actualCostUsd).toBeCloseTo(30 * TEST_RATE_USD_PER_UNIT, 9);
    // op B: stats=40 + rating=5 (resolves at t=5ms, BEFORE op A's rating call settles) => 45 units
    expect(b.actualCostUsd).toBeCloseTo(45 * TEST_RATE_USD_PER_UNIT, 9);
  });

  // ── Non-advertised capabilities refuse rather than fake data ──────────────────────────────────────
  it("refuses ai_visibility — Ahrefs has no confirmed AI-visibility product exposed via API", async () => {
    const { p } = provider({});
    await expect(p.getAiVisibility({ query: "x" })).rejects.toThrow(/does not offer 'ai_visibility'/);
  });

  it("estimateCostUsd throws for the two OpKinds it does not support (defensive — unreachable via dispatch)", () => {
    const { p } = provider({});
    expect(() => p.estimateCostUsd({ kind: "suggestions", query: "k" })).toThrow(/does not support op kind 'suggestions'/);
    expect(() => p.estimateCostUsd({ kind: "ai_visibility", query: "k" })).toThrow(/does not support op kind 'ai_visibility'/);
  });

  // ── Errors + credential handling ────────────────────────────────────────────────────────────────
  it("does not echo the response body on an HTTP error (Ahrefs's error body can carry workspace detail)", async () => {
    const fetchImpl = (async () => ({
      ok: false, status: 403, headers: { get: () => null }, json: async () => ({ error: "workspace-secret-id" }),
    })) as unknown as typeof fetch;
    const p = new AhrefsProvider({
      apiKey: "leak-me-not", baseUrl: "https://api.test/v3", timeoutMs: 100, country: "us",
      costPerUnitUsd: TEST_RATE_USD_PER_UNIT, fetchImpl,
    });
    const err = await p.getKeywordMetrics([{ keyword: "k" }]).catch((e: Error) => e);
    expect((err as Error).message).toBe("ahrefs /keywords-explorer/overview returned HTTP 403");
    expect((err as Error).message).not.toContain("workspace-secret-id");
    expect((err as Error).message).not.toContain("leak-me-not");
  });

  it("aborts a hung request on the configured timeout", async () => {
    const fetchImpl = ((_u: unknown, init?: RequestInit) => new Promise((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(new Error("The operation was aborted")));
    })) as unknown as typeof fetch;
    const p = new AhrefsProvider({
      apiKey: "k", baseUrl: "https://api.test/v3", timeoutMs: 20, country: "us",
      costPerUnitUsd: TEST_RATE_USD_PER_UNIT, fetchImpl,
    });
    await expect(p.getKeywordMetrics([{ keyword: "k" }])).rejects.toThrow(/abort/i);
  });
});

describe("SM-35 cost table + unit->USD derivation (design addendum §A3, binding)", () => {
  const { p } = provider({});
  const op = (kind: ProviderOp["kind"], items: number): ProviderOp => ({ kind, query: "k", items });

  it("publishes the researched per-call unit-cost constants (report structure — NOT the unverified $/unit ratio)", () => {
    expect(AHREFS_RATES).toEqual({
      backlinksStatsBaseUnits: 50,
      domainRatingBaseUnits: 50,
      keywordsOverviewBaseUnits: 50,
      keywordsOverviewPerFieldUnits: 1,
      keywordsOverviewAssumedFields: 4,
      organicCompetitorsBaseUnits: 50,
      serpOverviewUnits: 0,
    });
  });

  describe("computeAhrefsCostPerUnitUsd — the pure price/allowance derivation", () => {
    it("is 0 when either input is 0 (the config default) — never a positive fallback", () => {
      expect(computeAhrefsCostPerUnitUsd(0, 0)).toBe(0);
      expect(computeAhrefsCostPerUnitUsd(500, 0)).toBe(0);
      expect(computeAhrefsCostPerUnitUsd(0, 150_000)).toBe(0);
    });

    it("is 0 for a negative input too (defensive)", () => {
      expect(computeAhrefsCostPerUnitUsd(-500, 150_000)).toBe(0);
      expect(computeAhrefsCostPerUnitUsd(500, -150_000)).toBe(0);
    });

    it("derives price / allowance once both are positive, with no hardcoded vendor figure asserted", () => {
      expect(computeAhrefsCostPerUnitUsd(500, 150_000)).toBeCloseTo(500 / 150_000, 9);
      expect(computeAhrefsCostPerUnitUsd(449, 1_000_000)).toBeCloseTo(449 / 1_000_000, 9);
    });
  });

  it("prices a backlinks op as (stats + rating) base units, scaling WITH items (one full call each per item)", () => {
    const expected = (AHREFS_RATES.backlinksStatsBaseUnits + AHREFS_RATES.domainRatingBaseUnits) *
      3 * TEST_RATE_USD_PER_UNIT;
    expect(p.estimateCostUsd(op("backlinks", 3))).toBeCloseTo(expected, 9);
  });

  it("prices a volume op with the base charged ONCE per call and only the per-row term scaling with items", () => {
    const oneRow = p.estimateCostUsd(op("volume", 1));
    const tenRows = p.estimateCostUsd(op("volume", 10));
    const base = AHREFS_RATES.keywordsOverviewBaseUnits * TEST_RATE_USD_PER_UNIT;
    const perRow = AHREFS_RATES.keywordsOverviewPerFieldUnits * AHREFS_RATES.keywordsOverviewAssumedFields * TEST_RATE_USD_PER_UNIT;
    expect(oneRow).toBeCloseTo(base + perRow, 9);
    expect(tenRows).toBeCloseTo(base + perRow * 10, 9);
    // The base does NOT scale 10x just because items did — that would be the 'backlinks' shape,
    // which this op deliberately does not share.
    expect(tenRows).toBeLessThan(oneRow * 10);
  });

  // ── SM-42 / addendum §A9.5 — items >= 1 alignment with the simulator ──────────────────────────────
  it("clamps items to a floor of 1 — an items:0 backlinks op prices the SAME as items:1, never $0", () => {
    const zero = p.estimateCostUsd(op("backlinks", 0));
    const one = p.estimateCostUsd(op("backlinks", 1));
    expect(zero).toBeCloseTo(one, 9);
    expect(zero).toBeGreaterThan(0);
  });

  it("prices a serp op at exactly $0 regardless of items — confirmed free, not an assumption", () => {
    expect(p.estimateCostUsd(op("serp", 1))).toBe(0);
    expect(p.estimateCostUsd(op("serp", 100))).toBe(0);
  });

  it("is pure and synchronous — the stop-loss calls it before every dispatch", () => {
    const o = op("backlinks", 1);
    expect(p.estimateCostUsd(o)).toBe(p.estimateCostUsd(o));
    expect(typeof p.estimateCostUsd(o)).toBe("number");
  });

  it("B1: throws rather than returning $0 if ever called on an instance with a non-positive rate — even for the free 'serp' op", () => {
    const { p: unpriced } = provider({}, { costPerUnitUsd: 0 });
    expect(() => unpriced.estimateCostUsd(op("serp", 1))).toThrow(/costPerUnitUsd is not configured/);
    expect(() => unpriced.estimateCostUsd(op("backlinks", 1))).toThrow(/costPerUnitUsd is not configured/);
    const { p: negRate } = provider({}, { costPerUnitUsd: -1 });
    expect(() => negRate.estimateCostUsd(op("volume", 1))).toThrow(/costPerUnitUsd is not configured/);
  });
});

describe("SM-35 keyless bootstrap — registration requires BOTH a key AND a positive unit rate, independent of the other vendors", () => {
  it("returns null when AHREFS_API_KEY is empty even with a valid rate configured", () => {
    const original = { ...config.search.ahrefs };
    try {
      config.search.ahrefs = { ...original, apiKey: "", monthlyApiTierPriceUsd: 500, monthlyApiTierUnitAllowance: 150_000 };
      expect(createAhrefsProviderFromConfig()).toBeNull();
    } finally {
      config.search.ahrefs = original;
    }
  });

  it("B1: returns null when the API key is present but NO unit rate is configured — never falls back to $0", () => {
    const original = { ...config.search.ahrefs };
    try {
      config.search.ahrefs = { ...original, apiKey: "a-real-token", monthlyApiTierPriceUsd: 0, monthlyApiTierUnitAllowance: 0 };
      expect(createAhrefsProviderFromConfig()).toBeNull();

      config.search.ahrefs = { ...original, apiKey: "a-real-token", monthlyApiTierPriceUsd: 500, monthlyApiTierUnitAllowance: 0 };
      expect(createAhrefsProviderFromConfig()).toBeNull();

      config.search.ahrefs = { ...original, apiKey: "a-real-token", monthlyApiTierPriceUsd: 0, monthlyApiTierUnitAllowance: 150_000 };
      expect(createAhrefsProviderFromConfig()).toBeNull();
    } finally {
      config.search.ahrefs = original;
    }
  });

  it("registers once BOTH the key and a positive rate are configured", () => {
    const original = { ...config.search.ahrefs };
    try {
      config.search.ahrefs = {
        ...original, apiKey: "a-real-token", monthlyApiTierPriceUsd: 500, monthlyApiTierUnitAllowance: 150_000,
      };
      const p = createAhrefsProviderFromConfig();
      expect(p).toBeInstanceOf(AhrefsProvider);
      expect(p!.key).toBe("ahrefs");
      // The configured rate flows through to a real cost estimate (never $0) for a non-free op.
      expect(p!.estimateCostUsd({ kind: "backlinks", query: "k", items: 1 })).toBeGreaterThan(0);
    } finally {
      config.search.ahrefs = original;
    }
  });

  it("Ahrefs registration is decided purely from config.search.ahrefs — Semrush's own key never affects it", () => {
    const ahrefsOriginal = { ...config.search.ahrefs };
    const semrushOriginal = { ...config.search.semrush };
    try {
      config.search.ahrefs = {
        ...ahrefsOriginal, apiKey: "ahrefs-present", monthlyApiTierPriceUsd: 500, monthlyApiTierUnitAllowance: 150_000,
      };
      config.search.semrush = { ...semrushOriginal, apiKey: "" }; // Semrush deliberately absent
      const p = createAhrefsProviderFromConfig();
      expect(p).toBeInstanceOf(AhrefsProvider); // Ahrefs still registers
    } finally {
      config.search.ahrefs = ahrefsOriginal;
      config.search.semrush = semrushOriginal;
    }
  });
});
