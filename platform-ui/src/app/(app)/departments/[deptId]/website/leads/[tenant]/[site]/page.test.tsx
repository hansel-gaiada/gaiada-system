import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

// The Leads tab's page: the site (company wall), then the web leads for its WebDesk tenant slug. Anything that is not
// data is words, and a failed read never draws a table or an "empty" claim.

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/webdeskContent", () => ({ listSites: vi.fn() }));
vi.mock("@/lib/websiteLeads", () => ({ listWebLeads: vi.fn() }));
vi.mock("@/components/webdesk/content/serverCtx", () => ({ requireWebsiteCtx: vi.fn() }));

import { listSites } from "@/lib/webdeskContent";
import { listWebLeads } from "@/lib/websiteLeads";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import Page from "./page";

const sitesMock = vi.mocked(listSites);
const leadsMock = vi.mocked(listWebLeads);
const ctxMock = vi.mocked(requireWebsiteCtx);

const sites = () => ({ kind: "ok" as const, data: { tenants: [{ slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en"], sites: [{ siteId: "site-1", name: "gaiada.com", kind: "static", environments: [] }] }] } });
const attr = (o: Record<string, unknown> = {}) => ({ landing: null, formPage: null, referrer: null, utmSource: null, utmMedium: null, utmCampaign: null, clickIds: [], ...o });
const lead = (o: Record<string, unknown> = {}) => ({
  id: "lead-1", orgName: "Villa Sari", contactName: "Citra", originForm: "onboard", createdAt: "2026-10-10T09:05:00Z",
  status: "new", stage: "enquiry", attribution: attr(), marketingConsent: null, ...o,
});
const body = (leads: unknown[], o: Record<string, unknown> = {}) => ({ kind: "ok" as const, data: { leadIntakeEnabled: true, truncated: false, leads, ...o } });
const mount = async () => render(await Page({ params: Promise.resolve({ deptId: "dept-1", tenant: "gaiada", site: "site-1" }) }));

beforeEach(() => {
  ctxMock.mockReset(); sitesMock.mockReset(); leadsMock.mockReset();
  ctxMock.mockResolvedValue({ userId: "u", me: {}, company: "co-1", deptId: "dept-1", leadsBase: "/departments/dept-1/website/leads" } as never);
  sitesMock.mockResolvedValue(sites() as never);
});

describe("Website -> Leads -> site", () => {
  it("asks for the Leads tab context and reads the WebDesk tenant slug for this company", async () => {
    leadsMock.mockResolvedValue(body([lead()]) as never);
    await mount();
    expect(ctxMock).toHaveBeenCalledWith("dept-1", "leads");
    expect(leadsMock).toHaveBeenCalledWith("u", "co-1", "gaiada");
  });

  it("draws a row per lead: name, form, stage and status, a link to the existing lead page", async () => {
    leadsMock.mockResolvedValue(body([lead()]) as never);
    await mount();
    const row = screen.getByTestId("web-lead-row");
    expect(within(row).getByRole("link", { name: "Villa Sari" }).getAttribute("href")).toBe("/agency/leads/lead-1");
    expect(row.textContent).toContain("Citra");
    expect(row.textContent).toContain("onboard");
    expect(row.textContent).toContain("Enquiry");
    expect(row.textContent).toContain("10 Oct 2026");
  });

  it("shows attribution: landing, utm, and click-id PRESENCE only (gclid check), never a value", async () => {
    leadsMock.mockResolvedValue(body([lead({ attribution: attr({ landing: "/services/web/", utmSource: "google", utmMedium: "cpc", utmCampaign: "spring", referrer: "www.google.com", clickIds: ["gclid", "fbclid"] }) })]) as never);
    const { container } = await mount();
    expect(container.textContent).toContain("/services/web/");
    expect(container.textContent).toContain("google / cpc / spring");
    expect(container.textContent).toContain("from www.google.com");
    expect(screen.getAllByTestId("click-id").map((e) => e.textContent)).toEqual(["gclid ✓", "fbclid ✓"]);
  });

  it("consent badge: yes, no, and unknown are three different things (unknown is not consent)", async () => {
    leadsMock.mockResolvedValue(body([lead({ id: "a", marketingConsent: true }), lead({ id: "b", marketingConsent: false }), lead({ id: "c", marketingConsent: null })]) as never);
    await mount();
    expect(screen.getAllByTestId("consent-badge").map((e) => e.textContent)).toEqual(["Marketing consent", "No marketing consent", "Consent unknown"]);
  });

  it("keeps the server's order (newest first) and does not re-sort", async () => {
    leadsMock.mockResolvedValue(body([lead({ id: "n", orgName: "Newer", createdAt: "2026-10-11T09:00:00Z" }), lead({ id: "o", orgName: "Older", createdAt: "2026-10-01T09:00:00Z" })]) as never);
    await mount();
    expect(screen.getAllByTestId("web-lead-row").map((r) => r.querySelector("a")!.textContent)).toEqual(["Newer", "Older"]);
  });

  it("empty with intake on: the plain-words empty state, no table, no intake-off hint", async () => {
    leadsMock.mockResolvedValue(body([]) as never);
    const { container } = await mount();
    expect(container.textContent).toContain("No website leads yet. Leads appear here once the site's forms post to WebDesk and lead intake is switched on.");
    expect(container.querySelector("table")).toBeNull();
    expect(screen.queryByTestId("leads-intake-off")).toBeNull();
  });

  it("intake off: the hint shows (with the empty state), and still shows when old leads exist", async () => {
    leadsMock.mockResolvedValue(body([], { leadIntakeEnabled: false }) as never);
    await mount();
    expect(screen.getByTestId("leads-intake-off").textContent).toMatch(/Lead intake is off/);
  });

  it("intake off with leads already filed: hint and the rows", async () => {
    leadsMock.mockResolvedValue(body([lead()], { leadIntakeEnabled: false }) as never);
    await mount();
    expect(screen.getByTestId("leads-intake-off")).toBeTruthy();
    expect(screen.getAllByTestId("web-lead-row")).toHaveLength(1);
  });

  it("a truncated list says so", async () => {
    leadsMock.mockResolvedValue(body([lead()], { truncated: true }) as never);
    await mount();
    expect(screen.getByTestId("leads-truncated").textContent).toMatch(/newest 1/);
  });

  it("forbidden is a refusal notice, NOT an empty state and no table", async () => {
    leadsMock.mockResolvedValue({ kind: "forbidden", reason: "no" } as never);
    const { container } = await mount();
    expect(container.textContent).not.toContain("No website leads yet");
    expect(container.querySelector("table")).toBeNull();
    expect(screen.queryByTestId("website-leads")).toBeNull();
  });

  it("contract drift is the loud notice, not an empty list", async () => {
    leadsMock.mockResolvedValue({ kind: "unavailable", code: "contract_drift", reason: "web-leads.leads: expected an array" } as never);
    await mount();
    expect(screen.getByTestId("wd-contract-drift")).toBeTruthy();
    expect(screen.queryByTestId("website-leads")).toBeNull();
  });

  it("a site that is not this company's is not found and reads no leads", async () => {
    sitesMock.mockResolvedValue({ kind: "ok", data: { tenants: [] } } as never);
    await mount();
    expect(leadsMock).not.toHaveBeenCalled();
  });

  it("a failed site read is a refusal and reads no leads", async () => {
    sitesMock.mockResolvedValue({ kind: "forbidden", reason: "no" } as never);
    await mount();
    expect(leadsMock).not.toHaveBeenCalled();
  });
});
