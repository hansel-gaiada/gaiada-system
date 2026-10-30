import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// The Analytics tab's page: the site, then the property + Umami reads. Anything that is not data is words, and a failed
// read never draws a table or a zero.

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/webdeskContent", () => ({ listSites: vi.fn() }));
vi.mock("@/lib/websiteAnalytics", () => ({ readSiteAnalytics: vi.fn() }));
vi.mock("@/lib/visitors", () => ({ readStatus: vi.fn() }));
vi.mock("@/lib/trackingTags", () => ({ readTrackingTags: vi.fn() }));
vi.mock("@/lib/trackingTagsActions", () => ({ saveLinkedinPartnerIdAction: vi.fn() }));
vi.mock("@/components/webdesk/content/serverCtx", () => ({ requireWebsiteCtx: vi.fn() }));

import { listSites } from "@/lib/webdeskContent";
import { readSiteAnalytics } from "@/lib/websiteAnalytics";
import { readStatus } from "@/lib/visitors";
import { readTrackingTags } from "@/lib/trackingTags";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import Page from "./page";

const sitesMock = vi.mocked(listSites);
const readMock = vi.mocked(readSiteAnalytics);
const statusMock = vi.mocked(readStatus);
const tagsMock = vi.mocked(readTrackingTags);
const tagsOk = (partnerId: string | null, canManage = true) => ({ state: "ok" as const, data: { linkedin: { partnerId }, target: { repo: "gaiadabali/gaiada-web-revamp", variable: "PUBLIC_LINKEDIN_PARTNER_ID" }, canManage, state: "ok" as const, reason: null } });
const meOf = (role: string) => ({ userId: "u", name: "U", email: "u@x.com", title: null, assurance: "high", companies: [], roles: [{ role, scopeType: "company", scopeId: "co-1" }] });
const botsOk = (total: number) => ({ state: "ok" as const, data: { state: "ok" as const, message: null, configured: true, enabled: true, lastOkIngestAt: null, lastRunAt: null, lastOutcome: null, bots: { from: "2026-09-14", to: "2026-10-13", days: 30, total, byReason: { ua: total - 2, asn: 2 } } } });
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
  ctxMock.mockReset(); sitesMock.mockReset(); readMock.mockReset(); statusMock.mockReset(); tagsMock.mockReset();
  statusMock.mockResolvedValue(botsOk(1234));
  tagsMock.mockResolvedValue(tagsOk("778899"));
  ctxMock.mockResolvedValue({ userId: "u", me: meOf("search_manager"), company: "co-1", deptId: "dept-1", contentBase: "c", mediaBase: "m", analyticsBase: "/departments/dept-1/website/analytics" } as never);
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

  // M5-V3-i: "bot hits filtered" from the collector, with the go-live note. Needs read_visitors; never a zero for an error.
  describe("bot hits filtered", () => {
    it("shows the count, the window, the reasons and the go-live note for a holder of read_visitors", async () => {
      readMock.mockResolvedValue({ kind: "ok", property, reads: okReads() } as never);
      await mount();
      expect(statusMock).toHaveBeenCalledWith("u", "co-1", "p1");
      const fig = screen.getByTestId("bot-hits");
      expect(fig.textContent).toContain("Bot hits filtered");
      expect(fig.textContent).toContain("1,234");
      expect(fig.textContent).toContain("30 days");
      expect(fig.textContent).toContain("ua 1,232");
      expect(screen.getByTestId("bot-hits-note").textContent).toContain("drop from the day the bot filter went live");
    });

    it("plain search staff gets no figure and no read (Analytics itself stays open)", async () => {
      ctxMock.mockResolvedValue({ userId: "u", me: meOf("search_staff"), company: "co-1", deptId: "dept-1", contentBase: "c", mediaBase: "m", analyticsBase: "/departments/dept-1/website/analytics" } as never);
      readMock.mockResolvedValue({ kind: "ok", property, reads: okReads() } as never);
      await mount();
      expect(statusMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId("bot-hits")).toBeNull();
      expect(screen.getByTestId("website-analytics")).toBeTruthy();
    });

    it.each([
      ["unreachable", "The visitor collector could not be reached just now. Profiles already stored are shown; bot counts are unavailable."],
      ["not_configured", "The visitor collector is not set up on this server yet (its address and keys are missing), so no visitor has been read."],
      ["disabled", "Visitor profiles are switched off on this server, so nothing is being collected into profiles."],
    ] as const)("status %s is words and not a zero", async (state, message) => {
      statusMock.mockResolvedValue({ state: "ok", data: { state, message, configured: false, enabled: false, lastOkIngestAt: null, lastRunAt: null, lastOutcome: null, bots: null } } as never);
      readMock.mockResolvedValue({ kind: "ok", property, reads: okReads() } as never);
      await mount();
      expect(screen.getByTestId(`bot-hits-${state}`).textContent).toContain(message);
      expect(screen.queryByTestId("bot-hits")).toBeNull();
    });

    it("a status that could not be read is words", async () => {
      statusMock.mockResolvedValue({ state: "unavailable", message: "The visitor status could not be read. Try again in a moment." });
      readMock.mockResolvedValue({ kind: "ok", property, reads: okReads() } as never);
      await mount();
      expect(screen.getByTestId("bot-hits-unavailable").textContent).toContain("could not be read");
    });

    it("is drawn even when Umami's own summary failed (it comes from the collector)", async () => {
      const s = down("unreachable", "Umami could not be reached. Try again in a moment.");
      readMock.mockResolvedValue({ kind: "ok", property, reads: { summary: s, pages: s, sources: s, sections: s, ctas: s, forms: s, vitals: s } } as never);
      await mount();
      expect(screen.getByTestId("bot-hits").textContent).toContain("1,234");
    });
  });

  // M5-P4 (WSK-D92): the Tracking tags card. Every search reader sees the value; only a holder of search.tags.manage gets the editor.
  describe("tracking tags", () => {
    it("asks for the property's tags with the WebDesk tenant and site, and shows the stored id and its repository", async () => {
      readMock.mockResolvedValue({ kind: "ok", property, reads: okReads() } as never);
      await mount();
      expect(tagsMock).toHaveBeenCalledWith("u", "co-1", "p1", "gaiada", "site-1");
      expect(screen.getByTestId("tracking-tags-value").textContent).toBe("778899");
      expect(screen.getByTestId("tracking-tags-target").textContent).toContain("gaiadabali/gaiada-web-revamp");
    });

    it("a search manager gets the editor", async () => {
      readMock.mockResolvedValue({ kind: "ok", property, reads: okReads() } as never);
      await mount();
      expect(screen.getByTestId("tracking-tags-form")).toBeTruthy();
    });

    it("plain search staff sees the value but gets no editor", async () => {
      ctxMock.mockResolvedValue({ userId: "u", me: meOf("search_staff"), company: "co-1", deptId: "dept-1", contentBase: "c", mediaBase: "m", analyticsBase: "/departments/dept-1/website/analytics" } as never);
      tagsMock.mockResolvedValue(tagsOk("778899", false));
      readMock.mockResolvedValue({ kind: "ok", property, reads: okReads() } as never);
      await mount();
      expect(screen.getByTestId("tracking-tags-value").textContent).toBe("778899");
      expect(screen.queryByTestId("tracking-tags-form")).toBeNull();
    });

    it("a failed read is a sentence in the card, never 'Not set', and the rest of the page still draws", async () => {
      tagsMock.mockResolvedValue({ state: "unavailable", message: "The tracking tags could not be read: GitHub did not answer." });
      readMock.mockResolvedValue({ kind: "ok", property, reads: okReads() } as never);
      await mount();
      expect(screen.getByTestId("tracking-tags-unavailable").textContent).toContain("could not be read");
      expect(screen.queryByText("Not set")).toBeNull();
      expect(screen.getByTestId("website-analytics")).toBeTruthy();
    });

    it("is drawn even when Umami's own summary failed (it comes from GitHub, not Umami)", async () => {
      const s = down("unreachable", "Umami could not be reached. Try again in a moment.");
      readMock.mockResolvedValue({ kind: "ok", property, reads: { summary: s, pages: s, sources: s, sections: s, ctas: s, forms: s, vitals: s } } as never);
      await mount();
      expect(screen.getByTestId("tracking-tags-value").textContent).toBe("778899");
    });

    it("is not drawn, and nothing is read, when no property matches the site", async () => {
      readMock.mockResolvedValue({ kind: "no_property" });
      await mount();
      expect(tagsMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId("tracking-tags")).toBeNull();
    });
  });
});
