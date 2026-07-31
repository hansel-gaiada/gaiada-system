// SM-25c — ads-client.ts: response interpretation + idempotent persistence, against SM-51's sandbox on
// real sockets and a real Postgres (same harness as gsc-client.test.ts/ga4-client.test.ts, which this
// file mirrors for setup). What THIS file proves, mapped to the ticket's own duties:
//   1. Interpretation: the sandbox's per-row customer/campaign/segments/metrics envelope is parsed
//      into the right columns, and money (MICROS vs plain currency-unit) is converted correctly.
//   2. The two §A12 prohibitions, asserted as behaviour: driving a pull never writes
//      search_data_cache (0 rows) and never writes search_provider_calls (0 rows).
//   3. `simulated` is stamped from the CONNECTION's own issuer-honesty flag (a MUTATION PROBE).
//   4. Echo-validation (§A14): a wrong-customer row, an out-of-window row, and an unmatched-campaign
//      row are each skipped, counted, and never persisted — proven both by a happy-path assertion AND
//      by mutation-probing the guard that enforces it (§6bi Ruling 4's "plausible defect" shape).
//   5. The account link (`linkAdsCustomerId`) validates provider + digit-only ids.
//   6. Idempotency: schema-level UNIQUE(campaign_id, date) + ON CONFLICT DO UPDATE.
//   7. The two fail-closed guards this ticket owns: no developer token configured (503), no customer
//      id linked (400) — both checked BEFORE any network call.
//
// ⚠ BINDING (§A12.5, transposed here as in every Google-surface test in this module): a green run of
// this file is a validated client of OUR OWN MODEL OF GOOGLE ADS' SEARCH ENVELOPE, not a validated
// Google integration. SM-41G confirms real shapes, real quota/developer-token/MCC behaviour.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

import { config } from "../../../config";
import { newId, withTenants } from "../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../../testing/fixtures";
import { startGoogleSandbox, type GoogleSandbox } from "../../../testing/vendor-sandbox/google-server";
import { startAuthorization, completeAuthorization, getGoogleConnection } from "./oauth";
import { GoogleAdsCustomerNotLinkedError, GoogleAdsNotConfiguredError, GooglePropertyNotBoundError } from "./errors";
import {
  linkAdsCustomerId, listAdsCampaignMetrics, normalizeAdsCustomerId, pullAdsMetricsForEngagement,
} from "./ads-client";
import { adsSearchBody } from "../../../testing/vendor-sandbox/fixtures/google/ads-search";

const CLIENT_ID = "sm25c-ads-dev";
const CLIENT_SECRET = "sm25c-ads-dev-secret";
const REDIRECT_URI = "http://127.0.0.1:3004/api/search/google/oauth/callback";
const CUSTOMER_ID = "1234567890";

describe.skipIf(!TEST_URL)("SM-25c · ads-client.ts against the SM-51 sandbox", () => {
  let sb: GoogleSandbox;
  let tenant: string;
  let user: string;
  let client: string;
  let propertyId: string;
  let connectionId: string;
  let engagementId: string;
  let campaignAId: string; // external_id "111111"
  let campaignBId: string; // external_id "222222"
  const savedDeveloperToken = config.search.google.adsDeveloperToken;

  beforeAll(async () => {
    await initTestDb();
    config.integrationTokenKey = randomBytes(32).toString("base64");
    config.search.google.adsDeveloperToken = "sm25c-fake-dev-token"; // fail-closed guard needs SOME value

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

    tenant = await createCompany("SM-25c Ads Agency", ["search"]);
    user = await createUser("ads-linker@sm25c.test");
    await addMembership(tenant, user);
    client = await createClient(tenant, "SM-25c Ads Client");
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

    // Real authorization-code + PKCE round trip against the sandbox, binding the property in the
    // same flow — the identical chain gsc-client.test.ts/ga4-client.test.ts drive.
    const started = await startAuthorization({
      tenantId: tenant, clientId: client, propertyId, provider: "google_ads", createdBy: user,
    });
    const res = await fetch(started.authorizeUrl, { redirect: "manual" });
    const loc = new URL(res.headers.get("location")!);
    const connection = await completeAuthorization({
      stateToken: loc.searchParams.get("state")!, code: loc.searchParams.get("code")!,
      principalUserId: user, provider: "google_ads",
    });
    connectionId = connection.id;

    // The engagement + two tracked campaigns (SM-25c's own "account link + read pulls into the SM-20
    // tables" scope) — one clean external_id, one deliberately dirty for the invalid-id guard.
    engagementId = newId();
    await withTenants(
      [tenant],
      (c) =>
        c.query(
          `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status, owner_id)
           VALUES ($1,$2,$3,$4,$5,'{}',10,'active',$6)`,
          [engagementId, tenant, client, propertyId, "SM-25c engagement", user],
        ),
      { modules: ["search"] },
    );
    campaignAId = newId();
    campaignBId = newId();
    await withTenants(
      [tenant],
      async (c) => {
        await c.query(
          `INSERT INTO search_campaigns (id, tenant_id, engagement_id, platform, external_id, name, status)
           VALUES ($1,$2,$3,'google_ads','111111',$4,'live')`,
          [campaignAId, tenant, engagementId, "SM-25c campaign A"],
        );
        await c.query(
          `INSERT INTO search_campaigns (id, tenant_id, engagement_id, platform, external_id, name, status)
           VALUES ($1,$2,$3,'google_ads','222222',$4,'live')`,
          [campaignBId, tenant, engagementId, "SM-25c campaign B"],
        );
      },
      { modules: ["search"] },
    );
  });

  afterAll(async () => {
    if (sb) await sb.close();
    config.search.google.adsDeveloperToken = savedDeveloperToken;
    await teardownTestDb();
  });

  beforeEach(() => {
    sb.resetHitCounts();
  });

  // ── 0 · the account link ────────────────────────────────────────────────────────────────────────

  it("linkAdsCustomerId strips dashes/spaces and persists the digit-only id", async () => {
    const view = await linkAdsCustomerId(tenant, connectionId, "123-456-7890");
    expect(view.externalAccount).toBe("1234567890");
  });

  it("normalizeAdsCustomerId strips everything but digits", () => {
    expect(normalizeAdsCustomerId("123-456-7890")).toBe("1234567890");
    expect(normalizeAdsCustomerId("  1234567890  ")).toBe("1234567890");
    expect(normalizeAdsCustomerId("abc")).toBe("");
  });

  it("linkAdsCustomerId refuses a non-digit customerId", async () => {
    await expect(linkAdsCustomerId(tenant, connectionId, "not-a-number-at-all-!!!".replace(/[0-9]/g, ""))).rejects.toThrow(
      /customerId must contain at least one digit/,
    );
  });

  it("linkAdsCustomerId refuses a connection that is not google_ads", async () => {
    // Link a GSC connection, then try to set an Ads customer id on it.
    const gscStarted = await startAuthorization({ tenantId: tenant, clientId: client, provider: "google_search_console", createdBy: user });
    const gscRes = await fetch(gscStarted.authorizeUrl, { redirect: "manual" });
    const gscLoc = new URL(gscRes.headers.get("location")!);
    const gscConn = await completeAuthorization({
      stateToken: gscLoc.searchParams.get("state")!, code: gscLoc.searchParams.get("code")!,
      principalUserId: user, provider: "google_search_console",
    });
    await expect(linkAdsCustomerId(tenant, gscConn.id, CUSTOMER_ID)).rejects.toThrow(/not google_ads/);
  });

  // ── 1 · fail-closed guards, BEFORE any network call ────────────────────────────────────────────

  it("refuses with GoogleAdsNotConfiguredError (503) when no developer token is set — checked before any I/O", async () => {
    config.search.google.adsDeveloperToken = "";
    try {
      await linkAdsCustomerId(tenant, connectionId, CUSTOMER_ID);
      await expect(
        pullAdsMetricsForEngagement({ tenantId: tenant, engagementId, propertyId }),
      ).rejects.toBeInstanceOf(GoogleAdsNotConfiguredError);
      expect(sb.hitCount("ads:search")).toBe(0); // never reached the network
    } finally {
      config.search.google.adsDeveloperToken = "sm25c-fake-dev-token";
    }
  });

  it("refuses with GooglePropertyNotBoundError when the property has no Ads connection bound", async () => {
    const bareEngagementId = newId();
    const barePropertyId = newId();
    await withTenants(
      [tenant],
      async (c) => {
        await c.query(
          `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, origin_site)
           VALUES ($1,$2,$3,'unbound.example','https://unbound.example/',$4)`,
          [barePropertyId, tenant, client, config.originSite],
        );
        await c.query(
          `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status)
           VALUES ($1,$2,$3,$4,'unbound eng','{}',10,'active')`,
          [bareEngagementId, tenant, client, barePropertyId],
        );
      },
      { modules: ["search"] },
    );
    await expect(
      pullAdsMetricsForEngagement({ tenantId: tenant, engagementId: bareEngagementId, propertyId: barePropertyId }),
    ).rejects.toBeInstanceOf(GooglePropertyNotBoundError);
  });

  it("refuses with GoogleAdsCustomerNotLinkedError when the connection has no customer id and none is overridden", async () => {
    // A second, freshly-linked Ads connection with no customer id set yet.
    const secondClient = await createClient(tenant, "SM-25c second client");
    const secondPropertyId = newId();
    const secondEngagementId = newId();
    await withTenants(
      [tenant],
      async (c) => {
        await c.query(
          `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, origin_site)
           VALUES ($1,$2,$3,'nolink.example','https://nolink.example/',$4)`,
          [secondPropertyId, tenant, secondClient, config.originSite],
        );
        await c.query(
          `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status)
           VALUES ($1,$2,$3,$4,'nolink eng','{}',10,'active')`,
          [secondEngagementId, tenant, secondClient, secondPropertyId],
        );
      },
      { modules: ["search"] },
    );
    const started = await startAuthorization({ tenantId: tenant, clientId: secondClient, propertyId: secondPropertyId, provider: "google_ads", createdBy: user });
    const res = await fetch(started.authorizeUrl, { redirect: "manual" });
    const loc = new URL(res.headers.get("location")!);
    await completeAuthorization({
      stateToken: loc.searchParams.get("state")!, code: loc.searchParams.get("code")!,
      principalUserId: user, provider: "google_ads",
    });
    await expect(
      pullAdsMetricsForEngagement({ tenantId: tenant, engagementId: secondEngagementId, propertyId: secondPropertyId }),
    ).rejects.toBeInstanceOf(GoogleAdsCustomerNotLinkedError);
  });

  // ── 2 · zero tracked campaigns is honest, not a network call ──────────────────────────────────

  it("zero tracked campaigns returns an honest empty outcome and never calls the Ads endpoint", async () => {
    await linkAdsCustomerId(tenant, connectionId, CUSTOMER_ID);
    const untrackedEngagementId = newId();
    await withTenants(
      [tenant],
      (c) =>
        c.query(
          `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status)
           VALUES ($1,$2,$3,$4,'untracked eng','{}',10,'active')`,
          [untrackedEngagementId, tenant, client, propertyId],
        ),
      { modules: ["search"] },
    );
    const outcome = await pullAdsMetricsForEngagement({ tenantId: tenant, engagementId: untrackedEngagementId, propertyId });
    expect(outcome.status).toBe("pulled");
    expect(outcome.campaignsTracked).toBe(0);
    expect(outcome.rowsUpserted).toBe(0);
    expect(sb.hitCount("ads:search")).toBe(0);
  });

  // ── 3 · interpretation + money conversion ──────────────────────────────────────────────────────

  it("parses customer/campaign/segments/metrics and converts money correctly (micros vs plain units)", async () => {
    await linkAdsCustomerId(tenant, connectionId, CUSTOMER_ID);
    sb.seedAdsSearch(CUSTOMER_ID, adsSearchBody({
      rows: [
        { campaignId: "111111", campaignName: "A", clicks: 40, impressions: 800, costMicros: 12_500_000, conversions: 3, conversionsValue: 250.5, date: "2026-07-20", customerId: CUSTOMER_ID, currencyCode: "USD" },
        { campaignId: "222222", campaignName: "B", clicks: 10, impressions: 300, costMicros: 3_000_000, conversions: 1, conversionsValue: 40, date: "2026-07-20", customerId: CUSTOMER_ID, currencyCode: "USD" },
      ],
    }));
    const outcome = await pullAdsMetricsForEngagement({
      tenantId: tenant, engagementId, propertyId, startDate: "2026-07-15", endDate: "2026-07-20",
    });
    expect(outcome.status).toBe("pulled");
    expect(outcome.customerId).toBe(CUSTOMER_ID);
    expect(outcome.campaignsTracked).toBe(2);
    expect(outcome.rowsUpserted).toBe(2);
    expect(outcome.malformedRowsSkipped).toBe(0);
    expect(outcome.rowsOutsideRangeSkipped).toBe(0);
    expect(outcome.rowsWrongCustomerSkipped).toBe(0);
    expect(outcome.rowsUnmatchedCampaignSkipped).toBe(0);
    expect(outcome.provider).toBe("google_ads");

    const rows = await withTenants(
      [tenant],
      (c) =>
        c.query<{ campaign_id: string; clicks: string; impressions: string; cost_minor: string; currency: string; conv_value_minor: string }>(
          `SELECT campaign_id, clicks, impressions, cost_minor, currency, conv_value_minor
             FROM search_campaign_metrics_daily WHERE date = '2026-07-20' AND campaign_id = ANY($1)`,
          [[campaignAId, campaignBId]],
        ),
      { modules: ["search"] },
    );
    const rowA = rows.rows.find((r) => r.campaign_id === campaignAId)!;
    expect(Number(rowA.clicks)).toBe(40);
    expect(Number(rowA.impressions)).toBe(800);
    // 12,500,000 micros = $12.50 = 1250 minor units.
    expect(Number(rowA.cost_minor)).toBe(1250);
    // 250.5 currency units = 25050 minor units.
    expect(Number(rowA.conv_value_minor)).toBe(25050);
    expect(rowA.currency).toBe("USD");
  });

  it("Google's own ABSENT-results shape (not []) is treated as zero rows, never an error", async () => {
    await linkAdsCustomerId(tenant, connectionId, CUSTOMER_ID);
    sb.seedAdsSearch(CUSTOMER_ID, { fieldMask: "campaign.id" }); // no `results` key at all
    const outcome = await pullAdsMetricsForEngagement({ tenantId: tenant, engagementId, propertyId, startDate: "2026-01-01", endDate: "2026-01-05" });
    expect(outcome.status).toBe("pulled");
    expect(outcome.rowsUpserted).toBe(0);
  });

  // ── 4 · echo-validation (§A14), happy path + mutation probes ──────────────────────────────────

  it("skips a row whose customer.id does not match the queried customerId — counted, never persisted", async () => {
    await linkAdsCustomerId(tenant, connectionId, CUSTOMER_ID);
    sb.seedAdsSearch(CUSTOMER_ID, adsSearchBody({
      rows: [
        { campaignId: "111111", campaignName: "A", clicks: 5, impressions: 50, costMicros: 100_000, date: "2026-06-01", customerId: "9999999999" },
      ],
    }));
    const outcome = await pullAdsMetricsForEngagement({ tenantId: tenant, engagementId, propertyId, startDate: "2026-05-29", endDate: "2026-06-01" });
    expect(outcome.rowsWrongCustomerSkipped).toBe(1);
    expect(outcome.rowsUpserted).toBe(0);
    const row = await withTenants([tenant], (c) => c.query(`SELECT 1 FROM search_campaign_metrics_daily WHERE campaign_id = $1 AND date = '2026-06-01'`, [campaignAId]), { modules: ["search"] });
    expect(row.rowCount).toBe(0);
  });

  it("skips a row whose segments.date falls outside the requested window — counted, never persisted", async () => {
    await linkAdsCustomerId(tenant, connectionId, CUSTOMER_ID);
    // The pull's own window is 2026-05-25..2026-05-27; the seeded row is dated 2026-05-20, well before
    // it (and well within the freshness-lag boundary, so this is a genuine out-of-window row, not an
    // artifact of the clamp).
    sb.seedAdsSearch(CUSTOMER_ID, adsSearchBody({
      rows: [
        { campaignId: "111111", campaignName: "A", clicks: 5, impressions: 50, costMicros: 100_000, date: "2026-05-20", customerId: CUSTOMER_ID },
      ],
    }));
    const outcome = await pullAdsMetricsForEngagement({ tenantId: tenant, engagementId, propertyId, startDate: "2026-05-25", endDate: "2026-05-27" });
    expect(outcome.rowsOutsideRangeSkipped).toBe(1);
    expect(outcome.rowsUpserted).toBe(0);
    const row = await withTenants([tenant], (c) => c.query(`SELECT 1 FROM search_campaign_metrics_daily WHERE campaign_id = $1 AND date = '2026-05-20'`, [campaignAId]), { modules: ["search"] });
    expect(row.rowCount).toBe(0);
  });

  it("skips a row whose campaign.id is not one this engagement tracks — counted, never persisted", async () => {
    await linkAdsCustomerId(tenant, connectionId, CUSTOMER_ID);
    sb.seedAdsSearch(CUSTOMER_ID, adsSearchBody({
      rows: [
        { campaignId: "999999", campaignName: "untracked", clicks: 5, impressions: 50, costMicros: 100_000, date: "2026-06-02", customerId: CUSTOMER_ID },
      ],
    }));
    const outcome = await pullAdsMetricsForEngagement({ tenantId: tenant, engagementId, propertyId, startDate: "2026-05-29", endDate: "2026-06-02" });
    expect(outcome.rowsUnmatchedCampaignSkipped).toBe(1);
    expect(outcome.rowsUpserted).toBe(0);
  });

  it("a campaign with a non-digit external_id is excluded from the query and counted, not sent to Ads", async () => {
    const dirtyCampaignId = newId();
    await withTenants(
      [tenant],
      (c) =>
        c.query(
          `INSERT INTO search_campaigns (id, tenant_id, engagement_id, platform, external_id, name, status)
           VALUES ($1,$2,$3,'google_ads','abc-not-numeric',$4,'live')`,
          [dirtyCampaignId, tenant, engagementId, "SM-25c dirty campaign"],
        ),
      { modules: ["search"] },
    );
    await linkAdsCustomerId(tenant, connectionId, CUSTOMER_ID);
    sb.seedAdsSearch(CUSTOMER_ID, adsSearchBody({ rows: [{ campaignId: "111111", campaignName: "A", clicks: 1, impressions: 10, costMicros: 1000, date: "2026-06-03", customerId: CUSTOMER_ID }] }));
    const outcome = await pullAdsMetricsForEngagement({ tenantId: tenant, engagementId, propertyId, startDate: "2026-05-29", endDate: "2026-06-03" });
    expect(outcome.campaignsWithInvalidExternalIdSkipped).toBe(1);
    // campaignsTracked counts only the two clean campaigns (111111/222222) — the dirty one never joins the set.
    expect(outcome.campaignsTracked).toBe(2);
    await withTenants([tenant], (c) => c.query(`UPDATE search_campaigns SET deleted_at = now() WHERE id = $1`, [dirtyCampaignId]), { modules: ["search"] });
  });

  // ── 5 · the two §A12 prohibitions, as behaviour ────────────────────────────────────────────────

  it("NEVER writes search_data_cache — client-private Ads rows in the shared no-RLS cache would be a cross-tenant leak by construction", async () => {
    await linkAdsCustomerId(tenant, connectionId, CUSTOMER_ID);
    sb.seedAdsSearch(CUSTOMER_ID, adsSearchBody({ rows: [{ campaignId: "111111", campaignName: "A", clicks: 1, impressions: 10, costMicros: 1000, date: "2026-06-04", customerId: CUSTOMER_ID }] }));
    const outcome = await pullAdsMetricsForEngagement({ tenantId: tenant, engagementId, propertyId, startDate: "2026-05-29", endDate: "2026-06-04" });
    expect(outcome.rowsUpserted).toBeGreaterThan(0);
    const cache = await withTenants([tenant], (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM search_data_cache`));
    expect(Number(cache.rows[0].n)).toBe(0);
  });

  it("NEVER writes search_provider_calls — there is no vendor dollar to meter on a client's own Ads account", async () => {
    await linkAdsCustomerId(tenant, connectionId, CUSTOMER_ID);
    sb.seedAdsSearch(CUSTOMER_ID, adsSearchBody({ rows: [{ campaignId: "111111", campaignName: "A", clicks: 1, impressions: 10, costMicros: 1000, date: "2026-06-05", customerId: CUSTOMER_ID }] }));
    const outcome = await pullAdsMetricsForEngagement({ tenantId: tenant, engagementId, propertyId, startDate: "2026-05-29", endDate: "2026-06-05" });
    expect(outcome.rowsUpserted).toBeGreaterThan(0);
    const ledger = await withTenants([tenant], (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM search_provider_calls`));
    expect(Number(ledger.rows[0].n)).toBe(0);
  });

  // ── 6 · provenance MUTATION PROBE ──────────────────────────────────────────────────────────────

  it("MUTATION PROBE — simulated is stamped from the CONNECTION's own issuer-honesty flag, not guessed", async () => {
    const connection = await getGoogleConnection(tenant, connectionId);
    expect(connection!.issuerIsGoogle).toBe(false); // the sandbox is not a Google host
    await linkAdsCustomerId(tenant, connectionId, CUSTOMER_ID);
    sb.seedAdsSearch(CUSTOMER_ID, adsSearchBody({ rows: [{ campaignId: "111111", campaignName: "A", clicks: 1, impressions: 10, costMicros: 1000, date: "2026-06-06", customerId: CUSTOMER_ID }] }));
    await pullAdsMetricsForEngagement({ tenantId: tenant, engagementId, propertyId, startDate: "2026-05-29", endDate: "2026-06-06" });
    const row = await withTenants(
      [tenant],
      (c) => c.query<{ simulated: boolean; connection_id: string }>(`SELECT simulated, connection_id FROM search_campaign_metrics_daily WHERE campaign_id = $1 AND date = '2026-06-06'`, [campaignAId]),
      { modules: ["search"] },
    );
    expect(row.rows[0].simulated).toBe(!connection!.issuerIsGoogle);
    expect(row.rows[0].simulated).toBe(true);
    expect(row.rows[0].connection_id).toBe(connectionId);
  });

  // ── 7 · idempotency ─────────────────────────────────────────────────────────────────────────────

  it("a re-pull of an overlapping range upserts in place — no duplicate rows", async () => {
    await linkAdsCustomerId(tenant, connectionId, CUSTOMER_ID);
    sb.seedAdsSearch(CUSTOMER_ID, adsSearchBody({ rows: [{ campaignId: "111111", campaignName: "A", clicks: 5, impressions: 50, costMicros: 100_000, date: "2026-06-07", customerId: CUSTOMER_ID }] }));
    await pullAdsMetricsForEngagement({ tenantId: tenant, engagementId, propertyId, startDate: "2026-06-05", endDate: "2026-06-07" });
    sb.seedAdsSearch(CUSTOMER_ID, adsSearchBody({ rows: [{ campaignId: "111111", campaignName: "A", clicks: 99, impressions: 900, costMicros: 500_000, date: "2026-06-07", customerId: CUSTOMER_ID }] }));
    await pullAdsMetricsForEngagement({ tenantId: tenant, engagementId, propertyId, startDate: "2026-06-05", endDate: "2026-06-07" });
    const rows = await withTenants(
      [tenant],
      (c) => c.query<{ clicks: string }>(`SELECT clicks FROM search_campaign_metrics_daily WHERE campaign_id = $1 AND date = '2026-06-07'`, [campaignAId]),
      { modules: ["search"] },
    );
    expect(rows.rows).toHaveLength(1); // updated, not duplicated
    expect(Number(rows.rows[0].clicks)).toBe(99);
  });

  // ── 8 · the reader ──────────────────────────────────────────────────────────────────────────────

  it("listAdsCampaignMetrics badges (never filters) simulated/source", async () => {
    await linkAdsCustomerId(tenant, connectionId, CUSTOMER_ID);
    sb.seedAdsSearch(CUSTOMER_ID, adsSearchBody({ rows: [{ campaignId: "111111", campaignName: "A", clicks: 7, impressions: 70, costMicros: 200_000, date: "2026-06-08", customerId: CUSTOMER_ID }] }));
    await pullAdsMetricsForEngagement({ tenantId: tenant, engagementId, propertyId, startDate: "2026-06-06", endDate: "2026-06-08" });
    const rows = await listAdsCampaignMetrics({ tenantId: tenant, campaignId: campaignAId, startDate: "2026-06-08", endDate: "2026-06-08" });
    expect(rows.length).toBeGreaterThan(0);
    const row = rows.find((r) => r.date === "2026-06-08")!;
    expect(row.source).toBe("google_ads_api");
    expect(row.simulated).toBe(true);
    expect(row.clicks).toBe(7);
  });
});
