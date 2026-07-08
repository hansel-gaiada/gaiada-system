// Store selector: Postgres when DATABASE_URL is set, else the local file store.
import { config } from "../config";
import { FileStore } from "./file";
import { PgStore } from "./pg";
import type { Store, StoredMessage, MediaStatus } from "./types";

export type { StoredMessage, MediaStatus } from "./types";

const store: Store = config.databaseUrl ? new PgStore(config.databaseUrl) : new FileStore();

export const initStore = (): Promise<void> => store.init();
export const saveMessage = (m: StoredMessage): Promise<void> => store.saveMessage(m);
export const getMessages = (chatId: string, sinceTs?: number): Promise<StoredMessage[]> =>
  store.getMessages(chatId, sinceTs);
export const getGroupChatIds = (): Promise<string[]> => store.getGroupChatIds();
export const getPendingMedia = (limit?: number): Promise<StoredMessage[]> => store.getPendingMedia(limit);
export const updateMedia = (waMessageId: string, patch: { status: MediaStatus; text?: string }): Promise<void> =>
  store.updateMedia(waMessageId, patch);
