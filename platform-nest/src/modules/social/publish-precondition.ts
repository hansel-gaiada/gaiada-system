// SMM-09 — THE PUBLISH GATE's server-side re-evaluation, and the typed refusal vocabulary that
// SMM-10/17/22/31 consume.
//
// Design: docs/blueprints/smm-design-addendum-2026-08-12.md — SMM-09 row, D-14 (publish executes on
// approval; money is split out of that path), D-15 (`payload_hash` IS `argsSha256`), plus D-22
// (owner decision 2026-08-18: the composer's explicit selections ARE the TikTok creator consent, and
// `creator_info` is re-verified at dispatch).
//
// ── WHAT THIS FILE IS ───────────────────────────────────────────────────────────────────────────
// `core/approval-executables.ts` registers `social.publishPost` as a D14 executable approval. Its
// `precondition` is `evaluatePublishPrecondition` below: the WD-29 lesson applied to the one action
// in this estate that is genuinely irreversible. A human clicked Approve at T; the executor runs at
// T+minutes-or-hours with nobody standing by; between those two instants the variant may have been
// edited, the account may have been disconnected, the client may have been re-scoped, the quota may
// have filled, the budget may have been spent and a TikTok creator may have changed their own
// privacy settings. A verdict of `{ ok: false }` means the executor NEVER calls the hub — no tool
// call, no grant spent, no post.
//
// It is sited in the MODULE (not in `core/`) for the same reason `webdev.provisionSite`'s body lives
// in `modules/webdev/provisioning.service.ts`: the domain knowledge is the module's, and the registry
// entry should be a thin, auditable binding of (lockKey, precondition) rather than a second home for
// social-media rules that would drift from the ones the composer enforces.
//
// ── THE ORDER IS THE CONTRACT: scope → quota → hash → unconsumed → budget → creator-info ─────────
// The first five and their order are fixed by the SMM-09 ticket row and D-14. The sixth is D-22's,
// and it is APPENDED rather than interleaved — deliberately, and here is why:
//
//   * The five run cheapest-and-most-structural first. `scope` answers "may this content reach this
//     account at all", which is the question whose wrong answer is a client's post on another
//     client's public feed; there is no point costing out a budget for a publish that was never
//     allowed to happen.
//   * `hash` must come before anything that reasons about WHAT was approved, because until the hash
//     matches we do not know that the row in front of us is the content the human saw. D-22's
//     creator-info check compares the APPROVED SELECTIONS (which live inside the hashed args)
//     against the creator's live settings — so it is only meaningful AFTER `hash` has passed.
//   * `creator_info` is the closest-to-dispatch check and the only one whose answer can come from
//     outside our own database. Running it last means every deterministic refusal has already been
//     spent, so an operator reading `precondition_failed: creator_info_unverified` knows the ONLY
//     remaining obstacle is the consent re-verify — not that it happened to be checked first.
//
// ── THE REASON TOKENS ARE A CONTRACT, NOT LOG MESSAGES ──────────────────────────────────────────
// Each is stored verbatim after `precondition_failed: ` in `automation_approvals.execution_error`
// (core/approval-execute.ts), surfaces in the approvals UI and in a notification, and is branched on
// by SMM-10 (dispatch), SMM-17 (replies), SMM-22 (X metering) and SMM-31 (client review). Add a
// token rather than reword one. Never put user text, identifiers or secrets in a token.
//
// ── WHAT THIS FILE DOES NOT DO ──────────────────────────────────────────────────────────────────
// It does not publish, does not consume the approval, does not stamp `provider_post_id` and does not
// call `SocialPublisher.schedulePost`. That is SMM-10 (dispatch + status reconcile), which owns the
// transaction that consumes the one-shot approval and stamps the provider id together. This file
// answers exactly one question: may the executor call the hub AT ALL.
import type { PoolClient } from "pg";
import { variantArgsSha256, argsSha256 } from "./canonical-args";
import { validateVariant, estimateCostUsd, isNetwork, type Network, type QuotaSnapshot } from "./media-rules";
import { assertDispatchChain } from "./publisher/provisioning";
import { SocialPublisherError } from "./publisher/types";
// SMM-22: moved to its own leaf module — see this file's "module-scope GUC" section below for why,
// and for the re-export that keeps every OTHER file's existing import path unchanged.
import { declareSocialModuleScope } from "./module-scope";
// SMM-22 — the D-9 stop-loss chain's tenant + global tiers, and X's config-sourced price. The
// engagement tier stays computed inline below (it was already here, pre-this-ticket); the tenant
// and global sums and the pure evaluateUsageBudget arithmetic are `usage-ledger.ts`'s own — one
// implementation, reused here AND by `dispatch.ts`'s reservation, never a second copy.
import { evaluateUsageBudget, resolveXPricing, sumUsageMonthToDate, sumGlobalUsageMonthToDate } from "./usage-ledger";
import { config } from "../../config";

/** The two tool names D-14 splits the publish path across. `social.publishPost` is the $0 path and
 *  is registry-eligible; `social.publishPostMetered` carries any variant on a metered network (X
 *  today) and is BARRED from executing — see `core/approval-executables.ts`'s SMM-09 section. */
export const SOCIAL_PUBLISH_TOOL = "social.publishPost";
export const SOCIAL_PUBLISH_METERED_TOOL = "social.publishPostMetered";

/** The hub-side classification `social.publishPost` MUST carry when SMM-10 declares it as an
 *  `McpToolDef` with a real dispatch endpoint. Exported as a pinned constant (rather than restated
 *  in prose) because these two values ARE the D14 gate: `write && impact !== 'low'` is what suspends
 *  an automation/agent call into WS4 in `mcp-hub/src/policy.ts`, and `automation_approvals.impact`
 *  cannot even REPRESENT a low-impact write. A publish that is not `high` is a publish that does not
 *  suspend. */
export const SOCIAL_PUBLISH_TOOL_CLASSIFICATION = { write: true, impact: "high" } as const;

/** SMM-22 — the metered twin's classification. SPREAD, never retyped, exactly like
 *  `SOCIAL_REPLY_TOOL_CLASSIFICATION`: a metered publish is the SAME outbound-public,
 *  irreversible act as the free one, so it shares one classification literal, not two that could
 *  drift. Used by `core/approval-executables.ts`'s SMM-22 section (only reachable when the bar is
 *  lifted) and by `modules/social/index.ts`'s McpToolDef declaration (declared regardless of
 *  whether the bar is lifted — the tool exists and suspends into WS4 either way; only auto-execution
 *  on approval is config-gated). */
export const SOCIAL_PUBLISH_METERED_TOOL_CLASSIFICATION = { ...SOCIAL_PUBLISH_TOOL_CLASSIFICATION };

// ── The typed refusal vocabulary ────────────────────────────────────────────────────────────────

/** Every token this gate can produce, grouped by the stage that produces it. The object is the
 *  single source of truth: tests iterate it, and `PublishRefusalReason` is derived from it so a new
 *  token cannot be introduced without appearing here. */
export const PUBLISH_REFUSAL = {
  // ── (1) scope ──────────────────────────────────────────────────────────────────────────────
  /** No variant row resolves in this tenant (deleted, never existed, or hidden by RLS). Also the
   *  answer when the FK chain itself is broken — it never confirms that some other tenant's row
   *  exists. */
  variantNotFound: "variant_not_found",
  /** The target account belongs to a different client than the post's engagement. THE
   *  wrong-account-publish defence (design §11), re-derived at execution time. Reused verbatim from
   *  `SocialPublisherError`'s code so the estate has one spelling of this fact, not two. */
  crossClientAccount: "cross_client_account",
  /** The account (or its publisher org) is no longer in a state that can publish. */
  accountNotConnected: "account_not_connected",
  /** The network is off at the DEPLOYMENT level (SOCIAL_NETWORKS_ENABLED), which outranks any
   *  per-engagement tool scope. */
  networkDisabled: "network_disabled",
  /** The engagement's own `tool_scope.networks[<network>]` is not `true`. The per-engagement dial
   *  SMM-05's `assertDispatchChain` explicitly left for this ticket to check. */
  networkNotInScope: "network_not_in_scope",
  /** The engagement is not `active` (paused, closed, or still a draft). An approval filed while the
   *  engagement was live must not fire after it was deliberately stopped. */
  engagementInactive: "engagement_inactive",
  /** A metered-network variant reached the $0 tool. D-14 splits the path BY TOOL NAME so the money
   *  bar is visible at the tool surface rather than as a runtime branch; a metered variant on
   *  `social.publishPost` is a routing bug, and it fails closed here rather than spending. */
  meteredNetworkRequiresMeteredTool: "metered_network_requires_metered_tool",
  /** SMM-22, the symmetric belt-and-braces check: a NON-metered-network variant reached the
   *  metered tool. Not itself a money risk (no cap exists to breach), but a routing bug the OTHER
   *  direction from `meteredNetworkRequiresMeteredTool` — the metered path should never write an
   *  `x_post`-kind ledger row for, say, an Instagram post. Refused at the same stage for the same
   *  reason: the tool-name split IS the D-14 gate, and it must hold both ways. */
  meteredToolRequiresMeteredNetwork: "metered_tool_requires_metered_network",

  // ── (2) quota ──────────────────────────────────────────────────────────────────────────────
  /** The account's live posting quota is spent. `quota_unknown` is deliberately NOT escalated —
   *  media-rules.ts's standing doctrine is that an absent counter warns and never certifies, and
   *  turning a warning into a hard refusal here would make an unsynced registry look like a full
   *  one. */
  quotaExhausted: "quota_exhausted",
  /** Re-running the network's media/body/schedule rules against the CURRENT account state fails.
   *  This is not a duplicate of composer-time validation: `validateVariant` is time-sensitive
   *  (Facebook's native-scheduling window is 10 minutes to 30 days), so an approval whose scheduled
   *  slot has since passed lands here rather than being posted at the wrong time. */
  mediaRulesFailed: "media_rules_failed",

  // ── (3) hash ───────────────────────────────────────────────────────────────────────────────
  /** EDIT-INVALIDATES-APPROVAL, mechanically. The live variant no longer hashes to the value the
   *  approval was minted against (D-15). Any content edit moves the hash, so the approval stops
   *  applying — this is a structural property, not a policed one. */
  argsHashMismatch: "args_hash_mismatch",

  // ── (4) unconsumed ─────────────────────────────────────────────────────────────────────────
  /** REPLAY REFUSED. The variant already carries a provider post id, or has already left the
   *  pre-dispatch states. A second approved row reaching execution for the same variant is a
   *  decision made from a snapshot that predates the publish that already went out. */
  alreadyDispatched: "already_dispatched",
  /** A grant was already spent on this variant (`social_post_variants.approval_id` is set). The
   *  schema's `ux_social_post_variants_approval` partial unique index is the second, independent
   *  half of the same one-shot rule. */
  approvalAlreadyConsumed: "approval_already_consumed",
  /** The variant is not in `approved`. The commonest live cause is an EDIT: the composer's own
   *  update statement reverts `in_review`/`approved` to `draft` in the same statement that moves the
   *  hash, so an edited variant fails `hash` first and would fail here too. */
  variantNotApproved: "variant_not_approved",

  // ── (5) budget ─────────────────────────────────────────────────────────────────────────────
  /** D-9's stop-loss chain tripped at SOME tier — engagement, tenant, or global. The engagement
   *  tier was SMM-09's own check; SMM-22 adds the tenant and global tiers to the SAME token rather
   *  than inventing a per-tier spelling, because every tier answers the identical operator
   *  question ("this publish would spend past a configured cap") and a caller branches on `stage`
   *  ("budget"), not on WHICH tier, to render it. Which tier tripped is visible on the usage panel,
   *  never inferred from the refusal token alone. */
  budgetExceeded: "budget_exceeded",
  /** SMM-22, defect class #4: X's per-post price is unconfigured. FAIL CLOSED — an absent price
   *  must refuse, never default to $0 (a zero price is an unmetered spend). This is the steady
   *  state for every deployment that has not set `SOCIAL_X_PER_POST_COST_USD`/
   *  `SOCIAL_X_PER_POST_WITH_LINK_COST_USD`, which today is every deployment (X also ships
   *  disabled at `SOCIAL_NETWORKS_ENABLED`, so the `scope` stage's `network_disabled` refusal
   *  fires first in practice — this branch exists so turning X on does not silently turn the price
   *  requirement off with it). */
  meteredPriceUnconfigured: "metered_price_unconfigured",

  // ── (6) creator-info (D-22) ────────────────────────────────────────────────────────────────
  /** TikTok variant, and no creator-info re-verification is available at this instant. FAIL CLOSED,
   *  and this is the steady state until SMM-10 installs the dispatch-side verifier: TikTok requires
   *  the creator to consent immediately before upload, we approve at T and publish at T+hours, and
   *  "we could not check" must never read as "the creator still agrees". */
  creatorInfoUnverified: "creator_info_unverified",
  /** TikTok variant, verification available, and the creator's live settings no longer permit the
   *  selections the human approved (their account went private, comments/duet/stitch were turned
   *  off, the chosen privacy level is no longer offered). The approval was for THOSE selections;
   *  publishing anything else would misrepresent what was approved. */
  creatorSelectionNoLongerPermitted: "creator_selection_no_longer_permitted",
} as const;

export type PublishRefusalReason = (typeof PUBLISH_REFUSAL)[keyof typeof PUBLISH_REFUSAL];

/** The six stages, in evaluation order. Exported so callers (and tests) can assert the ORDER rather
 *  than infer it, and so the dry-run endpoint can report which gate stopped a variant. */
export const PUBLISH_PRECONDITION_STAGES = ["scope", "quota", "hash", "unconsumed", "budget", "creator_info"] as const;
export type PublishPreconditionStage = (typeof PUBLISH_PRECONDITION_STAGES)[number];

/** Which stage owns each token. One map, so a caller can render "stopped at: quota" without
 *  string-matching, and so a token can never silently belong to two stages. */
export const PUBLISH_REFUSAL_STAGE: Record<PublishRefusalReason, PublishPreconditionStage> = {
  [PUBLISH_REFUSAL.variantNotFound]: "scope",
  [PUBLISH_REFUSAL.crossClientAccount]: "scope",
  [PUBLISH_REFUSAL.accountNotConnected]: "scope",
  [PUBLISH_REFUSAL.networkDisabled]: "scope",
  [PUBLISH_REFUSAL.networkNotInScope]: "scope",
  [PUBLISH_REFUSAL.engagementInactive]: "scope",
  [PUBLISH_REFUSAL.meteredNetworkRequiresMeteredTool]: "scope",
  [PUBLISH_REFUSAL.meteredToolRequiresMeteredNetwork]: "scope",
  [PUBLISH_REFUSAL.quotaExhausted]: "quota",
  [PUBLISH_REFUSAL.mediaRulesFailed]: "quota",
  [PUBLISH_REFUSAL.argsHashMismatch]: "hash",
  [PUBLISH_REFUSAL.alreadyDispatched]: "unconsumed",
  [PUBLISH_REFUSAL.approvalAlreadyConsumed]: "unconsumed",
  [PUBLISH_REFUSAL.variantNotApproved]: "unconsumed",
  [PUBLISH_REFUSAL.budgetExceeded]: "budget",
  [PUBLISH_REFUSAL.meteredPriceUnconfigured]: "budget",
  [PUBLISH_REFUSAL.creatorInfoUnverified]: "creator_info",
  [PUBLISH_REFUSAL.creatorSelectionNoLongerPermitted]: "creator_info",
};

export type PublishPreconditionVerdict =
  | { ok: true }
  | { ok: false; stage: PublishPreconditionStage; reason: PublishRefusalReason };

function refuse(reason: PublishRefusalReason): PublishPreconditionVerdict {
  return { ok: false, stage: PUBLISH_REFUSAL_STAGE[reason], reason };
}

// ── D-22: the creator-info re-verify seam ───────────────────────────────────────────────────────
//
// THE PROBLEM, stated so nobody "simplifies" this into a network call. TikTok requires the posting
// surface to show the creator their OWN live settings, fetched from `creator_info`, with no default
// privacy value, and to obtain consent IMMEDIATELY BEFORE the upload starts. Our spine approves at T
// and publishes unattended at T+hours. The owner's decision (D-22, 2026-08-18) is option (b) of
// OQ-8: the composer's explicit selections ARE the consent, AND `creator_info` is re-verified at
// dispatch.
//
// This precondition runs INSIDE the executor's open claim transaction, holding an advisory lock.
// `ExecutableApprovalEntry.precondition`'s own contract forbids network I/O there, for the reason
// core/approval-execute.ts's "TRANSACTION BOUNDARY" note gives: the hub re-enters this platform, so
// an outbound call under a held lock is a distributed self-deadlock waiting to happen. So the LIVE
// fetch is SMM-10's, at dispatch, outside this transaction — and what lives here is the HOOK plus
// its typed refusal:
//
//   * no verifier installed  -> a TikTok variant refuses `creator_info_unverified`. Fail closed.
//     This is the shipped state today and it is correct: `tiktok` is also off in
//     SOCIAL_NETWORKS_ENABLED, so the scope stage already refuses first in a default deployment.
//     The branch exists, and is tested, so that turning TikTok on does not silently turn the consent
//     rule off with it.
//   * verifier installed     -> it re-derives, READ-ONLY and IN THIS TRANSACTION, whether the
//     approved selections are still permitted by the creator's last-known live settings. SMM-10
//     owns where that snapshot is written (a schema decision that belongs to the senior-db seat) and
//     owns the fetch that refreshes it.
//
// A refusal here is NOT retried automatically — see `neverAutoRetry` on the registry entry.

export interface CreatorInfoContext {
  variantId: string;
  accountId: string;
  network: Network;
  /** The opaque upstream integration id the dispatch would target. */
  integrationId: string;
  /** OUR `social_publisher_orgs.id`. Never a key, never an alias's value. */
  publisherOrgId: string;
  /** The per-network selections the human approved, verbatim from the HASHED args — so a verifier
   *  can only ever be asked about selections that already passed the `hash` stage. */
  settings: Record<string, unknown>;
}

export type CreatorInfoVerdict =
  | { ok: true }
  | { ok: false; reason: typeof PUBLISH_REFUSAL.creatorInfoUnverified | typeof PUBLISH_REFUSAL.creatorSelectionNoLongerPermitted };

/** SMM-10 installs this. MUST be read-only and MUST NOT perform network I/O — it runs inside the
 *  executor's claim transaction under an advisory lock. */
export type CreatorInfoVerifier = (c: PoolClient, ctx: CreatorInfoContext) => Promise<CreatorInfoVerdict>;

let creatorInfoVerifier: CreatorInfoVerifier | null = null;

/** Install (or, with `null`, remove) the dispatch-side creator-info verifier. Mirrors
 *  `publisher/registry.ts`'s registration seam: a process-level slot that starts EMPTY, so the
 *  absence of a verifier is a REFUSAL rather than a silent pass. */
export function setCreatorInfoVerifier(verifier: CreatorInfoVerifier | null): void {
  creatorInfoVerifier = verifier;
}

/** Test/boot seam, matching `resetPublishers()`. */
export function resetCreatorInfoVerifier(): void {
  creatorInfoVerifier = null;
}

/** The networks whose platform rules require creator consent immediately before upload. TikTok is
 *  the only one today (addendum §A4h/§A4i, OQ-8 → D-22); it is a set rather than an `=== "tiktok"`
 *  so a second such network is a data change, not a control-flow edit. */
export const CONSENT_AT_UPLOAD_NETWORKS: ReadonlySet<string> = new Set(["tiktok"]);

/** The metered networks D-14 routes to the barred twin. X is the only one in v1. */
export const METERED_NETWORKS: ReadonlySet<string> = new Set(["x"]);

// ── lockKey ─────────────────────────────────────────────────────────────────────────────────────

/** The variant id from the publish call's arguments. `variantId` (not `postId`, not `tenantId`) is
 *  the key because the VARIANT is the unit of publication: one variant is one post on one account,
 *  and two approvals for the same variant are exactly what must be serialized. Keying on the POST
 *  would serialize a five-network fan-out behind itself for no benefit; keying on the TENANT would
 *  serialize every publish in the agency behind every other. */
export function extractVariantId(toolArgs: Record<string, unknown>): string | null {
  const v = toolArgs?.variantId;
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/** The advisory-lock key. A pure, stable function of `toolArgs` (a retry re-derives the same key).
 *
 *  A missing/malformed `variantId` must NOT collapse onto one shared constant: a bare literal like
 *  `"social.publishPost"` would serialize every bad-input approval for this tool behind a SINGLE
 *  lock for no benefit — the refusal does not need serialization, it needs to never reach the hub,
 *  which the precondition already guarantees on its own. Same fail-closed shape `deployLockKey` and
 *  `pmLockKey` established. */
export function publishLockKey(toolArgs: Record<string, unknown>, toolName: string): string {
  const variantId = extractVariantId(toolArgs);
  if (variantId) return variantId;
  return `${toolName}:invalid-variant-id:${JSON.stringify(toolArgs)}`;
}

// ── the module-scope GUC ────────────────────────────────────────────────────────────────────────
//
// SMM-22: the implementation moved to `module-scope.ts` (a shared leaf both this file and
// `usage-ledger.ts` can import without a cycle — see that file's own header; imported at the top of
// this file and re-exported here under its ORIGINAL name so every existing
// `import { declareSocialModuleScope } from "./publish-precondition"` (dispatch.ts,
// reply-precondition.ts, inbox-retention-job.ts, inbox-sync-job.ts, inbox-triage-job.ts,
// client-review.ts) keeps compiling unchanged).
export { declareSocialModuleScope };

// ── the chain ───────────────────────────────────────────────────────────────────────────────────

interface VariantRow {
  id: string;
  tenant_id: string;
  account_id: string;
  body: string;
  first_comment: string | null;
  media: unknown;
  settings: Record<string, unknown> | null;
  scheduled_at: Date | null;
  status: string;
  args_sha256: string | null;
  approval_id: string | null;
  provider_post_id: string | null;
  native_import: boolean;
  engagement_id: string;
  engagement_status: string;
  tool_scope: Record<string, Record<string, unknown>> | null;
  usage_budget_usd: string | number;
  network: string;
  account_quota: QuotaSnapshot | null;
}

/** The variant states that mean a dispatch ALREADY HAPPENED. `failed` and `cancelled` are
 *  deliberately absent: neither is a post that went out, so refusing them as `already_dispatched`
 *  would tell an operator something untrue. They fall through to `variant_not_approved`, which is
 *  what they are. */
const DISPATCHED_STATUSES = new Set(["queued", "publishing", "published"]);

/**
 * THE PRECONDITION. Called by `core/approval-executables.ts`'s `social.publishPost` entry on the
 * executor's own transaction, under `pg_advisory_xact_lock(APPROVAL_EXEC_LOCK_NS, hashtext(variantId))`.
 * Also called by the module's read-only dry-run endpoint so the approval card and the composer can
 * show WHY a publish will refuse before anyone clicks Approve — one implementation, two callers,
 * never two copies of the rule.
 *
 * Never writes a domain row. Never performs network I/O.
 *
 * `toolName` decides the D-14 money split: `social.publishPost` refuses a metered-network variant
 * (`metered_network_requires_metered_tool`) rather than spending, and the metered twin is barred
 * from the registry outright so it can never reach this function through the executor at all.
 */
export async function evaluatePublishPrecondition(
  c: PoolClient,
  toolArgs: Record<string, unknown>,
  toolName: string = SOCIAL_PUBLISH_TOOL,
  now: Date = new Date(),
): Promise<PublishPreconditionVerdict> {
  const variantId = extractVariantId(toolArgs);
  // Fail closed on missing/malformed args: there is no variant to re-evaluate against, and
  // `variant_not_found` is true whether the id is absent, the wrong type, or simply unknown here.
  if (!variantId) return refuse(PUBLISH_REFUSAL.variantNotFound);

  await declareSocialModuleScope(c);

  // ══ (1) SCOPE ═════════════════════════════════════════════════════════════════════════════════
  //
  // EXISTENCE FIRST, then the chain walk. The order is load-bearing and not a style choice:
  // `assertDispatchChain` answers "no such variant" and "the chain is broken" with the SAME
  // `cross_client_account` code — deliberately, because as an HTTP refusal it must never confirm
  // that some other tenant's row exists. Here the audience is different: an operator reading
  // `precondition_failed: cross_client_account` on their own tenant's approval must be able to tell
  // "the account belongs to another client" (a real, investigable control firing) from "that
  // variant is gone" (someone deleted it). So the row is resolved first and a miss is
  // `variant_not_found`; only a variant that genuinely exists can produce `cross_client_account`.
  const { rows } = await c.query<VariantRow>(
    `SELECT v.id, v.tenant_id, v.account_id, v.body, v.first_comment, v.media, v.settings,
            v.scheduled_at, v.status, v.args_sha256, v.approval_id, v.provider_post_id,
            v.native_import,
            p.engagement_id                      AS engagement_id,
            e.status                             AS engagement_status,
            e.tool_scope                         AS tool_scope,
            e.usage_budget_usd                   AS usage_budget_usd,
            a.network                            AS network,
            a.quota                              AS account_quota
       FROM social_post_variants v
       JOIN social_posts p       ON p.id = v.post_id       AND p.tenant_id = v.tenant_id
       JOIN social_engagements e ON e.id = p.engagement_id AND e.tenant_id = v.tenant_id
       JOIN social_accounts a    ON a.id = v.account_id    AND a.tenant_id = v.tenant_id
      WHERE v.id = $1 AND v.deleted_at IS NULL`,
    [variantId],
  );
  const row = rows[0];
  if (!row) return refuse(PUBLISH_REFUSAL.variantNotFound);

  // The FK-chain walk is SMM-05's `assertDispatchChain` — reused, never reimplemented. It answers
  // "is this account the right account for this variant", enforces the cross-client defence (design
  // §11) and the DEPLOYMENT-level network flag, and throws a `SocialPublisherError` whose `code` is
  // already a typed token in this estate's vocabulary. Mapping code → reason keeps one spelling of
  // each fact. An UNEXPECTED code (a driver refusal that could only arrive here through a code
  // change) collapses to `variant_not_found` rather than leaking an unknown token: the refusal
  // contract is CLOSED, and an open one would let a future edit invent a reason SMM-10/17/22/31
  // cannot branch on.
  let chain;
  try {
    chain = await assertDispatchChain(c, variantId);
  } catch (err) {
    if (err instanceof SocialPublisherError) {
      if (err.code === "cross_client_account") return refuse(PUBLISH_REFUSAL.crossClientAccount);
      if (err.code === "account_not_connected") return refuse(PUBLISH_REFUSAL.accountNotConnected);
      if (err.code === "network_disabled") return refuse(PUBLISH_REFUSAL.networkDisabled);
      return refuse(PUBLISH_REFUSAL.variantNotFound);
    }
    throw err;
  }

  // A native import DESCRIBES something a human already posted by hand. 0105's
  // `svar_native_import_is_bookkeeping` CHECK forbids it from carrying an approval or a provider id
  // at all, so an approval naming one is a bug upstream — and dispatching it would post the content
  // a SECOND time, publicly. Refused as already-dispatched, which is exactly what it is.
  if (row.native_import) return refuse(PUBLISH_REFUSAL.alreadyDispatched);

  if (row.engagement_status !== "active") return refuse(PUBLISH_REFUSAL.engagementInactive);

  const network = row.network;
  if (!isNetwork(network)) return refuse(PUBLISH_REFUSAL.variantNotFound);

  // The PER-ENGAGEMENT dial. `assertDispatchChain` checks the deployment-level flag and says in its
  // own doc that SMM-09 still owes this one; it is the check that makes an engagement's tool scope
  // mean something at execution time rather than only at composer time.
  const networksScope = (chain.toolScope ?? row.tool_scope ?? {}).networks as Record<string, unknown> | undefined;
  if (networksScope?.[network] !== true) return refuse(PUBLISH_REFUSAL.networkNotInScope);

  // D-14's money split, enforced at the tool surface. The metered twin is barred from the registry,
  // so this arm is what catches a metered variant that reached the FREE tool.
  if (toolName === SOCIAL_PUBLISH_TOOL && METERED_NETWORKS.has(network)) {
    return refuse(PUBLISH_REFUSAL.meteredNetworkRequiresMeteredTool);
  }
  // SMM-22 — the symmetric check. A non-metered-network variant has no business on the metered
  // tool: there is no money at stake, but writing an `x_post`-kind ledger row for (say) an
  // Instagram post would be a data-integrity bug the usage panel could not explain.
  if (toolName === SOCIAL_PUBLISH_METERED_TOOL && !METERED_NETWORKS.has(network)) {
    return refuse(PUBLISH_REFUSAL.meteredToolRequiresMeteredNetwork);
  }

  // ══ (2) QUOTA (and the network's media/body/schedule rules) ═══════════════════════════════════
  //
  // Re-run against the account's CURRENT registry snapshot and the CURRENT clock. Both move between
  // approval and execution, and both can turn a valid variant invalid without anyone touching it:
  // the quota fills, or Facebook's 10-minute-to-30-day native-scheduling window closes on a slot
  // that was comfortably in range when the human clicked Approve.
  const shape = {
    body: row.body ?? "",
    firstComment: row.first_comment,
    media: (row.media ?? []) as never[],
    settings: row.settings ?? {},
    scheduledAt: row.scheduled_at,
  };
  const validation = validateVariant(network, shape, row.account_quota ?? undefined, now);
  if (!validation.ok) {
    // `quota_exhausted` is reported as itself when present — "the account is out of posts" and "the
    // caption is too long" are different facts and a caller must be able to tell them apart.
    const exhausted = validation.errors.some((e) => e.rule === "quota_exhausted");
    return refuse(exhausted ? PUBLISH_REFUSAL.quotaExhausted : PUBLISH_REFUSAL.mediaRulesFailed);
  }

  // ══ (3) HASH — edit-invalidates-approval (D-15) ═══════════════════════════════════════════════
  //
  // Two comparisons, one reason, because they are two ways of asking the same question:
  //   (a) does the LIVE variant still hash to the value the executor is about to SEND as the tool
  //       arguments? That is the value the hub will recompute and the grant is bound to, so a
  //       mismatch here means the approved content and the current content are different content.
  //   (b) does the stored `args_sha256` column still agree with the live row? A disagreement means
  //       something wrote the content WITHOUT recomputing the anchor (a direct SQL edit, a future
  //       write path that forgot). The column is the composer's own anchor and the client-review
  //       stage compares against it, so a drifted column is a refusal, never a "close enough".
  const live = variantArgsSha256({
    tenantId: row.tenant_id,
    id: row.id,
    accountId: row.account_id,
    body: row.body ?? "",
    firstComment: row.first_comment,
    media: row.media,
    settings: row.settings,
    scheduledAt: row.scheduled_at,
  });
  if (live !== argsSha256(toolArgs)) return refuse(PUBLISH_REFUSAL.argsHashMismatch);
  if (row.args_sha256 !== live) return refuse(PUBLISH_REFUSAL.argsHashMismatch);

  // ══ (4) UNCONSUMED — the single-use half that lives in the DOMAIN ═════════════════════════════
  //
  // The APPROVAL's own single-use guarantee is the executor's claim (`execution_status='pending'` in
  // its UPDATE's WHERE clause). This stage is the other half: the VARIANT must not already have been
  // published, and must not already have spent a grant. Both are needed — the claim protects one row
  // against itself; this protects one variant against a SECOND approval filed for it.
  //
  // `approval_id` is stamped by SMM-10 in the SAME transaction that stamps `provider_post_id`
  // (0105's own header: "a variant reaches 'queued' ONLY by consuming an approved, unconsumed
  // approval whose argsSha256 matches, in the same transaction that stamps provider_post_id"). So a
  // non-null `approval_id` at THIS instant means a grant was already spent here. SMM-10 must keep
  // that stamping order; splitting it would make this check read as a false positive.
  if (row.provider_post_id !== null || DISPATCHED_STATUSES.has(row.status)) {
    return refuse(PUBLISH_REFUSAL.alreadyDispatched);
  }
  if (row.approval_id !== null) return refuse(PUBLISH_REFUSAL.approvalAlreadyConsumed);
  // Everything that is not `approved` lands here: `draft`/`in_review` (an edit reverted it — and
  // that edit also moved the hash, so stage 3 has usually already refused), `cancelled` (a human
  // pulled it), `failed` (a prior attempt never landed; a human presses Retry after fixing it, they
  // do not get an unattended second shot).
  if (row.status !== "approved") return refuse(PUBLISH_REFUSAL.variantNotApproved);

  // ══ (5) BUDGET — the metered stop-loss, re-checked at execution ═══════════════════════════════
  //
  // The estimate itself can now REFUSE (`x_price_not_configured`): an absent price is a fail-closed
  // condition, never a $0 stand-in, since a $0 estimate would let an unpriced X post sail through
  // every tier for free. For the $0 path (every network except X) `estimateCostUsd` never refuses —
  // there is nothing to misconfigure about a network that costs nothing.
  const estimate = estimateCostUsd(network, shape, resolveXPricing());
  if (!estimate.ok) return refuse(PUBLISH_REFUSAL.meteredPriceUnconfigured);

  const engagementCap = Number(row.usage_budget_usd);
  // SMM-22 ⚠ THE TENANT/GLOBAL TIERS ARE GATED ON `METERED_NETWORKS.has(network)`, DELIBERATELY —
  // read this before "simplifying" it into an unconditional 3-tier check.
  //
  // SMM-09's own engagement-tier check (unchanged, below) was designed as a per-CLIENT circuit
  // breaker: "an engagement already over its cap cannot publish AT ALL" — even a $0 Instagram post,
  // once THAT ENGAGEMENT's own metered spend has exceeded ITS OWN cap. That blast radius is
  // deliberately scoped to one client. Naively extending the SAME "$0 posts are blocked too" shape
  // to the TENANT and GLOBAL tiers would turn one runaway X bill into a PLATFORM-WIDE freeze on
  // every company's free Instagram/Facebook/LinkedIn posting the moment the global cap is breached
  // — a blast radius no design document asked for and this ticket must not invent. So the tenant
  // and global tiers apply ONLY to an actually-metered dispatch (`estimate.costUsd` can only be
  // nonzero for a network in `METERED_NETWORKS`, and the scope stage above already guarantees a
  // metered network only ever reaches here via the metered tool) — a $0 publish's ONLY budget
  // exposure remains the pre-existing engagement-tier check, exactly as before this ticket.
  const engagementMtd = await sumUsageMonthToDate(c, row.engagement_id);
  if (METERED_NETWORKS.has(network)) {
    const tenantMtd = await sumUsageMonthToDate(c);
    // Cross-tenant, TTL-cached — see that function's own header for why this is safe to call from
    // inside an already-open, lock-holding transaction (a separate pool connection, no lock taken).
    const globalMtd = await sumGlobalUsageMonthToDate();
    const decision = evaluateUsageBudget({
      estimate: estimate.costUsd,
      engagementCap, engagementMtd,
      tenantCap: config.social.usage.tenantMonthlyCapUsd, tenantMtd,
      globalCap: config.social.usage.globalMonthlyCapUsd, globalMtd,
    });
    if (!decision.ok) return refuse(PUBLISH_REFUSAL.budgetExceeded);
  } else {
    // The UNCHANGED, engagement-tier-only check every network except X has always run.
    if (!Number.isFinite(engagementCap) || engagementMtd + estimate.costUsd > engagementCap) {
      return refuse(PUBLISH_REFUSAL.budgetExceeded);
    }
  }

  // ══ (6) CREATOR-INFO re-verify (D-22) ═════════════════════════════════════════════════════════
  if (CONSENT_AT_UPLOAD_NETWORKS.has(network)) {
    if (!creatorInfoVerifier) return refuse(PUBLISH_REFUSAL.creatorInfoUnverified);
    const verdict = await creatorInfoVerifier(c, {
      variantId: row.id,
      accountId: row.account_id,
      network,
      integrationId: chain.integrationId,
      publisherOrgId: chain.org.id,
      settings: (row.settings ?? {}) as Record<string, unknown>,
    });
    if (!verdict.ok) return refuse(verdict.reason);
  }

  return { ok: true };
}
