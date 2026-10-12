// M5-V5-b — pure unit tests for the A/B statistics engine (experiment-stats.ts). No DB, no Cerbos.
//
// Reference values quoted below come from published sources, not from this implementation:
//   * z_{0.975} = 1.959963984540054, z_{0.8} = 0.8416212335729143, z_{0.999} = 3.090232306167813,
//     Phi(1.96) = 0.9750021048517795, Phi(-3) = 0.0013498980316301 (standard normal tables / R qnorm, pnorm).
//   * chi-square critical values (df 1: 3.841459 -> 0.05, 10.827566 -> 0.001; df 2: 5.991465 -> 0.05;
//     df 3: 7.814728 -> 0.05) and the closed form sf(x, df = 2) = exp(-x / 2).
//   * R documentation of `power.prop.test`: `power.prop.test(p1 = .50, p2 = .75, power = .90)` gives
//     n = 76.7 and `power.prop.test(n = 50, p1 = .5, p2 = .75)` gives power = 0.740.
//   * The design's own known answer (docs/plans/2026-10-12-m5-phase5-design.md §5.4, §8 row V5-b):
//     3.0 % -> 4.5 %, alpha 0.05, power 0.8 -> 2,518 per arm (2517.003 before rounding).
//   * Fisher: R `fisher.test(matrix(c(3,1,1,3), 2))` p = 0.4857 (the lady tasting tea, 34/70);
//     Wikipedia's dieting example [[1, 9], [11, 3]] p = 0.002759; [[10, 0], [0, 10]] p = 2 / C(20, 10).
//   * Holm: R `p.adjust(c(0.01, 0.04, 0.03), "holm")` = 0.03 0.06 0.06.
//   * Newcombe (1998), Statistics in Medicine 17:873, example 56/70 vs 48/80, method 10: (0.0524, 0.3339);
//     the Wilson score interval for 81/263 is (0.2553, 0.3662).
import { describe, expect, it } from "vitest";
import {
  EXPERIMENT_STATS_LIMITS,
  ExperimentStatsError,
  analyseAtHorizon,
  chiSquareSf,
  evaluateExperiment,
  fisherExact,
  holmAdjust,
  logFactorial,
  logGamma,
  minExpectedCell,
  newcombeInterval,
  normalCdf,
  normalQuantile,
  normalSf,
  pooledZTest,
  powerTwoProportions,
  progressView,
  projectDuration,
  sampleRatioMismatch,
  sampleSizeForRates,
  sampleSizePerArm,
  wholeDaysBetween,
  wilsonInterval,
  type ExperimentPlan,
} from "./experiment-stats";

describe("special functions", () => {
  it("normal CDF/SF match published values", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 15);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021048517795, 13);
    expect(normalCdf(-3)).toBeCloseTo(0.0013498980316301, 14);
    expect(normalSf(3)).toBeCloseTo(0.0013498980316301, 14);
    // deep tail keeps relative accuracy: Phi(-8) = 6.220960574271785e-16
    expect(normalCdf(-8) / 6.220960574271785e-16).toBeCloseTo(1, 9);
  });

  it("normal quantile matches published values and inverts the CDF", () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963984540054, 12);
    expect(normalQuantile(0.8)).toBeCloseTo(0.8416212335729143, 12);
    expect(normalQuantile(0.999)).toBeCloseTo(3.090232306167813, 11);
    expect(normalQuantile(0.025)).toBeCloseTo(-1.959963984540054, 12);
    for (const p of [1e-9, 1e-4, 0.01, 0.2, 0.5, 0.77, 0.99, 1 - 1e-7]) {
      expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 12);
    }
  });

  it("log-gamma and log-factorial are exact where known", () => {
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 13);
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 13);
    expect(logFactorial(10)).toBeCloseTo(Math.log(3628800), 13);
    // table / Stirling seam: ln(255!) via table vs gamma, ln(256!) via Stirling vs gamma
    expect(logFactorial(255)).toBeCloseTo(logGamma(256), 9);
    expect(logFactorial(256)).toBeCloseTo(logGamma(257), 9);
    expect(logFactorial(100000)).toBeCloseTo(logGamma(100001), 6);
  });

  it("chi-square survival matches critical values and the df=2 closed form", () => {
    expect(chiSquareSf(3.841458820694124, 1)).toBeCloseTo(0.05, 10);
    expect(chiSquareSf(10.827566170662733, 1)).toBeCloseTo(0.001, 10);
    expect(chiSquareSf(5.991464547107979, 2)).toBeCloseTo(0.05, 10);
    expect(chiSquareSf(7.814727903251179, 3)).toBeCloseTo(0.05, 10);
    for (const x of [0.1, 1, 4, 9, 30, 80]) expect(chiSquareSf(x, 2)).toBeCloseTo(Math.exp(-x / 2), 12);
    // df = 1 is a squared normal
    for (const x of [0.5, 2, 6, 15]) expect(chiSquareSf(x, 1)).toBeCloseTo(2 * normalSf(Math.sqrt(x)), 12);
    expect(chiSquareSf(0, 3)).toBe(1);
  });
});

describe("(1) sample size per arm", () => {
  it("reproduces the design's known answer: 3.0 % -> 4.5 % needs 2,518 per arm", () => {
    const s = sampleSizePerArm({ baselineRate: 0.03, relativeMde: 0.5 });
    expect(s.nPerArm).toBe(2518);
    expect(s.nExact).toBeCloseTo(2517.003, 3);
    expect(s.targetRate).toBeCloseTo(0.045, 12);
    expect(s.alpha).toBe(0.05);
    expect(s.power).toBe(0.8);
  });

  it("matches R power.prop.test(p1 = .50, p2 = .75, power = .90): n = 76.7", () => {
    const n = sampleSizeForRates(0.5, 0.75, 0.05, 0.9);
    expect(n).toBeCloseTo(76.7, 1);
    // Reports as 76.65 in R's docs rounding; the integer sizing is 77.
    expect(sampleSizePerArm({ baselineRate: 0.5, relativeMde: 0.5, power: 0.9 }).nPerArm).toBe(77);
  });

  it("matches R power.prop.test(n = 50, p1 = .5, p2 = .75): power = 0.740", () => {
    expect(powerTwoProportions(50, 0.5, 0.75)).toBeCloseTo(0.7401659, 3);
  });

  it("the returned n is the smallest integer reaching the target power (independent route via the power function)", () => {
    const cases: Array<[number, number, number, number]> = [
      [0.03, 0.5, 0.05, 0.8],
      [0.1, 0.2, 0.05, 0.8],
      [0.02, 0.25, 0.05, 0.9],
      [0.25, 0.1, 0.01, 0.8],
    ];
    for (const [p0, mde, alpha, power] of cases) {
      const s = sampleSizePerArm({ baselineRate: p0, relativeMde: mde, alpha, power });
      expect(powerTwoProportions(s.nPerArm, p0, s.targetRate, alpha)).toBeGreaterThanOrEqual(power - 1e-9);
      expect(powerTwoProportions(s.nPerArm - 1, p0, s.targetRate, alpha)).toBeLessThan(power);
    }
  });

  it("agrees with Lehr's rule of thumb (n ~ 16 * pbar * qbar / delta^2 at 80 % power) within 5 %", () => {
    const s = sampleSizePerArm({ baselineRate: 0.03, relativeMde: 0.5 });
    const pbar = 0.0375;
    const lehr = (16 * pbar * (1 - pbar)) / 0.015 ** 2;
    expect(Math.abs(s.nPerArm - lehr) / lehr).toBeLessThan(0.05);
  });

  it("n is monotone: it falls as the MDE grows and rises with power and with a smaller alpha", () => {
    let prev = Infinity;
    for (const mde of [0.05, 0.1, 0.2, 0.35, 0.5, 0.8, 1.2]) {
      const n = sampleSizePerArm({ baselineRate: 0.03, relativeMde: mde }).nPerArm;
      expect(n).toBeLessThan(prev);
      prev = n;
    }
    const base = sampleSizePerArm({ baselineRate: 0.03, relativeMde: 0.3 }).nPerArm;
    expect(sampleSizePerArm({ baselineRate: 0.03, relativeMde: 0.3, power: 0.9 }).nPerArm).toBeGreaterThan(base);
    expect(sampleSizePerArm({ baselineRate: 0.03, relativeMde: 0.3, alpha: 0.01 }).nPerArm).toBeGreaterThan(base);
    expect(sampleSizePerArm({ baselineRate: 0.03, relativeMde: 0.3, comparisons: 3 }).nPerArm).toBeGreaterThan(base);
  });

  it("rejects malformed input with a typed error", () => {
    const bad = [
      { baselineRate: 0, relativeMde: 0.5 },
      { baselineRate: 1, relativeMde: 0.5 },
      { baselineRate: 0.03, relativeMde: 0 },
      { baselineRate: 0.03, relativeMde: -0.2 },
      { baselineRate: 0.6, relativeMde: 0.8 }, // p1 >= 1
      { baselineRate: 0.03, relativeMde: 0.5, alpha: 0 },
      { baselineRate: 0.03, relativeMde: 0.5, power: 1 },
      { baselineRate: Number.NaN, relativeMde: 0.5 },
      { baselineRate: 0.03, relativeMde: 0.5, comparisons: 0 },
    ];
    for (const b of bad) expect(() => sampleSizePerArm(b)).toThrow(ExperimentStatsError);
  });
});

describe("(2) duration projection", () => {
  it("the design's examples: 2,518 per arm at 300 units a day is 17 days, at 120 it is 42", () => {
    const at300 = projectDuration({ nPerArm: 2518, weights: [50, 50], dailyUnits: 300 });
    expect(at300).toMatchObject({ ok: true, days: 17 });
    const at120 = projectDuration({ nPerArm: 2518, weights: [50, 50], dailyUnits: 120 });
    expect(at120).toMatchObject({ ok: true, days: 42 });
  });

  it("applies the 14-day floor and says so", () => {
    const r = projectDuration({ nPerArm: 500, weights: [50, 50], dailyUnits: 1000 });
    expect(r).toMatchObject({ ok: true, days: 14, limitedByMinimum: true });
  });

  it("allows exactly 56 days and refuses 57 with a typed 'underpowered'", () => {
    // 2 arms, 50/50: days = n * 2 / daily. n = 2800, daily = 100 -> exactly 56.
    expect(projectDuration({ nPerArm: 2800, weights: [50, 50], dailyUnits: 100 })).toMatchObject({ ok: true, days: 56 });
    const r = projectDuration({ nPerArm: 2801, weights: [50, 50], dailyUnits: 100 });
    expect(r).toEqual({ ok: false, reason: "underpowered", projectedDays: 57, maxDays: 56 });
  });

  it("the arm with the smallest weight sets the pace; more arms take longer", () => {
    const even = projectDuration({ nPerArm: 1000, weights: [50, 50], dailyUnits: 200 });
    const lopsided = projectDuration({ nPerArm: 1000, weights: [80, 20], dailyUnits: 200 });
    const three = projectDuration({ nPerArm: 1000, weights: [34, 33, 33], dailyUnits: 200 });
    expect(even.ok && lopsided.ok && three.ok).toBe(true);
    if (even.ok && lopsided.ok && three.ok) {
      expect(lopsided.days).toBeGreaterThan(even.days);
      expect(three.days).toBeGreaterThan(even.days);
    }
  });

  it("no traffic is underpowered; bad plans throw", () => {
    expect(projectDuration({ nPerArm: 100, weights: [50, 50], dailyUnits: 0 })).toMatchObject({ ok: false, reason: "underpowered" });
    expect(() => projectDuration({ nPerArm: 100, weights: [60, 50], dailyUnits: 10 })).toThrow(ExperimentStatsError);
    expect(() => projectDuration({ nPerArm: 100, weights: [100], dailyUnits: 10 })).toThrow(ExperimentStatsError);
    expect(() => projectDuration({ nPerArm: 100, weights: [20, 20, 20, 20, 20], dailyUnits: 10 })).toThrow(ExperimentStatsError);
    expect(() => projectDuration({ nPerArm: 0, weights: [50, 50], dailyUnits: 10 })).toThrow(ExperimentStatsError);
  });
});

describe("(3) intervals and tests", () => {
  it("Wilson interval matches Newcombe's published 81/263", () => {
    const w = wilsonInterval(81, 263);
    expect(w.lower).toBeCloseTo(0.2553, 4);
    expect(w.upper).toBeCloseTo(0.3662, 4);
  });

  it("Newcombe hybrid-score interval matches the published example 56/70 vs 48/80", () => {
    const ci = newcombeInterval(56, 70, 48, 80);
    expect(ci.diff).toBeCloseTo(0.2, 12);
    expect(ci.lower).toBeCloseTo(0.0524, 4);
    expect(ci.upper).toBeCloseTo(0.3339, 4);
  });

  it("Wilson stays inside [0, 1] at the extremes", () => {
    expect(wilsonInterval(0, 50).lower).toBe(0);
    expect(wilsonInterval(50, 50).upper).toBe(1);
    expect(wilsonInterval(0, 50).upper).toBeGreaterThan(0);
  });

  it("pooled z-test: 45/1000 vs 30/1000 equals prop.test(correct = FALSE) chi-square 3.117, p = 0.0775", () => {
    const r = pooledZTest({ x1: 45, n1: 1000, x0: 30, n0: 1000 });
    expect(r.z * r.z).toBeCloseTo(3.1168, 3);
    expect(r.pValue).toBeCloseTo(0.07749, 4);
    expect(r.pValue).toBeCloseTo(chiSquareSf(r.z * r.z, 1), 12);
  });

  it("Fisher: the lady tasting tea [[3,1],[1,3]] has p = 34/70", () => {
    expect(fisherExact({ x1: 3, n1: 4, x0: 1, n0: 4 }).pValue).toBeCloseTo(34 / 70, 12);
  });

  it("Fisher: [[1,9],[11,3]] has p = 0.002759 and is symmetric under swapping the arms", () => {
    const p = fisherExact({ x1: 1, n1: 10, x0: 11, n0: 14 }).pValue;
    expect(p).toBeCloseTo(0.002759, 5);
    expect(fisherExact({ x1: 11, n1: 14, x0: 1, n0: 10 }).pValue).toBeCloseTo(p, 12);
  });

  it("Fisher: perfect separation [[10,0],[0,10]] has p = 2 / C(20,10); identical arms give 1", () => {
    expect(fisherExact({ x1: 10, n1: 10, x0: 0, n0: 10 }).pValue).toBeCloseTo(2 / 184756, 12);
    expect(fisherExact({ x1: 0, n1: 500, x0: 0, n0: 500 }).pValue).toBe(1);
  });

  it("Fisher does not overflow on big arms and agrees with the z-test when both apply", () => {
    const t = { x1: 1500, n1: 100000, x0: 1400, n0: 100000 };
    const f = fisherExact(t).pValue;
    expect(Number.isFinite(f)).toBe(true);
    expect(Math.abs(f - pooledZTest(t).pValue)).toBeLessThan(0.005);
  });

  it("minExpectedCell finds the smallest cell; the switch happens below 5", () => {
    // 2/100 vs 1/100: conversions column total 3, expected 1.5 per arm
    expect(minExpectedCell({ x1: 2, n1: 100, x0: 1, n0: 100 })).toBeCloseTo(1.5, 12);
    expect(minExpectedCell({ x1: 50, n1: 100, x0: 40, n0: 100 })).toBeCloseTo(45, 12);
  });

  it("rejects impossible tables", () => {
    expect(() => fisherExact({ x1: 11, n1: 10, x0: 1, n0: 10 })).toThrow(ExperimentStatsError);
    expect(() => pooledZTest({ x1: 1, n1: 0, x0: 0, n0: 10 })).toThrow(ExperimentStatsError);
    expect(() => newcombeInterval(1.5, 10, 1, 10)).toThrow(ExperimentStatsError);
  });
});

describe("Holm-Bonferroni", () => {
  it("matches R p.adjust(c(0.01, 0.04, 0.03), 'holm') = 0.03 0.06 0.06, in input order", () => {
    const a = holmAdjust([0.01, 0.04, 0.03]);
    expect(a[0]).toBeCloseTo(0.03, 12);
    expect(a[1]).toBeCloseTo(0.06, 12);
    expect(a[2]).toBeCloseTo(0.06, 12);
  });

  it("steps down: multipliers are m, m-1, ... in ascending-p order and the result is monotone", () => {
    // sorted: 0.001 (x4), 0.011 (x3), 0.012 (x2), 0.5 (x1)
    const a = holmAdjust([0.5, 0.012, 0.001, 0.011]);
    expect(a[2]).toBeCloseTo(0.004, 12);
    expect(a[3]).toBeCloseTo(0.033, 12);
    // 0.012 * 2 = 0.024 < 0.033, so the running maximum lifts it to 0.033
    expect(a[1]).toBeCloseTo(0.033, 12);
    expect(a[0]).toBeCloseTo(0.5, 12);
  });

  it("caps at 1, handles one comparison and the empty list, never lowers a p, keeps ties together", () => {
    expect(holmAdjust([0.6, 0.7])).toEqual([1, 1]);
    expect(holmAdjust([0.03])).toEqual([0.03]);
    expect(holmAdjust([])).toEqual([]);
    const t = holmAdjust([0.02, 0.02, 0.2]);
    expect(t[0]).toBeCloseTo(0.06, 12);
    expect(t[1]).toBeCloseTo(0.06, 12);
  });

  it("property: adjusted >= raw, within [0, 1], order-preserving, for 400 random vectors", () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 400; i++) {
      const m = 1 + Math.floor(rnd() * 5);
      const ps = Array.from({ length: m }, () => rnd() ** 2);
      const adj = holmAdjust(ps);
      ps.forEach((p, j) => {
        expect(adj[j]!).toBeGreaterThanOrEqual(p - 1e-15);
        expect(adj[j]!).toBeLessThanOrEqual(1);
        expect(adj[j]!).toBeGreaterThanOrEqual(0);
        ps.forEach((q, k) => {
          if (p < q) expect(adj[j]!).toBeLessThanOrEqual(adj[k]! + 1e-15);
        });
      });
    }
  });

  it("rejects p-values outside [0, 1]", () => {
    expect(() => holmAdjust([1.2])).toThrow(ExperimentStatsError);
    expect(() => holmAdjust([-0.1])).toThrow(ExperimentStatsError);
    expect(() => holmAdjust([Number.NaN])).toThrow(ExperimentStatsError);
  });
});

describe("(4) sample-ratio mismatch", () => {
  it("flags a 50/50 plan observed at 52/48 with large n", () => {
    const r = sampleRatioMismatch([5200, 4800], [50, 50]);
    expect(r.chiSquare).toBeCloseTo(16, 10); // 2 * 200^2 / 5000
    expect(r.pValue).toBeLessThan(0.001);
    expect(r.mismatch).toBe(true);
    expect(r.df).toBe(1);
  });

  it("does not flag 52/48 at small n", () => {
    const r = sampleRatioMismatch([520, 480], [50, 50]);
    expect(r.chiSquare).toBeCloseTo(1.6, 10);
    expect(r.pValue).toBeCloseTo(0.2059, 3);
    expect(r.mismatch).toBe(false);
    expect(sampleRatioMismatch([52, 48], [50, 50]).mismatch).toBe(false);
  });

  it("the threshold is p < 0.001, not 0.05: chi-square 10.0 (p = 0.0016) is not flagged, 11.0 (p = 0.0009) is", () => {
    // 50/50, total N, observed (N/2 + d, N/2 - d): chi2 = 4 d^2 / N
    expect(sampleRatioMismatch([5000 + 50, 5000 - 50], [50, 50]).chiSquare).toBeCloseTo(1, 10); // control for the algebra
    const near = sampleRatioMismatch([500 + 50, 500 - 50], [50, 50]); // chi2 = 10
    expect(near.chiSquare).toBeCloseTo(10, 10);
    expect(near.pValue).toBeCloseTo(0.001565, 5);
    expect(near.mismatch).toBe(false);
    const over = sampleRatioMismatch([5000 + 524, 5000 - 524 + 0], [50, 50]); // chi2 = 4*524^2/10000 ~ 109
    expect(over.mismatch).toBe(true);
    // chi2 = 11 -> p = 0.000911: N = 1100, d = 55 -> 4 * 3025 / 1100 = 11
    const eleven = sampleRatioMismatch([550 + 55, 550 - 55], [50, 50]);
    expect(eleven.chiSquare).toBeCloseTo(11, 10);
    expect(eleven.mismatch).toBe(true);
  });

  it("works for unequal weights and 3 arms (df = 2); a perfect split has p = 1", () => {
    const perfect = sampleRatioMismatch([700, 300], [70, 30]);
    expect(perfect.chiSquare).toBeCloseTo(0, 12);
    expect(perfect.pValue).toBeCloseTo(1, 12);
    const three = sampleRatioMismatch([3400, 3300, 3300], [34, 33, 33]);
    expect(three.df).toBe(2);
    expect(three.mismatch).toBe(false);
    expect(sampleRatioMismatch([2000, 3000, 1000], [34, 33, 33]).mismatch).toBe(true);
  });

  it("no exposures yet is not evaluable and never flags", () => {
    const r = sampleRatioMismatch([0, 0], [50, 50]);
    expect(r).toMatchObject({ evaluable: false, mismatch: false, pValue: 1 });
  });

  it("rejects mismatched shapes", () => {
    expect(() => sampleRatioMismatch([1, 2, 3], [50, 50])).toThrow(ExperimentStatsError);
    expect(() => sampleRatioMismatch([1.5, 2], [50, 50])).toThrow(ExperimentStatsError);
  });
});

describe("analysis at the horizon: every decision case", () => {
  const control = { key: "a", units: 3000, conversions: 90 }; // 3.0 %

  it("ships a clear winner: 3.0 % vs 4.5 % at n = 3000", () => {
    const r = analyseAtHorizon(control, [{ key: "b", units: 3000, conversions: 135 }]);
    const b = r.comparisons[0]!;
    expect(b.method).toBe("z");
    expect(b.difference).toBeCloseTo(0.015, 12);
    expect(b.pRaw).toBeLessThan(0.01);
    expect(b.pAdjusted).toBeCloseTo(b.pRaw, 15); // one comparison: no inflation
    expect(b.ciLower).toBeGreaterThan(0);
    expect(b.ciLevel).toBeCloseTo(0.95, 12);
    expect(b.significantWinner).toBe(true);
    expect(r.decision).toEqual({ action: "ship", arm: "b" });
  });

  it("keeps control when the difference is not significant", () => {
    const r = analyseAtHorizon(control, [{ key: "b", units: 3000, conversions: 100 }]);
    expect(r.comparisons[0]!.pAdjusted).toBeGreaterThan(0.05);
    expect(r.comparisons[0]!.significantWinner).toBe(false);
    expect(r.decision).toEqual({ action: "keep_control", reason: "no_significant_winner" });
  });

  it("never ships a significant LOSER", () => {
    const r = analyseAtHorizon({ key: "a", units: 3000, conversions: 135 }, [{ key: "b", units: 3000, conversions: 80 }]);
    const b = r.comparisons[0]!;
    expect(b.pAdjusted).toBeLessThan(0.05);
    expect(b.ciLower).toBeLessThan(0);
    expect(b.significantWinner).toBe(false);
    expect(r.decision.action).toBe("keep_control");
  });

  it("requires the interval's lower bound above 0 as well as adjusted p < alpha", () => {
    // Fabricate the boundary through Holm: two arms with the same raw p just under 0.05 -> adjusted 0.05+ -> not a winner.
    const c = { key: "a", units: 3000, conversions: 90 };
    const r = analyseAtHorizon(c, [
      { key: "b", units: 3000, conversions: 120 },
      { key: "c", units: 3000, conversions: 120 },
    ]);
    const [b, cc] = r.comparisons;
    expect(b!.pRaw).toBeCloseTo(cc!.pRaw, 15);
    expect(b!.pAdjusted).toBeCloseTo(Math.min(1, 2 * b!.pRaw), 12);
    expect(b!.significantWinner).toBe(b!.pAdjusted < 0.05 && b!.ciLower > 0);
  });

  it("Holm across arms: a raw p below 0.05 can fail after correction", () => {
    // raw p of arm b is ~0.031 (significant alone); with a second comparison it becomes ~0.062
    const c = { key: "a", units: 4000, conversions: 120 };
    const r = analyseAtHorizon(c, [
      { key: "b", units: 4000, conversions: 156 },
      { key: "c", units: 4000, conversions: 118 },
    ]);
    const b = r.comparisons[0]!;
    expect(b.pRaw).toBeLessThan(0.05);
    expect(b.pAdjusted).toBeGreaterThanOrEqual(0.05);
    expect(r.decision).toEqual({ action: "keep_control", reason: "no_significant_winner" });
  });

  it("with several winners the best estimate ships", () => {
    const r = analyseAtHorizon({ key: "a", units: 5000, conversions: 100 }, [
      { key: "b", units: 5000, conversions: 200 },
      { key: "c", units: 5000, conversions: 260 },
      { key: "d", units: 5000, conversions: 90 },
    ]);
    expect(r.comparisons.map((c) => c.significantWinner)).toEqual([true, true, false]);
    expect(r.decision).toEqual({ action: "ship", arm: "c" });
  });

  it("uses Fisher's exact test when an expected cell is below 5, and z otherwise", () => {
    const small = analyseAtHorizon({ key: "a", units: 2500, conversions: 1 }, [{ key: "b", units: 2500, conversions: 7 }]);
    expect(small.comparisons[0]!.method).toBe("fisher");
    expect(small.comparisons[0]!.pRaw).toBeCloseTo(fisherExact({ x1: 7, n1: 2500, x0: 1, n0: 2500 }).pValue, 15);
    const big = analyseAtHorizon(control, [{ key: "b", units: 3000, conversions: 135 }]);
    expect(big.comparisons[0]!.method).toBe("z");
    // boundary: expected conversions per arm = (x1 + x0) / 2 with equal n; 9 total -> 4.5 < 5 -> fisher, 10 -> 5 -> z
    expect(analyseAtHorizon({ key: "a", units: 1000, conversions: 4 }, [{ key: "b", units: 1000, conversions: 5 }]).comparisons[0]!.method).toBe("fisher");
    expect(analyseAtHorizon({ key: "a", units: 1000, conversions: 4 }, [{ key: "b", units: 1000, conversions: 6 }]).comparisons[0]!.method).toBe("z");
  });

  it("identical arms and zero conversions are handled: p = 1, keep control", () => {
    const r = analyseAtHorizon({ key: "a", units: 800, conversions: 0 }, [{ key: "b", units: 800, conversions: 0 }]);
    expect(r.comparisons[0]!.pRaw).toBe(1);
    expect(r.comparisons[0]!.difference).toBe(0);
    expect(r.decision.action).toBe("keep_control");
  });

  it("is deterministic and rejects duplicate keys, an empty arm list and impossible counts", () => {
    const a = analyseAtHorizon(control, [{ key: "b", units: 3000, conversions: 135 }]);
    const b = analyseAtHorizon(control, [{ key: "b", units: 3000, conversions: 135 }]);
    expect(a).toEqual(b);
    expect(() => analyseAtHorizon(control, [{ key: "a", units: 10, conversions: 1 }])).toThrow(ExperimentStatsError);
    expect(() => analyseAtHorizon(control, [])).toThrow(ExperimentStatsError);
    expect(() => analyseAtHorizon(control, [{ key: "b", units: 10, conversions: 11 }])).toThrow(ExperimentStatsError);
  });

  it("property: p-values in [0, 1], interval contains the difference, over 300 random experiments", () => {
    let seed = 987654;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 300; i++) {
      const k = 2 + Math.floor(rnd() * 3);
      const units = 20 + Math.floor(rnd() * 20000);
      const base = rnd() * 0.3;
      const mk = (key: string): { key: string; units: number; conversions: number } => ({
        key,
        units,
        conversions: Math.min(units, Math.floor(units * Math.min(1, base * (0.6 + rnd() * 0.9)))),
      });
      const r = analyseAtHorizon(mk("a"), ["b", "c", "d"].slice(0, k - 1).map(mk));
      for (const c of r.comparisons) {
        expect(c.pRaw).toBeGreaterThanOrEqual(0);
        expect(c.pRaw).toBeLessThanOrEqual(1);
        expect(c.pAdjusted).toBeGreaterThanOrEqual(c.pRaw - 1e-15);
        expect(c.pAdjusted).toBeLessThanOrEqual(1);
        expect(c.ciLower).toBeLessThanOrEqual(c.difference + 1e-15);
        expect(c.ciUpper).toBeGreaterThanOrEqual(c.difference - 1e-15);
        expect(c.ciLower).toBeGreaterThanOrEqual(-1);
        expect(c.ciUpper).toBeLessThanOrEqual(1);
      }
    }
  });

  it("p-value monotonicity: a larger gap at fixed n never raises p", () => {
    let prev = 2;
    for (const conv of [95, 105, 115, 125, 140, 160]) {
      const p = analyseAtHorizon({ key: "a", units: 3000, conversions: 90 }, [{ key: "b", units: 3000, conversions: conv }]).comparisons[0]!.pRaw;
      expect(p).toBeLessThan(prev);
      prev = p;
    }
  });

  it("a test sized for 3.0 % -> 4.5 % at n = 2,518 is the smallest n reaching 80 % power", () => {
    expect(powerTwoProportions(2518, 0.03, 0.045)).toBeGreaterThanOrEqual(0.8);
    expect(powerTwoProportions(2517, 0.03, 0.045)).toBeLessThan(0.8);
  });
});

describe("(5) the horizon guard: no estimate before the horizon", () => {
  const plan: ExperimentPlan = { nPerArm: 2518, weights: [50, 50], armKeys: ["a", "b"] };
  // Telltale members of an outcome. None may appear anywhere in a pre-horizon answer, at any depth.
  const OUTCOME_KEYS = [
    "rate",
    "difference",
    "ciLower",
    "ciUpper",
    "ciLevel",
    "pRaw",
    "pAdjusted",
    "conversions",
    "analysis",
    "comparisons",
    "significantWinner",
    "method",
    "lift",
    "estimate",
  ];
  function keysDeep(v: unknown, acc: Set<string> = new Set()): Set<string> {
    if (Array.isArray(v)) v.forEach((x) => keysDeep(x, acc));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        acc.add(k);
        keysDeep(x, acc);
      }
    }
    return acc;
  }
  const arms = (au: number, ac: number, bu: number, bc: number) => [
    { key: "a", units: au, conversions: ac },
    { key: "b", units: bu, conversions: bc },
  ];

  it("before the exposure target the answer is progress + SRM only", () => {
    const v = evaluateExperiment(plan, { arms: arms(1200, 40, 1180, 90), elapsedDays: 9 });
    expect(v.phase).toBe("collecting");
    expect(v.horizonReached).toBe(false);
    expect("analysis" in v).toBe(false);
    expect(v.progress.perArm).toEqual([
      { key: "a", exposures: 1200, target: 2518, fraction: 1200 / 2518 },
      { key: "b", exposures: 1180, target: 2518, fraction: 1180 / 2518 },
    ]);
    expect(v.progress.exposuresReached).toBe(false);
    expect(v.srm.mismatch).toBe(false);
    const found = keysDeep(v);
    for (const k of OUTCOME_KEYS) expect(found.has(k), `leaked key ${k}`).toBe(false);
  });

  it("with n exposures but fewer than 14 whole days there is still no estimate", () => {
    const v = evaluateExperiment(plan, { arms: arms(2600, 50, 2600, 120), elapsedDays: 13.9 });
    expect(v.horizonReached).toBe(false);
    expect(v.progress.exposuresReached).toBe(true);
    expect(v.progress.minDaysReached).toBe(false);
    expect(v.progress.elapsedDays).toBe(13);
    for (const k of OUTCOME_KEYS) expect(keysDeep(v).has(k), `leaked key ${k}`).toBe(false);
  });

  it("with 14 days but one arm short of n there is still no estimate", () => {
    const v = evaluateExperiment(plan, { arms: arms(2600, 50, 2517, 120), elapsedDays: 20 });
    expect(v.horizonReached).toBe(false);
    for (const k of OUTCOME_KEYS) expect(keysDeep(v).has(k), `leaked key ${k}`).toBe(false);
  });

  it("the guard never reads conversions before the horizon (poisoned counts do not matter)", () => {
    const poisoned = arms(100, Number.NaN, 100, -5) as unknown as Array<{ key: string; units: number; conversions: number }>;
    const v = evaluateExperiment(plan, { arms: poisoned, elapsedDays: 3 });
    expect(v.horizonReached).toBe(false);
  });

  it("at the horizon (every arm >= n and >= 14 whole days) the analysis appears", () => {
    const v = evaluateExperiment(plan, { arms: arms(2518, 76, 2530, 130), elapsedDays: 14 });
    expect(v.horizonReached).toBe(true);
    if (v.phase !== "horizon") throw new Error("expected horizon");
    expect(v.analysis.comparisons).toHaveLength(1);
    expect(v.analysis.decision.action).toBe("ship");
    expect(v.progress.exposuresReached && v.progress.minDaysReached).toBe(true);
  });

  it("property: for any pre-horizon observation no outcome key ever appears (500 random cases)", () => {
    let seed = 424242;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 500; i++) {
      const au = Math.floor(rnd() * 2517);
      const bu = Math.floor(rnd() * 5000);
      const days = Math.floor(rnd() * 56); // < 56 so never the cap
      const v = evaluateExperiment(plan, { arms: arms(au, Math.floor(au * rnd()), bu, Math.floor(bu * rnd())), elapsedDays: days });
      // au < n, so the horizon cannot be reached
      expect(v.horizonReached).toBe(false);
      const found = keysDeep(v);
      for (const k of OUTCOME_KEYS) expect(found.has(k), `leaked key ${k}`).toBe(false);
      expect(JSON.stringify(v)).not.toMatch(/"(rate|difference|pRaw|pAdjusted|ciLower)"/);
    }
  });

  it("the SRM check works before the horizon: a skewed split raises the alarm without any outcome", () => {
    const v = evaluateExperiment(plan, { arms: arms(1300, 40, 1100, 90), elapsedDays: 5 });
    expect(v.srm.mismatch).toBe(true);
    expect(v.horizonReached).toBe(false);
    for (const k of OUTCOME_KEYS) expect(keysDeep(v).has(k)).toBe(false);
  });

  it("at 56 days without the horizon: inconclusive, keep control, still no outcome", () => {
    const v = evaluateExperiment(plan, { arms: arms(1500, 50, 1500, 80), elapsedDays: 56 });
    expect(v.phase).toBe("inconclusive");
    expect(v.horizonReached).toBe(false);
    if (v.phase === "inconclusive") expect(v.decision).toEqual({ action: "keep_control", reason: "inconclusive_at_max_duration" });
    for (const k of OUTCOME_KEYS) expect(keysDeep(v).has(k)).toBe(false);
  });

  it("reaching the horizon on day 56 still analyses (the horizon wins over the cap)", () => {
    const v = evaluateExperiment(plan, { arms: arms(2518, 76, 2518, 77), elapsedDays: 56 });
    expect(v.phase).toBe("horizon");
  });

  it("progressView takes exposures only (its signature has no conversions) and rejects bad shapes", () => {
    const p = progressView(plan, [100, 90], 2);
    expect(Object.keys(p).sort()).toEqual(["elapsedDays", "exposuresReached", "maxDays", "minDays", "minDaysReached", "perArm"]);
    expect(() => progressView(plan, [100], 2)).toThrow(ExperimentStatsError);
    expect(() => progressView(plan, [100, 90], -1)).toThrow(ExperimentStatsError);
  });

  it("rejects arms out of plan order or of the wrong count", () => {
    expect(() =>
      evaluateExperiment(plan, { arms: [{ key: "b", units: 1, conversions: 0 }, { key: "a", units: 1, conversions: 0 }], elapsedDays: 1 }),
    ).toThrow(ExperimentStatsError);
    expect(() => evaluateExperiment(plan, { arms: [{ key: "a", units: 1, conversions: 0 }], elapsedDays: 1 })).toThrow(ExperimentStatsError);
  });

  it("three-arm horizon applies Holm over two comparisons", () => {
    const plan3: ExperimentPlan = { nPerArm: 1000, weights: [34, 33, 33], armKeys: ["a", "b", "c"] };
    const v = evaluateExperiment(plan3, {
      arms: [
        { key: "a", units: 1000, conversions: 50 },
        { key: "b", units: 1000, conversions: 80 },
        { key: "c", units: 1000, conversions: 52 },
      ],
      elapsedDays: 20,
    });
    if (v.phase !== "horizon") throw new Error("expected horizon");
    const [b, c] = v.analysis.comparisons;
    expect(b!.pAdjusted).toBeCloseTo(Math.min(1, 2 * b!.pRaw), 12);
    expect(c!.pAdjusted).toBeGreaterThanOrEqual(b!.pAdjusted - 1e-15);
  });
});

describe("limits and helpers", () => {
  it("exposes the design's constants", () => {
    expect(EXPERIMENT_STATS_LIMITS).toMatchObject({ minDays: 14, maxDays: 56, alpha: 0.05, power: 0.8, srmPThreshold: 0.001, fisherMinExpectedCell: 5 });
  });

  it("wholeDaysBetween floors and never goes negative", () => {
    expect(wholeDaysBetween(0, 14 * 86_400_000 - 1)).toBe(13);
    expect(wholeDaysBetween(0, 14 * 86_400_000)).toBe(14);
    expect(wholeDaysBetween(10, 5)).toBe(0);
  });
});
