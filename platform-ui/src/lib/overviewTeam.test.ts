import { describe, it, expect } from "vitest";
import { AGENCY, agencyTree, lead, me, member } from "./workspaceFixtures";
import { resolveMyWorkspaces } from "./workspaceAccess";
import { subjectOfRef } from "./overview";
import type { ReportDocument, ReportKpi } from "./reports";
import type { CheckinCompliance, CheckinComplianceRow } from "./checkins";
import type { ComplianceRow, UnitComplianceResult } from "./lms";
import type { Milestone, PmTask } from "./pm";
import type { RequestSummary } from "./requests";
import type { AppraisalStatus } from "./appraisals";
import {
  BLOCKED_PROJECTS_SHOWN, appraisalBreakdown, blockedReading, blockersView, buildTeamNeedsYou, buildTeamNumbers, canSwitchToTeam,
  ledScopeIsThisUnit, parseOverviewView, resolveOverviewView, teamAppraisalsView, teamLearningView, viewHref, widgetTitle, youBandLabel,
  type TeamNumbersView,
} from "./overviewTeam";

const WEB = { deptId: "d-web", unitPath: ["d-web", "root"] };
const ok = <T,>(data: T) => ({ kind: "ok" as const, data });
const forbidden = { kind: "forbidden" as const };
const unavailable = { kind: "unavailable" as const, reason: "boom" };

describe("parseOverviewView (DW-3h)", () => {
  it("reads only the exact word team as Team; everything else is Me", () => {
    expect(parseOverviewView("team")).toBe("team");
    expect(parseOverviewView("me")).toBe("me");
    for (const bad of [undefined, null, "", "TEAM", "Team", " team", "team ", "teams", "1", "true", "bogus"]) expect(parseOverviewView(bad)).toBe("me");
  });

  it("uses the first of a repeated param", () => {
    expect(parseOverviewView(["team", "me"])).toBe("team");
    expect(parseOverviewView(["me", "team"])).toBe("me");
    expect(parseOverviewView([])).toBe("me");
  });
});

describe("who is offered the switch (DW-3h, DW-D15)", () => {
  it("a head of THIS unit sees it", () => {
    expect(canSwitchToTeam(me([member(), lead("d-web")]), "co-a", WEB)).toBe(true);
  });

  it("a head of a unit ABOVE this one sees it (the server's rule cascades down)", () => {
    expect(canSwitchToTeam(me([member(), lead("root")]), "co-a", WEB)).toBe(true);
  });

  it("a head of another unit does not", () => {
    expect(canSwitchToTeam(me([member(), lead("d-seo")]), "co-a", WEB)).toBe(false);
  });

  it("a head of a unit INSIDE the department is not a head of the department", () => {
    expect(canSwitchToTeam(me([member(), lead("dv-fe")]), "co-a", WEB)).toBe(false);
  });

  it("someone with no lead grant does not, whatever else they hold", () => {
    expect(canSwitchToTeam(me([member()]), "co-a", WEB)).toBe(false);
    expect(canSwitchToTeam(me([member(), { role: "manager", scopeType: "org_unit", scopeId: "d-web" }]), "co-a", WEB)).toBe(false);
    expect(canSwitchToTeam(me([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]), "co-a", WEB)).toBe(false);
  });

  it("a lead role at company scope is not a lead of a unit", () => {
    expect(canSwitchToTeam(me([{ role: "org_unit_lead", scopeType: "company", scopeId: "co-a" }]), "co-a", WEB)).toBe(false);
  });

  it("a workspace with no unit of its own has no team to switch to", () => {
    const head = me([member(), lead("d-web")]);
    expect(canSwitchToTeam(head, "co-a", { deptId: null, unitPath: [] })).toBe(false);
    expect(canSwitchToTeam(head, "co-a", { deptId: "d-web", unitPath: [] })).toBe(false);
    expect(canSwitchToTeam(head, null, WEB)).toBe(false);
  });

  it("a company the person does not belong to is never a team of theirs (node ids repeat across companies)", () => {
    expect(canSwitchToTeam(me([member(), lead("d-web")]), "co-other", WEB)).toBe(false);
  });

  it("agrees with the workspace the sidebar homes them in, built from the real resolver", () => {
    const tree = agencyTree();
    const head = me([member(), lead("d-web")]);
    const ws = resolveMyWorkspaces({ me: head, tenantId: "co-a", root: tree });
    const web = subjectOfRef(ws.mine[0]);
    expect(web.deptId).toBe("d-web");
    expect(canSwitchToTeam(head, AGENCY.id, web)).toBe(true);
    const seo = subjectOfRef(ws.all.find((r) => r.deptId === "d-seo")!);
    expect(canSwitchToTeam(head, AGENCY.id, seo)).toBe(false);
  });
});

describe("resolveOverviewView: ?view=team is a head's alone", () => {
  it("is Team only when the person may switch AND asked for it", () => {
    expect(resolveOverviewView("team", true)).toBe("team");
    expect(resolveOverviewView("me", true)).toBe("me");
    expect(resolveOverviewView(undefined, true)).toBe("me");
  });

  it("ignores it for everyone else, so nothing about a team is read", () => {
    expect(resolveOverviewView("team", false)).toBe("me");
    expect(resolveOverviewView(["team"], false)).toBe("me");
  });
});

describe("the switch's links and words", () => {
  it("keep the period, and Me drops the view", () => {
    expect(viewHref("week", "team")).toBe("?period=week&view=team");
    expect(viewHref("month", "me")).toBe("?period=month");
  });

  it("retitle the four Team blocks and leave every other block alone", () => {
    expect(widgetTitle("your-numbers", "Your numbers", "team")).toBe("Team numbers");
    expect(widgetTitle("needs-you", "Needs you", "team")).toBe("Team needs you");
    expect(widgetTitle("learning", "Learning", "team")).toBe("Team learning");
    expect(widgetTitle("appraisal", "Appraisal", "team")).toBe("Team appraisals");
    expect(widgetTitle("pulse", "Pulse", "team")).toBe("Pulse");
    expect(widgetTitle("your-numbers", "Your numbers", "me")).toBe("Your numbers");
    expect(youBandLabel("me")).toBe("You");
    expect(youBandLabel("team")).toBe("You and your team");
  });

  it("says whether the person leads exactly this department", () => {
    expect(ledScopeIsThisUnit(me([lead("d-web")]), "d-web", "co-a")).toBe(true);
    expect(ledScopeIsThisUnit(me([lead("d-web"), lead("d-seo")]), "d-web", "co-a")).toBe(false);
    expect(ledScopeIsThisUnit(me([lead("root")]), "d-web", "co-a")).toBe(false);
    expect(ledScopeIsThisUnit(me([lead("d-web")]), null, "co-a")).toBe(false);
  });
});

// ── Team numbers ─────────────────────────────────────────────────────────────────────────────────

const kpi = (metricKey: string, value: number, extra: Partial<ReportKpi> = {}): ReportKpi => ({
  metricKey, label: metricKey, unit: "count", value, appraisalSafe: true, direction: "up_good", previous: { value: 0 }, ...extra,
});
const doc = (kpis: ReportKpi[], warnings?: ReportDocument["header"]["warnings"]): ReportDocument => ({
  header: {
    tenantId: "co-a", grain: "department", scopeRef: "d-web", scopeName: "Web Dev", periodKind: "month",
    periodStart: "2026-10-01", periodEnd: "2026-10-31", dayCount: 31, periodLabel: "October 2026",
    generatedAt: "2026-10-13T08:00:00Z", sealed: false,
    comparison: { periodStart: "2026-09-01", periodEnd: "2026-09-30", dayCount: 30 },
    ...(warnings ? { warnings } : {}),
  },
  kpis, series: [], distributions: [], tables: [], highlights: [], narrative: { source: "deterministic", text: "" },
});
const DEPT_KPIS = [
  kpi("delivery.on_time_rate", 0.8, { unit: "percent", numerator: 8, denominator: 10 }),
  kpi("flow.blocked_share", 0.09, { unit: "percent", numerator: 9, denominator: 100 }),
  kpi("effort.capacity_utilization", 0.75, { unit: "percent", numerator: 7200, denominator: 9600 }),
];
const row = (userId: string, expected: number, submitted: number): CheckinComplianceRow => ({
  userId, expectedDays: expected, submittedDays: submitted, missedDays: expected - submitted, excusedDays: 0, complianceRate: expected > 0 ? submitted / expected : null,
});
const grid = (rows: CheckinComplianceRow[], unit: string | null = "d-web"): CheckinCompliance => ({ from: "2026-10-01", to: "2026-10-31", unit, rows });
const FILLED = grid([row("u-2", 10, 9), row("u-3", 10, 7)]);
const numbers = (input: Partial<Parameters<typeof buildTeamNumbers>[0]> = {}): TeamNumbersView =>
  buildTeamNumbers({ document: ok(doc(DEPT_KPIS)), compliance: ok(FILLED), wider: false, selfUserId: "u-1", ...input });
function tiles(v: TeamNumbersView) {
  if (v.kind !== "ok") throw new Error(`expected ok, got ${v.kind}`);
  return Object.fromEntries(v.tiles.map((t) => [t.key, t]));
}

describe("buildTeamNumbers (DW-3h)", () => {
  it("draws check-ins sent, on time, blocked share and hours vs capacity from the two sources", () => {
    const v = numbers();
    expect(v.kind).toBe("ok");
    const t = tiles(v);
    expect(Object.keys(t)).toEqual(["check-ins", "on-time", "blocked", "hours"]);
    expect(t["check-ins"]).toMatchObject({ state: "ok", value: "16 of 20", detail: "80% · 2 people" });
    expect(t["on-time"]).toMatchObject({ state: "ok", value: "80%", detail: "8 of 10 tasks" });
    expect(t.blocked).toMatchObject({ state: "ok", value: "9%" });
    expect(t.hours).toMatchObject({ state: "ok", value: "120 h of 160 h", detail: "75% of expected hours" });
    expect(v.kind === "ok" && v.periodLabel).toBe("October 2026");
  });

  it("sums the grid's numerators and denominators, never averaging rates", () => {
    const t = tiles(numbers({ compliance: ok(grid([row("a", 1, 1), row("b", 19, 9)])) }));
    expect(t["check-ins"].value).toBe("10 of 20");
  });

  it("says one person, not one people", () => {
    expect(tiles(numbers({ compliance: ok(grid([row("a", 4, 4)])) }))["check-ins"].detail).toBe("100% · 1 person");
  });

  it("names a scope wider than the department when the person leads more than it", () => {
    expect(tiles(numbers({ wider: true }))["check-ins"].detail).toBe("80% · 2 people you lead, more than this department");
  });

  describe("a source that refused or failed", () => {
    it("shows the failed source's tiles as No access or Unavailable and keeps the other's figures", () => {
      const docDown = tiles(numbers({ document: forbidden }));
      expect(docDown["check-ins"].state).toBe("ok");
      for (const k of ["on-time", "blocked", "hours"]) expect(docDown[k]).toMatchObject({ state: "forbidden", value: "No access" });

      const gridDown = tiles(numbers({ compliance: unavailable }));
      expect(gridDown["check-ins"]).toMatchObject({ state: "unavailable", value: "Unavailable" });
      expect(gridDown["on-time"].state).toBe("ok");
    });

    it("never turns a refusal into a 0 or into No data", () => {
      const down = tiles(numbers({ document: unavailable }));
      for (const k of ["on-time", "blocked", "hours"]) expect(down[k].value).toBe("Unavailable");
      expect(tiles(numbers({ compliance: forbidden }))["check-ins"].value).toBe("No access");
    });

    it("is one refusal for the whole block only when BOTH failed: forbidden if both were, else unavailable", () => {
      expect(numbers({ document: forbidden, compliance: forbidden })).toEqual({ kind: "forbidden" });
      expect(numbers({ document: unavailable, compliance: unavailable })).toEqual({ kind: "unavailable" });
      expect(numbers({ document: forbidden, compliance: unavailable })).toEqual({ kind: "unavailable" });
    });
  });

  describe("empty versus filled", () => {
    it("is No data, never 0, when nothing was expected", () => {
      const t = tiles(numbers({ compliance: ok(grid([])) }));
      expect(t["check-ins"]).toMatchObject({ state: "no-data", value: "No data", detail: "No check-in was due in this period" });
      expect(tiles(numbers({ compliance: ok(grid([row("a", 0, 0)])) }))["check-ins"].state).toBe("no-data");
    });

    it("is No data for a KPI the document does not state, a ratio over nothing, or a missing capacity", () => {
      const t = tiles(numbers({ document: ok(doc([])) }));
      for (const k of ["on-time", "blocked", "hours"]) expect(t[k]).toMatchObject({ state: "no-data", value: "No data" });

      const empty = tiles(numbers({ document: ok(doc([kpi("delivery.on_time_rate", 0, { numerator: 0, denominator: 0 })])) }));
      expect(empty["on-time"].state).toBe("no-data");

      // Hours alone are not hours AGAINST anything: without the capacity KPI the tile has no figure.
      const hoursOnly = tiles(numbers({ document: ok(doc([kpi("effort.minutes_logged", 7200, { unit: "minutes" })])) }));
      expect(hoursOnly.hours).toMatchObject({ state: "no-data", value: "No data" });

      const noParts = tiles(numbers({ document: ok(doc([kpi("flow.blocked_share", 0.1)])) }));
      expect(noParts.blocked.state).toBe("no-data");
    });

    it("keeps a real 0% (parts stated) as a figure", () => {
      const t = tiles(numbers({ document: ok(doc([kpi("delivery.on_time_rate", 0, { numerator: 0, denominator: 4 })])) }));
      expect(t["on-time"]).toMatchObject({ state: "ok", value: "0%", detail: "0 of 4 tasks" });
    });
  });

  describe("a grid that is not a team's", () => {
    it("treats the caller's own row alone, with no unit, as the self-only fallback", () => {
      const t = tiles(numbers({ compliance: ok(grid([row("u-1", 10, 10)], null)) }));
      expect(t["check-ins"]).toMatchObject({ state: "unavailable", value: "Unavailable" });
    });

    it("still reads a head's team when the server names no unit (an unplaced head), because the rows are others'", () => {
      const t = tiles(numbers({ compliance: ok(grid([row("u-2", 10, 5), row("u-3", 10, 5)], null)) }));
      expect(t["check-ins"]).toMatchObject({ state: "ok", value: "10 of 20" });
    });

    it("does not call a unit-echoed grid of one's own row a fallback", () => {
      expect(tiles(numbers({ compliance: ok(grid([row("u-1", 10, 10)], "d-web")) }))["check-ins"].state).toBe("ok");
    });
  });

  it("says in words when the period starts before the records do, and otherwise has no note", () => {
    const warned = numbers({ document: ok(doc(DEPT_KPIS, { precedesFactHistory: { firstFactDate: "2026-05-01", affectedDays: 10 } } as ReportDocument["header"]["warnings"])) });
    expect(warned.kind === "ok" && warned.note).toBe("These numbers cover only part of this period: records begin on 1 May 2026.");
    const plain = numbers();
    expect(plain.kind === "ok" ? plain.note : "not ok").toBeNull();
  });
});

// ── Team needs you ───────────────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-10-13T12:00:00Z");
const task = (over: Partial<PmTask>): PmTask => ({ id: "t", projectId: "p", status: "todo", dueDate: null, ...over }) as PmTask;
const inputs = (tasks: PmTask[], milestones: Milestone[] = []) => ok({ tasks, milestones, statuses: [] });

describe("the team's blockers (DW-3h)", () => {
  it("counts a project's blocked tasks from its work read, by the project's own status flag", () => {
    expect(blockedReading(inputs([task({ status: "blocked" }), task({ status: "blocked" }), task({ status: "todo" }), task({ status: "done" })]), NOW))
      .toEqual({ kind: "ok", blocked: 2 });
    expect(blockedReading(inputs([task({ status: "todo" })]), NOW)).toEqual({ kind: "ok", blocked: 0 });
  });

  it("keeps a refused or failed read as its own state, never 0 blocked", () => {
    expect(blockedReading(forbidden, NOW)).toEqual({ kind: "forbidden" });
    expect(blockedReading(unavailable, NOW)).toEqual({ kind: "unavailable" });
  });

  const reading = (blocked: number) => ({ kind: "ok" as const, blocked });
  it("totals the readable projects, lists those with blockers (most first, capped), and counts the unread", () => {
    const rows = [
      { id: "a", name: "Alpha", reading: reading(1) },
      { id: "b", name: "Beta", reading: reading(3) },
      { id: "c", name: "Gamma", reading: reading(0) },
      { id: "d", name: "Delta", reading: { kind: "unavailable" as const } },
      { id: "e", name: "Epsilon", reading: reading(2) },
      { id: "f", name: "Zeta", reading: reading(2) },
    ];
    const v = blockersView(rows);
    expect(v).toMatchObject({ kind: "ok", total: 8, unread: 1, open: 6 });
    if (v.kind !== "ok") return;
    expect(v.projects.map((p) => p.id)).toEqual(["b", "e", "f"]);
    expect(v.projects).toHaveLength(BLOCKED_PROJECTS_SHOWN);
  });

  it("says no open projects only from a successful, empty list", () => {
    expect(blockersView([])).toEqual({ kind: "ok", total: 0, projects: [], unread: 0, open: 0 });
  });

  it("is one refusal when no project at all could be read, forbidden only if every one was", () => {
    expect(blockersView([{ id: "a", name: "A", reading: { kind: "forbidden" } }, { id: "b", name: "B", reading: { kind: "forbidden" } }])).toEqual({ kind: "forbidden" });
    expect(blockersView([{ id: "a", name: "A", reading: { kind: "forbidden" } }, { id: "b", name: "B", reading: { kind: "unavailable" } }])).toEqual({ kind: "unavailable" });
  });

  it("reads zero blocked as a floor, not a claim, while some project is unread", () => {
    const v = blockersView([{ id: "a", name: "A", reading: reading(0) }, { id: "b", name: "B", reading: { kind: "unavailable" } }]);
    expect(v).toMatchObject({ kind: "ok", total: 0, unread: 1, open: 2 });
  });
});

describe("buildTeamNeedsYou (DW-3h)", () => {
  const summary: RequestSummary = { incoming: { open: 3, oldestOpenAt: "2026-10-10T12:00:00Z" }, sent: { open: 1 } };
  const blockers = blockersView([]);

  it("carries the requests waiting on the department with the oldest one's age", () => {
    expect(buildTeamNeedsYou({ requests: ok(summary), blockers, now: NOW }).requests).toEqual({
      kind: "ok", incoming: 3, sent: 1, oldestOpenAt: "2026-10-10T12:00:00Z", oldestAge: "3 days",
    });
  });

  it("an empty successful read is zero waiting; a refused or failed one never is", () => {
    const empty = buildTeamNeedsYou({ requests: ok({ incoming: { open: 0, oldestOpenAt: null }, sent: { open: 0 } }), blockers, now: NOW });
    expect(empty.requests).toMatchObject({ kind: "ok", incoming: 0, oldestAge: null });
    expect(buildTeamNeedsYou({ requests: forbidden, blockers, now: NOW }).requests).toEqual({ kind: "forbidden" });
    expect(buildTeamNeedsYou({ requests: unavailable, blockers, now: NOW }).requests).toEqual({ kind: "unavailable" });
  });

  it("keeps the two sources apart: one failing does not touch the other", () => {
    const m = buildTeamNeedsYou({ requests: unavailable, blockers: { kind: "forbidden" }, now: NOW });
    expect(m.requests.kind).toBe("unavailable");
    expect(m.blockers.kind).toBe("forbidden");
  });
});

// ── Team learning ────────────────────────────────────────────────────────────────────────────────

const path = (over: Partial<ComplianceRow>): ComplianceRow => ({ pathKey: "k", title: "T", isMandatory: true, assigned: 0, completed: 0, outstanding: 0, overdue: 0, waived: 0, ...over });
const unitOk = (learners: number, paths: ComplianceRow[]): UnitComplianceResult => ({ kind: "ok", data: { unit: "d-web", learners, paths } });

describe("teamLearningView (DW-3h, BFF §38)", () => {
  it("totals the MANDATORY paths only, with coverage as completed over assigned", () => {
    const v = teamLearningView(unitOk(2, [
      path({ pathKey: "a", assigned: 2, completed: 2 }),
      path({ pathKey: "b", assigned: 2, completed: 1, outstanding: 1, overdue: 1 }),
      path({ pathKey: "c", isMandatory: false, assigned: 9, completed: 0, outstanding: 9, overdue: 9 }),
    ]));
    expect(v).toEqual({ kind: "ok", learners: 2, assigned: 4, completed: 3, outstanding: 1, overdue: 1, coverage: 75 });
  });

  it("has no coverage, not 0% and not 100%, when nothing mandatory is assigned", () => {
    expect(teamLearningView(unitOk(3, [path({ assigned: 0 })]))).toMatchObject({ kind: "ok", learners: 3, coverage: null });
    expect(teamLearningView(unitOk(3, []))).toMatchObject({ coverage: null });
  });

  it("keeps the roster size, so an empty team is learners 0", () => {
    expect(teamLearningView(unitOk(0, [path({})]))).toMatchObject({ kind: "ok", learners: 0, coverage: null });
  });

  it("is forbidden when refused, and unavailable for an error or an unknown unit, never an empty table", () => {
    expect(teamLearningView({ kind: "forbidden" })).toEqual({ kind: "forbidden" });
    expect(teamLearningView({ kind: "error", reason: "x" })).toEqual({ kind: "unavailable" });
    expect(teamLearningView({ kind: "not_found" })).toEqual({ kind: "unavailable" });
  });
});

// ── Team appraisals ──────────────────────────────────────────────────────────────────────────────

const appr = (cycleId: string, status: AppraisalStatus) => ({ cycleId, status });

describe("teamAppraisalsView (DW-3h, BFF §39)", () => {
  it("counts by status and cycles", () => {
    const v = teamAppraisalsView(ok({ appraisals: [
      appr("c1", "finalized"), appr("c1", "finalized"), appr("c1", "draft"), appr("c2", "submitted"), appr("c2", "acknowledged"), appr("c2", "disputed"),
    ] }));
    expect(v).toEqual({ kind: "ok", total: 6, cycles: 2, draft: 1, submitted: 1, acknowledged: 1, disputed: 1, finalized: 2 });
  });

  it("an empty successful list is a real none; a refused or failed one never is", () => {
    expect(teamAppraisalsView(ok({ appraisals: [] }))).toMatchObject({ kind: "ok", total: 0, cycles: 0 });
    expect(teamAppraisalsView(forbidden)).toEqual({ kind: "forbidden" });
    expect(teamAppraisalsView(unavailable)).toEqual({ kind: "unavailable" });
  });

  it("names only the states that have someone in them", () => {
    const base = { total: 5, cycles: 1, draft: 0, submitted: 0, acknowledged: 0, disputed: 0, finalized: 5 };
    expect(appraisalBreakdown(base)).toBe("");
    expect(appraisalBreakdown({ ...base, finalized: 1, draft: 2, submitted: 1, disputed: 1 })).toBe("2 being scored, 1 awaiting acknowledgement, 1 disputed");
  });
});
