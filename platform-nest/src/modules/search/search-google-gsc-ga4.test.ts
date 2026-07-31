// SM-25b — controller + persistence integration for the GSC/GA4 read routes (design addendum §A12;
// tracker §6ao "owed" / §6x.3 item 5). Same harness as search-rank.test.ts (real Postgres, real HTTP,
// Cerbos stubbed to always-allow — parity is search-cerbos.test.ts's job) plus SM-51's Google sandbox
// (same setup as google/gsc-client.test.ts / ga4-client.test.ts).
//
// What THIS file proves that the lower-level google/{gsc,ga4}-client.test.ts files do not: every new
// route actually lives on SearchController, is tenancy/auth-gated the same three-wall way as every
// sibling route, and returns exactly what the service layer computed — driven over REAL HTTP, not by
// calling the service function directly.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { randomBytes } from "node:crypto";

import { config } from "../../config";
import { withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { searchModule } from "./index";
import { resetCoreRollupProviders, syncMetricDefinitions } from "../../rollups/engine";
import { startGoogleSandbox, type GoogleSandbox } from "../../testing/vendor-sandbox/google-server";
import { startAuthorization, completeAuthorization } from "./google/oauth";

vi.mock("../../rbac/cerbos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rbac/cerbos")>();
  return { ...actual, check: vi.fn(async () => ({ allow: true as const })) };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const CLIENT_ID = "sm25b-http-dev";
const CLIENT_SECRET = "sm25b-http-dev-secret";
const REDIRECT_URI = "http://127.0.0.1:3004/api/search/google/oauth/callback";
const SITE_URL = "https://sm25b-http.example/";
const GA4_PROPERTY_ID = "987654321";

describe.skipIf(!TEST_URL)("search-marketing GSC + GA4 read routes (SM-25b)", () => {
  let app: NestFastifyApplication;
  let sb: GoogleSandbox;
  let A: string;
  let uA: string;
  let clientA: string;
  let propertyId: string;
  let engagementId: string;

  async function makeProperty(siteUrl: string, domain: string): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/properties`, headers: asUser(uA),
      payload: { clientId: clientA, domain, siteUrl },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function makeEngagement(propId: string): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/engagements`, headers: asUser(uA),
      payload: { clientId: clientA, propertyId: propId, name: "SM-25b engagement" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.integrationTokenKey = randomBytes(32).toString("base64");
    resetModules();
    resetCoreRollupProviders();
    registerModule(searchModule);
    await syncMetricDefinitions();

    sb = await startGoogleSandbox({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI });
    // The sandbox's default GSC site list does not include this file's own SITE_URL — a real Search
    // Console account can only query a site it has PERMISSION on (the sandbox's own 403 modelling of
    // that fact), so this property's site must be added before any searchAnalytics call.
    sb.seedGscSites([{ siteUrl: SITE_URL, permissionLevel: "siteOwner" }]);
    config.search.google.clientId = CLIENT_ID;
    config.search.google.clientSecret = CLIENT_SECRET;
    config.search.google.redirectUri = REDIRECT_URI;
    config.search.google.authorizeUrl = sb.endpoints.authorizeUrl;
    config.search.google.tokenUrl = sb.endpoints.tokenUrl;
    config.search.google.revokeUrl = sb.endpoints.revokeUrl;
    config.search.google.searchConsoleBaseUrl = sb.endpoints.searchConsoleBaseUrl;
    config.search.google.analyticsDataBaseUrl = sb.endpoints.analyticsDataBaseUrl;
    config.search.google.adsBaseUrl = sb.endpoints.adsBaseUrl;

    A = await createCompany("SM-25b HTTP Co", ["search"]);
    uA = await createUser("sm25b-http@a.test");
    await addMembership(A, uA);
    clientA = await createClient(A, "SM-25b HTTP Client");

    app = await buildApp();

    propertyId = await makeProperty(SITE_URL, "sm25b-http.example.com");
    engagementId = await makeEngagement(propertyId);

    // Link + bind BOTH surfaces via the real OAuth chain (service layer — the HTTP callback route is
    // a separate, tenant-agnostic controller already covered by search-google-oauth.controller.test.ts;
    // re-driving it here would duplicate that file's coverage rather than this ticket's own).
    for (const provider of ["google_search_console", "google_analytics"] as const) {
      const started = await startAuthorization({ tenantId: A, clientId: clientA, propertyId, provider, createdBy: uA });
      const res = await fetch(started.authorizeUrl, { redirect: "manual" });
      const loc = new URL(res.headers.get("location")!);
      await completeAuthorization({
        stateToken: loc.searchParams.get("state")!, code: loc.searchParams.get("code")!,
        principalUserId: uA, provider,
      });
    }
  });

  afterAll(async () => {
    if (sb) await sb.close();
    await app?.close();
    await teardownTestDb();
  });

  beforeEach(() => {
    sb.resetHitCounts();
  });

  // ═══════════════════════════════════════════ GSC ═════════════════════════════════════════════════

  describe("POST engagements/:id/gsc-pull + GET properties/:id/gsc-performance", () => {
    it("pulls, persists, and the reader returns exactly what was persisted (badge shape — simulated on every row)", async () => {
      sb.seedSearchAnalytics(SITE_URL, [
        { keys: ["2026-07-20", "http-probe-query", "https://sm25b-http.example/page", "DESKTOP"], clicks: 8, impressions: 80, ctr: 0.1, position: 3.1 },
      ]);
      const pull = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/gsc-pull`, headers: asUser(uA),
        payload: { startDate: "2026-07-15", endDate: "2026-07-20" },
      });
      expect(pull.statusCode).toBe(200);
      const pullBody = pull.json();
      expect(pullBody.status).toBe("pulled");
      expect(pullBody.rowsUpserted).toBe(1);
      expect(pullBody.provider).toBe("google_search_console");

      const list = await app.inject({
        method: "GET", url: `/api/${A}/modules/search/properties/${propertyId}/gsc-performance`, headers: asUser(uA),
      });
      expect(list.statusCode).toBe(200);
      const rows = list.json() as Array<{ query: string; page: string; device: string; clicks: number; simulated: boolean }>;
      const row = rows.find((r) => r.query === "http-probe-query")!;
      expect(row).toBeDefined();
      expect(row.page).toBe("https://sm25b-http.example/page");
      expect(row.device).toBe("DESKTOP");
      expect(row.clicks).toBe(8);
      expect(row.simulated).toBe(true); // badge present on the raw row, per the reader's own AC
    });

    it("404s for an engagement that does not exist, and never reaches the sandbox", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/00000000-0000-0000-0000-000000000000/gsc-pull`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(404);
      expect(sb.hitCount("gsc:search_analytics")).toBe(0);
    });
  });

  describe("GET properties/:id/gsc-performance/top-queries", () => {
    it("requires startDate+endDate and returns the aggregate (includeSimulated=1, since this whole file's data is simulated)", async () => {
      sb.seedSearchAnalytics(SITE_URL, [
        { keys: ["2026-07-18", "top-agg-probe", "https://sm25b-http.example/a", "DESKTOP"], clicks: 20, impressions: 200, ctr: 0.1, position: 2 },
      ]);
      await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/gsc-pull`, headers: asUser(uA),
        payload: { startDate: "2026-07-16", endDate: "2026-07-18" },
      });

      const missingDates = await app.inject({
        method: "GET", url: `/api/${A}/modules/search/properties/${propertyId}/gsc-performance/top-queries`, headers: asUser(uA),
      });
      expect(missingDates.statusCode).toBe(400);

      const res = await app.inject({
        method: "GET",
        url: `/api/${A}/modules/search/properties/${propertyId}/gsc-performance/top-queries?startDate=2026-07-16&endDate=2026-07-18&includeSimulated=1`,
        headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200);
      const top = res.json() as Array<{ query: string; clicks: number }>;
      expect(top.find((q) => q.query === "top-agg-probe")?.clicks).toBe(20);
    });
  });

  describe("POST engagements/:id/gsc-keyword-import", () => {
    it("seeds a NEW keyword set (source='gsc') from persisted GSC queries, idempotent on re-import", async () => {
      sb.seedSearchAnalytics(SITE_URL, [
        { keys: ["2026-07-12", "import-probe-alpha", "https://sm25b-http.example/a", "DESKTOP"], clicks: 15, impressions: 150, ctr: 0.1, position: 2 },
        { keys: ["2026-07-12", "import-probe-beta", "https://sm25b-http.example/b", "MOBILE"], clicks: 1, impressions: 200, ctr: 0.005, position: 9 },
      ]);
      await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/gsc-pull`, headers: asUser(uA),
        payload: { startDate: "2026-07-10", endDate: "2026-07-12" },
      });

      // DEFAULT (includeSimulated omitted): this file's connection is a dev-sandbox link, so the
      // route's own real-data-only default must import NOTHING — the disposition pinned as
      // behaviour, not merely documented in a comment.
      const defaultImp = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/gsc-keyword-import`, headers: asUser(uA),
        payload: { startDate: "2026-07-10", endDate: "2026-07-12", minClicks: 1 },
      });
      expect(defaultImp.statusCode).toBe(200);
      expect(defaultImp.json().imported).toBe(0);

      const imp = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/gsc-keyword-import`, headers: asUser(uA),
        payload: { startDate: "2026-07-10", endDate: "2026-07-12", minClicks: 1, includeSimulated: true },
      });
      expect(imp.statusCode).toBe(200);
      const impBody = imp.json();
      expect(impBody.imported).toBe(2);
      const setId = impBody.setId as string;

      const set = await app.inject({ method: "GET", url: `/api/${A}/modules/search/keyword-sets/${setId}`, headers: asUser(uA) });
      expect(set.json().source).toBe("gsc");

      // Re-import into the SAME set: dedupes via the pre-existing search_keywords UNIQUE constraint
      // (0034), exactly like the CSV importer's own idempotency — never a second copy.
      const reimport = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/gsc-keyword-import`, headers: asUser(uA),
        payload: { setId, startDate: "2026-07-10", endDate: "2026-07-12", minClicks: 1, includeSimulated: true },
      });
      expect(reimport.statusCode).toBe(200);
      expect(reimport.json().imported).toBe(0); // both already present
      expect(reimport.json().duplicates).toBe(2);
    });
  });

  // ═══════════════════════════════════════════ GA4 ══════════════════════════════════════════════════

  describe("POST engagements/:id/ga4-pull + GET properties/:id/ga4-metrics", () => {
    it("requires ga4PropertyId, then pulls/persists/reads", async () => {
      const missing = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/ga4-pull`, headers: asUser(uA),
        payload: {},
      });
      expect(missing.statusCode).toBe(400);

      sb.seedGa4Report(GA4_PROPERTY_ID, {
        dimensionHeaders: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }],
        metricHeaders: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "conversions" }, { name: "totalRevenue" }],
        rows: [{ dimensionValues: [{ value: "20260713" }, { value: "Organic Search" }], metricValues: [{ value: "300" }, { value: "220" }, { value: "5" }, { value: "40" }] }],
        rowCount: 1,
        metadata: { currencyCode: "USD", timeZone: "UTC" },
      });
      const pull = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/ga4-pull`, headers: asUser(uA),
        payload: { ga4PropertyId: GA4_PROPERTY_ID, startDate: "2026-07-10", endDate: "2026-07-13" },
      });
      expect(pull.statusCode).toBe(200);
      expect(pull.json().rowsUpserted).toBe(1);

      const list = await app.inject({
        method: "GET", url: `/api/${A}/modules/search/properties/${propertyId}/ga4-metrics`, headers: asUser(uA),
      });
      expect(list.statusCode).toBe(200);
      const rows = list.json() as Array<{ channelGroup: string; sessions: number; simulated: boolean }>;
      const row = rows.find((r) => r.channelGroup === "Organic Search")!;
      expect(row).toBeDefined();
      expect(row.sessions).toBe(300);
      expect(row.simulated).toBe(true);
    });
  });

  // ═══════════════════════════════════════ THE TWO PROHIBITIONS, OVER HTTP ═══════════════════════════

  it("driving BOTH pulls over real HTTP never writes search_data_cache or search_provider_calls", async () => {
    sb.seedSearchAnalytics(SITE_URL, [{ keys: ["2026-07-05", "prohibition-probe", "https://sm25b-http.example/p", "DESKTOP"], clicks: 1, impressions: 10, ctr: 0.1, position: 5 }]);
    sb.seedGa4Report(GA4_PROPERTY_ID, {
      dimensionHeaders: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }],
      metricHeaders: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "conversions" }, { name: "totalRevenue" }],
      rows: [{ dimensionValues: [{ value: "20260705" }, { value: "Direct" }], metricValues: [{ value: "10" }, { value: "5" }, { value: "0" }, { value: "0" }] }],
      rowCount: 1,
      metadata: { currencyCode: "USD", timeZone: "UTC" },
    });
    await app.inject({
      method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/gsc-pull`, headers: asUser(uA),
      payload: { startDate: "2026-07-01", endDate: "2026-07-05" },
    });
    await app.inject({
      method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/ga4-pull`, headers: asUser(uA),
      payload: { ga4PropertyId: GA4_PROPERTY_ID, startDate: "2026-07-01", endDate: "2026-07-05" },
    });
    const [cache, ledger] = await Promise.all([
      withTenants([A], (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM search_data_cache`)),
      withTenants([A], (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM search_provider_calls`)),
    ]);
    expect(Number(cache.rows[0].n)).toBe(0);
    expect(Number(ledger.rows[0].n)).toBe(0);
  });

  // ═══════════════════════════════════════ TENANCY / AUTH ════════════════════════════════════════════

  it("a caller with no valid principal is refused before touching any Google surface", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/gsc-pull`,
      headers: { authorization: "Bearer svc-token" }, // no x-user-id
    });
    expect(res.statusCode).toBe(401);
  });

  it("a property from another tenant is invisible to this tenant's reader (RLS + tenant choke-point)", async () => {
    const B = await createCompany("SM-25b HTTP Co B", ["search"]);
    const uB = await createUser("sm25b-http-b@b.test");
    await addMembership(B, uB);
    const res = await app.inject({
      method: "GET", url: `/api/${B}/modules/search/properties/${propertyId}/gsc-performance`, headers: asUser(uB),
    });
    expect(res.statusCode).toBe(404); // resolved through tenant B's own RLS-scoped connection — finds nothing
  });
});
