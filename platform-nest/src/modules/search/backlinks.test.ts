// SM-16 — pure unit tests for isBacklinkLostSpike (backlinks.ts). No DB, no HTTP — mirrors
// rank.test.ts's split between pure-function tests and the controller-level integration file
// (backlinks-integration.test.ts).
import { describe, it, expect } from "vitest";
import { isBacklinkLostSpike } from "./backlinks";

describe("isBacklinkLostSpike (design §09: 'search.backlinks.lost_spike' producer)", () => {
  it("no prior snapshot -> never a spike, regardless of the new count", () => {
    expect(isBacklinkLostSpike(null, 0)).toBe(false);
    expect(isBacklinkLostSpike(null, 10_000)).toBe(false);
  });

  it("prior count of zero -> never a spike (nothing to divide by, and a rise from 0 isn't a loss)", () => {
    expect(isBacklinkLostSpike(0, 0)).toBe(false);
    expect(isBacklinkLostSpike(0, 5)).toBe(false);
  });

  it("current >= previous is NOT a spike (a gain or steady count, never a loss)", () => {
    expect(isBacklinkLostSpike(100, 100)).toBe(false);
    expect(isBacklinkLostSpike(100, 150)).toBe(false);
  });

  it("a small relative AND absolute drop is NOT a spike (noise, not signal)", () => {
    // 1000 -> 995: 0.5% drop, 5 links absolute — under both thresholds.
    expect(isBacklinkLostSpike(1000, 995)).toBe(false);
  });

  it("an absolute drop >= 50 IS a spike even if the ratio is small (a large site's small % is still a real loss)", () => {
    // 100,000 -> 99,940: 0.06% drop, but 60 links absolute >= LOST_SPIKE_ABSOLUTE.
    expect(isBacklinkLostSpike(100_000, 99_940)).toBe(true);
  });

  it("a >=10% relative drop IS a spike even with a small absolute count (a small site's real loss)", () => {
    // 100 -> 89: 11% drop, only 11 links absolute — under the absolute threshold, over the ratio one.
    expect(isBacklinkLostSpike(100, 89)).toBe(true);
  });

  it("exactly at the ratio threshold (10%) counts as a spike (>=, not >)", () => {
    expect(isBacklinkLostSpike(1000, 900)).toBe(true);
  });

  it("exactly at the absolute threshold (50) counts as a spike (>=, not >)", () => {
    expect(isBacklinkLostSpike(10_000, 9_950)).toBe(true);
  });

  it("never divides by zero or produces NaN for any input (§6r's NaN-cap lesson, verified the way the bug was verified)", () => {
    for (const [prev, cur] of [[0, 0], [0, 100], [null, 0], [null, 100]] as Array<[number | null, number]>) {
      const result = isBacklinkLostSpike(prev, cur);
      expect(typeof result).toBe("boolean");
      expect(Number.isNaN(result as unknown as number)).toBe(false);
    }
  });
});
