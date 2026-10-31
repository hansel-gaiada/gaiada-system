import { describe, it, expect } from "vitest";
import { editableFieldsOf, refusalFromBody, type PipelinePost } from "./socialPipeline";
import { asCollections, asSavedPage } from "./socialSaved";
import {
  SAVED_USE_MAX, buildUseInPost, canUseFromSaved, chosenWords, pickerGroups, searchGroups, unusableWords, useRefusalText, type PickEntry,
} from "./socialSavedUse";

// SCP-5e (BFF §63.26.3): the pure rules of "Use from Saved": the picker's groups, the search, where each item goes, the body of the post edit, and the words for a refusal.

type P = Pick<PipelinePost, "pipelineStatus" | "change" | "caption" | "hashtags" | "rawAssets" | "archivedAt">;
const post = (over: Partial<P> = {}): P => ({ pipelineStatus: "drafting", change: null, caption: "", hashtags: [], rawAssets: [], archivedAt: null, ...over });
const entry = (over: Partial<PickEntry> & Pick<PickEntry, "key" | "holds">): PickEntry => ({
  id: over.holds === "hashtags" ? null : `id-${over.key}`, title: over.key, body: null, url: null, media: null, source: null, aiNote: null, tags: [], versionId: null, useWords: "Not used yet", useCount: 0, ...over,
});
const text = (key: string, body: string) => entry({ key, holds: "text", body });
const link = (key: string, url: string, source: string | null = "client") => entry({ key, holds: "link", url, source });
const set = (key: string, tags: string[]) => entry({ key, holds: "hashtags", tags });

describe("buildUseInPost", () => {
  it("a text goes into an empty caption, and after a blank line into a caption that has words; only the changed field is sent, with the stored item's id", () => {
    const a = buildUseInPost(post(), [text("c1", "  The harvest is in.  ")]);
    expect(a).toEqual({ ok: true, body: { fields: { caption: "The harvest is in." }, savedItemIds: ["id-c1"] }, counted: 1 });
    const b = buildUseInPost(post({ caption: "Opening line.  \n" }), [text("c1", "One"), text("c2", "Two")]);
    expect(b).toEqual({ ok: true, body: { fields: { caption: "Opening line.\n\nOne\n\nTwo" }, savedItemIds: ["id-c1", "id-c2"] }, counted: 2 });
  });

  it("a hashtag set merges into the hashtags without the # sign or repeats; it has no item id, so it is not counted", () => {
    const r = buildUseInPost(post({ hashtags: ["Local"] }), [set("h1", ["#local", "Fresh", " #market ", ""])]);
    expect(r).toEqual({ ok: true, body: { fields: { hashtags: ["Local", "Fresh", "market"] } }, counted: 0 });
    // a set that adds nothing changes nothing
    expect(buildUseInPost(post({ hashtags: ["a"] }), [set("h1", ["A"])])).toEqual({ ok: false, message: "Everything you chose is already in the post, so there is nothing to add." });
  });

  it("a link goes into the reference images with its title, source and AI note; one already there is not added twice", () => {
    const old = { url: "https://example.com/old", label: "Old", source: "own", aiNote: null };
    const r = buildUseInPost(post({ rawAssets: [old] }), [link("l1", "https://example.com/new"), link("l2", "https://example.com/old"), link("l3", "https://example.com/ai", "ai")]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.fields.rawAssets).toEqual([
      old,
      { url: "https://example.com/new", label: "l1", source: "client", aiNote: null },
      { url: "https://example.com/ai", label: "l3", source: "ai", aiNote: null },
    ]);
    expect(r.body.savedItemIds).toEqual(["id-l1", "id-l2", "id-l3"]);
  });

  it("a mix sends copy and images in one edit", () => {
    const r = buildUseInPost(post(), [text("c1", "Hello"), set("h1", ["a"]), link("l1", "https://example.com/x")]);
    expect(r.ok && Object.keys(r.body.fields).sort()).toEqual(["caption", "hashtags", "rawAssets"]);
    expect(r.ok && r.counted).toBe(2);
  });

  it("holds the server's bounds: 1 to 10 items, distinct, a caption up to 5,000, 60 hashtags, 10 reference images", () => {
    expect(buildUseInPost(post(), [])).toEqual({ ok: false, message: "Choose at least one item." });
    const eleven = Array.from({ length: SAVED_USE_MAX + 1 }, (_, i) => text(`c${i}`, "x"));
    expect(buildUseInPost(post(), eleven)).toEqual({ ok: false, message: `Choose at most ${SAVED_USE_MAX} items.` });
    expect(buildUseInPost(post(), eleven.slice(0, SAVED_USE_MAX)).ok).toBe(true);
    expect(buildUseInPost(post(), [text("c1", "x"), text("c1", "y")])).toEqual({ ok: false, message: "An item is chosen twice." });
    const long = buildUseInPost(post({ caption: "y".repeat(4990) }), [text("c1", "x".repeat(20))]);
    expect(long.ok).toBe(false);
    expect(!long.ok && long.message).toMatch(/over 5,000 characters/);
    const many = Array.from({ length: 61 }, (_, i) => `t${i}`);
    expect(buildUseInPost(post(), [set("h1", many)])).toEqual({ ok: false, message: "The post would have 61 hashtags and takes at most 60. Choose a smaller set." });
    const nine = Array.from({ length: 9 }, (_, i) => ({ url: `https://e.com/${i}`, label: "", source: "own", aiNote: null }));
    const imgs = buildUseInPost(post({ rawAssets: nine }), [link("l1", "https://e.com/a"), link("l2", "https://e.com/b")]);
    expect(!imgs.ok && imgs.message).toMatch(/11 reference images and takes at most 10/);
  });

  it("refuses what the post's step does not take, in words: an Asset Library photo always, the copy in planned, the images in a copy change", () => {
    const photo = entry({ key: "a1", holds: "asset", title: "Autumn hero" });
    expect(buildUseInPost(post(), [photo])).toEqual({ ok: false, message: "Autumn hero: An Asset Library photo becomes a design through the designer, so it cannot be added here." });
    expect(buildUseInPost(post({ pipelineStatus: "planned" }), [text("c1", "x")])).toEqual({ ok: false, message: "c1: The caption cannot change at this step." });
    const copyChange = post({ pipelineStatus: "changes", change: { by: "", kind: "", returnTo: "", note: null, case: "client_copy" } });
    expect(buildUseInPost(copyChange, [link("l1", "https://e.com/x")])).toEqual({ ok: false, message: "l1: The reference images cannot change at this step." });
    expect(buildUseInPost(copyChange, [text("c1", "x")]).ok).toBe(true);
  });

  it("agrees with the fixture's editRules: planned takes images only, drafting both, a copy change the copy", () => {
    expect(editableFieldsOf({ pipelineStatus: "planned", change: null }).fields).toContain("rawAssets");
    expect(editableFieldsOf({ pipelineStatus: "planned", change: null }).fields).not.toContain("caption");
    expect(unusableWords(post({ pipelineStatus: "planned" }), { holds: "link" })).toBeNull();
    expect(unusableWords(post({ pipelineStatus: "planned" }), { holds: "hashtags" })).toMatch(/hashtags cannot change/);
    expect(unusableWords(post(), { holds: "text" })).toBeNull();
    expect(unusableWords(post(), { holds: "hashtags" })).toBeNull();
  });
});

describe("canUseFromSaved", () => {
  it("is offered to an author where the copy or the images may change, and nowhere else", () => {
    expect(canUseFromSaved(post(), true)).toBe(true);
    expect(canUseFromSaved(post({ pipelineStatus: "planned" }), true)).toBe(true);
    expect(canUseFromSaved(post(), false)).toBe(false);
    expect(canUseFromSaved(post({ archivedAt: "2026-10-01T00:00:00Z" }), true)).toBe(false);
    for (const s of ["proofread", "hod", "design", "final", "client", "approved", "scheduled", "live", "blocked"]) expect(canUseFromSaved(post({ pipelineStatus: s }), true), s).toBe(false);
    expect(canUseFromSaved(post({ pipelineStatus: "changes", change: { by: "", kind: "", returnTo: "", note: null, case: "hod_copy" } }), true)).toBe(true);
    expect(canUseFromSaved(post({ pipelineStatus: "changes", change: { by: "", kind: "", returnTo: "", note: null, case: "client_design" } }), true)).toBe(false);
  });
});

describe("the picker's groups and search", () => {
  const collections = asCollections({
    collections: [
      { key: "photos", label: "Photos and videos", holds: ["asset", "link"], derived: true, count: 3, previews: [] },
      { key: "posts", label: "Approved posts", holds: [], derived: true, count: 1, previews: [] },
      { key: "captions", label: "Captions", holds: ["text"], derived: false, count: 1, previews: [] },
      { key: "hashtags", label: "Hashtag sets", holds: [], derived: true, count: 1, previews: [] },
    ],
    canAdd: true,
  });
  const pages = [
    asSavedPage({ items: [
      { key: "g:1", savedItemId: null, holds: "asset", title: "A design's photo", asset: { groupId: "g1", versionId: "v1" }, used: true, usedIn: 1 },
      { key: "s:2", savedItemId: "i-2", holds: "link", title: "Stock table", media: "photo", url: "https://example.com/table", source: "stock", used: false, usedIn: 0 },
      { key: "s:3", savedItemId: "i-3", holds: "asset", title: "Kept photo", asset: { groupId: "g3", versionId: "v3" }, used: false, usedIn: 0 },
    ] }, "photos"),
    asSavedPage({ items: [{ id: "i-4", category: "captions", holds: "text", title: "Harvest opener", body: "Fresh and local.", useCount: 2, used: true }] }, "captions"),
    asSavedPage({ items: [{ key: "set-1", name: "Market set", tags: ["#local", "fresh"] }] }, "hashtags"),
  ];
  const groups = pickerGroups(collections.collections, pages);

  it("groups by the company's categories in their order, without the approved posts or a design's own photo, with each item's use words", () => {
    expect(groups.map((g) => g.label)).toEqual(["Photos and videos", "Captions", "Hashtag sets"]);
    expect(groups[0].entries.map((e) => [e.title, e.id, e.holds])).toEqual([["Stock table", "i-2", "link"], ["Kept photo", "i-3", "asset"]]);
    expect(groups[1].entries[0]).toMatchObject({ id: "i-4", useWords: "Used 2 times", useCount: 2, holds: "text" });
    expect(groups[2].entries[0]).toMatchObject({ id: null, holds: "hashtags", tags: ["#local", "fresh"], useWords: "From the brand book" });
  });

  it("searches every word across the title, the text, the link and the tags, case-blind; an empty search keeps all and a group left empty is dropped", () => {
    expect(searchGroups(groups, "")).toHaveLength(3);
    expect(searchGroups(groups, "LOCAL").map((g) => g.label)).toEqual(["Captions", "Hashtag sets"]);
    expect(searchGroups(groups, "fresh local").map((g) => g.label)).toEqual(["Captions", "Hashtag sets"]);
    expect(searchGroups(groups, "harvest fresh").map((g) => g.label)).toEqual(["Captions"]);
    expect(searchGroups(groups, "example.com table").map((g) => g.entries.map((e) => e.title))).toEqual([["Stock table"]]);
    expect(searchGroups(groups, "nothing like this")).toEqual([]);
  });
});

describe("the words", () => {
  it("a savedItemIds refusal says what may be wrong and that nothing was changed or counted", () => {
    const t = useRefusalText(refusalFromBody(400, "invalid_field", {}, "savedItemIds"));
    expect(t).toMatch(/another client/);
    expect(t).toMatch(/Nothing was changed or counted\.$/);
  });
  it("a machine refusal keeps its own sentence and adds that nothing was counted", () => {
    expect(useRefusalText(refusalFromBody(409, "field_locked", { detail: { field: "caption", status: "planned" } }))).toBe("Caption cannot be changed at Planned. Nothing was changed or counted.");
    expect(useRefusalText(refusalFromBody(409, "status_changed", { detail: { status: "proofread" } }))).toMatch(/Nothing was changed or counted\.$/);
    expect(useRefusalText(refusalFromBody(403, "not_the_officer", {}))).toBe("Only the client's officer can do this. Nothing was changed or counted.");
  });
  it("says how many are chosen and that ten is the most", () => {
    expect(chosenWords(0)).toBe("0 of 10 chosen.");
    expect(chosenWords(10)).toBe("10 of 10 chosen. That is the most one edit takes.");
  });
});
