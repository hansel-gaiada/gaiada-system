// Inbound event union. Today the bot only understands text/media messages; actions need
// button presses (confirmations), reactions (e.g. ✅ to approve), and member join/leave.
// These normalizers turn a raw WAHA/Telegram payload into one typed event; message/media
// events still flow through the existing normalize()/normalizeTelegram() text path.
import { normalize } from "../waha";
import { normalizeTelegram, tgChatId } from "../telegram";
import type { InboundMessage } from "../waha";

export type InboundEvent =
  | { kind: "message"; message: InboundMessage }
  | { kind: "button"; chatId: string; senderId: string; token: string; messageId: string; ts: number }
  | { kind: "reaction"; chatId: string; senderId: string; emoji: string; messageId: string; ts: number }
  | { kind: "member"; chatId: string; userId: string; change: "joined" | "left"; ts: number };

/** WAHA → InboundEvent. Message/media events wrap the existing normalize(); other event
 *  types (reaction, group participant change) map to their own variants. */
export function normalizeWahaEvent(event: unknown): InboundEvent | null {
  const e = event as any;
  if (!e || typeof e.event !== "string") return null;

  if (e.event === "message") {
    const m = normalize(event);
    return m ? { kind: "message", message: m } : null;
  }

  if (e.event === "message.reaction" || e.event === "message.reaction.v2") {
    const p = e.payload ?? {};
    const r = p.reaction ?? p;
    const emoji = String(r.text ?? r.emoji ?? "");
    const chatId = String(p.from ?? p.chatId ?? "");
    if (!emoji || !chatId) return null;
    return {
      kind: "reaction",
      chatId,
      senderId: String(p.participant ?? p.author ?? p.from ?? ""),
      emoji,
      messageId: String(r.messageId ?? p.id ?? ""),
      ts: p.timestamp ? Number(p.timestamp) * 1000 : Date.now(),
    };
  }

  // WAHA button reply (interactive templates) arrives as a message with a selectedId.
  if (e.event === "button.reply") {
    const p = e.payload ?? {};
    const chatId = String(p.from ?? "");
    const token = String(p.selectedId ?? p.selectedButtonId ?? p.id ?? "");
    if (!chatId || !token) return null;
    return {
      kind: "button",
      chatId,
      senderId: String(p.participant ?? p.from ?? ""),
      token,
      messageId: String(p.messageId ?? ""),
      ts: p.timestamp ? Number(p.timestamp) * 1000 : Date.now(),
    };
  }

  if (e.event === "group.v2.participants" || e.event === "group.participants") {
    const p = e.payload ?? {};
    const action = String(p.action ?? "");
    const change: "joined" | "left" | null =
      action === "add" || action === "join" ? "joined" : action === "remove" || action === "leave" ? "left" : null;
    const userId = String((Array.isArray(p.participants) ? p.participants[0] : p.participant) ?? "");
    const chatId = String(p.id ?? p.chatId ?? "");
    if (!change || !userId || !chatId) return null;
    return { kind: "member", chatId, userId, change, ts: Date.now() };
  }

  return null;
}

/** Telegram update → InboundEvent. Handles message, callback_query (button), message_reaction,
 *  and member join/leave (via new_chat_members / left_chat_member on a message). */
export function normalizeTelegramEvent(update: unknown): InboundEvent | null {
  const u = update as any;
  if (!u) return null;

  if (u.callback_query) {
    const cq = u.callback_query;
    const chat = cq.message?.chat?.id;
    if (chat === undefined || !cq.data) return null;
    return {
      kind: "button",
      chatId: tgChatId(chat),
      senderId: cq.from?.id !== undefined ? tgChatId(cq.from.id) : "",
      token: String(cq.data),
      messageId: cq.message?.message_id !== undefined ? tgChatId(cq.message.message_id) : "",
      ts: Date.now(),
    };
  }

  if (u.message_reaction) {
    const mr = u.message_reaction;
    if (mr.chat?.id === undefined) return null;
    const newr = Array.isArray(mr.new_reaction) ? mr.new_reaction : [];
    const emoji = newr.find((x: any) => x?.emoji)?.emoji ?? "";
    if (!emoji) return null; // reaction removed → ignore
    return {
      kind: "reaction",
      chatId: tgChatId(mr.chat.id),
      senderId: mr.user?.id !== undefined ? tgChatId(mr.user.id) : "",
      emoji: String(emoji),
      messageId: mr.message_id !== undefined ? tgChatId(mr.message_id) : "",
      ts: mr.date ? mr.date * 1000 : Date.now(),
    };
  }

  const m = u.message;
  if (m?.chat?.id !== undefined) {
    if (Array.isArray(m.new_chat_members) && m.new_chat_members.length) {
      return { kind: "member", chatId: tgChatId(m.chat.id), userId: tgChatId(m.new_chat_members[0].id), change: "joined", ts: (m.date ?? 0) * 1000 || Date.now() };
    }
    if (m.left_chat_member) {
      return { kind: "member", chatId: tgChatId(m.chat.id), userId: tgChatId(m.left_chat_member.id), change: "left", ts: (m.date ?? 0) * 1000 || Date.now() };
    }
    const msg = normalizeTelegram(update);
    return msg ? { kind: "message", message: msg } : null;
  }

  return null;
}
