// SCP-4a — the money core of boosts and the monthly boost budget: the rules, the cycle lock and the reads (BFF §63.11; §63.1 file 7;
// fixture `boosts` and `boostBudgets`; plan rulings SCP-Q11, SCP-Q15).
//
// NO ADS ARE BOUGHT BY THE ERP (§63.11). Nothing in this file, or in boosts.ts that writes the rows, spends money, buys an ad or calls
// any network: a boost RECORDS what the team runs in Meta's own tools (or the simulator runs), and the estimate is arithmetic.
//
// THE RULES (pure, pinned in boosts.test.ts):
//   committed (SCP-Q15)  over the cycle's boosts: the full budget (`total_budget_minor`) of each `approved` or `running` boost, the actual
//                        spend (`spend_minor`) of each `stopped` or `completed` one, nothing for `requested`, `cancelled` or `declined`
//                        (the fixture's `committedBy`).
//   remaining            the cycle's agreed budget minus committed, shown as 0 when below; 0 with no cycle or no agreed budget.
//   fits                 a request fits when its total is at most `agreed - committed` (the raw difference, never the clamped one).
//
// THE CYCLE LOCK. Every write that moves `committed` or the agreement (a boost request, an approval in the portal or recorded, a start, a
// stop, a completion, a cancellation, a decline, a proposal, an agreement, a recording, a withdrawal) runs `lockBoostCycle` FIRST in its
// transaction, BEFORE it reads committed or the agreement, and only then reads its own row `FOR UPDATE`. It is a transaction-scoped
// advisory lock (`pg_advisory_xact_lock`, released at COMMIT or ROLLBACK) keyed on a namespaced 64-bit hash of the cycle id alone. The key
// is the id carried by the PLAIN-walled money rows (`social_boosts.cycle_id`, `social_boost_budgets.cycle_id`), so the portal path takes
// the very same lock without ever reading the third-walled `social_cycles`. Under READ COMMITTED each statement after the lock sees every
// write the previous holder committed, so two writers can never both take the last of a budget. Lock order is always: the cycle lock, then
// row locks; a stage action on the post never takes a cycle lock, so no cycle of waits can form.
//
// THE WALL. `social_boosts` and `social_boost_budgets` take the plain tenant wall (the portal writes them). The joins to `social_posts`,
// `social_cycles` and `social_post_designs` here need the social module scope: every caller's transaction declares it (`{ modules:
// ["social"] }` or `declareSocialModuleScope`).
import type { PoolClient } from "pg";
import { declareSocialModuleScope } from "../module-scope";
import { AVERAGE_WINDOW_DAYS, DEFAULT_BOOST_FACTOR, isBoostCandidate, meanRate, postRate, round6, type MetricSource, type Snapshot } from "./post-metrics";

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The vocabulary (the fixture's and §63.1 file 7's)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export const BOOST_STATUSES = ["requested", "approved", "running", "stopped", "completed", "cancelled", "declined"] as const;
export type BoostStatus = (typeof BOOST_STATUSES)[number];
/** The statuses `ux_social_boosts_open_post` counts: at most one per post. */
export const OPEN_BOOST_STATUSES: readonly BoostStatus[] = ["requested", "approved", "running"];
export const BOOST_GOALS = ["profile_visits", "website", "messages"] as const;
export const BOOST_AUDIENCES = ["automatic", "local", "custom"] as const;
export const BUDGET_STATUSES = ["pending", "agreed", "declined", "withdrawn", "superseded"] as const;
export type BudgetStatus = (typeof BUDGET_STATUSES)[number];
/** How a client's answer given outside the portal came (as `social_post_client_reviews.channel`). */
export const RECORD_CHANNELS = ["whatsapp", "email", "meeting"] as const;
/** §63.0: no amount exceeds 10^12. */
export const MAX_MINOR = 1_000_000_000_000;
export const MAX_INT = 2_147_483_647;
export const DEFAULT_CURRENCY = "IDR";

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The rules (pure)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** PURE. What one boost commits of its cycle's budget (the fixture's `committedBy`). */
export function committedBy(status: string, totalMinor: number, spendMinor: number | null): number {
  if (status === "approved" || status === "running") return totalMinor;
  if (status === "stopped" || status === "completed") return spendMinor ?? 0;
  return 0;
}

/** PURE. A cycle's committed: the sum of `committedBy` over its boosts. */
export function committedOf(boosts: ReadonlyArray<{ status: string; totalMinor: number; spendMinor: number | null }>): number {
  return boosts.reduce((n, b) => n + committedBy(b.status, b.totalMinor, b.spendMinor), 0);
}

/** PURE. What remains to show: agreed − committed, never below 0; 0 with no agreed budget. */
export function remainingOf(agreedMinor: number | null, committedMinor: number): number {
  if (agreedMinor === null) return 0;
  return Math.max(0, agreedMinor - committedMinor);
}

/** PURE. Whether a boost of `totalMinor` fits what remains: only with an agreed budget, against the raw difference. */
export function fitsRemaining(agreedMinor: number | null, committedMinor: number, totalMinor: number): boolean {
  return agreedMinor !== null && totalMinor <= agreedMinor - committedMinor;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The cycle lock
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** The namespace of the lock key: no other advisory lock in the codebase hashes a string with this prefix. */
export const BOOST_CYCLE_LOCK_NAMESPACE = "scp4:social_boost_cycle:";

/**
 * Take the cycle's money lock for the rest of the caller's transaction (header). Call it FIRST, before reading committed, the agreement
 * or the row being changed. Blocks until a concurrent holder commits or rolls back. A boost with no cycle has no budget to protect and
 * takes no lock (its own row lock and `ux_social_boosts_open_post` are enough).
 */
export async function lockBoostCycle(c: PoolClient, cycleId: string | null): Promise<void> {
  if (!cycleId) return;
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [`${BOOST_CYCLE_LOCK_NAMESPACE}${cycleId.toLowerCase()}`]);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Currency
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** The SQL for a currency's minor digits (`finance_currencies`, global reference data); IDR is 0, an unknown code 2. */
export const minorUnitSql = (col: string) =>
  `COALESCE((SELECT fc.minor_unit FROM finance_currencies fc WHERE fc.code = ${col}::text), CASE WHEN ${col}::text = 'IDR' THEN 0 ELSE 2 END)::int`;

export async function minorUnitOf(c: PoolClient, currency: string): Promise<number> {
  const r = await c.query<{ mu: number }>(`SELECT ${minorUnitSql("$1")} AS mu`, [currency]);
  return Number(r.rows[0]?.mu ?? 2);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// A cycle's money
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface BudgetRow {
  id: string;
  clientId: string;
  cycleId: string;
  amountMinor: number;
  currency: string;
  status: BudgetStatus;
  requestedBy: string;
  requestedAt: string;
  requestNote: string | null;
  decidedVia: "portal" | "recorded" | null;
  decidedBy: string | null;
  recordedBy: string | null;
  channel: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
}

const BUDGET_COLUMNS = `b.id::text AS id, b.client_id::text AS client_id, b.cycle_id::text AS cycle_id, b.amount_minor::text AS amount_minor,
  b.currency::text AS currency, b.status, b.requested_by::text AS requested_by, b.requested_at, b.request_note, b.decided_via,
  b.decided_by::text AS decided_by, b.recorded_by::text AS recorded_by, b.channel, b.decision_note, b.decided_at`;

interface BudgetDbRow {
  id: string; client_id: string; cycle_id: string; amount_minor: string; currency: string; status: BudgetStatus; requested_by: string;
  requested_at: Date; request_note: string | null; decided_via: "portal" | "recorded" | null; decided_by: string | null; recorded_by: string | null;
  channel: string | null; decision_note: string | null; decided_at: Date | null;
}

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

const budgetOf = (r: BudgetDbRow): BudgetRow => ({
  id: r.id, clientId: r.client_id, cycleId: r.cycle_id, amountMinor: Number(r.amount_minor), currency: r.currency, status: r.status,
  requestedBy: r.requested_by, requestedAt: iso(r.requested_at)!, requestNote: r.request_note, decidedVia: r.decided_via, decidedBy: r.decided_by,
  recordedBy: r.recorded_by, channel: r.channel, decisionNote: r.decision_note, decidedAt: iso(r.decided_at),
});

/** One budget row by id in the tenant (plain wall: readable on the portal path), `FOR UPDATE` when asked. */
export async function loadBudget(c: PoolClient, tenantId: string, id: string, lock = false): Promise<BudgetRow | null> {
  const r = await c.query<BudgetDbRow>(
    `SELECT ${BUDGET_COLUMNS} FROM social_boost_budgets b WHERE b.tenant_id = $1 AND b.id = $2 ${lock ? "FOR UPDATE" : ""}`, [tenantId, id]);
  return r.rows[0] ? budgetOf(r.rows[0]) : null;
}

/** Every budget row of a cycle, newest first. */
export async function loadCycleBudgets(c: PoolClient, tenantId: string, cycleId: string): Promise<BudgetRow[]> {
  const r = await c.query<BudgetDbRow>(
    `SELECT ${BUDGET_COLUMNS} FROM social_boost_budgets b WHERE b.tenant_id = $1 AND b.cycle_id = $2 ORDER BY b.requested_at DESC, b.id DESC`,
    [tenantId, cycleId]);
  return r.rows.map(budgetOf);
}

export interface CycleMoney {
  agreed: BudgetRow | null;
  pending: BudgetRow | null;
  committedMinor: number;
  remainingMinor: number;
  /** The cycle's budget currency: the agreement's, else the pending proposal's, else IDR. */
  currency: string;
}

/** The cycle's agreed budget, its pending proposal and its committed (one read each). Under the lock when the caller writes. */
export async function readCycleMoney(c: PoolClient, tenantId: string, cycleId: string): Promise<CycleMoney> {
  const r = await c.query<BudgetDbRow>(
    `SELECT ${BUDGET_COLUMNS} FROM social_boost_budgets b WHERE b.tenant_id = $1 AND b.cycle_id = $2 AND b.status IN ('agreed','pending')`,
    [tenantId, cycleId]);
  const rows = r.rows.map(budgetOf);
  const agreed = rows.find((x) => x.status === "agreed") ?? null;
  const pending = rows.find((x) => x.status === "pending") ?? null;
  const committedMinor = await readCommitted(c, tenantId, cycleId);
  return { agreed, pending, committedMinor, remainingMinor: remainingOf(agreed?.amountMinor ?? null, committedMinor), currency: agreed?.currency ?? pending?.currency ?? DEFAULT_CURRENCY };
}

/** `committed` of one cycle, summed in SQL by the same rule as `committedBy`. */
export async function readCommitted(c: PoolClient, tenantId: string, cycleId: string): Promise<number> {
  const r = await c.query<{ n: string }>(
    `SELECT COALESCE(SUM(CASE WHEN status IN ('approved','running') THEN total_budget_minor
                              WHEN status IN ('stopped','completed') THEN COALESCE(spend_minor, 0)
                              ELSE 0 END), 0)::text AS n
       FROM social_boosts WHERE tenant_id = $1 AND cycle_id = $2`,
    [tenantId, cycleId]);
  return Number(r.rows[0]?.n ?? 0);
}

/** The budget cycle of a boost: the engagement's live cycle whose month is the first of `startsOn`'s month, or null. Needs the module scope. */
export async function budgetCycleFor(c: PoolClient, tenantId: string, engagementId: string, startsOn: string): Promise<string | null> {
  await declareSocialModuleScope(c);
  const r = await c.query<{ id: string }>(
    `SELECT id::text AS id FROM social_cycles
      WHERE tenant_id = $1 AND engagement_id = $2 AND deleted_at IS NULL AND month = date_trunc('month', $3::date::timestamp)::date`,
    [tenantId, engagementId, startsOn]);
  return r.rows[0]?.id ?? null;
}

/** The engagement a cycle belongs to, deleted cycles included (a withdrawal of an old proposal still needs its gate). Needs the module scope. */
export async function cycleEngagement(c: PoolClient, tenantId: string, cycleId: string, liveOnly = false): Promise<{ engagementId: string; month: string } | null> {
  await declareSocialModuleScope(c);
  const r = await c.query<{ engagement_id: string; month: string }>(
    `SELECT engagement_id::text AS engagement_id, to_char(month, 'YYYY-MM') AS month FROM social_cycles
      WHERE tenant_id = $1 AND id = $2 ${liveOnly ? "AND deleted_at IS NULL" : ""}`,
    [tenantId, cycleId]);
  return r.rows[0] ? { engagementId: r.rows[0].engagement_id, month: r.rows[0].month } : null;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Boost rows and BoostRow (the UI's shape, §63.11)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** §63.11 `BoostRow`. Money in minor units of `currency`. */
export interface BoostRow {
  id: string;
  postId: string;
  postTitle: string | null;
  clientName: string;
  cycleId: string | null;
  status: BoostStatus;
  goal: string;
  audience: string;
  audienceNote: string | null;
  dailyBudgetMinor: number;
  days: number;
  totalBudgetMinor: number;
  currency: string;
  minorUnit: number;
  startsOn: string;
  approvedVia: "budget" | "portal" | "recorded" | null;
  approvedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  spendMinor: number | null;
  paidReach: number | null;
  clicks: number | null;
  reachEstimate: { low: number; high: number } | null;
  simulated: boolean;
}

/** The raw facts of one boost the writers need (no joins). */
export interface RawBoost {
  id: string;
  postId: string;
  clientId: string;
  cycleId: string | null;
  status: BoostStatus;
  totalMinor: number;
  currency: string;
  spendMinor: number | null;
  approvedVia: "budget" | "portal" | "recorded" | null;
  declinedAt: string | null;
  requestedBy: string;
  simulated: boolean;
}

interface RawDbRow {
  id: string; post_id: string; client_id: string; cycle_id: string | null; status: BoostStatus; total_budget_minor: string; currency: string;
  spend_minor: string | null; approved_via: RawBoost["approvedVia"]; declined_at: Date | null; requested_by: string; simulated: boolean;
}

/** One boost's raw facts by id (plain wall), `FOR UPDATE` when asked. */
export async function loadRawBoost(c: PoolClient, tenantId: string, boostId: string, lock = false): Promise<RawBoost | null> {
  const r = await c.query<RawDbRow>(
    `SELECT id::text AS id, post_id::text AS post_id, client_id::text AS client_id, cycle_id::text AS cycle_id, status,
            total_budget_minor::text AS total_budget_minor, currency::text AS currency, spend_minor::text AS spend_minor, approved_via,
            declined_at, requested_by::text AS requested_by, simulated
       FROM social_boosts WHERE tenant_id = $1 AND id = $2 ${lock ? "FOR UPDATE" : ""}`,
    [tenantId, boostId]);
  const x = r.rows[0];
  if (!x) return null;
  return {
    id: x.id, postId: x.post_id, clientId: x.client_id, cycleId: x.cycle_id, status: x.status, totalMinor: Number(x.total_budget_minor),
    currency: x.currency, spendMinor: x.spend_minor === null ? null : Number(x.spend_minor), approvedVia: x.approved_via,
    declinedAt: iso(x.declined_at), requestedBy: x.requested_by, simulated: x.simulated,
  };
}

/** The SELECT list behind `boostRowOf`, over `social_boosts b` joined to the post `p` (LEFT: the post may be gone) and the client `cl`. */
const BOOST_ROW_SELECT = `
  SELECT b.id::text AS id, b.post_id::text AS post_id, p.title AS post_title, cl.name AS client_name, b.cycle_id::text AS cycle_id, b.status,
         b.goal, b.audience, b.audience_note, b.daily_budget_minor::text AS daily_budget_minor, b.days, b.total_budget_minor::text AS total_budget_minor,
         b.currency::text AS currency, ${minorUnitSql("b.currency")} AS minor_unit, b.starts_on::text AS starts_on, b.approved_via, b.approved_at,
         b.started_at, b.ended_at, b.spend_minor::text AS spend_minor, b.paid_reach, b.clicks, b.reach_estimate_low, b.reach_estimate_high,
         b.simulated, b.requested_at,
         to_char(b.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS requested_at_key
    FROM social_boosts b
    LEFT JOIN social_posts p ON p.tenant_id = b.tenant_id AND p.id = b.post_id
    JOIN clients cl ON cl.id = b.client_id AND cl.tenant_id = b.tenant_id`;

export interface BoostDbRow {
  id: string; post_id: string; post_title: string | null; client_name: string; cycle_id: string | null; status: BoostStatus; goal: string;
  audience: string; audience_note: string | null; daily_budget_minor: string; days: number; total_budget_minor: string; currency: string;
  minor_unit: number; starts_on: string; approved_via: BoostRow["approvedVia"]; approved_at: Date | null; started_at: Date | null;
  ended_at: Date | null; spend_minor: string | null; paid_reach: number | null; clicks: number | null; reach_estimate_low: number | null;
  reach_estimate_high: number | null; simulated: boolean; requested_at: Date; requested_at_key: string;
}

/** PURE. The UI's `BoostRow` (§63.11) from one joined row. */
export function boostRowOf(r: BoostDbRow): BoostRow {
  return {
    id: r.id, postId: r.post_id, postTitle: r.post_title, clientName: r.client_name, cycleId: r.cycle_id, status: r.status, goal: r.goal,
    audience: r.audience, audienceNote: r.audience_note, dailyBudgetMinor: Number(r.daily_budget_minor), days: Number(r.days),
    totalBudgetMinor: Number(r.total_budget_minor), currency: r.currency, minorUnit: Number(r.minor_unit), startsOn: r.starts_on,
    approvedVia: r.approved_via, approvedAt: iso(r.approved_at), startedAt: iso(r.started_at), endedAt: iso(r.ended_at),
    spendMinor: r.spend_minor === null ? null : Number(r.spend_minor), paidReach: r.paid_reach, clicks: r.clicks,
    reachEstimate: r.reach_estimate_low !== null && r.reach_estimate_high !== null ? { low: r.reach_estimate_low, high: r.reach_estimate_high } : null,
    simulated: r.simulated,
  };
}

/** One boost as a `BoostRow`, or null. Needs the module scope (the post's title). */
export async function readBoostRow(c: PoolClient, tenantId: string, boostId: string): Promise<BoostRow | null> {
  await declareSocialModuleScope(c);
  const r = await c.query<BoostDbRow>(`${BOOST_ROW_SELECT} WHERE b.tenant_id = $1 AND b.id = $2`, [tenantId, boostId]);
  return r.rows[0] ? boostRowOf(r.rows[0]) : null;
}

/** The pipeline post read's `boost` (§63.6.2): the post's open boost, else its newest, else null. Needs the module scope. */
export async function readPostBoost(c: PoolClient, tenantId: string, postId: string): Promise<BoostRow | null> {
  await declareSocialModuleScope(c);
  const r = await c.query<BoostDbRow>(
    `${BOOST_ROW_SELECT} WHERE b.tenant_id = $1 AND b.post_id = $2
      ORDER BY (b.status IN ('requested','approved','running')) DESC, b.requested_at DESC, b.id DESC LIMIT 1`,
    [tenantId, postId]);
  return r.rows[0] ? boostRowOf(r.rows[0]) : null;
}

export interface BoostListFilter {
  status?: BoostStatus;
  engagementId?: string;
  cycleId?: string;
  /** The cursor's position: rows strictly older than this (requested_at, id). */
  after?: { at: string; id: string };
  limit: number;
}

/** The Boosting list's page, newest request first (`limit + 1` rows read, so the caller knows whether there is more). */
export async function listBoosts(c: PoolClient, tenantId: string, f: BoostListFilter): Promise<{ rows: BoostRow[]; keys: Array<{ at: string; id: string }> }> {
  await declareSocialModuleScope(c);
  const r = await c.query<BoostDbRow>(
    `${BOOST_ROW_SELECT}
      WHERE b.tenant_id = $1
        AND ($2::text IS NULL OR b.status = $2)
        AND ($3::uuid IS NULL OR p.engagement_id = $3)
        AND ($4::uuid IS NULL OR b.cycle_id = $4)
        AND ($5::timestamptz IS NULL OR (b.requested_at, b.id) < ($5::timestamptz, $6::uuid))
      ORDER BY b.requested_at DESC, b.id DESC
      LIMIT $7`,
    [tenantId, f.status ?? null, f.engagementId ?? null, f.cycleId ?? null, f.after?.at ?? null, f.after?.id ?? null, f.limit + 1]);
  return { rows: r.rows.map(boostRowOf), keys: r.rows.map((x) => ({ at: x.requested_at_key, id: x.id })) };
}

/** The Boosting list's `totals` over the same filter (no cursor): committed by the rule and the spend, in the most used currency. */
export async function boostTotals(c: PoolClient, tenantId: string, f: Omit<BoostListFilter, "after" | "limit">): Promise<{ committedMinor: number; spendMinor: number; currency: string }> {
  await declareSocialModuleScope(c);
  const r = await c.query<{ currency: string; committed: string; spend: string; n: string }>(
    `SELECT b.currency::text AS currency,
            COALESCE(SUM(CASE WHEN b.status IN ('approved','running') THEN b.total_budget_minor
                              WHEN b.status IN ('stopped','completed') THEN COALESCE(b.spend_minor, 0) ELSE 0 END), 0)::text AS committed,
            COALESCE(SUM(b.spend_minor), 0)::text AS spend, count(*)::text AS n
       FROM social_boosts b
       LEFT JOIN social_posts p ON p.tenant_id = b.tenant_id AND p.id = b.post_id
      WHERE b.tenant_id = $1 AND ($2::text IS NULL OR b.status = $2) AND ($3::uuid IS NULL OR p.engagement_id = $3) AND ($4::uuid IS NULL OR b.cycle_id = $4)
      GROUP BY b.currency ORDER BY count(*) DESC, b.currency LIMIT 1`,
    [tenantId, f.status ?? null, f.engagementId ?? null, f.cycleId ?? null]);
  const x = r.rows[0];
  return x ? { committedMinor: Number(x.committed), spendMinor: Number(x.spend), currency: x.currency } : { committedMinor: 0, spendMinor: 0, currency: DEFAULT_CURRENCY };
}

/** Needs you (§63.7, the HoD and GM): boosts `approved` but not started, oldest approval first. Needs the module scope. */
export async function readBoostsToStart(c: PoolClient, tenantId: string, max: number): Promise<Array<{ id: string; postId: string; title: string; clientName: string; since: string; startsOn: string }>> {
  await declareSocialModuleScope(c);
  const r = await c.query<{ id: string; post_id: string; title: string | null; client_name: string; approved_at: Date; starts_on: string }>(
    `SELECT b.id::text AS id, b.post_id::text AS post_id, p.title, cl.name AS client_name, b.approved_at, b.starts_on::text AS starts_on
       FROM social_boosts b
       JOIN social_posts p ON p.tenant_id = b.tenant_id AND p.id = b.post_id AND p.deleted_at IS NULL
       JOIN clients cl ON cl.id = b.client_id AND cl.tenant_id = b.tenant_id
      WHERE b.tenant_id = $1 AND b.status = 'approved' AND b.started_at IS NULL
      ORDER BY b.approved_at, b.id LIMIT $2`,
    [tenantId, max]);
  return r.rows.map((x) => ({ id: x.id, postId: x.post_id, title: x.title ?? "Untitled post", clientName: x.client_name, since: iso(x.approved_at)!, startsOn: x.starts_on }));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Boost candidates (the Boosting list): post-metrics.ts's rule, never re-derived
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface BoostCandidate { postId: string; clientName: string; title: string; engagementRate: number | null; accountAverageRate: number | null }

/**
 * Live pipeline posts that are boost candidates by post-metrics.ts's rule (`isBoostCandidate` of the post's rate against the mean rate of the
 * same engagement's OTHER live posts of the last 90 days, at the company's factor) and have no open boost. Considered: live, unarchived,
 * undeleted pipeline posts that went live in the same 90-day window the average uses. Highest rate first, at most `max`.
 */
export async function readBoostCandidates(c: PoolClient, tenantId: string, engagementId: string | null, max: number): Promise<BoostCandidate[]> {
  await declareSocialModuleScope(c);
  const windowStart = new Date(Date.now() - AVERAGE_WINDOW_DAYS * 86_400_000);
  const settings = await c.query<{ factor: string }>(`SELECT boost_candidate_factor::text AS factor FROM social_settings WHERE tenant_id = $1`, [tenantId]);
  const factor = settings.rows[0] ? Number(settings.rows[0].factor) : DEFAULT_BOOST_FACTOR;
  const { rows } = await c.query<{
    post_id: string; engagement_id: string; title: string | null; client_name: string; open_boost: boolean;
    reach: number | null; impressions: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null;
    video_views: number | null; clicks: number | null; source: MetricSource; fetched_at: Date;
  }>(
    `SELECT p.id::text AS post_id, p.engagement_id::text AS engagement_id, p.title, cl.name AS client_name,
            EXISTS (SELECT 1 FROM social_boosts ob WHERE ob.tenant_id = p.tenant_id AND ob.post_id = p.id
                     AND ob.status IN ('requested','approved','running')) AS open_boost,
            m.reach, m.impressions, m.likes, m.comments, m.shares, m.saves, m.video_views, m.clicks, m.source, m.fetched_at
       FROM social_posts p
       JOIN social_engagements e ON e.tenant_id = p.tenant_id AND e.id = p.engagement_id
       JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id
       JOIN social_post_variants v ON v.tenant_id = p.tenant_id AND v.post_id = p.id AND v.deleted_at IS NULL
       JOIN LATERAL (
         SELECT x.reach, x.impressions, x.likes, x.comments, x.shares, x.saves, x.video_views, x.clicks, x.source, x.fetched_at
           FROM social_post_metrics x WHERE x.tenant_id = v.tenant_id AND x.variant_id = v.id
          ORDER BY x.fetched_at DESC, x.created_at DESC, x.id DESC LIMIT 1
       ) m ON true
      WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND p.archived_at IS NULL AND p.pipeline_status = 'live'
        AND p.went_live_at >= $2::timestamptz AND ($3::uuid IS NULL OR p.engagement_id = $3)`,
    [tenantId, windowStart, engagementId]);
  const posts = new Map<string, { engagementId: string; title: string; clientName: string; open: boolean; snaps: Snapshot[] }>();
  for (const r of rows) {
    const cur = posts.get(r.post_id) ?? { engagementId: r.engagement_id, title: r.title ?? "Untitled post", clientName: r.client_name, open: r.open_boost, snaps: [] };
    cur.snaps.push({
      reach: r.reach, impressions: r.impressions, likes: r.likes, comments: r.comments, shares: r.shares, saves: r.saves, videoViews: r.video_views,
      clicks: r.clicks, source: r.source, capturedAt: new Date(r.fetched_at),
    });
    posts.set(r.post_id, cur);
  }
  const rateOf = new Map<string, number | null>([...posts].map(([id, p]) => [id, postRate(p.snaps)]));
  const out: BoostCandidate[] = [];
  for (const [id, p] of posts) {
    if (p.open) continue;
    const others = [...posts].filter(([oid, o]) => oid !== id && o.engagementId === p.engagementId).map(([oid]) => rateOf.get(oid) ?? null);
    const rate = rateOf.get(id) ?? null;
    const average = meanRate(others);
    if (!isBoostCandidate(rate, average, factor)) continue;
    out.push({ postId: id, clientName: p.clientName, title: p.title, engagementRate: round6(rate), accountAverageRate: round6(average) });
  }
  out.sort((a, b) => (b.engagementRate ?? 0) - (a.engagementRate ?? 0) || (a.postId < b.postId ? -1 : 1));
  return out.slice(0, max);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The reach estimate (§63.11 `GET posts/:postId/boosts/estimate`)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface ReachEstimate { reachLow: number | null; reachHigh: number | null; basis: "history" | "simulated" | "none" }

/** The band around the centre of a history estimate: 80% to 120%. */
export const HISTORY_BAND = { low: 0.8, high: 1.2 } as const;
/** A simulated post with no simulated history: a fixed, made-up yield of 0.02 to 0.06 people per MAJOR unit of the currency (Rp 500,000
 *  reads 10,000 to 30,000). Deterministic, so a test and a demo read the same band; never shown without the SIMULATED mark. */
export const SIMULATED_REACH_PER_MAJOR = { low: 0.02, high: 0.06 } as const;

/**
 * PURE. The estimate from the client's history (`paidReach` and `spend` summed over their completed boosts of the same kind, real or
 * simulated, in the same currency), or the simulated placeholder, or none.
 *   - history: the client's paid reach per minor unit spent, times the boost's total, in a band of 80% to 120% (floor and ceiling);
 *   - simulated: only for a simulated post with no simulated history: `SIMULATED_REACH_PER_MAJOR` times the total in major units;
 *   - none: nulls (a real post with no history: no made-up number).
 * The audience is not in the maths: there is no history per audience yet, and a guess per audience would be a made-up number.
 */
export function estimateFrom(i: { totalMinor: number; minorUnit: number; simulated: boolean; historyReach: number; historySpend: number }): ReachEstimate {
  const clamp = (n: number) => Math.max(0, Math.min(MAX_INT, n));
  if (i.historySpend > 0) {
    const centre = (i.historyReach / i.historySpend) * i.totalMinor;
    return { reachLow: clamp(Math.floor(centre * HISTORY_BAND.low)), reachHigh: clamp(Math.ceil(centre * HISTORY_BAND.high)), basis: "history" };
  }
  if (i.simulated) {
    const major = i.totalMinor / 10 ** i.minorUnit;
    return { reachLow: clamp(Math.floor(major * SIMULATED_REACH_PER_MAJOR.low)), reachHigh: clamp(Math.ceil(major * SIMULATED_REACH_PER_MAJOR.high)), basis: "simulated" };
  }
  return { reachLow: null, reachHigh: null, basis: "none" };
}

/** The estimate for one boost of `totalMinor` on a post of `clientId` (its `simulated` mark), reading the client's history. */
export async function estimateReach(c: PoolClient, tenantId: string, i: { clientId: string; simulated: boolean; currency: string; totalMinor: number }): Promise<ReachEstimate> {
  const h = await c.query<{ reach: string; spend: string }>(
    `SELECT COALESCE(SUM(paid_reach), 0)::text AS reach, COALESCE(SUM(spend_minor), 0)::text AS spend
       FROM social_boosts
      WHERE tenant_id = $1 AND client_id = $2 AND status = 'completed' AND currency = $3 AND simulated = $4
        AND spend_minor > 0 AND paid_reach IS NOT NULL`,
    [tenantId, i.clientId, i.currency, i.simulated]);
  return estimateFrom({
    totalMinor: i.totalMinor, minorUnit: await minorUnitOf(c, i.currency), simulated: i.simulated,
    historyReach: Number(h.rows[0]?.reach ?? 0), historySpend: Number(h.rows[0]?.spend ?? 0),
  });
}
