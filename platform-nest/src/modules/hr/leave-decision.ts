// WSD-4: eventHandlers["automation_approval.decided"] — applies a human decision made through the
// EXISTING unified /automation-approvals/:id/decide endpoint (core/automation-approvals.controller.ts,
// no fork) back onto the hr_leave_requests row it was filed for, moves the leave balance on APPROVAL
// (design §3 — used_minutes increments on approval, never on filing), and notifies the subject with
// a deep-link href. Every non-hr-origin decided event is a harmless no-op here (design §2.2's
// tight module=='hr' scoping is mirrored on the write side by this origin check).
import { withTenants } from "../../db";
import { notify } from "../../core/http";
import type { OutboxEvent } from "../../events/types";

interface DecidedPayload {
  decision?: "approved" | "rejected";
  origin?: string;
  decidedBy?: string | null;
  toolArgs?: { leaveRequestId?: string } & Record<string, unknown>;
}

export async function applyLeaveDecision(event: OutboxEvent): Promise<void> {
  const payload = event.payload as DecidedPayload;
  if (payload.origin !== "hr") return;
  const decision = payload.decision;
  if (decision !== "approved" && decision !== "rejected") return;
  const leaveRequestId = payload.toolArgs?.leaveRequestId;
  if (!leaveRequestId) return;

  const tenantId = event.tenantId;
  const newStatus = decision === "approved" ? "approved" : "denied";

  const decided = await withTenants(
    [tenantId],
    async (c) => {
      // Idempotent: only a still-pending row transitions (a redelivered event, or a request the
      // subject cancelled in between, changes nothing on a second pass).
      const upd = await c.query<{
        subject_user_id: string; minutes: number; leave_type: string; starts_on: string;
      }>(
        `UPDATE hr_leave_requests
           SET status = $2, decided_by = $3, decided_at = now(), approval_id = $4, updated_at = now()
         WHERE id = $1 AND status = 'pending'
         RETURNING subject_user_id, minutes, leave_type, starts_on`,
        [leaveRequestId, newStatus, payload.decidedBy ?? null, event.entityId],
      );
      const row = upd.rows[0];
      if (!row) return null;
      if (newStatus === "approved") {
        const year = new Date(row.starts_on).getUTCFullYear();
        await c.query(
          `INSERT INTO hr_leave_balances (id, tenant_id, subject_user_id, year, leave_type, allocated_minutes, used_minutes)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 0, $5)
           ON CONFLICT (tenant_id, subject_user_id, year, leave_type)
           DO UPDATE SET used_minutes = hr_leave_balances.used_minutes + EXCLUDED.used_minutes`,
          [tenantId, row.subject_user_id, year, row.leave_type, row.minutes],
        );
      }
      return row;
    },
    { modules: ["hr"] },
  );
  if (!decided) return;

  await notify(tenantId, decided.subject_user_id, null, "hr.leave.decided", {
    title: newStatus === "approved" ? "Your leave request was approved" : "Your leave request was denied",
    severity: newStatus === "approved" ? "info" : "warning",
    entityType: "hr_leave_request",
    entityId: leaveRequestId,
    href: `/hr/leave/${leaveRequestId}`,
    leaveRequestId,
    decision: newStatus,
  });
}
