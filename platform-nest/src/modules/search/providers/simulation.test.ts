// SM-33 — proofs for the simulation provider tier and, more importantly, for its PROVENANCE.
//
// Two things are under test, and the second one is the ticket's real acceptance criterion:
//
//  1. The simulator is BELIEVABLE and DETERMINISTIC. "Believable" is not a vibe here — it is a set
//     of statistical properties a demo viewer would notice the absence of (a long-tail volume
//     distribution, volume falling with word count, CPC tracking commercial intent, difficulty
//     tracking volume, vendors disagreeing slightly, backlink profiles scaled to the domain). Flat
//     constants — what mock-provider.ts returns — would pass a "shape" test and fail every one of
//     these, which is exactly why this file asserts distributions and correlations rather than
//     single values. Determinism is asserted across fresh instances: same query ⇒ same output,
//     forever (addendum §A4.6, contractual).
//
//  2. SIMULATED DATA CANNOT BE MISTAKEN FOR REAL DATA — the two mode predicates ruled in addendum
//     §A4.1/§A4.2, which are the §4d fail-open class if either is missed:
//       * BUDGETS are mode-filtered: each mode binds against its own disjoint ledger, proven on a
//         MIXED table (real and simulated rows coexisting) in both directions, and proven to still
//         REFUSE (a budget cap must stop a simulated pull — the money path stays demonstrable).
//       * CACHE reads are mode-filtered symmetrically: a row written in one mode is invisible to a
//         read in the other, both directions, proven at the cache layer AND end-to-end through
//         dispatchProviderOp across a live mode flip.
//
// The integration half runs against LIVE Postgres for the same reason dispatch.test.ts does: these
// are DB guarantees (a WHERE clause and an upsert), and mocking the database would test nothing.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { config } from "../../../config";
import { newId, withGlobal, withTenants } from "../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, createClient } from "../../../testing/fixtures";
import { MockSearchProvider } from "./mock-provider";
import { registerProvider, resetProviders } from "./registry";
import { dispatchProviderOp, projectMonthlyCost } from "./dispatch";
import { buildCacheKey, readFreshCache, writeCache } from "./cache";
import { insertLedgerRow, resetGlobalMonthToDateCache, sumGlobalMonthToDate, sumMonthToDate } from "./ledger";
import { AHREFS_RATES } from "./ahrefs";
import { DFS_RATES } from "./dataforseo";
import { SEMRUSH_RATES } from "./semrush";
import {
  AI_ENGINES,
  classifyIntent,
  createSimulationProviders,
  isSimulatedProvider,
  providerMode,
  simulateBacklinks,
  simulateMarket,
  SimulatedSearchProvider,
  SIMULATED_PROVIDER_KEYS,
} from "./simulation";
import { BudgetExceededError, type Capability, type ProviderOp, type SearchDataProvider } from "./types";

// ── fixtures shared by the pure half ────────────────────────────────────────────────────────────────

/** A realistic keyword corpus: varied word counts and all four intents, written out rather than
 *  generated so a human reviewer can see that the numbers asserted below belong to plausible
 *  queries. */
const CORPUS = [
  "crm", "shoes", "seo", "coffee", "laptop",
  "running shoes", "best crm", "seo agency", "coffee grinder", "buy laptop",
  "best crm software", "how to do seo", "cheap running shoes", "coffee grinder review", "seo audit checklist",
  "best crm software for small business", "how to do seo for a local business", "cheap running shoes for wide feet",
  "what is technical seo and why does it matter", "coffee grinder burr vs blade comparison guide",
  "plumber near me", "dentist near me", "crm login", "hubspot login", "seo tools pricing",
  "content marketing ideas", "keyword research tutorial", "backlink audit template", "local seo checklist 2026",
  "enterprise seo platform pricing", "ahrefs vs semrush", "best project management software",
  "how to fix crawl errors", "why is my traffic dropping", "google ai overview optimization",
  "generative engine optimization guide", "aeo vs seo", "schema markup examples",
  "buy ergonomic office chair", "cheapest flight to bali", "hire wordpress developer",
  "digital marketing agency jakarta", "seo consultant rates", "technical seo audit service",
  "what is a canonical tag", "how to write meta descriptions", "core web vitals guide 2026",
];

/** A large synthetic corpus for the rate/frequency assertions (n large enough that a per-engine
 *  citation rate is a real signal). Deterministic, so these are not statistical flakes — they are
 *  fixed facts about this simulator. */
const BIG_CORPUS = Array.from({ length: 300 }, (_, i) => `sim probe query ${i}`);

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const pct = (xs: number[], q: number) => sorted(xs)[Math.floor(q * (xs.length - 1))];

function drivers(): { dfs: SimulatedSearchProvider; semrush: SimulatedSearchProvider; ahrefs: SimulatedSearchProvider } {
  const [dfs, semrush, ahrefs] = createSimulationProviders() as SimulatedSearchProvider[];
  return { dfs, semrush, ahrefs };
}

// ─────────────────────────────────────── capability honesty (no DB) ─────────────────────────────────

describe("SM-33 createSimulationProviders — one driver per vendor, capabilities its real vendor has", () => {
  it("registers exactly the three vendor keys, each marked as a simulator", () => {
    const providers = createSimulationProviders();
    expect(providers.map((p) => p.key)).toEqual(["dataforseo", "semrush", "ahrefs"]);
    expect(SIMULATED_PROVIDER_KEYS).toEqual(["dataforseo", "semrush", "ahrefs"]);
    for (const p of providers) expect(isSimulatedProvider(p)).toBe(true);
  });

  it("does NOT mark a real driver as simulated — provenance is opt-in, so an unmarked driver is real", () => {
    // This is what main.ts's boot-time mutual-exclusion assertion relies on (addendum §A4.3).
    expect(isSimulatedProvider(new MockSearchProvider())).toBe(false);
    expect(isSimulatedProvider(null)).toBe(false);
    expect(isSimulatedProvider(undefined)).toBe(false);
  });

  it("advertises per-vendor capability sets, NOT a can-do-everything superset", () => {
    const { dfs, semrush, ahrefs } = drivers();
    const caps = (p: SearchDataProvider) => [...p.capabilities].sort();

    expect(caps(dfs)).toEqual(
      ["ai_visibility", "backlinks", "competitors", "difficulty", "serp", "suggestions", "volume"],
    );
    expect(caps(semrush)).toEqual(["backlinks", "competitors", "difficulty", "serp", "volume"]);
    expect(caps(ahrefs)).toEqual(["backlinks", "competitors", "difficulty", "serp", "volume"]);

    // The asymmetries that make capability-routing bugs visible in dev (addendum §A2): only
    // DataForSEO sells keyword suggestions and AI visibility.
    for (const cap of ["suggestions", "ai_visibility"] as Capability[]) {
      expect(semrush.capabilities.has(cap)).toBe(false);
      expect(ahrefs.capabilities.has(cap)).toBe(false);
      expect(dfs.capabilities.has(cap)).toBe(true);
    }
  });

  it("THROWS instead of inventing data for a capability the vendor does not sell", async () => {
    const { semrush, ahrefs } = drivers();
    // Unreachable through dispatch (the capability gate refuses first) — which is the point: if it
    // IS reached, a routing bug exists, and plausible data would hide it.
    await expect(semrush.getAiVisibility({ query: "crm" })).rejects.toThrow(/does not offer 'ai_visibility'/);
    await expect(ahrefs.getAiVisibility({ query: "crm" })).rejects.toThrow(/does not offer 'ai_visibility'/);
    expect(() => semrush.estimateCostUsd({ kind: "ai_visibility", query: "crm" })).toThrow(/not an advertised capability/);
    expect(() => ahrefs.estimateCostUsd({ kind: "suggestions", query: "crm" })).toThrow(/not an advertised capability/);
  });

  it("only the suggestions-capable vendor returns a suggestions array", async () => {
    const { dfs, semrush, ahrefs } = drivers();
    const q = [{ keyword: "coffee grinder" }];
    expect((await dfs.getKeywordMetrics(q))[0].suggestions?.length).toBeGreaterThanOrEqual(5);
    expect((await semrush.getKeywordMetrics(q))[0].suggestions).toBeUndefined();
    expect((await ahrefs.getKeywordMetrics(q))[0].suggestions).toBeUndefined();
  });
});

// ─────────────────────────────────── deterministic + believable (no DB) ─────────────────────────────

describe("SM-33 determinism — same query ⇒ same output, forever (addendum §A4.6)", () => {
  it("two independently constructed drivers return byte-identical payloads", async () => {
    const a = drivers();
    const b = drivers();
    const kws = CORPUS.slice(0, 12).map((keyword) => ({ keyword }));

    expect(await b.dfs.getKeywordMetrics(kws)).toEqual(await a.dfs.getKeywordMetrics(kws));
    expect(await b.semrush.getKeywordMetrics(kws)).toEqual(await a.semrush.getKeywordMetrics(kws));
    expect(await b.ahrefs.getBacklinkSummary("gaiada.com")).toEqual(await a.ahrefs.getBacklinkSummary("gaiada.com"));
    expect(await b.dfs.getAiVisibility({ query: "best crm software" }))
      .toEqual(await a.dfs.getAiVisibility({ query: "best crm software" }));

    const serpA = await a.dfs.fetchSerpResults(await a.dfs.postSerpTasks([{ keyword: "best crm software" }]));
    const serpB = await b.dfs.fetchSerpResults(await b.dfs.postSerpTasks([{ keyword: "best crm software" }]));
    expect(serpB).toEqual(serpA);
    // Task ids too: a fixture or a screenshot taken from a demo stays valid across restarts.
    expect((await b.dfs.postSerpTasks([{ keyword: "crm" }]))[0].id)
      .toBe((await a.dfs.postSerpTasks([{ keyword: "crm" }]))[0].id);
  });

  it("the MARKET is part of the seed — the same keyword in another locale is a different market", () => {
    const us = simulateMarket("running shoes", "en-US", 2840);
    const id = simulateMarket("running shoes", "id-ID", 2360);
    expect(id.volume).not.toBe(us.volume);
    // ...but still the same keyword's intent, which is a property of the words, not the market.
    expect(id.intent).toBe(us.intent);
  });
});

describe("SM-33 the data is NOT flat — the properties a demo viewer would miss", () => {
  const markets = CORPUS.map((k) => simulateMarket(k));
  const volumes = markets.map((m) => m.volume);

  it("volumes vary widely instead of being a constant (mock-provider returns 1200 for everything)", () => {
    expect(new Set(volumes).size).toBeGreaterThanOrEqual(Math.ceil(CORPUS.length * 0.5));
    expect(Math.min(...volumes)).toBeLessThan(200);
    expect(Math.max(...volumes)).toBeGreaterThan(20_000);
  });

  it("follows a LONG-TAIL distribution: most keywords small, a few very large", () => {
    const median = pct(volumes, 0.5);
    // Right-skewed: the mean is dragged far above the median by the head terms.
    expect(mean(volumes)).toBeGreaterThan(median * 2);
    expect(Math.max(...volumes)).toBeGreaterThan(median * 20);
    // ...and the bulk really is small: the bottom half sits below ~1k/mo.
    expect(median).toBeLessThan(2_000);
  });

  it("volume falls as the phrase gets longer (the actual head/long-tail relationship)", () => {
    const head = mean(markets.filter((m) => m.wordCount <= 2).map((m) => m.volume));
    const tail = mean(markets.filter((m) => m.wordCount >= 5).map((m) => m.volume));
    expect(head).toBeGreaterThan(tail * 5);
  });

  it("CPC tracks COMMERCIAL INTENT, not word count", () => {
    const cpcFor = (intent: string) => mean(markets.filter((m) => m.intent === intent).map((m) => m.cpcUsd));
    expect(cpcFor("transactional")).toBeGreaterThan(cpcFor("commercial"));
    expect(cpcFor("commercial")).toBeGreaterThan(cpcFor("informational"));
    expect(cpcFor("transactional")).toBeGreaterThan(cpcFor("informational") * 2);
    expect(cpcFor("informational")).toBeGreaterThan(cpcFor("navigational"));
  });

  it("classifies intent from the query's own tokens (a rule, not a hash — a demo must not mislabel)", () => {
    expect(classifyIntent("buy running shoes")).toBe("transactional");
    expect(classifyIntent("cheapest flight to bali")).toBe("transactional");
    expect(classifyIntent("plumber near me")).toBe("transactional");
    expect(classifyIntent("best crm software")).toBe("commercial");
    expect(classifyIntent("ahrefs vs semrush")).toBe("commercial");
    expect(classifyIntent("how to do seo")).toBe("informational");
    expect(classifyIntent("what is a canonical tag")).toBe("informational");
    expect(classifyIntent("hubspot login")).toBe("navigational");
  });

  it("difficulty tracks volume and stays inside 1-100", () => {
    const byVolume = [...markets].sort((a, b) => a.volume - b.volume);
    const q = Math.floor(byVolume.length / 4);
    const lowKd = mean(byVolume.slice(0, q).map((m) => m.difficulty));
    const highKd = mean(byVolume.slice(-q).map((m) => m.difficulty));
    expect(highKd).toBeGreaterThan(lowKd + 15);
    for (const m of markets) {
      expect(m.difficulty).toBeGreaterThanOrEqual(1);
      expect(m.difficulty).toBeLessThanOrEqual(100);
    }
  });
});

describe("SM-33 the three vendors DISAGREE slightly — the deliberate feature", () => {
  it("volumes differ per vendor on most keywords, but stay within the same order of magnitude", async () => {
    const { dfs, semrush, ahrefs } = drivers();
    const kws = CORPUS.map((keyword) => ({ keyword }));
    const [a, b, c] = [await dfs.getKeywordMetrics(kws), await semrush.getKeywordMetrics(kws), await ahrefs.getKeywordMetrics(kws)];

    let disagreements = 0;
    for (let i = 0; i < kws.length; i++) {
      const base = a[i].volume!;
      for (const other of [b[i].volume!, c[i].volume!]) {
        const ratio = other / base;
        expect(ratio).toBeGreaterThan(0.6);
        expect(ratio).toBeLessThan(1.7);
        if (other !== base) disagreements += 1;
      }
      // Semrush/Ahrefs report integer KD; DataForSEO Labs reports a decimal. Two vendors formatting
      // the same metric differently is normal, and a consumer assuming otherwise is a bug.
      expect(Number.isInteger(b[i].difficulty!)).toBe(true);
      expect(Number.isInteger(c[i].difficulty!)).toBe(true);
    }
    // Not "always different" (rounded volumes legitimately coincide), but mostly different.
    expect(disagreements).toBeGreaterThan(kws.length);
  });

  it("Ahrefs reports the biggest link index and DataForSEO the smallest, for the same domain", async () => {
    const { dfs, semrush, ahrefs } = drivers();
    const target = "gaiada.com";
    const [a, s, h] = [await dfs.getBacklinkSummary(target), await semrush.getBacklinkSummary(target), await ahrefs.getBacklinkSummary(target)];
    expect(h.backlinks).toBeGreaterThan(s.backlinks);
    expect(s.backlinks).toBeGreaterThan(a.backlinks);
    // Same domain, so the three must still be describing the same site.
    expect(h.backlinks / a.backlinks).toBeLessThan(4);
  });
});

describe("SM-33 SERP synthesis", () => {
  it("returns a stable ten-row page with unique hosts, plausible URLs and titles", async () => {
    const { dfs } = drivers();
    const [serp] = await dfs.fetchSerpResults(await dfs.postSerpTasks([{ keyword: "best crm software" }]));

    expect(serp.items).toHaveLength(10);
    expect(serp.items.map((i) => i.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const hosts = serp.items.map((i) => new URL(i.url).host);
    expect(new Set(hosts).size).toBe(10); // no domain ranking twice — the giveaway of a generated page
    for (const item of serp.items) {
      expect(item.url.startsWith("https://")).toBe(true);
      expect(item.title!.length).toBeGreaterThan(10);
      // No stuttering titles ("Best Best Crm Software") on an already-superlative keyword.
      expect(item.title!.toLowerCase()).not.toMatch(/\bbest best\b/);
    }
    // Well-known sites keep their own URL shapes rather than /keyword-slug.
    const wiki = serp.items.find((i) => i.url.includes("wikipedia.org"));
    if (wiki) expect(wiki.url).toContain("/wiki/");
  });

  it("SERP features vary with intent — an AI overview is not on every page nor on none", () => {
    const informational = BIG_CORPUS.map((q) => `what is ${q}`);
    const transactional = BIG_CORPUS.map((q) => `buy ${q}`);
    const { dfs } = drivers();
    const rate = async (queries: string[], feature: string) => {
      const results = await dfs.fetchSerpResults(await dfs.postSerpTasks(queries.map((keyword) => ({ keyword }))));
      return results.filter((r) => r.serpFeatures?.[feature]).length / results.length;
    };
    return Promise.all([rate(informational, "ai_overview"), rate(transactional, "shopping"), rate(informational, "shopping")])
      .then(([aiOnInfo, shoppingOnTx, shoppingOnInfo]) => {
        expect(aiOnInfo).toBeGreaterThan(0.4);
        expect(aiOnInfo).toBeLessThan(0.85);
        expect(shoppingOnTx).toBeGreaterThan(shoppingOnInfo * 3);
      });
  });

  it("each vendor reports only the feature set its own product carries", async () => {
    const { dfs, semrush } = drivers();
    const [d] = await dfs.fetchSerpResults(await dfs.postSerpTasks([{ keyword: "coffee grinder" }]));
    const [s] = await semrush.fetchSerpResults(await semrush.postSerpTasks([{ keyword: "coffee grinder" }]));
    expect(Object.keys(d.serpFeatures!)).toContain("image_pack");
    expect(Object.keys(s.serpFeatures!)).not.toContain("image_pack");
    for (const v of Object.values(s.serpFeatures!)) expect(typeof v).toBe("boolean");
  });

  it("vendors mostly agree on WHO ranks and disagree on the ORDER (as real snapshots do)", async () => {
    const { dfs, semrush } = drivers();
    let reordered = 0;
    for (const keyword of CORPUS.slice(0, 12)) {
      const [a] = await dfs.fetchSerpResults(await dfs.postSerpTasks([{ keyword }]));
      const [b] = await semrush.fetchSerpResults(await semrush.postSerpTasks([{ keyword }]));
      const hostsA = a.items.map((i) => new URL(i.url).host);
      const hostsB = b.items.map((i) => new URL(i.url).host);
      expect(hostsA.filter((h) => hostsB.includes(h)).length).toBeGreaterThanOrEqual(6);
      if (hostsA.join() !== hostsB.join()) reordered += 1;
    }
    expect(reordered).toBeGreaterThan(6);
  });
});

// ── SM-48 (tracker §6s) — the platform-level portfolio-domain fold-in that fixes the "always null"
// rank-tracking gap: SM-33's simulated SERP had no knowledge of ANY tenant's tracked property, so a
// real rank-pull (SM-14) always returned `position: null`. Fixed as a config-wide, tenant-agnostic
// domain list folded into the SAME candidate pool and scored by the SAME shared+vendor formula every
// other candidate uses — deliberately NOT a per-call injection of a tenant's property domain (that
// would leak into `search_data_cache`'s shared, no-RLS rows — D-4). Positions below were computed by
// independently re-implementing hash32/unit/serpFor's scoring in a throwaway script against this
// exact corpus and vendor profile, then pinned here — so a change to the scoring, the candidate pool,
// or the fold-in itself is caught by an exact-value regression, not a vibe assertion.
describe("SM-48 platform-level portfolio domain folded into the simulated SERP", () => {
  const PORTFOLIO_DOMAIN = "balibeach.test";

  afterEach(() => {
    config.search.simulation.portfolioDomains = [];
  });

  it("unset (the default) is genuinely empty, and the SERP pool is byte-identical to before SM-48", async () => {
    expect(config.search.simulation.portfolioDomains).toEqual([]);
    const { dfs } = drivers();
    const [serp] = await dfs.fetchSerpResults(await dfs.postSerpTasks([{ keyword: "seo" }]));
    expect(serp.items.some((i) => new URL(i.url).host === PORTFOLIO_DOMAIN)).toBe(false);
  });

  it("configuring the domain makes it rank at a stable, reproducible position — deterministic like every other candidate", async () => {
    config.search.simulation.portfolioDomains = [PORTFOLIO_DOMAIN];
    const { dfs } = drivers();
    const [serp] = await dfs.fetchSerpResults(await dfs.postSerpTasks([{ keyword: "seo" }]));
    const hit = serp.items.find((i) => new URL(i.url).host === PORTFOLIO_DOMAIN);
    expect(hit?.position).toBe(4);

    // Same output from an independently constructed driver (addendum §A4.6's determinism guarantee
    // extends to the portfolio domain — it is not special-cased out of it).
    const { dfs: dfs2 } = drivers();
    const [serp2] = await dfs2.fetchSerpResults(await dfs2.postSerpTasks([{ keyword: "seo" }]));
    expect(serp2).toEqual(serp);
  });

  it("does NOT always rank first, and legitimately fails to rank at all on some keywords", async () => {
    config.search.simulation.portfolioDomains = [PORTFOLIO_DOMAIN];
    const { dfs } = drivers();
    const posOf = (r: { items: Array<{ url: string; position: number }> }) =>
      r.items.find((i) => new URL(i.url).host === PORTFOLIO_DOMAIN)?.position ?? null;

    const [top1] = await dfs.fetchSerpResults(await dfs.postSerpTasks([{ keyword: "enterprise seo platform pricing" }]));
    const [mid] = await dfs.fetchSerpResults(await dfs.postSerpTasks([{ keyword: "seo" }]));
    const [absent] = await dfs.fetchSerpResults(await dfs.postSerpTasks([{ keyword: "crm" }]));
    expect(posOf(top1)).toBe(1);
    expect(posOf(mid)).toBe(4);
    // 0034's own documented "not found in this SERP" — a real state the UI must still be able to show,
    // per the ticket's own requirement that "not ranking" stays reachable.
    expect(posOf(absent)).toBeNull();

    // Across the full corpus, BOTH outcomes occur, and the ranked positions are not all the same —
    // a portfolio domain that always/never ranks would be exactly as undemonstrable as SM-33's gap.
    const results = await Promise.all(
      CORPUS.map(async (keyword) => posOf((await dfs.fetchSerpResults(await dfs.postSerpTasks([{ keyword }])))[0])),
    );
    expect(results.some((p) => p !== null)).toBe(true);
    expect(results.some((p) => p === null)).toBe(true);
    expect(new Set(results.filter((p): p is number => p !== null)).size).toBeGreaterThan(1);
  });

  it("scored by the SAME shared+vendor formula as every other candidate — pinning an absence, not just a presence", async () => {
    // If the domain were special-cased (unconditionally inserted, exempted from the pool-size slice,
    // or given its own always-wins score) this keyword — one where plain scoring puts it outside the
    // top 10 — would rank it anyway. It must not.
    config.search.simulation.portfolioDomains = [PORTFOLIO_DOMAIN];
    const { dfs } = drivers();
    const [serp] = await dfs.fetchSerpResults(await dfs.postSerpTasks([{ keyword: "coffee grinder review" }]));
    expect(serp.items.some((i) => new URL(i.url).host === PORTFOLIO_DOMAIN)).toBe(false);
  });

  // ⚡ QA gate, 2026-07-30 — adversarial: config.ts only trims/lower-cases the raw env value, it does
  // NOT strip a scheme/www/trailing-slash the way rank.ts's normalizeDomain (the thing that actually
  // matches a property against a SERP) does. Before the simulation.ts-side fix, a portfolio entry of
  // "https://balibeach.test" produced serpUrl() = "https://https://balibeach.test/..." — a hostname of
  // literally "https" — so a pasted-URL misconfiguration silently made the tracked property unrankable
  // with no error anywhere. Pinned here as a same-position equivalence: a scheme/www/slash-decorated
  // entry must rank IDENTICALLY to the bare-domain form, on the same keyword.
  it("a scheme/www/trailing-slash-decorated portfolio entry normalizes to the same domain and ranks identically to the bare form", async () => {
    config.search.simulation.portfolioDomains = [PORTFOLIO_DOMAIN];
    const { dfs: bareDriver } = drivers();
    const [bareSerp] = await bareDriver.fetchSerpResults(await bareDriver.postSerpTasks([{ keyword: "seo" }]));
    const barePos = bareSerp.items.find((i) => new URL(i.url).host === PORTFOLIO_DOMAIN)?.position;
    expect(barePos).toBe(4); // matches the pinned value above — sanity that this run is comparable

    for (const decorated of ["https://balibeach.test", "https://www.balibeach.test/", "http://balibeach.test/some/path"]) {
      config.search.simulation.portfolioDomains = [decorated];
      const { dfs } = drivers();
      const [serp] = await dfs.fetchSerpResults(await dfs.postSerpTasks([{ keyword: "seo" }]));
      const hit = serp.items.find((i) => new URL(i.url).host === PORTFOLIO_DOMAIN);
      expect(hit?.position, `decorated entry '${decorated}' should rank identically to the bare domain`).toBe(barePos);
      // And the decorated string itself must never survive into a rendered URL/host — proves the
      // normalization actually stripped it rather than merely finding a lucky match.
      expect(serp.items.some((i) => i.url.includes("https://https://") || i.url.includes("http://http://"))).toBe(false);
    }
  });

  // ⚡ QA gate, 2026-07-30 — adversarial: the ticket's own comment calls a duplicate domain in one SERP
  // "the obviously fake artifact" the design avoids. Configuring a portfolio domain that DUPLICATES a
  // domain already in the built-in pool (EVERGREEN_DOMAINS) must not produce two rows for the same
  // host — the pre-existing `new Set(...)` fold is what protects this, pinned directly here so a future
  // refactor that reorders/removes that Set can't silently reintroduce a duplicate SERP row.
  it("a portfolio domain duplicating an existing pool domain never appears twice in one SERP", async () => {
    config.search.simulation.portfolioDomains = ["en.wikipedia.org", "en.wikipedia.org"]; // also self-duplicated
    const { dfs } = drivers();
    const [serp] = await dfs.fetchSerpResults(await dfs.postSerpTasks([{ keyword: "seo" }]));
    const hosts = serp.items.map((i) => new URL(i.url).host);
    expect(hosts.filter((h) => h === "en.wikipedia.org")).toHaveLength(hosts.includes("en.wikipedia.org") ? 1 : 0);
    expect(new Set(hosts).size).toBe(hosts.length); // no duplicate host anywhere in the SERP, full stop
  });
});

describe("SM-33 backlink profiles are scaled to the DOMAIN", () => {
  it("a mega-domain dwarfs a small business site, and the numbers stay internally consistent", () => {
    const wiki = simulateBacklinks("https://en.wikipedia.org/wiki/SEO");
    const small = simulateBacklinks("my-tiny-local-plumber.info");
    expect(wiki.refDomains).toBeGreaterThan(500_000);
    expect(wiki.refDomains).toBeGreaterThan(small.refDomains * 1000);
    expect(wiki.authorityScore).toBeGreaterThan(small.authorityScore + 25);
    for (const b of [wiki, small]) {
      expect(b.backlinks).toBeGreaterThanOrEqual(b.refDomains); // never fewer links than domains
      expect(b.authorityScore).toBeGreaterThanOrEqual(1);
      expect(b.authorityScore).toBeLessThanOrEqual(100);
    }
    // The URL was normalized to a registrable domain, so a URL and its host seed identically.
    expect(simulateBacklinks("en.wikipedia.org").refDomains).toBe(wiki.refDomains);
  });

  it("TLD matters in aggregate — institutional domains out-link junk ones", () => {
    const forTld = (tld: string) =>
      mean(BIG_CORPUS.slice(0, 60).map((_, i) => simulateBacklinks(`probe-site-${i}.${tld}`).refDomains));
    expect(forTld("gov")).toBeGreaterThan(forTld("com"));
    expect(forTld("com")).toBeGreaterThan(forTld("xyz"));
  });
});

describe("SM-33 AI-visibility synthesis (GEO pillar)", () => {
  it("covers exactly the engines the schema accepts, and never contradicts itself", async () => {
    const { dfs } = drivers();
    const rows = await dfs.getAiVisibility({ query: "best crm software" });
    expect(rows.map((r) => r.engine)).toEqual([...AI_ENGINES]);
    // The CHECK constraint on search_ai_visibility.engine (0034) — a simulator whose output cannot
    // be persisted is worse than none.
    expect([...AI_ENGINES]).toEqual(["chatgpt", "google_ai_overview", "gemini", "claude", "perplexity"]);
    for (const r of rows) {
      if (r.cited) {
        expect(r.brandMentioned).toBe(true); // cannot be cited without being mentioned
        expect(r.citedUrl).toBeTruthy();
      } else {
        expect(r.citedUrl).toBeUndefined();
      }
      expect(r.prominence!).toBeGreaterThanOrEqual(0);
      expect(r.prominence!).toBeLessThanOrEqual(1);
    }
  });

  it("citation state VARIES BY ENGINE — the per-engine comparison is the whole GEO surface", async () => {
    const { dfs } = drivers();
    const rows = await Promise.all(BIG_CORPUS.map((query) => dfs.getAiVisibility({ query })));
    const rateFor = (engine: string, field: "brandMentioned" | "cited") =>
      rows.filter((r) => r.find((x) => x.engine === engine)![field]).length / rows.length;

    // Perplexity cites nearly everything it mentions; Claude links least. Deterministic corpus, so
    // these are fixed properties, not a sampling accident.
    expect(rateFor("perplexity", "brandMentioned")).toBeGreaterThan(rateFor("claude", "brandMentioned"));
    expect(rateFor("perplexity", "cited")).toBeGreaterThan(rateFor("claude", "cited") * 1.5);
    // ...and no engine is stuck at always/never, which is what a flat stub would produce.
    for (const engine of AI_ENGINES) {
      expect(rateFor(engine, "brandMentioned")).toBeGreaterThan(0.2);
      expect(rateFor(engine, "brandMentioned")).toBeLessThan(0.85);
    }
  });

  it("an explicitly requested engine is the only one answered", async () => {
    const { dfs } = drivers();
    const rows = await dfs.getAiVisibility({ query: "aeo vs seo", engine: "perplexity" });
    expect(rows).toHaveLength(1);
    expect(rows[0].engine).toBe("perplexity");
  });
});

// ───────────────────────────── pricing: the REAL rate tables (addendum §A4.5) ────────────────────────

describe("SM-33 pricing comes from the live drivers' own rate tables", () => {
  const placeholderSemrushRate = 499.95 / 300_000;
  const placeholderAhrefsRate = 500 / 1_000_000;

  it("dataforseo-sim estimateCostUsd EQUALS DFS_RATES arithmetic for every op kind (§A6-A3 AC)", () => {
    const { dfs } = drivers();
    const est = (op: ProviderOp) => dfs.estimateCostUsd(op);
    expect(est({ kind: "serp", query: "x", items: 10 })).toBeCloseTo(DFS_RATES.serpStandardPerTask * 10, 12);
    expect(est({ kind: "volume", query: "x", items: 50 }))
      .toBeCloseTo(DFS_RATES.keywordsDataPerTask + DFS_RATES.keywordsDataPerKeyword * 50, 12);
    expect(est({ kind: "suggestions", query: "x", items: 50 }))
      .toBeCloseTo(DFS_RATES.labsPerTask + DFS_RATES.labsPerItem * 50, 12);
    expect(est({ kind: "backlinks", query: "x" })).toBeCloseTo(DFS_RATES.backlinksSummary, 12);
    expect(est({ kind: "ai_visibility", query: "x", items: 10 }))
      .toBeCloseTo(DFS_RATES.serpStandardPerTask * 10, 12);
  });

  // SM-46e (SM-44b's own defect finding): the queue-aware branch in estimateFor was UNPINNED — the
  // parity test above only asserts the Standard rate, so deleting the `config.search.dataforseo.queue
  // === "live"` conditional entirely (always pricing at Standard) left the suite green. Every guard in
  // this module has mutation-tested its own defect; this proves the branch both directions.
  it("dataforseo-sim prices serp/ai_visibility at the LIVE queue rate when config.search.dataforseo.queue is 'live' (SM-44b)", () => {
    const { dfs } = drivers();
    const prevQueue = config.search.dataforseo.queue;
    try {
      config.search.dataforseo.queue = "live";
      expect(dfs.estimateCostUsd({ kind: "serp", query: "x", items: 10 }))
        .toBeCloseTo(DFS_RATES.serpLivePerTask * 10, 12);
      expect(dfs.estimateCostUsd({ kind: "ai_visibility", query: "x", items: 10 }))
        .toBeCloseTo(DFS_RATES.serpLivePerTask * 10, 12);
    } finally {
      config.search.dataforseo.queue = prevQueue;
    }
    // ...and restored to Standard once the queue flips back — the parity test's own baseline.
    expect(dfs.estimateCostUsd({ kind: "serp", query: "x", items: 10 }))
      .toBeCloseTo(DFS_RATES.serpStandardPerTask * 10, 12);
    expect(dfs.estimateCostUsd({ kind: "ai_visibility", query: "x", items: 10 }))
      .toBeCloseTo(DFS_RATES.serpStandardPerTask * 10, 12);
  });

  it("prepaid vendors price units × the amortized rate, using the SAME unit tables as the live drivers", () => {
    const { semrush, ahrefs } = drivers();
    expect(semrush.estimateCostUsd({ kind: "volume", query: "x", items: 20 })).toBeCloseTo(
      (SEMRUSH_RATES.keywordOverviewUnitsPerLine + SEMRUSH_RATES.keywordDifficultyUnitsPerLine) * 20 * placeholderSemrushRate,
      12,
    );
    expect(semrush.estimateCostUsd({ kind: "backlinks", query: "x" })).toBeCloseTo(
      SEMRUSH_RATES.backlinksUnitsPerLine * placeholderSemrushRate, 12,
    );
    expect(ahrefs.estimateCostUsd({ kind: "backlinks", query: "x", items: 3 })).toBeCloseTo(
      (AHREFS_RATES.backlinksStatsBaseUnits + AHREFS_RATES.domainRatingBaseUnits) * 3 * placeholderAhrefsRate, 12,
    );
    // Ahrefs' SERP Overview is confirmed FREE upstream: the simulator reproduces that rather than
    // inventing a plausible-looking price, because the demo's job is to predict staging.
    expect(AHREFS_RATES.serpOverviewUnits).toBe(0);
    expect(ahrefs.estimateCostUsd({ kind: "serp", query: "x", items: 10 })).toBe(0);
  });

  it("a configured plan rate REPLACES the placeholder (so a demo prices like the real account will)", () => {
    const { semrush } = drivers();
    const before = semrush.estimateCostUsd({ kind: "serp", query: "x", items: 10 });
    config.search.semrush.monthlyPlanPriceUsd = 1_000;
    config.search.semrush.monthlyUnitAllowance = 100_000; // => $0.01/unit, ~6x the placeholder
    try {
      expect(semrush.estimateCostUsd({ kind: "serp", query: "x", items: 10 }))
        .toBeCloseTo(SEMRUSH_RATES.serpUnitsPerLine * 10 * 0.01, 12);
      expect(semrush.estimateCostUsd({ kind: "serp", query: "x", items: 10 })).toBeGreaterThan(before);
    } finally {
      config.search.semrush.monthlyPlanPriceUsd = 0;
      config.search.semrush.monthlyUnitAllowance = 0;
    }
  });

  it("estimates are pure, synchronous, deterministic and scale with items", () => {
    const { dfs, semrush } = drivers();
    for (const p of [dfs, semrush]) {
      const one = p.estimateCostUsd({ kind: "backlinks", query: "gaiada.com" });
      expect(p.estimateCostUsd({ kind: "backlinks", query: "gaiada.com" })).toBe(one);
      expect(p.estimateCostUsd({ kind: "backlinks", query: "gaiada.com", items: 4 })).toBeCloseTo(one * 4, 12);
      expect(one).toBeGreaterThan(0); // never $0 by accident for a billed op
      expect(p.dispatchCount).toBe(0); // pricing touched no "network"
    }
  });
});

// ───────────────── mode plumbing on the pure surfaces (projection + mode read) ───────────────────────

describe("SM-33 provenance on the cost-projection surface (what SM-38 badges)", () => {
  afterEach(() => {
    resetProviders();
    config.search.providerMode = "live";
  });

  it("reports the platform mode and flags each tool priced by a simulated driver", () => {
    resetProviders();
    for (const p of createSimulationProviders()) registerProvider(p);
    config.search.providerMode = "simulate";

    const projection = projectMonthlyCost({ rank: { enabled: true, cadence: "daily", maxKeywords: 20 } });
    expect(projection.providerMode).toBe("simulate");
    expect(providerMode()).toBe("simulate");
    for (const tool of projection.perTool) expect(tool.simulated).toBe(true);
    // The price tags are still real arithmetic from the real rate table.
    const rank = projection.perTool.find((t) => t.tool === "rank")!;
    expect(rank.costPerRunUsd).toBeCloseTo(DFS_RATES.serpStandardPerTask * 20, 6);
  });

  it("live mode with a real driver reports simulated=false everywhere (mode off ⇒ today's answer)", () => {
    resetProviders();
    registerProvider(new MockSearchProvider());
    config.search.providerMode = "live";

    const projection = projectMonthlyCost({ rank: { enabled: true, cadence: "daily", maxKeywords: 100 } });
    expect(projection.providerMode).toBe("live");
    for (const tool of projection.perTool) expect(tool.simulated).toBe(false);
    expect(projection.perTool.find((t) => t.tool === "rank")!.projectedMonthlyUsd).toBeCloseTo(1.8, 4);
  });

  it("a simulated driver registered while the mode says live is STILL flagged (provenance follows the driver)", () => {
    // main.ts makes this combination a boot error (§A4.3). If it ever happens anyway, the badge must
    // describe the bytes, not the config — under-labelling synthetic data is the expensive failure.
    resetProviders();
    for (const p of createSimulationProviders()) registerProvider(p);
    config.search.providerMode = "live";
    const projection = projectMonthlyCost({ rank: { enabled: true } });
    expect(projection.providerMode).toBe("live");
    expect(projection.perTool.find((t) => t.tool === "rank")!.simulated).toBe(true);
  });
});

// ─────────────────────────────────── integration (live Postgres) ────────────────────────────────────

describe.skipIf(!TEST_URL)("SM-33 simulation through the REAL dispatch choke-point (live Postgres)", () => {
  let tenant: string;
  let userId: string;
  let clientId: string;
  let propertyId: string;
  let sims: SimulatedSearchProvider[];

  const ALL_TOOLS = {
    rank: { enabled: true },
    volume: { enabled: true },
    suggestions: { enabled: true },
    backlinks: { enabled: true },
    ai_visibility: { enabled: true },
  };

  async function makeEngagement(toolScope: Record<string, unknown>, budgetUsd = 10): Promise<string> {
    const id = newId();
    await withTenants(
      [tenant],
      (c) => c.query(
        `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active')`,
        [id, tenant, clientId, propertyId, "SM-33 engagement", JSON.stringify(toolScope), budgetUsd],
      ),
      { modules: ["search"] },
    );
    return id;
  }

  async function ledgerRows(engagementId: string) {
    const r = await withTenants(
      [tenant],
      (c) => c.query<{ endpoint: string; cost_usd: string; status: string; cache_hit: boolean; simulated: boolean }>(
        `SELECT endpoint, cost_usd, status, cache_hit, simulated FROM search_provider_calls
          WHERE engagement_id = $1 ORDER BY created_at, id`,
        [engagementId],
      ),
      { modules: ["search"] },
    );
    return r.rows;
  }

  async function cacheRows(cacheKey: string) {
    const r = await withGlobal((c) => c.query<{ cache_key: string; provider: string; simulated: boolean; payload: unknown }>(
      `SELECT cache_key, provider, simulated, payload FROM search_data_cache WHERE cache_key = $1`,
      [cacheKey],
    ));
    return r.rows;
  }

  /** Insert a ledger row directly, so a MIXED table (real + simulated rows) can be set up without
   *  having to flip modes mid-test. */
  async function seedLedgerRow(engagementId: string, costUsd: number, simulated: boolean): Promise<void> {
    await withTenants(
      [tenant],
      (c) => insertLedgerRow(c, {
        tenantId: tenant, engagementId, provider: "dataforseo", endpoint: "seed.volume",
        items: 1, costUsd, cacheHit: false, status: "completed", requestedBy: userId, simulated,
      }),
      { modules: ["search"] },
    );
  }

  let seq = 0;
  const uniqueKeyword = (label: string) => `sm33-${label}-${Date.now()}-${seq++}`;

  beforeAll(async () => {
    await initTestDb();
    tenant = await createCompany("SM-33 Simulation Co", ["search"]);
    userId = await createUser("sm33@simulation.test");
    clientId = await createClient(tenant, "SM-33 Client");
    propertyId = newId();
    await withTenants(
      [tenant],
      (c) => c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url) VALUES ($1,$2,$3,$4,$5)`,
        [propertyId, tenant, clientId, "sm33.example.com", "https://sm33.example.com"],
      ),
      { modules: ["search"] },
    );
  });

  afterAll(async () => {
    resetProviders();
    config.search.providerMode = "live";
    await teardownTestDb();
  });

  beforeEach(() => {
    resetProviders();
    sims = createSimulationProviders() as SimulatedSearchProvider[];
    for (const p of sims) registerProvider(p);
    config.search.providerMode = "simulate";
    config.search.tenantMonthlyCapUsd = null;
    config.search.globalMonthlyCapUsd = 1_000_000;
    config.search.budgetWarnRatio = 0.8;
    resetGlobalMonthToDateCache();
  });

  afterEach(() => {
    config.search.providerMode = "live";
  });

  // ── AC: mode on, keyless ⇒ all five op kinds return shaped data, every row flagged ────────────────
  it("all FIVE op kinds dispatch, return shaped data, and are flagged simulated on ledger AND cache", async () => {
    const eng = await makeEngagement(ALL_TOOLS, 1000);
    // SM-36 (design addendum §A2): the platform default is now per-CAPABILITY, not one vendor for
    // every op kind — serp/suggestions/ai_visibility route to DataForSEO, volume to Semrush,
    // backlinks to Ahrefs (all three registered here). dfs.dispatchCount alone is no longer "every
    // op kind dispatched" — the SUM across all three simulated drivers is.
    const dfs = sims.find((s) => s.key === "dataforseo")!;
    const semrush = sims.find((s) => s.key === "semrush")!;
    const ahrefs = sims.find((s) => s.key === "ahrefs")!;

    const ops: ProviderOp[] = [
      { kind: "serp", query: uniqueKeyword("serp") },
      { kind: "volume", query: uniqueKeyword("volume") },
      { kind: "suggestions", query: uniqueKeyword("sugg") },
      { kind: "backlinks", query: `${uniqueKeyword("bl")}.com` },
      { kind: "ai_visibility", query: uniqueKeyword("geo") },
    ];

    for (const op of ops) {
      const res = await dispatchProviderOp({
        tenantId: tenant, engagementId: eng, propertyId, op, requestedBy: userId,
      });
      expect(res.cacheHit).toBe(false);
      expect(res.simulated).toBe(true);
      expect(res.costUsd).toBeGreaterThanOrEqual(0);
      expect(res.payload).toBeTruthy();
      // ...and the payload is really shaped data, not an empty envelope.
      const shape = Array.isArray(res.payload) ? res.payload[0] : res.payload;
      expect(Object.keys(shape as object).length).toBeGreaterThan(1);

      const rows = await cacheRows(buildCacheKey(res.provider, op));
      expect(rows).toHaveLength(1);
      expect(rows[0].simulated).toBe(true);
    }

    // Every op kind dispatched exactly once, SOMEWHERE — proven per-provider (pinning §A2's actual
    // routing) rather than just a bare total, so a capability-routing regression is caught here too.
    expect(dfs.dispatchCount).toBe(3); // serp + suggestions + ai_visibility
    expect(semrush.dispatchCount).toBe(1); // volume
    expect(ahrefs.dispatchCount).toBe(1); // backlinks
    expect(dfs.dispatchCount + semrush.dispatchCount + ahrefs.dispatchCount).toBe(5);
    const rows = await ledgerRows(eng);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.simulated).toBe(true);
    expect(rows.filter((r) => Number(r.cost_usd) > 0).length).toBeGreaterThanOrEqual(4);
  });

  it("capability routing still refuses: ai_visibility routed to Ahrefs is refused, not silently answered", async () => {
    const eng = await makeEngagement({ ...ALL_TOOLS, provider: { ai_visibility: "ahrefs" } }, 1000);
    await expect(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "ai_visibility", query: uniqueKeyword("route") },
      requestedBy: userId,
    })).rejects.toThrow(/capability 'ai_visibility'/);
    for (const s of sims) expect(s.dispatchCount).toBe(0);
  });

  it("single-flight holds for a simulated driver too: 8 identical concurrent pulls dispatch ONCE", async () => {
    const eng = await makeEngagement(ALL_TOOLS, 1000);
    const op: ProviderOp = { kind: "volume", query: uniqueKeyword("stampede") };
    // SM-36: 'volume' resolves to Semrush by default (§A2), not DataForSEO — the provider actually
    // billed for this op kind, so it is the one whose call counter proves single-flight.
    const semrush = sims.find((s) => s.key === "semrush")!;
    semrush.delayMs = 120;

    const results = await Promise.all(
      Array.from({ length: 8 }, () => dispatchProviderOp({ tenantId: tenant, engagementId: eng, op, requestedBy: userId })),
    );
    expect(semrush.dispatchCount).toBe(1);
    expect(results.filter((r) => !r.cacheHit)).toHaveLength(1);
    for (const r of results) expect(r.simulated).toBe(true);
  });

  // ── AC: a budget cap still refuses a SIMULATED pull ───────────────────────────────────────────────
  it("a budget cap REFUSES a simulated pull — synthetic dollars still hit the stop-loss", async () => {
    const eng = await makeEngagement(ALL_TOOLS, 0.001); // dfs-sim backlinks = $0.02
    const err = await dispatchProviderOp({
      tenantId: tenant, engagementId: eng, propertyId,
      op: { kind: "backlinks", query: `${uniqueKeyword("budget")}.com` }, requestedBy: userId,
    }).catch((e: Error) => e);

    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).tier).toBe("engagement");
    for (const s of sims) expect(s.dispatchCount).toBe(0);

    // The refusal is auditable AND flagged, so a demo's blocked row is never read as a real refusal.
    const rows = await ledgerRows(eng);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].endpoint).toMatch(/budget_blocked$/);
    expect(rows[0].simulated).toBe(true);
  });

  it("a scope refusal in simulate mode is flagged too (the toggle gate runs before provider resolution)", async () => {
    const eng = await makeEngagement({ volume: { enabled: true } }); // 'rank' absent => serp off
    await expect(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword("scope") }, requestedBy: userId,
    })).rejects.toThrow(/enable the 'rank' tool/);
    const rows = await ledgerRows(eng);
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint).toBe("serp.scope_disabled");
    expect(rows[0].simulated).toBe(true);
  });

  // ── AC (addendum §A4.1): budgets are MODE-FILTERED, proven on a MIXED table ───────────────────────
  it("month-to-date sums are mode-filtered on a MIXED table — each mode sees only its own rows", async () => {
    const eng = await makeEngagement(ALL_TOOLS, 1000);
    await seedLedgerRow(eng, 7, false); // a REAL row (as every pre-0047 row is)
    await seedLedgerRow(eng, 3, false);
    await seedLedgerRow(eng, 100, true); // a SIMULATED row

    const live = await withTenants([tenant], (c) => sumMonthToDate(c, eng, false), { modules: ["search"] });
    const sim = await withTenants([tenant], (c) => sumMonthToDate(c, eng, true), { modules: ["search"] });

    // The fail-open shape this forecloses is live mode DROPPING real rows: assert the real total
    // exactly, not merely "less than everything".
    expect(live).toBeCloseTo(10, 6);
    expect(sim).toBeCloseTo(100, 6);
    // Default = live: an un-migrated caller keeps its old meaning (real rows only).
    expect(await withTenants([tenant], (c) => sumMonthToDate(c, eng), { modules: ["search"] })).toBeCloseTo(10, 6);

    // Same for the platform-wide ceiling, whose aggregate is the one with the ratified allowlist
    // entry — and whose TTL cache must therefore be keyed per mode, or a flip would serve the
    // other mode's total for up to 30s.
    resetGlobalMonthToDateCache();
    const globalLive = await sumGlobalMonthToDate(false);
    const globalSim = await sumGlobalMonthToDate(true);
    expect(globalLive).toBeGreaterThanOrEqual(10);
    expect(globalSim).toBeGreaterThanOrEqual(100);
    expect(globalSim).not.toBe(globalLive);
  });

  it("real spend does not bind a SIMULATED pull, and simulated spend does not bind a REAL one", async () => {
    // The consequence that matters operationally: a month of demo history must not refuse real
    // clients, and a real month's spend must not silently make the demo's stop-loss unreachable.
    const engA = await makeEngagement(ALL_TOOLS, 1); // cap $1
    await seedLedgerRow(engA, 0.999, false); // REAL spend has all but exhausted the cap
    const simPull = await dispatchProviderOp({
      tenantId: tenant, engagementId: engA, op: { kind: "backlinks", query: `${uniqueKeyword("simfree")}.com` },
      requestedBy: userId,
    });
    expect(simPull.simulated).toBe(true);
    expect(simPull.cacheHit).toBe(false); // proceeded: simulated budget was empty

    const engB = await makeEngagement(ALL_TOOLS, 1);
    await seedLedgerRow(engB, 0.999, true); // SIMULATED spend has all but exhausted the cap
    config.search.providerMode = "live";
    resetProviders();
    const real = new MockSearchProvider();
    registerProvider(real);
    const realPull = await dispatchProviderOp({
      tenantId: tenant, engagementId: engB, op: { kind: "backlinks", query: `${uniqueKeyword("realfree")}.com` },
      requestedBy: userId,
    });
    expect(realPull.simulated).toBe(false);
    expect(realPull.cacheHit).toBe(false); // proceeded: real budget was empty
    expect(real.dispatchCount).toBe(1);
  });

  it("the simulated budget still binds simulated spend — the stop-loss demo is real arithmetic", async () => {
    const eng = await makeEngagement(ALL_TOOLS, 1);
    await seedLedgerRow(eng, 0.99, true); // simulated spend, close to the $1 cap
    await expect(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "backlinks", query: `${uniqueKeyword("simcap")}.com` },
      requestedBy: userId,
    })).rejects.toThrowError(BudgetExceededError); // $0.02 more would breach
  });

  // ── AC (addendum §A4.2): cache reads are mode-filtered, SYMMETRICALLY ─────────────────────────────
  it("at the cache layer: a row written in one mode is INVISIBLE to a read in the other, both ways", async () => {
    const simKey = `sm33-cache-sim-${Date.now()}`;
    const liveKey = `sm33-cache-live-${Date.now()}`;
    await withGlobal(async (c) => {
      await writeCache(c, simKey, "volume", { v: "synthetic" }, "dataforseo", 0.5, true);
      await writeCache(c, liveKey, "volume", { v: "real" }, "dataforseo", 0.5, false);

      expect(await readFreshCache(c, simKey, true)).not.toBeNull();
      expect(await readFreshCache(c, simKey, false)).toBeNull(); // a live read cannot see it
      expect(await readFreshCache(c, liveKey, false)).not.toBeNull();
      expect(await readFreshCache(c, liveKey, true)).toBeNull(); // nor can a simulate read see a real row
    });
  });

  it("an overwrite across modes moves payload AND flag together — provenance can never mismatch payload", async () => {
    const key = `sm33-cache-flip-${Date.now()}`;
    await withGlobal(async (c) => {
      await writeCache(c, key, "volume", { v: "synthetic" }, "dataforseo", 0.5, true);
      await writeCache(c, key, "volume", { v: "real" }, "dataforseo", 0.7, false);

      const asLive = await readFreshCache(c, key, false);
      expect(asLive?.payload).toEqual({ v: "real" });
      expect(asLive?.simulated).toBe(false);
      expect(await readFreshCache(c, key, true)).toBeNull(); // the synthetic row is gone, not stale
      const rows = await cacheRows(key);
      expect(rows).toHaveLength(1); // PK is cache_key alone: one row per market coordinate
    });
  });

  it("END TO END: a simulated cache row is NOT served after a flip to live, and vice versa", async () => {
    // The ticket's headline AC. Write in simulate mode, flip to live (registering a real driver, as
    // main.ts's mutual exclusion would), and prove the second pull is a real dispatch — not a hit on
    // yesterday's invented numbers — then flip back and prove the symmetry. Uses 'serp' rather than
    // 'volume': SM-36's platform preference for 'serp' is a length-1 ['dataforseo'] list (§A2 — no
    // fallback), so the SAME provider (and therefore the SAME cache key) resolves in every mode this
    // test flips through, which is what makes "the same coordinate is invisible across the flip" an
    // honest test of the MODE PREDICATE rather than an artifact of two different keys.
    const eng = await makeEngagement(ALL_TOOLS, 1000);
    const op: ProviderOp = { kind: "serp", query: uniqueKeyword("modeflip") };
    const key = buildCacheKey("dataforseo", op);
    const dfs = sims.find((s) => s.key === "dataforseo")!;

    const first = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, op, requestedBy: userId });
    expect(first.simulated).toBe(true);
    expect(first.cacheHit).toBe(false);
    // A second simulate-mode pull IS a hit, so the cache is genuinely working in this mode...
    const second = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, op, requestedBy: userId });
    expect(second.cacheHit).toBe(true);
    expect(second.simulated).toBe(true);
    expect(dfs.dispatchCount).toBe(1);

    // ...now flip to live with a real driver registered.
    config.search.providerMode = "live";
    resetProviders();
    const real = new MockSearchProvider();
    registerProvider(real);

    const afterFlip = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, op, requestedBy: userId });
    expect(afterFlip.cacheHit).toBe(false); // the simulated row was NOT served
    expect(afterFlip.simulated).toBe(false);
    expect(real.dispatchCount).toBe(1); // a real pull actually happened
    expect(afterFlip.payload).not.toEqual(first.payload);
    let rows = await cacheRows(key);
    expect(rows).toHaveLength(1);
    expect(rows[0].simulated).toBe(false);

    // And symmetrically: back in simulate mode the REAL row is invisible too.
    config.search.providerMode = "simulate";
    resetProviders();
    const sim2 = createSimulationProviders() as SimulatedSearchProvider[];
    for (const p of sim2) registerProvider(p);
    const sim2Dfs = sim2.find((s) => s.key === "dataforseo")!;
    const backAgain = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, op, requestedBy: userId });
    expect(backAgain.cacheHit).toBe(false);
    expect(backAgain.simulated).toBe(true);
    expect(sim2Dfs.dispatchCount).toBe(1);
    rows = await cacheRows(key);
    expect(rows[0].simulated).toBe(true);

    // Every ledger row along the way is labelled with the provenance of the data it describes.
    const ledger = await ledgerRows(eng);
    expect(ledger.map((r) => r.simulated)).toEqual([true, true, false, true]);
  });

  // ── AC: mode OFF ⇒ today's behaviour ─────────────────────────────────────────────────────────────
  it("mode off ⇒ nothing is flagged and the cache key is the pre-SM-33 string", async () => {
    config.search.providerMode = "live";
    resetProviders();
    const real = new MockSearchProvider();
    registerProvider(real);

    const eng = await makeEngagement(ALL_TOOLS, 1000);
    const op: ProviderOp = { kind: "volume", query: uniqueKeyword("liveplain"), locale: "id-ID" };
    const res = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, op, requestedBy: userId });

    expect(res.simulated).toBe(false);
    // The key format is unchanged by SM-33 (mode is a row predicate, not a key component) — pinned
    // literally, because a key change would silently invalidate every existing cached row.
    const key = buildCacheKey("dataforseo", op);
    expect(key).toBe(`volume|dataforseo|${op.query}|_|id-ID|_`);
    const rows = await cacheRows(key);
    expect(rows).toHaveLength(1);
    expect(rows[0].simulated).toBe(false);
    expect((await ledgerRows(eng)).every((r) => r.simulated === false)).toBe(true);
  });
});
