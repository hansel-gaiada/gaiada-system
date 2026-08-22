"use server";
// Social-media (SMM) write paths — SMM-11. Mirrors the `lib/hrActions.ts` / `searchMarketingActions.ts`
// `ctx()` convention exactly. RBAC gating here is defence-in-depth only, a UI hint — Cerbos's
// `social_engagement`/`social_post` actions (cerbos/policies/resource_social_engagement.yaml,
// resource_social_post.yaml) are the real boundary and are enforced server-side by platform-nest
// regardless of what this file does.
//
// Every refusal token below is whatever `social.controller.ts`'s `refuse()` throws as `message`
// (renamed to `error` by the global HttpErrorFilter on the way out) — returned VERBATIM as
// `result.error` so a caller can render or branch on the exact snake_case contract token
// (docs/FRONTEND-BFF-CONTRACT.md §19: "Render against the token, never by matching prose"), never
// a re-worded string invented on this side of the wire.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError, type Me } from "./platform";
import { getActiveTenant } from "./tenant";
import { can } from "./rbac";
import type {
  ToolScope, CreatedResult, CreateVariantResult, UpdateVariantResult, PublishPreconditionResult,
  ClientReviewStatus, AttachMediaResult, ReplyDraftResult, ApproveReplyDraftResult,
  ReplySendPreconditionResult,
} from "./socialShared";

async function ctx(tenantOverride?: string): Promise<{ userId: string; tenant: string; me: Me } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = tenantOverride ?? (await getActiveTenant(me));
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant, me };
}

const base = (t: string) => `/api/${t}/modules/social`;

// eslint-disable-next-line @typescript-eslint/ban-types -- the empty-object default is deliberate:
// a plain write (delete, PATCH with no echoed payload) resolves to exactly `{ ok: true }`.
export type ActionResult<T = {}> = ({ ok: true } & T) | { ok: false; error: string };

function isCtxError(c: Awaited<ReturnType<typeof ctx>>): c is { error: string } {
  return "error" in c;
}

async function run<T>(tenantOverride: string | undefined, fn: (c: { userId: string; tenant: string; me: Me }) => Promise<T>): Promise<ActionResult<T>> {
  const c = await ctx(tenantOverride);
  if (isCtxError(c)) return { ok: false, error: c.error };
  try {
    const result = await fn(c);
    return { ok: true, ...result };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

// ── engagements ──────────────────────────────────────────────────────────────────────────────────

export async function createEngagement(
  tenantId: string,
  body: { clientId: string; name: string; projectId?: string; id?: string },
): Promise<ActionResult<CreatedResult>> {
  return run(tenantId, async (c) => {
    const res = await platformFetch<CreatedResult>(`${base(c.tenant)}/engagements`, c.userId, {
      method: "POST", body: JSON.stringify(body),
    });
    revalidatePath(`/departments`, "layout");
    return res;
  });
}

export async function updateEngagement(
  tenantId: string, engagementId: string,
  body: { name?: string; status?: string; projectId?: string | null; ownerId?: string | null; startsOn?: string | null; endsOn?: string | null },
): Promise<ActionResult> {
  return run(tenantId, async (c) => {
    await platformFetch(`${base(c.tenant)}/engagements/${engagementId}`, c.userId, { method: "PATCH", body: JSON.stringify(body) });
    return {};
  });
}

export async function deleteEngagement(tenantId: string, engagementId: string): Promise<ActionResult> {
  return run(tenantId, async (c) => {
    await platformFetch(`${base(c.tenant)}/engagements/${engagementId}`, c.userId, { method: "DELETE" });
    return {};
  });
}

export type SetScopeResult = { toolScope: ToolScope; usageBudgetUsd: number | undefined; warnings: string[] };

/** `social.engagement.set_scope` — the money-and-blast-radius dial (D-14). Gated on
 *  `social.scope.write` here as a UI hint; Cerbos's `set_scope` action is the real boundary.
 *  NOTE (contract discrepancy #1, see lib/social.ts's header): the response's `usageBudgetUsd` is
 *  only the value THIS call sent, not the persisted one — callers needing the true current budget
 *  after a scope-only patch must re-read `getEngagementScope`. */
export async function setEngagementScope(
  tenantId: string, engagementId: string, body: { toolScope?: Partial<ToolScope>; usageBudgetUsd?: number },
): Promise<ActionResult<SetScopeResult>> {
  const c0 = await ctx(tenantId);
  if (isCtxError(c0)) return { ok: false, error: c0.error };
  if (!can(c0.me, "social.scope.write", c0.tenant)) {
    return { ok: false, error: "You don't have the social.scope.write permission." };
  }
  return run(tenantId, async (c) => {
    const res = await platformFetch<SetScopeResult>(`${base(c.tenant)}/engagements/${engagementId}/scope`, c.userId, {
      method: "PATCH", body: JSON.stringify(body),
    });
    revalidatePath(`/departments`, "layout");
    return res;
  });
}

// ── brand profile ───────────────────────────────────────────────────────────────────────────────

export async function upsertBrandProfile(
  tenantId: string, clientId: string,
  body: { tone?: Record<string, unknown>; hashtagStrategy?: Record<string, unknown>; knowledgeSourceIds?: string[] },
): Promise<ActionResult> {
  return run(tenantId, async (c) => {
    await platformFetch(`${base(c.tenant)}/brand-profiles/${clientId}`, c.userId, { method: "PATCH", body: JSON.stringify(body) });
    return {};
  });
}

// ── campaigns / kpi targets ──────────────────────────────────────────────────────────────────────

export async function createCampaign(
  tenantId: string, body: { engagementId: string; name: string; goal?: string; id?: string },
): Promise<ActionResult<CreatedResult>> {
  return run(tenantId, async (c) => platformFetch<CreatedResult>(`${base(c.tenant)}/campaigns`, c.userId, {
    method: "POST", body: JSON.stringify(body),
  }));
}

export async function createKpiTarget(
  tenantId: string,
  body: { engagementId: string; metricKey: string; targetValue: number; baselineValue?: number; direction?: "up" | "down"; duePeriod?: string; id?: string },
): Promise<ActionResult<CreatedResult>> {
  return run(tenantId, async (c) => platformFetch<CreatedResult>(`${base(c.tenant)}/kpi-targets`, c.userId, {
    method: "POST", body: JSON.stringify(body),
  }));
}

// ── posts ────────────────────────────────────────────────────────────────────────────────────────

export async function createPost(
  tenantId: string,
  body: { engagementId: string; title: string; brief?: string; source?: "human" | "ai" | "agent"; campaignId?: string; scheduledAt?: string; id?: string },
): Promise<ActionResult<CreatedResult>> {
  return run(tenantId, async (c) => {
    const res = await platformFetch<CreatedResult>(`${base(c.tenant)}/posts`, c.userId, {
      method: "POST", body: JSON.stringify(body),
    });
    revalidatePath(`/departments`, "layout");
    return res;
  });
}

export async function updatePost(
  tenantId: string, postId: string,
  body: { title?: string; brief?: string; campaignId?: string | null; scheduledAt?: string | null; status?: string },
): Promise<ActionResult> {
  return run(tenantId, async (c) => {
    await platformFetch(`${base(c.tenant)}/posts/${postId}`, c.userId, { method: "PATCH", body: JSON.stringify(body) });
    revalidatePath(`/departments`, "layout");
    return {};
  });
}

/** May refuse `post_has_live_variants` — anything queued/publishing/published under the post
 *  blocks a soft delete; taking a LIVE post down is `delete_published`, a separate power (D-14/09,
 *  not built by this ticket). Gated on `social.post.delete` — same Cerbos `delete` action as
 *  `deleteVariant` below, denied to `module_staff`. */
export async function deletePost(tenantId: string, postId: string): Promise<ActionResult> {
  const c0 = await ctx(tenantId);
  if (isCtxError(c0)) return { ok: false, error: c0.error };
  if (!can(c0.me, "social.post.delete", c0.tenant)) {
    return { ok: false, error: "You don't have the social.post.delete permission." };
  }
  return run(tenantId, async (c) => {
    await platformFetch(`${base(c.tenant)}/posts/${postId}`, c.userId, { method: "DELETE" });
    revalidatePath(`/departments`, "layout");
    return {};
  });
}

export async function importNativePost(
  tenantId: string,
  body: { engagementId: string; accountId: string; title: string; body?: string; publishedUrl?: string; publishedAt?: string; id?: string },
): Promise<ActionResult<CreatedResult>> {
  return run(tenantId, async (c) => {
    const res = await platformFetch<CreatedResult>(`${base(c.tenant)}/posts/import-native`, c.userId, {
      method: "POST", body: JSON.stringify(body),
    });
    revalidatePath(`/departments`, "layout");
    return res;
  });
}

// ── variants ─────────────────────────────────────────────────────────────────────────────────────

export async function createVariant(
  tenantId: string, postId: string,
  body: { accountId: string; body?: string; firstComment?: string | null; media?: unknown[]; settings?: Record<string, unknown>; scheduledAt?: string | null; id?: string },
): Promise<ActionResult<CreateVariantResult>> {
  return run(tenantId, async (c) => {
    const res = await platformFetch<CreateVariantResult>(`${base(c.tenant)}/posts/${postId}/variants`, c.userId, {
      method: "POST", body: JSON.stringify(body),
    });
    revalidatePath(`/departments`, "layout");
    return res;
  });
}

/** Edit invalidates approval (design D-15) — the response's `approvalInvalidated` tells the
 *  caller immediately when this drops an approved/in-review variant back to `draft`; render it,
 *  don't let the operator find out on the next load. */
export async function updateVariant(
  tenantId: string, variantId: string,
  body: { body?: string; firstComment?: string | null; media?: unknown[]; settings?: Record<string, unknown>; scheduledAt?: string | null },
): Promise<ActionResult<UpdateVariantResult>> {
  return run(tenantId, async (c) => {
    const res = await platformFetch<UpdateVariantResult>(`${base(c.tenant)}/variants/${variantId}`, c.userId, {
      method: "PATCH", body: JSON.stringify(body),
    });
    revalidatePath(`/departments`, "layout");
    return res;
  });
}

/** Gated on `social.post.delete` — Cerbos denies this to `module_staff` (staff may author/submit
 *  but not remove) even though `social.manage`'s create/update tier is shared with staff. */
export async function deleteVariant(tenantId: string, variantId: string): Promise<ActionResult> {
  const c0 = await ctx(tenantId);
  if (isCtxError(c0)) return { ok: false, error: c0.error };
  if (!can(c0.me, "social.post.delete", c0.tenant)) {
    return { ok: false, error: "You don't have the social.post.delete permission." };
  }
  return run(tenantId, async (c) => {
    await platformFetch(`${base(c.tenant)}/variants/${variantId}`, c.userId, { method: "DELETE" });
    revalidatePath(`/departments`, "layout");
    return {};
  });
}

// ── asset library attach (SMM-20, AMENDED by D-17 — attach only, generation removed) ──────────────
//
// Attaches ONE library asset (an existing `files` row or a Studio-graded `creative_assets` row)
// onto a variant's `media`. Same "edit invalidates approval" contract `updateVariant` carries —
// `approvalInvalidated` must be rendered immediately, never discovered on the next load.
export async function attachVariantMedia(
  tenantId: string, variantId: string,
  body: { source: "file" | "creative_asset"; assetId: string; alt?: string; kind?: "image" | "video"; format?: string },
): Promise<ActionResult<AttachMediaResult>> {
  return run(tenantId, async (c) => {
    const res = await platformFetch<AttachMediaResult>(`${base(c.tenant)}/variants/${variantId}/media/attach`, c.userId, {
      method: "POST", body: JSON.stringify(body),
    });
    revalidatePath(`/departments`, "layout");
    return res;
  });
}

// ── submit-with-preview (SMM-12) ────────────────────────────────────────────────────────────────
//
// The composer's "would this publish right now?" button. A GET, not a write — routed through a
// server action anyway (rather than living in `lib/social.ts`) because the caller is a client
// component firing it on demand from a click, and `lib/social.ts` is `server-only` and cannot be
// imported from a "use client" file at all. Read-tier on the backend (`social_post`/`read`); no
// `can()` gate here beyond the ordinary session check — staff who author content are exactly who
// needs this answer, same reasoning the controller's own comment gives.
export async function checkPublishPreconditions(
  tenantId: string, variantId: string,
): Promise<ActionResult<{ verdict: PublishPreconditionResult }>> {
  return run(tenantId, async (c) => {
    const verdict = await platformFetch<PublishPreconditionResult>(
      `${base(c.tenant)}/variants/${variantId}/publish-preconditions`, c.userId,
    );
    return { verdict };
  });
}

// ── drag-to-reschedule (SMM-12) ──────────────────────────────────────────────────────────────────
//
// Dragging a post card to a new day on the calendar moves the POST's own `scheduledAt` (cosmetic —
// it's what the calendar groups by) AND every one of its variants' `scheduledAt` (the field that
// actually matters: it is part of the hashed args, addendum D-15). `updateVariant`'s own statement
// already reverts an `approved`/`in_review` variant to `draft` and clears `approval_id` in the SAME
// write that moves the hash — that mechanical invalidation is the backend's, not re-implemented
// here. This action's job is only to fire one call per row and report each row's own outcome
// honestly: a locked variant (`variant_not_editable`, `variant_native_import_immutable`) refuses
// independently of its siblings, and the caller must be able to tell which network that was, not
// just that "something" in the batch failed. The CALLER (CalendarGrid) is responsible for warning
// the operator BEFORE calling this — by the time this runs, the drop has already been committed.
export interface RescheduleVariantOutcome {
  variantId: string;
  ok: boolean;
  approvalInvalidated?: boolean;
  error?: string;
}

export async function rescheduleVariants(
  tenantId: string, postId: string, scheduledAtIso: string, variantIds: string[],
): Promise<ActionResult<{ variants: RescheduleVariantOutcome[] }>> {
  const c0 = await ctx(tenantId);
  if (isCtxError(c0)) return { ok: false, error: c0.error };
  if (!can(c0.me, "social.manage", c0.tenant)) {
    return { ok: false, error: "You don't have the social.manage permission." };
  }
  return run(tenantId, async (c) => {
    // The post's own date moves first — purely so the calendar's grouping reflects the drop even
    // if every variant beneath it turns out to be locked (a post-level reschedule is never refused,
    // only a variant's can be).
    await platformFetch(`${base(c.tenant)}/posts/${postId}`, c.userId, {
      method: "PATCH", body: JSON.stringify({ scheduledAt: scheduledAtIso }),
    });
    const variants: RescheduleVariantOutcome[] = [];
    for (const variantId of variantIds) {
      try {
        const res = await platformFetch<UpdateVariantResult>(`${base(c.tenant)}/variants/${variantId}`, c.userId, {
          method: "PATCH", body: JSON.stringify({ scheduledAt: scheduledAtIso }),
        });
        variants.push({ variantId, ok: true, approvalInvalidated: res.approvalInvalidated });
      } catch (e) {
        variants.push({ variantId, ok: false, error: e instanceof PlatformError ? e.message : "Reschedule failed." });
      }
    }
    revalidatePath(`/departments`, "layout");
    return { variants };
  });
}

// ── client review (SMM-31/32, D-16) — the STAFF side of the two-sided seam: ask + retract. The
// CLIENT's own decision lives on the portal (`lib/portalActions.ts`'s `portalDecideSocialReview`),
// never here — same split the backend's own two controllers enforce.

export interface RequestClientReviewResult { id: string; status: "pending"; alreadyPending: boolean }

/** `social.client_review.request` — ask the client to sign off. **Idempotent upsert**: 0105's
 *  `UNIQUE(variant_id)` means one review row per variant forever, so re-asking from ANY prior state
 *  (including after `withdrawn`/`changes_requested`, or after an edit staled a prior `approved`)
 *  resets the SAME row to `pending` rather than filing a second one. A repeat call while already
 *  `pending` is a no-op (`alreadyPending:true`, no duplicate notification on the backend). */
export async function requestClientReview(tenantId: string, variantId: string): Promise<ActionResult<RequestClientReviewResult>> {
  const c0 = await ctx(tenantId);
  if (isCtxError(c0)) return { ok: false, error: c0.error };
  if (!can(c0.me, "social.client_review.request", c0.tenant)) {
    return { ok: false, error: "You don't have the social.client_review.request permission." };
  }
  return run(tenantId, async (c) => {
    const res = await platformFetch<RequestClientReviewResult>(`${base(c.tenant)}/variants/${variantId}/client-review`, c.userId, {
      method: "POST",
    });
    revalidatePath(`/departments`, "layout");
    return res;
  });
}

export interface WithdrawClientReviewResult { id: string; status: ClientReviewStatus }

/** `social.client_review.withdraw` — **manager-tier**, unlike `request`/`read` which `social_staff`
 *  also holds (mirrors `social.post.delete`'s own staff/manager split). Retract a PENDING ask.
 *  Idempotent: withdrawing an already-withdrawn review is a 200 no-op on the backend, never an
 *  error. Refuses `client_review_not_pending` (400) if the review is already `approved`/
 *  `changes_requested` — re-ask instead via `requestClientReview`, which resets the same row. */
export async function withdrawClientReview(tenantId: string, variantId: string): Promise<ActionResult<WithdrawClientReviewResult>> {
  const c0 = await ctx(tenantId);
  if (isCtxError(c0)) return { ok: false, error: c0.error };
  if (!can(c0.me, "social.client_review.withdraw", c0.tenant)) {
    return { ok: false, error: "You don't have the social.client_review.withdraw permission." };
  }
  return run(tenantId, async (c) => {
    const res = await platformFetch<WithdrawClientReviewResult>(`${base(c.tenant)}/variants/${variantId}/client-review/withdraw`, c.userId, {
      method: "POST",
    });
    revalidatePath(`/departments`, "layout");
    return res;
  });
}

// ── the engagement inbox reply flow (SMM-17 backend, SMM-18 this ticket) — draft / edit / approve
// ONLY. Deliberately no `sendReply` action here: `POST .../messages/:messageId/send` is the D14
// dispatch endpoint, reachable in the ordinary flow ONLY through the executor's re-drive (mirrors
// `dispatchPublish`'s own documented convention — no UI in this codebase calls `POST
// variants/:id/publish` directly either, verified by grep). Its own precondition requires a
// pre-existing, currently-EXECUTING `social.sendReply` automation approval
// (`approval_not_resolvable` otherwise) — a direct human POST from this console would refuse every
// single time, the exact dead-button anti-pattern `rbac.ts`'s own discipline names. Reported as an
// open question in this ticket's final report: how a human-initiated reply actually reaches the
// automation-approval queue at all is not answered anywhere in `social.controller.ts`.
// Gated on `social.inbox.reply` here as a UI hint only — Cerbos's `assign` action on `social_inbox`
// is the real boundary for all three writes below (drafting/editing/approving a reply rides `assign`,
// per `resource_social_inbox.yaml`'s own header: "a draft is a row in our DB").

export async function createReplyDraft(
  tenantId: string, threadId: string, body: string,
): Promise<ActionResult<ReplyDraftResult>> {
  const c0 = await ctx(tenantId);
  if (isCtxError(c0)) return { ok: false, error: c0.error };
  if (!can(c0.me, "social.inbox.reply", c0.tenant)) {
    return { ok: false, error: "You don't have the social.inbox.reply permission." };
  }
  return run(tenantId, async (c) => {
    const res = await platformFetch<ReplyDraftResult>(`${base(c.tenant)}/threads/${threadId}/messages`, c.userId, {
      method: "POST", body: JSON.stringify({ body }),
    });
    revalidatePath(`/departments`, "layout");
    return res;
  });
}

/** Edit invalidates approval (D-15, restated for a reply) — the response's `approvalInvalidated`
 *  must be rendered immediately, same discipline `updateVariant` follows. */
export async function updateReplyDraft(
  tenantId: string, threadId: string, messageId: string, body: string,
): Promise<ActionResult<ReplyDraftResult>> {
  const c0 = await ctx(tenantId);
  if (isCtxError(c0)) return { ok: false, error: c0.error };
  if (!can(c0.me, "social.inbox.reply", c0.tenant)) {
    return { ok: false, error: "You don't have the social.inbox.reply permission." };
  }
  return run(tenantId, async (c) => {
    const res = await platformFetch<ReplyDraftResult>(`${base(c.tenant)}/threads/${threadId}/messages/${messageId}`, c.userId, {
      method: "PATCH", body: JSON.stringify({ body }),
    });
    revalidatePath(`/departments`, "layout");
    return res;
  });
}

/** Idempotent on the backend (an already-`approved` message re-approves as a no-op). */
export async function approveReplyDraft(
  tenantId: string, threadId: string, messageId: string,
): Promise<ActionResult<ApproveReplyDraftResult>> {
  const c0 = await ctx(tenantId);
  if (isCtxError(c0)) return { ok: false, error: c0.error };
  if (!can(c0.me, "social.inbox.reply", c0.tenant)) {
    return { ok: false, error: "You don't have the social.inbox.reply permission." };
  }
  return run(tenantId, async (c) => {
    const res = await platformFetch<ApproveReplyDraftResult>(`${base(c.tenant)}/threads/${threadId}/messages/${messageId}/approve`, c.userId, {
      method: "POST",
    });
    revalidatePath(`/departments`, "layout");
    return res;
  });
}

// ── send-preconditions dry run (SMM-17) — a GET, routed through a server action for the same
// reason `checkPublishPreconditions` above is: a client component fires it on demand and cannot
// import `lib/social.ts` (server-only) directly.
export async function checkReplySendPreconditions(
  tenantId: string, threadId: string, messageId: string,
): Promise<ActionResult<{ verdict: ReplySendPreconditionResult }>> {
  return run(tenantId, async (c) => {
    const verdict = await platformFetch<ReplySendPreconditionResult>(
      `${base(c.tenant)}/threads/${threadId}/messages/${messageId}/send-preconditions`, c.userId,
    );
    return { verdict };
  });
}
