// Employee-loan approval decision (wave E) — the loan counterpart of leave-decision.ts, applied
// through the SAME unified path: a human decides on the existing /automation-approvals/:id/decide
// endpoint, the outbox -> Redis -> consumer pipeline delivers `automation_approval.decided`, and the
// hr module's dispatcher routes it here when the payload carries a loanRequestId.
//
// APPROVAL IS WHERE THE SCHEDULE IS BORN. The request only records what was ASKED for; this handler
// freezes the amortization rows that define what is OWED (see 0081's header for why they are
// materialized rather than recomputed). Both the header fields and the installment rows are written
// in ONE transaction, so a partially-scheduled loan cannot exist.
import { withTenants } from "../../db";
import { notify } from "../../core/http";
import type { OutboxEvent } from "../../events/types";
import { buildSchedule, firstOfNextMonth } from "./loan-schedule";

interface DecidedPayload {
  decision?: "approved" | "rejected";
  origin?: string;
  decidedBy?: string | null;
  toolArgs?: { loanRequestId?: string } & Record<string, unknown>;
}

export async function applyLoanDecision(event: OutboxEvent): Promise<void> {
  const payload = event.payload as DecidedPayload;
  if (payload.origin !== "hr") return;
  const decision = payload.decision;
  if (decision !== "approved" && decision !== "rejected") return;
  const loanRequestId = payload.toolArgs?.loanRequestId;
  if (!loanRequestId) return;

  const tenantId = event.tenantId;
  const newStatus = decision === "approved" ? "approved" : "denied";

  const decided = await withTenants(
    [tenantId],
    async (c) => {
      // Idempotent by construction: only a still-pending row transitions. A redelivered event, or a
      // request the employee withdrew in between, changes nothing on a second pass — which also
      // means the installment INSERT below can never run twice for the same loan.
      const upd = await c.query<{
        subject_user_id: string; principal_amount: string; currency: string;
        term_months: number; annual_interest_rate: string;
      }>(
        `UPDATE hr_loan_requests
           SET status = $2, decided_by = $3, decided_at = now(), approval_id = $4, updated_at = now()
         WHERE id = $1 AND status = 'pending'
         RETURNING subject_user_id, principal_amount, currency, term_months, annual_interest_rate`,
        [loanRequestId, newStatus, payload.decidedBy ?? null, event.entityId],
      );
      const row = upd.rows[0];
      if (!row) return null;
      if (newStatus !== "approved") return { row, outstanding: 0, monthly: 0, installments: 0 };

      // The schedule is anchored on the APPROVAL date, not the request date: a request that sat in
      // the inbox for three weeks should not have its first installment already in the past.
      const schedule = buildSchedule({
        principal: row.principal_amount,
        annualRatePct: row.annual_interest_rate,
        termMonths: row.term_months,
        firstDueOn: firstOfNextMonth(new Date().toISOString().slice(0, 10)),
      });
      // Note: `schedule.length` can be SHORTER than term_months for a degenerate tiny principal
      // (loan-schedule.ts closes the loan early rather than emitting zero-value rows, which
      // 0081's CHECK (total_due > 0) would reject) — so the rows drive the header, not the term.
      for (const inst of schedule) {
        await c.query(
          `INSERT INTO hr_loan_installments
             (tenant_id, loan_request_id, seq, due_on, principal_due, interest_due, total_due)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [tenantId, loanRequestId, inst.seq, inst.dueOn, inst.principalDue, inst.interestDue, inst.totalDue],
        );
      }
      const totalPayable = Math.round(schedule.reduce((s, i) => s + i.totalDue, 0) * 100) / 100;
      await c.query(
        `UPDATE hr_loan_requests SET first_due_on = $2, total_payable = $3, updated_at = now() WHERE id = $1`,
        [loanRequestId, schedule[0].dueOn, totalPayable],
      );
      return { row, outstanding: totalPayable, monthly: schedule[0].totalDue, installments: schedule.length };
    },
    { modules: ["hr"] },
  );
  if (!decided) return;

  const { row } = decided;
  await notify(tenantId, row.subject_user_id, null, "hr.loan.decided", {
    title: newStatus === "approved" ? "Your loan request was approved" : "Your loan request was declined",
    severity: newStatus === "approved" ? "info" : "warning",
    entityType: "hr_loan_request",
    entityId: loanRequestId,
    href: `/me/loans/${loanRequestId}`,
    loanRequestId,
    decision: newStatus,
    // Give the employee the terms in the notification itself — the numbers are the point.
    ...(newStatus === "approved"
      ? {
          currency: row.currency,
          totalPayable: decided.outstanding,
          monthlyPayment: decided.monthly,
          installments: decided.installments,
        }
      : {}),
  });
}
