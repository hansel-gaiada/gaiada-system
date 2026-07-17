import Link from "next/link";
import type { Timeline } from "@/lib/pm";
import "./pm.css";

// Read-only Gantt: bars positioned on a shared date axis (see computeTimeline).
// Bar colour = status; a dashed edge marks tasks with no start date (bar begins
// at the due date). Server-safe.
export function Gantt({ timeline }: { timeline: Timeline }) {
  const fmt = (d: string) => new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  return (
    <div className="erp-scroll" style={{ overflowX: "auto" }}>
      <div className="pm-gantt">
        <div className="pm-gantt__axis"><span>{fmt(timeline.start)}</span><span>{fmt(timeline.end)}</span></div>
        {timeline.bars.map((b) => (
          <div className="pm-gantt__row" key={b.task.id}>
            <Link className="pm-gantt__label" href={`/tasks/${b.task.id}`}>{b.task.title}</Link>
            <div className="pm-gantt__track">
              <Link
                href={`/tasks/${b.task.id}`}
                className={`pm-gantt__bar pm-gantt__bar--${b.task.status}${b.startsMissing ? " pm-gantt__bar--dashed" : ""}`}
                style={{ left: `${b.offsetPct}%`, width: `${b.widthPct}%` }}
                title={`${b.task.title} · ${b.task.progress}%${b.task.dueDate ? ` · due ${fmt(b.task.dueDate)}` : ""}`}
              >
                {b.task.progress}%
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
