// SM-49 (tracker §6u; design addendum §A10) — the Semrush LIVE driver's real HTTP path, end to end,
// against the vendor-envelope sandbox (server.ts). Same discipline as dataforseo.sandbox.test.ts: the
// REAL zero-arg factory (`createSemrushProviderFromConfig`), `config.search.semrush` mutated in
// try/finally, the whole registry -> dispatchProviderOp -> cache -> ledger chain, real Postgres
// (§0 protocol, skips without DATABASE_URL_TEST).
//
// Semrush has NO async queue (unlike DataForSEO's Standard-queue poll) and NO confirmed per-response
// true-up header (unlike Ahrefs's) — so this file covers AC 2/3/4 only; there is no AC 5/AC 8
// equivalent for this vendor (see semrush.ts's own estimateCostUsd doc comment on why no true-up is
// implemented here).
//
// REMINDER (binding, §A10 MUST-NOT list): a green run validates OUR mechanics against OUR OWN vendor
// model, never a vendor fact. OQ-9/OQ-10/OQ-11 and every SM-41 clause are untouched.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { config } from "../../../config";
import { newId, withTenants } from "../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, createClient } from "../../../testing/fixtures";
import { startVendorSandbox, type VendorSandbox } from "../../../testing/vendor-sandbox/server";
import { createSemrushProviderFromConfig, SEMRUSH_RATES, computeSemrushCostPerUnitUsd } from "./semrush";
import { registerProvider, resetProviders } from "./registry";
import { dispatchProviderOp } from "./dispatch";
import { phraseOrganicText } from "../../../testing/vendor-sandbox/fixtures/semrush/phrase-organic";
import { phraseTheseText } from "../../../testing/vendor-sandbox/fixtures/semrush/phrase-these";
import { backlinksOverviewText } from "../../../testing/vendor-sandbox/fixtures/semrush/backlinks-overview";

const CREDS = { apiKey: "sm49-semrush-key" };
const TEST_PLAN_PRICE_USD = 499.95;
const TEST_UNIT_ALLOWANCE = 300_000;
const RATE = computeSemrushCostPerUnitUsd(TEST_PLAN_PRICE_USD, TEST_UNIT_ALLOWANCE);

describe.skipIf(!TEST_URL)("SM-49 Semrush — live driver over the vendor sandbox (real Postgres)", () => {
  let tenant: string;
  let userId: string;
  let clientId: string;
  let propertyId: string;
  let sandbox: VendorSandbox;
  let originalSemrushConfig: typeof config.search.semrush;

  async function makeEngagement(toolScope: Record<string, unknown>): Promise<string> {
    const id = newId();
    await withTenants(
      [tenant],
      (c) => c.query(
        `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active')`,
        [id, tenant, clientId, propertyId, "SM-49 Semrush sandbox engagement", JSON.stringify(toolScope), 10],
      ),
      { modules: ["search"] },
    );
    return id;
  }

  async function ledgerRows(engagementId: string) {
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
  const uniqueKeyword = (label: string) => `sm49-semrush-${label}-${Date.now()}-${seq++}`;

  beforeAll(async () => {
    await initTestDb();
    tenant = await createCompany("SM-49 Semrush Sandbox Co", ["search"]);
    userId = await createUser("sm49-semrush@sandbox.test");
    clientId = await createClient(tenant, "SM-49 Semrush Client");
    propertyId = newId();
    await withTenants(
      [tenant],
      (c) => c.query(`INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url) VALUES ($1,$2,$3,$4,$5)`,
        [propertyId, tenant, clientId, "sm49-semrush.example.com", "https://sm49-semrush.example.com"]),
      { modules: ["search"] },
    );
    sandbox = await startVendorSandbox({
      dataforseo: { login: "unused", password: "unused" },
      semrush: CREDS,
      ahrefs: { apiKey: "unused-in-this-file" },
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
    originalSemrushConfig = { ...config.search.semrush };
    config.search.semrush = {
      ...originalSemrushConfig,
      apiKey: CREDS.apiKey,
      baseUrl: sandbox.origin,
      database: "us",
      timeoutMs: 5000,
      monthlyPlanPriceUsd: TEST_PLAN_PRICE_USD,
      monthlyUnitAllowance: TEST_UNIT_ALLOWANCE,
    };
  });

  function restoreConfig(): void {
    config.search.semrush = originalSemrushConfig;
  }

  it("AC 2/3: the REAL zero-arg factory registers a live driver whose ledger row stamps simulated=false", async () => {
    try {
      expect(config.search.providerMode).toBe("live");
      const driver = createSemrushProviderFromConfig();
      expect(driver).not.toBeNull();
      expect((driver as unknown as { simulated?: unknown }).simulated).toBeUndefined();
      registerProvider(driver!);

      const target = uniqueKeyword("backlinks") + ".example";
      sandbox.seedSemrushBacklinksOverview(target, backlinksOverviewText({ ascore: 55, total: 9001, domains_num: 340 }));
      const eng = await makeEngagement({ backlinks: { enabled: true }, provider: { default: "semrush" } });
      const result = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, propertyId, op: { kind: "backlinks", query: target }, requestedBy: userId });

      expect(result.simulated).toBe(false);
      expect(result.provider).toBe("semrush");
      expect(result.payload).toEqual({ target, backlinks: 9001, refDomains: 340, authorityScore: 55 });
      expect(result.costUsd).toBeCloseTo(SEMRUSH_RATES.backlinksUnitsPerLine * RATE, 9);

      const rows = await ledgerRows(eng);
      expect(rows).toHaveLength(1);
      expect(rows[0].simulated).toBe(false);
      expect(rows[0].status).toBe("posted");
    } finally {
      restoreConfig();
    }
  });

  it("AC 4: volume — parses the semicolon-delimited envelope, writes ledger+cache, and a second identical "
    + "dispatch is a cache hit issuing ZERO new sandbox requests", async () => {
    try {
      registerProvider(createSemrushProviderFromConfig()!);
      const kw = uniqueKeyword("volume-cache");
      sandbox.setSemrushPhraseThese(phraseTheseText([{ keyword: kw, volume: 2400, cpc: 0.85, kd: 38 }]));
      const eng = await makeEngagement({ volume: { enabled: true }, provider: { default: "semrush" } });

      const first = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, propertyId, op: { kind: "volume", query: kw }, requestedBy: userId });
      expect(first.cacheHit).toBe(false);
      expect((first.payload as Array<{ volume?: number }>)[0].volume).toBe(2400);
      expect(first.costUsd).toBeCloseTo((SEMRUSH_RATES.keywordOverviewUnitsPerLine + SEMRUSH_RATES.keywordDifficultyUnitsPerLine) * RATE, 9);

      const before = sandbox.hitCount("semrush:phrase_these");
      const second = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, propertyId, op: { kind: "volume", query: kw }, requestedBy: userId });
      expect(second.cacheHit).toBe(true);
      expect(second.costUsd).toBe(0);
      expect(sandbox.hitCount("semrush:phrase_these")).toBe(before); // ZERO new requests
    } finally {
      restoreConfig();
    }
  });

  it("AC 4: serp (phrase_organic) — full chain parses real bytes, no second network round trip on fetch", async () => {
    try {
      registerProvider(createSemrushProviderFromConfig()!);
      const kw = uniqueKeyword("serp");
      sandbox.seedSemrushPhraseOrganic(kw, phraseOrganicText(kw));
      const eng = await makeEngagement({ rank: { enabled: true }, provider: { default: "semrush" } });
      const result = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, propertyId, op: { kind: "serp", query: kw }, requestedBy: userId });
      const payload = result.payload as Array<{ items: Array<{ position: number }> }>;
      expect(payload[0].items).toHaveLength(2);
      expect(payload[0].items[0].position).toBe(1);
      expect(result.costUsd).toBeCloseTo(SEMRUSH_RATES.serpUnitsPerLine * RATE, 9);
    } finally {
      restoreConfig();
    }
  });

  it("does NOT advertise suggestions/ai_visibility — those ops refuse at the registry, never reach this driver", async () => {
    try {
      registerProvider(createSemrushProviderFromConfig()!);
      const eng = await makeEngagement({ suggestions: { enabled: true }, provider: { default: "semrush" } });
      await expect(
        dispatchProviderOp({ tenantId: tenant, engagementId: eng, propertyId, op: { kind: "suggestions", query: uniqueKeyword("no-suggestions") }, requestedBy: userId }),
      ).rejects.toThrow(/no registered search-data provider advertises capability/);
    } finally {
      restoreConfig();
    }
  });
});
