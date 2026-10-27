import { Suspense, type ReactElement, type ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { me as meFixture, member } from "@/lib/workspaceFixtures";
import type { PmTask } from "@/lib/pm";
import type { DepartmentWorkspace } from "@/lib/departments";

// DW-9d perf: the department Home. Framed by the Overview, the legacy band is its own async component under <Suspense> (so the Overview's
// header and widgets are not held behind the band's reads), and it reads only what it still draws. Server page: the readers are mocked, and
// the elements it returns are walked (an async server component cannot render in jsdom's client React).
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => { throw new Error(`redirect:${to}`); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
}));
vi.mock("next/link", () => ({ default: ({ children }: { children?: ReactNode }) => <a>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/platform", async () => ({ ...(await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform")), getMe: vi.fn() }));
vi.mock("@/lib/departments", async () => ({
  ...(await vi.importActual<typeof import("@/lib/departments")>("@/lib/departments")),
  getDepartment: vi.fn(), getDepartmentNode: vi.fn(), getServicedCompanies: vi.fn(async () => ({ items: [], companies: [] })),
}));
vi.mock("@/lib/entities", () => ({ listProjects: vi.fn(), listMembers: vi.fn(async () => []) }));
vi.mock("@/lib/pm", async () => ({
  ...(await vi.importActual<typeof import("@/lib/pm")>("@/lib/pm")),
  listPmTasks: vi.fn(), listMilestones: vi.fn(async () => []), listProjectStatuses: vi.fn(async () => []),
}));
vi.mock("@/lib/activity", async () => ({ ...(await vi.importActual<typeof import("@/lib/activity")>("@/lib/activity")), listWorkActivity: vi.fn(async () => []) }));
vi.mock("@/lib/claudeSeats", async () => ({ ...(await vi.importActual<typeof import("@/lib/claudeSeats")>("@/lib/claudeSeats")), listClaudeSeats: vi.fn(async () => ({ rows: [], unavailable: false })) }));
vi.mock("@/components/overview/pilot", () => ({ pilotFrame: vi.fn() }));
// SCP-1d: the Social Media Home is the feed only in the Social skin. The prefs cookie holds the person's own choice; the feed's reads are its own component's (not run here).
vi.mock("@/lib/prefs", async () => ({ ...(await vi.importActual<typeof import("@/lib/prefs")>("@/lib/prefs")), getPrefs: vi.fn() }));
vi.mock("@/components/social/SocialHome", () => ({ SocialHome: () => null }));

import { getMe } from "@/lib/platform";
import { getDepartment, getDepartmentNode } from "@/lib/departments";
import { listProjects } from "@/lib/entities";
import { listMilestones, listPmTasks, listProjectStatuses } from "@/lib/pm";
import { pilotFrame } from "@/components/overview/pilot";
import { DEFAULT_PREFS, getPrefs } from "@/lib/prefs";
import { SocialHome } from "@/components/social/SocialHome";
import { KpiStrip } from "@/components/departments/KpiStrip";
import DepartmentHomePage from "./page";

const task = (id: string, projectId: string, progress: number): PmTask => ({ id, projectId, status: "todo", progress, dueDate: null, assignee: null } as unknown as PmTask);
const DEPT: DepartmentWorkspace = { id: "d-web", name: "Web Dev", divisions: [], people: [], tasks: [task("t1", "p-1", 40), task("t2", "p-2", 60)], statusesByProject: {} };
const PROJECTS = [{ id: "p-1", name: "One", department_id: "d-web" }, { id: "p-2", name: "Two", department_id: "d-web" }, { id: "p-3", name: "Other", department_id: "d-seo" }];

const params = Promise.resolve({ deptId: "d-web" });
const searchParams = Promise.resolve({});
const mount = () => DepartmentHomePage({ params, searchParams });

type El = ReactElement<Record<string, unknown>>;

/** The body component element an Overview frame was given, however it is wrapped. */
function bodyOf(legacy: ReactNode): El {
  const el = legacy as El;
  return el.type === Suspense ? (el.props.children as El) : el;
}
/** Runs the async body and returns the KpiStrip's props. */
async function kpiProps(legacy: ReactNode) {
  const el = bodyOf(legacy);
  const root = (await (el.type as (p: unknown) => Promise<El>)(el.props)) as El;
  const kids = root.props.children as ReactNode;
  const list = (Array.isArray(kids) ? kids : [kids]) as (El | false)[];
  const strip = list.find((c) => c && c.type === KpiStrip) as El;
  return strip.props as { progressPct: number; active: number };
}

beforeEach(() => {
  vi.mocked(getMe).mockResolvedValue(meFixture([member()]));
  vi.mocked(getDepartmentNode).mockReset().mockResolvedValue({ id: "d-web", name: "Web Dev" });
  vi.mocked(getDepartment).mockReset().mockResolvedValue(DEPT);
  vi.mocked(listProjects).mockReset().mockResolvedValue(PROJECTS as never);
  vi.mocked(listPmTasks).mockReset().mockImplementation(async (_u: string, _t: string, pid: string) => (pid === "p-1" ? [task("a", "p-1", 30), task("b", "p-1", 50)] : [task("c", "p-2", 90)]));
  vi.mocked(listMilestones).mockClear();
  vi.mocked(listProjectStatuses).mockClear();
  vi.mocked(pilotFrame).mockReset();
  vi.mocked(getPrefs).mockReset().mockResolvedValue({ ...DEFAULT_PREFS });
});

describe("Department Home: the node check", () => {
  it("is a 404 for an unknown department, from the light node read (no tasks read for it)", async () => {
    vi.mocked(getDepartmentNode).mockResolvedValue(null);
    await expect(mount()).rejects.toThrow("notFound");
    expect(getDepartment).not.toHaveBeenCalled();
  });

  it("sends a functional department to its console from the node's name alone", async () => {
    vi.mocked(getDepartmentNode).mockResolvedValue({ id: "d-hr", name: "HR" });
    await expect(mount()).rejects.toThrow("redirect:/hr");
    expect(getDepartment).not.toHaveBeenCalled();
  });
});

describe("Department Home: framed by the Overview", () => {
  const frame = vi.fn((legacy: ReactNode) => legacy);
  beforeEach(() => { frame.mockClear(); vi.mocked(pilotFrame).mockResolvedValue(frame as never); });

  it("hands the frame the body under its own <Suspense>, so the Overview's header does not wait for the body's reads", async () => {
    await mount();
    expect(frame).toHaveBeenCalledTimes(1);
    const legacy = frame.mock.calls[0][0] as El;
    expect(legacy.type).toBe(Suspense);
    expect(legacy.props.fallback).toBeTruthy();
    // Returning the frame costs no body read: nothing of the body has run yet.
    expect(getDepartment).not.toHaveBeenCalled();
    expect(listProjects).not.toHaveBeenCalled();
    expect(listPmTasks).not.toHaveBeenCalled();
  });

  it("reads only the tasks of each owned project: no milestones, no status registry (the Project health cards are not kept)", async () => {
    await mount();
    await kpiProps(frame.mock.calls[0][0]);
    expect(listPmTasks).toHaveBeenCalledTimes(2);
    expect(listMilestones).not.toHaveBeenCalled();
    expect(listProjectStatuses).not.toHaveBeenCalled();
  });

  it("shows the same KPI strip as the unframed page: Progress is each owned project's task average, framed or not", async () => {
    await mount();
    const framed = await kpiProps(frame.mock.calls[0][0]);
    vi.mocked(pilotFrame).mockResolvedValue(null);
    const unframed = await kpiProps(await mount());
    expect(framed).toEqual(unframed);
    // Project one averages (30 + 50) / 2 = 40, project two is 90, so the department's Progress is (40 + 90) / 2.
    expect(framed.progressPct).toBe(65);
  });
});

describe("Department Home: not framed", () => {
  beforeEach(() => { vi.mocked(pilotFrame).mockResolvedValue(null); });

  it("returns the body itself (no Suspense) and reads the milestones and statuses of every owned project, as before", async () => {
    const out = await mount();
    expect((out as El).type).not.toBe(Suspense);
    await kpiProps(out);
    expect(listPmTasks).toHaveBeenCalledTimes(2);
    expect(listMilestones).toHaveBeenCalledTimes(2);
    expect(listProjectStatuses).toHaveBeenCalledTimes(2);
  });
});

// SCP-1d (plan §6.1, §6.2): the Social Media workspace's Home is laid out as the team's feed WHEN it is drawn in the Social skin, and not otherwise. The feed is handed to the
// Overview frame as its `lead`, behind its own <Suspense>; a person who chose Standard and every other department are handed the frame exactly as before (one argument).
describe("Department Home: the Social skin's feed", () => {
  const frame = vi.fn((legacy: ReactNode, lead?: ReactNode) => (lead ? [lead, legacy] : legacy));
  const social = () => vi.mocked(getDepartmentNode).mockResolvedValue({ id: "d-web", name: "Social Media" });
  beforeEach(() => { frame.mockClear(); vi.mocked(pilotFrame).mockResolvedValue(frame as never); });

  it("gives the Social Media workspace, in the Social skin, the feed as the frame's lead: for this person, in this company, in this department", async () => {
    social();
    await mount();
    expect(frame).toHaveBeenCalledTimes(1);
    expect(frame.mock.calls[0]).toHaveLength(2);
    const lead = frame.mock.calls[0][1] as El;
    expect(lead.type).toBe(Suspense);
    expect(lead.props.fallback).toBeTruthy();
    const feed = lead.props.children as El;
    expect(feed.type).toBe(SocialHome);
    expect(feed.props).toEqual({ userId: "u-1", tenantId: "co-a", deptId: "d-web", noQueue: false });
    // The body stays (the KPI strip and the rest): the feed is added, nothing is taken out.
    expect((frame.mock.calls[0][0] as El).type).toBe(Suspense);
  });

  it("leaves the Social Media Home as it is for a person who chose the Standard skin", async () => {
    social();
    vi.mocked(getPrefs).mockResolvedValue({ ...DEFAULT_PREFS, skin: "standard" });
    await mount();
    expect(frame).toHaveBeenCalledTimes(1);
    expect(frame.mock.calls[0]).toHaveLength(1);
  });

  it("leaves every other department as it is, and does not even read the prefs for it", async () => {
    await mount(); // Web Dev
    expect(frame.mock.calls[0]).toHaveLength(1);
    expect(getPrefs).not.toHaveBeenCalled();
  });

  it("draws the feed above the body when there is no Overview frame, and the body alone for Standard", async () => {
    vi.mocked(pilotFrame).mockResolvedValue(null);
    social();
    const out = (await mount()) as El;
    const kids = out.props.children as El[];
    expect(kids).toHaveLength(2);
    expect((kids[0].props.children as El).type).toBe(SocialHome);
    vi.mocked(getPrefs).mockResolvedValue({ ...DEFAULT_PREFS, skin: "standard" });
    const plain = (await mount()) as El;
    expect(plain.type).not.toBe(Suspense);
    expect(plain.props.children).toBeUndefined();
  });
});
