import { describe, it, expect } from "vitest";
import { defaultStructure, sanitizeStructure } from "./org";

describe("defaultStructure", () => {
  it("seeds the five departments for the agency", () => {
    const s = defaultStructure({ id: "co-agency", name: "Gaia Digital Agency", type: "agency" });
    expect(s.root.kind).toBe("company");
    // GM is LAST here on purpose: these ids are positional (`dept-${i + 1}`), so inserting it at the
    // front would renumber Web Dev off `dept-1` and SEO off `dept-3` — the latter is hard-wired into
    // the demo login mapping. The sidebar hoists GM for reading (`shell/nav.ts`); identity stays put.
    expect(s.root.children.map((c) => c.name)).toEqual(["Web Dev", "Creatives", "SEO", "Social Media", "GM"]);
    expect(s.root.children.every((c) => c.kind === "department")).toBe(true);
  });

  it("gives GM its own department node with no divisions", () => {
    // Mirrors platform-nest `seed/roster.ts`: `{ id: "d-gm", name: "GM", divisions: [] }` — people
    // sit directly under the department, same as Social Media.
    const s = defaultStructure({ id: "co-agency", name: "Gaia Digital Agency", type: "agency" });
    const gm = s.root.children.find((c) => c.name === "GM")!;
    expect(gm.id).toBe("dept-5");
    expect(gm.children.every((c) => c.kind === "person")).toBe(true);
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

  // 2026-09-02 — ported from platform-nest's org-structure.service.test.ts, the byte-identical bug
  // this file's own header calls a "mirror" of. A parent node with no explicit `id` used to read its
  // fallback `n-<count>` from the RETURN statement, which executes AFTER recursing through the whole
  // subtree — so a parent and its last-visited descendant (also missing an id) shared one id string.
  // This sanitizer also runs client-side on the cookie-fallback structure, so a collision here is a
  // real bug even when no backend PUT is ever made.
  it("gives every node a UNIQUE fallback id, even along a single-child chain where no node supplies one", () => {
    const clean = sanitizeStructure({
      root: {
        name: "Acme",
        children: [{
          name: "Engineering", kind: "department", children: [{
            name: "Backend", kind: "role", children: [
              { name: "Alice", kind: "person", assigneeId: "u-alice" },
            ],
          }],
        }],
      },
    });
    const dept = clean.root.children[0];
    const role = dept.children[0];
    const person = role.children[0];
    const ids = [clean.root.id, dept.id, role.id, person.id];
    expect(new Set(ids).size, `duplicate fallback ids: ${ids.join(", ")}`).toBe(4);
  });

  it("de-duplicates explicit ids reused across sibling nodes, without moving anyone or touching assigneeId", () => {
    const clean = sanitizeStructure({
      root: {
        id: "root", name: "Gaia Digital Agency", kind: "company",
        children: [{
          id: "d-gm", name: "GM", kind: "department",
          children: [
            { id: "p-019fb652", name: "Ayu", kind: "person", assigneeId: "u-ayu", children: [] },
            { id: "p-019fb652", name: "Budi", kind: "person", assigneeId: "u-budi", children: [] },
          ],
        }],
      },
    });
    const people = clean.root.children[0].children;
    expect(people.map((p) => p.id)).toEqual(["p-019fb652", "p-019fb652-dup1"]);
    expect(people.map((p) => p.name)).toEqual(["Ayu", "Budi"]);
    expect(people.map((p) => p.assigneeId)).toEqual(["u-ayu", "u-budi"]);
  });
});
