import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { METHOD_LABEL, money, loanDate, repaidPercent } from "@/lib/loans";
import { getLoan } from "@/lib/loans-data";
import { recordRepayment } from "@/lib/loanActions";
import { RepaymentForm } from "@/components/me/RepaymentForm";
import { CancelLoanButton } from "@/components/me/CancelLoanButton";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Card, StatusBadge } from "@/components/ui";
import { MailThreadPanel } from "@/components/mail/MailThreadPanel";

// `/me/loans/[loanId]` — the agreement, the frozen schedule, and the money ledger.
//
// The schedule is what was FROZEN at approval, not a live recomputation: if the rounding rule ever
// changes, what this employee already agreed to owe does not (see migration 0081's header). Which
// instalment a payment settles IS derived (FIFO), so the allocation policy can change without a
// data migration.
//
// Repayment recording is staff-only — `can(me, "hr.manage")` here, and independently hr_case:update
// on the server, which the `member` derived role does not hold.

type Params = Promise<{ loanId: string }>;

const STATE_LABEL: Record<string, string> = { paid: "Paid", partial: "Part-paid", unpaid: "Due" };

export default async function LoanDetailPage({ params }: { params: Params }) {
  const { loanId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const loan = await getLoan(userId, tenant, loanId);
  if (!loan) notFound();

  const isStaff = can(me, "hr.manage", tenant);
  const pct = repaidPercent(loan.summary);
  const scheduled = loan.schedule.length > 0;

  const facts: { label: string; value: string }[] = [
    { label: "Principal", value: money(loan.principalAmount, loan.currency) },
    { label: "Term", value: `${loan.termMonths} months` },
    { label: "Interest", value: loan.annualInterestRate > 0 ? `${loan.annualInterestRate}% p.a.` : "Interest-free" },
    { label: "Requested", value: loanDate(loan.createdAt) },
    ...(loan.decidedAt ? [{ label: "Decided", value: loanDate(loan.decidedAt) }] : []),
    ...(loan.firstDueOn ? [{ label: "First instalment", value: loanDate(loan.firstDueOn) }] : []),
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <Link href="/me/loans" style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
          ← All loans
        </Link>
        <StatusBadge label={loan.status} />
        {loan.subjectName && loan.subjectUserId !== userId && (
          <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
            {loan.subjectName}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {loan.status === "pending" && <CancelLoanButton tenantId={tenant} loanId={loan.id} />}
        {isStaff && (loan.status === "approved" || loan.status === "settled") && (
          <RepaymentForm
            record={recordRepayment} companyId={tenant} loanId={loan.id}
            outstanding={loan.summary.outstanding} currency={loan.currency}
          />
        )}
        {loan.approvalId && (
          <Link href={`/approvals/${loan.approvalId}`} className="lux-btn lux-btn--sm">
            View approval
          </Link>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        {facts.map((f) => (
          <Card key={f.label}>
            <p style={{
              margin: 0, font: "700 11px var(--font-body)", letterSpacing: "0.08em",
              textTransform: "uppercase", color: "var(--erp-ink-50)",
            }}>
              {f.label}
            </p>
            <p style={{ margin: "8px 0 0", font: "400 15px var(--font-body)", color: "var(--erp-ink)" }}>{f.value}</p>
          </Card>
        ))}
      </div>

      {loan.purpose && (
        <Card title="Purpose">
          <p style={{ margin: 0, font: "400 14px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>{loan.purpose}</p>
        </Card>
      )}

      {!scheduled ? (
        <EmptyNote>
          {loan.status === "pending"
            ? "The repayment schedule is set when this request is approved."
            : `This request was ${loan.status}, so no repayment schedule was created.`}
        </EmptyNote>
      ) : (
        <>
          <Card title="Balance">
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
              <span style={{ font: "400 13px var(--font-body)", color: "var(--erp-ink-50)" }}>
                {money(loan.summary.totalPaid, loan.currency)} repaid of {money(loan.summary.totalPayable, loan.currency)}
              </span>
              <span style={{ font: "500 13px var(--font-body)", color: "var(--erp-ink)" }}>
                {loan.summary.settled ? "Settled" : `${money(loan.summary.outstanding, loan.currency)} outstanding`}
              </span>
            </div>
            <div
              role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Loan repaid"
              style={{ height: 4, background: "var(--erp-hairline)" }}
            >
              <div style={{ width: `${pct}%`, height: "100%", background: "var(--erp-ink)" }} />
            </div>
            <p style={{ margin: "10px 0 0", font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
              {loan.summary.paidInstallments} of {loan.summary.installmentCount} instalments paid
              {loan.summary.totalInterest > 0 ? ` · ${money(loan.summary.totalInterest, loan.currency)} total interest` : ""}
              {/* An overpayment is shown as credit rather than hidden inside a negative balance. */}
              {loan.summary.credit > 0 ? ` · ${money(loan.summary.credit, loan.currency)} credit` : ""}
            </p>
            {loan.summary.overdueCount > 0 && (
              <p style={{ margin: "8px 0 0", font: "500 12px var(--font-body)", color: "var(--status-critical-fg)" }}>
                {loan.summary.overdueCount} instalment{loan.summary.overdueCount === 1 ? "" : "s"} overdue —
                {" "}{money(loan.summary.overdueAmount, loan.currency)}
              </p>
            )}
          </Card>

          <Card title="Schedule" hint="Frozen when the loan was approved. Payments are applied oldest instalment first.">
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", font: "400 13px var(--font-body)" }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--erp-ink-50)" }}>
                    <th style={{ padding: "6px 10px 6px 0", font: "700 11px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase" }}>#</th>
                    <th style={{ padding: "6px 10px", font: "700 11px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase" }}>Due</th>
                    <th style={{ padding: "6px 10px", textAlign: "right", font: "700 11px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase" }}>Principal</th>
                    <th style={{ padding: "6px 10px", textAlign: "right", font: "700 11px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase" }}>Interest</th>
                    <th style={{ padding: "6px 10px", textAlign: "right", font: "700 11px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase" }}>Total</th>
                    <th style={{ padding: "6px 0 6px 10px", textAlign: "right", font: "700 11px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase" }}>State</th>
                  </tr>
                </thead>
                <tbody>
                  {loan.schedule.map((i) => (
                    <tr key={i.seq} style={{ borderTop: "0.5px solid var(--erp-hairline)" }}>
                      <td style={{ padding: "8px 10px 8px 0", color: "var(--erp-ink-50)" }}>{i.seq}</td>
                      <td style={{ padding: "8px 10px", color: "var(--erp-ink)" }}>{loanDate(i.dueOn)}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", color: "var(--erp-ink-60)" }}>
                        {money(i.principalDue, loan.currency)}
                      </td>
                      <td style={{ padding: "8px 10px", textAlign: "right", color: "var(--erp-ink-60)" }}>
                        {i.interestDue > 0 ? money(i.interestDue, loan.currency) : "—"}
                      </td>
                      <td style={{ padding: "8px 10px", textAlign: "right", color: "var(--erp-ink)" }}>
                        {money(i.totalDue, loan.currency)}
                      </td>
                      <td style={{
                        padding: "8px 0 8px 10px", textAlign: "right",
                        color: i.overdue ? "var(--status-critical-fg)" : i.state === "paid" ? "var(--erp-ink-50)" : "var(--erp-ink-60)",
                      }}>
                        {i.overdue ? "Overdue" : STATE_LABEL[i.state]}
                        {i.state === "partial" ? ` · ${money(i.outstanding, loan.currency)} left` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Repayments">
            {loan.repayments.length === 0 ? (
              <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--erp-ink-50)" }}>
                No repayment has been recorded yet.
              </p>
            ) : (
              <div>
                {loan.repayments.map((r, idx) => (
                  <div
                    key={r.id}
                    style={{
                      display: "flex", alignItems: "baseline", gap: 12, padding: "10px 0",
                      borderTop: idx === 0 ? "none" : "0.5px solid var(--erp-hairline)",
                    }}
                  >
                    <span style={{ font: "500 14px var(--font-body)", color: "var(--erp-ink)", minWidth: 120 }}>
                      {money(r.amount, loan.currency)}
                    </span>
                    <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)", flex: 1 }}>
                      {loanDate(r.paidOn)} · {METHOD_LABEL[r.method] ?? r.method}
                      {r.recordedByName ? ` · recorded by ${r.recordedByName}` : ""}
                      {r.note ? ` · ${r.note}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      {/* Any mail exchanged about this loan, same panel the portal and pipeline surfaces use. */}
      <MailThreadPanel
        userId={userId} tenantId={tenant}
        entityType="hr_loan_request" entityId={loan.id} title="Correspondence"
      />
    </div>
  );
}
