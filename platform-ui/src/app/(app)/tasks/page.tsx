import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listAllPmTasks } from "@/lib/pm";
import { listTasks } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { DataTable, type Column } from "@/components/data/DataTable";

type Search = Promise<{ assignee?: string }>;
const COLUMNS: Column[] = [
  { key: "title", header: "Task", sortable: true },
  { key: "project", header: "Project", sortable: true },
  { key: "assignee", header: "Assignee", sortable: true },
  { key: "priority", header: "Priority", sortable: true },
  { key: "progress", header: "Progress", format: "number", sortable: true, align: "right" },
  { key: "status", header: "Status", format: "status", sortable: true, align: "right" },
];

export default async function TasksPage({ searchParams }: { searchParams: Search }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { assignee } = await searchParams;
  const mine = assignee === "me";

  if (!tenant) {
    return (<><PageHeader eyebrow="Business" title="Tasks" /><EmptyNote>Select a company from the top bar.</EmptyNote></>);
  }

  // Prefer the rich PM tasks (unifies with the board/detail); fall back to base tasks.
  let rows: Record<string, unknown>[];
  const pm = await listAllPmTasks(userId, tenant, mine ? { assignee: "me" } : {});
  if (pm.length > 0) {
    rows = pm.map((t) => ({ id: t.id, title: t.title, project: t.projectName, assignee: t.assignee?.responsibleName ?? "Unassigned", priority: t.priority, progress: t.progress, status: t.status }));
  } else {
    const base = await listTasks(userId, tenant).catch(() => []);
    rows = base.map((t) => ({ id: t.id, title: t.title, project: t.project_name, assignee: t.assignee_id ?? "—", priority: t.priority ?? "—", progress: 0, status: t.status ?? "—" }));
  }

  const tab = (label: string, href: string, active: boolean) => (
    <Link href={href} className="lux-btn lux-btn--ghost lux-btn--sm" style={{ textDecoration: "none", ...(active ? { borderColor: "var(--erp-accent)", color: "var(--erp-accent)" } : {}) }}>{label}</Link>
  );

  return (
    <>
      <PageHeader
        eyebrow="Business"
        title="Tasks"
        actions={<Link href="/tasks/new" className="lux-btn lux-btn--solid lux-btn--sm">New task</Link>}
      />
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {tab("All tasks", "/tasks", !mine)}
        {tab("Assigned to me", "/tasks?assignee=me", mine)}
      </div>
      {rows.length === 0 ? (
        <Card><EmptyNote>{mine ? "No tasks assigned to you." : "No tasks yet. Create one under a project."}</EmptyNote></Card>
      ) : (
        <DataTable columns={COLUMNS} rows={rows} link={{ base: "/tasks", idKey: "id", labelKey: "title" }} csvName="tasks" pageSize={25} />
      )}
    </>
  );
}
