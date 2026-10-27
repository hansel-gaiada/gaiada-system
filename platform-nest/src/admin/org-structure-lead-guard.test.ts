// SCP-1r and SCP-1s (SCP-D7) -- the PURE half of the unit self-edit guard: which stored nodes does a submitted tree touch? Runs everywhere
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

describe("SCP-1r and SCP-1s touchedUnitIds -- what counts as touching a unit", () => {
  it("an identical tree touches nothing", () => {
    expect(touched(() => {})).toEqual([]);
  });

  it("a rename touches that unit and no other", () => {
    expect(touched((r) => { find(r, "d-web")!.name = "Social Media"; })).toEqual(["d-web"]);
  });

  it("a re-type touches that unit (a division read as a department, the GM trick)", () => {
    expect(touched((r) => { find(r, "d-social")!.kind = "department"; })).toEqual(["d-social"]);
  });

  it("a move (re-parent) touches the moved unit and the unit it moves under (SCP-1s), not the units it moves among or the root it stays under", () => {
    expect(
      touched((r) => {
        const web = find(r, "d-web")!;
        parentOf(r, "d-web")!.children = parentOf(r, "d-web")!.children!.filter((c) => c.id !== "d-web");
        find(r, "d-mkt")!.children!.push(web);
      }),
    ).toEqual(["d-mkt", "d-web"]);
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

  it("a person node moved between units touches the person node and the unit it now sits under, not the unit it left", () => {
    expect(
      touched((r) => {
        const web = find(r, "d-web")!;
        const p = web.children!.pop()!;
        find(r, "d-gm")!.children!.push(p);
      }),
    ).toEqual(["d-gm", "p-1"]);
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

describe("SCP-1s touchedUnitIds -- moving a unit into a subtree touches every unit above it in its new place", () => {
  const deep = (): N =>
    n("root", "Acme", "company", [
      n("d-gm", "GM", "department"),
      n("d-mkt", "Marketing", "department", [
        n("d-social", "Social Media", "division", [n("dv-a", "A", "division", [n("p-a", "Ayu", "person")])]),
        n("d-creatives", "Creatives", "division"),
      ]),
      n("d-web", "Web Dev", "department", [n("dv-w", "Frontend", "division")]),
    ]);
  const moved = (edit: (root: N) => void): string[] => {
    const next = deep();
    edit(next);
    return touchedUnitIds(S(deep()), S(next));
  };
  /** Take `id` out of the tree and put it under `under`. */
  const reparent = (root: N, id: string, under: string): void => {
    const p = parentOf(root, id)!;
    const node = find(root, id)!;
    p.children = p.children!.filter((c) => c.id !== id);
    find(root, under)!.children!.push(node);
  };

  it("a unit moved under Web Dev touches the unit and Web Dev, and nothing above Web Dev", () => {
    expect(moved((r) => reparent(r, "d-creatives", "d-web"))).toEqual(["d-creatives", "d-web"]);
  });

  it("a unit moved DEEP into a subtree touches every unit above it in the new place that it was not already under", () => {
    // d-creatives goes under dv-a, itself under d-social under d-mkt: it already sat under d-mkt, so d-mkt (and the root) are not new.
    expect(moved((r) => reparent(r, "d-creatives", "dv-a"))).toEqual(["d-creatives", "d-social", "dv-a"]);
    // dv-w goes from Web Dev to under dv-a: the whole chain of Social Media above it is new, Web Dev is left behind.
    expect(moved((r) => reparent(r, "dv-w", "dv-a"))).toEqual(["d-mkt", "d-social", "dv-a", "dv-w"]);
  });

  it("a move inside a subtree the unit already belongs to adds no ancestor: the lead's reach did not change", () => {
    expect(moved((r) => reparent(r, "dv-a", "d-creatives"))).toEqual(["d-creatives", "dv-a"]);
    expect(moved((r) => reparent(r, "p-a", "d-social"))).toEqual(["p-a"]);
  });

  it("a move OUT of a subtree touches the moved unit and the unit it joins, never the one it left", () => {
    expect(moved((r) => reparent(r, "dv-a", "d-gm"))).toEqual(["d-gm", "dv-a"]);
  });

  it("moving a unit up to the top (under the root) adds no ancestor: the root was above it before", () => {
    expect(moved((r) => reparent(r, "dv-a", "root"))).toEqual(["dv-a"]);
  });

  it("a person moved under a unit touches that unit (placing someone under your unit is the other way to take their reach)", () => {
    expect(moved((r) => reparent(r, "p-a", "d-web"))).toEqual(["d-web", "p-a"]);
  });

  it("a unit that is NEW in the submitted tree, and a node moved under a NEW unit, add no unit that has no seat to look up", () => {
    // d-creatives moves under a brand-new unit nested under Web Dev: the new unit has no stored seat, Web Dev does.
    expect(moved((r) => { find(r, "d-web")!.children!.push(n("d-new", "New", "division")); reparent(r, "d-creatives", "d-new"); }))
      .toEqual(["d-creatives", "d-web"]);
  });

  it("several moves in one edit: the touched set is the union of each move's new ancestors", () => {
    expect(moved((r) => { reparent(r, "d-creatives", "d-web"); reparent(r, "dv-w", "d-gm"); })).toEqual(["d-creatives", "d-gm", "d-web", "dv-w"]);
  });

  it("a rename or re-type alone adds no ancestor (the parent is unchanged)", () => {
    expect(moved((r) => { find(r, "dv-a")!.name = "Renamed"; })).toEqual(["dv-a"]);
  });
});

