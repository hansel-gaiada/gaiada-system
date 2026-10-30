// AIP-03a — the one place a platform-nest caller of ai-gateway-go turns "I made a call" into an `ai_usage_events` row.
//
// WHY THIS FILE EXISTS (plan §6, AIP-03: "via one small shared client so callers cannot forget")
// No call site writes an insert. The gateway clients (search/providers/gateway-client.ts, social/gateway-client.ts, the assistant's
// relayGeneration and compaction call) each record the call they just made through `recordGatewayCall` below, and each takes an
// `AiCallAttribution` as a REQUIRED parameter in its type. A new caller of those clients cannot compile without saying who, which company,
// which surface; so forgetting is a type error, not a code review catch.
//
// WHAT IS RECORDED (never text)
//   * attribution: company, person (or null for a job / bot with no person), department, surface, thread, run, and a call-site `task` label;
//   * the answer's facts: capability, provider, model, outcome, token counts and cost when the gateway reported them;
//   * a refused call (DLP 503, budget 429, any other failure) is a row too, with the matching outcome and no tokens.
//
// THE DEPARTMENT (ai_usage_events.org_unit_id)
//   The call site's own department when it passes one (`orgUnitId`). Otherwise the person's PRIMARY membership today
//   (org_unit_memberships, is_primary, valid today: the same row person-scope.ts's ownPrimaryUnits reads for every department surface),
//   mapped to its org_units row. Cached per process for 10 minutes. Null when the person has no placement, or the placement is not an
//   org_units row, or there is no person. A failure to resolve is a null, never an error: it must never fail or slow the call.
//
// THE HOME NODE (ai_usage_events.unit_node_id, AIP-15a, plan §6.3 item 1)
//   The SAME primary placement's node id (org_unit_memberships.unit_node_id), whether or not that node has an org_units row: most
//   departments exist only as nodes of company_org_structure, which is why org_unit_id was empty on every live row. It is ALWAYS the
//   person's home: a call site's own `orgUnitId` (the page it came from) never changes it, because the bill goes to the department the
//   person works in. The same one read and the same 10-minute cache resolve both ids. A node id that is not a label (LABEL_PATTERN) is
//   recorded as null rather than costing the row.
//
// NEVER LET RECORDING BREAK OR SLOW A CALL
//   `recordGatewayCall` returns a promise that NEVER rejects, and callers do not await it (`void recordGatewayCall(...)`). It runs after the
//   answer is in hand. The writer it ends in (writer.ts) has the same never-throw contract.
import { withTenants } from "../../db";
import { INT4_MAX, LABEL_PATTERN, UUID_PATTERN, recordAiUsageCall, type AiUsageDeps, type AiUsageCall, type AiUsageContext, type RecordResult } from "./writer";
import { readGatewayTier } from "./routing";
import type { AiUsageCapability, AiUsageOutcome, AiUsageSurface } from "./vocab";

/**
 * Who is making the call and for what. REQUIRED by every gateway client in platform-nest.
 * `userId` is required but nullable on purpose: a caller must say "no person" (`null`) rather than leave it out by accident.
 */
export interface AiCallAttribution {
  /** The company (the RLS key). */
  tenantId: string;
  /** The person on whose behalf the call is made; null for a scheduled job or a call with no person. A bot is a `users` row: pass its id. */
  userId: string | null;
  /** The department, when the call site knows it. Leave out to have it resolved from the person's primary placement. */
  orgUnitId?: string | null;
  surface: AiUsageSurface;
  threadId?: string | null;
  runId?: string | null;
  /**
   * A call-site label such as `social.draft_caption` (no spaces, at most 120 characters). Recorded as-is in `ai_usage_events.task`.
   * AIP-07: the gateway routes on a coarser CLASS derived from it (`gatewayTaskFor`, routing.ts); the label is kept because it is finer.
   */
  task?: string | null;
}

/** The person a principal stands for, as the `userId` of an attribution. */
export function aiAttribution(
  principal: { userId?: string | null } | null | undefined,
  tenantId: string,
  surface: AiUsageSurface,
  extra: Omit<AiCallAttribution, "tenantId" | "userId" | "surface"> = {},
): AiCallAttribution {
  return { tenantId, userId: principal?.userId ?? null, surface, ...extra };
}

// ── what the gateway reports ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The gateway's `usage` object (AIP-02): `{promptTokens, completionTokens, costUsd?, source:"provider"}`. */
export interface GatewayUsage {
  promptTokens: number;
  completionTokens: number;
  /** The upstream's own USD figure; null when it sent none. A reported 0 is kept as 0. */
  costUsd: number | null;
}

/** Read the gateway's `usage` object. Null for anything that is not real provider-reported counts: absent, malformed, or not labelled "provider". */
export function readGatewayUsage(raw: unknown): GatewayUsage | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const u = raw as Record<string, unknown>;
  if (u.source !== undefined && u.source !== "provider") return null;
  const whole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= INT4_MAX;
  if (!whole(u.promptTokens) || !whole(u.completionTokens)) return null;
  const cost = typeof u.costUsd === "number" && Number.isFinite(u.costUsd) && u.costUsd >= 0 ? u.costUsd : null;
  return { promptTokens: u.promptTokens, completionTokens: u.completionTokens, costUsd: cost };
}

/** What an HTTP refusal from the gateway means for the record: 429 is the budget cap, 503 is DLP, anything else is an error. */
export function outcomeForGatewayStatus(status: number): AiUsageOutcome {
  if (status === 429) return "blocked_budget";
  if (status === 503) return "blocked_dlp";
  return "error";
}

/** The HTTP status in a gateway client error's message ("ai-gateway /complete returned HTTP 503"), or null. Never reads a body. */
export function statusFromError(err: unknown): number | null {
  const m = /HTTP (\d{3})/.exec((err as Error | undefined)?.message ?? "");
  return m ? Number(m[1]) : null;
}

/** A label the writer will accept, or null: a provider or model name with a space in it must not cost the whole row. */
function label(v: unknown): string | null {
  return typeof v === "string" && LABEL_PATTERN.test(v) ? v : null;
}

// ── one call's facts ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What a client knows after (or instead of) an answer. */
export interface GatewayCallFacts {
  capability: AiUsageCapability;
  outcome: AiUsageOutcome;
  provider?: string | null;
  model?: string | null;
  /** The tier the gateway reports it applied (AIP-06); anything but fast|standard|strong is dropped. A refused call records none. */
  tier?: string | null;
  /** The provider-reported counts and cost, when the answer carried them. Wins over `estimate`. */
  usage?: GatewayUsage | null;
  /** A labelled 4-characters-per-token estimate, used only when `usage` is absent. */
  estimate?: { promptTokens: number; completionTokens: number } | null;
  /** The provider the caller asked the gateway to try first (the cloudPolish hint), a label. */
  providerHint?: string | null;
}

/** Combine the facts into the writer's call shape. Pure. A refused call carries no tokens, whatever the caller passed. */
export function toAiUsageCall(facts: GatewayCallFacts, attr: Pick<AiCallAttribution, "task">): AiUsageCall {
  const refused = facts.outcome !== "ok" && facts.outcome !== "incurred";
  const usage = refused ? null : (facts.usage ?? null);
  const estimate = refused || usage ? null : (facts.estimate ?? null);
  const call: AiUsageCall = {
    capability: facts.capability,
    outcome: facts.outcome,
    provider: label(facts.provider),
    model: label(facts.model),
    tier: refused ? null : label(readGatewayTier(facts.tier)),
    task: label(attr.task ?? null),
    gatewayProviderHint: label(facts.providerHint ?? null),
    tokensSource: usage ? "provider" : estimate ? "estimate" : "none",
  };
  if (usage) {
    call.promptTokens = usage.promptTokens;
    call.completionTokens = usage.completionTokens;
    if (usage.costUsd !== null) {
      call.costUsd = usage.costUsd;
      call.costSource = "provider";
    }
  } else if (estimate) {
    call.promptTokens = estimate.promptTokens;
    call.completionTokens = estimate.completionTokens;
  }
  return call;
}

// ── the department of a person, cached ──────────────────────────────────────────────────────────────────────────────────────────────

const UNIT_TTL_MS = 10 * 60 * 1000;
const UNIT_CACHE_MAX = 5000;
/** The person's primary placement today: its org_units id (or null) and its org node id (or null). */
export interface PrimaryPlacement {
  orgUnitId: string | null;
  unitNodeId: string | null;
}
const NO_PLACEMENT: PrimaryPlacement = { orgUnitId: null, unitNodeId: null };
const unitCache = new Map<string, { placement: PrimaryPlacement; at: number }>();

/** Tests only: forget every cached department. */
export function clearUnitCacheForTests(): void {
  unitCache.clear();
}

export interface UnitDeps {
  /** Defaults to the platform's withTenants. */
  withTenants?: typeof withTenants;
  now?: () => number;
}

/**
 * The person's primary placement today: the org_units id (when the node has an ACTIVE org_units row) and the org node id itself (always,
 * when there is a placement). One read under the company's tenant context, cached per (company, person) for 10 minutes (an empty answer
 * is cached too, so a person with no placement is not re-read on every call). A failure is { null, null } and is NOT cached. Never throws.
 *
 * At most one primary membership is valid on a day (0055's EXCLUDE constraint), so the LEFT JOIN picks the same row the earlier
 * inner-join read did whenever that row has an org_units match: `orgUnitId` is exactly what it was before AIP-15a.
 */
export async function resolvePrimaryPlacement(tenantId: string, userId: string, deps: UnitDeps = {}): Promise<PrimaryPlacement> {
  const now = (deps.now ?? Date.now)();
  const key = `${tenantId}:${userId}`;
  const hit = unitCache.get(key);
  if (hit && now - hit.at < UNIT_TTL_MS) return hit.placement;
  try {
    const rows = await (deps.withTenants ?? withTenants)([tenantId], async (c) => {
      const r = await c.query<{ id: string | null; unit_node_id?: string | null }>(
        `SELECT ou.id, m.unit_node_id
           FROM org_unit_memberships m
           LEFT JOIN org_units ou ON ou.tenant_id = m.tenant_id AND ou.node_id = m.unit_node_id AND ou.status = 'active'
          WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.is_primary
            AND m.valid_from <= (now() AT TIME ZONE 'UTC')::date
            AND (m.valid_to IS NULL OR m.valid_to >= (now() AT TIME ZONE 'UTC')::date)
          ORDER BY m.valid_from DESC, ou.id NULLS LAST
          LIMIT 1`,
        [tenantId, userId],
      );
      return r.rows;
    });
    const row = rows[0];
    const node = row?.unit_node_id;
    const placement: PrimaryPlacement = row
      ? { orgUnitId: row.id ?? null, unitNodeId: typeof node === "string" && LABEL_PATTERN.test(node) ? node : null }
      : NO_PLACEMENT;
    if (unitCache.size >= UNIT_CACHE_MAX) unitCache.delete(unitCache.keys().next().value as string);
    unitCache.set(key, { placement, at: now });
    return placement;
  } catch {
    return NO_PLACEMENT;
  }
}

/** The org_units id of the person's primary placement today, or null (resolvePrimaryPlacement's first half; the same read and cache). */
export async function resolvePrimaryUnitId(tenantId: string, userId: string, deps: UnitDeps = {}): Promise<string | null> {
  return (await resolvePrimaryPlacement(tenantId, userId, deps)).orgUnitId;
}

// ── the recorder ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface GatewayUsageDeps {
  /** Overrides how a person's primary placement (org_units id and home node) is resolved (tests). */
  resolvePlacement?: (tenantId: string, userId: string) => Promise<PrimaryPlacement>;
  /** Passed through to the writer (tests). */
  writer?: AiUsageDeps;
}

/**
 * Record one gateway call. The returned promise NEVER rejects; callers must not await it on a hot path (`void recordGatewayCall(...)`).
 * Resolves to the writer's result, or null when nothing was attempted: an attribution with no usable company records nothing (there is
 * no row to write without one).
 */
export async function recordGatewayCall(attr: AiCallAttribution, facts: GatewayCallFacts, deps: GatewayUsageDeps = {}): Promise<RecordResult | null> {
  try {
    if (!attr || typeof attr.tenantId !== "string" || !UUID_PATTERN.test(attr.tenantId)) return null;
    let orgUnitId: string | null = attr.orgUnitId ?? null;
    let unitNodeId: string | null = null;
    if (typeof attr.userId === "string" && UUID_PATTERN.test(attr.userId)) {
      // One cached read answers both. The home node is ALWAYS the person's (AIP-15a); a call site's own orgUnitId still wins for org_unit_id.
      const placement = await (deps.resolvePlacement ?? resolvePrimaryPlacement)(attr.tenantId, attr.userId);
      if (attr.orgUnitId === undefined) orgUnitId = placement.orgUnitId;
      unitNodeId = placement.unitNodeId;
    }
    const ctx: AiUsageContext = {
      tenantId: attr.tenantId,
      userId: attr.userId ?? null,
      orgUnitId,
      unitNodeId,
      surface: attr.surface,
      threadId: attr.threadId ?? null,
      runId: attr.runId ?? null,
    };
    return await recordAiUsageCall(ctx, toAiUsageCall(facts, attr), deps.writer);
  } catch {
    // recordAiUsageCall cannot throw; this guards the department read and the shape building above. A broken record must never break a call.
    return null;
  }
}
