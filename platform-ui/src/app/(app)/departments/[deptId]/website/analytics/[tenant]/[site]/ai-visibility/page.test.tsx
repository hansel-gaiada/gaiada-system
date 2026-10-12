import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

// The AI visibility tab: AI-crawler panels + the SM-16 AI-answer panels. Anything that is not data is words, and a
// missing log is never drawn as zero hits.

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/webdeskContent", () => ({ listSites: vi.fn() }));
vi.mock("@/lib/aiVisibility", () => ({ readSiteAiVisibility: vi.fn() }));
vi.mock("@/components/webdesk/content/serverCtx", () => ({ requireWebsiteCtx: vi.fn() }));

import { listSites } from "@/lib/webdeskContent";
import { readSiteAiVisibility } from "@/lib/aiVisibility";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import Page from "./page";

const sitesMock = vi.mocked(listSites);
const readMock = vi.mocked(readSiteAiVisibility);
const ctxMock = vi.mocked(requireWebsiteCtx);

const sites = () => ({ kind: "ok" as const, data: { tenants: [{ slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en"], sites: [{ siteId: "site-1", name: "gaiada.com", kind: "static", environments: [{ envId: "e", name: "live", domain: "gaiada.com", status: "active" }] }] }] } });
const property = { id: "p1", domain: "gaiada.com", umamiSiteId: null };
const range = { from: "2026-10-10", to: "2026-10-12" };
const okCrawlers = (o: { verified?: number; unverified?: number } = {}) => ({
  state: "ok" as const,
  data: {
    state: "ok" as const, range, coverage: { firstDay: "2026-10-10", lastDay: "2026-10-12" }, totalHits: 14,
    byDay: [{ day: "2026-10-10", bot: "GPTBot", hits: 6 }, { day: "2026-10-12", bot: "ClaudeBot", hits: 8 }],
    byBot: [{ bot: "ClaudeBot", hits: 8, verified: 0, unverified: o.unverified ?? 0, claimed: 8 }, { bot: "GPTBot", hits: 6, verified: o.verified ?? 0, unverified: 0, claimed: 6 }],
    topPaths: [{ path: "/pricing/", hits: 9 }, { path: "/blog/a/", hits: 5 }],
    statusMix: [{ status: 200, hits: 10 }, { status: 403, hits: 3 }, { status: 404, hits: 1 }],
  },
});
const okVisibility = (simulated = false) => ({
  state: "ok" as const,
  data: {
    state: "ok" as const, lastCapturedAt: "2026-10-08T00:00:00.000Z", anySimulated: simulated,
    engines: [{ engine: "chatgpt", queries: 2, mentioned: 1, cited: 0, changed: 1 }],
    latest: [
      { engine: "chatgpt", query: "best web agency", brandMentioned: true, cited: false, citedUrl: null, prominence: null, capturedAt: "2026-10-08T00:00:00.000Z", simulated, changed: true },
      { engine: "chatgpt", query: "web design bali", brandMentioned: false, cited: true, citedUrl: "https://gaiada.com/services/", prominence: 2, capturedAt: "2026-10-08T00:00:00.000Z", simulated, changed: false },
    ],
  },
});
const mount = async (search: { from?: string; to?: string } = {}) =>
  render(await Page({ params: Promise.resolve({ deptId: "dept-1", tenant: "gaiada", site: "site-1" }), searchParams: Promise.resolve(search) }));

beforeEach(() => {
  ctxMock.mockReset(); sitesMock.mockReset(); readMock.mockReset();
  ctxMock.mockResolvedValue({ userId: "u", me: {}, company: "co-1", deptId: "dept-1", contentBase: "c", mediaBase: "m", analyticsBase: "/departments/dept-1/website/analytics" } as never);
  sitesMock.mockResolvedValue(sites());
});

describe("Website -> Analytics -> site -> AI visibility", () => {
  it("ok: asks for the Analytics context, passes the domains and range, and draws every panel", async () => {
    readMock.mockResolvedValue({ kind: "ok", property, crawlers: okCrawlers(), visibility: okVisibility() } as never);
    await mount({ from: "2026-10-10", to: "2026-10-12" });
    expect(ctxMock).toHaveBeenCalledWith("dept-1", "analytics");
    expect(readMock).toHaveBeenCalledWith("u", "co-1", ["gaiada.com"], "2026-10-10", "2026-10-12");
    expect(screen.getByTestId("ai-visibility")).toBeTruthy();
    expect(screen.getByTestId("ai-over-time")).toBeTruthy();
    expect(within(screen.getByTestId("ai-by-bot")).getByText("ClaudeBot")).toBeTruthy();
    expect(within(screen.getByTestId("ai-top-paths")).getByText("/pricing/")).toBeTruthy();
    const mix = screen.getByTestId("ai-status-mix");
    expect(within(mix).getByText(/Blocked/).closest("tr")!.textContent).toContain("3");
    expect(within(mix).getByText(/Not found/).closest("tr")!.textContent).toContain("1");
    expect(within(screen.getByTestId("ai-engines")).getByText("ChatGPT")).toBeTruthy();
    expect(within(screen.getByTestId("ai-latest")).getByText("best web agency")).toBeTruthy();
    expect(screen.getByText(/Yes: https:\/\/gaiada.com\/services\//)).toBeTruthy();
    expect(screen.queryByTestId("ai-simulated")).toBeNull();
  });

  it("the daily table keeps a day with no hits as a 0 and says what it means", async () => {
    readMock.mockResolvedValue({ kind: "ok", property, crawlers: okCrawlers(), visibility: okVisibility() } as never);
    await mount();
    const cells = Array.from(screen.getByText("2026-10-11").closest("tr")!.querySelectorAll("td")).map((td) => td.textContent);
    expect(cells).toEqual(["2026-10-11", "0", "0"]);
    expect(screen.getByText(/days outside it were not shipped, not quiet/)).toBeTruthy();
  });

  it("verification off: unverified is n/a (not zero) and the note says it is a claim; verification on shows the counts", async () => {
    readMock.mockResolvedValue({ kind: "ok", property, crawlers: okCrawlers(), visibility: okVisibility() } as never);
    const a = await mount();
    expect(within(screen.getByTestId("ai-by-bot")).getAllByText("n/a").length).toBe(4);
    expect(screen.getByText(/Verification is off on this server/)).toBeTruthy();
    expect(screen.queryByText("Unverified claims")).toBeNull();
    a.unmount();
    readMock.mockResolvedValue({ kind: "ok", property, crawlers: okCrawlers({ verified: 6, unverified: 8 }), visibility: okVisibility() } as never);
    await mount();
    expect(screen.getByText("Unverified claims")).toBeTruthy();
    expect(within(screen.getByTestId("ai-by-bot")).queryByText("n/a")).toBeNull();
    expect(screen.getByText(/may be a copycat/)).toBeTruthy();
  });

  it("no crawler log yet: words, NO tables and no zero hits", async () => {
    readMock.mockResolvedValue({
      kind: "ok", property, visibility: okVisibility(),
      crawlers: { state: "ok", data: { state: "no_data", message: "No AI-crawler log has been ingested for this property yet, so there is nothing to show.", range, coverage: { firstDay: null, lastDay: null } } },
    } as never);
    await mount();
    expect(screen.getByTestId("ai-state-no_data").textContent).toContain("No AI-crawler log has been ingested");
    expect(screen.queryByTestId("ai-by-bot")).toBeNull();
    expect(screen.queryByText("AI-crawler hits")).toBeNull();
    expect(screen.getByTestId("ai-engines")).toBeTruthy(); // the other read is unaffected
  });

  it("log has data but not in this range: its own words", async () => {
    readMock.mockResolvedValue({
      kind: "ok", property, visibility: okVisibility(),
      crawlers: { state: "ok", data: { state: "no_data_in_range", message: "No AI-crawler requests were recorded between 2026-10-10 and 2026-10-12. The log has data from 2026-01-01 to 2026-02-01.", range, coverage: { firstDay: "2026-01-01", lastDay: "2026-02-01" } } },
    } as never);
    await mount();
    expect(screen.getByTestId("ai-state-no_data_in_range").textContent).toContain("The log has data from");
    expect(screen.queryByTestId("ai-over-time")).toBeNull();
  });

  it("no AI-visibility checks yet: words in place of the answer panels", async () => {
    readMock.mockResolvedValue({ kind: "ok", property, crawlers: okCrawlers(), visibility: { state: "ok", data: { state: "no_data", message: "No AI-visibility check has run for this property yet." } } } as never);
    await mount();
    expect(screen.getByTestId("ai-state-vis-no_data").textContent).toContain("No AI-visibility check has run");
    expect(screen.queryByTestId("ai-engines")).toBeNull();
    expect(screen.getByTestId("ai-by-bot")).toBeTruthy();
  });

  it("one read failing is said in that section only", async () => {
    readMock.mockResolvedValue({ kind: "ok", property, crawlers: { state: "unavailable", message: "The AI-crawler log could not be read. Try again in a moment." }, visibility: okVisibility() } as never);
    await mount();
    expect(screen.getByTestId("ai-state-unavailable").textContent).toContain("could not be read");
    expect(screen.queryByTestId("ai-by-bot")).toBeNull();
    expect(screen.getByTestId("ai-engines")).toBeTruthy();
  });

  it("simulated provider rows are badged, never hidden", async () => {
    readMock.mockResolvedValue({ kind: "ok", property, crawlers: okCrawlers(), visibility: okVisibility(true) } as never);
    await mount();
    expect(screen.getByTestId("ai-simulated").textContent).toContain("sample data");
    expect(screen.getAllByText(/\(sample\)/).length).toBe(2);
  });

  it("no search property for the site: an explanation, no panels", async () => {
    readMock.mockResolvedValue({ kind: "no_property" } as never);
    await mount();
    expect(screen.getByText(/No search property matches gaiada.com/)).toBeTruthy();
    expect(screen.queryByTestId("ai-visibility")).toBeNull();
  });

  it("a refused read is a refusal, not an empty page", async () => {
    readMock.mockResolvedValue({ kind: "forbidden", reason: "no" } as never);
    await mount();
    expect(screen.queryByTestId("ai-visibility")).toBeNull();
  });

  it("an unknown site is a not-found refusal and nothing is read", async () => {
    sitesMock.mockResolvedValue({ kind: "ok", data: { tenants: [] } } as never);
    await mount();
    expect(readMock).not.toHaveBeenCalled();
  });

  it("links back to the visitor analytics page", async () => {
    readMock.mockResolvedValue({ kind: "ok", property, crawlers: okCrawlers(), visibility: okVisibility() } as never);
    await mount();
    expect(screen.getByText("Back to visitor analytics").getAttribute("href")).toBe("/departments/dept-1/website/analytics/gaiada/site-1");
  });
});
