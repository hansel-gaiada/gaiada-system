// SCP-Sd — the metrics sweep pulling SIMULATED accounts through the simulator, against live Postgres (needs DATABASE_URL_TEST:
// NOT run on the dev laptop, runs on the Linux CI gate; a skip is not a pass). No Nest app, no Cerbos: the same split
// metrics-job.test.ts uses. The SCP-3c read of the stored rows is `pipeline/simulated-metrics.http.test.ts`.
//
// Proves:
//   (D1) a live simulated post gets EXACTLY the due snapshots, `source = 'simulated'`, `reach` filled, `entered_by` NULL,
//        stamped go-live + 1, 3 and 7 days, equal to the generator's numbers, cumulative day over day.
//   (D2) a rerun writes nothing (and two sweeps at once write one set, not two): idempotent.
//   (D3) the catch-up: a post live 3.5 days gets days 1 and 3 on the next run, and day 7 is appended exactly once when it falls
//        due; a post live 12 hours gets nothing yet.
//   (D4) the switch OFF: nothing simulated is written, no error is counted, a real account's pull still works and is
//        untouched (a `pull` row, reach NULL), and the simulator is never asked about a real engine's id or the reverse.
//   (D5) the daily series: 30 `simulated` rows from a seeded account (even one whose integration id is missing), a rerun
//        changes no row (updated_at unchanged), a day already held as a real `pull` row is never overwritten, and a pending
//        account is not pulled.
//   (D6) both simulated writers refuse `simulation_disabled` while the switch is off and declare their own module scope (a
//        real row exists after a caller that passed none).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany } from "../../testing/fixtures";
import { registerPublisher, resetPublishers } from "./publisher/registry";
import { createMockPublisher, newMockPublisherState, type MockPublisherState } from "./publisher/mock-driver";
import { createSimulatedPublisher } from "./publisher/simulated-driver";
import { SOCIAL_SIMULATION_REFUSAL } from "./publisher/simulation";
import { SocialPublisherError } from "./publisher/types";
import { SNAPSHOT_DAYS, simulatedDailyMetrics, simulatedPostMetrics, snapshotCapturedAt } from "./publisher/simulated-metrics";
import {
  SIMULATED_DAILY_WINDOW_DAYS, applySimulatedDailyMetrics, appendSimulatedPostMetrics, pullTenantMetrics,
} from "./metrics-job";

const MODULES: { modules: string[] } = { modules: ["social"] };
const DAY = 86_400_000;

let seq = 0;
const uniq = (label: string): string => `scp-sd-${label}-${++seq}`;

interface Fixture { clientId: string; orgId: string; engagementId: string }

describe.skipIf(!TEST_URL)("SCP-Sd · the metrics sweep pulls simulated accounts through the simulator", () => {
  const before = { flag: config.socialSimulationEnabled, key: config.social.publisher.defaultOrgApiKey };
  let clock = Date.now();
  let mock: MockPublisherState;

  /** The switch on, with the simulator registered under a clock the test moves. */
  function simulate(): void {
    config.socialSimulationEnabled = true;
    resetPublishers();
    registerPublisher(createSimulatedPublisher({ now: () => clock }));
  }

  async function makeTenant(label: string): Promise<{ tenant: string } & Fixture> {
    const tenant = await createCompany(`SCP-Sd ${label}`, ["social"]);
    const clientId = newId();
    await withTenants([tenant], (c) =>
      c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'Mock Client Kopi Senja','central')`, [clientId, tenant]));
    const orgId = newId();
    await withTenants([tenant], (c) => c.query(
      `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
       VALUES ($1,$2,$3,'postiz',$4,'default','active','central')`, [orgId, tenant, clientId, uniq("org")]), MODULES);
    const engagementId = newId();
    await withTenants([tenant], (c) => c.query(
      `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, origin_site)
       VALUES ($1,$2,$3,'SCP-Sd engagement','active','{}',10,'central')`, [engagementId, tenant, clientId]), MODULES);
    return { tenant, clientId, orgId, engagementId };
  }

  async function makeAccount(
    t: { tenant: string } & Fixture, network: string,
    o: { simulated: boolean; connected?: boolean; integration?: string | null },
  ): Promise<string> {
    const id = newId();
    const integration = o.integration === undefined ? (o.simulated ? `simulated:${network}` : uniq("integration")) : o.integration;
    await withTenants([t.tenant], (c) => c.query(
      `INSERT INTO social_accounts
         (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, simulated, origin_site)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'{}',$9,'central')`,
      [id, t.tenant, t.clientId, t.orgId, network, uniq("@mock-kopi-senja"), integration, o.connected === false ? "pending" : "connected", o.simulated],
    ), MODULES);
    return id;
  }

  /** A PUBLISHED variant (with its post, approval and hash) that went live `liveMsAgo` before the test clock. */
  async function makeVariant(
    t: { tenant: string } & Fixture, accountId: string, network: string,
    o: { simulated: boolean; liveMsAgo: number; format?: string | null },
  ): Promise<{ variantId: string; providerPostId: string; wentLive: Date }> {
    const postId = newId();
    const variantId = newId();
    const approvalId = newId();
    const wentLive = new Date(clock - o.liveMsAgo);
    const providerPostId = o.simulated ? `simulated:${network}:${wentLive.getTime()}:${newId()}` : uniq("real-post");
    await withTenants([t.tenant], async (c) => {
      await c.query(
        `INSERT INTO automation_approvals
           (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at, origin, origin_site, execution_status)
         VALUES ($1,$2,'wf:delivery','social.publishPost','{}','high','approved',NULL,NULL,now(),'automation','main','executed')`,
        [approvalId, t.tenant]);
      await c.query(
        `INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, format, went_live_at, origin_site)
         VALUES ($1,$2,$3,'SCP-Sd post','publishing',$4,$5,'central')`,
        [postId, t.tenant, t.engagementId, o.format === undefined ? "reel" : o.format, wentLive]);
      await c.query(
        `INSERT INTO social_post_variants
           (id, tenant_id, post_id, account_id, body, media, settings, args_sha256, approval_id, provider_post_id, status, published_at, simulated, origin_site)
         VALUES ($1,$2,$3,$4,'body','[]','{}','deadbeef',$5,$6,'published',$7,$8,'central')`,
        [variantId, t.tenant, postId, accountId, approvalId, providerPostId, wentLive, o.simulated]);
    }, MODULES);
    return { variantId, providerPostId, wentLive };
  }

  const snapshots = async (variantId: string) =>
    (await adminPool().query(
      `SELECT source, reach, impressions, likes, comments, shares, saves, video_views, clicks, entered_by, fetched_at
         FROM social_post_metrics WHERE variant_id = $1 ORDER BY fetched_at`, [variantId])).rows as Array<Record<string, unknown>>;
  const dailyCount = async (accountId: string) =>
    Number((await adminPool().query(`SELECT count(*) AS n FROM social_metrics_daily WHERE account_id = $1`, [accountId])).rows[0].n);
  const sweep = (tenant: string) => pullTenantMetrics(tenant, new Date(clock));

  beforeAll(async () => {
    await initTestDb();
    config.social.publisher.defaultOrgApiKey = "test-org-key";
  }, 120_000);
  afterAll(async () => {
    config.socialSimulationEnabled = before.flag;
    config.social.publisher.defaultOrgApiKey = before.key;
    resetPublishers();
    await teardownTestDb();
  });
  beforeEach(() => {
    clock = Date.now();
    mock = newMockPublisherState();
    resetPublishers();
    config.socialSimulationEnabled = false;
  });
  afterEach(() => {
    config.socialSimulationEnabled = false;
    resetPublishers();
  });

  // ══ (D1) exactly the due snapshots, marked simulated, with reach ═══════════════════════════════════════════════════

  it("(D1) a post live 9.5 days gets exactly days 1, 3 and 7: source 'simulated', reach filled, stamped go-live + day, the generator's numbers", async () => {
    simulate();
    const t = await makeTenant("D1");
    const account = await makeAccount(t, "instagram", { simulated: true });
    const v = await makeVariant(t, account, "instagram", { simulated: true, liveMsAgo: 9.5 * DAY });

    const result = await sweep(t.tenant);
    expect(result.errors).toBe(0);
    expect(result.posts).toBe(1);
    expect(result.postMetricRows).toBe(3);

    const rows = await snapshots(v.variantId);
    expect(rows).toHaveLength(3);
    for (const [i, day] of SNAPSHOT_DAYS.entries()) {
      const want = simulatedPostMetrics(v.variantId, "instagram", "reel", day);
      expect(rows[i]).toMatchObject({
        source: "simulated", entered_by: null, reach: want.reach, impressions: want.impressions, likes: want.likes,
        comments: want.comments, shares: want.shares, saves: want.saves, video_views: want.videoViews, clicks: want.clicks,
      });
      expect((rows[i].fetched_at as Date).toISOString()).toBe(snapshotCapturedAt(v.wentLive, day).toISOString());
      expect(rows[i].reach).not.toBeNull();
    }
    // Cumulative: no counter falls from one day to the next.
    for (const k of ["reach", "impressions", "likes", "comments", "shares", "saves", "video_views", "clicks"]) {
      expect(rows[1][k] as number, k).toBeGreaterThanOrEqual(rows[0][k] as number);
      expect(rows[2][k] as number, k).toBeGreaterThanOrEqual(rows[1][k] as number);
    }
  });

  it("(D1b) a post with no format reads as feed (no video views, NULL not 0), and two variants of different networks differ", async () => {
    simulate();
    const t = await makeTenant("D1b");
    const ig = await makeAccount(t, "instagram", { simulated: true });
    const fb = await makeAccount(t, "facebook", { simulated: true });
    const a = await makeVariant(t, ig, "instagram", { simulated: true, liveMsAgo: 8 * DAY, format: null });
    const b = await makeVariant(t, fb, "facebook", { simulated: true, liveMsAgo: 8 * DAY, format: null });
    await sweep(t.tenant);
    const ra = await snapshots(a.variantId);
    const rb = await snapshots(b.variantId);
    expect(ra).toHaveLength(3);
    expect(ra.every((r) => r.video_views === null)).toBe(true);
    expect(ra[2]).toMatchObject({ reach: simulatedPostMetrics(a.variantId, "instagram", null, 7).reach });
    const shape = (r: Record<string, unknown>) => [r.reach, r.impressions, r.likes, r.clicks].join("/");
    expect(shape(rb[2])).not.toBe(shape(ra[2])); // the seed is the VARIANT, so two networks of one client never share numbers
  });

  // ══ (D2) idempotent ════════════════════════════════════════════════════════════════════════════════════════════════

  it("(D2) a rerun writes nothing, and two sweeps at the same moment write one set of snapshots, not two", async () => {
    simulate();
    const t = await makeTenant("D2");
    const account = await makeAccount(t, "instagram", { simulated: true });
    const v = await makeVariant(t, account, "instagram", { simulated: true, liveMsAgo: 10 * DAY });

    expect((await sweep(t.tenant)).postMetricRows).toBe(3);
    const again = await sweep(t.tenant);
    expect(again.errors).toBe(0);
    expect(again.postMetricRows).toBe(0);
    expect(await snapshots(v.variantId)).toHaveLength(3);

    const t2 = await makeTenant("D2b");
    const acct2 = await makeAccount(t2, "tiktok", { simulated: true });
    const v2 = await makeVariant(t2, acct2, "tiktok", { simulated: true, liveMsAgo: 10 * DAY });
    const [x, y] = await Promise.all([sweep(t2.tenant), sweep(t2.tenant)]);
    expect(x.errors + y.errors).toBe(0);
    expect(x.postMetricRows + y.postMetricRows).toBe(3);
    expect(await snapshots(v2.variantId)).toHaveLength(3);
  });

  // ══ (D3) catch-up and the not-yet-due ══════════════════════════════════════════════════════════════════════════════

  it("(D3) a post live 3.5 days gets days 1 and 3 at once; day 7 is appended exactly once when it falls due; a post live 12 hours gets nothing", async () => {
    simulate();
    const t = await makeTenant("D3");
    const account = await makeAccount(t, "instagram", { simulated: true });
    const old = await makeVariant(t, account, "instagram", { simulated: true, liveMsAgo: 3.5 * DAY });
    const fresh = await makeVariant(t, account, "instagram", { simulated: true, liveMsAgo: 0.5 * DAY });

    expect((await sweep(t.tenant)).postMetricRows).toBe(2);
    const first = await snapshots(old.variantId);
    expect(first.map((r) => (r.fetched_at as Date).toISOString())).toEqual([
      snapshotCapturedAt(old.wentLive, 1).toISOString(), snapshotCapturedAt(old.wentLive, 3).toISOString(),
    ]);
    expect(await snapshots(fresh.variantId)).toHaveLength(0);

    clock += 4 * DAY; // day 7 of `old` falls due; day 1 of `fresh` too
    const next = await sweep(t.tenant);
    expect(next.errors).toBe(0);
    expect(next.postMetricRows).toBe(3); // old: day 7 (1); fresh, live 4.5 days by now: days 1 and 3 (2)
    expect(await snapshots(old.variantId)).toHaveLength(3);
    expect(await snapshots(fresh.variantId)).toHaveLength(2);
    expect((await sweep(t.tenant)).postMetricRows).toBe(0);
  });

  // ══ (D4) the switch off, and a real account ════════════════════════════════════════════════════════════════════════

  it("(D4) with the switch OFF nothing simulated is written and no error is counted; a real account is pulled as before and untouched", async () => {
    const t = await makeTenant("D4");
    const simAccount = await makeAccount(t, "instagram", { simulated: true });
    const simVariant = await makeVariant(t, simAccount, "instagram", { simulated: true, liveMsAgo: 9 * DAY });
    const realAccount = await makeAccount(t, "facebook", { simulated: false });
    const realVariant = await makeVariant(t, realAccount, "facebook", { simulated: false, liveMsAgo: 2 * DAY });
    // The real account's pull goes to the real (mock) engine; the simulator is NOT registered (the switch is off).
    registerPublisher(createMockPublisher(mock));

    const result = await sweep(t.tenant);
    expect(result.errors).toBe(0);
    expect(result.accounts).toBe(2);
    expect(await snapshots(simVariant.variantId)).toHaveLength(0);
    expect(await dailyCount(simAccount)).toBe(0);
    // The real variant took the real path exactly as before: one `pull` row, reach NULL (the engine's PostMetrics has none).
    const real = await snapshots(realVariant.variantId);
    expect(real).toHaveLength(1);
    expect(real[0]).toMatchObject({ source: "pull", reach: null, entered_by: null });
    // ... and the real engine was asked once per half, never about the simulated account or post.
    expect(mock.calls.filter((c) => c.op === "getAccountMetrics")).toHaveLength(1);
    expect(mock.calls.filter((c) => c.op === "getPostMetrics")).toHaveLength(1);
    expect(result.postMetricRows).toBe(1);
    const simRows = await adminPool().query(`SELECT count(*) AS n FROM social_post_metrics WHERE tenant_id = $1 AND source = 'simulated'`, [t.tenant]);
    expect(Number(simRows.rows[0].n)).toBe(0);
  });

  it("(D4b) with the switch ON a simulated account's numbers come from the simulator alone: no real engine is asked", async () => {
    // The registry refuses a real engine beside the simulator (so none can be registered); the mock's call log stays empty
    // because it is never wired in, which proves the sweep reached the simulator through the resolver and nothing else.
    simulate();
    const t = await makeTenant("D4b");
    const account = await makeAccount(t, "instagram", { simulated: true });
    await makeVariant(t, account, "instagram", { simulated: true, liveMsAgo: 9 * DAY });
    const result = await sweep(t.tenant);
    expect(result.errors).toBe(0);
    expect(result.postMetricRows).toBe(3);
    expect(mock.calls).toEqual([]);
  });

  it("(D4c) the switch on but the simulator not registered: a simulated account counts an error and writes nothing (it never falls through)", async () => {
    config.socialSimulationEnabled = true; // and no simulator registered
    const t = await makeTenant("D4c");
    const account = await makeAccount(t, "instagram", { simulated: true });
    const v = await makeVariant(t, account, "instagram", { simulated: true, liveMsAgo: 9 * DAY });
    const result = await sweep(t.tenant);
    expect(result.errors).toBeGreaterThan(0);
    expect(await snapshots(v.variantId)).toHaveLength(0);
    expect(await dailyCount(account)).toBe(0);
  });

  // ══ (D5) the daily series ══════════════════════════════════════════════════════════════════════════════════════════

  it("(D5) a simulated account gets a 30-day series with source 'simulated'; a rerun changes no row; a real `pull` day is never overwritten", async () => {
    simulate();
    const t = await makeTenant("D5");
    // SCP-Sa2: a simulated account always carries `simulated:<network>` now (social_accounts_kind_ck; it was allowed to carry
    // none before), so this is the seed's own shape.
    const account = await makeAccount(t, "instagram", { simulated: true });
    const today = new Date(clock).toISOString().slice(0, 10);
    const held = new Date(clock - 5 * DAY).toISOString().slice(0, 10);
    // A day already held as a real pull row, with a value the generator would never write.
    await adminPool().query(
      `INSERT INTO social_metrics_daily (tenant_id, account_id, date, followers, source) VALUES ($1,$2,$3,1,'pull')`, [t.tenant, account, held]);

    const first = await sweep(t.tenant);
    expect(first.errors).toBe(0);
    expect(first.accounts).toBe(1);
    expect(first.dailyRows).toBe(SIMULATED_DAILY_WINDOW_DAYS - 1); // 30 days, one of them held by a real row
    expect(await dailyCount(account)).toBe(SIMULATED_DAILY_WINDOW_DAYS);

    const rows = (await adminPool().query(
      `SELECT date::text AS date, followers, reach, impressions, engagements, link_clicks, video_views, source, raw, updated_at
         FROM social_metrics_daily WHERE account_id = $1 ORDER BY date`, [account])).rows;
    const heldRow = rows.find((r) => r.date === held);
    expect(heldRow).toMatchObject({ followers: 1, source: "pull" });
    const todayRow = rows.find((r) => r.date === today);
    const want = simulatedDailyMetrics(account, "instagram", today) as NonNullable<ReturnType<typeof simulatedDailyMetrics>>;
    expect(todayRow).toMatchObject({
      source: "simulated", raw: { simulated: true }, followers: want.followers, reach: want.reach, impressions: want.impressions,
      engagements: want.engagements, link_clicks: want.linkClicks, video_views: want.videoViews,
    });
    expect(rows.filter((r) => r.source === "simulated")).toHaveLength(SIMULATED_DAILY_WINDOW_DAYS - 1);

    const again = await sweep(t.tenant);
    expect(again.errors).toBe(0);
    expect(again.dailyRows).toBe(0);
    const after = (await adminPool().query(`SELECT date::text AS date, updated_at FROM social_metrics_daily WHERE account_id = $1 ORDER BY date`, [account])).rows;
    expect(after.map((r) => (r.updated_at as Date).getTime())).toEqual(rows.map((r) => (r.updated_at as Date).getTime()));
  });

  it("(D5b) a pending simulated account is not pulled", async () => {
    simulate();
    const t = await makeTenant("D5b");
    const account = await makeAccount(t, "instagram", { simulated: true, connected: false });
    const result = await sweep(t.tenant);
    expect(result.accounts).toBe(0);
    expect(await dailyCount(account)).toBe(0);
  });

  // ══ (D6) the writers' own fences ═══════════════════════════════════════════════════════════════════════════════════

  it("(D6) both simulated writers refuse simulation_disabled with the switch off, and write a real row with the switch on and no caller-side scope", async () => {
    const t = await makeTenant("D6");
    const account = await makeAccount(t, "instagram", { simulated: true });
    const v = await makeVariant(t, account, "instagram", { simulated: true, liveMsAgo: 9 * DAY });
    const metrics = { providerPostId: v.providerPostId, reach: 100, likes: 5, capturedAt: new Date(clock - 2 * DAY).toISOString() };

    config.socialSimulationEnabled = false;
    for (const call of [
      () => appendSimulatedPostMetrics(t.tenant, [{ variantId: v.variantId, metrics }]),
      () => applySimulatedDailyMetrics(t.tenant, account, [{ date: "2026-11-01", followers: 10 }]),
    ]) {
      const err = await call().then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(SocialPublisherError);
      expect((err as SocialPublisherError).code).toBe(SOCIAL_SIMULATION_REFUSAL.disabled);
    }
    expect(await snapshots(v.variantId)).toHaveLength(0);

    config.socialSimulationEnabled = true;
    expect((await appendSimulatedPostMetrics(t.tenant, [{ variantId: v.variantId, metrics }])).written).toBe(1);
    expect((await appendSimulatedPostMetrics(t.tenant, [{ variantId: v.variantId, metrics }])).written).toBe(0);
    expect((await applySimulatedDailyMetrics(t.tenant, account, [{ date: "2026-11-01", followers: 10 }])).written).toBe(1);
    expect((await applySimulatedDailyMetrics(t.tenant, account, [{ date: "2026-11-01", followers: 10 }])).written).toBe(0);
    expect((await applySimulatedDailyMetrics(t.tenant, account, [{ date: "2026-11-01", followers: 11 }])).written).toBe(1);
    const stored = await snapshots(v.variantId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ source: "simulated", reach: 100, likes: 5, impressions: null, video_views: null });
  });

  it("(D6b) a simulated snapshot with no usable capturedAt is skipped, never written unstamped", async () => {
    config.socialSimulationEnabled = true;
    const t = await makeTenant("D6b");
    const account = await makeAccount(t, "instagram", { simulated: true });
    const v = await makeVariant(t, account, "instagram", { simulated: true, liveMsAgo: 9 * DAY });
    const out = await appendSimulatedPostMetrics(t.tenant, [
      { variantId: v.variantId, metrics: { providerPostId: v.providerPostId, reach: 1 } },
      { variantId: v.variantId, metrics: { providerPostId: v.providerPostId, reach: 1, capturedAt: "not a date" } },
    ]);
    expect(out.written).toBe(0);
    expect(await snapshots(v.variantId)).toHaveLength(0);
  });
});
