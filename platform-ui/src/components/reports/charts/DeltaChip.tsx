import "./charts.css";
import type { ReportKpi } from "@/lib/reports";

// A signed delta vs a NAMED comparison period (never a bare arrow with no
// context — the caller supplies `comparisonLabel`, e.g. "vs 16 Jun – 4 Jul",
// from lib/reports.ts's comparisonLabel()). Color = direction × whether up is
// good (marks-and-anatomy.md's stat-tile delta contract): up_good rewards a
// rise, down_good rewards a fall (e.g. reopen rate), neutral never colors the
// number by direction at all.
export function DeltaChip({ delta, direction, unit, comparisonLabel }: {
  delta: number;
  direction?: ReportKpi["direction"];
  unit: ReportKpi["unit"];
  comparisonLabel?: string | null;
}) {
  const up = delta > 0;
  const flat = delta === 0;
  const goodDirection =
    direction === "neutral" || flat ? "neutral" : direction === "down_good" ? (up ? "down-bad" : "up-good") : (up ? "up-good" : "down-bad");
  const arrow = flat ? "•" : up ? "▲" : "▼";
  const suffix = unit === "percent" ? "pp" : unit === "minutes" ? "m" : "";
  const magnitude = `${Math.abs(delta).toLocaleString()}${suffix}`;
  return (
    <span className={`rc-delta rc-delta--${goodDirection}`}>
      <span aria-hidden>{arrow}</span>
      <span>{magnitude}</span>
      {comparisonLabel && <span className="rc-kpi__ratio">{comparisonLabel}</span>}
    </span>
  );
}
