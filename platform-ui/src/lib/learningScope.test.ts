import { describe, it, expect } from "vitest";
import { unitSubtree, inUnit } from "./learningScope";
import type { OrgNode, OrgStructure } from "./org";

const n = (id: string, name: string, kind: OrgNode["kind"], children: OrgNode[] = []): OrgNode => ({ id, name, kind, children });
const structure: OrgStructure = {
  root: n("root", "Acme", "company", [
    n("dept-1", "Web Dev", "department", [
      n("dept-1-div-1", "Frontend", "division", [n("r1", "Senior", "role", [n("p1", "Made", "person")])]),
      n("dept-1-div-2", "Backend", "division"),
    ]),
    n("dept-2", "Creatives", "department"),
  ]),
};

describe("unitSubtree", () => {
  it("a department includes itself, its divisions and everything beneath", () => {
    const s = unitSubtree(structure, "dept-1")!;
    expect(s.name).toBe("Web Dev");
    expect([...s.ids].sort()).toEqual(["dept-1", "dept-1-div-1", "dept-1-div-2", "p1", "r1"]);
  });
  it("a leaf is just itself", () => {
    expect([...unitSubtree(structure, "dept-2")!.ids]).toEqual(["dept-2"]);
  });
  it("a division does not reach its parent or siblings", () => {
    const s = unitSubtree(structure, "dept-1-div-2")!;
    expect([...s.ids]).toEqual(["dept-1-div-2"]);
  });
  it("an unknown id is null", () => {
    expect(unitSubtree(structure, "nope")).toBeNull();
  });
});

describe("inUnit", () => {
  it("keeps items on the unit set and drops null and other units", () => {
    const ids = unitSubtree(structure, "dept-1")!.ids;
    const items = [
      { id: "a", unitNodeId: "dept-1" },
      { id: "b", unitNodeId: "dept-1-div-2" },
      { id: "c", unitNodeId: null },
      { id: "d", unitNodeId: "dept-2" },
    ];
    expect(inUnit(items, ids).map((i) => i.id)).toEqual(["a", "b"]);
  });
});
