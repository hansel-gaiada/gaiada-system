// SMM-17 — approval-execution -> `SocialPublisher.sendReply`, and the transactional stamp. Reuses
// SMM-10's own shape (`dispatch.ts`) rather than reinventing it: two phases, a lock-held precondition
// re-run with no network I/O, then the network call OUTSIDE any transaction, then a SINGLE guarded
// UPDATE that stamps `approval_id` + `args_sha256`-checked outcome together. Read `dispatch.ts`'s
// header first — every "why" below is that file's, applied to a reply instead of a publish.
//
// ── WHY THIS FILE RE-RUNS THE PRECONDITION A SECOND TIME ────────────────────────────────────────
// Identical reasoning to `dispatch.ts`'s own: the grant the hub verified is short-lived and the call
// this file backs happens over a SEPARATE HTTP hop after the executor's own transaction has already
// committed and released its advisory lock. A concurrent second approval for the same message, or a
// fast edit racing the network hop, could land in that gap. So this file takes the SAME advisory
// lock namespace (`APPROVAL_EXEC_LOCK_NS`) and re-runs `evaluateReplyPrecondition` a second time.
//
// ── THE APPROVAL-ID PUZZLE — resolved the SAME way `dispatch.ts` resolves it ──────────────────────
// mcp-hub does not forward the verified grant's `approvalId` to the platform handler, so this
// endpoint resolves the ONE `automation_approvals` row it is executing for: `tool_name =
// social.sendReply`, `execution_status = 'executing'`, `tool_args @> {messageId}`. Ambiguity refuses
// closed (`REPLY_DISPATCH_REFUSAL.approvalNotResolvable`) rather than guessing which row to spend.
//
// ── THE TRANSACTIONAL STAMP ─────────────────────────────────────────────────────────────────────
// `approval_id` and `external_id` land in the SAME UPDATE, and ONLY once `SocialPublisher.sendReply`
// has ALREADY returned (or thrown). Never "claim first, dispatch second" — see `dispatch.ts`'s own
// header for why that ordering would make a network failure read as a false-positive "grant spent,
// nothing sent" OR, worse, could let a genuinely-sent reply's grant look unconsumed. The only
// pre-network claim taken is the advisory lock, released once the precondition-check transaction
// commits — by the time a concurrent second call gets that lock, this row's state has already moved.
//
// ── ON FAILURE, THE APPROVAL IS STILL CONSUMED ─────────────────────────────────────────────────────
// Once `sendReply` has been attempted (succeeded OR thrown), the approval is spent: a `failed`
// message carries `approval_id` in the SAME final UPDATE, for the SAME `neverAutoRetry` reason
// `dispatch.ts` gives — a human must look at why it failed and file a fresh approval, never get an
// unattended second shot at a reply whose outcome is ambiguous.
import type { PoolClient } from "pg";
import { withTenants } from "../../db";
import { emitEvent } from "../../events/outbox.service";
import { writeActivity } from "../../core/http";
import { APPROVAL_EXEC_LOCK_NS } from "../../core/approval-execute";
import { declareSocialModuleScope } from "./publish-precondition";
import {
  SOCIAL_REPLY_TOOL, REPLY_REFUSAL, evaluateReplyPrecondition, loadReplyChain,
  type ReplyPreconditionStage, type ReplyRefusalReason, type ReplyChain,
} from "./reply-precondition";
import { replyDispatchArgs } from "./canonical-args";
import { resolveDispatchOrgHandle } from "./publisher/provisioning";
import { invokePublisher } from "./publisher/registry";
import { SocialPublisherError } from "./publisher/types";

/** Refusals that belong to THIS file's own routing question, not to the four-stage precondition —
 *  the SAME separation `DISPATCH_REFUSAL` keeps from `PUBLISH_REFUSAL`. */
export const REPLY_DISPATCH_REFUSAL = {
  /** Zero, or more than one, `executing` `social.sendReply` approval names this message. */
  approvalNotResolvable: "approval_not_resolvable",
  /** The final stamp's own guarded UPDATE affected zero rows — the narrowest possible race,
   *  reported CRITICAL so the caller notifies loudly (mirrors `dispatch.ts`'s `stampRaceLost`). */
  stampRaceLost: "reply_stamp_race_lost",
  /** The resolved driver does not advertise `inbox_reply`, or has no `sendReply` member at all —
   *  the SAME "unsupported vs empty" distinction `inbox-sync-job.ts` draws for `listComments`. An
   *  unsupported network and a failed send are different facts: this token is raised BEFORE any
   *  call is attempted, never folded into `sendFailed` below. */
  capabilityUnsupported: "capability_unsupported",
  /** `SocialPublisher.sendReply` itself threw (unreachable, HTTP error, ambiguous response). The
   *  approval is still consumed; see this file's header. */
  sendFailed: "reply_send_failed",
} as const;
export type ReplyDispatchRefusalReason = (typeof REPLY_DISPATCH_REFUSAL)[keyof typeof REPLY_DISPATCH_REFUSAL];

export type ReplyDispatchVerdict =
  | { ok: true; externalId: string; network: string }
  | {
      ok: false;
      stage: ReplyPreconditionStage | "dispatch";
      reason: ReplyRefusalReason | ReplyDispatchRefusalReason;
      critical?: boolean;
    };

interface ReplyForDispatch {
  tenant_id: string;
  thread_id: string;
  account_id: string;
  body: string;
  args_sha256: string | null;
}

async function loadReplyForDispatch(c: PoolClient, messageId: string): Promise<ReplyForDispatch | null> {
  const { rows } = await c.query<ReplyForDispatch>(
    `SELECT m.tenant_id AS tenant_id, m.thread_id AS thread_id, t.account_id AS account_id,
            m.body AS body, m.args_sha256 AS args_sha256
       FROM social_inbox_messages m
       JOIN social_inbox_threads t ON t.id = m.thread_id AND t.tenant_id = m.tenant_id
      WHERE m.id = $1 AND m.direction = 'out'`,
    [messageId],
  );
  // `account_id` above is the THREAD's account (messages carry no account_id of their own; the
  // thread is the join key), matching `evaluateReplyPrecondition`'s own resolution.
  return rows[0] ?? null;
}

async function resolveExecutingApprovalId(c: PoolClient, tenantId: string, messageId: string): Promise<string | null> {
  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM automation_approvals
      WHERE tenant_id = $1 AND tool_name = $2 AND execution_status = 'executing'
        AND tool_args @> $3::jsonb`,
    [tenantId, SOCIAL_REPLY_TOOL, JSON.stringify({ messageId })],
  );
  return rows.length === 1 ? rows[0].id : null;
}

interface PreconditionClaim {
  approvalId: string;
  chain: ReplyChain;
  reply: ReplyForDispatch;
}

type PreconditionOutcome =
  | { kind: "ok"; claim: PreconditionClaim }
  | { kind: "refused"; stage: ReplyPreconditionStage; reason: ReplyRefusalReason }
  | { kind: "unresolved" }
  | { kind: "not_found" };

/** Phase 1: lock + re-run the precondition + resolve the consuming approval. Mirrors
 *  `dispatch.ts#checkPreconditionAndResolveApproval` exactly, for a message instead of a variant. */
async function checkPreconditionAndResolveApproval(tenantId: string, messageId: string): Promise<PreconditionOutcome> {
  return withTenants([tenantId], async (c) => {
    await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [APPROVAL_EXEC_LOCK_NS, messageId]);
    await declareSocialModuleScope(c);

    const reply = await loadReplyForDispatch(c, messageId);
    if (!reply) return { kind: "not_found" as const };

    const args = replyDispatchArgs({
      tenantId: reply.tenant_id, id: messageId, threadId: reply.thread_id, accountId: reply.account_id, body: reply.body,
    });
    const verdict = await evaluateReplyPrecondition(c, args as unknown as Record<string, unknown>);
    if (!verdict.ok) return { kind: "refused" as const, stage: verdict.stage, reason: verdict.reason };

    const approvalId = await resolveExecutingApprovalId(c, tenantId, messageId);
    if (!approvalId) return { kind: "unresolved" as const };

    const chain = await loadReplyChain(c, messageId);
    /* istanbul ignore next — the precondition above already proved this chain resolves */
    if (!chain) return { kind: "not_found" as const };
    return { kind: "ok" as const, claim: { approvalId, chain, reply } };
  });
}

/** Phase 3: the transactional stamp. Guarded by the SAME conditions the precondition re-derives
 *  (`status='approved' AND approval_id IS NULL AND external_id IS NULL AND args_sha256 matches`). */
async function stampReplyOutcome(
  tenantId: string,
  messageId: string,
  approvalId: string,
  expectedHash: string,
  outcome: { status: "sent" | "failed"; externalId: string | null; lastError: string | null },
): Promise<boolean> {
  return withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    const upd = await c.query(
      `UPDATE social_inbox_messages
          SET approval_id = $2, external_id = $3, status = $4, last_error = $5, updated_at = now()
        WHERE id = $1 AND status = 'approved' AND approval_id IS NULL AND external_id IS NULL AND args_sha256 = $6`,
      [messageId, approvalId, outcome.externalId, outcome.status, outcome.lastError, expectedHash],
    );
    return (upd.rowCount ?? 0) > 0;
  });
}

/** THE ENTRY POINT. Called by `social.controller.ts`'s send endpoint (the handler
 *  `social.sendReply`'s `pathTemplate` fronts) — reachable in the ordinary flow the SAME way
 *  `dispatchPublish` is: only through the D14 executor's re-drive. `actorId` is the OBO-resolved
 *  principal's own user id, never the approver (invariant 1, `core/approval-execute.ts`). */
export async function dispatchApprovedReply(
  tenantId: string,
  messageId: string,
  actorId: string | null,
): Promise<ReplyDispatchVerdict> {
  const outcome = await checkPreconditionAndResolveApproval(tenantId, messageId);
  if (outcome.kind === "not_found") {
    return { ok: false, stage: "scope", reason: REPLY_REFUSAL.messageNotFound };
  }
  if (outcome.kind === "refused") {
    return { ok: false, stage: outcome.stage, reason: outcome.reason };
  }
  if (outcome.kind === "unresolved") {
    return { ok: false, stage: "dispatch", reason: REPLY_DISPATCH_REFUSAL.approvalNotResolvable };
  }

  const { approvalId, chain, reply } = outcome.claim;
  const expectedHash = reply.args_sha256 as string; // non-null: the hash stage already passed

  // ── Phase 2: the network call. OUTSIDE any transaction and outside the advisory lock — same
  // discipline `dispatch.ts`'s own network-call phase holds, for the same reason (never hold a
  // Postgres lock across an external HTTP round trip).
  let sent: { externalId: string } | null = null;
  let dispatchError: string | null = null;
  let dispatchReason: ReplyDispatchRefusalReason = REPLY_DISPATCH_REFUSAL.sendFailed;
  try {
    // The SAME (network, capability) switch `inbox-sync-job.ts` resolves through for `inbox_read` —
    // never a plain `openOrg`, so a future config override or a future `direct` sendReply
    // implementation is routed correctly without this file changing at all.
    const { driver, handle } = await resolveDispatchOrgHandle(
      tenantId, { org: chain.org, network: chain.network, accountId: chain.accountId }, "inbox_reply",
    );
    // The "unsupported vs empty" distinction, checked BEFORE any call is attempted — the SAME
    // discipline `inbox-sync-job.ts` uses for `listComments`/`inbox_read`. An unsupported network
    // and a failed send are different facts (this ticket's own instruction), so this refuses with
    // its OWN token rather than falling through to `sendFailed`.
    if (!driver.capabilities.has("inbox_reply") || typeof driver.sendReply !== "function") {
      dispatchReason = REPLY_DISPATCH_REFUSAL.capabilityUnsupported;
      dispatchError = `driver '${driver.key}' does not advertise inbox_reply for network '${chain.network}'`;
    } else {
      sent = await invokePublisher(
        { op: "sendReply", org: handle, network: chain.network },
        () => driver.sendReply!(handle, {
          integrationId: chain.integrationId,
          externalThreadId: chain.externalThreadId,
          body: reply.body,
          approvalId,
        }),
      );
    }
  } catch (err) {
    // `resolveDispatchOrgHandle`'s own eager, data-driven refusal (a configured override naming a
    // (network, capability) pair the resolved driver does not actually cover) raises the SAME
    // `capability_unsupported` fact the in-block check above does, one layer up — counted the same
    // way, never folded into the generic `sendFailed`.
    if (err instanceof SocialPublisherError && err.code === "capability_unsupported") {
      dispatchReason = REPLY_DISPATCH_REFUSAL.capabilityUnsupported;
    } else {
      dispatchReason = REPLY_DISPATCH_REFUSAL.sendFailed;
    }
    dispatchError = err instanceof SocialPublisherError ? `${err.code}: ${err.message}` : (err as Error)?.message ?? "unknown send error";
  }

  const stamped = await stampReplyOutcome(tenantId, messageId, approvalId, expectedHash, {
    status: sent ? "sent" : "failed",
    externalId: sent?.externalId ?? null,
    lastError: dispatchError,
  });

  if (!stamped) {
    await withTenants([tenantId], (c) =>
      emitEvent(c, tenantId, "social_post_variant", messageId, "social.post.failed", {
        reason: REPLY_DISPATCH_REFUSAL.stampRaceLost, network: chain.network, threadId: chain.threadId,
        externalId: sent?.externalId ?? null,
      }),
    );
    if (actorId) {
      await writeActivity(tenantId, actorId, "refused", "social_inbox_message", messageId, {
        reason: REPLY_DISPATCH_REFUSAL.stampRaceLost, critical: true,
      });
    }
    return { ok: false, stage: "dispatch", reason: REPLY_DISPATCH_REFUSAL.stampRaceLost, critical: true };
  }

  if (!sent) {
    await withTenants([tenantId], (c) =>
      emitEvent(c, tenantId, "social_post_variant", messageId, "social.post.failed", {
        reason: dispatchReason, network: chain.network, threadId: chain.threadId, detail: dispatchError,
      }),
    );
    if (actorId) {
      await writeActivity(tenantId, actorId, "failed", "social_inbox_message", messageId, { detail: dispatchError });
    }
    return { ok: false, stage: "dispatch", reason: dispatchReason };
  }

  await withTenants([tenantId], (c) =>
    emitEvent(c, tenantId, "social_post_variant", messageId, "social.post.dispatched", {
      network: chain.network, threadId: chain.threadId, externalId: sent!.externalId,
    }),
  );
  if (actorId) {
    await writeActivity(tenantId, actorId, "dispatched", "social_inbox_message", messageId, {
      network: chain.network, externalId: sent.externalId,
    });
  }
  return { ok: true, externalId: sent.externalId, network: chain.network };
}
