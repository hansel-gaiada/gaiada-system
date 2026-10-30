// AIP-15 (docs/FRONTEND-BFF-CONTRACT.md §66, docs/PERMISSION-CONTRACT.md §58; plan docs/plans/2026-10-27-ai-plan.md §6.3 item 3) — the three
// AI usage reads: the month parser, the answer's shapes and the SQL, kept out of the controller so the rules are unit-testable and the
// controller stays an authorize-then-delegate layer (the dept-assistant-preamble layout).
//
// Two halves in one file, on purpose:
//   1. PURE: `parseMonth`, `toFigures`. No DB, no Nest: reads.service.test.ts drives them directly.
//   2. SQL helpers that take the caller's `PoolClient`, so every read runs inside the controller's one `withTenants([tenantId])` transaction
//      (ai_usage_events is FORCE RLS: an unset tenant GUC reads ZERO rows and reports success).
//
// WHAT AN ANSWER NEVER HOLDS. No text: the table has no column that could hold any, and these reads select ids, labels (surface, provider,
// model), counts and money only. `task` (a call-site label) is never selected. A person appears only in `people[]`, and only on the unit
// route for a caller who may see people (read_unit or read_people); the person route (`me`) filters `user_id = caller` in SQL.
//
// FIGURES. Every group answers the same `Figures`: calls; prompt and completion tokens (a SUM, `null` when no row in the group reported the
// figure: unknown is never 0); cost in USD as an exact decimal string (`null` when no row had a cost); and the honesty counts: how many calls
// were token ESTIMATES, how many had no tokens, how many had NO cost, and how many costs came from the provider or from our price table
// (AIP-D11). A partial sum is still a sum of what is known; `noCostCalls` says how much is missing.
//
// THE MONTH is the UTC calendar month (`REPORTS_TZ` is unset live, and ai_usage_daily's days are UTC days): `[YYYY-MM-01T00:00Z, next
// month)`. Days are UTC days, listed only when they have a row (a sparse series, oldest first).
//
// A UNIT counts its WHOLE SUBTREE: every row whose home node is a descendant of the unit in the per-tenant closure (org_unit_closure is
// self-inclusive, so the unit itself counts). A row's home node is `unit_node_id` (AIP-15a), or, for a row written before it, the node of its
// `org_unit_id` (org_units.node_id). A row with neither is "No department recorded".
import type { PoolClient } from "pg";
import { findOrgUnit } from "../reports/dept-kpis";

/** A refusal the controller maps to an HTTP exception. Pure data: no Nest import. */
export class UsageRuleError extends Error {
  constructor(
    readonly httpStatus: 400 | 404,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "UsageRuleError";
  }
}
export const unitNotFound = () => new UsageRuleError(404, "unit_not_found", "unitNodeId");

export interface UsageMonth {
  /** `YYYY-MM`. */
  month: string;
  /** Inclusive start, `YYYY-MM-01T00:00:00Z`. */
  start: string;
  /** Exclusive end: the first instant of the next month, UTC. */
  end: string;
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * PURE. `?month=YYYY-MM`, the UTC calendar month. Absent: the current UTC month (from `now`). Anything else is a 400 naming `month`: an empty
 * string, a repeated parameter (Fastify hands an array), a day (`2026-10-01`), a month outside 01 to 12, a year outside 1970 to 9998.
 * Called AFTER the authorization decision, so a refused caller always gets 403 and never learns that the month was invalid.
 */
export function parseMonth(raw: unknown, now: Date = new Date()): UsageMonth {
  let year: number;
  let month: number;
  if (raw === undefined) {
    year = now.getUTCFullYear();
    month = now.getUTCMonth() + 1;
  } else {
    const m = typeof raw === "string" ? MONTH_RE.exec(raw) : null;
    if (!m) throw new UsageRuleError(400, "month must be YYYY-MM (a UTC calendar month)", "month");
    year = Number(m[1]);
    month = Number(m[2]);
    if (year < 1970 || year > 9998) throw new UsageRuleError(400, "month must be YYYY-MM with a year from 1970 to 9998", "month");
  }
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  return {
    month: `${year}-${pad2(month)}`,
    start: `${year}-${pad2(month)}-01T00:00:00Z`,
    end: `${next.y}-${pad2(next.m)}-01T00:00:00Z`,
  };
}

/** One group's figures. Counts are whole numbers; a sum with nothing reported is `null` (unknown), never 0. */
export interface Figures {
  calls: number;
  promptTokens: number | null;
  completionTokens: number | null;
  /** USD as an exact decimal string (numeric(14,8) summed), or `null` when no call in the group had a cost. */
  costUsd: string | null;
  /** Calls whose token counts are a 4-characters-per-token estimate (tokens_source 'estimate'). */
  estimatedTokenCalls: number;
  /** Calls with no token counts at all (tokens_source 'none'). */
  noTokenCalls: number;
  /** Calls with no cost (cost_usd NULL): the part of `costUsd` that is unknown. */
  noCostCalls: number;
  /** Calls whose cost is the provider's own figure (cost_source 'provider', AIP-D11). */
  providerCostCalls: number;
  /** Calls whose cost our price table filled (cost_source 'table'). */
  tableCostCalls: number;
}

export interface FigureRow {
  calls: string | number;
  prompt_tokens: string | number | null;
  completion_tokens: string | number | null;
  cost_usd: string | null;
  estimated_token_calls: string | number;
  no_token_calls: string | number;
  no_cost_calls: string | number;
  provider_cost_calls: string | number;
  table_cost_calls: string | number;
}

const num = (v: string | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));
const count = (v: string | number | null | undefined): number => Number(v ?? 0);

/** PURE. A SQL figures row as an answer's `Figures`. bigint sums arrive as strings; they stay far below 2^53. */
export function toFigures(r: FigureRow): Figures {
  return {
    calls: count(r.calls),
    promptTokens: num(r.prompt_tokens),
    completionTokens: num(r.completion_tokens),
    costUsd: r.cost_usd ?? null,
    estimatedTokenCalls: count(r.estimated_token_calls),
    noTokenCalls: count(r.no_token_calls),
    noCostCalls: count(r.no_cost_calls),
    providerCostCalls: count(r.provider_cost_calls),
    tableCostCalls: count(r.table_cost_calls),
  };
}

export interface Capabilities {
  /** The caller may see per-person lines: on a unit, `read_unit` or `read_people`; elsewhere `read_people` (the owner, the superadmin). */
  canSeePeople: boolean;
  /** `manage`: budgets, allowances, lifting any stop (the owner, the superadmin). */
  canManage: boolean;
  /** On a unit: `manage` or `lift_stop` on that unit. Elsewhere: `manage` (lifting ANY stop). */
  canLiftStop: boolean;
}

// ── SQL ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The figures of a group of `s` (the scoped CTE below). */
const FIGS = `
  count(*)::bigint                                                AS calls,
  sum(s.prompt_tokens)::bigint                                    AS prompt_tokens,
  sum(s.completion_tokens)::bigint                                AS completion_tokens,
  sum(s.cost_usd)::text                                           AS cost_usd,
  (count(*) FILTER (WHERE s.tokens_source = 'estimate'))::bigint  AS estimated_token_calls,
  (count(*) FILTER (WHERE s.tokens_source = 'none'))::bigint      AS no_token_calls,
  (count(*) FILTER (WHERE s.cost_usd IS NULL))::bigint            AS no_cost_calls,
  (count(*) FILTER (WHERE s.cost_source = 'provider'))::bigint    AS provider_cost_calls,
  (count(*) FILTER (WHERE s.cost_source = 'table'))::bigint       AS table_cost_calls`;

/** Which rows a read sees. $1 tenant, $2 start, $3 end; `own` adds $4 the caller; `unit` adds $4 the unit node. */
export type UsageScope = { kind: "own"; userId: string } | { kind: "unit"; unitNodeId: string } | { kind: "company" };

/**
 * The scoped rows as a CTE body: the month's rows of the company, each with its HOME node (`unit_node_id`, else its org unit's node for a row
 * written before AIP-15a) and its UTC day. Only the columns a read needs are selected: never `task`, never a thread or run id.
 */
function scopedSql(scope: UsageScope): string {
  const where =
    scope.kind === "own"
      ? `AND e.user_id = $4::uuid`
      : scope.kind === "unit"
        ? `AND COALESCE(e.unit_node_id, ou.node_id) IN (SELECT cl.descendant_id FROM org_unit_closure cl WHERE cl.tenant_id = $1 AND cl.ancestor_id = $4)`
        : "";
  return `
    SELECT e.user_id, e.surface, e.provider, e.model, e.prompt_tokens, e.completion_tokens, e.tokens_source, e.cost_usd, e.cost_source,
           COALESCE(e.unit_node_id, ou.node_id) AS home_node,
           to_char((e.occurred_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day
      FROM ai_usage_events e
      LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     WHERE e.tenant_id = $1 AND e.occurred_at >= $2::timestamptz AND e.occurred_at < $3::timestamptz
       ${where}`;
}

function scopeParams(tenantId: string, month: UsageMonth, scope: UsageScope): unknown[] {
  const base: unknown[] = [tenantId, month.start, month.end];
  if (scope.kind === "own") base.push(scope.userId);
  if (scope.kind === "unit") base.push(scope.unitNodeId);
  return base;
}

/** One grouped read over the scoped rows. `cols` are the group's own columns; `filter` narrows `s`; `order` sorts. */
async function grouped<T extends Record<string, unknown>>(
  c: PoolClient,
  tenantId: string,
  month: UsageMonth,
  scope: UsageScope,
  q: { cols?: string; join?: string; filter?: string; groupBy?: string; order?: string },
): Promise<Array<T & FigureRow>> {
  const cols = q.cols ? `${q.cols},` : "";
  const { rows } = await c.query<T & FigureRow>(
    `WITH s AS (${scopedSql(scope)})
     SELECT ${cols} ${FIGS}
       FROM s ${q.join ?? ""}
      ${q.filter ? `WHERE ${q.filter}` : ""}
      ${q.groupBy ? `GROUP BY ${q.groupBy}` : ""}
      ${q.order ? `ORDER BY ${q.order}` : ""}`,
    scopeParams(tenantId, month, scope),
  );
  return rows;
}

export interface SurfaceLine extends Figures { surface: string }
export interface DayLine extends Figures { day: string }
export interface ModelLine extends Figures { provider: string | null; model: string | null }
export interface PersonLine extends Figures { userId: string; name: string | null }
export interface DepartmentLine extends Figures {
  /** The home org node, or `null` for "No department recorded" (rows with a person but no node: old rows, or no placement). */
  unitNodeId: string | null;
  /** The node's name in the company's org tree today, or `null` (the null bucket, or a node no longer in the tree). */
  name: string | null;
}

export async function readTotals(c: PoolClient, tenantId: string, month: UsageMonth, scope: UsageScope): Promise<Figures> {
  const rows = await grouped(c, tenantId, month, scope, {});
  return toFigures(rows[0]);
}

export async function readBySurface(c: PoolClient, tenantId: string, month: UsageMonth, scope: UsageScope, filter?: string): Promise<SurfaceLine[]> {
  const rows = await grouped<{ surface: string }>(c, tenantId, month, scope, { cols: "s.surface", filter, groupBy: "s.surface", order: `s.surface COLLATE "C"` });
  return rows.map((r) => ({ surface: r.surface, ...toFigures(r) }));
}

export async function readByDay(c: PoolClient, tenantId: string, month: UsageMonth, scope: UsageScope): Promise<DayLine[]> {
  const rows = await grouped<{ day: string }>(c, tenantId, month, scope, { cols: "s.day", groupBy: "s.day", order: "s.day" });
  return rows.map((r) => ({ day: r.day, ...toFigures(r) }));
}

export async function readByModel(c: PoolClient, tenantId: string, month: UsageMonth, scope: UsageScope): Promise<ModelLine[]> {
  const rows = await grouped<{ provider: string | null; model: string | null }>(c, tenantId, month, scope, {
    cols: "s.provider, s.model", groupBy: "s.provider, s.model", order: `s.provider COLLATE "C" NULLS LAST, s.model COLLATE "C" NULLS LAST`,
  });
  return rows.map((r) => ({ provider: r.provider ?? null, model: r.model ?? null, ...toFigures(r) }));
}

/** Per person (the scoped rows' people; a row whose person was erased counts in the totals, never as a person). Display name from `users`. */
export async function readPeople(c: PoolClient, tenantId: string, month: UsageMonth, scope: UsageScope): Promise<PersonLine[]> {
  const rows = await grouped<{ user_id: string; name: string | null }>(c, tenantId, month, scope, {
    cols: "s.user_id::text AS user_id, u.name", join: "JOIN users u ON u.id = s.user_id", groupBy: "s.user_id, u.name",
    order: `u.name COLLATE "C" NULLS LAST, s.user_id`,
  });
  return rows.map((r) => ({ userId: r.user_id, name: r.name ?? null, ...toFigures(r) }));
}

/**
 * Per home department, for the company view: every row that has a person or a node. Rows with a person and no node are the `null` bucket
 * ("No department recorded"). Rows with NEITHER a person nor a node (most knowledge embeds, jobs) are not here: `readNoPerson` lists them by
 * surface ("Company, no person"). Names come from the company's org tree.
 */
export async function readByDepartment(
  c: PoolClient,
  tenantId: string,
  month: UsageMonth,
  structure: unknown,
): Promise<DepartmentLine[]> {
  const rows = await grouped<{ home_node: string | null }>(c, tenantId, month, { kind: "company" }, {
    cols: "s.home_node", filter: "s.user_id IS NOT NULL OR s.home_node IS NOT NULL", groupBy: "s.home_node", order: `s.home_node COLLATE "C" NULLS LAST`,
  });
  return rows.map((r) => ({
    unitNodeId: r.home_node ?? null,
    name: r.home_node ? (findOrgUnit(structure, r.home_node)?.name ?? null) : null,
    ...toFigures(r),
  }));
}

/** The company's rows with no person AND no node, by surface ("Company, no person"). */
export function readNoPerson(c: PoolClient, tenantId: string, month: UsageMonth): Promise<SurfaceLine[]> {
  return readBySurface(c, tenantId, month, { kind: "company" }, "s.user_id IS NULL AND s.home_node IS NULL");
}

/** The unit's name in the company's org tree, or null. */
export function unitName(structure: unknown, unitNodeId: string): string | null {
  return findOrgUnit(structure, unitNodeId)?.name ?? null;
}
