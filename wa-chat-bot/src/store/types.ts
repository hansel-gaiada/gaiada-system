export type MediaStatus = "pending" | "done" | "failed";

export interface StoredMessage {
  chatId: string;
  senderId: string;
  senderName: string;
  waMessageId: string;
  ts: number;
  text: string;
  fromBot: boolean;
  /** Media enrichment (Phase 2). Bytes are never stored — only a reference + derived text. */
  mediaMime?: string;
  mediaRef?: string; // WAHA-served download URL
  mediaStatus?: MediaStatus;
  mediaText?: string; // scrubbed transcript/description/extraction
}

/** One row of the chat-viewer aggregate (chat-admin.ts §GET /admin/chats). Decoding of the
 *  sender identity happens here (in the store), not the caller — `lastSenderName` is already
 *  the decrypted, already-scrubbed display name of the most recent non-bot sender ("" if the
 *  chat has no non-bot messages, e.g. bot-only or erased). `lastPreview` is the last message's
 *  raw (already-scrubbed) text, untruncated — the caller truncates for display. */
export interface ChatSummary {
  chatId: string;
  messageCount: number;
  lastActivityTs: number;
  lastPreview: string;
  lastSenderName: string;
}

/** Durable inbound-intake record (WA operability hardening, Agent A). One row per normalized
 *  webhook event, written BEFORE the webhook ACKs (persist-then-ACK) so a process death after
 *  the ACK can never lose the event — it stays "pending" and a reconciler replays it. `payload`
 *  is the already-decrypted, JSON-parseable normalized event (an `InboundEvent` from
 *  `gateway/events.ts`); the store layer owns encrypting it at rest (crypto-shred, same
 *  subject×entity envelope as message sender identity) — callers never see ciphertext. */
export type IntakeStatus = "pending" | "done" | "failed";

export interface IntakeRecord {
  id: string;
  surface: string; // "whatsapp" | "telegram"
  kind: string; // InboundEvent["kind"]
  payload: unknown; // the normalized InboundEvent, JSON-parseable
  status: IntakeStatus;
  error?: string;
  createdAt: number; // ms epoch
}

export interface Store {
  init(): Promise<void>;
  saveMessage(m: StoredMessage): Promise<void>;
  getMessages(chatId: string, sinceTs?: number): Promise<StoredMessage[]>;
  getGroupChatIds(): Promise<string[]>;
  /** Media rows awaiting processing (the store IS the queue in trial-lite — no Redis). */
  getPendingMedia(limit?: number): Promise<StoredMessage[]>;
  updateMedia(waMessageId: string, patch: { status: MediaStatus; text?: string }): Promise<void>;
  /** Distinct chats the bot has stored, sorted by lastActivityTs desc, capped to `limit`. */
  listChats(limit?: number): Promise<ChatSummary[]>;
  /** 1e: case-insensitive substring search over stored (already scrubbed) text, across all
   *  chats, newest-first, capped to `limit`. An empty/whitespace query returns []. */
  searchMessages(query: string, limit: number): Promise<StoredMessage[]>;
  /** 1e: the newest `opts.limit` messages strictly older than `opts.beforeTs` (or the newest
   *  `opts.limit` overall when beforeTs is omitted), returned oldest -> newest (thread order,
   *  same convention as getMessages). */
  getMessagesPage(chatId: string, opts: { limit: number; beforeTs?: number }): Promise<StoredMessage[]>;

  /** Durable intake (crash-safe webhook handling). `subjectId`/`entityId` are the crypto-shred
   *  axes (subject = the human the event is about; entity = the chat) used to encrypt `payload`
   *  at rest — same model as message sender identity. Returns the new row's id. */
  saveInboundEvent(rec: {
    surface: string;
    kind: string;
    subjectId: string;
    entityId: string;
    payload: unknown;
  }): Promise<string>;
  /** Rows still "pending". `minAgeMs` (default 0 = all) restricts to rows at least that old —
   *  the periodic reconciler uses this to avoid racing a row still legitimately in flight; the
   *  boot reconciler calls it with the default (a fresh process has nothing in flight yet). */
  getPendingInboundEvents(minAgeMs?: number): Promise<IntakeRecord[]>;
  markInboundEventDone(id: string): Promise<void>;
  markInboundEventFailed(id: string, error: string): Promise<void>;

  /** Delete everything older than `config.retentionDays` — ALL chats, regardless of recent
   *  activity (unlike the incidental purge that used to only run as a side effect of the next
   *  saveMessage in some chat). Covers both the `messages` table/file and the inbound-intake
   *  log (it holds the same class of scrubbed PII). Returns the total rows deleted across both,
   *  so a caller logging "purged N rows" is reporting the whole retention sweep, not a partial
   *  one. Safe to call on a schedule (idempotent — a no-op when nothing has expired). */
  purgeExpired(): Promise<number>;
}
