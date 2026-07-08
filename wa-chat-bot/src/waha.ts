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
  /** Present when the message carries media. `url` is empty if WAHA didn't serve the file
   *  (since WAHA 2026.6.1 media is free in core — check media config if empty) — the
   *  worker records an observable failure either way. */
  media: { url: string; mimetype: string; filename?: string } | null;
}

export interface WhatsAppGateway {
  sendText(chatId: string, text: string): Promise<void>;
}

/** Map a raw WAHA webhook event to our internal shape. Returns null if not a text message. */
export function normalize(event: unknown): InboundMessage | null {
  const e = event as any;
  if (!e || e.event !== "message") return null;
  const p = e.payload ?? {};
  const chatId: string = p.from ?? "";
  if (!chatId) return null;
  return {
    chatId,
    senderId: p.participant ?? p.author ?? p.from ?? "",
    senderName: p.notifyName ?? p._data?.notifyName ?? "",
    waMessageId: p.id ?? "",
    ts: p.timestamp ? Number(p.timestamp) * 1000 : Date.now(),
    text: typeof p.body === "string" ? p.body : "",
    isGroup: String(chatId).endsWith("@g.us"),
    fromMe: Boolean(p.fromMe),
    replyToBot: Boolean(p._data?.quotedMsg?.fromMe),
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
