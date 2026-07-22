import Link from "next/link";

// One project's health, at a glance — the console's signature visual. The
// system's CSS reserves circles for exactly one thing (see ui.css: the status
// badge dot is "the system's one sanctioned circle"); this ring is the second,
// deliberately spent on the single most load-bearing number a department owner
// checks — a project's progress — so it earns the visual weight per the
// "as visual as possible, colour only for signal" mandate. Ring stroke stays
// the brand accent unless the project is at risk, when it (and only it) shifts
// to the risk colour — the sole place colour communicates urgency here.
//
// Dept-agnostic, props only: the caller (Home tab data wiring) computes
// progress/open/at-risk from whatever entities that department's projects are
// built from — this component never fetches or assumes a department shape.
export interface HealthRingCardProps {
  projectName: string;
  /** Link to the project's detail page; renders as plain text when omitted. */
  href?: string;
  /** 0–100. Drives the ring's fill arc. */
  progressPct: number;
  /** Open (not-done) task count on this project. */
  openCount: number;
  /** Next upcoming milestone, or null/undefined when none is set. */
  nextMilestone?: { label: string; dueDate: string /* ISO */ } | null;
  /** true when overdue > 0 or blocked > 0 for this project (decision #12). */
  atRisk: boolean;
  /** Short reason shown under an at-risk card, e.g. "2 overdue · 1 blocked". */
  atRiskReason?: string;
}

const RING_RADIUS = 40;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function formatMilestoneDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function HealthRingCard({
  projectName,
  href,
  progressPct,
  openCount,
  nextMilestone,
  atRisk,
  atRiskReason,
}: HealthRingCardProps) {
  const pct = Math.max(0, Math.min(100, Math.round(progressPct)));
  const dashOffset = RING_CIRCUMFERENCE * (1 - pct / 100);

  return (
    <div className={`dept-ring-card${atRisk ? " dept-ring-card--risk" : ""}`}>
      <div className="dept-ring-card__head">
        {href ? (
          <Link href={href} className="dept-ring-card__name">{projectName}</Link>
        ) : (
          <span className="dept-ring-card__name">{projectName}</span>
        )}
        {atRisk && (
          <span className="lux-badge dept-ring-card__risk-badge">
            <span className="lux-badge__dot" />
            At risk
          </span>
        )}
      </div>

      <div className="dept-ring-card__body">
        <div className="dept-ring-wrap">
          <svg className="dept-ring" viewBox="0 0 96 96" width="96" height="96" role="img" aria-label={`${pct} percent complete`}>
            <circle className="dept-ring__track" cx="48" cy="48" r={RING_RADIUS} />
            <circle
              className="dept-ring__value"
              cx="48" cy="48" r={RING_RADIUS}
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={dashOffset}
            />
          </svg>
          <span className="dept-ring__label">{pct}%</span>
        </div>
        <dl className="dept-ring-card__stats">
          <div className="dept-ring-card__stat">
            <dt className="type-eyebrow">Open</dt>
            <dd>{openCount}</dd>
          </div>
          <div className="dept-ring-card__stat">
            <dt className="type-eyebrow">Next milestone</dt>
            <dd>{nextMilestone ? `${nextMilestone.label} · ${formatMilestoneDate(nextMilestone.dueDate)}` : "None set"}</dd>
          </div>
        </dl>
      </div>

      {atRisk && atRiskReason && <p className="dept-ring-card__reason">{atRiskReason}</p>}
    </div>
  );
}
