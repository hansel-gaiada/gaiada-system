// MAIL-13 — the provider-agnostic inbound message shape. Everything downstream of
// `brevo-payload.ts` works on `NormalizedInbound` and knows nothing about Brevo, which is what makes
// the §7.6 IMAP-poll fallback ("a single provider-hosted mailbox polled over IMAP") a new normalizer
// rather than a second pipeline.
export interface NormalizedAttachment {
  /** As the sender named it — sanitized to a single line before it is ever stored or served. */
  name: string;
  contentType: string;
  /** Bytes, when the provider inlined them (our fixture corpus does; see `content`). */
  content: Buffer | null;
  /** Provider-declared length. Trusted ONLY for the "reject before we bother fetching" decision;
   *  the authoritative size is `content.byteLength` once bytes exist. */
  declaredBytes: number;
  /** Brevo hands out a `DownloadToken` instead of bytes (its inbound payload is metadata-only for
   *  attachments). Carried so the staging leg (§15 R3) can fetch them with an API key; dev never
   *  dereferences it. */
  downloadToken: string | null;
}

export interface NormalizedInbound {
  /** 'brevo-inbound' | 'imap-poll' — written to `mail_messages.provider`. */
  provider: string;
  /** Idempotency key half. `(provider, provider_message_id)` is UNIQUE in the DDL. */
  providerMessageId: string;
  /** DISPLAY METADATA ONLY. Never used for matching or authorization (design §7.6, binding). */
  fromEmail: string;
  /** Every recipient address the provider reported (RCPT TO first, then To/Cc). The VERP token is
   *  extracted from these — this is the ONLY match key. */
  recipientAddresses: string[];
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  attachments: NormalizedAttachment[];
  /** Raw header map as the provider reported it, used ONLY for best-effort NDR classification
   *  (`Content-Type: multipart/report`, `Auto-Submitted`, ...). Never stored. */
  headers: Record<string, string | string[]>;
  /** Total declared size of the delivery, for the `MAIL_INBOUND_MAX_BYTES` intake cap. */
  sizeBytes: number;
}

/** What one inbound POST resolved to. Mirrors the §11 metric label
 *  `mail_inbound_total{provider,outcome}`. */
export type InboundOutcome =
  | "threaded" // matched a live reply_token, a mail_messages row exists
  | "duplicate" // replayed (provider, provider_message_id) — no second row
  | "ndr" // classified as a bounce; mail_log.status='bounced' (+ suppression)
  | "unmatched" // no/unknown token: counted + logged + 204 (A9)
  | "rejected"; // auth/size/rate — never reaches the database

export type InboundRejectReason = "auth" | "size" | "dupe" | "rate" | "malformed";
