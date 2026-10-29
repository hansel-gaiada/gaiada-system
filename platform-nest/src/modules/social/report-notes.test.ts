// SCP-5a (BFF §63.1 file 9, §63.18) — the monthly report's pure parts: the notes and action-plan shapes the PATCH enforces, the
// HoD check's completeness rule, "Draft with AI"'s parse and template, the boosts as the client's own ad spend, the notes and
// action plan as printed tables, the SIMULATED mark on the document, and the due date. No database, no services.
import { describe, it, expect } from "vitest";
import {
  ACTION_PLAN_MAX, NOTE_MAX, buildMonthlyReportDraftPrompt, isIsoDate, notesComplete, parseMonthlyReportDraft, templateNotes,
  validateActionPlan, validateNotes,
} from "./report-notes";
import { buildSocialReportDocument, buildSocialReportSnapshot, monthLabel, notesTables, previousPeriod, reportDueDate, type BoostSpendInput } from "./reports";
import type { ReportNarrativeGroundingFacts } from "./ai-drafts";

const full = {
  followers: { insight: "Followers grew.", suggestion: "Keep posting." },
  engagement: { insight: "Engagement held.", suggestion: "Answer comments." },
  audience: { insight: "Reach widened.", suggestion: "Post at noon." },
};

const facts: ReportNarrativeGroundingFacts = {
  engagementName: "Mock engagement", clientName: "Mock Bakery", periodLabel: "2026-08-01 – 2026-08-31",
  kpis: [{ label: "Followers", value: 110, unit: "count" }, { label: "Reach", value: 900, unit: "count" }, { label: "Engagement rate", value: 4.5, unit: "percent" }],
  topPosts: [], knowledgeHits: [],
};

describe("validateNotes (400 {field: 'notes'})", () => {
  it("admits the three areas, a partial set, an empty object and the 500-character limit", () => {
    expect(validateNotes(full)).toEqual({ ok: true, value: full });
    expect(validateNotes({})).toEqual({ ok: true, value: {} });
    expect(validateNotes({ followers: { insight: "x" } })).toEqual({ ok: true, value: { followers: { insight: "x", suggestion: "" } } });
    expect(validateNotes({ audience: { insight: "a".repeat(NOTE_MAX), suggestion: "" } }).ok).toBe(true);
  });
  it("refuses a non-object, an unknown area, an unknown key, a non-string and an over-long text", () => {
    for (const bad of [null, [], "notes", 5, { reach: { insight: "x", suggestion: "y" } }, { followers: null }, { followers: [] },
      { followers: { insight: "x", extra: "y" } }, { followers: { insight: 5 } }, { followers: { insight: null } },
      { followers: { suggestion: "a".repeat(NOTE_MAX + 1) } }]) {
      expect(validateNotes(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("validateActionPlan (400 {field: 'actionPlan'})", () => {
  it("admits up to ten actions with an owner and an optional real due date (null reads as none)", () => {
    const ten = Array.from({ length: ACTION_PLAN_MAX }, (_, i) => ({ action: `Step ${i}`, owner: i % 2 ? "client" : "agency" }));
    expect(validateActionPlan(ten).ok).toBe(true);
    expect(validateActionPlan([])).toEqual({ ok: true, value: [] });
    expect(validateActionPlan([{ action: "Plan", owner: "agency", due: "2026-09-30" }, { action: "Agree", owner: "client", due: null }]))
      .toEqual({ ok: true, value: [{ action: "Plan", owner: "agency", due: "2026-09-30" }, { action: "Agree", owner: "client" }] });
  });
  it("refuses eleven, a blank or over-long action, a bad owner, a bad date and an unknown key", () => {
    const eleven = Array.from({ length: ACTION_PLAN_MAX + 1 }, () => ({ action: "x", owner: "agency" }));
    for (const bad of [null, {}, "x", eleven, [null], [{ owner: "agency" }], [{ action: "   ", owner: "agency" }],
      [{ action: "a".repeat(301), owner: "agency" }], [{ action: "x", owner: "both" }], [{ action: "x" }],
      [{ action: "x", owner: "agency", due: "2026-02-30" }], [{ action: "x", owner: "agency", due: "30/09/2026" }],
      [{ action: "x", owner: "agency", note: "y" }]]) {
      expect(validateActionPlan(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it("isIsoDate checks the calendar", () => {
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2027-02-29")).toBe(false);
    expect(isIsoDate("2027-13-01")).toBe(false);
  });
});

describe("notesComplete (400 notes_incomplete)", () => {
  it("needs a non-blank insight AND suggestion in every area", () => {
    expect(notesComplete(full)).toBe(true);
    expect(notesComplete({})).toBe(false);
    expect(notesComplete(null)).toBe(false);
    expect(notesComplete({ ...full, audience: { insight: "Reach widened.", suggestion: "  \n " } })).toBe(false);
    expect(notesComplete({ followers: full.followers, engagement: full.engagement })).toBe(false);
  });
});

describe("Draft with AI: one draft, one source", () => {
  const good = { narrative: "Followers reached 110 this month.", notes: full, actionPlan: [{ action: "Post two reels a week.", owner: "agency" }] };

  it("takes the model's answer when every part passes", () => {
    const d = parseMonthlyReportDraft(JSON.stringify(good), facts);
    expect(d.draftedVia).toBe("ai");
    expect(d.narrativeMd).toBe(good.narrative);
    expect(d.notes).toEqual(full);
    expect(d.actionPlan).toEqual(good.actionPlan);
  });

  it("falls back to the plain template, whole, when the gateway is down or any part fails", () => {
    const cases: Array<[string | null, string | undefined]> = [
      [null, undefined],
      ["not json at all", undefined],
      [JSON.stringify({ ...good, narrative: "Followers reached 999." }), "narrative"],
      [JSON.stringify({ ...good, notes: { followers: full.followers } }), "notes"],
      [JSON.stringify({ ...good, notes: { ...full, followers: { insight: "Followers rose by 37.", suggestion: "x" } } }), "notes"],
      [JSON.stringify({ ...good, actionPlan: [] }), "actionPlan"],
      [JSON.stringify({ ...good, actionPlan: [{ action: "x", owner: "everyone" }] }), "actionPlan"],
    ];
    for (const [raw, part] of cases) {
      const d = parseMonthlyReportDraft(raw, facts);
      expect(d.draftedVia, String(raw)).toBe("template");
      expect(d.rejected?.part, String(raw)).toBe(part);
      expect(notesComplete(d.notes)).toBe(true); // the template always passes the HoD check's notes rule
      expect(validateActionPlan(d.actionPlan).ok).toBe(true);
      expect(d.actionPlan.length).toBeGreaterThan(0);
    }
  });

  it("an insight may state only a given number; a suggestion may advise with any", () => {
    const d = parseMonthlyReportDraft(JSON.stringify({ ...good, notes: { ...full, engagement: { insight: "The rate was 4.5%.", suggestion: "Try 3 carousels." } } }), facts);
    expect(d.draftedVia).toBe("ai");
  });

  it("the template states only the snapshot's numbers and says plainly what was not fetched", () => {
    const t = templateNotes({ ...facts, kpis: [] });
    expect(t.followers.insight).toContain("not been fetched");
    expect(t.engagement.insight).toContain("not been fetched");
    expect(t.audience.insight).toContain("not been fetched");
    const withNumbers = templateNotes(facts);
    expect(withNumbers.followers.insight).toContain("110");
    expect(withNumbers.engagement.insight).toContain("4.5%");
    expect(withNumbers.audience.insight).toContain("900");
  });

  it("the prompt carries the grounding numbers and asks for the three parts as strict JSON", () => {
    const p = buildMonthlyReportDraftPrompt(facts);
    expect(p).toContain("- Followers: 110 count");
    expect(p).toContain('"notes"');
    expect(p).toContain('"actionPlan"');
  });
});

describe("the snapshot's boosts: the client's own ad spend (PV7-Q3)", () => {
  const boost = (o: Partial<BoostSpendInput>): BoostSpendInput => ({
    boostId: "b1", postTitle: "Mock post", startsOn: "2026-08-05", days: 5, status: "completed", currency: "IDR", minorUnit: 0,
    spendMinor: 500_000, paidReach: 1200, clicks: 40, ...o,
  });
  const base = { rangeStart: "2026-08-01", rangeEnd: "2026-08-31", daily: [], posts: [], postsPublishedInPeriod: 0, kpiTargets: [] };

  it("sums the known spends per currency; a running boost's unknown spend is never a 0", () => {
    const snap = buildSocialReportSnapshot({ ...base, boosts: [boost({}), boost({ boostId: "b2", startsOn: "2026-08-20", status: "running", spendMinor: null, paidReach: null, clicks: null })] });
    expect(snap.adSpend).toEqual([{ currency: "IDR", minorUnit: 0, boosts: 2, spendMinor: 500_000, paidReach: 1200, clicks: 40 }]);
    const table = snap.tables.find((t) => t.key === "ad_spend")!;
    expect(table.rows.map((r) => r.spend)).toEqual([500_000, null]);
    expect(table.totalRow).toMatchObject({ spend: 500_000, currency: "IDR" });
    expect(JSON.stringify(table)).not.toMatch(/fee|margin/i);
  });

  it("shows money in major units and never sums two currencies", () => {
    const snap = buildSocialReportSnapshot({ ...base, boosts: [boost({}), boost({ boostId: "b2", currency: "USD", minorUnit: 2, spendMinor: 12_345 })] });
    expect(snap.adSpend!.map((s) => s.currency)).toEqual(["IDR", "USD"]);
    const table = snap.tables.find((t) => t.key === "ad_spend")!;
    expect(table.rows.find((r) => r.currency === "USD")!.spend).toBe(123.45);
    expect(table.totalRow).toBeUndefined();
  });

  it("no boosts: no table and no adSpend", () => {
    const snap = buildSocialReportSnapshot(base);
    expect(snap.adSpend).toBeUndefined();
    expect(snap.tables.find((t) => t.key === "ad_spend")).toBeUndefined();
  });
});

describe("the document: notes and action plan as tables, the SIMULATED mark", () => {
  const frozen = buildSocialReportSnapshot({ rangeStart: "2026-08-01", rangeEnd: "2026-08-31", daily: [], posts: [], postsPublishedInPeriod: 0, kpiTargets: [] });
  const doc = (o: { simulated?: boolean; notes?: typeof full | Record<string, never> } = {}) => buildSocialReportDocument({
    tenantId: "t", engagementId: "e", clientName: "Mock Bakery", kind: "monthly", period: "2026-08", status: "approved", frozen,
    narrativeText: "n", generatedAt: "2026-09-01T00:00:00Z", notes: o.notes ?? full, actionPlan: [{ action: "Plan", owner: "client", due: "2026-09-10" }],
    simulated: o.simulated,
  });

  it("prints the notes and the action plan", () => {
    const d = doc();
    expect(d.tables.find((t) => t.key === "notes")!.rows).toEqual([
      { area: "Followers", ...full.followers }, { area: "Engagement", ...full.engagement }, { area: "Audience", ...full.audience },
    ]);
    expect(d.tables.find((t) => t.key === "action_plan")!.rows).toEqual([{ action: "Plan", owner: "Client", due: "2026-09-10" }]);
    expect(notesTables({}, [])).toEqual([]);
    expect(doc({ notes: {} }).tables.find((t) => t.key === "notes")).toBeUndefined();
  });

  it("carries simulated only when the row is simulated", () => {
    expect(doc({ simulated: true }).simulated).toBe(true);
    expect("simulated" in doc({ simulated: false })).toBe(false);
    expect("simulated" in doc()).toBe(false);
  });
});

describe("reports due (§63.18)", () => {
  it("the due day of the month after the period, clamped to that month's end", () => {
    expect(reportDueDate("2026-08", 5)).toBe("2026-09-05");
    expect(reportDueDate("2026-08", 31)).toBe("2026-09-30");
    expect(reportDueDate("2027-01", 30)).toBe("2027-02-28");
    expect(reportDueDate("2027-12", 10)).toBe("2028-01-10");
    expect(reportDueDate("2027-13", 10)).toBeNull();
    expect(reportDueDate("2027-01", 0)).toBeNull();
    expect(reportDueDate("bad", 1)).toBeNull();
  });
  it("the period due this month is last month's", () => {
    expect(previousPeriod("2026-10-29")).toBe("2026-09");
    expect(previousPeriod("2027-01-01")).toBe("2026-12");
    expect(monthLabel("2026-09")).toBe("September 2026");
  });
});

// PERMISSION §53.7: every `social_report` call site sends `module: "social"` and the seat approvers. Pinned statically: the report
// controller builds no resource of its own; each `authorize` / `check` names `socialReportResource(...)` or a variable made from it.
describe("static: every social_report decision goes through socialReportResource (module social, approverIds)", () => {
  it("the controller's authorize and check calls", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "social-reports.controller.ts"), "utf8");
    expect(src).not.toMatch(/kind:\s*["']social_report["']/);
    const fromHelper = new Set([...src.matchAll(/const (\w+) = socialReportResource\(/g)].map((m) => m[1]));
    const calls = [...src.matchAll(/\b(?:authorize|check)\(req\.principal,\s*([^,]+?),/g)].map((m) => m[1].trim());
    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const arg of calls) {
      expect(arg.startsWith("socialReportResource(") || fromHelper.has(arg), arg).toBe(true);
    }
  });
});
