import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { listProjects } from "@/lib/entities";
import { isDoneStatus, projectUrgency, type PmTask } from "@/lib/pm";
import { formatDate } from "@/lib/format";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { UrgencyChip } from "@/components/pm/UrgencyChip";
import { taskDateEnvelope, tallyProjectTasks, targetNote } from "./page-helpers";
// The `.dept-proj__*` classes live in the console sheet. `[deptId]/layout.tsx` already imports it,
// so this is belt-and-braces — but a page that owns classes should say where they come from.
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// Projects — the projects this department OWNS (department_id === deptId,
// P1-01), shown even with no tasks routed yet. Cross-department work assigned
// to this department still shows on the Board tab (routed by task assignee),
// not here — this tab is the ownership rollup.
export default async function DepartmentProjectsPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const [dept, allProjects] = await Promise.all([
    getDepartment(userId, tenant, deptId),
    listProjects(userId, tenant).catch(() => []),
  ]);
  if (!dept) notFound();

  // Task counts per project, from the work routed into this department. P4-H3: was a literal
  // `t.status === "done"`, disagreeing with the Urgency column's `isDoneStatus` the moment a
  // project used a custom (renamed or extra) done status — see `tallyProjectTasks` above.
  const byProject = tallyProjectTasks(dept.tasks, dept.statusesByProject);
  const owned = allProjects.filter((p) => p.department_id === deptId);

  // One pass, keyed by project, reused below for the urgency roll-up AND the new Range column
  // (P4-H3) so both read the identical task subset.
  const tasksByProject = new Map<string, PmTask[]>();
  for (const t of dept.tasks) {
    const arr = tasksByProject.get(t.projectId) ?? [];
    arr.push(t);
    tasksByProject.set(t.projectId, arr);
  }

  // P4-G5: project-grain urgency roll-up (worst tier + counts) — the roll-up half of the ticket,
  // "glance many projects without opening any of them". `today` resolved ONCE for this render.
  // Scoped to the SAME task subset the "Work routed here" column counts (work routed into this
  // department, not necessarily every task the project owns — see the comment on `byProject`
  // above) so the two columns never disagree about which tasks they mean. done-ness resolves via
  // `isDoneStatus` against each project's OWN registry, not a literal "done".
  const today = new Date().toISOString().slice(0, 10);
  const projectStatusesByProject = dept.statusesByProject;
  const projectUrgencyById = new Map(
    owned.map((p) => {
      const tasksHere = tasksByProject.get(p.id) ?? [];
      // `projectDueDate` is deliberately NOT folded in here any more. `projectUrgency` pushes it
      // into the same tier array as the tasks, so its counts included the project itself: a row
      // reading "Tasks here 3" carried a chip reading "4 Overdue", and the fourth was not a task.
      // The project's own slipped target is a different fact and now has its own column (Target,
      // via `targetNote`), where it can say "30d past" instead of inflating a task count.
      const roll = projectUrgency(
        tasksHere.map((t) => ({ dueDate: t.dueDate, isDone: isDoneStatus(t.status, projectStatusesByProject[p.id]) })),
        today,
      );
      return [p.id, roll] as const;
    }),
  );
  // P4-H3 — range: this list's `p.due_date` is the project's AUTHORED target (the bulk
  // `/api/:t/projects` read has no `start_date` column yet, unlike the single-project PM read —
  // see the ticket report), shown alongside the TASK-DERIVED envelope (min task start / max task
  // due, same subset as above) so a reader can see the gap between the two (decision 12).
  const rangeById = new Map(owned.map((p) => [p.id, taskDateEnvelope(tasksByProject.get(p.id) ?? [])] as const));

  return (
    <Card
      title="Department projects"
      // A bare "2" in the corner names nothing. The word costs three characters.
      headerRight={<span className="dept-proj__total">{owned.length} owned</span>}
    >
      {owned.length === 0 ? (
        <EmptyNote>No projects owned by this department yet. Create one from Projects and set its owning department, or assign work here from a shared project — it appears on the Board tab.</EmptyNote>
      ) : (
        /* Four columns, not six. "Tasks here"/"Done" were two columns holding one fact and one
           denominator; "Status" printed the same word on every row and repeated what Urgency
           already said, so it moved under the project's name where a label belongs.
           The scroller is not decoration: `HairlineTable` is a CSS grid with fr columns and no
           stacked mode, so on a 390px screen the four headers collided into
           "WORK ROUTEDRISK TARGET" and every cell wrapped mid-phrase. Swiping a table whose columns
           survive beats reading one that has folded in on itself — the same idiom the board, the
           Gantt and the connections table already use. */
        <div className="dept-table-scroll erp-scroll">
        <HairlineTable
          columns={[
            { label: "Project" },
            // NOT "Tasks here" — the header has to admit it is a subset. This page counts the work
            // ROUTED INTO this department, while Home's ring counts everything the project owns, and
            // the two numbers differ on the same project (3 vs 5 in the demo). A reader comparing
            // them needs the header to say which is which.
            { label: "Work routed here" },
            { label: "Risk" },
            { label: "Target", align: "right" },
          ]}
          tcols="2.4fr 1.3fr 1fr 1fr"
          rows={owned.map((p) => {
            const c = byProject[p.id] ?? { total: 0, done: 0 };
            const roll = projectUrgencyById.get(p.id);
            const env = rangeById.get(p.id) ?? { start: null, end: null };
            const note = targetNote(p.due_date, today);
            return [
              <span key={p.id} className="dept-proj__cell">
                <Link href={`/departments/${deptId}/projects/${p.id}`} className="dept-proj__name">{p.name}</Link>
                <span className="dept-proj__sub">
                  <StatusBadge label={p.status} />
                  {/* The task-derived envelope, on one line and in the cell it belongs to. As its
                      own right-aligned column it was two lines and five dates wide, and the
                      reader still had to hold the target from the next column to use it. */}
                  {(env.start || env.end) && (
                    <span className="dept-proj__span">
                      {env.start ? formatDate(env.start) : "—"} → {env.end ? formatDate(env.end) : "—"}
                    </span>
                  )}
                </span>
              </span>,
              c.total === 0
                ? <span key="w" className="dept-proj__none">none routed yet</span>
                : <span key="w" className="dept-proj__work">{c.total} task{c.total === 1 ? "" : "s"} · {c.done} done</span>,
              roll ? <UrgencyChip key="u" tier={roll.tier} variant="chip" count={roll.counts[roll.tier] || undefined} /> : "—",
              <span key="t" className="dept-proj__target">
                <span className="dept-proj__target-date">{p.due_date ? formatDate(p.due_date) : "no target"}</span>
                {note && <span className={`dept-proj__target-note${note.late ? " dept-proj__target-note--late" : ""}`}>{note.text}</span>}
              </span>,
            ];
          })}
        />
        </div>
      )}
    </Card>
  );
}
