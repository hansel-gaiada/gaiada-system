// Learning scope (DW-4f): which org nodes make up "a department's courses". Pure — no fetch, no
// server-only — so the catalogue page and its tests share one rule.
//
// A department's courses may sit on the department node itself or on any division/role beneath it,
// so the filter is the node's whole SUBTREE. (The backend's `unitNodeId=` filter matches ONE exact
// node, which is why the page filters instead.)
import type { OrgNode, OrgStructure } from "./org";

/** The node and every descendant (any kind); `null` when the node is not in the tree. */
export function unitSubtree(structure: OrgStructure, nodeId: string): { name: string; ids: Set<string> } | null {
  const find = (node: OrgNode): OrgNode | null => {
    if (node.id === nodeId) return node;
    for (const child of node.children) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  };
  const start = find(structure.root);
  if (!start) return null;
  const ids = new Set<string>();
  const collect = (node: OrgNode): void => {
    ids.add(node.id);
    node.children.forEach(collect);
  };
  collect(start);
  return { name: start.name, ids };
}

/** Items placed on one of the given units. An item with no unit (`null`, the general track) is dropped. */
export function inUnit<T extends { unitNodeId: string | null }>(items: T[], ids: Set<string>): T[] {
  return items.filter((i) => i.unitNodeId !== null && ids.has(i.unitNodeId));
}
