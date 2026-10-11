import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { WdResult } from "@/lib/webdeskContentModel";
import type { MediaAsset, MediaListBody, UploadToken } from "@/lib/webdeskMediaModel";
import type { MediaDriver } from "@/lib/webdeskEditorDriver";

// WSK-49d — the media library in CLIENT MODE (MediaLibrary.test.tsx, the staff suite, runs unchanged).
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/webdeskMediaActions", () => ({
  listMediaAction: vi.fn(), mediaUsageAction: vi.fn(), mintUploadTokenAction: vi.fn(), updateMediaAction: vi.fn(), deleteMediaAction: vi.fn(),
}));
vi.mock("@/lib/mediaUpload", () => ({ uploadFile: vi.fn() }));

import * as A from "@/lib/webdeskMediaActions";
import { uploadFile } from "@/lib/mediaUpload";
import { MediaLibrary } from "./MediaLibrary";

const staff = vi.mocked(A);
const up = vi.mocked(uploadFile);
const SCOPE = { tenantSlug: "gaiada", siteId: "s1" };
const ok = <T,>(data: T): WdResult<T> => ({ kind: "ok", data });
const asset = (n: number): MediaAsset => ({
  assetId: `a${n}`, url: `/v1/t/gaiada/media/a${n}`, mime: "image/png", sizeBytes: 2048, scanStatus: "clean", title: `Image ${n}`, alt: { en: `Alt ${n}` }, tags: [],
  originalFilename: `image-${n}.png`, width: 10, height: 10, createdBy: "u1", createdAt: "2026-10-11T08:00:00.000Z", updatedAt: "2026-10-11T08:00:00.000Z", deletedAt: null,
});
const list = (assets: MediaAsset[]): MediaListBody => ({ assets, page: { cursor: null, hasMore: false, limit: 48 } });
const token: UploadToken = { uploadUrl: "https://webdesk.example/v1/t/gaiada/media/upload/T", expiresAt: "2026-10-11T08:10:00Z", maxBytes: 1024 * 1024, allowedMimes: ["image/png"] };

let drv: { [K in "list" | "mintToken" | "update"]: ReturnType<typeof vi.fn> } & MediaDriver;
const mount = () => render(<MediaLibrary mode="manage" scope={SCOPE} routeBase="/portal/website/g/s" locales={["en"]} authors={{}} publicBase={null} initial={{ list: list([asset(1)]), loadedAt: "t" }} driver={drv} />);
const open = () => fireEvent.click(screen.getByTestId("media-tile"));

beforeEach(() => {
  Object.values(staff).forEach((f) => (f as ReturnType<typeof vi.fn>).mockReset());
  up.mockReset();
  drv = { list: vi.fn().mockResolvedValue(ok(list([asset(1)]))), mintToken: vi.fn(), update: vi.fn() } as never;
});

describe("media in client mode: NO delete, no 'where it's used'", () => {
  it("an opened asset has no Delete control and no usage section", async () => {
    mount();
    open();
    expect(await screen.findByTestId("media-detail")).toBeTruthy();
    expect(screen.queryByTestId("media-delete")).toBeNull();
    expect(screen.queryByTestId("media-usage")).toBeNull();
    expect(screen.queryByText(/delete/i)).toBeNull();
    expect(staff.mediaUsageAction).not.toHaveBeenCalled();
  });

  it("a save of the details goes through the portal's update, never the staff action", async () => {
    drv.update.mockResolvedValue(ok({ asset: { ...asset(1), title: "Renamed" } }));
    mount();
    open();
    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Renamed" } });
    await act(async () => { fireEvent.click(screen.getByTestId("media-save")); });
    expect(drv.update).toHaveBeenCalledTimes(1);
    expect(drv.update.mock.calls[0].slice(0, 3)).toEqual([SCOPE, "a1", { title: "Renamed" }]);
    expect(staff.updateMediaAction).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("media-detail-title").textContent).toBe("Renamed"));
  });

  it("an update the server refuses with 403 says to ask the company's admin (not a Web Dev publisher)", async () => {
    drv.update.mockResolvedValue({ kind: "forbidden", reason: "forbidden" });
    mount();
    open();
    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Renamed" } });
    await act(async () => { fireEvent.click(screen.getByTestId("media-save")); });
    expect((await screen.findByTestId("media-readonly")).textContent).toContain("Ask your company's admin.");
    expect(document.body.textContent).not.toContain("Web Dev");
  });
});

describe("media in client mode: the list and the upload use the portal's calls", () => {
  it("a filter search reads through the portal's list", async () => {
    mount();
    fireEvent.change(screen.getByLabelText(/Search/i), { target: { value: "logo" } });
    await act(async () => { fireEvent.submit(screen.getByRole("search")); });
    await waitFor(() => expect(drv.list).toHaveBeenCalled());
    expect(drv.list.mock.calls[0][0]).toEqual(SCOPE);
    expect(drv.list.mock.calls[0][1]).toMatchObject({ q: "logo" });
    expect(staff.listMediaAction).not.toHaveBeenCalled();
  });

  it("an upload mints its token through the portal and the bytes go browser -> WebDesk exactly as in the staff UI", async () => {
    drv.mintToken.mockResolvedValue(ok(token));
    up.mockResolvedValue({ ok: true, asset: asset(2) } as never);
    mount();
    const file = new File([new Uint8Array(64)], "new.png", { type: "image/png" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
    await waitFor(() => expect(up).toHaveBeenCalled());
    expect(drv.mintToken).toHaveBeenCalledWith(SCOPE, "media");
    expect(up.mock.calls[0][0]).toBe(token.uploadUrl);
    expect(staff.mintUploadTokenAction).not.toHaveBeenCalled();
  });

  it("an upload the server refuses with 403 turns Upload off, with the client's sentence", async () => {
    drv.mintToken.mockResolvedValue({ kind: "forbidden", reason: "forbidden" });
    mount();
    const file = new File([new Uint8Array(64)], "new.png", { type: "image/png" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
    await waitFor(() => expect(document.body.textContent).toContain("Ask your company's admin."));
  });
});
