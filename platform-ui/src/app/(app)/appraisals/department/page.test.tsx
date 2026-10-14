import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// DW-4j-3 — the department KPI page: (1) "Behind the miss" is requested only for the KPIs that are at risk or off track, only for a viewer who
// may see it (a head of the unit or the company-wide tier), for the period the page shows, and in parallel with the targets read; a unit's staff
// never trigger the read. (2) The weekly digest's link (`?unit=&periodKind=week&start=<Monday>`) opens the page on that week.

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-1", companies: [], roles: [] })) }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("@/lib/rbac", () => ({ can: vi.fn(() => false), canInUnit: vi.fn(() => false), unitPathOf: vi.fn(() => []) }));
vi.mock("@/lib/campaigns-data", () => ({ readOrgRoot: vi.fn(async () => null) }));
vi.mock("@/lib/deptKpis", async (orig) => ({
  ...(await orig<typeof import("@/lib/deptKpis")>()),
  getDeptKpis: vi.fn(),
  getDeptKpiTargets: vi.fn(),
}));
vi.mock("@/lib/deptKpiAlerts", () => ({ getUnitKpiAlerts: vi.fn(async () => ({ kind: "ok", data: [] })) }));
vi.mock("@/lib/deptKpiDrivers", async (orig) => ({
  ...(await orig<typeof import("@/lib/deptKpiDrivers")>()),
  getKpiDrivers: vi.fn(),
}));
vi.mock("@/lib/deptAppraisals", () => ({ getCyclePicks: vi.fn(async () => ({ kind: "ok", data: [] })), getDeptAppraisal: vi.fn() }));
vi.mock("@/components/PageHeader", () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock("@/components/reports/ReportPeriodBar", () => ({
  ReportPeriodBar: ({ value }: { value: { kind: string; start: string; end: string } }) => <div data-testid="period">{`${value.kind}|${value.start}|${value.end}`}</div>,
}));
vi.mock("@/components/deptkpis/TargetControls", () => ({ ProposeTargetForm: () => null, DecideButtons: () => null }));
vi.mock("@/components/deptkpis/AppraisalView", () => ({ AppraisalView: () => null, CyclePicker: () => null }));
vi.mock("@/components/deptkpis/KpiAlerts", () => ({ AlertsSection: () => null, TileAlertLine: () => null }));

import { can, canInUnit } from "@/lib/rbac";
import { getDeptKpis, getDeptKpiTargets, type DeptKpi, type DeptKpisView } from "@/lib/deptKpis";
import { getKpiDrivers } from "@/lib/deptKpiDrivers";
import DepartmentKpiPage from "./page";

const kpi = (key: string, label: string, condition: DeptKpi["condition"], over: Partial<DeptKpi> = {}): DeptKpi => ({
  key, label, unit: "percent", direction: "up_good", value: 0.8, target: 0.85, tolerance: 0.05, targetSource: "approved", condition, ...over,
});
const KPIS: DeptKpi[] = [
  kpi("projects-on-time", "Projects on time", "at_risk"),
  kpi("requests-within-sla", "Requests answered within the SLA", "on_track"),
  kpi("client-site-uptime", "Client site uptime", "unavailable", { value: null, reason: "no_reader" }),
  kpi("reopened-work-rate", "Reopened work rate", "off_track", { direction: "down_good", value: 0.2, target: 0.05 }),
];
const WEEK = { periodKind: "week", start: "2026-10-05", end: "2026-10-11" };
const view = (period = WEEK, kpis = KPIS): DeptKpisView => ({ unit: { id: "dept-1", name: "Web Dev" }, workspace: "web-dev", period, condition: "off_track", kpis });
const targetsOk = { kind: "ok", data: { unit: { id: "dept-1", name: "Web Dev" }, workspace: "web-dev", asOf: "2026-10-01", kpis: [] } };
const driversOk = (key: string, rows: unknown[] | null = [], reason?: string) => ({
  kind: "ok",
  data: { kpi: { key, label: key, unit: "percent", direction: "up_good" }, period: WEEK, drivers: rows, ...(reason ? { reason } : {}) },
});

const mount = async (search: Record<string, string> = { unit: "dept-1" }) => render(await DepartmentKpiPage({ searchParams: Promise.resolve(search) }));
const asHead = () => vi.mocked(canInUnit).mockImplementation((_me, perm) => perm === "reports.dept_kpi_target.propose");
const asApprover = () => vi.mocked(can).mockImplementation((_me, perm) => perm === "reports.dept_kpi_target.approve");

beforeEach(() => {
  vi.mocked(can).mockReset().mockReturnValue(false);
  vi.mocked(canInUnit).mockReset().mockReturnValue(false);
  vi.mocked(getDeptKpis).mockReset().mockResolvedValue({ kind: "ok", data: view() });
  vi.mocked(getDeptKpiTargets).mockReset().mockResolvedValue(targetsOk as never);
  vi.mocked(getKpiDrivers).mockReset().mockImplementation(async (_u, _t, q) => driversOk(q.kpiKey) as never);
});

describe("Behind the miss: who asks, for which KPIs, for which period", () => {
  it("a head's page asks for the drivers of the at-risk and off-track KPIs only, for the period the page shows", async () => {
    asHead();
    await mount({ unit: "dept-1", periodKind: "week", start: "2026-10-05" });
    const calls = vi.mocked(getKpiDrivers).mock.calls.map(([u, t, q]) => [u, t, q]);
    expect(calls).toEqual([
      ["u-1", "co-1", { unitNodeId: "dept-1", kpiKey: "projects-on-time", ...WEEK }],
      ["u-1", "co-1", { unitNodeId: "dept-1", kpiKey: "reopened-work-rate", ...WEEK }],
    ]);
  });

  it("renders a block with one list per KPI that missed, and none for the KPIs that did not", async () => {
    asHead();
    vi.mocked(getKpiDrivers).mockImplementation(async (_u, _t, q) =>
      (q.kpiKey === "projects-on-time"
        ? driversOk(q.kpiKey, [{ kind: "project", id: "p-web-1", name: "Client site redesign", value: 0.6, numerator: 3, denominator: 5 }])
        : driversOk(q.kpiKey, [])) as never,
    );
    await mount();
    expect(screen.getByRole("list", { name: "Behind the miss: Projects on time" })).toBeInTheDocument();
    expect(screen.getByText("Client site redesign")).toBeInTheDocument();
    expect(screen.getByText("No one stands out")).toBeInTheDocument(); // Reopened work rate: a true empty answer
    expect(screen.queryByText("Behind the miss: Client site uptime")).toBeNull();
  });

  it("the company-wide approver asks too", async () => {
    asApprover();
    await mount();
    expect(vi.mocked(getKpiDrivers)).toHaveBeenCalledTimes(2);
  });

  it("a unit's staff never trigger the read and never see the block, while their tiles still render", async () => {
    await mount(); // can() and canInUnit() are false: staff of the unit
    expect(vi.mocked(getKpiDrivers)).not.toHaveBeenCalled();
    expect(vi.mocked(getDeptKpiTargets)).not.toHaveBeenCalled();
    expect(screen.queryByText(/Behind the miss/)).toBeNull();
    expect(screen.getByText("Projects on time")).toBeInTheDocument();
  });

  it("asks for nothing when no KPI is at risk or off track", async () => {
    asHead();
    vi.mocked(getDeptKpis).mockResolvedValue({ kind: "ok", data: view(WEEK, [kpi("a", "A", "on_track"), kpi("b", "B", "unavailable", { value: null, reason: "no_target" })]) });
    await mount();
    expect(vi.mocked(getKpiDrivers)).not.toHaveBeenCalled();
    expect(screen.queryByText(/Behind the miss/)).toBeNull();
  });

  it("reads the drivers in parallel with the targets, not after them", async () => {
    asHead();
    let release!: (v: unknown) => void;
    vi.mocked(getDeptKpiTargets).mockImplementation(() => new Promise((res) => { release = res; }) as never);
    vi.mocked(getKpiDrivers).mockImplementation(async (_u, _t, q) => {
      release(targetsOk); // the targets read only finishes once a drivers read has started: a sequential page would never get here
      return driversOk(q.kpiKey) as never;
    });
    await mount();
    expect(vi.mocked(getKpiDrivers)).toHaveBeenCalledTimes(2);
  });

  it("a refused drivers read renders nothing; a failed one says so and does not claim an empty list", async () => {
    asHead();
    vi.mocked(getKpiDrivers).mockImplementation(async (_u, _t, q) => (q.kpiKey === "projects-on-time" ? { kind: "forbidden" } : { kind: "error", reason: "boom" }) as never);
    await mount();
    expect(screen.getByText("Couldn't load what is behind this")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Behind the miss: Projects on time" })).toBeNull();
    expect(screen.queryByText("No one stands out")).toBeNull();
  });

  it("a head refused for every KPI sees no block at all", async () => {
    asHead();
    vi.mocked(getKpiDrivers).mockResolvedValue({ kind: "forbidden" } as never);
    await mount();
    expect(screen.queryByText(/Behind the miss/)).toBeNull();
  });
});

describe("the weekly digest's link opens the page on its week", () => {
  const digestHref = "/appraisals/department?unit=dept-1&periodKind=week&start=2026-10-05";
  const params = Object.fromEntries(new URL(digestHref, "http://x").searchParams);

  it("passes the digest's periodKind and start to the KPI read, with no end, and shows that week in the period bar", async () => {
    await mount(params);
    expect(vi.mocked(getDeptKpis)).toHaveBeenCalledWith("u-1", "co-1", { unit: "dept-1", periodKind: "week", start: "2026-10-05" });
    expect(screen.getByTestId("period").textContent).toBe("week|2026-10-05|2026-10-11");
  });

  it("without those params the page shows the current month, as before", async () => {
    await mount({ unit: "dept-1" });
    const q = vi.mocked(getDeptKpis).mock.calls[0][2];
    expect(q.periodKind).toBe("month");
    expect(q.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(q.end).toBeUndefined();
  });
});
