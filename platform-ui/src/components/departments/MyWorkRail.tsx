import Link from "next/link";
import { TeachState } from "./TeachState";

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
  /** ISO date; omit/null when there's no due date. */
  dueDate?: string | null;
  priority?: RailPriority;
  /** Optional context caption, e.g. the owning project's name. */
  projectName?: string;
}

export interface RailWaitingItem {
  id: string;
  title: string;
  href?: string;
  kind: "approval" | "blocked_task";
  /** Optional caption, e.g. "Waiting on Sarah Kim" or "Waiting on client sign-off". */
  waitingOn?: string;
}

export interface MyWorkRailProps {
  today: RailTaskItem[];
  waiting: RailWaitingItem[];
  todayEmptyText?: string;
  waitingEmptyText?: string;
}

function dueBadge(dueDate?: string | null): { label: string; tone: "risk" | "soon" | "quiet" } | null {
  if (!dueDate) return null;
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) return null;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.floor((due.getTime() - startOfToday.getTime()) / 86_400_000);
  if (days < 0) return { label: "Overdue", tone: "risk" };
  if (days === 0) return { label: "Due today", tone: "soon" };
  return { label: `Due ${due.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`, tone: "quiet" };
}

export function MyWorkRail({ today, waiting, todayEmptyText, waitingEmptyText }: MyWorkRailProps) {
  return (
    <div className="dept-rail">
      <section className="dept-rail__section">
        <span className="type-eyebrow dept-rail__heading">My work today</span>
        {today.length === 0 ? (
          <p className="dept-rail__empty">{todayEmptyText ?? "Nothing due — a clear day."}</p>
        ) : (
          <ul className="dept-rail__list">
            {today.map((item) => {
              const badge = dueBadge(item.dueDate);
              const row = (
                <>
                  <span className="dept-rail__item-title">{item.title}</span>
                  <span className="dept-rail__item-meta">
                    {item.projectName && <span className="dept-rail__item-project">{item.projectName}</span>}
                    {badge && <span className={`dept-rail__due dept-rail__due--${badge.tone}`}>{badge.label}</span>}
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
