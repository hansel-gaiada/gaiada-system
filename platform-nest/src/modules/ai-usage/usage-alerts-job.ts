// AIP-17b + AIP-19 (docs/plans/2026-10-27-ai-plan.md §6.3 items 7 and 8; rulings AIP-D7, AIP-D19) — the AI usage job. Every 10 minutes, for every
// company, two checks, both notify-only (report mode: a stop is AIP-18's):
//
//   BUDGETS   month-to-date spend (the UTC month) of the company's alert figure and of every budgeted department's whole SUBTREE, against its
//             `ai_budgets` row. Each threshold crossed (80, then 100 percent) is inserted into the dedupe ledger `ai_usage_alerts` with
//             ON CONFLICT DO NOTHING, and a notice is sent ONLY when that insert really happened. A department's notice goes to the department's
//             head(s) (the live lead-seat holders of that exact node) and the company's owner(s); the company figure's goes to the owner(s)
//             and the GM (the lead-seat holders of the company's GM unit).
//   RUNAWAY   a person (all surfaces, `user_id`) or an agent (surface `agent`, grouped by `task`, the agent's name) whose calls TODAY (UTC day) are
//             at least 5 times its own average per ACTIVE day over the previous 14 UTC days, with at least 7 active days and at least 20 calls
//             today (budgets.ts `isRunaway`). Once per subject per day (ledger threshold 500). The notice NAMES the person (AIP-D19) with
//             today's calls and the usual daily figure: no cost and no text. It goes to the owner(s) and to IT (the lead-seat holders of the
//             company's IT unit, found by workspace slug the way the GM unit is).
//
// EXACTLY ONCE. The ledger row is inserted BEFORE the notice goes out and the notice goes only if the insert returned a row, so two runners (two
// replicas, a tick that overlaps a restart) cannot both send: the primary key decides. The price is at-most-once: a crash between the insert
// and the notice loses that one notice, never duplicates it (a lost "80 percent" is followed by the 100 percent notice; a duplicate would be
// noise to the owner every ten minutes). Notices go through `notify()` (best effort, skips non-members); a failed notice is logged.
//
// SINGLE RUNNER, FAIL SOFT. One session advisory lock per sweep (the house pattern: search content-decay) keeps two sweeps in one database from
// overlapping; the ledger is the real guarantee. Chained setTimeout (a slow sweep never stacks), a jittered first tick (a restart of several
// replicas does not align them), one company's failure is logged and never stops the next, and nothing here ever throws out of a tick.
// SWITCH: AI_USAGE_JOB_ENABLED=0 turns the loop off (any other value, or unset, leaves it on); AI_USAGE_JOB_INTERVAL_MS (default 600000, minimum 60000).
import type { PoolClient } from "pg";
import { withGlobal, withTenants } from "../../db";
import { config } from "../../config";
import { notify as realNotify, type NotificationPayload } from "../../core/http";
import { loadOrgStructure, loadSeatHoldersByNode } from "../reports/person-scope";
import { loadGmSeatIds, loadItSeatIds } from "./authz";
import { parseMonth, type UsageMonth } from "./reads.service";
import { readBudgets, type BudgetLine, type UnitBudgetLine } from "./budgets.service";
import {
  RUNAWAY_LEDGER_THRESHOLD, RUNAWAY_MIN_CALLS_TODAY, RUNAWAY_WINDOW_DAYS, isRunaway, thresholdsCrossed, usualDaily, utcDay, utcDayMinus,
} from "./budgets";
import { findOrgUnit } from "../reports/dept-kpis";

/** The advisory lock's namespace: 'AU' (AI usage) + 1, beside the other jobs' (search 0x5343000N, agency 0x4149000N). */
export const USAGE_ALERTS_LOCK_NS = 0x41550001;
export const USAGE_ALERTS_LOCK_KEY = 0;

export const NOTICE_BUDGET_80 = "ai_usage.budget_80";
export const NOTICE_BUDGET_100 = "ai_usage.budget_100";
export const NOTICE_RUNAWAY_PERSON = "ai_usage.runaway_person";
export const NOTICE_RUNAWAY_AGENT = "ai_usage.runaway_agent";

type NotifyFn = (tenantId: string, recipientId: string | null, actorId: string | null, type: string, payload?: NotificationPayload) => Promise<void>;

export interface AlertsDeps {
  notify?: NotifyFn;
  /** Test seam: one company's pass. Defaults to `runCompanyAlerts`. */
  runCompany?: (tenantId: string, now: Date, deps: AlertsDeps) => Promise<CompanyAlertsResult>;
}

export interface CompanyAlertsResult {
  budgetNotices: number;
  runawayNotices: number;
}

export interface AlertsSweepResult extends CompanyAlertsResult {
  skippedLocked: boolean;
  companies: number;
  errors: number;
}

// ── who gets told ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The holders of a company-scope `owner` grant on exactly this company, lower case, sorted and distinct (an unexpired grant). */
export async function loadOwnerIds(tenantId: string): Promise<string[]> {
  const { rows } = await withGlobal((c) =>
    c.query<{ user_id: string }>(
      `SELECT DISTINCT ur.user_id::text AS user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE r.name = 'owner' AND ur.scope_type = 'company' AND ur.scope_id = $1
          AND (ur.expires_at IS NULL OR ur.expires_at > now())`,
      [tenantId],
    ),
  );
  return [...new Set(rows.map((r) => r.user_id.toLowerCase()))].sort();
}

const union = (...lists: string[][]): string[] => [...new Set(lists.flat().map((x) => x.toLowerCase()))].sort();

// ── the ledger ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

type AlertKind = "company_budget" | "unit_budget" | "runaway_person" | "runaway_agent";

/** True when THIS call inserted the row: the one runner that may send the notice. */
async function claim(c: PoolClient, tenantId: string, kind: AlertKind, subject: string, period: string, threshold: number): Promise<boolean> {
  const { rowCount } = await c.query(
    `INSERT INTO ai_usage_alerts (tenant_id, kind, subject, period, threshold) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, kind, subject, period, threshold) DO NOTHING`,
    [tenantId, kind, subject, period, threshold],
  );
  return rowCount === 1;
}

// ── runaway detection (SQL) ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RunawayCandidate {
  subject: string;
  today: number;
  activeDays: number;
  previousCalls: number;
}

/**
 * Subjects with at least 20 calls today, and each one's previous-14-UTC-day history (days with any call only). `subjectExpr` / `where` pick
 * the persons (`user_id`) or the agents (`task` of surface `agent`). The runaway rule itself is applied by the caller (`isRunaway`).
 */
async function runawayCandidates(c: PoolClient, tenantId: string, today: string, subjectExpr: string, where: string): Promise<RunawayCandidate[]> {
  const from = `${utcDayMinus(today, RUNAWAY_WINDOW_DAYS)}T00:00:00Z`;
  const to = `${utcDayMinus(today, -1)}T00:00:00Z`;
  const { rows } = await c.query<{ subject: string; today: number; active_days: number; previous_calls: number }>(
    `WITH d AS (
       SELECT ${subjectExpr} AS subject, (occurred_at AT TIME ZONE 'UTC')::date AS day, count(*)::int AS n
         FROM ai_usage_events
        WHERE tenant_id = $1 AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz AND ${where}
        GROUP BY 1, 2)
     SELECT subject,
            COALESCE(sum(n) FILTER (WHERE day = $4::date), 0)::int AS today,
            (count(*) FILTER (WHERE day < $4::date))::int AS active_days,
            COALESCE(sum(n) FILTER (WHERE day < $4::date), 0)::int AS previous_calls
       FROM d
      GROUP BY subject
     HAVING COALESCE(sum(n) FILTER (WHERE day = $4::date), 0) >= ${RUNAWAY_MIN_CALLS_TODAY}
      ORDER BY subject COLLATE "C"`,
    [tenantId, from, to, today],
  );
  return rows.map((r) => ({ subject: r.subject, today: r.today, activeDays: r.active_days, previousCalls: r.previous_calls }));
}

export const personCandidates = (c: PoolClient, tenantId: string, today: string) =>
  runawayCandidates(c, tenantId, today, "user_id::text", "user_id IS NOT NULL");
export const agentCandidates = (c: PoolClient, tenantId: string, today: string) =>
  runawayCandidates(c, tenantId, today, "task", "surface = 'agent' AND task IS NOT NULL AND task <> ''");

// ── one company ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Claimed {
  kind: AlertKind;
  subject: string;
  threshold: number;
  line?: BudgetLine | UnitBudgetLine;
  candidate?: RunawayCandidate;
  name?: string | null;
}

const runsAway = (c: RunawayCandidate): boolean => isRunaway({ today: c.today, activeDays: c.activeDays, previousCalls: c.previousCalls });

const money = (v: string | null): string => (v === null ? "0" : v.replace(/(\.[0-9]*?)0+$/, "$1").replace(/\.$/, ""));

/**
 * One company's pass: read what is due, claim each notice in the ledger, then send only the claimed ones. Safe to run twice, and concurrently:
 * the ledger's primary key lets exactly one caller claim a given notice. Exported for the tests; the sweep calls it per company.
 */
export async function runCompanyAlerts(tenantId: string, now: Date = new Date(), deps: AlertsDeps = {}): Promise<CompanyAlertsResult> {
  const send = deps.notify ?? realNotify;
  const month: UsageMonth = parseMonth(undefined, now);
  const today = utcDay(now);

  // (1) what is due: reads only, one transaction.
  const seen = await withTenants([tenantId], async (c) => {
    const structure = await loadOrgStructure(c, tenantId);
    const budgets = await readBudgets(c, tenantId, month, structure);
    const persons = (await personCandidates(c, tenantId, today)).filter(runsAway);
    const agents = (await agentCandidates(c, tenantId, today)).filter(runsAway);
    const crossedUnits = budgets.units.filter((u) => thresholdsCrossed(u.state).length > 0).map((u) => u.unitNodeId);
    return { structure, budgets, persons, agents, crossedUnits };
  });
  const companyCrossed = seen.budgets.company ? thresholdsCrossed(seen.budgets.company.state) : [];
  if (companyCrossed.length === 0 && seen.crossedUnits.length === 0 && seen.persons.length === 0 && seen.agents.length === 0) {
    return { budgetNotices: 0, runawayNotices: 0 };
  }

  // (2) claim: the ledger decides who sends.
  const claimed = await withTenants([tenantId], async (c) => {
    const out: Claimed[] = [];
    if (seen.budgets.company) {
      for (const t of companyCrossed) if (await claim(c, tenantId, "company_budget", "", month.month, t)) out.push({ kind: "company_budget", subject: "", threshold: t, line: seen.budgets.company });
    }
    for (const u of seen.budgets.units) {
      for (const t of thresholdsCrossed(u.state)) if (await claim(c, tenantId, "unit_budget", u.unitNodeId, month.month, t)) out.push({ kind: "unit_budget", subject: u.unitNodeId, threshold: t, line: u });
    }
    for (const p of seen.persons) if (await claim(c, tenantId, "runaway_person", p.subject, today, RUNAWAY_LEDGER_THRESHOLD)) out.push({ kind: "runaway_person", subject: p.subject, threshold: RUNAWAY_LEDGER_THRESHOLD, candidate: p });
    for (const a of seen.agents) if (await claim(c, tenantId, "runaway_agent", a.subject, today, RUNAWAY_LEDGER_THRESHOLD)) out.push({ kind: "runaway_agent", subject: a.subject, threshold: RUNAWAY_LEDGER_THRESHOLD, candidate: a });
    return out;
  });
  if (claimed.length === 0) return { budgetNotices: 0, runawayNotices: 0 };

  // (3) recipients and names, read only for what was claimed.
  const owners = await loadOwnerIds(tenantId);
  const needGm = claimed.some((x) => x.kind === "company_budget");
  const needIt = claimed.some((x) => x.kind === "runaway_person" || x.kind === "runaway_agent");
  const unitNodes = claimed.filter((x) => x.kind === "unit_budget").map((x) => x.subject);
  const personIds = claimed.filter((x) => x.kind === "runaway_person").map((x) => x.subject);
  const who = await withTenants([tenantId], async (c) => {
    const gm = needGm ? await loadGmSeatIds(c, tenantId, seen.structure) : [];
    const it = needIt ? await loadItSeatIds(c, tenantId, seen.structure) : [];
    const heads = await loadSeatHoldersByNode(c, tenantId, unitNodes);
    const names = new Map<string, string | null>();
    if (personIds.length > 0) {
      const r = await c.query<{ id: string; name: string | null }>(`SELECT id::text AS id, name FROM users WHERE id = ANY($1::uuid[])`, [personIds]);
      for (const row of r.rows) names.set(row.id.toLowerCase(), row.name);
    }
    return { gm, it, heads, names };
  });

  // (4) send. Nothing below throws out: a notice is best effort.
  let budgetNotices = 0;
  let runawayNotices = 0;
  for (const x of claimed) {
    let recipients: string[];
    let type: string;
    let payload: NotificationPayload;
    if (x.kind === "company_budget") {
      const line = x.line as BudgetLine;
      recipients = union(owners, who.gm);
      type = x.threshold === 100 ? NOTICE_BUDGET_100 : NOTICE_BUDGET_80;
      payload = {
        title: x.threshold === 100 ? "The company's AI budget is used up" : "The company has used 80% of its AI budget",
        body: `${line.percent}% of the monthly AI figure for ${month.month} is used: $${money(line.spentUsd)} of $${money(line.monthlyUsd)}.`,
        href: "/ai-usage", entityType: "ai_budget", severity: x.threshold === 100 ? "critical" : "warning",
        scope: "company", month: month.month, threshold: x.threshold,
      };
    } else if (x.kind === "unit_budget") {
      const line = x.line as UnitBudgetLine;
      const unitName = findOrgUnit(seen.structure, x.subject)?.name ?? x.subject;
      recipients = union(who.heads.get(x.subject) ?? [], owners);
      type = x.threshold === 100 ? NOTICE_BUDGET_100 : NOTICE_BUDGET_80;
      payload = {
        title: x.threshold === 100 ? `${unitName}'s AI budget is used up` : `${unitName} has used 80% of its AI budget`,
        body: `${line.percent}% of the monthly AI budget for ${month.month} is used: $${money(line.spentUsd)} of $${money(line.monthlyUsd)}.`,
        href: `/analytics/ai-usage/department?unit=${encodeURIComponent(x.subject)}`, entityType: "ai_budget", severity: x.threshold === 100 ? "critical" : "warning",
        scope: "unit", unitNodeId: x.subject, month: month.month, threshold: x.threshold,
      };
    } else {
      const cand = x.candidate as RunawayCandidate;
      const usual = usualDaily(cand);
      recipients = union(owners, who.it);
      if (x.kind === "runaway_person") {
        const name = who.names.get(x.subject.toLowerCase()) ?? "A person";
        type = NOTICE_RUNAWAY_PERSON;
        payload = {
          title: `${name} is using AI far above their usual`,
          body: `${name} made ${cand.today} AI calls today; the usual is about ${usual} a day.`,
          href: "/ai-usage", entityType: "ai_usage_person", entityId: x.subject, severity: "warning",
          day: today, calls: cand.today, usualDaily: usual,
        };
      } else {
        type = NOTICE_RUNAWAY_AGENT;
        payload = {
          title: `The agent ${x.subject} is running far above its usual`,
          body: `The agent ${x.subject} ran ${cand.today} times today; the usual is about ${usual} a day.`,
          href: "/ai-usage", entityType: "ai_usage_agent", severity: "warning",
          day: today, calls: cand.today, usualDaily: usual, agent: x.subject,
        };
      }
    }
    let sent = 0;
    for (const r of recipients) {
      try {
        await send(tenantId, r, null, type, payload);
        sent++;
      } catch (err) {
        console.error(`[AI-USAGE-ALERTS] notice ${type} to ${r} failed:`, (err as Error)?.message ?? err);
      }
    }
    if (x.kind === "runaway_person" || x.kind === "runaway_agent") runawayNotices += sent > 0 ? 1 : 0;
    else budgetNotices += sent > 0 ? 1 : 0;
  }
  return { budgetNotices, runawayNotices };
}

// ── the sweep and the loop ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every company, one at a time. One company's failure is logged and never stops the others. Never throws. */
export async function runUsageAlertsSweep(now: Date = new Date(), deps: AlertsDeps = {}): Promise<AlertsSweepResult> {
  const result: AlertsSweepResult = { skippedLocked: false, companies: 0, errors: 0, budgetNotices: 0, runawayNotices: 0 };
  try {
    return await withGlobal(async (c) => {
      const lock = await c.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS locked", [USAGE_ALERTS_LOCK_NS, USAGE_ALERTS_LOCK_KEY]);
      if (!lock.rows[0]?.locked) {
        result.skippedLocked = true;
        return result;
      }
      try {
        const { rows } = await c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL ORDER BY created_at ASC, id`);
        for (const { id } of rows) {
          result.companies++;
          try {
            const r = await (deps.runCompany ?? runCompanyAlerts)(id, now, deps);
            result.budgetNotices += r.budgetNotices;
            result.runawayNotices += r.runawayNotices;
          } catch (err) {
            result.errors++;
            console.error(`[AI-USAGE-ALERTS] company ${id} failed:`, (err as Error)?.message ?? err);
          }
        }
        return result;
      } finally {
        await c.query("SELECT pg_advisory_unlock($1, $2)", [USAGE_ALERTS_LOCK_NS, USAGE_ALERTS_LOCK_KEY]).catch(() => undefined);
      }
    });
  } catch (err) {
    result.errors++;
    console.error("[AI-USAGE-ALERTS] sweep failed:", (err as Error)?.message ?? err);
    return result;
  }
}

/** First tick: a minute plus up to a minute of jitter, so a restart of several replicas does not align them and boot stays quiet. */
export function firstTickDelayMs(random: () => number = Math.random): number {
  return 60_000 + Math.floor(random() * 60_000);
}

/**
 * The loop. Returns null (no timer, no DB, no network) when AI_USAGE_JOB_ENABLED is "0". Chained setTimeout, so a slow sweep never stacks;
 * every tick is fail-soft.
 */
export function startUsageAlertsLoop(
  opts: { enabled?: boolean; intervalMs?: number; initialDelayMs?: number; sweep?: () => Promise<AlertsSweepResult> } = {},
): { stop: () => void } | null {
  const enabled = opts.enabled ?? config.aiUsage.jobEnabled;
  if (!enabled) return null;
  const intervalMs = opts.intervalMs ?? config.aiUsage.jobIntervalMs;
  const sweep = opts.sweep ?? (() => runUsageAlertsSweep());
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const r = await sweep();
      if (r.budgetNotices > 0 || r.runawayNotices > 0 || r.errors > 0) {
        console.log("[AI-USAGE-ALERTS] tick:", { companies: r.companies, budgetNotices: r.budgetNotices, runawayNotices: r.runawayNotices, errors: r.errors });
      }
    } catch (err) {
      console.error("[AI-USAGE-ALERTS] tick failed:", (err as Error)?.message ?? err);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
    timer?.unref?.();
  };
  timer = setTimeout(tick, opts.initialDelayMs ?? firstTickDelayMs());
  timer.unref?.();
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
