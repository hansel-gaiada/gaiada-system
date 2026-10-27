// SCP-1b — the Composer routes and the legacy portal review surface step aside for pipeline posts.
// A `social_posts` row with `pipeline_status` NULL is a Composer post and behaves as before; a row with
// it NOT NULL is a pipeline post, whose variants and client reviews only the stage machine writes
// (docs/FRONTEND-BFF-CONTRACT.md §63.12). Against live Postgres + Cerbos (skips without DATABASE_URL_TEST).
//
// What is proved, and why each is a test rather than a comment:
//   (1) seven Composer routes answer 409 `pipeline_post` on a pipeline post and are NOT refused on a
//       Composer post (the guard must not leak onto the old path);
//   (2) authorization comes first: a caller without the permission reads 403, never 409 (a 409 would tell
//       an unauthorised caller that the post exists and is a pipeline post);
//   (3) GET posts and GET posts/:postId carry `pipelineStatus` and `phase` (null for Composer);
//   (4) the portal list omits a pipeline post's review, and decide answers 409 `decide_per_post`.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants, newId } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../testing/fixtures";
import { resetModules, registerModule } from "../registry";
import { socialModule } from "./index";
import { variantArgsSha256 } from "./canonical-args";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const MODULES = { modules: ["social"] };

describe.skipIf(!TEST_URL)("SCP-1b · legacy routes step aside for pipeline posts", () => {
  let app: NestFastifyApplication;
  let co: string;
  let client: string;
  let engagementId: string;
  let cycleId: string;
  let accountId: string;
  let manager: string;      // social_manager at co: holds every permission these routes ask for
  let outsider: string;     // a member of co with no social grant at all
  let portalUser: string;   // a client contact on `client`

  interface Seeded { postId: string; variantId: string }

  /** One post (Composer when `pipeline` is false, a `planned` pipeline post when true) with one draft
   *  variant. Fresh per call, so a destructive route never starves the next case. */
  async function seed(pipeline: boolean): Promise<Seeded> {
    const postId = newId();
    const variantId = newId();
    const argsSha256 = variantArgsSha256({
      tenantId: co, id: variantId, accountId, body: "mock copy", firstComment: null, media: [], settings: {}, scheduledAt: null,
    });
    await withTenants(
      [co],
      async (c) => {
        if (pipeline) {
          await c.query(
            `INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site, cycle_id, pipeline_status, status_since)
             VALUES ($1,$2,$3,'SCP-1b pipeline post','draft','central',$4,'planned', now())`,
            [postId, co, engagementId, cycleId],
          );
        } else {
          await c.query(
            `INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site)
             VALUES ($1,$2,$3,'SCP-1b composer post','draft','central')`,
            [postId, co, engagementId],
          );
        }
        await c.query(
          `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, args_sha256, status, origin_site)
           VALUES ($1,$2,$3,$4,'mock copy',$5,'draft','central')`,
          [variantId, co, postId, accountId, argsSha256],
        );
      },
      MODULES,
    );
    return { postId, variantId };
  }

  async function requestReview(variantId: string): Promise<string> {
    const id = newId();
    await adminPool().query(
      `INSERT INTO social_post_client_reviews (id, tenant_id, variant_id, client_id, status, requested_at, updated_at, origin_site)
       VALUES ($1,$2,$3,$4,'pending', now(), now(), 'central')`,
      [id, co, variantId, client],
    );
    return id;
  }

  const base = () => `/api/${co}/modules/social`;
  /** The seven routes under test, each as an inject() call for a seeded post/variant. */
  const ROUTES: Array<{ name: string; call: (s: Seeded, as: string) => ReturnType<NestFastifyApplication["inject"]> }> = [
    { name: "PATCH posts/:postId", call: (s, as) => app.inject({ method: "PATCH", url: `${base()}/posts/${s.postId}`, headers: asUser(as), payload: { title: "renamed" } }) },
    { name: "DELETE posts/:postId", call: (s, as) => app.inject({ method: "DELETE", url: `${base()}/posts/${s.postId}`, headers: asUser(as) }) },
    { name: "POST posts/:postId/variants", call: (s, as) => app.inject({ method: "POST", url: `${base()}/posts/${s.postId}/variants`, headers: asUser(as), payload: { accountId, body: "another" } }) },
    { name: "DELETE variants/:variantId", call: (s, as) => app.inject({ method: "DELETE", url: `${base()}/variants/${s.variantId}`, headers: asUser(as) }) },
    { name: "POST variants/:variantId/client-review", call: (s, as) => app.inject({ method: "POST", url: `${base()}/variants/${s.variantId}/client-review`, headers: asUser(as) }) },
    { name: "POST variants/:variantId/client-review/withdraw", call: (s, as) => app.inject({ method: "POST", url: `${base()}/variants/${s.variantId}/client-review/withdraw`, headers: asUser(as) }) },
    { name: "POST variants/:variantId/approve", call: (s, as) => app.inject({ method: "POST", url: `${base()}/variants/${s.variantId}/approve`, headers: asUser(as) }) },
  ];

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(socialModule);

    co = await createCompany("SCP-1b Legacy Co", ["social"]);
    client = await createClient(co, "SCP-1b Brand");

    manager = await createUser("scp1b-manager@a.test");
    outsider = await createUser("scp1b-outsider@a.test");
    await addMembership(co, manager);
    await addMembership(co, outsider);
    await grantRole(manager, await createRole("social_manager"), "company", co);

    engagementId = newId();
    await withTenants(
      [co],
      async (c) => {
        await c.query(
          `INSERT INTO social_engagements (id, tenant_id, client_id, name, owner_id, status, tool_scope, usage_budget_usd, origin_site)
           VALUES ($1,$2,$3,'SCP-1b engagement',$4,'active',$5,10,'central')`,
          [engagementId, co, client, manager, JSON.stringify({ networks: { instagram: true } })],
        );
        cycleId = newId();
        await c.query(
          `INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by, origin_site)
           VALUES ($1,$2,$3,'2026-11-01','2026-10-30','2026-10-28','central')`,
          [cycleId, co, engagementId],
        );
        const orgId = newId();
        await c.query(
          `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
           VALUES ($1,$2,$3,'postiz','scp1b-org','default','active','central')`,
          [orgId, co, client],
        );
        accountId = newId();
        await c.query(
          `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, origin_site)
           VALUES ($1,$2,$3,$4,'instagram','@scp1b-brand','connected','{}','central')`,
          [accountId, co, client, orgId],
        );
      },
      MODULES,
    );

    // A portal contact on `client`, shaped exactly as social-client-review-portal.controller.test.ts does.
    portalUser = await createUser("scp1b-portal@client.test");
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, origin_site)
         VALUES ($1, $2, $3, $4, 'viewer', 'active', 'central')`,
        [newId(), co, client, portalUser],
      ));
    await grantRole(portalUser, await createRole("client"), "company", co);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ── (1) the seven routes ───────────────────────────────────────────────────────────────────────
  describe.each(ROUTES.map((r) => [r.name, r] as const))("%s", (_name, route) => {
    it("answers 409 pipeline_post on a pipeline post", async () => {
      const res = await route.call(await seed(true), manager);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "pipeline_post" });
    });

    it("is not refused as a pipeline post on a Composer post", async () => {
      const res = await route.call(await seed(false), manager);
      expect(res.statusCode).not.toBe(409);
      expect(res.statusCode).not.toBe(403);
    });

    it("answers 403 before 409 to a caller without the permission", async () => {
      const res = await route.call(await seed(true), outsider);
      expect(res.statusCode).toBe(403);
    });
  });

  it("leaves the pipeline post untouched when PATCH/DELETE are refused", async () => {
    const s = await seed(true);
    await app.inject({ method: "PATCH", url: `${base()}/posts/${s.postId}`, headers: asUser(manager), payload: { title: "renamed" } });
    await app.inject({ method: "DELETE", url: `${base()}/posts/${s.postId}`, headers: asUser(manager) });
    const { rows } = await withTenants([co], (c) =>
      c.query(`SELECT title, deleted_at FROM social_posts WHERE id = $1`, [s.postId]), MODULES);
    expect(rows[0]).toMatchObject({ title: "SCP-1b pipeline post", deleted_at: null });
  });

  it("a missing post still answers its own 404, not 409", async () => {
    const res = await app.inject({ method: "PATCH", url: `${base()}/posts/${newId()}`, headers: asUser(manager), payload: { title: "x" } });
    expect(res.statusCode).toBe(404);
  });

  // ── (3) additive fields on the reads ───────────────────────────────────────────────────────────
  it("GET posts and GET posts/:postId carry pipelineStatus and phase", async () => {
    const pipe = await seed(true);
    const comp = await seed(false);

    const list = await app.inject({ method: "GET", url: `${base()}/posts?engagementId=${engagementId}`, headers: asUser(manager) });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as Array<{ id: string; pipelineStatus: string | null; phase: string | null }>;
    expect(rows.find((r) => r.id === pipe.postId)).toMatchObject({ pipelineStatus: "planned", phase: "brief" });
    expect(rows.find((r) => r.id === comp.postId)).toMatchObject({ pipelineStatus: null, phase: null });

    const onePipe = await app.inject({ method: "GET", url: `${base()}/posts/${pipe.postId}`, headers: asUser(manager) });
    expect(onePipe.statusCode).toBe(200);
    expect(onePipe.json()).toMatchObject({ pipelineStatus: "planned", phase: "brief" });
    const oneComp = await app.inject({ method: "GET", url: `${base()}/posts/${comp.postId}`, headers: asUser(manager) });
    expect(oneComp.json()).toMatchObject({ pipelineStatus: null, phase: null });
  });

  // ── (4) the portal ─────────────────────────────────────────────────────────────────────────────
  it("the portal list omits a pipeline post's review, and decide answers 409 decide_per_post", async () => {
    const pipe = await seed(true);
    const comp = await seed(false);
    const pipeReview = await requestReview(pipe.variantId);
    const compReview = await requestReview(comp.variantId);

    const list = await app.inject({ method: "GET", url: `/api/${co}/portal/social-reviews`, headers: asUser(portalUser) });
    expect(list.statusCode).toBe(200);
    const ids = (list.json() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(compReview);
    expect(ids).not.toContain(pipeReview);

    const decide = await app.inject({
      method: "POST", url: `/api/${co}/portal/social-reviews/${pipeReview}/decide`,
      headers: asUser(portalUser), payload: { decision: "approved" },
    });
    expect(decide.statusCode).toBe(409);
    expect(decide.json()).toMatchObject({ error: "decide_per_post" });
    const row = await adminPool().query(`SELECT status FROM social_post_client_reviews WHERE id = $1`, [pipeReview]);
    expect(row.rows[0].status).toBe("pending");

    // The Composer review still decides as before.
    const ok = await app.inject({
      method: "POST", url: `/api/${co}/portal/social-reviews/${compReview}/decide`,
      headers: asUser(portalUser), payload: { decision: "approved" },
    });
    expect(ok.statusCode).toBe(200);
  });
});
