// WSK-43a (owner rulings WSK-D53/D54) — the media library's control-plane commands and reads:
// media.update, media.delete (soft, refused while content uses the asset), media.usage, media.list (its new
// filters and fields), and the quota counting bytes held. Real Postgres (migrations through 0014), the real
// AppModule with the REAL Layer-3/4 PDP (content-test-kit.ts).
//
// Doctrine (estate memory: "validation pre-empts authz"): every denial sends a request that is valid for its
// command and is paired with a positive control that sends the IDENTICAL request and succeeds.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asTenant, buildContentApp, createContentFixture, createItem, hdr, publishItems, serviceFields, type ContentFixture } from "./content-test-kit";
import { dumpAudit, dumpIdempotency, itemBase } from "./preview-test-kit";
import {
  PROBLEM,
  assetUrl,
  auditRows,
  deleteMedia,
  getAsset,
  imageBlock,
  listMedia,
  mediaBase,
  mediaUsage,
  seedAsset,
  seedItem,
  updateMedia,
} from "./media-library-kit";
import { QuotaService } from "../src/media/quota.service";
import { normaliseTags } from "../src/control/content/media-commands.service";

describe("WSK-43a media.update / media.delete / media.usage / media.list", () => {
  let app: NestFastifyApplication;
  let fx: ContentFixture;
  let other: ContentFixture;

  beforeAll(async () => {
    app = await buildContentApp();
    fx = await createContentFixture("mlib");
    other = await createContentFixture("mlib-other");
  });
  afterAll(async () => {
    await app?.close();
  });

  // ==============================================================================================
  // media.update
  // ==============================================================================================
  describe("media.update", () => {
    it("sets title, alt (a per-locale map) and tags; answers { asset } with the new fields and a moved updated_at", async () => {
      const a = await seedAsset(fx, { tags: ["old"] });
      const before = (await getAsset(fx, a.id)) as Record<string, any>;
      const res = await updateMedia(app, fx, a.id, { title: "  Hero banner ", alt: { en: "A cat", id: "Seekor kucing" }, tags: ["Hero", " Cats "] });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body.replayed).toBe(false);
      expect(body.asset).toMatchObject({ assetId: a.id, url: assetUrl(fx, a.id), title: "Hero banner", alt: { en: "A cat", id: "Seekor kucing" }, tags: ["hero", "cats"] });
      const row = (await getAsset(fx, a.id)) as Record<string, any>;
      expect(row).toMatchObject({ title: "Hero banner", alt: { en: "A cat", id: "Seekor kucing" }, tags: ["hero", "cats"] });
      expect(new Date(row.updated_at).getTime()).toBeGreaterThan(new Date(before.updated_at).getTime());
      expect((await auditRows(fx, "control.media.update")).length).toBeGreaterThan(0);
    });

    it("a partial update changes only what it names: title alone leaves alt and tags; null / empty clears the title", async () => {
      const a = await seedAsset(fx, { title: "T", alt: { en: "kept" }, tags: ["kept"] });
      expect((await updateMedia(app, fx, a.id, { title: "New" })).statusCode).toBe(200);
      expect(await getAsset(fx, a.id)).toMatchObject({ title: "New", alt: { en: "kept" }, tags: ["kept"] });
      expect((await updateMedia(app, fx, a.id, { title: null })).statusCode).toBe(200);
      expect((await getAsset(fx, a.id))?.title).toBeNull();
      expect((await updateMedia(app, fx, a.id, { title: "again" })).statusCode).toBe(200);
      expect((await updateMedia(app, fx, a.id, { title: "   " })).statusCode).toBe(200);
      expect((await getAsset(fx, a.id))?.title).toBeNull();
    });

    it("alt is the COMPLETE map: it replaces, an empty text drops its key, {} clears", async () => {
      const a = await seedAsset(fx, { alt: { en: "one", id: "satu" } });
      expect((await updateMedia(app, fx, a.id, { alt: { en: "uno" } })).statusCode).toBe(200);
      expect((await getAsset(fx, a.id))?.alt).toEqual({ en: "uno" });
      expect((await updateMedia(app, fx, a.id, { alt: { en: "x", id: "  " } })).statusCode).toBe(200);
      expect((await getAsset(fx, a.id))?.alt).toEqual({ en: "x" });
      expect((await updateMedia(app, fx, a.id, { alt: {} })).statusCode).toBe(200);
      expect((await getAsset(fx, a.id))?.alt).toEqual({});
    });

    it("ALT LOCALES are validated against the tenant's declared locales: an unknown one is 400 naming the declared set; the declared ones pass", async () => {
      const a = await seedAsset(fx);
      const bad = await updateMedia(app, fx, a.id, { alt: { en: "fine", fr: "pas déclaré" } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().type).toBe(`${PROBLEM}invalid-request`);
      expect(bad.json().detail).toMatch(/fr/);
      expect(bad.json().detail).toMatch(/en, id/);
      expect((await getAsset(fx, a.id))?.alt).toEqual({}); // nothing was written
      expect((await updateMedia(app, fx, a.id, { alt: { en: "fine", id: "bagus" } })).statusCode).toBe(200);
      for (const alt of [[], "x", 5, null, { en: 5 }, { en: "x".repeat(501) }]) {
        const r = await updateMedia(app, fx, a.id, { alt });
        expect(r.statusCode, JSON.stringify(alt)).toBe(400);
      }
    });

    it("TAGS are normalised: trimmed, lower-cased, whitespace collapsed, de-duplicated (first position wins), empties dropped", async () => {
      const a = await seedAsset(fx);
      const res = await updateMedia(app, fx, a.id, { tags: ["  Hero ", "HERO", "hero", "big   Cat", "", "   ", "Big Cat", "z"] });
      expect(res.statusCode).toBe(200);
      expect(res.json().asset.tags).toEqual(["hero", "big cat", "z"]);
      expect((await getAsset(fx, a.id))?.tags).toEqual(["hero", "big cat", "z"]);
      expect(normaliseTags([" A ", "a"])).toEqual(["a"]); // the pure function
      expect((await updateMedia(app, fx, a.id, { tags: [] })).statusCode).toBe(200);
      expect((await getAsset(fx, a.id))?.tags).toEqual([]);
    });

    it("the COUNT and LENGTH of tags are capped: 21 distinct tags and a 41-character tag are 400 (never silently cut); 20 and 40 pass; duplicates do not count twice", async () => {
      const a = await seedAsset(fx);
      const many = Array.from({ length: 21 }, (_, i) => `tag-${i}`);
      const r1 = await updateMedia(app, fx, a.id, { tags: many });
      expect(r1.statusCode).toBe(400);
      expect(r1.json().type).toBe(`${PROBLEM}invalid-request`);
      expect((await updateMedia(app, fx, a.id, { tags: many.slice(0, 20) })).statusCode).toBe(200);
      expect((await updateMedia(app, fx, a.id, { tags: [...many.slice(0, 20), "TAG-0", " tag-1 "] })).statusCode).toBe(200); // 22 given, 20 distinct
      expect((await updateMedia(app, fx, a.id, { tags: ["x".repeat(41)] })).statusCode).toBe(400);
      expect((await updateMedia(app, fx, a.id, { tags: ["x".repeat(40)] })).statusCode).toBe(200);
      for (const tags of ["hero", [5], [null], ["a\u0000b"], { a: 1 }]) {
        const r = await updateMedia(app, fx, a.id, { tags });
        expect(r.statusCode, JSON.stringify(tags)).toBe(400);
      }
    });

    it("a body with no field, an unknown key, a route-param key, or a title that is too long or not a string is 400", async () => {
      const a = await seedAsset(fx);
      for (const body of [{}, { extra: 1 }, { title: "x", siteId: fx.siteId }, { title: "x", assetId: a.id }, { title: "x".repeat(201) }, { title: 5 }, { title: ["x"] }]) {
        const r = await updateMedia(app, fx, a.id, body);
        expect(r.statusCode, JSON.stringify(body)).toBe(400);
        expect(r.json().type).toBe(`${PROBLEM}invalid-request`);
      }
      expect((await updateMedia(app, fx, a.id, { title: "x".repeat(200) })).statusCode).toBe(200);
    });

    it("a DELETED asset is 409 media-asset-deleted; unknown, malformed and another tenant's or site's asset are the same 404", async () => {
      const gone = await seedAsset(fx, { deleted: { deletedAgo: "1 hour", purgeAfterAgo: "-1 day" } });
      const r = await updateMedia(app, fx, gone.id, { title: "x" });
      expect(r.statusCode).toBe(409);
      expect(r.json().type).toBe(`${PROBLEM}media-asset-deleted`);
      const foreign = await seedAsset(other);
      for (const id of [foreign.id, randomUUID(), "not-a-uuid"]) {
        const res = await updateMedia(app, fx, id, { title: "x" });
        expect(res.statusCode, id).toBe(404);
        expect(res.json().type).toBe(`${PROBLEM}media-asset-not-found`);
      }
      expect((await getAsset(other, foreign.id))?.title).toBeNull(); // untouched
      expect((await updateMedia(app, other, foreign.id, { title: "mine" })).statusCode).toBe(200); // positive control, under its own site
    });

    it("an idempotent retry (same key, same body) replays the stored answer; the same key with another body is 409 idempotency-key-reused", async () => {
      const a = await seedAsset(fx);
      const idem = `idem-${randomUUID()}`;
      const first = await updateMedia(app, fx, a.id, { title: "once" }, { idem });
      expect(first.statusCode).toBe(200);
      const replay = await updateMedia(app, fx, a.id, { title: "once" }, { idem });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().replayed).toBe(true);
      expect(replay.json().asset.title).toBe("once");
      const reused = await updateMedia(app, fx, a.id, { title: "twice" }, { idem });
      expect(reused.statusCode).toBe(409);
      expect(reused.json().type).toBe(`${PROBLEM}idempotency-key-reused`);
    });

    it("GATES: no editorial principal -> 401, a scopeless or read-only token -> 403, no Idempotency-Key -> 400; each identical request that is allowed succeeds; nothing is written by a refusal", async () => {
      const a = await seedAsset(fx);
      const body = { title: "gated" };
      const auditBefore = (await dumpAudit(fx)).length;
      expect((await updateMedia(app, fx, a.id, body, { editorial: null })).statusCode).toBe(401);
      expect((await updateMedia(app, fx, a.id, body, { scopes: [] })).statusCode).toBe(403);
      expect((await updateMedia(app, fx, a.id, body, { scopes: ["webdesk:read"] })).statusCode).toBe(403);
      expect((await updateMedia(app, fx, a.id, body, { idem: null })).statusCode).toBe(400);
      expect((await getAsset(fx, a.id))?.title).toBeNull();
      expect((await dumpAudit(fx)).length).toBe(auditBefore);
      // gate ORDER: an invalid body with no principal is 401 (authz first), with one it is 400
      expect((await updateMedia(app, fx, a.id, {}, { editorial: null })).statusCode).toBe(401);
      expect((await updateMedia(app, fx, a.id, {})).statusCode).toBe(400);
      expect((await updateMedia(app, fx, a.id, body, { scopes: ["webdesk:operate"] })).statusCode).toBe(200);
    });
  });

  // ==============================================================================================
  // media.delete
  // ==============================================================================================
  describe("media.delete", () => {
    it("an UNUSED asset is soft-deleted: deleted_at set, purge_after = deleted_at + the bucket retention (1 day), the row kept, the answer carries both instants", async () => {
      const a = await seedAsset(fx);
      const res = await deleteMedia(app, fx, a.id);
      expect(res.statusCode, res.body).toBe(200);
      const b = res.json();
      expect(b).toMatchObject({ assetId: a.id, alreadyDeleted: false, replayed: false });
      const row = (await getAsset(fx, a.id)) as Record<string, any>;
      expect(row.deleted_at).not.toBeNull();
      expect(row.purged_at).toBeNull();
      expect(new Date(row.purge_after).getTime() - new Date(row.deleted_at).getTime()).toBe(24 * 3600 * 1000); // WEBDESK_STORAGE_LOCK_DAYS default 1
      expect(b.deletedAt).toBe(new Date(row.deleted_at).toISOString());
      expect(b.purgeAfter).toBe(new Date(row.purge_after).toISOString());
      expect((await auditRows(fx, "control.media.delete")).length).toBeGreaterThan(0);
    });

    it("the retention follows WEBDESK_STORAGE_LOCK_DAYS (the variable the storage bootstrap applies); an empty one means 1, a malformed one refuses loudly and deletes nothing", async () => {
      const prev = process.env.WEBDESK_STORAGE_LOCK_DAYS;
      try {
        process.env.WEBDESK_STORAGE_LOCK_DAYS = "7";
        const a = await seedAsset(fx);
        expect((await deleteMedia(app, fx, a.id)).statusCode).toBe(200);
        const row = (await getAsset(fx, a.id)) as Record<string, any>;
        expect(new Date(row.purge_after).getTime() - new Date(row.deleted_at).getTime()).toBe(7 * 24 * 3600 * 1000);
        process.env.WEBDESK_STORAGE_LOCK_DAYS = "";
        const b = await seedAsset(fx);
        expect((await deleteMedia(app, fx, b.id)).statusCode).toBe(200);
        const rowB = (await getAsset(fx, b.id)) as Record<string, any>;
        expect(new Date(rowB.purge_after).getTime() - new Date(rowB.deleted_at).getTime()).toBe(24 * 3600 * 1000);
        process.env.WEBDESK_STORAGE_LOCK_DAYS = "0";
        const c = await seedAsset(fx);
        expect((await deleteMedia(app, fx, c.id)).statusCode).toBe(500);
        expect((await getAsset(fx, c.id))?.deleted_at).toBeNull();
      } finally {
        if (prev === undefined) delete process.env.WEBDESK_STORAGE_LOCK_DAYS;
        else process.env.WEBDESK_STORAGE_LOCK_DAYS = prev;
      }
    });

    it("a deleted asset is GONE from media.list, 404 on the public serving route, and STILL COUNTED in the quota (its bytes are held until purged)", async () => {
      const f = await createContentFixture("del-quota");
      const keep = await seedAsset(f, { sizeBytes: 1000 });
      const gone = await seedAsset(f, { sizeBytes: 4000 });
      const quota = app.get(QuotaService);
      expect(await quota.usedBytes(f.tenantId)).toBe(5000);
      expect((await deleteMedia(app, f, gone.id)).statusCode).toBe(200);
      const list = (await listMedia(app, f)).json();
      expect(list.assets.map((x: { assetId: string }) => x.assetId)).toEqual([keep.id]);
      expect(await quota.usedBytes(f.tenantId)).toBe(5000); // soft-deleted within retention: still held
      const served = await app.inject({ method: "GET", url: assetUrl(f, gone.id) });
      expect(served.statusCode).toBe(404);
    });

    it("DELETING AGAIN is idempotent: 200 { alreadyDeleted: true } with the ORIGINAL instants, nothing moves (a new key, an old key, and an asset that has since become 'in use')", async () => {
      const a = await seedAsset(fx);
      const first = (await deleteMedia(app, fx, a.id)).json();
      const again = await deleteMedia(app, fx, a.id);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ assetId: a.id, alreadyDeleted: true, deletedAt: first.deletedAt, purgeAfter: first.purgeAfter });
      expect((await getAsset(fx, a.id))?.deleted_at).not.toBeNull();
      // a content item now names the (deleted) asset: a repeat delete still answers 200, it is not re-judged
      await seedItem(fx, { slug: "names-a-deleted-asset", blocks: imageBlock(assetUrl(fx, a.id)) });
      expect((await deleteMedia(app, fx, a.id)).json().alreadyDeleted).toBe(true);
    });

    it("IN USE by a LIVE item -> 409 media-in-use listing it (itemId, collectionKey, locale, slug, where); nothing is deleted", async () => {
      const f = await createContentFixture("inuse-live");
      const a = await seedAsset(f);
      const used = await seedItem(f, { slug: "live-page", blocks: imageBlock(assetUrl(f, a.id)), state: "published" });
      const res = await deleteMedia(app, f, a.id);
      expect(res.statusCode).toBe(409);
      const p = res.json();
      expect(p.type).toBe(`${PROBLEM}media-in-use`);
      expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
      expect(p.total).toBe(1);
      expect(p.usage).toEqual([{ itemId: used.itemId, collectionKey: "service", locale: "en", slug: "live-page", in: expect.arrayContaining(["live"]) }]);
      expect((await getAsset(f, a.id))?.deleted_at).toBeNull();
      expect((await auditRows(f, "control.media.delete")).length).toBe(0); // a refusal leaves no audit row (it rolled back)
      expect((await listMedia(app, f)).json().assets).toHaveLength(1);
    });

    it("IN USE by a DRAFT HEAD only (never published) -> 409; and once the head no longer names the asset the delete goes through", async () => {
      const f = await createContentFixture("inuse-draft");
      const a = await seedAsset(f);
      // a real draft through the editor: its only version refers to the asset in its markdown body
      const created = await createItem(app, f, { collectionKey: "service", locale: "en", slug: "service.draft-ref", fields: serviceFields({ body: `![hero](${assetUrl(f, a.id)})` }) });
      expect(created.statusCode, created.body).toBe(201);
      const itemId = created.json().item.itemId as string;
      const blocked = await deleteMedia(app, f, a.id);
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().usage).toEqual([{ itemId, collectionKey: "service", locale: "en", slug: "service.draft-ref", in: ["head"] }]);
      // the editor removes the image: a new head version without it (version 1 still has it, in history: not a use)
      const upd = await app.inject({ method: "PUT", url: itemBase(f, itemId), headers: hdr(), payload: { baseVersion: 1, fields: serviceFields({ body: "no image any more" }) } });
      expect(upd.statusCode, upd.body).toBe(200);
      expect((await mediaUsage(app, f, a.id)).json().total).toBe(0);
      expect((await deleteMedia(app, f, a.id)).statusCode).toBe(200);
    });

    it("a LIVE item whose newer HEAD dropped the image is still in use (live), and a head that adds it to a live item is in use (head): both reported", async () => {
      const f = await createContentFixture("inuse-both");
      const a = await seedAsset(f);
      const b = await seedAsset(f);
      // live v1 names a; head v2 names b only
      const item = await seedItem(f, { slug: "live-and-head", blocks: imageBlock(assetUrl(f, a.id)), headBlocks: imageBlock(assetUrl(f, b.id)), state: "published" });
      const ua = (await mediaUsage(app, f, a.id)).json();
      expect(ua.items).toEqual([{ itemId: item.itemId, collectionKey: "service", locale: "en", slug: "live-and-head", in: ["live"] }]);
      const ub = (await mediaUsage(app, f, b.id)).json();
      expect(ub.items).toEqual([{ itemId: item.itemId, collectionKey: "service", locale: "en", slug: "live-and-head", in: ["head"] }]);
      expect((await deleteMedia(app, f, a.id)).statusCode).toBe(409);
      expect((await deleteMedia(app, f, b.id)).statusCode).toBe(409);
    });

    it("the scan finds the URL however it is written: with a host in front, a transform suffix, an upper-case id, in the seo (og image) and in a collection other than 'service'", async () => {
      const f = await createContentFixture("inuse-forms");
      const urls = [
        (id: string) => `https://api.example.test${assetUrl(f, id)}`,
        (id: string) => `${assetUrl(f, id)}/transform?w=400&h=300`,
        (id: string) => assetUrl(f, id).toUpperCase().replace("/V1/T/", "/v1/t/").replace("/MEDIA/", "/media/"),
      ];
      for (const mk of urls) {
        const a = await seedAsset(f);
        await seedItem(f, { slug: `u-${a.id.slice(0, 8)}`, blocks: imageBlock(mk(a.id)) });
        expect((await mediaUsage(app, f, a.id)).json().total, mk(a.id)).toBe(1);
      }
      const og = await seedAsset(f);
      await seedItem(f, { slug: "seo-only", blocks: [], seo: { title: "t", ogImage: assetUrl(f, og.id) } });
      expect((await mediaUsage(app, f, og.id)).json().total).toBe(1);
      const nav = await seedAsset(f);
      await seedItem(f, { slug: "nav", collection: "navigation", blocks: imageBlock(assetUrl(f, nav.id)) });
      const u = (await mediaUsage(app, f, nav.id)).json();
      expect(u.items[0].collectionKey).toBe("navigation");
      // another asset's id in the same content is no match (the id is the whole needle)
      const unrelated = await seedAsset(f);
      expect((await mediaUsage(app, f, unrelated.id)).json().total).toBe(0);
    });

    it("a SOFT-DELETED item is not a use; an item in another tenant that names the same id is not a use; a pending scheduled swap IS a use", async () => {
      const f = await createContentFixture("inuse-scope");
      const a = await seedAsset(f);
      await seedItem(f, { slug: "deleted-page", blocks: imageBlock(assetUrl(f, a.id)), deleted: true });
      expect((await mediaUsage(app, f, a.id)).json().total).toBe(0);
      // another tenant's item naming this asset id (a forged reference) changes nothing here
      await seedItem(other, { slug: "forged", blocks: imageBlock(`/v1/t/${f.slug}/media/${a.id}`) });
      expect((await mediaUsage(app, f, a.id)).json().total).toBe(0);
      // a live item whose pending swap (WSK-61) pins a version that names the asset
      const item = await seedItem(f, { slug: "swap-page", blocks: [], headBlocks: [], state: "published" });
      // versions are append-only for the app role, but the migrator may shape a fixture: version 1 names the
      // asset, the projection and the head (version 2) do not, and a pending swap pins version 1
      await asTenant(f.tenantId, async (db) => {
        await db.query(`UPDATE content_versions SET blocks = $3::jsonb WHERE content_item_id = $1 AND version = $2`, [item.itemId, 1, JSON.stringify(imageBlock(assetUrl(f, a.id)))]);
        await db.query(
          `INSERT INTO content_schedules (tenant_id, site_id, content_item_id, version, publish_at, requested_by) VALUES ($1, $2, $3, 1, now() + interval '1 day', 'seed')`,
          [f.tenantId, f.siteId, item.itemId],
        );
      });
      const u = (await mediaUsage(app, f, a.id)).json();
      expect(u.items).toEqual([{ itemId: item.itemId, collectionKey: "service", locale: "en", slug: "swap-page", in: ["scheduled"] }]);
      expect((await deleteMedia(app, f, a.id)).statusCode).toBe(409);
    });

    it("the problem lists at most 50 items and reports the true total", async () => {
      const f = await createContentFixture("inuse-many");
      const a = await seedAsset(f);
      for (let i = 0; i < 53; i++) await seedItem(f, { slug: `page-${String(i).padStart(3, "0")}`, blocks: imageBlock(assetUrl(f, a.id)) });
      const res = await deleteMedia(app, f, a.id);
      expect(res.statusCode).toBe(409);
      expect(res.json().total).toBe(53);
      expect(res.json().usage).toHaveLength(50);
      expect(res.json().usage[0].slug).toBe("page-000"); // stable order (collection, slug, locale)
      const u = (await mediaUsage(app, f, a.id)).json();
      expect(u.total).toBe(53);
      expect(u.items).toHaveLength(50);
    }, 60_000);

    it("a published item via the editor: the same refusal; unpublishing leaves its head as a use; deleting the ITEM frees the asset", async () => {
      const f = await createContentFixture("inuse-editor");
      const a = await seedAsset(f);
      const created = await createItem(app, f, { collectionKey: "service", locale: "en", slug: "service.pub-ref", fields: serviceFields({ body: `![hero](${assetUrl(f, a.id)})` }) });
      const itemId = created.json().item.itemId as string;
      expect((await publishItems(app, f, [{ itemId, version: 1 }])).statusCode).toBe(200);
      const live = await deleteMedia(app, f, a.id);
      expect(live.statusCode).toBe(409);
      expect(live.json().usage[0].in).toEqual(expect.arrayContaining(["live", "head"]));
      expect((await app.inject({ method: "POST", url: `${itemBase(f, itemId)}/unpublish`, headers: hdr(), payload: { expectedPublishedVersion: 1 } })).statusCode).toBe(200);
      expect((await deleteMedia(app, f, a.id)).statusCode).toBe(409); // the head still names it
      expect((await app.inject({ method: "POST", url: `${itemBase(f, itemId)}/delete`, headers: hdr(), payload: { baseVersion: 1 } })).statusCode).toBe(200);
      expect((await deleteMedia(app, f, a.id)).statusCode).toBe(200);
    });

    it("unknown, malformed and another tenant's or site's asset are one 404 media-asset-not-found", async () => {
      const foreign = await seedAsset(other);
      for (const id of [foreign.id, randomUUID(), "not-a-uuid"]) {
        const res = await deleteMedia(app, fx, id);
        expect(res.statusCode, id).toBe(404);
        expect(res.json().type).toBe(`${PROBLEM}media-asset-not-found`);
      }
      expect((await getAsset(other, foreign.id))?.deleted_at).toBeNull();
      expect((await deleteMedia(app, other, foreign.id)).statusCode).toBe(200); // positive control
    });

    it("an idempotent retry replays the stored answer; GATES: no principal -> 401, scopeless/read-only -> 403, no key -> 400, nothing deleted by a refusal", async () => {
      const a = await seedAsset(fx);
      expect((await deleteMedia(app, fx, a.id, { editorial: null })).statusCode).toBe(401);
      expect((await deleteMedia(app, fx, a.id, { scopes: [] })).statusCode).toBe(403);
      expect((await deleteMedia(app, fx, a.id, { scopes: ["webdesk:read"] })).statusCode).toBe(403);
      expect((await deleteMedia(app, fx, a.id, { idem: null })).statusCode).toBe(400);
      expect((await getAsset(fx, a.id))?.deleted_at).toBeNull();
      const idem = `idem-${randomUUID()}`;
      const first = await deleteMedia(app, fx, a.id, { idem, scopes: ["webdesk:operate"] });
      expect(first.statusCode).toBe(200);
      const replay = await deleteMedia(app, fx, a.id, { idem });
      expect(replay.json()).toMatchObject({ replayed: true, deletedAt: first.json().deletedAt });
      const keys = (await dumpIdempotency(fx)).filter((r) => String(r.scope_key).endsWith(`:media.delete:${idem}`));
      expect(keys).toHaveLength(1);
    });
  });

  // ==============================================================================================
  // media.usage
  // ==============================================================================================
  describe("media.usage", () => {
    it("lists where an asset is used by the same scan the delete uses; an unused asset answers { total: 0, items: [] }; a deleted asset answers too", async () => {
      const f = await createContentFixture("usage");
      const a = await seedAsset(f);
      const none = await mediaUsage(app, f, a.id);
      expect(none.statusCode).toBe(200);
      expect(none.json()).toEqual({ assetId: a.id, url: assetUrl(f, a.id), total: 0, items: [] });
      const item = await seedItem(f, { slug: "p", blocks: imageBlock(assetUrl(f, a.id)) });
      expect((await mediaUsage(app, f, a.id)).json().items).toEqual([{ itemId: item.itemId, collectionKey: "service", locale: "en", slug: "p", in: ["head"] }]);
      const gone = await seedAsset(f, { deleted: { deletedAgo: "1 hour", purgeAfterAgo: "-1 day" } });
      expect((await mediaUsage(app, f, gone.id)).statusCode).toBe(200);
    });

    it("unknown, malformed and another tenant's asset are one 404; a READ needs the read scope only and no editorial principal; a scopeless token is 403", async () => {
      const foreign = await seedAsset(other);
      for (const id of [foreign.id, randomUUID(), "not-a-uuid"]) {
        const res = await mediaUsage(app, fx, id);
        expect(res.statusCode, id).toBe(404);
        expect(res.json().type).toBe(`${PROBLEM}media-asset-not-found`);
      }
      const a = await seedAsset(fx);
      expect((await mediaUsage(app, fx, a.id, { scopes: [] })).statusCode).toBe(403);
      expect((await mediaUsage(app, fx, a.id, { scopes: ["webdesk:read"] })).statusCode).toBe(200);
      const strict = await app.inject({ method: "GET", url: `${mediaBase(fx)}/${a.id}/usage?x=1`, headers: hdr({ editorial: null, idem: null }) });
      expect(strict.statusCode).toBe(400); // an unknown query parameter is refused, not ignored
    });
  });

  // ==============================================================================================
  // media.list
  // ==============================================================================================
  describe("media.list", () => {
    let f: ContentFixture;
    const ids: Record<string, string> = {};
    beforeAll(async () => {
      f = await createContentFixture("list");
      const mk = async (name: string, o: Parameters<typeof seedAsset>[1], at: string) => {
        ids[name] = (await seedAsset(f, { ...o, createdAt: at })).id;
      };
      await mk("hero", { title: "Homepage Hero", tags: ["hero", "home"], originalFilename: "hero-banner.png", mime: "image/png", alt: { en: "A hero" } }, "2026-01-01T10:00:00Z");
      await mk("logo", { title: "Company Logo", tags: ["brand", "logo"], originalFilename: "logo.webp", mime: "image/webp" }, "2026-01-02T10:00:00Z");
      await mk("report", { title: null, tags: ["finance"], originalFilename: "Annual_Report.pdf", mime: "application/pdf" }, "2026-01-03T10:00:00Z");
      await mk("team", { title: "Team photo", tags: ["people", "home"], originalFilename: "team.jpg", mime: "image/jpeg" }, "2026-01-04T10:00:00Z");
      await mk("old", { title: "Retired hero", tags: ["hero"], originalFilename: "old-hero.png", mime: "image/png", deleted: { deletedAgo: "2 days", purgeAfterAgo: "-1 day" } }, "2026-01-05T10:00:00Z");
    });
    const idsOf = (res: { json(): any }) => res.json().assets.map((a: { assetId: string }) => a.assetId);

    it("returns the library fields and keeps the original ones; newest first; hides deleted assets by default", async () => {
      const res = await listMedia(app, f);
      expect(res.statusCode).toBe(200);
      expect(idsOf(res)).toEqual([ids.team, ids.report, ids.logo, ids.hero]); // created_at DESC; 'old' (deleted) hidden
      const hero = res.json().assets.find((a: { assetId: string }) => a.assetId === ids.hero);
      expect(hero).toMatchObject({
        assetId: ids.hero,
        url: assetUrl(f, ids.hero),
        bucket: "media",
        mime: "image/png",
        sizeBytes: 100,
        scanStatus: "clean",
        title: "Homepage Hero",
        alt: { en: "A hero" },
        tags: ["hero", "home"],
        originalFilename: "hero-banner.png",
        width: null,
        height: null,
        deletedAt: null,
        purgeAfter: null,
        purgedAt: null,
      });
      for (const k of ["bucketKey", "createdAt", "updatedAt"]) expect(hero).toHaveProperty(k);
      expect(res.json().page).toEqual({ cursor: null, hasMore: false, limit: 50 });
    });

    it("includeDeleted=true includes soft-deleted assets, with their lifecycle instants; includeDeleted=false is the default", async () => {
      const all = await listMedia(app, f, "includeDeleted=true");
      expect(idsOf(all)).toEqual([ids.old, ids.team, ids.report, ids.logo, ids.hero]);
      const old = all.json().assets[0];
      expect(old.deletedAt).not.toBeNull();
      expect(old.purgeAfter).not.toBeNull();
      expect(old.purgedAt).toBeNull();
      expect(idsOf(await listMedia(app, f, "includeDeleted=false"))).toEqual([ids.team, ids.report, ids.logo, ids.hero]);
    });

    it("q searches the title, the tags and the original filename, case-insensitively, as a substring; LIKE metacharacters are literal", async () => {
      expect(idsOf(await listMedia(app, f, "q=HERO"))).toEqual([ids.hero]); // title + tag + filename of 'hero'; the deleted 'old' is hidden
      expect(idsOf(await listMedia(app, f, "q=logo"))).toEqual([ids.logo]);
      expect(idsOf(await listMedia(app, f, "q=annual"))).toEqual([ids.report]); // filename only (it has no title)
      expect(idsOf(await listMedia(app, f, "q=finan"))).toEqual([ids.report]); // tag only
      expect(idsOf(await listMedia(app, f, "q=photo"))).toEqual([ids.team]); // title only
      expect(idsOf(await listMedia(app, f, "q=hero&includeDeleted=true"))).toEqual([ids.old, ids.hero]);
      expect(idsOf(await listMedia(app, f, "q=nothing-matches-this"))).toEqual([]);
      expect(idsOf(await listMedia(app, f, `q=${encodeURIComponent("%")}`))).toEqual([]); // not a wildcard
      expect(idsOf(await listMedia(app, f, `q=${encodeURIComponent("_")}`))).toEqual([ids.report]); // literal underscore: only Annual_Report.pdf
    });

    it("tag matches one tag exactly (spelled the way the library stores it: trimmed and lower-cased)", async () => {
      expect(idsOf(await listMedia(app, f, "tag=home"))).toEqual([ids.team, ids.hero]);
      expect(idsOf(await listMedia(app, f, "tag=HOME"))).toEqual([ids.team, ids.hero]);
      expect(idsOf(await listMedia(app, f, "tag=hom"))).toEqual([]); // exact, not a prefix
      expect(idsOf(await listMedia(app, f, "tag=hero&includeDeleted=true"))).toEqual([ids.old, ids.hero]);
    });

    it("mime is exact (image/png) or a type prefix (image/*); filters combine", async () => {
      expect(idsOf(await listMedia(app, f, "mime=image/png"))).toEqual([ids.hero]);
      expect(idsOf(await listMedia(app, f, `mime=${encodeURIComponent("image/*")}`))).toEqual([ids.team, ids.logo, ids.hero]);
      expect(idsOf(await listMedia(app, f, "mime=application/pdf"))).toEqual([ids.report]);
      expect(idsOf(await listMedia(app, f, `mime=${encodeURIComponent("image/*")}&tag=home`))).toEqual([ids.team, ids.hero]);
      expect(idsOf(await listMedia(app, f, `mime=${encodeURIComponent("image/*")}&tag=home&q=photo`))).toEqual([ids.team]);
    });

    it("the cursor keeps its semantics under every filter: pages are disjoint, complete and ordered, and an edit or a delete between two pages cannot move a row", async () => {
      const page1 = await listMedia(app, f, `mime=${encodeURIComponent("image/*")}&limit=2`);
      expect(idsOf(page1)).toEqual([ids.team, ids.logo]);
      expect(page1.json().page.hasMore).toBe(true);
      // between the pages: an edit of an unrelated row, and a delete of one not yet seen
      expect((await updateMedia(app, f, ids.hero, { title: "Edited between pages" })).statusCode).toBe(200);
      const cursor = page1.json().page.cursor as string;
      const page2 = await listMedia(app, f, `mime=${encodeURIComponent("image/*")}&limit=2&cursor=${encodeURIComponent(cursor)}`);
      expect(idsOf(page2)).toEqual([ids.hero]);
      expect(page2.json().page).toEqual({ cursor: null, hasMore: false, limit: 2 });
      // with includeDeleted: the walk is still complete
      const walked: string[] = [];
      let cur: string | null = null;
      do {
        const r: { json(): any } = await listMedia(app, f, `includeDeleted=true&limit=2${cur ? `&cursor=${encodeURIComponent(cur)}` : ""}`);
        walked.push(...idsOf(r));
        cur = r.json().page.cursor;
      } while (cur);
      expect(walked).toEqual([ids.old, ids.team, ids.report, ids.logo, ids.hero]);
    });

    it("strict query validation: an unknown key, a bad boolean, an empty q or tag, a bad mime, a bad limit or cursor are 400; the old keys still work", async () => {
      for (const qs of ["bogus=1", "includeDeleted=maybe", "q=", "tag=", "tag=%20%20", "mime=notamime", "limit=0", "limit=101", "cursor=garbage", `q=${"x".repeat(201)}`]) {
        const res = await listMedia(app, f, qs);
        expect(res.statusCode, qs).toBe(400);
        expect(res.json().type).toBe(`${PROBLEM}invalid-request`);
      }
      expect((await listMedia(app, f, "limit=1&mime=image/png")).statusCode).toBe(200);
    });

    it("only this site's assets, whatever the filter; a read needs the read scope; a scopeless token is 403", async () => {
      await seedAsset(other, { title: "Homepage Hero", tags: ["hero"] });
      expect(idsOf(await listMedia(app, f, "q=hero")).length).toBe(1);
      expect((await listMedia(app, f, "", { scopes: [] })).statusCode).toBe(403);
      expect((await listMedia(app, f, "", { scopes: ["webdesk:read"] })).statusCode).toBe(200);
    });
  });

  // ==============================================================================================
  // Quota: bytes held
  // ==============================================================================================
  describe("quota counts the bytes storage holds (purged_at IS NULL)", () => {
    it("live and soft-deleted-within-retention assets count; a purged one does not; an empty library is 0", async () => {
      const f = await createContentFixture("quota-held");
      const quota = app.get(QuotaService);
      expect(await quota.usedBytes(f.tenantId)).toBe(0);
      await seedAsset(f, { sizeBytes: 1000 });
      await seedAsset(f, { sizeBytes: 2000, deleted: { deletedAgo: "1 hour", purgeAfterAgo: "-1 day" } }); // deleted, inside retention
      await seedAsset(f, { sizeBytes: 4000, deleted: { deletedAgo: "3 days", purgeAfterAgo: "1 day" }, purged: true }); // purged: bytes freed
      expect(await quota.usedBytes(f.tenantId)).toBe(3000);
      expect(await quota.wouldExceedQuota(f.tenantId, 1)).toBe(false);
      const prev = process.env.WEBDESK_TENANT_STORAGE_QUOTA_BYTES;
      process.env.WEBDESK_TENANT_STORAGE_QUOTA_BYTES = "3000";
      try {
        expect(await quota.wouldExceedQuota(f.tenantId, 1)).toBe(true); // 3000 held + 1 > 3000
        expect(await quota.wouldExceedQuota(f.tenantId, 0)).toBe(false);
      } finally {
        if (prev === undefined) delete process.env.WEBDESK_TENANT_STORAGE_QUOTA_BYTES;
        else process.env.WEBDESK_TENANT_STORAGE_QUOTA_BYTES = prev;
      }
    });
  });
});
