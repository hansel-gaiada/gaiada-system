import { describe, it, expect } from "vitest";
import { parseWindow, WINDOW_MS } from "./security-window";

describe("parseWindow", () => {
  it("defaults to 24h when absent or empty", () => {
    expect(parseWindow(undefined)).toEqual({ ok: true, window: "24h" });
    expect(parseWindow("")).toEqual({ ok: true, window: "24h" });
  });
  it("accepts the three windows", () => {
    for (const w of ["15m", "24h", "7d"] as const) expect(parseWindow(w)).toEqual({ ok: true, window: w });
  });
  it("🔴 anything else is refused, not defaulted (case, units, arrays, numbers)", () => {
    for (const bad of ["1h", "7D", "30d", "24", "all", " 24h", ["24h"], ["24h", "7d"], 24, {}, true]) {
      expect(parseWindow(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it("a narrower allowed set refuses the others (sign-ins are 24h or 7d)", () => {
    expect(parseWindow("15m", ["24h", "7d"]).ok).toBe(false);
    expect(parseWindow("7d", ["24h", "7d"])).toEqual({ ok: true, window: "7d" });
  });
  it("the millisecond spans are the names", () => {
    expect(WINDOW_MS["15m"]).toBe(900_000);
    expect(WINDOW_MS["24h"]).toBe(86_400_000);
    expect(WINDOW_MS["7d"]).toBe(604_800_000);
  });
});
