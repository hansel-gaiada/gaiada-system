import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listNotifications } from "@/lib/entities";
import { listLeave, listLeaveBalances } from "@/lib/hr";
import { money } from "@/lib/loans";
import { listLoans } from "@/lib/loans-data";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

// `/me` overview (wave A) — the HOME the seven scattered self-service surfaces never had.
//
// Two jobs, in this order:
//   1. AT A GLANCE: the handful of numbers an employee opens the ERP to check — anything of theirs
//      awaiting a decision, what they owe, what is unread.
//   2. RE-HOME: one labelled door to each surface that already exists elsewhere. These are LINKS,
//      not re-implementations — /timesheets, /reports/person, /appraisals/mine and the employee-360
//      page keep their single implementation and stay reachable from their original nav homes too.
//
// Every read below absence-degrades. `hr` is dark for companies other than the agency, so leave and
// loan reads legitimately return nothing — that must render as a quiet dash, not an error.

/** Absence-degrading wrapper: a 403/404 from a dark module is data, not a failure. */
async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

export default async function MeOverviewPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  if (!tenant) {
    return <EmptyNote>Select a company from the top bar to see your personal hub.</EmptyNote>;
  }

  const [notifications, leave, balances, loanList] = await Promise.all([
    safe(listNotifications(userId, tenant), []),
    safe(listLeave(userId, tenant, { subjectUserId: userId }), []),
    safe(listLeaveBalances(userId, tenant, { subjectUserId: userId }), []),
    safe(listLoans(userId, tenant, { subjectUserId: userId }), { loans: [], scope: "self" as const, unavailable: true }),
  ]);

  const unread = notifications.filter((n) => !n.read_at).length;
  const pendingLeave = leave.filter((l) => l.status === "pending").length;
  // Vacation is the balance an employee actually plans around; the others are shown on /me/leave.
  const vacation = balances.find((b) => b.leaveType === "vacation");
  const vacationLeft = vacation ? Math.max(0, vacation.allocatedMinutes - vacation.usedMinutes) / 480 : null;

  const activeLoan = loanList.loans.find((l) => l.status === "approved") ?? null;
  const pendingLoan = loanList.loans.find((l) => l.status === "pending") ?? null;

  const stats: { label: string; value: string; href: string; hint?: string }[] = [
    {
      label: "Unread",
      value: unread === 0 ? "—" : String(unread),
      href: "/me/inbox",
      hint: unread === 0 ? "Nothing new" : "in your inbox",
    },
    {
      label: "Leave awaiting a decision",
      value: pendingLeave === 0 ? "—" : String(pendingLeave),
      href: "/me/leave",
      hint: vacationLeft !== null ? `${vacationLeft.toFixed(vacationLeft % 1 === 0 ? 0 : 1)} vacation days left` : undefined,
    },
    activeLoan
      ? {
          label: "Loan outstanding",
          value: money(activeLoan.summary.outstanding, activeLoan.currency),
          href: `/me/loans/${activeLoan.id}`,
          hint: activeLoan.summary.nextDue
            ? `Next ${money(activeLoan.summary.nextDue.totalDue, activeLoan.currency)} due ${activeLoan.summary.nextDue.dueOn}`
            : undefined,
        }
      : {
          label: "Loans",
          value: pendingLoan ? "1 pending" : "—",
          href: "/me/loans",
          hint: pendingLoan ? "awaiting a decision" : "No active loan",
        },
  ];

  // The seven surfaces this hub re-homes. `/people/[userId]` is the existing employee-360 page — the
  // viewer is always allowed their own (canViewEmployee: self OR superadmin OR owner).
  const doors: { label: string; href: string; blurb: string }[] = [
    { label: "My work", href: "/", blurb: "Today's tasks, approvals and what needs you." },
    { label: "My employee page", href: `/people/${userId}`, blurb: "Your profile, roles, projects and linked accounts." },
    { label: "My timesheets", href: "/timesheets", blurb: "Log and review your own hours." },
    { label: "My report", href: "/reports/person", blurb: "Your activity and delivery over time." },
    { label: "My appraisals", href: "/appraisals/mine", blurb: "What your manager submitted, verbatim." },
    { label: "Account settings", href: "/account", blurb: "Sign-in, linked identities, preferences." },
    { label: "My leave", href: "/me/leave", blurb: "Request time off and track balances." },
    { label: "My loans", href: "/me/loans", blurb: "Request a loan, follow the repayment schedule." },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        {stats.map((s) => (
          <Link key={s.label} href={s.href} style={{ textDecoration: "none" }}>
            <Card style={{ height: "100%" }}>
              <p style={{
                margin: 0, font: "700 11px var(--font-body)", letterSpacing: "0.08em",
                textTransform: "uppercase", color: "var(--erp-ink-50)",
              }}>
                {s.label}
              </p>
              <p style={{ margin: "10px 0 0", font: "300 26px var(--font-display)", color: "var(--erp-ink)" }}>
                {s.value}
              </p>
              {s.hint && (
                <p style={{ margin: "6px 0 0", font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
                  {s.hint}
                </p>
              )}
            </Card>
          </Link>
        ))}
      </div>

      <section>
        <h2 style={{
          margin: "0 0 12px", font: "700 11px var(--font-body)", letterSpacing: "0.08em",
          textTransform: "uppercase", color: "var(--erp-ink-50)",
        }}>
          Everything of yours
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
          {doors.map((d) => (
            <Link
              key={d.href}
              href={d.href}
              style={{
                textDecoration: "none", border: "0.5px solid var(--erp-hairline)",
                padding: "16px 18px", display: "block",
              }}
            >
              <p style={{ margin: 0, font: "500 14px var(--font-body)", color: "var(--erp-ink)" }}>{d.label}</p>
              <p style={{ margin: "6px 0 0", font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-50)" }}>
                {d.blurb}
              </p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
