import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import {
  getDepartment, parseBoardFocus, encodeBoardFocus, filterTasksByFocus,
  priorityColumns, assigneeColumns, divisionColumns, divisionStatusGrid, assigneeStatusGrid,
  filterTasksByBall, filterTasksByResponsible, ballFacetOptions, responsibleFacetOptions,
  type BoardSwimlane,
} from "@/lib/departments";
import {
  unionStatusColumns, isSynthDefaultStatuses, openDependencies, listTags, resolveTags, distinctTagLabels, filterTasksByTagLabels,
  parseTagFilterParam, isDoneStatus, taskUrgency, type Tag, type UrgencyTier,
} from "@/lib/pm";
import { moveTask, moveTaskToStatusLabel, setTaskPriority, reassignResponsible, setDivisionAssignee } from "@/lib/pmActions";
import { PM_TERMS } from "@/lib/pmVocabulary";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Board, BoardGrid } from "@/components/pm/Board";
import { FacetFilters } from "@/components/pm/FacetFilters";
import { TAG_COLOR_HEX } from "@/lib/tagColors";

type Params = Promise<{ deptId: string }>;
// Next 15: searchParams is async. `focus`: "dept" | "me" | "division:<id>"
// (WSUX-7/R-2 — ORG-CORE's Whole dept/Division/Just me); `swimlane`: the
// group-by (Status default, or Assignee/Priority/Division — all drag-capable,
// P1-03 unified every axis through one `Board`); `tags`: the P2-02 tag
// filter, matched by LABEL across projects (D-1) since a department's board
// spans multiple projects, each with its own tag id space.
// P4-B9: `ball`/`responsible` are the two filter facets, same shape as `tags`, now rendered
// through the shared `FacetFilters` panel (components/pm/FacetFilters.tsx) rather than a
// hand-rolled checkbox Card — see that file's header for why (findable/clearable/shows-active).
type SearchParams = Promise<{ focus?: string; swimlane?: string; tags?: string | string[]; ball?: string | string[]; responsible?: string | string[] }>;

// A department's board can span several projects, each with its own tag
// registry (different ids can share a label — D-1). Picks the first registry
// hit for a label purely for the filter checkbox's display color; it never
// affects matching (that's label-based, see filterTasksByTagLabels).
function representativeTag(label: string, registriesByProject: Record<string, Tag[]>): Tag | undefined {
  for (const reg of Object.values(registriesByProject)) {
    const hit = reg.find((t) => t.label === label);
    if (hit) return hit;
  }
  return undefined;
}

// Ball moved OUT to its own tab (owner decision 2026-08-10, same pass as `/pm`'s: "Ball gets its
// own tab in EVERY project-management surface — not just /pm — and stops polluting the board").
// It used to be one more "Group by" axis here; it now lives only in `../ball/page.tsx`
// (`ballColumns`/`reassignBall`, imported there instead). `DeptBoardSwimlane` is a local narrowing
// of the shared `BoardSwimlane` type (lib/departments.ts) — same precedent as `/pm/page-helpers.ts`'s
// own `PmSwimlane`. A stale bookmarked `?swimlane=ball` degrades to the `status` default below
// rather than throwing.
//
// P4-B6: "assignee" is keyed off `responsibleId` (`assigneeColumns`, lib/departments.ts) — it IS
// the Responsible board; the persisted `?swimlane=` value stays `assignee` for old bookmarked
// links, only its label changes.
type DeptBoardSwimlane = Exclude<BoardSwimlane, "ball">;
const SWIMLANES: { value: DeptBoardSwimlane; label: string }[] = [
  { value: "status", label: "Status" },
  { value: "assignee", label: PM_TERMS.responsible },
  { value: "priority", label: "Priority" },
  { value: "division", label: "Division" },
  // P2-09 (design spec §8) — true 2-axis grid: rows=Division/Assignee, columns=Status. Kept as
  // two more options on this SAME `?swimlane=` select rather than a second control/query param,
  // so the GET-form/URL contract doesn't grow.
  { value: "grid-division", label: "Division × Status (grid)" },
  { value: "grid-assignee", label: "Assignee × Status (grid)" },
];

function isSwimlane(v: string | undefined): v is DeptBoardSwimlane {
  return v === "assignee" || v === "priority" || v === "division" || v === "grid-division" || v === "grid-assignee";
}

// Board — the department's working kanban (decision #10 split: this used to
// share a tab with the owned-project rollup, which now lives on the Projects
// tab). Tasks routed to this department, its divisions, or its people appear
// here; drag a card to move it.
//
// WSUX-7 (R-2): grafts the daily-work spec's focus model (Whole dept /
// Division:<name> / Just me) and swimlane-by (Status/Assignee/Priority/Division
// — P1-03: every axis is now drag-capable through one `Board`, no more
// read-only BoardLanes) in as a plain GET form — no client JS, matching the
// Activity tab's filter pattern. Focus is a pure filter over `dept.tasks`
// (lib/departments.ts, reusing the SAME division/person membership `scan()`
// already computed — no re-traversal of the org tree). Focus stays
// server-authoritative: an unknown/foreign `?focus=division:<id>` (not one of
// this dept's own divisions) resolves to zero tasks rather than silently
// falling back to "whole dept".
export default async function DepartmentBoardPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const sp = await searchParams;
  const focus = parseBoardFocus(sp.focus);
  const swimlane: DeptBoardSwimlane = isSwimlane(sp.swimlane) ? sp.swimlane : "status";

  const focusedTasks = filterTasksByFocus(dept.tasks, dept.divisions, focus, userId);
  const taskById = new Map(dept.tasks.map((t) => [t.id, t]));
  // P2-05: each task's blocked-by-open-deps check resolves "done" via ITS OWN
  // project's status registry (deps are same-project).
  const blockedIds = new Set(dept.tasks.filter((t) => openDependencies(t, taskById, dept.statusesByProject[t.projectId]).length > 0).map((t) => t.id));
  const showStatusColors = Object.values(dept.statusesByProject).some((s) => !isSynthDefaultStatuses(s));
  const focusLabel =
    focus.mode === "me" ? "you"
    : focus.mode === "division" ? (dept.divisions.find((d) => d.id === focus.divisionId)?.name ?? "this division")
    : dept.name;

  // Tags (P2-02, design spec §6, D-1): fetch every distinct project's own
  // registry once, then match/filter/display by LABEL across the whole
  // department board (ids aren't comparable across projects).
  const projectIds = [...new Set(dept.tasks.map((t) => t.projectId))];
  const registries = await Promise.all(projectIds.map((pid) => listTags(userId, tenant, pid)));
  const registriesByProject: Record<string, Tag[]> = {};
  projectIds.forEach((pid, i) => { registriesByProject[pid] = registries[i]; });
  const allTagLabels = distinctTagLabels(registriesByProject);
  const selectedTagLabels = parseTagFilterParam(sp.tags);
  const tagFilteredTasks = filterTasksByTagLabels(focusedTasks, registriesByProject, selectedTagLabels);
  const taskTags: Record<string, Tag[]> = {};
  for (const t of dept.tasks) taskTags[t.id] = resolveTags(t.tags, registriesByProject[t.projectId] ?? []);

  // P4-B9: Ball/Responsible filter facets — options from the dept's FULL task set (so filtering
  // never shrinks its own option list), applied on top of focus + tag filtering.
  const selectedBallIds = parseTagFilterParam(sp.ball);
  const selectedResponsibleIds = parseTagFilterParam(sp.responsible);
  const ballOptions = ballFacetOptions(dept.tasks);
  const responsibleOptions = responsibleFacetOptions(dept.tasks);
  const facetFilteredTasks = filterTasksByResponsible(filterTasksByBall(tagFilteredTasks, selectedBallIds), selectedResponsibleIds);

  // P4-G5: urgency, resolved ONCE for this whole render — `today` a single date string, `isDone`
  // per task against ITS OWN project's status registry (same precedent as the `blockedIds` computed
  // above). Passed to every Board/BoardGrid call below, whichever axis is active.
  const today = new Date().toISOString().slice(0, 10);
  const taskUrgencyById: Record<string, UrgencyTier> = {};
  for (const t of dept.tasks) taskUrgencyById[t.id] = taskUrgency({ dueDate: t.dueDate, isDone: isDoneStatus(t.status, dept.statusesByProject[t.projectId]) }, today);

  return (
    <>
      {/* ONE control strip. This was three stacked full-width blocks — an eyebrow row with two
          buttons, a Card holding Focus/Group-by, and a third Card holding the (collapsed, so
          effectively empty-looking) Filters disclosure. Measured on the built page, the first column
          began at y=564 of a 1100px viewport, and below the fold entirely on a phone. Same controls,
          same GET-form contract, one row. */}
      <div className="pm-boardbar">
        <span className="type-eyebrow pm-boardbar__label">Work board</span>
        <form className="pm-boardbar__form" method="get" aria-label="Board focus">
          <label className="pm-boardbar__field">
            <span>Focus</span>
            <select name="focus" defaultValue={encodeBoardFocus(focus)}>
              <option value="dept">Whole dept</option>
              {dept.divisions.map((d) => (
                <option key={d.id} value={`division:${d.id}`}>Division: {d.name}</option>
              ))}
              <option value="me">Just me</option>
            </select>
          </label>
          <label className="pm-boardbar__field">
            <span>Group by</span>
            <select name="swimlane" defaultValue={swimlane}>
              {SWIMLANES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          {selectedTagLabels.map((l) => <input key={l} type="hidden" name="tags" value={l} />)}
          {selectedBallIds.map((id) => <input key={id} type="hidden" name="ball" value={id} />)}
          {selectedResponsibleIds.map((id) => <input key={id} type="hidden" name="responsible" value={id} />)}
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm">Apply</button>
          {(focus.mode !== "dept" || swimlane !== "status") && (
            <a href={`/departments/${deptId}/board`} className="lux-btn lux-btn--ghost lux-btn--sm">Reset</a>
          )}
        </form>
        {/* Tag/Ball/Responsible filters: ONE shared, findable/clearable panel (components/pm/
          FacetFilters.tsx) — replaces what used to be two separate always-open checkbox Cards.
          `bare` because it now sits in the strip above rather than in a Card of its own. */}
        <FacetFilters
        bare
        basePath={`/departments/${deptId}/board`}
        hidden={{ focus: encodeBoardFocus(focus), swimlane }}
        groups={[
          {
            key: "tags", label: PM_TERMS.tags, selected: selectedTagLabels,
            options: allTagLabels.map((label) => {
              const rep = representativeTag(label, registriesByProject);
              return { id: label, label, swatch: rep ? <span className="pm-col__dot" aria-hidden style={{ background: TAG_COLOR_HEX[rep.color]?.onLight ?? "currentColor" }} /> : undefined };
            }),
          },
          { key: "ball", label: PM_TERMS.ball, selected: selectedBallIds, options: ballOptions },
          { key: "responsible", label: PM_TERMS.responsible, selected: selectedResponsibleIds, options: responsibleOptions },
        ]}
        />

        <div className="pm-boardbar__links">
          <Link href="/pipeline" className="lux-btn lux-btn--ghost lux-btn--sm">Delivery Pipeline</Link>
          <Link href="/projects" className="lux-btn lux-btn--ghost lux-btn--sm">All projects</Link>
        </div>
      </div>

      {facetFilteredTasks.length === 0 ? (
        <EmptyNote>
            {focusedTasks.length === 0
              ? (focus.mode === "dept"
                  ? `No work routed to this department yet. Tasks assigned to ${dept.name}, its divisions, or its people appear here.`
                  : `No work routed to ${focusLabel} yet.`)
              : "No tasks match these filters."}
          </EmptyNote>
      ) : swimlane === "priority" ? (
        <Board columns={priorityColumns(facetFilteredTasks)} move={setTaskPriority} blockedIds={blockedIds} taskTags={taskTags} taskUrgency={taskUrgencyById} />
      ) : swimlane === "assignee" ? (
        <Board columns={assigneeColumns(facetFilteredTasks)} move={reassignResponsible} blockedIds={blockedIds} taskTags={taskTags} taskUrgency={taskUrgencyById} />
      ) : swimlane === "division" ? (
        <Board columns={divisionColumns(facetFilteredTasks, dept.divisions)} move={setDivisionAssignee} blockedIds={blockedIds} taskTags={taskTags} taskUrgency={taskUrgencyById} />
      ) : swimlane === "grid-division" ? (
        // §8 true 2-axis grid: rows=Division, columns=Status (union-by-label, same as the flat
        // status swimlane below). Within-row drop = status change; cross-row drop = the same
        // division-axis responsible popover/commit as the flat Division swimlane above.
        <BoardGrid
          rows={divisionStatusGrid(facetFilteredTasks, dept.divisions, dept.statusesByProject)}
          columnMove={moveTaskToStatusLabel}
          columnMovePick={moveTask}
          rowMove={setDivisionAssignee}
          rowAxisLabel="Division"
          colorColumns={showStatusColors}
          blockedIds={blockedIds}
          taskTags={taskTags}
          taskUrgency={taskUrgencyById}
        />
      ) : swimlane === "grid-assignee" ? (
        <BoardGrid
          rows={assigneeStatusGrid(facetFilteredTasks, dept.statusesByProject)}
          columnMove={moveTaskToStatusLabel}
          columnMovePick={moveTask}
          rowMove={reassignResponsible}
          rowAxisLabel="Assignee"
          colorColumns={showStatusColors}
          blockedIds={blockedIds}
          taskTags={taskTags}
          taskUrgency={taskUrgencyById}
        />
      ) : (
        // Status axis on the dept board = union-by-label (§7 D-4): columns are the
        // distinct labels across projects; a drop maps to the card's own project's
        // matching status id, or opens the pick popover on no-match (movePick).
        <Board columns={unionStatusColumns(facetFilteredTasks, dept.statusesByProject)} move={moveTaskToStatusLabel} movePick={moveTask} colorColumns={showStatusColors} blockedIds={blockedIds} taskTags={taskTags} taskUrgency={taskUrgencyById} />
      )}
    </>
  );
}
