import { describe, it, expect } from "vitest";
import {
  countsText, departmentsView, normalizeDeptKpiOverview, standingDetail, DEPARTMENTS_SHOWN, type DeptStanding,
} from "./overviewDepartments";
import { bannerSentence, conditionLabel, driverText, unavailableWhy, type DeptKpi, type KpiReason } from "./deptKpiFormat";

const kpi = (over: Partial<DeptKpi> = {}): DeptKpi => ({
  key: "projects-on-time", label: "Projects on time", unit: "percent", direction: "up_good", value: 0.62, target: 0.85, tolerance: 0.1,
  targetSource: "approved", condition: "off_track", ...over,
});
const dept = (id: string, name: string, condition: DeptStanding["condition"], kpis: DeptKpi[] = [], workspace: string | null = null): DeptStanding =>
  ({ unit: { id, name }, workspace, condition, kpis });
const noTarget = (key: string, reason: KpiReason = "no_reader") => kpi({ key, label: key, value: null, target: null, tolerance: null, targetSource: "none", condition: "unavailable", reason });

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
    expect(o.departments[0]).toMatchObject({ unit: { id: "d-web", name: "Web Dev" }, workspace: "web-dev", condition: "off_track" });
    expect(o.departments[0].kpis[0]).toMatchObject({ key: "projects-on-time", unit: "percent", value: 0.62, numerator: 5, denominator: 8, target: 0.85, tolerance: 0.1, targetSource: "approved" });
    expect(o.departments[0].kpis[0].reason).toBeUndefined();
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

  it("drops a reason code it does not know rather than inventing words for it", () => {
    const o = normalizeDeptKpiOverview({ departments: [{ unit: { id: "d", name: "D" }, condition: "unavailable", kpis: [{ key: "k", condition: "unavailable", reason: "cosmic_rays" }] }] })!;
    expect(o.departments[0].kpis[0].reason).toBeUndefined();
  });

  it("is null for an answer that is not the overview, so the reader says Unavailable and never an empty list", () => {
    for (const raw of [null, undefined, "x", [], {}, { departments: "no" }, { items: [] }]) expect(normalizeDeptKpiOverview(raw), JSON.stringify(raw)).toBeNull();
  });

  it("drops a department with no unit id, and falls back to the id for a missing name", () => {
    const o = normalizeDeptKpiOverview({ departments: [{ condition: "on_track" }, { unit: {} }, { unit: { id: "d-x" }, condition: "on_track" }] })!;
    expect(o.departments.map((d) => [d.unit.id, d.unit.name])).toEqual([["d-x", "d-x"]]);
  });

  it("is an empty list for a company with no department: a real answer", () => {
    expect(normalizeDeptKpiOverview({ departments: [] })).toEqual({ departments: [] });
  });
});

describe("the words a row says: deptKpiFormat's, not a second vocabulary (DW-3i2)", () => {
  it("names the driving KPI and its figure against the target, as the department banner does", () => {
    const d = dept("d", "Web Dev", "off_track", [kpi(), kpi({ key: "x", label: "X", value: 0.9, target: 0.85, condition: "on_track" })]);
    expect(standingDetail(d)).toBe("Projects on time 62% against 85%");
    expect(standingDetail(d)).toBe(driverText(kpi()));
    // The banner of the same department ends with the very same words.
    expect(bannerSentence({ unit: d.unit, condition: d.condition, kpis: d.kpis })).toBe(`Web Dev: off track · ${standingDetail(d)}`);
  });

  it("picks the KPI furthest past its target among the worst condition, and says how many more share it", () => {
    const a = kpi({ key: "a", label: "A", value: 0.7, condition: "off_track" });
    const c = kpi({ key: "c", label: "C", value: 0.5, condition: "off_track" });
    const ok = kpi({ key: "ok", label: "OK", value: 0.9, condition: "on_track" });
    expect(standingDetail(dept("d", "D", "off_track", [ok, a, c]))).toBe("C 50% against 85%, and 1 more");
    // Off track on two at-risk KPIs (§40.3): the at-risk ones are named.
    const r1 = kpi({ key: "r1", label: "R1", value: 0.8, condition: "at_risk" });
    const r2 = kpi({ key: "r2", label: "R2", value: 0.78, condition: "at_risk" });
    expect(standingDetail(dept("d", "D", "off_track", [r1, r2]))).toBe("R2 78% against 85%, and 1 more");
  });

  it("reads a down-is-good KPI the other way round", () => {
    const k = kpi({ key: "overdue", label: "Overdue", direction: "down_good", unit: "count", value: 12, target: 5, tolerance: 3, condition: "off_track" });
    const ok = kpi({ key: "ok", label: "OK", direction: "down_good", unit: "count", value: 2, target: 5, tolerance: 3, condition: "on_track" });
    expect(standingDetail(dept("d", "D", "off_track", [ok, k]))).toBe("Overdue 12 against 5");
  });

  it("says what an on-track department has measured, without inventing a driver", () => {
    expect(standingDetail(dept("d", "D", "on_track", [kpi({ condition: "on_track" }), noTarget("n")]))).toBe("Its one measured KPI is on target");
    expect(standingDetail(dept("d", "D", "on_track", [kpi({ condition: "on_track" }), kpi({ key: "b", condition: "on_track" })]))).toBe("All 2 measured KPIs are on target");
  });

  it("says why there is no condition in deptKpiFormat's words, never a rating", () => {
    const d = dept("d", "D", "unavailable", [noTarget("a"), noTarget("b", "no_target")]);
    expect(standingDetail(d)).toBe(unavailableWhy(d.kpis));
    expect(standingDetail(d)).toBe("No KPI has an approved target yet");
    expect(standingDetail(dept("d", "D", "unavailable", [noTarget("a")]))).toBe("None of its KPIs is measured yet");
    expect(standingDetail(dept("d", "D", "unavailable", []))).toBe("This department has no KPIs yet");
  });

  it("counts only the states that have a department in them, in the shared condition words", () => {
    expect(countsText({ offTrack: 1, atRisk: 0, onTrack: 2, notRated: 1 })).toBe("1 off track, 2 on track, 1 unavailable");
    expect(countsText({ offTrack: 0, atRisk: 2, onTrack: 0, notRated: 0 })).toBe("2 at risk");
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
      dept("a", "Creatives", "unavailable", [noTarget("x", "no_target")]), dept("b", "Social", "on_track", [kpi({ condition: "on_track" })]),
      dept("c", "Web Dev", "off_track", [kpi()]), dept("d", "SEO", "at_risk", [kpi({ condition: "at_risk", value: 0.8 })]),
    ]));
    if (v.kind !== "ok") throw new Error("expected ok");
    expect(v.rows.map((r) => [r.name, r.conditionText])).toEqual([
      ["Web Dev", "Off track"], ["SEO", "At risk"], ["Social", "On track"], ["Creatives", "Unavailable"],
    ]);
    expect(v.rows[3].detail).toBe("No KPI has an approved target yet");
    expect(v.rows[0].href).toBe("/departments/c");
    expect(v.counts).toEqual({ offTrack: 1, atRisk: 1, onTrack: 1, notRated: 1 });
  });

  it("a row's condition is worded by deptKpiFormat's conditionLabel, for every condition", () => {
    const v = departmentsView(ok((["off_track", "at_risk", "on_track", "unavailable"] as const).map((c, i) => dept(`d${i}`, `D${i}`, c))));
    if (v.kind !== "ok") throw new Error("expected ok");
    expect(v.rows.map((r) => r.conditionText)).toEqual(["Off track", "At risk", "On track", "Unavailable"]);
    for (const r of v.rows) expect(r.conditionText).toBe(conditionLabel(r.condition));
  });

  it("breaks ties by name, then id, and does not mutate the server's list", () => {
    const sent = [dept("2", "Same", "at_risk"), dept("1", "Same", "at_risk"), dept("3", "Alpha", "at_risk")];
    const before = sent.map((d) => d.unit.id);
    const v = departmentsView(ok(sent));
    if (v.kind !== "ok") throw new Error("expected ok");
    expect(v.rows.map((r) => r.id)).toEqual(["3", "1", "2"]);
    expect(sent.map((d) => d.unit.id)).toEqual(before);
  });

  it("every department unrated, the live state until targets are approved: all say why, ordered by name", () => {
    const v = departmentsView(ok([dept("2", "SEO", "unavailable", [noTarget("a", "no_target")]), dept("1", "Creatives", "unavailable", [noTarget("a", "no_target")])]));
    if (v.kind !== "ok") throw new Error("expected ok");
    expect(v.rows.map((r) => [r.name, r.detail])).toEqual([["Creatives", "No KPI has an approved target yet"], ["SEO", "No KPI has an approved target yet"]]);
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
