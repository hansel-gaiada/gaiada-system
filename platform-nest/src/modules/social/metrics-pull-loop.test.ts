// The metrics pull loop's schedule (no database: the sweep is injected). A sweep that fails as a whole (at boot, the
// company list's connection timing out while every loop starts at once) is tried again after METRICS_PULL_RETRY_MS, not a
// full interval; a sweep that runs goes back to the interval; the retry is never later than the interval itself.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startMetricsPullLoop, METRICS_PULL_RETRY_MS } from "./metrics-job";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("startMetricsPullLoop · the schedule after a failed sweep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries a failed boot tick after the retry window, then keeps the interval once a sweep runs", async () => {
    let calls = 0;
    const run = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("timeout exceeded when trying to connect");
      return { tenants: 1 };
    });
    const loop = startMetricsPullLoop(DAY, { run });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(METRICS_PULL_RETRY_MS - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(METRICS_PULL_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(DAY - METRICS_PULL_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(3);
    loop.stop();
  });

  it("never waits longer than the interval after a failure", async () => {
    const run = vi.fn(async () => { throw new Error("down"); });
    const loop = startMetricsPullLoop(60_000, { run, retryMs: 10 * 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it("stops: no tick after stop()", async () => {
    const run = vi.fn(async () => { throw new Error("down"); });
    const loop = startMetricsPullLoop(HOUR, { run });
    await vi.advanceTimersByTimeAsync(0);
    loop.stop();
    await vi.advanceTimersByTimeAsync(DAY);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
