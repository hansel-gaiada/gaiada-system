// Wires the action framework to the chat surfaces. Command dispatch, button-press
// confirmation, and affirmative-reply confirmation all funnel into the executor gauntlet.
// The bot never asserts identity — it forwards the (surface, senderId) OBO envelope and lets
// the platform (via the hub) decide.
import { callHubTool } from "../hub";
import { resolvePrincipal } from "../principal";
import { surfaceOf } from "../gateway/capabilities";
import { sendWithRetry } from "../safety/outbound";
import { getAction } from "./registry";
import { makeHubAuthorizer } from "./authorize";
import { proposeAction, confirmAction, confirmByReply } from "./executor";
import { getPending } from "./confirm";
import { routeIntent } from "./intent";
import type { Action, ActionContext } from "./types";
import type { ChatGateway } from "../gateway/contract";
import type { InboundMessage, WhatsAppGateway } from "../waha";

const authorizer = makeHubAuthorizer();

function buildCtx(gw: WhatsAppGateway, chatId: string, senderId: string, senderName: string): ActionContext {
  const surface = surfaceOf(chatId);
  return {
    principal: resolvePrincipal(surface, senderId),
    surface,
    chatId,
    senderId,
    senderName,
    gateway: gw as unknown as ChatGateway,
    hub: (tool, args) => callHubTool(tool, args, { provider: surface, externalId: senderId }),
  };
}

/** Resolve `word0.word1` (e.g. "task create") to a registered action; null if not one. */
function matchAction(body: string): { action: Action<any>; args: string } | null {
  const words = body.trim().split(/\s+/);
  if (words.length < 2) return null;
  const action = getAction(`${words[0].toLowerCase()}.${words[1].toLowerCase()}`);
  if (!action) return null;
  return { action, args: words.slice(2).join(" ") };
}

/** True if `body` (already stripped of the command prefix) is a known action command. */
export function isActionCommand(body: string): boolean {
  return matchAction(body) !== null;
}

/** Shared: propose an action and deliver the preview (buttons where supported). */
async function proposeAndSend(
  gw: WhatsAppGateway,
  msg: InboundMessage,
  action: Action<any>,
  args: string | Record<string, unknown>,
): Promise<void> {
  const ctx = buildCtx(gw, msg.chatId, msg.senderId, msg.senderName);
  const result = await proposeAction(action, args, ctx, { authorize: authorizer });
  const full = gw as unknown as Partial<ChatGateway>;
  if (result.proposed && result.buttons && typeof full.sendButtons === "function") {
    await full.sendButtons(msg.chatId, result.reply, result.buttons);
  } else {
    await sendWithRetry(gw, msg.chatId, result.reply);
  }
}

/** Propose an action from a command. Returns true if it was an action (handled). */
export async function dispatchActionCommand(gw: WhatsAppGateway, msg: InboundMessage, body: string): Promise<boolean> {
  const match = matchAction(body);
  if (!match) return false;
  await proposeAndSend(gw, msg, match.action, match.args);
  return true;
}

/**
 * Natural-language path: map free text to a proposed action (or a clarifying question).
 * Returns true if it produced an action proposal or a clarification; false → fall back to Q&A.
 */
export async function dispatchIntent(gw: WhatsAppGateway, msg: InboundMessage, text: string): Promise<boolean> {
  const intent = await routeIntent(text);
  if (intent.kind === "none") return false;
  if (intent.kind === "clarify") {
    await sendWithRetry(gw, msg.chatId, intent.question);
    return true;
  }
  const action = getAction(intent.actionName);
  if (!action) return false;
  await proposeAndSend(gw, msg, action, intent.args);
  return true;
}

const resolve = (name: string) => getAction(name);

/** Handle a button press (confirmation). Always processed (not subject to trigger rules). */
export async function handleButton(gw: WhatsAppGateway, chatId: string, senderId: string, token: string): Promise<void> {
  const ctxFor = () => buildCtx(gw, chatId, senderId, "");
  const r = await confirmAction(chatId, senderId, token, resolve, ctxFor, { authorize: authorizer });
  await sendWithRetry(gw, chatId, r.reply);
}

/**
 * If the user has a pending action here, treat an affirmative/negative reply as its
 * confirmation. Returns true if it was consumed as a confirmation, false otherwise.
 */
export async function tryConfirmByReply(gw: WhatsAppGateway, msg: InboundMessage, text: string): Promise<boolean> {
  if (!getPending(msg.chatId, msg.senderId)) return false;
  const ctxFor = () => buildCtx(gw, msg.chatId, msg.senderId, msg.senderName);
  const r = await confirmByReply(msg.chatId, msg.senderId, text, resolve, ctxFor, { authorize: authorizer });
  if (!r) return false;
  await sendWithRetry(gw, msg.chatId, r.reply);
  return true;
}
