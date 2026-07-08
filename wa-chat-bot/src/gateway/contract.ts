// ChatGateway: the surface-agnostic outbound contract. WAHA and Telegram both implement
// it; a capability matrix declares which verbs each surface supports so the executor can
// degrade honestly (e.g. buttons → numbered text) instead of failing opaquely.

export type Surface = "whatsapp" | "telegram";

/** Verbs a gateway may support. `sendText` is universal and kept off this list (always ok). */
export type GatewayVerb =
  | "reply"
  | "sendMedia"
  | "react"
  | "sendButtons"
  | "typing"
  | "addMember"
  | "removeMember"
  | "promote"
  | "demote"
  | "setSubject"
  | "pin"
  | "inviteLink";

export type MediaKind = "image" | "document" | "voice" | "video";

export interface MediaPayload {
  kind: MediaKind;
  /** A URL the surface can fetch, or base64 data. Exactly one should be set. */
  url?: string;
  base64?: string;
  mimetype: string;
  filename?: string;
  caption?: string;
}

export interface ActionButton {
  /** Shown to the user. */
  label: string;
  /** Opaque single-use token echoed back on press (never the raw action args). */
  token: string;
}

export interface GatewayResult {
  ok: boolean;
  /** True when the surface cannot perform this verb; caller should degrade. */
  unsupported?: boolean;
  /** Surface-native id of anything created (e.g. invite link, message id). */
  ref?: string;
  error?: string;
}

/**
 * Full outbound contract. `sendText` matches the legacy WhatsAppGateway exactly, so every
 * existing caller keeps working; the rest are new. Group-admin verbs require the bot to be
 * an admin of the target group and may be `unsupported` on a given surface.
 */
export interface ChatGateway {
  sendText(chatId: string, text: string): Promise<void>;
  reply(chatId: string, replyToId: string, text: string): Promise<GatewayResult>;
  sendMedia(chatId: string, media: MediaPayload): Promise<GatewayResult>;
  react(chatId: string, messageId: string, emoji: string): Promise<GatewayResult>;
  sendButtons(chatId: string, text: string, buttons: ActionButton[]): Promise<GatewayResult>;
  typing(chatId: string, on: boolean): Promise<GatewayResult>;
  addMember(chatId: string, userId: string): Promise<GatewayResult>;
  removeMember(chatId: string, userId: string): Promise<GatewayResult>;
  promote(chatId: string, userId: string): Promise<GatewayResult>;
  demote(chatId: string, userId: string): Promise<GatewayResult>;
  setSubject(chatId: string, subject: string): Promise<GatewayResult>;
  pin(chatId: string, messageId: string): Promise<GatewayResult>;
  inviteLink(chatId: string): Promise<GatewayResult>;
}

/** unsupported result helper. */
export const unsupported = (verb: GatewayVerb, surface: Surface): GatewayResult => ({
  ok: false,
  unsupported: true,
  error: `${surface} does not support ${verb}`,
});
