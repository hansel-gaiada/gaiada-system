// Telegram adapter (Task 3.6 + 5a.7): the fallback surface. Official Bot API — no ban
// risk. Satisfies the same gateway contract as WAHA, so text AND media route through the
// exact same pipeline (registry → scrub → persist/enqueue → media worker → skills/Q&A).
// Media refs are `tg-file:<file_id>`; the media worker resolves them via getFile (free).
import { config } from "./config";
import { unsupported } from "./gateway/contract";
import type { ChatGateway, GatewayResult, MediaPayload, ActionButton } from "./gateway/contract";
import type { InboundMessage } from "./waha";

interface TgFile {
  file_id?: string;
  mime_type?: string;
}
interface TgMessage {
  message_id?: number;
  date?: number;
  text?: string;
  caption?: string;
  chat?: { id?: number; type?: string };
  from?: { id?: number; first_name?: string; last_name?: string; is_bot?: boolean };
  reply_to_message?: { from?: { is_bot?: boolean } };
  photo?: TgFile[]; // ascending sizes; last = largest
  voice?: TgFile;
  audio?: TgFile;
  video?: TgFile;
  document?: TgFile;
}
interface TgUpdate {
  message?: TgMessage;
}

/** Telegram chat ids are numeric; prefix them so they can never collide with WA ids. */
export const tgChatId = (id: number | string): string => `tg:${id}`;
export const TG_FILE_PREFIX = "tg-file:";

/** Extract a media descriptor from a Telegram message, if any. */
function tgMedia(m: TgMessage): { url: string; mimetype: string } | null {
  if (m.voice?.file_id) return { url: TG_FILE_PREFIX + m.voice.file_id, mimetype: m.voice.mime_type ?? "audio/ogg" };
  if (m.audio?.file_id) return { url: TG_FILE_PREFIX + m.audio.file_id, mimetype: m.audio.mime_type ?? "audio/mpeg" };
  if (m.video?.file_id) return { url: TG_FILE_PREFIX + m.video.file_id, mimetype: m.video.mime_type ?? "video/mp4" };
  if (m.document?.file_id)
    return { url: TG_FILE_PREFIX + m.document.file_id, mimetype: m.document.mime_type ?? "application/octet-stream" };
  if (m.photo?.length) {
    const largest = m.photo[m.photo.length - 1];
    if (largest.file_id) return { url: TG_FILE_PREFIX + largest.file_id, mimetype: "image/jpeg" };
  }
  return null;
}

export function normalizeTelegram(update: unknown): InboundMessage | null {
  const m = (update as TgUpdate)?.message;
  if (!m?.chat?.id) return null;
  if (m.from?.is_bot) return null; // never ingest bot chatter (incl. our own echoes)
  const media = tgMedia(m);
  const text = m.text ?? m.caption ?? "";
  if (text === "" && !media) return null; // nothing to ingest
  const type = m.chat.type ?? "private";
  return {
    chatId: tgChatId(m.chat.id),
    senderId: m.from?.id !== undefined ? tgChatId(m.from.id) : "",
    senderName: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" "),
    waMessageId: m.message_id !== undefined ? tgChatId(m.message_id) : "",
    ts: m.date ? m.date * 1000 : Date.now(),
    text,
    isGroup: type === "group" || type === "supergroup",
    fromMe: false,
    replyToBot: Boolean(m.reply_to_message?.from?.is_bot),
    media: media ? { url: media.url, mimetype: media.mimetype } : null,
  };
}

/** Resolve a `tg-file:<id>` ref to raw bytes via getFile + download (5a.7). */
export async function downloadTelegramFile(ref: string, token: string = config.telegramBotToken): Promise<Buffer> {
  const fileId = ref.slice(TG_FILE_PREFIX.length);
  const meta = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  if (!meta.ok) throw new Error(`telegram getFile ${meta.status}`);
  const path = ((await meta.json()) as { result?: { file_path?: string } }).result?.file_path;
  if (!path) throw new Error("telegram getFile: no file_path");
  const file = await fetch(`https://api.telegram.org/file/bot${token}/${path}`);
  if (!file.ok) throw new Error(`telegram file download ${file.status}`);
  return Buffer.from(await file.arrayBuffer());
}

export const isTelegramFileRef = (ref: string): boolean => ref.startsWith(TG_FILE_PREFIX);

/**
 * Long-polling intake (getUpdates) — works with NO public URL, so Telegram can run
 * locally today. Don't combine with a registered webhook (Telegram rejects getUpdates
 * while a webhook is set; use `deleteWebhook` to switch back).
 */
export async function pollTelegramOnce(
  token: string,
  offset: number,
  onMessage: (m: InboundMessage) => Promise<void>,
): Promise<number> {
  const res = await fetch(
    `https://api.telegram.org/bot${token}/getUpdates?timeout=25&offset=${offset}&allowed_updates=%5B%22message%22%5D`,
  );
  if (!res.ok) throw new Error(`getUpdates ${res.status}`);
  const data = (await res.json()) as { ok: boolean; result?: Array<{ update_id: number }> };
  let next = offset;
  for (const u of data.result ?? []) {
    next = Math.max(next, u.update_id + 1);
    const m = normalizeTelegram(u);
    if (m) await onMessage(m).catch((e: Error) => console.warn(`[telegram] handle failed: ${e.message}`));
  }
  return next;
}

export function startTelegramPoller(
  onMessage: (m: InboundMessage) => Promise<void>,
  opts: { token?: string; retryMs?: number } = {},
): { stop: () => void } {
  const token = opts.token ?? config.telegramBotToken;
  let offset = 0;
  let stopped = false;
  void (async () => {
    while (!stopped) {
      try {
        offset = await pollTelegramOnce(token, offset, onMessage);
      } catch (e) {
        console.warn(`[telegram] poll failed: ${(e as Error).message} — retrying`);
        await new Promise((r) => setTimeout(r, opts.retryMs ?? 5000));
      }
    }
  })();
  return {
    stop: () => {
      stopped = true;
    },
  };
}

/** Strip the `tg:` prefix we add to chat/user/message ids to get the Telegram-native id. */
const raw = (id: string): string => (id.startsWith("tg:") ? id.slice(3) : id);

export class TelegramGateway implements ChatGateway {
  constructor(private token: string = config.telegramBotToken) {}

  /** Generic Bot API call → GatewayResult (never throws for a request-level failure). */
  private async call(method: string, body: Record<string, unknown>): Promise<GatewayResult> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return { ok: false, error: `Telegram ${method} ${res.status} ${await res.text().catch(() => "")}` };
      const json = (await res.json().catch(() => ({}))) as { result?: unknown };
      return { ok: true, ref: typeof json.result === "string" ? json.result : JSON.stringify(json.result ?? "") };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: raw(chatId), text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
    }
  }

  async reply(chatId: string, replyToId: string, text: string): Promise<GatewayResult> {
    return this.call("sendMessage", { chat_id: raw(chatId), text, reply_parameters: { message_id: Number(raw(replyToId)) } });
  }

  async sendMedia(chatId: string, media: MediaPayload): Promise<GatewayResult> {
    const method =
      media.kind === "image" ? "sendPhoto" : media.kind === "voice" ? "sendVoice" : media.kind === "video" ? "sendVideo" : "sendDocument";
    const field = media.kind === "image" ? "photo" : media.kind === "voice" ? "voice" : media.kind === "video" ? "video" : "document";
    const value = media.url ?? media.base64;
    if (!value) return { ok: false, error: "sendMedia: no url or base64" };
    return this.call(method, { chat_id: raw(chatId), [field]: value, caption: media.caption });
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<GatewayResult> {
    return this.call("setMessageReaction", { chat_id: raw(chatId), message_id: Number(raw(messageId)), reaction: [{ type: "emoji", emoji }] });
  }

  async sendButtons(chatId: string, text: string, buttons: ActionButton[]): Promise<GatewayResult> {
    const inline_keyboard = [buttons.map((b) => ({ text: b.label, callback_data: b.token }))];
    return this.call("sendMessage", { chat_id: raw(chatId), text, reply_markup: { inline_keyboard } });
  }

  async typing(chatId: string, on: boolean): Promise<GatewayResult> {
    if (!on) return { ok: true }; // Telegram has no "stop typing"; the indicator auto-expires
    return this.call("sendChatAction", { chat_id: raw(chatId), action: "typing" });
  }

  async addMember(_chatId: string, _userId: string): Promise<GatewayResult> {
    return unsupported("addMember", "telegram"); // bots cannot add arbitrary users
  }

  async removeMember(chatId: string, userId: string): Promise<GatewayResult> {
    return this.call("banChatMember", { chat_id: raw(chatId), user_id: Number(raw(userId)) });
  }

  async promote(chatId: string, userId: string): Promise<GatewayResult> {
    return this.call("promoteChatMember", {
      chat_id: raw(chatId), user_id: Number(raw(userId)),
      can_manage_chat: true, can_delete_messages: true, can_restrict_members: true, can_pin_messages: true, can_invite_users: true,
    });
  }

  async demote(chatId: string, userId: string): Promise<GatewayResult> {
    return this.call("promoteChatMember", {
      chat_id: raw(chatId), user_id: Number(raw(userId)),
      can_manage_chat: false, can_delete_messages: false, can_restrict_members: false, can_pin_messages: false, can_invite_users: false,
    });
  }

  async setSubject(chatId: string, subject: string): Promise<GatewayResult> {
    return this.call("setChatTitle", { chat_id: raw(chatId), title: subject });
  }

  async pin(chatId: string, messageId: string): Promise<GatewayResult> {
    return this.call("pinChatMessage", { chat_id: raw(chatId), message_id: Number(raw(messageId)) });
  }

  async inviteLink(chatId: string): Promise<GatewayResult> {
    return this.call("createChatInviteLink", { chat_id: raw(chatId) });
  }
}
