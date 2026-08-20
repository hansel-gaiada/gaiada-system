// SMM-31 — the client-review stage: `evaluateClientReviewPrecondition`, the composed
// `evaluatePublishPreconditionWithClientReview` wrapper, and the STAFF-side state machine
// (request/read/withdraw) against the real endpoint. The CLIENT decide path is covered by
// `src/core/social-client-review-portal.controller.test.ts` (a different trust boundary, a
// different controller, its own regression case for the SAME module-GUC trap).
//
// ── ⚠ THE MODULE-GUC REGRESSION ─────────────────────────────────────────────────────────────────────
// `evaluateClientReviewPrecondition` declares its OWN module scope (mirroring
// `evaluatePublishPrecondition`'s own doctrine). "opens a module-less transaction, then calls the
// precondition, then asserts a REAL refusal (not a vacuous pass)" is the regression test: delete the
// `declareSocialModuleScope` call from inside the function and the join returns ZERO ROWS, the
// function falls through to its `if (!row) return {ok:true}` branch, and the assertion below
// (expecting a REFUSAL) fails. See "(R1)" below.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { socialModule } from "./index";
import { variantArgsSha256, variantPublishArgs } from "./canonical-args";
import { SOCIAL_PUBLISH_TOOL } from "./publish-precondition";
import {
  CLIENT_REVIEW_REFUSAL,
  evaluateClientReviewPrecondition,
  evaluatePublishPreconditionWithClientReview,
} from "./client-review";

const MODULES: { modules: string[] } = { modules: ["social"] };
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

let seq = 0;
const uniq = (label: string): string => `smm31-${label}-${++seq}`;

describe.skipIf(!TEST_URL)("SMM-31 · client-review stage", () => {
  let co: string;
  let clientId: string;
  let accountId: string;
  let manager: string;
  let staff: string;

  async function makeEngagement(requiresClientOk: boolean): Promise<string> {
    const id = newId();
    await withTenants(
      [co],
      (c) => c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, origin_site)
         VALUES ($1,$2,$3,'SMM-31 engagement','active',$4,10,'central')`,
        [id, co, clientId, JSON.stringify({ networks: { instagram: true }, posting: { requiresClientOk } })],
      ),
      MODULES,
    );
    return id;
  }

  async function makeVariant(engagementId: string): Promise<string> {
    const postId = newId();
    const variantId = newId();
    const hash = variantArgsSha256({
      tenantId: co, id: variantId, accountId, body: "hello", firstComment: null, media: [], settings: {}, scheduledAt: null,
    });
    await withTenants(
      [co],
      async (c) => {
        await c.query(
          `INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site)
           VALUES ($1,$2,$3,'SMM-31 post','draft','central')`,
          [postId, co, engagementId],
        );
        await c.query(
          `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, args_sha256, status, origin_site)
           VALUES ($1,$2,$3,$4,'hello',$5,'draft','central')`,
          [variantId, co, postId, accountId, hash],
        );
      },
      MODULES,
    );
    return variantId;
  }

  async function editVariantBody(variantId: string, newBody: string): Promise<string> {
    const newHash = variantArgsSha256({
      tenantId: co, id: variantId, accountId, body: newBody, firstComment: null, media: [], settings: {}, scheduledAt: null,
    });
    await withTenants(
      [co],
      (c) => c.query(`UPDATE social_post_variants SET body = $2, args_sha256 = $3 WHERE id = $1`, [variantId, newBody, newHash]),
      MODULES,
    );
    return newHash;
  }

  async function reviewRow(variantId: string) {
    const { rows } = await adminPool().query(
      `SELECT id, status, comment, reviewed_args_sha256, decided_by, decided_at FROM social_post_client_reviews WHERE variant_id = $1`,
      [variantId],
    );
    return rows[0] as { id: string; status: string; comment: string | null; reviewed_args_sha256: string | null } | undefined;
  }

  let app: NestFastifyApplication;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(socialModule);

    co = await createCompany("SMM-31 Co", ["social"]);
    clientId = await createClient(co, "SMM-31 Brand");

    manager = await createUser("smm31-manager@a.test");
    staff = await createUser("smm31-staff@a.test");
    await addMembership(co, manager);
    await addMembership(co, staff);
    const managerRole = await createRole("social_manager");
    const staffRole = await createRole("social_staff");
    await grantRole(manager, managerRole, "company", co);
    await grantRole(staff, staffRole, "company", co);

    const orgId = newId();
    await withTenants(
      [co],
      (c) => c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1,$2,$3,'postiz',$4,'default','active','central')`,
        [orgId, co, clientId, uniq("org")],
      ),
      MODULES,
    );
    accountId = newId();
    await withTenants(
      [co],
      (c) => c.query(
        `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, origin_site)
         VALUES ($1,$2,$3,$4,'instagram',$5,'connected','{}','central')`,
        [accountId, co, clientId, orgId, uniq("@brand")],
      ),
      MODULES,
    );

    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // The precondition function, unit-level
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("requiresClientOk=false never consults the review table — ok even with no row", async () => {
    const engagementId = await makeEngagement(false);
    const variantId = await makeVariant(engagementId);
    const verdict = await withTenants([co], (c) => evaluateClientReviewPrecondition(c, variantId), MODULES);
    expect(verdict).toEqual({ ok: true });
  });

  it("requiresClientOk=true, no review ever requested -> client_review_not_requested", async () => {
    const engagementId = await makeEngagement(true);
    const variantId = await makeVariant(engagementId);
    const verdict = await withTenants([co], (c) => evaluateClientReviewPrecondition(c, variantId), MODULES);
    expect(verdict).toEqual({ ok: false, reason: CLIENT_REVIEW_REFUSAL.clientReviewNotRequested });
  });

  it("(R1) REGRESSION — self-declares module scope: the SAME refusal is returned even with NO {modules} option on the caller's transaction", async () => {
    const engagementId = await makeEngagement(true);
    const variantId = await makeVariant(engagementId);
    // No `{modules:['social']}` here — mirrors the D14 executor's own module-less transaction. If
    // `declareSocialModuleScope` were ever removed from inside `evaluateClientReviewPrecondition`,
    // this join would silently return zero rows and the function would answer `{ok:true}` instead —
    // a wrongly PERMISSIVE result that would fail this assertion.
    const verdict = await withTenants([co], (c) => evaluateClientReviewPrecondition(c, variantId));
    expect(verdict).toEqual({ ok: false, reason: CLIENT_REVIEW_REFUSAL.clientReviewNotRequested });
  });

  it("pending -> client_review_pending; changes_requested -> client_review_changes_requested; withdrawn -> client_review_withdrawn", async () => {
    const engagementId = await makeEngagement(true);

    const v1 = await makeVariant(engagementId);
    await adminPool().query(
      `INSERT INTO social_post_client_reviews (id, tenant_id, variant_id, client_id, status, origin_site)
       VALUES ($1,$2,$3,$4,'pending','central')`,
      [newId(), co, v1, clientId],
    );
    expect(await withTenants([co], (c) => evaluateClientReviewPrecondition(c, v1), MODULES))
      .toEqual({ ok: false, reason: CLIENT_REVIEW_REFUSAL.clientReviewPending });

    const v2 = await makeVariant(engagementId);
    await adminPool().query(
      `INSERT INTO social_post_client_reviews (id, tenant_id, variant_id, client_id, status, decided_by, decided_at, origin_site)
       VALUES ($1,$2,$3,$4,'changes_requested',$5,now(),'central')`,
      [newId(), co, v2, clientId, manager],
    );
    expect(await withTenants([co], (c) => evaluateClientReviewPrecondition(c, v2), MODULES))
      .toEqual({ ok: false, reason: CLIENT_REVIEW_REFUSAL.clientReviewChangesRequested });

    const v3 = await makeVariant(engagementId);
    await adminPool().query(
      `INSERT INTO social_post_client_reviews (id, tenant_id, variant_id, client_id, status, decided_by, decided_at, origin_site)
       VALUES ($1,$2,$3,$4,'withdrawn',$5,now(),'central')`,
      [newId(), co, v3, clientId, manager],
    );
    expect(await withTenants([co], (c) => evaluateClientReviewPrecondition(c, v3), MODULES))
      .toEqual({ ok: false, reason: CLIENT_REVIEW_REFUSAL.clientReviewWithdrawn });
  });

  it("approved + matching hash -> ok; approved + STALE hash (edited since) -> client_review_stale", async () => {
    const engagementId = await makeEngagement(true);
    const variantId = await makeVariant(engagementId);
    const { rows } = await adminPool().query<{ args_sha256: string }>(
      `SELECT args_sha256 FROM social_post_variants WHERE id = $1`, [variantId],
    );
    await adminPool().query(
      `INSERT INTO social_post_client_reviews (id, tenant_id, variant_id, client_id, status, reviewed_args_sha256, decided_by, decided_at, origin_site)
       VALUES ($1,$2,$3,$4,'approved',$5,$6,now(),'central')`,
      [newId(), co, variantId, clientId, rows[0].args_sha256, manager],
    );
    expect(await withTenants([co], (c) => evaluateClientReviewPrecondition(c, variantId), MODULES)).toEqual({ ok: true });

    // An edit after the client's sign-off moves the hash — D-15's rule, re-derived for the client
    // side of the same content.
    await editVariantBody(variantId, "an edit after the client approved");
    expect(await withTenants([co], (c) => evaluateClientReviewPrecondition(c, variantId), MODULES))
      .toEqual({ ok: false, reason: CLIENT_REVIEW_REFUSAL.clientReviewStale });
  });

  it("a missing variant is reported ok:true — this function must never invent variant_not_found", async () => {
    const verdict = await withTenants([co], (c) => evaluateClientReviewPrecondition(c, newId()), MODULES);
    expect(verdict).toEqual({ ok: true });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // The composed wrapper — runs FIRST, before the six-stage chain, first-refusal-wins
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("the composed wrapper refuses stage:'client_review' BEFORE the six-stage chain ever runs", async () => {
    const engagementId = await makeEngagement(true);
    const variantId = await makeVariant(engagementId);
    const args = variantPublishArgs({
      tenantId: co, id: variantId, accountId, body: "hello", firstComment: null, media: [], settings: {}, scheduledAt: null,
    });
    const verdict = await withTenants(
      [co],
      (c) => evaluatePublishPreconditionWithClientReview(c, args as unknown as Record<string, unknown>, SOCIAL_PUBLISH_TOOL),
      MODULES,
    );
    expect(verdict).toEqual({ ok: false, stage: "client_review", reason: CLIENT_REVIEW_REFUSAL.clientReviewNotRequested });
  });

  it("the composed wrapper falls through to the six-stage chain once client review is satisfied", async () => {
    const engagementId = await makeEngagement(true);
    const variantId = await makeVariant(engagementId);
    const { rows } = await adminPool().query<{ args_sha256: string }>(
      `SELECT args_sha256 FROM social_post_variants WHERE id = $1`, [variantId],
    );
    await adminPool().query(
      `INSERT INTO social_post_client_reviews (id, tenant_id, variant_id, client_id, status, reviewed_args_sha256, decided_by, decided_at, origin_site)
       VALUES ($1,$2,$3,$4,'approved',$5,$6,now(),'central')`,
      [newId(), co, variantId, clientId, rows[0].args_sha256, manager],
    );
    const args = variantPublishArgs({
      tenantId: co, id: variantId, accountId, body: "hello", firstComment: null, media: [], settings: {}, scheduledAt: null,
    });
    const verdict = await withTenants(
      [co],
      (c) => evaluatePublishPreconditionWithClientReview(c, args as unknown as Record<string, unknown>, SOCIAL_PUBLISH_TOOL),
      MODULES,
    );
    // Client review is satisfied; the variant is still 'draft' (never approved for STAFF publish),
    // so the six-stage chain itself now refuses — proving control passed through, not that
    // everything downstream also happens to pass.
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.stage).not.toBe("client_review");
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // THE DRY-RUN ENDPOINT — the practical "submission precondition" surface (no separate submit
  // endpoint exists in this codebase; see client-review.ts's header for why this is the moment
  // staff actually observe the gate before filing a WS4 request).
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("GET .../publish-preconditions reports client_review_not_requested when requiresClientOk is set and nobody asked", async () => {
    const engagementId = await makeEngagement(true);
    const variantId = await makeVariant(engagementId);
    const r = await app.inject({
      method: "GET", url: `/api/${co}/modules/social/variants/${variantId}/publish-preconditions`, headers: asUser(staff),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { ok: boolean; stage?: string; reason?: string };
    expect(body.ok).toBe(false);
    expect(body.stage).toBe("client_review");
    expect(body.reason).toBe(CLIENT_REVIEW_REFUSAL.clientReviewNotRequested);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // STAFF endpoints — request / read / withdraw
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("staff requests a client review: 201, a real pending row, and an outbox event in the SAME transaction", async () => {
    const engagementId = await makeEngagement(true);
    const variantId = await makeVariant(engagementId);
    const r = await app.inject({
      method: "POST", url: `/api/${co}/modules/social/variants/${variantId}/client-review`, headers: asUser(staff),
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { id: string; status: string; alreadyPending: boolean };
    expect(body.status).toBe("pending");
    expect(body.alreadyPending).toBe(false);

    const row = await reviewRow(variantId);
    expect(row).toMatchObject({ id: body.id, status: "pending" });

    const outbox = await adminPool().query(
      `SELECT event_type, payload FROM outbox_events WHERE entity_type = 'social_post_variant' AND entity_id = $1
        AND event_type = 'social.client_review.requested'`,
      [variantId],
    );
    expect(outbox.rows).toHaveLength(1);
    expect((outbox.rows[0].payload as { clientId: string }).clientId).toBe(clientId);
  });

  it("requesting again while already pending is a NO-OP: same row id, no duplicate outbox event", async () => {
    const engagementId = await makeEngagement(true);
    const variantId = await makeVariant(engagementId);
    const first = await app.inject({
      method: "POST", url: `/api/${co}/modules/social/variants/${variantId}/client-review`, headers: asUser(staff),
    });
    const firstId = (first.json() as { id: string }).id;

    const second = await app.inject({
      method: "POST", url: `/api/${co}/modules/social/variants/${variantId}/client-review`, headers: asUser(staff),
    });
    expect(second.statusCode).toBe(201);
    const secondBody = second.json() as { id: string; alreadyPending: boolean };
    expect(secondBody.id).toBe(firstId);
    expect(secondBody.alreadyPending).toBe(true);

    const outbox = await adminPool().query(
      `SELECT id FROM outbox_events WHERE entity_type = 'social_post_variant' AND entity_id = $1
        AND event_type = 'social.client_review.requested'`,
      [variantId],
    );
    expect(outbox.rows).toHaveLength(1); // still one — the no-op call emitted nothing
  });

  it("staff READ answers {status:'not_requested'} before any request, and the real row after", async () => {
    const engagementId = await makeEngagement(true);
    const variantId = await makeVariant(engagementId);

    const before = await app.inject({
      method: "GET", url: `/api/${co}/modules/social/variants/${variantId}/client-review`, headers: asUser(staff),
    });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ status: "not_requested" });

    await app.inject({
      method: "POST", url: `/api/${co}/modules/social/variants/${variantId}/client-review`, headers: asUser(staff),
    });
    const after = await app.inject({
      method: "GET", url: `/api/${co}/modules/social/variants/${variantId}/client-review`, headers: asUser(staff),
    });
    expect((after.json() as { status: string }).status).toBe("pending");
  });

  it("social_staff is DENIED withdraw (manager-tier) — a 403, not a silent no-op", async () => {
    const engagementId = await makeEngagement(true);
    const variantId = await makeVariant(engagementId);
    await app.inject({
      method: "POST", url: `/api/${co}/modules/social/variants/${variantId}/client-review`, headers: asUser(staff),
    });
    const r = await app.inject({
      method: "POST", url: `/api/${co}/modules/social/variants/${variantId}/client-review/withdraw`, headers: asUser(staff),
    });
    expect(r.statusCode).toBe(403);
  });

  it("manager withdraws a pending review: 200, row becomes withdrawn; a SECOND withdraw is idempotent (200, not an error)", async () => {
    const engagementId = await makeEngagement(true);
    const variantId = await makeVariant(engagementId);
    await app.inject({
      method: "POST", url: `/api/${co}/modules/social/variants/${variantId}/client-review`, headers: asUser(staff),
    });
    const first = await app.inject({
      method: "POST", url: `/api/${co}/modules/social/variants/${variantId}/client-review/withdraw`, headers: asUser(manager),
    });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { status: string }).status).toBe("withdrawn");
    const row = await reviewRow(variantId);
    expect(row?.status).toBe("withdrawn");

    // Idempotent: deciding (here, retracting) twice must not double-apply or error.
    const second = await app.inject({
      method: "POST", url: `/api/${co}/modules/social/variants/${variantId}/client-review/withdraw`, headers: asUser(manager),
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { status: string }).status).toBe("withdrawn");
  });

  it("withdraw on a variant with NO review requested at all is a 404", async () => {
    const engagementId = await makeEngagement(true);
    const variantId = await makeVariant(engagementId);
    const r = await app.inject({
      method: "POST", url: `/api/${co}/modules/social/variants/${variantId}/client-review/withdraw`, headers: asUser(manager),
    });
    expect(r.statusCode).toBe(404);
  });

  it("re-requesting after a withdrawal cycles the SAME row back to pending, not a second row", async () => {
    const engagementId = await makeEngagement(true);
    const variantId = await makeVariant(engagementId);
    const created = await app.inject({
      method: "POST", url: `/api/${co}/modules/social/variants/${variantId}/client-review`, headers: asUser(staff),
    });
    const reviewId = (created.json() as { id: string }).id;
    await app.inject({
      method: "POST", url: `/api/${co}/modules/social/variants/${variantId}/client-review/withdraw`, headers: asUser(manager),
    });
    const reRequested = await app.inject({
      method: "POST", url: `/api/${co}/modules/social/variants/${variantId}/client-review`, headers: asUser(staff),
    });
    expect(reRequested.statusCode).toBe(201);
    const reBody = reRequested.json() as { id: string; status: string; alreadyPending: boolean };
    expect(reBody.id).toBe(reviewId); // ONE row per variant, forever (0105's UNIQUE(variant_id))
    expect(reBody.status).toBe("pending");
    expect(reBody.alreadyPending).toBe(false); // a REAL transition (withdrawn -> pending), not a no-op

    const count = await adminPool().query(`SELECT count(*) AS n FROM social_post_client_reviews WHERE variant_id = $1`, [variantId]);
    expect(Number(count.rows[0].n)).toBe(1);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // event-handlers.ts routing — direct calls, mirroring event-handlers.test.ts's own idiom (the
  // consumer loop itself is proven reachable by event-wiring.test.ts's static pin on the SAME
  // "social_post_variant" stream these two new handlers also ride).
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("socialModule.eventHandlers registers both new routes", () => {
    expect(Object.keys(socialModule.eventHandlers ?? {})).toEqual(
      expect.arrayContaining(["social.client_review.requested", "social.client_review.decided"]),
    );
  });
});
