// TR-09 — the mandatory EOD check-in subsystem's endpoint surface (Blueprint §5.3, §6.2's
// "Check-ins" table, §8's `resource_checkin` row).
//
// The design constraint that shapes every decision in this file: submission must be possible in
// UNDER 30 SECONDS, or compliance dies in week two and the "daily report" becomes noise nobody
// trusts. That is why `GET /checkins/today` does real work (composeCheckinPrefill below) instead
// of handing back a blank textarea — the flow is confirm-and-edit, not write-from-scratch.
//
// ─────────────────────────── SUBSTRATE ALREADY LANDED (read, not rebuilt) ───────────────────────
// `report_checkins` / `report_work_calendars` (migration 0056) and the §5.3 false-negative guard
// (`expectedCheckinUsers`, `writeAutoMissedCheckins`, `loadWorkCalendar`) shipped with TR-07's
// fact-job.ts, ahead of this ticket, under the header "TR-09's substrate" — this file REUSES that
// pure predicate rather than re-deriving expected(), so there is exactly one place in the codebase
// that decides who was expected to check in on a given day. The only fact-job.ts change this
// ticket made is extracting the calendar-row parsing into the now-exported `loadWorkCalendar`, so
// the nightly hook and these live reads share one parser instead of two copies drifting apart.
//
// ─────────────────────────── THREE WALLS (same shape as every module surface) ───────────────────
//   1. Cerbos — `checkin` resource kind (cerbos/policies/resource_checkin.yaml): submit is
//      `member`-self ONLY (subjectUserId MUST equal the principal — never trusted from the
//      request body, there IS no subject field in the submit body for exactly that reason); read/
//      excuse admit platform_admin, group_executive, hr module_staff/module_manager, company_admin,
//      and `manager` (dept lead) — Cerbos's `manager` derived role is scoped at company/project,
//      NOT at a specific org unit (no such primitive exists in this codebase yet), so a bare
//      `manager` grant is COARSE. This file narrows it the rest of the way in-app (see
//      `isManagerTierOnly`/`ownCurrentUnit` below) to the caller's own current org unit, computed
//      server-side from `org_unit_memberships` — never from a client-supplied `unit`/`userId`
//      query param. That is the "controllers never trust client-supplied scope" rule applied to a
//      tier Cerbos itself cannot express yet; flagged for TR-25's parity-matrix pass.
//   2. The tenant choke-point — every query below runs inside `withTenants([tenantId], …)`.
//   3. Module-sliced RLS — `report_checkins`/`report_work_calendars` sit behind the `reports`
//      third wall; `hr_leave_requests`/`hr_attendance` behind `hr`'s. Every call below declares
//      `{modules: CHECKIN_MODULES}` (the SAME triple fact-job.ts declares), so a handler that
//      forgot a scope reads/writes ZERO rows in that module rather than leaking (fail-closed).
// Plus the per-tenant `ModuleEnabledGuard("reports")` gate, same as ReportsController.
//
// ─────────────────────────── DELIBERATE V1 BOUNDARY (say so, don't fake it) ───────────────────────
// §8's matrix names a fifth column, "served-dept case (provider lead, company A→B)", for checkin
// read/excuse. That is NOT implemented here. Every other cross-company view in this program (the
// department-grain provider view) is served EXCLUSIVELY through the D12 rollup/aggregate path,
// never a raw per-person row read across a tenant boundary (§8's hard rule 3: "Person-grain data
// for people outside your line is structurally unreachable"). A provider lead reading another
// company's individual check-in rows would violate exactly that rule, and no report-document/
// rollup path for check-ins exists yet (that is TR-13+ territory). Rather than fake a served-dept
// view with an approximation that could leak or under-scope silently, this ticket leaves it
// unimplemented and says so here, for TR-13/TR-25 to pick up once the aggregate path exists.
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { AuthGuard } from "../../auth/guards";
import { authorize, writeActivity } from "../../core/http";
import { addDaysIso } from "../../core/dept-resolution";
import { newId, withGlobal, withTenants } from "../../db";
import { config } from "../../config";
import type { Principal } from "../../rbac/principal";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import {
  DEFAULT_WORK_CALENDAR,
  expectedCheckinUsers,
  loadWorkCalendar,
  type WorkCalendar,
} from "./fact-job";

/** The exact triple fact-job.ts declares (`REPORT_JOB_MODULES`): `reports` for the report_* third
 *  wall, `hr` for the leave/attendance false-negative guard, `pm` for forward-compat visibility.
 *  Re-declared here (rather than imported) because fact-job.ts's constant is typed `readonly
 *  ["reports","pm","hr"]` for ITS OWN call sites; withTenants wants a plain `string[]`, and keeping
 *  two spellings of the same three strings in one file each would be worse than one local const. */
const CHECKIN_MODULES = ["reports", "pm", "hr"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_VALUES = new Set(["ui", "wa", "mcp", "system"]);
const MAX_RANGE_DAYS = 400; // mirrors reports.controller.ts's §6.2 ceiling — same DoS reasoning.

function assertDate(value: string | undefined, field: string): string {
  if (!value || !DATE_RE.test(value)) throw new BadRequestException(`${field} must be a YYYY-MM-DD date`);
  return value;
}

/** 'YYYY-MM-DD' for "today" in the deployment's `REPORTS_TZ` (Blueprint §6.2/OQ-1) — NOT
 *  `todayIso()` (dept-resolution.ts), which is UTC-only and exists for the org-structure PUT
 *  path's different "calendar day" convention. Check-ins are user-facing and must agree with the
 *  zone the rest of the reporting surface reads/writes in. `en-CA` is the one built-in
 *  `Intl.DateTimeFormat` locale that formats as `YYYY-MM-DD`, so no manual re-assembly of
 *  year/month/day parts (and no risk of a locale silently reordering them) is needed. */
export function todayIsoInTz(tz: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// ═══════════════════════════════ PURE CORE — the prefill composer ═══════════════════════════════
// House pattern (fact-job.ts, dept-resolution.ts): gather is I/O, compose is pure, so the <30s
// acceptance bar's actual CONTENT is unit-testable without a database.

export interface PrefillProjectMinutes {
  projectId: string;
  projectName: string;
  minutes: number;
}

export interface PrefillTaskRef {
  taskId: string;
  title: string;
}

export interface CheckinPrefillActivity {
  verb: string;
  objectKind: string;
  objectRef: string;
  title: string | null;
  source: string;
}

export interface CheckinPrefillTimeEntry {
  projectId: string;
  projectName: string;
  minutes: number;
  billable: boolean;
}

export interface PrefillGatherInputs {
  timeEntries: CheckinPrefillTimeEntry[];
  activities: CheckinPrefillActivity[];
}

export interface CheckinPrefill {
  summaryText: string;
  minutesLogged: number;
  minutesBillable: number;
  byProject: PrefillProjectMinutes[];
  tasksCompleted: PrefillTaskRef[];
  tasksCreated: PrefillTaskRef[];
  tasksMoved: PrefillTaskRef[]; // status_changed / reopened — "task moves" per the ticket brief
  commentsAuthored: number;
  docsUpdated: number;
  otherActivityEvents: number;
}

function formatMinutes(total: number): string {
  if (total <= 0) return "0m";
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** De-duplicate by `objectRef` (a task can emit more than one matching activity row in a day —
 *  e.g. completed then reopened then completed again, per fact-job.ts's same-day-ping-pong
 *  discipline) while preserving first-seen order, and keep the best-known title. */
function uniqueTaskRefs(activities: CheckinPrefillActivity[], verbs: string[]): PrefillTaskRef[] {
  const seen = new Map<string, string>();
  for (const a of activities) {
    if (a.objectKind !== "pm_task" || !verbs.includes(a.verb)) continue;
    if (!seen.has(a.objectRef)) seen.set(a.objectRef, a.title ?? `task ${a.objectRef.slice(0, 8)}`);
  }
  return [...seen.entries()].map(([taskId, title]) => ({ taskId, title }));
}

/** PURE. Same inputs -> same prefill, every time — what makes this testable without a database
 *  and what makes `edited` (POST /checkins) a plain string comparison against a RE-composed
 *  prefill rather than something persisted-and-diffed. */
export function composeCheckinPrefill(inputs: PrefillGatherInputs): CheckinPrefill {
  const byProjectMap = new Map<string, PrefillProjectMinutes>();
  let minutesLogged = 0;
  let minutesBillable = 0;
  for (const entry of inputs.timeEntries) {
    minutesLogged += entry.minutes;
    if (entry.billable) minutesBillable += entry.minutes;
    const existing = byProjectMap.get(entry.projectId);
    if (existing) existing.minutes += entry.minutes;
    else byProjectMap.set(entry.projectId, { projectId: entry.projectId, projectName: entry.projectName, minutes: entry.minutes });
  }
  const byProject = [...byProjectMap.values()].sort((a, b) => b.minutes - a.minutes || a.projectName.localeCompare(b.projectName));

  const tasksCompleted = uniqueTaskRefs(inputs.activities, ["completed"]);
  const tasksCreated = uniqueTaskRefs(inputs.activities, ["created"]);
  const tasksMoved = uniqueTaskRefs(inputs.activities, ["status_changed", "reopened"]).filter(
    (t) => !tasksCompleted.some((c) => c.taskId === t.taskId), // "completed" already tells that story
  );
  const commentsAuthored = inputs.activities.filter((a) => a.objectKind === "pm_task" && a.verb === "commented").length;
  const docsUpdated = inputs.activities.filter(
    (a) => a.objectKind === "doc" && (a.verb === "created" || a.verb === "updated" || a.verb === "restored"),
  ).length;
  const accountedForKinds = new Set(["pm_task", "doc"]);
  const otherActivityEvents = inputs.activities.filter((a) => !accountedForKinds.has(a.objectKind)).length;

  const parts: string[] = [];
  if (minutesLogged > 0) {
    const top = byProject.slice(0, 3).map((p) => p.projectName).join(", ");
    parts.push(`Logged ${formatMinutes(minutesLogged)} across ${byProject.length} project${byProject.length === 1 ? "" : "s"}${top ? ` (${top})` : ""}.`);
  }
  if (tasksCompleted.length > 0) {
    parts.push(`Completed: ${tasksCompleted.map((t) => t.title).join(", ")}.`);
  }
  if (tasksCreated.length > 0) {
    parts.push(`Created: ${tasksCreated.map((t) => t.title).join(", ")}.`);
  }
  if (tasksMoved.length > 0) {
    parts.push(`Moved: ${tasksMoved.map((t) => t.title).join(", ")}.`);
  }
  const evidenceBits: string[] = [];
  if (commentsAuthored > 0) evidenceBits.push(`${commentsAuthored} comment${commentsAuthored === 1 ? "" : "s"}`);
  if (docsUpdated > 0) evidenceBits.push(`${docsUpdated} doc update${docsUpdated === 1 ? "" : "s"}`);
  if (otherActivityEvents > 0) evidenceBits.push(`${otherActivityEvents} other activity event${otherActivityEvents === 1 ? "" : "s"}`);
  if (evidenceBits.length > 0) parts.push(`${evidenceBits.join(", ")}.`);

  const summaryText = parts.length > 0
    ? parts.join(" ")
    : "No tracked activity today yet — add a note before submitting.";

  return {
    summaryText,
    minutesLogged,
    minutesBillable,
    byProject,
    tasksCompleted,
    tasksCreated,
    tasksMoved,
    commentsAuthored,
    docsUpdated,
    otherActivityEvents,
  };
}

// ═══════════════════════════════ I/O EDGE — gather ═══════════════════════════════

/** All the substrate the prefill composer needs for ONE (tenant, user, date). Sequenced on the
 *  caller's shared client (§15's TR-08 lesson: concurrent `client.query()` calls on one `pg`
 *  client is a deprecated, warned-against pattern) — never `Promise.all`. */
async function gatherPrefillInputs(c: PoolClient, tenantId: string, userId: string, date: string, tz: string): Promise<PrefillGatherInputs> {
  const time = await c.query<{ project_id: string; project_name: string; minutes: string; billable: boolean }>(
    `SELECT te.project_id, p.name AS project_name, te.minutes, te.billable
       FROM time_entries te
       JOIN projects p ON p.id = te.project_id AND p.tenant_id = te.tenant_id
      WHERE te.tenant_id = $1 AND te.user_id = $2 AND te.entry_date = $3::date AND te.deleted_at IS NULL
      ORDER BY te.id`,
    [tenantId, userId, date],
  );
  const activity = await c.query<{ verb: string; object_kind: string; object_ref: string; title: string | null; source: string }>(
    `SELECT verb, object_kind, object_ref, title, source
       FROM work_activity
      WHERE tenant_id = $1 AND actor_user_id = $2 AND (occurred_at AT TIME ZONE $4)::date = $3::date
      ORDER BY occurred_at`,
    [tenantId, userId, date, tz],
  );
  return {
    timeEntries: time.rows.map((r) => ({ projectId: r.project_id, projectName: r.project_name, minutes: Number(r.minutes), billable: r.billable })),
    activities: activity.rows.map((r) => ({ verb: r.verb, objectKind: r.object_kind, objectRef: r.object_ref, title: r.title, source: r.source })),
  };
}

// ═══════════════════════════════ I/O EDGE — expected()-for-one-user helpers ═══════════════════════

async function isEmployedAsOf(c: PoolClient, tenantId: string, userId: string, date: string): Promise<boolean> {
  const { rowCount } = await c.query(
    `SELECT 1 FROM org_unit_memberships
      WHERE tenant_id = $1 AND user_id = $2 AND is_primary
        AND valid_from <= $3::date AND (valid_to IS NULL OR valid_to >= $3::date)
      LIMIT 1`,
    [tenantId, userId, date],
  );
  return (rowCount ?? 0) > 0;
}

async function isOnApprovedLeave(c: PoolClient, tenantId: string, userId: string, date: string): Promise<boolean> {
  const { rowCount } = await c.query(
    `SELECT 1 FROM hr_leave_requests
      WHERE tenant_id = $1 AND subject_user_id = $2 AND status = 'approved' AND deleted_at IS NULL
        AND starts_on <= $3::date AND ends_on >= $3::date
      LIMIT 1`,
    [tenantId, userId, date],
  );
  return (rowCount ?? 0) > 0;
}

async function isAttendanceOff(c: PoolClient, tenantId: string, userId: string, date: string): Promise<boolean> {
  const { rowCount } = await c.query(
    `SELECT 1 FROM hr_attendance WHERE tenant_id = $1 AND subject_user_id = $2 AND day = $3::date AND status IN ('leave','absent')`,
    [tenantId, userId, date],
  );
  return (rowCount ?? 0) > 0;
}

/** §5.3's expected() for exactly one (user, date) — reuses `expectedCheckinUsers` (fact-job.ts)
 *  with single-element arrays rather than re-deriving the predicate, so there is still exactly ONE
 *  place that decides expected-ness; this is just its one-user projection. */
async function isExpectedToday(c: PoolClient, tenantId: string, userId: string, date: string, calendar: WorkCalendar): Promise<boolean> {
  const [employed, onLeave, attOff] = [
    await isEmployedAsOf(c, tenantId, userId, date),
    await isOnApprovedLeave(c, tenantId, userId, date),
    await isAttendanceOff(c, tenantId, userId, date),
  ];
  return expectedCheckinUsers({
    date,
    calendar,
    employed: employed ? [userId] : [],
    approvedLeave: onLeave ? [userId] : [],
    attendanceOff: attOff ? [userId] : [],
  }).length > 0;
}

async function ownCurrentUnit(c: PoolClient, tenantId: string, userId: string, date: string): Promise<string | null> {
  const { rows } = await c.query<{ unit_node_id: string }>(
    `SELECT unit_node_id FROM org_unit_memberships
      WHERE tenant_id = $1 AND user_id = $2 AND is_primary
        AND valid_from <= $3::date AND (valid_to IS NULL OR valid_to >= $3::date)
      LIMIT 1`,
    [tenantId, userId, date],
  );
  return rows[0]?.unit_node_id ?? null;
}

/** Does this principal hold ONLY the coarse `manager` grant in this tenant — i.e. none of the
 *  broader tiers (platform_admin/group_executive/company_admin/hr staff-or-manager) that already
 *  see the whole company? Read directly off `principal.roles` (server-assembled from `user_roles`
 *  at auth time — never client input), the same shape Cerbos's derived roles evaluate. Used ONLY
 *  to decide whether to apply the in-app own-unit narrowing described in this file's header; it is
 *  never itself an authorization decision (Cerbos's `authorize()` call already gated the request). */
function isManagerTierOnly(principal: Principal, tenantId: string): boolean {
  const has = (role: string, extra?: (g: Principal["roles"][number]) => boolean) =>
    principal.roles.some((g) => g.role === role && (g.scopeType === "global" || (g.scopeType === "company" && g.scopeId === tenantId)) && (!extra || extra(g)));
  const broad = has("platform_admin") || has("group_executive") || has("company_admin") || has("hr_staff") || has("hr_manager");
  const manager = principal.roles.some(
    (g) => g.role === "manager" && (g.scopeType === "global" || (g.scopeType === "company" && g.scopeId === tenantId) || g.scopeType === "project"),
  );
  return manager && !broad;
}

// ═══════════════════════════════ PURE CORE — the compliance grid ═══════════════════════════════

export interface ComplianceInputRow {
  userId: string;
  date: string; // 'YYYY-MM-DD'
  status: "submitted" | "auto_missed" | "excused";
}

export interface ComplianceMembershipRow {
  userId: string;
  unitNodeId: string;
  validFrom: string;
  validTo: string | null;
}

export interface ComplianceGridInputs {
  from: string;
  to: string;
  calendar: WorkCalendar;
  memberships: ComplianceMembershipRow[]; // every primary interval overlapping [from, to]
  approvedLeave: { userId: string; startsOn: string; endsOn: string }[];
  attendanceOff: { userId: string; day: string }[];
  checkins: ComplianceInputRow[];
  /** When set, only users whose as-of-that-day unit equals this are included (the in-app own-unit
   *  narrowing described in the file header; `null` = no unit filter, whole company). */
  unitFilter: string | null;
}

export interface ComplianceRow {
  userId: string;
  expectedDays: number;
  submittedDays: number;
  missedDays: number;
  excusedDays: number;
  complianceRate: number | null; // submitted / expected; null when expectedDays === 0 (never divide by zero)
}

function withinInterval(date: string, validFrom: string, validTo: string | null): boolean {
  return validFrom <= date && (validTo === null || validTo >= date);
}

/** PURE. Walks every day in [from, to] and tallies, per user, expected/submitted/missed/excused —
 *  the compliance grid `GET /checkins/compliance` returns. Day-by-day (not one aggregate query) on
 *  purpose: `expectedCheckinUsers` is the single authority on expected-ness and it is a per-day
 *  predicate (calendar/holiday are day properties; leave/attendance are date-range/date-row
 *  properties resolved per day), so re-deriving it per day is what keeps this grid and the nightly
 *  auto_missed writer agreeing on every single day, never just in aggregate. */
export function buildComplianceGrid(inputs: ComplianceGridInputs): ComplianceRow[] {
  const byUser = new Map<string, ComplianceRow>();
  const checkinByUserDate = new Map<string, ComplianceInputRow["status"]>();
  for (const row of inputs.checkins) checkinByUserDate.set(`${row.userId}|${row.date}`, row.status);

  const membershipsByUser = new Map<string, ComplianceMembershipRow[]>();
  for (const m of inputs.memberships) {
    (membershipsByUser.get(m.userId) ?? membershipsByUser.set(m.userId, []).get(m.userId)!).push(m);
  }

  for (let date = inputs.from; date <= inputs.to; date = addDaysIso(date, 1)) {
    const employedToday = [...membershipsByUser.entries()]
      .filter(([, intervals]) => {
        const hit = intervals.find((i) => withinInterval(date, i.validFrom, i.validTo));
        if (!hit) return false;
        return inputs.unitFilter === null || hit.unitNodeId === inputs.unitFilter;
      })
      .map(([userId]) => userId);

    const approvedLeave = inputs.approvedLeave.filter((l) => l.startsOn <= date && l.endsOn >= date).map((l) => l.userId);
    const attendanceOff = inputs.attendanceOff.filter((a) => a.day === date).map((a) => a.userId);

    const expected = expectedCheckinUsers({ date, calendar: inputs.calendar, employed: employedToday, approvedLeave, attendanceOff });
    for (const userId of expected) {
      const row = byUser.get(userId) ?? { userId, expectedDays: 0, submittedDays: 0, missedDays: 0, excusedDays: 0, complianceRate: null };
      row.expectedDays += 1;
      const status = checkinByUserDate.get(`${userId}|${date}`);
      if (status === "submitted") row.submittedDays += 1;
      else if (status === "excused") row.excusedDays += 1;
      else row.missedDays += 1; // covers auto_missed AND "no row written yet" (e.g. today, or the
      // nightly job hasn't run for this date yet) uniformly — both mean "not accounted for".
      byUser.set(userId, row);
    }
  }

  for (const row of byUser.values()) row.complianceRate = row.expectedDays > 0 ? row.submittedDays / row.expectedDays : null;
  return [...byUser.values()].sort((a, b) => a.userId.localeCompare(b.userId));
}

// ═══════════════════════════════ PURE CORE — period resolution ═══════════════════════════════

/** `periodKind=day|week|month|custom` -> an inclusive [from, to]. Deliberately NOT the full
 *  §6.1 `ReportPeriodKind` machinery (that lives in TR-13's not-yet-built report-document.ts) —
 *  week/month here are plain ISO-week/calendar-month arithmetic, which is all the compliance grid
 *  needs. `custom` mirrors §6.2's own rule: `end` is required and the range is capped so an
 *  unbounded caller-chosen window can't turn this into a 400-row-per-day-times-N-days scan. */
export function resolveCheckinPeriod(periodKind: string | undefined, start: string | undefined, end: string | undefined): { from: string; to: string } {
  const kind = periodKind ?? "day";
  const s = assertDate(start, "start");
  if (kind === "day") return { from: s, to: s };
  if (kind === "week") {
    const dow = new Date(`${s}T00:00:00.000Z`).getUTCDay() || 7; // Mon=1..Sun=7
    const from = addDaysIso(s, -(dow - 1));
    return { from, to: addDaysIso(from, 6) };
  }
  if (kind === "month") {
    const [y, m] = s.split("-");
    const from = `${y}-${m}-01`;
    const nextMonth = new Date(`${y}-${m}-01T00:00:00.000Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const to = addDaysIso(nextMonth.toISOString().slice(0, 10), -1);
    return { from, to };
  }
  if (kind === "custom") {
    const e = assertDate(end, "end");
    if (e < s) throw new BadRequestException("end must be on or after start");
    return { from: s, to: e };
  }
  throw new BadRequestException("periodKind must be one of day, week, month, custom");
}

function assertRangeWithinCeiling(from: string, to: string): void {
  const days = Math.floor((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new UnprocessableEntityException({ message: "range_too_large", field: "end" });
  }
}

// ═══════════════════════════════ THE CONTROLLER ═══════════════════════════════

@Controller("api/:tenantId/checkins")
@UseGuards(AuthGuard, ModuleEnabledGuard("reports"))
export class CheckinsController {
  /** `GET /checkins/today` — self only. The <30s flow's whole reason to exist: a REAL, live-
   *  derived draft, not a blank form. */
  @Get("today")
  async today(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    const userId = req.principal.userId;
    if (!userId) throw new BadRequestException("no principal user");
    await authorize(req.principal, { kind: "checkin", tenantId, subjectUserId: userId }, "read");

    const tz = config.reportsTz;
    const date = todayIsoInTz(tz);
    return withTenants(
      [tenantId],
      async (c) => {
        const calendar = await loadWorkCalendar(c, tenantId);
        const expected = await isExpectedToday(c, tenantId, userId, date, calendar);
        const existing = await c.query<{
          id: string; status: string; summary: string; blockers: string | null;
          edited: boolean; source: string; submitted_at: string | null;
        }>(
          `SELECT id, status, summary, blockers, edited, source, submitted_at::text AS submitted_at
             FROM report_checkins WHERE tenant_id = $1 AND user_id = $2 AND checkin_date = $3::date`,
          [tenantId, userId, date],
        );
        const gathered = await gatherPrefillInputs(c, tenantId, userId, date, tz);
        const draft = composeCheckinPrefill(gathered);
        const row = existing.rows[0] ?? null;
        return {
          date,
          expected,
          alreadySubmitted: row?.status === "submitted",
          existing: row
            ? {
                id: row.id, status: row.status, summary: row.summary, blockers: row.blockers,
                edited: row.edited, source: row.source, submittedAt: row.submitted_at,
              }
            : null,
          draft,
        };
      },
      { modules: CHECKIN_MODULES },
    );
  }

  /** `POST /checkins` — submit/confirm. Self only (subjectUserId is ALWAYS `req.principal.userId`,
   *  never read off the body); one row per (tenant, user, date) via the table's own UNIQUE key,
   *  enforced here as an upsert rather than a bare INSERT so the "confirm" half of confirm-and-edit
   *  (re-POSTing the same day to fix a typo) does not 23505 the caller. */
  @Post()
  @HttpCode(200)
  async submit(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { date?: string; summary?: string; blockers?: string; source?: string },
  ) {
    const userId = req.principal.userId;
    if (!userId) throw new BadRequestException("no principal user");
    await authorize(req.principal, { kind: "checkin", tenantId, subjectUserId: userId }, "submit");

    const summary = typeof body?.summary === "string" ? body.summary.trim() : "";
    if (summary.length === 0) throw new BadRequestException("summary must be non-empty");
    const blockers = typeof body?.blockers === "string" && body.blockers.trim().length > 0 ? body.blockers.trim() : null;
    const source = body?.source ?? "ui";
    if (!SOURCE_VALUES.has(source)) throw new BadRequestException("source must be one of ui, wa, mcp, system");

    const tz = config.reportsTz;
    const today = todayIsoInTz(tz);
    const yesterday = addDaysIso(today, -1);
    const date = body?.date ? assertDate(body.date, "date") : today;
    // "today or yesterday-until-cutoff" (§6.2). No hour-based cutoff is specified anywhere in the
    // design doc, so rather than invent an unspecified constant, the cutoff this ships is: submit
    // is open for today or yesterday, UNTIL a manager/HR has already excused that day (a submit
    // after an excuse would silently override an audited decision — see the 409 below). Flagged in
    // the ticket report as a scoping decision, not a silent guess.
    if (date !== today && date !== yesterday) {
      throw new BadRequestException("date must be today or yesterday");
    }

    return withTenants(
      [tenantId],
      async (c) => {
        const gathered = await gatherPrefillInputs(c, tenantId, userId, date, tz);
        const prefill = composeCheckinPrefill(gathered);
        const edited = summary !== prefill.summaryText.trim();

        const existing = await c.query<{ id: string; status: string }>(
          `SELECT id, status FROM report_checkins WHERE tenant_id = $1 AND user_id = $2 AND checkin_date = $3::date`,
          [tenantId, userId, date],
        );
        const prior = existing.rows[0];
        if (prior?.status === "excused") {
          throw new ConflictException("this day was already excused — ask your manager/HR to reopen it");
        }

        let id: string;
        if (prior) {
          id = prior.id;
          await c.query(
            `UPDATE report_checkins
                SET status = 'submitted', summary = $3, blockers = $4, prefill = $5::jsonb,
                    edited = $6, source = $7, submitted_at = now(), updated_at = now()
              WHERE id = $1 AND tenant_id = $2`,
            [id, tenantId, summary, blockers, JSON.stringify(prefill), edited, source],
          );
        } else {
          id = newId();
          await c.query(
            `INSERT INTO report_checkins
               (id, tenant_id, user_id, checkin_date, status, summary, blockers, prefill, edited, source, submitted_at, origin_site)
             VALUES ($1,$2,$3,$4::date,'submitted',$5,$6,$7::jsonb,$8,$9,now(),$10)`,
            // Ruling: origin_site has NO column default (§15) — always pass config.originSite explicitly.
            [id, tenantId, userId, date, summary, blockers, JSON.stringify(prefill), edited, source, config.originSite],
          );
        }

        await writeActivity(tenantId, userId, "submitted", "report_checkin", id, { date, edited, source });

        return { id, date, status: "submitted", summary, blockers, edited, source };
      },
      { modules: CHECKIN_MODULES },
    );
  }

  /** `GET /checkins?userId&from&to` — history. Self is always allowed (Cerbos `member` self rule);
   *  reading someone else's history requires a broader Cerbos tier, further narrowed in-app to the
   *  caller's own org unit when that tier is bare `manager` (see `isManagerTierOnly`). */
  @Get()
  async history(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("userId") userIdParam: string | undefined,
    @Query("from") fromParam: string | undefined,
    @Query("to") toParam: string | undefined,
  ) {
    const principal = req.principal;
    const subjectUserId = userIdParam || principal.userId;
    if (!subjectUserId) throw new BadRequestException("userId is required");
    const from = assertDate(fromParam, "from");
    const to = assertDate(toParam, "to");
    if (to < from) throw new BadRequestException("to must be on or after from");
    assertRangeWithinCeiling(from, to);

    // `module: "hr"` is a Cerbos-attribute reuse of the generic module_staff/module_manager
    // derived role (resource_checkin.yaml) so an hr_staff/hr_manager grant is recognized as §8's
    // "HR-appraisal role" tier for this non-HR-module resource kind — orthogonal to the actual
    // module-sliced RLS wall below (`{modules: CHECKIN_MODULES}`), which is unaffected either way.
    await authorize(principal, { kind: "checkin", tenantId, subjectUserId, module: "hr" }, "read");

    const tz = config.reportsTz;
    return withTenants(
      [tenantId],
      async (c) => {
        if (subjectUserId !== principal.userId && isManagerTierOnly(principal, tenantId)) {
          const today = todayIsoInTz(tz);
          const mine = principal.userId ? await ownCurrentUnit(c, tenantId, principal.userId, today) : null;
          const theirs = await ownCurrentUnit(c, tenantId, subjectUserId, today);
          if (!mine || mine !== theirs) throw new ForbiddenException("outside your unit");
        }
        const rows = await c.query<{
          id: string; checkin_date: string; status: string; summary: string; blockers: string | null;
          edited: boolean; source: string; submitted_at: string | null; excused_reason: string | null;
        }>(
          `SELECT id, checkin_date::text AS checkin_date, status, summary, blockers, edited, source,
                  submitted_at::text AS submitted_at, excused_reason
             FROM report_checkins
            WHERE tenant_id = $1 AND user_id = $2 AND checkin_date BETWEEN $3::date AND $4::date
            ORDER BY checkin_date DESC`,
          [tenantId, subjectUserId, from, to],
        );
        return {
          userId: subjectUserId,
          from,
          to,
          checkins: rows.rows.map((r) => ({
            id: r.id, date: r.checkin_date, status: r.status, summary: r.summary, blockers: r.blockers,
            edited: r.edited, source: r.source, submittedAt: r.submitted_at, excusedReason: r.excused_reason,
          })),
        };
      },
      { modules: CHECKIN_MODULES },
    );
  }

  /** `GET /checkins/compliance?unit&periodKind&start[&end]` — the grid. Self (`member`) is
   *  structurally excluded: Cerbos's self rule requires `subjectUserId`, which this action never
   *  sets, so only lead/exec/HR/admin tiers can ever pass — matching §8's "self ⛔" cell exactly. */
  @Get("compliance")
  async compliance(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("unit") unitParam: string | undefined,
    @Query("periodKind") periodKindParam: string | undefined,
    @Query("start") startParam: string | undefined,
    @Query("end") endParam: string | undefined,
  ) {
    const principal = req.principal;
    await authorize(principal, { kind: "checkin", tenantId, module: "hr" }, "read");

    const { from, to } = resolveCheckinPeriod(periodKindParam, startParam, endParam);
    assertRangeWithinCeiling(from, to);

    const tz = config.reportsTz;
    return withTenants(
      [tenantId],
      async (c) => {
        let unitFilter: string | null = unitParam ?? null;
        if (isManagerTierOnly(principal, tenantId)) {
          // Never trust the client-supplied `unit` param for this tier — override with the
          // caller's OWN unit, server-computed. A bare manager grant with no resolvable unit sees
          // an empty grid rather than an error (there is simply nothing in scope for them).
          const today = todayIsoInTz(tz);
          unitFilter = principal.userId ? await ownCurrentUnit(c, tenantId, principal.userId, today) : null;
          if (!unitFilter) return { from, to, unit: null, rows: [] };
        }

        const calendar = await loadWorkCalendar(c, tenantId);
        const memberships = await c.query<{ user_id: string; unit_node_id: string; valid_from: string; valid_to: string | null }>(
          `SELECT user_id, unit_node_id, valid_from::text AS valid_from, valid_to::text AS valid_to
             FROM org_unit_memberships
            WHERE tenant_id = $1 AND is_primary AND valid_from <= $3::date AND (valid_to IS NULL OR valid_to >= $2::date)`,
          [tenantId, from, to],
        );
        const leave = await c.query<{ subject_user_id: string; starts_on: string; ends_on: string }>(
          `SELECT subject_user_id, starts_on::text AS starts_on, ends_on::text AS ends_on
             FROM hr_leave_requests
            WHERE tenant_id = $1 AND status = 'approved' AND deleted_at IS NULL
              AND starts_on <= $3::date AND ends_on >= $2::date`,
          [tenantId, from, to],
        );
        const attendance = await c.query<{ subject_user_id: string; day: string }>(
          `SELECT subject_user_id, day::text AS day FROM hr_attendance
            WHERE tenant_id = $1 AND day BETWEEN $2::date AND $3::date AND status IN ('leave','absent')`,
          [tenantId, from, to],
        );
        const checkins = await c.query<{ user_id: string; checkin_date: string; status: string }>(
          `SELECT user_id, checkin_date::text AS checkin_date, status FROM report_checkins
            WHERE tenant_id = $1 AND checkin_date BETWEEN $2::date AND $3::date`,
          [tenantId, from, to],
        );

        const rows = buildComplianceGrid({
          from,
          to,
          calendar,
          memberships: memberships.rows.map((r) => ({ userId: r.user_id, unitNodeId: r.unit_node_id, validFrom: r.valid_from, validTo: r.valid_to })),
          approvedLeave: leave.rows.map((r) => ({ userId: r.subject_user_id, startsOn: r.starts_on, endsOn: r.ends_on })),
          attendanceOff: attendance.rows.map((r) => ({ userId: r.subject_user_id, day: r.day })),
          checkins: checkins.rows.map((r) => ({ userId: r.user_id, date: r.checkin_date, status: r.status as ComplianceInputRow["status"] })),
          unitFilter,
        });
        return { from, to, unit: unitFilter, rows };
      },
      { modules: CHECKIN_MODULES },
    );
  }

  /** `POST /checkins/:id/excuse` — audited. Only an `auto_missed` row can be excused (a submitted
   *  day needs no excuse; re-excusing an already-excused row is a no-op the caller should read as
   *  idempotent success, not retry). */
  @Post(":id/excuse")
  @HttpCode(200)
  async excuse(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { reason?: string },
  ) {
    const principal = req.principal;
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (reason.length === 0) throw new BadRequestException("reason must be non-empty");

    return withTenants(
      [tenantId],
      async (c) => {
        const existing = await c.query<{ id: string; user_id: string; status: string }>(
          `SELECT id, user_id, status FROM report_checkins WHERE tenant_id = $1 AND id = $2`,
          [tenantId, id],
        );
        const row = existing.rows[0];
        if (!row) throw new NotFoundException("check-in not found");

        await authorize(principal, { kind: "checkin", tenantId, subjectUserId: row.user_id, id, module: "hr" }, "excuse");

        if (isManagerTierOnly(principal, tenantId)) {
          const today = todayIsoInTz(config.reportsTz);
          const mine = principal.userId ? await ownCurrentUnit(c, tenantId, principal.userId, today) : null;
          const theirs = await ownCurrentUnit(c, tenantId, row.user_id, today);
          if (!mine || mine !== theirs) throw new ForbiddenException("outside your unit");
        }

        if (row.status === "submitted") {
          throw new ConflictException("cannot excuse a day that was already submitted");
        }
        if (row.status !== "excused") {
          await c.query(
            `UPDATE report_checkins SET status = 'excused', excused_reason = $3, excused_by = $4, updated_at = now()
              WHERE id = $1 AND tenant_id = $2`,
            [id, tenantId, reason, principal.userId],
          );
        }

        await writeActivity(tenantId, principal.userId, "excused", "report_checkin", id, { subjectUserId: row.user_id, reason });

        return { id, status: "excused", excusedReason: reason };
      },
      { modules: CHECKIN_MODULES },
    );
  }

  /** `GET /checkins/pending-reminders?date` — service/admin only; the n8n-facing read (TR-11
   *  wires the actual reminder flow). Defaults to TODAY (nagging, before EOD) but accepts a past
   *  `date` too (TR-11's escalation message needs "yesterday's misses"). Deliberately does NOT
   *  reuse `writeAutoMissedCheckins` — that only ever fires for PAST days and WRITES rows; this is
   *  a same-day-safe READ that never marks anything missed, so it can be polled all afternoon
   *  without side effects. */
  @Get("pending-reminders")
  async pendingReminders(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("date") dateParam: string | undefined) {
    await authorize(req.principal, { kind: "checkin", tenantId }, "pending_reminders");

    const tz = config.reportsTz;
    const date = dateParam ? assertDate(dateParam, "date") : todayIsoInTz(tz);

    const pendingUserIds = await withTenants(
      [tenantId],
      async (c) => {
        const calendar = await loadWorkCalendar(c, tenantId);
        const employed = await c.query<{ user_id: string }>(
          `SELECT DISTINCT user_id FROM org_unit_memberships
            WHERE tenant_id = $1 AND is_primary AND valid_from <= $2::date AND (valid_to IS NULL OR valid_to >= $2::date)`,
          [tenantId, date],
        );
        const leave = await c.query<{ subject_user_id: string }>(
          `SELECT DISTINCT subject_user_id FROM hr_leave_requests
            WHERE tenant_id = $1 AND status = 'approved' AND deleted_at IS NULL AND starts_on <= $2::date AND ends_on >= $2::date`,
          [tenantId, date],
        );
        const attendance = await c.query<{ subject_user_id: string }>(
          `SELECT subject_user_id FROM hr_attendance WHERE tenant_id = $1 AND day = $2::date AND status IN ('leave','absent')`,
          [tenantId, date],
        );
        const expected = expectedCheckinUsers({
          date,
          calendar,
          employed: employed.rows.map((r) => r.user_id),
          approvedLeave: leave.rows.map((r) => r.subject_user_id),
          attendanceOff: attendance.rows.map((r) => r.subject_user_id),
        });
        if (expected.length === 0) return [];
        const already = await c.query<{ user_id: string }>(
          `SELECT user_id FROM report_checkins WHERE tenant_id = $1 AND checkin_date = $2::date AND status IN ('submitted','excused')`,
          [tenantId, date],
        );
        const alreadySet = new Set(already.rows.map((r) => r.user_id));
        return expected.filter((u) => !alreadySet.has(u));
      },
      { modules: CHECKIN_MODULES },
    );

    if (pendingUserIds.length === 0) return { date, pending: [] };

    // identity_links is a GLOBAL table (0001_core.sql) — no tenant context, so this is a SEPARATE
    // call rather than nested inside the withTenants transaction above.
    //
    // TR-11 additive field: `waExternalId` alongside the original `hasWaLink` boolean. This is the
    // identity the bot's notify route sends to (for a WA DM, the same string IS the chat id —
    // waha.ts's InboundMessage sets chatId := senderId for a 1:1 chat, and that senderId is exactly
    // what enrollment records as `external_id`). Non-breaking: every existing consumer that only
    // reads `hasWaLink` is unaffected. Exposing the raw external_id to this SAME company_admin-tier
    // caller is not a new class of exposure — `GET /api/:t/identity-links` (admin-identity.
    // controller.ts) already returns every provider's external_id to that identical tier.
    const links = await withGlobal((c) =>
      c.query<{ user_id: string; external_id: string }>(
        `SELECT DISTINCT ON (user_id) user_id, external_id FROM identity_links
          WHERE provider = 'whatsapp' AND user_id = ANY($1::uuid[]) AND verified_at IS NOT NULL
          ORDER BY user_id, external_id`,
        [pendingUserIds],
      ),
    );
    const linkedExternalId = new Map(links.rows.map((r) => [r.user_id, r.external_id]));
    return {
      date,
      pending: pendingUserIds.map((userId) => ({
        userId,
        hasWaLink: linkedExternalId.has(userId),
        waExternalId: linkedExternalId.get(userId) ?? null,
      })),
    };
  }

  /** `GET /checkins/missed-yesterday?date` — service/admin only (same tier as pending-reminders):
   *  TR-11's escalation-flow read (§10 flow 3, "yesterday's auto_missed grouped by unit"). Groups
   *  the day's `auto_missed` rows by the missed person's CURRENT unit, and resolves each unit's
   *  lead(s) as "whoever holds `manager` at company scope AND is themselves a current primary
   *  member of that same unit" — the same "manager's own unit" convention this file already
   *  applies for the compliance-grid narrowing above (`isManagerTierOnly`/`ownCurrentUnit`),
   *  because no per-org-node manager-grant primitive exists in this codebase yet (the open
   *  architectural gap TR-09/TR-13 both flagged for TR-25). A unit with no such lead reports an
   *  EMPTY `leadUserIds` array rather than guessing one — the caller (n8n) then has nowhere to
   *  route that unit's escalation and skips it, which is the correct fail-closed behavior for
   *  "the right lead, never a broadcast": widening to "notify every manager in the company"
   *  would violate exactly the boundary TR-09 drew. */
  @Get("missed-yesterday")
  async missedYesterday(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("date") dateParam: string | undefined) {
    await authorize(req.principal, { kind: "checkin", tenantId }, "missed_by_unit");

    const tz = config.reportsTz;
    const date = dateParam ? assertDate(dateParam, "date") : addDaysIso(todayIsoInTz(tz), -1);

    return withTenants(
      [tenantId],
      async (c) => {
        const missed = await c.query<{ user_id: string }>(
          `SELECT user_id FROM report_checkins WHERE tenant_id = $1 AND checkin_date = $2::date AND status = 'auto_missed'`,
          [tenantId, date],
        );
        if (missed.rows.length === 0) return { date, byUnit: [] as Array<{ unitNodeId: string; missedUserIds: string[]; leadUserIds: string[] }> };

        const missedIds = missed.rows.map((r) => r.user_id);
        const memberships = await c.query<{ user_id: string; unit_node_id: string }>(
          `SELECT user_id, unit_node_id FROM org_unit_memberships
            WHERE tenant_id = $1 AND is_primary AND valid_from <= $2::date AND (valid_to IS NULL OR valid_to >= $2::date)
              AND user_id = ANY($3::uuid[])`,
          [tenantId, date, missedIds],
        );
        const unitByUser = new Map(memberships.rows.map((r) => [r.user_id, r.unit_node_id]));

        const missedByUnit = new Map<string, string[]>();
        for (const userId of missedIds) {
          const unit = unitByUser.get(userId);
          if (!unit) continue; // no resolvable current unit (e.g. offboarded since) — nothing to route
          (missedByUnit.get(unit) ?? missedByUnit.set(unit, []).get(unit)!).push(userId);
        }
        if (missedByUnit.size === 0) return { date, byUnit: [] };

        // Every current primary member of any AFFECTED unit (not the whole company) — one query,
        // grouped locally, rather than one round trip per unit.
        const affectedUnits = [...missedByUnit.keys()];
        const allMembers = await c.query<{ user_id: string; unit_node_id: string }>(
          `SELECT user_id, unit_node_id FROM org_unit_memberships
            WHERE tenant_id = $1 AND is_primary AND valid_from <= $2::date AND (valid_to IS NULL OR valid_to >= $2::date)
              AND unit_node_id = ANY($3::text[])`,
          [tenantId, date, affectedUnits],
        );
        const candidateIds = [...new Set(allMembers.rows.map((r) => r.user_id))];
        const leads = candidateIds.length
          ? await withGlobal((cg) =>
              cg.query<{ user_id: string }>(
                `SELECT DISTINCT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                  WHERE r.name = 'manager' AND ur.scope_type = 'company' AND ur.scope_id = $1
                    AND ur.user_id = ANY($2::uuid[])`,
                [tenantId, candidateIds],
              ),
            )
          : { rows: [] as { user_id: string }[] };
        const leadSet = new Set(leads.rows.map((r) => r.user_id));
        const leadsByUnit = new Map<string, string[]>();
        for (const m of allMembers.rows) {
          if (!leadSet.has(m.user_id)) continue;
          (leadsByUnit.get(m.unit_node_id) ?? leadsByUnit.set(m.unit_node_id, []).get(m.unit_node_id)!).push(m.user_id);
        }

        return {
          date,
          byUnit: [...missedByUnit.entries()].map(([unitNodeId, missedUserIds]) => ({
            unitNodeId,
            missedUserIds,
            leadUserIds: leadsByUnit.get(unitNodeId) ?? [],
          })),
        };
      },
      { modules: CHECKIN_MODULES },
    );
  }
}
