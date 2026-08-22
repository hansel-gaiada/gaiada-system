import { describe, it, expect } from "vitest";
import { companyToneIndex, companyToneVar, companyToneLineVar } from "./companyColor";

describe("companyColor", () => {
  it("is deterministic — same id always resolves to the same tone", () => {
    expect(companyToneIndex("co-agency")).toBe(companyToneIndex("co-agency"));
    expect(companyToneVar("co-agency")).toBe(companyToneVar("co-agency"));
  });

  it("resolves into the 1..8 categorical range", () => {
    for (const id of ["co-agency", "co-holding", "co-x", "a", "", "very-long-company-id-string-here"]) {
      const idx = companyToneIndex(id);
      expect(idx).toBeGreaterThanOrEqual(1);
      expect(idx).toBeLessThanOrEqual(8);
    }
  });

  it("distributes across more than one tone for a realistic id set", () => {
    // Not a strict uniformity requirement — just guards against a degenerate
    // hash that collapses every id onto the same bucket.
    const ids = Array.from({ length: 20 }, (_, i) => `company-${i}`);
    const tones = new Set(ids.map(companyToneIndex));
    expect(tones.size).toBeGreaterThan(1);
  });

  it("companyToneVar/companyToneLineVar reference the matching --cat-N token", () => {
    const idx = companyToneIndex("co-agency");
    expect(companyToneVar("co-agency")).toBe(`var(--cat-${idx})`);
    expect(companyToneLineVar("co-agency")).toBe(`var(--cat-${idx}-line)`);
  });
});
