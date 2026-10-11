// WSK-49c — the pure half of the ERP's D59 / D62 pre-check: the `clientEditable` map, how a request becomes stored content,
// the create verdict, the pre-check functions and the problem bodies (which must match WebDesk's, slug for slug). No DB, no
// network. The RULE itself (`isClientEditable`, the content diff) is WebDesk's vendored function; its own semantics are
// covered by webdesk/delivery/test/wsk49-client-editable.test.mjs and its byte-identity by vocabulary-vendor.test.ts, so the
// checks here only prove the vendored copy RUNS in the ERP and that the glue around it is right.
import { describe, expect, it } from "vitest";
import { WebdeskProblem } from "./webdesk-content.service";
import {
  assembleClientContent,
  assertClientMayChange,
  assertClientMayCreate,
  assertClientMayPublish,
  clientEditableMap,
  fieldNotClientEditable,
  publishNotClientEditable,
  refuseClientSeo,
  splitStoredContent,
} from "./webdesk-client-guard";
import { isClientEditable } from "./vocabulary/client-editable";
import type { CollectionComposition } from "./vocabulary/composition";
import type { WebdeskZoneB } from "./webdesk-content.service";

const P = "/blocks/0/props";
const ON = {
  ui: { label: "Pages", clientEditable: true },
  fields: [
    { name: "title", primitive: "text" },
    { name: "price", primitive: "number", ui: { clientEditable: false } },
    { name: "tags", primitive: "text", multiple: true },
    {
      name: "faq", primitive: "group", multiple: true, itemKey: "key",
      fields: [{ name: "key", primitive: "text", required: true, ui: { clientEditable: false } }, { name: "q", primitive: "text" }],
    },
    { name: "legal", primitive: "group", ui: { clientEditable: false }, fields: [{ name: "terms", primitive: "text" }, { name: "summary", primitive: "text", ui: { clientEditable: true } }] },
  ],
  blocks: ["richText"],
} as unknown as CollectionComposition;
const OFF = {
  fields: [
    { name: "title", primitive: "text" },
    { name: "blurb", primitive: "text", ui: { clientEditable: true } },
  ],
} as unknown as CollectionComposition;
const GENERIC_ON = { ui: { label: "Home", clientEditable: true }, blocks: ["hero"] } as unknown as CollectionComposition;
const GENERIC_OFF = { ui: { label: "Home" }, blocks: ["hero"] } as unknown as CollectionComposition;

const throwsProblem = (fn: () => unknown): WebdeskProblem => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(WebdeskProblem);
    return e as WebdeskProblem;
  }
  throw new Error("expected a WebdeskProblem");
};

describe("the vendored rule runs in the ERP (smoke; the rule's own semantics are WebDesk's tests)", () => {
  it("inheritance, group opt-out, seo never, generic blocks follow the collection", () => {
    expect(isClientEditable(ON, `${P}/title`)).toBe(true);
    expect(isClientEditable(ON, `${P}/price`)).toBe(false);
    expect(isClientEditable(ON, `${P}/faq/0/q`)).toBe(true);
    expect(isClientEditable(ON, `${P}/faq/0/key`)).toBe(false);
    expect(isClientEditable(ON, `${P}/legal/terms`)).toBe(false);
    expect(isClientEditable(ON, `${P}/legal/summary`)).toBe(true);
    expect(isClientEditable(ON, "/seo/title")).toBe(false);
    expect(isClientEditable(ON, "/blocks/1/props/html")).toBe(true);
    expect(isClientEditable(OFF, "/blocks/1/props/html")).toBe(false);
    expect(isClientEditable(OFF, `${P}/title`)).toBe(false);
    expect(isClientEditable(OFF, `${P}/blurb`)).toBe(true);
  });
});

describe("clientEditableMap: what the portal renders read-only fields from", () => {
  it("one entry per declared field at every depth, a multiple group's members share a dotted path, seo is always false", () => {
    const m = clientEditableMap("page", ON);
    expect(m.fields).toEqual({
      title: true, price: false, tags: true, faq: true, "faq.key": false, "faq.q": true, legal: false, "legal.terms": false, "legal.summary": true,
    });
    expect(m.blocks).toBe(true);
    expect(m.seo).toBe(false);
  });

  it("agrees with isClientEditable for every entry (the map restates nothing)", () => {
    const m = clientEditableMap("page", ON);
    const pointer = (dotted: string) => `${P}/${dotted.split(".").map((s, i, a) => (i < a.length - 1 && s === "faq" ? `${s}/0` : s)).join("/")}`;
    for (const [path, editable] of Object.entries(m.fields)) expect(isClientEditable(ON, pointer(path)), path).toBe(editable);
  });

  it("a collection with no ui: only marked fields; blocks false; a generic-only collection follows the collection", () => {
    expect(clientEditableMap("x", OFF).fields).toEqual({ title: false, blurb: true });
    expect(clientEditableMap("x", OFF).blocks).toBe(false);
    expect(clientEditableMap("home", GENERIC_ON)).toMatchObject({ fields: {}, blocks: true });
    expect(clientEditableMap("home", GENERIC_OFF)).toMatchObject({ fields: {}, blocks: false });
  });

  it("create verdict: allowed, nothing-editable, required-fields-not-editable (named), system-collection", () => {
    expect(clientEditableMap("page", ON).create).toEqual({ allowed: true, reason: null, blockedBy: [] });
    expect(clientEditableMap("home", GENERIC_OFF).create).toMatchObject({ allowed: false, reason: "nothing-editable" });
    const required = { fields: [{ name: "code", primitive: "text", required: true }, { name: "headline", primitive: "text", ui: { clientEditable: true } }] } as unknown as CollectionComposition;
    expect(clientEditableMap("promo", required).create).toEqual({ allowed: false, reason: "required-fields-not-editable", blockedBy: ["code"] });
    // a required field that IS editable does not block
    const requiredEditable = { fields: [{ name: "headline", primitive: "text", required: true, ui: { clientEditable: true } }] } as unknown as CollectionComposition;
    expect(clientEditableMap("promo", requiredEditable).create.allowed).toBe(true);
    expect(clientEditableMap("redirect", OFF)).toMatchObject({ fields: {}, blocks: false, create: { allowed: false, reason: "system-collection" } });
  });

  it("an empty / malformed composition is not editable and not creatable (every doubt answers no)", () => {
    expect(clientEditableMap("x", {} as CollectionComposition)).toMatchObject({ fields: {}, blocks: false, create: { allowed: false } });
    expect(clientEditableMap("x", { fields: "nope" } as unknown as CollectionComposition).fields).toEqual({});
  });
});

describe("assembleClientContent / splitStoredContent (WebDesk's assembleItemContent, minus validation)", () => {
  it("a fields collection stores `fields` as blocks[0] then the request's blocks; seo is the request's", () => {
    expect(assembleClientContent("page", ON, { fields: { title: "T" }, blocks: [{ type: "richText", props: {} }], seo: { title: "S" } })).toEqual({
      blocks: [{ type: "fields", props: { title: "T" } }, { type: "richText", props: {} }], seo: { title: "S" },
    });
    expect(assembleClientContent("page", ON, {})).toEqual({ blocks: [{ type: "fields", props: {} }], seo: {} });
  });
  it("a collection with no fields stores only blocks; the redirect collection stores fields under seo.redirect with no blocks", () => {
    expect(assembleClientContent("home", GENERIC_ON, { fields: { ignored: 1 }, blocks: [{ type: "hero" }] })).toEqual({ blocks: [{ type: "hero" }], seo: {} });
    expect(assembleClientContent("redirect", OFF, { fields: { toPath: "/x" }, blocks: [{ type: "x" }] })).toEqual({ blocks: [], seo: { redirect: { toPath: "/x" } } });
  });
  it("splitStoredContent is the inverse: fields props, the generic blocks after them, the existing seo", () => {
    const stored = { blocks: [{ type: "fields", props: { title: "T" } }, { type: "richText", props: { a: 1 } }], seo: { title: "S" } };
    expect(splitStoredContent(ON, stored)).toEqual({ fields: { title: "T" }, blocks: [{ type: "richText", props: { a: 1 } }], seo: { title: "S" } });
    expect(assembleClientContent("page", ON, splitStoredContent(ON, stored))).toEqual(stored); // round trip: re-sending the head changes nothing
    expect(splitStoredContent(GENERIC_ON, { blocks: [{ type: "hero" }], seo: null })).toEqual({ fields: undefined, blocks: [{ type: "hero" }], seo: {} });
    expect(splitStoredContent(ON, { blocks: "garbage", seo: [] })).toEqual({ fields: {}, blocks: [], seo: {} });
  });
});

describe("the pre-checks", () => {
  const head = { blocks: [{ type: "fields", props: { title: "T", price: 10, faq: [{ key: "k", q: "q" }] } }, { type: "richText", props: { a: 1 } }], seo: { title: "S" } };

  it("update: editable changes pass; the first non-editable one refuses the WHOLE write with every pointer; omitting seo is a seo change", () => {
    const edited = assembleClientContent("page", ON, { fields: { title: "New", price: 10, faq: [{ key: "k", q: "q2" }] }, blocks: [{ type: "richText", props: { a: 1 } }], seo: { title: "S" } });
    expect(() => assertClientMayChange(ON, head, edited)).not.toThrow();
    const bad = assembleClientContent("page", ON, { fields: { title: "New", price: 99, faq: [{ key: "k2", q: "q" }] }, blocks: [{ type: "richText", props: { a: 1 } }], seo: { title: "S" } });
    const p = throwsProblem(() => assertClientMayChange(ON, head, bad));
    expect((p.problem.issues as Array<{ path: string }>).map((i) => i.path)).toEqual([`${P}/faq/0/key`, `${P}/price`]);
    // omitting the seo the item has (the 49b footgun) IS a change to /seo
    const noSeo = assembleClientContent("page", ON, { fields: { title: "T", price: 10, faq: [{ key: "k", q: "q" }] }, blocks: [{ type: "richText", props: { a: 1 } }] });
    expect((throwsProblem(() => assertClientMayChange(ON, head, noSeo)).problem.issues as Array<{ path: string }>).map((i) => i.path)).toEqual(["/seo/title"]);
    // ... and re-sending the head (what the BFF does) is no change at all
    expect(() => assertClientMayChange(ON, head, assembleClientContent("page", ON, splitStoredContent(ON, head)))).not.toThrow();
  });

  it("create: allowed in an editable collection, refused for seo / non-editable values / nothing-editable / required-non-editable", () => {
    expect(() => assertClientMayCreate("page", ON, { fields: { title: "T", tags: ["a"] } })).not.toThrow();
    expect(() => assertClientMayCreate("page", ON, { fields: { title: null as unknown as string } })).not.toThrow(); // null = default
    expect((throwsProblem(() => assertClientMayCreate("page", ON, { fields: { title: "T", price: 5 } })).problem.issues as Array<{ path: string }>).map((i) => i.path)).toEqual([`${P}/price`]);
    expect(throwsProblem(() => assertClientMayCreate("home", GENERIC_OFF, { blocks: [{ type: "hero" }] })).problem.issues).toEqual([{ path: "/collectionKey", message: expect.any(String) }]);
    const required = { fields: [{ name: "code", primitive: "text", required: true }, { name: "headline", primitive: "text", ui: { clientEditable: true } }] } as unknown as CollectionComposition;
    const p = throwsProblem(() => assertClientMayCreate("promo", required, { fields: { headline: "x" } }));
    expect(p.problem.detail).toMatch(/required field\(s\) code are not client-editable.*Ask Gaiada to create the item/s);
    expect(throwsProblem(() => assertClientMayCreate("redirect", OFF, { fields: { toPath: "/x" } })).problem.issues).toEqual([{ path: "/collectionKey", message: expect.any(String) }]);
  });

  it("refuseClientSeo: absent / null / {} are nothing; anything else is 422 /seo", () => {
    for (const seo of [undefined, null, {}]) expect(() => refuseClientSeo({ seo })).not.toThrow();
    for (const seo of [{ title: "x" }, { a: 1 }, "x", [], 0]) {
      expect((throwsProblem(() => refuseClientSeo({ seo: seo as never })).problem.issues as Array<{ path: string }>)[0].path).toBe("/seo");
    }
  });

  it("publish (D62): diff against what is LIVE, an empty baseline when never published, the whole batch refused with /items/<index> pointers", async () => {
    const live = { blocks: [{ type: "fields", props: { title: "T", price: 10 } }], seo: { title: "S" } };
    const items: Record<string, { collectionKey: string; headVersion: number; publishedVersion: number | null; version: { blocks: unknown; seo: unknown }; live: { blocks: unknown; seo: unknown } | null; deletedAt?: string | null }> = {
      ok: { collectionKey: "page", headVersion: 2, publishedVersion: 1, version: { blocks: [{ type: "fields", props: { title: "T2", price: 10 } }], seo: { title: "S" } }, live },
      protectedChange: { collectionKey: "page", headVersion: 2, publishedVersion: 1, version: { blocks: [{ type: "fields", props: { title: "T", price: 11 } }], seo: { title: "S" } }, live },
      seoChange: { collectionKey: "page", headVersion: 2, publishedVersion: 1, version: { blocks: [{ type: "fields", props: { title: "T", price: 10 } }], seo: { title: "S2" } }, live },
      sameAsLive: { collectionKey: "page", headVersion: 1, publishedVersion: 1, version: live, live },
      neverPublishedClean: { collectionKey: "page", headVersion: 1, publishedVersion: null, version: { blocks: [{ type: "fields", props: { title: "only editable" } }], seo: {} }, live: null },
      neverPublishedDirty: { collectionKey: "page", headVersion: 1, publishedVersion: null, version: { blocks: [{ type: "fields", props: { title: "x", price: 3 } }], seo: {} }, live: null },
      deleted: { collectionKey: "page", headVersion: 1, publishedVersion: null, version: { blocks: [], seo: {} }, live: null, deletedAt: "2026-10-11T00:00:00Z" },
    };
    const calls: string[] = [];
    const zoneB = {
      read: async (req: { command: string; params?: Record<string, string>; query?: Record<string, string> }) => {
        calls.push(req.command);
        if (req.command === "collection.get") return { status: 200, body: { key: req.params?.key, composition: ON } };
        const it = items[req.params?.itemId as string];
        return { status: 200, body: { item: { itemId: req.params?.itemId, collectionKey: it.collectionKey, deletedAt: it.deletedAt ?? null, headVersion: it.headVersion, publishedVersion: it.publishedVersion }, version: it.version, live: it.live } };
      },
    } as unknown as WebdeskZoneB;
    const site = { tenantSlug: "gaiada", siteId: "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4" };
    const check = (...ids: string[]) => assertClientMayPublish(zoneB, site, ids.map((itemId) => ({ itemId, version: 1 })));

    await expect(check("ok", "sameAsLive", "neverPublishedClean")).resolves.toBeUndefined();
    const refused = async (...ids: string[]) => {
      try {
        await check(...ids);
      } catch (e) {
        return (e as WebdeskProblem).problem;
      }
      throw new Error("expected a refusal");
    };
    expect((await refused("protectedChange")).issues).toEqual([{ path: `/items/0${P}/price`, message: expect.any(String) }]);
    expect(((await refused("ok", "seoChange")).issues as Array<{ path: string }>).map((i) => i.path)).toEqual(["/items/1/seo/title"]);
    expect(((await refused("neverPublishedDirty")).issues as Array<{ path: string }>).map((i) => i.path)).toEqual([`/items/0${P}/price`]);
    const mixed = await refused("ok", "protectedChange", "neverPublishedDirty");
    expect(mixed).toMatchObject({ type: expect.stringContaining("/errors/publish-not-client-editable"), status: 422, total: 2 });
    expect((mixed.issues as Array<{ path: string }>).map((i) => i.path)).toEqual([`/items/1${P}/price`, `/items/2${P}/price`]);
    // a deleted item is 409 item-deleted
    const del = await refused("deleted");
    expect(del).toMatchObject({ status: 409, type: expect.stringContaining("/errors/item-deleted") });
    // every read is a read: the pre-check never writes
    expect(calls.every((c) => c === "item.get" || c === "collection.get")).toBe(true);
  });
});

describe("the problem bodies match WebDesk's (slug, status, title, detail, issues, total)", () => {
  it("field-not-client-editable", () => {
    const p = fieldNotClientEditable(["/blocks/0/props/a", "/seo/title"]).problem;
    expect(p).toEqual({
      type: "https://webdesk.gaiada.online/errors/field-not-client-editable", title: "Field not client-editable", status: 422,
      detail: "A client editor may change only the fields the composition marks client-editable (ui.clientEditable). Nothing was written.",
      issues: [{ path: "/blocks/0/props/a", message: "this part of the item is not client-editable" }, { path: "/seo/title", message: "this part of the item is not client-editable" }],
      total: 2,
    });
  });
  it("publish-not-client-editable", () => {
    const p = publishNotClientEditable([{ index: 3, pointers: ["/seo/title"] }]).problem;
    expect(p).toMatchObject({ type: "https://webdesk.gaiada.online/errors/publish-not-client-editable", title: "Publish not client-editable", status: 422, total: 1, issues: [{ path: "/items/3/seo/title" }] });
    expect(p.detail).toContain("A client editor may publish only what a client could have changed");
  });
  it("lists at most 50 pointers but counts them all (as WebDesk does)", () => {
    const many = Array.from({ length: 80 }, (_, i) => `/blocks/0/props/f${i}`);
    const p = fieldNotClientEditable(many).problem;
    expect((p.issues as unknown[]).length).toBe(50);
    expect(p.total).toBe(80);
    expect((publishNotClientEditable([{ index: 0, pointers: many }]).problem.issues as unknown[]).length).toBe(50);
  });
});
