import Link from "next/link";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Card } from "@/components/ui";
import {
  bucketByDay, COUNTS_WITHHELD_WORDS, filterChoices, outsideGrid, PLACEMENT_LEGEND, shortDay, TRUNCATED_WORDS, unscheduled, UTC_NOTE, WEEKDAYS,
  type CalendarBody, type CalendarFilters, type CalendarGrid,
} from "@/lib/webdeskCalendarModel";
import { CalendarEntryLine } from "./CalendarEntryLine";
import { WorkflowNav } from "./WorkflowNav";
import "./editorial.css";

/**
 * `writers/calendar/[tenant]/[site]`: the month or week view of the site's editorial calendar.
 *
 * Every item sits on ONE day and says which date that is (`placement.kind`, with the legend below the title); drafts with no date are in
 * the "Unscheduled" list; days are UTC days. Navigation is plain links and a GET form: no client state, no action buttons. A failed read never
 * reaches this component (the page shows the notice instead), so an empty grid here is a true "nothing in this window".
 */
export function WritersCalendar({
  body, grid, base, boardHref, editorBase, briefBase, authors, filters, siteLocales, today,
}: {
  body: CalendarBody;
  grid: CalendarGrid;
  /** `…/writers/calendar/:tenant/:site` (this page). */
  base: string;
  boardHref: string;
  editorBase: string;
  briefBase: string;
  authors: Record<string, string>;
  filters: CalendarFilters;
  siteLocales: readonly string[];
  /** The UTC day "today" is (passed in: this component never reads a clock). */
  today: string;
}) {
  const byDay = bucketByDay(body.entries);
  const un = unscheduled(body.entries);
  const stray = outsideGrid(body.entries, grid.from, grid.to);
  const choices = filterChoices(body, siteLocales);
  const filtered = !!(filters.collection || filters.locale || filters.assignee);
  const href = (over: { view?: string; day?: string }) => {
    const p = new URLSearchParams({ view: over.view ?? grid.view, day: over.day ?? grid.anchor });
    if (filters.collection) p.set("collection", filters.collection);
    if (filters.locale) p.set("locale", filters.locale);
    if (filters.assignee) p.set("assignee", filters.assignee);
    return `${base}?${p.toString()}`;
  };
  const placed = body.entries.length - un.length;

  return (
    <div className="wc-page" data-testid="writers-calendar">
      <WorkflowNav boardHref={boardHref} calendarHref={base} current="calendar" />
      <p className="wc-lede">
        When things are due, planned and going live. Each item sits on one day, and says which kind of day it is. {UTC_NOTE}
      </p>

      <ul className="we-legend" aria-label="What a date means" data-testid="calendar-legend">
        {PLACEMENT_LEGEND.map((l) => (
          <li key={l.kind}><span aria-hidden="true">{l.glyph}</span> <strong>{l.label}</strong> — {l.sentence}</li>
        ))}
      </ul>

      {body.countsWithheld && (
        <div className="wc-banner wc-banner--info" role="note" data-testid="counts-withheld">
          <span className="wc-banner__body"><strong>Counts are hidden for your access.</strong> {COUNTS_WITHHELD_WORDS.replace("Counts are hidden for your access. ", "")} The calendar lists only the items you can see.</span>
        </div>
      )}
      {body.truncated && (
        <div className="wc-banner wc-banner--warn" role="alert" data-testid="calendar-truncated">
          <span className="wc-banner__body"><strong>Some items may be missing.</strong> {TRUNCATED_WORDS}</span>
        </div>
      )}
      {stray.length > 0 && (
        <div className="wc-banner wc-banner--warn" role="alert" data-testid="calendar-stray">
          <span className="wc-banner__body">{stray.length} item{stray.length === 1 ? " is" : "s are"} dated outside this view, so {stray.length === 1 ? "it is" : "they are"} not drawn on the grid. Reload to try again.</span>
        </div>
      )}

      <div className="we-cal-bar">
        <h2 className="we-cal-title" data-testid="calendar-title">{grid.title}</h2>
        <div className="we-cal-nav">
          <Link href={href({ day: grid.prev })} className="lux-btn lux-btn--ghost lux-btn--sm" data-testid="cal-prev">Previous {grid.view}</Link>
          <Link href={href({ day: today })} className="lux-btn lux-btn--ghost lux-btn--sm" data-testid="cal-today">Today</Link>
          <Link href={href({ day: grid.next })} className="lux-btn lux-btn--ghost lux-btn--sm" data-testid="cal-next">Next {grid.view}</Link>
          <Link href={href({ view: "month" })} className="lux-btn lux-btn--ghost lux-btn--sm" aria-current={grid.view === "month" ? "true" : undefined} data-testid="view-month">Month</Link>
          <Link href={href({ view: "week" })} className="lux-btn lux-btn--ghost lux-btn--sm" aria-current={grid.view === "week" ? "true" : undefined} data-testid="view-week">Week</Link>
        </div>
      </div>

      <form method="get" action={base} className="wc-filter" aria-label="Filter the calendar">
        <input type="hidden" name="view" value={grid.view} />
        <input type="hidden" name="day" value={grid.anchor} />
        <div className="lux-field">
          <label className="lux-field__label" htmlFor="wcal-collection">Collection</label>
          <select id="wcal-collection" name="collection" className="lux-field__control" defaultValue={filters.collection ?? ""}>
            <option value="">All collections</option>
            {choices.collections.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="lux-field">
          <label className="lux-field__label" htmlFor="wcal-locale">Language</label>
          <select id="wcal-locale" name="locale" className="lux-field__control" defaultValue={filters.locale ?? ""}>
            <option value="">All languages</option>
            {choices.locales.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <label className="we-check" htmlFor="wcal-mine">
          <input id="wcal-mine" type="checkbox" name="assignee" value="me" defaultChecked={filters.assignee === "me"} /> Assigned to me
        </label>
        <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Apply</button>
        {filtered && <Link href={`${base}?view=${grid.view}&day=${grid.anchor}`} className="lux-btn lux-btn--ghost lux-btn--sm">Clear</Link>}
      </form>

      {body.entries.length === 0 && (
        <p className="wc-muted" data-testid="calendar-empty" role="status">
          {filtered
            ? "No items match these filters in this view, and there are no undated drafts that match."
            : "Nothing is due, planned or scheduled in this view, and there are no undated drafts."}
        </p>
      )}

      <table className="we-cal" data-testid="calendar-grid" data-view={grid.view}>
        <caption className="we-sr">{grid.title}: {placed} dated item{placed === 1 ? "" : "s"}</caption>
        <thead>
          <tr>{WEEKDAYS.map((d) => <th key={d} scope="col">{d}</th>)}</tr>
        </thead>
        <tbody>
          {grid.weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((day) => {
                const list = byDay.get(day) ?? [];
                const out = grid.view === "month" && day.slice(0, 7) !== grid.month;
                return (
                  <td key={day} className={`we-cal__day${out ? " we-cal__day--out" : ""}${day === today ? " we-cal__day--today" : ""}`} data-day={day} data-testid={`day-${day}`}>
                    <span className="we-cal__date">{grid.view === "week" ? shortDay(day) : Number(day.slice(8, 10))}{day === today ? <span className="we-sr"> (today)</span> : null}</span>
                    {list.length > 0 && (
                      <ul className="we-cal__list">
                        {list.map((e) => <CalendarEntryLine key={e.itemId} entry={e} editorBase={editorBase} briefBase={briefBase} authors={authors} />)}
                      </ul>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <Card title={`Unscheduled (${un.length})`}>
        {un.length === 0 ? (
          <EmptyNote>{filtered ? "No undated drafts match these filters." : "Every draft has a date. Nothing is waiting to be scheduled."}</EmptyNote>
        ) : (
          <>
            <p className="wc-muted">Drafts with no due date, planned date or requested publish time.</p>
            <ul className="we-cal__list we-cal__list--wide" data-testid="unscheduled-list">
              {un.map((e) => <CalendarEntryLine key={e.itemId} entry={e} editorBase={editorBase} briefBase={briefBase} authors={authors} />)}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}
