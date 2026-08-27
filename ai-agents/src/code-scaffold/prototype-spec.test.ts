import { describe, it, expect } from "vitest";
import { parsePrototypeSpec } from "./prototype-spec";

describe("parsePrototypeSpec", () => {
  it("parses a structured JSON prototype into pages verbatim", () => {
    const raw = JSON.stringify({
      pages: [
        { slug: "", title: "Home", collection: "landing", isListing: false },
        { slug: "blog", title: "Blog", collection: "blog-post", isListing: true },
      ],
    });
    const { spec, mode } = parsePrototypeSpec(raw);
    expect(mode).toBe("structured");
    expect(spec.pages).toHaveLength(2);
    expect(spec.pages[1]).toEqual({ slug: "blog", title: "Blog", collection: "blog-post", isListing: true });
  });

  it("falls back to markdown headings when the artifact is prose, never inventing a collection", () => {
    const md = "# Acme Rebrand — Design Brief\n\n## Home\nHero + testimonials.\n\n## Pricing\nA table.\n";
    const { spec, mode } = parsePrototypeSpec(md);
    expect(mode).toBe("markdown-fallback");
    expect(spec.pages.length).toBeGreaterThanOrEqual(3);
    expect(spec.pages[0].slug).toBe(""); // first heading = home
    for (const p of spec.pages) expect(p.collection).toBeUndefined();
  });

  it("malformed JSON-looking input also falls back to the markdown heuristic rather than throwing", () => {
    const raw = "{ this is not json #Heading";
    expect(() => parsePrototypeSpec(raw)).not.toThrow();
    const { mode } = parsePrototypeSpec(raw);
    expect(mode).toBe("markdown-fallback");
  });

  it("prose with no headings at all still yields one home page", () => {
    const { spec, mode } = parsePrototypeSpec("Just some prose, no structure.");
    expect(mode).toBe("markdown-fallback");
    expect(spec.pages).toEqual([{ slug: "", title: "Home" }]);
  });
});
