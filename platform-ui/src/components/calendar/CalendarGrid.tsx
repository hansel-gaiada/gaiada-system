import Link from "next/link";
import { StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import {
  WEEKDAY_LABELS, dayNumber, groupByDate, isOverdue, monthGrid, sameMonth, weekDays,
  type CalItem,
} from "@/lib/calendar";
import "./calendar.css";

// Month / Week / Day grids. Server components on purpose: navigation and view switching are plain
// links carrying ?view= and ?date=, so the calendar needs no client JS, keeps working without it,
// and every state is a shareable URL.
//
// All-day layout, not hour rows: a task has a due DATE and no time, so hour columns would be
// scaffolding with nothing in them. This is the equivalent of a calendar's all-day band.

const CHIP_LIMIT = 3;

function Chip({ item, today }: { item: CalItem; today: string }) {
  const over = isOverdue(item.date, today);
  return (
    <Link
      href={item.href}
      className={`cal-chip${over ? " cal-chip--overdue" : ""}`}
      title={`${item.title}${item.projectName ? ` · ${item.projectName}` : ""}${item.company ? ` · ${item.company}` : ""}`}
    >
      <span className="cal-chip__dot" aria-hidden="true" />
      <span className="cal-chip__text">{item.title}</span>
    </Link>
  );
}

export function MonthView({ anchor, today, items, dayHref }: {
  anchor: string; today: string; items: CalItem[];
  /** Builds the link for a day cell's date — clicking a day opens it in Day view. */
  dayHref: (iso: string) => string;
}) {
  const weeks = monthGrid(anchor);
  const byDate = groupByDate(items);
  return (
    <div className="cal-month">
      <div className="cal-month__head" role="row">
        {WEEKDAY_LABELS.map((w) => (
          <span key={w} className="type-eyebrow cal-month__wd" role="columnheader">{w}</span>
        ))}
      </div>
      {weeks.map((week) => (
        <div className="cal-month__row" key={week[0]} role="row">
          {week.map((iso) => {
            const dayItems = byDate.get(iso) ?? [];
            const extra = dayItems.length - CHIP_LIMIT;
            return (
              <div
                key={iso}
                role="gridcell"
                className={[
                  "cal-cell",
                  sameMonth(iso, anchor) ? "" : "cal-cell--outside",
                  iso === today ? "cal-cell--today" : "",
                ].filter(Boolean).join(" ")}
              >
                <Link href={dayHref(iso)} className="cal-cell__num" aria-label={`Open ${iso}`}>
                  {dayNumber(iso)}
                </Link>
                <div className="cal-cell__items">
                  {dayItems.slice(0, CHIP_LIMIT).map((it) => <Chip key={it.id} item={it} today={today} />)}
                  {extra > 0 && (
                    <Link href={dayHref(iso)} className="cal-cell__more">+{extra} more</Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function WeekView({ anchor, today, items, dayHref }: {
  anchor: string; today: string; items: CalItem[]; dayHref: (iso: string) => string;
}) {
  const days = weekDays(anchor);
  const byDate = groupByDate(items);
  return (
    <div className="cal-week">
      {days.map((iso) => {
        const dayItems = byDate.get(iso) ?? [];
        return (
          <div key={iso} className={`cal-week__col${iso === today ? " cal-week__col--today" : ""}`}>
            <Link href={dayHref(iso)} className="cal-week__head">
              <span className="type-eyebrow">{WEEKDAY_LABELS[days.indexOf(iso)]}</span>
              <span className="cal-week__num">{dayNumber(iso)}</span>
            </Link>
            <div className="cal-week__items">
              {dayItems.length === 0
                ? <span className="cal-week__empty" aria-hidden="true">·</span>
                : dayItems.map((it) => <Chip key={it.id} item={it} today={today} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function DayView({ anchor, today, items }: { anchor: string; today: string; items: CalItem[] }) {
  const dayItems = groupByDate(items).get(anchor) ?? [];
  if (dayItems.length === 0) {
    return <EmptyNote>Nothing of yours is due on this day.</EmptyNote>;
  }
  return (
    <div className="cal-day">
      {dayItems.map((it) => (
        <div key={it.id} className="cal-day__row">
          <Link href={it.href} className="cal-day__title">{it.title}</Link>
          <span className="cal-day__meta">
            {it.projectName && <span>{it.projectName}</span>}
            {it.company && <span>{it.company}</span>}
            {isOverdue(it.date, today) && <span className="cal-day__overdue">Overdue</span>}
          </span>
          <StatusBadge label={it.status} />
        </div>
      ))}
    </div>
  );
}
