// ORG-6 — the service-assignment reconciler. THE highest-stakes component in the backbone
// program: a bug here is a cross-tenant access leak. It is a PURE, IDEMPOTENT projection of
// (provider org blob, service_assignments row) → the target company's ordinary
// memberships + user_roles grants, refcounted by service_grant_claims (A2). Cerbos and RLS
// never learn about assignments — they evaluate the memberships/grants this file materializes,
// exactly as they do for a manually-added employee.
//
// INVARIANTS (GATE-1, encoded literally below):
//  - Desired state is a deterministic function of (blob, status): status='active' ⇒ the unit
//    subtree's placed staff get grants; anything else (proposed/suspended/revoked) ⇒ EMPTY.
//    Re-running converges to the same rows (idempotent) — inserts ON CONFLICT DO NOTHING, the
//    removal phase diffs claims, and role/membership identity never changes on a no-op pass.
//  - Deletion guard: a managed artifact is deleted ONLY when THIS assignment's claim was its
//    LAST claim AND it is reconciler-owned (membership.kind='service' AND managed_by IS NOT NULL;
//    user_role.managed_by IS NOT NULL). Employee memberships and manual grants are never deleted.
//  - A1 privileged-writer discipline: this is the sole multi-tenant writer outside the request
//    path. Every materialization transaction RE-READS the assignment and re-verifies status
//    ='active' in the SAME transaction as the write before granting anything (consent is already
//    structural: a provider-admin can only ever create 'proposed'; only a target accept or a
//    global actor produces 'active' — so status='active' IS proof of consent).
//  - A2 no coalescing: claims are the liveness source of truth; managed_by is a marker only.
//    A manual identical grant (managed_by NULL) is left entirely alone — no claim recorded, so a
//    later revoke cannot decrement it.
//  - A16 freeze-don't-revoke: when the unit node vanishes/changes-kind in the blob the assignment
//    is marked orphaned and grants are FROZEN (not stripped); the nightly sweep auto-suspends
//    after a TTL. A person merely moved OUT of the (still-present) unit is an ordinary re-diff.
//
// Triggering is outbox-driven (A7): see events/reconcile-consumer.ts, which maps the existing
// service_assignment.* / org_structure.updated events onto the entry points here. The functions
// are also called directly by the manual /reconcile endpoint (ORG-7) and the nightly sweep.
import type { PoolClient } from "pg";
import { newId, withGlobal, withTenants } from "../db";
import { config } from "../config";
import { emitEvent } from "../events/outbox.service";
// P2-04: this reconciler's grant/revoke statements live in the ONE choke point. It is a
// TRUSTED_INTERNAL caller — no caller-choice validation runs — for the reasons stated at each
// call site and pinned by name in `user-roles-writer-guard.test.ts`.
import { insertGrantRow, revokeManagedGrant } from "./grant-write.service";

const UNIT_KINDS = new Set(["department", "division"]);
const LIVE_ISH = ["active", "suspended", "proposed"];

interface BlobNode {
  id: string;
  name: string;
  kind: string;
  assigneeId?: string | null;
  children?: BlobNode[];
}

interface AssignmentRow {
  id: string;
  unit_id: string;
  provider_tenant_id: string;
  target_tenant_id: string;
  module_key: string;
  status: string;
  lead_user_id: string | null;
}

export interface ReconcileResult {
  assignmentId: string;
  status: string;
  granted: number; // user_role grants newly materialized this run
  revoked: number; // managed user_role grants torn down this run
  orphaned: boolean;
  skipped: string[]; // assigneeIds present in the subtree but not a valid provider member
  affectedUsers: string[]; // users whose access changed → session bumped
}

// ---- pure blob helpers (unit-testable, no IO) ----
export function findNode(root: BlobNode, nodeId: string): BlobNode | null {
  if (root.id === nodeId) return root;
  for (const child of root.children ?? []) {
    const found = findNode(child, nodeId);
    if (found) return found;
  }
  return null;
}

/** Distinct assigneeIds of PERSON nodes in the subtree rooted at `node` (inclusive). */
export function collectSubtreePersons(node: BlobNode): string[] {
  const out = new Set<string>();
  const walk = (n: BlobNode) => {
    if (n.kind === "person" && typeof n.assigneeId === "string" && n.assigneeId) out.add(n.assigneeId);
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return [...out];
}

/** Look up the global (company_id NULL) module role id, e.g. 'hr_staff'. NULL if unseeded. */
async function moduleRoleId(c: PoolClient, moduleKey: string, kind: "staff" | "manager"): Promise<string | null> {
  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM roles WHERE company_id IS NULL AND name = $1`,
    [`${moduleKey}_${kind}`],
  );
  return rows[0]?.id ?? null;
}

/**
 * Reconcile a single assignment to its desired state. `scopeTenantId` must be a tenant that can
 * legally see the row (provider or target — both satisfy sa_select); the outbox consumer passes
 * the event's own tenant, the manual endpoint passes the URL tenant. Returns null when the flag
 * is off or the row is not visible/gone.
 */
export async function reconcileAssignment(
  assignmentId: string,
  scopeTenantId: string,
): Promise<ReconcileResult | null> {
  if (!config.serviceAssignmentsEnabled) return null;

  const row = (
    await withTenants([scopeTenantId], (c) =>
      c.query<AssignmentRow>(
        `SELECT id, unit_id, provider_tenant_id, target_tenant_id, module_key, status, lead_user_id
         FROM service_assignments WHERE id = $1`,
        [assignmentId],
      ),
    )
  ).rows[0];
  if (!row) return null;

  const provider = row.provider_tenant_id;
  const target = row.target_tenant_id;
  const statusAtRead = row.status;
  const skipped: string[] = [];
  let orphaned = false;

  // Desired grants for THIS assignment: userId → role kind. Empty unless status='active'.
  const desired = new Map<string, "manager" | "staff">();

  if (statusAtRead === "active") {
    // Provider-side read: the unit's anchor + the org blob. org_units is provider-only (A8), so
    // this MUST run under the provider tenant, separate from the target write transaction.
    const providerData = await withTenants([provider], async (c) => {
      const unit = (
        await c.query<{ node_id: string }>(
          `SELECT node_id FROM org_units WHERE id = $1 AND tenant_id = $2`,
          [row.unit_id, provider],
        )
      ).rows[0];
      const blob = (
        await c.query<{ structure: { root: BlobNode } }>(
          `SELECT structure FROM company_org_structure WHERE tenant_id = $1`,
          [provider],
        )
      ).rows[0];
      return { unit, blob };
    });

    const node =
      providerData.unit && providerData.blob
        ? findNode(providerData.blob.structure.root, providerData.unit.node_id)
        : null;

    if (!node || !UNIT_KINDS.has(node.kind)) {
      // A16 orphan-freeze: node gone or kind changed. Mark orphaned, emit, and FREEZE — leave
      // whatever grants exist standing (do NOT diff). Auto-suspension is the sweep's job (TTL).
      orphaned = true;
      await withTenants([provider], async (c) => {
        await c.query(`UPDATE org_units SET status = 'orphaned', updated_at = now() WHERE id = $1`, [row.unit_id]);
        await c.query(`UPDATE service_assignments SET unit_status = 'orphaned' WHERE id = $1`, [row.id]);
        await emitEvent(c, provider, "org_unit", row.unit_id, "org_unit.orphaned", {
          correlationId: row.id,
          assignmentId: row.id,
          module: row.module_key,
          targetTenantId: target,
        });
      });
      return { assignmentId, status: statusAtRead, granted: 0, revoked: 0, orphaned: true, skipped, affectedUsers: [] };
    }

    // Node is healthy: refresh denormalized unit metadata (A8) + clear any prior orphaned flag.
    await withTenants([provider], async (c) => {
      await c.query(
        `UPDATE org_units SET name = $2, kind = $3, status = 'active', updated_at = now() WHERE id = $1`,
        [row.unit_id, node.name, node.kind],
      );
      await c.query(
        `UPDATE service_assignments SET unit_name = $2, unit_kind = $3, unit_status = 'active' WHERE id = $1`,
        [row.id, node.name, node.kind],
      );
    });

    // Placed staff = distinct person assigneeIds in the subtree WITH an active provider membership.
    // A bogus/stale assigneeId is skipped and reported, never granted (closes the unvalidated-id hole).
    const persons = collectSubtreePersons(node);
    const valid = new Set<string>();
    if (persons.length) {
      const { rows } = await withTenants([provider], (c) =>
        c.query<{ user_id: string }>(
          `SELECT user_id FROM company_memberships
           WHERE tenant_id = $1 AND user_id = ANY($2::uuid[]) AND status = 'active' AND deleted_at IS NULL`,
          [provider, persons],
        ),
      );
      for (const r of rows) valid.add(r.user_id);
    }
    for (const u of persons) if (!valid.has(u)) skipped.push(u);
    for (const u of valid) desired.set(u, u === row.lead_user_id ? "manager" : "staff"); // A12
  }

  // ---- apply the diff in ONE target-tenant transaction (single-tenant write convention kept;
  //      WITH CHECK stays a real guard). user_roles has no RLS so it rides the same client. ----
  let granted = 0;
  let revoked = 0;
  const affected = new Set<string>();

  await withTenants([target], async (c) => {
    // A1 in-transaction re-verification: only materialize if the row is STILL active as read.
    const fresh = (
      await c.query<{ status: string }>(`SELECT status FROM service_assignments WHERE id = $1`, [assignmentId])
    ).rows[0];
    const effectiveActive = !orphaned && statusAtRead === "active" && fresh?.status === "active";
    const want = effectiveActive ? desired : new Map<string, "manager" | "staff">();

    const desiredMembershipIds = new Set<string>();
    const desiredGrantIds = new Set<string>();

    for (const [userId, kind] of want) {
      // (1) membership: reuse existing; resurrect only a DEAD service row; never mutate an
      //     employee row. Always record a claim (refcount), guarded by kind on teardown.
      const existing = (
        await c.query<{ id: string; kind: string; status: string; deleted_at: string | null }>(
          `SELECT id, kind, status, deleted_at FROM company_memberships WHERE tenant_id = $1 AND user_id = $2`,
          [target, userId],
        )
      ).rows[0];
      let membershipId: string;
      if (!existing) {
        membershipId = newId();
        await c.query(
          `INSERT INTO company_memberships (id, tenant_id, user_id, kind, managed_by, status, origin_site)
           VALUES ($1, $2, $3, 'service', $4, 'active', $5)
           ON CONFLICT (tenant_id, user_id) DO NOTHING`,
          [membershipId, target, userId, assignmentId, config.originSite],
        );
        // ON CONFLICT (a race) → re-read the winner's id.
        const back = (
          await c.query<{ id: string }>(
            `SELECT id FROM company_memberships WHERE tenant_id = $1 AND user_id = $2`,
            [target, userId],
          )
        ).rows[0];
        membershipId = back.id;
      } else {
        membershipId = existing.id;
        if (existing.kind === "service" && (existing.deleted_at || existing.status !== "active")) {
          await c.query(
            `UPDATE company_memberships
               SET status = 'active', deleted_at = NULL, managed_by = COALESCE(managed_by, $2), updated_at = now()
             WHERE id = $1`,
            [membershipId, assignmentId],
          );
        }
      }
      desiredMembershipIds.add(membershipId);
      await c.query(
        `INSERT INTO service_grant_claims (id, tenant_id, assignment_id, membership_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (assignment_id, membership_id) WHERE membership_id IS NOT NULL DO NOTHING`,
        [newId(), target, assignmentId, membershipId],
      );

      // (2) role grant: (userId, <module>_(staff|manager), company:target).
      const rid = await moduleRoleId(c, row.module_key, kind);
      if (!rid) {
        skipped.push(userId); // module role unseeded — cannot grant; reported, never silently dropped
        continue;
      }
      const g = (
        await c.query<{ id: string; managed_by: string | null }>(
          `SELECT id, managed_by FROM user_roles
           WHERE user_id = $1 AND role_id = $2 AND scope_type = 'company' AND scope_id = $3`,
          [userId, rid, target],
        )
      ).rows[0];
      let grantId: string | null;
      if (!g) {
        // P2-04: routed through the choke point as a TRUSTED_INTERNAL caller — same statement,
        // same conflict clause, same transaction (the claim INSERT below must stay atomic with
        // this one, so the service writes on THIS client rather than opening its own). No
        // caller-choice validation runs, and that is the correct call here: `rid` comes from
        // `moduleRoleId()` — derived from the service assignment's OWN module contract, never
        // from request input — and scope_type/scope_id are hardcoded 'company'/the served tenant.
        // There is no (role, scope) pair a caller can steer through this path.
        grantId = await insertGrantRow(c, {
          origin: "trusted_internal",
          targetUserId: userId,
          roleId: rid,
          scopeType: "company",
          scopeId: target,
          managedBy: assignmentId,
          onConflict: "unique_columns",
        });
        const back = (
          await c.query<{ id: string; managed_by: string | null }>(
            `SELECT id, managed_by FROM user_roles
             WHERE user_id = $1 AND role_id = $2 AND scope_type = 'company' AND scope_id = $3`,
            [userId, rid, target],
          )
        ).rows[0];
        grantId = back.managed_by === null ? null : back.id; // a manual row won the race → leave alone
        if (grantId) {
          granted++;
          affected.add(userId);
        }
      } else if (g.managed_by === null) {
        // A2: a manual identical grant exists → skip, record NOTHING (revoke leaves it alone).
        grantId = null;
      } else {
        // Managed by this or another live assignment → just add a refcount claim.
        grantId = g.id;
      }
      if (grantId) {
        desiredGrantIds.add(grantId);
        await c.query(
          `INSERT INTO service_grant_claims (id, tenant_id, assignment_id, user_role_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (assignment_id, user_role_id) WHERE user_role_id IS NOT NULL DO NOTHING`,
          [newId(), target, assignmentId, grantId],
        );
      }
    }

    // ---- removal phase: drop THIS assignment's claims that are no longer desired; delete the
    //      artifact iff that was its LAST claim AND it is reconciler-owned (the deletion guard).
    //
    //      CONCURRENCY (QA V3): two assignments sharing one artifact can be torn down in parallel
    //      transactions. Under READ COMMITTED, a naive "delete my claim → count → delete artifact
    //      if 0" races: each tx still sees the OTHER's uncommitted sibling claim, both count ≥1,
    //      NEITHER deletes → a live grant with zero claims (a permanent, audit-invisible leak).
    //      Fix: SERIALIZE on the artifact. Before touching its claim, lock the artifact row
    //      FOR UPDATE — the second tx blocks there (still holding its own claim, so the FK-RESTRICT
    //      pin guarantees the row exists to lock) until the first commits, then sees the committed
    //      post-delete count. Locks are acquired in a stable artifact-id order across ALL txns so
    //      two overlapping teardowns can never deadlock (consistent lock ordering). ----
    type Removal = { claimId: string; artifactId: string; kind: "grant" | "membership" };
    const claims = (
      await c.query<{ id: string; membership_id: string | null; user_role_id: string | null }>(
        `SELECT id, membership_id, user_role_id FROM service_grant_claims WHERE assignment_id = $1`,
        [assignmentId],
      )
    ).rows;
    const removals: Removal[] = [];
    for (const cl of claims) {
      if (cl.user_role_id && !desiredGrantIds.has(cl.user_role_id)) {
        removals.push({ claimId: cl.id, artifactId: cl.user_role_id, kind: "grant" });
      } else if (cl.membership_id && !desiredMembershipIds.has(cl.membership_id)) {
        removals.push({ claimId: cl.id, artifactId: cl.membership_id, kind: "membership" });
      }
    }
    // Consistent global lock order → no deadlock between overlapping concurrent teardowns.
    removals.sort((a, b) => (a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0));

    for (const rm of removals) {
      // (1) LOCK the artifact FIRST — serializes concurrent teardowns of the same artifact.
      if (rm.kind === "grant") {
        await c.query(`SELECT 1 FROM user_roles WHERE id = $1 FOR UPDATE`, [rm.artifactId]);
      } else {
        await c.query(`SELECT 1 FROM company_memberships WHERE id = $1 FOR UPDATE`, [rm.artifactId]);
      }
      // (2) drop THIS assignment's claim, now inside the serialized section.
      await c.query(`DELETE FROM service_grant_claims WHERE id = $1`, [rm.claimId]);
      // (3) count remaining claims — reflects any sibling tx that committed before us.
      const col = rm.kind === "grant" ? "user_role_id" : "membership_id";
      const remaining = (
        await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM service_grant_claims WHERE ${col} = $1`,
          [rm.artifactId],
        )
      ).rows[0].n;
      // (4) last claim + reconciler-owned ⇒ tear down (guard spares employee/manual rows).
      if (remaining === 0) {
        if (rm.kind === "grant") {
          // P2-04: routed through the choke point (TRUSTED_INTERNAL). Same statement, same
          // `AND managed_by IS NOT NULL` deletion guard — the thing that makes manual and
          // employee rows structurally untouchable from this teardown path (A2) — and still on
          // THIS client, inside the FOR UPDATE-serialized section above.
          const revokedUserId = await revokeManagedGrant(c, rm.artifactId);
          if (revokedUserId) {
            revoked++;
            affected.add(revokedUserId);
          }
        } else {
          const del = await c.query<{ user_id: string }>(
            `UPDATE company_memberships SET status = 'inactive', deleted_at = now(), updated_at = now()
             WHERE id = $1 AND kind = 'service' AND managed_by IS NOT NULL RETURNING user_id`,
            [rm.artifactId],
          );
          if (del.rowCount) affected.add(del.rows[0].user_id);
        }
      }
    }

    // Per-tenant outbox emission (correlationId = assignmentId) for downstream (n8n/graph/audit).
    if (granted || revoked) {
      await emitEvent(c, target, "service_assignment", assignmentId, "service_staff.reconciled", {
        correlationId: assignmentId,
        providerTenantId: provider,
        module: row.module_key,
        status: statusAtRead,
        granted,
        revoked,
        staff: [...want.keys()],
        skipped,
      });
    }
  });

  // Batch session bumps: ONE bump per affected user (D11), not per grant — a holding-wide
  // restructure produces one bump per person, not a bump storm.
  for (const userId of affected) {
    await withGlobal((c) =>
      c.query(`UPDATE users SET session_version = session_version + 1, updated_at = now() WHERE id = $1`, [userId]),
    );
  }

  return {
    assignmentId,
    status: statusAtRead,
    granted,
    revoked,
    orphaned,
    skipped,
    affectedUsers: [...affected],
  };
}

/**
 * Reconcile every live-ish assignment PROVIDED by `providerTenantId` — the entry point for an
 * org_structure.updated event (a chart edit may re-diff many assignments at once).
 */
export async function reconcileProvider(providerTenantId: string): Promise<ReconcileResult[]> {
  if (!config.serviceAssignmentsEnabled) return [];
  const ids = (
    await withTenants([providerTenantId], (c) =>
      c.query<{ id: string }>(
        `SELECT id FROM service_assignments WHERE provider_tenant_id = $1 AND status = ANY($2)`,
        [providerTenantId, LIVE_ISH],
      ),
    )
  ).rows.map((r) => r.id);
  const results: ReconcileResult[] = [];
  for (const id of ids) {
    const r = await reconcileAssignment(id, providerTenantId);
    if (r) results.push(r);
  }
  return results;
}

/**
 * A14 admin-collision: an admin grant/endpoint has landed a MANUAL row on an artifact the
 * reconciler manages. Convert it to manual — clear managed_by AND drop its claims — so a later
 * revoke cannot decrement a now-manual row into deletion. Idempotent. Call from the role-assign
 * path (ORG-7) when an assign collides with a managed user_role; also usable for memberships.
 */
export async function adoptManagedGrantAsManual(
  targetTenantId: string,
  opts: { userRoleId?: string; membershipId?: string },
): Promise<void> {
  await withTenants([targetTenantId], async (c) => {
    if (opts.userRoleId) {
      await c.query(`UPDATE user_roles SET managed_by = NULL WHERE id = $1`, [opts.userRoleId]);
      await c.query(`DELETE FROM service_grant_claims WHERE user_role_id = $1`, [opts.userRoleId]);
    }
    if (opts.membershipId) {
      await c.query(
        `UPDATE company_memberships SET kind = 'employee', managed_by = NULL, updated_at = now() WHERE id = $1`,
        [opts.membershipId],
      );
      await c.query(`DELETE FROM service_grant_claims WHERE membership_id = $1`, [opts.membershipId]);
    }
  });
}

/**
 * Nightly drift/orphan sweep (A7 + A16). Drift INSURANCE: re-reconcile every active/suspended
 * assignment (expected to change zero rows — a nonzero total is real drift and should alert).
 * Escalation: any assignment orphaned longer than the TTL is auto-suspended (grants off, edge
 * kept) so an accidental orphan cannot leave cross-company access standing forever.
 */
export async function sweepDriftAndOrphans(): Promise<{ reconciled: number; drift: number; autoSuspended: number }> {
  if (!config.serviceAssignmentsEnabled) return { reconciled: 0, drift: 0, autoSuspended: 0 };
  const providers = (
    await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL`))
  ).rows.map((r) => r.id);

  let reconciled = 0;
  let drift = 0;
  let autoSuspended = 0;
  const ttlCutoff = new Date(Date.now() - config.serviceOrphanTtlMs);

  for (const provider of providers) {
    const rows = (
      await withTenants([provider], (c) =>
        c.query<{ id: string; status: string; unit_status: string; unit_id: string }>(
          `SELECT sa.id, sa.status, sa.unit_status, sa.unit_id
           FROM service_assignments sa
           WHERE sa.provider_tenant_id = $1 AND sa.status IN ('active','suspended')`,
          [provider],
        ),
      )
    ).rows;
    if (!rows.length) continue;

    // Orphan TTL escalation — flip long-orphaned ACTIVE edges to suspended, then let reconcile strip.
    for (const r of rows) {
      if (r.status !== "active" || r.unit_status !== "orphaned") continue;
      const orphanedSince = (
        await withTenants([provider], (c) =>
          c.query<{ updated_at: Date }>(`SELECT updated_at FROM org_units WHERE id = $1`, [r.unit_id]),
        )
      ).rows[0]?.updated_at;
      if (orphanedSince && orphanedSince < ttlCutoff) {
        const targetId = (
          await withTenants([provider], (c) =>
            c.query<{ target_tenant_id: string }>(
              `SELECT target_tenant_id FROM service_assignments WHERE id = $1`,
              [r.id],
            ),
          )
        ).rows[0].target_tenant_id;
        await withTenants([provider], async (c) => {
          await c.query(`UPDATE service_assignments SET status = 'suspended', suspended_at = now() WHERE id = $1`, [r.id]);
          await emitEvent(c, provider, "service_assignment", r.id, "service_assignment.suspended", {
            correlationId: r.id,
            reason: "orphan_ttl_auto_suspend",
            targetTenantId: targetId,
          });
        });
        autoSuspended++;
      }
    }

    for (const r of rows) {
      const res = await reconcileAssignment(r.id, provider);
      if (res) {
        reconciled++;
        drift += res.granted + res.revoked;
      }
    }
  }
  return { reconciled, drift, autoSuspended };
}
