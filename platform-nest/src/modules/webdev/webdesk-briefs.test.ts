// M5-W4 — content briefs for the writers' room over the REAL surface: HTTP (`app.inject`), the real Cerbos with the W1a policies, the real
// principal assembly (scope rows from Postgres), the real content and editorial services, the real `search_content_briefs` table under FORCE RLS
// and the real `notifications` table. Stand-in: Zone B, the in-process FakeZoneB (it records every call, so "WebDesk received no write" is asserted
// on what was actually sent).
//
// THE DECISION UNDER TEST (webdesk-briefs.service.ts header): no new Cerbos kind. Managing a brief is `webdesk_content_item:assign` on the brief's
// {site, collection, locale}; reading a linked brief is `webdesk_content_item:comment` on its item, with the author read from WebDesk.
//
// Every denial sends a VALID body and sits beside a positive control (same request, an allowed principal, 2xx). Needs DATABASE_URL_TEST + CERBOS_URL,
// the test Cerbos restarted on the W1a policies. NOT RUN LOCALLY (owner order: no docker on the laptop); it runs on the Linux gate (CI).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId, withGlobal, withTenants } from "../../db";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createClient, createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { setWebdeskApprovedCommandDepsForTests } from "./webdesk-approved-command";
import { webdeskZoneB } from "./webdesk-content.service";
import { FakeZoneB, GAIADA_SITE, GAIADA_SLUG, OTHER_SITE, makeTestSigner } from "./webdesk-content-testkit";

const live = !!TEST_URL && !!process.env.CERBOS_URL;
const asUser = (id: string) => ({ authorization: "Bearer svc-token", "x-user-id": id });

describe.skipIf(!live)("M5-W4 · writers' room briefs over HTTP, real Cerbos, real RLS", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  let publisherA: string, staffA: string, adminA: string, platformAdmin: string, searchStaffA: string;
  let writerOwn: string, writerOther: string, seoA: string;
  let editorPost: string, editorPostEn: string, editorGuide: string, editorAll: string, editorB: string;
  let propertyId: string;
  let seoBriefId: string;
  let zb: FakeZoneB;
  const signer = makeTestSigner();

  const site = () => `/api/${A}/modules/webdev/content/sites/${GAIADA_SLUG}/${GAIADA_SITE}`;
  const call = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, as: string, payload?: unknown, idem = "idem-brief-0001") =>
    app.inject({ method, url, headers: { ...asUser(as), "idempotency-key": idem }, ...(payload !== undefined ? { payload: payload as never } : {}) });
  const notes = async (userId: string, type?: string) =>
    (await adminPool().query(`SELECT type, payload FROM notifications WHERE user_id = $1 ${type ? "AND type = $2" : ""}`, type ? [userId, type] : [userId])).rows;
  const briefRows = async (tenant = A) => (await adminPool().query(`SELECT * FROM search_content_briefs WHERE tenant_id = $1 AND webdesk_site_id IS NOT NULL ORDER BY created_at`, [tenant])).rows;
  const briefRow = async (id: string) => (await adminPool().query(`SELECT * FROM search_content_briefs WHERE id = $1`, [id])).rows[0];
  let uniq = 0;
  const slug = (p: string) => `${p}-${++uniq}`;

  const body = (over: Record<string, unknown> = {}) => ({
    collectionKey: "post", locale: "en", topic: `Villa guide ${++uniq}`, targetQuery: "villa bali", searchIntent: "commercial",
    aiQuestions: ["Is a villa cheaper than a hotel?"], contentGaps: ["no pricing section"], ...over,
  });
  /** An editor in scope files a brief; the id comes back. */
  const fileBrief = async (over: Record<string, unknown> = {}, as = () => editorPost): Promise<string> => {
    const r = await call("POST", `${site()}/briefs`, as(), body(over));
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  };
  /** Brief + draft, assigned to `author`: the writer's world. */
  const draftFor = async (author: string, over: Record<string, unknown> = {}) => {
    const id = await fileBrief(over);
    const r = await call("POST", `${site()}/briefs/${id}/create-draft`, editorPost, { slug: slug("villa"), authorSub: author }, `idem-draft-${++uniq}-xx`);
    expect(r.statusCode, r.body).toBe(201);
    return { briefId: id, itemId: r.json().item.itemId as string };
  };

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

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    A = await createCompany("W4 Co A", ["webdev", "search"]);
    B = await createCompany("W4 Co B", ["webdev", "search"]);
    const mk = async (co: string, email: string, role: string, scopeType: "company" | "global" = "company") => {
      const id = await createUser(email);
      await addMembership(co, id);
      await grantRole(id, await createRole(role), scopeType, scopeType === "global" ? null : co);
      return id;
    };
    publisherA = await mk(A, "publisher@w4.test", "webdev_manager");
    staffA = await mk(A, "staff@w4.test", "webdev_staff");
    adminA = await mk(A, "admin@w4.test", "company_admin");
    searchStaffA = await mk(A, "search@w4.test", "search_staff");
    platformAdmin = await mk(A, "padmin@w4.test", "platform_admin", "global");
    writerOwn = await mk(A, "writer-own@w4.test", "member");
    writerOther = await mk(A, "writer-other@w4.test", "member");
    seoA = await mk(A, "seo@w4.test", "member");
    editorPost = await mk(A, "editor-post@w4.test", "member");
    editorPostEn = await mk(A, "editor-post-en@w4.test", "member");
    editorGuide = await mk(A, "editor-guide@w4.test", "member");
    editorAll = await mk(A, "editor-all@w4.test", "member");
    editorB = await mk(B, "editor-b@w4.test", "member");
    await editorial(A, writerOwn, "webdesk_writer", GAIADA_SITE, ["post"], ["en"]);
    await editorial(A, writerOther, "webdesk_writer", GAIADA_SITE, ["post"], ["en"]);
    await editorial(A, seoA, "webdesk_seo_reviewer", GAIADA_SITE, "all", "all");
    await editorial(A, editorPost, "webdesk_editor", GAIADA_SITE, ["post"], "all");
    await editorial(A, editorPostEn, "webdesk_editor", GAIADA_SITE, ["post"], ["en"]);
    await editorial(A, editorGuide, "webdesk_editor", GAIADA_SITE, ["guide"], "all");
    await editorial(A, editorAll, "webdesk_editor", GAIADA_SITE, "all", "all");
    await editorial(B, editorB, "webdesk_editor", OTHER_SITE, "all", "all");

    // an SEO-department brief with a search property (staff's existing surface; `fromBriefId` copies it)
    const clientId = await createClient(A, "W4 client");
    propertyId = newId();
    await adminPool().query(`INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url) VALUES ($1,$2,$3,'w4.example.com','https://w4.example.com')`, [propertyId, A, clientId]);
    seoBriefId = newId();
    await adminPool().query(
      `INSERT INTO search_content_briefs (id, tenant_id, property_id, topic, status, outline, body, geo_notes, grounding, origin_site)
       VALUES ($1,$2,$3,'SEO dept brief','draft','["Intro","Pricing"]','Seed body','Use FAQ schema','{"findingCount":3}',$4)`,
      [seoBriefId, A, propertyId, config.originSite],
    );
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
    await adminPool().query(`DELETE FROM search_content_briefs WHERE webdesk_site_id IS NOT NULL`);
  });
  afterEach(() => setWebdeskApprovedCommandDepsForTests(null));
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("create: an editor in scope files a brief; nobody else does", () => {
    it("201 for the scoped editor, with the link written from the ROUTE and WebDesk (never the body); WebDesk receives no write", async () => {
      const r = await call("POST", `${site()}/briefs`, editorPost, body({ topic: "Best villas in Ubud" }));
      expect(r.statusCode, r.body).toBe(201);
      const b = r.json();
      expect(b).toMatchObject({ status: "draft", topic: "Best villas in Ubud", collectionKey: "post", locale: "en", siteId: GAIADA_SITE, tenantSlug: GAIADA_SLUG, itemId: null, targetQuery: "villa bali", searchIntent: "commercial" });
      expect(b.provenance).toMatchObject({ propertyId: null, createdBy: editorPost });
      const row = await briefRow(b.id);
      expect(row).toMatchObject({ tenant_id: A, webdesk_site_id: GAIADA_SITE, collection_key: "post", locale: "en", webdesk_item_id: null, property_id: null });
      expect(zb.writes).toHaveLength(0);
      expect(zb.calls.some((c) => c.command === "collection.get")).toBe(true); // the collection was proven against WebDesk
    });

    it("a body cannot name the site, the tenant, the assignee, the item or the creator (400 for an allowed caller)", async () => {
      for (const k of ["siteId", "tenantSlug", "assigneeId", "itemId", "createdBy", "webdeskSiteId"]) {
        expect((await call("POST", `${site()}/briefs`, editorPost, body({ [k]: GAIADA_SITE }))).statusCode, k).toBe(400);
      }
      expect(await briefRows()).toHaveLength(0);
    });

    for (const [name, who] of [["a writer", () => writerOwn], ["an SEO reviewer", () => seoA], ["unscoped webdev staff", () => staffA], ["search-only staff", () => searchStaffA]] as const) {
      it(`${name}: 403 with a valid body, no brief, no WebDesk write; the editor is the positive control`, async () => {
        const r = await call("POST", `${site()}/briefs`, who(), body());
        expect(r.statusCode, r.body).toBe(403);
        expect(await briefRows()).toHaveLength(0);
        expect(zb.writes).toHaveLength(0);
        expect((await call("POST", `${site()}/briefs`, editorPost, body())).statusCode).toBe(201);
      });
    }

    it("scope: an editor of `guide` cannot file a `post` brief (403) but can file a `guide` brief (201); a locale outside the grant is 403", async () => {
      expect((await call("POST", `${site()}/briefs`, editorGuide, body({ collectionKey: "post" }))).statusCode).toBe(403);
      expect((await call("POST", `${site()}/briefs`, editorGuide, body({ collectionKey: "guide" }))).statusCode).toBe(201);
      expect((await call("POST", `${site()}/briefs`, editorPostEn, body({ locale: "id" }))).statusCode).toBe(403);
      expect((await call("POST", `${site()}/briefs`, editorPostEn, body({ locale: "en" }))).statusCode).toBe(201);
    });

    it("authorization first: a denied caller with an INVALID body is 403, an allowed caller with the same body is 400", async () => {
      const bad = { collectionKey: "post", locale: "en", topic: "", aiQuestions: "nope" };
      expect((await call("POST", `${site()}/briefs`, writerOwn, bad)).statusCode).toBe(403);
      expect((await call("POST", `${site()}/briefs`, editorPost, bad)).statusCode).toBe(400);
    });

    it("a collection that does not exist on the site is WebDesk's typed 404; a locale outside the tenant's is 400", async () => {
      const r = await call("POST", `${site()}/briefs`, platformAdmin, body({ collectionKey: "nope" }));
      expect(r.statusCode).toBe(404);
      expect(r.headers["content-type"]).toContain("application/problem+json");
      expect((await call("POST", `${site()}/briefs`, platformAdmin, body({ locale: "fr" }))).statusCode).toBe(400);
      expect(await briefRows()).toHaveLength(0);
    });

    it("cross-company: another company's editor, and the platform admin through the wrong company, cannot reach this site", async () => {
      const wrong = `/api/${B}/modules/webdev/content/sites/${GAIADA_SLUG}/${GAIADA_SITE}/briefs`;
      expect((await call("POST", wrong, editorB, body())).statusCode).toBe(403);
      expect([403, 404]).toContain((await call("POST", wrong, platformAdmin, body())).statusCode); // the wall (404): this tenant is not company B's
      expect(await briefRows(B)).toHaveLength(0);
      expect(await briefRows(A)).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the search link never widens search access", () => {
    it("propertyId: an editor with no search access is 403 (valid body, no brief); a company admin who holds both is 201 and the property is recorded", async () => {
      expect((await call("POST", `${site()}/briefs`, editorPost, body({ propertyId }))).statusCode).toBe(403);
      expect(await briefRows()).toHaveLength(0);
      const ok = await call("POST", `${site()}/briefs`, adminA, body({ propertyId }));
      expect(ok.statusCode, ok.body).toBe(201);
      expect(ok.json().provenance.propertyId).toBe(propertyId);
    });

    it("fromBriefId copies a SEO brief only for a caller who can read its property; the writer's view then omits the property", async () => {
      expect((await call("POST", `${site()}/briefs`, editorPost, { collectionKey: "post", locale: "en", fromBriefId: seoBriefId })).statusCode).toBe(403);
      const ok = await call("POST", `${site()}/briefs`, adminA, { collectionKey: "post", locale: "en", fromBriefId: seoBriefId, aiQuestions: ["q?"] });
      expect(ok.statusCode, ok.body).toBe(201);
      expect(ok.json()).toMatchObject({ topic: "SEO dept brief", outline: ["Intro", "Pricing"], body: "Seed body", geoNotes: "Use FAQ schema", aiQuestions: ["q?"] });
      expect(ok.json().provenance).toMatchObject({ propertyId, sourceBriefId: seoBriefId });
      // the SEO original is untouched
      expect((await briefRow(seoBriefId)).webdesk_site_id).toBeNull();
    });

    it("a SEO brief of another company, or one that does not exist, is 404", async () => {
      const otherClient = await createClient(B, "W4 client B");
      const pB = newId();
      await adminPool().query(`INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url) VALUES ($1,$2,$3,'b.example.com','https://b.example.com')`, [pB, B, otherClient]);
      const bB = newId();
      await adminPool().query(`INSERT INTO search_content_briefs (id, tenant_id, property_id, topic, origin_site) VALUES ($1,$2,$3,'B brief',$4)`, [bB, B, pB, config.originSite]);
      expect((await call("POST", `${site()}/briefs`, adminA, { collectionKey: "post", locale: "en", fromBriefId: bB })).statusCode).toBe(404);
      expect((await call("POST", `${site()}/briefs`, adminA, body({ propertyId: pB }))).statusCode).toBe(404);
      expect((await call("POST", `${site()}/briefs`, adminA, { collectionKey: "post", locale: "en", fromBriefId: newId() })).statusCode).toBe(404);
    });

    it("the SEO department's surface is unchanged: staff read a property brief, and a property-less writers' room brief is not found there", async () => {
      const withProperty = (await call("POST", `${site()}/briefs`, adminA, { collectionKey: "post", locale: "en", fromBriefId: seoBriefId })).json().id as string;
      const without = await fileBrief();
      const seo = (id: string) => call("GET", `/api/${A}/modules/search/briefs/${id}`, searchStaffA);
      expect((await seo(seoBriefId)).statusCode).toBe(200);
      expect((await seo(withProperty)).statusCode).toBe(200);
      expect((await seo(without)).statusCode).toBe(404);
      // and search-only staff have no door into the writers' room routes
      expect((await call("GET", `${site()}/briefs/${withProperty}`, searchStaffA)).statusCode).toBe(403);
      expect((await call("GET", `${site()}/briefs`, searchStaffA)).statusCode).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("create draft from brief", () => {
    it("creates the WebDesk item in the brief's collection and locale, sets brief_ref = the brief id, records the item on the brief, notifies the assignee", async () => {
      const id = await fileBrief({ topic: "Villa pricing explained" });
      const r = await call("POST", `${site()}/briefs/${id}/create-draft`, editorPost, { slug: "villa-pricing", fields: { h1: "Villa pricing" }, authorSub: writerOwn, dueAt: "2026-12-01" }, "idem-create-draft-1");
      expect(r.statusCode, r.body).toBe(201);
      const itemId = r.json().item.itemId as string;
      expect(zb.writes.map((w) => w.command)).toEqual(["content.create", "editorial.assign"]);
      expect(zb.writes[0].body).toMatchObject({ collectionKey: "post", locale: "en", slug: "villa-pricing" });
      expect(zb.writes[1].body).toMatchObject({ briefRef: id, authorSub: writerOwn, dueAt: "2026-12-01" });
      expect(zb.writes[0].idempotencyKey).toBe("idem-create-draft-1");
      expect(zb.writes[0].claims).toMatchObject({ sub: editorPost, cmd: "content.create" });
      expect(zb.items.get(itemId)!.editorial).toMatchObject({ briefRef: id, authorSub: writerOwn });
      expect(r.json().brief).toMatchObject({ id, itemId, assigneeId: writerOwn });
      const row = await briefRow(id);
      expect(row).toMatchObject({ webdesk_item_id: itemId, assignee_id: writerOwn });
      expect(row.linked_at).not.toBeNull();
      // the assignee is told, with ids and the brief's title only; nobody else is
      const n = await notes(writerOwn, "webdesk.brief.assigned");
      expect(n).toHaveLength(1);
      expect(n[0].payload).toMatchObject({ entityType: "search_content_brief", entityId: id, itemId, collectionKey: "post", locale: "en" });
      expect(JSON.stringify(n[0].payload)).not.toContain("villa bali"); // the target query is not in a notification
      for (const who of [editorPost, writerOther, publisherA]) expect(await notes(who)).toHaveLength(0);
    });

    it("the item's collection and locale are the BRIEF's: a body that names others is 400, and an `id` brief makes an `id` item", async () => {
      const id = await fileBrief({ locale: "id" });
      expect((await call("POST", `${site()}/briefs/${id}/create-draft`, editorPost, { slug: slug("x"), collectionKey: "guide" })).statusCode).toBe(400);
      expect((await call("POST", `${site()}/briefs/${id}/create-draft`, editorPost, { slug: slug("x"), locale: "en" })).statusCode).toBe(400);
      expect(zb.writes).toHaveLength(0);
      const ok = await call("POST", `${site()}/briefs/${id}/create-draft`, editorPost, { slug: slug("x") });
      expect(ok.statusCode, ok.body).toBe(201);
      expect(zb.writes[0].body).toMatchObject({ collectionKey: "post", locale: "id" });
    });

    for (const [name, who] of [["a writer", () => writerOwn], ["an SEO reviewer", () => seoA], ["an editor of another collection", () => editorGuide], ["an editor of another locale", () => editorPostEn]] as const) {
      it(`${name}: 403 with a valid body, nothing created in WebDesk, the brief stays unlinked`, async () => {
        const id = await fileBrief({ locale: name === "an editor of another locale" ? "id" : "en" });
        const r = await call("POST", `${site()}/briefs/${id}/create-draft`, who(), { slug: slug("denied") });
        expect(r.statusCode, r.body).toBe(403);
        expect(zb.writes).toHaveLength(0);
        expect((await briefRow(id)).webdesk_item_id).toBeNull();
        expect((await call("POST", `${site()}/briefs/${id}/create-draft`, editorAll, { slug: slug("ok") })).statusCode).toBe(201); // positive control
      });
    }

    it("a second draft from a linked brief is 409 and creates nothing", async () => {
      const { briefId } = await draftFor(writerOwn);
      zb.calls.length = 0;
      const r = await call("POST", `${site()}/briefs/${briefId}/create-draft`, editorPost, { slug: slug("again") });
      expect(r.statusCode).toBe(409);
      expect(zb.writes).toHaveLength(0);
    });

    it("WebDesk's typed problems pass through (409 slug-taken) and the brief stays unlinked", async () => {
      const id = await fileBrief();
      zb.seedItem({ siteId: GAIADA_SITE, slug: "taken", collectionKey: "post", locale: "en" });
      const r = await call("POST", `${site()}/briefs/${id}/create-draft`, editorPost, { slug: "taken" });
      expect(r.statusCode).toBe(409);
      expect(r.json().type).toMatch(/slug-taken$/);
      expect((await briefRow(id)).webdesk_item_id).toBeNull();
      expect(await notes(writerOwn)).toHaveLength(0);
    });

    it("a brief of another site or company is a uniform 404 (no question asked); an unknown id too", async () => {
      expect((await call("POST", `${site()}/briefs/${newId()}/create-draft`, platformAdmin, { slug: slug("x") })).statusCode).toBe(404);
      expect((await call("POST", `${site()}/briefs/not-a-uuid/create-draft`, platformAdmin, { slug: slug("x") })).statusCode).toBe(404);
      const id = await fileBrief();
      const wrong = `/api/${B}/modules/webdev/content/sites/${GAIADA_SLUG}/${GAIADA_SITE}/briefs/${id}/create-draft`;
      expect([403, 404]).toContain((await call("POST", wrong, platformAdmin, { slug: slug("x") })).statusCode);
      expect((await briefRow(id)).webdesk_item_id).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("assign a brief to an existing item", () => {
    const seedItem = (collectionKey = "post", locale = "en", authorSub: string | null = null) =>
      zb.seedItem({ siteId: GAIADA_SITE, slug: slug("existing"), collectionKey, locale, editorial: { reviewRequired: false, state: "draft", approvedVersion: null, authorSub, submittedVersion: null } });

    it("links brief and item both ways, assigns the author, notifies; a writer cannot", async () => {
      const id = await fileBrief();
      const it0 = seedItem();
      const url = `${site()}/briefs/${id}/assign`;
      expect((await call("POST", url, writerOwn, { itemId: it0.itemId, authorSub: writerOwn })).statusCode).toBe(403);
      expect(zb.writes).toHaveLength(0);
      const r = await call("POST", url, editorPost, { itemId: it0.itemId, authorSub: writerOwn, plannedPublishAt: "2026-12-20" });
      expect(r.statusCode, r.body).toBe(200);
      expect(zb.writes.map((w) => w.command)).toEqual(["editorial.assign"]);
      expect(zb.writes[0].body).toMatchObject({ briefRef: id, authorSub: writerOwn, plannedPublishAt: "2026-12-20" });
      expect(zb.items.get(it0.itemId)!.editorial).toMatchObject({ briefRef: id, authorSub: writerOwn });
      expect(await briefRow(id)).toMatchObject({ webdesk_item_id: it0.itemId, assignee_id: writerOwn });
      expect(await notes(writerOwn, "webdesk.brief.assigned")).toHaveLength(1);
    });

    it("an item in another collection or locale is 409 and nothing is written; an item that holds ANOTHER brief is 409", async () => {
      const id = await fileBrief();
      const wrongCollection = seedItem("guide");
      expect((await call("POST", `${site()}/briefs/${id}/assign`, editorAll, { itemId: wrongCollection.itemId })).statusCode).toBe(409);
      const wrongLocale = seedItem("post", "id");
      expect((await call("POST", `${site()}/briefs/${id}/assign`, editorAll, { itemId: wrongLocale.itemId })).statusCode).toBe(409);
      expect(zb.writes).toHaveLength(0);
      const first = await draftFor(writerOwn);
      const second = await fileBrief();
      expect((await call("POST", `${site()}/briefs/${second}/assign`, editorPost, { itemId: first.itemId })).statusCode).toBe(409);
      expect(zb.writes.map((w) => w.command)).toEqual(["content.create", "editorial.assign"]); // only the first draft's two
    });

    it("an unknown item is WebDesk's 404; an item the caller may not assign is 403 (an editor of another collection)", async () => {
      const id = await fileBrief();
      expect((await call("POST", `${site()}/briefs/${id}/assign`, editorPost, { itemId: newId() })).statusCode).toBe(404);
      const guideItem = seedItem("guide");
      expect((await call("POST", `${site()}/briefs/${id}/assign`, editorGuide, { itemId: guideItem.itemId })).statusCode).toBe(403); // the brief is a `post` brief
    });

    it("authorization first: a denied caller with an invalid body is 403", async () => {
      const id = await fileBrief();
      expect((await call("POST", `${site()}/briefs/${id}/assign`, writerOwn, { nonsense: 1 })).statusCode).toBe(403);
      expect((await call("POST", `${site()}/briefs/${id}/assign`, editorPost, { nonsense: 1 })).statusCode).toBe(400);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("reads: a scoped writer reads ONLY the briefs of items assigned to them", () => {
    it("the brief of an item: the assigned writer 200 (no provenance, no search property); another writer 403; the editor, SEO reviewer and staff 200", async () => {
      const { briefId, itemId } = await draftFor(writerOwn);
      const url = `${site()}/items/${itemId}/brief`;
      const own = await call("GET", url, writerOwn);
      expect(own.statusCode, own.body).toBe(200);
      expect(own.json()).toMatchObject({ id: briefId, targetQuery: "villa bali", searchIntent: "commercial", aiQuestions: ["Is a villa cheaper than a hotel?"], contentGaps: ["no pricing section"], itemId });
      expect(own.json().provenance).toBeUndefined();
      expect((await call("GET", url, writerOther)).statusCode).toBe(403);
      expect((await call("GET", url, editorGuide)).statusCode).toBe(403); // other collection
      for (const who of [editorPost, seoA, staffA, publisherA, platformAdmin]) expect((await call("GET", url, who)).statusCode, who).toBe(200);
      expect((await call("GET", url, editorPost)).json().provenance).toMatchObject({ createdBy: editorPost });
    });

    it("the brief by id follows the same rule; an UNLINKED brief is for managers only (403 for the writer)", async () => {
      const { briefId } = await draftFor(writerOwn);
      const unlinked = await fileBrief();
      expect((await call("GET", `${site()}/briefs/${briefId}`, writerOwn)).statusCode).toBe(200);
      expect((await call("GET", `${site()}/briefs/${briefId}`, writerOther)).statusCode).toBe(403);
      expect((await call("GET", `${site()}/briefs/${unlinked}`, writerOwn)).statusCode).toBe(403);
      expect((await call("GET", `${site()}/briefs/${unlinked}`, editorPost)).statusCode).toBe(200);
      expect((await call("GET", `${site()}/briefs/${unlinked}`, staffA)).statusCode).toBe(403); // unscoped staff keep the search routes, not these
      expect((await call("GET", `${site()}/briefs/${unlinked}`, editorGuide)).statusCode).toBe(403);
    });

    it("an item with no brief is 404 for an allowed caller", async () => {
      const bare = zb.seedItem({ siteId: GAIADA_SITE, slug: slug("bare"), collectionKey: "post", locale: "en", editorial: { reviewRequired: false, state: "draft", approvedVersion: null, authorSub: writerOwn, submittedVersion: null } });
      expect((await call("GET", `${site()}/items/${bare.itemId}/brief`, writerOwn)).statusCode).toBe(404);
    });

    it("WebDesk must confirm the link: a cleared or forged brief_ref gives the writer a 404 and the editor still reads it", async () => {
      const { briefId, itemId } = await draftFor(writerOwn);
      zb.items.get(itemId)!.editorial!.briefRef = null;
      expect((await call("GET", `${site()}/items/${itemId}/brief`, writerOwn)).statusCode).toBe(404);
      expect((await call("GET", `${site()}/briefs/${briefId}`, writerOwn)).statusCode).toBe(404);
      expect((await call("GET", `${site()}/briefs/${briefId}`, editorPost)).statusCode).toBe(200);
      // an editor pointing an item's brief_ref at ANOTHER brief through the generic assign route links nothing on the ERP side
      const other = await fileBrief({ topic: "A different brief" });
      expect((await call("POST", `${site()}/items/${itemId}/editorial/assign`, editorPost, { briefRef: other })).statusCode).toBe(200);
      expect((await call("GET", `${site()}/items/${itemId}/brief`, writerOwn)).statusCode).toBe(404);
      expect((await call("GET", `${site()}/briefs/${other}`, writerOwn)).statusCode).toBe(403); // unlinked: managers only
    });

    it("reassigning the item through the generic assign route moves the read right and the stored assignee; the old writer loses it", async () => {
      const { briefId, itemId } = await draftFor(writerOwn);
      expect((await call("GET", `${site()}/items/${itemId}/brief`, writerOwn)).statusCode).toBe(200);
      expect((await call("POST", `${site()}/items/${itemId}/editorial/assign`, editorPost, { authorSub: writerOther })).statusCode).toBe(200);
      expect((await briefRow(briefId)).assignee_id).toBe(writerOther);
      expect((await call("GET", `${site()}/items/${itemId}/brief`, writerOwn)).statusCode).toBe(403);
      expect((await call("GET", `${site()}/items/${itemId}/brief`, writerOther)).statusCode).toBe(200);
      expect((await call("GET", `${site()}/briefs`, writerOwn)).json().briefs).toHaveLength(0);
      expect((await call("GET", `${site()}/briefs`, writerOther)).json().briefs.map((b: { id: string }) => b.id)).toEqual([briefId]);
    });

    it("a stale stored assignee grants nothing: the DB says writerOwn, WebDesk says writerOther -> writerOwn's list is empty and the item read is 403", async () => {
      const { briefId, itemId } = await draftFor(writerOwn);
      zb.items.get(itemId)!.editorial!.authorSub = writerOther; // WebDesk changed it; the ERP mirror was not told
      expect((await briefRow(briefId)).assignee_id).toBe(writerOwn);
      expect((await call("GET", `${site()}/briefs`, writerOwn)).json().briefs).toHaveLength(0);
      expect((await call("GET", `${site()}/items/${itemId}/brief`, writerOwn)).statusCode).toBe(403);
      expect((await call("GET", `${site()}/briefs/${briefId}`, writerOwn)).statusCode).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the writers' board list", () => {
    it("a manager sees every brief of the collections it manages; a writer only the linked ones assigned to it; the SEO reviewer and staff the linked ones; another collection's editor none", async () => {
      const mine = await draftFor(writerOwn);
      const theirs = await draftFor(writerOther);
      const unlinked = await fileBrief();
      const ids = async (who: string) => ((await call("GET", `${site()}/briefs`, who)).json().briefs as Array<{ id: string }>).map((b) => b.id).sort();
      expect(await ids(editorPost)).toEqual([mine.briefId, theirs.briefId, unlinked].sort());
      expect(await ids(editorAll)).toEqual([mine.briefId, theirs.briefId, unlinked].sort());
      expect(await ids(publisherA)).toEqual([mine.briefId, theirs.briefId, unlinked].sort());
      expect(await ids(writerOwn)).toEqual([mine.briefId]);
      expect(await ids(writerOther)).toEqual([theirs.briefId]);
      expect(await ids(seoA)).toEqual([mine.briefId, theirs.briefId].sort());
      expect(await ids(staffA)).toEqual([mine.briefId, theirs.briefId].sort());
      expect(await ids(editorGuide)).toEqual([]);
      const own = (await call("GET", `${site()}/briefs`, writerOwn)).json().briefs[0];
      expect(own).toMatchObject({ canManage: false, itemId: mine.itemId });
      expect(own).not.toHaveProperty("body");
      expect((await call("GET", `${site()}/briefs`, editorPost)).json().briefs[0].canManage).toBe(true);
      expect(zb.writes.map((w) => w.command).filter((c) => c !== "content.create" && c !== "editorial.assign")).toEqual([]);
    });

    it("a locale-scoped editor manages only its locale; the other locale's brief is not in its list", async () => {
      const en = await fileBrief({ locale: "en" }, () => editorAll);
      const id = await fileBrief({ locale: "id" }, () => editorAll);
      const ids = ((await call("GET", `${site()}/briefs`, editorPostEn)).json().briefs as Array<{ id: string }>).map((b) => b.id);
      expect(ids).toEqual([en]);
      expect(ids).not.toContain(id);
    });

    it("filters and keyset pagination: no gaps, no repeats, a cursor that is forged is 400", async () => {
      const made: string[] = [];
      for (let i = 0; i < 5; i++) made.push(await fileBrief({ collectionKey: i === 4 ? "guide" : "post" }, () => editorAll));
      const seen: string[] = [];
      let cursor = "";
      for (let page = 0; page < 6; page++) {
        const r = await call("GET", `${site()}/briefs?limit=2${cursor ? `&cursor=${cursor}` : ""}`, editorAll);
        expect(r.statusCode, r.body).toBe(200);
        const j = r.json();
        seen.push(...j.briefs.map((b: { id: string }) => b.id));
        if (!j.page.hasMore) break;
        cursor = j.page.cursor;
      }
      expect(seen.sort()).toEqual([...made].sort());
      expect(new Set(seen).size).toBe(5);
      const guide = (await call("GET", `${site()}/briefs?collectionKey=guide`, editorAll)).json().briefs;
      expect(guide).toHaveLength(1);
      expect((await call("GET", `${site()}/briefs?linked=true`, editorAll)).json().briefs).toHaveLength(0);
      expect((await call("GET", `${site()}/briefs?cursor=garbage`, editorAll)).statusCode).toBe(400);
      expect((await call("GET", `${site()}/briefs?siteId=x`, editorAll)).statusCode).toBe(400);
    });

    it("cross-company: company B's editor sees none of A's briefs, on its own site or on A's", async () => {
      await fileBrief();
      const own = await call("GET", `/api/${B}/modules/webdev/content/sites/othertenant/${OTHER_SITE}/briefs`, editorB);
      expect(own.statusCode, own.body).toBe(200);
      expect(own.json().briefs).toEqual([]);
      expect((await call("GET", `/api/${B}/modules/webdev/content/sites/${GAIADA_SLUG}/${GAIADA_SITE}/briefs`, editorB)).statusCode).toBe(403);
    });

    it("a WebDesk outage during the list is a 5xx, never a shorter list", async () => {
      await draftFor(writerOwn);
      const { WebdeskControlTransportError } = await import("./webdesk-control-client");
      zb.failWith = new WebdeskControlTransportError("down", 1, true, "ECONNRESET");
      const r = await call("GET", `${site()}/briefs`, writerOwn);
      expect(r.statusCode).toBeGreaterThanOrEqual(500);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("edit", () => {
    it("the scoped editor edits (PATCH), a writer cannot (403 with a valid body), and the link fields cannot be touched", async () => {
      const id = await fileBrief();
      expect((await call("PATCH", `${site()}/briefs/${id}`, writerOwn, { status: "approved" })).statusCode).toBe(403);
      expect((await briefRow(id)).status).toBe("draft");
      const r = await call("PATCH", `${site()}/briefs/${id}`, editorPost, { status: "approved", contentGaps: ["a", "b"], geoNotes: null });
      expect(r.statusCode, r.body).toBe(200);
      expect(await briefRow(id)).toMatchObject({ status: "approved", content_gaps: ["a", "b"], collection_key: "post", webdesk_site_id: GAIADA_SITE });
      for (const k of ["collectionKey", "locale", "itemId", "assigneeId", "siteId"]) expect((await call("PATCH", `${site()}/briefs/${id}`, editorPost, { [k]: "x" })).statusCode, k).toBe(400);
      expect((await call("PATCH", `${site()}/briefs/${id}`, editorGuide, { status: "draft" })).statusCode).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the table: FORCE RLS stays, the zero-row trap, and the new constraints (migration 202610122300)", () => {
    it("RLS is still ENABLED and FORCED with the one tenant_isolation policy", async () => {
      const { rows } = await adminPool().query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'search_content_briefs'`);
      expect(rows[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      const pol = await adminPool().query(`SELECT policyname FROM pg_policies WHERE tablename = 'search_content_briefs'`);
      expect(pol.rows.map((r) => r.policyname)).toEqual(["tenant_isolation"]);
    });

    it("an UNSET tenant GUC reads ZERO rows, so does a tenant with no `search` module scope, and another tenant; only (right tenant + search scope) reads them", async () => {
      const id = await fileBrief();
      const total = Number((await adminPool().query(`SELECT count(*) AS n FROM search_content_briefs WHERE id = $1`, [id])).rows[0].n);
      expect(total).toBe(1);
      const unset = await withGlobal((c) => c.query(`SELECT id FROM search_content_briefs WHERE id = $1`, [id]));
      expect(unset.rows).toHaveLength(0);
      const noScope = await withTenants([A], (c) => c.query(`SELECT id FROM search_content_briefs WHERE id = $1`, [id]));
      expect(noScope.rows).toHaveLength(0);
      const other = await withTenants([B], (c) => c.query(`SELECT id FROM search_content_briefs WHERE id = $1`, [id]), { modules: ["search"] });
      expect(other.rows).toHaveLength(0);
      const ok = await withTenants([A], (c) => c.query(`SELECT id FROM search_content_briefs WHERE id = $1`, [id]), { modules: ["search"] });
      expect(ok.rows).toHaveLength(1);
      // a write in the wrong tenant is refused, not silently dropped
      await expect(
        withTenants([B], (c) => c.query(`UPDATE search_content_briefs SET topic = 'x' WHERE id = $1 RETURNING id`, [id]).then((r) => { if (r.rowCount === 0) throw new Error("zero rows"); }), { modules: ["search"] }),
      ).rejects.toThrow("zero rows");
    });

    const insert = (cols: Record<string, unknown>) => {
      const all = { id: newId(), tenant_id: A, topic: "t", origin_site: config.originSite, ...cols };
      const keys = Object.keys(all);
      return adminPool().query(`INSERT INTO search_content_briefs (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(all));
    };

    it("property_id is nullable and a plain SEO brief (the old column set) still inserts", async () => {
      await insert({});
      await insert({ property_id: propertyId });
    });

    it("the WebDesk link is all-or-none", async () => {
      await expect(insert({ webdesk_site_id: GAIADA_SITE })).rejects.toThrow(/chk_scb_webdesk_link/);
      await expect(insert({ collection_key: "post" })).rejects.toThrow(/chk_scb_webdesk_link/);
      await expect(insert({ webdesk_item_id: newId(), linked_at: new Date() })).rejects.toThrow(/chk_scb_webdesk_link/);
      await insert({ webdesk_site_id: GAIADA_SITE, webdesk_tenant_slug: GAIADA_SLUG, collection_key: "post", locale: "en" });
    });

    it("one brief per item, and an item needs its link stamp", async () => {
      const link = { webdesk_site_id: GAIADA_SITE, webdesk_tenant_slug: GAIADA_SLUG, collection_key: "post", locale: "en" };
      const item = newId();
      await insert({ ...link, webdesk_item_id: item, linked_at: new Date() });
      await expect(insert({ ...link, webdesk_item_id: item, linked_at: new Date() })).rejects.toThrow(/ux_search_content_briefs_item/);
      await expect(insert({ ...link, webdesk_item_id: newId() })).rejects.toThrow(/chk_scb_item_needs_stamp/);
      // a soft-deleted brief frees the item
      await adminPool().query(`UPDATE search_content_briefs SET deleted_at = now() WHERE webdesk_item_id = $1`, [item]);
      await insert({ ...link, webdesk_item_id: item, linked_at: new Date() });
    });

    it("intent, list sizes and shapes are bounded by CHECKs", async () => {
      await expect(insert({ search_intent: "nope" })).rejects.toThrow(/chk_scb_search_intent/);
      await expect(insert({ ai_questions: JSON.stringify(Array.from({ length: 51 }, () => "q")) })).rejects.toThrow(/chk_scb_ai_questions/);
      await expect(insert({ content_gaps: JSON.stringify({ a: 1 }) })).rejects.toThrow(/chk_scb_content_gaps/);
      await expect(insert({ target_query: "" })).rejects.toThrow(/chk_scb_target_query/);
      await insert({ search_intent: "informational", ai_questions: JSON.stringify(["q"]), content_gaps: JSON.stringify([]) });
    });
  });
});
