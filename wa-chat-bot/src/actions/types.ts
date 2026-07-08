// Action framework types. An Action is a *write* (distinct from a read-only Skill): it
// mutates platform data, chat state, or group membership. Every action flows through the
// executor gauntlet (kill-switch → rate-limit → authorize → confirm → execute → audit).
import type { Principal } from "../principal";
import type { ChatGateway, GatewayResult } from "../gateway/contract";
import type { Surface } from "../gateway/contract";

export type ActionCategory = "business" | "chat" | "group-admin";
export type RiskTier = "low" | "medium" | "high";

export interface ActionContext {
  principal: Principal;
  surface: Surface;
  chatId: string;
  senderId: string;
  senderName: string;
  gateway: ChatGateway;
  /** Call a hub write-tool with the sender's OBO envelope (wired in Phase D). */
  hub: (tool: string, args: Record<string, unknown>) => Promise<string>;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  ref?: string;
}

export type ParsedArgs<A> = { ok: true; args: A } | { ok: false; error: string };

export interface Action<A = Record<string, unknown>> {
  name: string;
  description: string;
  category: ActionCategory;
  riskTier: RiskTier;
  /** Maps to a Cerbos resource+action; the platform is the enforcement point. */
  cerbos: { resource: string; action: string };
  /** Validate/parse raw command args or an intent-router arg object. */
  validate(raw: string | Record<string, unknown>): ParsedArgs<A>;
  /** Human-readable "what will happen" shown in the confirmation card. */
  preview(args: A, ctx: ActionContext): string | Promise<string>;
  /** Perform the mutation. Only reached after authorize + confirm both pass. */
  execute(args: A, ctx: ActionContext): Promise<ActionResult>;
}

export type AuthzDecision = { decision: "allow" | "deny" | "stepup"; reason?: string };

/** The authority boundary. The bot never decides authorization itself; it delegates to
 *  this function, which (in Phase D) resolves the D4 identity and asks Cerbos via the hub. */
export type Authorizer = (principal: Principal, action: Action, ctx: ActionContext) => Promise<AuthzDecision>;

export type { GatewayResult };
