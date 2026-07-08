// The action executor: the single gauntlet every mutating action passes through, whether
// it came from a /command or the LLM intent router. Order matters and is security-critical:
//   kill-switch → rate-limit → validate → AUTHORIZE → propose+confirm → RE-AUTHORIZE → execute → audit
// Authorization is checked twice (propose and execute) so a revocation in between denies.
import { randomUUID } from "node:crypto";
import { actionsEnabled, killSwitchMessage } from "../safety/kill-switch";
import { checkRate } from "../safety/rate-limit";
import { recordActionAudit, actorHash } from "../safety/audit";
import type { ActionAuditEntry } from "../safety/audit";
import { putPending, consumeToken, getPending } from "./confirm";
import type { Action, ActionContext, AuthzDecision, Authorizer, RiskTier } from "./types";
import type { ActionButton } from "../gateway/contract";

const RATE: Record<RiskTier, { capacity: number; refillPerSec: number }> = {
  low: { capacity: 20, refillPerSec: 0.2 },
  medium: { capacity: 8, refillPerSec: 0.1 },
  high: { capacity: 3, refillPerSec: 0.03 },
};

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface ExecDeps {
  authorize: Authorizer;
  now?: number;
  genToken?: () => string;
  ttlMs?: number;
  audit?: (e: ActionAuditEntry) => Promise<void>;
}

export interface ProposeResult {
  reply: string;
  buttons?: ActionButton[];
  proposed: boolean;
}

const AFFIRMATIVE = /^(y|yes|ok|okay|confirm|confirmed|do it|1)$/i;
export const isAffirmative = (text: string): boolean => AFFIRMATIVE.test(text.trim());

function argsSummary(args: unknown): string {
  const s = typeof args === "string" ? args : JSON.stringify(args);
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

async function audit(deps: ExecDeps, ctx: ActionContext, action: Action, args: unknown, decision: ActionAuditEntry["decision"], outcome: ActionAuditEntry["outcome"], error?: string) {
  const write = deps.audit ?? recordActionAudit;
  await write({
    ts: deps.now ?? Date.now(),
    surface: ctx.surface,
    chatId: ctx.chatId,
    actor: actorHash(ctx.surface, ctx.senderId),
    action: action.name,
    argsSummary: argsSummary(args),
    decision,
    outcome,
    ...(error ? { error } : {}),
  }).catch(() => undefined);
}

/**
 * Stage 1: validate → authorize → propose. Returns the reply to send. When it returns
 * `proposed: true`, a pending confirmation was stored and `buttons` should be offered.
 */
export async function proposeAction(
  action: Action<any>,
  raw: string | Record<string, unknown>,
  ctx: ActionContext,
  deps: ExecDeps,
): Promise<ProposeResult> {
  const now = deps.now ?? Date.now();

  if (!actionsEnabled()) {
    await audit(deps, ctx, action, raw, "deny", "blocked", "kill-switch");
    return { reply: killSwitchMessage(), proposed: false };
  }

  const rl = checkRate(`${ctx.senderId}|${action.name}`, { ...RATE[action.riskTier], now });
  if (!rl.allowed) {
    await audit(deps, ctx, action, raw, "deny", "blocked", "rate-limited");
    return { reply: `You're doing that too often. Try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.`, proposed: false };
  }

  const parsed = action.validate(raw);
  if (!parsed.ok) {
    return { reply: parsed.error, proposed: false };
  }

  const decision = await deps.authorize(ctx.principal, action, ctx);
  if (decision.decision === "stepup") {
    await audit(deps, ctx, action, parsed.args, "stepup", "blocked");
    return { reply: decision.reason ?? "That needs a verified login. Ask an admin to link and verify your account, then try again.", proposed: false };
  }
  if (decision.decision === "deny") {
    await audit(deps, ctx, action, parsed.args, "deny", "blocked", decision.reason);
    return { reply: decision.reason ?? "You're not allowed to do that.", proposed: false };
  }

  const token = (deps.genToken ?? randomUUID)();
  const preview = await action.preview(parsed.args, ctx);
  putPending({ chatId: ctx.chatId, senderId: ctx.senderId, actionName: action.name, args: parsed.args, preview, token }, deps.ttlMs ?? DEFAULT_TTL_MS, now);
  return {
    reply: `${preview}\n\nConfirm?`,
    buttons: [
      { label: "✅ Confirm", token },
      { label: "✖ Cancel", token: `cancel:${token}` },
    ],
    proposed: true,
  };
}

/**
 * Stage 2: confirm by token (button press). Consumes the single-use token, RE-authorizes,
 * executes, audits. `resolve` maps an action name to its Action (registry lookup).
 */
export async function confirmAction(
  chatId: string,
  senderId: string,
  token: string,
  resolve: (name: string) => Action<any> | undefined,
  ctxFor: (pendingArgs: unknown, action: Action<any>) => ActionContext,
  deps: ExecDeps,
): Promise<{ reply: string; executed: boolean }> {
  const now = deps.now ?? Date.now();

  if (token.startsWith("cancel:")) {
    consumeToken(chatId, senderId, token.slice("cancel:".length), now);
    return { reply: "Cancelled.", executed: false };
  }

  const p = consumeToken(chatId, senderId, token, now);
  if (!p) return { reply: "Nothing to confirm (it may have expired or already run).", executed: false };

  const action = resolve(p.actionName);
  if (!action) return { reply: "That action is no longer available.", executed: false };

  const ctx = ctxFor(p.args, action);
  if (!actionsEnabled()) {
    await audit(deps, ctx, action, p.args, "deny", "blocked", "kill-switch");
    return { reply: killSwitchMessage(), executed: false };
  }

  // Re-authorize at execute time (revocation between propose and confirm must deny).
  const decision: AuthzDecision = await deps.authorize(ctx.principal, action, ctx);
  if (decision.decision !== "allow") {
    await audit(deps, ctx, action, p.args, decision.decision === "stepup" ? "stepup" : "deny", "blocked", decision.reason);
    return { reply: decision.reason ?? "You're no longer allowed to do that.", executed: false };
  }

  try {
    const result = await action.execute(p.args, ctx);
    await audit(deps, ctx, action, p.args, "allow", result.ok ? "done" : "failed", result.ok ? undefined : result.message);
    return { reply: result.message, executed: result.ok };
  } catch (err) {
    await audit(deps, ctx, action, p.args, "allow", "failed", (err as Error).message);
    return { reply: `That failed: ${(err as Error).message}`, executed: false };
  }
}

/** Confirm by an affirmative reply ("yes"/"1"). Resolves the stored token, then confirms. */
export async function confirmByReply(
  chatId: string,
  senderId: string,
  text: string,
  resolve: (name: string) => Action<any> | undefined,
  ctxFor: (pendingArgs: unknown, action: Action<any>) => ActionContext,
  deps: ExecDeps,
): Promise<{ reply: string; executed: boolean } | null> {
  const now = deps.now ?? Date.now();
  const p = getPending(chatId, senderId, now);
  if (!p) return null; // nothing pending → not a confirmation
  if (/^(n|no|cancel)$/i.test(text.trim())) {
    consumeToken(chatId, senderId, p.token, now);
    return { reply: "Cancelled.", executed: false };
  }
  if (!isAffirmative(text)) return null; // ambiguous → let normal handling take it
  return confirmAction(chatId, senderId, p.token, resolve, ctxFor, deps);
}
