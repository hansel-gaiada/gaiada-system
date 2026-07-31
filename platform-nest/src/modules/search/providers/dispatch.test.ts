// SM-04 — the money-safety proofs for the provider dispatch choke-point (design §05/§12).
//
// The AC this file discharges, verbatim from design §12 SM-04:
//   "Unit+integration: scope-disabled capability refused naming the toggle; cache hit logs cost 0;
//    concurrent identical queries dispatch once; budget breach refuses + emits event; ledger sums
//    match dispatched costs"
// plus the true-up path (§05: posted -> completed with the actual cost, never a second row) and the
// audited `search:provider:admin` override.
//
// These run against LIVE Postgres (initTestDb) because the guarantees under test are DB guarantees:
// the single-flight property is produced by pg advisory locks inside one transaction, and the ledger
// sums are what the stop-loss actually reads. Mocking the DB here would test nothing.
//
// Isolation note: `search_data_cache` is deliberately no-RLS and cross-tenant shared (D-4), so it is
// GLOBAL state across tests. Every test therefore uses a unique keyword (so its cache key is unique)
// and the cache-hit test seeds its own key explicitly. Never assume the table is empty.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { config, computeProviderReservationCapUsd } from "../../../config";
import { newId, withTenants } from "../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, createClient } from "../../../testing/fixtures";
import { MockSearchProvider } from "./mock-provider";
import { AhrefsProvider } from "./ahrefs";
import { registerProvider, resetProviders, resolveProvider } from "./registry";
import { dispatchProviderOp, evaluateBudget, projectMonthlyCost } from "./dispatch";
import { ON_DEMAND_ESTIMATE_RUNS_PER_MONTH } from "../cadence";
import { resetProviderMonthToDateCache, sumMonthToDate, trueUpLedger } from "./ledger";
// Namespace import so the global-ceiling failure path can be forced with a spy (dispatch.ts calls
// through the module object once SWC transpiles the ESM import).
import * as ledger from "./ledger";
import { buildCacheKey } from "./cache";
import {
  BudgetExceededError,
  GlobalCeilingUnavailableError,
  NoCapableProviderError,
  PillarDisabledError,
  ProviderCeilingUnavailableError,
  ProviderDispatchError,
  ScopeDisabledError,
  type Capability,
  type ProviderOp,
  type SearchDataProvider,
} from "./types";

// ─────────────────────────────────────────────── pure units (no DB) ─────────────────────────────────

describe("SM-04 evaluateBudget — the ordered stop-loss arithmetic", () => {
  // providerCap defaults to null (tier skipped) so every PRE-EXISTING test below is unaffected by
  // the SM-40 tier's insertion — it exercises the provider tier explicitly in its own describe block.
  const base = {
    estimate: 1, engagementCap: 100, engagementMtd: 0,
    tenantCap: 100 as number | null, tenantMtd: 0,
    providerCap: null as number | null, providerMtd: 0,
    globalCap: 100, globalMtd: 0,
  };

  it("passes when every tier has headroom", () => {
    expect(evaluateBudget(base).breach).toBeUndefined();
  });

  // Regression pin for the QA gate's NaN-cap finding (tracker §6r) — pinning the property that is
  // actually true here, which is NOT what the finding first suggested.
  //
  // A NaN cap cannot be defended inside this function. Entering a NaN tier and skipping it are
  // behaviourally IDENTICAL: `projected > NaN` is false and `projected >= ratio * NaN` is false, so
  // either way the tier yields no breach and no warning. My first attempt at a pin here asserted
  // "some other tier still catches it", which passes with or without the guard — a test that tests
  // nothing, the very thing three gates in this module have caught elsewhere. It is recorded rather
  // than quietly deleted, because the mistake is instructive: a malformed cap is a CONFIG defect,
  // and no amount of arithmetic downstream can distinguish "no cap set" from "cap I could not read".
  // The enforcement therefore lives at the parse site (config.ts's moneyEnv throws at boot).
  //
  // What IS pinnable here: a non-finite cap must never leak into a warning payload, because a
  // warning quoting "$NaN" would be shown to an operator.
  it("a non-finite cap never leaks into a warning payload (an operator must never be shown $NaN)", () => {
    const decision = evaluateBudget({ ...base, providerCap: Number.NaN, estimate: 1_000_000_000 });
    expect(decision.warnings.every((w) => Number.isFinite(w.cap))).toBe(true);
  });

  it("documents the residual: with EVERY cap non-finite, nothing breaches — which is why config must refuse to boot on one", () => {
    // Not a defect in this function: a cap it cannot interpret is indistinguishable from a cap that
    // was never set, and `null` (never set) is correctly a skip. The hazard is entirely upstream —
    // an operator who typed a ceiling and got none. config.ts's moneyEnv() is what closes it.
    const allNaN = {
      ...base, estimate: 1_000_000_000,
      engagementCap: Number.NaN, tenantCap: Number.NaN,
      providerCap: Number.NaN, globalCap: Number.NaN,
    };
    expect(evaluateBudget(allNaN).breach).toBeUndefined();
  });

  it("breaches the ENGAGEMENT tier first even when tenant/provider/global would also breach", () => {
    const d = evaluateBudget({
      ...base, engagementMtd: 100, tenantMtd: 100, providerCap: 100, providerMtd: 100, globalMtd: 100,
    });
    expect(d.breach?.tier).toBe("engagement");
  });

  it("falls through tenant -> provider -> global, in that order (SM-40 inserts provider between tenant and global)", () => {
    expect(evaluateBudget({ ...base, tenantMtd: 100, globalMtd: 100 }).breach?.tier).toBe("tenant");
    expect(
      evaluateBudget({ ...base, providerCap: 100, providerMtd: 100, globalMtd: 100 }).breach?.tier,
    ).toBe("provider");
    expect(evaluateBudget({ ...base, globalMtd: 100 }).breach?.tier).toBe("global");
  });

  it("skips a tier with a null cap rather than treating it as zero", () => {
    expect(evaluateBudget({ ...base, tenantCap: null, tenantMtd: 1e9 }).breach).toBeUndefined();
    // SM-40: an unconfigured provider cap (the default) must never itself refuse a dispatch, no
    // matter how large the provider month-to-date figure would be.
    expect(evaluateBudget({ ...base, providerCap: null, providerMtd: 1e9 }).breach).toBeUndefined();
  });

  it("is a > comparison: landing exactly ON the cap is allowed, one cent over is not", () => {
    expect(evaluateBudget({ ...base, engagementMtd: 99 }).breach).toBeUndefined();
    expect(evaluateBudget({ ...base, engagementMtd: 99.01 }).breach?.tier).toBe("engagement");
  });

  it("warns at the configured ratio without breaching", () => {
    const d = evaluateBudget({ ...base, engagementMtd: 85 });
    expect(d.breach).toBeUndefined();
    expect(d.warnings.map((w) => w.tier)).toContain("engagement");
  });

  // ── SM-40: the PROVIDER tier specifically ──────────────────────────────────────────────────────
  it("breaches the PROVIDER tier ahead of global when both would breach", () => {
    const d = evaluateBudget({
      ...base, providerCap: 10, providerMtd: 10, globalCap: 10, globalMtd: 10,
    });
    expect(d.breach?.tier).toBe("provider");
  });

  it("the provider tier is a > comparison, same as every other tier", () => {
    expect(evaluateBudget({ ...base, providerCap: 100, providerMtd: 99 }).breach).toBeUndefined();
    expect(evaluateBudget({ ...base, providerCap: 100, providerMtd: 99.01 }).breach?.tier).toBe("provider");
  });

  it("the provider tier warns at the configured ratio without breaching", () => {
    const d = evaluateBudget({ ...base, providerCap: 100, providerMtd: 85 });
    expect(d.breach).toBeUndefined();
    expect(d.warnings.map((w) => w.tier)).toContain("provider");
  });
});

describe("SM-40 computeProviderReservationCapUsd — the amortization arithmetic (config.ts, §A3.5)", () => {
  it("is the plan price times the reservation fraction — the amortized-USD reserved share", () => {
    expect(computeProviderReservationCapUsd(500, 0.5)).toBeCloseTo(250, 9);
    expect(computeProviderReservationCapUsd(549, 0.5)).toBeCloseTo(274.5, 9);
    expect(computeProviderReservationCapUsd(500, 0.25)).toBeCloseTo(125, 9);
    expect(computeProviderReservationCapUsd(500, 1)).toBeCloseTo(500, 9); // a 100% reservation is legal, if ever ratified
  });

  it("a non-positive plan price means NO plan fact configured => null (tier SKIPPED), never 0 (tier ALWAYS BREACHED)", () => {
    // This is the load-bearing distinction: 0 would mean "every dispatch to this vendor is over
    // cap", which is the opposite of the unset-cap-skips-tier convention every other tier honors.
    expect(computeProviderReservationCapUsd(0, 0.5)).toBeNull();
    expect(computeProviderReservationCapUsd(-500, 0.5)).toBeNull();
  });
});

describe("SM-04 projectMonthlyCost — the estimateCostUsd projection (SM-29's price tags)", () => {
  beforeEach(() => {
    resetProviders();
    registerProvider(new MockSearchProvider());
  });

  it("prices only ENABLED toggles; a disabled tool projects $0 but still reports its unit cost", () => {
    const { perTool, totalMonthlyUsd } = projectMonthlyCost({
      rank: { enabled: true, cadence: "weekly", maxKeywords: 100 },
      volume: { enabled: false, maxKeywords: 100 },
    });
    const rank = perTool.find((t) => t.tool === "rank")!;
    const volume = perTool.find((t) => t.tool === "volume")!;

    expect(rank.enabled).toBe(true);
    expect(rank.itemsPerRun).toBe(100);
    expect(rank.runsPerMonth).toBeCloseTo(30 / 7, 3);
    // mock serp rate 0.0006/item x 100 items = 0.06/run
    expect(rank.costPerRunUsd).toBeCloseTo(0.06, 6);
    expect(rank.projectedMonthlyUsd).toBeCloseTo(0.06 * (30 / 7), 5);

    expect(volume.projectedMonthlyUsd).toBe(0);
    expect(volume.costPerRunUsd).toBeGreaterThan(0); // the price is shown even while switched off
    expect(totalMonthlyUsd).toBeCloseTo(rank.projectedMonthlyUsd, 6);
  });

  it("covers all five paid toggles and totals them", () => {
    const { perTool } = projectMonthlyCost({});
    expect(perTool.map((t) => t.tool).sort()).toEqual(
      ["ai_visibility", "backlinks", "rank", "suggestions", "volume"],
    );
  });

  it("degrades to a note instead of throwing when no provider can price a tool", () => {
    resetProviders();
    const { perTool, totalMonthlyUsd } = projectMonthlyCost({ rank: { enabled: true, cadence: "daily" } });
    const rank = perTool.find((t) => t.tool === "rank")!;
    expect(rank.note).toMatch(/no provider available/i);
    expect(rank.costPerRunUsd).toBe(0);
    expect(totalMonthlyUsd).toBe(0);
  });

  it("uses the SAME estimator the choke-point bills with — projection can never undercut dispatch", () => {
    const op: ProviderOp = { kind: "serp", query: "x", items: 50 };
    const viaProvider = resolveProvider({}, "serp").estimateCostUsd(op);
    const viaProjection = projectMonthlyCost({ rank: { enabled: true, cadence: "monthly", maxKeywords: 50 } })
      .perTool.find((t) => t.tool === "rank")!.costPerRunUsd;
    expect(viaProjection).toBeCloseTo(viaProvider, 9);
  });

  // ── SM-61 (tracker §6au Ruling 1, clauses 1+3) ────────────────────────────────────────────────
  describe("SM-61 · `scheduled` + the no-default cadence parse", () => {
    it("an enabled tool with an EXPLICIT real cadence, in SCHEDULED_TOOLS, is scheduled:true", () => {
      const { perTool } = projectMonthlyCost({ rank: { enabled: true, cadence: "weekly" } });
      expect(perTool.find((t) => t.tool === "rank")!.scheduled).toBe(true);
    });

    it("REQUIRED PROBE 1 (§6au): an enabled tool with NO cadence is scheduled:false and prices at the on-demand estimate — never the weekly-conservative figure the superseded SM-54 spec clause would have used", () => {
      const { perTool } = projectMonthlyCost({ rank: { enabled: true } });
      const rank = perTool.find((t) => t.tool === "rank")!;
      expect(rank.scheduled).toBe(false);
      expect(rank.cadence).toBeNull();
      expect(rank.runsPerMonth).toBeCloseTo(ON_DEMAND_ESTIMATE_RUNS_PER_MONTH, 6);
      // The property a "treat null as weekly" mutation would break: runsPerMonth must NOT be ~4.29.
      expect(rank.runsPerMonth).not.toBeCloseTo(30 / 7, 1);
    });

    it("junk cadence parses to on-demand (scheduled:false), never to a guessed schedule", () => {
      const { perTool } = projectMonthlyCost({ rank: { enabled: true, cadence: "fortnightly" } });
      const rank = perTool.find((t) => t.tool === "rank")!;
      expect(rank.scheduled).toBe(false);
      expect(rank.cadence).toBeNull();
      expect(rank.runsPerMonth).toBeCloseTo(ON_DEMAND_ESTIMATE_RUNS_PER_MONTH, 6);
    });

    it("a DISABLED tool is never scheduled regardless of cadence", () => {
      const { perTool } = projectMonthlyCost({ rank: { enabled: false, cadence: "daily" } });
      expect(perTool.find((t) => t.tool === "rank")!.scheduled).toBe(false);
    });

    it("'suggestions' can NEVER be scheduled:true — it has no scheduled flow, even with enabled+a real cadence set", () => {
      const { perTool } = projectMonthlyCost({ suggestions: { enabled: true, cadence: "daily" } });
      const suggestions = perTool.find((t) => t.tool === "suggestions")!;
      expect(suggestions.enabled).toBe(true);
      expect(suggestions.cadence).toBe("daily");
      expect(suggestions.scheduled).toBe(false); // not in SCHEDULED_TOOLS — the whole point of clause 3
    });

    it("PRICE-REGRESSION PIN (§6au, REQUIRED PROBE 2): volume WITH cadence:'monthly' prices identically to the pre-SM-61 shape (enabled, no cadence)", () => {
      const before = projectMonthlyCost({ volume: { enabled: true, maxKeywords: 50 } });
      const after = projectMonthlyCost({ volume: { enabled: true, cadence: "monthly", maxKeywords: 50 } });
      const b = before.perTool.find((t) => t.tool === "volume")!;
      const a = after.perTool.find((t) => t.tool === "volume")!;
      expect(a.runsPerMonth).toBe(b.runsPerMonth); // both 1
      expect(a.costPerRunUsd).toBeCloseTo(b.costPerRunUsd, 9);
      expect(a.projectedMonthlyUsd).toBeCloseTo(b.projectedMonthlyUsd, 9);
      // The only thing that's allowed to change is the LABEL, never the number.
      expect(b.scheduled).toBe(false);
      expect(a.scheduled).toBe(true);
    });
  });
});

describe("SM-04 resolveProvider — fail-closed selection", () => {
  beforeEach(() => resetProviders());

  it("refuses when nothing is registered (no phantom-provider dispatch)", () => {
    expect(() => resolveProvider({}, "serp")).toThrow(ProviderDispatchError);
  });

  it("refuses an explicitly-selected provider that lacks the capability, rather than silently substituting", () => {
    class SerpOnly extends MockSearchProvider {
      readonly capabilities = new Set<Capability>(["serp"]);
    }
    registerProvider(new SerpOnly() as SearchDataProvider);
    expect(resolveProvider({}, "serp").key).toBe("dataforseo");
    expect(() => resolveProvider({}, "backlinks")).toThrow(NoCapableProviderError);
  });

  it("honors a per-tool override over the default", () => {
    const mock = new MockSearchProvider();
    registerProvider(mock);
    expect(() => resolveProvider({ provider: { serp: "semrush" } }, "serp"))
      .toThrow(/'semrush' is not registered/);
  });
});

// ─────────────────────────────────────────── integration (live PG) ──────────────────────────────────

describe.skipIf(!TEST_URL)("SM-04 dispatch choke-point (live Postgres)", () => {
  let tenant: string;
  let userId: string;
  let clientId: string;
  let propertyId: string;
  let provider: MockSearchProvider;

  /** A fresh engagement with the given tool_scope + budget, so each test owns its spend window. */
  async function makeEngagement(toolScope: Record<string, unknown>, budgetUsd = 10): Promise<string> {
    const id = newId();
    await withTenants(
      [tenant],
      (c) => c.query(
        `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active')`,
        [id, tenant, clientId, propertyId, "SM-04 engagement", JSON.stringify(toolScope), budgetUsd],
      ),
      { modules: ["search"] },
    );
    return id;
  }

  async function ledgerRows(engagementId: string) {
    const r = await withTenants(
      [tenant],
      (c) => c.query<{ id: string; endpoint: string; items: number; cost_usd: string; cache_hit: boolean; status: string }>(
        `SELECT id, endpoint, items, cost_usd, cache_hit, status FROM search_provider_calls
          WHERE engagement_id = $1 ORDER BY created_at, id`,
        [engagementId],
      ),
      { modules: ["search"] },
    );
    return r.rows;
  }

  async function budgetEvents(engagementId: string) {
    const r = await withTenants(
      [tenant],
      (c) => c.query<{ event_type: string; payload: Record<string, unknown> }>(
        `SELECT event_type, payload FROM outbox_events
          WHERE entity_id = $1 AND event_type = 'search.provider.budget_threshold' ORDER BY created_at`,
        [engagementId],
      ),
      { modules: ["search"] },
    );
    return r.rows;
  }

  /** Unique per call so each test gets its own cache key in the globally-shared no-RLS cache. */
  let kwSeq = 0;
  const uniqueKeyword = (label: string) => `sm04-${label}-${Date.now()}-${kwSeq++}`;

  beforeAll(async () => {
    await initTestDb();
    tenant = await createCompany("SM-04 Provider Co", ["search"]);
    userId = await createUser("sm04@provider.test");
    clientId = await createClient(tenant, "SM-04 Client");
    propertyId = newId();
    await withTenants(
      [tenant],
      (c) => c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url) VALUES ($1,$2,$3,$4,$5)`,
        [propertyId, tenant, clientId, "sm04.example.com", "https://sm04.example.com"],
      ),
      { modules: ["search"] },
    );
  });

  afterAll(async () => {
    resetProviders();
    await teardownTestDb();
  });

  beforeEach(() => {
    resetProviders();
    provider = new MockSearchProvider();
    registerProvider(provider);
    config.search.tenantMonthlyCapUsd = null;
    config.search.globalMonthlyCapUsd = 1_000_000;
    config.search.budgetWarnRatio = 0.8;
    // SM-40: every test starts with the provider tier SKIPPED for every vendor (matches
    // tenantMonthlyCapUsd's default-null convention) — a test that wants to exercise the tier sets
    // `config.search.providerMonthlyCapUsd.dataforseo` explicitly (MockSearchProvider's key).
    config.search.providerMonthlyCapUsd = { dataforseo: null, semrush: null, ahrefs: null, scraper: null };
    resetProviderMonthToDateCache();
  });

  // ── AC 1: scope-disabled refused, NAMING the toggle ───────────────────────────────────────────────
  it("refuses a scope-disabled capability naming the toggle, and never touches the provider", async () => {
    const eng = await makeEngagement({ volume: { enabled: true } }); // 'rank' absent => serp is off
    await expect(
      dispatchProviderOp({
        tenantId: tenant, engagementId: eng, propertyId,
        op: { kind: "serp", query: uniqueKeyword("scope") }, requestedBy: userId,
      }),
    ).rejects.toThrowError(ScopeDisabledError);

    expect(provider.dispatchCount).toBe(0); // no money, no network
    const rows = await ledgerRows(eng);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].endpoint).toBe("serp.scope_disabled");
    expect(Number(rows[0].cost_usd)).toBe(0);
  });

  it("names the toggle a human can act on, not the internal op kind", async () => {
    const eng = await makeEngagement({});
    const err = await dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword("toggle") },
      requestedBy: userId,
    }).catch((e: ScopeDisabledError) => e);
    expect(err).toBeInstanceOf(ScopeDisabledError);
    expect((err as ScopeDisabledError).toggle).toBe("rank"); // the tool_scope key, not "serp"
    expect((err as ScopeDisabledError).message).toContain("'rank'");
  });

  it("refuses on scope EVEN WHEN no provider is registered — scope is gate zero", async () => {
    // Regression guard: resolving the would-be-billed provider for the blocked ledger row must not
    // convert a ScopeDisabledError into an unknown_provider error.
    resetProviders();
    const eng = await makeEngagement({});
    const err = await dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword("noprov") },
      requestedBy: userId,
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ScopeDisabledError);
  });

  // ── SM-06: the pillar kill switch outranks everything ─────────────────────────────────────────────
  it("a disabled pillar refuses before scope, budget or provider are even consulted", async () => {
    const eng = await makeEngagement({ rank: { enabled: true } }, 1000); // scope ON, budget ample
    config.search.pillars.seo = false;
    try {
      const err = await dispatchProviderOp({
        tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword("pillar") },
        requestedBy: userId,
      }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(PillarDisabledError);
      expect((err as PillarDisabledError).pillar).toBe("seo");
      expect((err as Error).message).toContain("SEARCH_PILLAR_SEO=0");
      expect(provider.dispatchCount).toBe(0);
      // No ledger row: the capability does not exist right now — this client wasn't refused.
      expect(await ledgerRows(eng)).toHaveLength(0);
    } finally {
      config.search.pillars.seo = true;
    }
  });

  it("the pillars are independent — disabling SEO leaves GEO pulls working", async () => {
    const eng = await makeEngagement({ rank: { enabled: true }, ai_visibility: { enabled: true } }, 1000);
    config.search.pillars.seo = false;
    try {
      await expect(dispatchProviderOp({
        tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword("geo-seo") }, requestedBy: userId,
      })).rejects.toThrowError(PillarDisabledError);

      const geo = await dispatchProviderOp({
        tenantId: tenant, engagementId: eng, op: { kind: "ai_visibility", query: uniqueKeyword("geo-ok") }, requestedBy: userId,
      });
      expect(geo.cacheHit).toBe(false);
      expect(provider.dispatchCount).toBe(1);
    } finally {
      config.search.pillars.seo = true;
    }
  });

  // ── AC 2: cache hit logs cost 0 ───────────────────────────────────────────────────────────────────
  it("a cache hit costs 0, dispatches nothing, and is logged as a completed cache_hit row", async () => {
    const eng = await makeEngagement({ volume: { enabled: true } });
    const query = uniqueKeyword("cache");
    const op: ProviderOp = { kind: "volume", query };

    const first = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, op, requestedBy: userId });
    expect(first.cacheHit).toBe(false);
    expect(first.costUsd).toBeGreaterThan(0);
    expect(provider.dispatchCount).toBe(1);

    const second = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, op, requestedBy: userId });
    expect(second.cacheHit).toBe(true);
    expect(second.costUsd).toBe(0);
    expect(provider.dispatchCount).toBe(1); // unchanged — the second call never reached the provider
    expect(second.payload).toEqual(first.payload);

    const rows = await ledgerRows(eng);
    const hit = rows.find((r) => r.cache_hit)!;
    expect(hit.status).toBe("completed");
    expect(Number(hit.cost_usd)).toBe(0);
    expect(hit.endpoint).toMatch(/\.cache_hit$/);
  });

  it("the cache is shared across tenants — a second client pays $0 for market data the first bought", async () => {
    // This IS the cost model (D-4): the no-RLS cache is keyed on public market coordinates only.
    const otherTenant = await createCompany("SM-04 Other Co", ["search"]);
    const otherClient = await createClient(otherTenant, "Other Client");
    const otherProperty = newId();
    await withTenants(
      [otherTenant],
      (c) => c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url) VALUES ($1,$2,$3,$4,$5)`,
        [otherProperty, otherTenant, otherClient, "other.example.com", "https://other.example.com"],
      ),
      { modules: ["search"] },
    );
    const otherEng = newId();
    await withTenants(
      [otherTenant],
      (c) => c.query(
        `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status)
         VALUES ($1,$2,$3,$4,'Other engagement',$5,10,'active')`,
        [otherEng, otherTenant, otherClient, otherProperty, JSON.stringify({ volume: { enabled: true } })],
      ),
      { modules: ["search"] },
    );

    const eng = await makeEngagement({ volume: { enabled: true } });
    const op: ProviderOp = { kind: "volume", query: uniqueKeyword("shared") };
    await dispatchProviderOp({ tenantId: tenant, engagementId: eng, op, requestedBy: userId });
    expect(provider.dispatchCount).toBe(1);

    const cross = await dispatchProviderOp({ tenantId: otherTenant, engagementId: otherEng, op, requestedBy: userId });
    expect(cross.cacheHit).toBe(true);
    expect(cross.costUsd).toBe(0);
    expect(provider.dispatchCount).toBe(1);
  });

  it("bypassCache forces a real dispatch and writes no cache row (tracked-rank pulls)", async () => {
    const eng = await makeEngagement({ rank: { enabled: true } });
    const op: ProviderOp = { kind: "serp", query: uniqueKeyword("bypass") };

    const a = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, op, requestedBy: userId, bypassCache: true });
    const b = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, op, requestedBy: userId, bypassCache: true });
    expect(a.cacheHit).toBe(false);
    expect(b.cacheHit).toBe(false);
    expect(provider.dispatchCount).toBe(2); // both are live captures of the property's position

    // and nothing was cached, so a later cacheable call still misses
    const c = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, op, requestedBy: userId });
    expect(c.cacheHit).toBe(false);
  });

  // ── AC 3: concurrent identical queries dispatch exactly once ──────────────────────────────────────
  it("N concurrent identical queries dispatch EXACTLY ONCE; the losers all read the winner's row", async () => {
    const eng = await makeEngagement({ volume: { enabled: true } });
    const op: ProviderOp = { kind: "volume", query: uniqueKeyword("stampede") };
    provider.delayMs = 120; // hold the advisory-lock window open so all 8 genuinely race

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        dispatchProviderOp({ tenantId: tenant, engagementId: eng, op, requestedBy: userId })),
    );

    expect(provider.dispatchCount).toBe(1);
    expect(results.filter((r) => !r.cacheHit)).toHaveLength(1);
    expect(results.filter((r) => r.cacheHit)).toHaveLength(7);
    for (const r of results) expect(r.payload).toEqual(results[0].payload);
    // Exactly one billed row; the other seven are cost-0 hits.
    const rows = await ledgerRows(eng);
    expect(rows.filter((r) => Number(r.cost_usd) > 0)).toHaveLength(1);
    expect(rows.filter((r) => r.cache_hit)).toHaveLength(7);
  });

  it("concurrent DIFFERENT queries are not serialized into one dispatch", async () => {
    const eng = await makeEngagement({ volume: { enabled: true } });
    const queries = [uniqueKeyword("d1"), uniqueKeyword("d2"), uniqueKeyword("d3")];
    await Promise.all(queries.map((q) =>
      dispatchProviderOp({ tenantId: tenant, engagementId: eng, op: { kind: "volume", query: q }, requestedBy: userId })));
    expect(provider.dispatchCount).toBe(3);
  });

  it("the cache key ignores tenant identity but respects market coordinates", () => {
    const base: ProviderOp = { kind: "serp", query: "Running Shoes ", locale: "id-ID" };
    expect(buildCacheKey("dataforseo", base)).toBe(buildCacheKey("dataforseo", { ...base, query: "running shoes" }));
    expect(buildCacheKey("dataforseo", base)).not.toBe(buildCacheKey("dataforseo", { ...base, locale: "en-US" }));
    expect(buildCacheKey("dataforseo", base)).not.toBe(buildCacheKey("semrush", base));
  });

  // ── AC 4: budget breach refuses + emits ───────────────────────────────────────────────────────────
  it("an engagement budget breach refuses, emits a blocked threshold event, and records the blocked row", async () => {
    const eng = await makeEngagement({ backlinks: { enabled: true } }, 0.001); // mock backlinks = $0.02
    const err = await dispatchProviderOp({
      tenantId: tenant, engagementId: eng, propertyId,
      op: { kind: "backlinks", query: uniqueKeyword("budget") + ".com" }, requestedBy: userId,
    }).catch((e: Error) => e);

    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).tier).toBe("engagement");
    expect(provider.dispatchCount).toBe(0);

    const rows = await ledgerRows(eng);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].endpoint).toMatch(/budget_blocked$/);
    expect(Number(rows[0].cost_usd)).toBe(0);

    const events = await budgetEvents(eng);
    expect(events).toHaveLength(1);
    expect(events[0].payload.level).toBe("blocked");
    expect(events[0].payload.tier).toBe("engagement");
  });

  it("the TENANT ceiling refuses even when the engagement still has headroom", async () => {
    const eng = await makeEngagement({ backlinks: { enabled: true } }, 1000);
    config.search.tenantMonthlyCapUsd = 0.001;
    const err = await dispatchProviderOp({
      tenantId: tenant, engagementId: eng,
      op: { kind: "backlinks", query: uniqueKeyword("tenantcap") + ".com" }, requestedBy: userId,
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).tier).toBe("tenant");
    expect(provider.dispatchCount).toBe(0);
  });

  // ── SM-40 (design addendum §A3.5): the PROVIDER ceiling, end-to-end through dispatch ─────────────
  it("the PROVIDER ceiling refuses even when engagement AND tenant still have headroom", async () => {
    const eng = await makeEngagement({ backlinks: { enabled: true } }, 1000); // engagement cap huge
    // config.search.tenantMonthlyCapUsd stays null (skipped) from beforeEach. MockSearchProvider's
    // key is "dataforseo" (mock-provider.ts) — cap smaller than a SINGLE backlinks estimate ($0.02),
    // so this breaches on the DISPATCHED OP'S OWN estimate alone, deterministic regardless of any
    // other test's prior dataforseo spend in this file (same trick the TENANT ceiling test above
    // uses with tenantMonthlyCapUsd = 0.001).
    config.search.providerMonthlyCapUsd.dataforseo = 0.001;
    const err = await dispatchProviderOp({
      tenantId: tenant, engagementId: eng,
      op: { kind: "backlinks", query: uniqueKeyword("providercap") + ".com" }, requestedBy: userId,
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).tier).toBe("provider");
    expect(provider.dispatchCount).toBe(0);

    const rows = await ledgerRows(eng);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].endpoint).toMatch(/budget_blocked$/);
    expect(Number(rows[0].cost_usd)).toBe(0);

    const events = await budgetEvents(eng);
    expect(events).toHaveLength(1);
    expect(events[0].payload.tier).toBe("provider");
    expect(events[0].payload.level).toBe("blocked");
  });

  it("an UNCONFIGURED provider cap (null, the default) never itself refuses a dispatch — end-to-end skip", async () => {
    // Regression guard for the skip semantics, proven through the REAL dispatch path (not just the
    // pure evaluateBudget unit above): with the cap left null, sumProviderMonthToDate must never
    // even be ATTEMPTED (see the "mutation-probe" note in the ticket report) — a real dispatch must
    // succeed normally.
    const eng = await makeEngagement({ backlinks: { enabled: true } }, 1000);
    config.search.providerMonthlyCapUsd.dataforseo = null;
    const result = await dispatchProviderOp({
      tenantId: tenant, engagementId: eng,
      op: { kind: "backlinks", query: uniqueKeyword("providerskip") + ".com" }, requestedBy: userId,
    });
    expect(result.cacheHit).toBe(false);
    expect(provider.dispatchCount).toBe(1);
  });

  it("with an UNCONFIGURED provider cap, the sum is never even ATTEMPTED — a failing aggregate cannot refuse a tier nobody configured", async () => {
    // Distinguishes "the tier is skipped in evaluateBudget's arithmetic" (already proven above) from
    // "the cross-tenant sum is skipped BEFORE it can ever fail" — a stronger, separately-mutable
    // guard. If dispatch.ts always called sumProviderMonthToDate() regardless of the configured cap,
    // this test would fail: the mocked rejection would surface as ProviderCeilingUnavailableError
    // even though nobody asked this tier to be enforced.
    const eng = await makeEngagement({ backlinks: { enabled: true } }, 1000);
    config.search.providerMonthlyCapUsd.dataforseo = null; // explicit — the default from beforeEach
    const spy = vi
      .spyOn(ledger, "sumProviderMonthToDate")
      .mockRejectedValue(new Error("would refuse if this were ever called"));
    try {
      const result = await dispatchProviderOp({
        tenantId: tenant, engagementId: eng,
        op: { kind: "backlinks", query: uniqueKeyword("providerunattempted") + ".com" }, requestedBy: userId,
      });
      expect(result.cacheHit).toBe(false);
      expect(provider.dispatchCount).toBe(1);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("an uncomputable PROVIDER ceiling fails CLOSED rather than degrading to $0 month-to-date", async () => {
    // Regression guard for the SM-40 analogue of the §4d fail-open: a $0 provider month-to-date can
    // never breach, so any failure in the cross-tenant provider sum would silently disarm the ONE
    // tier standing between a misconfigured engagement and overrunning the humans' interactive share
    // of a shared paid subscription. The cap MUST be configured (non-null) for this test — an unset
    // cap skips the sum entirely (proven above), so this failure could never surface for it.
    const eng = await makeEngagement({ backlinks: { enabled: true } }, 1000);
    config.search.providerMonthlyCapUsd.dataforseo = 1_000_000; // headroom — only the COMPUTE fails
    const spy = vi
      .spyOn(ledger, "sumProviderMonthToDate")
      .mockRejectedValue(new Error("permission denied for table search_provider_calls"));
    try {
      const err = await dispatchProviderOp({
        tenantId: tenant, engagementId: eng, propertyId,
        op: { kind: "backlinks", query: uniqueKeyword("providerfail") + ".com" }, requestedBy: userId,
      }).catch((e: Error) => e);

      expect(err).toBeInstanceOf(ProviderCeilingUnavailableError);
      expect((err as ProviderCeilingUnavailableError).provider).toBe("dataforseo");
      expect(provider.dispatchCount).toBe(0); // refused before any spend

      const rows = await ledgerRows(eng);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("failed");
      expect(rows[0].endpoint).toMatch(/provider_ceiling_unavailable$/);
      expect(Number(rows[0].cost_usd)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("a SECONDARY failure recording the provider-ceiling refusal never masks ProviderCeilingUnavailableError", async () => {
    // Mirrors the analogous global-ceiling test: if the audit write ALSO throws (e.g. the same
    // fault that broke sumProviderMonthToDate is wide enough to break writes too), the caller must
    // still see the typed ProviderCeilingUnavailableError — never the recordBlocked failure.
    const eng = await makeEngagement({ backlinks: { enabled: true } }, 1000);
    config.search.providerMonthlyCapUsd.dataforseo = 1_000_000;
    const mtdSpy = vi
      .spyOn(ledger, "sumProviderMonthToDate")
      .mockRejectedValue(new Error("permission denied for table search_provider_calls"));
    const blockedSpy = vi
      .spyOn(ledger, "recordBlocked")
      .mockRejectedValue(new Error("permission denied for table search_provider_calls (insert)"));
    try {
      const err = await dispatchProviderOp({
        tenantId: tenant, engagementId: eng, propertyId,
        op: { kind: "backlinks", query: uniqueKeyword("providerfail-secondary") + ".com" }, requestedBy: userId,
      }).catch((e: Error) => e);

      expect(err).toBeInstanceOf(ProviderCeilingUnavailableError); // NOT the recordBlocked error
      expect(provider.dispatchCount).toBe(0);
    } finally {
      mtdSpy.mockRestore();
      blockedSpy.mockRestore();
    }
  });

  it("an uncomputable GLOBAL ceiling fails CLOSED rather than degrading to $0 month-to-date", async () => {
    // Regression guard for a fail-OPEN found at the SM-04 gate. sumGlobalMonthToDate() used to be
    // wrapped in a try/catch that set globalMtd = 0 on error — and a $0 month-to-date can never
    // breach, so any failure in that one cross-tenant aggregate silently removed the platform-wide
    // ceiling. On the default config that is the ONLY platform-wide tier (tenantMonthlyCapUsd is
    // optional and unset), so an enforced $150/mo cap became no cap at all. The realistic trigger is
    // a permission/logic failure in exactly the query whose lint-withtenants allowlist entry is the
    // most likely thing to be reworked — hence a permission error is what this simulates.
    const eng = await makeEngagement({ backlinks: { enabled: true } }, 1000);
    const spy = vi
      .spyOn(ledger, "sumGlobalMonthToDate")
      .mockRejectedValue(new Error("permission denied for table search_provider_calls"));
    try {
      const err = await dispatchProviderOp({
        tenantId: tenant, engagementId: eng, propertyId,
        op: { kind: "backlinks", query: uniqueKeyword("globalfail") + ".com" }, requestedBy: userId,
      }).catch((e: Error) => e);

      expect(err).toBeInstanceOf(GlobalCeilingUnavailableError);
      expect(provider.dispatchCount).toBe(0); // refused before any spend

      // Refusals are auditable: a cost-0 failed row naming the reason, not a silent proceed.
      const rows = await ledgerRows(eng);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("failed");
      expect(rows[0].endpoint).toMatch(/global_ceiling_unavailable$/);
      expect(Number(rows[0].cost_usd)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("a SECONDARY failure recording the global-ceiling refusal never masks GlobalCeilingUnavailableError (architect gate follow-up, 2026-07-29)", async () => {
    // dispatch.ts's global-ceiling catch block calls recordBlocked(...) to make the refusal
    // auditable. If THAT insert also throws (e.g. the same fault that broke sumGlobalMonthToDate
    // is wide enough to break writes too), the caller must still see the typed
    // GlobalCeilingUnavailableError — never the recordBlocked failure — so callers can keep relying
    // on `instanceof GlobalCeilingUnavailableError` to recognize this refusal.
    const eng = await makeEngagement({ backlinks: { enabled: true } }, 1000);
    const mtdSpy = vi
      .spyOn(ledger, "sumGlobalMonthToDate")
      .mockRejectedValue(new Error("permission denied for table search_provider_calls"));
    const blockedSpy = vi
      .spyOn(ledger, "recordBlocked")
      .mockRejectedValue(new Error("permission denied for table search_provider_calls (insert)"));
    try {
      const err = await dispatchProviderOp({
        tenantId: tenant, engagementId: eng, propertyId,
        op: { kind: "backlinks", query: uniqueKeyword("globalfail-secondary") + ".com" }, requestedBy: userId,
      }).catch((e: Error) => e);

      expect(err).toBeInstanceOf(GlobalCeilingUnavailableError); // NOT the recordBlocked error
      expect(provider.dispatchCount).toBe(0);
    } finally {
      mtdSpy.mockRestore();
      blockedSpy.mockRestore();
    }
  });

  it("crossing the warn ratio emits a warn event but still dispatches", async () => {
    // budget 0.024: one $0.02 backlinks pull = ~83% of the cap, comfortably past the 0.8 ratio.
    // Deliberately NOT the exact-80% budget (0.025): `0.8 * 0.025` is 0.020000000000000004 in IEEE
    // 754, so a pull landing precisely on the threshold does not warn. That is a cosmetic
    // off-by-an-ulp on an advisory signal, not a gate — the BREACH comparison is a plain `>` on the
    // same values and stays conservative (it refuses at the cap, never past it). Documented here so
    // the boundary is a known property rather than a surprise for SM-17's 80%/100% surfaces.
    const eng = await makeEngagement({ backlinks: { enabled: true } }, 0.024);
    const res = await dispatchProviderOp({
      tenantId: tenant, engagementId: eng,
      op: { kind: "backlinks", query: uniqueKeyword("warn") + ".com" }, requestedBy: userId,
    });
    expect(res.cacheHit).toBe(false);
    const events = await budgetEvents(eng);
    expect(events.some((e) => e.payload.level === "warn")).toBe(true);
  });

  it("the admin override proceeds past a breach but still emits an audited override event", async () => {
    const eng = await makeEngagement({ backlinks: { enabled: true } }, 0.001);
    const res = await dispatchProviderOp({
      tenantId: tenant, engagementId: eng,
      op: { kind: "backlinks", query: uniqueKeyword("override") + ".com" },
      requestedBy: userId, override: true,
    });
    expect(res.cacheHit).toBe(false);
    expect(provider.dispatchCount).toBe(1);
    const events = await budgetEvents(eng);
    expect(events.some((e) => e.payload.level === "override")).toBe(true);
  });

  it("a breached engagement stays refused on retry — the stop-loss is not a one-shot", async () => {
    const eng = await makeEngagement({ backlinks: { enabled: true } }, 0.001);
    const target = uniqueKeyword("retry") + ".com";
    for (let i = 0; i < 3; i++) {
      await expect(dispatchProviderOp({
        tenantId: tenant, engagementId: eng, op: { kind: "backlinks", query: target }, requestedBy: userId,
      })).rejects.toThrowError(BudgetExceededError);
    }
    expect(provider.dispatchCount).toBe(0);
    expect((await ledgerRows(eng)).filter((r) => r.status === "failed")).toHaveLength(3);
  });

  // ── AC 5: ledger sums match dispatched costs ──────────────────────────────────────────────────────
  it("ledger sums reconcile with a scripted call sequence, counting only real dispatches", async () => {
    const eng = await makeEngagement({ volume: { enabled: true }, backlinks: { enabled: true } }, 100);
    const kw = uniqueKeyword("recon");
    const domain = uniqueKeyword("recon") + ".com";

    const dispatched: number[] = [];
    dispatched.push((await dispatchProviderOp({ tenantId: tenant, engagementId: eng, op: { kind: "volume", query: kw }, requestedBy: userId })).costUsd);
    // two cache hits — must contribute exactly 0
    await dispatchProviderOp({ tenantId: tenant, engagementId: eng, op: { kind: "volume", query: kw }, requestedBy: userId });
    await dispatchProviderOp({ tenantId: tenant, engagementId: eng, op: { kind: "volume", query: kw }, requestedBy: userId });
    dispatched.push((await dispatchProviderOp({ tenantId: tenant, engagementId: eng, op: { kind: "backlinks", query: domain }, requestedBy: userId })).costUsd);
    // a refusal — must contribute exactly 0
    await dispatchProviderOp({ tenantId: tenant, engagementId: eng, op: { kind: "serp", query: kw }, requestedBy: userId }).catch(() => undefined);

    const expected = dispatched.reduce((a, b) => a + b, 0);
    const mtd = await withTenants([tenant], (c) => sumMonthToDate(c, eng), { modules: ["search"] });
    expect(mtd).toBeCloseTo(expected, 6);

    // and the sum the stop-loss reads is the sum of the rows a human would see in the usage panel
    const rows = await ledgerRows(eng);
    const rowSum = rows.reduce((s, r) => s + Number(r.cost_usd), 0);
    expect(rowSum).toBeCloseTo(expected, 6);
    expect(rows.filter((r) => Number(r.cost_usd) > 0)).toHaveLength(2);
  });

  it("month-to-date is scoped per engagement — one client's spend never counts against another's cap", async () => {
    const engA = await makeEngagement({ backlinks: { enabled: true } }, 100);
    const engB = await makeEngagement({ backlinks: { enabled: true } }, 100);
    await dispatchProviderOp({ tenantId: tenant, engagementId: engA, op: { kind: "backlinks", query: uniqueKeyword("mtdA") + ".com" }, requestedBy: userId });

    const a = await withTenants([tenant], (c) => sumMonthToDate(c, engA), { modules: ["search"] });
    const b = await withTenants([tenant], (c) => sumMonthToDate(c, engB), { modules: ["search"] });
    expect(a).toBeGreaterThan(0);
    expect(b).toBe(0);
  });

  // ── true-up (§05): posted -> completed, never a second row ────────────────────────────────────────
  it("true-up advances the SAME posted row to completed with the actual cost", async () => {
    const eng = await makeEngagement({ backlinks: { enabled: true } }, 100);
    const res = await dispatchProviderOp({
      tenantId: tenant, engagementId: eng,
      op: { kind: "backlinks", query: uniqueKeyword("trueup") + ".com" }, requestedBy: userId,
    });
    expect(res.status).toBe("posted");

    const actual = res.costUsd * 2; // the provider billed more than we estimated
    expect(await trueUpLedger(tenant, res.ledgerId, actual)).toBe(true);

    const rows = await ledgerRows(eng);
    expect(rows).toHaveLength(1); // NOT two rows
    expect(rows[0].status).toBe("completed");
    expect(Number(rows[0].cost_usd)).toBeCloseTo(actual, 6);

    const mtd = await withTenants([tenant], (c) => sumMonthToDate(c, eng), { modules: ["search"] });
    expect(mtd).toBeCloseTo(actual, 6);
  });

  it("a double true-up is a no-op rather than a corruption", async () => {
    const eng = await makeEngagement({ backlinks: { enabled: true } }, 100);
    const res = await dispatchProviderOp({
      tenantId: tenant, engagementId: eng,
      op: { kind: "backlinks", query: uniqueKeyword("double") + ".com" }, requestedBy: userId,
    });
    expect(await trueUpLedger(tenant, res.ledgerId, 0.05)).toBe(true);
    expect(await trueUpLedger(tenant, res.ledgerId, 999)).toBe(false); // already completed
    const rows = await ledgerRows(eng);
    expect(Number(rows[0].cost_usd)).toBeCloseTo(0.05, 6);
  });

  it("true-up cannot reach across tenants", async () => {
    const foreign = await createCompany("SM-04 Foreign Co", ["search"]);
    const eng = await makeEngagement({ backlinks: { enabled: true } }, 100);
    const res = await dispatchProviderOp({
      tenantId: tenant, engagementId: eng,
      op: { kind: "backlinks", query: uniqueKeyword("xtenant") + ".com" }, requestedBy: userId,
    });
    expect(await trueUpLedger(foreign, res.ledgerId, 999)).toBe(false);
    const rows = await ledgerRows(eng);
    expect(Number(rows[0].cost_usd)).toBeCloseTo(res.costUsd, 6);
  });

  // ── SM-42: dispatch's AUTOMATIC true-up seam (design addendum §A8.7, tracker §6j step 3) ──────────
  // Unlike the tests above (which call trueUpLedger by hand to prove the primitive), these exercise
  // the WIRED path: a real driver reporting an actual cost through the optional
  // SearchDataProvider.takeActualCostUsd surface, consumed by dispatchProviderOp itself.
  describe("SM-42 automatic true-up seam — dispatch consumes the optional actual-cost surface", () => {
    /** A minimal Ahrefs-backed fetchImpl: backlinks-stats and domain-rating each answer with the
     *  given confirmed x-api-units-cost-total-actual unit counts. No network, no credentials. */
    function ahrefsFetch(statsUnits: number, ratingUnits: number): typeof fetch {
      return (async (url: string | URL | Request) => {
        const full = new URL(String(url));
        const header = (units: number) => ({ get: (n: string) => (n.toLowerCase() === "x-api-units-cost-total-actual" ? String(units) : null) });
        if (full.pathname.endsWith("/site-explorer/backlinks-stats")) {
          return { ok: true, status: 200, headers: header(statsUnits), json: async () => ({ metrics: { live: 1, live_refdomains: 1 } }) } as unknown as Response;
        }
        return { ok: true, status: 200, headers: header(ratingUnits), json: async () => ({ domain_rating: { domain_rating: 1 } }) } as unknown as Response;
      }) as unknown as typeof fetch;
    }

    it("trues up the SAME posted row DOWN when the vendor reports LESS than the estimate", async () => {
      resetProviders();
      const ahrefsRate = 0.0001;
      registerProvider(new AhrefsProvider({
        apiKey: "k", baseUrl: "https://api.test/v3", timeoutMs: 5000, country: "us",
        costPerUnitUsd: ahrefsRate, fetchImpl: ahrefsFetch(5, 5), // 10 units actual
      }) as unknown as SearchDataProvider);
      const eng = await makeEngagement({ backlinks: { enabled: true }, provider: { default: "ahrefs" } }, 100);

      const res = await dispatchProviderOp({
        tenantId: tenant, engagementId: eng,
        op: { kind: "backlinks", query: uniqueKeyword("trueup-down") + ".com" }, requestedBy: userId,
      });

      const estimate = (100) * ahrefsRate; // AHREFS_RATES base 50+50 units * rate
      const actual = 10 * ahrefsRate;
      expect(estimate).toBeGreaterThan(actual); // sanity: this really is a downward correction
      expect(res.costUsd).toBeCloseTo(actual, 9);
      expect(res.status).toBe("completed"); // trued up automatically, not left 'posted'

      const rows = await ledgerRows(eng);
      expect(rows).toHaveLength(1); // the SAME row, never a second one
      expect(rows[0].status).toBe("completed");
      expect(Number(rows[0].cost_usd)).toBeCloseTo(actual, 9);
    });

    it("trues up the SAME posted row UP when the vendor reports MORE than the estimate, and NEVER re-runs budget arithmetic even when the actual alone would have breached every tier", async () => {
      resetProviders();
      const ahrefsRate = 0.0001;
      registerProvider(new AhrefsProvider({
        apiKey: "k", baseUrl: "https://api.test/v3", timeoutMs: 5000, country: "us",
        costPerUnitUsd: ahrefsRate, fetchImpl: ahrefsFetch(500, 500), // 1000 units actual
      }) as unknown as SearchDataProvider);
      // Engagement cap is BELOW the trued-up actual, but ABOVE the pre-dispatch estimate — proving
      // the budget decision was (and stays) made against the estimate only.
      const estimate = 100 * ahrefsRate; // 0.01
      const actual = 1000 * ahrefsRate; // 0.1
      const engagementCap = 0.05;
      expect(estimate).toBeLessThan(engagementCap); // dispatch must be ALLOWED to proceed
      expect(actual).toBeGreaterThan(engagementCap); // ...yet the true-up alone would breach it
      const eng = await makeEngagement({ backlinks: { enabled: true }, provider: { default: "ahrefs" } }, engagementCap);

      // Must NOT throw BudgetExceededError — the estimate (which passed) is the only decision ever
      // made; the true-up is a correction after the money is already spent, not a second gate.
      const res = await dispatchProviderOp({
        tenantId: tenant, engagementId: eng,
        op: { kind: "backlinks", query: uniqueKeyword("trueup-up") + ".com" }, requestedBy: userId,
      });

      expect(res.costUsd).toBeCloseTo(actual, 9);
      expect(res.status).toBe("completed");
      const rows = await ledgerRows(eng);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].cost_usd)).toBeCloseTo(actual, 9);

      // And the tier that WOULD refuse a fresh dispatch at this (now-trued-up) spend level really
      // does refuse — proving the prior dispatch's success was not a broken budget check, but
      // specifically the absence of a RE-check after true-up.
      const err = await dispatchProviderOp({
        tenantId: tenant, engagementId: eng,
        op: { kind: "backlinks", query: uniqueKeyword("trueup-up-2nd") + ".com" }, requestedBy: userId,
      }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(BudgetExceededError);
    });

    it("leaves the row exactly at its estimate, status 'posted', when the resolved driver reports no actual cost (MockSearchProvider)", async () => {
      // Regression guard: providers with no takeActualCostUsd (every one already registered in the
      // parent describe's beforeEach, and DataForSEO/every simulator in production) must be
      // completely unaffected by this seam.
      const eng = await makeEngagement({ backlinks: { enabled: true } }, 100);
      const res = await dispatchProviderOp({
        tenantId: tenant, engagementId: eng,
        op: { kind: "backlinks", query: uniqueKeyword("no-trueup") + ".com" }, requestedBy: userId,
      });
      expect(res.status).toBe("posted");
    });

    // ── THE named hazard, at the dispatch/ledger level (tracker §6j step 3) ─────────────────────────
    // getBacklinkSummary issues two calls in parallel for ONE op; this races TWO SEPARATE dispatches
    // (different engagements, different targets) against the SAME registered Ahrefs provider
    // instance, with staggered internal delays so the two ops' HTTP calls interleave, and proves each
    // op's LEDGER ROW ends up trued up to its OWN target's reported cost — never swapped, never
    // dropped, never summed across ops.
    it("two concurrent dispatchProviderOp calls against the SAME Ahrefs instance true-up to their OWN target's cost, never cross-contaminated", async () => {
      resetProviders();
      const ahrefsRate = 0.0001;
      const fetchImpl = (async (url: string | URL | Request) => {
        const full = new URL(String(url));
        const isA = full.searchParams.get("target")?.includes("race-a");
        const header = (units: number) => ({ get: (n: string) => (n.toLowerCase() === "x-api-units-cost-total-actual" ? String(units) : null) });
        if (full.pathname.endsWith("/site-explorer/backlinks-stats")) {
          return { ok: true, status: 200, headers: header(isA ? 10 : 40), json: async () => ({ metrics: { live: 1, live_refdomains: 1 } }) } as unknown as Response;
        }
        // domain-rating: op A is delayed LONGER than op B, so op B's second call resolves BEFORE
        // op A's — the two ops' calls interleave rather than resolving in dispatch order.
        await new Promise((r) => setTimeout(r, isA ? 30 : 5));
        return { ok: true, status: 200, headers: header(isA ? 20 : 5), json: async () => ({ domain_rating: { domain_rating: 1 } }) } as unknown as Response;
      }) as unknown as typeof fetch;
      registerProvider(new AhrefsProvider({
        apiKey: "k", baseUrl: "https://api.test/v3", timeoutMs: 5000, country: "us",
        costPerUnitUsd: ahrefsRate, fetchImpl,
      }) as unknown as SearchDataProvider);

      const engA = await makeEngagement({ backlinks: { enabled: true }, provider: { default: "ahrefs" } }, 100);
      const engB = await makeEngagement({ backlinks: { enabled: true }, provider: { default: "ahrefs" } }, 100);

      const [resA, resB] = await Promise.all([
        dispatchProviderOp({
          tenantId: tenant, engagementId: engA,
          op: { kind: "backlinks", query: uniqueKeyword("race-a") + ".com" }, requestedBy: userId,
        }),
        dispatchProviderOp({
          tenantId: tenant, engagementId: engB,
          op: { kind: "backlinks", query: uniqueKeyword("race-b") + ".com" }, requestedBy: userId,
        }),
      ]);

      // op A: stats=10 + rating=20 => 30 units. op B: stats=40 + rating=5 => 45 units. A cross-
      // contaminated (last-write-wins) implementation would instead show ONE of these two values on
      // BOTH rows, or a summed/blended figure — never the two correct, DISTINCT totals below.
      expect(resA.costUsd).toBeCloseTo(30 * ahrefsRate, 9);
      expect(resB.costUsd).toBeCloseTo(45 * ahrefsRate, 9);
      expect(resA.status).toBe("completed");
      expect(resB.status).toBe("completed");

      const rowsA = await ledgerRows(engA);
      const rowsB = await ledgerRows(engB);
      expect(Number(rowsA[0].cost_usd)).toBeCloseTo(30 * ahrefsRate, 9);
      expect(Number(rowsB[0].cost_usd)).toBeCloseTo(45 * ahrefsRate, 9);
    });
  });

  // ── refusals leave no partial state ───────────────────────────────────────────────────────────────
  it("a provider failure rolls back the whole critical section — no cache row, no billed row", async () => {
    class ExplodingProvider extends MockSearchProvider {
      async getBacklinkSummary(): Promise<never> {
        this.dispatchCount += 1;
        throw new Error("provider 502");
      }
    }
    resetProviders();
    const exploding = new ExplodingProvider();
    registerProvider(exploding as SearchDataProvider);

    const eng = await makeEngagement({ backlinks: { enabled: true } }, 100);
    const target = uniqueKeyword("explode") + ".com";
    await expect(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "backlinks", query: target }, requestedBy: userId,
    })).rejects.toThrow(/provider 502/);

    expect(await ledgerRows(eng)).toHaveLength(0); // nothing billed for a call that never returned

    // and no poisoned cache entry: a later successful call still dispatches
    resetProviders();
    const good = new MockSearchProvider();
    registerProvider(good);
    const res = await dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "backlinks", query: target }, requestedBy: userId,
    });
    expect(res.cacheHit).toBe(false);
  });

  it("dispatch to an unknown engagement refuses without spending", async () => {
    await expect(dispatchProviderOp({
      tenantId: tenant, engagementId: newId(), op: { kind: "volume", query: uniqueKeyword("noeng") }, requestedBy: userId,
    })).rejects.toThrow(/engagement not found/);
    expect(provider.dispatchCount).toBe(0);
  });

  it("records requested_by and correlation_id so an automated pull is attributable", async () => {
    const eng = await makeEngagement({ volume: { enabled: true } }, 100);
    const correlationId = newId();
    await dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "volume", query: uniqueKeyword("attrib") },
      requestedBy: userId, correlationId,
    });
    const r = await withTenants(
      [tenant],
      (c) => c.query<{ requested_by: string; correlation_id: string }>(
        `SELECT requested_by, correlation_id FROM search_provider_calls WHERE engagement_id = $1`, [eng]),
      { modules: ["search"] },
    );
    expect(r.rows[0].requested_by).toBe(userId);
    expect(r.rows[0].correlation_id).toBe(correlationId);
  });
});
