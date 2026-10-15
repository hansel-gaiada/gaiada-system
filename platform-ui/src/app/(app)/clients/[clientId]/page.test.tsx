import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ClientOverview } from "@/lib/clientHub";
import type { ClientHealthDetail } from "@/lib/clientHealth";

// PV7-03: where the Health card sits on the hub Overview, and that a failed health read does not take the page down or
// invent a state. The card's own states are pinned in components/clients/ClientHealthCard.test.tsx.

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
  redirect: vi.fn((to: string) => { throw new Error(`REDIRECT:${to}`); }),
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-1", companies: [], roles: [] })) }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("@/lib/clientHub", () => ({ getClientOverview: vi.fn(), getClientHealth: vi.fn() }));
vi.mock("@/components/clients/EmailClientButton", () => ({ EmailClientButton: () => null }));

import ClientOverviewPage from "./page";
import { getClientHealth, getClientOverview } from "@/lib/clientHub";

const overview: ClientOverview = {
  client: { id: "cl-1", name: "Northwind Traders", status: "active", contact: { email: "ops@northwind.example" } },
  projects: { total: 1, active: 1, done: 0, percent: 10 },
  tasks: { total: 4, open: 3, overdue: 0, blocked: 0 },
  deliverables: { total: 3, delivered: 1, overdue: 1 },
  nextMilestone: null,
  money: { byCurrency: [], primary: null },
  needsUs: [{ kind: "request", id: "dcr-1", label: "Triage a new change request", context: "Update the pricing page copy", href: "/clients/cl-1/work", since: "2026-10-13T00:00:00.000Z", clientVisible: true }],
  needsClient: [{ kind: "review", id: "drv-1", label: "Awaiting client post approval", context: "Launch announcement", href: "/clients/cl-1/work", since: "2026-10-12T00:00:00.000Z", clientVisible: true }],
};

const health: ClientHealthDetail = {
  clientId: "cl-1", name: "Northwind Traders", status: "active", ownerUserId: null, ownerName: null,
  state: "at_risk", reasons: [{ code: "late_work", count: 1, since: "2026-10-10" }],
  signals: {
    waitingOnUs: { count: 1, oldestSince: "2026-10-13T00:00:00.000Z" }, waitingOnClient: { count: 1, oldestSince: "2026-10-12T00:00:00.000Z" },
    lateDeliverables: { count: 1, oldestDue: "2026-10-10" }, lateMilestones: { count: 0, oldestDue: null },
    openChangeRequests: 1, conversationsAwaitingReply: 0, overdueInvoices: { count: 0, oldestDue: null },
    site: null, deliveryOnTime: null, activeProjects: 1, activeServices: 0,
  },
  asOf: "2026-10-15T12:00:00.000Z", onTimeKnownSince: null, unavailable: [],
  projects: [], turnaround: null,
};

const run = async () => render(await ClientOverviewPage({ params: Promise.resolve({ clientId: "cl-1" }) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getClientOverview).mockResolvedValue(overview);
  vi.mocked(getClientHealth).mockResolvedValue(health);
});

describe("Client hub Overview · Health card placement", () => {
  it("the Health card follows the two ball lists and precedes the tiles; each waiting item is listed once", async () => {
    await run();
    const text = document.body.textContent ?? "";
    const waitingUs = text.indexOf("Waiting on us");
    const waitingClient = text.indexOf("Waiting on the client");
    const healthAt = text.indexOf("At risk");
    const tiles = text.indexOf("Active projects");
    expect(waitingUs).toBeGreaterThan(-1);
    expect(waitingClient).toBeGreaterThan(waitingUs);
    expect(healthAt).toBeGreaterThan(waitingClient);
    expect(tiles).toBeGreaterThan(healthAt);
    // The existing lists keep their items, and the Health card adds none of them again.
    expect(screen.getAllByText("Triage a new change request")).toHaveLength(1);
    expect(screen.getAllByText("Awaiting client post approval")).toHaveLength(1);
    expect(screen.getByText("At risk").getAttribute("data-state")).toBe("at_risk");
  });

  it("🔴 a failed health read leaves the page (and its lists) intact, says so, and shows no state", async () => {
    vi.mocked(getClientHealth).mockResolvedValue(null);
    await run();
    expect(screen.getByText(/Health: Could not be loaded/)).toBeTruthy();
    expect(screen.getByText("Triage a new change request")).toBeTruthy();
    expect(document.querySelector("[data-state]")).toBeNull();
  });

  it("a client that does not exist is still a 404, whatever the health read says", async () => {
    vi.mocked(getClientOverview).mockResolvedValue(null);
    await expect(run()).rejects.toThrow("NOT_FOUND");
  });
});
