// WSK-51 — the control plane's live read commands (write-plane design §4), end to end against a real
// Postgres (0001-0009, webdesk_app NOBYPASSRLS), real Redis, the real AppModule and the REAL Layer-3/4
// PolicyDecisionPoint (content-test-kit.ts). Done-when items (design §12 WSK-51):
//   (1) each read returns §4's shape against seeded data     (2) cross-tenant 404 + positive control
//   (3) tenant.list filters by companyRef                    (4) drafts, versions and lint are visible
//   (5) no `webdesk:read` -> 403, each with a scoped control (6) no audit_entries rows are written
//   (7) pagination is stable while writes run concurrently   (8) soft-deleted items: hidden by default
// plus the WSK-66 contract: item.get returns publishedVersion / publishAt / unpublishAt exactly as
// platform-nest's reconcile (webdesk-approved-command.ts reconcileByReading) reads them.
//
// Doctrine (estate memory: "validation pre-empts authz"): every 403 below is a VALID read, paired
// with a control that sends the identical request with the read scope and succeeds.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  asPlatform,
  asTenant,
  base,
  buildContentApp,
  createContentFixture,
  createItem,
  hdr,
  publishItems,
  serviceFields,
  ws4For,
  type ContentFixture,
} from "./content-test-kit";

const PROBLEM = "https://webdesk.gaiada.online/errors/";
const READ = ["webdesk:read"];
const ALL_BUT_READ = ["webdesk:operate", "webdesk:promote", "webdesk:keys"];

let app: NestFastifyApplication;

// ------------------------------------------------------------------------------------------------
// Request helpers
// ------------------------------------------------------------------------------------------------
/** A read: control principal + scopes only. No editorial principal, no idempotency key (a read needs neither). */
function rh(scopes: string[] = READ): Record<string, string> {
  return { "x-webdesk-control-principal": "erp-webdesk-control", "x-webdesk-control-scopes": scopes.join(",") };
}
const get = (url: string, scopes: string[] = READ) => app.inject({ method: "GET", url, headers: rh(scopes) });

const siteBase = (fx: ContentFixture) => `/control/v1/tenants/${fx.slug}/sites/${fx.siteId}`;
const itemsUrl = (fx: ContentFixture, key = "service", qs = "") => `${siteBase(fx)}/collections/${key}/items${qs}`;
const itemUrl = (fx: ContentFixture, id: string, qs = "") => `${base(fx)}/items/${id}${qs}`;

async function put(fx: ContentFixture, id: string, body: Record<string, unknown>, editorial = "user-editor-1") {
  const r = await app.inject({ method: "PUT", url: itemUrl(fx, id), headers: hdr({ editorial }), payload: body });
  expect(r.statusCode).toBe(200);
  return r.json();
}
async function post(fx: ContentFixture, path: string, body: Record<string, unknown>, ws4?: string) {
  return app.inject({ method: "POST", url: `${base(fx)}${path}`, headers: hdr({ ws4 }), payload: body });
}
async function draft(fx: ContentFixture, slug: string, over: Record<string, unknown> = {}, locale = "en") {
  const r = await createItem(app, fx, { collectionKey: "service", locale, slug, fields: serviceFields(), ...over });
  expect(r.statusCode).toBe(201);
  return r.json();
}
async function publish(fx: ContentFixture, id: string, version: number) {
  const r = await publishItems(app, fx, [{ itemId: id, version }]);
  expect(r.statusCode).toBe(200);
}
async function schedule(fx: ContentFixture, id: string, version: number, publishAt: string | null, unpublishAt: string | null) {
  const body: Record<string, unknown> = { items: [{ itemId: id, version }] };
  if (publishAt) body.publishAt = publishAt;
  if (unpublishAt) body.unpublishAt = unpublishAt;
  const ws4 = ws4For("content.schedule", { tenantSlug: fx.slug, siteId: fx.siteId }, body);
  const r = await post(fx, "/schedule", body, ws4);
  expect(r.statusCode).toBe(200);
}
async function unpublish(fx: ContentFixture, id: string, expectedPublishedVersion: number) {
  const r = await post(fx, `/items/${id}/unpublish`, { expectedPublishedVersion });
  expect(r.statusCode).toBe(200);
}
async function del(fx: ContentFixture, id: string, baseVersion: number) {
  const r = await post(fx, `/items/${id}/delete`, { baseVersion });
  expect(r.statusCode).toBe(200);
}
const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

async function companyRefOf(fx: ContentFixture): Promise<string> {
  return asPlatform(async (c) => (await c.query(`SELECT company_ref FROM tenants WHERE id = $1`, [fx.tenantId])).rows[0].company_ref as string);
}

/** Every audit_entries row visible to the three tenants plus the platform-level (tenant_id NULL) rows. */
async function auditTotals(fxs: ContentFixture[]): Promise<{ perTenant: number[]; platform: number }> {
  const perTenant: number[] = [];
  for (const fx of fxs) {
    perTenant.push(await asTenant(fx.tenantId, async (db) => (await db.query(`SELECT count(*)::int AS n FROM audit_entries`)).rows[0].n as number));
  }
  const platform = await asPlatform(async (c) => (await c.query(`SELECT count(*)::int AS n FROM audit_entries WHERE tenant_id IS NULL`)).rows[0].n as number);
  return { perTenant, platform };
}

async function insertMedia(fx: ContentFixture, rows: { key: string; mime: string; size: number; createdAt?: string; id?: string }[]) {
  await asTenant(fx.tenantId, async (db) => {
    for (const r of rows) {
      await db.query(
        `INSERT INTO media_assets (id, tenant_id, site_id, bucket_key, mime, size_bytes, scan_status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'clean', COALESCE($7::timestamptz, now()))`,
        [r.id ?? randomUUID(), fx.tenantId, fx.siteId, r.key, r.mime, r.size, r.createdAt ?? null],
      );
    }
  });
}

const keysOf = (o: unknown) => Object.keys(o as object).sort();

// ================================================================================================
describe("WSK-51 content reads (real DB + real PDP)", () => {
  let fxA: ContentFixture;
  let fxA2: ContentFixture; // same company as A
  let fxB: ContentFixture; // another company
  let companyA: string;
  let companyB: string;

  // seeded ids (tenant A)
  const id: Record<string, string> = {};
  let seoCreate: { item: Record<string, unknown>; version: Record<string, unknown>; lint: unknown };
  let legacyId: string;
  let itemOfB: string;
  let mediaB: string;

  beforeAll(async () => {
    app = await buildContentApp();
    fxA = await createContentFixture("rdA");
    fxA2 = await createContentFixture("rdA2");
    fxB = await createContentFixture("rdB");
    await asPlatform((c) => c.query(`UPDATE tenants SET company_ref = (SELECT company_ref FROM tenants WHERE id = $1) WHERE id = $2`, [fxA.tenantId, fxA2.tenantId]));
    companyA = await companyRefOf(fxA);
    companyB = await companyRefOf(fxB);
    expect(companyA).not.toBe(companyB);

    // ---- tenant A: one item in each state, through the real write plane --------------------------
    // service.seo (en): published v1, then edited to v2 -> head 2, live 1. Carries lint findings.
    seoCreate = await draft(fxA, "service.seo", {
      fields: serviceFields({ h1: "SEO Agency Bali", body: "# SEO\n\nResult {{RESULT_1_METRIC}} and [CONFIRM: 12 percent] and [CLIENT: quote]." }),
      seo: { description: "d1" },
      note: "first draft",
    });
    id.seo = seoCreate.item.itemId as string;
    await publish(fxA, id.seo, 1);
    await put(fxA, id.seo, { baseVersion: 1, fields: serviceFields({ h1: "SEO Agency Bali v2" }), seo: { description: "d2" }, note: "fixed the headline" });

    // service.seo (id): a twin in the same localization group, still a draft
    const twin = await draft(fxA, "service.seo-id", { twinOf: id.seo, fields: serviceFields({ h1: "SEO Agency Bali ID" }) }, "id");
    id.seoId = twin.item.itemId as string;

    id.draftOnly = (await draft(fxA, "service.draft-only", { fields: serviceFields({ h1: "Draft Only" }) })).item.itemId as string;

    id.sched = (await draft(fxA, "service.sched", { fields: serviceFields({ h1: "Scheduled Page" }) })).item.itemId as string;
    await schedule(fxA, id.sched, 1, hours(48), hours(96));

    id.unpub = (await draft(fxA, "service.unpub", { fields: serviceFields({ h1: "Takedown" }) })).item.itemId as string;
    await publish(fxA, id.unpub, 1);
    await unpublish(fxA, id.unpub, 1);

    id.gone = (await draft(fxA, "service.gone", { fields: serviceFields({ h1: "Gone" }) })).item.itemId as string;
    await del(fxA, id.gone, 1);

    // a pre-0009 row: published straight into the projection, head_version 0, no version rows
    legacyId = randomUUID();
    const collectionId = fxA.collections.service;
    await asTenant(fxA.tenantId, async (db) => {
      await db.query(
        `INSERT INTO content_items (id, tenant_id, site_id, collection_id, locale, slug, blocks, seo, publish_state)
         VALUES ($1, $2, $3, $4, 'en', 'service.legacy', $5::jsonb, '{}'::jsonb, 'published')`,
        [legacyId, fxA.tenantId, fxA.siteId, collectionId, JSON.stringify([{ type: "fields", props: { url: "/legacy/", h1: "Legacy Page" } }])],
      );
    });

    await insertMedia(fxA, [
      { key: "a/one.png", mime: "image/png", size: 1000, createdAt: "2026-01-01T00:00:01.000001Z" },
      { key: "a/two.pdf", mime: "application/pdf", size: 2000, createdAt: "2026-01-01T00:00:02.000002Z" },
      { key: "a/three.jpg", mime: "image/jpeg", size: 3000, createdAt: "2026-01-01T00:00:03.000003Z" },
    ]);

    // ---- tenant B -------------------------------------------------------------------------------
    itemOfB = (await draft(fxB, "service.b-only", { fields: serviceFields({ h1: "B Only" }) })).item.itemId as string;
    await insertMedia(fxB, [{ key: "b/secret.png", mime: "image/png", size: 5 }]);
    mediaB = "b/secret.png";
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  // ==============================================================================================
  // (1) §4's shapes against seeded data
  // ==============================================================================================
  describe("(1) shapes (design §4)", () => {
    it("collection.list: composition, vocabularyVersion, counts {items, byLocale, live, pendingChanges}, updatedAt", async () => {
      const r = await get(`${siteBase(fxA)}/collections`);
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(keysOf(body)).toEqual(["collections"]);
      expect(body.collections.map((c: { key: string }) => c.key)).toEqual(["company", "navigation", "redirect", "service", "token-registry"]);
      const service = body.collections.find((c: { key: string }) => c.key === "service");
      expect(keysOf(service)).toEqual(["composition", "counts", "key", "updatedAt", "vocabularyVersion"]);
      expect(service.vocabularyVersion).toBe("1.5.0"); // M5-V5-a (1.4.0 was M5-W8b, 1.3.0 M5-W3c, 1.2.0 was WSK-49a, 1.1.0 WSK-64)
      expect(service.composition.ui).toEqual({ label: "Service pages", group: "Pages", titleField: "h1" });
      expect(Number.isNaN(Date.parse(service.updatedAt))).toBe(false);
      // non-deleted: seo(en) seo(id) draft-only sched unpub legacy = 6. live: seo(en) + legacy. pending: seo(en) seo(id) draft-only unpub.
      expect(service.counts).toEqual({ items: 6, byLocale: { en: 5, id: 1 }, live: 2, pendingChanges: 4 });
      const navigation = body.collections.find((c: { key: string }) => c.key === "navigation");
      expect(navigation.counts).toEqual({ items: 0, byLocale: {}, live: 0, pendingChanges: 0 });
    });

    it("collection.get: {key, composition, vocabularyVersion, updatedAt}; an unknown key is 404 collection-not-found", async () => {
      const r = await get(`${siteBase(fxA)}/collections/service`);
      expect(r.statusCode).toBe(200);
      expect(keysOf(r.json())).toEqual(["composition", "key", "updatedAt", "vocabularyVersion"]);
      expect(r.json().key).toBe("service");
      const miss = await get(`${siteBase(fxA)}/collections/nope`);
      expect(miss.statusCode).toBe(404);
      expect(miss.json().type).toBe(`${PROBLEM}collection-not-found`);
      expect(miss.headers["content-type"]).toMatch(/application\/problem\+json/);
    });

    it("item.list: ItemSummary fields, ordered by slug, locale, id; the title is the HEAD's (seo.title, else fields[ui.titleField])", async () => {
      const r = await get(itemsUrl(fxA));
      expect(r.statusCode).toBe(200);
      const { items, page } = r.json();
      expect(page).toEqual({ cursor: null, hasMore: false, limit: 50 });
      // the deleted item is hidden by default (decision, design §12 WSK-51 done-when 8)
      expect(items.map((i: { slug: string }) => i.slug)).toEqual([
        "service.draft-only",
        "service.legacy",
        "service.sched",
        "service.seo",
        "service.seo-id",
        "service.unpub",
      ]);
      for (const i of items) {
        expect(keysOf(i)).toEqual(
          [
            "deletedAt",
            "editorial", // M5-W2b: the review state (control plane only)
            "headCreatedAt",
            "headCreatedBy",
            "headVersion",
            "itemId",
            "localizationGroupId",
            "locale",
            "pendingChanges",
            "publishAt",
            "publishState",
            "publishedVersion",
            "slug",
            "title",
            "unpublishAt",
            "updatedAt",
          ].sort(),
        );
      }
      const by = (slug: string) => items.find((i: { slug: string }) => i.slug === slug);
      // service.seo is live at v1 but its head is v2: the title shown is the head's
      expect(by("service.seo")).toMatchObject({
        itemId: id.seo,
        title: "SEO Agency Bali v2",
        headVersion: 2,
        publishedVersion: 1,
        publishState: "published",
        pendingChanges: true,
        headCreatedBy: "user-editor-1",
        deletedAt: null,
      });
      expect(by("service.draft-only")).toMatchObject({ title: "Draft Only", headVersion: 1, publishedVersion: null, publishState: "draft", pendingChanges: true });
      expect(by("service.sched")).toMatchObject({ publishState: "scheduled", publishedVersion: 1, pendingChanges: false });
      expect(by("service.sched").publishAt).not.toBeNull();
      expect(by("service.sched").unpublishAt).not.toBeNull();
      expect(by("service.unpub")).toMatchObject({ publishState: "unpublished", publishedVersion: null, pendingChanges: true });
      // a pre-0009 row: head 0, no version row (headCreated* null), the projection's title, never pending
      expect(by("service.legacy")).toMatchObject({
        itemId: legacyId,
        title: "Legacy Page",
        headVersion: 0,
        headCreatedAt: null,
        headCreatedBy: null,
        pendingChanges: false,
      });
      expect(by("service.seo").localizationGroupId).toBe(by("service.seo-id").localizationGroupId);
    });

    it("item.list filters: state, locale, q (escaped), and an unknown collection is 404", async () => {
      const slugs = async (qs: string) => (await get(itemsUrl(fxA, "service", qs))).json().items.map((i: { slug: string }) => i.slug);
      expect(await slugs("?state=draft")).toEqual(["service.draft-only", "service.seo-id"]);
      expect(await slugs("?state=live")).toEqual(["service.legacy", "service.seo"]);
      expect(await slugs("?state=scheduled")).toEqual(["service.sched"]);
      expect(await slugs("?state=unpublished")).toEqual(["service.unpub"]);
      expect(await slugs("?state=pending")).toEqual(["service.draft-only", "service.seo", "service.seo-id", "service.unpub"]);
      expect(await slugs("?locale=id")).toEqual(["service.seo-id"]);
      expect(await slugs("?q=bali")).toEqual(["service.seo", "service.seo-id"]); // by the head's title
      expect(await slugs("?q=sched")).toEqual(["service.sched"]); // by slug
      expect(await slugs("?q=%25")).toEqual([]); // a literal '%' is not a wildcard
      expect((await get(itemsUrl(fxA, "nope"))).statusCode).toBe(404);
    });

    it("item.get: {item, version, live, group, lint}; the item is the write plane's ItemState plus the editor's extras", async () => {
      const r = await get(itemUrl(fxA, id.seo));
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(keysOf(body)).toEqual(["editorial", "group", "item", "lint", "live", "version"]); // editorial: M5-W2b
      expect(keysOf(body.item)).toEqual(
        [
          // ItemState (content-commands.service.ts), unchanged
          "itemId", "collectionKey", "locale", "slug", "localizationGroupId", "headVersion", "publishedVersion",
          "publishState", "publishAt", "unpublishAt", "deletedAt", "updatedAt",
          // the editor's ItemSummary extras
          "title", "pendingChanges", "headCreatedAt", "headCreatedBy",
        ].sort(),
      );
      expect(body.item).toMatchObject({
        itemId: id.seo,
        collectionKey: "service",
        locale: "en",
        slug: "service.seo",
        headVersion: 2,
        publishedVersion: 1,
        publishState: "published",
        publishAt: null,
        unpublishAt: null,
        deletedAt: null,
        title: "SEO Agency Bali v2",
        pendingChanges: true,
      });
      expect(keysOf(body.version)).toEqual(["attribution", "blocks", "contentHash", "createdAt", "createdBy", "n", "note", "seo", "version"]);
      expect(body.version).toMatchObject({ n: 2, version: 2, createdBy: "user-editor-1", note: "fixed the headline", attribution: { pk: "human" } });
      expect(body.version.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(body.version.blocks[0]).toEqual({ type: "fields", props: expect.objectContaining({ h1: "SEO Agency Bali v2" }) });
      expect(body.version.seo).toEqual({ description: "d2" });
      expect(body.live).toMatchObject({ n: 1, note: "first draft" });
      expect(body.live.blocks[0].props.h1).toBe("SEO Agency Bali");
      expect(body.group).toEqual([
        { locale: "en", itemId: id.seo, slug: "service.seo", headVersion: 2, publishedVersion: 1, publishState: "published" },
        { locale: "id", itemId: id.seoId, slug: "service.seo-id", headVersion: 1, publishedVersion: null, publishState: "draft" },
      ]);
    });

    it("item.versions: newest first, {version, contentHash, createdAt, createdBy, attribution, note} + page", async () => {
      const r = await get(`${itemUrl(fxA, id.seo)}/versions`);
      expect(r.statusCode).toBe(200);
      const { versions, page } = r.json();
      expect(page).toEqual({ cursor: null, hasMore: false, limit: 50 });
      expect(versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
      expect(keysOf(versions[0])).toEqual(["attribution", "contentHash", "createdAt", "createdBy", "note", "version"]);
      expect(versions[0]).toMatchObject({ createdBy: "user-editor-1", note: "fixed the headline", attribution: { pk: "human" } });
      expect(versions[1].note).toBe("first draft");
      // a pre-0009 row has no version history: that is what an empty list truthfully says here
      expect((await get(`${itemUrl(fxA, legacyId)}/versions`)).json().versions).toEqual([]);
    });

    it("item.versionGet: the full version (blocks, seo); a missing version is 404 version-not-found", async () => {
      const r = await get(`${itemUrl(fxA, id.seo)}/versions/1`);
      expect(r.statusCode).toBe(200);
      expect(keysOf(r.json())).toEqual(["attribution", "blocks", "contentHash", "createdAt", "createdBy", "n", "note", "seo", "version"]);
      expect(r.json().version).toBe(1);
      expect(r.json().blocks[0].props.h1).toBe("SEO Agency Bali");
      expect(r.json().seo).toEqual({ description: "d1" });
      // the write plane returned this very hash for version 1
      expect(r.json().contentHash).toBe(seoCreate.version.contentHash);
      const miss = await get(`${itemUrl(fxA, id.seo)}/versions/9`);
      expect(miss.statusCode).toBe(404);
      expect(miss.json().type).toBe(`${PROBLEM}version-not-found`);
    });

    it("media.list: the original keys plus the WSK-43a library fields, newest first; mime filter exact and wildcard", async () => {
      const r = await get(`${siteBase(fxA)}/media`);
      expect(r.statusCode).toBe(200);
      const { assets, page } = r.json();
      expect(page).toEqual({ cursor: null, hasMore: false, limit: 50 });
      expect(assets.map((a: { bucketKey: string }) => a.bucketKey)).toEqual(["a/three.jpg", "a/two.pdf", "a/one.png"]);
      // WSK-43a added the library fields to every asset; the six original keys are unchanged (the full filter and
      // lifecycle battery is test/media-library-commands.spec.ts).
      expect(keysOf(assets[0])).toEqual([
        "alt",
        "assetId",
        "bucket",
        "bucketKey",
        "createdAt",
        "createdBy",
        "deletedAt",
        "height",
        "mime",
        "originalFilename",
        "purgeAfter",
        "purgedAt",
        "reviewState", // M5-W1q (migration 0020): the review state and who judged it
        "reviewedAt",
        "reviewedBy",
        "scanStatus",
        "sizeBytes",
        "tags",
        "title",
        "updatedAt",
        "url",
        "width",
      ]);
      expect(assets[0]).toMatchObject({ mime: "image/jpeg", sizeBytes: 3000, scanStatus: "clean", createdAt: "2026-01-01T00:00:03.000Z" });
      const exact = (await get(`${siteBase(fxA)}/media?mime=application/pdf`)).json().assets;
      expect(exact.map((a: { bucketKey: string }) => a.bucketKey)).toEqual(["a/two.pdf"]);
      const wild = (await get(`${siteBase(fxA)}/media?mime=${encodeURIComponent("image/*")}`)).json().assets;
      expect(wild.map((a: { bucketKey: string }) => a.bucketKey)).toEqual(["a/three.jpg", "a/one.png"]);
    });

    it("tenant.list: {tenants:[{slug,status,defaultLocale,locales,sites:[{siteId,name,kind,status,environments:[{envId,name,domain,status}]}]}]}", async () => {
      const r = await get(`/control/v1/tenants?companyRef=${companyB}`);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({
        tenants: [
          {
            slug: fxB.slug,
            status: "active",
            defaultLocale: "en",
            locales: ["en", "id"],
            sites: [
              {
                siteId: fxB.siteId,
                name: "rdB site",
                kind: "astro",
                status: "active",
                environments: [
                  { envId: fxB.productionEnvId, name: "production", domain: null, status: "active" },
                  { envId: fxB.stagingEnvId, name: "staging", domain: null, status: "active" },
                ],
              },
            ],
          },
        ],
      });
    });
  });

  // ==============================================================================================
  // (2) tenancy
  // ==============================================================================================
  describe("(2) cross-tenant reads are a uniform 404, with positive controls", () => {
    it("tenant B's item through tenant A's slug and site -> 404 item-not-found; the same query under B returns it", async () => {
      const crossed = await get(itemUrl(fxA, itemOfB));
      expect(crossed.statusCode).toBe(404);
      expect(crossed.json().type).toBe(`${PROBLEM}item-not-found`);
      // positive control: identical request shape, the right tenant
      const own = await get(itemUrl(fxB, itemOfB));
      expect(own.statusCode).toBe(200);
      expect(own.json().item.itemId).toBe(itemOfB);
      // and an item id that exists nowhere answers identically (no existence oracle)
      const nowhere = await get(itemUrl(fxA, randomUUID()));
      expect(nowhere.statusCode).toBe(404);
      expect(nowhere.json()).toEqual(crossed.json());
    });

    it("tenant B's versions through tenant A's slug -> 404, controls 200", async () => {
      expect((await get(`${itemUrl(fxA, itemOfB)}/versions`)).statusCode).toBe(404);
      expect((await get(`${itemUrl(fxA, itemOfB)}/versions/1`)).statusCode).toBe(404);
      expect((await get(`${itemUrl(fxB, itemOfB)}/versions`)).statusCode).toBe(200);
      expect((await get(`${itemUrl(fxB, itemOfB)}/versions/1`)).statusCode).toBe(200);
    });

    it("tenant B's site id under tenant A's slug -> 404 site-not-found on every site-scoped read; controls 200", async () => {
      const crossedSite = `/control/v1/tenants/${fxA.slug}/sites/${fxB.siteId}`;
      for (const path of ["/collections", "/collections/service", "/collections/service/items", `/content/items/${itemOfB}`, `/content/items/${itemOfB}/versions`, "/media"]) {
        const r = await get(`${crossedSite}${path}`);
        expect(r.statusCode, path).toBe(404);
        expect(r.json().type, path).toBe(`${PROBLEM}site-not-found`);
        expect((await get(`${siteBase(fxB)}${path}`)).statusCode, `control ${path}`).toBe(200);
      }
      // an unknown tenant slug is the same answer
      const unknown = await get(`/control/v1/tenants/no-such-tenant/sites/${fxA.siteId}/collections`);
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().type).toBe(`${PROBLEM}site-not-found`);
    });

    it("lists never mix tenants: A's item list and media hold none of B's rows; B's hold none of A's", async () => {
      const aItems = (await get(itemsUrl(fxA))).json().items.map((i: { itemId: string }) => i.itemId);
      expect(aItems).not.toContain(itemOfB);
      const bItems = (await get(itemsUrl(fxB))).json().items.map((i: { itemId: string }) => i.itemId);
      expect(bItems).toEqual([itemOfB]);
      const aMedia = (await get(`${siteBase(fxA)}/media`)).json().assets.map((m: { bucketKey: string }) => m.bucketKey);
      expect(aMedia).not.toContain(mediaB);
      expect((await get(`${siteBase(fxB)}/media`)).json().assets.map((m: { bucketKey: string }) => m.bucketKey)).toEqual([mediaB]);
    });
  });

  // ==============================================================================================
  // (3) tenant.list filters by companyRef
  // ==============================================================================================
  describe("(3) tenant.list filters by companyRef", () => {
    it("company A sees its two tenants and not B's; company B sees only B's", async () => {
      const a = (await get(`/control/v1/tenants?companyRef=${companyA}`)).json().tenants.map((t: { slug: string }) => t.slug);
      // set equality: the list is ordered by the database's collation, which is not JS's code-unit order
      expect([...a].sort()).toEqual([fxA.slug, fxA2.slug].sort());
      expect(a).not.toContain(fxB.slug);
      const b = (await get(`/control/v1/tenants?companyRef=${companyB}`)).json().tenants.map((t: { slug: string }) => t.slug);
      expect(b).toEqual([fxB.slug]);
      expect(b).not.toContain(fxA.slug);
    });

    it("a company with no tenants gets an empty list; the id's case does not matter", async () => {
      expect((await get(`/control/v1/tenants?companyRef=${randomUUID()}`)).json()).toEqual({ tenants: [] });
      const upper = await get(`/control/v1/tenants?companyRef=${companyB.toUpperCase()}`);
      expect(upper.json().tenants.map((t: { slug: string }) => t.slug)).toEqual([fxB.slug]);
    });

    it("companyRef is required: missing, malformed, repeated or extra parameters are 400 (never every company's tenants)", async () => {
      for (const qs of ["", "?companyRef=", "?companyRef=not-a-uuid", `?companyRef=${companyA}&companyRef=${companyB}`, `?companyRef=${companyA}&all=true`]) {
        const r = await get(`/control/v1/tenants${qs}`);
        expect(r.statusCode, qs).toBe(400);
        expect(r.json().type, qs).toBe(`${PROBLEM}invalid-request`);
      }
    });

    it("an archived tenant is listed with its status, so a retired site does not look like it never existed", async () => {
      await asPlatform((c) => c.query(`UPDATE tenants SET status = 'archived' WHERE id = $1`, [fxA2.tenantId]));
      try {
        const t = (await get(`/control/v1/tenants?companyRef=${companyA}`)).json().tenants.find((x: { slug: string }) => x.slug === fxA2.slug);
        expect(t.status).toBe("archived");
        // and its content reads are refused like every other control command on an archived tenant
        expect((await get(`/control/v1/tenants/${fxA2.slug}/sites/${fxA2.siteId}/collections`)).statusCode).toBe(404);
      } finally {
        await asPlatform((c) => c.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [fxA2.tenantId]));
      }
    });
  });

  // ==============================================================================================
  // (4) drafts, versions and lint are visible
  // ==============================================================================================
  describe("(4) the editor reads heads, not just live", () => {
    it("item.get defaults to the head draft; ?version=live and ?version=<n> select the others", async () => {
      const head = (await get(itemUrl(fxA, id.seo))).json();
      const live = (await get(itemUrl(fxA, id.seo, "?version=live"))).json();
      const v1 = (await get(itemUrl(fxA, id.seo, "?version=1"))).json();
      const v2 = (await get(itemUrl(fxA, id.seo, "?version=2"))).json();
      expect(head.version.n).toBe(2);
      expect(head.version.blocks[0].props.h1).toBe("SEO Agency Bali v2");
      expect(live.version.n).toBe(1);
      expect(live.version.blocks[0].props.h1).toBe("SEO Agency Bali");
      expect(v1.version).toEqual(live.version);
      expect(v2.version).toEqual(head.version);
      // `live` is the published version whichever one is selected
      for (const r of [head, live, v1, v2]) expect(r.live.n).toBe(1);
    });

    it("a draft that was never published reads fine, with live null", async () => {
      const r = (await get(itemUrl(fxA, id.draftOnly))).json();
      expect(r.item).toMatchObject({ publishState: "draft", publishedVersion: null, headVersion: 1 });
      expect(r.live).toBeNull();
      expect(r.version.n).toBe(1);
      const noLive = await get(itemUrl(fxA, id.draftOnly, "?version=live"));
      expect(noLive.statusCode).toBe(404);
      expect(noLive.json().type).toBe(`${PROBLEM}version-not-found`);
    });

    it("an unpublished item's head is readable and nothing is live; a scheduled item's schedule is visible", async () => {
      const u = (await get(itemUrl(fxA, id.unpub))).json();
      expect(u.item).toMatchObject({ publishState: "unpublished", publishedVersion: null });
      expect(u.live).toBeNull();
      const s = (await get(itemUrl(fxA, id.sched))).json();
      expect(s.item).toMatchObject({ publishState: "scheduled", publishedVersion: 1 });
      expect(s.item.publishAt).not.toBeNull();
      expect(s.item.unpublishAt).not.toBeNull();
    });

    it("lint is computed live and reads back what the save returned", async () => {
      const r = (await get(itemUrl(fxA, id.seo, "?version=1"))).json();
      type Lint = { placeholders: unknown; content: { findings: { code: string }[] } };
      const saved = seoCreate.lint as Lint;
      // Placeholder lint depends only on the version itself: it reads back exactly what the save returned.
      expect(r.lint.placeholders).toEqual(saved.placeholders);
      // Content lint (M5-W3) is computed live as well. Its per-item findings read back exactly as saved; the
      // ID-twin rule is cross-item (it reads the localization group as it is NOW), so once a twin exists in
      // the group the save's `twin.missing.*` finding legitimately no longer appears on a later read.
      const perItem = (l: Lint) => ({
        ...l.content,
        findings: l.content.findings.filter((f) => !f.code.startsWith("twin.")),
      });
      expect(perItem(r.lint)).toEqual(perItem(saved));
      expect(r.lint.placeholders.unresolvedTokens).toEqual(["{{RESULT_1_METRIC}}"]);
      expect(r.lint.placeholders.markers).toEqual({ CONFIRM: 1, CLIENT: 1 });
      // the head (v2) has none of them
      const head = (await get(itemUrl(fxA, id.seo))).json();
      expect(head.lint.placeholders).toEqual({ unresolvedTokens: [], markers: { CONFIRM: 0, CLIENT: 0 } });
      expect(Array.isArray(head.lint.content.findings)).toBe(true);
      expect(Array.isArray(head.lint.content.unavailable)).toBe(true);
    });

    it("per-site lint.content settings (M5-W3c): the save and item.get read the same resolved settings", async () => {
      const fxC = await createContentFixture("rdC");
      const setLintContent = async (content: unknown) =>
        asTenant(fxC.tenantId, async (db) => {
          const { rows } = await db.query(`SELECT schema FROM collections WHERE id = $1`, [fxC.collections.service]);
          const schema = rows[0].schema;
          if (content === undefined) delete schema.lint.content;
          else schema.lint.content = content;
          await db.query(`UPDATE collections SET schema = $2::jsonb WHERE id = $1`, [fxC.collections.service, JSON.stringify(schema)]);
        });
      type ContentLint = { findings: { code: string }[]; aeo: unknown; unavailable: unknown[] };
      const codes = (l: { content?: ContentLint }) => (l.content?.findings ?? []).map((f) => f.code).filter((c) => !c.startsWith("twin."));
      const readLint = async (itemId: string) => (await get(itemUrl(fxC, itemId))).json().lint as { content?: ContentLint };

      // 1. no lint.content: today's behaviour. A save with no `seo` reports the meta findings, and item.get agrees.
      const a = await draft(fxC, "service.w3c-a", { fields: serviceFields({ h1: "W3c A" }), seo: {} });
      expect(codes(a.lint)).toContain("meta.title.missing");
      expect(codes(await readLint(a.item.itemId))).toEqual(codes(a.lint));

      // 2. the site switches the meta rule and the AEO score off: a NEW save and item.get agree, and so does the old item.
      await setLintContent({ rules: { meta: { enabled: false }, aeo: { enabled: false } } });
      const b = await draft(fxC, "service.w3c-b", { fields: serviceFields({ h1: "W3c B" }), seo: {} });
      expect(codes(b.lint).some((c: string) => c.startsWith("meta."))).toBe(false);
      expect(b.lint.content.aeo).toBeNull();
      expect(b.lint.content.unavailable).toEqual([]);
      const readB = await readLint(b.item.itemId);
      expect(codes(readB)).toEqual(codes(b.lint));
      expect(readB.content!.aeo).toBeNull();
      expect(codes(await readLint(a.item.itemId)).some((c) => c.startsWith("meta."))).toBe(false); // read == CURRENT settings

      // 3. a threshold: a title limit of 1 makes the same title "too long"; item.get agrees with the save.
      await setLintContent({ rules: { meta: { titleMax: 1 } } });
      const c = await draft(fxC, "service.w3c-c", { fields: serviceFields({ h1: "W3c C" }), seo: { title: "Ab", description: "x".repeat(130) } });
      expect(codes(c.lint)).toContain("meta.title.too-long");
      expect(codes(await readLint(c.item.itemId))).toEqual(codes(c.lint));

      // 4. the master switch: no `content` member on the save or on item.get; the item is still saved (advisory).
      await setLintContent({ enabled: false });
      const d = await draft(fxC, "service.w3c-d", { fields: serviceFields({ h1: "W3c D" }), seo: {} });
      expect(d.lint.content).toBeUndefined();
      expect((await readLint(d.item.itemId)).content).toBeUndefined();

      // 5. back to nothing: today's constants again.
      await setLintContent(undefined);
      expect(codes(await readLint(a.item.itemId))).toContain("meta.title.missing");
    });

    it("lint resolves a token the registry defines", async () => {
      // a registry value makes {{KNOWN}} resolved; {{UNKNOWN}} stays unresolved
      const reg = await createItem(app, fxB, {
        collectionKey: "token-registry",
        locale: "en",
        slug: "tokens",
        fields: { tokens: [{ key: "KNOWN", value: "42" }] },
      });
      expect(reg.statusCode).toBe(201);
      const it2 = await draft(fxB, "service.tokens", { fields: serviceFields({ body: "{{KNOWN}} and {{UNKNOWN}}" }) });
      const r = (await get(itemUrl(fxB, it2.item.itemId))).json();
      expect(r.lint.placeholders.unresolvedTokens).toEqual(["{{UNKNOWN}}"]);
      expect(it2.lint).toEqual(r.lint);
    });

    it("a pre-0009 row reads as version 0 (its projection) and is its own live version", async () => {
      const r = (await get(itemUrl(fxA, legacyId))).json();
      expect(r.item).toMatchObject({ headVersion: 0, publishedVersion: null, publishState: "published", pendingChanges: false, title: "Legacy Page" });
      expect(r.version).toMatchObject({ n: 0, version: 0, createdBy: null, note: null, attribution: {} });
      expect(r.version.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.live.n).toBe(0);
      expect((await get(itemUrl(fxA, legacyId, "?version=live"))).statusCode).toBe(200);
      expect((await get(itemUrl(fxA, legacyId, "?version=1"))).statusCode).toBe(404);
    });
  });

  // ==============================================================================================
  // (5) scope
  // ==============================================================================================
  describe("(5) webdesk:read is required", () => {
    const routes = (): { command: string; url: string }[] => [
      { command: "tenant.list", url: `/control/v1/tenants?companyRef=${companyA}` },
      { command: "collection.list", url: `${siteBase(fxA)}/collections` },
      { command: "collection.get", url: `${siteBase(fxA)}/collections/service` },
      { command: "item.list", url: itemsUrl(fxA) },
      { command: "item.get", url: itemUrl(fxA, id.seo) },
      { command: "item.versions", url: `${itemUrl(fxA, id.seo)}/versions` },
      { command: "item.versionGet", url: `${itemUrl(fxA, id.seo)}/versions/1` },
      { command: "media.list", url: `${siteBase(fxA)}/media` },
    ];

    it("every read: a token without webdesk:read is 403 (L3); the identical request with it is 200", async () => {
      expect(routes()).toHaveLength(8);
      for (const { command, url } of routes()) {
        const none = await get(url, []);
        expect(none.statusCode, `${command} no scopes`).toBe(403);
        expect(none.json().message, command).toMatch(/lacks required scope 'webdesk:read'/);
        const others = await get(url, ALL_BUT_READ);
        expect(others.statusCode, `${command} every scope but read`).toBe(403);
        const allowed = await get(url, READ);
        expect(allowed.statusCode, `${command} control`).toBe(200);
      }
    });

    it("no control principal at all is 401 (L2), and the reads need no editorial principal", async () => {
      const url = `${siteBase(fxA)}/collections`;
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
      // the control group above already sent no editorial header and got 200; state it once more, directly
      expect((await app.inject({ method: "GET", url, headers: rh() })).statusCode).toBe(200);
    });
  });

  // ==============================================================================================
  // (6) no audit rows
  // ==============================================================================================
  describe("(6) reads are not audited", () => {
    it("audit_entries is unchanged across every read, including refused and 404 ones", async () => {
      const fxs = [fxA, fxA2, fxB];
      const before = await auditTotals(fxs);
      expect(before.perTenant[0]).toBeGreaterThan(0); // the seed's writes were audited: the counter can see rows
      const urls = [
        `/control/v1/tenants?companyRef=${companyA}`,
        `/control/v1/tenants?companyRef=${companyB}`,
        `${siteBase(fxA)}/collections`,
        `${siteBase(fxA)}/collections/service`,
        itemsUrl(fxA),
        itemsUrl(fxA, "service", "?state=pending&includeDeleted=true"),
        itemUrl(fxA, id.seo),
        itemUrl(fxA, id.seo, "?version=live"),
        `${itemUrl(fxA, id.seo)}/versions`,
        `${itemUrl(fxA, id.seo)}/versions/2`,
        `${siteBase(fxA)}/media`,
        // refusals and misses
        itemUrl(fxA, itemOfB),
        `${siteBase(fxA)}/collections/nope`,
        `/control/v1/tenants/${fxA.slug}/sites/${fxB.siteId}/media`,
        `${itemUrl(fxA, id.seo)}/versions/99`,
        itemsUrl(fxA, "service", "?limit=0"),
      ];
      for (const url of urls) await get(url);
      for (const url of urls) await get(url, []); // 403s
      const after = await auditTotals(fxs);
      expect(after).toEqual(before);
    });
  });

  // ==============================================================================================
  // (7) pagination stays stable while writes run
  // ==============================================================================================
  describe("(7) pagination is stable under concurrent writes", () => {
    it("item.list: no item is skipped or repeated while updates, a publish and two inserts run between and during page fetches", async () => {
      const fxP = await createContentFixture("rdP");
      const slugOf = (n: number) => `service.p${String(n).padStart(2, "0")}`;
      const created: Record<string, string> = {};
      for (let n = 1; n <= 23; n++) created[slugOf(n)] = (await draft(fxP, slugOf(n), { fields: serviceFields({ h1: `P${n}` }) })).item.itemId as string;

      const page = async (cursor?: string) => {
        const r = await get(itemsUrl(fxP, "service", `?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`));
        expect(r.statusCode).toBe(200);
        return r.json() as { items: { slug: string; itemId: string; headVersion: number }[]; page: { cursor: string | null; hasMore: boolean; limit: number } };
      };

      const seen: { slug: string; headVersion: number }[] = [];
      const first = await page();
      seen.push(...first.items);
      expect(first.items.map((i) => i.slug)).toEqual([1, 2, 3, 4, 5].map(slugOf));
      expect(first.page.hasMore).toBe(true);

      // between pages: one row that sorts BEFORE the cursor and one AFTER it
      const before = await draft(fxP, "service.p00", { fields: serviceFields({ h1: "P00" }) });
      const after = await draft(fxP, "service.p99", { fields: serviceFields({ h1: "P99" }) });

      let cursor = first.page.cursor;
      const writes: (() => Promise<unknown>)[] = [
        () => put(fxP, created[slugOf(1)], { baseVersion: 1, fields: serviceFields({ h1: "P1 edited" }) }), // already served
        () => put(fxP, created[slugOf(14)], { baseVersion: 1, fields: serviceFields({ h1: "P14 edited" }) }), // not yet served
        () => publish(fxP, created[slugOf(16)], 1), // not yet served: its projection changes
        () => put(fxP, created[slugOf(7)], { baseVersion: 1, fields: serviceFields({ h1: "P7 edited" }) }), // next page's own row
      ];
      let i = 0;
      while (cursor) {
        // the page fetch and a write run at the same time
        const [p] = await Promise.all([page(cursor), i < writes.length ? writes[i++]() : Promise.resolve()]);
        seen.push(...p.items);
        cursor = p.page.cursor;
      }

      const slugs = seen.map((s) => s.slug);
      expect(new Set(slugs).size).toBe(slugs.length); // no row twice
      const expected = [...Array.from({ length: 23 }, (_, k) => slugOf(k + 1)), "service.p99"];
      expect(slugs).toEqual(expected); // none skipped, still in slug order; p00 sorted before the cursor, so it is not re-served
      expect(slugs).not.toContain("service.p00");
      expect(before.item.slug).toBe("service.p00");
      expect(after.item.slug).toBe("service.p99");
      // a fresh walk from the start sees the new row in its place
      const all = await (async () => {
        const out: string[] = [];
        let c: string | null | undefined;
        do {
          const p = await page(c ?? undefined);
          out.push(...p.items.map((x) => x.slug));
          c = p.page.cursor;
        } while (c);
        return out;
      })();
      expect(all).toEqual(["service.p00", ...expected]);
    }, 120_000);

    it("item.versions: newer versions written between pages never shift the older ones", async () => {
      const fxV = await createContentFixture("rdV");
      const created = await draft(fxV, "service.history", { fields: serviceFields({ h1: "v1" }) });
      const itemId = created.item.itemId as string;
      for (let v = 1; v < 12; v++) await put(fxV, itemId, { baseVersion: v, fields: serviceFields({ h1: `v${v + 1}` }), note: `change ${v + 1}` });

      const url = (cursor?: string) => `${itemUrl(fxV, itemId)}/versions?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const p1 = (await get(url())).json();
      expect(p1.versions.map((v: { version: number }) => v.version)).toEqual([12, 11, 10, 9, 8]);
      expect(p1.page).toMatchObject({ hasMore: true, limit: 5 });

      // two new versions land above the cursor, one of them during the next fetch
      await put(fxV, itemId, { baseVersion: 12, fields: serviceFields({ h1: "v13" }) });
      const [p2] = await Promise.all([get(url(p1.page.cursor)), put(fxV, itemId, { baseVersion: 13, fields: serviceFields({ h1: "v14" }) })]);
      expect(p2.json().versions.map((v: { version: number }) => v.version)).toEqual([7, 6, 5, 4, 3]);
      const p3 = (await get(url(p2.json().page.cursor))).json();
      expect(p3.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
      expect(p3.page).toEqual({ cursor: null, hasMore: false, limit: 5 });
      expect((await get(`${itemUrl(fxV, itemId)}/versions?limit=100`)).json().versions.map((v: { version: number }) => v.version)).toEqual([14, 13, ...p1.versions.map((v: { version: number }) => v.version), 7, 6, 5, 4, 3, 2, 1]);
    }, 120_000);

    it("media.list: an upload between pages does not repeat or skip; assets created in the same instant tie-break on id", async () => {
      const fxM = await createContentFixture("rdM");
      const tie = "2026-02-01T00:00:00.500000Z";
      const stem = randomUUID().slice(0, -1); // random per run (media_assets.id is global), ids differ only in the last digit
      const rows = [
        { key: "m/1.png", mime: "image/png", size: 1, createdAt: "2026-02-01T00:00:01.000000Z" },
        { key: "m/2.png", mime: "image/png", size: 2, createdAt: "2026-02-01T00:00:02.000000Z" },
        { key: "m/3a.png", mime: "image/png", size: 3, createdAt: tie, id: `${stem}a` },
        { key: "m/3b.png", mime: "image/png", size: 3, createdAt: tie, id: `${stem}b` },
        { key: "m/4.png", mime: "image/png", size: 4, createdAt: "2026-02-01T00:00:00.000001Z" },
        { key: "m/5.png", mime: "image/png", size: 5, createdAt: "2026-02-01T00:00:00.000002Z" },
        { key: "m/6.png", mime: "image/png", size: 6, createdAt: "2026-01-31T23:59:59.999999Z" },
      ];
      await insertMedia(fxM, rows);
      const url = (cursor?: string) => `${siteBase(fxM)}/media?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const keys = (r: { json: () => { assets: { bucketKey: string }[] } }) => r.json().assets.map((a) => a.bucketKey);
      const p1 = await get(url());
      expect(keys(p1)).toEqual(["m/2.png", "m/1.png", "m/3b.png"]); // newest first; the tie breaks id DESC
      await insertMedia(fxM, [{ key: "m/new.png", mime: "image/png", size: 9 }]); // newer than everything: above the cursor
      const p2 = await get(url(p1.json().page.cursor));
      expect(keys(p2)).toEqual(["m/3a.png", "m/5.png", "m/4.png"]); // the tied row that was not on page 1 comes next; microsecond order holds
      const p3 = await get(url(p2.json().page.cursor));
      expect(keys(p3)).toEqual(["m/6.png"]);
      expect(p3.json().page).toEqual({ cursor: null, hasMore: false, limit: 3 });
    }, 60_000);
  });

  // ==============================================================================================
  // (8) soft-deleted items (decision: hidden by default; includeDeleted=true for history)
  // ==============================================================================================
  describe("(8) soft-deleted items", () => {
    it("item.list hides them by default, ?includeDeleted=true includes them, ?state=deleted lists only them", async () => {
      const def = (await get(itemsUrl(fxA))).json().items.map((i: { slug: string }) => i.slug);
      expect(def).not.toContain("service.gone");
      const inc = (await get(itemsUrl(fxA, "service", "?includeDeleted=true"))).json().items;
      expect(inc.map((i: { slug: string }) => i.slug)).toContain("service.gone");
      expect(inc.find((i: { slug: string }) => i.slug === "service.gone")).toMatchObject({ itemId: id.gone, deletedAt: expect.any(String), pendingChanges: false });
      const only = (await get(itemsUrl(fxA, "service", "?state=deleted"))).json().items;
      expect(only.map((i: { slug: string }) => i.slug)).toEqual(["service.gone"]);
      // includeDeleted composes with the other filters
      expect((await get(itemsUrl(fxA, "service", "?state=draft&includeDeleted=true"))).json().items.map((i: { slug: string }) => i.slug)).toEqual([
        "service.draft-only",
        "service.gone",
        "service.seo-id",
      ]);
      expect((await get(itemsUrl(fxA, "service", "?includeDeleted=false"))).json().items.map((i: { slug: string }) => i.slug)).toEqual(def);
    });

    it("item.get and the version reads still open a deleted item (history), with deletedAt set; counts exclude it", async () => {
      const g = await get(itemUrl(fxA, id.gone));
      expect(g.statusCode).toBe(200);
      expect(g.json().item.deletedAt).not.toBeNull();
      expect(g.json().item.pendingChanges).toBe(false);
      expect((await get(`${itemUrl(fxA, id.gone)}/versions`)).json().versions).toHaveLength(1);
      expect((await get(`${itemUrl(fxA, id.gone)}/versions/1`)).statusCode).toBe(200);
      const service = (await get(`${siteBase(fxA)}/collections`)).json().collections.find((c: { key: string }) => c.key === "service");
      expect(service.counts.items).toBe(6); // not 7
      // a deleted item is not in its group's locale switcher
      expect((await get(itemUrl(fxA, id.gone))).json().group).toEqual([]);
    });
  });

  // ==============================================================================================
  // strict inputs
  // ==============================================================================================
  describe("input validation (RFC 9457 400 / 404)", () => {
    it("rejects unknown parameters, bad enums, out-of-range limits and malformed cursors instead of ignoring them", async () => {
      const bad = [
        itemsUrl(fxA, "service", "?includeDelete=true"),
        itemsUrl(fxA, "service", "?state=bogus"),
        itemsUrl(fxA, "service", "?includeDeleted=yes"),
        itemsUrl(fxA, "service", "?limit=0"),
        itemsUrl(fxA, "service", "?limit=101"),
        itemsUrl(fxA, "service", "?limit=abc"),
        itemsUrl(fxA, "service", "?limit=5&limit=6"),
        itemsUrl(fxA, "service", "?cursor=@@@"),
        itemsUrl(fxA, "service", `?cursor=${Buffer.from('["a","b","not-a-uuid"]').toString("base64url")}`),
        itemsUrl(fxA, "service", `?cursor=${Buffer.from('{"slug":"a"}').toString("base64url")}`),
        `${siteBase(fxA)}/collections?x=1`,
        itemUrl(fxA, id.seo, "?version=abc"),
        itemUrl(fxA, id.seo, "?version=0"),
        itemUrl(fxA, id.seo, "?version=-1"),
        itemUrl(fxA, id.seo, "?version=1.5"),
        `${itemUrl(fxA, id.seo)}/versions/abc`,
        `${itemUrl(fxA, id.seo)}/versions?cursor=zzz`,
        `${siteBase(fxA)}/media?mime=notamime`,
        `${siteBase(fxA)}/media?cursor=${Buffer.from('["2026-01-01","x"]').toString("base64url")}`,
      ];
      for (const url of bad) {
        const r = await get(url);
        expect(r.statusCode, url).toBe(400);
        expect(r.json().type, url).toBe(`${PROBLEM}invalid-request`);
        expect(r.headers["content-type"], url).toMatch(/application\/problem\+json/);
      }
    });

    it("a malformed item id is a 404 item-not-found, never a 400 or a 500", async () => {
      for (const url of [itemUrl(fxA, "not-a-uuid"), `${itemUrl(fxA, "not-a-uuid")}/versions`, `${itemUrl(fxA, "not-a-uuid")}/versions/1`]) {
        const r = await get(url);
        expect(r.statusCode, url).toBe(404);
        expect(r.json().type, url).toBe(`${PROBLEM}item-not-found`);
      }
    });

    it("the cursor pages a real list: the limit is honoured and the last page has hasMore false", async () => {
      const p1 = (await get(itemsUrl(fxA, "service", "?limit=4"))).json();
      expect(p1.items).toHaveLength(4);
      expect(p1.page).toMatchObject({ hasMore: true, limit: 4 });
      const p2 = (await get(itemsUrl(fxA, "service", `?limit=4&cursor=${encodeURIComponent(p1.page.cursor)}`))).json();
      expect(p2.items.map((i: { slug: string }) => i.slug)).toEqual(["service.seo-id", "service.unpub"]);
      expect(p2.page).toEqual({ cursor: null, hasMore: false, limit: 4 });
    });
  });
});

// ================================================================================================
// WSK-66's contract. platform-nest/src/modules/webdev/webdesk-approved-command.ts reconcileByReading
// reconciles an ambiguous publish/schedule by sending item.get to
//   GET /control/v1/tenants/:tenantSlug/sites/:siteId/content/items/:itemId
// and reading `res.json.item.publishedVersion`, `.publishAt` and `.unpublishAt`:
//   content.publish   holds iff  item.publishedVersion === it.version
//   content.schedule  holds iff  sameInstant(item.publishAt, a.publishAt) && sameInstant(item.unpublishAt, a.unpublishAt)
// where sameInstant(a, null) is "a is null or undefined" and otherwise "a is a string with the same
// Date.parse as b". The predicate below is a verbatim port of that code (platform-nest is a separate
// package and this suite ships without it), so a change to either side's field names or meanings
// fails here.
// ================================================================================================
describe("WSK-51 item.get honours the WSK-66 reconcile contract", () => {
  let fx: ContentFixture;

  beforeAll(async () => {
    app = await buildContentApp();
    fx = await createContentFixture("rdR");
  }, 60_000);
  afterAll(async () => {
    await app?.close();
  });

  function sameInstant(a: unknown, b: string | null): boolean {
    if (b === null) return a === null || a === undefined;
    return typeof a === "string" && Date.parse(a) === Date.parse(b);
  }
  async function holdsPublish(itemId: string, version: number): Promise<boolean | null> {
    const res = await get(`/control/v1/tenants/${fx.slug}/sites/${fx.siteId}/content/items/${itemId}`);
    const json = res.json();
    if (res.statusCode !== 200 || typeof json !== "object" || json === null || typeof json.item !== "object" || json.item === null) return null;
    return json.item.publishedVersion === version;
  }
  async function holdsSchedule(itemId: string, publishAt: string | null, unpublishAt: string | null): Promise<boolean | null> {
    const res = await get(`/control/v1/tenants/${fx.slug}/sites/${fx.siteId}/content/items/${itemId}`);
    const json = res.json();
    if (res.statusCode !== 200 || typeof json !== "object" || json === null || typeof json.item !== "object" || json.item === null) return null;
    return sameInstant(json.item.publishAt, publishAt) && sameInstant(json.item.unpublishAt, unpublishAt);
  }

  async function newItem(slug: string): Promise<string> {
    return (await draft(fx, slug)).item.itemId as string;
  }

  it("publishedVersion: null for a draft; the published version after content.publish (a number, strictly equal); null again after unpublish", async () => {
    const itemId = await newItem("service.rec-publish");
    const raw = async () => (await get(itemUrl(fx, itemId))).json().item;

    let item = await raw();
    expect(item.publishedVersion).toBeNull();
    expect(await holdsPublish(itemId, 1)).toBe(false);

    await publish(fx, itemId, 1);
    item = await raw();
    expect(item.publishedVersion).toBe(1); // a JSON number: the reconciler compares with ===
    expect(typeof item.publishedVersion).toBe("number");
    expect(await holdsPublish(itemId, 1)).toBe(true);
    expect(await holdsPublish(itemId, 2)).toBe(false);

    // publishing a newer version moves it; the head being ahead is not "published"
    await put(fx, itemId, { baseVersion: 1, fields: serviceFields({ h1: "second" }) });
    expect((await raw()).publishedVersion).toBe(1);
    expect((await raw()).headVersion).toBe(2);
    await publish(fx, itemId, 2);
    expect((await raw()).publishedVersion).toBe(2);
    expect(await holdsPublish(itemId, 2)).toBe(true);
    expect(await holdsPublish(itemId, 1)).toBe(false);

    await unpublish(fx, itemId, 2);
    expect((await raw()).publishedVersion).toBeNull();
    expect(await holdsPublish(itemId, 2)).toBe(false);
  });

  it("publishAt / unpublishAt: ISO-8601 instants after content.schedule, null when not set, and the reconcile predicate agrees", async () => {
    const itemId = await newItem("service.rec-schedule");
    const raw = async () => (await get(itemUrl(fx, itemId))).json().item;

    let item = await raw();
    expect(item.publishAt).toBeNull(); // null, not absent
    expect(item.unpublishAt).toBeNull();
    expect("publishAt" in item && "unpublishAt" in item && "publishedVersion" in item).toBe(true);
    expect(await holdsSchedule(itemId, null, null)).toBe(true);

    const publishAt = "2031-03-04T05:06:07Z"; // deliberately without milliseconds: the reconciler compares instants, not strings
    const unpublishAt = "2031-06-07T08:09:10Z";
    await schedule(fx, itemId, 1, publishAt, unpublishAt);
    item = await raw();
    expect(typeof item.publishAt).toBe("string");
    expect(Date.parse(item.publishAt)).toBe(Date.parse(publishAt));
    expect(Date.parse(item.unpublishAt)).toBe(Date.parse(unpublishAt));
    expect(item.publishAt).toBe(new Date(publishAt).toISOString());
    expect(item.publishedVersion).toBe(1); // a scheduled version is the published version, waiting for its time
    expect(await holdsSchedule(itemId, publishAt, unpublishAt)).toBe(true);
    expect(await holdsSchedule(itemId, publishAt, null)).toBe(false);
    expect(await holdsSchedule(itemId, "2031-03-04T05:06:08Z", unpublishAt)).toBe(false);
    expect(await holdsSchedule(itemId, null, null)).toBe(false);
  });

  it("a scheduled takedown on a live item: publishAt null, unpublishAt set, still published", async () => {
    const itemId = await newItem("service.rec-takedown");
    await publish(fx, itemId, 1);
    const unpublishAt = "2031-09-09T09:09:09Z";
    await schedule(fx, itemId, 1, null, unpublishAt);
    const item = (await get(itemUrl(fx, itemId))).json().item;
    expect(item.publishedVersion).toBe(1);
    expect(item.publishAt).toBeNull();
    expect(Date.parse(item.unpublishAt)).toBe(Date.parse(unpublishAt));
    expect(await holdsSchedule(itemId, null, unpublishAt)).toBe(true);
    expect(await holdsPublish(itemId, 1)).toBe(true);
  });

  it("an unknown item is a 404 the reconciler reads as 'could not be read' (null), never as a state", async () => {
    expect(await holdsPublish(randomUUID(), 1)).toBeNull();
  });
});
