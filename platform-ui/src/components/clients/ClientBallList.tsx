import Link from "next/link";
import type { ClientBallItem } from "@/lib/clientHub";
import { EmptyNote } from "@/components/systems/EmptyNote";

// CC-3 — one side of "who is holding the ball".
//
// `staleAfterDays` marks items that have been sitting too long. It applies to the OUR-SIDE list and
// deliberately not to the client's: we do not get to call a client slow, and an angry red badge on
// something we are waiting for them to sign is a number nobody in this company can act on. On our own
// list it is the entire point — a payment awaiting confirmation for three weeks is the failure this
// screen was built to make visible.
//
// `since` is rendered as an AGE ("14d"), not a date. A date makes the reader do the arithmetic, and
// the arithmetic is the finding.

function ageDays(since: string | null, today: Date): number | null {
  if (!since) return null;
  const then = new Date(since);
  if (Number.isNaN(then.getTime())) return null;
  return Math.floor((today.getTime() - then.getTime()) / 86_400_000);
}

export function ClientBallList({
  items,
  empty,
  staleAfterDays,
  today,
}: {
  items: ClientBallItem[];
  empty: string;
  /** Omit to never mark an item stale — see the header for why the client's side omits it. */
  staleAfterDays?: number;
  /** Passed in, never read from the clock in here: a component that reads `new Date()` renders
   *  differently on the server and the client and produces a hydration mismatch. Same discipline as
   *  `lib/pmUrgency.ts` ("today is a required parameter"). */
  today: Date;
}) {
  if (items.length === 0) return <EmptyNote>{empty}</EmptyNote>;
  return (
    <div>
      {items.map((item) => {
        const age = ageDays(item.since, today);
        const stale = staleAfterDays !== undefined && age !== null && age >= staleAfterDays;
        return (
          <div key={`${item.kind}-${item.id}`} className={`ch-ball__item${stale ? " ch-ball__item--stale" : ""}`}>
            <span>
              <Link href={item.href} className="ch-ball__label">{item.label}</Link>
              <br />
              <span className="ch-ball__ctx">{item.context}</span>
            </span>
            <span className="ch-ball__since">
              {age === null ? "" : age === 0 ? "today" : `${age}d`}
            </span>
          </div>
        );
      })}
    </div>
  );
}
