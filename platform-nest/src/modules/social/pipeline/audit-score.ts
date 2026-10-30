// SCP-5g (W5-B4) — the social audit's PURE scoring (FRONTEND-BFF-CONTRACT §63.28.1, §63.30). No I/O: the six automatic rules over what the pipeline
// holds, the typed scores, the overall, the band and the three fixes. The company's scorecard (`AuditRules`, from `rules.ts`) says which dimensions
// exist, their weights, which automatic rule feeds each, the bands and the benchmark; nothing here names "the twelve".
//
// THE SCORES
//   A dimension scores 0 to 5 by halves. An automatic one is `5 × min(1, actual ÷ expected)` rounded to the nearest half (a quarter rounds up),
//   or NONE with its reason when either side is unknown (never 0: a score of 0 is a real zero). A typed score (a number by halves) may stand in
//   for an automatic one and then wins (`used`).
//   `used` = the typed score when there is one, else the automatic score, else none.
//
// THE OVERALL (63.28.1)  round(100 × Σ(weight × used ÷ 5) ÷ Σ weight) over the dimensions that have a `used` score; none when nothing is scored (or
//   every scored dimension weighs 0). It is computed in integers (scores in halves, weights in hundredths) so a .5 never drifts: half rounds up.
// THE BAND  `auditBandFor(scorecard, overall)` (rules.ts): the first band, highest first, whose `from` the overall reaches; none without an overall.
// THE FIXES  the three lowest `used` scores, each with the dimension's advice line: ascending by score, a tie in the scorecard's own order. (A
//   dimension that scored 5 is a fix too when fewer than three are lower; the contract says "the three lowest-scored dimensions".)
//
// THE SIX AUTOMATIC RULES (over the audit's month M; "live" is a pipeline post that went live in M, not archived or deleted; the SQL is audit-data.ts's)
//   consistency      actual  the COUNTED live posts (not a story, not an extra post: `tallyCounts`' rule)   expected  the client's `posts_per_cycle`
//                    none: `no_target` (no target, or 0)
//   format_mix       actual  the allocated formats that M's live posts used (distinct)                      expected  the number of allocated formats
//                    none: `no_allocated_formats`
//   engagement_rate  actual  the mean rate of M's live posts that have one (63.10's `postRate`/`meanRate`)  expected  the benchmark (below)
//                    none: `no_rate` (no live post with a rate), `no_benchmark` (no typed rate for the business type, no peer with a rate, or a 0)
//   reels            actual  the mean rate of M's live reels                                                expected  the mean rate of M's OTHER live feed posts
//                    (a feed post here is a `feed` or `carousel`: the posts of the grid, never a reel or a story)
//                    none: `no_reels`, `no_reel_rate`, `no_feed_baseline` (no other live feed post with a rate, or a 0)
//   stories          actual  the ISO weeks that hold a live story of M                                      expected  the ISO weeks touching M (Monday-first)
//   boosting         actual  the cycles of the three months to M that have a boost that ran (`stopped` or `completed`)
//                    expected the cycles among those three months with an agreed boost budget above 0      none: `no_agreed_budget`
// THE BENCHMARK  typed by business type (`benchmark.rates`), else the median rate of the company's other clients of the same business type over the 90
//   days to M's end; the median of ALL the other clients with a rate when fewer than three of that type have one.
import { auditBandFor, type AuditBand, type AuditDimension, type AuditRules, type AuditSource } from "./rules";

// ── Vocabulary ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const AUDIT_MAX_SCORE = 5;
export const BENCHMARK_WINDOW_DAYS = 90;
/** Months a boost's cycle may lie in, counting M: the three months to M. */
export const BOOST_MONTHS = 3;
export const FIX_COUNT = 3;

/** Why an automatic score is none. */
export type NoneReason =
  | "no_target" | "no_allocated_formats" | "no_rate" | "no_benchmark" | "no_reels" | "no_reel_rate" | "no_feed_baseline" | "no_agreed_budget";

/** One automatic dimension's result: a score (0 to 5 by halves) or none with its reason, and the numbers it was read from. */
export interface AutoResult {
  score: number | null;
  reason: NoneReason | null;
  /** `{actual, expected, unit, ...}`: the numbers behind the score, for the page's "evidence" line. A side that is unknown is null. */
  evidence: AutoEvidence;
}
export interface AutoEvidence {
  actual: number | null;
  expected: number | null;
  unit: "posts" | "formats" | "rate" | "weeks" | "cycles";
  [detail: string]: unknown;
}

/** A pipeline post that went live in M, with what the rules need. */
export interface LivePost {
  format: string | null;
  isExtra: boolean;
  /** The Monday (YYYY-MM-DD) of the ISO week it went live in, in the company's zone. */
  weekStart: string;
  /** 63.10's post rate (a ratio), null without a reach. */
  rate: number | null;
  simulated: boolean;
}

export interface BoostFacts {
  /** Live cycles of the three months to M. */
  cycles: number;
  /** Of them, those with a boost that ran (`stopped` or `completed`). */
  ran: number;
  /** Of them, those with an agreed boost budget above 0. */
  agreed: number;
  simulated: boolean;
}

export interface BenchmarkFacts {
  /** The rate to measure against, or null when there is none. */
  rate: number | null;
  /** `typed` (the company's own rate), `own_clients_median` (same business type), `own_clients_median_all` (fewer than three of the type), or null. */
  basis: "typed" | "own_clients_median" | "own_clients_median_all" | null;
  /** How many peers the median is over (0 for a typed rate). */
  peers: number;
}

export interface AutoInputs {
  /** The client's `posts_per_cycle`. */
  target: number | null;
  /** The client's allocated formats (`social_engagements.formats`). */
  allocatedFormats: readonly string[];
  posts: readonly LivePost[];
  /** The ISO weeks (Mondays) touching M. */
  weeks: readonly string[];
  benchmark: BenchmarkFacts;
  boosts: BoostFacts;
}

// ── Numbers ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether `n` is a score: 0 to 5 by halves. */
export const isHalfScore = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= AUDIT_MAX_SCORE && Number.isInteger(n * 2);

/** PURE. `5 × min(1, actual ÷ expected)` to the nearest half; a quarter rounds UP. The epsilon keeps 5 × 0.45 = 2.25 (a float 2.2500000000000004 or 2.2499999) a quarter. */
export function ratioScore(actual: number, expected: number): number {
  const r = Math.min(1, Math.max(0, actual / expected));
  return Math.min(AUDIT_MAX_SCORE, Math.round(2 * AUDIT_MAX_SCORE * r + 1e-9) / 2);
}

/** PURE. The median of a list (the mean of the two middle values when even); null for an empty list. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** PURE. The mean of the rates that exist; null when none does. */
export function meanOf(values: ReadonlyArray<number | null>): number | null {
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0) / known.length;
}

/** The rate (a ratio) to six decimals, as the metrics routes answer it. */
export const round6 = (n: number | null): number | null => (n === null ? null : Math.round(n * 1e6) / 1e6);

// ── Dates ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const dayNumber = (iso: string): number => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY_MS;
const isoOfDayNumber = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** PURE. A real `YYYY-MM-DD`. */
export function isRealDay(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  return isoOfDayNumber(dayNumber(v)) === v;
}

export const addDaysIso = (iso: string, n: number): string => isoOfDayNumber(dayNumber(iso) + n);

/** PURE. The Monday of the ISO week a day falls in. */
export function weekStartOf(iso: string): string {
  const n = dayNumber(iso);
  const dow = (((n + 3) % 7) + 7) % 7; // 1970-01-01 was a Thursday: (n + 3) % 7 is 0 on a Monday
  return isoOfDayNumber(n - dow);
}

/** PURE. The first day of the month after `month` (`YYYY-MM-01`). */
export function nextMonthStart(month: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

/** PURE. The first day of the month `n` months before `month` (`YYYY-MM-01`). */
export function monthsBefore(month: string, n: number): string {
  const total = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) - n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-01`;
}

/** PURE. The Mondays of the ISO weeks that touch the month (a week touches it when any of its seven days is in it): 4 to 6 of them. */
export function isoWeeksTouching(month: string): string[] {
  const first = `${month.slice(0, 7)}-01`;
  const last = addDaysIso(nextMonthStart(first), -1);
  const out: string[] = [];
  for (let w = weekStartOf(first); w <= last; w = addDaysIso(w, 7)) out.push(w);
  return out;
}

// ── The six automatic rules ───────────────────────────────────────────────────────────────────────────────────────────

const none = (reason: NoneReason, evidence: AutoEvidence): AutoResult => ({ score: null, reason, evidence });
const scored = (actual: number, expected: number, evidence: AutoEvidence): AutoResult => ({ score: ratioScore(actual, expected), reason: null, evidence });

/** Posting consistency. */
export function scoreConsistency(i: AutoInputs): AutoResult {
  const counted = i.posts.filter((p) => !p.isExtra && p.format !== "story").length;
  const target = i.target !== null && i.target > 0 ? i.target : null;
  if (target === null) return none("no_target", { actual: counted, expected: null, unit: "posts" });
  return scored(counted, target, { actual: counted, expected: target, unit: "posts" });
}

/** Format mix. */
export function scoreFormatMix(i: AutoInputs): AutoResult {
  const allocated = [...new Set(i.allocatedFormats)];
  if (allocated.length === 0) return none("no_allocated_formats", { actual: null, expected: null, unit: "formats" });
  const used = allocated.filter((f) => i.posts.some((p) => p.format === f));
  return scored(used.length, allocated.length, { actual: used.length, expected: allocated.length, unit: "formats", used, allocated });
}

/** Engagement against the benchmark. */
export function scoreEngagementRate(i: AutoInputs): AutoResult {
  const rate = meanOf(i.posts.map((p) => p.rate));
  const expected = i.benchmark.rate;
  const detail = { benchmarkBasis: i.benchmark.basis, peers: i.benchmark.peers, posts: i.posts.filter((p) => p.rate !== null).length };
  if (rate === null) return none("no_rate", { actual: null, expected: round6(expected), unit: "rate", ...detail });
  if (expected === null || !(expected > 0)) return none("no_benchmark", { actual: round6(rate), expected: round6(expected), unit: "rate", ...detail });
  return scored(rate, expected, { actual: round6(rate), expected: round6(expected), unit: "rate", ...detail });
}

const isFeedFormat = (f: string | null): boolean => f === "feed" || f === "carousel";

/** Reels against the other feed posts. */
export function scoreReels(i: AutoInputs): AutoResult {
  const reels = i.posts.filter((p) => p.format === "reel");
  if (reels.length === 0) return none("no_reels", { actual: null, expected: null, unit: "rate", reels: 0 });
  const reelRate = meanOf(reels.map((p) => p.rate));
  const feedRate = meanOf(i.posts.filter((p) => isFeedFormat(p.format)).map((p) => p.rate));
  const detail = { reels: reels.length, feedPosts: i.posts.filter((p) => isFeedFormat(p.format) && p.rate !== null).length };
  if (reelRate === null) return none("no_reel_rate", { actual: null, expected: round6(feedRate), unit: "rate", ...detail });
  if (feedRate === null || !(feedRate > 0)) return none("no_feed_baseline", { actual: round6(reelRate), expected: round6(feedRate), unit: "rate", ...detail });
  return scored(reelRate, feedRate, { actual: round6(reelRate), expected: round6(feedRate), unit: "rate", ...detail });
}

/** Stories: the ISO weeks touching M that hold a live story. */
export function scoreStories(i: AutoInputs): AutoResult {
  const expected = i.weeks.length;
  const withStory = new Set(i.posts.filter((p) => p.format === "story").map((p) => p.weekStart));
  const actual = i.weeks.filter((w) => withStory.has(w)).length;
  return scored(actual, expected, { actual, expected, unit: "weeks" });
}

/** Paid boosting. */
export function scoreBoosting(i: AutoInputs): AutoResult {
  const { ran, agreed, cycles } = i.boosts;
  if (agreed <= 0) return none("no_agreed_budget", { actual: ran, expected: 0, unit: "cycles", cycles });
  return scored(ran, agreed, { actual: ran, expected: agreed, unit: "cycles", cycles });
}

export type AutoSource = Exclude<AuditSource, "typed">;
const AUTO_RULES: Readonly<Record<AutoSource, (i: AutoInputs) => AutoResult>> = {
  consistency: scoreConsistency, format_mix: scoreFormatMix, engagement_rate: scoreEngagementRate, reels: scoreReels, stories: scoreStories, boosting: scoreBoosting,
};

/** PURE. Every automatic rule over the same inputs, keyed by source. */
export function scoreAutomatic(i: AutoInputs): Record<AutoSource, AutoResult> {
  const out = {} as Record<AutoSource, AutoResult>;
  for (const k of Object.keys(AUTO_RULES) as AutoSource[]) out[k] = AUTO_RULES[k](i);
  return out;
}

/** PURE. Whether any automatic score read a simulated row: a live post that was simulated (its rate and counts), or a simulated boost. */
export function readSimulated(i: Pick<AutoInputs, "posts" | "boosts">): boolean {
  return i.posts.some((p) => p.simulated) || i.boosts.simulated;
}

/**
 * PURE. The benchmark of the scorecard for a client. `typed` reads the company's rate for the business type (matched ignoring case and edges);
 * `own_clients_median` reads the median of the peers of the same business type, or of every other client when fewer than three of that type have a rate.
 * `sameType` and `all` are the OTHER clients' rates (a client with no rate in the window is not in either list).
 */
export function resolveBenchmark(
  benchmark: AuditRules["benchmark"], businessType: string | null, peers: { sameType: readonly number[]; all: readonly number[] },
): BenchmarkFacts {
  if (benchmark.source === "typed") {
    const want = (businessType ?? "").trim().toLowerCase();
    const hit = want === "" ? undefined : Object.entries(benchmark.rates).find(([t]) => t.trim().toLowerCase() === want);
    return { rate: hit ? hit[1] : null, basis: hit ? "typed" : null, peers: 0 };
  }
  if (peers.sameType.length >= 3) return { rate: median(peers.sameType), basis: "own_clients_median", peers: peers.sameType.length };
  if (peers.all.length > 0) return { rate: median(peers.all), basis: "own_clients_median_all", peers: peers.all.length };
  return { rate: null, basis: null, peers: 0 };
}

// ── The scorecard ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TypedScore { score: number | null; note: string }

export interface ScoredDimension {
  key: string;
  label: string;
  /** `automatic` for a dimension fed by a rule (it is typed for a prospect), `typed` for one a person always scores. */
  kind: "automatic" | "typed";
  weight: number;
  advice: string;
  auto: { score: number | null; evidence: AutoEvidence; reason: NoneReason | null } | null;
  typed: TypedScore | null;
  used: number | null;
}

export interface Fix { key: string; label: string; score: number; advice: string }

export interface Scorecard {
  dimensions: ScoredDimension[];
  overall: number | null;
  band: { key: string; label: string } | null;
  scored: number;
  total: number;
  fixes: Fix[];
}

/** PURE. The overall over the scored dimensions, in integers: scores as halves, weights as hundredths, `Math.round`'s half up done by hand. */
export function overallOf(parts: ReadonlyArray<{ weight: number; used: number | null }>): number | null {
  let num = 0; // Σ weight100 × score2
  let den = 0; // Σ weight100
  for (const p of parts) {
    if (p.used === null) continue;
    const w = Math.round(p.weight * 100);
    num += w * Math.round(p.used * 2);
    den += w;
  }
  if (den === 0) return null;
  // overall = 100 × Σ(w × s ÷ 5) ÷ Σw = 100 × (num ÷ 2 ÷ 5) ÷ den = 10 × num ÷ den, half up.
  return Math.floor((2 * 10 * num + den) / (2 * den));
}

/** PURE. The three lowest `used` scores with their advice (ascending; a tie keeps the scorecard's order). */
export function fixesOf(dimensions: readonly ScoredDimension[]): Fix[] {
  return dimensions
    .map((d, order) => ({ d, order }))
    .filter((x): x is { d: ScoredDimension & { used: number }; order: number } => x.d.used !== null)
    .sort((a, b) => a.d.used - b.d.used || a.order - b.order)
    .slice(0, FIX_COUNT)
    .map(({ d }) => ({ key: d.key, label: d.label, score: d.used, advice: d.advice }));
}

/**
 * PURE. The scorecard of an audit under `rules`. `auto` is the automatic results keyed by source (a client's; null for a prospect, whose twelve are all
 * typed); `typed` is the audit's typed scores keyed by dimension key (a key outside the scorecard is ignored).
 */
export function composeScorecard(a: {
  rules: AuditRules; auto: Partial<Record<AutoSource, AutoResult>> | null; typed: Readonly<Record<string, TypedScore>>;
}): Scorecard {
  const dimensions = a.rules.dimensions.map((d: AuditDimension): ScoredDimension => {
    const result = d.source !== "typed" && a.auto ? a.auto[d.source] ?? null : null;
    const typedRaw = Object.prototype.hasOwnProperty.call(a.typed, d.key) ? a.typed[d.key] : null;
    const typed = typedRaw ? { score: typedRaw.score, note: typedRaw.note } : null;
    const used = typed && typed.score !== null ? typed.score : result ? result.score : null;
    return {
      key: d.key, label: d.label, kind: d.source === "typed" ? "typed" : "automatic", weight: d.weight, advice: d.advice,
      auto: result ? { score: result.score, evidence: result.evidence, reason: result.reason } : null, typed, used,
    };
  });
  const overall = overallOf(dimensions);
  const band: AuditBand | null = auditBandFor(a.rules, overall);
  return {
    dimensions, overall, band: band ? { key: band.key, label: band.label } : null,
    scored: dimensions.filter((d) => d.used !== null).length, total: dimensions.length, fixes: fixesOf(dimensions),
  };
}
