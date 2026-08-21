// SMM-17 — the reply gate's server-side re-evaluation, and its own typed refusal vocabulary.
//
// Design: docs/blueprints/smm-design-addendum-2026-08-12.md, SMM-17 row as AMENDED by D-14's own
// extension to replies: "a reply is an outbound public write, so it takes the same discipline as a
// publish: draft -> WS4 approval -> send, with its own executable-approval registry entry and its
// own precondition." This file is that precondition, built by REUSING SMM-09's pattern rather than
// reinventing it — read `publish-precondition.ts`'s header first; every design choice below is that
// file's, carried over deliberately, with the differences named where they differ and why.
//
// ── WHAT THIS FILE IS ───────────────────────────────────────────────────────────────────────────
// `core/approval-executables.ts` registers `social.sendReply` as a D14 executable approval, exactly
// the way it registers `social.publishPost`. Its `precondition` is `evaluateReplyPrecondition`
// below: a human (or an agent, WS4-suspended) decided to send this reply at T; the executor runs at
// T+minutes-or-hours with nobody standing by; between those two instants the message may have been
// edited, the account may have been disconnected, the client's engagement may have turned the reply
// dial off, or — the one risk this ticket's brief asks about by name — the comment this reply
// answers may have been purged off the retention clock. A verdict of `{ok:false}` means the
// executor NEVER calls the hub — no tool call, no grant spent, no reply sent.
//
// It is sited in the MODULE, not in `core/`, for the SAME reason `publish-precondition.ts` is:
// the domain knowledge (which engagement's `tool_scope` governs a thread, what "the source has
// expired" means) is the module's, and the registry entry should stay a thin, auditable binding of
// (lockKey, precondition) rather than a second home for social-media rules.
//
// ── WHY THIS IS A SEPARATE FILE, AND A SEPARATE VOCABULARY, NOT PUBLISH_REFUSAL WIDENED ──────────
// `DISPATCH_REFUSAL` (dispatch.ts) and `CLIENT_REVIEW_REFUSAL` (client-review.ts) both drew this
// same line already: a reply and a publish are different actions with different failure shapes (a
// reply has no quota/budget/creator-info stage; it has a retention-purge stage a publish never
// needs), and folding a reply-specific token into `PUBLISH_REFUSAL` would give the estate two
// unrelated meanings behind one shared vocabulary — exactly what this program's own instruction
// forbids. `REPLY_REFUSAL` below is its own small, closed set, kept apart the same way those two are.
//
// ── THE ORDER IS THE CONTRACT, MIRRORING PUBLISH's OWN REASONING ─────────────────────────────────
// scope -> hash -> unconsumed -> retention.
//   * `scope` first, for the SAME reason publish puts it first: "may this content reach this
//     account/network at all" is the question whose wrong answer is a reply going out under an
//     account that should never have been allowed to speak for this engagement.
//   * `hash` before `unconsumed`, for the SAME reason publish orders them that way: until the hash
//     matches we do not know the row in front of us is the content that was approved.
//   * `retention` LAST, deliberately — mirroring D-22's own placement of `creator_info` last in the
//     publish chain. It is the check whose answer is most likely to have changed between approval
//     and execution (a purge sweep runs on its own clock, independent of anything a human did to
//     this message), and running it last means every other, more-structural refusal has already
//     been spent: an operator reading `precondition_failed: source_content_purged` knows the ONLY
//     remaining obstacle was the retention clock, not that it happened to be checked first.
//
// ── THE RETENTION QUESTION, ANSWERED (this ticket's own named design question) ────────────────────
// If a draft reply quotes or embeds the comment it answers, that quoted text is subject to
// LinkedIn's SAME 48h activity-content cap the comment itself carries (addendum §A4e) — a copy is
// still a representation of the same personal content, the same reasoning SMM-16's migration
// applied to a sentiment/category/urgency label distilled from that text. We cannot inspect free
// text to prove a given reply does NOT quote the source (an unreliable, gameable check even if we
// tried), so the answer mirrors D-22's TikTok doctrine exactly: FAIL CLOSED ON UNKNOWN. The instant
// `social_inbox_threads.activity_content_purged_at` is set on the thread this message answers, an
// approved-but-unsent draft refuses `source_content_purged` — never silently sent on the assumption
// that its own text happened not to quote anything. This needs NO schema change: it reads the
// EXISTING column SMM-36's purge already maintains (`inbox-retention-job.ts`), so there is no second
// job and no new column. A human who still wants to send after this refusal edits the reply (which
// re-derives a fresh hash and re-enters review) with the understanding that the source has expired —
// this file does not, and must not, try to guess whether that edit actually removed a quote.
//
// ── THE MESSAGE-PURGE INTERACTION THIS TICKET FOUND AND FIXED AT THE SOURCE ───────────────────────
// `inbox-retention-job.ts`'s existing per-message activity/profile purge UPDATEs matched ANY message
// row past the age threshold, with no `direction` filter — correct when every row was inbound (all
// SMM-15/16 ever wrote), but wrong the instant an OUTBOUND reply row exists on the same table: our
// own authored reply text is not a member's social-activity content LinkedIn's cap is about, and
// wiping it (including on an ALREADY-SENT reply, which is our own historical record, never subject
// to this cap) would be an over-broad application of a rule about someone else's data. Fixed at that
// file's own two message-purge branches (`m.direction = 'in'` added to both WHERE clauses) — not
// worked around here. See that file's own header for the fix; this file never needed to change its
// own retention answer as a result, because it reads `activity_content_purged_at` on the THREAD
// (never on the message), which was never affected by the bug.
import type { PoolClient } from "pg";
import { config } from "../../config";
import { replyArgsSha256, argsSha256 } from "./canonical-args";
import { isNetwork, type Network } from "./media-rules";
import { declareSocialModuleScope, SOCIAL_PUBLISH_TOOL_CLASSIFICATION } from "./publish-precondition";

/** The one tool this file's precondition guards. `impact:"high"` (see
 *  `SOCIAL_REPLY_TOOL_CLASSIFICATION` below) is what makes an `origin='automation'`/`'agent'` re-drive
 *  need `core/approval-executables.ts`'s registry entry at all — a human's own attended send never
 *  reaches this gate through a suspension, but it re-enters the SAME dispatch endpoint the executor
 *  does (see `reply-dispatch.ts`'s header), so the precondition below is the one and only rule for
 *  both callers, never a second copy for "the attended path". */
export const SOCIAL_REPLY_TOOL = "social.sendReply";

/** SPREAD from `SOCIAL_PUBLISH_TOOL_CLASSIFICATION`, never retyped — those two literals ARE the D14
 *  gate (`write && impact !== 'low'` is what suspends an automation/agent call into WS4,
 *  mcp-hub/src/policy.ts), and a hand-typed `{write:true, impact:"high"}` here would be a second copy
 *  that could silently drift from the publish tool's own. A reply and a publish are BOTH outbound
 *  public writes with the SAME irreversibility (this ticket's own instruction: "takes the same
 *  discipline as a publish"), so they share the identical classification, sourced from one place. */
export const SOCIAL_REPLY_TOOL_CLASSIFICATION = { ...SOCIAL_PUBLISH_TOOL_CLASSIFICATION } as const;

// ── The typed refusal vocabulary — REPLY_REFUSAL, kept apart from PUBLISH_REFUSAL ─────────────────

export const REPLY_REFUSAL = {
  // ── (1) scope ──────────────────────────────────────────────────────────────────────────────
  /** No outbound (`direction='out'`) message row resolves in this tenant. Also the answer when the
   *  id is missing/malformed, or names an INBOUND row — a reply is sent FROM a row WE wrote, never
   *  from a comment we received. */
  messageNotFound: "message_not_found",
  /** The account (or its publisher org) is no longer in a state that can send. Reused verbatim from
   *  `SocialPublisherError`'s own spelling — one word for this fact, not two. */
  accountNotConnected: "account_not_connected",
  /** The network is off at the DEPLOYMENT level (SOCIAL_NETWORKS_ENABLED), which outranks any
   *  per-engagement tool scope — the SAME outer gate publish's scope stage enforces. */
  networkDisabled: "network_disabled",
  /** No engagement resolves to govern this thread's client at all (no active engagement for the
   *  account's client), so neither `networks.<network>` nor `inbox.reply` can be evaluated. Fails
   *  closed rather than treating "nothing to check against" as "nothing forbids it" — the same
   *  doctrine `creatorInfoUnverified` applies to an absent verifier. */
  engagementNotFound: "engagement_not_found",
  /** The resolved engagement's `tool_scope.networks[<network>]` is not `true` — the SAME
   *  per-engagement network dial publish's scope stage checks, re-applied here because a reply is
   *  still a write to that network under that engagement's name. */
  networkNotInScope: "network_not_in_scope",
  /** The resolved engagement's `tool_scope.inbox.reply` is not `true` — the dial THIS ticket adds
   *  (additive to 0105's existing `tool_scope.inbox` shape; no migration, jsonb is schema-free). A
   *  client whose engagement has not opted into staff-sent replies must not have one go out under
   *  their account regardless of who or what proposed it. */
  replyNotInScope: "reply_not_in_scope",

  // ── (2) hash ───────────────────────────────────────────────────────────────────────────────
  /** EDIT-INVALIDATES-APPROVAL (D-15), the same structural property publish's hash stage enforces:
   *  the live message no longer hashes to the value the approval was minted against. */
  argsHashMismatch: "args_hash_mismatch",

  // ── (3) unconsumed ─────────────────────────────────────────────────────────────────────────
  /** REPLAY REFUSED. The message already carries an `external_id` or has already reached `sent` —
   *  a second approved decision reaching execution for the same message is a decision made from a
   *  snapshot that predates the send that already went out. */
  alreadySent: "already_sent",
  /** A grant was already spent on this message (`social_inbox_messages.approval_id` is set) but it
   *  has not reached `sent` yet — the second, independent half of the one-shot rule, mirroring
   *  `approvalAlreadyConsumed` on the publish side; 0105's `ux_social_inbox_messages_approval`
   *  partial unique index is the schema-level twin of this check. */
  approvalAlreadyConsumed: "approval_already_consumed",
  /** The message is not `approved`. The commonest live cause is an edit: the same edit-invalidates-
   *  approval statement that moves the hash also reverts the status, so stage 2 has usually already
   *  refused — this is what catches everything else (still `draft`/`in_review`, or `failed` from a
   *  prior attempt that never landed and needs a human to look at it, never an unattended retry). */
  messageNotApproved: "message_not_approved",

  // ── (4) retention (this ticket's own named design question) ───────────────────────────────
  /** The thread this message answers has had its activity content purged
   *  (`activity_content_purged_at` is set) since this reply was drafted/approved. FAIL CLOSED — see
   *  this file's header for why "we cannot verify what this quotes" must never read as "still fine
   *  to send", the same doctrine `creatorInfoUnverified` applies to an unavailable live check. */
  sourceContentPurged: "source_content_purged",
} as const;

export type ReplyRefusalReason = (typeof REPLY_REFUSAL)[keyof typeof REPLY_REFUSAL];

export const REPLY_PRECONDITION_STAGES = ["scope", "hash", "unconsumed", "retention"] as const;
export type ReplyPreconditionStage = (typeof REPLY_PRECONDITION_STAGES)[number];

export const REPLY_REFUSAL_STAGE: Record<ReplyRefusalReason, ReplyPreconditionStage> = {
  [REPLY_REFUSAL.messageNotFound]: "scope",
  [REPLY_REFUSAL.accountNotConnected]: "scope",
  [REPLY_REFUSAL.networkDisabled]: "scope",
  [REPLY_REFUSAL.engagementNotFound]: "scope",
  [REPLY_REFUSAL.networkNotInScope]: "scope",
  [REPLY_REFUSAL.replyNotInScope]: "scope",
  [REPLY_REFUSAL.argsHashMismatch]: "hash",
  [REPLY_REFUSAL.alreadySent]: "unconsumed",
  [REPLY_REFUSAL.approvalAlreadyConsumed]: "unconsumed",
  [REPLY_REFUSAL.messageNotApproved]: "unconsumed",
  [REPLY_REFUSAL.sourceContentPurged]: "retention",
};

export type ReplyPreconditionVerdict =
  | { ok: true }
  | { ok: false; stage: ReplyPreconditionStage; reason: ReplyRefusalReason };

function refuse(reason: ReplyRefusalReason): ReplyPreconditionVerdict {
  return { ok: false, stage: REPLY_REFUSAL_STAGE[reason], reason };
}

// ── lockKey ─────────────────────────────────────────────────────────────────────────────────────

/** The message id from the send call's arguments. `messageId` (not `threadId`, not `tenantId`) is
 *  the key because the MESSAGE is the unit of the outbound act — one message is one reply on one
 *  thread, and two approvals for the same message are exactly what must be serialized. Mirrors
 *  `extractVariantId`'s own reasoning verbatim. */
export function extractMessageId(toolArgs: Record<string, unknown>): string | null {
  const v = toolArgs?.messageId;
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/** The advisory-lock key. Pure, stable function of `toolArgs` — mirrors `publishLockKey` exactly,
 *  including the reasoning for the malformed-input fallback (never collapse every bad call for this
 *  tool onto one shared constant). */
export function replyLockKey(toolArgs: Record<string, unknown>, toolName: string): string {
  const messageId = extractMessageId(toolArgs);
  if (messageId) return messageId;
  return `${toolName}:invalid-message-id:${JSON.stringify(toolArgs)}`;
}

// ── the chain ───────────────────────────────────────────────────────────────────────────────────

interface ReplyRow {
  id: string;
  tenant_id: string;
  thread_id: string;
  direction: string;
  body: string;
  status: string;
  args_sha256: string | null;
  approval_id: string | null;
  external_id: string | null;
  account_id: string;
  network: string;
  external_thread_id: string;
  activity_content_purged_at: Date | null;
  account_client_id: string;
  account_status: string;
  org_status: string;
  org_id: string;
  org_client_id: string;
  org_driver: string;
  org_postiz_org_id: string;
  org_api_key_ref: string;
  integration_id: string | null;
}

const SENT_STATUSES = new Set(["sent"]);

/**
 * THE PRECONDITION. Called by `core/approval-executables.ts`'s `social.sendReply` entry on the
 * executor's own transaction, under the SAME advisory-lock namespace publish uses
 * (`APPROVAL_EXEC_LOCK_NS`), keyed on `replyLockKey`. Also called by the module's own read-only
 * dry-run endpoint (`social.controller.ts`) so the reply card can show WHY a send will refuse before
 * anyone approves it — one implementation, two callers, never two copies of the rule.
 *
 * Never writes a domain row. Never performs network I/O.
 */
export async function evaluateReplyPrecondition(
  c: PoolClient,
  toolArgs: Record<string, unknown>,
): Promise<ReplyPreconditionVerdict> {
  const messageId = extractMessageId(toolArgs);
  if (!messageId) return refuse(REPLY_REFUSAL.messageNotFound);

  await declareSocialModuleScope(c);

  // ══ (1) SCOPE ═════════════════════════════════════════════════════════════════════════════════
  const { rows } = await c.query<ReplyRow>(
    `SELECT m.id, m.tenant_id, m.thread_id, m.direction, m.body, m.status, m.args_sha256,
            m.approval_id, m.external_id,
            t.account_id                          AS account_id,
            a.network                             AS network,
            t.external_thread_id                  AS external_thread_id,
            t.activity_content_purged_at          AS activity_content_purged_at,
            a.client_id                           AS account_client_id,
            a.status                              AS account_status,
            a.postiz_integration_id               AS integration_id,
            o.id                                  AS org_id,
            o.client_id                           AS org_client_id,
            o.driver                              AS org_driver,
            o.postiz_org_id                       AS org_postiz_org_id,
            o.api_key_ref                         AS org_api_key_ref,
            o.status                              AS org_status
       FROM social_inbox_messages m
       JOIN social_inbox_threads t     ON t.id = m.thread_id       AND t.tenant_id = m.tenant_id
       JOIN social_accounts a          ON a.id = t.account_id      AND a.tenant_id = m.tenant_id
       JOIN social_publisher_orgs o    ON o.id = a.publisher_org_id AND o.tenant_id = m.tenant_id
      WHERE m.id = $1 AND m.direction = 'out'`,
    [messageId],
  );
  const row = rows[0];
  if (!row) return refuse(REPLY_REFUSAL.messageNotFound);

  if (row.org_status !== "active") return refuse(REPLY_REFUSAL.accountNotConnected);
  if (row.account_status !== "connected" || !row.integration_id) {
    return refuse(REPLY_REFUSAL.accountNotConnected);
  }
  const network = row.network;
  if (!isNetwork(network)) return refuse(REPLY_REFUSAL.messageNotFound);
  if (!config.social.publisher.enabledNetworks.includes(network)) {
    return refuse(REPLY_REFUSAL.networkDisabled);
  }

  // The per-engagement dial. No FK from a thread to an engagement (a thread answers an ACCOUNT, not
  // a post) — resolved the SAME documented-simplification way `inbox-triage-job.ts`'s spike
  // notification already does: the most recently created ACTIVE engagement for this client. Not a
  // schema guarantee; a named, accepted simplification (see that file's own evidence).
  const eng = await c.query<{ id: string; tool_scope: Record<string, Record<string, unknown>> }>(
    `SELECT id, tool_scope FROM social_engagements
      WHERE client_id = $1 AND deleted_at IS NULL AND status = 'active'
      ORDER BY created_at DESC LIMIT 1`,
    [row.account_client_id],
  );
  const engagement = eng.rows[0];
  if (!engagement) return refuse(REPLY_REFUSAL.engagementNotFound);

  const toolScope = engagement.tool_scope ?? {};
  const networksScope = toolScope.networks as Record<string, unknown> | undefined;
  if (networksScope?.[network] !== true) return refuse(REPLY_REFUSAL.networkNotInScope);
  const inboxScope = toolScope.inbox as Record<string, unknown> | undefined;
  if (inboxScope?.reply !== true) return refuse(REPLY_REFUSAL.replyNotInScope);

  // ══ (2) HASH — edit-invalidates-approval (D-15) ═══════════════════════════════════════════════
  const live = replyArgsSha256({
    tenantId: row.tenant_id, id: row.id, threadId: row.thread_id, accountId: row.account_id, body: row.body ?? "",
  });
  if (live !== argsSha256(toolArgs)) return refuse(REPLY_REFUSAL.argsHashMismatch);
  if (row.args_sha256 !== live) return refuse(REPLY_REFUSAL.argsHashMismatch);

  // ══ (3) UNCONSUMED ════════════════════════════════════════════════════════════════════════════
  if (row.external_id !== null || SENT_STATUSES.has(row.status)) return refuse(REPLY_REFUSAL.alreadySent);
  if (row.approval_id !== null) return refuse(REPLY_REFUSAL.approvalAlreadyConsumed);
  if (row.status !== "approved") return refuse(REPLY_REFUSAL.messageNotApproved);

  // ══ (4) RETENTION — this ticket's own named design question, answered above in the header ════
  if (row.activity_content_purged_at !== null) return refuse(REPLY_REFUSAL.sourceContentPurged);

  return { ok: true };
}

/** Read-only chain resolution for the dispatch endpoint's SECOND lookup (network call phase, no
 *  transaction) — mirrors `assertDispatchChain`'s own split from the precondition. Exported so
 *  `reply-dispatch.ts` reads the SAME shape rather than re-querying with a hand-written duplicate. */
export interface ReplyChain {
  messageId: string;
  threadId: string;
  accountId: string;
  network: Network;
  externalThreadId: string;
  integrationId: string;
  org: { id: string; clientId: string; driver: string; postizOrgId: string; apiKeyRef: string; status: string };
}

export async function loadReplyChain(c: PoolClient, messageId: string): Promise<ReplyChain | null> {
  const { rows } = await c.query<ReplyRow>(
    `SELECT m.id, m.tenant_id, m.thread_id, m.direction, m.body, m.status, m.args_sha256,
            m.approval_id, m.external_id,
            t.account_id                          AS account_id,
            a.network                             AS network,
            t.external_thread_id                  AS external_thread_id,
            t.activity_content_purged_at          AS activity_content_purged_at,
            a.client_id                           AS account_client_id,
            a.status                              AS account_status,
            a.postiz_integration_id               AS integration_id,
            o.id                                  AS org_id,
            o.client_id                           AS org_client_id,
            o.driver                              AS org_driver,
            o.postiz_org_id                       AS org_postiz_org_id,
            o.api_key_ref                         AS org_api_key_ref,
            o.status                              AS org_status
       FROM social_inbox_messages m
       JOIN social_inbox_threads t     ON t.id = m.thread_id       AND t.tenant_id = m.tenant_id
       JOIN social_accounts a          ON a.id = t.account_id      AND a.tenant_id = m.tenant_id
       JOIN social_publisher_orgs o    ON o.id = a.publisher_org_id AND o.tenant_id = m.tenant_id
      WHERE m.id = $1 AND m.direction = 'out'`,
    [messageId],
  );
  const row = rows[0];
  if (!row || !isNetwork(row.network) || !row.integration_id) return null;
  return {
    messageId: row.id,
    threadId: row.thread_id,
    accountId: row.account_id,
    network: row.network,
    externalThreadId: row.external_thread_id,
    integrationId: row.integration_id,
    org: {
      id: row.org_id, clientId: row.org_client_id, driver: row.org_driver,
      postizOrgId: row.org_postiz_org_id, apiKeyRef: row.org_api_key_ref, status: row.org_status,
    },
  };
}
