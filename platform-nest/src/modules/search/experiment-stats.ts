// M5-V5-b — the A/B-test statistics engine. PURE: no I/O, no DB, no clock, no randomness.
// Design: docs/plans/2026-10-12-m5-phase5-design.md §5.4 (the stopping rule), §5.5, §10 O9.
//
// WHAT THIS IS: a fixed-horizon, frequentist engine. The sample size is fixed before the test starts,
// each non-control arm is tested once against control at the horizon, and Holm's step-down procedure
// corrects across those k - 1 comparisons. Nothing in here lets a caller read an outcome early.
//
// THE LOAD-BEARING PROPERTY (§5.4 "Why not Bayesian", reason 1): `evaluateExperiment` returns an
// object WITHOUT any rate, difference, interval or p-value until the pre-registered horizon is
// reached. The pre-horizon branch is built from exposure counts only (`progressView`), so "peek and
// stop" is impossible through this API by construction, not by habit. The sample-ratio-mismatch (SRM)
// check is the only data look allowed before the horizon (a data-quality alarm that uses exposures,
// never conversions).
//
// FORMULAS (all two-sided; z_q = the standard normal quantile at q):
//   * Sample size per arm (the design's formula, uncorrected for continuity):
//       n = ceil( ( z_{1-a/2} * sqrt(2 * pbar * qbar) + z_{power} * sqrt(p0*q0 + p1*q1) )^2 / (p1 - p0)^2 )
//       with pbar = (p0 + p1) / 2, qbar = 1 - pbar, p1 = p0 * (1 + relativeMde).
//     This is also the formula behind R's `power.prop.test` (its statistic uses (p1+p2)(1-(p1+p2)/2)
//     = 2*pbar*qbar and p1q1+p2q2), so the two agree before rounding. 3.0 % -> 4.5 %, a = 0.05,
//     power = 0.8 gives 2517.003 -> 2,518 per arm.
//   * Duration: days = ceil( n / (dailyUnits * weight_i / 100) ) for the slowest arm, floored at the
//     14-day minimum; a projection above 56 days is a typed refusal ("underpowered").
//   * Test: pooled two-proportion z-test; Fisher's exact test (two-sided, the R convention: sum the
//     probabilities of every table no more likely than the observed one, relative tolerance 1e-7)
//     when ANY expected cell of the 2x2 table is < 5.
//   * Interval: Newcombe's hybrid-score interval (method 10) for p_arm - p_control, from Wilson
//     score intervals of the two proportions; 95 % by default (1 - alpha).
//   * Multiplicity: Holm-Bonferroni step-down over the k - 1 raw p-values, monotone, capped at 1.
//   * SRM: chi-square goodness of fit of the observed exposures against the planned weights,
//     df = k - 1; flagged when p < 0.001.
//
// NUMERICAL PRECISION (checked against published values in the tests):
//   * Normal CDF/SF via erfc (Maclaurin series below x = 2, Lentz continued fraction above), about
//     1e-15 absolute, tails keep ~12 significant digits. Quantile by Halley iteration on that CDF
//     (agrees with the 1.959963984540054 reference to better than 1e-12).
//   * Chi-square survival via the regularised upper incomplete gamma (series / continued fraction,
//     Lanczos log-gamma), about 1e-13 relative in the ranges that matter.
//   * Fisher: the hypergeometric pmf in log space (exact log-factorial table up to 255, Stirling
//     series beyond), so a 100k-unit arm does not overflow; p-values are good to ~1e-9 relative.
// Not a substitute for a sequential design: peeking invalidates alpha, which is why there is no
// peeking API. The named upgrade if traffic grows is group-sequential with O'Brien-Fleming spending.

// ---------------------------------------------------------------------------------------------
// Limits and defaults (design §10 O9: 14-56 days, alpha 0.05, power 0.8; §5.4: SRM p < 0.001)
// ---------------------------------------------------------------------------------------------

export const EXPERIMENT_STATS_LIMITS = {
  minDays: 14,
  maxDays: 56,
  alpha: 0.05,
  power: 0.8,
  /** SRM alarm threshold: flag when the chi-square p-value is below this. */
  srmPThreshold: 0.001,
  /** Fisher's exact test replaces the z-test when any expected cell of the 2x2 table is below this. */
  fisherMinExpectedCell: 5,
  minArms: 2,
  maxArms: 4,
} as const;

/** Thrown for malformed input (a programming or validation error), never for a statistical outcome. */
export class ExperimentStatsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperimentStatsError";
  }
}

function assertFinite(name: string, v: number): void {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ExperimentStatsError(`${name} must be a finite number`);
  }
}

function assertOpenUnit(name: string, v: number): void {
  assertFinite(name, v);
  if (!(v > 0 && v < 1)) throw new ExperimentStatsError(`${name} must be strictly between 0 and 1`);
}

function assertCount(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 0) throw new ExperimentStatsError(`${name} must be a non-negative integer`);
}

// ---------------------------------------------------------------------------------------------
// Special functions
// ---------------------------------------------------------------------------------------------

const SQRT_PI = Math.sqrt(Math.PI);
const SQRT_2 = Math.SQRT2;
const SQRT_2PI = Math.sqrt(2 * Math.PI);

/** erf(x) for 0 <= x < 2 by the all-positive-terms Maclaurin form: 2/sqrt(pi) * e^{-x^2} * sum 2^n x^{2n+1}/(2n+1)!! */
function erfSmall(x: number): number {
  const x2 = x * x;
  let term = x;
  let sum = x;
  for (let n = 1; n < 200; n++) {
    term *= (2 * x2) / (2 * n + 1);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return ((2 / SQRT_PI) * Math.exp(-x2)) * sum;
}

/** erfc(x) for x >= 2 by the Lentz-evaluated continued fraction erfc = e^{-x^2}/sqrt(pi) / (x + (1/2)/(x + 1/(x + (3/2)/(x + ...)))). */
function erfcLarge(x: number): number {
  const tiny = 1e-300;
  let f = x;
  let c = x;
  let d = 0;
  for (let n = 1; n < 500; n++) {
    const a = n / 2;
    d = x + a * d;
    if (d === 0) d = tiny;
    c = x + a / c;
    if (c === 0) c = tiny;
    d = 1 / d;
    const delta = c * d;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return Math.exp(-x * x) / (SQRT_PI * f);
}

/** Complementary error function, accurate across the whole real line. */
export function erfc(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x < 0) return 2 - erfc(-x);
  if (x < 2) return 1 - erfSmall(x);
  if (x > 27) return 0;
  return erfcLarge(x);
}

/** Standard normal CDF, Phi(x). */
export function normalCdf(x: number): number {
  return 0.5 * erfc(-x / SQRT_2);
}

/** Standard normal survival function, 1 - Phi(x), without cancellation in the upper tail. */
export function normalSf(x: number): number {
  return 0.5 * erfc(x / SQRT_2);
}

/** Standard normal quantile (inverse CDF), 0 < p < 1. Halley iteration on `normalCdf` from the A&S 26.2.23 start. */
export function normalQuantile(p: number): number {
  assertOpenUnit("p", p);
  if (p === 0.5) return 0;
  const lower = p < 0.5;
  const q = lower ? p : 1 - p;
  const t = Math.sqrt(-2 * Math.log(q));
  let x =
    -(t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t));
  // x is now the lower-tail quantile of q (negative). Refine on the lower tail where erfc keeps relative accuracy.
  for (let i = 0; i < 60; i++) {
    const e = normalCdf(x) - q;
    const u = (e * SQRT_2PI) * Math.exp((x * x) / 2);
    const dx = u / (1 + (x * u) / 2);
    x -= dx;
    if (Math.abs(dx) < 1e-15 * Math.max(1, Math.abs(x))) break;
  }
  return lower ? x : -x;
}

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Gamma(z) for z > 0 (Lanczos, g = 7, n = 9; ~1e-15). */
export function logGamma(z: number): number {
  if (!(z > 0)) throw new ExperimentStatsError("logGamma needs z > 0");
  if (z < 0.5) {
    // reflection: Gamma(z) Gamma(1-z) = pi / sin(pi z)
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const x = z - 1;
  let a = LANCZOS[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

const LOG_FACT_TABLE_SIZE = 256;
const LOG_FACT_TABLE: number[] = (() => {
  const t = new Array<number>(LOG_FACT_TABLE_SIZE).fill(0);
  for (let i = 2; i < LOG_FACT_TABLE_SIZE; i++) t[i] = t[i - 1]! + Math.log(i);
  return t;
})();

/** ln(n!) for integer n >= 0: exact accumulation below 256, Stirling series (error < 1e-18) above. */
export function logFactorial(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new ExperimentStatsError("logFactorial needs an integer >= 0");
  if (n < LOG_FACT_TABLE_SIZE) return LOG_FACT_TABLE[n]!;
  const x = n;
  return (
    x * Math.log(x) - x + 0.5 * Math.log(2 * Math.PI * x) + 1 / (12 * x) - 1 / (360 * x ** 3) + 1 / (1260 * x ** 5)
  );
}

function logChoose(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

/** Regularised upper incomplete gamma Q(a, x) = Gamma(a, x) / Gamma(a). */
export function gammaQ(a: number, x: number): number {
  if (!(a > 0) || x < 0) throw new ExperimentStatsError("gammaQ needs a > 0 and x >= 0");
  if (x === 0) return 1;
  const gln = logGamma(a);
  if (x < a + 1) {
    // series for P(a, x), return 1 - P
    let ap = a;
    let del = 1 / a;
    let sum = del;
    for (let n = 0; n < 1000; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-16) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  // continued fraction for Q(a, x) (modified Lentz)
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

/** Chi-square survival function P(X >= x), X ~ chi-square with `df` degrees of freedom. */
export function chiSquareSf(x: number, df: number): number {
  if (!Number.isInteger(df) || df < 1) throw new ExperimentStatsError("df must be an integer >= 1");
  assertFinite("x", x);
  if (x <= 0) return 1;
  return Math.min(1, Math.max(0, gammaQ(df / 2, x / 2)));
}

// ---------------------------------------------------------------------------------------------
// (1) Sample size per arm
// ---------------------------------------------------------------------------------------------

export interface SampleSizeInput {
  /** Baseline conversion rate p0 of the control, in (0, 1). */
  baselineRate: number;
  /** Relative minimum detectable effect, > 0 (0.5 means 3.0 % -> 4.5 %). p0 * (1 + mde) must stay below 1. */
  relativeMde: number;
  /** Two-sided significance level, default 0.05. */
  alpha?: number;
  /** Power, default 0.8. */
  power?: number;
  /**
   * Number of comparisons to size for, default 1 (the design's formula at the plain alpha). Setting it to
   * k - 1 sizes each comparison at alpha / (k - 1) (Bonferroni, which bounds Holm's first step); it is
   * OFF by default because §5.4 pre-registers n at alpha 0.05.
   */
  comparisons?: number;
}

export interface SampleSize {
  /** Units (exposures) needed in EACH arm, rounded up. */
  nPerArm: number;
  /** The same figure before rounding (R's `power.prop.test` reports this). */
  nExact: number;
  baselineRate: number;
  /** p1 = p0 * (1 + relativeMde). */
  targetRate: number;
  alpha: number;
  power: number;
}

/** n per arm for a two-sided two-proportion test with the design's formula (module header). */
export function sampleSizePerArm(input: SampleSizeInput): SampleSize {
  const alpha = input.alpha ?? EXPERIMENT_STATS_LIMITS.alpha;
  const power = input.power ?? EXPERIMENT_STATS_LIMITS.power;
  const comparisons = input.comparisons ?? 1;
  assertOpenUnit("baselineRate", input.baselineRate);
  assertFinite("relativeMde", input.relativeMde);
  if (!(input.relativeMde > 0)) throw new ExperimentStatsError("relativeMde must be > 0");
  assertOpenUnit("alpha", alpha);
  assertOpenUnit("power", power);
  if (!Number.isInteger(comparisons) || comparisons < 1) {
    throw new ExperimentStatsError("comparisons must be an integer >= 1");
  }
  const p0 = input.baselineRate;
  const p1 = p0 * (1 + input.relativeMde);
  if (!(p1 < 1)) throw new ExperimentStatsError("baselineRate * (1 + relativeMde) must be below 1");
  const nExact = sampleSizeForRates(p0, p1, alpha / comparisons, power);
  return {
    nPerArm: Math.max(1, Math.ceil(nExact - 1e-9)),
    nExact,
    baselineRate: p0,
    targetRate: p1,
    alpha,
    power,
  };
}

/** Un-rounded n per arm for two given rates (either order), two-sided alpha. */
export function sampleSizeForRates(p0: number, p1: number, alpha: number, power: number): number {
  assertOpenUnit("p0", p0);
  assertOpenUnit("p1", p1);
  assertOpenUnit("alpha", alpha);
  assertOpenUnit("power", power);
  if (p0 === p1) throw new ExperimentStatsError("the two rates must differ");
  const pbar = (p0 + p1) / 2;
  const za = normalQuantile(1 - alpha / 2);
  const zb = normalQuantile(power);
  const num = za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p0 * (1 - p0) + p1 * (1 - p1));
  return (num * num) / ((p1 - p0) * (p1 - p0));
}

/** Power of the two-sided two-proportion test at n per arm (R's `power.prop.test` formula). */
export function powerTwoProportions(nPerArm: number, p0: number, p1: number, alpha = 0.05): number {
  assertOpenUnit("p0", p0);
  assertOpenUnit("p1", p1);
  assertOpenUnit("alpha", alpha);
  if (!(nPerArm > 0)) throw new ExperimentStatsError("nPerArm must be > 0");
  const za = normalQuantile(1 - alpha / 2);
  const s = (p0 + p1) * (1 - (p0 + p1) / 2);
  const num = Math.sqrt(nPerArm) * Math.abs(p1 - p0) - za * Math.sqrt(s);
  return normalCdf(num / Math.sqrt(p0 * (1 - p0) + p1 * (1 - p1)));
}

// ---------------------------------------------------------------------------------------------
// (2) Duration projection
// ---------------------------------------------------------------------------------------------

export interface DurationInput {
  nPerArm: number;
  /** Planned arm weights in percent (integers summing to 100), arm "a" first. 2 to 4 arms. */
  weights: readonly number[];
  /** Eligible exposures per day across ALL arms (the observed rate of the last 28 days). */
  dailyUnits: number;
}

export type DurationProjection =
  | {
      ok: true;
      /** Whole days until every arm has n exposures, floored at the minimum (14). */
      days: number;
      /** The unrounded days before the 14-day floor was applied. */
      rawDays: number;
      /** True when the 14-day minimum, not traffic, sets the horizon. */
      limitedByMinimum: boolean;
    }
  | {
      ok: false;
      /** The service answers `422 underpowered`. */
      reason: "underpowered";
      projectedDays: number;
      maxDays: number;
    };

function assertWeights(weights: readonly number[]): void {
  const { minArms, maxArms } = EXPERIMENT_STATS_LIMITS;
  if (weights.length < minArms || weights.length > maxArms) {
    throw new ExperimentStatsError(`an experiment has ${minArms} to ${maxArms} arms`);
  }
  let sum = 0;
  for (const w of weights) {
    if (!Number.isInteger(w) || w <= 0) throw new ExperimentStatsError("weights must be positive integers");
    sum += w;
  }
  if (sum !== 100) throw new ExperimentStatsError("weights must sum to 100");
}

/** How long until the slowest arm reaches n, or a typed refusal when that is beyond 56 days. */
export function projectDuration(input: DurationInput): DurationProjection {
  assertWeights(input.weights);
  if (!Number.isInteger(input.nPerArm) || input.nPerArm < 1) {
    throw new ExperimentStatsError("nPerArm must be an integer >= 1");
  }
  assertFinite("dailyUnits", input.dailyUnits);
  const { minDays, maxDays } = EXPERIMENT_STATS_LIMITS;
  if (input.dailyUnits <= 0) {
    // no traffic: never reaches the horizon
    return { ok: false, reason: "underpowered", projectedDays: Number.POSITIVE_INFINITY, maxDays };
  }
  const smallest = Math.min(...input.weights);
  const rawDays = (input.nPerArm * 100) / (input.dailyUnits * smallest);
  // The 1e-9 keeps float noise from turning exactly 56 into 57.
  const wholeDays = Math.max(1, Math.ceil(rawDays - 1e-9));
  if (wholeDays > maxDays) {
    return { ok: false, reason: "underpowered", projectedDays: wholeDays, maxDays };
  }
  const days = Math.max(minDays, wholeDays);
  return { ok: true, days, rawDays, limitedByMinimum: wholeDays < minDays };
}

// ---------------------------------------------------------------------------------------------
// Intervals and tests
// ---------------------------------------------------------------------------------------------

/** Wilson score interval for x successes in n trials at two-sided level 1 - alpha. */
export function wilsonInterval(x: number, n: number, alpha: number = EXPERIMENT_STATS_LIMITS.alpha): { lower: number; upper: number } {
  assertCount("x", x);
  assertCount("n", n);
  if (n < 1 || x > n) throw new ExperimentStatsError("need 0 <= x <= n and n >= 1");
  const z = normalQuantile(1 - alpha / 2);
  const p = x / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

/** Newcombe's hybrid-score interval (method 10) for p1 - p0, where arm 1 is x1/n1 and the control x0/n0. */
export function newcombeInterval(
  x1: number,
  n1: number,
  x0: number,
  n0: number,
  alpha: number = EXPERIMENT_STATS_LIMITS.alpha,
): { diff: number; lower: number; upper: number } {
  const p1 = x1 / n1;
  const p0 = x0 / n0;
  const w1 = wilsonInterval(x1, n1, alpha);
  const w0 = wilsonInterval(x0, n0, alpha);
  const d = p1 - p0;
  return {
    diff: d,
    lower: d - Math.sqrt((p1 - w1.lower) ** 2 + (w0.upper - p0) ** 2),
    upper: d + Math.sqrt((w1.upper - p1) ** 2 + (p0 - w0.lower) ** 2),
  };
}

export interface TwoByTwo {
  x1: number;
  n1: number;
  x0: number;
  n0: number;
}

function assertTable(t: TwoByTwo): void {
  assertCount("x1", t.x1);
  assertCount("n1", t.n1);
  assertCount("x0", t.x0);
  assertCount("n0", t.n0);
  if (t.n1 < 1 || t.n0 < 1) throw new ExperimentStatsError("each arm needs at least one unit");
  if (t.x1 > t.n1 || t.x0 > t.n0) throw new ExperimentStatsError("conversions cannot exceed units");
}

/** The smallest expected cell of the 2x2 table (converted / not converted by arm), under independence. */
export function minExpectedCell(t: TwoByTwo): number {
  assertTable(t);
  const n = t.n1 + t.n0;
  const conv = t.x1 + t.x0;
  const rows = [t.n1, t.n0];
  const cols = [conv, n - conv];
  let m = Number.POSITIVE_INFINITY;
  for (const r of rows) for (const c of cols) m = Math.min(m, (r * c) / n);
  return m;
}

/** Pooled two-proportion z statistic and its two-sided p-value. Only meaningful when no expected cell is small. */
export function pooledZTest(t: TwoByTwo): { z: number; pValue: number } {
  assertTable(t);
  const pooled = (t.x1 + t.x0) / (t.n1 + t.n0);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / t.n1 + 1 / t.n0));
  if (se === 0) return { z: 0, pValue: 1 };
  const z = (t.x1 / t.n1 - t.x0 / t.n0) / se;
  return { z, pValue: Math.min(1, 2 * normalSf(Math.abs(z))) };
}

/**
 * Fisher's exact test, two-sided, for the 2x2 table [[x1, n1 - x1], [x0, n0 - x0]]. The p-value sums the
 * probability of every table (same margins) that is no more likely than the observed one, with R's
 * relative tolerance of 1e-7 for ties. Hypergeometric terms are computed in log space.
 */
export function fisherExact(t: TwoByTwo): { pValue: number } {
  assertTable(t);
  const N = t.n1 + t.n0;
  const K = t.x1 + t.x0; // total conversions
  const lo = Math.max(0, K - t.n0);
  const hi = Math.min(K, t.n1);
  const logDenom = logChoose(N, K);
  const logPmf = (x: number): number => logChoose(t.n1, x) + logChoose(t.n0, K - x) - logDenom;
  const observed = logPmf(t.x1);
  const cutoff = observed + 1e-7; // ln(1 + 1e-7) ~ 1e-7
  let p = 0;
  for (let x = lo; x <= hi; x++) {
    const lp = logPmf(x);
    if (lp <= cutoff) p += Math.exp(lp);
  }
  return { pValue: Math.min(1, p) };
}

/** Holm-Bonferroni adjusted p-values (step-down, monotone, capped at 1), returned in the INPUT order. */
export function holmAdjust(pValues: readonly number[]): number[] {
  const m = pValues.length;
  for (const p of pValues) {
    assertFinite("p", p);
    if (p < 0 || p > 1) throw new ExperimentStatsError("p-values must be in [0, 1]");
  }
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p || a.i - b.i);
  const adjusted = new Array<number>(m);
  let running = 0;
  order.forEach((entry, rank) => {
    const candidate = Math.min(1, (m - rank) * entry.p);
    running = Math.max(running, candidate);
    adjusted[entry.i] = running;
  });
  return adjusted;
}

// ---------------------------------------------------------------------------------------------
// (4) Sample-ratio mismatch
// ---------------------------------------------------------------------------------------------

export interface SrmResult {
  /** False when there are no exposures yet (nothing to test). */
  evaluable: boolean;
  chiSquare: number;
  df: number;
  pValue: number;
  /** p < 0.001: the assignment is not splitting as planned, a data-quality alarm, not an outcome look. */
  mismatch: boolean;
  expected: number[];
  observed: number[];
}

/** Chi-square goodness of fit of the observed exposures against the planned weights. */
export function sampleRatioMismatch(
  observedExposures: readonly number[],
  weights: readonly number[],
  threshold: number = EXPERIMENT_STATS_LIMITS.srmPThreshold,
): SrmResult {
  assertWeights(weights);
  if (observedExposures.length !== weights.length) {
    throw new ExperimentStatsError("one exposure count per planned arm is required");
  }
  observedExposures.forEach((o, i) => assertCount(`exposures[${i}]`, o));
  const total = observedExposures.reduce((a, b) => a + b, 0);
  const df = weights.length - 1;
  if (total === 0) {
    return {
      evaluable: false,
      chiSquare: 0,
      df,
      pValue: 1,
      mismatch: false,
      expected: weights.map(() => 0),
      observed: [...observedExposures],
    };
  }
  const expected = weights.map((w) => (total * w) / 100);
  let chi = 0;
  observedExposures.forEach((o, i) => {
    chi += ((o - expected[i]!) ** 2) / expected[i]!;
  });
  const pValue = chiSquareSf(chi, df);
  return { evaluable: true, chiSquare: chi, df, pValue, mismatch: pValue < threshold, expected, observed: [...observedExposures] };
}

// ---------------------------------------------------------------------------------------------
// (3) The analysis at the horizon
// ---------------------------------------------------------------------------------------------

export interface ArmCounts {
  key: string;
  /** Exposed units. */
  units: number;
  /** Units that converted after exposure (once per unit), 0 <= conversions <= units. */
  conversions: number;
}

export interface ArmComparison {
  key: string;
  units: number;
  conversions: number;
  rate: number;
  /** Rate difference against control (arm minus control) and its Newcombe interval. */
  difference: number;
  ciLower: number;
  ciUpper: number;
  ciLevel: number;
  method: "z" | "fisher";
  pRaw: number;
  /** Holm-adjusted over the k - 1 comparisons. */
  pAdjusted: number;
  /** pAdjusted < alpha AND the interval's lower bound > 0. */
  significantWinner: boolean;
}

export type Decision =
  | { action: "ship"; arm: string }
  /** Keep control: no arm cleared the bar. */
  | { action: "keep_control"; reason: "no_significant_winner" };

export interface HorizonAnalysis {
  control: { key: string; units: number; conversions: number; rate: number };
  comparisons: ArmComparison[];
  decision: Decision;
  alpha: number;
}

/**
 * Analyse the arms against control. This is the ONLY function that computes outcomes, and it is
 * meant to be reached through `evaluateExperiment` after the horizon. Calling it directly before the
 * horizon is a misuse the service must not make; the guard is where the property is enforced.
 */
export function analyseAtHorizon(
  control: ArmCounts,
  arms: readonly ArmCounts[],
  alpha: number = EXPERIMENT_STATS_LIMITS.alpha,
): HorizonAnalysis {
  assertOpenUnit("alpha", alpha);
  if (arms.length < 1) throw new ExperimentStatsError("at least one non-control arm is required");
  const keys = new Set<string>([control.key]);
  for (const a of arms) {
    if (keys.has(a.key)) throw new ExperimentStatsError(`duplicate arm key ${a.key}`);
    keys.add(a.key);
  }
  const rows = arms.map((arm) => {
    const table: TwoByTwo = { x1: arm.conversions, n1: arm.units, x0: control.conversions, n0: control.units };
    assertTable(table);
    const method: "z" | "fisher" =
      minExpectedCell(table) < EXPERIMENT_STATS_LIMITS.fisherMinExpectedCell ? "fisher" : "z";
    const pRaw = method === "fisher" ? fisherExact(table).pValue : pooledZTest(table).pValue;
    const ci = newcombeInterval(arm.conversions, arm.units, control.conversions, control.units, alpha);
    return { arm, method, pRaw, ci };
  });
  const adjusted = holmAdjust(rows.map((r) => r.pRaw));
  const comparisons: ArmComparison[] = rows.map((r, i) => ({
    key: r.arm.key,
    units: r.arm.units,
    conversions: r.arm.conversions,
    rate: r.arm.conversions / r.arm.units,
    difference: r.ci.diff,
    ciLower: r.ci.lower,
    ciUpper: r.ci.upper,
    ciLevel: 1 - alpha,
    method: r.method,
    pRaw: r.pRaw,
    pAdjusted: adjusted[i]!,
    significantWinner: adjusted[i]! < alpha && r.ci.lower > 0,
  }));
  let best: ArmComparison | null = null;
  for (const c of comparisons) {
    if (c.significantWinner && (best === null || c.difference > best.difference)) best = c;
  }
  const decision: Decision = best
    ? { action: "ship", arm: best.key }
    : { action: "keep_control", reason: "no_significant_winner" };
  return {
    control: { key: control.key, units: control.units, conversions: control.conversions, rate: control.conversions / control.units },
    comparisons,
    decision,
    alpha,
  };
}

// ---------------------------------------------------------------------------------------------
// (5) The horizon guard: no estimate before the horizon, by construction
// ---------------------------------------------------------------------------------------------

export interface ExperimentPlan {
  /** The pre-registered n per arm. */
  nPerArm: number;
  /** Planned weights in percent, arm "a" (control) first, one per arm. */
  weights: readonly number[];
  /** Arm keys in the same order as `weights` ("a", "b", ...). */
  armKeys: readonly string[];
  alpha?: number;
  minDays?: number;
  maxDays?: number;
}

export interface ExperimentObservation {
  /** One entry per arm, in plan order. */
  arms: readonly ArmCounts[];
  /** Days since `started_at` (fractions are floored to whole days). */
  elapsedDays: number;
}

export interface ProgressView {
  perArm: Array<{ key: string; exposures: number; target: number; fraction: number }>;
  elapsedDays: number;
  minDays: number;
  maxDays: number;
  /** Every arm has reached n exposures. */
  exposuresReached: boolean;
  /** At least `minDays` whole days have passed. */
  minDaysReached: boolean;
}

/** What `evaluateExperiment` returns BEFORE the horizon: progress and the SRM check, nothing about outcomes. */
export interface PreHorizonView {
  phase: "collecting" | "inconclusive";
  horizonReached: false;
  progress: ProgressView;
  srm: SrmResult;
  /** Set when the 56-day cap passed without reaching the horizon: keep control; no outcome is computed. */
  decision?: { action: "keep_control"; reason: "inconclusive_at_max_duration" };
}

export interface HorizonView {
  phase: "horizon";
  horizonReached: true;
  progress: ProgressView;
  srm: SrmResult;
  analysis: HorizonAnalysis;
}

export type ExperimentView = PreHorizonView | HorizonView;

function validatePlan(plan: ExperimentPlan): { alpha: number; minDays: number; maxDays: number } {
  assertWeights(plan.weights);
  if (plan.armKeys.length !== plan.weights.length) throw new ExperimentStatsError("one arm key per weight");
  if (!Number.isInteger(plan.nPerArm) || plan.nPerArm < 1) throw new ExperimentStatsError("nPerArm must be an integer >= 1");
  return {
    alpha: plan.alpha ?? EXPERIMENT_STATS_LIMITS.alpha,
    minDays: plan.minDays ?? EXPERIMENT_STATS_LIMITS.minDays,
    maxDays: plan.maxDays ?? EXPERIMENT_STATS_LIMITS.maxDays,
  };
}

/**
 * Progress from EXPOSURE COUNTS ONLY. The signature takes no conversions, so nothing here can leak an outcome.
 */
export function progressView(plan: ExperimentPlan, exposures: readonly number[], elapsedDays: number): ProgressView {
  const { minDays, maxDays } = validatePlan(plan);
  if (exposures.length !== plan.armKeys.length) throw new ExperimentStatsError("one exposure count per arm");
  exposures.forEach((e, i) => assertCount(`exposures[${i}]`, e));
  assertFinite("elapsedDays", elapsedDays);
  if (elapsedDays < 0) throw new ExperimentStatsError("elapsedDays must be >= 0");
  const whole = Math.floor(elapsedDays);
  return {
    perArm: plan.armKeys.map((key, i) => ({
      key,
      exposures: exposures[i]!,
      target: plan.nPerArm,
      fraction: Math.min(1, exposures[i]! / plan.nPerArm),
    })),
    elapsedDays: whole,
    minDays,
    maxDays,
    exposuresReached: exposures.every((e) => e >= plan.nPerArm),
    minDaysReached: whole >= minDays,
  };
}

/**
 * The one entry point the service uses to show results. The horizon is reached only when EVERY arm has
 * at least n exposures AND at least `minDays` whole days have passed. Until then the returned object has
 * no rate, difference, interval, p-value or conversion count: the pre-horizon branch never reads
 * `conversions`. Past `maxDays` without the horizon the answer is "inconclusive, keep control", still
 * with no outcome (the pre-registration was never fulfilled).
 */
export function evaluateExperiment(plan: ExperimentPlan, obs: ExperimentObservation): ExperimentView {
  const { alpha, maxDays } = validatePlan(plan);
  if (obs.arms.length !== plan.armKeys.length) throw new ExperimentStatsError("one count entry per arm");
  obs.arms.forEach((a, i) => {
    if (a.key !== plan.armKeys[i]) throw new ExperimentStatsError("arm order must match the plan");
  });
  const exposures = obs.arms.map((a) => a.units);
  const progress = progressView(plan, exposures, obs.elapsedDays);
  const srm = sampleRatioMismatch(exposures, plan.weights);
  if (progress.exposuresReached && progress.minDaysReached) {
    const [control, ...rest] = obs.arms;
    return {
      phase: "horizon",
      horizonReached: true,
      progress,
      srm,
      analysis: analyseAtHorizon(control!, rest, alpha),
    };
  }
  if (progress.elapsedDays >= maxDays) {
    return {
      phase: "inconclusive",
      horizonReached: false,
      progress,
      srm,
      decision: { action: "keep_control", reason: "inconclusive_at_max_duration" },
    };
  }
  return { phase: "collecting", horizonReached: false, progress, srm };
}

/** Whole days between two instants in milliseconds (floors; never negative). */
export function wholeDaysBetween(startMs: number, nowMs: number): number {
  assertFinite("startMs", startMs);
  assertFinite("nowMs", nowMs);
  return Math.max(0, Math.floor((nowMs - startMs) / 86_400_000));
}
