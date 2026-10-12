import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";

// The Experiments tab: the list (server order, status as words) and the register form (underpowered in words).

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/webdeskContent", () => ({ listSites: vi.fn() }));
vi.mock("@/lib/experiments", () => ({ readSiteExperiments: vi.fn() }));
vi.mock("@/lib/experimentsActions", () => ({ registerExperimentAction: vi.fn() }));
vi.mock("@/components/webdesk/content/serverCtx", () => ({ requireWebsiteCtx: vi.fn() }));

import { listSites } from "@/lib/webdeskContent";
import { readSiteExperiments } from "@/lib/experiments";
import { registerExperimentAction } from "@/lib/experimentsActions";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import type { Status } from "@/lib/experimentsModel";
import Page from "./page";

const sitesMock = vi.mocked(listSites);
const readMock = vi.mocked(readSiteExperiments);
const ctxMock = vi.mocked(requireWebsiteCtx);
const regMock = vi.mocked(registerExperimentAction);

const sites = () => ({ kind: "ok" as const, data: { tenants: [{ slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en"], sites: [{ siteId: "site-1", name: "gaiada.com", kind: "static", environments: [{ envId: "e", name: "live", domain: "gaiada.com", status: "active" }] }] }] } });
const exp = (key: string, status: Status) => ({
  id: `id-${key}`, propertyId: "p1", key, status, hypothesis: `hyp ${key}`, item: { tenantSlug: "gaiada", siteId: "site-1", itemId: "i", collectionKey: "pages", locale: "en" },
  sectionId: "hero", goal: { event: "generate_lead" }, arms: [{ key: "a", weight: 50 }, { key: "b", weight: 50 }], enrolment: "consented",
  preRegistration: { baselineRate: 0.03, baselineSource: "supplied", relativeMde: 0.2, alpha: 0.05, power: 0.8, nPerArm: 800, dailyUnits: 100, projectedDays: 16, locked: status !== "draft" },
  startedAt: null, stoppedAt: null, createdAt: "x",
});
const meWith = (role: string) => ({ roles: [{ role, scopeType: "company", scopeId: "co-1" }] });
const mount = async () => render(await Page({ params: Promise.resolve({ deptId: "dept-1", tenant: "gaiada", site: "site-1" }) }));

beforeEach(() => {
  ctxMock.mockReset(); sitesMock.mockReset(); readMock.mockReset(); regMock.mockReset();
  ctxMock.mockResolvedValue({ userId: "u", me: meWith("search_manager"), company: "co-1", deptId: "dept-1", analyticsBase: "/departments/dept-1/website/analytics" } as never);
  sitesMock.mockResolvedValue(sites());
});

describe("Website -> Analytics -> site -> Experiments", () => {
  it("asks for the Analytics tab context (404s where the toolkit lacks it) and passes the domains", async () => {
    readMock.mockResolvedValue({ kind: "ok", propertyId: "p1", experiments: [] });
    await mount();
    expect(ctxMock).toHaveBeenCalledWith("dept-1", "analytics");
    expect(readMock).toHaveBeenCalledWith("u", "co-1", ["gaiada.com"]);
  });
  it("404s for a user without search view", async () => {
    ctxMock.mockResolvedValue({ userId: "u", me: meWith("member"), company: "co-1", deptId: "dept-1", analyticsBase: "/a" } as never);
    await expect(mount()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(readMock).not.toHaveBeenCalled();
  });
  it("keeps the server order and says status in words", async () => {
    readMock.mockResolvedValue({ kind: "ok", propertyId: "p1", experiments: [exp("zeta", "running"), exp("alpha", "stopped"), exp("mid", "draft"), exp("old", "aborted")] });
    await mount();
    const rows = within(screen.getByTestId("exp-list")).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.querySelector("a")!.textContent)).toEqual(["zeta", "alpha", "mid", "old"]);
    expect(rows[0].textContent).toContain("Running");
    expect(rows[1].textContent).toContain("Stopped: waiting for the decision");
    expect(rows[2].textContent).toContain("Draft: registered, not live yet");
    expect(rows[3].textContent).toContain("Aborted: no result");
    expect(rows[0].querySelector("a")!.getAttribute("href")).toBe("/departments/dept-1/website/analytics/gaiada/site-1/experiments/id-zeta");
  });
  it("no tests yet: words", async () => {
    readMock.mockResolvedValue({ kind: "ok", propertyId: "p1", experiments: [] });
    await mount();
    expect(screen.getByTestId("exp-empty").textContent).toContain("No tests registered");
    expect(screen.queryByTestId("exp-list")).toBeNull();
  });
  it("no search property: an explanation, no form", async () => {
    readMock.mockResolvedValue({ kind: "no_property" });
    await mount();
    expect(screen.getByText(/No search property matches gaiada.com/)).toBeTruthy();
    expect(screen.queryByTestId("exp-register")).toBeNull();
  });
  it("a refused read is a refusal, not an empty list", async () => {
    readMock.mockResolvedValue({ kind: "forbidden", reason: "no" } as never);
    await mount();
    expect(screen.queryByTestId("experiments")).toBeNull();
  });
  it("an unknown site reads nothing", async () => {
    sitesMock.mockResolvedValue({ kind: "ok", data: { tenants: [] } } as never);
    await mount();
    expect(readMock).not.toHaveBeenCalled();
  });
  it("register: underpowered shows days against the 56-day cap in words, and the sent body has no alpha or power", async () => {
    readMock.mockResolvedValue({ kind: "ok", propertyId: "p1", experiments: [] });
    regMock.mockResolvedValue({ ok: false, message: "This test would need about 120 days at the section's recent traffic, and a test may run for at most 56 days." });
    await mount();
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "hero" } });
    fireEvent.change(screen.getByLabelText("What do you expect, and why?"), { target: { value: "bigger button" } });
    fireEvent.change(screen.getByLabelText("Page id"), { target: { value: "item-1" } });
    fireEvent.change(screen.getByLabelText("Section id"), { target: { value: "hero" } });
    fireEvent.submit(screen.getByTestId("exp-register"));
    await waitFor(() => expect(screen.getByTestId("exp-register-msg")).toBeTruthy());
    expect(screen.getByTestId("exp-register-msg").textContent).toMatch(/120 days.*56 days/);
    expect(screen.getByTestId("exp-register-msg").getAttribute("role")).toBe("alert");
    expect(regMock).toHaveBeenCalledWith("p1", { tenantSlug: "gaiada", siteId: "site-1" }, expect.objectContaining({ key: "hero", itemId: "item-1", weightA: "50", weightB: "50" }));
    expect(JSON.stringify(regMock.mock.calls[0])).not.toMatch(/alpha|power/);
    expect(screen.getByText(/Significance is fixed at 5% and power at 80%/)).toBeTruthy();
  });
});
