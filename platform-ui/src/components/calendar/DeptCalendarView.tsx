import Link from "next/link";
import {
  CHIP_KIND_LABEL, WEEKDAY_LABELS, agendaDays, agendaEmptyText, chipsByDay, dayLabel, inMonth, legNotes, monthTitle, sixWeekGrid,
  type Chip, type ChipKind, type DeptCalendar,
} from "@/lib/deptCalendar";
import { dayNumber } from "@/lib/calendar";
import "./calendar.css";

// DW-10c-3 (BFF §59.4): the department calendar's body. A server component: it draws the six-week month grid, the legend, a note for
// every leg that did not load, and the agenda.
//
// THE GRID IS A REAL TABLE, and the agenda is its linear twin. A table (a caption, `scope="col"` weekday headers, one cell per day
// with its full date) lets a screen-reader user move by day and by weekday, which the agenda cannot; the agenda is the reading order
// for anyone who wants the month as a list, with each item's kind said in words. The grid is therefore neither `aria-hidden` (a
// keyboard user would still land on its links) nor `role="presentation"` (the day/weekday structure is real data). The chips carry
// their kind as a shape and a `title`; the agenda says it in words. A cell shows three chips and then "+N more", which jumps to that
// day in the agenda.
//
// A leg that is not included has no chips, and its note says so above the grid: the absence of a chip is never "nobody is away".

const CHIP_LIMIT = 3;
const KINDS: ChipKind[] = ["holiday", "away", "milestone", "event"];

function GridChip({ chip }: { chip: Chip }) {
  const cls = `cal-dept__chip cal-dept__chip--${chip.kind}`;
  const title = `${CHIP_KIND_LABEL[chip.kind]}: ${chip.label}`;
  const inner = <span className="cal-dept__chip-text">{chip.label}</span>;
  return chip.href
    ? <Link href={chip.href} className={cls} title={title}>{inner}</Link>
    : <span className={cls} title={title}>{inner}</span>;
}

export function DeptCalendarLegend() {
  return (
    <ul className="cal-dept__legend" aria-label="Legend">
      {KINDS.map((k) => (
        <li key={k} className="cal-dept__legend-item">
          <span className={`cal-dept__swatch cal-dept__swatch--${k}`} aria-hidden="true" />
          {{ holiday: "Holiday", away: "Away (name · leave type)", milestone: "Milestone (project · milestone)", event: "Event (time · title)" }[k]}
        </li>
      ))}
    </ul>
  );
}

export function DeptCalendarView({ cal, tenantId, month, today }: { cal: DeptCalendar; tenantId: string; month: string; today: string }) {
  const weeks = sixWeekGrid(month);
  const byDay = chipsByDay(cal, tenantId);
  const days = agendaDays(byDay);
  const notes = legNotes(cal);

  return (
    <div className="cal-dept">
      <DeptCalendarLegend />
      {notes.length > 0 && (
        <ul className="cal-dept__notes" aria-label="What could not be loaded">
          {notes.map((n) => <li key={`${n.leg}:${n.text}`} className="cal-dept__note">{n.text}</li>)}
        </ul>
      )}
      <p className="cal-dept__skip"><a href="#cal-dept-agenda">Go to the agenda list</a></p>

      <table className="cal-dept__grid">
        <caption className="cal-dept__caption">{monthTitle(month)}, weeks start on Monday</caption>
        <thead>
          <tr>{WEEKDAY_LABELS.map((w) => <th key={w} scope="col" className="type-eyebrow cal-dept__wd">{w}</th>)}</tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((iso) => {
                const chips = byDay.get(iso) ?? [];
                const extra = chips.length - CHIP_LIMIT;
                return (
                  <td key={iso} className={["cal-dept__cell", inMonth(iso, month) ? "" : "cal-dept__cell--outside", iso === today ? "cal-dept__cell--today" : ""].filter(Boolean).join(" ")}>
                    <time dateTime={iso} className="cal-dept__num" title={dayLabel(iso)}>{dayNumber(iso)}</time>
                    {chips.length > 0 && (
                      <div className="cal-dept__chips">
                        {chips.slice(0, CHIP_LIMIT).map((c) => <GridChip key={c.key} chip={c} />)}
                        {extra > 0 && <a href={`#cal-dept-day-${iso}`} className="cal-dept__more">+{extra} more</a>}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <section id="cal-dept-agenda" className="cal-dept__agenda" aria-labelledby="cal-dept-agenda-h">
        <h4 id="cal-dept-agenda-h" className="cal-dept__agenda-h">Agenda</h4>
        {days.length === 0 ? (
          <p className="cal-dept__empty">{agendaEmptyText(cal)}</p>
        ) : (
          <ol className="cal-dept__days" aria-label={`${monthTitle(month)} agenda, by day`}>
            {days.map(({ day, chips }) => (
              <li key={day} id={`cal-dept-day-${day}`} className="cal-dept__day">
                <h5 className="cal-dept__day-h"><time dateTime={day}>{dayLabel(day)}</time></h5>
                <ul className="cal-dept__items">
                  {chips.map((c) => (
                    <li key={c.key} className="cal-dept__item">
                      <span className={`cal-dept__swatch cal-dept__swatch--${c.kind}`} aria-hidden="true" />
                      <span className="cal-dept__kind">{CHIP_KIND_LABEL[c.kind]}</span>
                      {c.href ? <Link href={c.href} className="cal-dept__label">{c.label}</Link> : <span className="cal-dept__label">{c.label}</span>}
                      {c.detail && <span className="cal-dept__detail">{c.detail}</span>}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
