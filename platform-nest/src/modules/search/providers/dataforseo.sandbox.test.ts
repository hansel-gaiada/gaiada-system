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
import {
  startVendorSandbox, DFS_NEVER_READY_MARKER, DFS_TASK_ID_MISMATCH_MARKER, DFS_EXTRA_TASK_MARKER,
  type VendorSandbox,
} from "../../../testing/vendor-sandbox/server";
import { DataForSeoProvider, createDataForSeoProviderFromConfig, DFS_RATES } from "./dataforseo";
import { registerProvider, resetProviders } from "./registry";
import { dispatchProviderOp } from "./dispatch";
import { insertLedgerRow, recordIncurred } from "./ledger";
import { collectRankForTask } from "../rank";

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
      // SM-50 widens this projection with `vendor_ref` (0053) — the never-ready test below asserts it.
      (c) => c.query<{ endpoint: string; cost_usd: string; cache_hit: boolean; status: string; simulated: boolean; vendor_ref: string | null }>(
        `SELECT endpoint, cost_usd, cache_hit, status, simulated, vendor_ref FROM search_provider_calls WHERE engagement_id = $1 ORDER BY created_at`,
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

  it("AC 5 (SM-50: pin FLIPPED): the never-ready path still raises the driver's OWN error, and now "
    + "leaves exactly ONE `incurred` ledger row for the charge the vendor already took", async () => {
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

      // ── SM-50: THIS PIN IS THE TICKET'S ACCEPTANCE EVIDENCE (AC 6, addendum §A11.2 #10) ───────────
      //
      // What it used to assert, and why: `expect(rows).toHaveLength(0)`. The SM-49 agent hit that while
      // writing this very test, and did the right thing — it pinned the ACTUAL behaviour instead of the
      // `failed` row the AC wording implied, and flagged the discrepancy rather than editing a driver to
      // make its expectation true. That flag became SM-50, because the behaviour was not merely
      // under-specified, it was a fail-open: a provider exception fires INSIDE
      // runInCacheCriticalSection's transaction, before insertLedgerRow, so the rollback took the
      // record of a REAL VENDOR CHARGE with it. DataForSEO's Standard queue charges at `task_post`, so
      // this exact path — post, get charged, poll forever, give up — spent money the stop-loss could
      // never see.
      //
      // The pin now asserts the fix, over REAL SOCKETS against the vendor sandbox, which is what makes
      // this the strongest evidence available short of a funded deposit: the real driver, its real HTTP
      // layer, the real dispatch choke-point, real Postgres.
      //
      // The SPLIT §A11.2 #10 requires is deliberate and both halves are pinned: a failure BEFORE the
      // billable point keeps the no-row property (dispatch.test.ts's ExplodingProvider case and
      // incurred-cost.test.ts's AC2 are the negative controls), while a failure AFTER it produces
      // exactly one cost-bearing `incurred` row and still no cache row.
      const rows = await ledgerRows(eng);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("incurred");
      // Standard-queue published rate for the ONE task the sandbox accepted (and therefore billed).
      expect(Number(rows[0].cost_usd)).toBeCloseTo(DFS_RATES.serpStandardPerTask, 9);
      expect(rows[0].cache_hit).toBe(false);
      // Rehearsal fidelity, unchanged from this file's other ACs: the sandbox runs the LIVE path, so the
      // row must NOT be badged simulated. An incurred row that badged itself simulated would put real
      // money into the synthetic ledger, where no live-mode ceiling would ever see it.
      expect(rows[0].simulated).toBe(false);
      // The reconciliation key SM-41 matches vendor console line items on (§A11.1.4) — a real task id
      // minted by the sandbox's task state machine, not a fabricated string.
      expect(rows[0].vendor_ref).toBeTruthy();
      expect(rows[0].endpoint).toBe("dataforseo.serp.incurred_no_data");
    } finally {
      restoreConfig();
    }
  });

  // ── SM-56: THE COLLECT EDGE, PROVEN AT THE TRANSPORT LAYER ────────────────────────────────────────
  //
  // This is the strongest evidence that exists for SM-56 short of a funded DataForSEO deposit, and it is
  // stronger than the function-level repro in qa-adversarial-sm50-14-16-53.test.ts for one specific
  // reason: the count is taken by the SANDBOX, on the far side of a real socket, from bytes the real
  // driver's real HTTP layer actually sent. Nothing in the platform is trusted to report on itself.
  //
  // Why the request COUNT and not the cost: `costUsd === 0` is exactly what a driver that posted a task
  // and then mispriced the op would also report, so a cost assertion cannot tell "did not buy" from
  // "bought and called it free". `hitCount("dataforseo:task_post")` can, because on the DataForSEO
  // Standard queue the `task_post` request IS the purchase (~$0.0006, charged at post — dataforseo.ts's
  // header). Zero posts is therefore not evidence *about* the money; on this vendor's billing model it
  // IS the money.
  it("SM-56: a COLLECT issues exactly ONE task_get and ZERO task_post — counted at the sandbox, over real "
    + "sockets — and writes no new ledger row", async () => {
    try {
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
      const kw = uniqueKeyword("collect");
      const eng = await makeEngagement({ rank: { enabled: true }, provider: { default: "dataforseo" } });
      const set = await withTenants(
        [tenant],
        (c) => c.query<{ id: string }>(
          `INSERT INTO search_keyword_sets (tenant_id, engagement_id, name) VALUES ($1,$2,'SM-56 collect set') RETURNING id`,
          [tenant, eng],
        ),
        { modules: ["search"] },
      );
      const kwRow = await withTenants(
        [tenant],
        (c) => c.query<{ id: string }>(
          `INSERT INTO search_keywords (tenant_id, set_id, keyword, locale) VALUES ($1,$2,$3,'en-US') RETURNING id`,
          [tenant, set.rows[0].id, kw],
        ),
        { modules: ["search"] },
      );
      const keywordId = kwRow.rows[0].id;

      // ── Phase 1: the PURCHASE, and why it is staged rather than driven through a full pull ─────────
      //
      // A full `pullRankForKeyword` would post AND poll to completion AND persist the snapshot in one
      // go — after which a postback for that task is legitimately a DUPLICATE (there is nothing left to
      // collect), which is what the collect edge correctly reports and what the QA repro asserts. The
      // case a postback actually EXISTS for is the opposite one: the purchase happened and the platform
      // does NOT hold the data. So this stages exactly that state — a real task posted through the real
      // driver, its `posted` ledger row recorded, and no snapshot — which is the state a Standard-queue
      // pull leaves whenever its bounded poll gives up before the vendor's crawl finishes.
      const refs = await p.postSerpTasks([{ keyword: kw, locale: "en-US" }]);
      expect(refs).toHaveLength(1);
      // A REAL task id minted by the sandbox's own task state machine, not a fabricated string.
      const taskId = refs[0].id;
      expect(taskId).toBeTruthy();
      // Walk the sandbox's task to ready (its Standard queue answers 40602 twice first) so that Phase 2
      // measures ONE task_get for the collect rather than the collect's own re-polling. These polls are
      // counted BEFORE the counter snapshot below, deliberately.
      await p.fetchSerpResults(refs);

      // The purchase's ledger row, stamped with the vendor's id exactly as dispatch stamps it (0053).
      const ledgerId = await withTenants(
        [tenant],
        (c) => insertLedgerRow(c, {
          tenantId: tenant, engagementId: eng, propertyId, provider: "dataforseo",
          endpoint: "dataforseo.serp", items: 1, costUsd: DFS_RATES.serpStandardPerTask,
          cacheHit: false, status: "posted", requestedBy: userId, simulated: false, vendorRef: taskId,
        }),
        { modules: ["search"] },
      );
      expect(await ledgerRows(eng)).toHaveLength(1);

      // ── Phase 2: the COLLECT. Counters snapshotted immediately before, so the deltas describe this
      // operation alone and nothing that came before it in this file. ────────────────────────────────
      const postsBefore = sandbox.hitCount("dataforseo:task_post");
      const livesBefore = sandbox.hitCount("dataforseo:live_advanced");
      const getsBefore = sandbox.hitCount("dataforseo:task_get");

      const collected = await collectRankForTask({
        tenantId: tenant, engagementId: eng, propertyId, propertyDomain: "sm49-dfs.example.com",
        keyword: { keywordId, keyword: kw, locale: "en-US" }, taskId, requestedBy: userId,
      });

      // THE HEADLINE ASSERTION: a collect costs nothing, proven as bytes-on-the-wire.
      expect(sandbox.hitCount("dataforseo:task_post") - postsBefore).toBe(0);
      // The Live endpoint is the OTHER way to be charged for a SERP ($0.002/task, 3.3x Standard), so it
      // is counted too — closing the "no task_post, but it used the paid live endpoint instead" hole.
      expect(sandbox.hitCount("dataforseo:live_advanced") - livesBefore).toBe(0);
      // Exactly ONE task_get: the sandbox's task is already ready (the pull polled it there), so the
      // collect gets its answer first try. Asserting `toBe(1)` rather than `>= 1` pins that the collect
      // does not re-poll a task it can already read.
      expect(sandbox.hitCount("dataforseo:task_get") - getsBefore).toBe(1);
      expect(collected.status).toBe("collected");
      expect(collected.simulated).toBe(false); // the live path — provenance carried from the paid row

      // NO NEW LEDGER ROW. One charge, one row, still exactly as the purchase left it.
      const rowsAfterCollect = await ledgerRows(eng);
      expect(rowsAfterCollect).toHaveLength(1);
      expect(Number(rowsAfterCollect[0].cost_usd)).toBeCloseTo(DFS_RATES.serpStandardPerTask, 9);
      // The snapshot is attributed to the ORIGINAL paid call — the provenance a collect must carry,
      // since no new call exists to point at.
      const snaps = await withTenants(
        [tenant],
        (c) => c.query<{ provider_call_id: string | null }>(
          `SELECT provider_call_id FROM search_rank_snapshots WHERE keyword_id = $1`, [keywordId],
        ),
        { modules: ["search"] },
      );
      expect(snaps.rows).toHaveLength(1);
      expect(snaps.rows[0].provider_call_id).toBe(ledgerId);

      // ── Phase 3: at-least-once redelivery. Zero requests of ANY kind — it short-circuits on the
      // ledger/snapshot key before the driver is touched. ────────────────────────────────────────────
      const dupPosts = sandbox.hitCount("dataforseo:task_post");
      const dupGets = sandbox.hitCount("dataforseo:task_get");
      const redelivered = await collectRankForTask({
        tenantId: tenant, engagementId: eng, propertyId, propertyDomain: "sm49-dfs.example.com",
        keyword: { keywordId, keyword: kw, locale: "en-US" }, taskId, requestedBy: userId,
      });
      expect(redelivered.status).toBe("duplicate");
      expect(sandbox.hitCount("dataforseo:task_post") - dupPosts).toBe(0);
      expect(sandbox.hitCount("dataforseo:task_get") - dupGets).toBe(0);
      expect(await ledgerRows(eng)).toHaveLength(1);
    } finally {
      restoreConfig();
    }
  });

  it("SM-56 + §A11.1.4: collecting a task that was written off as `incurred` advances THAT row to "
    + "completed at the same cost — over real sockets, with zero task_post", async () => {
    try {
      // This is the two tickets meeting: SM-50's never-ready path leaves an `incurred` row for a real
      // charge that delivered nothing (the test above this block pins that). If the task later completes
      // and the postback arrives, §A11.1.4 says the honest bookkeeping is ONE charge, ONE row, now
      // completed — never a second cost-bearing row and never a re-post to get there.
      //
      // The sandbox's never-ready marker makes a task that NEVER becomes ready, so it cannot also be the
      // task we later collect. Instead the `incurred` row is written for a task the sandbox DOES have
      // real state for: post it, let it become ready, but hand the module a ledger row in `incurred`
      // status — which is exactly the state SM-60's post-success write failure produces for a task the
      // vendor did serve.
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
      const kw = uniqueKeyword("collect-incurred");
      const eng = await makeEngagement({ rank: { enabled: true }, provider: { default: "dataforseo" } });
      const set = await withTenants(
        [tenant],
        (c) => c.query<{ id: string }>(
          `INSERT INTO search_keyword_sets (tenant_id, engagement_id, name) VALUES ($1,$2,'SM-56 incurred set') RETURNING id`,
          [tenant, eng],
        ),
        { modules: ["search"] },
      );
      const kwRow = await withTenants(
        [tenant],
        (c) => c.query<{ id: string }>(
          `INSERT INTO search_keywords (tenant_id, set_id, keyword, locale) VALUES ($1,$2,$3,'en-US') RETURNING id`,
          [tenant, set.rows[0].id, kw],
        ),
        { modules: ["search"] },
      );
      const keywordId = kwRow.rows[0].id;

      // Post through the REAL driver so the task id is genuinely the sandbox's, then drive it ready.
      const refs = await p.postSerpTasks([{ keyword: kw, locale: "en-US" }]);
      expect(refs).toHaveLength(1);
      const taskId = refs[0].id;
      await p.fetchSerpResults(refs); // walks the 40602 -> 20000 state machine to ready

      // The written-off charge, in its own right — recordIncurred's shape (§A11.1.1).
      const ledgerId = await recordIncurred({
        tenantId: tenant, engagementId: eng, propertyId, provider: "dataforseo",
        endpoint: "dataforseo.serp.incurred_write_failed", items: 1,
        costUsd: DFS_RATES.serpStandardPerTask, requestedBy: userId, simulated: false, vendorRef: taskId,
      });

      const postsBefore = sandbox.hitCount("dataforseo:task_post");
      const collected = await collectRankForTask({
        tenantId: tenant, engagementId: eng, propertyId, propertyDomain: "sm49-dfs.example.com",
        keyword: { keywordId, keyword: kw, locale: "en-US" }, taskId, requestedBy: userId,
      });

      expect(collected.status).toBe("collected");
      expect(collected.reconciledIncurred).toBe(true);
      expect(sandbox.hitCount("dataforseo:task_post") - postsBefore).toBe(0); // no re-post to reconcile

      // ONE row, advanced in place, at the SAME cost. `advanceIncurredToCompleted` takes no cost
      // parameter by design, so a reconciliation cannot re-price a charge.
      const rows = (await ledgerRows(eng)).filter((r) => r.vendor_ref === taskId);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("completed");
      expect(Number(rows[0].cost_usd)).toBeCloseTo(DFS_RATES.serpStandardPerTask, 9);

      // And the snapshot is attributed to that same original charge, not to a new call.
      const snaps = await withTenants(
        [tenant],
        (c) => c.query<{ provider_call_id: string | null }>(
          `SELECT provider_call_id FROM search_rank_snapshots WHERE keyword_id = $1`, [keywordId],
        ),
        { modules: ["search"] },
      );
      expect(snaps.rows).toHaveLength(1);
      expect(snaps.rows[0].provider_call_id).toBe(ledgerId);
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

  // ── SM-67 (tracker §6be/§6be.1/§6bc, design addendum §A14.2 refuse-as-not-found) ─────────────────
  // A green sandbox run had never been able to prove this axis before this ticket (§A10.5/§6be's own
  // finding): the harness always echoed the id it was asked for. DFS_TASK_ID_MISMATCH_MARKER is the
  // widening that makes the anomaly expressible at all — over a REAL socket, through the REAL driver.
  it("SM-67: a task_get response echoing a DIFFERENT id than requested is refused — real socket, real "
    + "driver, no ledger row left behind", async () => {
    try {
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
      const kw = `sm49-dfs-${DFS_TASK_ID_MISMATCH_MARKER}-${Date.now()}-${seq++}`;
      const eng = await makeEngagement({ rank: { enabled: true }, provider: { default: "dataforseo" } });

      await expect(
        dispatchProviderOp({ tenantId: tenant, engagementId: eng, propertyId, op: { kind: "serp", query: kw }, requestedBy: userId }),
      ).rejects.toThrow(/40400 Task Not Found\./);

      // SM-50 (§A11.1.3): the post charge is real (a genuine task_post happened, standard-queue billing
      // point), so a compensating `incurred` row is the correct outcome here — same shape as the
      // never-ready path just above, NOT a `posted`/`completed` row (which would mean the mismatched
      // response's data got trusted and written).
      const rows = await ledgerRows(eng);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("incurred");
      expect(Number(rows[0].cost_usd)).toBeCloseTo(DFS_RATES.serpStandardPerTask, 9);
    } finally {
      restoreConfig();
    }
  });

  // ── SM-68 (tracker §6be/§6be.1/§6bc, billing-adjacent) — the response-array bound, over a real socket ─
  it("SM-68: a task_post response widened with ONE unrequested extra task never bills for it — real "
    + "socket, real driver, exactly ONE ledger row for the ONE task actually posted", async () => {
    try {
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
      const kw = `sm49-dfs-${DFS_EXTRA_TASK_MARKER}-${Date.now()}-${seq++}`;
      const eng = await makeEngagement({ rank: { enabled: true }, provider: { default: "dataforseo" } });

      const before = p.getTasksUnmatchedSkippedCount();
      const result = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, propertyId, op: { kind: "serp", query: kw }, requestedBy: userId });

      expect(result.simulated).toBe(false);
      // Exactly the Standard rate for ONE task, never two — the phantom task was never billed.
      expect(result.costUsd).toBeCloseTo(DFS_RATES.serpStandardPerTask, 9);
      expect(p.getTasksUnmatchedSkippedCount()).toBe(before + 1);

      const rows = await ledgerRows(eng);
      expect(rows).toHaveLength(1); // ONE ledger row — not one per response task
      expect(Number(rows[0].cost_usd)).toBeCloseTo(DFS_RATES.serpStandardPerTask, 9);
    } finally {
      restoreConfig();
    }
  });

  // ── SM-69 (tracker §6be/§6bc) — backlinks target identity, over a real socket ──────────────────────
  it("SM-69: a backlinks response echoing a DIFFERENT target than requested still persists the "
    + "REQUESTED target — real socket, real driver, real ledger/cache row", async () => {
    try {
      registerProvider(createDataForSeoProviderFromConfig()!);
      const target = uniqueKeyword("sm69-target") + ".example";
      const vendorEchoed = uniqueKeyword("sm69-vendor-echoed") + ".example";
      // seedDfsBacklinks' `target` field (SM-69's harness widening) wins over the request's own target
      // in the sandbox's response body — modelling a vendor/intermediary echoing a different domain.
      sandbox.seedDfsBacklinks(target, { target: vendorEchoed, backlinks: 42, referring_domains: 3, rank: 7 });
      const eng = await makeEngagement({ backlinks: { enabled: true }, provider: { default: "dataforseo" } });
      const result = await dispatchProviderOp({ tenantId: tenant, engagementId: eng, propertyId, op: { kind: "backlinks", query: target }, requestedBy: userId });

      expect(result.payload).toEqual({ target, backlinks: 42, refDomains: 3, authorityScore: 7 });
      expect((result.payload as { target: string }).target).not.toBe(vendorEchoed);
    } finally {
      restoreConfig();
    }
  });
});
