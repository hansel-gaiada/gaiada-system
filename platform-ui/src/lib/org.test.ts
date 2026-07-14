import { describe, it, expect } from "vitest";
import { defaultStructure, sanitizeStructure } from "./org";

describe("defaultStructure", () => {
  it("seeds the five departments for the agency", () => {
    const s = defaultStructure({ id: "co-agency", name: "Gaia Digital Agency", type: "agency" });
    expect(s.root.kind).toBe("company");
    expect(s.root.children.map((c) => c.name)).toEqual(["Web Dev", "SEO", "SMM", "Video Editor", "Design Graphic"]);
    expect(s.root.children.every((c) => c.kind === "department")).toBe(true);
  });

  it("gives non-agency companies an empty, editable root", () => {
    const s = defaultStructure({ id: "co-holding", name: "Holding", type: "holding" });
    expect(s.root.children).toEqual([]);
  });
});

describe("sanitizeStructure", () => {
  it("coerces invalid kinds and forces the root to company", () => {
    const clean = sanitizeStructure({ root: { name: "X", kind: "bogus", children: [{ name: "A", kind: "department" }] } });
    expect(clean.root.kind).toBe("company");
    expect(clean.root.children[0].kind).toBe("department");
    expect(clean.root.children[0].children).toEqual([]);
  });

  it("fills a missing root name with the fallback and defaults unknown child kinds to role", () => {
    const clean = sanitizeStructure({ root: { children: [{ name: "B" }] } }, "Acme");
    expect(clean.root.name).toBe("Acme");
    expect(clean.root.children[0].kind).toBe("role");
  });
});
