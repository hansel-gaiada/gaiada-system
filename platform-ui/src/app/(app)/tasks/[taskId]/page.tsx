import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getTask } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { DescriptionList } from "@/components/DescriptionList";
import { Card, StatusBadge } from "@/components/ui";

export default async function TaskDetailPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) notFound();

  let task;
  try {
    task = await getTask(userId, tenant, taskId);
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) {
      return (
        <>
          <PageHeader eyebrow="Task" title="Task" />
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
  if (!task) notFound();

  const items: { label: string; value: ReactNode }[] = [
    { label: "Project", value: <Link href={`/projects/${task.project_id}`}>{task.project_name}</Link> },
    { label: "Status", value: <StatusBadge label={task.status ?? "—"} /> },
    { label: "Priority", value: task.priority ?? "—" },
    { label: "Assignee", value: task.assignee_name ?? "Unassigned" },
    { label: "Due date", value: task.due_date ?? "—" },
    ...Object.entries(task.custom_fields ?? {}).map(([key, value]) => ({
      label: key,
      value: value == null || value === "" ? "—" : String(value),
    })),
  ];

  return (
    <>
      <PageHeader
        eyebrow="Task"
        title={task.title}
        actions={
          <Link href={`/tasks/${task.id}/edit`} className="lux-btn lux-btn--ghost lux-btn--sm">
            Edit
          </Link>
        }
      />
      <DescriptionList items={items} />
    </>
  );
}
