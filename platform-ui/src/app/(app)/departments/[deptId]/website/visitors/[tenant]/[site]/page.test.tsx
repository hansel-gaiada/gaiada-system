import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

// The Visitors tab's list page: site -> property -> status + list. Server order is kept, every non-ok state is words, an empty list is
// a claim only about a working pipeline, and the page asks for the Visitors tab context (which 404s without the toolkit or read_visitors).

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/visitors", () => ({ resolveSiteProperty: vi.fn(), readOverview: vi.fn() }));
vi.mock("@/components/webdesk/content/serverCtx", () => ({ requireWebsiteCtx: vi.fn() }));

import { readOverview, resolveSiteProperty } from "@/lib/visitors";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import Page from "./page";

const ctxMock = vi.mocked(requireWebsiteCtx);
const siteMock = vi.mocked(resolveSiteProperty);
const overviewMock = vi.mocked(readOverview);

const A = "0194a3b2-1111-7000-8000-000000000001";
const B = "ffff0000-2222-7000-8000-000000000002";
const C = "abcd1234-3333-7000-8000-000000000003";
const row = (id: string, o: Record<string, unknown> = {}) => ({
  visitorId: id, firstSeenAt: "2026-10-01T08:00:00.000Z", lastSeenAt: "2026-10-12T09:30:00.000Z", visits: 4, pageviews: 11, device: "desktop",
  country: "ID", city: "Denpasar", network: { kind: "network", name: "Telkom", domain: null, confidence: null, source: null }, company: null,
  interests: { industry: [{ tag: "hospitality", score: 8 }], service: [{ tag: "web-design", score: 5 }] }, score: 61, lead: { state: "none" }, ...o,
});
const okStatus = { state: "ok" as const, data: { state: "ok" as const, message: null, configured: true, enabled: true, lastOkIngestAt: "2026-10-13T00:30:00.000Z", lastRunAt: null, lastOutcome: null, bots: { from: "a", to: "b", days: 30, total: 5, byReason: {} } } };
const nonOk = (state: "not_configured" | "disabled" | "no_website" | "unreachable" | "rejected", message: string) => ({
  state: "ok" as const, data: { state, message, configured: false, enabled: false, lastOkIngestAt: null, lastRunAt: "2026-10-12T00:00:00.000Z", lastOutcome: "last run failed", bots: null },
});
const list = (visitors: unknown[], nextCursor: string | null = null) => ({ state: "ok" as const, data: { propertyId: "p1", visitors, nextCursor } });

const mount = async (search: Record<string, string> = {}) =>
  render(await Page({ params: Promise.resolve({ deptId: "dept-1", tenant: "gaiada", site: "site-1" }), searchParams: Promise.resolve(search) }));

beforeEach(() => {
  ctxMock.mockReset(); siteMock.mockReset(); overviewMock.mockReset();
  ctxMock.mockResolvedValue({ userId: "u", me: {}, company: "co-1", deptId: "dept-1", visitorsBase: "/departments/dept-1/website/visitors" } as never);
  siteMock.mockResolvedValue({ kind: "ok", siteName: "gaiada.com", property: { id: "p1", domain: "gaiada.com", umamiSiteId: "u" } });
});

describe("Website -> Visitors -> site", () => {
  it("asks for the visitors tab context and shows the header line exactly", async () => {
    overviewMock.mockResolvedValue({ status: okStatus, list: list([row(A)]) } as never);
    await mount();
    expect(ctxMock).toHaveBeenCalledWith("dept-1", "visitors");
    expect(screen.getByTestId("visitors-header").textContent).toBe("Only visitors who accepted analytics. A score is a guide for follow-up, never a decision about a person.");
  });

  it("keeps the server's row order and shows each visitor by its 8-character id only", async () => {
    // Deliberately NOT sorted by score or id: the page must not re-sort.
    overviewMock.mockResolvedValue({ status: okStatus, list: list([row(B, { score: 5 }), row(A, { score: 90 }), row(C, { score: 40 })]) } as never);
    const { container } = await mount();
    const ids = screen.getAllByTestId("visitor-id").map((e) => e.textContent);
    expect(ids).toEqual(["ffff0000", "0194a3b2", "abcd1234"]);
    expect(ids.every((i) => i!.length === 8)).toBe(true);
    // The full id appears only inside a link, never as text.
    expect(container.textContent).not.toContain(A);
    expect(container.textContent).not.toContain("0194a3b2-1111");
    expect(screen.getAllByTestId("visitor-id")[1].getAttribute("href")).toBe(`/departments/dept-1/website/visitors/gaiada/site-1/${A}`);
  });

  it("draws the columns: last seen, visits, country and city, Network or Company, interests, score, lead", async () => {
    overviewMock.mockResolvedValue({ status: okStatus, list: list([
      row(A, { lead: { state: "linked" } }),
      row(B, { network: null, company: { kind: "company", name: "Acme Ltd", domain: "acme.test", confidence: "high", source: "x", version: null }, lead: { state: "none" } }),
    ]) } as never);
    await mount();
    const rows = screen.getAllByTestId("visitor-row");
    const first = within(rows[0]);
    expect(first.getByText("2026-10-12 09:30 UTC")).toBeTruthy();
    expect(first.getByText("Denpasar, ID")).toBeTruthy();
    expect(first.getByTestId("visitor-who").textContent).toBe("Network: Telkom");
    expect(first.getByText("hospitality")).toBeTruthy();
    expect(first.getByText("web-design")).toBeTruthy();
    expect(first.getByText("61")).toBeTruthy();
    expect(first.getByTestId("lead-linked")).toBeTruthy();
    expect(within(rows[1]).getByTestId("visitor-who").textContent).toBe("Company: Acme Ltd (high confidence)");
    expect(within(rows[1]).queryByTestId("lead-linked")).toBeNull();
    expect(screen.getByText(/The score only orders this list/)).toBeTruthy();
  });

  it("a list row never offers a lead link or id (only linked or none)", async () => {
    overviewMock.mockResolvedValue({ status: okStatus, list: list([row(A, { lead: { state: "linked" } })]) } as never);
    const { container } = await mount();
    expect(container.querySelector('a[href*="/agency/leads/"]')).toBeNull();
  });

  it.each([
    ["not_configured", "The visitor collector is not set up on this server yet (its address and keys are missing), so no visitor has been read."],
    ["disabled", "Visitor profiles are switched off on this server, so nothing is being collected into profiles."],
    ["no_website", "This property is not linked to a collector website yet, so no visitor can be read for it."],
    ["unreachable", "The visitor collector could not be reached just now."],
    ["rejected", "The visitor collector refused the ERP's key or does not know this website."],
  ] as const)("status %s is a notice in words, and an empty list is NOT called 'no visitors'", async (state, words) => {
    overviewMock.mockResolvedValue({ status: nonOk(state, words), list: list([]) } as never);
    const { container } = await mount();
    expect(screen.getByTestId(`visitors-status-${state}`).textContent).toContain(words);
    expect(screen.getByTestId("visitors-empty-not-ok").textContent).toContain("does not mean the site had no visitors");
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).not.toContain("No visitor who accepted analytics has been recorded");
    expect(container.textContent).not.toMatch(/\b0 visitors\b/);
  });

  it("stored profiles stay visible beside a non-ok status", async () => {
    overviewMock.mockResolvedValue({ status: nonOk("unreachable", "The visitor collector could not be reached just now."), list: list([row(A)]) } as never);
    await mount();
    expect(screen.getByTestId("visitors-status-unreachable")).toBeTruthy();
    expect(screen.getAllByTestId("visitor-row")).toHaveLength(1);
  });

  it("a status that could not be read is words, and so is a list that could not be read (no table, no zero)", async () => {
    overviewMock.mockResolvedValue({
      status: { state: "unavailable", message: "The visitor status could not be read. Try again in a moment." },
      list: { state: "unavailable", message: "The visitor list could not be read. Try again in a moment." },
    } as never);
    const { container } = await mount();
    expect(screen.getByTestId("visitors-status-unavailable").textContent).toContain("could not be read");
    expect(screen.getByTestId("visitors-list-unavailable").textContent).toContain("not an empty list");
    expect(container.querySelector("table")).toBeNull();
    expect(screen.queryByTestId("visitors-empty-not-ok")).toBeNull();
  });

  it("an empty list on a working pipeline says so, differently with and without filters", async () => {
    overviewMock.mockResolvedValue({ status: okStatus, list: list([]) } as never);
    await mount();
    expect(screen.getByText("No visitor who accepted analytics has been recorded for this site yet.")).toBeTruthy();
  });

  it("filters are passed through cleaned, an unusable one is named, and Next page keeps the filters", async () => {
    overviewMock.mockResolvedValue({ status: okStatus, list: list([row(A)], "CURSOR_1") } as never);
    await mount({ minScore: "40", order: "recent", tag: "Bad Tag" });
    expect(overviewMock).toHaveBeenCalledWith("u", "co-1", "p1", { minScore: "40", order: "recent" });
    expect(screen.getByTestId("visitors-ignored").textContent).toContain("interest tag");
    const next = screen.getByTestId("visitors-next").getAttribute("href")!;
    expect(next).toContain("cursor=CURSOR_1");
    expect(next).toContain("minScore=40");
    expect(next).toContain("order=recent");
  });

  it("links to the interest rules sub-page", async () => {
    overviewMock.mockResolvedValue({ status: okStatus, list: list([row(A)]) } as never);
    await mount();
    expect(screen.getByTestId("interest-rules-link").getAttribute("href")).toBe("/departments/dept-1/website/visitors/gaiada/site-1/interest-rules");
  });

  it("no search property for the site: a sentence, and no status or list reads", async () => {
    siteMock.mockResolvedValue({ kind: "no_property", siteName: "gaiada.com" });
    await mount();
    expect(screen.getByText(/No search property matches gaiada.com/)).toBeTruthy();
    expect(overviewMock).not.toHaveBeenCalled();
  });

  it("a refusal reading the site is a notice, never an empty list", async () => {
    siteMock.mockResolvedValue({ kind: "unavailable", code: "network", reason: "fetch failed" });
    await mount();
    expect(screen.getByTestId("wd-editorial-unavailable")).toBeTruthy();
    expect(overviewMock).not.toHaveBeenCalled();
  });

  it("an unknown site is not-found words", async () => {
    siteMock.mockResolvedValue({ kind: "no_site" });
    await mount();
    expect(screen.getByText(/does not exist/)).toBeTruthy();
  });
});
