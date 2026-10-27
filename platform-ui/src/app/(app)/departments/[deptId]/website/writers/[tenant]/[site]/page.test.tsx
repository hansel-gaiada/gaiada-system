import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// The Writers' room board page: the site (company wall), then the workflow board from the calendar read. A refusal, or a part the BFF could not
// read, is a notice and never an empty board; withheld counts are words and never zeros.
// M5-W1q2 added the link to the uploads desk: it is drawn ONLY where the BFF lets the caller read the review queue (its own Cerbos `review` answer), never from a
// role name; a 403 or any other refusal of that read draws no link, and the board itself is unaffected either way.

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/webdeskContent", () => ({ listSites: vi.fn(), resolveAuthorNames: vi.fn() }));
vi.mock("@/lib/webdeskCalendar", () => ({ getEditorialCalendar: vi.fn() }));
vi.mock("@/lib/webdeskMediaReview", () => ({ listQuarantine: vi.fn() }));
vi.mock("@/components/webdesk/content/serverCtx", () => ({ requireWebsiteCtx: vi.fn() }));

import { listSites, resolveAuthorNames } from "@/lib/webdeskContent";
import { getEditorialCalendar } from "@/lib/webdeskCalendar";
import { listQuarantine } from "@/lib/webdeskMediaReview";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import Page from "./page";

const sitesMock = vi.mocked(listSites);
const namesMock = vi.mocked(resolveAuthorNames);
const calMock = vi.mocked(getEditorialCalendar);
const queueMock = vi.mocked(listQuarantine);
const ctxMock = vi.mocked(requireWebsiteCtx);

const sites = () => ({ kind: "ok" as const, data: { tenants: [{ slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en", "id"], sites: [{ siteId: "site-1", name: "gaiada.com", kind: "static", environments: [] }] }] } });
const entry = (over: Record<string, unknown> = {}) => ({
  itemId: "i1", collectionKey: "service", locale: "en", slug: "service.seo", title: "SEO", headVersion: 2, publishState: "draft", publishAt: null, unpublishAt: null,
  reviewState: "in_review", reviewRequired: true, inFlow: true, authorSub: "u1", dueAt: null, plannedPublishAt: null, submittedVersion: 2, approvedVersion: null, openComments: 0,
  briefRef: null, brief: null, briefHidden: false, requests: [], placement: null, ...over,
});
const cal = (over: Record<string, unknown> = {}) => ({
  kind: "ok" as const,
  data: {
    tenantSlug: "gaiada", siteId: "site-1", from: null, to: null, truncated: false, entries: [entry()],
    policies: [{ collectionKey: "service", reviewRequired: true, seoSignoffRequired: false }],
    counts: { draft: 0, in_review: 1, changes_requested: 0, approved: 0 }, countsWithheld: false, ...over,
  },
});
const mount = async (search: Record<string, string> = {}) => render(await Page({ params: Promise.resolve({ deptId: "dept-1", tenant: "gaiada", site: "site-1" }), searchParams: Promise.resolve(search) }));

beforeEach(() => {
  ctxMock.mockReset(); sitesMock.mockReset(); namesMock.mockReset(); calMock.mockReset(); queueMock.mockReset();
  ctxMock.mockResolvedValue({ userId: "u", me: {}, company: "co-1", deptId: "dept-1", contentBase: "/departments/dept-1/website/content", writersBase: "/departments/dept-1/website/writers" } as never);
  sitesMock.mockResolvedValue(sites() as never);
  namesMock.mockResolvedValue({ u1: "Ayu" });
  queueMock.mockResolvedValue({ kind: "forbidden", reason: "forbidden" } as never); // the default caller may not review: no link unless a test says otherwise
});
afterEach(cleanup);

describe("Website -> Writers' room -> site", () => {
  it("asks for the writers tab context and reads the calendar with no window, forwarding the filters ('me' is the caller's own id)", async () => {
    calMock.mockResolvedValue(cal() as never);
    await mount({ state: "in_review", collection: "service", locale: "en", assignee: "me" });
    expect(ctxMock).toHaveBeenCalledWith("dept-1", "writers");
    expect(calMock).toHaveBeenCalledWith("u", "co-1", "gaiada", "site-1", { collection: "service", locale: "en", authorSub: "u" });
  });

  it("draws the board with the tabs, and links into the content editor, the brief and the people page", async () => {
    calMock.mockResolvedValue(cal({ entries: [entry({ briefRef: "b1", brief: { id: "b1", topic: "Villa", status: "draft", assigneeId: "u1" } })] }) as never);
    await mount();
    expect(screen.getByTestId("writers-board")).toBeTruthy();
    expect(screen.getByRole("link", { name: "SEO" }).getAttribute("href")).toBe("/departments/dept-1/website/content/gaiada/site-1/service/service.seo?locale=en");
    expect(screen.getByTestId("card-brief").getAttribute("href")).toBe("/departments/dept-1/website/writers/briefs/gaiada/site-1/b1");
    expect(screen.getByTestId("people-link").getAttribute("href")).toBe("/departments/dept-1/website/writers/people/gaiada/site-1");
    expect(screen.getByTestId("tab-calendar").getAttribute("href")).toBe("/departments/dept-1/website/writers/calendar/gaiada/site-1");
  });

  it("a scheduled item of a review-off collection is on the calendar but not on the board", async () => {
    calMock.mockResolvedValue(cal({ entries: [entry(), entry({ itemId: "i2", slug: "page.home", title: "Home", inFlow: false, publishState: "scheduled" })] }) as never);
    await mount();
    expect(screen.queryByRole("link", { name: "Home" })).toBeNull();
    expect(screen.getAllByTestId("board-card")).toHaveLength(1);
  });

  it("the state filter narrows the board", async () => {
    calMock.mockResolvedValue(cal({ entries: [entry(), entry({ itemId: "i2", slug: "s2", title: "Other", reviewState: "approved" })] }) as never);
    await mount({ state: "approved" });
    expect(screen.queryByRole("link", { name: "SEO" })).toBeNull();
    expect(screen.getByRole("link", { name: "Other" })).toBeTruthy();
  });

  it("withheld counts are said in words, with no zeros", async () => {
    const b = cal({ counts: null, countsWithheld: true });
    delete (b.data as Record<string, unknown>).counts;
    calMock.mockResolvedValue({ ...b, data: { ...b.data, counts: null } } as never);
    await mount();
    expect(screen.getByTestId("counts-withheld").textContent).toMatch(/Counts are hidden for your access/);
    expect(screen.queryByTestId("board-counts")).toBeNull();
  });

  it("forbidden is a refusal notice, not an empty board", async () => {
    calMock.mockResolvedValue({ kind: "forbidden", reason: "no" } as never);
    await mount();
    expect(screen.queryByTestId("writers-board")).toBeNull();
    expect(screen.queryByText("No items are in the review flow yet.")).toBeNull();
  });

  it("a part the BFF could not read is named, and no board is drawn", async () => {
    calMock.mockResolvedValue({ kind: "unavailable", code: "editorial_unavailable", reason: "briefs_unreadable" } as never);
    await mount();
    expect(screen.getByTestId("calendar-part-unreadable").textContent).toMatch(/briefs/);
    expect(screen.queryByTestId("writers-board")).toBeNull();
  });

  it("contract drift is the loud notice", async () => {
    calMock.mockResolvedValue({ kind: "unavailable", code: "contract_drift", reason: "calendar.entries: expected array" } as never);
    await mount();
    expect(screen.getByTestId("wd-contract-drift")).toBeTruthy();
    expect(screen.queryByTestId("writers-board")).toBeNull();
  });

  it("WebDesk unavailable is the full-page notice", async () => {
    calMock.mockResolvedValue({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" } as never);
    await mount();
    expect(screen.getByTestId("wd-editorial-unavailable")).toBeTruthy();
  });

  it("a site that is not this company's reads no board", async () => {
    sitesMock.mockResolvedValue({ kind: "ok", data: { tenants: [] } } as never);
    await mount();
    expect(calMock).not.toHaveBeenCalled();
  });

  it("a failed site read is a refusal and reads no board", async () => {
    sitesMock.mockResolvedValue({ kind: "forbidden", reason: "no" } as never);
    await mount();
    expect(calMock).not.toHaveBeenCalled();
  });
});

const queue = (n: number, hasMore = false) => ({
  kind: "ok" as const,
  data: { assets: Array.from({ length: n }, (_, i) => ({ asset: { assetId: `a${i}` }, reviewState: "quarantined", allowedReview: true })), page: { cursor: null, hasMore, limit: 50 } },
});
const linkText = () => screen.getByTestId("uploads-link").textContent?.replace(/\s+/g, " ").trim();

describe("Website -> Writers' room -> site: the link to the uploads desk (M5-W1q2)", () => {
  it("a caller whose queue read succeeds sees the link, to this site's uploads desk, with the number held; the queue read is for THIS site", async () => {
    calMock.mockResolvedValue(cal() as never);
    queueMock.mockResolvedValue(queue(3) as never);
    await mount();
    expect(queueMock).toHaveBeenCalledWith("u", "co-1", "gaiada", "site-1");
    expect(screen.getByTestId("uploads-link").getAttribute("href")).toBe("/departments/dept-1/website/writers/uploads/gaiada/site-1");
    expect(linkText()).toBe("Uploads awaiting review (3)");
  });

  it("more than one page of uploads says so with a '+'; an empty queue is still a link (a real answer: the desk says nothing is waiting)", async () => {
    calMock.mockResolvedValue(cal() as never);
    queueMock.mockResolvedValue(queue(50, true) as never);
    await mount();
    expect(linkText()).toBe("Uploads awaiting review (50+)");
    cleanup();
    queueMock.mockResolvedValue(queue(0) as never);
    await mount();
    expect(linkText()).toBe("Uploads awaiting review (0)");
  });

  it("a caller the BFF refuses (403: may not review) gets NO link, and the board is still drawn", async () => {
    calMock.mockResolvedValue(cal() as never);
    queueMock.mockResolvedValue({ kind: "forbidden", reason: "forbidden" } as never);
    await mount();
    expect(screen.queryByTestId("uploads-link")).toBeNull();
    expect(screen.getByTestId("writers-board")).toBeTruthy();
    expect(screen.getByTestId("people-link")).toBeTruthy(); // the neighbouring links are unaffected
  });

  it("any other failure of the queue read (the service is down, drift, not found) also draws no link, and never breaks the board", async () => {
    calMock.mockResolvedValue(cal() as never);
    for (const r of [{ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" }, { kind: "unavailable", code: "contract_drift", reason: "x" }, { kind: "not_found", slug: "site-not-found" }]) {
      queueMock.mockResolvedValue(r as never);
      await mount();
      expect(screen.queryByTestId("uploads-link")).toBeNull();
      expect(screen.getByTestId("writers-board")).toBeTruthy();
      cleanup();
    }
  });

  it("a board that could not be read draws no board and so no link, whatever the queue says", async () => {
    calMock.mockResolvedValue({ kind: "forbidden", reason: "no" } as never);
    queueMock.mockResolvedValue(queue(2) as never);
    await mount();
    expect(screen.queryByTestId("writers-board")).toBeNull();
    expect(screen.queryByTestId("uploads-link")).toBeNull();
  });
});
