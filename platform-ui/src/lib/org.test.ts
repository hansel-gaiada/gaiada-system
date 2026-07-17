import { describe, it, expect } from "vitest";
import { defaultStructure, sanitizeStructure } from "./org";

describe("defaultStructure", () => {
  it("seeds the five departments for the agency", () => {
    const s = defaultStructure({ id: "co-agency", name: "Gaia Digital Agency", type: "agency" });
    expect(s.root.kind).toBe("company");
    expect(s.root.children.map((c) => c.name)).toEqual(["Web Dev", "SEO", "SMM", "Video Editor", "Design Graphic"]);
    expect(s.root.children.every((c) => c.kind === "department")).toBe(true);
  });

  it("seeds the canonical depth department → division → role → person for the agency", () => {
    const s = defaultStructure({ id: "co-agency", name: "Gaia Digital Agency", type: "agency" });
    const webDev = s.root.children[0];
    expect(webDev.children[0].kind).toBe("division");
    const division = webDev.children[0];
    expect(division.children[0].kind).toBe("role");
    expect(division.children[0].children[0].kind).toBe("person");
    // At least one employee is placed (assigned) so the depth is visible.
    expect(division.children[0].children[0].assigneeId).toBe("u-dev");
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

  it("migrates legacy 'team' nodes to 'division'", () => {
    const clean = sanitizeStructure({ root: { name: "Co", kind: "company", children: [{ name: "T", kind: "team", children: [] }] } });
    expect(clean.root.children[0].kind).toBe("division");
  });

  it("accepts the new holding and division kinds", () => {
    const clean = sanitizeStructure({ root: { name: "D & A", kind: "company", children: [{ name: "Dev", kind: "department", children: [{ name: "FE", kind: "division", children: [] }] }] } });
    expect(clean.root.children[0].children[0].kind).toBe("division");
  });
});
