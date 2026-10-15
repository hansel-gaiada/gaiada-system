import Link from "next/link";
import { NOTHING_TODAY, type MyActivity } from "@/lib/overviewActivity";
import { HeatmapLegend, fmtDay, monthShort } from "@/components/pm/activityHeatmap";
import "@/components/pm/productivity.css";

/** Where the full year lives: Analytics > My activity (DW-4i, BFF section 44.9). */
export const MY_ACTIVITY_HREF = "/analytics/activity";

/** What the block says when the server refused the read (403): nothing is drawn and nothing is claimed. */
export const NOTHING_SHOWN = "Nothing is shown: you can't read this activity";

// DW-3j, DW-4h-3: the Overview's "My activity" block. The heatmap of the last 16 weeks reuses the year map's cells, levels
// and legend (`components/pm/activityHeatmap`, `productivity.css`); "Today so far" lists today's counts by the server's own
// kinds. Nothing here is a rating (DW-D19): a day's total is its shade and its tooltip ("5 things done"). A model of null
// is the server's refusal (403): the block says nothing is shown. A failed read never reaches this component: the widget
// throws and the frame's boundary says "Unavailable".
export function MyActivityBlock({ model, activityHref }: { model: MyActivity | null; activityHref: string }) {
  if (model === null) {
    return (
      <section className="ov-block" aria-label="My activity">
        <h3 className="ov-block__title">My activity</h3>
        <p className="ov-block__note">{NOTHING_SHOWN}</p>
      </section>
    );
  }

  // A month label over the first column whose week holds the 1st (or the very first column).
  const months = Array.from({ length: model.weekCount }, (_, w) => {
    const first = model.cells.slice(w * 7, w * 7 + 7).find((c): c is NonNullable<typeof c> => c !== null);
    if (!first) return "";
    return w === 0 || Number(first.date.slice(8, 10)) <= 7 ? monthShort(first.date) : "";
  });
  const columns = `repeat(${model.weekCount}, 11px)`;

  return (
    <section className="ov-block ov-act" aria-label="My activity">
      <h3 className="ov-block__title">My activity</h3>

      <div className="ov-act__body">
        {model.from && model.to ? (
          <div className="ov-act__map prod-heatmap">
            <div className="prod-heatmap__scroll">
              <div className="prod-heatmap__months" style={{ gridTemplateColumns: columns }} aria-hidden>
                {months.map((m, i) => <span key={i} className="prod-heatmap__month">{m}</span>)}
              </div>
              <div
                className="prod-heatmap__grid"
                style={{ gridTemplateColumns: columns }}
                role="img"
                aria-label={`Activity calendar, ${fmtDay(model.from)} to ${fmtDay(model.to)}`}
              >
                {model.cells.map((c, i) => (
                  c === null
                    ? <span key={`b-${i}`} className="prod-heatmap__cell" style={{ visibility: "hidden" }} aria-hidden />
                    : <span key={c.date} className="prod-heatmap__cell ov-act__cell" data-level={c.level} title={c.label} />
                ))}
              </div>
            </div>
            <HeatmapLegend />
          </div>
        ) : (
          <p className="ov-block__note">No activity history in range</p>
        )}

        {model.today && (
          <div className="ov-act__today">
            <h4 className="ov-block__sub">Today so far</h4>
            {model.counts.length === 0 ? (
              <p className="ov-block__note">{NOTHING_TODAY}</p>
            ) : (
              <ul className="ov-act__counts">
                {model.counts.map((c) => (
                  <li key={c.key} className="ov-act__count">
                    <span className="ov-act__value">{c.value}</span>
                    <span className="ov-act__kind">{c.label}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <Link href={activityHref} className="ov-nums__link">Open my activity</Link>
    </section>
  );
}
