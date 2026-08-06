// T3b — the shared filing core, extracted from `automation-approvals.controller.ts`'s `create()` so
// the confirm-machinery endpoint (`modules/assistant/write-intents.ts`) can file through the EXACT
// same path an n8n workflow does, never a second implementation.
//
// Ticket: T3b, docs/superpowers/plans/2026-08-06-t3b-confirm-machinery-report.md.
// Design: docs/superpowers/plans/2026-08-06-asst-23-unblock-design.md §7.2.2.
//
// ── WHY THIS IS TWO FUNCTIONS, NOT ONE ────────────────────────────────────────────────────────────
// `insertAutomationApprovalRow` is JUST the INSERT — it takes an existing `PoolClient` (already
// inside someone else's transaction/RLS context) and a PRE-GENERATED id, because the confirm
// machinery's single-winner claim needs the claim UPDATE (on `assistant_write_intents`) and this
// INSERT to commit or roll back TOGETHER, in ONE transaction, on the SAME connection — the design's
// requirement #1 ("the claim, the filing INSERT, and the one-time ledger `approval_id` NULL→value
// write must be one transaction"). `fileAutomationApproval` is the pre-T3b shape: it opens its OWN
// `withTenants` transaction for the INSERT, then runs the activity-log write and the decider
// notifications as separate, best-effort side effects — EXACTLY the shape `create()` had before this
// extraction (writeActivity/notifyBestEffort were already separate transactions from the INSERT, so
// nothing about their atomicity changes here). `create()` becomes a thin wrapper over this function;
// the n8n path is therefore byte-identical in behaviour, only the code that runs it moved.
import type { PoolClient } from "pg";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { writeActivity } from "./http";
import { notifyBestEffort } from "./client-notify";
import { resolveAutomationApprovalDeciders } from "./approval-deciders";

export interface FileApprovalInput {
  tenantId: string;
  workflowId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  impact: string;
  reason?: string | null;
  /** 'automation' | 'agent' (and, for the pre-existing hr.controller.ts caller, 'hr' — see
   *  automation-approvals.controller.ts's ORIGINS set; this function does not itself validate the
   *  value, the same way the pre-extraction `create()` left validation to the controller). */
  origin: string;
  agentName?: string | null;
  /** The principal the row is filed AS. For the confirm-machinery caller this is the CHATTING USER
   *  (never the approver — the anti-privilege-amplification invariant `approval-execute.ts` and
   *  `resolve-and-execute`'s `requested_by` gate both depend on). For `create()` it is
   *  `req.principal.userId`, unchanged from before this extraction. */
  requestedBy: string;
}

/** JUST the INSERT, on a caller-supplied client/transaction, with a caller-supplied id. Used by
 *  `fileAutomationApproval` below AND directly by the confirm machinery's atomic claim transaction —
 *  see this file's header for why those two callers need different transaction shapes. */
export async function insertAutomationApprovalRow(
  c: PoolClient,
  id: string,
  input: FileApprovalInput,
): Promise<void> {
  await c.query(
    `INSERT INTO automation_approvals
       (id, tenant_id, workflow_id, tool_name, tool_args, impact, reason, requested_by, origin, agent_name, origin_site)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      input.tenantId,
      input.workflowId,
      input.toolName,
      JSON.stringify(input.toolArgs ?? {}),
      input.impact,
      input.reason ?? null,
      input.requestedBy,
      input.origin,
      input.agentName ?? null,
      config.originSite,
    ],
  );
}

/**
 * The activity-log write + decider notification (MAIL-06) half of filing — split out from the INSERT
 * so a caller whose INSERT already happened on a DIFFERENT connection/transaction (T3b's confirm
 * machinery, `modules/assistant/write-intents.ts`'s `confirmWriteIntent`) can still produce the SAME
 * bell/mail a runner- or n8n-filed row gets, as a separate best-effort step AFTER its own atomic
 * transaction commits — never inside it (nesting a second `withTenants`/connection inside an
 * in-flight transaction is exactly the hazard `insertAutomationApprovalRow` exists to avoid).
 */
export async function notifyApprovalFiled(id: string, input: FileApprovalInput): Promise<void> {
  await writeActivity(input.tenantId, input.requestedBy, "suspended", "automation_approval", id, {
    workflowId: input.workflowId,
    toolName: input.toolName,
    impact: input.impact,
    origin: input.origin,
    agentName: input.agentName ?? null,
  });
  // MAIL-06 (F1 fix): notify the resolved decider set. `module` is 'hr' only for an hr-origin row —
  // every other origin (including 'agent', T3b's own caller) passes undefined, unchanged from
  // `create()`'s pre-extraction behaviour.
  const deciders = await resolveAutomationApprovalDeciders(input.tenantId, input.origin === "hr" ? "hr" : undefined);
  await notifyBestEffort(input.tenantId, input.requestedBy, deciders, "approval.requested", {
    title: input.reason ?? `${input.toolName} (${input.workflowId})`,
    href: `/approvals/${id}`,
    entityType: "automation_approval",
    entityId: id,
    origin: input.origin,
    impact: input.impact,
    tool: input.toolName,
    severity: input.impact === "high" ? "warning" : "info",
  });
}

/**
 * File a new `automation_approvals` row end to end: INSERT (its own transaction) + activity log +
 * decider notification (MAIL-06) — the exact sequence `automation-approvals.controller.ts`'s
 * `create()` ran before this extraction, moved here verbatim so `create()` can become a thin HTTP
 * wrapper without changing what an n8n workflow (or any other direct caller) observes.
 */
export async function fileAutomationApproval(input: FileApprovalInput): Promise<{ id: string; status: "pending" }> {
  const id = newId();
  await withTenants([input.tenantId], (c) => insertAutomationApprovalRow(c, id, input));
  await notifyApprovalFiled(id, input);
  return { id, status: "pending" };
}
