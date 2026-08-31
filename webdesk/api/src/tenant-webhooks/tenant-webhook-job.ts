// WSK-37 — the BullMQ job payload shape, same "typed job data" convention as ../mail/mail-job.ts.
// Deliberately carries NO secret material — the worker decrypts fresh from the DB row per job
// (webhook-secret.ts's own header: decrypted plaintext never leaves the call stack that needs
// it), so a Redis compromise alone cannot yield a signing secret either.
export type TenantWebhookJobData = {
  deliveryId: string;
  webhookId: string;
  tenantId: string;
  eventId: string;
  envelopeJson: string; // pre-serialized TenantWebhookEnvelope — signed over VERBATIM, never
  // re-serialized inside the worker (same "rawBody must be the exact bytes" rule
  // zoneb-event-signature.ts's own header explains for the B->A side).
};
