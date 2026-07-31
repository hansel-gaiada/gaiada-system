// SM-25b — ga4-client.ts: response interpretation + idempotent persistence, against SM-51's sandbox.
// Same harness/duties list as gsc-client.test.ts, transposed onto GA4's own wire shape; the one duty
// unique to THIS file is proving the SAMPLING flag is recorded rather than silently averaged away
// (the module's own standing rule, restated in 0061's migration header).
//
// ⚠ BINDING (§A12.5): a green run here is a validated client of OUR OWN MODEL of the GA4 Data API, not
// a validated Google integration.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

import { config } from "../../../config";
import { newId, withTenants } from "../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../../testing/fixtures";
import { startGoogleSandbox, type GoogleSandbox } from "../../../testing/vendor-sandbox/google-server";
import { startAuthorization, completeAuthorization, getGoogleConnection } from "./oauth";
import { GooglePropertyNotBoundError } from "./errors";
import { pullGa4MetricsForProperty } from "./ga4-client";
import { ga4RunReportBody } from "../../../testing/vendor-sandbox/fixtures/google/ga4-run-report";

const CLIENT_ID = "sm25b-ga4-dev";
const CLIENT_SECRET = "sm25b-ga4-dev-secret";
const REDIRECT_URI = "http://127.0.0.1:3004/api/search/google/oauth/callback";
const GA4_PROPERTY_ID = "123456789";

describe.skipIf(!TEST_URL)("SM-25b · ga4-client.ts against the SM-51 sandbox", () => {
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

    tenant = await createCompany("SM-25b GA4 Agency", ["search"]);
    user = await createUser("ga4-linker@sm25b.test");
    await addMembership(tenant, user);
    client = await createClient(tenant, "SM-25b GA4 Client");
    propertyId = newId();
    await withTenants(
      [tenant],
      (c) =>
        c.query(
          `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [propertyId, tenant, client, "sandbox-client.example", "https://sandbox-client.example/", config.originSite],
        ),
      { modules: ["search"] },
    );

    const started = await startAuthorization({
      tenantId: tenant, clientId: client, propertyId, provider: "google_analytics", createdBy: user,
    });
    const res = await fetch(started.authorizeUrl, { redirect: "manual" });
    const loc = new URL(res.headers.get("location")!);
    const connection = await completeAuthorization({
      stateToken: loc.searchParams.get("state")!,
      code: loc.searchParams.get("code")!,
      principalUserId: user,
      provider: "google_analytics",
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

  it("parses GA4's positional, STRING-typed metric values into the right numeric columns", async () => {
    sb.seedGa4Report(
      GA4_PROPERTY_ID,
      ga4RunReportBody({
        dimensionNames: ["date", "sessionDefaultChannelGroup"],
        metricNames: ["sessions", "engagedSessions", "conversions", "totalRevenue"],
        rows: [
          { dimensions: ["20260710", "Organic Search"], metrics: ["420", "310", "12.5", "88.40"] },
          { dimensions: ["20260711", "Direct"], metrics: ["150", "100", "2", "0"] },
        ],
      }),
    );
    const outcome = await pullGa4MetricsForProperty({
      tenantId: tenant, propertyId, ga4PropertyId: GA4_PROPERTY_ID, startDate: "2026-07-01", endDate: "2026-07-11",
    });
    expect(outcome.status).toBe("pulled");
    expect(outcome.rowsUpserted).toBe(2);
    expect(outcome.sampled).toBe(false);
    // SM-64 regression pin: an ordinary in-window pull is byte-identical except this new zero-valued
    // counter.
    expect(outcome.rowsOutsideRangeSkipped).toBe(0);

    const rows = await withTenants(
      [tenant],
      (c) => c.query<{ date: string; channel_group: string; sessions: number; engaged_sessions: number; conversions: string; total_revenue: string }>(
        `SELECT date::text, channel_group, sessions, engaged_sessions, conversions, total_revenue
           FROM search_ga4_metrics WHERE property_id = $1 ORDER BY date ASC`,
        [propertyId],
      ),
      { modules: ["search"] },
    );
    expect(rows.rows).toHaveLength(2);
    // 20260710 (GA4's documented no-separator wire shape) normalized to ISO for the date column.
    expect(rows.rows[0].date).toBe("2026-07-10");
    expect(rows.rows[0].channel_group).toBe("Organic Search");
    expect(rows.rows[0].sessions).toBe(420);
    expect(rows.rows[0].engaged_sessions).toBe(310);
    expect(Number(rows.rows[0].conversions)).toBe(12.5);
    expect(Number(rows.rows[0].total_revenue)).toBe(88.4);
  });

  it("GA4's own ABSENT-rows shape is treated as zero rows, never an error", async () => {
    sb.seedGa4Report(GA4_PROPERTY_ID, ga4RunReportBody({ dimensionNames: ["date"], metricNames: ["sessions"], rows: [] }));
    const outcome = await pullGa4MetricsForProperty({
      tenantId: tenant, propertyId, ga4PropertyId: GA4_PROPERTY_ID, startDate: "2026-02-01", endDate: "2026-02-02",
    });
    expect(outcome.rowsUpserted).toBe(0);
  });

  // ── the sampling duty (the ticket's own standing rule) ─────────────────────────────────────────

  it("SAMPLING: a response carrying metadata.samplingMetadatas is recorded (report-level flag, denormalized onto every row) — never silently averaged into a clean-looking number", async () => {
    const body = ga4RunReportBody({
      dimensionNames: ["date", "sessionDefaultChannelGroup"],
      metricNames: ["sessions", "engagedSessions", "conversions", "totalRevenue"],
      rows: [{ dimensions: ["20260601", "Paid Search"], metrics: ["9999", "5000", "40", "1200"] }],
    });
    (body as { metadata?: Record<string, unknown> }).metadata = {
      ...(body as { metadata?: Record<string, unknown> }).metadata,
      samplingMetadatas: [{ samplesReadCount: "50000", samplingSpaceSize: "5000000" }],
    };
    sb.seedGa4Report(GA4_PROPERTY_ID, body);

    const outcome = await pullGa4MetricsForProperty({
      tenantId: tenant, propertyId, ga4PropertyId: GA4_PROPERTY_ID, startDate: "2026-06-01", endDate: "2026-06-01",
    });
    expect(outcome.sampled).toBe(true);

    const row = await withTenants(
      [tenant],
      (c) => c.query<{ sampled: boolean }>(`SELECT sampled FROM search_ga4_metrics WHERE property_id = $1 AND channel_group = 'Paid Search'`, [propertyId]),
      { modules: ["search"] },
    );
    // The row-level column, not merely the outcome object — a reader of the TABLE (not the pull's own
    // return value) must be able to see this without re-deriving it.
    expect(row.rows[0].sampled).toBe(true);
  });

  it("MUTATION PROBE — an UNSAMPLED response stamps sampled=false, proving the flag is actually READ from the response, not hardcoded true", async () => {
    sb.seedGa4Report(
      GA4_PROPERTY_ID,
      ga4RunReportBody({ dimensionNames: ["date", "sessionDefaultChannelGroup"], metricNames: ["sessions", "engagedSessions", "conversions", "totalRevenue"], rows: [{ dimensions: ["20260201", "Direct"], metrics: ["10", "8", "0", "0"] }] }),
    );
    const outcome = await pullGa4MetricsForProperty({ tenantId: tenant, propertyId, ga4PropertyId: GA4_PROPERTY_ID, startDate: "2026-02-01", endDate: "2026-02-01" });
    expect(outcome.sampled).toBe(false);
  });

  // ── provenance + prohibitions (same shape as gsc-client.test.ts) ───────────────────────────────

  it("MUTATION PROBE — simulated is stamped from the CONNECTION's own issuer-honesty flag", async () => {
    const connection = await getGoogleConnection(tenant, connectionId);
    expect(connection!.issuerIsGoogle).toBe(false);
    sb.seedGa4Report(GA4_PROPERTY_ID, ga4RunReportBody({ dimensionNames: ["date"], metricNames: ["sessions"], rows: [{ dimensions: ["20260301"], metrics: ["1"] }] }));
    await pullGa4MetricsForProperty({ tenantId: tenant, propertyId, ga4PropertyId: GA4_PROPERTY_ID, startDate: "2026-03-01", endDate: "2026-03-01" });
    const row = await withTenants(
      [tenant],
      (c) => c.query<{ simulated: boolean }>(`SELECT simulated FROM search_ga4_metrics WHERE property_id = $1 ORDER BY created_at DESC LIMIT 1`, [propertyId]),
      { modules: ["search"] },
    );
    expect(row.rows[0].simulated).toBe(!connection!.issuerIsGoogle);
    expect(row.rows[0].simulated).toBe(true);
  });

  it("NEVER writes search_data_cache or search_provider_calls", async () => {
    sb.seedGa4Report(GA4_PROPERTY_ID, ga4RunReportBody({ dimensionNames: ["date"], metricNames: ["sessions"], rows: [{ dimensions: ["20260401"], metrics: ["1"] }] }));
    await pullGa4MetricsForProperty({ tenantId: tenant, propertyId, ga4PropertyId: GA4_PROPERTY_ID, startDate: "2026-04-01", endDate: "2026-04-01" });
    const [cache, ledger] = await Promise.all([
      withTenants([tenant], (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM search_data_cache`)),
      withTenants([tenant], (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM search_provider_calls`)),
    ]);
    expect(Number(cache.rows[0].n)).toBe(0);
    expect(Number(ledger.rows[0].n)).toBe(0);
  });

  // ── idempotency under a genuine concurrent race ─────────────────────────────────────────────────

  it("a GENUINE CONCURRENT RACE of overlapping pulls lands exactly one row per (date, channel_group)", async () => {
    sb.seedGa4Report(
      GA4_PROPERTY_ID,
      ga4RunReportBody({ dimensionNames: ["date", "sessionDefaultChannelGroup"], metricNames: ["sessions", "engagedSessions", "conversions", "totalRevenue"], rows: [{ dimensions: ["20260501", "Organic Search"], metrics: ["77", "60", "3", "0"] }] }),
    );
    const pull = () => pullGa4MetricsForProperty({ tenantId: tenant, propertyId, ga4PropertyId: GA4_PROPERTY_ID, startDate: "2026-05-01", endDate: "2026-05-01" });
    // 20 concurrent callers — see gsc-client.test.ts's identical race test for the honest note on what
    // this probabilistically covers vs. what the manual widened-delay mutation probe conclusively proved.
    const results = await Promise.all(Array.from({ length: 20 }, pull));
    for (const r of results) expect(r.rowsUpserted).toBe(1);
    const rows = await withTenants(
      [tenant],
      (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM search_ga4_metrics WHERE property_id = $1 AND date = '2026-05-01' AND channel_group = 'Organic Search'`, [propertyId]),
      { modules: ["search"] },
    );
    expect(Number(rows.rows[0].n)).toBe(1);
  });

  it("refuses with GooglePropertyNotBoundError when the property has no GA4 connection bound", async () => {
    const unboundProperty = newId();
    await withTenants(
      [tenant],
      (c) => c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [unboundProperty, tenant, client, "unbound-ga4.example.com", "https://unbound-ga4.example.com/", config.originSite],
      ),
      { modules: ["search"] },
    );
    await expect(
      pullGa4MetricsForProperty({ tenantId: tenant, propertyId: unboundProperty, ga4PropertyId: GA4_PROPERTY_ID, startDate: "2026-01-01", endDate: "2026-01-02" }),
    ).rejects.toBeInstanceOf(GooglePropertyNotBoundError);
    expect(sb.hitCount("ga4:run_report")).toBe(0);
  });

  // ── SM-64 echo-validation twin (§A14, date-window axis) ─────────────────────────────────────────
  // The GSC twin's identical attack: the SM-51 sandbox does not enforce GA4's own date-range
  // semantics either — it returns exactly what was seeded regardless of the requested dateRanges.

  it("SM-64 — a returned row dated OUTSIDE the requested [startDate, effectiveEndDate] window (after YYYYMMDD→ISO normalization) is skipped, counted, and never persisted, and stays orthogonal to `sampled`", async () => {
    sb.seedGa4Report(
      GA4_PROPERTY_ID,
      ga4RunReportBody({
        dimensionNames: ["date", "sessionDefaultChannelGroup"],
        metricNames: ["sessions", "engagedSessions", "conversions", "totalRevenue"],
        rows: [
          { dimensions: ["20260115", "Organic Search"], metrics: ["50", "40", "1", "0"] }, // OUTSIDE the requested range below
          { dimensions: ["20260101", "Direct"], metrics: ["20", "10", "0", "0"] }, // inside
        ],
      }),
    );
    const outcome = await pullGa4MetricsForProperty({
      tenantId: tenant, propertyId, ga4PropertyId: GA4_PROPERTY_ID, startDate: "2026-01-01", endDate: "2026-01-05",
    });
    expect(outcome.rowsUpserted).toBe(1); // only the in-range row
    expect(outcome.rowsOutsideRangeSkipped).toBe(1);
    expect(outcome.sampled).toBe(false); // the report carries no sampling metadata — orthogonal axes
    const rows = await withTenants(
      [tenant],
      // Scoped by date, not just channel_group — this test reuses the describe block's shared
      // propertyId, and earlier tests in this file already wrote 'Organic Search'/'Direct' rows for
      // OTHER dates; filtering on channel_group alone leaked those in (the actual bug this fix caught).
      (c) => c.query<{ channel_group: string }>(`SELECT channel_group FROM search_ga4_metrics WHERE property_id = $1 AND date IN ('2026-01-15','2026-01-01')`, [propertyId]),
      { modules: ["search"] },
    );
    expect(rows.rows.map((r) => r.channel_group)).toEqual(["Direct"]);
  });

  it("a requested endDate reaching into today is clamped to the freshness-lag boundary", async () => {
    sb.seedGa4Report(GA4_PROPERTY_ID, ga4RunReportBody({ dimensionNames: ["date"], metricNames: ["sessions"], rows: [{ dimensions: ["20260601"], metrics: ["1"] }] }));
    const today = new Date().toISOString().slice(0, 10);
    const outcome = await pullGa4MetricsForProperty({ tenantId: tenant, propertyId, ga4PropertyId: GA4_PROPERTY_ID, startDate: "2026-01-01", endDate: today });
    expect(outcome.clampedForFreshness).toBe(true);
    expect(outcome.effectiveEndDate < today).toBe(true);
    expect(outcome.freshnessLagDays).toBe(2);
  });
});
