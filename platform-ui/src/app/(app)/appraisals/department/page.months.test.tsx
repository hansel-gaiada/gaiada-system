import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

// DW-10b-2 (BFF section 58.4): the department KPI page's By month view (`?view=months`). The series read is honest (a refusal and a failure are said,
// never an empty table), the plan form is offered to a proposer only, the approver gets the grouped proposals, and the switch keeps `unit`.

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-1", companies: [], roles: [] })) }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("@/lib/rbac", () => ({ can: vi.fn(() => false), canInUnit: vi.fn(() => false), unitPathOf: vi.fn(() => []) }));
vi.mock("@/lib/campaigns-data", () => ({ readOrgRoot: vi.fn(async () => null) }));
vi.mock("@/lib/deptKpis", async (orig) => ({
  ...(await orig<typeof import("@/lib/deptKpis")>()),
  getDeptKpis: vi.fn(),
  getDeptKpiTargets: vi.fn(),
  getDeptKpiMonths: vi.fn(),
}));
vi.mock("@/lib/deptKpiAlerts", () => ({ getUnitKpiAlerts: vi.fn(async () => ({ kind: "ok", data: [] })) }));
vi.mock("@/lib/deptKpiDrivers", async (orig) => ({ ...(await orig<typeof import("@/lib/deptKpiDrivers")>()), getKpiDrivers: vi.fn(async () => ({ kind: "forbidden" })) }));
vi.mock("@/lib/deptAppraisals", () => ({ getCyclePicks: vi.fn(async () => ({ kind: "ok", data: [] })), getDeptAppraisal: vi.fn() }));
vi.mock("@/lib/deptKpiActions", () => ({
  proposeTargetsBatchAction: vi.fn(), decideTargetsBatchAction: vi.fn(), proposeDeptKpiTarget: vi.fn(), approveDeptKpiTarget: vi.fn(), rejectDeptKpiTarget: vi.fn(),
}));
vi.mock("@/components/PageHeader", () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock("@/components/reports/ReportPeriodBar", () => ({ ReportPeriodBar: () => <div data-testid="period-bar" /> }));
vi.mock("@/components/deptkpis/AppraisalView", () => ({ AppraisalView: () => null, CyclePicker: () => null }));
vi.mock("@/components/deptkpis/KpiAlerts", () => ({ AlertsSection: () => null, TileAlertLine: () => null }));

import { can, canInUnit } from "@/lib/rbac";
import { getDeptKpis, getDeptKpiMonths, getDeptKpiTargets, type DeptKpiMonthsView, type DeptKpiTargetRow, type DeptKpiTargetsKpi } from "@/lib/deptKpis";
import DepartmentKpiPage from "./page";

const months: DeptKpiMonthsView = {
  unit: { id: "dept-1", name: "Web Dev" }, workspace: "web-dev",
  months: ["2026-08", "2026-09", "2026-10"].map((m, i) => ({ month: m, start: `${m}-01`, end: `${m}-28`, partial: i === 2, condition: "at_risk" as const })),
  kpis: [{
    key: "projects-on-time", label: "Projects on time", unit: "percent", direction: "up_good",
    cells: [
      { month: "2026-08", value: 0.8, target: 0.82, tolerance: 0.05, targetSource: "approved", condition: "at_risk" },
      { month: "2026-09", value: null, target: 0.85, tolerance: 0.05, targetSource: "approved", condition: "unavailable", reason: "no_data" },
      { month: "2026-10", value: 0.9, target: 0.85, tolerance: 0.05, targetSource: "approved", condition: "on_track" },
    ],
  }],
};
const proposal = (id: string, proposedBy: string): DeptKpiTargetRow => ({
  id, unitNodeId: "dept-1", kpiKey: "projects-on-time", effectiveFrom: "2026-11-01", target: 0.9, tolerance: 0.05, status: "proposed", note: null,
  proposedBy, proposedAt: "2026-10-15T08:00:00.000Z", decidedBy: null, decidedAt: null,
});
const targetsKpi = (proposals: DeptKpiTargetRow[] = []): DeptKpiTargetsKpi => ({
  key: "projects-on-time", label: "Projects on time", unit: "percent", direction: "up_good", suggestedTarget: 0.85, suggestedTolerance: 0.05,
  inForce: null, proposals, history: [],
});
const targetsOk = (proposals: DeptKpiTargetRow[] = []) => ({ kind: "ok", data: { unit: { id: "dept-1", name: "Web Dev" }, workspace: "web-dev", asOf: "2026-10-01", kpis: [targetsKpi(proposals)] } });

const mount = async (search: Record<string, string> = { unit: "dept-1", view: "months" }) => render(await DepartmentKpiPage({ searchParams: Promise.resolve(search) }));
const asHead = () => vi.mocked(canInUnit).mockImplementation((_me, perm) => perm === "reports.dept_kpi_target.propose");
const asApprover = () => vi.mocked(can).mockImplementation((_me, perm) => perm === "reports.dept_kpi_target.approve");

beforeEach(() => {
  vi.mocked(can).mockReset().mockReturnValue(false);
  vi.mocked(canInUnit).mockReset().mockReturnValue(false);
  vi.mocked(getDeptKpiMonths).mockReset().mockResolvedValue({ kind: "ok", data: months });
  vi.mocked(getDeptKpiTargets).mockReset().mockResolvedValue(targetsOk() as never);
  vi.mocked(getDeptKpis).mockReset();
});

describe("?view=months: the table and the read", () => {
  it("reads the series for the unit only (the default window), not the period view's KPIs, and renders the table", async () => {
    await mount();
    expect(vi.mocked(getDeptKpiMonths)).toHaveBeenCalledWith("u-1", "co-1", "dept-1", {});
    expect(vi.mocked(getDeptKpis)).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Web Dev · Department");
    const table = screen.getByRole("table", { name: /Web Dev: each KPI by month/ });
    expect(within(table).getAllByRole("columnheader")).toHaveLength(4);
    expect(within(table).getByText("Unavailable · No data this period")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show the trend for Projects on time" })).toBeInTheDocument();
    expect(screen.queryByTestId("period-bar")).toBeNull();
  });

  it("passes a well-formed from and to through, and drops one that is not a month", async () => {
    await mount({ unit: "dept-1", view: "months", from: "2026-01", to: "2026-10" });
    expect(vi.mocked(getDeptKpiMonths).mock.calls[0][3]).toEqual({ from: "2026-01", to: "2026-10" });
    await mount({ unit: "dept-1", view: "months", from: "last year", to: "2026-10" });
    expect(vi.mocked(getDeptKpiMonths).mock.calls[1][3]).toEqual({ to: "2026-10" });
  });

  it("says Unavailable in place of the table when the series read fails, never an empty table", async () => {
    vi.mocked(getDeptKpiMonths).mockResolvedValue({ kind: "unavailable", reason: "boom" });
    await mount();
    expect(screen.getByText(/The monthly KPIs unavailable/)).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    // the switch is still there to go back
    expect(screen.getByRole("link", { name: "This period" })).toHaveAttribute("href", "/appraisals/department?unit=dept-1");
  });

  it("says a refusal as a refusal, and a missing department as that", async () => {
    vi.mocked(getDeptKpiMonths).mockResolvedValue({ kind: "forbidden" });
    const { unmount } = await mount();
    expect(screen.getByText(/limited to the people in it, its heads/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    unmount();
    vi.mocked(getDeptKpiMonths).mockResolvedValue({ kind: "unavailable", reason: "unit_not_found" });
    await mount();
    expect(screen.getByText("This department does not exist.")).toBeInTheDocument();
  });

  it("is not the default: without view=months the page is the period view, and the switch says so", async () => {
    vi.mocked(getDeptKpis).mockResolvedValue({
      kind: "ok",
      data: { unit: { id: "dept-1", name: "Web Dev" }, workspace: "web-dev", period: { periodKind: "month", start: "2026-10-01", end: "2026-10-31" }, condition: "on_track", kpis: [] },
    });
    await mount({ unit: "dept-1" });
    expect(vi.mocked(getDeptKpiMonths)).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "This period" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "By month" })).toHaveAttribute("href", "/appraisals/department?unit=dept-1&view=months");
  });
});

describe("?view=months: the switch", () => {
  it("keeps the unit on both links and marks By month as the current view", async () => {
    await mount({ unit: "dept-7", view: "months" });
    expect(screen.getByRole("link", { name: "By month" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "By month" })).toHaveAttribute("href", "/appraisals/department?unit=dept-7&view=months");
    expect(screen.getByRole("link", { name: "This period" })).toHaveAttribute("href", "/appraisals/department?unit=dept-7");
  });

  it("carries the period the page was opened with, so the way back lands on it", async () => {
    await mount({ unit: "dept-1", view: "months", periodKind: "week", start: "2026-10-05" });
    expect(screen.getByRole("link", { name: "This period" })).toHaveAttribute("href", "/appraisals/department?unit=dept-1&periodKind=week&start=2026-10-05");
  });
});

describe("?view=months: who is offered what", () => {
  it("a plain member sees the table and no plan form, and no targets read happens", async () => {
    await mount();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.queryByText("Plan the coming months")).toBeNull();
    expect(screen.queryByRole("form", { name: /Plan targets/ })).toBeNull();
    expect(screen.queryByText("Targets")).toBeNull();
    expect(vi.mocked(getDeptKpiTargets)).not.toHaveBeenCalled();
  });

  it("a head (may propose for the unit) gets the plan form, pre-filled, above the Targets card", async () => {
    asHead();
    await mount();
    expect(vi.mocked(getDeptKpiTargets)).toHaveBeenCalledWith("u-1", "co-1", "dept-1");
    expect(vi.mocked(canInUnit)).toHaveBeenCalledWith(expect.anything(), "reports.dept_kpi_target.propose", "co-1", []);
    const plan = screen.getByRole("heading", { name: /Plan the coming months/ });
    const targets = screen.getByRole("heading", { name: /^Targets/ });
    expect(plan.compareDocumentPosition(targets) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText("Target for Projects on time, November 2026")).toHaveValue("85");
    expect(screen.getByRole("button", { name: "Send 3 proposals" })).toBeInTheDocument();
  });

  it("lists what a head proposed as proposals in the Targets card, read only, with no checkboxes", async () => {
    asHead();
    vi.mocked(getDeptKpiTargets).mockResolvedValue(targetsOk([proposal("p1", "u-1"), proposal("p2", "u-other")]) as never);
    await mount();
    expect(screen.getAllByText(/^Proposed: 90%, tolerance 5 pts, from November 2026/)).toHaveLength(2);
    expect(screen.getByText(/You proposed this/)).toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("a head's plan form is not shown when the targets read fails, which is said instead", async () => {
    asHead();
    vi.mocked(getDeptKpiTargets).mockResolvedValue({ kind: "error", reason: "down" } as never);
    await mount();
    expect(screen.queryByText("Plan the coming months")).toBeNull();
    expect(screen.getByText(/This department's targets unavailable/)).toBeInTheDocument();
  });

  it("an approver gets the open proposals grouped by KPI with a checkbox per proposal, and none on their own", async () => {
    asApprover();
    vi.mocked(getDeptKpiTargets).mockResolvedValue(targetsOk([proposal("p1", "u-head"), proposal("p2", "u-1")]) as never);
    await mount();
    const group = screen.getByRole("region", { name: "Open proposals: Projects on time" });
    expect(within(group).getAllByRole("checkbox")).toHaveLength(1);
    expect(within(group).getByRole("checkbox", { name: "Select the proposal for Projects on time, November 2026" })).toBeInTheDocument();
    expect(within(group).getByText(/You proposed this/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve selected" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject selected" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Approve the proposed target for Projects on time" })).toHaveLength(1); // the single buttons stay
    // an approver who may not propose gets no plan form
    expect(screen.queryByText("Plan the coming months")).toBeNull();
  });
});
