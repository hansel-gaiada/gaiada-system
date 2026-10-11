import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { FieldDef } from "@/lib/webdeskContentModel";
import type { MediaAsset, MediaListBody } from "@/lib/webdeskMediaModel";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/webdeskMediaActions", () => ({
  listMediaAction: vi.fn(), mediaUsageAction: vi.fn(), mintUploadTokenAction: vi.fn(), updateMediaAction: vi.fn(), deleteMediaAction: vi.fn(),
}));
vi.mock("@/lib/mediaUpload", () => ({ uploadFile: vi.fn() }));

import * as A from "@/lib/webdeskMediaActions";
import { uploadFile } from "@/lib/mediaUpload";
import { FieldEditor, type FormCtx } from "./FieldEditor";

const a = vi.mocked(A);
const up = vi.mocked(uploadFile);

const SCOPE = { tenantSlug: "gaiada", siteId: "s1" };
const asset = (n: number, over: Partial<MediaAsset> = {}): MediaAsset => ({
  assetId: `a${n}`, url: `/v1/t/gaiada/media/a${n}`, mime: "image/png", sizeBytes: 2048, scanStatus: "clean", title: `Image ${n}`, alt: { en: `English ${n}`, id: `Indonesia ${n}` }, tags: [],
  originalFilename: `image-${n}.png`, width: 1200, height: 800, createdBy: "u1", createdAt: "2026-10-11T08:00:00.000Z", updatedAt: "2026-10-11T08:00:00.000Z", deletedAt: null, ...over,
});
const lib = (assets: MediaAsset[]): MediaListBody => ({ assets, page: { cursor: null, hasMore: false, limit: 48 } });

const defs: FieldDef[] = [
  { name: "hero", primitive: "media", ui: { label: "Hero image" } },
  { name: "gallery", primitive: "media", multiple: true, ui: { label: "Gallery" } },
];

function ctxFor(locale = "en", over: Partial<FormCtx> = {}): FormCtx {
  return {
    issues: [], readOnly: false, neutralLock: false, neutralLocale: "en",
    media: { scope: SCOPE, routeBase: "/departments/d1/website/content/gaiada/s1", locale, locales: ["en", "id"], authors: { u1: "Dewi" }, publicBase: "https://webdesk.example" },
    ...over,
  };
}

let latest: Record<string, unknown> = {};
function Harness({ initial = {}, ctx = ctxFor() }: { initial?: Record<string, unknown>; ctx?: FormCtx }) {
  const [v, setV] = useState<Record<string, unknown>>(initial);
  latest = v;
  return <FieldEditor defs={defs} value={v} onChange={setV} ctx={ctx} />;
}

const choose = async (name: RegExp) => {
  const btn = screen.getByRole("button", { name });
  btn.focus();
  fireEvent.click(btn);
  return screen.findByTestId("media-picker");
};

beforeEach(() => {
  Object.values(a).forEach((f) => (f as ReturnType<typeof vi.fn>).mockReset());
  up.mockReset();
  a.mediaUsageAction.mockResolvedValue({ kind: "ok", data: { assetId: "a1", url: "/v1/t/gaiada/media/a1", total: 0, items: [] } });
  a.listMediaAction.mockResolvedValue({ kind: "ok", data: lib([asset(1), asset(2)]) });
  latest = {};
});

describe("the picker for a media field", () => {
  it("opens the library as a dialog in pick mode, loading the list only now", async () => {
    render(<Harness />);
    expect(a.listMediaAction).not.toHaveBeenCalled(); // nothing is read until the dialog opens
    const dlg = await choose(/Choose from library: Hero image/);
    expect(dlg.getAttribute("aria-labelledby")).toBeTruthy();
    expect(within(dlg).getByRole("heading", { name: "Choose from the media library" })).toBeTruthy();
    await waitFor(() => expect(within(dlg).getAllByTestId("media-tile")).toHaveLength(2));
    expect(a.listMediaAction).toHaveBeenCalledWith(SCOPE, expect.objectContaining({ limit: 48 }));
  });

  it("choosing an asset writes exactly {url, alt, width, height, mime}, alt being the asset's text for the EDITOR's locale", async () => {
    render(<Harness ctx={ctxFor("id")} />);
    await choose(/Choose from library: Hero image/);
    await waitFor(() => expect(screen.getAllByTestId("media-tile")).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId("media-tile")[1]);
    fireEvent.click(await screen.findByTestId("media-use"));
    expect(latest.hero).toEqual({ url: "/v1/t/gaiada/media/a2", alt: "Indonesia 2", width: 1200, height: 800, mime: "image/png" });
    expect(Object.keys(latest.hero as object)).toEqual(["url", "alt", "width", "height", "mime"]);
    expect(screen.queryByTestId("media-picker")).toBeNull(); // closed
    // the manual inputs show what was written
    expect((document.querySelector('[data-pointer="/blocks/0/props/hero/url"]') as HTMLInputElement).value).toBe("/v1/t/gaiada/media/a2");
    expect((document.querySelector('[data-pointer="/blocks/0/props/hero/alt"]') as HTMLInputElement).value).toBe("Indonesia 2");
  });

  it("omits alt when the asset has none for that locale, and omits dimensions the asset does not have", async () => {
    a.listMediaAction.mockResolvedValue({ kind: "ok", data: lib([asset(3, { alt: { en: "only English" }, width: null, height: null, mime: "application/pdf" })]) });
    render(<Harness ctx={ctxFor("id")} />);
    await choose(/Choose from library: Hero image/);
    fireEvent.click((await screen.findAllByTestId("media-tile"))[0]);
    fireEvent.click(await screen.findByTestId("media-use"));
    expect(latest.hero).toEqual({ url: "/v1/t/gaiada/media/a3", mime: "application/pdf" });
  });

  it("a multiple field APPENDS: existing images are kept, in order, and the new one goes last", async () => {
    const existing = [{ url: "https://cdn.example/old.png", alt: "old" }];
    render(<Harness initial={{ gallery: existing }} />);
    await choose(/Add from library: Gallery/);
    fireEvent.click((await screen.findAllByTestId("media-tile"))[0]);
    fireEvent.click(await screen.findByTestId("media-use"));
    expect(latest.gallery).toEqual([existing[0], { url: "/v1/t/gaiada/media/a1", alt: "English 1", width: 1200, height: 800, mime: "image/png" }]);
    // and a second pick appends again
    await choose(/Add from library: Gallery/);
    fireEvent.click((await screen.findAllByTestId("media-tile"))[1]);
    fireEvent.click(await screen.findByTestId("media-use"));
    expect((latest.gallery as unknown[]).length).toBe(3);
    expect((latest.gallery as { url: string }[])[2].url).toBe("/v1/t/gaiada/media/a2");
  });

  it("a row of a multiple field has its own picker, which REPLACES that row only", async () => {
    render(<Harness initial={{ gallery: [{ url: "/x/1" }, { url: "/x/2" }] }} />);
    await choose(/Choose from library: Gallery 2/);
    fireEvent.click((await screen.findAllByTestId("media-tile"))[0]);
    fireEvent.click(await screen.findByTestId("media-use"));
    const g = latest.gallery as { url: string }[];
    expect(g.map((x) => x.url)).toEqual(["/x/1", "/v1/t/gaiada/media/a1"]);
  });

  it("manual URL entry keeps working beside the picker", () => {
    render(<Harness />);
    fireEvent.change(document.querySelector('[data-pointer="/blocks/0/props/hero/url"]')!, { target: { value: "https://cdn.example/x.png" } });
    fireEvent.change(document.querySelector('[data-pointer="/blocks/0/props/hero/alt"]')!, { target: { value: "typed" } });
    expect(latest.hero).toEqual({ url: "https://cdn.example/x.png", alt: "typed" });
  });

  it("uploading from inside the picker selects the new asset, ready to use", async () => {
    a.mintUploadTokenAction.mockResolvedValue({ kind: "ok", data: { uploadUrl: "https://webdesk.example/v1/t/gaiada/media/upload/T", expiresAt: "t", maxBytes: 1024 * 1024, allowedMimes: ["image/png"] } });
    up.mockResolvedValue({ ok: true, asset: asset(9, { title: "Fresh", alt: { en: "Fresh alt" } }) });
    render(<Harness />);
    await choose(/Choose from library: Hero image/);
    await screen.findAllByTestId("media-tile");
    fireEvent.change(screen.getByTestId("media-file-input"), { target: { files: [new File([new Uint8Array(8)], "fresh.png", { type: "image/png" })] } });
    await waitFor(() => expect(screen.getAllByTestId("media-tile")[0].getAttribute("data-asset-id")).toBe("a9"));
    expect(screen.getAllByTestId("media-tile")[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByTestId("media-use"));
    expect(latest.hero).toEqual({ url: "/v1/t/gaiada/media/a9", alt: "Fresh alt", width: 1200, height: 800, mime: "image/png" });
  });

  it("alt edited in the picker before choosing is what gets written", async () => {
    a.updateMediaAction.mockResolvedValue({ kind: "ok", data: { asset: asset(1, { alt: { en: "Typed in the picker" } }) } });
    render(<Harness />);
    await choose(/Choose from library: Hero image/);
    fireEvent.click((await screen.findAllByTestId("media-tile"))[0]);
    fireEvent.change(await screen.findByTestId("media-alt-en"), { target: { value: "Typed in the picker" } });
    await act(async () => { fireEvent.click(screen.getByTestId("media-save")); });
    fireEvent.click(screen.getByTestId("media-use"));
    expect((latest.hero as { alt: string }).alt).toBe("Typed in the picker");
  });

  it("the dialog is modal and labelled; Close and Escape close it and focus returns to the button that opened it", async () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: /Choose from library: Hero image/ });
    const dlg = await choose(/Choose from library: Hero image/);
    expect(dlg.tagName).toBe("DIALOG");
    expect(dlg.hasAttribute("open")).toBe(true);
    const title = document.getElementById(dlg.getAttribute("aria-labelledby")!);
    expect(title?.textContent).toBe("Choose from the media library");
    fireEvent.click(await screen.findByTestId("media-pick-close"));
    await waitFor(() => expect(screen.queryByTestId("media-picker")).toBeNull());
    expect(document.activeElement).toBe(opener);
    // Escape (the dialog's cancel event)
    opener.focus();
    const dlg2 = await choose(/Choose from library: Hero image/);
    fireEvent(dlg2, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(screen.queryByTestId("media-picker")).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(latest.hero).toBeUndefined(); // closing picks nothing
  });

  it("when the library can't be read, the dialog says so (never an empty library) and the manual inputs are still there", async () => {
    a.listMediaAction.mockResolvedValue({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" });
    render(<Harness />);
    await choose(/Choose from library: Hero image/);
    expect((await screen.findByTestId("media-unavailable")).textContent).toContain("unavailable");
    expect(screen.queryByTestId("media-empty")).toBeNull();
    fireEvent.click(screen.getByTestId("media-pick-close"));
    await waitFor(() => expect(screen.queryByTestId("media-picker")).toBeNull());
    expect(document.querySelector('[data-pointer="/blocks/0/props/hero/url"]')).toBeTruthy();
  });

  it("a read-only form has no working picker; a form with no media context has none at all", () => {
    const { unmount } = render(<Harness ctx={ctxFor("en", { readOnly: true })} />);
    for (const b of screen.getAllByTestId("media-choose")) expect((b as HTMLButtonElement).disabled).toBe(true);
    unmount();
    render(<Harness ctx={{ issues: [], readOnly: false, neutralLock: false, neutralLocale: "en" }} />);
    expect(screen.queryByTestId("media-choose")).toBeNull();
    expect(document.querySelector('[data-pointer="/blocks/0/props/hero/url"]')).toBeTruthy();
  });
});
