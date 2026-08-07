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
  listProjectStatuses, listFollowers, listAssignmentHistory, openDependencies, reachableStatusIds,
  isDoneStatus, timeSummary, wouldCreateCycle, titleWithRecurrenceGlyph, resolveTags, taskUrgency, type PmTask,
} from "@/lib/pm";
import {
  setTaskProgress, toggleSubtask, addSubtask, setAssignee, postTaskComment,
  runTracker, confirmSuggestion, dismissSuggestion, addDependency, removeDependency, logTime, deleteTaskAction,
  setTaskTags, createTag, updateTaskCustomFields, setTaskStatus, undoRecurrenceSpawn,
  duplicateTaskAction, saveTaskAsTemplateAction, followTask, unfollowTask, addReaction, removeReaction,
  addContributor, removeContributor, reassignResponsible, setBallToMe, rescheduleTask,
} from "@/lib/pmActions";
import { PM_TERMS } from "@/lib/pmVocabulary";
import { StatusSelect } from "@/components/pm/StatusSelect";
import { PageHeader } from "@/components/PageHeader";
import { DescriptionList } from "@/components/DescriptionList";
import { StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ProgressControl } from "@/components/pm/ProgressControl";
import { Subtasks } from "@/components/pm/Subtasks";
import { AssigneeEditor } from "@/components/pm/AssigneeEditor";
import { TrackerPanel } from "@/components/pm/TrackerPanel";
import { CommentThread, FollowToggle, SetToMeButton, TodayScheduleButton } from "@/components/pm/CommentThread";
import { UrgencyChip } from "@/components/pm/UrgencyChip";
import { Dependencies } from "@/components/pm/Dependencies";
import { Contributors } from "@/components/pm/Contributors";
import { TimeLog } from "@/components/pm/TimeLog";
import { TagEditor } from "@/components/pm/TagEditor";
import { TaskCustomFields } from "@/components/pm/TaskCustomFields";
import { Prop, Section } from "@/components/pm/Section";
import "./task-detail.css";

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
  chrome = "page",
}: {
  taskId: string;
  backHref: string;
  backLabel: string;
  /** "page" renders the standard PageHeader + breadcrumbs. "drawer" renders the compact heading the
   *  slide-over needs (code · title · project, actions beneath) — the drawer shell owns the close
   *  control and the scroll container, so the header here must not repeat them. */
  chrome?: "page" | "drawer";
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

  const [comments, suggestions, assignable, projectTasks, timeLogs, files, tagRegistry, customFieldDefs, projectStatuses, followers, assignmentHistory] = await Promise.all([
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
    listAssignmentHistory(userId, tenant, taskId), // P4-B7
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

  // P4-I4: a courtesy mirror of the server-side chain-enforcement gate (P4-I1, built in parallel).
  // Only Backlog/isBlocked/Done stay reachable while blockers are open — everything else is
  // disabled with the reason stated, never a silently dead option. The task's OWN current status
  // is never disabled (a task already sitting somewhere the ladder no longer allows must stay
  // visibly selected, not rendered as a broken control).
  const isBlockedByDeps = openDeps.length > 0;
  const reachable = reachableStatusIds(projectStatuses, isBlockedByDeps);
  const statusOptions = projectStatuses.map((s) => ({
    id: s.id, label: s.label, color: s.color,
    disabled: s.id !== task.status && !reachable.has(s.id),
  }));
  const statusDisabledHint = isBlockedByDeps
    ? `Blocked by ${openDeps.length} open ${openDeps.length === 1 ? "dependency" : "dependencies"} — clear ${openDeps.length === 1 ? "it" : "them"} first.`
    : undefined;

  const responsibleId = task.assignee?.responsibleId;
  const fmtMinutes = (m: number | null) => {
    if (m === null || m === 0) return null;
    const h = Math.floor(m / 60), r = m % 60;
    return h > 0 ? `${h}h${r ? ` ${r}m` : ""}` : `${r}m`;
  };
  // P4-B7: this component is an async Server Component — it renders once server-side with no
  // client-side re-render/hydration of this markup, so a locale-formatted timestamp here cannot
  // diverge the way it would inside a "use client" island (same convention as DocHistory's own
  // `toLocaleString`, just without that component's hydration exposure).
  const fmtWhen = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  // P4-F3: resolved once, server-side, so the "Today" quick-schedule button and the overdue
  // glyph agree on what day it is — same hydration-divergence rule `pmUrgency.ts` pins `today`
  // on (never `Date.now()` inside a client component).
  const today = new Date().toISOString().slice(0, 10);
  const dueUrgency = task.dueDate ? taskUrgency({ dueDate: task.dueDate, isDone: isDoneStatus(task.status, projectStatuses) }, today) : null;

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

  const heading = titleWithRecurrenceGlyph(task);
  const actions = (
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
  );

  return (
    <>
      {chrome === "page" ? (
        <PageHeader
          eyebrow="Task"
          title={task.displayCode ? `${task.displayCode} · ${heading}` : heading}
          breadcrumbs={[{ label: backLabel, href: backHref }, { label: task.title }]}
          actions={actions}
        />
      ) : (
        <div className="pm-detail__head">
          {task.displayCode && <span className="pm-detail__code">{task.displayCode}</span>}
          <h1 className="pm-detail__title">{heading}</h1>
          <Link href={`/projects/${task.projectId}`} className="pm-detail__project">{task.projectName}</Link>
          <div className="pm-detail__actions">{actions}</div>
        </div>
      )}

      {/* Blocked is the one thing that must interrupt: it explains why the work isn't moving, and
          P4-I4 requires each blocker to be named AND linked, not just counted. */}
      {openDeps.length > 0 && (
        <p style={{ margin: "0 0 14px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="pm-blocked-chip">Blocked by {openDeps.length}</span>
          <span style={{ font: "400 13px var(--font-body)", color: "var(--erp-ink-60)" }}>
            Waiting on:{" "}
            {openDeps.map((d, i) => (
              <span key={d.id}>
                {i > 0 && ", "}
                <Link href={`/tasks/${d.id}`} className="pm-detail__link">{d.title}</Link>
              </span>
            ))}
          </span>
        </p>
      )}

      <div className="pm-detail">
        {/* LEFT — the work itself, in the order someone reads it. */}
        <div className="pm-detail__main">
          <Section label="Description">
            {task.description
              ? <p className="pm-desc">{task.description}</p>
              : <p className="pm-desc pm-desc--empty">No description yet.</p>}
          </Section>

          <Section
            label="Subtasks"
            count={task.subtasks.length ? `${task.subtasks.filter((s) => s.done).length}/${task.subtasks.length}` : undefined}
          >
            <Subtasks subtasks={task.subtasks} canEdit={canEdit} toggle={toggleSubtask.bind(null, task.id)} add={addSubtask.bind(null, task.id)} />
          </Section>

          {customFieldDefs.length > 0 && (
            <Section label="Custom fields">
              <TaskCustomFields
                taskId={task.id}
                defs={customFieldDefs}
                values={task.customFields}
                canEdit={canEdit}
                save={updateTaskCustomFields}
              />
            </Section>
          )}

          <Section label="Attachments" count={files.length || undefined}>
            <Attachments files={files} canEdit={canEdit} attach={attachFileAction.bind(null, "task", task.id)} remove={deleteFileAction.bind(null, "task", task.id)} />
          </Section>

          <Section label="Comments & activity" count={comments.length || undefined}>
            <CommentThread
              comments={comments}
              post={postTaskComment.bind(null, task.id)}
              addReaction={addReaction}
              removeReaction={removeReaction}
              mentionCandidates={assignable.members}
            />
          </Section>
        </div>

        {/* RIGHT — properties: one row per fact, so "what state is this in" is a single scan. */}
        <aside className="pm-detail__side">
          <div className="pm-props">
            <Prop label="Status">
              <StatusSelect
                current={task.status}
                statuses={statusOptions}
                canEdit={canEdit}
                save={setTaskStatus.bind(null, task.id)}
                undoSpawn={task.recurrence ? undoRecurrenceSpawn.bind(null, task.projectId) : undefined}
                disabledHint={statusDisabledHint}
              />
            </Prop>
            {/* Ball = assignee.refId/kind, Responsible = assignee.responsibleId — one field, two
                independent slots (plan §1.5), not two axes. Shown side by side per the Repsona
                modal, each with its own "Set to me" (P4-F4). */}
            <Prop label={PM_TERMS.ball} muted={!task.assignee}>
              {task.assignee ? (
                <>
                  {task.assignee.refName}
                  {task.assignee.kind !== "person" && (
                    <span style={{ color: "var(--erp-ink-50)" }}> · {task.assignee.kind}</span>
                  )}
                </>
              ) : "Unassigned"}
              {canEdit && <SetToMeButton label={PM_TERMS.setToMe} act={setBallToMe.bind(null, task.id)} />}
            </Prop>
            <Prop label={PM_TERMS.responsible} muted={!responsibleId}>
              {responsibleId ? <Link href={`/people/${responsibleId}`}>{task.assignee?.responsibleName}</Link> : "—"}
              {canEdit && <SetToMeButton label={PM_TERMS.setToMe} act={reassignResponsible.bind(null, task.id, userId)} />}
            </Prop>
            <Prop label="Priority">{task.priority}</Prop>
            <Prop label="Start" muted={!task.startDate}>{task.startDate ?? "Not set"}</Prop>
            {/* P4-F3: start–due range, the overdue/almost-late/in-time glyph (one definition,
                `taskUrgency` — never a bespoke date comparison here), and a one-click "Today". */}
            <Prop label="Due" muted={!task.dueDate}>
              {task.startDate && task.dueDate ? `${task.startDate} – ${task.dueDate}` : task.dueDate ?? "Not set"}
              {dueUrgency && <UrgencyChip tier={dueUrgency} variant="dot" />}
              {canEdit && <TodayScheduleButton act={rescheduleTask.bind(null, task.id, task.startDate ?? null, today)} />}
            </Prop>
            <Prop label="Estimate" muted={!task.estimateMinutes}>{fmtMinutes(task.estimateMinutes) ?? "Not set"}</Prop>
            <Prop label="Logged" muted={!task.loggedMinutes}>{fmtMinutes(task.loggedMinutes) ?? "None"}</Prop>
            <Prop label="Progress" stack>
              <ProgressControl taskId={task.id} value={task.progress} canEdit={canEdit} save={setTaskProgress} />
            </Prop>
          </div>

          {/* P4-B7 — the assignment-history timeline (migration 0087, plan §1.5). Passing the Ball
              above never erases the previous holder; this is the full append-only record, newest
              first, read straight off the ledger rather than reconstructed from current state. */}
          <Section label="History" count={assignmentHistory.length || undefined}>
            {assignmentHistory.length === 0 ? (
              <p className="pm-desc pm-desc--empty">No history yet.</p>
            ) : (
              <ol className="pm-history">
                {assignmentHistory.map((e) => (
                  <li key={e.id} className="pm-history__row">
                    <span className="pm-history__when">{fmtWhen(e.createdAt)}</span>
                    <span className="pm-history__body">
                      <strong>{e.refName ?? PM_TERMS.unassigned}</strong>
                      {e.refKind && e.refKind !== "person" && (
                        <span className="pm-history__muted"> · {e.refKind}</span>
                      )}
                      <span className="pm-history__muted"> took the {PM_TERMS.ball.toLowerCase()}</span>
                      {e.responsibleName && (
                        <span className="pm-history__muted"> · {PM_TERMS.responsible}: {e.responsibleName}</span>
                      )}
                      <span className="pm-history__muted"> · {statusLabel(e.statusId)}</span>
                      {e.changedByName && <span className="pm-history__by"> — by {e.changedByName}</span>}
                      {e.note && <span className="pm-history__note"> “{e.note}”</span>}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Section>

          {canEdit && (
            <Section label={task.assignee ? "Reassign" : "Assign"}>
              <AssigneeEditor label={task.assignee ? "Reassign" : "Assign"} assignable={assignable} current={task.assignee} save={setAssignee.bind(null, task.id)} />
            </Section>
          )}

          <Section label="Tags">
            <TagEditor
              registry={tagRegistry}
              selected={task.tags}
              canEdit={canEdit}
              setTags={setTaskTags.bind(null, task.id)}
              createTag={createTag.bind(null, task.projectId)}
            />
          </Section>

          <Section label="Contributors">
            <Contributors
              contributors={task.contributors}
              ownerId={responsibleId}
              ownerName={task.assignee?.responsibleName}
              candidates={assignable.members}
              canEdit={canEdit}
              add={addContributor.bind(null, task.id)}
              remove={removeContributor.bind(null, task.id)}
            />
          </Section>

          <Section label="Dependencies">
            <Dependencies
              current={currentDeps}
              options={depOptions}
              canEdit={canEdit}
              add={addDependency.bind(null, task.id)}
              remove={removeDependency.bind(null, task.id)}
            />
          </Section>

          <Section label="Time">
            <TimeLog
              logs={timeLogs}
              loggedMinutes={task.loggedMinutes}
              estimateMinutes={task.estimateMinutes}
              billableMinutes={time.billable}
              canEdit={canEdit}
              log={logTime.bind(null, task.id)}
            />
          </Section>

          <Section label="AI Tracker">
            <TrackerPanel
              taskId={task.id}
              suggestions={suggestions}
              canAct={canEdit}
              run={runTracker}
              confirm={confirmSuggestion.bind(null, task.id)}
              dismiss={dismissSuggestion.bind(null, task.id)}
            />
          </Section>
        </aside>
      </div>
    </>
  );
}
