// SCP-1r (SCP-D7) -- the PURE half of the unit self-edit guard: which stored nodes does a submitted tree touch? Runs everywhere
// (no database). The seat lookup and the decision are driven end to end in org-structure-self-edit.test.ts.
import { describe, it, expect } from "vitest";
import { sanitizeStructure, type OrgStructure } from "./org-structure.service";
import { touchedUnitIds } from "./org-structure-lead-guard";

type N = { id: string; name: string; kind: string; assigneeId?: string | null; assigneeName?: string | null; children?: N[] };
const n = (id: string, name: string, kind: string, children: N[] = [], extra: Partial<N> = {}): N => ({
  id, name, kind, assigneeId: null, assigneeName: null, children, ...extra,
});

/** The fixture tree, built fresh each call so a test can mutate its copy. */
const tree = (): N =>
  n("root", "Acme", "company", [
    n("d-gm", "GM", "department"),
    n("d-mkt", "Marketing", "department", [n("d-social", "Social Media", "division"), n("d-creatives", "Creatives", "division")]),
    n("d-web", "Web Dev", "department", [n("p-1", "Ayu", "person", [], { assigneeId: "u1", assigneeName: "Ayu" })]),
  ]);
const S = (root: N): OrgStructure => sanitizeStructure({ root });
const find = (root: N, id: string): N | null => {
  if (root.id === id) return root;
  for (const c of root.children ?? []) {
    const f = find(c, id);
    if (f) return f;
  }
  return null;
};
const parentOf = (root: N, id: string): N | null => {
  for (const c of root.children ?? []) {
    if (c.id === id) return root;
    const f = parentOf(c, id);
    if (f) return f;
  }
  return null;
};
const touched = (edit: (root: N) => void): string[] => {
  const next = tree();
  edit(next);
  return touchedUnitIds(S(tree()), S(next));
};

describe("SCP-1r touchedUnitIds -- what counts as touching a unit", () => {
  it("an identical tree touches nothing", () => {
    expect(touched(() => {})).toEqual([]);
  });

  it("a rename touches that unit and no other", () => {
    expect(touched((r) => { find(r, "d-web")!.name = "Social Media"; })).toEqual(["d-web"]);
  });

  it("a re-type touches that unit (a division read as a department, the GM trick)", () => {
    expect(touched((r) => { find(r, "d-social")!.kind = "department"; })).toEqual(["d-social"]);
  });

  it("a move (re-parent) touches the moved unit, not the units it moves among", () => {
    expect(
      touched((r) => {
        const web = find(r, "d-web")!;
        parentOf(r, "d-web")!.children = parentOf(r, "d-web")!.children!.filter((c) => c.id !== "d-web");
        find(r, "d-mkt")!.children!.push(web);
      }),
    ).toEqual(["d-web"]);
  });

  it("a deletion touches the removed unit AND every unit inside the removed subtree", () => {
    expect(touched((r) => { r.children = r.children!.filter((c) => c.id !== "d-mkt"); })).toEqual(["d-creatives", "d-mkt", "d-social"]);
  });

  it("replacing a unit's id (delete one node, add another) touches the old id, and what hung under it (its parent changed)", () => {
    expect(touched((r) => { find(r, "d-web")!.id = "d-web-2"; })).toEqual(["d-web", "p-1"]);
  });

  it("swapping two units' ids is a rename of both (and moves what hung under one), so all of them are touched", () => {
    expect(
      touched((r) => {
        find(r, "d-web")!.id = "tmp";
        find(r, "d-gm")!.id = "d-web";
        find(r, "tmp")!.id = "d-gm";
      }),
    ).toEqual(["d-gm", "d-web", "p-1"]);
  });

  it("a NEW unit touches nothing (it has no seat), even one named like an approver unit", () => {
    expect(touched((r) => { find(r, "d-web")!.children!.push(n("d-new", "Social Media", "department")); })).toEqual([]);
  });

  it("re-ordering siblings, changing an assignee and adding a child under a unit touch nothing", () => {
    expect(touched((r) => { r.children!.reverse(); })).toEqual([]);
    expect(touched((r) => { Object.assign(find(r, "p-1")!, { assigneeId: "u2", assigneeName: "Bagus" }); })).toEqual([]);
    expect(touched((r) => { find(r, "d-web")!.children!.push(n("dv-x", "Frontend", "division")); })).toEqual([]);
  });

  it("a person node moved between units touches the person node only", () => {
    expect(
      touched((r) => {
        const web = find(r, "d-web")!;
        const p = web.children!.pop()!;
        find(r, "d-gm")!.children!.push(p);
      }),
    ).toEqual(["p-1"]);
  });

  it("is blind to normalisation noise: an untrimmed name and a legacy `team` kind are not changes", () => {
    const stored = S(tree());
    const next = tree();
    find(next, "d-web")!.name = "  Web Dev  ";
    // The stored tree holds a legacy `team` that the sanitizer reads as `division`; the new tree already says `division`.
    const legacy = tree();
    find(legacy, "d-social")!.kind = "team";
    expect(touchedUnitIds(S(legacy), S(tree()))).toEqual([]);
    expect(touchedUnitIds(stored, S(next))).toEqual([]);
  });

  it("a case change in a name is a rename", () => {
    expect(touched((r) => { find(r, "d-gm")!.name = "gm"; })).toEqual(["d-gm"]);
  });

  it("nothing stored yet (a first write) touches nothing", () => {
    expect(touchedUnitIds(null, S(tree()))).toEqual([]);
  });

  it("the root counts too: renaming it touches it; replacing its id touches it and its children (their parent changed)", () => {
    expect(touched((r) => { r.name = "Other Co"; })).toEqual(["root"]);
    expect(touched((r) => { r.id = "root-2"; })).toEqual(["d-gm", "d-mkt", "d-web", "root"]);
  });
});
