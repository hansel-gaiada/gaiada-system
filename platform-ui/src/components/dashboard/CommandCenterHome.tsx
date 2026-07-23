import type { QueueItem } from "@/lib/queueUrgency";
import { NeedsMeQueue } from "./NeedsMeQueue";
import { FilterChips, type QueueFilter, type FilterChipDef } from "./FilterChips";
import { ThroughputSparkline } from "./ThroughputSparkline";
import type { QueueDecideOrigin } from "@/app/(app)/actions";
import "./dashboard.css";

type Decide = (tenantId: string, origin: QueueDecideOrigin, originId: string, decision: "approved" | "rejected") => Promise<{ ok: boolean; error?: string }>;

function isOverdueTask(i: QueueItem, now: Date): boolean {
  if (i.type !== "task" || !i.dueDate) return false;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return new Date(i.dueDate).getTime() < startOfToday.getTime();
}
function isDueTodayTask(i: QueueItem, now: Date): boolean {
  if (i.type !== "task" || !i.dueDate) return false;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d = new Date(i.dueDate).getTime();
  return d >= startOfToday.getTime() && d < startOfToday.getTime() + 86_400_000;
}

/** Pure — the four chip buckets + how each filters the queue. Exported so a
 *  unit test can pin the semantics independent of rendering. */
export function buildChips(items: QueueItem[], now = new Date()): FilterChipDef[] {
  return [
    { key: "overdue", label: "Overdue", count: items.filter((i) => isOverdueTask(i, now)).length },
    { key: "due_today", label: "Due today", count: items.filter((i) => isDueTodayTask(i, now)).length },
    { key: "approvals", label: "Approvals", count: items.filter((i) => i.type === "approval" || i.type === "gate").length },
    { key: "mentions", label: "Mentions", count: items.filter((i) => i.type === "mention").length },
  ];
}

export function applyQueueFilter(items: QueueItem[], filter: QueueFilter | undefined, now = new Date()): QueueItem[] {
  switch (filter) {
    case "overdue": return items.filter((i) => isOverdueTask(i, now));
    case "due_today": return items.filter((i) => isDueTodayTask(i, now));
    case "approvals": return items.filter((i) => i.type === "approval" || i.type === "gate");
    case "mentions": return items.filter((i) => i.type === "mention");
    default: return items;
  }
}

// Manager-tier Home (UX-2 §1.2 "Command Center"): the ranked queue IS the
// hero; KPI tiles are reborn as clickable filter chips over that same queue
// (not static vanity numbers); a demoted sparkline keeps glance value
// without leading.
export function CommandCenterHome({ items, filter, buildFilterHref, decide, throughput, emptyText }: {
  items: QueueItem[];
  filter: QueueFilter | undefined;
  buildFilterHref: (next: QueueFilter | undefined) => string;
  decide: Decide;
  throughput: number[];
  emptyText?: string;
}) {
  const chips = buildChips(items);
  const filtered = applyQueueFilter(items, filter);
  return (
    <div className="command-center">
      <div className="command-center__chips-row">
        <FilterChips chips={chips} active={filter} buildHref={buildFilterHref} />
        <ThroughputSparkline series={throughput} />
      </div>
      <section>
        <span className="type-eyebrow command-center__heading">Needs you</span>
        <NeedsMeQueue items={filtered} decide={decide} emptyText={emptyText} />
      </section>
    </div>
  );
}
