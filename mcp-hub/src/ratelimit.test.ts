import { describe, it, expect, beforeEach } from "vitest";
import { take, resetBuckets } from "./ratelimit";

describe("rate limiter (WS2 §8)", () => {
  beforeEach(() => resetBuckets());

  it("allows up to the burst then blocks", () => {
    let t = 1_000_000;
    for (let i = 0; i < 5; i++) expect(take("k", 60, 5, t)).toBe(true);
    expect(take("k", 60, 5, t)).toBe(false); // burst exhausted, no time passed
  });

  it("refills over time at the configured rate", () => {
    let t = 1_000_000;
    for (let i = 0; i < 5; i++) take("k", 60, 5, t); // drain (60/min = 1/sec)
    expect(take("k", 60, 5, t)).toBe(false);
    t += 1_000; // 1 second → +1 token
    expect(take("k", 60, 5, t)).toBe(true);
    expect(take("k", 60, 5, t)).toBe(false);
  });

  it("keys are independent", () => {
    const t = 1_000_000;
    expect(take("a", 60, 1, t)).toBe(true);
    expect(take("a", 60, 1, t)).toBe(false);
    expect(take("b", 60, 1, t)).toBe(true); // different key, own bucket
  });

  it("a non-positive rate or burst disables limiting", () => {
    const t = 1_000_000;
    for (let i = 0; i < 100; i++) expect(take("x", 0, 5, t)).toBe(true);
    for (let i = 0; i < 100; i++) expect(take("y", 60, 0, t)).toBe(true);
  });
});
