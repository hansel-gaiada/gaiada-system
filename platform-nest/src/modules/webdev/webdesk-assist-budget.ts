// M5-W6 — the per-principal daily budget of AI assist. A budget is the ERP's own: ai-gateway-go has a global daily cost cap and
// an optional per-tenant one (keyed on an `x-tenant-id` header this client does not send), and its /complete reports no token
// usage, so neither can say "this writer has had enough today". The ERP counts what IT asked for.
//
// WHERE THE COUNT LIVES: the `activities` ledger, in the request's company (RLS-scoped, no migration). Two rows per call under
// the verb `webdesk.content.assist`:
//   `phase:"reserved"`  written BEFORE the gateway call, inside the same transaction that checked the budget, under a per-principal
//                       advisory lock, so two concurrent calls cannot both take the last slot. Carries `tokensEst` (the prompt).
//   `phase:"completed"` written after, with the outcome, latency and `tokensEst` (the completion). When the gateway never served
//                       the call (down, not configured, only the keyless `echo` answered) it carries `refundCalls:1` and
//                       `tokensRefund` = the prompt estimate, so an outage does not use up a writer's day.
// Rows carry ids, the kind, counts and latency. Never a prompt, a completion or an item's text.
//
// "TODAY" is the UTC day. TOKENS ARE ESTIMATES (about four characters a token): the gateway reports none for /complete. The
// response says so (`tokensAreEstimates: true`). Limits come from env with defaults, read on every call (a bad or empty value
// falls back to the default, never to zero: an empty `${VAR:-}` must not turn a limit into "no calls allowed" or "no limit").
import { newId, withTenants } from "../../db";
import { currentVia } from "../../core/request-context";
import { config } from "../../config";
import type { Principal } from "../../rbac/principal";

export const ASSIST_VERB = "webdesk.content.assist";

export interface AssistLimits {
  calls: number;
  tokens: number;
}

export interface AssistUsage {
  calls: number;
  tokens: number;
}

/** Bots, automation accounts and anything an agent or n8n drives. The budget is the only thing that differs for them. */
export function isAutomatedPrincipal(p: Principal): boolean {
  return p.kind === "bot" || p.kind === "automation" || p.via?.agent !== undefined || p.via?.provider === "n8n";
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Humans: 40 calls and ~120k estimated tokens a day. Automated callers: 15 and ~40k (they can loop; a person cannot). */
export function limitsFor(p: Principal): AssistLimits {
  return isAutomatedPrincipal(p)
    ? { calls: envInt("WEBDESK_ASSIST_DAILY_CALLS_AUTOMATED", 15), tokens: envInt("WEBDESK_ASSIST_DAILY_TOKENS_AUTOMATED", 40_000) }
    : { calls: envInt("WEBDESK_ASSIST_DAILY_CALLS", 40), tokens: envInt("WEBDESK_ASSIST_DAILY_TOKENS", 120_000) };
}

export const startOfUtcDay = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
export const secondsToNextUtcDay = (now: Date): number => Math.max(1, Math.ceil((startOfUtcDay(now).getTime() + 86_400_000 - now.getTime()) / 1000));

export interface ReserveInput {
  tenantId: string;
  userId: string;
  kind: string;
  siteId: string;
  itemId: string;
  version: number | null;
  promptTokensEst: number;
  limits: AssistLimits;
  now: Date;
}

export type Reserved =
  | { ok: true; reservationId: string; before: AssistUsage }
  | { ok: false; before: AssistUsage; retryAfterSeconds: number };

export type AssistOutcome = "served" | "output_invalid" | "gateway_unavailable" | "not_configured" | "no_provider";

export interface SettleInput {
  tenantId: string;
  userId: string;
  reservationId: string;
  kind: string;
  siteId: string;
  itemId: string;
  outcome: AssistOutcome;
  /** The completion's estimated tokens (0 when nothing came back). */
  completionTokensEst: number;
  /** The prompt estimate that was reserved: refunded when the gateway never served the call. */
  promptTokensEst: number;
  latencyMs: number;
  suggestions: number;
  provider: string | null;
}

export interface AssistBudgetStore {
  reserve(i: ReserveInput): Promise<Reserved>;
  settle(i: SettleInput): Promise<void>;
}

/** Outcomes the gateway never served: the call and its prompt tokens are given back. */
export const REFUNDED_OUTCOMES: readonly AssistOutcome[] = ["gateway_unavailable", "not_configured", "no_provider"];

// ── the real store: the `activities` ledger ────────────────────────────────────────────────────────────────────────
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ledgerAssistBudget: AssistBudgetStore = {
  async reserve(i) {
    const since = startOfUtcDay(i.now);
    return withTenants([i.tenantId], async (c) => {
      // One writer at a time per principal and company: the count and the insert below are one decision.
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`assist:${i.tenantId}:${i.userId}`]);
      const { rows } = await c.query<{ reserved: number; refunded: number; tokens: number }>(
        `SELECT count(*) FILTER (WHERE metadata->>'phase' = 'reserved')::int AS reserved,
                COALESCE(sum((metadata->>'refundCalls')::int), 0)::int AS refunded,
                (COALESCE(sum((metadata->>'tokensEst')::int), 0) - COALESCE(sum((metadata->>'tokensRefund')::int), 0))::int AS tokens
           FROM activities
          WHERE tenant_id = $1 AND actor_id = $2 AND verb = $3 AND occurred_at >= $4`,
        [i.tenantId, i.userId, ASSIST_VERB, since],
      );
      const before: AssistUsage = { calls: Math.max(0, (rows[0]?.reserved ?? 0) - (rows[0]?.refunded ?? 0)), tokens: Math.max(0, rows[0]?.tokens ?? 0) };
      if (before.calls >= i.limits.calls || before.tokens + i.promptTokensEst > i.limits.tokens) {
        return { ok: false as const, before, retryAfterSeconds: secondsToNextUtcDay(i.now) };
      }
      const id = newId();
      const via = currentVia();
      await c.query(
        `INSERT INTO activities (id, tenant_id, actor_id, verb, target_entity_type, target_entity_id, metadata, origin_site)
         VALUES ($1, $2, $3, $4, 'webdesk_content_item', $5, $6, $7)`,
        [
          id, i.tenantId, i.userId, ASSIST_VERB, UUID.test(i.itemId) ? i.itemId : null,
          JSON.stringify({ phase: "reserved", kind: i.kind, siteId: i.siteId, itemId: i.itemId, version: i.version, tokensEst: i.promptTokensEst, ...(via ? { via } : {}) }),
          config.originSite,
        ],
      );
      return { ok: true as const, reservationId: id, before };
    });
  },

  async settle(i) {
    const refund = REFUNDED_OUTCOMES.includes(i.outcome);
    const via = currentVia();
    await withTenants([i.tenantId], (c) =>
      c.query(
        `INSERT INTO activities (id, tenant_id, actor_id, verb, target_entity_type, target_entity_id, metadata, origin_site)
         VALUES ($1, $2, $3, $4, 'webdesk_content_item', $5, $6, $7)`,
        [
          newId(), i.tenantId, i.userId, ASSIST_VERB, UUID.test(i.itemId) ? i.itemId : null,
          JSON.stringify({
            phase: "completed", reservationId: i.reservationId, kind: i.kind, siteId: i.siteId, itemId: i.itemId, outcome: i.outcome,
            latencyMs: i.latencyMs, suggestions: i.suggestions, provider: i.provider,
            tokensEst: i.completionTokensEst, tokensAreEstimates: true,
            ...(refund ? { refundCalls: 1, tokensRefund: i.promptTokensEst } : {}),
            ...(via ? { via } : {}),
          }),
          config.originSite,
        ],
      ),
    );
  },
};

// ── an in-memory store with the SAME rules, for unit tests that have no database ────────────────────────────────────
export class InMemoryAssistBudget implements AssistBudgetStore {
  readonly rows: Array<Record<string, unknown>> = [];

  async reserve(i: ReserveInput): Promise<Reserved> {
    const since = startOfUtcDay(i.now).getTime();
    const mine = this.rows.filter((r) => r.tenantId === i.tenantId && r.userId === i.userId && (r.at as number) >= since);
    const before: AssistUsage = {
      calls: Math.max(0, mine.filter((r) => r.phase === "reserved").length - mine.reduce((n, r) => n + ((r.refundCalls as number | undefined) ?? 0), 0)),
      tokens: Math.max(0, mine.reduce((n, r) => n + ((r.tokensEst as number | undefined) ?? 0) - ((r.tokensRefund as number | undefined) ?? 0), 0)),
    };
    if (before.calls >= i.limits.calls || before.tokens + i.promptTokensEst > i.limits.tokens) {
      return { ok: false, before, retryAfterSeconds: secondsToNextUtcDay(i.now) };
    }
    const id = newId();
    this.rows.push({ id, tenantId: i.tenantId, userId: i.userId, at: i.now.getTime(), phase: "reserved", kind: i.kind, itemId: i.itemId, tokensEst: i.promptTokensEst });
    return { ok: true, reservationId: id, before };
  }

  async settle(i: SettleInput): Promise<void> {
    const refund = REFUNDED_OUTCOMES.includes(i.outcome);
    this.rows.push({
      tenantId: i.tenantId, userId: i.userId, at: Date.now(), phase: "completed", reservationId: i.reservationId, kind: i.kind, itemId: i.itemId,
      outcome: i.outcome, latencyMs: i.latencyMs, suggestions: i.suggestions, provider: i.provider, tokensEst: i.completionTokensEst,
      ...(refund ? { refundCalls: 1, tokensRefund: i.promptTokensEst } : {}),
    });
  }
}
