// PV4-09 — the staff side of the client conversation: client-safe types and pure helpers.
// No fetch and no server-only import, so the "use client" thread view, the server pages and plain vitest can
// all import it (same split as lib/webdevChangeRequests.ts).
//
// Backend contract: docs/FRONTEND-BFF-CONTRACT.md §29 / §29b. Rules this file encodes:
//   - bodies are PLAIN TEXT, 1..10,000 characters (design decision 7). `linkify` (lib/linkify.ts) is the only "rich" step and it
//     returns data, never markup: the renderer turns each part into a React text node or an <a>.
//   - at most 5 attachments and 10 MB in total per message (§29, lead decision).
//   - messages are PERMANENT (PV-D34): no edit, no retract, and so no `edited`, `retracted` or `editableUntil` field.
//     A correction is a new message.

export const MAX_BODY_CHARS = 10_000;
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** How often an open thread asks for news. There is no staff live channel (design decision 6). */
export const THREAD_POLL_MS = 20_000;

/** Plan §2.4 — said where staff write, because this is the sentence people get wrong in a reply. */
export const COMPOSER_HINT = "Prices and terms change only through a signed contract or amendment.";
/** PV-D34 — said beside the hint above, on every composer: a sent message cannot be changed. */
export const COMPOSER_PERMANENT_HINT = "Messages can't be edited or removed once sent. Post a correction instead.";

export type ThreadStatus = "open" | "closed";
export type MessageSide = "client" | "staff";

export interface StaffThread {
  id: string;
  clientId: string;
  clientName: string;
  projectId: string | null;
  projectName: string | null;
  general: boolean;
  subject: string | null;
  status: ThreadStatus;
  createdSide: MessageSide;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt?: string;
  createdBy?: string | null;
  unreadCount: number;
  /** The last message is the client's and the thread is open (§29b). */
  awaitingReply: boolean;
  pendingDrafts: number;
  /** From the backend (computed in SQL), never derived here. Optional: an older server omits it. */
  clientVisible?: boolean;
}

export interface MessageAttachment {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
}

export interface StaffMessage {
  id: string;
  threadId: string;
  authorId: string;
  authorName: string;
  authorSide: MessageSide;
  /** Always present: messages are permanent (PV-D34). */
  body: string;
  createdAt: string;
  mine: boolean;
  attachments: MessageAttachment[];
  /** The agent user whose draft this message was sent from (provenance, staff-only). */
  draftedBy: string | null;
  /** "Client sees this": the backend's `clientVisible`, rendered from the field only (trap 9). */
  clientVisible?: boolean;
}

export interface StaffDraft {
  id: string;
  threadId: string;
  body: string;
  draftedBy: string;
  draftedByName: string | null;
  status: "pending" | "sent" | "discarded";
  decidedBy: string | null;
  decidedAt: string | null;
  sentMessageId: string | null;
  createdAt: string;
  /** Always `false` from the backend. A draft is staff-only by table, and the card says so from this field. */
  clientVisible?: boolean;
}

export interface ThreadSnapshot {
  thread: StaffThread;
  messages: StaffMessage[];
  /** Every draft of the thread (pending, sent, discarded): the sent ones carry the agent's name for the
   *  "drafted by" line on the message they became. */
  drafts: StaffDraft[];
}

export interface AttachmentInput {
  filename: string;
  contentType: string;
  /** base64, no data: prefix */
  content: string;
}

export type ConvResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

// ── ordering ─────────────────────────────────────────────────────────────────────────────────────

const ts = (iso: string | null | undefined): number => {
  const n = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(n) ? 0 : n;
};

/** "Awaiting our reply" first, then by last activity, newest first. Stable partition: a thread that is
 *  waiting on us is the one thing this list exists to put on top. */
export function sortThreads<T extends Pick<StaffThread, "awaitingReply" | "lastMessageAt" | "createdAt">>(threads: T[]): T[] {
  const activity = (t: T) => ts(t.lastMessageAt ?? t.createdAt);
  return [...threads].sort((a, b) => {
    if (a.awaitingReply !== b.awaitingReply) return a.awaitingReply ? -1 : 1;
    return activity(b) - activity(a);
  });
}

export function threadTitle(t: Pick<StaffThread, "subject" | "general" | "projectName">): string {
  if (t.subject && t.subject.trim()) return t.subject.trim();
  if (t.general || !t.projectName) return "General conversation";
  return t.projectName;
}

/** What the thread is attached to, as a short label: the project's name, or "General". */
export function threadScope(t: Pick<StaffThread, "general" | "projectName">): string {
  return t.general || !t.projectName ? "General" : t.projectName;
}

// ── composer limits ──────────────────────────────────────────────────────────────────────────────

export function bodyError(body: string): string | null {
  if (!body.trim()) return "Write a message first.";
  if (body.length > MAX_BODY_CHARS) return `A message can be at most ${MAX_BODY_CHARS.toLocaleString("en-GB")} characters (this one is ${body.length.toLocaleString("en-GB")}).`;
  return null;
}

export function attachmentsError(files: { name: string; size: number }[]): string | null {
  if (files.length > MAX_ATTACHMENTS) return `Attach at most ${MAX_ATTACHMENTS} files to one message.`;
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > MAX_ATTACHMENT_BYTES) return "The attachments together can be at most 10 MB.";
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── drafts ───────────────────────────────────────────────────────────────────────────────────────

export function pendingDrafts(drafts: StaffDraft[]): StaffDraft[] {
  return drafts.filter((d) => d.status === "pending").sort((a, b) => ts(a.createdAt) - ts(b.createdAt));
}

/** message id -> the agent's name, for the staff-only "drafted by" line on a message sent from a draft. */
export function draftedByNames(drafts: StaffDraft[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of drafts) if (d.status === "sent" && d.sentMessageId && d.draftedByName) out.set(d.sentMessageId, d.draftedByName);
  return out;
}

/** Ids of messages in `next` that are not in `prev`, written by the other side. For the polite announcement. */
export function newClientMessages(prev: StaffMessage[], next: StaffMessage[]): StaffMessage[] {
  const known = new Set(prev.map((m) => m.id));
  return next.filter((m) => !known.has(m.id) && !m.mine && m.authorSide === "client");
}

// ── error wording ────────────────────────────────────────────────────────────────────────────────

/** Typed refusals from the conversation routes, in words. Anything else is the server's own sentence. */
export function conversationErrorText(status: number | null, message: string): string {
  if (status === 409) {
    if (/closed/i.test(message)) return "This conversation is closed. Reopen it to reply.";
    if (/15 min|window|retract|already|pending|decided/i.test(message)) return "That can't be changed any more: the edit window has passed, or someone else already acted on it. Reload the conversation to see where it stands.";
    return message || "That conflicts with the current state of the conversation. Reload and try again.";
  }
  if (status === 403) return "You don't have permission to do that here.";
  if (status === 404) return "That conversation or message no longer exists.";
  if (status === 413) return "That message is too large to send. Remove an attachment and try again.";
  return message || "That did not work. Try again.";
}
