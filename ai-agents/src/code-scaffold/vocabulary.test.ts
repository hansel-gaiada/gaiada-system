import { describe, it, expect } from "vitest";
import { PRIMITIVE_NAMES, BLOCK_TYPE_NAMES, isBlockType } from "./vocabulary";

describe("vocabulary mirror (§05 Layer 1)", () => {
  it("has exactly the 8 primitives §05 names", () => {
    expect([...PRIMITIVE_NAMES].sort()).toEqual(
      ["text", "richtext", "media", "relation", "number", "date", "select", "geo"].sort(),
    );
  });

  it("has exactly the 9 block types §05 names", () => {
    expect([...BLOCK_TYPE_NAMES].sort()).toEqual(
      ["hero", "richText", "gallery", "cta", "featureGrid", "form", "testimonial", "faq", "logoCloud"].sort(),
    );
  });

  it("isBlockType is true for every known block and false for a made-up one", () => {
    for (const t of BLOCK_TYPE_NAMES) expect(isBlockType(t)).toBe(true);
    expect(isBlockType("pricingTable")).toBe(false);
  });
});
