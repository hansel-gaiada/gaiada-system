// P2-06 — THE org-structure write pipeline, extracted so there is exactly ONE implementation.
//
// Design: docs/superpowers/plans/2026-08-13-iam-phase2-design.md §4.2 ("Placement: one authority,
// no second hierarchy"). The org blob remains the single placement authority: `sweepMemberships()`
// derives `org_unit_memberships` from the blob's person nodes on every write, so **any flow that
// moves a person must move their blob person node through this same pipeline**. A transfer that
// only touched `position_assignments` would be silently reverted by the next org PUT's sweep —
// that IS the stale-mover defect, reintroduced through the side door.
//
// Before this file, the pipeline (sanitize → persist → sweep → closure rebuild → emit) lived
// inline in `company-admin.controller.ts::putOrg`. The JML flows in `employees.controller.ts` are
// the second caller, so the pipeline moved here verbatim and `putOrg` now calls it. Both callers
// therefore run byte-identical logic — `org-structure-single-implementation.test.ts` asserts that
// the controller holds no second copy, because "two callers of one implementation" is a property
// that decays the moment someone re-inlines a step.
//
// ⚠ The person-node helpers (`upsertPersonNode`/`removePersonNode`) are the ONLY sanctioned way a
// non-PUT flow may edit the blob. They operate on a sanitized structure and hand it straight back
// to `applyOrgStructure()`, so a JML flow can never persist a shape the PUT path would reject.
import type { PoolClient } from "pg";
import { config } from "../config";
import {
  deriveBlobPlacements, diffMembershipSweep, isUuidShaped, todayIso,
  type BlobPlacement, type OpenPrimaryMembership,
} from "../core/dept-resolution";
import { rebuildOrgUnitClosure } from "../core/org-unit-closure";
import { emitEvent } from "../events/outbox.service";

// ---- Org-structure types + sanitizer (mirror platform-ui/src/lib/org.ts) ----
// Canonical depth: holding → company → department → division → role → person.
// Legacy "team" nodes are migrated to "division" on read/write.
const ORG_KINDS = new Set(["holding", "company", "department", "division", "role", "person"]);
const MAX_NODES = 300;
const MAX_DEPTH = 8;

export interface OrgNode {
  id: string;
  name: string;
  kind: string;
  assigneeId: string | null;
  assigneeName: string | null;
  children: OrgNode[];
}
export interface OrgStructure {
  root: OrgNode;
  updatedAt?: string | null;
}

/** Coerce arbitrary input into a safe OrgStructure: valid kinds, string names, bounded
 *  node-count and depth (defends against cycles/abuse). Root is forced to kind "company". */
export function sanitizeStructure(input: unknown, fallbackName = "Company"): OrgStructure {
  let count = 0;
  // ── id de-duplication (2026-09-02, live symptom: 4 GM people sharing one `p-` node id) ──────────
  // This runs on EVERY write through this function (the PUT handler and every JML flow), so it is
  // the one place that can catch a duplicate id regardless of where it came from — an explicit id
  // reused by a client payload, a bug in a future seed/import script (the proximate cause of the
  // live symptom was `org-structure-refresh.ts` truncating a full uuidv7 person id down to 8 hex
  // characters, which collides by construction for any batch of accounts created close together in
  // time — fixed separately, at the source, in that file). `seenIds` is scoped to ONE
  // `sanitizeStructure` call, i.e. one whole tree, and `dupCounter` is independent of the id
  // `count` above specifically so a disambiguated id (`<original>-dupN`) can never coincide with a
  // node's own natural fallback (`n-<count>`) — the two counters name disjoint id spaces.
  //
  // Deliberately NEVER reparents anyone: only the `id` STRING of the LATER duplicate occurrence
  // changes (first-seen wins, keeping the more "natural" id stable across a resave); `assigneeId`,
  // `assigneeName`, `kind`, `name` and the node's position in the tree are all untouched. Renaming
  // an id has no bearing on placement/authorization either way — `deriveBlobPlacements`
  // (core/dept-resolution.ts) keys membership purely off `assigneeId`, never off a node's own `id`.
  const seenIds = new Set<string>();
  let dupCounter = 0;
  function uniqueId(candidate: string): string {
    let id = candidate;
    while (seenIds.has(id)) {
      dupCounter += 1;
      id = `${candidate}-dup${dupCounter}`;
    }
    seenIds.add(id);
    return id;
  }
  function node(raw: unknown, depth: number): OrgNode {
    const r = (raw ?? {}) as Record<string, unknown>;
    count += 1;
    // ⚠ FIXED (2026-09-02, live symptom: 4 people sharing one `p-` node id in the `GM` tree):
    // the fallback id MUST be captured HERE, immediately after `count` advances for THIS node and
    // before recursing into its children — `count` is a single shared counter that every descendant
    // call also advances. The id used to be computed inline in the `return` below, which executes
    // AFTER the recursive `children.push(node(...))` loop below has walked the entire subtree — so a
    // parent's fallback id read `count` as it stood once its LAST-visited descendant had also
    // incremented it, handing the parent and that descendant (and, along a single-child chain, every
    // node in between) the IDENTICAL `n-<N>` string. Allocating it now, pre-order, means each node's
    // id is fixed at the moment `count` reflects that node and no other.
    const fallbackId = `n-${count}`;
    const rawKind = r.kind === "team" ? "division" : (r.kind as string);
    const kind = ORG_KINDS.has(rawKind) ? rawKind : "role";
    const rawChildren = Array.isArray(r.children) ? r.children : [];
    const children: OrgNode[] = [];
    if (depth < MAX_DEPTH) {
      for (const c of rawChildren) {
        if (count >= MAX_NODES) break;
        children.push(node(c, depth + 1));
      }
    }
    return {
      id: uniqueId(typeof r.id === "string" && r.id ? r.id : fallbackId),
      name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 80) : "Untitled",
      kind,
      assigneeId: typeof r.assigneeId === "string" ? r.assigneeId : null,
      assigneeName: typeof r.assigneeName === "string" ? r.assigneeName : null,
      children,
    };
  }
  const obj = (input ?? {}) as Record<string, unknown>;
  const root = node(obj.root ?? obj, 0);
  root.kind = "company";
  if (root.name === "Untitled") root.name = fallbackName;
  return { root };
}

export function countNodes(node: OrgNode): number {
  return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0);
}

// ---- TR-04 (§3.2 Blocker 2) — the org-blob write hook: the membership sweep ----
// Diffs the NEW blob's person placements against the tenant's currently-open PRIMARY
// org_unit_memberships rows and executes the resulting ops as plain SQL inside the SAME
// transaction as the blob write, so a sweep failure rolls back the structure change too rather
// than leaving them inconsistent. The diff itself is a PURE function (core/dept-resolution.ts,
// unit-tested there). `config.originSite` is passed EXPLICITLY on every insert (§15 ruling:
// org_unit_memberships has NO column default for origin_site — a default would silently mislabel
// a site-originated row as central under the sync engine's site/central topology).
export async function sweepMemberships(c: PoolClient, tenantId: string, root: OrgNode): Promise<void> {
  const candidates: BlobPlacement[] = deriveBlobPlacements(root);

  const uuidCandidates = candidates.filter((p) => isUuidShaped(p.userId));
  const knownUserIds = uuidCandidates.length
    ? new Set(
        (
          await c.query<{ id: string }>(`SELECT id FROM users WHERE id = ANY($1::uuid[])`, [
            uuidCandidates.map((p) => p.userId),
          ])
        ).rows.map((r) => r.id),
      )
    : new Set<string>();
  // Never invent a person, never abort the write for an unrepresentable ref — same posture as the
  // 0055 backfill's DEFENSIVE PERSON-REF RESOLUTION.
  const placements = uuidCandidates.filter((p) => knownUserIds.has(p.userId));

  const openRows = (
    await c.query<OpenPrimaryMembership>(
      `SELECT user_id AS "userId", unit_node_id AS "unitNodeId", valid_from::text AS "validFrom"
         FROM org_unit_memberships
        WHERE tenant_id = $1 AND is_primary AND valid_to IS NULL`,
      [tenantId],
    )
  ).rows;

  const ops = diffMembershipSweep(placements, openRows, todayIso());

  for (const op of ops) {
    if (op.kind === "add") {
      await c.query(
        `INSERT INTO org_unit_memberships
           (tenant_id, user_id, unit_node_id, is_primary, valid_from, valid_to, source, origin_site)
         VALUES ($1, $2, $3, true, $4, NULL, 'org_blob', $5)
         ON CONFLICT DO NOTHING`,
        [tenantId, op.userId, op.unitNodeId, op.validFrom, config.originSite],
      );
    } else if (op.kind === "amend") {
      await c.query(
        `UPDATE org_unit_memberships SET unit_node_id = $3
          WHERE tenant_id = $1 AND user_id = $2 AND is_primary AND valid_to IS NULL`,
        [tenantId, op.userId, op.unitNodeId],
      );
    } else if (op.kind === "transfer") {
      // Sequenced so the transfer is atomic and legal: close the old row FIRST (the EXCLUDE
      // constraint is checked per-statement, not deferred), THEN open the new one — closing at
      // `today - 1` (never `today`) is what keeps the two ranges non-overlapping under the
      // constraint's inclusive-both-ends daterange (see org-unit-memberships.test.ts's "ADJACENT
      // non-overlapping primary ranges are ALLOWED" case, which this reproduces exactly).
      await c.query(
        `UPDATE org_unit_memberships SET valid_to = $3
          WHERE tenant_id = $1 AND user_id = $2 AND is_primary AND valid_to IS NULL`,
        [tenantId, op.userId, op.closeValidTo],
      );
      await c.query(
        `INSERT INTO org_unit_memberships
           (tenant_id, user_id, unit_node_id, is_primary, valid_from, valid_to, source, origin_site)
         VALUES ($1, $2, $3, true, $4, NULL, 'org_blob', $5)
         ON CONFLICT DO NOTHING`,
        [tenantId, op.userId, op.openUnitNodeId, op.openValidFrom, config.originSite],
      );
    } else {
      // 'remove' — person no longer resolvable anywhere in the new blob; close, open nothing.
      await c.query(
        `UPDATE org_unit_memberships SET valid_to = $3
          WHERE tenant_id = $1 AND user_id = $2 AND is_primary AND valid_to IS NULL`,
        [tenantId, op.userId, op.closeValidTo],
      );
    }
  }
}

/** Read the tenant's stored structure, or `null` when none is set yet. Caller supplies the
 *  transaction so a JML flow reads and writes the blob in ONE transaction (§5.2: "one
 *  transaction"). */
export async function loadOrgStructure(c: PoolClient, tenantId: string): Promise<OrgStructure | null> {
  const { rows } = await c.query<{ structure: OrgStructure }>(
    `SELECT structure FROM company_org_structure WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows[0] ? sanitizeStructure(rows[0].structure) : null;
}

/**
 * THE org-structure write: persist the blob, sweep memberships, rebuild the closure, emit
 * `org_structure.updated` — all inside the caller's transaction. Both the HTTP PUT and every JML
 * flow go through here; there is deliberately no second path.
 */
export async function applyOrgStructure(
  c: PoolClient,
  tenantId: string,
  structure: OrgStructure,
): Promise<void> {
  await c.query(
    `INSERT INTO company_org_structure (tenant_id, structure, origin_site)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id) DO UPDATE SET structure = $2, updated_at = now()`,
    [tenantId, JSON.stringify(structure), config.originSite],
  );
  // Every org-blob write is also a membership-sweep write (TR-04) AND a closure rebuild (IAM-09),
  // in the SAME transaction, so neither can disagree with the tree it describes.
  await sweepMemberships(c, tenantId, structure.root);
  await rebuildOrgUnitClosure(c, tenantId, structure.root);
  await emitEvent(c, tenantId, "org_structure", tenantId, "org_structure.updated", {
    nodeCount: countNodes(structure.root),
  });
}

// ---- Person-node helpers (the JML flows' only sanctioned blob edit) ----

function findNode(node: OrgNode, nodeId: string): OrgNode | null {
  if (node.id === nodeId) return node;
  for (const child of node.children) {
    const hit = findNode(child, nodeId);
    if (hit) return hit;
  }
  return null;
}

/** Removes every person node whose `assigneeId` is this user, wherever it sits. Returns the number
 *  of nodes removed — 0 means the person was not placed, which is a legitimate state (a
 *  `pending_start` hire with no placement), never an error. */
export function removePersonNode(root: OrgNode, userId: string): number {
  let removed = 0;
  function walk(node: OrgNode): void {
    const keep: OrgNode[] = [];
    for (const child of node.children) {
      if (child.kind === "person" && child.assigneeId === userId) {
        removed += 1;
        continue;
      }
      walk(child);
      keep.push(child);
    }
    node.children = keep;
  }
  walk(root);
  return removed;
}

/**
 * Places `userId` as a person node under `unitNodeId`, moving them if they are already placed
 * elsewhere (remove-then-add, so a person is never in two units at once — which the primary
 * membership's GiST non-overlap constraint would reject anyway, one layer later and far less
 * legibly).
 *
 * Returns false when `unitNodeId` is not in this tree: the caller must treat that as a refusal,
 * NOT place the person at the root as a fallback. A position whose unit node has been deleted from
 * the blob is exactly the "orphaned position" state the reconciler freezes (design §3.3) — quietly
 * reparenting the person would hide it.
 */
export function upsertPersonNode(
  root: OrgNode,
  unitNodeId: string,
  person: { userId: string; name: string },
): boolean {
  const target = findNode(root, unitNodeId);
  if (!target) return false;
  removePersonNode(root, person.userId);
  target.children.push({
    // Deterministic id: re-running a hire/transfer for the same person under the same unit
    // produces the same node instead of accumulating duplicates (§5's idempotency requirement).
    id: `p-${person.userId}`,
    name: person.name,
    kind: "person",
    assigneeId: person.userId,
    assigneeName: person.name,
    children: [],
  });
  return true;
}
