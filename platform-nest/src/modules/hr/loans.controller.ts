// EMPLOYEE LOANS (employee-portal wave E). Mounted under the SAME prefix and guards as
// HrController — /api/:tenantId/modules/hr, AuthGuard + ModuleEnabledGuard("hr") — because a loan is
// an HR-module resource; it is a separate class only to keep hr.controller.ts from growing further.
//
// The three walls of design §2.4 apply unchanged (Cerbos -> withTenants -> module-sliced RLS), and
// every query below passes `{ modules: ["hr"] }`. Omitting it reads/writes ZERO rows silently.
//
// AUTHORIZATION, and the one asymmetry that matters:
//   request / list / detail / cancel   authorize as hr_case with subjectUserId  -> the `member`
//                                      self-service rule in resource_hr_case.yaml matches, so an
//                                      employee can do these for THEMSELVES.
//   record a repayment                 authorizes as hr_case "update" -> `member` does NOT hold
//                                      that action, so the employee who owes the money can never
//                                      declare it paid. Only module_staff/module_manager/
//                                      company_admin/group_executive can write the ledger.
// This reuses the EXISTING hr_case policy rather than adding resource_hr_loan.yaml — deliberately:
// a brand-new policy file is not hot-reloaded through the Cerbos bind mount, and an unlisted kind
// is a silent DENY that reads like a logic bug (see the cerbos-new-policy-needs-restart trap).
//
// The DECISION is not made here. Requesting a loan files an automation_approvals row (origin='hr'),
// exactly as leave does; a human decides it on the unified approvals surface, and
// loan-decision.ts applies that decision + freezes the amortization schedule.
import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException,
  Param, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withGlobal, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity } from "../../core/http";
import { notifyBestEffort } from "../../core/client-notify";
import { resolveAutomationApprovalDeciders } from "../../core/approval-deciders";
import { emitEvent } from "../../events/outbox.service";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { staffOrSelfRead } from "./hr.controller";
import {
  buildSchedule, firstOfNextMonth, localToday, summarizeLoan, type Installment, type RepaymentRow,
} from "./loan-schedule";

const REPAYMENT_METHODS = new Set(["payroll_deduction", "transfer", "cash", "other"]);
const MAX_TERM_MONTHS = 120;

/** Today as an ISO date, from LOCAL components (see localToday's note on why not toISOString). */
const today = localToday;

interface LoanRow {
  id: string;
  subject_user_id: string;
  principal_amount: string;
  currency: string;
  term_months: number;
  annual_interest_rate: string;
  purpose: string | null;
  status: string;
  approval_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  first_due_on: string | null;
  total_payable: string | null;
  created_at: string;
}

@Controller("api/:tenantId/modules/hr")
@UseGuards(AuthGuard, ModuleEnabledGuard("hr"))
export class LoansController {
  // ============================================================== REQUEST A LOAN ==============
  @Post("loans")
  @HttpCode(201)
  async requestLoan(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: {
      subjectUserId?: string; principalAmount?: number; termMonths?: number;
      annualInterestRate?: number; currency?: string; purpose?: string;
    },
  ) {
    const subjectUserId = body?.subjectUserId;
    const principalAmount = Number(body?.principalAmount);
    const termMonths = Math.trunc(Number(body?.termMonths));
    // Rate is OPTIONAL and defaults to 0: an interest-free staff loan is the common case, and
    // requiring the requester to state a rate would make them guess company policy.
    const annualInterestRate = body?.annualInterestRate === undefined ? 0 : Number(body.annualInterestRate);
    const currency = (body?.currency ?? "IDR").toUpperCase();

    if (!subjectUserId || !Number.isFinite(principalAmount) || principalAmount <= 0
      || !Number.isFinite(termMonths) || termMonths < 1 || termMonths > MAX_TERM_MONTHS) {
      throw new BadRequestException(
        `subjectUserId, principalAmount>0 and termMonths between 1 and ${MAX_TERM_MONTHS} required`,
      );
    }
    if (!Number.isFinite(annualInterestRate) || annualInterestRate < 0 || annualInterestRate > 100) {
      throw new BadRequestException("annualInterestRate must be between 0 and 100");
    }
    if (!/^[A-Z]{3}$/.test(currency)) throw new BadRequestException("currency must be a 3-letter code");
    await authorize(req.principal, { kind: "hr_case", tenantId, module: "hr", subjectUserId }, "create");

    const subject = await withGlobal((c) => c.query<{ name: string }>(`SELECT name FROM users WHERE id = $1`, [subjectUserId]));
    const subjectName = subject.rows[0]?.name ?? subjectUserId;

    const { loanId, approvalId } = await withTenants(
      [tenantId],
      async (c) => {
        // One live loan at a time per employee. Without this an employee can stack requests and the
        // decider approves them one by one with no view of the total exposure.
        const live = await c.query<{ n: string }>(
          `SELECT count(*) AS n FROM hr_loan_requests
            WHERE tenant_id = $1 AND subject_user_id = $2 AND deleted_at IS NULL
              AND status IN ('pending','approved')`,
          [tenantId, subjectUserId],
        );
        if (Number(live.rows[0].n) > 0) {
          throw new BadRequestException("this employee already has a pending or active loan");
        }

        const id = newId();
        await c.query(
          `INSERT INTO hr_loan_requests
             (id, tenant_id, subject_user_id, principal_amount, currency, term_months, annual_interest_rate, purpose)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, tenantId, subjectUserId, principalAmount, currency, termMonths, annualInterestRate, body?.purpose ?? null],
        );

        // A PREVIEW of the schedule goes into the approval payload so the decider sees the monthly
        // burden and total cost at decision time, not just the principal. It is not persisted here —
        // the authoritative schedule is frozen by loan-decision.ts on approval.
        const preview = buildSchedule({
          principal: principalAmount, annualRatePct: annualInterestRate,
          termMonths, firstDueOn: firstOfNextMonth(today()),
        });
        const totalPayable = preview.reduce((s, i) => s + i.totalDue, 0);
        const href = `/me/loans/${id}`;
        const approvalIdRow = newId();
        await c.query(
          `INSERT INTO automation_approvals
             (id, tenant_id, workflow_id, tool_name, tool_args, impact, reason, requested_by, origin, origin_site)
           VALUES ($1,$2,'hr:loan','hr.requestLoan',$3,'high',$4,$5,'hr',$6)`,
          [
            approvalIdRow, tenantId,
            JSON.stringify({
              loanRequestId: id, subjectUserId, subjectName, principalAmount, currency, termMonths,
              annualInterestRate,
              schedulePreview: {
                installmentCount: preview.length,
                firstDueOn: preview[0]?.dueOn ?? null,
                lastDueOn: preview[preview.length - 1]?.dueOn ?? null,
                monthlyPayment: preview[0]?.totalDue ?? 0,
                totalPayable: Math.round(totalPayable * 100) / 100,
                totalInterest: Math.round((totalPayable - principalAmount) * 100) / 100,
              },
              href,
            }),
            // 'high' impact, not leave's 'medium': this one moves money.
            `${subjectName} requested a ${currency} ${principalAmount.toLocaleString("en-US")} loan over ${termMonths} months`,
            req.principal.userId, config.originSite,
          ],
        );
        await c.query(`UPDATE hr_loan_requests SET approval_id = $2 WHERE id = $1`, [id, approvalIdRow]);
        await emitEvent(c, tenantId, "hr_loan_request", id, "hr.loan.requested", {
          subjectUserId, principalAmount, currency, termMonths, approvalId: approvalIdRow,
        });
        return { loanId: id, approvalId: approvalIdRow };
      },
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "requested", "hr_loan_request", loanId, {
      subjectUserId, principalAmount, currency, termMonths,
    });

    // See the MAIL-06 note in hr.controller.ts: this is the SECOND (and only other) origin='hr'
    // approval-creation site, so it resolves the same module='hr' decider set.
    const deciders = await resolveAutomationApprovalDeciders(tenantId, "hr");
    await notifyBestEffort(tenantId, req.principal.userId, deciders, "approval.requested", {
      title: `${subjectName} requested a loan`,
      href: `/approvals/${approvalId}`,
      entityType: "automation_approval",
      entityId: approvalId,
      origin: "hr",
      impact: "high",
    });
    return { id: loanId, approvalId, status: "pending" };
  }

  // ===================================================================== LIST =================
  @Get("loans")
  async listLoans(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("subjectUserId") subjectUserId?: string, @Query("status") status?: string,
  ) {
    // Staff see the whole tenant; an employee falls back to the member self-rule and is narrowed to
    // their own rows by the WHERE clause below. A genuinely unauthorized caller gets 403, never an
    // empty list.
    const { selfOnly } = await staffOrSelfRead(req.principal, tenantId, "hr_case");
    const effectiveSubject = selfOnly ? (req.principal.userId ?? "") : subjectUserId;

    const rows = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query<LoanRow & { subject_name: string | null }>(
          `SELECT l.*, u.name AS subject_name
             FROM hr_loan_requests l
             LEFT JOIN users u ON u.id = l.subject_user_id
            WHERE l.tenant_id = $1 AND l.deleted_at IS NULL
              AND ($2::uuid IS NULL OR l.subject_user_id = $2)
              AND ($3::text IS NULL OR l.status = $3)
            ORDER BY l.created_at DESC`,
          [tenantId, effectiveSubject || null, status || null],
        );
        // Balances come from the ledger, so the list can show "outstanding" without N+1 detail
        // fetches. Both child reads are one query each, keyed by the loan ids on the page.
        const ids = r.rows.map((x) => x.id);
        const { installments, repayments } = await loadChildren(c, tenantId, ids);
        return r.rows.map((row) => shapeLoan(row, installments.get(row.id) ?? [], repayments.get(row.id) ?? []));
      },
      { modules: ["hr"] },
    );
    return { loans: rows, scope: selfOnly ? "self" : "tenant" };
  }

  // =================================================================== DETAIL =================
  @Get("loans/:id")
  async getLoan(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const loaded = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query<LoanRow & { subject_name: string | null }>(
          `SELECT l.*, u.name AS subject_name
             FROM hr_loan_requests l
             LEFT JOIN users u ON u.id = l.subject_user_id
            WHERE l.id = $1 AND l.deleted_at IS NULL`,
          [id],
        );
        const row = r.rows[0];
        if (!row) return null;
        const { installments, repayments } = await loadChildren(c, tenantId, [id]);
        const ledger = await c.query<{
          id: string; amount: string; paid_on: string; method: string; note: string | null;
          recorded_by: string; recorded_by_name: string | null; created_at: string;
        }>(
          `SELECT r.id, r.amount, r.paid_on, r.method, r.note, r.recorded_by,
                  u.name AS recorded_by_name, r.created_at
             FROM hr_loan_repayments r
             LEFT JOIN users u ON u.id = r.recorded_by
            WHERE r.tenant_id = $1 AND r.loan_request_id = $2
            ORDER BY r.paid_on ASC, r.created_at ASC`,
          [tenantId, id],
        );
        return { row, installments: installments.get(id) ?? [], repayments: repayments.get(id) ?? [], ledger: ledger.rows };
      },
      { modules: ["hr"] },
    );
    // A row invisible to this caller's tenant set — or hidden by the module wall — is a 404, not a
    // 403: the caller must not learn that the id exists.
    if (!loaded) throw new NotFoundException("loan not found");

    // Authorize the ROW's subject, so an employee reads their own loan and staff read any. Done
    // after the fetch because the subject is what is being authorized.
    //
    // A denial becomes 404, NOT 403. Otherwise the two outcomes are distinguishable and the endpoint
    // is an existence oracle: a colleague could walk loan ids and learn which ones are real in their
    // company, which is exactly the fact a loan's existence should not volunteer. The caller has no
    // legitimate use for the difference — they cannot see the row either way.
    try {
      await authorize(
        req.principal,
        { kind: "hr_case", tenantId, module: "hr", subjectUserId: loaded.row.subject_user_id },
        "read",
      );
    } catch {
      throw new NotFoundException("loan not found");
    }
    return {
      ...shapeLoan(loaded.row, loaded.installments, loaded.repayments),
      repayments: loaded.ledger.map((r) => ({
        id: r.id, amount: Number(r.amount), paidOn: r.paid_on, method: r.method,
        note: r.note, recordedBy: r.recorded_by, recordedByName: r.recorded_by_name, createdAt: r.created_at,
      })),
    };
  }

  // =================================================================== CANCEL =================
  // Self-service withdrawal of one's OWN PENDING request — the same shape as leave/:id/cancel, and
  // for the same reason: `member` holds "cancel" on the hr_case gate, so staff use the approvals
  // inbox to DENY rather than cancelling on someone's behalf here.
  @Post("loans/:id/cancel")
  @HttpCode(200)
  async cancelLoan(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const row = await withTenants(
      [tenantId],
      (c) => c.query<{ subject_user_id: string; status: string; approval_id: string | null }>(
        `SELECT subject_user_id, status, approval_id FROM hr_loan_requests WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      ),
      { modules: ["hr"] },
    );
    const loan = row.rows[0];
    if (!loan) throw new NotFoundException("loan not found");
    await authorize(
      req.principal,
      { kind: "hr_case", tenantId, module: "hr", subjectUserId: loan.subject_user_id },
      "cancel",
    );
    if (loan.status !== "pending") {
      throw new BadRequestException(`only a pending loan request can be cancelled (this one is ${loan.status})`);
    }

    await withTenants(
      [tenantId],
      async (c) => {
        await c.query(
          `UPDATE hr_loan_requests SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = 'pending'`,
          [id],
        );
        // Withdraw the paired approval so it stops sitting in the deciders' inbox. Guarded on
        // 'pending' so a decision that landed in the same moment wins instead of being overwritten.
        if (loan.approval_id) {
          await c.query(
            `UPDATE automation_approvals SET status = 'cancelled', decided_at = now()
              WHERE id = $1 AND tenant_id = $2 AND status = 'pending'`,
            [loan.approval_id, tenantId],
          );
        }
        await emitEvent(c, tenantId, "hr_loan_request", id, "hr.loan.cancelled", { subjectUserId: loan.subject_user_id });
      },
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "cancelled", "hr_loan_request", id, {});
    return { id, status: "cancelled" };
  }

  // ================================================================ REPAYMENTS =================
  // STAFF ONLY by construction: "update" is not in the `member` rule of resource_hr_case.yaml, so
  // the employee who owes the money cannot record their own repayment. See the header.
  @Post("loans/:id/repayments")
  @HttpCode(201)
  async recordRepayment(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { amount?: number; paidOn?: string; method?: string; note?: string },
  ) {
    const amount = Number(body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException("amount must be > 0");
    const method = body?.method ?? "transfer";
    if (!REPAYMENT_METHODS.has(method)) {
      throw new BadRequestException(`method must be one of ${[...REPAYMENT_METHODS].join("|")}`);
    }
    const paidOn = body?.paidOn ?? today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) throw new BadRequestException("paidOn must be an ISO date (YYYY-MM-DD)");

    const loaded = await withTenants(
      [tenantId],
      (c) => c.query<{ subject_user_id: string; status: string }>(
        `SELECT subject_user_id, status FROM hr_loan_requests WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      ),
      { modules: ["hr"] },
    );
    const loan = loaded.rows[0];
    if (!loan) throw new NotFoundException("loan not found");
    await authorize(
      req.principal,
      { kind: "hr_case", tenantId, module: "hr", subjectUserId: loan.subject_user_id },
      "update",
    );
    // A pending/denied/cancelled loan has no schedule to repay against.
    if (loan.status !== "approved" && loan.status !== "settled") {
      throw new BadRequestException(`cannot record a repayment against a ${loan.status} loan`);
    }

    const result = await withTenants(
      [tenantId],
      async (c) => {
        const repaymentId = newId();
        await c.query(
          `INSERT INTO hr_loan_repayments (id, tenant_id, loan_request_id, amount, paid_on, method, note, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [repaymentId, tenantId, id, amount, paidOn, method, body?.note ?? null, req.principal.userId],
        );
        const { installments, repayments } = await loadChildren(c, tenantId, [id]);
        const summary = summarizeLoan(installments.get(id) ?? [], repayments.get(id) ?? [], today());
        // Auto-settle the moment the ledger covers the schedule, and un-settle if a repayment is
        // ever reversed by a correcting entry (the status is derived from the ledger, not latched).
        const nextStatus = summary.settled ? "settled" : "approved";
        if (nextStatus !== loan.status) {
          await c.query(`UPDATE hr_loan_requests SET status = $2, updated_at = now() WHERE id = $1`, [id, nextStatus]);
        }
        await emitEvent(c, tenantId, "hr_loan_request", id, "hr.loan.repayment.recorded", {
          subjectUserId: loan.subject_user_id, amount, method, outstanding: summary.outstanding, settled: summary.settled,
        });
        return { repaymentId, summary, nextStatus };
      },
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "recorded", "hr_loan_repayment", result.repaymentId, {
      loanRequestId: id, amount, method,
    });

    // Tell the employee their balance moved — they cannot write the ledger, so this is the only way
    // they learn a payroll deduction or transfer was applied.
    await notifyBestEffort(tenantId, req.principal.userId, [loan.subject_user_id], "hr.loan.repayment", {
      title: result.summary.settled ? "Your loan is fully repaid" : "A loan repayment was recorded",
      severity: "info",
      entityType: "hr_loan_request",
      entityId: id,
      href: `/me/loans/${id}`,
      amount,
      outstanding: result.summary.outstanding,
    });
    return { id: result.repaymentId, loanId: id, status: result.nextStatus, summary: result.summary };
  }
}

// ══════════════════════════════════════════════════════════════════════════════════ helpers ══

interface ChildRows {
  installments: Map<string, Installment[]>;
  repayments: Map<string, RepaymentRow[]>;
}

/** Both child tables for a page of loans in ONE query each (avoids N+1 on the list endpoint). */
async function loadChildren(
  c: { query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  tenantId: string,
  loanIds: string[],
): Promise<ChildRows> {
  const installments = new Map<string, Installment[]>();
  const repayments = new Map<string, RepaymentRow[]>();
  if (loanIds.length === 0) return { installments, repayments };

  const inst = await c.query(
    `SELECT loan_request_id, seq, due_on, principal_due, interest_due, total_due
       FROM hr_loan_installments
      WHERE tenant_id = $1 AND loan_request_id = ANY($2::uuid[])
      ORDER BY loan_request_id, seq`,
    [tenantId, loanIds],
  );
  for (const r of inst.rows) {
    const key = String(r.loan_request_id);
    const list = installments.get(key) ?? [];
    list.push({
      seq: Number(r.seq),
      dueOn: isoDate(r.due_on),
      principalDue: Number(r.principal_due),
      interestDue: Number(r.interest_due),
      totalDue: Number(r.total_due),
    });
    installments.set(key, list);
  }

  const pays = await c.query(
    `SELECT loan_request_id, amount, paid_on FROM hr_loan_repayments
      WHERE tenant_id = $1 AND loan_request_id = ANY($2::uuid[])
      ORDER BY loan_request_id, paid_on`,
    [tenantId, loanIds],
  );
  for (const r of pays.rows) {
    const key = String(r.loan_request_id);
    const list = repayments.get(key) ?? [];
    list.push({ amount: String(r.amount), paidOn: isoDate(r.paid_on) });
    repayments.set(key, list);
  }
  return { installments, repayments };
}

/**
 * pg returns a `date` column as a JS Date at LOCAL midnight; the schedule math is string-based, so
 * normalize at the boundary.
 *
 * ⚠ NOT `toISOString()`. That converts to UTC, which moves the CALENDAR DAY BACKWARDS for every
 * timezone east of UTC: on a UTC+8 machine a due date of 2026-09-01 comes back as "2026-08-31".
 * Latent rather than live today only because the containers run with no TZ set (UTC), so local ==
 * UTC there — but it reproduces on any dev box in Asia (it broke a real assertion in
 * loans.test.ts), and setting TZ on the container, which a Bali-based team would plausibly do to
 * make logs readable, would ship it to production silently. For a date-only column the LOCAL
 * components are the value, so read those.
 */
function isoDate(v: unknown): string {
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  return String(v).slice(0, 10);
}

function shapeLoan(
  row: LoanRow & { subject_name?: string | null },
  installments: Installment[],
  repayments: RepaymentRow[],
) {
  const summary = summarizeLoan(installments, repayments, today());
  return {
    id: row.id,
    subjectUserId: row.subject_user_id,
    subjectName: row.subject_name ?? null,
    principalAmount: Number(row.principal_amount),
    currency: row.currency,
    termMonths: row.term_months,
    annualInterestRate: Number(row.annual_interest_rate),
    purpose: row.purpose,
    status: row.status,
    approvalId: row.approval_id,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    firstDueOn: row.first_due_on ? isoDate(row.first_due_on) : null,
    // Header value once approved; before that the schedule does not exist yet and the summary of an
    // empty schedule is 0 — so fall back to null rather than reporting a payable of zero.
    totalPayable: row.total_payable !== null ? Number(row.total_payable) : null,
    createdAt: row.created_at,
    schedule: summary.installments,
    summary: {
      totalPayable: summary.totalPayable,
      totalPrincipal: summary.totalPrincipal,
      totalInterest: summary.totalInterest,
      totalPaid: summary.totalPaid,
      outstanding: summary.outstanding,
      credit: summary.credit,
      paidInstallments: summary.paidInstallments,
      installmentCount: summary.installmentCount,
      overdueCount: summary.overdueCount,
      overdueAmount: summary.overdueAmount,
      nextDue: summary.nextDue,
      settled: summary.settled,
    },
  };
}
