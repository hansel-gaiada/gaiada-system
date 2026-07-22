// Deterministic auto-enhance — the "Auto" button. This is classic image
// processing, NOT AI: it reads the image's own statistics and derives a NEUTRAL
// correction (fix the white balance, recover exposure, restore contrast). It is
// fast, reproducible and testable — the right tool for "make this technically
// correct". Creative looks (Vivid Warm etc.) are presets applied on top; the AI
// tier (phase 2) learns a stylised look instead of a neutral one.
//
// Split in two so the maths stays pure and unit-testable: analyseImage() reduces
// pixels to a small stats struct; deriveAutoGrade() turns stats into a Grade with
// no pixel access at all.

import { IDENTITY_GRADE, mergeGrade, type Grade } from "./grade";
import { luma } from "./ops";

export interface ImageStats {
  /** Mean of each channel over sampled pixels, [0,1]. */
  meanR: number;
  meanG: number;
  meanB: number;
  /** Mean luma, [0,1]. */
  meanLuma: number;
  /** Luma percentiles used for black/white point + contrast estimation. */
  p01: number;
  p99: number;
}

/**
 * Reduce an RGBA buffer to summary stats. Samples at a stride for speed (full
 * histogram not needed for global correction). Pure given the buffer.
 */
export function analyseImage(rgba: Uint8ClampedArray | number[], stride = 4): ImageStats {
  let sr = 0, sg = 0, sb = 0, n = 0;
  const lumaHist = new Array<number>(256).fill(0);
  const step = 4 * Math.max(1, stride);
  for (let i = 0; i + 3 < rgba.length; i += step) {
    const r = rgba[i] / 255, g = rgba[i + 1] / 255, b = rgba[i + 2] / 255;
    sr += r; sg += g; sb += b; n++;
    const L = Math.round(luma(r, g, b) * 255);
    lumaHist[L < 0 ? 0 : L > 255 ? 255 : L]++;
  }
  if (n === 0) return { meanR: 0.5, meanG: 0.5, meanB: 0.5, meanLuma: 0.5, p01: 0, p99: 1 };

  const percentile = (frac: number): number => {
    const target = frac * n;
    let cum = 0;
    for (let v = 0; v < 256; v++) {
      cum += lumaHist[v];
      if (cum >= target) return v / 255;
    }
    return 1;
  };

  return {
    meanR: sr / n,
    meanG: sg / n,
    meanB: sb / n,
    meanLuma: (0.2126 * sr + 0.7152 * sg + 0.0722 * sb) / n,
    p01: percentile(0.01),
    p99: percentile(0.99),
  };
}

/**
 * Derive a neutral correction from stats:
 *  - White balance via the grey-world assumption: the average scene should be
 *    neutral grey, so counter any channel imbalance (temperature/tint).
 *  - Exposure toward a mid-luma target of ~0.5.
 *  - Contrast toward a healthy tonal range when the histogram is compressed.
 * Output is clamped to conservative limits so "Auto" never wildly over-corrects.
 */
export function deriveAutoGrade(stats: ImageStats): Grade {
  const { meanR, meanG, meanB, meanLuma, p01, p99 } = stats;
  const grey = (meanR + meanG + meanB) / 3 || 1e-6;

  // Grey-world: how far each channel is from neutral → temperature/tint.
  // R heavy vs B heavy → the scene is warm/cool; correct by pushing the opposite way.
  const warmBias = (meanR - meanB) / grey; // >0 means image is already warm
  const greenBias = (meanG - (meanR + meanB) / 2) / grey; // >0 means image is green
  const temperature = clamp(-warmBias * 0.6, -0.5, 0.5);
  const tint = clamp(greenBias * 0.6, -0.5, 0.5); // green bias → push toward magenta (tint>0)

  // Exposure toward mid-grey 0.5 (in stops), gently.
  const target = 0.5;
  const exposure = meanLuma > 1e-3 ? clamp(Math.log2(target / meanLuma) * 0.6, -1, 1) : 0;

  // Contrast: if the tonal range is compressed (p99-p01 small), add contrast.
  const range = Math.max(1e-3, p99 - p01);
  const contrast = clamp(1 + (0.8 - range) * 0.5, 0.9, 1.35);

  return mergeGrade(IDENTITY_GRADE, { temperature, tint, exposure, contrast });
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Convenience: pixels → neutral auto grade. */
export function autoGradeForImage(rgba: Uint8ClampedArray | number[]): Grade {
  return deriveAutoGrade(analyseImage(rgba));
}
