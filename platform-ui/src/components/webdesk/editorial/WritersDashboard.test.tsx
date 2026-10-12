import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { DashboardItem, DashboardMetrics, Metric, WritersDashboard as Dash } from "@/lib/webdeskDashboardModel";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import { WritersDashboard } from "./WritersDashboard";

afterEach(cleanup);

const reason = (code: string, text: string) => ({ code, text });
const ok = <T,>(value: T): Metric<T> => ({ value, reason: null });
const na = <T,>(code: string, text: string): Metric<T> => ({ value: null, reason: reason(code, text) });

const metrics = (over: Partial<DashboardMetrics> = {}): DashboardMetrics => ({
  views: ok({ current: 120, previous: 60, trend: "up" }),
  avgSeconds: ok({ seconds: 210 }),
  clicks: ok({ current: 30, previous: 50, trend: "down" }),
  impressions: ok({ current: 900, previous: 900, trend: "flat" }),
  topQueries: ok([{ query: "villa bali", clicks: 20, impressions: 400 }]),
  leads: ok({ current: 2, previous: null, trend: null }),
  ...over,
});
const item = (id: string, over: Partial<DashboardItem> = {}): DashboardItem => ({
  itemId: id, collectionKey: "post", locale: "en", slug: `post-${id}`, title: `Title ${id}`, publishedVersion: 2, mine: false,
  pagePath: `/blog/${id}/`, pagePathReason: null, metrics: metrics(), decay: ok("none"), ...over,
});
const dash = (items: DashboardItem[], over: Partial<Dash> = {}): Dash => ({
  tenantSlug: "gaiada", siteId: "site-1", period: { key: "28d", days: 28 },
  windows: { traffic: { current: { from: "2026-09-15", to: "2026-10-12" }, previous: { from: "2026-08-18", to: "2026-09-14" } }, search: { current: { from: "2026-09-12", to: "2026-10-09" }, previous: { from: "2026-08-15", to: "2026-09-11" } } },
  scope: "all_site", sources: { umami: { state: "ok" }, search: { state: "ok" }, leads: { state: "ok" }, decay: { state: "ok" } },
  items, page: { cursor: null, hasMore: false, limit: 25 }, ...over,
});
const show = (d: Dash, filters = {}) =>
  render(<WritersDashboard data={d} filters={filters} filterAction="/d/website/writers/dashboard/gaiada/site-1" editorBase="/d/website/content/gaiada/site-1" collections={["post", "page"]} locales={["en", "id"]} />);

describe("WritersDashboard: a card per article", () => {
  it("title links into the editor, with the page address, collection, language and version", () => {
    show(dash([item("a", { mine: true })]));
    const card = screen.getByTestId("dash-card");
    expect(within(card).getByRole("link", { name: "Title a" }).getAttribute("href")).toBe("/d/website/content/gaiada/site-1/post/post-a?locale=en");
    expect(within(card).getByTestId("page-path").textContent).toContain("/blog/a/");
    expect(card.textContent).toMatch(/post · en · v2/);
    expect(within(card).getByTestId("mine-chip").textContent).toBe("Your article");
  });

  it("every figure with its arrow AND words: views up, clicks down, impressions level; the earlier period is shown", () => {
    show(dash([item("a")]));
    expect(screen.getByTestId("views-value").textContent).toBe("120");
    expect(screen.getByTestId("views-trend").textContent).toMatch(/up on the period before/);
    expect(screen.getByTestId("views-trend").getAttribute("data-trend")).toBe("up");
    expect(screen.getByTestId("views-previous").textContent).toMatch(/Period before: 60/);
    expect(screen.getByTestId("clicks-trend").textContent).toMatch(/down on the period before/);
    expect(screen.getByTestId("impressions-trend").textContent).toMatch(/about the same/);
    expect(screen.getByTestId("time-value").textContent).toBe("3 min 30 s");
    expect(screen.getByTestId("leads-value").textContent).toBe("2");
    expect(screen.queryByTestId("leads-trend")).toBeNull(); // no earlier period to compare with: no arrow
    expect(screen.getByTestId("tile-leads").textContent).toMatch(/web leads that landed on, or sent a form from, this page/);
  });

  it("the arrow is decorative: the words carry the meaning", () => {
    show(dash([item("a")]));
    const trend = screen.getByTestId("views-trend");
    expect(trend.querySelector("[aria-hidden=true]")?.textContent).toBe("▲");
  });

  it("top queries are listed with their counts; none is said in words", () => {
    show(dash([item("a"), item("b", { metrics: metrics({ topQueries: ok([]) }) })]));
    const cards = screen.getAllByTestId("dash-card");
    expect(within(cards[0]).getByTestId("queries-list").textContent).toMatch(/villa bali.*20 clicks, 400 impressions/);
    expect(within(cards[1]).getByTestId("queries-none").textContent).toMatch(/No query had enough impressions/);
    expect(within(cards[1]).queryByTestId("queries-list")).toBeNull();
  });
});

describe("WritersDashboard: an unavailable figure is words, never a zero", () => {
  const down = reason("umami_unreachable", "Website analytics could not be reached. Try again in a moment.");

  it("a figure with a reason says 'Unavailable' and the reason, and the card stays with its other figures", () => {
    show(dash([item("a", { metrics: metrics({ views: { value: null, reason: down }, avgSeconds: { value: null, reason: down } }) })]));
    const views = screen.getByTestId("tile-views");
    expect(views.getAttribute("data-available")).toBe("false");
    expect(views.textContent).toMatch(/Unavailable/);
    expect(screen.getByTestId("tile-views-reason").textContent).toBe(down.text);
    expect(screen.queryByTestId("views-value")).toBeNull();
    expect(screen.queryByTestId("time-value")).toBeNull();
    expect(screen.getByTestId("clicks-value").textContent).toBe("30"); // search figures still show
    // nowhere does an unavailable figure read as a number
    expect(views.textContent).not.toMatch(/\b0\b/);
  });

  it("a small cell reads 'fewer than 5' with no arrow", () => {
    show(dash([item("a", { metrics: metrics({ views: ok({ current: "<5", previous: 40, trend: null }) }) })]));
    expect(screen.getByTestId("views-value").textContent).toBe("fewer than 5");
    expect(screen.queryByTestId("views-trend")).toBeNull();
  });

  it("an article with no public page address says so, shows no figure, and keeps its row", () => {
    const why = reason("no_route_pattern", "This collection has no public page address on record, so no page figures can be matched to its items.");
    const allNa = (): DashboardMetrics => ({
      views: na("no_route_pattern", why.text), avgSeconds: na("no_route_pattern", why.text), clicks: na("no_route_pattern", why.text),
      impressions: na("no_route_pattern", why.text), topQueries: na("no_route_pattern", why.text), leads: na("no_route_pattern", why.text),
    });
    show(dash([item("a", { pagePath: null, pagePathReason: why, metrics: allNa(), decay: na("no_route_pattern", why.text) })]));
    expect(screen.getByTestId("page-path-na").textContent).toMatch(/No public page address/);
    expect(screen.getByTestId("page-path-na").textContent).toContain(why.text);
    expect(screen.queryByTestId("page-path")).toBeNull();
    for (const t of ["tile-views", "tile-time", "tile-clicks", "tile-impressions", "tile-queries", "tile-leads"]) {
      expect(screen.getByTestId(t).getAttribute("data-available")).toBe("false");
    }
    expect(screen.getByTestId("decay-na").textContent).toBe("Decay check unavailable");
  });

  it("the source banner names each source that did not answer, once, with its reason", () => {
    show(dash([item("a")], { sources: { umami: { state: "unavailable", reason: down }, search: { state: "ok" }, leads: { state: "unavailable", reason: reason("leads_unavailable", "Lead counts could not be read right now.") }, decay: { state: "not_asked" } } }));
    const banner = screen.getByTestId("dash-sources");
    expect(banner.textContent).toMatch(/Some figures are unavailable right now/);
    expect(banner.textContent).toMatch(/nothing is shown as zero/);
    expect(screen.getByTestId("source-website").textContent).toContain(down.text);
    expect(screen.getByTestId("source-leads").textContent).toContain("Lead counts could not be read");
    expect(screen.queryByTestId("source-search")).toBeNull();
  });

  it("no banner when every source answered", () => {
    show(dash([item("a")]));
    expect(screen.queryByTestId("dash-sources")).toBeNull();
  });
});

describe("WritersDashboard: the decay badge", () => {
  const finding = { findingId: "f-1", status: "open", reason: "Search clicks fell by 40 %.", detectedAt: "2026-10-10T00:00:00Z", briefId: null };

  it("a finding is a badge that links to the finding on the same card, with its reason, status and a way to refresh the article", () => {
    show(dash([item("a", { decay: ok(finding) })]));
    const badge = screen.getByTestId("decay-badge");
    expect(badge.textContent).toBe("Losing traffic");
    expect(badge.getAttribute("href")).toBe("#finding-f-1");
    const f = screen.getByTestId("decay-finding");
    expect(f.getAttribute("id")).toBe("finding-f-1");
    expect(f.textContent).toContain("Search clicks fell by 40 %.");
    expect(f.textContent).toMatch(/Open: nobody has looked at it yet/);
    expect(within(f).getByRole("link", { name: "Open the article to refresh it" }).getAttribute("href")).toBe("/d/website/content/gaiada/site-1/post/post-a?locale=en");
  });

  it("no finding while the detector runs is 'No decay alert'; a decay check that is off or failed is unavailable in words, never 'healthy'", () => {
    show(dash([
      item("a"),
      item("b", { decay: na("decay_off", "The decay check is switched off on this server, so \"no alert\" would not mean the page is healthy.") }),
    ]));
    const cards = screen.getAllByTestId("dash-card");
    expect(within(cards[0]).getByTestId("decay-none").textContent).toBe("No decay alert");
    expect(within(cards[1]).queryByTestId("decay-none")).toBeNull();
    expect(within(cards[1]).getByTestId("decay-na-reason").textContent).toMatch(/switched off/);
  });
});

describe("WritersDashboard: scope, windows, filters, paging", () => {
  it("says which period each source covers (search settles late)", () => {
    show(dash([item("a")]));
    expect(screen.getByTestId("dash-windows").textContent).toMatch(/15 Sep 2026 to 12 Oct 2026, compared with 18 Aug 2026 to 14 Sep 2026/);
    expect(screen.getByTestId("dash-windows").textContent).toMatch(/Search figures: 12 Sep 2026 to 9 Oct 2026/);
  });

  it("a scoped caller is told the list follows their access; a staff caller is told it is every article", () => {
    show(dash([item("a")], { scope: "scoped" }));
    expect(screen.getByTestId("writers-dashboard").textContent).toMatch(/articles your access lets you see/);
    cleanup();
    show(dash([item("a")], { scope: "all_site" }));
    expect(screen.getByTestId("writers-dashboard").textContent).toMatch(/every article on this site/);
  });

  it("the lede promises counts only", () => {
    show(dash([item("a")]));
    expect(screen.getByTestId("writers-dashboard").textContent).toMatch(/Counts only: no visitor, and no lead.s name or details/);
  });

  it("filters: period, collection (the site's, plus the rows'), language, and my articles/all; the current choice is selected", () => {
    show(dash([item("a", { collectionKey: "guide" })]), { period: "7d", collection: "post", locale: "id", mine: true });
    expect((screen.getByLabelText("Period") as HTMLSelectElement).value).toBe("7d");
    expect((screen.getByLabelText("Collection") as HTMLSelectElement).value).toBe("post");
    expect(Array.from((screen.getByLabelText("Collection") as HTMLSelectElement).options).map((o) => o.value)).toEqual(["", "guide", "page", "post"]);
    expect((screen.getByLabelText("Language") as HTMLSelectElement).value).toBe("id");
    expect((screen.getByLabelText("Show") as HTMLSelectElement).value).toBe("true");
    expect(screen.getByRole("link", { name: "Clear" }).getAttribute("href")).toBe("/d/website/writers/dashboard/gaiada/site-1");
    const form = screen.getByRole("form", { name: "Filter the dashboard" }) as HTMLFormElement;
    expect(form.method).toBe("get");
  });

  it("no filters: no Clear link, the default period selected", () => {
    show(dash([item("a")]));
    expect(screen.queryByRole("link", { name: "Clear" })).toBeNull();
    expect((screen.getByLabelText("Period") as HTMLSelectElement).value).toBe("28d");
  });

  it("an empty page is words, and says whether a filter caused it; never a blank", () => {
    show(dash([]));
    expect(screen.getByText("There are no published articles to show yet.")).toBeTruthy();
    cleanup();
    show(dash([]), { collection: "post" });
    expect(screen.getByText("No published articles match these filters.")).toBeTruthy();
    cleanup();
    show(dash([], { page: { cursor: "c2", hasMore: true, limit: 25 } }));
    expect(screen.getByText(/None of the articles on this page can be shown for these filters/)).toBeTruthy();
    expect(screen.getByTestId("dash-next").getAttribute("href")).toBe("/d/website/writers/dashboard/gaiada/site-1?cursor=c2");
  });

  it("the next page keeps the filters and carries the cursor", () => {
    show(dash([item("a")], { page: { cursor: "c2", hasMore: true, limit: 25 } }), { period: "90d", collection: "post", mine: true });
    expect(screen.getByTestId("dash-next").getAttribute("href")).toBe("/d/website/writers/dashboard/gaiada/site-1?period=90d&collection=post&mine=true&cursor=c2");
  });

  it("no next link on the last page", () => {
    show(dash([item("a")]));
    expect(screen.queryByTestId("dash-next")).toBeNull();
  });
});

describe("WritersDashboard: counts only", () => {
  it("nothing on the page can be a person: no address, phone or lead id is a field of the data, and none is drawn", () => {
    show(dash([item("a", { mine: true }), item("b")]));
    const text = screen.getByTestId("writers-dashboard").textContent ?? "";
    expect(text).not.toMatch(/@/);
    expect(text.toLowerCase()).not.toMatch(/phone|e-?mail|lead id/);
  });
});

describe("the board links to the dashboard", () => {
  it("a link when the page gives one, none otherwise", async () => {
    const { WritersBoard } = await import("./WritersBoard");
    const board = { items: [], counts: { draft: 0, in_review: 0, changes_requested: 0, approved: 0 }, countsWithheld: false, policies: [], page: { cursor: null, hasMore: false, limit: 100 } };
    const props = { board, editorBase: "/e", authors: {}, filters: {}, filterAction: "/w", peopleHref: "/p" };
    render(<WritersBoard {...props} dashboardHref="/w/dashboard/gaiada/site-1" />);
    expect(screen.getByTestId("dashboard-link").getAttribute("href")).toBe("/w/dashboard/gaiada/site-1");
    cleanup();
    render(<WritersBoard {...props} />);
    expect(screen.queryByTestId("dashboard-link")).toBeNull();
  });
});
