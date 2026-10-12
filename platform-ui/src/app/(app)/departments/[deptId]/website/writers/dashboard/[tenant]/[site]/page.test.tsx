import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// The writer dashboard page: the site (company wall), then the dashboard. A refusal is a notice and never an empty dashboard; a failed
// collection list only costs the filter its extra options.

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/webdeskContent", () => ({ listSites: vi.fn(), listCollections: vi.fn() }));
vi.mock("@/lib/webdeskDashboard", () => ({ getWritersDashboard: vi.fn() }));
vi.mock("@/components/webdesk/content/serverCtx", () => ({ requireWebsiteCtx: vi.fn() }));

import { listCollections, listSites } from "@/lib/webdeskContent";
import { getWritersDashboard } from "@/lib/webdeskDashboard";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import Page from "./page";

const sitesMock = vi.mocked(listSites);
const colsMock = vi.mocked(listCollections);
const dashMock = vi.mocked(getWritersDashboard);
const ctxMock = vi.mocked(requireWebsiteCtx);

const sites = () => ({ kind: "ok" as const, data: { tenants: [{ slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en", "id"], sites: [{ siteId: "site-1", name: "gaiada.com", kind: "static", environments: [] }] }] } });
const ok = (value: unknown) => ({ value, reason: null });
const dash = (over: Record<string, unknown> = {}) => ({
  kind: "ok" as const,
  data: {
    tenantSlug: "gaiada", siteId: "site-1", period: { key: "28d", days: 28 },
    windows: { traffic: { current: { from: "2026-09-15", to: "2026-10-12" }, previous: { from: "2026-08-18", to: "2026-09-14" } }, search: { current: { from: "2026-09-12", to: "2026-10-09" }, previous: { from: "2026-08-15", to: "2026-09-11" } } },
    scope: "all_site", sources: { umami: { state: "ok" }, search: { state: "ok" }, leads: { state: "ok" }, decay: { state: "ok" } },
    items: [{
      itemId: "i1", collectionKey: "post", locale: "en", slug: "hello", title: "Hello", publishedVersion: 2, mine: true, pagePath: "/blog/hello/", pagePathReason: null,
      metrics: {
        views: ok({ current: 120, previous: 60, trend: "up" }), avgSeconds: ok({ seconds: 90 }), clicks: ok({ current: 3, previous: 2, trend: "up" }),
        impressions: ok({ current: 90, previous: 80, trend: "up" }), topQueries: ok([]), leads: ok({ current: 1, previous: 0, trend: "up" }),
      },
      decay: ok("none"),
    }],
    page: { cursor: null, hasMore: false, limit: 25 }, ...over,
  },
});
const mount = async (search: Record<string, string> = {}) => render(await Page({ params: Promise.resolve({ deptId: "dept-1", tenant: "gaiada", site: "site-1" }), searchParams: Promise.resolve(search) }));

beforeEach(() => {
  ctxMock.mockReset(); sitesMock.mockReset(); colsMock.mockReset(); dashMock.mockReset();
  ctxMock.mockResolvedValue({ userId: "u", me: {}, company: "co-1", deptId: "dept-1", contentBase: "/departments/dept-1/website/content", writersBase: "/departments/dept-1/website/writers" } as never);
  sitesMock.mockResolvedValue(sites() as never);
  colsMock.mockResolvedValue({ kind: "ok", data: [{ key: "post" }, { key: "page" }] } as never);
});

describe("Website -> Writers' room -> Dashboard -> site", () => {
  it("asks for the writers tab context and reads the dashboard for the site, forwarding the filters (an unknown period is dropped)", async () => {
    dashMock.mockResolvedValue(dash() as never);
    await mount({ period: "7d", collection: "post", locale: "id", mine: "true", cursor: "c1" });
    expect(ctxMock).toHaveBeenCalledWith("dept-1", "writers");
    expect(dashMock).toHaveBeenCalledWith("u", "co-1", "gaiada", "site-1", { period: "7d", collection: "post", locale: "id", mine: true, cursor: "c1" });
    cleanup();
    dashMock.mockClear();
    await mount({ period: "1y" });
    expect(dashMock.mock.calls[0][4]).toMatchObject({ period: undefined, mine: false });
  });

  it("draws the dashboard with the site's collections and languages in the filters", async () => {
    dashMock.mockResolvedValue(dash() as never);
    await mount();
    expect(screen.getByTestId("writers-dashboard")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Hello" }).getAttribute("href")).toBe("/departments/dept-1/website/content/gaiada/site-1/post/hello?locale=en");
    const col = screen.getByLabelText("Collection") as HTMLSelectElement;
    expect(Array.from(col.options).map((o) => o.value)).toEqual(["", "page", "post"]);
    expect(Array.from((screen.getByLabelText("Language") as HTMLSelectElement).options).map((o) => o.value)).toEqual(["", "en", "id"]);
  });

  it("a failed collection list costs the filter its extra options and nothing else", async () => {
    dashMock.mockResolvedValue(dash() as never);
    colsMock.mockResolvedValue({ kind: "forbidden", reason: "no" } as never);
    await mount();
    expect(screen.getByTestId("writers-dashboard")).toBeTruthy();
    expect(Array.from((screen.getByLabelText("Collection") as HTMLSelectElement).options).map((o) => o.value)).toEqual(["", "post"]);
  });

  it("an unknown site is 'not found', not an empty dashboard", async () => {
    render(await Page({ params: Promise.resolve({ deptId: "dept-1", tenant: "gaiada", site: "elsewhere" }), searchParams: Promise.resolve({}) }));
    expect(dashMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("writers-dashboard")).toBeNull();
  });

  it("forbidden is a refusal notice, not an empty dashboard", async () => {
    dashMock.mockResolvedValue({ kind: "forbidden", reason: "no" } as never);
    await mount();
    expect(screen.queryByTestId("writers-dashboard")).toBeNull();
    expect(screen.queryByText("There are no published articles to show yet.")).toBeNull();
  });

  it("contract drift is the loud notice", async () => {
    dashMock.mockResolvedValue({ kind: "unavailable", code: "contract_drift", reason: "dashboard.items[0].metrics.clicks: a value or a reason" } as never);
    await mount();
    expect(screen.getByTestId("wd-contract-drift")).toBeTruthy();
    expect(screen.queryByTestId("writers-dashboard")).toBeNull();
  });

  it("WebDesk unavailable is the full-page notice", async () => {
    dashMock.mockResolvedValue({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" } as never);
    await mount();
    expect(screen.getByTestId("wd-editorial-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("writers-dashboard")).toBeNull();
  });
});
