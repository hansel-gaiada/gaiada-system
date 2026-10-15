import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { PortalHealth, PortalOverview } from "@/lib/portal";
import type { BusinessResults } from "@/lib/clientCentre";

// PV7-03: the portal Overview's "Project health" and "Results at a glance" blocks. The four states that matter:
// a client-wide contact (everything), a contact limited to some projects (no client-wide items, the PV-D37 results
// line), a failed read (always "Could not be loaded", never 0, an empty list or a healthy-looking project), and the
// fact that the portal never draws a health STATE (L3).

vi.mock("next/navigation", () => ({ redirect: vi.fn((to: string) => { throw new Error(`REDIRECT:${to}`); }) }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-1", name: "Dana", companies: [], roles: [{ role: "client", scopeType: "global", scopeId: null }] })) }));
vi.mock("@/lib/portal-company", () => ({ getActivePortalCompany: vi.fn(async () => ({ id: "co-1" })) }));
vi.mock("@/lib/portal-data", () => ({ getPortalOverview: vi.fn(), getPortalHealth: vi.fn() }));
vi.mock("@/lib/clientCentre-data", () => ({ getPortalCentreResults: vi.fn() }));
vi.mock("@/components/portal/PortalLive", () => ({ PortalLive: () => null }));

import PortalOverviewPage from "./page";
import { getPortalHealth, getPortalOverview } from "@/lib/portal-data";
import { getPortalCentreResults } from "@/lib/clientCentre-data";
import { RESULTS_HIDDEN_COPY } from "@/components/client-centre/ResultsView";

const NW = { id: "cl-1", name: "Northwind Traders", status: "active" };
const HB = { id: "cl-hb", name: "Harbour Hotel", status: "active" };

function overview(clients = [NW]): PortalOverview {
  return {
    clients, client: clients[0], viewOnly: false,
    progress: { projects: 2, activeProjects: 2, completedProjects: 0, percent: 40 },
    deliverables: { total: 3, delivered: 1, overdue: 1 },
    nextMilestone: null, needsYou: [], finance: { byCurrency: [], primary: null },
  };
}

const ball = (count: number, items: Array<{ kind: string; id: string; context: string | null; since: string | null }> = []) =>
  ({ count, oldestSince: items[0]?.since ?? null, items });

function nwHealth(over: Partial<PortalHealth["clients"][number]> = {}): PortalHealth["clients"][number] {
  return {
    clientId: "cl-1", name: "Northwind Traders", wide: true,
    projects: [
      {
        projectId: "p-site", name: "Website relaunch", status: "active",
        milestones: { total: 5, done: 2, upcoming: 2, late: 1, undated: 0 },
        deliverables: { total: 4, delivered: 3, late: 1 },
        nextMilestone: { id: "m-3", name: "Build and content load", dueDate: "2026-10-24" },
        waitingOnYou: ball(2, [
          { kind: "gate", id: "gate-9", context: "Website relaunch", since: "2026-10-12T08:00:00.000Z" },
          { kind: "contract", id: "ctr-7", context: "Statement of Work", since: "2026-10-13T08:00:00.000Z" },
        ]),
        waitingOnUs: ball(1, [{ kind: "payment", id: "pay-3", context: null, since: "2026-10-09T08:00:00.000Z" }]),
      },
      {
        projectId: "p-old", name: "Campaign Q4 2025", status: "completed",
        milestones: { total: 2, done: 2, upcoming: 0, late: 0, undated: 0 },
        deliverables: { total: 4, delivered: 4, late: 0 },
        nextMilestone: null, waitingOnYou: ball(0), waitingOnUs: ball(0),
      },
    ],
    clientWide: {
      waitingOnYou: ball(0),
      waitingOnUs: ball(1, [{ kind: "conversation", id: "th-general", context: "General conversation", since: "2026-10-10T08:00:00.000Z" }]),
    },
    turnaround: { windowDays: 90, client: { medianDays: 2.5, n: 7, withheld: false }, ours: { medianDays: 1, n: 9, withheld: false } },
    ...over,
  };
}
const health = (clients: PortalHealth["clients"], unavailable: PortalHealth["unavailable"] = []): PortalHealth => ({ asOf: "2026-10-15T09:00:00.000Z", clients, unavailable });

const kpi = (key: string, label: string, value: number | null) => ({
  key, label, value, unit: "count" as const, period: { from: "2026-09-01", to: "2026-09-30" }, previous: null, target: null, asOf: null,
});
const card = (service: "social" | "search" | "search_ads" | "analytics" | "website", areaId: string, title: string, kpis: ReturnType<typeof kpi>[]) =>
  ({ service, areaId, title, status: "active" as const, since: null, items: [], kpis, clientVisible: true as const });
const resultsOf = (over: Partial<BusinessResults> = {}): BusinessResults => ({
  clientId: "cl-1", generatedAt: "2026-10-13T00:00:00Z", visible: true, unavailable: [],
  services: [
    card("social", "mk_social", "Social media", [kpi("followers", "Followers", 12400)]),
    card("search", "se", "Search", [kpi("organic_sessions", "Organic sessions", 8200)]),
    card("search_ads", "mk_paid", "Paid search", [kpi("conversion_value", "Conversion value (USD)", 18450), kpi("clicks", "Clicks", 3150)]),
    card("analytics", "mk_analytics", "Analytics", [kpi("sessions", "Sessions", null)]),
    card("website", "mk_web", "Website", []),
  ],
  ...over,
});

async function renderPage() {
  render(await PortalOverviewPage());
  return screen.getByText("Project health").closest("section") as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPortalOverview).mockResolvedValue({ overview: overview(), isPortalClient: true });
  vi.mocked(getPortalHealth).mockResolvedValue(health([nwHealth()]));
  vi.mocked(getPortalCentreResults).mockResolvedValue(resultsOf());
});

describe("Portal Overview · Project health (client-wide contact)", () => {
  it("one client: no client heading; per project the milestones, late deliverables, next milestone; the finished project is not listed", async () => {
    const card = await renderPage();
    const w = within(card);
    expect(w.queryByRole("heading", { name: "Northwind Traders" })).toBeNull();
    expect(w.getByRole("link", { name: "Website relaunch" }).getAttribute("href")).toBe("/portal/projects/p-site");
    expect(w.getByText(/2 done · 2 coming up ·/)).toBeTruthy();
    // Milestones 1 late and deliverables 1 late: both carry the late style.
    expect(w.getAllByText("1 late", { selector: "span" }).map((e) => e.className)).toEqual(["cp-hfacts__late", "cp-hfacts__late"]);
    expect(w.getByText(/3 of 4 delivered ·/)).toBeTruthy();
    expect(w.getByText(/Build and content load · 24 Oct 2026/)).toBeTruthy();
    expect(w.queryByText("Campaign Q4 2025")).toBeNull();
    expect(w.getByText(/1 finished project is under/)).toBeTruthy();
  });

  it("'Waiting on you' and 'Waiting on us' say the count and the oldest date, and each item links where the client acts", async () => {
    const w = within(await renderPage());
    const proj = w.getByText("Website relaunch").closest("[data-project]") as HTMLElement;
    const p = within(proj);
    expect(p.getByText("Waiting on you: 2, oldest since 12 Oct 2026")).toBeTruthy();
    expect(p.getByText("Waiting on us: 1, oldest since 09 Oct 2026")).toBeTruthy();
    // A gate id is not a run id: it links to the approvals list.
    expect(p.getByRole("link", { name: "An approval for you" }).getAttribute("href")).toBe("/portal/approvals");
    expect(p.getByRole("link", { name: "An agreement to sign" }).getAttribute("href")).toBe("/portal/contracts/ctr-7");
    expect(p.getByRole("link", { name: "A payment we are confirming" }).getAttribute("href")).toBe("/portal/invoices");
    // A payment carries no amount.
    expect(proj.textContent).not.toMatch(/IDR|USD|\d{1,3}(,\d{3})+/);
  });

  it("client-wide items appear for a client-wide contact, in their own part", async () => {
    const w = within(await renderPage());
    const wide = document.querySelector('[data-scope="client-wide"]') as HTMLElement;
    expect(wide).toBeTruthy();
    expect(within(wide).getByText("Waiting on us: 1, oldest since 10 Oct 2026")).toBeTruthy();
    expect(within(wide).getByRole("link", { name: "A message waiting for our reply" }).getAttribute("href")).toBe("/portal/conversation/th-general");
    expect(w.getByText("Across your whole account")).toBeTruthy();
  });

  it("turnaround reads 'You usually reply in N days · We usually reply in N days (last 90 days)'", async () => {
    const w = within(await renderPage());
    expect(w.getByText("You usually reply in 2.5 days · We usually reply in 1 day (last 90 days)")).toBeTruthy();
  });

  it("🔴 the portal never draws a health state or a verdict (L3)", async () => {
    const card = await renderPage();
    expect(card.textContent).not.toMatch(/on track|at risk|off track|healthy|unhealthy|behind schedule/i);
    expect(document.body.textContent).not.toMatch(/off track|at risk/i);
  });

  it("a section named in unavailable[] reads 'Could not be loaded' even if the payload still carries it", async () => {
    vi.mocked(getPortalHealth).mockResolvedValue(health([nwHealth()], ["turnaround"]));
    const w = within(await renderPage());
    expect(w.getByText(/Reply times: Could not be loaded/)).toBeTruthy();
    expect(w.queryByText(/usually reply in/)).toBeNull();
  });
});

describe("Portal Overview · Project health (failed and partial reads)", () => {
  it("🔴 a failed health read says so and shows no project, no zero and no empty-list claim", async () => {
    vi.mocked(getPortalHealth).mockResolvedValue(null);
    const card = await renderPage();
    expect(within(card).getByText(/Project health: Could not be loaded/)).toBeTruthy();
    expect(card.textContent).not.toMatch(/Website relaunch|nothing|No active projects|0 late|0 done/);
  });

  it("🔴 projects: null reads 'Could not be loaded', never 'No active projects'", async () => {
    vi.mocked(getPortalHealth).mockResolvedValue(health([nwHealth({ projects: null })], ["projects"]));
    const w = within(await renderPage());
    expect(w.getByText(/Projects: Could not be loaded/)).toBeTruthy();
    expect(w.queryByText(/No active projects/)).toBeNull();
  });

  it("🔴 a failed ball read says 'Could not be loaded' on both sides, never 'nothing'", async () => {
    const c = nwHealth();
    c.projects![0] = { ...c.projects![0], waitingOnYou: null, waitingOnUs: null };
    vi.mocked(getPortalHealth).mockResolvedValue(health([{ ...c, clientWide: null }], ["ball"]));
    const w = within(await renderPage());
    expect(w.getByText("Waiting on you: Could not be loaded")).toBeTruthy();
    expect(w.getByText("Waiting on us: Could not be loaded")).toBeTruthy();
    expect(w.queryByText(/Waiting on (you|us): nothing/)).toBeNull();
  });

  it("a null turnaround reads 'Could not be loaded'; a withheld side reads 'Not enough yet'", async () => {
    vi.mocked(getPortalHealth).mockResolvedValue(health([nwHealth({ turnaround: null })]));
    expect(within(await renderPage()).getByText(/Reply times: Could not be loaded/)).toBeTruthy();
    document.body.innerHTML = "";
    vi.mocked(getPortalHealth).mockResolvedValue(health([nwHealth({
      turnaround: { windowDays: 90, client: { medianDays: 2, n: 5, withheld: false }, ours: { medianDays: null, n: 2, withheld: true } },
    })]));
    expect(within(await renderPage()).getByText("You usually reply in 2 days · Not enough yet to say how quickly we reply (last 90 days)")).toBeTruthy();
  });

  it("a full list is capped by the payload: 'Showing the oldest 25 of N'", async () => {
    const c = nwHealth();
    const items = Array.from({ length: 25 }, (_, i) => ({ kind: "request", id: `cr-${i}`, context: `Req ${i}`, since: "2026-10-01T00:00:00.000Z" }));
    c.projects![0] = { ...c.projects![0], waitingOnUs: ball(31, items) };
    c.projects![0].waitingOnUs!.oldestSince = "2026-10-01T00:00:00.000Z";
    vi.mocked(getPortalHealth).mockResolvedValue(health([c]));
    const w = within(await renderPage());
    expect(w.getByText("Showing the oldest 25 of 31.")).toBeTruthy();
    expect(w.getByText("Waiting on us: 31, oldest since 01 Oct 2026")).toBeTruthy();
  });
});

describe("Portal Overview · a contact limited to some projects (PV7-Q2, PV-D37)", () => {
  const scoped = nwHealth({
    clientId: "cl-hb", name: "Harbour Hotel", wide: false, clientWide: null,
    projects: [{
      projectId: "p-spa", name: "Spa booking page", status: "active",
      milestones: { total: 3, done: 1, upcoming: 2, late: 0, undated: 0 },
      deliverables: { total: 2, delivered: 1, late: 0 },
      nextMilestone: null, waitingOnYou: ball(0), waitingOnUs: ball(0),
    }],
  });

  beforeEach(() => {
    vi.mocked(getPortalOverview).mockResolvedValue({ overview: overview([NW, HB]), isPortalClient: true });
    vi.mocked(getPortalHealth).mockResolvedValue(health([nwHealth(), scoped]));
    vi.mocked(getPortalCentreResults).mockImplementation(async (_u, _t, clientId) =>
      clientId === "cl-hb" ? resultsOf({ clientId: "cl-hb", visible: false, services: [] }) : resultsOf());
  });

  it("two clients: each gets a heading, and the limited one shows no client-wide part", async () => {
    const card = await renderPage();
    const w = within(card);
    expect(w.getByRole("heading", { name: "Northwind Traders" })).toBeTruthy();
    expect(w.getByRole("heading", { name: "Harbour Hotel" })).toBeTruthy();
    const hb = card.querySelector('[data-client="cl-hb"]') as HTMLElement;
    expect(within(hb).getByText("Spa booking page")).toBeTruthy();
    expect(hb.querySelector('[data-scope="client-wide"]')).toBeNull();
    // Northwind (client-wide) still has its.
    expect((card.querySelector('[data-client="cl-1"]') as HTMLElement).querySelector('[data-scope="client-wide"]')).toBeTruthy();
  });

  it("🔴 results: the limited contact gets the PV-D37 sentence, the client-wide one gets figures", async () => {
    await renderPage();
    const glance = screen.getByText("Results at a glance").closest("section") as HTMLElement;
    const hb = glance.querySelector('[data-client="cl-hb"]') as HTMLElement;
    expect(hb.textContent).toContain(RESULTS_HIDDEN_COPY);
    expect(hb.textContent).not.toMatch(/Followers|Sessions/);
    const nw = glance.querySelector('[data-client="cl-1"]') as HTMLElement;
    expect(within(nw).getByText("Followers")).toBeTruthy();
  });
});

describe("Portal Overview · Results at a glance", () => {
  it("up to four first-KPI figures of the active services; 'Not measured yet' for null; never conversion_value; one link to Services & results", async () => {
    await renderPage();
    const glance = screen.getByText("Results at a glance").closest("section") as HTMLElement;
    const g = within(glance);
    expect(g.getByText("Followers")).toBeTruthy();
    expect(g.getByText("12,400")).toBeTruthy();
    expect(g.getByText("Organic sessions")).toBeTruthy();
    // search_ads: conversion_value is skipped for the card's next figure.
    expect(g.getByText("Clicks")).toBeTruthy();
    expect(glance.textContent).not.toMatch(/Conversion value|18,450/);
    expect(g.getByText("Sessions")).toBeTruthy();
    expect(g.getByText("Not measured yet")).toBeTruthy();
    expect(g.getAllByText(/Followers|Organic sessions|Clicks|Sessions/).length).toBeGreaterThanOrEqual(4);
    expect(g.getByRole("link", { name: /Services & results/ }).getAttribute("href")).toBe("/portal/company");
    expect(glance.querySelector("h4")).toBeNull();
  });

  it("🔴 a failed results read says 'could not be loaded', not 'no results' and not 0", async () => {
    vi.mocked(getPortalCentreResults).mockResolvedValue(null);
    const glance = (await renderPage(), screen.getByText("Results at a glance").closest("section") as HTMLElement);
    expect(within(glance).getByText(/Results: Could not be loaded/)).toBeTruthy();
    expect(glance.textContent).not.toMatch(/No service|0/);
  });

  it("a service that failed to load is said, and 'no service running' is not claimed over it", async () => {
    vi.mocked(getPortalCentreResults).mockResolvedValue(resultsOf({ services: [], unavailable: ["analytics"] }));
    const glance = (await renderPage(), screen.getByText("Results at a glance").closest("section") as HTMLElement);
    expect(glance.textContent).toContain("Some results could not be loaded");
    expect(glance.textContent).not.toContain("No service with results is running yet");
  });
});
