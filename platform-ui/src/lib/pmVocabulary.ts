// PM vocabulary — the single source of truth for what we CALL things (P4-L2, plan
// `2026-08-04-pm-repsona-parity-phase4-plan.md` workstream L).
//
// Owner directive 2026-08-06: the UI mirrors Repsona, naming included, because the team is already
// fluent in Repsona's words. The risk that makes this a module rather than a find-and-replace is
// HALF-renaming: 30 components each holding their own string, so "Assignee" survives in a filter
// label while the card next to it says "Ball". Two names for one thing in the same product is worse
// than not renaming at all. Import from here; never inline one of these words.
//
// Client-safe (no imports, no `server-only`): both server pages and client components render these.
//
// IMPORTANT — labels rename, IDS DO NOT. `in_progress` stays `in_progress` in the database, in
// `PmTask.status`, in every per-project status registry row and in every URL already bookmarked;
// only its human label becomes "Doing". Renaming an id would orphan every existing task row and the
// failure would look like tasks losing their status rather than a naming change. The `id` fields
// below are therefore load-bearing and must not be "tidied up" to match the new labels.

/** Nouns and actions, Repsona-faithful. Keys are stable code names; values are what the user reads. */
export const PM_TERMS = {
  // Assignment. `ball` is our existing `assignee.refId`/`kind`; `responsible` is
  // `assignee.responsibleId` — one field, two slots, not a new axis (plan §1.5).
  ball: "Ball",
  responsible: "Responsible",
  setToMe: "Set to me",
  unassigned: "no user", // Repsona's own lower-case wording for the empty board column

  // Scope. Repsona's project switcher calls the tenant-wide scope "Cross project" (`@all`).
  crossProject: "Cross project",
  allTasks: "All Tasks",

  // The one PM surface name (owner decision 2026-08-10: "PM" and the department "Work" group both
  // read as the abbreviation/vague word the owner explicitly asked to stop — see PM_RENAMES below).
  // Every place that names this surface — the Workspace nav row, the Business nav row, and each
  // department console's primary-strip group — imports THIS, not a local string.
  projectManagement: "Project Management",

  // Views. 2026-08-10 owner decision, reversing the 2026-08-06 Timeline->Gantt rename and adding
  // Board->Overview: three surfaces (`/pm`, Business, a department console) had drifted onto
  // different words for the same two views. See PM_RENAMES.
  gantt: "Timeline",
  board: "Overview",
  charts: "Charts",
  productivity: "Productivity",
  milestones: "Milestones",
  notes: "Notes", // Repsona's word for what we currently ship as "Docs"
  comment: "Comment",

  // Home dashboard columns.
  todaysTodo: "Today's Todo",
  completedTasks: "Completed Tasks",
  tasksWithActivity: "Tasks with Activity",
  upcomingSchedule: "Upcoming Schedule",

  // Task anatomy.
  subTask: "Sub-task",
  addATask: "Add a task",
  addATag: "Add a tag",
  dueDate: "Due date",
  priority: "Priority",
  tags: "Tags",
  keywords: "Keywords",
  follow: "Follow",

  // Gantt toggles.
  overdueOnly: "Overdue Only",
  showClosed: "Show Closed",

  // Urgency (workstream G). "Almost late" is the owner's phrasing — keep it; "Due soon" is the
  // code-side tier name (`UrgencyTier`), not something a user should ever read.
  overdue: "Overdue",
  almostLate: "Almost late",
  inTime: "In time",
} as const;

export type PmTermKey = keyof typeof PM_TERMS;

/**
 * The default status ladder (decision 6, 2026-08-06): `Backlog · ToDo · Doing · Blocked · Done`.
 *
 * `id` is the persisted value and MUST NOT change — see the header note. `backlog` is the only new
 * row; `in_progress` keeps its id and gains the label "Doing". Projects still add their own statuses
 * (`Ready to check`, `Client Review`, …) through the per-project registry — this is only the default
 * set synthesized for a project that has never customized one.
 *
 * `P4-B8` points `DEFAULT_STATUSES` in the server-only `lib/pm.ts` at this list so the labels have
 * exactly one home; the colours stay there because they are design tokens, not vocabulary.
 */
export const PM_STATUS_LADDER: { id: string; label: string; isDone: boolean; isBlocked: boolean }[] = [
  { id: "backlog", label: "Backlog", isDone: false, isBlocked: false },
  { id: "todo", label: "ToDo", isDone: false, isBlocked: false },
  { id: "in_progress", label: "Doing", isDone: false, isBlocked: false },
  { id: "blocked", label: "Blocked", isDone: false, isBlocked: true },
  { id: "done", label: "Done", isDone: true, isBlocked: false },
];

/**
 * Renames this program performs, kept as data so the fidelity pass (`P4-L3`) can be audited rather
 * than eyeballed: anything still rendering a `was` string is an unfinished rename. `idUnchanged`
 * records the persisted value where one exists, which is the half people get wrong.
 */
export const PM_RENAMES: { was: string; now: string; idUnchanged?: string; note?: string }[] = [
  { was: "Assignee", now: PM_TERMS.ball, note: "assignee.refId/kind — the field itself is unchanged" },
  { was: "In progress", now: "Doing", idUnchanged: "in_progress" },
  { was: "To do", now: "ToDo", idUnchanged: "todo" },
  {
    // `was` records the FULL history (2026-08-06 renamed this "Timeline" -> "Gantt"; 2026-08-10
    // reverses that) — only `now` has to be a currently-published word (pinned by this file's own
    // test), so the intermediate "Gantt" step lives here as free-text context, not a second entry.
    was: "Timeline (2026-08-06), then Gantt", now: PM_TERMS.gantt,
    note: "2026-08-10 owner decision: three surfaces (/pm, Business, a department console) disagreed on names — back to \"Timeline\". The ?view=gantt query value, Gantt.tsx, and every pm-gantt__* CSS class stay for old links/code (id-stability rule above).",
  },
  {
    was: "Board", now: PM_TERMS.board,
    note: "2026-08-10 owner decision, same pass as Gantt->Timeline: \"Overview\", so the kanban view stops sharing a name with the department console's Work/Project Management group. The ?view=board query value, the tab key \"board\", Board.tsx, and every pm-col__*/pm-board__* CSS class stay unchanged.",
  },
  {
    was: "PM", now: PM_TERMS.projectManagement,
    note: "2026-08-10 owner decision: the sidebar's Workspace row, the collapsed Business row, and every department console's \"Work\" group all read \"Project Management\" now — one name for the one surface. Routes/paths are unchanged (/pm, /project-management, /departments/[deptId]/<tab>).",
  },
  {
    was: "Work", now: PM_TERMS.projectManagement,
    note: "the department console's primary-strip group — see the PM entry above; same rename, same reason.",
  },
  { was: "Docs", now: PM_TERMS.notes, note: "route/endpoint segment stays /docs" },
  { was: "Discussion", now: PM_TERMS.comment },
  { was: "Unassigned", now: PM_TERMS.unassigned },
];
