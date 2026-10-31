import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// SEO workspace -> Accounts -> Engagements -> one engagement (M5-P4g): the Tracking tags card (Google Ads and LinkedIn) for the engagement's
// search property. The site is found with the Website -> Analytics rule (environment domain = property domain, www. ignored); no match is a
// plain note; a refused or failed read of the sites or of the tags never breaks the page.

vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, redirect: () => { throw new Error("NEXT_REDIRECT"); } }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn() }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn() }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn() }));
vi.mock("@/lib/departments", () => ({ getDepartment: vi.fn() }));
vi.mock("@/lib/searchMarketing", () => ({
  getEngagement: vi.fn(), getEngagementScope: vi.fn(), getCostProjection: vi.fn(), listProperties: vi.fn(),
  formatUsd: (n: number | null) => (n === null ? "—" : `$${n}`), anyEnabledToolSimulated: () => false,
}));
vi.mock("@/components/search/ScopeEditor", () => ({ ScopeEditor: () => <div data-testid="scope-editor" /> }));
vi.mock("@/components/search/SimulatedBadge", () => ({ ProviderModeStatement: () => null, SimulatedBadge: () => null }));
vi.mock("@/lib/webdeskContent", () => ({ listSites: vi.fn() }));
vi.mock("@/lib/trackingTags", () => ({ readTrackingTags: vi.fn() }));
vi.mock("@/lib/trackingTagsActions", () => ({ saveLinkedinPartnerIdAction: vi.fn(), saveGoogleAdsAction: vi.fn() }));

import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { getEngagement, getEngagementScope, getCostProjection, listProperties } from "@/lib/searchMarketing";
import { listSites } from "@/lib/webdeskContent";
import { readTrackingTags } from "@/lib/trackingTags";
import Page from "./page";

const sitesMock = vi.mocked(listSites);
const tagsMock = vi.mocked(readTrackingTags);
const meOf = (role: string) => ({ userId: "u", name: "U", email: "u@x.com", title: null, assurance: "high", companies: [], roles: [{ role, scopeType: "company", scopeId: "co-1" }] });
const property = { id: "p1", clientId: "c1", domain: "Acme.com", siteUrl: null, targets: null, umamiSiteId: null, verifiedAt: null, status: "active", createdAt: "x" };
const engagement = { id: "e1", clientId: "c1", propertyId: "p1", projectId: null, name: "Acme SEO", scopePreset: null, status: "active", providerBudgetUsd: 100, toolScope: {}, startsOn: null, endsOn: null, createdAt: "x" };
const siteOf = (domain: string | null, name = "acme.com", siteId = "site-1") => ({ siteId, name, kind: "static", environments: [{ envId: "e", name: "live", domain, status: "active" }] });
const sites = (...list: Array<ReturnType<typeof siteOf>>) => ({ kind: "ok" as const, data: { tenants: [{ slug: "acme", status: "active", defaultLocale: "en", locales: ["en"], sites: list }] } });
const tagsOk = (canManage = true) => ({
  state: "ok" as const,
  data: {
    linkedin: { partnerId: null }, googleAds: { ids: ["AW-123456789"], conversions: { lead: "AW-123456789/abc" } },
    target: { repo: "acme/site", variable: "PUBLIC_LINKEDIN_PARTNER_ID" }, canManage, state: "ok" as const, reason: null,
  },
});
const mount = async () => render(await Page({ params: Promise.resolve({ deptId: "dept-1", engagementId: "e1" }) }));

beforeEach(() => {
  vi.mocked(getSessionUserId).mockReset().mockResolvedValue("u");
  vi.mocked(getMe).mockReset().mockResolvedValue(meOf("search_manager") as never);
  vi.mocked(getActiveTenant).mockReset().mockResolvedValue("co-1");
  vi.mocked(getDepartment).mockReset().mockResolvedValue({ id: "dept-1" } as never);
  vi.mocked(getEngagement).mockReset().mockResolvedValue(engagement as never);
  vi.mocked(getEngagementScope).mockReset().mockResolvedValue({ scopePreset: null, toolScope: {}, providerBudgetUsd: null } as never);
  vi.mocked(getCostProjection).mockReset().mockResolvedValue(null as never);
  vi.mocked(listProperties).mockReset().mockResolvedValue([property] as never);
  sitesMock.mockReset().mockResolvedValue(sites(siteOf("www.acme.com")) as never);
  tagsMock.mockReset().mockResolvedValue(tagsOk());
});

describe("engagement page: Tracking tags card", () => {
  it("a site whose environment domain matches the property (www. and case ignored): the card, read for that site and property", async () => {
    sitesMock.mockResolvedValue(sites(siteOf("other.example", "other", "site-0"), siteOf("https://WWW.acme.com/en")) as never);
    await mount();
    expect(sitesMock).toHaveBeenCalledWith("u", "co-1");
    expect(tagsMock).toHaveBeenCalledWith("u", "co-1", "p1", "acme", "site-1");
    expect(screen.getByTestId("tracking-tags")).toBeTruthy();
    expect(screen.getByTestId("google-ads")).toBeTruthy();
    expect(screen.getByLabelText("Google Ads tag ids")).toBeTruthy(); // a search_manager holds search.tags.manage and the server said canManage
    expect(screen.queryByTestId("engagement-tags-not-built")).toBeNull();
    expect(screen.getByTestId("scope-editor")).toBeTruthy();
  });

  it("read-only for a viewer without search.tags.manage", async () => {
    vi.mocked(getMe).mockResolvedValue(meOf("search_staff") as never);
    await mount();
    expect(screen.getByTestId("google-ads-ids").textContent).toBe("AW-123456789");
    expect(screen.queryByTestId("google-ads-form")).toBeNull();
  });

  it("no matching site: the plain note, no card, and the tags are never read", async () => {
    sitesMock.mockResolvedValue(sites(siteOf("somebody-else.example"), siteOf(null, "no-domain-yet", "site-2")) as never);
    await mount();
    expect(screen.getByTestId("engagement-tags-not-built").textContent).toBe(
      "This client's website is not built by the ERP, so its Google Ads and LinkedIn tags are set on the website itself.");
    expect(screen.queryByTestId("tracking-tags")).toBeNull();
    expect(tagsMock).not.toHaveBeenCalled();
  });

  it("no websites at all is also the note", async () => {
    sitesMock.mockResolvedValue({ kind: "ok", data: { tenants: [] } } as never);
    await mount();
    expect(screen.getByTestId("engagement-tags-not-built")).toBeTruthy();
  });

  it("a refused read of the sites (403) is a sentence and the rest of the page still draws", async () => {
    sitesMock.mockResolvedValue({ kind: "forbidden", reason: "no" } as never);
    await mount();
    expect(screen.getByTestId("engagement-tags-unavailable").textContent).toMatch(/do not have access/);
    expect(screen.queryByTestId("engagement-tags-not-built")).toBeNull();
    expect(screen.queryByTestId("tracking-tags")).toBeNull();
    expect(screen.getByTestId("scope-editor")).toBeTruthy();
    expect(screen.getByText("Acme SEO")).toBeTruthy();
  });

  it("a failed read of the sites (outage, or a thrown error) is a sentence, never the 'not built' note, and the page draws", async () => {
    sitesMock.mockResolvedValue({ kind: "unavailable", code: "network", reason: "down" } as never);
    await mount();
    expect(screen.getByTestId("engagement-tags-unavailable").textContent).toMatch(/could not be looked up/);
    sitesMock.mockRejectedValue(new Error("boom"));
    document.body.innerHTML = "";
    await mount();
    expect(screen.getByTestId("engagement-tags-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("engagement-tags-not-built")).toBeNull();
    expect(screen.getByTestId("scope-editor")).toBeTruthy();
  });

  it("a failed read of the tags is the card's own sentence, never 'Not set', and the page draws", async () => {
    tagsMock.mockResolvedValue({ state: "unavailable", message: "The tracking tags could not be read: GitHub is down." });
    await mount();
    expect(screen.getByTestId("tracking-tags-unavailable").textContent).toContain("could not be read");
    expect(screen.queryByText("Not set")).toBeNull();
    expect(screen.queryByTestId("google-ads")).toBeNull();
    expect(screen.getByTestId("scope-editor")).toBeTruthy();
  });

  it("an engagement with no property shows no tags section and reads no sites", async () => {
    vi.mocked(getEngagement).mockResolvedValue({ ...engagement, propertyId: null } as never);
    await mount();
    expect(sitesMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("tracking-tags")).toBeNull();
    expect(screen.queryByTestId("engagement-tags-not-built")).toBeNull();
    expect(screen.getByTestId("scope-editor")).toBeTruthy();
  });
});
