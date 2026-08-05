// MAIL-04 — the provider adapter seam (design §4.1, binding contract; webdesk C-03 copies it
// later). Swap = config; no caller ever sees a provider name. Kept as a standalone types module
// (no runtime code) so provider.ts, sender.ts, queue.ts and templates.ts can all import it without
// a cyclic dependency.
export type MailStream = "notify" | "auth"; // Zone B adds "forms" later — not built here.

export interface MailAddress {
  email: string;
  name?: string;
}

export interface OutboundMail {
  stream: MailStream; // picks identity + credentials
  to: MailAddress; // one recipient per row
  replyTo?: MailAddress; // threading: reply+<token>@<replyDomain>
  subject: string;
  html: string;
  text: string; // always both parts
  headers?: Record<string, string>;
}

export interface SendResult {
  ok: true;
  providerMessageId?: string;
} // adapters THROW on failure — there is no `ok: false` shape.

export interface MailProviderAdapter {
  readonly name: string; // 'smtp' | 'dev-log' | later 'brevo-api'…
  send(mail: OutboundMail): Promise<SendResult>;
  verify?(): Promise<void>; // boot-time config sanity (fail-soft, logged)
}

/** A row claimed off `mail_log` by the sender worker — just enough to render + send it. */
export interface ClaimedMail {
  id: string;
  stream: MailStream;
  to_email: string;
  template_key: string;
  payload: Record<string, unknown>;
  subject: string;
  entity_type: string | null;
  entity_id: string | null;
  reply_token: string | null;
  attempts: number;
}

/** Code templates render this from `(templateKey, payload)` (design A6: templates are code, not
 *  DB rows). `mail_log.payload` is the only thing persisted — never the rendered body twice. */
export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}
