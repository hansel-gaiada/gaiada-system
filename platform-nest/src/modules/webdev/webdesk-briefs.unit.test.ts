// M5-W4 — the parts of the writers' room briefs that need no services: the body and query parsers, the views, the cursor, the MCP tool
// registry (impacts, paths, required inputs), and the service's ORDER (phase 2 before the body, and a brief of another site is a 404 before
// any question) against stubs. The HTTP + Cerbos + Postgres behaviour is `webdesk-briefs.test.ts` (the Linux gate).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { webdevModule, WEBDESK_BRIEF_TOOLS } from "./index";
import { searchModule } from "../search";
import {
  briefSummary,
  briefView,
  encodeCursor,
  parseAssign,
  parseCreate,
  parseCreateDraft,
  parseListQuery,
  parsePatch,
} from "./webdesk-briefs.service";
import type { BriefRecord } from "./webdesk-brief-store";

const ID = "7b1f0a52-3c64-4d8e-9a10-5e2f6b7c8d90";
const ITEM = "0d4c5b6a-7e8f-4a1b-9c2d-3e4f5a6b7c8d";
const USER = "11111111-2222-4333-8444-555555555555";

function brief(over: Partial<BriefRecord> = {}): BriefRecord {
  return {
    id: ID, propertyId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", topic: "Bali villa SEO", status: "draft", outline: ["Intro"], body: "b", geoNotes: "g",
    grounding: { findingCount: 2 }, draftedVia: "ai", createdBy: USER, createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z",
    webdeskTenantSlug: "gaiada", webdeskSiteId: "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4", collectionKey: "post", locale: "en", webdeskItemId: ITEM,
    linkedAt: "2026-10-12T00:00:00.000Z", assigneeId: USER, targetQuery: "villa bali", searchIntent: "commercial", aiQuestions: ["q1"], contentGaps: ["gap"],
    sourceBriefId: null, ...over,
  };
}

describe("parseCreate", () => {
  const base = { collectionKey: "post", locale: "en", topic: "T" };
  it("accepts the full shape", () => {
    const out = parseCreate({ ...base, targetQuery: "q", searchIntent: "informational", aiQuestions: ["a", "b"], contentGaps: ["g"], outline: ["h1"], body: "x", geoNotes: "n", propertyId: ID.toUpperCase() });
    expect(out).toMatchObject({ collectionKey: "post", locale: "en", topic: "T", targetQuery: "q", searchIntent: "informational", propertyId: ID });
  });
  it("needs a topic, or fromBriefId", () => {
    expect(() => parseCreate({ collectionKey: "post", locale: "en" })).toThrow(/topic is required/);
    expect(parseCreate({ collectionKey: "post", locale: "en", fromBriefId: ID }).fromBriefId).toBe(ID);
  });
  it("refuses an unknown key, a bad intent, an over-long list and a non-uuid property", () => {
    expect(() => parseCreate({ ...base, siteId: "x" })).toThrow(/unknown body key/);
    expect(() => parseCreate({ ...base, searchIntent: "nope" })).toThrow(/searchIntent/);
    expect(() => parseCreate({ ...base, aiQuestions: Array.from({ length: 51 }, () => "q") })).toThrow(/aiQuestions/);
    expect(() => parseCreate({ ...base, contentGaps: [""] })).toThrow(/contentGaps/);
    expect(() => parseCreate({ ...base, propertyId: "p" })).toThrow(/propertyId/);
    expect(() => parseCreate("nope")).toThrow(/JSON object/);
  });
  it("never reads siteId, tenantSlug, assignee or item link from a body", () => {
    for (const k of ["siteId", "tenantSlug", "assigneeId", "itemId", "webdeskItemId", "createdBy", "status"]) {
      expect(() => parseCreate({ ...base, [k]: "x" }), k).toThrow(/unknown body key/);
    }
  });
});

describe("parsePatch", () => {
  it("accepts an allow-listed subset and clears with null", () => {
    expect(parsePatch({ status: "approved", geoNotes: null, targetQuery: null })).toEqual({ status: "approved", geoNotes: null, targetQuery: null });
  });
  it("refuses an empty patch, a bad status and any link field", () => {
    expect(() => parsePatch({})).toThrow(/nothing to update/);
    expect(() => parsePatch({ status: "published" })).toThrow(/status/);
    for (const k of ["collectionKey", "locale", "itemId", "assigneeId", "propertyId"]) expect(() => parsePatch({ [k]: "x" }), k).toThrow(/unknown body key/);
  });
});

describe("parseAssign and parseCreateDraft", () => {
  it("assign needs a uuid itemId and takes an optional author and dates", () => {
    expect(parseAssign({ itemId: ITEM, authorSub: USER, dueAt: "2026-12-01", plannedPublishAt: null })).toEqual({ itemId: ITEM, authorSub: USER, dueAt: "2026-12-01", plannedPublishAt: null });
    expect(() => parseAssign({})).toThrow(/itemId is required/);
    expect(() => parseAssign({ itemId: "x" })).toThrow(/itemId must be a uuid/);
    expect(() => parseAssign({ itemId: ITEM, authorSub: "not-a-uuid" })).toThrow(/authorSub/);
    expect(() => parseAssign({ itemId: ITEM, briefRef: "x" })).toThrow(/unknown body key/);
  });
  it("create-draft needs a slug; the collection and locale are never the body's", () => {
    expect(parseCreateDraft({ slug: "villa-guide", fields: { h1: "x" }, note: "n" })).toMatchObject({ slug: "villa-guide", fields: { h1: "x" } });
    expect(() => parseCreateDraft({})).toThrow(/slug is required/);
    for (const k of ["collectionKey", "locale", "twinOf", "briefRef", "itemId"]) expect(() => parseCreateDraft({ slug: "s", [k]: "x" }), k).toThrow(/unknown body key/);
    expect(() => parseCreateDraft({ slug: "s", fields: [] })).toThrow(/fields/);
  });
});

describe("parseListQuery and the cursor", () => {
  it("defaults and bounds", () => {
    expect(parseListQuery(undefined)).toEqual({ limit: 50 });
    expect(parseListQuery({ collectionKey: "post", locale: "en", status: "draft", linked: "false", limit: "10" })).toMatchObject({ linked: false, limit: 10, status: "draft" });
    expect(() => parseListQuery({ limit: "0" })).toThrow(/limit/);
    expect(() => parseListQuery({ limit: "101" })).toThrow(/limit/);
    expect(() => parseListQuery({ linked: "maybe" })).toThrow(/linked/);
    expect(() => parseListQuery({ siteId: "x" })).toThrow(/unknown query parameter/);
  });
  it("a cursor round-trips and a forged one is a 400", () => {
    const ts = "2026-10-12T01:02:03.123456Z";
    expect(parseListQuery({ cursor: encodeCursor(ts, ID) }).cursor).toEqual({ ts, id: ID });
    expect(() => parseListQuery({ cursor: "###" })).toThrow(/cursor/);
    expect(() => parseListQuery({ cursor: Buffer.from(`'; drop table x;--|${ID}`).toString("base64url") })).toThrow(/cursor/);
    expect(() => parseListQuery({ cursor: Buffer.from(`${ts}|not-a-uuid`).toString("base64url") })).toThrow(/cursor/);
  });
});

describe("views", () => {
  it("the writer's view carries what a brief says and no provenance", () => {
    const v = briefView(brief(), false);
    expect(v).toMatchObject({ id: ID, targetQuery: "villa bali", searchIntent: "commercial", aiQuestions: ["q1"], contentGaps: ["gap"], itemId: ITEM });
    expect(JSON.stringify(v)).not.toContain("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"); // the search property id
    expect(v).not.toHaveProperty("provenance");
    expect(v).not.toHaveProperty("grounding");
  });
  it("the manager's view adds the provenance; the summary has no body", () => {
    expect(briefView(brief(), true)).toHaveProperty("provenance.propertyId", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    const s = briefSummary(brief(), false);
    expect(s).not.toHaveProperty("body");
    expect(s).not.toHaveProperty("outline");
    expect(s).toMatchObject({ canManage: false });
  });
});

describe("MCP tools: the impact classes (agentic-native bar)", () => {
  const byName = (n: string) => webdevModule.mcpTools.find((t) => t.name === n);
  it("registers exactly these seven, in the module", () => {
    expect(WEBDESK_BRIEF_TOOLS.map((t) => t.name).sort()).toEqual([
      "webdesk.briefs.assign", "webdesk.briefs.create", "webdesk.briefs.createDraft", "webdesk.briefs.forItem", "webdesk.briefs.get", "webdesk.briefs.list", "webdesk.briefs.update",
    ]);
    for (const t of WEBDESK_BRIEF_TOOLS) expect(byName(t.name), t.name).toBeDefined();
  });
  it("create, update, assign and createDraft are LOW writes; the rest are reads; nothing is high", () => {
    for (const n of ["create", "update", "assign", "createDraft"]) expect(byName(`webdesk.briefs.${n}`), n).toMatchObject({ write: true, impact: "low" });
    for (const n of ["list", "get", "forItem"]) {
      const t = byName(`webdesk.briefs.${n}`);
      expect(t!.write, n).toBeFalsy();
      expect(t!.impact, n).toBeUndefined();
      expect(t!.method, n).toBe("GET");
    }
    expect(WEBDESK_BRIEF_TOOLS.some((t) => t.impact === "high" || t.impact === "medium")).toBe(false);
  });
  it("every path param is a required input", () => {
    for (const t of WEBDESK_BRIEF_TOOLS) {
      for (const p of [...(t.pathTemplate ?? "").matchAll(/:([A-Za-z]+)/g)].map((m) => m[1])) {
        expect((t.inputSchema as { required: string[] }).required, `${t.name}:${p}`).toContain(p);
      }
    }
  });
  it("every tool path is a route the briefs controller declares", () => {
    const src = readFileSync(join(__dirname, "webdesk-briefs.controller.ts"), "utf8");
    for (const t of WEBDESK_BRIEF_TOOLS) {
      const rel = (t.pathTemplate as string).replace("/api/:tenantId/modules/webdev/content/", "");
      expect(src, t.name).toContain(`"${rel}"`);
    }
  });
  it("the first statement of every controller handler is authorizeSite (phase 1)", () => {
    const src = readFileSync(join(__dirname, "webdesk-briefs.controller.ts"), "utf8");
    const handlers = src.split(/\n  @(?:Get|Post|Patch)\(/).slice(1);
    expect(handlers.length).toBe(7);
    for (const h of handlers) {
      const body = h.slice(h.indexOf("{", h.indexOf("async ")) + 1);
      expect(body.trimStart().startsWith("const gate = await authorizeSite("), h.slice(0, 60)).toBe(true);
    }
  });
});

describe("the search module registers the migration", () => {
  it("lists 202610122300_search_content_briefs_webdesk_link.sql", () => {
    expect(searchModule.migrations).toContain("202610122300_search_content_briefs_webdesk_link.sql");
  });
});

// ── the service's order, against stubs ───────────────────────────────────────────────────────────

const store = vi.hoisted(() => ({
  getBrief: vi.fn(),
  getBriefByItem: vi.fn(),
  getSearchBrief: vi.fn(),
  insertBrief: vi.fn(),
  linkBrief: vi.fn(),
  listBriefs: vi.fn(),
  searchPropertyExists: vi.fn(),
  updateBrief: vi.fn(),
  syncAssignee: vi.fn(),
}));
vi.mock("./webdesk-brief-store", () => store);
const authz = vi.hoisted(() => ({ authorize: vi.fn(), probe: vi.fn() }));
vi.mock("../../core/http", async (orig) => ({ ...(await orig<typeof import("../../core/http")>()), authorize: authz.authorize, writeActivity: vi.fn(async () => "a") }));
vi.mock("../../core/client-notify", () => ({ notifyBestEffort: vi.fn(async () => undefined) }));
vi.mock("./webdesk-content.service", async (orig) => ({ ...(await orig<typeof import("./webdesk-content.service")>()), probeAllowed: authz.probe }));

const SITE = { tenantSlug: "gaiada", siteId: "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4" };
const principal = { userId: USER, roles: [] } as never;
const makeGate = (action: string) => ({
  principal, tenantId: "t1", require: vi.fn(), clientAttr: () => ({}), resolveSite: vi.fn(async () => ({ tenant: { locales: ["en", "id"] }, site: { siteId: SITE.siteId } })),
  _action: action,
}) as never;

describe("service order (stubs)", () => {
  beforeEach(() => {
    for (const f of Object.values(store)) f.mockReset();
    authz.authorize.mockReset().mockResolvedValue(undefined);
    authz.probe.mockReset();
  });

  it("create: a denied caller is refused BEFORE the body is looked at, and nothing is written", async () => {
    const { WebdeskBriefsService } = await import("./webdesk-briefs.service");
    authz.authorize.mockRejectedValueOnce(new Error("403"));
    const assertCollectionExists = vi.fn();
    const svc = new WebdeskBriefsService({} as never, { assertCollectionExists } as never, {} as never);
    // an INVALID body: if validation ran first it would be a 400, not the denial
    await expect(svc.create(makeGate("assign"), SITE, { collectionKey: "post", locale: "en", unknown: 1 })).rejects.toThrow("403");
    expect(assertCollectionExists).not.toHaveBeenCalled();
    expect(store.insertBrief).not.toHaveBeenCalled();
  });

  it("create: phase 2 asks `assign` with the collection and locale the body NAMES, and the site from the wall", async () => {
    const { WebdeskBriefsService } = await import("./webdesk-briefs.service");
    store.insertBrief.mockResolvedValue(brief({ webdeskItemId: null }));
    const svc = new WebdeskBriefsService({} as never, { assertCollectionExists: vi.fn() } as never, {} as never);
    await svc.create(makeGate("assign"), SITE, { collectionKey: "post", locale: "en", topic: "T" });
    const [, resource, action] = authz.authorize.mock.calls[0];
    expect(action).toBe("assign");
    expect(resource).toMatchObject({ kind: "webdesk_content_item", tenantId: "t1", module: "webdev", siteId: SITE.siteId, collectionKey: "post", locale: "en" });
  });

  it("create: a property the caller cannot read in search is refused and no brief is inserted (search is never widened)", async () => {
    const { WebdeskBriefsService } = await import("./webdesk-briefs.service");
    store.searchPropertyExists.mockResolvedValue(true);
    authz.authorize.mockImplementation(async (_p: unknown, r: { kind: string }) => {
      if (r.kind === "resource_search_property") throw new Error("403 search");
    });
    const svc = new WebdeskBriefsService({} as never, { assertCollectionExists: vi.fn() } as never, {} as never);
    await expect(svc.create(makeGate("assign"), SITE, { collectionKey: "post", locale: "en", topic: "T", propertyId: ID })).rejects.toThrow("403 search");
    expect(store.insertBrief).not.toHaveBeenCalled();
  });

  it("create: a locale outside the tenant's is a 400 after phase 2", async () => {
    const { WebdeskBriefsService } = await import("./webdesk-briefs.service");
    const svc = new WebdeskBriefsService({} as never, { assertCollectionExists: vi.fn() } as never, {} as never);
    await expect(svc.create(makeGate("assign"), SITE, { collectionKey: "post", locale: "fr", topic: "T" })).rejects.toMatchObject({ status: 400 });
    expect(store.insertBrief).not.toHaveBeenCalled();
  });

  it("get: a brief of another site or company is a 404 BEFORE any Cerbos question", async () => {
    const { WebdeskBriefsService } = await import("./webdesk-briefs.service");
    store.getBrief.mockResolvedValue(null);
    const svc = new WebdeskBriefsService({} as never, {} as never, {} as never);
    await expect(svc.get(makeGate("read"), SITE, ID)).rejects.toMatchObject({ status: 404 });
    await expect(svc.get(makeGate("read"), SITE, "not-a-uuid")).rejects.toMatchObject({ status: 404 });
    expect(authz.probe).not.toHaveBeenCalled();
    expect(authz.authorize).not.toHaveBeenCalled();
  });

  it("get: a non-manager of an UNLINKED brief gets the denial (403), never the brief", async () => {
    const { WebdeskBriefsService } = await import("./webdesk-briefs.service");
    store.getBrief.mockResolvedValue(brief({ webdeskItemId: null, linkedAt: null }));
    authz.probe.mockResolvedValue(false);
    authz.authorize.mockRejectedValue(new Error("403"));
    const openEditorialItem = vi.fn();
    const svc = new WebdeskBriefsService({} as never, { openEditorialItem } as never, {} as never);
    await expect(svc.get(makeGate("read"), SITE, ID)).rejects.toThrow("403");
    expect(openEditorialItem).not.toHaveBeenCalled();
  });

  it("get: a non-manager reads a linked brief only when WebDesk's brief_ref names it (comment on the item, from WebDesk's facts)", async () => {
    const { WebdeskBriefsService } = await import("./webdesk-briefs.service");
    store.getBrief.mockResolvedValue(brief());
    authz.probe.mockResolvedValue(false);
    const openEditorialItem = vi.fn().mockResolvedValue({ attrs: { briefRef: ID } });
    const svc = new WebdeskBriefsService({} as never, { openEditorialItem } as never, {} as never);
    const out = (await svc.get(makeGate("read"), SITE, ID)) as Record<string, unknown>;
    expect(openEditorialItem).toHaveBeenCalledWith(expect.anything(), SITE, ITEM, "comment");
    expect(out).not.toHaveProperty("provenance");
    // WebDesk's brief_ref cleared or pointing elsewhere: the link is not confirmed, so a 404
    openEditorialItem.mockResolvedValue({ attrs: { briefRef: null } });
    await expect(svc.get(makeGate("read"), SITE, ID)).rejects.toMatchObject({ status: 404 });
    openEditorialItem.mockResolvedValue({ attrs: { briefRef: "someone-elses-brief" } });
    await expect(svc.get(makeGate("read"), SITE, ID)).rejects.toMatchObject({ status: 404 });
  });

  it("assign: phase 2 on the brief, then on the item, before the body is validated; a mismatched collection is a 409 and writes nothing", async () => {
    const { WebdeskBriefsService } = await import("./webdesk-briefs.service");
    store.getBrief.mockResolvedValue(brief({ webdeskItemId: null, linkedAt: null }));
    const openEditorialItem = vi.fn().mockResolvedValue({ collectionKey: "guide", locale: "en", attrs: { briefRef: null } });
    const itemCommand = vi.fn();
    const svc = new WebdeskBriefsService({} as never, { openEditorialItem } as never, { itemCommand } as never);
    await expect(svc.assign(makeGate("assign"), SITE, ID, { itemId: ITEM }, "idem-0001")).rejects.toMatchObject({ status: 409 });
    expect(itemCommand).not.toHaveBeenCalled();
    expect(store.linkBrief).not.toHaveBeenCalled();
    // a denied caller: invalid body, still the denial
    authz.authorize.mockRejectedValueOnce(new Error("403"));
    await expect(svc.assign(makeGate("assign"), SITE, ID, { nonsense: true }, "idem-0001")).rejects.toThrow("403");
  });

  it("assign: the item already holds ANOTHER brief -> 409 before anything is sent", async () => {
    const { WebdeskBriefsService } = await import("./webdesk-briefs.service");
    store.getBrief.mockResolvedValue(brief({ webdeskItemId: null, linkedAt: null }));
    store.getBriefByItem.mockResolvedValue(brief({ id: "99999999-9999-4999-8999-999999999999" }));
    const openEditorialItem = vi.fn().mockResolvedValue({ collectionKey: "post", locale: "en", attrs: {} });
    const itemCommand = vi.fn();
    const svc = new WebdeskBriefsService({} as never, { openEditorialItem } as never, { itemCommand } as never);
    await expect(svc.assign(makeGate("assign"), SITE, ID, { itemId: ITEM }, "idem-0001")).rejects.toMatchObject({ status: 409 });
    expect(itemCommand).not.toHaveBeenCalled();
  });

  it("createDraft: a body that names the collection or locale is a 400 (they are the BRIEF's), and nothing is created", async () => {
    const { WebdeskBriefsService } = await import("./webdesk-briefs.service");
    store.getBrief.mockResolvedValue(brief({ webdeskItemId: null, linkedAt: null }));
    const createItem = vi.fn();
    const itemCommand = vi.fn();
    const svc = new WebdeskBriefsService({} as never, { createItem } as never, { itemCommand } as never);
    // (the full create -> assign -> link sequence needs the real second gate: it is driven in the DB suite)
    await expect(svc.createDraft(makeGate("assign"), SITE, ID, { slug: "villa", collectionKey: "guide" }, "idem-0001")).rejects.toMatchObject({ status: 400 });
    expect(createItem).not.toHaveBeenCalled();
    expect(itemCommand).not.toHaveBeenCalled();
  });

  it("createDraft: an already linked brief is a 409 and nothing is created", async () => {
    const { WebdeskBriefsService } = await import("./webdesk-briefs.service");
    store.getBrief.mockResolvedValue(brief());
    const createItem = vi.fn();
    const svc = new WebdeskBriefsService({} as never, { createItem } as never, {} as never);
    await expect(svc.createDraft(makeGate("assign"), SITE, ID, { slug: "villa" }, "idem-0001")).rejects.toMatchObject({ status: 409 });
    expect(createItem).not.toHaveBeenCalled();
  });

  it("list: a manager sees the row with no WebDesk read; a non-manager's row is decided on WebDesk's facts, and a gone item is dropped", async () => {
    const { WebdeskBriefsService } = await import("./webdesk-briefs.service");
    const rows = [
      { ...brief({ id: "11111111-1111-4111-8111-111111111111", collectionKey: "post" }), cursorTs: "2026-10-12T00:00:00.000000Z" },
      { ...brief({ id: "22222222-2222-4222-8222-222222222222", collectionKey: "guide" }), cursorTs: "2026-10-11T00:00:00.000000Z" },
      { ...brief({ id: "33333333-3333-4333-8333-333333333333", collectionKey: "guide", webdeskItemId: null, linkedAt: null }), cursorTs: "2026-10-10T00:00:00.000000Z" },
    ];
    store.listBriefs.mockResolvedValue({ rows, hasMore: false });
    // `post` is managed; `guide` is not. For the non-manager rows: the narrow probe passes, then the facts probe passes.
    authz.probe.mockImplementation(async (_p: unknown, r: { collectionKey: string }, a: string) => (a === "assign" ? r.collectionKey === "post" : true));
    const itemFacts = vi.fn().mockResolvedValue({ briefRef: "22222222-2222-4222-8222-222222222222", collectionKey: "guide", locale: "en", ownerId: USER, reviewState: "draft", published: false });
    const svc = new WebdeskBriefsService({ } as never, { itemFacts } as never, {} as never);
    const out = (await svc.list(makeGate("read"), SITE, undefined)) as { briefs: Array<{ id: string; canManage: boolean }>; page: { hasMore: boolean } };
    expect(out.briefs.map((b) => b.id)).toEqual(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]); // the unlinked guide brief is not a non-manager's
    expect(out.briefs.map((b) => b.canManage)).toEqual([true, false]);
    expect(itemFacts).toHaveBeenCalledTimes(1);
    // WebDesk reports a DIFFERENT brief_ref: dropped
    itemFacts.mockResolvedValue({ briefRef: null, collectionKey: "guide", locale: "en", ownerId: USER, reviewState: "draft", published: false });
    const out2 = (await svc.list(makeGate("read"), SITE, undefined)) as { briefs: Array<{ id: string }> };
    expect(out2.briefs.map((b) => b.id)).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });

  it("list: a WebDesk failure is the error, never a quietly shorter list", async () => {
    const { WebdeskBriefsService } = await import("./webdesk-briefs.service");
    store.listBriefs.mockResolvedValue({ rows: [{ ...brief({ collectionKey: "guide" }), cursorTs: "2026-10-12T00:00:00.000000Z" }], hasMore: false });
    authz.probe.mockImplementation(async (_p: unknown, _r: unknown, a: string) => a !== "assign");
    const svc = new WebdeskBriefsService({} as never, { itemFacts: vi.fn().mockRejectedValue(new Error("breaker open")) } as never, {} as never);
    await expect(svc.list(makeGate("read"), SITE, undefined)).rejects.toThrow("breaker open");
  });
});
