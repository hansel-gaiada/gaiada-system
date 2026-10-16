import { describe, it, expect, vi, beforeEach } from "vitest";
import { platformFetch, PlatformError } from "./platform";
import { getDeptKpiMonths } from "./deptKpis";
import {
  cellConditionText, cellTargetText, cellsInMonthOrder, explainBatchDecisionError, isMonthKey, monthColumnLabel, monthsWithValue, splitItemField,
  targetInForceFor, trendSeriesOf, type DeptKpiMonthCell, type DeptKpiMonthsKpi, type DeptKpiMonthsView, type DeptKpiTargetRow, type DeptKpiTargetsKpi,
} from "./deptKpiFormat";

vi.mock("./platform", async (importOriginal) => ({ ...(await importOriginal<typeof import("./platform")>()), platformFetch: vi.fn() }));

// DW-10b-2 (BFF section 58.1): the honest reader of the monthly series, and the pure helpers its table, trend and plan form are built from.

const cell = (month: string, over: Partial<DeptKpiMonthCell> = {}): DeptKpiMonthCell => ({
  month, value: 0.8, target: 0.85, tolerance: 0.05, targetSource: "approved", condition: "at_risk", ...over,
});
const kpi: DeptKpiMonthsKpi = {
  key: "projects-on-time", label: "Projects on time", unit: "percent", direction: "up_good",
  cells: [cell("2026-08"), cell("2026-09", { value: null, condition: "unavailable", reason: "no_data" }), cell("2026-10", { value: 0.9, condition: "on_track" })],
};
const view: DeptKpiMonthsView = {
  unit: { id: "dept-1", name: "Web Dev" }, workspace: "web-dev",
  months: [
    { month: "2026-08", start: "2026-08-01", end: "2026-08-31", partial: false, condition: "at_risk" },
    { month: "2026-09", start: "2026-09-01", end: "2026-09-30", partial: false, condition: "unavailable" },
    { month: "2026-10", start: "2026-10-01", end: "2026-10-31", partial: true, condition: "on_track" },
  ],
  kpis: [kpi],
};

beforeEach(() => vi.mocked(platformFetch).mockReset());

describe("getDeptKpiMonths", () => {
  it("asks for the unit and only the bounds it was given, and returns the series as ok", async () => {
    vi.mocked(platformFetch).mockResolvedValue(view);
    expect(await getDeptKpiMonths("u-1", "co-1", "dept-1")).toEqual({ kind: "ok", data: view });
    expect(vi.mocked(platformFetch).mock.calls[0][0]).toBe("/api/co-1/dept-kpis/months?unitNodeId=dept-1");
    await getDeptKpiMonths("u-1", "co-1", "dept 1", { from: "2026-01", to: "2026-10" });
    expect(vi.mocked(platformFetch).mock.calls[1][0]).toBe("/api/co-1/dept-kpis/months?unitNodeId=dept+1&from=2026-01&to=2026-10");
    expect(vi.mocked(platformFetch).mock.calls[1][1]).toBe("u-1");
  });

  it("says forbidden for a 403, never an empty series", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "outside your reporting line"));
    expect(await getDeptKpiMonths("u-1", "co-1", "dept-1")).toEqual({ kind: "forbidden" });
  });

  it("says unavailable, with the backend's words, for a 404, a 400 and a network failure", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "unit_not_found", "unitNodeId"));
    expect(await getDeptKpiMonths("u-1", "co-1", "dept-9")).toEqual({ kind: "unavailable", reason: "unit_not_found" });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "a window is at most 12 months", "from"));
    expect(await getDeptKpiMonths("u-1", "co-1", "dept-1", { from: "2024-01", to: "2026-10" })).toEqual({ kind: "unavailable", reason: "a window is at most 12 months" });
    vi.mocked(platformFetch).mockRejectedValueOnce(new Error("socket hang up"));
    expect(await getDeptKpiMonths("u-1", "co-1", "dept-1")).toEqual({ kind: "unavailable", reason: "socket hang up" });
  });

  it("treats an answer of the wrong shape as unavailable instead of an empty table", async () => {
    for (const bad of [null, {}, { unit: { name: "x" }, months: [], kpis: "no" }, { unit: { name: "x" }, months: [], kpis: [{ key: "a" }] }, { months: [], kpis: [] }]) {
      vi.mocked(platformFetch).mockResolvedValueOnce(bad);
      expect(await getDeptKpiMonths("u-1", "co-1", "dept-1")).toMatchObject({ kind: "unavailable" });
    }
  });
});

describe("the month cell, in words", () => {
  it("words the target in the KPI's unit, or says there is none", () => {
    expect(cellTargetText(cell("2026-10"), "percent")).toBe("target 85%");
    expect(cellTargetText(cell("2026-10", { target: 12 }), "count")).toBe("target 12");
    expect(cellTargetText(cell("2026-10", { target: 90 }), "minutes")).toBe("target 1h 30m");
    expect(cellTargetText(cell("2026-10", { target: null }), "percent")).toBe("no target");
  });

  it("words the condition, and says why an unavailable cell is", () => {
    expect(cellConditionText(cell("2026-10", { condition: "on_track" }))).toBe("On track");
    expect(cellConditionText(cell("2026-10", { condition: "off_track" }))).toBe("Off track");
    expect(cellConditionText(cell("2026-10", { condition: "unavailable", reason: "no_data" }))).toBe("Unavailable · No data this period");
    expect(cellConditionText(cell("2026-10", { condition: "unavailable", reason: "no_reader" }))).toBe("Unavailable · Not measured yet");
    expect(cellConditionText(cell("2026-10", { condition: "unavailable", reason: "no_target" }))).toBe("Unavailable · No target yet");
    expect(cellConditionText(cell("2026-10", { condition: "unavailable", reason: "read_failed" }))).toBe("Unavailable · Couldn't be read right now");
    expect(cellConditionText(cell("2026-10", { condition: "unavailable" }))).toBe("Unavailable");
  });

  it("labels a month column and recognises a month key", () => {
    expect(monthColumnLabel("2026-10")).toBe("Oct 2026");
    expect(monthColumnLabel("2025-01")).toBe("Jan 2025");
    expect(isMonthKey("2026-10")).toBe(true);
    for (const bad of ["2026-13", "2026-00", "2026-1", "2026-10-01", "", "october"]) expect(isMonthKey(bad)).toBe(false);
  });
});

describe("the trend's data", () => {
  it("puts a cell per month in the month order, and a missing month is null, never a zero", () => {
    const sparse: DeptKpiMonthsKpi = { ...kpi, cells: [kpi.cells[0], kpi.cells[2]] };
    expect(cellsInMonthOrder(sparse, view.months).map((c) => c && c.month)).toEqual(["2026-08", null, "2026-10"]);
    const { values, target } = trendSeriesOf(sparse, view.months);
    expect(values.points).toEqual([{ t: "2026-08-01", v: 0.8 }, { t: "2026-09-01", v: null }, { t: "2026-10-01", v: 0.9 }]);
    expect(target.points.map((p) => p.v)).toEqual([0.85, null, 0.85]);
  });

  it("counts the months that carry a value", () => {
    expect(monthsWithValue(kpi)).toBe(2);
    expect(monthsWithValue({ ...kpi, cells: [kpi.cells[1]] })).toBe(0);
  });
});

describe("a batch refusal's field", () => {
  it("splits items[i].field into the item and its own field", () => {
    expect(splitItemField("items[3].target")).toEqual({ index: 3, field: "target" });
    expect(splitItemField("items[12].effectiveFrom")).toEqual({ index: 12, field: "effectiveFrom" });
    expect(splitItemField("items[0]")).toEqual({ index: 0, field: "" });
    for (const other of ["items", "unitNodeId", "ids", "items[x].target", undefined]) expect(splitItemField(other)).toBeNull();
  });

  it("words a refused batch decision with the proposal that caused it and says nothing was decided", () => {
    expect(explainBatchDecisionError("cannot_approve_own_proposal", "Projects on time, November 2026")).toBe(
      "Projects on time, November 2026: You proposed this target, so someone else has to decide it. Nothing was decided.",
    );
    expect(explainBatchDecisionError("not_proposed", null)).toMatch(/already decided\. Refresh to see where it stands\. Nothing was decided\.$/);
    expect(explainBatchDecisionError("not authorized", "X, May 2027")).toBe("X, May 2027: not authorized Nothing was decided.");
  });
});

describe("the target in force for a month (the plan form's pre-fill)", () => {
  const row = (id: string, effectiveFrom: string, target: number, status: DeptKpiTargetRow["status"]): DeptKpiTargetRow => ({
    id, unitNodeId: "dept-1", kpiKey: "k", effectiveFrom, target, tolerance: 0.05, status, note: null, proposedBy: "p", proposedAt: "2026-01-01T00:00:00Z", decidedBy: null, decidedAt: null,
  });
  const targets: DeptKpiTargetsKpi = {
    key: "k", label: "K", unit: "percent", direction: "up_good", suggestedTarget: 0.5, suggestedTolerance: 0.1,
    inForce: row("a", "2026-09-01", 0.85, "approved"),
    proposals: [row("p", "2026-11-01", 0.99, "proposed")],
    history: [row("h1", "2026-07-01", 0.8, "approved"), row("h2", "2026-08-01", 0.7, "superseded"), row("h3", "2026-12-01", 0.9, "approved"), row("h4", "2026-10-01", 0.6, "rejected")],
  };

  it("is the latest APPROVED row from that month or earlier, counting an approved row in the future, and never a proposal, a rejected or a superseded one", () => {
    expect(targetInForceFor(targets, "2026-06-01")).toBeNull();
    expect(targetInForceFor(targets, "2026-07-01")).toEqual({ target: 0.8, tolerance: 0.05 });
    expect(targetInForceFor(targets, "2026-10-01")).toEqual({ target: 0.85, tolerance: 0.05 });
    expect(targetInForceFor(targets, "2026-11-01")).toEqual({ target: 0.85, tolerance: 0.05 });
    expect(targetInForceFor(targets, "2027-01-01")).toEqual({ target: 0.9, tolerance: 0.05 });
    expect(targetInForceFor({ ...targets, inForce: null, history: [] }, "2026-10-01")).toBeNull();
  });
});
