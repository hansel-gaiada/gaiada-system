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
// One job (DW-8d, "Me is personal admin"): AT A GLANCE, the handful of numbers an employee opens the ERP
// to check — anything of theirs awaiting a decision, what they owe, what is unread — each linking to its
// page. The door-card grid is gone: every door has a home in the sidebar (plan §10). The one link kept is
// "Your employee page", quiet, under the strip.
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <p style={{ margin: 0, font: "400 13px var(--font-body)" }}>
        <Link href={`/people/${userId}`} style={{ color: "var(--erp-ink-50)" }}>Your employee page</Link>
      </p>
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
    </div>
  );
}
