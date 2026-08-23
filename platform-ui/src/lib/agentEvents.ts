// Agent run events (O4) — the office canvas's data types for one agent run's real, in-flight
// activity feed. Mirrors platform-nest's whitelisted reshape of
// ai-agents/src/runner/store.ts's `RunEventRow` (see intelligence.controller.ts's
// `reshapeEvent`) — NOT the runner's raw row (no `tenantId`; the caller already knows its own
// tenant from the route it's on, same convention as every other type in this domain).
//
// Kept as its OWN client-safe file rather than folded into lib/admin.ts (which already owns
// AgentGoal/AgentRun and the rest of the "agents" domain) because admin.ts is `server-only` for
// its WHOLE file — the "older domain" shape per this repo's module-trio convention (see
// CLAUDE.md). A client component that needs a plain function out of admin.ts today mirrors the
// logic inline instead of importing it (see GoalsTable.tsx's comment on `hasActiveGoal`). That
// is an acceptable trade for a one-line boolean; it is NOT an acceptable trade for
// `findSeqGaps` below, which exists specifically so a consumer never has to re-derive "was
// something dropped" by hand and get the edge case subtly wrong. This file + the sibling
// `agentEvents-data.ts` follow the NEWER trio split instead (`reports.ts`, `appraisals.ts`,
// `checkins.ts`): pure types + client-safe helpers here, the `platformFetch` reader there.
export type AgentRunEventKind = "model" | "tool" | "delegate" | "approval_wait" | "error";

export interface AgentRunEvent {
  eventId: string;
  runId: string;
  goalId: string;
  /** Monotonic per run, assigned by the runner's in-memory per-run counter BEFORE it attempts
   *  the write (ai-agents/src/runner/store.ts's `RunEventInput` doc) — so a dropped write leaves
   *  a real hole in this sequence, not merely a late one. See `findSeqGaps`. */
  seq: number;
  /** Server-assigned insert time (ISO 8601, from Postgres `now()`) — real wall-clock ordering,
   *  never a client-side guess. */
  ts: string;
  kind: AgentRunEventKind;
  /** Untrusted model/tool output — mirrors `AgentStep.detail` in `lib/admin.ts`: render as inert
   *  text only, exactly like `TranscriptView` already does for a full run's steps. */
  detail: string;
  durationMs: number | null;
  /** The delegation edge (S0): the run that spawned the run THIS event belongs to, when it is a
   *  supervisor-spawned specialist. Independent of `runId` — see the runner's own
   *  `agent_run_events` doc for why this is not a foreign key (a supervisor's own planner
   *  events can carry a `parentRunId` that never becomes an `agent_runs` row at all). */
  parentRunId: string | null;
}

/** One missing stretch of `seq` between two consecutive events this consumer has actually seen
 *  (or between its prior cursor and the first event of a fresh page). The emitter increments its
 *  per-run counter BEFORE attempting the DB write and is fail-soft on that write (a transient DB
 *  error degrades to "this one step wasn't recorded", never a failed/slowed agent run — see
 *  `runner/store.ts`'s `GoalStore.insertEvent` doc) — so `seq` is monotonic but NOT guaranteed
 *  gap-free. A consumer that only checks "did the array grow" cannot see this; a consumer that
 *  renders the array as the complete story would be silently wrong about what happened. */
export interface SeqGap {
  /** The last seq this consumer already had proof of (0 for a fresh load with no prior cursor). */
  afterSeq: number;
  /** The next seq actually received — strictly greater than `afterSeq + 1`. */
  beforeSeq: number;
}

/** Pure, client-safe: scan an ASCENDING, already-fetched page of events for holes in `seq`,
 *  relative to `sinceSeq` (the cursor the caller already had before this page — 0 for a first
 *  load). Each `{afterSeq, beforeSeq}` pair means `beforeSeq - afterSeq - 1` event(s) never
 *  arrived; the caller decides how to render that (e.g. "N step(s) missing here").
 *
 *  Does NOT sort or dedupe its input — feeding it an out-of-order or overlapping page produces a
 *  meaningless answer, matching every other consumer of this endpoint's "ascending, since-only"
 *  contract (the runner's own `GoalStore.listEvents` doc: `WHERE seq > $sinceSeq ORDER BY seq
 *  ASC`). */
export function findSeqGaps(events: readonly Pick<AgentRunEvent, "seq">[], sinceSeq = 0): SeqGap[] {
  const gaps: SeqGap[] = [];
  let prev = sinceSeq;
  for (const e of events) {
    if (e.seq > prev + 1) gaps.push({ afterSeq: prev, beforeSeq: e.seq });
    prev = e.seq;
  }
  return gaps;
}

/** Convenience over `findSeqGaps` for a simple "is anything missing" render decision (e.g. a
 *  warning badge) without the caller needing the individual ranges. */
export function hasSeqGap(events: readonly Pick<AgentRunEvent, "seq">[], sinceSeq = 0): boolean {
  return findSeqGaps(events, sinceSeq).length > 0;
}

/** The next cursor to poll with: the highest `seq` seen in this page, or `previous` unchanged if
 *  the page was empty. A poller must never regress its cursor on an empty poll (that would
 *  re-request events it already rendered) — folding that rule in here means every consumer gets
 *  it for free instead of re-deriving `Math.max(...)` (and its empty-array edge case) by hand. */
export function nextCursor(events: readonly Pick<AgentRunEvent, "seq">[], previous = 0): number {
  return events.reduce((max, e) => Math.max(max, e.seq), previous);
}
