import { describe, it, expect } from "vitest";
import {
  KIND_TABS, anyPeriodLabel, asReportRules, chosenTab, isKindTab, isPeriodOfKind, isoWeekKey, kindNoun, offeredTabs, periodChoices, periodHasEnded, periodHasStarted, periodLabel, periodOf, periodRange,
  rangeWords, shiftPeriod, tabOfKind,
} from "./socialReportKinds";
import defaults from "./socialRulesDefaults.json";

// SCP-5 W5-A4 (BFF §63.24.1): the kinds' periods. The golden rows are the server's own (`pipeline/rules-periods.ts`): a quarter, half and year follow the fiscal year start and are
// named by the calendar year they start in; a week is ISO, Monday to Sunday.

describe("the kind switch", () => {
  it("has the design's seven tabs, in order", () => {
    expect(KIND_TABS.map((t) => t.label)).toEqual(["Daily", "Weekly", "Monthly", "Quarterly", "Half-year", "Yearly", "Other"]);
    expect(isKindTab("semester")).toBe(true);
    expect(isKindTab("campaign")).toBe(false);
  });
  it("puts campaign and ad hoc reports under Other, and names every kind as the server titles it", () => {
    expect(tabOfKind("campaign")).toBe("other");
    expect(tabOfKind("adhoc")).toBe("other");
    expect(tabOfKind("semester")).toBe("semester");
    expect(kindNoun("semester")).toBe("Half-year report");
    expect(kindNoun("whatever")).toBe("Report");
  });
});

describe("a period's range", () => {
  it("covers a day, an ISO week, a month, a quarter, a half and a year", () => {
    expect(periodRange("daily", "2026-11-09")).toEqual({ start: "2026-11-09", end: "2026-11-09" });
    expect(periodRange("weekly", "2026-W46")).toEqual({ start: "2026-11-09", end: "2026-11-15" });
    expect(periodRange("monthly", "2026-02")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(periodRange("quarterly", "2026-Q4")).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    expect(periodRange("semester", "2026-H1")).toEqual({ start: "2026-01-01", end: "2026-06-30" });
    expect(periodRange("yearly", "2026")).toEqual({ start: "2026-01-01", end: "2026-12-31" });
  });
  it("follows a fiscal year that starts in April, named by the calendar year it starts in", () => {
    expect(periodRange("quarterly", "2026-Q1", 4)).toEqual({ start: "2026-04-01", end: "2026-06-30" });
    expect(periodRange("semester", "2026-H2", 4)).toEqual({ start: "2026-10-01", end: "2027-03-31" });
    expect(periodRange("yearly", "2026", 4)).toEqual({ start: "2026-04-01", end: "2027-03-31" });
    expect(periodOf("quarterly", "2027-02-10", 4)).toBe("2026-Q4");
    expect(periodOf("yearly", "2027-02-10", 4)).toBe("2026");
  });
  it("refuses what is not a real period of its kind", () => {
    expect(periodRange("daily", "2026-02-30")).toBeNull();
    expect(periodRange("weekly", "2025-W53")).toBeNull(); // 2025 has 52 ISO weeks
    expect(periodRange("weekly", "2026-W53")).toEqual({ start: "2026-12-28", end: "2027-01-03" }); // 2026 starts on a Thursday: 53 weeks
    expect(periodRange("quarterly", "2026-Q5")).toBeNull();
    expect(periodRange("semester", "2026-H3")).toBeNull();
    expect(periodRange("yearly", "26")).toBeNull();
    expect(isPeriodOfKind("weekly", "2026-W46")).toBe(true);
    expect(isPeriodOfKind("weekly", "2026-11-09")).toBe(false);
    expect(isPeriodOfKind("campaign", "2026-09")).toBe(false);
  });
  it("names the week of a date by its Thursday's year", () => {
    expect(isoWeekKey("2027-01-01")).toBe("2026-W53");
    expect(isoWeekKey("2026-11-09")).toBe("2026-W46");
  });
});

describe("the period before and after", () => {
  it("steps a day, a week across the year's turn, a month, a quarter, a half and a year", () => {
    expect(shiftPeriod("daily", "2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftPeriod("weekly", "2026-W01", -1)).toBe("2025-W52");
    expect(shiftPeriod("weekly", "2026-W52", 1)).toBe("2026-W53");
    expect(shiftPeriod("monthly", "2026-01", -1)).toBe("2025-12");
    expect(shiftPeriod("quarterly", "2026-Q1", -1)).toBe("2025-Q4");
    expect(shiftPeriod("quarterly", "2026-Q4", 1)).toBe("2027-Q1");
    expect(shiftPeriod("semester", "2026-H1", -1)).toBe("2025-H2");
    expect(shiftPeriod("yearly", "2026", 1)).toBe("2027");
    expect(shiftPeriod("quarterly", "2026-Q1", -1, 4)).toBe("2025-Q4");
    expect(shiftPeriod("daily", "nope", 1)).toBeNull();
  });
});

describe("a period in words", () => {
  it("is the server's title for each kind", () => {
    expect(periodLabel("daily", "2026-11-09")).toBe("9 Nov 2026");
    expect(periodLabel("weekly", "2026-W46")).toBe("Week 46, 2026 (9 to 15 Nov 2026)");
    expect(periodLabel("weekly", "2025-W53")).toBe("2025-W53"); // not a real week: shown as it came
    expect(periodLabel("monthly", "2026-09")).toBe("September 2026");
    expect(periodLabel("quarterly", "2026-Q4")).toBe("Q4 2026");
    expect(periodLabel("semester", "2026-H2")).toBe("H2 2026");
    expect(periodLabel("yearly", "2026")).toBe("2026");
    expect(periodLabel("yearly", "2026", 4)).toBe("2026 (Apr 2026 to Mar 2027)");
  });
  it("writes a range across a month and a year's turn", () => {
    expect(rangeWords({ start: "2026-12-29", end: "2027-01-04" })).toBe("29 Dec 2026 to 4 Jan 2027");
    expect(rangeWords({ start: "2026-10-26", end: "2026-11-01" })).toBe("26 Oct to 1 Nov 2026");
  });
  it("keeps SMM-23's words for a campaign or ad hoc report", () => {
    expect(anyPeriodLabel("campaign", "2026-09")).toBe("September 2026");
    expect(anyPeriodLabel("adhoc", "Spring sale")).toBe("Spring sale");
    expect(anyPeriodLabel("adhoc", null)).toBe("Custom period");
    expect(anyPeriodLabel("monthly", null)).toBe("No period");
  });
});

describe("the periods a person may pick", () => {
  const TODAY = "2026-11-12"; // a Thursday, in week 46
  it("a short kind offers the period still going first, marked so far, then the ended ones", () => {
    const d = periodChoices("daily", TODAY, { allowCurrent: true });
    expect(d[0]).toEqual({ value: "2026-11-12", label: "12 Nov 2026 (so far)", ended: false });
    expect(d[1]).toMatchObject({ value: "2026-11-11", ended: true });
    expect(d).toHaveLength(14);
    expect(periodChoices("weekly", TODAY, { allowCurrent: true })[0].value).toBe("2026-W46");
  });
  it("'all clients' on a kind frozen at create offers only ended periods, so a run never freezes half a period", () => {
    expect(periodChoices("monthly", TODAY, { allowCurrent: false })[0]).toMatchObject({ value: "2026-10", ended: true });
    expect(periodChoices("quarterly", TODAY, { allowCurrent: false })[0].value).toBe("2026-Q3");
    expect(periodChoices("semester", TODAY, { allowCurrent: false })[0].value).toBe("2026-H1");
    expect(periodChoices("yearly", TODAY, { allowCurrent: false })[0].value).toBe("2025");
  });
  it("one client's monthly offers the month so far too, and a fiscal year moves the quarters", () => {
    expect(periodChoices("monthly", TODAY, { allowCurrent: true })[0]).toMatchObject({ value: "2026-11", label: "November 2026 (so far)" });
    expect(periodChoices("quarterly", TODAY, { allowCurrent: false, fiscalYearStartMonth: 4 })[0].value).toBe("2026-Q2"); // Jul to Sep 2026
  });
  it("knows when a period has ended and when it has begun", () => {
    expect(periodHasEnded("weekly", "2026-W45", TODAY)).toBe(true);
    expect(periodHasEnded("weekly", "2026-W46", TODAY)).toBe(false);
    expect(periodHasStarted("weekly", "2026-W47", TODAY)).toBe(false);
    expect(periodHasStarted("daily", "2026-11-12", TODAY)).toBe(true);
  });
});

describe("the company's rules the pages read", () => {
  const body = (kinds: Record<string, unknown> = {}, ideas: unknown = { metricRequired: true }) => ({ rules: { reports: { fiscalYearStartMonth: 1, kinds }, ideas }, canEdit: false });
  const on = { enabled: true, aiDrafting: true, freezeAt: "create", content: { narrative: { max: null } } };

  it("reads the seed (version 0) the server answers: every kind on, the short two frozen at submit", () => {
    const r = asReportRules({ version: 0, rules: defaults });
    expect(r.fiscalYearStartMonth).toBe(1);
    expect(r.ideas.metricRequired).toBe(true);
    expect(Object.keys(r.kinds)).toEqual(["daily", "weekly", "monthly", "quarterly", "semester", "yearly"]);
    expect(r.kinds.daily).toEqual({ enabled: true, aiDrafting: true, freezeAt: "submit", narrativeMax: 1000 });
    expect(r.kinds.yearly).toMatchObject({ freezeAt: "create", narrativeMax: null });
    expect(offeredTabs(r)).toEqual(["daily", "weekly", "monthly", "quarterly", "semester", "yearly", "other"]);
  });
  it("offers only the kinds the company has on, and Other always", () => {
    const r = asReportRules(body({ daily: { ...on, enabled: false }, monthly: on, weekly: { ...on, enabled: false } }));
    expect(offeredTabs(r)).toEqual(["monthly", "other"]);
  });
  it("a kind drafted by hand says so, and a fiscal year start that is not a month is January", () => {
    const r = asReportRules({ rules: { reports: { fiscalYearStartMonth: 13, kinds: { monthly: { ...on, aiDrafting: false } } } } });
    expect(r.kinds.monthly?.aiDrafting).toBe(false);
    expect(r.fiscalYearStartMonth).toBe(1);
    expect(r.ideas.metricRequired).toBe(true); // absent: the stricter rule
  });
  it("throws on a body that is not the rules, and without them offers the monthly report and Other only", () => {
    expect(() => asReportRules({})).toThrow();
    expect(() => asReportRules({ rules: { reports: {} } })).toThrow();
    expect(offeredTabs(null)).toEqual(["monthly", "other"]);
  });
  it("shows the kind asked for when it is offered, else the monthly report, else the first", () => {
    expect(chosenTab("weekly", ["weekly", "monthly", "other"])).toBe("weekly");
    expect(chosenTab("daily", ["weekly", "monthly", "other"])).toBe("monthly");
    expect(chosenTab(null, ["weekly", "other"])).toBe("weekly");
    expect(chosenTab(null, [])).toBe("other");
  });
});
