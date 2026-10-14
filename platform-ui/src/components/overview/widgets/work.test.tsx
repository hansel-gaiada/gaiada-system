import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OVERVIEW_WIDGETS, hasOverviewWidget, type OverviewWidgetProps } from "./index";
import { Projects } from "./Projects";
import { Campaigns } from "./Campaigns";
import { Requests } from "./Requests";
import { subjectOfRef } from "@/lib/overview";
import { workLinks } from "@/lib/overviewWork";
import { resolveMyWorkspaces } from "@/lib/workspaceAccess";
import { agencyTree, me as meFixture, member } from "@/lib/workspaceFixtures";
import { PlatformError } from "@/lib/platform";
import * as entities from "@/lib/entities";
import * as pm from "@/lib/pm";
import * as campaigns from "@/lib/campaigns-data";
import * as requests from "@/lib/requests-data";

vi.mock("@/lib/entities", async (orig) => ({ ...(await orig<typeof import("@/lib/entities")>()), listProjects: vi.fn() }));
vi.mock("@/lib/pm", async (orig) => ({ ...(await orig<typeof import("@/lib/pm")>()), readProjectPmInputs: vi.fn() }));
vi.mock("@/lib/campaigns-data", () => ({ readSharedCampaigns: vi.fn() }));
vi.mock("@/lib/requests-data", () => ({ readRequestSummary: vi.fn() }));

const person = meFixture([member()]);
const listProjects = vi.mocked(entities.listProjects);
const projectWork = vi.mocked(pm.readProjectPmInputs);
const shared = vi.mocked(campaigns.readSharedCampaigns);
const summary = vi.mocked(requests.readRequestSummary);

const placed = resolveMyWorkspaces({ me: person, tenantId: "co-a", root: agencyTree({ web: ["u-1"] }) });
const webDev = subjectOfRef(placed.mine[0]);
const props = (key: string, extra: Partial<OverviewWidgetProps> = {}): OverviewWidgetProps => ({
  me: person, tenantId: "co-a", period: "month", deptId: "d-web", unitPath: ["d-web"], tools: [],
  widget: { key, band: "work", label: key }, workLinks: workLinks(webDev), ...extra,
});

const project = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `Project ${id}`, status: "active", due_date: null, ...over }) as never;
const work = (tasks: unknown[] = []) => ({ kind: "ok" as const, data: { tasks: tasks as never, milestones: [], statuses: [] } });
const late = { id: "t1", projectId: "p", status: "todo", dueDate: "2020-01-01" };
const refused = { kind: "forbidden" as const };
const failed = { kind: "unavailable" as const, reason: "boom" };

beforeEach(() => {
  for (const m of [listProjects, projectWork, shared, summary]) m.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("the Work blocks are wired into the host (DW-3f)", () => {
  it("has a component for each of the three", () => {
    for (const k of ["projects", "campaigns", "requests"]) expect(hasOverviewWidget(k, OVERVIEW_WIDGETS)).toBe(true);
    expect(hasOverviewWidget("condition", OVERVIEW_WIDGETS)).toBe(true); // DW-3k built it
  });

  it("draws nothing for a workspace with no unit to scope to", async () => {
    expect(await Projects(props("projects", { deptId: null }))).toBeNull();
    expect(await Campaigns(props("campaigns", { deptId: null }))).toBeNull();
    expect(await Requests(props("requests", { deptId: null }))).toBeNull();
    for (const m of [listProjects, shared, summary]) expect(m).not.toHaveBeenCalled();
  });
});

describe("Projects (widget)", () => {
  it("lists the top 4 open projects by risk with health, next due date and a link, and the block's own link", async () => {
    listProjects.mockResolvedValue([project("p1"), project("p2"), project("p3"), project("p4"), project("p5"), project("p6", { status: "completed" })]);
    projectWork.mockImplementation(async (_u, _t, id) => (id === "p5" ? work([late, { ...late, id: "t2" }]) : work([{ ...late, dueDate: "2999-01-01" }])));
    render(await Projects(props("projects")));
    const block = screen.getByRole("region", { name: "Projects" });
    expect(listProjects).toHaveBeenCalledWith("u-1", "co-a", undefined, "d-web");
    const items = within(block).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent("Project p5");
    expect(items[0]).toHaveTextContent("At risk · 2 overdue");
    expect(items[1]).toHaveTextContent("On track");
    expect(items[1]).toHaveTextContent("Next due 01 Jan 2999");
    expect(within(items[0]).getByRole("link", { name: "Project p5" })).toHaveAttribute("href", "/projects/p5");
    expect(within(block).getByText("4 of 5 open, most at risk first")).toBeInTheDocument();
    expect(within(block).getByRole("link", { name: "All projects" })).toHaveAttribute("href", "/departments/d-web/projects");
    expect(within(block).queryByText("Project p6")).toBeNull();
  });

  it("says a project has no upcoming due date when none is dated", async () => {
    listProjects.mockResolvedValue([project("p1")]);
    projectWork.mockResolvedValue(work([{ id: "t", projectId: "p", status: "todo", dueDate: null }]));
    render(await Projects(props("projects")));
    expect(screen.getByText("No upcoming due date")).toBeInTheDocument();
  });

  it("says Unavailable when the list failed, and No access when it was refused, never an empty list", async () => {
    listProjects.mockRejectedValue(new Error("down"));
    const first = render(await Projects(props("projects")));
    expect(screen.getByRole("region", { name: "Projects" })).toHaveTextContent("Unavailable");
    expect(screen.queryByText(/No open projects/)).toBeNull();
    first.unmount();
    listProjects.mockRejectedValue(new PlatformError(403, "no"));
    render(await Projects(props("projects")));
    expect(screen.getByRole("region", { name: "Projects" })).toHaveTextContent("No access");
    expect(screen.queryByText(/No open projects/)).toBeNull();
  });

  it("keeps a project whose work could not be read as Unavailable, never on track", async () => {
    listProjects.mockResolvedValue([project("p1"), project("p2")]);
    projectWork.mockImplementation(async (_u, _t, id) => (id === "p1" ? failed : work([{ ...late, dueDate: "2999-01-01" }])));
    render(await Projects(props("projects")));
    const items = within(screen.getByRole("region", { name: "Projects" })).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Project p1");
    expect(items[0]).toHaveTextContent("Unavailable");
    expect(items[1]).toHaveTextContent("On track");
  });

  it("says plainly that a real empty list is empty", async () => {
    listProjects.mockResolvedValue([]);
    render(await Projects(props("projects")));
    expect(screen.getByText("No open projects.")).toBeInTheDocument();
  });
});

describe("Campaigns (widget)", () => {
  const row = (id: string, over: Record<string, unknown> = {}) => ({
    id, name: `Campaign ${id}`, status: "active", projectId: null, clientId: null, leadUnitId: null, startsOn: "2026-11-01", endsOn: "2026-12-01",
    partCount: 1, part: { id: "pt", status: "in_progress", ownerId: null, ownerName: null, dueOn: null }, ...over,
  });

  it("lists the shared campaigns with our part's status and dates, linking to Campaigns > Shared", async () => {
    shared.mockResolvedValue({ kind: "ok", data: [row("c1")] as never });
    render(await Campaigns(props("campaigns")));
    const block = screen.getByRole("region", { name: "Campaigns" });
    expect(shared).toHaveBeenCalledWith("u-1", "co-a", "d-web");
    expect(within(block).getByRole("link", { name: "Campaign c1" })).toHaveAttribute("href", "/agency/c1");
    // The part's status reads like the Campaigns pages' badge, never as the raw enum.
    expect(block).toHaveTextContent("Our part: In progress");
    expect(block).not.toHaveTextContent("in_progress");
    expect(block).toHaveTextContent("01 Nov 2026 to 01 Dec 2026");
    expect(within(block).getByRole("link", { name: "Shared campaigns" })).toHaveAttribute("href", "/departments/d-web/campaigns");
  });

  it("says No shared campaigns only for a successful empty read", async () => {
    shared.mockResolvedValue({ kind: "ok", data: [] });
    render(await Campaigns(props("campaigns")));
    expect(screen.getByText("No shared campaigns.")).toBeInTheDocument();
  });

  it("says Unavailable or No access for a failed or refused read", async () => {
    shared.mockResolvedValue(failed);
    const first = render(await Campaigns(props("campaigns")));
    expect(screen.getByRole("region", { name: "Campaigns" })).toHaveTextContent("Unavailable");
    expect(screen.queryByText(/No shared campaigns/)).toBeNull();
    first.unmount();
    shared.mockResolvedValue(refused);
    render(await Campaigns(props("campaigns")));
    expect(screen.getByRole("region", { name: "Campaigns" })).toHaveTextContent("No access");
  });
});

describe("Requests (widget)", () => {
  it("shows both counts, the oldest waiting with its age, and a link to each tab the workspace has", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000 - 60_000).toISOString();
    summary.mockResolvedValue({ kind: "ok", data: { incoming: { open: 3, oldestOpenAt: eightDaysAgo }, sent: { open: 2 } } });
    render(await Requests(props("requests")));
    const block = screen.getByRole("region", { name: "Requests" });
    expect(summary).toHaveBeenCalledWith("u-1", "co-a", "d-web");
    expect(block.querySelector('[data-tile="incoming"]')).toHaveTextContent("Waiting on us3");
    expect(block.querySelector('[data-tile="sent"]')).toHaveTextContent("We are waiting on2");
    expect(block).toHaveTextContent("Oldest waiting: 8 days");
    expect(block.querySelector('[data-tile="incoming"] a')).toHaveAttribute("href", "/departments/d-web/requests");
    expect(block.querySelector('[data-tile="sent"] a')).toHaveAttribute("href", "/departments/d-web/requests/sent");
  });

  it("links no Incoming where the workspace has no such tab", async () => {
    summary.mockResolvedValue({ kind: "ok", data: { incoming: { open: 0, oldestOpenAt: null }, sent: { open: 1 } } });
    render(await Requests(props("requests", { workLinks: workLinks({ workspaceKey: "seo", deptId: "d-web" }) })));
    const block = screen.getByRole("region", { name: "Requests" });
    expect(block.querySelector('[data-tile="incoming"] a')).toBeNull();
    expect(block.querySelector('[data-tile="sent"] a')).toHaveAttribute("href", "/departments/d-web/requests/sent");
    expect(block).toHaveTextContent("Nothing is waiting on this department.");
  });

  it("never shows 0 for a failed or refused read", async () => {
    summary.mockResolvedValue(failed);
    const first = render(await Requests(props("requests")));
    const block = screen.getByRole("region", { name: "Requests" });
    expect(block).toHaveTextContent("Unavailable");
    expect(block.querySelector(".ov-nums__value")).toBeNull();
    first.unmount();
    summary.mockResolvedValue(refused);
    render(await Requests(props("requests")));
    expect(screen.getByRole("region", { name: "Requests" })).toHaveTextContent("No access");
  });
});
