// SCP-5g (W5-B4) — the audit's PURE scoring, pinned by a GOLDEN TABLE (audit-golden.json: facts to scores, and scores to the overall, band and fixes), plus the
// helpers around it (rounding, the ISO weeks, the median and the benchmark, the parsers, the summary guard). No database, no Cerbos: runs anywhere.
//
// WHAT THE TABLE PINS (BFF §63.28.1, §63.28.6)
//   the six automatic rules, each with its reason: no target, no allocated formats, no benchmark (none, or 0), no rate, no reels, a reel with no rate, no feed
//   baseline, a month touching six weeks (and five and four), no agreed budget; a quarter rounds UP; capped at 5; a real 0 is not none;
//   the overall over the scored dimensions only, half up, in integers: 67.5 → 68, 2.5 → 3, 74.5 → 75, 49.5 → 50; the band edges 75 and 50 inclusive (and 74.4,
//   49.4 below them); a zero weight; all weights zero; unequal and fractional weights; custom bands; the fixes (three lowest, ties in scorecard order);
//   a prospect's twelve typed scores; a typed score over an automatic one.
import { describe, it, expect } from "vitest";
import golden from "./audit-golden.json";
import {
  composeScorecard, fixesOf, isHalfScore, isoWeeksTouching, median, meanOf, monthsBefore, nextMonthStart, overallOf, ratioScore, resolveBenchmark,
  scoreAutomatic, weekStartOf, type AutoInputs, type AutoResult, type AutoSource, type LivePost, type TypedScore,
} from "./audit-score";
import {
  applyScoresPatch, buildFrozen, buildSummaryPrompt, parseAuditCreate, parseAuditListQuery, parseAuditPatch, parseAttach, parseMonth, parsePublicNumbers,
  parseSummaryDraft, readStoredScores, sortWorstFirst, summaryFactsOf, templateSummary, ungroundedNumbers, type SummaryFacts,
} from "./audit";
import { socialModule } from "../index";
import { DEFAULT_RULES, type AuditRules } from "./rules";

interface GoldenPost { format: string; liveOn: string; rate?: number; isExtra?: boolean; simulated?: boolean; count?: number }
interface GoldenAuto {
  name: string; month: string; target: number | null; formats: string[]; posts: GoldenPost[];
  benchmark: AutoInputs["benchmark"]; boosts: AutoInputs["boosts"];
  expect: Record<string, { score: number | null; reason: string | null }>;
}
interface GoldenCard {
  name: string; subject: "client" | "prospect"; rules: { dimensions: Array<{ key: string; weight: number; source: string }>; bands: AuditRules["bands"] } | null;
  auto: Record<string, number | null> | null; typed: Record<string, number | { score: number | null; note: string }>;
  expect: { overall?: number | null; band?: string | null; scored?: number; total?: number; fixes?: string[]; used?: Record<string, number | null> };
}
const table = golden as unknown as { automatic: GoldenAuto[]; scorecards: GoldenCard[] };

const livePosts = (g: GoldenPost[]): LivePost[] =>
  g.flatMap((p) => Array.from({ length: p.count ?? 1 }, (): LivePost => ({
    format: p.format, isExtra: p.isExtra === true, weekStart: weekStartOf(p.liveOn), rate: p.rate ?? null, simulated: p.simulated === true,
  })));

describe("the golden table: facts to automatic scores", () => {
  it("covers the six rules and every reason the contract names", () => {
    const reasons = new Set(table.automatic.flatMap((c) => Object.values(c.expect).map((e) => e.reason)).filter((r) => r !== null));
    expect([...reasons].sort()).toEqual(["no_agreed_budget", "no_allocated_formats", "no_benchmark", "no_feed_baseline", "no_rate", "no_reel_rate", "no_reels", "no_target"]);
    const keys = new Set(table.automatic.flatMap((c) => Object.keys(c.expect)));
    expect([...keys].sort()).toEqual(["boosting", "consistency", "engagement_rate", "format_mix", "reels", "stories"]);
  });
  for (const c of table.automatic) {
    it(c.name, () => {
      const inputs: AutoInputs = {
        target: c.target, allocatedFormats: c.formats, posts: livePosts(c.posts), weeks: isoWeeksTouching(c.month), benchmark: c.benchmark, boosts: c.boosts,
      };
      const got = scoreAutomatic(inputs);
      for (const [key, want] of Object.entries(c.expect)) {
        expect({ score: got[key as AutoSource].score, reason: got[key as AutoSource].reason }, key).toEqual(want);
      }
    });
  }
});

function cardOf(c: GoldenCard) {
  const dims = c.rules
    ? c.rules.dimensions.map((d) => ({ key: d.key, label: d.key.toUpperCase(), weight: d.weight, source: d.source as AuditRules["dimensions"][number]["source"], advice: `advice ${d.key}` }))
    : DEFAULT_RULES.audit.dimensions;
  const rules: AuditRules = { dimensions: dims, bands: c.rules ? c.rules.bands : DEFAULT_RULES.audit.bands, benchmark: { source: "own_clients_median" } };
  const auto = c.auto === null ? null : Object.fromEntries(Object.entries(c.auto).map(([k, v]): [string, AutoResult] => [
    k, { score: v, reason: v === null ? "no_target" : null, evidence: { actual: null, expected: null, unit: "posts" } },
  ])) as Partial<Record<AutoSource, AutoResult>>;
  const typed: Record<string, TypedScore> = Object.fromEntries(Object.entries(c.typed).map(([k, v]): [string, TypedScore] => [k, typeof v === "number" ? { score: v, note: "" } : v]));
  return composeScorecard({ rules, auto, typed });
}

describe("the golden table: scores to the overall, the band and the fixes", () => {
  for (const c of table.scorecards) {
    it(c.name, () => {
      const card = cardOf(c);
      if ("overall" in c.expect) expect(card.overall, "overall").toBe(c.expect.overall);
      if ("band" in c.expect) expect(card.band?.key ?? null, "band").toBe(c.expect.band);
      if (c.expect.scored !== undefined) expect(card.scored, "scored").toBe(c.expect.scored);
      if (c.expect.total !== undefined) expect(card.total, "total").toBe(c.expect.total);
      if (c.expect.fixes) expect(card.fixes.map((f) => f.key), "fixes").toEqual(c.expect.fixes);
      for (const [k, v] of Object.entries(c.expect.used ?? {})) expect(card.dimensions.find((d) => d.key === k)?.used, `used ${k}`).toBe(v);
    });
  }
  it("the band edges at 75 and 50 are in the table, from both sides", () => {
    const edge = table.scorecards.filter((c) => [75, 74, 50, 49].includes(c.expect.overall as number)).map((c) => `${c.expect.overall}:${c.expect.band}`);
    expect(edge).toEqual(expect.arrayContaining(["75:strong", "74:fair", "50:fair", "49:needs_work"]));
  });
});

describe("the seeded scorecard is SCP-Q32's", () => {
  it("twelve dimensions of weight 1, six automatic and six typed; bands from 75 and 50; our own clients' median", () => {
    const a = DEFAULT_RULES.audit;
    expect(a.dimensions).toHaveLength(12);
    expect(a.dimensions.every((d) => d.weight === 1)).toBe(true);
    expect(a.dimensions.filter((d) => d.source !== "typed").map((d) => d.source)).toEqual(["consistency", "format_mix", "engagement_rate", "reels", "stories", "boosting"]);
    expect(a.dimensions.filter((d) => d.source === "typed")).toHaveLength(6);
    expect(a.bands.map((b) => [b.key, b.from])).toEqual([["strong", 75], ["fair", 50], ["needs_work", 0]]);
    expect(a.benchmark).toEqual({ source: "own_clients_median" });
  });
});

describe("rounding and integer overall", () => {
  it("ratioScore: the nearest half, a quarter up, capped", () => {
    expect([[1, 4], [3, 4], [9, 20], [7, 20], [1, 40], [3, 3], [9, 3], [0, 5]].map(([a, e]) => ratioScore(a, e))).toEqual([1.5, 4, 2.5, 2, 0, 5, 5, 0]); // 3 of 4 is 3.75: a quarter, up to 4
  });
  it("ratioScore never returns a value off the half grid, for any ratio", () => {
    for (let e = 1; e <= 40; e++) for (let a = 0; a <= 50; a++) expect(isHalfScore(ratioScore(a, e)), `${a}/${e}`).toBe(true);
  });
  it("overallOf is exact on halves and weights of two decimals: nothing drifts across a .5", () => {
    expect(overallOf([{ weight: 7.45, used: 5 }, { weight: 2.55, used: 0 }])).toBe(75);
    expect(overallOf([{ weight: 7.44, used: 5 }, { weight: 2.56, used: 0 }])).toBe(74);
    expect(overallOf([{ weight: 0.1, used: 5 }, { weight: 0.2, used: 5 }, { weight: 0.3, used: 0 }])).toBe(50);
    expect(overallOf([])).toBeNull();
    expect(overallOf([{ weight: 1, used: null }])).toBeNull();
    expect(overallOf([{ weight: 0, used: 4 }])).toBeNull();
  });
  it("isHalfScore", () => {
    for (const ok of [0, 0.5, 2, 4.5, 5]) expect(isHalfScore(ok)).toBe(true);
    for (const bad of [-0.5, 5.5, 0.25, 4.99, NaN, Infinity, "3", null, undefined]) expect(isHalfScore(bad)).toBe(false);
  });
  it("fixesOf: ascending, ties in order, at most three", () => {
    const d = (key: string, used: number | null) => ({ key, label: key, kind: "typed" as const, weight: 1, advice: `a ${key}`, auto: null, typed: null, used });
    expect(fixesOf([d("a", 2), d("b", null), d("c", 1), d("d", 2), d("e", 0.5), d("f", 3)]).map((f) => f.key)).toEqual(["e", "c", "a"]);
    expect(fixesOf([d("a", 5)]).map((f) => [f.key, f.advice])).toEqual([["a", "a a"]]);
  });
});

describe("the ISO weeks, months and the median", () => {
  it("weekStartOf is the Monday", () => {
    expect(weekStartOf("2027-05-01")).toBe("2027-04-26"); // a Saturday
    expect(weekStartOf("2027-05-03")).toBe("2027-05-03"); // a Monday
    expect(weekStartOf("2027-05-09")).toBe("2027-05-03"); // a Sunday
    expect(weekStartOf("2028-01-01")).toBe("2027-12-27");
  });
  it("isoWeeksTouching: a month touches four to six weeks", () => {
    expect(isoWeeksTouching("2027-05-01")).toEqual(["2027-04-26", "2027-05-03", "2027-05-10", "2027-05-17", "2027-05-24", "2027-05-31"]);
    expect(isoWeeksTouching("2027-02-01")).toHaveLength(4);
    expect(isoWeeksTouching("2027-03-01")).toHaveLength(5);
    expect(isoWeeksTouching("2028-02-01")).toHaveLength(5); // a leap February starting on a Tuesday
  });
  it("monthsBefore and nextMonthStart cross the year", () => {
    expect(monthsBefore("2027-01-01", 1)).toBe("2026-12-01");
    expect(monthsBefore("2027-05-01", 2)).toBe("2027-03-01");
    expect(monthsBefore("2027-01-01", 13)).toBe("2025-12-01");
    expect(nextMonthStart("2027-12-01")).toBe("2028-01-01");
    expect(nextMonthStart("2027-04-01")).toBe("2027-05-01");
  });
  it("median and meanOf", () => {
    expect(median([])).toBeNull();
    expect(median([3])).toBe(3);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(meanOf([null, 0.02, 0.04])).toBeCloseTo(0.03, 10);
    expect(meanOf([null])).toBeNull();
  });
});

describe("the benchmark", () => {
  const own: AuditRules["benchmark"] = { source: "own_clients_median" };
  it("typed: the company's rate for the business type, ignoring case; none for a type it lacks", () => {
    const typed: AuditRules["benchmark"] = { source: "typed", rates: { Restaurant: 0.05, "Beauty clinic": 0.03 } };
    expect(resolveBenchmark(typed, "restaurant", { sameType: [], all: [] })).toEqual({ rate: 0.05, basis: "typed", peers: 0 });
    expect(resolveBenchmark(typed, " Beauty Clinic ", { sameType: [], all: [] }).rate).toBe(0.03);
    expect(resolveBenchmark(typed, "retail", { sameType: [0.1], all: [0.1] })).toEqual({ rate: null, basis: null, peers: 0 });
    expect(resolveBenchmark(typed, null, { sameType: [], all: [] }).rate).toBeNull();
  });
  it("own median: the same type when three have a rate, else every other client, else none", () => {
    expect(resolveBenchmark(own, "x", { sameType: [0.01, 0.05, 0.03], all: [0.2, 0.2] })).toEqual({ rate: 0.03, basis: "own_clients_median", peers: 3 });
    const wide = resolveBenchmark(own, "x", { sameType: [0.01, 0.05], all: [0.01, 0.05, 0.1, 0.3] });
    expect(wide).toMatchObject({ basis: "own_clients_median_all", peers: 4 });
    expect(wide.rate).toBeCloseTo(0.075, 12);
    expect(resolveBenchmark(own, "x", { sameType: [], all: [] })).toEqual({ rate: null, basis: null, peers: 0 });
  });
});

describe("the bodies", () => {
  const months = { lastFullMonth: "2027-03-01", currentMonth: "2027-04-01" };
  const refusal = (fn: () => unknown): string => {
    try { fn(); return "ok"; } catch (e) {
      const r = (e as { getResponse?: () => { message?: string; field?: string } }).getResponse?.();
      return `${r?.message}:${r?.field ?? ""}`;
    }
  };
  const E = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";

  it("create: a client's month defaults to the last full month; a prospect's name is required", () => {
    expect(parseAuditCreate({ subject: "client", engagementId: E.toUpperCase() }, months)).toEqual({ subject: "client", id: null, engagementId: E, month: "2027-03-01" });
    expect(parseAuditCreate({ subject: "client", engagementId: E, month: "2027-04" }, months)).toMatchObject({ month: "2027-04-01" });
    expect(parseAuditCreate({ subject: "prospect", prospectName: " Mock Cafe ", publicNumbers: { followers: 1200, lastPostOn: "2027-03-30" } }, months))
      .toEqual({ subject: "prospect", id: null, prospectName: "Mock Cafe", businessType: null, publicNumbers: { followers: 1200, lastPostOn: "2027-03-30" } });
  });
  it("create: refusals name the field", () => {
    expect(refusal(() => parseAuditCreate(null, months))).toBe("invalid_field:body");
    expect(refusal(() => parseAuditCreate({}, months))).toBe("missing_field:subject");
    expect(refusal(() => parseAuditCreate({ subject: "team" }, months))).toBe("invalid_field:subject");
    expect(refusal(() => parseAuditCreate({ subject: "client" }, months))).toBe("missing_field:engagementId");
    expect(refusal(() => parseAuditCreate({ subject: "client", engagementId: "nope" }, months))).toBe("invalid_field:engagementId");
    expect(refusal(() => parseAuditCreate({ subject: "client", engagementId: E, month: "2027-03-15" }, months))).toBe("invalid_field:month");
    expect(refusal(() => parseAuditCreate({ subject: "client", engagementId: E, month: "2027-05" }, months))).toBe("invalid_field:month");
    expect(refusal(() => parseAuditCreate({ subject: "client", engagementId: E, prospectName: "x" }, months))).toBe("invalid_field:prospectName");
    expect(refusal(() => parseAuditCreate({ subject: "prospect" }, months))).toBe("missing_field:prospectName");
    expect(refusal(() => parseAuditCreate({ subject: "prospect", prospectName: "x".repeat(201) }, months))).toBe("invalid_field:prospectName");
    expect(refusal(() => parseAuditCreate({ subject: "prospect", prospectName: "x", businessType: "y".repeat(61) }, months))).toBe("invalid_field:businessType");
    expect(refusal(() => parseAuditCreate({ subject: "prospect", prospectName: "x", engagementId: E }, months))).toBe("invalid_field:engagementId");
    expect(refusal(() => parseAuditCreate({ subject: "prospect", prospectName: "x", id: "no" }, months))).toBe("invalid_field:id");
  });
  it("parseMonth", () => {
    expect(parseMonth("2027-02", "month")).toBe("2027-02-01");
    expect(parseMonth("2027-02-01", "month")).toBe("2027-02-01");
    for (const bad of ["2027-13", "2027-00", "2027-02-02", "27-02", "", 5, null]) expect(refusal(() => parseMonth(bad, "month")), String(bad)).toBe("invalid_field:month");
  });
  it("public numbers: counts are whole, averages may have decimals, the date is real", () => {
    expect(parsePublicNumbers({ followers: 10, avgLikes: 3.456, avgComments: null })).toEqual({ followers: 10, avgLikes: 3.46 });
    expect(parsePublicNumbers(null)).toEqual({});
    expect(refusal(() => parsePublicNumbers({ followers: 1.5 }))).toBe("invalid_field:publicNumbers.followers");
    expect(refusal(() => parsePublicNumbers({ postsLast30Days: -1 }))).toBe("invalid_field:publicNumbers.postsLast30Days");
    expect(refusal(() => parsePublicNumbers({ lastPostOn: "2027-02-30" }))).toBe("invalid_field:publicNumbers.lastPostOn");
    expect(refusal(() => parsePublicNumbers({ reach: 1 }))).toBe("invalid_field:publicNumbers.reach");
    expect(refusal(() => parsePublicNumbers([]))).toBe("invalid_field:publicNumbers");
  });

  const rules = DEFAULT_RULES.audit;
  const patch = (body: unknown, subject: "client" | "prospect" = "client", existing: Record<string, TypedScore> = {}) =>
    parseAuditPatch(body, { subject, rules, existing, currentMonth: months.currentMonth });
  it("patch: a typed score by halves; overriding an automatic dimension of a client needs its note", () => {
    expect(patch({ scores: { profile: { score: 4.5 } } }).scores).toEqual({ profile: { score: 4.5, note: "" } });
    expect(patch({ scores: { consistency: { score: 2, note: " by hand " } } }).scores).toEqual({ consistency: { score: 2, note: "by hand" } });
    expect(refusal(() => patch({ scores: { consistency: { score: 2 } } }))).toBe("missing_field:scores.consistency.note");
    expect(refusal(() => patch({ scores: { consistency: { score: 2, note: "  " } } }))).toBe("missing_field:scores.consistency.note");
    // A score sent again without a note keeps the note already stored.
    expect(patch({ scores: { consistency: { score: 3 } } }, "client", { consistency: { score: 2, note: "kept" } }).scores).toEqual({ consistency: { score: 3, note: "kept" } });
    // A prospect's twelve are typed: no note is needed.
    expect(patch({ scores: { consistency: { score: 2 } } }, "prospect").scores).toEqual({ consistency: { score: 2, note: "" } });
  });
  it("patch: refusals", () => {
    expect(refusal(() => patch({ scores: { profile: { score: 2.25 } } }))).toBe("invalid_field:scores.profile.score");
    expect(refusal(() => patch({ scores: { profile: { score: 6 } } }))).toBe("invalid_field:scores.profile.score");
    expect(refusal(() => patch({ scores: { profile: { score: "4" } } }))).toBe("invalid_field:scores.profile.score");
    expect(refusal(() => patch({ scores: { profile: {} } }))).toBe("missing_field:scores.profile.score");
    expect(refusal(() => patch({ scores: { unknown_key: { score: 1 } } }))).toBe("invalid_field:scores.unknown_key");
    expect(refusal(() => patch({ scores: { profile: { score: 1, note: "x".repeat(501) } } }))).toBe("invalid_field:scores.profile.note");
    expect(refusal(() => patch({ scores: { profile: { score: 1, extra: 1 } } }))).toBe("invalid_field:scores.profile.extra");
    expect(refusal(() => patch({ scores: [] }))).toBe("invalid_field:scores");
    expect(refusal(() => patch({ month: "2027-05" }))).toBe("invalid_field:month");
    expect(refusal(() => patch({ prospectName: "x" }))).toBe("invalid_field:prospectName"); // a client's audit has no prospect name
    expect(refusal(() => patch({ month: "2027-02" }, "prospect"))).toBe("invalid_field:month");
    expect(refusal(() => patch({ summary: "x".repeat(3001) }))).toBe("invalid_field:summary");
    expect(refusal(() => patch({ summary: 5 }))).toBe("invalid_field:summary");
    expect(refusal(() => patch({ summary: "ok", summaryVia: "robot" }))).toBe("invalid_field:summaryVia");
    expect(refusal(() => patch({ nope: 1 }))).toBe("invalid_field:nope");
  });
  it("patch: dropping an override, the summary and its provenance", () => {
    expect(patch({ scores: { consistency: { score: null } } }).scores).toEqual({ consistency: null });
    expect(patch({ scores: { consistency: { score: null } } }, "client", { consistency: { score: 2, note: "n" } }).scores).toEqual({ consistency: { score: null, note: "n" } });
    expect(patch({ scores: { profile: null } }).scores).toEqual({ profile: null });
    expect(patch({ summary: " Fine. " }).summary).toEqual({ text: "Fine.", via: "typed" });
    expect(patch({ summary: "Drafted", summaryVia: "ai" }).summary).toEqual({ text: "Drafted", via: "ai" });
    expect(patch({ summary: null }).summary).toEqual({ text: null, via: null });
    expect(patch({ summary: "  " }).summary).toEqual({ text: null, via: null });
    expect(patch({}) ).toEqual({});
    expect(patch({ prospectName: " Mock Cafe ", businessType: "", publicNumbers: {} }, "prospect")).toEqual({ prospectName: "Mock Cafe", businessType: null, publicNumbers: {} });
  });
  it("applyScoresPatch and readStoredScores", () => {
    expect(applyScoresPatch({ a: { score: 1, note: "" }, b: { score: 2, note: "" } }, { a: null, c: { score: 3, note: "x" } })).toEqual({ b: { score: 2, note: "" }, c: { score: 3, note: "x" } });
    expect(readStoredScores({ a: { score: 3, note: "n" }, b: { score: null }, c: { score: 9 }, d: "x" })).toEqual({ a: { score: 3, note: "n" }, b: { score: null, note: "" } });
    expect(readStoredScores(null)).toEqual({});
  });
  it("attach and the list query", () => {
    expect(parseAttach({ engagementId: E.toUpperCase() })).toEqual({ engagementId: E });
    expect(refusal(() => parseAttach({}))).toBe("missing_field:engagementId");
    expect(refusal(() => parseAttach({ engagementId: "x" }))).toBe("invalid_field:engagementId");
    expect(refusal(() => parseAttach({ engagementId: E, extra: 1 }))).toBe("invalid_field:extra");
    expect(parseAuditListQuery({})).toEqual({ subject: null });
    expect(parseAuditListQuery({ subject: "prospect" })).toEqual({ subject: "prospect" });
    expect(refusal(() => parseAuditListQuery({ subject: "team" }))).toBe("invalid_field:subject");
    expect(refusal(() => parseAuditListQuery({ x: "1" }))).toBe("invalid_field:x");
  });
  it("the list reads worst first: lowest overall, then none, ties by name", () => {
    const items = [{ name: "Bea", overall: 80 }, { name: "Zed", overall: null }, { name: "Ann", overall: 20 }, { name: "Cy", overall: 20 }, { name: "Al", overall: null }];
    expect(sortWorstFirst(items).map((i) => i.name)).toEqual(["Ann", "Cy", "Bea", "Al", "Zed"]);
  });
});

describe("Draft with AI: the proposal's guard", () => {
  const card = cardOf(table.scorecards.find((c) => c.name.startsWith("exactly 75"))!);
  const facts: SummaryFacts = summaryFactsOf({ name: "Mock Cafe", subject: "client", month: "2027-03", card });
  it("the facts are the scorecard's: the overall, the band, the scored dimensions and the three fixes", () => {
    expect(facts).toMatchObject({ name: "Mock Cafe", overall: 75, bandLabel: "Strong", scored: 12, total: 12 });
    expect(facts.fixes.map((f) => f.label)).toEqual(["Captions and calls to action", "Answers to comments and messages", "The client's other networks"]);
    expect(buildSummaryPrompt(facts)).toContain("Overall: 75 out of 100 (Strong)");
  });
  it("the template states only the facts' numbers, within the column", () => {
    const t = templateSummary(facts);
    expect(t).toContain("75 out of 100");
    expect(ungroundedNumbers(t, facts)).toEqual([]);
    expect(t.length).toBeLessThanOrEqual(3000);
    expect(templateSummary({ ...facts, overall: null, bandLabel: null, scored: 0, dimensions: [], fixes: [] })).toContain("nothing is scored");
  });
  it("an answer that states a number the facts lack is rejected for the template; a grounded one is kept", () => {
    const good = JSON.stringify({ summary: "Mock Cafe scores 75 out of 100. Start with captions." });
    expect(parseSummaryDraft(good, facts)).toEqual({ summary: "Mock Cafe scores 75 out of 100. Start with captions.", draftedVia: "ai" });
    const invented = JSON.stringify({ summary: "Mock Cafe gained 4,200 followers and scores 75." });
    expect(parseSummaryDraft(invented, facts).draftedVia).toBe("template");
    for (const raw of [null, "", "not json", "{}", JSON.stringify({ summary: "" }), JSON.stringify({ summary: 5 }), JSON.stringify({ summary: "x".repeat(3001) })]) {
      expect(parseSummaryDraft(raw as string | null, facts).draftedVia, String(raw).slice(0, 20)).toBe("template");
    }
    expect(parseSummaryDraft(`Here: ${good}`, facts).draftedVia).toBe("ai");
  });
});

describe("the frozen record", () => {
  it("holds every dimension, the overall, band, fixes and the scorecard itself", () => {
    const card = cardOf(table.scorecards[0]);
    const f = buildFrozen({
      card, scorecard: DEFAULT_RULES.audit, rulesRef: "default:x", fixtureVersion: "x", subject: "client", month: "2027-03", businessType: "restaurant", publicNumbers: {},
      simulated: false, benchmark: null,
    });
    expect(f.dimensions).toHaveLength(12);
    expect(f).toMatchObject({ overall: 100, band: { key: "strong" }, scored: 12, total: 12, rulesRef: "default:x", scorecard: DEFAULT_RULES.audit });
    expect(JSON.parse(JSON.stringify(f))).toEqual(f);
  });
});

describe("the agent tools (BFF §63.15, §63.28)", () => {
  const tool = (name: string) => socialModule.mcpTools.find((t) => t.name === name);
  const props = (n: string) => Object.keys((tool(n)?.inputSchema as { properties: Record<string, unknown> }).properties).sort();
  it("the reads are the two GETs; the writes are `low` (an internal record that reaches no client)", () => {
    expect(tool("social.audits")).toMatchObject({ method: "GET", pathTemplate: "/api/:tenantId/modules/social/audits" });
    expect(tool("social.getAudit")).toMatchObject({ method: "GET", pathTemplate: "/api/:tenantId/modules/social/audits/:auditId" });
    expect(tool("social.audits")?.write).toBeFalsy();
    expect(tool("social.getAudit")?.write).toBeFalsy();
    expect(tool("social.saveAudit")).toMatchObject({ method: "POST", write: true, impact: "low", pathTemplate: "/api/:tenantId/modules/social/audits" });
    expect(tool("social.editAudit")).toMatchObject({ method: "PATCH", write: true, impact: "low", pathTemplate: "/api/:tenantId/modules/social/audits/:auditId" });
    expect(tool("social.finalizeAudit")).toMatchObject({ method: "POST", write: true, impact: "low", pathTemplate: "/api/:tenantId/modules/social/audits/:auditId/finalize" });
  });
  it("the tools name exactly the fields the routes take", () => {
    expect(props("social.saveAudit")).toEqual(["businessType", "engagementId", "id", "month", "prospectName", "publicNumbers", "subject", "tenantId"]);
    expect(props("social.editAudit")).toEqual(["auditId", "businessType", "month", "prospectName", "publicNumbers", "scores", "summary", "summaryVia", "tenantId"]);
    expect(props("social.audits")).toEqual(["subject", "tenantId"]);
  });
});
