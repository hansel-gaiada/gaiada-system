// Lean file-backed store (trial default; used when DATABASE_URL is unset).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config";
import type { Ciphertext } from "../crypto/envelope";
import { encodeSender, decodeSender } from "./encode";
import type { Store, StoredMessage, MediaStatus } from "./types";

interface PersistedMessage {
  chatId: string;
  senderEnc: Ciphertext | null;
  senderPseudonym: string;
  waMessageId: string;
  ts: number;
  text: string;
  fromBot: boolean;
  mediaMime?: string;
  mediaRef?: string;
  mediaStatus?: MediaStatus;
  mediaText?: string;
}

export class FileStore implements Store {
  private cache: PersistedMessage[] | null = null;
  private path: string;

  constructor(path: string = config.messagesFile) {
    this.path = path;
  }

  async init(): Promise<void> {
    // no-op
  }

  private load(): PersistedMessage[] {
    if (this.cache) return this.cache;
    this.cache = existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as PersistedMessage[]) : [];
    return this.cache;
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.cache ?? [], null, 2));
  }

  private purgeExpired(): void {
    const cutoff = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
    const rows = this.load();
    const kept = rows.filter((m) => m.ts >= cutoff);
    if (kept.length !== rows.length) {
      this.cache = kept;
      this.flush();
    }
  }

  async saveMessage(m: StoredMessage): Promise<void> {
    const { enc, pseudo } = await encodeSender(m);
    this.load().push({
      chatId: m.chatId,
      senderEnc: enc,
      senderPseudonym: pseudo,
      waMessageId: m.waMessageId,
      ts: m.ts,
      text: m.text,
      fromBot: m.fromBot,
      mediaMime: m.mediaMime,
      mediaRef: m.mediaRef,
      mediaStatus: m.mediaStatus,
      mediaText: m.mediaText,
    });
    this.purgeExpired();
    this.flush();
  }

  private async toStored(p: PersistedMessage): Promise<StoredMessage> {
    const s = await decodeSender(p.senderEnc);
    return {
      chatId: p.chatId,
      ...s,
      waMessageId: p.waMessageId,
      ts: p.ts,
      text: p.text,
      fromBot: p.fromBot,
      mediaMime: p.mediaMime,
      mediaRef: p.mediaRef,
      mediaStatus: p.mediaStatus,
      mediaText: p.mediaText,
    };
  }

  async getMessages(chatId: string, sinceTs = 0): Promise<StoredMessage[]> {
    return Promise.all(
      this.load()
        .filter((p) => p.chatId === chatId && p.ts >= sinceTs)
        .map((p) => this.toStored(p)),
    );
  }

  async getGroupChatIds(): Promise<string[]> {
    return [...new Set(this.load().filter((p) => p.chatId.endsWith("@g.us")).map((p) => p.chatId))];
  }

  async getPendingMedia(limit = 10): Promise<StoredMessage[]> {
    return Promise.all(
      this.load()
        .filter((p) => p.mediaStatus === "pending")
        .slice(0, limit)
        .map((p) => this.toStored(p)),
    );
  }

  async updateMedia(waMessageId: string, patch: { status: MediaStatus; text?: string }): Promise<void> {
    const row = this.load().find((p) => p.waMessageId === waMessageId);
    if (!row) return;
    row.mediaStatus = patch.status;
    if (patch.text !== undefined) row.mediaText = patch.text;
    this.flush();
  }
}
