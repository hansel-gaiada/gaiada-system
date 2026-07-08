// Identity ceiling (Task 1.9, D4): the bot NEVER asserts who someone is. It only carries
// the envelope (provider, external_id); the platform mints the principal. A WhatsApp
// session is inherently low-assurance, so the ceiling below is hard-coded: general Q&A
// and own-group Q&A only. Company-data access requires a step-up on a stronger surface —
// there is deliberately no way to express a role here.
/** "verified" exists only so future platform-minted principals can express it — nothing
 *  on the chat surface can produce one. */
export type Assurance = "low" | "verified";

export interface Principal {
  provider: "whatsapp" | "telegram";
  externalId: string;
  assurance: Assurance;
}

export type Action =
  | { kind: "general-qa" }
  | { kind: "group-qa"; sourceChatId: string; targetChatId: string }
  | { kind: "company-data"; resource: string };

export function resolvePrincipal(provider: "whatsapp" | "telegram", externalId: string): Principal {
  return { provider, externalId, assurance: "low" };
}

export function isAllowed(_p: Principal, action: Action): boolean {
  switch (action.kind) {
    case "general-qa":
      return true;
    case "group-qa":
      // Only the history of the chat the question was asked in.
      return action.sourceChatId === action.targetChatId;
    case "company-data":
      return false; // low-assurance ceiling — always denied on this surface
  }
}

export function denialMessage(action: Action): string {
  const what = action.kind === "company-data" ? action.resource : "that";
  return `I can't access ${what} from WhatsApp — it needs a verified login. I can answer general questions or summarize this group's own chat.`;
}
