import { describe, it, expect } from "vitest";
import {
  DRIVERS_LOAD_ERROR, driverHref, driverParts, driverReading, driversListName, driversReasonText, hasMiss, isKpiDriver, isKpiDrivers, noDriversStandOut,
  type KpiDriver,
} from "./deptKpiDriverFormat";
import { kpiPeriodFromQuery } from "./deptKpiFormat";

// DW-4j-3 — the pure wording of "Behind the miss" (BFF §43.8). Golden strings: a driver's value is `formatKpiValue`'s, in the KPI's unit.

const project = (over: Partial<KpiDriver> = {}): KpiDriver => ({ kind: "project", id: "p-1", name: "Client site redesign", value: 0.6, numerator: 3, denominator: 5, ...over });
const person = (over: Partial<KpiDriver> = {}): KpiDriver => ({ kind: "person", id: "u-1", name: "Made Putra", value: 0.2, numerator: 2, denominator: 10, ...over });

describe("driverReading: the value in the KPI's unit and the parts, per metric", () => {
  it("projects on time: a percent and the milestones", () => {
    expect(driverReading("projects-on-time", "percent", project({ value: 0.6, numerator: 3, denominator: 5 }))).toEqual({ value: "60%", parts: "3 of 5 milestones hit" });
    expect(driverReading("projects-on-time", "percent", project({ value: 2 / 5, numerator: 2, denominator: 5 }))).toEqual({ value: "40%", parts: "2 of 5 milestones hit" });
  });
  it("reopened work: a percent and the tasks reopened", () => {
    expect(driverReading("reopened-work-rate", "percent", person({ value: 0.3, numerator: 3, denominator: 10 }))).toEqual({ value: "30%", parts: "3 of 10 tasks reopened" });
  });
  it("check-in compliance: a percent and the check-ins", () => {
    expect(driverReading("check-in-compliance", "percent", person({ value: 18 / 22, numerator: 18, denominator: 22 }))).toEqual({ value: "82%", parts: "18 of 22 check-ins" });
  });
  it("overdue tasks: a count with no ratio, so the count is the parts and the value is not said twice", () => {
    const d = person({ value: 4, numerator: undefined, denominator: undefined });
    expect(driverParts("overdue-tasks", "count", d)).toBe("4 overdue");
    expect(driverReading("overdue-tasks", "count", d)).toEqual({ value: null, parts: "4 overdue" });
  });
  it("a number with thousands is grouped as every other KPI number", () => {
    expect(driverParts("projects-on-time", "percent", project({ numerator: 1200, denominator: 1500 }))).toBe("1,200 of 1,500 milestones hit");
  });
  it("a KPI this does not know says only the numbers when it has a ratio, and nothing when it has none", () => {
    expect(driverParts("something-new", "percent", project({ numerator: 3, denominator: 5 }))).toBe("3 of 5");
    expect(driverReading("something-new", "count", project({ value: 7, numerator: undefined, denominator: undefined }))).toEqual({ value: "7", parts: null });
    expect(driverParts("asset-requests-on-time", "percent", person({ numerator: 5, denominator: 9 }))).toBe("5 of 9");
  });
  it("a minutes KPI is worded as a duration, through the one formatter", () => {
    expect(driverReading("something-new", "minutes", person({ value: 200, numerator: undefined, denominator: undefined })).value).toBe("3h 20m");
  });
});

describe("the words", () => {
  it("what an empty answer says depends on the grain of the KPI", () => {
    expect(noDriversStandOut("projects-on-time")).toBe("No project missed a milestone");
    for (const k of ["reopened-work-rate", "overdue-tasks", "check-in-compliance"]) expect(noDriversStandOut(k)).toBe("No one stands out");
  });
  it("the reason words, and a reason this does not know reads as no breakdown", () => {
    expect(driversReasonText("no_reader")).toBe("Not measured yet");
    expect(driversReasonText("no_drivers")).toBe("No breakdown for this KPI");
    expect(driversReasonText("reader_failed")).toBe("No breakdown for this KPI");
    expect(driversReasonText(undefined)).toBe("No breakdown for this KPI");
  });
  it("the list's accessible name and the failure line", () => {
    expect(driversListName("Projects on time")).toBe("Behind the miss: Projects on time");
    expect(DRIVERS_LOAD_ERROR).toBe("Couldn't load what is behind this");
  });
  it("only a KPI that is at risk or off track has a miss", () => {
    expect([hasMiss("at_risk"), hasMiss("off_track"), hasMiss("on_track"), hasMiss("unavailable")]).toEqual([true, true, false, false]);
  });
});

describe("driverHref: only routes that exist", () => {
  const period = { periodKind: "week", start: "2026-10-05", end: "2026-10-11" };
  it("a project goes to its page; a person to their report for the period", () => {
    expect(driverHref({ kind: "project", id: "p-web-1" }, period)).toBe("/projects/p-web-1");
    expect(driverHref({ kind: "person", id: "u-1" }, period)).toBe("/reports/person?periodKind=week&start=2026-10-05&end=2026-10-11&scopeRef=u-1");
  });
  it("encodes an id", () => {
    expect(driverHref({ kind: "project", id: "a/b" }, period)).toBe("/projects/a%2Fb");
  });
});

describe("the shape guard", () => {
  const ok = { kpi: { key: "k", label: "K", unit: "percent", direction: "up_good" }, period: { periodKind: "month", start: "2026-10-01", end: "2026-10-31" } };
  it("takes an array (even an empty one), or null with a reason", () => {
    expect(isKpiDrivers({ ...ok, drivers: [] })).toBe(true);
    expect(isKpiDrivers({ ...ok, drivers: [project(), person()] })).toBe(true);
    expect(isKpiDrivers({ ...ok, drivers: null, reason: "no_reader" })).toBe(true);
    expect(isKpiDrivers({ ...ok, drivers: null, reason: "something_later" })).toBe(true);
  });
  it("refuses everything else", () => {
    for (const v of [null, undefined, [], "x", { ...ok }, { ...ok, drivers: null }, { ...ok, drivers: {} }, { ...ok, drivers: [{}] }, { ...ok, period: null }]) expect(isKpiDrivers(v)).toBe(false);
    expect(isKpiDriver({ ...project(), value: Number.NaN })).toBe(false);
    expect(isKpiDriver({ ...project(), value: Infinity })).toBe(false);
  });
});

describe("kpiPeriodFromQuery: the digest's link opens the page on its week", () => {
  it("honours periodKind and start from the digest's href", () => {
    expect(kpiPeriodFromQuery({ periodKind: "week", start: "2026-10-05" }, "2026-10-14")).toEqual({ periodKind: "week", start: "2026-10-05" });
  });
  it("passes end only when given, and defaults to the month of today", () => {
    expect(kpiPeriodFromQuery({ periodKind: "custom", start: "2026-10-01", end: "2026-10-20" }, "2026-10-14")).toEqual({ periodKind: "custom", start: "2026-10-01", end: "2026-10-20" });
    expect(kpiPeriodFromQuery({}, "2026-10-14")).toEqual({ periodKind: "month", start: "2026-10-14" });
  });
  it("a missing, empty or repeated param falls back instead of reaching the server as nonsense", () => {
    expect(kpiPeriodFromQuery({ periodKind: "", start: ["2026-10-05", "2026-10-12"], end: "" }, "2026-10-14")).toEqual({ periodKind: "month", start: "2026-10-14" });
  });
});
