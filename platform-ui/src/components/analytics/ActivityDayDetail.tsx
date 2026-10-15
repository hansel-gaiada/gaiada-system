import Link from "next/link";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { fmtDay } from "@/components/pm/activityHeatmap";
import type { ActivityDayResult } from "@/lib/activitySeries";
import { groupDayItems, safeLink, timeOfItem, type ActivityKind } from "@/lib/activitySeriesFormat";
import "./activity.css";

export const DAY_HINT = "Select a day on the map to see what was done.";
export const DAY_NOTHING = "Nothing recorded on this day.";

// DW-4i: one day's detail (`GET /activity/day`, BFF section 44.4): the work's own names by kind, with the time and a link when
// the ERP has a page for it. Never message or comment text (the server returns none). A refusal and a failure are said in
// words; neither reads as "nothing happened".
export function ActivityDayDetail({
  date, result, kinds, timezone,
}: { date: string | null; result: ActivityDayResult | null; kinds: readonly ActivityKind[]; timezone: string }) {
  if (date === null || result === null) return <p className="act__note">{DAY_HINT}</p>;
  if (result.kind === "forbidden") return <EmptyNote>No access: you can&apos;t read this person&apos;s work for {fmtDay(date)}.</EmptyNote>;
  if (result.kind === "error") return <EmptyNote>Unavailable: this day&apos;s detail could not be read ({result.reason}).</EmptyNote>;
  const groups = groupDayItems(result.data.items, kinds);
  if (groups.length === 0) return <p className="act__note">{DAY_NOTHING}</p>;
  return (
    <div className="act-day">
      {groups.map((g) => (
        <div key={g.key} className="act-day__group">
          <h4 className="act__sub">{g.label}</h4>
          <ul className="act-day__list">
            {g.items.map((it, i) => {
              const href = safeLink(it.link);
              return (
                <li key={`${it.at}-${i}`} className="act-day__item">
                  <time className="act-day__time" dateTime={it.at}>{timeOfItem(it.at, timezone)}</time>
                  {href ? <Link href={href}>{it.title}</Link> : <span>{it.title}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
