// Read-only chat viewer + logs for the ERP's WA/TG Bot page (design doc addendum: the
// admin/chats + session/events surfaces). Same fail-closed ADMIN_TOKEN gate as every other
// /admin/* route (enforced in server.ts, not here). Pure read paths — no mutation, no PII
// beyond what the store already decrypts+scrubs at ingest (StoredMessage is the same shape
// used everywhere else: digests, /admin/actions/audit, etc).
import { listChats as storeListChats, getMessagesPage, searchMessages as storeSearchMessages } from "./store";
import type { StoredMessage } from "./store";
import { groupName } from "./groups";

// The ONE definition of a valid chat id (server.ts imports isValidChatId from here — it used to
// keep a second copy of this regex, and the two drifted). Accepts:
//   <digits>@g.us  group        <digits>@c.us  DM (WEBJS / classic addressing)
//   <digits>@lid   DM addressed by WhatsApp's newer LINKED IDENTITY, which is what the NOWEB
//                  (Baileys) engine reports for most 1:1 chats. Omitting it meant every such DM
//                  listed fine but 400'd the moment an operator clicked it in the ERP.
//   <digits>-<digits>@g.us
//                  LEGACY group id (<creator>-<created-at>), still used by older groups.
//   tg:<numeric>   Telegram
//
// Shapes verified against the live store (31 chats): 18 `N@g.us`, 12 `N@lid`, 1 `N-N@g.us`. Both
// omissions had the same signature — the chat listed fine and 400'd on click — because listChats
// does not validate, only the per-chat routes do.
const CHAT_ID_RE = /^([0-9]+(-[0-9]+)?@(g\.us|c\.us|lid)|tg:-?[0-9]+)$/;

const PREVIEW_MAX_LEN = 80;

/** How many chats to scan from the store when a q/kind filter is in play (see listChats). */
const MAX_FILTER_SCAN = 1000;

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

/** GET /admin/chats — one entry per distinct stored chat, sorted by lastActivityTs desc.
 *  1e: `q` filters the (already `limit`-capped) list by name or id, case-insensitive; `kind`
 *  filters to group|dm. Both are applied client-side after the store's limit — same
 *  architecture as before, no new store method needed for the chat-list view. */
export async function listChats(
  limit = 100,
  opts: { q?: string; kind?: ChatKind } = {},
): Promise<{ chats: ChatListEntry[] }> {
  // Filters MUST be applied before the limit. Asking the store for `limit` rows and then
  // filtering them means a filter only ever sees the newest N chats: `kind=dm&limit=8` returned
  // 1 of 12 DMs, and a search for a chat outside the newest N returned nothing at all — a
  // silent wrong answer, which is worse than an error. Over-scan when filtering, slice at the end.
  const filtering = Boolean(opts.kind || opts.q?.trim());
  const summaries = await storeListChats(filtering ? Math.max(limit, MAX_FILTER_SCAN) : limit);
  let chats: ChatListEntry[] = summaries.map((s) => {
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
  if (opts.kind) chats = chats.filter((c) => c.kind === opts.kind);
  const q = opts.q?.trim().toLowerCase();
  if (q) chats = chats.filter((c) => c.name.toLowerCase().includes(q) || c.chatId.toLowerCase().includes(q));
  return { chats: chats.slice(0, limit) };
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
  | { ok: true; chatId: string; messages: ChatMessageEntry[]; hasMore: boolean }
  | { ok: false; status: 400 | 404; error: string };

function toEntry(m: StoredMessage): ChatMessageEntry {
  return {
    ts: m.ts,
    senderId: m.senderId,
    senderName: m.senderName,
    text: m.text,
    fromBot: m.fromBot,
    mediaMime: m.mediaMime,
    mediaStatus: m.mediaStatus,
    mediaText: m.mediaText,
  };
}

/** GET /admin/chats/:chatId/messages — a page of messages, oldest -> newest (thread order),
 *  so the ERP can render it top-to-bottom like a normal chat transcript. 1e: `beforeTs` pages
 *  backwards (strictly older than that ts); `hasMore` tells the UI whether an older page
 *  still exists, so "load older" can hide at the start of a thread.
 *
 *  Fetches limit+1 rows to derive hasMore without a second query: getting back limit+1 means
 *  there's at least one more older message, so we drop the extra (the oldest of the batch)
 *  before returning exactly `limit`. A truly unknown chat (no stored messages at all, i.e.
 *  the FIRST page comes back empty) is a 404; an exhausted OLDER page (beforeTs given, empty
 *  result) is a normal empty page with hasMore:false — the chat is real, we've just reached
 *  its start. */
export async function chatMessages(chatId: string, limit = 100, beforeTs?: number): Promise<ChatMessagesResult> {
  if (!isValidChatId(chatId)) {
    return { ok: false, status: 400, error: "invalid chatId" };
  }
  const fetched = await getMessagesPage(chatId, { limit: limit + 1, beforeTs });
  if (fetched.length === 0) {
    if (beforeTs === undefined) {
      return { ok: false, status: 404, error: "unknown chat (no stored messages)" };
    }
    return { ok: true, chatId, messages: [], hasMore: false };
  }
  const hasMore = fetched.length > limit;
  const page = hasMore ? fetched.slice(1) : fetched; // ascending order -> the extra is at index 0
  return { ok: true, chatId, messages: page.map(toEntry), hasMore };
}

export interface SearchResultEntry {
  chatId: string;
  chatName: string;
  kind: ChatKind;
  surface: Surface;
  ts: number;
  senderName: string;
  text: string;
}

/** GET /admin/search — message search across every stored chat. Names resolve with the same
 *  groupName()/sender logic as listChats: the registry/discovery name for groups, the
 *  message's own senderName (falling back to the chatId) for DMs. */
export async function searchAllChats(query: string, limit = 20): Promise<{ results: SearchResultEntry[] }> {
  const hits = await storeSearchMessages(query, limit);
  const results: SearchResultEntry[] = hits.map((m) => {
    const kind = kindOf(m.chatId);
    return {
      chatId: m.chatId,
      chatName: kind === "group" ? groupName(m.chatId) : m.senderName || m.chatId,
      kind,
      surface: surfaceOf(m.chatId),
      ts: m.ts,
      senderName: m.senderName,
      text: m.text,
    };
  });
  return { results };
}
