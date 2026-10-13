import "./charts.css";
import type { ReportKpi } from "@/lib/reports";

// A signed delta vs a NAMED comparison period (never a bare arrow with no
// context — the caller supplies `comparisonLabel`, e.g. "vs 16 Jun – 4 Jul",
// from lib/reports.ts's comparisonLabel()). Color = direction × whether up is
// good (marks-and-anatomy.md's stat-tile delta contract): up_good rewards a
// rise, down_good rewards a fall (e.g. reopen rate), neutral never colors the
// number by direction at all.
//
// `magnitude` (DW-3d) lets a caller that shows the figure in another unit than the report does (the Overview
// draws minutes as hours and a ratio's delta as percentage points) say it in its own words; the colour and the
// arrow still come from `delta` and `direction`, so there is one rule for good and bad.
export function DeltaChip({ delta, direction, unit, comparisonLabel, magnitude: shown }: {
  delta: number;
  direction?: ReportKpi["direction"];
  unit: ReportKpi["unit"];
  comparisonLabel?: string | null;
  magnitude?: string;
}) {
  const up = delta > 0;
  const flat = delta === 0;
  const goodDirection =
    direction === "neutral" || flat ? "neutral" : direction === "down_good" ? (up ? "down-bad" : "up-good") : (up ? "up-good" : "down-bad");
  const arrow = flat ? "•" : up ? "▲" : "▼";
  const suffix = unit === "percent" ? "pp" : unit === "minutes" ? "m" : "";
  const magnitude = shown ?? `${Math.abs(delta).toLocaleString()}${suffix}`;
  return (
    <span className={`rc-delta rc-delta--${goodDirection}`}>
      <span aria-hidden>{arrow}</span>
      <span>{magnitude}</span>
      {comparisonLabel && <span className="rc-kpi__ratio">{comparisonLabel}</span>}
    </span>
  );
}
