import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// The Writers' room board page: the site (company wall), then the board. A refusal is a notice and never an empty board; withheld
// counts are words and never zeros.

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/webdeskContent", () => ({ listSites: vi.fn(), resolveAuthorNames: vi.fn() }));
vi.mock("@/lib/webdeskEditorial", () => ({ getEditorialBoard: vi.fn() }));
vi.mock("@/components/webdesk/content/serverCtx", () => ({ requireWebsiteCtx: vi.fn() }));

import { listSites, resolveAuthorNames } from "@/lib/webdeskContent";
import { getEditorialBoard } from "@/lib/webdeskEditorial";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import Page from "./page";

const sitesMock = vi.mocked(listSites);
const namesMock = vi.mocked(resolveAuthorNames);
const boardMock = vi.mocked(getEditorialBoard);
const ctxMock = vi.mocked(requireWebsiteCtx);

const sites = () => ({ kind: "ok" as const, data: { tenants: [{ slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en"], sites: [{ siteId: "site-1", name: "gaiada.com", kind: "static", environments: [] }] }] } });
const ed = (state: string) => ({ reviewRequired: true, state, approvedVersion: null, authorSub: "u1", openComments: 0 });
const board = (over: Record<string, unknown> = {}) => ({
  kind: "ok" as const,
  data: {
    items: [{ itemId: "i1", collectionKey: "service", locale: "en", slug: "service.seo", title: "SEO", headVersion: 2, publishState: "draft", editorial: ed("in_review") }],
    counts: { draft: 0, in_review: 1, changes_requested: 0, approved: 0 }, countsWithheld: false,
    policies: [{ collectionKey: "service", reviewRequired: true, seoSignoffRequired: false }], page: { cursor: null, hasMore: false, limit: 100 }, ...over,
  },
});
const mount = async (search: Record<string, string> = {}) => render(await Page({ params: Promise.resolve({ deptId: "dept-1", tenant: "gaiada", site: "site-1" }), searchParams: Promise.resolve(search) }));

beforeEach(() => {
  ctxMock.mockReset(); sitesMock.mockReset(); namesMock.mockReset(); boardMock.mockReset();
  ctxMock.mockResolvedValue({ userId: "u", me: {}, company: "co-1", deptId: "dept-1", contentBase: "/departments/dept-1/website/content", writersBase: "/departments/dept-1/website/writers" } as never);
  sitesMock.mockResolvedValue(sites() as never);
  namesMock.mockResolvedValue({ u1: "Ayu" });
});

describe("Website -> Writers' room -> site", () => {
  it("asks for the writers tab context, reads the board for the site, and forwards the filters", async () => {
    boardMock.mockResolvedValue(board() as never);
    await mount({ state: "in_review", collection: "service", cursor: "c1" });
    expect(ctxMock).toHaveBeenCalledWith("dept-1", "writers");
    expect(boardMock).toHaveBeenCalledWith("u", "co-1", "gaiada", "site-1", { state: "in_review", collection: "service", cursor: "c1" });
  });

  it("draws the board and links into the content editor and to the people page", async () => {
    boardMock.mockResolvedValue(board() as never);
    await mount();
    expect(screen.getByTestId("writers-board")).toBeTruthy();
    expect(screen.getByRole("link", { name: "SEO" }).getAttribute("href")).toBe("/departments/dept-1/website/content/gaiada/site-1/service/service.seo?locale=en");
    expect(screen.getByTestId("people-link").getAttribute("href")).toBe("/departments/dept-1/website/writers/people/gaiada/site-1");
  });

  it("withheld counts are said in words, with no zeros", async () => {
    const b = board({ counts: null, countsWithheld: true });
    boardMock.mockResolvedValue(b as never);
    await mount();
    expect(screen.getByTestId("counts-withheld").textContent).toMatch(/Counts are hidden for your access/);
    expect(screen.queryByTestId("board-counts")).toBeNull();
  });

  it("forbidden is a refusal notice, not an empty board", async () => {
    boardMock.mockResolvedValue({ kind: "forbidden", reason: "no" } as never);
    await mount();
    expect(screen.queryByTestId("writers-board")).toBeNull();
    expect(screen.queryByText("No items are in the review flow yet.")).toBeNull();
  });

  it("contract drift is the loud notice", async () => {
    boardMock.mockResolvedValue({ kind: "unavailable", code: "contract_drift", reason: "board.counts: expected object" } as never);
    await mount();
    expect(screen.getByTestId("wd-contract-drift")).toBeTruthy();
    expect(screen.queryByTestId("writers-board")).toBeNull();
  });

  it("WebDesk unavailable is the full-page notice", async () => {
    boardMock.mockResolvedValue({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" } as never);
    await mount();
    expect(screen.getByTestId("wd-editorial-unavailable")).toBeTruthy();
  });

  it("a site that is not this company's reads no board", async () => {
    sitesMock.mockResolvedValue({ kind: "ok", data: { tenants: [] } } as never);
    await mount();
    expect(boardMock).not.toHaveBeenCalled();
  });

  it("a failed site read is a refusal and reads no board", async () => {
    sitesMock.mockResolvedValue({ kind: "forbidden", reason: "no" } as never);
    await mount();
    expect(boardMock).not.toHaveBeenCalled();
  });
});
