import Link from "next/link";
import "./editorial.css";

/** Board | Calendar for one site. The current one is `aria-current="page"` and a word, not a colour. */
export function WorkflowNav({ boardHref, calendarHref, current }: { boardHref: string; calendarHref: string; current: "board" | "calendar" }) {
  return (
    <nav className="we-tabs" aria-label="Writers' room views" data-testid="workflow-nav">
      <Link href={boardHref} className="we-tab" aria-current={current === "board" ? "page" : undefined} data-testid="tab-board">Board</Link>
      <Link href={calendarHref} className="we-tab" aria-current={current === "calendar" ? "page" : undefined} data-testid="tab-calendar">Calendar</Link>
    </nav>
  );
}
