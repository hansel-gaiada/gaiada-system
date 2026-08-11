// IAM-09 — pure unit tests for computeOrgUnitClosure. No database, no skipIf: these must always
// run (same posture as dept-resolution.test.ts).
import { describe, it, expect } from "vitest";
import { computeOrgUnitClosure, type ClosureRow } from "./org-unit-closure";
import type { OrgNodeForWalk } from "./dept-resolution";

const node = (id: string, children: OrgNodeForWalk[] = [], kind = "role"): OrgNodeForWalk => ({
  id,
  kind,
  children,
});

const sort = (rows: ClosureRow[]) =>
  [...rows].sort((a, b) => (a.ancestorId + "\0" + a.descendantId).localeCompare(b.ancestorId + "\0" + b.descendantId));

describe("computeOrgUnitClosure", () => {
  it("a single node is its own ancestor at depth 0, and nothing else", () => {
    const tree = node("root");
    expect(computeOrgUnitClosure(tree)).toEqual([{ ancestorId: "root", descendantId: "root", depth: 0 }]);
  });

  it("every node is its own ancestor at depth 0 (self-inclusive) in a deeper tree", () => {
    const tree = node("root", [node("d1", [node("d1-1", [node("r1", [node("p1")])])])]);
    const rows = computeOrgUnitClosure(tree);
    for (const id of ["root", "d1", "d1-1", "r1", "p1"]) {
      expect(rows).toContainEqual({ ancestorId: id, descendantId: id, depth: 0 });
    }
  });

  it("computes the full ancestor chain for a nested node, nearest ancestor at depth 1", () => {
    const tree = node("root", [node("d1", [node("d1-1", [node("r1", [node("p1")])])])]);
    const rows = computeOrgUnitClosure(tree);
    const ancestorsOfP1 = rows.filter((r) => r.descendantId === "p1").sort((a, b) => a.depth - b.depth);
    expect(ancestorsOfP1).toEqual([
      { ancestorId: "p1", descendantId: "p1", depth: 0 },
      { ancestorId: "r1", descendantId: "p1", depth: 1 },
      { ancestorId: "d1-1", descendantId: "p1", depth: 2 },
      { ancestorId: "d1", descendantId: "p1", depth: 3 },
      { ancestorId: "root", descendantId: "p1", depth: 4 },
    ]);
  });

  it("computes every descendant of an internal node, including itself", () => {
    const tree = node("root", [
      node("d1", [node("d1-1"), node("d1-2")]),
      node("d2"),
    ]);
    const rows = computeOrgUnitClosure(tree);
    const descendantsOfD1 = rows.filter((r) => r.ancestorId === "d1").map((r) => r.descendantId).sort();
    expect(descendantsOfD1).toEqual(["d1", "d1-1", "d1-2"]);
    // d2 and root are NOT descendants of d1.
    expect(descendantsOfD1).not.toContain("d2");
    expect(descendantsOfD1).not.toContain("root");
  });

  it("a leaf's only descendant is itself", () => {
    const tree = node("root", [node("d1", [node("leaf")])]);
    const rows = computeOrgUnitClosure(tree);
    expect(rows.filter((r) => r.ancestorId === "leaf").map((r) => r.descendantId)).toEqual(["leaf"]);
  });

  it("a sibling subtree is neither an ancestor nor a descendant of another sibling", () => {
    const tree = node("root", [node("d1", [node("d1-1")]), node("d2", [node("d2-1")])]);
    const rows = computeOrgUnitClosure(tree);
    expect(rows.find((r) => r.ancestorId === "d1" && r.descendantId === "d2-1")).toBeUndefined();
    expect(rows.find((r) => r.ancestorId === "d2" && r.descendantId === "d1-1")).toBeUndefined();
  });

  it("row count for a chain of length N is N*(N+1)/2 (triangular — every prefix pair once)", () => {
    // root -> a -> b -> c: 4 nodes in a straight line.
    const tree = node("root", [node("a", [node("b", [node("c")])])]);
    const rows = computeOrgUnitClosure(tree);
    expect(rows.length).toBe((4 * 5) / 2); // 10
  });

  it("wide trees: total row count is the sum over each node of (its own depth + 1)", () => {
    const tree = node("root", [node("d1"), node("d2"), node("d3")]);
    // root: depth0 contributes 1 row; each of d1/d2/d3: depth1 contributes 2 rows (self + root).
    const rows = computeOrgUnitClosure(tree);
    expect(rows.length).toBe(1 + 2 + 2 + 2);
  });

  it("duplicate ids in a malformed tree: the NEAREST (smallest-depth) relationship wins deterministically", () => {
    // 'dup' appears twice: once as a direct child of root (depth 1 from root), and again nested
    // three levels deeper under a DIFFERENT branch also named 'dup' at the shallow position —
    // simplest reproduction: the same id id "x" appears both as root's direct child AND as that
    // child's own nested grandchild.
    const tree = node("root", [node("x", [node("y", [node("x")])])]);
    const rows = computeOrgUnitClosure(tree);
    // (root, x) must appear exactly once, and since 'x' is visited at depth 1 (direct child) as
    // well as depth 3 (nested), the row for (root, x) must record the SMALLER depth (1), not 3 —
    // deterministic nearest-wins tie-break, matching the migration backfill's MIN(depth) GROUP BY.
    const rootToX = rows.filter((r) => r.ancestorId === "root" && r.descendantId === "x");
    expect(rootToX).toHaveLength(1);
    expect(rootToX[0].depth).toBe(1);
  });

  it("a node with no string id is skipped defensively (never walked into, produces no row)", () => {
    const malformed = {
      id: "root",
      kind: "company",
      children: [{ id: undefined as unknown as string, kind: "role", children: [{ id: "orphan-child", kind: "role", children: [] }] }],
    } as OrgNodeForWalk;
    const rows = computeOrgUnitClosure(malformed);
    expect(rows.find((r) => r.descendantId === "orphan-child")).toBeUndefined();
    expect(rows).toEqual([{ ancestorId: "root", descendantId: "root", depth: 0 }]);
  });

  it("is deterministic: two calls on the same tree produce byte-identical (sorted) output", () => {
    const tree = node("root", [node("d1", [node("d1-1")]), node("d2")]);
    expect(sort(computeOrgUnitClosure(tree))).toEqual(sort(computeOrgUnitClosure(tree)));
  });

  it("output is pre-sorted by (ancestorId, descendantId)", () => {
    const tree = node("root", [node("d2"), node("d1")]);
    const rows = computeOrgUnitClosure(tree);
    const keys = rows.map((r) => `${r.ancestorId}\0${r.descendantId}`);
    expect(keys).toEqual([...keys].sort());
  });
});
