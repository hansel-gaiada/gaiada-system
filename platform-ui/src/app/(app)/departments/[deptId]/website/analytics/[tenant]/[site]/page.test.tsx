import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// The Analytics tab's page: the site, then the property + Umami reads. Anything that is not data is words, and a failed
// read never draws a table or a zero.

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/webdeskContent", () => ({ listSites: vi.fn() }));
vi.mock("@/lib/websiteAnalytics", () => ({ readSiteAnalytics: vi.fn() }));
vi.mock("@/components/webdesk/content/serverCtx", () => ({ requireWebsiteCtx: vi.fn() }));

import { listSites } from "@/lib/webdeskContent";
import { readSiteAnalytics } from "@/lib/websiteAnalytics";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import Page from "./page";

const sitesMock = vi.mocked(listSites);
const readMock = vi.mocked(readSiteAnalytics);
const ctxMock = vi.mocked(requireWebsiteCtx);

const sites = () => ({ kind: "ok" as const, data: { tenants: [{ slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en"], sites: [{ siteId: "site-1", name: "gaiada.com", kind: "static", environments: [{ envId: "e", name: "live", domain: "gaiada.com", status: "active" }] }] }] } });
const property = { id: "p1", domain: "gaiada.com", umamiSiteId: "u" };
const down = (state: "not_configured" | "not_bound" | "unreachable" | "rejected", message: string) => ({ state, message }) as const;
const okReads = () => ({
  summary: { state: "ok", data: { visitors: 400, visits: 500, pageviews: 1200, bounceRate: 0.3, avgVisitSeconds: 180 } },
  pages: { state: "ok", data: [{ label: "/", count: 300 }, { label: "/rare/", count: "<5" }] },
  sources: { state: "ok", data: { referrers: [{ label: "chatgpt.com", count: 12 }], aiSearch: { total: 12, hosts: [{ label: "chatgpt.com", count: 12 }] } } },
  sections: { state: "ok", data: [{ sectionId: "home.hero", views: 1000, reachPct: 83.3 }, { sectionId: "footer", views: "<5", reachPct: null }] },
  ctas: { state: "ok", data: [{ label: "hero", count: 30 }] },
  forms: { state: "ok", data: [{ formId: "contact", lead_form_start: 50, lead_form_step: "<5", lead_form_send: 20, generate_lead: 18 }] },
  vitals: { state: "ok", data: { byMetric: [{ label: "LCP", count: 300 }], byRating: [{ label: "good", count: 500 }] } },
});
const mount = async (search: { from?: string; to?: string } = {}) =>
  render(await Page({ params: Promise.resolve({ deptId: "dept-1", tenant: "gaiada", site: "site-1" }), searchParams: Promise.resolve(search) }));

beforeEach(() => {
  ctxMock.mockReset(); sitesMock.mockReset(); readMock.mockReset();
  ctxMock.mockResolvedValue({ userId: "u", me: {}, company: "co-1", deptId: "dept-1", contentBase: "c", mediaBase: "m", analyticsBase: "/departments/dept-1/website/analytics" } as never);
  sitesMock.mockResolvedValue(sites());
});

describe("Website -> Analytics -> site", () => {
  it("ok: draws the figures and tables, asks for the Analytics tab context, passes the site domains and range", async () => {
    readMock.mockResolvedValue({ kind: "ok", property, reads: okReads() } as never);
    await mount({ from: "2026-10-01", to: "2026-10-10" });
    expect(ctxMock).toHaveBeenCalledWith("dept-1", "analytics");
    expect(readMock).toHaveBeenCalledWith("u", "co-1", ["gaiada.com"], "2026-10-01", "2026-10-10");
    expect(screen.getByTestId("website-analytics")).toBeTruthy();
    expect(screen.getByText("1,200")).toBeTruthy();
    expect(screen.getByTestId("ai-search-total").textContent).toContain("12");
    expect(screen.getByText("home.hero")).toBeTruthy();
    expect(screen.getByText("83.3%")).toBeTruthy();
    expect(screen.getByTestId("ai-visibility-link").getAttribute("href")).toMatch(/\/ai-visibility$/); // M5-P5b
  });

  it("shows small cells as <5 and never a raw small number", async () => {
    readMock.mockResolvedValue({ kind: "ok", property, reads: okReads() } as never);
    const { container } = await mount();
    expect(container.textContent).toContain("<5");
    expect(screen.getByText("/rare/").closest("tr")!.textContent).toContain("<5");
  });

  it("Umami not configured: a plain-words notice and NO tables or zeros", async () => {
    const s = down("not_configured", "Website analytics is not set up on this server yet (the Umami address and key are missing).");
    readMock.mockResolvedValue({ kind: "ok", property, reads: { summary: s, pages: s, sources: s, sections: s, ctas: s, forms: s, vitals: s } } as never);
    const { container } = await mount();
    expect(screen.getByTestId("analytics-state-not_configured").textContent).toContain("not set up");
    expect(container.querySelector("table")).toBeNull();
    expect(screen.queryByText("Visitors")).toBeNull();
  });

  it("Umami unreachable: its own notice, no tables", async () => {
    const s = down("unreachable", "Umami could not be reached. Try again in a moment.");
    readMock.mockResolvedValue({ kind: "ok", property, reads: { summary: s, pages: s, sources: s, sections: s, ctas: s, forms: s, vitals: s } } as never);
    const { container } = await mount();
    expect(screen.getByTestId("analytics-state-unreachable").textContent).toContain("Umami unreachable");
    expect(container.querySelector("table")).toBeNull();
  });

  it("one read failing keeps the rest and says so in that card only", async () => {
    const reads = { ...okReads(), forms: down("unreachable", "Umami could not be reached.") };
    readMock.mockResolvedValue({ kind: "ok", property, reads } as never);
    await mount();
    expect(screen.getByTestId("analytics-state-unreachable")).toBeTruthy();
    expect(screen.getByText("home.hero")).toBeTruthy();
  });

  it("no matching property: says so, no dashboard", async () => {
    readMock.mockResolvedValue({ kind: "no_property" });
    await mount();
    expect(screen.getByText(/No search property matches gaiada.com/)).toBeTruthy();
    expect(screen.queryByTestId("website-analytics")).toBeNull();
  });

  it("a refusal (forbidden / unavailable) is a notice, no dashboard", async () => {
    readMock.mockResolvedValue({ kind: "unavailable", code: "contract_drift", reason: "bad body" });
    await mount();
    expect(screen.getByTestId("wd-contract-drift")).toBeTruthy();
    expect(screen.queryByTestId("website-analytics")).toBeNull();
  });

  it("an unusable range in the URL falls back and says why", async () => {
    readMock.mockResolvedValue({ kind: "ok", property, reads: okReads() } as never);
    await mount({ from: "garbage" });
    expect(screen.getByRole("alert").textContent).toMatch(/YYYY-MM-DD/);
  });

  it("a site that is not this company's is not found", async () => {
    sitesMock.mockResolvedValue({ kind: "ok", data: { tenants: [] } });
    await mount();
    expect(readMock).not.toHaveBeenCalled();
  });
});
