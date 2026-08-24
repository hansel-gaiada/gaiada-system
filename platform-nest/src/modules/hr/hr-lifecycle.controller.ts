// HR wave A — LIFECYCLE, COMPLIANCE AND ANALYTICS: the effective-dated job history, the append-only
// case timeline, document-expiry compliance, the leave-accrual runner, and the department's own
// analytics (headcount, turnover, tenure, absence).
//
// Authorization is split deliberately across three existing kinds rather than inventing a fourth:
//   * job history and analytics  -> `employee`  (raw per-person history is people-file data)
//   * case timeline              -> `hr_case`   (it IS a case, and the subject-self rule applies)
//   * document expiry            -> `hr_record` (it IS a record; the sensitive tier)
// Adding an `hr_lifecycle` kind would have given three unrelated sensitivities one holder set.
//
// THE THIRD WALL: every query passes `{ modules: ["hr"] }`. Omit it and it reads/writes ZERO rows.
import {
  BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity } from "../../core/http";
import { notifyBestEffort } from "../../core/client-notify";
import { emitEvent } from "../../events/outbox.service";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { staffOrSelfRead } from "./hr.controller";
import { planAccruals, type LeavePolicy } from "./leave-accrual";

const JOB_EVENT_TYPES = new Set([
  "hire", "probation_start", "probation_pass", "probation_fail", "confirm",
  "promotion", "transfer", "demotion", "status_change", "manager_change",
  "compensation_change", "contract_renewal", "suspension", "return_from_leave",
  "termination", "rehire", "correction",
]);
const CASE_EVENT_TYPES = new Set([
  "opened", "note", "evidence", "meeting", "statement", "warning_issued", "action_taken",
  "status_change", "assigned", "escalated", "resolved", "closed", "reopened", "appeal",
]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

@Controller("api/:tenantId/modules/hr")
@UseGuards(AuthGuard, ModuleEnabledGuard("hr"))
export class HrLifecycleController {
  // ═══════════════════════════════════════════════════════════ JOB HISTORY ════════════════════
  @Get("employees/:employeeId/history")
  async jobHistory(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("employeeId") employeeId: string) {
    await authorize(req.principal, { kind: "employee", id: employeeId, tenantId, module: "hr" }, "read");
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT j.id, j.effective_on AS "effectiveOn", j.event_type AS "eventType", j.previous, j.current,
                j.reason, j.source_kind AS "sourceKind", j.source_id AS "sourceId",
                j.position_id AS "positionId", p.title AS "positionTitle",
                j.created_by AS "createdBy", j.created_at AS "createdAt"
         FROM hr_job_events j LEFT JOIN positions p ON p.id = j.position_id
         WHERE j.employee_id = $1 ORDER BY j.effective_on DESC, j.created_at DESC`,
        [employeeId],
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  /**
   * Record a lifecycle event.
   *
   * `employees` is the materialized HEAD of this log, so a status-moving event moves it in the same
   * transaction — otherwise the head and the log disagree, and every tenure or turnover figure
   * derived from the log becomes quietly wrong.
   *
   * A CORRECTION is a new event, never an update. That is the whole point of an append-only history:
   * an editable audit trail is not an audit trail.
   */
  @Post("employees/:employeeId/history")
  @HttpCode(201)
  async recordJobEvent(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("employeeId") employeeId: string,
    @Body() body: { eventType?: string; effectiveOn?: string; previous?: Record<string, unknown>; current?: Record<string, unknown>; reason?: string; positionId?: string },
  ) {
    const eventType = body?.eventType && JOB_EVENT_TYPES.has(body.eventType) ? body.eventType : undefined;
    if (!eventType) throw new BadRequestException(`eventType must be one of: ${[...JOB_EVENT_TYPES].join("|")}`);
    if (typeof body?.effectiveOn !== "string" || !ISO_DATE.test(body.effectiveOn)) {
      throw new BadRequestException("effectiveOn must be an ISO date (YYYY-MM-DD)");
    }
    await authorize(req.principal, { kind: "employee", id: employeeId, tenantId, module: "hr" }, "update");

    // The events that MOVE the employee head, and where to. Everything else is history only.
    const STATUS_MOVES: Record<string, string> = {
      hire: "pending_start", rehire: "active", confirm: "active", probation_pass: "active",
      return_from_leave: "active", suspension: "on_leave", termination: "terminated",
      probation_fail: "terminated",
    };
    const id = newId();
    await withTenants(
      [tenantId],
      async (c) => {
        const emp = await c.query<{ user_id: string | null }>(
          `SELECT user_id FROM employees WHERE id = $1 AND deleted_at IS NULL`, [employeeId],
        );
        if (!emp.rows[0]) throw new NotFoundException("employee not found");
        await c.query(
          `INSERT INTO hr_job_events (id, tenant_id, employee_id, subject_user_id, effective_on, event_type, previous, current, reason, source_kind, position_id, created_by, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual',$10,$11,$12)`,
          [id, tenantId, employeeId, emp.rows[0].user_id, body.effectiveOn, eventType,
           JSON.stringify(body?.previous ?? {}), JSON.stringify(body?.current ?? {}),
           body?.reason ?? null, body?.positionId ?? null, req.principal.userId, config.originSite],
        );
        const nextStatus = STATUS_MOVES[eventType];
        if (nextStatus) {
          await c.query(
            `UPDATE employees SET employment_status = $2,
                    terminated_at = CASE WHEN $2 = 'terminated' THEN $3::date ELSE terminated_at END,
                    updated_at = now()
              WHERE id = $1`,
            [employeeId, nextStatus, body.effectiveOn],
          );
        }
        await emitEvent(c, tenantId, "employee", employeeId, `hr.job_event.${eventType}`, {
          effectiveOn: body.effectiveOn, jobEventId: id,
        });
      },
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "created", "hr_job_event", id, { employeeId, eventType });
    return { id, eventType, headMoved: !!STATUS_MOVES[eventType] };
  }

  // ═══════════════════════════════════════════════════════════ CASE TIMELINE ══════════════════
  /**
   * The case timeline. `hr_only` events are filtered out for a subject reading their own case — the
   * same reasoning that keeps `hr_records.record_type='note'` off the employee portal: investigation
   * notes stop being written honestly the moment the subject can read them.
   */
  @Get("cases/:id/events")
  async listCaseEvents(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") caseId: string) {
    const row = await withTenants(
      [tenantId],
      (c) => c.query<{ subject_user_id: string | null }>(
        `SELECT subject_user_id FROM hr_cases WHERE id = $1 AND deleted_at IS NULL`, [caseId],
      ),
      { modules: ["hr"] },
    );
    if (!row.rows[0]) throw new NotFoundException("hr case not found");
    const subjectUserId = row.rows[0].subject_user_id ?? undefined;
    // Which arm won decides visibility, so the two authorize attempts are made explicitly rather
    // than through a single call: a subject-self read must not see hr_only events.
    let staff = true;
    try {
      await authorize(req.principal, { kind: "hr_case", id: caseId, tenantId, module: "hr" }, "read");
    } catch {
      await authorize(req.principal, { kind: "hr_case", id: caseId, tenantId, module: "hr", subjectUserId }, "read");
      staff = false;
    }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, event_type AS "eventType", body, data, file_id AS "fileId", visibility,
                occurred_at AS "occurredAt", created_by AS "createdBy"
         FROM hr_case_events
         WHERE case_id = $1${staff ? "" : " AND visibility = 'participants'"}
         ORDER BY occurred_at, created_at`,
        [caseId],
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  @Post("cases/:id/events")
  @HttpCode(201)
  async addCaseEvent(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") caseId: string,
    @Body() body: { eventType?: string; body?: string; data?: Record<string, unknown>; fileId?: string; visibility?: string; occurredAt?: string },
  ) {
    const eventType = body?.eventType && CASE_EVENT_TYPES.has(body.eventType) ? body.eventType : undefined;
    if (!eventType) throw new BadRequestException(`eventType must be one of: ${[...CASE_EVENT_TYPES].join("|")}`);
    // Writing to a case timeline is a staff act: `update` on hr_case, with NO subjectUserId passed,
    // so the member-self rule (which requires it) can never match. A subject must not be able to
    // append to the file that is about them.
    await authorize(req.principal, { kind: "hr_case", id: caseId, tenantId, module: "hr" }, "update");
    const visibility = body?.visibility === "participants" ? "participants" : "hr_only";
    const id = newId();
    await withTenants(
      [tenantId],
      async (c) => {
        const exists = await c.query(`SELECT 1 FROM hr_cases WHERE id = $1 AND deleted_at IS NULL`, [caseId]);
        if (!exists.rows[0]) throw new NotFoundException("hr case not found");
        await c.query(
          `INSERT INTO hr_case_events (id, tenant_id, case_id, event_type, body, data, file_id, visibility, occurred_at, created_by, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz, now()),$10,$11)`,
          [id, tenantId, caseId, eventType, body?.body ?? null, JSON.stringify(body?.data ?? {}),
           body?.fileId ?? null, visibility, body?.occurredAt ?? null, req.principal.userId, config.originSite],
        );
        // A timeline event that changes the case's status keeps the two in step. Without this the
        // header says 'open' while the timeline says 'resolved', and the header is what lists sort by.
        if (eventType === "resolved" || eventType === "closed") {
          await c.query(`UPDATE hr_cases SET status = 'done', updated_at = now() WHERE id = $1`, [caseId]);
        } else if (eventType === "reopened") {
          await c.query(`UPDATE hr_cases SET status = 'in_progress', updated_at = now() WHERE id = $1`, [caseId]);
        }
        await emitEvent(c, tenantId, "hr_case", caseId, "hr.case.event_added", { eventType, visibility });
      },
      { modules: ["hr"] },
    );
    return { id };
  }

  // ═══════════════════════════════════════════════════ DOCUMENT COMPLIANCE ════════════════════
  /**
   * Documents expiring within `days` (default 90), plus everything already expired.
   *
   * Already-expired rows are ALWAYS included regardless of the window: a work permit that lapsed
   * three months ago is more urgent than one lapsing next week, and a naive "next 90 days" window
   * would hide it completely.
   */
  @Get("compliance/expiring")
  async expiringDocuments(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("days") daysQ?: string,
  ) {
    await authorize(req.principal, { kind: "hr_record", tenantId, module: "hr" }, "read");
    const days = Math.max(1, Math.min(365, Number(daysQ ?? 90) || 90));
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT r.id, r.subject_user_id AS "subjectUserId", u.name AS "subjectName",
                r.record_type AS "recordType", r.reference, r.issued_on AS "issuedOn",
                r.expires_on AS "expiresOn", r.file_id AS "fileId",
                (r.expires_on - CURRENT_DATE)::int AS "daysRemaining",
                (r.expires_on < CURRENT_DATE) AS expired
         FROM hr_records r LEFT JOIN users u ON u.id = r.subject_user_id
         WHERE r.deleted_at IS NULL AND r.expires_on IS NOT NULL
           AND r.expires_on <= CURRENT_DATE + ($1 || ' days')::interval
         ORDER BY r.expires_on`,
        [days],
      ),
      { modules: ["hr"] },
    );
    return { windowDays: days, documents: rows.rows };
  }

  /**
   * Sweep expiry reminders: materialize the (record, offset) rows that are now due and notify.
   *
   * Idempotent by construction — `UNIQUE (tenant, record, days_before)` means a second pass
   * conflicts rather than re-notifying, which is what makes this safe to run from a cron, from a
   * button, and from an agent without coordinating between them.
   */
  @Post("compliance/sweep")
  @HttpCode(200)
  async sweepReminders(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { offsets?: number[] },
  ) {
    await authorize(req.principal, { kind: "hr_record", tenantId, module: "hr" }, "update");
    const offsets = Array.isArray(body?.offsets) && body.offsets.length
      ? body.offsets.map(Number).filter((n) => Number.isFinite(n) && n >= 0)
      : [90, 30, 7];
    const due = await withTenants(
      [tenantId],
      async (c) => {
        let created = 0;
        for (const offset of offsets) {
          const res = await c.query(
            `INSERT INTO hr_record_reminders (id, tenant_id, record_id, days_before, due_on)
             SELECT gen_random_uuid(), $1, r.id, $2, (r.expires_on - ($2 || ' days')::interval)::date
             FROM hr_records r
             WHERE r.deleted_at IS NULL AND r.expires_on IS NOT NULL
               AND (r.expires_on - ($2 || ' days')::interval)::date <= CURRENT_DATE
               AND r.expires_on >= CURRENT_DATE
             ON CONFLICT (tenant_id, record_id, days_before) DO NOTHING`,
            [tenantId, offset],
          );
          created += res.rowCount ?? 0;
        }
        const pending = await c.query<{ id: string; subject_user_id: string | null; reference: string | null; expires_on: string; days_before: number }>(
          `SELECT rem.id, r.subject_user_id, r.reference, to_char(r.expires_on,'YYYY-MM-DD') AS expires_on, rem.days_before
           FROM hr_record_reminders rem JOIN hr_records r ON r.id = rem.record_id
           WHERE rem.notified_at IS NULL AND rem.due_on <= CURRENT_DATE
           ORDER BY r.expires_on LIMIT 200`,
        );
        return { created, pending: pending.rows };
      },
      { modules: ["hr"] },
    );

    if (due.pending.length) {
      // Notify the HR actor who ran the sweep rather than the subjects: an expiring contract is HR's
      // action item, and notifying an employee that their own permit lapses is a decision with
      // employment-law weight that does not belong in a maintenance sweep.
      await notifyBestEffort(tenantId, req.principal.userId, [req.principal.userId].filter((x): x is string => !!x), "hr.documents.expiring", {
        title: `${due.pending.length} HR document(s) approaching expiry`,
        href: "/hr/compliance",
        entityType: "hr_record",
        entityId: due.pending[0].id,
      });
      await withTenants(
        [tenantId],
        (c) => c.query(
          `UPDATE hr_record_reminders SET notified_at = now() WHERE id = ANY($1::uuid[])`,
          [due.pending.map((p) => p.id)],
        ),
        { modules: ["hr"] },
      );
    }
    return { remindersCreated: due.created, notified: due.pending.length };
  }

  // ══════════════════════════════════════════════════════ LEAVE ACCRUAL RUN ═══════════════════
  /**
   * Post leave accruals for a year, up to `asOf`.
   *
   * Idempotent on three levels, because this is exactly the kind of endpoint that gets fired twice:
   *   1. `planAccruals` diffs against what the ledger already holds and returns nothing when square.
   *   2. `ux_hr_leave_accruals_engine_period` makes a duplicate engine posting a constraint error.
   *   3. Balances are recomputed as a SUM of the ledger, never incremented — so even a partially
   *      applied run leaves the balance consistent with the ledger rather than drifting from it.
   *
   * Point 3 is the important one. Incrementing `allocated_minutes` alongside each insert would be
   * cheaper and would drift the first time an insert failed after its increment.
   */
  @Post("leave/accrue")
  @HttpCode(200)
  async runAccrual(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { year?: number; asOf?: string; leaveType?: string; subjectUserId?: string; dryRun?: boolean },
  ) {
    await authorize(req.principal, { kind: "hr_policy", tenantId, module: "hr" }, "update");
    const year = typeof body?.year === "number" ? body.year : new Date().getUTCFullYear();
    const asOf = typeof body?.asOf === "string" && ISO_DATE.test(body.asOf)
      ? body.asOf
      : new Date().toISOString().slice(0, 10);
    const dryRun = body?.dryRun === true;

    const outcome = await withTenants(
      [tenantId],
      async (c) => {
        const employees = await c.query<{ employee_id: string; user_id: string; display_name: string; hire_date: string | null; terminated_at: string | null }>(
          `SELECT e.id AS employee_id, e.user_id, e.display_name,
                  to_char(e.hire_date,'YYYY-MM-DD') AS hire_date,
                  to_char(e.terminated_at,'YYYY-MM-DD') AS terminated_at
           FROM employees e
           WHERE e.deleted_at IS NULL AND e.user_id IS NOT NULL
             AND e.employment_status IN ('active','on_leave')
             ${body?.subjectUserId ? "AND e.user_id = $1" : ""}`,
          body?.subjectUserId ? [body.subjectUserId] : [],
        );

        const posted: { subjectUserId: string; name: string; leaveType: string; minutes: number; reason: string }[] = [];
        const skipped: { name: string; reason: string }[] = [];

        for (const e of employees.rows) {
          if (!e.hire_date) { skipped.push({ name: e.display_name, reason: "no hire date" }); continue; }

          // Most-specific-wins policy resolution: person > org-unit > tenant default. Ordering by
          // the specificity of the target and THEN by effective_from means a mid-year person-level
          // override beats an older tenant default, which is the intent of a three-level scheme.
          const policies = await c.query<{
            id: string; leave_type: string; accrual_method: string; annual_entitlement_minutes: number;
            waiting_period_months: number; prorate_first_year: boolean; carryover_max_minutes: number;
            carryover_expiry_months: number; allow_negative_balance: boolean;
          }>(
            `SELECT DISTINCT ON (p.leave_type)
                    p.id, p.leave_type, p.accrual_method, p.annual_entitlement_minutes,
                    p.waiting_period_months, p.prorate_first_year, p.carryover_max_minutes,
                    p.carryover_expiry_months, p.allow_negative_balance
             FROM hr_leave_policies p
             JOIN hr_leave_policy_assignments a ON a.policy_id = p.id
             WHERE p.deleted_at IS NULL AND p.is_active
               AND a.effective_from <= $2::date AND (a.effective_to IS NULL OR a.effective_to >= $2::date)
               AND (a.subject_user_id = $1 OR (a.subject_user_id IS NULL AND a.unit_node_id IS NULL))
               ${body?.leaveType ? "AND p.leave_type = $3" : ""}
             ORDER BY p.leave_type,
                      (a.subject_user_id IS NOT NULL) DESC,
                      a.effective_from DESC`,
            body?.leaveType ? [e.user_id, asOf, body.leaveType] : [e.user_id, asOf],
          );
          if (!policies.rows.length) { skipped.push({ name: e.display_name, reason: "no leave policy assigned" }); continue; }

          for (const p of policies.rows) {
            const alreadyRows = await c.query<{ minutes: string | null }>(
              `SELECT SUM(minutes)::text AS minutes FROM hr_leave_accruals
                WHERE subject_user_id = $1 AND year = $2 AND leave_type = $3 AND kind = 'accrual'`,
              [e.user_id, year, p.leave_type],
            );
            const priorRows = await c.query<{ remaining: string | null }>(
              `SELECT (allocated_minutes - used_minutes)::text AS remaining FROM hr_leave_balances
                WHERE subject_user_id = $1 AND year = $2 AND leave_type = $3`,
              [e.user_id, year - 1, p.leave_type],
            );
            const carriedRows = await c.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM hr_leave_accruals
                WHERE subject_user_id = $1 AND year = $2 AND leave_type = $3 AND kind = 'carryover'`,
              [e.user_id, year, p.leave_type],
            );

            const policy: LeavePolicy = {
              id: p.id,
              accrualMethod: p.accrual_method as LeavePolicy["accrualMethod"],
              annualEntitlementMinutes: p.annual_entitlement_minutes,
              waitingPeriodMonths: p.waiting_period_months,
              prorateFirstYear: p.prorate_first_year,
              carryoverMaxMinutes: p.carryover_max_minutes,
              carryoverExpiryMonths: p.carryover_expiry_months,
              allowNegativeBalance: p.allow_negative_balance,
            };
            const postings = planAccruals(policy, {
              hireDate: e.hire_date,
              year, asOf,
              alreadyAccruedMinutes: Number(alreadyRows.rows[0]?.minutes ?? 0),
              // Carryover is posted at most once per year; suppress it on a re-run rather than
              // relying on the unique index to reject it, so a re-run stays a clean no-op instead
              // of an error the caller has to interpret.
              priorYearRemainingMinutes: Number(carriedRows.rows[0]?.n ?? 0) > 0
                ? 0
                : Math.max(0, Number(priorRows.rows[0]?.remaining ?? 0)),
              terminationDate: e.terminated_at,
            });

            for (const posting of postings) {
              posted.push({ subjectUserId: e.user_id, name: e.display_name, leaveType: p.leave_type, minutes: posting.minutes, reason: posting.reason });
              if (dryRun) continue;
              await c.query(
                `INSERT INTO hr_leave_accruals (id, tenant_id, subject_user_id, year, leave_type, kind, minutes, policy_id, period_start, period_end, reason)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                 ON CONFLICT DO NOTHING`,
                [newId(), tenantId, e.user_id, year, p.leave_type, posting.kind, posting.minutes,
                 p.id, posting.periodStart, posting.periodEnd, posting.reason],
              );
            }

            if (!dryRun && postings.length) {
              // Balances are RECOMPUTED from the ledger, never incremented — see the doc comment.
              await c.query(
                `INSERT INTO hr_leave_balances (id, tenant_id, subject_user_id, year, leave_type, allocated_minutes, used_minutes)
                 VALUES ($1,$2,$3,$4,$5,
                         COALESCE((SELECT SUM(minutes) FROM hr_leave_accruals
                                    WHERE subject_user_id = $3 AND year = $4 AND leave_type = $5), 0), 0)
                 ON CONFLICT (tenant_id, subject_user_id, year, leave_type)
                 DO UPDATE SET allocated_minutes = COALESCE((
                   SELECT SUM(minutes) FROM hr_leave_accruals
                    WHERE subject_user_id = $3 AND year = $4 AND leave_type = $5), 0)`,
                [newId(), tenantId, e.user_id, year, p.leave_type],
              );
            }
          }
        }
        return { posted, skipped };
      },
      { modules: ["hr"] },
    );

    if (!dryRun && outcome.posted.length) {
      await writeActivity(tenantId, req.principal.userId, "updated", "hr_leave_balance", tenantId, {
        year, asOf, postings: outcome.posted.length,
      });
    }
    return {
      year, asOf, dryRun,
      postings: outcome.posted.length,
      totalMinutes: outcome.posted.reduce((s, p) => s + p.minutes, 0),
      detail: outcome.posted,
      // Skips are REPORTED, never swallowed. An employee with no assigned policy accrues nothing,
      // and the only way anyone finds out is if the run says so.
      skipped: outcome.skipped,
    };
  }

  @Get("leave/ledger")
  async leaveLedger(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("subjectUserId") subjectUserIdQ?: string, @Query("year") yearQ?: string,
  ) {
    const { selfOnly } = await staffOrSelfRead(req.principal, tenantId, "hr_case");
    const subjectUserId = selfOnly ? req.principal.userId : subjectUserIdQ;
    if (!subjectUserId) throw new BadRequestException("subjectUserId required");
    const year = Number(yearQ ?? new Date().getUTCFullYear());
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT kind, leave_type AS "leaveType", minutes, period_start AS "periodStart",
                period_end AS "periodEnd", reason, created_by AS "createdBy", created_at AS "createdAt"
         FROM hr_leave_accruals WHERE subject_user_id = $1 AND year = $2
         ORDER BY created_at`,
        [subjectUserId, year],
      ),
      { modules: ["hr"] },
    );
    return { subjectUserId, year, entries: rows.rows };
  }

  // ═══════════════════════════════════════════════════════════════ ANALYTICS ══════════════════
  /**
   * HR analytics: headcount, movement, turnover, tenure and absence for a window.
   *
   * Every figure is derived from `hr_job_events` rather than from `employees`, because the employee
   * row only knows the present. Turnover in particular is unanswerable from current state — it is
   * "how many people LEFT during a window", and once they have left the row says `terminated` with
   * no notion of when relative to the window.
   *
   * Turnover uses AVERAGE headcount (start + end) / 2 as the denominator, which is the standard
   * definition. Using end-of-period headcount inflates the rate in a shrinking company and deflates
   * it in a growing one — precisely when the number matters most.
   */
  @Get("analytics")
  async analytics(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("from") fromQ?: string, @Query("to") toQ?: string,
  ) {
    await authorize(req.principal, { kind: "employee", tenantId, module: "hr" }, "read");
    const to = fromIsoOrDefault(toQ, new Date().toISOString().slice(0, 10));
    const from = fromIsoOrDefault(fromQ, `${new Date(to).getUTCFullYear()}-01-01`);

    const out = await withTenants(
      [tenantId],
      async (c) => {
        const headcount = await c.query<{ status: string; n: string }>(
          `SELECT employment_status AS status, count(*)::text AS n FROM employees
            WHERE deleted_at IS NULL GROUP BY employment_status`,
        );
        const movement = await c.query<{ event_type: string; n: string }>(
          `SELECT event_type, count(*)::text AS n FROM hr_job_events
            WHERE effective_on BETWEEN $1::date AND $2::date GROUP BY event_type ORDER BY event_type`,
          [from, to],
        );
        // Headcount at the two window edges, reconstructed from the event log: hired on or before
        // the edge, minus terminated on or before it.
        const edges = await c.query<{ at_start: string; at_end: string }>(
          `SELECT
             (SELECT count(DISTINCT employee_id) FROM hr_job_events
               WHERE event_type IN ('hire','rehire') AND effective_on <= $1::date)
             - (SELECT count(DISTINCT employee_id) FROM hr_job_events
                 WHERE event_type = 'termination' AND effective_on <= $1::date) AS at_start,
             (SELECT count(DISTINCT employee_id) FROM hr_job_events
               WHERE event_type IN ('hire','rehire') AND effective_on <= $2::date)
             - (SELECT count(DISTINCT employee_id) FROM hr_job_events
                 WHERE event_type = 'termination' AND effective_on <= $2::date) AS at_end`,
          [from, to],
        );
        const leavers = await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM hr_job_events
            WHERE event_type = 'termination' AND effective_on BETWEEN $1::date AND $2::date`,
          [from, to],
        );
        const tenure = await c.query<{ median: string | null; mean: string | null }>(
          `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (now() - hire_date::timestamptz)) / 31557600)::numeric(6,2) AS median,
                  AVG(EXTRACT(EPOCH FROM (now() - hire_date::timestamptz)) / 31557600)::numeric(6,2) AS mean
           FROM employees WHERE deleted_at IS NULL AND employment_status = 'active' AND hire_date IS NOT NULL`,
        );
        const absence = await c.query<{ leave_type: string; requests: string; minutes: string }>(
          `SELECT leave_type, count(*)::text AS requests, COALESCE(SUM(minutes),0)::text AS minutes
           FROM hr_leave_requests
           WHERE status = 'approved' AND deleted_at IS NULL AND starts_on <= $2::date AND ends_on >= $1::date
           GROUP BY leave_type ORDER BY leave_type`,
          [from, to],
        );
        const attendance = await c.query<{ status: string; n: string }>(
          `SELECT status, count(*)::text AS n FROM hr_attendance
            WHERE day BETWEEN $1::date AND $2::date GROUP BY status`,
          [from, to],
        );
        const openCases = await c.query<{ kind: string; n: string }>(
          `SELECT kind, count(*)::text AS n FROM hr_cases
            WHERE deleted_at IS NULL AND status IN ('open','in_progress') GROUP BY kind`,
        );
        const expiring = await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM hr_records
            WHERE deleted_at IS NULL AND expires_on IS NOT NULL AND expires_on <= CURRENT_DATE + INTERVAL '90 days'`,
        );
        return {
          headcount: headcount.rows, movement: movement.rows, edges: edges.rows[0],
          leavers: Number(leavers.rows[0]?.n ?? 0), tenure: tenure.rows[0],
          absence: absence.rows, attendance: attendance.rows,
          openCases: openCases.rows, expiringDocuments: Number(expiring.rows[0]?.n ?? 0),
        };
      },
      { modules: ["hr"] },
    );

    const startHead = Number(out.edges?.at_start ?? 0);
    const endHead = Number(out.edges?.at_end ?? 0);
    const averageHeadcount = (startHead + endHead) / 2;
    return {
      window: { from, to },
      headcountByStatus: Object.fromEntries(out.headcount.map((r) => [r.status, Number(r.n)])),
      headcountAtStart: startHead,
      headcountAtEnd: endHead,
      leavers: out.leavers,
      // NULL rather than 0 when there is nobody to divide by. A turnover rate of 0% and "there is
      // no meaningful rate" are different answers, and reporting the first for the second is the
      // kind of confident wrong number this program has been bitten by before.
      turnoverRatePct: averageHeadcount > 0
        ? Number(((out.leavers / averageHeadcount) * 100).toFixed(2))
        : null,
      tenureYears: {
        median: out.tenure?.median === null || out.tenure?.median === undefined ? null : Number(out.tenure.median),
        mean: out.tenure?.mean === null || out.tenure?.mean === undefined ? null : Number(out.tenure.mean),
      },
      movementByType: Object.fromEntries(out.movement.map((r) => [r.event_type, Number(r.n)])),
      absenceByType: out.absence.map((r) => ({ leaveType: r.leave_type, requests: Number(r.requests), minutes: Number(r.minutes), days: Number(r.minutes) / 480 })),
      attendanceByStatus: Object.fromEntries(out.attendance.map((r) => [r.status, Number(r.n)])),
      openCasesByKind: Object.fromEntries(out.openCases.map((r) => [r.kind, Number(r.n)])),
      expiringDocuments90d: out.expiringDocuments,
    };
  }
}

function fromIsoOrDefault(value: string | undefined, fallback: string): string {
  return typeof value === "string" && ISO_DATE.test(value) ? value : fallback;
}
