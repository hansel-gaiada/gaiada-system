// M5-V5-c — pure unit tests for the experiments service's pure half (experiments.ts) and its MCP tool defs. No DB, no Cerbos,
// no network: the I/O half and the HTTP surface are driven by experiments.db.test.ts on the Linux gate.
import { describe, expect, it, vi } from "vitest";
import {
  ExperimentRefusal, computePlan, countEvValues, evaluateOnExposures, experimentBlockOf, parseArms, parseDraftPatch, parseNote, parseRegistration,
  planDifferences, progressDto, srmDto, suggestBaseline, toResultsDto, totalOfEvent, totalOfValue, UMAMI_VALUES_LIMIT,
  type RegistrationInput,
} from "./experiments";
import { progressView, sampleSizePerArm, type ExperimentView } from "./experiment-stats";
import { EXPERIMENT_MCP_TOOLS } from "./experiments-mcp-tools";

const SITE = "11111111-2222-4333-8444-555555555555";
const ITEM = "22222222-3333-4444-8555-666666666666";
const valid = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  key: "home-hero-2026-11",
  hypothesis: "A shorter headline will get more people to start the contact form.",
  webdesk: { tenantSlug: "gaiada", siteId: SITE, itemId: ITEM },
  sectionId: "home.hero",
  target: "fields",
  goal: { event: "lead_form_start", match: { form_id: "contact" } },
  arms: [{ key: "a", weight: 50 }, { key: "b", weight: 50 }],
  baselineRate: 0.03,
  relativeMde: 0.5,
  ...over,
});
const parsed = (b: unknown, o: { allowAllEnrolment?: boolean } = {}) => parseRegistration(b, o);
const refusal = (fn: () => unknown): ExperimentRefusal => {
  try { fn(); } catch (e) { if (e instanceof ExperimentRefusal) return e; throw e; }
  throw new Error("expected an ExperimentRefusal");
};

describe("parseRegistration", () => {
  it("accepts a full valid body and fills the defaults", () => {
    const r = parsed(valid());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.enrolment).toBe("consented");
      expect(r.value.target).toBe("fields");
      expect(r.value.baselineRate).toBe(0.03);
      expect(r.value.webdesk.siteId).toBe(SITE);
    }
  });
  it("a missing baselineRate means 'suggest it'", () => {
    const r = parsed(valid({ baselineRate: undefined }));
    expect(r.ok && r.value.baselineRate).toBe(null);
  });
  it.each([
    ["key", { key: "A" }, "key_invalid"],
    ["short key", { key: "ab" }, "key_invalid"],
    ["hypothesis", { hypothesis: "  " }, "hypothesis_required"],
    ["long hypothesis", { hypothesis: "x".repeat(501) }, "hypothesis_too_long"],
    ["webdesk", { webdesk: { tenantSlug: "gaiada", siteId: "nope", itemId: ITEM } }, "webdesk_invalid"],
    ["webdesk extra", { webdesk: { tenantSlug: "gaiada", siteId: SITE, itemId: ITEM, x: 1 } }, "webdesk_invalid"],
    ["section", { sectionId: "has space" }, "section_id_invalid"],
    ["target", { target: { block: 0 } }, "target_invalid"],
    ["target text", { target: "blocks" }, "target_invalid"],
    ["enrolment", { enrolment: "some" }, "enrolment_invalid"],
    ["goal event", { goal: { event: "page_view" } }, "goal_event_invalid"],
    ["goal match two", { goal: { event: "cta_click", match: { link_location: "a", form_id: "b" } } }, "goal_match_invalid"],
    ["goal match key", { goal: { event: "cta_click", match: { page: "a" } } }, "goal_match_invalid"],
    ["goal match value", { goal: { event: "cta_click", match: { link_location: "a b" } } }, "goal_match_invalid"],
    ["goal extra", { goal: { event: "cta_click", x: 1 } }, "goal_invalid"],
    ["baseline 0", { baselineRate: 0 }, "baseline_rate_invalid"],
    ["baseline 1", { baselineRate: 1 }, "baseline_rate_invalid"],
    ["baseline text", { baselineRate: "3%" }, "baseline_rate_invalid"],
    ["mde", { relativeMde: 0 }, "mde_invalid"],
    ["mde big", { relativeMde: 6 }, "mde_invalid"],
    ["mde missing", { relativeMde: undefined }, "mde_invalid"],
    ["unknown field", { alpha: 0.1 }, "unknown_field"],
  ])("refuses %s with a typed token", (_n, over, token) => {
    const r = parsed(valid(over));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.token).toBe(token);
  });
  it("alpha and power are not caller-editable (design fixes them)", () => {
    expect(parsed(valid({ power: 0.9 }))).toMatchObject({ ok: false, token: "unknown_field" });
  });
  it("a non-object body is refused", () => {
    expect(parsed(null)).toMatchObject({ ok: false, token: "body_invalid" });
    expect(parsed([])).toMatchObject({ ok: false, token: "body_invalid" });
  });
  it("enrolment 'all' waits for counsel (O6) unless switched on", () => {
    expect(parsed(valid({ enrolment: "all" }))).toMatchObject({ ok: false, token: "enrolment_all_not_enabled" });
    expect(parsed(valid({ enrolment: "all" }), { allowAllEnrolment: true }).ok).toBe(true);
  });
  it("the block target takes an index of at least 1", () => {
    const r = parsed(valid({ target: { block: 2 } }));
    expect(r.ok && r.value.target).toEqual({ block: 2 });
  });
});

describe("parseArms (design 5.1)", () => {
  it("2 to 4 arms a..d in order, weights >= 10 summing to 100", () => {
    expect(parseArms([{ key: "a", weight: 50 }, { key: "b", weight: 50 }]).ok).toBe(true);
    expect(parseArms([{ key: "a", weight: 40 }, { key: "b", weight: 30 }, { key: "c", weight: 20 }, { key: "d", weight: 10 }]).ok).toBe(true);
  });
  it.each([
    ["one arm", [{ key: "a", weight: 100 }]],
    ["five arms", ["a", "b", "c", "d", "e"].map((key) => ({ key, weight: 20 }))],
    ["wrong order", [{ key: "b", weight: 50 }, { key: "a", weight: 50 }]],
    ["sum 99", [{ key: "a", weight: 50 }, { key: "b", weight: 49 }]],
    ["weight 9", [{ key: "a", weight: 91 }, { key: "b", weight: 9 }]],
    ["fraction", [{ key: "a", weight: 50.5 }, { key: "b", weight: 49.5 }]],
    ["override is WebDesk's", [{ key: "a", weight: 50 }, { key: "b", weight: 50, override: { x: 1 } }]],
    ["not a list", "a,b"],
  ])("refuses %s", (_n, arms) => {
    expect(parseArms(arms)).toMatchObject({ ok: false, token: "arms_invalid" });
  });
});

describe("parseDraftPatch and parseNote", () => {
  it("allows the editable members and nothing else", () => {
    expect(parseDraftPatch({ hypothesis: "New words.", relativeMde: 0.4 }).ok).toBe(true);
    expect(parseDraftPatch({ baselineRate: null })).toMatchObject({ ok: true, value: { baselineRate: null } });
    expect(parseDraftPatch({})).toMatchObject({ ok: false, token: "empty_patch" });
    expect(parseDraftPatch({ key: "other-key" })).toMatchObject({ ok: false, token: "field_not_editable" });
    expect(parseDraftPatch({ webdesk: {} })).toMatchObject({ ok: false, token: "field_not_editable" });
    expect(parseDraftPatch({ nPerArm: 5 })).toMatchObject({ ok: false, token: "unknown_field" });
    expect(parseDraftPatch({ arms: [{ key: "a", weight: 1 }] })).toMatchObject({ ok: false, token: "arms_invalid" });
  });
  it("a decide note is optional text of at most 500 characters", () => {
    expect(parseNote(undefined)).toEqual({ ok: true, value: null });
    expect(parseNote({})).toEqual({ ok: true, value: null });
    expect(parseNote({ note: "  shipped b  " })).toEqual({ ok: true, value: "shipped b" });
    expect(parseNote({ note: "x".repeat(501) })).toMatchObject({ ok: false, token: "note_too_long" });
    expect(parseNote({ note: 3 })).toMatchObject({ ok: false, token: "note_invalid" });
    expect(parseNote({ who: "me" })).toMatchObject({ ok: false, token: "unknown_field" });
  });
});

describe("computePlan: n per arm and the 56-day rule (design 5.4, O9)", () => {
  it("3.0 % -> 4.5 % needs 2,518 per arm; at 300 units a day that is 17 days, at 120 it is 42 (the design's own example)", () => {
    expect(sampleSizePerArm({ baselineRate: 0.03, relativeMde: 0.5 }).nPerArm).toBe(2518);
    expect(computePlan({ baselineRate: 0.03, relativeMde: 0.5, weights: [50, 50], dailyUnits: 300 })).toMatchObject({ nPerArm: 2518, projectedDays: 17 });
    expect(computePlan({ baselineRate: 0.03, relativeMde: 0.5, weights: [50, 50], dailyUnits: 120 })).toMatchObject({ nPerArm: 2518, projectedDays: 42 });
  });
  it("floors the horizon at 14 days when traffic is plentiful", () => {
    const p = computePlan({ baselineRate: 0.03, relativeMde: 0.5, weights: [50, 50], dailyUnits: 100_000 });
    expect(p.projectedDays).toBe(14);
    expect(p.limitedByMinimum).toBe(true);
  });
  it("56 days is accepted; a 57-day projection is refused 422 `underpowered` WITH the projection", () => {
    // days = ceil(2518 * 100 / (units * 50)): 90 a day -> 55.96 -> 56, 88.5 a day -> 56.9 -> 57
    expect(computePlan({ baselineRate: 0.03, relativeMde: 0.5, weights: [50, 50], dailyUnits: 90 }).projectedDays).toBe(56);
    const r = refusal(() => computePlan({ baselineRate: 0.03, relativeMde: 0.5, weights: [50, 50], dailyUnits: 88.5 }));
    expect(r.status).toBe(422);
    expect(r.token).toBe("underpowered");
    expect(r.message.startsWith("underpowered")).toBe(true);
    expect(r.detail).toMatchObject({ projectedDays: 57, maxDays: 56, nPerArm: 2518, dailyUnits: 88.5 });
  });
  it("an unequal split is paced by its smallest arm", () => {
    const r = refusal(() => computePlan({ baselineRate: 0.03, relativeMde: 0.5, weights: [90, 10], dailyUnits: 300 }));
    expect(r.token).toBe("underpowered"); // 2518 / 30 a day = 84 days
    expect((r.detail as { projectedDays: number }).projectedDays).toBe(84);
  });
  it("no traffic at all is underpowered with a null projection (never zero days)", () => {
    const r = refusal(() => computePlan({ baselineRate: 0.03, relativeMde: 0.5, weights: [50, 50], dailyUnits: 0 }));
    expect(r.token).toBe("underpowered");
    expect((r.detail as { projectedDays: number | null }).projectedDays).toBeNull();
  });
  it("a baseline x (1 + MDE) of 1 or more is `mde_out_of_range`", () => {
    const r = refusal(() => computePlan({ baselineRate: 0.5, relativeMde: 1.5, weights: [50, 50], dailyUnits: 1000 }));
    expect(r).toMatchObject({ status: 422, token: "mde_out_of_range" });
  });
});

describe("reading the site's events from Umami (design 5.3)", () => {
  const rows = (...r: Array<[string, number]>) => r.map(([value, total]) => ({ value, total }));
  it("sums c and s unit kinds per arm and ignores other tests, unknown arms and malformed values", () => {
    const body = rows(
      ["home-hero-2026-11:a:c", 10], ["home-hero-2026-11:b:c", 12], ["home-hero-2026-11:b:s", 3],
      ["other-test-key:a:c", 99], ["home-hero-2026-11:z:c", 7], ["home-hero-2026-11:a", 5], ["home-hero-2026-11:a:x", 5], ["home-hero-2026-11:a:c:extra", 5],
    );
    expect(countEvValues(body, "home-hero-2026-11", ["a", "b"])).toEqual({ counts: [10, 15], truncated: false });
  });
  it("a prefix of another key is not a match", () => {
    expect(countEvValues(rows(["home-hero-2026-11-v2:a:c", 40]), "home-hero-2026-11", ["a", "b"]).counts).toEqual([0, 0]);
  });
  it("a full 100-row page is flagged truncated; a non-array is empty, not an error", () => {
    const full = Array.from({ length: UMAMI_VALUES_LIMIT }, (_, i) => ({ value: `k${i}:a:c`, total: 1 }));
    expect(countEvValues(full, "home-hero-2026-11", ["a", "b"]).truncated).toBe(true);
    expect(countEvValues({ nope: 1 }, "home-hero-2026-11", ["a", "b"])).toEqual({ counts: [0, 0], truncated: false });
  });
  it("totals for the traffic window: one value of a property, one event name", () => {
    expect(totalOfValue(rows(["home.hero", 280], ["pricing", 40]), "home.hero")).toBe(280);
    expect(totalOfValue(rows(["pricing", 40]), "home.hero")).toBe(0);
    expect(totalOfEvent([{ x: "cta_click", y: 12 }, { x: "generate_lead", y: 3 }], "generate_lead")).toBe(3);
  });
  it("suggestBaseline is goal events over section views, kept inside the formula's domain", () => {
    expect(suggestBaseline(30, 1000)).toBeCloseTo(0.03, 10);
    expect(suggestBaseline(5, 0)).toBeNull();
    expect(suggestBaseline(0, 1000)).toBe(0.0001);
    expect(suggestBaseline(5000, 1000)).toBe(0.9);
  });
});

describe("the live block against the registration", () => {
  const reg = {
    key: "home-hero-2026-11", target: "fields" as const, enrolment: "consented", goal: { event: "lead_form_start" as const, match: { form_id: "contact" } },
    arms: [{ key: "a", weight: 50 }, { key: "b", weight: 50 }],
  };
  const block = (over: Record<string, unknown> = {}) => ({
    type: "experiment",
    props: {
      key: "home-hero-2026-11", target: "fields", enrolment: "consented", goal: { match: { form_id: "contact" }, event: "lead_form_start" },
      arms: [{ key: "a", weight: 50 }, { key: "b", weight: 50, override: { heading: "Your next client is searching now" } }], ...over,
    },
  });
  it("finds the first experiment block, or null", () => {
    expect(experimentBlockOf([{ type: "fields", props: {} }, block()])?.key).toBe("home-hero-2026-11");
    expect(experimentBlockOf([{ type: "fields", props: {} }])).toBeNull();
    expect(experimentBlockOf(null)).toBeNull();
  });
  it("the registered plan matches regardless of key order and of the arms' overrides", () => {
    expect(planDifferences(reg, block().props)).toEqual([]);
  });
  it("names every member that differs (the stats assume the registered plan)", () => {
    expect(planDifferences(reg, block({ arms: [{ key: "a", weight: 70 }, { key: "b", weight: 30 }] }).props)).toEqual(["arms"]);
    expect(planDifferences(reg, block({ enrolment: "all" }).props)).toEqual(["enrolment"]);
    expect(planDifferences(reg, block({ goal: { event: "cta_click" } }).props)).toEqual(["goal"]);
    expect(planDifferences(reg, block({ target: { block: 2 } }).props)).toEqual(["target"]);
    expect(planDifferences(reg, block({ key: "other-key" }).props)).toEqual(["key"]);
  });
  it("an absent enrolment is the default 'consented'", () => {
    const p = block().props as Record<string, unknown>;
    delete p.enrolment;
    expect(planDifferences(reg, p)).toEqual([]);
  });
});

describe("evaluateOnExposures: conversions are fetched only at the horizon", () => {
  const plan = { nPerArm: 100, armKeys: ["a", "b"], weights: [50, 50] };
  it("before the horizon the conversion loader is NEVER called (by exposures)", async () => {
    const loader = vi.fn(async () => [9, 9]);
    const out = await evaluateOnExposures(plan, [60, 60], 20, loader);
    expect(loader).not.toHaveBeenCalled();
    expect(out.view.phase).toBe("collecting");
    expect(out.arms.every((a) => a.conversions === 0)).toBe(true);
  });
  it("before the horizon the conversion loader is NEVER called (by days)", async () => {
    const loader = vi.fn(async () => [9, 9]);
    const out = await evaluateOnExposures(plan, [100, 100], 13, loader);
    expect(loader).not.toHaveBeenCalled();
    expect(out.view.phase).toBe("collecting");
  });
  it("at the horizon it is called once and the engine analyses", async () => {
    const loader = vi.fn(async () => [10, 30]);
    const out = await evaluateOnExposures(plan, [100, 100], 14, loader);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(out.view.phase).toBe("horizon");
    if (out.view.phase === "horizon") expect(out.view.analysis.comparisons[0]!.key).toBe("b");
  });
  it("more converts than exposed units is clamped and flagged, never a crash", async () => {
    const out = await evaluateOnExposures(plan, [100, 100], 14, async () => [5, 130]);
    expect(out.warnings).toEqual(["conversions_exceed_exposures:b"]);
    expect(out.arms[1]).toMatchObject({ units: 100, conversions: 100 });
  });
  it("past 56 days without the horizon: inconclusive, keep the control, still no outcome numbers", async () => {
    const loader = vi.fn(async () => [1, 1]);
    const out = await evaluateOnExposures(plan, [20, 20], 56, loader);
    expect(loader).not.toHaveBeenCalled();
    expect(out.view.phase).toBe("inconclusive");
    const dto = toResultsDto(out.view);
    expect(dto).toMatchObject({ phase: "inconclusive", horizonReached: false, decision: { action: "keep_control", reason: "inconclusive_at_max_duration" } });
  });
});

/** Every object key anywhere in a value. */
const keysOf = (v: unknown, acc: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, acc));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { acc.push(k); keysOf(x, acc); }
  return acc;
};
const OUTCOME_KEY = /rate|diff|interval|^ci|pvalue|praw|padjusted|conversion|winner|lift|uplift|significan|chisquare/i;

describe("the results DTO is a whitelist: no estimate before the horizon", () => {
  const plan = { nPerArm: 100, armKeys: ["a", "b"], weights: [50, 50] };
  it("pre-horizon body: exposures, progress and the SRM verdict only (no key that names an outcome)", async () => {
    const out = await evaluateOnExposures(plan, [90, 99], 14, async () => { throw new Error("must not be called"); });
    const dto = toResultsDto(out.view);
    const keys = keysOf(dto);
    expect(keys.filter((k) => OUTCOME_KEY.test(k))).toEqual([]);
    expect(dto).toMatchObject({ state: "ok", phase: "collecting", horizonReached: false });
    expect(dto.progress.perArm).toEqual([
      { key: "a", exposures: 90, target: 100, fraction: 0.9 },
      { key: "b", exposures: 99, target: 100, fraction: 0.99 },
    ]);
    expect(Object.keys(dto.srm).sort()).toEqual(["evaluable", "mismatch", "message"].sort());
    expect("analysis" in dto).toBe(false);
  });
  it("the SRM verdict never carries the chi-square or its p before the horizon", () => {
    const dto = srmDto({ evaluable: true, mismatch: true });
    expect(dto.mismatch).toBe(true);
    expect(dto.message).toContain("Sample ratio mismatch");
    expect(JSON.stringify(dto)).not.toMatch(/chi|pValue|expected|observed/i);
  });
  it("an SRM mismatch is raised on a lopsided split, still without an outcome", async () => {
    const out = await evaluateOnExposures(plan, [600, 400], 5, async () => [0, 0]);
    const dto = toResultsDto(out.view);
    expect(dto.srm.mismatch).toBe(true);
    expect(keysOf(dto).filter((k) => OUTCOME_KEY.test(k))).toEqual([]);
  });
  it("small cells leave as '<5' and their fraction is null (visitor addendum R-V6)", () => {
    const p = progressDto(progressView({ nPerArm: 100, weights: [50, 50], armKeys: ["a", "b"] }, [3, 40], 2));
    expect(p.perArm[0]).toEqual({ key: "a", exposures: "<5", target: 100, fraction: null });
    expect(p.perArm[1]).toMatchObject({ exposures: 40, fraction: 0.4 });
  });
  it("at the horizon the analysis is present, with the engine's decision", async () => {
    const out = await evaluateOnExposures({ nPerArm: 500, armKeys: ["a", "b"], weights: [50, 50] }, [500, 500], 14, async () => [50, 100]);
    const dto = toResultsDto(out.view);
    expect(dto).toMatchObject({ phase: "horizon", horizonReached: true });
    if (dto.phase === "horizon") {
      expect(dto.analysis.decision).toEqual({ action: "ship", arm: "b" });
      expect(dto.analysis.comparisons[0]).toMatchObject({ key: "b", units: 500, conversions: 100, rate: 0.2, method: "z", significantWinner: true });
      expect(dto.analysis.control).toMatchObject({ rate: 0.1 });
    }
  });
  it("at the horizon a conversion count under 5 is '<5' and its rate null", async () => {
    const out = await evaluateOnExposures({ nPerArm: 500, armKeys: ["a", "b"], weights: [50, 50] }, [500, 500], 14, async () => [2, 3]);
    const dto = toResultsDto(out.view);
    if (dto.phase !== "horizon") throw new Error("horizon expected");
    expect(dto.analysis.control).toMatchObject({ conversions: "<5", rate: null });
    expect(dto.analysis.comparisons[0]).toMatchObject({ conversions: "<5", rate: null });
    expect(dto.analysis.decision).toMatchObject({ action: "keep_control" });
  });
  it("a view built by hand with the wrong phase cannot smuggle an analysis into the collecting branch", () => {
    const view = { phase: "collecting", horizonReached: false, progress: progressView(plan, [1, 1], 1), srm: { evaluable: true, mismatch: false, chiSquare: 0, df: 1, pValue: 0.99, expected: [1, 1], observed: [1, 1] }, analysis: { leaked: 1 } } as unknown as ExperimentView;
    const dto = toResultsDto(view);
    expect(JSON.stringify(dto)).not.toMatch(/leaked|pValue|chiSquare/);
  });
});

describe("MCP tool defs (agentic-native bar: every capability is an endpoint AND a tool with an impact class)", () => {
  const byName = new Map(EXPERIMENT_MCP_TOOLS.map((t) => [t.name, t]));
  it("has the seven design tools plus update and sync", () => {
    expect([...byName.keys()].sort()).toEqual([
      "search.experiments.abort", "search.experiments.create", "search.experiments.decide", "search.experiments.get", "search.experiments.list",
      "search.experiments.results", "search.experiments.stop", "search.experiments.sync", "search.experiments.update",
    ]);
  });
  it("reads carry no impact; every write is LOW and `verified`", () => {
    for (const name of ["list", "get", "results"]) {
      const t = byName.get(`search.experiments.${name}`)!;
      expect(t.method).toBe("GET");
      expect(t.write).not.toBe(true);
      expect(t.impact).toBeUndefined();
      expect(t.minAssurance).toBe("low");
    }
    for (const name of ["create", "update", "sync", "stop", "abort", "decide"]) {
      const t = byName.get(`search.experiments.${name}`)!;
      expect(t.write).toBe(true);
      expect(t.impact).toBe("low");
      expect(t.minAssurance).toBe("verified");
    }
  });
  it("every pathTemplate param is declared in the tool's input schema, and reads use only path params", () => {
    for (const t of EXPERIMENT_MCP_TOOLS) {
      const params = [...(t.pathTemplate ?? "").matchAll(/:(\w+)/g)].map((m) => m[1]!);
      const props = Object.keys((t.inputSchema as { properties: Record<string, unknown> }).properties);
      for (const p of params) expect(props, `${t.name} :${p}`).toContain(p);
      if (t.method === "GET") expect(props.sort()).toEqual([...params].sort());
    }
  });
});
