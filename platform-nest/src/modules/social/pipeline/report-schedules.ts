// SCP-5 W5-A5 (docs/FRONTEND-BFF-CONTRACT.md §63.24.9; owner rulings SCP-Q17, Q38, Q40) — report automation: the schedules the four set,
// "Run now", the job `social-report-schedules` and the spend reads. Every run goes through W5-A3's engine (report-runs.ts): the same
// listing, the same four drafts in flight, the same resume, the same usage record. There is no second engine here.
//
// ── WHO (SCP-Q17, Q19) ───────────────────────────────────────────────────────────────────────────────────────────────────────
//   Every route asks, in this order: an unattended principal (`users.kind` automation or bot) 403 `automation_cannot_act`; then
//   `social_engagement` · `plan` (the four: the Social Media and GM lead seats, the owner, the superadmin) 403 `not_a_social_approver`;
//   then 404 `schedule_not_found`; then 400 `invalid_field` `{field}`; then 409.
//   A schedule is OWNED by the one of the four who set it or last changed it (`owner_id`): the person, never an agent (by chat the OBO
//   envelope makes the person the principal; a persona acting for a person makes that person the owner).
//
// ── RUN-AS-OWNER (the job) ──────────────────────────────────────────────────────────────────────────────────────────────────────
//   At run time, inside the schedule row's transaction, the owner is loaded AFRESH (`assemblePrincipal`: an inactive or deleted user is
//   null) and asked the live gates the routes ask: `social_engagement` · `plan`, then `social_report` · `create`, with the company's
//   approver ids read now. Then the run is listed for them (`planReportRun`, the route's own narrowing), so every client is one they may
//   draft for, and each client's draft is authorized again as them by the engine (`createSocialReport`). The run's `requested_by` is the
//   owner and its `via` is `{automation: 'report_schedule', scheduleId, missed}`, which the engine stamps on every report's activity; the
//   usage rows carry the owner and the run id.
//   When the owner no longer passes, NO run is made: the schedule pauses (`owner_inactive` for a user who is not active, `owner_not_allowed`
//   for a lost seat or grant, or an owner who is somehow not a person), `paused_by` NULL (the job), and `social.report_schedule.paused` goes
//   to the owner (when still active) and to the HoD and GM seats. The kind turned off or drafted by hand pauses it the same way (`kind_off`,
//   `ai_drafting_off`). Whoever of the four resumes it becomes its owner. A Cerbos or database failure pauses nothing: the transaction rolls
//   back and the next tick tries again.
//
// ── THE JOB (every minute, on every instance) ──────────────────────────────────────────────────────────────────────────────────
//   Per company, under the tenant wall, one due schedule at a time: `SELECT … FOR UPDATE SKIP LOCKED` (enabled, not deleted, `next_run_at
//   <= now()`), so two instances never hold the same one. In that row's transaction:
//     1. its moment is computed AGAIN with today's calendar (`dueAt`): a holiday added since moves it, and nothing runs;
//     2. otherwise the run drafts the LATEST period whose moment has passed; the ones between are `missed` (counted in `via`), never drafted;
//     3. the owner is re-authorized (above);
//     4. the run is inserted IN THIS TRANSACTION (`insertReportRun`; its FK to this locked row could not be taken from another connection):
//        `ux_social_report_runs_schedule` makes a second run of one schedule and period impossible (a period "Run now" already ran is
//        passed over, and the next one computed), and a run of the same company, kind and period still going (`generation_running`) leaves
//        the schedule as it is, for the next tick;
//     5. `last_run_at`, `last_period`, `next_run_at` and `next_period` advance, and the transaction commits.
//   Then, outside it, the activity `run` (the owner as actor, with `via`) and the run started as 63.24.5 starts it. A restart mid-run is the
//   engine's resume: the schedule row already moved, so nothing is made twice.
import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { newId, withGlobal, withTenants } from "../../../db";
import { config } from "../../../config";
import { authorize, notify, writeActivity } from "../../../core/http";
import { check } from "../../../rbac/cerbos";
import { assemblePrincipal, type Principal } from "../../../rbac/principal";
import { todayIsoInTz } from "../../reports/person-scope";
import { loadWorkingCalendar } from "../../reports/dept-kpi-readers/functional/working-calendar";
import { loadSocialApproverIds, socialEngagementResource, socialReportResource } from "../pipeline-authz";
import { findDepartmentBySlug } from "./pipeline-data";
import { PERIODIC_KINDS, reportKindRules, socialRules, type PeriodicKind } from "./rules";
import { MAX_CHOSEN_CLIENTS, countResults, type RunEntry } from "./report-run-plan";
import {
  insertReportRun, isAutomationPrincipal, launchReportRun, mayPlan, personOf, planReportRun, startReportRun, viaOfRequest,
  type StartRunAnswer,
} from "./report-runs";
import {
  calendarWindowFor, dueAt, lastEndedPeriod, localDateOf, nextOccurrence, parseTiming, timingText, zonedInstant,
  type ScheduleTiming, type TimingContext,
} from "./report-schedule-timing";

const SOCIAL = { modules: ["social"] };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The job's cadence (every minute, §63.24.9). */
export const REPORT_SCHEDULES_INTERVAL_MS = 60_000;
/** The most due schedules one sweep takes per company (the rest wait a minute). */
const MAX_PER_COMPANY_PER_TICK = 25;

export type ScheduleScope = "all" | "chosen";
export type PausedReason = "manual" | "owner_not_allowed" | "owner_inactive" | "kind_off" | "ai_drafting_off";
const JOB_PAUSE_WORDS: Record<Exclude<PausedReason, "manual">, string> = {
  owner_not_allowed: "its owner may no longer run it",
  owner_inactive: "its owner is no longer an active user",
  kind_off: "the company turned this report kind off",
  ai_drafting_off: "this report kind is drafted by hand",
};

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const iso = (v: string | Date | null): string | null => (v === null ? null : new Date(v).toISOString());
const isUniqueViolation = (e: unknown, constraint?: string): boolean =>
  (e as { code?: string } | null)?.code === "23505" && (constraint === undefined || (e as { constraint?: string }).constraint === constraint);
function invalidField(field: string): never {
  throw new BadRequestException({ message: "invalid_field", field });
}
const lower = (ids: readonly string[]): string[] => ids.map((x) => x.toLowerCase());

interface ScheduleRow {
  id: string; owner_id: string; kind: PeriodicKind; scope: ScheduleScope; engagement_ids: string[]; timing: unknown;
  enabled: boolean; paused_reason: PausedReason | null; paused_at: string | null; paused_by: string | null;
  next_run_at: string | null; next_period: string | null; last_run_at: string | null; last_period: string | null;
  created_at: string; updated_at: string;
}
const SCHEDULE_COLUMNS = `id::text AS id, owner_id::text AS owner_id, kind, scope, engagement_ids::text[] AS engagement_ids, timing, enabled,
  paused_reason, paused_at, paused_by::text AS paused_by, next_run_at, next_period, last_run_at, last_period, created_at, updated_at`;

async function loadSchedule(c: PoolClient, tenantId: string, id: string, lock = false): Promise<ScheduleRow | null> {
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  const r = await c.query<ScheduleRow>(
    `SELECT ${SCHEDULE_COLUMNS} FROM social_report_schedules WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL${lock ? " FOR UPDATE" : ""}`,
    [tenantId, id.toLowerCase()]);
  return r.rows[0] ?? null;
}

const approverIdsOf = (tenantId: string): Promise<string[]> => withTenants([tenantId], (c) => loadSocialApproverIds(c, tenantId), SOCIAL);

/**
 * The routes' gate (see the header): 403 `automation_cannot_act`, then `plan` or 403 `not_a_social_approver` (a 401 passes through, and an
 * `assurance_required` reason is kept). Answers the person who acts: the owner a write records.
 */
async function gate(principal: Principal, tenantId: string): Promise<string> {
  if (isAutomationPrincipal(principal)) throw new ForbiddenException({ message: "automation_cannot_act" });
  try {
    await authorize(principal, socialEngagementResource(tenantId, await approverIdsOf(tenantId)), "plan");
  } catch (e) {
    if (e instanceof ForbiddenException) {
      const res = e.getResponse() as { reason?: unknown };
      throw new ForbiddenException({ message: "not_a_social_approver", ...(typeof res?.reason === "string" ? { reason: res.reason } : {}) });
    }
    throw e;
  }
  const person = personOf(principal);
  if (!person) throw new ForbiddenException({ message: "not_a_social_approver" });
  return person.toLowerCase();
}

/** The company's timing context now: its zone, its fiscal year's first month, its holiday calendar around `now` (and `behindDays` back). */
async function timingContextFor(tenantId: string, now: Date, behindDays = 0, c?: PoolClient): Promise<TimingContext> {
  const tz = config.reportsTz;
  const company = c ? await socialRules(c, tenantId) : await withTenants([tenantId], (cc) => socialRules(cc, tenantId), SOCIAL);
  const window = calendarWindowFor(localDateOf(now, tz), behindDays);
  const calendar = await loadWorkingCalendar(tenantId, window.from, window.to);
  return { tz, fiscalYearStartMonth: company.rules.reports.fiscalYearStartMonth, calendar };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The read: GET report-schedules
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface Spend { runs: number; calls: number; promptTokens: number; completionTokens: number; costUsd: number | null }
export interface ScheduleView {
  id: string; kind: PeriodicKind; scope: ScheduleScope; clients: Array<{ engagementId: string; clientName: string }>;
  timing: ScheduleTiming | Record<string, unknown>; timingText: string; enabled: boolean; pausedReason: PausedReason | null;
  owner: { id: string; name: string | null }; nextRunAt: string | null; nextPeriod: string | null; lastRunAt: string | null; lastPeriod: string | null;
  lastRun: { runId: string; status: string; created: number; existing: number; skipped: number; failed: number; missed: number } | null;
  spend: { last30Days: Spend; monthToDate: Spend };
}

const emptySpend = (): Spend => ({ runs: 0, calls: 0, promptTokens: 0, completionTokens: 0, costUsd: null });

/** Each schedule's spend (SCP-Q40): over its runs made in the last 30 days and since the company's month began, summed from `ai_usage_events` by `run_id`. */
async function spendOf(tenantId: string, scheduleIds: string[], now: Date): Promise<Map<string, { last30Days: Spend; monthToDate: Spend }>> {
  const out = new Map<string, { last30Days: Spend; monthToDate: Spend }>();
  if (scheduleIds.length === 0) return out;
  const tz = config.reportsTz;
  const monthStart = zonedInstant(`${localDateOf(now, tz).slice(0, 7)}-01`, "00:00", tz);
  const r = await withTenants([tenantId], (c) => c.query<{
    schedule_id: string; window: "d30" | "mtd"; runs: number; calls: number; prompt: string | null; completion: string | null; cost: string | null; costed: number;
  }>(
    `WITH runs AS (
       SELECT r.id, r.schedule_id, r.created_at >= $3::timestamptz - interval '30 days' AS in30, r.created_at >= $4::timestamptz AS inmtd
         FROM social_report_runs r
        WHERE r.tenant_id = $1 AND r.schedule_id = ANY($2::uuid[])
          AND r.created_at >= least($3::timestamptz - interval '30 days', $4::timestamptz)
     ), usage AS (
       SELECT u.run_id, count(*)::int AS calls, sum(u.prompt_tokens) AS prompt, sum(u.completion_tokens) AS completion,
              sum(u.cost_usd) AS cost, count(u.cost_usd)::int AS costed
         FROM ai_usage_events u
        WHERE u.tenant_id = $1 AND u.run_id IN (SELECT id FROM runs)
        GROUP BY u.run_id
     ), windows AS (
       SELECT 'd30'::text AS window, runs.* FROM runs WHERE in30
       UNION ALL
       SELECT 'mtd'::text AS window, runs.* FROM runs WHERE inmtd
     )
     SELECT w.schedule_id::text AS schedule_id, w.window, count(*)::int AS runs, coalesce(sum(u.calls), 0)::int AS calls,
            sum(u.prompt)::text AS prompt, sum(u.completion)::text AS completion, sum(u.cost)::text AS cost, coalesce(sum(u.costed), 0)::int AS costed
       FROM windows w LEFT JOIN usage u ON u.run_id = w.id
      GROUP BY w.schedule_id, w.window`,
    [tenantId, scheduleIds, now.toISOString(), monthStart.toISOString()]), SOCIAL);
  for (const id of scheduleIds) out.set(id, { last30Days: emptySpend(), monthToDate: emptySpend() });
  for (const row of r.rows) {
    const s: Spend = {
      runs: row.runs, calls: row.calls, promptTokens: Number(row.prompt ?? 0), completionTokens: Number(row.completion ?? 0),
      costUsd: row.costed > 0 && row.cost !== null ? Number(row.cost) : null,
    };
    const slot = out.get(row.schedule_id.toLowerCase());
    if (slot) slot[row.window === "d30" ? "last30Days" : "monthToDate"] = s;
  }
  return out;
}

async function viewsOf(tenantId: string, rows: ScheduleRow[], now = new Date()): Promise<ScheduleView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id.toLowerCase());
  const engagementIds = [...new Set(rows.flatMap((r) => lower(r.engagement_ids ?? [])))];
  const ownerIds = [...new Set(rows.map((r) => r.owner_id.toLowerCase()))];
  const [names, owners, lastRuns, spend] = await Promise.all([
    engagementIds.length === 0 ? new Map<string, string>() : withTenants([tenantId], async (c) => {
      const r = await c.query<{ id: string; client_name: string }>(
        `SELECT e.id::text AS id, cl.name AS client_name FROM social_engagements e JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id
          WHERE e.tenant_id = $1 AND e.id = ANY($2::uuid[])`, [tenantId, engagementIds]);
      return new Map(r.rows.map((x) => [x.id.toLowerCase(), x.client_name]));
    }, SOCIAL),
    withGlobal(async (c) => {
      const r = await c.query<{ id: string; name: string | null }>(`SELECT id::text AS id, name FROM users WHERE id = ANY($1::uuid[])`, [ownerIds]);
      return new Map(r.rows.map((x) => [x.id.toLowerCase(), x.name]));
    }),
    withTenants([tenantId], async (c) => {
      const r = await c.query<{ schedule_id: string; id: string; status: string; results: RunEntry[]; via: Record<string, unknown> | null }>(
        `SELECT DISTINCT ON (schedule_id) schedule_id::text AS schedule_id, id::text AS id, status, results, via
           FROM social_report_runs WHERE tenant_id = $1 AND schedule_id = ANY($2::uuid[])
          ORDER BY schedule_id, created_at DESC, id`, [tenantId, ids]);
      return new Map(r.rows.map((x) => [x.schedule_id.toLowerCase(), x]));
    }, SOCIAL),
    spendOf(tenantId, ids, now),
  ]);
  return rows.map((row): ScheduleView => {
    const parsed = parseTiming(row.kind, row.timing);
    const last = lastRuns.get(row.id.toLowerCase());
    const counts = last ? countResults(last.results ?? []) : null;
    return {
      id: row.id, kind: row.kind, scope: row.scope,
      clients: lower(row.engagement_ids ?? []).map((engagementId) => ({ engagementId, clientName: names.get(engagementId) ?? "" })),
      timing: parsed.ok ? parsed.timing : (isObj(row.timing) ? row.timing : {}),
      timingText: parsed.ok ? timingText(row.kind, parsed.timing) : "",
      enabled: row.enabled, pausedReason: row.paused_reason,
      owner: { id: row.owner_id, name: owners.get(row.owner_id.toLowerCase()) ?? null },
      nextRunAt: iso(row.next_run_at), nextPeriod: row.next_period, lastRunAt: iso(row.last_run_at), lastPeriod: row.last_period,
      lastRun: last && counts ? {
        runId: last.id, status: last.status, created: counts.created, existing: counts.existing, skipped: counts.skipped, failed: counts.failed,
        missed: typeof last.via?.missed === "number" ? last.via.missed : 0,
      } : null,
      spend: spend.get(row.id.toLowerCase()) ?? { last30Days: emptySpend(), monthToDate: emptySpend() },
    };
  });
}

/** `GET report-schedules`: the company's schedules, oldest first. */
export async function listReportSchedules(principal: Principal, tenantId: string): Promise<{ items: ScheduleView[] }> {
  await gate(principal, tenantId);
  const rows = await withTenants([tenantId], (c) => c.query<ScheduleRow>(
    `SELECT ${SCHEDULE_COLUMNS} FROM social_report_schedules WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY created_at, id`, [tenantId]), SOCIAL);
  return { items: await viewsOf(tenantId, rows.rows) };
}

async function viewOf(tenantId: string, id: string): Promise<ScheduleView> {
  const row = await withTenants([tenantId], (c) => loadSchedule(c, tenantId, id), SOCIAL);
  if (!row) throw new NotFoundException({ message: "schedule_not_found" });
  return (await viewsOf(tenantId, [row]))[0];
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The writes: POST, PATCH and DELETE report-schedules
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

function bodyOf(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (!isObj(body)) invalidField("body");
  for (const k of Object.keys(body)) if (!allowed.includes(k)) invalidField(k);
  return body;
}

function timingOf(kind: PeriodicKind, raw: unknown): ScheduleTiming {
  const t = parseTiming(kind, raw);
  if (!t.ok) invalidField(t.field);
  return t.timing;
}

function engagementIdsOf(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CHOSEN_CLIENTS || !raw.every((x) => typeof x === "string" && UUID_RE.test(x))) {
    invalidField("engagementIds");
  }
  return [...new Set((raw as string[]).map((x) => x.toLowerCase()))];
}

/** Every chosen client is an open engagement of the company (not deleted, not closed), or 400 `engagementIds`. */
async function assertOpenEngagements(c: PoolClient, tenantId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const r = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM social_engagements WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL AND status <> 'closed'`,
    [tenantId, ids]);
  if ((r.rows[0]?.n ?? 0) !== ids.length) invalidField("engagementIds");
}

async function scheduleExists(c: PoolClient, tenantId: string, kind: string): Promise<never> {
  const r = await c.query<{ id: string }>(
    `SELECT id::text AS id FROM social_report_schedules WHERE tenant_id = $1 AND kind = $2 AND scope = 'all' AND deleted_at IS NULL LIMIT 1`, [tenantId, kind]);
  throw new ConflictException({ message: "schedule_exists", detail: { scheduleId: r.rows[0]?.id ?? null } });
}

/** Run a write under a savepoint so a unique violation can be answered on the same transaction. */
async function guarded<T>(c: PoolClient, fn: () => Promise<T>, onUnique: (e: unknown) => Promise<never>): Promise<T> {
  await c.query("SAVEPOINT social_report_schedule_write");
  try {
    const out = await fn();
    await c.query("RELEASE SAVEPOINT social_report_schedule_write");
    return out;
  } catch (e) {
    await c.query("ROLLBACK TO SAVEPOINT social_report_schedule_write");
    if (isUniqueViolation(e)) return onUnique(e);
    throw e;
  }
}

/** `POST report-schedules` `{id?, kind, scope, engagementIds?, timing, enabled?}` -> 201 `{schedule, created: true}`; a replayed id 200 `created: false`. */
export async function createReportSchedule(principal: Principal, tenantId: string, rawBody: unknown): Promise<{ status: 200 | 201; body: { schedule: ScheduleView; created: boolean } }> {
  const owner = await gate(principal, tenantId);
  const b = bodyOf(rawBody, ["id", "kind", "scope", "engagementIds", "timing", "enabled"]);
  if (b.id !== undefined && (typeof b.id !== "string" || !UUID_RE.test(b.id))) invalidField("id");
  const id = (b.id as string | undefined)?.toLowerCase() ?? newId();
  if (b.id !== undefined) {
    const prior = await withTenants([tenantId], (c) => c.query<{ id: string }>(`SELECT id::text AS id FROM social_report_schedules WHERE tenant_id = $1 AND id = $2`, [tenantId, id]), SOCIAL);
    if (prior.rows[0]) return { status: 200, body: { schedule: await viewOf(tenantId, id), created: false } };
  }
  if (typeof b.kind !== "string" || !(PERIODIC_KINDS as readonly string[]).includes(b.kind)) invalidField("kind");
  const kind = b.kind as PeriodicKind;
  if (b.scope !== "all" && b.scope !== "chosen") invalidField("scope");
  const scope = b.scope as ScheduleScope;
  let engagementIds: string[] = [];
  if (scope === "chosen") engagementIds = engagementIdsOf(b.engagementIds);
  else if (b.engagementIds !== undefined && !(Array.isArray(b.engagementIds) && b.engagementIds.length === 0)) invalidField("engagementIds");
  if (b.timing === undefined) invalidField("timing");
  const timing = timingOf(kind, b.timing);
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") invalidField("enabled");
  const enabled = b.enabled !== false;

  const now = new Date();
  const next = enabled ? nextOccurrence(kind, timing, now, await timingContextFor(tenantId, now)) : null;
  const created = await withTenants([tenantId], async (c) => {
    await assertOpenEngagements(c, tenantId, engagementIds);
    return guarded(c, async () => {
      await c.query(
        `INSERT INTO social_report_schedules (id, tenant_id, owner_id, kind, scope, engagement_ids, timing, enabled, paused_reason, paused_at, paused_by,
                                              next_run_at, next_period, updated_by, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7::jsonb, $8, $9, $10, $11, $12, $13, $3, $14)`,
        [id, tenantId, owner, kind, scope, engagementIds, JSON.stringify(timing), enabled,
          enabled ? null : "manual", enabled ? null : now.toISOString(), enabled ? null : owner,
          next ? next.runAt.toISOString() : null, next ? next.period : null, config.originSite]);
      return true;
    }, async (e) => {
      if (isUniqueViolation(e, "ux_social_report_schedules_all")) return scheduleExists(c, tenantId, kind);
      if (isUniqueViolation(e, "social_report_schedules_pkey")) throw new ConflictException({ message: "schedule_replayed" });
      throw e;
    });
  }, SOCIAL).catch(async (e) => {
    // The same id replayed at the same moment: answer the schedule the first one made.
    if (e instanceof ConflictException && (e.getResponse() as { message?: string }).message === "schedule_replayed") return false;
    throw e;
  });
  if (!created) return { status: 200, body: { schedule: await viewOf(tenantId, id), created: false } };
  await writeActivity(tenantId, owner, "created", "social_report_schedule", id, { kind, scope, timing, enabled, clients: engagementIds.length });
  return { status: 201, body: { schedule: await viewOf(tenantId, id), created: true } };
}

/**
 * `PATCH report-schedules/:id` `{scope?, engagementIds?, timing?, enabled?}`: the caller becomes the owner. Resuming clears the pause and
 * computes the next run; pausing sets `manual`; a new timing on a running schedule computes its next run again.
 */
export async function updateReportSchedule(principal: Principal, tenantId: string, id: string, rawBody: unknown): Promise<{ schedule: ScheduleView }> {
  const owner = await gate(principal, tenantId);
  const exists = await withTenants([tenantId], (c) => loadSchedule(c, tenantId, id), SOCIAL);
  if (!exists) throw new NotFoundException({ message: "schedule_not_found" });
  const b = bodyOf(rawBody, ["scope", "engagementIds", "timing", "enabled"]);
  if (b.scope !== undefined && b.scope !== "all" && b.scope !== "chosen") invalidField("scope");
  const scope = (b.scope as ScheduleScope | undefined) ?? exists.scope;
  let engagementIds: string[] | undefined;
  if (scope === "chosen") {
    if (b.engagementIds !== undefined) engagementIds = engagementIdsOf(b.engagementIds);
    else if (exists.scope !== "chosen") invalidField("engagementIds");
  } else if (b.engagementIds !== undefined && !(Array.isArray(b.engagementIds) && b.engagementIds.length === 0)) {
    invalidField("engagementIds");
  } else {
    engagementIds = [];
  }
  const timing = b.timing !== undefined ? timingOf(exists.kind, b.timing) : null;
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") invalidField("enabled");

  const now = new Date();
  const ctx = await timingContextFor(tenantId, now);
  const out = await withTenants([tenantId], async (c) => {
    const row = await loadSchedule(c, tenantId, id, true);
    if (!row) throw new NotFoundException({ message: "schedule_not_found" });
    if (engagementIds && engagementIds.length > 0) await assertOpenEngagements(c, tenantId, engagementIds);
    const t = timing ?? (() => { const p = parseTiming(row.kind, row.timing); if (!p.ok) invalidField("timing"); return p.timing; })();
    const pausing = b.enabled === false && row.enabled;
    const resuming = b.enabled === true && !row.enabled;
    const enabled = pausing ? false : resuming ? true : row.enabled;
    const next = enabled && (resuming || timing !== null) ? nextOccurrence(row.kind, t, now, ctx) : null;
    await guarded(c, () => c.query(
      `UPDATE social_report_schedules
          SET owner_id = $3, updated_by = $3, updated_at = now(), scope = $4, engagement_ids = coalesce($5::uuid[], engagement_ids), timing = $6::jsonb,
              enabled = $7,
              paused_reason = CASE WHEN $8 THEN 'manual' WHEN $9 THEN NULL ELSE paused_reason END,
              paused_at = CASE WHEN $8 THEN now() WHEN $9 THEN NULL ELSE paused_at END,
              paused_by = CASE WHEN $8 THEN $3::uuid WHEN $9 THEN NULL ELSE paused_by END,
              next_run_at = CASE WHEN NOT $7 THEN NULL WHEN $10::timestamptz IS NOT NULL THEN $10::timestamptz ELSE next_run_at END,
              next_period = CASE WHEN NOT $7 THEN NULL WHEN $11::text IS NOT NULL THEN $11::text ELSE next_period END
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, row.id, owner, scope, engagementIds ?? null, JSON.stringify(t), enabled, pausing, resuming,
        next ? next.runAt.toISOString() : null, next ? next.period : null]),
    async (e) => {
      if (isUniqueViolation(e, "ux_social_report_schedules_all")) return scheduleExists(c, tenantId, row.kind);
      throw e;
    });
    return { row, pausing, resuming, edited: b.scope !== undefined || b.engagementIds !== undefined || b.timing !== undefined };
  }, SOCIAL);
  const sid = out.row.id;
  if (out.edited || (!out.pausing && !out.resuming)) {
    await writeActivity(tenantId, owner, "updated", "social_report_schedule", sid, {
      ...(b.scope !== undefined ? { scope } : {}), ...(engagementIds ? { clients: engagementIds.length } : {}), ...(timing ? { timing } : {}),
      previousOwner: out.row.owner_id,
    });
  }
  if (out.pausing) await writeActivity(tenantId, owner, "paused", "social_report_schedule", sid, { reason: "manual" });
  if (out.resuming) await writeActivity(tenantId, owner, "resumed", "social_report_schedule", sid, { previousReason: out.row.paused_reason, previousOwner: out.row.owner_id });
  return { schedule: await viewOf(tenantId, sid) };
}

/** `DELETE report-schedules/:id`: a soft delete. A run already started finishes. */
export async function deleteReportSchedule(principal: Principal, tenantId: string, id: string): Promise<{ id: string; deleted: true }> {
  const actor = await gate(principal, tenantId);
  const sid = await withTenants([tenantId], async (c) => {
    const row = await loadSchedule(c, tenantId, id, true);
    if (!row) throw new NotFoundException({ message: "schedule_not_found" });
    await c.query(`UPDATE social_report_schedules SET deleted_at = now(), deleted_by = $3, updated_by = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tenantId, row.id, actor]);
    return row.id;
  }, SOCIAL);
  await writeActivity(tenantId, actor, "deleted", "social_report_schedule", sid, {});
  return { id: sid, deleted: true };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Run now: POST report-schedules/:id/run
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export type RunNowAnswer = StartRunAnswer | { status: 200; body: { alreadyApplied: true; runId: string | null; period: string } };

/**
 * "Run now": a run of the schedule's kind for the period that has just ended, AS THE CALLER (`trigger: 'run_now'`, the caller's narrowing
 * within the schedule's scope), whether the schedule is on or off; `next_run_at` does not move. A period the schedule already ran answers
 * 200 `{alreadyApplied: true, runId}`; otherwise 202 as `POST reports/generate`, and 409 `generation_running` as there.
 */
export async function runReportScheduleNow(principal: Principal, tenantId: string, id: string): Promise<RunNowAnswer> {
  const actor = await gate(principal, tenantId);
  const row = await withTenants([tenantId], (c) => loadSchedule(c, tenantId, id), SOCIAL);
  if (!row) throw new NotFoundException({ message: "schedule_not_found" });
  const company = await withTenants([tenantId], (c) => socialRules(c, tenantId), SOCIAL);
  const period = lastEndedPeriod(row.kind, todayIsoInTz(config.reportsTz), company.rules.reports.fiscalYearStartMonth);
  const prior = await withTenants([tenantId], (c) => c.query<{ id: string }>(
    `SELECT id::text AS id FROM social_report_runs WHERE tenant_id = $1 AND schedule_id = $2 AND period = $3 LIMIT 1`, [tenantId, row.id, period]), SOCIAL);
  if (prior.rows[0]) return { status: 200, body: { alreadyApplied: true, runId: prior.rows[0].id, period } };
  let answer: StartRunAnswer;
  try {
    answer = await startReportRun(principal, tenantId, {
      kind: row.kind, period, ...(row.scope === "chosen" ? { engagementIds: row.engagement_ids } : {}),
    }, { trigger: "run_now", scheduleId: row.id, via: { ...(viaOfRequest(principal) ?? {}), scheduleId: row.id }, strictChosen: false });
  } catch (e) {
    if (e instanceof ConflictException && (e.getResponse() as { message?: string }).message === "schedule_period_has_run") {
      const detail = (e.getResponse() as { detail?: { runId?: string | null } }).detail;
      return { status: 200, body: { alreadyApplied: true, runId: detail?.runId ?? null, period } };
    }
    throw e;
  }
  const runId = answer.status === 202 ? answer.body.runId : answer.body.runId;
  await writeActivity(tenantId, actor, "run", "social_report_schedule", row.id, { runId, period, trigger: "run_now" });
  return answer;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The job `social-report-schedules`
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Why the owner may not run the schedule now, or null when they may (see the header's run-as-owner). Never throws on a plain denial. */
export async function ownerRefusal(c: PoolClient, tenantId: string, ownerId: string): Promise<{ reason: "owner_inactive" | "owner_not_allowed" } | { principal: Principal; approverIds: string[] }> {
  const p = await assemblePrincipal(ownerId, "linked");
  if (!p) return { reason: "owner_inactive" };
  if (isAutomationPrincipal(p) || !p.userId) return { reason: "owner_not_allowed" };
  const approverIds = await loadSocialApproverIds(c, tenantId);
  if (!(await mayPlan(p, tenantId, approverIds))) return { reason: "owner_not_allowed" };
  if (!(await check(p, socialReportResource(tenantId, "", approverIds), "create")).allow) return { reason: "owner_not_allowed" };
  return { principal: p, approverIds };
}

type Outcome =
  | { kind: "ran"; scheduleId: string; ownerId: string; runId: string; period: string; missed: number; via: Record<string, unknown> }
  | { kind: "paused"; scheduleId: string; ownerId: string; reason: Exclude<PausedReason, "manual">; scheduleKind: PeriodicKind; notifyOwner: boolean; approverIds: string[] }
  | { kind: "moved" | "passed" | "waiting" | "skipped"; scheduleId: string };

export interface ReportSchedulesSweepResult { tenants: number; claimed: number; ran: number; paused: number; moved: number; passed: number; waiting: number; errors: number }

/** TEST SEAM: called after a schedule is claimed (its row locked) and before anything else; tests hold it to prove the second instance skips. */
let afterClaimForTests: ((scheduleId: string) => Promise<void>) | null = null;
export function setReportScheduleClaimHookForTests(fn: ((scheduleId: string) => Promise<void>) | null): void {
  afterClaimForTests = fn;
}

async function pauseInTx(c: PoolClient, tenantId: string, row: ScheduleRow, reason: Exclude<PausedReason, "manual">): Promise<void> {
  await c.query(
    `UPDATE social_report_schedules SET enabled = false, paused_reason = $3, paused_at = now(), paused_by = NULL, next_run_at = NULL, next_period = NULL
      WHERE tenant_id = $1 AND id = $2`, [tenantId, row.id, reason]);
}

/** Claim one due schedule of the company and act on it in its row's transaction (see the header). Null when none is due. */
async function processOne(tenantId: string, seen: string[]): Promise<Outcome | null> {
  return withTenants([tenantId], async (c) => {
    const r = await c.query<ScheduleRow>(
      `SELECT ${SCHEDULE_COLUMNS} FROM social_report_schedules
        WHERE tenant_id = $1 AND enabled AND deleted_at IS NULL AND next_run_at <= now() AND NOT (id = ANY($2::uuid[]))
        ORDER BY next_run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`, [tenantId, seen]);
    const row = r.rows[0];
    if (!row) return null;
    seen.push(row.id);
    if (afterClaimForTests) await afterClaimForTests(row.id);

    const timing = parseTiming(row.kind, row.timing);
    if (!timing.ok || !row.next_period) {
      // eslint-disable-next-line no-console
      console.error(`[SOCIAL-REPORT-SCHEDULES] schedule ${row.id} (tenant ${tenantId}) has an unreadable timing; left as it is`);
      return { kind: "skipped", scheduleId: row.id };
    }
    const now = new Date();
    const behindDays = Math.max(0, Math.ceil((now.getTime() - new Date(row.next_run_at!).getTime()) / 86_400_000));
    const ctx = await timingContextFor(tenantId, now, behindDays, c);
    const due = dueAt(row.kind, timing.timing, row.next_period, now, ctx);
    const advance = (next: { runAt: Date; period: string }, ran: { period: string } | null) => c.query(
      `UPDATE social_report_schedules
          SET next_run_at = $3, next_period = $4, last_run_at = CASE WHEN $5::text IS NULL THEN last_run_at ELSE now() END,
              last_period = coalesce($5::text, last_period)
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, row.id, next.runAt.toISOString(), next.period, ran?.period ?? null]);
    if (!due.due) {
      await advance(due.next, null);
      return { kind: "moved", scheduleId: row.id };
    }

    // The company's rules now: a kind turned off, or drafted by hand, pauses the schedule.
    const company = await socialRules(c, tenantId);
    const kindRules = reportKindRules(company.rules, row.kind);
    const rulesPause: Exclude<PausedReason, "manual"> | null = !kindRules.enabled ? "kind_off" : !kindRules.aiDrafting ? "ai_drafting_off" : null;
    const owner = rulesPause ? null : await ownerRefusal(c, tenantId, row.owner_id);
    const reason = rulesPause ?? (owner && "reason" in owner ? owner.reason : null);
    if (reason) {
      await pauseInTx(c, tenantId, row, reason);
      return {
        kind: "paused", scheduleId: row.id, ownerId: row.owner_id, reason, scheduleKind: row.kind, notifyOwner: reason !== "owner_inactive",
        approverIds: await loadSocialApproverIds(c, tenantId),
      };
    }
    const { principal, approverIds } = owner as { principal: Principal; approverIds: string[] };

    const via = { automation: "report_schedule", scheduleId: row.id, missed: due.missed };
    let plan;
    try {
      plan = await planReportRun(principal, tenantId, approverIds, {
        kind: row.kind, period: due.period, ...(row.scope === "chosen" ? { engagementIds: row.engagement_ids } : {}),
      }, { strictChosen: false });
    } catch (e) {
      const code = e instanceof HttpException ? (e.getResponse() as { message?: string }).message : null;
      if (code === "report_kind_off" || code === "ai_drafting_off") {
        const why = code === "report_kind_off" ? "kind_off" : "ai_drafting_off";
        await pauseInTx(c, tenantId, row, why);
        return { kind: "paused", scheduleId: row.id, ownerId: row.owner_id, reason: why, scheduleKind: row.kind, notifyOwner: true, approverIds };
      }
      if (e instanceof HttpException) {
        // A period the engine refuses (it cannot be one this file computed): passed over, never retried every minute.
        // eslint-disable-next-line no-console
        console.error(`[SOCIAL-REPORT-SCHEDULES] schedule ${row.id} period ${due.period} refused (${code}); passed over`);
        await advance(due.next, null);
        return { kind: "passed", scheduleId: row.id };
      }
      throw e;
    }
    const runId = newId();
    try {
      await insertReportRun(c, tenantId, plan, { runId, requestedBy: row.owner_id, via, trigger: "schedule", scheduleId: row.id });
    } catch (e) {
      const code = e instanceof ConflictException ? (e.getResponse() as { message?: string }).message : null;
      if (code === "generation_running") return { kind: "waiting", scheduleId: row.id };
      if (code === "schedule_period_has_run") {
        await advance(due.next, null);
        return { kind: "passed", scheduleId: row.id };
      }
      throw e;
    }
    await advance(due.next, { period: due.period });
    return { kind: "ran", scheduleId: row.id, ownerId: row.owner_id, runId, period: due.period, missed: due.missed, via };
  }, SOCIAL);
}

/** `social.report_schedule.paused` to the owner (when still active) and the HoD and GM seats, naming the reason in words. Never throws. */
async function noticeOfPause(tenantId: string, o: Extract<Outcome, { kind: "paused" }>): Promise<void> {
  try {
    const dept = await withTenants([tenantId], (c) => findDepartmentBySlug(c, tenantId, "social-media"));
    const words = JOB_PAUSE_WORDS[o.reason];
    const recipients = new Set(lower(o.approverIds));
    // An inactive owner is never told, even while a seat row still names them.
    if (o.notifyOwner) recipients.add(o.ownerId.toLowerCase());
    else recipients.delete(o.ownerId.toLowerCase());
    for (const to of recipients) {
      await notify(tenantId, to, null, "social.report_schedule.paused", {
        title: `The ${o.scheduleKind} report schedule is paused: ${words}`,
        body: "Any of the four may resume it from Report automation in Settings, and becomes its owner.",
        href: dept ? `/departments/${dept.id}/settings` : "/departments#",
        entityType: "social_report_schedule", entityId: o.scheduleId, severity: "warning", reason: o.reason, kind: o.scheduleKind,
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[SOCIAL-REPORT-SCHEDULES] the pause notice of ${o.scheduleId} failed:`, (err as Error)?.message ?? err);
  }
}

/** After the row's transaction committed: the activity, the notices, and the run started as 63.24.5 starts it. */
async function afterCommit(tenantId: string, o: Outcome): Promise<void> {
  if (o.kind === "ran") {
    await writeActivity(tenantId, o.ownerId, "run", "social_report_schedule", o.scheduleId, {
      runId: o.runId, period: o.period, missed: o.missed, trigger: "schedule", via: o.via,
    }).catch(() => undefined);
    await launchReportRun(tenantId, o.runId);
  } else if (o.kind === "paused") {
    await writeActivity(tenantId, o.ownerId, "paused", "social_report_schedule", o.scheduleId, {
      reason: o.reason, via: { automation: "report_schedule", scheduleId: o.scheduleId },
    }).catch(() => undefined);
    await noticeOfPause(tenantId, o);
  }
}

/**
 * One sweep: per company, claim due schedules one at a time (`SKIP LOCKED`) and act on each (see the header). The runs it starts are not
 * awaited.
 */
export async function runReportSchedulesSweep(o: { only?: string[] } = {}): Promise<ReportSchedulesSweepResult> {
  const { rows: all } = await withGlobal((c) => c.query<{ id: string }>(`SELECT id::text AS id FROM companies WHERE deleted_at IS NULL`));
  const tenants = o.only ? all.filter((t) => o.only!.some((x) => x.toLowerCase() === t.id.toLowerCase())) : all;
  const out: ReportSchedulesSweepResult = { tenants: tenants.length, claimed: 0, ran: 0, paused: 0, moved: 0, passed: 0, waiting: 0, errors: 0 };
  for (const { id: tenantId } of tenants) {
    const seen: string[] = [];
    for (let i = 0; i < MAX_PER_COMPANY_PER_TICK; i++) {
      let outcome: Outcome | null;
      try {
        outcome = await processOne(tenantId, seen);
      } catch (err) {
        out.errors += 1;
        // eslint-disable-next-line no-console
        console.error(`[SOCIAL-REPORT-SCHEDULES] tenant ${tenantId} failed:`, (err as Error)?.message ?? err);
        continue;
      }
      if (!outcome) break;
      out.claimed += 1;
      if (outcome.kind === "ran") out.ran += 1;
      else if (outcome.kind === "paused") out.paused += 1;
      else if (outcome.kind === "moved") out.moved += 1;
      else if (outcome.kind === "passed") out.passed += 1;
      else if (outcome.kind === "waiting") out.waiting += 1;
      try {
        await afterCommit(tenantId, outcome);
      } catch (err) {
        out.errors += 1;
        // eslint-disable-next-line no-console
        console.error(`[SOCIAL-REPORT-SCHEDULES] after schedule ${outcome.scheduleId}:`, (err as Error)?.message ?? err);
      }
    }
  }
  return out;
}

/** The loop `main.ts` starts. The first sweep runs at once; each later one an interval after the last ended. */
export function startReportSchedulesLoop(intervalMs: number = REPORT_SCHEDULES_INTERVAL_MS): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const r = await runReportSchedulesSweep();
      if (r.claimed > 0 || r.errors > 0) {
        // eslint-disable-next-line no-console
        console.log("[SOCIAL-REPORT-SCHEDULES] sweep run:", r);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[SOCIAL-REPORT-SCHEDULES] tick failed:", (err as Error)?.message ?? err);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  void tick();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
