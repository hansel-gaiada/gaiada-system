// SCP-5e (W5-B3) — Saved's pure half: the bodies, the query, the cursor and `savedItemIds` (FRONTEND-BFF-CONTRACT §63.26). No services needed.
//
//   1. The categories are the company's: an unknown, hidden or read-only category is `{field: 'category'}`, and a category that does not take the
//      item's shape too; a renamed, reordered or added category follows the rules, not a constant in this file.
//   2. Each shape: asset (group only), link (url and source, a note for `ai`, media), text (body only); a field of another shape is 400 on it.
//   3. A change: the item's own fields only; `body` for a text, `source` and `aiNote` for a link; a link left as `ai` keeps its note; `category` moves.
//   4. The list's query, the opaque cursor and `savedItemIds` (1 to 10 distinct uuids).
import { describe, it, expect } from "vitest";
import { socialModule } from "../index";
import { DEFAULT_RULES, savedCategories, validateSection, type RulesDoc } from "./rules";
import {
  decodeSavedCursor, encodeSavedCursor, parseSavedCreate, parseSavedItemIds, parseSavedListQuery, parseSavedPatch,
} from "./saved";

const CATS = savedCategories(DEFAULT_RULES);
const G = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";

/** The refusal of a call as `code:field`, or "ok". */
function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    const r = (e as { getResponse: () => { message: string; field?: string } }).getResponse();
    return `${r.message}:${r.field}`;
  }
  return "ok";
}

const text = (o: Record<string, unknown> = {}) => ({ category: "captions", holds: "text", title: "Spring caption", body: "Hello spring", ...o });
const link = (o: Record<string, unknown> = {}) => ({ category: "references", holds: "link", title: "Shoot", url: "https://drive.example.test/f/1", source: "client", ...o });
const asset = (o: Record<string, unknown> = {}) => ({ category: "photos", holds: "asset", title: "Hero", assetGroupId: G, ...o });

describe("parseSavedCreate · the shapes (63.26.1 CHECKs, said as typed refusals)", () => {
  it("accepts each shape and trims", () => {
    expect(parseSavedCreate(text({ title: "  Spring caption  ", body: " Hello " }), CATS)).toMatchObject({ holds: "text", title: "Spring caption", body: "Hello", url: null, assetGroupId: null });
    expect(parseSavedCreate(link({ media: "video" }), CATS)).toMatchObject({ holds: "link", url: "https://drive.example.test/f/1", source: "client", media: "video", body: null });
    expect(parseSavedCreate(asset({ assetGroupId: G.toUpperCase(), pillar: "Offers" }), CATS)).toMatchObject({ holds: "asset", assetGroupId: G, pillar: "Offers", source: null, url: null });
  });
  it("a text carries its body and nothing of the others", () => {
    expect(refusal(() => parseSavedCreate(text({ body: undefined }), CATS))).toBe("missing_field:body");
    expect(refusal(() => parseSavedCreate(text({ body: "   " }), CATS))).toBe("invalid_field:body");
    expect(refusal(() => parseSavedCreate(text({ body: "x".repeat(5001) }), CATS))).toBe("invalid_field:body");
    for (const f of ["url", "media", "assetGroupId", "source", "aiNote"]) {
      expect(refusal(() => parseSavedCreate(text({ [f]: f === "assetGroupId" ? G : f === "media" ? "photo" : f === "url" ? "https://a.test/" : "own" }), CATS)), f).toBe(`invalid_field:${f}`);
    }
  });
  it("a link carries a url and a source; ai needs a note; video and photo are the media", () => {
    expect(refusal(() => parseSavedCreate(link({ url: undefined }), CATS))).toBe("missing_field:url");
    expect(refusal(() => parseSavedCreate(link({ source: undefined }), CATS))).toBe("missing_field:source");
    expect(refusal(() => parseSavedCreate(link({ url: "ftp://x.test/f" }), CATS))).toBe("invalid_field:url");
    expect(refusal(() => parseSavedCreate(link({ url: "https://a.test/with space" }), CATS))).toBe("invalid_field:url");
    expect(refusal(() => parseSavedCreate(link({ url: `https://a.test/${"x".repeat(500)}` }), CATS))).toBe("invalid_field:url");
    expect(refusal(() => parseSavedCreate(link({ source: "friend" }), CATS))).toBe("invalid_field:source");
    expect(refusal(() => parseSavedCreate(link({ media: "audio" }), CATS))).toBe("invalid_field:media");
    expect(refusal(() => parseSavedCreate(link({ source: "ai" }), CATS))).toBe("missing_field:aiNote");
    expect(refusal(() => parseSavedCreate(link({ source: "ai", aiNote: "Made with an image model" }), CATS))).toBe("ok");
    expect(refusal(() => parseSavedCreate(link({ aiNote: "x".repeat(1001) }), CATS))).toBe("invalid_field:aiNote");
    expect(refusal(() => parseSavedCreate(link({ body: "text" }), CATS))).toBe("invalid_field:body");
    expect(refusal(() => parseSavedCreate(link({ assetGroupId: G }), CATS))).toBe("invalid_field:assetGroupId");
  });
  it("an asset carries its group; its source and note are the asset's own", () => {
    expect(refusal(() => parseSavedCreate(asset({ assetGroupId: undefined }), CATS))).toBe("missing_field:assetGroupId");
    expect(refusal(() => parseSavedCreate(asset({ assetGroupId: "nope" }), CATS))).toBe("invalid_field:assetGroupId");
    for (const [f, v] of [["source", "own"], ["aiNote", "n"], ["url", "https://a.test/"], ["body", "b"], ["media", "photo"]] as const) {
      expect(refusal(() => parseSavedCreate(asset({ [f]: v }), CATS)), f).toBe(`invalid_field:${f}`);
    }
  });
  it("names the missing and the invalid field, in order, and an unknown key", () => {
    expect(refusal(() => parseSavedCreate("nope", CATS))).toBe("missing_field:category");
    expect(refusal(() => parseSavedCreate({}, CATS))).toBe("missing_field:category");
    expect(refusal(() => parseSavedCreate({ category: "captions" }, CATS))).toBe("missing_field:holds");
    expect(refusal(() => parseSavedCreate({ category: "captions", holds: "text" }, CATS))).toBe("missing_field:title");
    expect(refusal(() => parseSavedCreate(text({ holds: "poem" }), CATS))).toBe("invalid_field:holds");
    expect(refusal(() => parseSavedCreate(text({ title: "" }), CATS))).toBe("invalid_field:title");
    expect(refusal(() => parseSavedCreate(text({ title: "x".repeat(121) }), CATS))).toBe("invalid_field:title");
    expect(refusal(() => parseSavedCreate(text({ id: "nope" }), CATS))).toBe("invalid_field:id");
    expect(refusal(() => parseSavedCreate(text({ pillar: "p".repeat(61) }), CATS))).toBe("invalid_field:pillar");
    expect(refusal(() => parseSavedCreate(text({ colour: "red" }), CATS))).toBe("invalid_field:colour");
    expect(parseSavedCreate(text({ id: I.toUpperCase() }), CATS).id).toBe(I);
  });
});

describe("the categories are the company's (SCP-Q41)", () => {
  const withSaved = (categories: RulesDoc["saved"]["categories"]): ReturnType<typeof savedCategories> =>
    savedCategories({ ...DEFAULT_RULES, saved: validateSection("saved", { categories }) });
  const seed = DEFAULT_RULES.saved.categories;

  it("the seeded six take their shapes: captions and templates a text; references a link or an asset; photos an asset or a link", () => {
    expect(refusal(() => parseSavedCreate(text({ category: "templates" }), CATS))).toBe("ok");
    expect(refusal(() => parseSavedCreate(link({ category: "photos" }), CATS))).toBe("ok");
    expect(refusal(() => parseSavedCreate(asset({ category: "references" }), CATS))).toBe("ok");
  });
  it("an unknown category, one that does not take the shape, and the read-only ones are 400 on `category`", () => {
    expect(refusal(() => parseSavedCreate(text({ category: "moodboards" }), CATS))).toBe("invalid_field:category");
    expect(refusal(() => parseSavedCreate(link({ category: "captions" }), CATS))).toBe("invalid_field:category");
    expect(refusal(() => parseSavedCreate(asset({ category: "templates" }), CATS))).toBe("invalid_field:category");
    // `posts` and `hashtags` are read from where they live: nothing is stored under them, whatever the shape.
    for (const holds of ["text", "link", "asset"] as const) {
      for (const category of ["posts", "hashtags"]) {
        const body = holds === "text" ? text({ category }) : holds === "link" ? link({ category }) : asset({ category });
        expect(refusal(() => parseSavedCreate(body, CATS)), `${holds} in ${category}`).toBe("invalid_field:category");
      }
    }
    expect(refusal(() => parseSavedCreate(text({ category: 7 }), CATS))).toBe("invalid_field:category");
  });
  it("a hidden category refuses new items; a category the company added takes what it says it holds", () => {
    const hidden = withSaved(seed.map((c) => (c.key === "captions" ? { ...c, enabled: false } : c)));
    expect(refusal(() => parseSavedCreate(text(), hidden))).toBe("invalid_field:category");
    const added = withSaved([...seed, { key: "campaign_ideas", label: "Campaign ideas", holds: ["text", "link"], enabled: true }]);
    expect(refusal(() => parseSavedCreate(text({ category: "campaign_ideas" }), added))).toBe("ok");
    expect(refusal(() => parseSavedCreate(link({ category: "campaign_ideas" }), added))).toBe("ok");
    expect(refusal(() => parseSavedCreate(asset({ category: "campaign_ideas" }), added))).toBe("invalid_field:category");
  });
  it("renaming or reordering changes no key, so the same body still passes", () => {
    const renamed = withSaved([...seed].reverse().map((c) => (c.key === "captions" ? { ...c, label: "Words" } : c)));
    expect(refusal(() => parseSavedCreate(text(), renamed))).toBe("ok");
    expect(renamed[renamed.length - 1].key).toBe("photos");
  });
});

describe("parseSavedPatch", () => {
  const shape = (holds: "asset" | "link" | "text", source: string | null = null, aiNote: string | null = null) => ({ holds, source, aiNote });
  it("changes the item's own fields", () => {
    expect(parseSavedPatch({ title: " New ", body: "Edited", pillar: null }, shape("text"), CATS)).toEqual({ title: "New", body: "Edited", pillar: null });
    expect(parseSavedPatch({ source: "own", aiNote: null, pillar: "Offers" }, shape("link", "client"), CATS)).toEqual({ source: "own", aiNote: null, pillar: "Offers" });
    expect(parseSavedPatch({ title: "Hero 2", pillar: "People" }, shape("asset"), CATS)).toEqual({ title: "Hero 2", pillar: "People" });
  });
  it("a field the shape does not carry is 400 on it", () => {
    expect(refusal(() => parseSavedPatch({ body: "x" }, shape("link", "own"), CATS))).toBe("invalid_field:body");
    expect(refusal(() => parseSavedPatch({ body: "x" }, shape("asset"), CATS))).toBe("invalid_field:body");
    expect(refusal(() => parseSavedPatch({ source: "own" }, shape("text"), CATS))).toBe("invalid_field:source");
    expect(refusal(() => parseSavedPatch({ aiNote: "n" }, shape("asset"), CATS))).toBe("invalid_field:aiNote");
    expect(refusal(() => parseSavedPatch({ url: "https://a.test/" }, shape("link", "own"), CATS))).toBe("invalid_field:url");
    expect(refusal(() => parseSavedPatch({ title: null }, shape("text"), CATS))).toBe("invalid_field:title");
    expect(refusal(() => parseSavedPatch({ body: null }, shape("text"), CATS))).toBe("invalid_field:body");
  });
  it("an empty change and a body that is not an object are missing", () => {
    expect(refusal(() => parseSavedPatch({}, shape("text"), CATS))).toBe("missing_field:title");
    expect(refusal(() => parseSavedPatch(null, shape("text"), CATS))).toBe("missing_field:title");
  });
  it("a link that ends as `ai` keeps a note: the new source needs one, and the note cannot be cleared", () => {
    expect(refusal(() => parseSavedPatch({ source: "ai" }, shape("link", "own"), CATS))).toBe("missing_field:aiNote");
    expect(refusal(() => parseSavedPatch({ source: "ai", aiNote: "Image model" }, shape("link", "own"), CATS))).toBe("ok");
    expect(refusal(() => parseSavedPatch({ aiNote: null }, shape("link", "ai", "Image model"), CATS))).toBe("missing_field:aiNote");
    expect(refusal(() => parseSavedPatch({ pillar: "Offers" }, shape("link", "ai", "Image model"), CATS))).toBe("ok");
    expect(refusal(() => parseSavedPatch({ source: "own", aiNote: null }, shape("link", "ai", "Image model"), CATS))).toBe("ok");
  });
  it("moving to another category needs one that takes the item's shape", () => {
    expect(parseSavedPatch({ category: "templates" }, shape("text"), CATS)).toEqual({ category: "templates" });
    expect(refusal(() => parseSavedPatch({ category: "references" }, shape("text"), CATS))).toBe("invalid_field:category");
    expect(refusal(() => parseSavedPatch({ category: "posts" }, shape("link", "own"), CATS))).toBe("invalid_field:category");
    expect(refusal(() => parseSavedPatch({ category: "elsewhere" }, shape("text"), CATS))).toBe("invalid_field:category");
  });
});

describe("parseSavedListQuery", () => {
  it("answers the collections with no `collection`, the defaults and the filters", () => {
    expect(parseSavedListQuery({}, CATS)).toEqual({ collection: null, pillar: null, used: null, source: null, cursor: null, limit: 30 });
    expect(parseSavedListQuery({ collection: "photos", pillar: "Offers", used: "false", source: "ai", limit: "100" }, CATS))
      .toMatchObject({ collection: "photos", pillar: "Offers", used: false, source: "ai", limit: 100 });
    expect(parseSavedListQuery({ collection: "other" }, CATS).collection).toBe("other");
  });
  it("refuses an unknown or hidden collection and a bad value, naming the field", () => {
    const hidden = savedCategories({ ...DEFAULT_RULES, saved: validateSection("saved", { categories: DEFAULT_RULES.saved.categories.map((c) => (c.key === "templates" ? { ...c, enabled: false } : c)) }) });
    expect(refusal(() => parseSavedListQuery({ collection: "templates" }, hidden))).toBe("invalid_field:collection");
    expect(refusal(() => parseSavedListQuery({ collection: "nope" }, CATS))).toBe("invalid_field:collection");
    expect(refusal(() => parseSavedListQuery({ used: "yes" }, CATS))).toBe("invalid_field:used");
    expect(refusal(() => parseSavedListQuery({ source: "friend" }, CATS))).toBe("invalid_field:source");
    expect(refusal(() => parseSavedListQuery({ limit: "0" }, CATS))).toBe("invalid_field:limit");
    expect(refusal(() => parseSavedListQuery({ limit: "101" }, CATS))).toBe("invalid_field:limit");
    expect(refusal(() => parseSavedListQuery({ limit: "ten" }, CATS))).toBe("invalid_field:limit");
    expect(refusal(() => parseSavedListQuery({ pillar: "p".repeat(61) }, CATS))).toBe("invalid_field:pillar");
  });
});

describe("the cursor", () => {
  it("round-trips and refuses anything it did not make", () => {
    const k = { at: "2027-04-01T10:00:00.123456Z", key: "asset:abc" };
    expect(decodeSavedCursor(encodeSavedCursor(k))).toEqual(k);
    expect(refusal(() => decodeSavedCursor("garbage"))).toBe("invalid_field:cursor");
    expect(refusal(() => decodeSavedCursor(Buffer.from("2027-04-01|x", "utf8").toString("base64url")))).toBe("invalid_field:cursor");
    expect(refusal(() => decodeSavedCursor(Buffer.from("2027-04-01T10:00:00.123456Z|", "utf8").toString("base64url")))).toBe("invalid_field:cursor");
  });
});

describe("parseSavedItemIds (savedItemIds on the post edit)", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  it("takes 1 to 10 distinct uuids, lower-cased", () => {
    expect(parseSavedItemIds([I.toUpperCase()])).toEqual([I]);
    expect(parseSavedItemIds(ids(10))).toHaveLength(10);
  });
  it("is 400 on `savedItemIds` for none, eleven, a duplicate, a non-uuid or not a list", () => {
    for (const bad of [[], ids(11), [I, I], ["nope"], [7], I, null, {}]) expect(refusal(() => parseSavedItemIds(bad)), JSON.stringify(bad)).toBe("invalid_field:savedItemIds");
  });
});

describe("the agent tools (BFF §63.15, §63.26)", () => {
  const tool = (name: string) => socialModule.mcpTools.find((t) => t.name === name);
  it("social.savedItems reads the two GETs; social.saveItem writes the POST at impact low (team material, removed in one step)", () => {
    expect(tool("social.savedItems")).toMatchObject({ method: "GET", pathTemplate: "/api/:tenantId/modules/social/engagements/:engagementId/saved" });
    expect(tool("social.savedItems")?.write).toBeFalsy();
    expect(tool("social.saveItem")).toMatchObject({ method: "POST", write: true, impact: "low", pathTemplate: "/api/:tenantId/modules/social/engagements/:engagementId/saved" });
  });
  it("the tools name exactly the fields the routes take", () => {
    const props = (n: string) => Object.keys((tool(n)?.inputSchema as { properties: Record<string, unknown> }).properties).sort();
    expect(props("social.saveItem")).toEqual(["aiNote", "assetGroupId", "body", "category", "engagementId", "holds", "id", "media", "pillar", "source", "tenantId", "title", "url"]);
    expect(props("social.savedItems")).toEqual(["collection", "cursor", "engagementId", "limit", "pillar", "source", "tenantId", "used"]);
  });
});
