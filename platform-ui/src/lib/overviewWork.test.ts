import { describe, it, expect } from "vitest";
import {
  CAMPAIGNS_SHOWN, PROJECTS_SHOWN, ageText, campaignsView, healthText, isOpenProject, nextDueDate, projectRow, projectsView,
  requestsView, sortByRisk, workLinks, workWidgetPlaced, type ProjectRowModel,
} from "./overviewWork";
import { selectBands } from "./overview";
import { WORKSPACES, isPlanned } from "./workspaces";
import { HOTEL, agencyTree, me, member } from "./workspaceFixtures";
import { resolveMyWorkspaces } from "./workspaceAccess";
import { subjectOfRef } from "./overview";
import type { Milestone, PmTask } from "./pm";
import type { DeptCampaignRow } from "./campaigns";

const NOW = new Date("2026-10-13T12:00:00Z");
const task = (over: Partial<PmTask>): PmTask => ({ id: "t", projectId: "p", status: "todo", dueDate: null, ...over }) as PmTask;
const ms = (over: Partial<Milestone>): Milestone => ({ id: "m", projectId: "p", name: "M", dueDate: null, status: "open", ...over });
const proj = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id, status: "active", due_date: null, ...over });
const ok = <T,>(data: T) => ({ kind: "ok" as const, data });
const inputs = (tasks: PmTask[], milestones: Milestone[] = []) => ok({ tasks, milestones, statuses: [] });
const row = (id: string, over: Partial<ProjectRowModel> = {}): ProjectRowModel => ({
  id, name: id, nextDue: null, health: { kind: "ok", atRisk: false, reason: null, hasTasks: true, riskScore: 0 }, ...over,
});
const atRisk = (score: number): ProjectRowModel["health"] => ({ kind: "ok", atRisk: true, reason: `${score} overdue`, hasTasks: true, riskScore: score });

describe("the Work blocks' placement (DW-3f)", () => {
  it("places them only for a workspace with a unit, and leaves every other widget alone", () => {
    for (const key of ["projects", "campaigns", "requests"]) {
      expect(workWidgetPlaced(key, { deptId: "d-web" })).toBe(true);
      expect(workWidgetPlaced(key, { deptId: null })).toBe(false);
    }
    expect(workWidgetPlaced("pulse", { deptId: null })).toBe(true);
  });

  it("drops the Work band when no block is placed, and keeps it when one is", () => {
    const placed = resolveMyWorkspaces({ me: me([member()]), tenantId: "co-a", root: agencyTree({ web: ["u-1"] }) });
    const webDev = subjectOfRef(placed.mine[0]);
    const ctx = { me: me([member()]), tenantId: "co-a", unitPath: webDev.unitPath };
    const placedKeys = (subject: { deptId: string | null }) =>
      selectBands(webDev.widgets, ctx, (k) => ["projects", "campaigns", "requests"].includes(k) && workWidgetPlaced(k, subject))
        .flatMap((b) => b.widgets.map((w) => w.key));
    expect(placedKeys(webDev)).toEqual(["projects", "campaigns", "requests"]);
    expect(placedKeys({ deptId: null })).toEqual([]);
  });

  it("hides Campaigns and Requests where the gate fails (a company without the agency pack)", () => {
    const webDev = WORKSPACES.find((w) => w.key === "web-dev")!;
    const hotel = { me: me([member("co-h")], [HOTEL]), tenantId: "co-h", unitPath: ["d-web"] };
    const keys = selectBands(webDev.overview, hotel, (k) => workWidgetPlaced(k, { deptId: "d-web" })).flatMap((b) => b.widgets.map((w) => w.key));
    expect(keys).toContain("projects");
    expect(keys).not.toContain("campaigns");
    expect(keys).not.toContain("requests");
  });

  it("has the three blocks built in every department workspace (no ticket left)", () => {
    for (const w of WORKSPACES.filter((x) => x.overview.some((o) => o.key === "projects"))) {
      for (const k of ["projects", "campaigns", "requests"]) expect(isPlanned(w.overview.find((o) => o.key === k)!), `${w.key}/${k}`).toBe(false);
    }
  });

  it("links to the tabs the workspace really has: Incoming only where it has that tab", () => {
    expect(workLinks({ workspaceKey: "web-dev", deptId: "d-1" })).toEqual({
      projects: "/departments/d-1/projects", campaigns: "/departments/d-1/campaigns",
      requestsIncoming: "/departments/d-1/requests", requestsSent: "/departments/d-1/requests/sent",
    });
    const seo = workLinks({ workspaceKey: "seo", deptId: "d-3" });
    expect(seo.requestsIncoming).toBeNull();
    expect(seo.requestsSent).toBe("/departments/d-3/requests/sent");
    expect(workLinks({ workspaceKey: null, deptId: null })).toEqual({ projects: null, campaigns: null, requestsIncoming: null, requestsSent: null });
  });

  it("gives a generic department's Projects block its projects link too (DW-3z): the generic workspace has the Project Management row", () => {
    expect(workLinks({ workspaceKey: "generic", deptId: "d-9" })).toEqual({
      // DW-10e: the generic workspace has Requests > Sent for a company with routes, so its block links there.
      projects: "/departments/d-9/projects", campaigns: null, requestsIncoming: null, requestsSent: "/departments/d-9/requests/sent",
    });
  });
});

describe("Projects: next due date", () => {
  it("is the earliest date from today on, among open tasks, open milestones and the project's own date", () => {
    const tasks = [task({ dueDate: "2026-11-20" }), task({ dueDate: "2026-10-30" }), task({ dueDate: "2026-10-01" }), task({ status: "done", dueDate: "2026-10-14" })];
    expect(nextDueDate(tasks, [ms({ dueDate: "2026-12-01" })], "2026-12-31", NOW)).toBe("2026-10-30");
    expect(nextDueDate([], [ms({ dueDate: "2026-10-20" }), ms({ dueDate: "2026-10-15", status: "done" })], null, NOW)).toBe("2026-10-20");
    expect(nextDueDate([], [], "2026-10-13", NOW)).toBe("2026-10-13");
  });

  it("is null when nothing upcoming is dated: absent, past, or done", () => {
    expect(nextDueDate([], [], null, NOW)).toBeNull();
    expect(nextDueDate([task({ dueDate: "2026-09-01" }), task({ status: "done", dueDate: "2026-11-01" })], [], "2026-08-01", NOW)).toBeNull();
    expect(nextDueDate([task({ dueDate: "not a date" })], [], null, NOW)).toBeNull();
  });
});

describe("Projects: the row and its health", () => {
  it("reads health from the project's tasks: overdue and blocked make it at risk, with the reason", () => {
    const r = projectRow(proj("a"), inputs([task({ dueDate: "2026-10-01" }), task({ status: "blocked" }), task({ status: "done" })]), NOW);
    expect(r.health).toMatchObject({ kind: "ok", atRisk: true, reason: "1 overdue · 1 blocked", riskScore: 2 });
    expect(healthText(r.health)).toBe("At risk · 1 overdue · 1 blocked");
  });

  it("says on track only for a project with tasks, and says so plainly when it has none", () => {
    expect(healthText(projectRow(proj("a"), inputs([task({ dueDate: "2026-12-01" })]), NOW).health)).toBe("On track");
    expect(healthText(projectRow(proj("a"), inputs([]), NOW).health)).toBe("No tasks yet");
  });

  it("keeps a project whose work could not be read, as Unavailable or No access, never on track", () => {
    expect(healthText(projectRow(proj("a"), { kind: "unavailable", reason: "x" }, NOW).health)).toBe("Unavailable");
    expect(healthText(projectRow(proj("a"), { kind: "forbidden" }, NOW).health)).toBe("No access");
  });

  it("skips a finished project", () => {
    expect(isOpenProject({ status: "active" })).toBe(true);
    expect(isOpenProject({ status: "on_hold" })).toBe(true);
    expect(isOpenProject({ status: "completed" })).toBe(false);
    expect(isOpenProject({ status: "Cancelled" })).toBe(false);
  });
});

describe("Projects: risk ordering and the top-4 cut", () => {
  it("puts the most at risk first, then those that could not be read, then those on track", () => {
    const rows = [
      row("on-track"), row("unknown", { health: { kind: "unavailable" } }),
      row("one", { health: atRisk(1) }), row("three", { health: atRisk(3) }),
    ];
    expect(sortByRisk(rows).map((r) => r.id)).toEqual(["three", "one", "unknown", "on-track"]);
  });

  it("breaks ties by the nearest next date, undated last, then by name, without changing its input", () => {
    const rows = [row("c"), row("b", { nextDue: "2026-11-01" }), row("a", { nextDue: "2026-12-01" }), row("d", { nextDue: "2026-11-01" })];
    const before = rows.map((r) => r.id);
    expect(sortByRisk(rows).map((r) => r.id)).toEqual(["b", "d", "a", "c"]);
    expect(rows.map((r) => r.id)).toEqual(before);
  });

  it("cuts to four and still counts every open project", () => {
    const rows = Array.from({ length: 7 }, (_, i) => row(`p${i}`, { health: atRisk(i + 1) }));
    const view = projectsView(ok(rows));
    expect(PROJECTS_SHOWN).toBe(4);
    expect(view).toMatchObject({ kind: "ok", total: 7 });
    expect(view.kind === "ok" && view.rows.map((r) => r.id)).toEqual(["p6", "p5", "p4", "p3"]);
  });

  it("tells Unavailable, No access and a real empty list apart", () => {
    expect(projectsView({ kind: "unavailable", reason: "boom" })).toEqual({ kind: "unavailable" });
    expect(projectsView({ kind: "forbidden" })).toEqual({ kind: "forbidden" });
    expect(projectsView(ok([]))).toEqual({ kind: "ok", rows: [], total: 0 });
  });
});

describe("Campaigns", () => {
  const camp = (id: string, over: Partial<DeptCampaignRow> = {}): DeptCampaignRow => ({
    id, name: id, status: "active", projectId: null, clientId: null, leadUnitId: null, startsOn: null, endsOn: null, partCount: 1, part: null, ...over,
  });
  const part = (status: string) => ({ id: "pt", status, ownerId: null, ownerName: null, dueOn: null });

  it("shows our part's status, with the campaign's name and dates, parts first then the soonest end", () => {
    const view = campaignsView(ok([
      camp("lead-only", { leadUnitId: "d-1" }),
      camp("late", { part: part("planned"), endsOn: "2026-12-01", startsOn: "2026-11-01" }),
      camp("soon", { part: part("in_progress"), endsOn: "2026-11-01" }),
      camp("undated", { part: part("planned") }),
    ]), "d-1");
    expect(view.kind === "ok" && view.rows.map((r) => [r.id, r.ourPart, r.partStatus])).toEqual([
      ["soon", "in_progress", "in_progress"], ["late", "planned", "planned"], ["undated", "planned", "planned"],
      ["lead-only", "Lead, no part", null],
    ]);
    expect(view.kind === "ok" && view.rows[1]).toMatchObject({ name: "late", startsOn: "2026-11-01", endsOn: "2026-12-01" });
  });

  it("says plainly a campaign the department neither leads nor has a part in has no part of ours", () => {
    const view = campaignsView(ok([camp("x", { leadUnitId: "d-9" })]), "d-1");
    expect(view.kind === "ok" && view.rows[0]).toMatchObject({ ourPart: "No part", partStatus: null });
  });

  it("cuts to the top few and counts them all", () => {
    const view = campaignsView(ok(Array.from({ length: 6 }, (_, i) => camp(`c${i}`, { part: part("planned") }))), "d-1");
    expect(view).toMatchObject({ kind: "ok", total: 6 });
    expect(view.kind === "ok" && view.rows).toHaveLength(CAMPAIGNS_SHOWN);
  });

  it("tells Unavailable, No access and a real empty list apart", () => {
    expect(campaignsView({ kind: "unavailable", reason: "x" }, "d-1")).toEqual({ kind: "unavailable" });
    expect(campaignsView({ kind: "forbidden" }, "d-1")).toEqual({ kind: "forbidden" });
    expect(campaignsView(ok([]), "d-1")).toEqual({ kind: "ok", rows: [], total: 0 });
  });
});

describe("Requests", () => {
  const summary = (inOpen: number, oldest: string | null, sent: number) => ok({ incoming: { open: inOpen, oldestOpenAt: oldest }, sent: { open: sent } });

  it("counts in and sent, and ages the oldest waiting", () => {
    expect(requestsView(summary(3, "2026-10-10T12:00:00Z", 2), NOW)).toEqual({
      kind: "ok", incoming: 3, sent: 2, oldestOpenAt: "2026-10-10T12:00:00Z", oldestAge: "3 days",
    });
  });

  it("ages in the unit a person would say", () => {
    expect(ageText("2026-10-12T12:00:00Z", NOW)).toBe("1 day");
    expect(ageText("2026-10-13T07:00:00Z", NOW)).toBe("5 hours");
    expect(ageText("2026-10-13T11:00:00Z", NOW)).toBe("1 hour");
    expect(ageText("2026-10-13T11:30:00Z", NOW)).toBe("under an hour");
    expect(ageText(null, NOW)).toBeNull();
    expect(ageText("nonsense", NOW)).toBeNull();
    expect(ageText("2026-10-20T00:00:00Z", NOW)).toBeNull();
  });

  it("shows no oldest when nothing waits, and no age when the server gave no date", () => {
    expect(requestsView(summary(0, "2026-10-01T00:00:00Z", 1), NOW)).toMatchObject({ incoming: 0, oldestOpenAt: null, oldestAge: null });
    expect(requestsView(summary(2, null, 0), NOW)).toMatchObject({ incoming: 2, oldestAge: null });
  });

  it("never turns a failed or refused read into a count", () => {
    expect(requestsView({ kind: "unavailable", reason: "x" }, NOW)).toEqual({ kind: "unavailable" });
    expect(requestsView({ kind: "forbidden" }, NOW)).toEqual({ kind: "forbidden" });
  });
});
