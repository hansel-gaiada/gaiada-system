import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// One visitor: timeline (server order), interests, score parts, the linked lead. A lead the viewer cannot open is "a lead you cannot open"
// and no id anywhere; a readable one is a link. Non-ok reads are words.

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/visitors", () => ({ resolveSiteProperty: vi.fn(), readDetail: vi.fn() }));
vi.mock("@/lib/replays", () => ({ readRecordings: vi.fn() }));
vi.mock("@/components/webdesk/content/serverCtx", () => ({ requireWebsiteCtx: vi.fn() }));

import { readDetail, resolveSiteProperty } from "@/lib/visitors";
import { readRecordings } from "@/lib/replays";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import Page from "./page";

const V = "0194a3b2-1111-7000-8000-000000000001";
const LEAD = "99999999-8888-7000-8000-000000000042";
const detail = (lead: unknown, o: Record<string, unknown> = {}) => ({
  visitorId: V, firstSeenAt: "2026-10-01T08:00:00.000Z", lastSeenAt: "2026-10-12T09:30:00.000Z", visits: 4, pageviews: 11, device: "mobile",
  country: "ID", city: "Denpasar", network: { kind: "network", name: "Telkom", domain: null, confidence: null, source: null }, company: null,
  interests: { industry: [{ tag: "hospitality", score: 8 }], service: [] }, score: 61, lead,
  scoreParts: { recency: 20, frequency: 10, depth: 15, intent: 16 }, scoreMax: { recency: 25, frequency: 15, depth: 30, intent: 30 },
  events: [
    { occurredAt: "2026-10-12T09:30:00.000Z", kind: "pageview", path: "/b-newest/", name: null, data: null },
    { occurredAt: "2026-10-12T09:20:00.000Z", kind: "event", path: "/contact/", name: "lead_form_start", data: { form_id: "contact" } },
    { occurredAt: "2026-10-11T09:00:00.000Z", kind: "pageview", path: "/a-oldest/", name: null, data: null },
  ],
  eventsTruncated: false, ...o,
});
const ctxMock = vi.mocked(requireWebsiteCtx);
const siteMock = vi.mocked(resolveSiteProperty);
const detailMock = vi.mocked(readDetail);
const recMock = vi.mocked(readRecordings);
const R1 = "0194a3b2-bbbb-7000-8000-0000000000b1";
const meOf = (role: string) => ({ userId: "u", name: "U", email: "u@x.com", title: null, assurance: "high", companies: [], roles: [{ role, scopeType: "company", scopeId: "co-1" }] });
const asViewer = (role: string) => ctxMock.mockResolvedValue({ userId: "u", me: meOf(role), company: "co-1", deptId: "dept-1", visitorsBase: "/departments/dept-1/website/visitors" } as never);
const mount = async () => render(await Page({ params: Promise.resolve({ deptId: "dept-1", tenant: "gaiada", site: "site-1", visitorId: V }) }));

beforeEach(() => {
  ctxMock.mockReset(); siteMock.mockReset(); detailMock.mockReset(); recMock.mockReset();
  asViewer("search_staff"); // plain staff: no replay capability unless a test says otherwise
  siteMock.mockResolvedValue({ kind: "ok", siteName: "gaiada.com", property: { id: "p1", domain: "gaiada.com", umamiSiteId: "u" } });
});

describe("Website -> Visitors -> site -> visitor", () => {
  it("asks for the visitors tab context; shows the 8-character id only, the summary, score parts and interests", async () => {
    detailMock.mockResolvedValue({ kind: "ok", visitor: detail({ state: "none" }) } as never);
    const { container } = await mount();
    expect(ctxMock).toHaveBeenCalledWith("dept-1", "visitors");
    expect(detailMock).toHaveBeenCalledWith("u", "co-1", "p1", V);
    expect(screen.getByTestId("visitor-detail-id").textContent).toBe("Visitor 0194a3b2");
    expect(container.textContent).not.toContain(V);
    expect(screen.getByTestId("score-parts").textContent).toContain("Recency");
    expect(screen.getByTestId("score-parts").textContent).toContain("20");
    expect(screen.getByTestId("score-parts").textContent).toContain("25");
    expect(screen.getByText("hospitality (8)")).toBeTruthy();
    expect(screen.getByText(/never a decision about a person/)).toBeTruthy();
  });

  it("keeps the timeline in the server's order (newest first, not re-sorted)", async () => {
    detailMock.mockResolvedValue({ kind: "ok", visitor: detail({ state: "none" }) } as never);
    await mount();
    const paths = screen.getAllByTestId("visitor-event").map((r) => r.textContent ?? "");
    expect(paths[0]).toContain("/b-newest/");
    expect(paths[1]).toContain("/contact/");
    expect(paths[1]).toContain("form_id: contact");
    expect(paths[2]).toContain("/a-oldest/");
  });

  it("a restricted lead says 'a lead you cannot open' and shows no id and no link", async () => {
    detailMock.mockResolvedValue({ kind: "ok", visitor: detail({ state: "restricted", message: "a lead you cannot open" }) } as never);
    const { container } = await mount();
    expect(screen.getByTestId("lead-restricted").textContent).toContain("a lead you cannot open");
    expect(container.querySelector('a[href*="/agency/leads/"]')).toBeNull();
    expect(container.innerHTML).not.toContain(LEAD);
  });

  it("a readable lead is a link to the existing lead page", async () => {
    detailMock.mockResolvedValue({ kind: "ok", visitor: detail({ state: "readable", id: LEAD }) } as never);
    await mount();
    expect(screen.getByTestId("lead-link").getAttribute("href")).toBe(`/agency/leads/${LEAD}`);
  });

  it("no lead is said in words", async () => {
    detailMock.mockResolvedValue({ kind: "ok", visitor: detail({ state: "none" }) } as never);
    await mount();
    expect(screen.getByTestId("lead-none").textContent).toContain("No lead is linked");
  });

  it("no interests says why (the rules are the only source); a truncated timeline says so", async () => {
    detailMock.mockResolvedValue({ kind: "ok", visitor: detail({ state: "none" }, { interests: { industry: [], service: [] }, eventsTruncated: true }) } as never);
    await mount();
    expect(screen.getByText(/Interests come only from the interest rules/)).toBeTruthy();
    expect(screen.getByTestId("events-truncated").textContent).toContain("200");
  });

  it("a visitor that is not there is words", async () => {
    detailMock.mockResolvedValue({ kind: "visitor_not_found" });
    const { container } = await mount();
    expect(container.textContent).toContain("There is no consented visitor with this id");
    expect(screen.queryByTestId("visitor-detail")).toBeNull();
  });

  it("a failed read is a notice, not an empty detail", async () => {
    detailMock.mockResolvedValue({ kind: "unavailable", code: "network", reason: "boom" });
    await mount();
    expect(screen.getByTestId("wd-editorial-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("visitor-detail")).toBeNull();
  });

  it("a contract defect is said as one", async () => {
    detailMock.mockResolvedValue({ kind: "unavailable", code: "contract_drift", reason: "visitor.lead.state: unknown" });
    await mount();
    expect(screen.getByTestId("wd-contract-drift")).toBeTruthy();
  });
});

describe("Recordings (V6-c)", () => {
  const okList = (recordings: unknown[]) => ({ kind: "ok", list: { propertyId: "p1", visitorId: V, recordings } }) as never;
  const rec = { recordingId: R1, startedAt: "2026-10-12T09:00:00.000Z", lastChunkAt: "2026-10-12T09:03:20.000Z", durationSeconds: 200, pages: ["https://gaiada.com/", "https://gaiada.com/contact/"], chunks: 20 };
  const unreachable = "The recording store did not answer, so recordings cannot be read right now. Try again in a moment.";

  it("a viewer without search.replay.view sees no Recordings section and NO read is made", async () => {
    asViewer("search_staff");
    detailMock.mockResolvedValue({ kind: "ok", visitor: detail({ state: "none" }) } as never);
    const { container } = await mount();
    expect(recMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("recordings")).toBeNull();
    expect(screen.queryByTestId("recordings-unavailable")).toBeNull();
    expect(container.textContent).not.toContain("Recordings");
    expect(screen.getByTestId("visitor-detail")).toBeTruthy();
  });

  it("a holder of it sees each recording's date, length and pages, and a link to the player", async () => {
    asViewer("search_manager");
    detailMock.mockResolvedValue({ kind: "ok", visitor: detail({ state: "none" }) } as never);
    recMock.mockResolvedValue(okList([rec]));
    await mount();
    expect(recMock).toHaveBeenCalledWith("u", "co-1", "p1", V);
    const row = screen.getByTestId("recording-row");
    expect(row.textContent).toContain("2026-10-12 09:00 UTC");
    expect(row.textContent).toContain("3 min 20 s");
    expect(row.textContent).toContain("https://gaiada.com/, https://gaiada.com/contact/");
    // A plain link (a full page load), so the player's own Content-Security-Policy applies to its document.
    const a = screen.getByTestId("recording-watch");
    expect(a.getAttribute("href")).toBe(`/departments/dept-1/website/visitors/gaiada/site-1/${V}/recordings/${R1}`);
    expect(a.tagName).toBe("A");
  });

  it("an empty list says the store answered and has none", async () => {
    asViewer("search_manager");
    detailMock.mockResolvedValue({ kind: "ok", visitor: detail({ state: "none" }) } as never);
    recMock.mockResolvedValue(okList([]));
    await mount();
    expect(screen.getByTestId("recordings").textContent).toContain("No recordings are stored for this visitor");
    expect(screen.queryByTestId("recordings-table")).toBeNull();
  });

  it("a failed read is words, not an empty table, and the rest of the visitor still shows", async () => {
    asViewer("search_manager");
    detailMock.mockResolvedValue({ kind: "ok", visitor: detail({ state: "none" }) } as never);
    recMock.mockResolvedValue({ kind: "failed", failure: { kind: "unavailable", reason: "collector_unreachable", message: unreachable }, message: unreachable });
    await mount();
    expect(screen.getByTestId("recordings-unavailable").textContent).toContain("did not answer");
    expect(screen.queryByTestId("recordings-table")).toBeNull();
    expect(screen.getByTestId("visitor-detail")).toBeTruthy();
  });

  it("an off-contract answer is said as a defect", async () => {
    asViewer("search_manager");
    detailMock.mockResolvedValue({ kind: "ok", visitor: detail({ state: "none" }) } as never);
    recMock.mockResolvedValue({ kind: "drift", message: "recordings[0].durationSeconds: expected a number" });
    await mount();
    expect(screen.getByTestId("recordings-unavailable").textContent).toMatch(/defect, not an empty list/);
  });
});
