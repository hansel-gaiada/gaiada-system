// Per-surface capability matrix. The executor consults `supports()` before dispatching a
// verb; unsupported verbs degrade (buttons → numbered text, react → 👍 text) rather than
// failing opaquely. Kept as data so it is trivial to test and to adjust as APIs change.
import type { GatewayVerb, Surface } from "./contract";

const MATRIX: Record<Surface, Record<GatewayVerb, boolean>> = {
  whatsapp: {
    reply: true,
    sendMedia: true,
    react: true,
    sendButtons: true,
    typing: true,
    addMember: true,
    removeMember: true,
    promote: true,
    demote: true,
    setSubject: true,
    pin: false, // WAHA pin support is inconsistent across engines — treat as unsupported for now
    inviteLink: true,
  },
  telegram: {
    reply: true,
    sendMedia: true,
    react: true,
    sendButtons: true,
    typing: true,
    addMember: false, // bots cannot add arbitrary users to a group (Telegram restriction)
    removeMember: true,
    promote: true,
    demote: true,
    setSubject: true,
    pin: true,
    inviteLink: true,
  },
};

export function supports(surface: Surface, verb: GatewayVerb): boolean {
  return MATRIX[surface]?.[verb] ?? false;
}

/** Surface implied by a chat id (tg:-prefixed ids are Telegram; everything else WhatsApp). */
export function surfaceOf(chatId: string): Surface {
  return chatId.startsWith("tg:") ? "telegram" : "whatsapp";
}
