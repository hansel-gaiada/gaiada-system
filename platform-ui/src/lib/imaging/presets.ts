// Presets — named Grades, the "look" library. These are the hand-authored LUTs
// that ship day one (no training required). A designer builds the house look once
// here; everyone applies it in one click and batches it consistently. Phase-2 the
// learned model produces Grades of the same shape, so a trained look drops into
// this same list alongside the hand-tuned ones.
//
// "Vivid Warm" is tuned to the reference the creative team supplied: a warm
// white-balance push, an S-curve of contrast, deepened shadows with a touch of
// highlight recovery, and a vibrance lift that lets muted colours pop without
// over-cooking skin.

import { IDENTITY_GRADE, mergeGrade, type Grade } from "./grade";

export interface Preset {
  id: string;
  label: string;
  /** One-line description shown under the preset chip. */
  blurb: string;
  grade: Grade;
}

export const PRESETS: Preset[] = [
  {
    id: "vivid-warm",
    label: "Vivid Warm",
    blurb: "Editorial warmth — punchy contrast, rich colour, deep shadows.",
    grade: mergeGrade(IDENTITY_GRADE, {
      temperature: 0.34,
      tint: 0.04,
      exposure: -0.04,
      contrast: 1.18,
      shadows: -0.16,
      highlights: -0.1,
      gamma: 0.97,
      saturation: 1.1,
      vibrance: 0.32,
    }),
  },
  {
    id: "product-clean",
    label: "Product Clean",
    blurb: "Bright, neutral, true-to-colour — for catalogue and storefront.",
    grade: mergeGrade(IDENTITY_GRADE, {
      exposure: 0.12,
      contrast: 1.06,
      highlights: -0.08,
      shadows: 0.08,
      saturation: 1.04,
      vibrance: 0.1,
    }),
  },
  {
    id: "document-crisp",
    label: "Document Crisp",
    blurb: "High-legibility scan — strong contrast, neutralised paper.",
    grade: mergeGrade(IDENTITY_GRADE, {
      exposure: 0.1,
      contrast: 1.35,
      gamma: 1.05,
      saturation: 0.9,
      shadows: -0.05,
    }),
  },
  {
    id: "neutral",
    label: "Neutral",
    blurb: "No stylised look — the original, unchanged.",
    grade: IDENTITY_GRADE,
  },
];

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
