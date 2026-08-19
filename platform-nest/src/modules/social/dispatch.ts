// SMM-10 — approval-execution -> `schedulePost`, and the transactional stamp.
//
// Design: docs/blueprints/smm-design-addendum-2026-08-12.md — the SMM-10 row. Consumes what SMM-09
// left as a seam: `core/approval-executables.ts`'s `social.publishPost` entry mints a grant and calls
// the hub only after `evaluatePublishPrecondition` passes inside the EXECUTOR's own claim
// transaction. The hub then re-drives the tool as the original filing principal, over HTTP, against
// the endpoint this file's `dispatchApprovedPublish` backs (wired in `social.controller.ts`).
//
// ── WHY THIS FILE RE-RUNS THE PRECONDITION A SECOND TIME ────────────────────────────────────────────
// The grant the hub verified is short-lived (60s mint window, `core/hub-client.ts`'s
// GRANT_WINDOW_MS) and mcp-hub's OWN authorization check (`policy.ts#authorizeCall`) is what the
// grant actually buys — but the platform-side call this file backs happens over a SEPARATE HTTP hop
// AFTER the executor's transaction has already committed and released its advisory lock (see
// `core/approval-execute.ts`'s "TRANSACTION BOUNDARY" note: the hub call is deliberately outside that
// transaction). A concurrent second approval for the same variant, or a fast edit racing the network
// hop, could in principle land in the gap between "executor's precondition passed" and "this endpoint
// runs". So this file takes the SAME advisory lock and re-runs the SAME precondition
// (`evaluatePublishPrecondition`) a second time, under its own transaction, before it will ever call
// the publisher — one implementation, reused twice, never a second copy of the rules.
//
// ── THE APPROVAL-ID PUZZLE, AND HOW THIS FILE RESOLVES IT ────────────────────────────────────────────
// `mcp-hub`'s tool-call contract does NOT forward the verified grant's `approvalId` to the platform
// handler (`hub.ts#CallToolRequestSchema` calls `decision.tool.handler(args, principal)` with the
// RAW original tool args only; `module-tools.ts#callPlatform` forwards exactly those args and the OBO
// identity, nothing else) — confirmed by reading both files rather than assumed. So THIS endpoint
// cannot be handed the approval id; it must resolve which row is consuming it. It does so by finding
// the `automation_approvals` row this exact call is executing FOR: `tool_name = social.publishPost`,
// `execution_status = 'executing'` (the state the executor's own claim UPDATE set, and holds for the
// duration of exactly one hub round trip) and `tool_args` naming this variant. Ambiguity (zero or more
// than one match) refuses closed — see `DISPATCH_REFUSAL.approvalNotResolvable` below — rather than
// guessing which row to spend.
//
// ── THE TRANSACTIONAL STAMP — THE ONE THING THIS TICKET MUST NEVER GET WRONG ────────────────────────
// `approval_id` and `provider_post_id` land in the SAME UPDATE statement, and ONLY once
// `SocialPublisher.schedulePost` has ALREADY returned a real provider post id. This is deliberately
// NOT "claim first, dispatch second": stamping `approval_id` alone at claim time (before the network
// call) would make 0105's `svar_dispatched_has_approval` CHECK-carrying row read as
// `approval_already_consumed` even if the network call then failed and no post ever went out — a
// FALSE POSITIVE the ticket brief calls out by name, because a human retrying after fixing whatever
// failed would be told the grant was already spent when nothing was ever published. So the only
// pre-network claim this file takes is the advisory lock (released once the precondition-check
// transaction commits) — the SAME lock a concurrent second call for the same variant would also have
// to wait for, and by the time it gets it, this row's `status`/`approval_id` will have moved.
//
// ── ON FAILURE, THE APPROVAL IS STILL CONSUMED ───────────────────────────────────────────────────────
// Once `schedulePost` has been attempted (succeeded OR thrown), the approval is spent: a `failed`
// variant carries `approval_id` in the SAME final UPDATE (0105's CHECK requires it for any status
// outside draft/in_review/approved/cancelled). This is deliberate — the design's own "no auto-retry
// on an ambiguous publish failure" doctrine (`approval-executables.ts`'s SMM-09 section,
// `neverAutoRetry: true`) means a human must look at WHY it failed and file a fresh approval to try
// again, never get an unattended second shot on the same grant.
import type { PoolClient } from "pg";
import { withTenants } from "../../db";
import { emitEvent } from "../../events/outbox.service";
import { writeActivity } from "../../core/http";
import { APPROVAL_EXEC_LOCK_NS } from "../../core/approval-execute";
import {
  SOCIAL_PUBLISH_TOOL,
  CONSENT_AT_UPLOAD_NETWORKS,
  PUBLISH_REFUSAL,
  declareSocialModuleScope,
  evaluatePublishPrecondition,
  type PublishPreconditionStage,
  type PublishRefusalReason,
} from "./publish-precondition";
import { variantPublishArgs, type VariantPublishArgs } from "./canonical-args";
import { assertDispatchChain, openOrg, type DispatchChain } from "./publisher/provisioning";
import { invokePublisher } from "./publisher/registry";
import { SocialPublisherError, type VariantDispatch } from "./publisher/types";
import { refreshCreatorInfoSnapshot } from "./creator-info-verifier";

/** Refusals that belong to THIS file's own routing question ("who authorized this call"), not to
 *  the six-stage precondition. A distinct, small vocabulary — same separation
 *  `core/approval-execute.ts`'s `EXEC_ERROR` keeps from `PUBLISH_REFUSAL`. */
export const DISPATCH_REFUSAL = {
  /** Zero, or more than one, `executing` `social.publishPost` approval names this variant. Fails
   *  closed rather than guessing which row to spend — see this file's header. */
  approvalNotResolvable: "approval_not_resolvable",
  /** The final stamp's own guarded UPDATE affected zero rows: between the precondition passing and
   *  this UPDATE, something else already moved the variant (the narrowest possible race window,
   *  after a real network dispatch already happened). CRITICAL — see `stampDispatchOutcome`'s doc. */
  stampRaceLost: "dispatch_stamp_race_lost",
  /** `SocialPublisher.schedulePost` itself threw (unreachable, HTTP error, ambiguous response). The
   *  approval is still consumed (0105's state law) but nothing was published; see this file's header
   *  "ON FAILURE, THE APPROVAL IS STILL CONSUMED". */
  publishDispatchFailed: "dispatch_error",
} as const;
export type DispatchRefusalReason = (typeof DISPATCH_REFUSAL)[keyof typeof DISPATCH_REFUSAL];

export type DispatchVerdict =
  | { ok: true; providerPostId: string; network: string }
  | { ok: false; stage: PublishPreconditionStage | "dispatch"; reason: PublishRefusalReason | DispatchRefusalReason; critical?: boolean };

/** See `dispatchApprovedPublish`'s own "KNOWN LIMITATION" comment at the call site. `fileId` is
 *  mapped onto `id` verbatim — a placeholder mapping, not a real upload. */
function toDispatchMedia(raw: unknown): VariantDispatch["media"] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>) : null))
    .filter((m): m is Record<string, unknown> => m !== null && typeof m.fileId === "string")
    .map((m) => ({ id: m.fileId as string }));
}

interface VariantForDispatch {
  tenant_id: string;
  account_id: string;
  body: string;
  first_comment: string | null;
  media: unknown;
  settings: Record<string, unknown> | null;
  scheduled_at: Date | null;
  args_sha256: string | null;
  engagement_id: string;
}

async function loadVariantForDispatch(c: PoolClient, variantId: string): Promise<VariantForDispatch | null> {
  const { rows } = await c.query<VariantForDispatch>(
    `SELECT v.tenant_id, v.account_id, v.body, v.first_comment, v.media, v.settings, v.scheduled_at,
            v.args_sha256, p.engagement_id
       FROM social_post_variants v
       JOIN social_posts p ON p.id = v.post_id AND p.tenant_id = v.tenant_id
      WHERE v.id = $1 AND v.deleted_at IS NULL`,
    [variantId],
  );
  return rows[0] ?? null;
}

/** Resolve the ONE `automation_approvals` row this call is executing for. Plain core tenant wall —
 *  no module scope needed for this table — but run on the SAME connection as the social reads so it
 *  is atomic with them under the one advisory lock. */
async function resolveExecutingApprovalId(c: PoolClient, tenantId: string, variantId: string): Promise<string | null> {
  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM automation_approvals
      WHERE tenant_id = $1 AND tool_name = $2 AND execution_status = 'executing'
        AND tool_args @> $3::jsonb`,
    [tenantId, SOCIAL_PUBLISH_TOOL, JSON.stringify({ variantId })],
  );
  return rows.length === 1 ? rows[0].id : null;
}

interface PreconditionClaim {
  approvalId: string;
  chain: DispatchChain;
  args: VariantPublishArgs;
  variant: VariantForDispatch;
}

type PreconditionOutcome =
  | { kind: "ok"; claim: PreconditionClaim }
  | { kind: "refused"; stage: PublishPreconditionStage; reason: PublishRefusalReason }
  | { kind: "unresolved" }
  | { kind: "not_found" };

/** Phase 1: lock + re-run the precondition + resolve the consuming approval. Never writes; never
 *  performs network I/O. Mirrors the executor's own claim shape (lock FIRST, then read) so this
 *  transaction is atomic with respect to any other holder of the same variant's lock key. */
async function checkPreconditionAndResolveApproval(tenantId: string, variantId: string): Promise<PreconditionOutcome> {
  return withTenants([tenantId], async (c) => {
    await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [APPROVAL_EXEC_LOCK_NS, variantId]);
    // Declared explicitly rather than via `withTenants`'s `{modules}` option — this transaction ALSO
    // reads `automation_approvals` (a plain-tenant-wall core table), and the module-scope helper is
    // additive, so declaring it once up front is correct for both reads. See `declareSocialModuleScope`'s
    // own doc for why an omitted declaration here would make every social_* read below return ZERO
    // ROWS SILENTLY — the single sharpest trap in this module.
    await declareSocialModuleScope(c);

    const variant = await loadVariantForDispatch(c, variantId);
    if (!variant) return { kind: "not_found" as const };

    const args = variantPublishArgs({
      tenantId: variant.tenant_id, id: variantId, accountId: variant.account_id, body: variant.body,
      firstComment: variant.first_comment, media: variant.media, settings: variant.settings,
      scheduledAt: variant.scheduled_at,
    });
    const verdict = await evaluatePublishPrecondition(c, args as unknown as Record<string, unknown>, SOCIAL_PUBLISH_TOOL);
    if (!verdict.ok) return { kind: "refused" as const, stage: verdict.stage, reason: verdict.reason };

    const approvalId = await resolveExecutingApprovalId(c, tenantId, variantId);
    if (!approvalId) return { kind: "unresolved" as const };

    // Re-walk the chain UNDER THE LOCK for the fields `schedulePost` needs (integration id, org,
    // network) — the precondition above already proved this variant may publish; this is the same
    // function, not a second implementation, called again because its return value (not just its
    // pass/fail) is needed outside this transaction.
    const chain = await assertDispatchChain(c, variantId);
    return { kind: "ok" as const, claim: { approvalId, chain, args, variant } };
  });
}

/** Phase 3: the transactional stamp. Runs AFTER `schedulePost` has already been attempted — see this
 *  file's header for why the claim never precedes the network call. Guarded by the SAME conditions
 *  the precondition itself re-derives (`status='approved' AND approval_id IS NULL AND args_sha256
 *  matches`), so a variant that moved out from under this call between the precondition passing and
 *  this UPDATE is a hard, loud failure — see the `stampRaceLost` doc above — never a silent partial
 *  write. `providerPostId` NULL on a failed attempt: the approval is still spent (0105's own state
 *  law), but nothing was actually published. */
async function stampDispatchOutcome(
  tenantId: string,
  variantId: string,
  approvalId: string,
  expectedHash: string,
  outcome: { status: "queued" | "failed"; providerPostId: string | null; lastError: string | null },
): Promise<boolean> {
  return withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    const upd = await c.query(
      `UPDATE social_post_variants
          SET approval_id = $2, provider_post_id = $3, status = $4, last_error = $5,
              published_at = CASE WHEN $4 = 'published' THEN now() ELSE published_at END,
              updated_at = now()
        WHERE id = $1 AND status = 'approved' AND approval_id IS NULL AND args_sha256 = $6`,
      [variantId, approvalId, outcome.providerPostId, outcome.status, outcome.lastError, expectedHash],
    );
    return (upd.rowCount ?? 0) > 0;
  });
}

/**
 * THE ENTRY POINT. Called by `social.controller.ts`'s dispatch endpoint (the handler
 * `social.publishPost`'s `pathTemplate` fronts). `actorId` is the OBO-resolved principal's own
 * user id, for `writeActivity`/`emitEvent` attribution — never the approver (invariant 1,
 * `core/approval-execute.ts`).
 */
export async function dispatchApprovedPublish(
  tenantId: string,
  variantId: string,
  actorId: string | null,
): Promise<DispatchVerdict> {
  // ── D-22: the live fetch, OUTSIDE any transaction, BEFORE the precondition re-run so the
  // verifier (running INSIDE that transaction, read-only) sees a fresh snapshot for a TikTok variant.
  // Resolved from a quick, lock-free read — a stale read here costs nothing: the fetch either lands
  // before the precondition runs (best case) or the precondition's own creator_info stage refuses
  // `creator_info_unverified` and nothing is spent (safe case). Never itself a reason to fail this call.
  const preview = await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    const v = await loadVariantForDispatch(c, variantId);
    if (!v) return null;
    const chain = await assertDispatchChain(c, variantId).catch(() => null);
    return { network: chain?.network ?? null, chain };
  });
  if (preview?.network && CONSENT_AT_UPLOAD_NETWORKS.has(preview.network) && preview.chain) {
    await refreshCreatorInfoSnapshot(tenantId, variantId, preview.chain.org, preview.chain.integrationId);
  }

  const outcome = await checkPreconditionAndResolveApproval(tenantId, variantId);
  if (outcome.kind === "not_found") {
    return { ok: false, stage: "scope", reason: PUBLISH_REFUSAL.variantNotFound };
  }
  if (outcome.kind === "refused") {
    return { ok: false, stage: outcome.stage, reason: outcome.reason };
  }
  if (outcome.kind === "unresolved") {
    return { ok: false, stage: "dispatch", reason: DISPATCH_REFUSAL.approvalNotResolvable };
  }

  const { approvalId, chain, args, variant } = outcome.claim;
  const expectedHash = variant.args_sha256 as string; // non-null: the hash stage already passed

  // ── Phase 2: the network call. OUTSIDE any transaction and outside the advisory lock (this file's
  // header, and the same discipline `core/approval-execute.ts`'s TRANSACTION BOUNDARY note enforces
  // for the hub call itself: never hold Postgres locks across an external HTTP round trip).
  const { driver, handle } = openOrg(chain.org);
  const dispatch: VariantDispatch = {
    integrationId: chain.integrationId,
    network: chain.network as VariantDispatch["network"],
    body: args.body,
    firstComment: args.firstComment,
    // ⚠ KNOWN LIMITATION, named rather than silently wrong: `VariantDispatch.media` wants ALREADY-
    // UPLOADED engine media refs (`{id, url?}` — `SocialPublisher.uploadMedia`'s own return shape),
    // and the variant's stored descriptors are `{fileId, kind, alt}` (0105's own comment on the
    // `media` column) — composer-side references into `files`, never uploaded to the publisher yet.
    // SMM-05 built `uploadMedia` on the port; wiring the upload step (reading each `fileId`'s bytes
    // out of `files` and calling it once per attachment, before this call) is real work this ticket's
    // scope — "approval-execution → schedulePost (transactional stamp)" — did not size for, and it is
    // NOT silently faked here: `toDispatchMedia` below maps `fileId` onto `id` verbatim, which is
    // correct ONLY for a variant whose media was already resolved to engine-side ids by an earlier
    // step. A real image/video attachment reaching this line uploads nothing and will fail
    // `publisher_http_error`/an upstream 4xx rather than silently posting the wrong asset — loud, not
    // silent, but still a gap for the next ticket to close (flagged in this ticket's own report).
    media: toDispatchMedia(args.media),
    settings: (args.settings ?? {}) as Record<string, unknown>,
    scheduledAt: args.scheduledAt,
    approvalId,
    variantId,
  };

  let dispatched: { providerPostId: string } | null = null;
  let dispatchError: string | null = null;
  try {
    dispatched = await invokePublisher(
      { op: "schedulePost", org: handle, network: chain.network, costUsd: 0 },
      () => driver.schedulePost(handle, dispatch),
    );
  } catch (err) {
    dispatchError = err instanceof SocialPublisherError ? `${err.code}: ${err.message}` : (err as Error)?.message ?? "unknown dispatch error";
  }

  // ── Phase 3: the transactional stamp — ONE UPDATE, both columns, only now that the network call
  // has actually been ATTEMPTED (succeeded or thrown). See stampDispatchOutcome's own doc.
  const stamped = await stampDispatchOutcome(tenantId, variantId, approvalId, expectedHash, {
    status: dispatched ? "queued" : "failed",
    providerPostId: dispatched?.providerPostId ?? null,
    lastError: dispatchError,
  });

  if (!stamped) {
    // The narrowest possible race: the network call was attempted (and may have SUCCEEDED — a post
    // may exist upstream right now) but this row no longer matches the guard by the time the stamp
    // ran. This can only happen if something ELSE mutated the row between the precondition passing
    // and this UPDATE — outside this file's own control (the advisory lock was released once the
    // precondition-check transaction committed, by design, so the network call is never made under
    // it). Reported as CRITICAL so the caller notifies loudly rather than treating this as an
    // ordinary refusal; a human must look at whether the post above actually went out.
    await withTenants([tenantId], (c) =>
      emitEvent(c, tenantId, "social_post_variant", variantId, "social.post.failed", {
        reason: DISPATCH_REFUSAL.stampRaceLost, network: chain.network, engagementId: variant.engagement_id,
        providerPostId: dispatched?.providerPostId ?? null,
      }),
    );
    if (actorId) {
      await writeActivity(tenantId, actorId, "refused", "social_post_variant", variantId, {
        reason: DISPATCH_REFUSAL.stampRaceLost, critical: true,
      });
    }
    return { ok: false, stage: "dispatch", reason: DISPATCH_REFUSAL.stampRaceLost, critical: true };
  }

  if (!dispatched) {
    await withTenants([tenantId], (c) =>
      emitEvent(c, tenantId, "social_post_variant", variantId, "social.post.failed", {
        reason: "dispatch_error", network: chain.network, engagementId: variant.engagement_id, detail: dispatchError,
      }),
    );
    if (actorId) {
      await writeActivity(tenantId, actorId, "failed", "social_post_variant", variantId, { detail: dispatchError });
    }
    return { ok: false, stage: "dispatch", reason: DISPATCH_REFUSAL.publishDispatchFailed };
  }

  await withTenants([tenantId], (c) =>
    emitEvent(c, tenantId, "social_post_variant", variantId, "social.post.dispatched", {
      network: chain.network, engagementId: variant.engagement_id, providerPostId: dispatched!.providerPostId,
    }),
  );
  if (actorId) {
    await writeActivity(tenantId, actorId, "dispatched", "social_post_variant", variantId, {
      network: chain.network, providerPostId: dispatched.providerPostId,
    });
  }
  return { ok: true, providerPostId: dispatched.providerPostId, network: chain.network };
}
