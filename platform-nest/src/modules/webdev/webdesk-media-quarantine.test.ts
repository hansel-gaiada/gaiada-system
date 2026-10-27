// M5-W1q (owner ruling WSK-D84) -- the contributor upload quarantine, the ERP's BFF half:
//
//   GET  /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/media/quarantine           the review queue, with a per-upload `allowed.review`
//   POST …/media/:assetId/review {decision: accept | reject}                                        accept or reject one quarantined upload
//
// Real: Postgres (RLS, the activities ledger), Cerbos (the real `webdesk_media_asset` policy, including its `review` rules and DENYs), the
// full NestJS app (`buildApp()`), the real `WebdeskMediaService`/`WebdeskZoneB`. Stand-in: Zone B, the in-process fake in
// `webdesk-content-testkit.ts` (strict about the editorial assertion, and it models `media.review` and the filtered `media.list`).
// The contributor's own Cerbos answers (upload allowed, update/delete/review denied) are proven in `rbac/contributor-principal.db.test.ts` and
// `cerbos/tests/`; this file proves the staff side over HTTP.
//
// What this proves:
//   queue     only quarantined uploads, `reviewState` forced by the BFF (never the caller's), each upload carrying the BFF's own Cerbos answer;
//             the uploader's own upload is `allowed.review = false`; a caller who may not review is a 403 BEFORE anything is read
//   review    the signed command carries the REAL uploader's Cerbos check: the uploader is refused by Cerbos and nothing reaches Zone B; an
//             unknown uploader is refused; every staff tier that may review does, with the two-row ledger and a MEDIUM assertion
//   authz     denied callers get 403 for ANY body (authorize precedes validation); the wall: another company cannot see or decide
//   library   the plain library listing still hides the quarantine and cannot be asked for it (`reviewState` is not an allowed query key)
// Needs DATABASE_URL_TEST + CERBOS_URL (skips otherwise).
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { setWebdeskApprovedCommandDepsForTests } from "./webdesk-approved-command";
import { webdeskZoneB } from "./webdesk-content.service";
import { FakeZoneB, GAIADA_SITE, GAIADA_SLUG, OTHER_SITE, OTHER_SLUG, makeTestSigner, type FakeMediaAsset } from "./webdesk-content-testkit";

const live = !!TEST_URL && !!process.env.CERBOS_URL;
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const CONTRIBUTOR_SUB = "contributor-user-1"; // a freelance writer's principal sub: not one of the company's users

describe.skipIf(!live)("M5-W1q · the contributor upload quarantine, BFF", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  let adminA: string, editorA: string, managerA: string, publisherA: string, memberA: string, adminB: string;
  let zb: FakeZoneB;
  const signer = makeTestSigner();

  const base = (co = A) => `/api/${co}/modules/webdev/content`;
  const site = (co = A, slug = GAIADA_SLUG, siteId = GAIADA_SITE) => `${base(co)}/sites/${slug}/${siteId}`;
  const call = (method: "GET" | "POST", url: string, as: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { ...asUser(as), ...headers }, payload: payload as never });
  const review = (assetId: string, decision: unknown, as: string, co = A, slug = GAIADA_SLUG, siteId = GAIADA_SITE, key = `idem-${randomUUID()}`) =>
    call("POST", `${site(co, slug, siteId)}/media/${assetId}/review`, as, { decision }, { "idempotency-key": key });

  async function ledger(verbLike = "webdesk.media.%") {
    const { rows } = await adminPool().query<{ verb: string; actor_id: string; target_entity_id: string | null; metadata: Record<string, unknown> }>(
      `SELECT verb, actor_id, target_entity_id, metadata FROM activities WHERE tenant_id = $1 AND verb LIKE $2 ORDER BY occurred_at, id`,
      [A, verbLike],
    );
    return rows;
  }
  const clearLedger = () => adminPool().query(`DELETE FROM activities WHERE tenant_id = $1 AND verb LIKE 'webdesk.%'`, [A]);
  const quarantined = (over: Partial<FakeMediaAsset> = {}): FakeMediaAsset =>
    zb.seedMedia({ siteId: GAIADA_SITE, title: "Held", originalFilename: "held.png", reviewState: "quarantined", createdBy: CONTRIBUTOR_SUB, ...over });
  const reviewCalls = () => zb.calls.filter((c) => c.command === "media.review");

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    A = await createCompany("W1q Co A", ["webdev"]);
    B = await createCompany("W1q Co B", ["webdev"]);
    const mk = async (co: string, email: string, role: string) => {
      const id = await createUser(email);
      await addMembership(co, id);
      await grantRole(id, await createRole(role), "company", co);
      return id;
    };
    adminA = await mk(A, "w1q-admin-a@ex.test", "company_admin");
    editorA = await mk(A, "w1q-editor-a@ex.test", "webdev_staff");
    managerA = await mk(A, "w1q-manager-a@ex.test", "manager");
    publisherA = await mk(A, "w1q-publisher-a@ex.test", "webdev_manager");
    memberA = await mk(A, "w1q-member-a@ex.test", "member");
    adminB = await mk(B, "w1q-admin-b@ex.test", "company_admin");
    zb = new FakeZoneB(A, B);
    app = await buildApp();
  }, 120_000);

  beforeEach(async () => {
    zb.reset();
    signer.calls.length = 0;
    signer.configured = true;
    webdeskZoneB.clearSiteCache();
    setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer });
    await clearLedger();
  });
  afterEach(() => setWebdeskApprovedCommandDepsForTests(null));
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the queue: GET …/media/quarantine", () => {
    it("lists ONLY quarantined uploads of the site, each with the BFF's own `allowed.review`; `reviewState` is forced by the BFF", async () => {
      const held = quarantined();
      zb.seedMedia({ siteId: GAIADA_SITE, title: "Public", originalFilename: "public.png" }); // accepted: not in the queue
      quarantined({ title: "Other site's", siteId: OTHER_SITE }); // another site's upload: not in this queue
      const r = await call("GET", `${site()}/media/quarantine`, editorA);
      expect(r.statusCode, r.body).toBe(200);
      const assets = r.json().assets as Array<{ assetId: string; reviewState: string; allowed: { review: boolean | null }; createdBy: string }>;
      expect(assets.map((a) => a.assetId)).toEqual([held.assetId]);
      expect(assets[0]).toMatchObject({ reviewState: "quarantined", createdBy: CONTRIBUTOR_SUB, allowed: { review: true } });
      expect(zb.calls.at(-1)).toMatchObject({ command: "media.list", params: { tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE }, query: { reviewState: "quarantined" } });
      expect(await ledger()).toHaveLength(0); // reads write nothing
    });

    it("a staff editor's OWN upload is listed but `allowed.review` is false for them (the uploader never reviews), true for another reviewer", async () => {
      quarantined({ createdBy: editorA });
      const mine = (await call("GET", `${site()}/media/quarantine`, editorA)).json().assets[0];
      expect(mine.allowed).toEqual({ review: false });
      const theirs = (await call("GET", `${site()}/media/quarantine`, publisherA)).json().assets[0];
      expect(theirs.allowed).toEqual({ review: true });
    });

    it("every staff tier that may review sees the queue; a caller who may not review is a 403 BEFORE Zone B is asked anything", async () => {
      quarantined();
      for (const who of [adminA, editorA, managerA, publisherA]) {
        expect((await call("GET", `${site()}/media/quarantine`, who)).statusCode, who).toBe(200);
      }
      const before = zb.calls.length;
      const denied = await call("GET", `${site()}/media/quarantine`, memberA);
      expect(denied.statusCode).toBe(403);
      expect(zb.calls.length).toBe(before);
    });

    it("authorize precedes validation: an unknown query key is 400 for a reviewer and 403 for a caller who may not review", async () => {
      expect((await call("GET", `${site()}/media/quarantine?reviewState=accepted`, editorA)).statusCode).toBe(400); // the BFF owns reviewState
      expect((await call("GET", `${site()}/media/quarantine?reviewState=accepted`, memberA)).statusCode).toBe(403);
    });

    it("forwards only cursor and limit", async () => {
      quarantined();
      await call("GET", `${site()}/media/quarantine?limit=20&cursor=abc`, editorA);
      expect(zb.calls.at(-1)!.query).toEqual({ limit: "20", cursor: "abc", reviewState: "quarantined" });
    });

    it("the wall: another company's admin gets the site's 404, and Zone B is never asked for the queue", async () => {
      quarantined();
      const r = await call("GET", `${site(B)}/media/quarantine`, adminB);
      expect(r.statusCode).toBe(404);
      expect(zb.calls.filter((c) => c.command === "media.list")).toHaveLength(0);
      // company A's own site under company B's route is the same 404 (positive control for the 200 above)
      expect((await call("GET", `${site(B, GAIADA_SLUG, GAIADA_SITE)}/media/quarantine`, adminB)).statusCode).toBe(404);
      expect((await call("GET", `${site(B, OTHER_SLUG, OTHER_SITE)}/media/quarantine`, adminB)).statusCode).toBe(200);
    });

    it("the plain library listing hides the quarantine and cannot be asked for it: `reviewState` and `assetId` are not allowed query keys there", async () => {
      const held = quarantined();
      const pub = zb.seedMedia({ siteId: GAIADA_SITE, title: "Public", originalFilename: "public.png" });
      const list = await call("GET", `${site()}/media`, editorA);
      expect(list.statusCode).toBe(200);
      const ids = (list.json().assets as Array<{ assetId: string }>).map((a) => a.assetId);
      expect(ids).toContain(pub.assetId);
      expect(ids).not.toContain(held.assetId);
      for (const q of ["reviewState=quarantined", "reviewState=all", `assetId=${held.assetId}`]) {
        expect((await call("GET", `${site()}/media?${q}`, editorA)).statusCode, q).toBe(400);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the decision: POST …/media/:assetId/review", () => {
    it("accept: 200 {asset, decision, alreadyDecided}; the signed MEDIUM command carries the route's ids and the decision; the two-row ledger names the decision", async () => {
      const held = quarantined();
      const r = await review(held.assetId, "accept", editorA, A, GAIADA_SLUG, GAIADA_SITE, "idem-w1q-accept-1");
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ decision: "accept", alreadyDecided: false, asset: { assetId: held.assetId, reviewState: "accepted" } });
      const w = reviewCalls().at(-1)!;
      expect(w).toMatchObject({ command: "media.review", method: "POST", idempotencyKey: "idem-w1q-accept-1", params: { tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, assetId: held.assetId }, body: { decision: "accept" } });
      const claims = signer.calls.at(-1)!;
      expect(claims).toMatchObject({ sub: editorA, pk: "human", ten: GAIADA_SLUG, site: GAIADA_SITE, cmd: "media.review" });
      expect(claims).not.toHaveProperty("apr"); // MEDIUM: no approval
      const rows = await ledger("webdesk.media.review");
      expect(rows.map((x) => x.metadata.outcome)).toEqual(["attempted", "succeeded"]);
      expect(rows[0].metadata).toMatchObject({ assetId: held.assetId, decision: "accept" });
      expect(rows[0].target_entity_id).toBe(held.assetId);
      expect(rows.every((x) => x.actor_id === editorA)).toBe(true);
    });

    it("reject: 200, the upload is rejected and gone from the queue", async () => {
      const held = quarantined();
      const r = await review(held.assetId, "reject", publisherA);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ decision: "reject", asset: { reviewState: "rejected" } });
      const queue = (await call("GET", `${site()}/media/quarantine`, publisherA)).json().assets as unknown[];
      expect(queue).toHaveLength(0);
    });

    it("every staff tier that may review does (company admin, Web Dev editor, manager, Web Dev manager), each with the identical request", async () => {
      for (const who of [adminA, editorA, managerA, publisherA]) {
        const held = quarantined();
        const r = await review(held.assetId, "accept", who);
        expect(r.statusCode, `${who}: ${r.body}`).toBe(200);
      }
    });

    it("THE UPLOADER NEVER REVIEWS THEIR OWN UPLOAD: Cerbos refuses (403), nothing reaches Zone B; another reviewer's identical request succeeds", async () => {
      const mine = quarantined({ createdBy: editorA });
      const before = reviewCalls().length;
      const self = await review(mine.assetId, "accept", editorA);
      expect(self.statusCode, self.body).toBe(403);
      expect(reviewCalls().length).toBe(before);
      expect(zb.media.get(mine.assetId)!.reviewState).toBe("quarantined");
      expect((await review(mine.assetId, "accept", publisherA)).statusCode).toBe(200);
    });

    it("an upload whose uploader is unknown is refused to everyone (four eyes cannot be shown), and nothing is sent", async () => {
      const orphan = quarantined({ createdBy: null });
      for (const who of [adminA, publisherA]) {
        const r = await review(orphan.assetId, "accept", who);
        expect(r.statusCode, who).toBe(403);
      }
      expect(reviewCalls()).toHaveLength(0);
    });

    it("a caller who may not review is 403 for ANY body, and nothing is read or sent (authorize precedes validation)", async () => {
      const held = quarantined();
      const before = zb.calls.length;
      for (const body of [{ decision: "accept" }, { decision: "maybe" }, {}, { decision: "accept", extra: 1 }]) {
        const r = await call("POST", `${site()}/media/${held.assetId}/review`, memberA, body, { "idempotency-key": `idem-${randomUUID()}` });
        expect(r.statusCode, JSON.stringify(body)).toBe(403);
      }
      expect(zb.calls.length).toBe(before);
      // positive control: the same body, a reviewer, succeeds
      expect((await review(held.assetId, "accept", editorA)).statusCode).toBe(200);
    });

    it("validation for a reviewer: the decision is accept or reject, nothing else; a malformed Idempotency-Key is a 400; a malformed or unknown asset is the typed 404", async () => {
      const held = quarantined();
      for (const body of [{ decision: "maybe" }, {}, { decision: "accept", extra: 1 }, [1]]) {
        const r = await call("POST", `${site()}/media/${held.assetId}/review`, editorA, body, { "idempotency-key": `idem-${randomUUID()}` });
        expect(r.statusCode, JSON.stringify(body)).toBe(400);
      }
      expect((await call("POST", `${site()}/media/${held.assetId}/review`, editorA, { decision: "accept" }, { "idempotency-key": "short" })).statusCode).toBe(400); // a malformed key
      for (const id of ["not-a-uuid", randomUUID()]) {
        const r = await review(id, "accept", editorA);
        expect(r.statusCode, id).toBe(404);
        expect(r.json().type).toContain("/media-asset-not-found");
      }
      expect(reviewCalls()).toHaveLength(0);
    });

    it("Zone B's own refusals pass through untouched: already decided is its 409, the opposite decision is its 409 media-not-quarantined", async () => {
      const held = quarantined();
      expect((await review(held.assetId, "accept", editorA)).statusCode).toBe(200);
      const again = await review(held.assetId, "accept", publisherA);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().alreadyDecided).toBe(true);
      const flip = await review(held.assetId, "reject", publisherA);
      expect(flip.statusCode, flip.body).toBe(409);
      expect(flip.headers["content-type"]).toContain("application/problem+json");
      expect(flip.json().type).toContain("/media-not-quarantined");
    });

    it("the wall: another company's admin cannot decide company A's upload, and the asset does not change", async () => {
      const held = quarantined();
      const r = await review(held.assetId, "accept", adminB, B);
      expect(r.statusCode).toBe(404);
      expect(reviewCalls()).toHaveLength(0);
      expect(zb.media.get(held.assetId)!.reviewState).toBe("quarantined");
    });

    it("an asset of ANOTHER site is the same 404 as an unknown one (the uploader is read from THIS site's row, never trusted from the request)", async () => {
      const elsewhere = quarantined({ siteId: OTHER_SITE });
      const r = await review(elsewhere.assetId, "accept", editorA);
      expect(r.statusCode).toBe(404);
      expect(reviewCalls()).toHaveLength(0);
    });
  });
});
