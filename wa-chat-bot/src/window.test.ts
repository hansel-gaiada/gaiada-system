import { describe, it, expect } from "vitest";
import { computeWindow } from "./window";

const H = 60 * 60 * 1000;

describe("computeWindow", () => {
  it("caps first run at 12 hours back", () => {
    const now = 100 * H;
    expect(computeWindow(undefined, now)).toEqual({ start: now - 12 * H, end: now });
  });

  it("continues from the previous run (gap-safe)", () => {
    const now = 100 * H;
    const last = 82 * H; // 18h earlier — longer than the 12h cap
    expect(computeWindow(last, now)).toEqual({ start: last, end: now });
  });

  it("ignores a future/invalid last-run", () => {
    const now = 100 * H;
    expect(computeWindow(200 * H, now)).toEqual({ start: now - 12 * H, end: now });
  });
});
