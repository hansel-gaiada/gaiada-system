// SMM-31 — the client-review stage: `social_post_client_reviews` (0105, D-16), the submission
// precondition it backs, and the small refusal vocabulary it produces.
//
// Design: docs/blueprints/smm-design-addendum-2026-08-12.md — D-16 (owner decision 2026-08-12). Schema:
// migrations/0105_module_social.sql (the table already exists; this ticket is application code only —
// no migration, no Cerbos policy change: 0106 already seeded `social.client_review.*` +
// `portal.approve_post`, and `resource_social_client_review.yaml` / `resource_portal.yaml` already
// carry the actions this file's callers authorize against).
//
// ── WHY THE TABLE IS A PLAIN TENANT WALL (D-16 / 0088's D-2a lesson) ───────────────────────────────
// `social_post_client_reviews` is the ONE tenant table in this module that takes the plain core
// tenant_isolation policy instead of the third `app_module_allowed('social')` wall every other
// `social_*` table carries. Its primary writer is the CLIENT PORTAL (this ticket's own decide
// endpoint), and portal controllers are core — they declare no module scope in `app.scopes`, by
// design (portal-scope.ts's four-layer isolation kernel knows nothing about modules). A third wall
// here would be a two-sided handshake the portal path can never complete: every portal write would
// read/write ZERO ROWS, silently, exactly the failure 0088's D-2a decision (`webdev_change_requests`)
// existed to head off for the SAME reason — a client-portal-owned table under a module's third wall.
// 0105's own migration applied that lesson before it could bite here, rather than after.
//
// ── WHERE THIS GATE SITS RELATIVE TO SMM-09's SIX-STAGE PUBLISH CHAIN ───────────────────────────────
// It does NOT become a seventh stage inside `evaluatePublishPrecondition`. Three reasons:
//   1. `PUBLISH_PRECONDITION_STAGES` is PINNED — `d14-smm-09-social-publish-registry.test.ts` asserts
//      `toEqual(["scope","quota","hash","unconsumed","budget","creator_info"])` verbatim, and that
//      file's own header calls the five-stage order (six with D-22's creator_info) "fixed by the
//      SMM-09 ticket row and D-14". Inserting a stage there means editing a DIFFERENT ticket's already
//      -merged contract test to make room for this one — exactly the kind of casual widening the
//      ticket brief warns against ("not casually into PUBLISH_REFUSAL").
//   2. 0105's own migration comment states the ordering directly: "client OK is a PRECONDITION OF
//      SUBMITTING a variant for staff approval, never a substitute for it." That is a claim about
//      SUBMISSION, a different (and, in the current codebase, unbuilt-as-its-own-endpoint) moment
//      from PUBLISH/DISPATCH.
//   3. Precedent already exists for a SEPARATE, small, additively-composed refusal vocabulary rather
//      than folding a new routing question into `PUBLISH_REFUSAL`: `dispatch.ts`'s `DISPATCH_REFUSAL`
//      is kept apart from the six-stage chain for the identical reason ("A distinct, small vocabulary
///     — same separation core/approval-execute.ts's EXEC_ERROR keeps from PUBLISH_REFUSAL").
//      `CLIENT_REVIEW_REFUSAL` below follows that same idiom.
//
// Given there is (as of P1) no dedicated "submit for staff approval" endpoint in this module — a
// variant moves straight from composer edits to a WS4 `automation_approvals` row filed against the
// generic `POST /api/:t/automation-approvals` surface, with no per-tool filing-time hook anywhere in
// the estate (core/approval-executables.ts registers EXECUTION-time preconditions only) — the
// practical choke points where "submission" is actually observable are:
//   (a) the dry-run endpoint staff consult BEFORE filing a WS4 request
//       (`social.controller.ts#getVariantPublishPreconditions` / MCP tool `checkPublishPreconditions`)
//   (b) the D14 executor's own precondition, the moment a human's WS4 approval would otherwise fire
//       `schedulePost`
//   (c) SMM-10's own re-run of the same precondition under its own lock (`dispatch.ts`)
// `evaluatePublishPreconditionWithClientReview` below is composed into all three, so a variant whose
// engagement requires client sign-off is refused at the FIRST of these three moments a caller reaches
// — usually (a), which is exactly "gate submission" in the only sense the current architecture makes
// observable — and, crucially, re-derived every time rather than cached, so a client withdrawing
// consent or a staff edit invalidating a stale approval between filing and execution still refuses at
// (b)/(c) even if (a) was never consulted (an agent calling the tool directly, say).
//
// ── DOES NOT WEAKEN D14 ──────────────────────────────────────────────────────────────────────────
// This is a STRICTLY ADDITIONAL, orthogonal gate, evaluated BEFORE the six-stage chain and never
// touching `args_sha256`, the approval's single-use claim, or `neverAutoRetry`. A pass here still has
// to clear every one of `evaluatePublishPrecondition`'s six stages; a refusal here never spends
// anything (no grant is minted, no hub call is made) — identical to how a refusal at any of the six
// stages behaves today.
import type { PoolClient } from "pg";
import {
  declareSocialModuleScope,
  evaluatePublishPrecondition,
  SOCIAL_PUBLISH_TOOL,
  type PublishPreconditionStage,
  type PublishPreconditionVerdict,
  type PublishRefusalReason,
} from "./publish-precondition";

// ── The typed refusal vocabulary, kept apart from PUBLISH_REFUSAL (see header) ─────────────────────
export const CLIENT_REVIEW_REFUSAL = {
  /** `tool_scope.posting.requiresClientOk` is set and no review has ever been requested for this
   *  variant (no row exists at all). */
  clientReviewNotRequested: "client_review_not_requested",
  /** A review was requested and the client has not yet decided. */
  clientReviewPending: "client_review_pending",
  /** The client asked for changes. Re-request (which resets the row to `pending`) after addressing
   *  the feedback — see `requestClientReview`. */
  clientReviewChangesRequested: "client_review_changes_requested",
  /** Staff withdrew the ask (the content changed, the campaign was cancelled) and nobody has asked
   *  again since. */
  clientReviewWithdrawn: "client_review_withdrawn",
  /** The client approved, but the variant's content has changed since — `reviewed_args_sha256` (what
   *  they actually saw) no longer matches the variant's live `args_sha256`. Mirrors D-15's
   *  edit-invalidates-approval rule for the STAFF side of the same content: an edit after client
   *  sign-off must not let the stale sign-off carry the new content toward publish. */
  clientReviewStale: "client_review_stale",
} as const;
export type ClientReviewRefusalReason = (typeof CLIENT_REVIEW_REFUSAL)[keyof typeof CLIENT_REVIEW_REFUSAL];

export type ClientReviewPreconditionVerdict =
  | { ok: true }
  | { ok: false; reason: ClientReviewRefusalReason };

interface ClientReviewGateRow {
  requires_client_ok: boolean;
  live_args_sha256: string | null;
}

interface ClientReviewRow {
  status: string;
  reviewed_args_sha256: string | null;
}

/**
 * THE SUBMISSION PRECONDITION. Never writes, never performs network I/O — same contract as
 * `evaluatePublishPrecondition`. Declares its OWN module scope, additively and idempotently (same
 * doctrine as `declareSocialModuleScope`'s own header): every one of this function's three call
 * sites (the D14 executor's module-less transaction, `dispatch.ts`'s module-less re-check, and the
 * controller's `{modules:['social']}`-scoped dry run) reaches this function correctly regardless of
 * whether the caller remembered to declare the scope itself — the single defect class this module has
 * shipped four times already.
 *
 * A missing variant is reported as `{ok:true}` — never `client_review_not_requested` — because this
 * function must not be the one to invent "no such variant" as a fact; that is
 * `evaluatePublishPrecondition`'s `variant_not_found`, and this function runs BEFORE it in the
 * composed wrapper below.
 */
export async function evaluateClientReviewPrecondition(
  c: PoolClient,
  variantId: string,
): Promise<ClientReviewPreconditionVerdict> {
  await declareSocialModuleScope(c);

  const { rows } = await c.query<ClientReviewGateRow>(
    `SELECT (e.tool_scope -> 'posting' ->> 'requiresClientOk')::boolean AS requires_client_ok,
            v.args_sha256 AS live_args_sha256
       FROM social_post_variants v
       JOIN social_posts p       ON p.id = v.post_id       AND p.tenant_id = v.tenant_id
       JOIN social_engagements e ON e.id = p.engagement_id AND e.tenant_id = v.tenant_id
      WHERE v.id = $1 AND v.deleted_at IS NULL`,
    [variantId],
  );
  const row = rows[0];
  if (!row || row.requires_client_ok !== true) return { ok: true };

  // `social_post_client_reviews` is the PLAIN tenant wall (see this file's header) — no module scope
  // needed for THIS read, and `declareSocialModuleScope` above is additive so it does not narrow it.
  const review = await c.query<ClientReviewRow>(
    `SELECT status, reviewed_args_sha256 FROM social_post_client_reviews WHERE variant_id = $1`,
    [variantId],
  );
  const r = review.rows[0];
  if (!r) return { ok: false, reason: CLIENT_REVIEW_REFUSAL.clientReviewNotRequested };
  if (r.status === "pending") return { ok: false, reason: CLIENT_REVIEW_REFUSAL.clientReviewPending };
  if (r.status === "withdrawn") return { ok: false, reason: CLIENT_REVIEW_REFUSAL.clientReviewWithdrawn };
  if (r.status === "changes_requested") return { ok: false, reason: CLIENT_REVIEW_REFUSAL.clientReviewChangesRequested };
  // status === 'approved': stale if the client's snapshot no longer matches the live content.
  if (r.reviewed_args_sha256 !== row.live_args_sha256) return { ok: false, reason: CLIENT_REVIEW_REFUSAL.clientReviewStale };
  return { ok: true };
}

export type GatedPublishVerdict =
  | { ok: true }
  | { ok: false; stage: "client_review"; reason: ClientReviewRefusalReason }
  | { ok: false; stage: PublishPreconditionStage; reason: PublishRefusalReason };

/**
 * ONE IMPLEMENTATION, THREE CALLERS (`core/approval-executables.ts`'s `socialPublishPrecondition`,
 * `dispatch.ts`'s `checkPreconditionAndResolveApproval`, and
 * `social.controller.ts#getVariantPublishPreconditions`) — composes the client-review gate in FRONT
 * of the pinned six-stage chain, never inside it. First refusal wins, exactly like the six-stage
 * chain's own doctrine.
 */
export async function evaluatePublishPreconditionWithClientReview(
  c: PoolClient,
  toolArgs: Record<string, unknown>,
  toolName: string = SOCIAL_PUBLISH_TOOL,
  now: Date = new Date(),
): Promise<GatedPublishVerdict> {
  const variantId = typeof toolArgs?.variantId === "string" ? toolArgs.variantId : null;
  if (variantId) {
    const review = await evaluateClientReviewPrecondition(c, variantId);
    if (!review.ok) return { ok: false, stage: "client_review", reason: review.reason };
  }
  const verdict: PublishPreconditionVerdict = await evaluatePublishPrecondition(c, toolArgs, toolName, now);
  if (verdict.ok) return { ok: true };
  return { ok: false, stage: verdict.stage, reason: verdict.reason };
}
