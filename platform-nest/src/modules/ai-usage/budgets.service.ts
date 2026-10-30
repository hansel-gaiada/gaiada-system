// AIP-17b (docs/plans/2026-10-27-ai-plan.md §6.3 item 6; docs/FRONTEND-BFF-CONTRACT.md §66.4) — the stored side of AI budgets and per-person
// allowances: the SQL the routes and the reads share, and the body parsers. Every function takes the caller's `PoolClient`, so each runs inside
// the route's one `withTenants([tenantId])` transaction (the three tables are FORCE RLS: an unset GUC reads ZERO rows and reports success).
//
// WRITES AND THEIR ACTIVITY ROW. Every write that CHANGES something writes exactly one `activities` row on the same client, so the change and
// its audit commit or roll back together. The row names the scope, the unit or person and the figures (ids and numbers), never any text a
// person typed. A removal of something that was not there changed nothing and says nothing (the AIP-13b rule).
import type { PoolClient } from "pg";
import { newId } from "../../db";
import { config } from "../../config";
import { currentVia } from "../../core/request-context";
import { budgetFigure, MoneyError, parseMonthlyUsd, type BudgetFigure } from "./budgets";
import { readTotals, unitName, type UsageMonth } from "./reads.service";

// ── bodies ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const BUDGET_MODES = ["report", "soft_stop"] as const;
export type BudgetMode = (typeof BUDGET_MODES)[number];
export const MAX_DAILY_REPLIES = 100000;

/** A refusal the controller maps to 400. Pure data: no Nest import. */
export class BudgetBodyError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = "BudgetBodyError";
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw new BudgetBodyError(`unknown field: ${extra[0]}`, extra[0]);
}

/** PURE. `{ monthlyUsd: string | null }`: a figure, or null to remove it. */
export function parseCompanyBudgetBody(body: unknown): { monthlyUsd: string | null } {
  if (!isPlainObject(body)) throw new BudgetBodyError("the body must be an object", "body");
  rejectUnknownKeys(body, ["monthlyUsd"]);
  if (!("monthlyUsd" in body)) throw new BudgetBodyError("monthlyUsd is required (a decimal string, or null to remove it)", "monthlyUsd");
  return { monthlyUsd: parseFigure(body.monthlyUsd) };
}

/** PURE. `{ monthlyUsd: string | null, mode?: 'report' | 'soft_stop' }`. A `mode` with a null figure is refused: a removed budget has no mode. */
export function parseUnitBudgetBody(body: unknown): { monthlyUsd: string | null; mode: BudgetMode | undefined } {
  if (!isPlainObject(body)) throw new BudgetBodyError("the body must be an object", "body");
  rejectUnknownKeys(body, ["monthlyUsd", "mode"]);
  if (!("monthlyUsd" in body)) throw new BudgetBodyError("monthlyUsd is required (a decimal string, or null to remove it)", "monthlyUsd");
  const monthlyUsd = parseFigure(body.monthlyUsd);
  let mode: BudgetMode | undefined;
  if (body.mode !== undefined) {
    if (typeof body.mode !== "string" || !(BUDGET_MODES as readonly string[]).includes(body.mode)) {
      throw new BudgetBodyError(`mode must be one of ${BUDGET_MODES.join(", ")}`, "mode");
    }
    mode = body.mode as BudgetMode;
    if (monthlyUsd === null) throw new BudgetBodyError("mode needs a figure: a removed budget has no mode", "mode");
  }
  return { monthlyUsd, mode };
}

function parseFigure(raw: unknown): string | null {
  if (raw === null) return null;
  try {
    return parseMonthlyUsd(raw);
  } catch (e) {
    if (e instanceof MoneyError) throw new BudgetBodyError(e.message, e.field);
    throw e;
  }
}

/** PURE. `{ dailyReplies: number | null }`: a whole number from 1 to 100000, or null to remove the override. */
export function parseAllowanceBody(body: unknown): { dailyReplies: number | null } {
  if (!isPlainObject(body)) throw new BudgetBodyError("the body must be an object", "body");
  rejectUnknownKeys(body, ["dailyReplies"]);
  if (!("dailyReplies" in body)) throw new BudgetBodyError("dailyReplies is required (a whole number, or null to use the default)", "dailyReplies");
  const v = body.dailyReplies;
  if (v === null) return { dailyReplies: null };
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_DAILY_REPLIES) {
    throw new BudgetBodyError(`dailyReplies must be a whole number from 1 to ${MAX_DAILY_REPLIES}, or null`, "dailyReplies");
  }
  return { dailyReplies: v };
}

// ── reads: the budget lines ───────────────────────────────────────────────────────────────────────────────────────────────────────────

interface BudgetRow {
  scope: "company" | "unit";
  unit_node_id: string | null;
  monthly_usd: string;
  mode: BudgetMode | null;
  stop_lifted_month: string | null;
}

const BUDGET_COLS = `scope, unit_node_id, monthly_usd::text AS monthly_usd, mode, stop_lifted_month`;

/** One budget's month-to-date standing. Money as exact decimal strings; `noCostCalls` is the unknown part of `spentUsd`. */
export interface BudgetLine extends BudgetFigure {
  monthlyUsd: string;
  /** Month-to-date cost of the scope (the unit's whole subtree), or `null` when no call in it had a cost. */
  spentUsd: string | null;
  /** Calls in the scope with no cost: money nobody knows, never counted in `spentUsd`. */
  noCostCalls: number;
}
export interface UnitBudgetLine extends BudgetLine {
  unitNodeId: string;
  name: string | null;
  mode: BudgetMode;
  /** The stop was lifted for the month the answer is about (AIP-18 writes it; false until then). */
  stopLifted: boolean;
}
export interface BudgetsView {
  company: BudgetLine | null;
  units: UnitBudgetLine[];
}

async function companyLine(c: PoolClient, tenantId: string, month: UsageMonth, row: BudgetRow): Promise<BudgetLine> {
  const totals = await readTotals(c, tenantId, month, { kind: "company" });
  return { monthlyUsd: row.monthly_usd, spentUsd: totals.costUsd, noCostCalls: totals.noCostCalls, ...budgetFigure(totals.costUsd, row.monthly_usd) };
}

async function unitLine(c: PoolClient, tenantId: string, month: UsageMonth, structure: unknown, row: BudgetRow): Promise<UnitBudgetLine> {
  const unitNodeId = row.unit_node_id as string;
  const totals = await readTotals(c, tenantId, month, { kind: "unit", unitNodeId });
  return {
    unitNodeId,
    name: unitName(structure, unitNodeId),
    monthlyUsd: row.monthly_usd,
    mode: (row.mode ?? "report") as BudgetMode,
    spentUsd: totals.costUsd,
    noCostCalls: totals.noCostCalls,
    ...budgetFigure(totals.costUsd, row.monthly_usd),
    stopLifted: row.stop_lifted_month === month.month,
  };
}

/** The company view's `budgets`: the company figure and every department's budget, with the month's standing. */
export async function readBudgets(c: PoolClient, tenantId: string, month: UsageMonth, structure: unknown): Promise<BudgetsView> {
  const { rows } = await c.query<BudgetRow>(
    `SELECT ${BUDGET_COLS} FROM ai_budgets WHERE tenant_id = $1 ORDER BY scope, unit_node_id COLLATE "C"`,
    [tenantId],
  );
  const companyRow = rows.find((r) => r.scope === "company");
  const out: BudgetsView = { company: companyRow ? await companyLine(c, tenantId, month, companyRow) : null, units: [] };
  for (const r of rows) if (r.scope === "unit") out.units.push(await unitLine(c, tenantId, month, structure, r));
  return out;
}

/** The unit view's `budget`: that unit's own budget with the month's standing, or null when it has none. */
export async function readUnitBudget(
  c: PoolClient,
  tenantId: string,
  month: UsageMonth,
  structure: unknown,
  unitNodeId: string,
): Promise<UnitBudgetLine | null> {
  const { rows } = await c.query<BudgetRow>(
    `SELECT ${BUDGET_COLS} FROM ai_budgets WHERE tenant_id = $1 AND scope = 'unit' AND unit_node_id = $2`,
    [tenantId, unitNodeId],
  );
  return rows[0] ? unitLine(c, tenantId, month, structure, rows[0]) : null;
}

// ── writes ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One audit row on the caller's client (same transaction). Ids and figures only. */
async function activity(
  c: PoolClient,
  tenantId: string,
  actorId: string,
  verb: string,
  entityType: string,
  entityId: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  const via = currentVia();
  await c.query(
    `INSERT INTO activities (id, tenant_id, actor_id, verb, target_entity_type, target_entity_id, metadata, origin_site)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [newId(), tenantId, actorId, verb, entityType, entityId, JSON.stringify(via && metadata.via === undefined ? { ...metadata, via } : metadata), config.originSite],
  );
}

export interface BudgetWriteResult {
  /** The stored figure after the write, or null when the budget does not exist (removed, or never was). */
  monthlyUsd: string | null;
  mode: BudgetMode | null;
  changed: boolean;
}

/** Set (`monthlyUsd` a figure) or remove (null) the company's alert figure. */
export async function putCompanyBudget(c: PoolClient, tenantId: string, actorId: string, monthlyUsd: string | null): Promise<BudgetWriteResult> {
  const prev = await c.query<{ monthly_usd: string }>(
    `SELECT monthly_usd::text AS monthly_usd FROM ai_budgets WHERE tenant_id = $1 AND scope = 'company'`,
    [tenantId],
  );
  const previous = prev.rows[0]?.monthly_usd ?? null;
  if (monthlyUsd === null) {
    if (previous === null) return { monthlyUsd: null, mode: null, changed: false };
    await c.query(`DELETE FROM ai_budgets WHERE tenant_id = $1 AND scope = 'company'`, [tenantId]);
    await activity(c, tenantId, actorId, "removed", "ai_budget", null, { scope: "company", previousMonthlyUsd: previous });
    return { monthlyUsd: null, mode: null, changed: true };
  }
  const { rows } = await c.query<{ monthly_usd: string }>(
    `INSERT INTO ai_budgets (tenant_id, scope, unit_node_id, monthly_usd, mode, updated_by, updated_at)
     VALUES ($1, 'company', NULL, $2::numeric, NULL, $3, now())
     ON CONFLICT (tenant_id) WHERE scope = 'company'
     DO UPDATE SET monthly_usd = EXCLUDED.monthly_usd, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING monthly_usd::text AS monthly_usd`,
    [tenantId, monthlyUsd, actorId],
  );
  await activity(c, tenantId, actorId, previous === null ? "created" : "updated", "ai_budget", null, {
    scope: "company", monthlyUsd: rows[0].monthly_usd, previousMonthlyUsd: previous,
  });
  return { monthlyUsd: rows[0].monthly_usd, mode: null, changed: true };
}

/**
 * Set or remove one department's budget. `mode` omitted keeps the stored mode, or is 'report' on a new row (AIP-D7). The caller has already
 * checked the unit is a node of this company's org tree.
 */
export async function putUnitBudget(
  c: PoolClient,
  tenantId: string,
  actorId: string,
  unitNodeId: string,
  monthlyUsd: string | null,
  mode: BudgetMode | undefined,
): Promise<BudgetWriteResult> {
  const prev = await c.query<{ monthly_usd: string; mode: BudgetMode }>(
    `SELECT monthly_usd::text AS monthly_usd, mode FROM ai_budgets WHERE tenant_id = $1 AND scope = 'unit' AND unit_node_id = $2`,
    [tenantId, unitNodeId],
  );
  const previous = prev.rows[0] ?? null;
  if (monthlyUsd === null) {
    if (previous === null) return { monthlyUsd: null, mode: null, changed: false };
    await c.query(`DELETE FROM ai_budgets WHERE tenant_id = $1 AND scope = 'unit' AND unit_node_id = $2`, [tenantId, unitNodeId]);
    await activity(c, tenantId, actorId, "removed", "ai_budget", null, {
      scope: "unit", unitNodeId, previousMonthlyUsd: previous.monthly_usd, previousMode: previous.mode,
    });
    return { monthlyUsd: null, mode: null, changed: true };
  }
  const { rows } = await c.query<{ monthly_usd: string; mode: BudgetMode }>(
    `INSERT INTO ai_budgets (tenant_id, scope, unit_node_id, monthly_usd, mode, updated_by, updated_at)
     VALUES ($1, 'unit', $2, $3::numeric, COALESCE($4::text, 'report'), $5, now())
     ON CONFLICT (tenant_id, unit_node_id) WHERE scope = 'unit'
     DO UPDATE SET monthly_usd = EXCLUDED.monthly_usd, mode = COALESCE($4::text, ai_budgets.mode), updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING monthly_usd::text AS monthly_usd, mode`,
    [tenantId, unitNodeId, monthlyUsd, mode ?? null, actorId],
  );
  await activity(c, tenantId, actorId, previous === null ? "created" : "updated", "ai_budget", null, {
    scope: "unit", unitNodeId, monthlyUsd: rows[0].monthly_usd, mode: rows[0].mode,
    previousMonthlyUsd: previous?.monthly_usd ?? null, previousMode: previous?.mode ?? null,
  });
  return { monthlyUsd: rows[0].monthly_usd, mode: rows[0].mode, changed: true };
}

// ── allowances ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AllowanceLine {
  userId: string;
  name: string | null;
  dailyReplies: number;
  updatedAt: string;
}

/** The overrides of the company, with names, sorted by name. A person with no row is on the default (not listed). */
export async function readAllowances(c: PoolClient, tenantId: string): Promise<AllowanceLine[]> {
  const { rows } = await c.query<{ user_id: string; name: string | null; daily_replies: number; updated_at: Date }>(
    `SELECT a.user_id::text AS user_id, u.name, a.daily_replies, a.updated_at
       FROM ai_person_allowances a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.tenant_id = $1
      ORDER BY u.name COLLATE "C" NULLS LAST, a.user_id`,
    [tenantId],
  );
  return rows.map((r) => ({ userId: r.user_id, name: r.name ?? null, dailyReplies: r.daily_replies, updatedAt: r.updated_at.toISOString() }));
}

/** An ACTIVE member of this company (a person with a live membership row): the only kind of person an allowance may name. */
export async function isActiveMember(c: PoolClient, tenantId: string, userId: string): Promise<boolean> {
  const { rows } = await c.query(
    `SELECT 1 FROM company_memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' AND deleted_at IS NULL`,
    [tenantId, userId],
  );
  return rows.length > 0;
}

export interface AllowanceWriteResult {
  dailyReplies: number | null;
  changed: boolean;
}

/** Set (`dailyReplies` a number) or remove (null: back to the default) one person's allowance. */
export async function putAllowance(c: PoolClient, tenantId: string, actorId: string, userId: string, dailyReplies: number | null): Promise<AllowanceWriteResult> {
  const prev = await c.query<{ daily_replies: number }>(
    `SELECT daily_replies FROM ai_person_allowances WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  );
  const previous = prev.rows[0]?.daily_replies ?? null;
  if (dailyReplies === null) {
    if (previous === null) return { dailyReplies: null, changed: false };
    await c.query(`DELETE FROM ai_person_allowances WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
    await activity(c, tenantId, actorId, "removed", "ai_allowance", userId, { previousDailyReplies: previous });
    return { dailyReplies: null, changed: true };
  }
  await c.query(
    `INSERT INTO ai_person_allowances (tenant_id, user_id, daily_replies, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET daily_replies = EXCLUDED.daily_replies, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [tenantId, userId, dailyReplies, actorId],
  );
  await activity(c, tenantId, actorId, previous === null ? "created" : "updated", "ai_allowance", userId, { dailyReplies, previousDailyReplies: previous });
  return { dailyReplies, changed: true };
}
