// WSK-41 — the content authoring commands, end to end (write-plane design §2.6, §3; rulings
// WSK-D45/D46), against a real Postgres (0001-0009), real Redis, the real AppModule and the REAL
// Layer-3/4 PolicyDecisionPoint (see content-test-kit.ts). Done-when items covered here:
//   (1) draft isolation   (2) unpublish / delete   (3) concurrency   (4) durable idempotency
//   (7) composition cases (8) events                + schema.apply validation and bump
// Gate order and WS4 single-use (5, 6) are in content-commands-gates.spec.ts.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // the local HTTPS webhook sink's self-signed cert (test-only)
process.env.TENANT_WEBHOOK_QUEUE_NAME = `wsk41-content-${Date.now()}`;
process.env.TENANT_WEBHOOK_BACKOFF_DELAY_MS = "200";
process.env.TENANT_WEBHOOK_MAX_ATTEMPTS = "2";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  asTenant,
  base,
  buildContentApp,
  createContentFixture,
  createItem,
  hdr,
  mintReadKeys,
  publishItems,
  serviceFields,
  v1Get,
  waitFor,
  ws4For,
  type ContentFixture,
} from "./content-test-kit";
import { TenantWebhooksService } from "../src/tenant-webhooks/tenant-webhooks.service";
import { mapDbError } from "../src/control/content/content-commands.service";
import { ControlProblem } from "../src/control/content/content-problem";
import { TenantWebhookSink } from "./helpers/tenant-webhook-sink";

const PROBLEM = "https://webdesk.gaiada.online/errors/";

describe("WSK-41 content commands (real DB + real PDP)", () => {
  let app: NestFastifyApplication;
  let fx: ContentFixture;
  let keys: { production: string; staging: string };

  beforeAll(async () => {
    app = await buildContentApp();
    fx = await createContentFixture("cmd");
    keys = await mintReadKeys(app, fx);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ==============================================================================================
  // (1) Draft isolation
  // ==============================================================================================
  it("(1) draft isolation: an update to a live item is not live until it is published; updatedAt moves only on publish", async () => {
    const created = await createItem(app, fx, {
      collectionKey: "service",
      locale: "en",
      slug: "service.seo",
      fields: serviceFields({ h1: "H1 v1" }),
      seo: { title: "SEO v1", description: "d" },
    });
    expect(created.statusCode).toBe(201);
    const c = created.json();
    expect(c.item).toMatchObject({ headVersion: 1, publishedVersion: null, publishState: "draft", collectionKey: "service", locale: "en" });
    expect(c.version.version).toBe(1);
    expect(c.version.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(c.unchanged).toBe(false);
    expect(c.replayed).toBe(false);
    const itemId = c.item.itemId as string;

    // A draft: production 404, staging serves the head.
    expect((await v1Get(app, fx, keys.production, "service", "service.seo")).statusCode).toBe(404);
    const stagingDraft = await v1Get(app, fx, keys.staging, "service", "service.seo");
    expect(stagingDraft.statusCode).toBe(200);
    expect(stagingDraft.json().blocks[0]).toEqual({ type: "fields", props: serviceFields({ h1: "H1 v1" }) });

    // Publish v1.
    const pub1 = await publishItems(app, fx, [{ itemId, version: 1 }]);
    expect(pub1.statusCode).toBe(200);
    expect(pub1.json().published).toEqual([
      expect.objectContaining({ itemId, collectionKey: "service", locale: "en", slug: "service.seo", version: 1 }),
    ]);
    const live1 = await v1Get(app, fx, keys.production, "service", "service.seo");
    expect(live1.statusCode).toBe(200);
    expect(live1.json().blocks[0].props.h1).toBe("H1 v1");
    const updatedAt1 = live1.json().meta.updatedAt as string;

    // Update to v2 while v1 is live.
    await new Promise((r) => setTimeout(r, 20));
    const upd = await app.inject({
      method: "PUT",
      url: `${base(fx)}/items/${itemId}`,
      headers: hdr(),
      payload: { baseVersion: 1, fields: serviceFields({ h1: "H1 v2" }), seo: { title: "SEO v2", description: "d" }, note: "v2" },
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().item).toMatchObject({ headVersion: 2, publishedVersion: 1, publishState: "published" });

    // Production AND staging still serve v1 (the item is live: the projection is the published version).
    const prodAfterUpdate = await v1Get(app, fx, keys.production, "service", "service.seo");
    expect(prodAfterUpdate.json().blocks[0].props.h1).toBe("H1 v1");
    expect(prodAfterUpdate.json().seo.title).toBe("SEO v1");
    expect(prodAfterUpdate.json().meta.updatedAt).toBe(updatedAt1);
    const stagingAfterUpdate = await v1Get(app, fx, keys.staging, "service", "service.seo");
    expect(stagingAfterUpdate.json().blocks[0].props.h1).toBe("H1 v1");

    // Publish v2: production serves v2 and updatedAt moved.
    await new Promise((r) => setTimeout(r, 20));
    const pub2 = await publishItems(app, fx, [{ itemId, version: 2 }]);
    expect(pub2.statusCode).toBe(200);
    const live2 = await v1Get(app, fx, keys.production, "service", "service.seo");
    expect(live2.json().blocks[0].props.h1).toBe("H1 v2");
    expect(live2.json().seo.title).toBe("SEO v2");
    expect(Date.parse(live2.json().meta.updatedAt)).toBeGreaterThan(Date.parse(updatedAt1));

    // Versions are the working copy: exactly 1, 2; created_by is the editorial sub, not the service.
    const versions = await asTenant(fx.tenantId, async (db) =>
      (await db.query(`SELECT version, created_by, content_hash, attribution FROM content_versions WHERE content_item_id = $1 ORDER BY version`, [itemId])).rows,
    );
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions.every((v) => v.created_by === "user-editor-1")).toBe(true);
    expect(versions[0].attribution).toEqual({ pk: "human" });
    const row = await asTenant(fx.tenantId, async (db) =>
      (await db.query(`SELECT head_version, published_version, last_published_by FROM content_items WHERE id = $1`, [itemId])).rows[0],
    );
    expect(row).toEqual({ head_version: 2, published_version: 2, last_published_by: "user-editor-1" });
  });

  // ==============================================================================================
  // (2) Unpublish and delete
  // ==============================================================================================
  it("(2) unpublish: production 404, staging serves the HEAD; delete refuses a live item and soft-deletes a draft", async () => {
    const c = (await createItem(app, fx, { collectionKey: "service", locale: "en", slug: "service.unpub", fields: serviceFields({ h1: "U1" }) })).json();
    const itemId = c.item.itemId as string;
    expect((await publishItems(app, fx, [{ itemId, version: 1 }])).statusCode).toBe(200);
    const upd = await app.inject({
      method: "PUT",
      url: `${base(fx)}/items/${itemId}`,
      headers: hdr(),
      payload: { baseVersion: 1, fields: serviceFields({ h1: "U2 head" }) },
    });
    expect(upd.statusCode).toBe(200);

    // delete of a LIVE item -> 409 item-is-live, nothing changed
    const delLive = await app.inject({ method: "POST", url: `${base(fx)}/items/${itemId}/delete`, headers: hdr(), payload: { baseVersion: 2 } });
    expect(delLive.statusCode).toBe(409);
    expect(delLive.json().type).toBe(`${PROBLEM}item-is-live`);
    expect(delLive.headers["content-type"]).toContain("application/problem+json");

    // wrong expectedPublishedVersion -> 409 published-version-changed
    const stale = await app.inject({ method: "POST", url: `${base(fx)}/items/${itemId}/unpublish`, headers: hdr(), payload: { expectedPublishedVersion: 2 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().type).toBe(`${PROBLEM}published-version-changed`);

    const un = await app.inject({ method: "POST", url: `${base(fx)}/items/${itemId}/unpublish`, headers: hdr(), payload: { expectedPublishedVersion: 1 } });
    expect(un.statusCode).toBe(200);
    expect(un.json().item).toMatchObject({ publishState: "unpublished", publishedVersion: null, headVersion: 2 });
    expect((await v1Get(app, fx, keys.production, "service", "service.unpub")).statusCode).toBe(404);
    const staging = await v1Get(app, fx, keys.staging, "service", "service.unpub");
    expect(staging.statusCode).toBe(200);
    expect(staging.json().blocks[0].props.h1).toBe("U2 head");

    // A second unpublish: not live.
    const again = await app.inject({ method: "POST", url: `${base(fx)}/items/${itemId}/unpublish`, headers: hdr(), payload: { expectedPublishedVersion: 1 } });
    expect(again.statusCode).toBe(409);
    expect(again.json().type).toBe(`${PROBLEM}not-live`);

    // Delete the (now draft) item: soft delete, history kept.
    const delStale = await app.inject({ method: "POST", url: `${base(fx)}/items/${itemId}/delete`, headers: hdr(), payload: { baseVersion: 1 } });
    expect(delStale.statusCode).toBe(409);
    expect(delStale.json().type).toBe(`${PROBLEM}version-conflict`);
    const del = await app.inject({ method: "POST", url: `${base(fx)}/items/${itemId}/delete`, headers: hdr(), payload: { baseVersion: 2 } });
    expect(del.statusCode).toBe(200);
    expect(del.json().item.deletedAt).not.toBeNull();
    const dbRow = await asTenant(fx.tenantId, async (db) =>
      (await db.query(`SELECT deleted_at IS NOT NULL AS deleted, (SELECT count(*)::int FROM content_versions WHERE content_item_id = $1) AS versions FROM content_items WHERE id = $1`, [itemId])).rows[0],
    );
    expect(dbRow).toEqual({ deleted: true, versions: 2 });
    // A deleted item takes no further writes.
    const updDeleted = await app.inject({ method: "PUT", url: `${base(fx)}/items/${itemId}`, headers: hdr(), payload: { baseVersion: 2, fields: serviceFields() } });
    expect(updDeleted.statusCode).toBe(409);
    expect(updDeleted.json().type).toBe(`${PROBLEM}item-deleted`);
    // The deleted row leaves the localization group's live set (ux_content_items_group_locale is over
    // deleted_at IS NULL): a new item may take that locale in the same group.
    const live = await asTenant(fx.tenantId, async (db) =>
      (await db.query(`SELECT count(*)::int AS n FROM content_items WHERE id = $1 AND deleted_at IS NULL`, [itemId])).rows[0].n,
    );
    expect(live).toBe(0);
  });

  // ==============================================================================================
  // (3) Concurrency
  // ==============================================================================================
  it("(3) 10 parallel updates on the same baseVersion: exactly one 200 and nine 409 version-conflict, no version gaps", async () => {
    const c = (await createItem(app, fx, { collectionKey: "service", locale: "en", slug: "service.race", fields: serviceFields() })).json();
    const itemId = c.item.itemId as string;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        app.inject({
          method: "PUT",
          url: `${base(fx)}/items/${itemId}`,
          headers: hdr(),
          payload: { baseVersion: 1, fields: serviceFields({ h1: `racer ${i}` }) },
        }),
      ),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((s) => s === 200)).toHaveLength(1);
    expect(codes.filter((s) => s === 409)).toHaveLength(9);
    for (const r of results.filter((x) => x.statusCode === 409)) {
      expect(r.json().type).toBe(`${PROBLEM}version-conflict`);
      expect(r.json().currentHeadVersion).toBe(2);
      expect(r.json().currentContentHash).toMatch(/^[0-9a-f]{64}$/);
    }
    const versions = await asTenant(fx.tenantId, async (db) =>
      (await db.query(`SELECT version FROM content_versions WHERE content_item_id = $1 ORDER BY version`, [itemId])).rows.map((r) => r.version),
    );
    expect(versions).toEqual([1, 2]);
  });

  // ==============================================================================================
  // (4) Durable idempotency
  // ==============================================================================================
  it("(4) same key + same body twice -> one version and replayed:true, still replayed after an app restart; same key + other body -> 409", async () => {
    const idem = `wsk41-idem-${randomUUID()}`;
    const body = { collectionKey: "service", locale: "en", slug: "service.idem", fields: serviceFields({ h1: "idem" }) };
    const first = await createItem(app, fx, body, { idem });
    const second = await createItem(app, fx, body, { idem });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().replayed).toBe(false);
    expect(second.json().replayed).toBe(true);
    expect(second.json().item.itemId).toBe(first.json().item.itemId);
    const { replayed: _a, ...firstRest } = first.json();
    const { replayed: _b, ...secondRest } = second.json();
    expect(secondRest).toEqual(firstRest);

    // Restart: a brand-new app process state; the store is the database.
    await app.close();
    app = await buildContentApp();
    const third = await createItem(app, fx, body, { idem });
    expect(third.statusCode).toBe(201);
    expect(third.json().replayed).toBe(true);
    expect(third.json().item.itemId).toBe(first.json().item.itemId);

    const reused = await createItem(app, fx, { ...body, slug: "service.idem-other" }, { idem });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().type).toBe(`${PROBLEM}idempotency-key-reused`);

    const db = await asTenant(fx.tenantId, async (c) => ({
      items: (await c.query(`SELECT count(*)::int AS n FROM content_items WHERE slug IN ('service.idem', 'service.idem-other')`)).rows[0].n,
      versions: (await c.query(`SELECT count(*)::int AS n FROM content_versions WHERE content_item_id = $1`, [first.json().item.itemId])).rows[0].n,
      key: (await c.query(`SELECT status, command FROM control_idempotency_keys WHERE scope_key = $1`, [`${fx.slug}:content.create:${idem}`])).rows,
      audits: (await c.query(`SELECT action FROM audit_entries WHERE args_hash IS NOT NULL AND action LIKE 'control.content.create%' AND actor = 'user-editor-1' AND tenant_id = $1`, [fx.tenantId])).rows.map((r) => r.action),
    }));
    expect(db.items).toBe(1);
    expect(db.versions).toBe(1);
    expect(db.key).toEqual([{ status: "completed", command: "content.create" }]);
    expect(db.audits.filter((a) => a === "control.content.create.replay").length).toBeGreaterThanOrEqual(2);
  });

  // ==============================================================================================
  // (7) Composition cases
  // ==============================================================================================
  it("(7a) singleton: a second item in the same locale -> 409 singleton-exists; the other locale is free", async () => {
    const en = await createItem(app, fx, { collectionKey: "navigation", locale: "en", slug: "navigation", fields: { cta: "Get your free audit" } });
    expect(en.statusCode).toBe(201);
    const dup = await createItem(app, fx, { collectionKey: "navigation", locale: "en", slug: "navigation-two", fields: { cta: "x" } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().type).toBe(`${PROBLEM}singleton-exists`);
    const id = await createItem(app, fx, {
      collectionKey: "navigation",
      locale: "id",
      slug: "navigation",
      twinOf: en.json().item.itemId,
      fields: { cta: "Dapatkan audit gratis" },
    });
    expect(id.statusCode).toBe(201);
    expect(id.json().item.localizationGroupId).toBe(en.json().item.localizationGroupId);
  });

  it("(7b) localized:false: an item outside the default locale -> 422 at /locale; the default locale -> 201", async () => {
    const bad = await createItem(app, fx, { collectionKey: "company", locale: "id", slug: "company", fields: { name: "Gaia" } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().type).toBe(`${PROBLEM}composition-violation`);
    expect(bad.json().issues.map((i: { path: string }) => i.path)).toContain("/locale");
    const good = await createItem(app, fx, { collectionKey: "company", locale: "en", slug: "company", fields: { name: "Gaia" } });
    expect(good.statusCode).toBe(201);
    // a locale the tenant does not declare at all
    const undeclared = await createItem(app, fx, { collectionKey: "service", locale: "fr", slug: "service.fr", fields: serviceFields() });
    expect(undeclared.statusCode).toBe(422);
    expect(undeclared.json().issues[0].path).toBe("/locale");
  });

  it("(7c) twins: a second item in the group's taken locale -> 409 twin-locale-taken; twinOf across collections -> 422", async () => {
    const en = (await createItem(app, fx, { collectionKey: "service", locale: "en", slug: "service.twin", fields: serviceFields() })).json();
    const id1 = await createItem(app, fx, { collectionKey: "service", locale: "id", slug: "service.twin", twinOf: en.item.itemId, fields: serviceFields() });
    expect(id1.statusCode).toBe(201);
    const id2 = await createItem(app, fx, { collectionKey: "service", locale: "id", slug: "service.twin-b", twinOf: en.item.itemId, fields: serviceFields() });
    expect(id2.statusCode).toBe(409);
    expect(id2.json().type).toBe(`${PROBLEM}twin-locale-taken`);
    const nav = (await createItem(app, fx, { collectionKey: "service", locale: "en", slug: "service.slug-taken", fields: serviceFields() })).json();
    const slugTaken = await createItem(app, fx, { collectionKey: "service", locale: "en", slug: "service.slug-taken", fields: serviceFields() });
    expect(slugTaken.statusCode).toBe(409);
    expect(slugTaken.json().type).toBe(`${PROBLEM}slug-taken`);
    const crossCollection = await createItem(app, fx, {
      collectionKey: "redirect",
      locale: "en",
      slug: "/cross",
      twinOf: nav.item.itemId,
      fields: { toPath: "/x", status: "301", active: "true" },
    });
    expect(crossCollection.statusCode).toBe(422);
    expect(crossCollection.json().issues[0].path).toBe("/twinOf");
  });

  it("(7d) redirect is a system collection: values stored under seo.redirect with blocks [], never validateItemContent", async () => {
    const ok = await createItem(app, fx, {
      collectionKey: "redirect",
      locale: "en",
      slug: "/old-path/",
      fields: { toPath: "/new-path/", status: "301", active: "true" },
    });
    expect(ok.statusCode).toBe(201);
    const stored = await asTenant(fx.tenantId, async (db) =>
      (await db.query(`SELECT blocks, seo FROM content_items WHERE id = $1`, [ok.json().item.itemId])).rows[0],
    );
    expect(stored.blocks).toEqual([]);
    expect(stored.seo).toEqual({ redirect: { toPath: "/new-path/", status: "301", active: "true" } });

    const badStatus = await createItem(app, fx, { collectionKey: "redirect", locale: "en", slug: "/bad/", fields: { toPath: "/x", status: "999", active: "true" } });
    expect(badStatus.statusCode).toBe(422);
    expect(badStatus.json().issues.map((i: { path: string }) => i.path)).toContain("/seo/redirect/status");
    const withBlocks = await createItem(app, fx, {
      collectionKey: "redirect",
      locale: "en",
      slug: "/blocks/",
      fields: { toPath: "/x" },
      blocks: [{ type: "richText", props: { content: "x" } }],
    });
    expect(withBlocks.statusCode).toBe(422);
    expect(withBlocks.json().issues.map((i: { path: string }) => i.path)).toContain("/blocks");
    const notAPath = await createItem(app, fx, { collectionKey: "redirect", locale: "en", slug: "no-slash", fields: { toPath: "/x" } });
    expect(notAPath.statusCode).toBe(422);
  });

  it("(7g) WSK-D51: a soft-deleted item releases its slug. create -> delete -> create again succeeds; two LIVE items with one slug are still refused", async () => {
    const slug = "service.d51-release";
    const first = await createItem(app, fx, { collectionKey: "service", locale: "en", slug, fields: serviceFields({ h1: "first" }) });
    expect(first.statusCode).toBe(201);
    const firstId = first.json().item.itemId as string;

    const del = await app.inject({ method: "POST", url: `${base(fx)}/items/${firstId}/delete`, headers: hdr(), payload: { baseVersion: 1 } });
    expect(del.statusCode).toBe(200);
    expect(del.json().item.deletedAt).not.toBeNull();

    // The slug of a soft-deleted item is free again (this was 409 slug-taken against an invisible row).
    const again = await createItem(app, fx, { collectionKey: "service", locale: "en", slug, fields: serviceFields({ h1: "second" }) });
    expect(again.statusCode).toBe(201);
    const secondId = again.json().item.itemId as string;
    expect(secondId).not.toBe(firstId);
    expect(again.json().item).toMatchObject({ slug, headVersion: 1, publishedVersion: null, publishState: "draft", deletedAt: null });

    // Two LIVE items with one slug: still refused, as a problem, and nothing was written.
    const third = await createItem(app, fx, { collectionKey: "service", locale: "en", slug, fields: serviceFields({ h1: "third" }) });
    expect(third.statusCode).toBe(409);
    expect(third.json().type).toBe(`${PROBLEM}slug-taken`);
    expect(third.headers["content-type"]).toContain("application/problem+json");

    const rows = await asTenant(fx.tenantId, async (db) =>
      (
        await db.query(
          `SELECT ci.id, ci.deleted_at IS NULL AS live, (SELECT count(*)::int FROM content_versions v WHERE v.content_item_id = ci.id) AS versions
             FROM content_items ci JOIN collections c ON c.id = ci.collection_id
            WHERE ci.site_id = $1 AND c.key = 'service' AND ci.locale = 'en' AND ci.slug = $2 ORDER BY ci.created_at`,
          [fx.siteId, slug],
        )
      ).rows,
    );
    // The deleted item and its history are untouched; exactly one live row holds the slug.
    expect(rows).toEqual([
      { id: firstId, live: false, versions: 1 },
      { id: secondId, live: true, versions: 1 },
    ]);
  });

  it("(7h) WSK-D51: mapDbError names ux_content_items_slug_live as slug-taken, and the pre-0010 constraint name no longer exists to map", () => {
    const mapped = mapDbError({ code: "23505", constraint: "ux_content_items_slug_live" });
    expect(mapped).toBeInstanceOf(ControlProblem);
    expect((mapped as ControlProblem).getStatus()).toBe(409);
    expect((mapped as ControlProblem).slug).toBe("slug-taken");
    // 0010 dropped content_items_collection_id_locale_slug_key; an error naming it is not ours to translate.
    const stale = { code: "23505", constraint: "content_items_collection_id_locale_slug_key" };
    expect(mapDbError(stale)).toBe(stale);
  });

  it("(7e) write-time validation: unknown block type, missing required field, bad slug and unknown field -> 422 with JSON-pointer issues", async () => {
    const unknownBlock = await createItem(app, fx, {
      collectionKey: "service",
      locale: "en",
      slug: "service.unknown-block",
      fields: serviceFields(),
      blocks: [{ type: "mystery", props: {} }],
    });
    expect(unknownBlock.statusCode).toBe(422);
    expect(unknownBlock.json().issues).toEqual([expect.objectContaining({ path: "/blocks/1/type" })]);

    const { url: _drop, ...noUrl } = serviceFields();
    const missing = await createItem(app, fx, { collectionKey: "service", locale: "en", slug: "service.missing", fields: noUrl });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().issues.map((i: { path: string }) => i.path)).toContain("/blocks/0/props/url");

    const badSlug = await createItem(app, fx, { collectionKey: "service", locale: "en", slug: "Service SEO", fields: serviceFields() });
    expect(badSlug.statusCode).toBe(422);
    expect(badSlug.json().issues[0].path).toBe("/slug");

    const unknownField = await createItem(app, fx, { collectionKey: "service", locale: "en", slug: "service.extra", fields: serviceFields({ extra: 1 }) });
    expect(unknownField.statusCode).toBe(422);
    expect(unknownField.json().issues.map((i: { path: string }) => i.path)).toContain("/blocks/0/props/extra");

    const dupKey = await createItem(app, fx, {
      collectionKey: "service",
      locale: "en",
      slug: "service.dupkey",
      fields: serviceFields({ faq: [{ key: "a" }, { key: "a" }] }),
    });
    expect(dupKey.statusCode).toBe(422);

    const nothingWritten = await asTenant(fx.tenantId, async (db) =>
      (await db.query(`SELECT count(*)::int AS n FROM content_items WHERE slug IN ('service.unknown-block','service.missing','service.extra','service.dupkey')`)).rows[0].n,
    );
    expect(nothingWritten).toBe(0);

    const missingCollection = await createItem(app, fx, { collectionKey: "nope", locale: "en", slug: "x", fields: {} });
    expect(missingCollection.statusCode).toBe(404);
    expect(missingCollection.json().type).toBe(`${PROBLEM}collection-not-found`);
    const reserved = await createItem(app, fx, { collectionKey: "service", locale: "en", slug: "service.r", siteId: fx.siteId, fields: serviceFields() });
    expect(reserved.statusCode).toBe(400);
    expect(reserved.json().type).toBe(`${PROBLEM}invalid-request`);
  });

  it("(7f) restoreVersion appends a new head from an old version; unchanged content writes nothing; a missing version -> 409", async () => {
    const c = (await createItem(app, fx, { collectionKey: "service", locale: "en", slug: "service.restore", fields: serviceFields({ h1: "R1" }) })).json();
    const itemId = c.item.itemId as string;
    const put = (baseVersion: number, h1: string) =>
      app.inject({ method: "PUT", url: `${base(fx)}/items/${itemId}`, headers: hdr(), payload: { baseVersion, fields: serviceFields({ h1 }) } });
    expect((await put(1, "R2")).statusCode).toBe(200);
    const same = await put(2, "R2");
    expect(same.statusCode).toBe(200);
    expect(same.json().unchanged).toBe(true);
    expect(same.json().version.version).toBe(2);

    const restore = await app.inject({ method: "POST", url: `${base(fx)}/items/${itemId}/restore`, headers: hdr(), payload: { version: 1, baseVersion: 2, note: "back" } });
    expect(restore.statusCode).toBe(200);
    expect(restore.json().version.version).toBe(3);
    expect(restore.json().version.contentHash).toBe(c.version.contentHash);
    const staging = await v1Get(app, fx, keys.staging, "service", "service.restore");
    expect(staging.json().blocks[0].props.h1).toBe("R1");

    const missing = await app.inject({ method: "POST", url: `${base(fx)}/items/${itemId}/restore`, headers: hdr(), payload: { version: 9, baseVersion: 3 } });
    expect(missing.statusCode).toBe(409);
    expect(missing.json().type).toBe(`${PROBLEM}version-not-found`);
    const notes = await asTenant(fx.tenantId, async (db) =>
      (await db.query(`SELECT version, note FROM content_versions WHERE content_item_id = $1 ORDER BY version`, [itemId])).rows,
    );
    expect(notes).toEqual([
      { version: 1, note: null },
      { version: 2, note: null },
      { version: 3, note: "back" },
    ]);
  });

  it("lint is advisory: placeholders are reported (registry-resolved tokens excluded) and never block a save", async () => {
    const reg = await createItem(app, fx, {
      collectionKey: "token-registry",
      locale: "en",
      slug: "token-registry",
      fields: { tokens: [{ key: "PUBLISH_DATE", value: "2026-10-20" }, { key: "RESULT_1_METRIC" }] },
    });
    expect(reg.statusCode).toBe(201);
    const c = await createItem(app, fx, {
      collectionKey: "service",
      locale: "en",
      slug: "service.lint",
      fields: serviceFields({ h1: "{{PUBLISH_DATE}} and {{RESULT_1_METRIC}}", body: "[CONFIRM: author] [CONFIRM: role] [CLIENT: logo] {{RESULT_1_METRIC}}" }),
    });
    expect(c.statusCode).toBe(201);
    expect(c.json().lint).toEqual({ placeholders: { unresolvedTokens: ["{{RESULT_1_METRIC}}"], markers: { CONFIRM: 2, CLIENT: 1 } } });
  });

  // ==============================================================================================
  // schedule (HIGH): the read path honours time; the two documented refusals
  // ==============================================================================================
  it("schedule: a future publishAt goes live by time alone; a live item -> 409 schedule-live-item-requires-worker; a takedown of a non-live item -> 409 not-live", async () => {
    const c = (await createItem(app, fx, { collectionKey: "service", locale: "en", slug: "service.sched", fields: serviceFields({ h1: "S1" }) })).json();
    const itemId = c.item.itemId as string;
    const publishAt = new Date(Date.now() + 2500).toISOString();
    const body = { items: [{ itemId, version: 1 }], publishAt };
    const ws4 = ws4For("content.schedule", { tenantSlug: fx.slug, siteId: fx.siteId }, body);
    const sched = await app.inject({ method: "POST", url: `${base(fx)}/schedule`, headers: hdr({ ws4 }), payload: body });
    expect(sched.statusCode).toBe(200);
    expect(sched.json().scheduled[0]).toMatchObject({ itemId, version: 1, publishAt });
    expect((await v1Get(app, fx, keys.production, "service", "service.sched")).statusCode).toBe(404);
    await waitFor(async () => (await v1Get(app, fx, keys.production, "service", "service.sched")).statusCode === 200, 8000, 250);

    const body2 = { items: [{ itemId, version: 1 }], publishAt: new Date(Date.now() + 60_000).toISOString() };
    const liveRefused = await app.inject({
      method: "POST",
      url: `${base(fx)}/schedule`,
      headers: hdr({ ws4: ws4For("content.schedule", { tenantSlug: fx.slug, siteId: fx.siteId }, body2) }),
      payload: body2,
    });
    expect(liveRefused.statusCode).toBe(409);
    expect(liveRefused.json().type).toBe(`${PROBLEM}schedule-live-item-requires-worker`);

    const d = (await createItem(app, fx, { collectionKey: "service", locale: "en", slug: "service.sched-draft", fields: serviceFields() })).json();
    const body3 = { items: [{ itemId: d.item.itemId, version: 1 }], unpublishAt: new Date(Date.now() + 60_000).toISOString() };
    const notLive = await app.inject({
      method: "POST",
      url: `${base(fx)}/schedule`,
      headers: hdr({ ws4: ws4For("content.schedule", { tenantSlug: fx.slug, siteId: fx.siteId }, body3) }),
      payload: body3,
    });
    expect(notLive.statusCode).toBe(409);
    expect(notLive.json().type).toBe(`${PROBLEM}not-live`);
  });

  // ==============================================================================================
  // (8) Events
  // ==============================================================================================
  it("(8) content.published: one delivery per enabled webhook, zero with none registered, and the payload carries no prop values", async () => {
    const sink = await TenantWebhookSink.start();
    process.env.TENANT_WEBHOOK_SSRF_TEST_ALLOWLIST = `127.0.0.1:${sink.port}`;
    try {
      const webhooks = app.get(TenantWebhooksService);
      await webhooks.register(fx.tenantId, { targetUrl: sink.url(), eventKinds: ["content.published"], description: "a" });
      await webhooks.register(fx.tenantId, { targetUrl: sink.url(), eventKinds: ["content.published", "form.received"], description: "b" });
      const disabled = await webhooks.register(fx.tenantId, { targetUrl: sink.url(), eventKinds: ["content.published"], description: "c" });
      await asTenant(fx.tenantId, (db) => db.query(`UPDATE tenant_webhooks SET enabled = false WHERE id = $1`, [disabled.id]));
      await webhooks.register(fx.tenantId, { targetUrl: sink.url(), eventKinds: ["content.unpublished"], description: "other kind" });

      const SECRET_VALUE = `secret-h1-${randomUUID()}`;
      const c = (await createItem(app, fx, { collectionKey: "service", locale: "en", slug: "service.events", fields: serviceFields({ h1: SECRET_VALUE }) })).json();
      const itemId = c.item.itemId as string;
      expect((await publishItems(app, fx, [{ itemId, version: 1 }])).statusCode).toBe(200);

      const received = await waitFor(async () => (sink.received().length >= 2 ? sink.received() : null), 15000);
      await new Promise((r) => setTimeout(r, 500)); // nothing further should arrive
      expect(sink.received()).toHaveLength(2);
      for (const r of received) {
        const env = JSON.parse(r.rawBody);
        expect(env.kind).toBe("content.published");
        expect(env.tenantId).toBe(fx.tenantId);
        expect(Object.keys(env.data).sort()).toEqual(["items", "siteId"]);
        expect(env.data.items).toHaveLength(1);
        expect(Object.keys(env.data.items[0]).sort()).toEqual(["collectionKey", "itemId", "locale", "slug", "version"]);
        expect(env.data.items[0]).toEqual({ itemId, collectionKey: "service", locale: "en", slug: "service.events", version: 1 });
        expect(r.rawBody).not.toContain(SECRET_VALUE);
      }
      const deliveries = await asTenant(fx.tenantId, async (db) =>
        (await db.query(`SELECT kind, count(*)::int AS n FROM tenant_webhook_deliveries WHERE tenant_id = $1 GROUP BY kind`, [fx.tenantId])).rows,
      );
      expect(deliveries).toEqual([{ kind: "content.published", n: 2 }]);

      // Another tenant with no webhooks: zero deliveries.
      const other = await createContentFixture("noevents");
      const oc = (await createItem(app, other, { collectionKey: "service", locale: "en", slug: "service.quiet", fields: serviceFields() })).json();
      expect((await publishItems(app, other, [{ itemId: oc.item.itemId, version: 1 }])).statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 300));
      const none = await asTenant(other.tenantId, async (db) =>
        (await db.query(`SELECT count(*)::int AS n FROM tenant_webhook_deliveries WHERE tenant_id = $1`, [other.tenantId])).rows[0].n,
      );
      expect(none).toBe(0);
      expect(sink.received()).toHaveLength(2);
    } finally {
      process.env.TENANT_WEBHOOK_SSRF_TEST_ALLOWLIST = "";
      await sink.stop();
    }
  });

  // ==============================================================================================
  // schema.apply: composition validation + the computed bump (finding §14.3)
  // ==============================================================================================
  it("schema.apply validates the composition (422), returns {bump, reasons}, and refuses a MAJOR change (409)", async () => {
    const url = (key: string) => `/control/v1/tenants/${fx.slug}/sites/${fx.siteId}/collections/${key}/schema/apply`;
    const h = () => ({
      "x-webdesk-control-principal": "erp-webdesk-control",
      "x-webdesk-control-scopes": "webdesk:operate",
      "idempotency-key": `schema-${randomUUID()}`,
    });
    const invalid = await app.inject({ method: "POST", url: url("faq-pages"), headers: h(), payload: { schema: { title: { type: "text" } } } });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().type).toBe(`${PROBLEM}composition-violation`);
    expect(invalid.json().issues[0].path).toBe("faq-pages.title");
    const notStored = await asTenant(fx.tenantId, async (db) => (await db.query(`SELECT count(*)::int AS n FROM collections WHERE key = 'faq-pages'`)).rows[0].n);
    expect(notStored).toBe(0);

    const v1 = { fields: [{ name: "q", primitive: "text", required: true }], ui: { label: "FAQ" } };
    const created = await app.inject({ method: "POST", url: url("faq-pages"), headers: h(), payload: { schema: v1 } });
    expect(created.statusCode).toBe(201);
    expect(created.json().bump).toBe("minor");
    expect(created.json().reasons).toEqual(['collection "faq-pages" added']);

    const uiEdit = await app.inject({ method: "POST", url: url("faq-pages"), headers: h(), payload: { schema: { ...v1, ui: { label: "Frequently asked" } } } });
    expect(uiEdit.statusCode).toBe(201);
    expect(uiEdit.json().bump).toBe("patch");

    const flip = await app.inject({ method: "POST", url: url("faq-pages"), headers: h(), payload: { schema: { ...v1, ui: { label: "Frequently asked" }, singleton: true } } });
    expect(flip.statusCode).toBe(409);
    expect(flip.json().type).toBe(`${PROBLEM}contract-major-change`);
    expect(flip.json().bump).toBe("major");
    const stillNotSingleton = await asTenant(fx.tenantId, async (db) => (await db.query(`SELECT schema FROM collections WHERE key = 'faq-pages'`)).rows[0].schema);
    expect(stillNotSingleton.singleton).toBeUndefined();
  });
});
