import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getProject, listComments, listFiles, getFieldDefs } from "@/lib/entities";
import { postEntityComment, attachFileAction, deleteFileAction } from "@/lib/collabActions";
import { CommentThread } from "@/components/pm/CommentThread";
import { Attachments } from "@/components/Attachments";
import { PendingLink } from "@/components/PendingLink";
import { listRecordings, STATUS_LABEL, formatDuration } from "@/lib/meetings";
import { RecordControls } from "@/components/meetings/RecordControls";
import { formatDateTime } from "@/lib/format";
import {
  getPmProject, listPmTasks, listMilestones, listDocs, assignableUnits, listTags,
  groupByStatus, computeTimeline, openDependencies, resolveTags, parseTagFilterParam,
  synthDefaultStatuses, isSynthDefaultStatuses, titleWithRecurrenceGlyph,
  getBurndown, burndownOverlay, timelineFromDates, getFlow, flowSeries, tagBreakdown,
  projectProgress, isDoneStatus, taskUrgency, type PmTask, type Tag, type ProjectStatus, type UrgencyTier,
} from "@/lib/pm";
import {
  moveTask, createPmTask, setProjectOwner, addMilestone, saveDoc,
  setTaskPriority, reassignResponsible, reassignBall, createTag, updateTag, deleteTag,
  createStatus, updateStatus, reorderStatuses, deleteStatus,
} from "@/lib/pmActions";
import { can } from "@/lib/rbac";
import { StatusManager } from "@/components/pm/StatusManager";
import { archiveProject } from "@/app/(app)/projects/actions";
import { PageHeader } from "@/components/PageHeader";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Board } from "@/components/pm/Board";
import { Gantt } from "@/components/pm/Gantt";
import { UrgencyChip } from "@/components/pm/UrgencyChip";
import { Charts, type ChartsKpis } from "@/components/pm/Charts";
import { ProgressBar } from "@/components/pm/ProgressBar";
import { NewTaskForm } from "@/components/pm/NewTaskForm";
import { AssigneeEditor } from "@/components/pm/AssigneeEditor";
import { MilestoneForm } from "@/components/pm/MilestoneForm";
import { DocEditor } from "@/components/pm/DocEditor";
import { TagChip } from "@/components/pm/TagChip";
import { TagManager } from "@/components/pm/TagManager";
import { DuplicateProject } from "@/components/pm/DuplicateProject";
import {
  assigneeColumns, priorityColumns, ballColumns, filterTasksByBall, filterTasksByResponsible,
  ballFacetOptions, responsibleFacetOptions, type BoardSwimlane,
} from "@/lib/departments";
import { PM_TERMS } from "@/lib/pmVocabulary";
import "@/components/pm/pm.css";

// The full project workspace (Board/List/Timeline/Milestones/Docs + owner/
// progress + attachments/discussion) — extracted out of the standalone
// `/projects/[projectId]` route (P1-05, design spec §3) so it can be mounted
// BOTH there and nested inside a department console
// (`/departments/[deptId]/projects/[projectId]`) with identical behaviour.
// The caller owns the breadcrumb's first hop (`backHref`/`backLabel`) and any
// auth/tenant guard around the mount point; this component re-resolves its
// own userId/tenant (same as every other server-fetched page/component in
// this app — e.g. the dept layout + its child pages each do this
// independently) since it isn't handed them as props.
export type ProjectWorkspaceSearch = {
  view?: string;
  swimlane?: string;
  tags?: string | string[];
  // P4-B9: Ball/Responsible filter facets — same shape as `tags` (a GET-form checkbox
  // multi-select; absent/empty means "no filter", not "match nothing").
  ball?: string | string[];
  responsible?: string | string[];
};

// "files", "discussion" and "meetings" are tabs, not always-rendered cards. They used to sit below
// every view as three large panels — usually empty — so the page ended in dead weight and the board
// above it had to compete for attention with an empty comment box.
const VIEWS = ["board", "list", "timeline", "charts", "milestones", "docs", "files", "discussion", "meetings"] as const;
type View = (typeof VIEWS)[number];

// The project board only groups by axes that make sense scoped to ONE
// project — Status (default), Responsible, Ball, Priority. Division and the dept
// "focus" filter are department-scoped concepts (see the dept Board tab,
// lib/departments.ts) and don't apply inside a single project's workspace.
//
// P4-B6: "assignee" keys off `responsibleId` (see `assigneeColumns`) — it IS the Responsible
// board, only the persisted `?swimlane=` value stays `assignee` for old bookmarked links. "ball"
// is the new, genuinely separate axis (`ballColumns`, keyed off `assignee.refId`) — Repsona's two
// boards show DIFFERENT tasks for the same person, which is the entire point (plan §1.5).
type ProjectSwimlane = Extract<BoardSwimlane, "status" | "assignee" | "ball" | "priority">;
const SWIMLANES: { value: ProjectSwimlane; label: string }[] = [
  { value: "status", label: "Status" },
  { value: "assignee", label: PM_TERMS.responsible },
  { value: "ball", label: PM_TERMS.ball },
  { value: "priority", label: "Priority" },
];
function isSwimlane(v: string | undefined): v is Exclude<ProjectSwimlane, "status"> {
  return v === "assignee" || v === "ball" || v === "priority";
}

function who(t: PmTask): string {
  return t.assignee ? (t.assignee.responsibleName || t.assignee.refName) : "Unassigned";
}

// P4-B9 — List-view Ball/Responsible columns read the two slots directly rather than through
// `who()`'s blended fallback (which exists for callers that only have room for one name).
function ballWho(t: PmTask): string {
  return t.assignee?.refName || PM_TERMS.unassigned;
}
function responsibleWho(t: PmTask): string {
  return t.assignee?.responsibleName || PM_TERMS.unassigned;
}

export async function ProjectWorkspaceView({
  projectId,
  backHref,
  backLabel,
  searchParams,
}: {
  projectId: string;
  backHref: string;
  backLabel: string;
  searchParams: ProjectWorkspaceSearch;
}) {
  const view: View = (VIEWS as readonly string[]).includes(searchParams.view ?? "") ? (searchParams.view as View) : "board";
  const swimlane: ProjectSwimlane = isSwimlane(searchParams.swimlane) ? searchParams.swimlane : "status";

  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) notFound();

  const [pm, base, tasks, milestones, docs, assignable, comments, files, tags, taskCustomFieldDefs, meetings] = await Promise.all([
    getPmProject(userId, tenant, projectId),
    getProject(userId, tenant, projectId).catch(() => null),
    listPmTasks(userId, tenant, projectId),
    listMilestones(userId, tenant, projectId),
    listDocs(userId, tenant, projectId),
    assignableUnits(userId, tenant),
    listComments(userId, tenant, "project", projectId),
    listFiles(userId, tenant, "project", projectId),
    listTags(userId, tenant, projectId),
    getFieldDefs(userId, tenant, "pm_task"),
    // WD-07: recordings started from THIS project workspace (client/project context plumbed
    // straight into `RecordControls` below) — verifies the capture edge end-to-end from a
    // project's own page, not just the standalone /meetings registry.
    listRecordings(userId, tenant, { projectId }),
  ]);
  // Burndown overlay (P2-08, design spec §4 phase-2) — only fetched when the Timeline or Charts
  // tab is actually being rendered, same lazy pattern as everything else view-scoped on this page.
  const burndownSeries = (view === "timeline" || view === "charts") ? await getBurndown(userId, tenant, projectId) : [];
  // Cumulative flow (P3-06) — same lazy pattern; getFlow degrades to [] until the sibling BE
  // ticket P3-05 ships the real /flow endpoint (DEMO_MODE already returns a seeded series).
  const flowPoints = view === "charts" ? await getFlow(userId, tenant, projectId) : [];

  if (!pm && !base) notFound();
  // P2-05: this project's workflow statuses (synth legacy 4 when the registry is
  // empty / the project is base-only). Everything status-shaped below keys off it.
  const projectStatuses: ProjectStatus[] = pm?.statuses?.length ? [...pm.statuses].sort((a, b) => a.position - b.position) : synthDefaultStatuses();
  const statusLabelById = new Map(projectStatuses.map((s) => [s.id, s.label]));
  const statusLabel = (id: string) => statusLabelById.get(id) ?? id;
  const statusColorById = new Map(projectStatuses.map((s) => [s.id, s.color]));
  const canManageStatuses = can(me, "pm.manage", tenant);
  const showStatusColors = !isSynthDefaultStatuses(projectStatuses);
  const statusUsage: Record<string, number> = {};
  for (const s of projectStatuses) statusUsage[s.id] = 0;
  for (const t of tasks) statusUsage[t.status] = (statusUsage[t.status] ?? 0) + 1;

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const blockedIds = new Set(tasks.filter((t) => openDependencies(t, taskById, projectStatuses).length > 0).map((t) => t.id));
  const name = base?.name ?? pm?.name ?? "Project";
  const status = base?.status ?? pm?.status ?? "active";
  const progress = pm?.progress ?? 0;
  const owner = pm?.owner ?? null;

  // Tags (P2-02, design spec §6) — this project's OWN registry, so filtering
  // is a plain id match (unlike the dept board's cross-project label match).
  const taskTags: Record<string, Tag[]> = {};
  for (const t of tasks) taskTags[t.id] = resolveTags(t.tags, tags);

  // P4-G5: urgency, resolved ONCE for this whole render and threaded to every view (Board/List/
  // Timeline/Milestones) below — never per-view, never per-row. `today` is a plain date string so
  // server and any client component it's handed to agree by construction (see lib/pmUrgency.ts);
  // `isDoneStatus` resolves against THIS project's own status registry, same precedent as `taskTags`.
  const today = new Date().toISOString().slice(0, 10);
  const taskUrgencyById: Record<string, UrgencyTier> = {};
  for (const t of tasks) taskUrgencyById[t.id] = taskUrgency({ dueDate: t.dueDate, isDone: isDoneStatus(t.status, projectStatuses) }, today);
  const selectedTagIds = parseTagFilterParam(searchParams.tags);
  const tagFilteredTasks = selectedTagIds.length === 0 ? tasks : tasks.filter((t) => t.tags.some((id) => selectedTagIds.includes(id)));
  // P4-B9: Ball/Responsible facets — options derived from the FULL unfiltered task set (so a
  // filter never removes its own options), applied on top of the tag filter, same chained-filter
  // shape as the dept board's tag-then-focus filtering.
  const selectedBallIds = parseTagFilterParam(searchParams.ball);
  const selectedResponsibleIds = parseTagFilterParam(searchParams.responsible);
  const ballOptions = ballFacetOptions(tasks);
  const responsibleOptions = responsibleFacetOptions(tasks);
  const filteredTasks = filterTasksByResponsible(filterTasksByBall(tagFilteredTasks, selectedBallIds), selectedResponsibleIds);

  // Own path in whichever mount point rendered this component — derivable
  // from `backHref` without a 4th "self path" prop: the list page's href
  // plus this project's id, in both the standalone ("/projects" ->
  // "/projects/{id}") and nested ("/departments/{d}/projects" ->
  // "/departments/{d}/projects/{id}") cases.
  const basePath = `${backHref}/${projectId}`;

  // taskHrefBase (P1-06, design spec §5): when this workspace is mounted
  // in-console (`backHref` starts with `/departments/`), task links from the
  // Board/Gantt/List views point at the nested task route so navigating to a
  // task keeps the user in-console; the standalone mount (`backHref="/projects"`)
  // leaves it undefined so Board/Gantt/List fall back to `/tasks/{id}`.
  const taskHrefBase = backHref.startsWith("/departments/") ? `${basePath}/tasks` : undefined;
  const taskHref = (id: string) => (taskHrefBase ? `${taskHrefBase}/${id}` : `/tasks/${id}`);

  // PendingLink, not Link: a ?view= change is not a segment change, so Next fires no loading.tsx
  // and a tab click on a cold view looked like nothing happened. See components/PendingLink.tsx.
  const tab = (v: View, label: string) => (
    <PendingLink href={`${basePath}?view=${v}`} className={`pm-tab${view === v ? " pm-tab--active" : ""}`}>{label}</PendingLink>
  );

  return (
    <>
      <PageHeader
        eyebrow="Project"
        title={name}
        breadcrumbs={[{ label: backLabel, href: backHref }, { label: name }]}
        actions={
          <>
            <Link href={`/projects/${projectId}/edit`} className="lux-btn lux-btn--ghost lux-btn--sm">Edit</Link>
            <DuplicateProject projectId={projectId} projectName={name} canManage={canManageStatuses} />
            <form action={archiveProject.bind(null, projectId)}><button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Archive</button></form>
          </>
        }
      />

      {/* One line, not a four-column grid of labelled blocks. These are facts about the project, so
          they read left to right at one size; the work below is what deserves the weight. */}
      <div className="pm-meta">
        <StatusBadge label={status} />
        <span className="pm-meta__prog"><ProgressBar value={progress} /></span>
        <span className="pm-meta__item">
          <span className="pm-meta__label">Owner</span>
          {owner ? (owner.responsibleName || owner.refName) : "Unassigned"}
          {owner && owner.kind !== "person" ? ` · ${owner.refName}` : ""}
          <AssigneeEditor label={owner ? "Reassign" : "Assign"} assignable={assignable} current={owner} save={setProjectOwner.bind(null, projectId)} />
        </span>
        <span className="pm-meta__item">
          <span className="pm-meta__label">Tags</span>
          <TagManager tags={tags} create={createTag.bind(null, projectId)} update={updateTag.bind(null, projectId)} remove={deleteTag.bind(null, projectId)} />
        </span>
      </div>

      <div className="pm-tabsrow">
        <div className="pm-tabs">
          {tab("board", "Board")}{tab("list", "List")}{tab("timeline", "Timeline")}{tab("charts", "Charts")}{tab("milestones", "Milestones")}{tab("docs", "Docs")}
          {tab("files", files.length ? `Files (${files.length})` : "Files")}
          {tab("discussion", comments.length ? `Discussion (${comments.length})` : "Discussion")}
          {tab("meetings", meetings.length ? `Meetings (${meetings.length})` : "Meetings")}
        </div>
        <NewTaskForm assignable={assignable} milestones={milestones} customFieldDefs={taskCustomFieldDefs} create={createPmTask.bind(null, projectId)} />
      </div>

      {/* Tag filter (P2-02, design spec §6/§9): a bookmarkable GET form, same
          pattern as the board's own swimlane control. Applies to Board/List/
          Timeline uniformly (Milestones/Docs aren't task-list views). */}
      {tags.length > 0 && (
        <div className="pm-filterbar">
          <form className="lux-filters" method="get" aria-label="Filter by tag">
            <input type="hidden" name="view" value={view} />
            {swimlane !== "status" && <input type="hidden" name="swimlane" value={swimlane} />}
            {selectedBallIds.map((id) => <input key={id} type="hidden" name="ball" value={id} />)}
            {selectedResponsibleIds.map((id) => <input key={id} type="hidden" name="responsible" value={id} />)}
            <div className="pm-tagfilter">
              <span className="pm-tagfilter__label">Tags</span>
              <div className="pm-tagfilter__options">
                {tags.map((tg) => (
                  <label key={tg.id} className="pm-tagfilter__opt">
                    <input type="checkbox" name="tags" value={tg.id} defaultChecked={selectedTagIds.includes(tg.id)} />
                    <TagChip label={tg.label} color={tg.color} />
                  </label>
                ))}
              </div>
            </div>
            <div className="lux-filters__actions">
              <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Apply</button>
              {selectedTagIds.length > 0 && (
                <a href={`${basePath}?view=${view}`} className="lux-btn lux-btn--ghost lux-btn--sm">Reset</a>
              )}
            </div>
          </form>
        </div>
      )}

      {/* Ball/Responsible filter facets (P4-B9) — same bookmarkable-GET-form shape as the tag
          filter above, and independent of it (both can be active at once). Only renders when the
          project has more than the trivial "no assignee at all" option, same threshold the tag
          filter uses (`tags.length > 0`). */}
      {(ballOptions.length > 0 || responsibleOptions.length > 0) && (
        <div className="pm-filterbar">
          <form className="lux-filters" method="get" aria-label={`Filter by ${PM_TERMS.ball} or ${PM_TERMS.responsible}`}>
            <input type="hidden" name="view" value={view} />
            {swimlane !== "status" && <input type="hidden" name="swimlane" value={swimlane} />}
            {selectedTagIds.map((id) => <input key={id} type="hidden" name="tags" value={id} />)}
            {ballOptions.length > 0 && (
              <div className="pm-tagfilter">
                <span className="pm-tagfilter__label">{PM_TERMS.ball}</span>
                <div className="pm-tagfilter__options">
                  {ballOptions.map((o) => (
                    <label key={o.id} className="pm-tagfilter__opt">
                      <input type="checkbox" name="ball" value={o.id} defaultChecked={selectedBallIds.includes(o.id)} />
                      {o.label}
                    </label>
                  ))}
                </div>
              </div>
            )}
            {responsibleOptions.length > 0 && (
              <div className="pm-tagfilter">
                <span className="pm-tagfilter__label">{PM_TERMS.responsible}</span>
                <div className="pm-tagfilter__options">
                  {responsibleOptions.map((o) => (
                    <label key={o.id} className="pm-tagfilter__opt">
                      <input type="checkbox" name="responsible" value={o.id} defaultChecked={selectedResponsibleIds.includes(o.id)} />
                      {o.label}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="lux-filters__actions">
              <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Apply</button>
              {(selectedBallIds.length > 0 || selectedResponsibleIds.length > 0) && (
                <a href={`${basePath}?view=${view}`} className="lux-btn lux-btn--ghost lux-btn--sm">Reset</a>
              )}
            </div>
          </form>
        </div>
      )}

      {view === "board" && (
        filteredTasks.length === 0 ? (
          <EmptyNote>{tasks.length === 0 ? "No tasks yet — create the first one above." : "No tasks match these filters."}</EmptyNote>
        ) : (
            <>
              {/* Unboxed: grouping is a setting, and a bordered card gave it the same weight as the
                  board itself. Apply stays because this is a server-rendered GET form. */}
              <div className="pm-filterbar">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                  <form className="lux-filters" method="get" aria-label="Board group-by">
                    <input type="hidden" name="view" value="board" />
                    {selectedTagIds.map((id) => <input key={id} type="hidden" name="tags" value={id} />)}
                    {selectedBallIds.map((id) => <input key={id} type="hidden" name="ball" value={id} />)}
                    {selectedResponsibleIds.map((id) => <input key={id} type="hidden" name="responsible" value={id} />)}
                    <label className="lux-filters__field">
                      <span>Group by</span>
                      <select name="swimlane" defaultValue={swimlane}>
                        {SWIMLANES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                      </select>
                    </label>
                    <div className="lux-filters__actions">
                      <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Apply</button>
                      {swimlane !== "status" && (
                        <a href={`${basePath}?view=board`} className="lux-btn lux-btn--ghost lux-btn--sm">Reset</a>
                      )}
                    </div>
                  </form>
                  {swimlane === "status" && canManageStatuses && (
                    <StatusManager
                      statuses={projectStatuses}
                      usageCounts={statusUsage}
                      create={createStatus.bind(null, projectId)}
                      update={updateStatus.bind(null, projectId)}
                      reorder={reorderStatuses.bind(null, projectId)}
                      remove={deleteStatus.bind(null, projectId)}
                    />
                  )}
                </div>
              </div>
              {swimlane === "priority" ? (
                <Board columns={priorityColumns(filteredTasks)} move={setTaskPriority} blockedIds={blockedIds} taskHrefBase={taskHrefBase} taskTags={taskTags} taskUrgency={taskUrgencyById} />
              ) : swimlane === "assignee" ? (
                <Board columns={assigneeColumns(filteredTasks)} move={reassignResponsible} blockedIds={blockedIds} taskHrefBase={taskHrefBase} taskTags={taskTags} taskUrgency={taskUrgencyById} />
              ) : swimlane === "ball" ? (
                <Board columns={ballColumns(filteredTasks)} move={reassignBall} blockedIds={blockedIds} taskHrefBase={taskHrefBase} taskTags={taskTags} taskUrgency={taskUrgencyById} />
              ) : (
                <Board columns={groupByStatus(filteredTasks, projectStatuses)} move={moveTask} colorColumns={showStatusColors} blockedIds={blockedIds} taskHrefBase={taskHrefBase} taskTags={taskTags} taskUrgency={taskUrgencyById} />
              )}
            </>
          )
      )}

      {view === "list" && (
        <Card>
          {filteredTasks.length === 0 ? (
            <EmptyNote>{tasks.length === 0 ? "No tasks yet." : "No tasks match these filters."}</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Task" }, { label: "Tags" }, { label: PM_TERMS.ball }, { label: PM_TERMS.responsible }, { label: "Status" }, { label: "Progress" }, { label: "Due", align: "right" }]}
              rows={filteredTasks.map((t) => [
                <Link key="t" href={taskHref(t.id)} style={{ color: "var(--text-primary)", textDecoration: "none" }}>{titleWithRecurrenceGlyph(t)}</Link>,
                taskTags[t.id]?.length ? (
                  <div key="tg" className="pm-tags-row">
                    {taskTags[t.id].map((tg) => <TagChip key={tg.id} label={tg.label} color={tg.color} />)}
                  </div>
                ) : "—",
                ballWho(t),
                responsibleWho(t),
                <StatusBadge key="s" label={statusLabel(t.status)} />,
                <ProgressBar key="p" value={t.progress} />,
                <span key="d" style={{ display: "inline-flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
                  {t.dueDate ?? "—"}
                  <UrgencyChip tier={taskUrgencyById[t.id]} variant="dot" />
                </span>,
              ])}
              tcols="2fr 1.2fr 1.1fr 1.1fr 1fr 1.2fr 0.8fr"
            />
          )}
        </Card>
      )}

      {view === "timeline" && (() => {
        const tl = computeTimeline(filteredTasks);
        // P2-05 (§5): bar colours from each task's status colour.
        const barColors: Record<string, string> = {};
        for (const t of filteredTasks) { const c = statusColorById.get(t.status); if (c) barColors[t.id] = c; }
        const burndown = tl ? burndownOverlay(tl, burndownSeries) : [];
        return (
          <Card>
            {/* `todayISO`/`taskTags` are threaded from here for the same reason `taskUrgency` is:
                this page already resolves `today` once on the server, and Gantt's client-side
                fallback exists only for callers that don't. Passing it keeps the today-marker on the
                server clock — the one that decided every urgency tier on this page — instead of the
                viewer's, which can disagree across a timezone or a midnight boundary. */}
            {tl ? <Gantt timeline={tl} taskHrefBase={taskHrefBase} barColors={barColors} burndown={burndown} taskUrgency={taskUrgencyById} todayISO={today} taskTags={taskTags} /> : <EmptyNote>Add start/due dates to tasks to see them on the timeline.</EmptyNote>}
          </Card>
        );
      })()}

      {view === "charts" && (() => {
        // Unfiltered by the tag-filter control above — same precedent as Milestones/Docs (both
        // task-shaped views that ignore it too): burndown/flow are whole-project time series the
        // backend can't slice by tag, so KPIs/tag-breakdown stay on the SAME full `tasks` set for
        // internal consistency rather than drifting from a tag-filtered subset.
        const kpis: ChartsKpis = {
          open: tasks.filter((t) => !isDoneStatus(t.status, projectStatuses)).length,
          done: tasks.filter((t) => isDoneStatus(t.status, projectStatuses)).length,
          avgProgress: projectProgress(tasks),
        };
        const flow = flowSeries(flowPoints, projectStatuses);
        const bdTl = burndownSeries.length ? timelineFromDates(burndownSeries[0].date, burndownSeries[burndownSeries.length - 1].date) : null;
        const bdOverlay = bdTl ? burndownOverlay(bdTl, burndownSeries) : [];
        const tagRows = tagBreakdown(tasks, tags);
        return <Charts kpis={kpis} flow={flow} burndownSeries={burndownSeries} burndownOverlay={bdOverlay} tagRows={tagRows} />;
      })()}

      {view === "milestones" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Card><MilestoneForm add={addMilestone.bind(null, projectId)} /></Card>
          {milestones.length === 0 && <EmptyNote>No milestones yet.</EmptyNote>}
          {milestones.map((mst) => {
            const mtasks = tasks.filter((t) => t.milestoneId === mst.id);
            // Milestone-grain urgency: a milestone has no ProjectStatus registry of its own (that
            // model is task-scoped, P2-05), so "done" is read off its own status string directly —
            // the same `mst.status` this Card already renders as a StatusBadge. Low-count, one row
            // per milestone -> chip form (room for the word, unlike the dense task tables below it).
            const mstTier = taskUrgency({ dueDate: mst.dueDate, isDone: mst.status === "done" }, today);
            return (
              <Card
                key={mst.id}
                title={mst.name}
                headerRight={
                  <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
                    <StatusBadge label={mst.status} />
                    <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>{mst.dueDate ?? "—"}</span>
                    <UrgencyChip tier={mstTier} variant="chip" />
                  </span>
                }
              >
                {mtasks.length === 0 ? <EmptyNote>No tasks in this milestone.</EmptyNote> : (
                  <HairlineTable
                    columns={[{ label: "Task" }, { label: "Assignee" }, { label: "Status" }, { label: "Progress" }, { label: "Due", align: "right" }]}
                    rows={mtasks.map((t) => [
                      <Link key="t" href={taskHref(t.id)} style={{ color: "var(--text-primary)", textDecoration: "none" }}>{titleWithRecurrenceGlyph(t)}</Link>,
                      who(t),
                      <StatusBadge key="s" label={statusLabel(t.status)} />,
                      <ProgressBar key="p" value={t.progress} />,
                      <span key="d" style={{ display: "inline-flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
                        {t.dueDate ?? "—"}
                        <UrgencyChip tier={taskUrgencyById[t.id]} variant="dot" />
                      </span>,
                    ])}
                    tcols="2fr 1.2fr 1fr 1fr 1.2fr"
                  />
                )}
              </Card>
            );
          })}
        </div>
      )}

      {view === "docs" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Card title="New doc"><DocEditor save={saveDoc.bind(null, projectId)} /></Card>
          {docs.length === 0 && <EmptyNote>No docs yet.</EmptyNote>}
          {docs.map((d) => (
            <Card key={d.id} title={d.title} headerRight={<DocEditor doc={d} save={saveDoc.bind(null, projectId)} />}>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", font: "400 13px/1.6 var(--font-body)", color: "var(--text-primary)" }}>{d.body}</pre>
              <p style={{ margin: "10px 0 0", font: "400 11px var(--font-body)", color: "var(--erp-ink-50)" }}>{d.author ? `${d.author} · ` : ""}{d.updatedAt ? new Date(d.updatedAt).toLocaleDateString("en-GB") : ""}</p>
            </Card>
          ))}
        </div>
      )}

      {view === "files" && (
        <Attachments files={files} canEdit={true} attach={attachFileAction.bind(null, "project", projectId)} remove={deleteFileAction.bind(null, "project", projectId)} />
      )}

      {view === "discussion" && (
        <CommentThread comments={comments} post={postEntityComment.bind(null, "project", projectId)} />
      )}

      {/* WD-07 (Web Dev Phase 1 §12) — capture a briefing straight from this project so it lands
          scoped (`projectId` + this project's own `client_id`), and shows here once recorded. */}
      {view === "meetings" && (
        <>
          <RecordControls projectId={projectId} clientId={base?.client_id ?? undefined} />
          {meetings.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <HairlineTable
                columns={[{ label: "Meeting" }, { label: "Status" }, { label: "Length" }, { label: "Recorded", align: "right" }]}
                rows={meetings.map((r) => [
                  <Link key="t" href={`/meetings/${r.id}`} style={{ color: "inherit", fontWeight: 600 }}>{r.title ?? r.meeting_id}</Link>,
                  <StatusBadge key="s" label={STATUS_LABEL[r.status] ?? r.status} />,
                  formatDuration(r.duration_sec),
                  formatDateTime(r.created_at),
                ])}
                tcols="2fr 1fr .8fr 1fr"
              />
            </div>
          )}
        </>
      )}

    </>
  );
}
