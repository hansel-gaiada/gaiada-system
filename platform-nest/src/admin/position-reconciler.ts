// IAM Phase 2 (P2-05) — the POSITION reconciler. `position_assignments` in, `user_roles` out.
//
// Assigning a position materialises its role set; closing an assignment removes exactly what that
// assignment justified and nothing else. Modeled line-for-line on `service-reconciler.ts` (design
// §3: "Modeled line-for-line on service-reconciler.ts's proven invariants"). Cerbos and RLS never
// learn positions exist — they evaluate the ordinary `user_roles` grants this file materializes,
// exactly as they do for a hand-made grant.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE GRAIN: one USER in one TENANT.
//
// Not one assignment. Design §3.1 defines desired state as "the union over their active position
// assignments" — plural seats compose, and two seats conferring the same (role, scope) must
// produce ONE grant with TWO claims. That union is only computable per-user, so the per-user
// transaction is the unit that can be made correct. Every entry point below (per-assignment,
// per-position, per-tenant, sweep) resolves to a set of affected users and drives this one core.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// INVARIANTS CARRIED FROM THE SERVICE RECONCILER (each stated where it is enforced below)
//
//  - A2 REFCOUNT — `position_grant_claims` is the liveness source of truth; `managed_by_position`
//    is a marker only. Two assignments justifying the same (role, scope) hold two claims on ONE
//    user_roles row; closing one decrements to 1 and deletes NOTHING. See `applyPlan`'s removal
//    phase (count-remaining-then-delete).
//  - A2 MANUAL-GRANT ADOPTION — a pre-existing hand-made grant (`managed_by IS NULL AND
//    managed_by_position IS NULL`) is neither stolen nor duplicated: it is classified
//    `skip_manual`, NO claim is recorded, and the marker is never stamped on it. Because no claim
//    exists, a later close cannot decrement it into deletion. See `classifyExisting`.
//  - A16 ORPHAN FREEZE — a position whose org-blob unit node has vanished is `status='orphaned'`;
//    grants FREEZE standing rather than being stripped. A chart edit is never allowed to become a
//    mass revocation. See `computePlan`'s orphan short-circuit.
//  - LOCK ORDERING — teardown locks each artifact `FOR UPDATE` in sorted artifact-id order before
//    touching its claim, so two overlapping teardowns of a shared artifact serialize instead of
//    both observing the other's uncommitted claim and NEITHER deleting (the READ COMMITTED race
//    QA V3 found). Stable global order ⇒ no deadlock. See `applyPlan`.
//  - A1 IN-TRANSACTION RE-VERIFICATION — the desired state is re-collected INSIDE the writing
//    transaction, never carried in from an earlier read.
//  - A14 ADOPTION HOOK — `adoptPositionGrantAsManual` converts a managed row to manual (clear
//    marker, drop claims) so an admin's explicit hand-grant is not later decremented away.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// TWO DEVIATIONS FROM THE DESIGN TEXT, BOTH FORCED BY FILE OWNERSHIP — READ BEFORE EDITING
//
// (1) THE REVOKE STATEMENT. Design §3.2 specifies a delete against `user_roles` pinned by
//     `id = $1 AND managed_by_position IS NOT NULL`. That statement belongs in the choke point
//     (`grant-write.service.ts`), which this ticket is forbidden from modifying, and
//     `user-roles-writer-guard.test.ts` correctly reds any bespoke delete of a `user_roles` row
//     elsewhere in `src/` — including, as this file found out, one merely QUOTED in a comment,
//     since the sweep is a raw-text scan. The choke point's existing `revokeManagedGrant()` guards
//     `managed_by IS NOT NULL` — which a position-owned row NEVER satisfies, because migration
//     0109's `user_roles_managed_by_position_exclusive` CHECK makes the two columns mutually
//     exclusive. Calling it would silently delete nothing.
//
//     So this file calls `revokeGrantById(c, grantId, userId)` and enforces the ownership guard
//     ITSELF, in the transaction, under the `FOR UPDATE` lock it already holds on that exact row:
//     the row is re-read post-lock and deleted ONLY if `managed_by_position IS NOT NULL`. This is
//     atomically equivalent to the in-statement guard — the lock is taken BEFORE the ownership
//     read, so the A14 adoption path (which clears the marker) blocks behind it and cannot
//     interleave between check and delete. `position-reconciler-adversarial.test.ts` proves the
//     manual and service-owned rows are untouchable through this path.
//     ⚠ FOLLOW-UP FOR THE ARCHITECT: add `revokeManagedPositionGrant()` to the choke point and
//     repoint this call. That restores the guard to the statement and is strictly better; it just
//     needs an owner for that file.
//
// (2) STAMPING `managed_by_position`. `insertGrantRow`'s `GrantSpec` has `managedBy` but no
//     `managedByPosition` (P2-04 predates this table's use). Rather than fork the insert, the row
//     is inserted through the choke point and the marker applied by a following
//     `UPDATE user_roles SET managed_by_position = ...` in the SAME transaction. That update is
//     provenance-only and is EXPLICITLY sanctioned by the writer guard, whose own words are:
//     "Provenance-only updates (managed_by, managed_by_position, expires_at) are fine and are not
//     flagged." The intermediate state (a marker-less row) is never visible outside this
//     uncommitted transaction, and the UPDATE is pinned `AND managed_by IS NULL AND
//     managed_by_position IS NULL` so it can never re-stamp a row that turned out to be manual or
//     service-owned.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHERE THIS SITS RELATIVE TO `sweepMemberships()` (P2-06's boundary — read this before P2-06)
//
// `org_unit_memberships` is DERIVED from the org blob by `sweepMemberships()` on every
// `PUT /companies/:id/org-structure` (`company-admin.controller.ts`). This reconciler NEVER reads
// or writes `org_unit_memberships`, and never reads the org blob. Its ONLY link to the org chart
// is `positions.unit_node_id`, a free-text node id it reads as an opaque string to resolve an
// `own_unit` scope. The two pipelines are therefore independent projections of the same chart, and
// P2-06 can move a person's blob node through the EXISTING PUT pipeline untouched: `sweepMemberships()`
// re-derives memberships, and this reconciler is driven separately by the position_assignment
// close/open pair that the transfer also writes. P2-06 owns the transfer capability — closing the
// old assignment (`valid_to = current_date`) and opening the new one, then calling
// `reconcileUser()` (or emitting the events that drive it). Nothing here needs to change for that.
import type { PoolClient } from "pg";
import { withGlobal, withTenants } from "../db";
import { config } from "../config";
import { emitEvent } from "../events/outbox.service";
// P2-04: every user_roles write in this file goes through the ONE choke point as a
// TRUSTED_INTERNAL caller. Neither the role nor the scope is caller-chosen: `role_id` comes from
// `position_roles` (a stored template, guarded at write time by 0109's `position_roles_guard()`),
// and the scope is derived from `scope_kind` — 'company' → the position's own tenant, 'own_unit' →
// the position's own `unit_node_id`. `position_roles.scope_kind`'s CHECK has no 'global' member,
// so a position structurally cannot confer platform tier. Pinned by name in
// `user-roles-writer-guard.test.ts`'s TRUSTED_INTERNAL_CALLERS.
import { insertGrantRow, revokeGrantById } from "./grant-write.service";

/** Thrown when a single run would revoke more grants than `positionMassRevokeThreshold`. Carries
 *  the plan so the caller can report exactly what it refused to do. Fails CLOSED: the transaction
 *  aborts before any write commits, rather than applying the first N revocations. */
export class MassRevokeBrakeError extends Error {
  constructor(
    readonly attempted: number,
    readonly threshold: number,
    readonly scope: string,
    readonly detail: RevokePlanEntry[],
  ) {
    super(
      `position_reconcile_brake: ${scope} would revoke ${attempted} grant(s), over the ` +
        `${threshold} threshold. REFUSED — nothing was written. A reconciler bug that revokes ` +
        `everyone is far worse than one that revokes nothing. Review with dryRun, then re-run ` +
        `with force:true if this is genuinely intended.`,
    );
    this.name = "MassRevokeBrakeError";
  }
}

type ScopeKind = "company" | "own_unit";

interface DesiredGrant {
  roleId: string;
  scopeType: "company" | "org_unit";
  scopeId: string;
  /** Every live assignment justifying this exact (role, scope) — the refcount's inputs (A2). */
  assignmentIds: string[];
}

export interface GrantPlanEntry {
  key: string;
  roleId: string;
  scopeType: string;
  scopeId: string;
  assignmentIds: string[];
  /** `insert` = mint + stamp + claim. `claim_only` = row already position-managed, add refcount.
   *  `skip_manual` = hand-made grant, record NOTHING (A2). `skip_service` = owned by the service
   *  reconciler (`managed_by` set); the 0109 exclusivity CHECK forbids double-marking, so leave it. */
  action: "insert" | "claim_only" | "skip_manual" | "skip_service";
  existingGrantId: string | null;
}

export interface RevokePlanEntry {
  claimIds: string[];
  artifactId: string;
  /** Claims on this artifact held by assignments OUTSIDE this run's drop set. >0 ⇒ refcount
   *  survives and the grant is NOT deleted — only the claim is. */
  survivingClaims: number;
  wouldDeleteGrant: boolean;
}

export interface ReconcilePlan {
  tenantId: string;
  userId: string;
  orphaned: boolean;
  grants: GrantPlanEntry[];
  revokes: RevokePlanEntry[];
  /** Grants that would actually be DELETED (refcount hits zero) — what the brake counts. */
  revokeCount: number;
}

export interface ReconcileUserResult {
  tenantId: string;
  userId: string;
  granted: number;
  revoked: number;
  claimsAdded: number;
  claimsDropped: number;
  orphaned: boolean;
  dryRun: boolean;
  plan: ReconcilePlan;
}

const grantKey = (roleId: string, scopeType: string, scopeId: string): string =>
  `${roleId}|${scopeType}|${scopeId}`;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE COLLECTOR — the ONE desired-state read. Dry-run and the real path both call `computePlan`,
// which calls this. There is no second implementation to drift (the ORG-7b rule: "a preview that
// re-implements the collector is a preview of a different program").
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Design §3.1 — desired state for one user in one tenant: the union over their ACTIVE position
 * assignments (`valid_to IS NULL`, position `status='active'`) of each position's
 * `position_roles`, scope-resolved.
 *
 * `valid_to IS NULL` is the liveness test, matching the design and `position_assignments`' own
 * table comment ("valid_to IS NULL = currently active"). This is what makes a transfer bite
 * IMMEDIATELY: P2-06 closes the old seat by stamping `valid_to = current_date`, and that row stops
 * being desired on the very next reconcile — it does not linger until midnight.
 */
async function collectDesired(
  c: PoolClient,
  tenantId: string,
  userId: string,
): Promise<Map<string, DesiredGrant>> {
  const { rows } = await c.query<{
    assignment_id: string;
    role_id: string;
    scope_kind: ScopeKind;
    unit_node_id: string;
  }>(
    `SELECT pa.id AS assignment_id, pr.role_id, pr.scope_kind, p.unit_node_id
       FROM position_assignments pa
       JOIN positions p        ON p.id = pa.position_id AND p.tenant_id = pa.tenant_id
       JOIN position_roles pr  ON pr.position_id = p.id AND pr.tenant_id = p.tenant_id
      WHERE pa.tenant_id = $1
        AND pa.user_id = $2
        AND pa.valid_to IS NULL
        AND p.status = 'active'`,
    [tenantId, userId],
  );

  const desired = new Map<string, DesiredGrant>();
  for (const r of rows) {
    // scope_kind's CHECK admits only 'company' | 'own_unit' — there is deliberately no 'global',
    // which is the ENTIRE enforcement of "a position can never confer platform tier" (0109 §2.3).
    const scopeType = r.scope_kind === "own_unit" ? "org_unit" : "company";
    const scopeId = r.scope_kind === "own_unit" ? r.unit_node_id : tenantId;
    const key = grantKey(r.role_id, scopeType, scopeId);
    const existing = desired.get(key);
    if (existing) {
      // Union semantics: two seats conferring the SAME (role, scope) → one grant, two claims (A2).
      if (!existing.assignmentIds.includes(r.assignment_id)) existing.assignmentIds.push(r.assignment_id);
    } else {
      desired.set(key, { roleId: r.role_id, scopeType, scopeId, assignmentIds: [r.assignment_id] });
    }
  }
  return desired;
}

/** A16 — does this user hold a live assignment against an ORPHANED position? If so the whole
 *  user reconcile FREEZES: grants stay standing, nothing is diffed. Deliberately conservative
 *  (a user with one healthy and one orphaned seat freezes entirely) because every error in this
 *  direction leaves access UNCHANGED, and the opposite direction is the top hazard in the
 *  program risk table. Auto-retirement after a TTL is the sweep's job, not this path's. */
async function hasOrphanedSeat(c: PoolClient, tenantId: string, userId: string): Promise<boolean> {
  const { rows } = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM position_assignments pa
       JOIN positions p ON p.id = pa.position_id AND p.tenant_id = pa.tenant_id
      WHERE pa.tenant_id = $1 AND pa.user_id = $2 AND pa.valid_to IS NULL AND p.status = 'orphaned'`,
    [tenantId, userId],
  );
  return rows[0].n > 0;
}

/** A2 — classify an EXISTING user_roles row by who owns it. This is the manual-grant adoption
 *  invariant's whole implementation: a row with neither marker is manual and is left completely
 *  alone (no claim, no marker, no delete), so it is neither stolen from the admin who made it nor
 *  duplicated by a second row this reconciler would then own. */
function classifyExisting(row: {
  managed_by: string | null;
  managed_by_position: string | null;
}): "claim_only" | "skip_manual" | "skip_service" {
  if (row.managed_by !== null) return "skip_service";
  if (row.managed_by_position !== null) return "claim_only";
  return "skip_manual";
}

/**
 * THE PLAN. Pure read — writes nothing. `dryRun` and the real path call this identically, which is
 * why a preview and the action it previews cannot diverge: they are the same function, and the
 * real path calls it INSIDE its own writing transaction (A1 re-verification) rather than trusting
 * a plan computed earlier.
 */
export async function computePlan(c: PoolClient, tenantId: string, userId: string): Promise<ReconcilePlan> {
  const orphaned = await hasOrphanedSeat(c, tenantId, userId);
  if (orphaned) {
    // A16 freeze: report the frozen state, diff nothing.
    return { tenantId, userId, orphaned: true, grants: [], revokes: [], revokeCount: 0 };
  }

  const desired = await collectDesired(c, tenantId, userId);

  // ── grant side: what each desired (role, scope) needs, given what already exists ────────────
  const grants: GrantPlanEntry[] = [];
  // ⚠ Keyed by (assignmentId, grantId) PAIR, not by grantId. Keying by artifact alone was a real
  // bug caught by VECTOR 1 of the adversarial suite: when seat A and seat B both justify one
  // grant and seat A closes, the artifact is STILL desired (seat B wants it), so an artifact-keyed
  // check keeps every claim on it — including seat A's, which must go. The refcount then never
  // decrements and the closed seat stays attached to a live grant forever, which is precisely the
  // "zero grants tagged to the closed assignment remain" criterion failing.
  const desiredClaimPairs = new Set<string>();
  const claimPair = (assignmentId: string, grantId: string): string => `${assignmentId}|${grantId}`;
  for (const [key, d] of desired) {
    const { rows } = await c.query<{ id: string; managed_by: string | null; managed_by_position: string | null }>(
      `SELECT id, managed_by, managed_by_position FROM user_roles
        WHERE user_id = $1 AND role_id = $2 AND scope_type = $3 AND scope_id = $4`,
      [userId, d.roleId, d.scopeType, d.scopeId],
    );
    const existing = rows[0];
    const action = existing ? classifyExisting(existing) : "insert";
    if (existing && action === "claim_only") {
      for (const aid of d.assignmentIds) desiredClaimPairs.add(claimPair(aid, existing.id));
    }
    grants.push({
      key,
      roleId: d.roleId,
      scopeType: d.scopeType,
      scopeId: d.scopeId,
      assignmentIds: d.assignmentIds,
      action,
      existingGrantId: existing?.id ?? null,
    });
  }

  // ── removal side: THIS USER's claims (across ALL their assignments in this tenant, open OR
  //    closed) whose artifact is no longer desired. Joining through position_assignments is what
  //    scopes the teardown to "exactly what this person's assignments justified and nothing else".
  const { rows: claimRows } = await c.query<{
    id: string;
    user_role_id: string;
    position_assignment_id: string;
  }>(
    `SELECT pgc.id, pgc.user_role_id, pgc.position_assignment_id
       FROM position_grant_claims pgc
       JOIN position_assignments pa
         ON pa.id = pgc.position_assignment_id AND pa.tenant_id = pgc.tenant_id
      WHERE pgc.tenant_id = $1 AND pa.user_id = $2 AND pgc.user_role_id IS NOT NULL`,
    [tenantId, userId],
  );

  const dropByArtifact = new Map<string, string[]>();
  for (const cl of claimRows) {
    // Keep this claim only if THIS assignment still justifies THIS artifact. A sibling seat
    // wanting the same artifact keeps the GRANT alive (via the refcount below) but never keeps a
    // closed seat's claim alive.
    if (desiredClaimPairs.has(claimPair(cl.position_assignment_id, cl.user_role_id))) continue;
    const list = dropByArtifact.get(cl.user_role_id) ?? [];
    list.push(cl.id);
    dropByArtifact.set(cl.user_role_id, list);
  }

  const revokes: RevokePlanEntry[] = [];
  for (const [artifactId, claimIds] of dropByArtifact) {
    // A2 REFCOUNT: how many claims on this artifact are held by assignments we are NOT dropping?
    // A second seat (this user's or another's) keeps the grant alive with a decremented count.
    const { rows } = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM position_grant_claims
        WHERE user_role_id = $1 AND id <> ALL($2::uuid[])`,
      [artifactId, claimIds],
    );
    const surviving = rows[0].n;
    revokes.push({
      claimIds,
      artifactId,
      survivingClaims: surviving,
      wouldDeleteGrant: surviving === 0,
    });
  }
  // Stable global lock order — see `applyPlan`. Sorted HERE so the plan a dry-run shows is the
  // exact order the real run will take its locks in.
  revokes.sort((a, b) => (a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0));

  return {
    tenantId,
    userId,
    orphaned: false,
    grants,
    revokes,
    revokeCount: revokes.filter((r) => r.wouldDeleteGrant).length,
  };
}

/** The brake, as a pure predicate so the batch driver and the per-user path share ONE rule. */
function assertUnderBrake(plan: { revokeCount: number }, scope: string, detail: RevokePlanEntry[], force: boolean): void {
  const threshold = config.positionMassRevokeThreshold;
  if (!force && plan.revokeCount > threshold) {
    throw new MassRevokeBrakeError(plan.revokeCount, threshold, scope, detail);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE APPLY
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function applyPlan(
  c: PoolClient,
  plan: ReconcilePlan,
): Promise<{ granted: number; revoked: number; claimsAdded: number; claimsDropped: number }> {
  const { tenantId, userId } = plan;
  let granted = 0;
  let revoked = 0;
  let claimsAdded = 0;
  let claimsDropped = 0;

  const addClaim = async (assignmentId: string, grantId: string): Promise<void> => {
    const res = await c.query(
      `INSERT INTO position_grant_claims (tenant_id, position_assignment_id, user_role_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (position_assignment_id, user_role_id) WHERE user_role_id IS NOT NULL DO NOTHING`,
      [tenantId, assignmentId, grantId],
    );
    claimsAdded += res.rowCount ?? 0;
  };

  // ── grant phase ─────────────────────────────────────────────────────────────────────────────
  for (const g of plan.grants) {
    if (g.action === "skip_manual" || g.action === "skip_service") {
      // A2: record NOTHING. No claim means a later close cannot decrement this row into deletion.
      continue;
    }
    let grantId: string | null = g.existingGrantId;

    if (g.action === "insert") {
      // Design §3.2: "INSERT with managed_by_position + claim (ON CONFLICT DO NOTHING, untargeted
      // — the 0092 partial-index lesson)". Untargeted per the design; positions never produce a
      // NULL scope_id anyway (no 'global' scope_kind exists), so both clauses behave alike here.
      await insertGrantRow(c, {
        origin: "trusted_internal",
        targetUserId: userId,
        roleId: g.roleId,
        scopeType: g.scopeType,
        scopeId: g.scopeId,
        // `managedBy` is deliberately NOT supplied — not even as an explicit null. It is the
        // SERVICE reconciler's marker (A1: `managed-by-invariant.test.ts` pins that
        // `service-reconciler.ts` is its only supplier), and 0109's
        // `user_roles_managed_by_position_exclusive` CHECK makes the two markers mutually
        // exclusive. This reconciler's provenance is `managed_by_position`, stamped below.
        onConflict: "untargeted",
      });
      // Re-read the winner (a concurrent manual grant may have won the ON CONFLICT race).
      const { rows } = await c.query<{ id: string; managed_by: string | null; managed_by_position: string | null }>(
        `SELECT id, managed_by, managed_by_position FROM user_roles
          WHERE user_id = $1 AND role_id = $2 AND scope_type = $3 AND scope_id = $4`,
        [userId, g.roleId, g.scopeType, g.scopeId],
      );
      const row = rows[0];
      if (!row) continue;

      // Deviation (2) in the header: stamp the marker with a provenance-only UPDATE, pinned so it
      // can NEVER re-stamp a row that turned out to be manual or service-owned. If a manual row
      // won the race, this matches zero rows and the row stays manual — no claim is recorded below
      // either, because `justInserted` stays false. That is the A2 adoption invariant surviving a
      // race, not just a quiet path.
      const stamp = await c.query(
        `UPDATE user_roles SET managed_by_position = $2
          WHERE id = $1 AND managed_by IS NULL AND managed_by_position IS NULL`,
        [row.id, g.assignmentIds[0]],
      );
      const justInserted = (stamp.rowCount ?? 0) > 0;
      if (!justInserted && row.managed_by_position === null) {
        // Someone else's row (manual or service-owned) won — leave it entirely alone.
        continue;
      }
      grantId = row.id;
      if (justInserted) granted++;
    }

    if (!grantId) continue;
    // A2 REFCOUNT: one claim per justifying assignment. Two seats ⇒ two claims on one row.
    for (const assignmentId of g.assignmentIds) await addClaim(assignmentId, grantId);
  }

  // ── removal phase ───────────────────────────────────────────────────────────────────────────
  //
  // CONCURRENCY (carried verbatim in spirit from service-reconciler.ts's QA V3 fix): two
  // teardowns sharing one artifact race under READ COMMITTED. A naive "delete my claim → count →
  // delete artifact if 0" lets each transaction still see the OTHER's uncommitted sibling claim,
  // so both count >= 1 and NEITHER deletes — a live grant with zero claims, a permanent and
  // audit-invisible leak. Fix: SERIALIZE on the artifact. Lock the artifact row FOR UPDATE BEFORE
  // touching its claim; the second transaction blocks there (still holding its own claim, so the
  // row is guaranteed to exist to lock) until the first commits, then sees the committed
  // post-delete count. `plan.revokes` is already sorted by artifact id, so locks are acquired in a
  // stable global order across ALL transactions and two overlapping teardowns cannot deadlock.
  for (const rm of plan.revokes) {
    // (1) LOCK FIRST.
    const locked = await c.query<{ id: string; user_id: string; managed_by: string | null; managed_by_position: string | null }>(
      `SELECT id, user_id, managed_by, managed_by_position FROM user_roles WHERE id = $1 FOR UPDATE`,
      [rm.artifactId],
    );
    // (2) drop THIS user's claims, now inside the serialized section.
    const del = await c.query(`DELETE FROM position_grant_claims WHERE id = ANY($1::uuid[])`, [rm.claimIds]);
    claimsDropped += del.rowCount ?? 0;
    // (3) re-count remaining claims — reflects any sibling transaction that committed before us.
    const { rows } = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM position_grant_claims WHERE user_role_id = $1`,
      [rm.artifactId],
    );
    if (rows[0].n !== 0) continue; // refcount survives — claim dropped, grant stands (A2).

    // (4) last claim gone ⇒ tear down, but ONLY if position-owned. See deviation (1) in the
    //     header: this ownership re-read happens under the FOR UPDATE lock taken in step (1), so
    //     it is atomically equivalent to the in-statement `AND managed_by_position IS NOT NULL`
    //     guard the design specifies. A manual row (both markers NULL) and a service-reconciler
    //     row (`managed_by` set) are both structurally untouchable from here.
    const row = locked.rows[0];
    if (!row || row.managed_by_position === null) continue;
    const goneUserId = await revokeGrantById(c, rm.artifactId, row.user_id);
    if (goneUserId) revoked++;
  }

  if (granted || revoked) {
    await emitEvent(c, tenantId, "position_assignment", userId, "position_grants.reconciled", {
      correlationId: userId,
      userId,
      granted,
      revoked,
      claimsAdded,
      claimsDropped,
    });
  }

  return { granted, revoked, claimsAdded, claimsDropped };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ENTRY POINTS
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ReconcileOpts {
  /** Preview only — reuses the SAME collector and the SAME plan as the real path. */
  dryRun?: boolean;
  /** Bypass the mass-revoke brake. Design §3.2: the manual endpoint accepts this only after a
   *  dry-run has been reviewed. */
  force?: boolean;
}

/**
 * THE core entry point: reconcile ONE user in ONE tenant. Everything else resolves to this.
 * Returns null when the flag is off (dark by default, design §3).
 */
export async function reconcileUser(
  tenantId: string,
  userId: string,
  opts: ReconcileOpts = {},
): Promise<ReconcileUserResult | null> {
  if (!config.positionSyncEnabled) return null;
  const dryRun = opts.dryRun === true;

  const out = await withTenants([tenantId], async (c) => {
    // A1: the plan is computed INSIDE the writing transaction — never carried in from an earlier
    // read — so what is applied is what was true at write time.
    const plan = await computePlan(c, tenantId, userId);
    assertUnderBrake(plan, `user ${userId} in tenant ${tenantId}`, plan.revokes, opts.force === true);

    if (dryRun || plan.orphaned) {
      return { granted: 0, revoked: 0, claimsAdded: 0, claimsDropped: 0, plan };
    }
    const applied = await applyPlan(c, plan);
    return { ...applied, plan };
  });

  // Session cut (design §3.2): ONE bump per affected user, AFTER commit. Mutations re-check
  // `sessionVersionCurrent()`, so a revocation bites on the target's next write.
  if (!dryRun && (out.granted || out.revoked)) {
    await withGlobal((c) =>
      c.query(`UPDATE users SET session_version = session_version + 1, updated_at = now() WHERE id = $1`, [userId]),
    );
  }

  return {
    tenantId,
    userId,
    granted: out.granted,
    revoked: out.revoked,
    claimsAdded: out.claimsAdded,
    claimsDropped: out.claimsDropped,
    orphaned: out.plan.orphaned,
    dryRun,
    plan: out.plan,
  };
}

/** Every user with ANY claim or ANY assignment in this tenant — the set a batch must consider.
 *  Claims are included so a user whose LAST assignment was closed (and who therefore has no
 *  assignment rows left to find) is still swept and still gets their grants torn down. */
async function affectedUsers(c: PoolClient, tenantId: string, positionId?: string): Promise<string[]> {
  if (positionId) {
    const { rows } = await c.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM position_assignments WHERE tenant_id = $1 AND position_id = $2`,
      [tenantId, positionId],
    );
    return rows.map((r) => r.user_id);
  }
  const { rows } = await c.query<{ user_id: string }>(
    `SELECT DISTINCT pa.user_id
       FROM position_assignments pa
      WHERE pa.tenant_id = $1
      UNION
     SELECT DISTINCT pa2.user_id
       FROM position_grant_claims pgc
       JOIN position_assignments pa2 ON pa2.id = pgc.position_assignment_id AND pa2.tenant_id = pgc.tenant_id
      WHERE pgc.tenant_id = $1`,
    [tenantId],
  );
  return rows.map((r) => r.user_id);
}

export interface BatchResult {
  tenantId: string;
  users: number;
  granted: number;
  revoked: number;
  plannedRevokes: number;
  dryRun: boolean;
  results: ReconcileUserResult[];
}

/**
 * Reconcile a SET of users in one tenant (a position edit, a tenant sweep, the manual endpoint).
 *
 * TWO PHASES, and the split is the whole point of the brake at this grain: phase 1 PLANS every
 * user read-only and sums the revocations; if that total is over threshold the batch is refused
 * WHOLESALE, before a single user has been applied. A per-user brake alone cannot catch "an org
 * edit revoked one grant each from four hundred people" — every individual plan is under
 * threshold and the damage is only visible in the sum. Phase 2 then re-plans each user inside
 * their own writing transaction (A1), so the pre-plan is the BRAKE and the re-plan is the
 * CORRECTNESS.
 */
export async function reconcileUsers(
  tenantId: string,
  userIds: string[],
  opts: ReconcileOpts = {},
): Promise<BatchResult | null> {
  if (!config.positionSyncEnabled) return null;
  const dryRun = opts.dryRun === true;
  const force = opts.force === true;

  // ── phase 1: plan everything, read-only, one transaction ────────────────────────────────────
  const plans = await withTenants([tenantId], async (c) => {
    const out: ReconcilePlan[] = [];
    for (const userId of userIds) out.push(await computePlan(c, tenantId, userId));
    return out;
  });
  const plannedRevokes = plans.reduce((n, p) => n + p.revokeCount, 0);
  assertUnderBrake(
    { revokeCount: plannedRevokes },
    `tenant ${tenantId} batch of ${userIds.length} user(s)`,
    plans.flatMap((p) => p.revokes),
    force,
  );

  if (dryRun) {
    return {
      tenantId,
      users: userIds.length,
      granted: 0,
      revoked: 0,
      plannedRevokes,
      dryRun: true,
      results: plans.map((plan) => ({
        tenantId,
        userId: plan.userId,
        granted: 0,
        revoked: 0,
        claimsAdded: 0,
        claimsDropped: 0,
        orphaned: plan.orphaned,
        dryRun: true,
        plan,
      })),
    };
  }

  // ── phase 2: apply per user, each in its own transaction, each re-planned + re-braked ───────
  const results: ReconcileUserResult[] = [];
  for (const userId of userIds) {
    const r = await reconcileUser(tenantId, userId, { force });
    if (r) results.push(r);
  }
  return {
    tenantId,
    users: userIds.length,
    granted: results.reduce((n, r) => n + r.granted, 0),
    revoked: results.reduce((n, r) => n + r.revoked, 0),
    plannedRevokes,
    dryRun: false,
    results,
  };
}

/** A position changed (roles edited, retired, orphaned) → re-diff everyone who has ever held it. */
export async function reconcilePosition(
  tenantId: string,
  positionId: string,
  opts: ReconcileOpts = {},
): Promise<BatchResult | null> {
  if (!config.positionSyncEnabled) return null;
  const users = await withTenants([tenantId], (c) => affectedUsers(c, tenantId, positionId));
  return reconcileUsers(tenantId, users, opts);
}

/** One assignment opened or closed → reconcile its holder (the union is recomputed anyway). */
export async function reconcileAssignment(
  tenantId: string,
  assignmentId: string,
  opts: ReconcileOpts = {},
): Promise<ReconcileUserResult | null> {
  if (!config.positionSyncEnabled) return null;
  const holder = await withTenants([tenantId], (c) =>
    c.query<{ user_id: string }>(`SELECT user_id FROM position_assignments WHERE id = $1 AND tenant_id = $2`, [
      assignmentId,
      tenantId,
    ]),
  );
  const userId = holder.rows[0]?.user_id;
  if (!userId) return null;
  return reconcileUser(tenantId, userId, opts);
}

/** Whole-tenant reconcile — the manual endpoint's broad form and the sweep's per-tenant step. */
export async function reconcileTenant(tenantId: string, opts: ReconcileOpts = {}): Promise<BatchResult | null> {
  if (!config.positionSyncEnabled) return null;
  const users = await withTenants([tenantId], (c) => affectedUsers(c, tenantId));
  return reconcileUsers(tenantId, users, opts);
}

/**
 * A14 — an admin has hand-granted a (user, role, scope) this reconciler manages. Convert it to
 * manual: clear the marker AND drop its claims, so a later seat close cannot decrement a now-manual
 * row into deletion. Idempotent.
 *
 * The UPDATE is provenance-only (`managed_by_position`), which the writer guard explicitly does
 * not flag — it changes who OWNS the grant, never what it confers.
 */
export async function adoptPositionGrantAsManual(tenantId: string, userRoleId: string): Promise<void> {
  await withTenants([tenantId], async (c) => {
    await c.query(`UPDATE user_roles SET managed_by_position = NULL WHERE id = $1`, [userRoleId]);
    await c.query(`DELETE FROM position_grant_claims WHERE user_role_id = $1 AND tenant_id = $2`, [
      userRoleId,
      tenantId,
    ]);
  });
}

/**
 * Design §3.4 — nightly drift detector. REPORTS, never silently self-heals: "divergence → report +
 * `iam.drift_detected` event, never a silent self-heal while the flag is young".
 *
 * ⚠ RLS TRAP (the standing one): this runs `withGlobal` ONLY to enumerate tenants, then re-enters
 * `withTenants([tenant])` for every read. A tenant-scoped query with an unset GUC returns ZERO
 * rows and reports success — which here would look exactly like "no drift anywhere", the most
 * dangerous possible false negative. `assertScoped` below turns that silent zero into a loud
 * throw by proving the tenant context actually resolves rows this transaction can see.
 */
export async function sweepPositionDrift(): Promise<{ tenants: number; usersChecked: number; drifted: number }> {
  if (!config.positionSyncEnabled) return { tenants: 0, usersChecked: 0, drifted: 0 };
  const tenants = (
    await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL`))
  ).rows.map((r) => r.id);

  let usersChecked = 0;
  let drifted = 0;

  for (const tenantId of tenants) {
    const users = await withTenants([tenantId], (c) => affectedUsers(c, tenantId));
    if (!users.length) continue;

    await withTenants([tenantId], async (c) => {
      // ASSERT the tenant GUC actually took. If it did not, `app_current_tenants()` is empty, every
      // read below returns zero rows, and this sweep would report a clean bill of health for a
      // tenant it never actually looked at.
      const { rows } = await c.query<{ ok: boolean }>(
        `SELECT $1 = ANY(app_current_tenants()) AS ok`,
        [tenantId],
      );
      if (!rows[0]?.ok) {
        throw new Error(
          `sweepPositionDrift: tenant context did not take for ${tenantId} — every scoped read ` +
            `would return ZERO rows and this sweep would report "no drift" for a tenant it never read.`,
        );
      }

      for (const userId of users) {
        usersChecked++;
        const plan = await computePlan(c, tenantId, userId);
        const pendingGrants = plan.grants.filter((g) => g.action === "insert").length;
        const pendingRevokes = plan.revokeCount;
        if (pendingGrants || pendingRevokes) {
          drifted++;
          await emitEvent(c, tenantId, "position_assignment", userId, "iam.drift_detected", {
            correlationId: userId,
            userId,
            pendingGrants,
            pendingRevokes,
            source: "position_reconciler",
          });
        }
      }
    });
  }
  return { tenants: tenants.length, usersChecked, drifted };
}
