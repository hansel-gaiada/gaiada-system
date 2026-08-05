// MAIL-16D — the `GmailClient` SEAM. Design §8C/A14 (binding): dev builds this interface + a
// fixture-backed implementation + a provider-agnostic contract-test suite (contract.ts). NOTHING
// ELSE. No OAuth link flow, no live Google adapter, no UI, no persistence — those are MAIL-16/17,
// staging-gated (design §15 R7). See README.md in this directory for the full honesty note.
//
// WHY THE SHAPE BELOW, NOT A THIN WRAPPER OVER GOOGLE'S OWN RESPONSE SHAPE: Google's
// `users.threads.get` / `users.messages.get` return a recursive `payload.parts` tree of
// base64url-encoded bodies, keyed by MIME structure that varies per message (single-part plain
// text, multipart/alternative, multipart/mixed with attachments, nested multipart/related for
// inline images — all UNVERIFIED here, design §8C/§15 R7). Modeling this seam directly on that
// shape would leak Google's wire format into every caller and into MAIL-17's reading pane, and
// would make "provider-agnostic" a lie the moment a second provider's tree shape differed. Instead
// this seam defines the DECODED, FLATTENED shape every caller actually needs — already-decoded text
// parts, attachment METADATA only (never content: M14, "cache nothing"). The live adapter (MAIL-16)
// does the base64url-decode + MIME-tree-walk and maps into this shape; the contract suite asserts
// the shape, not Google's wire format, so it is unmodified-runnable against that adapter.

/** One label, exactly as Gmail models it: system labels (INBOX, UNREAD, ...) and user-created ones
 *  share one namespace. `type` distinguishes them for rendering (MAIL-17, out of scope here). */
export interface GmailLabel {
  id: string;
  name: string;
  type: "system" | "user";
}

/** A thread as it appears in a list view — enough to render a thread list row without fetching
 *  every message body. Deliberately excludes decoded content (that is `getMessage`'s job). */
export interface GmailThreadSummary {
  id: string;
  snippet: string;
  labelIds: string[];
  /** Message ids belonging to this thread, oldest-first. Present so a caller can decide whether to
   *  fetch the last message only or the whole thread, without a second round-trip to discover ids. */
  messageIds: string[];
  /** ISO-8601. The most recent message's date, for list sorting — UNVERIFIED against Gmail's own
   *  internal-date semantics (design §15 R7: real thread/pagination semantics are unexercised by a
   *  fixture). */
  lastMessageDate: string;
}

/** One page of the thread list. `nextPageToken` is opaque — callers must treat it as a bag of bytes
 *  and never parse it; the fixture and live implementations use INCOMPATIBLE token encodings on
 *  purpose (see fixture-client.ts), which is exactly what a provider-agnostic contract must tolerate. */
export interface GmailThreadPage {
  threads: GmailThreadSummary[];
  nextPageToken?: string;
}

/** A thread's full message list, in send order. Each entry is a summary (same shape as a list-view
 *  row) — decoded bodies + attachment metadata come from `getMessage(id)` per message, matching the
 *  design's explicit two-call shape (`getThread` then `getMessage`). */
export interface GmailThread {
  id: string;
  labelIds: string[];
  messages: GmailThreadSummary[];
}

/** One decoded body part. `body` is ALREADY decoded (UTF-8 text) — no base64url, no raw MIME. A
 *  message with both a plain-text and an HTML alternative surfaces as two parts; callers pick. */
export interface GmailMessagePart {
  mimeType: string; // e.g. "text/plain", "text/html"
  body: string;
}

/** Attachment METADATA ONLY. Per M14 ("render on demand, cache nothing") this seam never fetches or
 *  stores attachment bytes — a caller wanting content would need a THIRD call this interface
 *  deliberately does not define yet, kept out of scope until the live wave needs it for real. */
export interface GmailAttachmentMeta {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  headers: {
    from: string;
    to: string;
    subject: string;
    /** ISO-8601. */
    date: string;
  };
  parts: GmailMessagePart[];
  attachments: GmailAttachmentMeta[];
}

/** The seam. Every method is READ-ONLY (M14: `gmail.readonly`, no send scope) and SELF-ONLY in
 *  spirit — a real adapter binds one instance to one caller's own connection; this interface itself
 *  carries no caller/tenant parameter because that binding is MAIL-16's concern (constructing the
 *  client from a resolved access token), not this seam's. */
export interface GmailClient {
  listThreads(pageToken?: string): Promise<GmailThreadPage>;
  getThread(threadId: string): Promise<GmailThread>;
  getMessage(messageId: string): Promise<GmailMessage>;
  listLabels(): Promise<GmailLabel[]>;
}
