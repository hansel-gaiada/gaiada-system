// Regression pin for a LIVE INCIDENT, 2026-08-18: the position/expiry sweep ran with a 0ms interval
// and busy-looped against Postgres at ~46% CPU on the live box.
//
// How it happened, in one line each:
//   1. compose was given `POSITION_DRIFT_SWEEP_INTERVAL_MS: ${POSITION_DRIFT_SWEEP_INTERVAL_MS:-}`,
//      and that form passes an EMPTY STRING into the container when the variable is unset;
//   2. `config.ts` read it as `Number(process.env.X ?? default)` — and `??` does not fire on `""`,
//      while `Number("")` is `0`;
//   3. `startPositionMaintenanceLoop`'s `setTimeout(tick, 0)` chain then re-ran the sweep as fast as
//      the event loop allowed. Nothing errored. `/health` stayed 200. It presented as healthy uptime.
//
// Both code layers are pinned below. The compose layer (a real default instead of `:-`) is not
// testable from here and is guarded by a comment at the line itself.
import { describe, it, expect, vi, afterEach } from "vitest";
import { startPositionMaintenanceLoop } from "./grant-expiry-sweep";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sweep interval guard (2026-08-18 busy-loop incident)", () => {
  // ── layer 2: the loop itself refuses a non-positive interval ───────────────────────────────────
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`refuses to start with intervalMs=${bad} and never schedules a timer`, () => {
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const handle = startPositionMaintenanceLoop(bad as number);

      // The refusal must be LOUD — a silent no-op sweep is its own failure mode.
      expect(errorSpy).toHaveBeenCalledOnce();
      expect(String(errorSpy.mock.calls[0][0])).toContain("refusing to start");
      // and it must not have armed anything. `void tick()` is what would have run the sweep, so the
      // assertion is on the SCHEDULING call, which is the part that loops.
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      // The handle is still safe to call — callers should not have to know it refused.
      expect(() => handle.stop()).not.toThrow();
    });
  }

  it("DOES start with a positive interval (the guard is not over-broad)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = startPositionMaintenanceLoop(86_400_000);
    expect(errorSpy).not.toHaveBeenCalled();
    handle.stop(); // stop immediately — the first tick fires async and we do not want it in this test
  });
});

// ── layer 1: config coercion ─────────────────────────────────────────────────────────────────────
// `config.ts` freezes its values at import time, so the helper is exercised by re-importing the
// module with a mutated environment rather than by calling the (private) function directly.
describe("config.positionDriftSweepIntervalMs coercion", () => {
  const DEFAULT = 24 * 3600 * 1000;

  async function loadWith(value: string | undefined): Promise<number> {
    const prev = process.env.POSITION_DRIFT_SWEEP_INTERVAL_MS;
    if (value === undefined) delete process.env.POSITION_DRIFT_SWEEP_INTERVAL_MS;
    else process.env.POSITION_DRIFT_SWEEP_INTERVAL_MS = value;
    vi.resetModules();
    try {
      const { config } = await import("../config");
      return config.positionDriftSweepIntervalMs;
    } finally {
      if (prev === undefined) delete process.env.POSITION_DRIFT_SWEEP_INTERVAL_MS;
      else process.env.POSITION_DRIFT_SWEEP_INTERVAL_MS = prev;
      vi.resetModules();
    }
  }

  it("🔴 THE INCIDENT: an EMPTY string yields the default, not 0", async () => {
    // This is the exact value compose's `${VAR:-}` form delivered.
    expect(await loadWith("")).toBe(DEFAULT);
  });

  it("whitespace-only yields the default", async () => {
    expect(await loadWith("   ")).toBe(DEFAULT);
  });

  it("unset yields the default (unchanged behaviour)", async () => {
    expect(await loadWith(undefined)).toBe(DEFAULT);
  });

  it("zero and negatives yield the default", async () => {
    expect(await loadWith("0")).toBe(DEFAULT);
    expect(await loadWith("-5000")).toBe(DEFAULT);
  });

  it("garbage yields the default", async () => {
    expect(await loadWith("soon")).toBe(DEFAULT);
  });

  it("a real value is still honoured (the coercion is not over-broad)", async () => {
    expect(await loadWith("60000")).toBe(60_000);
  });
});
