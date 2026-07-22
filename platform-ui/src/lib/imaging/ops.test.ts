import { describe, it, expect } from "vitest";
import { IDENTITY_GRADE, mergeGrade } from "./grade";
import {
  applyGrade, applyExposure, applyContrast, applyWhiteBalance, applyGamma,
  applySaturation, applyVibrance, applyToneRegions, luma, type RGB,
} from "./ops";

const mid: RGB = [0.5, 0.5, 0.5];

describe("ops — identities are exact no-ops", () => {
  it("IDENTITY_GRADE leaves pixels untouched", () => {
    for (const px of [[0, 0, 0], [0.2, 0.6, 0.9], [1, 1, 1]] as RGB[]) {
      expect(applyGrade(px, IDENTITY_GRADE)).toEqual(px);
    }
  });
  it("each op is a no-op at its identity value", () => {
    expect(applyExposure(mid, 0)).toEqual(mid);
    expect(applyContrast(mid, 1)).toEqual(mid);
    expect(applyWhiteBalance(mid, 0, 0)).toEqual(mid);
    expect(applyGamma(mid, 1)).toEqual(mid);
    expect(applySaturation(mid, 1)).toEqual(mid);
    expect(applyVibrance(mid, 0)).toEqual(mid);
    expect(applyToneRegions(mid, 0, 0)).toEqual(mid);
  });
});

describe("ops — directional correctness", () => {
  it("exposure +1 stop brightens (doubles below clip)", () => {
    expect(applyExposure([0.25, 0.25, 0.25], 1)).toEqual([0.5, 0.5, 0.5]);
  });
  it("exposure clamps at white", () => {
    expect(applyExposure([0.8, 0.8, 0.8], 2)).toEqual([1, 1, 1]);
  });
  it("warm white balance raises red and lowers blue", () => {
    const [r, , b] = applyWhiteBalance([0.5, 0.5, 0.5], 0.5, 0);
    expect(r).toBeGreaterThan(0.5);
    expect(b).toBeLessThan(0.5);
  });
  it("contrast >1 pushes darks down and lights up around 0.5", () => {
    expect(applyContrast([0.25, 0.25, 0.25], 1.5)[0]).toBeLessThan(0.25);
    expect(applyContrast([0.75, 0.75, 0.75], 1.5)[0]).toBeGreaterThan(0.75);
  });
  it("saturation 0 produces greyscale (all channels equal luma)", () => {
    const [r, g, b] = applySaturation([0.2, 0.6, 0.9], 0);
    expect(r).toBeCloseTo(g, 6);
    expect(g).toBeCloseTo(b, 6);
    expect(r).toBeCloseTo(luma(0.2, 0.6, 0.9), 6);
  });
  it("gamma >1 lifts midtones", () => {
    expect(applyGamma([0.25, 0.25, 0.25], 2)[0]).toBeGreaterThan(0.25);
  });
  it("shadows<0 deepens darks but leaves highlights ~unchanged", () => {
    const dark = applyToneRegions([0.1, 0.1, 0.1], 0, -0.5);
    const light = applyToneRegions([0.95, 0.95, 0.95], 0, -0.5);
    expect(dark[0]).toBeLessThan(0.1);
    expect(light[0]).toBeCloseTo(0.95, 2);
  });
});

describe("ops — vibrance spares saturated pixels", () => {
  it("boosts a muted pixel more than an already-saturated one", () => {
    const muted: RGB = [0.5, 0.52, 0.55];
    const saturated: RGB = [0.9, 0.1, 0.1];
    const dMuted = deltaSat(muted, applyVibrance(muted, 0.8));
    const dSat = deltaSat(saturated, applyVibrance(saturated, 0.8));
    expect(dMuted).toBeGreaterThan(dSat);
  });
});

describe("ops — output stays in gamut", () => {
  it("a strong grade never leaves [0,1]", () => {
    const g = mergeGrade(IDENTITY_GRADE, { exposure: 2, contrast: 2, saturation: 2, temperature: 1, vibrance: 1 });
    for (const px of [[0, 0, 0], [0.3, 0.7, 0.1], [1, 1, 1]] as RGB[]) {
      for (const c of applyGrade(px, g)) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });
});

function deltaSat(a: RGB, b: RGB): number {
  const s = (p: RGB) => { const mx = Math.max(...p), mn = Math.min(...p); return mx <= 0 ? 0 : (mx - mn) / mx; };
  return s(b) - s(a);
}
