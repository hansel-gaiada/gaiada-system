"use client";
import { useState } from "react";
import type { QueueItem } from "@/lib/queueUrgency";
import type { QueueDecideOrigin } from "@/app/(app)/actions";
import { NEEDS_YOU_LIMIT } from "@/lib/overviewNow";
import { QueueRows, useQueueDecisions, type Acknowledge } from "@/components/dashboard/NeedsMeQueue";
import { Toast } from "@/components/ui";

type Decide = (tenantId: string, origin: QueueDecideOrigin, originId: string, decision: "approved" | "rejected") => Promise<{ ok: boolean; error?: string }>;

// DW-3c: the Overview's "Needs you" block. The server widget ranks the queue (`selectNeedsYou`) and passes it
// whole; this only draws the top rows and lets "Show all" open the rest in place, so the whole queue stays
// reachable now that `/` no longer shows it. Rows and the inline Approve/Deny are today's own
// (`QueueRows`, `useQueueDecisions`): a decide runs the same code here as it did on the old home.
//
// Every company's items are here, each row tagged with its company when the person has more than one. A
// company that could not be read is named in the note rather than failing the block.
//
// The count is what is still waiting, so it drops as items are decided. An empty list is a claim: it says
// "Nothing needs you right now" only when every source answered, and never a bare 0.
export function NeedsYouBlock({ items, unread = [], multiCompany = false, decide, acknowledge, limit = NEEDS_YOU_LIMIT, titled = true }: {
  /** Ranked, each id once, across every company the person can reach (DW-Q2). */
  items: QueueItem[];
  /** The companies (by name) with a source that could not be read: the list is short, and an empty one is not settled. */
  unread?: string[];
  /** The person has more than one company, so each row says which one it is from. */
  multiCompany?: boolean;
  decide: Decide;
  /** DW-4j-2: the one action of a KPI alert row (Acknowledge, with an optional note). Absent: an alert row offers "Open" only. */
  acknowledge?: Acknowledge;
  limit?: number;
  /** False when a container already names the queue (the Inbox's "Needs you" row, SCP-Kh): no title of its own and no second region of the
   *  same name, so the words "Needs you" are not drawn twice. */
  titled?: boolean;
}) {
  const partial = unread.length > 0;
  const { visible, act, ack, toast } = useQueueDecisions(items, decide, acknowledge);
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? visible : visible.slice(0, limit);
  const Wrap = titled ? "section" : "div";

  return (
    <Wrap className="ov-block" {...(titled ? { "aria-label": "Needs you" } : {})}>
      {titled && <h3 className="ov-block__title">{visible.length > 0 ? `Needs you · ${visible.length}` : "Needs you"}</h3>}
      {visible.length === 0 ? (
        <p className="ov-block__note">
          {partial ? "Nothing found in the sources that could be read." : "Nothing needs you right now"}
        </p>
      ) : (
        <QueueRows items={shown} act={act} ack={ack} showCompany={multiCompany} />
      )}
      {visible.length > limit && (
        <button
          type="button"
          className="lux-btn lux-btn--ghost lux-btn--sm ov-block__more"
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? "Show fewer" : `Show all (${visible.length})`}
        </button>
      )}
      {partial && (
        <p className="ov-block__note">Some sources could not be read{multiCompany ? `: ${unread.join(", ")}` : ""}</p>
      )}
      {toast && <Toast message={toast} />}
    </Wrap>
  );
}
