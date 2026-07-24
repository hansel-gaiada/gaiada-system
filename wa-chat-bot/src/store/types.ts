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
}
