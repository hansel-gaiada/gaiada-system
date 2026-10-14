// DW-7d: the sanitize guard of the backfill. A stored tree is only appended to when `sanitizeStructure`
// would leave it alone, apart from the assignee fields a seed leaves out (which read as null).
import { describe, it, expect } from "vitest";
import { sanitizeStructure } from "../admin/org-structure.service";
import { sanitizeDrift } from "./functional-departments";

const seedShaped = {
  root: {
    id: "root", name: "Acme", kind: "company",
    children: [{ id: "d-web", name: "Web Dev", kind: "department", children: [{ id: "v-web", name: "Web", kind: "division", children: [] }] }],
  },
};

describe("sanitizeDrift", () => {
  it("a seed-built tree without assigneeId/assigneeName is stable", () => {
    expect(sanitizeDrift(seedShaped)).toBeNull();
  });
  it("a tree the sanitizer already produced is stable", () => {
    expect(sanitizeDrift(sanitizeStructure(seedShaped))).toBeNull();
  });
  it("untrimmed names, unknown kinds, legacy teams, duplicate ids and a missing root are drift", () => {
    const withChild = (child: unknown) => ({ root: { ...seedShaped.root, children: [child] } });
    expect(sanitizeDrift(withChild({ id: "a", name: " Ops ", kind: "department", children: [] }))).not.toBeNull();
    expect(sanitizeDrift(withChild({ id: "a", name: "Ops", kind: "weird", children: [] }))).not.toBeNull();
    expect(sanitizeDrift(withChild({ id: "a", name: "Ops", kind: "team", children: [] }))).not.toBeNull();
    expect(sanitizeDrift({ root: { ...seedShaped.root, children: [
      { id: "a", name: "A", kind: "department", children: [] }, { id: "a", name: "B", kind: "department", children: [] },
    ] } })).not.toBeNull();
    expect(sanitizeDrift({})).not.toBeNull();
    expect(sanitizeDrift(null)).not.toBeNull();
  });
  it("a tree over the sanitizer's node limit is drift", () => {
    const kids = Array.from({ length: 305 }, (_, i) => ({ id: `n${i}`, name: `N${i}`, kind: "role", children: [] }));
    expect(sanitizeDrift({ root: { ...seedShaped.root, children: kids } })).not.toBeNull();
  });
});
