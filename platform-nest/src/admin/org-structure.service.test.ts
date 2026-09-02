// Pure unit tests for `sanitizeStructure`'s fallback-id allocation. No database, no skipIf — same
// posture as dept-resolution.test.ts.
//
// Live symptom this pins (reported 2026-08-26): in the `GM` org tree, four different people all
// carried the SAME node id (`p-019fb652`) — 2 distinct ids across 5 people. The `p-` collision is a
// SEPARATE defect in the stored blob/seed (upsertPersonNode mints a deterministic `p-${userId}`, so
// a real collision there means a duplicate id was already IN the data, not a bug in the helper) —
// but reading this file's `sanitizeStructure()` turned up a second, PROVABLE id-collision bug of its
// own, independent of that data question: any node whose input has NO `id` at all falls back to
// `n-${count}`, and `count` is incremented on ENTRY to each node (pre-order) but the fallback id is
// read from the RETURN statement, which executes AFTER the node has recursed through its entire
// subtree. So a parent with no id and its last-visited (deepest, rightmost-DFS) descendant with no
// id are handed the IDENTICAL `n-<N>` string — anything keying on that id (assignment, closure
// rebuild, membership sweep) cannot tell the two nodes apart.
import { describe, it, expect } from "vitest";
import { sanitizeStructure, countNodes } from "./org-structure.service";

describe("sanitizeStructure — fallback id allocation", () => {
  it("FAILS before the fix: a parent with no id and its last-visited child with no id collide on the same n-<N> id", () => {
    // Root (company, forced id doesn't matter) -> dept (no id) -> role (no id, ONE child) -> person
    // (no id, no children — the last node visited in this subtree's DFS walk).
    const input = {
      root: {
        name: "Acme",
        children: [
          {
            // no id — the PARENT under test
            name: "Engineering",
            kind: "department",
            children: [
              {
                // no id — sits between the parent and the leaf so the parent's own return isn't
                // simply reading its OWN entry count (which would trivially match a childless node)
                name: "Backend",
                kind: "role",
                children: [
                  { name: "Alice", kind: "person", assigneeId: "u-alice" }, // no id — the LAST-visited leaf
                ],
              },
            ],
          },
        ],
      },
    };

    const { root } = sanitizeStructure(input);
    expect(countNodes(root)).toBe(4); // company + department + role + person

    const dept = root.children[0];
    const role = dept.children[0];
    const person = role.children[0];

    expect(dept.id, "the department (a PARENT) got a fallback id").toMatch(/^n-\d+$/);
    expect(person.id, "the person (the deepest, last-visited LEAF) got a fallback id").toMatch(/^n-\d+$/);

    // THE BUG: dept's id is allocated from `count` as it stands AFTER the whole subtree (dept ->
    // role -> person) has been walked, which is the SAME value person's own id used. Two structurally
    // different nodes — one a container, one a placed person — must never share an id.
    expect(dept.id, "a parent node's fallback id must be its OWN position in the walk, not its last descendant's").not.toBe(person.id);

    // Every fallback id across the whole tree must be unique — the general property the collision
    // violates, not just this one pair.
    const ids: string[] = [];
    (function collect(n: typeof root) {
      ids.push(n.id);
      n.children.forEach(collect);
    })(root);
    expect(new Set(ids).size, `duplicate ids in sanitized tree: ${ids.join(", ")}`).toBe(ids.length);
  });

  it("still respects an explicit id on any node, and only synthesizes n-<N> where one is missing", () => {
    const input = {
      root: {
        id: "co-1",
        name: "Acme",
        children: [
          { id: "d-eng", name: "Engineering", kind: "department", children: [
            { name: "Backend", kind: "role", children: [] }, // no id — should get its OWN synthetic id
          ] },
        ],
      },
    };
    const { root } = sanitizeStructure(input);
    expect(root.id).toBe("co-1");
    expect(root.children[0].id).toBe("d-eng");
    expect(root.children[0].children[0].id).toMatch(/^n-\d+$/);
  });

  // ── the SEPARATE `p-` defect this ticket also investigates: org-structure-refresh.ts used to
  // truncate a full uuidv7 person id to its first 8 hex characters, and uuidv7 is TIME-ORDERED, so a
  // batch of accounts created close together shares a long common prefix — the truncation collided
  // by construction, not by bad luck. That is fixed at the source in org-structure-refresh.ts
  // itself (this file has no reason to know about uuidv7). What THIS suite proves is the general
  // safety net every org-blob write now runs regardless of where a duplicate explicit id comes from.
  it("de-duplicates explicit ids reused across sibling nodes, WITHOUT moving anyone or touching their assigneeId", () => {
    const input = {
      root: {
        id: "root", name: "Gaia Digital Agency", kind: "company",
        children: [
          {
            id: "d-gm", name: "General Management", kind: "department",
            children: [
              // Four different people, the SAME truncated-style id — reproducing the live symptom
              // shape (2 distinct ids across 5 people; simplified here to one colliding id across
              // four, which is the same defect).
              { id: "p-019fb652", name: "Ayu", kind: "person", assigneeId: "u-ayu", children: [] },
              { id: "p-019fb652", name: "Budi", kind: "person", assigneeId: "u-budi", children: [] },
              { id: "p-019fb652", name: "Eka", kind: "person", assigneeId: "u-eka", children: [] },
              { id: "p-019fb652", name: "Gaiada Exec", kind: "person", assigneeId: "u-exec", children: [] },
            ],
          },
        ],
      },
    };

    const { root } = sanitizeStructure(input);
    const gm = root.children[0];
    const people = gm.children;

    expect(people).toHaveLength(4);
    const ids = people.map((p) => p.id);
    expect(new Set(ids).size, `still colliding: ${ids.join(", ")}`).toBe(4);

    // First occurrence (Ayu) keeps the contested id verbatim; the later three get a disambiguated
    // variant of the SAME base, so the id's provenance ("this used to be p-019fb652") stays legible
    // rather than being replaced by an unrelated synthetic n-<N>.
    expect(people[0].id).toBe("p-019fb652");
    for (const p of people.slice(1)) expect(p.id.startsWith("p-019fb652-dup")).toBe(true);

    // Nobody moved: all four are still under GM, in their original order, with their OWN
    // assigneeId/name/kind untouched — only the id STRING changed for the three duplicates.
    expect(gm.children.map((c) => c.name)).toEqual(["Ayu", "Budi", "Eka", "Gaiada Exec"]);
    expect(people.map((p) => p.assigneeId)).toEqual(["u-ayu", "u-budi", "u-eka", "u-exec"]);
    for (const p of people) expect(p.kind).toBe("person");
  });

  it("a wide sibling fan-out (no nested descendants) never collides even before the fix — the bug is specifically about a NON-LEAF ancestor", () => {
    const input = {
      root: {
        name: "Acme",
        children: [
          { name: "A", kind: "department", children: [] },
          { name: "B", kind: "department", children: [] },
          { name: "C", kind: "department", children: [] },
        ],
      },
    };
    const { root } = sanitizeStructure(input);
    const ids = root.children.map((c) => c.id);
    expect(new Set(ids).size).toBe(3);
  });
});
