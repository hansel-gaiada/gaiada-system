// SCP-Se — THE SIMULATED BOOST'S RESULTS: a pure, deterministic generator (plan §5 "Simulated boosts": "A started boost completes after
// a short, configurable time, with spend at or below budget, paid reach and clicks"; §8 row Se). No I/O, no clock, no `Math.random`:
// the same facts give the same numbers on every machine, forever. The job (../simulated-boost-job.ts) reads the facts from the boost's
// own row and hands what this returns to `completeBoost` (pipeline/boosts.ts), which is the route's own transition.
//
// ── DETERMINISM ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The same device as simulated-metrics.ts: every draw is `unit(boostId, label)`, a uniform [0, 1) from the SHA-256 of `boostId|label`
// (that file's own `unit`, imported rather than copied so there is ONE hash recipe and its golden pins cover it). A label per
// quantity makes the draws independent of one another and of the order they are asked in. Change a constant below and
// simulated-boost.test.ts's golden values fail on purpose: every result the owner has already seen would move.
//
// ── THE RULES ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
//   spend   85% to under 100% of the boost's TOTAL budget (daily x days), rounded down: a boost never overspends, so the
//           `spend_above_budget` warning (boosts.ts) never fires for a simulated boost, and the cycle's committed figure (a completed
//           boost commits its actual spend) comes out at or below what was agreed.
//   reach   inside the boost's own reach estimate (`reach_estimate_low`..`reach_estimate_high`, both ends included) when it has one:
//           a made-up result that fell outside the made-up promise would read as a bug in the demo. With no estimate (the column is
//           nullable, and a boost can predate the estimate) it is the spend's own yield: 0.02 to 0.06 people per MAJOR unit spent,
//           the very band `boosts-data.ts#SIMULATED_REACH_PER_MAJOR` uses for the estimate, so the two agree.
//   clicks  a share of the paid reach, by GOAL: `website` 2.0% to 4.5% (the goal is the click), `profile_visits` 1.0% to 2.5%,
//           `messages` 0.2% to 0.8% (a conversation is the rarest outcome). The three bands are drawn from the SAME uniform, so for
//           one boost the order website >= profile_visits >= messages holds by construction, not by luck. The audience nudges the
//           rate: `local` x1.15 (a narrower, closer crowd), `custom` x1.05, `automatic` x1. Clicks never exceed the reach.
// Everything is a non-negative integer, and reach and clicks are capped at the column's int4 ceiling (`paid_reach`, `clicks` are
// `integer`), spend at the table's own 10^12 CHECK.
import { unit } from "./simulated-metrics";

export const SIMULATED_BOOST_GOALS = ["profile_visits", "website", "messages"] as const;
export type SimulatedBoostGoal = (typeof SIMULATED_BOOST_GOALS)[number];

/** The boost's own facts, as `social_boosts` holds them. The estimate pair is null when the boost has none. */
export interface SimulatedBoostFacts {
  boostId: string;
  dailyBudgetMinor: number;
  days: number;
  goal: string;
  audience: string;
  reachEstimateLow: number | null;
  reachEstimateHigh: number | null;
  /** The currency's minor digits (0 for IDR, 2 for most): only used to turn the spend into major units when there is no estimate. */
  minorUnit: number;
}

export interface SimulatedBoostResult {
  spendMinor: number;
  paidReach: number;
  clicks: number;
}

/** A Postgres `integer`'s ceiling, the cap of reach and clicks. */
const MAX_INT = 2_147_483_647;
/** The table's `spend_minor` CHECK (0..10^12). */
const MAX_SPEND = 1_000_000_000_000;

/** The spend as a share of the total: 85% (included) to 100% (excluded). */
export const SIMULATED_SPEND_SHARE = { low: 0.85, high: 1.0 } as const;
/** People reached per MAJOR currency unit spent when the boost has no estimate: the same band the estimate itself uses. */
export const SIMULATED_REACH_PER_MAJOR_SPENT = { low: 0.02, high: 0.06 } as const;
/** The click share of paid reach by goal, [low, high): one uniform walks all three, so website >= profile_visits >= messages. */
export const SIMULATED_CLICK_RATE: Record<SimulatedBoostGoal, { low: number; high: number }> = {
  website: { low: 0.020, high: 0.045 },
  profile_visits: { low: 0.010, high: 0.025 },
  messages: { low: 0.002, high: 0.008 },
};
/** The audience's nudge on the click rate. An unknown audience is x1 (the column's CHECK admits only these three). */
export const SIMULATED_AUDIENCE_LIFT: Record<string, number> = { automatic: 1, local: 1.15, custom: 1.05 };

const between = (seed: string, label: string, lo: number, hi: number): number => lo + (hi - lo) * unit(seed, label);
const clampInt = (n: number, hi: number): number => Math.max(0, Math.min(hi, Math.floor(n)));

/** The boost's total budget in minor units (the table's generated column, recomputed so the generator needs no second read). */
export function simulatedBoostTotal(f: Pick<SimulatedBoostFacts, "dailyBudgetMinor" | "days">): number {
  return f.dailyBudgetMinor * f.days;
}

/** The results a simulated boost finishes with. Pure and total: any facts give non-negative integers, spend at or below the total. */
export function simulatedBoostResult(f: SimulatedBoostFacts): SimulatedBoostResult {
  const total = Math.max(0, simulatedBoostTotal(f));
  // Floor of a share below 1 is at most total - 0 for a total of 1 (floor(0.9) = 0), so spend <= total always; the min is the proof's belt.
  const spendMinor = Math.min(total, clampInt(total * between(f.boostId, "spend", SIMULATED_SPEND_SHARE.low, SIMULATED_SPEND_SHARE.high), MAX_SPEND));

  let paidReach: number;
  const { reachEstimateLow: low, reachEstimateHigh: high } = f;
  if (low !== null && high !== null && high >= low) {
    // Inside the promise, end to end: 10% to 95% of the way up the band keeps the draw away from the edges (a boost that lands exactly on
    // the floor of its estimate looks broken), and the clamp keeps it inside even for a one-number band.
    paidReach = Math.min(high, Math.max(low, low + Math.round((high - low) * between(f.boostId, "reach", 0.10, 0.95))));
    paidReach = clampInt(paidReach, MAX_INT);
  } else {
    const major = spendMinor / 10 ** Math.max(0, f.minorUnit);
    paidReach = clampInt(major * between(f.boostId, "reach", SIMULATED_REACH_PER_MAJOR_SPENT.low, SIMULATED_REACH_PER_MAJOR_SPENT.high), MAX_INT);
  }

  const band = SIMULATED_CLICK_RATE[f.goal as SimulatedBoostGoal] ?? SIMULATED_CLICK_RATE.profile_visits;
  const rate = between(f.boostId, "clicks", band.low, band.high) * (SIMULATED_AUDIENCE_LIFT[f.audience] ?? 1);
  const clicks = Math.min(paidReach, clampInt(paidReach * rate, MAX_INT));

  return { spendMinor, paidReach, clicks };
}
