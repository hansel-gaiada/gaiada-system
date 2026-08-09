import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getPmScope } from "@/lib/pmScopeActions";
import {
  resolveScopeWork, pmScopeOptions, scopeTagRegistries, scopeMilestones, scopeBurndownOverlay, scopeChartsData,
} from "@/lib/pmScope-data";
import {
  unionStatusColumns, isSynthDefaultStatuses, openDependencies, resolveTags, distinctTagLabels,
  filterTasksByTagLabels, parseTagFilterParam, isDoneStatus, taskUrgency, getProductivity,
  computeTimeline, groupTimelineBars, milestoneMarkers, dependencyEdges,
  type Tag, type UrgencyTier, type Milestone,
} from "@/lib/pm";
import { PlatformError } from "@/lib/platform";
import {
  assigneeColumns, ballColumns, priorityColumns, filterTasksByBall, filterTasksByResponsible,
  ballFacetOptions, responsibleFacetOptions,
} from "@/lib/departments";
import { moveTask, moveTaskToStatusLabel, setTaskPriority, reassignResponsible, reassignBall } from "@/lib/pmActions";
import { PM_TERMS } from "@/lib/pmVocabulary";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Board } from "@/components/pm/Board";
import { Gantt } from "@/components/pm/Gantt";
import { Charts } from "@/components/pm/Charts";
import { Productivity } from "@/components/pm/Productivity";
import { TagChip } from "@/components/pm/TagChip";
import { ScopeSwitcher } from "@/components/pm/ScopeSwitcher";
import { PM_SWIMLANES, isSwimlane, isView, representativeTag, leadWithUnassigned, type PmSwimlane } from "./page-helpers";
import "@/components/pm/pm.css";

// The `@all` cross-project PM surface (plan §1.1/§3 workstream A, tickets P4-A3/A4/A5) — Repsona's
// "Cross project" scope, generalised to ALSO serve a single department or a single project through
// the exact same three views (P4-A3's whole point: one scope layer, no fourth set of components).
// `/pm` is the new home for this (decision 1) — `/` stays the personal My Work landing.
//
// One page, tab-switched views (`?view=board|ball|gantt|charts|productivity`, same `?view=` idiom
// `ProjectWorkspaceView` already uses) rather than one route per view: the scope switcher's whole
// point is to stay on the view you're looking at while re-scoping it, and a single page/search-param
// pair makes that trivial (no pathname plumbing needed to know "which view was I on"). `productivity`
// is the exception (see its own note below) — it ignores the scope switcher entirely.
//
// NOT built here (a separate ticket in the same plan): a `Home` column view (P4-A8, needs a
// comments-on-tasks join). Division/grid swimlanes stay on the department board — a division only
// means something inside ONE department, so they don't generalise to `@all`/project scope.
//
// `Productivity` (P4-E3/E4, plan §1.7) IS mounted here as a fourth tab, but it does not consume
// `work`/the scope switcher at all — it is PERSON-grain (whose activity), not project/department/
// tenant-grain like the other three, so re-scoping the board/gantt/charts tabs has no meaning for
// it. It always shows the SIGNED-IN user's own series (self is always allowed server-side; the
// backend's `?userId=` param exists for a future person-switcher, deliberately not built here —
// out of this ticket's scope).
//
// P4-A6: `Responsible`/`Ball` ARE first-class views here, at every scope, with `leadWithUnassigned`
// (./page-helpers) normalising both to lead with a "no user" column, matching the reference
// (§1.4/§1.5). `Responsible` is reached through Board's "Group by" swimlane selector (no fourth
// set of components, per the ticket). `Ball` used to be the fourth swimlane option there too, but
// owner decision 2026-08-09 pulled it out into its own peer tab (`BallSection` below) — a full
// board-layout switch just to see who's holding the ball cluttered the board view's real job
// (status triage). `page-helpers.ts`'s `PM_SWIMLANES`/`isSwimlane` no longer accept "ball"; it
// lives only in `PmView`/`isView` now.

type SearchParams = Promise<{
  view?: string; swimlane?: string; tags?: string | string[]; ball?: string | string[]; responsible?: string | string[];
}>;

export default async function PmPage({ searchParams }: { searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) redirect("/");

  const scope = await getPmScope();
  const [work, options] = await Promise.all([
    resolveScopeWork(userId, tenant, scope),
    pmScopeOptions(userId, tenant),
  ]);

  const sp = await searchParams;
  const view = isView(sp.view) ? sp.view : "board";
  const canEdit = can(me, "pm.manage", tenant);

  // P4-G5 precedent: `today` resolved ONCE per render, urgency/isDone derived from THIS task's own
  // project's registry — never recomputed per view, so Board/Gantt/Charts can never disagree.
  const today = new Date().toISOString().slice(0, 10);
  const taskUrgencyById: Record<string, UrgencyTier> = {};
  for (const t of work.tasks) taskUrgencyById[t.id] = taskUrgency({ dueDate: t.dueDate, isDone: isDoneStatus(t.status, work.statusesByProject[t.projectId]) }, today);

  const tab = (v: "board" | "ball" | "gantt" | "charts" | "productivity", label: string) => (
    <a href={`/pm?view=${v}`} className={`pm-tab${view === v ? " pm-tab--active" : ""}`} aria-current={view === v ? "page" : undefined}>{label}</a>
  );

  return (
    <>
      <PageHeader
        title={work.label}
        actions={<ScopeSwitcher current={work.scope} departments={options.departments} projects={options.projects} />}
      />
      {work.fellBackToAll && (
        <Card style={{ marginBottom: 16 }}>
          <EmptyNote>The scope you last had selected is no longer available — showing {PM_TERMS.crossProject} instead.</EmptyNote>
        </Card>
      )}

      <div className="pm-tabsrow">
        <div className="pm-tabs">
          {tab("board", PM_TERMS.board)}
          {tab("ball", PM_TERMS.ball)}
          {tab("gantt", PM_TERMS.gantt)}
          {tab("charts", PM_TERMS.charts)}
          {tab("productivity", PM_TERMS.productivity)}
        </div>
      </div>

      {view === "board" && (
        <BoardSection work={work} sp={sp} canEdit={canEdit} taskUrgencyById={taskUrgencyById} userId={userId} tenant={tenant} />
      )}
      {view === "ball" && (
        <BallSection work={work} sp={sp} canEdit={canEdit} taskUrgencyById={taskUrgencyById} userId={userId} tenant={tenant} />
      )}
      {view === "gantt" && (
        <GanttSection work={work} canEdit={canEdit} taskUrgencyById={taskUrgencyById} today={today} userId={userId} tenant={tenant} />
      )}
      {view === "charts" && <ChartsSection work={work} userId={userId} tenant={tenant} />}
      {view === "productivity" && <ProductivitySection userId={userId} tenant={tenant} scopeName={me.name} />}
    </>
  );
}

// ---------------------------------------------------------------------------
async function BoardSection({
  work, sp, canEdit, taskUrgencyById, userId, tenant,
}: {
  work: Awaited<ReturnType<typeof resolveScopeWork>>;
  sp: { swimlane?: string; tags?: string | string[]; ball?: string | string[]; responsible?: string | string[] };
  canEdit: boolean;
  taskUrgencyById: Record<string, UrgencyTier>;
  userId: string;
  tenant: string;
}) {
  const swimlane: PmSwimlane = isSwimlane(sp.swimlane) ? sp.swimlane : "status";
  const taskById = new Map(work.tasks.map((t) => [t.id, t]));
  const blockedIds = new Set(
    work.tasks.filter((t) => openDependencies(t, taskById, work.statusesByProject[t.projectId]).length > 0).map((t) => t.id),
  );
  const showStatusColors = Object.values(work.statusesByProject).some((s) => !isSynthDefaultStatuses(s));

  const registriesByProject = await scopeTagRegistries(userId, tenant, work.projectIds);
  const allTagLabels = distinctTagLabels(registriesByProject);
  const selectedTagLabels = parseTagFilterParam(sp.tags);
  const tagFilteredTasks = filterTasksByTagLabels(work.tasks, registriesByProject, selectedTagLabels);
  const taskTags: Record<string, Tag[]> = {};
  for (const t of work.tasks) taskTags[t.id] = resolveTags(t.tags, registriesByProject[t.projectId] ?? []);

  const selectedBallIds = parseTagFilterParam(sp.ball);
  const selectedResponsibleIds = parseTagFilterParam(sp.responsible);
  const ballOptions = ballFacetOptions(work.tasks);
  const responsibleOptions = responsibleFacetOptions(work.tasks);
  const facetFilteredTasks = filterTasksByResponsible(filterTasksByBall(tagFilteredTasks, selectedBallIds), selectedResponsibleIds);

  return (
    <>
      <Card style={{ marginBottom: 16 }}>
        <form className="lux-filters" method="get" aria-label="Board group by">
          <input type="hidden" name="view" value="board" />
          <label className="lux-filters__field">
            <span>Group by</span>
            <select name="swimlane" defaultValue={swimlane}>
              {PM_SWIMLANES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          {selectedTagLabels.map((l) => <input key={l} type="hidden" name="tags" value={l} />)}
          {selectedBallIds.map((id) => <input key={id} type="hidden" name="ball" value={id} />)}
          {selectedResponsibleIds.map((id) => <input key={id} type="hidden" name="responsible" value={id} />)}
          <div className="lux-filters__actions">
            <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm">Apply</button>
            {swimlane !== "status" && <a href="/pm?view=board" className="lux-btn lux-btn--ghost lux-btn--sm">Reset</a>}
          </div>
        </form>
      </Card>

      {allTagLabels.length > 0 && (
        <Card style={{ marginBottom: 16 }}>
          <form className="lux-filters" method="get" aria-label="Filter by tag">
            <input type="hidden" name="view" value="board" />
            <input type="hidden" name="swimlane" value={swimlane} />
            {selectedBallIds.map((id) => <input key={id} type="hidden" name="ball" value={id} />)}
            {selectedResponsibleIds.map((id) => <input key={id} type="hidden" name="responsible" value={id} />)}
            <div className="pm-tagfilter">
              <span className="pm-tagfilter__label">Tags</span>
              <div className="pm-tagfilter__options">
                {allTagLabels.map((label) => {
                  const rep = representativeTag(label, registriesByProject);
                  return (
                    <label key={label} className="pm-tagfilter__opt">
                      <input type="checkbox" name="tags" value={label} defaultChecked={selectedTagLabels.includes(label)} />
                      {rep ? <TagChip label={label} color={rep.color} /> : label}
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="lux-filters__actions">
              <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm">Apply</button>
              {selectedTagLabels.length > 0 && (
                <a href={`/pm?view=board&swimlane=${swimlane}`} className="lux-btn lux-btn--ghost lux-btn--sm">Reset</a>
              )}
            </div>
          </form>
        </Card>
      )}

      {(ballOptions.length > 0 || responsibleOptions.length > 0) && (
        <Card style={{ marginBottom: 16 }}>
          <form className="lux-filters" method="get" aria-label={`Filter by ${PM_TERMS.ball} or ${PM_TERMS.responsible}`}>
            <input type="hidden" name="view" value="board" />
            <input type="hidden" name="swimlane" value={swimlane} />
            {selectedTagLabels.map((l) => <input key={l} type="hidden" name="tags" value={l} />)}
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
              <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm">Apply</button>
              {(selectedBallIds.length > 0 || selectedResponsibleIds.length > 0) && (
                <a href={`/pm?view=board&swimlane=${swimlane}`} className="lux-btn lux-btn--ghost lux-btn--sm">Reset</a>
              )}
            </div>
          </form>
        </Card>
      )}

      {!canEdit && (
        <Card style={{ marginBottom: 16 }}>
          <EmptyNote>You can view this board but can&apos;t move cards here — that needs {PM_TERMS.ball.toLowerCase()}/task-management access.</EmptyNote>
        </Card>
      )}

      {facetFilteredTasks.length === 0 ? (
        <EmptyNote>{work.tasks.length === 0 ? `No work in ${work.label} yet.` : "No tasks match these filters."}</EmptyNote>
      ) : swimlane === "priority" ? (
        <Board columns={priorityColumns(facetFilteredTasks)} move={setTaskPriority} blockedIds={blockedIds} taskTags={taskTags} taskUrgency={taskUrgencyById} />
      ) : swimlane === "assignee" ? (
        <Board columns={leadWithUnassigned(assigneeColumns(facetFilteredTasks), "__unassigned")} move={reassignResponsible} blockedIds={blockedIds} taskTags={taskTags} taskUrgency={taskUrgencyById} />
      ) : (
        <Board
          columns={unionStatusColumns(facetFilteredTasks, work.statusesByProject)}
          move={moveTaskToStatusLabel}
          movePick={moveTask}
          colorColumns={showStatusColors}
          blockedIds={blockedIds}
          taskTags={taskTags}
          taskUrgency={taskUrgencyById}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Ball — its own tab (owner decision 2026-08-09, "Ball should be in this tab list so it doesn't
// clutter the board view"). This used to be Board's fourth "Group by" axis (`swimlane === "ball"`
// in `BoardSection` above); it is now the only place `ballColumns`/`reassignBall` render on this
// page. Same data, same filters, same write path (`reassignBall` — P4-B6, "anyone can pass the
// ball" is `pm.contribute`, not `pm.manage`; unchanged here) — only the "Group by" selector itself
// is gone, since this whole tab IS the ball grouping (nothing left to switch between).
async function BallSection({
  work, sp, canEdit, taskUrgencyById, userId, tenant,
}: {
  work: Awaited<ReturnType<typeof resolveScopeWork>>;
  sp: { tags?: string | string[]; ball?: string | string[]; responsible?: string | string[] };
  canEdit: boolean;
  taskUrgencyById: Record<string, UrgencyTier>;
  userId: string;
  tenant: string;
}) {
  const taskById = new Map(work.tasks.map((t) => [t.id, t]));
  const blockedIds = new Set(
    work.tasks.filter((t) => openDependencies(t, taskById, work.statusesByProject[t.projectId]).length > 0).map((t) => t.id),
  );

  const registriesByProject = await scopeTagRegistries(userId, tenant, work.projectIds);
  const allTagLabels = distinctTagLabels(registriesByProject);
  const selectedTagLabels = parseTagFilterParam(sp.tags);
  const tagFilteredTasks = filterTasksByTagLabels(work.tasks, registriesByProject, selectedTagLabels);
  const taskTags: Record<string, Tag[]> = {};
  for (const t of work.tasks) taskTags[t.id] = resolveTags(t.tags, registriesByProject[t.projectId] ?? []);

  const selectedBallIds = parseTagFilterParam(sp.ball);
  const selectedResponsibleIds = parseTagFilterParam(sp.responsible);
  const ballOptions = ballFacetOptions(work.tasks);
  const responsibleOptions = responsibleFacetOptions(work.tasks);
  const facetFilteredTasks = filterTasksByResponsible(filterTasksByBall(tagFilteredTasks, selectedBallIds), selectedResponsibleIds);

  return (
    <>
      {allTagLabels.length > 0 && (
        <Card style={{ marginBottom: 16 }}>
          <form className="lux-filters" method="get" aria-label="Filter by tag">
            <input type="hidden" name="view" value="ball" />
            {selectedBallIds.map((id) => <input key={id} type="hidden" name="ball" value={id} />)}
            {selectedResponsibleIds.map((id) => <input key={id} type="hidden" name="responsible" value={id} />)}
            <div className="pm-tagfilter">
              <span className="pm-tagfilter__label">Tags</span>
              <div className="pm-tagfilter__options">
                {allTagLabels.map((label) => {
                  const rep = representativeTag(label, registriesByProject);
                  return (
                    <label key={label} className="pm-tagfilter__opt">
                      <input type="checkbox" name="tags" value={label} defaultChecked={selectedTagLabels.includes(label)} />
                      {rep ? <TagChip label={label} color={rep.color} /> : label}
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="lux-filters__actions">
              <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm">Apply</button>
              {selectedTagLabels.length > 0 && (
                <a href="/pm?view=ball" className="lux-btn lux-btn--ghost lux-btn--sm">Reset</a>
              )}
            </div>
          </form>
        </Card>
      )}

      {(ballOptions.length > 0 || responsibleOptions.length > 0) && (
        <Card style={{ marginBottom: 16 }}>
          <form className="lux-filters" method="get" aria-label={`Filter by ${PM_TERMS.ball} or ${PM_TERMS.responsible}`}>
            <input type="hidden" name="view" value="ball" />
            {selectedTagLabels.map((l) => <input key={l} type="hidden" name="tags" value={l} />)}
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
              <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm">Apply</button>
              {(selectedBallIds.length > 0 || selectedResponsibleIds.length > 0) && (
                <a href="/pm?view=ball" className="lux-btn lux-btn--ghost lux-btn--sm">Reset</a>
              )}
            </div>
          </form>
        </Card>
      )}

      {!canEdit && (
        <Card style={{ marginBottom: 16 }}>
          <EmptyNote>You can view this board but can&apos;t move cards here — that needs {PM_TERMS.ball.toLowerCase()}/task-management access.</EmptyNote>
        </Card>
      )}

      {facetFilteredTasks.length === 0 ? (
        <EmptyNote>{work.tasks.length === 0 ? `No work in ${work.label} yet.` : "No tasks match these filters."}</EmptyNote>
      ) : (
        <Board
          columns={leadWithUnassigned(ballColumns(facetFilteredTasks), "__no_ball")}
          move={reassignBall}
          blockedIds={blockedIds}
          taskTags={taskTags}
          taskUrgency={taskUrgencyById}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
async function GanttSection({
  work, canEdit, taskUrgencyById, today, userId, tenant,
}: {
  work: Awaited<ReturnType<typeof resolveScopeWork>>;
  canEdit: boolean;
  taskUrgencyById: Record<string, UrgencyTier>;
  today: string;
  userId: string;
  tenant: string;
}) {
  const timeline = computeTimeline(work.tasks);
  if (!timeline) {
    return (
      <Card title={PM_TERMS.gantt}>
        <EmptyNote>
          {work.tasks.length === 0
            ? `No work in ${work.label} yet.`
            : `None of ${work.label}'s tasks have start/due dates yet. Add dates to see them on the timeline.`}
        </EmptyNote>
      </Card>
    );
  }

  // `scopeMilestones` already fetches exactly this scope's own projects, so every row here already
  // belongs to `work.projectIds` — no further filtering needed. `milestoneMarkers` below drops any
  // undated ones on its own (same as the department Timeline page).
  const milestones: Milestone[] = await scopeMilestones(userId, tenant, work.projectIds);
  const groups = groupTimelineBars(timeline.bars, "project", milestones.map((m) => ({ id: m.id, name: m.name })));
  const markers = milestoneMarkers(timeline, milestones);
  const edges = dependencyEdges(timeline.bars);
  const burndown = await scopeBurndownOverlay(userId, tenant, work, timeline);

  return (
    <Card
      title={PM_TERMS.gantt}
      headerRight={<span style={{ font: "700 10px var(--font-body)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>{work.projectIds.length} project{work.projectIds.length === 1 ? "" : "s"}</span>}
    >
      <Gantt
        timeline={timeline}
        groups={groups}
        groupBy="project"
        milestones={markers}
        depEdges={edges}
        interactive
        canEdit={canEdit}
        burndown={burndown}
        taskUrgency={taskUrgencyById}
        todayISO={today}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
async function ChartsSection({ work, userId, tenant }: { work: Awaited<ReturnType<typeof resolveScopeWork>>; userId: string; tenant: string }) {
  if (work.tasks.length === 0) {
    return <Card title={PM_TERMS.charts}><EmptyNote>No work in {work.label} yet.</EmptyNote></Card>;
  }
  const data = await scopeChartsData(userId, tenant, work);
  return (
    <Card
      title={PM_TERMS.charts}
      headerRight={<span style={{ font: "700 10px var(--font-body)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>{work.projectIds.length} project{work.projectIds.length === 1 ? "" : "s"}</span>}
    >
      <Charts kpis={data.kpis} flow={data.flow} burndownSeries={data.burndownSeries} burndownOverlay={data.burndownOverlay} tagRows={data.tagRows} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Productivity (P4-E3/E4, plan §1.7) — self-view only for now (see the header note above this
// component). `getProductivity` degrades a 404 (stale backend / module disabled) to `null`; a 403
// is deliberately NOT swallowed by the reader (self is always allowed server-side, so hitting one
// here would mean something is actually wrong, not "no data yet") — surfaced honestly rather than
// silently reproduced as an empty state.
async function ProductivitySection({ userId, tenant, scopeName }: { userId: string; tenant: string; scopeName: string }) {
  let report;
  try {
    report = await getProductivity(userId, tenant, {});
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) {
      return (
        <Card title={PM_TERMS.productivity}>
          <EmptyNote>You can&apos;t view this productivity series — {e.message}.</EmptyNote>
        </Card>
      );
    }
    throw e;
  }
  if (!report) {
    return (
      <Card title={PM_TERMS.productivity}>
        <EmptyNote>Productivity data isn&apos;t available yet.</EmptyNote>
      </Card>
    );
  }
  return (
    <Card
      title={PM_TERMS.productivity}
      headerRight={<span style={{ font: "700 10px var(--font-body)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>{scopeName}</span>}
    >
      <Productivity report={report} scopeName={scopeName} viewingSelf />
    </Card>
  );
}
