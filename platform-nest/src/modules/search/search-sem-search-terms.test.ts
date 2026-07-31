// SM-20 — controller + persistence integration for the search-terms sync webhook (design §12 SM-20;
// this ticket's own brief: "a signed webhook that ingests search-term / performance data for SEM
// campaigns, with an idempotent upsert"). LIVE Postgres (RLS actually exercised) + real HTTP — same
// harness as search-rank.test.ts (SM-14/SM-56/SM-63) and search-google-gsc-ga4.test.ts (SM-25b), whose
// admission-check and forced-race techniques this file transposes onto a genuinely different edge: no
// vendor is dispatched here at all (the payload IS the data, not a trigger to re-fetch).
//
// What this file proves, mapped to the ticket's own hazards:
//   1. the shared secret is checked FIRST (before body validation/Cerbos/DB), missing and wrong both
//      refuse with the SAME 401, and an unconfigured secret fails CLOSED (refuses everything) rather
//      than skipping the check.
//   2. the SM-63 admission-check CLASS, applied on THIS edge from day one: a campaignId that resolves
//      but under the WRONG claimed engagementId, and an adGroupId that resolves but under the WRONG
//      campaign, are both refused with the exact SAME 404 as an unknown id — proven by whole-body
//      equality, so the edge cannot be used as an oracle.
//   3. idempotency is a SCHEMA-level guarantee (UNIQUE(tenant_id, campaign_id, row_hash) + INSERT ...
//      ON CONFLICT), proven under a GENUINELY forced concurrent race (an injected delay widens the
//      window, not a hopeful Promise.all that might never collide — the §6ay lesson), AND given a
//      negative control: a hand-written naive check-then-insert competitor against the SAME
//      table/constraint is shown to fail under the identical forced window, which is what gives the
//      production-path race test its teeth (§6bc's negative-control rule).
//   4. never a paid pull: no `search_provider_calls` row, ever.
//   5. a hostile/oversized/malformed payload is always 400, never 500, and never a partial write.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { searchModule } from "./index";
import { resetCoreRollupProviders, syncMetricDefinitions } from "../../rollups/engine";
import { computeSearchTermRowHash, __setIngestRaceDelayMsForTests } from "./sem-search-terms";

vi.mock("../../rbac/cerbos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rbac/cerbos")>();
  return { ...actual, check: vi.fn(async () => ({ allow: true as const })) };
});

const SECRET = "sm20-test-secret-do-not-use-in-prod";
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const asRelay = (id: string) => ({ ...asUser(id), "x-gaiada-search-sem-callback-secret": SECRET });

const URL_PATH = (tenantId: string) => `/api/${tenantId}/modules/search/search-terms/callback`;

describe.skipIf(!TEST_URL)("search-marketing search-terms sync webhook (SM-20)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let uA: string;
  let clientA: string;
  let engagementId: string;
  let propertyId: string;
  let campaignId: string;
  let adGroupId: string;
  let seq = 0;
  const uniqueTerm = (tag: string) => `sm20-${tag}-${Date.now()}-${seq++}`;

  async function makeProperty(): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/properties`, headers: asUser(uA),
      payload: { clientId: clientA, domain: `sm20-${Date.now()}-${seq++}.example.com`, siteUrl: "https://sm20.example.com" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function makeEngagement(propId: string): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/engagements`, headers: asUser(uA),
      payload: { clientId: clientA, propertyId: propId, name: `SM-20 engagement ${seq++}` },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function makeCampaign(engId: string): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/engagements/${engId}/campaigns`, headers: asUser(uA),
      payload: { name: `SM-20 campaign ${seq++}` },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function makeAdGroup(campId: string): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/campaigns/${campId}/ad-groups`, headers: asUser(uA),
      payload: { name: `SM-20 ad group ${seq++}` },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  function oneRowBatch(overrides: Record<string, unknown> = {}) {
    return {
      engagementId, campaignId,
      rows: [{ adGroupId, date: "2026-07-20", term: uniqueTerm("row"), matchType: "exact", impressions: 100, clicks: 5, costMinor: 250, currency: "USD", conversions: 1, convValueMinor: 5000, ...overrides }],
    };
  }

  async function countRowsForCampaign(campId: string): Promise<number> {
    const r = await withTenants([A], (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM search_term_metrics_daily WHERE campaign_id = $1`, [campId]), { modules: ["search"] });
    return Number(r.rows[0].n);
  }

  async function ledgerCount(): Promise<number> {
    const r = await withTenants([A], (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM search_provider_calls`), { modules: ["search"] });
    return Number(r.rows[0].n);
  }

  /** Negative control (§6bc's rule): a hand-written check-then-insert competitor against the SAME
   *  table and the SAME UNIQUE(tenant_id, campaign_id, row_hash) constraint migration 0062 created —
   *  deliberately NOT the production path (which uses INSERT...ON CONFLICT). Used ONLY to prove the
   *  forced race window is real: under it, this shape either throws a genuine Postgres unique_violation
   *  (both callers passed the "not found" check before either INSERT lands) — never silently succeeds
   *  cleanly the way the production path does under the identical window. */
  async function naiveCheckThenInsert(campId: string, agId: string, delayMs: number): Promise<void> {
    const rowHash = computeSearchTermRowHash(campId, agId, "2026-07-25", "naive-race-term", "exact");
    await withTenants(
      [A],
      async (c) => {
        const existing = await c.query<{ id: string }>(
          `SELECT id FROM search_term_metrics_daily WHERE tenant_id = $1 AND campaign_id = $2 AND row_hash = $3`,
          [A, campId, rowHash],
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs)); // the widened window
        if (existing.rows.length > 0) {
          await c.query(`UPDATE search_term_metrics_daily SET impressions = 1, updated_at = now() WHERE id = $1`, [existing.rows[0].id]);
        } else {
          // Deliberately NO ON CONFLICT clause — this is the anti-pattern the production code does NOT use.
          await c.query(
            `INSERT INTO search_term_metrics_daily
               (id, tenant_id, campaign_id, ad_group_id, date, term, match_type, impressions, clicks,
                cost_minor, currency, conversions, conv_value_minor, row_hash, simulated, source, origin_site)
             VALUES ($1,$2,$3,$4,'2026-07-25','naive-race-term','exact',1,0,0,'USD',0,0,$5,false,'ads_scripts',$6)`,
            [newId(), A, campId, agId, rowHash, config.originSite],
          );
        }
      },
      { modules: ["search"] },
    );
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    // Via `config`, not `process.env`: `config` is evaluated at module load, so an env mutation here
    // would leave the controller reading "" and the fail-closed branch would pass every test for the
    // wrong reason. Same pattern as the SM-56 collect-edge suites.
    config.search.semCallbackSecret = SECRET;
    resetModules();
    resetCoreRollupProviders();
    registerModule(searchModule);
    await syncMetricDefinitions();

    A = await createCompany("SM-20 Co", ["search"]);
    uA = await createUser("sm20@a.test");
    await addMembership(A, uA);
    clientA = await createClient(A, "SM-20 Client");

    app = await buildApp();

    propertyId = await makeProperty();
    engagementId = await makeEngagement(propertyId);
    campaignId = await makeCampaign(engagementId);
    adGroupId = await makeAdGroup(campaignId);
  });

  afterAll(async () => {
    config.search.semCallbackSecret = "";
    await app?.close();
    await teardownTestDb();
  });

  afterEach(() => {
    __setIngestRaceDelayMsForTests(0);
    config.search.providerMode = "simulate";
  });

  // ══════════════════════════════════════ THE SECRET, FIRST ════════════════════════════════════════

  describe("the shared secret", () => {
    it("refuses a request with NO secret header — 401", async () => {
      const res = await app.inject({ method: "POST", url: URL_PATH(A), headers: asUser(uA), payload: oneRowBatch() });
      expect(res.statusCode).toBe(401);
    });

    it("refuses a request with the WRONG secret — the SAME 401, same body as missing", async () => {
      const missing = await app.inject({ method: "POST", url: URL_PATH(A), headers: asUser(uA), payload: oneRowBatch() });
      const wrong = await app.inject({
        method: "POST", url: URL_PATH(A),
        headers: { ...asUser(uA), "x-gaiada-search-sem-callback-secret": "totally-wrong" },
        payload: oneRowBatch(),
      });
      expect(wrong.statusCode).toBe(missing.statusCode);
      expect(wrong.json()).toEqual(missing.json());
      expect(await countRowsForCampaign(campaignId)).toBe(0);
    });

    it("uses a DIFFERENT secret from SEARCH_CALLBACK_SECRET — the collect edge's own secret does not authenticate this route", async () => {
      config.search.callbackSecret = "some-other-collect-edge-secret";
      const res = await app.inject({
        method: "POST", url: URL_PATH(A),
        headers: { ...asUser(uA), "x-gaiada-search-sem-callback-secret": config.search.callbackSecret },
        payload: oneRowBatch(),
      });
      expect(res.statusCode).toBe(401);
      config.search.callbackSecret = "";
    });

    it("FAILS CLOSED when SEARCH_SEM_CALLBACK_SECRET is unset — refuses even a correctly-shaped, correctly-headed request", async () => {
      const saved = config.search.semCallbackSecret;
      config.search.semCallbackSecret = "";
      try {
        // Presents the CORRECT secret deliberately. An empty header here would 401 on the
        // compare regardless of whether the fail-closed branch exists, so the test would pass
        // for the wrong reason and stay green if that branch were deleted. Sending a valid
        // secret against an unconfigured server means ONLY fail-closed can produce this 401.
        const res = await app.inject({
          method: "POST", url: URL_PATH(A),
          headers: { ...asUser(uA), "x-gaiada-search-sem-callback-secret": SECRET },
          payload: oneRowBatch(),
        });
        expect(res.statusCode).toBe(401);
        expect(await countRowsForCampaign(campaignId)).toBe(0);
      } finally {
        config.search.semCallbackSecret = saved;
      }
    });

    it("a caller with no valid principal at all is refused before this route is even reached", async () => {
      const res = await app.inject({
        method: "POST", url: URL_PATH(A),
        headers: { authorization: "Bearer svc-token", "x-gaiada-search-sem-callback-secret": SECRET },
        payload: oneRowBatch(),
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ══════════════════════════════════════ HOSTILE PAYLOAD → 400, NEVER 500, NEVER PARTIAL ══════════

  describe("hostile/malformed payloads", () => {
    it("400s on a non-object JSON body (an array), before any DB read", async () => {
      const res = await app.inject({ method: "POST", url: URL_PATH(A), headers: asRelay(uA), payload: [] });
      expect(res.statusCode).toBe(400);
    });

    it("400s when engagementId/campaignId/rows are missing", async () => {
      const res = await app.inject({ method: "POST", url: URL_PATH(A), headers: asRelay(uA), payload: {} });
      expect(res.statusCode).toBe(400);
    });

    it("400s on an empty rows array", async () => {
      const res = await app.inject({ method: "POST", url: URL_PATH(A), headers: asRelay(uA), payload: { engagementId, campaignId, rows: [] } });
      expect(res.statusCode).toBe(400);
    });

    it("400s on an oversized batch (over MAX_ROWS_PER_BATCH), never a 500, never a partial write", async () => {
      const before = await countRowsForCampaign(campaignId);
      const rows = Array.from({ length: 2_001 }, (_, i) => ({ adGroupId, date: "2026-07-20", term: `overflow-${i}` }));
      const res = await app.inject({ method: "POST", url: URL_PATH(A), headers: asRelay(uA), payload: { engagementId, campaignId, rows } });
      expect(res.statusCode).toBe(400);
      expect(await countRowsForCampaign(campaignId)).toBe(before);
    });

    it("400s on a term exceeding the length cap", async () => {
      const res = await app.inject({
        method: "POST", url: URL_PATH(A), headers: asRelay(uA),
        payload: { engagementId, campaignId, rows: [{ adGroupId, date: "2026-07-20", term: "x".repeat(501) }] },
      });
      expect(res.statusCode).toBe(400);
    });

    it("400s on a negative metric — a hostile payload cannot poison a row with a negative number", async () => {
      const res = await app.inject({ method: "POST", url: URL_PATH(A), headers: asRelay(uA), payload: oneRowBatch({ impressions: -5 }) });
      expect(res.statusCode).toBe(400);
    });

    it("400s on a malformed date", async () => {
      const res = await app.inject({ method: "POST", url: URL_PATH(A), headers: asRelay(uA), payload: oneRowBatch({ date: "07/20/2026" }) });
      expect(res.statusCode).toBe(400);
    });

    it("400s on an invalid matchType", async () => {
      const res = await app.inject({ method: "POST", url: URL_PATH(A), headers: asRelay(uA), payload: oneRowBatch({ matchType: "fuzzy" }) });
      expect(res.statusCode).toBe(400);
    });

    it("a malformed campaignId (not uuid-shaped) is a 400, never a raw Postgres 500", async () => {
      const res = await app.inject({ method: "POST", url: URL_PATH(A), headers: asRelay(uA), payload: { ...oneRowBatch(), campaignId: "not-a-uuid" } });
      expect(res.statusCode).toBe(400);
    });
  });

  // ══════════════════════════════════════ SM-63's CLASS: SCOPE, NOT JUST EXISTENCE ══════════════════

  describe("admission check — SM-63's class", () => {
    it("404s for a campaignId that does not exist at all", async () => {
      const res = await app.inject({ method: "POST", url: URL_PATH(A), headers: asRelay(uA), payload: { ...oneRowBatch(), campaignId: newId() } });
      expect(res.statusCode).toBe(404);
    });

    it("404s — SAME body as unknown — when campaignId is REAL but under a DIFFERENT engagement than claimed", async () => {
      const property2 = await makeProperty();
      const engagement2 = await makeEngagement(property2);
      const campaign2 = await makeCampaign(engagement2); // real campaign, but NOT under `engagementId`

      const unknown = await app.inject({ method: "POST", url: URL_PATH(A), headers: asRelay(uA), payload: { ...oneRowBatch(), campaignId: newId() } });
      const wrongScope = await app.inject({
        method: "POST", url: URL_PATH(A), headers: asRelay(uA),
        payload: { engagementId, campaignId: campaign2, rows: oneRowBatch().rows }, // claims OUR engagementId, but campaign2 belongs to engagement2
      });

      expect(wrongScope.statusCode).toBe(404);
      expect(wrongScope.statusCode).toBe(unknown.statusCode);
      // Whole-body equality, not a field-name check — a field-name assertion would pass vacuously if
      // the body ever stopped carrying that field, which is how an oracle sneaks back in unnoticed.
      expect(wrongScope.json()).toEqual(unknown.json());
      expect(await countRowsForCampaign(campaign2)).toBe(0); // nothing was written for the real-but-wrong-scope campaign
    });

    it("404s — nothing written — when a row's adGroupId belongs to a DIFFERENT campaign (same tenant, even same engagement)", async () => {
      const campaignSibling = await makeCampaign(engagementId); // same engagement as campaignId, different campaign
      const adGroupSibling = await makeAdGroup(campaignSibling);

      const before = await countRowsForCampaign(campaignId);
      const res = await app.inject({
        method: "POST", url: URL_PATH(A), headers: asRelay(uA),
        payload: { engagementId, campaignId, rows: [{ adGroupId: adGroupSibling, date: "2026-07-20", term: uniqueTerm("wrong-ag") }] },
      });
      expect(res.statusCode).toBe(404);
      expect(await countRowsForCampaign(campaignId)).toBe(before); // all-or-nothing: the whole batch refused, nothing written
    });

    it("a campaign belonging to a DIFFERENT TENANT is invisible via RLS — refused the same way as unknown", async () => {
      const B = await createCompany("SM-20 Co B", ["search"]);
      const uB = await createUser("sm20-b@b.test");
      await addMembership(B, uB);
      const res = await app.inject({
        method: "POST", url: URL_PATH(B), headers: asRelay(uB),
        payload: oneRowBatch(), // campaignId/engagementId belong to tenant A
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ══════════════════════════════════════ NOT A PAID PULL ═══════════════════════════════════════════

  it("never writes a search_provider_calls ledger row — this is not a paid pull", async () => {
    const before = await ledgerCount();
    const res = await app.inject({ method: "POST", url: URL_PATH(A), headers: asRelay(uA), payload: oneRowBatch() });
    expect(res.statusCode).toBe(200);
    expect(await ledgerCount()).toBe(before);
  });

  // ══════════════════════════════════════ PROVENANCE ═════════════════════════════════════════════════

  it("simulated is stamped from config.search.providerMode at ingest time, on both the response and the persisted row", async () => {
    config.search.providerMode = "simulate";
    const simRes = await app.inject({ method: "POST", url: URL_PATH(A), headers: asRelay(uA), payload: oneRowBatch() });
    expect(simRes.statusCode).toBe(200);
    expect(simRes.json().simulated).toBe(true);

    config.search.providerMode = "live";
    const liveRes = await app.inject({ method: "POST", url: URL_PATH(A), headers: asRelay(uA), payload: oneRowBatch() });
    expect(liveRes.statusCode).toBe(200);
    expect(liveRes.json().simulated).toBe(false);

    const list = await app.inject({ method: "GET", url: `/api/${A}/modules/search/campaigns/${campaignId}/search-terms`, headers: asUser(uA) });
    const rows = list.json() as Array<{ simulated: boolean }>;
    expect(rows.some((r) => r.simulated === true)).toBe(true);
    expect(rows.some((r) => r.simulated === false)).toBe(true);
  });

  // ══════════════════════════════════════ IDEMPOTENCY ═══════════════════════════════════════════════

  describe("idempotent upsert", () => {
    it("a SEQUENTIAL re-post of the same key UPSERTS in place — no duplicate row, values refreshed", async () => {
      const term = uniqueTerm("sequential");
      const first = await app.inject({
        method: "POST", url: URL_PATH(A), headers: asRelay(uA),
        payload: { engagementId, campaignId, rows: [{ adGroupId, date: "2026-07-21", term, impressions: 10, clicks: 1 }] },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().rowsUpserted).toBe(1);

      const second = await app.inject({
        method: "POST", url: URL_PATH(A), headers: asRelay(uA),
        payload: { engagementId, campaignId, rows: [{ adGroupId, date: "2026-07-21", term, impressions: 999, clicks: 42 }] },
      });
      expect(second.statusCode).toBe(200);

      const list = await app.inject({ method: "GET", url: `/api/${A}/modules/search/campaigns/${campaignId}/search-terms`, headers: asUser(uA) });
      const matches = (list.json() as Array<{ term: string; impressions: number; clicks: number }>).filter((r) => r.term === term);
      expect(matches).toHaveLength(1); // NOT 2
      expect(matches[0].impressions).toBe(999);
      expect(matches[0].clicks).toBe(42);
    });

    it("a partially-overlapping batch does not duplicate the overlapping rows", async () => {
      const termOverlap = uniqueTerm("overlap");
      const termOnlyInFirst = uniqueTerm("only-first");
      const termOnlyInSecond = uniqueTerm("only-second");

      const batchA = await app.inject({
        method: "POST", url: URL_PATH(A), headers: asRelay(uA),
        payload: {
          engagementId, campaignId,
          rows: [
            { adGroupId, date: "2026-07-22", term: termOverlap, impressions: 1 },
            { adGroupId, date: "2026-07-22", term: termOnlyInFirst, impressions: 1 },
          ],
        },
      });
      expect(batchA.statusCode).toBe(200);
      expect(batchA.json().rowsUpserted).toBe(2);

      const batchB = await app.inject({
        method: "POST", url: URL_PATH(A), headers: asRelay(uA),
        payload: {
          engagementId, campaignId,
          rows: [
            { adGroupId, date: "2026-07-22", term: termOverlap, impressions: 2 }, // the overlap, changed value
            { adGroupId, date: "2026-07-22", term: termOnlyInSecond, impressions: 1 },
          ],
        },
      });
      expect(batchB.statusCode).toBe(200);

      const list = await app.inject({ method: "GET", url: `/api/${A}/modules/search/campaigns/${campaignId}/search-terms`, headers: asUser(uA) });
      const all = list.json() as Array<{ term: string; impressions: number }>;
      expect(all.filter((r) => r.term === termOverlap)).toHaveLength(1); // never duplicated
      expect(all.find((r) => r.term === termOverlap)?.impressions).toBe(2); // refreshed, not stuck at 1
      expect(all.filter((r) => r.term === termOnlyInFirst)).toHaveLength(1);
      expect(all.filter((r) => r.term === termOnlyInSecond)).toHaveLength(1);
    });

    // ── THE FORCED RACE, AND ITS NEGATIVE CONTROL (§6bc's rule) ─────────────────────────────────────
    it("a GENUINELY FORCED concurrent race on the SAME key lands exactly ONE row — the window is widened, not hoped for", async () => {
      const term = uniqueTerm("race");
      __setIngestRaceDelayMsForTests(150); // widen the window between admission-check and the upsert
      const payload = { engagementId, campaignId, rows: [{ adGroupId, date: "2026-07-23", term, impressions: 7 }] };
      const [a, b] = await Promise.all([
        app.inject({ method: "POST", url: URL_PATH(A), headers: asRelay(uA), payload }),
        app.inject({ method: "POST", url: URL_PATH(A), headers: asRelay(uA), payload }),
      ]);
      __setIngestRaceDelayMsForTests(0);
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);

      const list = await app.inject({ method: "GET", url: `/api/${A}/modules/search/campaigns/${campaignId}/search-terms`, headers: asUser(uA) });
      const matches = (list.json() as Array<{ term: string }>).filter((r) => r.term === term);
      expect(matches).toHaveLength(1); // the UNIQUE constraint + ON CONFLICT held under REAL concurrency
    });

    it("NEGATIVE CONTROL: the SAME forced window breaks a naive check-then-insert competitor against the SAME constraint — proving the window is real and ON CONFLICT is what makes production safe, not merely 'a unique constraint exists'", async () => {
      const results = await Promise.allSettled([
        naiveCheckThenInsert(campaignId, adGroupId, 150),
        naiveCheckThenInsert(campaignId, adGroupId, 150),
      ]);
      const rejected = results.filter((r) => r.status === "rejected");
      // Both callers pass the "not found" SELECT before either INSERT lands (the widened window), so
      // the second INSERT collides with the first at the very UNIQUE constraint this ticket relies on
      // — a genuine Postgres unique_violation (23505), not a silent duplicate and not a clean upsert.
      // This is the teeth: it proves the constraint is real AND that a naive shape does not survive
      // the identical window the production ON CONFLICT path survives cleanly (the test above).
      expect(rejected.length).toBeGreaterThanOrEqual(1);
      for (const r of rejected) {
        if (r.status === "rejected") expect(String((r.reason as { code?: string })?.code ?? r.reason)).toContain("23505");
      }
    });

    it("20 concurrent identical requests (standing, probabilistic assurance) still land exactly one row", async () => {
      const term = uniqueTerm("stress");
      const payload = { engagementId, campaignId, rows: [{ adGroupId, date: "2026-07-24", term, impressions: 3 }] };
      const post = () => app.inject({ method: "POST", url: URL_PATH(A), headers: asRelay(uA), payload });
      const results = await Promise.all(Array.from({ length: 20 }, post));
      for (const r of results) expect(r.statusCode).toBe(200);
      expect(await withTenants([A], (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM search_term_metrics_daily WHERE campaign_id = $1 AND term = $2`, [campaignId, term]), { modules: ["search"] }).then((r) => Number(r.rows[0].n))).toBe(1);
    });
  });

  // ══════════════════════════════════════ THE READER ═════════════════════════════════════════════════

  describe("GET campaigns/:id/search-terms", () => {
    it("404s for a campaign that does not exist", async () => {
      const res = await app.inject({ method: "GET", url: `/api/${A}/modules/search/campaigns/${newId()}/search-terms`, headers: asUser(uA) });
      expect(res.statusCode).toBe(404);
    });

    it("filters by adGroupId and date range", async () => {
      const otherAdGroup = await makeAdGroup(campaignId);
      const term = uniqueTerm("filter");
      await app.inject({
        method: "POST", url: URL_PATH(A), headers: asRelay(uA),
        payload: { engagementId, campaignId, rows: [{ adGroupId: otherAdGroup, date: "2026-06-01", term, impressions: 1 }] },
      });
      const res = await app.inject({
        method: "GET",
        url: `/api/${A}/modules/search/campaigns/${campaignId}/search-terms?adGroupId=${otherAdGroup}&startDate=2026-06-01&endDate=2026-06-01`,
        headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200);
      const rows = res.json() as Array<{ term: string; adGroupId: string }>;
      expect(rows.some((r) => r.term === term && r.adGroupId === otherAdGroup)).toBe(true);
    });
  });
});
