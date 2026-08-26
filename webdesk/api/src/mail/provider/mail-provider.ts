// WSK-11 — provider adapter interface (vendor-neutral seam, per the ticket brief: "no vendor
// lock"). Shaped close to Zone A's own `src/mail/provider.ts` contract
// (docs/superpowers/specs/2026-08-04-zone-a-mail-design.md §4.1) so the pattern is familiar to
// anyone who has read that doctrine, but NOT importing anything from platform-nest and NOT
// carrying its `stream` field — Zone B holds zero Zone A code or credentials (design §01/§03 hard
// rule) and owns exactly one identity (identity.ts), so there is nothing here to select between.
export type MailAddress = { email: string; name?: string };

export type OutboundMail = {
  to: MailAddress;
  // ALWAYS identity.ts's resolveFromIdentity() output — see mail-sender.processor.ts, which is
  // the only place that constructs an OutboundMail. Never caller-supplied.
  from: { address: string; name: string };
  // The human, per D14 — never a Zone A address (mail.service.ts calls assertNotZoneADomain on
  // this before it ever reaches a queue job).
  replyTo?: MailAddress;
  subject: string;
  html: string;
  text: string; // always both parts
  headers?: Record<string, string>;
};

export type SendResult = { ok: true; providerMessageId?: string };

export interface MailProviderAdapter {
  readonly name: string;
  /** Throws on failure — the queue processor catches and lets BullMQ's attempts/backoff handle
   * the retry; this method itself never retries internally. */
  send(mail: OutboundMail): Promise<SendResult>;
}
