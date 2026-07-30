// SM-49 (tracker §6u; design addendum §A10) — the Ahrefs LIVE driver's real HTTP path, end to end,
// against the vendor-envelope sandbox (server.ts). Same discipline as the DataForSEO/Semrush sandbox
// files: the REAL zero-arg factory (`createAhrefsProviderFromConfig`), `config.search.ahrefs` mutated
// in try/finally, the whole registry -> dispatchProviderOp -> cache -> ledger chain, real Postgres
// (§0 protocol, skips without DATABASE_URL_TEST).
//
// THE VALUE UNIQUE TO THIS FILE (AC 8): Ahrefs is the one vendor with a CONFIRMED per-response
// true-up header (`x-api-units-cost-total-actual`) and a driver whose getBacklinkSummary() issues TWO
// PARALLEL internal HTTP calls for ONE op — the exact shape SM-42's AsyncLocalStorage fix
// (types.ts's withActualCostCapture/recordActualCostUsd/takeCapturedActualCostUsd) exists for.
// ahrefs.test.ts already proves the ALS mechanism correct against an INJECTED fetchImpl; this file
// re-proves it against REAL SOCKETS — two genuinely concurrent dispatchProviderOp() calls, each racing
// its own two real HTTP round-trips against the SAME provider singleton, each trueing up to its OWN
// total.
//
// REMINDER (binding, §A10 MUST-NOT list): a green run validates OUR mechanics against OUR OWN vendor
// model, never a vendor fact — in particular, whether `x-api-units-cost-total-actual` is spelled/cased
// the way the real Ahrefs API sends it is EXACTLY the kind of vendor fact this harness cannot prove
// (§A10.5). OQ-9/OQ-10/OQ-11 and every SM-41 clause are untouched.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { config } from "../../../config";
import { newId, withTenants } from "../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, createClient } from "../../../testing/fixtures";
import { startVendorSandbox, AHREFS_ERROR_MARKER, type VendorSandbox } from "../../../testing/vendor-sandbox/server";
import { createAhrefsProviderFromConfig, AHREFS_RATES, computeAhrefsCostPerUnitUsd } from "./ahrefs";
import { registerProvider, resetProviders } from "./registry";
import { dispatchProviderOp } from "./dispatch";

const CREDS = { apiKey: "sm49-ahrefs-token" };
const TEST_TIER_PRICE_USD = 500;
const TEST_TIER_UNIT_ALLOWANCE = 150_000;
const RATE = computeAhrefsCostPerUnitUsd(TEST_TIER_PRICE_USD, TEST_TIER_UNIT_ALLOWANCE);
const RANK_TRACKER_PROJECT_ID = "sm49-ahrefs-proj";

describe.skipIf(!TEST_URL)("SM-49 Ahrefs — live driver over the vendor sandbox (real Postgres)", () => {
  let tenant: string;
  let userId: string;
  let clientId: string;
  let propertyId: string;
  let sandbox: VendorSandbox;
  let originalAhrefsConfig: typeof config.search.ahrefs;

  async function makeEngagement(toolScope: Record<string, unknown>): Promise<string> {
    const id = newId();
    await withTenants(
      [tenant],
      (c) => c.query(
        `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active')`,
        [id, tenant, clientId, propertyId, "SM-49 Ahrefs sandbox engagement", JSON.stringify(toolScope), 10],
      ),
      { modules: ["search"] },
    );
    return id;
  }

  async function ledgerRow(engagementId: string) {
    const r = await withTenants(
      [tenant],
      (c) => c.query<{ endpoint: string; cost_usd: string; cache_hit: boolean; status: string; simulated: boolean }>(
        `SELECT endpoint, cost_usd, cache_hit, status, simulated FROM search_provider_calls WHERE engagement_id = $1 ORDER BY created_at`,
        [engagementId],
      ),
      { modules: ["search"] },
    );
    return r.rows;
  }

  let seq = 0;
  const uniqueTarget = (label: string) => `sm49-ahrefs-${label}-${Date.now()}-${seq++}.example`;

  beforeAll(async () => {
    await initTestDb();
    tenant = await createCompany("SM-49 Ahrefs Sandbox Co", ["search"]);
    userId = await createUser("sm49-ahrefs@sandbox.test");
    clientId = await createClient(tenant, "SM-49 Ahrefs Client");
    propertyId = newId();
    await withTenants(
      [tenant],
      (c) => c.query(`INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url) VALUES ($1,$2,$3,$4,$5)`,
        [propertyId, tenant, clientId, "sm49-ahrefs.example.com", "https://sm49-ahrefs.example.com"]),
      { modules: ["search"] },
    );
    sandbox = await startVendorSandbox({
      dataforseo: { login: "unused", password: "unused" },
      semrush: { apiKey: "unused-in-this-file" },
      ahrefs: CREDS,
    });
  });

  afterAll(async () => {
    resetProviders();
    await sandbox.close();
    await teardownTestDb();
  });

  beforeEach(() => {
    resetProviders();
    config.search.tenantMonthlyCapUsd = null;
    config.search.globalMonthlyCapUsd = 1_000_000;
    originalAhrefsConfig = { ...config.search.ahrefs };
    config.search.ahrefs = {
      ...originalAhrefsConfig,
      apiKey: CREDS.apiKey,
      baseUrl: sandbox.origin,
      country: "us",
      timeoutMs: 5000,
      rankTrackerProjectId: RANK_TRACKER_PROJECT_ID,
      monthlyApiTierPriceUsd: TEST_TIER_PRICE_USD,
      monthlyApiTierUnitAllowance: TEST_TIER_UNIT_ALLOWANCE,
    };
  });

  function restoreConfig(): void {
    config.search.ahrefs = originalAhrefsConfig;
  }

  it("AC 2/3: the REAL zero-arg factory registers a live driver whose ledger row stamps simulated=false", async () => {
    try {
      expect(config.search.providerMode).toBe("live");
      const driver = createAhrefsProviderFromConfig();
      expect(driver).not.toBeNull();
      expect((driver as unknown as { simulated?: unknown }).simulated).toBeUndefined();
      registerProvider(driver!);

      const target = uniqueTarget("fidelity");
      sandbox.seedAhrefsBacklinks(target, { live: 7000, live_refdomains: 300, domain_rating: 60 });
      const eng = await makeEngagement({ backlinks: { enabled: true }, provider: { default: "ahrefs" } });
      const result = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, propertyId, op: { kind: "backlinks", query: target }, requestedBy: userId });

      expect(result.simulated).toBe(false);
      expect(result.provider).toBe("ahrefs");
      expect(result.payload).toEqual({ target, backlinks: 7000, refDomains: 300, authorityScore: 60 });

      const rows = await ledgerRow(eng);
      expect(rows).toHaveLength(1);
      expect(rows[0].simulated).toBe(false);
    } finally {
      restoreConfig();
    }
  });

  it("AC 4: volume — parses the keywords-explorer envelope, writes ledger+cache, and a second identical "
    + "dispatch is a cache hit issuing ZERO new sandbox requests", async () => {
    try {
      registerProvider(createAhrefsProviderFromConfig()!);
      const kw = `sm49-ahrefs-volume-${Date.now()}-${seq++}`;
      sandbox.seedAhrefsVolumeRow(kw, { keyword: kw, volume: 3300, difficulty: 22 });
      const eng = await makeEngagement({ volume: { enabled: true }, provider: { default: "ahrefs" } });

      const first = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, propertyId, op: { kind: "volume", query: kw }, requestedBy: userId });
      expect(first.cacheHit).toBe(false);
      expect((first.payload as Array<{ volume?: number }>)[0].volume).toBe(3300);
      const expectedEstimate = (AHREFS_RATES.keywordsOverviewBaseUnits + AHREFS_RATES.keywordsOverviewPerFieldUnits * AHREFS_RATES.keywordsOverviewAssumedFields) * RATE;
      expect(first.costUsd).toBeCloseTo(expectedEstimate, 9);

      const before = sandbox.hitCount("ahrefs:keywords_explorer_overview");
      const second = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, propertyId, op: { kind: "volume", query: kw }, requestedBy: userId });
      expect(second.cacheHit).toBe(true);
      expect(second.costUsd).toBe(0);
      expect(sandbox.hitCount("ahrefs:keywords_explorer_overview")).toBe(before);
    } finally {
      restoreConfig();
    }
  });

  it("AC 4: serp (serp-overview, confirmed free) — full chain, requires the configured Rank Tracker project_id", async () => {
    try {
      registerProvider(createAhrefsProviderFromConfig()!);
      const kw = `sm49-ahrefs-serp-${Date.now()}-${seq++}`;
      const eng = await makeEngagement({ rank: { enabled: true }, provider: { default: "ahrefs" } });
      const result = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, propertyId, op: { kind: "serp", query: kw }, requestedBy: userId });
      const payload = result.payload as Array<{ items: Array<{ position: number }> }>;
      expect(payload[0].items).toHaveLength(2); // the no-URL row is filtered out by the driver
      expect(result.costUsd).toBe(0); // confirmed free
    } finally {
      restoreConfig();
    }
  });

  // ── AC 8: the confirmed true-up header, over a REAL socket, single dispatch ─────────────────────────
  it("AC 8: x-api-units-cost-total-actual trues the ledger row up/down in-transaction, over a real HTTP round trip", async () => {
    try {
      registerProvider(createAhrefsProviderFromConfig()!);
      const target = uniqueTarget("trueup");
      sandbox.seedAhrefsBacklinks(target, { live: 1, live_refdomains: 1, domain_rating: 5 });
      sandbox.configureAhrefsTrueUp(target, { statsUnits: 12, ratingUnits: 37 });
      const eng = await makeEngagement({ backlinks: { enabled: true }, provider: { default: "ahrefs" } });

      const result = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, propertyId, op: { kind: "backlinks", query: target }, requestedBy: userId });

      // 12 + 37 = 49 units, converted through the SAME costPerUnitUsd estimateCostUsd used — proving
      // the sum (not last-write-wins) over TWO real, separately-headed HTTP responses.
      expect(result.status).toBe("completed");
      expect(result.costUsd).toBeCloseTo(49 * RATE, 9);

      const rows = await ledgerRow(eng);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("completed");
      // Precision 5 (not 9): cost_usd is `numeric(12,6)` (migration 0034) — the DB itself rounds to 6
      // decimal places, so a diff on the order of 1e-7 is the column's OWN rounding, not a bug.
      expect(Number(rows[0].cost_usd)).toBeCloseTo(49 * RATE, 5);
    } finally {
      restoreConfig();
    }
  });

  // ── AC 8: the SM-42 concurrency proof, transposed to real sockets ──────────────────────────────────
  // Two DIFFERENT engagements (not one) is deliberate: dispatchProviderOp's critical section holds an
  // advisory lock keyed on engagementId for its ENTIRE duration (cache.ts), which would SERIALIZE two
  // dispatches sharing one engagement — defeating the very concurrency this test needs to prove. Two
  // engagements let both dispatches' invokeProvider() calls genuinely interleave at the socket level,
  // while both still resolve through the SAME Ahrefs provider SINGLETON (registry.ts holds exactly one
  // instance per ProviderKey) — the exact shape ahrefs.test.ts's own racing unit test names.
  it("AC 8: two dispatches racing concurrently on the SAME provider instance over REAL sockets never "
    + "cross-contaminate — each trues up to its OWN reported cost", async () => {
    try {
      const driver = createAhrefsProviderFromConfig()!;
      registerProvider(driver);
      const targetA = uniqueTarget("race-a");
      const targetB = uniqueTarget("race-b");
      sandbox.seedAhrefsBacklinks(targetA, { live: 1, live_refdomains: 1, domain_rating: 5 });
      sandbox.seedAhrefsBacklinks(targetB, { live: 1, live_refdomains: 1, domain_rating: 5 });
      // Staggered delays so op B's rating call resolves BEFORE op A's — crossed completion order,
      // not dispatch order — the same technique ahrefs.test.ts's unit-level race test uses.
      sandbox.configureAhrefsTrueUp(targetA, { statsUnits: 10, ratingUnits: 20, ratingDelayMs: 30 });
      sandbox.configureAhrefsTrueUp(targetB, { statsUnits: 40, ratingUnits: 5, ratingDelayMs: 5 });

      const engA = await makeEngagement({ backlinks: { enabled: true }, provider: { default: "ahrefs" } });
      const engB = await makeEngagement({ backlinks: { enabled: true }, provider: { default: "ahrefs" } });

      const [resultA, resultB] = await Promise.all([
        dispatchProviderOp({ tenantId: tenant, engagementId: engA, propertyId, op: { kind: "backlinks", query: targetA }, requestedBy: userId }),
        dispatchProviderOp({ tenantId: tenant, engagementId: engB, propertyId, op: { kind: "backlinks", query: targetB }, requestedBy: userId }),
      ]);

      // op A: stats=10 + rating=20 => 30 units. op B: stats=40 + rating=5 => 45 units. The OLD
      // last-write-wins instance field could only ever report ONE call's figure (whichever settled
      // last across BOTH ops) — a regression back to that shape fails these two assertions together,
      // not just a subtler one.
      expect(resultA.costUsd).toBeCloseTo(30 * RATE, 9);
      expect(resultB.costUsd).toBeCloseTo(45 * RATE, 9);

      const [rowsA, rowsB] = await Promise.all([ledgerRow(engA), ledgerRow(engB)]);
      // Precision 5, same DB-rounding reasoning as the single-dispatch true-up test above.
      expect(Number(rowsA[0].cost_usd)).toBeCloseTo(30 * RATE, 5);
      expect(Number(rowsB[0].cost_usd)).toBeCloseTo(45 * RATE, 5);
    } finally {
      restoreConfig();
    }
  });

  it("vendor-error-inside (non-2xx) on backlinks propagates as a typed failure, with NO ledger row surviving "
    + "the rolled-back transaction (pinned as current dispatch semantics, not redesigned)", async () => {
    try {
      registerProvider(createAhrefsProviderFromConfig()!);
      const target = `sm49-ahrefs-${AHREFS_ERROR_MARKER}-${Date.now()}-${seq++}.example`;
      const eng = await makeEngagement({ backlinks: { enabled: true }, provider: { default: "ahrefs" } });
      await expect(
        dispatchProviderOp({ tenantId: tenant, engagementId: eng, propertyId, op: { kind: "backlinks", query: target }, requestedBy: userId }),
      ).rejects.toThrow(/HTTP 403/);
      const rows = await ledgerRow(eng);
      expect(rows).toHaveLength(0);
    } finally {
      restoreConfig();
    }
  });
});
