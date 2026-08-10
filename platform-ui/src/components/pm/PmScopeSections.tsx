// Shared PM scope-workspace sections — Overview (was "Board"), Ball, Timeline (was "Gantt"),
// Charts, Productivity — factored out of `/pm/page.tsx` (2026-08-10 owner directive: "Business and
// Departments must use the same interface as /pm... one component set parameterized by scope, not
// three parallel implementations"). This is that one set. Every caller hands in a `work` object
// from `resolveScopeWork` (`lib/pmScope-data.ts`) — the SAME reader every scope (a project, a
// department, or the whole tenant/"@all") goes through, so a surface can never quietly grow its own
// hand-written query with a different column set (the exact outage class this rename program is
// closing alongside the naming). A "surface" using these sections only ever differs in: which
// `PmScope` it resolves `work` from, and its own `basePath` for building this tab's hrefs — nothing
// about the sections themselves.
//
// Deliberately NOT "use client" (same rationale as ProjectWorkspaceView.tsx, which this mirrors):
// every section here is an async Server Component that reads server-only `lib/pm.ts`/
// `lib/pmScope-data.ts` helpers directly. Only mountable from a server page/component.
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Board } from "@/components/pm/Board";
import { Gantt } from "@/components/pm/Gantt";
import { Charts } from "@/components/pm/Charts";
import { Productivity } from "@/components/pm/Productivity";
import { FacetFilters, type FacetGroupSpec } from "@/components/pm/FacetFilters";
import { PM_TERMS } from "@/lib/pmVocabulary";
import { PlatformError } from "@/lib/platform";
import {
  resolveScopeWork, scopeTagRegistries, scopeMilestones, scopeBurndownOverlay, scopeChartsData,
} from "@/lib/pmScope-data";
import {
  unionStatusColumns, isSynthDefaultStatuses, openDependencies, resolveTags, distinctTagLabels,
  filterTasksByTagLabels, parseTagFilterParam, isDoneStatus, taskUrgency, getProductivity,
  computeTimeline, groupTimelineBars, milestoneMarkers, dependencyEdges,
  type Tag, type UrgencyTier, type Milestone,
} from "@/lib/pm";
import {
  assigneeColumns, ballColumns, priorityColumns, filterTasksByBall, filterTasksByResponsible,
  ballFacetOptions, responsibleFacetOptions,
} from "@/lib/departments";
import { moveTask, moveTaskToStatusLabel, setTaskPriority, reassignResponsible, reassignBall } from "@/lib/pmActions";
// Pure helpers stay owned by the `/pm` route (they are not page.tsx itself, so re-exporting them
// from a plain .ts file is unaffected by the "page.tsx may only export default" restriction) —
// imported here rather than duplicated, per this whole ticket's "no fourth shape" rule.
import { PM_SWIMLANES, isSwimlane, representativeTag, leadWithUnassigned, BALL_GATE_CAPABILITY, type PmSwimlane } from "@/app/(app)/pm/page-helpers";
import { TAG_COLOR_HEX } from "@/lib/tagColors";

type ScopeWork = Awaited<ReturnType<typeof resolveScopeWork>>;

function tagGroup(allTagLabels: string[], registriesByProject: Record<string, Tag[]>, selected: string[]): FacetGroupSpec {
  return {
    key: "tags",
    label: PM_TERMS.tags,
    selected,
    options: allTagLabels.map((label) => {
      const rep = representativeTag(label, registriesByProject);
      return { id: label, label, swatch: rep ? <TagSwatch color={rep.color} /> : undefined };
    }),
  };
}
function ballGroup(options: { id: string; label: string }[], selected: string[]): FacetGroupSpec {
  return { key: "ball", label: PM_TERMS.ball, options, selected };
}
function responsibleGroup(options: { id: string; label: string }[], selected: string[]): FacetGroupSpec {
  return { key: "responsible", label: PM_TERMS.responsible, options, selected };
}

// Tiny inline colour dot — avoids pulling in the full `TagChip` (which renders the label text
// too; FacetFilters already renders the label itself once, in the chip/checkbox around this).
// Same `TAG_COLOR_HEX` lookup TagChip.tsx itself uses; a hex inline style here is the established
// pattern for a per-tag dynamic colour (design tokens can't enumerate every tag's own colour), not
// a `tokens.test.ts` violation — that guard only scans `.css` files, not inline styles.
function TagSwatch({ color }: { color: Tag["color"] }) {
  return <span className="pm-col__dot" aria-hidden style={{ background: TAG_COLOR_HEX[color]?.onLight ?? "currentColor" }} />;
}

// ---------------------------------------------------------------------------
// Overview (was "Board" — owner decision 2026-08-10; PM_TERMS.board carries the label everywhere).
export async function OverviewSection({
  basePath, work, sp, canEdit, taskUrgencyById, userId, tenant,
}: {
  basePath: string;
  work: ScopeWork;
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
        <form className="lux-filters" method="get" action={basePath} aria-label={`${PM_TERMS.board} group by`}>
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
            {swimlane !== "status" && <a href={`${basePath}?view=board`} className="lux-btn lux-btn--ghost lux-btn--sm">Reset</a>}
          </div>
        </form>
      </Card>

      <FacetFilters
        basePath={basePath}
        hidden={{ view: "board", swimlane }}
        groups={[
          tagGroup(allTagLabels, registriesByProject, selectedTagLabels),
          ballGroup(ballOptions, selectedBallIds),
          responsibleGroup(responsibleOptions, selectedResponsibleIds),
        ]}
      />

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
// Ball — its own tab everywhere (owner decision: it must never again be a Board "Group by" axis).
// `canPassBall` (NOT Overview/Timeline's `canEdit`) is this tab's own gate — see
// `BALL_GATE_CAPABILITY`'s doc comment in `app/(app)/pm/page-helpers.ts`.
export async function BallSection({
  basePath, work, sp, canPassBall, taskUrgencyById, userId, tenant,
}: {
  basePath: string;
  work: ScopeWork;
  sp: { tags?: string | string[]; ball?: string | string[]; responsible?: string | string[] };
  canPassBall: boolean;
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
      <FacetFilters
        basePath={basePath}
        hidden={{ view: "ball" }}
        groups={[
          tagGroup(allTagLabels, registriesByProject, selectedTagLabels),
          ballGroup(ballOptions, selectedBallIds),
          responsibleGroup(responsibleOptions, selectedResponsibleIds),
        ]}
      />

      {!canPassBall && (
        <Card style={{ marginBottom: 16 }}>
          <EmptyNote>You can view this board but can&apos;t pass the {PM_TERMS.ball.toLowerCase()} here — passing it is open to any member of this company&apos;s project team, so that&apos;s the access to ask for.</EmptyNote>
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
// Timeline (was "Gantt" — owner decision 2026-08-10). `pm-timeline-widen` (shell.css) is the real
// fix for "the Timeline must be far bigger": the constraint was never inside Gantt.tsx (it already
// has horizontal scroll + Day/Week/Month zoom) — it was the app shell's own `.erp-main__inner`
// capping every page's content column at 1180px. See shell.css's comment above the `:has()` rule.
export async function TimelineSection({
  basePath, work, canEdit, taskUrgencyById, today, userId, tenant,
}: {
  basePath: string;
  work: ScopeWork;
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
    <div className="pm-timeline-widen">
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
    </div>
  );
}

// ---------------------------------------------------------------------------
export async function ChartsSection({ work, userId, tenant }: { work: ScopeWork; userId: string; tenant: string }) {
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
// Productivity — self-view only (see the original /pm ticket note this carries forward). Ignores
// `work`/scope entirely: it is PERSON-grain, not project/department/tenant-grain, so re-scoping the
// other sections has no meaning for it. `getProductivity` degrades a 404 (stale backend/module
// disabled) to `null`; a 403 is deliberately NOT swallowed (self is always allowed server-side, so
// hitting one here means something is actually wrong, not "no data yet").
export async function ProductivitySection({ userId, tenant, scopeName }: { userId: string; tenant: string; scopeName: string }) {
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
