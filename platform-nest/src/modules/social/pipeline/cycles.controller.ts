// SCP-1c — the settings and the cycles: the deadline table, ready-by and schedule health (BFF §63.4 last paragraph, §63.5; plan §4.4).
//
//   GET  settings                 social_post · read              the buffer, the boost factor, whether a holiday calendar is known
//   PUT  settings                 social_engagement · plan        writes them and recomputes every open cycle's ready_by, in one transaction
//   GET  cycles?month=YYYY-MM     social_post · read              the deadline table of one month
//   PUT  cycles                   social_engagement · plan        upserts (engagement, month) deadlines, writes ready_by; one transaction
//   GET  cycles/:cycleId/health   social_post · read              per post and for the client
//
// THE FOUR APPROVERS PLAN, NOBODY ELSE (SCP-Q18, SCP-Q19; PERMISSION §53.6). `plan` is held by the HoD and GM lead seats, the owner and
// the superadmin. `manager`, `company_admin` and a `social_manager` grant do not hold it. A refusal is 403 `not_a_social_approver`. The
// resource is `socialEngagementResource(tenantId, approverIds)` with `approverIds` read from the rows (`loadSocialApproverIds`), never from
// a body. Only a plain Cerbos DENIAL becomes that code: a 401 (a revoked session) passes through, and an `assurance_required` reason
// (PV5-14) is kept beside the code.
//
// AUTHORIZATION BEFORE VALIDATION (BFF §63.0). Every route reads only the path ids it needs and asks Cerbos first; the body and the query
// are validated afterwards, so a refused caller always gets 403, never 400.
//
// THE MODULE WALL. Every social query declares `{ modules: ["social"] }` on its `withTenants` (the data module also calls
// `declareSocialModuleScope`). Holidays come through `loadWorkingCalendar`, which declares the hr scope itself.
//
// THE CONTENT-MONTH PM TASK (§63.13, SCP-1n): `PUT cycles` creates or updates one PM task per cycle through `syncContentMonthTask`
// (content-month.ts), in the same transaction. Each row of the answer says which task (`contentMonthTask.taskId`), or why there is none
// (`contentMonthTask.reason`: `no_project` when the engagement has no project, `project_not_found` when it was deleted).
import {
  BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Put, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../../../db";
import { config } from "../../../config";
import { authorize } from "../../../core/http";
import { check } from "../../../rbac/cerbos";
import { AuthGuard } from "../../../auth/guards";
import { ModuleEnabledGuard } from "../../module-enabled.guard";
import { addDays, parseIsoDate } from "../../hr/working-days";
import { declareSocialModuleScope } from "../module-scope";
import { loadSocialApproverIds, socialEngagementResource } from "../pipeline-authz";
import {
  CYCLE_STEPS_LOOKBACK_DAYS, HEALTH_LOOKBACK_DAYS, READY_BY_LOOKBACK_DAYS, composeCycleHealth, composeCycleTable, loadCalendarInfo,
  openCycleDeadlineRange, readApprovalSamples, readCycle, readCyclePosts, readCycleTableData, readEngagements, readSettings,
  recomputeOpenReadyBy, tableAnchors, todayIsoInTz, writeCycleInTx,
  type CalendarInfo, type CycleTable, type SocialSettings,
} from "./cycles-data";
import type { ContentMonthTaskResult } from "./content-month";
import type { CycleStepTasksResult } from "./cycle-steps";
import { composeCycleSteps, readCycleSteps, type CycleStepRow, type StepsReason } from "./cycle-steps-read";
import { isMonthKey, lastDayOfMonth, readyByFor, looksLikeIsoDate } from "./schedule-health";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ROWS = 100;

function invalid(field: string, error = "invalid_field"): never {
  throw new BadRequestException({ message: error, field });
}

/** The company's Social Media and GM lead-seat holders, read in the company's own scope. */
const approverIdsOf = (tenantId: string): Promise<string[]> =>
  withTenants([tenantId], (c) => loadSocialApproverIds(c, tenantId), { modules: ["social"] });

/** `plan` on `social_engagement` (the four approvers), or 403 `not_a_social_approver`. Runs before anything in the body is read. */
async function authorizePlan(req: FastifyRequest, tenantId: string): Promise<void> {
  const resource = socialEngagementResource(tenantId, await approverIdsOf(tenantId));
  try {
    await authorize(req.principal, resource, "plan");
  } catch (e) {
    if (e instanceof ForbiddenException) {
      const res = e.getResponse() as { reason?: unknown };
      throw new ForbiddenException({ message: "not_a_social_approver", ...(typeof res?.reason === "string" ? { reason: res.reason } : {}) });
    }
    throw e;
  }
}

/** The read every team member with a social read tier holds: `social_post` · `read`. */
async function authorizeRead(req: FastifyRequest, tenantId: string): Promise<void> {
  await authorize(req.principal, { kind: "social_post", tenantId, module: "social" }, "read");
}

/** Whether the caller may plan (the UI's `canPlan`). A plain decision: it never throws on a denial. */
async function canPlanOf(req: FastifyRequest, tenantId: string): Promise<boolean> {
  const d = await check(req.principal, socialEngagementResource(tenantId, await approverIdsOf(tenantId)), "plan");
  return d.allow;
}

interface SettingsAnswer {
  bufferWorkingDays: number;
  boostCandidateFactor: number;
  holidayCalendar: { known: boolean; name: string | null };
  canPlan: boolean;
}

const settingsAnswer = (s: SocialSettings, info: Pick<CalendarInfo, "known" | "name">, canPlan: boolean): SettingsAnswer => ({
  bufferWorkingDays: s.bufferWorkingDays, boostCandidateFactor: s.boostCandidateFactor,
  holidayCalendar: { known: info.known, name: info.name }, canPlan,
});

/** A real `YYYY-MM-DD` calendar date (not 2026-02-31). */
function isRealDate(s: string): boolean {
  if (!looksLikeIsoDate(s)) return false;
  try { parseIsoDate(s); return true; } catch { return false; }
}

/** The cycle's range for a deadline (BFF §63.1 `social_cycles_deadline_ck`): from three months before the month to its last day. */
function deadlineRange(month: string): { min: string; max: string } {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const total = y * 12 + (m - 1) - 3;
  const minY = Math.floor(total / 12);
  const minM = (total % 12) + 1;
  return { min: `${String(minY).padStart(4, "0")}-${String(minM).padStart(2, "0")}-01`, max: lastDayOfMonth(month) };
}

@Controller("api/:tenantId/modules/social")
@UseGuards(AuthGuard, ModuleEnabledGuard("social"))
export class SocialCyclesController {
  // ==================================================================== GET settings
  @Get("settings")
  async getSettings(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string): Promise<SettingsAnswer> {
    await authorizeRead(req, tenantId);
    const today = todayIsoInTz(config.reportsTz);
    const settings = await withTenants([tenantId], (c) => readSettings(c, tenantId), { modules: ["social"] });
    const info = await loadCalendarInfo(tenantId, [today], READY_BY_LOOKBACK_DAYS);
    return settingsAnswer(settings, info, await canPlanOf(req, tenantId));
  }

  // ==================================================================== PUT settings
  @Put("settings")
  async putSettings(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: unknown): Promise<SettingsAnswer & { cyclesRecomputed: number }> {
    await authorizePlan(req, tenantId);

    // Validation, after the decision.
    if (body === null || typeof body !== "object" || Array.isArray(body)) invalid("body");
    const b = body as Record<string, unknown>;
    for (const k of Object.keys(b)) if (k !== "bufferWorkingDays" && k !== "boostCandidateFactor") invalid(k, "unknown_field");
    let buffer: number | undefined;
    if (b.bufferWorkingDays !== undefined) {
      const v = b.bufferWorkingDays;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 10) invalid("bufferWorkingDays");
      buffer = v;
    }
    let factor: number | undefined;
    if (b.boostCandidateFactor !== undefined) {
      const v = b.boostCandidateFactor;
      // numeric(4,2), 1.00 to 10.00: at most two decimals, so what is stored is what was sent.
      if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > 10 || Math.abs(Math.round(v * 100) - v * 100) > 1e-9) invalid("boostCandidateFactor");
      factor = Math.round(v * 100) / 100;
    }

    const today = todayIsoInTz(config.reportsTz);
    // The deadlines of the open cycles decide which holidays to read; the holidays are read before the transaction (the hr scope is its own).
    const range = await withTenants([tenantId], (c) => openCycleDeadlineRange(c, tenantId, today), { modules: ["social"] });
    // SCP-5f: the cycles' step tasks are re-dated in the same transaction, so the holidays cover the window they walk back over.
    const info = await loadCalendarInfo(tenantId, range ? [range.min, range.max, today] : [today], CYCLE_STEPS_LOOKBACK_DAYS);

    const actorId = req.principal.userId ?? null;
    const result = await withTenants(
      [tenantId],
      async (c) => {
        await declareSocialModuleScope(c);
        const current = await readSettings(c, tenantId);
        const next: SocialSettings = {
          bufferWorkingDays: buffer ?? current.bufferWorkingDays,
          boostCandidateFactor: factor ?? current.boostCandidateFactor,
        };
        await c.query(
          `INSERT INTO social_settings (tenant_id, buffer_working_days, boost_candidate_factor, updated_by, updated_at, origin_site)
           VALUES ($1, $2, $3, $4, now(), $5)
           ON CONFLICT (tenant_id) DO UPDATE
              SET buffer_working_days = EXCLUDED.buffer_working_days, boost_candidate_factor = EXCLUDED.boost_candidate_factor,
                  updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [tenantId, next.bufferWorkingDays, next.boostCandidateFactor, actorId, config.originSite],
        );
        // The same transaction: every open cycle's ready_by follows the new buffer.
        const recomputed = range
          ? await recomputeOpenReadyBy(c, { tenantId, today, bufferWorkingDays: next.bufferWorkingDays, calendar: info.calendar, range, actorId })
          : { checked: 0, updated: 0, skipped: 0 };
        return { next, recomputed };
      },
      { modules: ["social"] },
    );
    return { ...settingsAnswer(result.next, info, true), cyclesRecomputed: result.recomputed.updated };
  }

  // ==================================================================== GET cycles
  @Get("cycles")
  async getCycles(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("month") monthQ?: string): Promise<CycleTable> {
    await authorizeRead(req, tenantId);
    const today = todayIsoInTz(config.reportsTz);
    const month = monthQ === undefined || monthQ === "" ? today.slice(0, 7) : monthQ;
    if (!isMonthKey(month)) invalid("month");
    const table = await this.buildTable(req, tenantId, month, today);
    return table;
  }

  // ==================================================================== PUT cycles
  @Put("cycles")
  async putCycles(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: unknown): Promise<CycleTable> {
    await authorizePlan(req, tenantId);

    // Validation, after the decision: the whole body first, so one bad row refuses all.
    if (body === null || typeof body !== "object" || Array.isArray(body)) invalid("body");
    const b = body as { month?: unknown; rows?: unknown };
    if (typeof b.month !== "string" || !isMonthKey(b.month)) invalid("month");
    const month = b.month;
    if (!Array.isArray(b.rows)) invalid("rows");
    if (b.rows.length > MAX_ROWS) invalid("rows", "too_many_rows");
    const range = deadlineRange(month);
    const seen = new Set<string>();
    const rows: Array<{ engagementId: string; deadline: string }> = [];
    b.rows.forEach((raw: unknown, i: number) => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) invalid(`rows[${i}]`);
      const r = raw as { engagementId?: unknown; deadline?: unknown };
      if (typeof r.engagementId !== "string" || !UUID_RE.test(r.engagementId)) invalid(`rows[${i}].engagementId`);
      const engagementId = r.engagementId.toLowerCase();
      if (seen.has(engagementId)) invalid(`rows[${i}].engagementId`, "duplicate_row");
      seen.add(engagementId);
      if (typeof r.deadline !== "string" || !isRealDate(r.deadline) || r.deadline < range.min || r.deadline > range.max) invalid(`rows[${i}].deadline`);
      rows.push({ engagementId, deadline: r.deadline });
    });

    const today = todayIsoInTz(config.reportsTz);
    const actorId = req.principal.userId ?? null;
    // The holidays the new ready-bys walk across, read before the transaction.
    // SCP-5f: and the cycles' step tasks, which walk back further (CYCLE_STEPS_LOOKBACK_DAYS).
    const info = await loadCalendarInfo(tenantId, [...rows.map((r) => r.deadline), `${month}-01`, today], CYCLE_STEPS_LOOKBACK_DAYS);

    const tasks = new Map<string, ContentMonthTaskResult>();
    const stepTasks = new Map<string, CycleStepTasksResult>();
    await withTenants(
      [tenantId],
      async (c) => {
        await declareSocialModuleScope(c);
        const buffer = (await readSettings(c, tenantId)).bufferWorkingDays;
        // 404 names the row. Checked in row order; one missing engagement refuses all (nothing has been written yet).
        const found = new Set((await readEngagements(c, tenantId, rows.map((r) => r.engagementId))).map((e) => e.id));
        for (const r of rows) if (!found.has(r.engagementId)) throw new NotFoundException({ message: "engagement_not_found", failedId: r.engagementId });
        for (const r of rows) {
          const readyBy = readyByFor(r.deadline, buffer, info.calendar);
          const written = await writeCycleInTx(c, { tenantId, engagementId: r.engagementId, month, deadline: r.deadline, readyBy, actorId, calendar: info.calendar });
          tasks.set(r.engagementId, written.task);
          stepTasks.set(r.engagementId, written.stepTasks);
        }
      },
      { modules: ["social"] },
    );

    const table = await this.buildTable(req, tenantId, month, today, true);
    // Additive (SCP-1n): each row names the content-month task of the cycle this call wrote, or why it has none. Rows the call did not write carry none.
    // Additive (SCP-5f, BFF §63.27.3): and its step tasks, `stepTasks: {created, reason}`: how many this call made (0 on a re-run), or why none.
    return {
      ...table,
      rows: table.rows.map((row) => {
        const t = tasks.get(row.engagementId);
        const s = stepTasks.get(row.engagementId);
        return t ? { ...row, contentMonthTask: { taskId: t.taskId, reason: t.reason }, ...(s ? { stepTasks: { created: s.created, reason: s.reason } } : {}) } : row;
      }),
    } as CycleTable;
  }

  // ==================================================================== GET cycles/:cycleId/health
  @Get("cycles/:cycleId/health")
  async getCycleHealth(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("cycleId") cycleId: string) {
    await authorizeRead(req, tenantId);
    if (!UUID_RE.test(cycleId)) throw new NotFoundException({ message: "cycle_not_found" });
    const today = todayIsoInTz(config.reportsTz);
    const tz = config.reportsTz;

    const data = await withTenants(
      [tenantId],
      async (c) => {
        await declareSocialModuleScope(c);
        const cycle = await readCycle(c, tenantId, cycleId.toLowerCase());
        if (!cycle) return null;
        // A cycle of a closed engagement is not listed by the table, but its health still answers.
        const [eng] = await readEngagements(c, tenantId, [cycle.engagementId], { includeClosed: true });
        if (!eng) return null;
        const posts = await readCyclePosts(c, tenantId, [cycle.id]);
        const samples = (await readApprovalSamples(c, tenantId, [cycle.engagementId], today, tz)).get(cycle.engagementId) ?? [];
        const buffer = (await readSettings(c, tenantId)).bufferWorkingDays;
        // SCP-5f (§63.27.4): the cycle's step tasks, found by link (read only).
        const stepsData = await readCycleSteps(c, tenantId, cycle.id);
        return { cycle, eng, posts, samples, buffer, stepsData };
      },
      { modules: ["social"] },
    );
    if (!data) throw new NotFoundException({ message: "cycle_not_found" });

    const info = await loadCalendarInfo(tenantId, [today, data.cycle.deadline, data.cycle.readyBy, addDays(today, -100)], HEALTH_LOOKBACK_DAYS);
    const health = composeCycleHealth(data.cycle, data.eng, data.posts, data.samples, data.buffer, today, info);
    // Additive (SCP-5f, §63.27.4): `steps` in the rules' order, or none with `stepsReason` when the engagement has no project.
    const sd = data.stepsData;
    const steps: CycleStepRow[] = sd ? composeCycleSteps(sd.rules, sd.month, sd.tasks, today) : [];
    const stepsReason: StepsReason | null = sd?.reason ?? null;
    return { ...health, steps: stepsReason ? [] : steps, stepsReason };
  }

  // ==================================================================== the deadline table, shared by GET and the answer of PUT
  private async buildTable(req: FastifyRequest, tenantId: string, month: string, today: string, canPlan?: boolean): Promise<CycleTable> {
    const data = await withTenants([tenantId], (c) => readCycleTableData(c, tenantId, month, today, config.reportsTz), { modules: ["social"] });
    const info = await loadCalendarInfo(tenantId, tableAnchors(month, today, data.cycles), HEALTH_LOOKBACK_DAYS);
    return composeCycleTable(data, month, today, info, canPlan ?? (await canPlanOf(req, tenantId)));
  }
}
