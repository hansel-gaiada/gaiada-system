// Read-only chat viewer + logs for the ERP's WA/TG Bot page (design doc addendum: the
// admin/chats + session/events surfaces). Same fail-closed ADMIN_TOKEN gate as every other
// /admin/* route (enforced in server.ts, not here). Pure read paths — no mutation, no PII
// beyond what the store already decrypts+scrubs at ingest (StoredMessage is the same shape
// used everywhere else: digests, /admin/actions/audit, etc).
import { listChats as storeListChats, getMessages } from "./store";
import type { StoredMessage } from "./store";
import { groupName } from "./groups";

// Mirrors server.ts's CHAT_ID_RE (kept local to avoid a server.ts <-> chat-admin.ts import
// cycle): WhatsApp group/DM ids or a "tg:<numeric>" Telegram chat id.
const CHAT_ID_RE = /^([0-9]+@(g\.us|c\.us)|tg:-?[0-9]+)$/;

const PREVIEW_MAX_LEN = 80;

export type Surface = "whatsapp" | "telegram";
export type ChatKind = "group" | "dm";

export interface ChatListEntry {
  chatId: string;
  kind: ChatKind;
  surface: Surface;
  name: string;
  messageCount: number;
  lastActivityTs: number;
  lastPreview: string;
}

export function isValidChatId(chatId: string): boolean {
  return CHAT_ID_RE.test(chatId);
}

export function surfaceOf(chatId: string): Surface {
  return chatId.startsWith("tg:") ? "telegram" : "whatsapp";
}

export function kindOf(chatId: string): ChatKind {
  return chatId.endsWith("@g.us") ? "group" : "dm";
}

function truncate(text: string, max = PREVIEW_MAX_LEN): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** GET /admin/chats — one entry per distinct stored chat, sorted by lastActivityTs desc. */
export async function listChats(limit = 100): Promise<{ chats: ChatListEntry[] }> {
  const summaries = await storeListChats(limit);
  const chats: ChatListEntry[] = summaries.map((s) => {
    const kind = kindOf(s.chatId);
    return {
      chatId: s.chatId,
      kind,
      surface: surfaceOf(s.chatId),
      name: kind === "group" ? groupName(s.chatId) : s.lastSenderName || s.chatId,
      messageCount: s.messageCount,
      lastActivityTs: s.lastActivityTs,
      lastPreview: truncate(s.lastPreview),
    };
  });
  return { chats };
}

export interface ChatMessageEntry {
  ts: number;
  senderId: string;
  senderName: string;
  text: string;
  fromBot: boolean;
  mediaMime?: string;
  mediaStatus?: StoredMessage["mediaStatus"];
  mediaText?: string;
}

export type ChatMessagesResult =
  | { ok: true; chatId: string; messages: ChatMessageEntry[] }
  | { ok: false; status: 400 | 404; error: string };

/** GET /admin/chats/:chatId/messages — last `limit` messages, oldest -> newest (thread
 *  order), so the ERP can render it top-to-bottom like a normal chat transcript. */
export async function chatMessages(chatId: string, limit = 100): Promise<ChatMessagesResult> {
  if (!isValidChatId(chatId)) {
    return { ok: false, status: 400, error: "invalid chatId" };
  }
  const all = await getMessages(chatId);
  if (all.length === 0) {
    return { ok: false, status: 404, error: "unknown chat (no stored messages)" };
  }
  // getMessages already returns oldest -> newest (ts ASC); keep only the last `limit`.
  const tail = all.slice(-limit);
  const messages: ChatMessageEntry[] = tail.map((m) => ({
    ts: m.ts,
    senderId: m.senderId,
    senderName: m.senderName,
    text: m.text,
    fromBot: m.fromBot,
    mediaMime: m.mediaMime,
    mediaStatus: m.mediaStatus,
    mediaText: m.mediaText,
  }));
  return { ok: true, chatId, messages };
}
