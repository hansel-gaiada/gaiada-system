// WhatsApp gateway (WAHA adapter) + message normalization.
// Behind a small interface so WAHA/Baileys/Cloud API are swappable later.
import { config } from "./config";
import { supports } from "./gateway/capabilities";
import { unsupported } from "./gateway/contract";
import type { ChatGateway, GatewayResult, MediaPayload, ActionButton } from "./gateway/contract";

export interface InboundMessage {
  chatId: string;
  senderId: string;
  senderName: string;
  waMessageId: string;
  ts: number; // ms epoch
  text: string;
  isGroup: boolean;
  fromMe: boolean;
  /** True when this message quotes/replies to one of the bot's own messages. */
  replyToBot: boolean;
  /** JIDs @mentioned in the message (WhatsApp mentions tag a participant's JID, not literal text).
   *  Used to detect a real @mention of the bot. Empty when none / not a group mention. */
  mentionedJids: string[];
  /** Present when the message carries media. `url` is empty if WAHA didn't serve the file
   *  (since WAHA 2026.6.1 media is free in core — check media config if empty) — the
   *  worker records an observable failure either way. */
  media: { url: string; mimetype: string; filename?: string } | null;
}

export interface WhatsAppGateway {
  sendText(chatId: string, text: string): Promise<void>;
}

/** WhatsApp system/pseudo chats that must NEVER be ingested or replied to: status updates,
 *  broadcast lists, and channels/newsletters. (aire lesson: replying here is a ban/spam risk.) */
function isSystemChat(chatId: string): boolean {
  const id = chatId.toLowerCase();
  return id === "status@broadcast" || id.endsWith("@broadcast") || id.endsWith("@newsletter");
}

/** Extract @mentioned JIDs from a WAHA message payload. WEBJS and NOWEB (Baileys) put mentions in
 *  different places (aire lesson — they probe ~5 fields), so check them all and dedupe. */
function extractMentions(p: any): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (Array.isArray(v)) for (const x of v) if (typeof x === "string" && x) out.add(x);
  };
  add(p.mentionedIds);
  add(p.mentions);
  add(p._data?.mentionedJidList);
  add(p._data?.message?.extendedTextMessage?.contextInfo?.mentionedJid);
  add(p._data?.contextInfo?.mentionedJid);
  return [...out];
}

/** Map a raw WAHA webhook event to our internal shape. Returns null if not a usable text message.
 *  Engine-tolerant: reads WAHA's normalized payload fields (`from`/`body`/`media`/`participant`),
 *  which are consistent across the WEBJS and NOWEB (Baileys) engines; `_data` is the engine-specific
 *  raw and is only used as a best-effort fallback. */
export function normalize(event: unknown): InboundMessage | null {
  const e = event as any;
  if (!e || e.event !== "message") return null;
  const p = e.payload ?? {};
  const chatId: string = p.from ?? "";
  if (!chatId) return null;
  // Never process status/broadcast/newsletter pseudo-chats (engine-agnostic guard).
  if (isSystemChat(chatId)) return null;
  return {
    chatId,
    senderId: p.participant ?? p.author ?? p.from ?? "",
    senderName: p.notifyName ?? p._data?.notifyName ?? p._data?.pushName ?? "",
    waMessageId: p.id ?? "",
    ts: p.timestamp ? Number(p.timestamp) * 1000 : Date.now(),
    text: typeof p.body === "string" ? p.body : "",
    isGroup: String(chatId).endsWith("@g.us"),
    fromMe: Boolean(p.fromMe),
    // Engine-tolerant reply-to-bot: WEBJS exposes `_data.quotedMsg.fromMe`; WAHA's normalized
    // `replyTo.fromMe` (when present) covers NOWEB. Absent → false (mention is the primary trigger).
    replyToBot: Boolean(p._data?.quotedMsg?.fromMe ?? p.replyTo?.fromMe ?? false),
    mentionedJids: extractMentions(p),
    media:
      p.hasMedia || p.media
        ? {
            url: String(p.media?.url ?? ""),
            mimetype: String(p.media?.mimetype ?? p._data?.mimetype ?? "application/octet-stream"),
            filename: p.media?.filename ? String(p.media.filename) : undefined,
          }
        : null,
  };
}

export class WahaGateway implements ChatGateway {
  constructor(
    private baseUrl: string = config.wahaUrl,
    private session: string = config.wahaSession,
  ) {}

  private headers() {
    return { "Content-Type": "application/json", ...(config.wahaApiKey ? { "X-Api-Key": config.wahaApiKey } : {}) };
  }

  /** Generic WAHA call → GatewayResult (never throws for a request-level failure). */
  private async call(method: string, path: string, body?: unknown): Promise<GatewayResult> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) return { ok: false, error: `WAHA ${path} ${res.status} ${await res.text().catch(() => "")}` };
      const ref = await res.text().catch(() => "");
      return { ok: true, ref };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sendText`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ session: this.session, chatId, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`WAHA sendText failed: ${res.status} ${body}`);
    }
  }

  async reply(chatId: string, replyToId: string, text: string): Promise<GatewayResult> {
    return this.call("POST", "/api/sendText", { session: this.session, chatId, text, reply_to: replyToId });
  }

  async sendMedia(chatId: string, media: MediaPayload): Promise<GatewayResult> {
    const endpoint =
      media.kind === "image" ? "/api/sendImage" : media.kind === "voice" ? "/api/sendVoice" : "/api/sendFile";
    const file = {
      mimetype: media.mimetype,
      ...(media.url ? { url: media.url } : {}),
      ...(media.base64 ? { data: media.base64 } : {}),
      ...(media.filename ? { filename: media.filename } : {}),
    };
    return this.call("POST", endpoint, { session: this.session, chatId, file, caption: media.caption });
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<GatewayResult> {
    return this.call("PUT", "/api/reaction", { session: this.session, messageId, reaction: emoji });
  }

  /** WAHA interactive buttons vary by engine; deliver a reliable numbered-text prompt.
   *  The confirmation FSM (Phase C) accepts a numeric/`yes` reply, so this is functional. */
  async sendButtons(chatId: string, text: string, buttons: ActionButton[]): Promise<GatewayResult> {
    const lines = buttons.map((b, i) => `${i + 1}. ${b.label}`).join("\n");
    return this.call("POST", "/api/sendText", { session: this.session, chatId, text: `${text}\n\n${lines}\n\nReply with a number.` });
  }

  async typing(chatId: string, on: boolean): Promise<GatewayResult> {
    return this.call("POST", on ? "/api/startTyping" : "/api/stopTyping", { session: this.session, chatId });
  }

  async addMember(chatId: string, userId: string): Promise<GatewayResult> {
    return this.call("POST", `/api/${this.session}/groups/${chatId}/participants/add`, { participants: [userId] });
  }

  async removeMember(chatId: string, userId: string): Promise<GatewayResult> {
    return this.call("POST", `/api/${this.session}/groups/${chatId}/participants/remove`, { participants: [userId] });
  }

  async promote(chatId: string, userId: string): Promise<GatewayResult> {
    return this.call("POST", `/api/${this.session}/groups/${chatId}/admin/promote`, { participants: [userId] });
  }

  async demote(chatId: string, userId: string): Promise<GatewayResult> {
    return this.call("POST", `/api/${this.session}/groups/${chatId}/admin/demote`, { participants: [userId] });
  }

  async setSubject(chatId: string, subject: string): Promise<GatewayResult> {
    return this.call("PUT", `/api/${this.session}/groups/${chatId}/subject`, { subject });
  }

  async pin(_chatId: string, _messageId: string): Promise<GatewayResult> {
    return unsupported("pin", "whatsapp");
  }

  async inviteLink(chatId: string): Promise<GatewayResult> {
    if (!supports("whatsapp", "inviteLink")) return unsupported("inviteLink", "whatsapp");
    return this.call("GET", `/api/${this.session}/groups/${chatId}/invite-code`);
  }
}
