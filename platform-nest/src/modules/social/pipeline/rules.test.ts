// SCP-5 W5-A0 — the company rules core, pure (BFF §63.30.7): the seed and its twin, the rulings as defaults, each section's validation
// (one refusal per rule, with its field), what is NOT a setting, the refs, the diff, the read-through reader and the versioned save
// against a scripted client, and the period and due-date maths. No database: runs anywhere.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { runWithRequestContext } from "../../../core/request-context";
import { ACTION_PLAN_MAX, NOTE_AREAS } from "../report-notes";
import {
  DEFAULTS_ARCHIVE, DEFAULTS_VERSION, DEFAULT_RULES, LEGACY_RULES_REF, PERIODIC_KINDS, RULES_REF_RE, auditBandFor, auditScorecard,
  cycleSteps, diffRules, enabledReportKinds, fiscalYearStartMonth, ideasSettings, loadSeed, parseRulesRef, reportKindRules,
  rulesByRef, rulesRefFor, saveRulesSectionInTx, savedCategories, socialRules, validateRulesDoc, validateSection, type RulesDoc,
  type RulesSection,
} from "./rules";
import {
  cycleStepDueDate, cycleStepTitle, isoWeekKey, nextReportDues, periodOf, periodRange, reportDueDate,
} from "./rules-periods";

const NEST_SEED = join(__dirname, "..", "social-rules-defaults.json");
const UI_SEED = join(__dirname, "..", "..", "..", "..", "..", "platform-ui", "src", "lib", "socialRulesDefaults.json");
const MIGRATION = join(__dirname, "..", "..", "..", "..", "migrations", "202610301210_social_rules.sql");

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** The field a 400 names, or a failure when nothing was refused. */
function refusedField(section: RulesSection, value: unknown): string {
  try {
    validateSection(section, value);
  } catch (e) {
    const r = (e as { getResponse?: () => unknown; getStatus?: () => number });
    expect(r.getStatus?.()).toBe(400);
    const body = r.getResponse?.() as { message: string; field: string };
    expect(body.message).toBe("invalid_field");
    return body.field;
  }
  throw new Error(`expected ${section} to be refused`);
}
const edit = <S extends RulesSection>(section: S, fn: (v: Record<string, any>) => void): Record<string, any> => {
  const v = clone(DEFAULT_RULES[section]) as Record<string, any>;
  fn(v);
  return v;
};

describe("W5-A0 · the seed and its twin", () => {
  it("the seed's twins are byte-equal", () => {
    expect(readFileSync(UI_SEED, "utf8")).toBe(readFileSync(NEST_SEED, "utf8"));
  });

  it("the seed is LF only, validates, and is version 0 named by its defaultsVersion", () => {
    const raw = readFileSync(NEST_SEED, "utf8");
    expect(raw).not.toMatch(/\r/);
    const seed = loadSeed(JSON.parse(raw));
    expect(seed.defaultsVersion).toBe(DEFAULTS_VERSION);
    expect(seed.rules).toEqual(DEFAULT_RULES);
    expect(validateRulesDoc(clone(DEFAULT_RULES))).toEqual(DEFAULT_RULES);
    expect(DEFAULTS_ARCHIVE[DEFAULTS_VERSION]).toBe(DEFAULT_RULES);
  });

  it("a bad seed refuses to load, naming the field", () => {
    const bad = JSON.parse(readFileSync(NEST_SEED, "utf8"));
    bad.audit.bands[0].from = 10;
    expect(() => loadSeed(bad)).toThrow(/audit\.bands/);
    expect(() => loadSeed({ ...JSON.parse(readFileSync(NEST_SEED, "utf8")), defaultsVersion: "Bad Version" })).toThrow(/defaultsVersion/);
  });

  it("the rulings are the defaults (SCP-Q25 to SCP-Q40)", () => {
    const r = DEFAULT_RULES;
    expect(fiscalYearStartMonth(r)).toBe(1); // SCP-Q39: calendar periods
    expect(enabledReportKinds(r)).toEqual([...PERIODIC_KINDS]);
    for (const k of ["daily", "weekly"] as const) {
      expect(reportKindRules(r, k)).toEqual({
        enabled: true, due: { rule: "working_days_after", n: 1 }, freezeAt: "submit",
        content: { narrative: { max: 1000 }, nextPeriodLine: true, notes: { areas: [] }, actionPlan: { enabled: false, max: 10 } },
        checkRequires: ["narrative"], aiDrafting: true,
      });
    }
    for (const k of ["monthly", "quarterly", "semester", "yearly"] as const) {
      const kr = reportKindRules(r, k);
      expect(kr).toMatchObject({ enabled: true, due: { rule: "report_due_day" }, freezeAt: "create", checkRequires: ["notes"], aiDrafting: true });
      expect(kr.content).toEqual({
        narrative: { max: null }, nextPeriodLine: false,
        notes: { areas: [{ key: "followers", label: "Followers" }, { key: "engagement", label: "Engagement" }, { key: "audience", label: "Audience" }] },
        actionPlan: { enabled: true, max: 10 },
      });
    }
    expect(ideasSettings(r)).toEqual({ metricRequired: true, sharedInMonthlyReport: false }); // 63.25, SCP-Q27
    expect(cycleSteps(r).map((s) => s.key)).toEqual(["report", "planning", "copy_lock", "artwork", "client_window", "deploy"]);
    expect(cycleSteps(r).every((s) => s.autoClose.rule !== "manual")).toBe(true); // SCP-Q31: all six close themselves
    expect(cycleSteps(r)[0]).toEqual({
      key: "report", title: "Monthly report for {month-2}", due: { rule: "report_due_day", monthOffset: -1 },
      autoClose: { rule: "report_delivered", reportMonthOffset: -2 },
    });
    const a = auditScorecard(r);
    expect(a.dimensions).toHaveLength(12); // SCP-Q32
    expect(a.dimensions.every((d) => d.weight === 1)).toBe(true);
    expect(a.dimensions.filter((d) => d.source !== "typed").map((d) => d.key)).toEqual(["consistency", "format_mix", "engagement_rate", "reels", "stories", "boosting"]);
    expect(a.bands.map((b) => [b.key, b.from])).toEqual([["strong", 75], ["fair", 50], ["needs_work", 0]]);
    expect(a.benchmark).toEqual({ source: "own_clients_median" });
    expect(savedCategories(r).map((c) => [c.key, c.derived])).toEqual([
      ["photos", true], ["posts", true], ["captions", false], ["hashtags", true], ["templates", false], ["references", false],
    ]);
  });

  it("'default:scp-5a' reads as the seed, whose monthly kind is SCP-5a's as built (63.18)", async () => {
    const legacy = await rulesByRef({} as PoolClient, "00000000-0000-0000-0000-000000000001", LEGACY_RULES_REF);
    const m = reportKindRules(legacy.rules, "monthly");
    expect(legacy).toMatchObject({ ref: "default:scp-5a", version: 0, defaultsVersion: "scp-5a" });
    expect(m.due).toEqual({ rule: "report_due_day" });
    expect(m.freezeAt).toBe("create");
    expect(m.content.notes.areas.map((x) => x.key)).toEqual([...NOTE_AREAS]);
    expect(m.content.actionPlan).toEqual({ enabled: true, max: ACTION_PLAN_MAX });
    expect(m.checkRequires).toEqual(["notes"]);
  });
});

describe("W5-A0 · each section's validation, one refusal per rule", () => {
  it("every default section passes and comes back equal", () => {
    for (const s of ["reports", "ideas", "cycle", "audit", "saved"] as const) expect(validateSection(s, clone(DEFAULT_RULES[s]))).toEqual(DEFAULT_RULES[s]);
  });

  it("reports", () => {
    expect(refusedField("reports", null)).toBe("reports");
    expect(refusedField("reports", edit("reports", (v) => { v.fiscalYearStartMonth = 13; }))).toBe("reports.fiscalYearStartMonth");
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.campaign = v.kinds.monthly; }))).toBe("reports.kinds.campaign");
    expect(refusedField("reports", edit("reports", (v) => { delete v.kinds.weekly; }))).toBe("reports.kinds.weekly");
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.daily.enabled = "yes"; }))).toBe("reports.kinds.daily.enabled");
    expect(refusedField("reports", edit("reports", (v) => { delete v.kinds.daily.aiDrafting; }))).toBe("reports.kinds.daily.aiDrafting");
    // A due rule the kind cannot take.
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.daily.due = { rule: "weekday", weekday: 1, week: "next" }; }))).toBe("reports.kinds.daily.due");
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.daily.due = { rule: "report_due_day" }; }))).toBe("reports.kinds.daily.due");
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.monthly.due = { rule: "weekday", weekday: 1, week: "same" }; }))).toBe("reports.kinds.monthly.due");
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.weekly.due = { rule: "report_due_day" }; }))).toBe("reports.kinds.weekly.due");
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.daily.due = { rule: "working_days_after", n: 31 }; }))).toBe("reports.kinds.daily.due.n");
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.weekly.due = { rule: "weekday", weekday: 8, week: "same" }; }))).toBe("reports.kinds.weekly.due.weekday");
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.weekly.due = { rule: "weekday", weekday: 1, week: "later" }; }))).toBe("reports.kinds.weekly.due.week");
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.weekly.due = { rule: "working_days_after", n: 1, extra: 1 }; }))).toBe("reports.kinds.weekly.due.extra");
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.daily.freezeAt = "send"; }))).toBe("reports.kinds.daily.freezeAt");
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.daily.content.narrative.max = 50; }))).toBe("reports.kinds.daily.content.narrative.max");
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.daily.content.narrative.max = 10_001; }))).toBe("reports.kinds.daily.content.narrative.max");
    // The next_period column admits the short kinds only (63.24.2).
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.monthly.content.nextPeriodLine = true; }))).toBe("reports.kinds.monthly.content.nextPeriodLine");
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.monthly.content.notes.areas.push({ key: "followers", label: "Again" }); }))).toBe("reports.kinds.monthly.content.notes.areas.3.key");
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.monthly.content.notes.areas[0].key = "Followers"; }))).toBe("reports.kinds.monthly.content.notes.areas.0.key");
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.monthly.content.notes.areas[0].label = "  "; }))).toBe("reports.kinds.monthly.content.notes.areas.0.label");
    expect(refusedField("reports", edit("reports", (v) => {
      v.kinds.monthly.content.notes.areas = ["a", "b", "c", "d", "e", "f", "g"].map((k) => ({ key: k, label: k }));
    }))).toBe("reports.kinds.monthly.content.notes.areas");
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.monthly.content.actionPlan.max = 21; }))).toBe("reports.kinds.monthly.content.actionPlan.max");
    // A checkRequires part the content turns off; a repeated or unknown part.
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.daily.checkRequires = ["notes"]; }))).toBe("reports.kinds.daily.checkRequires");
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.daily.checkRequires = ["actionPlan"]; }))).toBe("reports.kinds.daily.checkRequires");
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.monthly.checkRequires = ["nextPeriodLine"]; }))).toBe("reports.kinds.monthly.checkRequires");
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.monthly.content.notes.areas = []; }))).toBe("reports.kinds.monthly.checkRequires");
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.daily.checkRequires = ["narrative", "narrative"]; }))).toBe("reports.kinds.daily.checkRequires");
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.daily.checkRequires = ["photos"]; }))).toBe("reports.kinds.daily.checkRequires");
  });

  it("reports: what a company may change is accepted, and labels are trimmed", () => {
    const v = edit("reports", (x) => {
      x.fiscalYearStartMonth = 4;
      x.kinds.weekly.due = { rule: "weekday", weekday: 2, week: "next" };
      x.kinds.daily.enabled = false;
      x.kinds.monthly.content.notes.areas.push({ key: "reach", label: "  Reach  " });
      x.kinds.monthly.checkRequires = ["notes", "actionPlan", "narrative"];
      x.kinds.quarterly.due = { rule: "working_days_after", n: 5 };
      x.kinds.yearly.aiDrafting = false;
    });
    const out = validateSection("reports", v);
    expect(out.kinds.monthly.content.notes.areas[3]).toEqual({ key: "reach", label: "Reach" });
    expect(out.fiscalYearStartMonth).toBe(4);
  });

  it("ideas", () => {
    expect(refusedField("ideas", { metricRequired: true })).toBe("ideas.sharedInMonthlyReport");
    expect(refusedField("ideas", { metricRequired: 1, sharedInMonthlyReport: false })).toBe("ideas.metricRequired");
    expect(refusedField("ideas", { metricRequired: true, sharedInMonthlyReport: false, sharedInPortal: true })).toBe("ideas.sharedInPortal");
    expect(validateSection("ideas", { metricRequired: false, sharedInMonthlyReport: true })).toEqual({ metricRequired: false, sharedInMonthlyReport: true });
  });

  it("cycle", () => {
    expect(refusedField("cycle", { steps: [] })).toBe("cycle.steps");
    expect(refusedField("cycle", edit("cycle", (v) => { v.steps = Array.from({ length: 13 }, (_, i) => ({ ...v.steps[1], key: `s${i}` })); }))).toBe("cycle.steps");
    expect(refusedField("cycle", edit("cycle", (v) => { v.steps[2].key = "planning"; }))).toBe("cycle.steps.2.key");
    expect(refusedField("cycle", edit("cycle", (v) => { v.steps[2].key = "copy-lock"; }))).toBe("cycle.steps.2.key");
    expect(refusedField("cycle", edit("cycle", (v) => { v.steps[1].title = "{client} plan"; }))).toBe("cycle.steps.1.title");
    expect(refusedField("cycle", edit("cycle", (v) => { v.steps[1].title = "{month-4} plan"; }))).toBe("cycle.steps.1.title");
    expect(refusedField("cycle", edit("cycle", (v) => { v.steps[1].title = "x".repeat(201); }))).toBe("cycle.steps.1.title");
    expect(refusedField("cycle", edit("cycle", (v) => { v.steps[1].due.lessEstimatesFrom = "planning"; }))).toBe("cycle.steps.1.due.lessEstimatesFrom");
    expect(refusedField("cycle", edit("cycle", (v) => { v.steps[1].due.lessWorkingDays = 31; }))).toBe("cycle.steps.1.due.lessWorkingDays");
    expect(refusedField("cycle", edit("cycle", (v) => { v.steps[0].due.monthOffset = 1; }))).toBe("cycle.steps.0.due.monthOffset");
    expect(refusedField("cycle", edit("cycle", (v) => { v.steps[0].due = { rule: "fixed_day", day: 3 }; }))).toBe("cycle.steps.0.due");
    expect(refusedField("cycle", edit("cycle", (v) => { v.steps[1].autoClose = { rule: "posts_liked" }; }))).toBe("cycle.steps.1.autoClose");
    expect(refusedField("cycle", edit("cycle", (v) => { v.steps[0].autoClose.reportMonthOffset = -4; }))).toBe("cycle.steps.0.autoClose.reportMonthOffset");
    expect(refusedField("cycle", edit("cycle", (v) => { v.steps[1].autoClose = { rule: "manual", when: "never" }; }))).toBe("cycle.steps.1.autoClose.when");
    const ok = validateSection("cycle", edit("cycle", (v) => { v.steps[1].autoClose = { rule: "manual" }; v.steps[5].due = { rule: "none" }; }));
    expect(ok.steps[1].autoClose).toEqual({ rule: "manual" });
  });

  it("audit", () => {
    expect(refusedField("audit", edit("audit", (v) => { v.dimensions = []; }))).toBe("audit.dimensions");
    expect(refusedField("audit", edit("audit", (v) => { for (let i = 0; i < 9; i++) v.dimensions.push({ ...v.dimensions[6], key: `extra_${i}` }); }))).toBe("audit.dimensions");
    expect(refusedField("audit", edit("audit", (v) => { v.dimensions[1].key = "consistency"; }))).toBe("audit.dimensions.1.key");
    expect(refusedField("audit", edit("audit", (v) => { v.dimensions[1].weight = 11; }))).toBe("audit.dimensions.1.weight");
    expect(refusedField("audit", edit("audit", (v) => { v.dimensions[1].weight = 0.333; }))).toBe("audit.dimensions.1.weight");
    expect(refusedField("audit", edit("audit", (v) => { v.dimensions[1].source = "followers_growth"; }))).toBe("audit.dimensions.1.source");
    expect(refusedField("audit", edit("audit", (v) => { v.dimensions[1].source = "consistency"; }))).toBe("audit.dimensions.1.source");
    expect(refusedField("audit", edit("audit", (v) => { v.dimensions[1].advice = ""; }))).toBe("audit.dimensions.1.advice");
    expect(refusedField("audit", edit("audit", (v) => { for (const d of v.dimensions) d.weight = 0; }))).toBe("audit.dimensions");
    // Bands out of order, a repeated band, the last not from 0, too few.
    expect(refusedField("audit", edit("audit", (v) => { v.bands[1].from = 80; }))).toBe("audit.bands");
    expect(refusedField("audit", edit("audit", (v) => { v.bands[1].key = "strong"; }))).toBe("audit.bands.1.key");
    expect(refusedField("audit", edit("audit", (v) => { v.bands[2].from = 10; }))).toBe("audit.bands");
    expect(refusedField("audit", edit("audit", (v) => { v.bands = [v.bands[2]]; }))).toBe("audit.bands");
    expect(refusedField("audit", edit("audit", (v) => { v.bands[0].from = 101; }))).toBe("audit.bands.0.from");
    expect(refusedField("audit", edit("audit", (v) => { v.benchmark = { source: "industry" }; }))).toBe("audit.benchmark");
    expect(refusedField("audit", edit("audit", (v) => { v.benchmark = { source: "typed", rates: {} }; }))).toBe("audit.benchmark.rates");
    expect(refusedField("audit", edit("audit", (v) => { v.benchmark = { source: "typed", rates: { cafe: 2 } }; }))).toBe("audit.benchmark.rates.cafe");
    expect(refusedField("audit", edit("audit", (v) => { v.benchmark = { source: "own_clients_median", rates: {} }; }))).toBe("audit.benchmark.rates");
    const ok = validateSection("audit", edit("audit", (v) => {
      v.benchmark = { source: "typed", rates: { Cafe: 0.04, " Hotel ": 0.025 } };
      v.dimensions[0].weight = 2.5;
      v.bands = [{ key: "top", label: "Top", from: 90 }, { key: "rest", label: "Rest", from: 0 }];
    }));
    expect(ok.benchmark).toEqual({ source: "typed", rates: { Cafe: 0.04, Hotel: 0.025 } });
  });

  it("saved", () => {
    const cats = (fn: (c: any[]) => void) => edit("saved", (v) => fn(v.categories));
    expect(refusedField("saved", cats((c) => { c.splice(1, 1); }))).toBe("saved.categories"); // a derived category removed
    expect(refusedField("saved", cats((c) => { c[2].holds = []; }))).toBe("saved.categories.2.holds"); // holds nothing
    expect(refusedField("saved", cats((c) => { c[0].holds = ["text"]; }))).toBe("saved.categories.0.holds"); // a derived shape changed
    expect(refusedField("saved", cats((c) => { c[2].holds = ["text", "text"]; }))).toBe("saved.categories.2.holds");
    expect(refusedField("saved", cats((c) => { c[2].holds = ["video"]; }))).toBe("saved.categories.2.holds");
    expect(refusedField("saved", cats((c) => { c[4].key = "captions"; }))).toBe("saved.categories.4.key");
    expect(refusedField("saved", cats((c) => { c[4].key = "other"; }))).toBe("saved.categories.4.key"); // "Other" holds removed categories' items
    expect(refusedField("saved", cats((c) => { for (let i = 0; i < 10; i++) c.push({ key: `extra_${i}`, label: "Extra", holds: ["link"], enabled: true }); }))).toBe("saved.categories");
    const ok = validateSection("saved", cats((c) => {
      c[0].label = "Pictures";
      c[1].enabled = false; // hidden, not removed
      c.reverse();
      c.push({ key: "videos", label: "Video links", holds: ["link"], enabled: true });
    }));
    expect(ok.categories.map((c) => c.key)).toEqual(["references", "templates", "hashtags", "captions", "posts", "photos", "videos"]);
    expect(savedCategories({ ...DEFAULT_RULES, saved: ok }, { enabledOnly: true }).map((c) => c.key)).not.toContain("posts");
  });

  it("what is not set here stays fixed: the validator has no key for who acts, the one-report rule, drafting-only AI or a schedule's owner", () => {
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.monthly.approvers = ["owner"]; }))).toBe("reports.kinds.monthly.approvers");
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.monthly.checkedBy = "officer"; }))).toBe("reports.kinds.monthly.checkedBy");
    expect(refusedField("reports", edit("reports", (v) => { v.onePerPeriod = false; }))).toBe("reports.onePerPeriod");
    expect(refusedField("reports", edit("reports", (v) => { v.kinds.weekly.aiSends = true; }))).toBe("reports.kinds.weekly.aiSends");
    expect(refusedField("reports", edit("reports", (v) => { v.scheduleOwner = "automation"; }))).toBe("reports.scheduleOwner");
    expect(refusedField("cycle", edit("cycle", (v) => { v.steps[1].assignee = "client"; }))).toBe("cycle.steps.1.assignee");
    expect(() => validateRulesDoc({ ...clone(DEFAULT_RULES), permissions: {} })).toThrow();
  });
});

describe("W5-A0 · refs and the diff", () => {
  it("a ref is 'company:<version>' or 'default:<defaultsVersion>', the same shape the migration's CHECKs hold", () => {
    expect(parseRulesRef("company:3")).toEqual({ kind: "company", version: 3 });
    expect(parseRulesRef("default:scp-5a")).toEqual({ kind: "default", defaultsVersion: "scp-5a" });
    for (const bad of ["company:0", "company:-1", "default:", "Company:1", "company:1 ", "rules:1"]) expect(parseRulesRef(bad)).toBeNull();
    expect(rulesRefFor({ ref: "company:7" })).toBe("company:7");
    const sql = readFileSync(MIGRATION, "utf8");
    const pattern = RULES_REF_RE.source;
    expect(sql.split(`CHECK (rules_ref ~ '${pattern}')`).length - 1).toBe(2);
  });

  it("the diff names each changed leaf with its path", () => {
    const next = edit("reports", (v) => { v.fiscalYearStartMonth = 4; v.kinds.daily.enabled = false; }) as RulesDoc["reports"];
    expect(diffRules(DEFAULT_RULES.reports, next, "reports")).toEqual([
      { path: "reports.fiscalYearStartMonth", from: 1, to: 4 },
      { path: "reports.kinds.daily.enabled", from: true, to: false },
    ]);
    expect(diffRules(DEFAULT_RULES.audit, DEFAULT_RULES.audit, "audit")).toEqual([]);
    const fewer = edit("cycle", (v) => { v.steps.pop(); });
    expect(diffRules(DEFAULT_RULES.cycle, fewer, "cycle")).toEqual([{ path: "cycle.steps", from: DEFAULT_RULES.cycle.steps, to: fewer.steps }]);
  });

  it("a moved band changes the band a score falls in", () => {
    const a = auditScorecard(DEFAULT_RULES);
    expect(auditBandFor(a, 70)?.key).toBe("fair");
    const moved = validateSection("audit", edit("audit", (v) => { v.bands[0].from = 65; }));
    expect(auditBandFor(moved, 70)?.key).toBe("strong");
    expect(auditBandFor(a, null)).toBeNull();
    expect(auditBandFor(a, 0)?.key).toBe("needs_work");
  });
});

// ── The reader and the save, against a scripted client ──────────────────────────────────────────────────────────────────
interface Stored { version: number; rules: RulesDoc; defaults_version: string; effective_from: string; section: string; reset: boolean }
function fakeDb(stored: Stored[] = []) {
  const calls: string[] = [];
  const c = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push(sql);
      if (/FROM social_rule_versions WHERE tenant_id = \$1 ORDER BY version DESC LIMIT 1/.test(sql)) {
        const top = [...stored].sort((x, y) => y.version - x.version)[0];
        return { rows: top ? [top] : [] };
      }
      if (/FROM social_rule_versions WHERE tenant_id = \$1 AND version = \$2/.test(sql)) {
        return { rows: stored.filter((s) => s.version === params[1]) };
      }
      if (/^\s*INSERT INTO social_rule_versions/.test(sql)) {
        stored.push({ version: params[1] as number, rules: JSON.parse(params[2] as string), section: params[3] as string, reset: params[4] as boolean,
          defaults_version: params[5] as string, effective_from: new Date().toISOString() });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return { c: c as unknown as PoolClient, calls, stored, reads: () => calls.filter((s) => /FROM social_rule_versions/.test(s)).length };
}
const T = "00000000-0000-0000-0000-0000000000a1";

describe("W5-A0 · the read-through reader and the versioned save", () => {
  it("a company with no row reads the seed as version 0", async () => {
    const { c } = fakeDb();
    const r = await socialRules(c, T);
    expect(r).toEqual({ ref: `default:${DEFAULTS_VERSION}`, version: 0, defaultsVersion: DEFAULTS_VERSION, rules: DEFAULT_RULES, effectiveFrom: null });
    expect(rulesRefFor(r)).toBe(`default:${DEFAULTS_VERSION}`);
  });

  it("is read once per request, and again in the next", async () => {
    const db = fakeDb();
    await runWithRequestContext(async () => {
      await socialRules(db.c, T);
      await socialRules(db.c, T);
      await socialRules(db.c, T.toUpperCase());
    });
    expect(db.reads()).toBe(1);
    await runWithRequestContext(() => socialRules(db.c, T));
    expect(db.reads()).toBe(2);
    await socialRules(db.c, T); // no request: no memo
    await socialRules(db.c, T);
    expect(db.reads()).toBe(4);
  });

  it("a save writes version + 1 with the whole document, the other sections unchanged; a stale expectedVersion is 409 rules_changed", async () => {
    const db = fakeDb();
    await runWithRequestContext(async () => {
      expect((await socialRules(db.c, T)).version).toBe(0);
      const value = validateSection("ideas", { metricRequired: false, sharedInMonthlyReport: true });
      const r1 = await saveRulesSectionInTx(db.c, { tenantId: T, actorId: "u1", section: "ideas", expectedVersion: 0, value, reset: false });
      expect(r1).toEqual({ version: 1, diff: [
        { path: "ideas.metricRequired", from: true, to: false }, { path: "ideas.sharedInMonthlyReport", from: false, to: true },
      ] });
      // The memo was dropped by the save: the next read sees version 1.
      const now = await socialRules(db.c, T);
      expect(now).toMatchObject({ ref: "company:1", version: 1 });
      expect(now.rules.ideas).toEqual(value);
      expect(now.rules.reports).toEqual(DEFAULT_RULES.reports);
      await expect(saveRulesSectionInTx(db.c, { tenantId: T, actorId: "u1", section: "ideas", expectedVersion: 0, value, reset: false }))
        .rejects.toMatchObject({ response: { message: "rules_changed", detail: { currentVersion: 1 } }, status: 409 });
      const r2 = await saveRulesSectionInTx(db.c, { tenantId: T, actorId: "u1", section: "ideas", expectedVersion: 1, reset: true });
      expect(r2.version).toBe(2);
      expect(db.stored[1]).toMatchObject({ section: "ideas", reset: true, defaults_version: DEFAULTS_VERSION });
      expect(db.stored[1].rules.ideas).toEqual(DEFAULT_RULES.ideas);
    });
    // The company's lock is taken before the version is read, and the insert comes last.
    const lock = db.calls.findIndex((q) => /pg_advisory_xact_lock/.test(q));
    const insert = db.calls.findIndex((q) => /INSERT INTO social_rule_versions/.test(q));
    const readAfterLock = db.calls.findIndex((q, i) => i > lock && /ORDER BY version DESC LIMIT 1/.test(q));
    expect(lock).toBeGreaterThan(-1);
    expect(readAfterLock).toBeGreaterThan(lock);
    expect(insert).toBeGreaterThan(readAfterLock);
  });

  it("a record keeps its own rules: rulesByRef reads the version it names, after later saves", async () => {
    const db = fakeDb();
    const v1 = validateSection("reports", edit("reports", (v) => { v.fiscalYearStartMonth = 4; }));
    await saveRulesSectionInTx(db.c, { tenantId: T, actorId: "u1", section: "reports", expectedVersion: 0, value: v1, reset: false });
    const ref = rulesRefFor(await socialRules(db.c, T));
    const v2 = validateSection("reports", edit("reports", (v) => { v.fiscalYearStartMonth = 7; }));
    await saveRulesSectionInTx(db.c, { tenantId: T, actorId: "u1", section: "reports", expectedVersion: 1, value: v2, reset: false });
    expect(ref).toBe("company:1");
    expect(fiscalYearStartMonth((await rulesByRef(db.c, T, ref)).rules)).toBe(4);
    expect(fiscalYearStartMonth((await socialRules(db.c, T)).rules)).toBe(7);
    await expect(rulesByRef(db.c, T, "company:9")).rejects.toMatchObject({ response: { message: "rules_ref_unknown" } });
    await expect(rulesByRef(db.c, T, "default:never-seeded")).rejects.toMatchObject({ response: { message: "rules_ref_unknown" } });
    await expect(rulesByRef(db.c, T, "garbage")).rejects.toMatchObject({ response: { message: "rules_ref_unknown" } });
  });
});

// ── Periods and due dates ───────────────────────────────────────────────────────────────────────────────────────────────
const MON_FRI = {};

describe("W5-A0 · periods, due dates and cycle steps", () => {
  it("calendar periods by default; a fiscal year starting in April makes Q1 April to June", () => {
    expect(periodOf("quarterly", "2026-11-09")).toBe("2026-Q4");
    expect(periodRange("quarterly", "2026-Q4")).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    expect(periodOf("quarterly", "2026-05-02", 4)).toBe("2026-Q1");
    expect(periodRange("quarterly", "2026-Q1", 4)).toEqual({ start: "2026-04-01", end: "2026-06-30" });
    expect(periodOf("quarterly", "2027-02-10", 4)).toBe("2026-Q4"); // named by the year the fiscal year starts in
    expect(periodRange("quarterly", "2026-Q4", 4)).toEqual({ start: "2027-01-01", end: "2027-03-31" });
    expect(periodOf("semester", "2026-07-01")).toBe("2026-H2");
    expect(periodRange("semester", "2026-H2", 4)).toEqual({ start: "2026-10-01", end: "2027-03-31" });
    expect(periodOf("yearly", "2027-03-31", 4)).toBe("2026");
    expect(periodRange("yearly", "2026", 4)).toEqual({ start: "2026-04-01", end: "2027-03-31" });
    expect(periodRange("yearly", "2026")).toEqual({ start: "2026-01-01", end: "2026-12-31" });
    expect(periodOf("monthly", "2026-11-09", 4)).toBe("2026-11"); // the month is never fiscal
  });

  it("ISO weeks, and periods that do not exist", () => {
    expect(isoWeekKey("2026-11-09")).toBe("2026-W46");
    expect(isoWeekKey("2027-01-01")).toBe("2026-W53");
    expect(periodRange("weekly", "2026-W53")).toEqual({ start: "2026-12-28", end: "2027-01-03" });
    expect(periodRange("weekly", "2025-W53")).toBeNull();
    expect(isoWeekKey("2024-12-30")).toBe("2025-W01");
    expect(periodRange("daily", "2026-02-30")).toBeNull();
    expect(periodRange("quarterly", "2026-Q5")).toBeNull();
    expect(periodRange("monthly", "2026-13")).toBeNull();
  });

  it("each due rule", () => {
    const week = periodRange("weekly", "2026-W46")!; // Mon 9 to Sun 15 Nov 2026
    expect(reportDueDate({ rule: "working_days_after", n: 1 }, week, { reportDueDay: null, calendar: MON_FRI })).toBe("2026-11-16");
    expect(reportDueDate({ rule: "working_days_after", n: 1 }, { start: "2026-11-13", end: "2026-11-13" }, { reportDueDay: null, calendar: MON_FRI })).toBe("2026-11-16");
    const holiday = { holidays: [{ day: "2026-11-16", kind: "public" as const }] };
    expect(reportDueDate({ rule: "working_days_after", n: 1 }, week, { reportDueDay: null, calendar: holiday })).toBe("2026-11-17");
    expect(reportDueDate({ rule: "weekday", weekday: 2, week: "next" }, week, { reportDueDay: null, calendar: MON_FRI })).toBe("2026-11-17");
    expect(reportDueDate({ rule: "weekday", weekday: 5, week: "same" }, week, { reportDueDay: null, calendar: MON_FRI })).toBe("2026-11-13");
    expect(reportDueDate({ rule: "report_due_day" }, periodRange("monthly", "2026-12")!, { reportDueDay: 31, calendar: MON_FRI })).toBe("2027-01-31");
    expect(reportDueDate({ rule: "report_due_day" }, periodRange("monthly", "2026-10")!, { reportDueDay: 31, calendar: MON_FRI })).toBe("2026-11-30");
    expect(reportDueDate({ rule: "report_due_day" }, periodRange("quarterly", "2026-Q4")!, { reportDueDay: 5, calendar: MON_FRI })).toBe("2027-01-05");
    expect(reportDueDate({ rule: "report_due_day" }, periodRange("quarterly", "2026-Q4")!, { reportDueDay: null, calendar: MON_FRI })).toBeNull();
  });

  it("the next due date of each kind", () => {
    const dues = nextReportDues(DEFAULT_RULES.reports, "2026-11-10", { reportDueDay: 5, calendar: MON_FRI });
    expect(dues.map((d) => [d.kind, d.period, d.due])).toEqual([
      ["daily", "2026-11-09", "2026-11-10"],
      ["weekly", "2026-W46", "2026-11-16"], // W45 fell due on Monday the 9th, already past
      ["monthly", "2026-11", "2026-12-05"],
      ["quarterly", "2026-Q4", "2027-01-05"],
      ["semester", "2026-H2", "2027-01-05"],
      ["yearly", "2026", "2027-01-05"],
    ]);
  });

  it("cycle steps: due dates with and without estimates, the report step, the titles", () => {
    const steps = DEFAULT_RULES.cycle.steps;
    const ctx = { readyBy: "2026-11-20", estimates: {}, reportDueDay: 31, calendar: MON_FRI };
    // Without estimates every step but the report falls due on ready-by.
    expect(steps.map((s) => cycleStepDueDate(s, "2026-12", ctx))).toEqual(["2026-11-30", "2026-11-20", "2026-11-20", "2026-11-20", "2026-11-20", "2026-11-20"]);
    const est = { ...ctx, estimates: { proofread: 1, hod: 1, design: 3, final: 1, client: 2, schedule: 1 } };
    // planning: R less 9; copy_lock: R less 7; artwork: R less 4; client_window: R less 1; deploy: R.
    expect(steps.map((s) => cycleStepDueDate(s, "2026-12", est))).toEqual(["2026-11-30", "2026-11-09", "2026-11-11", "2026-11-16", "2026-11-19", "2026-11-20"]);
    expect(cycleStepDueDate(steps[0], "2026-12", { ...ctx, reportDueDay: null })).toBeNull();
    expect(cycleStepDueDate({ due: { rule: "none" } }, "2026-12", ctx)).toBeNull();
    expect(cycleStepDueDate({ due: { rule: "ready_by", lessEstimatesFrom: null, lessWorkingDays: 2 } }, "2026-12", ctx)).toBe("2026-11-18");
    expect(steps.map((s) => cycleStepTitle(s, "2027-01"))).toEqual([
      "Monthly report for November 2026", "January 2027 plan", "January 2027 copy locked", "January 2027 artwork",
      "January 2027 client approval", "January 2027 scheduled",
    ]);
  });
});
