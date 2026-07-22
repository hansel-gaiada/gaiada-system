// The Grade — the complete, serialisable description of a colour grade. Every
// correction the Image Studio can apply is a value in this struct. It is the
// SINGLE SOURCE OF TRUTH for a "look": presets are Grades, the manual sliders
// edit a Grade, the deterministic auto-enhance derives a Grade, and (phase 2)
// the AI predicts one. The engine bakes a Grade into a 3D LUT (see lut.ts) which
// is what both the WebGL renderer and the future learned model operate on.
//
// All parameters are chosen so IDENTITY_GRADE is a perfect no-op, which keeps the
// whole pipeline honest: "no adjustment" must return the pixels untouched.

export interface Grade {
  /** Exposure in stops. 0 = unchanged. Each +1 roughly doubles perceived brightness. */
  exposure: number;
  /** Contrast multiplier around mid-grey. 1 = unchanged, >1 punchier, <1 flatter. */
  contrast: number;
  /** White balance warmth. 0 = neutral, >0 warmer (amber), <0 cooler (blue). Range ~[-1,1]. */
  temperature: number;
  /** White balance tint. 0 = neutral, >0 magenta, <0 green. Range ~[-1,1]. */
  tint: number;
  /** Midtone gamma. 1 = unchanged, >1 lifts midtones, <1 deepens them. */
  gamma: number;
  /** Global saturation. 1 = unchanged, 0 = greyscale, >1 more saturated. */
  saturation: number;
  /** Vibrance — saturation weighted toward less-saturated pixels. 0 = off. Range ~[-1,1]. */
  vibrance: number;
  /** Highlight recovery/boost. 0 = unchanged, <0 pulls blown highlights down. Range ~[-1,1]. */
  highlights: number;
  /** Shadow lift/deepen. 0 = unchanged, <0 deepens (crush) shadows, >0 lifts them. Range ~[-1,1]. */
  shadows: number;
}

export const IDENTITY_GRADE: Grade = {
  exposure: 0,
  contrast: 1,
  temperature: 0,
  tint: 0,
  gamma: 1,
  saturation: 1,
  vibrance: 0,
  highlights: 0,
  shadows: 0,
};

/** Sane hard limits for each control — used by the UI sliders and to clamp AI/auto output. */
export const GRADE_LIMITS: Record<keyof Grade, { min: number; max: number; step: number }> = {
  exposure: { min: -3, max: 3, step: 0.01 },
  contrast: { min: 0, max: 2, step: 0.01 },
  temperature: { min: -1, max: 1, step: 0.01 },
  tint: { min: -1, max: 1, step: 0.01 },
  gamma: { min: 0.3, max: 3, step: 0.01 },
  saturation: { min: 0, max: 2, step: 0.01 },
  vibrance: { min: -1, max: 1, step: 0.01 },
  highlights: { min: -1, max: 1, step: 0.01 },
  shadows: { min: -1, max: 1, step: 0.01 },
};

const KEYS = Object.keys(IDENTITY_GRADE) as (keyof Grade)[];

/** Clamp every field of a grade into its allowed range. */
export function clampGrade(g: Grade): Grade {
  const out = {} as Grade;
  for (const k of KEYS) {
    const { min, max } = GRADE_LIMITS[k];
    out[k] = Math.min(max, Math.max(min, g[k]));
  }
  return out;
}

/** Overlay a partial grade onto a base (used by presets + slider edits). */
export function mergeGrade(base: Grade, patch: Partial<Grade>): Grade {
  return clampGrade({ ...base, ...patch });
}

/** True when a grade makes no visible change (within a small epsilon). */
export function isIdentity(g: Grade, eps = 1e-4): boolean {
  return KEYS.every((k) => Math.abs(g[k] - IDENTITY_GRADE[k]) <= eps);
}
