// The ONE place an approved IAM request turns into a write.
//
// Design: 2026-08-13-iam-phase2-design.md §6.5 (routed overrides) + §11.2's owner end-state (a dept
// head's assignment becomes a REQUEST that HR or company_admin approves). Both are "an IAM exception
// somebody more senior agreed to", both ride `automation_approvals` with `origin='iam'`, both are
// authorized by the same `decide_override` action, and both execute here — told apart by
// `workflow_id` alone.
//
// ── WHY A MODULE RATHER THAN A SECOND BRANCH IN THE DECIDE HANDLER ─────────────────────────────
// `automation-approvals.controller.ts` is a shared route: `automation`, `agent`, `hr` and now `iam`
// rows all pass through it. Every IAM-specific import added there is coupling the next author has to
// reason about, and the override branch alone already pulled the grant choke point into a core
// controller. One exported function keeps that route's IAM knowledge to a single call.
//
// ── WHY IN-BAND, NOT VIA THE D14 REGISTRY ──────────────────────────────────────────────────────
// The executable registry (`core/approval-executables.ts`) is deliberately origin-scoped to
// `automation|agent` — its own doctrine — and the other non-registry origin (HR's leave) executes
// through a module eventHandler, which IAM cannot use because IAM is not a module. So these run
// synchronously inside the decide request, and the HTTP response reflects committed reality.
import { BadRequestException } from "@nestjs/common";
import type { Principal } from "../rbac/principal";
import { newId, withGlobal, withTenants } from "../db";
import { config } from "../config";
import { emitEvent } from "../events/outbox.service";
import { insertGrantRow } from "./grant-write.service";
import { reconcileUser } from "./position-reconciler";

/** The two IAM request kinds, keyed by `automation_approvals.workflow_id`. */
export const IAM_OVERRIDE_WORKFLOW = "iam:override";
export const IAM_POSITION_ASSIGN_WORKFLOW = "iam:position_assign";

export function isIamRequest(origin: string, workflowId: string | null): boolean {
  return origin === "iam" && (workflowId === IAM_OVERRIDE_WORKFLOW || workflowId === IAM_POSITION_ASSIGN_WORKFLOW);
}

export interface IamExecutionResult {
  kind: "override" | "position_assign";
  /** Present for an override: the `user_roles` row that was written (null when already held). */
  grantId?: string | null;
  expiresAt?: string;
  /** Present for a position assignment: the seat that was opened, and what the reconciler did. */
  assignmentId?: string;
  reconciled?: { granted: number; revoked: number } | null;
}

/** D11 — the target's live sessions must see the change on their next request. */
async function bumpSession(userId: string): Promise<void> {
  await withGlobal((c) =>
    c.query(`UPDATE users SET session_version = session_version + 1, updated_at = now() WHERE id = $1`, [userId]),
  );
}

/**
 * Execute an APPROVED IAM request. Called only after the decide handler has flipped the row to
 * `approved` and Cerbos has allowed `decide_override` (which carries the structural requester ≠
 * decider DENY), so this function does not re-check WHO may decide — it enforces WHAT may be written.
 *
 * `decider` is the acting principal, and it matters: the ceiling inside `insertGrantRow` runs against
 * THEIR resolved permissions. That is the whole point of routing an override — the approver's
 * authority backs the grant, never the requester's.
 */
export async function executeApprovedIamRequest(
  tenantId: string,
  approvalId: string,
  workflowId: string,
  toolArgs: unknown,
  decider: Principal,
): Promise<IamExecutionResult> {
  const args = (toolArgs ?? {}) as Record<string, unknown>;

  if (workflowId === IAM_OVERRIDE_WORKFLOW) {
    const targetUserId = typeof args.targetUserId === "string" ? args.targetUserId : "";
    const roleId = typeof args.roleId === "string" ? args.roleId : "";
    if (!targetUserId || !roleId) {
      // A malformed payload must not be swallowed: the row is already `approved`, so a silent no-op
      // would leave a decision on record with nothing behind it.
      throw new BadRequestException("override payload is malformed: targetUserId and roleId are required");
    }
    const rawDays = Number(args.expiresInDays ?? 90);
    const days = Number.isFinite(rawDays) && rawDays > 0 ? rawDays : 90;
    const expiresAt = new Date(Date.now() + days * 86400000).toISOString();

    const grantId = await withGlobal((c) =>
      insertGrantRow(c, {
        origin: "ui",
        targetUserId,
        roleId,
        scopeType: typeof args.scopeType === "string" ? args.scopeType : "company",
        scopeId: typeof args.scopeId === "string" ? args.scopeId : tenantId,
        actorUserId: decider.userId,
        actorPerms: decider.perms,
        tenantId,
        expiresAt,
        originApprovalId: approvalId,
        onConflict: "unique_columns",
      }),
    );
    await bumpSession(targetUserId);
    return { kind: "override", grantId, expiresAt };
  }

  // ── iam:position_assign — the dept head's assignment, once approved (owner end-state, §11.2) ──
  const positionId = typeof args.positionId === "string" ? args.positionId : "";
  const userId = typeof args.userId === "string" ? args.userId : "";
  if (!positionId || !userId) {
    throw new BadRequestException("position-assignment payload is malformed: positionId and userId are required");
  }

  const assignmentId = await withTenants([tenantId], async (c) => {
    // Re-read the seat AT EXECUTION TIME rather than trusting the payload: an approval can sit in the
    // inbox for days, and a position retired in the meantime must not be filled by a stale decision.
    const pos = await c.query<{ status: string }>(
      `SELECT status FROM positions WHERE tenant_id = $1 AND id = $2`,
      [tenantId, positionId],
    );
    if (!pos.rows[0]) throw new BadRequestException("position no longer exists");
    if (pos.rows[0].status !== "active") {
      throw new BadRequestException(`position is ${pos.rows[0].status}; the request is stale and was not applied`);
    }
    const member = await c.query<{ user_id: string }>(
      `SELECT user_id FROM company_memberships
        WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' AND deleted_at IS NULL`,
      [tenantId, userId],
    );
    if (!member.rows[0]) throw new BadRequestException("target is no longer an active member of this company");

    const open = await c.query<{ id: string }>(
      `SELECT id FROM position_assignments
        WHERE tenant_id = $1 AND position_id = $2 AND user_id = $3 AND valid_to IS NULL`,
      [tenantId, positionId, userId],
    );
    if (open.rows[0]) return open.rows[0].id; // idempotent: a re-decided row does not stack seats

    const id = newId();
    await c.query(
      `INSERT INTO position_assignments
         (id, tenant_id, position_id, user_id, valid_from, assigned_by, reason, origin_site)
       VALUES ($1,$2,$3,$4,current_date,$5,$6,$7)`,
      [id, tenantId, positionId, userId, decider.userId,
       typeof args.reason === "string" ? args.reason.slice(0, 200) : "approved assignment request",
       config.originSite],
    );
    await emitEvent(c, tenantId, "position_assignment", id, "position_assignment.created", {
      positionId, userId, viaApproval: approvalId,
    });
    return id;
  });

  // Access follows the seat, here and not on a timer — same as the direct assign path.
  const reconciled = await reconcileUser(tenantId, userId);
  return {
    kind: "position_assign",
    assignmentId,
    reconciled: reconciled ? { granted: reconciled.granted, revoked: reconciled.revoked } : null,
  };
}
