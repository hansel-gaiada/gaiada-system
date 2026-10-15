import Link from "next/link";
import { HeatmapLegend, fmtDay, monthShort } from "@/components/pm/activityHeatmap";
import { kindsLegend, type ActivitySeries, type YearMap } from "@/lib/activitySeriesFormat";
import "@/components/pm/productivity.css";
import "./activity.css";

// DW-4i: the year map of all work. A grid with one row per week and one cell per day; every cell is a link that selects the day
// and carries its own label ("14 Oct 2026: 3 things done. Commits 2, Site edits 1"). The shade is the day's VOLUME against the
// busiest day of the window and is worded as such: never a score or a rating (DW-D19). Server-rendered, so selecting a day works
// without JavaScript. The cells, levels and legend are the Overview's and Productivity's (`components/pm/activityHeatmap`).
export function ActivityYearMap({ map, hrefFor, selected }: { map: YearMap; hrefFor: (date: string) => string; selected: string | null }) {
  if (map.cells.length === 0 || !map.from || !map.to) return <p className="act__note">No days in range.</p>;

  const weeks = Array.from({ length: map.weekCount }, (_, w) => map.cells.slice(w * 7, w * 7 + 7));
  // A month label over the first column whose week holds the 1st (or the very first column).
  const months = weeks.map((week, w) => {
    const first = week.find((c) => c !== null);
    if (!first) return "";
    return w === 0 || Number(first.date.slice(8, 10)) <= 7 ? monthShort(first.date) : "";
  });
  const columns = `repeat(${map.weekCount}, 11px)`;

  return (
    <div className="act-map prod-heatmap">
      <p className="act__note">
        <strong>{map.activeDays}</strong> of {map.dayCount} days had something recorded. A darker day means more things done that
        day, compared with the busiest day here; it is a volume, not a rating.
      </p>
      <div className="act-map__scroll">
        <div className="prod-heatmap__months" style={{ gridTemplateColumns: columns }} aria-hidden>
          {months.map((m, i) => <span key={i} className="prod-heatmap__month">{m}</span>)}
        </div>
        <div className="act-map__grid" role="grid" aria-label={`Activity calendar, ${fmtDay(map.from)} to ${fmtDay(map.to)}`} aria-readonly="true">
          {weeks.map((week, w) => (
            <div key={w} className="act-map__week" role="row">
              {week.map((c, i) => (
                c === null
                  ? <span key={`b-${i}`} className="act-map__blank" aria-hidden />
                  : (
                    <span key={c.date} role="gridcell" className="prod-heatmap__cell act-map__cell" data-level={c.level} data-selected={selected === c.date}>
                      <Link
                        href={hrefFor(c.date)}
                        prefetch={false}
                        scroll={false}
                        aria-label={c.label}
                        aria-current={selected === c.date ? "date" : undefined}
                        title={c.label}
                      />
                    </span>
                  )
              ))}
            </div>
          ))}
        </div>
      </div>
      <HeatmapLegend />
    </div>
  );
}

/** The kinds legend: every kind the server lists, never a fixed list, with its count over the window. */
export function ActivityKinds({ series }: { series: Pick<ActivitySeries, "kinds" | "totals"> }) {
  const legend = kindsLegend(series);
  if (legend.length === 0) return <p className="act__note">No kinds of work are recorded for this company yet.</p>;
  return (
    <ul className="act-kinds" aria-label="Kinds of work counted">
      {legend.map((k) => (
        <li key={k.key} className="act-kinds__item">
          <span className="act-kinds__n">{k.n}</span>
          <span>{k.label}</span>
        </li>
      ))}
    </ul>
  );
}
