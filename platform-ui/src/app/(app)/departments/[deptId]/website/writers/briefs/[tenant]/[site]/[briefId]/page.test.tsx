import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/webdeskContent", () => ({ listSites: vi.fn(), resolveAuthorNames: vi.fn() }));
vi.mock("@/lib/webdeskCalendar", () => ({ getBrief: vi.fn() }));
vi.mock("@/components/webdesk/content/serverCtx", () => ({ requireWebsiteCtx: vi.fn() }));

import { listSites, resolveAuthorNames } from "@/lib/webdeskContent";
import { getBrief } from "@/lib/webdeskCalendar";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import Page from "./page";

const sitesMock = vi.mocked(listSites);
const namesMock = vi.mocked(resolveAuthorNames);
const briefMock = vi.mocked(getBrief);
const ctxMock = vi.mocked(requireWebsiteCtx);

const sites = () => ({ kind: "ok" as const, data: { tenants: [{ slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en"], sites: [{ siteId: "site-1", name: "gaiada.com", kind: "static", environments: [] }] }] } });
const brief = { id: "b1", status: "draft", topic: "Villa guide", targetQuery: "villa bali", searchIntent: "commercial", aiQuestions: [], contentGaps: [], outline: ["Intro"], body: "", geoNotes: null, collectionKey: "post", locale: "en", itemId: "i1", assigneeId: "u1", updatedAt: "2026-10-12T00:00:00.000Z" };
const mount = async () => render(await Page({ params: Promise.resolve({ deptId: "dept-1", tenant: "gaiada", site: "site-1", briefId: "b1" }) }));

beforeEach(() => {
  ctxMock.mockReset(); sitesMock.mockReset(); namesMock.mockReset(); briefMock.mockReset();
  ctxMock.mockResolvedValue({ userId: "u", me: {}, company: "co-1", deptId: "dept-1", contentBase: "/c", writersBase: "/departments/dept-1/website/writers" } as never);
  sitesMock.mockResolvedValue(sites() as never);
  namesMock.mockResolvedValue({ u1: "Ayu" });
});

describe("Website -> Writers' room -> a brief", () => {
  it("reads the brief for the site and draws it with links back to the board and the calendar", async () => {
    briefMock.mockResolvedValue({ kind: "ok", data: brief } as never);
    await mount();
    expect(briefMock).toHaveBeenCalledWith("u", "co-1", "gaiada", "site-1", "b1");
    expect(screen.getByTestId("brief-view")).toBeTruthy();
    expect(screen.getByText("villa bali")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Board" }).getAttribute("href")).toBe("/departments/dept-1/website/writers/gaiada/site-1");
    expect(screen.getByRole("link", { name: "Calendar" }).getAttribute("href")).toBe("/departments/dept-1/website/writers/calendar/gaiada/site-1");
  });
  it("the BFF's plain 404 (unknown, another site's, or not yours) is 'not found or not yours', not 'not served'", async () => {
    briefMock.mockResolvedValue({ kind: "not_enabled", reason: "not_served" } as never);
    await mount();
    expect(screen.getByText(/doesn.t exist on this site, or you can.t read it/)).toBeTruthy();
    expect(screen.queryByTestId("brief-view")).toBeNull();
  });
  it("forbidden and unavailable are refusals, never an empty brief", async () => {
    briefMock.mockResolvedValue({ kind: "forbidden", reason: "no" } as never);
    await mount();
    expect(screen.queryByTestId("brief-view")).toBeNull();
    briefMock.mockResolvedValue({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" } as never);
    await mount();
    expect(screen.getByTestId("wd-editorial-unavailable")).toBeTruthy();
  });
  it("a site that is not this company's reads no brief", async () => {
    sitesMock.mockResolvedValue({ kind: "ok", data: { tenants: [] } } as never);
    await mount();
    expect(briefMock).not.toHaveBeenCalled();
  });
});
