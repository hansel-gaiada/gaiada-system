import Link from "next/link";
import { TeachState } from "./TeachState";
import { UrgencyChip } from "@/components/pm/UrgencyChip";
import type { UrgencyTier } from "@/lib/pmUrgency";
import { PM_TERMS } from "@/lib/pmVocabulary";

// The persistent rail (decision #10: rendered once in `[deptId]/layout.tsx`, so
// it is on screen no matter which tab is open). Two sections per decision #12:
// "My work today" (this person's dept tasks) and "Waiting on me" (pending
// approvals + their blocked tasks) — the two lists that answer "what do I do
// next" without leaving the console. Dept-agnostic, props only: the caller
// (Home/rail data wiring) does the querying AND the sort (due, then priority)
// — this component renders whatever order it's given, so it stays a pure view.
export type RailPriority = "low" | "medium" | "high" | "critical";

export interface RailTaskItem {
  id: string;
  title: string;
  href?: string;
  /** ISO date; omit/null when there's no due date. Kept for display; NOT read for urgency —
   * see `urgencyTier` below. */
  dueDate?: string | null;
  priority?: RailPriority;
  /** Optional context caption, e.g. the owning project's name. */
  projectName?: string;
  // P4-G5: precomputed by the caller (`taskUrgency(task, today, { isDone: isDoneStatus(...) })`,
  // lib/pm) — the rail used to derive its own overdue/due-today/normal tone from `dueDate` with a
  // local `new Date()` comparison, exactly the drift this ticket exists to close (this rail and a
  // board card disagreeing about "today" at midnight). Omit/undefined renders no indicator.
  urgencyTier?: UrgencyTier;
}

export interface RailWaitingItem {
  id: string;
  title: string;
  href?: string;
  kind: "approval" | "blocked_task";
  /** Optional caption, e.g. "Waiting on Sarah Kim" or "Waiting on client sign-off". */
  waitingOn?: string;
}

// P4-K3 — the ball-holder queue: "whose turn is it right now" (plan workstream B/K). Ball is our
// existing `assignee.refId`, renamed; this section answers "which of MY tasks currently hold the
// ball", distinct from "My work today" (which is due-date driven, not turn driven) — a task can be
// due next week and still be the one thing actually blocking you from passing it on.
export type RailReadiness = "ready" | "blocked";

export interface RailBallItem {
  id: string;
  title: string;
  href?: string;
  /** Optional context caption, e.g. the owning project's name. */
  projectName?: string;
  /** ISO date; display only, same as `RailTaskItem.dueDate` — NOT read for urgency. */
  dueDate?: string | null;
  /** Chain-enforcement readiness (P4-I): whether this task's dependencies are clear. Precomputed
   *  by the caller against the `dependsOn` graph — this component never derives it, same rule as
   *  `urgencyTier` below. Omit when the caller has no chain data (renders no readiness badge). */
  readiness?: RailReadiness;
  // P4-G5: precomputed by the caller, same contract as `RailTaskItem.urgencyTier` — never derived
  // here from `dueDate`.
  urgencyTier?: UrgencyTier;
}

export interface MyWorkRailProps {
  today: RailTaskItem[];
  waiting: RailWaitingItem[];
  /** Tasks where the viewer currently holds the Ball. Optional so every existing render site (none
   *  of which have wired the ball queue yet) keeps compiling and rendering unchanged; omit the prop
   *  to skip the section entirely, or pass `[]` to render its empty state. */
  ball?: RailBallItem[];
  todayEmptyText?: string;
  waitingEmptyText?: string;
  ballEmptyText?: string;
}

export function MyWorkRail({ today, waiting, ball, todayEmptyText, waitingEmptyText, ballEmptyText }: MyWorkRailProps) {
  return (
    <div className="dept-rail">
      <section className="dept-rail__section">
        <span className="type-eyebrow dept-rail__heading">My work today</span>
        {today.length === 0 ? (
          <p className="dept-rail__empty">{todayEmptyText ?? "Nothing due — a clear day."}</p>
        ) : (
          <ul className="dept-rail__list">
            {today.map((item) => {
              const row = (
                <>
                  <span className="dept-rail__item-title">{item.title}</span>
                  <span className="dept-rail__item-meta">
                    {item.projectName && <span className="dept-rail__item-project">{item.projectName}</span>}
                    {item.urgencyTier && <UrgencyChip tier={item.urgencyTier} variant="dot" detail={item.dueDate ?? undefined} />}
                    {(item.priority === "high" || item.priority === "critical") && (
                      <span className={`dept-rail__priority dept-rail__priority--${item.priority}`}>{item.priority}</span>
                    )}
                  </span>
                </>
              );
              return (
                <li key={item.id} className="dept-rail__item">
                  {item.href ? <Link href={item.href} className="dept-rail__item-link">{row}</Link> : row}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {ball !== undefined && (
        <section className="dept-rail__section">
          <span className="type-eyebrow dept-rail__heading">{PM_TERMS.ball} is with you</span>
          {ball.length === 0 ? (
            <p className="dept-rail__empty">{ballEmptyText ?? "Nothing on your ball right now."}</p>
          ) : (
            <ul className="dept-rail__list">
              {ball.map((item) => {
                const row = (
                  <>
                    <span className="dept-rail__item-title">{item.title}</span>
                    <span className="dept-rail__item-meta">
                      {item.projectName && <span className="dept-rail__item-project">{item.projectName}</span>}
                      {item.urgencyTier && <UrgencyChip tier={item.urgencyTier} variant="dot" detail={item.dueDate ?? undefined} />}
                      {item.readiness && (
                        <span className="dept-rail__kind">{item.readiness === "ready" ? "Ready" : "Blocked"}</span>
                      )}
                    </span>
                  </>
                );
                return (
                  <li key={item.id} className="dept-rail__item">
                    {item.href ? <Link href={item.href} className="dept-rail__item-link">{row}</Link> : row}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <section className="dept-rail__section dept-rail__section--waiting">
        <span className="type-eyebrow dept-rail__heading">Waiting on me</span>
        {waiting.length === 0 ? (
          <p className="dept-rail__empty">{waitingEmptyText ?? "Nothing waiting on you."}</p>
        ) : (
          <ul className="dept-rail__list">
            {waiting.map((item) => {
              const row = (
                <>
                  <span className="dept-rail__item-title">{item.title}</span>
                  <span className="dept-rail__item-meta">
                    <span className="dept-rail__kind">{item.kind === "approval" ? "Approval" : "Blocked"}</span>
                    {item.waitingOn && <span className="dept-rail__item-project">{item.waitingOn}</span>}
                  </span>
                </>
              );
              return (
                <li key={item.id} className="dept-rail__item dept-rail__item--waiting">
                  {item.href ? <Link href={item.href} className="dept-rail__item-link">{row}</Link> : row}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
