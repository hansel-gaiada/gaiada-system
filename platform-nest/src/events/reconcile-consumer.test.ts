// ORG-7 §3 — nightly drift/orphan sweep LOOP lifecycle (start/tick/stop). Purely a timer-plumbing
// test: sweepDriftAndOrphans() itself is already exhaustively covered against live Postgres in
// service-reconciler.test.ts / service-reconciler-adversarial.test.ts (the "flag off" case, the
// orphan-TTL escalation, etc.) — this file mocks it out and uses fake timers so the loop's
// interval/stop semantics can be asserted deterministically with no DB/Redis dependency at all.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sweepDriftAndOrphans = vi.fn(async () => ({ reconciled: 0, drift: 0, autoSuspended: 0 }));
vi.mock("../admin/service-reconciler", () => ({
  sweepDriftAndOrphans: () => sweepDriftAndOrphans(),
  // reconcileAssignment/reconcileProvider are imported by this same module (for startReconcileLoop's
  // dispatch path) but unused by anything this file exercises.
  reconcileAssignment: vi.fn(),
  reconcileProvider: vi.fn(),
}));

import { startDriftSweepLoop } from "./reconcile-consumer";

describe("startDriftSweepLoop (ORG-7 §3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sweepDriftAndOrphans.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks immediately on start, then again after each interval", async () => {
    const handle = startDriftSweepLoop(1000);
    // The first tick fires synchronously (void tick()); flush its microtask queue.
    await vi.advanceTimersByTimeAsync(0);
    expect(sweepDriftAndOrphans).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(sweepDriftAndOrphans).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(sweepDriftAndOrphans).toHaveBeenCalledTimes(3);

    handle.stop();
  });

  it("stop() halts further ticks (no zombie interval)", async () => {
    const handle = startDriftSweepLoop(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(sweepDriftAndOrphans).toHaveBeenCalledTimes(1);

    handle.stop();
    await vi.advanceTimersByTimeAsync(5000);
    // No further calls after stop, however long we advance.
    expect(sweepDriftAndOrphans).toHaveBeenCalledTimes(1);
  });

  it("a rejected sweep is swallowed (logged, not thrown) and the loop keeps ticking", async () => {
    sweepDriftAndOrphans.mockRejectedValueOnce(new Error("boom"));
    const handle = startDriftSweepLoop(1000);
    await vi.advanceTimersByTimeAsync(0); // the failing tick
    await vi.advanceTimersByTimeAsync(1000); // the loop must have survived and re-scheduled
    expect(sweepDriftAndOrphans).toHaveBeenCalledTimes(2);
    handle.stop();
  });
});
