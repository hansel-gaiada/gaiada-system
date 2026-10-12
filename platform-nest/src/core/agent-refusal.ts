// PV4-07 — the TYPED refusal an agent gets where PV-D23 ("agents draft, staff send") shuts a door.
// Plan: docs/plans/2026-10-12-pv4-conversation-tickets.md (PV4-07; design decision 9). BFF: §29 "MCP tools".
//
// Cerbos is the DECIDER. The `conversation` kind denies `post` and `manage`, and `meeting_recording` denies
// `share_minutes`, to `principal.attr.kind in ["automation","bot"]` with an EFFECT_DENY that beats every ALLOW. What
// Cerbos returns is prose ("cerbos denied post on conversation"), and a bare 403 teaches an agent nothing: it cannot
// tell "you may not, ever" from "you lack a role", and it is not told what to do instead (agentic-native criterion 5).
//
// So the endpoints call `authorizeOrRefuseAgent` instead of `authorize`. For a `bot`/`automation` principal that is
// denied, the 403 body becomes `{error, reason}` where `reason` is a STABLE machine code and `error` names the tool the
// agent should call. The Cerbos message is kept at the end of `error`, so nothing that matched on it stops matching.
// A human is untouched: the exception is rethrown as it was.
//
// This changes the SHAPE of a refusal, never its outcome: the same call is refused with the same status, whether or not
// this wrapper exists. Remove it and the agent is still denied; it just is not told why.
import { ForbiddenException } from "@nestjs/common";
import type { Principal } from "../rbac/principal";
import type { Resource } from "../rbac/cerbos";
import { authorize } from "./http";

/** An agent may never send a message to, or share minutes with, a client. It drafts; a staff member sends. */
export const AGENTS_DRAFT_STAFF_SEND = "agents_draft_staff_send";
/** An agent may never close, reopen or rename a client conversation (`manage`). */
export const AGENTS_CANNOT_MANAGE_CONVERSATION = "agents_cannot_manage_conversation";

export interface AgentRefusal {
  /** The stable code a caller branches on. */
  reason: string;
  /** What to tell the agent: why it is refused and which tool to call instead. Never a bare "forbidden". */
  message: string;
}

/** `bot` and `automation` are the non-human principal kinds (principal-kinds memory; the Cerbos DENY keys on the same two). */
export function isAgentPrincipal(p: Principal): boolean {
  return p.kind === "bot" || p.kind === "automation";
}

/** The three refusals PV4-07 defines, each naming the tool an agent should use instead. */
export const REFUSALS = {
  post: {
    reason: AGENTS_DRAFT_STAFF_SEND,
    message:
      `${AGENTS_DRAFT_STAFF_SEND}: agents draft, staff send (PV-D23). An agent never posts to a client. ` +
      "Use conversation.draftReply to leave a draft reply on an existing thread; a staff member reviews it and sends it.",
  },
  sendDraft: {
    reason: AGENTS_DRAFT_STAFF_SEND,
    message:
      `${AGENTS_DRAFT_STAFF_SEND}: agents draft, staff send (PV-D23). Only a staff member sends a draft; yours stays pending ` +
      "for them to review. To change what it says, leave a new draft with conversation.draftReply.",
  },
  shareMinutes: {
    reason: AGENTS_DRAFT_STAFF_SEND,
    message:
      `${AGENTS_DRAFT_STAFF_SEND}: agents draft, staff send (PV-D23). An agent never shares minutes with a client. ` +
      "Use meetings.saveMinutes to save them as a draft; a staff member reads them and shares them.",
  },
  manage: {
    reason: AGENTS_CANNOT_MANAGE_CONVERSATION,
    message:
      `${AGENTS_CANNOT_MANAGE_CONVERSATION}: closing, reopening or renaming a client conversation is a staff action (PV-D23). ` +
      "Use conversation.draftReply to leave a draft on the thread; a staff member decides whether to close it.",
  },
} as const satisfies Record<string, AgentRefusal>;

/**
 * `authorize()`, except that a denial of an agent principal is thrown as a typed refusal (see the file header).
 * Everything `authorize()` does still happens first (the Cerbos check, the audit row, the act-for second check); only the
 * exception that leaves is different, and only for `bot`/`automation`.
 */
export async function authorizeOrRefuseAgent(
  principal: Principal,
  resource: Resource,
  action: string,
  refusal: AgentRefusal,
): Promise<void> {
  try {
    await authorize(principal, resource, action);
  } catch (err) {
    if (err instanceof ForbiddenException && isAgentPrincipal(principal)) {
      throw new ForbiddenException({ message: `${refusal.message} (${err.message})`, reason: refusal.reason });
    }
    throw err;
  }
}
