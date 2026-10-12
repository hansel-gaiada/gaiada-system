// M5-V4 — the decay job's flag, loop and parsers, and the controller's pure helpers. No services needed:
// the flag-off path is proven here by a fetch spy and a sweep spy that must never be called.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DECAY_ENABLED_ENV, UMAMI_PATH_LIMIT, decayIntervalMs, isDecayJobEnabled, parseUmamiPaths, startContentDecayLoop,
  type DecaySweepResult,
} from "./content-decay-job";
import { buildRefreshBrief, toDto } from "./content-decay.controller";
import { detectDecay } from "./content-decay";

const EMPTY: DecaySweepResult = { skippedLocked: false, tenants: 0, properties: 0, noData: 0, evaluated: 0, inserted: 0, resolved: 0, errors: 0 };

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("SEARCH_DECAY_ENABLED flag", () => {
  it("is ON only for exactly \"1\"", () => {
    expect(isDecayJobEnabled({ [DECAY_ENABLED_ENV]: "1" })).toBe(true);
    for (const v of [undefined, "", " ", "0", "true", "TRUE", "yes", "11", " 1", "1 "]) {
      expect(isDecayJobEnabled({ [DECAY_ENABLED_ENV]: v } as NodeJS.ProcessEnv), JSON.stringify(v)).toBe(false);
    }
    expect(isDecayJobEnabled({})).toBe(false);
  });

  it("flag off: the loop is null, no timer, no sweep, no network", () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const sweep = vi.fn(async () => EMPTY);
    for (const v of [undefined, "", "0", "true"]) {
      expect(startContentDecayLoop({ [DECAY_ENABLED_ENV]: v } as NodeJS.ProcessEnv, { sweep, initialDelayMs: 1 })).toBeNull();
    }
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * 24 * 3600 * 1000);
    expect(sweep).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("flag on: sweeps after the initial delay, then on the interval, and stop() ends it", async () => {
    vi.useFakeTimers();
    const sweep = vi.fn(async () => EMPTY);
    const loop = startContentDecayLoop({ [DECAY_ENABLED_ENV]: "1", SEARCH_DECAY_INTERVAL_MS: "120000" }, { sweep, initialDelayMs: 1000 });
    expect(loop).not.toBeNull();
    expect(sweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120000);
    expect(sweep).toHaveBeenCalledTimes(2);
    loop!.stop();
    await vi.advanceTimersByTimeAsync(10 * 120000);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it("a throwing sweep does not kill the loop", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sweep = vi.fn(async () => { throw new Error("boom"); });
    const loop = startContentDecayLoop({ [DECAY_ENABLED_ENV]: "1" }, { sweep, initialDelayMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(24 * 3600 * 1000);
    expect(sweep).toHaveBeenCalledTimes(2);
    loop!.stop();
  });

  it("the interval: empty, junk, zero and sub-minute fall back to a day, never 0", () => {
    const day = 24 * 3600 * 1000;
    for (const v of [undefined, "", "0", "abc", "-5", "59999", "NaN"]) {
      expect(decayIntervalMs({ SEARCH_DECAY_INTERVAL_MS: v } as NodeJS.ProcessEnv), String(v)).toBe(day);
    }
    expect(decayIntervalMs({ SEARCH_DECAY_INTERVAL_MS: "60000" })).toBe(60000);
  });
});

describe("parseUmamiPaths", () => {
  it("normalizes paths, sums duplicates, drops junk rows", () => {
    const r = parseUmamiPaths([{ x: "/a/", y: 10 }, { x: "/a?utm=1", y: 5 }, { x: "", y: 3 }, { x: "/b", y: "9" }, { y: 1 }, { x: "/c", y: 2 }]);
    expect(r.byPath.get("/a")).toBe(15);
    expect(r.byPath.get("/c")).toBe(2);
    expect(r.byPath.has("/b")).toBe(false);
    expect(r.covered).toBe(true);
    expect(r.truncated).toBe(false);
  });
  it("an empty or non-array body is not covered (missing, not zero)", () => {
    expect(parseUmamiPaths([]).covered).toBe(false);
    expect(parseUmamiPaths({ error: "x" }).covered).toBe(false);
    expect(parseUmamiPaths(null).covered).toBe(false);
  });
  it("a full page of rows is flagged truncated", () => {
    const rows = Array.from({ length: UMAMI_PATH_LIMIT }, (_, i) => ({ x: `/p${i}`, y: 1 }));
    expect(parseUmamiPaths(rows).truncated).toBe(true);
  });
});

describe("small cells (visitor addendum R-V6)", () => {
  it("the detector never spells out a recent view count under 5", () => {
    const r = detectDecay({
      recent: { clicks: null, impressions: null, position: null, views: 2 },
      baseline: { clicks: null, impressions: null, position: null, views: 300 },
      yearAgo: null,
    });
    expect(r.flagged).toBe(true);
    expect(r.reason).toContain("fewer than 5 (from 300)");
    expect(r.reason).not.toMatch(/to 2\b/);
  });
  it("toDto masks a stored view count under 5 and its derived drop", () => {
    const dto = toDto({
      id: "i", page_path: "/x", window_from: "2026-09-12", window_to: "2026-10-09", window_days: 28, status: "open", reason: "r",
      reasons: [{ metric: "views", basis: "prior_period", recent: 2, baseline: 300, drop: 298, dropPct: 0.99, text: "t" }],
      brief_id: null, detected_at: new Date("2026-10-12T00:00:00Z"), acknowledged_at: null, resolved_at: null,
    });
    expect(dto.reasons[0]).toMatchObject({ recent: "<5", drop: null, dropPct: null });
    expect(dto.window).toEqual({ from: "2026-09-12", to: "2026-10-09", days: 28 });
  });
});

describe("buildRefreshBrief", () => {
  it("is a fixed template from the page path and the reason (no AI)", () => {
    const b = buildRefreshBrief("/blog/post", "Search clicks fell 62% (410 to 156).");
    expect(b.topic).toBe("Refresh: /blog/post");
    expect(b.body).toContain("Search clicks fell 62%");
    expect(b.outline.length).toBeGreaterThan(2);
  });
});
