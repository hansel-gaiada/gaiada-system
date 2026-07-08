import { scrub } from "./scrub";
import { resolvePrincipal, isAllowed, denialMessage } from "./principal";
import { loadGroups, isMonitored, noteDiscovered } from "./groups";
import { saveMessage, getMessages } from "./store";
import { answerQuestion } from "./summarize";
import { registerBuiltins, routeCommand, listSkills } from "./skills";
import { registerBusinessActions } from "./actions/builtins";
import { registerGroupAdminActions } from "./actions/group-admin";
import { listActions } from "./actions/registry";
import { dispatchActionCommand, dispatchIntent, tryConfirmByReply, handleButton, isActionCommand } from "./actions/dispatch";
import { emitDiscovery } from "./discovery";
import { enqueueMedia } from "./media-queue";
import { seenBefore, dedupKey } from "./safety/dedup";
import { sendWithRetry } from "./safety/outbound";
import { config } from "./config";
import type { InboundMessage, WhatsAppGateway } from "./waha";
import type { InboundEvent } from "./gateway/events";

if (listSkills().length === 0) registerBuiltins();
if (listActions().length === 0) {
  registerBusinessActions();
  registerGroupAdminActions();
}

/** In groups, respond when addressed: command prefix, @mention, or a reply to the bot. DMs always respond. */
export function isTriggered(m: InboundMessage, text: string): boolean {
  if (!m.isGroup) return true;
  if (m.replyToBot) return true;
  const t = text.toLowerCase();
  return text.startsWith(config.commandPrefix) || t.includes(config.botMention);
}

export async function respond(m: InboundMessage, text: string): Promise<string> {
  const stripped = text.trim();
  if (stripped.startsWith(config.commandPrefix)) {
    const body = stripped.slice(config.commandPrefix.length).trim();
    const cmd = (body.split(/\s+/)[0] ?? "").toLowerCase();
    const args = body.slice(cmd.length).trim();
    return routeCommand(cmd, { msg: m, args, principal: resolvePrincipal("whatsapp", m.senderId) });
  }
  // Q&A ceiling (D4): the sender is only ever a low-assurance (provider, external_id)
  // envelope — history access is limited to the chat the question was asked in.
  const principal = resolvePrincipal("whatsapp", m.senderId);
  const action = { kind: "group-qa", sourceChatId: m.chatId, targetChatId: m.chatId } as const;
  if (!isAllowed(principal, action)) return denialMessage(action);
  const question = text.replace(new RegExp(config.botMention, "ig"), "").trim() || text;
  return answerQuestion(question, await getMessages(m.chatId));
}

/** The core loop: scrub -> store -> (if addressed) answer + reply. */
export async function handleInbound(gw: WhatsAppGateway, inbound: InboundMessage): Promise<void> {
  if (inbound.fromMe) return;
  // Idempotency: drop webhook redeliveries so nothing is stored or answered twice.
  const surface = inbound.chatId.startsWith("tg:") ? "telegram" : "whatsapp";
  if (inbound.waMessageId && seenBefore(dedupKey(surface, inbound.waMessageId))) return;
  // Registry active -> only listed groups are ingested; unlisted ones are logged
  // (observable drop), never persisted. DMs and registry-inactive mode pass through.
  if (inbound.isGroup && loadGroups() !== null && !isMonitored(inbound.chatId)) {
    noteDiscovered(inbound.chatId);
    return;
  }
  const { clean } = scrub(inbound.text);
  await saveMessage({
    chatId: inbound.chatId,
    senderId: inbound.senderId,
    senderName: inbound.senderName,
    waMessageId: inbound.waMessageId,
    ts: inbound.ts,
    text: clean,
    fromBot: false,
    // Media intake (Phase 2): store a reference only, mark pending; the media worker
    // downloads, extracts text, scrubs it, and completes the row asynchronously.
    ...(inbound.media
      ? { mediaMime: inbound.media.mimetype, mediaRef: inbound.media.url, mediaStatus: "pending" as const }
      : {}),
  });
  // 5a.1: enqueue eagerly on receipt; the reconciler poller catches any miss.
  if (inbound.media) void enqueueMedia(inbound.waMessageId);
  // A pending confirmation from this user takes precedence over normal handling — even
  // without an explicit trigger, since a "yes"/"1" reply is a plain group message.
  if (await tryConfirmByReply(gw, inbound, clean)) return;
  if (!isTriggered(inbound, clean)) return;
  emitDiscovery({
    ts: Date.now(),
    surface: inbound.chatId.startsWith("tg:") ? "telegram" : "whatsapp",
    kind: !inbound.isGroup
      ? "dm"
      : clean.trim().startsWith(config.commandPrefix)
        ? "command"
        : inbound.replyToBot
          ? "reply"
          : "mention",
    ...(clean.trim().startsWith(config.commandPrefix)
      ? { command: clean.trim().slice(config.commandPrefix.length).split(/\s+/)[0]?.toLowerCase() }
      : {}),
    isGroup: inbound.isGroup,
  });
  // Action commands (writes) go through the executor gauntlet, not the read-only skill
  // router: propose → authorize → confirm → execute. Non-actions fall through to Q&A/skills.
  if (clean.trim().startsWith(config.commandPrefix)) {
    const body = clean.trim().slice(config.commandPrefix.length).trim();
    if (isActionCommand(body) && (await dispatchActionCommand(gw, inbound, body))) return;
  } else if (await dispatchIntent(gw, inbound, clean)) {
    // Natural-language action intent ("assign task X to Budi") → proposed + confirm-gated.
    return;
  }
  const reply = await respond(inbound, clean);
  const delivery = await sendWithRetry(gw, inbound.chatId, reply);
  if (!delivery.ok) console.warn(`[bot] reply delivery failed after ${delivery.attempts} attempts: ${delivery.error}`);
  await saveMessage({
    chatId: inbound.chatId,
    senderId: "bot",
    senderName: "Bot",
    waMessageId: "",
    ts: Date.now(),
    text: reply,
    fromBot: true,
  });
}

/** Route a normalized inbound event. Messages take the full pipeline; button presses are
 *  confirmations (always processed); reaction/member events are reserved for Phase F. */
export async function handleEvent(gw: WhatsAppGateway, event: InboundEvent): Promise<void> {
  if (event.kind === "message") return handleInbound(gw, event.message);
  if (event.kind === "button") return handleButton(gw, event.chatId, event.senderId, event.token);
  // reaction / member events are not yet actioned.
}
