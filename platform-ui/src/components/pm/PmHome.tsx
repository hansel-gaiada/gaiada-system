// PM `@all` Home dashboard (P4-A8, plan `2026-08-04-pm-repsona-parity-phase4-plan.md` §1.2 +
// workstream A). Repsona's 4-column status dashboard: Today's Todo · Completed Tasks · Tasks with
// Activity (grouped by status, WITH comment excerpts — the column that makes Home feel alive,
// per the plan) · Upcoming Schedule (grouped by status).
//
// Deliberately NOT "use client" and hook-free, same rationale as `UrgencyChip.tsx`: both server
// pages and client wrappers can render this without a second variant, and it means the `/pm`
// route (owned by a concurrent agent — this file does not create that route) can mount it either
// way. This component does ZERO fetching — every task/comment/urgency-tier is precomputed by the
// caller and handed in as props. That is deliberate, not a shortcut: `lib/pm.ts` (server-only,
// owned by another agent right now) and `lib/activity.ts` are where the real reads live; this file
// only renders a fully-assembled view-model. `lib/queue.ts::getPmHomeData` is the reference
// assembler that produces exactly this shape — see its header for the actual data sourcing
// (work-activity §11 join for the comment excerpts).
//
// `today` and `windowLabel` are resolved ONCE by the caller and passed in — NEVER `new Date()` in
// here. Same hydration trap `lib/pmUrgency.ts` documents: server and client straddle midnight
// differently, so "today" has to be agreed by construction, not recomputed per render.
import type { UrgencyTier } from "@/lib/pmUrgency";
import { UrgencyChip } from "./UrgencyChip";
import { PM_TERMS } from "@/lib/pmVocabulary";
import "./pm.css"; // the folder sheet — carries `.pm-sr-only` + the PM tokens this file consumes
import "./pm-home.css";

/** One task card, shared shape across all 4 columns. `commentExcerpt`/`commentAuthor`/`commentAt`
 *  are only ever populated on a Tasks-with-Activity card — every other column omits them. */
export interface PmHomeTask {
  id: string;
  href: string;
  title: string;
  projectName: string;
  statusLabel: string;
  /** A CSS colour value — `var(--pm-status-*)` for a synthesized default or a materialized hex,
   *  exactly `ProjectStatus.color`'s own convention (`lib/pm.ts`). Applied via inline style, same
   *  as `Board.tsx`'s `pm-col__dot` — dynamic per-project colour cannot live in static CSS. */
  statusColor: string;
  dueDate: string | null; // "YYYY-MM-DD"
  urgencyTier: UrgencyTier;
  /** Ball holder's display name (assignee.refName) for the avatar. `null` renders the empty
   *  "no user" avatar, Repsona's own wording (`PM_TERMS.unassigned`). */
  assigneeName: string | null;
  commentExcerpt?: string;
  commentAuthor?: string;
}

/** `Tasks with Activity` / `Upcoming Schedule` are grouped by status; `Today's Todo` /
 *  `Completed Tasks` are flat lists (matches the Repsona reference screenshots). */
export interface PmHomeStatusGroup {
  statusId: string;
  statusLabel: string;
  statusColor: string;
  tasks: PmHomeTask[];
}

export interface PmHomeProps {
  /** Resolved once by the caller — see header. */
  today: string;
  /** Explicit "M/D – M/D" label for the activity/upcoming 7-day windows, e.g. "7/28 – 8/4" —
   *  Repsona shows the window explicitly rather than just saying "this week". */
  windowLabel: string;
  todaysTodo: PmHomeTask[];
  completedTasks: PmHomeTask[];
  tasksWithActivity: PmHomeStatusGroup[];
  upcomingSchedule: PmHomeStatusGroup[];
}

// Up to two initials from a display name — identical rule to `Gantt.tsx`'s own `initials()`
// (no shared helper exists yet; kept local here the same way Gantt keeps its own copy).
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// "YYYY-MM-DD" -> "M/D". Pure string slicing, no `Date` object — the header's hydration
// rationale applies here too: parsing into a `Date` and calling a locale formatter is exactly the
// documented trap (`charts/chartHover.ts::fmtDate`).
function shortDate(iso: string): string {
  const [, mo, d] = iso.slice(0, 10).split("-");
  return `${Number(mo)}/${Number(d)}`;
}

function Avatar({ name }: { name: string | null }) {
  if (!name) {
    return (
      <span className="pm-home__avatar pm-home__avatar--empty">
        <span className="pm-sr-only">{PM_TERMS.unassigned}</span>
      </span>
    );
  }
  return (
    <span className="pm-home__avatar" title={name}>
      <span aria-hidden>{initials(name)}</span>
      <span className="pm-sr-only">{name}</span>
    </span>
  );
}

function StatusPill({ label, color }: { label: string; color: string }) {
  return (
    <span className="pm-home__status" style={{ background: color }}>
      {label}
    </span>
  );
}

const URGENCY_UNDATED_LABEL = "No due date";

function TaskCard({ task }: { task: PmHomeTask }) {
  return (
    <li className="pm-home__card">
      <div className="pm-home__card-top">
        <Avatar name={task.assigneeName} />
        <a className="pm-home__title" href={task.href}>
          {task.title}
        </a>
      </div>
      <div className="pm-home__card-meta">
        <span className="pm-home__project">{task.projectName}</span>
        <StatusPill label={task.statusLabel} color={task.statusColor} />
        <span className="pm-home__due">
          {task.dueDate ? shortDate(task.dueDate) : URGENCY_UNDATED_LABEL}
        </span>
        <UrgencyChip tier={task.urgencyTier} variant="dot" detail={task.dueDate ? shortDate(task.dueDate) : undefined} />
      </div>
      {task.commentExcerpt && (
        <p className="pm-home__excerpt">
          {task.commentAuthor && <span className="pm-home__excerpt-author">{task.commentAuthor}: </span>}
          {task.commentExcerpt}
        </p>
      )}
    </li>
  );
}

function FlatColumn({ title, tasks }: { title: string; tasks: PmHomeTask[] }) {
  return (
    <section className="pm-home__col">
      <header className="pm-home__col-head">
        <h3 className="pm-home__col-title">{title}</h3>
        <span className="pm-home__col-count">{tasks.length}</span>
      </header>
      {tasks.length === 0 ? (
        <p className="pm-home__empty">Nothing here.</p>
      ) : (
        <ul className="pm-home__list">
          {tasks.map((t) => (
            <TaskCard key={t.id} task={t} />
          ))}
        </ul>
      )}
    </section>
  );
}

function GroupedColumn({ title, groups, windowLabel }: { title: string; groups: PmHomeStatusGroup[]; windowLabel?: string }) {
  const total = groups.reduce((n, g) => n + g.tasks.length, 0);
  return (
    <section className="pm-home__col">
      <header className="pm-home__col-head">
        <h3 className="pm-home__col-title">
          {title}
          {windowLabel && <span className="pm-home__col-window">{windowLabel}</span>}
        </h3>
        <span className="pm-home__col-count">{total}</span>
      </header>
      {total === 0 ? (
        <p className="pm-home__empty">Nothing here.</p>
      ) : (
        groups
          .filter((g) => g.tasks.length > 0)
          .map((g) => (
            <div className="pm-home__group" key={g.statusId}>
              <div className="pm-home__group-head">
                <StatusPill label={g.statusLabel} color={g.statusColor} />
                <span className="pm-home__group-count">{g.tasks.length}</span>
              </div>
              <ul className="pm-home__list">
                {g.tasks.map((t) => (
                  <TaskCard key={t.id} task={t} />
                ))}
              </ul>
            </div>
          ))
      )}
    </section>
  );
}

/** THE `@all` Home dashboard (P4-A8) — 4 columns, per the Repsona reference. Pure rendering; every
 *  input is precomputed. See the file header + `lib/queue.ts::getPmHomeData` for how a caller
 *  builds these props. */
export function PmHome({ windowLabel, todaysTodo, completedTasks, tasksWithActivity, upcomingSchedule }: PmHomeProps) {
  return (
    <div className="pm-home">
      <FlatColumn title={PM_TERMS.todaysTodo} tasks={todaysTodo} />
      <FlatColumn title={PM_TERMS.completedTasks} tasks={completedTasks} />
      <GroupedColumn title={PM_TERMS.tasksWithActivity} groups={tasksWithActivity} windowLabel={windowLabel} />
      <GroupedColumn title={PM_TERMS.upcomingSchedule} groups={upcomingSchedule} windowLabel={windowLabel} />
    </div>
  );
}
