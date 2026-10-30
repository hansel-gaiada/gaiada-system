// SCP-5 W5-A2 — the periodic report kinds, pure (BFF §63.24.1 to §63.24.4, §63.30): what each kind's own rules make of a report: its
// period (accepted and refused), its due day, its content and what the HoD check needs, its short draft, the facts a short report
// adds, and the items Needs you and the dashboard draw. No database: runs anywhere. The same claims run on real Postgres and Cerbos
// in social-reports-periodic.http.test.ts.
import { describe, expect, it } from "vitest";
import { deliveredReportTitle } from "../../core/client-reports";
import { periodicWhen } from "../../core/report-period-label";
import { parseAllocationPatch } from "./pipeline/allocation.controller";
import { DEFAULT_RULES, enabledReportKinds, reportKindRules, type PeriodicKind, type RulesDoc } from "./pipeline/rules";
import {
  CHECK_CODE, PERIOD_SHAPE_RE, REPORT_KINDS, buildShortReportDraftPrompt, contentOf, dueOf, isLiveWhile, nextRangeOf, notesCheckPasses,
  parseShortReportDraft, resolvePeriod, shortKindGrounding, templateNextLine, unmetCheck, validateEdit, type ShortDraftContext,
} from "./report-kinds";
import { candidatePeriods, pickDuePeriod } from "./report-periodic-due";
import { periodicAttention } from "./pipeline/team";
import { periodDateRange, withShortKindFacts, buildSocialReportDocument, buildSocialReportSnapshot } from "./reports";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const content = (kind: PeriodicKind, rules: RulesDoc = DEFAULT_RULES) => contentOf(kind, reportKindRules(rules, kind));
const NOTES = {
  followers: { insight: "Up.", suggestion: "Keep going." }, engagement: { insight: "Steady.", suggestion: "Reply." }, audience: { insight: "Local.", suggestion: "Lunch." },
};

describe("the kinds as seeded (BFF §63.24.1's table)", () => {
  it("daily and weekly: a summary of at most 1,000 and a next-period line, live until submit, the check needs the summary", () => {
    for (const k of ["daily", "weekly"] as const) {
      expect(content(k)).toMatchObject({
        periodic: true, narrativeMax: 1000, nextPeriodLine: true, areas: [], actionPlan: { enabled: false }, freezeAt: "submit",
        checkRequires: ["narrative"], aiDrafting: true,
      });
    }
  });
  it("monthly, quarterly, semester and yearly: the narrative, the three notes and an action plan of ten, frozen at create, the check needs the notes", () => {
    for (const k of ["monthly", "quarterly", "semester", "yearly"] as const) {
      expect(content(k)).toMatchObject({
        periodic: true, narrativeMax: null, nextPeriodLine: false, actionPlan: { enabled: true, max: 10 }, freezeAt: "create", checkRequires: ["notes"],
      });
      expect(content(k).areas.map((a) => a.key)).toEqual(["followers", "engagement", "audience"]);
    }
  });
  it("campaign and ad hoc are SMM-23's own: any of the three notes and ten actions, nothing required", () => {
    expect(contentOf("campaign", null)).toMatchObject({ periodic: false, checkRequires: [], nextPeriodLine: false, freezeAt: "create", aiDrafting: true });
    expect(contentOf("adhoc", null).areas.map((a) => a.key)).toEqual(["followers", "engagement", "audience"]);
  });
  it("a next-period line exists on the short kinds only: the column does, whatever another kind's rules say", () => {
    const rules = clone(DEFAULT_RULES);
    rules.reports.kinds.quarterly.content.nextPeriodLine = true;
    expect(content("quarterly", rules).nextPeriodLine).toBe(false);
    rules.reports.kinds.daily.checkRequires = ["narrative", "nextPeriodLine"];
    expect(content("daily", rules).checkRequires).toEqual(["narrative", "nextPeriodLine"]);
    rules.reports.kinds.quarterly.checkRequires = ["notes", "nextPeriodLine"] as never;
    expect(content("quarterly", rules).checkRequires).toEqual(["notes"]);
  });
  it("the kinds are the eight", () => {
    expect([...REPORT_KINDS]).toEqual(["daily", "weekly", "monthly", "quarterly", "semester", "yearly", "campaign", "adhoc"]);
    expect(enabledReportKinds(DEFAULT_RULES)).toHaveLength(6);
  });
});

describe("a new report's period, per kind: the format accepted and refused, a real date or week, not in the future, and ended when frozen at create", () => {
  const TODAY = "2026-11-20";
  const ok = (kind: PeriodicKind, period: unknown, freeze = false, today = TODAY, fy = 1) => resolvePeriod(kind, period, fy, today, freeze);
  const bad = (kind: PeriodicKind, period: unknown, code: string, freeze = false, today = TODAY, fy = 1) =>
    expect(ok(kind, period, freeze, today, fy), `${kind} ${String(period)}`).toEqual({ ok: false, code });

  it("daily: YYYY-MM-DD, a real day, today at the latest", () => {
    expect(ok("daily", "2026-11-09")).toEqual({ ok: true, range: { start: "2026-11-09", end: "2026-11-09" } });
    expect(ok("daily", TODAY).ok).toBe(true); // today: the day is still going, its numbers live until submit
    for (const p of ["2026-02-30", "2026-13-01", "26-11-09", "2026-11-9", "2026-11", "", null, 20261109]) bad("daily", p, "invalid_field");
    bad("daily", "2026-11-21", "invalid_field"); // the future
    bad("daily", TODAY, "period_not_over", true); // frozen at create: the day must have ended
  });
  it("weekly: ISO YYYY-Www, Monday to Sunday, a week 53 only where the year has one", () => {
    expect(ok("weekly", "2026-W46")).toEqual({ ok: true, range: { start: "2026-11-09", end: "2026-11-15" } });
    expect(ok("weekly", "2026-W47").ok).toBe(true); // the week still going
    bad("weekly", "2026-W47", "period_not_over", true);
    for (const p of ["2026-W00", "2026-W54", "2026-W1", "2026W46", "2026-w46", "2026-46"]) bad("weekly", p, "invalid_field");
    bad("weekly", "2026-W48", "invalid_field"); // starts after today
    expect(ok("weekly", "2026-W53", false, "2027-01-15")).toEqual({ ok: true, range: { start: "2026-12-28", end: "2027-01-03" } });
    bad("weekly", "2025-W53", "invalid_field", false, "2027-01-15"); // 2025 has 52 weeks
  });
  it("quarterly: YYYY-Qn, three months; the current quarter is not over", () => {
    expect(ok("quarterly", "2026-Q3", true)).toEqual({ ok: true, range: { start: "2026-07-01", end: "2026-09-30" } });
    bad("quarterly", "2026-Q4", "period_not_over", true);
    for (const p of ["2026-Q5", "2026-Q0", "2026-Q", "2026Q1", "2026-q1"]) bad("quarterly", p, "invalid_field", true);
    bad("quarterly", "2027-Q1", "invalid_field", true);
  });
  it("semester: YYYY-Hn, January to June or July to December", () => {
    expect(ok("semester", "2026-H1", true)).toEqual({ ok: true, range: { start: "2026-01-01", end: "2026-06-30" } });
    bad("semester", "2026-H2", "period_not_over", true);
    for (const p of ["2026-H3", "2026-H0", "2026-1"]) bad("semester", p, "invalid_field", true);
  });
  it("yearly: YYYY, the calendar year; this year is not over", () => {
    expect(ok("yearly", "2025", true)).toEqual({ ok: true, range: { start: "2025-01-01", end: "2025-12-31" } });
    bad("yearly", "2026", "period_not_over", true);
    for (const p of ["26", "20260", "2026-", "abcd"]) bad("yearly", p, "invalid_field", true);
  });
  it("a fiscal year starting in April makes Q1 April to June and the year April to March, named by the year it starts in", () => {
    expect(ok("quarterly", "2026-Q1", true, TODAY, 4)).toEqual({ ok: true, range: { start: "2026-04-01", end: "2026-06-30" } });
    expect(ok("yearly", "2025", true, TODAY, 4)).toEqual({ ok: true, range: { start: "2025-04-01", end: "2026-03-31" } });
    bad("yearly", "2026", "period_not_over", true, TODAY, 4);
    expect(ok("semester", "2026-H1", true, TODAY, 4)).toEqual({ ok: true, range: { start: "2026-04-01", end: "2026-09-30" } });
  });
  it("the list's period filter takes every form's shape", () => {
    for (const p of ["2026-11-09", "2026-W46", "2026-11", "2026-Q4", "2026-H2", "2026"]) expect(PERIOD_SHAPE_RE.test(p), p).toBe(true);
    for (const p of ["2026-13", "2026-Q5", "2026-H3", "26", "2026-11-9", "latest"]) expect(PERIOD_SHAPE_RE.test(p), p).toBe(false);
  });
  it("periodDateRange learns every form when told the kind, and is as SCP-5a built it when not", () => {
    expect(periodDateRange("2026-Q4", new Date("2026-11-20"), { kind: "quarterly" })).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    expect(periodDateRange("2026-W46", new Date("2026-11-20"), { kind: "weekly" })).toEqual({ start: "2026-11-09", end: "2026-11-15" });
    expect(periodDateRange("2026-09", new Date("2026-11-20"))).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(periodDateRange("2026-Q4", new Date("2026-11-20"))).toEqual({ start: "2026-10-21", end: "2026-11-20" }); // a campaign's: the trailing 30 days
  });
  it("the range after a short report's period: the next day, the next Monday to Sunday", () => {
    expect(nextRangeOf("daily", { start: "2026-11-09", end: "2026-11-09" })).toEqual({ range: { start: "2026-11-10", end: "2026-11-10" }, label: "day" });
    expect(nextRangeOf("weekly", { start: "2026-11-09", end: "2026-11-15" })).toEqual({ range: { start: "2026-11-16", end: "2026-11-22" }, label: "week" });
    expect(nextRangeOf("monthly", { start: "2026-10-01", end: "2026-10-31" })).toBeNull();
  });
});

describe("the due day, per kind, by the report's own rules (a golden table)", () => {
  const rules = (kind: PeriodicKind, over: Partial<{ fiscalYearStartMonth: number }> = {}) => ({
    fiscalYearStartMonth: over.fiscalYearStartMonth ?? 1, due: content(kind).due,
  });
  const none = { reportDueDay: null, calendar: {} };
  it("daily and weekly: the first working day after the period", () => {
    expect(dueOf("daily", "2026-11-06", rules("daily"), none)).toBe("2026-11-09"); // a Friday: the Monday
    expect(dueOf("daily", "2026-11-09", rules("daily"), none)).toBe("2026-11-10");
    expect(dueOf("weekly", "2026-W46", rules("weekly"), none)).toBe("2026-11-16");
  });
  it("a holiday after a daily, and a holiday Monday after a week, push the day on", () => {
    const calendar = { holidays: [{ day: "2026-11-09", kind: "public" as const }] };
    expect(dueOf("daily", "2026-11-06", rules("daily"), { reportDueDay: null, calendar })).toBe("2026-11-10");
    const monday = { holidays: [{ day: "2026-11-16", kind: "public" as const }] };
    expect(dueOf("weekly", "2026-W46", rules("weekly"), { reportDueDay: null, calendar: monday })).toBe("2026-11-17");
  });
  it("the long kinds: the client's report_due_day of the month after the period; none without one", () => {
    const ten = { reportDueDay: 10, calendar: {} };
    expect(dueOf("monthly", "2026-09", rules("monthly"), ten)).toBe("2026-10-10");
    expect(dueOf("quarterly", "2026-Q4", rules("quarterly"), ten)).toBe("2027-01-10"); // a quarter's turn into the next year
    expect(dueOf("semester", "2026-H2", rules("semester"), ten)).toBe("2027-01-10");
    expect(dueOf("yearly", "2026", rules("yearly"), ten)).toBe("2027-01-10"); // a year's turn
    expect(dueOf("quarterly", "2026-Q2", rules("quarterly"), { reportDueDay: 31, calendar: {} })).toBe("2026-07-31");
    expect(dueOf("quarterly", "2026-Q3", rules("quarterly"), { reportDueDay: 31, calendar: {} })).toBe("2026-10-31");
    expect(dueOf("quarterly", "2026-Q4", rules("quarterly"), none)).toBeNull(); // no report_due_day: no due day
    expect(dueOf("yearly", "2026", rules("yearly"), none)).toBeNull();
  });
  it("a fiscal year from April: Q1 (April to June) falls due in July", () => {
    expect(dueOf("quarterly", "2026-Q1", rules("quarterly", { fiscalYearStartMonth: 4 }), { reportDueDay: 5, calendar: {} })).toBe("2026-07-05");
    expect(dueOf("yearly", "2025", rules("yearly", { fiscalYearStartMonth: 4 }), { reportDueDay: 5, calendar: {} })).toBe("2026-04-05");
  });
  it("campaign, ad hoc and a malformed legacy period have none", () => {
    expect(dueOf("campaign", "2026-09", { fiscalYearStartMonth: 1, due: null }, none)).toBeNull();
    expect(dueOf("monthly", "not-a-month", rules("monthly"), { reportDueDay: 5, calendar: {} })).toBeNull();
    expect(dueOf("monthly", null, rules("monthly"), { reportDueDay: 5, calendar: {} })).toBeNull();
  });
});

describe("editing: the report's own rules decide the parts and their limits", () => {
  it("a daily or weekly report takes a summary and a next-period line; notes and an action plan are 400 {field}", () => {
    const c = content("daily");
    expect(validateEdit(c, { narrativeMd: "A good day.", nextPeriod: "Tomorrow: a reel." })).toEqual({ ok: true, value: { narrativeMd: "A good day.", nextPeriod: "Tomorrow: a reel." } });
    expect(validateEdit(c, { nextPeriod: null })).toEqual({ ok: true, value: { nextPeriod: null } });
    expect(validateEdit(c, { notes: NOTES })).toEqual({ ok: false, field: "notes" });
    expect(validateEdit(c, { notes: {} })).toEqual({ ok: false, field: "notes" }); // not even an empty one
    expect(validateEdit(c, { actionPlan: [] })).toEqual({ ok: false, field: "actionPlan" });
    expect(validateEdit(c, { narrativeMd: "x".repeat(1001) })).toEqual({ ok: false, field: "narrativeMd" });
    expect(validateEdit(c, { narrativeMd: "x".repeat(1000) }).ok).toBe(true);
    expect(validateEdit(c, { nextPeriod: "x".repeat(1001) })).toEqual({ ok: false, field: "nextPeriod" });
    expect(validateEdit(c, { nextPeriod: 5 })).toEqual({ ok: false, field: "nextPeriod" });
    expect(validateEdit(c, { narrativeMd: 5 })).toEqual({ ok: false, field: "narrativeMd" });
  });
  it("a long kind takes the narrative, the notes and the plan, and no next-period line; the monthly's shapes are SCP-5a's", () => {
    for (const k of ["monthly", "quarterly", "semester", "yearly"] as const) {
      const c = content(k);
      expect(validateEdit(c, { notes: NOTES, actionPlan: [{ action: "Plan.", owner: "agency" }], narrativeMd: "x".repeat(5000) }).ok, k).toBe(true);
      expect(validateEdit(c, { nextPeriod: "tomorrow" }), k).toEqual({ ok: false, field: "nextPeriod" });
      expect(validateEdit(c, { notes: { reach: { insight: "x", suggestion: "y" } } }), k).toEqual({ ok: false, field: "notes" });
      expect(validateEdit(c, { notes: { followers: { insight: "x".repeat(501), suggestion: "y" } } }), k).toEqual({ ok: false, field: "notes" });
      expect(validateEdit(c, { actionPlan: Array.from({ length: 11 }, () => ({ action: "x", owner: "agency" })) }), k).toEqual({ ok: false, field: "actionPlan" });
    }
  });
  it("the first bad part is named, in the order narrative, notes, action plan, next period", () => {
    expect(validateEdit(content("monthly"), { notes: [], actionPlan: {}, narrativeMd: 1 })).toEqual({ ok: false, field: "narrativeMd" });
    expect(validateEdit(content("monthly"), { notes: [], actionPlan: {} })).toEqual({ ok: false, field: "notes" });
  });
  it("a company's own areas and limits apply to the reports made under them", () => {
    const rules = clone(DEFAULT_RULES);
    rules.reports.kinds.quarterly.content.notes.areas = [{ key: "reach", label: "Reach" }, { key: "sales", label: "Sales" }];
    rules.reports.kinds.quarterly.content.actionPlan.max = 2;
    rules.reports.kinds.quarterly.content.narrative.max = 200;
    const c = content("quarterly", rules);
    const notes = { reach: { insight: "a", suggestion: "b" }, sales: { insight: "c", suggestion: "d" } };
    expect(validateEdit(c, { notes }).ok).toBe(true);
    expect(validateEdit(c, { notes: NOTES })).toEqual({ ok: false, field: "notes" }); // the three of the default are not its areas
    expect(validateEdit(c, { actionPlan: [1, 2, 3].map((n) => ({ action: `a${n}`, owner: "agency" })) })).toEqual({ ok: false, field: "actionPlan" });
    expect(validateEdit(c, { narrativeMd: "x".repeat(201) })).toEqual({ ok: false, field: "narrativeMd" });
  });
});

describe("the HoD check needs what the report's rules name, one refusal per part", () => {
  const row = (o: Partial<{ narrativeMd: string; notes: unknown; actionPlan: unknown[]; nextPeriod: string | null }> = {}) =>
    ({ narrativeMd: "", notes: {}, actionPlan: [], nextPeriod: null, ...o });
  it("summary_missing binds the short kinds, and only them", () => {
    for (const k of ["daily", "weekly"] as const) {
      expect(unmetCheck(content(k), row()), k).toBe("summary_missing");
      expect(unmetCheck(content(k), row({ narrativeMd: "   " })), k).toBe("summary_missing");
      expect(unmetCheck(content(k), row({ narrativeMd: "A day." })), k).toBeNull(); // no next-period line needed by default
    }
    for (const k of ["monthly", "quarterly", "semester", "yearly"] as const) expect(unmetCheck(content(k), row({ notes: NOTES })), k).toBeNull();
    expect(unmetCheck(contentOf("campaign", null), row()), "campaign").toBeNull();
  });
  it("notes_incomplete binds the long kinds, and only them", () => {
    for (const k of ["monthly", "quarterly", "semester", "yearly"] as const) {
      expect(unmetCheck(content(k), row({ narrativeMd: "x" })), k).toBe("notes_incomplete");
      expect(unmetCheck(content(k), row({ narrativeMd: "x", notes: { ...NOTES, audience: { insight: "Local.", suggestion: " " } } })), k).toBe("notes_incomplete");
      expect(unmetCheck(content(k), row({ notes: NOTES })), k).toBeNull(); // a long kind's summary is not required
    }
    expect(unmetCheck(content("daily"), row({ narrativeMd: "x" }))).toBeNull();
    expect(notesCheckPasses(content("daily"), {})).toBe(true);
    expect(notesCheckPasses(content("monthly"), {})).toBe(false);
    expect(notesCheckPasses(content("monthly"), NOTES)).toBe(true);
    expect(notesCheckPasses(contentOf("campaign", null), {})).toBe(true);
  });
  it("action_plan_missing and next_period_missing when a company's rules ask, in the order narrative, notes, plan, line", () => {
    const rules = clone(DEFAULT_RULES);
    rules.reports.kinds.weekly.checkRequires = ["narrative", "nextPeriodLine"];
    rules.reports.kinds.yearly.checkRequires = ["notes", "actionPlan"];
    expect(unmetCheck(content("weekly", rules), row({ narrativeMd: "x" }))).toBe("next_period_missing");
    expect(unmetCheck(content("weekly", rules), row())).toBe("summary_missing");
    expect(unmetCheck(content("weekly", rules), row({ narrativeMd: "x", nextPeriod: "Next week: a reel." }))).toBeNull();
    expect(unmetCheck(content("yearly", rules), row({ notes: NOTES }))).toBe("action_plan_missing");
    expect(unmetCheck(content("yearly", rules), row({ notes: NOTES, actionPlan: [{}] }))).toBeNull();
    expect(CHECK_CODE).toEqual({ narrative: "summary_missing", notes: "notes_incomplete", actionPlan: "action_plan_missing", nextPeriodLine: "next_period_missing" });
  });
  it("an added notes area is required by the check", () => {
    const rules = clone(DEFAULT_RULES);
    rules.reports.kinds.monthly.content.notes.areas.push({ key: "sales", label: "Sales" });
    expect(unmetCheck(content("monthly", rules), row({ notes: NOTES }))).toBe("notes_incomplete");
    expect(unmetCheck(content("monthly", rules), row({ notes: { ...NOTES, sales: { insight: "Up.", suggestion: "More." } } }))).toBeNull();
  });
  it("numbers are live only for a draft whose rules freeze them at submit", () => {
    expect(isLiveWhile(content("daily"), "draft")).toBe(true);
    expect(isLiveWhile(content("daily"), "in_review")).toBe(false);
    expect(isLiveWhile(content("monthly"), "draft")).toBe(false);
    const rules = clone(DEFAULT_RULES);
    rules.reports.kinds.monthly.freezeAt = "submit";
    expect(isLiveWhile(content("monthly", rules), "draft")).toBe(true);
  });
});

describe("a short report's snapshot adds the client's approvals, the best post and what comes next", () => {
  const base = buildSocialReportSnapshot({ rangeStart: "2026-11-09", rangeEnd: "2026-11-09", daily: [], posts: [], postsPublishedInPeriod: 0, kpiTargets: [] });
  const withFacts = withShortKindFacts(base, {
    approvedPosts: 2,
    bestPost: { title: "Behind the scenes", network: "instagram", publishedAt: "2026-11-09 10:00:00+00", reach: 1234 },
    nextPosts: [{ postId: "p1", title: "Mock launch reel", format: "reel", scheduledAt: "2026-11-10T09:00:00.000Z", phase: "with_client", phaseLabel: "With client" }],
    nextLabel: "day",
  });
  it("a real count of approvals (0 too), a best_post table, a next_period table with the post's id and phase, and the counts", () => {
    expect(withFacts.kpis.find((k) => k.metricKey === "posts_approved_period")).toMatchObject({ label: "Posts approved by the client", value: 2 });
    expect(withFacts.tables.find((t) => t.key === "best_post")?.rows).toEqual([{ post: "Behind the scenes", network: "instagram", publishedAt: "2026-11-09 10:00:00+00", reach: 1234 }]);
    expect(withFacts.tables.find((t) => t.key === "next_period")?.rows).toEqual([
      { postId: "p1", title: "Mock launch reel", format: "reel", scheduledAt: "2026-11-10T09:00:00.000Z", phase: "with_client", phaseLabel: "With client" },
    ]);
    expect(withFacts.shortKind).toEqual({ approvedPosts: 2, nextPosts: 1, nextLabel: "day", bestPostReach: 1234 });
    const zero = withShortKindFacts(base, { approvedPosts: 0, bestPost: null, nextPosts: [], nextLabel: "week" });
    expect(zero.kpis.find((k) => k.metricKey === "posts_approved_period")?.value).toBe(0); // zero approved is a fact
    expect(zero.tables.map((t) => t.key)).toEqual([]);
    expect(zero.shortKind).toEqual({ approvedPosts: 0, nextPosts: 0, nextLabel: "week", bestPostReach: null });
    expect(base.shortKind, "the input is not changed").toBeUndefined();
  });
  it("the facts a draft may state, and what the prompt says about them", () => {
    const g = shortKindGrounding(withFacts)!;
    expect(g.kpis).toEqual([{ label: "Posts scheduled for the next day", value: 1, unit: "count" }, { label: "Best post reach", value: 1234, unit: "count" }]);
    expect(g.lines.join("\n")).toContain('Best post by reach this period: "Behind the scenes" (instagram), reach 1234.');
    expect(g.lines.join("\n")).toContain('- "Mock launch reel" (reel, 2026-11-10T09:00:00.000Z)');
    expect(shortKindGrounding(base)).toBeNull();
  });
  it("the document prints the next-period line under the summary, and the monthly's carries none", () => {
    const doc = buildSocialReportDocument({
      tenantId: "t", engagementId: "e", clientName: "Mock Client", kind: "daily", period: "2026-11-09", status: "approved", frozen: withFacts,
      narrativeText: "A good day.", generatedAt: "2026-11-10T00:00:00Z", nextPeriod: "Tomorrow: a reel.",
    });
    expect(doc.narrative.text).toBe("A good day.\n\nNext day: Tomorrow: a reel.");
    expect(doc.header).toMatchObject({ periodLabel: "9 Nov 2026", periodStart: "2026-11-09", periodEnd: "2026-11-09" });
    expect(doc.tables.map((t) => t.key)).toEqual(expect.arrayContaining(["best_post", "next_period"]));
    const monthly = buildSocialReportDocument({
      tenantId: "t", engagementId: "e", clientName: "Mock Client", kind: "monthly", period: "2026-09", status: "approved", frozen: base,
      narrativeText: "A month.", generatedAt: "2026-11-10T00:00:00Z", nextPeriod: null,
    });
    expect(monthly.narrative.text).toBe("A month.");
    expect(monthly.header.periodLabel).toBe("September 2026");
  });
});

describe("a short report's draft: a summary and a next-period line, one source", () => {
  const facts = {
    engagementName: "Eng", clientName: "Client", periodLabel: "2026-11-09 – 2026-11-09",
    kpis: [{ label: "Posts published", value: 2, unit: "count" }, { label: "Posts scheduled for the next day", value: 1, unit: "count" }],
    topPosts: [], knowledgeHits: [],
  };
  const ctx: ShortDraftContext = {
    kind: "daily", narrativeMax: 1000, nextPeriodLine: true, extraLines: ["No posts are scheduled yet."], nextLabel: "day", nextPosts: 1, nextTitles: ["Launch reel"],
  };
  const answer = (o: Record<string, unknown>) => JSON.stringify({ narrative: "Two posts went out today.", nextPeriod: "One post is scheduled tomorrow.", ...o });
  it("the prompt asks for the two parts as strict JSON, grounded", () => {
    const p = buildShortReportDraftPrompt(facts, ctx);
    expect(p).toContain("Posts published: 2 count");
    expect(p).toContain("short summary for the client of how the day went (at most 1000 characters) and one line about what comes next day");
    expect(p).toContain('{"narrative": "...", "nextPeriod": "..."}');
    expect(buildShortReportDraftPrompt(facts, { ...ctx, nextPeriodLine: false, narrativeMax: null, kind: "weekly", nextLabel: "week" })).toContain('{"narrative": "..."}');
  });
  it("a good answer is the model's", () => {
    expect(parseShortReportDraft(answer({}), facts, ctx)).toEqual({ narrativeMd: "Two posts went out today.", nextPeriod: "One post is scheduled tomorrow.", draftedVia: "ai" });
  });
  it("an invented number, a missing or over-long part, malformed JSON and no answer all give the whole template", () => {
    for (const [raw, why] of [
      [answer({ narrative: "Grew by 4321 today." }), "an invented number in the summary"],
      [answer({ nextPeriod: "Expect 77 posts tomorrow." }), "an invented number in the line"],
      [answer({ nextPeriod: "" }), "no line"],
      [JSON.stringify({ narrative: "Two posts went out." }), "a missing line"],
      [answer({ narrative: "x ".repeat(600) }), "a summary over the limit"],
      ["not json", "malformed"],
      [null, "no answer"],
    ] as const) {
      const d = parseShortReportDraft(raw, facts, ctx);
      expect(d.draftedVia, why).toBe("template");
      expect(d.nextPeriod, why).toBe('1 post is scheduled for the next day: "Launch reel".');
      expect(d.narrativeMd.length, why).toBeLessThanOrEqual(1000);
    }
  });
  it("a kind with no next-period line drafts none", () => {
    const d = parseShortReportDraft(JSON.stringify({ narrative: "Two posts went out today." }), facts, { ...ctx, nextPeriodLine: false });
    expect(d).toEqual({ narrativeMd: "Two posts went out today.", nextPeriod: null, draftedVia: "ai" });
  });
  it("the template's line states only what the pipeline holds", () => {
    expect(templateNextLine({ nextLabel: "week", nextPosts: 0, nextTitles: [] })).toBe("Nothing is scheduled yet for the next week.");
    expect(templateNextLine({ nextLabel: "week", nextPosts: 4, nextTitles: ["A", "B", "C", "D"] })).toBe('4 posts are scheduled for the next week: "A", "B", "C".');
  });
  it("the template is cut to the summary's limit at a word, never inside a number", () => {
    const k = [{ label: "Reach", value: 123456, unit: "count" }, { label: "Impressions", value: 987654, unit: "count" }];
    const full = parseShortReportDraft(null, { ...facts, kpis: k }, { ...ctx, narrativeMax: null }).narrativeMd;
    for (const max of [40, 60, 75, 90]) {
      const cut = parseShortReportDraft(null, { ...facts, kpis: k }, { ...ctx, narrativeMax: max }).narrativeMd;
      expect(cut.length, `max ${max}`).toBeLessThanOrEqual(max);
      expect(full.startsWith(cut), `max ${max}`).toBe(true);
      expect(full.charAt(cut.length) === "" || /\s/.test(full.charAt(cut.length)), `max ${max}: cut at a word`).toBe(true);
    }
  });
});

describe("what is due: the period looked at, and the items Needs you and the dashboard draw", () => {
  const none = { reportDueDay: null, calendar: {} };
  const dueRule = (k: PeriodicKind) => reportKindRules(DEFAULT_RULES, k).due;
  it("a weekly report is due from its due day; the dashboard shows it from the day after", () => {
    // Week 46 (9 to 15 Nov) is due Monday the 16th.
    expect(pickDuePeriod("weekly", "2026-11-15", 1, dueRule("weekly"), none, "reached")).toEqual({ period: "2026-W45", due: "2026-11-09" }); // before: last week's
    expect(pickDuePeriod("weekly", "2026-11-16", 1, dueRule("weekly"), none, "reached")).toEqual({ period: "2026-W46", due: "2026-11-16" });
    expect(pickDuePeriod("weekly", "2026-11-16", 1, dueRule("weekly"), none, "after")).toEqual({ period: "2026-W45", due: "2026-11-09" });
    expect(pickDuePeriod("weekly", "2026-11-17", 1, dueRule("weekly"), none, "after")).toEqual({ period: "2026-W46", due: "2026-11-16" });
  });
  it("a daily report over a weekend: the latest period whose due day has come", () => {
    expect(pickDuePeriod("daily", "2026-11-09", 1, dueRule("daily"), none, "reached")).toEqual({ period: "2026-11-08", due: "2026-11-09" }); // Sunday's (Friday's and Saturday's are due Monday too)
    expect(pickDuePeriod("daily", "2026-11-07", 1, dueRule("daily"), none, "reached")).toEqual({ period: "2026-11-05", due: "2026-11-06" }); // Saturday: Thursday's (Fri's is due Monday)
  });
  it("a long kind with no report_due_day is never due; with one, from that day of the month after", () => {
    expect(pickDuePeriod("quarterly", "2027-01-20", 1, dueRule("quarterly"), none, "reached")).toBeNull();
    const ten = { reportDueDay: 10, calendar: {} };
    expect(pickDuePeriod("quarterly", "2027-01-09", 1, dueRule("quarterly"), ten, "reached")).toEqual({ period: "2026-Q3", due: "2026-10-10" });
    expect(pickDuePeriod("quarterly", "2027-01-10", 1, dueRule("quarterly"), ten, "reached")).toEqual({ period: "2026-Q4", due: "2027-01-10" });
    expect(pickDuePeriod("yearly", "2027-01-10", 1, dueRule("yearly"), ten, "reached")).toEqual({ period: "2026", due: "2027-01-10" });
    expect(pickDuePeriod("semester", "2026-07-10", 1, dueRule("semester"), ten, "reached")).toEqual({ period: "2026-H1", due: "2026-07-10" });
  });
  it("the candidate periods are the current one and the four before it", () => {
    expect(candidatePeriods("quarterly", "2026-11-20", 1).map((c) => c.period)).toEqual(["2026-Q4", "2026-Q3", "2026-Q2", "2026-Q1", "2025-Q4"]);
    expect(candidatePeriods("weekly", "2026-11-20", 1)).toHaveLength(5);
  });
  it("the dashboard's item is a report_due with its reportKind, from the day after the due day", () => {
    const items = periodicAttention([
      { engagementId: "e1", clientName: "Alpha", reportDueDay: null, kind: "weekly", period: "2026-W46", due: "2026-11-16", reportId: null, reportStatus: null },
      { engagementId: "e2", clientName: "Beta", reportDueDay: 10, kind: "quarterly", period: "2026-Q4", due: "2027-01-10", reportId: "r2", reportStatus: "draft" },
    ]);
    expect(items).toEqual([
      { kind: "report_due", reportKind: "weekly", engagementId: "e1", clientName: "Alpha", title: "Weekly report 2026-W46", since: "2026-11-17" },
      { kind: "report_due", reportKind: "quarterly", reportId: "r2", engagementId: "e2", clientName: "Beta", title: "Quarterly report 2026-Q4", since: "2027-01-11" },
    ]);
    expect("reportId" in items[0]).toBe(false); // omitted, not null
  });
});

describe("the title a delivered report is published under", () => {
  it("names each kind (the contract's examples)", () => {
    expect(deliveredReportTitle("social_report", "daily", "2026-11-09", "2026-11-09", "2026-11-09")).toBe("Daily report, 9 Nov 2026");
    expect(deliveredReportTitle("social_report", "weekly", "2026-W46", "2026-11-09", "2026-11-15")).toBe("Weekly report, 9 to 15 Nov 2026");
    expect(deliveredReportTitle("social_report", "weekly", "2026-W45", "2026-10-26", "2026-11-01")).toBe("Weekly report, 26 Oct to 1 Nov 2026");
    expect(deliveredReportTitle("social_report", "weekly", "2026-W53", "2026-12-28", "2027-01-03")).toBe("Weekly report, 28 Dec 2026 to 3 Jan 2027");
    expect(deliveredReportTitle("social_report", "quarterly", "2026-Q4", "2026-10-01", "2026-12-31")).toBe("Quarterly report, Q4 2026");
    expect(deliveredReportTitle("social_report", "semester", "2026-H2", "2026-07-01", "2026-12-31")).toBe("Half-year report, H2 2026");
    expect(deliveredReportTitle("social_report", "yearly", "2026", "2026-01-01", "2026-12-31")).toBe("Yearly report, 2026");
  });
  it("the monthly, campaign, ad hoc and search titles are as before", () => {
    expect(deliveredReportTitle("social_report", "monthly", "2026-09", "2026-09-01", "2026-09-30")).toBe("Social media report, September 2026");
    expect(deliveredReportTitle("social_report", "campaign", "2026-09", "2026-09-01", "2026-09-30")).toBe("Social media campaign report, September 2026");
    expect(deliveredReportTitle("social_report", "adhoc", null, "2026-10-01", "2026-10-30")).toBe("Social media report, 2026-10-01 to 2026-10-30");
    expect(deliveredReportTitle("search_report", "audit", "2026-09", "2026-09-01", "2026-09-30")).toBe("Search audit report, September 2026");
    expect(periodicWhen("daily", "garbage", "", "")).toBeNull();
  });
});

describe("the allocation's reportKinds (BFF §63.24.4): de-duplicated in the route, the five kinds only", () => {
  it("accepts the five periodic kinds, once each, in the order sent", () => {
    expect(parseAllocationPatch({ reportKinds: ["weekly", "daily", "weekly", "daily"] }).reportKinds).toEqual(["weekly", "daily"]);
    expect(parseAllocationPatch({ reportKinds: [] }).reportKinds).toEqual([]);
    expect(parseAllocationPatch({ reportKinds: ["daily", "weekly", "quarterly", "semester", "yearly"] }).reportKinds).toHaveLength(5);
    expect(parseAllocationPatch({ reportKinds: Array.from({ length: 12 }, () => "daily") }).reportKinds).toEqual(["daily"]);
  });
  it("refuses the monthly (every client's), campaign, anything else and a non-array: 400 invalid_field {reportKinds}", () => {
    for (const bad of [["monthly"], ["campaign"], ["hourly"], ["daily", 3], "daily", null, {}, Array.from({ length: 51 }, () => "daily")]) {
      try {
        parseAllocationPatch({ reportKinds: bad });
        throw new Error(`expected ${JSON.stringify(bad).slice(0, 40)} to be refused`);
      } catch (e) {
        expect((e as { getResponse?: () => unknown }).getResponse?.()).toMatchObject({ message: "invalid_field", field: "reportKinds" });
      }
    }
  });
});
