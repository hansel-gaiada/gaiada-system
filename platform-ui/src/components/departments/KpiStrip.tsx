// KPI strip — the four numbers that answer "how is this department doing right
// now": Active, Due soon, Blocked, Progress. Semantics are fixed by design
// decision #12 (web-dev-phase1-tickets.md) so every department's Home tab reads
// the same way; the CALLER computes the numbers (from tasks/projects it owns),
// this component only renders them. Dept-agnostic, props only, no fetching.
//
// Colour is signal, not decoration: Blocked only goes to the risk colour when
// it is > 0 (there is something to look at); everything else stays neutral ink.
// Progress additionally draws a thin hairline bar — the strip's one visual
// (non-numeric) read, per the "as visual as possible" mandate.
import { InfoHint } from "@/components/InfoHint";

export interface KpiStripProps {
  /** todo + in_progress task count for the department. */
  active: number;
  /** Tasks due within 7 days that are not done. */
  dueSoon: number;
  /** Tasks currently blocked. */
  blocked: number;
  /** Average progress (0–100) across the department's owned projects. */
  progressPct: number;
  /** Optional caption under Active, e.g. "of 24 total". */
  totalTasksFoot?: string;
  /** Optional caption under Progress, e.g. "across 6 projects". */
  totalProjectsFoot?: string;
}

// Definitions are transcribed from computeDeptKpis() in lib/departments.ts — the point of a hint
// is to state what the number literally counts, so these must track that function, not paraphrase
// it. Two things users get wrong without being told, both visible in the code:
//   * "Due soon" uses daysUntil <= 7, which is TRUE for negative values — overdue tasks are in it.
//   * "Progress" averages OWNED PROJECT progress, not task progress, so it can sit at 0% while
//     Active is non-zero (tasks assigned here, no project owned here).
const HINTS = {
  active: "Tasks assigned to this department that are neither done nor blocked. Done/blocked come from each task's own project statuses, so a project that renamed “Done” still counts correctly.",
  dueSoon: "Not-done department tasks due within the next 7 days. Overdue tasks are included — they are still due.",
  blocked: "Department tasks sitting in a status their project marks as blocked.",
  progress: "Average progress of the projects this department OWNS — not of its tasks. It reads 0% when the department owns no projects, even if it has active tasks.",
} as const;

export function KpiStrip({ active, dueSoon, blocked, progressPct, totalTasksFoot, totalProjectsFoot }: KpiStripProps) {
  const pct = Math.max(0, Math.min(100, Math.round(progressPct)));
  return (
    <div className="dept-kpi-strip">
      <div className="dept-kpi">
        <span className="dept-kpi__labelrow">
          <span className="type-eyebrow dept-kpi__label">Active</span>
          <InfoHint label="Active">{HINTS.active}</InfoHint>
        </span>
        <span className="dept-kpi__value">{active}</span>
        {totalTasksFoot && <span className="dept-kpi__foot">{totalTasksFoot}</span>}
      </div>
      <div className="dept-kpi">
        <span className="dept-kpi__labelrow">
          <span className="type-eyebrow dept-kpi__label">Due soon</span>
          <InfoHint label="Due soon">{HINTS.dueSoon}</InfoHint>
        </span>
        <span className="dept-kpi__value">{dueSoon}</span>
        <span className="dept-kpi__foot">within 7 days</span>
      </div>
      <div className="dept-kpi">
        <span className="dept-kpi__labelrow">
          <span className="type-eyebrow dept-kpi__label">Blocked</span>
          <InfoHint label="Blocked">{HINTS.blocked}</InfoHint>
        </span>
        <span className={`dept-kpi__value${blocked > 0 ? " dept-kpi__value--attention" : ""}`}>{blocked}</span>
        <span className="dept-kpi__foot">{blocked > 0 ? "needs a look" : "none right now"}</span>
      </div>
      <div className="dept-kpi">
        <span className="dept-kpi__labelrow">
          <span className="type-eyebrow dept-kpi__label">Progress</span>
          <InfoHint label="Progress">{HINTS.progress}</InfoHint>
        </span>
        <span className="dept-kpi__value">{pct}%</span>
        <div className="dept-kpi__bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
        {totalProjectsFoot && <span className="dept-kpi__foot">{totalProjectsFoot}</span>}
      </div>
    </div>
  );
}
