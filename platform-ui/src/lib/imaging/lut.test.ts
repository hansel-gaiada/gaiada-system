import { describe, it, expect } from "vitest";
import { IDENTITY_GRADE, mergeGrade } from "./grade";
import { applyGrade, type RGB } from "./ops";
import { bakeLut, sampleLut, lutToAtlas, applyLutToImageData, DEFAULT_LUT_SIZE } from "./lut";

describe("lut — shape", () => {
  it("bakes a size^3 * 3 table", () => {
    const lut = bakeLut(IDENTITY_GRADE, 17);
    expect(lut.size).toBe(17);
    expect(lut.data.length).toBe(17 * 17 * 17 * 3);
  });
  it("defaults to the .cube standard 33", () => {
    expect(bakeLut(IDENTITY_GRADE).size).toBe(DEFAULT_LUT_SIZE);
  });
});

describe("lut — identity round-trips", () => {
  it("sampling an identity LUT returns the input colour", () => {
    const lut = bakeLut(IDENTITY_GRADE);
    for (const px of [[0, 0, 0], [0.2, 0.5, 0.8], [1, 1, 1], [0.33, 0.66, 0.1]] as RGB[]) {
      const [r, g, b] = sampleLut(lut, px);
      expect(r).toBeCloseTo(px[0], 2);
      expect(g).toBeCloseTo(px[1], 2);
      expect(b).toBeCloseTo(px[2], 2);
    }
  });
});

describe("lut — approximates the exact grade", () => {
  it("trilinear LUT sampling is close to applyGrade() for a real look", () => {
    const grade = mergeGrade(IDENTITY_GRADE, { temperature: 0.3, contrast: 1.2, saturation: 1.1, vibrance: 0.3, shadows: -0.15 });
    const lut = bakeLut(grade, 33);
    let maxErr = 0;
    for (let i = 0; i < 200; i++) {
      const px: RGB = [((i * 7) % 100) / 100, ((i * 13) % 100) / 100, ((i * 29) % 100) / 100];
      const exact = applyGrade(px, grade);
      const viaLut = sampleLut(lut, px);
      for (let c = 0; c < 3; c++) maxErr = Math.max(maxErr, Math.abs(exact[c] - viaLut[c]));
    }
    // 33-node LUT with trilinear interp should track the exact maths tightly.
    expect(maxErr).toBeLessThan(0.02);
  });
});

describe("lut — atlas packing", () => {
  it("atlas has the expected dimensions", () => {
    const lut = bakeLut(IDENTITY_GRADE, 33);
    const atlas = lutToAtlas(lut);
    expect(atlas.width).toBe(33 * 33);
    expect(atlas.height).toBe(33);
    expect(atlas.pixels.length).toBe(33 * 33 * 33 * 4);
  });
});

describe("lut — CPU image apply", () => {
  it("identity LUT leaves an RGBA buffer unchanged and preserves alpha", () => {
    const lut = bakeLut(IDENTITY_GRADE);
    const px = new Uint8ClampedArray([10, 128, 240, 77, 0, 255, 100, 200]);
    const before = Array.from(px);
    applyLutToImageData(lut, px);
    expect(px[3]).toBe(before[3]); // alpha preserved
    expect(px[7]).toBe(before[7]);
    for (let i = 0; i < px.length; i++) {
      if (i % 4 === 3) continue;
      expect(Math.abs(px[i] - before[i])).toBeLessThanOrEqual(3); // quantisation only
    }
  });
});
