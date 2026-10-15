import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listTimeEntries, listProjects } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { Card, KpiTile } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { DataTable, type Column } from "@/components/data/DataTable";
import { TimeEntryForm } from "@/components/forms/ClientWorkForms";
import { logTimeEntryAction } from "@/lib/clientWorkActions";
import { hoursFromMinutes } from "@/lib/format";
import { timesheetView, type TimesheetView as View } from "@/lib/timesheetView";

const COLUMNS: Column[] = [
  { key: "entry_date", header: "Date", format: "date", sortable: true },
  { key: "project", header: "Project", sortable: true },
  { key: "hours", header: "Hours", align: "right", sortable: true },
  { key: "billable", header: "Billable" },
  { key: "notes", header: "Notes" },
];

export default async function TimesheetsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (<><PageHeader eyebrow="Business" title="Timesheets" /><EmptyNote>Select a company from the top bar.</EmptyNote></>);
  }

  const mayViewEveryone = can(me, "reports.department.view", tenant);
  const view = timesheetView((await searchParams).view, mayViewEveryone);
  const [entries, projects] = await Promise.all([
    listTimeEntries(userId, tenant, view === "mine" ? { mine: true } : {}),
    listProjects(userId, tenant).catch(() => []),
  ]);
  const proj = new Map(projects.map((p) => [p.id, p.name]));
  const totalMin = entries.reduce((n, e) => n + (e.minutes ?? 0), 0);
  const billableMin = entries.reduce((n, e) => n + (e.billable ? e.minutes ?? 0 : 0), 0);

  const rows = entries.map((e) => ({
    id: e.id,
    entry_date: e.entry_date,
    project: e.project_id ? proj.get(e.project_id) ?? "—" : "—",
    hours: hoursFromMinutes(e.minutes),
    billable: e.billable ? "Yes" : "No",
    notes: e.notes || "—",
  }));

  const mine = view === "mine";
  const toggle = (v: View, label: string) => (
    <Link
      href={v === "mine" ? "/timesheets" : "/timesheets?view=everyone"}
      className="lux-btn lux-btn--ghost lux-btn--sm"
      aria-current={view === v ? "page" : undefined}
      style={{ textDecoration: "none", ...(view === v ? { borderColor: "var(--erp-accent)", color: "var(--erp-accent)" } : {}) }}
    >{label}</Link>
  );

  return (
    <>
      <PageHeader eyebrow="Business" title="Timesheets" subtitle={mine ? "Your logged time." : "Logged time across the company. Billable hours roll up for invoicing."} />
      {mayViewEveryone && (
        <nav aria-label="Whose time" style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          {toggle("mine", "Mine")}
          {toggle("everyone", "Everyone")}
        </nav>
      )}
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 20 }}>
        <KpiTile
          label="Total logged"
          value={hoursFromMinutes(totalMin)}
          foot={`${entries.length} entries`}
          hint={mine ? "Every time entry you logged in this company, for all time." : "Every time entry in this company, for all time — not this week or this month. Logged by anyone, not only you."}
        />
        <KpiTile label="Billable" value={hoursFromMinutes(billableMin)} foot={totalMin ? `${Math.round((billableMin / totalMin) * 100)}% of logged` : "—"} hint="Time whose entry is flagged billable. This is what invoicing draws on; the flag is set per entry when the time is logged." />
        <KpiTile label="Non-billable" value={hoursFromMinutes(totalMin - billableMin)} />
      </div>

      <Card title="Log time" style={{ marginBottom: 20 }}>
        <TimeEntryForm action={logTimeEntryAction} projects={projects.map((p) => ({ id: p.id, name: p.name }))} />
      </Card>

      {entries.length === 0 ? (
        <EmptyNote>{mine ? "You haven't logged any time yet." : "No time logged yet."}</EmptyNote>
      ) : (
        <DataTable columns={COLUMNS} rows={rows} csvName={mine ? "my-timesheet" : "timesheets"} pageSize={20} />
      )}
    </>
  );
}
