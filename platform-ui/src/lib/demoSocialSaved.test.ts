import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// SCP-5e (BFF §63.26): DEMO_MODE's twin of the Saved routes, in the server's order of checks, with the gates of SCP-Q29. The store seeds from the day it is first touched, so the clock is pinned to
// mid-month (Friday 16 October 2026) before it is imported (hence vi.hoisted). Only Date is faked. Each test builds its own store from the seed.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import { PIPE_ENGAGEMENTS } from "./demoSocialPipeline";
import { DEMO_ASSETS } from "./demoSocialPipelineRun";
import { savedApi, seedSavedStore, type SavedStore } from "./demoSocialSaved";
import { socialDemo } from "./demoSocial";
import { asCollections, asSavedPage, asSavedCreated, asSavedItem } from "./socialSaved";

const USER = { officer: "u-social", officer2: "u-social-2", hod: "u-pm", gm: "u-gm", owner: "demo-owner", superadmin: "demo-hansel", companyAdmin: "u-dev", copywriter: "u-copy", designer: "u-creative", client: "demo-client", bot: "demo-bot" };
const [NORTH, SPA] = PIPE_ENGAGEMENTS.map((e) => e.id);
const NEW = "11111111-1111-4111-8111-111111111111";

let store: SavedStore;
let api: ReturnType<typeof savedApi>;
beforeEach(() => { store = seedSavedStore(); api = savedApi(store); });

const call = (method: string, tail: string, user: string, body?: unknown, query = "") => {
  const r = api.staff(method, tail, new URLSearchParams(query), body === undefined ? undefined : JSON.stringify(body), user);
  expect(r, `${method} ${tail} is a saved route`).not.toBeNull();
  return r!;
};
const error = (r: { json: unknown }) => (r.json as { error: string }).error;
const refused = (r: { status: number; json: unknown }, status: number, code: string, field?: string) => {
  expect([r.status, error(r)]).toEqual([status, code]);
  if (field) expect((r.json as { field?: string }).field).toBe(field);
};
const cols = (eng = NORTH, user = USER.officer) => asCollections(call("GET", `engagements/${eng}/saved`, user).json);
const items = (collection: string, eng = NORTH, user = USER.officer, query = "") =>
  asSavedPage(call("GET", `engagements/${eng}/saved`, user, undefined, `collection=${collection}${query}`).json, collection);

describe("the seed and the collections", () => {
  it("lists the company's six collections in its order, every one filled for Northwind", () => {
    const c = cols();
    expect(c.collections.map((x) => x.key)).toEqual(["photos", "posts", "captions", "hashtags", "templates", "references"]);
    for (const x of c.collections) expect(x.count, x.key).toBeGreaterThan(0);
    expect(c.collections.find((x) => x.key === "captions")).toMatchObject({ count: 3, derived: false, holds: ["text"] });
    expect(c.collections.find((x) => x.key === "photos")).toMatchObject({ derived: true, holds: ["asset", "link"] });
    expect(c.collections.find((x) => x.key === "hashtags")).toMatchObject({ derived: true, holds: [], count: 1 });
  });
  it("stores nothing for Saltmarsh Day Spa, so its stored collections are empty", () => {
    const c = cols(SPA);
    for (const k of ["captions", "templates", "references"]) expect(c.collections.find((x) => x.key === k)!.count, k).toBe(0);
    expect(c.collections.find((x) => x.key === "hashtags")!.count).toBe(2);
  });
  it("previews are titles for text, and canAdd follows the person", () => {
    const c = cols();
    expect(c.collections.find((x) => x.key === "captions")!.previews[0]).toBe("Weekend reminder");
    expect(c.canAdd).toBe(true);
    expect(cols(NORTH, USER.designer).canAdd).toBe(false);
  });
  it("the photos are the designs' groups (used, derived) beside the kept asset no post uses and the kept links", () => {
    const p = items("photos");
    if (p.entries.kind !== "photos") throw new Error("not photos");
    const kept = p.entries.items.find((x) => x.asset?.groupId === DEMO_ASSETS[0].groupId)!;
    expect(kept).toMatchObject({ savedItemId: expect.any(String), used: false, usedIn: 0 });
    expect(p.entries.items.some((x) => x.savedItemId === null && x.used)).toBe(true);
    expect(p.entries.items.filter((x) => x.holds === "link").map((x) => x.media).sort()).toEqual(["photo", "video"]);
  });
  it("the posts are the client's approved-or-later posts with a stored design, read-only", () => {
    const p = items("posts");
    if (p.entries.kind !== "posts") throw new Error("not posts");
    expect(p.entries.items.length).toBeGreaterThan(0);
    for (const x of p.entries.items) expect(["approved", "scheduled", "live"]).toContain(x.pipelineStatus);
  });
  it("the hashtag sets are the brand book's and unpaged", () => {
    const p = items("hashtags", SPA);
    if (p.entries.kind !== "hashtags") throw new Error("not sets");
    expect(p.entries.items.map((s) => s.name)).toEqual(["Always", "Seasonal"]);
    expect(p.nextCursor).toBeNull();
  });
});

describe("reading: the gates and the order of checks", () => {
  it("a client contact is refused every read, before anything else", () => {
    expect(call("GET", `engagements/${NORTH}/saved`, USER.client).status).toBe(403);
    expect(call("GET", "engagements/nope/saved", USER.client).status).toBe(403);
  });
  it("an unknown client is 404, and the query is judged after it (400)", () => {
    refused(call("GET", "engagements/nope/saved", USER.officer), 404, "engagement_not_found");
    const q = (s: string) => call("GET", `engagements/${NORTH}/saved`, USER.officer, undefined, s);
    refused(q("collection=nope"), 400, "invalid_field", "collection");
    refused(q("collection=captions&used=maybe"), 400, "invalid_field", "used");
    refused(q("collection=captions&source=web"), 400, "invalid_field", "source");
    refused(q("collection=captions&limit=0"), 400, "invalid_field", "limit");
    refused(q("collection=captions&cursor=@@"), 400, "invalid_field", "cursor");
  });
  it("filters by pillar, used and source, and pages with an opaque cursor", () => {
    const used = items("captions", NORTH, USER.officer, "&used=true");
    expect(used.entries.kind === "items" && used.entries.items.map((i) => i.title)).toEqual(["Harvest week opener"]);
    const pillar = items("captions", NORTH, USER.officer, "&pillar=Behind%20the%20scenes");
    expect(pillar.entries.kind === "items" && pillar.entries.items.map((i) => i.title)).toEqual(["Thank you to the team"]);
    const src = items("photos", NORTH, USER.officer, "&source=stock");
    expect(src.entries.kind === "photos" && src.entries.items.map((i) => i.title)).toEqual(["Stock: wooden table, morning light"]);
    const first = items("captions", NORTH, USER.officer, "&limit=2");
    expect(first.nextCursor).not.toBeNull();
    const second = items("captions", NORTH, USER.officer, `&limit=2&cursor=${first.nextCursor}`);
    expect(second.entries.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });
  it("items whose category the company no longer has fall under Other", () => {
    const orphan = store.items.find((i) => i.category === "captions")!;
    orphan.category = "retired";
    expect(cols().collections.find((x) => x.key === "other")).toMatchObject({ label: "Other", count: 1 });
    const p = items("other");
    expect(p.entries.kind === "items" && p.entries.items.map((i) => i.id)).toEqual([orphan.id]);
  });
});

describe("adding", () => {
  const text = { id: NEW, category: "captions", holds: "text", title: "Sale ends", body: "Last day, come in." };
  it("the team adds a text, a link and an Asset Library photo; a client contact and the Creatives designer are refused", () => {
    const t = call("POST", `engagements/${NORTH}/saved`, USER.copywriter, text);
    expect(t.status).toBe(201);
    expect(asSavedCreated(t.json)).toMatchObject({ created: true, item: { title: "Sale ends", category: "captions", addedBy: { id: "u-copy" }, useCount: 0 } });
    const l = call("POST", `engagements/${NORTH}/saved`, USER.officer, { category: "photos", holds: "link", title: "A reel", url: "https://drive.example.com/x", media: "video", source: "ai", aiNote: "Music made with a model." });
    expect(l.status).toBe(201);
    const a = call("POST", `engagements/${SPA}/saved`, USER.officer2, { category: "references", holds: "asset", title: "Portrait", assetGroupId: DEMO_ASSETS[1].versionId });
    expect(asSavedCreated(a.json).item.asset).toMatchObject({ groupId: DEMO_ASSETS[1].groupId, versionNo: 1 });
    expect(call("POST", `engagements/${NORTH}/saved`, USER.designer, text).status).toBe(403);
    expect(call("POST", `engagements/${NORTH}/saved`, USER.client, text).status).toBe(403);
    refused(call("POST", `engagements/${NORTH}/saved`, USER.bot, text), 403, "automation_cannot_act");
  });
  it("answers 404 for an unknown client before the 403, then the 403 before the body", () => {
    refused(call("POST", "engagements/nope/saved", USER.designer, text), 404, "engagement_not_found");
    expect(call("POST", `engagements/${NORTH}/saved`, USER.designer, {}).status).toBe(403);
  });
  it("judges the body in the server's order: missing and invalid fields name the field", () => {
    const post = (b: unknown) => call("POST", `engagements/${NORTH}/saved`, USER.officer, b);
    refused(post({}), 400, "missing_field", "category");
    refused(post({ category: "captions" }), 400, "missing_field", "holds");
    refused(post({ category: "captions", holds: "video" }), 400, "invalid_field", "holds");
    refused(post({ category: "captions", holds: "link", title: "x" }), 400, "invalid_field", "category");
    refused(post({ category: "hashtags", holds: "text", title: "x", body: "y" }), 400, "invalid_field", "category");
    refused(post({ category: "captions", holds: "text" }), 400, "missing_field", "title");
    refused(post({ category: "captions", holds: "text", title: "x".repeat(121), body: "y" }), 400, "invalid_field", "title");
    refused(post({ category: "captions", holds: "text", title: "x" }), 400, "missing_field", "body");
    refused(post({ category: "captions", holds: "text", title: "x", body: "y", url: "https://a.example" }), 400, "invalid_field", "url");
    refused(post({ category: "photos", holds: "link", title: "x", url: "ftp://a", source: "own" }), 400, "invalid_field", "url");
    refused(post({ category: "photos", holds: "link", title: "x", url: "https://a.example" }), 400, "missing_field", "source");
    refused(post({ category: "photos", holds: "link", title: "x", url: "https://a.example", source: "ai" }), 400, "missing_field", "aiNote");
    refused(post({ category: "photos", holds: "link", title: "x", url: "https://a.example", source: "own", media: "gif" }), 400, "invalid_field", "media");
    refused(post({ category: "photos", holds: "asset", title: "x" }), 400, "missing_field", "assetGroupId");
    refused(post({ category: "captions", holds: "text", title: "x", body: "y", extra: 1 }), 400, "invalid_field", "extra");
    refused(post({ id: "not-a-uuid", category: "captions", holds: "text", title: "x", body: "y" }), 400, "invalid_field", "id");
  });
  it("an asset outside the company is 404, and one already kept answers 200 created false", () => {
    refused(call("POST", `engagements/${NORTH}/saved`, USER.officer, { category: "photos", holds: "asset", title: "x", assetGroupId: "nope" }), 404, "asset_not_found");
    const again = call("POST", `engagements/${NORTH}/saved`, USER.officer, { category: "photos", holds: "asset", title: "again", assetGroupId: DEMO_ASSETS[0].groupId });
    expect(again.status).toBe(200);
    expect(asSavedCreated(again.json)).toMatchObject({ created: false, item: { title: "Autumn hero - final" } });
  });
  it("a replayed id answers the item as it is (200), before the body is judged, and another client's id is 400", () => {
    call("POST", `engagements/${NORTH}/saved`, USER.officer, text);
    const replay = call("POST", `engagements/${NORTH}/saved`, USER.officer, { id: NEW });
    expect(replay.status).toBe(200);
    expect(asSavedCreated(replay.json)).toMatchObject({ created: false, item: { title: "Sale ends" } });
    refused(call("POST", `engagements/${SPA}/saved`, USER.officer2, { ...text }), 400, "invalid_field", "id");
  });
});

describe("changing and deleting (SCP-Q29)", () => {
  const caption = () => store.items.find((i) => i.title === "Weekend reminder")!; // written by u-social-2; Northwind's officer is u-social
  it("the author changes their own item; the client's officer and the four change anyone's; another member is 403 not_officer_or_approver", () => {
    const id = caption().id;
    expect(call("PATCH", `saved/${id}`, USER.officer2, { title: "Weekend note" }).status).toBe(200);
    expect(asSavedItem((call("PATCH", `saved/${id}`, USER.officer, { pillar: "Product stories" }).json as { item: unknown }).item).pillar).toBe("Product stories");
    for (const u of [USER.hod, USER.gm, USER.owner, USER.superadmin]) expect(call("PATCH", `saved/${id}`, u, { title: `By ${u}` }).status, u).toBe(200);
    refused(call("PATCH", `saved/${id}`, USER.copywriter, { title: "no" }), 403, "not_officer_or_approver");
    refused(call("DELETE", `saved/${id}`, USER.copywriter), 403, "not_officer_or_approver");
    refused(call("PATCH", `saved/${id}`, USER.bot, { title: "no" }), 403, "automation_cannot_act");
  });
  it("is 404 for an item that is gone, before the 403; a delete is a soft delete that removes it from the lists", () => {
    refused(call("PATCH", "saved/nope", USER.copywriter, { title: "x" }), 404, "saved_item_not_found");
    const id = caption().id;
    expect(call("DELETE", `saved/${id}`, USER.officer2).json).toEqual({ id, deleted: true });
    refused(call("DELETE", `saved/${id}`, USER.officer2), 404, "saved_item_not_found");
    expect(cols().collections.find((x) => x.key === "captions")!.count).toBe(2);
  });
  it("judges the change by the item's own shape", () => {
    const text = caption().id;
    const link = store.items.find((i) => i.holds === "link" && i.source === "stock")!.id;
    const patch = (id: string, b: unknown) => call("PATCH", `saved/${id}`, USER.hod, b);
    refused(patch(text, {}), 400, "missing_field", "title");
    refused(patch(text, { nope: 1 }), 400, "invalid_field", "nope");
    refused(patch(text, { source: "own" }), 400, "invalid_field", "source");
    refused(patch(link, { body: "x" }), 400, "invalid_field", "body");
    refused(patch(link, { source: "ai" }), 400, "missing_field", "aiNote");
    expect(patch(link, { source: "ai", aiNote: "Made with a model." }).status).toBe(200);
    refused(patch(text, { category: "photos" }), 400, "invalid_field", "category");
    expect(patch(text, { category: "templates", pillar: null }).status).toBe(200);
  });
});

describe("through the DEMO_MODE router", () => {
  it("answers the saved routes from socialDemo", () => {
    const r = socialDemo("GET", `/api/co-agency/modules/social/engagements/${NORTH}/saved`, new URLSearchParams(), undefined, USER.officer)!;
    expect(r.status).toBe(200);
    expect(asCollections(r.json).collections.length).toBeGreaterThan(0);
  });
});
