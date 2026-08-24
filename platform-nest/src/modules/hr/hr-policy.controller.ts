// HR wave A — the CONFIGURATION surface: holiday calendars, leave policies and their assignments,
// review cycles, pipeline stage sets, pay-grade structure, and the statutory parameter sets.
//
// Mounted under the same `/api/:tenantId/modules/hr` prefix as HrController and gated by the same
// AuthGuard + ModuleEnabledGuard("hr"). Everything here authorizes as the `hr_policy` Cerbos kind
// (resource_hr_policy.yaml) — a deliberately WIDE read and a narrow write, because these are the
// company's own rules and the people they govern are the people who need to see them.
//
// THE THIRD WALL: every query passes `{ modules: ["hr"] }`. Omit it on any new query here and it
// reads and writes ZERO rows, with no error. That is fail-closed by construction and it is the
// single easiest way to add a silently-broken endpoint to this file.
import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity } from "../../core/http";
import { emitEvent } from "../../events/outbox.service";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { countWorkingDays, type HolidayEntry } from "./working-days";

const LEAVE_TYPES = new Set(["vacation", "sick", "unpaid", "other"]);
const ACCRUAL_METHODS = new Set(["upfront", "monthly", "anniversary", "none"]);
const HOLIDAY_KINDS = new Set(["public", "joint_leave", "company"]);
const CYCLE_KINDS = new Set(["probation", "periodic", "project"]);
const CYCLE_STATUSES = new Set(["draft", "open", "closed", "cancelled"]);
const GRADE_TRACKS = new Set(["individual", "management", "executive", "support"]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const requireIsoDate = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    throw new BadRequestException(`${field} must be an ISO date (YYYY-MM-DD)`);
  }
  return value;
};

@Controller("api/:tenantId/modules/hr")
@UseGuards(AuthGuard, ModuleEnabledGuard("hr"))
export class HrPolicyController {
  // ══════════════════════════════════════════════════════ HOLIDAY CALENDARS ══════════════════
  @Get("calendars")
  async listCalendars(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "hr_policy", tenantId, module: "hr" }, "read");
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT c.id, c.name, c.country_code AS "countryCode", c.weekend_days AS "weekendDays",
                c.is_default AS "isDefault", c.created_at,
                (SELECT count(*) FROM hr_holidays h WHERE h.calendar_id = c.id)::int AS "holidayCount"
         FROM hr_holiday_calendars c WHERE c.deleted_at IS NULL ORDER BY c.is_default DESC, c.name`,
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  @Post("calendars")
  @HttpCode(201)
  async createCalendar(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { name?: string; countryCode?: string; weekendDays?: number[]; isDefault?: boolean },
  ) {
    if (!body?.name) throw new BadRequestException("name required");
    await authorize(req.principal, { kind: "hr_policy", tenantId, module: "hr" }, "create");
    const weekendDays = Array.isArray(body.weekendDays) && body.weekendDays.length
      ? body.weekendDays.map(Number).filter((d) => d >= 1 && d <= 7)
      : [6, 7];
    const id = newId();
    await withTenants(
      [tenantId],
      async (c) => {
        // Demote the incumbent default BEFORE inserting a new one. The partial unique index
        // (ux_hr_holiday_calendars_default) would otherwise reject the insert — correctly, but with
        // a constraint error rather than the intended "this is now the default" behaviour.
        if (body.isDefault) {
          await c.query(`UPDATE hr_holiday_calendars SET is_default = false WHERE is_default AND deleted_at IS NULL`);
        }
        await c.query(
          `INSERT INTO hr_holiday_calendars (id, tenant_id, name, country_code, weekend_days, is_default, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, tenantId, body.name, (body.countryCode ?? "ID").toUpperCase(), weekendDays, !!body.isDefault, config.originSite],
        );
      },
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "created", "hr_holiday_calendar", id, { name: body.name });
    return { id };
  }

  @Get("calendars/:id/holidays")
  async listHolidays(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Query("year") year?: string,
  ) {
    await authorize(req.principal, { kind: "hr_policy", tenantId, module: "hr" }, "read");
    const params: unknown[] = [id];
    let yearClause = "";
    if (year) { params.push(`${Number(year)}-01-01`, `${Number(year)}-12-31`); yearClause = ` AND day BETWEEN $2 AND $3`; }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, day, name, kind, deducts_entitlement AS "deductsEntitlement"
         FROM hr_holidays WHERE calendar_id = $1${yearClause} ORDER BY day`,
        params,
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  /**
   * Add holidays in bulk. Bulk rather than one-at-a-time because a year's holiday set arrives as a
   * decree, all at once, and 17 sequential POSTs is 17 chances to land a partial year.
   *
   * `ON CONFLICT DO UPDATE` on (tenant, calendar, day) so re-posting a corrected decree amends the
   * existing rows rather than failing halfway — Indonesian joint-leave dates are revised most years.
   */
  @Post("calendars/:id/holidays")
  @HttpCode(201)
  async addHolidays(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") calendarId: string,
    @Body() body: { holidays?: { day?: string; name?: string; kind?: string; deductsEntitlement?: boolean }[] },
  ) {
    const input = Array.isArray(body?.holidays) ? body.holidays : [];
    if (!input.length) throw new BadRequestException("holidays[] required");
    await authorize(req.principal, { kind: "hr_policy", tenantId, module: "hr" }, "create");

    const rows = input.map((h) => {
      const day = requireIsoDate(h.day, "holidays[].day");
      if (!h.name) throw new BadRequestException("holidays[].name required");
      const kind = h.kind && HOLIDAY_KINDS.has(h.kind) ? h.kind : "public";
      // deductsEntitlement is only meaningful for joint_leave; NULL elsewhere so the column reads
      // as "not applicable" rather than as a false (see the migration's own note).
      const deducts = kind === "joint_leave" ? h.deductsEntitlement !== false : null;
      return { day, name: h.name, kind, deducts };
    });

    const inserted = await withTenants(
      [tenantId],
      async (c) => {
        const owner = await c.query(`SELECT 1 FROM hr_holiday_calendars WHERE id = $1 AND deleted_at IS NULL`, [calendarId]);
        if (!owner.rows[0]) throw new NotFoundException("calendar not found");
        let n = 0;
        for (const r of rows) {
          await c.query(
            `INSERT INTO hr_holidays (id, tenant_id, calendar_id, day, name, kind, deducts_entitlement)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (tenant_id, calendar_id, day)
             DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, deducts_entitlement = EXCLUDED.deducts_entitlement`,
            [newId(), tenantId, calendarId, r.day, r.name, r.kind, r.deducts],
          );
          n += 1;
        }
        return n;
      },
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "updated", "hr_holiday_calendar", calendarId, { holidaysUpserted: inserted });
    return { calendarId, upserted: inserted };
  }

  @Delete("holidays/:id")
  @HttpCode(200)
  async deleteHoliday(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "hr_policy", tenantId, module: "hr" }, "delete");
    const res = await withTenants(
      [tenantId],
      (c) => c.query(`DELETE FROM hr_holidays WHERE id = $1`, [id]),
      { modules: ["hr"] },
    );
    if (!res.rowCount) throw new NotFoundException("holiday not found");
    return { ok: true };
  }

  /**
   * Working-day breakdown for a date range against a calendar. The endpoint the leave form calls
   * before it lets anyone submit, so the days shown to the requester and the days charged by the
   * backend come from the same function rather than from two implementations of the same rule.
   */
  @Get("working-days")
  async workingDays(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("from") from?: string, @Query("to") to?: string, @Query("calendarId") calendarId?: string,
  ) {
    await authorize(req.principal, { kind: "hr_policy", tenantId, module: "hr" }, "read");
    const startsOn = requireIsoDate(from, "from");
    const endsOn = requireIsoDate(to, "to");
    if (endsOn < startsOn) throw new BadRequestException("to must be >= from");
    const calendar = await loadCalendar(tenantId, calendarId ?? null, startsOn, endsOn);
    return { from: startsOn, to: endsOn, calendarId: calendar.id, ...countWorkingDays(startsOn, endsOn, calendar) };
  }

  // ══════════════════════════════════════════════════════════ LEAVE POLICIES ══════════════════
  @Get("leave-policies")
  async listLeavePolicies(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "hr_policy", tenantId, module: "hr" }, "read");
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, name, leave_type AS "leaveType", accrual_method AS "accrualMethod",
                annual_entitlement_minutes AS "annualEntitlementMinutes",
                waiting_period_months AS "waitingPeriodMonths", prorate_first_year AS "prorateFirstYear",
                carryover_max_minutes AS "carryoverMaxMinutes", carryover_expiry_months AS "carryoverExpiryMonths",
                allow_negative_balance AS "allowNegativeBalance", excludes_holidays AS "excludesHolidays",
                escalate_over_minutes AS "escalateOverMinutes", min_notice_days AS "minNoticeDays",
                is_active AS "isActive", created_at
         FROM hr_leave_policies WHERE deleted_at IS NULL ORDER BY leave_type, name`,
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  @Post("leave-policies")
  @HttpCode(201)
  async createLeavePolicy(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const name = typeof body?.name === "string" ? body.name : undefined;
    const leaveType = typeof body?.leaveType === "string" && LEAVE_TYPES.has(body.leaveType) ? body.leaveType : undefined;
    if (!name || !leaveType) throw new BadRequestException("name and leaveType (vacation|sick|unpaid|other) required");
    const accrualMethod = typeof body?.accrualMethod === "string" && ACCRUAL_METHODS.has(body.accrualMethod)
      ? body.accrualMethod : "upfront";
    await authorize(req.principal, { kind: "hr_policy", tenantId, module: "hr" }, "create");

    const num = (k: string, d: number) => (typeof body?.[k] === "number" ? Math.round(body[k] as number) : d);
    const bool = (k: string, d: boolean) => (typeof body?.[k] === "boolean" ? (body[k] as boolean) : d);
    const id = newId();
    await withTenants(
      [tenantId],
      (c) => c.query(
        `INSERT INTO hr_leave_policies
           (id, tenant_id, name, leave_type, accrual_method, annual_entitlement_minutes, waiting_period_months,
            prorate_first_year, carryover_max_minutes, carryover_expiry_months, allow_negative_balance,
            excludes_holidays, escalate_over_minutes, min_notice_days, created_by, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          id, tenantId, name, leaveType, accrualMethod,
          num("annualEntitlementMinutes", 0), num("waitingPeriodMonths", 0),
          bool("prorateFirstYear", true), num("carryoverMaxMinutes", 0), num("carryoverExpiryMonths", 0),
          bool("allowNegativeBalance", false), bool("excludesHolidays", true),
          typeof body?.escalateOverMinutes === "number" ? Math.round(body.escalateOverMinutes as number) : null,
          num("minNoticeDays", 0), req.principal.userId, config.originSite,
        ],
      ),
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "created", "hr_leave_policy", id, { name, leaveType, accrualMethod });
    return { id };
  }

  @Patch("leave-policies/:id")
  async updateLeavePolicy(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    await authorize(req.principal, { kind: "hr_policy", id, tenantId, module: "hr" }, "update");
    // Allow-list of settable columns. An open-ended column map here would let a client set
    // `tenant_id` and re-home the policy.
    const FIELDS: Record<string, string> = {
      name: "name", accrualMethod: "accrual_method",
      annualEntitlementMinutes: "annual_entitlement_minutes", waitingPeriodMonths: "waiting_period_months",
      prorateFirstYear: "prorate_first_year", carryoverMaxMinutes: "carryover_max_minutes",
      carryoverExpiryMonths: "carryover_expiry_months", allowNegativeBalance: "allow_negative_balance",
      excludesHolidays: "excludes_holidays", escalateOverMinutes: "escalate_over_minutes",
      minNoticeDays: "min_notice_days", isActive: "is_active",
    };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries(FIELDS)) {
      if (body?.[key] === undefined) continue;
      if (key === "accrualMethod" && !ACCRUAL_METHODS.has(String(body[key]))) {
        throw new BadRequestException("accrualMethod must be upfront|monthly|anniversary|none");
      }
      params.push(body[key]);
      sets.push(`${column} = $${params.length}`);
    }
    if (!sets.length) throw new BadRequestException("no updatable fields supplied");
    const res = await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE hr_leave_policies SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`, params),
      { modules: ["hr"] },
    );
    if (!res.rowCount) throw new NotFoundException("leave policy not found");
    await writeActivity(tenantId, req.principal.userId, "updated", "hr_leave_policy", id, { fields: Object.keys(body ?? {}) });
    return { ok: true };
  }

  @Post("leave-policies/:id/assignments")
  @HttpCode(201)
  async assignLeavePolicy(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") policyId: string,
    @Body() body: { subjectUserId?: string; unitNodeId?: string; effectiveFrom?: string; effectiveTo?: string },
  ) {
    await authorize(req.principal, { kind: "hr_policy", tenantId, module: "hr" }, "create");
    if (body?.subjectUserId && body?.unitNodeId) {
      throw new BadRequestException("supply at most one of subjectUserId or unitNodeId (omit both for the tenant default)");
    }
    const effectiveFrom = requireIsoDate(body?.effectiveFrom, "effectiveFrom");
    const id = newId();
    await withTenants(
      [tenantId],
      async (c) => {
        const owner = await c.query(`SELECT 1 FROM hr_leave_policies WHERE id = $1 AND deleted_at IS NULL`, [policyId]);
        if (!owner.rows[0]) throw new NotFoundException("leave policy not found");
        await c.query(
          `INSERT INTO hr_leave_policy_assignments (id, tenant_id, policy_id, subject_user_id, unit_node_id, effective_from, effective_to, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, tenantId, policyId, body?.subjectUserId ?? null, body?.unitNodeId ?? null, effectiveFrom, body?.effectiveTo ?? null, req.principal.userId],
        );
      },
      { modules: ["hr"] },
    );
    return { id };
  }

  @Get("leave-policies/:id/assignments")
  async listAssignments(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") policyId: string) {
    await authorize(req.principal, { kind: "hr_policy", tenantId, module: "hr" }, "read");
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, subject_user_id AS "subjectUserId", unit_node_id AS "unitNodeId",
                effective_from AS "effectiveFrom", effective_to AS "effectiveTo", created_at
         FROM hr_leave_policy_assignments WHERE policy_id = $1 ORDER BY effective_from DESC`,
        [policyId],
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  // ══════════════════════════════════════════════════════════ REVIEW CYCLES ═══════════════════
  @Get("review-cycles")
  async listReviewCycles(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("status") status?: string,
  ) {
    await authorize(req.principal, { kind: "hr_policy", tenantId, module: "hr" }, "read");
    const params: unknown[] = [];
    const clauses = ["deleted_at IS NULL"];
    if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT c.id, c.name, c.kind, c.period_start AS "periodStart", c.period_end AS "periodEnd",
                c.opens_on AS "opensOn", c.closes_on AS "closesOn", c.status, c.template, c.created_at,
                (SELECT count(*) FROM hr_review_participants p WHERE p.cycle_id = c.id)::int AS "participantCount",
                (SELECT count(*) FROM hr_review_participants p WHERE p.cycle_id = c.id
                   AND p.status IN ('submitted','acknowledged','waived'))::int AS "completedCount"
         FROM hr_review_cycles c WHERE ${clauses.join(" AND ")} ORDER BY c.period_end DESC`,
        params,
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  @Post("review-cycles")
  @HttpCode(201)
  async createReviewCycle(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { name?: string; kind?: string; periodStart?: string; periodEnd?: string; opensOn?: string; closesOn?: string; template?: Record<string, unknown> },
  ) {
    if (!body?.name) throw new BadRequestException("name required");
    const kind = body?.kind && CYCLE_KINDS.has(body.kind) ? body.kind : "periodic";
    const periodStart = requireIsoDate(body?.periodStart, "periodStart");
    const periodEnd = requireIsoDate(body?.periodEnd, "periodEnd");
    if (periodEnd < periodStart) throw new BadRequestException("periodEnd must be >= periodStart");
    await authorize(req.principal, { kind: "hr_policy", tenantId, module: "hr" }, "create");
    const id = newId();
    await withTenants(
      [tenantId],
      async (c) => {
        await c.query(
          `INSERT INTO hr_review_cycles (id, tenant_id, name, kind, period_start, period_end, opens_on, closes_on, template, created_by, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id, tenantId, body.name, kind, periodStart, periodEnd, body?.opensOn ?? null, body?.closesOn ?? null,
           JSON.stringify(body?.template ?? {}), req.principal.userId, config.originSite],
        );
        await emitEvent(c, tenantId, "hr_review_cycle", id, "hr.review_cycle.created", { kind, periodStart, periodEnd });
      },
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "created", "hr_review_cycle", id, { name: body.name, kind });
    return { id };
  }

  @Patch("review-cycles/:id")
  async updateReviewCycle(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { status?: string; name?: string; opensOn?: string; closesOn?: string },
  ) {
    await authorize(req.principal, { kind: "hr_policy", id, tenantId, module: "hr" }, "update");
    if (body?.status && !CYCLE_STATUSES.has(body.status)) {
      throw new BadRequestException("status must be draft|open|closed|cancelled");
    }
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries({ status: "status", name: "name", opensOn: "opens_on", closesOn: "closes_on" })) {
      if (body?.[key as keyof typeof body] === undefined) continue;
      params.push(body[key as keyof typeof body]);
      sets.push(`${column} = $${params.length}`);
    }
    if (!sets.length) throw new BadRequestException("no updatable fields supplied");
    const res = await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE hr_review_cycles SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`, params),
      { modules: ["hr"] },
    );
    if (!res.rowCount) throw new NotFoundException("review cycle not found");
    return { ok: true };
  }

  /**
   * Enrol participants. Reviewers default to NULL rather than being guessed: the org chart's lead
   * position holder is the right default, but resolving it here would bake an org-chart read into a
   * config endpoint and produce a wrong reviewer silently when the chart is mid-change. An
   * unassigned participant is visible and fixable; a wrongly-assigned one is not.
   */
  @Post("review-cycles/:id/participants")
  @HttpCode(201)
  async addParticipants(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") cycleId: string,
    @Body() body: { participants?: { subjectUserId?: string; reviewerUserId?: string; dueOn?: string }[] },
  ) {
    const input = Array.isArray(body?.participants) ? body.participants : [];
    if (!input.length) throw new BadRequestException("participants[] required");
    await authorize(req.principal, { kind: "hr_policy", tenantId, module: "hr" }, "create");
    const added = await withTenants(
      [tenantId],
      async (c) => {
        const owner = await c.query(`SELECT 1 FROM hr_review_cycles WHERE id = $1 AND deleted_at IS NULL`, [cycleId]);
        if (!owner.rows[0]) throw new NotFoundException("review cycle not found");
        let n = 0;
        for (const p of input) {
          if (!p.subjectUserId) throw new BadRequestException("participants[].subjectUserId required");
          const res = await c.query(
            `INSERT INTO hr_review_participants (id, tenant_id, cycle_id, subject_user_id, reviewer_user_id, due_on)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (tenant_id, cycle_id, subject_user_id) DO NOTHING`,
            [newId(), tenantId, cycleId, p.subjectUserId, p.reviewerUserId ?? null, p.dueOn ?? null],
          );
          n += res.rowCount ?? 0;
        }
        return n;
      },
      { modules: ["hr"] },
    );
    return { cycleId, added };
  }

  @Get("review-cycles/:id/participants")
  async listParticipants(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") cycleId: string) {
    await authorize(req.principal, { kind: "hr_policy", tenantId, module: "hr" }, "read");
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT p.id, p.subject_user_id AS "subjectUserId", u.name AS "subjectName",
                p.reviewer_user_id AS "reviewerUserId", p.due_on AS "dueOn", p.status,
                p.outcome, p.outcome_note AS "outcomeNote", p.appraisal_id AS "appraisalId",
                p.case_id AS "caseId", p.submitted_at AS "submittedAt"
         FROM hr_review_participants p
         LEFT JOIN users u ON u.id = p.subject_user_id
         WHERE p.cycle_id = $1 ORDER BY u.name NULLS LAST`,
        [cycleId],
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  /**
   * Record a participant's outcome. Note what this does NOT do: it never writes appraisal content.
   * The reports program owns that (resource_appraisal.yaml, its own sealing rules); this records the
   * HR-side verdict and links out via `appraisalId`.
   */
  @Patch("review-participants/:id")
  async updateParticipant(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { status?: string; outcome?: string; outcomeNote?: string; reviewerUserId?: string; appraisalId?: string },
  ) {
    await authorize(req.principal, { kind: "hr_policy", id, tenantId, module: "hr" }, "update");
    if (body?.outcome && !["pass", "extend", "fail"].includes(body.outcome)) {
      throw new BadRequestException("outcome must be pass|extend|fail");
    }
    const sets: string[] = [];
    const params: unknown[] = [id];
    const map: Record<string, string> = {
      status: "status", outcome: "outcome", outcomeNote: "outcome_note",
      reviewerUserId: "reviewer_user_id", appraisalId: "appraisal_id",
    };
    for (const [key, column] of Object.entries(map)) {
      if (body?.[key as keyof typeof body] === undefined) continue;
      params.push(body[key as keyof typeof body]);
      sets.push(`${column} = $${params.length}`);
    }
    if (!sets.length) throw new BadRequestException("no updatable fields supplied");
    // `submitted_at` is derived from the status transition rather than accepted from the client — a
    // client-supplied submission timestamp on a probation verdict is exactly the field somebody
    // would want to backdate.
    if (body?.status === "submitted") sets.push("submitted_at = now()");
    const res = await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE hr_review_participants SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params),
      { modules: ["hr"] },
    );
    if (!res.rowCount) throw new NotFoundException("review participant not found");
    await writeActivity(tenantId, req.principal.userId, "updated", "hr_review_participant", id, { outcome: body?.outcome, status: body?.status });
    return { ok: true };
  }

  // ══════════════════════════════════════════════════════════ PAY GRADES ══════════════════════
  @Get("pay-grades")
  async listPayGrades(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "hr_policy", tenantId, module: "hr" }, "read");
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, code, name, track, level, min_amount AS "minAmount", mid_amount AS "midAmount",
                max_amount AS "maxAmount", currency, pay_period AS "payPeriod", is_active AS "isActive"
         FROM hr_pay_grades WHERE deleted_at IS NULL ORDER BY track, level, code`,
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  @Post("pay-grades")
  @HttpCode(201)
  async createPayGrade(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { code?: string; name?: string; track?: string; level?: number; minAmount?: number; midAmount?: number; maxAmount?: number; currency?: string; payPeriod?: string },
  ) {
    if (!body?.code || !body?.name) throw new BadRequestException("code and name required");
    if (typeof body?.minAmount !== "number" || typeof body?.maxAmount !== "number") {
      throw new BadRequestException("minAmount and maxAmount required");
    }
    if (body.maxAmount < body.minAmount) throw new BadRequestException("maxAmount must be >= minAmount");
    const track = body?.track && GRADE_TRACKS.has(body.track) ? body.track : "individual";
    await authorize(req.principal, { kind: "hr_policy", tenantId, module: "hr" }, "create");
    const id = newId();
    await withTenants(
      [tenantId],
      (c) => c.query(
        `INSERT INTO hr_pay_grades (id, tenant_id, code, name, track, level, min_amount, mid_amount, max_amount, currency, pay_period)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, tenantId, body.code, body.name, track, body?.level ?? 1, body.minAmount, body?.midAmount ?? null,
         body.maxAmount, body?.currency ?? "IDR", body?.payPeriod ?? "monthly"],
      ),
      { modules: ["hr"] },
    );
    return { id };
  }

  // ══════════════════════════════════════════════ STATUTORY PARAMETER SETS ════════════════════
  @Get("statutory-parameters")
  async listParameterSets(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "hr_policy", tenantId, module: "hr" }, "read");
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT s.id, s.name, s.country_code AS "countryCode", s.effective_from AS "effectiveFrom",
                s.effective_to AS "effectiveTo", s.ratified_by AS "ratifiedBy", s.ratified_at AS "ratifiedAt",
                s.source_note AS "sourceNote", s.created_at,
                (SELECT count(*) FROM hr_statutory_parameters p WHERE p.set_id = s.id)::int AS "parameterCount"
         FROM hr_statutory_parameter_sets s ORDER BY s.effective_from DESC`,
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  @Get("statutory-parameters/:id")
  async getParameterSet(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "hr_policy", id, tenantId, module: "hr" }, "read");
    const { set, parameters } = await withTenants(
      [tenantId],
      async (c) => {
        const s = await c.query(
          `SELECT id, name, country_code AS "countryCode", effective_from AS "effectiveFrom", effective_to AS "effectiveTo",
                  ratified_by AS "ratifiedBy", ratified_at AS "ratifiedAt", source_note AS "sourceNote"
           FROM hr_statutory_parameter_sets WHERE id = $1`,
          [id],
        );
        const p = await c.query(
          `SELECT key, value_num AS "valueNum", value_json AS "valueJson", unit, note
           FROM hr_statutory_parameters WHERE set_id = $1 ORDER BY key`,
          [id],
        );
        return { set: s.rows[0], parameters: p.rows };
      },
      { modules: ["hr"] },
    );
    if (!set) throw new NotFoundException("parameter set not found");
    return { ...set, ratified: !!set.ratifiedAt, parameters };
  }

  @Post("statutory-parameters")
  @HttpCode(201)
  async createParameterSet(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { name?: string; countryCode?: string; effectiveFrom?: string; effectiveTo?: string; sourceNote?: string; parameters?: { key?: string; valueNum?: number; valueJson?: unknown; unit?: string; note?: string }[] },
  ) {
    if (!body?.name) throw new BadRequestException("name required");
    const effectiveFrom = requireIsoDate(body?.effectiveFrom, "effectiveFrom");
    await authorize(req.principal, { kind: "hr_policy", tenantId, module: "hr" }, "create");
    const id = newId();
    await withTenants(
      [tenantId],
      async (c) => {
        await c.query(
          `INSERT INTO hr_statutory_parameter_sets (id, tenant_id, country_code, name, effective_from, effective_to, source_note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, tenantId, (body?.countryCode ?? "ID").toUpperCase(), body.name, effectiveFrom, body?.effectiveTo ?? null,
           body?.sourceNote ?? null, req.principal.userId],
        );
        for (const p of body?.parameters ?? []) {
          if (!p.key) throw new BadRequestException("parameters[].key required");
          const hasNum = typeof p.valueNum === "number";
          const hasJson = p.valueJson !== undefined && p.valueJson !== null;
          // The table's ck_hr_param_one_value CHECK enforces this too; raising here turns a
          // constraint violation into a message naming the offending key.
          if (hasNum === hasJson) throw new BadRequestException(`parameters["${p.key}"] needs exactly one of valueNum or valueJson`);
          await c.query(
            `INSERT INTO hr_statutory_parameters (id, tenant_id, set_id, key, value_num, value_json, unit, note)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [newId(), tenantId, id, p.key, hasNum ? p.valueNum : null, hasJson ? JSON.stringify(p.valueJson) : null, p.unit ?? null, p.note ?? null],
          );
        }
      },
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "created", "hr_statutory_parameter_set", id, { name: body.name, effectiveFrom });
    return { id, ratified: false };
  }

  /**
   * RATIFY a parameter set — its own action, at the D4 high-assurance tier, held by company_admin
   * and NOT by hr_manager (resource_hr_policy.yaml). This is the gate the payroll runner checks
   * before it will finalize a run against these numbers, so it is an accountability act rather than
   * an HR-operations one, and it is deliberately not reachable from the same routine edit that
   * fixes a typo in the set's name.
   *
   * Idempotent-but-honest: re-ratifying an already-ratified set is refused rather than silently
   * re-stamping it with a new signature, because the first signature is the one that matters.
   */
  @Post("statutory-parameters/:id/ratify")
  @HttpCode(200)
  async ratifyParameterSet(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { note?: string },
  ) {
    await authorize(req.principal, { kind: "hr_policy", id, tenantId, module: "hr" }, "ratify");
    const row = await withTenants(
      [tenantId],
      async (c) => {
        const existing = await c.query<{ ratified_at: string | null }>(
          `SELECT ratified_at FROM hr_statutory_parameter_sets WHERE id = $1`, [id],
        );
        if (!existing.rows[0]) throw new NotFoundException("parameter set not found");
        if (existing.rows[0].ratified_at) throw new BadRequestException("parameter set is already ratified");
        const res = await c.query(
          `UPDATE hr_statutory_parameter_sets
              SET ratified_by = $2, ratified_at = now(),
                  source_note = COALESCE($3, source_note), updated_at = now()
            WHERE id = $1
            RETURNING ratified_at AS "ratifiedAt"`,
          [id, req.principal.userId, body?.note ?? null],
        );
        await emitEvent(c, tenantId, "hr_statutory_parameter_set", id, "hr.statutory_parameters.ratified", {
          ratifiedBy: req.principal.userId,
        });
        return res.rows[0];
      },
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "ratified", "hr_statutory_parameter_set", id, {});
    return { ok: true, ratified: true, ratifiedAt: row.ratifiedAt };
  }
}

/**
 * Load a working calendar for a date window: the named calendar, else the tenant default, else an
 * empty one (weekends only).
 *
 * Shared with the leave and payroll paths — exported so the three of them cannot end up with three
 * different notions of which calendar applies. Callers must already hold hr-module scope; this
 * opens its own `withTenants` because it is called from several transactions' boundaries.
 */
export async function loadCalendar(
  tenantId: string, calendarId: string | null, fromIso: string, toIso: string,
): Promise<{ id: string | null; weekendDays: number[]; holidays: HolidayEntry[] }> {
  return withTenants(
    [tenantId],
    async (c) => {
      const cal = calendarId
        ? await c.query<{ id: string; weekend_days: number[] }>(
            `SELECT id, weekend_days FROM hr_holiday_calendars WHERE id = $1 AND deleted_at IS NULL`, [calendarId])
        : await c.query<{ id: string; weekend_days: number[] }>(
            `SELECT id, weekend_days FROM hr_holiday_calendars WHERE is_default AND deleted_at IS NULL LIMIT 1`);
      const found = cal.rows[0];
      if (!found) return { id: null, weekendDays: [6, 7], holidays: [] as HolidayEntry[] };
      const holidays = await c.query<{ day: string; kind: HolidayEntry["kind"]; deducts_entitlement: boolean | null }>(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, kind, deducts_entitlement
         FROM hr_holidays WHERE calendar_id = $1 AND day BETWEEN $2 AND $3`,
        [found.id, fromIso, toIso],
      );
      return {
        id: found.id,
        weekendDays: found.weekend_days ?? [6, 7],
        holidays: holidays.rows.map((h) => ({ day: h.day, kind: h.kind, deductsEntitlement: h.deducts_entitlement })),
      };
    },
    { modules: ["hr"] },
  );
}
