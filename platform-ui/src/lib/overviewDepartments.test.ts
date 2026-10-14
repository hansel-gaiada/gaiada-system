import { describe, it, expect } from "vitest";
import {
  countsText, departmentsView, driversOf, formatKpiValue, normalizeDeptKpiOverview, orderDepartments, standingDetail, unratedText,
  DEPARTMENTS_SHOWN, type DeptKpiReading, type DeptStanding,
} from "./overviewDepartments";

const kpi = (over: Partial<DeptKpiReading> = {}): DeptKpiReading => ({
  key: "projects-on-time", label: "Projects on time", unit: "percent", direction: "up_good", value: 0.62, target: 0.85, tolerance: 0.1,
  targetSource: "approved", condition: "off_track", reason: null, ...over,
});
const dept = (id: string, name: string, condition: DeptStanding["condition"], kpis: DeptKpiReading[] = [], workspace: string | null = null): DeptStanding =>
  ({ id, name, workspace, condition, kpis });
const noTarget = (key: string, reason = "no_reader") => kpi({ key, label: key, value: null, target: null, tolerance: null, targetSource: "none", condition: "unavailable", reason });

describe("normalizeDeptKpiOverview (BFF §40.3a)", () => {
  const wire = {
    period: { periodKind: "month", start: "2026-10-01", end: "2026-10-31" },
    departments: [
      {
        unit: { id: "d-web", name: "Web Dev" }, workspace: "web-dev", condition: "off_track",
        kpis: [{ key: "projects-on-time", label: "Projects on time", unit: "percent", direction: "up_good", value: 0.62, numerator: 5, denominator: 8, target: 0.85, tolerance: 0.1, targetSource: "approved", condition: "off_track" }],
      },
    ],
  };

  it("reads a department's unit, workspace, condition and KPIs", () => {
    const o = normalizeDeptKpiOverview(wire)!;
    expect(o.departments).toHaveLength(1);
    expect(o.departments[0]).toMatchObject({ id: "d-web", name: "Web Dev", workspace: "web-dev", condition: "off_track" });
    expect(o.departments[0].kpis[0]).toMatchObject({ key: "projects-on-time", unit: "percent", value: 0.62, target: 0.85, tolerance: 0.1, targetSource: "approved", reason: null });
  });

  it("keeps null as null: a missing value, target or tolerance is never 0", () => {
    const o = normalizeDeptKpiOverview({ departments: [{ unit: { id: "d", name: "D" }, condition: "unavailable", kpis: [{ key: "k", value: null, target: null, tolerance: null, targetSource: "none", condition: "unavailable", reason: "no_target" }] }] })!;
    expect(o.departments[0].kpis[0]).toMatchObject({ value: null, target: null, tolerance: null, targetSource: "none", reason: "no_target" });
  });

  it("reads a condition it does not know as unavailable, never as a rating", () => {
    const o = normalizeDeptKpiOverview({ departments: [{ unit: { id: "d", name: "D" }, condition: "excellent", kpis: [{ key: "k", condition: "stellar" }] }] })!;
    expect(o.departments[0].condition).toBe("unavailable");
    expect(o.departments[0].kpis[0].condition).toBe("unavailable");
  });

  it("is null for an answer that is not the overview, so the reader says Unavailable and never an empty list", () => {
    for (const raw of [null, undefined, "x", [], {}, { departments: "no" }, { items: [] }]) expect(normalizeDeptKpiOverview(raw), JSON.stringify(raw)).toBeNull();
  });

  it("drops a department with no unit id, and falls back to the id for a missing name", () => {
    const o = normalizeDeptKpiOverview({ departments: [{ condition: "on_track" }, { unit: {} }, { unit: { id: "d-x" }, condition: "on_track" }] })!;
    expect(o.departments.map((d) => [d.id, d.name])).toEqual([["d-x", "d-x"]]);
  });

  it("is an empty list for a company with no department: a real answer", () => {
    expect(normalizeDeptKpiOverview({ departments: [] })).toEqual({ departments: [] });
  });
});

describe("orderDepartments: worst first, unknown last (plan §5.5)", () => {
  it("puts off track, at risk, on track, then the departments with no condition", () => {
    const rows = [
      dept("1", "A", "unavailable"), dept("2", "B", "on_track"), dept("3", "C", "off_track"), dept("4", "D", "at_risk"), dept("5", "E", "unavailable"),
    ];
    expect(orderDepartments(rows).map((d) => d.id)).toEqual(["3", "4", "2", "1", "5"]);
  });

  it("breaks ties by name, then id, and does not mutate its input", () => {
    const rows = [dept("2", "Same", "at_risk"), dept("1", "Same", "at_risk"), dept("3", "Alpha", "at_risk")];
    const before = rows.map((d) => d.id);
    expect(orderDepartments(rows).map((d) => d.id)).toEqual(["3", "1", "2"]);
    expect(rows.map((d) => d.id)).toEqual(before);
  });
});

describe("driversOf: the KPI driving the condition", () => {
  it("is the KPI furthest past its target, in units of its tolerance", () => {
    const a = kpi({ key: "a", label: "A", value: 0.7, target: 0.85, tolerance: 0.1, condition: "off_track" }); // 1.5 tolerances
    const b = kpi({ key: "b", label: "B", value: 0.4, target: 0.85, tolerance: 0.3, condition: "off_track" }); // 1.5 tolerances too
    const c = kpi({ key: "c", label: "C", value: 0.5, target: 0.85, tolerance: 0.1, condition: "off_track" }); // 3.5
    const d = driversOf({ kpis: [a, b, c] });
    expect(d.first?.key).toBe("c");
    expect(d.others).toBe(2);
    expect(d.level).toBe("off_track");
  });

  it("keeps the catalogue's order on equal shortfalls", () => {
    const a = kpi({ key: "a", value: 0.7, condition: "at_risk" });
    const b = kpi({ key: "b", value: 0.7, condition: "at_risk" });
    expect(driversOf({ kpis: [a, b] }).first?.key).toBe("a");
  });

  it("reads a down-is-good KPI the other way round", () => {
    const k = kpi({ key: "overdue", direction: "down_good", unit: "count", value: 12, target: 5, tolerance: 3, condition: "off_track" });
    const ok = kpi({ key: "ok", direction: "down_good", unit: "count", value: 2, target: 5, tolerance: 3, condition: "on_track" });
    expect(driversOf({ kpis: [ok, k] }).first?.key).toBe("overdue");
  });

  it("uses the at-risk KPIs when a department is off track on two of them (§40.3), and none when nothing is at risk", () => {
    const a = kpi({ key: "a", value: 0.8, condition: "at_risk" });
    const b = kpi({ key: "b", value: 0.78, condition: "at_risk" });
    const d = driversOf({ kpis: [a, b] });
    expect(d.level).toBe("at_risk");
    expect(d.others).toBe(1);
    expect(driversOf({ kpis: [kpi({ condition: "on_track" }), noTarget("x")] })).toEqual({ first: null, others: 0, level: null });
  });
});

describe("the words a row says", () => {
  it("formats each unit in its own terms", () => {
    expect(formatKpiValue("percent", 0.625)).toBe("63%");
    expect(formatKpiValue("count", 1234)).toBe("1,234");
    expect(formatKpiValue("minutes", 45)).toBe("45 min");
    expect(formatKpiValue("minutes", 150)).toBe("2.5 h");
  });

  it("names the KPI and its figure against the target for an off-track department", () => {
    const d = dept("d", "Web Dev", "off_track", [kpi(), kpi({ key: "x", label: "X", value: 0.9, target: 0.85, condition: "on_track" })]);
    expect(standingDetail(d)).toBe("Projects on time: 62% against a target of 85%");
  });

  it("says how many more KPIs share the worst condition", () => {
    const d = dept("d", "D", "off_track", [kpi(), kpi({ key: "b", label: "B", value: 0.5 })]);
    expect(standingDetail(d)).toMatch(/, and 1 more$/);
  });

  it("says what an on-track department has measured, without inventing a driver", () => {
    expect(standingDetail(dept("d", "D", "on_track", [kpi({ condition: "on_track" }), noTarget("n")]))).toBe("Its one measured KPI is on target");
    expect(standingDetail(dept("d", "D", "on_track", [kpi({ condition: "on_track" }), kpi({ key: "b", condition: "on_track" })]))).toBe("All 2 measured KPIs are on target");
  });

  it("says No target set when no KPI has a target in force, which is every department until targets are approved", () => {
    const d = dept("d", "D", "unavailable", [noTarget("a"), noTarget("b", "no_target")]);
    expect(unratedText(d)).toBe("No target set");
    expect(standingDetail(d)).toBe("No target set");
  });

  it("says what a department with a target still lacks", () => {
    const withTarget = (reason: string) => kpi({ value: null, targetSource: "approved", condition: "unavailable", reason });
    expect(unratedText(dept("d", "D", "unavailable", [withTarget("no_data"), noTarget("n")]))).toBe("No data in this period");
    expect(unratedText(dept("d", "D", "unavailable", [withTarget("no_reader"), noTarget("n")]))).toBe("Not measured yet");
    expect(unratedText(dept("d", "D", "unavailable", []))).toBe("No KPIs defined");
  });

  it("counts only the states that have a department in them", () => {
    expect(countsText({ offTrack: 1, atRisk: 0, onTrack: 2, notRated: 1 })).toBe("1 off track, 2 on track, 1 with no condition yet");
    expect(countsText({ offTrack: 0, atRisk: 0, onTrack: 0, notRated: 0 })).toBe("");
  });
});

describe("departmentsView: the block's three read states", () => {
  const ok = (departments: DeptStanding[]) => ({ kind: "ok" as const, data: { departments } });

  it("passes a refusal and a failure through, never an empty list", () => {
    expect(departmentsView({ kind: "forbidden" })).toEqual({ kind: "forbidden" });
    expect(departmentsView({ kind: "unavailable", reason: "boom" })).toEqual({ kind: "unavailable" });
  });

  it("an empty ok is a real 'no department': zero rows and zero counts", () => {
    expect(departmentsView(ok([]))).toEqual({ kind: "ok", rows: [], total: 0, counts: { offTrack: 0, atRisk: 0, onTrack: 0, notRated: 0 } });
  });

  it("orders worst first with the unrated last, whatever order the server sent", () => {
    const v = departmentsView(ok([
      dept("a", "Creatives", "unavailable", [noTarget("x")]), dept("b", "Social", "on_track", [kpi({ condition: "on_track" })]),
      dept("c", "Web Dev", "off_track", [kpi()]), dept("d", "SEO", "at_risk", [kpi({ condition: "at_risk", value: 0.8 })]),
    ]));
    if (v.kind !== "ok") throw new Error("expected ok");
    expect(v.rows.map((r) => [r.name, r.conditionText])).toEqual([
      ["Web Dev", "Off track"], ["SEO", "At risk"], ["Social", "On track"], ["Creatives", "No condition yet"],
    ]);
    expect(v.rows[3].detail).toBe("No target set");
    expect(v.rows[0].href).toBe("/departments/c");
    expect(v.counts).toEqual({ offTrack: 1, atRisk: 1, onTrack: 1, notRated: 1 });
  });

  it("every department unrated, the live state until targets are approved: all say No target set, ordered by name", () => {
    const v = departmentsView(ok([dept("2", "SEO", "unavailable", [noTarget("a")]), dept("1", "Creatives", "unavailable", [noTarget("a")])]));
    if (v.kind !== "ok") throw new Error("expected ok");
    expect(v.rows.map((r) => [r.name, r.detail])).toEqual([["Creatives", "No target set"], ["SEO", "No target set"]]);
    expect(v.counts.notRated).toBe(2);
  });

  it("caps the rows and says how many exist", () => {
    const many = Array.from({ length: DEPARTMENTS_SHOWN + 3 }, (_, i) => dept(`d${i}`, `Dept ${String(i).padStart(2, "0")}`, "on_track"));
    const v = departmentsView(ok(many));
    if (v.kind !== "ok") throw new Error("expected ok");
    expect(v.rows).toHaveLength(DEPARTMENTS_SHOWN);
    expect(v.total).toBe(DEPARTMENTS_SHOWN + 3);
  });

  it("encodes the department id in its link", () => {
    const v = departmentsView(ok([dept("a/b", "X", "on_track")]));
    if (v.kind !== "ok") throw new Error("expected ok");
    expect(v.rows[0].href).toBe("/departments/a%2Fb");
  });
});
