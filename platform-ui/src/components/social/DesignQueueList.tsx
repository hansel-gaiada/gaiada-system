// SCP-1h (BFF §63.6.6): the designer's queue as a list. One row per post the caller may design now: the title opens the post page, the client,
// the format, the step the design is at and the ready-by sit under it, the schedule health beside it, and a revision shows the note that asked for it
// on the row itself (a revision is why the post came back, so it is read before the post is opened). Server-rendered: nothing here needs the browser.
import Link from "next/link";
import { HealthChip } from "./HealthChip";
import { creativeStateLabel, designQueuePostHref, formatLabel, type DesignQueueItem } from "@/lib/socialDesignQueue";
import "./cycles.css";
import "./design-queue.css";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "24 Oct 2026" from a plain `YYYY-MM-DD` (never through `Date`, so no time zone can move the day). */
const readyByText = (iso: string): string => {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d || m > 12) return iso;
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

export function DesignQueueList({ items, deptId }: { items: DesignQueueItem[]; deptId: string }) {
  return (
    <ul className="scp-dq" aria-label="Posts to design">
      {items.map((it) => (
        <li key={it.postId} className="scp-dq__row" data-post-id={it.postId}>
          <div className="scp-dq__main">
            <Link className="scp-dq__title" href={designQueuePostHref(deptId, it.postId)}>{it.title || "Untitled post"}</Link>
            <span className="scp-dq__meta">
              <span>{it.clientName}</span>
              <span>{formatLabel(it.format)}</span>
              <span>Ready by {readyByText(it.readyBy)}</span>
            </span>
            {it.revisionNote && (
              <p className="scp-dq__revision">
                <span className="scp-dq__revision-label">Revision asked for</span>
                {it.revisionNote}
              </p>
            )}
          </div>
          <div className="scp-dq__side">
            <span className="scp-dq__state" data-state={it.creativeState ?? "not_started"}>{creativeStateLabel(it.creativeState)}</span>
            <HealthChip health={it.health} />
          </div>
        </li>
      ))}
    </ul>
  );
}
