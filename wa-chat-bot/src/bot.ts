import { scrub } from "./scrub";
import { resolvePrincipal, isAllowed, denialMessage } from "./principal";
import { loadGroups, isMonitored, noteDiscovered, isIgnored } from "./groups";
import { ensureGroupName } from "./group-names";
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
import { checkReplyBudget } from "./safety/reply-budget";
import { isLoopSuppressed } from "./safety/loop-guard";
import { config } from "./config";
import { handleSessionEvent, getSelfJid } from "./session-state";
import { refreshSelfJid } from "./waha-admin";
import type { InboundMessage, WhatsAppGateway } from "./waha";
import type { InboundEvent } from "./gateway/events";

if (listSkills().length === 0) registerBuiltins();
if (listActions().length === 0) {
  registerBusinessActions();
  registerGroupAdminActions();
}

/** True only when the bot is mentioned as a STANDALONE token (start or after whitespace, followed
 *  by end/whitespace/punctuation). Prevents accidental triggers from substrings like "@bottom" or
 *  "someone@bot.com" — a loose includes() would fire the bot on those and make it "go crazy". */
export function mentionsBot(text: string): boolean {
  const esc = config.botMention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${esc}(?=$|\\W)`, "i").test(text);
}

/** Just the digits of a JID (628123...@c.us / @s.whatsapp.net / @lid all vary) for robust matching. */
function jidDigits(s: string): string {
  return s.match(/\d+/g)?.join("") ?? "";
}

/** True when the bot's own JID is among the message's @mentioned JIDs — i.e. a REAL WhatsApp
 *  @mention of the bot (picker mention), which tags the bot's number, not the literal text "@bot".
 *  Returns false until the session is paired and the bot's JID is known. */
export function mentionsSelfJid(mentionedJids: string[]): boolean {
  const self = getSelfJid();
  if (!self) return false;
  const sd = jidDigits(self);
  return sd.length > 0 && mentionedJids.some((j) => jidDigits(j) === sd);
}

/** Whether the bot may auto-reply to a DM from this sender, per dmReplyPolicy. Default "off"
 *  protects a shared/personal number — personal contacts are never auto-answered. */
export function dmReplyAllowed(senderId: string): boolean {
  if (config.dmReplyPolicy === "all") return true;
  if (config.dmReplyPolicy === "allowlist") {
    const digits = senderId.replace(/\D/g, "");
    return digits.length > 0 && config.dmAllowlist.includes(digits);
  }
  return false; // "off"
}

/** Respond ONLY when properly addressed. Groups: command prefix, a real @mention of the bot (by
 *  JID or the "@Rhea" text), or a reply to the bot — ordinary chatter is never answered (still
 *  stored for digests). DMs: only per dmReplyPolicy (default off) so a shared/personal number does
 *  not auto-reply to personal contacts. */
export function isTriggered(m: InboundMessage, text: string): boolean {
  if (!m.isGroup) return dmReplyAllowed(m.senderId);
  if (m.replyToBot) return true;
  if (text.trimStart().startsWith(config.commandPrefix)) return true;
  if (mentionsSelfJid(m.mentionedJids)) return true;
  return mentionsBot(text);
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
  // Surface EVERY group the bot sees (even in trial mode with no registry) so the ERP monitor
  // can list them for the operator to formalize. Dedup'd by id inside noteDiscovered.
  if (inbound.isGroup) {
    noteDiscovered(inbound.chatId);
    // The webhook has no group subject (only the sender's push name), so resolve it from
    // WAHA out-of-band. Fire-and-forget + no-op when already known: never blocks the reply.
    void ensureGroupName(inbound.chatId).catch(() => {});
  }
  // 1a: the ignore list drops a group in BOTH modes, ahead of the registry gate — an
  // ignored group is never stored, even in trial mode (where the registry gate below is a
  // no-op). It was still noteDiscovered()'d above, so it stays visible/un-ignorable.
  if (inbound.isGroup && isIgnored(inbound.chatId)) {
    return;
  }
  // Registry active -> only listed groups are ingested; unlisted ones are dropped (observable via
  // the discovered list above), never persisted. DMs and registry-inactive mode pass through.
  if (inbound.isGroup && loadGroups() !== null && !isMonitored(inbound.chatId)) {
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
  // Backlog guard: WAHA delivers unread history on (re)connect. Store it, but NEVER reply to a
  // stale message — otherwise the bot answers hours-old chatter the moment it comes online.
  if (config.replyMaxAgeMs > 0 && Date.now() - inbound.ts > config.replyMaxAgeMs) return;
  // A pending confirmation from this user takes precedence over normal handling — even
  // without an explicit trigger, since a "yes"/"1" reply is a plain group message.
  if (await tryConfirmByReply(gw, inbound, clean)) return;
  if (!isTriggered(inbound, clean)) return;
  // Loop guard (abuse/ban protection): a bot<->bot or echo loop must never be engaged —
  // refusing to reply is the only correct response (the message is already stored above, so
  // it still counts for digests/history). Logs once per chat internally; PII-free.
  if (isLoopSuppressed(inbound.chatId, clean)) return;
  // Per-(chat,sender) reply budget: bounds a single sender's burst on the reply path (the
  // only prior protection here was `fromMe`). Exhaustion is SILENT on purpose — a "slow down"
  // reply would itself be outbound traffic and could itself contribute to a flood. Scoped to
  // the engage-and-reply pipeline (Q&A/skills + action propose/confirm/intent below); a
  // pending confirmation ("yes"/"no" via tryConfirmByReply above) is exempt — it's a single,
  // bounded, user-initiated exchange already governed by the action executor's own rate limit.
  if (!checkReplyBudget(inbound.chatId, inbound.senderId)) return;
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
 *  confirmations (always processed); session events feed the session-state tracker;
 *  reaction/member events are reserved for Phase F. */
export async function handleEvent(gw: WhatsAppGateway, event: InboundEvent): Promise<void> {
  if (event.kind === "message") return handleInbound(gw, event.message);
  if (event.kind === "button") return handleButton(gw, event.chatId, event.senderId, event.token);
  if (event.kind === "session") {
    handleSessionEvent(event);
    // On (re)pair, learn the bot's own JID so real @mentions (JID-tagged) trigger replies.
    if (event.status === "WORKING") void refreshSelfJid().catch(() => {});
    return;
  }
  // reaction / member events are not yet actioned.
}
