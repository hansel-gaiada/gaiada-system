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
export type TenantWebhookEventKind = "form.received";

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
