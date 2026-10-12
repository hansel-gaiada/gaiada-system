import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

// The Writers' room calendar page: the site (company wall), then the calendar read for the grid's window. A failed read, or a part the BFF could
// not read, is a notice and never an empty calendar.

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/webdeskContent", () => ({ listSites: vi.fn(), resolveAuthorNames: vi.fn() }));
vi.mock("@/lib/webdeskCalendar", () => ({ getEditorialCalendar: vi.fn() }));
vi.mock("@/components/webdesk/content/serverCtx", () => ({ requireWebsiteCtx: vi.fn() }));

import { listSites, resolveAuthorNames } from "@/lib/webdeskContent";
import { getEditorialCalendar } from "@/lib/webdeskCalendar";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import Page from "./page";

const sitesMock = vi.mocked(listSites);
const namesMock = vi.mocked(resolveAuthorNames);
const calMock = vi.mocked(getEditorialCalendar);
const ctxMock = vi.mocked(requireWebsiteCtx);

const sites = () => ({ kind: "ok" as const, data: { tenants: [{ slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en", "id"], sites: [{ siteId: "site-1", name: "gaiada.com", kind: "static", environments: [] }] }] } });
const entry = (over: Record<string, unknown> = {}) => ({
  itemId: "i1", collectionKey: "post", locale: "en", slug: "villa", title: "Villa", headVersion: 2, publishState: "draft", publishAt: null, unpublishAt: null,
  reviewState: "draft", reviewRequired: true, inFlow: true, authorSub: "u1", dueAt: "2026-10-10T00:00:00.000Z", plannedPublishAt: null, submittedVersion: null, approvedVersion: null,
  openComments: 0, briefRef: null, brief: null, briefHidden: false, requests: [], placement: { kind: "due", at: "2026-10-10T00:00:00.000Z" }, ...over,
});
const cal = (over: Record<string, unknown> = {}) => ({
  kind: "ok" as const,
  data: { tenantSlug: "gaiada", siteId: "site-1", from: "2026-09-28", to: "2026-11-01", truncated: false, entries: [entry()], policies: [], counts: { draft: 1, in_review: 0, changes_requested: 0, approved: 0 }, countsWithheld: false, ...over },
});
const mount = async (search: Record<string, string> = {}) => render(await Page({ params: Promise.resolve({ deptId: "dept-1", tenant: "gaiada", site: "site-1" }), searchParams: Promise.resolve(search) }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T10:00:00.000Z"));
  ctxMock.mockReset(); sitesMock.mockReset(); namesMock.mockReset(); calMock.mockReset();
  ctxMock.mockResolvedValue({ userId: "u", me: {}, company: "co-1", deptId: "dept-1", contentBase: "/departments/dept-1/website/content", writersBase: "/departments/dept-1/website/writers" } as never);
  sitesMock.mockResolvedValue(sites() as never);
  namesMock.mockResolvedValue({ u1: "Ayu" });
});
afterEach(() => vi.useRealTimers());

describe("Website -> Writers' room -> Calendar -> site", () => {
  it("asks for the writers tab and reads the month window of today (UTC), in the month view by default", async () => {
    calMock.mockResolvedValue(cal() as never);
    await mount();
    expect(ctxMock).toHaveBeenCalledWith("dept-1", "writers");
    expect(calMock).toHaveBeenCalledWith("u", "co-1", "gaiada", "site-1", { from: "2026-09-28", to: "2026-11-01" });
    expect(screen.getByTestId("calendar-title").textContent).toBe("October 2026");
    expect(within(screen.getByTestId("day-2026-10-10")).getByRole("link", { name: "Villa" }).getAttribute("href")).toBe("/departments/dept-1/website/content/gaiada/site-1/post/villa?locale=en");
  });

  it("the week view and the day come from the URL; filters are forwarded, 'me' as the caller's id", async () => {
    calMock.mockResolvedValue(cal({ entries: [] }) as never);
    await mount({ view: "week", day: "2026-10-21", collection: "post", locale: "id", assignee: "me" });
    expect(calMock).toHaveBeenCalledWith("u", "co-1", "gaiada", "site-1", { from: "2026-10-19", to: "2026-10-25", collection: "post", locale: "id", authorSub: "u" });
    expect(screen.getByTestId("calendar-grid").getAttribute("data-view")).toBe("week");
  });

  it("a nonsense view or day falls back to this month; it never errors", async () => {
    calMock.mockResolvedValue(cal() as never);
    await mount({ view: "year", day: "2026-13-45" });
    expect(calMock.mock.calls[0][4]).toMatchObject({ from: "2026-09-28", to: "2026-11-01" });
  });

  it("links the board, the brief and the unscheduled list", async () => {
    calMock.mockResolvedValue(cal({ entries: [entry({ briefRef: "b1", brief: { id: "b1", topic: "Villa guide", status: "draft", assigneeId: "u1" } }), entry({ itemId: "i2", slug: "undated", title: "Undated", placement: null, dueAt: null })] }) as never);
    await mount();
    expect(screen.getByTestId("tab-board").getAttribute("href")).toBe("/departments/dept-1/website/writers/gaiada/site-1");
    expect(screen.getByTestId("entry-brief").getAttribute("href")).toBe("/departments/dept-1/website/writers/briefs/gaiada/site-1/b1");
    expect(within(screen.getByTestId("unscheduled-list")).getByRole("link", { name: "Undated" })).toBeTruthy();
  });

  it("forbidden is a refusal notice, not an empty calendar", async () => {
    calMock.mockResolvedValue({ kind: "forbidden", reason: "no" } as never);
    await mount();
    expect(screen.queryByTestId("writers-calendar")).toBeNull();
    expect(screen.queryByTestId("calendar-empty")).toBeNull();
  });

  it("a 503 that names a part says which part could not be read, and draws no calendar", async () => {
    calMock.mockResolvedValue({ kind: "unavailable", code: "editorial_unavailable", reason: "scheduled_unreadable" } as never);
    await mount();
    expect(screen.getByTestId("calendar-part-unreadable").textContent).toMatch(/scheduled publish dates/);
    expect(screen.queryByTestId("writers-calendar")).toBeNull();
  });

  it("contract drift is the loud notice", async () => {
    calMock.mockResolvedValue({ kind: "unavailable", code: "contract_drift", reason: "calendar.entries: expected array" } as never);
    await mount();
    expect(screen.getByTestId("wd-contract-drift")).toBeTruthy();
  });

  it("a site that is not this company's, or a failed site read, reads no calendar", async () => {
    sitesMock.mockResolvedValue({ kind: "ok", data: { tenants: [] } } as never);
    await mount();
    sitesMock.mockResolvedValue({ kind: "forbidden", reason: "no" } as never);
    await mount();
    expect(calMock).not.toHaveBeenCalled();
  });
});
