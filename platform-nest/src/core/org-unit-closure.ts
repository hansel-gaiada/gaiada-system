// IAM-09 — the org-unit closure table: ancestor/descendant/depth over company_org_structure's
// tree, keyed on free-form TEXT node ids (0100 widened user_roles.scope_id uuid->text for exactly
// this reason: org-unit node ids are `'d-hr'`/`'dv-web'`-shaped, never uuids). Load-bearing
// prerequisite for HIER-2's org_unit_lead subtree cascade
// (docs/superpowers/plans/2026-08-10-iam-hier-01-plan.md §HIER-2): a resource carries
// `unitAncestors` = every row here where `descendant_id` = the resource's own unit node id;
// HIER-2's Cerbos condition then tests whether the caller's `org_unit`-scoped grant's `scopeId` is
// IN that list. This ticket does NOT create that role or touch Cerbos — it only builds and
// maintains the substrate HIER-2 reads.
//
// PURE COMPUTATION, I/O SEPARATED — same house pattern as this file's sibling, dept-resolution.ts
// (whose `OrgNodeForWalk` type is reused here verbatim, not re-derived, per the ticket's
// instruction not to write a second tree parser). `computeOrgUnitClosure()` takes a sanitized
// org-blob root and returns the full closure. `rebuildOrgUnitClosure()` is the only I/O: it is
// called from company-admin.controller.ts's `putOrg`, inside that handler's own
// `withTenants([tenantId], ...)` transaction, so the closure can never disagree with the tree it
// describes — a closure-write failure rolls back the blob write too.
//
// SELF-INCLUSIVE AT DEPTH 0 — a node is its own ancestor. This is deliberate, not an oversight:
// HIER-2's own Cerbos condition (`g.scopeId in request.resource.attr.unitAncestors`) must match a
// grant scoped directly AT the resource's own unit, not only at a strict ancestor above it — a
// dept lead's grant scoped at 'd-web' must cover a 'd-web' resource itself, not just resources
// nested beneath it. This mirrors person-scope.ts's `collectUnitSubtree`, which is self-inclusive
// for the identical reason (`found: string[] = [unitNodeId]`) — untouched by this ticket, kept as
// its own independent boundary, but the convention is intentionally the same shape.
//
// SCOPE OF THE CLOSURE: every node in the org-blob tree, not filtered to "department"/"division"
// kind. This is a deliberate simplification: a generic full-tree closure cannot disagree with
// kind-based filtering that lives elsewhere (person-scope.ts's `UNIT_KINDS` owns that boundary for
// the person axis and stays untouched); `org_unit`-scoped grants (0100's shape CHECK) are
// unrestricted non-empty text with no kind restriction either, so this table has no authoritative
// kind vocabulary to filter against without duplicating one that could drift from either consumer.
// Any 'role'/'person' rows that end up in an ancestor or descendant list are harmless noise: an
// `org_unit_lead` grant is only ever minted at a node someone chose to grant leadership over
// (department/division, by the role-authoring surface's own convention), so a role/person id is
// never actually present on the LEFT side of a real grant comparison.
import type { PoolClient } from "pg";
import type { OrgNodeForWalk } from "./dept-resolution";

export interface ClosureRow {
  ancestorId: string;
  descendantId: string;
  depth: number;
}

/**
 * PURE. The full ancestor/descendant/depth closure of `root`'s tree, self-inclusive (a node is
 * its own ancestor at depth 0 — see this file's header). Every node visited becomes exactly one
 * `descendantId`, paired with every node on the path from the tree's root down to it (inclusive)
 * as an `ancestorId`.
 *
 * DETERMINISTIC TIE-BREAK for a malformed tree that repeats the same id at two positions (the same
 * defensive posture 0055's backfill and `deriveBlobPlacements` take for duplicate `assigneeId`s):
 * if the same (ancestorId, descendantId) pair would otherwise be produced at two different depths,
 * the SMALLER depth (nearest) wins. A node missing a string `id` is skipped (never walked into,
 * never produces a row) — mirrors `deriveBlobPlacements`'s own defensive-shape posture; the
 * sanitizer (`company-admin.controller.ts::sanitizeStructure`) never omits an id, so this only
 * matters for a hand-crafted or pre-sanitizer legacy blob.
 */
export function computeOrgUnitClosure(root: OrgNodeForWalk): ClosureRow[] {
  const best = new Map<string, number>(); // `${ancestorId}\x00${descendantId}` -> min depth seen

  const walk = (node: OrgNodeForWalk, chainAbove: string[]): void => {
    if (!node || typeof node !== "object" || typeof node.id !== "string" || node.id === "") return;
    const path = [...chainAbove, node.id];
    const depthOfSelf = path.length - 1;
    for (let i = 0; i < path.length; i++) {
      const ancestorId = path[i];
      const depth = depthOfSelf - i;
      const key = `${ancestorId}\x00${node.id}`;
      const existing = best.get(key);
      if (existing === undefined || depth < existing) best.set(key, depth);
    }
    for (const child of node.children ?? []) walk(child, path);
  };

  walk(root, []);

  return [...best.entries()]
    .map(([key, depth]) => {
      const sep = key.indexOf("\x00");
      return { ancestorId: key.slice(0, sep), descendantId: key.slice(sep + 1), depth };
    })
    .sort((a, b) => {
      if (a.ancestorId !== b.ancestorId) return a.ancestorId < b.ancestorId ? -1 : 1;
      if (a.descendantId !== b.descendantId) return a.descendantId < b.descendantId ? -1 : 1;
      return 0;
    });
}

/**
 * I/O — rebuild ONE tenant's closure rows wholesale, inside the CALLER's transaction (the caller
 * owns `withTenants`/RLS context; this function issues plain queries on the given client, exactly
 * like `sweepMemberships` in company-admin.controller.ts, which calls this function immediately
 * after itself, in the same transaction as the org-blob write).
 *
 * DELETE-then-INSERT, not a diff. This is what makes "a node moved" and "a node deleted" trivially
 * correct: there is no incremental-update logic that can miss an affected ancestor path or leave an
 * orphaned row behind. Cost is bounded by `company-admin.controller.ts`'s own `MAX_NODES` (300) —
 * worst case a few tens of thousands of rows per tenant, recomputed on every PUT, which is cheap at
 * this scale and never a hot read path (closure READS, not this rebuild, are what HIER-2 puts on
 * the request path).
 *
 * Returns the number of rows written, so the caller (and tests) can assert the rebuild actually did
 * something rather than silently no-op — the same "assert, never assume" discipline the ticket
 * brief calls out for the backfill.
 */
export async function rebuildOrgUnitClosure(c: PoolClient, tenantId: string, root: OrgNodeForWalk): Promise<number> {
  const rows = computeOrgUnitClosure(root);

  await c.query(`DELETE FROM org_unit_closure WHERE tenant_id = $1`, [tenantId]);
  if (rows.length === 0) return 0;

  await c.query(
    `INSERT INTO org_unit_closure (tenant_id, ancestor_id, descendant_id, depth)
     SELECT $1::uuid, a, d, dep
       FROM unnest($2::text[], $3::text[], $4::int[]) AS t(a, d, dep)`,
    [tenantId, rows.map((r) => r.ancestorId), rows.map((r) => r.descendantId), rows.map((r) => r.depth)],
  );
  return rows.length;
}

/** Read helper for hot query 1 (§"what a resource carries so a grant can match"): every ancestor
 *  of `nodeId` (INCLUSIVE of itself, depth 0), nearest-first. Served by `ix_org_unit_closure_
 *  ancestors (tenant_id, descendant_id, depth)`. Returns `[]` for an unknown/orphaned node id
 *  (fail-closed: HIER-2's `scopeId in unitAncestors` then matches nothing, per its own design). */
export async function loadUnitAncestors(c: PoolClient, tenantId: string, nodeId: string): Promise<string[]> {
  const { rows } = await c.query<{ ancestor_id: string }>(
    `SELECT ancestor_id FROM org_unit_closure
      WHERE tenant_id = $1 AND descendant_id = $2
      ORDER BY depth ASC`,
    [tenantId, nodeId],
  );
  return rows.map((r) => r.ancestor_id);
}

/**
 * Every org node id THIS company owns: the answer to "is `scope_id` one of this company's units?".
 *
 * Three sources, UNIONed, because each alone is incomplete:
 *   1. the org blob (`company_org_structure.structure`) — the single placement AUTHORITY (see
 *      org-structure.service.ts's header). Walked in SQL exactly as 0101's backfill walks it, on the
 *      RAW stored ids: never through `sanitizeStructure`, whose duplicate-id repair would rename ids
 *      and so miss a grant scoped at the id actually stored. Covers blobs written by a seed that never
 *      rebuilt the closure.
 *   2. `org_unit_closure` — the blob's materialization, rebuilt in the SAME transaction as every blob
 *      write that goes through `applyOrgStructure`; every `descendant_id` is a node of the tree.
 *   3. `org_units` — the LAZILY anchored, service-assigned units (0026). A unit can stay anchored
 *      after it left the blob (status 'orphaned'), and a grant on it is still this company's.
 *
 * `org_units` ALONE was the 2026-10-14 offboarding gap: a unit never anchored there (most of them —
 * anchoring only happens on a service assignment) was not recognized as this company's, so a leaver's
 * manual org_unit grant on it was never revoked.
 *
 * ⚠ CALLER CONTRACT: `c` must be inside `withTenants([tenantId], ...)`. All three tables are FORCE RLS
 * on the authorized-tenant-set; under a bare `withGlobal` every arm returns ZERO rows with no error
 * (the RLS zero-row trap), which would read as "this company has no units".
 */
export async function loadCompanyUnitNodeIds(c: PoolClient, tenantId: string): Promise<Set<string>> {
  const { rows } = await c.query<{ node_id: string }>(
    `WITH RECURSIVE tree(node) AS (
       SELECT s.structure -> 'root' FROM company_org_structure s WHERE s.tenant_id = $1
       UNION ALL
       SELECT ch.child
         FROM tree t
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(t.node -> 'children') = 'array' THEN t.node -> 'children' ELSE '[]'::jsonb END
         ) AS ch(child)
        WHERE jsonb_typeof(t.node) = 'object'
     )
     SELECT node ->> 'id' AS node_id FROM tree
      WHERE jsonb_typeof(node) = 'object' AND jsonb_typeof(node -> 'id') = 'string' AND node ->> 'id' <> ''
     UNION
     SELECT descendant_id FROM org_unit_closure WHERE tenant_id = $1
     UNION
     SELECT node_id FROM org_units WHERE tenant_id = $1`,
    [tenantId],
  );
  return new Set(rows.map((r) => r.node_id));
}

/** Read helper for hot query 2 ("all descendants of node N"): every descendant of `nodeId`
 *  (INCLUSIVE of itself, depth 0), nearest-first. Served by the table's PRIMARY KEY leftmost
 *  prefix `(tenant_id, ancestor_id, descendant_id)` — no separate index needed. */
export async function loadUnitDescendants(c: PoolClient, tenantId: string, nodeId: string): Promise<string[]> {
  const { rows } = await c.query<{ descendant_id: string }>(
    `SELECT descendant_id FROM org_unit_closure
      WHERE tenant_id = $1 AND ancestor_id = $2
      ORDER BY depth ASC`,
    [tenantId, nodeId],
  );
  return rows.map((r) => r.descendant_id);
}
