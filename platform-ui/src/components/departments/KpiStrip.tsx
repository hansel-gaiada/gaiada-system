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

export function KpiStrip({ active, dueSoon, blocked, progressPct, totalTasksFoot, totalProjectsFoot }: KpiStripProps) {
  const pct = Math.max(0, Math.min(100, Math.round(progressPct)));
  return (
    <div className="dept-kpi-strip">
      <div className="dept-kpi">
        <span className="type-eyebrow dept-kpi__label">Active</span>
        <span className="dept-kpi__value">{active}</span>
        {totalTasksFoot && <span className="dept-kpi__foot">{totalTasksFoot}</span>}
      </div>
      <div className="dept-kpi">
        <span className="type-eyebrow dept-kpi__label">Due soon</span>
        <span className="dept-kpi__value">{dueSoon}</span>
        <span className="dept-kpi__foot">within 7 days</span>
      </div>
      <div className="dept-kpi">
        <span className="type-eyebrow dept-kpi__label">Blocked</span>
        <span className={`dept-kpi__value${blocked > 0 ? " dept-kpi__value--attention" : ""}`}>{blocked}</span>
        <span className="dept-kpi__foot">{blocked > 0 ? "needs a look" : "none right now"}</span>
      </div>
      <div className="dept-kpi">
        <span className="type-eyebrow dept-kpi__label">Progress</span>
        <span className="dept-kpi__value">{pct}%</span>
        <div className="dept-kpi__bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
        {totalProjectsFoot && <span className="dept-kpi__foot">{totalProjectsFoot}</span>}
      </div>
    </div>
  );
}
