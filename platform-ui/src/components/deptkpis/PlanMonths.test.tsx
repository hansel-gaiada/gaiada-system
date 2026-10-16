import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/deptKpiActions", () => ({ proposeTargetsBatchAction: vi.fn(), proposeDeptKpiTarget: vi.fn(), approveDeptKpiTarget: vi.fn(), rejectDeptKpiTarget: vi.fn() }));

import { proposeTargetsBatchAction } from "@/lib/deptKpiActions";
import { PlanMonths } from "./PlanMonths";
import type { DeptKpiTargetRow, DeptKpiTargetsKpi } from "@/lib/deptKpiFormat";

// DW-10b-2 (BFF section 58.2 and 58.4): "Plan the coming months". The form pre-fills each month with the target in force THAT month, shows a percent as a
// whole percent, sends ONE batch, and puts the server's refusal under the month it names.

const approved = (effectiveFrom: string, target: number, tolerance: number): DeptKpiTargetRow => ({
  id: `a-${effectiveFrom}`, unitNodeId: "dept-1", kpiKey: "projects-on-time", effectiveFrom, target, tolerance, status: "approved",
  note: null, proposedBy: "p", proposedAt: "2026-06-01T00:00:00Z", decidedBy: "d", decidedAt: "2026-06-02T00:00:00Z",
});
const onTime: DeptKpiTargetsKpi = {
  key: "projects-on-time", label: "Projects on time", unit: "percent", direction: "up_good", suggestedTarget: 0.9, suggestedTolerance: 0.1,
  inForce: approved("2026-09-01", 0.85, 0.05), proposals: [], history: [approved("2026-07-01", 0.82, 0.05)],
};
const turnaround: DeptKpiTargetsKpi = {
  key: "turnaround", label: "Client approval turnaround", unit: "minutes", direction: "down_good", suggestedTarget: 2880, suggestedTolerance: 1440,
  inForce: null, proposals: [], history: [],
};
const empty: DeptKpiTargetsKpi = { key: "assets", label: "Assets delivered", unit: "count", direction: "up_good", suggestedTarget: null, suggestedTolerance: null, inForce: null, proposals: [], history: [] };

const mount = (kpis = [onTime, turnaround, empty]) => render(<PlanMonths unitId="dept-1" kpis={kpis} asOf="2026-10-01" />);
const target = (month: string, kpi = "Projects on time") => screen.getByLabelText(`Target for ${kpi}, ${month}`) as HTMLInputElement;
const tolerance = (month: string, kpi = "Projects on time") => screen.getByLabelText(`Tolerance for ${kpi}, ${month}`) as HTMLInputElement;

beforeEach(() => {
  refresh.mockReset();
  vi.mocked(proposeTargetsBatchAction).mockReset();
});

describe("Plan the coming months", () => {
  it("starts with the first KPI and the next three months, each pre-filled with the target in force, a percent as a whole percent", () => {
    mount();
    expect(screen.getByLabelText("KPI")).toHaveValue("projects-on-time");
    expect(screen.getByLabelText("How many coming months")).toHaveValue("3");
    for (const m of ["November 2026", "December 2026", "January 2027"]) {
      expect(target(m)).toHaveValue("85");
      expect(tolerance(m)).toHaveValue("5");
    }
    expect(screen.queryByLabelText("Target for Projects on time, February 2027")).toBeNull();
    expect(screen.getByRole("button", { name: "Send 3 proposals" })).toBeInTheDocument();
  });

  it("offers 1 to 12 coming months and adds a row per month", () => {
    mount();
    const select = screen.getByLabelText("How many coming months") as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(["1 month", ...Array.from({ length: 11 }, (_, i) => `${i + 2} months`)]);
    fireEvent.change(select, { target: { value: "12" } });
    expect(screen.getAllByLabelText(/^Target for Projects on time, /)).toHaveLength(12);
    expect(target("October 2027")).toHaveValue("85");
    fireEvent.change(select, { target: { value: "1" } });
    expect(screen.getAllByLabelText(/^Target for /)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Send 1 proposal" })).toBeInTheDocument();
  });

  it("falls back to the catalogue's suggestion when no target is in force, in the KPI's own unit, and to empty when there is none", () => {
    mount();
    fireEvent.change(screen.getByLabelText("KPI"), { target: { value: "turnaround" } });
    expect(target("November 2026", "Client approval turnaround")).toHaveValue("2880");
    expect(tolerance("November 2026", "Client approval turnaround")).toHaveValue("1440");
    fireEvent.change(screen.getByLabelText("KPI"), { target: { value: "assets" } });
    expect(target("November 2026", "Assets delivered")).toHaveValue("");
  });

  it("pre-fills a month with the approved target of THAT month when one is already planned ahead", () => {
    const planned: DeptKpiTargetsKpi = { ...onTime, history: [...onTime.history, approved("2026-12-01", 0.9, 0.04)] };
    mount([planned]);
    expect(target("November 2026")).toHaveValue("85");
    expect(target("December 2026")).toHaveValue("90");
    expect(tolerance("December 2026")).toHaveValue("4");
    expect(target("January 2027")).toHaveValue("90");
  });

  it("sends ONE batch for the KPI and every month as the viewer left them, and says what was sent", async () => {
    vi.mocked(proposeTargetsBatchAction).mockResolvedValue({ ok: true, ids: ["x", "y", "z"] });
    mount();
    fireEvent.change(target("December 2026"), { target: { value: "88" } });
    fireEvent.change(tolerance("January 2027"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Note for every month (optional)"), { target: { value: "Peak" } });
    fireEvent.click(screen.getByRole("button", { name: "Send 3 proposals" }));
    await waitFor(() => expect(proposeTargetsBatchAction).toHaveBeenCalledTimes(1));
    expect(vi.mocked(proposeTargetsBatchAction).mock.calls[0][0]).toEqual({
      unitNodeId: "dept-1",
      items: [
        { kpiKey: "projects-on-time", unit: "percent", effectiveFrom: "2026-11-01", target: "85", tolerance: "5", note: "Peak" },
        { kpiKey: "projects-on-time", unit: "percent", effectiveFrom: "2026-12-01", target: "88", tolerance: "5", note: "Peak" },
        { kpiKey: "projects-on-time", unit: "percent", effectiveFrom: "2027-01-01", target: "85", tolerance: "3", note: "Peak" },
      ],
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Sent 3 proposals. They are listed under Targets until the approver decides them.");
    expect(refresh).toHaveBeenCalled();
  });

  it("puts the server's refusal of one month under that month's row (items[1].target), and nothing under the others", async () => {
    vi.mocked(proposeTargetsBatchAction).mockResolvedValue({ ok: false, error: "a percent target is a fraction between 0 and 1", field: "items[1].target", index: 1, itemField: "target" });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Send 3 proposals" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("December 2026: a percent target is a fraction between 0 and 1");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("row", { name: /December 2026/ })).toContainElement(alert);
    expect(target("December 2026")).toHaveAttribute("aria-invalid", "true");
    expect(target("November 2026")).not.toHaveAttribute("aria-invalid");
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows a refusal that names no month (403, 404, 409) as a message under the form", async () => {
    vi.mocked(proposeTargetsBatchAction).mockResolvedValue({ ok: false, error: "not authorized" });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Send 3 proposals" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("not authorized");
    expect(within(screen.getByRole("table")).queryByRole("alert")).toBeNull();
  });

  it("starts over when the KPI or the number of months changes", () => {
    mount();
    fireEvent.change(target("November 2026"), { target: { value: "70" } });
    fireEvent.change(screen.getByLabelText("How many coming months"), { target: { value: "4" } });
    expect(target("November 2026")).toHaveValue("85");
  });

  it("says there is nothing to plan for a department with no KPIs", () => {
    mount([]);
    expect(screen.getByText(/no KPIs to plan targets for/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Send/ })).toBeNull();
  });
});
