import { describe, it, expect } from "vitest";
import {
  isValidCommentary, commentaryRemaining, findMissingDeviationNotes, findIncompleteAxes,
  previewComposite, checkSubmitReadiness, formatCohortValue,
  MIN_COMMENTARY_LENGTH, DEVIATION_THRESHOLD,
  type AppraisalAxis, type AppraisalAxisScore,
} from "./appraisals";

function scores(overrides: Partial<Record<AppraisalAxis, AppraisalAxisScore>> = {}): Record<AppraisalAxis, AppraisalAxisScore> {
  return {
    delivery: { auto: 3, manager: 3 },
    quality: { auto: 3, manager: 3 },
    effort: { auto: 3, manager: 3 },
    collaboration: { auto: 3, manager: 3 },
    ...overrides,
  };
}

describe("isValidCommentary / commentaryRemaining", () => {
  it("refuses commentary shorter than the minimum, mirroring appraisal-engine.ts's rule", () => {
    expect(isValidCommentary("too short")).toBe(false);
    expect(isValidCommentary(undefined)).toBe(false);
    expect(isValidCommentary(null)).toBe(false);
  });
  it("accepts commentary at or above the minimum (trimmed)", () => {
    const ok = "x".repeat(MIN_COMMENTARY_LENGTH);
    expect(isValidCommentary(ok)).toBe(true);
    expect(isValidCommentary(`  ${ok}  `)).toBe(true);
  });
  it("reports exactly how many characters remain", () => {
    expect(commentaryRemaining("")).toBe(MIN_COMMENTARY_LENGTH);
    expect(commentaryRemaining("x".repeat(10))).toBe(MIN_COMMENTARY_LENGTH - 10);
    expect(commentaryRemaining("x".repeat(MIN_COMMENTARY_LENGTH))).toBe(0);
  });
});

describe("findMissingDeviationNotes — §5.2 point 4", () => {
  it("flags an axis whose manager score deviates from auto by more than the threshold, with no note", () => {
    const s = scores({ effort: { auto: 2, manager: 5 } }); // deviation 3
    expect(findMissingDeviationNotes(s)).toEqual(["effort"]);
  });
  it("does not flag a deviation within the threshold", () => {
    const s = scores({ effort: { auto: 2, manager: 3 } }); // deviation 1, threshold is >1
    expect(DEVIATION_THRESHOLD).toBe(1);
    expect(findMissingDeviationNotes(s)).toEqual([]);
  });
  it("does not flag a large deviation that already carries a non-empty note", () => {
    const s = scores({ effort: { auto: 2, manager: 5, note: "Real ownership beyond the metric." } });
    expect(findMissingDeviationNotes(s)).toEqual([]);
  });
  it("never flags an axis with no computable auto (small-cohort-suppressed) — nothing to deviate from", () => {
    const s = scores({ effort: { auto: null, manager: 5 } });
    expect(findMissingDeviationNotes(s)).toEqual([]);
  });
  it("never flags an axis the manager hasn't scored yet", () => {
    const s = scores({ effort: { auto: 2, manager: null } });
    expect(findMissingDeviationNotes(s)).toEqual([]);
  });
});

describe("findIncompleteAxes / previewComposite", () => {
  it("lists every axis still missing a manager score", () => {
    const s = scores({ effort: { auto: 3, manager: null }, quality: { auto: 3, manager: null } });
    expect(findIncompleteAxes(s)).toEqual(["quality", "effort"]);
  });
  it("is null until every axis is scored", () => {
    const weights = { delivery: 0.35, quality: 0.3, effort: 0.1, collaboration: 0.25 };
    expect(previewComposite(weights, scores({ effort: { auto: 3, manager: null } }))).toBeNull();
  });
  it("computes the weighted sum once every axis is scored", () => {
    const weights = { delivery: 0.35, quality: 0.3, effort: 0.1, collaboration: 0.25 };
    const s = { delivery: { auto: 4, manager: 4 }, quality: { auto: 4, manager: 4 }, effort: { auto: 2, manager: 4 }, collaboration: { auto: 5, manager: 5 } };
    expect(previewComposite(weights, s)).toBeCloseTo(0.35 * 4 + 0.3 * 4 + 0.1 * 4 + 0.25 * 5, 5);
  });
});

describe("checkSubmitReadiness — the pre-submit checklist surfaced by the form", () => {
  it("is not ok when scores are incomplete, commentary is short, and a deviation is unjustified", () => {
    const s = scores({ effort: { auto: 2, manager: null }, quality: { auto: 2, manager: 5 } });
    const r = checkSubmitReadiness(s, "too short");
    expect(r.ok).toBe(false);
    expect(r.incompleteAxes).toEqual(["effort"]);
    expect(r.missingDeviationNotes).toEqual(["quality"]);
    expect(r.commentaryOk).toBe(false);
  });
  it("is ok once every axis is scored, every deviation is justified, and commentary clears the minimum", () => {
    const s = scores({ quality: { auto: 2, manager: 5, note: "Justified." } });
    const r = checkSubmitReadiness(s, "x".repeat(MIN_COMMENTARY_LENGTH));
    expect(r.ok).toBe(true);
  });
});

describe("formatCohortValue — percent values are 0-100 fractions, never a raw 0-1 number (TR-17/TR-18's convention)", () => {
  it("formats a percent as a rounded whole percentage, never the raw fraction", () => {
    expect(formatCohortValue(0.864, "percent")).toBe("86%");
    expect(formatCohortValue(0.864, "percent")).not.toBe("0.86");
  });
  it("formats minutes and counts plainly", () => {
    expect(formatCohortValue(125, "minutes")).toBe("125m");
    expect(formatCohortValue(1200, "count")).toBe("1,200");
  });
});
