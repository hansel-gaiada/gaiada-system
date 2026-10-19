// DW-10f-4a — freelancers and their bills (docs/FRONTEND-BFF-CONTRACT.md §61.7, §61.8; PERMISSION-CONTRACT §51). The money
// and the claim are freelancer-bills.service.ts; the vendor link (`PATCH finance/ap/vendors/:vendorId/person`, `POST
// finance/ap/vendors` with `userId`) lives with the other vendor routes in finance.controller.ts.
//
//   GET    /api/:t/finance/freelancers                          finance_ap read          every person with a rate or a linked vendor
//   POST   /api/:t/finance/freelancers/:userId/rates            finance_ap vendor_master a rate (closes the open one the day before)
//   PATCH  /api/:t/finance/freelancers/:userId/rates/:rateId    finance_ap vendor_master end it, reopen it, or its note
//   DELETE /api/:t/finance/freelancers/:userId/rates/:rateId    finance_ap vendor_master withdraw a rate that priced nothing billed
//   GET    /api/:t/finance/freelancer-bills/preview             finance_ap read          what drafting a period would make
//   POST   /api/:t/finance/freelancer-bills                     finance_ap bill_entry    draft one person's bill (a replay dedupes)
//   GET    /api/:t/finance/freelancer-bills                     finance_ap read          the freelancer bills, with derived warnings
//   DELETE /api/:t/finance/freelancer-bills/:billId             finance_ap bill_entry    discard a draft, releasing its hours
// Approval is the existing `POST finance/ap/bills/:billId/approve` (finance_ap approve), unchanged.
//
// ── THE ORDER ON EVERY ROUTE ─────────────────────────────────────────────────────────────────────────────────────────
// Cerbos first, then the shape of the request (400), then the rows (404, 409). A denied caller never learns whether its
// body was valid. Rates and links are `vendor_master` (high assurance: money terms and payees are a person's act at a
// fresh second factor); drafting and discarding are `bill_entry`, so the duty split with `approve` holds.
//
// ── THE WALLS ────────────────────────────────────────────────────────────────────────────────────────────────────────
// ModuleEnabledGuard("finance"); Cerbos; every query through `withFreelancerScope` (the finance AND hr scopes, §61.12); and
// the database's own refusals (the EXCLUDE on rates, PD615 to PD617 on the claim), mapped by `mapFreelancerDbError`.
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { AuthGuard } from "../../auth/guards";
import { authorize, writeActivity } from "../../core/http";
import type { Principal } from "../../rbac/principal";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import {
  MAX_NOTE, RATE_USED_SQL, UUID_RE, activeHuman, bad, billablePerson, buildPlan, claimedAfter, conflict, draftBill,
  functionalCurrency, isIsoDate, mapFreelancerDbError, noWithholdingWarning, notFound, parsePositiveAmount, payrollOverlap,
  periodProblem, planView, postableAccountId, withFreelancerScope,
} from "./freelancer-bills.service";

type FinanceApAction = "read" | "vendor_master" | "bill_entry";
const gate = (p: Principal, tenantId: string, action: FinanceApAction) =>
  authorize(p, { kind: "finance_ap", tenantId, module: "finance" }, action);

const RATE_COLUMNS = `r.id, r.user_id AS "userId", r.hourly_rate::float8 AS "hourlyRate", r.currency_code AS currency,
  r.expense_account_code AS "expenseAccountCode", to_char(r.valid_from, 'YYYY-MM-DD') AS "validFrom",
  to_char(r.valid_to, 'YYYY-MM-DD') AS "validTo", r.note, ${RATE_USED_SQL("r")} AS used`;

interface RateView {
  id: string; userId: string; hourlyRate: number; currency: string; expenseAccountCode: string;
  validFrom: string; validTo: string | null; note: string | null; used: boolean;
}

async function readRate(c: PoolClient, tenantId: string, rateId: string): Promise<RateView> {
  const r = await c.query<RateView>(`SELECT ${RATE_COLUMNS} FROM finance_freelancer_rates r WHERE r.tenant_id = $1 AND r.id = $2`, [tenantId, rateId]);
  return r.rows[0];
}

/** A note: absent, null (clear) or at most 500 characters. Returns the value to store, or undefined for "unchanged". */
function noteOf(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string" || v.length > MAX_NOTE) throw bad("note_invalid", `note is text of at most ${MAX_NOTE} characters`);
  return v.trim() || null;
}

/** Runs a scoped transaction and maps the database's walls to their §61 answers. */
async function scoped<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  try {
    return await withFreelancerScope(tenantId, fn);
  } catch (e) {
    return mapFreelancerDbError(e);
  }
}

const today = (c: PoolClient) => c.query<{ d: string }>(`SELECT to_char(current_date, 'YYYY-MM-DD') AS d`).then((r) => r.rows[0].d);

@Controller("api")
@UseGuards(AuthGuard, ModuleEnabledGuard("finance"))
export class FreelancerBillsController {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // §61.7 Freelancers and their rates
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  @Get(":tenantId/finance/freelancers")
  async listFreelancers(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await gate(req.principal, tenantId, "read");
    return scoped(tenantId, async (c) => {
      const people = await c.query<{
        id: string; name: string; email: string; vendorId: string | null; vendorCode: string | null; vendorName: string | null;
        withholdingCode: string | null; onPayroll: boolean;
      }>(
        `WITH people AS (
           SELECT user_id FROM finance_freelancer_rates WHERE tenant_id = $1
           UNION
           SELECT user_id FROM finance_ap_vendors WHERE tenant_id = $1 AND user_id IS NOT NULL AND deleted_at IS NULL
         )
         SELECT u.id, u.name, u.email, v.id AS "vendorId", v.code AS "vendorCode", v.name AS "vendorName",
                NULLIF(btrim(v.default_withholding_code), '') AS "withholdingCode",
                EXISTS (SELECT 1 FROM hr_compensation hc JOIN employees em ON em.id = hc.employee_id AND em.tenant_id = hc.tenant_id
                         WHERE hc.tenant_id = $1 AND (em.user_id = u.id OR hc.subject_user_id = u.id)
                           AND current_date >= hc.effective_from AND (hc.effective_to IS NULL OR current_date <= hc.effective_to)) AS "onPayroll"
           FROM people pp JOIN users u ON u.id = pp.user_id
           LEFT JOIN finance_ap_vendors v ON v.tenant_id = $1 AND v.user_id = u.id AND v.deleted_at IS NULL
          ORDER BY u.name, u.id`,
        [tenantId],
      );
      const rates = await c.query<RateView & { current: boolean }>(
        `SELECT ${RATE_COLUMNS}, (current_date >= r.valid_from AND (r.valid_to IS NULL OR current_date <= r.valid_to)) AS current
           FROM finance_freelancer_rates r WHERE r.tenant_id = $1 ORDER BY r.valid_from DESC`,
        [tenantId],
      );
      return people.rows.map((p) => {
        const mine = rates.rows.filter((r) => r.userId === p.id);
        const strip = ({ current: _current, ...r }: RateView & { current: boolean }) => r;
        const cur = mine.find((r) => r.current);
        return {
          user: { id: p.id, name: p.name, email: p.email },
          vendor: p.vendorId ? { id: p.vendorId, code: p.vendorCode, name: p.vendorName, withholdingCode: p.withholdingCode } : null,
          currentRate: cur ? strip(cur) : null,
          rates: mine.map(strip),
          onPayroll: p.onPayroll,
        };
      });
    });
  }

  @Post(":tenantId/finance/freelancers/:userId/rates")
  @HttpCode(201)
  async addRate(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Body() body: { hourlyRate?: unknown; validFrom?: unknown; expenseAccountCode?: unknown; currency?: unknown; note?: unknown },
  ) {
    await gate(req.principal, tenantId, "vendor_master");
    const validFrom = body?.validFrom;
    if (!isIsoDate(validFrom)) throw bad("date_invalid", "validFrom must be a date (YYYY-MM-DD)", { field: "validFrom" });
    if (parsePositiveAmount(body?.hourlyRate, 4) === null) {
      throw bad("rate_invalid", "hourlyRate must be a positive amount", { field: "hourlyRate" });
    }
    const accountCode = typeof body?.expenseAccountCode === "string" ? body.expenseAccountCode.trim() : "";
    if (!accountCode) throw bad("expense_account_invalid", "expenseAccountCode is required", { field: "expenseAccountCode" });
    if (body?.currency !== undefined && typeof body.currency !== "string") throw bad("currency_not_functional", "currency must be a currency code");
    const note = noteOf(body?.note) ?? null;

    const out = await scoped(tenantId, async (c) => {
      const person = await activeHuman(c, tenantId, userId);
      if (!person) throw notFound("person_not_found", "no person with an active membership in this company has that id");
      const fc = await functionalCurrency(c, tenantId);
      const currency = typeof body.currency === "string" ? body.currency.trim().toUpperCase() : fc?.code;
      if (!fc || currency !== fc.code) {
        throw bad("currency_not_functional", fc
          ? `a rate is in the functional currency ${fc.code} (the ledger books at rate 1)`
          : "the company has no functional currency (Finance › Settings)");
      }
      const rate = parsePositiveAmount(body.hourlyRate, fc.minorUnit);
      if (rate === null) throw bad("rate_invalid", `hourlyRate must be positive with at most ${fc.minorUnit} decimals in ${fc.code}`, { field: "hourlyRate" });
      if (!(await postableAccountId(c, tenantId, accountCode))) {
        throw bad("expense_account_invalid", `account ${accountCode} is not a live, active, postable, non-control account`, { field: "expenseAccountCode" });
      }
      const payroll = await payrollOverlap(c, tenantId, userId, validFrom, null);
      if (payroll) {
        throw conflict("freelancer_on_payroll", `${person.name} has a compensation in force on ${payroll}: payroll would pay them twice`);
      }
      // The open rate that started before validFrom ends the day before, in this transaction (§61.7).
      const open = await c.query<{ id: string; valid_from: string }>(
        `SELECT id, to_char(valid_from, 'YYYY-MM-DD') AS valid_from FROM finance_freelancer_rates
          WHERE tenant_id = $1 AND user_id = $2 AND valid_to IS NULL AND valid_from < $3::date FOR UPDATE`,
        [tenantId, userId, validFrom],
      );
      let closed: { id: string; validTo: string } | null = null;
      if (open.rows[0]) {
        const dayBefore = (await c.query<{ d: string }>(`SELECT to_char($1::date - 1, 'YYYY-MM-DD') AS d`, [validFrom])).rows[0].d;
        if (await claimedAfter(c, tenantId, userId, open.rows[0].valid_from, null, dayBefore)) {
          throw conflict("rate_used", `the open rate priced hours already billed on or after ${validFrom}; a new rate cannot start before them`);
        }
        await c.query(`UPDATE finance_freelancer_rates SET valid_to = $2::date, updated_at = now() WHERE id = $1`, [open.rows[0].id, dayBefore]);
        closed = { id: open.rows[0].id, validTo: dayBefore };
      }
      const ins = await c.query<{ id: string }>(
        `INSERT INTO finance_freelancer_rates
           (tenant_id, user_id, hourly_rate, currency_code, expense_account_code, valid_from, note, created_by)
         VALUES ($1, $2, $3::numeric, $4, $5, $6::date, $7, $8) RETURNING id`,
        [tenantId, userId, rate, fc.code, accountCode, validFrom, note, req.principal.userId],
      );
      const vendor = await c.query<{ id: string }>(
        `SELECT id FROM finance_ap_vendors WHERE tenant_id = $1 AND user_id = $2 AND deleted_at IS NULL LIMIT 1`, [tenantId, userId]);
      return { rate: await readRate(c, tenantId, ins.rows[0].id), closed, vendorId: vendor.rows[0]?.id ?? null };
    });

    if (out.closed) {
      await writeActivity(tenantId, req.principal.userId, "freelancer_rate_ended", "finance_freelancer_rate", out.closed.id, {
        userId, vendorId: out.vendorId, validTo: out.closed.validTo, reason: "superseded",
      });
    }
    await writeActivity(tenantId, req.principal.userId, "freelancer_rate_added", "finance_freelancer_rate", out.rate.id, {
      userId, vendorId: out.vendorId, hourlyRate: out.rate.hourlyRate, currency: out.rate.currency, validFrom: out.rate.validFrom,
    });
    return { ...out.rate, closedRate: out.closed };
  }

  @Patch(":tenantId/finance/freelancers/:userId/rates/:rateId")
  async editRate(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("rateId") rateId: string,
    @Body() body: { validTo?: unknown; note?: unknown },
  ) {
    await gate(req.principal, tenantId, "vendor_master");
    const hasValidTo = body != null && Object.prototype.hasOwnProperty.call(body, "validTo");
    const validTo = hasValidTo ? body.validTo : undefined;
    if (hasValidTo && validTo !== null && !isIsoDate(validTo)) throw bad("date_invalid", "validTo must be a date (YYYY-MM-DD) or null", { field: "validTo" });
    const note = noteOf(body?.note);
    if (!hasValidTo && note === undefined) throw bad("date_invalid", "send validTo (a date, or null to reopen) or note");
    if (!UUID_RE.test(userId) || !UUID_RE.test(rateId)) throw notFound("rate_not_found", "no such rate for this person");

    const out = await scoped(tenantId, async (c) => {
      const cur = await c.query<{ valid_from: string; valid_to: string | null; name: string }>(
        `SELECT to_char(r.valid_from, 'YYYY-MM-DD') AS valid_from, to_char(r.valid_to, 'YYYY-MM-DD') AS valid_to, u.name
           FROM finance_freelancer_rates r JOIN users u ON u.id = r.user_id
          WHERE r.tenant_id = $1 AND r.id = $2 AND r.user_id = $3 FOR UPDATE OF r`,
        [tenantId, rateId, userId],
      );
      const r = cur.rows[0];
      if (!r) throw notFound("rate_not_found", "no such rate for this person");
      let verb: "freelancer_rate_ended" | "freelancer_rate_reopened" | "freelancer_rate_updated" = "freelancer_rate_updated";
      if (hasValidTo && validTo !== r.valid_to) {
        const newTo = validTo as string | null;
        if (newTo !== null && newTo < r.valid_from) throw bad("date_invalid", `validTo is before the rate's validFrom ${r.valid_from}`, { field: "validTo" });
        // Shortening must not take the rate away from hours it already priced on a bill.
        if (newTo !== null && (r.valid_to === null || newTo < r.valid_to)
            && (await claimedAfter(c, tenantId, userId, r.valid_from, r.valid_to, newTo))) {
          throw conflict("rate_used", `this rate priced hours already billed after ${newTo}; it cannot end before them`);
        }
        // Lengthening (or reopening) must not reach a day payroll pays.
        if (newTo === null || (r.valid_to !== null && newTo > r.valid_to)) {
          const payroll = await payrollOverlap(c, tenantId, userId, r.valid_from, newTo);
          if (payroll) throw conflict("freelancer_on_payroll", `${r.name} has a compensation in force on ${payroll}: payroll would pay them twice`);
        }
        await c.query(`UPDATE finance_freelancer_rates SET valid_to = $2::date, updated_at = now() WHERE id = $1`, [rateId, newTo]);
        verb = newTo === null ? "freelancer_rate_reopened" : "freelancer_rate_ended";
      }
      if (note !== undefined) {
        await c.query(`UPDATE finance_freelancer_rates SET note = $2, updated_at = now() WHERE id = $1`, [rateId, note]);
      }
      return { rate: await readRate(c, tenantId, rateId), verb };
    });
    await writeActivity(tenantId, req.principal.userId, out.verb, "finance_freelancer_rate", rateId, {
      userId, validFrom: out.rate.validFrom, validTo: out.rate.validTo,
    });
    return out.rate;
  }

  @Delete(":tenantId/finance/freelancers/:userId/rates/:rateId")
  async withdrawRate(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("rateId") rateId: string,
  ) {
    await gate(req.principal, tenantId, "vendor_master");
    if (!UUID_RE.test(userId) || !UUID_RE.test(rateId)) throw notFound("rate_not_found", "no such rate for this person");
    const gone = await scoped(tenantId, async (c) => {
      const r = await c.query<{ used: boolean; validFrom: string; validTo: string | null; hourlyRate: number }>(
        `SELECT ${RATE_USED_SQL("r")} AS used, to_char(r.valid_from, 'YYYY-MM-DD') AS "validFrom",
                to_char(r.valid_to, 'YYYY-MM-DD') AS "validTo", r.hourly_rate::float8 AS "hourlyRate"
           FROM finance_freelancer_rates r WHERE r.tenant_id = $1 AND r.id = $2 AND r.user_id = $3 FOR UPDATE OF r`,
        [tenantId, rateId, userId],
      );
      const row = r.rows[0];
      if (!row) throw notFound("rate_not_found", "no such rate for this person");
      if (row.used) throw conflict("rate_used", "this rate priced hours on a bill; end it instead of withdrawing it");
      await c.query(`DELETE FROM finance_freelancer_rates WHERE id = $1`, [rateId]);
      return row;
    });
    await writeActivity(tenantId, req.principal.userId, "freelancer_rate_withdrawn", "finance_freelancer_rate", rateId, {
      userId, validFrom: gone.validFrom, validTo: gone.validTo, hourlyRate: gone.hourlyRate,
    });
    return { deleted: true };
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // §61.8 Freelancer bills
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  @Get(":tenantId/finance/freelancer-bills/preview")
  async preview(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("periodStart") periodStart?: string,
    @Query("periodEnd") periodEnd?: string,
    @Query("userId") userId?: string,
  ) {
    await gate(req.principal, tenantId, "read");
    const problem = periodProblem(periodStart, periodEnd);
    if (problem) throw bad("period_invalid", problem);
    const start = periodStart as string;
    const end = periodEnd as string;
    return scoped(tenantId, async (c) => {
      const billDate = await today(c);
      let people: string[];
      if (userId) {
        const p = await billablePerson(c, tenantId, userId);
        if (!p) throw notFound("person_not_found", "no person of this company has that id");
        people = [p.id];
      } else {
        // Every person with a rate or a linked vendor who has unbilled time in the period.
        const r = await c.query<{ user_id: string }>(
          `SELECT DISTINCT te.user_id
             FROM time_entries te
            WHERE te.tenant_id = $1 AND te.ap_bill_id IS NULL AND te.deleted_at IS NULL
              AND te.entry_date BETWEEN $2::date AND $3::date
              AND (EXISTS (SELECT 1 FROM finance_freelancer_rates r WHERE r.tenant_id = te.tenant_id AND r.user_id = te.user_id)
                   OR EXISTS (SELECT 1 FROM finance_ap_vendors v WHERE v.tenant_id = te.tenant_id AND v.user_id = te.user_id AND v.deleted_at IS NULL))`,
          [tenantId, start, end],
        );
        people = r.rows.map((x) => x.user_id);
      }
      const freelancers = [];
      for (const id of people) {
        const person = await billablePerson(c, tenantId, id);
        if (!person) continue;
        freelancers.push(planView(await buildPlan(c, tenantId, person, start, end, billDate, false)));
      }
      freelancers.sort((a, b) => a.user.name.localeCompare(b.user.name) || a.user.id.localeCompare(b.user.id));
      return { periodStart: start, periodEnd: end, freelancers };
    });
  }

  @Post(":tenantId/finance/freelancer-bills")
  @HttpCode(201)
  async draft(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { userId?: unknown; periodStart?: unknown; periodEnd?: unknown; billDate?: unknown },
  ) {
    await gate(req.principal, tenantId, "bill_entry");
    const problem = periodProblem(body?.periodStart, body?.periodEnd);
    if (problem) throw bad("period_invalid", problem);
    if (body.billDate !== undefined && body.billDate !== null && !isIsoDate(body.billDate)) {
      throw bad("bill_date_invalid", "billDate must be a date (YYYY-MM-DD)", { field: "billDate" });
    }
    const userId = typeof body.userId === "string" ? body.userId : "";
    const start = body.periodStart as string;
    const end = body.periodEnd as string;

    const answer = await scoped(tenantId, async (c) => {
      const person = await billablePerson(c, tenantId, userId);
      if (!person) throw notFound("person_not_found", "no person of this company has that id");
      const billDate = typeof body.billDate === "string" ? body.billDate : await today(c);
      return { person, result: await draftBill(c, tenantId, req.principal.userId, person, start, end, billDate) };
    });
    if (!answer.result.deduped) {
      await writeActivity(tenantId, req.principal.userId, "freelancer_bill_drafted", "finance_ap_bill", answer.result.billId, {
        userId: answer.person.id, periodStart: start, periodEnd: end, billNo: answer.result.billNo,
        entryCount: answer.result.entryCount, subtotal: answer.result.subtotal, withholdingAmount: answer.result.withholdingAmount,
        warnings: answer.result.warnings.map((w) => w.code),
      });
    }
    return answer.result;
  }

  @Get(":tenantId/finance/freelancer-bills")
  async list(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("status") status?: string,
  ) {
    await gate(req.principal, tenantId, "read");
    if (from !== undefined && !isIsoDate(from)) throw bad("period_invalid", "from must be a date (YYYY-MM-DD)", { field: "from" });
    if (to !== undefined && !isIsoDate(to)) throw bad("period_invalid", "to must be a date (YYYY-MM-DD)", { field: "to" });
    const STATUSES = ["draft", "approved", "paid", "void"];
    if (status !== undefined && !STATUSES.includes(status)) throw bad("status_invalid", `status must be one of ${STATUSES.join(", ")}`);
    return scoped(tenantId, async (c) => {
      const r = await c.query<{
        billId: string; billNo: string; userId: string; userName: string; userEmail: string; vendorId: string; vendorCode: string;
        vendorName: string; periodStart: string; periodEnd: string; minutes: number; subtotal: number; withholdingAmount: number;
        amountPayable: number; currency: string; status: string; createdAt: string; createdById: string | null;
        createdByName: string | null; noWithholding: boolean;
      }>(
        `SELECT fb.bill_id AS "billId", ab.bill_no AS "billNo", u.id AS "userId", u.name AS "userName", u.email AS "userEmail",
                v.id AS "vendorId", v.code AS "vendorCode", v.name AS "vendorName",
                to_char(fb.period_start, 'YYYY-MM-DD') AS "periodStart", to_char(fb.period_end, 'YYYY-MM-DD') AS "periodEnd",
                fb.minutes, ab.subtotal::float8 AS subtotal, ab.withholding_amount::float8 AS "withholdingAmount",
                ab.amount_payable::float8 AS "amountPayable", ab.currency_code AS currency, ab.status, fb.created_at AS "createdAt",
                cb.id AS "createdById", cb.name AS "createdByName",
                (ab.withholding_amount = 0 AND NULLIF(btrim(v.default_withholding_code), '') IS NULL) AS "noWithholding"
           FROM finance_freelancer_bills fb
           JOIN finance_ap_bills ab ON ab.id = fb.bill_id AND ab.tenant_id = fb.tenant_id
           JOIN finance_ap_vendors v ON v.id = fb.vendor_id AND v.tenant_id = fb.tenant_id
           JOIN users u ON u.id = fb.user_id
           LEFT JOIN users cb ON cb.id = fb.created_by
          WHERE fb.tenant_id = $1
            AND ($2::date IS NULL OR fb.period_end >= $2::date)
            AND ($3::date IS NULL OR fb.period_start <= $3::date)
            AND ($4::text IS NULL OR ab.status = $4::text)
          ORDER BY fb.period_start DESC, u.name, fb.created_at DESC`,
        [tenantId, from ?? null, to ?? null, status ?? null],
      );
      return r.rows.map((b) => ({
        billId: b.billId, billNo: b.billNo,
        user: { id: b.userId, name: b.userName, email: b.userEmail },
        vendor: { id: b.vendorId, code: b.vendorCode, name: b.vendorName },
        periodStart: b.periodStart, periodEnd: b.periodEnd, minutes: b.minutes,
        subtotal: b.subtotal, withholdingAmount: b.withholdingAmount, amountPayable: b.amountPayable, currency: b.currency,
        status: b.status, createdAt: b.createdAt,
        createdBy: b.createdById ? { id: b.createdById, name: b.createdByName } : null,
        warnings: b.noWithholding ? [noWithholdingWarning(b.vendorName)] : [],
      }));
    });
  }

  @Delete(":tenantId/finance/freelancer-bills/:billId")
  async discard(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("billId") billId: string) {
    await gate(req.principal, tenantId, "bill_entry");
    if (!UUID_RE.test(billId)) throw notFound("freelancer_bill_not_found", "no freelancer bill with that id in this company");
    const out = await scoped(tenantId, async (c) => {
      // A manual AP bill has no freelancer row, so it reads as not found: this route never deletes one.
      const b = await c.query<{ status: string; bill_no: string; user_id: string }>(
        `SELECT ab.status, ab.bill_no, fb.user_id
           FROM finance_freelancer_bills fb JOIN finance_ap_bills ab ON ab.id = fb.bill_id AND ab.tenant_id = fb.tenant_id
          WHERE fb.tenant_id = $1 AND fb.bill_id = $2
          FOR UPDATE OF ab`,
        [tenantId, billId],
      );
      const row = b.rows[0];
      if (!row) throw notFound("freelancer_bill_not_found", "no freelancer bill with that id in this company");
      if (row.status !== "draft") throw conflict("bill_not_draft", `bill ${row.bill_no} is ${row.status}; only a draft can be discarded`);
      const n = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM time_entries WHERE tenant_id = $1 AND ap_bill_id = $2`, [tenantId, billId]);
      // The cascade removes the lines and the freelancer row; the FK's SET NULL (ap_bill_id) releases the entries.
      await c.query(`DELETE FROM finance_ap_bills WHERE tenant_id = $1 AND id = $2`, [tenantId, billId]);
      return { billNo: row.bill_no, userId: row.user_id, released: n.rows[0].n };
    });
    await writeActivity(tenantId, req.principal.userId, "freelancer_bill_discarded", "finance_ap_bill", billId, {
      billNo: out.billNo, userId: out.userId, releasedEntries: out.released,
    });
    return { billId, discarded: true, releasedEntries: out.released };
  }
}
