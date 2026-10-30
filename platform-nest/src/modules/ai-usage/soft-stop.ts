// AIP-18 (docs/plans/2026-10-27-ai-plan.md §6.3 item 9; rulings AIP-D1, AIP-D7, AIP-D8, AIP-D9; docs/FRONTEND-BFF-CONTRACT.md §66.11) — the
// soft stop's one question: is this person, in this company, stopped right now, and why?
//
//   ALLOWANCE   the person's assistant replies TODAY (the UTC day; `ai_usage_events` surface 'assistant', outcome 'ok', user_id = them) are at
//               or above their daily allowance (their `ai_person_allowances` row, else config.aiUsage.dailyReplyAllowance, AIP-D9). It resets
//               at the next 00:00 UTC.
//   DEPARTMENT  some unit on the path from the person's HOME node (the primary placement AIP-15a records, `resolvePrimaryPlacement`) UP through
//               its ancestors (the per-tenant closure) has an `ai_budgets` row in mode 'soft_stop', its month-to-date spend (the unit's whole
//               SUBTREE, the UTC month, the reads' own SQL) is at or above its monthly figure, and its stop was not lifted for this month. The
//               nearest such unit is named. It resets on the first of the next UTC month. A cost nobody knows never counts (the AIP-01 rule:
//               budgetFigure counts a NULL sum as nothing spent), and a 'report' unit never stops anything (AIP-D7).
//   Both at once: the allowance is reported (it is the person's own, and it resets first).
//
// FAILS OPEN. A soft stop only ever makes a reply lighter, it never refuses one, so a failure to compute is NOT a stop: `budgetState` never
// throws and never takes longer than one cached read on a hit, and at most `BUDGET_STATE_TIMEOUT_MS` on a miss (the computation then finishes in
// the background and fills the cache). The release of held hand-offs is the opposite: it asks `computeBudgetState`, which THROWS, so a failure
// keeps a hand-off held until the next try instead of starting it by accident.
//
// THE CACHE is per process, per (company, person), 60 seconds, and never past the stop's own reset instant (a stop does not outlive midnight
// because of the cache). A lift or an edit by the owner clears the company's entries in THIS process (`invalidateBudgetState`); another replica
// catches up within 60 seconds.
//
// Two halves, as budgets.ts: PURE (`decideBudgetState`, the reset instants, `isStopCandidate`), and the I/O that feeds it (one withTenants
// transaction: ai_budgets, ai_person_allowances, ai_usage_events and org_unit_closure are FORCE RLS; an unset GUC would read ZERO rows and
// report "not stopped").
import type { PoolClient } from "pg";
import { withTenants } from "../../db";
import { config } from "../../config";
import { budgetFigure, utcDay } from "./budgets";
import { parseMonth, readTotals, type UsageMonth } from "./reads.service";
import { resolvePrimaryPlacement, type PrimaryPlacement } from "./gateway-usage";

export type BudgetStopKind = "allowance" | "department";

/** Why a person is stopped. Never a figure: the line the person sees needs none (AIP-D18 lets them see their own, elsewhere). */
export interface BudgetStop {
  kind: BudgetStopKind;
  /** The unit whose budget stopped them (department only): the nearest stopped unit on the path up from their home node. */
  unitNodeId?: string;
  /** ISO instant the stop ends on its own: the next 00:00 UTC (allowance) or the first instant of the next UTC month (department). */
  resetsAt: string;
}

export type BudgetState = { stopped: false } | { stopped: true; stop: BudgetStop };

export const NOT_STOPPED: BudgetState = Object.freeze({ stopped: false }) as BudgetState;

// ── PURE ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** PURE. The next 00:00 UTC after `now` (a `now` at exactly midnight resets at the NEXT midnight: the day it names has just begun). */
export function nextUtcMidnight(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return d.toISOString();
}

/** PURE. The first instant of the UTC month after `now`'s. */
export function nextUtcMonthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/** One `ai_budgets` unit row on the person's path, nearest first. `spentUsd` is the unit's month-to-date subtree cost (null: none known). */
export interface PathBudget {
  unitNodeId: string;
  mode: string | null;
  monthlyUsd: string;
  stopLiftedMonth: string | null;
  /** Month-to-date spend of the unit's subtree; `undefined` when it was not computed (the row cannot stop anyone). */
  spentUsd?: string | null;
}

/** PURE. Whether a budget row could stop anyone this month at all: mode 'soft_stop' and not lifted for `month` (`YYYY-MM`). */
export function isStopCandidate(row: Pick<PathBudget, "mode" | "stopLiftedMonth">, month: string): boolean {
  return row.mode === "soft_stop" && row.stopLiftedMonth !== month;
}

export interface BudgetStateInput {
  /** Assistant replies with outcome 'ok' the person made today (the UTC day). */
  repliesToday: number;
  /** The person's daily allowance (their row, else the default). */
  allowance: number;
  /** The `ai_budgets` unit rows on the path from the home node up, NEAREST FIRST (the home node itself first when it has one). */
  path: PathBudget[];
}

/**
 * PURE. The decision table of §6.3 item 9. Allowance first; then the nearest unit on the path that is a stop candidate this month and whose
 * spend is at or above its figure (an exact decimal comparison, budgets.ts). A row whose spend was not computed, or is unknown (null), never
 * stops. Anything malformed (a non-integer count or allowance) reads as "not stopped" for that half: the soft stop fails open.
 */
export function decideBudgetState(input: BudgetStateInput, now: Date): BudgetState {
  const month = parseMonth(undefined, now).month;
  if (Number.isInteger(input.repliesToday) && Number.isInteger(input.allowance) && input.allowance > 0 && input.repliesToday >= input.allowance) {
    return { stopped: true, stop: { kind: "allowance", resetsAt: nextUtcMidnight(now) } };
  }
  for (const row of input.path) {
    if (!isStopCandidate(row, month) || row.spentUsd === undefined) continue;
    let over = false;
    try {
      over = budgetFigure(row.spentUsd, row.monthlyUsd).state === "over_100";
    } catch {
      over = false; // a figure that does not parse cannot stop anyone (fail open)
    }
    if (over) return { stopped: true, stop: { kind: "department", unitNodeId: row.unitNodeId, resetsAt: nextUtcMonthStart(now) } };
  }
  return NOT_STOPPED;
}

// ── I/O ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface BudgetStateDeps {
  now?: () => Date;
  /** The home-node resolver (default: AIP-15a's `resolvePrimaryPlacement`, the same read and 10-minute cache the usage writer uses). */
  resolvePlacement?: (tenantId: string, userId: string) => Promise<PrimaryPlacement>;
  withTenants?: typeof withTenants;
}

/** The person's daily allowance: their override row, else the configured default (AIP-D9). On the caller's withTenants([tenantId]) client. */
async function readAllowance(c: PoolClient, tenantId: string, userId: string): Promise<number> {
  const { rows } = await c.query<{ daily_replies: number }>(
    `SELECT daily_replies FROM ai_person_allowances WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  );
  return rows[0]?.daily_replies ?? config.aiUsage.dailyReplyAllowance;
}

/** Today's (UTC) assistant replies of the person that completed (outcome 'ok'). Served by ix_ai_usage_events_user_day. */
async function readRepliesToday(c: PoolClient, tenantId: string, userId: string, now: Date): Promise<number> {
  const day = utcDay(now);
  const { rows } = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ai_usage_events
      WHERE tenant_id = $1 AND user_id = $2 AND surface = 'assistant' AND outcome = 'ok'
        AND occurred_at >= $3::timestamptz AND occurred_at < $4::timestamptz`,
    [tenantId, userId, `${day}T00:00:00Z`, nextUtcMidnight(now)],
  );
  return rows[0]?.n ?? 0;
}

/**
 * The unit budget rows on the path from `homeNode` up (the closure is self-inclusive, so the home node's own row comes first), nearest first,
 * each with its month-to-date subtree spend when it is a stop candidate this month (the spend of any other row is never read: it cannot stop).
 */
export async function readPathBudgets(c: PoolClient, tenantId: string, homeNode: string, month: UsageMonth): Promise<PathBudget[]> {
  const { rows } = await c.query<{ unit_node_id: string; mode: string | null; monthly_usd: string; stop_lifted_month: string | null }>(
    `SELECT b.unit_node_id, b.mode, b.monthly_usd::text AS monthly_usd, b.stop_lifted_month
       FROM org_unit_closure cl
       JOIN ai_budgets b ON b.tenant_id = cl.tenant_id AND b.scope = 'unit' AND b.unit_node_id = cl.ancestor_id
      WHERE cl.tenant_id = $1 AND cl.descendant_id = $2
      ORDER BY cl.depth ASC, b.unit_node_id COLLATE "C"`,
    [tenantId, homeNode],
  );
  const out: PathBudget[] = [];
  for (const r of rows) {
    const row: PathBudget = { unitNodeId: r.unit_node_id, mode: r.mode, monthlyUsd: r.monthly_usd, stopLiftedMonth: r.stop_lifted_month };
    if (isStopCandidate(row, month.month)) row.spentUsd = (await readTotals(c, tenantId, month, { kind: "unit", unitNodeId: r.unit_node_id })).costUsd;
    out.push(row);
  }
  return out;
}

/**
 * STRICT: the person's state now, read fresh (no cache). THROWS on any failure: the release of held hand-offs relies on that (a failure keeps
 * a hand-off held). The send path never calls this directly: it calls `budgetState`, which fails open.
 */
export async function computeBudgetState(tenantId: string, userId: string, deps: BudgetStateDeps = {}): Promise<BudgetState> {
  const now = (deps.now ?? (() => new Date()))();
  const month = parseMonth(undefined, now);
  const tx = deps.withTenants ?? withTenants;
  const own = await tx([tenantId], async (c) => ({
    allowance: await readAllowance(c, tenantId, userId),
    repliesToday: await readRepliesToday(c, tenantId, userId, now),
  }));
  const first = decideBudgetState({ ...own, path: [] }, now);
  if (first.stopped) return first; // the allowance answers first: no department read needed
  const placement = await (deps.resolvePlacement ?? resolvePrimaryPlacement)(tenantId, userId);
  if (!placement.unitNodeId) return NOT_STOPPED;
  const homeNode = placement.unitNodeId;
  const path = await tx([tenantId], (c) => readPathBudgets(c, tenantId, homeNode, month));
  return decideBudgetState({ ...own, path }, now);
}

// ── the cached, fail-open read the send path asks ─────────────────────────────────────────────────────────────────────────────────

export const BUDGET_STATE_TTL_MS = 60_000;
/** On a cache miss the send path waits at most this long; past it the turn is NOT stopped and the result fills the cache when it lands. */
export const BUDGET_STATE_TIMEOUT_MS = 1_500;
const CACHE_MAX = 5000;

const cache = new Map<string, { state: BudgetState; expiresAt: number }>();
const inflight = new Map<string, Promise<BudgetState>>();

const keyOf = (tenantId: string, userId: string) => `${tenantId}:${userId.toLowerCase()}`;

/** Forget the cached state of one person, or of every person of a company (a lift, a budget or allowance edit). This process only. */
export function invalidateBudgetState(tenantId: string, userId?: string): void {
  if (userId) {
    cache.delete(keyOf(tenantId, userId));
    return;
  }
  const prefix = `${tenantId}:`;
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
}

/** Tests only. */
export function clearBudgetStateCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

export interface CachedBudgetStateDeps extends BudgetStateDeps {
  /** Overrides the strict computation (tests). */
  compute?: (tenantId: string, userId: string) => Promise<BudgetState>;
  timeoutMs?: number;
}

/**
 * The send path's one question. NEVER throws and NEVER stops a turn on a failure (fail open). A hit is a map read; a miss computes once per
 * (company, person) even when several sends race (one in-flight promise), and waits at most `timeoutMs`. A stopped answer is cached until
 * the earlier of 60 seconds and the stop's own reset instant; a failure is not cached (the next send asks again).
 */
export async function budgetState(tenantId: string, userId: string | null | undefined, deps: CachedBudgetStateDeps = {}): Promise<BudgetState> {
  if (!tenantId || !userId) return NOT_STOPPED;
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const key = keyOf(tenantId, userId);
  const hit = cache.get(key);
  if (hit && nowMs < hit.expiresAt) return hit.state;

  let p = inflight.get(key);
  if (!p) {
    const compute = deps.compute ?? ((t: string, u: string) => computeBudgetState(t, u, deps));
    p = (async () => {
      try {
        const state = await compute(tenantId, userId);
        const resets = state.stopped ? Date.parse(state.stop.resetsAt) : Number.POSITIVE_INFINITY;
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
        cache.set(key, { state, expiresAt: Math.min(nowMs + BUDGET_STATE_TTL_MS, Number.isFinite(resets) ? resets : nowMs + BUDGET_STATE_TTL_MS) });
        return state;
      } catch (e) {
        console.warn(`[AI-USAGE] budget state for a person could not be computed (${e instanceof Error ? e.message : "error"}); not stopped`);
        return NOT_STOPPED;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
  }
  const timeoutMs = deps.timeoutMs ?? BUDGET_STATE_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<BudgetState>((resolve) => {
    timer = setTimeout(() => resolve(NOT_STOPPED), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
