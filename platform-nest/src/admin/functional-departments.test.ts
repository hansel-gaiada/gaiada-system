// DW-7d: the pure rule that puts HR, Finance and IT into a company's org tree (owner ruling DW-D6).
// Node ids are per company (the full tenant uuid), so no two companies ever share a department node.
import { describe, it, expect } from "vitest";
import { sanitizeStructure } from "./org-structure.service";
import {
  FUNCTIONAL_DEPARTMENTS, ensureFunctionalDepartments, functionalNodeId, legacyFunctionalNodeId,
  resolveFunctionalNodeId, startingOrgStructure,
} from "./functional-departments";

const T = "0192f3a0-1111-7000-8000-000000000001";
const T2 = "0192f3a0-1111-7000-8000-000000000002";
const HR = functionalNodeId("hr", T);
const FIN = functionalNodeId("finance", T);
const IT = functionalNodeId("it", T);

interface N { id: string; name: string; kind: string; children: N[]; assigneeId?: string | null }
const n = (id: string, name: string, kind: string, children: N[] = []): N => ({ id, name, kind, children });
const tree = (...children: N[]) => ({ root: n("root", "Acme", "company", children) });
const ids = (s: { root: N }): string[] => {
  const out: string[] = [];
  const walk = (x: N) => { out.push(x.id); x.children.forEach(walk); };
  walk(s.root);
  return out;
};

describe("functionalNodeId", () => {
  it("embeds the FULL tenant id, and differs per company", () => {
    expect(HR).toBe(`d-hr-${T}`);
    expect(functionalNodeId("hr", T2)).not.toBe(HR);
    expect(legacyFunctionalNodeId("hr")).toBe("d-hr");
  });
});

describe("ensureFunctionalDepartments", () => {
  it("adds all three, at the end of the root's children, to a tree with none", () => {
    const base = tree(n("d-web", "Web Dev", "department"), n("d-gm", "GM", "department"));
    const r = ensureFunctionalDepartments(base, T);
    expect(r.added).toEqual([HR, FIN, IT]);
    expect(r.conflicts).toEqual([]);
    expect(r.structure.root.children.map((c) => c.id)).toEqual(["d-web", "d-gm", HR, FIN, IT]);
    expect(r.structure.root.children.slice(2)).toEqual([
      { id: HR, name: "HR", kind: "department", children: [] },
      { id: FIN, name: "Finance", kind: "department", children: [] },
      { id: IT, name: "IT", kind: "department", children: [] },
    ]);
    expect(r.existing).toEqual([{ id: "d-web", name: "Web Dev" }, { id: "d-gm", name: "GM" }]);
  });

  it("adds none when this company's own ids are present", () => {
    const r = ensureFunctionalDepartments(
      tree(n(HR, "HR", "department"), n(FIN, "Finance", "department"), n(IT, "IT", "department")), T);
    expect(r.added).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });

  it("treats a legacy plain-id department with the matching name as present", () => {
    const r = ensureFunctionalDepartments(
      tree(n("d-hr", "HR", "department"), n("d-it", "IT", "department")), T);
    expect(r.added).toEqual([FIN]);
    expect(r.conflicts).toEqual([]);
    expect(ids(r.structure)).not.toContain(HR);
  });

  it("adds none for a department of that name under another id, case and spacing included", () => {
    const r = ensureFunctionalDepartments(
      tree(n("x1", "hr", "department"), n("x2", "Finance ", "department"), n("x3", "IT", "department")), T);
    expect(r.added).toEqual([]);
    expect(r.conflicts).toEqual([]);
    expect(r.existing.map((d) => d.name)).toEqual(["hr", "Finance ", "IT"]);
  });

  it("a division holding the legacy or own id is a conflict, and nothing is added for that slug", () => {
    const legacy = ensureFunctionalDepartments(tree(n("d-hr", "People", "division")), T);
    expect(legacy.added).toEqual([FIN, IT]);
    expect(legacy.conflicts).toHaveLength(1);
    expect(legacy.conflicts[0].id).toBe("d-hr");
    const own = ensureFunctionalDepartments(tree(n(HR, "HR", "division")), T);
    expect(own.added).toEqual([FIN, IT]);
    expect(own.conflicts.map((c) => c.id)).toEqual([HR]);
  });

  it("a department holding the legacy id under a different name is a conflict", () => {
    const r = ensureFunctionalDepartments(tree(n("d-it", "Infrastructure", "department")), T);
    expect(r.conflicts.map((c) => c.id)).toEqual(["d-it"]);
    expect(r.added).toEqual([HR, FIN]);
  });

  it('"Human Resources" is not HR: HR is added and it is listed in existing', () => {
    const r = ensureFunctionalDepartments(tree(n("d-people", "Human Resources", "department")), T);
    expect(r.added).toContain(HR);
    expect(r.existing).toEqual([{ id: "d-people", name: "Human Resources" }]);
  });

  it("does not mutate its input and leaves every other node deep-equal", () => {
    const base = tree(n("d-web", "Web Dev", "department", [n("v1", "Web", "division", [n("p1", "Ann", "person")])]));
    const frozen = JSON.parse(JSON.stringify(base));
    const r = ensureFunctionalDepartments(base, T);
    expect(base).toEqual(frozen);
    expect(r.structure).not.toBe(base);
    expect(r.structure.root.children[0]).toEqual(frozen.root.children[0]);
    expect(r.structure.root.name).toBe("Acme");
  });

  it("is idempotent", () => {
    const once = ensureFunctionalDepartments(tree(), T);
    const twice = ensureFunctionalDepartments(once.structure, T);
    expect(twice.added).toEqual([]);
    expect(twice.structure).toEqual(once.structure);
  });

  it("two companies never get the same node id for the same department", () => {
    const a = ensureFunctionalDepartments(tree(), T);
    const b = ensureFunctionalDepartments(tree(), T2);
    for (const id of a.added) expect(b.added).not.toContain(id);
  });
});

describe("resolveFunctionalNodeId", () => {
  it("prefers the company's own id, then a matching legacy id, then any department of that slug", () => {
    expect(resolveFunctionalNodeId(tree(n(HR, "HR", "department")), "hr", T)).toBe(HR);
    expect(resolveFunctionalNodeId(tree(n("d-hr", "HR", "department")), "hr", T)).toBe("d-hr");
    expect(resolveFunctionalNodeId(tree(n("x9", "hr", "department")), "hr", T)).toBe("x9");
    expect(resolveFunctionalNodeId(tree(n("d-hr", "People", "division")), "hr", T)).toBeNull();
  });
});

describe("startingOrgStructure", () => {
  it("is exactly what sanitizeStructure returns, with the three departments", () => {
    const s = startingOrgStructure("  Acme Holdings ", T);
    expect(s.root.name).toBe("Acme Holdings");
    expect(s.root.kind).toBe("company");
    expect(s.root.id).toBe("root");
    expect(s.root.children.map((c) => [c.id, c.name, c.kind])).toEqual(
      FUNCTIONAL_DEPARTMENTS.map((f) => [functionalNodeId(f.slug, T), f.name, "department"]),
    );
    expect(sanitizeStructure(s)).toEqual(s);
    expect(ensureFunctionalDepartments(s, T).added).toEqual([]);
  });
});
