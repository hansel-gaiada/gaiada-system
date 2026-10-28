// SCP-3f — the pure side of `GET overview` (BFF §63.7): the Overview's Pulse tiles. No I/O here: `overview-data.ts` reads, and
// `feed.controller.ts` asks Cerbos and answers.
//
// NOTHING IS RETYPED. The phase of a post is `phaseOfCandidate` (the stage machine's fixture) and its health is `healthOfCandidate`
// (`schedule-health.ts`'s `postHealth` through the helpers `cycles-data.ts` uses): exactly what the feed's cards say, so a tile and the list
// it links to cannot disagree.
import type { WorkingCalendar } from "../../hr/working-days";
import { addDays } from "../../hr/working-days";
import type { ApprovalSample } from "./schedule-health";
import type { FeedCandidate } from "./feed-data";
import type { OverviewFacts } from "./overview-data";
import { healthOfCandidate, phaseOfCandidate } from "./feed";

export interface OverviewTiles {
  inProduction: number;
  withClient: number;
  late: number;
  scheduledThisWeek: number;
  failedPosts: number;
  /** Boosts requested, plus approved and not yet started (§63.7). */
  boostsWaiting: number;
}

export interface OverviewAnswer {
  tiles: OverviewTiles;
  /** True while the simulator switch is on: the tiles count simulated rows. False: simulated rows are left out. */
  simulatedIncluded: boolean;
}

/** Monday to Sunday of the week `today` (an ISO date in the company's zone) falls in: `from` inclusive, `to` the next Monday, exclusive. */
export function weekOf(today: string): { from: string; to: string } {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const from = addDays(today, -((dow + 6) % 7));
  return { from, to: addDays(from, 7) };
}

/** The tiles. PURE. `candidates` are the company's pipeline posts (the feed's `all`); `facts` the three numbers SQL answers. */
export function composeOverview(
  candidates: readonly FeedCandidate[], facts: OverviewFacts,
  ctx: { today: string; calendar: WorkingCalendar; samples: Map<string, ApprovalSample[]>; includeSimulated: boolean },
): OverviewAnswer {
  const slowerCache = new Map<string, boolean>();
  let inProduction = 0, withClient = 0, late = 0;
  for (const c of candidates) {
    if (!ctx.includeSimulated && (c.simulated || facts.simulatedIds.has(c.id))) continue;
    const phase = phaseOfCandidate(c);
    if (phase === "in_production") inProduction += 1;
    else if (phase === "with_client") withClient += 1;
    if (healthOfCandidate(c, ctx.today, ctx.calendar, ctx.samples, slowerCache)?.state === "late") late += 1;
  }
  return {
    tiles: { inProduction, withClient, late, scheduledThisWeek: facts.scheduledThisWeek, failedPosts: facts.failedPosts, boostsWaiting: facts.boostsWaiting },
    simulatedIncluded: ctx.includeSimulated,
  };
}
