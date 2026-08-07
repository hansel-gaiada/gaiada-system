// PM top-bar counter badges (P4-A9, plan §1.2/workstream A). Repsona shows 6 mine-scoped counter
// badges in the top bar of the PM surface; the owner's cut for this ticket is 4: Ball ·
// Responsible · Reactions · Overdue. THE point of this ticket is "one counts read, not six list
// calls" — see `lib/queue.ts::getPmCounters` for how the numbers are actually produced; this file
// is pure rendering, same split as `PmHome.tsx`.
//
// `reactions` is `number | null` — `null` means "not available yet", NOT zero. There is currently
// no BFF read that answers "reactions on things I authored/commented on" (no
// `comment_reactions`-scoped-to-me endpoint and no reaction notification type exist — see this
// ticket's report). Rendering `null` as a literal zero would be a confident wrong answer; this
// file renders an em dash instead so the gap is visible rather than silently claiming "0
// reactions".
//
// Not "use client", hook-free — same rationale as `UrgencyChip`/`PmHome`: whichever surface mounts
// this (the `/pm` route, built by a concurrent agent) can render it from a server component with
// no wrapper needed.
import { UrgencyChip } from "./UrgencyChip";
import { PM_TERMS } from "@/lib/pmVocabulary";
import "./pm.css"; // `.pm-sr-only` + PM tokens
import "./pm-counters.css";

export interface PmCounterValues {
  /** Tasks where I hold the ball (`assignee.kind === "person" && assignee.refId === me`). */
  ball: number;
  /** Tasks where I am Responsible (`assignee.responsibleId === me`) — independent of Ball. */
  responsible: number;
  /** `null` = no BFF read exists yet for this count (see file header). */
  reactions: number | null;
  /** Overdue among MY (ball-or-responsible) tasks — same `taskUrgency` tier the boards use, never
   *  a separately-invented date comparison. */
  overdue: number;
}

export interface PmCountersProps {
  counters: PmCounterValues;
  /** Optional per-badge link — e.g. a `?ball=me`/`?responsible=me`/`?overdueOnly=1` filtered `@all`
   *  list once P4-A5's scope switcher exists. Omitted badges render unlinked. */
  hrefs?: Partial<Record<keyof PmCounterValues, string>>;
}

function Badge({ label, value, href }: { label: string; value: number | null; href?: string }) {
  const body = (
    <>
      <span className="pm-counters__label">{label}</span>
      <span className="pm-counters__count">{value === null ? "—" : value}</span>
    </>
  );
  if (!href) {
    return (
      <span className="pm-counters__badge" title={value === null ? `${label}: not available` : `${value} ${label}`}>
        {body}
      </span>
    );
  }
  return (
    <a className="pm-counters__badge pm-counters__badge--link" href={href}>
      {body}
    </a>
  );
}

/** THE top-bar counter row (P4-A9). Pure rendering — see file header. */
export function PmCounters({ counters, hrefs }: PmCountersProps) {
  return (
    <div className="pm-counters" role="group" aria-label="My PM counters">
      <Badge label={PM_TERMS.ball} value={counters.ball} href={hrefs?.ball} />
      <Badge label={PM_TERMS.responsible} value={counters.responsible} href={hrefs?.responsible} />
      <Badge label="Reactions" value={counters.reactions} href={hrefs?.reactions} />
      {hrefs?.overdue ? (
        <a className="pm-counters__badge pm-counters__badge--link" href={hrefs.overdue}>
          <UrgencyChip tier="overdue" variant="chip" count={counters.overdue} />
        </a>
      ) : (
        <span className="pm-counters__badge">
          <UrgencyChip tier="overdue" variant="chip" count={counters.overdue} />
        </span>
      )}
    </div>
  );
}
