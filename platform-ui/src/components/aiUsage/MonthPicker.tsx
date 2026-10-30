import Link from "next/link";
import { currentMonth, monthLabel, recentMonths, shiftMonth } from "@/lib/aiUsage";
import "./aiUsage.css";

// AIP-16 and AIP-05: the month picker (UTC calendar months, BFF §66.2). A server component with no script: previous and next are links, and a plain GET form
// jumps to any of the last twelve months, so it works before the page has hydrated and keeps the page's other query (`unit`) as it was.
// The default is the current UTC month, and a month after it is never offered.
export function MonthPicker({ month, basePath, params = {}, now }: {
  month: string;
  basePath: string;
  /** The page's other query, kept on every link and in the form (the department page's `unit`). */
  params?: Record<string, string>;
  now?: Date;
}) {
  const cur = currentMonth(now);
  const href = (m: string) => {
    const qs = new URLSearchParams(params);
    qs.set("month", m);
    return `${basePath}?${qs.toString()}`;
  };
  const choices = recentMonths(now, 12);
  if (!choices.includes(month)) choices.push(month);
  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  return (
    <div className="aiu-month">
      <nav className="aiu-month__nav" aria-label="Month">
        <Link href={href(prev)} className="aiu-month__link" rel="prev">&lsaquo; {monthLabel(prev)}</Link>
        <span className="aiu-month__now" aria-current="date">{monthLabel(month)}</span>
        {next <= cur ? <Link href={href(next)} className="aiu-month__link" rel="next">{monthLabel(next)} &rsaquo;</Link> : null}
        {month !== cur ? <Link href={href(cur)} className="aiu-month__link">This month</Link> : null}
      </nav>
      <form method="get" action={basePath} className="aiu-month__form">
        {Object.entries(params).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
        <label className="aiu-month__label">
          <span>Choose a month</span>
          <select name="month" defaultValue={month} className="aiu-month__select">
            {choices.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
        </label>
        <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Show</button>
      </form>
    </div>
  );
}
