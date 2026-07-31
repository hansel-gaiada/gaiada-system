// SM-14 — controller + persistence integration for rank.ts (design §12 SM-14; tracker §6j "SM-14 ·
// rank tracking", §6s "Still owed on SM-14"). LIVE Postgres (RLS actually exercised) + the real HTTP
// layer — same harness as search-provider-pulls.test.ts (SM-16, whose file this one mirrors almost
// line-for-line: SM-16 transposed SM-14's five duties onto backlinks/ai-visibility; this file is the
// integration coverage those duties were always owed on THIS table and never got before the two
// infra faults). Cerbos stubbed to always-allow (parity is search-cerbos.test.ts's job).
//
// What this file proves, mapped to the ticket's five inherited duties (§6j):
//   1. `simulated` on search_rank_snapshots is stamped from DispatchResult.simulated, NEVER from
//      config.search.providerMode — the MUTATION PROBE below is the pin SM-16's §6aa record names as
//      the template: a simulated driver registered while providerMode says 'live' must STILL stamp
//      simulated=true. If the implementation read config.search.providerMode instead, this exact
//      test would go GREEN when it must be RED.
//   2. the keyword-metrics writer stamps metrics_provider/metrics_simulated in the SAME UPDATE as the
//      metric values — proven via a byte-for-byte match between the pull's HTTP response and the
//      persisted row, PLUS its own mutation probe (duty 1 applies identically to this second writer).
//   3. "absent stays absent" (metrics) and the rank-pull batch analogue (a mid-batch refusal stops
//      the loop but never rolls back already-persisted rows) — proven on live rows, not assumed.
//   4. listKeywords' SELECT widening (AC4, §4i): the GET route is driven over real HTTP and its
//      response is asserted against the EXACT alias names in search.controller.ts's listKeywords
//      SELECT (verified by reading that SELECT directly — lines ~1041-1044 at the time of writing —
//      never against the BFF TypeScript interface or a fixture, per §4i's own stated discipline).
//   5. every route lives on SearchController (rank-pull, metrics-pull, the rank-pulls/callback n8n
//      will hit, rank-snapshots) — proven by driving all four over real HTTP.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { searchModule } from "./index";
import { resetCoreRollupProviders, syncMetricDefinitions } from "../../rollups/engine";
import { MockSearchProvider } from "./providers/mock-provider";
import { registerProvider, resetProviders } from "./providers/registry";
import { createSimulationProviders } from "./providers/simulation";
import { resetGlobalMonthToDateCache } from "./providers/ledger";
import type { KeywordQuery, KeywordMetrics, SearchDataProvider, SerpResult, TaskRef } from "./providers/types";

vi.mock("../../rbac/cerbos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rbac/cerbos")>();
  return { ...actual, check: vi.fn(async () => ({ allow: true as const })) };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

// A driver whose SERP items never match any tracked property's domain — used to force a "not found"
// result deterministically (findPropertyPosition's own honest null state), independent of whatever
// property domain a given test happens to use.
class NeverFoundProvider extends MockSearchProvider {
  async fetchSerpResults(refs: TaskRef[]): Promise<SerpResult[]> {
    return refs.map((ref) => ({
      keyword: ref.keyword,
      items: [{ position: 1, url: "https://totally-unrelated-competitor.test/" }],
      serpFeatures: {},
    }));
  }
}

// A driver that returns NO metrics for one specific keyword string (everything else behaves like
// MockSearchProvider) — the only way to exercise "absent stays absent" (AC3), since MockSearchProvider
// always answers every query it is asked.
function absentFor(missingKeyword: string): SearchDataProvider {
  class AbsentAwareProvider extends MockSearchProvider {
    async getKeywordMetrics(kws: KeywordQuery[]): Promise<KeywordMetrics[]> {
      const answered = await super.getKeywordMetrics(kws);
      return answered.filter((m) => m.keyword !== missingKeyword);
    }
  }
  return new AbsentAwareProvider();
}

describe.skipIf(!TEST_URL)("search-marketing rank + keyword-metrics pulls (SM-14)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let uA: string;
  let clientA: string;
  let seq = 0;
  const uniqueDomain = () => `sm14-${Date.now()}-${seq++}.example.com`;
  const uniqueKeyword = (tag: string) => `sm14-${tag}-${Date.now()}-${seq++}`;

  async function makeProperty(domain?: string): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/properties`, headers: asUser(uA),
      payload: { clientId: clientA, domain: domain ?? uniqueDomain(), siteUrl: "https://sm14.example.com" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function makeEngagement(
    propertyId: string,
    toolScope: Record<string, unknown>,
    providerBudgetUsd = 100,
  ): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/engagements`, headers: asUser(uA),
      payload: { clientId: clientA, propertyId, name: `SM-14 engagement ${seq++}`, toolScope, providerBudgetUsd },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function makeKeywordSet(engagementId: string): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/keyword-sets`, headers: asUser(uA),
      payload: { engagementId, name: `SM-14 set ${seq++}`, source: "research" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  /** Imports one keyword by text and returns its id (via listKeywords — import itself only returns
   *  counts). Optionally marks it tracked (required for rank-pull's `is_tracked = true` filter;
   *  metrics-pull has no such filter). */
  async function makeKeyword(setId: string, keyword: string, opts: { tracked?: boolean } = {}): Promise<string> {
    const imp = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/keyword-sets/${setId}/import`, headers: asUser(uA),
      payload: { text: keyword },
    });
    expect(imp.statusCode).toBe(200);
    const list = await app.inject({
      method: "GET", url: `/api/${A}/modules/search/keyword-sets/${setId}/keywords`, headers: asUser(uA),
    });
    expect(list.statusCode).toBe(200);
    const row = (list.json() as Array<{ id: string; keyword: string }>).find((k) => k.keyword === keyword);
    if (!row) throw new Error(`keyword ${keyword} not found after import`);
    if (opts.tracked) {
      const patch = await app.inject({
        method: "PATCH", url: `/api/${A}/modules/search/keywords/${row.id}`, headers: asUser(uA),
        payload: { isTracked: true },
      });
      expect(patch.statusCode).toBe(200);
    }
    return row.id;
  }

  async function outboxEvents(entityId: string, eventType: string): Promise<number> {
    const r = await withTenants(
      [A],
      (c) => c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM outbox_events WHERE tenant_id = $1 AND entity_id = $2 AND event_type = $3`,
        [A, entityId, eventType],
      ),
    );
    return Number(r.rows[0].n);
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    registerModule(searchModule);
    await syncMetricDefinitions();

    A = await createCompany("SM14 Co A", ["search"]);
    uA = await createUser("sm14-a@a.test");
    await addMembership(A, uA);
    clientA = await createClient(A, "SM14 Client of A");

    app = await buildApp();
  });

  afterAll(async () => {
    resetProviders();
    config.search.providerMode = "live";
    await app?.close();
    await teardownTestDb();
  });

  beforeEach(() => {
    resetProviders();
    config.search.tenantMonthlyCapUsd = null;
    config.search.globalMonthlyCapUsd = 1_000_000;
    config.search.budgetWarnRatio = 0.8;
    resetGlobalMonthToDateCache();
  });

  afterEach(() => {
    resetProviders();
    config.search.providerMode = "live";
  });

  // ═══════════════════════════════════════════ RANK PULL ══════════════════════════════════════════

  describe("POST engagements/:id/rank-pull", () => {
    it("happy path: persists one snapshot stamped from a REAL (non-simulated) driver, position found, provenance atomic with the payload", async () => {
      registerProvider(new MockSearchProvider()); // fixed SERP item: position 1, https://example.com/
      config.search.providerMode = "live";
      const property = await makeProperty("example.com"); // matches the mock's fixed URL exactly
      const eng = await makeEngagement(property, { rank: { enabled: true, cadence: "weekly", maxKeywords: 50 } });
      const set = await makeKeywordSet(eng);
      const kwText = uniqueKeyword("happy");
      const kwId = await makeKeyword(set, kwText, { tracked: true });

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${eng}/rank-pull`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.attempted).toBe(1);
      expect(body.pulled).toBe(1);
      const outcome = body.results[0];
      expect(outcome.status).toBe("pulled");
      expect(outcome.position).toBe(1);
      expect(outcome.rankedUrl).toBe("https://example.com/");
      expect(outcome.provider).toBe("dataforseo");
      expect(outcome.simulated).toBe(false);
      expect(outcome.dropped).toBe(false); // first-ever snapshot, nothing to regress from

      const row = await withTenants(
        [A],
        (c) => c.query(
          `SELECT position, ranked_url AS "rankedUrl", provider, simulated, provider_call_id AS "providerCallId"
             FROM search_rank_snapshots WHERE property_id = $1 AND keyword_id = $2`,
          [property, kwId],
        ),
        { modules: ["search"] },
      );
      expect(row.rows.length).toBe(1);
      expect(row.rows[0].position).toBe(1);
      expect(row.rows[0].rankedUrl).toBe("https://example.com/");
      expect(row.rows[0].provider).toBe("dataforseo");
      expect(row.rows[0].simulated).toBe(false);
      expect(row.rows[0].providerCallId).not.toBeNull(); // real dispatch -> a real ledger row backs it
    });

    it("MUTATION PROBE (duty 1): a simulated driver registered while providerMode says 'live' STILL stamps simulated=true — proves the stamp reads DispatchResult.simulated, not config.search.providerMode", async () => {
      for (const p of createSimulationProviders()) registerProvider(p);
      config.search.providerMode = "live"; // deliberate misconfiguration (main.ts makes this a boot
      // error in prod, §A4.3) — the one scenario where DispatchResult.simulated and
      // (config.search.providerMode === 'simulate') DISAGREE, which is exactly what this pin needs.
      const property = await makeProperty();
      const eng = await makeEngagement(property, { rank: { enabled: true, cadence: "weekly", maxKeywords: 50 } });
      const set = await makeKeywordSet(eng);
      const kwText = uniqueKeyword("mutprobe");
      const kwId = await makeKeyword(set, kwText, { tracked: true });

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${eng}/rank-pull`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200);
      const outcome = res.json().results[0];
      // If the implementation were `simulated: config.search.providerMode === "simulate"` this would
      // read `false` here (mode is 'live') — it must read `true` (the DRIVER is simulated).
      expect(outcome.simulated).toBe(true);

      const row = await withTenants(
        [A],
        (c) => c.query(`SELECT simulated FROM search_rank_snapshots WHERE property_id = $1 AND keyword_id = $2`, [property, kwId]),
        { modules: ["search"] },
      );
      expect(row.rows.length).toBe(1);
      expect(row.rows[0].simulated).toBe(true);
    });

    it("refuses naming the toggle when the engagement's rank scope is disabled (budget stop-loss gate)", async () => {
      registerProvider(new MockSearchProvider());
      config.search.providerMode = "live";
      const property = await makeProperty();
      const eng = await makeEngagement(property, { rank: { enabled: false } });
      const set = await makeKeywordSet(eng);
      await makeKeyword(set, uniqueKeyword("disabled"), { tracked: true });

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${eng}/rank-pull`, headers: asUser(uA),
      });
      // SM-53 (tracker §6aa) mapped typed dispatch refusals off the message-less 500 onto 409/503;
      // scope_disabled -> 409 with the actionable substring (which toggle to enable).
      expect(res.statusCode).toBe(200); // batch route: refusal is captured PER keyword, not thrown as HTTP
      const body = res.json();
      expect(body.results[0].status).toBe("skipped");
      expect(body.results[0].reason).toBe("scope_disabled");
      expect(body.skipped).toBe(1);

      const rows = await withTenants(
        [A], (c) => c.query(`SELECT 1 FROM search_rank_snapshots WHERE property_id = $1`, [property]),
        { modules: ["search"] },
      );
      expect(rows.rows.length).toBe(0);
    });

    it("detects + emits search.rank.dropped when a keyword goes from a prior found position to not-found", async () => {
      registerProvider(new NeverFoundProvider());
      config.search.providerMode = "live";
      const property = await makeProperty();
      const eng = await makeEngagement(property, { rank: { enabled: true } });
      const set = await makeKeywordSet(eng);
      const kwText = uniqueKeyword("drop");
      const kwId = await makeKeyword(set, kwText, { tracked: true });

      // Seed a prior snapshot at a real position (engine/device default to 'google'/'desktop', the
      // same defaults pullRankForKeyword's own lookup query uses) so the new not-found pull reads as
      // a genuine regression.
      await withTenants(
        [A],
        (c) => c.query(
          `INSERT INTO search_rank_snapshots (id, tenant_id, property_id, keyword_id, position, provider, simulated)
           VALUES ($1,$2,$3,$4,4,'dataforseo',false)`,
          [newId(), A, property, kwId],
        ),
        { modules: ["search"] },
      );

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${eng}/rank-pull`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200);
      const outcome = res.json().results[0];
      expect(outcome.position).toBeNull();
      expect(outcome.previousPosition).toBe(4);
      expect(outcome.dropped).toBe(true);
      expect(await outboxEvents(property, "search.rank.dropped")).toBe(1);
    });

    it("no drop event on a first-ever not-found pull (nothing to regress from)", async () => {
      registerProvider(new NeverFoundProvider());
      config.search.providerMode = "live";
      const property = await makeProperty();
      const eng = await makeEngagement(property, { rank: { enabled: true } });
      const set = await makeKeywordSet(eng);
      const kwText = uniqueKeyword("firstnf");
      const kwId = await makeKeyword(set, kwText, { tracked: true });

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${eng}/rank-pull`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200);
      const outcome = res.json().results[0];
      expect(outcome.position).toBeNull();
      expect(outcome.previousPosition).toBeNull();
      expect(outcome.dropped).toBe(false);
      expect(await outboxEvents(property, "search.rank.dropped")).toBe(0);
      // and the snapshot itself still persisted despite not-found (a null position is a real capture)
      const rows = await withTenants([A], (c) => c.query(`SELECT 1 FROM search_rank_snapshots WHERE property_id = $1 AND keyword_id = $2`, [property, kwId]), { modules: ["search"] });
      expect(rows.rows.length).toBe(1);
    });

    it("batch shape: a mid-batch budget breach stops the loop, but the already-pulled keyword's snapshot stays persisted", async () => {
      registerProvider(new MockSearchProvider()); // serp rate 0.0006/item (mock-provider.ts RATE_USD)
      config.search.providerMode = "live";
      const property = await makeProperty();
      // Cap tight enough that the FIRST serp dispatch (0.0006) fits but a SECOND would breach.
      const eng = await makeEngagement(property, { rank: { enabled: true } }, 0.0007);
      const set = await makeKeywordSet(eng);
      const k1 = uniqueKeyword("batch-aaa"); // alphabetically first (rank-pull orders k.keyword ASC)
      const k2 = uniqueKeyword("batch-bbb");
      const kw1Id = await makeKeyword(set, k1, { tracked: true });
      const kw2Id = await makeKeyword(set, k2, { tracked: true });

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${eng}/rank-pull`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.attempted).toBe(2);
      expect(body.pulled).toBe(1);
      expect(body.skipped).toBe(1);
      expect(body.results[0].keywordId).toBe(kw1Id);
      expect(body.results[0].status).toBe("pulled");
      expect(body.results[1].keywordId).toBe(kw2Id);
      expect(body.results[1].status).toBe("skipped");

      const kw1Rows = await withTenants([A], (c) => c.query(`SELECT 1 FROM search_rank_snapshots WHERE property_id = $1 AND keyword_id = $2`, [property, kw1Id]), { modules: ["search"] });
      const kw2Rows = await withTenants([A], (c) => c.query(`SELECT 1 FROM search_rank_snapshots WHERE property_id = $1 AND keyword_id = $2`, [property, kw2Id]), { modules: ["search"] });
      expect(kw1Rows.rows.length).toBe(1); // NOT rolled back by kw2's refusal
      expect(kw2Rows.rows.length).toBe(0); // genuinely never dispatched
    });
  });

  describe("GET properties/:id/rank-snapshots — badge, not filter (AC5's own reader duty)", () => {
    it("returns BOTH simulated and real rows unfiltered, each carrying its own flag", async () => {
      const property = await makeProperty();
      const eng = await makeEngagement(property, { rank: { enabled: true } });
      const set = await makeKeywordSet(eng);
      const kwId = await makeKeyword(set, uniqueKeyword("badge"), { tracked: true });

      await withTenants(
        [A],
        async (c) => {
          await c.query(
            `INSERT INTO search_rank_snapshots (id, tenant_id, property_id, keyword_id, position, provider, simulated)
             VALUES ($1,$2,$3,$4,3,'dataforseo',true)`,
            [newId(), A, property, kwId],
          );
          await c.query(
            `INSERT INTO search_rank_snapshots (id, tenant_id, property_id, keyword_id, position, provider, simulated)
             VALUES ($1,$2,$3,$4,7,'dataforseo',false)`,
            [newId(), A, property, kwId],
          );
        },
        { modules: ["search"] },
      );

      const res = await app.inject({
        method: "GET", url: `/api/${A}/modules/search/properties/${property}/rank-snapshots`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200);
      const rows = res.json() as Array<{ simulated: boolean; position: number }>;
      expect(rows.length).toBe(2);
      expect(rows.map((r) => r.simulated).sort()).toEqual([false, true]);
    });
  });

  // ══════════════════════════════════════ RANK-PULLS CALLBACK (AC5) ═══════════════════════════════

  // ══════════════════════════ SM-56: rank-pulls/callback is now a COLLECT edge ═══════════════════════
  // These two tests are the SM-14 pins for this route, REWRITTEN because SM-56 changed the route's
  // contract on purpose (§6ab's lesson: changing a contract means finding every pin — the compiler
  // cannot find these, so they were grepped for and updated deliberately rather than discovered by a
  // red build). What changed: the secret header is now required, `taskId` is required and must name a
  // task THIS TENANT HAS A PAID LEDGER ROW FOR, and the outcome status is `collected`/`duplicate`
  // rather than `pulled`.
  describe("POST rank-pulls/callback — the Standard-queue COLLECT edge n8n will hit (SM-56)", () => {
    const SECRET = "sm56-callback-secret-value";
    // A DIFFERENT length as well as different bytes, so a wrong-secret test cannot pass merely because
    // the comparison length-checks before comparing content.
    const WRONG_SECRET = "sm56-wrong";

    /** The header the collect edge requires, alongside the UNCHANGED user/service auth (`asUser`). */
    const asRelay = (id: string) => ({ ...asUser(id), "x-gaiada-search-callback-secret": SECRET });

    // The secret is now parsed once in config.ts (`config.search.callbackSecret`), like every other env
    // in this codebase, so these tests set CONFIG rather than `process.env`. That is not a workaround
    // for the refactor: `config` is evaluated at module load, so mutating `process.env` after import
    // would silently have no effect and these tests would pass while asserting nothing. Setting config
    // directly is also the established house pattern here — see search-provider-pulls.test.ts, which
    // sets `config.search.providerMode` the same way.
    //
    // The CLAIMS are untouched: a valid secret is accepted, a wrong one 401s, and an unset one refuses
    // everything. Only the mechanism for expressing "configured" changed.
    let originalSecret: string;
    beforeEach(() => {
      originalSecret = config.search.callbackSecret;
      config.search.callbackSecret = SECRET;
    });
    afterEach(() => {
      config.search.callbackSecret = originalSecret;
    });

    /** A `posted` ledger row stamped with `vendor_ref = taskId` — i.e. the record of the ORIGINAL paid
     *  `task_post`. The collect edge's admission check requires it: a task id with no paid row is
     *  refused before any vendor call, which is what makes forgery pointless. */
    async function paidCall(eng: string, property: string, taskId: string, opts?: { status?: string; costUsd?: number }): Promise<string> {
      const id = newId();
      await withTenants(
        [A],
        (c) => c.query(
          `INSERT INTO search_provider_calls
             (id, tenant_id, engagement_id, property_id, provider, endpoint, items, cost_usd, cache_hit,
              status, requested_by, simulated, vendor_ref)
           VALUES ($1,$2,$3,$4,'dataforseo','dataforseo.serp',1,$5,false,$6,$7,false,$8)`,
          [id, A, eng, property, opts?.costUsd ?? 0.0006, opts?.status ?? "posted", uA, taskId],
        ),
        { modules: ["search"] },
      );
      return id;
    }

    async function snapshotsFor(property: string, kwId: string) {
      const r = await withTenants(
        [A],
        (c) => c.query<{ id: string; provider_call_id: string | null; simulated: boolean; provider: string | null }>(
          `SELECT id, provider_call_id, simulated, provider FROM search_rank_snapshots
            WHERE property_id = $1 AND keyword_id = $2`,
          [property, kwId],
        ),
        { modules: ["search"] },
      );
      return r.rows;
    }

    async function ledgerCount(eng: string): Promise<number> {
      const r = await withTenants(
        [A],
        (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM search_provider_calls WHERE engagement_id = $1`, [eng]),
        { modules: ["search"] },
      );
      return Number(r.rows[0].n);
    }

    it("happy path: collects the paid task and persists ONE snapshot attributed to the ORIGINAL paid call", async () => {
      const mock = new MockSearchProvider();
      registerProvider(mock);
      config.search.providerMode = "live";
      // Deliberately NOT domain "example.com" (the happy-path rank-pull test above already owns
      // that exact domain under this client — UNIQUE(tenant_id, client_id, domain), 0034). Position
      // is not the point of this test (that's covered above); proving the route persists a genuine
      // snapshot with the right provenance is.
      const property = await makeProperty();
      const eng = await makeEngagement(property, { rank: { enabled: true } });
      const set = await makeKeywordSet(eng);
      const kwId = await makeKeyword(set, uniqueKeyword("callback"));
      const ledgerId = await paidCall(eng, property, "dfs-task-123");
      const ledgerBefore = await ledgerCount(eng);

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/rank-pulls/callback`, headers: asRelay(uA),
        payload: { engagementId: eng, propertyId: property, keywordId: kwId, taskId: "dfs-task-123" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("collected");
      expect(body.position).toBeNull(); // domain doesn't match the mock's fixed SERP item — honest not-found
      expect(body.provider).toBe("dataforseo");
      expect(body.simulated).toBe(false);
      expect(body.taskId).toBe("dfs-task-123");
      expect(body.reconciledIncurred).toBe(false); // the row was `posted`, so nothing to reconcile

      // THE COLLECT REACHED THE DRIVER, and reached the COLLECT method — not the paid pull pair.
      expect(mock.collectCount).toBe(1);
      // `dispatchCount` only ever advances on a network-shaped PAID call (postSerpTasks/getKeywordMetrics
      // /...). Zero here is the function-level statement of the money property; the transport-level
      // proof (zero `task_post` requests over real sockets) lives in dataforseo.sandbox.test.ts.
      expect(mock.dispatchCount).toBe(0);

      // ONE snapshot, attributed to the ORIGINAL paid ledger row — the provenance that makes a collect
      // honest: this data came from THAT call, and no new call exists to point at.
      const snaps = await snapshotsFor(property, kwId);
      expect(snaps).toHaveLength(1);
      expect(snaps[0].provider_call_id).toBe(ledgerId);
      expect(snaps[0].provider).toBe("dataforseo");
      expect(snaps[0].simulated).toBe(false);

      // AND NO NEW LEDGER ROW. A collect spends nothing, so it meters nothing.
      expect(await ledgerCount(eng)).toBe(ledgerBefore);
    });

    it("AT-LEAST-ONCE DELIVERY: a redelivered postback for the same task id is a 200 no-op — no second snapshot, no second ledger row", async () => {
      // The idempotency AC. Vendor postbacks are at-least-once by nature, so this is the NORMAL case,
      // not an edge case.
      const mock = new MockSearchProvider();
      registerProvider(mock);
      config.search.providerMode = "live";
      const property = await makeProperty();
      const eng = await makeEngagement(property, { rank: { enabled: true } });
      const set = await makeKeywordSet(eng);
      const kwId = await makeKeyword(set, uniqueKeyword("redeliver"));
      await paidCall(eng, property, "dfs-task-dup");
      const ledgerBefore = await ledgerCount(eng);

      const payload = { engagementId: eng, propertyId: property, keywordId: kwId, taskId: "dfs-task-dup" };
      const first = await app.inject({ method: "POST", url: `/api/${A}/modules/search/rank-pulls/callback`, headers: asRelay(uA), payload });
      const second = await app.inject({ method: "POST", url: `/api/${A}/modules/search/rank-pulls/callback`, headers: asRelay(uA), payload });

      expect(first.statusCode).toBe(200);
      expect(first.json().status).toBe("collected");
      // 200, not 4xx: the platform genuinely holds the data, so a correctly-behaving vendor retrying
      // must not be told it failed (which would invite a retry loop over a final outcome).
      expect(second.statusCode).toBe(200);
      expect(second.json().status).toBe("duplicate");

      expect(await snapshotsFor(property, kwId)).toHaveLength(1); // ONE capture, not two
      expect(await ledgerCount(eng)).toBe(ledgerBefore); // and no ledger row either time
      // The second delivery did not even reach the vendor — it short-circuited on the ledger/snapshot
      // key before any fetch. Cheap by construction, which is what makes at-least-once safe here.
      expect(mock.collectCount).toBe(1);
    });

    it("SIMULTANEOUS redeliveries: two concurrent postbacks for one task id still produce exactly ONE snapshot — with the collision window GENUINELY forced open (SM-63)", async () => {
      // The read-then-write race the task-scoped advisory lock exists to close. Without the lock both
      // requests pass the "already collected?" check before either inserts.
      //
      // ── SM-63: THIS TEST USED TO PROVE NOTHING, and the fix is the instrument, not the assertion ────
      // It set `mock.delayMs = 40` to widen the window. `delayMs` is applied inside `MockSearchProvider`'s
      // private `tick()`, and `fetchSerpByTaskId` deliberately never calls `tick()` (a collect must not
      // advance `dispatchCount`) — so the collect path never read the field and the window stayed
      // zero-width. The QA gate demonstrated the consequence the only way that is conclusive: it DELETED
      // the advisory lock from rank.ts and this test stayed GREEN. A green test over an absent lock is
      // worse than no test, because it is cited as coverage.
      //
      // `collectDelayMs` is the knob the collect path actually reads (added in SM-63 for exactly this).
      // 120ms is wide enough that both requests' pre-insert SELECT lands before either INSERT, so with the
      // lock gone both would collect and both would write.
      const COLLECT_DELAY_MS = 120;
      const mock = new MockSearchProvider();
      mock.collectDelayMs = COLLECT_DELAY_MS;
      registerProvider(mock);
      config.search.providerMode = "live";
      const property = await makeProperty();
      const eng = await makeEngagement(property, { rank: { enabled: true } });
      const set = await makeKeywordSet(eng);
      const kwId = await makeKeyword(set, uniqueKeyword("race"));
      await paidCall(eng, property, "dfs-task-race");
      const ledgerBefore = await ledgerCount(eng);

      const payload = { engagementId: eng, propertyId: property, keywordId: kwId, taskId: "dfs-task-race" };
      const startedAt = Date.now();
      const [a, b] = await Promise.all([
        app.inject({ method: "POST", url: `/api/${A}/modules/search/rank-pulls/callback`, headers: asRelay(uA), payload }),
        app.inject({ method: "POST", url: `/api/${A}/modules/search/rank-pulls/callback`, headers: asRelay(uA), payload }),
      ]);
      const elapsedMs = Date.now() - startedAt;

      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);
      // Exactly one of the two collected; the other serialized behind the lock and saw the committed row.
      const statuses = [a.json().status, b.json().status].sort();
      expect(statuses).toEqual(["collected", "duplicate"]);
      expect(await snapshotsFor(property, kwId)).toHaveLength(1);
      expect(await ledgerCount(eng)).toBe(ledgerBefore);
      // The loser never reached the vendor at all — it woke up behind the lock, saw the committed
      // snapshot and short-circuited. This is the second, independent witness that the lock (and not
      // luck) produced the single snapshot: with the lock removed BOTH requests fetch, so this reads 2.
      expect(mock.collectCount).toBe(1);

      // ── The instrument asserts on ITSELF (§6av's lesson: mutation-probe the test, not just the code) ──
      // A `setTimeout(120)` cannot fire early, so a real 120ms collect makes the whole race take at least
      // that long. If a future edit removes the delay from `fetchSerpByTaskId` — reverting this test to the
      // zero-width window it shipped with — elapsed collapses to single-digit ms and THIS line goes red,
      // instead of the suite quietly resuming its old habit of passing over an unforced race. The small
      // slack absorbs timer coarseness only; the gap it is distinguishing is ~120ms versus ~0.
      expect(elapsedMs).toBeGreaterThanOrEqual(COLLECT_DELAY_MS - 10);
    });

    it("SM-50/§A11.1.4: collecting a task written off as `incurred` advances that row to `completed` at the SAME cost — never a second row", async () => {
      const mock = new MockSearchProvider();
      registerProvider(mock);
      config.search.providerMode = "live";
      const property = await makeProperty();
      const eng = await makeEngagement(property, { rank: { enabled: true } });
      const set = await makeKeywordSet(eng);
      const kwId = await makeKeyword(set, uniqueKeyword("incurred-collect"));
      // The shape SM-50/SM-60 leave behind: the vendor was charged and the platform kept nothing.
      const ledgerId = await paidCall(eng, property, "dfs-task-orphan", { status: "incurred", costUsd: 0.0006 });
      const ledgerBefore = await ledgerCount(eng);

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/rank-pulls/callback`, headers: asRelay(uA),
        payload: { engagementId: eng, propertyId: property, keywordId: kwId, taskId: "dfs-task-orphan" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("collected");
      expect(res.json().reconciledIncurred).toBe(true);

      const row = await withTenants(
        [A],
        (c) => c.query<{ status: string; cost_usd: string }>(`SELECT status, cost_usd FROM search_provider_calls WHERE id = $1`, [ledgerId]),
        { modules: ["search"] },
      );
      expect(row.rows[0].status).toBe("completed");
      // SAME cost — `advanceIncurredToCompleted` takes no cost parameter by design, so a caller cannot
      // re-price a charge while "reconciling" it. Asserted as money, because that is what it is.
      expect(Number(row.rows[0].cost_usd)).toBeCloseTo(0.0006, 9);
      expect(await ledgerCount(eng)).toBe(ledgerBefore); // ONE row for ONE charge, advanced not duplicated
    });

    it("401s with NO secret header, and 401s with a WRONG secret — same status, same message, no oracle", async () => {
      registerProvider(new MockSearchProvider());
      config.search.providerMode = "live";
      const property = await makeProperty();
      const eng = await makeEngagement(property, { rank: { enabled: true } });
      const set = await makeKeywordSet(eng);
      const kwId = await makeKeyword(set, uniqueKeyword("unauth"));
      await paidCall(eng, property, "dfs-task-unauth");
      const payload = { engagementId: eng, propertyId: property, keywordId: kwId, taskId: "dfs-task-unauth" };

      // `asUser` alone is the FULL pre-SM-56 credential set (service token + user). It is no longer
      // sufficient — which is the point: the secret is an ADDITIONAL wall, not a replacement.
      const missing = await app.inject({ method: "POST", url: `/api/${A}/modules/search/rank-pulls/callback`, headers: asUser(uA), payload });
      const wrong = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/rank-pulls/callback`,
        headers: { ...asUser(uA), "x-gaiada-search-callback-secret": WRONG_SECRET }, payload,
      });
      expect(missing.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
      // Indistinguishable responses, so the edge cannot be probed for whether a secret is configured.
      expect(wrong.json().error).toBe(missing.json().error);
      // And nothing happened: no snapshot, no vendor call.
      expect(await snapshotsFor(property, kwId)).toHaveLength(0);
    });

    it("FAIL-CLOSED when SEARCH_CALLBACK_SECRET is unset: the route refuses even a caller who presents nothing", async () => {
      // The default posture in every environment today. "No secret configured" must never mean "skip
      // the check" — that is the fail-open shape where forgetting an env var silently disarms a control.
      config.search.callbackSecret = ""; // unset, i.e. an unfinished deployment
      registerProvider(new MockSearchProvider());
      config.search.providerMode = "live";
      const property = await makeProperty();
      const eng = await makeEngagement(property, { rank: { enabled: true } });
      const set = await makeKeywordSet(eng);
      const kwId = await makeKeyword(set, uniqueKeyword("failclosed"));
      await paidCall(eng, property, "dfs-task-failclosed");

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/rank-pulls/callback`,
        headers: { ...asUser(uA), "x-gaiada-search-callback-secret": "" },
        payload: { engagementId: eng, propertyId: property, keywordId: kwId, taskId: "dfs-task-failclosed" },
      });
      expect(res.statusCode).toBe(401);
      expect(await snapshotsFor(property, kwId)).toHaveLength(0);
    });

    it("404s for a task id this tenant has no PAID row for — refused before any vendor call (forgery is pointless)", async () => {
      const mock = new MockSearchProvider();
      registerProvider(mock);
      config.search.providerMode = "live";
      const property = await makeProperty();
      const eng = await makeEngagement(property, { rank: { enabled: true } });
      const set = await makeKeywordSet(eng);
      const kwId = await makeKeyword(set, uniqueKeyword("forged"));
      // NOTE: deliberately NO paidCall() — this is the forged/unknown-task-id case.

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/rank-pulls/callback`, headers: asRelay(uA),
        payload: { engagementId: eng, propertyId: property, keywordId: kwId, taskId: "totally-made-up-task-id" },
      });
      expect(res.statusCode).toBe(404);
      // The money property of the refusal: the driver was never touched, so a forged postback cannot
      // even make us open a socket to the vendor, let alone spend.
      expect(mock.collectCount).toBe(0);
      expect(mock.dispatchCount).toBe(0);
      expect(await snapshotsFor(property, kwId)).toHaveLength(0);
    });

    // ── SM-63 — the same-tenant, WRONG-ENGAGEMENT collect. RLS cannot see this one ──────────────────
    it("SM-63: 404s when the task id's own ledger row belongs to a DIFFERENT engagement/property in the SAME tenant — nothing fetched, nothing written, and the real purchaser's row untouched", async () => {
      const mock = new MockSearchProvider();
      registerProvider(mock);
      config.search.providerMode = "live";

      // The genuine purchaser: engagement 1 / property 1 posted and paid for this task.
      const prop1 = await makeProperty();
      const eng1 = await makeEngagement(prop1, { rank: { enabled: true } });
      const set1 = await makeKeywordSet(eng1);
      const kw1 = await makeKeyword(set1, uniqueKeyword("scope-genuine"));
      const ledgerId = await paidCall(eng1, prop1, "dfs-task-wrong-scope");

      // An unrelated engagement/property in the SAME tenant. Every credential is legitimate and every
      // id it presents is its OWN and mutually consistent (keyword ∈ set ∈ engagement, engagement's
      // property = property) — the controller's cross-linkage checks all pass. The only thing wrong is
      // that ENGAGEMENT 1 paid for this task, which is precisely what the controller cannot see.
      const prop2 = await makeProperty();
      const eng2 = await makeEngagement(prop2, { rank: { enabled: true } });
      const set2 = await makeKeywordSet(eng2);
      const kw2 = await makeKeyword(set2, uniqueKeyword("scope-thief"));

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/rank-pulls/callback`, headers: asRelay(uA),
        payload: { engagementId: eng2, propertyId: prop2, keywordId: kw2, taskId: "dfs-task-wrong-scope" },
      });

      expect(res.statusCode).toBe(404);
      // Refused BEFORE the vendor, like every other refusal on this edge: a wrong-scope replay cannot
      // even make us open a socket.
      expect(mock.collectCount).toBe(0);
      expect(mock.dispatchCount).toBe(0);
      // No snapshot under the wrong scope — the misattribution the defect produced.
      expect(await snapshotsFor(prop2, kw2)).toHaveLength(0);
      // And nothing was stolen from the genuine purchaser either: no snapshot appeared under ITS scope
      // (the refusal is a refusal, not a redirect), and its ledger row is byte-identical.
      expect(await snapshotsFor(prop1, kw1)).toHaveLength(0);
      const row = await withTenants(
        [A],
        (c) => c.query<{ status: string; engagement_id: string; property_id: string }>(
          `SELECT status, engagement_id, property_id FROM search_provider_calls WHERE id = $1`, [ledgerId],
        ),
        { modules: ["search"] },
      );
      expect(row.rows[0].status).toBe("posted");
      expect(row.rows[0].engagement_id).toBe(eng1);
      expect(row.rows[0].property_id).toBe(prop1);

      // NO ORACLE: the response is indistinguishable from a task id that does not exist at all. If these
      // two ever diverge, the edge becomes an enumerator for other engagements' task ids — so the
      // equality is asserted rather than left to a convention two throw sites could drift apart on.
      const unknown = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/rank-pulls/callback`, headers: asRelay(uA),
        payload: { engagementId: eng2, propertyId: prop2, keywordId: kw2, taskId: "dfs-task-does-not-exist-at-all" },
      });
      expect(unknown.statusCode).toBe(res.statusCode);
      // Whole-body equality rather than one field: a field-name assertion would pass vacuously if the
      // body ever stopped carrying that field, which is how an oracle would sneak back in unnoticed.
      expect(unknown.json()).toEqual(res.json());
    });

    it("SM-63 (the money half): a wrong-engagement collect against an `incurred` row does NOT advance someone else's orphaned charge", async () => {
      // The reason this defect was worse than a data-attribution bug. §A11.1.4's `incurred -> completed`
      // advance fires as a side effect of a successful collect, so before SM-63 a caller naming its OWN
      // engagement could silently reconcile a charge belonging to a DIFFERENT one — making an orphaned
      // charge look delivered to SM-41's reconciliation and to every operator watching the incurred list,
      // on the strength of a task id it merely knew.
      const mock = new MockSearchProvider();
      registerProvider(mock);
      config.search.providerMode = "live";

      const prop1 = await makeProperty();
      const eng1 = await makeEngagement(prop1, { rank: { enabled: true } });
      const ledgerId = await paidCall(eng1, prop1, "dfs-task-wrong-scope-incurred", { status: "incurred", costUsd: 0.0006 });

      const prop2 = await makeProperty();
      const eng2 = await makeEngagement(prop2, { rank: { enabled: true } });
      const set2 = await makeKeywordSet(eng2);
      const kw2 = await makeKeyword(set2, uniqueKeyword("scope-thief-incurred"));
      const ledgerBefore1 = await ledgerCount(eng1);
      const ledgerBefore2 = await ledgerCount(eng2);

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/rank-pulls/callback`, headers: asRelay(uA),
        payload: { engagementId: eng2, propertyId: prop2, keywordId: kw2, taskId: "dfs-task-wrong-scope-incurred" },
      });
      expect(res.statusCode).toBe(404);

      const row = await withTenants(
        [A],
        (c) => c.query<{ status: string; cost_usd: string }>(`SELECT status, cost_usd FROM search_provider_calls WHERE id = $1`, [ledgerId]),
        { modules: ["search"] },
      );
      // STILL `incurred`, at the SAME cost. The orphaned charge stays visible as orphaned, which is the
      // honest state: nobody retrieved anything for it.
      expect(row.rows[0].status).toBe("incurred");
      expect(Number(row.rows[0].cost_usd)).toBeCloseTo(0.0006, 9);
      // And a refusal writes no ledger row on either side — a collect is not a spend attempt.
      expect(await ledgerCount(eng1)).toBe(ledgerBefore1);
      expect(await ledgerCount(eng2)).toBe(ledgerBefore2);
      expect(await snapshotsFor(prop2, kw2)).toHaveLength(0);
    });

    it("SM-63: the GENUINE purchaser can still collect the same task id — the new check refuses a mismatch, not the paid-for path", async () => {
      // The other half of any fail-closed check: proving it did not close the legitimate door too. Without
      // this, "refuse everything" would pass the two tests above.
      const mock = new MockSearchProvider();
      registerProvider(mock);
      config.search.providerMode = "live";
      const property = await makeProperty();
      const eng = await makeEngagement(property, { rank: { enabled: true } });
      const set = await makeKeywordSet(eng);
      const kwId = await makeKeyword(set, uniqueKeyword("scope-owner"));
      const ledgerId = await paidCall(eng, property, "dfs-task-right-scope");

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/rank-pulls/callback`, headers: asRelay(uA),
        payload: { engagementId: eng, propertyId: property, keywordId: kwId, taskId: "dfs-task-right-scope" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("collected");
      expect(mock.collectCount).toBe(1);
      const snaps = await snapshotsFor(property, kwId);
      expect(snaps).toHaveLength(1);
      expect(snaps[0].provider_call_id).toBe(ledgerId);
    });

    it("400s when taskId is missing — a collect with nothing to collect must not silently become a paid pull", async () => {
      registerProvider(new MockSearchProvider());
      config.search.providerMode = "live";
      const property = await makeProperty();
      const eng = await makeEngagement(property, { rank: { enabled: true } });
      const set = await makeKeywordSet(eng);
      const kwId = await makeKeyword(set, uniqueKeyword("notask"));

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/rank-pulls/callback`, headers: asRelay(uA),
        payload: { engagementId: eng, propertyId: property, keywordId: kwId },
      });
      expect(res.statusCode).toBe(400);
    });

    it("409s when the engagement's `rank` toggle is off — the collect is free, but the scope authorization still applies", async () => {
      registerProvider(new MockSearchProvider());
      config.search.providerMode = "live";
      const property = await makeProperty();
      const eng = await makeEngagement(property, { rank: { enabled: false } });
      const set = await makeKeywordSet(eng);
      const kwId = await makeKeyword(set, uniqueKeyword("scopeoff"));
      await paidCall(eng, property, "dfs-task-scopeoff");
      const ledgerBefore = await ledgerCount(eng);

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/rank-pulls/callback`, headers: asRelay(uA),
        payload: { engagementId: eng, propertyId: property, keywordId: kwId, taskId: "dfs-task-scopeoff" },
      });
      // 409 + the toggle named, via the SM-53 ProviderDispatchError filter.
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("scope_disabled");
      expect(await snapshotsFor(property, kwId)).toHaveLength(0);
      // A refused COLLECT writes no `failed` ledger row: recordBlocked exists to surface a refused
      // SPEND attempt in a spend panel, and a collect is not one.
      expect(await ledgerCount(eng)).toBe(ledgerBefore);
    });

    it("503s when the resolved driver cannot collect by task id — refused, never downgraded to a re-post", async () => {
      // The whole ticket in one assertion: given a driver with no `fetchSerpByTaskId`, the edge REFUSES
      // rather than falling back to postSerpTasks+fetchSerpResults, because that fallback IS the
      // double-charge. `dispatchCount` staying 0 is what proves no fallback happened.
      const mock = new MockSearchProvider();
      // Strip the collect surface to model a driver that never implemented it — which types.ts makes
      // OPTIONAL precisely so a vendor with no asynchronous queue can decline rather than fake it.
      Object.defineProperty(mock, "fetchSerpByTaskId", { value: undefined, configurable: true });
      registerProvider(mock);
      config.search.providerMode = "live";
      const property = await makeProperty();
      const eng = await makeEngagement(property, { rank: { enabled: true } });
      const set = await makeKeywordSet(eng);
      const kwId = await makeKeyword(set, uniqueKeyword("nocollect"));
      await paidCall(eng, property, "dfs-task-nocollect");

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/rank-pulls/callback`, headers: asRelay(uA),
        payload: { engagementId: eng, propertyId: property, keywordId: kwId, taskId: "dfs-task-nocollect" },
      });
      // 503 comes from provider-dispatch-error.filter.ts's DOCUMENTED default for an unmapped refusal
      // code — pinned here so that default is relied upon knowingly rather than by accident.
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe("collect_unsupported");
      expect(mock.dispatchCount).toBe(0); // NO fallback to the paid path
      expect(await snapshotsFor(property, kwId)).toHaveLength(0);
    });

    it("400s when the keywordId does not belong to the given engagementId (cross-linkage guard)", async () => {
      registerProvider(new MockSearchProvider());
      config.search.providerMode = "live";
      const property = await makeProperty();
      const eng1 = await makeEngagement(property, { rank: { enabled: true } });
      const eng2 = await makeEngagement(property, { rank: { enabled: true } });
      const set1 = await makeKeywordSet(eng1);
      const kwId = await makeKeyword(set1, uniqueKeyword("mismatch"));

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/rank-pulls/callback`, headers: asRelay(uA),
        payload: { engagementId: eng2, propertyId: property, keywordId: kwId, taskId: "dfs-task-x" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ═══════════════════════════════════════════ METRICS PULL ═══════════════════════════════════════

  describe("POST keyword-sets/:id/metrics-pull", () => {
    it("happy path: stamps metrics_provider + metrics_simulated in the SAME update as volume/difficulty/cpc, verified over HTTP via listKeywords' actual response envelope (AC4)", async () => {
      registerProvider(new MockSearchProvider()); // volume:1200, difficulty:37.5, cpcUsd:0.42
      config.search.providerMode = "live";
      const property = await makeProperty();
      const eng = await makeEngagement(property, { volume: { enabled: true } });
      const set = await makeKeywordSet(eng);
      const kwText = uniqueKeyword("metrics-happy");
      const kwId = await makeKeyword(set, kwText);

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/keyword-sets/${set}/metrics-pull`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.attempted).toBe(1);
      expect(body.updated).toBe(1);
      expect(body.results[0].status).toBe("updated");
      expect(body.results[0].volume).toBe(1200);
      expect(body.results[0].provider).toBe("dataforseo");
      expect(body.results[0].simulated).toBe(false);

      // AC4 (§4i discipline): field names below are copied VERBATIM from search.controller.ts's
      // listKeywords SELECT alias list ("metrics_provider AS \"metricsProvider\", metrics_simulated
      // AS \"metricsSimulated\"") — read directly from the controller, not from the BFF interface.
      const list = await app.inject({
        method: "GET", url: `/api/${A}/modules/search/keyword-sets/${set}/keywords`, headers: asUser(uA),
      });
      expect(list.statusCode).toBe(200);
      const row = (list.json() as Array<Record<string, unknown>>).find((k) => k.id === kwId)!;
      expect(row.metricsProvider).toBe("dataforseo");
      expect(row.metricsSimulated).toBe(false);
      expect(Number(row.volume)).toBe(1200);
      expect(Number(row.difficulty)).toBeCloseTo(37.5, 1);
      expect(Number(row.cpcUsd)).toBeCloseTo(0.42, 2);

      const dbRow = await withTenants(
        [A],
        (c) => c.query(
          `SELECT volume, metrics_provider AS "metricsProvider", metrics_simulated AS "metricsSimulated"
             FROM search_keywords WHERE id = $1`,
          [kwId],
        ),
        { modules: ["search"] },
      );
      expect(dbRow.rows[0].volume).toBe(1200);
      expect(dbRow.rows[0].metricsProvider).toBe("dataforseo");
      expect(dbRow.rows[0].metricsSimulated).toBe(false);
    });

    it("MUTATION PROBE (duty 1, second writer): a simulated driver registered while providerMode says 'live' STILL stamps metrics_simulated=true", async () => {
      for (const p of createSimulationProviders()) registerProvider(p);
      config.search.providerMode = "live";
      const property = await makeProperty();
      const eng = await makeEngagement(property, { volume: { enabled: true } });
      const set = await makeKeywordSet(eng);
      const kwId = await makeKeyword(set, uniqueKeyword("metrics-mutprobe"));

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/keyword-sets/${set}/metrics-pull`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200);
      // If the implementation stamped from config.search.providerMode === "simulate" this would read
      // `false` (mode is 'live'); it must read `true` (the DRIVER is simulated).
      expect(res.json().results[0].simulated).toBe(true);

      const row = await withTenants(
        [A],
        (c) => c.query(`SELECT metrics_simulated AS "metricsSimulated" FROM search_keywords WHERE id = $1`, [kwId]),
        { modules: ["search"] },
      );
      expect(row.rows[0].metricsSimulated).toBe(true);
    });

    it("AC3: a keyword absent from the provider's response keeps NULL provider + prior values untouched", async () => {
      const kwText = uniqueKeyword("absent");
      registerProvider(absentFor(kwText));
      config.search.providerMode = "live";
      const property = await makeProperty();
      const eng = await makeEngagement(property, { volume: { enabled: true } });
      const set = await makeKeywordSet(eng);
      const kwId = await makeKeyword(set, kwText);

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/keyword-sets/${set}/metrics-pull`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.absent).toBe(1);
      expect(body.updated).toBe(0);
      expect(body.results[0].status).toBe("absent");

      const row = await withTenants(
        [A],
        (c) => c.query(
          `SELECT volume, metrics_provider AS "metricsProvider", metrics_simulated AS "metricsSimulated"
             FROM search_keywords WHERE id = $1`,
          [kwId],
        ),
        { modules: ["search"] },
      );
      expect(row.rows[0].volume).toBeNull();
      expect(row.rows[0].metricsProvider).toBeNull();
      expect(row.rows[0].metricsSimulated).toBe(false); // NOT NULL DEFAULT false (0048) — never touched, not a guess
    });

    it("AC3: a live re-pull over previously-simulated metrics overwrites value+provider+flag TOGETHER", async () => {
      const property = await makeProperty();
      const eng = await makeEngagement(property, { volume: { enabled: true } });
      const set = await makeKeywordSet(eng);
      const kwId = await makeKeyword(set, uniqueKeyword("overwrite"));

      // First pull: simulated driver.
      for (const p of createSimulationProviders()) registerProvider(p);
      config.search.providerMode = "simulate";
      const first = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/keyword-sets/${set}/metrics-pull`, headers: asUser(uA),
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().results[0].simulated).toBe(true);
      const afterFirst = await withTenants([A], (c) => c.query(`SELECT volume, metrics_provider AS "metricsProvider", metrics_simulated AS "metricsSimulated" FROM search_keywords WHERE id = $1`, [kwId]), { modules: ["search"] });
      expect(afterFirst.rows[0].metricsSimulated).toBe(true);
      const simulatedVolume = afterFirst.rows[0].volume;

      // Second pull: real driver, different (fixed) values.
      resetProviders();
      registerProvider(new MockSearchProvider());
      config.search.providerMode = "live";
      const second = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/keyword-sets/${set}/metrics-pull`, headers: asUser(uA),
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().results[0].simulated).toBe(false);
      expect(second.json().results[0].volume).toBe(1200);

      const afterSecond = await withTenants([A], (c) => c.query(`SELECT volume, metrics_provider AS "metricsProvider", metrics_simulated AS "metricsSimulated" FROM search_keywords WHERE id = $1`, [kwId]), { modules: ["search"] });
      expect(afterSecond.rows[0].metricsProvider).toBe("dataforseo");
      expect(afterSecond.rows[0].metricsSimulated).toBe(false); // flipped atomically with the value
      expect(afterSecond.rows[0].volume).toBe(1200);
      expect(afterSecond.rows[0].volume).not.toBe(simulatedVolume === 1200 ? null : simulatedVolume); // sanity: a genuine overwrite happened
    });

    it("refuses naming the toggle when the engagement's volume scope is disabled", async () => {
      registerProvider(new MockSearchProvider());
      config.search.providerMode = "live";
      const property = await makeProperty();
      const eng = await makeEngagement(property, { volume: { enabled: false } });
      const set = await makeKeywordSet(eng);
      const kwId = await makeKeyword(set, uniqueKeyword("volumedisabled"));

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/keyword-sets/${set}/metrics-pull`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200); // batch route: per-keyword skip, not a thrown HTTP error
      const body = res.json();
      expect(body.results[0].status).toBe("skipped");
      expect(body.results[0].reason).toBe("scope_disabled");

      const row = await withTenants([A], (c) => c.query(`SELECT volume FROM search_keywords WHERE id = $1`, [kwId]), { modules: ["search"] });
      expect(row.rows[0].volume).toBeNull();
    });
  });

  describe("GET keyword-sets/:id/keywords — AC4 (never-pulled keyword's honest NULL/false provenance)", () => {
    it("a keyword with no metrics pull ever shows metricsProvider:null, metricsSimulated:false — never a guessed vendor", async () => {
      const eng = await makeEngagement(await makeProperty(), { volume: { enabled: true } });
      const set = await makeKeywordSet(eng);
      const kwId = await makeKeyword(set, uniqueKeyword("neverpulled"));

      const res = await app.inject({
        method: "GET", url: `/api/${A}/modules/search/keyword-sets/${set}/keywords`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200);
      const row = (res.json() as Array<Record<string, unknown>>).find((k) => k.id === kwId)!;
      expect(row.volume).toBeNull();
      expect(row.metricsProvider).toBeNull();
      expect(row.metricsSimulated).toBe(false);
    });
  });
});
