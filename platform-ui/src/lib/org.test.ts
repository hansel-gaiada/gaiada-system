import { describe, it, expect } from "vitest";
import { defaultStructure, sanitizeStructure } from "./org";

describe("defaultStructure", () => {
  it("seeds the eight departments for the agency: the five business ones, then HR, Finance and IT (DW-7d)", () => {
    const s = defaultStructure({ id: "co-agency", name: "Gaia Digital Agency", type: "agency", vertical: "agency" });
    expect(s.root.kind).toBe("company");
    // GM is LAST here on purpose: these ids are positional (`dept-${i + 1}`), so inserting it at the
    // front would renumber Web Dev off `dept-1` and SEO off `dept-3` — the latter is hard-wired into
    // the demo login mapping. The switcher hoists GM for reading (`lib/workspaceAccess.ts`); identity stays put.
    expect(s.root.children.map((c) => c.name)).toEqual(["Web Dev", "Creatives", "SEO", "Social Media", "GM", "HR", "Finance", "IT"]);
    expect(s.root.children.every((c) => c.kind === "department")).toBe(true);
  });

  it("gives HR, Finance and IT the ids dept-6..dept-8, after GM, so no earlier id moves (DW-7d)", () => {
    const s = defaultStructure({ id: "co-agency", name: "Gaia Digital Agency", type: "agency", vertical: "agency" });
    expect(s.root.children.slice(5).map((c) => [c.id, c.name])).toEqual([["dept-6", "HR"], ["dept-7", "Finance"], ["dept-8", "IT"]]);
  });

  it("gives GM its own department node with no divisions", () => {
    // Mirrors platform-nest `seed/roster.ts`: `{ id: "d-gm", name: "GM", divisions: [] }` — people
    // sit directly under the department, same as Social Media.
    const s = defaultStructure({ id: "co-agency", name: "Gaia Digital Agency", type: "agency", vertical: "agency" });
    const gm = s.root.children.find((c) => c.name === "GM")!;
    expect(gm.id).toBe("dept-5");
    expect(gm.children.every((c) => c.kind === "person")).toBe(true);
  });

  it("seeds the canonical depth department → division → role → person for the agency", () => {
    const s = defaultStructure({ id: "co-agency", name: "Gaia Digital Agency", type: "agency", vertical: "agency" });
    const webDev = s.root.children[0];
    expect(webDev.children[0].kind).toBe("division");
    const division = webDev.children[0];
    expect(division.children[0].kind).toBe("role");
    expect(division.children[0].children[0].kind).toBe("person");
    // At least one employee is placed (assigned) so the depth is visible.
    expect(division.children[0].children[0].assigneeId).toBe("u-dev");
  });

  it("gives non-agency companies an empty, editable root", () => {
    const s = defaultStructure({ id: "co-holding", name: "Holding", type: "holding", vertical: "holding" });
    expect(s.root.children).toEqual([]);
  });

  // PV-D13: the seed follows the VERTICAL. Neither the legacy `type` nor a company id (the old
  // hard-coded "co-agency") may select the agency tree.
  it("keys the agency tree on the vertical alone, not on type or id", () => {
    expect(defaultStructure({ id: "co-agency", name: "X", type: "agency", vertical: "general" }).root.children).toEqual([]);
    expect(defaultStructure({ id: "co-agency", name: "X", type: "agency" }).root.children).toEqual([]);
    expect(defaultStructure({ id: "anything", name: "X", type: null, vertical: "agency" }).root.children).toHaveLength(8);
  });
});

// DW-9a: the hospitality vertical gets a small seed so the generic workspace has a department to be driven on.
describe("defaultStructure: the hospitality seed (DW-9a)", () => {
  const viceroy = () => defaultStructure({ id: "co-resort", name: "Viceroy", type: "resort", vertical: "hospitality" });

  it("seeds Front Office (no bespoke workspace) and HR, Finance and IT", () => {
    expect(viceroy().root.children.map((c) => [c.id, c.name])).toEqual([
      ["hosp-dept-1", "Front Office"], ["hosp-dept-2", "HR"], ["hosp-dept-3", "Finance"], ["hosp-dept-4", "IT"],
    ]);
  });

  it("never reuses an agency node id, so an org_unit grant cannot cross companies", () => {
    const ids = (n: { id: string; children: readonly { id: string; children: readonly unknown[] }[] }): string[] =>
      [n.id, ...n.children.flatMap((c) => ids(c as never))];
    const agency = new Set(ids(defaultStructure({ id: "co-agency", name: "A", type: "agency", vertical: "agency" }).root as never));
    const resort = ids(viceroy().root as never).filter((id) => id !== "root");
    expect(resort.length).toBeGreaterThan(4);
    for (const id of resort) expect(agency.has(id)).toBe(false);
  });

  it("places u-resort in Front Office > Reception > Front Desk Agent, at the canonical depth", () => {
    const fo = viceroy().root.children[0];
    expect(fo.children[0].kind).toBe("division");
    expect(fo.children[0].children[0].kind).toBe("role");
    expect(fo.children[0].children[0].children[0]).toMatchObject({ kind: "person", assigneeId: "u-resort" });
  });

  it("is keyed by the vertical alone: the other verticals stay empty, and a prototype key is not a vertical", () => {
    for (const vertical of ["holding", "general", "catering", "unknown", "constructor", "toString", undefined]) {
      expect(defaultStructure({ id: "x", name: "X", type: null, vertical }).root.children).toEqual([]);
    }
    expect(defaultStructure({ id: "anything", name: "X", type: null, vertical: "hospitality" }).root.children).toHaveLength(4);
  });
});

describe("defaultStructure: DW-9a placements in the agency tree", () => {
  it("places u-seo, u-social and u-creative in SEO, Social Media and Creatives, each exactly once, and moves no positional id", () => {
    const s = defaultStructure({ id: "co-agency", name: "Gaia Digital Agency", type: "agency", vertical: "agency" });
    const where = (who: string) => {
      const hit: string[] = [];
      const walk = (n: { id: string; assigneeId?: string | null; children: readonly never[] }, dept: string) => {
        if (n.assigneeId === who) hit.push(dept);
        for (const c of n.children as never[]) walk(c, dept);
      };
      for (const d of s.root.children) walk(d as never, d.id);
      return hit;
    };
    expect(where("u-seo")).toEqual(["dept-3"]);
    expect(where("u-social")).toEqual(["dept-4"]);
    expect(where("u-creative")).toEqual(["dept-2"]);
    expect(where("u-dev")).toEqual(["dept-1"]);
    expect(s.root.children.map((c) => c.id)).toEqual(["dept-1", "dept-2", "dept-3", "dept-4", "dept-5", "dept-6", "dept-7", "dept-8"]);
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
