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
import { storage } from "../../core/storage";
import { APPROVAL_EXEC_LOCK_NS } from "../../core/approval-execute";
import {
  SOCIAL_PUBLISH_TOOL,
  CONSENT_AT_UPLOAD_NETWORKS,
  PUBLISH_REFUSAL,
  declareSocialModuleScope,
  type PublishPreconditionStage,
  type PublishRefusalReason,
} from "./publish-precondition";
// SMM-31 — the client-review gate, composed IN FRONT of the six-stage chain (never inside it — see
// client-review.ts's header). Re-run here for the SAME reason this file re-runs the six-stage chain
// itself (see this file's own "WHY THIS FILE RE-RUNS THE PRECONDITION A SECOND TIME" note): a
// concurrent withdrawal or a fresh edit racing the network hop must still refuse at this hop, not
// only at the executor's.
import { evaluatePublishPreconditionWithClientReview, type ClientReviewRefusalReason } from "./client-review";
import { variantPublishArgs, type VariantPublishArgs } from "./canonical-args";
import { assertDispatchChain, openOrg, type DispatchChain } from "./publisher/provisioning";
import { invokePublisher } from "./publisher/registry";
import { SocialPublisherError, type OrgHandle, type SocialPublisher, type VariantDispatch } from "./publisher/types";
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
  /** SMM-39 — resolving one of the variant's attachments to engine media (missing `files` row,
   *  unreadable storage bytes, or the driver's `uploadMedia` itself threw) failed BEFORE
   *  `schedulePost` was ever called. A NEW token, not a reuse of `dispatch_error`: that token means
   *  "the engine rejected the publish attempt", this one means "we never reached the engine with a
   *  publish attempt at all because we could not finish assembling its media" — an operator reading
   *  an approval's `execution_error` needs to tell "the engine is unhappy with what we sent" from
   *  "we never sent anything" apart, the same distinction `quotaExhausted` vs `mediaRulesFailed`
   *  already draws in `publish-precondition.ts`. Structural, not advisory: three attachments with the
   *  second failing must never publish a one-image post (this ticket's own AC), so ALL of a
   *  variant's media is resolved before `schedulePost` is ever invoked — see `resolveEngineMedia`.
   *  The approval is still consumed on this path too, for the same `neverAutoRetry` reason
   *  `publishDispatchFailed` already carries: a human must look at why the upload failed (a deleted
   *  file, a licence-zone outage) and file a fresh approval, never get an unattended second shot. */
  mediaUploadFailed: "media_upload_failed",
} as const;
export type DispatchRefusalReason = (typeof DISPATCH_REFUSAL)[keyof typeof DISPATCH_REFUSAL];

export type DispatchVerdict =
  | { ok: true; providerPostId: string; network: string }
  | {
      ok: false;
      // SMM-31: "client_review" is a LOCAL widening of this union, here only — it does not touch
      // `PublishPreconditionStage` (pinned by `d14-smm-09-social-publish-registry.test.ts`).
      stage: PublishPreconditionStage | "client_review" | "dispatch";
      reason: PublishRefusalReason | ClientReviewRefusalReason | DispatchRefusalReason;
      critical?: boolean;
    };

// ── SMM-39 — resolving the composer's `{fileId}` descriptors to uploaded engine media ─────────────
//
// `VariantDispatch.media` wants ALREADY-UPLOADED engine refs (`{id, url?}` — `uploadMedia`'s own
// return shape); the variant's stored descriptors are `{fileId, kind, alt, format}` — composer-side
// references into `files`, never uploaded to the publisher yet (0105's own comment on the `media`
// column). `resolveEngineMedia` below is the wiring SMM-05 built `uploadMedia` for and no ticket
// ever called: for each descriptor, reuse a persisted ref if this exact (variant, file) pair has
// already been uploaded (the idempotency backstop, migration 0116), otherwise read the file's bytes
// out of `files` (a PLAIN core tenant wall — no `declareSocialModuleScope` needed for THAT read, see
// the header note below) and call `SocialPublisher.uploadMedia` for real.

/** Thrown by `resolveEngineMedia` on ANY failure to finish resolving one attachment — a missing
 *  `files` row, an unreadable storage blob, or the driver's `uploadMedia` itself throwing. Caught by
 *  `dispatchApprovedPublish` and turned into `DISPATCH_REFUSAL.mediaUploadFailed` BEFORE
 *  `schedulePost` is ever called — see that token's own doc for why this is a distinct reason from
 *  `dispatch_error` rather than a reuse. */
class MediaUploadError extends Error {
  constructor(
    readonly fileId: string,
    message: string,
  ) {
    super(message);
    this.name = "MediaUploadError";
  }
}

interface MediaDescriptor {
  fileId: string;
  kind?: string;
}

/** Parse the variant's stored `media` jsonb into descriptors this file cares about. Mirrors
 *  `toDispatchMedia`'s old filtering (object, string `fileId`) — a malformed entry (no `fileId`) is
 *  a data problem `media-rules.ts`'s `media_missing_file` rule already catches at the precondition's
 *  quota stage, so it is silently dropped here rather than re-raised as a second error surface. */
function parseMediaDescriptors(raw: unknown): MediaDescriptor[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>) : null))
    .filter((m): m is Record<string, unknown> => m !== null && typeof m.fileId === "string")
    .map((m) => ({ fileId: m.fileId as string, kind: typeof m.kind === "string" ? m.kind : undefined }));
}

type UploadedMediaMap = Record<string, { id: string; url?: string }>;

/** Read the persisted idempotency map (migration 0116's `uploaded_media` column) — a social_* table,
 *  hence `declareSocialModuleScope`. Never the hashed `media` column; see that column's own doc. */
async function loadUploadedMediaRefs(tenantId: string, variantId: string): Promise<UploadedMediaMap> {
  return withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    const { rows } = await c.query<{ uploaded_media: UploadedMediaMap }>(
      `SELECT uploaded_media FROM social_post_variants WHERE id = $1`,
      [variantId],
    );
    return rows[0]?.uploaded_media ?? {};
  });
}

/** Persist ONE fileId's ref the instant its own upload succeeds — never batched to the end of the
 *  loop, because the whole point is that a later attachment failing must not lose the record of
 *  earlier ones that already succeeded (a redispatch must not re-upload them). A plain jsonb merge:
 *  it can only ever ADD this key, never touch a sibling's, and never touches `media`/`args_sha256`
 *  (D-15) — this UPDATE and the transactional stamp's UPDATE guard completely disjoint columns. */
async function persistUploadedMediaRef(
  tenantId: string,
  variantId: string,
  fileId: string,
  ref: { id: string; url?: string },
): Promise<void> {
  await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    await c.query(
      `UPDATE social_post_variants SET uploaded_media = uploaded_media || $2::jsonb WHERE id = $1`,
      [variantId, JSON.stringify({ [fileId]: ref })],
    );
  });
}

interface FileForUpload {
  filename: string;
  contentType: string;
  storageKey: string;
}

/** `files` is NOT a `social_*` table (no module GUC) — it carries only the plain core tenant wall,
 *  exactly like `core/files.controller.ts`'s own reads. Conflating the two scopes is the trap this
 *  ticket's brief names by name; this function deliberately does NOT call
 *  `declareSocialModuleScope`. */
async function loadFileForUpload(tenantId: string, fileId: string): Promise<FileForUpload | null> {
  return withTenants([tenantId], async (c) => {
    const { rows } = await c.query<{ filename: string; content_type: string; storage_key: string | null }>(
      `SELECT filename, content_type, storage_key FROM files WHERE id = $1 AND deleted_at IS NULL`,
      [fileId],
    );
    const f = rows[0];
    if (!f || !f.storage_key) return null; // no row, or a reference-only attach with no bytes
    return { filename: f.filename, contentType: f.content_type, storageKey: f.storage_key };
  });
}

/** THE UPLOAD STEP. Called OUTSIDE any claim transaction and OUTSIDE the advisory lock — real
 *  network I/O against the licence zone, the same discipline `dispatchApprovedPublish`'s own header
 *  and `core/approval-execute.ts`'s TRANSACTION BOUNDARY note both enforce for `schedulePost` and the
 *  D-22 creator-info fetch. A text-only variant (`descriptors.length === 0`) returns `[]` immediately
 *  without touching `files`, `storage()` or the driver at all — it must never acquire an upload round
 *  trip it never needed (this ticket's own AC).
 *
 *  Resolves and uploads attachments ONE AT A TIME, in order, persisting each successful ref before
 *  moving to the next. On ANY failure — a missing `files` row, unreadable bytes, or the driver
 *  throwing — this throws `MediaUploadError` immediately: it does NOT continue to the remaining
 *  attachments and does NOT return a partial list, because a partial list is exactly what would let
 *  a caller assemble a one-image post out of a three-image approval (this ticket's own AC). Whatever
 *  succeeded before the failing attachment is already durably persisted (migration 0116), so a
 *  redispatch after a human files a fresh approval resumes rather than re-uploading from zero. */
async function resolveEngineMedia(
  tenantId: string,
  variantId: string,
  descriptors: MediaDescriptor[],
  driver: SocialPublisher,
  handle: OrgHandle,
  network: string,
): Promise<Array<{ id: string; url?: string }>> {
  if (descriptors.length === 0) return [];

  const persisted = await loadUploadedMediaRefs(tenantId, variantId);
  const resolved: Array<{ id: string; url?: string }> = [];

  for (const d of descriptors) {
    const cached = persisted[d.fileId];
    if (cached) {
      // Idempotency: this exact (variant, fileId) pair was already uploaded by a prior attempt
      // (this call, or an earlier failed dispatch for the same variant). Reuse it — never a second
      // upload, and never a second gallery entry for the same attachment.
      resolved.push(cached);
      continue;
    }

    const file = await loadFileForUpload(tenantId, d.fileId);
    if (!file) {
      throw new MediaUploadError(d.fileId, `attachment references file '${d.fileId}', which does not exist or has no stored bytes`);
    }

    let bytes: Buffer;
    try {
      bytes = await storage().get(file.storageKey);
    } catch (err) {
      throw new MediaUploadError(d.fileId, `could not read stored bytes for file '${d.fileId}': ${(err as Error)?.message ?? "unknown storage error"}`);
    }

    let ref: { id: string; url?: string };
    try {
      ref = await invokePublisher(
        { op: "uploadMedia", org: handle, network, costUsd: 0 },
        () => driver.uploadMedia(handle, { filename: file.filename, contentType: file.contentType, bytes }),
      );
    } catch (err) {
      const detail = err instanceof SocialPublisherError ? `${err.code}: ${err.message}` : (err as Error)?.message ?? "unknown upload error";
      throw new MediaUploadError(d.fileId, `uploadMedia failed for file '${d.fileId}': ${detail}`);
    }

    // Persist BEFORE moving to the next attachment — see this function's own header.
    await persistUploadedMediaRef(tenantId, variantId, d.fileId, ref);
    persisted[d.fileId] = ref;
    resolved.push(ref);
  }

  return resolved;
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
  | { kind: "refused"; stage: PublishPreconditionStage | "client_review"; reason: PublishRefusalReason | ClientReviewRefusalReason }
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
    // SMM-31: the client-review gate re-runs HERE too, under the SAME lock and on the SAME
    // connection — see this file's own header for why the whole precondition re-runs a second time,
    // and client-review.ts's header for why this call is composed rather than folded into the
    // six-stage chain.
    const verdict = await evaluatePublishPreconditionWithClientReview(c, args as unknown as Record<string, unknown>, SOCIAL_PUBLISH_TOOL);
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

  // ── Phase 2: the network call(s). OUTSIDE any transaction and outside the advisory lock (this
  // file's header, and the same discipline `core/approval-execute.ts`'s TRANSACTION BOUNDARY note
  // enforces for the hub call itself: never hold Postgres locks across an external HTTP round
  // trip). SMM-39's media upload shares this discipline — it is the SLOWEST call on this hop (its
  // own 120s timeout class, `SOCIAL_POSTIZ_UPLOAD_TIMEOUT_MS`) and holding the advisory lock across
  // it would be a self-inflicted outage, exactly the shape D-22's creator-info fetch above already
  // established for this file.
  const { driver, handle } = openOrg(chain.org);

  let dispatched: { providerPostId: string } | null = null;
  let dispatchError: string | null = null;
  let dispatchReason: DispatchRefusalReason = DISPATCH_REFUSAL.publishDispatchFailed;
  let engineMedia: Array<{ id: string; url?: string }> = [];
  try {
    // SMM-39 — resolve the composer's `{fileId}` descriptors to already-uploaded engine refs.
    // A text-only variant (`args.media` empty/absent) returns here immediately: `resolveEngineMedia`
    // never touches `files`, `storage()` or the driver when there is nothing to upload — it must not
    // acquire an upload round trip it never needed (this ticket's own AC).
    engineMedia = await resolveEngineMedia(tenantId, variantId, parseMediaDescriptors(args.media), driver, handle, chain.network);
  } catch (err) {
    // Refuse closed on ANY partial failure: `resolveEngineMedia` never returns a partial list (see
    // its own doc), so reaching here means `schedulePost` is NEVER called below — a three-image
    // variant whose second upload fails must not publish a one-image post (this ticket's own AC).
    dispatchReason = DISPATCH_REFUSAL.mediaUploadFailed;
    dispatchError = err instanceof MediaUploadError ? err.message : ((err as Error)?.message ?? "unknown media upload error");
  }

  if (!dispatchError) {
    const dispatch: VariantDispatch = {
      integrationId: chain.integrationId,
      network: chain.network as VariantDispatch["network"],
      body: args.body,
      firstComment: args.firstComment,
      // Already-uploaded engine refs (SMM-39), never the composer's raw `{fileId}` descriptors.
      // Empty for a text-only variant, matching `resolveEngineMedia`'s own no-op path above.
      media: engineMedia,
      settings: (args.settings ?? {}) as Record<string, unknown>,
      scheduledAt: args.scheduledAt,
      approvalId,
      variantId,
    };
    try {
      dispatched = await invokePublisher(
        { op: "schedulePost", org: handle, network: chain.network, costUsd: 0 },
        () => driver.schedulePost(handle, dispatch),
      );
    } catch (err) {
      dispatchReason = DISPATCH_REFUSAL.publishDispatchFailed;
      dispatchError = err instanceof SocialPublisherError ? `${err.code}: ${err.message}` : (err as Error)?.message ?? "unknown dispatch error";
    }
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
        reason: dispatchReason, network: chain.network, engagementId: variant.engagement_id, detail: dispatchError,
      }),
    );
    if (actorId) {
      await writeActivity(tenantId, actorId, "failed", "social_post_variant", variantId, { detail: dispatchError });
    }
    return { ok: false, stage: "dispatch", reason: dispatchReason };
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
