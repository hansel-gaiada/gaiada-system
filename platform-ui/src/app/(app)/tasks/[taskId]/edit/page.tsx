import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getFieldDefs, getTask, listMembers } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { TaskForm } from "@/components/forms/TaskForm";
import { updateTask } from "../../actions";

export default async function EditTaskPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) notFound();

  const task = await getTask(userId, tenant, taskId);
  if (!task) notFound();

  const [defs, members] = await Promise.all([getFieldDefs(userId, tenant, "task"), listMembers(userId, tenant)]);

  return (
    <>
      <PageHeader eyebrow="Task" title={`Edit ${task.title}`} />
      <TaskForm action={updateTask.bind(null, taskId)} defs={defs} members={members} task={task} />
      <p style={{ marginTop: 16, font: "400 13px var(--font-body)", color: "rgba(26,25,22,.55)" }}>
        Saving requires the task-update backend endpoint (pending).
      </p>
    </>
  );
}
