// M5-W1c — the two-phase gate over the REAL surface: HTTP (`app.inject`), the real Cerbos with the W1a policies, the real
// principal assembly (a writers' room grant's scope rows from Postgres), the real content service. Stand-in: Zone B, the
// in-process FakeZoneB (it records every call, so "WebDesk received no write" is asserted on what was actually sent).
//
// What this adds to the unit file (webdesk-content-two-phase.unit.test.ts, whose Cerbos is a stub): the real policies decide the
// requests the real transport builds, and `allowed` equals a DIRECT Cerbos answer for the same principal and resource.
//
// Every denial sends a VALID body and sits beside a positive control (same request, an allowed principal, 2xx), so a denial is
// authorization and not validation. Needs DATABASE_URL_TEST + CERBOS_URL; the test Cerbos must have been restarted on the W1a
// policies. NOT RUN LOCALLY (owner order: no docker on the laptop); it runs on the Linux gate (CI).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { assemblePrincipal } from "../../rbac/principal";
import { checkActions } from "../../rbac/cerbos";
import { setWebdeskApprovedCommandDepsForTests } from "./webdesk-approved-command";
import { ITEM_ALLOWED_ACTIONS, webdeskZoneB } from "./webdesk-content.service";
import { setPreviewProbeForTests } from "./webdesk-preview";
import { FakeZoneB, GAIADA_SITE, GAIADA_SLUG, makeTestSigner, type FakeItem } from "./webdesk-content-testkit";

// A pass-through spy on the platform's Cerbos gate: the forged-value tests assert on what the policy was actually ASKED.
const authCalls = vi.hoisted(() => [] as Array<{ resource: Record<string, unknown>; action: string }>);
vi.mock("../../core/http", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../core/http")>();
  return {
    ...real,
    authorize: (async (principal: never, resource: never, action: never) => {
      authCalls.push({ resource: { ...(resource as Record<string, unknown>) }, action: action as string });
      return (real.authorize as (...a: unknown[]) => Promise<unknown>)(principal, resource, action);
    }) as typeof real.authorize,
  };
});

const live = !!TEST_URL && !!process.env.CERBOS_URL;
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const SITE2 = "7a7a7a7a-3d4a-4b5c-8d6e-7f8091a2b3c4";

describe.skipIf(!live)("M5-W1c · the two-phase gate over HTTP, real Cerbos", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  let adminA: string, publisherA: string, staffA: string, memberA: string;
  let writerA: string, otherAuthor: string, translatorA: string, seoA: string, editorialEditorA: string, writerSite2: string;
  let zb: FakeZoneB;
  const signer = makeTestSigner();

  const base = () => `/api/${A}/modules/webdev/content`;
  const site = (slug = GAIADA_SLUG, siteId = GAIADA_SITE) => `${base()}/sites/${slug}/${siteId}`;
  const call = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, as: string, payload?: unknown) =>
    app.inject({ method, url, headers: asUser(as), ...(payload !== undefined ? { payload: payload as never } : {}) });
  const approvals = async () =>
    (await adminPool().query(`SELECT id FROM automation_approvals WHERE tenant_id = $1 AND origin = 'webdesk'`, [A])).rows.length;

  /** Grant an editorial role at company scope with ONE scope row (the grant path itself is W1b's; this is its data). */
  async function editorial(userId: string, role: string, siteId: string, collections: string[] | "all", locales: string[] | "all") {
    const roleId = await createRole(role);
    await grantRole(userId, roleId, "company", A);
    const g = (await adminPool().query(`SELECT id FROM user_roles WHERE user_id = $1 AND role_id = $2`, [userId, roleId])).rows[0].id;
    await adminPool().query(
      `INSERT INTO user_role_editorial_scopes (user_role_id, tenant_id, webdesk_tenant_slug, site_id, all_collections, collections, all_locales, locales, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [g, A, siteId === SITE2 ? "second" : GAIADA_SLUG, siteId, collections === "all", collections === "all" ? [] : collections, locales === "all", locales === "all" ? [] : locales, config.originSite],
    );
  }

  const seed = (slug: string, author: string | null, state: string, over: Partial<FakeItem> = {}): FakeItem =>
    zb.seedItem({
      siteId: GAIADA_SITE, slug, collectionKey: "post", locale: "en",
      editorial: { reviewRequired: false, state, approvedVersion: state === "approved" ? 1 : null, authorSub: author, submittedVersion: state === "in_review" ? 1 : null },
      ...over,
    });
  const update = (it: FakeItem) => ({ baseVersion: it.headVersion, fields: { h1: "edited" } });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    A = await createCompany("W1c Co A", ["webdev"]);
    B = await createCompany("W1c Co B", ["webdev"]);
    const mk = async (email: string, role: string) => {
      const id = await createUser(email);
      await addMembership(A, id);
      await grantRole(id, await createRole(role), "company", A);
      return id;
    };
    adminA = await mk("admin@w1c.test", "company_admin");
    publisherA = await mk("publisher@w1c.test", "webdev_manager");
    staffA = await mk("staff@w1c.test", "webdev_staff");
    memberA = await mk("member@w1c.test", "member");
    writerA = await mk("writer@w1c.test", "member");
    otherAuthor = await mk("other-author@w1c.test", "member");
    translatorA = await mk("translator@w1c.test", "member");
    seoA = await mk("seo@w1c.test", "member");
    editorialEditorA = await mk("editorial-editor@w1c.test", "member");
    writerSite2 = await mk("writer-site2@w1c.test", "member");
    await editorial(writerA, "webdesk_writer", GAIADA_SITE, ["post"], ["en"]);
    await editorial(translatorA, "webdesk_translator", GAIADA_SITE, ["post"], ["id"]);
    await editorial(seoA, "webdesk_seo_reviewer", GAIADA_SITE, "all", "all");
    await editorial(editorialEditorA, "webdesk_editor", GAIADA_SITE, "all", "all");
    await editorial(writerSite2, "webdesk_writer", SITE2, "all", "all");
    zb = new FakeZoneB(A, B);
    zb.tenants.push({ companyRef: A, slug: "second", status: "active", siteId: SITE2 });
    zb.compositions.set("post", { ui: { label: "Posts" } });
    zb.compositions.set("guide", { ui: { label: "Guides" } });
    app = await buildApp();
  }, 120_000);

  beforeEach(async () => {
    zb.reset();
    authCalls.length = 0;
    signer.calls.length = 0;
    webdeskZoneB.clearSiteCache();
    setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer });
    // A preview probe that must never be reached by a denied caller.
    setPreviewProbeForTests({ fetchImpl: (async () => { throw new Error("the site must not be probed for a denied caller"); }) as unknown as typeof fetch, now: () => Date.now() });
    await adminPool().query(`DELETE FROM automation_approvals WHERE tenant_id = $1 AND origin = 'webdesk'`, [A]);
  });
  afterEach(() => {
    setWebdeskApprovedCommandDepsForTests(null);
    setPreviewProbeForTests(null);
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("acceptance 1: a writer's PUT on another author's item is 403 with a VALID body, and WebDesk receives no write", () => {
    it("update: another author's item 403 / the writer's own 200 / the staff editor 200 (staff unchanged)", async () => {
      const theirs = seed("post.theirs", otherAuthor, "draft");
      const mine = seed("post.mine", writerA, "draft");
      const denied = await call("PUT", `${site()}/items/${theirs.itemId}`, writerA, update(theirs));
      expect(denied.statusCode, denied.body).toBe(403);
      expect(zb.writes).toHaveLength(0);
      expect(signer.calls).toHaveLength(0);
      // positive controls: the identical request by the item's author, and by the unscoped staff editor
      expect((await call("PUT", `${site()}/items/${mine.itemId}`, writerA, update(mine))).statusCode).toBe(200);
      expect((await call("PUT", `${site()}/items/${theirs.itemId}`, staffA, update(theirs))).statusCode).toBe(200);
      expect(zb.writes.map((w) => w.command)).toEqual(["content.update", "content.update"]);
    });

    it("restore and preview of another author's item are refused the same way (preview never probes the site)", async () => {
      const theirs = seed("post.theirs-r", otherAuthor, "draft");
      expect((await call("POST", `${site()}/items/${theirs.itemId}/restore`, writerA, { version: 1, baseVersion: 1 })).statusCode).toBe(403);
      expect((await call("POST", `${site()}/items/${theirs.itemId}/preview`, writerA, {})).statusCode).toBe(403);
      expect(zb.writes).toHaveLength(0);
      expect((await call("POST", `${site()}/items/${theirs.itemId}/restore`, staffA, { version: 1, baseVersion: 1 })).statusCode).toBe(200);
    });

    it("an item in review is not the writer's to edit even when theirs; changes_requested is", async () => {
      const it0 = seed("post.review", writerA, "in_review");
      expect((await call("PUT", `${site()}/items/${it0.itemId}`, writerA, update(it0))).statusCode).toBe(403);
      expect(zb.writes).toHaveLength(0);
      it0.editorial = { reviewRequired: true, state: "changes_requested", approvedVersion: null, authorSub: writerA, submittedVersion: 1 };
      expect((await call("PUT", `${site()}/items/${it0.itemId}`, writerA, update(it0))).statusCode).toBe(200);
    });

    it("the SEO reviewer edits only while the item is in review; the editorial editor edits in scope", async () => {
      const draft = seed("post.seo-draft", writerA, "draft");
      const inReview = seed("post.seo-review", writerA, "in_review");
      expect((await call("PUT", `${site()}/items/${draft.itemId}`, seoA, update(draft))).statusCode).toBe(403);
      expect(zb.writes).toHaveLength(0);
      expect((await call("PUT", `${site()}/items/${inReview.itemId}`, seoA, update(inReview))).statusCode).toBe(200);
      expect((await call("PUT", `${site()}/items/${draft.itemId}`, editorialEditorA, update(draft))).statusCode).toBe(200);
    });

    it("unpublish and delete stay the publisher tier: a writer and the staff editor are 403 with valid bodies, the publisher 200", async () => {
      const liveItem = seed("post.live", writerA, "draft", { publishedVersion: 1, publishState: "published" });
      const gone = seed("post.gone", writerA, "draft");
      for (const who of [writerA, staffA]) {
        expect((await call("POST", `${site()}/items/${liveItem.itemId}/unpublish`, who, { expectedPublishedVersion: 1 })).statusCode).toBe(403);
        expect((await call("POST", `${site()}/items/${gone.itemId}/delete`, who, { baseVersion: 1 })).statusCode).toBe(403);
      }
      expect(zb.writes).toHaveLength(0);
      expect((await call("POST", `${site()}/items/${gone.itemId}/delete`, publisherA, { baseVersion: 1 })).statusCode).toBe(200);
    });

    it("create: in scope 201; a locale or a collection outside the grant 403 with no write; the translator needs an approved or live source", async () => {
      const body = { locale: "en", slug: "post.new", fields: { h1: "a" } };
      expect((await call("POST", `${site()}/collections/post/items`, writerA, { ...body, locale: "id", slug: "post.new-id" })).statusCode).toBe(403);
      expect((await call("POST", `${site()}/collections/guide/items`, writerA, body)).statusCode).toBe(403);
      expect(zb.writes).toHaveLength(0);
      expect((await call("POST", `${site()}/collections/post/items`, writerA, body)).statusCode).toBe(201);

      const twin = (src: FakeItem, slug: string) => ({ locale: "id", slug, twinOf: src.itemId, fields: { h1: "x" } });
      zb.reset(); // (items are re-seeded below)
      const approved2 = seed("post.src-ok2", otherAuthor, "approved");
      const draft2 = seed("post.src-draft2", otherAuthor, "draft");
      expect((await call("POST", `${site()}/collections/post/items`, translatorA, twin(draft2, "post.t-draft"))).statusCode).toBe(403);
      expect((await call("POST", `${site()}/collections/post/items`, translatorA, { locale: "id", slug: "post.t-fresh", fields: {} })).statusCode).toBe(403);
      expect(zb.writes).toHaveLength(0);
      expect((await call("POST", `${site()}/collections/post/items`, translatorA, twin(approved2, "post.t-ok"))).statusCode).toBe(201);
    });

    it("publish requests: a writer is 403 with a valid body (and with an invalid one: authorization first); the scoped editor files one", async () => {
      const it0 = seed("post.pub", writerA, "draft");
      const valid = { items: [{ itemId: it0.itemId, version: 1 }] };
      expect((await call("POST", `${site()}/publish-requests`, writerA, valid)).statusCode).toBe(403);
      expect((await call("POST", `${site()}/publish-requests`, writerA, { items: "nope" })).statusCode).toBe(403);
      expect(await approvals()).toBe(0);
      expect((await call("POST", `${site()}/publish-requests`, staffA, { items: "nope" })).statusCode).toBe(400);
      expect((await call("POST", `${site()}/publish-requests`, editorialEditorA, valid)).statusCode).toBe(202);
      expect(await approvals()).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("acceptance 2: body or query cannot set siteId, collectionKey, locale, ownerId or reviewState", () => {
    const FORGED = { siteId: "forged-site", collectionKey: "guide", locale: "id", ownerId: "forged-owner", reviewState: "draft", creatorId: "forged-creator" };

    it("a forged body on the owner's own update is a 400 (after the check), writes nothing, and Cerbos was asked with WebDesk's values", async () => {
      const mine = seed("post.forge", writerA, "draft");
      const r = await call("PUT", `${site()}/items/${mine.itemId}`, writerA, { ...update(mine), ...FORGED });
      expect(r.statusCode, r.body).toBe(400);
      expect(zb.writes).toHaveLength(0);
      const asks = authCalls.filter((c) => c.resource.kind === "webdesk_content_item" && c.action === "update");
      expect(asks.at(-1)!.resource).toMatchObject({ siteId: GAIADA_SITE, collectionKey: "post", locale: "en", ownerId: writerA, reviewState: "draft" });
      expect(JSON.stringify(authCalls)).not.toContain("forged-");
      // positive control: the same body without the forged keys
      expect((await call("PUT", `${site()}/items/${mine.itemId}`, writerA, update(mine))).statusCode).toBe(200);
    });

    it("a forged owner/state does not turn another author's item into the writer's; the forged value is a 400 only for someone already allowed", async () => {
      const theirs = seed("post.forge2", otherAuthor, "in_review");
      expect((await call("PUT", `${site()}/items/${theirs.itemId}`, writerA, { ...update(theirs), ...FORGED, ownerId: writerA })).statusCode).toBe(403);
      expect((await call("PUT", `${site()}/items/${theirs.itemId}`, writerA, { ...update(theirs), reviewState: "draft" })).statusCode).toBe(403);
      expect(zb.writes).toHaveLength(0);
      expect((await call("PUT", `${site()}/items/${theirs.itemId}`, staffA, { ...update(theirs), ...FORGED })).statusCode).toBe(400);
    });

    it("a query cannot name another collection or site: the check ran on the route's key / WebDesk's item", async () => {
      const mine = seed("post.forge3", writerA, "draft");
      const list = await call("GET", `${site()}/collections/post/items?collectionKey=guide&siteId=forged-site`, writerA);
      expect(list.statusCode).toBe(400);
      expect((await call("GET", `${site()}/collections/post/items?locale=en`, writerA)).statusCode).toBe(200);
      const get = await call("GET", `${site()}/items/${mine.itemId}?collectionKey=guide&ownerId=forged-owner`, writerA);
      expect(get.statusCode).toBe(400);
      expect((await call("GET", `${site()}/items/${mine.itemId}?version=1`, writerA)).statusCode).toBe(200);
      expect(JSON.stringify(authCalls)).not.toContain("forged-");
      // a collection outside the writer's scope is denied by the ROUTE's key, whatever the query claims
      expect((await call("GET", `${site()}/collections/guide/items?collectionKey=post`, writerA)).statusCode).toBe(403);
      expect((await call("GET", `${site()}/collections/guide/items`, writerA)).statusCode).toBe(403);
      expect((await call("GET", `${site()}/collections/guide/items`, staffA)).statusCode).toBe(200);
    });

    it("create: the body's collectionKey/siteId/ownerId/reviewState are refused (400), the route key and the body locale are what is asked", async () => {
      const body = { locale: "en", slug: "post.forge-create", fields: { h1: "a" } };
      expect((await call("POST", `${site()}/collections/post/items`, writerA, { ...body, ...FORGED, locale: "en", collectionKey: "post" })).statusCode).toBe(400);
      expect((await call("POST", `${site()}/collections/post/items`, writerA, { ...body, collectionKey: "guide" })).statusCode).toBe(400);
      expect(zb.writes).toHaveLength(0);
      const asks = authCalls.filter((c) => c.resource.kind === "webdesk_content_item" && c.action === "create");
      for (const a of asks) expect(a.resource).toMatchObject({ siteId: GAIADA_SITE, collectionKey: "post", locale: "en" });
      expect(JSON.stringify(authCalls)).not.toContain("forged-");
      expect((await call("POST", `${site()}/collections/post/items`, writerA, body)).statusCode).toBe(201);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("acceptance 3: `allowed` equals a direct Cerbos answer for the same principal and resource", () => {
    const direct = async (userId: string, it0: FakeItem, creatorId = "") => {
      const principal = (await assemblePrincipal(userId, "high"))!;
      return checkActions(
        principal,
        {
          kind: "webdesk_content_item", tenantId: A, module: "webdev", id: it0.itemId, siteId: GAIADA_SITE, collectionKey: it0.collectionKey, locale: it0.locale,
          ownerId: it0.editorial?.authorSub ?? "", reviewState: it0.editorial?.state ?? "", published: it0.publishedVersion !== null, creatorId,
        },
        ITEM_ALLOWED_ACTIONS,
      );
    };

    it.each([
      ["the writer on their own draft", () => writerA, "own"],
      ["the writer on another author's draft", () => writerA, "theirs"],
      ["the SEO reviewer on an in-review item", () => seoA, "review"],
      ["the unscoped staff editor", () => staffA, "own"],
      ["the publisher", () => publisherA, "own"],
      ["the company admin", () => adminA, "theirs"],
    ])("%s", async (_label, who, which) => {
      const it0 = which === "review" ? seed("post.allowed-r", writerA, "in_review") : seed(`post.allowed-${which}`, which === "own" ? writerA : otherAuthor, "draft");
      const r = await call("GET", `${site()}/items/${it0.itemId}`, who());
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().allowed).toEqual(await direct(who(), it0));
    });

    it("approve follows maker != checker on the SUBMITTED version's creator: the editor may approve another's version, never their own", async () => {
      const others = seed("post.appr-other", writerA, "in_review");
      others.versions[0].createdBy = writerA;
      const own = seed("post.appr-own", writerA, "in_review");
      own.versions[0].createdBy = editorialEditorA;
      const a = await call("GET", `${site()}/items/${others.itemId}`, editorialEditorA);
      const b = await call("GET", `${site()}/items/${own.itemId}`, editorialEditorA);
      expect(a.json().allowed).toEqual(await direct(editorialEditorA, others, writerA));
      expect(b.json().allowed).toEqual(await direct(editorialEditorA, own, editorialEditorA));
      expect(a.json().allowed.approve).toBe(true);
      expect(b.json().allowed.approve).toBe(false);
    });

    it("a member with no grant is 403 on the read (no `allowed` to leak)", async () => {
      const it0 = seed("post.allowed-m", writerA, "draft");
      expect((await call("GET", `${site()}/items/${it0.itemId}`, memberA)).statusCode).toBe(403);
      expect((await call("GET", `${site()}/items/${it0.itemId}`, staffA)).statusCode).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("acceptance 6: GET sites returns only the sites the caller may read; staff unchanged", () => {
    const slugs = (r: { json: () => { tenants: Array<{ slug: string }> } }) => r.json().tenants.map((t) => t.slug);

    it("a writer sees its own site only, a writer of the other site sees that one, staff and admin see both, a member is 403", async () => {
      expect(slugs(await call("GET", `${base()}/sites`, writerA))).toEqual([GAIADA_SLUG]);
      expect(slugs(await call("GET", `${base()}/sites`, writerSite2))).toEqual(["second"]);
      for (const who of [staffA, publisherA, adminA]) expect(slugs(await call("GET", `${base()}/sites`, who)).sort()).toEqual([GAIADA_SLUG, "second"]);
      expect((await call("GET", `${base()}/sites`, memberA)).statusCode).toBe(403);
    });

    it("the other site's routes are refused to a writer who has no grant there (403), and open to the one who has (control)", async () => {
      expect((await call("GET", `${site("second", SITE2)}/collections`, writerA)).statusCode).toBe(403);
      expect((await call("GET", `${site("second", SITE2)}/collections`, writerSite2)).statusCode).toBe(200);
      expect((await call("GET", `${site()}/collections`, writerA)).statusCode).toBe(200);
      expect((await call("GET", `${site()}/collections`, writerSite2)).statusCode).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("media: a writers' room grant reads the media of its site and nothing more", () => {
    it("writer: list 200 (with capabilities.read true, the rest false); update 403 with a valid body; the staff editor updates", async () => {
      const asset = zb.seedMedia({ siteId: GAIADA_SITE, title: "Hero", tags: ["hero"], originalFilename: "hero.png" });
      const list = await call("GET", `${site()}/media`, writerA);
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().capabilities).toEqual({ read: true, upload: false, update: false, delete: false });
      expect((await call("PATCH", `${site()}/media/${asset.assetId}`, writerA, { title: "t" })).statusCode).toBe(403);
      expect((await call("POST", `${site()}/media/upload-token`, writerA, { bucket: "media" })).statusCode).toBe(403);
      expect(zb.writes).toHaveLength(0);
      expect((await call("PATCH", `${site()}/media/${asset.assetId}`, staffA, { title: "t" })).statusCode).toBe(200);
      expect((await call("GET", `${site("second", SITE2)}/media`, writerA)).statusCode).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("acceptance 4: the staff tiers see no behaviour change (denials before egress, authorization before validation)", () => {
    it("a denied staff caller (member, staff on a publisher action) reaches no WebDesk call at all", async () => {
      const it0 = seed("post.staff", writerA, "draft", { publishedVersion: 1, publishState: "published" });
      zb.calls.length = 0;
      expect((await call("GET", `${site()}/items/${it0.itemId}`, memberA)).statusCode).toBe(403);
      expect((await call("POST", `${site()}/items/${it0.itemId}/unpublish`, staffA, { expectedPublishedVersion: 1 })).statusCode).toBe(403);
      expect((await call("POST", `${site()}/items/${it0.itemId}/delete`, staffA, { baseVersion: 1 })).statusCode).toBe(403);
      expect(zb.calls).toHaveLength(0);
      expect((await call("POST", `${site()}/items/${it0.itemId}/unpublish`, publisherA, { expectedPublishedVersion: 1 })).statusCode).toBe(200);
    });

    it("authorization precedes validation for the scoped writer too: another's item with an INVALID body is 403, the owner's is 400", async () => {
      const theirs = seed("post.inv-t", otherAuthor, "draft");
      const mine = seed("post.inv-m", writerA, "draft");
      expect((await call("PUT", `${site()}/items/${theirs.itemId}`, writerA, { nonsense: true })).statusCode).toBe(403);
      expect((await call("PUT", `${site()}/items/${mine.itemId}`, writerA, { nonsense: true })).statusCode).toBe(400);
      expect(zb.writes).toHaveLength(0);
    });

    it("a staff editor's whole editing loop works exactly as before (read, update, restore, publish request)", async () => {
      const it0 = seed("post.loop", null, "draft");
      expect((await call("GET", `${site()}/items/${it0.itemId}`, staffA)).statusCode).toBe(200);
      expect((await call("PUT", `${site()}/items/${it0.itemId}`, staffA, update(it0))).statusCode).toBe(200);
      expect((await call("POST", `${site()}/items/${it0.itemId}/restore`, staffA, { version: 1, baseVersion: 2 })).statusCode).toBe(200);
      expect((await call("POST", `${site()}/publish-requests`, staffA, { items: [{ itemId: it0.itemId, version: 1 }] })).statusCode).toBe(202);
    });
  });
});
