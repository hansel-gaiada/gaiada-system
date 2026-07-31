// ⚡ QA gate — bundled owed gate (§6au), attacking SM-25b's freshness clamp per the brief: "can a
// partial day still be persisted... via a timezone boundary, or clock skew?" `clampEndDateToFreshnessLag`
// (google/freshness.ts) never requests a date inside the lag window from Google — but that guarantee is
// only as strong as the ASSUMPTION that Google's response never contains a row dated later than the
// `endDate` actually requested. Nothing in `pullGscPerformanceForProperty` (gsc-client.ts) checks a
// returned row's own `date` against `effectiveEndDate` before persisting it. This file proves that gap
// at the code (the SM-51 sandbox itself does not enforce Google's own date-filtering semantics — it
// merely requires startDate/endDate to be PRESENT — so a seeded row need not respect the requested
// range, which is the exact seam a real vendor bug or a clock-skewed "today" would exploit).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";

import { config } from "../../../config";
import { newId, withTenants } from "../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../../testing/fixtures";
import { startGoogleSandbox, type GoogleSandbox } from "../../../testing/vendor-sandbox/google-server";
import { startAuthorization, completeAuthorization } from "./oauth";
import { pullGscPerformanceForProperty } from "./gsc-client";
import { pullGa4MetricsForProperty } from "./ga4-client";
import { isoDateDaysAgo } from "./freshness";
import { ga4RunReportBody } from "../../../testing/vendor-sandbox/fixtures/google/ga4-run-report";

const CLIENT_ID = "qa25b-fresh-dev";
const CLIENT_SECRET = "qa25b-fresh-dev-secret";
const REDIRECT_URI = "http://127.0.0.1:3004/api/search/google/oauth/callback";
const SITE_URL = "https://sandbox-client.example/"; // must be in DEFAULT_GSC_SITES (fixtures/google/gsc-sites.ts)

describe.skipIf(!TEST_URL)("⚡ QA adversarial — SM-25b freshness clamp vs a vendor that ignores the requested range", () => {
  let sb: GoogleSandbox;
  let tenant: string, user: string, client: string, propertyId: string;

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

    tenant = await createCompany("QA25b Fresh Agency", ["search"]);
    user = await createUser("qa25b-fresh@a.test");
    await addMembership(tenant, user);
    client = await createClient(tenant, "QA25b Fresh Client");
    propertyId = newId();
    await withTenants(
      [tenant],
      (c) => c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [propertyId, tenant, client, "sandbox-client.example", SITE_URL, config.originSite],
      ),
      { modules: ["search"] },
    );
    const started = await startAuthorization({
      tenantId: tenant, clientId: client, propertyId, provider: "google_search_console", createdBy: user,
    });
    const res = await fetch(started.authorizeUrl, { redirect: "manual" });
    const loc = new URL(res.headers.get("location")!);
    await completeAuthorization({
      stateToken: loc.searchParams.get("state")!, code: loc.searchParams.get("code")!,
      principalUserId: user, provider: "google_search_console",
    });
  });

  afterAll(async () => {
    if (sb) await sb.close();
    await teardownTestDb();
  });

  it("ATTACK — the sandbox (and by extension a misbehaving real vendor, or a clock-skewed 'today') seeds a row dated INSIDE the lag window despite the request being correctly clamped OUTSIDE it. Does the driver persist a partial row unflagged?", async () => {
    // TODAY's date, which is strictly INSIDE GSC's 3-day lag window — the exact date the clamp exists
    // to ensure is NEVER requested.
    const todayIso = isoDateDaysAgo(0);
    sb.seedSearchAnalytics(SITE_URL, [
      { keys: [todayIso, "qa25b partial-day query", "https://qa25b-fresh.example/", "DESKTOP"], clicks: 1, impressions: 5, ctr: 0.2, position: 3.1 },
    ]);

    // No endDate override — the caller asks for "as much as is safe", which the clamp turns into the
    // lag boundary. The REQUEST correctly never asks Google for `todayIso`.
    const outcome = await pullGscPerformanceForProperty({ tenantId: tenant, propertyId, siteUrl: SITE_URL });
    expect(outcome.effectiveEndDate < todayIso).toBe(true); // the OUTBOUND request was correctly clamped
    expect(outcome.clampedForFreshness).toBe(false); // no narrower request was given to honour — the boundary IS the request

    const rows = await withTenants(
      [tenant],
      (c) => c.query<{ date: string }>(`SELECT date::text AS date FROM search_gsc_performance WHERE property_id = $1`, [propertyId]),
      { modules: ["search"] },
    );

    if (rows.rows.some((r) => r.date === todayIso)) {
      throw new Error(
        `SM-25b RESIDUAL CONFIRMED: a row dated ${todayIso} (inside the ${outcome.freshnessLagDays}-day lag ` +
        `window, strictly after the clamped effectiveEndDate ${outcome.effectiveEndDate}) was persisted with ` +
        `no flag and no rejection. The clamp only ever governs the OUTBOUND request date; nothing in ` +
        `pullGscPerformanceForProperty cross-checks a RETURNED row's own date against effectiveEndDate before ` +
        `the UPSERT. The "no partial row anywhere to mislabel" guarantee (freshness.ts's header) is therefore ` +
        `conditional on Google actually honouring the requested range — an assumption this sandbox itself does ` +
        `not enforce, and the exact vendor fact §A10/SM-41G defers rather than proves. A real vendor date-` +
        `filtering bug, or a clock-skewed "today" on either side of the request, would silently defeat the clamp.`,
      );
    }
    // HELD if this line runs: the driver defended against an out-of-range row even though the sandbox let it through.
    expect(rows.rows.every((r) => r.date <= outcome.effectiveEndDate)).toBe(true);
    // SM-64 disclosure assertions — the fix must not just refuse to persist the row, it must SAY SO
    // (the counter IS the disclosure; a silent drop is explicitly foreclosed by §A14/Ruling 1).
    expect(outcome.rowsOutsideRangeSkipped).toBe(1);
    expect(outcome.rowsOverLimitSkipped).toBe(0); // this attack seeds one row, well under any rowLimit
  });
});

// SM-64 — the GA4 twin of the attack above (tracker §6bc Ruling 2: the identical check is owed on GA4;
// `sampled` does not cover it — sampled is an ESTIMATION fact, settledness is a COMPLETENESS fact, and an
// unsampled row dated today is `sampled: false` and fully misleading).
describe.skipIf(!TEST_URL)("⚡ QA adversarial — SM-64 GA4 twin: freshness clamp vs a vendor that ignores the requested range", () => {
  let sb: GoogleSandbox;
  let tenant: string, user: string, client: string, propertyId: string;
  const GA4_PROPERTY_ID = "987654321";

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

    tenant = await createCompany("QA25b Fresh GA4 Agency", ["search"]);
    user = await createUser("qa25b-fresh-ga4@a.test");
    await addMembership(tenant, user);
    client = await createClient(tenant, "QA25b Fresh GA4 Client");
    propertyId = newId();
    await withTenants(
      [tenant],
      (c) => c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [propertyId, tenant, client, "sandbox-client-ga4.example", "https://sandbox-client-ga4.example/", config.originSite],
      ),
      { modules: ["search"] },
    );
    const started = await startAuthorization({
      tenantId: tenant, clientId: client, propertyId, provider: "google_analytics", createdBy: user,
    });
    const res = await fetch(started.authorizeUrl, { redirect: "manual" });
    const loc = new URL(res.headers.get("location")!);
    await completeAuthorization({
      stateToken: loc.searchParams.get("state")!, code: loc.searchParams.get("code")!,
      principalUserId: user, provider: "google_analytics",
    });
  });

  afterAll(async () => {
    if (sb) await sb.close();
    await teardownTestDb();
  });

  it("ATTACK — a seeded GA4 row dated TODAY (strictly inside the 2-day lag window), UNSAMPLED, is returned despite the request being correctly clamped outside it. Does the driver persist it unflagged?", async () => {
    const todayIso = isoDateDaysAgo(0);
    const todayGa4 = todayIso.replace(/-/g, ""); // GA4's own YYYYMMDD wire shape
    sb.seedGa4Report(
      GA4_PROPERTY_ID,
      ga4RunReportBody({
        dimensionNames: ["date", "sessionDefaultChannelGroup"],
        metricNames: ["sessions", "engagedSessions", "conversions", "totalRevenue"],
        rows: [{ dimensions: [todayGa4, "Organic Search"], metrics: ["1", "1", "0", "0"] }],
      }),
    );

    // No endDate override — the boundary IS the request, exactly as the GSC attack above.
    const outcome = await pullGa4MetricsForProperty({ tenantId: tenant, propertyId, ga4PropertyId: GA4_PROPERTY_ID });
    expect(outcome.effectiveEndDate < todayIso).toBe(true); // the OUTBOUND request was correctly clamped
    expect(outcome.clampedForFreshness).toBe(false); // no narrower request was given to honour
    expect(outcome.sampled).toBe(false); // UNSAMPLED — proves settledness is checked independently of the sampling axis

    const rows = await withTenants(
      [tenant],
      (c) => c.query<{ date: string }>(`SELECT date::text AS date FROM search_ga4_metrics WHERE property_id = $1`, [propertyId]),
      { modules: ["search"] },
    );

    if (rows.rows.some((r) => r.date === todayIso)) {
      throw new Error(
        `SM-64 GA4 TWIN FAILED: a row dated ${todayIso} (inside the ${outcome.freshnessLagDays}-day GA4 lag ` +
        `window, unsampled, strictly after the clamped effectiveEndDate ${outcome.effectiveEndDate}) was ` +
        `persisted with no check and no rejection.`,
      );
    }
    expect(rows.rows.every((r) => r.date <= outcome.effectiveEndDate)).toBe(true);
    expect(outcome.rowsOutsideRangeSkipped).toBe(1); // disclosed, not silently dropped
  });
});
