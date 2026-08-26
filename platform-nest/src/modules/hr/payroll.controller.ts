// HR waves C+D — COMPENSATION, BENEFITS AND PAYROLL. The money surface.
//
// Authorizes as the `hr_payroll` Cerbos kind (resource_hr_payroll.yaml) — a deliberate step above
// `hr_record`: an HR assistant who legitimately files leave and uploads contracts has no business
// reading the company's salary book. The ONLY non-HR reach is a subject reading their own PUBLISHED
// payslip and their own compensation, guarded on both `subjectUserId` and `published`.
//
// ── Two invariants this file exists to hold ─────────────────────────────────────────────────────
//
// 1. COMPENSATION IS CLOSED, NEVER OVERWRITTEN. A raise closes the incumbent row and opens a new one
//    IN THE SAME TRANSACTION. `ex_hr_compensation_no_overlap` makes a second open row structurally
//    impossible, so payroll's point-in-time lookup is provably single-valued and any past period
//    recomputes exactly.
//
// 2. A FINALIZED RUN IS FROZEN. Payslips and their lines are materialized at calculation and never
//    recomputed on read — the same reasoning 0081 froze the loan schedule with. A later change to a
//    tax rate or a rounding rule must never silently rewrite what somebody was told they earned.
//
// ── The statutory gate ──────────────────────────────────────────────────────────────────────────
// Every regulated number comes from `hr_statutory_parameters`, effective-dated, carrying a
// `ratified_by` signature that is NULL until an owner signs off. `approveRun` REFUSES to finalize
// against an unratified set unless the caller explicitly forces it — and the force is recorded on
// the run, permanently. That is the employee-portal blueprint's "blocked on statutory facts" gate,
// re-expressed as data so the engine could be built without waiting on it.
//
// THE THIRD WALL: every query passes `{ modules: ["hr"] }`. Omit it and it reads/writes ZERO rows.
import {
  BadRequestException, Body, Controller, ConflictException, Get, HttpCode, NotFoundException,
  Param, Patch, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity } from "../../core/http";
import { notifyBestEffort } from "../../core/client-notify";
import { resolveAutomationApprovalDeciders } from "../../core/approval-deciders";
import { emitEvent } from "../../events/outbox.service";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import type { Principal } from "../../rbac/principal";
import {
  computePayslip, computeThr, DEFAULT_PARAMS_UNRATIFIED, terCategoryFor, periodBaseAmount,
  type PayComponent, type StatutoryParams,
} from "./payroll-calc";
import { computeSeverance, DEFAULT_SEVERANCE_UNRATIFIED, type SeveranceParams } from "./severance";
import { countWorkingDays, completedMonths, serviceYears } from "./working-days";
import { loadCalendar } from "./hr-policy.controller";

// Two independent dimensions, not one list. RATE_BASES is the unit the amount is QUOTED in — HR's
// fact about the contract. PAY_FREQUENCIES is how often a payslip is produced — Finance's
// operational cadence. An annual salary paid monthly and an hourly rate paid weekly are both
// ordinary, and neither can be expressed with a single field.
const RATE_BASES = new Set(["hourly", "daily", "weekly", "monthly", "annual", "piece_rate"]);
const PAY_FREQUENCIES = new Set(["weekly", "biweekly", "semi_monthly", "monthly"]);
const RUN_KINDS = new Set(["regular", "thr", "bonus", "final", "correction"]);
const CHANGE_REASONS = new Set([
  "hire", "annual_review", "promotion", "market_adjustment", "demotion", "correction", "contract_renewal", "other",
]);
const SEPARATION_GROUNDS = new Set([
  "resignation", "contract_end", "retirement", "mutual_agreement", "redundancy",
  "efficiency", "misconduct", "prolonged_illness", "death", "probation_fail", "other",
]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const requireIsoDate = (v: unknown, field: string): string => {
  if (typeof v !== "string" || !ISO_DATE.test(v)) throw new BadRequestException(`${field} must be an ISO date (YYYY-MM-DD)`);
  return v;
};

/**
 * Staff-or-self on the payroll kind.
 *
 * Unlike `staffOrSelfRead` in hr.controller.ts, the fallback passes `published: true` as well —
 * because the policy's member arm requires it, and a caller who omitted it would be denied with a
 * confusing message rather than told that a draft payslip is not theirs to see yet.
 */
async function payrollStaffOrSelf(
  principal: Principal, tenantId: string, action = "read",
): Promise<{ selfOnly: boolean }> {
  try {
    await authorize(principal, { kind: "hr_payroll", tenantId, module: "hr" }, action);
    return { selfOnly: false };
  } catch {
    await authorize(
      principal,
      { kind: "hr_payroll", tenantId, module: "hr", subjectUserId: principal.userId ?? undefined, published: true },
      action,
    );
    return { selfOnly: true };
  }
}

/**
 * Load the statutory parameter set in force on `onDate`, assembled into the engine's shape.
 *
 * Falls back to `DEFAULT_PARAMS_UNRATIFIED` when the tenant has configured nothing — and says so in
 * the returned `setId: null`, which is what makes the "unratified" refusal below fire. Silently
 * computing with built-in defaults and reporting success would be the worst of both worlds.
 */
async function loadStatutoryParams(
  tenantId: string, onDate: string,
): Promise<{ setId: string | null; ratified: boolean; params: StatutoryParams; severance: SeveranceParams }> {
  return withTenants(
    [tenantId],
    async (c) => {
      const set = await c.query<{ id: string; ratified_at: string | null }>(
        `SELECT id, ratified_at FROM hr_statutory_parameter_sets
          WHERE effective_from <= $1::date AND (effective_to IS NULL OR effective_to >= $1::date)
          ORDER BY effective_from DESC LIMIT 1`,
        [onDate],
      );
      const found = set.rows[0];
      if (!found) {
        return {
          setId: null, ratified: false,
          params: DEFAULT_PARAMS_UNRATIFIED, severance: DEFAULT_SEVERANCE_UNRATIFIED,
        };
      }
      const rows = await c.query<{ key: string; value_num: string | null; value_json: unknown }>(
        `SELECT key, value_num, value_json FROM hr_statutory_parameters WHERE set_id = $1`, [found.id],
      );
      // Start from the fixture shape and overlay whatever the set actually defines. A partially
      // configured set is a real state (a tenant adding this year's BPJS caps before the TER tables
      // land), and refusing to compute at all would be less useful than computing with the gaps
      // flagged by the ratification signature the run records.
      const params: StatutoryParams = JSON.parse(JSON.stringify(DEFAULT_PARAMS_UNRATIFIED));
      const severance: SeveranceParams = JSON.parse(JSON.stringify(DEFAULT_SEVERANCE_UNRATIFIED));
      for (const r of rows.rows) {
        const num = r.value_num === null ? undefined : Number(r.value_num);
        const json = r.value_json;
        const parts = r.key.split(".");
        if (parts[0] === "bpjs" && parts.length === 3) {
          const code = `bpjs_${parts[1]}`;
          params.contributions[code] = params.contributions[code] ?? { employerRate: 0, employeeRate: 0 };
          const field = parts[2];
          if (num !== undefined) {
            if (field === "employer_rate") params.contributions[code].employerRate = num;
            else if (field === "employee_rate") params.contributions[code].employeeRate = num;
            else if (field === "wage_cap") params.contributions[code].wageCap = num;
            else if (field === "wage_floor") params.contributions[code].wageFloor = num;
          }
        } else if (parts[0] === "pph21" && parts[1] === "ptkp" && num !== undefined) {
          params.ptkp[parts.slice(2).join("/")] = num;
        } else if (r.key === "pph21.brackets" && Array.isArray(json)) {
          params.brackets = json as StatutoryParams["brackets"];
        } else if (r.key.startsWith("pph21.ter.") && Array.isArray(json)) {
          const cat = r.key.slice("pph21.ter.".length) as "A" | "B" | "C";
          if (cat === "A" || cat === "B" || cat === "C") params.ter[cat] = json as StatutoryParams["ter"]["A"];
        } else if (r.key === "pph21.no_npwp_multiplier" && num !== undefined) {
          params.noNpwpMultiplier = num;
        } else if (r.key === "pph21.occupational_cost.rate" && num !== undefined) {
          params.occupationalCost.rate = num;
        } else if (r.key === "pph21.occupational_cost.monthly_cap" && num !== undefined) {
          params.occupationalCost.monthlyCap = num;
        } else if (r.key === "thr.min_service_months" && num !== undefined) {
          params.thrMinServiceMonths = num;
        } else if (r.key === "severance.grounds" && json && typeof json === "object") {
          severance.grounds = { ...severance.grounds, ...(json as SeveranceParams["grounds"]) };
        } else if (r.key === "severance.table" && Array.isArray(json)) {
          severance.severanceTable = json as SeveranceParams["severanceTable"];
        } else if (r.key === "severance.service_reward_table" && Array.isArray(json)) {
          severance.serviceRewardTable = json as SeveranceParams["serviceRewardTable"];
        }
      }
      return { setId: found.id, ratified: !!found.ratified_at, params, severance };
    },
    { modules: ["hr"] },
  );
}

@Controller("api/:tenantId/modules/hr")
@UseGuards(AuthGuard, ModuleEnabledGuard("hr"))
export class PayrollController {
  // ═══════════════════════════════════════════════════════════ COMPENSATION ═══════════════════
  @Get("compensation")
  async listCompensation(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("employeeId") employeeId?: string, @Query("current") current?: string,
  ) {
    const { selfOnly } = await payrollStaffOrSelf(req.principal, tenantId);
    const params: unknown[] = [];
    const clauses = ["1=1"];
    if (selfOnly) { params.push(req.principal.userId); clauses.push(`c.subject_user_id = $${params.length}`); }
    else if (employeeId) { params.push(employeeId); clauses.push(`c.employee_id = $${params.length}`); }
    if (current === "true") clauses.push("c.effective_to IS NULL");
    const rows = await withTenants(
      [tenantId],
      (client) => client.query(
        `SELECT c.id, c.employee_id AS "employeeId", e.display_name AS "employeeName",
                c.subject_user_id AS "subjectUserId", c.grade_id AS "gradeId", g.code AS "gradeCode",
                c.base_amount AS "baseAmount", c.currency, c.rate_basis AS "rateBasis",
                c.pay_frequency AS "payFrequency", c.fte,
                c.effective_from AS "effectiveFrom", c.effective_to AS "effectiveTo",
                c.change_reason AS "changeReason", c.approved_at AS "approvedAt", c.note
         FROM hr_compensation c
         JOIN employees e ON e.id = c.employee_id
         LEFT JOIN hr_pay_grades g ON g.id = c.grade_id
         WHERE ${clauses.join(" AND ")} ORDER BY e.display_name, c.effective_from DESC LIMIT 1000`,
        params,
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  /**
   * Set an employee's compensation from a date.
   *
   * The whole operation is one transaction that CLOSES the incumbent row before opening the new one.
   * Doing it in two calls would leave a window in which `ex_hr_compensation_no_overlap` rejects the
   * insert — correct, but as a constraint error rather than as the intended behaviour — and a window
   * in which a concurrent payroll run sees no open row at all.
   */
  @Post("compensation")
  @HttpCode(201)
  async setCompensation(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: {
      employeeId?: string; baseAmount?: number; currency?: string;
      rateBasis?: string; payFrequency?: string; fte?: number;
      gradeId?: string; effectiveFrom?: string; changeReason?: string; note?: string;
    },
  ) {
    if (!body?.employeeId) throw new BadRequestException("employeeId required");
    const baseAmount = typeof body?.baseAmount === "number" ? body.baseAmount : undefined;
    if (baseAmount === undefined || baseAmount < 0) throw new BadRequestException("baseAmount >= 0 required");
    const effectiveFrom = requireIsoDate(body?.effectiveFrom, "effectiveFrom");
    // Both fall back to monthly rather than rejecting an omission — monthly/monthly is the
    // Indonesian norm and the shape the payroll engine already expects. An UNRECOGNISED value also
    // falls back rather than 400ing, matching how every other enum in this controller behaves;
    // the database CHECK is the wall, this is the convenience.
    const rateBasis = body?.rateBasis && RATE_BASES.has(body.rateBasis) ? body.rateBasis : "monthly";
    const payFrequency =
      body?.payFrequency && PAY_FREQUENCIES.has(body.payFrequency) ? body.payFrequency : "monthly";
    const changeReason = body?.changeReason && CHANGE_REASONS.has(body.changeReason) ? body.changeReason : "other";
    await authorize(req.principal, { kind: "hr_payroll", tenantId, module: "hr" }, "create");

    const id = newId();
    const out = await withTenants(
      [tenantId],
      async (c) => {
        const emp = await c.query<{ user_id: string | null; display_name: string }>(
          `SELECT user_id, display_name FROM employees WHERE id = $1 AND deleted_at IS NULL`, [body.employeeId],
        );
        if (!emp.rows[0]) throw new NotFoundException("employee not found");

        // Band check, when the employee is being placed on a grade.
        if (body?.gradeId) {
          const grade = await c.query<{ code: string; min_amount: string; max_amount: string }>(
            `SELECT code, min_amount, max_amount FROM hr_pay_grades WHERE id = $1 AND deleted_at IS NULL`, [body.gradeId],
          );
          const g = grade.rows[0];
          if (!g) throw new NotFoundException("pay grade not found");
          if (baseAmount < Number(g.min_amount) || baseAmount > Number(g.max_amount)) {
            throw new BadRequestException(
              `${baseAmount} is outside grade ${g.code}'s band (${g.min_amount}–${g.max_amount})`,
            );
          }
        }

        // Close the incumbent. `effective_to = effectiveFrom - 1 day` because the migration's
        // daterange uses INCLUSIVE bounds on both ends — closing it AT effectiveFrom would leave a
        // one-day overlap and the exclusion constraint would (correctly) reject the insert.
        const closed = await c.query(
          `UPDATE hr_compensation
              SET effective_to = ($2::date - INTERVAL '1 day')::date, updated_at = now()
            WHERE employee_id = $1 AND effective_to IS NULL AND effective_from < $2::date`,
          [body.employeeId, effectiveFrom],
        );

        await c.query(
          `INSERT INTO hr_compensation
             (id, tenant_id, employee_id, subject_user_id, grade_id, base_amount, currency,
              rate_basis, pay_frequency, fte,
              effective_from, change_reason, note, created_by, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [id, tenantId, body.employeeId, emp.rows[0].user_id, body?.gradeId ?? null, baseAmount,
           body?.currency ?? "IDR", rateBasis, payFrequency, body?.fte ?? 1, effectiveFrom, changeReason,
           body?.note ?? null, req.principal.userId, config.originSite],
        );

        // The money record and the job history must not tell different stories about the same
        // promotion, so a compensation change always writes its lifecycle event.
        const jobEventId = newId();
        await c.query(
          `INSERT INTO hr_job_events (id, tenant_id, employee_id, subject_user_id, effective_on, event_type, previous, current, reason, source_kind, created_by, origin_site)
           VALUES ($1,$2,$3,$4,$5,'compensation_change','{}',$6,$7,'manual',$8,$9)`,
          [jobEventId, tenantId, body.employeeId, emp.rows[0].user_id, effectiveFrom,
           JSON.stringify({ baseAmount, currency: body?.currency ?? "IDR", rateBasis, payFrequency, fte: body?.fte ?? 1 }),
           changeReason, req.principal.userId, config.originSite],
        );
        await c.query(`UPDATE hr_compensation SET job_event_id = $2 WHERE id = $1`, [id, jobEventId]);
        await emitEvent(c, tenantId, "hr_compensation", id, "hr.compensation.changed", {
          employeeId: body.employeeId, changeReason, effectiveFrom,
        });
        return { supersededRows: closed.rowCount ?? 0, employeeName: emp.rows[0].display_name };
      },
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "created", "hr_compensation", id, {
      employeeId: body.employeeId, changeReason, effectiveFrom,
    });
    return { id, effectiveFrom, ...out };
  }

  // ═══════════════════════════════════════════════════ ALLOWANCES & BENEFITS ══════════════════
  @Get("allowance-types")
  async listAllowanceTypes(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "hr_payroll", tenantId, module: "hr" }, "read");
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, code, label, direction, calc_kind AS "calcKind", default_amount AS "defaultAmount",
                default_percent AS "defaultPercent", taxable, bpjs_base AS "bpjsBase", prorated, is_active AS "isActive"
         FROM hr_allowance_types ORDER BY direction, code`,
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  @Post("allowance-types")
  @HttpCode(201)
  async createAllowanceType(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: Record<string, unknown>,
  ) {
    if (!body?.code || !body?.label) throw new BadRequestException("code and label required");
    await authorize(req.principal, { kind: "hr_payroll", tenantId, module: "hr" }, "create");
    const id = newId();
    await withTenants(
      [tenantId],
      (c) => c.query(
        `INSERT INTO hr_allowance_types (id, tenant_id, code, label, direction, calc_kind, default_amount, default_percent, taxable, bpjs_base, prorated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (tenant_id, code) DO UPDATE SET
           label = EXCLUDED.label, direction = EXCLUDED.direction, calc_kind = EXCLUDED.calc_kind,
           default_amount = EXCLUDED.default_amount, default_percent = EXCLUDED.default_percent,
           taxable = EXCLUDED.taxable, bpjs_base = EXCLUDED.bpjs_base, prorated = EXCLUDED.prorated,
           updated_at = now()`,
        [id, tenantId, body.code, body.label, body?.direction ?? "allowance", body?.calcKind ?? "fixed",
         body?.defaultAmount ?? null, body?.defaultPercent ?? null,
         body?.taxable !== false, body?.bpjsBase === true, body?.prorated !== false],
      ),
      { modules: ["hr"] },
    );
    return { id, code: body.code };
  }

  @Post("employees/:employeeId/allowances")
  @HttpCode(201)
  async assignAllowance(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("employeeId") employeeId: string,
    @Body() body: { allowanceTypeId?: string; amount?: number; percent?: number; effectiveFrom?: string; effectiveTo?: string; note?: string },
  ) {
    if (!body?.allowanceTypeId) throw new BadRequestException("allowanceTypeId required");
    const effectiveFrom = requireIsoDate(body?.effectiveFrom, "effectiveFrom");
    await authorize(req.principal, { kind: "hr_payroll", tenantId, module: "hr" }, "create");
    const id = newId();
    try {
      await withTenants(
        [tenantId],
        (c) => c.query(
          `INSERT INTO hr_employee_allowances (id, tenant_id, employee_id, allowance_type_id, amount, percent, effective_from, effective_to, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [id, tenantId, employeeId, body.allowanceTypeId, body?.amount ?? null, body?.percent ?? null,
           effectiveFrom, body?.effectiveTo ?? null, body?.note ?? null, req.principal.userId],
        ),
        { modules: ["hr"] },
      );
    } catch (err) {
      if (String((err as { message?: string })?.message ?? "").includes("ex_hr_employee_allowances_no_overlap")) {
        throw new ConflictException("this employee already holds that allowance over an overlapping period — close the existing one first");
      }
      throw err;
    }
    return { id };
  }

  @Get("benefit-plans")
  async listBenefitPlans(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "hr_payroll", tenantId, module: "hr" }, "read");
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, code, name, kind, statutory_code AS "statutoryCode", provider,
                employer_rate AS "employerRate", employee_rate AS "employeeRate",
                wage_cap AS "wageCap", wage_floor AS "wageFloor", currency, is_active AS "isActive"
         FROM hr_benefit_plans ORDER BY kind, code`,
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  @Post("benefit-plans")
  @HttpCode(201)
  async createBenefitPlan(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: Record<string, unknown>,
  ) {
    if (!body?.code || !body?.name) throw new BadRequestException("code and name required");
    await authorize(req.principal, { kind: "hr_payroll", tenantId, module: "hr" }, "create");
    const id = newId();
    await withTenants(
      [tenantId],
      (c) => c.query(
        `INSERT INTO hr_benefit_plans (id, tenant_id, code, name, kind, statutory_code, provider, employer_rate, employee_rate, wage_cap, wage_floor, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (tenant_id, code) DO UPDATE SET
           name = EXCLUDED.name, kind = EXCLUDED.kind, statutory_code = EXCLUDED.statutory_code,
           provider = EXCLUDED.provider, employer_rate = EXCLUDED.employer_rate,
           employee_rate = EXCLUDED.employee_rate, wage_cap = EXCLUDED.wage_cap,
           wage_floor = EXCLUDED.wage_floor, updated_at = now()`,
        [id, tenantId, body.code, body.name, body?.kind ?? "statutory", body?.statutoryCode ?? null,
         body?.provider ?? null, body?.employerRate ?? null, body?.employeeRate ?? null,
         body?.wageCap ?? null, body?.wageFloor ?? null, body?.currency ?? "IDR"],
      ),
      { modules: ["hr"] },
    );
    return { id, code: body.code };
  }

  @Post("employees/:employeeId/benefits")
  @HttpCode(201)
  async enrolBenefit(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("employeeId") employeeId: string,
    @Body() body: { planId?: string; memberNumber?: string; dependants?: number; effectiveFrom?: string; effectiveTo?: string },
  ) {
    if (!body?.planId) throw new BadRequestException("planId required");
    const effectiveFrom = requireIsoDate(body?.effectiveFrom, "effectiveFrom");
    await authorize(req.principal, { kind: "hr_payroll", tenantId, module: "hr" }, "create");
    const id = newId();
    try {
      await withTenants(
        [tenantId],
        (c) => c.query(
          `INSERT INTO hr_benefit_enrollments (id, tenant_id, employee_id, plan_id, member_number, dependants, effective_from, effective_to, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, tenantId, employeeId, body.planId, body?.memberNumber ?? null, body?.dependants ?? 0,
           effectiveFrom, body?.effectiveTo ?? null, req.principal.userId],
        ),
        { modules: ["hr"] },
      );
    } catch (err) {
      if (String((err as { message?: string })?.message ?? "").includes("ex_hr_benefit_enrollments_no_overlap")) {
        throw new ConflictException("this employee is already enrolled in that plan over an overlapping period");
      }
      throw err;
    }
    return { id };
  }

  @Post("employees/:employeeId/tax-profile")
  @HttpCode(201)
  async setTaxProfile(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("employeeId") employeeId: string,
    @Body() body: { npwp?: string; ptkpStatus?: string; terCategory?: string; taxResident?: boolean; effectiveFrom?: string },
  ) {
    const effectiveFrom = requireIsoDate(body?.effectiveFrom, "effectiveFrom");
    const ptkpStatus = body?.ptkpStatus ?? "TK/0";
    await authorize(req.principal, { kind: "hr_payroll", tenantId, module: "hr" }, "create");
    const id = newId();
    await withTenants(
      [tenantId],
      async (c) => {
        await c.query(
          `UPDATE hr_tax_profiles SET effective_to = ($2::date - INTERVAL '1 day')::date, updated_at = now()
            WHERE employee_id = $1 AND effective_to IS NULL AND effective_from < $2::date`,
          [employeeId, effectiveFrom],
        );
        await c.query(
          `INSERT INTO hr_tax_profiles (id, tenant_id, employee_id, npwp, has_npwp, ptkp_status, ter_category, tax_resident, effective_from, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [id, tenantId, employeeId, body?.npwp ?? null, !!body?.npwp, ptkpStatus,
           // Stored rather than derived at read time: the PTKP -> TER mapping is itself regulated,
           // and a future change to it must not retroactively re-categorize past runs.
           body?.terCategory ?? terCategoryFor(ptkpStatus), body?.taxResident !== false,
           effectiveFrom, req.principal.userId],
        );
      },
      { modules: ["hr"] },
    );
    return { id };
  }

  // ════════════════════════════════════════════════════════════ PAYROLL RUNS ══════════════════
  @Get("payroll-runs")
  async listRuns(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("status") status?: string,
  ) {
    await authorize(req.principal, { kind: "hr_payroll", tenantId, module: "hr" }, "read");
    const params: unknown[] = [];
    const clauses = ["deleted_at IS NULL"];
    if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, reference, kind, period_start AS "periodStart", period_end AS "periodEnd",
                pay_date AS "payDate", currency, status, parameter_set_id AS "parameterSetId",
                unratified_override_at AS "unratifiedOverrideAt", total_gross AS "totalGross",
                total_net AS "totalNet", total_employer_cost AS "totalEmployerCost",
                employee_count AS "employeeCount", calculated_at AS "calculatedAt",
                approved_at AS "approvedAt", paid_at AS "paidAt", created_at
         FROM hr_payroll_runs WHERE ${clauses.join(" AND ")} ORDER BY period_end DESC LIMIT 200`,
        params,
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  @Post("payroll-runs")
  @HttpCode(201)
  async createRun(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { reference?: string; kind?: string; periodStart?: string; periodEnd?: string; payDate?: string; currency?: string; note?: string },
  ) {
    if (!body?.reference) throw new BadRequestException("reference required");
    const kind = body?.kind && RUN_KINDS.has(body.kind) ? body.kind : "regular";
    const periodStart = requireIsoDate(body?.periodStart, "periodStart");
    const periodEnd = requireIsoDate(body?.periodEnd, "periodEnd");
    if (periodEnd < periodStart) throw new BadRequestException("periodEnd must be >= periodStart");
    await authorize(req.principal, { kind: "hr_payroll", tenantId, module: "hr" }, "create");
    const id = newId();
    try {
      await withTenants(
        [tenantId],
        async (c) => {
          await c.query(
            `INSERT INTO hr_payroll_runs (id, tenant_id, reference, kind, period_start, period_end, pay_date, currency, note, created_by, origin_site)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [id, tenantId, body.reference, kind, periodStart, periodEnd, body?.payDate ?? null,
             body?.currency ?? "IDR", body?.note ?? null, req.principal.userId, config.originSite],
          );
          await emitEvent(c, tenantId, "hr_payroll_run", id, "hr.payroll_run.created", { kind, periodStart, periodEnd });
        },
        { modules: ["hr"] },
      );
    } catch (err) {
      const msg = String((err as { message?: string })?.message ?? "");
      if (msg.includes("ux_hr_payroll_runs_regular_period")) {
        throw new ConflictException("a regular payroll run already exists for that period — use kind=correction for an off-cycle adjustment");
      }
      if (msg.includes("ux_hr_payroll_runs_reference")) throw new ConflictException("that run reference is already in use");
      throw err;
    }
    return { id, status: "draft" };
  }

  /**
   * CALCULATE a run: resolve every active employee's inputs, compute their payslip through the pure
   * engine, and materialize the payslips and their lines.
   *
   * Re-runnable while the run is `draft` or `calculated` — it deletes and rebuilds the payslips.
   * Deliberately NOT re-runnable after approval: the payslips are then the artefact people were
   * given, and a silent rebuild is exactly what the whole freeze discipline exists to prevent. A
   * post-approval fix is a `correction` run.
   */
  @Post("payroll-runs/:id/calculate")
  @HttpCode(200)
  async calculateRun(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "hr_payroll", id, tenantId, module: "hr" }, "update");

    const run = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query<{ status: string; kind: string; period_start: string; period_end: string; currency: string }>(
          `SELECT status, kind, to_char(period_start,'YYYY-MM-DD') AS period_start,
                  to_char(period_end,'YYYY-MM-DD') AS period_end, currency
           FROM hr_payroll_runs WHERE id = $1 AND deleted_at IS NULL`,
          [id],
        );
        if (!r.rows[0]) throw new NotFoundException("payroll run not found");
        return r.rows[0];
      },
      { modules: ["hr"] },
    );
    if (!["draft", "calculated"].includes(run.status)) {
      throw new BadRequestException(
        `run is '${run.status}' — an approved or paid run is frozen; raise a kind=correction run instead`,
      );
    }

    const statutory = await loadStatutoryParams(tenantId, run.period_end);
    const calendar = await loadCalendar(tenantId, null, run.period_start, run.period_end);
    const periodWorkingDays = countWorkingDays(run.period_start, run.period_end, calendar).workingDays;

    const summary = await withTenants(
      [tenantId],
      async (c) => {
        // Rebuild from scratch. The ON DELETE CASCADE on hr_payslip_lines means deleting the
        // payslips takes their lines with them.
        await c.query(`DELETE FROM hr_payslips WHERE run_id = $1`, [id]);
        await c.query(`UPDATE hr_payroll_inputs SET consumed_by_run_id = NULL WHERE consumed_by_run_id = $1`, [id]);

        const employees = await c.query<{
          id: string; user_id: string | null; display_name: string; hire_date: string | null;
          base_amount: string | null; fte: string | null; currency: string | null;
          rate_basis: string | null; pay_frequency: string | null;
          ptkp_status: string | null; ter_category: string | null; has_npwp: boolean | null; tax_resident: boolean | null;
        }>(
          `SELECT e.id, e.user_id, e.display_name, to_char(e.hire_date,'YYYY-MM-DD') AS hire_date,
                  comp.base_amount, comp.fte, comp.currency, comp.rate_basis, comp.pay_frequency,
                  tax.ptkp_status, tax.ter_category, tax.has_npwp, tax.tax_resident
           FROM employees e
           LEFT JOIN LATERAL (
             SELECT base_amount, fte, currency, rate_basis, pay_frequency FROM hr_compensation
              WHERE employee_id = e.id AND effective_from <= $1::date
                AND (effective_to IS NULL OR effective_to >= $1::date)
              ORDER BY effective_from DESC LIMIT 1
           ) comp ON true
           LEFT JOIN LATERAL (
             SELECT ptkp_status, ter_category, has_npwp, tax_resident FROM hr_tax_profiles
              WHERE employee_id = e.id AND effective_from <= $1::date
                AND (effective_to IS NULL OR effective_to >= $1::date)
              ORDER BY effective_from DESC LIMIT 1
           ) tax ON true
           WHERE e.deleted_at IS NULL AND e.employment_status IN ('active','on_leave')
           ORDER BY e.display_name`,
          [run.period_end],
        );

        let totalGross = 0; let totalNet = 0; let totalEmployerCost = 0; let count = 0;
        const skipped: { employeeId: string; name: string; reason: string }[] = [];

        for (const e of employees.rows) {
          // An employee with no compensation row in force is SKIPPED and REPORTED, never defaulted
          // to zero. A zero payslip looks like a computed answer; a skip is visibly a gap.
          if (e.base_amount === null) {
            skipped.push({ employeeId: e.id, name: e.display_name, reason: "no compensation record in force for this period" });
            continue;
          }
          if (e.tax_resident === false) {
            skipped.push({ employeeId: e.id, name: e.display_name, reason: "non-resident (PPh 26) — not implemented; record a manual tax component" });
            continue;
          }

          // ── The quoted rate is converted to what is owed for THIS period ───────────────────────
          // `base_amount` is quoted in `rate_basis`, which is not necessarily the pay period. An
          // annual-quoted employee owed a monthly slip must be paid a TWELFTH.
          const rateBasis = e.rate_basis ?? "monthly";
          const payFrequency = e.pay_frequency ?? "monthly";
          const periodBase = periodBaseAmount(Number(e.base_amount), rateBasis, payFrequency);
          if (periodBase === undefined) {
            skipped.push({
              employeeId: e.id, name: e.display_name,
              reason: `cannot convert a '${rateBasis}' rate to a '${payFrequency}' period — piece rate and unknown bases must be entered as a manual payroll input`,
            });
            continue;
          }
          // ★ The tax engine below runs `mode: "monthly_ter"`, and TER is defined on a MONTHLY
          // gross. A weekly or biweekly slip taxed with a monthly TER rate would understate the
          // bracket and under-withhold — a real liability to DJP, not a rounding difference. So a
          // non-monthly frequency is SKIPPED AND REPORTED rather than approximated. The rest of the
          // model supports weekly pay today; the tax algorithm for it is a separate piece of work,
          // and shipping it as "close enough" would hide that.
          if (payFrequency !== "monthly") {
            skipped.push({
              employeeId: e.id, name: e.display_name,
              reason: `'${payFrequency}' pay frequency: PPh 21 withholding for non-monthly periods is not implemented (the engine is monthly TER only)`,
            });
            continue;
          }
          // THR is legally computed on a MONTHLY wage whatever the pay cadence, so it needs its own
          // conversion rather than reusing `periodBase`.
          const monthlyWage = periodBaseAmount(Number(e.base_amount), rateBasis, "monthly") ?? 0;

          const components: PayComponent[] = [];

          // Standing allowances in force over the period.
          const allowances = await c.query<{
            code: string; label: string; direction: string; calc_kind: string;
            amount: string | null; percent: string | null; taxable: boolean; bpjs_base: boolean; type_id: string;
          }>(
            `SELECT t.code, t.label, t.direction, t.calc_kind, t.taxable, t.bpjs_base, t.id AS type_id,
                    COALESCE(a.amount, t.default_amount) AS amount,
                    COALESCE(a.percent, t.default_percent) AS percent
             FROM hr_employee_allowances a JOIN hr_allowance_types t ON t.id = a.allowance_type_id
             WHERE a.employee_id = $1 AND t.is_active
               AND a.effective_from <= $2::date AND (a.effective_to IS NULL OR a.effective_to >= $2::date)`,
            [e.id, run.period_end],
          );
          for (const a of allowances.rows) {
            const magnitude = a.calc_kind === "percentage" && a.percent !== null
              ? periodBase * (Number(a.percent) / 100)
              : Number(a.amount ?? 0);
            if (!magnitude) continue;
            components.push({
              code: a.code, label: a.label,
              amount: a.direction === "deduction" ? -magnitude : magnitude,
              taxable: a.taxable, bpjsBase: a.bpjs_base,
              category: a.direction === "deduction" ? "other_deduction" : "allowance",
              sourceKind: "allowance", sourceId: a.type_id,
            });
          }

          // Per-period variable inputs (overtime, bonuses, reimbursements) not yet consumed.
          const inputs = await c.query<{ id: string; category: string; code: string | null; label: string; amount: string | null; quantity: string | null; taxable: boolean }>(
            `SELECT id, category, code, label, amount, quantity, taxable FROM hr_payroll_inputs
              WHERE employee_id = $1 AND consumed_by_run_id IS NULL
                AND period_start >= $2::date AND period_end <= $3::date`,
            [e.id, run.period_start, run.period_end],
          );
          for (const i of inputs.rows) {
            // An overtime row carrying only `quantity` (hours) is converted at the statutory-ish
            // hourly rate of monthly/173 — the Indonesian convention. Where the row already carries
            // an explicit amount, that wins: somebody computed it deliberately.
            const amount = i.amount !== null
              ? Number(i.amount)
              : (periodBase / 173) * Number(i.quantity ?? 0);
            const isDeduction = i.category === "deduction" || i.category === "advance";
            components.push({
              code: i.code ?? i.category, label: i.label,
              amount: isDeduction ? -Math.abs(amount) : amount,
              taxable: i.taxable, bpjsBase: false,
              category: (i.category === "overtime" ? "overtime"
                : i.category === "bonus" || i.category === "commission" ? "bonus"
                : i.category === "reimbursement" ? "reimbursement"
                : i.category === "leave_encashment" ? "leave_encashment"
                : i.category === "advance" ? "advance" : "other_deduction") as PayComponent["category"],
              sourceKind: "manual", sourceId: i.id,
            });
          }

          // Active loan installments due in this period — the 0081 seam finally wired. The
          // repayment is a POST-TAX deduction (the engine's step 5), which is why it is categorized
          // as `loan_repayment` rather than folded in as a negative allowance.
          const loans = await c.query<{ loan_id: string; due: string }>(
            `SELECT l.id AS loan_id, SUM(i.total_due)::text AS due
             FROM hr_loan_requests l JOIN hr_loan_installments i ON i.loan_request_id = l.id
             WHERE l.subject_user_id = $1 AND l.status = 'approved' AND l.deleted_at IS NULL
               AND i.due_on BETWEEN $2::date AND $3::date
             GROUP BY l.id`,
            [e.user_id, run.period_start, run.period_end],
          );
          for (const l of loans.rows) {
            components.push({
              code: "loan", label: "Loan repayment", amount: -Number(l.due),
              taxable: false, bpjsBase: false, category: "loan_repayment",
              sourceKind: "loan", sourceId: l.loan_id,
            });
          }

          // THR is its own run kind; when this IS that run, base pay is replaced by the allowance.
          if (run.kind === "thr" && e.hire_date) {
            const months = completedMonths(e.hire_date, run.period_end);
            const thr = computeThr(statutory.params, { monthlyWage, monthsOfService: months });
            if (!thr.eligible) {
              skipped.push({ employeeId: e.id, name: e.display_name, reason: `THR: ${months} months of service is below the eligibility floor` });
              continue;
            }
            components.push({
              code: "thr", label: "THR (religious holiday allowance)", amount: thr.amount,
              taxable: true, bpjsBase: false, category: "thr", sourceKind: "statutory",
            });
          }

          const enrolled = await c.query<{ statutory_code: string }>(
            `SELECT p.statutory_code FROM hr_benefit_enrollments en JOIN hr_benefit_plans p ON p.id = en.plan_id
             WHERE en.employee_id = $1 AND en.status = 'active' AND p.statutory_code IS NOT NULL
               AND en.effective_from <= $2::date AND (en.effective_to IS NULL OR en.effective_to >= $2::date)`,
            [e.id, run.period_end],
          );

          // Unpaid-leave days reduce the paid-day count and therefore prorate base pay.
          const unpaid = await c.query<{ minutes: string | null }>(
            `SELECT SUM(minutes)::text AS minutes FROM hr_leave_requests
              WHERE subject_user_id = $1 AND status = 'approved' AND leave_type = 'unpaid'
                AND deleted_at IS NULL AND starts_on <= $3::date AND ends_on >= $2::date`,
            [e.user_id, run.period_start, run.period_end],
          );
          const unpaidDays = Number(unpaid.rows[0]?.minutes ?? 0) / 480;
          const paidDays = Math.max(0, periodWorkingDays - unpaidDays);

          const result = computePayslip(
            statutory.params,
            {
              employeeId: e.id,
              // A THR run pays the allowance only — no base. Passing the base too would double-pay
              // the month, which is the single most expensive mistake available in this file.
              baseAmount: run.kind === "thr" ? 0 : periodBase,
              fte: Number(e.fte ?? 1),
              workingDays: periodWorkingDays,
              paidDays: run.kind === "thr" ? periodWorkingDays : paidDays,
              components,
              enrolledContributions: enrolled.rows.map((r) => r.statutory_code),
              ptkpStatus: e.ptkp_status ?? "TK/0",
              terCategory: (e.ter_category as "A" | "B" | "C" | null) ?? undefined,
              hasNpwp: e.has_npwp ?? false,
              taxResident: true,
            },
            { mode: "monthly_ter" },
          );

          const payslipId = newId();
          await c.query(
            `INSERT INTO hr_payslips
               (id, tenant_id, run_id, employee_id, subject_user_id, base_amount, fte, working_days, paid_days,
                unpaid_days, ptkp_status, has_npwp, gross, taxable_gross, bpjs_base, employee_deductions,
                tax_withheld, net, employer_cost, currency)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
            [
              payslipId, tenantId, id, e.id, e.user_id, periodBase, Number(e.fte ?? 1),
              periodWorkingDays, run.kind === "thr" ? periodWorkingDays : paidDays, unpaidDays,
              e.ptkp_status ?? "TK/0", e.has_npwp ?? false,
              result.gross, result.taxableGross, result.bpjsBase, result.employeeDeductions,
              result.taxWithheld, result.net, result.employerCost, run.currency,
              // `note` is deliberately NOT written here. It is a human-facing field the employee's
              // own payslip view renders, and stuffing the engine's workings JSON into it would put
              // a wall of `{"proration":{...}}` in front of the person the slip is about. The
              // workings are already persisted where they belong: per-line, in
              // hr_payslip_lines.meta, next to the number each one explains.
            ],
          );
          for (const line of result.lines) {
            await c.query(
              `INSERT INTO hr_payslip_lines (id, tenant_id, payslip_id, side, category, code, label, amount, taxable, bpjs_base, source_kind, source_id, meta, sort_order)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
              [newId(), tenantId, payslipId, line.side, line.category, line.code, line.label, line.amount,
               line.taxable, line.bpjsBase, line.sourceKind ?? null, line.sourceId ?? null,
               JSON.stringify(line.meta ?? {}), line.sortOrder],
            );
          }
          await c.query(
            `UPDATE hr_payroll_inputs SET consumed_by_run_id = $2 WHERE employee_id = $1 AND consumed_by_run_id IS NULL
              AND period_start >= $3::date AND period_end <= $4::date`,
            [e.id, id, run.period_start, run.period_end],
          );

          totalGross += result.gross;
          totalNet += result.net;
          totalEmployerCost += result.employerCost;
          count += 1;
        }

        await c.query(
          `UPDATE hr_payroll_runs
              SET status = 'calculated', parameter_set_id = $2, total_gross = $3, total_net = $4,
                  total_employer_cost = $5, employee_count = $6, calculated_at = now(), updated_at = now()
            WHERE id = $1`,
          [id, statutory.setId, totalGross.toFixed(2), totalNet.toFixed(2), totalEmployerCost.toFixed(2), count],
        );
        await emitEvent(c, tenantId, "hr_payroll_run", id, "hr.payroll_run.calculated", { employeeCount: count, totalNet });
        return { totalGross, totalNet, totalEmployerCost, employeeCount: count, skipped };
      },
      { modules: ["hr"] },
    );

    await writeActivity(tenantId, req.principal.userId, "calculated", "hr_payroll_run", id, {
      employeeCount: summary.employeeCount, skipped: summary.skipped.length,
    });
    return {
      id, status: "calculated", ...summary,
      parameterSetId: statutory.setId,
      // Surfaced on EVERY calculate, not buried: the caller needs to know the numbers are unratified
      // before they look at the totals, not after they have approved them.
      statutoryRatified: statutory.ratified,
      statutoryWarning: statutory.ratified
        ? null
        : statutory.setId
          ? "the statutory parameter set in force for this period is NOT ratified — approving will require an explicit override"
          : "no statutory parameter set covers this period; the engine used its built-in UNRATIFIED fixture. Configure and ratify a set before approving.",
    };
  }

  @Get("payroll-runs/:id")
  async getRun(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "hr_payroll", id, tenantId, module: "hr" }, "read");
    const out = await withTenants(
      [tenantId],
      async (c) => {
        const run = await c.query(
          `SELECT r.id, r.reference, r.kind, r.period_start AS "periodStart", r.period_end AS "periodEnd",
                  r.pay_date AS "payDate", r.currency, r.status, r.parameter_set_id AS "parameterSetId",
                  r.unratified_override_by AS "unratifiedOverrideBy", r.unratified_override_at AS "unratifiedOverrideAt",
                  r.unratified_override_reason AS "unratifiedOverrideReason",
                  r.total_gross AS "totalGross", r.total_net AS "totalNet",
                  r.total_employer_cost AS "totalEmployerCost", r.employee_count AS "employeeCount",
                  r.calculated_at AS "calculatedAt", r.approved_at AS "approvedAt", r.paid_at AS "paidAt",
                  s.ratified_at AS "parameterSetRatifiedAt", s.name AS "parameterSetName"
           FROM hr_payroll_runs r
           LEFT JOIN hr_statutory_parameter_sets s ON s.id = r.parameter_set_id
           WHERE r.id = $1 AND r.deleted_at IS NULL`,
          [id],
        );
        if (!run.rows[0]) throw new NotFoundException("payroll run not found");
        const payslips = await c.query(
          `SELECT p.id, p.employee_id AS "employeeId", e.display_name AS "employeeName",
                  p.gross, p.taxable_gross AS "taxableGross", p.employee_deductions AS "employeeDeductions",
                  p.tax_withheld AS "taxWithheld", p.net, p.employer_cost AS "employerCost",
                  p.status, p.published_at AS "publishedAt"
           FROM hr_payslips p JOIN employees e ON e.id = p.employee_id
           WHERE p.run_id = $1 ORDER BY e.display_name`,
          [id],
        );
        return { ...run.rows[0], payslips: payslips.rows };
      },
      { modules: ["hr"] },
    );
    return out;
  }

  /**
   * APPROVE a run — the D4 high-assurance action that commits money.
   *
   * THE STATUTORY GATE LIVES HERE. Against an unratified (or absent) parameter set the call is
   * REFUSED unless `overrideUnratified` is passed with a reason, and the override is then recorded
   * on the run permanently. The point is not to make approval hard; it is that "we paid people using
   * numbers nobody had signed off" should be a fact in the database rather than something to be
   * reconstructed later.
   */
  @Post("payroll-runs/:id/approve")
  @HttpCode(200)
  async approveRun(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { overrideUnratified?: boolean; overrideReason?: string },
  ) {
    await authorize(req.principal, { kind: "hr_payroll", id, tenantId, module: "hr" }, "approve");
    const out = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query<{ status: string; reference: string; parameter_set_id: string | null; total_net: string | null; employee_count: number | null; ratified_at: string | null }>(
          `SELECT r.status, r.reference, r.parameter_set_id, r.total_net, r.employee_count, s.ratified_at
           FROM hr_payroll_runs r LEFT JOIN hr_statutory_parameter_sets s ON s.id = r.parameter_set_id
           WHERE r.id = $1 AND r.deleted_at IS NULL`,
          [id],
        );
        const run = r.rows[0];
        if (!run) throw new NotFoundException("payroll run not found");
        if (run.status !== "calculated" && run.status !== "pending_approval") {
          throw new BadRequestException(`run is '${run.status}' — only a calculated run can be approved`);
        }

        const ratified = !!run.ratified_at && !!run.parameter_set_id;
        if (!ratified && !body?.overrideUnratified) {
          throw new BadRequestException(
            run.parameter_set_id
              ? "the statutory parameter set this run used is NOT ratified. Ratify it (POST /statutory-parameters/:id/ratify), " +
                "or re-send with overrideUnratified=true and an overrideReason — the override is recorded permanently."
              : "this run was calculated with NO configured statutory parameter set (the built-in UNRATIFIED fixture). " +
                "Configure and ratify a set, then recalculate — or re-send with overrideUnratified=true and an overrideReason.",
          );
        }
        if (!ratified && !body?.overrideReason) {
          throw new BadRequestException("overrideReason is required when overriding an unratified parameter set");
        }

        await c.query(
          `UPDATE hr_payroll_runs
              SET status = 'approved', approved_by = $2, approved_at = now(),
                  unratified_override_by = CASE WHEN $3 THEN $2 ELSE unratified_override_by END,
                  unratified_override_at = CASE WHEN $3 THEN now() ELSE unratified_override_at END,
                  unratified_override_reason = CASE WHEN $3 THEN $4 ELSE unratified_override_reason END,
                  updated_at = now()
            WHERE id = $1`,
          [id, req.principal.userId, !ratified, body?.overrideReason ?? null],
        );
        // Payslips become `final` with the run. Note they are NOT published here — publishing is a
        // separate act, because a run can be approved days before anyone should see their slip.
        await c.query(`UPDATE hr_payslips SET status = 'final', updated_at = now() WHERE run_id = $1`, [id]);
        await emitEvent(c, tenantId, "hr_payroll_run", id, "hr.payroll_run.approved", {
          reference: run.reference, overrodeUnratified: !ratified,
        });
        return { reference: run.reference, totalNet: run.total_net, employeeCount: run.employee_count, overrodeUnratified: !ratified };
      },
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "approved", "hr_payroll_run", id, out);
    return { ok: true, status: "approved", ...out };
  }

  /** Publish the run's payslips to their subjects. Separate from approval — see approveRun. */
  @Post("payroll-runs/:id/publish")
  @HttpCode(200)
  async publishRun(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "hr_payroll", id, tenantId, module: "hr" }, "approve");
    const subjects = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query<{ status: string }>(`SELECT status FROM hr_payroll_runs WHERE id = $1 AND deleted_at IS NULL`, [id]);
        if (!r.rows[0]) throw new NotFoundException("payroll run not found");
        if (!["approved", "paid"].includes(r.rows[0].status)) {
          throw new BadRequestException(`run is '${r.rows[0].status}' — only an approved run's payslips may be published`);
        }
        const res = await c.query<{ subject_user_id: string | null }>(
          `UPDATE hr_payslips SET published_at = COALESCE(published_at, now()), updated_at = now()
            WHERE run_id = $1 AND status IN ('final','paid')
            RETURNING subject_user_id`,
          [id],
        );
        return res.rows.map((x) => x.subject_user_id).filter((x): x is string => !!x);
      },
      { modules: ["hr"] },
    );
    if (subjects.length) {
      await notifyBestEffort(tenantId, req.principal.userId, subjects, "hr.payslip.published", {
        title: "Your payslip is available",
        href: "/me/pay",
        entityType: "hr_payroll_run",
        entityId: id,
      });
    }
    return { ok: true, published: subjects.length };
  }

  @Post("payroll-runs/:id/paid")
  @HttpCode(200)
  async markPaid(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "hr_payroll", id, tenantId, module: "hr" }, "approve");
    const res = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query(
          `UPDATE hr_payroll_runs SET status = 'paid', paid_at = now(), updated_at = now()
            WHERE id = $1 AND status = 'approved' AND deleted_at IS NULL RETURNING reference`,
          [id],
        );
        if (!r.rows[0]) throw new BadRequestException("run not found, or not in the approved state");
        await c.query(`UPDATE hr_payslips SET status = 'paid', updated_at = now() WHERE run_id = $1`, [id]);
        await emitEvent(c, tenantId, "hr_payroll_run", id, "hr.payroll_run.paid", {});
        return r.rows[0];
      },
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "paid", "hr_payroll_run", id, res);
    return { ok: true, status: "paid" };
  }

  // ════════════════════════════════════════════════════════════════ PAYSLIPS ══════════════════
  /**
   * List payslips. Staff see the tenant's; a subject sees ONLY their own PUBLISHED ones — both the
   * `subject_user_id` and the `published_at IS NOT NULL` narrowing are applied in SQL, mirroring the
   * two gates the policy's member arm requires. A mismatch between those two would be the classic
   * "authorized for one thing, queried for another" defect.
   */
  @Get("payslips")
  async listPayslips(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("runId") runId?: string, @Query("employeeId") employeeId?: string,
  ) {
    const { selfOnly } = await payrollStaffOrSelf(req.principal, tenantId);
    const params: unknown[] = [];
    const clauses = ["1=1"];
    if (selfOnly) {
      params.push(req.principal.userId);
      clauses.push(`p.subject_user_id = $${params.length}`, "p.published_at IS NOT NULL");
    } else {
      if (runId) { params.push(runId); clauses.push(`p.run_id = $${params.length}`); }
      if (employeeId) { params.push(employeeId); clauses.push(`p.employee_id = $${params.length}`); }
    }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT p.id, p.run_id AS "runId", r.reference AS "runReference", r.kind AS "runKind",
                r.period_start AS "periodStart", r.period_end AS "periodEnd", r.pay_date AS "payDate",
                p.employee_id AS "employeeId", p.gross, p.tax_withheld AS "taxWithheld", p.net,
                p.currency, p.status, p.published_at AS "publishedAt"
         FROM hr_payslips p JOIN hr_payroll_runs r ON r.id = p.run_id
         WHERE ${clauses.join(" AND ")} ORDER BY r.period_end DESC LIMIT 200`,
        params,
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  @Get("payslips/:id")
  async getPayslip(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    // One fetched row carries its own subject and publication state, so a single authorize covers
    // both the staff rule (which ignores them) and the member arm (which requires both).
    const row = await withTenants(
      [tenantId],
      (c) => c.query<{ subject_user_id: string | null; published_at: string | null }>(
        `SELECT subject_user_id, published_at FROM hr_payslips WHERE id = $1`, [id],
      ),
      { modules: ["hr"] },
    );
    if (!row.rows[0]) throw new NotFoundException("payslip not found");
    await authorize(
      req.principal,
      {
        kind: "hr_payroll", id, tenantId, module: "hr",
        subjectUserId: row.rows[0].subject_user_id ?? undefined,
        published: !!row.rows[0].published_at,
      },
      "read",
    );
    const out = await withTenants(
      [tenantId],
      async (c) => {
        const slip = await c.query(
          `SELECT p.id, p.run_id AS "runId", r.reference AS "runReference", r.kind AS "runKind",
                  r.period_start AS "periodStart", r.period_end AS "periodEnd", r.pay_date AS "payDate",
                  p.employee_id AS "employeeId", e.display_name AS "employeeName",
                  p.base_amount AS "baseAmount", p.fte, p.working_days AS "workingDays", p.paid_days AS "paidDays",
                  p.unpaid_days AS "unpaidDays", p.ptkp_status AS "ptkpStatus", p.has_npwp AS "hasNpwp",
                  p.gross, p.taxable_gross AS "taxableGross", p.bpjs_base AS "bpjsBase",
                  p.employee_deductions AS "employeeDeductions", p.tax_withheld AS "taxWithheld",
                  p.net, p.employer_cost AS "employerCost", p.currency, p.status, p.published_at AS "publishedAt"
           FROM hr_payslips p JOIN hr_payroll_runs r ON r.id = p.run_id JOIN employees e ON e.id = p.employee_id
           WHERE p.id = $1`,
          [id],
        );
        const lines = await c.query(
          `SELECT side, category, code, label, amount, taxable, bpjs_base AS "bpjsBase", meta, sort_order AS "sortOrder"
           FROM hr_payslip_lines WHERE payslip_id = $1 ORDER BY side, sort_order`,
          [id],
        );
        return { ...slip.rows[0], lines: lines.rows };
      },
      { modules: ["hr"] },
    );
    return out;
  }

  @Post("payroll-inputs")
  @HttpCode(201)
  async addPayrollInput(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { employeeId?: string; periodStart?: string; periodEnd?: string; category?: string; code?: string; label?: string; quantity?: number; amount?: number; taxable?: boolean; note?: string },
  ) {
    if (!body?.employeeId || !body?.label || !body?.category) {
      throw new BadRequestException("employeeId, category and label required");
    }
    if (body?.quantity === undefined && body?.amount === undefined) {
      throw new BadRequestException("one of quantity or amount required");
    }
    const periodStart = requireIsoDate(body?.periodStart, "periodStart");
    const periodEnd = requireIsoDate(body?.periodEnd, "periodEnd");
    await authorize(req.principal, { kind: "hr_payroll", tenantId, module: "hr" }, "create");
    const id = newId();
    await withTenants(
      [tenantId],
      (c) => c.query(
        `INSERT INTO hr_payroll_inputs (id, tenant_id, employee_id, period_start, period_end, category, code, label, quantity, amount, taxable, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id, tenantId, body.employeeId, periodStart, periodEnd, body.category, body?.code ?? null,
         body.label, body?.quantity ?? null, body?.amount ?? null, body?.taxable !== false,
         body?.note ?? null, req.principal.userId],
      ),
      { modules: ["hr"] },
    );
    return { id };
  }

  // ═══════════════════════════════════════════════════════════ SEPARATIONS ════════════════════
  /**
   * Draft a separation, computing the three statutory components.
   *
   * `service_years` is derived from `hr_job_events` (the earliest hire/rehire), NOT from
   * `employees.hire_date` — a rehired employee's service is not one contiguous span, and using the
   * employee row's single date would over-pay them. Falls back to `employees.hire_date` only when
   * there is no job history at all, which is the pre-wave-A case.
   */
  @Post("separations")
  @HttpCode(201)
  async createSeparation(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { employeeId?: string; ground?: string; initiatedBy?: string; effectiveOn?: string; lastWorkingDay?: string; noticeGivenOn?: string; noticeDays?: number; otherEntitlements?: number; note?: string },
  ) {
    if (!body?.employeeId) throw new BadRequestException("employeeId required");
    if (!body?.ground || !SEPARATION_GROUNDS.has(body.ground)) {
      throw new BadRequestException(`ground must be one of: ${[...SEPARATION_GROUNDS].join("|")}`);
    }
    const effectiveOn = requireIsoDate(body?.effectiveOn, "effectiveOn");
    await authorize(req.principal, { kind: "hr_payroll", tenantId, module: "hr" }, "create");

    const statutory = await loadStatutoryParams(tenantId, effectiveOn);
    const id = newId();
    const out = await withTenants(
      [tenantId],
      async (c) => {
        const emp = await c.query<{ user_id: string | null; display_name: string; hire_date: string | null }>(
          `SELECT user_id, display_name, to_char(hire_date,'YYYY-MM-DD') AS hire_date
           FROM employees WHERE id = $1 AND deleted_at IS NULL`,
          [body.employeeId],
        );
        if (!emp.rows[0]) throw new NotFoundException("employee not found");

        const continuous = await c.query<{ from: string }>(
          `SELECT to_char(MIN(effective_on),'YYYY-MM-DD') AS from FROM hr_job_events
            WHERE employee_id = $1 AND event_type IN ('hire','rehire')`,
          [body.employeeId],
        );
        const hireDate = continuous.rows[0]?.from ?? emp.rows[0].hire_date;
        if (!hireDate) throw new BadRequestException("cannot compute service: the employee has no hire date and no hire job event");

        const comp = await c.query<{ base_amount: string }>(
          `SELECT base_amount FROM hr_compensation
            WHERE employee_id = $1 AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)
            ORDER BY effective_from DESC LIMIT 1`,
          [body.employeeId, effectiveOn],
        );
        if (!comp.rows[0]) throw new BadRequestException("cannot compute severance: no compensation record in force on the effective date");

        // Unused leave, encashed as part of uang penggantian hak.
        const bal = await c.query<{ remaining: string | null }>(
          `SELECT SUM(allocated_minutes - used_minutes)::text AS remaining FROM hr_leave_balances
            WHERE subject_user_id = $1 AND year = EXTRACT(YEAR FROM $2::date)::int AND leave_type = 'vacation'`,
          [emp.rows[0].user_id, effectiveOn],
        );

        const computed = computeSeverance(statutory.severance, {
          monthlyWage: Number(comp.rows[0].base_amount),
          hireDate,
          effectiveOn,
          ground: body.ground!,
          unusedLeaveMinutes: Math.max(0, Number(bal.rows[0]?.remaining ?? 0)),
          otherEntitlements: body?.otherEntitlements ?? 0,
        });

        await c.query(
          `INSERT INTO hr_separations
             (id, tenant_id, employee_id, subject_user_id, ground, initiated_by, notice_given_on, notice_days,
              last_working_day, effective_on, service_years, severance_amount, service_reward_amount,
              entitlement_compensation_amount, other_amount, total_amount, parameter_set_id, note, created_by, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
          [
            id, tenantId, body.employeeId, emp.rows[0].user_id, body.ground, body?.initiatedBy ?? "employee",
            body?.noticeGivenOn ?? null, body?.noticeDays ?? null, body?.lastWorkingDay ?? null, effectiveOn,
            computed.serviceYears, computed.severanceAmount, computed.serviceRewardAmount,
            computed.entitlementCompensationAmount, body?.otherEntitlements ?? 0, computed.totalAmount,
            statutory.setId, body?.note ?? null, req.principal.userId, config.originSite,
          ],
        );
        await emitEvent(c, tenantId, "hr_separation", id, "hr.separation.drafted", {
          employeeId: body.employeeId, ground: body.ground, effectiveOn, total: computed.totalAmount,
        });
        return { employeeName: emp.rows[0].display_name, hireDate, ...computed };
      },
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "created", "hr_separation", id, { ground: body.ground, effectiveOn });
    return {
      id, status: "draft", ...out,
      statutoryRatified: statutory.ratified,
      statutoryWarning: statutory.ratified ? null
        : "the severance multipliers used are NOT ratified — verify them before approving this separation",
    };
  }

  /**
   * Approve a separation: routes through the SAME unified approvals surface leave (0028), loans
   * (0081) and requisitions use, then applies the terminating job event.
   *
   * The job event is written here rather than left to the approval handler because a separation
   * that is approved but never recorded in the history would make every later tenure and turnover
   * figure wrong, silently.
   */
  @Post("separations/:id/approve")
  @HttpCode(200)
  async approveSeparation(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "hr_payroll", id, tenantId, module: "hr" }, "approve");
    const out = await withTenants(
      [tenantId],
      async (c) => {
        const s = await c.query<{
          status: string; employee_id: string; subject_user_id: string | null;
          ground: string; effective_on: string; total_amount: string | null;
        }>(
          `SELECT status, employee_id, subject_user_id, ground, to_char(effective_on,'YYYY-MM-DD') AS effective_on, total_amount
           FROM hr_separations WHERE id = $1 AND deleted_at IS NULL`,
          [id],
        );
        const sep = s.rows[0];
        if (!sep) throw new NotFoundException("separation not found");
        if (sep.status === "approved" || sep.status === "completed") throw new ConflictException("separation is already approved");
        if (sep.status === "cancelled") throw new BadRequestException("separation is cancelled");

        await c.query(
          `UPDATE hr_separations SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1`,
          [id, req.principal.userId],
        );
        await c.query(
          `INSERT INTO hr_job_events (id, tenant_id, employee_id, subject_user_id, effective_on, event_type, previous, current, reason, source_kind, source_id, created_by, origin_site)
           VALUES ($1,$2,$3,$4,$5,'termination',$6,$7,$8,'manual',$9,$10,$11)`,
          [
            newId(), tenantId, sep.employee_id, sep.subject_user_id, sep.effective_on,
            JSON.stringify({ employmentStatus: "active" }),
            JSON.stringify({ employmentStatus: "terminated", ground: sep.ground, settlement: sep.total_amount }),
            sep.ground, id, req.principal.userId, config.originSite,
          ],
        );
        // `employees` is the materialized HEAD of the job-event log, so it moves with the event.
        await c.query(
          `UPDATE employees SET employment_status = 'terminated', terminated_at = $2::date, updated_at = now() WHERE id = $1`,
          [sep.employee_id, sep.effective_on],
        );
        await emitEvent(c, tenantId, "hr_separation", id, "hr.separation.approved", {
          employeeId: sep.employee_id, ground: sep.ground, effectiveOn: sep.effective_on,
        });
        return { employeeId: sep.employee_id, effectiveOn: sep.effective_on, total: sep.total_amount };
      },
      { modules: ["hr"] },
    );
    const deciders = await resolveAutomationApprovalDeciders(tenantId, "hr");
    await notifyBestEffort(tenantId, req.principal.userId, deciders, "hr.separation.approved", {
      title: "A separation was approved",
      href: `/hr/separations/${id}`,
      entityType: "hr_separation",
      entityId: id,
    });
    await writeActivity(tenantId, req.principal.userId, "approved", "hr_separation", id, out);
    return { ok: true, status: "approved", ...out };
  }

  @Get("separations")
  async listSeparations(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "hr_payroll", tenantId, module: "hr" }, "read");
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT s.id, s.employee_id AS "employeeId", e.display_name AS "employeeName", s.ground,
                s.initiated_by AS "initiatedBy", s.effective_on AS "effectiveOn",
                s.last_working_day AS "lastWorkingDay", s.service_years AS "serviceYears",
                s.severance_amount AS "severanceAmount", s.service_reward_amount AS "serviceRewardAmount",
                s.entitlement_compensation_amount AS "entitlementCompensationAmount",
                s.total_amount AS "totalAmount", s.currency, s.status, s.approved_at AS "approvedAt"
         FROM hr_separations s JOIN employees e ON e.id = s.employee_id
         WHERE s.deleted_at IS NULL ORDER BY s.effective_on DESC LIMIT 300`,
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  /**
   * Preview a severance computation WITHOUT persisting anything.
   *
   * Exists because the alternative is drafting a separation to find out what it costs, and a draft
   * separation for an employee who has not been told is a row somebody will see. A preview leaves
   * no trace.
   */
  @Get("separations/preview")
  async previewSeverance(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("employeeId") employeeId?: string, @Query("ground") ground?: string, @Query("effectiveOn") effectiveOn?: string,
  ) {
    if (!employeeId || !ground) throw new BadRequestException("employeeId and ground required");
    if (!SEPARATION_GROUNDS.has(ground)) throw new BadRequestException("unknown ground");
    const on = requireIsoDate(effectiveOn, "effectiveOn");
    await authorize(req.principal, { kind: "hr_payroll", tenantId, module: "hr" }, "read");
    const statutory = await loadStatutoryParams(tenantId, on);
    const facts = await withTenants(
      [tenantId],
      async (c) => {
        const emp = await c.query<{ hire_date: string | null }>(
          `SELECT to_char(hire_date,'YYYY-MM-DD') AS hire_date FROM employees WHERE id = $1 AND deleted_at IS NULL`, [employeeId],
        );
        if (!emp.rows[0]) throw new NotFoundException("employee not found");
        const continuous = await c.query<{ from: string | null }>(
          `SELECT to_char(MIN(effective_on),'YYYY-MM-DD') AS from FROM hr_job_events
            WHERE employee_id = $1 AND event_type IN ('hire','rehire')`,
          [employeeId],
        );
        const comp = await c.query<{ base_amount: string }>(
          `SELECT base_amount FROM hr_compensation
            WHERE employee_id = $1 AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)
            ORDER BY effective_from DESC LIMIT 1`,
          [employeeId, on],
        );
        return { hireDate: continuous.rows[0]?.from ?? emp.rows[0].hire_date, baseAmount: comp.rows[0]?.base_amount ?? null };
      },
      { modules: ["hr"] },
    );
    if (!facts.hireDate) throw new BadRequestException("employee has no hire date");
    if (facts.baseAmount === null) throw new BadRequestException("no compensation record in force on that date");
    const computed = computeSeverance(statutory.severance, {
      monthlyWage: Number(facts.baseAmount), hireDate: facts.hireDate, effectiveOn: on, ground,
    });
    return {
      ...computed,
      serviceYearsCheck: serviceYears(facts.hireDate, on),
      statutoryRatified: statutory.ratified,
      statutoryWarning: statutory.ratified ? null : "multipliers are NOT ratified — this is an estimate, not an offer",
    };
  }
}
