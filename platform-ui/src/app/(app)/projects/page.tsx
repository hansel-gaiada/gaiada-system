import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listMembers, listProjects, type Member, type Project } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { DataTable, type Column } from "@/components/data/DataTable";

const COLUMNS: Column[] = [
  { key: "name", header: "Name", sortable: true },
  { key: "status", header: "Status", format: "status", sortable: true },
  { key: "due_date", header: "Due date", format: "date", sortable: true },
  { key: "owner", header: "Owner", sortable: true, align: "right" },
];

export default async function ProjectsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  let projects: Project[];
  let members: Member[];
  try {
    [projects, members] = tenant
      ? await Promise.all([listProjects(userId, tenant), listMembers(userId, tenant)])
      : [[], []];
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) {
      return (
        <>
          <PageHeader eyebrow="Business" title="Projects" />
          <Card>
            <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "rgba(26,25,22,.62)" }}>
              You don&apos;t have access to this in the current company.
            </p>
          </Card>
        </>
      );
    }
    throw e;
  }
  const ownerName = new Map(members.map((m) => [m.user_id, m.name]));
  const rows = projects.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    due_date: p.due_date,
    owner: (p.owner_id && ownerName.get(p.owner_id)) ?? "—",
  }));

  return (
    <>
      <PageHeader
        eyebrow="Business"
        title="Projects"
        actions={<Link href="/projects/new" className="lux-btn lux-btn--solid lux-btn--sm">New project</Link>}
      />
      {projects.length === 0 ? (
        <Card><EmptyNote>No projects yet. Create the first project to get started.</EmptyNote></Card>
      ) : (
        <DataTable columns={COLUMNS} rows={rows} link={{ base: "/projects", idKey: "id", labelKey: "name" }} csvName="projects" pageSize={20} />
      )}
    </>
  );
}
