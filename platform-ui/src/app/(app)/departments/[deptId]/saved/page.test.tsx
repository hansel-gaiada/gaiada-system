import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

// SCP-5e (BFF §63.26, §63.17): the Saved page. A server page: the readers are mocked, the element tree is rendered. The client picker (the caller's clients first), the collections as mosaics, one
// collection's entries with the filters as links and the page link; a refused read is "no access" and a failed one is "cannot tell", never an empty bank; the page belongs to the Social Media workspace only.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => { throw new Error(`redirect:${to}`); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async (orig) => ({
  ...(await orig<typeof import("@/lib/platform")>()),
  getMe: vi.fn(async () => ({ userId: "u-1", roles: [], companies: [{ id: "co-a", vertical: "agency" }] })),
}));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/companyContext", () => ({ activeCompany: vi.fn(() => ({ id: "co-a", vertical: "agency" })) }));
vi.mock("@/lib/departments", () => ({ getDepartmentNode: vi.fn() }));
vi.mock("@/lib/socialAllocation-data", () => ({ getAllocation: vi.fn() }));
vi.mock("@/lib/socialClient-data", () => ({ getClientBrandBook: vi.fn() }));
vi.mock("@/lib/socialPipeline-data", () => ({ readAssetChoices: vi.fn() }));
vi.mock("@/lib/socialSaved-data", () => ({ getSavedCollections: vi.fn(), getSavedItems: vi.fn() }));
vi.mock("@/lib/socialSavedActions", () => ({ addSavedItem: vi.fn(), updateSavedItem: vi.fn(), deleteSavedItem: vi.fn() }));

import { getSessionUserId } from "@/lib/session-server";
import { getDepartmentNode } from "@/lib/departments";
import { getAllocation } from "@/lib/socialAllocation-data";
import { getClientBrandBook } from "@/lib/socialClient-data";
import { readAssetChoices } from "@/lib/socialPipeline-data";
import { getSavedCollections, getSavedItems } from "@/lib/socialSaved-data";
import { asCollections, asSavedPage } from "@/lib/socialSaved";
import SavedPage from "./page";

const alloc = (id: string, name: string) => ({ engagementId: id, clientId: `c-${id}`, clientName: name, status: "active" });
const COLLECTIONS = {
  collections: [
    { key: "photos", label: "Photos and videos", holds: ["asset", "link"], derived: true, count: 4, previews: ["v1", "v2"] },
    { key: "posts", label: "Approved posts", holds: [], derived: true, count: 2, previews: ["f1"] },
    { key: "captions", label: "Captions", holds: ["text"], derived: false, count: 3, previews: ["Opener", "Closer"] },
    { key: "hashtags", label: "Hashtag sets", holds: [], derived: true, count: 1, previews: ["Always"] },
    { key: "templates", label: "Templates", holds: ["text"], derived: false, count: 0, previews: [] },
  ],
  canAdd: true,
};
const okCols = (o: Record<string, unknown> = {}) => ({ kind: "ok" as const, data: asCollections({ ...COLLECTIONS, ...o }) });
const okPage = (collection: string, items: unknown[], nextCursor: string | null = null) => ({ kind: "ok" as const, data: asSavedPage({ items, nextCursor }, collection) });
const caption = (o: Record<string, unknown> = {}) => ({ id: "i1", category: "captions", holds: "text", title: "Harvest week opener", body: "The harvest is in.", pillar: "Product stories", useCount: 1, used: true, addedBy: { id: "u-copy", name: "Citra" }, addedAt: "2026-10-10T00:00:00Z", ...o });
const mount = async (search: Record<string, string> = {}, deptId = "d-soc") =>
  render(await SavedPage({ params: Promise.resolve({ deptId }), searchParams: Promise.resolve(search) }));

beforeEach(() => {
  vi.mocked(getSessionUserId).mockReset().mockResolvedValue("u-1");
  vi.mocked(getDepartmentNode).mockReset().mockResolvedValue({ id: "d-soc", name: "Social Media" } as never);
  vi.mocked(getAllocation).mockReset().mockImplementation(async (_u, _t, o) => ({
    kind: "ok", data: (o?.mine ? [alloc("e2", "Saltmarsh Day Spa")] : [alloc("e1", "Northwind Traders"), alloc("e2", "Saltmarsh Day Spa"), { ...alloc("e3", "Closed Co"), status: "closed" }]) as never,
  }));
  vi.mocked(getSavedCollections).mockReset().mockResolvedValue(okCols());
  vi.mocked(getSavedItems).mockReset().mockResolvedValue(okPage("captions", [caption()]));
  vi.mocked(getClientBrandBook).mockReset().mockResolvedValue({ kind: "ok", data: { contentPillars: ["Behind the scenes", "Product stories"] } } as never);
  vi.mocked(readAssetChoices).mockReset().mockResolvedValue({ kind: "ok", data: [{ groupId: "g1", versionId: "v1", versionNo: 2, name: "Autumn hero" }] });
});

describe("what is asked of the platform", () => {
  it("reads the clients, then the chosen client's collections and brand book, for the signed-in person in the active company", async () => {
    await mount({ client: "e1" });
    expect(getAllocation).toHaveBeenCalledWith("u-1", "co-a");
    expect(getAllocation).toHaveBeenCalledWith("u-1", "co-a", { mine: true });
    expect(getSavedCollections).toHaveBeenCalledWith("u-1", "co-a", "e1");
    expect(getClientBrandBook).toHaveBeenCalledWith("u-1", "co-a", "c-e1");
    expect(getSavedItems).not.toHaveBeenCalled(); // no collection is open: the mosaic is the page
  });
  it("opens a collection with the filters and the page cursor from the query, and ignores a filter that is not one", async () => {
    await mount({ client: "e1", collection: "captions", pillar: "Product stories", used: "true", source: "own", cursor: "c1" });
    expect(getSavedItems).toHaveBeenCalledWith("u-1", "co-a", "e1", { collection: "captions", pillar: "Product stories", used: true, source: "own", cursor: "c1" });
    await mount({ client: "e1", collection: "captions", used: "maybe", source: "web" });
    expect(getSavedItems).toHaveBeenLastCalledWith("u-1", "co-a", "e1", { collection: "captions", pillar: null, used: null, source: null, cursor: null });
  });
  it("starts on the caller's own client when none is asked for, and on the first client when a link names one that is not on the list", async () => {
    await mount();
    expect(getSavedCollections).toHaveBeenLastCalledWith("u-1", "co-a", "e2");
    await mount({ client: "gone" });
    expect(getSavedCollections).toHaveBeenLastCalledWith("u-1", "co-a", "e2");
    expect(screen.getByText("That client is not on the list, so the first one is shown.")).toBeInTheDocument();
  });
  it("sends a signed-out person to sign in, and is not found for another department, without reading anything", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as never);
    await expect(mount()).rejects.toThrow("redirect:/login");
    vi.mocked(getSessionUserId).mockResolvedValue("u-1");
    vi.mocked(getDepartmentNode).mockResolvedValue({ id: "d-web", name: "Web Dev" } as never);
    await expect(mount({}, "d-web")).rejects.toThrow("notFound");
    vi.mocked(getDepartmentNode).mockResolvedValue(null as never);
    await expect(mount({}, "nope")).rejects.toThrow("notFound");
    expect(getAllocation).not.toHaveBeenCalled();
  });
});

describe("the client picker and the collections", () => {
  it("lists the open clients, the caller's first and marked, the chosen one current, and never a closed client", async () => {
    await mount({ client: "e1" });
    const nav = screen.getByRole("navigation", { name: "Clients" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Saltmarsh Day Spa (yours)", "Northwind Traders"]);
    expect(links[1]).toHaveAttribute("aria-current", "true");
    expect(links[0]).toHaveAttribute("href", "/departments/d-soc/saved?client=e2");
    expect(within(nav).queryByText("Closed Co")).toBeNull();
  });
  it("draws the company's collections in order, each a link with its count in words, and says the bank is the team's", async () => {
    await mount({ client: "e1" });
    const tiles = within(screen.getByRole("list", { name: "Collections" })).getAllByRole("link");
    expect(tiles.map((t) => within(t).getByRole("heading").textContent)).toEqual(["Photos and videos", "Approved posts", "Captions", "Hashtag sets", "Templates"]);
    expect(tiles[2]).toHaveTextContent("3 items");
    expect(tiles[3]).toHaveTextContent("1 set");
    expect(tiles[4]).toHaveTextContent("Nothing here yet");
    expect(tiles[2]).toHaveAttribute("href", "/departments/d-soc/saved?client=e1&collection=captions");
    expect(screen.getByText(/Clients never see it\./)).toBeInTheDocument();
  });
});

describe("one collection", () => {
  it("draws the stored items with their source, use and who added them, the open tile marked, and the filters as links that keep the others", async () => {
    await mount({ client: "e1", collection: "captions", used: "true" });
    const card = screen.getByRole("article", { name: "Harvest week opener" });
    expect(card).toHaveTextContent("The harvest is in.");
    expect(card).toHaveTextContent("Used once");
    expect(card).toHaveTextContent("Added by Citra");
    expect(card).toHaveTextContent("Pillar: Product stories");
    expect(within(screen.getByRole("list", { name: "Collections" })).getByRole("link", { name: /Captions/ })).toHaveAttribute("aria-current", "true");
    const used = screen.getByRole("group", { name: "Used" });
    expect(within(used).getByRole("link", { name: "Not used yet" })).toHaveAttribute("href", "/departments/d-soc/saved?client=e1&collection=captions&used=false");
    expect(within(used).getByRole("link", { name: "Used" })).toHaveAttribute("aria-current", "true");
    const pillar = screen.getByRole("group", { name: "Pillar" });
    expect(within(pillar).getByRole("link", { name: "Product stories" })).toHaveAttribute("href", "/departments/d-soc/saved?client=e1&collection=captions&pillar=Product+stories&used=true");
  });
  it("pages with a link carrying the server's cursor, and says when it is on a later page", async () => {
    vi.mocked(getSavedItems).mockResolvedValue(okPage("captions", [caption()], "NEXT"));
    await mount({ client: "e1", collection: "captions" });
    expect(screen.getByRole("link", { name: "Next page" })).toHaveAttribute("href", "/departments/d-soc/saved?client=e1&collection=captions&cursor=NEXT");
    expect(screen.queryByRole("link", { name: "First page" })).toBeNull();
    await mount({ client: "e1", collection: "captions", cursor: "c1" });
    expect(screen.getAllByRole("link", { name: "First page" })[0]).toHaveAttribute("href", "/departments/d-soc/saved?client=e1&collection=captions");
  });
  it("photos: a design's photo is read-only and says so; a kept link opens in a new tab; a video is a link", async () => {
    vi.mocked(getSavedCollections).mockResolvedValue(okCols());
    vi.mocked(getSavedItems).mockResolvedValue(okPage("photos", [
      { key: "g:1", savedItemId: null, holds: "asset", title: "Autumn hero - final", used: true, usedIn: 2, source: "own", asset: { groupId: "g1", versionId: "v1", versionNo: 2, contentType: "image/png" }, addedAt: "2026-10-01T00:00:00Z" },
      { key: "s:2", savedItemId: "i2", holds: "link", title: "Workshop walkthrough", used: false, usedIn: 0, source: "own", media: "video", url: "https://drive.example.com/w", addedBy: { id: "u-1", name: "Komang" }, addedAt: "2026-10-02T00:00:00Z" },
    ]));
    await mount({ client: "e1", collection: "photos" });
    const design = screen.getByRole("article", { name: "Autumn hero - final" });
    expect(design).toHaveTextContent("Used in 2 posts");
    expect(design).toHaveTextContent("Photo from a design");
    expect(within(design).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(design.querySelector("img")).toHaveAttribute("src", "/api/creative-assets/v1");
    const video = screen.getByRole("article", { name: "Workshop walkthrough" });
    expect(video).toHaveTextContent("Video link");
    expect(video).toHaveTextContent("Not used yet");
    expect(within(video).getByRole("link", { name: "Open the link (new tab)" })).toHaveAttribute("target", "_blank");
    expect(within(video).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByText(/Videos are Drive links/)).toBeInTheDocument();
    expect(video).toHaveTextContent("Added by Komang (you) on 02 Oct 2026");
  });
  it("approved posts link to their post and show the SIMULATED mark only on a simulated one; hashtag sets point to the brand book", async () => {
    vi.mocked(getSavedItems).mockResolvedValueOnce(okPage("posts", [
      { postId: "p1", title: "Harvest teaser", format: "feed", cycleMonth: "2026-09", thumbFileId: "f1", pipelineStatus: "live", simulated: false },
      { postId: "p2", title: "Brunch is back", format: "carousel", cycleMonth: "2026-10", thumbFileId: null, pipelineStatus: "approved", simulated: true },
    ]));
    const a = await mount({ client: "e1", collection: "posts" });
    expect(screen.getByRole("link", { name: "Harvest teaser" })).toHaveAttribute("href", "/departments/d-soc/posts/p1");
    expect(screen.getAllByRole("img", { name: "Simulated" })).toHaveLength(1);
    expect(screen.getByRole("article", { name: "Brunch is back" })).toContainElement(screen.getByRole("img", { name: "Simulated" }));
    expect(screen.queryByRole("group", { name: "Used" })).toBeNull();
    a.unmount();
    vi.mocked(getSavedItems).mockResolvedValueOnce(okPage("hashtags", [{ key: "set-1", name: "Always", tags: ["northwind", "madewithcare"] }]));
    await mount({ client: "e1", collection: "hashtags" });
    expect(screen.getByText("#northwind")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Client profile" })).toHaveAttribute("href", expect.stringContaining("/departments/d-soc/profile/e1"));
    expect(screen.queryByRole("navigation", { name: "Filter this collection" })).toBeNull();
  });
});

describe("empty states, in words", () => {
  it("an empty collection says so and offers nothing it cannot, and a filter that matches nothing offers the whole collection", async () => {
    vi.mocked(getSavedItems).mockResolvedValue(okPage("templates", []));
    const a = await mount({ client: "e1", collection: "templates" });
    expect(screen.getByRole("status")).toHaveTextContent("Nothing in Templates yet.");
    a.unmount();
    vi.mocked(getSavedItems).mockResolvedValue(okPage("captions", []));
    await mount({ client: "e1", collection: "captions", pillar: "Product stories" });
    expect(screen.getByRole("status")).toHaveTextContent("Nothing in this collection matches the filter.");
    expect(screen.getByRole("link", { name: "Show everything in Captions" })).toHaveAttribute("href", "/departments/d-soc/saved?client=e1&collection=captions");
  });
  it("says so when the company has no collections on, when there are no clients, and when a collection is not the company's", async () => {
    vi.mocked(getSavedCollections).mockResolvedValue(okCols({ collections: [] }));
    const a = await mount({ client: "e1" });
    expect(screen.getByText(/no collections switched on/)).toBeInTheDocument();
    a.unmount();
    await mount({ client: "e1", collection: "retired" });
    expect(screen.getByText("That collection is not one of this company's, so none is open.")).toBeInTheDocument();
  });
  it("a company with no client says so, and reads nothing else", async () => {
    vi.mocked(getAllocation).mockResolvedValue({ kind: "ok", data: [] });
    await mount();
    expect(screen.getByText(/There is no client yet/)).toBeInTheDocument();
    expect(getSavedCollections).not.toHaveBeenCalled();
  });
});

describe("a refused read is no access and a failed one is cannot tell, never an empty bank", () => {
  it("the clients", async () => {
    vi.mocked(getAllocation).mockResolvedValue({ kind: "forbidden" });
    const a = await mount();
    expect(a.container.textContent).toMatch(/content bank/i);
    expect(screen.queryByRole("list", { name: "Collections" })).toBeNull();
    a.unmount();
    vi.mocked(getAllocation).mockResolvedValue({ kind: "unavailable", reason: "timeout" });
    await mount();
    expect(screen.getByText(/timeout/)).toBeInTheDocument();
  });
  it("the collections keep the picker and say what failed, with no 'Nothing here' claim", async () => {
    vi.mocked(getSavedCollections).mockResolvedValue({ kind: "unavailable", reason: "the module is off" });
    await mount({ client: "e1" });
    expect(screen.getByRole("navigation", { name: "Clients" })).toBeInTheDocument();
    expect(screen.getByText(/the module is off/)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Collections" })).toBeNull();
    expect(screen.queryByText(/Nothing here yet/)).toBeNull();
  });
  it("a collection's items", async () => {
    vi.mocked(getSavedItems).mockResolvedValue({ kind: "unavailable", reason: "cursor_invalid" });
    await mount({ client: "e1", collection: "captions" });
    expect(screen.getByText(/cursor_invalid/)).toBeInTheDocument();
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.queryByText(/Nothing in Captions yet/)).toBeNull();
  });
  it("a failed brand book says the pillar lists are empty; the bank is still drawn", async () => {
    vi.mocked(getClientBrandBook).mockResolvedValue({ kind: "unavailable", reason: "x" } as never);
    await mount({ client: "e1" });
    expect(screen.getByText(/pillar lists are empty/)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Collections" })).toBeInTheDocument();
  });
});

describe("adding", () => {
  it("draws the add form when the server says canAdd, with the Asset Library read for the photo way in", async () => {
    await mount({ client: "e1" });
    expect(screen.getByRole("form", { name: "Add to the content bank" })).toBeInTheDocument();
    expect(readAssetChoices).toHaveBeenCalledWith("u-1", "co-a");
  });
  it("says who may add, and draws no form, when the server says it cannot (and reads no assets)", async () => {
    vi.mocked(getSavedCollections).mockResolvedValue(okCols({ canAdd: false }));
    await mount({ client: "e1" });
    expect(screen.queryByRole("form", { name: "Add to the content bank" })).toBeNull();
    expect(screen.getByText(/Only the Social Media team adds to the content bank/)).toBeInTheDocument();
    expect(readAssetChoices).not.toHaveBeenCalled();
  });
});
