// Store selector: Postgres when DATABASE_URL is set, else the local file store.
import { config } from "../config";
import { FileStore } from "./file";
import { PgStore } from "./pg";
import type { Store, StoredMessage, MediaStatus, ChatSummary, IntakeRecord } from "./types";

export type { StoredMessage, MediaStatus, ChatSummary, IntakeRecord, IntakeStatus } from "./types";

function buildStore(): Store {
  return config.databaseUrl ? new PgStore(config.databaseUrl) : new FileStore();
}

let store: Store = buildStore();

/** Test seam (same convention as resetRegistryCache/resetSessionState): rebuild the store from
 *  the CURRENT config so a suite can point it at temp paths. Production never calls this — the
 *  FileStore caches rows in memory, so without it a test's fresh temp dir is shadowed by the
 *  previous test's cache. */
export function resetStoreForTest(): void {
  store = buildStore();
}

export const initStore = (): Promise<void> => store.init();
export const saveMessage = (m: StoredMessage): Promise<void> => store.saveMessage(m);
export const getMessages = (chatId: string, sinceTs?: number): Promise<StoredMessage[]> =>
  store.getMessages(chatId, sinceTs);
export const getGroupChatIds = (): Promise<string[]> => store.getGroupChatIds();
export const getPendingMedia = (limit?: number): Promise<StoredMessage[]> => store.getPendingMedia(limit);
export const updateMedia = (waMessageId: string, patch: { status: MediaStatus; text?: string }): Promise<void> =>
  store.updateMedia(waMessageId, patch);
export const listChats = (limit?: number): Promise<ChatSummary[]> => store.listChats(limit);
export const searchMessages = (query: string, limit = 20): Promise<StoredMessage[]> =>
  store.searchMessages(query, limit);
export const getMessagesPage = (chatId: string, opts: { limit: number; beforeTs?: number }): Promise<StoredMessage[]> =>
  store.getMessagesPage(chatId, opts);

// ---- Durable inbound intake (persist-then-ACK) + scheduled retention ----
export const saveInboundEvent = (rec: {
  surface: string;
  kind: string;
  subjectId: string;
  entityId: string;
  payload: unknown;
}): Promise<string> => store.saveInboundEvent(rec);
export const getPendingInboundEvents = (minAgeMs?: number): Promise<IntakeRecord[]> =>
  store.getPendingInboundEvents(minAgeMs);
export const markInboundEventDone = (id: string): Promise<void> => store.markInboundEventDone(id);
export const markInboundEventFailed = (id: string, error: string): Promise<void> =>
  store.markInboundEventFailed(id, error);
/** Full retention sweep (messages + intake log). Scheduled in schedule.ts — no longer only a
 *  side effect of the next saveMessage, which left quiet chats retaining PII forever. */
export const purgeExpired = (): Promise<number> => store.purgeExpired();
