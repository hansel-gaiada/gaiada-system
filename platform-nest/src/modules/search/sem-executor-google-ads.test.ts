// SM-26 — sem-executor-google-ads.ts against SM-51's sandbox on real sockets and a real Postgres (same
// harness ads-client.test.ts uses). What this file proves, mapped to tracker §6bp Ruling 6 + Ruling 3:
//   1. THE MANIFEST IS PERSISTED BEFORE THE SEND (Ruling 6.1) — proven with a self-asserting instrument
//      (`MANIFEST_TO_NETWORK_DELAY_MS`), the same lever-pattern sem-apply.ts's own
//      `APPLY_RACE_DELAY_MS` uses: the manifest row is queried and found WHILE the network call has
//      demonstrably not yet happened (sandbox hit count still 0), not merely "before the test finished".
//   2. Strict positional pairing against that manifest, per Ads resource-type mutate call.
//   3. A count/shape mismatch in ANY resource-type call ⇒ `indeterminate`-ALL via sem-apply.ts's OWN,
//      UNMODIFIED `reconcileExecution` (this file never hand-rolls that classification).
//   4. A per-row `partialFailureError` inside a correctly-sized response is a per-row outcome
//      (`partial`), never an addressing failure.
//   5. `resource_name` capture onto the manifest table, always — even when the ExecutorReport itself
//      withholds attribution.
//   6. The forbidden cross-product (Ruling 3.2/§A12.6): a live push refuses simulated keyword data,
//      with no override, and nothing is sent.
//   7. The ad-group/campaign-budget resource gaps this file flags rather than fixes (file header) throw
//      pre-send, never mid-flight.
//   8. The write-mode split resolver + boot-refusal assertion (Ruling 3.1), and that this executor
//      still slots into sem-apply.ts's EXISTING `resolveAdsExecutor`/`registerLiveAdsExecutor` seam
//      unmodified.
//
// ⚠ BINDING (§A12.5, verbatim, as in every Google-surface test in this module): a green run here is a
// validated client of OUR OWN MODEL of Google Ads mutate, not a validated Google integration. Per
// standing policy, no real developer token / OAuth client / Ads account exists in dev — every
// real-account acceptance criterion (do these operations apply as intended, real response shapes,
// whether an operation echo exists after all) is deferred to SM-41G in staging.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import {
  startGoogleSandbox,
  type GoogleSandbox,
  GOOGLE_SANDBOX_ADS_MUTATE_ROW_FAIL_MARKER,
  GOOGLE_SANDBOX_ADS_MUTATE_COUNT_MISMATCH_MARKER,
} from "../../testing/vendor-sandbox/google-server";
import { startAuthorization, completeAuthorization } from "./google/oauth";
import { linkAdsCustomerId } from "./google/ads-client";
import {
  clearLiveAdsExecutor,
  reconcileExecution,
  registerLiveAdsExecutor,
  resolveAdsExecutor,
  type AdsExecutorContext,
  type ChangeOperation,
} from "./sem-apply";
import {
  AdsAdGroupResourceUnavailableError,
  AdsCampaignBudgetResourceUnavailableError,
  AdsWriteModeBootError,
  MANIFEST_TO_NETWORK_DELAY_MS,
  SEARCH_ADS_WRITE_MODE_ENV,
  SimulatedKeywordDataRefusedError,
  assertAdsWriteModeBootSafe,
  googleAdsLiveExecutor,
  resolveSearchAdsWriteMode,
} from "./sem-executor-google-ads";

const CLIENT_ID = "sm26-ads-dev";
const CLIENT_SECRET = "sm26-ads-dev-secret";
const REDIRECT_URI = "http://127.0.0.1:3004/api/search/google/oauth/callback";
const CUSTOMER_ID = "9998887770";

interface ManifestRow {
  position: number;
  ref: string;
  ads_resource: string;
  resource_name: string | null;
  outcome: string | null;
  error_detail: string | null;
}

describe.skipIf(!TEST_URL)("SM-26 · sem-executor-google-ads.ts against the SM-51 sandbox", () => {
  let sb: GoogleSandbox;
  let tenant: string;
  let user: string;
  let client: string;
  let propertyId: string;
  let engagementId: string;
  const savedDeveloperToken = config.search.google.adsDeveloperToken;

  beforeAll(async () => {
    await initTestDb();
    config.integrationTokenKey = randomBytes(32).toString("base64");
    config.search.google.adsDeveloperToken = "sm26-fake-dev-token"; // fail-closed guard needs SOME value

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

    tenant = await createCompany("SM-26 Ads Agency", ["search"]);
    user = await createUser("ads-executor@sm26.test");
    await addMembership(tenant, user);
    client = await createClient(tenant, "SM-26 Ads Client");
    propertyId = newId();
    await withTenants(
      [tenant],
      (c) =>
        c.query(
          `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [propertyId, tenant, client, "sm26-sandbox-client.example", "https://sm26-sandbox-client.example/", config.originSite],
        ),
      { modules: ["search"] },
    );

    // Real authorization-code + PKCE round trip against the sandbox, exactly like ads-client.test.ts.
    const started = await startAuthorization({ tenantId: tenant, clientId: client, propertyId, provider: "google_ads", createdBy: user });
    const res = await fetch(started.authorizeUrl, { redirect: "manual" });
    const loc = new URL(res.headers.get("location")!);
    const connection = await completeAuthorization({
      stateToken: loc.searchParams.get("state")!, code: loc.searchParams.get("code")!,
      principalUserId: user, provider: "google_ads",
    });
    await linkAdsCustomerId(tenant, connection.id, CUSTOMER_ID);

    engagementId = newId();
    await withTenants(
      [tenant],
      (c) =>
        c.query(
          `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status, owner_id)
           VALUES ($1,$2,$3,$4,$5,'{}',10,'active',$6)`,
          [engagementId, tenant, client, propertyId, "SM-26 engagement", user],
        ),
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
    MANIFEST_TO_NETWORK_DELAY_MS.value = 0;
  });

  // ── fixtures ───────────────────────────────────────────────────────────────────────────────────

  async function seedCampaign(opts: { externalId?: string | null }): Promise<string> {
    const campaignId = newId();
    await withTenants(
      [tenant],
      (c) =>
        c.query(
          `INSERT INTO search_campaigns (id, tenant_id, engagement_id, platform, external_id, name, status)
           VALUES ($1,$2,$3,'google_ads',$4,'SM-26 campaign','live')`,
          [campaignId, tenant, engagementId, opts.externalId ?? null],
        ),
      { modules: ["search"] },
    );
    return campaignId;
  }

  async function seedAdGroup(campaignId: string, name: string, externalId: string | null): Promise<void> {
    await withTenants(
      [tenant],
      (c) =>
        c.query(
          `INSERT INTO search_ad_groups (id, tenant_id, campaign_id, name, external_id) VALUES ($1,$2,$3,$4,$5)`,
          [newId(), tenant, campaignId, name, externalId],
        ),
      { modules: ["search"] },
    );
  }

  async function seedKeyword(opts: { metricsSimulated: boolean }): Promise<string> {
    const setId = newId();
    const keywordId = newId();
    await withTenants(
      [tenant],
      async (c) => {
        await c.query(
          `INSERT INTO search_keyword_sets (id, tenant_id, engagement_id, name, source) VALUES ($1,$2,$3,'SM-26 set','client')`,
          [setId, tenant, engagementId],
        );
        await c.query(
          `INSERT INTO search_keywords (id, tenant_id, set_id, keyword, metrics_provider, metrics_simulated)
           VALUES ($1,$2,$3,'sm26 keyword',$4,$5)`,
          [keywordId, tenant, setId, opts.metricsSimulated ? "dataforseo_sim" : "dataforseo", opts.metricsSimulated],
        );
      },
      { modules: ["search"] },
    );
    return keywordId;
  }

  /** Mirrors search.controller.ts's own STEP 5 claim insert (proposal + approval + dispatched
   *  execution), the exact state that exists by the time the executor runs in production. */
  async function seedDispatchedExecution(params: { campaignId: string; kind: string; operationsCount: number }) {
    const proposalId = newId();
    const approvalId = newId();
    const executionId = newId();
    await withTenants(
      [tenant],
      async (c) => {
        await c.query(
          `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, status, origin_site)
           VALUES ($1,$2,'sm26-test','search.launchCampaign','approved',$3)`,
          [approvalId, tenant, config.originSite],
        );
        await c.query(
          `INSERT INTO search_change_proposals (id, tenant_id, campaign_id, kind, payload, status, mode, approval_id)
           VALUES ($1,$2,$3,$4,'{}','approved','api',$5)`,
          [proposalId, tenant, params.campaignId, params.kind, approvalId],
        );
        await c.query(
          `INSERT INTO search_change_executions
             (id, tenant_id, proposal_id, campaign_id, approval_id, kind, mode, payload_hash, status, changes_total, simulated, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,'api','sm26-test-hash','dispatched',$7,false,$8)`,
          [executionId, tenant, proposalId, params.campaignId, approvalId, params.kind, params.operationsCount, config.originSite],
        );
      },
      { modules: ["search"] },
    );
    return { proposalId, approvalId, executionId };
  }

  async function manifestRows(executionId: string): Promise<ManifestRow[]> {
    const rows = await withTenants(
      [tenant],
      (c) =>
        c.query<ManifestRow>(
          `SELECT position, ref, ads_resource, resource_name, outcome, error_detail
             FROM search_ads_execution_manifest WHERE execution_id = $1 ORDER BY position ASC`,
          [executionId],
        ),
      { modules: ["search"] },
    );
    return rows.rows;
  }

  // ── 1 · manifest persisted BEFORE the send (Ruling 6.1) — self-asserting instrument ─────────────

  it("persists the manifest before the first Ads mutate HTTP call, proven while the network call is still pending", async () => {
    const campaignId = await seedCampaign({ externalId: "700001" });
    const ops: ChangeOperation[] = [
      { ref: `campaign.pause#${campaignId}`, opType: "campaign.pause", entityType: "search_campaign", entityId: campaignId, fields: { name: "x", status: "paused" } },
    ];
    const { proposalId, executionId } = await seedDispatchedExecution({ campaignId, kind: "pause", operationsCount: 1 });
    const ctx: AdsExecutorContext = { tenantId: tenant, proposalId, campaignId, kind: "pause", operations: ops };

    MANIFEST_TO_NETWORK_DELAY_MS.value = 300;
    const pending = googleAdsLiveExecutor(ctx);
    await new Promise((r) => setTimeout(r, 100));

    // The manifest row is visible from a SEPARATE query, and the network call has demonstrably not
    // happened yet — the elapsed/hit-count instrument self-asserts, per the negative-control rule's
    // "instruments self-assert" clause (sem-apply.ts's own APPLY_RACE_DELAY_MS precedent).
    const rowsDuring = await manifestRows(executionId);
    expect(rowsDuring).toHaveLength(1);
    expect(rowsDuring[0].resource_name).toBeNull(); // not yet learned — the send hasn't happened
    expect(sb.hitCount("ads:mutate")).toBe(0);

    const report = await pending;
    expect(sb.hitCount("ads:mutate")).toBe(1);
    expect(report.results[0].outcome).toBe("applied");

    const rowsAfter = await manifestRows(executionId);
    expect(rowsAfter[0].resource_name).toBe(`customers/${CUSTOMER_ID}/campaigns/1`);
    expect(rowsAfter[0].outcome).toBe("applied");
  });

  // ── 2/5 · clean single-op happy path (campaign.pause) + resource_name capture ────────────────────

  it("pauses a linked campaign cleanly: applied, resource_name captured on both the report and the manifest", async () => {
    const campaignId = await seedCampaign({ externalId: "700002" });
    const ops: ChangeOperation[] = [
      { ref: `campaign.pause#${campaignId}`, opType: "campaign.pause", entityType: "search_campaign", entityId: campaignId, fields: { name: "x", status: "paused" } },
    ];
    const { proposalId, executionId } = await seedDispatchedExecution({ campaignId, kind: "pause", operationsCount: 1 });
    const report = await googleAdsLiveExecutor({ tenantId: tenant, proposalId, campaignId, kind: "pause", operations: ops });

    expect(report.provider).toBe("google_ads");
    expect(report.simulated).toBe(false);
    expect(report.results).toEqual([
      { ref: ops[0].ref, outcome: "applied", remoteId: `customers/${CUSTOMER_ID}/campaigns/1`, detail: null },
    ]);

    const outcome = reconcileExecution(ops, report, false);
    expect(outcome.status).toBe("applied");
    expect(outcome.echoViolations).toEqual([]);

    const rows = await manifestRows(executionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ads_resource: "campaigns", outcome: "applied", resource_name: `customers/${CUSTOMER_ID}/campaigns/1` });
  });

  // ── 3 · count/shape mismatch ⇒ indeterminate-ALL (Ruling 6.3), via sem-apply.ts's OWN reconciler ──

  it("a count/shape mismatch in one resource-type call impeaches the WHOLE execution's addressing (indeterminate-all)", async () => {
    const campaignId = await seedCampaign({ externalId: "700003" });
    await seedAdGroup(campaignId, "AG-mismatch", "800001");
    const kwA = newId();
    const kwB = newId();
    const ops: ChangeOperation[] = [
      { ref: `keyword.add#${kwA}`, opType: "keyword.add", entityType: "search_keyword", entityId: kwA, fields: { keyword: GOOGLE_SANDBOX_ADS_MUTATE_COUNT_MISMATCH_MARKER, adGroupName: "AG-mismatch", matchType: "broad" } },
      { ref: `keyword.add#${kwB}`, opType: "keyword.add", entityType: "search_keyword", entityId: kwB, fields: { keyword: "clean keyword", adGroupName: "AG-mismatch", matchType: "broad" } },
    ];
    const { proposalId, executionId } = await seedDispatchedExecution({ campaignId, kind: "launch", operationsCount: 2 });
    const report = await googleAdsLiveExecutor({ tenantId: tenant, proposalId, campaignId, kind: "launch", operations: ops });

    // The executor never hand-rolls `indeterminate` — it withholds ALL results, and sem-apply.ts's
    // OWN reconcileExecution (unmodified) derives indeterminate from that, exactly as it would for any
    // other executor whose echo failed.
    expect(report.results).toEqual([]);
    const outcome = reconcileExecution(ops, report, false);
    expect(outcome.status).toBe("indeterminate");
    expect(outcome.changesUnknown).toBe(2);
    expect(outcome.appliedEntityIds).toEqual([]);
    expect(outcome.echoViolations.some((v) => v.includes("no result"))).toBe(true);

    // Recorded regardless (§A14.5 record-before-raise) — the manifest still carries both rows, with
    // an impeachment note, even though neither could be safely attributed.
    const rows = await manifestRows(executionId);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.outcome).toBeNull();
      expect(r.resource_name).toBeNull();
      expect(r.error_detail).toMatch(/expected 2 result\(s\), got 1/);
    }
  });

  // ── 4 · a per-row partialFailureError is a PER-ROW outcome, never an addressing failure ──────────

  it("a per-row partial-failure inside a correctly-sized response yields 'partial', not indeterminate", async () => {
    const campaignId = await seedCampaign({ externalId: "700004" });
    await seedAdGroup(campaignId, "AG-partial", "800002");
    const kwA = newId();
    const kwB = newId();
    const ops: ChangeOperation[] = [
      { ref: `keyword.add#${kwA}`, opType: "keyword.add", entityType: "search_keyword", entityId: kwA, fields: { keyword: GOOGLE_SANDBOX_ADS_MUTATE_ROW_FAIL_MARKER, adGroupName: "AG-partial", matchType: "broad" } },
      { ref: `keyword.add#${kwB}`, opType: "keyword.add", entityType: "search_keyword", entityId: kwB, fields: { keyword: "clean keyword", adGroupName: "AG-partial", matchType: "broad" } },
    ];
    const { proposalId, executionId } = await seedDispatchedExecution({ campaignId, kind: "launch", operationsCount: 2 });
    const report = await googleAdsLiveExecutor({ tenantId: tenant, proposalId, campaignId, kind: "launch", operations: ops });

    expect(report.results).toHaveLength(2);
    const failed = report.results.find((r) => r.ref === ops[0].ref)!;
    const applied = report.results.find((r) => r.ref === ops[1].ref)!;
    expect(failed.outcome).toBe("failed");
    expect(failed.remoteId).toBeNull();
    expect(failed.detail).toMatch(/one or more operations failed/);
    expect(applied.outcome).toBe("applied");
    expect(applied.remoteId).toBe(`customers/${CUSTOMER_ID}/adGroupCriteria/2`);

    const outcome = reconcileExecution(ops, report, false);
    expect(outcome.status).toBe("partial");
    expect(outcome.changesApplied).toBe(1);
    expect(outcome.changesFailed).toBe(1);
    expect(outcome.changesUnknown).toBe(0);
    expect(outcome.echoViolations).toEqual([]); // NOT an addressing failure

    const rows = await manifestRows(executionId);
    const rowA = rows.find((r) => r.ref === ops[0].ref)!;
    const rowB = rows.find((r) => r.ref === ops[1].ref)!;
    expect(rowA.outcome).toBe("failed");
    expect(rowB.outcome).toBe("applied");
    expect(rowB.resource_name).toBe(`customers/${CUSTOMER_ID}/adGroupCriteria/2`);
  });

  // ── 6 · THE FORBIDDEN CROSS-PRODUCT (Ruling 3.2/§A12.6) — refused, no override, nothing sent ─────

  it("refuses a live push derived from simulated keyword data, with no override, and sends nothing", async () => {
    const campaignId = await seedCampaign({ externalId: "700005" });
    await seedAdGroup(campaignId, "AG-simulated", "800003");
    const kwId = await seedKeyword({ metricsSimulated: true });
    const ops: ChangeOperation[] = [
      { ref: `keyword.add#${kwId}`, opType: "keyword.add", entityType: "search_keyword", entityId: kwId, fields: { keyword: "sim keyword", adGroupName: "AG-simulated", matchType: "broad" } },
    ];
    const { proposalId, executionId } = await seedDispatchedExecution({ campaignId, kind: "launch", operationsCount: 1 });

    await expect(
      googleAdsLiveExecutor({ tenantId: tenant, proposalId, campaignId, kind: "launch", operations: ops }),
    ).rejects.toThrow(SimulatedKeywordDataRefusedError);

    expect(sb.hitCount("ads:mutate")).toBe(0);
    expect(await manifestRows(executionId)).toEqual([]); // nothing sent ⇒ no manifest either
  });

  it("does NOT refuse a live push whose keyword data is real (metrics_simulated = false)", async () => {
    const campaignId = await seedCampaign({ externalId: "700006" });
    await seedAdGroup(campaignId, "AG-real", "800004");
    const kwId = await seedKeyword({ metricsSimulated: false });
    const ops: ChangeOperation[] = [
      { ref: `keyword.add#${kwId}`, opType: "keyword.add", entityType: "search_keyword", entityId: kwId, fields: { keyword: "real keyword", adGroupName: "AG-real", matchType: "broad" } },
    ];
    const { proposalId } = await seedDispatchedExecution({ campaignId, kind: "launch", operationsCount: 1 });
    const report = await googleAdsLiveExecutor({ tenantId: tenant, proposalId, campaignId, kind: "launch", operations: ops });
    expect(report.results[0].outcome).toBe("applied");
  });

  // ── 7 · flagged-not-fixed gaps refuse PRE-SEND, never mid-flight ─────────────────────────────────

  it("refuses pre-send when an ad group has no linked external_id yet (flagged upstream gap)", async () => {
    const campaignId = await seedCampaign({ externalId: "700007" });
    await seedAdGroup(campaignId, "AG-unlinked", null);
    const kwId = newId();
    const ops: ChangeOperation[] = [
      { ref: `keyword.add#${kwId}`, opType: "keyword.add", entityType: "search_keyword", entityId: kwId, fields: { keyword: "x", adGroupName: "AG-unlinked", matchType: "broad" } },
    ];
    const { proposalId, executionId } = await seedDispatchedExecution({ campaignId, kind: "launch", operationsCount: 1 });
    await expect(
      googleAdsLiveExecutor({ tenantId: tenant, proposalId, campaignId, kind: "launch", operations: ops }),
    ).rejects.toThrow(AdsAdGroupResourceUnavailableError);
    expect(sb.hitCount("ads:mutate")).toBe(0);
    expect(await manifestRows(executionId)).toEqual([]);
  });

  it("refuses pre-send for campaign.budget (no campaign_budget resource-id column to construct from)", async () => {
    const campaignId = await seedCampaign({ externalId: "700008" });
    const ops: ChangeOperation[] = [
      { ref: `campaign.budget#${campaignId}`, opType: "campaign.budget", entityType: "search_campaign", entityId: campaignId, fields: { name: "x", budgetMinor: 100000, currency: "USD" } },
    ];
    const { proposalId, executionId } = await seedDispatchedExecution({ campaignId, kind: "budget", operationsCount: 1 });
    await expect(
      googleAdsLiveExecutor({ tenantId: tenant, proposalId, campaignId, kind: "budget", operations: ops }),
    ).rejects.toThrow(AdsCampaignBudgetResourceUnavailableError);
    expect(sb.hitCount("ads:mutate")).toBe(0);
    expect(await manifestRows(executionId)).toEqual([]);
  });

  // ── 8 · fits sem-apply.ts's EXISTING executor seam, unmodified ───────────────────────────────────

  it("registers into sem-apply.ts's resolveAdsExecutor('live') seam and round-trips through reconcileExecution", async () => {
    registerLiveAdsExecutor(googleAdsLiveExecutor);
    try {
      const live = resolveAdsExecutor("live");
      expect(live.expectSimulated).toBe(false);

      const campaignId = await seedCampaign({ externalId: "700009" });
      const ops: ChangeOperation[] = [
        { ref: `campaign.pause#${campaignId}`, opType: "campaign.pause", entityType: "search_campaign", entityId: campaignId, fields: { name: "x", status: "paused" } },
      ];
      const { proposalId } = await seedDispatchedExecution({ campaignId, kind: "pause", operationsCount: 1 });
      const report = await live.executor({ tenantId: tenant, proposalId, campaignId, kind: "pause", operations: ops });
      const outcome = reconcileExecution(ops, report, live.expectSimulated);
      expect(outcome.status).toBe("applied");

      // Simulation honesty is unaffected by registering a live executor (sem-apply.ts's own rule,
      // unmodified by this ticket) — 'simulate' mode must still be structurally incapable of a live
      // push even with a live executor registered.
      const simulate = resolveAdsExecutor("simulate");
      expect(simulate.expectSimulated).toBe(true);
      const simReport = await simulate.executor({ tenantId: tenant, proposalId, campaignId, kind: "pause", operations: ops });
      expect(simReport.provider).toBe("simulation");
      expect(simReport.simulated).toBe(true);
    } finally {
      clearLiveAdsExecutor();
    }
  });
});

// ── pure tests: no DB, no sandbox — the write-mode split (Ruling 3.1) ─────────────────────────────
describe("SM-26 · resolveSearchAdsWriteMode / assertAdsWriteModeBootSafe (pure)", () => {
  const saved = process.env[SEARCH_ADS_WRITE_MODE_ENV];
  afterAll(() => {
    if (saved === undefined) delete process.env[SEARCH_ADS_WRITE_MODE_ENV];
    else process.env[SEARCH_ADS_WRITE_MODE_ENV] = saved;
  });

  it("defaults to 'simulate' when unset, independent of SEARCH_PROVIDER_MODE", () => {
    delete process.env[SEARCH_ADS_WRITE_MODE_ENV];
    expect(resolveSearchAdsWriteMode()).toBe("simulate");
  });

  it("is 'live' only on the exact value 'live'", () => {
    process.env[SEARCH_ADS_WRITE_MODE_ENV] = "live";
    expect(resolveSearchAdsWriteMode()).toBe("live");
    process.env[SEARCH_ADS_WRITE_MODE_ENV] = "LIVE"; // not the exact documented value
    expect(resolveSearchAdsWriteMode()).toBe("simulate");
  });

  it("boot-refuses live mode with no registered executor", () => {
    expect(() => assertAdsWriteModeBootSafe("live", false)).toThrow(AdsWriteModeBootError);
  });

  it("does not refuse live mode WITH a registered executor, or simulate mode either way", () => {
    expect(() => assertAdsWriteModeBootSafe("live", true)).not.toThrow();
    expect(() => assertAdsWriteModeBootSafe("simulate", false)).not.toThrow();
    expect(() => assertAdsWriteModeBootSafe("simulate", true)).not.toThrow();
  });
});
