import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import {
  getDepartment, parseBoardFocus, encodeBoardFocus, filterTasksByFocus,
  ballColumns, filterTasksByBall, filterTasksByResponsible, ballFacetOptions, responsibleFacetOptions,
} from "@/lib/departments";
import {
  openDependencies, listTags, resolveTags, distinctTagLabels, filterTasksByTagLabels,
  parseTagFilterParam, isDoneStatus, taskUrgency, type Tag, type UrgencyTier,
} from "@/lib/pm";
import { reassignBall } from "@/lib/pmActions";
import { PM_TERMS } from "@/lib/pmVocabulary";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Board } from "@/components/pm/Board";
import { FacetFilters } from "@/components/pm/FacetFilters";
import { TAG_COLOR_HEX } from "@/lib/tagColors";
import { BALL_GATE_CAPABILITY, leadWithUnassigned } from "@/app/(app)/pm/page-helpers";

type Params = Promise<{ deptId: string }>;
// Same shape as ../board/page.tsx's own SearchParams, minus `swimlane` (this whole tab IS the
// ball grouping — nothing left to switch between, same precedent as /pm's Ball tab).
type SearchParams = Promise<{ focus?: string; tags?: string | string[]; ball?: string | string[]; responsible?: string | string[] }>;

function representativeTag(label: string, registriesByProject: Record<string, Tag[]>): Tag | undefined {
  for (const reg of Object.values(registriesByProject)) {
    const hit = reg.find((t) => t.label === label);
    if (hit) return hit;
  }
  return undefined;
}

// Ball — its own tab (owner decision 2026-08-10: "Ball gets its own tab in EVERY
// project-management surface — not just /pm — and stops polluting the board"). This used to be
// the Board tab's "ball" Group-by axis (../board/page.tsx); it is now the only place
// `ballColumns`/`reassignBall` render in this department console. Same Focus filter (Whole dept/
// Division/Just me), same tag/ball/responsible facets, same write path — only the "Group by"
// selector is gone.
export default async function DepartmentBallPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
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

  // The Ball tab's OWN gate — deliberately NOT a Board/Timeline `pm.manage` check. `reassignBall`
  // (lib/pmActions.ts) already submits on `pm.contribute` ("anyone can pass the ball" — same
  // BALL_GATE_CAPABILITY the /pm Ball tab uses; see its doc comment in app/(app)/pm/page-helpers.ts).
  const canPassBall = can(me, BALL_GATE_CAPABILITY, tenant);

  const focusedTasks = filterTasksByFocus(dept.tasks, dept.divisions, focus, userId);
  const taskById = new Map(dept.tasks.map((t) => [t.id, t]));
  const blockedIds = new Set(dept.tasks.filter((t) => openDependencies(t, taskById, dept.statusesByProject[t.projectId]).length > 0).map((t) => t.id));
  const focusLabel =
    focus.mode === "me" ? "you"
    : focus.mode === "division" ? (dept.divisions.find((d) => d.id === focus.divisionId)?.name ?? "this division")
    : dept.name;

  const projectIds = [...new Set(dept.tasks.map((t) => t.projectId))];
  const registries = await Promise.all(projectIds.map((pid) => listTags(userId, tenant, pid)));
  const registriesByProject: Record<string, Tag[]> = {};
  projectIds.forEach((pid, i) => { registriesByProject[pid] = registries[i]; });
  const allTagLabels = distinctTagLabels(registriesByProject);
  const selectedTagLabels = parseTagFilterParam(sp.tags);
  const tagFilteredTasks = filterTasksByTagLabels(focusedTasks, registriesByProject, selectedTagLabels);
  const taskTags: Record<string, Tag[]> = {};
  for (const t of dept.tasks) taskTags[t.id] = resolveTags(t.tags, registriesByProject[t.projectId] ?? []);

  const selectedBallIds = parseTagFilterParam(sp.ball);
  const selectedResponsibleIds = parseTagFilterParam(sp.responsible);
  const ballOptions = ballFacetOptions(dept.tasks);
  const responsibleOptions = responsibleFacetOptions(dept.tasks);
  const facetFilteredTasks = filterTasksByResponsible(filterTasksByBall(tagFilteredTasks, selectedBallIds), selectedResponsibleIds);

  const today = new Date().toISOString().slice(0, 10);
  const taskUrgencyById: Record<string, UrgencyTier> = {};
  for (const t of dept.tasks) taskUrgencyById[t.id] = taskUrgency({ dueDate: t.dueDate, isDone: isDoneStatus(t.status, dept.statusesByProject[t.projectId]) }, today);

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
        <div style={{ font: "700 10px var(--font-body)", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>{PM_TERMS.ball}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link href="/pipeline" className="lux-btn lux-btn--ghost lux-btn--sm">Delivery Pipeline</Link>
          <Link href="/projects" className="lux-btn lux-btn--ghost lux-btn--sm">All projects</Link>
        </div>
      </div>

      <Card style={{ marginBottom: 16 }}>
        <form className="lux-filters" method="get" aria-label="Ball focus">
          <label className="lux-filters__field">
            <span>Focus</span>
            <select name="focus" defaultValue={encodeBoardFocus(focus)}>
              <option value="dept">Whole dept</option>
              {dept.divisions.map((d) => (
                <option key={d.id} value={`division:${d.id}`}>Division: {d.name}</option>
              ))}
              <option value="me">Just me</option>
            </select>
          </label>
          {selectedTagLabels.map((l) => <input key={l} type="hidden" name="tags" value={l} />)}
          {selectedBallIds.map((id) => <input key={id} type="hidden" name="ball" value={id} />)}
          {selectedResponsibleIds.map((id) => <input key={id} type="hidden" name="responsible" value={id} />)}
          <div className="lux-filters__actions">
            <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm">Apply</button>
            {focus.mode !== "dept" && (
              <a href={`/departments/${deptId}/ball`} className="lux-btn lux-btn--ghost lux-btn--sm">Reset</a>
            )}
          </div>
        </form>
      </Card>

      <FacetFilters
        basePath={`/departments/${deptId}/ball`}
        hidden={{ focus: encodeBoardFocus(focus) }}
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

      {!canPassBall && (
        <Card style={{ marginBottom: 16 }}>
          <EmptyNote>You can view this board but can&apos;t pass the {PM_TERMS.ball.toLowerCase()} here — passing it is open to any member of this company&apos;s project team, so that&apos;s the access to ask for.</EmptyNote>
        </Card>
      )}

      {facetFilteredTasks.length === 0 ? (
        <EmptyNote>
          {focusedTasks.length === 0
            ? (focus.mode === "dept"
                ? `No work routed to this department yet. Tasks assigned to ${dept.name}, its divisions, or its people appear here.`
                : `No work routed to ${focusLabel} yet.`)
            : "No tasks match these filters."}
        </EmptyNote>
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
