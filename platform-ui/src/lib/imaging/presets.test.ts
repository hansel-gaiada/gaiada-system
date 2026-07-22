import { describe, it, expect } from "vitest";
import { PRESETS, presetById } from "./presets";
import { isIdentity } from "./grade";
import { applyGrade, luma, type RGB } from "./ops";

describe("presets — registry", () => {
  it("exposes the expected looks with unique ids", () => {
    const ids = PRESETS.map((p) => p.id);
    expect(ids).toContain("vivid-warm");
    expect(ids).toContain("product-clean");
    expect(ids).toContain("document-crisp");
    expect(ids).toContain("neutral");
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("neutral is a true identity; the rest are not", () => {
    expect(isIdentity(presetById("neutral")!.grade)).toBe(true);
    expect(isIdentity(presetById("vivid-warm")!.grade)).toBe(false);
  });
});

describe("presets — Vivid Warm does what it says", () => {
  const grade = presetById("vivid-warm")!.grade;
  const sample: RGB = [0.45, 0.4, 0.38]; // a muted mid-tone

  it("warms the image (red rises relative to blue)", () => {
    const [r, , b] = applyGrade(sample, grade);
    const beforeWarmth = sample[0] - sample[2];
    const afterWarmth = r - b;
    expect(afterWarmth).toBeGreaterThan(beforeWarmth);
  });
  it("increases saturation of a muted colour", () => {
    const sat = (p: RGB) => { const mx = Math.max(...p), mn = Math.min(...p); return mx <= 0 ? 0 : (mx - mn) / mx; };
    expect(sat(applyGrade(sample, grade))).toBeGreaterThan(sat(sample));
  });
  it("deepens shadows (a dark pixel gets darker)", () => {
    const dark: RGB = [0.12, 0.11, 0.1];
    expect(luma(...applyGrade(dark, grade))).toBeLessThan(luma(...dark));
  });
});
