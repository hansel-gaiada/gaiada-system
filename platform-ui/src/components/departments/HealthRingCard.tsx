import Link from "next/link";
import type { ProjectComposition } from "@/lib/departments";

// One project's health, at a glance — the console's signature visual. The
// system's CSS reserves circles for exactly one thing (see ui.css: the status
// badge dot is "the system's one sanctioned circle"); this ring is the second,
// deliberately spent on the single most load-bearing read a department owner
// checks — how a project's work is actually distributed.
//
// The ring shows a COMPOSITION, not a gauge. It used to be a single progress
// arc that turned rust when the project was at risk, which said "43% complete
// is bad" — recolouring progress to carry a fact progress does not hold. Every
// task sits in exactly one segment instead (done · blocked · overdue · on
// track, `ProjectComposition`), so risk is visible as a slice of the work
// rather than as a stain on the progress figure. That makes the ring the one
// polychrome object on the card, and it is the ONLY one: everything else stays
// ink plus the single rust rule down the at-risk edge (the same idiom the rail
// uses in `.dept-rail__item--waiting` — "this needs you").
//
// Dept-agnostic, props only: the caller (Home tab data wiring) computes
// progress/open/at-risk from whatever entities that department's projects are
// built from — this component never fetches or assumes a department shape.
export interface HealthRingCardProps {
  projectName: string;
  /** Link to the project's detail page; renders as plain text when omitted. */
  href?: string;
  /** 0–100. Shown small at the ring's centre; the ring itself is drawn from `composition`. */
  progressPct: number;
  /** Open (not-done) task count on this project — the card's lead figure. */
  openCount: number;
  /** Next upcoming milestone, or null/undefined when none is set. */
  nextMilestone?: { label: string; dueDate: string /* ISO */ } | null;
  /** true when overdue > 0 or blocked > 0 for this project (decision #12). */
  atRisk: boolean;
  /** Short reason, e.g. "2 overdue · 1 blocked". Rendered ONLY as the fallback for a caller that
   *  passes no `composition`: when the ring is drawn its legend already states this, more
   *  precisely, and repeating it makes risk the fourth rust-coloured thing on one card. */
  atRiskReason?: string;
  /** The ring's mutually-exclusive segments. Omit and the ring is not drawn. */
  composition?: ProjectComposition;
}

const RING_RADIUS = 40;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
/** Arc units shaved off each segment's end so adjacent segments read as separate slices. */
const SEGMENT_GAP = 3;

// Locale AND timeZone are pinned: `toLocaleDateString(undefined, …)` resolves against the
// runtime's ICU, so the server and the browser can format the same milestone differently and
// React reports a hydration mismatch. Same fix, same reason as charts/chartHover.ts::fmtDate.
function formatMilestoneDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

// Order is the reading order of the legend and the drawing order of the ring, and it is not
// arbitrary: done first (what is behind you), then the two problems, then the work still moving.
const SEGMENT_ORDER = [
  { key: "done", label: "done" },
  { key: "blocked", label: "blocked" },
  { key: "overdue", label: "overdue" },
  { key: "onTrack", label: "on track" },
] as const;

export function HealthRingCard({
  projectName,
  href,
  progressPct,
  openCount,
  nextMilestone,
  atRisk,
  atRiskReason,
  composition,
}: HealthRingCardProps) {
  const pct = Math.max(0, Math.min(100, Math.round(progressPct)));
  const total = composition?.total ?? 0;
  const slices = composition
    ? SEGMENT_ORDER.map((s) => ({ ...s, count: composition[s.key] })).filter((s) => s.count > 0)
    : [];

  // Lay the arcs out in one pass so each segment knows where the previous one ended. The gap is
  // shaved off the arc's length rather than added between arcs, so the ring always closes.
  let cursor = 0;
  const arcs = slices.map((s) => {
    const span = (s.count / total) * RING_CIRCUMFERENCE;
    const arc = { key: s.key, start: cursor, length: Math.max(span - (slices.length > 1 ? SEGMENT_GAP : 0), 0.5) };
    cursor += span;
    return arc;
  });

  const ringLabel = slices.length
    ? `${total} tasks: ${slices.map((s) => `${s.count} ${s.label}`).join(", ")}`
    : "No tasks yet";

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

      {/* Lead figure: the count you can act on, not the percentage you can only note. */}
      <p className="dept-ring-card__lead">
        <span className="dept-ring-card__lead-value">{openCount}</span>
        <span className="dept-ring-card__lead-unit">open</span>
      </p>
      {/* Progress lives here as words, not inside the ring. The ring shows a composition and the
          percentage is a different measure of the same project — `projectProgress` half-credits
          work in flight, so a ring showing 1 done of 5 sat around a centred "43%" and the two
          contradicted each other at a glance. One object, one story. */}
      <p className="dept-ring-card__lead-caption">
        {total > 0 && <>of {total} task{total === 1 ? "" : "s"} · {pct}% complete</>}
        {total > 0 && nextMilestone && " · "}
        {/* The date is one token: at narrow widths the caption wrapped between "20" and "Jul". */}
        {nextMilestone && <>{nextMilestone.label} · <span className="dept-ring-card__date">{formatMilestoneDate(nextMilestone.dueDate)}</span></>}
        {!nextMilestone && total === 0 && "No tasks yet"}
        {!nextMilestone && total > 0 && " · no milestone set"}
      </p>

      {slices.length > 0 && (
        <div className="dept-ring-card__body">
          <div className="dept-ring-wrap">
            <svg className="dept-ring" viewBox="0 0 96 96" width="96" height="96" role="img" aria-label={ringLabel}>
              <circle className="dept-ring__track" cx="48" cy="48" r={RING_RADIUS} />
              {arcs.map((a) => (
                <circle
                  key={a.key}
                  className={`dept-ring__seg dept-ring__seg--${a.key}`}
                  cx="48" cy="48" r={RING_RADIUS}
                  strokeDasharray={`${a.length} ${RING_CIRCUMFERENCE - a.length}`}
                  strokeDashoffset={-a.start}
                />
              ))}
            </svg>
          </div>
          {/* The legend is what makes the ring readable — and it is counts, not percentages: a
              project has a handful of tasks, and "62% done" of eight is precision the data does
              not have. */}
          <ul className="dept-ring-legend">
            {slices.map((s) => (
              <li key={s.key} className="dept-ring-legend__row">
                <span className={`dept-ring-legend__swatch dept-ring-legend__swatch--${s.key}`} aria-hidden="true" />
                <span className="dept-ring-legend__count">{s.count}</span>
                <span className="dept-ring-legend__label">{s.label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {slices.length === 0 && atRisk && atRiskReason && (
        <p className="dept-ring-card__reason">{atRiskReason}</p>
      )}
    </div>
  );
}
