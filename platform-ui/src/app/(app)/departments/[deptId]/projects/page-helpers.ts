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
// Whole days between two "YYYY-MM-DD" dates, positive when `date` is in the PAST. Both are parsed
// at UTC noon so no zone or DST edge can shift the answer by one, and `today` is always the
// caller-resolved value — this module never reads a clock (same rule as the rail's `age`).
//
// Exists because the Target column printed "Target 20 Jul 2026" for a target 30 days gone and said
// nothing about it: the row was already flagged at risk, and the one date that explained why read
// as neutral. Returns null on a missing or unparseable date rather than 0 — "no target" and "due
// today" are different facts.
export function daysPast(date: string | null | undefined, today: string): number | null {
  if (!date) return null;
  const a = Date.parse(`${date.slice(0, 10)}T12:00:00Z`);
  const b = Date.parse(`${today.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** "30d past" / "in 9d" / "today" — the Target column's caption. Null when there is no date. */
export function targetNote(date: string | null | undefined, today: string): { text: string; late: boolean } | null {
  const d = daysPast(date, today);
  if (d === null) return null;
  if (d === 0) return { text: "today", late: false };
  return d > 0 ? { text: `${d}d past`, late: true } : { text: `in ${-d}d`, late: false };
}

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

/** A client has many projects; the Projects tab reads that way. Groups a department's projects by
 *  client (clients A→Z by name, projects in the order given), with project-less ones last under
 *  "Internal — no client". A client id the names map does not know still gets its own group, named
 *  by id, rather than being folded into Internal. */
export interface ClientProjectGroup<P> { clientId: string | null; clientName: string; projects: P[] }

export function groupProjectsByClient<P extends { client_id: string | null }>(
  projects: P[],
  clientNames: Map<string, string>,
): ClientProjectGroup<P>[] {
  const byClient = new Map<string | null, P[]>();
  for (const p of projects) {
    const key = p.client_id ?? null;
    (byClient.get(key) ?? byClient.set(key, []).get(key)!).push(p);
  }
  const groups: ClientProjectGroup<P>[] = [];
  for (const [clientId, ps] of byClient) {
    if (clientId === null) continue;
    groups.push({ clientId, clientName: clientNames.get(clientId) ?? clientId, projects: ps });
  }
  groups.sort((a, b) => a.clientName.localeCompare(b.clientName, "en"));
  const internal = byClient.get(null);
  if (internal && internal.length) groups.push({ clientId: null, clientName: "Internal — no client", projects: internal });
  return groups;
}
