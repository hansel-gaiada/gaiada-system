import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getTask, listFiles } from "@/lib/entities";
import { attachFileAction, deleteFileAction } from "@/lib/collabActions";
import { Attachments } from "@/components/Attachments";
import {
  getPmTask, listTaskComments, listSuggestions, assignableUnits, listPmTasks, listTimeLogs,
  openDependencies, timeSummary, wouldCreateCycle, type PmTask,
} from "@/lib/pm";
import {
  setTaskProgress, toggleSubtask, addSubtask, setAssignee, postTaskComment,
  runTracker, confirmSuggestion, dismissSuggestion, addDependency, removeDependency, logTime, deleteTaskAction,
} from "@/lib/pmActions";
import { PageHeader } from "@/components/PageHeader";
import { DescriptionList } from "@/components/DescriptionList";
import { Card, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ProgressControl } from "@/components/pm/ProgressControl";
import { Subtasks } from "@/components/pm/Subtasks";
import { AssigneeEditor } from "@/components/pm/AssigneeEditor";
import { TrackerPanel } from "@/components/pm/TrackerPanel";
import { CommentThread } from "@/components/pm/CommentThread";
import { Dependencies } from "@/components/pm/Dependencies";
import { TimeLog } from "@/components/pm/TimeLog";

export default async function TaskDetailPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) notFound();

  const task = await getPmTask(userId, tenant, taskId);

  // Fallback: a task the PM store doesn't have (e.g. base-only) — minimal view.
  if (!task) {
    const base = await getTask(userId, tenant, taskId).catch(() => null);
    if (!base) notFound();
    return (
      <>
        <PageHeader eyebrow="Task" title={base.title} />
        <DescriptionList items={[
          { label: "Project", value: <Link href={`/projects/${base.project_id}`}>{base.project_name}</Link> },
          { label: "Status", value: <StatusBadge label={base.status ?? "—"} /> },
          { label: "Assignee", value: base.assignee_name ?? "Unassigned" },
        ]} />
        <div style={{ marginTop: 16 }}><EmptyNote>Rich PM features appear once this task is in the PM system.</EmptyNote></div>
      </>
    );
  }

  const [comments, suggestions, assignable, projectTasks, timeLogs, files] = await Promise.all([
    listTaskComments(userId, tenant, taskId),
    listSuggestions(userId, tenant, taskId),
    assignableUnits(userId, tenant),
    listPmTasks(userId, tenant, task.projectId),
    listTimeLogs(userId, tenant, taskId),
    listFiles(userId, tenant, "task", taskId),
  ]);
  const canEdit = true; // signed-in members; backend RLS is the real boundary

  // Dependencies: current blockers (resolved), still-open ones, and cycle-safe options.
  const byId = new Map<string, PmTask>(projectTasks.map((t) => [t.id, t]));
  const currentDeps = task.dependsOn
    .map((id) => byId.get(id))
    .filter((d): d is PmTask => !!d)
    .map((d) => ({ id: d.id, title: d.title, status: d.status, done: d.status === "done" }));
  const openDeps = openDependencies(task, byId);
  const depOptions = projectTasks
    .filter((o) => o.id !== task.id && !task.dependsOn.includes(o.id) && !wouldCreateCycle(projectTasks, task.id, o.id))
    .map((o) => ({ id: o.id, title: o.title }));
  const time = timeSummary(timeLogs);

  const meta: { label: string; value: ReactNode }[] = [
    { label: "Project", value: <Link href={`/projects/${task.projectId}`}>{task.projectName}</Link> },
    { label: "Status", value: <StatusBadge label={task.status} /> },
    { label: "Priority", value: task.priority },
    { label: "Due date", value: task.dueDate ?? "—" },
  ];
  const responsibleId = task.assignee?.responsibleId;

  return (
    <>
      <PageHeader
        eyebrow="Task"
        title={task.title}
        subtitle={task.projectName}
        actions={
          <>
            <Link href={`/tasks/${task.id}/edit`} className="lux-btn lux-btn--ghost lux-btn--sm">Edit</Link>
            {canEdit && <form action={deleteTaskAction.bind(null, task.id, task.projectId)}><button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Delete</button></form>}
          </>
        }
      />

      {openDeps.length > 0 && (
        <p style={{ margin: "0 0 16px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="pm-blocked-chip">Blocked by {openDeps.length}</span>
          <span style={{ font: "400 13px var(--font-body)", color: "var(--erp-ink-60)" }}>
            Waiting on: {openDeps.map((d) => d.title).join(", ")}
          </span>
        </p>
      )}

      <div style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <Card title="Overview">
          <DescriptionList items={meta} />
          <div style={{ marginTop: 14 }}>
            <span className="type-eyebrow" style={{ fontSize: 10, opacity: 0.5, display: "block", marginBottom: 8 }}>Progress</span>
            <ProgressControl taskId={task.id} value={task.progress} canEdit={canEdit} save={setTaskProgress} />
          </div>
          {task.description && (
            <p style={{ margin: "14px 0 0", font: "400 13px/1.6 var(--font-body)", color: "var(--text-primary)", whiteSpace: "pre-wrap" }}>{task.description}</p>
          )}
        </Card>

        <Card title="Assignee">
          {task.assignee ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ font: "400 14px var(--font-body)", color: "var(--text-primary)" }}>
                {task.assignee.kind === "person" ? "Person" : task.assignee.kind === "department" ? "Department" : "Division"}: <b>{task.assignee.refName}</b>
              </div>
              <div style={{ font: "400 13px var(--font-body)", color: "var(--erp-ink-60)" }}>
                In charge:{" "}
                {responsibleId ? <Link href={`/people/${responsibleId}`}>{task.assignee.responsibleName}</Link> : "—"}
              </div>
            </div>
          ) : (
            <p style={{ margin: "0 0 12px", font: "400 13px var(--font-body)", color: "var(--erp-ink-50)" }}>Unassigned.</p>
          )}
          {canEdit && (
            <div style={{ marginTop: 12 }}>
              <AssigneeEditor label={task.assignee ? "Reassign" : "Assign"} assignable={assignable} current={task.assignee} save={setAssignee.bind(null, task.id)} />
            </div>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title={`Subtasks${task.subtasks.length ? ` · ${task.subtasks.filter((s) => s.done).length}/${task.subtasks.length}` : ""}`}>
          <Subtasks subtasks={task.subtasks} canEdit={canEdit} toggle={toggleSubtask.bind(null, task.id)} add={addSubtask.bind(null, task.id)} />
        </Card>
      </div>

      <div style={{ marginTop: 20, display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <Card title="Dependencies">
          <Dependencies
            current={currentDeps}
            options={depOptions}
            canEdit={canEdit}
            add={addDependency.bind(null, task.id)}
            remove={removeDependency.bind(null, task.id)}
          />
        </Card>
        <Card title="Time">
          <TimeLog
            logs={timeLogs}
            loggedMinutes={task.loggedMinutes}
            estimateMinutes={task.estimateMinutes}
            billableMinutes={time.billable}
            canEdit={canEdit}
            log={logTime.bind(null, task.id)}
          />
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title="AI Tracker">
          <TrackerPanel
            taskId={task.id}
            suggestions={suggestions}
            canAct={canEdit}
            run={runTracker}
            confirm={confirmSuggestion.bind(null, task.id)}
            dismiss={dismissSuggestion.bind(null, task.id)}
          />
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title={`Attachments${files.length ? ` · ${files.length}` : ""}`}>
          <Attachments files={files} canEdit={canEdit} attach={attachFileAction.bind(null, "task", task.id)} remove={deleteFileAction.bind(null, "task", task.id)} />
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title="Comments & activity">
          <CommentThread comments={comments} post={postTaskComment.bind(null, task.id)} />
        </Card>
      </div>
    </>
  );
}
