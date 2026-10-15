// DW-8j UI: email through the person's OWN Gmail (docs/FRONTEND-BFF-CONTRACT.md §48). Pure and client-safe: the answer shapes as the
// backend sends them (§48.7), the normalisers that refuse a malformed answer, the route builders, compose validation and every sentence a
// person reads. The readers are in `gmail-data.ts`, the writes in `gmailActions.ts`.
//
// THE RULE THIS FILE KEEPS (DW-D24): nothing from the mailbox is kept. No function here stores, caches or logs a message, and the
// pages render what a request returns and nothing more. A failed read is a sentence, never an empty mailbox.

export const SIMULATED_LABEL = "Simulated mailbox: nothing is really sent";
export type GmailMode = "simulated" | "live";
export const MAIL_LABELS = ["INBOX", "SENT"] as const;
export type MailLabel = (typeof MAIL_LABELS)[number];

export interface GmailStatus {
  configured: boolean;
  connected: boolean;
  needsReconnect: boolean;
  accountEmail: string | null;
  mode: GmailMode;
}
export interface ThreadRow {
  id: string;
  snippet: string;
  subject: string;
  from: string;
  lastMessageDate: string;
  unread: boolean;
}
export interface ThreadList {
  mode: GmailMode;
  threads: ThreadRow[];
  nextPageToken: string | null;
}
export interface MailAttachment { filename: string; mimeType: string; sizeBytes: number }
export interface MailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  from: string;
  to: string;
  cc: string | null;
  subject: string;
  date: string;
  text: string | null;
  html: string | null;
  attachments: MailAttachment[];
}
export interface MailThread { mode: GmailMode; id: string; messages: MailMessage[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const s = (v: unknown): string => (typeof v === "string" ? v : "");
const sOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const modeOf = (v: unknown): GmailMode => (v === "live" ? "live" : "simulated");

export function normalizeStatus(raw: unknown): GmailStatus | null {
  if (!isObj(raw) || typeof raw.configured !== "boolean" || typeof raw.connected !== "boolean") return null;
  return {
    configured: raw.configured,
    connected: raw.configured && raw.connected,
    needsReconnect: raw.configured && raw.needsReconnect === true,
    accountEmail: sOrNull(raw.accountEmail),
    mode: modeOf(raw.mode),
  };
}

export function normalizeThreadList(raw: unknown): ThreadList | null {
  if (!isObj(raw) || !Array.isArray(raw.threads)) return null;
  const threads: ThreadRow[] = [];
  for (const t of raw.threads) {
    if (!isObj(t) || typeof t.id !== "string") return null;
    threads.push({
      id: t.id, snippet: s(t.snippet), subject: s(t.subject), from: s(t.from),
      lastMessageDate: s(t.lastMessageDate), unread: t.unread === true,
    });
  }
  return { mode: modeOf(raw.mode), threads, nextPageToken: sOrNull(raw.nextPageToken) };
}

export function normalizeThread(raw: unknown): MailThread | null {
  if (!isObj(raw) || typeof raw.id !== "string" || !Array.isArray(raw.messages)) return null;
  const messages: MailMessage[] = [];
  for (const m of raw.messages) {
    if (!isObj(m) || typeof m.id !== "string") return null;
    messages.push({
      id: m.id,
      threadId: s(m.threadId) || raw.id,
      labelIds: Array.isArray(m.labelIds) ? m.labelIds.filter((x): x is string => typeof x === "string") : [],
      from: s(m.from), to: s(m.to), cc: sOrNull(m.cc), subject: s(m.subject), date: s(m.date),
      text: typeof m.text === "string" ? m.text : null,
      html: typeof m.html === "string" && m.html.length > 0 ? m.html : null,
      attachments: Array.isArray(m.attachments)
        ? m.attachments.filter(isObj).map((a) => ({ filename: s(a.filename) || "(unnamed)", mimeType: s(a.mimeType), sizeBytes: typeof a.sizeBytes === "number" ? a.sizeBytes : 0 }))
        : [],
    });
  }
  return { mode: modeOf(raw.mode), id: raw.id, messages };
}

// ── The routes (the tenant is the caller's active company) ────────────────────────────────────────
const base = (t: string) => `/api/${encodeURIComponent(t)}/integrations/gmail`;
export const statusPath = (t: string): string => base(t);
export const startPath = (t: string): string => `${base(t)}/oauth/start`;
export const disconnectPath = (t: string): string => base(t);
export const threadsPath = (t: string, label: MailLabel, pageToken?: string | null): string => {
  const q = new URLSearchParams({ label });
  if (pageToken) q.set("pageToken", pageToken);
  return `/api/${encodeURIComponent(t)}/mail/me/threads?${q.toString()}`;
};
export const threadPath = (t: string, threadId: string): string => `/api/${encodeURIComponent(t)}/mail/me/threads/${encodeURIComponent(threadId)}`;
export const sendPath = (t: string): string => `/api/${encodeURIComponent(t)}/mail/me/send`;

export const isMailLabel = (v: unknown): v is MailLabel => (MAIL_LABELS as readonly unknown[]).includes(v);

// ── Sentences ─────────────────────────────────────────────────────────────────────────────────────
export const NO_MAILBOX_FOR_ROLE = "Your role has no mailbox here.";
export const NOT_CONNECTED_TEXT = "Connect your Gmail to read and send mail from here.";
export const NEEDS_RECONNECT_TEXT = "Google no longer accepts the saved Gmail connection. Reconnect your Gmail to continue.";
export const UNAVAILABLE_TEXT = "Gmail can't be reached right now.";
export const NOT_CONFIGURED_TEXT = "Gmail isn't set up for this ERP yet.";

const FIELD_NAME: Record<string, string> = { to: "To", cc: "Cc", subject: "Subject", body: "Message", inReplyTo: "Reply", context: "Client", label: "Folder", pageToken: "Page", threadId: "Thread" };

export function waitText(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "a little while";
  if (seconds < 90) return `${Math.ceil(seconds)} seconds`;
  const m = Math.ceil(seconds / 60);
  return m === 1 ? "1 minute" : `${m} minutes`;
}

const TOKENS = ["gmail_not_connected", "gmail_needs_reconnect", "gmail_unavailable", "gmail_send_rate_limited", "gmail_rate_limited", "gmail_send_invalid", "gmail_request_invalid", "gmail_not_configured", "gmail_not_found"] as const;
type Token = (typeof TOKENS)[number];

/** The token a refusal carries: `reason` when known, else the one at the START of `error`. */
export function gmailErrorToken(error?: string | null, reason?: string | null): Token | null {
  if (reason && (TOKENS as readonly string[]).includes(reason)) return reason as Token;
  const lead = /^[a-z_]+/.exec((error ?? "").trim());
  return lead && (TOKENS as readonly string[]).includes(lead[0]) ? (lead[0] as Token) : null;
}

export interface GmailFailure { status?: number; error?: string | null; reason?: string | null; field?: string | null; retryAfterSeconds?: number | null }

/** A refusal or failure in plain words. */
export function gmailErrorText(e: GmailFailure): string {
  if (e.status === 401) return "Your session expired. Sign in again.";
  if (e.status === 403) return NO_MAILBOX_FOR_ROLE;
  switch (gmailErrorToken(e.error, e.reason)) {
    case "gmail_not_connected": return NOT_CONNECTED_TEXT;
    case "gmail_needs_reconnect": return NEEDS_RECONNECT_TEXT;
    case "gmail_unavailable": return UNAVAILABLE_TEXT;
    case "gmail_not_configured": return NOT_CONFIGURED_TEXT;
    case "gmail_send_rate_limited": return `You have sent a lot of mail in the last hour. Try again in ${waitText(e.retryAfterSeconds)}.`;
    case "gmail_rate_limited": return `Gmail asked us to slow down. Try again in ${waitText(e.retryAfterSeconds)}.`;
    case "gmail_send_invalid": {
      const f = e.field ? FIELD_NAME[e.field] ?? e.field : null;
      return f ? `That message can't be sent: check ${f}.` : "That message can't be sent: check the recipients, subject and message.";
    }
    case "gmail_request_invalid": return "That request wasn't understood. Reload the page.";
    case "gmail_not_found": return "That conversation couldn't be found. It may have been removed.";
    default: break;
  }
  if (e.status === 502 || e.status === 503) return UNAVAILABLE_TEXT;
  return "That didn't work, and the reason wasn't one we recognise. Try again in a moment.";
}

// ── Compose ───────────────────────────────────────────────────────────────────────────────────────
export const MAX_RECIPIENTS = 20;
export const SUBJECT_MAX = 300;
export const BODY_MAX = 50_000;
const ADDRESS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export const isEmailAddress = (v: string): boolean => v.length > 0 && v.length <= 254 && v.lastIndexOf("@") <= 64 && ADDRESS.test(v);

/** "a@b.c, d@e.f" or one per line gives trimmed, non-empty addresses. */
export function splitAddresses(raw: string): string[] {
  return raw.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
}

export interface ComposeInput { to: string; cc: string; subject: string; body: string }
export type ComposeErrors = Partial<Record<keyof ComposeInput, string>>;

/** Mirrors the backend's one validator (§48.4); the platform stays the authority. */
export function validateCompose(i: ComposeInput): ComposeErrors {
  const err: ComposeErrors = {};
  const to = splitAddresses(i.to);
  const cc = splitAddresses(i.cc);
  if (to.length === 0) err.to = "Add at least one recipient.";
  else if (!to.every(isEmailAddress)) err.to = "One of the To addresses is not a valid email address.";
  if (cc.length > 0 && !cc.every(isEmailAddress)) err.cc = "One of the Cc addresses is not a valid email address.";
  if (!err.to && !err.cc && to.length + cc.length > MAX_RECIPIENTS) err.to = `A message can have at most ${MAX_RECIPIENTS} recipients.`;
  const subject = i.subject.trim();
  if (subject.length === 0) err.subject = "Add a subject.";
  else if (subject.length > SUBJECT_MAX) err.subject = `The subject can be at most ${SUBJECT_MAX} characters.`;
  else if (/[\r\n]/.test(i.subject)) err.subject = "The subject must be one line.";
  if (i.body.trim().length === 0) err.body = "Write a message.";
  else if (i.body.length > BODY_MAX) err.body = `The message can be at most ${BODY_MAX.toLocaleString("en-US")} characters.`;
  return err;
}

/** The subject of a reply: "Re: " once, never "Re: Re: ". */
export const replySubject = (subject: string): string => (/^re:\s/i.test(subject) ? subject : `Re: ${subject || "(no subject)"}`);

/** The bare address out of a "Name <a@b.c>" header, or the header itself when it is already bare. */
export function bareAddress(header: string): string {
  const m = /<([^<>]+)>/.exec(header);
  return (m ? m[1] : header).trim();
}

/** What a reply starts from: answer the latest message. Replying to someone else's message writes to them; replying to our own writes to
 *  whoever we wrote to. The thread and message ids are the latest message's, so the reply threads. */
export function replyDraft(thread: MailThread, myEmail: string | null): { to: string; subject: string; inReplyTo: { threadId: string; messageId: string } } | null {
  const last = thread.messages[thread.messages.length - 1];
  if (!last) return null;
  const mine = !!myEmail && bareAddress(last.from).toLowerCase() === myEmail.toLowerCase();
  const to = mine ? bareAddress(last.to.split(",")[0] ?? "") : bareAddress(last.from);
  return { to, subject: replySubject(last.subject), inReplyTo: { threadId: thread.id, messageId: last.id } };
}

export const composeHref = (p: { to?: string | null; client?: string | null }): string => {
  const q = new URLSearchParams();
  if (p.to) q.set("to", p.to);
  if (p.client) q.set("client", p.client);
  const qs = q.toString();
  return qs ? `/me/mail/new?${qs}` : "/me/mail/new";
};

/** The client's primary contact address from `client.contact`, or null. */
export function clientContactEmail(contact: Record<string, unknown> | null | undefined): string | null {
  const v = contact?.email;
  return typeof v === "string" && isEmailAddress(v.trim()) ? v.trim() : null;
}
