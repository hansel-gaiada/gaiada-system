import Link from "next/link";
import { UrgencyChip } from "@/components/pm/UrgencyChip";
import type { UrgencyTier } from "@/lib/pmUrgency";
import { PM_TERMS } from "@/lib/pmVocabulary";

// The persistent rail (decision #10: rendered once in `[deptId]/layout.tsx`, so
// it is on screen no matter which tab is open). Three sections per decision #12
// + P4-K3: "My work today" (this person's dept tasks), "<Ball> is with you", and
// "Waiting on me" (pending approvals + their blocked tasks) — the lists that
// answer "what do I do next" without leaving the console. Dept-agnostic, props
// only: the caller (Home/rail data wiring) does the querying AND the sort (due,
// then priority; oldest-first for waiting) — this component renders whatever
// order it is given, so it stays a pure view.
//
// Weighting rules learned from the built rail, all three deliberate:
//   1. An EMPTY section is one line, not a heading plus a sentence. With three
//      sections, two of them idle, the absence of work was taking more of the
//      rail than the five approvals actually waiting.
//   2. A non-empty heading carries its COUNT. "Waiting on me · 5" is the number
//      a person wants before reading any row.
//   3. The rust bar is for the rows that have waited too long, not for every
//      waiting row. Spent on all five, it marked none of them.
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
  /** How long it has been waiting, already formatted by the CALLER, e.g. "8d". Same contract as
   *  `urgencyTier`: this component never touches a clock. For an approval this is the ONLY urgency
   *  there is — the queue sets `urgencyScore: 0` on every approval/gate/automation row, so nothing
   *  else in the data distinguishes one row from another. */
  age?: string;
  /** true when the wait has passed the caller's threshold; drives the rust bar. */
  stale?: boolean;
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
  /** Short verdict shown beside the heading when the section is empty, e.g. "clear". A SENTENCE is
   *  wrong here — it sits inline with the heading now, not under it. */
  todayEmptyText?: string;
  waitingEmptyText?: string;
  ballEmptyText?: string;
}

/** An empty section: heading and verdict on one row, nothing below it. */
function ClearSection({ heading, text }: { heading: string; text: string }) {
  return (
    <section className="dept-rail__section dept-rail__section--clear">
      <span className="type-eyebrow dept-rail__heading dept-rail__heading--inline">{heading}</span>
      <span className="dept-rail__clear">{text}</span>
    </section>
  );
}

function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <span className="type-eyebrow dept-rail__heading">
      {label}
      <span className="dept-rail__count">{count}</span>
    </span>
  );
}

export function MyWorkRail({ today, waiting, ball, todayEmptyText, waitingEmptyText, ballEmptyText }: MyWorkRailProps) {
  // The kind label prints only when the list actually holds more than one kind. Five rows all
  // reading "APPROVAL" is a label repeated down a column — the same noise the activity feed dropped
  // its per-row "PM" chip to remove. With one kind, the section heading already said it.
  const waitingMixed = new Set(waiting.map((i) => i.kind)).size > 1;

  return (
    <div className="dept-rail">
      {today.length === 0 ? (
        <ClearSection heading="My work today" text={todayEmptyText ?? "clear"} />
      ) : (
        <section className="dept-rail__section">
          <SectionHeading label="My work today" count={today.length} />
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
        </section>
      )}

      {ball !== undefined && (ball.length === 0 ? (
        <ClearSection heading={`${PM_TERMS.ball} is with you`} text={ballEmptyText ?? "clear"} />
      ) : (
        <section className="dept-rail__section">
          <SectionHeading label={`${PM_TERMS.ball} is with you`} count={ball.length} />
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
        </section>
      ))}

      {waiting.length === 0 ? (
        <ClearSection heading="Waiting on me" text={waitingEmptyText ?? "clear"} />
      ) : (
        <section className="dept-rail__section dept-rail__section--waiting">
          <SectionHeading label="Waiting on me" count={waiting.length} />
          <ul className="dept-rail__list">
            {waiting.map((item) => {
              const row = (
                <>
                  <span className="dept-rail__item-head">
                    <span className="dept-rail__item-title">{item.title}</span>
                    {/* Age sits on the title's line, right-aligned: it is what ranks the row, and
                        the caller has already sorted the list by it. */}
                    {item.age && <span className="dept-rail__age">{item.age}</span>}
                  </span>
                  <span className="dept-rail__item-meta">
                    {waitingMixed && (
                      <span className="dept-rail__kind">{item.kind === "approval" ? "Approval" : "Blocked"}</span>
                    )}
                    {item.waitingOn && <span className="dept-rail__item-project">{item.waitingOn}</span>}
                  </span>
                </>
              );
              return (
                <li key={item.id} className={`dept-rail__item${item.stale ? " dept-rail__item--stale" : ""}`}>
                  {item.href ? <Link href={item.href} className="dept-rail__item-link">{row}</Link> : row}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
