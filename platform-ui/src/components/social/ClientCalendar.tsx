// SCP-1k — the client's calendar tab (BFF §63.10 `GET calendar`): the client's scheduled posts on a Monday-first month grid, each coloured by its phase (the
// status tokens) with a legend; the post's status and format are written in its link, so colour is never the only signal. A day shows in the zone the
// page shows dates in. Holidays and approved leave come from the department calendar (§59) and are not drawn here (the all-clients calendar, SCP-3e, draws them
// and moves dates; this tab is one client's read-only month, on the same Monday-first grid builder, weekdays and legend). A post opens the post page.
import Link from "next/link";
import type { CSSProperties } from "react";
import { CalendarLegend } from "@/components/social/CalendarLegend";
import { SimulatedMark } from "@/components/social/SimulatedMark";
import { CALENDAR_WEEKDAYS } from "@/lib/socialCalendar";
import {
  clientHref, formatWords, itemsByDay, monthGrid, monthTitle, phaseLabel, phaseStyle, postHref, shiftMonth, statusLabel, type CalendarItem,
} from "@/lib/socialClient";

export function ClientCalendar({
  deptId, engagementId, month, items, today, dayOf, timeOf,
}: {
  deptId: string; engagementId: string; month: string; items: readonly CalendarItem[]; today: string;
  /** The day (`YYYY-MM-DD`) an instant falls on, in the zone dates are shown in. */
  dayOf: (iso: string) => string;
  /** The time of day an instant falls on ("09:30"), in the same zone. */
  timeOf: (iso: string) => string;
}) {
  const weeks = monthGrid(month);
  const byDay = itemsByDay(items, dayOf);
  const inGrid = items.filter((i) => weeks.some((w) => w.some((d) => d.iso === dayOf(i.scheduledAt)))).length;
  return (
    <section aria-label="Calendar">
      <div className="scp-monthnav">
        <Link className="scp-monthnav__btn" href={clientHref(deptId, engagementId, "calendar", { month: shiftMonth(month, -1) })} aria-label="Previous month">&lsaquo;</Link>
        <h3 className="scp-monthnav__title">{monthTitle(month)}</h3>
        <Link className="scp-monthnav__btn" href={clientHref(deptId, engagementId, "calendar", { month: shiftMonth(month, 1) })} aria-label="Next month">&rsaquo;</Link>
      </div>
      <CalendarLegend />
      <div className="scp-tablewrap">
        <table className="scp-cal">
          <caption>{inGrid === 0 ? `No posts are scheduled in ${monthTitle(month)}.` : `${inGrid} ${inGrid === 1 ? "post" : "posts"} scheduled in view.`}</caption>
          <thead>
            <tr>{CALENDAR_WEEKDAYS.map((d) => <th key={d} scope="col">{d}</th>)}</tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w[0].iso}>
                {w.map((d) => {
                  const day = byDay.get(d.iso) ?? [];
                  return (
                    <td key={d.iso} className={[d.inMonth ? "" : "scp-cal__out", d.iso === today ? "scp-cal__today" : ""].filter(Boolean).join(" ")} data-day={d.iso}>
                      <span className="scp-cal__day">{Number(d.iso.slice(8))}</span>
                      {day.length > 0 && (
                        <ul className="scp-cal__items">
                          {day.map((it) => (
                            <li key={it.postId}>
                              <Link
                                href={postHref(deptId, it.postId)} className="scp-cal__post" style={phaseStyle(it.phase) as CSSProperties} data-phase={it.phase ?? ""}
                                title={`${it.title} · ${formatWords(it.format)} · ${statusLabel(it.pipelineStatus)} · ${phaseLabel(it.phase)}`}
                              >
                                {timeOf(it.scheduledAt)} {it.title}
                                {it.simulated && <> <SimulatedMark /></>}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
