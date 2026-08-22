// SMM-13 — notification and mail routing for social post events.
// SMM-31 extends the same routing table with the client-review stage's two events.
// SMM-16 extends it again with the inbox SLA guard's breach event and the spike detector's event.
//
// Routing:
// - `social.post.dispatched` → notifications only (routine success)
// - `social.post.published` → notifications only (routine success)
// - `social.post.failed` → notifications + mail (risk warning)
// - `social.client_review.requested` → notifies the CLIENT (portal contacts) that a post awaits them
// - `social.client_review.decided` → notifies STAFF (the engagement owner) of the client's decision
// - `social.client_review.withdrawn` → notifies the CLIENT that the ask was RETRACTED (same audience
//   as `.requested`; silence here left a live bell entry pointing at a row the client could no
//   longer see, which reads as a broken portal rather than a withdrawn request)
// - `social.inbox.sla_breached` → notifications + mail (risk warning — a customer-visible thread has
//   gone unanswered past the engagement's OWN configured response window)
// - `social.inbox.spike_detected` → notifications only (attention-needed, not yet a confirmed
//   incident — see `inbox-triage-job.ts`'s own header on why this has no measured baseline yet)
//
// Event payload contains: network, engagementId, providerPostId, reason (for failed)
// We query the engagement to find the owner and notify them of the outcome.
//
// Every handler added by SMM-31 AND SMM-16 rides the ALREADY-DRAINED "social_post_variant"
// entity-type stream (main.ts#startConsumerLoop) — deliberately, rather than a new stream name,
// because that list is the ONE thing deciding whether a Redis stream is ever read at all (this
// file's own SMM-14 fix, documented at the call site in main.ts): a new stream name here with no
// corresponding addition there would be exactly the "registered but never invoked" defect this
// module has already shipped once. `entityId` on the OUTBOX event is whatever the emitting job
// says it is (a review id, a thread id, an account id) — never assumed to be a variant id just
// because the stream is named after one; each handler below reads its own real ids out of the
// payload instead.
import { withTenants } from "../../db";
import { declareSocialModuleScope } from "./publish-precondition";
import { notify } from "../../core/http";
import { resolveClientRecipients, notifyBestEffort } from "../../core/client-notify";
import { enqueueMail } from "../../mail/queue";
import type { OutboxEvent } from "../../events/types";

interface SocialPostEventPayload {
  network?: string;
  engagementId?: string;
  providerPostId?: string;
  reason?: string; // for failed events
  detail?: string; // for failed events
  [key: string]: unknown;
}

interface EngagementRow {
  owner_id: string | null;
  name: string;
  /** The owner's address. enqueueMail VALIDATES this before it does anything else, so it has to be
   *  real by the time we call: an empty string throws `implausible recipient address` whenever mail
   *  is enabled, and is silently skipped whenever it is not. Both are wrong, and the second is the
   *  one that hides. */
  owner_email: string | null;
}

/** Query the engagement to find the owner. */
async function loadEngagementOwner(tenantId: string, engagementId: string): Promise<EngagementRow | null> {
  return withTenants([tenantId], async (c) => {
    // 0105's THIRD wall: every social_* table is additionally gated on app_module_allowed('social'),
    // which withTenants() alone does not satisfy. Without this the SELECT returns zero rows and
    // raises nothing, so every handler below decides "no engagement, nothing to notify" and routes
    // NOTHING -- silently, forever. That is the same trap SMM-09, SMM-36 and SMM-10 each hit; here
    // it would have made the whole ticket a no-op that still reported green.
    await declareSocialModuleScope(c);
    const { rows } = await c.query<EngagementRow>(
      `SELECT e.owner_id, e.name, u.email AS owner_email
         FROM social_engagements e
         LEFT JOIN users u ON u.id = e.owner_id
        WHERE e.id = $1 AND e.deleted_at IS NULL`,
      [engagementId],
    );
    return rows[0] ?? null;
  });
}

/**
 * Handle `social.post.dispatched` event.
 * Notifies the engagement owner that their post has been dispatched (sent to the publisher queue).
 */
export async function handlePostDispatched(event: OutboxEvent): Promise<void> {
  const payload = event.payload as SocialPostEventPayload;
  const engagementId = payload.engagementId;
  if (!engagementId) return;

  const engagement = await loadEngagementOwner(event.tenantId, engagementId);
  if (!engagement || !engagement.owner_id) return;

  const network = typeof payload.network === "string" ? payload.network : "unknown";
  await notify(event.tenantId, engagement.owner_id, null, "social.post.dispatched", {
    title: `Post dispatched to ${network}`,
    severity: "info",
    entityType: "social_post_variant",
    entityId: event.entityId,
    href: `/departments/social-media/posts`,
  });
}

/**
 * Handle `social.post.published` event.
 * Notifies the engagement owner that their post has been published (confirmed live on the network).
 */
export async function handlePostPublished(event: OutboxEvent): Promise<void> {
  const payload = event.payload as SocialPostEventPayload;
  const engagementId = payload.engagementId;
  if (!engagementId) return;

  const engagement = await loadEngagementOwner(event.tenantId, engagementId);
  if (!engagement || !engagement.owner_id) return;

  const network = typeof payload.network === "string" ? payload.network : "unknown";
  await notify(event.tenantId, engagement.owner_id, null, "social.post.published", {
    title: `Post published to ${network}`,
    severity: "info",
    entityType: "social_post_variant",
    entityId: event.entityId,
    href: `/departments/social-media/posts`,
  });
}

/**
 * Handle `social.post.failed` event.
 * Notifies the engagement owner (in-app notification) and sends a risk-warning email.
 * Risk-shaped: a published post failure is a customer-visible problem requiring urgent attention.
 */
export async function handlePostFailed(event: OutboxEvent): Promise<void> {
  const payload = event.payload as SocialPostEventPayload;
  const engagementId = payload.engagementId;
  if (!engagementId) return;

  const engagement = await loadEngagementOwner(event.tenantId, engagementId);
  if (!engagement || !engagement.owner_id) return;

  const network = typeof payload.network === "string" ? payload.network : "unknown";
  const reason = typeof payload.reason === "string" ? payload.reason : "unknown";
  const ownerUserId = engagement.owner_id;
  const ownerEmail = engagement.owner_email;

  // In-app notification (to the bell)
  await notify(event.tenantId, ownerUserId, null, "social.post.failed", {
    title: `Post failed on ${network}`,
    severity: "critical",
    entityType: "social_post_variant",
    entityId: event.entityId,
    href: `/departments/social-media/posts`,
    reason,
    network,
  });

  // Mail notification (risk warning)
  const reasonText = reason
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  const mailPayload = {
    href: `/departments/social-media/posts`,
    network,
    engagementName: engagement.name,
    reason: reasonText,
    detail: typeof payload.detail === "string" ? payload.detail : null,
  };

  // enqueueMail does NOT resolve an address from userId -- it validates `toEmail` first and throws
  // on an implausible one. With no address on file we send no mail rather than throwing inside an
  // event handler; the bell notification above has already fired, so the failure is never silent.
  if (!ownerEmail) return;

  await enqueueMail({
    stream: "notify",
    templateKey: "social.post_failed",
    toEmail: ownerEmail,
    tenantId: event.tenantId,
    userId: ownerUserId,
    entityType: "social_post_variant",
    entityId: event.entityId,
    payload: mailPayload,
  });
}

interface ClientReviewRequestedPayload {
  reviewId?: string;
  clientId?: string;
  projectId?: string | null;
  postTitle?: string;
  [key: string]: unknown;
}

/**
 * Handle `social.client_review.requested` (SMM-31). Notifies the CLIENT — every active portal
 * contact in scope, signer or viewer alike (`kind: 'general'`, matching `resource_portal.yaml`'s
 * own comment on `approve_post`: this is not a signing act and must reach the same audience
 * `request_change` already does). `client_contacts` is a CORE table, so this read needs no module
 * scope; only `postTitle` came pre-resolved from the write path's own third-walled join
 * (`social.controller.ts#requestClientReview`) — re-deriving it here would be a second copy of that
 * join, exactly the drift risk `loadEngagementOwner`'s reuse below avoids for the decided event.
 */
export async function handleClientReviewRequested(event: OutboxEvent): Promise<void> {
  const payload = event.payload as ClientReviewRequestedPayload;
  if (!payload.reviewId || !payload.clientId) return;

  const recipients = await withTenants([event.tenantId], (c) =>
    resolveClientRecipients(c, { clientId: payload.clientId!, projectId: payload.projectId ?? null, kind: "general" }),
  );
  if (!recipients.length) return;

  await notifyBestEffort(event.tenantId, null, recipients, "social.client_review.requested", {
    title: `A post is ready for your review${payload.postTitle ? `: ${payload.postTitle}` : ""}`,
    href: "/portal/social-reviews",
    entityType: "social_post_client_review",
    entityId: payload.reviewId,
    severity: "info",
  });
}

interface ClientReviewDecidedPayload {
  reviewId?: string;
  decision?: string;
  engagementId?: string;
  [key: string]: unknown;
}

/**
 * Handle `social.client_review.decided` (SMM-31). Notifies STAFF — the engagement owner, reusing
 * `loadEngagementOwner` (this file's own SMM-13 helper, module-scope-declared) rather than a second
 * copy of that read. Bell only, no mail: unlike a publish `failed`, a client's decision (either
 * direction) is a routine workflow step, not a customer-visible incident.
 */
export async function handleClientReviewDecided(event: OutboxEvent): Promise<void> {
  const payload = event.payload as ClientReviewDecidedPayload;
  if (!payload.engagementId) return;

  const engagement = await loadEngagementOwner(event.tenantId, payload.engagementId);
  if (!engagement || !engagement.owner_id) return;

  const changesRequested = payload.decision === "changes_requested";
  await notify(event.tenantId, engagement.owner_id, null, "social.client_review.decided", {
    title: changesRequested
      ? `Client requested changes on a post${engagement.name ? ` for ${engagement.name}` : ""}`
      : `Client approved a post${engagement.name ? ` for ${engagement.name}` : ""}`,
    severity: changesRequested ? "warning" : "info",
    entityType: "social_post_client_review",
    entityId: payload.reviewId ?? event.entityId,
    href: `/departments/social-media/posts`,
  });
}

interface ClientReviewWithdrawnPayload {
  reviewId?: string;
  clientId?: string | null;
  projectId?: string | null;
  postTitle?: string;
  [key: string]: unknown;
}

/**
 * Handle `social.client_review.withdrawn`. Notifies the CLIENT that an ask has been RETRACTED.
 *
 * Why this exists at all: `.requested` puts "a post is ready for your review" in the client's bell,
 * pointed at `/portal/social-reviews`. Withdrawing was silent, so the client kept a live ask for a
 * review that no longer existed — and following it showed the item simply GONE. A vanished row is
 * indistinguishable from a broken portal, which is the exact conflation this module refuses
 * everywhere else ("absent is not zero"). Naming the retraction is the honest close of that loop.
 *
 * Same audience and the same `kind: 'general'` as `handleClientReviewRequested`: a retraction must
 * reach everyone the original ask reached and never a WIDER set — see the write path's comment in
 * `social.controller.ts#withdrawClientReview` for why the client fields arrive absent rather than
 * recovered from the review row when the variant is gone. Bell only, no mail: retracting is a
 * routine workflow step, not a customer-visible incident, matching `.decided` rather than a
 * publish `failed`.
 */
export async function handleClientReviewWithdrawn(event: OutboxEvent): Promise<void> {
  const payload = event.payload as ClientReviewWithdrawnPayload;
  if (!payload.reviewId || !payload.clientId) return;

  const recipients = await withTenants([event.tenantId], (c) =>
    resolveClientRecipients(c, { clientId: payload.clientId!, projectId: payload.projectId ?? null, kind: "general" }),
  );
  if (!recipients.length) return;

  await notifyBestEffort(event.tenantId, null, recipients, "social.client_review.withdrawn", {
    title: `A post is no longer awaiting your review${payload.postTitle ? `: ${payload.postTitle}` : ""}`,
    href: "/portal/social-reviews",
    entityType: "social_post_client_review",
    entityId: payload.reviewId,
    severity: "info",
  });
}

interface InboxSlaBreachedPayload {
  threadId?: string;
  network?: string;
  engagementId?: string;
  slaDueAt?: string;
  [key: string]: unknown;
}

/**
 * Handle `social.inbox.sla_breached` (SMM-16). A thread's OWN engagement-configured response
 * window (`tool_scope.inbox.slaMinutes` — never a number this module invents, see
 * `inbox-triage-job.ts`'s header) has passed with the thread still `open`. Risk-shaped: an
 * unanswered client-facing comment is a customer-visible problem, the same reasoning
 * `handlePostFailed` above uses for a publish failure.
 */
export async function handleInboxSlaBreached(event: OutboxEvent): Promise<void> {
  const payload = event.payload as InboxSlaBreachedPayload;
  if (!payload.threadId || !payload.engagementId) return;

  const engagement = await loadEngagementOwner(event.tenantId, payload.engagementId);
  if (!engagement || !engagement.owner_id) return;

  const network = typeof payload.network === "string" ? payload.network : "unknown";
  await notify(event.tenantId, engagement.owner_id, null, "social.inbox.sla_breached", {
    title: `An inbox thread on ${network} missed its response window${engagement.name ? ` (${engagement.name})` : ""}`,
    severity: "critical",
    entityType: "social_inbox_thread",
    entityId: payload.threadId,
    href: `/departments/social-media/inbox`,
    network,
  });

  if (!engagement.owner_email) return; // enqueueMail refuses an implausible address — see handlePostFailed's own note
  await enqueueMail({
    stream: "notify",
    templateKey: "social.inbox_sla_breached",
    toEmail: engagement.owner_email,
    tenantId: event.tenantId,
    userId: engagement.owner_id,
    entityType: "social_inbox_thread",
    entityId: payload.threadId,
    payload: {
      href: `/departments/social-media/inbox`,
      network,
      engagementName: engagement.name,
      slaDueAt: typeof payload.slaDueAt === "string" ? payload.slaDueAt : null,
    },
  });
}

interface InboxSpikeDetectedPayload {
  accountId?: string;
  network?: string;
  engagementId?: string;
  recentCount?: number;
  baselineAvgPerWindow?: number;
  [key: string]: unknown;
}

/**
 * Handle `social.inbox.spike_detected` (SMM-16). Bell only — see `inbox-triage-job.ts`'s own header
 * on why this has no measured baseline and is a self-imposed, generous default rather than a
 * confirmed incident signal; escalating it to a risk-warning email would overstate confidence this
 * ticket does not have the data to back.
 */
export async function handleInboxSpikeDetected(event: OutboxEvent): Promise<void> {
  const payload = event.payload as InboxSpikeDetectedPayload;
  if (!payload.accountId || !payload.engagementId) return;

  const engagement = await loadEngagementOwner(event.tenantId, payload.engagementId);
  if (!engagement || !engagement.owner_id) return;

  const network = typeof payload.network === "string" ? payload.network : "unknown";
  await notify(event.tenantId, engagement.owner_id, null, "social.inbox.spike_detected", {
    title: `Unusual comment volume on ${network}${engagement.name ? ` (${engagement.name})` : ""}`,
    severity: "warning",
    entityType: "social_account",
    entityId: payload.accountId,
    href: `/departments/social-media/inbox`,
    network,
    recentCount: payload.recentCount ?? null,
  });
}
