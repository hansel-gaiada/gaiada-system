import { describe, it, expect, beforeEach } from "vitest";
import { checkRate, resetRateLimiter } from "./rate-limit";

describe("rate-limit (token bucket)", () => {
  beforeEach(() => resetRateLimiter());

  it("allows up to capacity, then blocks", () => {
    const opts = { capacity: 2, refillPerSec: 0, now: 1000 };
    expect(checkRate("u1", opts).allowed).toBe(true);
    expect(checkRate("u1", opts).allowed).toBe(true);
    const third = checkRate("u1", opts);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });

  it("refills over time", () => {
    const base = { capacity: 1, refillPerSec: 1 };
    expect(checkRate("u2", { ...base, now: 0 }).allowed).toBe(true);
    expect(checkRate("u2", { ...base, now: 0 }).allowed).toBe(false);
    // 1s later one token has refilled
    expect(checkRate("u2", { ...base, now: 1000 }).allowed).toBe(true);
  });

  it("keys are independent", () => {
    const opts = { capacity: 1, refillPerSec: 0, now: 5 };
    expect(checkRate("a", opts).allowed).toBe(true);
    expect(checkRate("b", opts).allowed).toBe(true);
  });
});
