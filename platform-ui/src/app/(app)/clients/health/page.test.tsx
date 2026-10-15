import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

// PV7-05 — the health board. Pinned: one h1; the rows come worst first and each name opens its client; the state, owner and
// department filters narrow them (the department through the clients list's own `departmentId` facet, ids from the org
// structure and never hard-coded); a source that could not be read is a banner that names it, its cells show a dash; a
// FAILED board read says "Could not be loaded" and draws no table (never an empty board); a failed department read does not
// draw an unfiltered board under a department chip.

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-1", companies: [], roles: [] })) }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("@/lib/entities", () => ({ readClients: vi.fn() }));
vi.mock("@/lib/departments", () => ({ listDepartmentBriefs: vi.fn() }));
vi.mock("@/lib/clientHub", () => ({ getClientHealthBoard: vi.fn() }));

import { readClients } from "@/lib/entities";
import { listDepartmentBriefs } from "@/lib/departments";
import { getClientHealthBoard } from "@/lib/clientHub";
import type { ClientHealthBoard, ClientHealthRow, ClientHealthSignals, HealthSource, HealthState } from "@/lib/clientHealth";
import ClientHealthBoardPage from "./page";

const ASOF = "2026-10-15T12:00:00.000Z";
const daysAgo = (n: number) => new Date(Date.parse(ASOF) - n * 86_400_000).toISOString();
const SIGNALS: ClientHealthSignals = {
  waitingOnUs: { count: 0, oldestSince: null }, waitingOnClient: { count: 0, oldestSince: null },
  lateDeliverables: { count: 0, oldestDue: null }, lateMilestones: { count: 0, oldestDue: null },
  openChangeRequests: 1, conversationsAwaitingReply: 2, overdueInvoices: { count: 0, oldestDue: null },
  site: { openIncidents: 0, oldestOpenSince: null, uptime30d: 99.5 }, deliveryOnTime: 0.8, activeProjects: 2, activeServices: 0,
};
const row = (id: string, name: string, state: HealthState, over: Partial<ClientHealthSignals> = {}, owner: [string, string] | null = null): ClientHealthRow => ({
  clientId: id, name, status: "active", ownerUserId: owner?.[0] ?? null, ownerName: owner?.[1] ?? null, state,
  reasons: state === "off_track" ? [{ code: "waiting_on_us_14d", count: 1, since: daysAgo(15) }] : [], signals: { ...SIGNALS, ...over },
});
const board = (clients: ClientHealthRow[], unavailable: HealthSource[] = []): { kind: "ok"; data: ClientHealthBoard } =>
  ({ kind: "ok", data: { asOf: ASOF, onTimeKnownSince: null, clients, unavailable } });

const CLIENTS = [
  row("c-quiet", "Quiet Co", "quiet"),
  row("c-ok", "Fine Co", "on_track", {}, ["u-2", "Bo Owner"]),
  row("c-off", "Late Co", "off_track", { waitingOnUs: { count: 2, oldestSince: daysAgo(15) } }, ["u-1", "Una Owner"]),
  row("c-risk", "Risky Co", "at_risk", { waitingOnUs: { count: 1, oldestSince: daysAgo(8) }, deliveryOnTime: null }, ["u-1", "Una Owner"]),
];

const mount = async (search: Record<string, string> = {}) => render(await ClientHealthBoardPage({ searchParams: Promise.resolve(search) }));
const names = () => [...document.querySelectorAll("tbody tr")].map((tr) => tr.querySelector("a.dt__link")?.textContent ?? "");

beforeEach(() => {
  vi.mocked(getClientHealthBoard).mockReset();
  vi.mocked(readClients).mockReset();
  vi.mocked(listDepartmentBriefs).mockReset();
  vi.mocked(getClientHealthBoard).mockResolvedValue(board(CLIENTS) as never);
  vi.mocked(listDepartmentBriefs).mockResolvedValue([{ id: "d-hr-co-1", name: "HR" }, { id: "d-web", name: "Web Dev" }]);
});

describe("Clients › Health · the board", () => {
  it("has exactly one h1", async () => {
    await mount();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Client health");
  });

  it("lists clients worst first, and every name opens its client", async () => {
    await mount();
    expect(names()).toEqual(["Late Co", "Risky Co", "Fine Co", "Quiet Co"]);
    expect(screen.getByRole("link", { name: "Late Co" }).getAttribute("href")).toBe("/clients/c-off");
    expect(screen.getByRole("link", { name: "Quiet Co" }).getAttribute("href")).toBe("/clients/c-quiet");
  });

  it("shows the state chip with its reasons in short words, and the figures", async () => {
    await mount();
    const late = screen.getByRole("link", { name: "Late Co" }).closest("tr")!;
    expect(within(late).getByText("Off track")).toBeTruthy();
    expect(late.textContent).toContain("Waiting on us 14+ days");
    expect(late.textContent).toContain("2 · oldest 15 days");
    const risky = screen.getByRole("link", { name: "Risky Co" }).closest("tr")!;
    expect(risky.textContent).toContain("1 · oldest 8 days");
    expect(within(late).getByText("80%")).toBeTruthy(); // delivery on time this month
    expect(risky.textContent).not.toContain("0%"); // null on time is a dash, never 0%
  });

  it("filters by state, and the facet counts are shown", async () => {
    await mount({ state: "at_risk" });
    expect(names()).toEqual(["Risky Co"]);
    const facet = screen.getByRole("group", { name: "Filter by health" });
    expect(within(facet).getByRole("link", { name: /Off track/ }).getAttribute("href")).toBe("/clients/health?state=off_track");
    expect(within(facet).getByRole("link", { name: /At risk/ }).getAttribute("href")).toBe("/clients/health"); // the active chip clears itself
  });

  it("filters by owner, including the people with no owner, and keeps the other filters in the links", async () => {
    await mount({ owner: "u-1", state: "off_track" });
    expect(names()).toEqual(["Late Co"]);
    cleanup();
    await mount({ owner: "u-1" });
    expect(names()).toEqual(["Late Co", "Risky Co"]);
    const owners = screen.getByRole("group", { name: "Filter by owner" });
    expect(within(owners).getByRole("link", { name: /No owner/ }).getAttribute("href")).toBe("/clients/health?owner=none");
    // The state facet keeps the owner filter in its links.
    expect(within(screen.getByRole("group", { name: "Filter by health" })).getByRole("link", { name: /Off track/ }).getAttribute("href")).toBe("/clients/health?state=off_track&owner=u-1");
  });

  it("filters by department through the clients list's departmentId facet, with ids from the org structure", async () => {
    vi.mocked(readClients).mockResolvedValue({ kind: "ok", data: [{ id: "c-ok" }, { id: "c-risk" }] } as never);
    await mount({ department: "d-hr-co-1" });
    expect(vi.mocked(readClients)).toHaveBeenCalledWith("u-1", "co-1", "d-hr-co-1");
    expect(names()).toEqual(["Risky Co", "Fine Co"]);
    expect(within(screen.getByRole("group", { name: "Filter by department" })).getByRole("link", { name: "HR" })).toBeTruthy();
  });

  it("ignores a department that is not in the company's org structure (no read, no filter)", async () => {
    await mount({ department: "d-hr-someone-else" });
    expect(vi.mocked(readClients)).not.toHaveBeenCalled();
    expect(names()).toHaveLength(4);
  });

  it("🔴 a failed department read does not draw an unfiltered board under the department chip", async () => {
    vi.mocked(readClients).mockResolvedValue({ kind: "unavailable", reason: "boom" } as never);
    await mount({ department: "d-web" });
    expect(screen.getByRole("alert").textContent).toMatch(/Could not be loaded/);
    expect(document.querySelector("table")).toBeNull();
  });

  it("names the sources that could not be read in a banner, and a source that makes a state unknown says so", async () => {
    vi.mocked(getClientHealthBoard).mockResolvedValue(board(CLIENTS, ["site", "invoices"]) as never);
    await mount();
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Could not be read: site monitoring, invoices.");
    expect(banner.textContent).toContain("Unknown");
  });

  it("a failed delivery-on-time read is named, but does not claim a state became Unknown", async () => {
    vi.mocked(getClientHealthBoard).mockResolvedValue(board(CLIENTS, ["reports"]) as never);
    await mount();
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("delivery on time");
    expect(banner.textContent).not.toContain("Unknown");
  });

  it("no banner when every source answered", async () => {
    await mount();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("🔴 a failed board read says Could not be loaded and draws no table: never an empty board", async () => {
    vi.mocked(getClientHealthBoard).mockResolvedValue({ kind: "unavailable", reason: "503" });
    await mount();
    expect(screen.getByRole("alert").textContent).toMatch(/Could not be loaded/);
    expect(document.querySelector("table")).toBeNull();
    expect(screen.queryByText(/No clients/)).toBeNull();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("a refused board read says the viewer has no access", async () => {
    vi.mocked(getClientHealthBoard).mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText(/You don.t have access to the client health board/)).toBeTruthy();
    expect(document.querySelector("table")).toBeNull();
  });

  it("a company with no clients says so (a real, successful, empty answer)", async () => {
    vi.mocked(getClientHealthBoard).mockResolvedValue(board([]) as never);
    await mount();
    expect(screen.getByText("No clients to show yet.")).toBeTruthy();
  });
});
