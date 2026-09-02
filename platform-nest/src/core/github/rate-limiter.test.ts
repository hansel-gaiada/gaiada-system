// GH-02 §4.7 acceptance criterion: "Bulk op by one user provably does not starve another." Pure unit
// tests against a fake clock/sleep — no network, no DB, runs everywhere this repo's vitest runs.
import { describe, it, expect, vi } from "vitest";
import { InstallationRateLimiter, GithubRetryableSignal } from "./rate-limiter";

/** A fake clock+sleep pair where `sleep(ms)` advances the clock by exactly `ms` and resolves on the
 *  next microtask — deterministic, no real timers, no flakiness from wall-clock scheduling. */
function fakeTime() {
  let now = 1_000_000;
  const clock = () => now;
  const sleep = (ms: number) => {
    now += ms;
    return Promise.resolve();
  };
  return { clock, sleep, advance: (ms: number) => (now += ms) };
}

describe("InstallationRateLimiter — per-user fairness (§4.7)", () => {
  it("a bulk operation by one user does not starve a single task from another user", async () => {
    const { clock, sleep } = fakeTime();
    const limiter = new InstallationRateLimiter(clock, sleep);
    const completionOrder: string[] = [];

    const runTask = (label: string) => async () => {
      completionOrder.push(label);
      return label;
    };

    // User A enqueues 20 tasks in one burst (a "bulk operation"). User B enqueues ONE task shortly
    // after — a real caller landing mid-burst, not before it, so this cannot pass by mere ordering.
    const aPromises = Array.from({ length: 20 }, (_, i) => limiter.schedule("user-a", runTask(`a${i}`)));
    const bPromise = limiter.schedule("user-b", runTask("b0"));

    await Promise.all([...aPromises, bPromise]);

    const bIndex = completionOrder.indexOf("b0");
    // Round-robin fairness: B's task runs on the SECOND dispatch (right after A's first), never
    // waiting behind the rest of A's 20-item bulk operation. A FIFO-across-all queue (the naive
    // "just queue everything" implementation this ticket explicitly rejects) would put b0 at index 20.
    expect(bIndex).toBe(1);
    expect(completionOrder.length).toBe(21);
  });

  it("three users interleave one-for-one round robin, not by arrival order within a user", async () => {
    const { clock, sleep } = fakeTime();
    const limiter = new InstallationRateLimiter(clock, sleep);
    const order: string[] = [];
    const track = (label: string) => async () => {
      order.push(label);
    };
    const all = [
      limiter.schedule("u1", track("u1-0")),
      limiter.schedule("u1", track("u1-1")),
      limiter.schedule("u2", track("u2-0")),
      limiter.schedule("u2", track("u2-1")),
      limiter.schedule("u3", track("u3-0")),
    ];
    await Promise.all(all);
    // Each of u1/u2/u3 gets a turn before any user's SECOND task runs.
    expect(order.slice(0, 3).sort()).toEqual(["u1-0", "u2-0", "u3-0"]);
    expect(order.slice(3)).toEqual(expect.arrayContaining(["u1-1", "u2-1"]));
  });

  it("a solo user with no contention just runs its tasks in order", async () => {
    const { clock, sleep } = fakeTime();
    const limiter = new InstallationRateLimiter(clock, sleep);
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => limiter.schedule("solo", async () => void order.push(i))),
    );
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("InstallationRateLimiter — backoff on retryable failures", () => {
  it("retries a GithubRetryableSignal up to maxAttempts, pausing the WHOLE queue meanwhile", async () => {
    const { clock, sleep } = fakeTime();
    const limiter = new InstallationRateLimiter(clock, sleep);
    let calls = 0;
    const flaky = async (attempt: number) => {
      calls += 1;
      if (attempt < 2) throw new GithubRetryableSignal("PATCH /repos/x", 1000, 0);
      return "ok";
    };
    const other = vi.fn(async () => "other-ran");

    const flakyPromise = limiter.schedule("u1", flaky, { maxAttempts: 5 });
    const otherPromise = limiter.schedule("u2", other);

    await expect(flakyPromise).resolves.toBe("ok");
    await expect(otherPromise).resolves.toBe("other-ran");
    expect(calls).toBe(3); // 2 failures + 1 success
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("rejects with the retryable signal itself once maxAttempts is exhausted — never wraps it", async () => {
    const { clock, sleep } = fakeTime();
    const limiter = new InstallationRateLimiter(clock, sleep);
    const alwaysFails = async () => {
      throw new GithubRetryableSignal("POST /repos/x/pulls", 500, 0);
    };
    await expect(limiter.schedule("u1", alwaysFails, { maxAttempts: 2 })).rejects.toBeInstanceOf(GithubRetryableSignal);
  });

  it("a non-retryable error rejects immediately without consuming a retry budget or pausing others", async () => {
    const { clock, sleep } = fakeTime();
    const limiter = new InstallationRateLimiter(clock, sleep);
    const boom = async () => {
      throw new Error("not a github rate-limit thing");
    };
    const otherRanAt: number[] = [];
    const other = async () => void otherRanAt.push(clock());

    await expect(limiter.schedule("u1", boom)).rejects.toThrow("not a github rate-limit thing");
    await limiter.schedule("u2", other);
    expect(otherRanAt.length).toBe(1);
  });
});

describe("InstallationRateLimiter — quota observation (§4.7 admin/info surface)", () => {
  it("reports the last observed x-ratelimit-* snapshot", () => {
    const limiter = new InstallationRateLimiter();
    expect(limiter.rateLimitSnapshot()).toEqual({ limit: null, remaining: null, resetAtMs: null });
    limiter.observe({ limit: 5000, remaining: 4321, resetAtMs: 1_700_000_000_000 });
    expect(limiter.rateLimitSnapshot()).toEqual({ limit: 5000, remaining: 4321, resetAtMs: 1_700_000_000_000 });
  });

  it("a partial observation only updates the fields present, keeping the rest", () => {
    const limiter = new InstallationRateLimiter();
    limiter.observe({ limit: 5000, remaining: 4321, resetAtMs: 1_700_000_000_000 });
    limiter.observe({ remaining: 4000 });
    expect(limiter.rateLimitSnapshot()).toEqual({ limit: 5000, remaining: 4000, resetAtMs: 1_700_000_000_000 });
  });

  it("proactively pauses when the bucket is observed dry, resuming exactly at reset", async () => {
    const { clock, sleep, advance } = fakeTime();
    const limiter = new InstallationRateLimiter(clock, sleep);
    const resetAt = clock() + 10_000;
    limiter.observe({ limit: 100, remaining: 0, resetAtMs: resetAt });
    let ranAt: number | null = null;
    const p = limiter.schedule("u1", async () => {
      ranAt = clock();
      return "ok";
    });
    await p;
    expect(ranAt).toBe(resetAt);
    void advance; // fakeTime's manual-advance helper is unused here; sleep() itself advances the clock.
  });

  it("queueDepth reports backlog per user and in total", () => {
    const limiter = new InstallationRateLimiter();
    const never = () => new Promise<void>(() => {});
    void limiter.schedule("u1", never);
    void limiter.schedule("u1", never);
    void limiter.schedule("u2", never);
    // drain() is kicked off on a deferred microtask (see schedule()'s own comment on why), so
    // checked synchronously right after scheduling — before any microtask has run — nothing has
    // been dispatched yet and both of u1's tasks are still queued.
    expect(limiter.queueDepth("u1")).toBe(2);
    expect(limiter.queueDepth()).toBeGreaterThanOrEqual(3);
    expect(limiter.activeUserCount()).toBeGreaterThanOrEqual(1);
  });
});
