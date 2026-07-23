import Link from "next/link";
import type { QueueItem } from "@/lib/queueUrgency";
import "./dashboard.css";

// IC-tier's compact day/week agenda (UX-2 §1.2, fused from A3). A
// self-contained placeholder for the bucketing logic the spec eventually
// wants extracted to `lib/agenda.ts` and shared with Calendar (§5,
// follow-on ticket WSUX-8, not yet built) — kept here as a pure, tested
// function so that extraction is a pure move, not a rewrite.
export type AgendaBucketKey = "overdue" | "today" | "tomorrow" | "later" | "no_date";

export interface AgendaBucket {
  key: AgendaBucketKey;
  label: string;
  items: QueueItem[];
}

const DAY_MS = 24 * 3600 * 1000;
const BUCKET_LABEL: Record<AgendaBucketKey, string> = {
  overdue: "Overdue",
  today: "Today",
  tomorrow: "Tomorrow",
  later: "Later",
  no_date: "No date",
};
const BUCKET_ORDER: AgendaBucketKey[] = ["overdue", "today", "tomorrow", "later", "no_date"];

/** Pure — buckets any dated/undated items by proximity to `now`. Only items
 *  with a due date are ever placed ahead of "no date" (never silently
 *  dropped — every input item lands in exactly one bucket). */
export function bucketAgenda(items: QueueItem[], now = new Date()): AgendaBucket[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const buckets: Record<AgendaBucketKey, QueueItem[]> = { overdue: [], today: [], tomorrow: [], later: [], no_date: [] };
  for (const item of items) {
    const due = item.dueDate ? new Date(item.dueDate) : null;
    if (!due || Number.isNaN(due.getTime())) {
      buckets.no_date.push(item);
      continue;
    }
    const days = Math.floor((due.getTime() - startOfToday.getTime()) / DAY_MS);
    if (days < 0) buckets.overdue.push(item);
    else if (days === 0) buckets.today.push(item);
    else if (days === 1) buckets.tomorrow.push(item);
    else buckets.later.push(item);
  }
  return BUCKET_ORDER.filter((k) => buckets[k].length > 0).map((k) => ({ key: k, label: BUCKET_LABEL[k], items: buckets[k] }));
}

export function TodayAgenda({ items, emptyText }: { items: QueueItem[]; emptyText?: string }) {
  const buckets = bucketAgenda(items);
  if (buckets.length === 0) {
    return <div className="dash-empty"><p>{emptyText ?? "Nothing scheduled."}</p></div>;
  }
  return (
    <div className="today-agenda">
      {buckets.map((b) => (
        <div key={b.key} className="today-agenda__bucket">
          <span className="type-eyebrow today-agenda__heading">{b.label} ({b.items.length})</span>
          <ul className="today-agenda__list">
            {b.items.map((item) => (
              <li key={item.id} className="today-agenda__item">
                {item.href ? <Link href={item.href} className="today-agenda__link">{item.title}</Link> : <span>{item.title}</span>}
                {item.meta && <span className="today-agenda__meta"> · {item.meta}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
