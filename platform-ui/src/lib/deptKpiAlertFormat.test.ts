import { describe, it, expect } from "vitest";
import {
  acknowledgedLine, alertReading, alertState, alertTitle, explainAckError, formatAlertDay, isKpiAlert, newestFirst, offTrackSince,
  openAlertsByKpi, resolvedLine, tileAlertLine, type KpiAlert,
} from "./deptKpiAlertFormat";
import { formatKpiValue } from "./deptKpiFormat";

// DW-4j-2 — the pure side of the KPI alerts (BFF §43.5): golden strings, so the page, the Needs-you row and the tests say the same words.

const alert = (over: Partial<KpiAlert> = {}): KpiAlert => ({
  id: "al-1", unit: { id: "dept-1", name: "Web Dev" }, kpiKey: "projects-on-time", kpiLabel: "Projects on time", kpiUnit: "percent",
  periodStart: "2026-10-01", openedAt: "2026-10-03T06:30:00.000Z", value: 0.72, target: 0.9,
  acknowledgedBy: null, acknowledgedByName: null, acknowledgedAt: null, ackNote: null, resolvedAt: null, resolvedCondition: null, ...over,
});

describe("formatAlertDay", () => {
  it("words the UTC day as day and month", () => {
    expect(formatAlertDay("2026-10-03T06:30:00.000Z")).toBe("3 Oct");
    expect(formatAlertDay("2026-01-31")).toBe("31 Jan");
    expect(formatAlertDay("2026-12-09T23:59:59.000Z")).toBe("9 Dec");
  });
  it("adds the year only when it is not the reference year", () => {
    expect(formatAlertDay("2025-10-03T06:30:00.000Z", 2026)).toBe("3 Oct 2025");
    expect(formatAlertDay("2026-10-03T06:30:00.000Z", 2026)).toBe("3 Oct");
  });
  it("never invents a day for an unreadable value", () => {
    expect(formatAlertDay("")).toBe("an unknown day");
    expect(formatAlertDay("soon")).toBe("an unknown day");
    expect(formatAlertDay("2026-13-01")).toBe("an unknown day");
  });
});

describe("the sentences", () => {
  it("titles the Needs-you row with the KPI and the department", () => {
    expect(alertTitle(alert())).toBe("Projects on time is off track · Web Dev");
  });
  it("words the value against the target with the ONE KPI formatter", () => {
    expect(alertReading(alert())).toBe("72% against 90%");
    expect(alertReading(alert())).toBe(`${formatKpiValue(0.72, "percent")} against ${formatKpiValue(0.9, "percent")}`);
    expect(alertReading(alert({ kpiUnit: "minutes", value: 200, target: 120 }))).toBe("3h 20m against 2h");
    expect(alertReading(alert({ kpiUnit: "count", value: 3, target: 2 }))).toBe("3 against 2");
    expect(alertReading(alert({ value: null }))).toBe("— against 90%");
  });
  it("has no reading for a KPI the workspace no longer has (no scale to word it in)", () => {
    expect(alertReading(alert({ kpiUnit: null }))).toBeNull();
  });
  it("says since when it is off track", () => {
    expect(offTrackSince(alert())).toBe("Off track since 3 Oct");
  });
  it("says who acknowledged it and when, or nothing when nobody has", () => {
    expect(acknowledgedLine(alert())).toBeNull();
    expect(acknowledgedLine(alert({ acknowledgedAt: "2026-10-04T09:00:00.000Z", acknowledgedByName: "Ayu" }))).toBe("Acknowledged by Ayu on 4 Oct");
    expect(acknowledgedLine(alert({ acknowledgedAt: "2026-10-04T09:00:00.000Z", acknowledgedByName: null }))).toBe("Acknowledged on 4 Oct");
  });
  it("says how it was resolved, or nothing while it is open", () => {
    expect(resolvedLine(alert())).toBeNull();
    expect(resolvedLine(alert({ resolvedAt: "2026-10-09T06:30:00.000Z", resolvedCondition: "on_track" }))).toBe("Back on track on 9 Oct");
    expect(resolvedLine(alert({ resolvedAt: "2026-10-09T06:30:00.000Z", resolvedCondition: "at_risk" }))).toBe("Improved to at risk on 9 Oct");
    expect(resolvedLine(alert({ resolvedAt: "2026-11-01T06:30:00.000Z", resolvedCondition: "unavailable" }))).toBe("Resolved (unavailable) on 1 Nov");
    expect(resolvedLine(alert({ resolvedAt: "2026-11-01T06:30:00.000Z", resolvedCondition: null }))).toBe("Resolved on 1 Nov");
  });
  it("words the tile line: since when, plus who once a head has acknowledged", () => {
    expect(tileAlertLine(alert())).toBe("Off track since 3 Oct");
    expect(tileAlertLine(alert({ acknowledgedAt: "2026-10-04T09:00:00.000Z", acknowledgedByName: "Ayu" }))).toBe("Off track since 3 Oct · acknowledged by Ayu");
    expect(tileAlertLine(alert({ acknowledgedAt: "2026-10-04T09:00:00.000Z", acknowledgedByName: null }))).toBe("Off track since 3 Oct · acknowledged");
  });
});

describe("alertState, openAlertsByKpi and newestFirst", () => {
  it("is open until acknowledged, and resolved wins over acknowledged", () => {
    expect(alertState(alert())).toBe("open");
    expect(alertState(alert({ acknowledgedAt: "2026-10-04T09:00:00.000Z" }))).toBe("acknowledged");
    expect(alertState(alert({ acknowledgedAt: "2026-10-04T09:00:00.000Z", resolvedAt: "2026-10-09T06:30:00.000Z" }))).toBe("resolved");
  });
  it("keeps only the open alert of a KPI for its tile, never a resolved one", () => {
    const open = alert({ id: "open", kpiKey: "a" });
    const done = alert({ id: "done", kpiKey: "b", resolvedAt: "2026-10-09T06:30:00.000Z" });
    const m = openAlertsByKpi([open, done]);
    expect([...m.keys()]).toEqual(["a"]);
    expect(m.get("a")?.id).toBe("open");
  });
  it("lists the history newest opened first, keeping the sent order for ties", () => {
    const a = alert({ id: "a", openedAt: "2026-08-01T00:00:00.000Z" });
    const b = alert({ id: "b", openedAt: "2026-10-01T00:00:00.000Z" });
    const c = alert({ id: "c", openedAt: "2026-10-01T00:00:00.000Z" });
    expect(newestFirst([a, b, c]).map((x) => x.id)).toEqual(["b", "c", "a"]);
  });
});

describe("explainAckError", () => {
  it("words the two machine codes and leaves every other message as the server sent it", () => {
    expect(explainAckError("already_acknowledged")).toMatch(/already acknowledged/);
    expect(explainAckError("resolved")).toMatch(/resolved/);
    expect(explainAckError("outside your reporting line")).toBe("outside your reporting line");
    expect(explainAckError("alert_not_found")).toBe("alert_not_found");
  });
});

describe("isKpiAlert", () => {
  it("accepts a row of the documented shape, with a null unit for a KPI the workspace dropped", () => {
    expect(isKpiAlert(alert())).toBe(true);
    expect(isKpiAlert(alert({ kpiUnit: null, value: null, target: null }))).toBe(true);
  });
  it("refuses a row with a missing or mistyped field rather than rendering half of it", () => {
    expect(isKpiAlert(null)).toBe(false);
    expect(isKpiAlert({})).toBe(false);
    expect(isKpiAlert({ ...alert(), unit: undefined })).toBe(false);
    expect(isKpiAlert({ ...alert(), value: "0.72" })).toBe(false);
    expect(isKpiAlert({ ...alert(), kpiUnit: "furlongs" })).toBe(false);
    expect(isKpiAlert({ ...alert(), resolvedCondition: "fine" })).toBe(false);
  });
});
