// SCP-1c — the data side of the cycle routes and the nightly ready-by job (BFF §63.4, §63.5): what is read, written and composed,
// around the pure maths of `schedule-health.ts`. Everything here runs on a caller-owned `withTenants([tenantId], fn, { modules: ["social"] })`
// client (the social tables carry the third wall), except `loadCalendarInfo`, which goes through `loadWorkingCalendar` and so declares
// the hr scope itself.
//
// THE HOLIDAY WINDOW. `loadWorkingCalendar` reads holidays between two days, so each reader first decides the days it will count over
// (`calendarWindow`): from the earliest day any step walks back to (a health handoff can sit up to six steps of 30 working days behind
// ready-by) to a little past the latest day. A holiday outside the window would silently read as a working day, so the window is a
// generous constant, and a ready-by recompute skips (and reports) any cycle whose deadline lies outside the window it was given.
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../../db";
import { config } from "../../../config";
import { loadWorkingCalendar, HOLIDAY_LOOKAHEAD_DAYS } from "../../reports/dept-kpi-readers/functional/working-calendar";
import { addDays, type WorkingCalendar } from "../../hr/working-days";
import { declareSocialModuleScope } from "../module-scope";
import { pushReadyByToContentMonthTask, syncContentMonthTask, type ContentMonthTaskResult } from "./content-month";
import { syncCycleStepTasks, type CycleStepTasksResult } from "./cycle-steps";
import { rulesRefFor, socialRules } from "./rules";
import {
  APPROVAL_WINDOW_DAYS, averageApprovalDays, clientHealth, isClientSlower, lastDayOfMonth, looksLikeIsoDate, parseStepEstimates,
  postHealth, postHolder, postPhase, prefillDeadline, readyByFor, tallyCounts,
  type ApprovalSample, type CountedPost, type CycleCounts, type DeliveryBatch, type Health, type HolderRole, type StepEstimates,
} from "./schedule-health";

// ── Settings ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The defaults of a company with no `social_settings` row (BFF §63.1). */
export const DEFAULT_BUFFER_WORKING_DAYS = 1;
export const DEFAULT_BOOST_CANDIDATE_FACTOR = 1.25;

export interface SocialSettings {
  bufferWorkingDays: number;
  boostCandidateFactor: number;
  /** SCP-5h (BFF §63.29.2): the company's client-onboarding PM project template, or null for none. */
  onboardingTemplateId: string | null;
}

/** The company's settings, or the defaults when it has no row. */
export async function readSettings(c: PoolClient, tenantId: string): Promise<SocialSettings> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ buffer_working_days: number; boost_candidate_factor: string; onboarding_template_id: string | null }>(
    `SELECT buffer_working_days, boost_candidate_factor, onboarding_template_id::text AS onboarding_template_id FROM social_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  const r = rows[0];
  return r
    ? { bufferWorkingDays: Number(r.buffer_working_days), boostCandidateFactor: Number(r.boost_candidate_factor), onboardingTemplateId: r.onboarding_template_id }
    : { bufferWorkingDays: DEFAULT_BUFFER_WORKING_DAYS, boostCandidateFactor: DEFAULT_BOOST_CANDIDATE_FACTOR, onboardingTemplateId: null };
}

// ── The company's calendar ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A ready-by walks back at most the buffer (10 working days); the slack covers a calendar with few working days. */
export const READY_BY_LOOKBACK_DAYS = 120;
/** SCP-5f (BFF §63.27.2): a cycle's step tasks walk back from ready-by by the client's estimates (up to six steps of 30 working days), so
 *  every write that dates them reads the holidays over the health window, not the ready-by one. */
export const CYCLE_STEPS_LOOKBACK_DAYS = 400;
/** A health handoff walks back up to six steps of 30 working days behind ready-by (about 250 calendar days), plus the 90-day approval look-back. */
export const HEALTH_LOOKBACK_DAYS = 400;

export interface CalendarInfo {
  calendar: WorkingCalendar;
  /** True when the company has a default holiday calendar; false means weekends only (plan §10). */
  known: boolean;
  name: string | null;
  /** The days the holidays were read for, inclusive. */
  window: { from: string; to: string };
}

/** The window of days a reader will count over: `lookbackDays` before its earliest anchor to the lookahead after its latest. */
export function calendarWindow(anchors: readonly string[], lookbackDays: number): { from: string; to: string } {
  const days = anchors.filter(looksLikeIsoDate).sort();
  if (days.length === 0) throw new Error("calendarWindow: no anchors");
  return { from: addDays(days[0], -lookbackDays), to: addDays(days[days.length - 1], HOLIDAY_LOOKAHEAD_DAYS) };
}

/** The company's default HR holiday calendar over the window of `anchors` (`loadWorkingCalendar`, which declares the hr scope), and its name. */
export async function loadCalendarInfo(tenantId: string, anchors: readonly string[], lookbackDays: number): Promise<CalendarInfo> {
  const window = calendarWindow(anchors, lookbackDays);
  const calendar = await loadWorkingCalendar(tenantId, window.from, window.to);
  // `loadWorkingCalendar` answers `{}` for a company with no default calendar and `{ weekendDays, holidays }` (holidays possibly empty) for one.
  const known = calendar.holidays !== undefined;
  let name: string | null = null;
  if (known) {
    name = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query<{ name: string }>(
          `SELECT name FROM hr_holiday_calendars WHERE tenant_id = $1::uuid AND is_default AND deleted_at IS NULL LIMIT 1`,
          [tenantId],
        );
        return r.rows[0]?.name ?? null;
      },
      { modules: ["hr"] },
    );
  }
  return { calendar, known, name, window };
}

/** "Today" for the company's report day. `REPORTS_TZ` is unset on live, so this is the UTC day there until DW-4 sets it (BFF §63.0). */
export { todayIsoInTz } from "../../reports/person-scope";

// ── Ready-by, written by the server only ───────────────────────────────────────────────────────────────────────────────────

/** The SQL predicate for an OPEN cycle: its content month has not ended (the month's last day is today or later). */
export const OPEN_CYCLE_SQL = `(c.month + interval '1 month' - interval '1 day')::date >= $2::date`;

/** The first and last deadline of the company's open cycles (the days a ready-by recompute walks back from), or null with none. */
export async function openCycleDeadlineRange(c: PoolClient, tenantId: string, today: string): Promise<{ min: string; max: string } | null> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ min: string | null; max: string | null }>(
    `SELECT to_char(min(c.deadline), 'YYYY-MM-DD') AS min, to_char(max(c.deadline), 'YYYY-MM-DD') AS max
       FROM social_cycles c WHERE c.tenant_id = $1 AND c.deleted_at IS NULL AND ${OPEN_CYCLE_SQL}`,
    [tenantId, today],
  );
  const r = rows[0];
  return r?.min && r.max ? { min: r.min, max: r.max } : null;
}

export interface RecomputeResult {
  /** Open cycles examined. */
  checked: number;
  /** Cycles whose ready-by changed. */
  updated: number;
  /** Cycles whose deadline lay outside the holiday window that was loaded (left for the next run). */
  skipped: number;
}

/**
 * Recompute `ready_by` for every open cycle of the company from its deadline, the buffer and the calendar, in the caller's transaction
 * (rows locked `FOR UPDATE`). Only a changed value is written. A cycle whose deadline is outside `[range.min, range.max]` (one created
 * between the caller's read of the range and this call) is skipped, because its holidays were not loaded.
 *
 * SCP-5f (BFF §63.27.3): every open cycle's step tasks are re-dated too, in cycle-id order (the rows' lock order), even when its ready-by
 * did not move: a holiday between a step's day and ready-by moves the step alone. The calendar must cover `CYCLE_STEPS_LOOKBACK_DAYS`.
 */
export async function recomputeOpenReadyBy(
  c: PoolClient,
  a: { tenantId: string; today: string; bufferWorkingDays: number; calendar: WorkingCalendar; range: { min: string; max: string }; actorId: string | null },
): Promise<RecomputeResult> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ id: string; deadline: string; ready_by: string }>(
    `SELECT c.id, to_char(c.deadline, 'YYYY-MM-DD') AS deadline, to_char(c.ready_by, 'YYYY-MM-DD') AS ready_by
       FROM social_cycles c WHERE c.tenant_id = $1 AND c.deleted_at IS NULL AND ${OPEN_CYCLE_SQL}
      ORDER BY c.id FOR UPDATE`,
    [a.tenantId, a.today],
  );
  let updated = 0;
  let skipped = 0;
  for (const r of rows) {
    if (r.deadline < a.range.min || r.deadline > a.range.max) { skipped += 1; continue; }
    const next = readyByFor(r.deadline, a.bufferWorkingDays, a.calendar);
    if (next !== r.ready_by) {
      await c.query(
        `UPDATE social_cycles SET ready_by = $3::date, updated_by = COALESCE($4, updated_by), updated_at = now() WHERE tenant_id = $1 AND id = $2`,
        [a.tenantId, r.id, next, a.actorId],
      );
      // SCP-1n: the cycle's content-month task is due on its ready-by, so it moves with it.
      await pushReadyByToContentMonthTask(c, a.tenantId, r.id, next, a.actorId);
      updated += 1;
    }
    // SCP-5f: then its step tasks (after the content-month task: the lock order), re-dated only (never made here).
    await syncCycleStepTasks(c, { tenantId: a.tenantId, cycleId: r.id, actorId: a.actorId, calendar: a.calendar, create: false });
  }
  return { checked: rows.length, updated, skipped };
}

/**
 * One `(engagement, month)` deadline written, in the caller's transaction: the upsert of the cycle row with its `ready_by`, then the content-month
 * PM task (`syncContentMonthTask`, BFF §63.13), then the cycle's step tasks (`syncCycleStepTasks`, BFF §63.27: made and re-dated, in that order,
 * which is the lock order). `PUT cycles` (BFF §63.5) writes each of its rows through this, and so does the sheet import (BFF §63.23) for a month
 * that has no cycle yet. `readyBy` is the caller's (`readyByFor`: the deadline, the buffer and the calendar); `calendar` dates the steps and must
 * cover `CYCLE_STEPS_LOOKBACK_DAYS` before the deadline.
 */
export async function writeCycleInTx(
  c: PoolClient,
  a: { tenantId: string; engagementId: string; month: string; deadline: string; readyBy: string; actorId: string | null; calendar: WorkingCalendar },
): Promise<{ cycleId: string; task: ContentMonthTaskResult; stepTasks: CycleStepTasksResult }> {
  // SCP-5 W5-A0 (BFF §63.30.3): a new cycle keeps the company's rules it was made under; an existing one keeps its own (the
  // upsert's UPDATE never touches `rules_ref`), so a rules change reaches new cycles only.
  const rulesRef = rulesRefFor(await socialRules(c, a.tenantId));
  const { rows: out } = await c.query<{ id: string }>(
    `INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by, created_by, updated_by, origin_site, rules_ref)
     VALUES ($1, $2, $3, $4::date, $5::date, $6::date, $7, $7, $8, $9)
     ON CONFLICT (tenant_id, engagement_id, month) WHERE deleted_at IS NULL
     DO UPDATE SET deadline = EXCLUDED.deadline, ready_by = EXCLUDED.ready_by, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING id`,
    [newId(), a.tenantId, a.engagementId, `${a.month}-01`, a.deadline, a.readyBy, a.actorId, config.originSite, rulesRef],
  );
  const cycleId = out[0].id;
  const task = await syncContentMonthTask(c, {
    tenantId: a.tenantId, cycleId, engagementId: a.engagementId, month: a.month, deadline: a.deadline, readyBy: a.readyBy, actorId: a.actorId,
  });
  const stepTasks = await syncCycleStepTasks(c, { tenantId: a.tenantId, cycleId, actorId: a.actorId, calendar: a.calendar, create: true });
  return { cycleId, task, stepTasks };
}

// The content-month PM task of a cycle (BFF §63.13) is SCP-1n's: `content-month.ts` (the task, made by `PUT cycles`) and
// `content-month-progress.ts` (its progress, written by the pipeline). This file only tells the task when its cycle's ready-by moved.

// ── The deadline table (GET cycles, and the answer of PUT cycles) ──────────────────────────────────────────────────────

export interface EngagementRow {
  id: string;
  clientName: string;
  officerId: string | null;
  officerName: string | null;
  deliveryBatch: DeliveryBatch | null;
  postsPerCycle: number | null;
  stepEstimates: StepEstimates;
}
export interface CycleRow {
  id: string;
  engagementId: string;
  month: string;
  deadline: string;
  readyBy: string;
}
export interface CyclePostRow extends CountedPost {
  id: string;
  cycleId: string;
  title: string;
  /** SCP-Sf: `social_posts.simulated` (the post went live through the social simulator), so every list of it can carry the mark. */
  simulated: boolean;
}

export interface CycleTableData {
  buffer: number;
  engagements: EngagementRow[];
  cycles: CycleRow[];
  posts: CyclePostRow[];
  /** The decided reviews of the last 90 days, per engagement. */
  samples: Map<string, ApprovalSample[]>;
}

/** The company's open (not closed, not deleted) engagements, by client name; `includeClosed` lifts the closed filter (a closed engagement's cycle still answers its health). */
export async function readEngagements(
  c: PoolClient, tenantId: string, engagementIds?: readonly string[], opts: { includeClosed?: boolean } = {},
): Promise<EngagementRow[]> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{
    id: string; client_name: string; owner_id: string | null; officer_name: string | null; delivery_batch: string | null;
    posts_per_cycle: number | null; step_estimates: unknown;
  }>(
    `SELECT e.id, cl.name AS client_name, e.owner_id, u.name AS officer_name, e.delivery_batch, e.posts_per_cycle, e.step_estimates
       FROM social_engagements e
       JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id
       LEFT JOIN users u ON u.id = e.owner_id
      WHERE e.tenant_id = $1 AND e.deleted_at IS NULL AND ($3::boolean OR e.status <> 'closed')
        AND ($2::uuid[] IS NULL OR e.id = ANY($2::uuid[]))
      ORDER BY lower(cl.name), cl.name, e.id`,
    [tenantId, engagementIds ? [...engagementIds] : null, opts.includeClosed === true],
  );
  return rows.map((r) => ({
    id: r.id, clientName: r.client_name, officerId: r.owner_id, officerName: r.officer_name,
    deliveryBatch: r.delivery_batch === "A" || r.delivery_batch === "B" ? r.delivery_batch : null,
    postsPerCycle: r.posts_per_cycle === null ? null : Number(r.posts_per_cycle),
    stepEstimates: parseStepEstimates(r.step_estimates),
  }));
}

const CYCLE_COLUMNS = `c.id, c.engagement_id, to_char(c.month, 'YYYY-MM') AS month,
  to_char(c.deadline, 'YYYY-MM-DD') AS deadline, to_char(c.ready_by, 'YYYY-MM-DD') AS ready_by`;
type CycleDbRow = { id: string; engagement_id: string; month: string; deadline: string; ready_by: string };
const toCycle = (r: CycleDbRow): CycleRow => ({ id: r.id, engagementId: r.engagement_id, month: r.month, deadline: r.deadline, readyBy: r.ready_by });

/** The live cycles of one content month. */
export async function readCyclesOfMonth(c: PoolClient, tenantId: string, month: string): Promise<CycleRow[]> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<CycleDbRow>(
    `SELECT ${CYCLE_COLUMNS} FROM social_cycles c WHERE c.tenant_id = $1 AND c.month = $2::date AND c.deleted_at IS NULL`,
    [tenantId, `${month}-01`],
  );
  return rows.map(toCycle);
}

/** One live cycle, or null (absent, deleted, or another company's: the tenant wall hides it). */
export async function readCycle(c: PoolClient, tenantId: string, cycleId: string): Promise<CycleRow | null> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<CycleDbRow>(
    `SELECT ${CYCLE_COLUMNS} FROM social_cycles c WHERE c.tenant_id = $1 AND c.id = $2 AND c.deleted_at IS NULL`,
    [tenantId, cycleId],
  );
  return rows[0] ? toCycle(rows[0]) : null;
}

/** The live pipeline posts of `cycleIds` (not deleted, not archived; a Composer post has no cycle). */
export async function readCyclePosts(c: PoolClient, tenantId: string, cycleIds: readonly string[]): Promise<CyclePostRow[]> {
  if (cycleIds.length === 0) return [];
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{
    id: string; cycle_id: string; title: string; pipeline_status: string; change_by: string | null; change_kind: string | null;
    return_to: string | null; changed_only: boolean; blocked_from: string | null; block_waiting_on: string | null; is_extra: boolean;
    format: string | null; simulated: boolean;
  }>(
    `SELECT p.id, p.cycle_id, p.title, p.pipeline_status, p.change_by, p.change_kind, p.return_to, p.changed_only, p.blocked_from,
            p.block_waiting_on, p.is_extra, p.format, p.simulated
       FROM social_posts p
      WHERE p.tenant_id = $1 AND p.cycle_id = ANY($2::uuid[]) AND p.pipeline_status IS NOT NULL
        AND p.deleted_at IS NULL AND p.archived_at IS NULL
      ORDER BY p.scheduled_at NULLS LAST, p.created_at, p.id`,
    [tenantId, [...cycleIds]],
  );
  return rows.map((r) => ({
    id: r.id, cycleId: r.cycle_id, title: r.title, status: r.pipeline_status, changeBy: r.change_by, changeKind: r.change_kind,
    returnTo: r.return_to, changedOnly: r.changed_only === true, blockedFrom: r.blocked_from, blockWaitingOn: r.block_waiting_on, isExtra: r.is_extra, format: r.format,
    simulated: r.simulated === true,
  }));
}

/**
 * The client's DECIDED reviews of the last 90 days, per engagement, as company-days (`requested_at` and `decided_at` in the company's
 * time zone): the samples of "the client is slower than usual". The reviews table keeps the plain tenant wall; the variants and posts it
 * joins are third-walled, which is why this runs on the social-scoped client.
 */
export async function readApprovalSamples(
  c: PoolClient, tenantId: string, engagementIds: readonly string[], today: string, tz: string,
): Promise<Map<string, ApprovalSample[]>> {
  const out = new Map<string, ApprovalSample[]>();
  if (engagementIds.length === 0) return out;
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ engagement_id: string; requested_on: string; decided_on: string }>(
    `SELECT p.engagement_id,
            to_char((r.requested_at AT TIME ZONE $4), 'YYYY-MM-DD') AS requested_on,
            to_char((r.decided_at AT TIME ZONE $4), 'YYYY-MM-DD') AS decided_on
       FROM social_post_client_reviews r
       JOIN social_post_variants v ON v.id = r.variant_id AND v.tenant_id = r.tenant_id
       JOIN social_posts p ON p.id = v.post_id AND p.tenant_id = v.tenant_id
      WHERE r.tenant_id = $1 AND p.engagement_id = ANY($2::uuid[])
        AND r.status IN ('approved', 'changes_requested') AND r.decided_at IS NOT NULL
        AND (r.decided_at AT TIME ZONE $4)::date > ($3::date - ${APPROVAL_WINDOW_DAYS})
        AND (r.decided_at AT TIME ZONE $4)::date <= $3::date`,
    [tenantId, [...engagementIds], today, tz],
  );
  for (const r of rows) {
    const list = out.get(r.engagement_id) ?? [];
    list.push({ requestedOn: r.requested_on, decidedOn: r.decided_on });
    out.set(r.engagement_id, list);
  }
  return out;
}

/** Everything the deadline table of `month` reads, in the caller's transaction. */
export async function readCycleTableData(c: PoolClient, tenantId: string, month: string, today: string, tz: string): Promise<CycleTableData> {
  const settings = await readSettings(c, tenantId);
  const engagements = await readEngagements(c, tenantId);
  const cycles = await readCyclesOfMonth(c, tenantId, month);
  const posts = await readCyclePosts(c, tenantId, cycles.map((x) => x.id));
  const withCycle = [...new Set(cycles.map((x) => x.engagementId))];
  const samples = await readApprovalSamples(c, tenantId, withCycle, today, tz);
  return { buffer: settings.bufferWorkingDays, engagements, cycles, posts, samples };
}

/** The days every holiday read of the deadline table must cover: the month, the month before (the pre-fill), today, the look-back of the averages, and each cycle's days. */
export function tableAnchors(month: string, today: string, cycles: readonly CycleRow[]): string[] {
  return [
    `${month}-01`, lastDayOfMonth(month), today, addDays(today, -(APPROVAL_WINDOW_DAYS + 10)), addDays(`${month}-01`, -62),
    ...cycles.flatMap((x) => [x.deadline, x.readyBy]),
  ];
}

export interface CycleTableRow {
  engagementId: string;
  clientName: string;
  officer: { id: string; name: string } | null;
  deliveryBatch: DeliveryBatch | null;
  cycleId: string | null;
  deadline: string | null;
  readyBy: string | null;
  prefill: { deadline: string | null; batch: DeliveryBatch | null };
  target: number | null;
  counts: CycleCounts;
  health: Health | null;
}
export interface CycleTable {
  month: string;
  bufferWorkingDays: number;
  holidaysKnown: boolean;
  canPlan: boolean;
  rows: CycleTableRow[];
}

const ZERO_COUNTS: CycleCounts = { counted: 0, planned: 0, inProduction: 0, withClient: 0, clientChanges: 0, approved: 0, scheduled: 0, live: 0, extra: 0, stories: 0 };

/** The client's "slower than usual" flag from its decided reviews and its `client` estimate. */
export function clientSlowerFor(e: EngagementRow, samples: Map<string, ApprovalSample[]>, calendar: WorkingCalendar): boolean {
  return isClientSlower(averageApprovalDays(samples.get(e.id) ?? [], calendar), e.stepEstimates.client);
}

/** Compose the deadline table of BFF §63.5 from what was read. PURE. */
export function composeCycleTable(data: CycleTableData, month: string, today: string, info: CalendarInfo, canPlan: boolean): CycleTable {
  const cycleOf = new Map(data.cycles.map((x) => [x.engagementId, x]));
  const postsOf = new Map<string, CyclePostRow[]>();
  for (const p of data.posts) postsOf.set(p.cycleId, [...(postsOf.get(p.cycleId) ?? []), p]);
  const rows = data.engagements.map((e): CycleTableRow => {
    const cycle = cycleOf.get(e.id) ?? null;
    const posts = cycle ? postsOf.get(cycle.id) ?? [] : [];
    let health: Health | null = null;
    if (cycle) {
      const slower = clientSlowerFor(e, data.samples, info.calendar);
      health = clientHealth(
        posts.map((p) => postHealth({ today, readyBy: cycle.readyBy, calendar: info.calendar, estimates: e.stepEstimates, clientSlower: slower, post: p })),
        cycle.readyBy,
      );
    }
    return {
      engagementId: e.id, clientName: e.clientName,
      officer: e.officerId ? { id: e.officerId, name: e.officerName ?? "" } : null,
      deliveryBatch: e.deliveryBatch,
      cycleId: cycle?.id ?? null, deadline: cycle?.deadline ?? null, readyBy: cycle?.readyBy ?? null,
      prefill: { deadline: prefillDeadline(month, e.deliveryBatch, info.calendar), batch: e.deliveryBatch },
      target: e.postsPerCycle,
      counts: cycle ? tallyCounts(posts) : { ...ZERO_COUNTS },
      health,
    };
  });
  return { month, bufferWorkingDays: data.buffer, holidaysKnown: info.known, canPlan, rows };
}

// ── One cycle's health (GET cycles/:cycleId/health) ────────────────────────────────────────────────────────────────────

export interface PostHealthRow {
  postId: string;
  title: string;
  status: string;
  phase: string | null;
  holder: HolderRole | null;
  isExtra: boolean;
  format: string | null;
  health: Health;
  /** SCP-Sf: the post went live through the social simulator (additive to BFF §63.5: the client page's cards carry the SIMULATED mark). */
  simulated: boolean;
}
export interface CycleHealthAnswer {
  cycleId: string;
  engagementId: string;
  clientName: string;
  month: string;
  deadline: string;
  readyBy: string;
  today: string;
  bufferWorkingDays: number;
  holidaysKnown: boolean;
  /** The client's step estimates (working days), as the maths read them. */
  estimates: StepEstimates;
  /** The client's average approval time over the last 90 days (working days), or null with no decided review. */
  averageApprovalDays: number | null;
  clientSlower: boolean;
  client: Health | null;
  posts: PostHealthRow[];
}

/** Compose one cycle's health answer. PURE. */
export function composeCycleHealth(
  cycle: CycleRow, e: EngagementRow, posts: readonly CyclePostRow[], samples: ApprovalSample[], buffer: number, today: string, info: CalendarInfo,
): CycleHealthAnswer {
  const average = averageApprovalDays(samples, info.calendar);
  const slower = isClientSlower(average, e.stepEstimates.client);
  const rows = posts.map((p): PostHealthRow => ({
    postId: p.id, title: p.title, status: p.status, phase: postPhase(p), holder: postHolder(p), isExtra: p.isExtra, format: p.format,
    simulated: p.simulated,
    health: postHealth({ today, readyBy: cycle.readyBy, calendar: info.calendar, estimates: e.stepEstimates, clientSlower: slower, post: p }),
  }));
  return {
    cycleId: cycle.id, engagementId: cycle.engagementId, clientName: e.clientName, month: cycle.month, deadline: cycle.deadline,
    readyBy: cycle.readyBy, today, bufferWorkingDays: buffer, holidaysKnown: info.known, estimates: e.stepEstimates,
    averageApprovalDays: average, clientSlower: slower, client: clientHealth(rows.map((r) => r.health), cycle.readyBy), posts: rows,
  };
}

/** The report-day time zone the sweeps and routes count in (`REPORTS_TZ`, UTC when unset). */
export const reportsTz = (): string => config.reportsTz;
