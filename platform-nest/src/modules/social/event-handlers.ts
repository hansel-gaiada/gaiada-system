// SMM-13 — notification and mail routing for social post events.
// SMM-31 extends the same routing table with the client-review stage's two events.
//
// Routing:
// - `social.post.dispatched` → notifications only (routine success)
// - `social.post.published` → notifications only (routine success)
// - `social.post.failed` → notifications + mail (risk warning)
// - `social.client_review.requested` → notifies the CLIENT (portal contacts) that a post awaits them
// - `social.client_review.decided` → notifies STAFF (the engagement owner) of the client's decision
//
// Event payload contains: network, engagementId, providerPostId, reason (for failed)
// We query the engagement to find the owner and notify them of the outcome.
//
// Both new handlers ride the ALREADY-DRAINED "social_post_variant" entity-type stream
// (main.ts#startConsumerLoop) — deliberately, rather than a new stream name, because that list is
// the ONE thing deciding whether a Redis stream is ever read at all (this file's own SMM-14 fix,
// documented at the call site in main.ts): a new stream name here with no corresponding addition
// there would be exactly the "registered but never invoked" defect this module has already shipped
// once. Both events are emitted with `entityId = variantId`, matching the other three.
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
