// AIP-18 (docs/plans/2026-10-27-ai-plan.md §6.3 item 9; docs/FRONTEND-BFF-CONTRACT.md §66.11) — what a STOPPED turn does, in one place:
//
//   * the stop is decided ONCE, at send time (`POST .../messages` and `POST assistant/ask`), from ai-usage's cached `budgetState`, and written
//     on the reply's PLACEHOLDER row as a `turn_budget` part, beside ASST-17's `turn_mode` and AIP-10's `turn_context`. The stream route reads
//     it back from the ROW (never its query string), so the send and the stream agree on one decision;
//   * the gateway call of that turn goes on the `fast` tier with NO provider hint and no provider session (the thread's stored `brain_tier`,
//     `brain_provider` and `hermes_session_id` are left exactly as they are: the next unstopped turn uses them again);
//   * retrieval is trimmed: half the knowledge passages (never below 1 while retrieval is on) and half the transcript's character budget for
//     THIS prompt (compaction still folds on the full budget, so the thread's stored summary moves exactly as it would have: nothing about the
//     thread changes because one turn was lighter);
//   * the part is kept on the finished reply (so a reloaded transcript shows the one line) and the stream emits it once as `event: budget`.
//
// The part names the kind, the unit (department only) and the reset instant. NEVER a figure: the line the person sees needs none.
//
// AIP-D1, honestly: while every tier maps to one model, `fast` costs the same. The real effects of a stop are the trimmed retrieval, the held
// agent runs and the line. Nothing here invents another lever.
import { config } from "../../config";
import type { GatewayTier } from "../ai-usage/routing";
import type { BudgetState, BudgetStop, BudgetStopKind } from "../ai-usage/soft-stop";

export const STOPPED_TIER: GatewayTier = "fast";

export interface TurnBudgetPart {
  type: "turn_budget";
  kind: BudgetStopKind;
  /** Department only. */
  unitNodeId?: string;
  /** ISO instant the stop ends on its own. */
  resetsAt: string;
}

/** The part for a stopped state, or null. Only the three facts: never a figure. */
export function turnBudgetPart(state: BudgetState): TurnBudgetPart | null {
  if (!state.stopped) return null;
  const s: BudgetStop = state.stop;
  return { type: "turn_budget", kind: s.kind, ...(s.kind === "department" && s.unitNodeId ? { unitNodeId: s.unitNodeId } : {}), resetsAt: s.resetsAt };
}

const KINDS: readonly string[] = ["allowance", "department"];

/** The `turn_budget` part of a placeholder's `parts`, re-validated (a malformed part is no stop: the turn runs as normal). */
export function readTurnBudget(parts: unknown): TurnBudgetPart | null {
  if (!Array.isArray(parts)) return null;
  for (const p of parts) {
    if (!p || typeof p !== "object" || (p as { type?: unknown }).type !== "turn_budget") continue;
    const kind = (p as { kind?: unknown }).kind;
    const resetsAt = (p as { resetsAt?: unknown }).resetsAt;
    const unitNodeId = (p as { unitNodeId?: unknown }).unitNodeId;
    if (typeof kind !== "string" || !KINDS.includes(kind)) return null;
    if (typeof resetsAt !== "string" || Number.isNaN(Date.parse(resetsAt))) return null;
    return {
      type: "turn_budget",
      kind: kind as BudgetStopKind,
      ...(kind === "department" && typeof unitNodeId === "string" && unitNodeId ? { unitNodeId } : {}),
      resetsAt,
    };
  }
  return null;
}

/** The wire shape of the stop (the SSE `budget` frame and the ask answer's `turnBudget`): the part without its `type`. */
export function turnBudgetWire(part: TurnBudgetPart): { kind: BudgetStopKind; unitNodeId?: string; resetsAt: string } {
  return { kind: part.kind, ...(part.unitNodeId ? { unitNodeId: part.unitNodeId } : {}), resetsAt: part.resetsAt };
}

/** PURE. Half the knowledge passages, never below 1 while retrieval is on; 0 (retrieval off) stays 0. */
export function trimmedKnowledgeTopK(topK: number): number {
  if (!Number.isFinite(topK) || topK <= 0) return topK;
  return Math.max(1, Math.floor(topK / 2));
}

/** PURE. Half the transcript's character budget, never below 1. */
export function trimmedCharBudget(budget: number): number {
  if (!Number.isFinite(budget) || budget <= 1) return budget;
  return Math.max(1, Math.floor(budget / 2));
}

/**
 * The `assembleContext` options of a turn: `{}` when it is not stopped (the call is then exactly what it was), else half the configured
 * knowledge passages and half the configured transcript budget.
 */
export function stoppedContextOpts(
  part: TurnBudgetPart | null,
  cfg: { knowledgeTopK: number; contextCharBudget: number } = config.assistant,
): { knowledgeTopK?: number; promptCharBudget?: number } {
  if (!part) return {};
  return { knowledgeTopK: trimmedKnowledgeTopK(cfg.knowledgeTopK), promptCharBudget: trimmedCharBudget(cfg.contextCharBudget) };
}

/** The gateway routing of a turn: unstopped, exactly today's (the thread's tier, the allowed provider hint and its session); stopped, `fast`. */
export function turnRouting(
  stopped: boolean,
  today: { provider: string | undefined; tier: GatewayTier | undefined; providerSession: string | undefined },
): { provider: string | undefined; tier: GatewayTier | undefined; providerSession: string | undefined } {
  return stopped ? { provider: undefined, tier: STOPPED_TIER, providerSession: undefined } : today;
}
