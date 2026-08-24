import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getAnalytics, formatRate, minutesToDays } from "@/lib/hr-full";
import { Card, KpiTile, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

// HR › Analytics — headcount, movement, turnover, tenure and absence (HR-FULL wave A).
//
// Every figure here is derived from `hr_job_events`, the append-only lifecycle log, rather than from
// the `employees` table. That is not an implementation detail: the employee row only knows the
// PRESENT, and turnover is a question about a WINDOW. Before the log existed, "how many people left
// last quarter" was unanswerable from this database at all.
export default async function HrAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const { from, to } = await searchParams;
  const a = await getAnalytics(userId, tenant, from, to);
  if (!a) {
    return <EmptyNote>HR analytics are unavailable for this company — the HR module may not be enabled or served here.</EmptyNote>;
  }

  const statusRows = Object.entries(a.headcountByStatus);
  const movementRows = Object.entries(a.movementByType).sort((x, y) => y[1] - x[1]);

  return (
    <>
      <p style={{ margin: "0 0 16px", font: "400 13px var(--font-body)", color: "var(--erp-ink-60)" }}>
        Window {a.window.from} → {a.window.to}. Headcount at the window edges is reconstructed from the
        lifecycle log (hires and rehires on or before the edge, less terminations), so it answers for the
        window rather than for today.
      </p>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile label="Headcount now" value={String(a.headcountByStatus.active ?? 0)} foot="active employees" />
        <KpiTile
          label="Movement"
          value={`${a.headcountAtStart} → ${a.headcountAtEnd}`}
          foot="start → end of window"
        />
        <KpiTile label="Leavers" value={String(a.leavers)} foot="terminations in window" />
        <KpiTile
          label="Turnover"
          value={formatRate(a.turnoverRatePct)}
          // NULL rather than 0% when there is nobody to divide by. "No meaningful rate" and "nobody
          // left" are different answers and this program has shipped the wrong one before.
          foot={a.turnoverRatePct === null ? "no average headcount to divide by" : "leavers / average headcount"}
        />
      </div>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", marginBottom: 22 }}>
        <Card title="Headcount by status">
          {statusRows.length === 0 ? (
            <EmptyNote>No employee records.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Status" }, { label: "People", align: "right" }]}
              rows={statusRows.map(([k, v]) => [k.replace(/_/g, " "), String(v)])}
            />
          )}
        </Card>

        <Card title="Tenure" hint="Active employees only. Median is the honest headline; a mean is skewed by one long-serving founder.">
          <HairlineTable
            columns={[{ label: "Measure" }, { label: "Years", align: "right" }]}
            rows={[
              ["Median", a.tenureYears.median === null ? "—" : a.tenureYears.median.toFixed(1)],
              ["Mean", a.tenureYears.mean === null ? "—" : a.tenureYears.mean.toFixed(1)],
            ]}
          />
        </Card>
      </div>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", marginBottom: 22 }}>
        <Card title="Lifecycle movement in window">
          {movementRows.length === 0 ? (
            <EmptyNote>
              No lifecycle events in this window. Every hire, promotion, transfer and termination writes one —
              an empty log here means nothing moved, not that the history is missing.
            </EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Event" }, { label: "Count", align: "right" }]}
              rows={movementRows.map(([k, v]) => [k.replace(/_/g, " "), String(v)])}
            />
          )}
        </Card>

        <Card title="Absence in window" hint="Approved leave overlapping the window, by type.">
          {a.absenceByType.length === 0 ? (
            <EmptyNote>No approved leave overlapping this window.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Type" }, { label: "Requests", align: "right" }, { label: "Days", align: "right" }]}
              rows={a.absenceByType.map((r) => [r.leaveType, String(r.requests), minutesToDays(r.minutes)])}
            />
          )}
        </Card>
      </div>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
        <Card title="Open cases by kind">
          {Object.keys(a.openCasesByKind).length === 0 ? (
            <EmptyNote>No open cases.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Kind" }, { label: "Open", align: "right" }]}
              rows={Object.entries(a.openCasesByKind).map(([k, v]) => [k, String(v)])}
            />
          )}
        </Card>

        <Card title="Attendance in window">
          {Object.keys(a.attendanceByStatus).length === 0 ? (
            <EmptyNote>No attendance recorded in this window.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Status" }, { label: "Days", align: "right" }]}
              rows={Object.entries(a.attendanceByStatus).map(([k, v]) => [k, String(v)])}
            />
          )}
        </Card>
      </div>
    </>
  );
}
