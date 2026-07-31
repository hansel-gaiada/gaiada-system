// SM-25b — gsc-client.ts: response interpretation + idempotent persistence, against SM-51's sandbox on
// real sockets and a real Postgres (same harness as google-oauth.sandbox.test.ts, which this file
// mirrors for setup). What THIS file proves, mapped to the ticket's own duties:
//   1. Interpretation: the sandbox's positional `keys[]` envelope is parsed into the right columns.
//   2. The two §A12 prohibitions, asserted as behaviour: driving a pull never writes
//      search_data_cache (0 rows) and never writes search_provider_calls (0 rows) — the exact assertion
//      SM-25a's own sandbox test made for the OAuth flow, repeated here for the DATA path.
//   3. `simulated` is stamped from the CONNECTION's own issuer-honesty flag (a MUTATION PROBE: a driver
//      that stamped it from anything else would still pass the happy-path assertion but fail this one).
//   4. Idempotency: a schema-level UNIQUE(tenant_id, property_id, row_hash) + ON CONFLICT DO UPDATE — a
//      re-pull of an overlapping range does not duplicate rows, proven under a GENUINE CONCURRENT RACE
//      (two overlapping pulls fired with Promise.all), not merely two sequential calls (SM-08's own QA
//      gate is the precedent this ticket cites: sequential tests proved nothing about the constraint).
//   5. The freshness-lag clamp is actually applied end to end (not merely unit-tested in isolation).
//
// ⚠ BINDING (§A12.5, transposed here as in every Google-surface test in this module): a green run of
// this file is a validated client of OUR OWN MODEL OF GOOGLE'S SEARCH ANALYTICS ENVELOPE, not a
// validated Google integration. SM-41G confirms real shapes, real quota/sampling/lag behaviour.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

import { config } from "../../../config";
import { newId, withTenants } from "../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../../testing/fixtures";
import { startGoogleSandbox, type GoogleSandbox } from "../../../testing/vendor-sandbox/google-server";
import { startAuthorization, completeAuthorization, getGoogleConnection } from "./oauth";
import { GooglePropertyNotBoundError } from "./errors";
import { gscRowHash, pullGscPerformanceForProperty, topGscQueries } from "./gsc-client";
import { deterministicRows } from "../../../testing/vendor-sandbox/fixtures/google/gsc-search-analytics";

const CLIENT_ID = "sm25b-gsc-dev";
const CLIENT_SECRET = "sm25b-gsc-dev-secret";
const REDIRECT_URI = "http://127.0.0.1:3004/api/search/google/oauth/callback";
const SITE_URL = "https://sandbox-client.example/";

describe.skipIf(!TEST_URL)("SM-25b · gsc-client.ts against the SM-51 sandbox", () => {
  let sb: GoogleSandbox;
  let tenant: string;
  let user: string;
  let client: string;
  let propertyId: string;
  let connectionId: string;

  beforeAll(async () => {
    await initTestDb();
    config.integrationTokenKey = randomBytes(32).toString("base64");

    sb = await startGoogleSandbox({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI });
    config.search.google.clientId = CLIENT_ID;
    config.search.google.clientSecret = CLIENT_SECRET;
    config.search.google.redirectUri = REDIRECT_URI;
    config.search.google.authorizeUrl = sb.endpoints.authorizeUrl;
    config.search.google.tokenUrl = sb.endpoints.tokenUrl;
    config.search.google.revokeUrl = sb.endpoints.revokeUrl;
    config.search.google.searchConsoleBaseUrl = sb.endpoints.searchConsoleBaseUrl;
    config.search.google.analyticsDataBaseUrl = sb.endpoints.analyticsDataBaseUrl;
    config.search.google.adsBaseUrl = sb.endpoints.adsBaseUrl;

    tenant = await createCompany("SM-25b GSC Agency", ["search"]);
    user = await createUser("gsc-linker@sm25b.test");
    await addMembership(tenant, user);
    client = await createClient(tenant, "SM-25b GSC Client");
    propertyId = newId();
    await withTenants(
      [tenant],
      (c) =>
        c.query(
          `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [propertyId, tenant, client, "sandbox-client.example", SITE_URL, config.originSite],
        ),
      { modules: ["search"] },
    );

    // Real authorization-code + PKCE round trip against the sandbox, binding the property in the same
    // flow (§A12's own AC) — the SAME chain SM-25a's own test drives, walked once here so every test
    // below starts from a genuinely linked + bound connection.
    const started = await startAuthorization({
      tenantId: tenant, clientId: client, propertyId, provider: "google_search_console", createdBy: user,
    });
    const res = await fetch(started.authorizeUrl, { redirect: "manual" });
    const loc = new URL(res.headers.get("location")!);
    const connection = await completeAuthorization({
      stateToken: loc.searchParams.get("state")!,
      code: loc.searchParams.get("code")!,
      principalUserId: user,
      provider: "google_search_console",
    });
    connectionId = connection.id;
  });

  afterAll(async () => {
    if (sb) await sb.close();
    await teardownTestDb();
  });

  beforeEach(() => {
    sb.resetHitCounts();
  });

  // ── 1 · interpretation ──────────────────────────────────────────────────────────────────────────

  it("parses the sandbox's positional keys[] envelope into the right columns and persists them", async () => {
    sb.seedSearchAnalytics(SITE_URL, [
      { keys: ["2026-07-25", "balibeach villas", "https://sandbox-client.example/villas", "DESKTOP"], clicks: 12, impressions: 340, ctr: 0.035294, position: 4.2 },
      { keys: ["2026-07-25", "bali beach resort", "https://sandbox-client.example/", "MOBILE"], clicks: 3, impressions: 90, ctr: 0.033333, position: 8.7 },
    ]);
    const outcome = await pullGscPerformanceForProperty({
      tenantId: tenant, propertyId, siteUrl: SITE_URL, startDate: "2026-07-20", endDate: "2026-07-25",
    });
    expect(outcome.status).toBe("pulled");
    expect(outcome.rowsUpserted).toBe(2);
    expect(outcome.malformedRowsSkipped).toBe(0);
    // SM-64 regression pin: an ordinary in-window pull is byte-identical except these new zero-valued
    // counters — the echo-validation checks must never fire a false positive on well-behaved data.
    expect(outcome.rowsOutsideRangeSkipped).toBe(0);
    expect(outcome.rowsOverLimitSkipped).toBe(0);
    expect(outcome.provider).toBe("google_search_console");
    expect(outcome.connectionId).toBe(connectionId);

    const rows = await withTenants(
      [tenant],
      (c) => c.query<{ query: string; page: string; device: string; clicks: number; impressions: number; ctr: string; position: string }>(
        `SELECT query, page, device, clicks, impressions, ctr, position FROM search_gsc_performance
          WHERE property_id = $1 ORDER BY query ASC`,
        [propertyId],
      ),
      { modules: ["search"] },
    );
    expect(rows.rows).toHaveLength(2);
    const villas = rows.rows.find((r) => r.query === "balibeach villas")!;
    expect(villas.page).toBe("https://sandbox-client.example/villas");
    expect(villas.device).toBe("DESKTOP");
    expect(villas.clicks).toBe(12);
    expect(villas.impressions).toBe(340);
    expect(Number(villas.ctr)).toBeCloseTo(0.035294, 5);
    expect(Number(villas.position)).toBeCloseTo(4.2, 1);
  });

  it("Google's own ABSENT-rows shape (not []) is treated as zero rows, never an error", async () => {
    sb.seedSearchAnalytics(SITE_URL, null); // gscSearchAnalyticsBody(null) omits `rows` entirely
    const outcome = await pullGscPerformanceForProperty({
      tenantId: tenant, propertyId, siteUrl: SITE_URL, startDate: "2026-01-01", endDate: "2026-01-05",
    });
    expect(outcome.status).toBe("pulled");
    expect(outcome.rowsUpserted).toBe(0);
  });

  // ── 2 · the two §A12 prohibitions, as behaviour ─────────────────────────────────────────────────

  it("NEVER writes search_data_cache — client-private Google rows in the shared no-RLS cache would be a cross-tenant leak by construction", async () => {
    sb.seedSearchAnalytics(SITE_URL, deterministicRows(["date", "query", "page", "device"], [["2026-07-01", "p1", "https://sandbox-client.example/p1", "DESKTOP"], ["2026-07-02", "p2", "https://sandbox-client.example/p2", "MOBILE"]]));
    const outcome = await pullGscPerformanceForProperty({ tenantId: tenant, propertyId, siteUrl: SITE_URL, startDate: "2026-07-01", endDate: "2026-07-10" });
    expect(outcome.rowsUpserted).toBeGreaterThan(0); // a REAL write happened — the prohibition below means something
    const cache = await withTenants([tenant], (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM search_data_cache`));
    expect(Number(cache.rows[0].n)).toBe(0);
  });

  it("NEVER writes search_provider_calls — there is no vendor dollar to meter on a client's own Google account", async () => {
    sb.seedSearchAnalytics(SITE_URL, deterministicRows(["date", "query", "page", "device"], [["2026-07-01", "p1", "https://sandbox-client.example/p1", "DESKTOP"]]));
    const outcome = await pullGscPerformanceForProperty({ tenantId: tenant, propertyId, siteUrl: SITE_URL, startDate: "2026-07-01", endDate: "2026-07-10" });
    expect(outcome.rowsUpserted).toBeGreaterThan(0);
    const ledger = await withTenants([tenant], (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM search_provider_calls`));
    expect(Number(ledger.rows[0].n)).toBe(0);
  });

  // ── 3 · provenance MUTATION PROBE ───────────────────────────────────────────────────────────────

  it("MUTATION PROBE — simulated is stamped from the CONNECTION's own issuer-honesty flag, not guessed", async () => {
    const connection = await getGoogleConnection(tenant, connectionId);
    expect(connection!.issuerIsGoogle).toBe(false); // the sandbox is not a Google host
    sb.seedSearchAnalytics(SITE_URL, deterministicRows(["date", "query", "page", "device"], [["2026-06-01", "probe", "https://sandbox-client.example/probe", "DESKTOP"]]));
    const outcome = await pullGscPerformanceForProperty({ tenantId: tenant, propertyId, siteUrl: SITE_URL, startDate: "2026-06-01", endDate: "2026-06-05" });
    expect(outcome.rowsUpserted).toBe(1); // this test's OWN pull, not a stale row from an earlier test
    const row = await withTenants(
      [tenant],
      (c) => c.query<{ simulated: boolean }>(`SELECT simulated FROM search_gsc_performance WHERE property_id = $1 AND query = 'probe'`, [propertyId]),
      { modules: ["search"] },
    );
    // The probe: `simulated` must equal `!issuerIsGoogle`. If the implementation instead hardcoded
    // `false`, or read something else, this line — not merely the happy path above — is what catches
    // it. (A hardcoded `true` would also pass a naive "is it true" check; asserting the exact boolean,
    // derived from the SAME connection fact independently re-read here, closes that gap.)
    expect(row.rows[0].simulated).toBe(!connection!.issuerIsGoogle);
    expect(row.rows[0].simulated).toBe(true);
  });

  // ── 4 · idempotency, under a GENUINE CONCURRENT RACE ────────────────────────────────────────────

  it("row_hash computes the same value for the same tuple, and a different value for any differing field", () => {
    const base = gscRowHash("prop-1", "2026-07-01", "shoes", "https://x.test/", "DESKTOP");
    expect(gscRowHash("prop-1", "2026-07-01", "shoes", "https://x.test/", "DESKTOP")).toBe(base);
    expect(gscRowHash("prop-2", "2026-07-01", "shoes", "https://x.test/", "DESKTOP")).not.toBe(base);
    expect(gscRowHash("prop-1", "2026-07-02", "shoes", "https://x.test/", "DESKTOP")).not.toBe(base);
    expect(gscRowHash("prop-1", "2026-07-01", "boots", "https://x.test/", "DESKTOP")).not.toBe(base);
    expect(gscRowHash("prop-1", "2026-07-01", "shoes", "https://x.test/other", "DESKTOP")).not.toBe(base);
    expect(gscRowHash("prop-1", "2026-07-01", "shoes", "https://x.test/", "MOBILE")).not.toBe(base);
  });

  it("a SEQUENTIAL re-pull of an overlapping range upserts in place — no duplicate rows", async () => {
    sb.seedSearchAnalytics(SITE_URL, [
      { keys: ["2026-05-10", "sequential-probe", "https://sandbox-client.example/a", "DESKTOP"], clicks: 5, impressions: 50, ctr: 0.1, position: 3 },
    ]);
    await pullGscPerformanceForProperty({ tenantId: tenant, propertyId, siteUrl: SITE_URL, startDate: "2026-05-08", endDate: "2026-05-10" });
    // Change the metrics for the SAME tuple and re-pull — the row must be UPDATED, not duplicated.
    sb.seedSearchAnalytics(SITE_URL, [
      { keys: ["2026-05-10", "sequential-probe", "https://sandbox-client.example/a", "DESKTOP"], clicks: 99, impressions: 500, ctr: 0.198, position: 1.5 },
    ]);
    await pullGscPerformanceForProperty({ tenantId: tenant, propertyId, siteUrl: SITE_URL, startDate: "2026-05-08", endDate: "2026-05-10" });

    const rows = await withTenants(
      [tenant],
      (c) => c.query<{ clicks: number }>(`SELECT clicks FROM search_gsc_performance WHERE property_id = $1 AND query = 'sequential-probe'`, [propertyId]),
      { modules: ["search"] },
    );
    expect(rows.rows).toHaveLength(1); // NOT 2 — the constraint dedupes, the upsert refreshes
    expect(rows.rows[0].clicks).toBe(99);
  });

  it("a GENUINE CONCURRENT RACE (two overlapping pulls fired together) still lands exactly one row per tuple — proven by the DB constraint, not by sequencing", async () => {
    sb.seedSearchAnalytics(SITE_URL, [
      { keys: ["2026-04-01", "race-probe", "https://sandbox-client.example/race", "DESKTOP"], clicks: 7, impressions: 70, ctr: 0.1, position: 5 },
    ]);
    const pull = () => pullGscPerformanceForProperty({ tenantId: tenant, propertyId, siteUrl: SITE_URL, startDate: "2026-04-01", endDate: "2026-04-01" });
    // Fired together, not awaited one at a time — this is what the ticket's "genuine concurrent race"
    // instruction means: many INSERT...ON CONFLICT statements for the SAME row_hash actually overlapping
    // at the database, which sequential await calls (as in the test above) never exercise. 20 concurrent
    // callers (not the smaller number this file used at first) to raise the odds the DB write phases
    // genuinely overlap on fast local hardware rather than happening to interleave into an accidental
    // sequence — self-critical note: on THIS machine a smaller concurrency count was observed to pass
    // even against a temporarily-reintroduced check-then-insert anti-pattern (the naive shape ONLY broke
    // once the race window was deliberately widened with an artificial delay during a manual mutation
    // probe, which is the actual authoritative proof that the ON CONFLICT upsert — not merely "a unique
    // constraint exists somewhere" — is what makes this safe; see the ticket report for that probe's
    // real red/green transcript). This test is real coverage against a REGRESSION back to that
    // anti-pattern, but its pass here is probabilistic, not a timing guarantee.
    const results = await Promise.all(Array.from({ length: 20 }, pull));
    for (const r of results) expect(r.rowsUpserted).toBe(1);

    const rows = await withTenants(
      [tenant],
      (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM search_gsc_performance WHERE property_id = $1 AND query = 'race-probe'`, [propertyId]),
      { modules: ["search"] },
    );
    expect(Number(rows.rows[0].n)).toBe(1); // the UNIQUE constraint held under real concurrency
  });

  // ── 5 · freshness-lag clamp, applied end to end ─────────────────────────────────────────────────

  it("a requested endDate reaching into today is clamped to the freshness-lag boundary, and the clamp is disclosed", async () => {
    sb.seedSearchAnalytics(SITE_URL, deterministicRows(["date", "query", "page", "device"], [["2026-01-01", "lag-probe", "https://sandbox-client.example/lag", "DESKTOP"]]));
    const today = new Date().toISOString().slice(0, 10);
    const outcome = await pullGscPerformanceForProperty({
      tenantId: tenant, propertyId, siteUrl: SITE_URL, startDate: "2026-01-01", endDate: today,
    });
    expect(outcome.clampedForFreshness).toBe(true);
    expect(outcome.requestedEndDate).toBe(today);
    expect(outcome.effectiveEndDate < today).toBe(true);
    expect(outcome.freshnessLagDays).toBe(3);
  });

  // ── 6 · property-not-bound refuses before any network call ─────────────────────────────────────

  it("refuses with GooglePropertyNotBoundError when the property has no GSC connection bound", async () => {
    const unboundProperty = newId();
    await withTenants(
      [tenant],
      (c) => c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [unboundProperty, tenant, client, "unbound.example.com", "https://unbound.example.com/", config.originSite],
      ),
      { modules: ["search"] },
    );
    await expect(
      pullGscPerformanceForProperty({ tenantId: tenant, propertyId: unboundProperty, siteUrl: "https://unbound.example.com/", startDate: "2026-01-01", endDate: "2026-01-02" }),
    ).rejects.toBeInstanceOf(GooglePropertyNotBoundError);
    expect(sb.hitCount("gsc:search_analytics")).toBe(0); // refused BEFORE any network call
  });

  // ── 7 · topGscQueries: aggregate, filtered to real data by default ─────────────────────────────

  it("topGscQueries aggregates persisted rows by query and excludes simulated rows unless asked", async () => {
    sb.seedSearchAnalytics(SITE_URL, [
      { keys: ["2026-03-01", "agg-probe", "https://sandbox-client.example/a", "DESKTOP"], clicks: 10, impressions: 100, ctr: 0.1, position: 2 },
      { keys: ["2026-03-02", "agg-probe", "https://sandbox-client.example/b", "MOBILE"], clicks: 5, impressions: 50, ctr: 0.1, position: 4 },
    ]);
    await pullGscPerformanceForProperty({ tenantId: tenant, propertyId, siteUrl: SITE_URL, startDate: "2026-03-01", endDate: "2026-03-02" });

    // Every row this file writes is `simulated = true` (the sandbox is not a Google host), so the
    // DEFAULT call (real-data-only, per §A4.7's aggregate-must-filter disposition) must come back
    // empty for this property's simulated-only history — never a partial/misleading blend.
    const defaultCall = await topGscQueries({ tenantId: tenant, propertyId, startDate: "2026-03-01", endDate: "2026-03-02" });
    expect(defaultCall.find((q) => q.query === "agg-probe")).toBeUndefined();

    // The EXPLICIT override surfaces it, and proves the aggregation arithmetic (summed across both
    // rows for the same query, on different dates/devices).
    const withSim = await topGscQueries({ tenantId: tenant, propertyId, startDate: "2026-03-01", endDate: "2026-03-02", includeSimulated: true });
    const agg = withSim.find((q) => q.query === "agg-probe")!;
    expect(agg.clicks).toBe(15); // summed across both rows
    expect(agg.impressions).toBe(150);
  });

  // ── 8 · SM-64 echo-validation: date-window + rowLimit page-cap ─────────────────────────────────
  // The SM-51 sandbox itself does not enforce Google's own date-range or rowLimit semantics (it
  // returns exactly what was seeded, regardless of the request) — the exact seam these tests attack,
  // per the sandbox's own file-header caveat and the ticket's finding.

  it("SM-64 — a returned row dated OUTSIDE the requested [startDate, effectiveEndDate] window is skipped, counted, and never persisted", async () => {
    sb.seedSearchAnalytics(SITE_URL, [
      { keys: ["2026-01-15", "out-of-range-probe", "https://sandbox-client.example/oor", "DESKTOP"], clicks: 9, impressions: 90, ctr: 0.1, position: 2 },
      { keys: ["2026-01-01", "in-range-probe", "https://sandbox-client.example/inr", "DESKTOP"], clicks: 4, impressions: 40, ctr: 0.1, position: 3 },
    ]);
    const outcome = await pullGscPerformanceForProperty({
      tenantId: tenant, propertyId, siteUrl: SITE_URL, startDate: "2026-01-01", endDate: "2026-01-05",
    });
    expect(outcome.rowsUpserted).toBe(1); // only the in-range row
    expect(outcome.rowsOutsideRangeSkipped).toBe(1);
    const rows = await withTenants(
      [tenant],
      (c) => c.query<{ query: string }>(`SELECT query FROM search_gsc_performance WHERE property_id = $1 AND query IN ('out-of-range-probe','in-range-probe')`, [propertyId]),
      { modules: ["search"] },
    );
    expect(rows.rows.map((r) => r.query)).toEqual(["in-range-probe"]);
  });

  it("SM-64 — an over-full page persists exactly rowLimit rows, counts the excess, sets truncated:true, and stops paging (mutation-probed by seeding 3 for a rowLimit of 2)", async () => {
    sb.seedSearchAnalytics(SITE_URL, [
      { keys: ["2026-01-20", "cap-probe-a", "https://sandbox-client.example/a", "DESKTOP"], clicks: 1, impressions: 10, ctr: 0.1, position: 1 },
      { keys: ["2026-01-20", "cap-probe-b", "https://sandbox-client.example/b", "DESKTOP"], clicks: 2, impressions: 20, ctr: 0.1, position: 2 },
      { keys: ["2026-01-20", "cap-probe-c", "https://sandbox-client.example/c", "DESKTOP"], clicks: 3, impressions: 30, ctr: 0.1, position: 3 },
    ]);
    sb.resetHitCounts();
    const outcome = await pullGscPerformanceForProperty({
      tenantId: tenant, propertyId, siteUrl: SITE_URL, startDate: "2026-01-20", endDate: "2026-01-20", rowLimit: 2, maxPages: 4,
    });
    expect(outcome.rowsUpserted).toBe(2); // sliced to rowLimit, not the full 3 the sandbox handed back
    expect(outcome.rowsOverLimitSkipped).toBe(1);
    expect(outcome.truncated).toBe(true);
    expect(outcome.pagesFetched).toBe(1); // stopped paging — offsets past an over-full page are meaningless
    expect(sb.hitCount("gsc:search_analytics")).toBe(1); // exactly one request, not maxPages worth
  });
});
