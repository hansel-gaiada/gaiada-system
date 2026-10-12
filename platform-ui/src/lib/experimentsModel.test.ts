import { describe, it, expect } from "vitest";
import {
  actionsFor, buildRegistration, EMPTY_FORM, ExperimentShapeError, fmtCount, parseExperiment, parseExperimentList, parseResults, refusalWords,
} from "./experimentsModel";

const progress = { perArm: [{ key: "a", exposures: 120, target: 800, fraction: 0.15 }, { key: "b", exposures: "<5", target: 800, fraction: null }], elapsedDays: 3, minDays: 14, maxDays: 56, exposuresReached: false, minDaysReached: false };
const srm = { evaluable: true, mismatch: false, message: "The arms are receiving visitors in the planned proportions." };
const exp = (o: Record<string, unknown> = {}) => ({
  id: "e1", propertyId: "p1", key: "hero", status: "running", hypothesis: "h", item: { tenantSlug: "gaiada", siteId: "s", itemId: "i", collectionKey: "pages", locale: "en" },
  sectionId: "hero", target: "fields", enrolment: "consented", goal: { event: "generate_lead" }, arms: [{ key: "a", weight: 50 }, { key: "b", weight: 50 }],
  preRegistration: { baselineRate: 0.03, baselineSource: "supplied", relativeMde: 0.2, alpha: 0.05, power: 0.8, nPerArm: 800, dailyUnits: 100, projectedDays: 16, locked: true },
  startedAt: "2026-10-01T00:00:00.000Z", stoppedAt: null, createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "x", ...o,
});

describe("parseResults: the stopping rule", () => {
  it("a pre-horizon body keeps progress and SRM only, even when it carries an outcome", () => {
    const r = parseResults({
      state: "ok", phase: "collecting", horizonReached: false, progress, srm, warnings: [], window: { from: "a", to: "b" },
      analysis: { control: { key: "a", units: 100, conversions: 9, rate: 0.09 }, comparisons: [], decision: { action: "ship", arm: "b" }, alpha: 0.05 },
      rate: 0.12, difference: 0.03, ciLower: 0.01, ciUpper: 0.05, pValue: 0.01, conversions: 12,
    });
    expect(r.state).toBe("ok");
    expect(Object.keys(r).sort()).toEqual(["horizonReached", "inconclusive", "phase", "progress", "srm", "state", "warnings"]);
    expect(JSON.stringify(r)).not.toMatch(/difference|ciLower|pValue|conversions|analysis|ship/);
  });
  it("horizonReached true without phase horizon is still treated as before the horizon", () => {
    const r = parseResults({ state: "ok", phase: "collecting", horizonReached: true, progress, srm, warnings: [], analysis: { bogus: 1 } });
    expect(r).toMatchObject({ horizonReached: false });
    expect("analysis" in r).toBe(false);
  });
  it("the horizon body carries the analysis", () => {
    const r = parseResults({
      state: "ok", phase: "horizon", horizonReached: true, progress, srm, warnings: [],
      analysis: { control: { key: "a", units: 900, conversions: "<5", rate: null }, comparisons: [], decision: { action: "keep_control", reason: "no_significant_winner" }, alpha: 0.05 },
    });
    expect(r).toMatchObject({ horizonReached: true });
  });
  it("unavailable, not started and aborted carry words and nothing numeric", () => {
    expect(parseResults({ state: "unavailable", reason: "unreachable", message: "m", progress })).toEqual({ state: "unavailable", reason: "unreachable", message: "m" });
    expect(parseResults({ state: "not_started", message: "m" })).toEqual({ state: "not_started", message: "m" });
    expect(parseResults({ state: "aborted", message: "m" })).toEqual({ state: "aborted", message: "m" });
  });
  it("an off-contract body is a shape error, not an empty view", () => {
    expect(() => parseResults({ state: "weird" })).toThrow(ExperimentShapeError);
    expect(() => parseResults({ state: "ok", phase: "collecting", horizonReached: false })).toThrow(ExperimentShapeError);
  });
});

describe("parsers and words", () => {
  it("the list keeps the server's order", () => {
    const list = parseExperimentList({ propertyId: "p", experiments: [exp({ id: "z", key: "zz" }), exp({ id: "a", key: "aa" })] });
    expect(list.map((e) => e.key)).toEqual(["zz", "aa"]);
  });
  it("an unknown status is a shape error", () => { expect(() => parseExperiment(exp({ status: "bogus" }))).toThrow(ExperimentShapeError); });
  it("small cells are said as words", () => { expect(fmtCount("<5")).toBe("fewer than 5"); expect(fmtCount(7)).toBe("7"); });
  it("underpowered says the projected days against the cap", () => {
    const s = refusalWords("underpowered", 422, { projectedDays: 120, maxDays: 56, nPerArm: 5000, dailyUnits: 40 });
    expect(s).toContain("120 days");
    expect(s).toContain("56 days");
    expect(s).not.toContain("underpowered");
  });
  it("underpowered with no traffic says so", () => { expect(refusalWords("underpowered", 422, { projectedDays: null, maxDays: 56 })).toContain("no visitors"); });
  it.each([
    "too_many_running", "pre_registration_locked", "horizon_not_reached", "experiment_still_live", "plan_mismatch", "not_stopped", "not_running",
    "experiment_closed", "already_decided", "key_taken", "item_already_registered", "item_already_has_experiment", "item_not_found", "baseline_unavailable",
    "analytics_not_bound", "analytics_unreachable", "analytics_rejected", "mde_out_of_range", "goal_event_invalid",
  ])("%s is a plain sentence without the raw token", (token) => {
    const s = refusalWords(token, 409);
    expect(s.length).toBeGreaterThan(20);
    expect(s).not.toContain(token);
    expect(s.endsWith(".")).toBe(true);
  });
  it("an unknown token falls back to a sentence by status", () => {
    expect(refusalWords("zzz", 403)).toContain("permission");
    expect(refusalWords(undefined, 500)).toContain("Nothing was changed");
  });
});

describe("actionsFor", () => {
  it.each([
    ["draft", { sync: true, stop: false, abort: true, decide: false }],
    ["running", { sync: false, stop: true, abort: true, decide: false }],
    ["stopped", { sync: false, stop: false, abort: true, decide: true }],
    ["aborted", { sync: false, stop: false, abort: false, decide: false }],
    ["decided", { sync: false, stop: false, abort: false, decide: false }],
  ] as const)("%s", (status, want) => { expect(actionsFor(status, true)).toEqual(want); });
  it("nothing without permission", () => { expect(actionsFor("running", false)).toEqual({ sync: false, stop: false, abort: false, decide: false }); });
});

describe("buildRegistration", () => {
  const ok = { ...EMPTY_FORM, key: "hero", hypothesis: "h", itemId: "i", sectionId: "hero" };
  it("builds the API body: percentages become fractions, alpha and power are never sent", () => {
    const r = buildRegistration({ ...ok, baselinePct: "3", mdePct: "20" }, { tenantSlug: "gaiada", siteId: "s" });
    expect(r).toEqual({ ok: true, body: {
      key: "hero", hypothesis: "h", webdesk: { tenantSlug: "gaiada", siteId: "s", itemId: "i" }, sectionId: "hero", goal: { event: "generate_lead" },
      arms: [{ key: "a", weight: 50 }, { key: "b", weight: 50 }], relativeMde: 0.2, baselineRate: 0.03,
    } });
    expect(JSON.stringify(r)).not.toMatch(/alpha|power/);
  });
  it("leaves the baseline out when empty (the server suggests one)", () => {
    const r = buildRegistration(ok, { tenantSlug: "g", siteId: "s" });
    expect(r.ok && "baselineRate" in r.body).toBe(false);
  });
  it.each([
    [{ weightA: "60", weightB: "50" }, "add up to 100"],
    [{ weightA: "5", weightB: "95" }, "at least 10"],
    [{ mdePct: "0" }, "above 0%"],
    [{ key: " " }, "key"],
    [{ baselinePct: "100" }, "below 100%"],
  ])("refuses %j in words", (o, word) => {
    const r = buildRegistration({ ...ok, ...o }, { tenantSlug: "g", siteId: "s" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain(word);
  });
});
