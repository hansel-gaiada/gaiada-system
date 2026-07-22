import Link from "next/link";
import { TeachState } from "./TeachState";

// Cross-source work timeline for a department (F2 `work_activity`, decision
// #2/#3 in web-dev-phase1-tickets.md): PM events today, GitHub/Drive once
// Phase-2 lands their auto-link rules. This component only renders rows —
// the caller fetches `/api/:t/work-activity`, sorts newest-first, and passes
// the array; grouping-by-day here is pure display math on `occurredAt`, not
// a fetch. Dept-agnostic: `source` is a fixed enum shared by every department
// (nothing Web-Dev-specific), and the empty state teaches the same way for all.
export type ActivitySource = "pm" | "pipeline" | "github" | "google_drive" | "claude" | "manual" | "system";

export interface ActivityItem {
  id: string;
  /** Display name of who did it; omitted for system-generated rows. */
  actor?: string | null;
  /** Already humanized by the caller, e.g. "created", "commented on", "shipped". */
  verb: string;
  /** e.g. "Task: Fix login redirect", "Doc: Q3 brief". */
  objectLabel: string;
  href?: string;
  /** ISO timestamp. */
  occurredAt: string;
  source?: ActivitySource;
}

export interface ActivityFeedProps {
  /** Newest-first. The component groups consecutive same-day rows; it does not re-sort. */
  items: ActivityItem[];
  emptyTitle?: string;
  emptyBody?: string;
  emptyCtaLabel?: string;
  emptyCtaHref?: string;
}

const SOURCE_LABEL: Record<ActivitySource, string> = {
  pm: "PM",
  pipeline: "Pipeline",
  github: "GitHub",
  google_drive: "Drive",
  claude: "Claude",
  manual: "Manual",
  system: "System",
};

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function ActivityFeed({ items, emptyTitle, emptyBody, emptyCtaLabel, emptyCtaHref }: ActivityFeedProps) {
  if (items.length === 0) {
    return (
      <TeachState
        glyph="◐"
        title={emptyTitle ?? "No activity yet"}
        body={emptyBody ?? "Work from PM, repos, and docs will show up here as soon as it happens."}
        ctaLabel={emptyCtaLabel}
        ctaHref={emptyCtaHref}
      />
    );
  }

  let lastDay = "";
  return (
    <ol className="dept-activity">
      {items.map((item) => {
        const day = dayLabel(item.occurredAt);
        const showDayHeader = day !== lastDay;
        lastDay = day;
        const body = (
          <>
            <span className="dept-activity__chip" data-source={item.source ?? "system"}>
              {SOURCE_LABEL[item.source ?? "system"]}
            </span>
            <span className="dept-activity__text">
              {item.actor && <strong>{item.actor}</strong>} {item.verb} <span className="dept-activity__object">{item.objectLabel}</span>
            </span>
            <span className="dept-activity__time">{timeLabel(item.occurredAt)}</span>
          </>
        );
        return (
          <li key={item.id} className="dept-activity__group">
            {showDayHeader && <span className="type-eyebrow dept-activity__day">{day}</span>}
            {item.href ? (
              <Link href={item.href} className="dept-activity__item dept-activity__item--link">{body}</Link>
            ) : (
              <span className="dept-activity__item">{body}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
