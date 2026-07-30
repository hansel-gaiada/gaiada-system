// Lean file-backed store (trial default; used when DATABASE_URL is unset).
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config";
import type { Ciphertext } from "../crypto/envelope";
import { encodeSender, decodeSender, encodePayload, decodePayload } from "./encode";
import type { Store, StoredMessage, MediaStatus, ChatSummary, IntakeRecord, IntakeStatus } from "./types";

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

/** On-disk shape of a durable intake row (payload encrypted at rest, like senderEnc). */
interface PersistedIntake {
  id: string;
  surface: string;
  kind: string;
  payloadEnc: Ciphertext;
  status: IntakeStatus;
  error?: string;
  createdAt: number;
}

export class FileStore implements Store {
  private cache: PersistedMessage[] | null = null;
  private path: string;
  private intakeCache: PersistedIntake[] | null = null;
  private intakePath: string;

  constructor(path: string = config.messagesFile, intakePath: string = config.inboundEventsFile) {
    this.path = path;
    this.intakePath = intakePath;
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

  /** Retention sweep across BOTH the message file and the intake log, returning the total
   *  deleted. Public (and Promise-returning) because it is now called on a schedule rather than
   *  only as a side effect of the next saveMessage — a quiet chat used to keep its PII forever. */
  async purgeExpired(): Promise<number> {
    const cutoff = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
    const rows = this.load();
    const keptMsgs = rows.filter((m) => m.ts >= cutoff);
    const msgsDeleted = rows.length - keptMsgs.length;
    if (msgsDeleted > 0) {
      this.cache = keptMsgs;
      this.flush();
    }

    const events = this.loadIntake();
    const keptEvents = events.filter((e) => e.createdAt >= cutoff);
    const eventsDeleted = events.length - keptEvents.length;
    if (eventsDeleted > 0) {
      this.intakeCache = keptEvents;
      this.flushIntake();
    }
    return msgsDeleted + eventsDeleted;
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
    // Fire-and-forget: saveMessage must not wait on a retention sweep. The scheduled purge
    // (schedule.ts) is the real guarantee; this incidental call just keeps the file trim.
    void this.purgeExpired().catch(() => undefined);
    this.flush();
  }

  // ---- Durable inbound intake (mirrors PgStore.inbound_events) ----
  // Kept in its own file so the message store's shape is untouched. The payload is encrypted
  // with the SAME subject×entity envelope as sender identity, so a crypto-shred erasure makes
  // a queued-but-unprocessed event unreadable too — the intake log must not become a plaintext
  // side-channel around the store's own PII guarantees.

  private loadIntake(): PersistedIntake[] {
    if (this.intakeCache) return this.intakeCache;
    this.intakeCache = existsSync(this.intakePath)
      ? (JSON.parse(readFileSync(this.intakePath, "utf8")) as PersistedIntake[])
      : [];
    return this.intakeCache;
  }

  private flushIntake(): void {
    mkdirSync(dirname(this.intakePath), { recursive: true });
    // Atomic (tmp + rename): a crash mid-write must not corrupt the durability log that exists
    // precisely to survive crashes.
    const tmp = `${this.intakePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.intakeCache ?? [], null, 2));
    renameSync(tmp, this.intakePath);
  }

  async saveInboundEvent(rec: {
    surface: string;
    kind: string;
    subjectId: string;
    entityId: string;
    payload: unknown;
  }): Promise<string> {
    const enc = await encodePayload(rec.subjectId, rec.entityId, rec.payload);
    const id = randomUUID();
    this.loadIntake().push({
      id,
      surface: rec.surface,
      kind: rec.kind,
      payloadEnc: enc,
      status: "pending",
      createdAt: Date.now(),
    });
    this.flushIntake();
    return id;
  }

  async getPendingInboundEvents(minAgeMs = 0): Promise<IntakeRecord[]> {
    const cutoff = Date.now() - minAgeMs;
    const pending = this.loadIntake()
      .filter((e) => e.status === "pending" && e.createdAt <= cutoff)
      .sort((a, b) => a.createdAt - b.createdAt);
    return Promise.all(
      pending.map(async (e) => ({
        id: e.id,
        surface: e.surface,
        kind: e.kind,
        payload: await decodePayload(e.payloadEnc),
        status: e.status,
        ...(e.error ? { error: e.error } : {}),
        createdAt: e.createdAt,
      })),
    );
  }

  async markInboundEventDone(id: string): Promise<void> {
    const row = this.loadIntake().find((e) => e.id === id);
    if (!row) return; // already purged — nothing to mark, not an error
    row.status = "done";
    delete row.error;
    this.flushIntake();
  }

  async markInboundEventFailed(id: string, error: string): Promise<void> {
    const row = this.loadIntake().find((e) => e.id === id);
    if (!row) return;
    row.status = "failed";
    row.error = error.slice(0, 500);
    this.flushIntake();
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

  /** 1e: substring search over stored text, newest-first, across all chats. */
  async searchMessages(query: string, limit = 20): Promise<StoredMessage[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const rows = this.load()
      .filter((p) => p.text.toLowerCase().includes(q))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
    return Promise.all(rows.map((p) => this.toStored(p)));
  }

  /** 1e: backwards paging — the newest `limit` messages strictly older than `beforeTs`,
   *  returned oldest -> newest (thread order). */
  async getMessagesPage(chatId: string, opts: { limit: number; beforeTs?: number }): Promise<StoredMessage[]> {
    const page = this.load()
      .filter((p) => p.chatId === chatId && (opts.beforeTs === undefined || p.ts < opts.beforeTs))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, opts.limit)
      .sort((a, b) => a.ts - b.ts);
    return Promise.all(page.map((p) => this.toStored(p)));
  }

  async listChats(limit = 100): Promise<ChatSummary[]> {
    interface Agg {
      count: number;
      lastTs: number;
      lastText: string;
      lastSenderTs: number;
      lastSenderEnc: Ciphertext | null;
    }
    const byChat = new Map<string, Agg>();
    for (const p of this.load()) {
      let agg = byChat.get(p.chatId);
      if (!agg) {
        agg = { count: 0, lastTs: -Infinity, lastText: "", lastSenderTs: -Infinity, lastSenderEnc: null };
        byChat.set(p.chatId, agg);
      }
      agg.count++;
      if (p.ts >= agg.lastTs) {
        agg.lastTs = p.ts;
        agg.lastText = p.text;
      }
      if (!p.fromBot && p.ts >= agg.lastSenderTs) {
        agg.lastSenderTs = p.ts;
        agg.lastSenderEnc = p.senderEnc;
      }
    }
    const top = [...byChat.entries()].sort((a, b) => b[1].lastTs - a[1].lastTs).slice(0, limit);
    return Promise.all(
      top.map(async ([chatId, agg]) => {
        const sender = agg.lastSenderTs > -Infinity ? await decodeSender(agg.lastSenderEnc) : null;
        return {
          chatId,
          messageCount: agg.count,
          lastActivityTs: agg.lastTs,
          lastPreview: agg.lastText,
          lastSenderName: sender?.senderName ?? "",
        };
      }),
    );
  }
}
