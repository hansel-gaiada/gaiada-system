import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import {
  getDepartment, parseBoardFocus, encodeBoardFocus, filterTasksByFocus, groupBoardLanes,
  type BoardSwimlane,
} from "@/lib/departments";
import { groupByStatus } from "@/lib/pm";
import { moveTask } from "@/lib/pmActions";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Board, BoardLanes } from "@/components/pm/Board";

type Params = Promise<{ deptId: string }>;
// Next 15: searchParams is async. `focus`: "dept" | "me" | "division:<id>"
// (WSUX-7/R-2 — ORG-CORE's Whole dept/Division/Just me); `swimlane`: the
// group-by (Status default, or Division/Person).
type SearchParams = Promise<{ focus?: string; swimlane?: string }>;

const SWIMLANES: { value: BoardSwimlane; label: string }[] = [
  { value: "status", label: "Status" },
  { value: "division", label: "Division" },
  { value: "person", label: "Person" },
];

// Board — the department's working kanban (decision #10 split: this used to
// share a tab with the owned-project rollup, which now lives on the Projects
// tab). Tasks routed to this department, its divisions, or its people appear
// here; drag a card to move it.
//
// WSUX-7 (R-2): grafts the daily-work spec's focus model (Whole dept /
// Division:<name> / Just me) and swimlane-by (Status/Division/Person) in as a
// plain GET form — no client JS, matching the Activity tab's filter pattern.
// Both are pure filters/groupings over `dept.tasks` (lib/departments.ts,
// reusing the SAME division/person membership `scan()` already computed —
// no re-traversal of the org tree). Focus stays server-authoritative: an
// unknown/foreign `?focus=division:<id>` (not one of this dept's own
// divisions) resolves to zero tasks rather than silently falling back to
// "whole dept".
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
  const swimlane: BoardSwimlane = sp.swimlane === "division" || sp.swimlane === "person" ? sp.swimlane : "status";

  const focusedTasks = filterTasksByFocus(dept.tasks, dept.divisions, focus, userId);
  const focusLabel =
    focus.mode === "me" ? "you"
    : focus.mode === "division" ? (dept.divisions.find((d) => d.id === focus.divisionId)?.name ?? "this division")
    : dept.name;

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
        <div style={{ font: "700 10px var(--font-body)", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>Work board</div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link href="/pipeline" className="lux-btn lux-btn--ghost lux-btn--sm">Delivery Pipeline</Link>
          <Link href="/projects" className="lux-btn lux-btn--ghost lux-btn--sm">All projects</Link>
        </div>
      </div>

      <Card style={{ marginBottom: 16 }}>
        <form className="lux-filters" method="get" aria-label="Board focus">
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
          <label className="lux-filters__field">
            <span>Group by</span>
            <select name="swimlane" defaultValue={swimlane}>
              {SWIMLANES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          <div className="lux-filters__actions">
            <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm">Apply</button>
            {(focus.mode !== "dept" || swimlane !== "status") && (
              <a href={`/departments/${deptId}/board`} className="lux-btn lux-btn--ghost lux-btn--sm">Reset</a>
            )}
          </div>
        </form>
      </Card>

      {focusedTasks.length === 0 ? (
        <Card>
          <EmptyNote>
            {focus.mode === "dept"
              ? `No work routed to this department yet. Tasks assigned to ${dept.name}, its divisions, or its people appear here.`
              : `No work routed to ${focusLabel} yet.`}
          </EmptyNote>
        </Card>
      ) : swimlane === "status" ? (
        <Board columns={groupByStatus(focusedTasks)} move={moveTask} />
      ) : (
        <BoardLanes lanes={groupBoardLanes(focusedTasks, dept.divisions, swimlane)} />
      )}
    </>
  );
}
