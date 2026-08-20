// SMM-21 — the two Analytics-tab read endpoints (`GET metrics/daily`, `GET metrics/posts`), driven
// through the REAL HTTP surface (Cerbos + the module gate + module-scoped RLS all live), the same
// golden-case discipline `social.test.ts`'s own header names (addendum D-19 criterion 7).
//
// What each case proves:
//   (1) `GET metrics/daily` returns exactly the rows `metrics-job.ts#applyAccountDailyMetrics`
//       wrote, for the right engagement's client, filtered by date range, with an absent counter
//       coming back `null` over the wire — never `0` (agentic-native "no invented numbers").
//   (2) `GET metrics/posts` returns the LATEST snapshot per variant, never a blended aggregate
//       across two pulls of the same post.
//   (3) `engagementId` is required on both routes (400 `missing_field`) — accounts are
//       client-scoped, not engagement-scoped, so there is no other way to know which client's rows
//       to read.
//   (4) social_staff (read-only tier) can read both; a company with no grant sees nothing for it
//       (403, never an empty 200 masquerading as "no data").
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants, newId } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { registerModule, resetModules, getModule } from "../registry";
import { socialModule } from "./index";
import { applyAccountDailyMetrics, appendPostMetrics } from "./metrics-job";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const MODULES = { modules: ["social"] };

describe.skipIf(!TEST_URL)("SMM-21 · Analytics endpoints (metrics/daily, metrics/posts)", () => {
  let app: NestFastifyApplication;
  let B: string;
  let staff: string;
  let outsider: string;
  let clientId: string;
  let engagementId: string;
  let accountId: string;
  let variantId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(socialModule);
    expect(getModule("social")).toBe(socialModule);

    B = await createCompany("SMM-21 Metrics Co", ["social"]);
    staff = await createUser("smm21-staff@a.test");
    outsider = await createUser("smm21-outsider@a.test");
    await addMembership(B, staff);
    await addMembership(B, outsider); // a member, but with no social grant at all

    const staffRole = await createRole("social_staff");
    await grantRole(staff, staffRole, "company", B);

    clientId = newId();
    await withTenants([B], (c) =>
      c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'Metrics Brand','central')`, [clientId, B]));

    const orgId = newId();
    await withTenants([B], (c) =>
      c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1,$2,$3,'postiz','org-smm21','default','active','central')`,
        [orgId, B, clientId]), MODULES);

    accountId = newId();
    await withTenants([B], (c) =>
      c.query(
        `INSERT INTO social_accounts
           (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, origin_site)
         VALUES ($1,$2,$3,$4,'instagram','@metricsbrand','ig-int-1','connected','{}','central')`,
        [accountId, B, clientId, orgId]), MODULES);

    engagementId = newId();
    await withTenants([B], (c) =>
      c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, origin_site)
         VALUES ($1,$2,$3,'metrics engagement','active','{}',10,'central')`,
        [engagementId, B, clientId]), MODULES);

    const postId = newId();
    variantId = newId();
    const approvalId = newId();
    await withTenants([B], async (c) => {
      // 0105's `svar_dispatched_has_approval` CHECK requires a non-draft, non-native variant to
      // carry both an approval and its args hash.
      await c.query(`INSERT INTO automation_approvals
           (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at, origin, origin_site, execution_status)
         VALUES ($1,$2,'wf:delivery','social.publishPost','{}','high','approved',NULL,NULL,now(),'automation','main','executed')`,
        [approvalId, B]);
      await c.query(
        `INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site)
         VALUES ($1,$2,$3,'metrics post','published','central')`, [postId, B, engagementId]);
      await c.query(
        `INSERT INTO social_post_variants
           (id, tenant_id, post_id, account_id, body, media, settings, args_sha256, approval_id,
            provider_post_id, status, published_at, published_url, origin_site)
         VALUES ($1,$2,$3,$4,'body','[]','{}','deadbeef',$5,'ig-post-1','published',
                 now() - interval '1 day', 'https://instagram.example/p/1', 'central')`,
        [variantId, B, postId, accountId, approvalId],
      );
    }, MODULES);

    // Seed via the real write path (metrics-job.ts), not a raw INSERT — proves the two halves of
    // this ticket (the job's writes, the controller's reads) actually agree on the same rows.
    await applyAccountDailyMetrics(B, accountId, [
      { date: "2026-08-14", followers: 900, impressions: 4000 }, // reach/engagements/etc absent
      { date: "2026-08-15", followers: 950, impressions: 4200, reach: 2100, engagements: 180 },
    ]);
    await appendPostMetrics(B, [
      { variantId, metrics: { providerPostId: "ig-post-1", impressions: 500, likes: 10 } },
    ]);
    // A second, later pull — proves `metrics/posts` returns the LATEST snapshot only.
    await appendPostMetrics(B, [
      { variantId, metrics: { providerPostId: "ig-post-1", impressions: 900, likes: 55, comments: 4 } },
    ]);

    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ── (1) metrics/daily ────────────────────────────────────────────────────────────────────────

  it("returns the daily series for the engagement's client's accounts, absent counters as null", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${B}/modules/social/metrics/daily?engagementId=${engagementId}`,
      headers: asUser(staff),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.series).toHaveLength(2);
    const day14 = body.series.find((r: { date: string }) => r.date.startsWith("2026-08-14"));
    const day15 = body.series.find((r: { date: string }) => r.date.startsWith("2026-08-15"));
    expect(day14.followers).toBe(900);
    expect(day14.impressions).toBe(4000);
    // Never fabricated — the engine reported nothing about these on the 14th.
    expect(day14.reach).toBeNull();
    expect(day14.engagements).toBeNull();
    expect(day15.reach).toBe(2100);
    expect(day15.engagements).toBe(180);
    expect(day14.network).toBe("instagram");
    expect(day14.accountId).toBe(accountId);
  });

  it("filters by date range (`from`/`to`)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${B}/modules/social/metrics/daily?engagementId=${engagementId}&from=2026-08-15&to=2026-08-15`,
      headers: asUser(staff),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.series).toHaveLength(1);
    expect(body.series[0].date.startsWith("2026-08-15")).toBe(true);
  });

  it("400 missing_field when engagementId is omitted — there is no other way to scope the accounts", async () => {
    const res = await app.inject({
      method: "GET", url: `/api/${B}/modules/social/metrics/daily`, headers: asUser(staff),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("missing_field");
  });

  it("403s a member with no social grant at all — never a quietly-empty 200", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${B}/modules/social/metrics/daily?engagementId=${engagementId}`,
      headers: asUser(outsider),
    });
    expect(res.statusCode).toBe(403);
  });

  // ── (2) metrics/posts ────────────────────────────────────────────────────────────────────────

  it("returns the LATEST post-metrics snapshot per variant, not a blend of both pulls", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${B}/modules/social/metrics/posts?engagementId=${engagementId}`,
      headers: asUser(staff),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.posts).toHaveLength(1);
    const row = body.posts[0];
    expect(row.variantId).toBe(variantId);
    // The SECOND pull's values, not the first's and not a sum of the two.
    expect(row.impressions).toBe(900);
    expect(row.likes).toBe(55);
    expect(row.comments).toBe(4);
    expect(row.network).toBe("instagram");
    expect(row.publishedUrl).toBe("https://instagram.example/p/1");
  });

  it("400 missing_field on metrics/posts with no engagementId", async () => {
    const res = await app.inject({
      method: "GET", url: `/api/${B}/modules/social/metrics/posts`, headers: asUser(staff),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("missing_field");
  });
});
