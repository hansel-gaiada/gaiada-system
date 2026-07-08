import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getProject, listProjectTasks } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { DescriptionList } from "@/components/DescriptionList";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";

const TASK_COLUMNS = [{ label: "Title" }, { label: "Status" }, { label: "Assignee" }, { label: "Due date", align: "right" as const }];
const TASK_TCOLS = "2fr 1fr 1fr 1fr";

export default async function ProjectDetailPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) notFound();

  let project;
  try {
    project = await getProject(userId, tenant, projectId);
  } catch (e) {
    if (e instanceof PlatformError && e.status === 404) notFound();
    if (e instanceof PlatformError && e.status === 403) {
      return (
        <>
          <PageHeader eyebrow="Project" title="Project" />
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

  const tasks = await listProjectTasks(userId, tenant, projectId);

  const items: { label: string; value: ReactNode }[] = [
    { label: "Status", value: <StatusBadge label={project.status} /> },
    { label: "Client", value: project.client_name ?? (project.is_internal ? "Internal" : "—") },
    { label: "Owner", value: project.owner_name ?? "—" },
    { label: "Start date", value: project.start_date ?? "—" },
    { label: "Due date", value: project.due_date ?? "—" },
    ...Object.entries(project.custom_fields ?? {}).map(([key, value]) => ({
      label: key,
      value: value == null || value === "" ? "—" : String(value),
    })),
  ];

  return (
    <>
      <PageHeader
        eyebrow="Project"
        title={project.name}
        actions={
          <Link href={`/projects/${project.id}/edit`} className="lux-btn lux-btn--ghost lux-btn--sm">
            Edit
          </Link>
        }
      />
      <DescriptionList items={items} />
      <div style={{ marginTop: 28 }}>
        <Card title="Tasks">
          {tasks.length === 0 ? (
            <div className="dash-empty">
              <p>No tasks on this project yet.</p>
            </div>
          ) : (
            <HairlineTable
              tcols={TASK_TCOLS}
              columns={TASK_COLUMNS}
              rows={tasks.map((t) => [
                t.title,
                <StatusBadge key={`${t.id}-status`} label={t.status ?? "—"} />,
                t.assignee_id ?? "—",
                t.due_date ?? "—",
              ])}
            />
          )}
        </Card>
      </div>
    </>
  );
}
