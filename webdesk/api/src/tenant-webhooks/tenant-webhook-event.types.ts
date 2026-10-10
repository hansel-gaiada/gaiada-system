// WSK-37 — the OUTBOUND (Zone B -> tenant's own server) envelope. Deliberately shaped like
// ../events/zoneb-event.types.ts's ZoneBEventEnvelope (same eventId/kind/tenantId/originSite/
// occurredAt/data skeleton) for one reason: the receiving client verifies the signature with the
// SAME algorithm WSK-12's Zone A bridge does (zoneb-event-signature.ts, reused verbatim — see
// tenant-webhook-dispatcher.service.ts), so keeping the envelope shape recognizable makes that
// signature verifiable by a receiver copying the exact same reference doc WSK-12 already ships.
// This is a SEPARATE type (not an import of ZoneBEventKind/ZoneBEventEnvelope) because the two
// envelopes cross different boundaries with different audiences and must be free to diverge —
// events/** is out of this ticket's owned scope to edit, and coupling this file's shape to that
// module's exported type would make an unrelated ticket's edit there a breaking change here.
// WSK-41 (write-plane design §3.3): the three content kinds. tenant_webhooks.event_kinds and
// tenant_webhook_deliveries.kind carry no value CHECK (0006), so widening this union needs no DDL.
export type TenantWebhookEventKind = "form.received" | "content.published" | "content.unpublished" | "content.scheduled";

export type TenantWebhookContentEventKind = Exclude<TenantWebhookEventKind, "form.received">;

export type TenantWebhookEnvelope<TData extends Record<string, unknown> = Record<string, unknown>> = {
  eventId: string;
  kind: TenantWebhookEventKind;
  tenantId: string; // Zone B tenants.id — opaque to the client, their own registration key
  occurredAt: string; // ISO 8601
  data: TData;
};

/**
 * The `form.received` slim projection sent to a TENANT's own endpoint. Unlike WSK-12's B->A
 * `FormReceivedData` (correlators only, §04: "never the raw blob"), this projection DOES carry
 * the submitted field VALUES — that is the entire point of this ticket ("clients want their own
 * form submissions in their own CRM") — but strictly the sanitized, already-validated fields of
 * THIS tenant's OWN form submission, never a raw database row, never any column outside what the
 * tenant's own form schema defines, and never another tenant's data (dispatch is always scoped by
 * `tenant_id` — see tenant-webhook-dispatcher.service.ts's own header on cross-tenant isolation).
 */
export type TenantWebhookFormReceivedData = {
  siteSlug: string;
  formId: string;
  submissionId: string;
  hasAttachments: boolean;
  fields: Record<string, unknown>;
};

/**
 * WSK-41 — one item a content event is about. Deliberately NO content values (design §3.3: "item
 * refs ... and no values"): a receiver that wants the content reads it through /v1 with its own key,
 * which applies the environment's visibility rule. This is also what keeps a batch publish of 100
 * items far inside the 64 KiB payload cap.
 */
export type TenantWebhookContentItemRef = {
  itemId: string;
  collectionKey: string;
  locale: string;
  slug: string;
  version: number | null;
};

/** `content.published` / `content.unpublished` / `content.scheduled` data: at most 100 refs per event. */
export type TenantWebhookContentData = {
  siteId: string;
  items: TenantWebhookContentItemRef[];
  /** content.scheduled only: when the scheduled items go live / come down (ISO 8601 or null). */
  publishAt?: string | null;
  unpublishAt?: string | null;
};
