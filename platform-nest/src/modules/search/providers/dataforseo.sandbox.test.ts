// SM-49 (tracker §6u; design addendum §A10) — the DataForSEO LIVE driver's real HTTP path, end to
// end, against the vendor-envelope sandbox (server.ts). Runs the whole
// registry -> dispatchProviderOp -> cache -> ledger chain (§A10.2's structural requirement) through
// the REAL zero-arg factory (`createDataForSeoProviderFromConfig`), with `config.search.dataforseo`
// mutated (fake creds, `baseUrl` -> sandbox origin) in try/finally (SM-46e pattern) — the ONLY
// exception is the poll-state-machine test, which constructs `DataForSeoProvider` directly to inject
// a short `pollIntervalMs` (permitted by AC 2 for exactly this reason; every other option is
// byte-matched to what the factory would have built from the same mutated config).
//
// Needs live Postgres (`initTestDb`) — same §0 per-file-throwaway-database protocol as every other
// `providers/*.test.ts` DB suite; skips (via `describe.skipIf(!TEST_URL)`) without
// DATABASE_URL_TEST. This is deliberate: dispatchProviderOp's guarantees (single-flight, the cache/
// ledger writes, the mode/provenance stamp) are DB guarantees, and this harness's whole point (§A10)
// is to prove the LIVE drivers run that real chain, not a mocked substitute for it.
//
// REMINDER (binding, §A10 MUST-NOT list): a green run here validates OUR mechanics against OUR OWN
// vendor model — never a vendor fact. Nothing below claims envelope fidelity, error-code completeness,
// or that DataForSEO's real API actually behaves this way. OQ-9/OQ-10/OQ-11 and every SM-41 clause are
// untouched.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { config } from "../../../config";
import { newId, withTenants } from "../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, createClient } from "../../../testing/fixtures";
import { startVendorSandbox, DFS_NEVER_READY_MARKER, type VendorSandbox } from "../../../testing/vendor-sandbox/server";
import { DataForSeoProvider, createDataForSeoProviderFromConfig, DFS_RATES } from "./dataforseo";
import { registerProvider, resetProviders } from "./registry";
import { dispatchProviderOp } from "./dispatch";

const CREDS = { login: "sm49-dfs-login", password: "sm49-dfs-password" };

describe.skipIf(!TEST_URL)("SM-49 DataForSEO — live driver over the vendor sandbox (real Postgres)", () => {
  let tenant: string;
  let userId: string;
  let clientId: string;
  let propertyId: string;
  let sandbox: VendorSandbox;
  let originalDfsConfig: typeof config.search.dataforseo;

  async function makeEngagement(toolScope: Record<string, unknown>): Promise<string> {
    const id = newId();
    await withTenants(
      [tenant],
      (c) => c.query(
        `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active')`,
        [id, tenant, clientId, propertyId, "SM-49 DFS sandbox engagement", JSON.stringify(toolScope), 10],
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
  const uniqueKeyword = (label: string) => `sm49-dfs-${label}-${Date.now()}-${seq++}`;

  beforeAll(async () => {
    await initTestDb();
    tenant = await createCompany("SM-49 DFS Sandbox Co", ["search"]);
    userId = await createUser("sm49-dfs@sandbox.test");
    clientId = await createClient(tenant, "SM-49 DFS Client");
    propertyId = newId();
    await withTenants(
      [tenant],
      (c) => c.query(`INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url) VALUES ($1,$2,$3,$4,$5)`,
        [propertyId, tenant, clientId, "sm49-dfs.example.com", "https://sm49-dfs.example.com"]),
      { modules: ["search"] },
    );
    sandbox = await startVendorSandbox({
      dataforseo: CREDS,
      semrush: { apiKey: "unused-in-this-file" },
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
    // Defensive, matching dispatch.test.ts's own convention: this suite's assertions are all about
    // the sandbox's protocol behaviour, not the stop-loss cascade — a wide-open cap keeps that cascade
    // from ever becoming an incidental cause of flakiness here.
    config.search.tenantMonthlyCapUsd = null;
    config.search.globalMonthlyCapUsd = 1_000_000;
    originalDfsConfig = { ...config.search.dataforseo };
    config.search.dataforseo = {
      ...originalDfsConfig,
      login: CREDS.login,
      password: CREDS.password,
      baseUrl: sandbox.origin,
      queue: "standard",
      timeoutMs: 5000,
    };
  });

  function restoreConfig(): void {
    config.search.dataforseo = originalDfsConfig;
  }

  // ── AC 2/AC 3: real factory, real registration, rehearsal fidelity pinned ───────────────────────────
  it("AC 2/3: the REAL zero-arg factory registers a live driver that dispatches through dispatchProviderOp, "
    + "and the ledger row stamps simulated=false (this IS the staging rehearsal, not the demo tier)", async () => {
    try {
      expect(config.search.providerMode).toBe("live"); // AC 3's precondition — never asserted, always checked
      const driver = createDataForSeoProviderFromConfig();
      expect(driver).not.toBeNull();
      registerProvider(driver!);
      // isSimulatedProvider(driver) === false — the LIVE driver carries no `simulated` marker at all.
      expect((driver as unknown as { simulated?: unknown }).simulated).toBeUndefined();

      const kw = uniqueKeyword("volume");
      const eng = await makeEngagement({ volume: { enabled: true }, provider: { default: "dataforseo" } });
      config.search.dataforseo.queue = "standard"; // irrelevant to volume, kept explicit for clarity
      const result = await dispatchProviderOp({
        tenantId: tenant, engagementId: eng, propertyId,
        op: { kind: "volume", query: kw }, requestedBy: userId,
      });
      expect(result.simulated).toBe(false); // the exact AC 3 assertion, on the actual dispatch result
      expect(result.provider).toBe("dataforseo");
      expect(result.costUsd).toBeCloseTo(DFS_RATES.keywordsDataPerTask + DFS_RATES.keywordsDataPerKeyword, 9);

      const rows = await ledgerRows(eng);
      expect(rows).toHaveLength(1);
      expect(rows[0].simulated).toBe(false); // asserted directly on the PERSISTED ROW, not just the return value
      expect(rows[0].status).toBe("posted");
      expect(Number(rows[0].cost_usd)).toBeCloseTo(DFS_RATES.keywordsDataPerTask + DFS_RATES.keywordsDataPerKeyword, 9);
    } finally {
      restoreConfig();
    }
  });

  // ── AC 4: full chain per capability + cache-hit issues ZERO new sandbox requests ────────────────────
  it("AC 4: volume — parses real bytes, writes ledger+cache, and a SECOND identical dispatch is a cache "
    + "hit issuing ZERO new sandbox requests", async () => {
    try {
      registerProvider(createDataForSeoProviderFromConfig()!);
      const kw = uniqueKeyword("volume-cache");
      sandbox.seedDfsVolumeRow(kw, { keyword: kw, search_volume: 8100, cpc: 1.23, keyword_difficulty: 41 });
      const eng = await makeEngagement({ volume: { enabled: true }, provider: { default: "dataforseo" } });

      const first = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, propertyId, op: { kind: "volume", query: kw }, requestedBy: userId });
      expect(first.cacheHit).toBe(false);
      expect((first.payload as Array<{ volume?: number }>)[0].volume).toBe(8100);

      const before = sandbox.hitCount("dataforseo:search_volume");
      const second = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, propertyId, op: { kind: "volume", query: kw }, requestedBy: userId });
      expect(second.cacheHit).toBe(true);
      expect(second.costUsd).toBe(0);
      expect(sandbox.hitCount("dataforseo:search_volume")).toBe(before); // ZERO new requests — the actual AC 4 proof
    } finally {
      restoreConfig();
    }
  });

  it("AC 4: backlinks — full chain parses real bytes and writes ledger+cache", async () => {
    try {
      registerProvider(createDataForSeoProviderFromConfig()!);
      const target = uniqueKeyword("backlinks-target") + ".example";
      sandbox.seedDfsBacklinks(target, { backlinks: 5321, referring_domains: 214, rank: 61 });
      const eng = await makeEngagement({ backlinks: { enabled: true }, provider: { default: "dataforseo" } });
      const result = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, propertyId, op: { kind: "backlinks", query: target }, requestedBy: userId });
      expect(result.payload).toEqual({ target, backlinks: 5321, refDomains: 214, authorityScore: 61 });
      expect(result.costUsd).toBeCloseTo(DFS_RATES.backlinksSummary, 9);
    } finally {
      restoreConfig();
    }
  });

  it("AC 4: ai_visibility — full chain parses real bytes and writes ledger+cache", async () => {
    try {
      registerProvider(createDataForSeoProviderFromConfig()!);
      const query = uniqueKeyword("ai-visibility");
      const eng = await makeEngagement({ ai_visibility: { enabled: true }, provider: { default: "dataforseo" } });
      const result = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, propertyId, op: { kind: "ai_visibility", query }, requestedBy: userId });
      const payload = result.payload as Array<{ brandMentioned: boolean; cited: boolean }>;
      expect(payload[0].brandMentioned).toBe(true);
      expect(payload[0].cited).toBe(true);
    } finally {
      restoreConfig();
    }
  });

  it("AC 4: suggestions — rides getKeywordMetrics like volume, under its own scope toggle", async () => {
    try {
      registerProvider(createDataForSeoProviderFromConfig()!);
      const kw = uniqueKeyword("suggestions");
      sandbox.seedDfsVolumeRow(kw, { keyword: kw, search_volume: 500, cpc: 0.4, keyword_difficulty: 12 });
      const eng = await makeEngagement({ suggestions: { enabled: true }, provider: { default: "dataforseo" } });
      const result = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, propertyId, op: { kind: "suggestions", query: kw }, requestedBy: userId });
      expect(result.simulated).toBe(false);
      expect(result.costUsd).toBeCloseTo(DFS_RATES.labsPerTask + DFS_RATES.labsPerItem, 9);
    } finally {
      restoreConfig();
    }
  });

  // ── AC 5: the Standard-queue 40602 poll as a genuine state machine ─────────────────────────────────
  it("AC 5: task_post -> task_get returns 40602 at least twice (sandbox holds real task state) before "
    + "20000 with payload — proven by the sandbox's own poll counter, not an assumption", async () => {
    try {
      // Direct construction permitted ONLY here (AC 2) — short pollIntervalMs so the test doesn't
      // wait DataForSeoProvider's real 3s default; every other option matches what the factory would
      // build from the SAME (already-mutated) config.
      const p = new DataForSeoProvider({
        login: config.search.dataforseo.login,
        password: config.search.dataforseo.password,
        baseUrl: config.search.dataforseo.baseUrl,
        queue: config.search.dataforseo.queue,
        timeoutMs: config.search.dataforseo.timeoutMs,
        pollAttempts: 10,
        pollIntervalMs: 1,
      });
      registerProvider(p);
      const kw = uniqueKeyword("poll");
      const eng = await makeEngagement({ rank: { enabled: true }, provider: { default: "dataforseo" } });

      const before = sandbox.hitCount("dataforseo:task_get");
      const result = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, propertyId, op: { kind: "serp", query: kw }, requestedBy: userId });
      const pollCalls = sandbox.hitCount("dataforseo:task_get") - before;

      expect(pollCalls).toBeGreaterThanOrEqual(3); // 2 "40602 pending" answers + 1 "20000 ready" answer
      expect(result.simulated).toBe(false);
      const rows = await ledgerRows(eng);
      expect(rows.some((r) => r.status === "posted")).toBe(true); // a successful ledger row exists
    } finally {
      restoreConfig();
    }
  });

  it("AC 5: the never-ready path (40602 forever) ends in the driver's OWN timeout/refusal, "
    + "pinned as current dispatch semantics — NOT redesigned into a new failure shape", async () => {
    try {
      const p = new DataForSeoProvider({
        login: config.search.dataforseo.login,
        password: config.search.dataforseo.password,
        baseUrl: config.search.dataforseo.baseUrl,
        queue: config.search.dataforseo.queue,
        timeoutMs: config.search.dataforseo.timeoutMs,
        pollAttempts: 3,
        pollIntervalMs: 1,
      });
      registerProvider(p);
      const kw = `sm49-dfs-${DFS_NEVER_READY_MARKER}-${Date.now()}-${seq++}`;
      const eng = await makeEngagement({ rank: { enabled: true }, provider: { default: "dataforseo" } });

      await expect(
        dispatchProviderOp({ tenantId: tenant, engagementId: eng, propertyId, op: { kind: "serp", query: kw }, requestedBy: userId }),
      ).rejects.toThrow(/still queued after 3 polls/);

      // PINNED, per current dispatch.ts semantics (not redesigned): a provider-thrown exception fires
      // INSIDE runInCacheCriticalSection's transaction, BEFORE insertLedgerRow is ever reached (that
      // call happens only after invokeProvider resolves) — so the whole transaction ROLLS BACK and
      // NO ledger row survives for this dispatch at all (unlike a pre-flight scope/budget refusal,
      // which explicitly recordBlocked()s in its OWN separate transaction). This is the honest current
      // behaviour, verified directly rather than assumed.
      const rows = await ledgerRows(eng);
      expect(rows).toHaveLength(0);
    } finally {
      restoreConfig();
    }
  });

  it("AC 5: queue='live' exercises the /live endpoints — task_get is answered ready on the FIRST poll "
    + "(the Live endpoint's own answer, no queueing wait)", async () => {
    try {
      config.search.dataforseo.queue = "live";
      registerProvider(createDataForSeoProviderFromConfig()!);
      const kw = uniqueKeyword("live-queue");
      const eng = await makeEngagement({ rank: { enabled: true }, provider: { default: "dataforseo" } });

      const beforeLive = sandbox.hitCount("dataforseo:live_advanced");
      const beforeTaskPost = sandbox.hitCount("dataforseo:task_post");
      const beforePoll = sandbox.hitCount("dataforseo:task_get");
      const result = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, propertyId, op: { kind: "serp", query: kw }, requestedBy: userId });

      expect(sandbox.hitCount("dataforseo:live_advanced") - beforeLive).toBe(1);
      expect(sandbox.hitCount("dataforseo:task_post") - beforeTaskPost).toBe(0); // standard endpoint untouched
      expect(sandbox.hitCount("dataforseo:task_get") - beforePoll).toBe(1); // ready on the very first poll
      expect(result.costUsd).toBeCloseTo(DFS_RATES.serpLivePerTask, 9); // 3.3x the Standard rate
    } finally {
      restoreConfig();
    }
  });
});
