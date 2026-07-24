import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getTask, listFiles, getFieldDefs } from "@/lib/entities";
import { attachFileAction, deleteFileAction } from "@/lib/collabActions";
import { Attachments } from "@/components/Attachments";
import {
  getPmTask, listTaskComments, listSuggestions, assignableUnits, listPmTasks, listTimeLogs, listTags,
  listProjectStatuses, listFollowers, openDependencies, isDoneStatus, timeSummary, wouldCreateCycle, titleWithRecurrenceGlyph, resolveTags, type PmTask,
} from "@/lib/pm";
import {
  setTaskProgress, toggleSubtask, addSubtask, setAssignee, postTaskComment,
  runTracker, confirmSuggestion, dismissSuggestion, addDependency, removeDependency, logTime, deleteTaskAction,
  setTaskTags, createTag, updateTaskCustomFields, setTaskStatus, undoRecurrenceSpawn,
  duplicateTaskAction, saveTaskAsTemplateAction, followTask, unfollowTask, addReaction, removeReaction,
} from "@/lib/pmActions";
import { StatusSelect } from "@/components/pm/StatusSelect";
import { PageHeader } from "@/components/PageHeader";
import { DescriptionList } from "@/components/DescriptionList";
import { Card, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ProgressControl } from "@/components/pm/ProgressControl";
import { Subtasks } from "@/components/pm/Subtasks";
import { AssigneeEditor } from "@/components/pm/AssigneeEditor";
import { TrackerPanel } from "@/components/pm/TrackerPanel";
import { CommentThread, FollowToggle } from "@/components/pm/CommentThread";
import { Dependencies } from "@/components/pm/Dependencies";
import { TimeLog } from "@/components/pm/TimeLog";
import { TagEditor } from "@/components/pm/TagEditor";
import { TaskCustomFields } from "@/components/pm/TaskCustomFields";

// The full task detail body (extracted out of the standalone `/tasks/[taskId]`
// route, P1-06, design spec §5) so it can be mounted BOTH there and nested
// inside a department console
// (`/departments/[deptId]/projects/[projectId]/tasks/[taskId]`) with
// identical behaviour. The caller owns the breadcrumb's first hop
// (`backHref`/`backLabel`) and any auth/tenant guard + cross-dept ownership
// check around the mount point; this component re-resolves its own
// userId/tenant (same pattern as `ProjectWorkspaceView`, P1-05).
export async function TaskDetailView({
  taskId,
  backHref,
  backLabel,
}: {
  taskId: string;
  backHref: string;
  backLabel: string;
}) {
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
        <PageHeader eyebrow="Task" title={base.title} breadcrumbs={[{ label: backLabel, href: backHref }, { label: base.title }]} />
        <DescriptionList items={[
          { label: "Project", value: <Link href={`/projects/${base.project_id}`}>{base.project_name}</Link> },
          { label: "Status", value: <StatusBadge label={base.status ?? "—"} /> },
          { label: "Assignee", value: base.assignee_name ?? "Unassigned" },
        ]} />
        <div style={{ marginTop: 16 }}><EmptyNote>Rich PM features appear once this task is in the PM system.</EmptyNote></div>
      </>
    );
  }

  const [comments, suggestions, assignable, projectTasks, timeLogs, files, tagRegistry, customFieldDefs, projectStatuses, followers] = await Promise.all([
    listTaskComments(userId, tenant, taskId),
    listSuggestions(userId, tenant, taskId),
    assignableUnits(userId, tenant),
    listPmTasks(userId, tenant, task.projectId),
    listTimeLogs(userId, tenant, taskId),
    listFiles(userId, tenant, "task", taskId),
    listTags(userId, tenant, task.projectId),
    getFieldDefs(userId, tenant, "pm_task"),
    listProjectStatuses(userId, tenant, task.projectId),
    listFollowers(userId, tenant, taskId),
  ]);
  const canEdit = true; // signed-in members; backend RLS is the real boundary
  const statusLabel = (id: string) => projectStatuses.find((s) => s.id === id)?.label ?? id;

  // Dependencies: current blockers (resolved), still-open ones, and cycle-safe options.
  const byId = new Map<string, PmTask>(projectTasks.map((t) => [t.id, t]));
  const currentDeps = task.dependsOn
    .map((id) => byId.get(id))
    .filter((d): d is PmTask => !!d)
    .map((d) => ({ id: d.id, title: d.title, status: statusLabel(d.status), done: isDoneStatus(d.status, projectStatuses) }));
  const openDeps = openDependencies(task, byId, projectStatuses);
  const depOptions = projectTasks
    .filter((o) => o.id !== task.id && !task.dependsOn.includes(o.id) && !wouldCreateCycle(projectTasks, task.id, o.id))
    .map((o) => ({ id: o.id, title: o.title }));
  const time = timeSummary(timeLogs);

  const meta: { label: string; value: ReactNode }[] = [
    { label: "Project", value: <Link href={`/projects/${task.projectId}`}>{task.projectName}</Link> },
    {
      label: "Status",
      value: (
        <StatusSelect
          current={task.status}
          statuses={projectStatuses.map((s) => ({ id: s.id, label: s.label, color: s.color }))}
          canEdit={canEdit}
          save={setTaskStatus.bind(null, task.id)}
          undoSpawn={task.recurrence ? undoRecurrenceSpawn.bind(null, task.projectId) : undefined}
        />
      ),
    },
    { label: "Priority", value: task.priority },
    { label: "Due date", value: task.dueDate ?? "—" },
  ];
  const responsibleId = task.assignee?.responsibleId;

  // P3-03: "Save as template" captures the task's current fields (tags resolved
  // to plain labels — a template is tenant-wide, so it can't hold this
  // project's tag IDS) into a new task template.
  const templateInput = {
    title: task.title,
    description: task.description || undefined,
    priority: task.priority,
    estimateMinutes: task.estimateMinutes ?? undefined,
    subtasks: task.subtasks.map((s) => s.title),
    tagLabels: resolveTags(task.tags, tagRegistry).map((tg) => tg.label),
  };

  return (
    <>
      <PageHeader
        eyebrow="Task"
        title={titleWithRecurrenceGlyph(task)}
        subtitle={task.projectName}
        breadcrumbs={[{ label: backLabel, href: backHref }, { label: task.title }]}
        actions={
          <>
            <FollowToggle
              me={{ id: userId, name: me.name }}
              followers={followers}
              follow={followTask.bind(null, task.id)}
              unfollow={unfollowTask.bind(null, task.id)}
            />
            <Link href={`/tasks/${task.id}/edit`} className="lux-btn lux-btn--ghost lux-btn--sm">Edit</Link>
            {canEdit && (
              <form action={duplicateTaskAction.bind(null, task.id)}>
                <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Duplicate</button>
              </form>
            )}
            {canEdit && (
              <form action={saveTaskAsTemplateAction.bind(null, templateInput)}>
                <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Save as template</button>
              </form>
            )}
            {canEdit && <form action={deleteTaskAction.bind(null, task.id, task.projectId)}><button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Delete</button></form>}
          </>
        }
      />

      <div style={{ margin: "0 0 16px" }}>
        <TagEditor
          registry={tagRegistry}
          selected={task.tags}
          canEdit={canEdit}
          setTags={setTaskTags.bind(null, task.id)}
          createTag={createTag.bind(null, task.projectId)}
        />
      </div>

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

      {customFieldDefs.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <Card title="Custom fields">
            <TaskCustomFields
              taskId={task.id}
              defs={customFieldDefs}
              values={task.customFields}
              canEdit={canEdit}
              save={updateTaskCustomFields}
            />
          </Card>
        </div>
      )}

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
          <CommentThread
            comments={comments}
            post={postTaskComment.bind(null, task.id)}
            addReaction={addReaction}
            removeReaction={removeReaction}
          />
        </Card>
      </div>
    </>
  );
}
