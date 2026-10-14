import type { QueueItem } from "@/lib/queueUrgency";
import { NeedsMeQueue, type Acknowledge } from "./NeedsMeQueue";
import { TodayAgenda } from "./TodayAgenda";
import type { QueueDecideOrigin } from "@/app/(app)/actions";
import "./dashboard.css";

type Decide = (tenantId: string, origin: QueueDecideOrigin, originId: string, decision: "approved" | "rejected") => Promise<{ ok: boolean; error?: string }>;

// IC-tier Home (UX-2 §1.2 "Queue + Agenda hybrid", A1×A3 fusion): no
// chips/chart — the same ranked queue on the left, a compact day/week agenda
// (bucketed from the queue's own task items — no extra fetch) on the right.
export function QueueAgendaHome({ items, decide, acknowledge, emptyText, agendaItems }: {
  items: QueueItem[];
  decide: Decide;
  /** DW-4j-2: acknowledges a KPI alert row. */
  acknowledge?: Acknowledge;
  emptyText?: string;
  /** See CommandCenterHome — the queue's own task leg is blind to pm_tasks. */
  agendaItems?: QueueItem[];
}) {
  const agenda = agendaItems ?? items.filter((i) => i.type === "task");
  return (
    <div className="queue-agenda">
      <section className="lux-card queue-agenda__queue">
        <span className="queue-agenda__heading">Needs you ({items.length})</span>
        <NeedsMeQueue items={items} decide={decide} acknowledge={acknowledge} emptyText={emptyText} />
      </section>
      <section className="lux-card queue-agenda__agenda">
        <span className="queue-agenda__heading">Today</span>
        <TodayAgenda items={agenda} />
      </section>
    </div>
  );
}
