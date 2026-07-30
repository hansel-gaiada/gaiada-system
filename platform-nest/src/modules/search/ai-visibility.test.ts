// SM-16 — pure unit tests for isAiVisibilityChange (ai-visibility.ts). No DB, no HTTP — mirrors
// rank.test.ts / backlinks.test.ts's split between pure-function tests and the controller-level
// integration file (ai-visibility-integration.test.ts).
import { describe, it, expect } from "vitest";
import { isAiVisibilityChange } from "./ai-visibility";

describe("isAiVisibilityChange (design §12 SM-16 AC: 'GEO panel shows mention/citation deltas')", () => {
  it("no prior row -> never a change, regardless of the new flags", () => {
    expect(isAiVisibilityChange(null, { brandMentioned: true, cited: true })).toBe(false);
    expect(isAiVisibilityChange(null, { brandMentioned: false, cited: false })).toBe(false);
  });

  it("identical flags vs prior -> not a change", () => {
    expect(
      isAiVisibilityChange({ brandMentioned: true, cited: true }, { brandMentioned: true, cited: true }),
    ).toBe(false);
    expect(
      isAiVisibilityChange({ brandMentioned: false, cited: false }, { brandMentioned: false, cited: false }),
    ).toBe(false);
  });

  it("brandMentioned flips -> a change", () => {
    expect(
      isAiVisibilityChange({ brandMentioned: false, cited: false }, { brandMentioned: true, cited: false }),
    ).toBe(true);
    expect(
      isAiVisibilityChange({ brandMentioned: true, cited: false }, { brandMentioned: false, cited: false }),
    ).toBe(true);
  });

  it("cited flips (even with brandMentioned unchanged) -> a change", () => {
    expect(
      isAiVisibilityChange({ brandMentioned: true, cited: false }, { brandMentioned: true, cited: true }),
    ).toBe(true);
    expect(
      isAiVisibilityChange({ brandMentioned: true, cited: true }, { brandMentioned: true, cited: false }),
    ).toBe(true);
  });

  it("both flags flip -> still just one change (not double-counted, boolean return)", () => {
    expect(
      isAiVisibilityChange({ brandMentioned: false, cited: false }, { brandMentioned: true, cited: true }),
    ).toBe(true);
  });
});
