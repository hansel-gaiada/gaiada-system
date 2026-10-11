import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { WdResult } from "@/lib/webdeskContentModel";
import type { MediaAsset, MediaListBody, MediaUsage, UploadToken } from "@/lib/webdeskMediaModel";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/webdeskMediaActions", () => ({
  listMediaAction: vi.fn(), mediaUsageAction: vi.fn(), mintUploadTokenAction: vi.fn(), updateMediaAction: vi.fn(), deleteMediaAction: vi.fn(),
}));
vi.mock("@/lib/mediaUpload", () => ({ uploadFile: vi.fn() }));

import * as A from "@/lib/webdeskMediaActions";
import { uploadFile, type UploadOutcome } from "@/lib/mediaUpload";
import { MediaLibrary, type MediaLibraryProps } from "./MediaLibrary";

const a = vi.mocked(A);
const up = vi.mocked(uploadFile);
const SCOPE = { tenantSlug: "gaiada", siteId: "s1" };
const ROUTE = "/departments/d1/website/content/gaiada/s1";
const ok = <T,>(data: T): WdResult<T> => ({ kind: "ok", data });

const asset = (n: number, over: Partial<MediaAsset> = {}): MediaAsset => ({
  assetId: `a${n}`, url: `/v1/t/gaiada/media/a${n}`, mime: "image/png", sizeBytes: 2048 * n, scanStatus: "clean", title: `Image ${n}`, alt: { en: `Alt ${n}` }, tags: ["hero"],
  originalFilename: `image-${n}.png`, width: 1200, height: 800, createdBy: "u1", createdAt: "2026-10-11T08:00:00.000Z", updatedAt: "2026-10-11T08:00:00.000Z", deletedAt: null, ...over,
});
const list = (assets: MediaAsset[], page: Partial<MediaListBody["page"]> = {}): MediaListBody => ({ assets, page: { cursor: null, hasMore: false, limit: 48, ...page } });
const noUse: MediaUsage = { assetId: "a1", url: "/v1/t/gaiada/media/a1", total: 0, items: [] };
const token = (over: Partial<UploadToken> = {}): UploadToken => ({ uploadUrl: "https://webdesk.example/v1/t/gaiada/media/upload/TOKEN-1", expiresAt: "2026-10-11T08:10:00Z", maxBytes: 1024 * 1024, allowedMimes: ["image/png", "image/jpeg", "application/pdf"], ...over });
const unavailable = (reason = "circuit_open"): WdResult<never> => ({ kind: "unavailable", code: "editorial_unavailable", reason });
const png = (name = "new.png", type = "image/png", size = 64) => new File([new Uint8Array(size)], name, { type });

function mount(over: Partial<MediaLibraryProps> = {}) {
  return render(
    <MediaLibrary
      mode="manage" scope={SCOPE} routeBase={ROUTE} locales={["en", "id"]} authors={{ u1: "Dewi" }} publicBase="https://webdesk.example"
      initial={{ list: list([asset(1), asset(2), asset(3)]), loadedAt: "2026-10-11T08:30:00.000Z" }} {...over}
    />,
  );
}
const tiles = () => screen.queryAllByTestId("media-tile");
const open = (n: number) => fireEvent.click(screen.getAllByTestId("media-tile").find((t) => t.getAttribute("data-asset-id") === `a${n}`)!);
const flush = () => act(async () => { await Promise.resolve(); });

beforeEach(() => {
  Object.values(a).forEach((f) => (f as ReturnType<typeof vi.fn>).mockReset());
  up.mockReset();
  a.mediaUsageAction.mockResolvedValue(ok(noUse));
  a.listMediaAction.mockResolvedValue(ok(list([])));
});

describe("list states", () => {
  it("ok: a grid whose tiles are named (name, type, size), with thumbnails from the public base", () => {
    mount();
    expect(tiles()).toHaveLength(3);
    expect(tiles()[0].getAttribute("aria-label")).toBe("Image 1, PNG image, 1200 × 800");
    expect(tiles()[0].querySelector("img")?.getAttribute("src")).toBe("https://webdesk.example/v1/t/gaiada/media/a1");
    expect(screen.getByRole("listbox", { name: "Media" })).toBeTruthy();
    expect(screen.queryByTestId("media-empty")).toBeNull();
  });

  it("without a preview base the tiles say so (no broken image) and the page explains why", () => {
    mount({ publicBase: null });
    expect(tiles()[0].querySelector("img")).toBeNull();
    expect(screen.getAllByTestId("media-tile-fallback")[0].textContent).toBe("No preview");
    expect(screen.getByTestId("media-no-previews").textContent).toContain("WEBDESK_PUBLIC_BASE_URL");
  });

  it("an image that fails to load falls back to a tile", () => {
    mount();
    fireEvent.error(tiles()[0].querySelector("img")!);
    expect(tiles()[0].querySelector("img")).toBeNull();
    expect(within(tiles()[0]).getByTestId("media-tile-fallback").textContent).toBe("Preview unavailable");
  });

  it("empty (an ok read of nothing) says the library is empty, and a filtered empty says nothing matches", async () => {
    mount({ initial: { list: list([]), loadedAt: "t" } });
    expect(screen.getByTestId("media-empty").textContent).toContain("library is empty");
    a.listMediaAction.mockResolvedValue(ok(list([])));
    fireEvent.change(screen.getByTestId("media-q"), { target: { value: "zzz" } });
    fireEvent.submit(screen.getByRole("search", { name: "Filter media" }));
    await waitFor(() => expect(screen.getByTestId("media-empty").textContent).toContain("No media matches these filters."));
  });

  it("unavailable on first load: a notice and NO grid and no empty claim; Try again recovers", async () => {
    a.listMediaAction.mockResolvedValueOnce(unavailable());
    mount({ initial: null });
    const n = await screen.findByTestId("media-unavailable");
    expect(n.textContent).toContain("The media library is unavailable");
    expect(n.textContent).toContain("Nothing has been lost");
    expect(screen.queryByTestId("media-grid")).toBeNull();
    expect(screen.queryByTestId("media-empty")).toBeNull();
    a.listMediaAction.mockResolvedValueOnce(ok(list([asset(1)])));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(tiles()).toHaveLength(1));
  });

  it("forbidden and contract drift are their own notices, never an empty library", async () => {
    a.listMediaAction.mockResolvedValueOnce({ kind: "forbidden", reason: "no" });
    const { unmount } = mount({ initial: null });
    expect((await screen.findByTestId("media-forbidden")).textContent).toContain("don't have access");
    unmount();
    a.listMediaAction.mockResolvedValueOnce({ kind: "unavailable", code: "contract_drift", reason: "media.assets: expected array, got object" });
    mount({ initial: null });
    expect((await screen.findByTestId("media-drift")).textContent).toContain("does not mean the library is empty");
    expect(screen.queryByTestId("media-empty")).toBeNull();
  });

  it("stale: a refresh that fails AFTER a good load keeps the grid, says when it loaded, and Try again re-asks", async () => {
    mount();
    a.listMediaAction.mockResolvedValueOnce(unavailable("webdesk_unreachable"));
    fireEvent.change(screen.getByTestId("media-q"), { target: { value: "x" } });
    fireEvent.submit(screen.getByRole("search", { name: "Filter media" }));
    const banner = await screen.findByTestId("media-stale");
    expect(banner.textContent).toContain("Couldn't update the list");
    expect(banner.textContent).toContain("webdesk_unreachable");
    expect(tiles()).toHaveLength(3); // not thrown away
    a.listMediaAction.mockResolvedValueOnce(ok(list([asset(9)])));
    fireEvent.click(screen.getByTestId("media-stale-retry"));
    await waitFor(() => expect(tiles()).toHaveLength(1));
    expect(screen.queryByTestId("media-stale")).toBeNull();
  });

  it("cursor paging: Load more asks with the cursor and appends (no duplicates)", async () => {
    mount({ initial: { list: list([asset(1), asset(2)], { hasMore: true, cursor: "CUR1" }), loadedAt: "t" } });
    a.listMediaAction.mockResolvedValueOnce(ok(list([asset(2), asset(3)], { hasMore: false })));
    fireEvent.click(screen.getByTestId("media-more"));
    await waitFor(() => expect(tiles()).toHaveLength(3));
    expect(a.listMediaAction).toHaveBeenCalledWith(SCOPE, expect.objectContaining({ cursor: "CUR1" }));
    expect(screen.queryByTestId("media-more")).toBeNull();
  });

  it("filters: search, tag and type are sent together, and Clear resets them", async () => {
    mount();
    a.listMediaAction.mockResolvedValue(ok(list([asset(1)])));
    fireEvent.change(screen.getByTestId("media-q"), { target: { value: " hero " } });
    fireEvent.change(screen.getByTestId("media-tag"), { target: { value: "Banner" } });
    fireEvent.change(screen.getByTestId("media-type"), { target: { value: "image/*" } });
    fireEvent.submit(screen.getByRole("search", { name: "Filter media" }));
    await waitFor(() => expect(a.listMediaAction).toHaveBeenCalled());
    expect(a.listMediaAction).toHaveBeenLastCalledWith(SCOPE, { mime: "image/*", q: "hero", tag: "banner", cursor: undefined, limit: 48 });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(a.listMediaAction).toHaveBeenCalledTimes(2));
    expect(a.listMediaAction).toHaveBeenLastCalledWith(SCOPE, { mime: undefined, q: undefined, tag: undefined, cursor: undefined, limit: 48 });
  });
});

describe("the detail panel", () => {
  it("shows who uploaded it and when, the canonical URL (with Copy), the file facts", () => {
    mount();
    open(1);
    expect(screen.getByTestId("media-uploader").textContent).toBe("Dewi");
    expect((screen.getByTestId("media-url") as HTMLInputElement).value).toBe("/v1/t/gaiada/media/a1");
    expect(screen.getByTestId("media-detail").textContent).toContain("image-1.png");
    expect(screen.getByTestId("media-detail").textContent).toContain("1200 × 800");
  });

  it("copy writes the canonical URL to the clipboard and says so politely", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mount(); open(1);
    await act(async () => { fireEvent.click(screen.getByTestId("media-copy")); });
    expect(writeText).toHaveBeenCalledWith("/v1/t/gaiada/media/a1");
    expect(screen.getByTestId("media-notice").textContent).toBe("Copied the URL.");
  });

  it("Where it's used: each item links to its editor; more than listed says so; a failed check is NOT 'unused'", async () => {
    a.mediaUsageAction.mockResolvedValueOnce(ok({ ...noUse, total: 3, items: [{ itemId: "i1", collectionKey: "service", locale: "en", slug: "service.seo", in: "live" }, { itemId: "i2", collectionKey: "service", locale: "id", slug: "service.seo", in: "head" }] }));
    mount(); open(1);
    const list_ = await screen.findByTestId("media-usage-list");
    const links = within(list_).getAllByRole("link");
    expect(links[0].getAttribute("href")).toBe(`${ROUTE}/service/service.seo?locale=en`);
    expect(links[1].getAttribute("href")).toBe(`${ROUTE}/service/service.seo?locale=id`);
    expect(list_.textContent).toContain("Live"); expect(list_.textContent).toContain("Draft");
    expect(screen.getByTestId("media-usage").textContent).toContain("and 1 more not listed");

    a.mediaUsageAction.mockResolvedValueOnce(unavailable());
    open(2);
    const err = await screen.findByTestId("media-usage-error");
    expect(err.textContent).toContain("not the same as");
    expect(screen.queryByTestId("media-usage-none")).toBeNull();

    a.mediaUsageAction.mockResolvedValueOnce(ok(noUse));
    open(3);
    expect((await screen.findByTestId("media-usage-none")).textContent).toBe("Not used by any item.");
  });

  it("edit title, per-locale alt and tags: PATCH carries only what changed, alt as the COMPLETE map, tags normalised, with an Idempotency-Key", async () => {
    mount(); open(1);
    a.updateMediaAction.mockResolvedValue(ok({ asset: asset(1, { title: "New title", alt: { en: "Alt 1", id: "Teks alt" }, tags: ["hero", "big image"] }) }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: " New title " } });
    fireEvent.change(screen.getByTestId("media-alt-id"), { target: { value: "Teks alt" } });
    fireEvent.change(screen.getByLabelText("Tags"), { target: { value: "Hero, Big  Image" } });
    expect(screen.getByTestId("media-dirty").textContent).toBe("Unsaved changes");
    await act(async () => { fireEvent.click(screen.getByTestId("media-save")); });
    expect(a.updateMediaAction).toHaveBeenCalledTimes(1);
    const [scope, id, patch, key] = a.updateMediaAction.mock.calls[0];
    expect(scope).toEqual(SCOPE); expect(id).toBe("a1");
    expect(patch).toEqual({ title: "New title", alt: { en: "Alt 1", id: "Teks alt" }, tags: ["hero", "big image"] });
    expect(typeof key).toBe("string"); expect(String(key).length).toBeGreaterThanOrEqual(8);
    expect(screen.getByTestId("media-notice").textContent).toBe("Saved New title.");
    // the grid shows the saved title and the form is clean again
    expect(tiles()[0].getAttribute("aria-label")).toBe("New title, PNG image, 1200 × 800");
    expect(screen.queryByTestId("media-dirty")).toBeNull();
    expect((screen.getByTestId("media-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("only the changed key is sent, and clearing an alt removes its locale from the map", async () => {
    mount(); open(1);
    a.updateMediaAction.mockResolvedValue(ok({ asset: asset(1, { alt: {} }) }));
    fireEvent.change(screen.getByTestId("media-alt-en"), { target: { value: "" } });
    await act(async () => { fireEvent.click(screen.getByTestId("media-save")); });
    expect(a.updateMediaAction.mock.calls[0][2]).toEqual({ alt: {} });
  });

  it("a 422 shows WebDesk's own words and keeps the edit", async () => {
    mount(); open(1);
    a.updateMediaAction.mockResolvedValue({ kind: "invalid", issues: [], message: "alt: 'fr' is not a locale this tenant declares" });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "x" } });
    await act(async () => { fireEvent.click(screen.getByTestId("media-save")); });
    expect(screen.getByTestId("media-save-problem").textContent).toContain("not a locale this tenant declares");
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("x");
  });

  it("read-only: a 403 on save turns the panel read-only with the reason, keeps the edit, and disables Save", async () => {
    mount(); open(1);
    a.updateMediaAction.mockResolvedValue({ kind: "forbidden", reason: "no" });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "x" } });
    await act(async () => { fireEvent.click(screen.getByTestId("media-save")); });
    expect(screen.getByTestId("media-save-problem").textContent).toContain("Your edits are still here");
    expect(screen.getByTestId("media-readonly").textContent).toContain("You can browse the library but not edit assets");
    expect((screen.getByLabelText("Title") as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByTestId("media-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("read-only from the start (a capability known to be off): upload, edit and delete are each disabled with their reason; browsing still works", () => {
    mount({ denied: { upload: "Uploads are off for you.", update: "Editing is off for you.", delete: "Deleting needs a publisher." } });
    expect((screen.getByTestId("media-upload") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("media-upload-why").textContent).toBe("Uploads are off for you.");
    expect(tiles()).toHaveLength(3);
    open(1);
    expect(screen.getByTestId("media-readonly").textContent).toContain("Editing is off for you.");
    expect((screen.getByTestId("media-delete") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("media-delete-why").textContent).toBe("Deleting needs a publisher.");
    expect(screen.getByRole("button", { name: "Upload files" }).getAttribute("aria-describedby")).toBe(screen.getByTestId("media-upload-why").id);
  });

  it("an unconfirmed save (502 ambiguous) says so, keeps the edit, and Retry re-sends with the SAME Idempotency-Key", async () => {
    mount(); open(1);
    a.updateMediaAction.mockResolvedValueOnce({ kind: "unavailable", code: "upstream_error", reason: "not_observed" });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "x" } });
    await act(async () => { fireEvent.click(screen.getByTestId("media-save")); });
    expect(screen.getByTestId("media-save-problem").textContent).toContain("couldn't confirm the save");
    a.updateMediaAction.mockResolvedValueOnce(ok({ asset: asset(1, { title: "x" }) }));
    await act(async () => { fireEvent.click(screen.getByTestId("media-save-retry")); });
    expect(a.updateMediaAction).toHaveBeenCalledTimes(2);
    expect(a.updateMediaAction.mock.calls[1][3]).toBe(a.updateMediaAction.mock.calls[0][3]);
    expect(a.updateMediaAction.mock.calls[1][2]).toEqual(a.updateMediaAction.mock.calls[0][2]);
  });

  it("changing the edit after an unconfirmed save is a NEW change: new key", async () => {
    mount(); open(1);
    a.updateMediaAction.mockResolvedValueOnce({ kind: "unavailable", code: "upstream_error", reason: "not_observed" });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "x" } });
    await act(async () => { fireEvent.click(screen.getByTestId("media-save")); });
    a.updateMediaAction.mockResolvedValueOnce(ok({ asset: asset(1, { title: "y" }) }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "y" } });
    await act(async () => { fireEvent.click(screen.getByTestId("media-save")); });
    expect(a.updateMediaAction.mock.calls[1][3]).not.toBe(a.updateMediaAction.mock.calls[0][3]);
  });
});

describe("delete", () => {
  it("asks first; confirming deletes with an Idempotency-Key, removes the tile, and says when WebDesk purges the file", async () => {
    mount(); open(2);
    fireEvent.click(screen.getByTestId("media-delete"));
    const dlg = screen.getByTestId("media-delete-dialog");
    expect(within(dlg).getByRole("heading", { name: "Delete this file?" })).toBeTruthy();
    expect(a.deleteMediaAction).not.toHaveBeenCalled();
    a.deleteMediaAction.mockResolvedValue(ok({ assetId: "a2", deletedAt: "2026-10-11T09:00:00.000Z", purgeAfter: "2026-10-12T09:00:00.000Z", alreadyDeleted: false }));
    await act(async () => { fireEvent.click(screen.getByTestId("media-delete-confirm")); });
    expect(a.deleteMediaAction).toHaveBeenCalledWith(SCOPE, "a2", expect.any(String));
    expect(tiles().map((t) => t.getAttribute("data-asset-id"))).toEqual(["a1", "a3"]);
    expect(screen.getByTestId("media-notice").textContent).toContain("Deleted. WebDesk keeps the stored file until");
    expect(screen.queryByTestId("media-detail")).toBeNull();
  });

  it("409 media-in-use shows the items that still use the asset, with links to their editors, and deletes nothing", async () => {
    mount(); open(1);
    fireEvent.click(screen.getByTestId("media-delete"));
    a.deleteMediaAction.mockResolvedValue({
      kind: "in_use", message: "in use", total: 3,
      items: [{ itemId: "i1", collectionKey: "service", locale: "en", slug: "service.seo", in: "live" }, { itemId: "i2", collectionKey: "navigation", locale: "id", slug: "navigation", in: "head" }],
    });
    await act(async () => { fireEvent.click(screen.getByTestId("media-delete-confirm")); });
    const dlg = screen.getByTestId("media-delete-dialog");
    expect(within(dlg).getByRole("heading", { name: /Can't delete: still in use/ })).toBeTruthy();
    expect(screen.getByTestId("media-in-use").textContent).toContain("used by 3 items");
    const links = within(screen.getByTestId("media-in-use-list")).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([`${ROUTE}/service/service.seo?locale=en`, `${ROUTE}/navigation/navigation?locale=id`]);
    expect(dlg.textContent).toContain("and 1 more not listed");
    expect(tiles()).toHaveLength(3); // still there
    expect(screen.queryByTestId("media-delete-failed")).toBeNull(); // never just "failed"
  });

  it("a 403 says deleting needs a publisher and turns Delete off; an unconfirmed delete offers Retry with the SAME key", async () => {
    mount(); open(1);
    fireEvent.click(screen.getByTestId("media-delete"));
    a.deleteMediaAction.mockResolvedValueOnce({ kind: "unavailable", code: "upstream_error", reason: "reconcile_failed" });
    await act(async () => { fireEvent.click(screen.getByTestId("media-delete-confirm")); });
    expect(screen.getByTestId("media-delete-unconfirmed").textContent).toContain("couldn't confirm the delete");
    a.deleteMediaAction.mockResolvedValueOnce({ kind: "forbidden", reason: "no" });
    await act(async () => { fireEvent.click(screen.getByTestId("media-delete-confirm")); });
    expect(a.deleteMediaAction.mock.calls[1][2]).toBe(a.deleteMediaAction.mock.calls[0][2]);
    expect(screen.getByTestId("media-delete-failed").textContent).toContain("needs a Web Dev publisher");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect((screen.getByTestId("media-delete") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("media-delete-why").textContent).toContain("publisher");
  });
});

describe("uploads", () => {
  const pick = (files: File[]) => fireEvent.change(screen.getByTestId("media-file-input"), { target: { files } });

  it("each file gets its OWN token (bucket by type), the raw file is sent to that token's URL, progress shows, and the asset lands in the grid, selected", async () => {
    a.mintUploadTokenAction.mockResolvedValueOnce(ok(token())).mockResolvedValueOnce(ok(token({ uploadUrl: "https://webdesk.example/v1/t/gaiada/media/upload/TOKEN-2" })));
    let progress: ((f: number) => void) | undefined;
    let finish: ((v: UploadOutcome) => void) | undefined;
    up.mockImplementationOnce((_u, _f, o) => { progress = o?.onProgress; return new Promise((r) => { finish = r; }); });
    up.mockImplementationOnce(async () => ({ ok: true as const, asset: asset(8, { title: "Second", originalFilename: "second.png" }) }));
    mount();
    const f1 = png("first.png"); const f2 = png("second.png");
    pick([f1, f2]);
    await waitFor(() => expect(up).toHaveBeenCalledTimes(1));
    expect(a.mintUploadTokenAction).toHaveBeenCalledWith(SCOPE, "media");
    expect(up.mock.calls[0][0]).toBe("https://webdesk.example/v1/t/gaiada/media/upload/TOKEN-1");
    expect(up.mock.calls[0][1]).toBe(f1);
    // second file waits for the first (WebDesk limits concurrent uploads per tenant)
    expect(a.mintUploadTokenAction).toHaveBeenCalledTimes(1);
    act(() => progress?.(0.5));
    const bar = screen.getByRole("progressbar", { name: "Uploading first.png" }) as HTMLProgressElement;
    expect(bar.value).toBe(50);
    await act(async () => { finish?.({ ok: true as const, asset: asset(7, { title: "First", originalFilename: "first.png" }) }); });
    await waitFor(() => expect(up).toHaveBeenCalledTimes(2));
    expect(a.mintUploadTokenAction).toHaveBeenCalledTimes(2);
    expect(up.mock.calls[1][0]).toBe("https://webdesk.example/v1/t/gaiada/media/upload/TOKEN-2");
    await waitFor(() => expect(tiles()).toHaveLength(5));
    expect(tiles()[0].getAttribute("data-asset-id")).toBe("a8");
    expect(tiles()[0].getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("media-detail-title").textContent).toBe("Second");
  });

  it("leaving the page while a file is still uploading asks first; once nothing is in flight it does not", async () => {
    a.mintUploadTokenAction.mockResolvedValue(ok(token()));
    let finish: ((v: UploadOutcome) => void) | undefined;
    up.mockImplementation(() => new Promise((r) => { finish = r; }));
    mount(); pick([png("slow.png")]);
    await waitFor(() => expect(up).toHaveBeenCalled());
    const during = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(during);
    expect(during.defaultPrevented).toBe(true);
    await act(async () => { finish?.({ ok: true as const, asset: asset(7) }); });
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("a video goes to the video bucket", async () => {
    a.mintUploadTokenAction.mockResolvedValue(ok(token({ allowedMimes: ["video/mp4"] })));
    up.mockResolvedValue({ ok: true, asset: asset(5, { mime: "video/mp4" }) });
    mount(); pick([png("clip.mp4", "video/mp4")]);
    await waitFor(() => expect(a.mintUploadTokenAction).toHaveBeenCalledWith(SCOPE, "video"));
  });

  it("progress is announced politely: milestones only (started, half, done), in a polite status region; never assertive, never role=log", async () => {
    a.mintUploadTokenAction.mockResolvedValue(ok(token()));
    let progress: ((f: number) => void) | undefined;
    let finish: ((v: UploadOutcome) => void) | undefined;
    up.mockImplementation((_u, _f, o) => { progress = o?.onProgress; return new Promise((r) => { finish = r; }); });
    const { container } = mount();
    pick([png("first.png")]);
    await waitFor(() => expect(up).toHaveBeenCalled());
    const status = screen.getByTestId("media-upload-status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("role")).toBe("status");
    const said: string[] = [];
    new MutationObserver(() => said.push(status.textContent ?? "")).observe(status, { childList: true, characterData: true, subtree: true });
    expect(status.textContent).toBe("Uploading first.png.");
    act(() => { for (const f of [0.1, 0.2, 0.3, 0.4]) progress?.(f); });
    expect(status.textContent).toBe("Uploading first.png."); // per-percent updates are NOT announced
    act(() => { for (const f of [0.5, 0.6, 0.7]) progress?.(f); });
    expect(status.textContent).toBe("first.png is half uploaded.");
    await act(async () => { finish?.({ ok: true, asset: asset(7) }); });
    expect(status.textContent).toBe("first.png uploaded.");
    await flush();
    expect(said).toEqual(["first.png is half uploaded.", "first.png uploaded."]);
    expect(container.querySelector('[aria-live="assertive"], [role="log"]')).toBeNull();
    expect(document.querySelector('[aria-live="assertive"]')).toBeNull();
  });

  it.each([
    ["too large", { ok: false as const, failure: { kind: "too_large" as const, title: "That file is too large.", detail: "The limit is 1.0 MB." } }, "too_large", "That file is too large."],
    ["type not allowed", { ok: false as const, failure: { kind: "type_not_allowed" as const, title: "That file type isn't allowed.", detail: "x" } }, "type_not_allowed", "That file type isn't allowed."],
    ["infected", { ok: false as const, failure: { kind: "infected" as const, title: "WebDesk's virus scan refused this file.", detail: "It was not added to the library." } }, "infected", "WebDesk's virus scan refused this file."],
    ["scan unavailable", { ok: false as const, failure: { kind: "scan_unavailable" as const, title: "WebDesk couldn't scan this file right now, so it wasn't accepted.", detail: "Try again in a few minutes." } }, "scan_unavailable", "couldn't scan this file"],
    ["uploads not enabled", { ok: false as const, failure: { kind: "not_enabled" as const, title: "Uploads aren't enabled for this site yet.", detail: "d" } }, "not_enabled", "Uploads aren't enabled for this site yet."],
    ["token expired", { ok: false as const, failure: { kind: "token_expired" as const, title: "The upload link expired or was already used.", detail: "Retrying asks for a fresh one." } }, "token_expired", "expired or was already used"],
  ])("a refused upload (%s) is shown on its file's row in plain words, and nothing is added to the grid", async (_n, outcome, kind, copy) => {
    a.mintUploadTokenAction.mockResolvedValue(ok(token()));
    up.mockResolvedValue(outcome);
    mount(); pick([png()]);
    const row = await screen.findByTestId("media-upload-failed");
    expect(row.getAttribute("data-kind")).toBe(kind);
    expect(row.textContent).toContain(copy);
    expect(tiles()).toHaveLength(3);
  });

  it("the file is checked against the token before any bytes are sent: a type or size the token does not allow never reaches WebDesk", async () => {
    a.mintUploadTokenAction.mockResolvedValue(ok(token({ maxBytes: 10 })));
    mount(); pick([png("big.png", "image/png", 64), png("a.svg", "image/svg+xml", 4)]);
    await waitFor(() => expect(screen.getAllByTestId("media-upload-failed")).toHaveLength(2));
    expect(up).not.toHaveBeenCalled();
    const kinds = screen.getAllByTestId("media-upload-failed").map((r) => r.getAttribute("data-kind"));
    expect(kinds).toEqual(["too_large", "type_not_allowed"]);
  });

  it("Retry mints a FRESH token and uploads again (a token is spent even by a refused body)", async () => {
    a.mintUploadTokenAction.mockResolvedValueOnce(ok(token())).mockResolvedValueOnce(ok(token({ uploadUrl: "https://webdesk.example/v1/t/gaiada/media/upload/TOKEN-FRESH" })));
    up.mockResolvedValueOnce({ ok: false, failure: { kind: "token_expired", title: "The upload link expired or was already used.", detail: "Retrying asks for a fresh one." } });
    up.mockResolvedValueOnce({ ok: true, asset: asset(7, { title: "Retried" }) });
    mount(); pick([png("again.png")]);
    await screen.findByTestId("media-upload-failed");
    fireEvent.click(screen.getByRole("button", { name: "Retry again.png" }));
    await waitFor(() => expect(up).toHaveBeenCalledTimes(2));
    expect(a.mintUploadTokenAction).toHaveBeenCalledTimes(2);
    expect(up.mock.calls[0][0]).toContain("TOKEN-1");
    expect(up.mock.calls[1][0]).toContain("TOKEN-FRESH");
    await waitFor(() => expect(tiles()).toHaveLength(4));
  });

  it("a mint the server refuses (403) is 'you can't upload', turns Upload off with the reason, and sends nothing", async () => {
    a.mintUploadTokenAction.mockResolvedValue({ kind: "forbidden", reason: "no" });
    mount(); pick([png()]);
    expect((await screen.findByTestId("media-upload-failed")).textContent).toContain("You can't upload to this library.");
    expect(up).not.toHaveBeenCalled();
    await waitFor(() => expect((screen.getByTestId("media-upload") as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByTestId("media-upload-why").textContent).toContain("You can browse the library but not add to it");
  });

  it("WebDesk's public URL not configured on the platform: 'Uploads aren't enabled for this site yet', with the operator's fix", async () => {
    a.mintUploadTokenAction.mockResolvedValue(unavailable("webdesk_public_url_not_configured"));
    mount(); pick([png()]);
    const row = await screen.findByTestId("media-upload-failed");
    expect(row.getAttribute("data-kind")).toBe("not_enabled");
    expect(row.textContent).toContain("Uploads aren't enabled for this site yet.");
    expect(row.textContent).toContain("WEBDESK_PUBLIC_BASE_URL");
  });

  it("the upload control works without drag and drop (a real button), and a drop on the grid uploads too", async () => {
    a.mintUploadTokenAction.mockResolvedValue(ok(token()));
    up.mockResolvedValue({ ok: true, asset: asset(7) });
    mount();
    const btn = screen.getByRole("button", { name: "Upload files" });
    const input = screen.getByTestId("media-file-input") as HTMLInputElement;
    const clicked = vi.spyOn(input, "click");
    fireEvent.click(btn);
    expect(clicked).toHaveBeenCalled();
    fireEvent.drop(screen.getByTestId("media-dropzone"), { dataTransfer: { files: [png("dropped.png")], types: ["Files"] } });
    await waitFor(() => expect(up).toHaveBeenCalledTimes(1));
    expect((up.mock.calls[0][1] as File).name).toBe("dropped.png");
  });

  it("a drop while uploads are off is refused with the reason, nothing is minted", () => {
    mount({ denied: { upload: "Uploads are off for you." } });
    fireEvent.drop(screen.getByTestId("media-dropzone"), { dataTransfer: { files: [png()], types: ["Files"] } });
    expect(a.mintUploadTokenAction).not.toHaveBeenCalled();
    expect(screen.getByTestId("media-notice").textContent).toBe("Uploads are off for you.");
  });
});

describe("keyboard and accessibility", () => {
  it("the grid is a listbox with a roving tabindex: arrows, Home and End move focus; Enter selects", () => {
    mount();
    const t = tiles();
    expect(t.map((x) => x.tabIndex)).toEqual([0, -1, -1]);
    t[0].focus();
    fireEvent.keyDown(t[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(t[1]);
    fireEvent.keyDown(t[1], { key: "End" });
    expect(document.activeElement).toBe(t[2]);
    fireEvent.keyDown(t[2], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(t[1]);
    fireEvent.keyDown(t[1], { key: "Home" });
    expect(document.activeElement).toBe(t[0]);
    expect(t[0].getAttribute("aria-selected")).toBe("false");
    fireEvent.keyDown(t[0], { key: "Enter" });
    expect(tiles()[0].getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("media-detail")).toBeTruthy();
    fireEvent.keyDown(tiles()[0], { key: " " });
    expect(screen.getByTestId("media-detail")).toBeTruthy();
  });

  it("every button and field has an accessible name", () => {
    mount(); open(1);
    for (const el of [...document.querySelectorAll("button, input:not([hidden]), select, textarea")]) {
      const name = el.getAttribute("aria-label") || el.textContent?.trim() || (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent) || el.getAttribute("aria-labelledby");
      expect(name, el.outerHTML).toBeTruthy();
    }
  });

  it("no live region on the page is assertive or a log", async () => {
    a.mintUploadTokenAction.mockResolvedValue(ok(token()));
    up.mockResolvedValue({ ok: false, failure: { kind: "infected", title: "x", detail: "y" } });
    mount(); open(1);
    fireEvent.change(screen.getByTestId("media-file-input"), { target: { files: [png()] } });
    await screen.findByTestId("media-upload-failed");
    expect(document.querySelector('[aria-live="assertive"], [role="log"]')).toBeNull();
  });

  it("leaving a detail with unsaved edits asks before discarding", () => {
    mount(); open(1);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "changed" } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    open(2);
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByTestId("media-detail-title").textContent).toBe("Image 1");
    confirm.mockReturnValue(true);
    open(2);
    expect(screen.getByTestId("media-detail-title").textContent).toBe("Image 2");
    confirm.mockRestore();
  });
});

// ── WSK-359 · controls disabled UP FRONT from the list's `capabilities` ─────────────────────────────────────────────
describe("capabilities from the list: controls are off before any 403", () => {
  const withCaps = (caps: NonNullable<MediaListBody["capabilities"]>, assets = [asset(1), asset(2), asset(3)]): MediaListBody => ({ ...list(assets), capabilities: caps });
  const ALL = { read: true, upload: true, update: true, delete: true };

  it("a read-only caller: Upload, Save and Delete are disabled on first paint, each with its reason, and browsing works", () => {
    mount({ initial: { list: withCaps({ read: true, upload: false, update: false, delete: false }), loadedAt: "t" } });
    expect((screen.getByTestId("media-upload") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("media-upload-why").textContent).toContain("You can't upload images here.");
    expect(tiles()).toHaveLength(3);
    open(1);
    expect(screen.getByTestId("media-readonly").textContent).toContain("You can't edit images here.");
    expect((screen.getByLabelText("Title") as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByTestId("media-save") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("media-delete") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("media-delete-why").textContent).toContain("You can't delete images here.");
    // nothing was sent to learn it
    expect(a.updateMediaAction).not.toHaveBeenCalled();
    expect(a.mintUploadTokenAction).not.toHaveBeenCalled();
    expect(a.deleteMediaAction).not.toHaveBeenCalled();
  });

  it("an editor (no delete): Upload and Save are on, only Delete is off with its reason", () => {
    mount({ initial: { list: withCaps({ read: true, upload: true, update: true, delete: false }), loadedAt: "t" } });
    expect((screen.getByTestId("media-upload") as HTMLButtonElement).disabled).toBe(false);
    open(1);
    expect(screen.queryByTestId("media-readonly")).toBeNull();
    expect((screen.getByLabelText("Title") as HTMLInputElement).readOnly).toBe(false);
    expect((screen.getByTestId("media-delete") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("media-delete-why").textContent).toContain("Deleting needs a Web Dev publisher or a company admin.");
  });

  it("a publisher: everything on, nothing said", () => {
    mount({ initial: { list: withCaps(ALL), loadedAt: "t" } });
    expect((screen.getByTestId("media-upload") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("media-upload-why")).toBeNull();
    open(1);
    expect((screen.getByTestId("media-delete") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("media-delete-why")).toBeNull();
  });

  it("UNKNOWN capabilities (the BFF could not ask, so the key is absent) leave every control on: unknown is never 'denied'", () => {
    mount();
    expect((screen.getByTestId("media-upload") as HTMLButtonElement).disabled).toBe(false);
    open(1);
    expect(screen.queryByTestId("media-readonly")).toBeNull();
    expect((screen.getByTestId("media-delete") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a drop while Upload is off up front is refused with the reason, and nothing is minted", () => {
    mount({ initial: { list: withCaps({ read: true, upload: false, update: true, delete: true }), loadedAt: "t" } });
    fireEvent.drop(screen.getByTestId("media-dropzone"), { dataTransfer: { files: [png()], types: ["Files"] }  });
    expect(a.mintUploadTokenAction).not.toHaveBeenCalled();
    expect(screen.getByTestId("media-notice").textContent).toContain("You can't upload images here.");
  });

  it("FALLBACK: capabilities say yes but the server says 403 anyway: the control still turns off with the 403 reason, and nothing breaks", async () => {
    a.mintUploadTokenAction.mockResolvedValue({ kind: "forbidden", reason: "no" });
    mount({ initial: { list: withCaps(ALL), loadedAt: "t" } });
    expect((screen.getByTestId("media-upload") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByTestId("media-file-input"), { target: { files: [png()] } });
    expect((await screen.findByTestId("media-upload-failed")).textContent).toContain("You can't upload to this library.");
    await waitFor(() => expect((screen.getByTestId("media-upload") as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByTestId("media-upload-why").textContent).toContain("You can browse the library but not add to it");
  });

  it("a 403 on save with capabilities saying yes still turns the panel read-only (the fallback)", async () => {
    mount({ initial: { list: withCaps(ALL), loadedAt: "t" } });
    open(1);
    a.updateMediaAction.mockResolvedValue({ kind: "forbidden", reason: "no" });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "x" } });
    await act(async () => { fireEvent.click(screen.getByTestId("media-save")); });
    expect(screen.getByTestId("media-readonly").textContent).toContain("You can browse the library but not edit assets");
    expect((screen.getByTestId("media-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("the picker's own load (no initial list) reads the capabilities from the answer and disables Upload up front", async () => {
    a.listMediaAction.mockResolvedValue(ok(withCaps({ read: true, upload: false, update: false, delete: false }, [asset(1)])));
    mount({ mode: "pick", initial: null, onPick: vi.fn() });
    await screen.findAllByTestId("media-tile");
    expect((screen.getByTestId("media-upload") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("media-upload-why").textContent).toContain("You can't upload images here.");
  });

  it("a later refresh replaces what the capabilities said (a promotion turns the control back on); a 403 learned earlier stays", async () => {
    a.listMediaAction.mockResolvedValueOnce(ok(withCaps(ALL, [asset(1)])));
    mount({ initial: { list: withCaps({ read: true, upload: false, update: true, delete: true }), loadedAt: "t" } });
    expect((screen.getByTestId("media-upload") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole("search", { name: "Filter media" }));
    await waitFor(() => expect((screen.getByTestId("media-upload") as HTMLButtonElement).disabled).toBe(false));
  });

  it("CLIENT MODE: the reasons name the company's admin, and a client's delete (always false) shows no Delete control at all", () => {
    const driver = { list: vi.fn(), mintToken: vi.fn(), update: vi.fn() } as never;
    mount({ driver, initial: { list: withCaps({ read: true, upload: false, update: false, delete: false }), loadedAt: "t" } });
    expect(screen.getByTestId("media-upload-why").textContent).toBe("You can't upload images here. Ask your company's admin.");
    open(1);
    expect(screen.getByTestId("media-readonly").textContent).toContain("You can't edit images here. Ask your company's admin.");
    expect(screen.queryByTestId("media-delete")).toBeNull();
  });
});
