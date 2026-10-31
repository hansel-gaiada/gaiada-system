import { describe, it, expect } from "vitest";
import {
  HEALTH_LABEL, HEALTH_TOKEN, PLAN_REFUSAL_REASON, asCycleTable, asSocialSettings, deadlineRange, healthText, isMonthKey, writeRefusalText,
  type Health,
} from "./socialCycles";

// SCP-1c: the Settings page's pure side. The maths are the server's (its golden table); this file pins the parsing and the words.

const h = (state: Health["state"], over: Partial<Health> = {}): Health => ({ state, spareDays: null, lateDays: null, lateWith: null, latestSafeHandoff: null, readyBy: "2026-10-13", ...over });

describe("healthText: the words always carry the state", () => {
  it("on track names its spare days, singular and plural", () => {
    expect(healthText(h("on_track", { spareDays: 3 }))).toBe("On track · 3 spare days");
    expect(healthText(h("on_track", { spareDays: 1 }))).toBe("On track · 1 spare day");
    expect(healthText(h("on_track"))).toBe("On track");
  });
  it("tight, at risk and done are their words", () => {
    expect(healthText(h("tight", { spareDays: 0 }))).toBe("Tight");
    expect(healthText(h("at_risk", { spareDays: -2 }))).toBe("At risk");
    expect(healthText(h("done"))).toBe("Done");
  });
  it("late names the days and who it waits on", () => {
    expect(healthText(h("late", { lateDays: 2, lateWith: "designer" }))).toBe("Late · 2 days · with the designer");
    expect(healthText(h("late", { lateDays: 1, lateWith: "client" }))).toBe("Late · 1 day · with the client");
    expect(healthText(h("late", { lateDays: 0, lateWith: null }))).toBe("Late · 0 days");
  });
  it("every state has a label and a design token, and no token is a raw colour", () => {
    for (const s of ["on_track", "tight", "at_risk", "late", "done"] as const) {
      expect(HEALTH_LABEL[s]).toBeTruthy();
      expect(HEALTH_TOKEN[s]).toMatch(/^var\(--status-[a-z]+-fg\)$/);
    }
  });
});

describe("deadlineRange (the social_cycles check)", () => {
  it("runs from the 1st three months before to the month's last day, across the year turn", () => {
    expect(deadlineRange("2026-03")).toEqual({ min: "2025-12-01", max: "2026-03-31" });
    expect(deadlineRange("2026-10")).toEqual({ min: "2026-07-01", max: "2026-10-31" });
    expect(deadlineRange("2028-02")).toEqual({ min: "2027-11-01", max: "2028-02-29" });
  });
  it("month keys", () => {
    expect(isMonthKey("2026-10")).toBe(true);
    for (const bad of ["2026-13", "2026-1", "2026-00", "x", 5, null]) expect(isMonthKey(bad)).toBe(false);
  });
});

describe("asSocialSettings", () => {
  it("reads the contract's shape", () => {
    expect(asSocialSettings({ bufferWorkingDays: 2, boostCandidateFactor: 1.5, holidayCalendar: { known: true, name: "Public holidays" }, canPlan: true }))
      .toEqual({ bufferWorkingDays: 2, boostCandidateFactor: 1.5, holidayCalendar: { known: true, name: "Public holidays" }, onboardingTemplate: null, canPlan: true });
  });
  it("reads an unknown calendar as weekends only, and a missing canPlan as false", () => {
    const s = asSocialSettings({ bufferWorkingDays: 1, boostCandidateFactor: 1.25, holidayCalendar: { known: false, name: null } });
    expect(s.holidayCalendar).toEqual({ known: false, name: null });
    expect(s.canPlan).toBe(false);
  });
  it("refuses a body that is not settings (the reader turns it into 'cannot tell')", () => {
    expect(() => asSocialSettings([])).toThrow();
    expect(() => asSocialSettings({ bufferWorkingDays: "1" })).toThrow();
    expect(() => asSocialSettings(null)).toThrow();
  });
});

describe("asCycleTable", () => {
  const row = {
    engagementId: "e1", clientName: "Brand Alpha", officer: { id: "u1", name: "Sam" }, deliveryBatch: "A", cycleId: "c1",
    deadline: "2026-09-15", readyBy: "2026-09-14", prefill: { deadline: "2026-09-15", batch: "A" }, target: 12,
    counts: { counted: 8, extra: 1 }, health: { state: "on_track", spareDays: 3, lateDays: null, lateWith: null, latestSafeHandoff: "2026-09-10", readyBy: "2026-09-14" },
  };
  it("parses rows, fills missing counts with 0, and keeps a null health null", () => {
    const t = asCycleTable({ month: "2026-10", bufferWorkingDays: 1, holidaysKnown: false, canPlan: true, rows: [row, { ...row, engagementId: "e2", cycleId: null, health: null }] });
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0].counts).toMatchObject({ counted: 8, extra: 1, planned: 0, stories: 0 });
    expect(t.rows[0].health?.state).toBe("on_track");
    expect(t.rows[1].health).toBeNull();
    expect(t.rows[1].cycleId).toBeNull();
    expect(t).toMatchObject({ month: "2026-10", holidaysKnown: false, canPlan: true });
  });
  it("drops a row that is not a row and a health that is not one; refuses a body that is not a table", () => {
    const t = asCycleTable({ month: "2026-10", rows: [row, 7, { engagementId: 1 }, { ...row, engagementId: "e3", health: { state: "fine" } }] });
    expect(t.rows.map((r) => r.engagementId)).toEqual(["e1", "e3"]);
    expect(t.rows[1].health).toBeNull();
    expect(() => asCycleTable({ month: "soon", rows: [] })).toThrow();
    expect(() => asCycleTable({ month: "2026-10" })).toThrow();
    expect(() => asCycleTable("x")).toThrow();
  });
});

describe("writeRefusalText", () => {
  it("says the plan refusal in the reason's words", () => {
    expect(writeRefusalText("not_a_social_approver")).toBe(PLAN_REFUSAL_REASON);
  });
  it("names what is wrong with a field", () => {
    expect(writeRefusalText("invalid_field", "bufferWorkingDays")).toMatch(/0 to 10/);
    expect(writeRefusalText("invalid_field", "boostCandidateFactor")).toMatch(/1 to 10/);
    expect(writeRefusalText("invalid_field", "rows[2].deadline")).toMatch(/real date/);
    expect(writeRefusalText("engagement_not_found")).toMatch(/Reload/);
    expect(writeRefusalText("something_else")).toBe("something_else");
  });
});
