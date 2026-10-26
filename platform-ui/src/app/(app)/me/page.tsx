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
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { readResult, type ReadResult } from "@/lib/readResult";

// `/me` overview (wave A) — the HOME the seven scattered self-service surfaces never had.
//
// One job (DW-8d, "Me is personal admin"): AT A GLANCE, the handful of numbers an employee opens the ERP
// to check — anything of theirs awaiting a decision, what they owe, what is unread — each linking to its
// page. The door-card grid is gone: every door has a home in the sidebar (plan §10). The one link kept is
// "Your employee page", quiet, under the strip.
//
// Every read below goes through `readResult` (AGN-3 / readiness-bar criterion 5). `hr` is dark for
// companies other than the agency, so a 404 on the leave reads legitimately means "none here" and
// renders as a quiet dash (`absentAsEmpty`). A 403 or any other failure is NOT emptiness: the stat
// says it could not be read and an explicit <ReadRefusal> names the read, never "Nothing new".

export default async function MeOverviewPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  if (!tenant) {
    return <EmptyNote>Select a company from the top bar to see your personal hub.</EmptyNote>;
  }

  const [notifR, leaveR, balancesR, loansR] = await Promise.all([
    readResult(listNotifications(userId, tenant)),
    readResult(listLeave(userId, tenant, { subjectUserId: userId }), { absentAsEmpty: [] }),
    readResult(listLeaveBalances(userId, tenant, { subjectUserId: userId }), { absentAsEmpty: [] }),
    readResult(listLoans(userId, tenant, { subjectUserId: userId })),
  ]);

  const refusals: { subject: string; r: ReadResult<unknown> }[] = [
    { subject: "your notifications", r: notifR },
    { subject: "your leave requests", r: leaveR },
    { subject: "your leave balances", r: balancesR },
    { subject: "your loans", r: loansR },
  ];

  const notifications = notifR.kind === "ok" ? notifR.data : [];
  const leave = leaveR.kind === "ok" ? leaveR.data : [];
  const balances = balancesR.kind === "ok" ? balancesR.data : [];
  const loanList = loansR.kind === "ok" ? loansR.data : { loans: [], scope: "self" as const, unavailable: false };

  const unread = notifications.filter((n) => !n.read_at).length;
  const pendingLeave = leave.filter((l) => l.status === "pending").length;
  // Vacation is the balance an employee actually plans around; the others are shown on /me/leave.
  const vacation = balances.find((b) => b.leaveType === "vacation");
  const vacationLeft = vacation ? Math.max(0, vacation.allocatedMinutes - vacation.usedMinutes) / 480 : null;

  const activeLoan = loanList.loans.find((l) => l.status === "approved") ?? null;
  const pendingLoan = loanList.loans.find((l) => l.status === "pending") ?? null;
  const NOT_SHOWN = "Not shown";

  const stats: { label: string; value: string; href: string; hint?: string }[] = [
    {
      label: "Unread",
      value: notifR.kind !== "ok" ? NOT_SHOWN : unread === 0 ? "—" : String(unread),
      href: "/me/inbox",
      hint: notifR.kind !== "ok" ? "could not be read" : unread === 0 ? "Nothing new" : "in your inbox",
    },
    {
      label: "Leave awaiting a decision",
      value: leaveR.kind !== "ok" ? NOT_SHOWN : pendingLeave === 0 ? "—" : String(pendingLeave),
      href: "/me/leave",
      hint: leaveR.kind !== "ok" ? "could not be read" : vacationLeft !== null ? `${vacationLeft.toFixed(vacationLeft % 1 === 0 ? 0 : 1)} vacation days left` : undefined,
    },
    loansR.kind !== "ok"
      ? { label: "Loans", value: NOT_SHOWN, href: "/me/loans", hint: "could not be read" }
      : activeLoan
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
      {refusals.map(({ subject, r }) =>
        r.kind === "ok" ? null : (
          <ReadRefusal key={subject} subject={subject} kind={r.kind} reason={r.kind === "unavailable" ? r.reason : undefined} inline />
        ),
      )}
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
