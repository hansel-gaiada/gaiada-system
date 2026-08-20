// SMM-31 — the client portal's decide surface for social posts, against live Postgres + RLS +
// Cerbos. Modelled on `webdev-change-requests-portal.controller.test.ts`'s own verification
// standard: a 200 is not a pass, every claim is asserted by a real row.
//
// ── ⚠ THE MODULE-GUC REGRESSION, PROVEN BY CONSTRUCTION (same idiom `dispatch.test.ts` uses) ───────
// This controller declares `declareSocialModuleScope` explicitly (portal controllers carry no
// `{modules:['social']}` option — see the controller's own header). Every test below that reaches a
// 200 with a REAL `reviewed_args_sha256` stamped IS the regression test: remove that one call from
// `social-client-review-portal.controller.ts#decide` and the variant/post join returns ZERO ROWS,
// `owner.rows[0]` is undefined, and every one of these tests would see a 404 instead.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withTenants } from "../db";
import { resetModules, registerModule } from "../modules/registry";
import { socialModule } from "../modules/social/index";
import { variantArgsSha256 } from "../modules/social/canonical-args";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createClient, createRole, grantRole } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const MODULES = { modules: ["social"] };

let seq = 0;
const uniq = (label: string): string => `smm31-portal-${label}-${++seq}`;

async function addContact(tenantId: string, clientId: string, userId: string, capability = "viewer"): Promise<void> {
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, origin_site)
       VALUES ($1, $2, $3, $4, $5, 'active', 'central')`,
      [newId(), tenantId, clientId, userId, capability],
    ),
  );
}

describe.skipIf(!TEST_URL)("SMM-31 · portal client-review decide (D-16)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let clientA: string;
  let clientB: string;
  let engagementId: string;
  let accountId: string;
  let ownerUserId: string;
  let portalUserA: string; // viewer-capability contact on clientA — approve_post must not require signer
  let portalUserB: string; // clientB's own contact, for cross-client isolation

  async function makeVariant(): Promise<{ variantId: string; argsSha256: string }> {
    const postId = newId();
    const variantId = newId();
    const argsSha256 = variantArgsSha256({
      tenantId: co, id: variantId, accountId, body: "draft copy", firstComment: null, media: [], settings: {}, scheduledAt: null,
    });
    await withTenants(
      [co],
      async (c) => {
        await c.query(
          `INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site)
           VALUES ($1,$2,$3,'SMM-31 portal post','draft','central')`,
          [postId, co, engagementId],
        );
        await c.query(
          `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, args_sha256, status, origin_site)
           VALUES ($1,$2,$3,$4,'draft copy',$5,'draft','central')`,
          [variantId, co, postId, accountId, argsSha256],
        );
      },
      MODULES,
    );
    return { variantId, argsSha256 };
  }

  async function requestReview(variantId: string, clientId: string): Promise<string> {
    const id = newId();
    await adminPool().query(
      `INSERT INTO social_post_client_reviews (id, tenant_id, variant_id, client_id, status, requested_at, updated_at, origin_site)
       VALUES ($1,$2,$3,$4,'pending', now(), now(), 'central')`,
      [id, co, variantId, clientId],
    );
    return id;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(socialModule);

    co = await createCompany("SMM-31 Portal Co", ["social"]);
    clientA = await createClient(co, "Portal Brand A");
    clientB = await createClient(co, "Portal Brand B");

    ownerUserId = await createUser(uniq("owner@a.test"));
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO company_memberships (id, tenant_id, user_id, status, origin_site, kind)
         VALUES ($1, $2, $3, 'active', 'central', 'employee')`,
        [newId(), co, ownerUserId],
      ));

    engagementId = newId();
    await withTenants(
      [co],
      (c) => c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, owner_id, status, tool_scope, usage_budget_usd, origin_site)
         VALUES ($1,$2,$3,'SMM-31 portal engagement',$4,'active',$5,10,'central')`,
        [engagementId, co, clientA, ownerUserId, JSON.stringify({ networks: { instagram: true }, posting: { requiresClientOk: true } })],
      ),
      MODULES,
    );

    const orgId = newId();
    await withTenants(
      [co],
      (c) => c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1,$2,$3,'postiz',$4,'default','active','central')`,
        [orgId, co, clientA, uniq("org")],
      ),
      MODULES,
    );
    accountId = newId();
    await withTenants(
      [co],
      (c) => c.query(
        `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, origin_site)
         VALUES ($1,$2,$3,$4,'instagram',$5,'connected','{}','central')`,
        [accountId, co, clientA, orgId, uniq("@brand-a")],
      ),
      MODULES,
    );

    portalUserA = await createUser(uniq("portal-a@client.test"));
    await addContact(co, clientA, portalUserA, "viewer");
    const clientRole = await createRole("client");
    await grantRole(portalUserA, clientRole, "company", co);

    portalUserB = await createUser(uniq("portal-b@client.test"));
    await addContact(co, clientB, portalUserB, "viewer");
    await grantRole(portalUserB, clientRole, "company", co);

    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("a viewer-capability contact approves a post — 'approve_post' is NOT signer-gated", async () => {
    const { variantId, argsSha256 } = await makeVariant();
    const reviewId = await requestReview(variantId, clientA);

    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/portal/social-reviews/${reviewId}/decide`,
      headers: asUser(portalUserA),
      payload: { decision: "approved", comment: "looks great" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: reviewId, status: "approved" });

    // (R1) the regression case: reviewed_args_sha256 is REAL and matches the live variant hash —
    // only reachable if the module scope was declared for the variant/post join.
    const row = await adminPool().query(
      `SELECT status, comment, reviewed_args_sha256, decided_by FROM social_post_client_reviews WHERE id = $1`,
      [reviewId],
    );
    expect(row.rows[0]).toMatchObject({
      status: "approved", comment: "looks great", reviewed_args_sha256: argsSha256, decided_by: portalUserA,
    });

    // The outbox row commits in the SAME transaction as the write it announces.
    const outbox = await adminPool().query(
      `SELECT event_type, payload FROM outbox_events
        WHERE entity_type = 'social_post_variant' AND entity_id = $1 AND event_type = 'social.client_review.decided'`,
      [variantId],
    );
    expect(outbox.rows).toHaveLength(1);
    expect((outbox.rows[0].payload as { engagementId: string }).engagementId).toBe(engagementId);
  });

  it("a viewer requests changes with a comment", async () => {
    const { variantId } = await makeVariant();
    const reviewId = await requestReview(variantId, clientA);

    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/portal/social-reviews/${reviewId}/decide`,
      headers: asUser(portalUserA),
      payload: { decision: "changes_requested", comment: "please fix the caption" },
    });
    expect(r.statusCode).toBe(200);
    const row = await adminPool().query(`SELECT status, comment FROM social_post_client_reviews WHERE id = $1`, [reviewId]);
    expect(row.rows[0]).toMatchObject({ status: "changes_requested", comment: "please fix the caption" });
  });

  it("IDEMPOTENT: deciding the SAME decision twice is a 200 no-op, not a double-apply", async () => {
    const { variantId } = await makeVariant();
    const reviewId = await requestReview(variantId, clientA);

    const first = await app.inject({
      method: "POST", url: `/api/${co}/portal/social-reviews/${reviewId}/decide`,
      headers: asUser(portalUserA), payload: { decision: "approved" },
    });
    expect(first.statusCode).toBe(200);
    const decidedAtFirst = (await adminPool().query(`SELECT decided_at FROM social_post_client_reviews WHERE id = $1`, [reviewId])).rows[0].decided_at;

    const second = await app.inject({
      method: "POST", url: `/api/${co}/portal/social-reviews/${reviewId}/decide`,
      headers: asUser(portalUserA), payload: { decision: "approved" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ id: reviewId, status: "approved", alreadyDecided: true });

    // No double-apply: decided_at did not move, and only ONE outbox event exists for this variant.
    const decidedAtSecond = (await adminPool().query(`SELECT decided_at FROM social_post_client_reviews WHERE id = $1`, [reviewId])).rows[0].decided_at;
    expect(new Date(decidedAtSecond).getTime()).toBe(new Date(decidedAtFirst).getTime());
    const outbox = await adminPool().query(
      `SELECT id FROM outbox_events WHERE entity_type = 'social_post_variant' AND entity_id = $1 AND event_type = 'social.client_review.decided'`,
      [variantId],
    );
    expect(outbox.rows).toHaveLength(1);
  });

  it("a DIFFERENT decision after the review is already resolved is a genuine 409, never a silent flip", async () => {
    const { variantId } = await makeVariant();
    const reviewId = await requestReview(variantId, clientA);

    await app.inject({
      method: "POST", url: `/api/${co}/portal/social-reviews/${reviewId}/decide`,
      headers: asUser(portalUserA), payload: { decision: "approved" },
    });
    const r = await app.inject({
      method: "POST", url: `/api/${co}/portal/social-reviews/${reviewId}/decide`,
      headers: asUser(portalUserA), payload: { decision: "changes_requested" },
    });
    expect(r.statusCode).toBe(409);

    const row = await adminPool().query(`SELECT status FROM social_post_client_reviews WHERE id = $1`, [reviewId]);
    expect(row.rows[0].status).toBe("approved"); // untouched
  });

  it("client B cannot decide client A's review — 404, not 403 (existence-oracle-safe)", async () => {
    const { variantId } = await makeVariant();
    const reviewId = await requestReview(variantId, clientA);

    const r = await app.inject({
      method: "POST", url: `/api/${co}/portal/social-reviews/${reviewId}/decide`,
      headers: asUser(portalUserB), payload: { decision: "approved" },
    });
    expect(r.statusCode).toBe(404);
    const row = await adminPool().query(`SELECT status FROM social_post_client_reviews WHERE id = $1`, [reviewId]);
    expect(row.rows[0].status).toBe("pending"); // untouched
  });

  it("a bogus decision string is refused (4xx) before any row is touched", async () => {
    const { variantId } = await makeVariant();
    const reviewId = await requestReview(variantId, clientA);
    const r = await app.inject({
      method: "POST", url: `/api/${co}/portal/social-reviews/${reviewId}/decide`,
      headers: asUser(portalUserA), payload: { decision: "rejected" },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
    const row = await adminPool().query(`SELECT status FROM social_post_client_reviews WHERE id = $1`, [reviewId]);
    expect(row.rows[0].status).toBe("pending");
  });

  it("list returns only the caller's own client's reviews", async () => {
    const { variantId: vA } = await makeVariant();
    await requestReview(vA, clientA);

    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/social-reviews`, headers: asUser(portalUserA) });
    expect(r.statusCode).toBe(200);
    const rows = r.json() as Array<{ variantId: string }>;
    expect(rows.some((row) => row.variantId === vA)).toBe(true);

    // clientB's own list must not show clientA's pending review.
    const rB = await app.inject({ method: "GET", url: `/api/${co}/portal/social-reviews`, headers: asUser(portalUserB) });
    const idsB = (rB.json() as Array<{ variantId: string }>).map((row) => row.variantId);
    expect(idsB).not.toContain(vA);
  });

  it("deciding a nonexistent review id is a 404", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/portal/social-reviews/${newId()}/decide`,
      headers: asUser(portalUserA), payload: { decision: "approved" },
    });
    expect(r.statusCode).toBe(404);
  });
});
