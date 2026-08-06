// T3b — the confirm-before-file machinery: the state machine behind
// `POST …/tool-calls/:callId/confirm` / `.../dismiss`, plus the GET-thread lazy reap.
//
// Ticket: T3b, docs/superpowers/plans/2026-08-06-t3b-confirm-machinery-report.md.
// Design: docs/superpowers/plans/2026-08-06-asst-23-unblock-design.md §7.2 — §7.2.3 is the ruled
// state machine this file implements; read that section before changing anything here.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// THE FIVE INVARIANTS THIS FILE EXISTS TO HOLD (restated from the ticket, kept next to the code)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 1. SINGLE-WINNER CLAIM. The claim UPDATE below (`WHERE … AND status = 'draft' AND expires_at >
//    now()`), the `automation_approvals` INSERT, and the intent row's own `approval_id` NULL→value
//    write are all issued on the SAME `PoolClient` inside the caller's ONE `withTenants` transaction
//    (never a nested `withTenants` — see `core/approval-filing.ts`'s `insertAutomationApprovalRow`,
//    which takes a client instead of opening its own). A second, concurrent claim on the identical
//    row loses the UPDATE's row lock and matches ZERO rows — Postgres's own row-level locking is the
//    exclusivity mechanism, not an application-level check-then-write.
// 2. THE ARGS. `tool_args` is read from THIS UPDATE's own `RETURNING`, never re-derived, never
//    re-composed — the row the human is about to see filed is byte-identical to what the model
//    proposed and the owner saw (redacted) in the chip. Scrubbed to NULL in the SAME transaction the
//    instant the row leaves 'draft', in every direction (filed/dismissed/expired).
// 3. AUTHORITY. `requestedBy` is threaded through from the ROUTE'S authenticated principal
//    (`req.principal.userId` in `assistant.controller.ts`) — never read from this row, never a body
//    field — and becomes `automation_approvals.requested_by`, which is what keeps the D14 executor's
//    re-drive principal and `resolve-and-execute`'s `requested_by` gate intact.
// 4. FILING EXTRACTION. The INSERT itself is `core/approval-filing.ts`'s `insertAutomationApprovalRow`
//    — the SAME function `fileAutomationApproval` (the n8n/`create()` path) calls — so a confirmed
//    row is byte-for-byte shape-identical to a runner-filed one; the matching/executor/grant chains
//    downstream need zero changes.
// 5. EXPIRY. TTL is config-driven (`config.assistantIntentTtlMs`), lazily reaped: the claim's own
//    `expires_at > now()` conjunct refuses an expired draft structurally, and `reapExpiredIntents`
//    (called from `GET thread`) opportunistically flips PAST-expiry drafts to 'expired' and scrubs
//    `tool_args` in the SAME UPDATE. No background job anywhere in this file.
import type { PoolClient } from "pg";
import { newId } from "../../db";
import { config } from "../../config";
import { insertAutomationApprovalRow, type FileApprovalInput } from "../../core/approval-filing";

export type { FileApprovalInput };

export type WriteIntentStatus = "draft" | "filed" | "dismissed" | "expired";

export interface ApprovalJoin {
  status: string;
  executionStatus: string;
  executionError: string | null;
}

export interface ConfirmOrDismissOk {
  outcome: "ok";
  intentId: string;
  status: WriteIntentStatus;
  approvalId: string | null;
  approval: ApprovalJoin | null;
  /** True only when THIS call's own claim won and just filed the row (never on an idempotent replay
   *  of an already-filed row). The controller uses this to decide whether to run the (best-effort,
   *  post-commit) decider notification exactly once per filing, never once per confirm request. */
  justFiled: boolean;
  /** Present only alongside `justFiled: true` — what the controller passes to
   *  `core/approval-filing.ts`'s `notifyApprovalFiled` AFTER this transaction commits. */
  notifyInput?: FileApprovalInput;
}

/**
 * NEITHER negative outcome throws from inside this file, ON PURPOSE — see `resolveLostClaim`'s own
 * header for why: a thrown exception inside the caller's `withTenants` transaction ROLLS BACK
 * everything that transaction did, including the very reap-UPDATE that flipped a stale draft to
 * 'expired'. The CONTROLLER (`assistant.controller.ts`), reading this discriminant AFTER
 * `withTenants(...)` has already returned (i.e. AFTER the transaction committed), is the one place
 * that turns `not_found`/`conflict` into the actual `NotFoundException`/`ConflictException` HTTP
 * response — by which point every DB write this file made is already durable.
 */
export type ConfirmOrDismissOutcome =
  | ConfirmOrDismissOk
  | { outcome: "not_found" }
  | { outcome: "conflict"; status: WriteIntentStatus };

interface CurrentIntentRow {
  id: string;
  status: WriteIntentStatus;
  approvalId: string | null;
  expiresAt: string;
}

/** The SAME shape `assistant.controller.ts`'s `fetchToolCallsByMessage` joins for a filed row — kept
 *  as one function so the two call sites (this file's idempotent/dismiss responses, and the GET
 *  thread join) can never describe an approval's state differently. */
async function fetchApprovalJoin(c: PoolClient, approvalId: string): Promise<ApprovalJoin | null> {
  const { rows } = await c.query<{ status: string; execution_status: string; execution_error: string | null }>(
    `SELECT status, execution_status, execution_error FROM automation_approvals WHERE id = $1`,
    [approvalId],
  );
  const row = rows[0];
  return row ? { status: row.status, executionStatus: row.execution_status, executionError: row.execution_error } : null;
}

async function fetchCurrentIntent(c: PoolClient, toolCallId: string, threadId: string): Promise<CurrentIntentRow | null> {
  const { rows } = await c.query<{ id: string; status: WriteIntentStatus; approval_id: string | null; expires_at: string }>(
    `SELECT id, status, approval_id, expires_at FROM assistant_write_intents WHERE tool_call_id = $1 AND thread_id = $2`,
    [toolCallId, threadId],
  );
  const row = rows[0];
  return row ? { id: row.id, status: row.status, approvalId: row.approval_id, expiresAt: row.expires_at } : null;
}

/** Lazily flips ONE intent row to 'expired' + scrubs `tool_args`, iff it is still 'draft' and past
 *  its TTL. A no-op (0 rows affected) for every other state — safe to call speculatively. */
async function reapOneIfExpired(c: PoolClient, intentId: string): Promise<boolean> {
  const r = await c.query(
    `UPDATE assistant_write_intents SET status = 'expired', tool_args = NULL
       WHERE id = $1 AND status = 'draft' AND expires_at <= now()`,
    [intentId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Resolve a claim that this request LOST (the UPDATE in `confirmWriteIntent`/`dismissWriteIntent`
 * matched zero rows) into either an idempotent success (the row already reached THIS action's own
 * target state — a double-click or a replay) or a `conflict` outcome (the row is terminal in the
 * OPPOSITE direction, or expired). `action` is which endpoint is asking, because the two endpoints
 * disagree about which terminal status is "success" vs "conflict".
 *
 * Returns, never throws (see `ConfirmOrDismissOutcome`'s own header on why: this function's own
 * reap-on-expiry UPDATE must survive even when the overall outcome is a conflict, and a thrown
 * exception here would roll back the transaction that UPDATE just ran in).
 */
async function resolveLostClaim(
  c: PoolClient,
  toolCallId: string,
  threadId: string,
  action: "confirm" | "dismiss",
): Promise<ConfirmOrDismissOutcome> {
  let current = await fetchCurrentIntent(c, toolCallId, threadId);
  if (!current) return { outcome: "not_found" };

  // The claim's own `expires_at > now()` conjunct is what would have refused a genuinely-expired
  // draft — reap it now (same "opportunistic, lazy" idiom `reapExpiredIntents` uses on GET thread) so
  // this request's own response is consistent with what a following GET thread would show, and so a
  // second confirm/dismiss attempt against the same stale row does not need to reap it again.
  if (current.status === "draft") {
    const reaped = await reapOneIfExpired(c, current.id);
    if (reaped) current = { ...current, status: "expired" };
    // else: still draft, not yet expired — the claim's `status = 'draft' AND expires_at > now()`
    // predicate matched an identical WHERE, so losing the claim while landing here means a genuine
    // programming error (e.g. a mismatched toolCallId/threadId pair racing something else), not a
    // reachable product state. Fall through to the generic conflict below rather than silently
    // succeeding.
  }

  const myTarget: WriteIntentStatus = action === "confirm" ? "filed" : "dismissed";
  if (current.status === myTarget) {
    // Idempotent: this row already reached the state THIS action wants. Double-click / replay.
    // `justFiled: false` — the notification for a 'filed' outcome already ran on whichever request
    // actually won the claim; this one must NOT double-notify.
    const approval = current.approvalId ? await fetchApprovalJoin(c, current.approvalId) : null;
    return { outcome: "ok", intentId: current.id, status: current.status, approvalId: current.approvalId, approval, justFiled: false };
  }

  // Terminal in some OTHER direction (or the "still draft, not expired" fallback above) — refused,
  // typed, never silently mapped onto a success. The CALLER (assistant.controller.ts, outside this
  // transaction) is what turns this into a 409 with a message naming `current.status` — see this
  // function's header on why the throw must not happen here.
  return { outcome: "conflict", status: current.status };
}

/**
 * T3b's central operation (§7.2.3). Claims a 'draft' intent, atomically files it through the SAME
 * `insertAutomationApprovalRow` the n8n/runner path uses, and scrubs the intent's own copy of the
 * real args — all on `c`, inside the caller's transaction (`assistant.controller.ts`'s
 * `withTenants([tenantId], …, {modules:['assistant']})`).
 *
 * `requestedBy` MUST be the route's own authenticated principal (never read off the intent row,
 * even though the intent's `owner_user_id` should always equal it under normal operation) — passing
 * it explicitly is what makes "the filing is attributed to the chatting user" a property of the
 * CALLER, not an assumption this function makes about data it did not itself validate.
 */
export async function confirmWriteIntent(
  c: PoolClient,
  params: { tenantId: string; threadId: string; toolCallId: string; requestedBy: string },
): Promise<ConfirmOrDismissOutcome> {
  const approvalId = newId();
  const claim = await c.query<{ id: string; toolArgs: unknown; toolName: string; impact: string; agent: string }>(
    `UPDATE assistant_write_intents
        SET status = 'filed', approval_id = $3
      WHERE tool_call_id = $1 AND thread_id = $2 AND status = 'draft' AND expires_at > now()
      RETURNING id, tool_args AS "toolArgs", tool_name AS "toolName", impact, agent`,
    [params.toolCallId, params.threadId, approvalId],
  );
  if ((claim.rowCount ?? 0) === 0) {
    return resolveLostClaim(c, params.toolCallId, params.threadId, "confirm");
  }

  const row = claim.rows[0];
  const fileInput: FileApprovalInput = {
    tenantId: params.tenantId,
    workflowId: row.agent,
    toolName: row.toolName,
    // The REAL args, straight from THIS claim's own RETURNING — never re-derived, never re-composed
    // (invariant #2 above). `{}` only if the row genuinely never carried an object (defensive; every
    // draft is written with a real args object by the broker's harvest).
    toolArgs: (row.toolArgs && typeof row.toolArgs === "object" ? row.toolArgs : {}) as Record<string, unknown>,
    impact: row.impact,
    reason: `assistant write proposal (${row.toolName}), confirmed by the requesting user`,
    origin: "agent",
    agentName: row.agent,
    requestedBy: params.requestedBy,
  };
  await insertAutomationApprovalRow(c, approvalId, fileInput);
  // Scrub in the SAME transaction, immediately after the row that consumed the real args exists —
  // never merely "not selected" going forward, genuinely NULL.
  await c.query(`UPDATE assistant_write_intents SET tool_args = NULL WHERE id = $1`, [row.id]);

  // A freshly-inserted row's own column DEFAULTs (0014/0078) — asserted, not guessed: `status`
  // defaults 'pending', `execution_status` defaults 'not_applicable'. Read back rather than
  // hardcoded, so a future default change cannot silently drift this response out of sync with what
  // a GET thread would show one request later.
  const approval = await fetchApprovalJoin(c, approvalId);
  // `justFiled: true` + `notifyInput` — the controller runs `notifyApprovalFiled` with THIS input
  // AFTER this transaction commits (never inside it — see this file's header invariant #1 and
  // `core/approval-filing.ts`'s own doc on why the notify half is a separate, best-effort step).
  return { outcome: "ok", intentId: row.id, status: "filed", approvalId, approval, justFiled: true, notifyInput: fileInput };
}

/** The dismiss half — same claim idiom, opposite target status, no filing. */
export async function dismissWriteIntent(
  c: PoolClient,
  params: { threadId: string; toolCallId: string },
): Promise<ConfirmOrDismissOutcome> {
  const claim = await c.query<{ id: string }>(
    `UPDATE assistant_write_intents
        SET status = 'dismissed', tool_args = NULL
      WHERE tool_call_id = $1 AND thread_id = $2 AND status = 'draft' AND expires_at > now()
      RETURNING id`,
    [params.toolCallId, params.threadId],
  );
  if ((claim.rowCount ?? 0) === 0) {
    return resolveLostClaim(c, params.toolCallId, params.threadId, "dismiss");
  }
  return { outcome: "ok", intentId: claim.rows[0].id, status: "dismissed", approvalId: null, approval: null, justFiled: false };
}

/**
 * Lazy reap, thread-wide (§7.2.3's "no background job" idiom applied at GET-thread scope instead of
 * per-intent). Called BEFORE `assistant.controller.ts`'s card-state join reads `assistant_write_intents`
 * — flips every past-expiry 'draft' row on this thread to 'expired' and scrubs `tool_args`, in ONE
 * UPDATE, so the join that follows never sees a stale draft it should have refused as expired.
 */
export async function reapExpiredIntents(c: PoolClient, threadId: string): Promise<void> {
  await c.query(
    `UPDATE assistant_write_intents SET status = 'expired', tool_args = NULL
       WHERE thread_id = $1 AND status = 'draft' AND expires_at <= now()`,
    [threadId],
  );
}

/** Per-message intent state for the GET-thread card-state join — see `assistant.controller.ts`'s
 *  `fetchToolCallsByMessage`, extended to LEFT JOIN this table by `tool_call_id`. Kept as a named type
 *  here (not inline in the controller) so the wire shape has one definition. */
export interface ToolCallIntent {
  status: WriteIntentStatus;
  expiresAt: string;
}

/** Config-driven TTL, in ms, for a fresh draft's `expires_at`. Exported so the broker's harvest
 *  (`assistant.controller.ts`'s stream handler) computes the SAME value this module's own doc header
 *  and the migration's column comment describe — one source, not a second copy of the default. */
export function intentTtlMs(): number {
  return config.assistantIntentTtlMs;
}
