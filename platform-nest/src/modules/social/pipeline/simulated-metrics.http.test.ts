// SCP-Sd — SCP-3c's `GET posts/:postId/metrics` over what the simulator wrote, against REAL Postgres (the three walls) and REAL Cerbos,
// through the real HTTP layer. Needs DATABASE_URL_TEST and Cerbos: NOT run on the dev laptop, runs on the Linux CI gate (a skip is not a pass).
//
// THE CLAIMS UNDER TEST (the sweep itself is simulated-metrics-job.db.test.ts; the maths is post-metrics.test.ts)
//   1. After the metrics sweep pulled a simulated account, the read answers `simulated: true`, `latest.source = 'simulated'`, the NEWEST snapshot
//      (day 7: its reach and counters are the generator's, its capture time go-live + 7 days), and an engagement rate that is the day-7
//      (likes + comments + saves + shares) / reach: a number, not null (the simulated rows carry reach, which a pulled row cannot).
//   2. `simulated` is true from the SOURCE alone: a post whose own `simulated` flag is false still answers true once its latest snapshot is simulated.
//   3. The account average is the mean of the same engagement's OTHER live posts' rates, and `boostCandidate` is exactly "rate >= 1.25 x that average":
//      the read agrees with the pure rule over the simulator's own numbers.
//   4. A post live for less than a day has no snapshot yet: `latest` is null, the rate null, the boost false (nothing is invented).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../../config";
import { newId } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../../testing/fixtures";
import { grantSocialRole, seedSocialOrgTree } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { socialModule } from "../index";
import { registerPublisher, resetPublishers } from "../publisher/registry";
import { createSimulatedPublisher } from "../publisher/simulated-driver";
import { simulatedPostMetrics, snapshotCapturedAt } from "../publisher/simulated-metrics";
import { pullTenantMetrics } from "../metrics-job";
import { isBoostCandidate, meanRate, round6 } from "./post-metrics";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const DAY = 86_400_000;

interface Answer {
  latest: null | { reach: number | null; likes: number | null; source: string; capturedAt: string };
  engagementRate: number | null; accountAverageRate: number | null; boostCandidate: boolean; simulated: boolean;
}
interface Made { postId: string; variantId: string; wentLive: Date; format: string }

describe.skipIf(!TEST_URL)("SCP-Sd · GET posts/:postId/metrics over simulated numbers", () => {
  const before = { flag: config.socialSimulationEnabled, key: config.social.publisher.defaultOrgApiKey };
  let app: NestFastifyApplication;
  let A: string;
  let staff: string;
  let engagementId: string;
  let cycleId: string;
  let accountId: string;
  const made: Made[] = [];

  const read = async (postId: string): Promise<Answer> => {
    const r = await app.inject({ method: "GET", url: `/api/${A}/modules/social/posts/${postId}/metrics`, headers: asUser(staff) });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as Answer;
  };

  /** One LIVE pipeline post with one published, simulated variant on the simulated Instagram account. */
  async function makePost(format: string, liveMsAgo: number, postSimulated: boolean): Promise<Made> {
    const postId = newId();
    const variantId = newId();
    const approvalId = newId();
    const wentLive = new Date(Date.now() - liveMsAgo);
    const db = adminPool();
    await db.query(
      `INSERT INTO automation_approvals
         (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at, origin, origin_site, execution_status)
       VALUES ($1,$2,'wf:delivery','social.publishPost','{}','high','approved',NULL,NULL,now(),'automation','main','executed')`, [approvalId, A]);
    await db.query(
      `INSERT INTO social_posts (id, tenant_id, engagement_id, cycle_id, title, pipeline_status, status_since, schedule_via, live_url, went_live_at,
                                 format, simulated, origin_site)
       VALUES ($1,$2,$3,$4,$5,'live',now(),'manual','https://simulated.invalid/instagram/x',$6,$7,$8,'central')`,
      [postId, A, engagementId, cycleId, `Mock ${format} post`, wentLive, format, postSimulated]);
    await db.query(
      `INSERT INTO social_post_variants
         (id, tenant_id, post_id, account_id, body, media, settings, args_sha256, approval_id, provider_post_id, status, published_url, published_at, simulated, origin_site)
       VALUES ($1,$2,$3,$4,'body','[]','{}','deadbeef',$5,$6,'published','https://simulated.invalid/instagram/x',$7,true,'central')`,
      [variantId, A, postId, accountId, approvalId, `simulated:instagram:${wentLive.getTime()}:${newId()}`, wentLive]);
    const m = { postId, variantId, wentLive, format };
    made.push(m);
    return m;
  }

  /** The rate the read must answer for a post whose newest snapshot is day 7: engaged over reach, from the generator. */
  const day7Rate = (m: Made): number => {
    const s = simulatedPostMetrics(m.variantId, "instagram", m.format, 7);
    return (s.likes + s.comments + s.saves + s.shares) / s.reach;
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.social.publisher.defaultOrgApiKey = "test-org-key";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SCP-Sd Agency", ["social"]);
    await seedSocialOrgTree(A);
    staff = await createUser("staff@scp-sd.test", "Mock staff");
    await addMembership(A, staff);
    await grantSocialRole(A, staff, "social_staff");

    const clientId = await createClient(A, "Mock Client Kopi Senja");
    engagementId = newId();
    cycleId = newId();
    const org = newId();
    accountId = newId();
    const db = adminPool();
    await db.query(`INSERT INTO social_engagements (id, tenant_id, client_id, name, status, owner_id) VALUES ($1,$2,$3,'Mock engagement','active',NULL)`, [engagementId, A, clientId]);
    await db.query(
      `INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by, origin_site)
       VALUES ($1,$2,$3,'2026-03-01','2026-02-26','2026-02-24','central')`, [cycleId, A, engagementId]);
    await db.query(
      `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
       VALUES ($1,$2,$3,'postiz',$4,'default','active','central')`, [org, A, clientId, `scp-sd-org-${Date.now()}`]);
    await db.query(
      `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, simulated, origin_site)
       VALUES ($1,$2,$3,$4,'instagram','@mock-kopi-senja','simulated:instagram','connected','{}',true,'central')`, [accountId, A, clientId, org]);

    // Five posts that are old enough for all three snapshots, in the four formats, one of them NOT flagged simulated on the post itself
    // (claim 2), and one that went live twelve hours ago (claim 4).
    await makePost("feed", 9 * DAY, true);
    await makePost("carousel", 8.5 * DAY, true);
    await makePost("reel", 8 * DAY, true);
    await makePost("story", 7.5 * DAY, true);
    await makePost("reel", 10 * DAY, false);
    await makePost("feed", 0.5 * DAY, true);

    config.socialSimulationEnabled = true;
    resetPublishers();
    registerPublisher(createSimulatedPublisher());
    const sweep = await pullTenantMetrics(A);
    expect(sweep.errors).toBe(0);
    expect(sweep.postMetricRows).toBe(5 * 3);

    app = await buildApp();
  }, 120_000);
  afterAll(async () => {
    config.socialSimulationEnabled = before.flag;
    config.social.publisher.defaultOrgApiKey = before.key;
    resetPublishers();
    await app?.close();
    await teardownTestDb();
  });

  it("(1) answers simulated: true, source 'simulated', the day-7 snapshot and an engagement rate", async () => {
    for (const m of made.slice(0, 5)) {
      const a = await read(m.postId);
      const want = simulatedPostMetrics(m.variantId, "instagram", m.format, 7);
      expect(a.simulated, m.format).toBe(true);
      expect(a.latest, m.format).toMatchObject({
        source: "simulated", reach: want.reach, likes: want.likes, capturedAt: snapshotCapturedAt(m.wentLive, 7).toISOString(),
      });
      expect(a.engagementRate, m.format).not.toBeNull();
      expect(a.engagementRate, m.format).toBe(round6(day7Rate(m)));
    }
  });

  it("(2) `simulated` follows the SOURCE: a post whose own flag is false still answers true", async () => {
    const flagOff = made[4];
    const row = await adminPool().query(`SELECT simulated FROM social_posts WHERE id = $1`, [flagOff.postId]);
    expect(row.rows[0].simulated).toBe(false);
    expect((await read(flagOff.postId)).simulated).toBe(true);
  });

  it("(3) the account average is the mean of the OTHER live posts' rates, and boostCandidate is exactly rate >= 1.25 x that average", async () => {
    const rated = made.slice(0, 5);
    for (const m of rated) {
      const others = rated.filter((o) => o !== m).map(day7Rate);
      const avg = meanRate(others);
      const a = await read(m.postId);
      expect(a.accountAverageRate, m.format).toBe(round6(avg));
      expect(a.boostCandidate, m.format).toBe(isBoostCandidate(day7Rate(m), avg, 1.25));
    }
  });

  it("(4) a post live twelve hours has no snapshot yet: latest null, rate null, not a boost candidate, nothing invented", async () => {
    const a = await read(made[5].postId);
    expect(a.latest).toBeNull();
    expect(a.engagementRate).toBeNull();
    expect(a.boostCandidate).toBe(false);
    // The post is flagged simulated itself, so the mark still shows (BFF §63.0): the read says so with no number behind it.
    expect(a.simulated).toBe(true);
  });
});
