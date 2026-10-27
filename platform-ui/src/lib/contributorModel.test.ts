import { describe, it, expect } from "vitest";
import type { WdResult } from "./webdeskContentModel";
import type { BoardItem, EditorialBoard } from "./webdeskEditorialModel";
import { buildAssignmentsView, itemHref, type SiteBoardRead } from "./contributorModel";

// M5-W1f: "My assignments". An empty list stands for a 200 with no rows and nothing else; every refusal is its own state.
const ME = "u-me";
const item = (id: string, over: Partial<BoardItem["editorial"]> = {}, extra: Partial<BoardItem> = {}): BoardItem => ({
  itemId: id, collectionKey: "blog", locale: "en", slug: `post-${id}`, title: `Post ${id}`, headVersion: 2, publishState: "draft",
  editorial: { reviewRequired: true, state: "draft", approvedVersion: null, authorSub: null, ...over }, ...extra,
});
const board = (items: BoardItem[], hasMore = false): WdResult<EditorialBoard> => ({
  kind: "ok", data: { items, counts: null, countsWithheld: true, policies: [], page: { cursor: null, hasMore, limit: 100 } },
});
const read = (b: WdResult<EditorialBoard>, over: Partial<SiteBoardRead> = {}): SiteBoardRead => ({ tenantSlug: "gaiada", siteId: "s1", siteName: "gaiada.com", board: b, ...over });
const sites = (n = 1): WdResult<{ tenantSlug: string; siteId: string; siteName: string }[]> => ({ kind: "ok", data: Array.from({ length: n }, (_, i) => ({ tenantSlug: "gaiada", siteId: `s${i}`, siteName: `Site ${i}` })) });
const fenced: WdResult<never> = { kind: "forbidden", reason: "contributor_route_forbidden", slug: "assurance_high_required" };

describe("buildAssignmentsView", () => {
  it("lists what is assigned to the caller first, the rest beneath, each with the contributor editor's link", () => {
    const v = buildAssignmentsView(sites(), [read(board([item("a"), item("b", { authorSub: ME }), item("c", { authorSub: "someone-else" })]))], ME);
    if (v.kind !== "ok") throw new Error(v.kind);
    const s = v.sections[0];
    if (s.kind !== "items") throw new Error(s.kind);
    expect(s.mine.map((r) => r.itemId)).toEqual(["b"]);
    expect(s.others.map((r) => r.itemId).sort()).toEqual(["a", "c"]);
    expect(s.mine[0].href).toBe("/contributor/items/gaiada/s1/blog/post-b?locale=en");
    expect(itemHref("t", "s", "c d", "x/y", "en")).toBe("/contributor/items/t/s/c%20d/x%2Fy?locale=en");
  });

  it("works first: changes requested, then drafts, then in review, then approved", () => {
    const v = buildAssignmentsView(sites(), [read(board([
      item("ap", { state: "approved", authorSub: ME }), item("ir", { state: "in_review", authorSub: ME }),
      item("dr", { state: "draft", authorSub: ME }), item("cr", { state: "changes_requested", authorSub: ME }),
    ]))], ME);
    const s = (v as { sections: { mine: { itemId: string }[] }[] }).sections[0];
    expect(s.mine.map((r) => r.itemId)).toEqual(["cr", "dr", "ir", "ap"]);
  });

  it("an answered board with no rows is the only 'none': 'Nothing is assigned'", () => {
    const v = buildAssignmentsView(sites(), [read(board([]))], ME);
    expect(v).toMatchObject({ kind: "ok", sections: [{ kind: "none" }] });
  });

  it("a refused board is a refused section, never 'none'", () => {
    const v = buildAssignmentsView(sites(), [read({ kind: "forbidden", reason: "forbidden" })], ME);
    expect(v).toMatchObject({ kind: "ok", sections: [{ kind: "refused" }] });
  });

  it("an unreachable board is an unavailable section that says it is not a statement of no work", () => {
    const v = buildAssignmentsView(sites(), [read({ kind: "unavailable", code: "network", reason: "down" })], ME);
    const s = (v as { sections: { kind: string; message: string }[] }).sections[0];
    expect(s.kind).toBe("unavailable");
    expect(s.message).toMatch(/not a statement that you have no work/);
  });

  it("one broken site does not hide the others", () => {
    const v = buildAssignmentsView(sites(2), [read({ kind: "unavailable", code: "network", reason: "x" }, { siteId: "s0" }), read(board([item("a")]), { siteId: "s1" })], ME);
    expect((v as { sections: { kind: string }[] }).sections.map((s) => s.kind)).toEqual(["unavailable", "items"]);
  });

  it("flags a site with more rows than were read", () => {
    const v = buildAssignmentsView(sites(), [read(board([item("a")], true))], ME);
    expect((v as { sections: { more: boolean }[] }).sections[0].more).toBe(true);
  });
});

describe("the two-step notice (assurance_high_required)", () => {
  it("the sites read refused by the fence turns the whole screen into the notice", () => {
    expect(buildAssignmentsView(fenced, [], ME)).toEqual({ kind: "assurance", reason: "assurance_high_required" });
  });
  it("a board refused by the fence does too, even after a good site: no partial list stands in for it", () => {
    const v = buildAssignmentsView(sites(2), [read(board([item("a")]), { siteId: "s0" }), read(fenced, { siteId: "s1" })], ME);
    expect(v).toEqual({ kind: "assurance", reason: "assurance_high_required" });
  });
  it("an ordinary refusal of the sites read is a refusal in words, not the notice and not an empty list", () => {
    const v = buildAssignmentsView({ kind: "forbidden", reason: "forbidden" }, [], ME);
    expect(v.kind).toBe("refused");
  });
  it("no sites at all is its own state", () => {
    expect(buildAssignmentsView(sites(0), [], ME)).toEqual({ kind: "no_sites" });
  });
});
