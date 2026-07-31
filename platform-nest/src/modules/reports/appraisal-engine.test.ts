// TR-24 — pure tests for the appraisal engine's anti-gaming core: no database (matches the house
// pattern — metrics.test.ts/document-builder.test.ts pin the pure half of their tickets; this pins
// the pure half of TR-24). The DB-backed generate/submit/ack/finalize/staleness flow is
// appraisals.controller.db.test.ts.
import { describe, it, expect } from "vitest";
import {
  APPRAISAL_AXES,
  PERSON_SAFE_METRICS,
  SMALL_COHORT_THRESHOLD,
  DEVIATION_THRESHOLD,
  MIN_COMMENTARY_LENGTH,
  normalizeRoleKey,
  resolveWeights,
  percentileRank,
  bandForPercentile,
  computeCohortBands,
  axisAutoScores,
  computeComposite,
  findMissingDeviationNotes,
  isValidCommentary,
  type SubjectMetricValue,
} from "./appraisal-engine";
import type { AppraisalAxis, AppraisalAxisScore, AppraisalCycleRow } from "./appraisal-document";
import { REPORT_METRICS } from "./metrics";

const CYCLE: Pick<AppraisalCycleRow, "defaultWeights" | "roleWeights"> = {
  defaultWeights: { delivery: 0.35, quality: 0.3, effort: 0.1, collaboration: 0.25 },
  roleWeights: { senior_developer: { delivery: 0.4, quality: 0.3, effort: 0.1, collaboration: 0.2 } },
};

describe("TR-24 anti-gaming catalog discipline", () => {
  it("PERSON_SAFE_METRICS is exactly the 9 appraisal-safe metrics minus #5 (project/dept/company only) = 8", () => {
    expect(PERSON_SAFE_METRICS).toHaveLength(8);
    const keys = PERSON_SAFE_METRICS.map((m) => m.metricKey).sort();
    expect(keys).toEqual(
      [
        "delivery.throughput_weighted",
        "delivery.on_time_rate",
        "delivery.estimate_coverage",
        "flow.reopen_rate",
        "effort.estimate_accuracy",
        "collab.contributed_minutes",
        "discipline.checkin_compliance",
        "discipline.time_logging_coverage",
      ].sort(),
    );
  });

  it("NEVER includes an appraisal-unsafe metric — #2 tasks_completed and #11 minutes_logged are excluded by construction", () => {
    const keys = PERSON_SAFE_METRICS.map((m) => m.metricKey);
    expect(keys).not.toContain("delivery.tasks_completed"); // #2 — raw count, rewards slicing
    expect(keys).not.toContain("effort.minutes_logged"); // #11 — raw hours, presence proxy
  });

  it("excludes #12 billable_share (appraisalSafe:false at person grain per the catalog's own D/C-only nuance) and #20 overdue_open (unsafe raw)", () => {
    const keys = PERSON_SAFE_METRICS.map((m) => m.metricKey);
    expect(keys).not.toContain("effort.billable_share");
    expect(keys).not.toContain("discipline.overdue_open");
  });

  it("every PERSON_SAFE_METRICS entry really is appraisalSafe:true and grains.includes('person') in the live catalog", () => {
    for (const m of PERSON_SAFE_METRICS) {
      const live = REPORT_METRICS.find((x) => x.metricKey === m.metricKey)!;
      expect(live.appraisalSafe, m.metricKey).toBe(true);
      expect(live.grains, m.metricKey).toContain("person");
    }
  });
});

describe("normalizeRoleKey / resolveWeights", () => {
  it("normalizes a free-text title into a cohort key", () => {
    expect(normalizeRoleKey("Senior Developer")).toBe("senior_developer");
    expect(normalizeRoleKey("  QA / Test  ")).toBe("qa_test");
    expect(normalizeRoleKey(null)).toBeNull();
    expect(normalizeRoleKey("")).toBeNull();
  });

  it("resolveWeights falls back to defaults when the role has no override", () => {
    expect(resolveWeights(CYCLE, "designer")).toEqual(CYCLE.defaultWeights);
    expect(resolveWeights(CYCLE, null)).toEqual(CYCLE.defaultWeights);
  });

  it("resolveWeights uses the role override when present (weights frozen at generate time)", () => {
    expect(resolveWeights(CYCLE, "senior_developer")).toEqual(CYCLE.roleWeights.senior_developer);
  });
});

describe("percentileRank / bandForPercentile", () => {
  it("ranks a value against its cohort (fraction below + half ties)", () => {
    const cohort = [1, 2, 3, 4, 5];
    expect(percentileRank(cohort, 1)).toBe(10); // 0 below, 1 tied -> 0.5/5
    expect(percentileRank(cohort, 5)).toBe(90); // 4 below, 1 tied -> 4.5/5
    expect(percentileRank(cohort, 3)).toBe(50); // 2 below, 1 tied -> 2.5/5
  });

  it("a single-member cohort ranks at 50 (nothing to compare against)", () => {
    expect(percentileRank([7], 7)).toBe(50);
  });

  it("bandForPercentile is a strict quintile mapping", () => {
    expect(bandForPercentile(0)).toBe(1);
    expect(bandForPercentile(19)).toBe(1);
    expect(bandForPercentile(20)).toBe(2);
    expect(bandForPercentile(59)).toBe(3);
    expect(bandForPercentile(60)).toBe(4);
    expect(bandForPercentile(100)).toBe(5);
  });
});

function metricVals(entries: Record<string, number>): Map<string, SubjectMetricValue> {
  const m = new Map<string, SubjectMetricValue>();
  for (const [k, v] of Object.entries(entries)) m.set(k, { value: v, numerator: v, denominator: 1 });
  return m;
}

describe("computeCohortBands — §5.2 anti-gaming (points 2, 3, 4)", () => {
  it("SMALL-COHORT GUARD: suppresses band AND percentile below 5 members, keeps value/numerator/denominator", () => {
    expect(SMALL_COHORT_THRESHOLD).toBe(5);
    const cohort = new Map([
      ["a", metricVals({ "delivery.throughput_weighted": 100 })],
      ["b", metricVals({ "delivery.throughput_weighted": 200 })],
      ["c", metricVals({ "delivery.throughput_weighted": 300 })],
    ]);
    const bands = computeCohortBands(cohort);
    const aBand = bands.get("a")!.find((b) => b.metricKey === "delivery.throughput_weighted")!;
    expect(aBand.band).toBeNull();
    expect(aBand.subjectPercentile).toBeUndefined(); // withheld together with the band, not just the band
    expect(aBand.cohortSize).toBe(3);
    expect(aBand.subjectValue).toBe(100);
    expect(aBand.numerator).toBe(100);
    expect(aBand.denominator).toBe(1); // §5.2 point 2: every safe rate carries its denominator regardless of banding
  });

  it("a 5-member cohort IS bandable — the guard is a strict >= 5, not > 5", () => {
    const cohort = new Map(
      ["a", "b", "c", "d", "e"].map((id, i) => [id, metricVals({ "delivery.on_time_rate": (i + 1) * 10 })] as const),
    );
    const bands = computeCohortBands(cohort);
    const aBand = bands.get("a")!.find((b) => b.metricKey === "delivery.on_time_rate")!;
    expect(aBand.band).not.toBeNull();
    expect(aBand.subjectPercentile).not.toBeUndefined();
    expect(aBand.cohortSize).toBe(5);
  });

  it("cross-role comparison is structurally impossible: bands are computed per COHORT MAP, one call per role group — a caller passing two different roles' subjects in one map would blend them, so the caller (generate) MUST group by role first (proven in the controller-level db test, not here — this test only proves the function bands whatever map it's given, honestly)", () => {
    // Documents the contract: computeCohortBands has NO role-awareness itself; role separation is
    // the CALLER's job (generateCycleAppraisals groups by resolved roleKey before calling this).
    const cohort = new Map([
      ["designer-1", metricVals({ "delivery.on_time_rate": 1 })],
      ["designer-2", metricVals({ "delivery.on_time_rate": 1 })],
      ["designer-3", metricVals({ "delivery.on_time_rate": 1 })],
      ["designer-4", metricVals({ "delivery.on_time_rate": 1 })],
      ["designer-5", metricVals({ "delivery.on_time_rate": 1 })],
    ]);
    const bands = computeCohortBands(cohort);
    expect(bands.get("designer-1")!.find((b) => b.metricKey === "delivery.on_time_rate")!.cohortSize).toBe(5);
  });

  it("flags discipline-axis metrics (#18/#19) as informationalOnly — they have no weighted axis home", () => {
    const cohort = new Map(
      ["a", "b", "c", "d", "e"].map((id) => [id, metricVals({ "discipline.checkin_compliance": 0.9, "delivery.on_time_rate": 0.9 })] as const),
    );
    const bands = computeCohortBands(cohort);
    const discipline = bands.get("a")!.find((b) => b.metricKey === "discipline.checkin_compliance")!;
    const delivery = bands.get("a")!.find((b) => b.metricKey === "delivery.on_time_rate")!;
    expect(discipline.informationalOnly).toBe(true);
    expect(delivery.informationalOnly).toBe(false);
  });

  it("flow.reopen_rate (lower_better) bands a LOWER value as the BETTER band, not the worse one", () => {
    const cohort = new Map([
      ["low", metricVals({ "flow.reopen_rate": 0.01 })],
      ["mid1", metricVals({ "flow.reopen_rate": 0.1 })],
      ["mid2", metricVals({ "flow.reopen_rate": 0.2 })],
      ["mid3", metricVals({ "flow.reopen_rate": 0.3 })],
      ["high", metricVals({ "flow.reopen_rate": 0.9 })],
    ]);
    const bands = computeCohortBands(cohort);
    const low = bands.get("low")!.find((b) => b.metricKey === "flow.reopen_rate")!;
    const high = bands.get("high")!.find((b) => b.metricKey === "flow.reopen_rate")!;
    expect(low.band!).toBeGreaterThan(high.band!);
  });

  it("effort.estimate_accuracy bands CLOSENESS to 1.0, not magnitude — both over- and under-estimating rank worse than accurate", () => {
    const cohort = new Map([
      ["accurate", metricVals({ "effort.estimate_accuracy": 1.0 })],
      ["under", metricVals({ "effort.estimate_accuracy": 0.5 })],
      ["over", metricVals({ "effort.estimate_accuracy": 1.5 })],
      ["mid1", metricVals({ "effort.estimate_accuracy": 0.8 })],
      ["mid2", metricVals({ "effort.estimate_accuracy": 1.2 })],
    ]);
    const bands = computeCohortBands(cohort);
    const accurate = bands.get("accurate")!.find((b) => b.metricKey === "effort.estimate_accuracy")!;
    const under = bands.get("under")!.find((b) => b.metricKey === "effort.estimate_accuracy")!;
    const over = bands.get("over")!.find((b) => b.metricKey === "effort.estimate_accuracy")!;
    expect(accurate.band!).toBeGreaterThan(under.band!);
    expect(accurate.band!).toBeGreaterThan(over.band!);
  });
});

describe("axisAutoScores", () => {
  it("aggregates a rounded average of an axis's bandable constituent metrics", () => {
    const bands = [
      { metricKey: "delivery.throughput_weighted", metricLabel: "", unit: "minutes" as const, subjectValue: 1, band: 5 as const, cohortSize: 5, axis: "delivery", informationalOnly: false },
      { metricKey: "delivery.on_time_rate", metricLabel: "", unit: "percent" as const, subjectValue: 1, band: 3 as const, cohortSize: 5, axis: "delivery", informationalOnly: false },
    ];
    const scores = axisAutoScores(bands);
    expect(scores.delivery).toBe(4); // round((5+3)/2)
    expect(scores.quality).toBeNull();
  });

  it("excludes informationalOnly (discipline) metrics from every weighted axis", () => {
    const bands = [
      { metricKey: "discipline.checkin_compliance", metricLabel: "", unit: "percent" as const, subjectValue: 1, band: 5 as const, cohortSize: 5, axis: "discipline", informationalOnly: true },
    ];
    const scores = axisAutoScores(bands);
    for (const axis of APPRAISAL_AXES) expect(scores[axis]).toBeNull();
  });

  it("an axis with every constituent metric small-cohort-suppressed (band:null) yields auto:null", () => {
    const bands = [
      { metricKey: "effort.estimate_accuracy", metricLabel: "", unit: "percent" as const, subjectValue: 1, band: null, cohortSize: 3, axis: "effort", informationalOnly: false },
    ];
    expect(axisAutoScores(bands).effort).toBeNull();
  });
});

const FULL_SCORES = (overrides: Partial<Record<AppraisalAxis, AppraisalAxisScore>> = {}): Record<AppraisalAxis, AppraisalAxisScore> => ({
  delivery: { auto: 3, manager: 3 },
  quality: { auto: 3, manager: 3 },
  effort: { auto: 3, manager: 3 },
  collaboration: { auto: 3, manager: 3 },
  ...overrides,
});

describe("computeComposite", () => {
  it("computes Σ weight * manager score across the four weighted axes", () => {
    const composite = computeComposite(CYCLE.defaultWeights, FULL_SCORES());
    expect(composite).toBe(3); // uniform score of 3 on every axis, weights sum to 1
  });

  it("is null until every axis has a manager score (never computed on a partial pack)", () => {
    expect(computeComposite(CYCLE.defaultWeights, FULL_SCORES({ effort: { auto: 3, manager: null } }))).toBeNull();
  });
});

describe("findMissingDeviationNotes — §5.2 point 4", () => {
  it("DEVIATION_THRESHOLD is ±1 band", () => {
    expect(DEVIATION_THRESHOLD).toBe(1);
  });

  it("flags an axis whose manager score deviates by more than 1 band from auto WITHOUT a note", () => {
    const scores = FULL_SCORES({ delivery: { auto: 2, manager: 5 } }); // deviates by 3
    expect(findMissingDeviationNotes(CYCLE.defaultWeights, scores)).toEqual(["delivery"]);
  });

  it("does NOT flag a >1 deviation that carries a non-empty note", () => {
    const scores = FULL_SCORES({ delivery: { auto: 2, manager: 5, note: "team delivered a major release ahead of the cohort" } });
    expect(findMissingDeviationNotes(CYCLE.defaultWeights, scores)).toEqual([]);
  });

  it("does NOT flag a deviation of exactly 1 band (the threshold is strictly greater-than)", () => {
    const scores = FULL_SCORES({ delivery: { auto: 3, manager: 4 } });
    expect(findMissingDeviationNotes(CYCLE.defaultWeights, scores)).toEqual([]);
  });

  it("never flags an axis with no auto band to deviate from (small-cohort-suppressed or no applicable metric)", () => {
    const scores = FULL_SCORES({ delivery: { auto: null, manager: 5 } });
    expect(findMissingDeviationNotes(CYCLE.defaultWeights, scores)).toEqual([]);
  });

  it("a note that is only whitespace does not count as justification", () => {
    const scores = FULL_SCORES({ delivery: { auto: 1, manager: 5, note: "   " } });
    expect(findMissingDeviationNotes(CYCLE.defaultWeights, scores)).toEqual(["delivery"]);
  });
});

describe("isValidCommentary — mandatory commentary >= 50 chars", () => {
  it("rejects undefined/empty/short commentary", () => {
    expect(MIN_COMMENTARY_LENGTH).toBe(50);
    expect(isValidCommentary(undefined)).toBe(false);
    expect(isValidCommentary(null)).toBe(false);
    expect(isValidCommentary("too short")).toBe(false);
  });

  it("accepts commentary >= 50 chars after trim", () => {
    const c = "Consistently delivered on time with high quality and strong collaboration.";
    expect(c.trim().length).toBeGreaterThanOrEqual(50);
    expect(isValidCommentary(c)).toBe(true);
  });

  it("counts length AFTER trim (leading/trailing whitespace is not padding)", () => {
    const padded = `   ${"x".repeat(45)}   `; // 45 real chars, well under 50 after trim
    expect(isValidCommentary(padded)).toBe(false);
  });
});
