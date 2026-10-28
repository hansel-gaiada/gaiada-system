// AIP-03b — turns "I called the gateway" into a UsageEvent for usage-reporter.ts. Identical copies live in ai-agents, mcp-hub and wa-chat-bot.
// Outcome mapping (every call site): HTTP 429 is blocked_budget, 503 is blocked_dlp, any other failure is error, otherwise ok. A refused or
// failed call carries no tokens and no cost. Tokens are 'provider' only when the gateway's `usage` object (AIP-02) is present and well formed;
// otherwise 'none' (these services estimate nothing). Labels that are not a plain token (a space in a model name) become null, never a sentence.
import type { UsageEvent } from "./usage-reporter";

const LABEL = /^[A-Za-z0-9._:/@+-]{1,120}$/;
const INT4_MAX = 2147483647;
export const label = (v: unknown): string | null => (typeof v === "string" && LABEL.test(v) ? v : null);

export function outcomeForStatus(status: number): UsageEvent["outcome"] {
  return status === 429 ? "blocked_budget" : status === 503 ? "blocked_dlp" : "error";
}

/** The gateway's `usage {promptTokens, completionTokens, costUsd?, source:"provider"}`, or null when absent or malformed. */
export function readUsage(raw: unknown): { promptTokens: number; completionTokens: number; costUsd: number | null } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const u = raw as Record<string, unknown>;
  const whole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= INT4_MAX;
  if ((u.source !== undefined && u.source !== "provider") || !whole(u.promptTokens) || !whole(u.completionTokens)) return null;
  const cost = typeof u.costUsd === "number" && Number.isFinite(u.costUsd) && u.costUsd >= 0 ? u.costUsd : null;
  return { promptTokens: u.promptTokens, completionTokens: u.completionTokens, costUsd: cost };
}

/** The gateway's reported routing tier: exactly fast, standard or strong, else null (never forwarded as-is). */
export const readTier = (v: unknown): "fast" | "standard" | "strong" | null => (v === "fast" || v === "standard" || v === "strong" ? v : null);

export type CallBase = Pick<UsageEvent, "tenantId" | "userId" | "surface" | "capability" | "task" | "runId">;

/** `status` is the gateway's HTTP status, or null when no HTTP answer arrived (network failure: error). `body` is the parsed answer on success. */
export function usageEvent(base: CallBase, status: number | null, body?: { provider?: unknown; model?: unknown; tier?: unknown; usage?: unknown } | null): UsageEvent {
  const ok = status !== null && status >= 200 && status < 300;
  const usage = ok ? readUsage(body?.usage) : null;
  return {
    ...base, task: label(base.task), userId: base.userId ?? null, runId: base.runId ?? null,
    // The gateway names the serving model next to `usage` (AIP-03 follow-up), so the platform's price table can cost the row.
    provider: ok ? label(body?.provider) : null, model: ok ? label(body?.model) : null,
    tier: ok ? readTier(body?.tier) : null,
    promptTokens: usage?.promptTokens ?? null, completionTokens: usage?.completionTokens ?? null,
    tokensSource: usage ? "provider" : "none",
    costUsd: usage?.costUsd ?? null, costSource: usage?.costUsd != null ? "provider" : null,
    outcome: ok ? "ok" : status === null ? "error" : outcomeForStatus(status),
  };
}
