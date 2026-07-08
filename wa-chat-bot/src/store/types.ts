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

export interface Store {
  init(): Promise<void>;
  saveMessage(m: StoredMessage): Promise<void>;
  getMessages(chatId: string, sinceTs?: number): Promise<StoredMessage[]>;
  getGroupChatIds(): Promise<string[]>;
  /** Media rows awaiting processing (the store IS the queue in trial-lite — no Redis). */
  getPendingMedia(limit?: number): Promise<StoredMessage[]>;
  updateMedia(waMessageId: string, patch: { status: MediaStatus; text?: string }): Promise<void>;
}
