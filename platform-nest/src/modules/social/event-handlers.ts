// SMM-13 — notification and mail routing for social post events.
//
// Routing:
// - `social.post.dispatched` → notifications only (routine success)
// - `social.post.published` → notifications only (routine success)
// - `social.post.failed` → notifications + mail (risk warning)
//
// Event payload contains: network, engagementId, providerPostId, reason (for failed)
// We query the engagement to find the owner and notify them of the outcome.
import { withTenants } from "../../db";
import { declareSocialModuleScope } from "./publish-precondition";
import { notify } from "../../core/http";
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
      `SELECT owner_id, name FROM social_engagements WHERE id = $1 AND deleted_at IS NULL`,
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

  await enqueueMail({
    stream: "notify",
    templateKey: "social.post_failed",
    toEmail: "", // will be resolved from userId
    tenantId: event.tenantId,
    userId: ownerUserId,
    entityType: "social_post_variant",
    entityId: event.entityId,
    payload: mailPayload,
  });
}
