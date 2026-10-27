// SCP-1r and SCP-1s (plan decision SCP-D7, applying owner ruling SCP-Q23; docs/PERMISSION-CONTRACT.md §53.4) -- the unit self-edit guard.
//
// THE RULE. Nobody may rename, re-type or move (re-parent) an org unit on which they hold a live lead seat, and nobody may delete
// one (SCP-1r). Nor may they move another unit INTO the subtree of a unit they hold a live lead seat on (SCP-1s): a lead's reach is
// the unit and everything under it (the DW-4 subtree reach, `collectUnitSubtree`), so re-parenting a unit or a person under the unit
// you lead hands you that unit's people. It holds for company_admin and superadmin alike: another administrator makes the change.
//
// WHY. Authority keyed by unit NAME. The four social approvers' Social Media and GM units are found by name and kind in the
// company's org tree (`socialApproverUnitIds`, `gmUnitIds`: department nodes whose name resolves to a workspace slug), and their
// holders are the live lead seats on those nodes. A company admin who leads some other unit could rename it "Social Media" (or
// re-type it so it reads as the GM unit) through the org-structure edit and become an approver alone, seat unchanged. SCP-1q shut the
// same door on the position side (nobody edits a position they hold); this shuts it on the unit side, for every unit-name-keyed
// authority at once.
//
// THE MECHANISM. `org_structure` · `update` carries an EFFECT_DENY (resource_org_structure.yaml) fed `touchedLeadHolderIds`: the
// live lead-seat holders of every unit the submitted tree touches. This file computes that list, from the STORED tree and the seat
// rows, never from the body. Two halves, so the diff is unit-testable without a database:
//   - `touchedUnitIds`        PURE   the node ids whose name, kind or parent changed, or which the new tree removes, and (SCP-1s) the
//                                    units a moved node newly sits under;
//   - `loadTouchedLeadHolderIds` I/O the §50 seat holders of those ids (`loadSeatHoldersByNode`, the ONE seat rule DW-10g-2 and the
//                                    social approvers read; not a second copy of it).
//
// WHAT COUNTS AS TOUCHED (by node id, against the stored tree, both sides run through `sanitizeStructure` so a legacy `team` kind, an
// untrimmed name or a duplicate id cannot show as a change that is not one):
//   - a node of the stored tree whose `name` differs in the new tree;
//   - a node whose `kind` differs (a department turned into a division, or the reverse);
//   - a node whose parent differs (re-parented; also an id whose node moved to a different parent);
//   - a node of the stored tree that is absent from the new tree (deleted, alone or inside a deleted subtree, or its id replaced).
//   - (SCP-1s) for each node whose parent changed, every unit of the stored tree that sits ABOVE it in its NEW position and did not
//     sit above it before: the parent it was moved under and that parent's own ancestors, less the ones it already was under. So the
//     lead of any unit it newly joins is a toucher of the move, and the same DENY fires. A move inside a subtree the node already
//     belonged to adds no ancestor (the lead's reach did not change), and a move out of a subtree adds none of it. Every node kind
//     moves under this rule, a person node included: placing a person under your unit is the other way to take their reach.
// Every node kind is considered, not only department/division: a seat names a `unit_node_id` and nothing stops it pointing at any
// node, so the seat lookup is what narrows the list, never a kind filter that a re-type could dodge. A NEW node (an id the stored
// tree lacks) touches nothing: it has no seat, and a seat cannot be put on it by the person who would gain from it (SCP-1q's
// position self-edit DENY and the `assign` self-DENY). Re-ordering siblings, changing an assignee, adding children and editing a
// unit the person does not lead are not touched. With no stored tree (a first write) nothing is touched.
import type { PoolClient } from "pg";
import { loadSeatHoldersByNode } from "../modules/reports/person-scope";
import { loadOrgStructure, type OrgNode, type OrgStructure } from "./org-structure.service";

interface FlatNode {
  name: string;
  kind: string;
  parentId: string | null;
}

function flatten(root: OrgNode): Map<string, FlatNode> {
  const out = new Map<string, FlatNode>();
  const walk = (n: OrgNode, parentId: string | null) => {
    // First seen wins, as `sanitizeStructure` already guarantees ids are unique within a tree.
    if (!out.has(n.id)) out.set(n.id, { name: n.name, kind: n.kind, parentId });
    for (const c of n.children) walk(c, n.id);
  };
  walk(root, null);
  return out;
}

/** The ids above `id` in `flat`, nearest first (its parent, then the parent's parent, up to the root). Stops at a repeat, so a malformed tree cannot loop. */
function ancestorsOf(flat: Map<string, FlatNode>, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  for (let at = flat.get(id)?.parentId ?? null; at !== null && !seen.has(at); at = flat.get(at)?.parentId ?? null) {
    out.push(at);
    seen.add(at);
  }
  return out;
}

/** PURE. The ids of the stored tree's nodes that `next` renames, re-types, moves or removes, and (SCP-1s) the units a moved node newly sits under, sorted. `stored` null (nothing stored
 *  yet) touches nothing. Both trees must already be sanitized (`loadOrgStructure` and `sanitizeStructure` both are). */
export function touchedUnitIds(stored: OrgStructure | null, next: OrgStructure): string[] {
  if (!stored) return [];
  const before = flatten(stored.root);
  const after = flatten(next.root);
  const out = new Set<string>();
  for (const [id, b] of before) {
    const a = after.get(id);
    if (!a || a.name !== b.name || a.kind !== b.kind || a.parentId !== b.parentId) out.add(id);
    // SCP-1s: a node whose parent changed also touches every unit it newly sits under (not a unit it was already under, and only a unit the
    // stored tree has: a node the new tree adds has no seat).
    if (a && a.parentId !== b.parentId) {
      const were = new Set(ancestorsOf(before, id));
      for (const anc of ancestorsOf(after, id)) if (!were.has(anc) && before.has(anc)) out.add(anc);
    }
  }
  return [...out].sort();
}

/**
 * I/O. The live lead-seat holders (user ids, lower-case, sorted and distinct) of every unit `next` touches, read on the caller's
 * client: the caller's `withTenants([tenantId])` transaction, which has locked the stored row, so the diff and the write cannot
 * be separated by a concurrent edit. `next` is the sanitized submitted tree. [] when nothing is touched or no touched unit has a live lead seat.
 */
export async function loadTouchedLeadHolderIds(c: PoolClient, tenantId: string, next: OrgStructure): Promise<string[]> {
  const touched = touchedUnitIds(await loadOrgStructure(c, tenantId), next);
  if (touched.length === 0) return [];
  const ids = new Set<string>();
  for (const holders of (await loadSeatHoldersByNode(c, tenantId, touched)).values()) for (const id of holders) ids.add(id.toLowerCase());
  return [...ids].sort();
}
