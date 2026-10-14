import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { type OverviewWidgetProps } from "./index";
import { YourNumbers } from "./YourNumbers";
import { NeedsYou } from "./NeedsYou";
import { Learning } from "./Learning";
import { Appraisal } from "./Appraisal";
import { me as meFixture, member, lead } from "@/lib/workspaceFixtures";
import { PlatformError } from "@/lib/platform";
import * as reports from "@/lib/reports-data";
import * as checkins from "@/lib/checkins-data";
import * as lms from "@/lib/lms";
import * as appraisals from "@/lib/appraisals-data";
import * as entities from "@/lib/entities";
import * as pm from "@/lib/pm";
import * as requests from "@/lib/requests-data";
import * as queue from "@/lib/queue";
import type { ReportDocument, ReportKpi } from "@/lib/reports";

// DW-3h: the Team-mode blocks of a head's Overview, each in its three read states (ok, forbidden, unavailable), empty and
// filled, and Me mode untouched. The readers are mocked at their seams; the pure rules have their own tests (overviewTeam.test.ts).
vi.mock("@/app/(app)/actions", () => ({ decideQueueItem: vi.fn() }));
vi.mock("@/lib/reports-data", () => ({ getReportDocument: vi.fn() }));
vi.mock("@/lib/checkins-data", () => ({ getCheckinCompliance: vi.fn() }));
vi.mock("@/lib/appraisals-data", () => ({ listAppraisals: vi.fn(), getMyAppraisals: vi.fn() }));
vi.mock("@/lib/requests-data", () => ({ readRequestSummary: vi.fn() }));
vi.mock("@/lib/lms", async (orig) => ({ ...(await orig<typeof import("@/lib/lms")>()), getUnitCompliance: vi.fn(), getMyLearning: vi.fn() }));
vi.mock("@/lib/entities", async (orig) => ({ ...(await orig<typeof import("@/lib/entities")>()), listProjects: vi.fn() }));
vi.mock("@/lib/pm", async (orig) => ({ ...(await orig<typeof import("@/lib/pm")>()), readProjectPmInputs: vi.fn() }));
// The Me-mode queue reader: a head's own Needs you must not run in Team mode.
vi.mock("@/lib/queue", async (orig) => ({ ...(await orig<typeof import("@/lib/queue")>()), getMyWorkQueue: vi.fn() }));

const head = meFixture([member(), lead("d-web")]);
const doc = vi.mocked(reports.getReportDocument);
const compliance = vi.mocked(checkins.getCheckinCompliance);
const unitCompliance = vi.mocked(lms.getUnitCompliance);
const myLearning = vi.mocked(lms.getMyLearning);
const listAppr = vi.mocked(appraisals.listAppraisals);
const myAppr = vi.mocked(appraisals.getMyAppraisals);
const summary = vi.mocked(requests.readRequestSummary);
const projects = vi.mocked(entities.listProjects);
const projectWork = vi.mocked(pm.readProjectPmInputs);
const getQueue = vi.mocked(queue.getMyWorkQueue);

const props = (key: string, over: Partial<OverviewWidgetProps> = {}): OverviewWidgetProps => ({
  me: head, tenantId: "co-a", period: "month", deptId: "d-web", unitPath: ["d-web"], tools: [],
  widget: { key, band: "you", label: key }, view: "team", subjectLabel: "Web Dev",
  workLinks: { projects: "/departments/d-web/projects", campaigns: null, requestsIncoming: "/departments/d-web/requests", requestsSent: null },
  ...over,
});

const kpi = (metricKey: string, value: number, extra: Partial<ReportKpi> = {}): ReportKpi => ({
  metricKey, label: metricKey, unit: "percent", value, appraisalSafe: true, direction: "up_good", previous: { value: 0 }, ...extra,
});
const document = (kpis: ReportKpi[]): ReportDocument => ({
  header: {
    tenantId: "co-a", grain: "department", scopeRef: "d-web", scopeName: "Web Dev", periodKind: "month",
    periodStart: "2026-10-01", periodEnd: "2026-10-31", dayCount: 31, periodLabel: "October 2026",
    generatedAt: "2026-10-13T08:00:00Z", sealed: false,
    comparison: { periodStart: "2026-09-01", periodEnd: "2026-09-30", dayCount: 30 },
  },
  kpis, series: [], distributions: [], tables: [], highlights: [], narrative: { source: "deterministic", text: "" },
});
const KPIS = [
  kpi("delivery.on_time_rate", 0.8, { numerator: 8, denominator: 10 }),
  kpi("flow.blocked_share", 0.1, { numerator: 10, denominator: 100 }),
  kpi("effort.capacity_utilization", 0.75, { numerator: 7200, denominator: 9600 }),
];
const row = (userId: string, expected: number, submitted: number) => ({ userId, expectedDays: expected, submittedDays: submitted, missedDays: expected - submitted, excusedDays: 0, complianceRate: submitted / expected });

const forbiddenErr = () => new PlatformError(403, "no");

beforeEach(() => {
  for (const m of [doc, compliance, unitCompliance, myLearning, listAppr, myAppr, summary, projects, projectWork, getQueue]) m.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("Team numbers (widget)", () => {
  it("reads the department's report document and the unit's check-in grid, as the signed-in head", async () => {
    doc.mockResolvedValue(document(KPIS));
    compliance.mockResolvedValue({ from: "2026-10-01", to: "2026-10-31", unit: "d-web", rows: [row("u-2", 10, 9), row("u-3", 10, 7)] });
    render(await YourNumbers(props("your-numbers")));
    expect(doc).toHaveBeenCalledWith("co-a", "u-1", expect.objectContaining({ grain: "department", scopeRef: "d-web", periodKind: "month" }));
    expect(compliance).toHaveBeenCalledWith("co-a", "u-1", expect.objectContaining({ unit: "d-web", periodKind: "month" }));

    const block = screen.getByRole("region", { name: "Team numbers" });
    expect(block).toHaveAttribute("data-state", "ok");
    const tile = (k: string) => block.querySelector(`[data-tile=${k}]`) as HTMLElement;
    expect(tile("check-ins")).toHaveTextContent("Check-ins sent16 of 20");
    expect(tile("on-time")).toHaveTextContent("80%");
    expect(tile("blocked")).toHaveTextContent("10%");
    expect(tile("hours")).toHaveTextContent("120 h of 160 h");
    expect(within(block).getByRole("link", { name: "Open the team report" }).getAttribute("href")).toMatch(/^\/reports\/team\?unit=d-web&periodKind=month&start=\d{4}-\d{2}-\d{2}/);
  });

  it("says No access or Unavailable per source, never 0", async () => {
    doc.mockRejectedValue(forbiddenErr());
    compliance.mockResolvedValue({ from: "a", to: "b", unit: "d-web", rows: [row("u-2", 4, 4)] });
    const first = render(await YourNumbers(props("your-numbers")));
    const block = screen.getByRole("region", { name: "Team numbers" });
    expect(block.querySelector("[data-tile=on-time]")).toHaveTextContent("No access");
    expect(block.querySelector("[data-tile=check-ins]")).toHaveTextContent("4 of 4");
    first.unmount();

    doc.mockRejectedValue(new Error("down"));
    compliance.mockRejectedValue(new Error("down"));
    render(await YourNumbers(props("your-numbers")));
    const refused = screen.getByRole("region", { name: "Team numbers" });
    expect(refused).toHaveAttribute("data-state", "unavailable");
    expect(refused).toHaveTextContent("Unavailable");
    expect(refused.querySelector("[data-tile]")).toBeNull();
  });

  it("is No data when the sources carry nothing", async () => {
    doc.mockResolvedValue(document([]));
    compliance.mockResolvedValue({ from: "a", to: "b", unit: "d-web", rows: [] });
    render(await YourNumbers(props("your-numbers")));
    const block = screen.getByRole("region", { name: "Team numbers" });
    for (const k of ["check-ins", "on-time", "blocked", "hours"]) expect(block.querySelector(`[data-tile=${k}]`)).toHaveTextContent("No data");
  });

  it("names a wider scope when the head leads more than this department", async () => {
    doc.mockResolvedValue(document(KPIS));
    compliance.mockResolvedValue({ from: "a", to: "b", unit: "d-web", rows: [row("u-2", 10, 9)] });
    render(await YourNumbers(props("your-numbers", { me: meFixture([member(), lead("d-web"), lead("d-seo")]) })));
    expect(screen.getByRole("region", { name: "Team numbers" }).querySelector("[data-tile=check-ins]")).toHaveTextContent("more than this department");
  });
});

describe("Team needs you (widget)", () => {
  const project = (id: string, name: string, status = "active") => ({ id, name, status, due_date: null });
  const work = (statuses: string[]) => ({ kind: "ok" as const, data: { tasks: statuses.map((status, i) => ({ id: `t${i}`, projectId: "p", status, dueDate: null })), milestones: [], statuses: [] } });

  it("shows what waits on the department and what is blocked in its open projects, from honest reads", async () => {
    summary.mockResolvedValue({ kind: "ok", data: { incoming: { open: 2, oldestOpenAt: null }, sent: { open: 0 } } });
    projects.mockResolvedValue([project("p1", "Site redesign"), project("p2", "Old", "completed"), project("p3", "Mobile")] as never);
    projectWork.mockImplementation(async (_u, _t, id) => (id === "p1" ? work(["blocked", "blocked", "todo"]) : work(["todo"])) as never);
    render(await NeedsYou(props("needs-you")));
    expect(summary).toHaveBeenCalledWith("u-1", "co-a", "d-web");
    expect(projects).toHaveBeenCalledWith("u-1", "co-a", undefined, "d-web");
    expect(projectWork).toHaveBeenCalledTimes(2); // the completed project is not read

    const block = screen.getByRole("region", { name: "Team needs you" });
    expect(block.querySelector("[data-part=requests]")).toHaveTextContent("Waiting on Web Dev2 requests waiting");
    expect(block.querySelector("[data-part=blockers]")).toHaveTextContent("2 blocked tasks");
    expect(within(block).getByRole("link", { name: "Site redesign" })).toHaveAttribute("href", "/projects/p1");
    expect(within(block).getByRole("link", { name: "Open incoming requests" })).toHaveAttribute("href", "/departments/d-web/requests");
  });

  it("says nothing waits only from successful reads", async () => {
    summary.mockResolvedValue({ kind: "ok", data: { incoming: { open: 0, oldestOpenAt: null }, sent: { open: 0 } } });
    projects.mockResolvedValue([project("p1", "Site redesign")] as never);
    projectWork.mockResolvedValue(work(["todo", "done"]) as never);
    render(await NeedsYou(props("needs-you")));
    const block = screen.getByRole("region", { name: "Team needs you" });
    expect(block.querySelector("[data-part=requests] [data-state=empty]")).toHaveTextContent("No request is waiting.");
    expect(block.querySelector("[data-part=blockers] [data-state=empty]")).toHaveTextContent("No blocked tasks.");
  });

  it("says No access or Unavailable in each source's own place, never nothing waiting", async () => {
    summary.mockRejectedValue(forbiddenErr());
    projects.mockRejectedValue(new Error("down"));
    render(await NeedsYou(props("needs-you")));
    const block = screen.getByRole("region", { name: "Team needs you" });
    expect(block.querySelector("[data-part=requests]")).toHaveTextContent("No access");
    expect(block.querySelector("[data-part=blockers]")).toHaveTextContent("Unavailable");
    expect(block).not.toHaveTextContent(/No request is waiting|No blocked tasks|No open projects/);
  });

  it("flags a project whose work could not be read, so zero blocked is only a floor", async () => {
    summary.mockResolvedValue({ kind: "ok", data: { incoming: { open: 0, oldestOpenAt: null }, sent: { open: 0 } } });
    projects.mockResolvedValue([project("p1", "A"), project("p2", "B")] as never);
    projectWork.mockImplementation(async (_u, _t, id) => (id === "p1" ? work(["todo"]) : { kind: "unavailable", reason: "x" }) as never);
    render(await NeedsYou(props("needs-you")));
    const blockers = screen.getByRole("region", { name: "Team needs you" }).querySelector("[data-part=blockers]")!;
    expect(blockers).toHaveTextContent("No blocked tasks in the projects that could be read.");
    expect(blockers).toHaveTextContent("1 project could not be read, so this may be more.");
  });

  it("does not run the person's own queue in Team mode", async () => {
    summary.mockResolvedValue({ kind: "ok", data: { incoming: { open: 0, oldestOpenAt: null }, sent: { open: 0 } } });
    projects.mockResolvedValue([] as never);
    render(await NeedsYou(props("needs-you")));
    expect(getQueue).not.toHaveBeenCalled();
  });
});

describe("Team learning (widget)", () => {
  const path = (over: Partial<lms.ComplianceRow>): lms.ComplianceRow => ({ pathKey: "k", title: "T", isMandatory: true, assigned: 0, completed: 0, outstanding: 0, overdue: 0, waived: 0, ...over });

  it("reads the unit-scoped compliance for this department and shows required coverage and overdue", async () => {
    unitCompliance.mockResolvedValue({ kind: "ok", data: { unit: "d-web", learners: 2, paths: [path({ assigned: 4, completed: 3, outstanding: 1, overdue: 1 })] } });
    render(await Learning(props("learning")));
    expect(unitCompliance).toHaveBeenCalledWith("u-1", "co-a", "d-web");
    const block = screen.getByRole("region", { name: "Team learning" });
    expect(block).toHaveAttribute("data-state", "ok");
    expect(block).toHaveTextContent("75% complete");
    expect(block).toHaveTextContent("3 of 4 required assignments, 2 people");
    expect(block.querySelector("[data-flag=overdue]")).toHaveTextContent("1 overdue");
    expect(within(block).getByRole("link", { name: "Team progress" })).toHaveAttribute("href", "/learning/compliance?unit=d-web");
  });

  it("says nobody is placed for an empty roster, not 0%", async () => {
    unitCompliance.mockResolvedValue({ kind: "ok", data: { unit: "d-web", learners: 0, paths: [path({})] } });
    render(await Learning(props("learning")));
    const block = screen.getByRole("region", { name: "Team learning" });
    expect(block).toHaveAttribute("data-state", "empty");
    expect(block).toHaveTextContent("No one is placed in Web Dev today");
    expect(block).not.toHaveTextContent("%");
  });

  it("says No access when refused and Unavailable for an error or an unknown department", async () => {
    unitCompliance.mockResolvedValue({ kind: "forbidden" });
    const a = render(await Learning(props("learning")));
    expect(screen.getByRole("region", { name: "Team learning" })).toHaveTextContent("No access");
    a.unmount();
    unitCompliance.mockResolvedValue({ kind: "error", reason: "x" });
    const b = render(await Learning(props("learning")));
    expect(screen.getByRole("region", { name: "Team learning" })).toHaveTextContent("Unavailable");
    b.unmount();
    unitCompliance.mockResolvedValue({ kind: "not_found" });
    render(await Learning(props("learning")));
    expect(screen.getByRole("region", { name: "Team learning" })).toHaveTextContent("Unavailable");
  });
});

describe("Team appraisals (widget)", () => {
  const entry = (id: string, status: string, cycleId = "c1") => ({ id, cycleId, subjectUserId: `s-${id}`, managerUserId: "m", status, composite: null });

  it("shows progress by status over the head's list", async () => {
    listAppr.mockResolvedValue({ appraisals: [entry("a", "finalized"), entry("b", "draft"), entry("c", "submitted"), entry("d", "disputed", "c2")] } as never);
    render(await Appraisal(props("appraisal")));
    expect(listAppr).toHaveBeenCalledWith("co-a", "u-1");
    const block = screen.getByRole("region", { name: "Team appraisals" });
    expect(block.querySelector("[data-part=finalized]")).toHaveTextContent("1 of 4 finalized");
    expect(block.querySelector("[data-part=breakdown]")).toHaveTextContent("1 being scored, 1 awaiting acknowledgement, 1 disputed");
    expect(block).toHaveTextContent("Across 2 cycles");
    expect(within(block).getByRole("link", { name: "Team appraisals" })).toHaveAttribute("href", "/appraisals");
  });

  it("says no appraisals yet only for an ok empty list", async () => {
    listAppr.mockResolvedValue({ appraisals: [] });
    render(await Appraisal(props("appraisal")));
    expect(screen.getByRole("region", { name: "Team appraisals" })).toHaveAttribute("data-state", "empty");
    expect(screen.getByRole("region", { name: "Team appraisals" })).toHaveTextContent("No appraisals yet.");
  });

  it("says No access or Unavailable, never none", async () => {
    listAppr.mockRejectedValue(forbiddenErr());
    const a = render(await Appraisal(props("appraisal")));
    expect(screen.getByRole("region", { name: "Team appraisals" })).toHaveTextContent("No access");
    a.unmount();
    listAppr.mockRejectedValue(new Error("down"));
    render(await Appraisal(props("appraisal")));
    const block = screen.getByRole("region", { name: "Team appraisals" });
    expect(block).toHaveTextContent("Unavailable");
    expect(block).not.toHaveTextContent(/No appraisals yet|finalized/);
  });
});

describe("Me mode is untouched (DW-3h)", () => {
  it("Learning and Appraisal read the person's own data and never the team's", async () => {
    myLearning.mockResolvedValue({ enrolments: [], certifications: [] } as never);
    myAppr.mockResolvedValue({ appraisals: [] });
    for (const view of [undefined, "me" as const]) {
      const a = render(await Learning(props("learning", { view })));
      expect(screen.getByRole("region", { name: "Learning" })).toHaveTextContent("Nothing outstanding.");
      a.unmount();
      const b = render(await Appraisal(props("appraisal", { view })));
      expect(screen.getByRole("region", { name: "Appraisal" })).toHaveTextContent("No appraisal yet");
      b.unmount();
    }
    expect(unitCompliance).not.toHaveBeenCalled();
    expect(listAppr).not.toHaveBeenCalled();
  });

  it("Your numbers reads the person grain, and no department or check-in grid", async () => {
    doc.mockResolvedValue({ ...document([]), header: { ...document([]).header, grain: "person" } });
    render(await YourNumbers(props("your-numbers", { view: "me" })));
    expect(screen.getByRole("region", { name: "Your numbers" })).toBeInTheDocument();
    expect(doc).toHaveBeenCalledWith("co-a", "u-1", expect.objectContaining({ grain: "person", scopeRef: "u-1" }));
    expect(compliance).not.toHaveBeenCalled();
  });

  it("Needs you in Me mode does not read the team's requests or projects", async () => {
    getQueue.mockResolvedValue({ items: [], companies: [{ id: "co-a", name: "Agency", included: true }] } as never);
    render(await NeedsYou(props("needs-you", { view: "me" })));
    expect(screen.getByRole("region", { name: "Needs you" })).toBeInTheDocument();
    expect(summary).not.toHaveBeenCalled();
    expect(projects).not.toHaveBeenCalled();
  });
});
