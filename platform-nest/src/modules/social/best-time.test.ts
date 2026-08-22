// SMM-27 — `best-time.ts`: the classical-stats best-hour-to-post computation, against a live
// Postgres + the mock publisher (for the 'unsupported' capability case).
//
// ── ⚠ THE MODULE-GUC REGRESSION TEST, THE TICKET DEMANDED BY NAME ─────────────────────────────────
// This ticket's own worst failure mode: without `declareSocialModuleScope`, a stats job would read
// ZERO ROWS from `social_post_variants`/`social_post_metrics` and SILENTLY compute
// `insufficient_evidence` from an empty set — which is indistinguishable, at the API, from the
// HONEST answer every real deployment gives today (no account connected, D-23). (G1) proves the RLS
// wall is real (a plain `withTenants([tenantId])` transaction with no module scope reads zero rows
// off a table a seeded row plainly exists in); (G2) proves `computeAccountBestTime` /
// `applyBestTimeSuggestion` — called exactly as written, no `{modules:['social']}` at the call site,
// because the FUNCTIONS declare their own scope internally — write and read back a REAL, correct
// 'suggested' verdict from seeded data that clears every threshold. Delete either internal
// `declareSocialModuleScope` call and (G2) fails outright (0 measured posts, not merely a
// differently-labelled empty result) — the same pinning shape `metrics-job.test.ts`'s (T1)/(T5) use.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany } from "../../testing/fixtures";
import { registerPublisher, resetPublishers } from "./publisher/registry";
import { createMockPublisher, newMockPublisherState, type MockPublisherState } from "./publisher/mock-driver";
import type { PublisherCapability } from "./publisher/types";
import {
  computeBestTimeFromRows, computeAccountBestTime, applyBestTimeSuggestion, getCachedBestTime,
} from "./best-time";

const MODULES: { modules: string[] } = { modules: ["social"] };
const DEFAULT_CAPS_MINUS_POST_METRICS: PublisherCapability[] = [
  "org_verify", "connect_url", "integrations", "quota_probe", "schedule", "cancel",
  "post_status", "account_metrics", "media_upload",
];

let seq = 0;
const uniq = (label: string): string => `smm27-besttime-${label}-${++seq}`;

async function makeTenant(name: string): Promise<string> {
  return createCompany(name, ["social"]);
}

async function makeAccount(tenant: string, network = "instagram"): Promise<{ accountId: string; orgId: string; clientId: string }> {
  const clientId = newId();
  await withTenants([tenant], (c) =>
    c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'best-time client','central')`, [clientId, tenant]));
  const orgId = newId();
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
       VALUES ($1,$2,$3,'postiz',$4,'default','active','central')`,
      [orgId, tenant, clientId, uniq("org")]), MODULES);
  const accountId = newId();
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO social_accounts
         (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, origin_site)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'connected','{}','central')`,
      [accountId, tenant, clientId, orgId, network, uniq("@brand"), uniq("integration")]), MODULES);
  return { accountId, orgId, clientId };
}

/** Seed one published variant AND its latest (only) metrics snapshot, at a chosen UTC hour of day,
 *  with a chosen engagement score. Mirrors `metrics-job.test.ts#makePublishedVariant` for the
 *  variant half; the metrics half is a direct `social_post_metrics` insert (this file does not
 *  exercise `appendPostMetrics` itself — that is SMM-21's own suite — only what `best-time.ts` reads
 *  back from the table it populates). */
async function seedMeasuredPost(
  tenant: string, clientId: string, accountId: string, hourUtc: number, likes: number,
): Promise<string> {
  const engagementId = newId();
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, origin_site)
       VALUES ($1,$2,$3,'best-time engagement','active','{}',10,'central')`,
      [engagementId, tenant, clientId]), MODULES);
  const postId = newId();
  const variantId = newId();
  const approvalId = newId();
  // A fixed calendar day/minute, only the HOUR varies — `published_at` is built as an explicit UTC
  // timestamptz literal so the seed itself can never be shifted by a session/local timezone, the
  // same discipline best-time.ts's own read side is held to.
  const publishedAt = `2026-06-01 ${String(hourUtc).padStart(2, "0")}:00:00+00`;
  await withTenants([tenant], async (c) => {
    await c.query(`INSERT INTO automation_approvals
         (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at, origin, origin_site, execution_status)
       VALUES ($1,$2,'wf:delivery','social.publishPost','{}','high','approved',NULL,NULL,now(),'automation','main','executed')`,
      [approvalId, tenant]);
    await c.query(
      `INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site)
       VALUES ($1,$2,$3,'best-time post','publishing','central')`, [postId, tenant, engagementId]);
    await c.query(
      `INSERT INTO social_post_variants
         (id, tenant_id, post_id, account_id, body, media, settings, args_sha256, approval_id,
          provider_post_id, status, published_at, origin_site)
       VALUES ($1,$2,$3,$4,'body','[]','{}','deadbeef',$5,$6,'published',$7::timestamptz,'central')`,
      [variantId, tenant, postId, accountId, approvalId, uniq("provider-post"), publishedAt],
    );
    await c.query(
      `INSERT INTO social_post_metrics (tenant_id, variant_id, likes, origin_site)
       VALUES ($1,$2,$3,'central')`,
      [tenant, variantId, likes],
    );
  }, MODULES);
  return variantId;
}

describe("SMM-27 · best-time — computeBestTimeFromRows (pure arithmetic, no I/O)", () => {
  const opts = { minMeasuredPosts: 5, minBucketPosts: 2, lookbackDays: 180 };

  it("(A1) fewer measured posts than minMeasuredPosts ⇒ insufficient_evidence, never a fabricated hour", () => {
    const rows = [
      { published_at: "2026-06-01T09:00:00Z", likes: 10, comments: null, shares: null, saves: null, clicks: null },
      { published_at: "2026-06-01T09:00:00Z", likes: 12, comments: null, shares: null, saves: null, clicks: null },
    ];
    const result = computeBestTimeFromRows(rows, opts);
    expect(result.status).toBe("insufficient_evidence");
    expect(result.bestHourUtc).toBeNull();
    expect(result.bestHourSampleSize).toBeNull();
    expect(result.avgEngagementScore).toBeNull();
    expect(result.totalMeasuredPosts).toBe(2);
  });

  it("(A2) enough total posts, but every hour bucket alone is below minBucketPosts ⇒ still insufficient_evidence", () => {
    // 5 posts total (clears minMeasuredPosts) but spread one-per-hour across 5 distinct hours — no
    // single bucket reaches minBucketPosts:2, so no bucket's own average is trustworthy.
    const rows = [0, 1, 2, 3, 4].map((h) => ({
      published_at: `2026-06-01T0${h}:00:00Z`, likes: 100, comments: null, shares: null, saves: null, clicks: null,
    }));
    const result = computeBestTimeFromRows(rows, opts);
    expect(result.status).toBe("insufficient_evidence");
    expect(result.totalMeasuredPosts).toBe(5);
  });

  it("(A3) a real winning bucket ⇒ suggested, with its own sample size and average", () => {
    const rows = [
      // Hour 14: 3 posts, high engagement.
      { published_at: "2026-06-01T14:00:00Z", likes: 50, comments: 10, shares: null, saves: null, clicks: null },
      { published_at: "2026-06-02T14:00:00Z", likes: 40, comments: 8, shares: null, saves: null, clicks: null },
      { published_at: "2026-06-03T14:00:00Z", likes: 60, comments: 12, shares: null, saves: null, clicks: null },
      // Hour 6: 2 posts, low engagement.
      { published_at: "2026-06-01T06:00:00Z", likes: 2, comments: 0, shares: null, saves: null, clicks: null },
      { published_at: "2026-06-02T06:00:00Z", likes: 1, comments: 0, shares: null, saves: null, clicks: null },
    ];
    const result = computeBestTimeFromRows(rows, opts);
    expect(result.status).toBe("suggested");
    expect(result.bestHourUtc).toBe(14);
    expect(result.bestHourSampleSize).toBe(3);
    expect(result.totalMeasuredPosts).toBe(5);
    // (50+10 + 40+8 + 60+12) / 3 = 60
    expect(result.avgEngagementScore).toBeCloseTo(60, 5);
    expect(result.raw["14"]).toEqual({ count: 3, avgScore: 60 });
  });

  it("(A4) a tie between two qualifying buckets is broken by the EARLIER hour, deterministically", () => {
    const rows = [
      { published_at: "2026-06-01T20:00:00Z", likes: 10, comments: null, shares: null, saves: null, clicks: null },
      { published_at: "2026-06-02T20:00:00Z", likes: 10, comments: null, shares: null, saves: null, clicks: null },
      { published_at: "2026-06-01T08:00:00Z", likes: 10, comments: null, shares: null, saves: null, clicks: null },
      { published_at: "2026-06-02T08:00:00Z", likes: 10, comments: null, shares: null, saves: null, clicks: null },
      { published_at: "2026-06-01T03:00:00Z", likes: 1, comments: null, shares: null, saves: null, clicks: null },
    ];
    const result = computeBestTimeFromRows(rows, opts);
    expect(result.status).toBe("suggested");
    expect(result.bestHourUtc).toBe(8); // earlier than 20, both averaging 10
  });

  it("(A5) an all-NULL-metrics post is the caller's job to exclude, not this function's — documented contract, not re-tested here (see loadMeasuredPosts's own SQL filter)", () => {
    // computeBestTimeFromRows trusts its input rows are already 'measured' (at least one non-null
    // field) — coalescing an ALL-null row would silently count a not-yet-fetched post as a real
    // zero-engagement observation, exactly the "no invented numbers" trap this file's header names.
    // Proven at the SQL layer instead, in the DB-backed describe block below (B2).
    expect(true).toBe(true);
  });
});

describe.skipIf(!TEST_URL)("SMM-27 · best-time — DB-backed: computeAccountBestTime / applyBestTimeSuggestion / getCachedBestTime", () => {
  let A: string;
  let state: MockPublisherState;
  let defaultOrgApiKeyBefore: string;
  let minMeasuredBefore: number;
  let minBucketBefore: number;

  beforeAll(async () => {
    await initTestDb();
    defaultOrgApiKeyBefore = config.social.publisher.defaultOrgApiKey;
    config.social.publisher.defaultOrgApiKey = "test-org-key";
    minMeasuredBefore = config.social.bestTime.minMeasuredPosts;
    minBucketBefore = config.social.bestTime.minBucketPosts;
    // Deterministic, small thresholds for this suite — not the shipped production defaults, which
    // this file's own config.test.ts coverage (if any) is responsible for pinning separately.
    config.social.bestTime.minMeasuredPosts = 4;
    config.social.bestTime.minBucketPosts = 2;
    A = await makeTenant("SMM-27 Best-Time Agency");
  });

  afterAll(async () => {
    config.social.publisher.defaultOrgApiKey = defaultOrgApiKeyBefore;
    config.social.bestTime.minMeasuredPosts = minMeasuredBefore;
    config.social.bestTime.minBucketPosts = minBucketBefore;
    await teardownTestDb();
  });

  beforeEach(() => {
    state = newMockPublisherState();
    resetPublishers();
    registerPublisher(createMockPublisher(state));
  });

  // ══ (G1) ⭐ THE MODULE-GUC TRAP ITSELF — proven directly against the RLS wall ══════════════════

  it("(G1) ⭐ a plain withTenants([tenantId]) read with NO module scope declared sees ZERO rows on a table that plainly has one — proving the trap `declareSocialModuleScope` exists to close", async () => {
    const { accountId } = await makeAccount(A);
    await withTenants([A], async (c) => {
      await c.query(
        `INSERT INTO social_best_time_suggestions
           (tenant_id, account_id, status, total_measured_posts,
            min_measured_posts_threshold, min_bucket_posts_threshold, lookback_days)
         VALUES ($1,$2,'insufficient_evidence',0,4,2,180)`,
        [A, accountId],
      );
    }, MODULES); // the WRITE is scoped correctly — this test isolates the READ side of the trap

    const unscopedRead = await withTenants([A], (c) =>
      c.query(`SELECT * FROM social_best_time_suggestions WHERE account_id = $1`, [accountId]),
    ); // ⚠ deliberately NO { modules: ["social"] } — this is the exact caller mistake the ticket names
    expect(unscopedRead.rows).toHaveLength(0);

    const scopedRead = await withTenants([A], (c) =>
      c.query(`SELECT * FROM social_best_time_suggestions WHERE account_id = $1`, [accountId]),
    MODULES);
    expect(scopedRead.rows).toHaveLength(1);
  });

  // ══ (G2) ⭐ computeAccountBestTime / applyBestTimeSuggestion — called exactly as written ═══════

  it("(G2) ⭐ computes and persists a real 'suggested' verdict from seeded data with NO {modules} option at any call site — fails (0 measured posts) if either internal declareSocialModuleScope is ever removed", async () => {
    const { accountId, clientId } = await makeAccount(A);
    // Winning bucket: hour 14, 3 posts. Runner-up: hour 6, 1 post (below minBucketPosts:2).
    await seedMeasuredPost(A, clientId, accountId, 14, 50);
    await seedMeasuredPost(A, clientId, accountId, 14, 40);
    await seedMeasuredPost(A, clientId, accountId, 14, 60);
    await seedMeasuredPost(A, clientId, accountId, 6, 1);

    const result = await computeAccountBestTime(A, accountId);
    expect(result.status).toBe("suggested");
    expect(result.bestHourUtc).toBe(14);
    expect(result.bestHourSampleSize).toBe(3);
    expect(result.totalMeasuredPosts).toBe(4);
    expect(result.avgEngagementScore).toBeCloseTo(50, 5);

    await applyBestTimeSuggestion(A, accountId, result);
    const cached = await getCachedBestTime(A, accountId);
    expect(cached).not.toBeNull();
    expect(cached?.status).toBe("suggested");
    expect(cached?.bestHourUtc).toBe(14);
    expect(cached?.bestHourSampleSize).toBe(3);
    expect(cached?.minMeasuredPostsThreshold).toBe(4);
    expect(cached?.minBucketPostsThreshold).toBe(2);
  });

  it("(G3) a re-run UPSERTS the cached row rather than accumulating a second one", async () => {
    const { accountId, clientId } = await makeAccount(A);
    await seedMeasuredPost(A, clientId, accountId, 10, 5);
    const first = await computeAccountBestTime(A, accountId);
    await applyBestTimeSuggestion(A, accountId, first);
    // second computation, same underlying data — still insufficient_evidence (only 1 measured post)
    const second = await computeAccountBestTime(A, accountId);
    await applyBestTimeSuggestion(A, accountId, second);

    const rows = await withTenants([A], (c) =>
      c.query(`SELECT count(*) AS n FROM social_best_time_suggestions WHERE account_id = $1`, [accountId]),
    MODULES);
    expect(Number(rows.rows[0].n)).toBe(1);
  });

  // ══ (B1) below minMeasuredPosts against REAL seeded rows ═══════════════════════════════════════

  it("(B1) below the configured minMeasuredPosts, the honest verdict is insufficient_evidence — even though real, non-zero engagement data exists", async () => {
    const { accountId, clientId } = await makeAccount(A);
    await seedMeasuredPost(A, clientId, accountId, 9, 100);
    await seedMeasuredPost(A, clientId, accountId, 9, 90);
    const result = await computeAccountBestTime(A, accountId);
    expect(result.status).toBe("insufficient_evidence");
    expect(result.totalMeasuredPosts).toBe(2);
    expect(result.bestHourUtc).toBeNull();
  });

  // ══ (B2) an all-NULL metrics snapshot is EXCLUDED from the sample, never counted as zero ═══════

  it("(B2) a published variant whose latest snapshot has every interaction field NULL is excluded from totalMeasuredPosts entirely", async () => {
    const { accountId, clientId } = await makeAccount(A);
    await seedMeasuredPost(A, clientId, accountId, 11, 20);
    await seedMeasuredPost(A, clientId, accountId, 11, 25);
    await seedMeasuredPost(A, clientId, accountId, 11, 30);
    // A fourth, published-but-not-yet-fetched post: an all-NULL social_post_metrics row.
    const engagementId = newId();
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, origin_site)
         VALUES ($1,$2,$3,'unmeasured','active','{}',10,'central')`,
        [engagementId, A, clientId]), MODULES);
    const postId = newId();
    const variantId = newId();
    const approvalId = newId();
    await withTenants([A], async (c) => {
      await c.query(`INSERT INTO automation_approvals
           (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at, origin, origin_site, execution_status)
         VALUES ($1,$2,'wf:delivery','social.publishPost','{}','high','approved',NULL,NULL,now(),'automation','main','executed')`,
        [approvalId, A]);
      await c.query(
        `INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site)
         VALUES ($1,$2,$3,'unmeasured post','publishing','central')`, [postId, A, engagementId]);
      await c.query(
        `INSERT INTO social_post_variants
           (id, tenant_id, post_id, account_id, body, media, settings, args_sha256, approval_id,
            provider_post_id, status, published_at, origin_site)
         VALUES ($1,$2,$3,$4,'body','[]','{}','deadbeef',$5,$6,'published','2026-06-01T11:00:00Z','central')`,
        [variantId, A, postId, accountId, approvalId, uniq("provider-post")],
      );
      // an ALL-NULL snapshot — "not yet fetched", never a zero.
      await c.query(
        `INSERT INTO social_post_metrics (tenant_id, variant_id, origin_site) VALUES ($1,$2,'central')`,
        [A, variantId],
      );
    }, MODULES);

    const result = await computeAccountBestTime(A, accountId);
    // 4 published variants exist, but only 3 are MEASURED — the unfetched one must not count.
    expect(result.totalMeasuredPosts).toBe(3);
  });

  // ══ (C1) unsupported — the driver never advertises post_metrics at all ════════════════════════

  it("(C1) an account whose resolved driver does not advertise post_metrics is 'unsupported', never 'insufficient_evidence' — a distinct, more permanent fact", async () => {
    resetPublishers();
    registerPublisher(createMockPublisher(state, { capabilities: DEFAULT_CAPS_MINUS_POST_METRICS }));
    const { accountId } = await makeAccount(A, "tiktok");
    const result = await computeAccountBestTime(A, accountId);
    expect(result.status).toBe("unsupported");
    expect(result.totalMeasuredPosts).toBe(0);
    expect(result.bestHourUtc).toBeNull();
  });

  // ══ (D1) not_yet_computed — a FOURTH fact distinct from all three statuses ═════════════════════

  it("(D1) getCachedBestTime returns null when the sweep has never run for this account — the caller's own job to surface as 'not_yet_computed', never coerced into insufficient_evidence", async () => {
    const { accountId } = await makeAccount(A);
    const cached = await getCachedBestTime(A, accountId);
    expect(cached).toBeNull();
  });
});
