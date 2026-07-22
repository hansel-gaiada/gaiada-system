// Pure colour operations — the maths of the grade, expressed as functions on a
// single RGB pixel with channels normalised to [0,1]. These are deterministic,
// side-effect free and fully unit-testable (no canvas, no GPU). The WebGL
// fragment shader in renderer.ts mirrors this exact sequence so the GPU preview
// and the CPU/LUT path agree.
//
// Operating space: gamma (sRGB) space, as CSS/Canvas filters do. Formulas are
// chosen to be monotonic and to leave IDENTITY_GRADE a bit-exact no-op.

import type { Grade } from "./grade";

export type RGB = [number, number, number];

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Rec.709 luma — perceptual brightness weight. */
export const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// ── Individual ops (each returns a new RGB, each is a no-op at its identity) ──

/** Exposure in stops: multiply by 2^ev. ev=0 → unchanged. */
export function applyExposure([r, g, b]: RGB, ev: number): RGB {
  if (ev === 0) return [r, g, b];
  const k = Math.pow(2, ev);
  return [clamp01(r * k), clamp01(g * k), clamp01(b * k)];
}

/** Contrast around mid-grey pivot 0.5. k=1 → unchanged. */
export function applyContrast([r, g, b]: RGB, k: number): RGB {
  if (k === 1) return [r, g, b];
  const f = (c: number) => clamp01((c - 0.5) * k + 0.5);
  return [f(r), f(g), f(b)];
}

/** White balance. temperature>0 warms (R up / B down); tint>0 pushes magenta (G down). */
export function applyWhiteBalance([r, g, b]: RGB, temperature: number, tint: number): RGB {
  if (temperature === 0 && tint === 0) return [r, g, b];
  const rGain = 1 + 0.25 * temperature;
  const bGain = 1 - 0.25 * temperature;
  const gGain = 1 - 0.15 * tint;
  return [clamp01(r * rGain), clamp01(g * gGain), clamp01(b * bGain)];
}

/** Midtone gamma. gamma=1 → unchanged; >1 lifts midtones, <1 deepens. */
export function applyGamma([r, g, b]: RGB, gamma: number): RGB {
  if (gamma === 1) return [r, g, b];
  const inv = 1 / gamma;
  return [Math.pow(r, inv), Math.pow(g, inv), Math.pow(b, inv)];
}

/**
 * Highlight/shadow tone shaping. Each pixel is weighted by how much it belongs to
 * the highlight vs shadow region (by luma), then nudged. shadows<0 crushes darks,
 * highlights<0 recovers blown lights — the classic "deepen + recover" of an
 * editorial grade. Both 0 → unchanged.
 */
export function applyToneRegions([r, g, b]: RGB, highlights: number, shadows: number): RGB {
  if (highlights === 0 && shadows === 0) return [r, g, b];
  const L = luma(r, g, b);
  // Smooth region weights: shadowW peaks at black, highlightW peaks at white.
  const shadowW = Math.pow(1 - L, 2);
  const highlightW = Math.pow(L, 2);
  const delta = shadows * 0.5 * shadowW + highlights * 0.5 * highlightW;
  return [clamp01(r + delta), clamp01(g + delta), clamp01(b + delta)];
}

/** Global saturation about the pixel's own luma. s=1 → unchanged, 0 → greyscale. */
export function applySaturation([r, g, b]: RGB, s: number): RGB {
  if (s === 1) return [r, g, b];
  const L = luma(r, g, b);
  return [clamp01(L + (r - L) * s), clamp01(L + (g - L) * s), clamp01(L + (b - L) * s)];
}

/**
 * Vibrance — saturation that spares already-saturated pixels (protects skin,
 * lets muted colours pop). v>0 boosts, weighted by (1 - currentSaturation).
 * v=0 → unchanged.
 */
export function applyVibrance([r, g, b]: RGB, v: number): RGB {
  if (v === 0) return [r, g, b];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max <= 0 ? 0 : (max - min) / max; // HSV saturation
  const boost = 1 + v * (1 - sat);
  const L = luma(r, g, b);
  return [clamp01(L + (r - L) * boost), clamp01(L + (g - L) * boost), clamp01(L + (b - L) * boost)];
}

// ── Composed pipeline ────────────────────────────────────────────────────────

/**
 * Apply a full Grade to one pixel, in the canonical order:
 *   white balance → exposure → contrast → tone regions → gamma → saturation → vibrance.
 * This ordering matches a photographic pipeline (fix the light first, then shape
 * tone, then colour). The WebGL shader applies the same steps in the same order.
 */
export function applyGrade(px: RGB, grade: Grade): RGB {
  let c = applyWhiteBalance(px, grade.temperature, grade.tint);
  c = applyExposure(c, grade.exposure);
  c = applyContrast(c, grade.contrast);
  c = applyToneRegions(c, grade.highlights, grade.shadows);
  c = applyGamma(c, grade.gamma);
  c = applySaturation(c, grade.saturation);
  c = applyVibrance(c, grade.vibrance);
  return c;
}
