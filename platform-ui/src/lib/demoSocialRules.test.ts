import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// SCP-5 W5-C5 (BFF §63.30.4): DEMO_MODE's twin of the company rules, in the server's order of checks. The preview counts from today, so the clock is pinned to Wednesday 14 October 2026 before the module
// is imported (hence vi.hoisted); only Date is faked. Every test starts from the seed, version 0.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import { demoRulesRoute, resetDemoSocialRules } from "./demoSocialRules";
import { demoValidateSection } from "./demoSocialRulesValidate";
import { socialDemo } from "./demoSocial";
import { PIPE_ENGAGEMENTS } from "./demoSocialPipeline";
import { asHistory, asPreview, asRulesAnswer, cloneJson, type RulesDoc } from "./socialRules";
import seed from "./socialRulesDefaults.json";

const USER = { hod: "u-pm", gm: "u-gm", owner: "demo-owner", officer: "u-social", client: "demo-client", bot: "demo-bot" };
const { _about: _a, defaultsVersion: _d, ...SEED } = seed as unknown as { _about: string; defaultsVersion: string } & RulesDoc;
const doc = (): RulesDoc => cloneJson(SEED as RulesDoc);
const E1 = PIPE_ENGAGEMENTS.find((e) => e.status !== "closed")!.id;

beforeEach(() => { resetDemoSocialRules(); vi.setSystemTime(new Date("2026-10-14T04:00:00Z")); });

const call = (m: string, tail: string, user: string, body?: unknown, query = "") => {
  const r = demoRulesRoute(m, tail, new URLSearchParams(query), body === undefined ? undefined : JSON.stringify(body), user);
  expect(r, `${m} ${tail} is a rules route`).not.toBeNull();
  return r!;
};
const error = (r: { json: unknown }) => (r.json as { error: string }).error;
const refused = (r: { status: number; json: unknown }, status: number, code: string) => { expect([r.status, error(r)]).toEqual([status, code]); };
const read = (user = USER.hod) => asRulesAnswer(call("GET", "rules", user).json);
const put = (section: string, expectedVersion: number, value: unknown, user = USER.hod) => call("PUT", `rules/${section}`, user, { expectedVersion, value });

describe("the read", () => {
  it("answers the seed as version 0, with the defaults beside it and nothing changed", () => {
    const a = read();
    expect(a.version).toBe(0);
    expect(a.defaultsVersion).toBe("scp5-2026-10-30");
    expect(a.rules).toEqual(doc());
    expect(a.defaults).toEqual(doc());
    expect(Object.values(a.sections).every((s) => !s.changed && s.version === 0 && s.editedBy === null)).toBe(true);
  });
  it("lets the four edit and every other staff member read only, and refuses a client contact", () => {
    for (const u of [USER.hod, USER.gm, USER.owner, "demo-hansel"]) expect(read(u).canEdit, u).toBe(true);
    expect(read(USER.officer).canEdit).toBe(false);
    expect(read(USER.bot).canEdit).toBe(false);
    expect(call("GET", "rules", USER.client).status).toBe(403);
  });
  it("is wired into the social demo, and is not another route's", () => {
    expect(socialDemo("GET", "/api/co-1/modules/social/rules", new URLSearchParams(), undefined, USER.hod)?.status).toBe(200);
    expect(demoRulesRoute("GET", "settings", new URLSearchParams(), undefined, USER.hod)).toBeNull();
    expect(demoRulesRoute("DELETE", "rules/cycle", new URLSearchParams(), undefined, USER.hod)).toBeNull();
  });
});

describe("a save", () => {
  it("writes version + 1 with only that section changed, and answers the read", () => {
    const v = doc().cycle;
    v.steps[0].title = "A new first step for {month}";
    const r = put("cycle", 0, v);
    expect(r.status).toBe(200);
    const a = asRulesAnswer(r.json);
    expect(a.version).toBe(1);
    expect(a.rules.cycle.steps[0].title).toBe("A new first step for {month}");
    expect(a.rules.reports).toEqual(doc().reports);
    expect(a.sections.cycle).toMatchObject({ changed: true, version: 1, editedBy: { id: USER.hod } });
    expect(a.sections.reports).toMatchObject({ changed: false, version: 0 });
    expect(read().version).toBe(1);
  });
  it("two saves make two consecutive versions, and a section keeps the version of its own last save", () => {
    const ideas = { metricRequired: false, sharedInMonthlyReport: true };
    expect(asRulesAnswer(put("ideas", 0, ideas).json).version).toBe(1);
    const cyc = doc().cycle;
    cyc.steps[1].title = "Second";
    const a = asRulesAnswer(put("cycle", 1, cyc).json);
    expect(a.version).toBe(2);
    expect(a.sections.ideas.version).toBe(1);
    expect(a.sections.cycle.version).toBe(2);
  });
  it("refuses a stale expectedVersion with 409 rules_changed and the current version, and writes nothing", () => {
    put("ideas", 0, { metricRequired: false, sharedInMonthlyReport: false });
    const r = put("ideas", 0, { metricRequired: true, sharedInMonthlyReport: true });
    refused(r, 409, "rules_changed");
    expect((r.json as { detail: { currentVersion: number } }).detail.currentVersion).toBe(1);
    expect(read().rules.ideas).toEqual({ metricRequired: false, sharedInMonthlyReport: false });
  });
  it("normalises labels (trimmed) as the server does", () => {
    const s = doc().saved;
    s.categories[0].label = "  Tidy label  ";
    expect(asRulesAnswer(put("saved", 0, s).json).rules.saved.categories[0].label).toBe("Tidy label");
  });
});

describe("the order of checks: automation, the gate, then the body (400), then the version (409)", () => {
  it("answers an automation 403 automation_cannot_act before anything, even a bad body", () => {
    refused(call("PUT", "rules/cycle", USER.bot, { nonsense: true }), 403, "automation_cannot_act");
    refused(call("POST", "rules/preview", USER.bot, {}), 403, "automation_cannot_act");
    refused(call("GET", "rules/versions", USER.bot), 403, "automation_cannot_act");
  });
  it("refuses anyone but the four with 403 not_a_social_approver, decided before the body is read", () => {
    refused(call("PUT", "rules/cycle", USER.officer, { nonsense: true }), 403, "not_a_social_approver");
    refused(call("POST", "rules/cycle/reset", USER.officer, { expectedVersion: 0 }), 403, "not_a_social_approver");
    refused(call("POST", "rules/preview", USER.officer, { section: "cycle" }), 403, "not_a_social_approver");
    refused(call("GET", "rules/versions", USER.officer), 403, "not_a_social_approver");
  });
  it("answers 400 invalid_field for the request before the value: the section, the keys, expectedVersion, value", () => {
    const f = (r: { json: unknown }) => (r.json as { field: string }).field;
    const bad = (r: { status: number; json: unknown }, field: string) => { refused(r, 400, "invalid_field"); expect(f(r)).toBe(field); };
    bad(call("PUT", "rules/bogus", USER.hod, { expectedVersion: 0, value: {} }), "section");
    bad(call("PUT", "rules/cycle", USER.hod, { expectedVersion: 0, value: {}, extra: 1 }), "extra");
    bad(call("PUT", "rules/cycle", USER.hod, { value: {} }), "expectedVersion");
    bad(call("PUT", "rules/cycle", USER.hod, { expectedVersion: 1.5, value: {} }), "expectedVersion");
    bad(call("PUT", "rules/cycle", USER.hod, { expectedVersion: 0 }), "value");
    bad(call("POST", "rules/cycle/reset", USER.hod, { expectedVersion: 0, value: {} }), "value");
  });
  it("answers the value's own field before the version: a bad value on a stale version is a 400, not a 409", () => {
    put("ideas", 0, { metricRequired: false, sharedInMonthlyReport: false });
    const r = put("ideas", 0, { metricRequired: "yes", sharedInMonthlyReport: false });
    refused(r, 400, "invalid_field");
    expect((r.json as { field: string }).field).toBe("ideas.metricRequired");
  });
});

describe("each section's validation names its field", () => {
  const field = (section: string, value: unknown) => {
    const r = put(section, 0, value);
    refused(r, 400, "invalid_field");
    return (r.json as { field: string }).field;
  };
  it("reports: a due rule the kind cannot take, a nextPeriodLine on a long kind, a check part the content turns off, a range", () => {
    const d = doc().reports;
    d.kinds.daily.due = { rule: "report_due_day" };
    expect(field("reports", d)).toBe("reports.kinds.daily.due");
    const e = doc().reports;
    e.kinds.monthly.content.nextPeriodLine = true;
    expect(field("reports", e)).toBe("reports.kinds.monthly.content.nextPeriodLine");
    const f = doc().reports;
    f.kinds.weekly.checkRequires = ["notes"];
    expect(field("reports", f)).toBe("reports.kinds.weekly.checkRequires");
    const g = doc().reports;
    g.fiscalYearStartMonth = 13;
    expect(field("reports", g)).toBe("reports.fiscalYearStartMonth");
    const h = doc().reports;
    h.kinds.weekly.content.narrative.max = 50;
    expect(field("reports", h)).toBe("reports.kinds.weekly.content.narrative.max");
    expect(field("reports", { ...doc().reports, surprise: 1 })).toBe("reports.surprise");
  });
  it("cycle: a repeated key, a bad title token, and the step count", () => {
    const a = doc().cycle;
    a.steps[1].key = a.steps[0].key;
    expect(field("cycle", a)).toBe("cycle.steps.1.key");
    const b = doc().cycle;
    b.steps[0].title = "Plan for {mnth}";
    expect(field("cycle", b)).toBe("cycle.steps.0.title");
    expect(field("cycle", { steps: [] })).toBe("cycle.steps");
  });
  it("audit: bands out of order, a repeated automatic source, a typed benchmark outside 0 to 1", () => {
    const a = doc().audit;
    a.bands = [{ key: "low", label: "Low", from: 0 }, { key: "high", label: "High", from: 75 }];
    expect(field("audit", a)).toBe("audit.bands");
    const b = doc().audit;
    b.bands[b.bands.length - 1].from = 5;
    expect(field("audit", b)).toBe("audit.bands");
    const c = doc().audit;
    const first = c.dimensions.find((d) => d.source !== "typed")!;
    const second = c.dimensions.filter((d) => d.source !== "typed")[1];
    second.source = first.source;
    expect(field("audit", c)).toMatch(/^audit\.dimensions\.\d+\.source$/);
    const d = doc().audit;
    d.benchmark = { source: "typed", rates: { Cafe: 4 } };
    expect(field("audit", d)).toBe("audit.benchmark.rates.Cafe");
  });
  it("saved: a category that holds nothing, a derived category removed or given other contents", () => {
    const a = doc().saved;
    a.categories[0].holds = [];
    expect(field("saved", a)).toBe("saved.categories.0.holds");
    const b = doc().saved;
    b.categories = b.categories.filter((c) => c.key !== "photos");
    expect(field("saved", b)).toBe("saved.categories");
    const c = doc().saved;
    const photos = c.categories.find((x) => x.key === "photos")!;
    photos.holds = ["text"];
    expect(field("saved", c)).toMatch(/\.holds$/);
  });
  it("the validator has no key for who acts, the one-report rule or drafting-only AI, so an unknown key is refused", () => {
    expect(demoValidateSection("ideas", { metricRequired: true, sharedInMonthlyReport: false, whoMayApprove: ["anyone"] })).toEqual({ ok: false, field: "ideas.whoMayApprove" });
    expect(demoValidateSection("ideas", { metricRequired: true, sharedInMonthlyReport: false })).toMatchObject({ ok: true });
  });
});

describe("reset", () => {
  it("writes a new version whose section is the seed's, and keeps the history of the edit before it", () => {
    put("ideas", 0, { metricRequired: false, sharedInMonthlyReport: true });
    const r = call("POST", "rules/ideas/reset", USER.gm, { expectedVersion: 1 });
    expect(r.status).toBe(200);
    const a = asRulesAnswer(r.json);
    expect(a.version).toBe(2);
    expect(a.rules.ideas).toEqual(SEED.ideas);
    expect(a.sections.ideas).toMatchObject({ changed: false, version: 2, editedBy: { id: USER.gm } });
    const h = asHistory(call("GET", "rules/versions", USER.hod, undefined, "section=ideas").json);
    expect(h.items.map((i) => [i.version, i.reset])).toEqual([[2, true], [1, false]]);
  });
  it("answers 409 rules_changed for a stale version", () => {
    put("ideas", 0, { metricRequired: false, sharedInMonthlyReport: true });
    refused(call("POST", "rules/ideas/reset", USER.hod, { expectedVersion: 0 }), 409, "rules_changed");
  });
});

describe("the history", () => {
  it("lists the versions newest first with each diff against the version before, for one section or all", () => {
    put("ideas", 0, { metricRequired: false, sharedInMonthlyReport: false });
    const cyc = doc().cycle;
    cyc.steps[0].title = "First";
    put("cycle", 1, cyc, USER.gm);
    const all = asHistory(call("GET", "rules/versions", USER.hod).json);
    expect(all.items.map((i) => [i.version, i.section])).toEqual([[2, "cycle"], [1, "ideas"]]);
    expect(all.items[0].editedBy.id).toBe(USER.gm);
    expect(all.items[0].diff).toEqual([{ path: "cycle.steps.0.title", from: SEED.cycle.steps[0].title, to: "First" }]);
    expect(all.items[1].diff.map((d) => d.path)).toEqual(["ideas.metricRequired"]);
    expect(asHistory(call("GET", "rules/versions", USER.hod, undefined, "section=cycle").json).items).toHaveLength(1);
  });
  it("pages with a cursor and refuses a bad section, cursor or limit", () => {
    for (let v = 0; v < 3; v++) put("ideas", v, { metricRequired: v % 2 === 1, sharedInMonthlyReport: false });
    const p1 = asHistory(call("GET", "rules/versions", USER.hod, undefined, "limit=2").json);
    expect(p1.items.map((i) => i.version)).toEqual([3, 2]);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = asHistory(call("GET", "rules/versions", USER.hod, undefined, `limit=2&cursor=${p1.nextCursor}`).json);
    expect(p2.items.map((i) => i.version)).toEqual([1]);
    expect(p2.nextCursor).toBeNull();
    for (const q of ["section=bogus", "cursor=!!", "limit=0", "limit=101"]) refused(call("GET", "rules/versions", USER.hod, undefined, q), 400, "invalid_field");
  });
});

describe("the preview", () => {
  const preview = (body: unknown, user = USER.hod) => call("POST", "rules/preview", user, body);
  it("answers the next due date of each report kind and saves nothing", () => {
    const r = preview({ section: "reports", value: doc().reports });
    expect(r.status).toBe(200);
    const p = asPreview(r.json);
    expect(p.reports?.map((x) => x.kind)).toEqual(["daily", "weekly", "monthly", "quarterly", "semester", "yearly"]);
    // Wednesday 14 October 2026: yesterday's day report is due today (1 working day after), so it is the next one
    expect(p.reports![0]).toMatchObject({ kind: "daily", period: "2026-10-13", due: "2026-10-14" });
    expect(p.reports![1]).toMatchObject({ kind: "weekly", period: "2026-W42", due: "2026-10-19" });
    expect(p.reports![2]).toMatchObject({ kind: "monthly", period: "2026-10", due: null });
    expect(p.reason).toBe("no_client");
    expect(read().version).toBe(0);
  });
  it("moves the dates with the rule: a weekday due rule, and a fiscal year starting in April (Q1 is April to June)", () => {
    const v = doc().reports;
    v.kinds.weekly.due = { rule: "weekday", weekday: 5, week: "next" };
    v.fiscalYearStartMonth = 4;
    const p = asPreview(preview({ section: "reports", value: v }).json);
    // last week (W41, the 5th to the 11th) has its due day on Friday the 16th, which is still ahead
    expect(p.reports![1]).toMatchObject({ period: "2026-W41", due: "2026-10-16" });
    expect(p.reports![3]).toMatchObject({ kind: "quarterly", period: "2026-Q3" });
    expect(p.reports![3].range).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    expect(p.reports![5]).toMatchObject({ kind: "yearly", period: "2026" });
  });
  it("answers the next cycle's step dates for a chosen client, and says why it is empty without one", () => {
    const none = asPreview(preview({ section: "cycle", value: doc().cycle }).json);
    expect(none.steps).toEqual([]);
    expect(none.reason).toBe("no_client");
    const p = asPreview(preview({ section: "cycle", value: doc().cycle, engagementId: E1 }).json);
    expect(p.cycle).toMatchObject({ month: "2026-11" });
    expect(p.steps!.map((s) => s.key)).toEqual(SEED.cycle.steps.map((s) => s.key));
    expect(p.steps![0].title).toMatch(/2026$/);
    expect(p.steps!.every((s) => !/[{}]/.test(s.title))).toBe(true);
  });
  it("answers a client's score under the edited scorecard", () => {
    const none = asPreview(preview({ section: "audit", value: doc().audit }).json);
    expect(none.audit).toBeNull();
    expect(none.reason).toBe("no_client");
    const p = asPreview(preview({ section: "audit", value: doc().audit, engagementId: E1 }).json);
    expect(p.audit?.overall).toBeGreaterThanOrEqual(0);
    expect(p.audit?.total).toBe(SEED.audit.dimensions.length);
    expect(p.audit?.bandLabel).toBeTruthy();
  });
  it("has nothing to preview for ideas or Saved, and says so with no part", () => {
    const p = asPreview(preview({ section: "ideas", value: doc().ideas }).json);
    expect([p.reports, p.steps, p.audit]).toEqual([null, null, null]);
  });
  it("checks in the server's order: 400 for the request and the value, then 404 for an unknown client", () => {
    refused(preview({ section: "bogus", value: {} }), 400, "invalid_field");
    refused(preview({ section: "cycle" }), 400, "invalid_field");
    refused(preview({ section: "cycle", value: { steps: [] } }), 400, "invalid_field");
    refused(preview({ section: "cycle", value: doc().cycle, engagementId: "bad id!" }), 400, "invalid_field");
    refused(preview({ section: "cycle", value: doc().cycle, engagementId: "nobody" }), 404, "engagement_not_found");
    refused(preview({ section: "cycle", value: { steps: [] }, engagementId: "nobody" }), 400, "invalid_field");
  });
});
