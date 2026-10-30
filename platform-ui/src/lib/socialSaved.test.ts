import { describe, it, expect } from "vitest";

// SCP-5e (BFF §63.26): Saved's parsers, words, query rules and the forms' own checks. A parsed answer that is the wrong shape throws (the reader turns that into "cannot tell"); every refusal has words
// that say who may; the checks name the server's own limits before a request is made.
import { REFUSAL_WORDS } from "./socialPipeline";
import {
  SAVED_ADD_REASON, SAVED_CHANGE_REASON, asCollections, asSavedCreated, asSavedItem, asSavedPage, asSavedPhoto, buildSavedCreate, buildSavedPatch, clientsMineFirst, defaultHolds,
  editFormOf, emptyAddForm, filtersFor, hasFilter, parseSavedView, photoKindWords, photoUseWords, previewKind, savedHref, savedQuery, savedRefusalText, sourceWords,
  storableCollections, useWords, type SavedCollection, type SavedItem,
} from "./socialSaved";

const col = (o: Partial<SavedCollection> & { key: string }): SavedCollection => ({ label: o.key, holds: [], derived: false, count: 0, previews: [], ...o });
const COLS = [col({ key: "photos", holds: ["asset", "link"], derived: true }), col({ key: "posts", derived: true }), col({ key: "captions", holds: ["text"] }), col({ key: "hashtags", derived: true }), col({ key: "references", holds: ["link", "asset"] })];
const item = (o: Record<string, unknown> = {}): SavedItem => asSavedItem({ id: "i1", category: "captions", holds: "text", title: "Opener", body: "Hello", addedAt: "2026-10-01T00:00:00Z", ...o });

describe("the collections", () => {
  it("parses the company's collections in order with counts, previews and canAdd", () => {
    const r = asCollections({ collections: [{ key: "photos", label: "Photos and videos", holds: ["asset", "link"], derived: true, count: 3, previews: ["v1", "v2"] }, { key: "captions", label: "Captions", holds: ["text"], derived: false, count: 0, previews: [] }], canAdd: true });
    expect(r.canAdd).toBe(true);
    expect(r.collections.map((c) => [c.key, c.count, c.derived])).toEqual([["photos", 3, true], ["captions", 0, false]]);
  });
  it("throws for a body that is not a list, and never trusts canAdd that is not exactly true", () => {
    expect(() => asCollections({})).toThrow();
    expect(() => asCollections({ collections: [{ label: "x" }] })).toThrow();
    expect(asCollections({ collections: [], canAdd: "yes" }).canAdd).toBe(false);
  });
  it("says what the previews are, and which collections store something", () => {
    expect(previewKind(COLS[0])).toBe("asset");
    expect(previewKind(COLS[1])).toBe("file");
    expect(previewKind(COLS[2])).toBe("text");
    expect(storableCollections(COLS).map((c) => c.key)).toEqual(["photos", "captions", "references"]);
    expect(defaultHolds(COLS[0])).toBe("link");
    expect(defaultHolds(COLS[2])).toBe("text");
    expect(defaultHolds(col({ key: "x", holds: ["asset"] }))).toBe("asset");
  });
});

describe("a page of entries is parsed by the collection's own shape", () => {
  it("photos, posts, hashtag sets and stored items", () => {
    expect(asSavedPage({ items: [{ key: "g:1", savedItemId: null, holds: "asset", title: "Hero", used: true, usedIn: 2, asset: { groupId: "g1", versionId: "v1", versionNo: 2, contentType: "image/png" } }], nextCursor: "abc" }, "photos"))
      .toMatchObject({ entries: { kind: "photos", items: [{ key: "g:1", savedItemId: null, used: true, usedIn: 2, asset: { versionNo: 2 } }] }, nextCursor: "abc" });
    expect(asSavedPage({ items: [{ postId: "p1", title: "Post", pipelineStatus: "live", simulated: true }], nextCursor: null }, "posts")).toMatchObject({ entries: { kind: "posts", items: [{ simulated: true }] } });
    expect(asSavedPage({ items: [{ key: "set-1", name: "Always", tags: ["a", "b", 3] }], nextCursor: "ignored" }, "hashtags")).toMatchObject({ entries: { kind: "hashtags", items: [{ tags: ["a", "b"] }] }, nextCursor: null });
    expect(asSavedPage({ items: [{ id: "i1", category: "captions", holds: "text", title: "T", body: "B" }] }, "captions")).toMatchObject({ entries: { kind: "items", items: [{ id: "i1", body: "B" }] }, nextCursor: null });
  });
  it("throws for a body that is not a page or an item of the wrong shape, never an empty list", () => {
    expect(() => asSavedPage({}, "captions")).toThrow();
    expect(() => asSavedPage({ items: [{ id: "i1", holds: "video", title: "T" }] }, "captions")).toThrow();
    expect(() => asSavedPhoto({ key: "k", holds: "text", title: "T" })).toThrow();
    expect(() => asSavedCreated({ item: {} })).toThrow();
    expect(asSavedCreated({ item: { id: "i", holds: "link", title: "T" }, created: false }).created).toBe(false);
  });
});

describe("words", () => {
  it("names a source, how often an item was used and what a photo is", () => {
    expect(sourceWords("stock")).toBe("Stock");
    expect(sourceWords(null)).toBe("Source not known");
    expect(sourceWords("odd")).toBe("odd");
    expect(useWords({ useCount: 0, used: false })).toBe("Not used yet");
    expect(useWords({ useCount: 1, used: true })).toBe("Used once");
    expect(useWords({ useCount: 4, used: true })).toBe("Used 4 times");
    expect(photoUseWords({ used: false, usedIn: 0 })).toBe("Not used yet");
    expect(photoUseWords({ used: true, usedIn: 1 })).toBe("Used in 1 post");
    expect(photoUseWords({ used: true, usedIn: 3 })).toBe("Used in 3 posts");
    expect(photoKindWords({ holds: "asset", media: null, savedItemId: null })).toBe("Photo from a design");
    expect(photoKindWords({ holds: "asset", media: null, savedItemId: "s" })).toBe("Asset Library photo, kept");
    expect(photoKindWords({ holds: "link", media: "video", savedItemId: "s" })).toBe("Video link");
  });
  it("a 403 says who may; a 400 field is worded; a 404 is the contract's words; nothing is a bare code", () => {
    expect(savedRefusalText({ status: 403, error: "forbidden" }, "add")).toBe(`You cannot do this. ${SAVED_ADD_REASON}`);
    expect(savedRefusalText({ status: 403, error: "forbidden" }, "change")).toBe(`You cannot do this. ${SAVED_CHANGE_REASON}`);
    expect(savedRefusalText({ status: 403, error: "not_officer_or_approver" }, "delete")).toBe(REFUSAL_WORDS.not_officer_or_approver);
    expect(savedRefusalText({ status: 403, error: "automation_cannot_act" }, "add")).toBe(REFUSAL_WORDS.automation_cannot_act);
    expect(savedRefusalText({ status: 400, error: "invalid_field", field: "category" }, "add")).toMatch(/does not take this kind of item/);
    expect(savedRefusalText({ status: 400, error: "missing_field", field: "aiNote" }, "add")).toMatch(/needs this note/);
    expect(savedRefusalText({ status: 400, error: "invalid_field", field: "url" }, "add")).toMatch(/http:\/\//);
    expect(savedRefusalText({ status: 404, error: "saved_item_not_found" })).toBe(REFUSAL_WORDS.saved_item_not_found);
    expect(savedRefusalText({ status: 404, error: "asset_not_found" }, "add")).toBe(REFUSAL_WORDS.asset_not_found);
    expect(savedRefusalText({ status: 404, error: "engagement_not_found" }, "add")).toBe(REFUSAL_WORDS.engagement_not_found);
    for (const w of [SAVED_ADD_REASON, SAVED_CHANGE_REASON]) expect(w).not.toContain("_");
  });
});

describe("the page's query and links", () => {
  it("ignores a value that is not one, so a mistyped link shows the whole bank", () => {
    expect(parseSavedView({ used: "maybe", source: "web", pillar: "x".repeat(61) })).toEqual({ client: null, collection: null, pillar: null, used: null, source: null, cursor: null });
    expect(parseSavedView({ client: "e1", collection: "captions", pillar: "Rituals", used: "false", source: "stock", cursor: "c" }))
      .toEqual({ client: "e1", collection: "captions", pillar: "Rituals", used: false, source: "stock", cursor: "c" });
    expect(parseSavedView({ used: ["true", "false"] }).used).toBe(true);
  });
  it("builds links that keep what they should and the server's own query", () => {
    expect(savedHref("d 1", {})).toBe("/departments/d%201/saved");
    expect(savedHref("d1", { client: "e1", collection: "photos", used: false, source: "own", pillar: "A b" })).toBe("/departments/d1/saved?client=e1&collection=photos&pillar=A+b&used=false&source=own");
    expect(savedQuery({ collection: "captions", pillar: null, used: true, source: null, cursor: "c" })).toBe("collection=captions&used=true&cursor=c");
    expect(hasFilter({ pillar: null, used: null, source: null })).toBe(false);
    expect(hasFilter({ pillar: null, used: false, source: null })).toBe(true);
    expect(filtersFor({ key: "hashtags" })).toEqual({ pillar: false, used: false, source: false });
    expect(filtersFor({ key: "posts" })).toEqual({ pillar: true, used: false, source: false });
    expect(filtersFor({ key: "captions" })).toEqual({ pillar: true, used: true, source: true });
  });
  it("puts the caller's clients first, each group in its own order", () => {
    const all = [{ engagementId: "a" }, { engagementId: "b" }, { engagementId: "c" }];
    expect(clientsMineFirst(all, [{ engagementId: "c" }]).map((r) => [r.engagementId, r.mine])).toEqual([["c", true], ["a", false], ["b", false]]);
    expect(clientsMineFirst(all, []).map((r) => r.engagementId)).toEqual(["a", "b", "c"]);
  });
});

describe("adding: the form's own checks", () => {
  const link = { ...emptyAddForm("photos", "link"), title: "Reel", url: "https://drive.example.com/x", source: "own" as const };
  it("a text needs a title and a body within the limits, and carries nothing else", () => {
    const f = { ...emptyAddForm("captions", "text"), title: " Opener ", body: " Hello " };
    expect(buildSavedCreate(f, "id1")).toEqual({ ok: true, body: { id: "id1", category: "captions", holds: "text", title: "Opener", body: "Hello" } });
    expect(buildSavedCreate({ ...f, title: " " }, "i")).toMatchObject({ ok: false, field: "title" });
    expect(buildSavedCreate({ ...f, title: "x".repeat(121) }, "i")).toMatchObject({ ok: false, field: "title" });
    expect(buildSavedCreate({ ...f, body: "" }, "i")).toMatchObject({ ok: false, field: "body" });
    expect(buildSavedCreate({ ...f, body: "x".repeat(5001) }, "i")).toMatchObject({ ok: false, field: "body" });
    expect(buildSavedCreate({ ...f, url: "https://ignored.example" }, "i")).toMatchObject({ ok: true, body: expect.not.objectContaining({ url: expect.anything() }) });
  });
  it("a link needs an http(s) address and a source; a link made with AI needs its note; a video is a link with media video", () => {
    expect(buildSavedCreate({ ...link, media: "video" }, "i")).toEqual({ ok: true, body: { id: "i", category: "photos", holds: "link", title: "Reel", url: "https://drive.example.com/x", source: "own", media: "video" } });
    expect(buildSavedCreate({ ...link, url: "" }, "i")).toMatchObject({ ok: false, field: "url" });
    expect(buildSavedCreate({ ...link, url: "ftp://x" }, "i")).toMatchObject({ ok: false, field: "url" });
    expect(buildSavedCreate({ ...link, url: "https://a b" }, "i")).toMatchObject({ ok: false, field: "url" });
    expect(buildSavedCreate({ ...link, source: "" }, "i")).toMatchObject({ ok: false, field: "source" });
    expect(buildSavedCreate({ ...link, source: "ai" }, "i")).toMatchObject({ ok: false, field: "aiNote" });
    expect(buildSavedCreate({ ...link, source: "ai", aiNote: "Music by a model." }, "i")).toMatchObject({ ok: true, body: { source: "ai", aiNote: "Music by a model." } });
    expect(buildSavedCreate({ ...link, pillar: "x".repeat(61) }, "i")).toMatchObject({ ok: false, field: "pillar" });
  });
  it("an Asset Library photo needs its group and carries no source of its own", () => {
    const f = { ...emptyAddForm("photos", "asset"), title: "Hero" };
    expect(buildSavedCreate(f, "i")).toMatchObject({ ok: false, field: "assetGroupId" });
    expect(buildSavedCreate({ ...f, assetGroupId: "g1", source: "own" }, "i")).toEqual({ ok: true, body: { id: "i", category: "photos", holds: "asset", title: "Hero", assetGroupId: "g1" } });
  });
});

describe("changing: only what changed, for the item's own shape", () => {
  it("sends nothing when nothing changed, and names a mistake before the request", () => {
    const i = item();
    expect(buildSavedPatch(i, editFormOf(i))).toEqual({ ok: false, field: "", message: "Nothing has changed." });
    expect(buildSavedPatch(i, { ...editFormOf(i), title: "" })).toMatchObject({ ok: false, field: "title" });
    expect(buildSavedPatch(i, { ...editFormOf(i), body: "" })).toMatchObject({ ok: false, field: "body" });
    expect(buildSavedPatch(i, { ...editFormOf(i), title: " New ", pillar: " Rituals " })).toEqual({ ok: true, body: { title: "New", pillar: "Rituals" } });
    expect(buildSavedPatch(item({ pillar: "Rituals" }), { ...editFormOf(item({ pillar: "Rituals" })), pillar: "" })).toEqual({ ok: true, body: { pillar: null } });
  });
  it("a text's body, a link's source and note, an asset's neither, and a move for an item under Other", () => {
    const text = item();
    expect(buildSavedPatch(text, { ...editFormOf(text), body: "Changed" })).toEqual({ ok: true, body: { body: "Changed" } });
    const link = item({ holds: "link", body: null, url: "https://a.example", source: "own", category: "photos" });
    expect(buildSavedPatch(link, { ...editFormOf(link), body: "ignored" })).toMatchObject({ ok: false });
    expect(buildSavedPatch(link, { ...editFormOf(link), source: "ai" })).toMatchObject({ ok: false, field: "aiNote" });
    expect(buildSavedPatch(link, { ...editFormOf(link), source: "ai", aiNote: " Model. " })).toEqual({ ok: true, body: { source: "ai", aiNote: "Model." } });
    const asset = item({ holds: "asset", body: null, category: "photos", asset: { groupId: "g", versionId: "v", versionNo: 1, contentType: "image/png" } });
    expect(buildSavedPatch(asset, { ...editFormOf(asset), body: "x", source: "own" })).toMatchObject({ ok: false });
    const orphan = item({ category: "retired" });
    expect(buildSavedPatch(orphan, { ...editFormOf(orphan), category: "captions" })).toEqual({ ok: true, body: { category: "captions" } });
  });
});
