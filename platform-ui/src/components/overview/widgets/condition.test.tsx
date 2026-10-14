import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OVERVIEW_WIDGETS, type OverviewWidgetProps } from "./index";
import { Condition } from "./Condition";
import { lead, me, member } from "@/lib/workspaceFixtures";
import * as deptKpis from "@/lib/deptKpis";
import type { DeptKpi, DeptKpisView } from "@/lib/deptKpiFormat";

vi.mock("@/lib/deptKpis", async (orig) => ({ ...(await orig<typeof import("@/lib/deptKpis")>()), getDeptKpis: vi.fn() }));

const getKpis = vi.mocked(deptKpis.getDeptKpis);
const T = "co-a";
const head = me([member(), lead("d-web")]);
const staff = me([member()]);

const props = (who = staff, extra: Partial<OverviewWidgetProps> = {}): OverviewWidgetProps => ({
  me: who, tenantId: T, period: "month", deptId: "d-web", unitPath: ["d-web", "root"], tools: [],
  widget: { key: "condition", band: "department", label: "Department condition" }, subjectLabel: "Web Dev", ...extra,
});

const kpi = (over: Partial<DeptKpi> = {}): DeptKpi => ({
  key: "projects-on-time", label: "Projects on time", unit: "percent", direction: "up_good", value: 0.79, numerator: 17, denominator: 21,
  target: 0.85, tolerance: 0.05, targetSource: "approved", condition: "at_risk", ...over,
});
const view = (condition: DeptKpisView["condition"], kpis: DeptKpi[]): DeptKpisView => ({
  unit: { id: "d-web", name: "Web Dev" }, workspace: "web-dev", period: { periodKind: "month", start: "2026-10-01", end: "2026-10-31" }, condition, kpis,
});
const atRisk = view("at_risk", [
  kpi(),
  kpi({ key: "uptime", label: "Client site uptime", value: 0.999, target: 0.995, tolerance: 0.005, condition: "on_track", numerator: undefined, denominator: undefined }),
]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T10:00:00Z"));
  getKpis.mockReset();
});

describe("Condition (widget, DW-3k)", () => {
  it("is registered in the host", () => {
    expect(OVERVIEW_WIDGETS.condition).toBe(Condition);
  });

  it("reads the department's own unit for the Overview's period, as the signed-in person", async () => {
    getKpis.mockResolvedValue({ kind: "ok", data: atRisk });
    await Condition(props(head, { period: "week" }));
    expect(getKpis).toHaveBeenCalledWith(head.userId, T, { unit: "d-web", periodKind: "week", start: "2026-10-14" });
    expect(getKpis).toHaveBeenCalledTimes(1);
  });

  it("a head sees the banner and a tile per KPI, each with its own condition, linked to the department KPI page", async () => {
    getKpis.mockResolvedValue({ kind: "ok", data: atRisk });
    render(await Condition(props(head)));
    const block = screen.getByRole("region", { name: "Department condition" });
    expect(block).toHaveAttribute("data-state", "banner");
    expect(block).toHaveAttribute("data-condition", "at_risk");
    expect(within(block).getByText("Web Dev: at risk · Projects on time 79% against 85%")).toBeInTheDocument();
    expect(within(block).getByRole("link", { name: "Open the department KPIs" })).toHaveAttribute("href", "/appraisals/department?unit=d-web&periodKind=month&start=2026-10-14");
    const tiles = [...block.querySelectorAll("[data-kpi]")] as HTMLElement[];
    expect(tiles.map((n) => [n.getAttribute("data-kpi"), n.getAttribute("data-condition")])).toEqual([["projects-on-time", "at_risk"], ["uptime", "on_track"]]);
    expect(within(tiles[0]).getByText("79%")).toBeInTheDocument();
    expect(within(tiles[0]).getByText("17 of 21")).toBeInTheDocument();
    expect(within(tiles[0]).getByText("Target 85% (tolerance 5 pts)")).toBeInTheDocument();
  });

  it("staff see a quiet strip: one line, no tiles and no link", async () => {
    getKpis.mockResolvedValue({ kind: "ok", data: atRisk });
    render(await Condition(props(staff)));
    const block = screen.getByRole("region", { name: "Department condition" });
    expect(block).toHaveAttribute("data-state", "strip");
    expect(within(block).getByText("Web Dev: at risk · Projects on time 79% against 85%")).toBeInTheDocument();
    expect(block.querySelectorAll("[data-kpi]")).toHaveLength(0);
    expect(within(block).queryByRole("list")).toBeNull();
    expect(within(block).queryByRole("link")).toBeNull();
  });

  it("a refused read (a visitor from another department) draws nothing at all", async () => {
    getKpis.mockResolvedValue({ kind: "forbidden" });
    for (const who of [head, staff]) expect(await Condition(props(who))).toBeNull();
    getKpis.mockResolvedValue({ kind: "not_found" });
    expect(await Condition(props(staff))).toBeNull();
  });

  it("a failed read says Unavailable, never on track, for a head and for staff", async () => {
    getKpis.mockResolvedValue({ kind: "error", reason: "boom" });
    const first = render(await Condition(props(head)));
    expect(screen.getByRole("region", { name: "Department condition" })).toHaveAttribute("data-state", "unavailable");
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/on track/i)).toBeNull();
    first.unmount();
    render(await Condition(props(staff)));
    expect(screen.getByText("Web Dev: Unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/on track/i)).toBeNull();
  });

  it("with no approved target (the live state), the head and staff both read it plainly and neither reads on track", async () => {
    const noTarget = view("unavailable", [
      kpi({ value: null, numerator: undefined, denominator: undefined, target: null, tolerance: null, targetSource: "none", condition: "unavailable", reason: "no_target" }),
    ]);
    getKpis.mockResolvedValue({ kind: "ok", data: noTarget });
    const first = render(await Condition(props(head)));
    const block = screen.getByRole("region", { name: "Department condition" });
    expect(within(block).getByText("Web Dev: condition unavailable · No KPI has an approved target yet")).toBeInTheDocument();
    expect(within(block).getByText("No target yet")).toBeInTheDocument();
    expect(within(block).queryByText(/on track/i)).toBeNull();
    first.unmount();
    render(await Condition(props(staff)));
    expect(screen.getByText("Web Dev: condition unavailable · No KPI has an approved target yet")).toBeInTheDocument();
    expect(screen.queryByText(/on track/i)).toBeNull();
  });

  it("is the same banner in Team mode as in Me mode for a head (always on top for the HOD, plan section 3.4)", async () => {
    getKpis.mockResolvedValue({ kind: "ok", data: atRisk });
    render(await Condition(props(head, { view: "team" })));
    expect(screen.getByRole("region", { name: "Department condition" })).toHaveAttribute("data-state", "banner");
  });

  it("draws nothing and reads nothing for a workspace with no department unit", async () => {
    expect(await Condition(props(head, { deptId: null, unitPath: [] }))).toBeNull();
    expect(getKpis).not.toHaveBeenCalled();
  });
});
