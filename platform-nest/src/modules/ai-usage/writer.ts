// AIP-01 — the append-only writer for `ai_usage_events` (migration 202610271800_ai_usage_events.sql).
//
// THE RULES THIS FILE KEEPS
//   * Ids, counts, labels and money only. Nothing here accepts prompt, answer, tool or message text. The event type has no such field,
//     an UNKNOWN KEY IS REJECTED (a JS caller cannot slip `content` or `prompt` through), and a label (task, tier, provider, model,
//     gateway hint) must match LABEL_PATTERN: no space, so it cannot hold a sentence. The table's own CHECK caps each label at 120.
//   * recordAiUsage NEVER BREAKS ITS CALLER. It does not throw and does not reject: any failure (a bad event, a missing database, a
//     foreign-key miss, a timeout) logs ONE warning and returns { ok: false }. The warning carries ids and a reason; never the event's
//     labels, counts or money, and never a database error's text (a CHECK violation's detail echoes the failing row).
//   * Written under the event's own company through withTenants([tenantId]), the one way to touch tenant data. The table is core (no
//     module wall), so no `modules` option is needed from any caller.
//   * Reads are not here. They arrive with AIP-15 behind a Cerbos kind `ai_usage`; by AIP-D6 a person never reads their own line.
//
// Callers (AIP-03) should not await it on a hot path: `void recordAiUsage(event)` is safe because it cannot reject.
import type { PoolClient } from "pg";
import { newId, withGlobal, withTenants } from "../../db";
import {
  AI_USAGE_CAPABILITIES,
  AI_USAGE_COST_SOURCES,
  AI_USAGE_OUTCOMES,
  AI_USAGE_SURFACES,
  AI_USAGE_TOKENS_SOURCES,
  type AiUsageCapability,
  type AiUsageCostSource,
  type AiUsageOutcome,
  type AiUsageSurface,
  type AiUsageTokensSource,
} from "./vocab";

/** One AI call. Every field is an id, a count, a label or money. There is no text field, by design. */
export interface AiUsageEvent {
  /** The company (the RLS key). Required. */
  tenantId: string;
  /** Defaults to the database's now(). */
  occurredAt?: Date | string | null;
  /** The person; null or absent for a bot or an unknown caller. */
  userId?: string | null;
  /** The department (an org_units id), when known. */
  orgUnitId?: string | null;
  surface: AiUsageSurface;
  capability: AiUsageCapability;
  /** The routing class and tier (AIP-06): labels. */
  task?: string | null;
  tier?: string | null;
  provider?: string | null;
  model?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  tokensSource: AiUsageTokensSource;
  /** US dollars. Present only with a costSource. */
  costUsd?: number | null;
  costSource?: AiUsageCostSource | null;
  outcome: AiUsageOutcome;
  threadId?: string | null;
  runId?: string | null;
  gatewayProviderHint?: string | null;
}

/** The ONLY keys an event may carry. Anything else is refused, so text cannot ride in under a new name. */
export const AI_USAGE_EVENT_KEYS = [
  "tenantId", "occurredAt", "userId", "orgUnitId", "surface", "capability", "task", "tier", "provider", "model",
  "promptTokens", "completionTokens", "tokensSource", "costUsd", "costSource", "outcome", "threadId", "runId", "gatewayProviderHint",
] as const;

const KEY_SET: ReadonlySet<string> = new Set(AI_USAGE_EVENT_KEYS);

/** A label is one token of `[A-Za-z0-9._:/@+-]`, 1 to 120 characters: a model id such as `ollama/kimi-k2.7-code:cloud` fits, a sentence does not. */
export const LABEL_PATTERN = /^[A-Za-z0-9._:/@+-]{1,120}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT4_MAX = 2147483647;
/** numeric(14,8): six digits before the point. */
const COST_MAX = 999999.99999999;

export type ValidationResult = { ok: true; event: AiUsageEvent } | { ok: false; error: string };

const fail = (error: string): ValidationResult => ({ ok: false, error });
const absent = (v: unknown): boolean => v === undefined || v === null;

/** Validate against the vocabularies. The error names a FIELD, never its value, so the caller may log it. */
export function validateAiUsageEvent(input: unknown): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return fail("event must be an object");
  const e = input as Record<string, unknown>;

  for (const k of Object.keys(e)) {
    if (!KEY_SET.has(k)) return fail(`unknown field: ${k.length <= 40 ? k : "(long name)"}`);
  }

  if (typeof e.tenantId !== "string" || !UUID_PATTERN.test(e.tenantId)) return fail("tenantId must be a uuid");
  for (const f of ["userId", "orgUnitId", "threadId", "runId"] as const) {
    if (!absent(e[f]) && (typeof e[f] !== "string" || !UUID_PATTERN.test(e[f] as string))) return fail(`${f} must be a uuid or null`);
  }

  const vocab: Array<[string, readonly string[]]> = [
    ["surface", AI_USAGE_SURFACES], ["capability", AI_USAGE_CAPABILITIES],
    ["tokensSource", AI_USAGE_TOKENS_SOURCES], ["outcome", AI_USAGE_OUTCOMES],
  ];
  for (const [f, list] of vocab) {
    if (typeof e[f] !== "string" || !list.includes(e[f] as string)) return fail(`${f} is not in its vocabulary`);
  }
  if (!absent(e.costSource) && (typeof e.costSource !== "string" || !(AI_USAGE_COST_SOURCES as readonly string[]).includes(e.costSource))) {
    return fail("costSource is not in its vocabulary");
  }

  for (const f of ["task", "tier", "provider", "model", "gatewayProviderHint"] as const) {
    if (!absent(e[f]) && (typeof e[f] !== "string" || !LABEL_PATTERN.test(e[f] as string))) {
      return fail(`${f} must be a label of 1 to 120 characters from A-Z a-z 0-9 . _ : / @ + - (no spaces)`);
    }
  }

  for (const f of ["promptTokens", "completionTokens"] as const) {
    const v = e[f];
    if (!absent(v) && (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > INT4_MAX)) {
      return fail(`${f} must be a whole number from 0 to ${INT4_MAX}, or null`);
    }
  }

  if (!absent(e.costUsd)) {
    const c = e.costUsd;
    if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > COST_MAX) return fail("costUsd must be a number from 0 to 999999.99999999, or null");
    if (absent(e.costSource)) return fail("costSource is required when costUsd is set");
  }

  if (!absent(e.occurredAt)) {
    const d = e.occurredAt instanceof Date ? e.occurredAt : typeof e.occurredAt === "string" ? new Date(e.occurredAt) : null;
    if (d === null || Number.isNaN(d.getTime())) return fail("occurredAt must be a valid date or null");
  }

  return { ok: true, event: e as unknown as AiUsageEvent };
}

export interface AiUsageInsert {
  text: string;
  values: unknown[];
}

export const AI_USAGE_INSERT_SQL =
  `INSERT INTO ai_usage_events
     (id, tenant_id, occurred_at, user_id, org_unit_id, surface, capability, task, tier, provider, model,
      prompt_tokens, completion_tokens, tokens_source, cost_usd, cost_source, outcome, thread_id, run_id, gateway_provider_hint)
   VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`;

/** The parameters of the one INSERT, in column order. Pure. Assumes a validated event. Absent fields are NULL (unknown, never zero). */
export function buildAiUsageInsert(event: AiUsageEvent, id: string): AiUsageInsert {
  const n = <T>(v: T | null | undefined): T | null => (v === undefined ? null : v);
  return {
    text: AI_USAGE_INSERT_SQL,
    values: [
      id,
      event.tenantId,
      event.occurredAt === undefined || event.occurredAt === null
        ? null
        : event.occurredAt instanceof Date ? event.occurredAt.toISOString() : new Date(event.occurredAt).toISOString(),
      n(event.userId),
      n(event.orgUnitId),
      event.surface,
      event.capability,
      n(event.task),
      n(event.tier),
      n(event.provider),
      n(event.model),
      n(event.promptTokens),
      n(event.completionTokens),
      event.tokensSource,
      // Sent as fixed-point text so a float's binary noise never reaches numeric(14,8).
      event.costUsd === undefined || event.costUsd === null ? null : event.costUsd.toFixed(8),
      n(event.costSource),
      event.outcome,
      n(event.threadId),
      n(event.runId),
      n(event.gatewayProviderHint),
    ],
  };
}

export interface AiUsageDeps {
  /** Defaults to the platform's withTenants. */
  withTenants?: <T>(tenantIds: string[], fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  /** Defaults to console.warn. */
  warn?: (message: string) => void;
  /** Defaults to the platform's time-ordered uuid. */
  newId?: () => string;
}

export type RecordResult = { ok: true; id: string } | { ok: false; reason: string };

/** Ids only: the sole event fields a warning may name. */
function idsOf(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const e = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const f of ["tenantId", "userId", "threadId", "runId"]) {
    const v = e[f];
    if (typeof v === "string" && UUID_PATTERN.test(v)) parts.push(`${f}=${v}`);
  }
  return parts.join(" ");
}

/** A pg error's SQLSTATE or its class name: never its message, which can echo the failing row. */
function dbReason(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return `database error ${code}`;
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && /^[A-Za-z]{1,40}$/.test(name)) return `error ${name}`;
  }
  return "unexpected error";
}

/**
 * Append one usage row. NEVER throws, never rejects. On any failure it logs one warning (ids and a reason, nothing else) and returns
 * { ok: false, reason }. Safe to fire and forget: `void recordAiUsage(event)`.
 */
export async function recordAiUsage(event: AiUsageEvent, deps: AiUsageDeps = {}): Promise<RecordResult> {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  let reason = "unexpected error";
  try {
    const checked = validateAiUsageEvent(event);
    if (!checked.ok) {
      reason = `invalid event: ${checked.error}`;
    } else {
      const id = (deps.newId ?? newId)();
      const insert = buildAiUsageInsert(checked.event, id);
      try {
        await (deps.withTenants ?? withTenants)([checked.event.tenantId], async (client) => {
          await client.query(insert.text, insert.values);
        });
        return { ok: true, id };
      } catch (err) {
        reason = dbReason(err);
      }
    }
  } catch {
    reason = "unexpected error";
  }
  try {
    warn(`[ai-usage] event not recorded (${reason})${idsOf(event) ? ` ${idsOf(event)}` : ""}`);
  } catch {
    // A broken logger must not break the caller either.
  }
  return { ok: false, reason };
}

// ── the small typed helper the later callers (AIP-03) use ───────────────────────────────────────────────────────────────────────────

/** What a caller knows before the call: who, where, and which thread or run. Build it once per request. */
export interface AiUsageContext {
  tenantId: string;
  userId?: string | null;
  orgUnitId?: string | null;
  surface: AiUsageSurface;
  threadId?: string | null;
  runId?: string | null;
}

/** What the call produced. Token counts are labelled by tokensSource; with no counts the source is 'none'. */
export interface AiUsageCall {
  capability: AiUsageCapability;
  outcome: AiUsageOutcome;
  provider?: string | null;
  model?: string | null;
  task?: string | null;
  tier?: string | null;
  gatewayProviderHint?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  /** Say 'provider' only when the provider reported the counts. Defaults to 'estimate' when counts are given, else 'none'. */
  tokensSource?: AiUsageTokensSource;
  costUsd?: number | null;
  costSource?: AiUsageCostSource | null;
  occurredAt?: Date | string | null;
}

/** Combine a request's context with one call's result into an event. Never claims 'provider' counts unless told so. */
export function buildAiUsageEvent(ctx: AiUsageContext, call: AiUsageCall): AiUsageEvent {
  const hasCounts = (call.promptTokens ?? null) !== null || (call.completionTokens ?? null) !== null;
  return {
    tenantId: ctx.tenantId,
    userId: ctx.userId ?? null,
    orgUnitId: ctx.orgUnitId ?? null,
    surface: ctx.surface,
    threadId: ctx.threadId ?? null,
    runId: ctx.runId ?? null,
    capability: call.capability,
    outcome: call.outcome,
    provider: call.provider ?? null,
    model: call.model ?? null,
    task: call.task ?? null,
    tier: call.tier ?? null,
    gatewayProviderHint: call.gatewayProviderHint ?? null,
    promptTokens: call.promptTokens ?? null,
    completionTokens: call.completionTokens ?? null,
    tokensSource: call.tokensSource ?? (hasCounts ? "estimate" : "none"),
    costUsd: call.costUsd ?? null,
    costSource: call.costSource ?? null,
    occurredAt: call.occurredAt ?? null,
  };
}

/** Context + call in one step: the one-liner a caller writes. Cannot throw. */
export function recordAiUsageCall(ctx: AiUsageContext, call: AiUsageCall, deps?: AiUsageDeps): Promise<RecordResult> {
  return recordAiUsage(buildAiUsageEvent(ctx, call), deps);
}

// ── erasure ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Erase a person from the usage record: sets user_id to NULL on every one of their rows in every company and keeps every count and
 * amount, so a company's totals stay right. Calls the SECURITY DEFINER function ai_usage_erase_user(uuid). Returns the rows cleared.
 *
 * UNLIKE recordAiUsage this THROWS: an erasure that fails quietly is a promise broken. The staff-user erasure job (none exists in
 * platform-nest today; see the migration header) must call this and treat a rejection as a failed step. A hard DELETE of a `users` row
 * needs no call: the foreign key clears user_id by itself.
 */
export async function eraseAiUsageForUser(userId: string): Promise<number> {
  if (!UUID_PATTERN.test(userId)) throw new Error("eraseAiUsageForUser: userId must be a uuid");
  const { rows } = await withGlobal((c) => c.query<{ cleared: string }>(`SELECT ai_usage_erase_user($1::uuid) AS cleared`, [userId]));
  return Number(rows[0]?.cleared ?? 0);
}
