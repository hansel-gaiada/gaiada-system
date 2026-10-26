// PGL-05/06 (PERMISSION-CONTRACT §52, FRONTEND-BFF-CONTRACT §8) — WHY THIS VIEWER'S APPROVE WOULD BE REFUSED.
//
// The approvals screens used to offer Approve to anyone holding the generic decide right and let the click 403. With
// PV-D46 the refusals are predictable from facts the server already holds, so the read routes say them up front:
// `approveRefusal` on the detail row and on the unified inbox's pending automation/agent items, a typed reason or null.
//
// A HINT, never the authority. The decide gate (`AutomationApprovalsController.decide()`) and the executor's second
// wall decide. The hint fails OPEN on purpose: a probe that errors, or a row past the per-list budget, yields null
// ("not known to be refused"), so the button stays and the decide gate answers. Hiding a button the viewer could use
// would strand the request, which is the worse failure for an inbox.
//
// Separate from approval-self-approval.ts so that file stays import-cycle-free for the executor (this one needs the
// executor's `runApproverCheck` / `toolArgsOf`).
import { withTenants } from "../db";
import type { Principal } from "../rbac/principal";
import { getExecutable } from "./approval-executables";
import { runApproverCheck, toolArgsOf } from "./approval-execute";
import { SELF_APPROVAL_ORIGINS, selfApprovalVerdict } from "./approval-self-approval";

export interface ApproveHintRow {
  origin: string;
  toolName: string;
  impact: string | null | undefined;
  requestedBy: string | null | undefined;
  toolArgs: unknown;
}

/** How many rows of ONE list may run an entry's `approverCheck` for the hint (each is a query and maybe a Cerbos
 *  call). Rows beyond it still get the pure self-approval hint; their entry rule is left to the decide gate. */
export const APPROVER_CHECK_HINT_BUDGET = 50;

/**
 * The typed reason the viewer's approval of this row would be refused with, or null.
 *   1. the generic self-approval rule (pure; always evaluated);
 *   2. the tool's registry `approverCheck`, when it declares one (`countersign_right_required`,
 *      `approver_recorded_this_payment`), run exactly as decide runs it, unless `budget` is spent.
 * `tenantId` is the row's own tenant (the RLS context the check reads under).
 */
export async function approveRefusalHint(
  principal: Principal,
  tenantId: string,
  row: ApproveHintRow,
  budget?: { remaining: number },
): Promise<string | null> {
  const self = selfApprovalVerdict(
    { origin: row.origin, toolName: row.toolName, impact: row.impact, requestedBy: row.requestedBy },
    { userId: principal.userId, actForUserId: principal.actFor?.userId },
  );
  if (!self.ok) return self.reason;
  if (!SELF_APPROVAL_ORIGINS.has(row.origin)) return null;
  const entry = getExecutable(row.toolName);
  if (!entry?.approverCheck || !principal.userId) return null;
  if (budget) {
    if (budget.remaining <= 0) return null;
    budget.remaining -= 1;
  }
  const approverId = principal.userId;
  try {
    const verdict = await withTenants([tenantId], (c) =>
      runApproverCheck(c, entry, toolArgsOf(row.toolArgs), {
        userId: approverId,
        ...(principal.actFor?.userId ? { actForUserId: principal.actFor.userId } : {}),
        assurance: principal.assurance,
      }),
    );
    return verdict.ok ? null : verdict.reason;
  } catch {
    return null;
  }
}
