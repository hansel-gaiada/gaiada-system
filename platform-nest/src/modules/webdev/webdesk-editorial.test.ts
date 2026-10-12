// M5-W2d — the review flow's BFF over the REAL surface: HTTP (`app.inject`), the real Cerbos with the W1a policies, the real principal
// assembly (scope rows from Postgres), the real content and editorial services, the real `notifications` table. Stand-in: Zone B, the
// in-process FakeZoneB (it records every call, so "WebDesk received no write" is asserted on what was actually sent).
//
// Every denial sends a VALID body and sits beside a positive control (same request, an allowed principal, 2xx).
// Needs DATABASE_URL_TEST + CERBOS_URL, the test Cerbos restarted on the W1a policies. NOT RUN LOCALLY (owner order: no docker on
// the laptop); it runs on the Linux gate (CI).
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
import { submitRecipients } from "./webdesk-editorial.service";
import { FakeZoneB, GAIADA_SITE, GAIADA_SLUG, OTHER_SITE, makeTestSigner, type FakeItem } from "./webdesk-content-testkit";

const live = !!TEST_URL && !!process.env.CERBOS_URL;
const asUser = (id: string) => ({ authorization: "Bearer svc-token", "x-user-id": id });

describe.skipIf(!live)("M5-W2d · the review flow over HTTP, real Cerbos", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  let publisherA: string, staffA: string, platformAdmin: string, writerA: string, authorA: string, otherWriter: string;
  let editorOne: string, editorTwo: string, editorOtherCollection: string, editorB: string, botA: string, automationA: string, seoA: string;
  let zb: FakeZoneB;
  const signer = makeTestSigner();

  const site = () => `/api/${A}/modules/webdev/content/sites/${GAIADA_SLUG}/${GAIADA_SITE}`;
  const call = (method: "GET" | "POST" | "PUT", url: string, as: string, payload?: unknown, idem = "idem-key-0001") =>
    app.inject({ method, url, headers: { ...asUser(as), "idempotency-key": idem }, ...(payload !== undefined ? { payload: payload as never } : {}) });
  const notes = async (userId: string, type?: string) =>
    (await adminPool().query(`SELECT type, payload FROM notifications WHERE user_id = $1 ${type ? "AND type = $2" : ""}`, type ? [userId, type] : [userId])).rows;

  async function editorial(tenant: string, userId: string, role: string, siteId: string, collections: string[] | "all", locales: string[] | "all") {
    const roleId = await createRole(role);
    await grantRole(userId, roleId, "company", tenant);
    const g = (await adminPool().query(`SELECT id FROM user_roles WHERE user_id = $1 AND role_id = $2`, [userId, roleId])).rows[0].id;
    await adminPool().query(
      `INSERT INTO user_role_editorial_scopes (user_role_id, tenant_id, webdesk_tenant_slug, site_id, all_collections, collections, all_locales, locales, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [g, tenant, siteId === OTHER_SITE ? "othertenant" : GAIADA_SLUG, siteId, collections === "all", collections === "all" ? [] : collections, locales === "all", locales === "all" ? [] : locales, config.originSite],
    );
  }

  /** An item in review: `author` owns it, `creator` made the submitted version 1. */
  const seed = (slug: string, author: string, state: string, creator = author): FakeItem => {
    const it = zb.seedItem({
      siteId: GAIADA_SITE, slug, collectionKey: "post", locale: "en",
      editorial: { reviewRequired: true, state, approvedVersion: null, authorSub: author, submittedVersion: state === "in_review" ? 1 : null },
    });
    it.versions[0].createdBy = creator;
    return it;
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    A = await createCompany("W2d Co A", ["webdev"]);
    B = await createCompany("W2d Co B", ["webdev"]);
    const mk = async (co: string, email: string, role: string, scopeType: "company" | "global" = "company") => {
      const id = await createUser(email);
      await addMembership(co, id);
      await grantRole(id, await createRole(role), scopeType, scopeType === "global" ? null : co);
      return id;
    };
    publisherA = await mk(A, "publisher@w2d.test", "webdev_manager");
    staffA = await mk(A, "staff@w2d.test", "webdev_staff");
    platformAdmin = await mk(A, "padmin@w2d.test", "platform_admin", "global");
    writerA = await mk(A, "writer@w2d.test", "member");
    authorA = await mk(A, "author@w2d.test", "member");
    otherWriter = await mk(A, "other-writer@w2d.test", "member");
    editorOne = await mk(A, "editor1@w2d.test", "member");
    editorTwo = await mk(A, "editor2@w2d.test", "member");
    editorOtherCollection = await mk(A, "editor-other@w2d.test", "member");
    editorB = await mk(B, "editor-b@w2d.test", "member");
    seoA = await mk(A, "seo@w2d.test", "member");
    botA = await mk(A, "bot@w2d.test", "webdev_manager");
    automationA = await mk(A, "automation@w2d.test", "webdev_manager");
    await adminPool().query(`UPDATE users SET kind = 'bot' WHERE id = $1`, [botA]);
    await adminPool().query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [automationA]);
    await editorial(A, writerA, "webdesk_writer", GAIADA_SITE, ["post"], ["en"]);
    await editorial(A, authorA, "webdesk_writer", GAIADA_SITE, ["post"], ["en"]);
    await editorial(A, otherWriter, "webdesk_writer", GAIADA_SITE, ["post"], ["en"]);
    await editorial(A, editorOne, "webdesk_editor", GAIADA_SITE, ["post"], ["en"]);
    await editorial(A, editorTwo, "webdesk_editor", GAIADA_SITE, "all", "all");
    await editorial(A, editorOtherCollection, "webdesk_editor", GAIADA_SITE, ["guide"], "all");
    await editorial(A, seoA, "webdesk_seo_reviewer", GAIADA_SITE, "all", "all");
    // another company's editor on a site id of its own: must never be told about company A's items
    await editorial(B, editorB, "webdesk_editor", OTHER_SITE, "all", "all");
    zb = new FakeZoneB(A, B);
    zb.compositions.set("post", { ui: { label: "Posts" } });
    zb.compositions.set("guide", { ui: { label: "Guides" } });
    app = await buildApp();
  }, 120_000);

  beforeEach(async () => {
    zb.reset();
    signer.calls.length = 0;
    webdeskZoneB.clearSiteCache();
    setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer });
    await adminPool().query(`DELETE FROM notifications WHERE tenant_id IN ($1, $2)`, [A, B]);
  });
  afterEach(() => setWebdeskApprovedCommandDepsForTests(null));
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("every route answers 403 BEFORE validation for a denied caller, and WebDesk receives no write", () => {
    // [method, path suffix, valid body, denied caller, allowed caller (positive control), seed state]
    type Case = [string, string, "POST" | "PUT", unknown, () => string, () => string, string];
    const cases: Case[] = [
      ["submit", "editorial/submit", "POST", { version: 1 }, () => otherWriter, () => authorA, "draft"],
      ["withdraw", "editorial/withdraw", "POST", {}, () => otherWriter, () => authorA, "in_review"],
      ["request-changes", "editorial/request-changes", "POST", { version: 1, note: "tighten the intro" }, () => authorA, () => editorTwo, "in_review"],
      ["seo-signoff", "editorial/seo-signoff", "POST", { version: 1 }, () => authorA, () => seoA, "in_review"],
      ["approve", "editorial/approve", "POST", { version: 1 }, () => authorA, () => editorTwo, "in_review"],
      ["assign", "editorial/assign", "POST", { dueAt: "2026-12-01" }, () => authorA, () => editorTwo, "draft"],
      ["comment", "editorial/comments", "POST", { version: 1, body: "nice" }, () => otherWriter, () => authorA, "in_review"],
    ];
    for (const [name, suffix, method, body, denied, allowed, state] of cases) {
      it(`${name}: denied caller 403 with a valid body (no write); the allowed caller 2xx`, async () => {
        const it0 = seed(`post.${name}`, authorA, state);
        const url = `${site()}/items/${it0.itemId}/${suffix}`;
        expect((await call(method, url, denied(), body)).statusCode).toBe(403);
        expect(zb.writes).toHaveLength(0);
        expect(signer.calls).toHaveLength(0);
        const ok = await call(method, url, allowed(), body);
        expect(ok.statusCode, ok.body).toBeLessThan(300);
        expect(zb.writes).toHaveLength(1);
      });
    }

    it("comment resolve: another author 403, the item's author 200", async () => {
      const it0 = seed("post.resolve", authorA, "in_review");
      const url = `${site()}/items/${it0.itemId}/editorial/comments/0f1e2d3c-4b5a-4968-8776-655443322110/resolve`;
      expect((await call("POST", url, otherWriter, {})).statusCode).toBe(403);
      expect(zb.writes).toHaveLength(0);
      expect((await call("POST", url, authorA, {})).statusCode).toBe(200);
    });

    it("editorial-policy: a writer and an editor are 403 (manage_editorial), the publisher 200", async () => {
      const url = `${site()}/collections/post/editorial-policy`;
      for (const who of [writerA, editorTwo]) expect((await call("PUT", url, who, { reviewRequired: true })).statusCode).toBe(403);
      expect(zb.writes).toHaveLength(0);
      expect((await call("PUT", url, publisherA, { reviewRequired: true })).statusCode).toBe(200);
      expect(zb.writes.map((w) => w.command)).toEqual(["editorial.policySet"]);
    });

    it("an item of a collection outside the grant is 403 for submit (writer scoped to post, item in guide)", async () => {
      const g = zb.seedItem({ siteId: GAIADA_SITE, slug: "guide.one", collectionKey: "guide", locale: "en", editorial: { reviewRequired: true, state: "draft", approvedVersion: null, authorSub: writerA, submittedVersion: null } });
      expect((await call("POST", `${site()}/items/${g.itemId}/editorial/submit`, writerA, { version: 1 })).statusCode).toBe(403);
      expect(zb.writes).toHaveLength(0);
    });

    it("a validation failure is 400 only for a caller that passed authorization", async () => {
      const it0 = seed("post.badbody", authorA, "draft");
      const url = `${site()}/items/${it0.itemId}/editorial/submit`;
      expect((await call("POST", url, otherWriter, { version: "x" })).statusCode).toBe(403);
      expect((await call("POST", url, authorA, { version: "x" })).statusCode).toBe(400);
      expect(zb.writes).toHaveLength(0);
    });

    it("the write carries a signed editorial assertion for the CALLER and the Idempotency-Key", async () => {
      const it0 = seed("post.signed", authorA, "draft");
      await call("POST", `${site()}/items/${it0.itemId}/editorial/submit`, authorA, { version: 1 }, "my-idem-key-77");
      expect(zb.writes[0].idempotencyKey).toBe("my-idem-key-77");
      expect(zb.writes[0].claims).toMatchObject({ sub: authorA, cmd: "editorial.submit", ten: GAIADA_SLUG, site: GAIADA_SITE, pk: "human" });
    });

    it("WebDesk's typed problems pass through unchanged (409 review-not-enabled)", async () => {
      const it0 = seed("post.noreview", authorA, "draft");
      zb.nextWriteResponse = { status: 409, contentType: "application/problem+json", json: { type: "https://webdesk.gaiada.online/errors/review-not-enabled", title: "x", status: 409 }, bodyText: "" };
      const r = await call("POST", `${site()}/items/${it0.itemId}/editorial/submit`, authorA, { version: 1 });
      expect(r.statusCode).toBe(409);
      expect(r.json().type).toMatch(/review-not-enabled$/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("approve: maker != checker, and machines never approve (real Cerbos)", () => {
    it("an editor approving a version they CREATED is 403, even as platform_admin; another editor's approval is 200", async () => {
      const mine = seed("post.self-editor", authorA, "in_review", editorTwo); // editorTwo rewrote it
      const url = `${site()}/items/${mine.itemId}/editorial/approve`;
      expect((await call("POST", url, editorTwo, { version: 1 })).statusCode).toBe(403);
      expect(zb.writes).toHaveLength(0);
      const adminsOwn = seed("post.self-admin", authorA, "in_review", platformAdmin);
      expect((await call("POST", `${site()}/items/${adminsOwn.itemId}/editorial/approve`, platformAdmin, { version: 1 })).statusCode).toBe(403);
      expect(zb.writes).toHaveLength(0);
      expect((await call("POST", url, editorOne, { version: 1 })).statusCode).toBe(200);
      expect((await call("POST", `${site()}/items/${adminsOwn.itemId}/editorial/approve`, publisherA, { version: 1 })).statusCode).toBe(200);
    });

    it("the creator is WebDesk's, never the body's: a body naming another creator changes nothing", async () => {
      const mine = seed("post.forged", authorA, "in_review", editorTwo);
      const r = await call("POST", `${site()}/items/${mine.itemId}/editorial/approve`, editorTwo, { version: 1, creatorId: editorOne });
      expect(r.statusCode).toBe(403); // authorization first: the forged key never reaches validation
      expect(zb.writes).toHaveLength(0);
    });

    it("a bot's and an automation principal's approve is 403 with a valid body; their seo sign-off too; no write", async () => {
      const it0 = seed("post.machine", authorA, "in_review");
      for (const who of [botA, automationA]) {
        expect((await call("POST", `${site()}/items/${it0.itemId}/editorial/approve`, who, { version: 1 })).statusCode).toBe(403);
        expect((await call("POST", `${site()}/items/${it0.itemId}/editorial/seo-signoff`, who, { version: 1 })).statusCode).toBe(403);
      }
      expect(zb.writes).toHaveLength(0);
      expect((await call("POST", `${site()}/items/${it0.itemId}/editorial/approve`, publisherA, { version: 1 })).statusCode).toBe(200);
    });

    it("an item not in review cannot be approved (403: no known creator, four eyes cannot be shown)", async () => {
      const it0 = seed("post.draft-approve", authorA, "draft");
      expect((await call("POST", `${site()}/items/${it0.itemId}/editorial/approve`, publisherA, { version: 1 })).statusCode).toBe(403);
      expect(zb.writes).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("notifications: ids and titles only, after WebDesk confirmed, to the right people", () => {
    it("a submit tells the editors whose scope covers the item and the publisher; not the author, a narrower-scope editor, another company's editor or a writer", async () => {
      const it0 = seed("post.notify-submit", authorA, "draft");
      expect((await call("POST", `${site()}/items/${it0.itemId}/editorial/submit`, authorA, { version: 1 })).statusCode).toBe(200);
      for (const who of [editorOne, editorTwo, publisherA]) expect(await notes(who, "webdesk.editorial.submitted")).toHaveLength(1);
      for (const who of [authorA, editorOtherCollection, editorB, writerA, seoA, staffA]) expect(await notes(who)).toHaveLength(0);
      const p = (await notes(editorOne))[0].payload;
      expect(p).toMatchObject({ entityType: "webdesk_content_item", entityId: it0.itemId, collectionKey: "post", locale: "en" });
      expect(Object.keys(p)).not.toContain("body");
    });

    it("a refused submit (WebDesk 409) notifies nobody", async () => {
      const it0 = seed("post.notify-refused", authorA, "draft");
      zb.nextWriteResponse = { status: 409, contentType: "application/problem+json", json: { type: "https://webdesk.gaiada.online/errors/review-state-conflict", title: "x", status: 409 }, bodyText: "" };
      expect((await call("POST", `${site()}/items/${it0.itemId}/editorial/submit`, authorA, { version: 1 })).statusCode).toBe(409);
      expect((await adminPool().query(`SELECT 1 FROM notifications WHERE tenant_id = $1`, [A])).rows).toHaveLength(0);
    });

    it("changes requested and an approval go to the item's author only, and carry no note text", async () => {
      const it0 = seed("post.notify-author", authorA, "in_review");
      const note = "SECRET-NOTE-TEXT rewrite the intro";
      expect((await call("POST", `${site()}/items/${it0.itemId}/editorial/request-changes`, editorTwo, { version: 1, note })).statusCode).toBe(200);
      const got = await notes(authorA, "webdesk.editorial.changes_requested");
      expect(got).toHaveLength(1);
      expect(JSON.stringify(got[0].payload)).not.toContain("SECRET-NOTE-TEXT");
      const it1 = seed("post.notify-approve", authorA, "in_review");
      expect((await call("POST", `${site()}/items/${it1.itemId}/editorial/approve`, editorTwo, { version: 1 })).statusCode).toBe(200);
      expect(await notes(authorA, "webdesk.editorial.approved")).toHaveLength(1);
      for (const who of [editorOne, publisherA, editorB, otherWriter]) expect(await notes(who)).toHaveLength(0);
    });

    it("the approver who is also the author is not notified of their own action", async () => {
      const it0 = seed("post.notify-self", editorTwo, "in_review", authorA);
      expect((await call("POST", `${site()}/items/${it0.itemId}/editorial/approve`, editorTwo, { version: 1 })).statusCode).toBe(200);
      expect(await notes(editorTwo)).toHaveLength(0);
    });

    it("submitRecipients reads the scope table through the tenant wall: company B sees only its own editor", async () => {
      expect((await submitRecipients(A, GAIADA_SITE, "post", "en")).sort()).toEqual([editorOne, editorTwo, publisherA, botA, automationA].sort());
      expect(await submitRecipients(A, OTHER_SITE, "post", "en")).not.toContain(editorB);
      expect(await submitRecipients(B, OTHER_SITE, "post", "en")).toEqual([editorB]);
      expect(await submitRecipients(B, GAIADA_SITE, "post", "en")).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("reads", () => {
    it("board: staff get WebDesk's answer; a scoped writer gets only its collection and no counts", async () => {
      seed("post.board-a", authorA, "in_review");
      const g = zb.seedItem({ siteId: GAIADA_SITE, slug: "guide.board", collectionKey: "guide", locale: "en", editorial: { reviewRequired: true, state: "draft", approvedVersion: null, authorSub: staffA, submittedVersion: null } });
      void g;
      const staff = await call("GET", `${site()}/editorial/board`, staffA);
      expect(staff.statusCode, staff.body).toBe(200);
      const scoped = await call("GET", `${site()}/editorial/board`, writerA);
      expect(scoped.statusCode, scoped.body).toBe(200);
      expect(scoped.json().counts).toBeUndefined();
      expect((scoped.json().items as Array<{ collectionKey: string }>).every((i) => i.collectionKey === "post")).toBe(true);
      expect(zb.writes).toHaveLength(0);
    });

    it("history: in scope 200, out of scope 403", async () => {
      const g = zb.seedItem({ siteId: GAIADA_SITE, slug: "guide.hist", collectionKey: "guide", locale: "en", editorial: { reviewRequired: true, state: "draft", approvedVersion: null, authorSub: staffA, submittedVersion: null } });
      expect((await call("GET", `${site()}/items/${g.itemId}/editorial`, writerA)).statusCode).toBe(403);
      expect((await call("GET", `${site()}/items/${g.itemId}/editorial`, staffA)).statusCode).toBe(200);
    });
  });
});
