import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// SEO workspace -> Accounts -> Engagements -> one engagement (M5-P4g): the Tracking tags card (Google Ads and LinkedIn) for the engagement's
// search property. The server names the site (GET tracking-tags/site, read on the property only); no site is a plain note; a refused or
// failed lookup or tags read never breaks the page.

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
// Only the new reader is mocked: the page asks no WebDesk or Web Dev permission, so the page can never depend on one.
vi.mock("@/lib/trackingTags", () => ({ findTrackingSite: vi.fn(), readTrackingTags: vi.fn() }));
vi.mock("@/lib/trackingTagsActions", () => ({ saveLinkedinPartnerIdAction: vi.fn(), saveGoogleAdsAction: vi.fn() }));

import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { getEngagement, getEngagementScope, getCostProjection, listProperties } from "@/lib/searchMarketing";
import { findTrackingSite, readTrackingTags } from "@/lib/trackingTags";
import Page from "./page";

const siteMock = vi.mocked(findTrackingSite);
const tagsMock = vi.mocked(readTrackingTags);
const meOf = (role: string) => ({ userId: "u", name: "U", email: "u@x.com", title: null, assurance: "high", companies: [], roles: [{ role, scopeType: "company", scopeId: "co-1" }] });
const property = { id: "p1", clientId: "c1", domain: "Acme.com", siteUrl: null, targets: null, umamiSiteId: null, verifiedAt: null, status: "active", createdAt: "x" };
const engagement = { id: "e1", clientId: "c1", propertyId: "p1", projectId: null, name: "Acme SEO", scopePreset: null, status: "active", providerBudgetUsd: 100, toolScope: {}, startsOn: null, endsOn: null, createdAt: "x" };
const found = (site: { webdeskTenant: string; site: string; name: string } | null) => ({ kind: "ok" as const, data: { site } });
const acme = { webdeskTenant: "acme", site: "site-1", name: "acme.com" };
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
  siteMock.mockReset().mockResolvedValue(found(acme));
  tagsMock.mockReset().mockResolvedValue(tagsOk());
});

describe("engagement page: Tracking tags card", () => {
  it("a site the server names: the card, read for that site and property", async () => {
    await mount();
    expect(siteMock).toHaveBeenCalledWith("u", "co-1", "p1");
    expect(tagsMock).toHaveBeenCalledWith("u", "co-1", "p1", "acme", "site-1");
    expect(screen.getByTestId("tracking-tags")).toBeTruthy();
    expect(screen.getByTestId("google-ads")).toBeTruthy();
    expect(screen.getByLabelText("Google Ads tag ids")).toBeTruthy(); // a search_manager holds search.tags.manage and the server said canManage
    expect(screen.queryByTestId("engagement-tags-not-built")).toBeNull();
    expect(screen.getByTestId("scope-editor")).toBeTruthy();
  });

  it("a user with NO WebDesk or Web Dev rights at all still gets the card: only the new reader is asked", async () => {
    vi.mocked(getMe).mockResolvedValue({ ...meOf("search_staff"), roles: [{ role: "search_staff", scopeType: "company", scopeId: "co-1" }] } as never);
    await mount();
    expect(siteMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("tracking-tags")).toBeTruthy();
    expect(screen.queryByTestId("engagement-tags-unavailable")).toBeNull();
  });

  it("read-only for a viewer without search.tags.manage", async () => {
    vi.mocked(getMe).mockResolvedValue(meOf("search_staff") as never);
    await mount();
    expect(screen.getByTestId("google-ads-ids").textContent).toBe("AW-123456789");
    expect(screen.queryByTestId("google-ads-form")).toBeNull();
  });

  it("site null: the plain note, no card, and the tags are never read", async () => {
    siteMock.mockResolvedValue(found(null));
    await mount();
    expect(screen.getByTestId("engagement-tags-not-built").textContent).toBe(
      "This client's website is not built by the ERP, so its Google Ads and LinkedIn tags are set on the website itself.");
    expect(screen.queryByTestId("tracking-tags")).toBeNull();
    expect(tagsMock).not.toHaveBeenCalled();
  });

  it("a refused lookup (403) is a sentence and the rest of the page still draws", async () => {
    siteMock.mockResolvedValue({ kind: "forbidden", message: "You do not have access to this client's property, so its website's tracking tags are not shown here." });
    await mount();
    expect(screen.getByTestId("engagement-tags-unavailable").textContent).toMatch(/do not have access/);
    expect(screen.queryByTestId("engagement-tags-not-built")).toBeNull();
    expect(screen.queryByTestId("tracking-tags")).toBeNull();
    expect(screen.getByTestId("scope-editor")).toBeTruthy();
    expect(screen.getByText("Acme SEO")).toBeTruthy();
  });

  it("a failed lookup is a sentence, never the 'not built' note, and the page draws", async () => {
    siteMock.mockResolvedValue({ kind: "unavailable", message: "The ERP could not list this company's websites just now." });
    await mount();
    expect(screen.getByTestId("engagement-tags-unavailable").textContent).toMatch(/could not list/);
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

  it("an engagement with no property shows no tags section and asks no lookup", async () => {
    vi.mocked(getEngagement).mockResolvedValue({ ...engagement, propertyId: null } as never);
    await mount();
    expect(siteMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("tracking-tags")).toBeNull();
    expect(screen.queryByTestId("engagement-tags-not-built")).toBeNull();
    expect(screen.getByTestId("scope-editor")).toBeTruthy();
  });
});
