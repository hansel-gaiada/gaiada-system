import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// The Media tab's page: two reads before anything is drawn (the site, then the first page of assets). A refusal of EITHER is
// a notice with NO grid; only an `ok` read may say "empty".

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/webdeskMediaActions", () => ({ listMediaAction: vi.fn(), mediaUsageAction: vi.fn(), mintUploadTokenAction: vi.fn(), updateMediaAction: vi.fn(), deleteMediaAction: vi.fn() }));
vi.mock("@/lib/webdeskContent", () => ({ listSites: vi.fn(), resolveAuthorNames: vi.fn() }));
vi.mock("@/lib/webdeskMedia", () => ({ listMedia: vi.fn(), mediaPublicBase: vi.fn(() => "https://webdesk.example") }));
vi.mock("@/components/webdesk/content/serverCtx", () => ({ requireWebsiteCtx: vi.fn() }));

import { listSites, resolveAuthorNames } from "@/lib/webdeskContent";
import { listMedia } from "@/lib/webdeskMedia";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import WebsiteMediaPage from "./page";

const sitesMock = vi.mocked(listSites);
const mediaMock = vi.mocked(listMedia);
const ctxMock = vi.mocked(requireWebsiteCtx);

const sites = () => ({ kind: "ok" as const, data: { tenants: [{ slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en", "id"], sites: [{ siteId: "site-1", name: "gaiada.com", kind: "static", environments: [] }] }] } });
const asset = (n: number) => ({
  assetId: `a${n}`, url: `/v1/t/gaiada/media/a${n}`, mime: "image/png", sizeBytes: 10, scanStatus: "clean", title: `Image ${n}`, alt: {}, tags: [], originalFilename: `i${n}.png`,
  width: 1, height: 1, createdBy: "u1", createdAt: "2026-10-11T08:00:00.000Z", updatedAt: "2026-10-11T08:00:00.000Z", deletedAt: null,
});
const mount = async () => render(await WebsiteMediaPage({ params: Promise.resolve({ deptId: "dept-1", tenant: "gaiada", site: "site-1" }) }));

beforeEach(() => {
  ctxMock.mockReset(); sitesMock.mockReset(); mediaMock.mockReset();
  ctxMock.mockResolvedValue({ userId: "u", me: {}, company: "co-1", deptId: "dept-1", contentBase: "/departments/dept-1/website/content", mediaBase: "/departments/dept-1/website/media" } as never);
  sitesMock.mockResolvedValue(sites());
  vi.mocked(resolveAuthorNames).mockResolvedValue({ u1: "Dewi" });
});

describe("Website → Media → site", () => {
  it("ok: asks for the Media tab's context and draws the library with the tenant's locales", async () => {
    mediaMock.mockResolvedValue({ kind: "ok", data: { assets: [asset(1), asset(2)], page: { cursor: null, hasMore: false, limit: 48 } } });
    await mount();
    expect(ctxMock).toHaveBeenCalledWith("dept-1", "media");
    expect(screen.getByTestId("media-library").getAttribute("data-mode")).toBe("manage");
    expect(screen.getAllByTestId("media-tile")).toHaveLength(2);
    expect(screen.getByText(/Alt text is written per language \(en, id; default en\)/)).toBeTruthy();
  });

  it("ok and empty: the library says it is empty (a real answer)", async () => {
    mediaMock.mockResolvedValue({ kind: "ok", data: { assets: [], page: { cursor: null, hasMore: false, limit: 48 } } });
    await mount();
    expect(screen.getByTestId("media-empty").textContent).toContain("library is empty");
  });

  it("unavailable: a full-page notice, no grid, no 'empty'", async () => {
    mediaMock.mockResolvedValue({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" });
    await mount();
    expect(screen.getByTestId("wd-editorial-unavailable").textContent).toContain("Editing is unavailable");
    expect(screen.queryByTestId("media-library")).toBeNull();
    expect(screen.queryByTestId("media-empty")).toBeNull();
  });

  it("forbidden and drift are refusals too; a site that is not this company's is not found", async () => {
    mediaMock.mockResolvedValue({ kind: "forbidden", reason: "no" });
    const first = await mount();
    expect(screen.queryByTestId("media-library")).toBeNull();
    first.unmount();
    mediaMock.mockResolvedValue({ kind: "unavailable", code: "contract_drift", reason: "media.assets: expected array" });
    const second = await mount();
    expect(screen.getByTestId("wd-contract-drift")).toBeTruthy();
    second.unmount();
    sitesMock.mockResolvedValue({ kind: "ok", data: { tenants: [] } });
    mediaMock.mockResolvedValue({ kind: "ok", data: { assets: [], page: { cursor: null, hasMore: false, limit: 48 } } });
    await mount();
    expect(screen.queryByTestId("media-library")).toBeNull();
    expect(screen.getByText(/does not exist or is not one of your company's/)).toBeTruthy();
  });

  it("the sites read failing is a refusal, never an empty library", async () => {
    sitesMock.mockResolvedValue({ kind: "unavailable", code: "editorial_unavailable", reason: "webdesk_unreachable" });
    mediaMock.mockResolvedValue({ kind: "ok", data: { assets: [], page: { cursor: null, hasMore: false, limit: 48 } } });
    await mount();
    expect(screen.getByTestId("wd-editorial-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("media-library")).toBeNull();
  });
});
