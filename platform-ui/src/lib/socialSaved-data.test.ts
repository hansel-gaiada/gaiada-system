import { describe, it, expect, vi, beforeEach } from "vitest";

// SCP-5e (BFF §63.26): the content bank's two readers. Every answer is a `ReadResult`: a failed or malformed read is "cannot tell" and a 403 is "forbidden", never an empty bank.
vi.mock("./platform", async (orig) => ({ ...(await orig<typeof import("./platform")>()), platformFetch: vi.fn() }));

import { platformFetch, PlatformError } from "./platform";
import { getSavedCollections, getSavedItems } from "./socialSaved-data";

beforeEach(() => { vi.mocked(platformFetch).mockReset(); });
const view = { collection: "captions", pillar: null, used: null, source: null, cursor: null };

describe("getSavedCollections", () => {
  it("asks the company's own route for the client and parses the collections with canAdd", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ collections: [{ key: "captions", label: "Captions", holds: ["text"], derived: false, count: 2, previews: ["A", "B"] }], canAdd: true });
    const r = await getSavedCollections("u-1", "co a", "e 1");
    expect(platformFetch).toHaveBeenCalledWith("/api/co%20a/modules/social/engagements/e%201/saved", "u-1");
    expect(r).toMatchObject({ kind: "ok", data: { canAdd: true, collections: [{ key: "captions", count: 2 }] } });
  });
  it("is forbidden on a 403 and cannot-tell on any other failure or a body that is not a list", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "not authorized: cerbos denied read on social_post"));
    expect((await getSavedCollections("u-1", "co-a", "e1")).kind).toBe("forbidden");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "engagement_not_found"));
    expect(await getSavedCollections("u-1", "co-a", "e1")).toEqual({ kind: "unavailable", reason: "engagement_not_found" });
    vi.mocked(platformFetch).mockResolvedValueOnce({ unexpected: true });
    expect((await getSavedCollections("u-1", "co-a", "e1")).kind).toBe("unavailable");
  });
});

describe("getSavedItems", () => {
  it("sends the collection and the filters and the page cursor, and parses by the collection's shape", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ items: [{ id: "i1", category: "captions", holds: "text", title: "T", body: "B" }], nextCursor: "next" });
    const r = await getSavedItems("u-1", "co-a", "e1", { ...view, pillar: "Rituals", used: false, source: "own", cursor: "c1" });
    expect(platformFetch).toHaveBeenCalledWith("/api/co-a/modules/social/engagements/e1/saved?collection=captions&pillar=Rituals&used=false&source=own&cursor=c1", "u-1");
    expect(r).toMatchObject({ kind: "ok", data: { collection: "captions", nextCursor: "next", entries: { kind: "items", items: [{ id: "i1" }] } } });
  });
  it("reads the photos as photos and the hashtag sets as sets", async () => {
    vi.mocked(platformFetch).mockResolvedValueOnce({ items: [{ key: "g:1", holds: "asset", title: "Hero", savedItemId: null }], nextCursor: null });
    expect(await getSavedItems("u-1", "co-a", "e1", { ...view, collection: "photos" })).toMatchObject({ kind: "ok", data: { entries: { kind: "photos" } } });
    vi.mocked(platformFetch).mockResolvedValueOnce({ items: [{ key: "set-1", name: "Always", tags: ["a"] }], nextCursor: null });
    expect(await getSavedItems("u-1", "co-a", "e1", { ...view, collection: "hashtags" })).toMatchObject({ kind: "ok", data: { entries: { kind: "hashtags" } } });
  });
  it("is forbidden on a 403, and cannot-tell on a failure or an item of the wrong shape", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "no"));
    expect((await getSavedItems("u-1", "co-a", "e1", view)).kind).toBe("forbidden");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "invalid_field"));
    expect(await getSavedItems("u-1", "co-a", "e1", view)).toEqual({ kind: "unavailable", reason: "invalid_field" });
    vi.mocked(platformFetch).mockResolvedValueOnce({ items: [{ nope: true }] });
    expect((await getSavedItems("u-1", "co-a", "e1", view)).kind).toBe("unavailable");
  });
});
