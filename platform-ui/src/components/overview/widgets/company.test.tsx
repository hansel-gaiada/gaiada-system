import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OVERVIEW_WIDGETS, hasOverviewWidget, type OverviewWidgetProps } from "./index";
import { Decisions } from "./Decisions";
import { Company } from "./Company";
import { Departments } from "./Departments";
import { CompanyCampaigns } from "./CompanyCampaigns";
import { CompanyLearning } from "./CompanyLearning";
import { CompanyAppraisals } from "./CompanyAppraisals";
import { COMPANY_OVERVIEW } from "@/lib/workspaces";
import { me as meFixture } from "@/lib/workspaceFixtures";
import { PlatformError } from "@/lib/platform";
import * as queue from "@/lib/queue";
import * as reports from "@/lib/reports-data";
import * as money from "@/lib/overviewCompany-data";
import * as deptKpis from "@/lib/overviewDepartments-data";
import * as campaigns from "@/lib/campaigns-data";
import * as lms from "@/lib/lms";
import * as appraisals from "@/lib/appraisals-data";
import type { QueueItem } from "@/lib/queueUrgency";
import type { DeptStanding } from "@/lib/overviewDepartments";

vi.mock("@/lib/queue", async (orig) => ({ ...(await orig<typeof import("@/lib/queue")>()), getMyWorkQueue: vi.fn() }));
vi.mock("@/lib/reports-data", async (orig) => ({ ...(await orig<typeof import("@/lib/reports-data")>()), getReportDocument: vi.fn() }));
vi.mock("@/lib/overviewCompany-data", () => ({ readCompanyMoney: vi.fn() }));
vi.mock("@/lib/overviewDepartments-data", () => ({ readDeptKpiOverview: vi.fn() }));
vi.mock("@/lib/campaigns-data", async (orig) => ({ ...(await orig<typeof import("@/lib/campaigns-data")>()), readAllCampaigns: vi.fn() }));
vi.mock("@/lib/lms", async (orig) => ({ ...(await orig<typeof import("@/lib/lms")>()), getCompanyCompliance: vi.fn() }));
vi.mock("@/lib/appraisals-data", async (orig) => ({ ...(await orig<typeof import("@/lib/appraisals-data")>()), listAppraisals: vi.fn() }));

const T = "co-a";
const grant = (...roles: string[]) => meFixture(roles.map((role) => ({ role, scopeType: "company", scopeId: T })));
const admin = grant("company_admin");
const member = grant("member");
const narrowed = grant("manager"); // reports.department.view, no company tier, no finance
const narrowedWithFinance = grant("manager", "finance_manager"); // console access plus the finance read capability

const props = (key: string, who = admin, extra: Partial<OverviewWidgetProps> = {}): OverviewWidgetProps => ({
  me: who, tenantId: T, period: "month", deptId: null, unitPath: [], tools: [], widget: { key, band: "now", label: key }, ...extra,
});

const getQueue = vi.mocked(queue.getMyWorkQueue);
const getDocument = vi.mocked(reports.getReportDocument);
const readMoney = vi.mocked(money.readCompanyMoney);
const readDepts = vi.mocked(deptKpis.readDeptKpiOverview);
const readCampaigns = vi.mocked(campaigns.readAllCampaigns);
const getCompliance = vi.mocked(lms.getCompanyCompliance);
const listAppr = vi.mocked(appraisals.listAppraisals);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T10:00:00Z"));
  for (const m of [getQueue, getDocument, readMoney, readDepts, readCampaigns, getCompliance, listAppr]) m.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const noReads = () => {
  for (const m of [getQueue, getDocument, readMoney, readDepts, readCampaigns, getCompliance, listAppr]) expect(m).not.toHaveBeenCalled();
};

describe("the company blocks are wired into the host (DW-3i)", () => {
  it("has a component for every widget of the company Overview", () => {
    for (const w of COMPANY_OVERVIEW) expect(hasOverviewWidget(w.key, OVERVIEW_WIDGETS), w.key).toBe(true);
  });
});

// ── Needs you: decisions ─────────────────────────────────────────────────────────────────────────

const item = (id: string, extra: Partial<QueueItem> = {}): QueueItem => ({
  id, type: "approval", title: `Approve ${id}`, companyId: T, company: "Agency", createdAt: "2026-10-01T00:00:00Z", decidable: true, urgencyScore: 0, href: `/approvals/${id}`, ...extra,
});
const envelope = (items: QueueItem[], leg: Record<string, unknown> = {}) => ({ items, companies: [{ id: T, name: "Agency", included: true, ...leg }] });

describe("Decisions (widget)", () => {
  it("is not drawn, and reads nothing, for someone the cockpit refuses", async () => {
    expect(await Decisions(props("decisions", member))).toBeNull();
    noReads();
  });

  it("draws the approvals and gates of the company with how long they have waited", async () => {
    getQueue.mockResolvedValue(envelope([item("a1"), item("g1", { type: "gate", decidable: false }), item("t1", { type: "task" })]) as never);
    render(await Decisions(props("decisions", narrowed)));
    const block = screen.getByRole("region", { name: "Needs you: decisions" });
    expect(within(block).getByText(/2 awaiting a decision, 2 waiting 5 days or more, 1 not yours to decide/)).toBeInTheDocument();
    expect(within(block).getByRole("link", { name: "Approve a1" })).toHaveAttribute("href", "/approvals/a1");
    expect(within(block).getAllByText(/Waiting 13d/)).toHaveLength(2);
    expect(within(block).getByText(/Someone else must act/)).toBeInTheDocument();
    expect(within(block).queryByText("Title t1")).toBeNull();
    expect(within(block).getByRole("link", { name: "All approvals" })).toHaveAttribute("href", "/approvals");
  });

  it("says nothing is waiting only when every source answered", async () => {
    getQueue.mockResolvedValue(envelope([]) as never);
    const first = render(await Decisions(props("decisions")));
    expect(screen.getByText("Nothing is waiting on a decision.")).toBeInTheDocument();
    first.unmount();
    getQueue.mockResolvedValue(envelope([], { partialSources: ["agency approvals"] }) as never);
    render(await Decisions(props("decisions")));
    expect(screen.queryByText("Nothing is waiting on a decision.")).toBeNull();
    expect(screen.getByText(/This list is incomplete: agency approvals could not be read/)).toBeInTheDocument();
  });

  it("says Unavailable when this company's leg was not read, and never an empty list", async () => {
    getQueue.mockResolvedValue(envelope([], { included: false }) as never);
    render(await Decisions(props("decisions")));
    const block = screen.getByRole("region", { name: "Needs you: decisions" });
    expect(block).toHaveAttribute("data-state", "unavailable");
    expect(within(block).getByText("Unavailable")).toBeInTheDocument();
    expect(within(block).queryByText(/Nothing is waiting/)).toBeNull();
  });
});

// ── Company ──────────────────────────────────────────────────────────────────────────────────────

const document_ = {
  header: { periodLabel: "October 2026" },
  kpis: [
    { metricKey: "delivery.milestone_hit_rate", label: "m", unit: "percent", value: 0.5, numerator: 4, denominator: 8 },
    { metricKey: "effort.capacity_utilization", label: "u", unit: "percent", value: 0.8, numerator: 4800, denominator: 6000 },
  ],
};
const moneyOk = {
  periods: { kind: "ok" as const, data: [{ id: "p" }] },
  pnl: { kind: "ok" as const, data: [{ section: "total", code: "TOTAL_REVENUE", name: "Revenue", amount: "331000000.0000" }, { section: "total", code: "NET_PROFIT", name: "Net", amount: "199000000.0000" }] },
  ar: { kind: "ok" as const, data: [{ customerCode: "c", customerName: "C", totalOutstanding: "100000000", current: "40000000", d90Plus: "0" }] },
};
const tileValue = (block: HTMLElement, key: string) => within(block.querySelector(`[data-tile="${key}"]`) as HTMLElement).getAllByText(/./).map((n) => n.textContent);

describe("Company (widget)", () => {
  it("reads nothing and draws nothing for a member or a narrowed lead without the finance capability", async () => {
    expect(await Company(props("company", member))).toBeNull();
    expect(await Company(props("company", narrowed))).toBeNull();
    noReads();
  });

  it("for the full tier reads the company report and the money, for the calendar period of the selected one", async () => {
    getDocument.mockResolvedValue(document_ as never);
    readMoney.mockResolvedValue(moneyOk as never);
    render(await Company(props("company", admin, { period: "month" })));
    expect(getDocument).toHaveBeenCalledWith(T, "u-1", { grain: "company", scopeRef: T, periodKind: "month", start: "2026-10-14", end: "2026-10-14" });
    expect(readMoney).toHaveBeenCalledWith("u-1", T, "2026-10-01", "2026-10-31");
    const block = screen.getByRole("region", { name: "Company" });
    expect([...block.querySelectorAll("[data-tile]")].map((n) => n.getAttribute("data-tile"))).toEqual(["revenue", "overdue", "milestones", "utilization"]);
    expect(tileValue(block, "revenue")).toContain("331.0M IDR");
    expect(tileValue(block, "overdue")).toContain("60.0M IDR");
    expect(tileValue(block, "milestones")).toContain("50%");
    expect(tileValue(block, "utilization")).toContain("80%");
    expect(within(block).getByRole("link", { name: "Company report" })).toHaveAttribute("href", "/reports/company?periodKind=month&start=2026-10-14");
    expect(within(block).getByRole("link", { name: "Finance" })).toHaveAttribute("href", "/finance/reports");
  });

  it("follows the selected period into the money window", async () => {
    getDocument.mockResolvedValue(document_ as never);
    readMoney.mockResolvedValue(moneyOk as never);
    render(await Company(props("company", admin, { period: "week" })));
    expect(readMoney).toHaveBeenCalledWith("u-1", T, "2026-10-12", "2026-10-18");
  });

  it("for a narrowed lead who also holds finance reads the money and NOT the company report", async () => {
    readMoney.mockResolvedValue(moneyOk as never);
    render(await Company(props("company", narrowedWithFinance)));
    expect(getDocument).not.toHaveBeenCalled();
    const block = screen.getByRole("region", { name: "Company" });
    expect([...block.querySelectorAll("[data-tile]")].map((n) => n.getAttribute("data-tile"))).toEqual(["revenue", "overdue"]);
    expect(within(block).queryByRole("link", { name: "Company report" })).toBeNull();
  });

  it("answers for each part on its own: a refused report says No access beside money that is there", async () => {
    getDocument.mockRejectedValue(new PlatformError(403, "forbidden"));
    readMoney.mockResolvedValue(moneyOk as never);
    render(await Company(props("company")));
    const block = screen.getByRole("region", { name: "Company" });
    expect(tileValue(block, "revenue")).toContain("331.0M IDR");
    expect(block.querySelector('[data-tile="milestones"]')).toHaveAttribute("data-state", "forbidden");
    expect(tileValue(block, "milestones")).toContain("No access");
    expect(tileValue(block, "utilization")).toContain("No access");
  });

  it("says Unavailable, never 0, when both reads fail", async () => {
    getDocument.mockRejectedValue(new Error("down"));
    readMoney.mockResolvedValue({ periods: { kind: "unavailable", reason: "x" }, pnl: null, ar: null } as never);
    render(await Company(props("company")));
    const block = screen.getByRole("region", { name: "Company" });
    for (const k of ["revenue", "overdue", "milestones", "utilization"]) expect(block.querySelector(`[data-tile="${k}"]`), k).toHaveAttribute("data-state", "unavailable");
    expect(within(block).queryByText(/^0/)).toBeNull();
  });

  it("draws no money, and no 'No access', when the finance gate read is refused", async () => {
    getDocument.mockResolvedValue(document_ as never);
    readMoney.mockResolvedValue({ periods: { kind: "forbidden" }, pnl: null, ar: null } as never);
    render(await Company(props("company")));
    const block = screen.getByRole("region", { name: "Company" });
    expect([...block.querySelectorAll("[data-tile]")].map((n) => n.getAttribute("data-tile"))).toEqual(["milestones", "utilization"]);
    expect(within(block).queryByText("No access")).toBeNull();
  });

  it("says setup, not zero, when the company has no fiscal calendar", async () => {
    getDocument.mockResolvedValue(document_ as never);
    readMoney.mockResolvedValue({ periods: { kind: "ok", data: [] }, pnl: null, ar: null } as never);
    render(await Company(props("company")));
    const block = screen.getByRole("region", { name: "Company" });
    expect(within(block).getByText(/No fiscal calendar yet/)).toBeInTheDocument();
    expect(block.querySelector('[data-tile="revenue"]')).toBeNull();
  });
});

// ── Departments by condition ─────────────────────────────────────────────────────────────────────

const standing = (id: string, name: string, condition: DeptStanding["condition"], withTarget = true): DeptStanding => ({
  id, name, workspace: null, condition,
  kpis: [{
    key: "projects-on-time", label: "Projects on time", unit: "percent", direction: "up_good", value: withTarget ? 0.62 : null, target: withTarget ? 0.85 : null,
    tolerance: withTarget ? 0.1 : null, targetSource: withTarget ? "approved" : "none", condition, reason: withTarget ? null : "no_target",
  }],
});

describe("Departments (widget)", () => {
  it("reads nothing and draws nothing for anyone but the full tier, narrowed leads included", async () => {
    expect(await Departments(props("departments", member))).toBeNull();
    expect(await Departments(props("departments", narrowed))).toBeNull();
    noReads();
  });

  it("reads the company standing for the selected period and draws the departments worst first, the unrated last", async () => {
    readDepts.mockResolvedValue({
      kind: "ok",
      data: { departments: [standing("d-seo", "SEO", "unavailable", false), standing("d-web", "Web Dev", "off_track"), standing("d-cr", "Creatives", "on_track"), standing("d-soc", "Social", "at_risk")] },
    });
    render(await Departments(props("departments", admin, { period: "month" })));
    expect(readDepts).toHaveBeenCalledWith("u-1", T, "month", "2026-10-14");
    const block = screen.getByRole("region", { name: "Departments by condition" });
    expect([...block.querySelectorAll("[data-dept]")].map((n) => [n.getAttribute("data-dept"), n.getAttribute("data-condition")])).toEqual([
      ["d-web", "off_track"], ["d-soc", "at_risk"], ["d-cr", "on_track"], ["d-seo", "unavailable"],
    ]);
    expect(within(block).getByText("Projects on time: 62% against a target of 85%", { selector: "li[data-dept=d-web] span" })).toBeInTheDocument();
    const seo = block.querySelector("[data-dept=d-seo]") as HTMLElement;
    expect(within(seo).getByText("No condition yet")).toBeInTheDocument();
    expect(within(seo).getByText("No target set")).toBeInTheDocument();
    expect(within(block).getByText("1 off track, 1 at risk, 1 on track, 1 with no condition yet, worst first")).toBeInTheDocument();
    expect(within(block).getByRole("link", { name: "Web Dev" })).toHaveAttribute("href", "/departments/d-web");
  });

  it("the live state until targets are approved: every department says No target set", async () => {
    readDepts.mockResolvedValue({ kind: "ok", data: { departments: [standing("d-b", "B", "unavailable", false), standing("d-a", "A", "unavailable", false)] } });
    render(await Departments(props("departments")));
    const block = screen.getByRole("region", { name: "Departments by condition" });
    expect(within(block).getAllByText("No target set")).toHaveLength(2);
    expect([...block.querySelectorAll("[data-dept]")].map((n) => n.getAttribute("data-dept"))).toEqual(["d-a", "d-b"]);
  });

  it("says No access for a refusal and Unavailable for a failure, never an empty list", async () => {
    readDepts.mockResolvedValue({ kind: "forbidden" });
    const first = render(await Departments(props("departments")));
    expect(screen.getByRole("region", { name: "Departments by condition" })).toHaveAttribute("data-state", "forbidden");
    expect(screen.getByText("No access")).toBeInTheDocument();
    first.unmount();
    readDepts.mockResolvedValue({ kind: "unavailable", reason: "x" });
    render(await Departments(props("departments")));
    expect(screen.getByRole("region", { name: "Departments by condition" })).toHaveAttribute("data-state", "unavailable");
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/No department in the org structure/)).toBeNull();
  });

  it("an empty answer from a successful read is a real 'no department'", async () => {
    readDepts.mockResolvedValue({ kind: "ok", data: { departments: [] } });
    render(await Departments(props("departments")));
    expect(screen.getByText("No department in the org structure.")).toBeInTheDocument();
  });
});

// ── Campaigns across departments ─────────────────────────────────────────────────────────────────

const camp = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: `Campaign ${id}`, status: "active", projectId: null, clientId: null, leadUnitId: null, startsOn: null, endsOn: null, partCount: 0, part: null, ...extra,
});

describe("CompanyCampaigns (widget)", () => {
  it("lists the open campaigns with the departments in each, soonest ending first, and links to the Agency page", async () => {
    readCampaigns.mockResolvedValue({ kind: "ok", data: [camp("b", { partCount: 3, endsOn: "2026-12-01" }), camp("a", { partCount: 1, endsOn: "2026-11-01" }), camp("x", { status: "completed" })] as never });
    render(await CompanyCampaigns(props("company-campaigns", member)));
    expect(readCampaigns).toHaveBeenCalledWith("u-1", T);
    const block = screen.getByRole("region", { name: "Campaigns" });
    expect(within(block).getAllByRole("listitem").map((li) => li.getAttribute("data-campaign"))).toEqual(["a", "b"]);
    expect(within(block).getByText(/3 departments/)).toBeInTheDocument();
    expect(within(block).getByText(/1 department$/)).toBeInTheDocument();
    expect(within(block).getByRole("link", { name: "Campaign a" })).toHaveAttribute("href", "/agency/a");
    expect(within(block).getByRole("link", { name: "All campaigns" })).toHaveAttribute("href", "/agency");
  });

  it("says No access, Unavailable or No open campaigns, each only for its own read", async () => {
    readCampaigns.mockResolvedValue({ kind: "forbidden" });
    let r = render(await CompanyCampaigns(props("company-campaigns")));
    expect(screen.getByText("No access")).toBeInTheDocument();
    r.unmount();
    readCampaigns.mockResolvedValue({ kind: "unavailable", reason: "x" });
    r = render(await CompanyCampaigns(props("company-campaigns")));
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No open campaigns.")).toBeNull();
    r.unmount();
    readCampaigns.mockResolvedValue({ kind: "ok", data: [] });
    render(await CompanyCampaigns(props("company-campaigns")));
    expect(screen.getByText("No open campaigns.")).toBeInTheDocument();
  });
});

// ── Growth ───────────────────────────────────────────────────────────────────────────────────────

describe("CompanyLearning (widget)", () => {
  it("reads nothing for anyone but the full tier", async () => {
    expect(await CompanyLearning(props("learning-compliance", member))).toBeNull();
    expect(await CompanyLearning(props("learning-compliance", narrowed))).toBeNull();
    noReads();
  });

  it("draws mandatory coverage, what is overdue and the weakest path", async () => {
    getCompliance.mockResolvedValue([
      { pathKey: "a", title: "Induction", isMandatory: true, assigned: 20, completed: 18, outstanding: 2, overdue: 0, waived: 0 },
      { pathKey: "b", title: "Security", isMandatory: true, assigned: 20, completed: 8, outstanding: 12, overdue: 6, waived: 0 },
    ]);
    render(await CompanyLearning(props("learning-compliance")));
    expect(getCompliance).toHaveBeenCalledWith("u-1", T);
    const block = screen.getByRole("region", { name: "Learning compliance" });
    expect(within(block).getByText("65% of mandatory training complete")).toBeInTheDocument();
    expect(within(block).getByText("26 of 40 assigned, across 2 mandatory paths")).toBeInTheDocument();
    expect(within(block).getByText("6 overdue")).toBeInTheDocument();
    expect(within(block).getByText("Lowest: Security, 40%")).toBeInTheDocument();
    expect(within(block).getByRole("link", { name: "Learning compliance" })).toHaveAttribute("href", "/learning/compliance");
  });

  it("says No access for a 403, Unavailable for a failure and 'nothing assigned' only for an empty successful read", async () => {
    getCompliance.mockRejectedValue(new PlatformError(403, "forbidden"));
    let r = render(await CompanyLearning(props("learning-compliance")));
    expect(screen.getByRole("region", { name: "Learning compliance" })).toHaveAttribute("data-state", "forbidden");
    r.unmount();
    getCompliance.mockRejectedValue(new Error("down"));
    r = render(await CompanyLearning(props("learning-compliance")));
    expect(screen.getByRole("region", { name: "Learning compliance" })).toHaveAttribute("data-state", "unavailable");
    expect(screen.queryByText(/No mandatory training/)).toBeNull();
    r.unmount();
    getCompliance.mockResolvedValue([]);
    render(await CompanyLearning(props("learning-compliance")));
    expect(screen.getByText("No mandatory training is assigned.")).toBeInTheDocument();
  });
});

describe("CompanyAppraisals (widget)", () => {
  it("reads nothing for anyone but the full tier", async () => {
    expect(await CompanyAppraisals(props("appraisal-cycle", member))).toBeNull();
    expect(await CompanyAppraisals(props("appraisal-cycle", narrowed))).toBeNull();
    noReads();
  });

  it("draws progress by stage, tenant first then user", async () => {
    listAppr.mockResolvedValue({
      appraisals: [
        { id: "1", cycleId: "c1", subjectUserId: "a", managerUserId: "m", status: "finalized", composite: 4 },
        { id: "2", cycleId: "c1", subjectUserId: "b", managerUserId: "m", status: "submitted", composite: null },
        { id: "3", cycleId: "c2", subjectUserId: "c", managerUserId: "m", status: "disputed", composite: null },
      ],
    } as never);
    render(await CompanyAppraisals(props("appraisal-cycle")));
    expect(listAppr).toHaveBeenCalledWith(T, "u-1");
    const block = screen.getByRole("region", { name: "Appraisal cycle" });
    expect(within(block).getByText("1 of 3 finalized")).toBeInTheDocument();
    expect(within(block).getByText("Across 2 cycles")).toBeInTheDocument();
    expect(within(block).getByText("1 awaiting acknowledgement, 1 disputed")).toBeInTheDocument();
    expect(within(block).getByRole("link", { name: "All appraisals" })).toHaveAttribute("href", "/appraisals");
  });

  it("says No access, Unavailable, and No appraisals yet only for an empty successful read", async () => {
    listAppr.mockRejectedValue(new PlatformError(403, "forbidden"));
    let r = render(await CompanyAppraisals(props("appraisal-cycle")));
    expect(screen.getByRole("region", { name: "Appraisal cycle" })).toHaveAttribute("data-state", "forbidden");
    r.unmount();
    listAppr.mockRejectedValue(new Error("down"));
    r = render(await CompanyAppraisals(props("appraisal-cycle")));
    expect(screen.getByRole("region", { name: "Appraisal cycle" })).toHaveAttribute("data-state", "unavailable");
    r.unmount();
    listAppr.mockResolvedValue({ appraisals: [] });
    render(await CompanyAppraisals(props("appraisal-cycle")));
    expect(screen.getByText("No appraisals yet.")).toBeInTheDocument();
  });
});
