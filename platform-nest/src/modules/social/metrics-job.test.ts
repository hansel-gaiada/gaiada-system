// SMM-21 — `metrics-job.ts`: `pullMetrics` against a live Postgres + the mock publisher.
//
// ── ⚠ THE MODULE-GUC REGRESSION TEST, THE TICKET DEMANDED BY NAME ─────────────────────────────────
// (T1)/(T5) below call `applyAccountDailyMetrics`/`appendPostMetrics` exactly as written — no
// `{modules:['social']}` passed at the call site, because the FUNCTION is what declares its own
// scope internally (`declareSocialModuleScope`) — and assert a REAL row exists afterward. Delete
// either declaration and these assertions fail with "written: 0" instead of a real write, which is
// the exact "0 rows synced, looks perfectly healthy" failure shape the ticket brief named. This
// mirrors `post-status-sync-job.test.ts`'s (T1) and `inbox-retention-job.test.ts`'s (1) verbatim.
//
// ── ⚠ NO INVENTED NUMBERS ───────────────────────────────────────────────────────────────────────
// (T2)/(T6) assert that a field the driver did not report comes back as SQL NULL from a direct
// re-read, never coerced to 0 — the regression proof for the "absent counter is unknown, never
// zero" rule this whole module holds `quota_unknown` to.
//
// ── THE MOCK DRIVER'S FIXED STUB, NAMED RATHER THAN WORKED AROUND ─────────────────────────────────
// `publisher/mock-driver.ts` (SMM-38a's file, out of scope here) hard-codes `getAccountMetrics` to
// return `[]` and `getPostMetrics` to return a bare `{providerPostId}` per id, regardless of test
// state — unlike `posts`/`quota`/`integrations`, there is no per-test-configurable map for either.
// (T7)'s sweep-level assertions are written AROUND that fact (0 daily rows from the sweep is the
// mock's own honest behaviour, not a bug) rather than modifying the shared file to add one.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany } from "../../testing/fixtures";
import { registerPublisher, resetPublishers } from "./publisher/registry";
import { createMockPublisher, newMockPublisherState, type MockPublisherState } from "./publisher/mock-driver";
import { SocialPublisherError } from "./publisher/types";
import {
  applyAccountDailyMetrics, appendPostMetrics, pullTenantMetrics, runMetricsPull,
  socialMetricsPullEnabled, socialMetricsPullIntervalMs,
} from "./metrics-job";

const MODULES: { modules: string[] } = { modules: ["social"] };

let seq = 0;
const uniq = (label: string): string => `smm21-metrics-${label}-${++seq}`;

async function makeTenant(name: string): Promise<string> {
  return createCompany(name, ["social"]);
}

async function makeAccount(
  tenant: string, network: string, opts: { connected?: boolean } = {},
): Promise<{ accountId: string; orgId: string; clientId: string }> {
  const clientId = newId();
  await withTenants([tenant], (c) =>
    c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'metrics client','central')`, [clientId, tenant]));
  const orgId = newId();
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
       VALUES ($1,$2,$3,'postiz',$4,'default','active','central')`,
      [orgId, tenant, clientId, uniq("org")]), MODULES);
  const accountId = newId();
  const status = opts.connected === false ? "pending" : "connected";
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO social_accounts
         (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, origin_site)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'{}','central')`,
      [accountId, tenant, clientId, orgId, network, uniq("@brand"), uniq("integration"), status]), MODULES);
  return { accountId, orgId, clientId };
}

async function makePublishedVariant(
  tenant: string, clientId: string, accountId: string, providerPostId: string, publishedDaysAgo = 1,
): Promise<string> {
  const engagementId = newId();
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, origin_site)
       VALUES ($1,$2,$3,'metrics engagement','active','{}',10,'central')`,
      [engagementId, tenant, clientId]), MODULES);
  const postId = newId();
  const variantId = newId();
  const approvalId = newId();
  await withTenants([tenant], async (c) => {
    // 0105's `svar_dispatched_has_approval` CHECK requires a non-draft, non-native variant to
    // carry BOTH an approval and its hash — mirrors `post-status-sync-job.test.ts`'s own
    // `makeInFlightVariant` fixture.
    await c.query(`INSERT INTO automation_approvals
         (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at, origin, origin_site, execution_status)
       VALUES ($1,$2,'wf:delivery','social.publishPost','{}','high','approved',NULL,NULL,now(),'automation','main','executed')`,
      [approvalId, tenant]);
    await c.query(
      `INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site)
       VALUES ($1,$2,$3,'metrics post','publishing','central')`, [postId, tenant, engagementId]);
    await c.query(
      `INSERT INTO social_post_variants
         (id, tenant_id, post_id, account_id, body, media, settings, args_sha256, approval_id,
          provider_post_id, status, published_at, origin_site)
       VALUES ($1,$2,$3,$4,'body','[]','{}','deadbeef',$5,$6,'published',
               now() - make_interval(days => $7),'central')`,
      [variantId, tenant, postId, accountId, approvalId, providerPostId, publishedDaysAgo],
    );
  }, MODULES);
  return variantId;
}

async function dailyRow(tenant: string, accountId: string, date: string) {
  const { rows } = await withTenants([tenant], (c) =>
    c.query(
      `SELECT followers, impressions, reach, engagements, link_clicks AS "linkClicks",
              video_views AS "videoViews"
         FROM social_metrics_daily WHERE account_id = $1 AND date = $2`,
      [accountId, date],
    ), MODULES);
  return rows;
}

async function postMetricRows(tenant: string, variantId: string) {
  const { rows } = await withTenants([tenant], (c) =>
    c.query(
      `SELECT impressions, likes, comments, shares, saves, video_views AS "videoViews", clicks, fetched_at AS "fetchedAt"
         FROM social_post_metrics WHERE variant_id = $1 ORDER BY fetched_at`,
      [variantId],
    ), MODULES);
  return rows;
}

describe.skipIf(!TEST_URL)("SMM-21 · metrics-job — pullMetrics into social_metrics_daily / social_post_metrics", () => {
  let A: string;
  let state: MockPublisherState;
  let defaultOrgApiKeyBefore: string;

  beforeAll(async () => {
    await initTestDb();
    // `openOrg` resolves `apiKeyRef: 'default'` (what every fixture below inserts) via
    // `config.social.publisher.defaultOrgApiKey` — unset, it throws before the mock driver is
    // ever reached (mirrors `post-status-sync-job.test.ts`'s own beforeAll).
    defaultOrgApiKeyBefore = config.social.publisher.defaultOrgApiKey;
    config.social.publisher.defaultOrgApiKey = "test-org-key";
    A = await makeTenant("SMM-21 Metrics Agency");
  });

  afterAll(async () => {
    config.social.publisher.defaultOrgApiKey = defaultOrgApiKeyBefore;
    await teardownTestDb();
  });

  beforeEach(() => {
    state = newMockPublisherState();
    resetPublishers();
    registerPublisher(createMockPublisher(state));
  });

  // ══ (T1) ⭐ applyAccountDailyMetrics — direct, and THIS IS THE MODULE-GUC REGRESSION TEST ══════

  it("(T1) ⭐ writes a real row through a caller-side transaction with NO module scope declared — fails if declareSocialModuleScope is ever removed", async () => {
    const { accountId } = await makeAccount(A, "instagram");
    const result = await applyAccountDailyMetrics(A, accountId, [
      { date: "2026-08-15", followers: 1200, impressions: 5400, reach: 3000, engagements: 210, linkClicks: 40, videoViews: 900 },
    ]);
    expect(result.written).toBe(1);
    const rows = await dailyRow(A, accountId, "2026-08-15");
    expect(rows).toHaveLength(1);
    expect(rows[0].followers).toBe(1200);
    expect(rows[0].impressions).toBe(5400);
    expect(rows[0].engagements).toBe(210);
  });

  // ══ (T2) NO INVENTED NUMBERS — an absent field is SQL NULL, never 0 ═══════════════════════════

  it("(T2) an absent DailyMetrics field is stored as NULL, never coerced to 0", async () => {
    const { accountId } = await makeAccount(A, "linkedin");
    // The engine reported followers and impressions; it said NOTHING about reach/engagements/
    // linkClicks/videoViews (LinkedIn's own analytics surface is documented as partial).
    await applyAccountDailyMetrics(A, accountId, [
      { date: "2026-08-16", followers: 500, impressions: 900 },
    ]);
    const rows = await dailyRow(A, accountId, "2026-08-16");
    expect(rows[0].followers).toBe(500);
    expect(rows[0].impressions).toBe(900);
    expect(rows[0].reach).toBeNull();
    expect(rows[0].engagements).toBeNull();
    expect(rows[0].linkClicks).toBeNull();
    expect(rows[0].videoViews).toBeNull();
  });

  // ══ (T3) UPSERT, NOT DUPLICATE — 0105's UNIQUE(account_id, date) is the ON CONFLICT target ════

  it("(T3) re-pulling the same day UPDATES the existing row, never inserts a second one", async () => {
    const { accountId } = await makeAccount(A, "facebook");
    await applyAccountDailyMetrics(A, accountId, [{ date: "2026-08-17", followers: 100 }]);
    await applyAccountDailyMetrics(A, accountId, [{ date: "2026-08-17", followers: 150 }]);
    const rows = await dailyRow(A, accountId, "2026-08-17");
    expect(rows).toHaveLength(1);
    expect(rows[0].followers).toBe(150);
  });

  // ══ (T4) 0 rows for an empty pull is a legitimate no-op, not a false write ════════════════════

  it("(T4) an empty series writes nothing and reports written:0", async () => {
    const { accountId } = await makeAccount(A, "instagram");
    const result = await applyAccountDailyMetrics(A, accountId, []);
    expect(result.written).toBe(0);
  });

  // ══ (T5) ⭐ appendPostMetrics — direct, ALSO the module-GUC regression for the post-metrics half ══

  it("(T5) ⭐ appends a real snapshot row with no module scope declared by the caller", async () => {
    const { accountId, clientId } = await makeAccount(A, "instagram");
    const variantId = await makePublishedVariant(A, clientId, accountId, uniq("post"));
    const result = await appendPostMetrics(A, [
      { variantId, metrics: { providerPostId: uniq("ignored"), impressions: 800, likes: 40, comments: 3 } },
    ]);
    expect(result.written).toBe(1);
    const rows = await postMetricRows(A, variantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].impressions).toBe(800);
    expect(rows[0].likes).toBe(40);
    expect(rows[0].comments).toBe(3);
    expect(rows[0].shares).toBeNull(); // never reported ⇒ NULL, never 0
  });

  // ══ (T6) APPEND-ONLY — never upserted, unlike the daily series ════════════════════════════════

  it("(T6) a second pull for the same variant APPENDS a second snapshot, never overwrites the first", async () => {
    const { accountId, clientId } = await makeAccount(A, "instagram");
    const variantId = await makePublishedVariant(A, clientId, accountId, uniq("post"));
    await appendPostMetrics(A, [{ variantId, metrics: { providerPostId: "x", impressions: 100 } }]);
    await appendPostMetrics(A, [{ variantId, metrics: { providerPostId: "x", impressions: 250 } }]);
    const rows = await postMetricRows(A, variantId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.impressions)).toEqual([100, 250]);
  });

  // ══ (T7) pullTenantMetrics — the sweep, against the mock driver's OWN fixed stub ═══════════════

  it("(T7) the sweep calls getAccountMetrics per connected account and getPostMetrics per org, batched", async () => {
    // A FRESH tenant, deliberately — `pullTenantMetrics` counts every connected account in the
    // tenant, and (T1)-(T6) above already added accounts/rows to `A`. Reusing `A` here would make
    // `result.accounts` an accumulating total across the whole file rather than this test's own.
    const T7 = await makeTenant("SMM-21 Metrics T7");
    const { accountId, clientId } = await makeAccount(T7, "instagram");
    const variantId = await makePublishedVariant(T7, clientId, accountId, uniq("post"));

    const result = await pullTenantMetrics(T7);

    expect(result.accounts).toBe(1);
    expect(result.errors).toBe(0);
    // The mock's `getAccountMetrics` is a fixed stub returning `[]` (see file header) — a real
    // driver returning data is proven separately by (T1)/(T2)/(T3) against `applyAccountDailyMetrics`
    // directly. What THIS test proves is that the sweep actually reached the driver and wrote
    // whatever it got back, honestly (0 here, because that is what the stub reported).
    expect(result.dailyRows).toBe(0);
    expect(state.calls.filter((c) => c.op === "getAccountMetrics")).toHaveLength(1);

    // The mock's `getPostMetrics` DOES echo back one bare object per id (`{providerPostId}`, every
    // other field absent) — so postMetricRows should be 1, batched into a single call for the org.
    expect(result.posts).toBe(1);
    expect(result.postMetricRows).toBe(1);
    expect(state.calls.filter((c) => c.op === "getPostMetrics")).toHaveLength(1);

    const rows = await postMetricRows(T7, variantId);
    expect(rows).toHaveLength(1);
    // No invented numbers even off the sweep path: the mock reported nothing but the id, so every
    // counter must be NULL, never a fabricated 0.
    expect(rows[0].impressions).toBeNull();
    expect(rows[0].likes).toBeNull();
  });

  it("(T8) an account with no postiz_integration_id (never connected) is not pulled at all", async () => {
    const T8 = await makeTenant("SMM-21 Metrics T8");
    const { accountId: connectedId } = await makeAccount(T8, "instagram");
    const clientId2 = newId();
    await withTenants([T8], (c) =>
      c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'pending client','central')`, [clientId2, T8]));
    const orgId2 = newId();
    await withTenants([T8], (c) =>
      c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1,$2,$3,'postiz',$4,'default','active','central')`,
        [orgId2, T8, clientId2, uniq("org")]), MODULES);
    // pending: postiz_integration_id IS NULL, status not 'connected'.
    const pendingAccount = newId();
    await withTenants([T8], (c) =>
      c.query(
        `INSERT INTO social_accounts
           (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, origin_site)
         VALUES ($1,$2,$3,$4,'facebook',$5,'pending','{}','central')`,
        [pendingAccount, T8, clientId2, orgId2, uniq("@pending")]), MODULES);

    const result = await pullTenantMetrics(T8);
    // Only the connected account (`connectedId`, made in this same tenant via `makeAccount` above)
    // should be counted; the pending one must not appear at all.
    expect(result.accounts).toBe(1);
    void connectedId;
  });

  // ══ (T9) capability gating — a driver without account_metrics/post_metrics is skipped, not error ══

  it("(T9) a driver that does not advertise account_metrics/post_metrics is skipped cleanly, zero errors", async () => {
    resetPublishers();
    registerPublisher(createMockPublisher(state, {
      capabilities: ["org_verify", "connect_url", "integrations", "schedule", "post_status"],
    }));
    const T9 = await makeTenant("SMM-21 Metrics T9");
    const { accountId, clientId } = await makeAccount(T9, "instagram");
    await makePublishedVariant(T9, clientId, accountId, uniq("post"));

    const result = await pullTenantMetrics(T9);
    expect(result.dailyRows).toBe(0);
    expect(result.postMetricRows).toBe(0);
    expect(result.errors).toBe(0);
    expect(state.calls.filter((c) => c.op === "getAccountMetrics" || c.op === "getPostMetrics")).toHaveLength(0);
  });

  // ══ (T10) per-tenant isolation — one tenant's driver failure never blocks another's pull ══════

  it("(T10) one tenant's driver failure is caught and counted; another tenant's pull still succeeds", async () => {
    const T10a = await makeTenant("SMM-21 Metrics T10a");
    const T10b = await makeTenant("SMM-21 Metrics T10b");
    const { accountId: accountA, clientId: clientA } = await makeAccount(T10a, "instagram");
    await makePublishedVariant(T10a, clientA, accountA, uniq("post"));
    const { accountId: accountB, clientId: clientB } = await makeAccount(T10b, "instagram");
    await makePublishedVariant(T10b, clientB, accountB, uniq("post"));

    // Both tenants share the SAME registered mock instance (module-level registry) — set failWith
    // AFTER tenant A's pull below so we can prove B is unaffected by a failure timed to hit A.
    const rA0 = await pullTenantMetrics(T10a);
    expect(rA0.errors).toBe(0);

    state.failWith = new SocialPublisherError("publisher_unreachable", "mock outage");
    const rA1 = await pullTenantMetrics(T10a);
    expect(rA1.errors).toBeGreaterThan(0);

    state.failWith = undefined;
    const rB = await pullTenantMetrics(T10b);
    expect(rB.errors).toBe(0);
    expect(rB.accounts).toBe(1);
  });

  // ══ (T11) runMetricsPull sweeps every tenant and aggregates ════════════════════════════════════

  it("(T11) runMetricsPull sweeps every non-deleted tenant and sums their counts", async () => {
    const T11 = await makeTenant("SMM-21 Metrics T11");
    const { accountId: accountC, clientId: clientC } = await makeAccount(T11, "instagram");
    await makePublishedVariant(T11, clientC, accountC, uniq("post"));

    const result = await runMetricsPull();
    expect(result.tenants).toBeGreaterThanOrEqual(2); // at least A and T11 exist by this point
    expect(result.errors).toBe(0);
  });

  // ══ env gate ════════════════════════════════════════════════════════════════════════════════

  it("dark by default: socialMetricsPullEnabled() is false with no env var set", () => {
    const prev = process.env.SOCIAL_METRICS_PULL_ENABLED;
    delete process.env.SOCIAL_METRICS_PULL_ENABLED;
    expect(socialMetricsPullEnabled()).toBe(false);
    process.env.SOCIAL_METRICS_PULL_ENABLED = "true";
    expect(socialMetricsPullEnabled()).toBe(true);
    if (prev === undefined) delete process.env.SOCIAL_METRICS_PULL_ENABLED;
    else process.env.SOCIAL_METRICS_PULL_ENABLED = prev;
  });

  it("socialMetricsPullIntervalMs() defaults to 24h", () => {
    const prev = process.env.SOCIAL_METRICS_PULL_INTERVAL_MS;
    delete process.env.SOCIAL_METRICS_PULL_INTERVAL_MS;
    expect(socialMetricsPullIntervalMs()).toBe(24 * 3600 * 1000);
    if (prev === undefined) delete process.env.SOCIAL_METRICS_PULL_INTERVAL_MS;
    else process.env.SOCIAL_METRICS_PULL_INTERVAL_MS = prev;
  });
});
