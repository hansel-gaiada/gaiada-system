import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { isModuleOnForActiveCompany } from "@/lib/modules";
import { money, loanDate, repaidPercent } from "@/lib/loans";
import { listLoans } from "@/lib/loans-data";
import { requestLoan } from "@/lib/loanActions";
import { LoanRequestForm } from "@/components/me/LoanRequestForm";
import { CancelLoanButton } from "@/components/me/CancelLoanButton";
import { ModuleDisabled } from "@/components/ModuleDisabled";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { StatusBadge } from "@/components/ui";

// `/me/loans` — the employee's own loans (wave E).
//
// One live loan at a time is enforced server-side, so the request form hides itself while a pending
// or active loan exists rather than offering a button that returns a 400.

export default async function MyLoansPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  if (!(await isModuleOnForActiveCompany("hr"))) {
    return <ModuleDisabled module="hr" label="HR" />;
  }

  const { loans, unavailable } = await listLoans(userId, tenant, { subjectUserId: userId });
  if (unavailable) return <ModuleDisabled module="hr" label="HR" />;

  const live = loans.find((l) => l.status === "pending" || l.status === "approved") ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        {live ? (
          <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--erp-ink-50)" }}>
            {live.status === "pending"
              ? "Your loan request is awaiting a decision. You can request another once this one is decided."
              : "You have an active loan. A new request can be made once it is fully repaid."}
          </p>
        ) : (
          <LoanRequestForm request={requestLoan} companyId={tenant} />
        )}
      </div>

      {loans.length === 0 ? (
        <EmptyNote>You have not requested a loan in this company.</EmptyNote>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {loans.map((l) => {
            const pct = repaidPercent(l.summary);
            return (
              <div key={l.id} style={{ border: "0.5px solid var(--erp-hairline)", padding: "16px 18px" }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Link href={`/me/loans/${l.id}`} style={{ textDecoration: "none" }}>
                      <p style={{ margin: 0, font: "500 15px var(--font-body)", color: "var(--erp-ink)" }}>
                        {money(l.principalAmount, l.currency)} over {l.termMonths} months
                        {l.annualInterestRate > 0 ? ` · ${l.annualInterestRate}% p.a.` : " · interest-free"}
                      </p>
                    </Link>
                    <p style={{ margin: "5px 0 0", font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
                      Requested {loanDate(l.createdAt)}
                      {l.purpose ? ` · ${l.purpose}` : ""}
                    </p>
                  </div>
                  <StatusBadge label={l.status} />
                  {l.status === "pending" && <CancelLoanButton tenantId={tenant} loanId={l.id} />}
                </div>

                {/* Only an approved/settled loan has a schedule to report against. */}
                {(l.status === "approved" || l.status === "settled") && (
                  <div style={{ marginTop: 14 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 6 }}>
                      <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
                        {money(l.summary.totalPaid, l.currency)} repaid of {money(l.summary.totalPayable, l.currency)}
                        {l.summary.totalInterest > 0 ? ` (incl. ${money(l.summary.totalInterest, l.currency)} interest)` : ""}
                      </span>
                      <span style={{ font: "500 12px var(--font-body)", color: "var(--erp-ink)" }}>
                        {l.summary.settled ? "Settled" : `${money(l.summary.outstanding, l.currency)} left`}
                      </span>
                    </div>
                    <div
                      role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
                      aria-label="Loan repaid"
                      style={{ height: 4, background: "var(--erp-hairline)" }}
                    >
                      <div style={{ width: `${pct}%`, height: "100%", background: "var(--erp-ink)" }} />
                    </div>
                    <p style={{ margin: "8px 0 0", font: "400 12px var(--font-body)", color: l.summary.overdueCount > 0 ? "var(--status-critical-fg)" : "var(--erp-ink-50)" }}>
                      {l.summary.overdueCount > 0
                        ? `${l.summary.overdueCount} instalment${l.summary.overdueCount === 1 ? "" : "s"} overdue — ${money(l.summary.overdueAmount, l.currency)}`
                        : l.summary.nextDue
                          ? `Next ${money(l.summary.nextDue.totalDue, l.currency)} due ${loanDate(l.summary.nextDue.dueOn)}`
                          : "Fully repaid."}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
