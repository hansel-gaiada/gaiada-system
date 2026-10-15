import Link from "next/link";
import { ClientHealthChip } from "@/components/clients/ClientHealthChip";
import { healthBoardHref } from "@/lib/clientHealthBoard";
import type { ClientHealthView } from "@/lib/overviewClientHealth";
import { UNAVAILABLE } from "@/lib/overviewWork";

// DW-10d: "Client health", the first optional block (DW-D34): a summary of the staff health board (BFF §54.2). A pure view of
// its model. A refused or failed read says "Unavailable" in the block's own place, never an empty board; "No clients" and "All N on
// track" are said only after a successful read. The chip is the board's own (words and a shape, never colour alone).

const TITLE = "Client health";
const plural = (n: number) => (n === 1 ? "client" : "clients");

/** `departmentId` is set in a department workspace: the link to the board then opens it narrowed to that department. */
export function ClientHealthBlock({ view, departmentId }: { view: ClientHealthView; departmentId?: string | null }) {
  if (view.kind !== "ok") {
    return (
      <section className="ov-block ov-block--unavailable" aria-label={TITLE} data-state="unavailable">
        <h3 className="ov-block__title">{TITLE}</h3>
        <p className="ov-block__note">{UNAVAILABLE}</p>
      </section>
    );
  }
  const boardHref = healthBoardHref(departmentId ? { department: departmentId } : {});
  const empty = view.total === 0;
  return (
    <section className="ov-block ov-chealth" aria-label={TITLE} data-state={empty ? "empty" : view.allOnTrack ? "calm" : "attention"}>
      <h3 className="ov-block__title">{TITLE}</h3>
      {empty ? (
        <p className="ov-block__note">{departmentId ? "No clients in this department." : "No clients yet."}</p>
      ) : view.allOnTrack ? (
        <p className="ov-chealth__counts">All {view.total} on track</p>
      ) : (
        <p className="ov-chealth__counts">{view.counts.map((c) => `${c.count} ${c.label.toLowerCase()}`).join(" · ")}</p>
      )}
      {view.rows.length > 0 && (
        <ul className="ov-work__list">
          {view.rows.map((r) => (
            <li key={r.clientId} className="ov-work__item ov-chealth__row" data-client={r.clientId}>
              <ClientHealthChip state={r.state} />
              <Link href={`/clients/${encodeURIComponent(r.clientId)}`} className="ov-work__name">{r.name}</Link>
              {r.reason && <span className="ov-work__meta">{r.reason}</span>}
            </li>
          ))}
        </ul>
      )}
      {view.more > 0 && <p className="ov-block__note">and {view.more} more {plural(view.more)} that need a look</p>}
      {view.unavailableNote && <p className="ov-block__note" role="status">{view.unavailableNote}</p>}
      <Link href={boardHref} className="ov-nums__link">Open the health board</Link>
    </section>
  );
}
