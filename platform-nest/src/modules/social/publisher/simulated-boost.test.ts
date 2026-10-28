// SCP-Se — the simulated boost's results, proved WITHOUT a database (runs anywhere): determinism with golden values (a changed
// constant fails on purpose), spend never above the total, reach inside the estimate, the goal ordering of clicks, and the config
// guard of the completion window. The DB half (the job completing a running simulated boost once, a young one waiting, a real one
// never touched, the switch off, a rerun) is ../simulated-boost-job.db.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SIMULATED_BOOST_GOALS, SIMULATED_SPEND_SHARE, simulatedBoostResult, simulatedBoostTotal, type SimulatedBoostFacts,
} from "./simulated-boost";

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const facts = (over: Partial<SimulatedBoostFacts> = {}): SimulatedBoostFacts => ({
  boostId: id(1), dailyBudgetMinor: 100_000, days: 5, goal: "website", audience: "automatic",
  reachEstimateLow: 10_000, reachEstimateHigh: 30_000, minorUnit: 0, ...over,
});
const isNonNegInt = (n: number): boolean => Number.isInteger(n) && n >= 0;

describe("SCP-Se · the generator is deterministic", () => {
  it("the same facts give the same numbers on every call, and the goldens are pinned", () => {
    expect(simulatedBoostResult(facts())).toEqual({ spendMinor: 438_890, paidReach: 13_948, clicks: 598 });
    expect(simulatedBoostResult(facts())).toEqual(simulatedBoostResult(facts()));
    expect(simulatedBoostResult(facts({ goal: "profile_visits" }))).toEqual({ spendMinor: 438_890, paidReach: 13_948, clicks: 330 });
    expect(simulatedBoostResult(facts({ goal: "messages" }))).toEqual({ spendMinor: 438_890, paidReach: 13_948, clicks: 104 });
    // No estimate: the reach is the spend's own yield (Rp 438,890 x 0.02..0.06 people per major unit).
    expect(simulatedBoostResult(facts({ reachEstimateLow: null, reachEstimateHigh: null }))).toEqual({ spendMinor: 438_890, paidReach: 10_789, clicks: 462 });
  });

  it("a different boost gets different numbers", () => {
    expect(simulatedBoostResult(facts({ boostId: id(2) }))).not.toEqual(simulatedBoostResult(facts()));
  });

  it("the total is the table's generated column", () => {
    expect(simulatedBoostTotal({ dailyBudgetMinor: 100_000, days: 5 })).toBe(500_000);
  });
});

describe("SCP-Se · spend stays at or below the total budget", () => {
  it("across many ids and budgets: 85% to under 100% of the total, whole non-negative numbers", () => {
    const shapes: Array<[number, number]> = [[100_000, 5], [50_000, 1], [1, 1], [7, 3], [250_000, 30], [1_000_000_000, 90], [999_999, 90]];
    for (let i = 0; i < 400; i++) {
      for (const [daily, days] of shapes) {
        const total = daily * days;
        const r = simulatedBoostResult(facts({ boostId: id(i), dailyBudgetMinor: daily, days }));
        expect(r.spendMinor, `${i} ${daily}x${days}`).toBeLessThanOrEqual(total);
        expect(r.spendMinor).toBeGreaterThanOrEqual(Math.floor(total * SIMULATED_SPEND_SHARE.low) - 1);
        expect(isNonNegInt(r.spendMinor) && isNonNegInt(r.paidReach) && isNonNegInt(r.clicks)).toBe(true);
        expect(r.clicks).toBeLessThanOrEqual(r.paidReach);
      }
    }
  });

  it("the biggest legal boost stays inside the table's 10^12 CHECK and the int4 columns", () => {
    const r = simulatedBoostResult(facts({ dailyBudgetMinor: 11_111_111_111, days: 90, reachEstimateLow: null, reachEstimateHigh: null, minorUnit: 0 }));
    expect(r.spendMinor).toBeLessThanOrEqual(1_000_000_000_000);
    expect(r.paidReach).toBeLessThanOrEqual(2_147_483_647);
    expect(r.clicks).toBeLessThanOrEqual(2_147_483_647);
  });
});

describe("SCP-Se · reach follows the estimate", () => {
  it("is inside the estimate band, ends included, for many ids", () => {
    for (let i = 0; i < 500; i++) {
      const r = simulatedBoostResult(facts({ boostId: id(i), reachEstimateLow: 10_000, reachEstimateHigh: 30_000 }));
      expect(r.paidReach).toBeGreaterThanOrEqual(10_000);
      expect(r.paidReach).toBeLessThanOrEqual(30_000);
    }
    // A one-number band and a zero band are still inside.
    expect(simulatedBoostResult(facts({ reachEstimateLow: 500, reachEstimateHigh: 500 })).paidReach).toBe(500);
    expect(simulatedBoostResult(facts({ reachEstimateLow: 0, reachEstimateHigh: 0 })).paidReach).toBe(0);
  });

  it("without an estimate it follows the spend in MAJOR units (the minor unit matters)", () => {
    const idr = simulatedBoostResult(facts({ reachEstimateLow: null, reachEstimateHigh: null, minorUnit: 0 }));
    const usd = simulatedBoostResult(facts({ reachEstimateLow: null, reachEstimateHigh: null, minorUnit: 2 }));
    expect(usd.spendMinor).toBe(idr.spendMinor);
    expect(usd.paidReach).toBeLessThan(idr.paidReach / 50);
    // One end missing counts as no estimate (the CHECK allows it): the spend's own yield, not a made-up band.
    expect(simulatedBoostResult(facts({ reachEstimateLow: 10_000, reachEstimateHigh: null }))).toEqual(idr);
  });
});

describe("SCP-Se · clicks follow the goal", () => {
  it("website above profile_visits above messages, for every id, with the same reach", () => {
    for (let i = 0; i < 400; i++) {
      const by = Object.fromEntries(SIMULATED_BOOST_GOALS.map((g) => [g, simulatedBoostResult(facts({ boostId: id(i), goal: g }))]));
      expect(by.website.paidReach).toBe(by.messages.paidReach);
      expect(by.website.clicks, `website > profile ${i}`).toBeGreaterThan(by.profile_visits.clicks);
      expect(by.profile_visits.clicks, `profile > messages ${i}`).toBeGreaterThan(by.messages.clicks);
    }
  });

  it("the audience nudges the rate and local is not below automatic; an unknown goal or audience still answers", () => {
    for (let i = 0; i < 100; i++) {
      const auto = simulatedBoostResult(facts({ boostId: id(i), audience: "automatic" })).clicks;
      const local = simulatedBoostResult(facts({ boostId: id(i), audience: "local" })).clicks;
      expect(local).toBeGreaterThanOrEqual(auto);
    }
    expect(isNonNegInt(simulatedBoostResult(facts({ goal: "mystery", audience: "mystery" })).clicks)).toBe(true);
  });
});

describe("SCP-Se · the completion window setting (config.social.simulatedBoostMinutes)", () => {
  const before = process.env.SOCIAL_SIMULATED_BOOST_MINUTES;
  afterEach(() => {
    if (before === undefined) delete process.env.SOCIAL_SIMULATED_BOOST_MINUTES;
    else process.env.SOCIAL_SIMULATED_BOOST_MINUTES = before;
    vi.resetModules();
  });
  async function minutesFor(raw: string | undefined): Promise<number> {
    if (raw === undefined) delete process.env.SOCIAL_SIMULATED_BOOST_MINUTES;
    else process.env.SOCIAL_SIMULATED_BOOST_MINUTES = raw;
    vi.resetModules();
    return (await import("../../../config")).config.social.simulatedBoostMinutes;
  }
  it("defaults to 10; a good whole number is kept; empty, junk, zero, negative, fractional and too large fall back to 10", async () => {
    expect(await minutesFor(undefined)).toBe(10);
    expect(await minutesFor("3")).toBe(3);
    expect(await minutesFor("1440")).toBe(1440);
    for (const bad of ["", "  ", "abc", "0", "-5", "2.5", "1441", "NaN", "Infinity"]) expect(await minutesFor(bad), JSON.stringify(bad)).toBe(10);
  });
});
