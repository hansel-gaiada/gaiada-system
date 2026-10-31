import { describe, it, expect } from "vitest";
import fixture from "./scpStageMachine.json";
import seed from "./socialRulesDefaults.json";
import { REFUSAL_WORDS } from "./socialPipeline";
import { PLAN_REFUSAL_REASON } from "./socialCycles";
import {
  RULES_SECTIONS, asHistory, asPreview, asRulesAnswer, autoCloseFor, checkPartOn, cloneJson, diffRows, diffRules, dueChoices, dueFor, dueRuleWords, fieldWords, historyWords,
  invalidFieldWords, moveItem, newBand, newCategory, newDimension, newStep, previewBody, pruneCheck, rulesRefusalText, sameJson, slugKey, stepDueFor, valueWords, type RulesDoc,
} from "./socialRules";

// SCP-5 W5-C5 (BFF §63.30): the rules' parsers, words and the pure helpers the editors share. The document under test is the seed twin itself.
const { _about: _a, defaultsVersion, ...DOC } = seed as unknown as { _about: string; defaultsVersion: string } & RulesDoc;
const doc = (): RulesDoc => cloneJson(DOC as RulesDoc);
const section = (over: Record<string, unknown> = {}) => ({ changed: false, version: 0, editedBy: null, effectiveFrom: null, ...over });
const answer = (over: Record<string, unknown> = {}) => ({
  version: 0, defaultsVersion, rules: doc(), defaults: doc(), canEdit: true, sections: Object.fromEntries(RULES_SECTIONS.map((s) => [s, section()])), ...over,
});

describe("asRulesAnswer", () => {
  it("reads the seed as version 0 with the defaults beside it", () => {
    const a = asRulesAnswer(answer());
    expect(a.version).toBe(0);
    expect(a.defaultsVersion).toBe("scp5-2026-10-30");
    expect(a.rules.reports.kinds.weekly.due).toEqual({ rule: "working_days_after", n: 1 });
    expect(a.canEdit).toBe(true);
    expect(RULES_SECTIONS.every((s) => a.sections[s].editedBy === null)).toBe(true);
  });
  it("reads who changed a section and when", () => {
    const a = asRulesAnswer(answer({ version: 2, sections: { ...answer().sections, cycle: section({ changed: true, version: 2, editedBy: { id: "u1", name: "Mock Head" }, effectiveFrom: "2026-10-31T01:00:00.000Z" }) } }));
    expect(a.sections.cycle).toEqual({ changed: true, version: 2, editedBy: { id: "u1", name: "Mock Head" }, effectiveFrom: "2026-10-31T01:00:00.000Z" });
  });
  it("takes canEdit only from a true", () => {
    expect(asRulesAnswer(answer({ canEdit: "yes" })).canEdit).toBe(false);
  });
  it("throws on a body that is not the rules, so the page says it cannot tell instead of drawing defaults", () => {
    expect(() => asRulesAnswer(null)).toThrow();
    expect(() => asRulesAnswer({})).toThrow();
    expect(() => asRulesAnswer(answer({ sections: {} }))).toThrow();
    const noWeekly = doc();
    delete (noWeekly.reports.kinds as Record<string, unknown>).weekly;
    expect(() => asRulesAnswer(answer({ rules: noWeekly }))).toThrow(/rules\.reports\.kinds\.weekly/);
    expect(() => asRulesAnswer(answer({ defaults: { ...doc(), saved: {} } }))).toThrow(/defaults\.saved/);
  });
});

describe("asHistory and asPreview", () => {
  it("reads a history page, newest first, with each diff", () => {
    const h = asHistory({
      items: [{ version: 3, section: "cycle", reset: false, editedBy: { id: "u1", name: "Mock Head" }, effectiveFrom: "2026-10-31T01:00:00.000Z", diff: [{ path: "cycle.steps.0.title", from: "A", to: "B" }] }, { version: 2, section: "bogus" }],
      nextCursor: "abc",
    });
    expect(h.items).toHaveLength(1);
    expect(h.items[0].diff).toEqual([{ path: "cycle.steps.0.title", from: "A", to: "B" }]);
    expect(h.nextCursor).toBe("abc");
    expect(() => asHistory({})).toThrow();
  });
  it("reads the three previews, and a part the section has none of as null", () => {
    const p = asPreview({
      section: "reports", engagementId: null, reason: "no_client",
      reports: [{ kind: "daily", enabled: true, period: "2026-10-30", range: { start: "2026-10-30", end: "2026-10-30" }, due: "2026-11-02" }, { kind: "bogus", period: "x" }],
    });
    expect(p.reports).toEqual([{ kind: "daily", enabled: true, period: "2026-10-30", range: { start: "2026-10-30", end: "2026-10-30" }, due: "2026-11-02" }]);
    expect(p.steps).toBeNull();
    expect(p.audit).toBeNull();
    expect(p.reason).toBe("no_client");
    const c = asPreview({ section: "cycle", engagementId: "e1", cycle: { cycleId: "c1", month: "2026-11", readyBy: "2026-10-14" }, steps: [{ key: "a", title: "A", due: null, autoClose: "manual" }] });
    expect(c.cycle?.month).toBe("2026-11");
    expect(c.steps).toEqual([{ key: "a", title: "A", due: null, autoClose: "manual" }]);
    const a = asPreview({ section: "audit", engagementId: "e1", audit: { month: "2026-10", overall: 62, band: "ok", bandLabel: "Okay", scored: 6, total: 12, dimensions: [{ key: "k", label: "K", weight: 1, used: null }] } });
    expect(a.audit).toMatchObject({ overall: 62, bandLabel: "Okay", scored: 6, total: 12 });
    expect(a.audit?.dimensions[0].used).toBeNull();
    expect(asPreview({ section: "audit", engagementId: "e1", audit: null }).audit).toBeNull();
    expect(() => asPreview({ section: "nope" })).toThrow();
  });
});

describe("diffs and words", () => {
  it("diffs like the server: leaves by key and index, whole arrays of different length", () => {
    expect(diffRules({ a: 1, b: [1, 2] }, { a: 1, b: [1, 3] }, "x")).toEqual([{ path: "x.b.1", from: 2, to: 3 }]);
    expect(diffRules({ l: [1] }, { l: [1, 2] }, "x")).toEqual([{ path: "x.l", from: [1], to: [1, 2] }]);
    expect(diffRules({ a: 1 }, { a: 1 }, "x")).toEqual([]);
    expect(diffRules({}, { a: 1 }, "x")).toEqual([{ path: "x.a", from: null, to: 1 }]);
  });
  it("names a field in words: the kind, the list item by number, the setting", () => {
    expect(fieldWords("reports.kinds.weekly.due.n")).toBe("Weekly report, the due date, the number of days");
    expect(fieldWords("reports.kinds.monthly.content.notes.areas.1.label")).toBe("Monthly report, the content, the notes, notes area 2, the name");
    expect(fieldWords("cycle.steps.2.title")).toBe("Step 3, the title");
    expect(fieldWords("audit.bands")).toBe("The bands");
    expect(fieldWords("ideas.metricRequired")).toBe("The metric requirement");
  });
  it("words an invalid field with the rule where it is not obvious", () => {
    expect(invalidFieldWords("audit.bands")).toContain("last one must start at 0");
    expect(invalidFieldWords("reports.kinds.daily.checkRequires")).toContain("turned on");
    expect(invalidFieldWords("reports.kinds.monthly.content.nextPeriodLine")).toContain("daily and weekly");
    expect(invalidFieldWords("cycle.steps.0.key")).toContain("unique");
    expect(invalidFieldWords("audit.dimensions.1.weight")).toBe("Dimension 2, the weight is not valid. A weight is 0 to 10, with at most two decimals.");
    expect(invalidFieldWords("expectedVersion")).toContain("Reload the page");
    expect(invalidFieldWords("engagementId")).toBe("Choose a client from the list.");
    expect(invalidFieldWords(undefined)).toBe("A value is not valid.");
  });
  it("words the values and the history lines", () => {
    expect(valueWords(null)).toBe("none");
    expect(valueWords(true)).toBe("on");
    expect(valueWords([1, 2])).toBe("2 items");
    expect(valueWords({ rule: "none" })).toBe('{"rule":"none"}');
    const item = {
      version: 2, section: "cycle" as const, reset: false, editedBy: { id: "u", name: "N" }, effectiveFrom: "2026-10-31T01:00:00.000Z",
      diff: [1, 2, 3, 4, 5].map((i) => ({ path: `cycle.steps.${i}.title`, from: "a", to: "b" })),
    };
    expect(historyWords(item)).toBe("Step 2, the title: a to b; Step 3, the title: a to b; Step 4, the title: a to b; and 2 more.");
    expect(historyWords({ ...item, reset: true })).toBe("Set back to the default.");
    expect(historyWords({ ...item, diff: [] })).toBe("Saved with no change to the values.");
  });
  it("lists what differs from the default as rows with both values", () => {
    const d = doc();
    d.reports.kinds.weekly.due = { rule: "weekday", weekday: 3, week: "next" };
    const rows = diffRows(DOC.reports, d.reports, "reports");
    // the server's diff is by leaf, so a changed rule shows each part that moved
    expect(rows.map((r) => r.path)).toEqual(["reports.kinds.weekly.due.rule", "reports.kinds.weekly.due.n", "reports.kinds.weekly.due.weekday", "reports.kinds.weekly.due.week"]);
    expect(rows[0]).toMatchObject({ words: "Weekly report, the due date, the rule", now: "weekday", wasOrDefault: "working_days_after" });
    expect(sameJson(DOC.reports, doc().reports)).toBe(true);
  });
  it("words a due rule", () => {
    expect(dueRuleWords({ rule: "working_days_after", n: 0 })).toBe("On the day the period ends");
    expect(dueRuleWords({ rule: "working_days_after", n: 1 })).toBe("1 working day after the period ends");
    expect(dueRuleWords({ rule: "weekday", weekday: 3, week: "next" })).toBe("On Wednesday of the next week");
    expect(dueRuleWords({ rule: "report_due_day" })).toContain("report day");
  });
});

describe("the words for a refusal", () => {
  const r = (error: string, status: number, extra: Record<string, unknown> = {}) => ({ status, error, ...extra });
  it("says who may change the rules, for the 403 and for an automation", () => {
    expect(rulesRefusalText(r("not_a_social_approver", 403), "save")).toBe(PLAN_REFUSAL_REASON.replace("change this", "change the company's rules"));
    expect(rulesRefusalText(r("not_a_social_approver", 403), "history")).toContain("see the history");
    expect(rulesRefusalText(r("automation_cannot_act", 403), "save")).toContain("A person does");
    expect(rulesRefusalText(r("anything", 403), "save")).toContain("Only the Social Media head");
  });
  it("names the field of a 400 in words", () => {
    expect(rulesRefusalText(r("invalid_field", 400, { field: "cycle.steps.0.title" }), "save")).toContain("Step 1, the title is not valid.");
  });
  it("says someone else saved first for rules_changed, and the client is gone for 404", () => {
    expect(rulesRefusalText(r("rules_changed", 409, { detail: { currentVersion: 4 } }), "save")).toBe(REFUSAL_WORDS.rules_changed);
    expect(rulesRefusalText(r("engagement_not_found", 404), "preview")).toBe(REFUSAL_WORDS.engagement_not_found);
    expect(rulesRefusalText(r("session_expired", 401), "save")).toContain("Session expired");
    expect(rulesRefusalText(r("weird", 500), "save")).toContain("That did not work");
  });
});

describe("every refusal code the rules routes and the preview can send is in the fixture and has words", () => {
  // The rules routes (rules.controller.ts) answer these and nothing else: the gate, the body, the version, the client.
  const CODES = ["not_a_social_approver", "automation_cannot_act", "invalid_field", "rules_changed", "engagement_not_found"];
  const F = (fixture as { refusals: Record<string, { http: number; with?: string }> }).refusals;
  it.each(CODES)("%s", (code) => {
    expect(F[code], `${code} is in refusals`).toBeDefined();
    expect(REFUSAL_WORDS[code], `${code} has words`).toBeTruthy();
  });
  it("carries the server's real status and detail", () => {
    expect(F.rules_changed).toEqual({ http: 409, with: "detail {currentVersion}" });
    expect(F.invalid_field).toEqual({ http: 400, with: "field" });
    expect(F.engagement_not_found.http).toBe(404);
    expect(F.not_a_social_approver.http).toBe(403);
    expect(F.automation_cannot_act.http).toBe(403);
  });
});

describe("the editors' helpers", () => {
  it("offers the due rules a kind can take", () => {
    expect(dueChoices("daily").map((c) => c.rule)).toEqual(["working_days_after"]);
    expect(dueChoices("weekly").map((c) => c.rule)).toEqual(["working_days_after", "weekday"]);
    expect(dueChoices("monthly").map((c) => c.rule)).toEqual(["working_days_after", "report_due_day"]);
    expect(dueFor("weekday")).toEqual({ rule: "weekday", weekday: 1, week: "next" });
    expect(dueFor("report_due_day")).toEqual({ rule: "report_due_day" });
    expect(dueFor("working_days_after")).toEqual({ rule: "working_days_after", n: 1 });
  });
  it("drops a check part the content turned off, and keeps one that is on", () => {
    const k = doc().reports.kinds.monthly;
    expect(checkPartOn(k, "notes")).toBe(true);
    expect(checkPartOn(k, "nextPeriodLine")).toBe(false);
    const noNotes = pruneCheck({ ...k, content: { ...k.content, notes: { areas: [] } }, checkRequires: ["notes", "narrative"] });
    expect(noNotes.checkRequires).toEqual(["narrative"]);
    expect(pruneCheck(k).checkRequires).toEqual(["notes"]);
  });
  it("builds new items with a key not already used, and fits the server's key rule", () => {
    const KEY = /^[a-z][a-z0-9_]{0,39}$/;
    expect(newStep(["step"]).key).toBe("step_2");
    expect(newDimension([]).weight).toBe(1);
    expect(newBand(["band", "band_2"]).key).toBe("band_3");
    expect(newCategory(["other"]).key).not.toBe("other");
    expect(newCategory([]).holds).toEqual(["text"]);
    for (const k of [slugKey("Tone of voice!", []), slugKey("1st look", []), slugKey("é", []), slugKey("x".repeat(80), [])]) expect(k).toMatch(KEY);
  });
  it("moves an item up or down and stays put at an edge", () => {
    expect(moveItem([1, 2, 3], 1, -1)).toEqual([2, 1, 3]);
    expect(moveItem([1, 2, 3], 1, 1)).toEqual([1, 3, 2]);
    expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(moveItem([1, 2, 3], 2, 1)).toEqual([1, 2, 3]);
  });
  it("builds a close condition and a step due rule with the server's shape", () => {
    expect(autoCloseFor("manual")).toEqual({ rule: "manual" });
    expect(autoCloseFor("report_delivered")).toEqual({ rule: "report_delivered", reportMonthOffset: 0 });
    expect(autoCloseFor("copy_locked")).toEqual({ rule: "copy_locked" });
    expect(stepDueFor("ready_by")).toEqual({ rule: "ready_by", lessEstimatesFrom: null, lessWorkingDays: 0 });
    expect(stepDueFor("report_due_day")).toEqual({ rule: "report_due_day", monthOffset: 0 });
    expect(stepDueFor("none")).toEqual({ rule: "none" });
  });
  it("builds the preview's body, with the client only when one is chosen", () => {
    expect(previewBody("cycle", { steps: [] }, null)).toEqual({ section: "cycle", value: { steps: [] } });
    expect(previewBody("cycle", { steps: [] }, "e1")).toEqual({ section: "cycle", value: { steps: [] }, engagementId: "e1" });
  });
});
