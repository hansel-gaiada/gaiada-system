import { describe, it, expect } from "vitest";
import { analyseImage, deriveAutoGrade, autoGradeForImage } from "./autoEnhance";

// Build a flat RGBA buffer of a single colour, `n` pixels.
function solid(r: number, g: number, b: number, n = 64): Uint8ClampedArray {
  const px = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) { px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255; }
  return px;
}

describe("autoEnhance — analysis", () => {
  it("computes channel means", () => {
    const s = analyseImage(solid(255, 128, 0), 1);
    expect(s.meanR).toBeCloseTo(1, 2);
    expect(s.meanG).toBeCloseTo(0.502, 2);
    expect(s.meanB).toBeCloseTo(0, 2);
  });
});

describe("autoEnhance — neutral correction is directional", () => {
  it("a blue-cast image gets warmed (temperature > 0)", () => {
    const g = autoGradeForImage(solid(90, 110, 170), 1);
    expect(g.temperature).toBeGreaterThan(0);
  });
  it("a warm/orange-cast image gets cooled (temperature < 0)", () => {
    const g = autoGradeForImage(solid(190, 120, 70), 1);
    expect(g.temperature).toBeLessThan(0);
  });
  it("a dark image gets an exposure lift (> 0)", () => {
    const g = autoGradeForImage(solid(40, 40, 40), 1);
    expect(g.exposure).toBeGreaterThan(0);
  });
  it("a bright image gets pulled down (exposure < 0)", () => {
    const g = autoGradeForImage(solid(220, 220, 220), 1);
    expect(g.exposure).toBeLessThan(0);
  });
  it("a neutral mid-grey image is left roughly alone", () => {
    const g = autoGradeForImage(solid(128, 128, 128), 1);
    expect(Math.abs(g.temperature)).toBeLessThan(0.05);
    expect(Math.abs(g.exposure)).toBeLessThan(0.1);
  });
});

describe("autoEnhance — stays within safe limits", () => {
  it("never over-corrects an extreme cast beyond clamps", () => {
    const g = deriveAutoGrade({ meanR: 1, meanG: 0, meanB: 0, meanLuma: 0.3, p01: 0.4, p99: 0.6 });
    expect(g.temperature).toBeGreaterThanOrEqual(-0.5);
    expect(g.temperature).toBeLessThanOrEqual(0.5);
    expect(g.contrast).toBeLessThanOrEqual(1.35);
  });
});
