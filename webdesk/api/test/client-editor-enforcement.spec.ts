// WSK-49b — WebDesk's write plane enforces WSK-D59 for a CLIENT editor (ruling WSK-D59: "Clients change only
// what the composition marks client-editable ... enforced twice: the ERP's portal BFF refuses ..., and
// WebDesk's write plane refuses it too when the editorial assertion marks the principal as a client").
//
// The least-trusted write path in the system, so this drives the REAL thing end to end: real Postgres, real
// Redis (the jti store), the real AppModule with the REAL Layer-3/4 PDP and the REAL editorial resolver
// verifying EdDSA-signed assertions (not the NODE_ENV=test header stub), a real client assertion carrying
// `ce: true`, and the real content / media / preview commands.
//
// Doctrine ("validation pre-empts authz"): every denial sends a body that is VALID for its command, so no
// 400/422 of the ordinary kind could be what refused it, and every denial proves NOTHING WAS WRITTEN. Every
// denial is paired with the same call WITHOUT `ce`, which succeeds exactly as before (the marker only ever
// restricts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asTenant, base, buildContentApp, createContentFixture, hdr, ws4For, type ContentFixture } from "./content-test-kit";
import { mediaBase, seedAsset } from "./media-library-kit";
import { EDITORIAL_PRINCIPAL_RESOLVER } from "../src/control/auth/editorial-principal";
import { RealEditorialPrincipalResolver } from "../src/control/auth/real-editorial-principal-resolver";
import { computeCommandHash } from "../src/control/auth/ws4-assertion";
import type { CommandName } from "../src/control/command-types";
import { freshKey, keySetOf, mintEditorial } from "./editorial-assertion-kit";

const PROBLEM = "https://webdesk.gaiada.online/errors/";
const HEADER = "x-webdesk-editorial-assertion";
const P = "/blocks/0/props";

// ------------------------------------------------------------------------------------------------
// Compositions (vocabulary 1.2.0)
// ------------------------------------------------------------------------------------------------
/** The collection says nothing (default false); fields opt IN. */
const CPAGE = {
  ui: { label: "Client pages" },
  fields: [
    { name: "headline", primitive: "text", ui: { clientEditable: true } },
    { name: "intro", primitive: "markdown", ui: { clientEditable: true } },
    { name: "price", primitive: "number" },
    {
      name: "legal",
      primitive: "group",
      fields: [
        { name: "terms", primitive: "text" },
        { name: "summary", primitive: "text", ui: { clientEditable: true } },
      ],
    },
    {
      name: "faq",
      primitive: "group",
      multiple: true,
      itemKey: "key",
      ui: { clientEditable: true },
      fields: [
        { name: "key", primitive: "text", required: true },
        { name: "q", primitive: "text" },
        { name: "a", primitive: "text" },
        { name: "badge", primitive: "text", ui: { clientEditable: false } },
      ],
    },
  ],
  blocks: ["richText"],
};
/** The collection opts IN as a whole; one field opts OUT; generic blocks follow the collection. */
const CWIDE = {
  ui: { label: "Wide", clientEditable: true },
  fields: [
    { name: "title", primitive: "text" },
    { name: "internal", primitive: "text", ui: { clientEditable: false } },
  ],
  blocks: ["richText"],
};
/** Nothing is client-editable here. */
const CLOCKED = { ui: { label: "Locked" }, fields: [{ name: "name", primitive: "text" }], blocks: ["richText"] };

describe("WSK-49b client editors: enforcement in the write plane (real resolver, signed client assertions)", () => {
  let app: NestFastifyApplication;
  let fx: ContentFixture;
  const clock = Math.floor(Date.now() / 1000);
  const key = freshKey("wde-ce-enf");
  const params = () => ({ tenantSlug: fx.slug, siteId: fx.siteId });

  beforeAll(async () => {
    const resolver = new RealEditorialPrincipalResolver({
      keys: keySetOf(key),
      store: { consume: async () => true, close: async () => {} },
      now: () => clock,
    });
    app = await buildContentApp((b) => b.overrideProvider(EDITORIAL_PRINCIPAL_RESOLVER).useValue(resolver));
    fx = await createContentFixture("ce49");
    await asTenant(fx.tenantId, async (db) => {
      for (const [k, schema] of Object.entries({ cpage: CPAGE, cwide: CWIDE, clocked: CLOCKED })) {
        const id = randomUUID();
        await db.query(`INSERT INTO collections (id, tenant_id, site_id, key, schema) VALUES ($1, $2, $3, $4, $5::jsonb)`, [id, fx.tenantId, fx.siteId, k, JSON.stringify(schema)]);
        fx.collections[k] = id;
      }
    });
  });
  afterAll(async () => {
    await app?.close();
  });

  // ── a signed request, as the ERP would send it ─────────────────────────────────────────────────
  interface Call {
    method: "POST" | "PUT" | "PATCH" | "DELETE";
    url: string;
    command: CommandName;
    params: Record<string, string>;
    body?: Record<string, unknown>;
    /** true = a client principal (the signed claim `ce: true`); false/omitted = staff. */
    ce?: boolean;
    /** HIGH commands: the WS4 approval id (also the assertion's `apr`). */
    approval?: string;
  }
  async function call(c: Call) {
    const args = { ...c.params, ...(c.body ?? {}) };
    const headers = hdr({ editorial: null, ws4: c.approval ? ws4For(c.command, c.params, c.body ?? {}, c.approval) : undefined });
    headers[HEADER] = mintEditorial(key, {
      sub: c.ce ? "erp-client-user-1" : "erp-staff-user-1",
      pk: "human",
      ten: fx.slug,
      site: fx.siteId,
      cmd: c.command,
      cmh: computeCommandHash(c.command, args),
      ...(c.approval ? { apr: c.approval } : {}),
      ...(c.ce ? { ce: true } : {}),
      iat: clock,
      exp: clock + 60,
      jti: randomUUID(),
    });
    return app.inject({ method: c.method, url: c.url, headers, payload: c.body });
  }

  const create = (body: Record<string, unknown>, ce = false) => call({ method: "POST", url: `${base(fx)}/items`, command: "content.create", params: params(), body, ce });
  const update = (itemId: string, body: Record<string, unknown>, ce = false) =>
    call({ method: "PUT", url: `${base(fx)}/items/${itemId}`, command: "content.update", params: { ...params(), itemId }, body, ce });
  const restore = (itemId: string, body: Record<string, unknown>, ce = false) =>
    call({ method: "POST", url: `${base(fx)}/items/${itemId}/restore`, command: "content.restoreVersion", params: { ...params(), itemId }, body, ce });
  const publish = (items: { itemId: string; version: number }[], ce = false) => {
    const approval = `apr-${randomUUID()}`;
    return call({ method: "POST", url: `${base(fx)}/publish`, command: "content.publish", params: params(), body: { items }, ce, approval });
  };

  const slug = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;
  const pageFields = (over: Record<string, unknown> = {}) => ({
    headline: "Welcome",
    intro: "# Hello",
    price: 10,
    legal: { terms: "Terms v1", summary: "Short" },
    faq: [{ key: "k1", q: "Q1", a: "A1", badge: "gold" }],
    ...over,
  });

  async function rows(sql: string, args: unknown[] = []): Promise<any[]> {
    return asTenant(fx.tenantId, async (db) => (await db.query(sql, args)).rows);
  }
  const itemCount = async (s: string) => (await rows(`SELECT count(*)::int AS n FROM content_items WHERE slug = $1`, [s]))[0].n as number;
  const versionCount = async (itemId: string) => (await rows(`SELECT count(*)::int AS n FROM content_versions WHERE content_item_id = $1`, [itemId]))[0].n as number;

  function expectProblem(r: { statusCode: number; headers: Record<string, unknown>; json: () => any; body: string }, status: number, slugName: string) {
    expect(r.statusCode, r.body).toBe(status);
    expect(String(r.headers["content-type"])).toContain("application/problem+json");
    expect(r.json().type).toBe(`${PROBLEM}${slugName}`);
  }
  const NOT_EDITABLE = "field-not-client-editable";
  /** The pointers a 422 lists. */
  const listed = (r: { json: () => any }): string[] => (r.json().issues as { path: string }[]).map((i) => i.path).sort();

  /** A staff-created item (full power) to edit, returns its id. */
  async function staffItem(collection = "cpage", fields: Record<string, unknown> = pageFields(), extra: Record<string, unknown> = {}): Promise<{ itemId: string; slug: string }> {
    const s = slug(collection);
    const r = await create({ collectionKey: collection, locale: "en", slug: s, fields, ...extra });
    expect(r.statusCode, r.body).toBe(201);
    return { itemId: r.json().item.itemId as string, slug: s };
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // content.update
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("content.update", () => {
    it("a change to client-editable fields only is allowed (200), writes version 2, and the attribution records the client marker", async () => {
      const { itemId } = await staffItem();
      const r = await update(itemId, { baseVersion: 1, fields: pageFields({ headline: "New headline", intro: "New intro", legal: { terms: "Terms v1", summary: "New summary" } }) }, true);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().unchanged).toBe(false);
      expect(r.json().version.version).toBe(2);
      const v = await rows(`SELECT created_by, attribution FROM content_versions WHERE content_item_id = $1 ORDER BY version`, [itemId]);
      expect(v[0]).toMatchObject({ created_by: "erp-staff-user-1", attribution: { pk: "human" } });
      expect(v[0].attribution.ce).toBeUndefined();
      expect(v[1]).toMatchObject({ created_by: "erp-client-user-1", attribution: { pk: "human", ce: "true" } });
    });

    it("a change to a NON-editable field is 422 field-not-client-editable with the pointer, and nothing is written", async () => {
      const { itemId } = await staffItem();
      const r = await update(itemId, { baseVersion: 1, fields: pageFields({ price: 99 }) }, true);
      expectProblem(r, 422, NOT_EDITABLE);
      expect(listed(r)).toEqual([`${P}/price`]);
      expect(await versionCount(itemId)).toBe(1);
      expect((await rows(`SELECT head_version FROM content_items WHERE id = $1`, [itemId]))[0].head_version).toBe(1);
    });

    it("the same non-editable change WITHOUT ce is allowed, exactly as before (200, version 2)", async () => {
      const { itemId } = await staffItem();
      const r = await update(itemId, { baseVersion: 1, fields: pageFields({ price: 99 }) }, false);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().version.version).toBe(2);
    });

    it("a MIXED update (one editable change, one not) is 422 for the whole write: the editable change is not applied either", async () => {
      const { itemId } = await staffItem();
      const r = await update(itemId, { baseVersion: 1, fields: pageFields({ headline: "Changed", price: 11 }) }, true);
      expectProblem(r, 422, NOT_EDITABLE);
      expect(listed(r)).toEqual([`${P}/price`]);
      expect(await versionCount(itemId)).toBe(1);
      const head = await rows(`SELECT blocks FROM content_versions WHERE content_item_id = $1 AND version = 1`, [itemId]);
      expect(head[0].blocks[0].props.headline).toBe("Welcome");
    });

    it("a seo change is 422 (seo is never client-editable), even beside an editable change", async () => {
      const { itemId } = await staffItem("cpage", pageFields(), { seo: { title: "SEO title" } });
      const r = await update(itemId, { baseVersion: 1, fields: pageFields({ headline: "H2" }), seo: { title: "Hijacked title" } }, true);
      expectProblem(r, 422, NOT_EDITABLE);
      expect(listed(r)).toEqual(["/seo/title"]);
      expect(await versionCount(itemId)).toBe(1);
      const ok = await update(itemId, { baseVersion: 1, fields: pageFields({ headline: "H2" }), seo: { title: "SEO title" } }, true);
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it("nested groups: a non-editable group member is refused (legal.terms), the editable sibling is allowed (legal.summary)", async () => {
      const { itemId } = await staffItem();
      const bad = await update(itemId, { baseVersion: 1, fields: pageFields({ legal: { terms: "Terms v2", summary: "Short" } }) }, true);
      expectProblem(bad, 422, NOT_EDITABLE);
      expect(listed(bad)).toEqual([`${P}/legal/terms`]);
      const ok = await update(itemId, { baseVersion: 1, fields: pageFields({ legal: { terms: "Terms v1", summary: "Changed" } }) }, true);
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it("a list of objects: an editable member of one item is allowed; an opted-out member (badge), and a NEW item carrying one, are refused with exact pointers", async () => {
      const { itemId } = await staffItem();
      const ok = await update(itemId, { baseVersion: 1, fields: pageFields({ faq: [{ key: "k1", q: "Q1 changed", a: "A1", badge: "gold" }] }) }, true);
      expect(ok.statusCode, ok.body).toBe(200);
      const badge = await update(itemId, { baseVersion: 2, fields: pageFields({ faq: [{ key: "k1", q: "Q1 changed", a: "A1", badge: "platinum" }] }) }, true);
      expectProblem(badge, 422, NOT_EDITABLE);
      expect(listed(badge)).toEqual([`${P}/faq/0/badge`]);
      const added = await update(itemId, {
        baseVersion: 2,
        fields: pageFields({ faq: [{ key: "k1", q: "Q1 changed", a: "A1", badge: "gold" }, { key: "k2", q: "Q2", a: "A2", badge: "sneaky" }] }),
      }, true);
      expectProblem(added, 422, NOT_EDITABLE);
      expect(listed(added)).toEqual([`${P}/faq/1/badge`]);
      const addedClean = await update(itemId, { baseVersion: 2, fields: pageFields({ faq: [{ key: "k1", q: "Q1 changed", a: "A1", badge: "gold" }, { key: "k2", q: "Q2", a: "A2" }] }) }, true);
      expect(addedClean.statusCode, addedClean.body).toBe(200);
    });

    it("an update that changes nothing is 200 unchanged for a client", async () => {
      const { itemId } = await staffItem();
      const r = await update(itemId, { baseVersion: 1, fields: pageFields() }, true);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().unchanged).toBe(true);
      expect(await versionCount(itemId)).toBe(1);
    });

    it("a stale baseVersion is the ordinary 409 version-conflict, not a misleading 422 about somebody else's change", async () => {
      const { itemId } = await staffItem();
      const staffEdit = await update(itemId, { baseVersion: 1, fields: pageFields({ price: 50 }) }, false);
      expect(staffEdit.statusCode, staffEdit.body).toBe(200);
      const r = await update(itemId, { baseVersion: 1, fields: pageFields({ headline: "Mine" }) }, true);
      expectProblem(r, 409, "version-conflict");
    });

    it("collection-level opt-in: fields follow the collection; an opted-out field and seo do not; generic blocks follow the collection", async () => {
      const { itemId } = await staffItem("cwide", { title: "T", internal: "I" });
      const ok = await update(itemId, { baseVersion: 1, fields: { title: "T2", internal: "I" }, blocks: [{ type: "richText", props: { content: "<p>generic</p>" } }] }, true);
      expect(ok.statusCode, ok.body).toBe(200);
      const bad = await update(itemId, { baseVersion: 2, fields: { title: "T2", internal: "I2" }, blocks: [{ type: "richText", props: { content: "<p>generic2</p>" } }] }, true);
      expectProblem(bad, 422, NOT_EDITABLE);
      expect(listed(bad)).toEqual([`${P}/internal`]);
    });

    it("a generic block in a collection that is NOT client-editable is refused; the same call without ce is allowed", async () => {
      const { itemId } = await staffItem();
      const body = { baseVersion: 1, fields: pageFields(), blocks: [{ type: "richText", props: { content: "<p>x</p>" } }] };
      const bad = await update(itemId, body, true);
      expectProblem(bad, 422, NOT_EDITABLE);
      expect(listed(bad)).toEqual(["/blocks/1/props/content", "/blocks/1/type"]);
      expect(await versionCount(itemId)).toBe(1);
      expect((await update(itemId, body, false)).statusCode).toBe(200);
    });

    it("a client edit in a collection with no editable field at all is 422 on any non-default change", async () => {
      const { itemId } = await staffItem("clocked", { name: "N" });
      const r = await update(itemId, { baseVersion: 1, fields: { name: "N2" } }, true);
      expectProblem(r, 422, NOT_EDITABLE);
      expect(listed(r)).toEqual([`${P}/name`]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // content.restoreVersion
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("content.restoreVersion", () => {
    it("restoring a version that differs from the head only in editable paths is allowed", async () => {
      const { itemId } = await staffItem();
      expect((await update(itemId, { baseVersion: 1, fields: pageFields({ headline: "v2 headline" }) }, true)).statusCode).toBe(200);
      const r = await restore(itemId, { version: 1, baseVersion: 2 }, true);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().version.version).toBe(3);
    });

    it("restoring a version that differs from the head in a NON-editable path is 422 field-not-client-editable, and nothing is written", async () => {
      const { itemId } = await staffItem(); // v1: price 10
      expect((await update(itemId, { baseVersion: 1, fields: pageFields({ price: 20 }) }, false)).statusCode).toBe(200); // v2 (staff): price 20
      const r = await restore(itemId, { version: 1, baseVersion: 2 }, true); // would put price back to 10
      expectProblem(r, 422, NOT_EDITABLE);
      expect(listed(r)).toEqual([`${P}/price`]);
      expect(await versionCount(itemId)).toBe(2);
      expect((await rows(`SELECT head_version FROM content_items WHERE id = $1`, [itemId]))[0].head_version).toBe(2);
    });

    it("the same restore WITHOUT ce works as before (200, version 3)", async () => {
      const { itemId } = await staffItem();
      expect((await update(itemId, { baseVersion: 1, fields: pageFields({ price: 20 }) }, false)).statusCode).toBe(200);
      const r = await restore(itemId, { version: 1, baseVersion: 2 }, false);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().version.version).toBe(3);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // content.create
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("content.create", () => {
    it("a create that sets only client-editable fields is allowed (201) and attributed to the client", async () => {
      const s = slug("cpage");
      const r = await create({ collectionKey: "cpage", locale: "en", slug: s, fields: { headline: "H", intro: "I", legal: { summary: "S" }, faq: [{ key: "k", q: "Q" }] } }, true);
      expect(r.statusCode, r.body).toBe(201);
      const v = await rows(`SELECT created_by, attribution FROM content_versions WHERE content_item_id = $1`, [r.json().item.itemId]);
      expect(v[0]).toMatchObject({ created_by: "erp-client-user-1", attribution: { pk: "human", ce: "true" } });
    });

    it("a create with a non-editable field SET is 422 field-not-client-editable listing it; nothing is written; without ce it is 201", async () => {
      const s = slug("cpage");
      const body = { collectionKey: "cpage", locale: "en", slug: s, fields: { headline: "H", price: 5 } };
      const r = await create(body, true);
      expectProblem(r, 422, NOT_EDITABLE);
      expect(listed(r)).toEqual([`${P}/price`]);
      expect(await itemCount(s)).toBe(0);
      expect((await create(body, false)).statusCode).toBe(201);
    });

    it("a non-editable field that is null (its default) is fine", async () => {
      const r = await create({ collectionKey: "cpage", locale: "en", slug: slug("cpage"), fields: { headline: "H", price: null } }, true);
      expect(r.statusCode, r.body).toBe(201);
    });

    it("a create with seo set is 422 (seo must be empty); with an empty seo it is 201", async () => {
      const s = slug("cpage");
      const bad = await create({ collectionKey: "cpage", locale: "en", slug: s, fields: { headline: "H" }, seo: { title: "T", description: "D" } }, true);
      expectProblem(bad, 422, NOT_EDITABLE);
      expect(listed(bad)).toEqual(["/seo/description", "/seo/title"]);
      expect(await itemCount(s)).toBe(0);
      expect((await create({ collectionKey: "cpage", locale: "en", slug: s, fields: { headline: "H" }, seo: {} }, true)).statusCode).toBe(201);
    });

    it("a create in a collection where NO field is client-editable is 422 (valid body); without ce it is 201", async () => {
      const s = slug("clocked");
      const body = { collectionKey: "clocked", locale: "en", slug: s, fields: {} };
      const r = await create(body, true);
      expectProblem(r, 422, NOT_EDITABLE);
      expect(listed(r)).toEqual(["/collectionKey"]);
      expect(await itemCount(s)).toBe(0);
      expect((await create(body, false)).statusCode).toBe(201);
    });

    it("generic blocks on create follow the collection (cwide yes, cpage no)", async () => {
      const block = [{ type: "richText", props: { content: "<p>c</p>" } }];
      expect((await create({ collectionKey: "cwide", locale: "en", slug: slug("cwide"), fields: { title: "T" }, blocks: block }, true)).statusCode).toBe(201);
      const s = slug("cpage");
      const bad = await create({ collectionKey: "cpage", locale: "en", slug: s, fields: { headline: "H" }, blocks: block }, true);
      expectProblem(bad, 422, NOT_EDITABLE);
      expect(await itemCount(s)).toBe(0);
    });

    it("the redirect system collection is never reachable for a client (its values live under seo)", async () => {
      const s = `/ce49-${randomUUID().slice(0, 6)}`;
      const body = { collectionKey: "redirect", locale: "en", slug: s, fields: { toPath: "/somewhere" } };
      const r = await create(body, true);
      expectProblem(r, 422, NOT_EDITABLE);
      expect(await itemCount(s)).toBe(0);
      expect((await create(body, false)).statusCode).toBe(201);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // The commands refused to a client, and the ones allowed
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("commands refused to a client: 403 client-command-not-allowed", () => {
    it("content.delete: refused, the item is not deleted; without ce it is deleted (200)", async () => {
      const { itemId } = await staffItem();
      const mk = (ce: boolean) => call({ method: "POST", url: `${base(fx)}/items/${itemId}/delete`, command: "content.delete", params: { ...params(), itemId }, body: { baseVersion: 1 }, ce });
      const r = await mk(true);
      expectProblem(r, 403, "client-command-not-allowed");
      expect((await rows(`SELECT deleted_at FROM content_items WHERE id = $1`, [itemId]))[0].deleted_at).toBeNull();
      expect((await mk(false)).statusCode).toBe(200);
    });

    it("content.unpublish: refused, the item stays live; without ce it is taken down (200)", async () => {
      const { itemId } = await staffItem();
      expect((await publish([{ itemId, version: 1 }])).statusCode).toBe(200);
      const mk = (ce: boolean) =>
        call({ method: "POST", url: `${base(fx)}/items/${itemId}/unpublish`, command: "content.unpublish", params: { ...params(), itemId }, body: { expectedPublishedVersion: 1 }, ce });
      const r = await mk(true);
      expectProblem(r, 403, "client-command-not-allowed");
      expect((await rows(`SELECT published_version FROM content_items WHERE id = $1`, [itemId]))[0].published_version).toBe(1);
      expect((await mk(false)).statusCode).toBe(200);
    });

    it("content.schedule (HIGH, with its WS4 approval and apr): refused; without ce it is scheduled (200)", async () => {
      const { itemId } = await staffItem();
      const publishAt = new Date(Date.now() + 3_600_000).toISOString();
      const mk = (ce: boolean) =>
        call({ method: "POST", url: `${base(fx)}/schedule`, command: "content.schedule", params: params(), body: { items: [{ itemId, version: 1 }], publishAt }, ce, approval: `apr-${randomUUID()}` });
      const r = await mk(true);
      expectProblem(r, 403, "client-command-not-allowed");
      expect((await rows(`SELECT publish_state FROM content_items WHERE id = $1`, [itemId]))[0].publish_state).toBe("draft");
      expect((await mk(false)).statusCode).toBe(200);
    });

    it("media.delete: refused, the asset is not deleted; without ce it is deleted (200)", async () => {
      const asset = await seedAsset(fx, { title: "to keep" });
      const mk = (ce: boolean) => call({ method: "DELETE", url: `${mediaBase(fx)}/${asset.id}`, command: "media.delete", params: { ...params(), assetId: asset.id }, ce });
      const r = await mk(true);
      expectProblem(r, 403, "client-command-not-allowed");
      expect((await rows(`SELECT deleted_at FROM media_assets WHERE id = $1`, [asset.id]))[0].deleted_at).toBeNull();
      expect((await mk(false)).statusCode).toBe(200);
    });
  });

  describe("commands allowed to a client (their own checks still apply)", () => {
    it("content.publish: allowed (WS4 + the editorial apr cross-binding, then WSK-D62's client-editable check; D58 is the ERP's)", async () => {
      const c = await create({ collectionKey: "cpage", locale: "en", slug: slug("cpage"), fields: { headline: "H", intro: "I" } }, true);
      expect(c.statusCode, c.body).toBe(201);
      const itemId = c.json().item.itemId as string;
      const r = await publish([{ itemId, version: 1 }], true);
      expect(r.statusCode, r.body).toBe(200);
      expect((await rows(`SELECT published_version, last_published_by FROM content_items WHERE id = $1`, [itemId]))[0]).toEqual({ published_version: 1, last_published_by: "erp-client-user-1" });
    });

    it("content.previewToken: allowed (201) and its revoke too", async () => {
      const { itemId } = await staffItem();
      const mint = await call({ method: "POST", url: `${base(fx)}/items/${itemId}/preview-token`, command: "content.previewToken", params: { ...params(), itemId }, body: {}, ce: true });
      expect(mint.statusCode, mint.body).toBe(201);
      const tokenId = mint.json().tokenId as string;
      const rev = await call({ method: "DELETE", url: `${base(fx)}/items/${itemId}/preview-tokens/${tokenId}`, command: "content.previewTokenRevoke", params: { ...params(), itemId, tokenId }, ce: true });
      expect(rev.statusCode, rev.body).toBe(200);
    });

    it("media.uploadToken: allowed (201)", async () => {
      const r = await call({ method: "POST", url: `${mediaBase(fx)}/upload-token`, command: "media.uploadToken", params: params(), body: { bucket: "media" }, ce: true });
      expect(r.statusCode, r.body).toBe(201);
    });

    it("media.update: allowed (200)", async () => {
      const asset = await seedAsset(fx, { title: "old" });
      const r = await call({ method: "PATCH", url: `${mediaBase(fx)}/${asset.id}`, command: "media.update", params: { ...params(), assetId: asset.id }, body: { title: "new title" }, ce: true });
      expect(r.statusCode, r.body).toBe(200);
      expect((await rows(`SELECT title FROM media_assets WHERE id = $1`, [asset.id]))[0].title).toBe("new title");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // WSK-D62: "A client may publish only what a client could have changed."
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("content.publish (WSK-D62): a client publishes only what a client could have changed", () => {
    const PUB = "publish-not-client-editable";
    const publishedVersion = async (itemId: string) => (await rows(`SELECT published_version FROM content_items WHERE id = $1`, [itemId]))[0].published_version as number | null;
    /** staff create + staff publish of v1: the "currently published" baseline. */
    async function liveItem(fields: Record<string, unknown> = pageFields(), extra: Record<string, unknown> = {}) {
      const it = await staffItem("cpage", fields, extra);
      expect((await publish([{ itemId: it.itemId, version: 1 }], false)).statusCode).toBe(200);
      return it;
    }

    it("a version differing from the published one ONLY in editable fields is published (200)", async () => {
      const { itemId } = await liveItem();
      expect((await update(itemId, { baseVersion: 1, fields: pageFields({ headline: "Client copy", legal: { terms: "Terms v1", summary: "S2" } }) }, true)).statusCode).toBe(200);
      const r = await publish([{ itemId, version: 2 }], true);
      expect(r.statusCode, r.body).toBe(200);
      expect(await publishedVersion(itemId)).toBe(2);
    });

    it("a draft carrying an AGENCY edit to a non-editable field is 422 publish-not-client-editable listing it, and nothing is published; without ce it is published", async () => {
      const { itemId } = await liveItem();
      expect((await update(itemId, { baseVersion: 1, fields: pageFields({ price: 99, headline: "Client copy" }) }, false)).statusCode).toBe(200); // staff
      const r = await publish([{ itemId, version: 2 }], true);
      expectProblem(r, 422, PUB);
      expect(listed(r)).toEqual([`/items/0${P}/price`]);
      expect(await publishedVersion(itemId)).toBe(1);
      const staff = await publish([{ itemId, version: 2 }], false);
      expect(staff.statusCode, staff.body).toBe(200);
      expect(await publishedVersion(itemId)).toBe(2);
    });

    it("a seo change is refused (seo is never client-editable); without ce it is published", async () => {
      const { itemId } = await liveItem(pageFields(), { seo: { title: "Original" } });
      expect((await update(itemId, { baseVersion: 1, fields: pageFields(), seo: { title: "Agency title" } }, false)).statusCode).toBe(200);
      const r = await publish([{ itemId, version: 2 }], true);
      expectProblem(r, 422, PUB);
      expect(listed(r)).toEqual(["/items/0/seo/title"]);
      expect(await publishedVersion(itemId)).toBe(1);
      expect((await publish([{ itemId, version: 2 }], false)).statusCode).toBe(200);
    });

    it("a batch with ONE bad item is refused as a whole: the pointers carry the item's index and the good item is not published either", async () => {
      const good = await liveItem();
      const bad = await liveItem();
      expect((await update(good.itemId, { baseVersion: 1, fields: pageFields({ headline: "Client copy" }) }, true)).statusCode).toBe(200);
      expect((await update(bad.itemId, { baseVersion: 1, fields: pageFields({ price: 77 }) }, false)).statusCode).toBe(200);
      const r = await publish([{ itemId: good.itemId, version: 2 }, { itemId: bad.itemId, version: 2 }], true);
      expectProblem(r, 422, PUB);
      expect(listed(r)).toEqual([`/items/1${P}/price`]);
      expect(await publishedVersion(good.itemId)).toBe(1);
      expect(await publishedVersion(bad.itemId)).toBe(1);
      const ok = await publish([{ itemId: good.itemId, version: 2 }, { itemId: bad.itemId, version: 2 }], false);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await publishedVersion(good.itemId)).toBe(2);
      expect(await publishedVersion(bad.itemId)).toBe(2);
    });

    it("a NEVER-published item with a non-editable field set is 422 (its empty baseline), listing every such path; without ce it is published", async () => {
      const { itemId } = await staffItem(); // price, legal.terms and faq[0].badge are set; none is client-editable
      const r = await publish([{ itemId, version: 1 }], true);
      expectProblem(r, 422, PUB);
      expect(listed(r)).toEqual([`/items/0${P}/faq/0/badge`, `/items/0${P}/legal/terms`, `/items/0${P}/price`]);
      expect(await publishedVersion(itemId)).toBeNull();
      expect((await publish([{ itemId, version: 1 }], false)).statusCode).toBe(200);
    });

    it("re-publishing the version that is already live is a no-change publish and is allowed", async () => {
      const { itemId } = await liveItem();
      const r = await publish([{ itemId, version: 1 }], true);
      expect(r.statusCode, r.body).toBe(200);
    });
  });
});
