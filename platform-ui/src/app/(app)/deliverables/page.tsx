import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listDeliverables, listProjects, listClients } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { DataTable, type Column } from "@/components/data/DataTable";

const COLUMNS: Column[] = [
  { key: "name", header: "Deliverable", sortable: true },
  { key: "project", header: "Project", sortable: true },
  { key: "client", header: "Client", sortable: true },
  { key: "status", header: "Status", format: "status", sortable: true },
  { key: "due_date", header: "Due", format: "date", sortable: true, align: "right" },
];

export default async function DeliverablesPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (<><PageHeader eyebrow="Business" title="Deliverables" /><EmptyNote>Select a company from the top bar.</EmptyNote></>);
  }

  const [deliverables, projects, clients] = await Promise.all([
    listDeliverables(userId, tenant), listProjects(userId, tenant).catch(() => []), listClients(userId, tenant),
  ]);
  const proj = new Map(projects.map((p) => [p.id, p.name]));
  const cli = new Map(clients.map((c) => [c.id, c.name]));
  const rows = deliverables.map((d) => ({
    id: d.id, name: d.name,
    project: d.project_id ? proj.get(d.project_id) ?? "—" : "—",
    client: d.client_id ? cli.get(d.client_id) ?? "—" : "—",
    status: d.status, due_date: d.due_date,
  }));

  return (
    <>
      <PageHeader
        eyebrow="Business"
        title="Deliverables"
        subtitle="Client-facing outputs across projects."
        actions={can(me, "pm.manage", tenant) ? <Link href="/deliverables/new" className="lux-btn lux-btn--solid lux-btn--sm">New deliverable</Link> : undefined}
      />
      {deliverables.length === 0 ? (
        <Card><EmptyNote>No deliverables yet.</EmptyNote></Card>
      ) : (
        <DataTable columns={COLUMNS} rows={rows} csvName="deliverables" pageSize={20} />
      )}
    </>
  );
}
