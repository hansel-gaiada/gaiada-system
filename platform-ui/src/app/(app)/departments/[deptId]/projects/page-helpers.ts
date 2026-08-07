import { isDoneStatus, type ProjectStatus } from "@/lib/pm";

// P4-H3 — pure helpers for the department projects list, split out of `page.tsx` so they're
// unit-testable in isolation (a `page.tsx` module may only export `default`/`metadata`/the other
// Next.js-reserved names — anything else fails the build with TS2344) AND so the inherited-bug
// fix below is exercised without rendering the server component.

// The task-derived half of decision 12's range (authored range lives on the base `projects` row
// via `p.due_date`; there is no bulk-list `start_date` yet — see the ticket report). String
// comparison is safe: dates are "YYYY-MM-DD".
// P4-H3 follow-up: the canonical fold now lives in lib/pm.ts (three surfaces had grown their
// own copy). Re-exported here so this module's existing importers and tests are unchanged.
export { taskDateEnvelope } from "@/lib/pm";

// The "Tasks here"/"Done" tally, isolated so a project with CUSTOM statuses (a renamed or extra
// done status, P2-04) can be exercised without rendering. Was a literal `t.status === "done"` —
// disagreed with the Urgency column next to it (which already resolved done-ness via
// `isDoneStatus` against each task's OWN project's registry) the moment a project renamed or
// added a done status.
export function tallyProjectTasks(
  tasks: { projectId: string; status: string }[],
  statusesByProject: Record<string, ProjectStatus[]>,
): Record<string, { total: number; done: number }> {
  const byProject: Record<string, { total: number; done: number }> = {};
  for (const t of tasks) {
    const row = byProject[t.projectId] ?? { total: 0, done: 0 };
    row.total += 1;
    if (isDoneStatus(t.status, statusesByProject[t.projectId])) row.done += 1;
    byProject[t.projectId] = row;
  }
  return byProject;
}
